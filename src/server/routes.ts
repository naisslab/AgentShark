// HTTP API routes (SPEC §6, §12.5): parameter parsing and validation, mapped onto IndexQueries and DerivedQueries
// methods. The query objects are injected, so this module never touches SQLite directly.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, normalize } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { isCredentialPath } from '../adapters/adapter.ts';
import type {
  AnalysisStatus, ColorRule, DerivedQueries, DerivedRowsQuery, DerivedScopeQuery, EndpointKind, EpisodeReportFormat, FollowTarget, IoMetric,
  LensQuery, QueueSort, SrtGroup, StepSort, ViewSort, ViewSpec,
} from '../index/api.ts';
import { parseTime } from '../filter/compile.ts';
import { SPAN_KINDS } from '../model/kinds.ts';
import {
  AGENT_PREFIX, ALARM_KINDS, ALARM_STATES, ALARM_THRESHOLDS, ATTENTION_SECTIONS, EPISODE_OUTCOMES, FAILURE_FAMILIES, FAILURE_TIERS, QUEUE_GROUPS,
  SIGNATURE_STATUSES, TIME_BUCKETS, type AgentKind, type AlarmThresholds, type ExpertGroup, type ExpertSeverity, type SessionRole, type SpanKind,
} from '../model/types.ts';
import type { ApiDerivedQueries, ApiQueries } from './query-host.ts';
import { validOperation, workbenchInput, type WorkbenchDispatch, WORKBENCH_OPERATIONS } from './workbench.ts';

export type { ApiDerivedQueries };

const gzipAsync = promisify(gzip);

/** JSON bodies larger than this are gzipped when the client accepts it. */
const GZIP_MIN_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 1 << 20;
const REPORT_BODY_BYTES = 16 << 20;
const MAX_VIEW_ROWS = 1000;
const MAX_HISTOGRAM_BINS = 10_000;
/** Largest `maxString` of the raw endpoint; a longer string is always shortened (SPEC §6). */
const MAX_RAW_STRING = 1_000_000;
const VIEW_SORTS: ViewSort[] = ['ts', 'seq', 'dur', 'tokIn', 'tokOut', 'kind', 'tool', 'session'];
// Largest page sizes of the derived routes (api.ts): the queue, Session · Steps, and every other derived list.
const MAX_QUEUE_ROWS = 1000;
const MAX_STEPS = 5000;
const MAX_DERIVED_ROWS = 5000;
/** Largest `output_chars` of the Lens frames and Follow streams (LensQuery). */
const MAX_OUTPUT_CHARS = 20_000;
const MARKDOWN = 'text/markdown; charset=utf-8';

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ApiContext {
  queries: ApiQueries;
  /** The SPEC §12.5 routes and `/api/info`'s `analysis`. Absent: the derived routes answer 501 not-implemented. */
  derived?: ApiDerivedQueries;
  workbench?: WorkbenchDispatch;
  /** Starts an incremental index run; returns false when one is already running. Absent in capture mode. */
  reindex?: () => boolean;
  /** Settings ▸ Alerts: stores the thresholds and starts a run that re-derives every tree. Absent in capture mode. */
  setAlarmThresholds?: (t: Partial<AlarmThresholds>) => Promise<AnalysisStatus>;
  /** Takes over the response as a Server-Sent Events stream. */
  openStream: (res: ServerResponse) => void;
}

interface ApiRequest {
  params: string[];
  query: URLSearchParams;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
}

/** Returned by handlers that wrote the response themselves (files, SSE). */
const HANDLED = Symbol('handled');

type Handler = (c: ApiContext, r: ApiRequest) => unknown;

interface Route {
  method: 'GET' | 'POST' | 'PUT';
  pattern: RegExp;
  handler: Handler;
  /** Largest request body this route reads (default MAX_BODY_BYTES). */
  maxBody?: number;
}

// `:name` matches one path segment; `:name*` matches the rest of the path, because session
// and span IDs may contain '/' (cc:<sid>/<agentId>) when a client does not encode them.
function route(method: Route['method'], path: string, handler: Handler, maxBody?: number): Route {
  const source = path
    .split('/')
    .map((seg) => (seg.endsWith('*') && seg.startsWith(':') ? '(.+)' : seg.startsWith(':') ? '([^/]+)' : seg))
    .join('/');
  return { method, pattern: new RegExp(`^${source}$`), handler, ...(maxBody ? { maxBody } : {}) };
}

