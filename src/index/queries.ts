// Read side of the index (SPEC §5.4, §6): materialized views, lookups, raw bytes, statistics and side files.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, extname, join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type DiscoverEnv, INTERRUPT_NOTE, isCredentialPath, readRange } from '../adapters/adapter.ts';
import { VerifiedSource, type SourceFingerprint } from '../raw/evidence.ts';
import { compileFilter, FilterError } from '../filter/compile.ts';
import { AGENT_SQL, listFields, resolveName, type FieldDef } from '../filter/fields.ts';
import { layerOf } from '../model/kinds.ts';
import { FAILURE_TIERS, FLAG_BITS, GROUP_SEVERITY } from '../model/types.ts';
import type { Attrs, ConversationItem, DerivedExpertGroup, EventFlag, EventRow, HealthReport, SessionRow, SpanRow, TokenUsage } from '../model/types.ts';
import { jsonRanges, shortenJson } from '../raw/raw.ts';
import {
  type CaptureInfo, type ExpertQuery, type ExpertResult, type FieldRef, type FileResult, GLOBAL_VIEW, type Histogram, type IndexQueries,
  type InfoResult, type IoMetric, type KindNode, type ModelStat, type PairStat, type PerformanceBottleneck, type SourceRow, type SourcesResult,
  type StatsScope, type ToolStat, type ViewInfo, type ViewRef, type ViewSort, type ViewSpec,
} from './api.ts';
import { indexSchemaVersion } from './db.ts';
import { analysisOutdated } from './derive.ts';
import {
  type BusyInterval, CACHE_INPUT, CACHE_READ, CALL_INPUT, CALL_LATENCY, CALL_OUTPUT_RATE, CALL_TTFT, type CallSample, CallStats, percentile,
  performanceTimeline, type ToolStart,
} from './performance.ts';
import { spanBucket } from './derive/time.ts';

