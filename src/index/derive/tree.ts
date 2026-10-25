// Loads one root tree (a root session and its descendants) into memory for the analysis pass (SPEC §12.3.1).
// Only own events are read (`flag_bits & 6 = 0`), in each session's event order, and attrs only for the kinds a rule
// reads. An incremental pass loads only some sessions of a tree (derive/plan.ts); the others keep their stored rows,
// and the loaded ones read what they need of them from those rows (Ses.stored).

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AgentKind, Attrs, EpisodeRow, SessionRole, TokenUsage, ToolKindTag, TurnImpact } from '../../model/types.ts';

export interface Ev {
  rid: number;
  id: string;
  sid: string;
  ts: number;
  /**
   * Position in the session's event order. One source: its file order. A session spread over several sources (a
   * Cowork transcript and its audit log, Codex continuation pages) merges them by time, each source keeping its order.
   */
  seq: number;
  kind: string;
  proto: string;
  span: string | null;
  turn: string | null;
  tool: string | null;
  toolKind: ToolKindTag | null;
  exit: number | null;
  flags: number;
  /** Parsed attrs; empty for kinds no rule reads (thinking, attachments, snapshots). */
  a: Attrs;
  /** Codex parsed_cmd objects of a CommandExecution item (or of the item mirroring an exec_command call). */
  pcmd?: unknown;
  /** The native record of file-history backups and external edits (their paths are not in attrs). */
  nat?: Record<string, any> | null;
  /** events.model of a tool call: the model that issued it (Statistics ▸ Tools by model). */
  model?: string | null;
  /** Source bytes, counted on the first event of each line (Statistics ▸ Kinds). */
  bytes: number;
}

export interface Span {
  id: string;
  sid: string;
  kind: string;
  parent: string | null;
  start: number | null;
  end: number | null;
  dur: number | null;
  durSrc: string | null;
  status: string | null;
  link: string | null;
  firstEvent: string | null;
  /** turn spans: attrs.turn.origin. */
  origin: string | null;
  /** llm and hook spans: the span's name. */
  name?: string | null;
  /** llm and turn spans: attrs.llm.model (Statistics ▸ Models; a turn's model issued its Codex tool calls). */
  model?: string | null;
  /** hook spans: attrs.hook.{event, command, duration_ms} (Endpoints ▸ hook). */
  hook?: { event: string | null; command: string | null; ms: number | null };
  /** llm spans: attrs.tokens (Statistics ▸ Models). */
  tokens?: TokenUsage | null;
}

/** An episode of a session this pass does not load, as its stored row gives it. */
export type StoredEpisode = Pick<EpisodeRow, 'id' | 'sessionId' | 'turnId' | 'outcome' | 'family' | 'loop' | 'wallUs' | 'nSteps' | 'endTs'>;

/**
 * What a session this pass does not load tells the sessions it does (a parent's delegation, a silent-child alarm):
 * read from its stored rows, which hold until its events change, and then it is loaded.
 */
export interface Stored {
  /** session_rollup.worst_impact; clean without a row. */
  worst: TurnImpact;
  /** Its last turn (turn_rollup.n), with whether it is open. */
  lastTurn: { id: string; open: boolean } | null;
  episodes: StoredEpisode[];
}

export interface Ses {
  id: string;
  agent: AgentKind;
  role: SessionRole;
  parentId: string | null;
  parentSpanId: string | null;
  rootId: string;
  cwd: string | null;
  meta: Record<string, any> | null;
  startTs: number | null;
  endTs: number | null;
  tokIn: number | null;
  tokOut: number | null;
  /** Distance from the root session (0 for the root). */
  depth: number;
  events: Ev[];
  spans: Span[];
  /** Set on a session this pass does not load (no events or spans) when a loaded session reads it. */
  stored?: Stored;
}

export interface TreeInput {
  rootId: string;
  /** The sessions this pass derives: root first, then descendants by depth. */
  sessions: Ses[];
  /** Every session of the tree, loaded or not. */
  session: Map<string, Ses>;
  span: Map<string, Span>;
  byId: Map<string, Ev>;
  byRid: Map<number, Ev>;
  /**
   * The index's newest event time, at most the wall clock: idleness is measured against it (derive/turns.ts), so the
   * rows stay a function of the indexed events, also when a pass re-derives history.
   */
  indexTs: number;
  /** The tree's newest own event: of the loaded sessions' events, and session_rollup.last_ts of the others. */
  newestTs: number;
}