const AGENTS = Object.keys(AGENT_PREFIX) as AgentKind[];
// Records keyed by the union types, so the compiler flags any kind added to the contract.
const SEVERITIES: Record<ExpertSeverity, true> = { error: true, warn: true, note: true, chat: true };
const GROUPS: Record<ExpertGroup, true> = {
  malformed: true, undecoded: true, unpaired: true, 'tool-error': true, 'api-error': true, retry: true, refusal: true,
  interrupted: true, 'permission-denied': true, compaction: true, 'logging-gap': true, sequence: true, 'rate-limit': true,
};
const IO_METRICS: Record<IoMetric, true> = {
  events: true, errors: true, 'tokens.input': true, 'tokens.output': true, 'tool.calls': true, 'llm.calls': true, 'latency.mean': true,
  'ttft.mean': true, 'output.rate.mean': true,
  'context.tokens': true, 'failures.failure': true, 'failures.suspect': true, 'failures.benign': true, 'failures.deferred': true,
};
/** The keys of a record keyed by a union type that has no runtime array in the contract. */
const keysOf = <T extends string>(r: Record<T, true>) => Object.keys(r) as T[];
const ROLES = keysOf<SessionRole>({ main: true, subagent: true, 'workflow-agent': true, guardian: true, review: true, fork: true, automation: true });
const QUEUE_SORTS = keysOf<QueueSort>({ attention: true, recent: true, impact: true, attempts: true, wall: true, sessions: true });
const STEP_SORTS = keysOf<StepSort>({ seq: true, dur: true, active: true, gap: true, tokIn: true, tokOut: true, ctx: true });
const SRT_GROUPS = keysOf<SrtGroup>({ tool: true, server: true, program: true, host: true, model: true });
const ENDPOINT_KINDS = keysOf<EndpointKind>({ mcp: true, host: true, hook: true, program: true, agent: true });
const REPORT_FORMATS = keysOf<EpisodeReportFormat>({ md: true, brief: true, json: true });