/** Error with an HTTP status for the server to pass through (unknown view or event, bad coloring rule). */
export class QueryError extends Error {
  status: number;
  code: string;
  /** Extra fields for the error body, e.g. `ruleId`, `start` and `end` of a bad coloring rule. */
  details?: Record<string, unknown>;
  constructor(message: string, status: number, code: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

type Row = Record<string, any>;
type Param = string | number | null;

const MAX_VIEWS = 16;
/** Rows kept across all cached views; temp tables live in memory, so this bounds their footprint. */
const VIEW_ROW_BUDGET = 8_000_000;
const MAX_PAGE = 1000;
const MAX_IO_BINS = 10_000;
const DEFAULT_SPAN_LIMIT = 20_000;
const DETAIL_LIMIT = 5000;
const MAX_COLOR_RULES = 64;
const MAX_COLUMNS = 16;
const MAX_FIELD_MAP = 5000;
/** Longest raw string a client may ask for; longer strings are always shortened. */
const RAW_MAX_STRING = 1_000_000;
/** How long one logging-health report is reused when nothing was indexed. */
const HEALTH_TTL_MS = 120_000;
const RELATED_LIMIT = 200;
const ERR = FLAG_BITS.error;
/** Copies of information held elsewhere; hidden unless a view asks for them. */
const HIDDEN = FLAG_BITS.inherited | FLAG_BITS.dup;
const FLAG_LIST = Object.entries(FLAG_BITS) as [EventFlag, number][];
const TOKEN_FIELDS = ['input', 'uncached', 'cache_read', 'cache_write', 'output', 'reasoning'] as const;
const TOKEN_COLS = TOKEN_FIELDS.map((k) => `json_extract(sp.attrs, '$.tokens.${k}') AS ${k}`).join(', ');
const TOKEN_SUMS = TOKEN_FIELDS.map((k) => `sum(json_extract(sp.attrs, '$.tokens.${k}')) AS ${k}`).join(', ');
/** Spans that group many unrelated events; their members are not "related" to each other. */
const CONTAINER_SPANS = new Set(['session', 'turn', 'workflow', 'phase']);
const SEVERITY_RANK: Record<string, number> = { error: 0, warn: 1, note: 2, chat: 3 };
/** An expert row's severity: its group's GROUP_SEVERITY when the group has one, else the row's own. */
const SEVERITY_SQL = `CASE x.grp ${Object.entries(GROUP_SEVERITY).map(([g, sev]) => `WHEN '${g}' THEN '${sev}'`).join(' ')} ELSE x.severity END`;
const CONVERSATION_KINDS = [
  'user.prompt', 'user.inject', 'llm.text', 'llm.thinking', 'llm.error', 'llm.refusal', 'tool.call', 'tool.result', 'tool.exec',
  'agent.spawn', 'agent.message', 'agent.status', 'context.compaction', 'turn.end', 'turn.abort',
].map((k) => `'${k}'`).join(', ');

/** EventRow columns over `events e`. The agent comes from the session id prefix (SPEC §3.1). */
const EVENT_COLS = `e.rid, e.id, e.session_id, e.ts, e.ts_src, e.seq, e.kind, e.proto, e.actor, e.summary, e.span_id,
  e.turn_id, e.tool_name, e.model, e.dur, e.tok_in, e.tok_out, e.flag_bits, ${AGENT_SQL} AS agent`;
const PAYLOAD_JOIN = 'LEFT JOIN event_payload p ON p.rid = e.rid';
/** Sessions in a JSON array parameter plus all their descendants through parent_id. */
const WITH_DESCENDANTS = `WITH RECURSIVE tree(id) AS (SELECT value FROM json_each(?)
  UNION SELECT c.id FROM sessions c JOIN tree ON c.parent_id = tree.id) SELECT id FROM tree`;

/** Bin widths for the I/O graph, in µs: 1 ms up to 7 days. */
const NICE_US = [1e3, 1e4, 1e5, 1e6, 5e6, 1e7, 3e7, 6e7, 3e8, 6e8, 1.8e9, 3.6e9, 1.08e10, 2.16e10, 4.32e10, 8.64e10, 6.048e11];

/** Primary ORDER BY column of each view sort; every sort but `seq` breaks ties by time, session and file order. */
const SORT_COLUMN: Record<ViewSort, string | null> = {
  ts: null, seq: null, dur: 'e.dur', tokIn: 'e.tok_in', tokOut: 'e.tok_out', kind: 'e.kind', tool: 'e.tool_name', session: 'e.session_id',
};

/** EventRow keys → the filter field that selects them (fieldMap of GET /api/events/:id). */
const EVENT_FIELDS: Record<string, string> = {
  id: 'id', session: 'session', agent: 'agent', ts: 'ts', tsSrc: 'ts_src', seq: 'seq', kind: 'kind', proto: 'proto',
  actor: 'actor', summary: 'summary', span: 'span', turn: 'turn', toolName: 'tool.name', model: 'model', dur: 'dur',
  tokIn: 'tokens.input', tokOut: 'tokens.output',
};

const TEXT = 'text/plain; charset=utf-8';
// .html, .svg and .xml are deliberately absent: side files must never run as active content in the viewer's origin.
const CONTENT_TYPES: Record<string, string> = {
  '.txt': TEXT, '.log': TEXT, '.jsonl': TEXT, '.diff': TEXT, '.patch': TEXT,
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export interface LiveStatus {
  watch: { enabled: boolean; intervalMs: number | null };
  lastIndexOkAt: number | null;
  lastIndexError: string | null;
  lastChangeAt: number | null;
}

export interface QueryContext {
  mode: 'live' | 'capture';
  indexPath: string;
  capturePath?: string;
  getIndexing: () => InfoResult['indexing'];
  /** Live mode: watch policy and the outcome of the last index runs (the server). */
  getLive?: () => LiveStatus;
  /** Home and Application Support folders for the local health report (tests). */
  healthEnv?: DiscoverEnv;
  /** Instance prefix for view ids (a query worker passes its own, so ids name their worker). */
  instance?: string;
}

interface CompiledRule {
  id: string;
  sql: string;
  params: Param[];
  payload: boolean;
}

interface View {
  id: string;
  table: string;
  sort: ViewSort;
  order: 'asc' | 'desc';
  info: ViewInfo;
  /** No filter, scope or options: the view holds exactly the events global statistics cover. */
  everything: boolean;
  /** Sessions and nothing else (no filter, time range or options): the view holds every visible event of `sessions`. */
  sessionsOnly: boolean;
  /** Sessions the view selects (with descendants), or null when it is not scoped to sessions. */
  sessions: Set<string> | null;
  /** Rebuild on the next createView with the same spec: an index run changed data the view covers. */
  stale: boolean;
  rules: CompiledRule[];
  /** The view table has an index on rid (built on first need: locate, find, span and diagnostics scope). */
  ridIndexed: boolean;
  /** Sessions with at least one row in the view (computed on first need). */
  rowSessions?: string[];
  /** The time range of the spec; statistics over intervals clip to it. */
  range: { from: number | null; to: number | null };
}

/** The events a statistic covers: a view's rows, or every event that is not a hidden copy. */
interface Scope {
  /** FROM clause that binds the scope's events as `e`. */
  from: string;
  where: string;
  /** The view whose rows are the scope; null for every event that is not a hidden copy. */
  view: View | null;
  /** Reported with the response. */
  label: StatsScope;
}

/** Event columns in the covering index ev_ts (schema.sql). */
const EV_TS_COLUMNS = new Set(['rid', 'ts', 'session_id', 'seq', 'flag_bits', 'kind', 'tok_in', 'tok_out', 'dur', 'tool_name', 'tool_kind', 'exit_code', 'model']);

// ---------------------------------------------------------------------------
// Row mapping

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function flagsOf(bits: number): EventFlag[] {
  const out: EventFlag[] = [];
  for (const [flag, bit] of FLAG_LIST) if (bits & bit) out.push(flag);
  return out;
}

function eventRow(r: Row): EventRow {
  return {
    no: r.no ?? null, id: r.id, rid: r.rid, session: r.session_id, agent: r.agent, ts: r.ts, tsSrc: r.ts_src, seq: r.seq,
    kind: r.kind, proto: r.proto, actor: r.actor, summary: r.summary, span: r.span_id, turn: r.turn_id,
    toolName: r.tool_name, model: r.model, dur: r.dur, tokIn: r.tok_in, tokOut: r.tok_out, flags: flagsOf(r.flag_bits),
  };
}

const SESSION_TOKEN_COLS: [keyof TokenUsage, string][] = [
  ['input', 'tok_in'], ['uncached', 'tok_uncached'], ['cache_read', 'tok_cache_read'], ['cache_write', 'tok_cache_write'],
  ['output', 'tok_out'], ['reasoning', 'tok_reasoning'],
];

function sessionRow(r: Row): SessionRow {
  const tokens: TokenUsage = {};
  for (const [key, col] of SESSION_TOKEN_COLS) if (r[col] != null) tokens[key] = r[col];
  return {
    id: r.id, agent: r.agent, nativeId: r.native_id, role: r.role, state: r.state, parentId: r.parent_id,
    parentSpanId: r.parent_span_id, rootId: r.root_id ?? r.id, title: r.title, cwd: r.cwd, project: r.project,
    gitBranch: r.git_branch, models: parseJson(r.models, []), version: r.version, originator: r.originator,
    entrypoint: r.entrypoint, start: r.start_ts ?? r.created_ts, end: r.end_ts, nEvents: r.n_events, nLlm: r.n_llm,
    nTools: r.n_tools, nTurns: r.n_turns, nErrors: r.n_errors, nChildren: r.n_children, tokens, costUsd: r.cost_usd,
  };
}

function spanRow(r: Row): SpanRow {
  return {
    id: r.id, session: r.session_id, kind: r.kind, name: r.name ?? '', parent: r.parent_id, start: r.start_ts ?? 0,
    end: r.end_ts, dur: r.dur, durSrc: r.dur_src ?? 'unknown', status: r.status ?? 'unknown', linkSession: r.link_session,
    firstEvent: r.first_event, lastEvent: r.last_event, depth: r.depth, attrs: parseJson(r.attrs, {}),
  };
}

function sourceRow(r: Row): SourceRow {
  return {
    id: r.id, agent: r.agent, kind: r.kind, path: r.path, size: r.size ?? 0, mtimeMs: r.mtime_ms ?? 0, lines: r.lines,
    malformed: r.malformed, unknown: r.unknown, skipped: r.skipped, inherited: r.inherited, dialect: r.dialect,
    status: r.status, error: r.error, existsNow: r.exists_now === 1, indexedAt: r.indexed_at, parseMs: r.parse_ms,
  };
}

function addTokens(acc: TokenUsage, r: Row): void {
  for (const k of TOKEN_FIELDS) if (r[k] != null) acc[k] = (acc[k] ?? 0) + r[k];
}

/** Stored `event` rows ('<kind> <proto>') summed per kind and proto, as the events scan of statsKinds returns them. */
function sumKinds(rows: Row[]): Row[] {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const at = (r.key as string).indexOf(' ');
    const k = out.get(r.key) ?? { kind: r.key.slice(0, at), proto: r.key.slice(at + 1), n: 0, bytes: 0 };
    k.n += r.n;
    k.bytes += r.bytes ?? 0;
    out.set(r.key, k);
  }
  return [...out.values()];
}

function withTotal(t: TokenUsage): TokenUsage {
  if (t.input != null || t.output != null) t.total = (t.input ?? 0) + (t.output ?? 0);
  return t;
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = Math.floor(v ?? def);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function contentTypeFor(path: string, data: Buffer): string {
  // Unknown extensions are served as text unless the bytes look binary.
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? (data.subarray(0, 8192).includes(0) ? 'application/octet-stream' : TEXT);
}

function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Read one source line in live mode, checking that the file still holds it where it was indexed.
 * The bytes on both sides of the line must be newlines (or the file edges), which catches rewritten files.
 */
export async function readLiveLine(path: string, line: number, offset: number, length: number, fingerprint?: SourceFingerprint): Promise<string | { reason: string }> {
  if (fingerprint) {
    let source: VerifiedSource | undefined;
    try {
      source = await VerifiedSource.open(path, fingerprint);
      return (await source.read(offset, length)).toString('utf8');
    } catch (e) { return { reason: (e as Error).message }; }
    finally { await source?.close(); }
  }
  let buf: Buffer;
  let before = 0;
  let after = 0;
  try {
    const { size } = await stat(path);
    if (size < offset + length) return { reason: 'source file is shorter than when it was indexed' };
    before = line > 0 && offset > 0 ? 1 : 0;
    after = line > 0 && size > offset + length ? 1 : 0;
    buf = await readRange(path, offset - before, length + before + after);
  } catch {
    return { reason: 'source file no longer exists' };
  }
  if (buf.length !== length + before + after || (before && buf[0] !== 10) || (after && buf[buf.length - 1] !== 10)) {
    return { reason: 'source file changed since it was indexed' };
  }
  return buf.subarray(before, before + length).toString('utf8');
}

/**
 * Folders whose files the index references (SPEC §6 `/api/file`): a Claude transcript's own session folder
 * (`<project>/<sid>/`: subagents, tool-results, workflows) and its file-history folder, a desktop registry's
 * `local_<id>/` folder, a Cowork audit log's folder, and the folder of every other kind of source file.
 * Agent configuration and account files next to registries are never in these folders.
 */
export function servedDirs(path: string, kind: string): string[] {
  const dir = dirname(path);
  const name = basename(path);
  switch (kind) {
    case 'state-db':
      return [];
    case 'transcript': {
      const sid = name.replace(/\.jsonl$/, '');
      const out = [join(dir, sid)];
      const m = /^(.*)\/\.claude\/projects\/[^/]+$/.exec(dir);
      if (m) out.push(join(m[1], '.claude', 'file-history', sid));
      return out;
    }
    case 'subagent-transcript':
    case 'workflow-transcript': {
      const i = path.lastIndexOf(`${sep}subagents${sep}`);
      return [i > 0 ? path.slice(0, i) : dir];
    }
    case 'registry':
      return [join(dir, name.replace(/\.json$/, ''))];
    default:
      return [dir];
  }
}

/** Scalar leaves of a JSON value as [JSON Pointer, path segments, value]. */
function leaves(value: unknown, pointer: string, path: (string | number)[], out: [string, (string | number)[], FieldRef['value']][], max: number): void {
  if (out.length >= max) return;
  if (value === null || typeof value !== 'object') {
    if (value === undefined) return;
    out.push([pointer, path, value as FieldRef['value']]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${pointer}/${i}`, [...path, i], out, max));
    return;
  }
  for (const [k, v] of Object.entries(value)) leaves(v, `${pointer}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`, [...path, k], out, max);
}

const FIELD_SEGMENT_RE = /^[A-Za-z_$][\w$-]*$/;

/** `['tool', 'input', 'files', 0]` → `tool.input.files[0]`; undefined when a key cannot be written in a filter. */
function fieldPath(path: (string | number)[]): string | undefined {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      if (!out) return undefined;
      out += `[${seg}]`;
    } else {
      if (!FIELD_SEGMENT_RE.test(seg)) return undefined;
      out += out ? `.${seg}` : seg;
    }
  }
  return out || undefined;
}

// ---------------------------------------------------------------------------

/** The read API plus resolveView, which lets derived queries on the same connection read a view's rows. */
export type Queries = IndexQueries & { resolveView(viewId: string | undefined): ViewRef | null };

export function createQueries(db: DatabaseSync, ctx: QueryContext): Queries {
  const all = (sql: string, ...params: Param[]): Row[] => db.prepare(sql).all(...params) as Row[];
  const get = (sql: string, ...params: Param[]): Row | undefined => db.prepare(sql).get(...params) as Row | undefined;
  const version = packageVersion();
  // View ids carry a per-process prefix so a client holding an id from an earlier server run gets "unknown view".
  const instance = ctx.instance ?? randomBytes(3).toString('hex');

  /**
   * Bumped whenever an index run changes sessions (noteChanges). Global statistics and the info counts are cached
   * per version; statistics of a view never change, because a view's rows are fixed when it is built.
   */
  let dataVersion = 0;
  const memo = new Map<string, unknown>();
  function cached<T>(key: string, compute: () => T): T {
    if (memo.has(key)) {
      const v = memo.get(key) as T;
      memo.delete(key);
      memo.set(key, v);
      return v;
    }
    const value = compute();
    if (memo.size >= 128) memo.delete(memo.keys().next().value!);
    memo.set(key, value);
    return value;
  }
  const versioned = (key: string) => `${key}@${dataVersion}`;

  /** Whether a session's events come from more than one source file (the linker records its sources). */
  function multiSource(sessionId: string): boolean {
    return cached(versioned(`multi:${sessionId}`), () => {
      const r = get('SELECT sources FROM sessions WHERE id = ?', sessionId);
      const list = parseJson<string[] | null>(r?.sources, null);
      if (list) return list.length > 1;
      return !!get(`SELECT 1 FROM events WHERE session_id = ?1
        AND src_id != (SELECT src_id FROM events WHERE session_id = ?1 LIMIT 1) LIMIT 1`, sessionId);
    });
  }

  // -------------------------------------------------------------------------
  // Views (SPEC §5.4)

  const views = new Map<string, View>(); // spec key → view, least recently used first
  let viewCounter = 0;

  function touch(key: string, v: View): View {
    views.delete(key);
    views.set(key, v);
    return v;
  }

  function dropView(key: string, v: View): void {
    views.delete(key);
    db.exec(`DROP TABLE IF EXISTS temp.${v.table}`);
    for (const k of [...memo.keys()]) if (k.endsWith(`:${v.id}`)) memo.delete(k);
  }

  function findView(viewId: string): View | undefined {
    for (const [key, v] of views) if (v.id === viewId) return touch(key, v);
    return undefined;
  }

  function getView(viewId: string): View {
    const v = findView(viewId);
    if (!v) throw new QueryError(`Unknown view ${viewId}; create it again`, 404, 'view-not-found');
    return v;
  }

  /** An index on rid: built on first need, so building a large view stays one ordered insert (0.35 s vs 0.7 s for 1.6M rows). */
  function ensureRidIndex(v: View): void {
    if (v.ridIndexed) return;
    db.exec(`CREATE INDEX temp.${v.table}_rid ON ${v.table}(rid)`);
    v.ridIndexed = true;
  }

  /** Sessions with at least one row in the view, as a JSON array parameter. */
  function rowSessions(v: View): string {
    v.rowSessions ??= all(`SELECT DISTINCT e.session_id AS id FROM temp.${v.table} v CROSS JOIN events e ON e.rid = v.rid`).map((r) => r.id as string);
    return JSON.stringify(v.rowSessions);
  }

  /** First row number whose ts is >= `ts` in a view in ascending time order (count + 1 when there is none). */
  function firstRowAtOrAfter(v: View, ts: number): number {
    const probe = db.prepare(`SELECT ts FROM temp.${v.table} WHERE no = ?`);
    let lo = 1;
    let hi = v.info.count + 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((probe.get(mid) as Row).ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The events a statistic covers. No id, or GLOBAL_VIEW, means every event that is not a hidden copy; an id that
   * names no live view is an error, never a silent fall-back to global numbers (SPEC §7.8).
   */
  function statScope(viewId?: string): Scope {
    const hidden = `(e.flag_bits & ${HIDDEN}) = 0`;
    if (viewId === undefined || viewId === GLOBAL_VIEW) {
      return { from: 'events e', where: hidden, view: null, label: { kind: 'all', viewId: null, events: globalEvents() } };
    }
    const view = findView(viewId);
    if (!view) throw new QueryError(`View ${viewId} expired or never existed; create the view again`, 404, 'view_expired', { viewId });
    const label: StatsScope = { kind: 'view', viewId, events: view.info.count };
    // The default view (no filter, no scope) holds every event that is not a hidden copy, so its statistics
    // use the global queries, which read covering indexes and session aggregates instead of joining every row.
    if (view.everything) return { from: 'events e', where: hidden, view: null, label };
    return {
      // CROSS JOIN keeps the view as the outer loop: one lookup in the narrow events table per view row.
      from: `temp.${view.table} v CROSS JOIN events e ON e.rid = v.rid`,
      where: '1',
      view,
      label,
    };
  }

  /**
   * Rows, time column and per-bin aggregate of an I/O graph metric. The derived metrics (SPEC §12.7) read steps and
   * failure rows: a view holds a step or a failure row when it holds one of its events. Null when the index has no
   * derived tables (schema 3, read while the new index builds).
   */
  function ioSource(sc: Scope, metric: IoMetric): { ts: string; source: string; agg: string; level: boolean } | null {
    const v = sc.view ? `temp.${sc.view.table}` : null;
    const tier = FAILURE_TIERS.find((t) => metric === `failures.${t}`);
    if (tier || metric === 'context.tokens') {
      if ((indexSchemaVersion(db) ?? 0) < 4) return null;
      if (tier) {
        const from = v ? `${v} v CROSS JOIN failures f ON f.rid = v.rid` : 'failures f';
        return { ts: 'f.ts', source: `${from} WHERE f.tier = '${tier}' AND f.ts > 0`, agg: 'count(*)', level: false };
      }
      const inView = v ? ` AND st.id IN (SELECT se.step_id FROM ${v} v JOIN step_events se ON se.rid = v.rid)` : '';
      return { ts: 'st.start_ts', source: `steps st WHERE st.ctx_tokens IS NOT NULL AND st.start_ts > 0${inView}`, agg: 'max(st.ctx_tokens)', level: true };
    }
    const span: Partial<Record<IoMetric, string>> = {
      'llm.calls': 'count(*)',
      'tokens.input': `sum(json_extract(sp.attrs, '$.tokens.input'))`,
      'tokens.output': `sum(json_extract(sp.attrs, '$.tokens.output'))`,
      'latency.mean': 'avg(sp.dur)',
      'ttft.mean': `avg(${CALL_TTFT})`,
      'output.rate.mean': `avg(${CALL_OUTPUT_RATE})`,
    };
    if (span[metric]) {
      return { ts: 'sp.start_ts', source: `spans sp WHERE sp.kind = 'llm' AND ${spanInScope(sc)} AND sp.start_ts > 0`, agg: span[metric], level: metric.endsWith('.mean') };
    }
    const event: Partial<Record<IoMetric, string>> = { events: 'count(*)', errors: `sum((e.flag_bits & ${ERR}) != 0)`, 'tool.calls': `sum(e.kind = 'tool.call')` };
    if (!event[metric]) throw new QueryError(`Unknown metric ${metric}`, 400, 'bad-metric');
    return { ts: 'e.ts', source: `${sc.view ? sc.from : 'events e INDEXED BY ev_ts'} WHERE ${sc.where} AND e.ts > 0`, agg: event[metric], level: false };
  }

  /**
   * The Diagnostics groups of the analysis (DerivedExpertGroup, severity warn): `loop` lists looping episodes and
   * `silent-child` the delegations whose failure the parent was not told about. Each item is the episode's opening
   * failure or the result the parent saw, and follows that event into a view. Ids are negative: no expert row has one.
   */
  function derivedExpertGroups(q: ExpertQuery, sc: Scope): ExpertResult['groups'] {
    const where: string[] = [];
    const params: Param[] = [];
    if (q.session) {
      where.push('x.session_id = ?');
      params.push(q.session);
    }
    if (sc.view) {
      ensureRidIndex(sc.view);
      where.push(`EXISTS (SELECT 1 FROM temp.${sc.view.table} v WHERE v.rid = e.rid)`);
    }
    const cond = where.length ? ` AND ${where.join(' AND ')}` : '';
    const limit = clampInt(q.limit, 200, 1, 10_000);
    let next = -1;
    const group = (name: DerivedExpertGroup, sql: string, message: (r: Row) => string): ExpertResult['groups'][number] => {
      const rows = all(`SELECT *, count(*) OVER () AS total FROM (${sql}) ORDER BY ts LIMIT ?`, ...params, limit);
      return {
        severity: 'warn', group: name, count: rows[0]?.total ?? 0,
        items: rows.map((r) => ({ id: next--, session: r.session_id, event: r.event_id, span: r.span_id, message: message(r), ts: r.ts, episodeId: r.episode_id })),
      };
    };
    return [
      group('loop', `SELECT x.session_id, e.id AS event_id, e.span_id, x.start_ts AS ts, x.id AS episode_id, x.n_attempts, s.text AS sig
          FROM episodes x JOIN events e ON e.rid = x.opener_rid LEFT JOIN signatures s ON s.id = x.sig_id WHERE x.loop = 1${cond}`,
        (r) => `${r.n_attempts} attempts of one signature${r.sig ? `: ${r.sig}` : ''}`),
      group('silent-child', `SELECT x.session_id, e.id AS event_id, x.id AS span_id, x.start_ts AS ts, x.outcome,
            (SELECT c.id FROM episodes c WHERE c.session_id = x.child_session AND c.section IN ('blocked', 'unrecovered') ORDER BY c.start_ts LIMIT 1) AS episode_id
          FROM delegations x JOIN events e ON e.rid = x.result_rid WHERE x.silent = 1${cond}`,
        (r) => `Subagent ${r.outcome}; the result the parent saw did not say so`),
    ];
  }

  function globalEvents(): number {
    return cached(versioned('global-events'), () => (get('SELECT coalesce(sum(n_events), 0) AS n FROM sessions')!.n as number));
  }

  /** Memo key of a statistic: per view (its rows never change), or per data version for global numbers. */
  /**
   * `session_stats` rows (derive/calls.ts) of the whole index or of a view of whole sessions, which sum to what a scan of
   * their events or llm spans gives; null for another view, or while the analysis is outdated or pending.
   */
  function storedStats(sc: Scope, kind: 'event' | 'model'): Row[] | null {
    if (sc.view && !sc.view.sessionsOnly) return null;
    const ready = cached(versioned('session-stats'), () =>
      !!get("SELECT 1 FROM sqlite_master WHERE name = 'session_stats'") && !analysisOutdated(db) && !!get("SELECT 1 FROM session_stats WHERE kind = 'event' LIMIT 1"));
    if (!ready) return null;
    const among = sc.view ? ' AND session_id IN (SELECT value FROM json_each(?))' : '';
    return all(`SELECT key, n, bytes, durs, tokens FROM session_stats WHERE kind = ?${among}`, kind, ...(sc.view ? [JSON.stringify([...sc.view.sessions!])] : []));
  }

  function statKey(name: string, sc: Scope): string {
    return sc.view ? `${name}:${sc.view.id}` : versioned(`${name}:global`);
  }

  /**
   * SQL condition: llm span `sp` belongs to the scope when a scope event lies in it or closes it. The second case
   * covers model responses made only of tool calls, whose events sit in tool spans.
   */
  function spanInScope(sc: Scope): string {
    // Globally: every span that is not copied context, as in the linker's session totals.
    if (!sc.view) return 'sp.inherited = 0';
    const v = sc.view;
    ensureRidIndex(v);
    const sessions = rowSessions(v).replaceAll("'", "''");
    // A view with fewer rows than its sessions have model responses is walked: the spans its events lie in, and the
    // llm spans they close (sp_llm_last).
    const llm = cached(`llm:${v.id}`, () => Number(get(`SELECT coalesce(sum(n_llm), 0) AS n FROM sessions WHERE id IN (SELECT value FROM json_each(?))`, rowSessions(v))!.n));
    if (2 * v.info.count < llm && cached('has:sp_llm_last', () => !!get("SELECT 1 FROM sqlite_master WHERE name = 'sp_llm_last'"))) {
      return `sp.id IN (SELECT e.span_id FROM temp.${v.table} v1 CROSS JOIN events e ON e.rid = v1.rid WHERE e.span_id IS NOT NULL
        UNION ALL SELECT s2.id FROM temp.${v.table} v2 CROSS JOIN events e ON e.rid = v2.rid JOIN spans s2 INDEXED BY sp_llm_last ON s2.last_event = e.id AND s2.kind = 'llm')`;
    }
    // Otherwise the candidates are the spans of the view's sessions (sp_session); each is checked with two index probes
    // into the events' span and id indexes and the view's rid index, instead of re-walking every view row.
    return `sp.session_id IN (SELECT value FROM json_each('${sessions}'))
      AND (EXISTS (SELECT 1 FROM events e2 INDEXED BY ev_span JOIN temp.${v.table} v2 ON v2.rid = e2.rid WHERE e2.span_id = sp.id)
        OR EXISTS (SELECT 1 FROM events e3 JOIN temp.${v.table} v3 ON v3.rid = e3.rid WHERE e3.id = sp.last_event))`;
  }

  /**
   * Tool calls in scope, one row per tool span (a call and its result), with the span's duration and status.
   * A view covers the calls it holds an event of, call or result: a view filtered on `error` holds failed results
   * only, and its tool statistics list those calls instead of none.
   */
  function toolCalls(sc: Scope): Row[] {
    const inScope = sc.view
      ? `sp.id IN (SELECT e.span_id FROM ${sc.from} WHERE ${sc.where} AND e.kind IN ('tool.call', 'tool.result') AND e.span_id IS NOT NULL)`
      : 'sp.inherited = 0';
    return all(`SELECT coalesce(sp.name, '(unknown)') AS tool, sp.dur, coalesce(s.agent, 'unknown') AS agent, sp.status = 'error' AS err
      FROM spans sp LEFT JOIN sessions s ON s.id = sp.session_id WHERE sp.kind = 'tool' AND ${inScope}`);
  }

  function compileRules(rules: ViewSpec['colorRules']): CompiledRule[] {
    if (!rules?.length) return [];
    if (rules.length > MAX_COLOR_RULES) throw new QueryError(`At most ${MAX_COLOR_RULES} coloring rules`, 400, 'bad-param');
    return rules.map((r) => {
      try {
        const f = compileFilter(r.filter);
        return { id: r.id, sql: f.sql, params: f.params, payload: f.joins.payload };
      } catch (err) {
        if (err instanceof FilterError) {
          throw new QueryError(`Coloring rule ${r.id}: ${err.message}`, 400, 'color_rule', { ruleId: r.id, start: err.start, end: err.end });
        }
        throw err;
      }
    });
  }

  /** SQL expressions for custom columns; unknown fields are a 400. */
  function columnExprs(columns: string[]): { name: string; sql: string; def: FieldDef }[] {
    if (columns.length > MAX_COLUMNS) throw new QueryError(`At most ${MAX_COLUMNS} columns`, 400, 'bad-param');
    return columns.map((name) => {
      const r = resolveName(name, false);
      if ('error' in r) throw new QueryError(`Column ${name}: ${r.error}`, 400, 'bad-param', { column: name });
      const def = r.def;
      let sql = def.type === 'json' ? `json_quote(${def.sql})` : def.predicate ? `(${def.sql})` : def.sql;
      if (def.join === 'session') sql = `(SELECT ${sql} FROM sessions s WHERE s.id = e.session_id)`;
      else if (def.join === 'span') sql = `(SELECT ${sql} FROM spans sp WHERE sp.id = e.span_id)`;
      return { name, sql, def };
    });
  }

  function columnValue(def: FieldDef, v: unknown): unknown {
    if (v == null) return null;
    if (def.type === 'json' && typeof v === 'string') return parseJson(v, v);
    if (def.type === 'bool' || def.predicate) return v === 1 || v === true;
    return v;
  }

  let health: { key: string; at: number; report: Promise<HealthReport[]> } | null = null;

  // -------------------------------------------------------------------------
  // Side files

  async function allowedDirs(): Promise<string[]> {
    const dirs = new Set(all('SELECT path, kind FROM sources').flatMap((r) => servedDirs(r.path, r.kind)));
    const real = await Promise.all([...dirs].map((d) => realpath(d).catch(() => null)));
    return real.filter((d): d is string => d !== null);
  }

  function blobFile(where: string, value: string): FileResult | null {
    const r = get(`SELECT data, media_type, encoding, origin_path FROM blobs WHERE ${where} LIMIT 1`, value);
    if (!r || r.data == null) return null;
    const data = typeof r.data === 'string' ? Buffer.from(r.data, r.encoding === 'base64' ? 'base64' : 'utf8') : Buffer.from(r.data);
    const declared = r.media_type && !/html|svg|xml|script/i.test(r.media_type) ? r.media_type : null;
    return { contentType: declared ?? contentTypeFor(r.origin_path ?? '', data), data };
  }

  // -------------------------------------------------------------------------
  // Capture metadata (meta table, written by the capture reader)

  function captureInfo(): CaptureInfo | undefined {
    if (ctx.mode !== 'capture') return undefined;
    return cached('capture-info', () => {
      const meta = new Map(all(`SELECT key, value FROM meta WHERE key LIKE 'capture_%'`).map((r) => [r.key as string, r.value as string]));
      const header = parseJson<Record<string, unknown> | null>(meta.get('capture_header'), null);
      const coverage = parseJson<CaptureInfo['coverage'] | null>(meta.get('capture_coverage'), null);
      const options = (header?.options ?? {}) as { raw?: boolean };
      return {
        path: ctx.capturePath ?? '',
        header,
        createdAt: typeof header?.created === 'number' ? header.created : null,
        complete: meta.get('capture_complete') === '1',
        coverage: coverage ?? {
          rawUnavailable: 0, rawUnavailableBySource: {}, rawOmitted: options.raw === false, sidecarsOmitted: [], known: false,
        },
        loadedAt: meta.has('capture_loaded_at') ? Number(meta.get('capture_loaded_at')) : null,
        ...(meta.has('capture_integrity') ? { integrity: parseJson<CaptureInfo['integrity']>(meta.get('capture_integrity'), undefined) } : {}),
        ...(meta.has('capture_analysis') ? { analysis: parseJson<CaptureInfo['analysis']>(meta.get('capture_analysis'), undefined) } : {}),
      };
    });
  }

  // -------------------------------------------------------------------------

  return {
    resolveView(viewId) {
      if (viewId === undefined || viewId === GLOBAL_VIEW) return null;
      const v = findView(viewId);
      if (!v) throw new QueryError(`View ${viewId} expired or never existed; create the view again`, 404, 'view_expired', { viewId });
      if (v.everything) return { table: null, events: v.info.count };
      // Derived queries test membership with `rid IN (SELECT rid FROM temp.<table>)`, which needs the rid index.
      ensureRidIndex(v);
      return { table: `temp.${v.table}`, events: v.info.count, ...(v.sessionsOnly && v.sessions ? { sessions: [...v.sessions] } : {}) };
    },

    info() {
      const counts = cached(versioned('counts'), () => {
        const n = (table: string) => get(`SELECT count(*) AS n FROM ${table}`)!.n as number;
        return { sources: n('sources'), sessions: n('sessions'), events: n('events'), spans: n('spans'), expert: n('expert') };
      });
      const range = cached(versioned('range'), () => get('SELECT (SELECT min(ts) FROM events WHERE ts > 0) AS lo, (SELECT max(ts) FROM events) AS hi')!);
      const live = ctx.getLive?.() ?? { watch: { enabled: false, intervalMs: null }, lastIndexOkAt: null, lastIndexError: null, lastChangeAt: null };
      const capture = captureInfo();
      return {
        version, mode: ctx.mode, indexPath: ctx.indexPath, ...(ctx.capturePath ? { capturePath: ctx.capturePath } : {}),
        counts, firstTs: range.lo, lastTs: range.hi, indexing: ctx.getIndexing(),
        watch: live.watch, lastIndexOkAt: live.lastIndexOkAt, lastIndexError: live.lastIndexError, lastChangeAt: live.lastChangeAt,
        ...(capture ? { capture } : {}),
      };
    },

    fields: listFields,

    validateFilter(filter) {
      try {
        const f = compileFilter(filter);
        // Preparing the statement also catches SQL the compiler produced but SQLite rejects.
        db.prepare(`SELECT 1 FROM events e ${PAYLOAD_JOIN} WHERE ${f.sql} LIMIT 0`);
        return f.warnings.length ? { ok: true, warning: f.warnings.join('; ') } : { ok: true };
      } catch (err) {
        if (err instanceof FilterError) return { ok: false, error: { message: err.message, start: err.start, end: err.end } };
        return { ok: false, error: { message: (err as Error).message, start: 0, end: filter.length } };
      }
    },

    listSessions(q) {
      const where: string[] = [];
      const params: Param[] = [];
      if (q.ids?.length) {
        where.push('id IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify(q.ids));
      }
      for (const col of ['agent', 'role', 'state'] as const) {
        if (q[col]) {
          where.push(`${col} = ?`);
          params.push(q[col]!);
        }
      }
      if (q.from != null) {
        where.push('coalesce(end_ts, start_ts, created_ts) >= ?');
        params.push(q.from);
      }
      if (q.to != null) {
        where.push('coalesce(start_ts, created_ts) <= ?');
        params.push(q.to);
      }
      if (q.q) {
        where.push(`instr(lower(id || ' ' || coalesce(title, '') || ' ' || coalesce(cwd, '') || ' ' || coalesce(project, '')), lower(?)) > 0`);
        params.push(q.q);
      }
      const cond = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const total = get(`SELECT count(*) AS n FROM sessions${cond}`, ...params)!.n;
      const rows = all(`SELECT * FROM sessions${cond} ORDER BY coalesce(start_ts, created_ts) DESC, id LIMIT ? OFFSET ?`,
        ...params, clampInt(q.limit, 5000, 1, 50_000), clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER));
      return { total, sessions: rows.map(sessionRow) };
    },

    getSession(id) {
      const r = get('SELECT * FROM sessions WHERE id = ?', id);
      if (!r) return null;
      const linked = parseJson<string[] | null>(r.sources, null);
      const srcIds = linked
        ? all(`SELECT value AS id FROM json_each(?) UNION SELECT src_id FROM sessions WHERE id = ? UNION SELECT src_id FROM enrich WHERE session_id = ?`,
          JSON.stringify(linked), id, id)
        : all(`SELECT src_id AS id FROM events WHERE session_id = ? UNION SELECT src_id FROM sessions WHERE id = ?
            UNION SELECT src_id FROM enrich WHERE session_id = ?`, id, id, id);
      return {
        session: { ...sessionRow(r), meta: parseJson(r.meta, {}), enriched: parseJson(r.meta_enriched, {}) },
        children: all('SELECT * FROM sessions WHERE parent_id = ? ORDER BY coalesce(start_ts, created_ts), id', id).map(sessionRow),
        turns: all(`SELECT * FROM spans WHERE session_id = ? AND kind = 'turn' ORDER BY start_ts`, id).map(spanRow),
        sources: all(`SELECT id, path, kind FROM sources WHERE id IN (SELECT value FROM json_each(?)) ORDER BY path`,
          JSON.stringify(srcIds.map((s) => s.id).filter(Boolean))).map((s) => ({ id: s.id, path: s.path, kind: s.kind })),
      };
    },

    createView(spec) {
      const order = spec.order === 'desc' ? 'desc' : 'asc';
      // File order is the natural order of one session, unless the session spans several files whose
      // sequence numbers do not interleave (Cowork transcript + audit log, Codex continuation pages).
      const sort: ViewSort = spec.sort ??
        (spec.sessions?.length === 1 && spec.descendants === false && !multiSource(spec.sessions[0]) ? 'seq' : 'ts');
      if (!(sort in SORT_COLUMN)) throw new QueryError(`Unknown sort ${sort}`, 400, 'bad-param');
      // Over the whole index, attrs and native predicates read the payload table in one sequential pass (semi-joins);
      // over chosen sessions, the payload of their few rows is joined per row.
      const f = compileFilter(spec.filter ?? '', { payload: spec.sessions?.length ? 'join' : 'semi' });
      const rules = compileRules(spec.colorRules);
      // A relative time (ts > -2h) is anchored when the view is built, so such a view is reused for a minute at most.
      const now = f.usesNow ? Math.floor(Date.now() / 60_000) : null;
      const key = JSON.stringify([
        spec.filter?.trim() ?? '', [...(spec.sessions ?? [])].sort(), spec.descendants !== false, spec.from ?? null,
        spec.to ?? null, sort, order, !!spec.includeInherited, !!spec.includeDup, rules.map((r) => [r.id, r.sql, r.params]), now,
      ]);
      const hit = views.get(key);
      if (hit && !hit.stale) return touch(key, hit).info;
      if (hit) {
        // A stale view stays readable under its id (clients page through it until they rebuild) until it is evicted or
        // rebuilt again. Only the newest stale copy can still be in use, and each copy keeps its rows in memory: while
        // agents work, the view of every event (millions of rows) is rebuilt every few seconds.
        for (const [k, old] of views) if (k.startsWith(`${key}~`)) dropView(k, old);
        views.delete(key);
        views.set(`${key}~${hit.id}`, hit);
      }

      const where = [`(${f.sql})`];
      const params: Param[] = [...f.params];
      let sessions: Set<string> | null = null;
      if (spec.sessions?.length) {
        const ids = all(spec.descendants === false ? 'SELECT value AS id FROM json_each(?)' : WITH_DESCENDANTS, JSON.stringify(spec.sessions));
        sessions = new Set(ids.map((r) => r.id as string));
        where.push('e.session_id IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify([...sessions]));
      }
      if (spec.from != null) {
        where.push('e.ts >= ?');
        params.push(spec.from);
      }
      if (spec.to != null) {
        where.push('e.ts <= ?');
        params.push(spec.to);
      }
      const hidden = (spec.includeInherited ? 0 : FLAG_BITS.inherited) | (spec.includeDup ? 0 : FLAG_BITS.dup);
      if (hidden) where.push(`(e.flag_bits & ${hidden}) = 0`);
      const joins = f.joins.payload ? ` ${PAYLOAD_JOIN}` : '';
      // Index choice. A time-ordered view whose filter reads only ev_ts columns scans that covering index in display
      // order; the planner would otherwise pick a kind or flag index and then read millions of table rows. A view over
      // sessions reads their rows (ev_session_seq), and a filter on a span field reads the selected spans' events
      // (ev_span): the planner's estimate for a json_each list or a semi-join is too coarse to find either on its own.
      const columns = [...f.sql.matchAll(/\be\.(\w+)/g)].map((m) => m[1]);
      const covered = sort === 'ts' && !sessions && !joins && !f.fts && columns.every((c) => EV_TS_COLUMNS.has(c));
      const hint = covered ? ' INDEXED BY ev_ts' : sessions ? ' INDEXED BY ev_session_seq' : f.spanDriven ? ' INDEXED BY ev_span' : '';
      const dir = order === 'desc' ? 'DESC' : 'ASC';
      const primary = SORT_COLUMN[sort];
      const orderBy = sort === 'seq'
        ? `e.session_id ${dir}, e.seq ${dir}`
        : `${primary ? `${primary} ${dir} NULLS LAST, ` : ''}e.ts ${dir}, e.session_id ${dir}, e.seq ${dir}`;

      const n = ++viewCounter;
      const table = `view_${n}`;
      // Beyond (no, rid), each row caches the event's time, error bit and tokens, so the histogram and the
      // time range of the view never touch the events table.
      db.exec(`CREATE TEMP TABLE ${table} (no INTEGER PRIMARY KEY, rid INTEGER, ts INTEGER, err INTEGER, tok INTEGER)`);
      let count: number;
      try {
        // Rows are inserted in ORDER BY order, so `no` is the 1-based display row number.
        count = Number(db.prepare(`INSERT INTO temp.${table} (rid, ts, err, tok)
          SELECT e.rid, e.ts, (e.flag_bits & ${ERR}) != 0, coalesce(e.tok_in, 0) + coalesce(e.tok_out, 0)
          FROM events e${hint}${joins}
          WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`).run(...params).changes);
      } catch (err) {
        db.exec(`DROP TABLE temp.${table}`);
        throw err;
      }
      const range = sort === 'ts' && order === 'asc'
        ? get(`SELECT (SELECT ts FROM temp.${table} WHERE no = 1) AS lo, (SELECT ts FROM temp.${table} WHERE no = ?) AS hi`, count)!
        : get(`SELECT min(ts) AS lo, max(ts) AS hi FROM temp.${table}`)!;
      const unfiltered = !spec.filter?.trim() && spec.from == null && spec.to == null && !spec.includeInherited && !spec.includeDup;
      const everything = unfiltered && !spec.sessions?.length;
      const id = `${instance}-${n}`;
      const view: View = {
        id, table, sort, order, everything, sessionsOnly: unfiltered && !!sessions, sessions, stale: false, rules, ridIndexed: false,
        range: { from: spec.from ?? null, to: spec.to ?? null },
        info: { viewId: id, count, firstTs: range.lo, lastTs: range.hi },
      };
      views.set(key, view);
      let rows = 0;
      for (const v of views.values()) rows += v.info.count;
      for (const [oldKey, old] of views) {
        if (old === view || (views.size <= MAX_VIEWS && rows <= VIEW_ROW_BUDGET)) break;
        dropView(oldKey, old);
        rows -= old.info.count;
      }
      return view.info;
    },

    viewRows(viewId, offset, limit, columns = []) {
      const v = getView(viewId);
      const start = clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const extra = columnExprs(columns);
      const params: Param[] = [];
      let select = `v.no, ${EVENT_COLS}`;
      if (v.rules.length) {
        select += `, CASE ${v.rules.map((r) => `WHEN (${r.sql}) THEN ?`).join(' ')} END AS color_rule`;
        for (const r of v.rules) params.push(...r.params, r.id);
      }
      extra.forEach((c, i) => (select += `, ${c.sql} AS x${i}`));
      const payload = v.rules.some((r) => r.payload) || extra.some((c) => /\bp\.(attrs|native)\b/.test(c.sql));
      const rows = all(`SELECT ${select} FROM temp.${v.table} v JOIN events e ON e.rid = v.rid${payload ? ` ${PAYLOAD_JOIN}` : ''}
        WHERE v.no > ? AND v.no <= ? ORDER BY v.no`, ...params, start, start + clampInt(limit, 200, 0, MAX_PAGE));
      return rows.map((r) => {
        const row = eventRow(r);
        if (v.rules.length) row.colorRule = r.color_rule ?? null;
        if (extra.length) row.extra = Object.fromEntries(extra.map((c, i) => [c.name, columnValue(c.def, r[`x${i}`])]));
        return row;
      });
    },

    locate(viewId, eventId) {
      const v = getView(viewId);
      ensureRidIndex(v);
      const r = get(`SELECT no FROM temp.${v.table} WHERE rid = (SELECT rid FROM events WHERE id = ?)`, eventId);
      return r ? r.no : null;
    },

    find(viewId, text, from, dir) {
      const v = getView(viewId);
      const q = text.trim();
      if (!q || q.length > 500) throw new QueryError('Find needs 1 to 500 characters of text', 400, 'bad-param');
      // The text as one FTS5 phrase whose last word may be a prefix, so a match appears while the user types.
      const match = `"${q.replaceAll('"', '""')}" *`;
      const next = dir !== 'prev';
      const at = from ?? (next ? 0 : v.info.count + 1);
      ensureRidIndex(v);
      const r = get(`SELECT ${next ? 'min' : 'max'}(v.no) AS no FROM events_fts f JOIN temp.${v.table} v ON v.rid = f.rowid
        WHERE events_fts MATCH ? AND v.no ${next ? '>' : '<'} ?`, match, at);
      return r?.no ?? null;
    },

    histogram(viewId, bins, from, to) {
      const v = getView(viewId);
      const lo = from ?? v.info.firstTs;
      const hi = to ?? v.info.lastTs;
      if (lo == null || hi == null || hi < lo) return { from: lo ?? 0, to: hi ?? 0, binUs: 1, bins: [] };
      const nBins = clampInt(bins, 100, 1, 10_000);
      const binUs = Math.max(1, Math.ceil((hi - lo + 1) / nBins));
      const out: Histogram['bins'] = Array.from({ length: nBins }, () => ({ count: 0, errors: 0, tokens: 0 }));
      // In a view in ascending time order the time range is one contiguous run of row numbers.
      const ordered = v.sort === 'ts' && v.order === 'asc';
      const [first, last] = ordered ? [firstRowAtOrAfter(v, lo), firstRowAtOrAfter(v, hi + 1) - 1] : [1, v.info.count];
      const rows = all(`SELECT CAST((ts - ?) / ? AS INTEGER) AS b, count(*) AS n, sum(err) AS err, sum(tok) AS tok
        FROM temp.${v.table} WHERE no BETWEEN ? AND ? AND ts BETWEEN ? AND ? GROUP BY b`, lo, binUs, first, last, lo, hi);
      for (const r of rows) out[r.b] = { count: r.n, errors: r.err, tokens: r.tok };
      return { from: lo, to: hi, binUs, bins: out };
    },

    getEvent(id) {
      const r = get(`SELECT ${EVENT_COLS}, p.attrs, p.native, e.src_id, e.src_line, e.src_off, e.src_len, e.src_block,
          src.path AS src_path
        FROM events e ${PAYLOAD_JOIN} LEFT JOIN sources src ON src.id = e.src_id WHERE e.id = ?`, id);
      if (!r) return null;
      const spanRec = r.span_id ? get('SELECT * FROM spans WHERE id = ?', r.span_id) : undefined;
      const span = spanRec ? spanRow(spanRec) : null;
      const spanChain = span
        ? all(`WITH RECURSIVE chain(id, n) AS (SELECT ?, 0
              UNION ALL SELECT sp.parent_id, chain.n + 1 FROM spans sp JOIN chain ON sp.id = chain.id
              WHERE sp.parent_id IS NOT NULL AND chain.n < 64)
            SELECT sp.* FROM chain JOIN spans sp ON sp.id = chain.id WHERE chain.n > 0 ORDER BY chain.n DESC`, span.id).map(spanRow)
        : [];
      let related: EventRow[] = [];
      if (span && !CONTAINER_SPANS.has(span.kind)) {
        // Same span (call ↔ result, blocks of one response), nested exec items, and for an exec item its tool call.
        const params: Param[] = [id, span.id, span.id];
        let parentCond = '';
        if (span.kind === 'exec' && span.parent) {
          parentCond = ' OR e.span_id = ?';
          params.push(span.parent);
        }
        related = all(`SELECT ${EVENT_COLS} FROM events e WHERE e.id != ? AND (e.span_id = ?
            OR e.span_id IN (SELECT id FROM spans WHERE parent_id = ? AND kind = 'exec')${parentCond})
          ORDER BY e.session_id, e.seq LIMIT ${RELATED_LIMIT}`, ...params).map(eventRow);
      }
      const session = get('SELECT * FROM sessions WHERE id = ?', r.session_id);
      const row = eventRow(r);
      const attrs = parseJson<Record<string, unknown>>(r.attrs, {});
      const native = parseJson<unknown>(r.native, null);
      return {
        event: {
          ...row, attrs, native,
          raw: { source: r.src_id, path: r.src_path, line: r.src_line ?? 0, offset: r.src_off ?? 0, length: r.src_len ?? 0, block: r.src_block },
        },
        span, spanChain, related, session: session ? sessionRow(session) : null,
        fieldMap: fieldMapOf(row, attrs, native),
      };
    },

    async getRaw(id, maxString = 2000) {
      const r = get(`SELECT e.src_id, e.src_line, e.src_off, e.src_len, src.path, src.sha256, src.parsed_bytes
        FROM events e LEFT JOIN sources src ON src.id = e.src_id WHERE e.id = ?`, id);
      if (!r) throw new QueryError(`Unknown event ${id}`, 404, 'event-not-found');
      const source = { id: r.src_id, path: r.path, line: r.src_line ?? 0, offset: r.src_off ?? 0, length: r.src_len ?? 0 };
      let loaded: string | { reason: string };
      if (ctx.mode === 'capture') {
        const raw = get('SELECT text FROM raw_store WHERE src_id = ? AND line = ?', source.id, source.line);
        const omitted = captureInfo()?.coverage.rawOmitted;
        loaded = raw
          ? raw.text
          : { reason: omitted ? 'the capture was written without raw lines (--no-raw)' : 'the capture holds no raw bytes for this record' };
      } else {
        loaded = source.path
          ? await readLiveLine(source.path, source.line, source.offset, source.length,
            r.sha256 && r.parsed_bytes != null ? { sha256: r.sha256, bytes: r.parsed_bytes } : undefined)
          : { reason: 'source is not in the index' };
      }
      if (typeof loaded !== 'string') return { available: false, reason: loaded.reason, source, text: '', truncated: false, ranges: {} };
      const short = shortenJson(loaded, clampInt(maxString, 2000, 1, RAW_MAX_STRING));
      return { available: true, source, text: short.text, truncated: short.truncated, ranges: jsonRanges(short.text),
        verification: ctx.mode === 'capture' ? 'captured' : r.sha256 && r.parsed_bytes != null ? 'verified' : 'unverified',
        ...(ctx.mode === 'capture' ? { captureIntegrity: captureInfo()?.integrity?.status ?? 'unverified' } : {}) };
    },

    listSpans(q) {
      const where = ['1'];
      const params: Param[] = [];
      if (q.sessions?.length) {
        where.push(`sp.session_id IN (${WITH_DESCENDANTS})`);
        params.push(JSON.stringify(q.sessions));
      }
      if (q.from != null) {
        where.push('coalesce(sp.end_ts, sp.start_ts) >= ?');
        params.push(q.from);
      }
      if (q.to != null) {
        where.push('sp.start_ts <= ?');
        params.push(q.to);
      }
      if (q.kinds?.length) {
        where.push('sp.kind IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify(q.kinds));
      }
      if (q.minDur != null) {
        where.push('sp.dur >= ?');
        params.push(q.minDur);
      }
      const limit = clampInt(q.limit, DEFAULT_SPAN_LIMIT, 1, 200_000);
      // Level of detail: past the limit, keep the longest spans; they are the ones visible at this zoom.
      const rows = all(`SELECT sp.* FROM spans sp WHERE ${where.join(' AND ')}
        ORDER BY coalesce(sp.dur, sp.end_ts - sp.start_ts, 0) DESC LIMIT ?`, ...params, limit + 1);
      const truncated = rows.length > limit;
      if (truncated) rows.length = limit;
      rows.sort((a, b) => (a.start_ts ?? 0) - (b.start_ts ?? 0) || a.depth - b.depth);
      return { spans: rows.map(spanRow), truncated };
    },

    getSpan(id) {
      const r = get('SELECT * FROM spans WHERE id = ?', id);
      if (!r) return null;
      return {
        span: spanRow(r),
        events: all(`SELECT ${EVENT_COLS} FROM events e WHERE e.span_id = ?
          ORDER BY e.session_id, e.seq LIMIT ${DETAIL_LIMIT}`, id).map(eventRow),
        children: all(`SELECT * FROM spans WHERE parent_id = ? ORDER BY start_ts LIMIT ${DETAIL_LIMIT}`, id).map(spanRow),
      };
    },

    overview(q) {
      const where = ['1'];
      const params: Param[] = [];
      if (q.agent) {
        where.push('agent = ?');
        params.push(q.agent);
      }
      if (q.from != null) {
        where.push('coalesce(end_ts, start_ts, created_ts) >= ?');
        params.push(q.from);
      }
      if (q.to != null) {
        where.push('coalesce(start_ts, created_ts) <= ?');
        params.push(q.to);
      }
      const rows = all(`SELECT id, agent, role, parent_id, title, project, coalesce(start_ts, created_ts) AS start, end_ts,
          n_events, n_errors, tok_out
        FROM sessions WHERE ${where.join(' AND ')} ORDER BY start, id`, ...params);
      return {
        sessions: rows.map((r) => ({
          id: r.id, agent: r.agent, role: r.role, parentId: r.parent_id, title: r.title, project: r.project, start: r.start,
          end: r.end_ts, nEvents: r.n_events, nErrors: r.n_errors, tokOut: r.tok_out ?? 0,
        })),
      };
    },

    conversation(sessionId, after, limit) {
      const n = clampInt(limit, 200, 1, MAX_PAGE);
      const own = `e.session_id = ? AND (e.flag_bits & ${HIDDEN}) = 0 AND +e.kind IN (${CONVERSATION_KINDS})`;
      // One file: page by seq (`after` = last seq), and `+e.kind` keeps SQLite on the (session_id, seq) index.
      // Several files (their seq ranges overlap): order by time and page by row offset (`after` = rows consumed).
      const multi = multiSource(sessionId);
      const offset = multi ? Math.max(0, after ?? 0) : 0;
      const rows = multi
        ? all(`SELECT ${EVENT_COLS}, p.attrs FROM events e ${PAYLOAD_JOIN} WHERE ${own}
            ORDER BY e.ts, e.src_id, e.seq LIMIT ? OFFSET ?`, sessionId, n, offset)
        : all(`SELECT ${EVENT_COLS}, p.attrs FROM events e ${PAYLOAD_JOIN} WHERE ${own} AND e.seq > ?
            ORDER BY e.seq LIMIT ?`, sessionId, after ?? -1, n);

      const spanIds = (kind: string) => JSON.stringify(rows.filter((r) => r.kind === kind && r.span_id).map((r) => r.span_id));
      const callSpans = spanIds('tool.call');
      const results = new Map<string, Row>();
      // Unary + on kind: look events up by span, never by scanning every event of a kind.
      for (const r of all(`SELECT e.id, e.span_id, e.flag_bits, p.attrs FROM events e ${PAYLOAD_JOIN}
          WHERE e.span_id IN (SELECT value FROM json_each(?)) AND +e.kind = 'tool.result' ORDER BY e.seq`, callSpans)) {
        if (!results.has(r.span_id)) results.set(r.span_id, r);
      }
      const spans = new Map(all(`SELECT id, dur, link_session FROM spans WHERE id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(rows.filter((r) => r.span_id).map((r) => r.span_id))).map((r) => [r.id, r]));
      // Exec items nest under the tool call that ran them: their span's parent is that call's tool span.
      const execParents = new Map(all(`SELECT x.id, t.first_event FROM spans x JOIN spans t ON t.id = x.parent_id
          WHERE x.id IN (SELECT value FROM json_each(?)) AND t.kind = 'tool'`, spanIds('tool.exec')).map((r) => [r.id, r.first_event]));
      // Results whose call is in this session are shown on the call's card.
      const pairedResults = new Set(all(`SELECT span_id FROM events WHERE +kind = 'tool.call' AND span_id IN (SELECT value FROM json_each(?))`,
        spanIds('tool.result')).map((r) => r.span_id));
      const linked = rows.map((r) => (parseJson<Attrs>(r.attrs, {}).agent?.link_session ?? spans.get(r.span_id)?.link_session) as string | undefined);
      const children = new Map(all(`SELECT id, title FROM sessions WHERE id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(linked.filter(Boolean))).map((r) => [r.id, r.title]));

      const items: ConversationItem[] = [];
      rows.forEach((r, i) => {
        const a = parseJson<Attrs>(r.attrs, {});
        const base = { event: r.id, ts: r.ts };
        const text = a.text;
        const textLen = a.text_len ?? text?.length;
        const link = linked[i];
        const subagent = link ? { session: link, title: children.get(link) ?? undefined, type: a.agent?.type } : undefined;
        switch (r.kind) {
          case 'user.prompt':
            items.push({ type: 'prompt', ...base, text, textLen });
            break;
          case 'user.inject':
            items.push({ type: 'inject', ...base, text: text ?? r.summary, textLen });
            break;
          case 'llm.text':
            items.push({ type: 'text', ...base, text, textLen, llm: { model: r.model ?? a.llm?.model, tokens: a.tokens } });
            break;
          case 'llm.thinking':
            items.push({ type: 'thinking', ...base, text, textLen, ...(a.llm?.thinking_ms != null ? { meta: { thinkingMs: a.llm.thinking_ms } } : {}) });
            break;
          case 'llm.error':
          case 'llm.refusal':
            items.push({ type: 'error', ...base, text: text ?? a.error?.message ?? r.summary, meta: { kind: r.kind, ...(a.error ? { error: a.error } : {}) } });
            break;
          case 'tool.exec': {
            const parent = r.span_id ? execParents.get(r.span_id) : undefined;
            items.push({
              type: 'exec', ...base, text: r.summary, ...(parent ? { parentEvent: parent } : {}),
              tool: {
                name: a.tool?.name ?? r.tool_name ?? '(unknown)', kind: a.tool?.kind, inputSummary: a.tool?.command ?? a.tool?.input_summary,
                output: a.tool?.output, outputLen: a.tool?.output_len, isError: (r.flag_bits & ERR) !== 0 || a.tool?.is_error === true,
                exitCode: a.tool?.exit_code, dur: r.dur ?? spans.get(r.span_id)?.dur ?? undefined,
              },
            });
            break;
          }
          case 'tool.call':
          case 'tool.result': {
            if (r.kind === 'tool.result' && pairedResults.has(r.span_id)) break;
            const result = r.kind === 'tool.call' ? results.get(r.span_id) : r;
            const ra = result === r ? a : parseJson<Attrs>(result?.attrs, {});
            const tool = {
              name: a.tool?.name ?? r.tool_name ?? '(unknown)', kind: a.tool?.kind, inputSummary: a.tool?.input_summary,
              input: a.tool?.input, output: ra.tool?.output, outputLen: ra.tool?.output_len,
              isError: result ? (result.flag_bits & ERR) !== 0 || ra.tool?.is_error === true : undefined,
              exitCode: ra.tool?.exit_code, dur: r.dur ?? spans.get(r.span_id)?.dur ?? undefined, resultEvent: result?.id,
            };
            items.push(subagent ? { type: 'subagent', ...base, tool, subagent } : { type: 'tool', ...base, tool });
            break;
          }
          case 'agent.spawn':
            items.push(subagent ? { type: 'subagent', ...base, text: r.summary, subagent } : { type: 'status', ...base, text: r.summary });
            break;
          case 'agent.message':
          case 'agent.status':
            items.push({ type: 'status', ...base, text: text ?? r.summary, ...(subagent ? { subagent } : {}) });
            break;
          case 'context.compaction':
            items.push({ type: 'compaction', ...base, text: text ?? r.summary, textLen });
            break;
          case 'turn.end':
          case 'turn.abort':
            items.push({ type: 'turn-end', ...base, text: r.summary, meta: { aborted: r.kind === 'turn.abort', dur: r.dur } });
            break;
        }
      });
      const next = rows.length < n ? null : multi ? offset + rows.length : rows[rows.length - 1].seq;
      return { items, next };
    },

    statsSummary(viewId) {
      const sc = statScope(viewId);
      // A view of whole sessions sums their aggregates, as the global summary sums every session's.
      const out = cached(statKey('summary', sc), () => (!sc.view ? globalSummary() : sc.view.sessionsOnly ? globalSummary([...sc.view.sessions!]) : viewSummary(sc)));
      return { scope: sc.label, ...out };
    },

    statsKinds(viewId) {
      const sc = statScope(viewId);
      return {
        scope: sc.label,
        ...cached(statKey('kinds', sc), () => {
          // Blocks of one line share its bytes; count them once, on the line's first event.
          const stored = storedStats(sc, 'event');
          const rows = stored ? sumKinds(stored) : all(`SELECT e.kind, e.proto, count(*) AS n,
              sum(CASE WHEN coalesce(e.src_block, 0) = 0 THEN coalesce(e.src_len, 0) ELSE 0 END) AS bytes
            FROM ${sc.view ? sc.from : 'events e INDEXED BY ev_kind'} WHERE ${sc.where} GROUP BY e.kind, e.proto`);
          const layers = new Map<string, KindNode>();
          const child = (parent: KindNode, name: string, index: Map<string, KindNode>) => {
            let node = index.get(name);
            if (!node) {
              node = { name, count: 0, bytes: 0, children: [] };
              index.set(name, node);
              parent.children.push(node);
            }
            return node;
          };
          const root: KindNode = { name: '', count: 0, bytes: 0, children: [] };
          const kinds = new Map<string, KindNode>();
          for (const r of rows) {
            const layer = child(root, layerOf(r.kind), layers);
            const kind = child(layer, r.kind, kinds);
            kind.children.push({ name: r.proto, count: r.n, bytes: r.bytes, children: [] });
            for (const node of [layer, kind]) {
              node.count += r.n;
              node.bytes += r.bytes;
            }
          }
          const sortTree = (nodes: KindNode[]): KindNode[] => {
            nodes.sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));
            for (const node of nodes) sortTree(node.children);
            return nodes;
          };
          return { tree: sortTree(root.children) };
        }),
      };
    },

    statsTools(viewId) {
      const sc = statScope(viewId);
      return {
        scope: sc.label,
        ...cached(statKey('tools', sc), () => {
          const groups = new Map<string, { durs: number[]; calls: number; errors: number; agents: Set<string> }>();
          for (const r of toolCalls(sc)) {
            const g = groups.get(r.tool) ?? { durs: [], calls: 0, errors: 0, agents: new Set<string>() };
            g.calls++;
            g.errors += r.err;
            g.agents.add(r.agent);
            if (r.dur != null) g.durs.push(r.dur);
            groups.set(r.tool, g);
          }
          const kindOf = db.prepare(`SELECT tool_kind AS kind FROM events WHERE tool_name = ? AND tool_kind IS NOT NULL LIMIT 1`);
          const tools: ToolStat[] = [...groups].map(([tool, g]) => {
            const durs = g.durs.sort((x, y) => x - y);
            return {
              tool, kind: ((kindOf.get(tool) as Row | undefined)?.kind as string) ?? 'other', calls: g.calls, errors: g.errors, durKnown: durs.length,
              p50: percentile(durs, 50), p90: percentile(durs, 90), p99: percentile(durs, 99), max: durs.at(-1) ?? null,
              total: durs.reduce((sum, d) => sum + d, 0), agents: [...g.agents].sort(),
            };
          });
          return { tools: tools.sort((x, y) => y.calls - x.calls || x.tool.localeCompare(y.tool)) };
        }),
      };
    },

    statsModels(viewId) {
      const sc = statScope(viewId);
      return {
        scope: sc.label,
        ...cached(statKey('models', sc), () => {
          const groups = new Map<string, { calls: number; durs: number[]; tokens: TokenUsage }>();
          const stored = storedStats(sc, 'model');
          if (stored) {
            for (const r of stored) {
              const g = groups.get(r.key) ?? { calls: 0, durs: [], tokens: {} };
              g.calls += r.n;
              for (const d of JSON.parse(r.durs ?? '[]') as number[]) g.durs.push(d);
              addTokens(g.tokens, JSON.parse(r.tokens ?? '{}'));
              groups.set(r.key, g);
            }
          }
          for (const r of stored ? [] : all(`SELECT coalesce(json_extract(sp.attrs, '$.llm.model'), nullif(sp.name, ''), '(unknown)') AS model,
              sp.dur, ${TOKEN_COLS} FROM spans sp WHERE sp.kind = 'llm' AND ${spanInScope(sc)}`)) {
            const g = groups.get(r.model) ?? { calls: 0, durs: [], tokens: {} };
            g.calls++;
            if (r.dur != null) g.durs.push(r.dur);
            addTokens(g.tokens, r);
            groups.set(r.model, g);
          }
          const models: ModelStat[] = [...groups].map(([model, g]) => {
            const durs = g.durs.sort((x, y) => x - y);
            const t = withTotal(g.tokens);
            return {
              model, calls: g.calls, tokens: t, cacheHitRatio: t.input && t.cache_read != null ? t.cache_read / t.input : null,
              latencyP50: percentile(durs, 50), latencyP90: percentile(durs, 90),
            };
          });
          return { models: models.sort((x, y) => y.calls - x.calls || x.model.localeCompare(y.model)) };
        }),
      };
    },

    statsPerformance(viewId) {
      const sc = statScope(viewId);
      return {
        scope: sc.label,
        ...cached(statKey('performance', sc), () => {
          // Intervals and starts clip to the view's time range, so the timeline never reaches outside it.
          const { from, to } = sc.view?.range ?? { from: null, to: null };
          const clamp = (t: number) => Math.min(to ?? Infinity, Math.max(from ?? -Infinity, t));
          const overall = new CallStats();
          const groups = new Map<string, CallStats>();
          const samples: CallSample[] = [];
          // Read span timing directly: existing indexes need no re-parse or analysis migration for these metrics.
          const rows = db.prepare(`SELECT coalesce(json_extract(sp.attrs, '$.llm.model'), nullif(sp.name, ''), '(unknown)') AS model,
            sp.start_ts, sp.status, ${CALL_LATENCY} AS latency, ${CALL_TTFT} AS ttft, ${CALL_OUTPUT_RATE} AS rate,
            coalesce(sp.dur_src, '') NOT LIKE 'logged:%' AS estimated,
            ${CACHE_INPUT} AS cache_input, ${CACHE_READ} AS cache_read, ${CALL_INPUT} AS input
            FROM spans sp WHERE sp.kind = 'llm' AND ${spanInScope(sc)}`);
          for (const r of rows.iterate() as Iterable<Row>) {
            const sample: CallSample = {
              start: r.start_ts > 0 ? clamp(r.start_ts) : null, latency: r.latency, ttft: r.ttft, rate: r.rate, estimated: !!r.estimated,
              cacheInput: r.cache_input, cacheRead: r.cache_read, input: r.input, failed: r.status === 'error',
            };
            overall.add(sample);
            let g = groups.get(r.model);
            if (!g) groups.set(r.model, (g = new CallStats()));
            g.add(sample);
            samples.push(sample);
          }
          // Generic span scope also covers retry/permission spans closed by an event in another span. A view's spans
          // are read through the sessions it holds rows of (sp_session), never by scanning every span.
          const inScope = sc.view ? `sp.session_id IN (SELECT value FROM json_each('${rowSessions(sc.view).replaceAll("'", "''")}'))
            AND (sp.id IN (SELECT e.span_id FROM ${sc.from} WHERE ${sc.where}) OR sp.last_event IN (SELECT e.id FROM ${sc.from} WHERE ${sc.where}))`
            : 'sp.inherited = 0';
          const command = `coalesce(json_extract(sp.attrs, '$.tool.command'), json_extract(sp.attrs, '$.tool.input.command'), json_extract(sp.attrs, '$.tool.input.cmd'))`;
          // One pass over the scoped spans: busy time reads the kinds Statistics ▸ Time reads, the timeline counts tool
          // calls by their start, and the longest completed intervals (exec spans aside: their tool call covers them)
          // are the bottlenecks.
          const intervals: BusyInterval[] = [];
          const tools: ToolStart[] = [];
          /** The ten longest so far, longest first; equal durations by span id. */
          const longest: Row[] = [];
          const longer = (x: Row, y: Row) => x.dur > y.dur || (x.dur === y.dur && x.id < y.id);
          for (const r of db.prepare(`SELECT sp.id, sp.session_id, sp.first_event, sp.last_event, sp.kind, sp.name, sp.status,
              sp.start_ts, sp.end_ts, sp.dur, sp.dur_src, ${CALL_LATENCY} AS latency,
              json_extract(sp.attrs, '$.tool.input.chars') AS chars, ${command} AS cmd
            FROM spans sp WHERE ${inScope} AND sp.start_ts IS NOT NULL
              AND sp.kind IN ('llm', 'tool', 'exec', 'hook', 'retry', 'compaction', 'permission', 'workflow', 'phase')`).iterate() as Iterable<Row>) {
            if (r.latency > 0 && r.kind !== 'exec' && (longest.length < 10 || longer(r, longest[9]))) {
              const at = longest.findIndex((x) => longer(r, x));
              longest.splice(at < 0 ? longest.length : at, 0, r);
              if (longest.length > 10) longest.pop();
            }
            if (!(r.start_ts > 0)) continue;
            if (r.kind === 'tool') tools.push({ start: clamp(r.start_ts), failed: r.status === 'error' });
            if (r.end_ts == null) continue;
            const start = clamp(r.start_ts);
            const end = clamp(r.end_ts);
            if (end > start) intervals.push({ session: r.session_id, start, end, bucket: spanBucket(r) });
          }
          // TTFT and cache reuse of the model calls among them.
          const llm = new Map(all(`SELECT sp.id, ${CALL_TTFT} AS ttft, (${CACHE_READ}) * 1.0 / (${CACHE_INPUT}) AS cache_ratio
            FROM spans sp WHERE sp.id IN (SELECT value FROM json_each(?))`, JSON.stringify(longest.filter((r) => r.kind === 'llm').map((r) => r.id)))
            .map((r) => [r.id, r]));
          const bottlenecks: PerformanceBottleneck[] = longest.map((r) => ({
            spanId: r.id, sessionId: r.session_id, eventId: r.first_event ?? r.last_event,
            name: r.name || r.kind, bucket: spanBucket(r), start: r.start_ts, duration: r.dur,
            estimated: !String(r.dur_src ?? '').startsWith('logged:'), ttft: llm.get(r.id)?.ttft ?? null, cacheHitRatio: llm.get(r.id)?.cache_ratio ?? null,
          }));
          const models = [...groups].map(([model, g]) => g.stat(model));
          return {
            overall: overall.stat(''),
            models: models.sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)),
            bottlenecks,
            timeline: performanceTimeline(intervals, samples, tools),
          };
        }),
      };
    },

    statsIo(viewId, intervalUs, metric) {
      const sc = statScope(viewId);
      const out = cached(statKey(`io:${intervalUs ?? ''}:${metric}`, sc), () => {
        const io = ioSource(sc, metric);
        if (!io) return { binUs: intervalUs ?? 1e6, metric, series: [] as { t: number; v: number }[] };
        const { ts: tsCol, source, agg, level } = io;
        const range = get(`SELECT min(${tsCol}) AS lo, max(${tsCol}) AS hi FROM ${source}`)!;
        if (range.lo == null) return { binUs: intervalUs ?? 1e6, metric, series: [] as { t: number; v: number }[] };
        const width = range.hi - range.lo + 1;
        const binUs = Math.max(
          intervalUs && intervalUs > 0 ? Math.round(intervalUs) : NICE_US.find((u) => u >= width / 300) ?? NICE_US.at(-1)!,
          Math.ceil(width / MAX_IO_BINS),
        );
        const sample = metric === 'ttft.mean' ? CALL_TTFT : metric === 'output.rate.mean' ? CALL_OUTPUT_RATE : null;
        const rows = all(`SELECT CAST(${tsCol} / ? AS INTEGER) AS b, ${agg} AS v${sample ? `, count(${sample}) AS n` : ''} FROM ${source} GROUP BY b ORDER BY b`, binUs);
        // A mean or a peak has no value in an empty bin (missing, not zero), so its series is sparse.
        if (level) {
          return { binUs, metric, series: rows.filter((r) => r.v != null).map((r) => ({ t: r.b * binUs, v: r.v as number, ...(sample ? { n: r.n as number } : {}) })) };
        }
        // Counts and sums are zero in empty bins, so the series is dense.
        const values = new Map(rows.map((r) => [r.b, r.v ?? 0]));
        const series: { t: number; v: number }[] = [];
        for (let b = Math.floor(range.lo / binUs); b <= Math.floor(range.hi / binUs); b++) series.push({ t: b * binUs, v: values.get(b) ?? 0 });
        return { binUs, metric, series };
      });
      return { scope: sc.label, ...out };
    },

    statsPairs(viewId) {
      const sc = statScope(viewId);
      return {
        scope: sc.label,
        ...cached(statKey('pairs', sc), () => {
          const pairs = new Map<string, PairStat>();
          for (const r of toolCalls(sc)) {
            const key = `${r.agent}\u0000${r.tool}`;
            const p = pairs.get(key) ?? { a: r.agent, b: r.tool, count: 0, dur: 0, errors: 0 };
            p.count++;
            p.dur += r.dur ?? 0;
            p.errors += r.err;
            pairs.set(key, p);
          }
          const out = [...pairs.values()];
          // Parent → child sessions: from the session aggregates globally, from the view's rows otherwise.
          const children = sc.view
            ? all(`SELECT c.parent_id AS a, c.id AS b, x.n, x.errors, coalesce(c.end_ts - c.start_ts, 0) AS dur
                FROM (SELECT e.session_id AS sid, count(*) AS n, sum((e.flag_bits & ${ERR}) != 0) AS errors
                      FROM ${sc.from} WHERE ${sc.where} GROUP BY e.session_id) x
                JOIN sessions c ON c.id = x.sid WHERE c.parent_id IS NOT NULL`)
            : all(`SELECT parent_id AS a, id AS b, n_events AS n, n_errors AS errors, coalesce(end_ts - start_ts, 0) AS dur
                FROM sessions WHERE parent_id IS NOT NULL AND n_events > 0`);
          for (const r of children) out.push({ a: r.a, b: r.b, count: r.n, dur: r.dur, errors: r.errors });
          return { pairs: out.sort((x, y) => y.count - x.count) };
        }),
      };
    },

    expert(q) {
      const where = ['1'];
      const params: Param[] = [];
      if (q.session) {
        where.push('x.session_id = ?');
        params.push(q.session);
      }
      if (q.severity) {
        where.push(`${SEVERITY_SQL} = ?`);
        params.push(q.severity);
      }
      if (q.group) {
        where.push('x.grp = ?');
        params.push(q.group);
      }
      const sc = statScope(q.viewId);
      if (sc.view) {
        // Entries tied to an event follow that event; session-level entries follow the view's sessions.
        const v = sc.view;
        ensureRidIndex(v);
        where.push(`x.session_id IN (SELECT value FROM json_each(?))
          AND (x.event_id IS NULL OR EXISTS (SELECT 1 FROM events e JOIN temp.${v.table} v ON v.rid = e.rid WHERE e.id = x.event_id))`);
        params.push(rowSessions(v));
      }
      // A child session's abort names no actor, and a group's severity follows GROUP_SEVERITY, also in indexes parsed
      // before the adapters said so (INTERRUPT_NOTE).
      const rows = all(`SELECT * FROM (
          SELECT x.id, x.session_id, x.event_id, x.span_id, ${SEVERITY_SQL} AS severity, x.grp,
            CASE WHEN x.grp = 'interrupted' AND x.message = ? AND (SELECT role FROM sessions WHERE id = x.session_id) <> 'main' THEN ? ELSE x.message END AS message,
            row_number() OVER (PARTITION BY ${SEVERITY_SQL}, x.grp ORDER BY x.id) AS rn,
            count(*) OVER (PARTITION BY ${SEVERITY_SQL}, x.grp) AS total
          FROM expert x WHERE ${where.join(' AND ')})
        WHERE rn <= ? ORDER BY severity, grp, rn`, INTERRUPT_NOTE.main, INTERRUPT_NOTE.child, ...params, clampInt(q.limit, 200, 1, 10_000));
      const tsOf = db.prepare('SELECT ts FROM events WHERE id = ?');
      // SPEC §12.7 Diagnostics: on an analysed index, failure items link to their episode.
      const analysed = (indexSchemaVersion(db) ?? 0) >= 4;
      const episodeOf = analysed ? db.prepare('SELECT f.episode_id AS ep FROM events e JOIN failures f ON f.rid = e.rid WHERE e.id = ?') : null;
      const groups = new Map<string, ExpertResult['groups'][number]>();
      for (const r of rows) {
        const key = `${r.severity}\u0000${r.grp}`;
        let g = groups.get(key);
        if (!g) {
          g = { severity: r.severity, group: r.grp, count: r.total, items: [] };
          groups.set(key, g);
        }
        const ts = r.event_id ? ((tsOf.get(r.event_id) as Row | undefined)?.ts ?? null) : null;
        const item: ExpertResult['groups'][number]['items'][number] = { id: r.id, session: r.session_id, event: r.event_id, span: r.span_id, message: r.message, ts };
        if (episodeOf) item.episodeId = r.event_id ? ((episodeOf.get(r.event_id) as Row | undefined)?.ep ?? null) : null;
        g.items.push(item);
      }
      if (analysed && (!q.severity || q.severity === 'warn')) {
        for (const g of derivedExpertGroups(q, sc)) if (g.count && (!q.group || q.group === g.group)) groups.set(`warn\u0000${g.group}`, g);
      }
      return {
        scope: sc.label,
        groups: [...groups.values()].sort((x, y) => (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9) || y.count - x.count),
      };
    },

    async sources(opts = {}): Promise<SourcesResult> {
      // Loaded on demand: the health report pulls in every adapter's discovery code. One report serves requests
      // until an index run changes data or HEALTH_TTL_MS pass (the local report also reads agent settings).
      const { healthReport } = await import('../health.ts');
      const scope = ctx.mode === 'capture' && !opts.local ? 'captured' : 'local';
      const capture = captureInfo();
      const key = `${scope}@${dataVersion}`;
      if (!health || health.key !== key || performance.now() - health.at > HEALTH_TTL_MS) {
        const report = healthReport(db, ctx.healthEnv, { scope });
        health = { key, at: performance.now(), report };
        report.catch(() => (health = null));
      }
      const host = (capture?.header?.host as { hostname?: string } | undefined)?.hostname ?? null;
      return {
        scope,
        host: scope === 'captured' ? host : hostname(),
        ...(scope === 'captured' ? { capturedAt: capture?.createdAt ?? null } : {}),
        agents: await health.report,
        sources: all('SELECT * FROM sources ORDER BY agent, path').map(sourceRow),
      };
    },

    async file(q) {
      if (q.blob) return blobFile('sha256 = ?', q.blob);
      if (!q.path) return null;
      // A capture carries side files as blobs; it never serves from this machine's disk.
      const captured = blobFile('origin_path = ?', q.path);
      if (captured || ctx.mode === 'capture') return captured;
      if (isCredentialPath(q.path)) return null;
      const real = await realpath(q.path).catch(() => null);
      if (!real || isCredentialPath(real)) return null;
      const dirs = await cached(versioned('served-dirs'), allowedDirs);
      if (!dirs.some((d) => real.startsWith(d + sep))) return null;
      if (!(await stat(real).catch(() => null))?.isFile()) return null;
      const data = await readFile(real);
      return { contentType: contentTypeFor(real, data), data };
    },

    noteChanges(sessions) {
      dataVersion++;
      // Views stay readable under their ids (clients page through them until they rebuild); a view over changed
      // data is only rebuilt the next time a client asks for the same spec.
      const changed = sessions ? new Set(sessions) : null;
      for (const v of views.values()) {
        if (!changed || !v.sessions || [...v.sessions].some((id) => changed.has(id))) v.stale = true;
      }
      for (const k of [...memo.keys()]) if (k.includes('@')) memo.delete(k);
    },
  };