const j = (path: string) => `json_extract(p.attrs, '${path}')`;
/** Kinds whose whole attrs load and parse in JS (one parse of a few KB beats many json_extract copies of the output). */
const WHOLE = `e.kind IN ('tool.call', 'tool.result', 'tool.exec', 'hook.run', 'agent.status', 'llm.error', 'llm.refusal', 'permission.decision')
  OR (e.kind = 'session.state' AND e.proto LIKE 'codex/%') OR e.proto = 'claude/attachment/task_status'`;
/** Records whose paths only the native record holds: file-history backups and external edits. */
const NATIVE = `e.kind = 'harness.file' OR e.proto = 'claude/attachment/edited_text_file'`;
/** Small, numerous kinds: the few fields the rules read, as columns. */
const COLUMNS = [
  [`CASE WHEN ${WHOLE} THEN p.attrs END`, 'attrs'],
  [`CASE WHEN e.kind IN ('llm.usage', 'llm.text') THEN ${j('$.llm.message_id')} END`, 'mid'],
  [`CASE WHEN e.kind = 'llm.usage' THEN ${j('$.tokens.input')} END`, 't_in'],
  [`CASE WHEN e.kind = 'llm.usage' THEN ${j('$.tokens.output')} END`, 't_out'],
  [`CASE WHEN e.kind = 'llm.usage' THEN ${j('$.tokens.uncached')} END`, 't_unc'],
  [`CASE WHEN e.kind = 'llm.usage' THEN ${j('$.tokens.context_window')} END`, 't_win'],
  [`CASE WHEN e.kind = 'llm.usage' THEN ${j('$.llm.latency_ms')} END`, 'lat'],
  // A turn's final text is read whole (the claim check); prompts only by their start (the correction rule).
  [`CASE WHEN e.kind = 'llm.text' THEN ${j('$.text')} WHEN e.kind = 'user.prompt' THEN substr(${j('$.text')}, 1, 600) END`, 'text'],
  [`CASE WHEN e.kind = 'context.attachment' THEN ${j('$.context.type')} END`, 'ctype'],
  [`CASE WHEN ${NATIVE} THEN p.native END`, 'nat'],
  [`CASE WHEN e.kind = 'tool.exec' THEN json_extract(p.native, '$.payload.item.parsed_cmd') END`, 'pcmd'],
  // Codex item_completed records that mirror an exec_command call (flagged dup) carry its parsed_cmd.
  [`CASE WHEN (e.flag_bits & 6) = 4 THEN json_extract(p.native, '$.payload.item.id') END`, 'mirror_of'],
  [`CASE WHEN e.kind = 'tool.call' THEN e.model END`, 'model'],
] as const;
const sj = (path: string) => `json_extract(attrs, '${path}')`;