// SPEC §12.5 and docs/MODULES.md D: one DerivedQueries method per route. Routes whose id may hold '/' take the rest of
// the path (`:id*`), so each one with a suffix (`/report`, `/steps`) comes before the bare form it would also match.
const DERIVED_ROUTES: Route[] = [
  route('GET', '/api/failures/summary', (c, { query: q }) =>
    derived(c).failuresSummary({ ...scope(q), tier: listOf(q, 'tier', FAILURE_TIERS) }),
  ),
  route('GET', '/api/failures/queue', (c, { query: q }) =>
    derived(c).failuresQueue({
      ...scope(q),
      group: oneOf(q, 'group', QUEUE_GROUPS),
      tier: listOf(q, 'tier', FAILURE_TIERS),
      outcome: listOf(q, 'outcome', EPISODE_OUTCOMES),
      family: listOf(q, 'family', FAILURE_FAMILIES),
      agent: listOf(q, 'agent', AGENTS),
      role: listOf(q, 'role', ROLES),
      unattended: bool(q, 'unattended'),
      section: oneOf(q, 'section', ATTENTION_SECTIONS),
      signature: str(q, 'signature'),
      sort: oneOf(q, 'sort', QUEUE_SORTS),
      limit: capped(q, 'limit', MAX_QUEUE_ROWS),
      offset: int(q, 'offset', 0),
    }),
  ),

  route('GET', '/api/episodes', (c, r) => derived(c).episodes(rows(r.query))),
  route('GET', '/api/episodes/:id*/report', async (c, { params, query: q, req, res }) => {
    const format = oneOf(q, 'format', REPORT_FORMATS) ?? 'md';
    const report = await found(derived(c).episodeReport(params[0], format), 'episode');
    // md and brief are text: a client that asks for Markdown gets the text alone, without the redaction list.
    if (format === 'json' || !/\btext\/markdown\b/i.test(req.headers.accept ?? '')) return report;
    await sendBody(req, res, 200, Buffer.from(report.text), MARKDOWN);
    return HANDLED;
  }),
  route('GET', '/api/episodes/:id*', (c, r) => found(derived(c).episode(r.params[0], lens(r.query)), 'episode')),

  route('GET', '/api/signatures', (c, { query: q }) =>
    derived(c).signatures({
      ...scope(q),
      family: listOf(q, 'family', FAILURE_FAMILIES),
      status: listOf(q, 'status', SIGNATURE_STATUSES),
      tier: listOf(q, 'tier', FAILURE_TIERS),
      sort: oneOf(q, 'sort', ['impact', 'count', 'recent'] as const),
      limit: capped(q, 'limit', MAX_DERIVED_ROWS),
      offset: int(q, 'offset', 0),
    }),
  ),
  route('GET', '/api/signatures/:id', (c, { params, query: q }) =>
    found(derived(c).signature(params[0], { splitAt: time(q, 'split_at') }), 'signature'),
  ),

  route('GET', '/api/sessions/:id*/steps', (c, { params, query: q }) =>
    found(
      derived(c).sessionSteps(params[0], {
        view: str(q, 'view'),
        turn: str(q, 'turn'),
        after: str(q, 'after'),
        limit: capped(q, 'limit', MAX_STEPS),
        sort: oneOf(q, 'sort', STEP_SORTS),
        order: oneOf(q, 'order', ['asc', 'desc'] as const),
        descendants: bool(q, 'descendants'),
        foldClean: bool(q, 'fold_clean'),
        onlyFailed: bool(q, 'only_failed'),
        bucket: oneOf(q, 'bucket', TIME_BUCKETS),
      }),
      'session',
    ),
  ),

  route('GET', '/api/report/:id*', async (c, { params, query: q, req, res }) => {
    const format = oneOf(q, 'format', ['json', 'md'] as const) ?? 'json';
    const report = await found(derived(c).runReport(params[0], { since: time(q, 'since') }), 'session');
    if (format === 'json') return report;
    // Loaded on demand, like the queries in server.ts: this module stays free of SQLite.
    const { renderRunReportMarkdown } = await import('../index/derived-queries.ts');
    await sendBody(req, res, 200, Buffer.from(renderRunReportMarkdown(report)), MARKDOWN);
    return HANDLED;
  }),

  route('GET', '/api/delegations', (c, r) => derived(c).delegations(rows(r.query))),
  route('GET', '/api/delegations/:id*', (c, r) => found(derived(c).delegation(r.params[0], lens(r.query)), 'delegation')),
  route('GET', '/api/claims', (c, r) => derived(c).claims(rows(r.query))),
  route('GET', '/api/claims/:id*', (c, r) => found(derived(c).claim(r.params[0], lens(r.query)), 'claim')),
  route('GET', '/api/interventions', (c, r) => derived(c).interventions(rows(r.query))),
  route('GET', '/api/processes', (c, r) => derived(c).processes(rows(r.query))),
  route('GET', '/api/alarms', (c, { query: q }) =>
    derived(c).alarms({ ...rows(q), state: oneOf(q, 'state', ALARM_STATES), kind: listOf(q, 'kind', ALARM_KINDS) }),
  ),

  route('GET', '/api/events/:id/derived', (c, r) => found(derived(c).eventDerived(r.params[0]), 'event')),
  route('GET', '/api/session-marks', (c, r) => derived(c).sessionMarks({ ids: list(r.query, 'ids') })),
  route('GET', '/api/changes/:id/diff', (c, { params, query: q }) =>
    found(derived(c).diff(params[0], { path: str(q, 'path'), maxLines: int(q, 'max_lines', 1) }), 'change'),
  ),

  route('GET', '/api/follow/call/:id', (c, r) => follow(c, r.query, { kind: 'call', eventId: r.params[0] })),
  route('GET', '/api/follow/delegation/:id*', (c, r) => follow(c, r.query, { kind: 'delegation', spanId: r.params[0] })),
  route('GET', '/api/follow/process/:id*', (c, r) => follow(c, r.query, { kind: 'process', id: r.params[0] })),
  route('GET', '/api/follow/file', (c, { query: q }) =>
    follow(c, q, { kind: 'file', session: required(q, 'session'), path: required(q, 'path') }),
  ),

  route('GET', '/api/time', (c, { query: q }) => {
    const session = str(q, 'session');
    const turn = str(q, 'turn');
    if ((session === undefined) === (turn === undefined)) throw new HttpError(400, 'bad-param', "Pass exactly one of 'session' and 'turn'");
    return found(derived(c).time({ session, turn }), session ? 'session' : 'turn');
  }),
  route('GET', '/api/stats/endpoints', (c, { query: q }) =>
    derived(c).statsEndpoints({ view: str(q, 'view'), kind: oneOf(q, 'kind', ENDPOINT_KINDS) }),
  ),
];