  // -------------------------------------------------------------------------
  // Statistics helpers (hoisted function declarations share the closure above)

  /**
   * Summary from the session aggregates the linker maintains (of every session, or of `ids`): milliseconds instead of
   * a scan of every event.
   */
  function globalSummary(ids?: string[]) {
    const among = ids ? ' AND id IN (SELECT value FROM json_each(?))' : '';
    const params = ids ? [JSON.stringify(ids)] : [];
    const sessions = all(`SELECT agent, n_events, n_errors, n_llm, n_tools, start_ts, end_ts, cost_usd,
        ${SESSION_TOKEN_COLS.map(([, c]) => c).join(', ')} FROM sessions WHERE n_events > 0${among}`, ...params);
    const byAgent = new Map<string, { agent: string; sessions: number; events: number }>();
    const tokens: TokenUsage = {};
    let events = 0;
    let errors = 0;
    let llmCalls = 0;
    // A tool call is a tool span (n_tools): the linker opens one per call that is not a copy.
    let toolCalls = 0;
    let firstTs: number | null = null;
    let lastTs: number | null = null;
    let cost: number | null = null;
    for (const s of sessions) {
      events += s.n_events;
      errors += s.n_errors;
      llmCalls += s.n_llm;
      toolCalls += s.n_tools;
      if (s.start_ts != null && (firstTs === null || s.start_ts < firstTs)) firstTs = s.start_ts;
      const end = s.end_ts ?? s.start_ts;
      if (end != null && (lastTs === null || end > lastTs)) lastTs = end;
      const a = byAgent.get(s.agent) ?? { agent: s.agent, sessions: 0, events: 0 };
      a.sessions++;
      a.events += s.n_events;
      byAgent.set(s.agent, a);
      if (s.cost_usd != null) cost = (cost ?? 0) + s.cost_usd;
      for (const [key, col] of SESSION_TOKEN_COLS) if (s[col] != null) tokens[key] = (tokens[key] ?? 0) + s[col];
    }
    return {
      events, sessions: sessions.length, firstTs, lastTs, byAgent: [...byAgent.values()].sort((x, y) => y.events - x.events),
      tokens: withTotal(tokens), llmCalls, toolCalls, errors, loggedCostUsd: cost,
    };
  }

