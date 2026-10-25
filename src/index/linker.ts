// Cross-file link and aggregate passes that run after each indexing run (SPEC §5.2).

import type { DatabaseSync } from 'node:sqlite';
import { FLAG_BITS } from '../model/types.ts';
import { type DeriveOptions, type DeriveResult, runDerive } from './derive.ts';

const INHERITED = FLAG_BITS.inherited;
/** Events that do not count toward session totals: copied context and mirrored records. */
const NOT_OWN = FLAG_BITS.inherited | FLAG_BITS.dup;

/**
 * Link and aggregate the given sessions (all sessions when undefined).
 * Session-tree passes (parent span, children, root) always cover every session; they are cheap.
 * Pass 6 (the analysis pass, src/index/derive.ts) then re-derives the root trees of those sessions, unless `derive` is false.
 * `rewritten` lists the sessions whose rows the pass changed (null when it linked every session): the ones it linked,
 * including those that gained inherited flags, and those whose parent, root or child count the tree passes changed.
 */
export function runLinker(
  db: DatabaseSync, sessionIds?: string[], opts: { derive?: Omit<DeriveOptions, 'sessions'> | false } = {},
): { derive: DeriveResult | null; rewritten: string[] | null } {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS link_set (id TEXT PRIMARY KEY)');
  const scoped = sessionIds !== undefined;
  const inSet = (col: string) => (scoped ? `${col} IN (SELECT id FROM temp.link_set)` : '1');
  const addToSet = db.prepare('INSERT OR IGNORE INTO temp.link_set (id) VALUES (?)');
  let moved: string[] = [];
  db.exec('SAVEPOINT link_pass');
  try {
    db.exec('DELETE FROM temp.link_set');
    for (const id of sessionIds ?? []) addToSet.run(id);
    addPlaceholderSessions(db, inSet('e.session_id'));
    applyEnrich(db, inSet('id'));
    for (const id of flagCrossSessionDuplicates(db, scoped)) addToSet.run(id);
    aggregate(db, inSet, scoped);
    collectGarbage(db, inSet('id'));
    moved = [...resolveParentSpans(db), ...linkTree(db)];
    db.exec('RELEASE link_pass');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK TO link_pass; RELEASE link_pass');
    throw err;
  }
  // Pass 6 covers the sessions this run linked, including those that gained inherited flags.
  const linked = scoped ? (db.prepare('SELECT id FROM temp.link_set').all() as { id: string }[]).map((r) => r.id) : undefined;
  const rewritten = linked ? [...new Set([...linked, ...moved])] : null;
  if (opts.derive === false) return { derive: null, rewritten };
  return { derive: runDerive(db, { ...opts.derive, sessions: linked }), rewritten };
}

/** Events whose session has no session record (e.g. an audit log of a session whose transcript is gone). */
function addPlaceholderSessions(db: DatabaseSync, where: string): void {
  db.exec(`
    INSERT OR IGNORE INTO sessions (id, agent, native_id, role, state, src_id)
    SELECT e.session_id, MIN(src.agent), substr(e.session_id, instr(e.session_id, ':') + 1), 'main', 'ok', MIN(e.src_id)
    FROM events e JOIN sources src ON src.id = e.src_id
    WHERE ${where} AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id)
    GROUP BY e.session_id`);
}

// ---------------------------------------------------------------------------
// Enrichment

type Col = 'title' | 'parent_id' | 'cwd' | 'project' | 'git_branch' | 'git_commit' | 'git_repo' | 'models';

/** How each enrich field maps to a nullable session column. `role` is handled separately (see applyEnrich). */
const ENRICH_COLUMNS: [Col, (f: Record<string, any>) => unknown][] = [
  ['title', (f) => f.title],
  ['parent_id', (f) => f.parentId],
  ['cwd', (f) => f.cwd],
  ['project', (f) => f.project],
  ['git_branch', (f) => f.git?.branch],
  ['git_commit', (f) => f.git?.commit],
  ['git_repo', (f) => f.git?.repo],
  ['models', (f) => (Array.isArray(f.models) && f.models.length ? JSON.stringify(f.models) : undefined)],
];