const ROUTES: Route[] = [
  route('GET', '/api/info', async (c) => {
    const info = await c.queries.info();
    return c.derived ? { ...info, analysis: await c.derived.analysisStatus() } : info;
  }),
  route('GET', '/api/fields', (c) => c.queries.fields()),
  route('POST', '/api/filter/validate', (c, r) => c.queries.validateFilter(bodyString(r.body, 'filter') ?? '')),
  // Before `/api/sessions/:id*`, which would also match `/api/sessions/<id>/steps`.
  ...DERIVED_ROUTES,

  route('GET', '/api/sessions', (c, { query: q }) =>
    c.queries.listSessions({
      ids: list(q, 'ids'),
      agent: oneOf(q, 'agent', AGENTS),
      q: str(q, 'q'),
      from: time(q, 'from'),
      to: time(q, 'to'),
      role: str(q, 'role'),
      state: str(q, 'state'),
      limit: int(q, 'limit', 0),
      offset: int(q, 'offset', 0),
    }),
  ),
  route('GET', '/api/sessions/:id*', (c, r) => found(c.queries.getSession(r.params[0]), 'session')),

  route('POST', '/api/views', (c, r) => c.queries.createView(viewSpec(r.body))),
  route('GET', '/api/views/:id/rows', async (c, { params, query: q }) => ({
    rows: await c.queries.viewRows(params[0], int(q, 'offset', 0) ?? 0, Math.min(int(q, 'limit', 0) ?? 200, MAX_VIEW_ROWS), list(q, 'columns') ?? []),
  })),
  route('GET', '/api/views/:id/locate', async (c, { params, query: q }) => ({ no: await c.queries.locate(params[0], required(q, 'event')) })),
  route('GET', '/api/views/:id/find', async (c, { params, query: q }) => ({
    no: await c.queries.find(params[0], required(q, 'q'), int(q, 'from', 0), oneOf(q, 'dir', ['next', 'prev'] as const) ?? 'next'),
  })),
  route('GET', '/api/views/:id/histogram', (c, { params, query: q }) =>
    c.queries.histogram(params[0], Math.min(int(q, 'bins', 1) ?? 200, MAX_HISTOGRAM_BINS), time(q, 'from'), time(q, 'to')),
  ),

  route('GET', '/api/events/:id', (c, r) => found(c.queries.getEvent(r.params[0]), 'event')),
  route('GET', '/api/events/:id/raw', (c, { params, query: q }) => {
    const max = int(q, 'maxString', 1);
    return c.queries.getRaw(params[0], max === undefined ? undefined : Math.min(max, MAX_RAW_STRING));
  }),

  route('GET', '/api/spans', (c, { query: q }) =>
    c.queries.listSpans({
      sessions: list(q, 'sessions'),
      from: time(q, 'from'),
      to: time(q, 'to'),
      kinds: listOf(q, 'kinds', Object.keys(SPAN_KINDS) as SpanKind[]),
      minDur: duration(q, 'minDur'),
      limit: int(q, 'limit', 1),
    }),
  ),
  route('GET', '/api/spans/:id*', (c, r) => found(c.queries.getSpan(r.params[0]), 'span')),

  route('GET', '/api/overview', (c, { query: q }) =>
    c.queries.overview({ from: time(q, 'from'), to: time(q, 'to'), agent: oneOf(q, 'agent', AGENTS) }),
  ),
  route('GET', '/api/conversation/:id*', (c, { params, query: q }) =>
    c.queries.conversation(params[0], int(q, 'after'), int(q, 'limit', 1)),
  ),

  route('GET', '/api/stats/summary', (c, r) => c.queries.statsSummary(str(r.query, 'view'))),
  route('GET', '/api/stats/kinds', (c, r) => c.queries.statsKinds(str(r.query, 'view'))),
  // With `group`, service response times (SPEC §12.5); without it, the SPEC §6 answer.
  route('GET', '/api/stats/tools', (c, { query: q }) => {
    const group = oneOf(q, 'group', SRT_GROUPS);
    return group ? derived(c).statsSrt({ view: str(q, 'view'), group }) : c.queries.statsTools(str(q, 'view'));
  }),
  route('GET', '/api/stats/models', (c, r) => c.queries.statsModels(str(r.query, 'view'))),
  route('GET', '/api/stats/performance', (c, r) => c.queries.statsPerformance(str(r.query, 'view'))),
  route('GET', '/api/stats/io', (c, { query: q }) =>
    c.queries.statsIo(str(q, 'view'), duration(q, 'interval'), oneOf(q, 'metric', Object.keys(IO_METRICS) as IoMetric[]) ?? 'events'),
  ),
  route('GET', '/api/stats/pairs', (c, r) => c.queries.statsPairs(str(r.query, 'view'))),

  route('GET', '/api/expert', (c, { query: q }) =>
    c.queries.expert({
      viewId: str(q, 'view'),
      session: str(q, 'session'),
      severity: oneOf(q, 'severity', Object.keys(SEVERITIES) as ExpertSeverity[]),
      group: oneOf(q, 'group', [...Object.keys(GROUPS) as ExpertGroup[], 'loop', 'silent-child', 'audit'] as const),
      limit: int(q, 'limit', 1),
    }),
  ),

  route('GET', '/api/sources', (c, { query: q }) => c.queries.sources({ local: bool(q, 'local') })),
  route('GET', '/api/workbench', (c) => ({ available: !!c.workbench, operations: WORKBENCH_OPERATIONS, version: 1 })),
  // A replay report lists every call of a session tree, so it may be larger than other requests.
  route('POST', '/api/workbench/replayReport', (c, r) => workbench(c, 'replayReport', r.body), REPORT_BODY_BYTES),
  route('POST', '/api/workbench/:operation', (c, r) => workbench(c, r.params[0], r.body)),
  route('GET', '/api/file', serveSideFile),

  route('POST', '/api/reindex', (c) => {
    if (!c.reindex) throw new HttpError(409, 'capture-mode', 'Reindexing is only available for the live index');
    return { started: c.reindex() };
  }),
  route('PUT', '/api/settings/alarm-thresholds', (c, r) => {
    if (!c.setAlarmThresholds) throw new HttpError(409, 'capture-mode', 'A capture keeps the thresholds it was written with');
    return c.setAlarmThresholds(alarmThresholds(r.body));
  }),
  route('GET', '/api/stream', (c, r) => {
    c.openStream(r.res);
    return HANDLED;
  }),
];

