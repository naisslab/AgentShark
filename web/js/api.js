// HTTP and SSE client: one function per route in SPEC §6. The auth token travels in the
// as_token cookie set by the launch URL, so requests only need same-origin credentials.

const enc = encodeURIComponent;

function query(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    parts.push(`${enc(k)}=${enc(Array.isArray(v) ? v.join(',') : String(v))}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

async function request(method, path, body, { text = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    const err = new Error('Cannot reach the AgentShark server. Is `agentshark serve` still running?');
    err.status = 0;
    err.cause = cause;
    throw err;
  }
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (res.ok && text) return raw;
  if (!res.ok) {
    let message = data?.error?.message ?? `${method} ${path} failed with HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      message = `${message} Open AgentShark through the launch URL printed by \`agentshark serve\`.`;
    }
    const err = new Error(message);
    err.status = res.status;
    err.code = data?.error?.code ?? null;
    err.data = data;
    throw err;
  }
  return data;
}

const get = (path, params) => request('GET', path + query(params));
const getText = (path, params) => request('GET', path + query(params), undefined, { text: true });
const post = (path, body) => request('POST', path, body ?? {});
const put = (path, body) => request('PUT', path, body ?? {});

export const info = () => get('/api/info');
export const fields = () => get('/api/fields');
export const validate = (filter) => post('/api/filter/validate', { filter });

/**
 * Optional server features, detected at runtime: null = not yet known, true/false once seen.
 * The engine adds them in a backward-compatible way (MAC-CONTRACT §3), so an older server
 * simply lacks them and the viewer falls back.
 */
export const features = {
  batchSessions: null, // GET /api/sessions?ids=
  sort: null, // POST /api/views sort beyond ts|seq, and order
  colorRules: null, // rows carry colorRule
  columns: null, // rows carry extra
  find: null, // GET /api/views/:id/find
  fieldMap: null, // GET /api/events/:id has fieldMap
  derived: null, // schema-4 analysis routes (SPEC §12.5): known from InfoResult.analysis
  alarmThresholds: null, // PUT /api/settings/alarm-thresholds: known from alarmThresholdsWritable()
};

/** q: { agent, q, from, to, role, state, limit, offset } */
export const sessions = (q) => get('/api/sessions', q);
export const session = (id) => get(`/api/sessions/${enc(id)}`);

/**
 * Session rows for a set of ids, via GET /api/sessions?ids=. An older server ignores `ids` and
 * returns its default list, which the check below detects; the result is then null.
 */
export async function sessionsByIds(ids) {
  if (!ids.length) return [];
  if (features.batchSessions === false) return null;
  const want = new Set(ids);
  // limit is one more than the ids: a server that ignores `ids` returns that many distinct rows of
  // its default list, which cannot all be in `want`.
  const res = await get('/api/sessions', { ids: ids.join(','), limit: ids.length + 1 });
  const rows = res?.sessions ?? [];
  const ok = rows.length <= ids.length && rows.every((s) => want.has(s.id));
  features.batchSessions = ok;
  return ok ? rows : null;
}

/** spec: { filter, sessions, descendants, from, to, sort, order, colorRules, includeInherited, includeDup } */
export const createView = (spec) => post('/api/views', spec);
/** columns: custom column fields; each row then carries `extra: {field: value}` on a current server. */
export const viewRows = (viewId, offset, limit, columns) => get(`/api/views/${enc(viewId)}/rows`, { offset, limit, columns });
/** Next (dir 'next') or previous row number after `from` whose text matches q: {no} or {no: null}. */
export const find = (viewId, q, from, dir) => get(`/api/views/${enc(viewId)}/find`, { q, from, dir });
export const locate = (viewId, eventId) => get(`/api/views/${enc(viewId)}/locate`, { event: eventId });
export const histogram = (viewId, bins, from, to) => get(`/api/views/${enc(viewId)}/histogram`, { bins, from, to });

export const event = (id) => get(`/api/events/${enc(id)}`);
export const raw = (id, maxString) => get(`/api/events/${enc(id)}/raw`, { maxString });

/** q: { sessions: string[], from, to, kinds: string[], minDur, limit } */
export const spans = (q) => get('/api/spans', q);
export const span = (id) => get(`/api/spans/${enc(id)}`);

/** q: { from, to, agent } */
export const overview = (q) => get('/api/overview', q);
export const conversation = (sessionId, after, limit) => get(`/api/conversation/${enc(sessionId)}`, { after, limit });

/** kind: 'summary' | 'kinds' | 'tools' | 'models' | 'io' | 'pairs'; params: { view, interval, metric } */
export const stats = (kind, params) => get(`/api/stats/${enc(kind)}`, params);

/** q: { view (or viewId), session, severity, group, limit } */
export function expert(q = {}) {
  const { viewId, ...rest } = q;
  return get('/api/expert', { view: viewId, ...rest });
}

/** Logging health. In capture mode the captured evidence; `{ local: true }` asks for this machine instead. */
export const sources = (opts = {}) => get('/api/sources', opts.local ? { local: 1 } : undefined);

/** URL for a side file (persisted output, backup, image) or a capture blob. */
export function fileUrl({ path, blob } = {}) {
  return '/api/file' + query({ path, blob });
}

export const reindex = () => post('/api/reindex');

/**
 * Subscribe to /api/stream. onEvent(type, data) receives the server events 'hello',
 * 'index-progress', 'index-done' and 'alarm' (AlarmStreamEvent), plus 'open' and 'error' for connection state.
 * Returns { close() }. EventSource reconnects on its own after errors.
 */