  function viewSummary(sc: Scope) {
    // Tool calls: the tool spans the view holds a call or result of, as in statsTools (a paired result sits in its
    // call's tool span; an orphan result, flagged, sits elsewhere), counted in the same pass.
    const perSession = all(`SELECT e.session_id AS sid, count(*) AS n, min(e.ts) AS t0, max(e.ts) AS t1,
        sum((e.flag_bits & ${ERR}) != 0) AS errors,
        count(DISTINCT CASE WHEN e.kind = 'tool.call' OR (e.kind = 'tool.result' AND (e.flag_bits & ${FLAG_BITS.orphan}) = 0)
          THEN e.span_id END) AS tools
      FROM ${sc.from} WHERE ${sc.where} GROUP BY e.session_id`);
    const sessions = new Map(all(`SELECT id, agent, cost_usd FROM sessions WHERE id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(perSession.map((r) => r.sid))).map((r) => [r.id, r]));
    const byAgent = new Map<string, { agent: string; sessions: number; events: number }>();
    let events = 0;
    let errors = 0;
    let toolCalls = 0;
    let firstTs: number | null = null;
    let lastTs: number | null = null;
    let cost: number | null = null;
    for (const r of perSession) {
      events += r.n;
      errors += r.errors;
      toolCalls += r.tools;
      if (firstTs === null || r.t0 < firstTs) firstTs = r.t0;
      if (lastTs === null || r.t1 > lastTs) lastTs = r.t1;
      const s = sessions.get(r.sid);
      const agent = s?.agent ?? 'unknown';
      const a = byAgent.get(agent) ?? { agent, sessions: 0, events: 0 };
      a.sessions++;
      a.events += r.n;
      byAgent.set(agent, a);
      // Logged cost is per session, so a view counts the sessions it touches.
      if (s?.cost_usd != null) cost = (cost ?? 0) + s.cost_usd;
    }
    const llm = get(`SELECT count(*) AS n, ${TOKEN_SUMS} FROM spans sp WHERE sp.kind = 'llm' AND ${spanInScope(sc)}`)!;
    const tokens: TokenUsage = {};
    addTokens(tokens, llm);
    return {
      events, sessions: perSession.length, firstTs, lastTs, byAgent: [...byAgent.values()].sort((x, y) => y.events - x.events),
      tokens: withTotal(tokens), llmCalls: llm.n, toolCalls, errors, loggedCostUsd: cost,
    };
  }

  /** Filter field and value for every scalar leaf of {event, attrs, native} (Mac contract §3.5). */
  function fieldMapOf(row: EventRow, attrs: Record<string, unknown>, native: unknown): Record<string, FieldRef> {
    const out: Record<string, FieldRef> = {};
    for (const [key, field] of Object.entries(EVENT_FIELDS)) {
      const value = (row as unknown as Record<string, unknown>)[key];
      if (value !== null && value !== undefined && typeof value !== 'object') out[`/event/${key}`] = { field, value: value as FieldRef['value'] };
    }
    row.flags.forEach((flag, i) => (out[`/event/flags/${i}`] = { field: flag, value: true }));
    const found: [string, (string | number)[], FieldRef['value']][] = [];
    leaves(attrs, '/attrs', [], found, MAX_FIELD_MAP);
    for (const [pointer, path, value] of found) {
      const name = fieldPath(path);
      if (!name) continue;
      const r = resolveName(name, false);
      out[pointer] = { field: 'error' in r || r.warning ? `attrs.${name}` : name, value };
    }
    const nat: [string, (string | number)[], FieldRef['value']][] = [];
    leaves(native, '/native', [], nat, MAX_FIELD_MAP);
    for (const [pointer, path, value] of nat) {
      const name = fieldPath(path);
      if (name) out[pointer] = { field: `native.${name}`, value };
    }
    return out;
  }
}