/** Handle one authenticated /api request. Never throws; every failure becomes a JSON error response. */
export async function handleApi(c: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const path = url.pathname;
    const allowed: string[] = [];
    for (const r of ROUTES) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      if (r.method !== req.method) {
        allowed.push(r.method);
        continue;
      }
      const params = m.slice(1).map(decodeParam);
      const body = req.method === 'GET' ? undefined : await readJsonBody(req, r.maxBody ?? MAX_BODY_BYTES);
      const result = await r.handler(c, { params, query: url.searchParams, body, req, res });
      // Query methods may answer synchronously (HTTP-thread connection) or through a worker.
      if (result !== HANDLED) await sendJson(req, res, 200, result);
      return;
    }
    if (allowed.length) {
      res.setHeader('Allow', allowed.join(', '));
      throw new HttpError(405, 'method-not-allowed', `${req.method} is not allowed on ${path}`);
    }
    throw new HttpError(404, 'not-found', `No API route ${path}`);
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err as Error);
      return;
    }
    const { status, body } = errorBody(err);
    // 501 (a route this build does not serve yet) and 503 (timeout, shutdown) are answers, not server faults.
    if (status >= 500 && status !== 501 && status !== 503) console.error(`agentshark: ${req.method} ${url.pathname} failed:`, err);
    await sendJson(req, res, status, body);
  }
}