export function stream(onEvent) {
  const es = new EventSource('/api/stream', { withCredentials: true });
  const parse = (e) => {
    try {
      return e.data ? JSON.parse(e.data) : null;
    } catch {
      return null;
    }
  };
  for (const type of ['hello', 'index-progress', 'index-done', 'alarm']) {
    es.addEventListener(type, (e) => onEvent(type, parse(e)));
  }
  es.onopen = () => onEvent('open', null);
  es.onerror = () => onEvent('error', { readyState: es.readyState });
  return { close: () => es.close() };
}

// ---------------------------------------------------------------------------
// Agent-native routes (SPEC §12.5, src/index/api.ts DerivedQueries). Parameter names are snake_case on
// the wire and list values go comma-separated. Every id in a path is percent-encoded: derived ids
// contain '#', ':', '/' and '.'.

const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** A camelCase query object as wire parameters; null, undefined, '' and [] are left out. */
export function wire(q) {
  const out = {};
  for (const [k, v] of Object.entries(q ?? {})) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[snake(k)] = v;
  }
  return out;
}

/** q: {view, session, since, until, tier} */
export const failuresSummary = (q) => get('/api/failures/summary', wire(q));
/** q: QueueQuery {view, group, tier, outcome, family, agent, role, unattended, section, signature, sort, limit, offset} */
export const failuresQueue = (q) => get('/api/failures/queue', wire(q));
export const episode = (id, { outputChars } = {}) => get(`/api/episodes/${enc(id)}`, wire({ outputChars }));
/** format: 'md' | 'brief' | 'json' → {format, text, redactions} */
export const episodeReport = (id, format) => get(`/api/episodes/${enc(id)}/report`, { format });
/** A report for any Lens kind (docs/DESIGN.md §12 engine change): episodes, claims, delegations, signatures. */
const REPORT_ROUTE = { episode: 'episodes', claim: 'claims', delegation: 'delegations', signature: 'signatures' };
export const itemReport = (kind, id, format) => get(`/api/${REPORT_ROUTE[kind] ?? 'episodes'}/${enc(id)}/report`, { format });
export const claim = (turnId, { outputChars } = {}) => get(`/api/claims/${enc(turnId)}`, wire({ outputChars }));
export const delegation = (spanId, { outputChars } = {}) => get(`/api/delegations/${enc(spanId)}`, wire({ outputChars }));
/** q: {view, family, status, tier, sort, limit, offset} */
export const signatures = (q) => get('/api/signatures', wire(q));
export const signature = (id, { splitAt } = {}) => get(`/api/signatures/${enc(id)}`, wire({ splitAt }));
/** q: StepsQuery {view, turn, after, limit, sort, order, descendants, foldClean, onlyFailed, bucket} */
export const sessionSteps = (sessionId, q) => get(`/api/sessions/${enc(sessionId)}/steps`, wire(q));
/** The Run report; format 'md' resolves to Markdown text. */
export function runReport(sessionId, { since, format } = {}) {
  const path = `/api/report/${enc(sessionId)}`;
  return format === 'md' ? getText(path, wire({ since, format })) : get(path, wire({ since }));
}
/** List routes; q: {view | session, descendants, since, until, limit, offset}; alarms also {state, kind}. */
export const delegations = (q) => get('/api/delegations', wire(q));
export const claims = (q) => get('/api/claims', wire(q));
export const interventions = (q) => get('/api/interventions', wire(q));
export const alarms = (q) => get('/api/alarms', wire(q));
export const episodes = (q) => get('/api/episodes', wire(q));
export const processes = (q) => get('/api/processes', wire(q));
/** The Step and Failure layers of the Events detail tree. */
export const eventDerived = (eventId) => get(`/api/events/${enc(eventId)}/derived`);
/** Sidebar glyphs; without ids, every session that has a mark. */
export const sessionMarks = (ids) => get('/api/session-marks', ids?.length ? { ids } : undefined);
export const diff = (eventId, { path, maxLines } = {}) => get(`/api/changes/${enc(eventId)}/diff`, wire({ path, maxLines }));
/** target: {kind:'call', eventId} | {kind:'delegation', spanId} | {kind:'process', id} | {kind:'file', session, path} */
export function follow(target, q = {}) {
  const params = wire(q);
  switch (target?.kind) {
    case 'call': return get(`/api/follow/call/${enc(target.eventId)}`, params);
    case 'delegation': return get(`/api/follow/delegation/${enc(target.spanId)}`, params);
    case 'process': return get(`/api/follow/process/${enc(target.id)}`, params);
    case 'file': return get('/api/follow/file', { ...params, session: target.session, path: target.path });
    default: return Promise.reject(new Error('Nothing to follow'));
  }
}
export const time = ({ session, turn } = {}) => get('/api/time', { session, turn });

/** PUT a partial AlarmThresholds (a server setting); answers the AnalysisStatus with the values in effect. */
export const setAlarmThresholds = (t) => put('/api/settings/alarm-thresholds', t);

/**
 * Whether this server takes threshold changes. The route serves only PUT, so a GET answers 405 with
 * `Allow: PUT`; a server without the route answers 404. The probe changes nothing. A capture still
 * refuses the PUT (409), so callers also check InfoResult.mode.
 */
export async function alarmThresholdsWritable() {
  if (features.alarmThresholds != null) return features.alarmThresholds;
  try {
    const res = await fetch('/api/settings/alarm-thresholds', { credentials: 'same-origin' });
    features.alarmThresholds = res.status === 405 && /\bPUT\b/.test(res.headers.get('Allow') ?? '');
  } catch {
    return false;
  }
  return features.alarmThresholds;
}
export const statsSrt = (view, group) => get('/api/stats/tools', { view, group });
export const statsEndpoints = (view, kind) => get('/api/stats/endpoints', { view, kind });