export class TreeLoader {
  private readonly qSessions: StatementSync;
  private readonly qEvents: StatementSync;
  private readonly qSpans: StatementSync;
  private readonly qRollups: StatementSync;
  private readonly qLastTurn: StatementSync;
  private readonly qEpisodes: StatementSync;
  private readonly db: DatabaseSync;
  private indexTs: number | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.qSessions = db.prepare(`
      SELECT id, agent, role, parent_id, parent_span_id, root_id, cwd, COALESCE(meta_enriched, meta) AS meta, start_ts, end_ts, tok_in, tok_out
      FROM sessions WHERE root_id = ? OR id = ?`);
    this.qRollups = db.prepare(`SELECT r.session_id, r.worst_impact, r.last_ts FROM sessions s JOIN session_rollup r ON r.session_id = s.id
      WHERE s.root_id = ? OR s.id = ?`);
    this.qLastTurn = db.prepare('SELECT turn_id, open FROM turn_rollup WHERE session_id = ? ORDER BY n DESC LIMIT 1');
    this.qEpisodes = db.prepare('SELECT id, session_id, turn_id, outcome, family, loop, wall_us, n_steps, end_ts FROM episodes WHERE session_id = ?');
    this.qEvents = db.prepare(`
      SELECT e.rid, e.id, e.src_id, e.ts, e.kind, e.proto, e.span_id, e.turn_id, e.tool_name, e.tool_kind, e.exit_code, e.flag_bits,
        CASE WHEN coalesce(e.src_block, 0) = 0 THEN coalesce(e.src_len, 0) ELSE 0 END AS bytes,
        ${COLUMNS.map(([expr, name]) => `${expr} AS ${name}`).join(',\n        ')}
      FROM events e LEFT JOIN event_payload p ON p.rid = e.rid
      WHERE e.session_id = ? AND ((e.flag_bits & 6) = 0 OR ((e.flag_bits & 6) = 4 AND e.kind = 'tool.exec' AND e.proto LIKE '%CommandExecution'))
      ORDER BY e.seq`);
    this.qSpans = db.prepare(`
      SELECT id, kind, parent_id, start_ts, end_ts, dur, dur_src, status, link_session, first_event,
        CASE WHEN kind = 'turn' THEN ${sj('$.turn.origin')} END AS origin,
        CASE WHEN kind IN ('llm', 'hook') THEN name END AS name,
        CASE WHEN kind IN ('llm', 'turn') THEN ${sj('$.llm.model')} END AS model,
        CASE WHEN kind = 'llm' THEN ${sj('$.tokens')} END AS tokens,
        CASE WHEN kind = 'hook' THEN json_array(${sj('$.hook.event')}, ${sj('$.hook.command')}, ${sj('$.hook.duration_ms')}) END AS hook
      FROM spans WHERE session_id = ? AND inherited = 0`);
  }

  /**
   * One tree; `only` loads just those sessions (an incremental pass, derive/plan.ts), with the stored facts of the
   * other sessions they spawn (Ses.stored).
   */
  load(rootId: string, only?: ReadonlySet<string> | null): TreeInput {
    const rows = this.qSessions.all(rootId, rootId) as Record<string, any>[];
    const session = new Map<string, Ses>();
    for (const r of rows) {
      session.set(r.id, {
        id: r.id, agent: r.agent, role: r.role, parentId: r.parent_id, parentSpanId: r.parent_span_id, rootId,
        cwd: r.cwd, meta: parseJson(r.meta), startTs: r.start_ts, endTs: r.end_ts, tokIn: r.tok_in, tokOut: r.tok_out,
        depth: 0, events: [], spans: [],
      });
    }
    for (const s of session.values()) {
      let d = 0;
      for (let p = s.parentId; p && session.has(p) && d < 50; p = session.get(p)!.parentId) d++;
      s.depth = d;
    }
    const sessions = [...session.values()].filter((s) => !only || only.has(s.id)).sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
    const span = new Map<string, Span>();
    const byId = new Map<string, Ev>();
    const byRid = new Map<number, Ev>();
    let newestTs = -Infinity;
    for (const s of sessions) {
      const mirrors = new Map<string, unknown>();
      const bySource = new Map<string, Ev[]>();
      for (const r of this.qEvents.iterate(s.id) as Iterable<Record<string, any>>) {
        if (r.mirror_of) {
          if (r.pcmd) mirrors.set(r.mirror_of, parseJson(r.pcmd));
          continue;
        }
        const ev: Ev = {
          rid: r.rid, id: r.id, sid: s.id, ts: r.ts, seq: 0, kind: r.kind, proto: r.proto, span: r.span_id, turn: r.turn_id,
          tool: r.tool_name, toolKind: r.tool_kind, exit: r.exit_code, flags: r.flag_bits, a: attrsOf(r), bytes: r.bytes,
        };
        if (r.pcmd) ev.pcmd = parseJson(r.pcmd);
        if (r.nat) ev.nat = parseJson(r.nat);
        if (r.model !== null) ev.model = r.model;
        if (ev.ts > newestTs) newestTs = ev.ts;
        let list = bySource.get(r.src_id);
        if (!list) bySource.set(r.src_id, (list = []));
        list.push(ev);
        byId.set(ev.id, ev);
        byRid.set(ev.rid, ev);
      }
      s.events = mergeByTime([...bySource.values()]);
      s.events.forEach((e, i) => (e.seq = i));
      // Mirrors are written after their call; attach their parsed_cmd to it.
      if (mirrors.size) {
        for (const e of s.events) {
          const m = e.kind === 'tool.call' && e.a.tool?.call_id ? mirrors.get(e.a.tool.call_id) : undefined;
          if (m) e.pcmd = m;
        }
      }
      for (const r of this.qSpans.iterate(s.id) as Iterable<Record<string, any>>) {
        const sp: Span = {
          id: r.id, sid: s.id, kind: r.kind, parent: r.parent_id, start: r.start_ts, end: r.end_ts, dur: r.dur, durSrc: r.dur_src,
          status: r.status, link: r.link_session, firstEvent: r.first_event, origin: r.origin,
        };
        if (r.kind === 'llm') Object.assign(sp, { name: r.name, model: r.model, tokens: parseJson(r.tokens) });
        else if (r.kind === 'turn') sp.model = r.model;
        if (r.hook) {
          const [event, command, ms] = parseJson(r.hook) ?? [];
          Object.assign(sp, { name: r.name, hook: { event: event ?? null, command: command ?? null, ms: typeof ms === 'number' ? ms : null } });
        }
        s.spans.push(sp);
        span.set(sp.id, sp);
      }
    }
    if (only) newestTs = Math.max(newestTs, this.stored(rootId, sessions, session, span));
    // Read once per pass: the trees of one pass share it.
    this.indexTs ??= indexClock(this.db);
    return { rootId, sessions, session, span, byId, byRid, indexTs: this.indexTs, newestTs };
  }

  /**
   * Stored facts of the sessions not loaded that a loaded one spawns (a span links it, or its workflow span is loaded);
   * returns the newest stored event time of every session not loaded.
   */
  private stored(rootId: string, loaded: Ses[], session: Map<string, Ses>, span: Map<string, Span>): number {
    const ids = new Set(loaded.map((s) => s.id));
    const read = new Set<string>();
    for (const s of loaded) for (const sp of s.spans) if (sp.link && session.has(sp.link) && !ids.has(sp.link)) read.add(sp.link);
    for (const s of session.values()) if (!ids.has(s.id) && s.parentSpanId && span.has(s.parentSpanId)) read.add(s.id);
    let newest = -Infinity;
    const worst = new Map<string, TurnImpact>();
    for (const r of this.qRollups.iterate(rootId, rootId) as Iterable<Record<string, any>>) {
      if (ids.has(r.session_id)) continue;
      if (r.last_ts > newest) newest = r.last_ts;
      worst.set(r.session_id, r.worst_impact);
    }
    for (const id of read) {
      const t = this.qLastTurn.get(id) as { turn_id: string; open: number } | undefined;
      const episodes = (this.qEpisodes.all(id) as Record<string, any>[]).map((e): StoredEpisode => ({
        id: e.id, sessionId: e.session_id, turnId: e.turn_id, outcome: e.outcome, family: e.family, loop: !!e.loop, wallUs: e.wall_us, nSteps: e.n_steps,
        endTs: e.end_ts,
      }));
      session.get(id)!.stored = { worst: worst.get(id) ?? 'clean', lastTurn: t ? { id: t.turn_id, open: !!t.open } : null, episodes };
    }
    return newest;
  }
}