/** Map any thrown value to an HTTP status and the `{error:{message,code}}` body. */
function errorBody(err: unknown): { status: number; body: { error: Record<string, unknown> } } {
  const e = err as { message?: unknown; status?: unknown; code?: unknown; start?: unknown; end?: unknown; details?: unknown };
  const message = typeof e?.message === 'string' ? e.message : String(err);
  // HttpError and QueryError (src/index/queries.ts) carry their own status, code and details, e.g. 404 view-not-found,
  // 404 view_expired, 400 color_rule with ruleId, start and end, 503 query-timeout.
  if (typeof e?.status === 'number' && e.status >= 400 && e.status < 600) {
    const details = e.details && typeof e.details === 'object' ? e.details : {};
    return { status: e.status, body: { error: { message, code: typeof e.code === 'string' ? e.code : 'error', ...details } } };
  }
  // FilterError (src/filter/compile.ts) is recognized by shape so this module does not depend on the compiler.
  if (typeof e?.start === 'number' && typeof e?.end === 'number') {
    return { status: 400, body: { error: { message, code: 'filter', start: e.start, end: e.end } } };
  }
  return { status: 500, body: { error: { message, code: 'internal' } } };
}

export async function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): Promise<void> {
  await sendBody(req, res, status, Buffer.from(JSON.stringify(body) ?? 'null'), 'application/json; charset=utf-8');
}

async function sendBody(req: IncomingMessage, res: ServerResponse, status: number, data: Buffer, contentType: string): Promise<void> {
  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  if (data.length > GZIP_MIN_BYTES && acceptsGzip(req.headers['accept-encoding'])) {
    // Level 1: the client is on the same machine, so speed matters more than ratio.
    data = await gzipAsync(data, { level: 1 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = data.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

async function serveSideFile(c: ApiContext, { query: q, res }: ApiRequest): Promise<typeof HANDLED> {
  const rawPath = str(q, 'path');
  const blob = str(q, 'blob');
  if (!rawPath && !blob) throw badParam('path', 'a file path or a blob sha256');
  if (blob && !/^[0-9a-f]{64}$/.test(blob)) throw badParam('blob', 'a sha256 hex digest');
  const path = rawPath ? normalize(rawPath) : undefined;
  if (path && (!isAbsolute(path) || isCredentialPath(path))) throw new HttpError(403, 'forbidden', 'This path cannot be served');
  const file = await c.queries.file({ path, blob });
  if (!file) throw new HttpError(404, 'not-found', 'File not found or outside the discovered source roots');
  res.writeHead(200, {
    'Content-Type': file.contentType,
    'Content-Length': file.data.length,
    'Cache-Control': 'no-store',
    // Side files are agent output; a sandboxed response cannot run script in the viewer's origin.
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  });
  res.end(file.data);
  return HANDLED;
}

// ---------------------------------------------------------------------------
// Request parsing

async function readJsonBody(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'too-large', `Request body exceeds ${max >> 20} MiB`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  // Requiring JSON also forces a CORS preflight for any cross-site POST.
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'unsupported-media-type', 'Request bodies must be application/json');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad-json', 'Request body is not valid JSON');
  }
}

function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'bad-request', 'Malformed percent-encoding in the path');
  }
}

function badParam(name: string, expected: string): HttpError {
  return new HttpError(400, 'bad-param', `Parameter '${name}' must be ${expected}`);
}

function str(q: URLSearchParams, name: string): string | undefined {
  return q.get(name) || undefined;
}

function required(q: URLSearchParams, name: string): string {
  const v = str(q, name);
  if (v === undefined) throw new HttpError(400, 'bad-param', `Parameter '${name}' is required`);
  return v;
}