/**
 * Merge enrich rows into `meta_enriched` and fill columns the transcript left null.
 * `meta_enriched.$applied` remembers what was filled, so a later enrich value can replace an earlier
 * one while a value the transcript wrote is never overridden.
 *
 * `role` is never null: a transcript that cannot tell (a scheduled Cowork run, a Dispatch child) says 'main',
 * so an enrich role replaces 'main' and reverts to 'main' when the enrich row no longer carries it.
 */
function applyEnrich(db: DatabaseSync, where: string): void {
  const sessions = db
    .prepare(`SELECT id, role, meta_enriched, ${ENRICH_COLUMNS.map(([c]) => c).join(', ')} FROM sessions
              WHERE ${where} AND (meta_enriched IS NOT NULL OR EXISTS (SELECT 1 FROM enrich en WHERE en.session_id = sessions.id))`)
    .all() as Record<string, any>[];
  const rowsOf = db.prepare('SELECT src_id, fields, meta FROM enrich WHERE session_id = ? ORDER BY src_id');
  const update = db.prepare(
    `UPDATE sessions SET meta_enriched = ?, role = ?, ${ENRICH_COLUMNS.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`,
  );
  for (const s of sessions) {
    const rows = rowsOf.all(s.id) as { src_id: string; fields: string | null; meta: string | null }[];
    const fields: Record<string, any> = {};
    let meta: Record<string, unknown> = {};
    for (const r of rows) {
      const f = r.fields ? JSON.parse(r.fields) : {};
      if (f.git) f.git = { ...fields.git, ...f.git };
      Object.assign(fields, f);
      if (r.meta) meta = { ...meta, ...JSON.parse(r.meta) };
    }
    const prevApplied: Record<string, unknown> = s.meta_enriched ? JSON.parse(s.meta_enriched).$applied ?? {} : {};
    const applied: Record<string, unknown> = {};
    const values = ENRICH_COLUMNS.map(([col, get]) => {
      const current = s[col];
      const ownedByEnrich = current == null || (col in prevApplied && prevApplied[col] === current);
      if (!ownedByEnrich) return current;
      const v = get(fields) ?? null;
      if (v !== null) applied[col] = v;
      return v;
    });
    let role: string = s.role;
    if (typeof fields.role === 'string' && (role === 'main' || role === prevApplied.role)) {
      role = fields.role;
      applied.role = role;
    } else if (prevApplied.role !== undefined && role === prevApplied.role) {
      role = 'main';
    }
    const enriched = rows.length
      ? JSON.stringify({ ...meta, $fields: fields, $sources: rows.map((r) => r.src_id), $applied: applied })
      : null;
    update.run(enriched, role, ...(values as (string | null)[]), s.id);
  }
}

// ---------------------------------------------------------------------------
// Duplicates across sessions

const CLAUDE = "('claude-code', 'claude-cowork')";

/**
 * A Claude message id or user uuid that appears in more than one session is inherited context in every
 * session but the original: an ancestor beats its descendants (forked subagents copy the parent's
 * history), otherwise the session whose copy starts earliest, then ends earliest (a resumed session
 * starts with the original's messages and runs past its end).
 *
 * Copies come from a session's ancestors or from earlier root sessions of the same project, so a
 * scoped run compares the changed sessions against exactly those. Returns sessions that gained flags.
 */