/** The index's newest event time, at most the wall clock (TreeInput.indexTs). */
export function indexClock(db: DatabaseSync): number {
  const clock = (db.prepare("SELECT value FROM meta WHERE key = 'capture_analysis_clock'").get() as { value: string } | undefined)?.value;
  return Math.min((db.prepare('SELECT max(ts) AS ts FROM events').get() as { ts: number | null }).ts ?? 0, clock ? Number(clock) : Date.now() * 1000);
}

/** One list per source, each in file order: merged by time, a source never reordered; ties go to the larger source. */
function mergeByTime(lists: Ev[][]): Ev[] {
  if (lists.length === 1) return lists[0];
  lists.sort((a, b) => b.length - a.length);
  const out: Ev[] = [];
  const at = lists.map(() => 0);
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      if (at[i] < lists[i].length && (best < 0 || lists[i][at[i]].ts < lists[best][at[best]].ts)) best = i;
    }
    if (best < 0) return out;
    out.push(lists[best][at[best]++]);
  }
}

/** Attrs of one row: the whole parsed JSON for WHOLE kinds, else the few columns (absent fields stay absent). */
function attrsOf(r: Record<string, any>): Attrs {
  if (r.attrs) return parseJson(r.attrs) ?? {};
  const a: Attrs = {};
  if (r.mid !== null || r.lat !== null) a.llm = { ...(r.mid !== null ? { message_id: r.mid } : {}), ...(r.lat !== null ? { latency_ms: r.lat } : {}) };
  if (r.t_in !== null || r.t_out !== null) {
    a.tokens = { input: r.t_in ?? undefined, output: r.t_out ?? undefined, uncached: r.t_unc ?? undefined, context_window: r.t_win ?? undefined };
  }
  if (r.text !== null) a.text = r.text;
  if (r.ctype !== null) a.context = { type: r.ctype };
  return a;
}

function parseJson(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