function int(q: URLSearchParams, name: string, min = -Infinity): number | undefined {
  const s = str(q, name);
  if (s === undefined) return undefined;
  const n = /^-?\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n) || n < min) throw badParam(name, min === -Infinity ? 'an integer' : `an integer ≥ ${min}`);
  return n;
}

/**
 * Epoch microseconds, or an ISO date for hand-written URLs. Dates and times without a zone are local time, as in the
 * display filter (one parser for every entry point: src/filter/compile.ts parseTime).
 */
function time(q: URLSearchParams, name: string): number | undefined {
  const s = str(q, name);
  if (s === undefined) return undefined;
  if (/^-?\d+$/.test(s)) return int(q, name);
  const us = parseTime(s);
  if (us === undefined) throw badParam(name, 'a time in µs since the epoch or an ISO date such as 2026-10-11T09:00+08:00');
  return us;
}

function bool(q: URLSearchParams, name: string): boolean | undefined {
  const s = str(q, name);
  if (s === undefined) return undefined;
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  throw badParam(name, '1 or 0');
}

const UNIT_US: Record<string, number> = { us: 1, ms: 1e3, s: 1e6, m: 60e6, min: 60e6, h: 3600e6, d: 86_400e6 };

/** Microseconds; a bare number is µs, and units (`500ms`, `2s`, `1h`) are accepted. */
function duration(q: URLSearchParams, name: string): number | undefined {
  const s = str(q, name);
  if (s === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)(us|ms|s|min|m|h|d)?$/.exec(s);
  if (!m) throw badParam(name, 'a duration in µs or with a unit (ms, s, m, h, d)');
  return Math.round(Number(m[1]) * UNIT_US[m[2] ?? 'us']);
}