function flagCrossSessionDuplicates(db: DatabaseSync, scoped: boolean): string[] {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS link_scope (id TEXT PRIMARY KEY);
           CREATE TEMP TABLE IF NOT EXISTS link_dup (key TEXT, session_id TEXT, rid INTEGER, ts INTEGER);
           DELETE FROM temp.link_scope; DELETE FROM temp.link_dup;`);
  if (scoped) {
    db.exec(`
      INSERT OR IGNORE INTO temp.link_scope (id)
      WITH changed AS (SELECT * FROM sessions WHERE id IN (SELECT id FROM temp.link_set) AND agent IN ${CLAUDE}),
      up(id) AS (SELECT parent_id FROM changed WHERE parent_id IS NOT NULL
                 UNION SELECT s.parent_id FROM sessions s JOIN up ON s.id = up.id WHERE s.parent_id IS NOT NULL)
      SELECT id FROM changed
      UNION SELECT id FROM up
      UNION SELECT id FROM sessions WHERE agent IN ${CLAUDE} AND parent_id IS NULL
        AND COALESCE(project, cwd) IN (SELECT COALESCE(project, cwd) FROM changed)`);
  } else {
    db.exec(`INSERT INTO temp.link_scope (id) SELECT id FROM sessions WHERE agent IN ${CLAUDE}`);
  }
  if ((db.prepare('SELECT COUNT(*) AS n FROM temp.link_scope').get() as { n: number }).n < 2) return [];
  db.exec(`
    INSERT INTO temp.link_dup (key, session_id, rid, ts)
    SELECT k, session_id, rid, ts FROM (
      SELECT e.session_id, e.rid, e.ts,
        CASE WHEN e.proto LIKE 'claude/assistant%'
          THEN COALESCE(json_extract(p.attrs, '$.llm.message_id'), json_extract(p.native, '$.message.id'))
          ELSE json_extract(p.native, '$.uuid') END AS k
      FROM temp.link_scope sc CROSS JOIN events e ON e.session_id = sc.id JOIN event_payload p ON p.rid = e.rid
      WHERE e.proto LIKE 'claude/assistant%' OR e.proto LIKE 'claude/user%')
    WHERE k IS NOT NULL`);
  const rows = db
    .prepare(`
      WITH ks AS (SELECT key, session_id FROM temp.link_dup GROUP BY key, session_id),
      multi AS (SELECT key FROM ks GROUP BY key HAVING COUNT(*) > 1),
      bounds AS (SELECT session_id, MIN(ts) AS t0, MAX(ts) AS t1 FROM temp.link_dup GROUP BY session_id),
      ranked AS (
        SELECT ks.key, ks.session_id,
          ROW_NUMBER() OVER (PARTITION BY ks.key ORDER BY s.parent_id IS NOT NULL, b.t0, b.t1, ks.session_id) AS rn
        FROM ks JOIN multi ON multi.key = ks.key JOIN bounds b ON b.session_id = ks.session_id
        JOIN sessions s ON s.id = ks.session_id)
      SELECT d.rid, d.session_id FROM temp.link_dup d
      JOIN ranked r ON r.key = d.key AND r.session_id = d.session_id
      WHERE r.rn > 1`)
    .all() as { rid: number; session_id: string }[];
  const flag = db.prepare(`UPDATE events SET flag_bits = flag_bits | ${INHERITED} WHERE rid = ? AND (flag_bits & ${INHERITED}) = 0`);
  const sessions = new Set<string>();
  for (const r of rows) if (Number(flag.run(r.rid).changes) > 0) sessions.add(r.session_id);
  db.exec('DELETE FROM temp.link_dup');
  return [...sessions];
}

// ---------------------------------------------------------------------------
// Aggregates

/** Per-session logging-health counters (sessions.measures), summed per agent by the health report (SPEC §8). */
export interface SessionMeasures {
  /** Events, and those with a logged timestamp. */
  ts_n: number;
  ts_logged: number;
  llm_n: number;
  llm_logged: number;
  llm_derived: number;
  llm_parsed: number;
  llm_tokens: number;
  llm_cache: number;
  llm_ttft: number;
  tool_n: number;
  tool_logged: number;
  tool_derived: number;
  tool_parsed: number;
  thinking_n: number;
  thinking_text: number;
  shell_n: number;
  shell_exit: number;
  turnend_n: number;
  turnend_ttft: number;
  turnend_cost: number;
  state_cost: number;
  claude_results: number;
  claude_tur: number;
  perm_req: number;
  perm_dec: number;
  file_n: number;
}

const MEASURED_KINDS = "('llm.thinking', 'tool.result', 'turn.end', 'session.state', 'permission.request', 'permission.decision', 'harness.file')";

/**
 * Logging-health counters of the sessions `where` selects (an SQL condition on the column session_id). Only the
 * sessions' own events and spans count (no copied context, no mirrors). Most counters read columns; only readable
 * thinking text, turn TTFT and Claude's toolUseResult (in subagent transcripts) read the payload of those events.
 * `withTs: false` skips the event and timestamp counts, which the linker takes from its aggregate pass.
 */
export function emptySessionMeasures(): SessionMeasures {
  return {
    ts_n: 0, ts_logged: 0, llm_n: 0, llm_logged: 0, llm_derived: 0, llm_parsed: 0, llm_tokens: 0, llm_cache: 0, llm_ttft: 0,
    tool_n: 0, tool_logged: 0, tool_derived: 0, tool_parsed: 0, thinking_n: 0, thinking_text: 0, shell_n: 0, shell_exit: 0,
    turnend_n: 0, turnend_ttft: 0, turnend_cost: 0, state_cost: 0, claude_results: 0, claude_tur: 0, perm_req: 0, perm_dec: 0,
    file_n: 0,
  };
}

export function measureSessions(db: DatabaseSync, where: string, scoped: boolean, withTs = true): Map<string, SessionMeasures> {
  const out = new Map<string, SessionMeasures>();
  const of = (id: string): SessionMeasures => {
    let m = out.get(id);
    if (!m) out.set(id, (m = emptySessionMeasures()));
    return m;
  };
  const own = `(e.flag_bits & ${NOT_OWN}) = 0`;
  const add = (sql: string) => {
    for (const r of db.prepare(sql).all() as Record<string, any>[]) {
      const m = of(r.session_id);
      for (const [k, v] of Object.entries(r)) if (k !== 'session_id' && typeof v === 'number') (m as any)[k] += v;
    }
  };
  const byKind = scoped ? '' : 'INDEXED BY ev_kind';
  if (withTs) {
    add(`SELECT session_id, COUNT(*) AS ts_n, SUM(ts_src = 'logged') AS ts_logged
      FROM events e ${scoped ? '' : 'NOT INDEXED'} WHERE ${where} AND ${own} GROUP BY session_id`);
  }
  add(`SELECT e.session_id,
      SUM(e.kind = 'llm.thinking') AS thinking_n,
      SUM(e.kind = 'tool.result' AND e.tool_kind = 'shell') AS shell_n,
      SUM(e.kind = 'tool.result' AND e.tool_kind = 'shell' AND e.exit_code IS NOT NULL) AS shell_exit,
      SUM(e.kind = 'turn.end') AS turnend_n,
      SUM(e.kind = 'turn.end' AND e.cost_usd IS NOT NULL) AS turnend_cost,
      SUM(e.kind = 'session.state' AND e.cost_usd IS NOT NULL) AS state_cost,
      SUM(e.kind = 'tool.result' AND e.proto LIKE 'claude/%') AS claude_results,
      SUM(e.kind = 'permission.request') AS perm_req, SUM(e.kind = 'permission.decision') AS perm_dec,
      SUM(e.kind = 'harness.file') AS file_n
    FROM events e ${byKind} WHERE ${where} AND e.kind IN ${MEASURED_KINDS} AND ${own} GROUP BY e.session_id`);
  add(`SELECT e.session_id, SUM(coalesce(json_extract(p.attrs, '$.text'), '') <> '') AS thinking_text
    FROM events e ${byKind} JOIN event_payload p ON p.rid = e.rid
    WHERE ${where} AND e.kind = 'llm.thinking' AND ${own} GROUP BY e.session_id`);
  add(`SELECT e.session_id, SUM(json_extract(p.attrs, '$.llm.ttft_ms') IS NOT NULL) AS turnend_ttft
    FROM events e ${byKind} JOIN event_payload p ON p.rid = e.rid
    WHERE ${where} AND e.kind = 'turn.end' AND ${own} GROUP BY e.session_id`);
  // toolUseResult only matters in Claude subagent and workflow transcripts (SPEC §8 findings).
  add(`SELECT e.session_id, SUM(json_type(p.native, '$.toolUseResult') IS NOT NULL) AS claude_tur
    FROM events e JOIN event_payload p ON p.rid = e.rid
    WHERE ${where} AND e.session_id IN (SELECT id FROM sessions WHERE role <> 'main' AND agent IN ('claude-code', 'claude-cowork'))
      AND e.kind = 'tool.result' AND e.proto LIKE 'claude/%' AND ${own} GROUP BY e.session_id`);
  const dur = (kind: string, src: string) => `SUM(kind = '${kind}' AND dur_src LIKE '${src}%')`;
  add(`SELECT session_id,
      SUM(kind = 'llm') AS llm_n, ${dur('llm', 'logged')} AS llm_logged, ${dur('llm', 'derived')} AS llm_derived,
      ${dur('llm', 'parsed')} AS llm_parsed,
      SUM(kind = 'llm' AND json_extract(attrs, '$.tokens.output') IS NOT NULL) AS llm_tokens,
      SUM(kind = 'llm' AND json_extract(attrs, '$.tokens.cache_read') IS NOT NULL) AS llm_cache,
      SUM(kind = 'llm' AND json_extract(attrs, '$.llm.ttft_ms') IS NOT NULL) AS llm_ttft,
      SUM(kind = 'tool') AS tool_n, ${dur('tool', 'logged')} AS tool_logged, ${dur('tool', 'derived')} AS tool_derived,
      ${dur('tool', 'parsed')} AS tool_parsed
    FROM spans e WHERE ${where} AND kind IN ('llm', 'tool') AND inherited = 0 GROUP BY session_id`);
  return out;
}

interface EventAgg {
  session_id: string;
  n_events: number;
  n_errors: number;
  start_own: number | null;
  end_own: number | null;
  start_all: number | null;
  end_all: number | null;
  cost_turns: number | null;
  cost_running: number | null;
  n_inherited: number;
  /** JSON array of the sources holding the session's events. */
  sources: string;
  ts_logged: number;
}

interface SpanAgg {
  session_id: string;
  n_llm: number;
  n_tools: number;
  n_turns: number;
  tok_in: number | null;
  tok_uncached: number | null;
  tok_cache_read: number | null;
  tok_cache_write: number | null;
  tok_out: number | null;
  tok_reasoning: number | null;
}

function aggregate(db: DatabaseSync, inSet: (col: string) => string, scoped: boolean): void {
  const timed = "ts_src != 'none'";
  const own = `(flag_bits & ${NOT_OWN}) = 0`;
  const cost = (cumulative: boolean) => `CASE WHEN ${own} AND cost_cum = ${cumulative ? 1 : 0} THEN cost_usd END`;
  // Unscoped, a sequential table scan beats walking the session index, whose row lookups jump around the table.
  // Per-turn costs add up; a running total (`cost.cumulative`, e.g. Claude cost-state) counts with its largest value.
  const events = db
    .prepare(`
      SELECT session_id,
        SUM(${own}) AS n_events,
        SUM(${own} AND (flag_bits & ${FLAG_BITS.error}) != 0) AS n_errors,
        MIN(CASE WHEN ${timed} AND (flag_bits & ${INHERITED}) = 0 THEN ts END) AS start_own,
        MAX(CASE WHEN ${timed} AND (flag_bits & ${INHERITED}) = 0 THEN ts END) AS end_own,
        MIN(CASE WHEN ${timed} THEN ts END) AS start_all,
        MAX(CASE WHEN ${timed} THEN ts END) AS end_all,
        SUM(${cost(false)}) AS cost_turns,
        MAX(${cost(true)}) AS cost_running,
        SUM((flag_bits & ${INHERITED}) != 0) AS n_inherited,
        SUM(${own} AND ts_src = 'logged') AS ts_logged,
        json_group_array(DISTINCT src_id) AS sources
      FROM events ${scoped ? '' : 'NOT INDEXED'} WHERE ${inSet('session_id')} GROUP BY session_id`)
    .all() as unknown as EventAgg[];
  // Models the session used itself (copied context left out), in order of first use, without Claude's '<synthetic>'
  // error placeholder. Read from ev_model.
  // An aggregate with DISTINCT and ORDER BY does not keep that order under every query plan, so it is built here.
  const models = new Map<string, string[]>();
  for (const r of db.prepare(`
      SELECT session_id, model, MIN(seq) AS first FROM events INDEXED BY ev_model
      WHERE ${inSet('session_id')} AND model IS NOT NULL AND model != '<synthetic>' AND (flag_bits & ${INHERITED}) = 0
      GROUP BY session_id, model ORDER BY session_id, first`).all() as { session_id: string; model: string }[]) {
    const list = models.get(r.session_id);
    if (list) list.push(r.model);
    else models.set(r.session_id, [r.model]);
  }
  // A span that opens on an inherited event is copied context (spans.inherited), so its tokens are not the
  // session's own. Only sessions holding inherited events can have such spans; the check is a lookup per span.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS link_inherited (id TEXT PRIMARY KEY); DELETE FROM temp.link_inherited');
  const addInherited = db.prepare('INSERT INTO temp.link_inherited (id) VALUES (?)');
  for (const e of events) if (e.n_inherited > 0) addInherited.run(e.session_id);
  db.exec(`
    UPDATE spans SET inherited = 1
    WHERE inherited = 0 AND session_id IN (SELECT id FROM temp.link_inherited)
      AND EXISTS (SELECT 1 FROM events fe WHERE fe.id = spans.first_event AND (fe.flag_bits & ${INHERITED}) != 0)`);
  const costOf = (e: EventAgg) => (e.cost_turns == null && e.cost_running == null ? null : (e.cost_turns ?? 0) + (e.cost_running ?? 0));
  // Token totals come from the session's own llm spans.
  const spans = db
    .prepare(`
      SELECT session_id,
        SUM(kind = 'llm') AS n_llm, SUM(kind = 'tool') AS n_tools, SUM(kind = 'turn') AS n_turns,
        SUM(CASE WHEN kind = 'llm' THEN json_extract(attrs, '$.tokens.input') END) AS tok_in,
        SUM(CASE WHEN kind = 'llm' THEN json_extract(attrs, '$.tokens.uncached') END) AS tok_uncached,
        SUM(CASE WHEN kind = 'llm' THEN json_extract(attrs, '$.tokens.cache_read') END) AS tok_cache_read,
        SUM(CASE WHEN kind = 'llm' THEN json_extract(attrs, '$.tokens.cache_write') END) AS tok_cache_write,
        SUM(CASE WHEN kind = 'llm' THEN json_extract(attrs, '$.tokens.output') END) AS tok_out,
        SUM(CASE WHEN kind = 'llm' THEN json_extract(attrs, '$.tokens.reasoning') END) AS tok_reasoning
      FROM spans sp
      WHERE ${inSet('sp.session_id')} AND sp.inherited = 0
      GROUP BY session_id`)
    .all() as unknown as SpanAgg[];

  const spanBy = new Map(spans.map((s) => [s.session_id, s]));

  const measures = measureSessions(db, inSet('session_id'), scoped, false);
  for (const e of events) {
    let m = measures.get(e.session_id);
    if (!m) measures.set(e.session_id, (m = emptySessionMeasures()));
    Object.assign(m, { ts_n: e.n_events, ts_logged: e.ts_logged });
  }
  const update = db.prepare(`
    UPDATE sessions SET start_ts = COALESCE(?, created_ts), end_ts = ?, n_events = ?, n_llm = ?, n_tools = ?, n_turns = ?,
      n_errors = ?, tok_in = ?, tok_uncached = ?, tok_cache_read = ?, tok_cache_write = ?, tok_out = ?, tok_reasoning = ?,
      cost_usd = ?, models = COALESCE(?, models), sources = ?, measures = ?
    WHERE id = ?`);
  const withEvents = new Set<string>();
  for (const e of events) {
    withEvents.add(e.session_id);
    const sp = spanBy.get(e.session_id);
    const used = models.get(e.session_id);
    const m = used ? JSON.stringify(used) : null;
    update.run(
      e.start_own ?? e.start_all, e.end_own ?? e.end_all, e.n_events, sp?.n_llm ?? 0, sp?.n_tools ?? 0, sp?.n_turns ?? 0,
      e.n_errors, sp?.tok_in ?? null, sp?.tok_uncached ?? null, sp?.tok_cache_read ?? null, sp?.tok_cache_write ?? null,
      sp?.tok_out ?? null, sp?.tok_reasoning ?? null, costOf(e), m, e.sources,
      measures.has(e.session_id) ? JSON.stringify(measures.get(e.session_id)) : null, e.session_id,
    );
  }

  // Sessions without events: 'ok' ones are reset (and usually collected next); a deleted source's
  // session keeps its last known totals.
  const empty = db
    .prepare(`SELECT id, state FROM sessions WHERE ${inSet('id')}`)
    .all() as { id: string; state: string }[];
  const reset = db.prepare(`
    UPDATE sessions SET start_ts = created_ts, end_ts = NULL, n_events = 0, n_llm = 0, n_tools = 0, n_turns = 0, n_errors = 0,
      tok_in = NULL, tok_uncached = NULL, tok_cache_read = NULL, tok_cache_write = NULL, tok_out = NULL, tok_reasoning = NULL,
      cost_usd = NULL, sources = NULL, measures = NULL
    WHERE id = ?`);
  const fillStart = db.prepare('UPDATE sessions SET start_ts = COALESCE(start_ts, created_ts) WHERE id = ?');
  for (const s of empty) {
    if (withEvents.has(s.id)) continue;
    if (s.state === 'ok') reset.run(s.id);
    else fillStart.run(s.id);
  }
}

/** Sessions with nothing left to show: no events, no enrichment, and no deletion to report. */
function collectGarbage(db: DatabaseSync, where: string): void {
  db.exec(`
    DELETE FROM sessions WHERE ${where} AND state = 'ok'
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id)
      AND NOT EXISTS (SELECT 1 FROM enrich en WHERE en.session_id = sessions.id)`);
}

// ---------------------------------------------------------------------------
// Session tree

/** A span whose `link_session` names a session is that session's parent span (and its session the parent). */
function resolveParentSpans(db: DatabaseSync): string[] {
  const ids = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map((r) => r.id);
  return [
    ...ids(`UPDATE sessions SET parent_span_id = (
      SELECT sp.id FROM spans sp WHERE sp.link_session = sessions.id AND sp.session_id != sessions.id
      ORDER BY sp.start_ts LIMIT 1)
    WHERE parent_span_id IS NULL
      AND EXISTS (SELECT 1 FROM spans sp WHERE sp.link_session = sessions.id AND sp.session_id != sessions.id)
    RETURNING id`),
    ...ids(`UPDATE sessions SET parent_id = (SELECT sp.session_id FROM spans sp WHERE sp.id = sessions.parent_span_id)
    WHERE parent_id IS NULL AND parent_span_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM spans sp WHERE sp.id = sessions.parent_span_id AND sp.session_id != sessions.id)
    RETURNING id`),
  ];
}

/** n_children and root_id for every session; returns the sessions it changed. A parent that is not in the index ends the walk. */
function linkTree(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT id, parent_id, root_id, n_children FROM sessions').all() as {
    id: string; parent_id: string | null; root_id: string | null; n_children: number;
  }[];
  const parentOf = new Map<string, string | null>();
  const children = new Map<string, number>();
  for (const r of rows) parentOf.set(r.id, r.parent_id);
  for (const r of rows) {
    if (r.parent_id && parentOf.has(r.parent_id)) children.set(r.parent_id, (children.get(r.parent_id) ?? 0) + 1);
  }
  const update = db.prepare('UPDATE sessions SET root_id = ?, n_children = ? WHERE id = ?');
  const changed: string[] = [];
  for (const r of rows) {
    let root = r.id;
    const seen = new Set([root]);
    for (let p = parentOf.get(root); p && parentOf.has(p) && !seen.has(p); p = parentOf.get(root)) {
      seen.add(p);
      root = p;
    }
    const n = children.get(r.id) ?? 0;
    if (root !== r.root_id || n !== r.n_children) {
      update.run(root, n, r.id);
      changed.push(r.id);
    }
  }
  return changed;
}