/** Comma-separated values, also accepted as a repeated parameter. */
function list(q: URLSearchParams, name: string): string[] | undefined {
  const items = q
    .getAll(name)
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function oneOf<T extends string>(q: URLSearchParams, name: string, allowed: readonly T[]): T | undefined {
  const s = str(q, name);
  if (s === undefined) return undefined;
  if (!allowed.includes(s as T)) throw badParam(name, `one of ${allowed.join(', ')}`);
  return s as T;
}

function listOf<T extends string>(q: URLSearchParams, name: string, allowed: readonly T[]): T[] | undefined {
  const items = list(q, name);
  const bad = items?.find((s) => !allowed.includes(s as T));
  if (bad !== undefined) throw badParam(name, `a list of ${allowed.join(', ')}`);
  return items as T[] | undefined;
}

async function found<T>(value: T | null | Promise<T | null>, what: string): Promise<T> {
  const v = await value;
  if (v === null) throw new HttpError(404, 'not-found', `No such ${what}`);
  return v;
}

/** An integer ≥ 0, cut to `max`: a page size or text length. */
function capped(q: URLSearchParams, name: string, max: number): number | undefined {
  const n = int(q, name, 0);
  return n === undefined ? undefined : Math.min(n, max);
}

// ---------------------------------------------------------------------------
// Derived routes (SPEC §12.5)

function derived(c: ApiContext): ApiDerivedQueries {
  if (!c.derived) throw new HttpError(501, 'not-implemented', 'This server does not serve the analysis routes');
  return c.derived;
}

/**
 * The scope of a derived list: `view=<id>|global` (absent: the whole index), or `session=` with `descendants=`, plus
 * `since=&until=`. A scope is one view or one session, never both, because the response's `scope.kind` names one. An
 * unknown view id is 404 `view_expired`, thrown by the derived queries that resolve it.
 */
function scope(q: URLSearchParams): DerivedScopeQuery {
  const view = str(q, 'view');
  const session = str(q, 'session');
  if (view !== undefined && session !== undefined) throw badParam('session', 'absent when view is given');
  const descendants = bool(q, 'descendants');
  if (descendants !== undefined && session === undefined) throw badParam('descendants', 'given only with session');
  const since = time(q, 'since');
  const until = time(q, 'until');
  if (since !== undefined && until !== undefined && since > until) throw badParam('until', 'at or after since');
  return { view, session, descendants, since, until };
}

function rows(q: URLSearchParams): DerivedRowsQuery {
  return { ...scope(q), limit: capped(q, 'limit', MAX_DERIVED_ROWS), offset: int(q, 'offset', 0) };
}

function lens(q: URLSearchParams): LensQuery {
  return { outputChars: capped(q, 'output_chars', MAX_OUTPUT_CHARS) };
}

function follow(c: ApiContext, q: URLSearchParams, target: FollowTarget) {
  const page = derived(c).follow(target, {
    after: str(q, 'after'),
    limit: capped(q, 'limit', MAX_DERIVED_ROWS),
    outputChars: capped(q, 'output_chars', MAX_OUTPUT_CHARS),
  });
  return found(page, target.kind === 'call' ? 'tool call' : target.kind);
}

// ---------------------------------------------------------------------------
// JSON body validation

function workbench(c: ApiContext, operation: string, body: unknown): unknown {
  if (!validOperation(operation)) throw new HttpError(400, 'workbench-operation', 'Unknown workbench operation');
  if (!c.workbench) throw new HttpError(503, 'workbench-unavailable', 'Analysis is not ready. Wait for indexing and try again.');
  return c.workbench(operation, workbenchInput(body));
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad-request', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** A Partial<AlarmThresholds>: known keys only, each a positive number. */
function alarmThresholds(body: unknown): Partial<AlarmThresholds> {
  const out: Partial<AlarmThresholds> = {};
  for (const [k, v] of Object.entries(bodyObject(body))) {
    if (!(k in ALARM_THRESHOLDS)) throw badParam(k, `one of ${Object.keys(ALARM_THRESHOLDS).join(', ')}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw badParam(k, 'a positive number');
    out[k as keyof AlarmThresholds] = v;
  }
  return out;
}

function bodyString(body: unknown, key: string): string | undefined {
  const v = bodyObject(body)[key];
  if (v == null) return undefined;
  if (typeof v !== 'string') throw badParam(key, 'a string');
  return v;
}

function bodyInt(b: Record<string, unknown>, key: string): number | undefined {
  const v = b[key];
  if (v == null) return undefined;
  if (!Number.isSafeInteger(v)) throw badParam(key, 'an integer');
  return v as number;
}

function bodyBool(b: Record<string, unknown>, key: string): boolean | undefined {
  const v = b[key];
  if (v == null) return undefined;
  if (typeof v !== 'boolean') throw badParam(key, 'true or false');
  return v;
}

function viewSpec(body: unknown): ViewSpec {
  const b = bodyObject(body);
  const spec: ViewSpec = {};
  const filter = bodyString(b, 'filter');
  if (filter !== undefined) spec.filter = filter;
  if (b.sessions != null) {
    if (!Array.isArray(b.sessions) || !b.sessions.every((s) => typeof s === 'string')) throw badParam('sessions', 'an array of session IDs');
    spec.sessions = b.sessions;
  }
  const from = bodyInt(b, 'from');
  const to = bodyInt(b, 'to');
  if (from !== undefined) spec.from = from;
  if (to !== undefined) spec.to = to;
  if (b.sort != null) {
    if (!VIEW_SORTS.includes(b.sort as ViewSort)) throw badParam('sort', `one of ${VIEW_SORTS.join(', ')}`);
    spec.sort = b.sort as ViewSort;
  }
  if (b.order != null) {
    if (b.order !== 'asc' && b.order !== 'desc') throw badParam('order', "'asc' or 'desc'");
    spec.order = b.order;
  }
  if (b.colorRules != null) {
    const rules = b.colorRules;
    const valid = (r: unknown): r is ColorRule => !!r && typeof r === 'object' && typeof (r as ColorRule).id === 'string' &&
      (r as ColorRule).id.length > 0 && typeof (r as ColorRule).filter === 'string';
    if (!Array.isArray(rules) || !rules.every(valid)) throw badParam('colorRules', 'an array of {id, filter} with string values');
    spec.colorRules = rules.map((r) => ({ id: r.id, filter: r.filter }));
  }
  for (const key of ['descendants', 'includeInherited', 'includeDup'] as const) {
    const v = bodyBool(b, key);
    if (v !== undefined) spec[key] = v;
  }
  return spec;
}
