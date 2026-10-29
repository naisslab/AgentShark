// Viewer shell: builds the App object (WEB-CONTRACT), the top bar with the display-filter bar and
// the scope chips, the sessions sidebar, the status bar, hash routing, keyboard shortcuts and the
// SSE connection. It owns the one scope and view-state model every workspace reads (SPEC §7.8).
// Workspaces load lazily from views/*.js.

import * as api from './api.js';
import * as fmt from './lib/format.js';
import { createStore, loadPref, savePref } from './state.js';
import { h, clear, debounce, icon, mark, agentDot, showMenu, openDialog, makeSplitter, placeholder, copyText, autoTitle, middleEllipsis } from './lib/dom.js';
import { createColorizer, normalizeRules, compileFilter, serverRules, newRuleId, withTierDefaults, DEFAULT_RULES, FLAG_GLYPHS, EVENT_KINDS, LAYERS, FLAGS, PALETTE } from './lib/colors.js';
import { createVariableList } from './lib/virtual.js';
import { combineFilter, viewStatus, isViewExpired, sameScope, changeAffects, scopeParts } from './lib/scope.js';
import { installKeys, helpSections } from './lib/keys.js';
import {
  IMPACT, ALARM, NEEDS_ATTENTION, attentionStatus, usesDerivedFields, worseImpact, sessionOfDerivedId, followTargets, alarmLine,
  alarmNotification, notifyDecision, ALERT_DEFAULTS,
} from './lib/derived.js';

// Workspace order of SPEC §12.7 (Alt+1–7). The setting "Classic workspace order" keeps Events first for
// one release. Conversation and Flow are now modes of Session; their old routes still open them.
const WORKSPACES = [
  { name: 'failures', label: 'Failures', file: 'failures.js' },
  { name: 'events', label: 'Events', file: 'events.js' },
  { name: 'session', label: 'Session', file: 'session.js' },
  { name: 'timeline', label: 'Timeline', file: 'timeline.js' },
  { name: 'stats', label: 'Statistics', file: 'stats.js' },
  // The route keeps the API name; the UI says Diagnostics (SPEC §7.8 naming).
  { name: 'expert', label: 'Diagnostics', file: 'expert.js' },
  { name: 'sources', label: 'Sources', file: 'sources.js' },
];
const MODE_ROUTES = { conversation: 'transcript', flow: 'flow' };
/** Appearance (the `theme` state key), in the order the top-bar button cycles through. */
const THEMES = [
  { id: 'system', label: 'System', hint: 'follows the OS' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];
const SESSION_MODES = ['steps', 'transcript', 'flow'];

/** Default scope label per workspace (SPEC §7.8 table); workspaces may publish a more precise one. */
const SCOPE_NOTES = {
  failures: 'Failures in the sessions, time range and filter',
  session: 'One session · filter and time range highlight steps',
  timeline: 'Spans: full session context · filter shown as density',
  expert: 'Diagnostics for the current view',
  sources: 'All indexed sources (local machine)',
};

const DEFAULT_FACETS = { tier: ['failure'], outcome: [], family: [], agent: [], role: [], unattended: null, group: 'attention', sort: 'attention', matchFilter: true, signature: null };

/** Stored facets over the defaults; anything malformed falls back. */
function loadFacets() {
  const f = loadPref('failures.facets', null);
  if (!f || typeof f !== 'object') return { ...DEFAULT_FACETS };
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const tier = list(f.tier);
  return {
    ...DEFAULT_FACETS,
    tier: tier.includes('failure') ? tier : ['failure', ...tier],
    outcome: list(f.outcome), family: list(f.family), agent: list(f.agent), role: list(f.role),
    unattended: typeof f.unattended === 'boolean' ? f.unattended : null,
    group: typeof f.group === 'string' ? f.group : 'attention',
    sort: typeof f.sort === 'string' ? f.sort : 'attention',
    matchFilter: f.matchFilter !== false,
  };
}

/** Coloring rules; a list stored before the failure tiers existed gains their rules once (WEB-CONTRACT). */
function loadRules() {
  const stored = loadPref('colorRules', null);
  let rules = normalizeRules(stored);
  if (stored && !loadPref('colorRules.tiers', false)) {
    rules = withTierDefaults(rules);
    savePref('colorRules', rules);
  }
  savePref('colorRules.tiers', true);
  return rules;
}

let classicOrder = loadPref('prefs.classicOrder', false) === true;

/** Workspace names in tab order (Alt+1–7). */
function workspaceOrder() {
  const names = WORKSPACES.map((w) => w.name);
  if (classicOrder) [names[0], names[1]] = [names[1], names[0]];
  return names;
}

const FILTER_PRESETS = [
  { label: 'Errors', filter: 'error' },
  { label: 'Slow shell commands', filter: 'tool.name == "Bash" && dur > 5s' },
  { label: 'Large model outputs', filter: 'llm && tokens.output > 2000' },
  { label: 'Subagent activity', filter: 'agent' },
  { label: 'Context compactions', filter: 'context.compaction' },
  { label: 'MCP tool calls', filter: 'tool.kind == "mcp"' },
  { label: 'Thinking blocks', filter: 'llm.thinking' },
  { label: 'Human prompts', filter: 'user.prompt' },
  { label: 'Failed tool results', filter: 'tool.result && error' },
  { label: 'Results without a call', filter: 'orphan' },
  { label: 'Undecoded records', filter: 'raw.unknown' },
  { label: 'Last two hours', filter: 'ts > -2h' },
];

const DATE_RANGES = [
  { id: '24h', label: '24h', long: 'the last 24 hours', us: 24 * 3600e6 },
  { id: '7d', label: '7d', long: 'the last 7 days', us: 7 * 24 * 3600e6 },
  { id: '30d', label: '30d', long: 'the last 30 days', us: 30 * 24 * 3600e6 },
  { id: 'all', label: 'All', long: null, us: null },
];

const AGENT_BY_PREFIX = { cc: 'claude-code', cw: 'claude-cowork', cx: 'codex', cp: 'copilot', ag: 'antigravity' };

const HISTORY_MAX = 30;
/** While an agent works, index runs finish every few seconds; a view follows them at most this often. */
const LIVE_REFRESH_MS = 15_000;
/** Above this many changed sessions an index run reloads the whole session list. */
const MAX_INCREMENTAL = 200;
const BROWSE_LIMIT = 20_000;
const SEARCH_PAGE = 500;
const DEFAULT_SORT = { key: 'ts', order: 'asc' };

// ---------------------------------------------------------------------------
// Store and App

const state = createStore({
  info: null,
  filter: '',
  scope: { sessions: null, from: null, to: null },
  view: null,
  selectedEvent: null,
  selectedSpan: null,
  workspace: WORKSPACES.some((w) => w.name === loadPref('workspace', null)) ? loadPref('workspace', null) : workspaceOrder()[0],
  timeFormat: loadPref('timeFormat', 'local'),
  theme: loadPref('theme', 'system'),
  showInherited: loadPref('showInherited', false),
  showDup: loadPref('showDup', false),
  indexVersion: 0,
  // Shell extensions beyond the contract keys.
  metaVersion: 0, // bumps whenever the session metadata cache gains or updates rows
  lastChange: { version: 0, sessions: [] }, // sessions touched by the latest index run (null = unknown)
  viewLoading: false,
  viewPending: null, // reason of the view request in flight: 'query' | 'sort' | 'refresh'
  viewError: null,
  selectedDetail: null,
  selectedNo: null,
  colorRules: loadRules(),
  colorize: loadPref('colorize', true),
  density: loadPref('density', 'compact'),
  sort: loadPref('events.sort', DEFAULT_SORT),
  live: false,
  streamState: 'connecting', // connecting | open | closed
  markCount: 0,
  bootError: null,
  wsStatus: {}, // workspace → scope label it published
  wsSelection: {}, // workspace → what is selected in it, in words (Failures: the Lens item; Session: the step)
  // Agent-native keys (WEB-CONTRACT "State keys added").
  sessionMode: loadPref('session.mode', 'steps'),
  lensItem: null,
  failureFacets: loadFacets(),
  timeRef: null,
  lastVisit: loadPref('prefs.lastVisit', null),
  alarms: [],
  // Split at Date of Failures ▸ Group by Signature and of the signature Lens (µs, local midnight).
  signatureSplitAt: null,
  sessionMarks: new Map(),
  analysis: null,
  stepsDescendants: loadPref('steps.descendants', true),
  // Shell extensions: the session Session · Steps shows when the scope covers it, the "Since … (last
  // visit)" chip, and the counts of the status bar.
  sessionFocus: null,
  sinceChip: null,
  attention: null,
  // Need-attention count of the scope Failures shows, when its scope or facets narrow the index; null otherwise.
  failuresAttention: null,
  // Failures' evidence pane shows the selected event (the status bar names the event instead of the Lens item).
  failuresEvidence: false,
});

/** Session metadata, merged from every response that carries session rows. It never shrinks. */
const meta = new Map();

function rememberSessions(rows) {
  let n = 0;
  for (const r of rows ?? []) {
    if (!r?.id) continue;
    const old = meta.get(r.id);
    meta.set(r.id, old ? { ...old, ...r } : r);
    n++;
  }
  if (n) state.set({ metaVersion: state.get('metaVersion') + 1 });
}

let colorizer = createColorizer(state.get('colorRules'));
let rulesById = new Map(state.get('colorRules').map((r) => [r.id, r]));
/** Rule ids the server rejected (400 color_rule); they are left out of later views. */
const brokenRules = new Set();

const app = {
  api,
  state,
  fmt,
  features: api.features,
  colors: {
    /** The coloring rule of a row: the server's verdict when the row carries one, else the client's. */
    ruleFor(row) {
      if (!row || !state.get('colorize')) return null;
      if ('colorRule' in row) return row.colorRule == null ? null : (rulesById.get(row.colorRule) ?? null);
      return colorizer.ruleFor(row);
    },
    get rules() {
      return state.get('colorRules');
    },
    setRules(rules) {
      const clean = normalizeRules(rules);
      colorizer = createColorizer(clean);
      rulesById = new Map(clean.map((r) => [r.id, r]));
      brokenRules.clear();
      savePref('colorRules', clean);
      state.set({ colorRules: clean });
    },
  },
  selectEvent(eventId, { reveal = true } = {}) {
    state.set({ selectedEvent: eventId ?? null });
    if (reveal && state.get('workspace') !== 'events') app.switchWorkspace('events');
  },
  /** Scope views to the session(s) (+descendants). The time range and the filter stay (SPEC §7.8). */
  openSession(sessionId, { workspace } = {}) {
    app.setSessions(sessionId);
    if (workspace) app.switchWorkspace(workspace);
  },
  /** Replace only the session set of the scope. */
  setSessions(ids) {
    const list = ids == null ? null : Array.isArray(ids) ? ids : [ids];
    state.set({ scope: { ...state.get('scope'), sessions: list?.length ? [...new Set(list)] : null } });
    ensureMeta(list ?? []);
  },
  setFilter(expr) {
    filterBar.setText(expr ?? '');
    filterBar.apply();
  },
  /** Combine a predicate with the applied filter (default: narrow with AND) and apply it. */
  narrowFilter(expr, mode = 'and') {
    app.setFilter(combineFilter(state.get('filter'), expr, mode));
  },
  /** Put an expression (optionally combined with the applied filter) in the filter bar without applying it. */
  prepareFilter(expr, mode = 'replace') {
    filterBar.setText(combineFilter(state.get('filter'), expr ?? '', mode));
    filterBar.focus();
  },
  setTimeRange(from, to) {
    state.set({ scope: { ...state.get('scope'), from: from ?? null, to: to ?? null } });
  },
  /** Clear the session set, the time range and the filter together. */
  resetScope() {
    state.set({ scope: { sessions: null, from: null, to: null } });
    if (state.get('filter')) app.setFilter('');
  },
  /** name: a workspace, or the old routes 'conversation' and 'flow' (Session modes); mode: a Session mode. */
  switchWorkspace(name, { mode } = {}) {
    if (MODE_ROUTES[name]) [name, mode] = ['session', MODE_ROUTES[name]];
    if (!WORKSPACES.some((w) => w.name === name)) return;
    const patch = { workspace: name };
    if (name === 'session' && SESSION_MODES.includes(mode)) patch.sessionMode = mode;
    state.set(patch);
  },
  workspaceOrder,
  toast,
  /** SessionRow by id from the metadata cache (null when not loaded yet). */
  sessionById(id) {
    return meta.get(id) ?? null;
  },
  rememberSessions,
  /** {status: 'loading'|'failed'|'ready-empty'|'ready', view, error} of the current view. */
  viewState() {
    const s = { view: state.get('view'), viewLoading: state.get('viewLoading'), viewError: state.get('viewError') };
    return { status: viewStatus(s), view: s.view, error: s.viewError };
  },
  /** Repeat the view request with the same filter and scope. */
  retryView() {
    rebuildView('query');
  },
  /** Handle an error from a view-scoped request; returns true when the view was rebuilt. */
  handleViewError(err) {
    if (!isViewExpired(err)) return false;
    if (Date.now() - lastExpiredRebuild > 5000) {
      lastExpiredRebuild = Date.now();
      rebuildView('refresh');
    }
    return true;
  },
  /** Whether the latest index run changed any of these sessions (or their subagents); null = all sessions. */
  changeAffects(ids) {
    return changeAffects(state.get('lastChange').sessions, ids, (id) => meta.get(id)?.parentId ?? null);
  },
  /** Short text naming the scope, e.g. "filter · 1 session + subagents · 10:02–10:07 +08:00". */
  scopeText() {
    const parts = scopeParts({ scope: state.get('scope'), filter: state.get('filter') }, rangeLabel);
    if (!state.get('scope').sessions?.length) parts.splice(state.get('filter') ? 1 : 0, 0, 'all sessions');
    if (!state.get('filter')) parts.push('no filter');
    return parts.join(' · ');
  },
  /** A workspace publishes its scope label for the status bar. */
  setWorkspaceStatus(name, text) {
    if (state.get('wsStatus')[name] === text) return;
    state.set({ wsStatus: { ...state.get('wsStatus'), [name]: text } });
  },
  /** A workspace names what is selected in it ("episode ep_… · step 27 of 52"), for the status bar; null for nothing. */
  setSelectionText(name, text) {
    if ((state.get('wsSelection')[name] ?? null) === (text ?? null)) return;
    state.set({ wsSelection: { ...state.get('wsSelection'), [name]: text ?? null } });
  },
  /** Sort of the Events view; validated against what the server supports. */
  async setSort(next) {
    const sort = next ?? DEFAULT_SORT;
    if ((sort.key !== 'ts' || sort.order !== 'asc') && api.features.sort == null) await probeSort();
    if (api.features.sort === false && (sort.key !== 'ts' || sort.order !== 'asc')) {
      toast('This AgentShark server can only order events by time, oldest first. Update the server to sort by other columns.', 'warn');
      return false;
    }
    savePref('events.sort', sort);
    state.set({ sort });
    return true;
  },
};

let lastExpiredRebuild = 0;

// ---------------------------------------------------------------------------
// Agent-native navigation (WEB-CONTRACT "App additions"): the Lens frame, Show in Session, failure and
// attention stepping, Copy Report, Follow and the time reference.

/** What the Lens shows, published by views/lens.js: the item and the events its keys act on. */
app.lensContext = null;

/** The `view` parameter of derived routes for the shared scope: 'global' when nothing narrows it. */
function derivedView() {
  const sc = state.get('scope');
  if (!state.get('filter') && !sc.sessions?.length && sc.from == null && sc.to == null) return 'global';
  const vs = app.viewState();
  if (vs.status === 'ready' || vs.status === 'ready-empty') return vs.view.viewId;
  throw new Error(vs.status === 'failed' ? 'The view failed to load; retry it first.' : 'The view is still loading.');
}

function needDerived() {
  if (api.features.derived) return true;
  toast('This AgentShark server predates failure analysis (schema 4); update it to use failures, the Lens and Steps.', 'warn');
  return false;
}

app.openLens = (item, { reveal = true } = {}) => {
  if (!item?.kind || !item.id) return;
  const cur = state.get('lensItem');
  if (cur?.kind !== item.kind || cur?.id !== item.id) state.set({ lensItem: { kind: item.kind, id: item.id } });
  if (reveal) app.switchWorkspace('failures');
};
app.openEpisode = (id, opts) => app.openLens({ kind: 'episode', id }, opts);

/** The queue row u last opened, so the next press moves on from it. */
let lastQueueKey = null;
/** The last queue row opened: the Lens reads figures from it that its own route does not ship (signature episodes). */
app.lastQueueRow = null;

/**
 * Open a queue row in the Lens frame by its kind (QueueRow doc in types.ts). `auto`: a rule chose it, not the user
 * (the entry rule, or Failures filling an empty Lens), so e still starts at the newest failure.
 */
app.openQueueRow = async (row, { reveal = true, auto = false } = {}) => {
  if (!row) return;
  lastQueueKey = `${row.kind}:${row.id}`;
  app.lastQueueRow = row;
  if (row.kind !== 'alarm') app.openLens({ kind: row.kind, id: row.id }, { reveal });
  else {
    let alarm = state.get('alarms').find((a) => a.id === row.id);
    if (!alarm && row.sessionId) alarm = (await api.alarms({ session: row.sessionId }).catch(() => null))?.rows?.find((a) => a.id === row.id);
    if (alarm?.episodeId) app.openLens({ kind: 'episode', id: alarm.episodeId }, { reveal });
    else if (alarm?.delegationId) app.openLens({ kind: 'delegation', id: alarm.delegationId }, { reveal });
    else if (row.sessionId) return app.showSession(row.sessionId, { turnId: row.turnId });
  }
  if (auto) entryLens = state.get('lensItem');
};
/** The Lens item a rule opened (openQueueRow `auto`), until the user picks another. */
app.autoLensItem = () => entryLens;

/** Session · Steps at a session, optionally a step or turn. The scope keeps its sessions when they cover it. */
app.showSession = (sessionId, { stepId = null, turnId = null, eventId = null } = {}) => {
  if (!sessionId) return;
  const ids = state.get('scope').sessions ?? [];
  const covers = (id) => {
    for (let cur = id, d = 0; cur && d < 12; d++, cur = meta.get(cur)?.parentId ?? null) if (ids.includes(cur)) return true;
    return false;
  };
  if (ids.length && !covers(sessionId)) app.setSessions(sessionId);
  ensureMeta([sessionId]);
  state.set({ sessionFocus: { session: sessionId, stepId, turnId, eventId } });
  app.switchWorkspace('session', { mode: 'steps' });
};

/** The event keys act on: the Lens attempt or the evidence pane in Failures, else the selected event. */
function actionEvent() {
  if (state.get('workspace') === 'failures') return app.lensContext?.focusedEvent ?? state.get('selectedEvent') ?? app.lensContext?.eventId ?? null;
  return state.get('selectedEvent');
}

/** Shift+Enter: Session · Steps with the event's step selected. */
app.showInSession = async (eventId = actionEvent()) => {
  if (!eventId) return toast('Select an event or a failure first.', 'info');
  let d = null;
  if (api.features.derived) d = await api.eventDerived(eventId).catch(() => null);
  const step = d?.step ?? null;
  const session = sessionOfDerivedId(step?.id) ?? (await api.event(eventId).catch(() => null))?.event?.session ?? null;
  if (!session) return toast('This event is no longer in the index.', 'warn');
  app.showSession(session, { stepId: step?.id ?? null, turnId: step?.turnId ?? null, eventId });
};

app.showFilterInEvents = (filter, eventId = null) => {
  app.setFilter(filter);
  if (eventId) state.set({ selectedEvent: eventId });
  app.switchWorkspace('events');
};
app.showEpisodeInEvents = (id, eventId) => app.showFilterInEvents(`episode == ${JSON.stringify(id)}`, eventId);
app.showSignatureEpisodes = (sigId) => {
  state.set({ failureFacets: { ...state.get('failureFacets'), group: 'episode', signature: sigId } });
  app.switchWorkspace('failures');
};

/** s: the signature of the Lens episode, or of the selected event's failure. */
app.showSignature = async () => {
  if (!needDerived()) return;
  let sig = state.get('workspace') === 'failures' ? app.lensContext?.signatureId : null;
  const ev = state.get('selectedEvent');
  if (!sig && ev) sig = (await api.eventDerived(ev).catch(() => null))?.failure?.signatureId ?? null;
  sig ??= app.lensContext?.signatureId ?? null;
  if (!sig) return toast('Select a failure first; s shows its signature.', 'info');
  app.openLens({ kind: 'signature', id: sig });
};

/**
 * F6 and Shift+F6 (§10.1): the next or previous pane in reading order: the top bar, the scope bar, the sidebar, the
 * active workspace's panes (elements marked data-f6), then the status bar.
 */
app.focusPane = (dir) => {
  const ws = document.querySelector(`.workspace[data-ws="${state.get('workspace')}"]`);
  const regions = [
    document.querySelector('.topbar-row:not(.toolbar)'),
    document.querySelector('.topbar-row.toolbar'),
    document.querySelector('.side-list'),
    ...(ws ? ws.querySelectorAll('[data-f6]') : []),
    document.querySelector('.statusbar'),
  ].filter((el) => el && el.offsetParent !== null);
  if (!regions.length) return;
  const at = regions.findIndex((r) => r.contains(document.activeElement));
  const next = regions[(at + dir + regions.length) % regions.length];
  const target = next.matches('[tabindex], input, button') ? next : next.querySelector('[tabindex="0"], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])') ?? next;
  if (!target.hasAttribute('tabindex') && !target.matches('button, input, a, select, textarea')) target.tabIndex = -1;
  target.focus();
};

/** c: Copy Report of the Lens item (any kind, §7.7), or of the selected event's episode. */
app.copyReport = async (episodeId) => {
  if (!needDerived()) return;
  const lensItem = state.get('workspace') === 'failures' ? state.get('lensItem') : null;
  if (!episodeId && lensItem && lensItem.kind !== 'session' && !state.get('failuresEvidence')) {
    const { openCopyReport } = await import('./views/lens.js');
    return openCopyReport(app, lensItem.id, lensItem.kind);
  }
  let id = episodeId ?? null;
  const ev = state.get('selectedEvent');
  if (!id && ev) id = (await api.eventDerived(ev).catch(() => null))?.failure?.episodeId ?? null;
  if (!id && state.get('lensItem')?.kind === 'episode') id = state.get('lensItem').id;
  if (!id) return toast('Select a failure first; c copies its report.', 'info');
  const { openCopyReport } = await import('./views/lens.js');
  openCopyReport(app, id);
};

/**
 * The Follow streams one event belongs to (its call, delegation, process and the files it touched) and
 * the one that fits it best (lib/derived.js followTargets).
 */
app.followTargets = async (eventId) => {
  const derivedOf = (id) => (api.features.derived && id ? api.eventDerived(id).catch(() => null) : null);
  const [own, detail] = await Promise.all([derivedOf(eventId), api.event(eventId).catch(() => null)]);
  // A call and its result share their streams: the change, process or delegation may sit on either one.
  const kind = detail?.event?.kind;
  const partner = (detail?.related ?? []).find((r) => r.kind === (kind === 'tool.call' ? 'tool.result' : kind === 'tool.result' ? 'tool.call' : ''));
  const other = await derivedOf(partner?.id);
  const derived = own || other ? {
    ...own,
    process: own?.process ?? other?.process ?? null,
    delegation: own?.delegation ?? other?.delegation ?? null,
    changes: [...(own?.changes ?? []), ...(other?.changes ?? [])],
  } : null;
  return followTargets({ eventId, event: detail?.event ?? null, related: detail?.related ?? [], derived });
};

/**
 * f: Follow the stream that fits the selection: the Lens delegation, else the selected event's best stream.
 * `targets` (followTargets) become the panel's tabs; a call target finds its own.
 */
app.openFollow = async (target, { targets = null } = {}) => {
  if (!target) {
    const item = state.get('lensItem');
    if (state.get('workspace') === 'failures' && item?.kind === 'delegation') target = { kind: 'delegation', spanId: item.id };
    else {
      const ev = state.get('workspace') === 'failures' ? app.lensContext?.callEventId ?? actionEvent() : actionEvent();
      if (ev) {
        const r = await app.followTargets(ev);
        targets = r.targets;
        target = r.targets[r.preferred];
      }
    }
  } else if (target.kind === 'call' && !targets) {
    // A call target still lists the call's process, delegation and files as tabs.
    const r = await app.followTargets(target.eventId);
    targets = r.targets.some((t) => t.kind === 'call') ? r.targets : [target, ...r.targets];
  }
  if (!target) return toast('Select a call first; f follows it.', 'info');
  const { openFollow } = await import('./views/follow.js');
  openFollow(app, target, { targets });
};

/** t: set the time reference at the selection, or clear it. ts: µs, null to clear. */
app.setTimeReference = (ts) => {
  if (ts === undefined) {
    if (state.get('timeRef') != null) return state.set({ timeRef: null });
    const ws = mounted.get(state.get('workspace'))?.instance;
    ts = ws?.selectionTs?.() ?? (state.get('workspace') === 'failures' ? app.lensContext?.ts : null) ?? state.get('selectedDetail')?.event?.ts ?? null;
    if (ts == null) return toast('Select an event or a step first; t sets the time reference there.', 'info');
  }
  state.set({ timeRef: ts });
};

let failureList = { key: null, rows: null };

/** e / E: the next (older) or previous (newer) failure episode in scope; with nothing selected, the newest. */
app.nextFailure = async (dir = 1) => {
  if (!needDerived()) return;
  const view = derivedView();
  const tiers = state.get('failureFacets').tier;
  const key = JSON.stringify([view, tiers, state.get('indexVersion')]);
  if (failureList.key !== key) {
    const res = await api.episodes({ view, limit: 5000 });
    failureList = { key, rows: (res?.rows ?? []).filter((r) => tiers.includes(r.tier)).sort((a, b) => b.endTs - a.endTs) };
  }
  const rows = failureList.rows;
  if (!rows.length) return toast('No failures in this scope.', 'info');
  const { at, ts } = await failureCursor(rows);
  // From a selected failure, the next one; from another selected event, the nearest one in that direction
  // (rows run newest first); with nothing selected, the newest (SPEC §12.7).
  const next = at >= 0 ? at + dir
    : ts == null ? 0
    : dir > 0 ? rows.findIndex((r) => r.endTs < ts) : rows.findLastIndex((r) => r.endTs > ts);
  if (at < 0 && ts != null && next < 0) return toast(dir > 0 ? 'No older failure in scope.' : 'No newer failure in scope.', 'info');
  if (next < 0 || next >= rows.length) return toast(next < 0 ? 'This is the newest failure in scope.' : 'This is the oldest failure in scope.', 'info');
  const ep = rows[next];
  const ws = state.get('workspace');
  app.openLens({ kind: 'episode', id: ep.id }, { reveal: ws !== 'events' && ws !== 'session' });
  // The selection moves with it, so the next e / E continues from this episode.
  if (ws === 'events' || ws === 'session') app.selectEvent(ep.lastEventId, { reveal: false });
  if (ws === 'session') app.showInSession(ep.lastEventId);
};

/**
 * Where e / E start in `rows`: in Failures, the Lens episode; elsewhere the selected event, by the episode
 * it belongs to (`at`) or else its time (`ts`). The Lens item of an earlier visit to Failures does not count.
 */
async function failureCursor(rows) {
  if (state.get('workspace') === 'failures') {
    const cur = state.get('lensItem');
    // The item the entry rule opened was not the user's pick: from it, e still starts at the newest.
    if (cur === entryLens) return { at: -1, ts: null };
    return { at: cur?.kind === 'episode' ? rows.findIndex((r) => r.id === cur.id) : -1, ts: null };
  }
  const ev = state.get('selectedEvent');
  if (!ev) return { at: -1, ts: null };
  let at = rows.findIndex((r) => r.lastEventId === ev || r.openerEventId === ev);
  if (at < 0) {
    const ep = (await api.eventDerived(ev).catch(() => null))?.failure?.episodeId;
    if (ep) at = rows.findIndex((r) => r.id === ep);
  }
  const det = state.get('selectedDetail');
  return { at, ts: det?.event?.id === ev ? det.event.ts : null };
}

/** u: the next item of the attention sections, in queue order. */
app.nextAttention = async () => {
  if (!needDerived()) return;
  const res = await api.failuresQueue({ view: derivedView(), group: 'attention', tier: state.get('failureFacets').tier, limit: 200 });
  const rows = (res?.rows ?? []).filter((r) => NEEDS_ATTENTION.includes(r.section));
  if (!rows.length) return toast('Nothing needs attention in this scope.', 'ok');
  const at = rows.findIndex((r) => `${r.kind}:${r.id}` === lastQueueKey);
  app.openQueueRow(rows[(at + 1) % rows.length], { reveal: true });
};

/** Time-range label used by chips and scope descriptions. */
/** A time range for a scope token: "Oct 12 17:48 → 18:20" (the second date only when it differs). */
/** A time in a scope token always names its day ("Oct 13 07:19", §7.2), so the token reads the same tomorrow. */
const tokenTime = (ts) => `${fmt.formatShortDate(ts)} ${fmt.formatClock(ts, { digits: 0, date: false }).slice(0, 5)}`;

function rangeLabel(from, to) {
  if (from == null) return `until ${tokenTime(to)}`;
  if (to == null) return `since ${tokenTime(from)}`;
  const b = fmt.sameDay(from, to) ? fmt.formatClock(to, { digits: 0, date: false }).slice(0, 5) : tokenTime(to);
  return `${tokenTime(from)} → ${b}`;
}

/** Fetch metadata for ids the cache does not have yet (chip titles, pinned rows). */
const pendingMeta = new Set();
async function ensureMeta(ids) {
  const missing = ids.filter((id) => !meta.has(id) && !pendingMeta.has(id));
  if (!missing.length) return;
  for (const id of missing) pendingMeta.add(id);
  try {
    const rows = await api.sessionsByIds(missing).catch(() => null);
    if (rows) rememberSessions(rows);
    else {
      const details = await Promise.all(missing.slice(0, 20).map((id) => api.session(id).catch(() => null)));
      rememberSessions(details.map((d) => d?.session).filter(Boolean));
    }
  } finally {
    for (const id of missing) pendingMeta.delete(id);
  }
}

/** One-off check whether the server sorts beyond time order (MAC-CONTRACT §3.2). */
async function probeSort() {
  try {
    await api.createView({ filter: 'kind == "agentshark.probe"', sort: 'dur', order: 'desc' });
    api.features.sort = true;
  } catch (err) {
    api.features.sort = err.status === 400 ? false : null;
  }
}

// ---------------------------------------------------------------------------
// Theme and density

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  const t = state.get('theme');
  return t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t;
}

function applyTheme() {
  const t = state.get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  window.dispatchEvent(new CustomEvent('agentshark:theme', { detail: { theme: t, effective: effectiveTheme() } }));
}

function applyDensity() {
  document.documentElement.dataset.density = state.get('density') === 'comfortable' ? 'comfortable' : 'compact';
  // Canvas views read font tokens at draw time; the theme event makes them redraw.
  window.dispatchEvent(new CustomEvent('agentshark:theme', { detail: { theme: state.get('theme'), effective: effectiveTheme() } }));
}

darkQuery.addEventListener('change', () => {
  if (state.get('theme') === 'system') applyTheme();
});

// ---------------------------------------------------------------------------
// Toasts

const toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' });

/** action: optional { label, onClick } shown as a button in the toast. */
function toast(message, kind = 'info', action = null) {
  const el = h('div', { class: ['toast', `toast-${kind}`], role: kind === 'error' ? 'alert' : 'status' }, h('span', null, String(message)),
    action ? h('button', { class: 'link-btn toast-action', type: 'button', onClick: () => action.onClick() }, action.label) : null);
  const remove = () => el.remove();
  el.addEventListener('click', remove);
  toastHost.append(el);
  while (toastHost.children.length > 4) toastHost.firstChild.remove();
  setTimeout(remove, kind === 'error' ? 8000 : 4500);
}

// ---------------------------------------------------------------------------
// Display filter bar

function createFilterBar() {
  const input = h('input', {
    class: 'filter-input',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'Apply a display filter …  e.g. tool.name == "Bash" && dur > 5s',
    'aria-label': 'Display filter',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
    'aria-controls': 'filter-ac',
    'aria-expanded': 'false',
  });
  const underline = h('div', { class: 'filter-underline', hidden: true });
  const errorTip = h('div', { class: 'filter-tip', role: 'alert', hidden: true });
  const clearBtn = h('button', { class: 'icon-btn filter-clear', title: 'Clear the filter', 'aria-label': 'Clear the filter' }, icon('close', 12));
  const wrap = h('div', { class: 'filter-wrap' }, h('span', { class: 'filter-icon' }, icon('filter', 13)), input, underline, clearBtn, errorTip);
  const menuBtn = h('button', { class: 'tool-btn filters-btn', title: 'Example, saved and recent filters', 'aria-haspopup': 'menu' }, 'Filters', icon('down', 11));
  const applyBtn = h('button', { class: 'btn apply-btn', title: 'Apply the filter (Enter)' }, 'Apply');
  const acList = h('div', { class: 'ac-list', role: 'listbox', id: 'filter-ac', 'aria-label': 'Filter suggestions', hidden: true });
  document.body.append(acList);

  let check = null; // last validation result for input.value
  let checkSeq = 0;
  let fieldItems = null;
  let fieldsLoading = null;
  let ac = { items: [], active: -1, token: null };
  const measure = document.createElement('canvas').getContext('2d');

  function setStatus() {
    const text = input.value.trim();
    wrap.classList.toggle('is-valid', !!text && check?.ok === true && !check.warning);
    wrap.classList.toggle('is-warning', !!text && check?.ok === true && !!check.warning);
    wrap.classList.toggle('is-invalid', !!text && check?.ok === false);
    wrap.classList.toggle('is-dirty', input.value.trim() !== state.get('filter'));
    input.setAttribute('aria-invalid', String(!!text && check?.ok === false));
    clearBtn.hidden = !input.value;
    const msg = check?.ok === false ? check.error?.message : check?.warning;
    errorTip.textContent = msg ?? '';
    errorTip.hidden = !text || !msg;
    errorTip.classList.toggle('warn', check?.ok === true);
    input.title = msg ?? '';
    positionUnderline();
  }

  function textWidth(s) {
    const cs = getComputedStyle(input);
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return measure.measureText(s).width;
  }

  function positionUnderline() {
    const err = check?.ok === false ? check.error : null;
    if (!err || !input.value.trim()) {
      underline.hidden = true;
      return;
    }
    const text = input.value;
    const start = Math.max(0, Math.min(err.start ?? 0, text.length));
    const end = Math.max(start, Math.min(err.end ?? start + 1, text.length));
    const padLeft = parseFloat(getComputedStyle(input).paddingLeft) || 0;
    const x0 = input.offsetLeft + padLeft + textWidth(text.slice(0, start)) - input.scrollLeft;
    const w = Math.max(7, textWidth(text.slice(start, end)));
    underline.style.left = `${x0}px`;
    underline.style.width = `${w}px`;
    underline.hidden = false;
  }

  /** Validate on the server; when it is unreachable, fall back to the local parser. */
  async function validateNow(text) {
    const seq = ++checkSeq;
    let result;
    if (!text.trim()) {
      result = { ok: true };
    } else {
      try {
        result = await api.validate(text);
      } catch {
        try {
          compileFilter(text);
          result = { ok: true };
        } catch (err) {
          result = { ok: false, error: { message: err.message, start: err.start ?? 0, end: err.end ?? text.length } };
        }
      }
    }
    if (seq === checkSeq && text === input.value) {
      check = result;
      setStatus();
    }
    return result;
  }
  const validateSoon = debounce(() => validateNow(input.value), 220);

  async function apply() {
    const text = input.value.trim();
    closeAc();
    if (text) {
      const res = await validateNow(input.value);
      if (!res.ok) {
        input.focus();
        toast(`Filter error: ${res.error?.message ?? 'invalid filter'}`, 'error');
        return;
      }
      pushHistory(text);
    }
    state.set({ filter: text });
    setStatus();
  }

  function setText(text) {
    input.value = text;
    check = null;
    setStatus();
    if (text) validateNow(text);
  }

  // Filters menu: examples, saved and recent ----------------------------------

  function pushHistory(text) {
    const list = loadPref('filterHistory', []).filter((f) => f !== text);
    list.unshift(text);
    savePref('filterHistory', list.slice(0, HISTORY_MAX));
  }

  function choose(text) {
    setText(text);
    apply();
  }

  menuBtn.addEventListener('click', () => {
    const saved = loadPref('filterBookmarks', []);
    const recent = loadPref('filterHistory', []).slice(0, 8);
    const current = input.value.trim();
    showMenu(
      menuBtn,
      [
        { header: 'Examples' },
        ...FILTER_PRESETS.map((p) => ({ label: p.label, hint: p.filter, onSelect: () => choose(p.filter) })),
        { header: 'Saved' },
        ...(saved.length ? saved.map((b) => ({ label: b.name, hint: b.filter, onSelect: () => choose(b.filter) })) : [{ label: 'No saved filters yet', disabled: true }]),
        { label: 'Save this filter…', disabled: !current, onSelect: () => saveBookmark(current) },
        { label: 'Manage saved filters…', disabled: !saved.length, onSelect: manageBookmarks },
        { header: 'Recent' },
        ...(recent.length ? recent.map((f) => ({ label: f, onSelect: () => choose(f) })) : [{ label: 'No recent filters', disabled: true }]),
        recent.length ? { label: 'Clear recent filters', onSelect: () => savePref('filterHistory', []) } : null,
        { separator: true },
        { label: 'Filter reference…', onSelect: showFilterReference },
      ].filter(Boolean),
      { minWidth: 380 },
    );
  });

  function saveBookmark(filter) {
    const name = h('input', { class: 'text-input', type: 'text', value: filter, 'aria-label': 'Name of the saved filter' });
    const dlg = openDialog({
      title: 'Save filter',
      body: [h('label', { class: 'field' }, h('span', null, 'Name'), name), h('div', { class: 'field-note mono' }, filter)],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            const saved = loadPref('filterBookmarks', []).filter((b) => b.filter !== filter);
            saved.push({ name: name.value.trim() || filter, filter });
            savePref('filterBookmarks', saved);
            toast('Filter saved', 'ok');
          },
        },
      ],
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dlg.el.querySelector('.btn.primary')?.click();
    });
    name.select();
  }

  function manageBookmarks() {
    const body = h('div', { class: 'bm-list' });
    const render = () => {
      clear(body);
      const saved = loadPref('filterBookmarks', []);
      if (!saved.length) body.append(placeholder('empty', 'No saved filters'));
      saved.forEach((b, i) => {
        body.append(
          h(
            'div',
            { class: 'bm-row' },
            h('div', { class: 'bm-name' }, b.name),
            h('div', { class: 'bm-filter mono' }, b.filter),
            h(
              'button',
              {
                class: 'icon-btn',
                title: 'Delete',
                'aria-label': `Delete ${b.name}`,
                onClick: () => {
                  saved.splice(i, 1);
                  savePref('filterBookmarks', saved);
                  render();
                },
              },
              icon('trash'),
            ),
          ),
        );
      });
    };
    render();
    openDialog({ title: 'Saved filters', body });
  }

  // Autocomplete (ARIA combobox) ----------------------------------------------

  /** Loads the completion list once; resolves after the server's field registry is merged in. */
  function ensureFields() {
    fieldsLoading ??= (async () => {
      const statics = [
        ...LAYERS.map((l) => ({ name: l, type: 'layer', description: `Every ${l}.* event` })),
        ...FLAGS.map((f) => ({ name: f, type: 'flag', description: `Events flagged ${f}` })),
        ...Object.entries(EVENT_KINDS).map(([k, d]) => ({ name: k, type: 'kind', description: d })),
      ];
      fieldItems = statics;
      try {
        const list = await loadFields();
        if (Array.isArray(list)) {
          const seen = new Set(list.map((f) => f.name));
          fieldItems = [...list, ...statics.filter((s) => !seen.has(s.name))];
        }
      } catch {
        // Field names from the server are optional; the static list still completes layers and kinds.
      }
    })();
    return fieldsLoading;
  }

  function tokenAt() {
    const text = input.value;
    const caret = input.selectionStart ?? text.length;
    let s = caret;
    while (s > 0 && /[\w.\-$]/.test(text[s - 1])) s--;
    let e = caret;
    while (e < text.length && /[\w.\-$]/.test(text[e])) e++;
    return { s, e, word: text.slice(s, caret), before: text.slice(0, s) };
  }

  function suggest(force = false) {
    if (!fieldItems || document.activeElement !== input) return closeAc();
    const tok = tokenAt();
    const valueCtx = /([A-Za-z_][\w.]*)\s*(?:==|!=|\beq\b|\bne\b)\s*("?)$/.exec(tok.before);
    let items = [];
    if (valueCtx) {
      const field = fieldItems.find((f) => f.name === valueCtx[1]);
      if (field?.values?.length) {
        const w = tok.word.toLowerCase();
        items = field.values
          .filter((v) => String(v).toLowerCase().includes(w))
          .map((v) => ({ name: String(v), type: field.name, description: '', value: true, quoted: valueCtx[2] === '"' }));
      }
    } else if (tok.word || force) {
      const w = tok.word.toLowerCase();
      const scored = [];
      for (const f of fieldItems) {
        const n = f.name.toLowerCase();
        const score = n === w ? 0 : n.startsWith(w) ? 1 : w.length > 1 && n.includes(w) ? 2 : -1;
        if (score >= 0) scored.push([score, f]);
      }
      scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].name.localeCompare(b[1].name));
      items = scored.slice(0, 60).map((x) => x[1]);
      if (items.length === 1 && items[0].name === tok.word) items = [];
    }
    if (!items.length) return closeAc();
    ac = { items, active: 0, token: tok };
    renderAc();
  }

  function renderAc() {
    clear(acList);
    ac.items.forEach((it, i) => {
      acList.append(
        h(
          'div',
          {
            class: ['ac-item', i === ac.active && 'active'],
            role: 'option',
            id: `filter-ac-${i}`,
            'aria-selected': String(i === ac.active),
            onMousedown: (e) => {
              e.preventDefault();
              accept(i);
            },
          },
          h('span', { class: 'ac-name' }, it.name),
          h('span', { class: 'ac-type' }, it.value ? 'value' : it.type),
          h('span', { class: 'ac-desc' }, it.description ?? ''),
        ),
      );
    });
    const r = input.getBoundingClientRect();
    const x = r.left + (parseFloat(getComputedStyle(input).paddingLeft) || 0) + textWidth(input.value.slice(0, ac.token.s)) - input.scrollLeft;
    acList.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', `filter-ac-${ac.active}`);
    acList.style.top = `${r.bottom + 4}px`;
    acList.style.left = `${Math.max(8, Math.min(x - 8, innerWidth - acList.offsetWidth - 8))}px`;
    const active = acList.querySelector('.ac-item.active');
    if (active) {
      const a = active.getBoundingClientRect();
      const c = acList.getBoundingClientRect();
      if (a.top < c.top) acList.scrollTop -= c.top - a.top;
      else if (a.bottom > c.bottom) acList.scrollTop += a.bottom - c.bottom;
    }
  }

  function closeAc() {
    ac = { items: [], active: -1, token: null };
    acList.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function accept(i) {
    const it = ac.items[i];
    const tok = ac.token;
    if (!it || !tok) return;
    const text = input.value;
    let insert = it.name;
    let rest = text.slice(tok.e);
    if (it.value && it.quoted) {
      insert = `${it.name}"`;
      rest = rest.replace(/^"/, '');
    } else if (it.value) {
      insert = JSON.stringify(it.name);
    }
    input.value = text.slice(0, tok.s) + insert + rest;
    const caret = tok.s + insert.length;
    input.setSelectionRange(caret, caret);
    closeAc();
    validateSoon();
    setStatus();
  }

  input.addEventListener('focus', () => {
    ensureFields();
    setStatus();
  });
  input.addEventListener('blur', () => setTimeout(closeAc, 100));
  input.addEventListener('input', () => {
    check = null;
    setStatus();
    validateSoon();
    ensureFields().then(() => suggest());
  });
  input.addEventListener('scroll', positionUnderline);
  input.addEventListener('keydown', (e) => {
    const open = !acList.hidden && ac.items.length;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      ac.active = (ac.active + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
      renderAc();
    } else if (open && (e.key === 'Tab' || (e.key === 'Enter' && ac.items[ac.active]?.name !== ac.token.word))) {
      e.preventDefault();
      accept(ac.active);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (open) closeAc();
      else {
        setText(state.get('filter'));
        input.blur();
      }
    } else if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      ensureFields().then(() => suggest(true));
    }
  });
  clearBtn.addEventListener('click', () => {
    setText('');
    apply();
  });
  applyBtn.addEventListener('click', apply);
  window.addEventListener('resize', () => {
    positionUnderline();
    closeAc();
  });

  state.subscribe(['filter'], (s) => {
    if (input.value.trim() !== s.filter) setText(s.filter);
    else setStatus();
  });
  state.subscribe(['viewError'], (s) => {
    const err = s.viewError;
    if (err?.data?.error && typeof err.data.error.start === 'number') {
      check = { ok: false, error: err.data.error };
      setStatus();
    }
  });

  const el = h('div', { class: 'filter-bar' }, menuBtn, wrap, applyBtn);
  setStatus();
  return {
    el,
    apply,
    setText,
    focus() {
      input.focus();
      input.select();
    },
  };
}

let fieldsPromise = null;
function loadFields() {
  fieldsPromise ??= api.fields().catch((err) => {
    fieldsPromise = null;
    throw err;
  });
  return fieldsPromise;
}

// ---------------------------------------------------------------------------
// Coloring rules dialog

function colorPicker(value, onChange) {
  const sel = h('select', { class: 'select', 'aria-label': 'Color' });
  const custom = h('input', { type: 'color', class: 'color-input', title: 'Custom color', 'aria-label': 'Custom color' });
  const options = [{ label: 'None', value: '' }, ...PALETTE];
  for (const o of options) sel.append(h('option', { value: o.value }, o.label));
  // The color input shows the resolved token color, so its swatch matches what rows will show.
  const resolve = (v) => {
    const token = /^var\((--[a-z0-9-]+)\)$/.exec(v ?? '')?.[1];
    const hex = token ? getComputedStyle(document.documentElement).getPropertyValue(token).trim() : v;
    return /^#[0-9a-fA-F]{6}$/.test(hex ?? '') ? hex : getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  };
  const setValue = (v) => {
    if (v && !options.some((o) => o.value === v)) sel.append(h('option', { value: v }, `Custom ${v}`));
    sel.value = v ?? '';
    custom.value = resolve(v);
  };
  setValue(value);
  sel.addEventListener('change', () => {
    custom.value = resolve(sel.value);
    onChange(sel.value || null);
  });
  custom.addEventListener('input', () => {
    setValue(custom.value);
    onChange(custom.value);
  });
  return h('span', { class: 'color-picker' }, sel, custom);
}

function openColoringRules() {
  let rules = app.colors.rules.map((r) => ({ ...r }));
  const body = h('div', { class: 'rules' });
  const checkRule = async (rule, row) => {
    const note = row.querySelector('.rule-note');
    let msg = '';
    let cls = '';
    try {
      const res = await api.validate(rule.filter);
      if (!res.ok) [msg, cls] = [res.error?.message ?? 'Invalid filter', 'err'];
    } catch {
      // Server unreachable: the local parser below still catches syntax errors.
    }
    if (!msg) {
      try {
        const c = compileFilter(rule.filter);
        if (c.unsupported.length && api.features.colorRules === false) {
          [msg, cls] = [`This server colors rows in the browser, which cannot read ${c.unsupported.join(', ')}; the rule will not color rows.`, 'warn'];
        }
      } catch (err) {
        [msg, cls] = [err.message, 'err'];
      }
    }
    note.textContent = msg;
    note.className = `rule-note ${cls}`;
    row.querySelector('.rule-filter').classList.toggle('invalid', cls === 'err');
  };

  const render = () => {
    clear(body);
    body.append(
      h('div', { class: 'rules-head' }, h('span', null, 'On'), h('span', null, 'Name'), h('span', null, 'Filter'), h('span', null, 'Text'), h('span', null, 'Bar and wash'), h('span', null, 'Outline'), h('span', null, '')),
    );
    rules.forEach((rule, i) => {
      const sample = h('span', { class: 'rule-sample' }, 'Sample');
      const paint = () => {
        sample.style.setProperty('--row-tint', rule.bg ?? rule.fg ?? 'transparent');
        sample.classList.toggle('washed', !!rule.bg);
        sample.style.color = rule.fg ?? '';
        sample.style.outline = rule.outline ? `1px ${rule.outlineStyle ?? 'solid'} ${rule.outline}` : '';
      };
      paint();
      const filterInput = h('input', { class: 'text-input mono rule-filter', type: 'text', value: rule.filter, spellcheck: 'false', 'aria-label': 'Rule filter' });
      const row = h(
        'div',
        { class: 'rule-row' },
        h('input', { type: 'checkbox', checked: rule.enabled !== false, 'aria-label': 'Enabled', onChange: (e) => (rule.enabled = e.target.checked) }),
        h('input', { class: 'text-input', type: 'text', value: rule.name, 'aria-label': 'Rule name', onInput: (e) => (rule.name = e.target.value) }),
        filterInput,
        colorPicker(rule.fg, (v) => {
          rule.fg = v;
          paint();
        }),
        colorPicker(rule.bg, (v) => {
          rule.bg = v;
          paint();
        }),
        colorPicker(rule.outline, (v) => {
          rule.outline = v;
          rule.outlineStyle ??= 'solid';
          paint();
        }),
        h(
          'span',
          { class: 'rule-actions' },
          sample,
          h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onClick: () => move(i, -1) }, icon('up')),
          h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: i === rules.length - 1, onClick: () => move(i, 1) }, icon('down')),
          h('button', { class: 'icon-btn', title: 'Delete rule', 'aria-label': 'Delete rule', onClick: () => (rules.splice(i, 1), render()) }, icon('trash')),
        ),
        h('div', { class: 'rule-note' }),
      );
      const checkLater = debounce(() => checkRule(rule, row), 250);
      filterInput.addEventListener('input', () => {
        rule.filter = filterInput.value;
        checkLater();
      });
      body.append(row);
      checkRule(rule, row);
    });
  };
  const move = (i, d) => {
    const [r] = rules.splice(i, 1);
    rules.splice(i + d, 0, r);
    render();
  };
  render();
  openDialog({
    title: 'Coloring rules',
    className: 'dialog-wide',
    body: [
      h('p', { class: 'dialog-note' }, 'Rules apply in order; the first enabled rule whose filter matches an event colors its row. The text color is the main cue; the background color draws the leading bar and a light wash; the outline draws a frame (the failure tiers use it).'),
      body,
    ],
    actions: [
      {
        label: 'Add rule',
        onClick: () => {
          rules.push({ id: newRuleId(new Set(rules.map((r) => r.id))), name: 'New rule', filter: '', fg: null, bg: 'var(--c-llm)', enabled: true });
          render();
          return false;
        },
      },
      {
        label: 'Reset to defaults',
        onClick: () => {
          rules = DEFAULT_RULES.map((r) => ({ ...r }));
          render();
          return false;
        },
      },
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: () => app.colors.setRules(rules.filter((r) => r.filter.trim())) },
    ],
  });
}

// ---------------------------------------------------------------------------
// Help: Getting Started, Filter Reference, Keyboard Shortcuts

function showGettingStarted() {
  const step = (title, text) => h('li', null, h('strong', null, title), ' ', text);
  const term = (name, text) => [h('dt', null, name), h('dd', null, text)];
  openDialog({
    title: 'Getting started',
    className: 'dialog-wide',
    body: h(
      'div',
      { class: 'help' },
      h('ol', { class: 'help-steps' },
        step('Pick what to investigate.', 'Click a session in the sidebar, or stay on All sessions. The search box and date buttons only filter the list; they never change what the workspaces show.'),
        step('Narrow it down.', 'Type a display filter such as error or tool.name == "Bash" && dur > 5s and press Enter. Filters ▾ has examples. The chips next to the filter show the scope; each × removes only that part.'),
        step('Read an event.', 'Click a row in Events. The Detail pane decodes it in layers; the Raw pane shows the original source line, and selecting a field highlights its bytes.'),
        step('Start from failures.', 'Failures lists what needs a human first: alarms, environment blocks, unrecovered work, silent child failures and unverified claims. Select one to read its observed chain in the Lens; e and E step through failures, u through attention items.'),
        step('Change the angle.', 'Session shows one run as turns and steps (and as a transcript or a flow); Timeline, Statistics and Diagnostics show the same investigation in other forms. The status bar says which parts of the scope each one honors.'),
        step('Check your logging.', 'Sources reports what each agent logs on this machine and how to log more.')),
      h('h3', null, 'Glossary'),
      h('dl', { class: 'help-terms' },
        term('Session', 'One run of an agent, such as a Claude Code conversation or a Codex rollout. Subagents are child sessions.'),
        term('Event', 'One decoded record: a prompt, a model output, a tool call or result, and so on.'),
        term('Span', 'An operation with a start and an end, such as a turn, a model call or a tool call.'),
        term('Source', 'A log file AgentShark read, such as a transcript or rollout file.'),
        term('Index', 'The local database AgentShark builds from the sources; the original files are never changed.'),
        term('Capture', 'A portable file with a selection of the index, opened with agentshark open.'),
        term('Scope', 'The sessions, time range and display filter you are investigating.'),
        term('Step', 'One model response with its tool calls and their results.'),
        term('Episode', 'Failures of one target in one turn, from the first failure to the call that recovered it, if any.'),
        term('Signature', 'A failure line with paths, numbers and quoted text replaced by placeholders, so the same error groups across sessions.'),
        term('Provenance', 'How a value was obtained: logged by the agent (no mark), derived ≈, parsed from output ~, or inferred by a versioned rule ?.')),
    ),
  });
}

async function showFilterReference() {
  const list = h('div', { class: 'help-fields' }, placeholder('loading', 'Loading fields…'));
  const search = h('input', { class: 'text-input', type: 'search', placeholder: 'Search fields', 'aria-label': 'Search fields' });
  const syntax = [
    ['error', 'A flag, a layer (tool, llm, …) or a kind (tool.call) alone'],
    ['tool.name == "Bash"', 'Compare: == != > >= < <='],
    ['dur > 5s  ·  tokens.output > 2k', 'Numbers take units: us ms s m h d, k M, KB MB GB'],
    ['ts > -2h  ·  ts > "2026-10-02 14:00"', 'Relative or absolute times (local time unless a zone is given)'],
    ['summary contains "timeout"', 'Substring, case-insensitive; "timeout" alone searches the summary'],
    ['tool.name matches "^mcp__"', 'Regular expression; (?i) makes it case-insensitive'],
    ['kind in {"tool.call", "tool.result"}', 'Set membership'],
    ['a && b  ·  a || b  ·  !a  ·  (a)', 'Combine; also and, or, not'],
  ];
  openDialog({
    title: 'Filter reference',
    className: 'dialog-wide',
    body: h(
      'div',
      { class: 'help' },
      h('table', { class: 'help-syntax' }, h('tbody', null, syntax.map(([code, text]) => h('tr', null, h('td', null, h('code', null, code)), h('td', null, text))))),
      h('div', { class: 'help-fields-head' }, h('h3', null, 'Fields'), search),
      list,
    ),
  });
  let fields = [];
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const rows = fields.filter((f) => !q || f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q));
    list.replaceChildren(
      rows.length
        ? h('table', { class: 'help-field-table' },
          h('thead', null, h('tr', null, h('th', null, 'Field'), h('th', null, 'Type'), h('th', null, 'Description'))),
          h('tbody', null, rows.map((f) => h('tr', null,
            h('td', null, h('code', null, f.name)),
            h('td', null, f.type),
            h('td', null, f.description ?? '', f.values?.length ? h('div', { class: 'help-values' }, f.values.slice(0, 12).join(', ') + (f.values.length > 12 ? ' …' : '')) : null)))))
        : placeholder('empty', 'No field matches'),
    );
  };
  search.addEventListener('input', debounce(render, 100));
  try {
    const res = await loadFields();
    const statics = [
      ...LAYERS.map((l) => ({ name: l, type: 'layer', description: `Every ${l}.* event` })),
      ...FLAGS.map((f) => ({ name: f, type: 'flag', description: `Events flagged ${f}` })),
    ];
    fields = [...(Array.isArray(res) ? res : []), ...statics];
    render();
  } catch (err) {
    list.replaceChildren(placeholder('error', 'Could not load the field list', err.message, { label: 'Retry', onClick: showFilterReference }));
  }
}

function showShortcuts() {
  openDialog({
    title: 'Keyboard shortcuts',
    className: 'dialog-wide',
    body: h('div', { class: 'help' }, helpSections().map((sec) => [
      h('h3', null, sec.title),
      h('table', { class: 'shortcuts' }, h('tbody', null, sec.rows.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d))))),
    ]),
    // Not keys: the letters of the Events gutter, which otherwise only a tooltip names.
    h('h3', null, 'Events: row flags'),
    h('table', { class: 'shortcuts' }, h('tbody', null, FLAG_GLYPHS.map(([, letter, text]) => h('tr', null, h('td', null, h('span', { class: 'flag-letter' }, letter)), h('td', null, text))))),
    h('p', { class: 'dialog-note' }, 'Single keys are inactive while typing in a text field. Esc closes menus, dialogs and the Follow panel, and reverts an unapplied filter.')),
  });
}
app.showShortcuts = showShortcuts;

// ---------------------------------------------------------------------------
// Capture provenance (SPEC §7.8): shown in the status menu and the Sources workspace.

const toUs = fmt.toMicros;

const basename = (p) => String(p ?? '').split(/[\\/]/).pop();

/** Scalar fields of a header object as "key: value" text. */
function describeObject(o) {
  if (o == null || typeof o !== 'object') return o == null ? null : String(o);
  return Object.entries(o)
    .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
}

/** Capture header host: "name (darwin arm64, 27.0.0)". */
function describeHost(host) {
  if (!host || typeof host !== 'object') return host ?? null;
  const sys = [host.platform, host.arch].filter(Boolean).join(' ');
  const extra = [sys, host.osRelease].filter(Boolean).join(', ');
  return `${host.hostname ?? 'unknown host'}${extra ? ` (${extra})` : ''}`;
}

/** Capture header scope: what the export selected and what that resolved to. */
function describeSelection(scope) {
  const parts = [];
  parts.push(scope.agents?.length ? `agents ${scope.agents.join(', ')}` : 'all agents');
  const at = (v) => (typeof v === 'number' ? fmt.formatClock(toUs(v), { digits: 0, offset: true }) : String(v));
  if (scope.since != null || scope.until != null) parts.push(`active ${scope.since != null ? `from ${at(scope.since)}` : ''}${scope.since != null && scope.until != null ? ' ' : ''}${scope.until != null ? `until ${at(scope.until)}` : ''}`);
  else parts.push('any time');
  if (scope.sessions?.length) parts.push(`${scope.sessions.length} chosen session${scope.sessions.length === 1 ? '' : 's'} with subagents`);
  if (scope.filter) parts.push(`sessions matching ${scope.filter}`);
  const r = scope.resolved;
  if (r && typeof r === 'object') parts.push(`→ ${fmt.formatInt(r.sessions ?? 0)} sessions from ${fmt.formatInt(r.sources ?? 0)} source files`);
  return parts.join(' · ');
}

/**
 * Label/value pairs describing the open capture (InfoResult.capture): origin, selection, options,
 * stream completeness and evidence coverage. Older servers only report the file path.
 */
function captureFacts(info) {
  const c = info?.capture ?? null;
  const header = c?.header ?? {};
  const facts = [];
  const add = (k, v, warn = false) => {
    if (v != null && v !== '') facts.push([k, String(v), warn]);
  };
  add('File', c?.path ?? info?.capturePath);
  const created = toUs(c?.createdAt ?? header.created ?? header.createdAt);
  add('Created', created ? fmt.formatClock(created, { digits: 0, offset: true }) : null);
  add('Host', describeHost(header.host ?? header.hostname));
  const tool = header.tool ?? header.writer;
  add('Written by', tool && typeof tool === 'object' ? [tool.name, tool.version].filter(Boolean).join(' ') : tool);
  add('Integrity', c?.integrity?.status ?? 'unverified', c?.integrity?.status !== 'verified');
  if (c?.integrity?.errors?.length) add('Integrity errors', c.integrity.errors.join('; '), true);
  add('Analysis', c?.analysis?.mode ? `${c.analysis.mode} settings` : 'legacy settings');
  if (header.privacy) add('Privacy', 'Structural export: original text, paths and raw evidence are omitted or pseudonymized', true);
  if (header.format != null || header.version != null) add('Format', [header.format, header.version != null ? `version ${header.version}` : null].filter(Boolean).join(', '));
  add('Selection', header.scope ? describeSelection(header.scope) : null);
  const opts = header.options;
  if (opts && typeof opts === 'object') {
    add('Options', [
      opts.raw === false ? 'raw source lines left out (--no-raw)' : opts.raw === true ? 'raw source lines included' : null,
      opts.sidecars === false ? 'side files left out (--no-sidecars)' : opts.sidecars === true ? 'side files included' : null,
    ].filter(Boolean).join(' · ') || describeObject(opts));
  }
  const loaded = toUs(c?.loadedAt);
  add('Opened here', loaded ? fmt.formatClock(loaded, { digits: 0, offset: true }) : null);
  const complete = c ? c.complete : null;
  if (complete != null) add('Stream', complete ? 'complete: the export finished' : 'TRUNCATED: the export did not finish; later records are missing', !complete);
  const cov = c?.coverage;
  if (cov) {
    if (cov.known === false) {
      add('Coverage', complete === false
        ? 'lost with the missing end record: missing evidence is unknown, not zero'
        : 'not recorded by this older capture: missing evidence is unknown, not zero', true);
    }
    else {
      if (cov.rawOmitted) add('Raw source lines', header.privacy ? 'omitted by the shareable profile' : 'omitted on purpose (--no-raw); normalized text and metadata are still included');
      const bySource = Object.entries(cov.rawUnavailableBySource ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 3)
        .map(([src, n]) => `${basename(src)} ${fmt.formatInt(n)}`).join(', ');
      add('Raw lines unavailable', cov.rawUnavailable ? `${fmt.formatInt(cov.rawUnavailable)} (source file deleted or changed before export)${bySource ? `: ${bySource}` : ''}` : 'none', !!cov.rawUnavailable);
      const omitted = cov.sidecarsOmitted ?? [];
      if (omitted.length) {
        const reasons = new Map();
        for (const o of omitted) reasons.set(o.reason, (reasons.get(o.reason) ?? 0) + 1);
        add('Side files omitted', `${fmt.formatInt(omitted.length)}: ${[...reasons].map(([r, n]) => `${n} ${r}`).join(', ')}`, true);
      } else add('Side files omitted', 'none');
    }
  }
  return { facts, complete, known: !!c };
}

function showCaptureDetails() {
  const info = state.get('info');
  const { facts, known } = captureFacts(info);
  openDialog({
    title: 'Capture details',
    body: h(
      'div',
      { class: 'help' },
      known ? null : h('p', { class: 'dialog-note' }, 'This server does not report the capture header; only the file name is known.'),
      h('dl', { class: 'help-terms' }, facts.flatMap(([k, v, warn]) => [h('dt', null, k), h('dd', { class: warn ? 'warn' : null }, v)])),
      h('p', { class: 'dialog-note' }, 'A capture holds prompts, model output, tool results, file paths and, unless exported with --no-raw, the original source lines. --no-raw is not redaction: normalized text and metadata remain.'),
    ),
  });
}
app.showCaptureDetails = showCaptureDetails;
app.captureFacts = () => captureFacts(state.get('info'));

// ---------------------------------------------------------------------------
// Live status (SPEC §7.8 "Status is truthful")

function liveStatus() {
  const info = state.get('info');
  const idx = info?.indexing ?? {};
  const lastOk = toUs(info?.lastIndexOkAt ?? idx.lastRunAt);
  const ago = lastOk ? fmt.formatAgo(lastOk) : null;
  if (!info) return state.get('bootError') ? { cls: 'off', label: 'Disconnected', detail: 'The server does not answer.' } : { cls: 'pending', label: 'Connecting', detail: '' };
  if (info.mode === 'capture') {
    const { complete } = captureFacts(info);
    const failed = info.capture?.integrity?.status === 'failed';
    return { cls: complete === false || failed ? 'warn' : 'capture', label: `Capture · ${basename(info.capturePath) || 'file'}${complete === false ? ' · incomplete' : ''}${failed ? ' · integrity failed' : ''}`, detail: failed ? 'Recovered evidence failed integrity checks. Inspect Capture Details before using its findings.' : 'A capture does not change; reopen it to see a newer export.' };
  }
  if (state.get('streamState') === 'closed') return { cls: 'off', label: 'Disconnected', detail: 'The live connection to the server dropped. It reconnects on its own; reload the page if it does not.' };
  if (idx.running && !idx.total) return { cls: 'indexing', label: 'Discovering sources…', detail: '' };
  if (idx.running) {
    // A staged run indexes the newest files first (SPEC §5.1): `since` says how far back history is complete.
    const since = idx.since ? ` · since ${fmt.formatDayTime(idx.since)}` : '';
    const detail = [idx.since ? `Sessions active since ${fmt.stampTitle(idx.since)} are indexed; older history follows.` : '', idx.currentPath ?? ''];
    return { cls: 'indexing', label: `Indexing ${fmt.formatInt(idx.done)}/${fmt.formatInt(idx.total)}${since}`, pct: Math.floor((idx.done / idx.total) * 100), detail: detail.filter(Boolean).join('\n') };
  }
  const watch = info.watch && typeof info.watch === 'object' ? info.watch.enabled : info.watch;
  const failures = info.analysis?.failed?.length ?? 0;
  const failed = (info.lastIndexError ? ` The last index run failed: ${info.lastIndexError}` : '')
    + (failures ? ` Analysis failed for ${failures} session trees; earlier findings are retained and a retry is pending.` : '');
  if (watch === true) {
    const every = info.watch?.intervalMs ? ` (checked every ${fmt.formatDuration(info.watch.intervalMs * 1000)})` : '';
    return { cls: failed ? 'warn' : 'on', label: 'Watching', detail: `Changed log files are indexed automatically${every}.${ago ? ` Last successful index ${ago}.` : ''}${failed}` };
  }
  if (watch === false) return { cls: 'manual', label: 'Connected · manual refresh', detail: `The server does not watch the logs (--no-watch); use Re-index now.${ago ? ` Last successful index ${ago}.` : ''}${failed}` };
  return { cls: 'on', label: 'Connected', detail: ago ? `Last index ${ago}.` : '' };
}

// ---------------------------------------------------------------------------
// Top bar

function appLogo() {
  return h('img', {
    class: 'logo', src: 'assets/app-icon-128.png', width: 22, height: 22,
    alt: '', 'aria-hidden': 'true',
  });
}

function createTopBar() {
  const tabs = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Workspaces' });
  const labelOf = (name) => WORKSPACES.find((w) => w.name === name).label;
  const buildTabs = () => {
    tabs.replaceChildren(...workspaceOrder().map((name, i) =>
      h('button', { class: 'tab', role: 'tab', dataset: { ws: name }, title: `${labelOf(name)} (Alt+${i + 1})`, onClick: () => app.switchWorkspace(name) }, labelOf(name))));
  };
  buildTabs();
  app.rebuildTabs = () => {
    buildTabs();
    renderTabs();
  };
  // Below 1,100 px the tabs become one "Workspace ▾" menu that names the current workspace (§8.6); tabs never hide.
  const wsMenu = h('button', { class: 'tool-btn ws-menu-btn', type: 'button', hidden: true, 'aria-haspopup': 'menu', title: 'Workspaces (Alt+1 to Alt+7)' });
  wsMenu.addEventListener('click', () =>
    showMenu(wsMenu, workspaceOrder().map((name, i) => ({ label: labelOf(name), hint: `Alt+${i + 1}`, checked: state.get('workspace') === name, onSelect: () => app.switchWorkspace(name) }))),
  );
  const tabsQuery = matchMedia('(max-width: 1099px)');
  const renderTabs = () => {
    for (const t of tabs.children) {
      const active = t.dataset.ws === state.get('workspace');
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
    }
    tabs.hidden = tabsQuery.matches;
    wsMenu.hidden = !tabsQuery.matches;
    wsMenu.replaceChildren(labelOf(state.get('workspace') ?? 'failures'), icon('down', 10));
  };
  tabsQuery.addEventListener('change', renderTabs);
  // The tab strip is one Tab stop; arrows move between tabs (§10.1).
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...tabs.children];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
    next.focus();
    app.switchWorkspace(next.dataset.ws);
  });
  state.subscribe(['workspace'], renderTabs);
  renderTabs();

  const live = h('button', { class: 'live', title: 'Index status' }, h('span', { class: 'live-dot' }), h('span', { class: 'live-label' }, 'Connecting'), h('span', { class: 'live-progress' }, h('span', { class: 'live-bar' })));
  const renderLive = () => {
    const st = liveStatus();
    live.className = `live ${st.cls}`;
    live.querySelector('.live-label').textContent = st.label;
    live.querySelector('.live-bar').style.width = `${st.pct ?? 0}%`;
    live.title = [st.label, st.detail].filter(Boolean).join('\n');
  };
  state.subscribe(['info', 'live', 'streamState', 'bootError'], renderLive);
  setInterval(renderLive, 30_000);
  live.addEventListener('click', () => {
    const info = state.get('info');
    const c = info?.counts ?? {};
    const idx = info?.indexing ?? {};
    const st = liveStatus();
    const lastOk = toUs(info?.lastIndexOkAt ?? idx.lastRunAt);
    showMenu(
      live,
      [
        { header: info ? `${info.mode === 'capture' ? 'Capture file' : 'Live index'} · v${info.version}` : 'Not connected' },
        { label: st.label, hint: st.detail, disabled: true },
        { label: `${fmt.formatInt(c.sessions)} sessions · ${fmt.formatInt(c.events)} events`, disabled: true },
        { label: `${fmt.formatInt(c.sources)} source files · ${fmt.formatInt(c.spans)} spans`, disabled: true },
        info?.mode !== 'capture'
          ? {
            label: idx.running
              ? `Indexing ${fmt.formatInt(idx.done)} of ${fmt.formatInt(idx.total)} files`
              : lastOk
                ? `Last successful index ${fmt.formatAgo(lastOk)}${idx.lastRunMs != null ? ` in ${fmt.formatDuration(idx.lastRunMs * 1000)}` : ''}`
                : 'Not indexed yet',
            hint: lastOk ? fmt.formatClock(lastOk, { digits: 0, offset: true }) : '',
            disabled: true,
          }
          : null,
        { label: info?.capturePath ?? info?.indexPath ?? '', disabled: true },
        { separator: true },
        info?.mode === 'capture' ? { label: 'Capture details…', onSelect: showCaptureDetails } : null,
        { label: 'Copy index path', disabled: !info?.indexPath, onSelect: () => copyText(info.indexPath) },
        { label: 'Re-index Now', disabled: info?.mode === 'capture' || idx.running, onSelect: reindex },
      ].filter(Boolean),
      { align: 'end', minWidth: 300 },
    );
  });

  // The icon cycles System → Light → Dark; View ▸ Appearance names the three (as the Mac's View ▸ Appearance does).
  const themeBtn = h('button', { class: 'icon-btn top-btn' });
  const nextTheme = () => THEMES[(THEMES.findIndex((x) => x.id === state.get('theme')) + 1) % THEMES.length];
  const renderTheme = () => {
    const t = state.get('theme');
    clear(themeBtn).append(icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor', 15));
    const label = `Appearance: ${THEMES.find((x) => x.id === t)?.label ?? t} (click for ${nextTheme().label})`;
    themeBtn.title = label;
    themeBtn.setAttribute('aria-label', label);
  };
  themeBtn.addEventListener('click', () => state.set({ theme: nextTheme().id }));
  state.subscribe(['theme'], (s) => {
    savePref('theme', s.theme);
    applyTheme();
    renderTheme();
  });
  renderTheme();

  const helpBtn = h('button', { class: 'tool-btn top-help', title: 'Help (?)', 'aria-haspopup': 'menu' }, 'Help', icon('down', 10));
  helpBtn.addEventListener('click', () =>
    showMenu(helpBtn, [
      { label: 'Getting started', onSelect: showGettingStarted },
      { label: 'Filter reference', onSelect: showFilterReference },
      { label: 'Keyboard shortcuts', hint: '?', onSelect: showShortcuts },
    ], { align: 'end', minWidth: 220 }),
  );
  const sideBtn = h('button', { class: 'icon-btn top-btn', title: 'Show or hide the sessions sidebar (Ctrl+B)', 'aria-label': 'Toggle sidebar' }, icon('sidebar', 15));
  sideBtn.addEventListener('click', () => toggleSidebar());

  // The logo switches to Events without touching the scope or the URL state.
  const brand = h('button', { class: 'brand', type: 'button', title: 'Go to Events (keeps the scope)', onClick: () => app.switchWorkspace('events') }, appLogo(), h('span', { class: 'wordmark' }, 'AgentShark'));

  const workbench = h('a', { class: 'tool-btn', href: '/workbench.html', title: 'Context, comparison, checks and research tools' }, 'Workbench');
  const row1 = h('div', { class: 'topbar-row' }, h('div', { class: 'top-group' }, sideBtn, brand), tabs, wsMenu, h('div', { class: 'spacer' }), h('div', { class: 'top-group' }, workbench, live, themeBtn, helpBtn));

  // Second row: filter toolbar with independent scope chips, time format and view options.
  const chips = h('div', { class: 'scope-chips', role: 'group', 'aria-label': 'Investigation scope' });
  // Scope tokens (§7.2): "Session: <title> ×", "Time: since Oct 12 17:48 (last visit) ×". The filter has no token,
  // because the field shows it. Each × removes only its part; Reset Scope shows when two or more parts are set.
  const renderChips = () => {
    clear(chips);
    const sc = state.get('scope');
    let parts = state.get('filter') ? 1 : 0;
    if (sc.sessions?.length) {
      parts++;
      const first = app.sessionById(sc.sessions[0]);
      const label = sc.sessions.length > 1 ? `${sc.sessions.length} sessions` : first?.title || first?.nativeId?.split('/').pop() || fmt.shortId(sc.sessions[0]);
      const tip = sc.sessions.map((id) => app.sessionById(id)?.title || id).join('\n') + '\nIncludes subagents.';
      chips.append(chip('Session', label, tip, () => app.setSessions(null), 'session'));
    }
    if (sc.from != null || sc.to != null) {
      parts++;
      // The entry rule's token names the last visit; removing it removes the time range.
      const since = state.get('sinceChip')?.from === sc.from && sc.to == null;
      const label = since ? `since ${tokenTime(sc.from)} (last visit)` : rangeLabel(sc.from, sc.to);
      chips.append(chip('Time', label, `${fmt.stampTitle(sc.from)}\n→ ${fmt.stampTitle(sc.to)}`, () => app.setTimeRange(null, null), 'time range'));
    }
    if (parts > 1) chips.append(h('button', { class: 'tool-btn chip-reset', title: 'Clear the sessions, the time range and the filter', onClick: app.resetScope }, 'Reset Scope'));
    const ref = state.get('timeRef');
    if (ref != null) {
      chips.append(chip('Reference', fmt.formatClock(ref, { digits: 3, date: false }), `Times show as +h:mm:ss.SSS from ${fmt.stampTitle(ref)} (t clears it)`, () => app.setTimeReference(null), 'time reference'));
    }
  };
  state.subscribe(['scope', 'metaVersion', 'filter', 'timeRef', 'sinceChip'], renderChips);

  const timeBtn = h('button', { class: 'tool-btn time-btn', 'aria-haspopup': 'menu', title: 'Time zone and the format of the Events Time column' });
  const renderTime = () => {
    const tf = state.get('timeFormat');
    const label = { local: `Times ${fmt.tzOffset()}`, utc: 'Times UTC', 'rel-first': 'Times from first', 'delta-prev': 'Times as Δ', 'rel-session': 'Times from session start' }[tf] ?? 'Times';
    timeBtn.replaceChildren(label, icon('down', 10));
  };
  timeBtn.addEventListener('click', () =>
    showMenu(
      timeBtn,
      [
        { header: 'Time column (Events workspace)' },
        ...fmt.TIME_FORMATS.map((f) => ({ label: f.id === 'local' ? `${f.label}, ${fmt.offsetLabel()}` : f.label, checked: state.get('timeFormat') === f.id, onSelect: () => state.set({ timeFormat: f.id }) })),
      ],
      { align: 'end' },
    ),
  );
  state.subscribe(['timeFormat'], (s) => {
    savePref('timeFormat', s.timeFormat);
    renderTime();
  });
  renderTime();

  const viewBtn = h('button', { class: 'tool-btn view-btn', title: 'View options', 'aria-haspopup': 'menu' }, 'View', icon('down', 10));
  viewBtn.addEventListener('click', () =>
    showMenu(
      viewBtn,
      [
        { label: 'Show inherited events', hint: 'resumed or copied context', checked: state.get('showInherited'), onSelect: () => state.set({ showInherited: !state.get('showInherited') }) },
        { label: 'Show duplicate events', hint: 'mirrored records', checked: state.get('showDup'), onSelect: () => state.set({ showDup: !state.get('showDup') }) },
        { separator: true },
        { label: 'Colorize rows', checked: state.get('colorize'), onSelect: () => state.set({ colorize: !state.get('colorize') }) },
        { label: 'Coloring Rules…', onSelect: openColoringRules },
        { separator: true },
        { header: 'Appearance' },
        ...THEMES.map((t) => ({ label: t.label, hint: t.hint, checked: state.get('theme') === t.id, onSelect: () => state.set({ theme: t.id }) })),
        { separator: true },
        { header: 'Density' },
        { label: 'Compact', hint: '13 px text, 22 px rows', checked: state.get('density') !== 'comfortable', onSelect: () => state.set({ density: 'compact' }) },
        { label: 'Comfortable', hint: '14 px text, 26 px rows', checked: state.get('density') === 'comfortable', onSelect: () => state.set({ density: 'comfortable' }) },
        { separator: true },
        { label: 'Classic workspace order', hint: 'Events first, for one release', checked: classicOrder, onSelect: toggleClassicOrder },
        { label: 'Alerts…', hint: 'desktop notifications for alarms', onSelect: openAlerts },
        { label: 'Reset Layout', hint: 'pane sizes and columns', onSelect: resetLayout },
        { label: 'Re-index Now', disabled: state.get('info')?.mode === 'capture', onSelect: reindex },
      ],
      { align: 'end', minWidth: 300 },
    ),
  );
  state.subscribe(['showInherited', 'showDup', 'colorize', 'density'], (s, changed) => {
    for (const k of changed) savePref(k, s[k]);
    if (changed.includes('density')) applyDensity();
  });

  const row2 = h('div', { class: 'topbar-row toolbar' }, filterBar.el, chips, h('div', { class: 'spacer' }), timeBtn, viewBtn);
  return h('header', { class: 'topbar' }, row1, row2);
}

function toggleClassicOrder() {
  classicOrder = !classicOrder;
  savePref('prefs.classicOrder', classicOrder);
  app.rebuildTabs?.();
}

/** A removable scope token (§6.1 Outline, neutral): "Kind: value ×". The tooltip carries the full value. */
function chip(kind, label, title, onClear, what) {
  return h(
    'span',
    { class: ['chip', `chip-${kind.toLowerCase()}`], title: title || label },
    h('span', { class: 'chip-kind' }, `${kind}:`),
    h('span', { class: 'chip-label' }, label),
    h('button', { class: 'chip-x', 'aria-label': `Remove the ${what} from the scope`, onClick: onClear }, icon('close', 10)),
  );
}

async function reindex() {
  try {
    await api.reindex();
    toast('Index update started');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function resetLayout() {
  try {
    const layoutKey = /^agentshark\.(layout\.|events\.(listFrac|detailFrac|columns2?|stripCollapsed|layers|rawMode|rawWrap)$)/;
    for (const k of Object.keys(localStorage)) if (layoutKey.test(k)) localStorage.removeItem(k);
  } catch {
    // Nothing stored.
  }
  location.reload();
}

// ---------------------------------------------------------------------------
// Sessions sidebar. Its search, agent chips and date presets are list filters: they choose which
// sessions the list shows and never change the investigation scope or the metadata cache.

function createSidebar() {
  const search = h('input', { class: 'side-search', type: 'search', placeholder: 'Search all sessions', spellcheck: 'false', 'aria-label': 'Search all indexed sessions by title, id, folder or project' });
  const chipsEl = h('div', { class: 'agent-chips', role: 'group', 'aria-label': 'Agents shown in the list' });
  const rangeEl = h('div', { class: 'seg', role: 'group', 'aria-label': 'Sessions shown in the list, by last activity' });
  const listEl = h('div', { class: 'side-list', role: 'tree', tabindex: '0', 'aria-label': 'Sessions' });
  const foot = h('div', { class: 'side-foot', 'aria-live': 'polite' });
  const countEl = h('span', { class: 'side-count' });
  const refreshBtn = h('button', { class: 'icon-btn', title: 'Reload the session list', 'aria-label': 'Reload sessions', onClick: () => load() }, icon('refresh', 13));
  const el = h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Sessions' },
    h('div', { class: 'side-head' }, h('span', { class: 'side-title' }, 'Sessions'), countEl, h('div', { class: 'spacer' }), refreshBtn),
    h(
      'div',
      { class: 'side-tools' },
      h('div', { class: 'side-tools-label', title: 'These filters choose which sessions the list shows. They do not change the scope of the workspaces.' }, 'List filters'),
      h('div', { class: 'side-search-wrap' }, icon('search', 12), search),
      chipsEl,
      rangeEl,
    ),
    listEl,
    foot,
  );

  let agents = new Set(loadPref('sidebar.agents', []));
  let range = loadPref('sidebar.range', 'all');
  const collapsed = new Set(loadPref('sidebar.collapsed', []));
  const expanded = new Set();
  let listRows = []; // the server's answer for the current range and search
  let total = 0; // server total for that query
  let query = '';
  let status = 'loading';
  let error = null;
  let loadSeq = 0;
  let model = [];
  let focusIndex = -1;
  let lastShown = 0;
  let lastPoll = Date.now() * 1000;

  const sessionH = () => (state.get('density') === 'comfortable' ? 48 : 40);
  const HEIGHTS = { all: 28, scopehead: 28, agent: 28, project: 28, more: 40, empty: 160, loading: 132, error: 160 };
  const vlist = createVariableList(listEl, { renderRow: (i) => renderRow(model[i], i) });

  const rangeOf = () => DATE_RANGES.find((d) => d.id === range) ?? DATE_RANGES[DATE_RANGES.length - 1];

  async function load({ append = false } = {}) {
    const seq = ++loadSeq;
    if (!append && !listRows.length) {
      status = 'loading';
      render();
    }
    const r = rangeOf();
    try {
      const res = await api.sessions({
        from: r.us ? Date.now() * 1000 - r.us : undefined,
        q: query || undefined,
        limit: query ? SEARCH_PAGE : BROWSE_LIMIT,
        offset: append ? listRows.length : 0,
      });
      if (seq !== loadSeq) return;
      const rows = res?.sessions ?? [];
      rememberSessions(rows);
      listRows = append ? [...listRows, ...rows] : rows;
      total = res?.total ?? listRows.length;
      status = 'ok';
      lastPoll = Date.now() * 1000;
    } catch (err) {
      if (seq !== loadSeq) return;
      status = 'error';
      error = err;
    }
    render();
  }

  /** Index run finished: update the changed sessions in place. Returns the changed ids (null = unknown). */
  async function applyChange(changed) {
    if (Array.isArray(changed) && !changed.length) return [];
    if (Array.isArray(changed) && changed.length > MAX_INCREMENTAL) {
      load();
      return changed;
    }
    let rows = Array.isArray(changed) ? await api.sessionsByIds(changed).catch(() => null) : null;
    let ids = changed;
    if (!rows) {
      // No batch endpoint or no change list: ask for the sessions active since the last poll.
      // A two-minute margin covers events whose timestamps trail the index run.
      const since = lastPoll - 120e6;
      const res = await api.sessions({ from: since, limit: 2000 }).catch(() => null);
      if (!res) return changed;
      rows = res.sessions ?? [];
      if (!Array.isArray(changed)) ids = rows.map((s) => s.id);
    }
    lastPoll = Date.now() * 1000;
    rememberSessions(rows);
    const from = rangeOf().us ? Date.now() * 1000 - rangeOf().us : null;
    const at = new Map(listRows.map((s, i) => [s.id, i]));
    let added = 0;
    for (const s of rows) {
      const i = at.get(s.id);
      if (i != null) listRows[i] = meta.get(s.id);
      else if (!query && (from == null || (s.end ?? s.start ?? 0) >= from)) {
        listRows.push(meta.get(s.id));
        added++;
      }
    }
    total += added;
    render();
    return ids;
  }

  function renderFilters() {
    clear(chipsEl);
    const present = new Map();
    for (const s of listRows) present.set(s.agent, (present.get(s.agent) ?? 0) + 1);
    for (const a of fmt.AGENTS) {
      if (!present.has(a.id) && !agents.has(a.id)) continue;
      const on = agents.has(a.id);
      chipsEl.append(
        h(
          'button',
          {
            class: ['chip', 'agent-chip', on && 'on'],
            type: 'button',
            'aria-pressed': String(on),
            title: on ? `Listing only selected agents; click to stop filtering on ${a.label}` : `List only ${a.label} sessions`,
            onClick: () => {
              if (on) agents.delete(a.id);
              else agents.add(a.id);
              savePref('sidebar.agents', [...agents]);
              render();
            },
          },
          agentDot(a.color),
          a.label,
          h('span', { class: 'chip-count' }, fmt.formatInt(present.get(a.id) ?? 0)),
        ),
      );
    }
    clear(rangeEl);
    for (const d of DATE_RANGES) {
      rangeEl.append(
        h(
          'button',
          {
            class: ['seg-btn', d.id === range && 'on'],
            'aria-pressed': String(d.id === range),
            title: d.us ? `List sessions active in ${d.long}` : 'List sessions of any date',
            onClick: () => setRange(d.id),
          },
          d.label,
        ),
      );
    }
  }

  function setRange(id) {
    range = id;
    savePref('sidebar.range', range);
    load();
  }

  function showAll() {
    agents = new Set();
    savePref('sidebar.agents', []);
    if (search.value) search.value = '';
    query = '';
    setRange('all');
  }

  const recency = (s) => s.end ?? s.start ?? 0;

  /** Agent → project → session tree of the listed sessions that pass the agent filter. */
  function buildTree() {
    const agentOk = (s) => !agents.size || agents.has(s.agent);
    const visible = new Set();
    const passing = new Set();
    for (const s of listRows) {
      if (!s || !agentOk(s)) continue;
      visible.add(s.id);
      passing.add(s.id);
      // Search results keep their parents as context when the cache knows them.
      if (query) for (let p = s.parentId; p && meta.has(p) && !visible.has(p); p = meta.get(p).parentId) visible.add(p);
    }
    const children = new Map();
    const roots = [];
    for (const id of visible) {
      const s = meta.get(id);
      if (!s) continue;
      if (s.parentId && visible.has(s.parentId)) {
        if (!children.has(s.parentId)) children.set(s.parentId, []);
        children.get(s.parentId).push(s);
      } else {
        roots.push(s);
      }
    }
    for (const c of children.values()) c.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    roots.sort((a, b) => recency(b) - recency(a));

    const groups = new Map(); // agent → Map(project → sessions)
    for (const s of roots) {
      if (!groups.has(s.agent)) groups.set(s.agent, new Map());
      const p = s.project || '(no project)';
      const g = groups.get(s.agent);
      if (!g.has(p)) g.set(p, []);
      g.get(p).push(s);
    }
    const rows = [];
    const order = [...fmt.AGENTS.map((a) => a.id), ...[...groups.keys()].filter((a) => !fmt.AGENTS.some((x) => x.id === a))];
    for (const agent of order) {
      const projects = groups.get(agent);
      if (!projects) continue;
      const aKey = `a:${agent}`;
      const n = [...projects.values()].reduce((sum, l) => sum + l.length, 0);
      rows.push({ type: 'agent', key: aKey, agent, count: n });
      if (collapsed.has(aKey)) continue;
      for (const [project, sessions] of projects) {
        const pKey = `p:${agent}/${project}`;
        rows.push({ type: 'project', key: pKey, project, count: sessions.length });
        if (collapsed.has(pKey)) continue;
        const walk = (s, depth) => {
          const kids = children.get(s.id) ?? [];
          const open = kids.length > 0 && (expanded.has(s.id) || !!query);
          rows.push({ type: 'session', s, depth, kids: kids.length, open, subtree: kids.length && !open ? subtreeMark(s.id, children) : null });
          if (open) for (const k of kids) walk(k, depth + 1);
        };
        for (const s of sessions) walk(s, 0);
      }
    }
    return { rows, passing };
  }

  function buildModel() {
    const out = [{ type: 'all' }];
    if (status === 'loading' && !listRows.length) return { model: [...out, { type: 'loading' }], shown: 0 };
    if (status === 'error') return { model: [...out, { type: 'error' }], shown: 0 };
    const { rows, passing } = buildTree();
    const scoped = state.get('scope').sessions ?? [];
    const hidden = scoped.filter((id) => !passing.has(id));
    if (hidden.length) {
      out.push({ type: 'scopehead', n: hidden.length });
      for (const id of hidden) out.push({ type: 'session', s: meta.get(id) ?? { id, agent: AGENT_BY_PREFIX[id.slice(0, 2)] }, depth: 0, kids: 0, open: false, pinned: true });
      ensureMeta(hidden);
    }
    out.push(...rows);
    if (!rows.length) out.push({ type: 'empty' });
    if (listRows.length < total) out.push({ type: 'more' });
    return { model: out, shown: passing.size };
  }

  function render() {
    renderFilters();
    const { model: next, shown } = buildModel();
    model = next;
    lastShown = shown;
    const sh = sessionH();
    vlist.setRows(model.map((r) => (r.type === 'session' ? sh : HEIGHTS[r.type] ?? 30)));
    if (focusIndex >= model.length) focusIndex = -1;
    const indexTotal = state.get('info')?.counts?.sessions;
    countEl.textContent = indexTotal != null ? fmt.formatInt(indexTotal) : '';
    renderFoot(shown, indexTotal);
  }

  function renderFoot(shown, indexTotal) {
    clear(foot);
    if (status !== 'ok') return;
    const r = rangeOf();
    const filtered = !!query || !!r.us || agents.size > 0;
    const parts = [];
    if (query) parts.push(`${fmt.formatInt(shown)} of ${fmt.formatInt(total)} matches for “${query}”`);
    else parts.push(`Showing ${fmt.formatInt(shown)} of ${fmt.formatInt(indexTotal ?? total)} sessions`);
    if (r.us) parts.push(`active in ${r.long}`);
    if (agents.size) parts.push([...agents].map(fmt.agentLabel).join(', ') + ' only');
    if (!query && listRows.length < total) parts.push(`the ${fmt.formatInt(listRows.length)} most recent; search to find older ones`);
    foot.append(parts.join(' · '));
    if (filtered) foot.append(' · ', h('button', { class: 'link-btn', onClick: showAll }, 'Show all'));
  }

  /** Worst impact, silent children and firing alarms over a collapsed parent's descendants. */
  function subtreeMark(id, children) {
    const marks = state.get('sessionMarks');
    const out = { worstImpact: null, silentChildren: 0, firingAlarms: 0 };
    const stack = [...(children.get(id) ?? [])];
    while (stack.length) {
      const c = stack.pop();
      const m = marks.get(c.id);
      if (m) {
        out.worstImpact = worseImpact(out.worstImpact, m.worstImpact);
        out.silentChildren += m.silentChildren ?? 0;
        out.firingAlarms += m.firingAlarms ?? 0;
      }
      stack.push(...(children.get(c.id) ?? []));
    }
    return out;
  }

  /**
   * Sidebar marks (§6.3, §7.18): the worst impact, a silent child and a firing alarm. A mark stands alone here, so it
   * carries its accessible name; a collapsed parent shows the worst mark of its subtree.
   */
  function markGlyphs(own, subtree) {
    const m = { worstImpact: worseImpact(own?.worstImpact ?? null, subtree?.worstImpact ?? null), silentChildren: (own?.silentChildren ?? 0) + (subtree?.silentChildren ?? 0), firingAlarms: (own?.firingAlarms ?? 0) + (subtree?.firingAlarms ?? 0) };
    const out = [];
    const imp = IMPACT[m.worstImpact];
    if (imp && m.worstImpact !== 'clean') {
      const inSub = subtree?.worstImpact && subtree.worstImpact === m.worstImpact && own?.worstImpact !== m.worstImpact;
      out.push(h('span', { class: ['s-mark', `tone-${imp.tone}`], title: `Worst turn: ${imp.word}${inSub ? ' (in a subagent)' : ''}` }, mark(m.worstImpact, { label: `worst turn ${imp.word}` })));
    }
    if (m.silentChildren) out.push(h('span', { class: 's-mark tone-bad', title: fmt.plural(m.silentChildren, 'child failure') + ' the parent was not told about' }, mark('silent', { label: true })));
    if (m.firingAlarms) out.push(h('span', { class: 's-mark tone-bad', title: fmt.plural(m.firingAlarms, 'alarm') + ' firing' }, mark('alarm', { label: true })));
    return out;
  }

  function sessionRow(s, depth, kids, open, selected, focused, pinned, subtree) {
    const missing = s.state && s.state !== 'ok';
    const dur = s.start != null && s.end != null ? s.end - s.start : null;
    const title = s.title || (s.role && s.role !== 'main' ? s.nativeId?.split('/').pop() : null) || fmt.shortId(s.id);
    // Line 2 abbreviates (ev, out, err, sub); the row tooltip spells them out. The error count comes second, so it is
    // the last figure to drop from the right (§7.18).
    const facts = [
      s.nEvents != null ? [`${fmt.formatInt(s.nEvents)} ev`, fmt.plural(s.nEvents, 'event')] : null,
      s.nErrors ? [`${fmt.formatInt(s.nErrors)} err`, fmt.plural(s.nErrors, 'error'), 'err'] : null,
      dur != null ? [fmt.formatDuration(dur), fmt.formatDuration(dur)] : null,
      s.tokens?.output ? [`${fmt.formatTokens(s.tokens.output)} out`, `${fmt.formatTokens(s.tokens.output)} tokens out`] : null,
      kids ? [`${fmt.formatInt(kids)} sub`, fmt.plural(kids, 'subagent')] : null,
    ].filter(Boolean);
    const tip = [
      facts.map((f) => f[1]).join(' · '),
      missing ? (s.state === 'missing-transcript' ? 'The transcript file is gone; only registry metadata remains.' : 'The source file was deleted; showing the indexed copy.') : null,
      pinned ? 'In the current scope, but hidden by the list filters.' : null,
    ].filter(Boolean).join('\n');
    const roleWord = { subagent: 'subagent', 'workflow-agent': 'workflow', guardian: 'guardian', review: 'review', fork: 'fork', automation: 'automation' }[s.role];
    return h(
      'div',
      {
        class: ['s-row', selected && 'selected', missing && 'missing', focused && 'focused', pinned && 'pinned'],
        role: 'treeitem',
        'aria-selected': String(selected),
        'aria-expanded': kids ? String(open) : null,
        'aria-level': String(depth + 1),
        'aria-label': [title, roleWord, fmt.agentLabel(s.agent), facts.map((f) => f[1]).join(', '), fmt.formatAgo(s.end ?? s.start)].filter(Boolean).join(', '),
        dataset: { id: s.id },
        style: { paddingLeft: `${8 + depth * 12}px` },
        title: tip || null,
      },
      h(
        'div',
        { class: 's-line1' },
        kids ? h('span', { class: ['twisty', open && 'open'], dataset: { toggle: s.id } }, icon('chevron', 10)) : h('span', { class: 'twisty-gap' }),
        agentDot(fmt.agentColor(s.agent)),
        roleWord ? h('span', { class: 's-role' }, roleWord) : null,
        missing ? h('span', { class: 's-mark tone-warn', title: 'Transcript missing' }, mark('degraded', { label: 'transcript missing' })) : null,
        markGlyphs(state.get('sessionMarks').get(s.id), subtree),
        h('span', { class: 's-title' }, title),
        h('span', { class: 's-ago' }, fmt.formatAgo(s.end ?? s.start)),
      ),
      h('div', { class: 's-line2' }, facts.map((f) => h('span', { class: f[2] ?? null }, f[0]))),
    );
  }

  function renderRow(r, i) {
    const scoped = new Set(state.get('scope').sessions ?? []);
    const focused = i === focusIndex;
    switch (r.type) {
      case 'all': {
        const n = state.get('info')?.counts?.sessions;
        return h(
          'div',
          { class: ['s-row', 's-all', !scoped.size && 'selected', focused && 'focused'], role: 'treeitem', 'aria-selected': String(!scoped.size), dataset: { all: '1' }, title: 'Investigate every indexed session' },
          h('div', { class: 's-line1' }, h('span', { class: 's-title' }, 'All sessions'), h('span', { class: 's-ago' }, n != null ? fmt.formatInt(n) : '')),
        );
      }
      case 'scopehead':
        return h('div', { class: 'g-row g-scope', role: 'presentation', title: 'Sessions in the current scope that the list filters hide' }, h('span', { class: 'g-label' }, 'In scope · hidden by list filters'), h('span', { class: 'g-count' }, fmt.formatInt(r.n)));
      case 'session':
        return sessionRow(meta.get(r.s.id) ?? r.s, r.depth, r.kids, r.open, scoped.has(r.s.id), focused, r.pinned, r.subtree);
      case 'agent':
      case 'project': {
        const open = !collapsed.has(r.key);
        return h(
          'div',
          { class: ['g-row', `g-${r.type}`, focused && 'focused'], dataset: { key: r.key }, role: 'treeitem', 'aria-expanded': String(open), title: r.type === 'project' ? r.project : '' },
          h('span', { class: ['twisty', open && 'open'] }, icon('chevron', 10)),
          r.type === 'agent' ? agentDot(fmt.agentColor(r.agent)) : null,
          h('span', { class: 'g-label' }, r.type === 'agent' ? fmt.agentLabel(r.agent) : r.project),
          h('span', { class: 'g-count' }, fmt.formatInt(r.count)),
        );
      }
      case 'more':
        return h('div', { class: 's-more' }, h('button', { class: 'btn small', dataset: { action: 'more' } }, query ? `Load more matches (${fmt.formatInt(total - listRows.length)} left)` : 'Load older sessions'));
      case 'loading':
        return placeholder('loading', 'Loading sessions…');
      case 'error':
        return placeholder('error', 'Could not load sessions', error?.message, { label: 'Retry', onClick: () => load() });
      default: {
        const r0 = rangeOf();
        if (query) return placeholder('empty', `No sessions match “${query}”`, r0.us ? `Only sessions active in ${r0.long} were searched.` : 'The search covers titles, ids, folders and projects.', { label: 'Clear the search', onClick: showAll });
        if (agents.size) return placeholder('empty', 'No sessions of the selected agents', null, { label: 'Show all', onClick: showAll });
        if (r0.us) return placeholder('empty', `No sessions active in ${r0.long}`, null, { label: 'Show all dates', onClick: () => setRange('all') });
        return placeholder('empty', 'No sessions indexed yet', 'Open Sources to see where AgentShark looked.', { label: 'Open Sources', onClick: () => app.switchWorkspace('sources') });
      }
    }
  }

  function activate(i, e) {
    const r = model[i];
    if (!r) return;
    if (r.type === 'all') return app.setSessions(null);
    if (r.type === 'agent' || r.type === 'project') {
      if (collapsed.has(r.key)) collapsed.delete(r.key);
      else collapsed.add(r.key);
      savePref('sidebar.collapsed', [...collapsed]);
      return render();
    }
    if (r.type !== 'session') return;
    const id = r.s.id;
    if (e && (e.metaKey || e.ctrlKey)) {
      const cur = new Set(state.get('scope').sessions ?? []);
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      app.setSessions([...cur]);
    } else {
      app.setSessions(id);
    }
  }

  const indexOfEl = (el) => {
    const row = el?.closest('[data-vi]');
    return row && row.matches('.s-row, .g-row') ? Number(row.dataset.vi) : -1;
  };

  listEl.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'more') return load({ append: true });
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.dataset.toggle;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      return render();
    }
    const i = indexOfEl(e.target);
    if (i >= 0) {
      focusIndex = i;
      activate(i, e);
    }
  });
  listEl.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.s-row[data-id]');
    if (row) app.showSession(row.dataset.id);
  });
  listEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.s-row[data-id]');
    if (!row) return;
    e.preventDefault();
    const id = row.dataset.id;
    const cur = state.get('scope').sessions ?? [];
    showMenu({ x: e.clientX, y: e.clientY }, [
      ...['failures', 'events', 'timeline'].map((w) => ({ label: `Open in ${WORKSPACES.find((x) => x.name === w).label}`, onSelect: () => app.openSession(id, { workspace: w }) })),
      ...['steps', 'transcript', 'flow'].map((m) => ({ label: `Open in Session · ${m[0].toUpperCase()}${m.slice(1)}`, onSelect: () => { app.openSession(id); app.showSession(id); app.switchWorkspace('session', { mode: m }); } })),
      { label: cur.includes(id) ? 'Remove from the scope' : 'Add to the scope', hint: 'Ctrl+click', onSelect: () => app.setSessions(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) },
      { separator: true },
      { label: 'Filter on this session', hint: 'session == … (narrows)', onSelect: () => app.narrowFilter(`session == ${JSON.stringify(id)}`) },
      { label: 'Copy session id', onSelect: () => copyText(id) },
    ]);
  });
  listEl.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const nav = model.map((r, i) => (['all', 'session', 'agent', 'project'].includes(r.type) ? i : -1)).filter((i) => i >= 0);
    if (!nav.length) return;
    e.preventDefault();
    let k = nav.indexOf(focusIndex);
    if (k < 0) {
      const sel = model.findIndex((r) => r.type === 'session' && (state.get('scope').sessions ?? []).includes(r.s.id));
      k = Math.max(0, nav.indexOf(sel));
    }
    if (e.key === 'ArrowDown') k = Math.min(nav.length - 1, k + 1);
    else if (e.key === 'ArrowUp') k = Math.max(0, k - 1);
    else if (e.key === 'Home') k = 0;
    else if (e.key === 'End') k = nav.length - 1;
    focusIndex = nav[k];
    const r = model[focusIndex];
    if (e.key === 'Enter') return activate(focusIndex, e);
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && r) {
      const want = e.key === 'ArrowRight';
      if (r.type === 'session' && r.kids && expanded.has(r.s.id) !== want) {
        if (want) expanded.add(r.s.id);
        else expanded.delete(r.s.id);
        return render();
      }
      if ((r.type === 'agent' || r.type === 'project') && collapsed.has(r.key) === want) return activate(focusIndex);
    }
    vlist.scrollToIndex(focusIndex);
    vlist.refresh();
  });
  const searchSoon = debounce(() => {
    query = search.value.trim();
    load();
  }, 250);
  search.addEventListener('input', searchSoon);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      searchSoon.cancel();
      query = '';
      load();
    }
  });

  state.subscribe(['scope'], render);
  state.subscribe(['metaVersion'], debounce(() => vlist.refresh(), 50));
  // Collapsed parents show the worst glyph of their subtree, so marks rebuild the model.
  state.subscribe(['sessionMarks'], debounce(() => render(), 50));
  state.subscribe(['density'], render);
  state.subscribe(['info'], () => {
    if (status === 'error') load();
    else {
      renderFoot(lastShown, state.get('info')?.counts?.sessions);
      countEl.textContent = state.get('info')?.counts?.sessions != null ? fmt.formatInt(state.get('info').counts.sessions) : '';
      vlist.refresh();
    }
  });
  load();
  return { el, render, applyChange, reload: load };
}

// ---------------------------------------------------------------------------
// Status bar (docs/DESIGN.md §7.16): Selection, Attention, Index, Source location and Watch status, each shown only
// when no other chrome or visible pane says the same; segments drop whole by priority (P4, then P3, then P2) when
// the bar is full. Workspace counts and scope labels live in the workspace headers, never here.

/** Whether a visible pane of the active workspace already shows its selection (Lens, Detail, inspector). */
function selectionShownInPane(ws) {
  const root = document.querySelector(`.workspace[data-ws="${ws}"]`);
  return [...(root?.querySelectorAll('[data-shows-selection]') ?? [])].some((el) => el.offsetParent !== null && !el.classList.contains('is-empty'));
}

function createStatusBar() {
  const seg = (cls, prio, tag = 'span') => h(tag, { class: ['sb-item', cls], dataset: { prio: String(prio) } });
  const selected = seg('sb-selected', 2);
  // "2,941 need attention · 1 alarm · all sessions" over the whole index; a click opens Failures (§7.16).
  const attention = seg('sb-attention', 1, 'button');
  attention.type = 'button';
  attention.addEventListener('click', () => app.switchWorkspace('failures'));
  const index = seg('sb-index', 4);
  const source = seg('sb-source', 3, 'button');
  source.addEventListener('click', () => {
    if (source.dataset.loc) copyText(source.dataset.loc).then(() => toast('Source location copied', 'ok'));
  });
  const watch = seg('sb-watch', 1, 'button');
  watch.addEventListener('click', () => document.querySelector('.live')?.click());
  const bar = h('footer', { class: 'statusbar', 'aria-label': 'Status' }, selected, attention, index, source, h('div', { class: 'spacer' }), watch);

  /** Show every segment that applies, then drop whole segments, P4 first, until the bar fits. */
  const fit = () => {
    const segs = [selected, attention, index, source, watch];
    for (const el of segs) el.classList.remove('sb-dropped');
    for (const prio of ['4', '3', '2']) {
      if (bar.scrollWidth <= bar.clientWidth + 1) return;
      for (const el of segs) if (el.dataset.prio === prio) el.classList.add('sb-dropped');
    }
  };

  const render = () => {
    const ws = state.get('workspace');
    const info = state.get('info');

    // Selection (P2): only when no visible Lens, Detail or inspector shows it.
    const sel = state.get('selectedEvent');
    const wsSel = state.get('wsSelection')[ws] ?? null;
    const det0 = state.get('selectedDetail');
    const selText = wsSel ?? (sel ? `${det0?.event?.id === sel ? det0.event.kind : 'event'} No. ${fmt.formatInt(state.get('selectedNo') ?? 0)}` : null);
    selected.hidden = !selText || selectionShownInPane(ws);
    selected.textContent = selText ? `Selected: ${selText}` : '';
    autoTitle(selected, selected.textContent);

    // Attention (P1): always all sessions; hidden in Failures, whose header owns the scoped count.
    const a = state.get('attention');
    const text = a ? attentionStatus(a) : null;
    attention.hidden = !text || ws === 'failures';
    attention.textContent = text ? `${text} · all sessions` : '';
    attention.classList.toggle('has-alarm', !!a?.openAlarms);
    const firing = state.get('alarms') ?? [];
    attention.title = firing.length
      ? `Open Failures (Alt+1). Firing alarms:\n${firing.slice(0, 8).map((x) => alarmLine(x, meta.get(x.sessionId))).join('\n')}${firing.length > 8 ? `\n… ${firing.length - 8} more` : ''}`
      : 'Open Failures (Alt+1)';

    // Index (P4).
    const c = info?.counts;
    index.hidden = !c;
    index.textContent = c ? `Index ${fmt.plural(c.sources ?? 0, 'source')}${info.indexBytes ? ` · ${fmt.formatBytes(info.indexBytes)}` : ''}` : '';

    // Source location (P3): path and line of the selected event while the Raw pane is not visible.
    const det = state.get('selectedDetail');
    const raw = det?.event?.id === sel ? det.event.raw : null;
    const rawShown = [...document.querySelectorAll(`.workspace[data-ws="${ws}"] .ev-raw-pane, .workspace[data-ws="${ws}"] .raw-body`)].some((el) => el.offsetParent !== null);
    if (raw?.path && !rawShown) {
      const loc = `${raw.path}:${raw.line}`;
      source.dataset.loc = loc;
      source.textContent = middleEllipsis(loc, 320, 11);
      source.title = `${loc}\nClick to copy`;
      source.setAttribute('aria-label', `Copy source location ${loc}`);
      source.hidden = false;
    } else {
      source.hidden = true;
    }

    // Watch status (P1, right).
    const st = liveStatus();
    const idx = info?.indexing;
    const lastOk = toUs(info?.lastIndexOkAt ?? idx?.lastRunAt);
    const an = state.get('analysis');
    const pending = an?.pending?.length ?? 0;
    const outdated = an && an.version !== an.expected;
    const note = pending ? ` · analysis pending for ${fmt.plural(pending, 'run')}` : outdated ? ' · analysis outdated' : '';
    // The top bar's status indicator names the state ("Watching", "Indexing 3/7"); this segment adds when the index
    // last changed, without repeating the state word (DESIGN Web notes).
    const watchText = info?.mode === 'capture' ? `Capture indexed ${lastOk ? fmt.formatAgo(lastOk) : ''}`.trim() : lastOk ? `Last index ${fmt.formatAgo(lastOk)}` : '';
    watch.hidden = !watchText && !note;
    watch.replaceChildren(`${watchText}${watchText ? note : note.replace(/^ · /, '')}`);
    watch.title = [st.detail, pending ? 'Some runs are still being analyzed; their failures appear when the pass finishes.' : outdated ? 'The index was derived by another analysis version; failure counts are incomplete until it is re-derived.' : ''].filter(Boolean).join('\n');
    requestAnimationFrame(fit);
  };
  state.subscribe(
    ['workspace', 'view', 'viewLoading', 'viewError', 'info', 'selectedEvent', 'selectedNo', 'selectedDetail', 'wsSelection', 'failuresEvidence', 'sessionMode', 'streamState', 'live', 'attention', 'analysis', 'alarms', 'inspectorOpen'],
    () => requestAnimationFrame(render),
  );
  new ResizeObserver(() => fit()).observe(bar);
  setInterval(render, 30_000);
  render();
  return bar;
}

// ---------------------------------------------------------------------------
// First-run, empty-index and connection overlay. It covers only the workspaces that show events,
// so Sources and Diagnostics stay reachable when the index is empty (SPEC §7.8).

const OVERLAY_FREE = new Set(['sources', 'expert']);

function createOverlay() {
  const el = h('div', { class: 'overlay', hidden: true });
  const render = () => {
    const info = state.get('info');
    const bootError = state.get('bootError');
    clear(el);
    if (bootError) {
      el.hidden = false;
      el.append(h('div', { class: 'overlay-card' }, appLogo(), placeholder('error', 'Cannot reach the AgentShark server', bootError.message, { label: 'Retry', onClick: boot })));
      return;
    }
    if (!info || info.counts?.events > 0 || OVERLAY_FREE.has(state.get('workspace'))) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const idx = info.indexing ?? {};
    const pct = idx.total ? Math.floor((idx.done / idx.total) * 100) : 0;
    const actions = (...btns) => h('div', { class: 'overlay-actions' }, ...btns.filter(Boolean));
    let content;
    if (idx.running) {
      content = [
        h('h2', null, idx.total ? 'Building your trace index' : 'Looking for agent logs'),
        h('p', { class: 'muted' }, 'AgentShark is reading the agent logs on this machine, newest first: sessions being written now appear within seconds, and older history fills in behind them. Later runs only parse changed files.'),
        h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: { width: `${pct}%` } })),
        h('div', { class: 'progress-meta' }, h('span', null, idx.total ? `${fmt.formatInt(idx.done)} of ${fmt.formatInt(idx.total)} files` : 'Discovering sources…'), h('span', null, idx.total ? `${pct}%` : '')),
        idx.currentPath ? h('div', { class: 'progress-path mono', title: idx.currentPath }, fmt.truncateStart(idx.currentPath, 90)) : null,
      ];
    } else if (info.mode === 'capture') {
      content = [
        h('h2', null, 'This capture contains no indexed events'),
        h('p', { class: 'muted' }, 'The export may have selected nothing, or it may be truncated. The capture details show what it was meant to contain.'),
        actions(h('button', { class: 'btn primary', onClick: showCaptureDetails }, 'Capture details'), h('button', { class: 'btn', onClick: () => app.switchWorkspace('sources') }, 'Captured sources')),
      ];
    } else if (!info.counts?.sources) {
      content = [
        h('h2', null, 'No supported logs found in the locations checked'),
        h('p', { class: 'muted' }, 'AgentShark reads Claude Code and Cowork transcripts, Codex rollouts, VS Code Copilot chat sessions and Google Antigravity conversations. Sources lists every location it checked.'),
        actions(h('button', { class: 'btn primary', onClick: () => app.switchWorkspace('sources') }, 'Open Sources'), h('button', { class: 'btn', onClick: reindex }, icon('refresh', 13), ' Index again')),
      ];
    } else {
      content = [
        h('h2', null, 'Found files, but no readable events were indexed'),
        h('p', { class: 'muted' }, `${fmt.formatInt(info.counts.sources)} source files were read without producing events. Diagnostics lists malformed and undecoded records; Sources shows each file's status.`),
        actions(h('button', { class: 'btn primary', onClick: () => app.switchWorkspace('expert') }, 'Open Diagnostics'), h('button', { class: 'btn', onClick: () => app.switchWorkspace('sources') }, 'Open Sources')),
      ];
    }
    el.append(h('div', { class: 'overlay-card' }, appLogo(), ...content));
  };
  state.subscribe(['info', 'bootError', 'workspace'], render);
  return el;
}

// ---------------------------------------------------------------------------
// Workspaces

const mounted = new Map(); // name → { root, instance, loading, attempts }

function createWorkspaceHost() {
  const host = h('main', { class: 'workspaces' });
  for (const w of WORKSPACES) {
    const root = h('section', { class: ['workspace', `ws-${w.name}`], hidden: true, 'aria-label': w.label, dataset: { ws: w.name } });
    host.append(root);
    mounted.set(w.name, { root, instance: null, loading: null, attempts: 0 });
  }
  state.subscribe(['workspace'], (s) => showWorkspace(s.workspace));
  return host;
}

async function showWorkspace(name) {
  for (const [n, m] of mounted) {
    if (n !== name && !m.root.hidden) {
      m.root.hidden = true;
      try {
        m.instance?.hide();
      } catch (err) {
        console.error(err);
      }
    }
  }
  const m = mounted.get(name);
  const spec = WORKSPACES.find((w) => w.name === name);
  m.root.hidden = false;
  if (!m.instance) {
    // A load already in flight shows the workspace itself when it finishes.
    if (m.loading) return;
    clear(m.root).append(placeholder('loading', `Loading ${spec.label}…`));
    // A retry needs a fresh URL: browsers cache failed module imports.
    const url = new URL(`./views/${spec.file}`, import.meta.url);
    if (m.attempts) url.searchParams.set('retry', String(m.attempts));
    m.attempts++;
    m.loading = import(url.href)
      .then((mod) => {
        clear(m.root);
        m.instance = mod.default(m.root, app);
      })
      .catch((err) => {
        console.error(`workspace ${name} failed to load`, err);
        clear(m.root).append(
          placeholder('error', `The ${spec.label} workspace failed to load`, err?.message ?? String(err), {
            label: 'Retry',
            onClick: () => showWorkspace(name),
          }),
        );
      });
    await m.loading;
    m.loading = null;
  }
  if (m.instance && state.get('workspace') === name && !m.root.hidden) {
    try {
      m.instance.show();
    } catch (err) {
      console.error(err);
      toast(`${spec.label}: ${err.message}`, 'error');
    }
  }
}

// ---------------------------------------------------------------------------
// View materialization: one view for the filter + scope, shared by Events, Statistics,
// Diagnostics and the timeline density. A failed view stays failed; nothing falls back to global.

let viewSeq = 0;
let lastRebuild = 0;
let refreshTimer = 0;

function viewSpec() {
  const scope = state.get('scope');
  const spec = {
    filter: state.get('filter') || undefined,
    sessions: scope.sessions ?? undefined,
    descendants: true,
    from: scope.from ?? undefined,
    to: scope.to ?? undefined,
    includeInherited: state.get('showInherited'),
    includeDup: state.get('showDup'),
  };
  const sort = state.get('sort') ?? DEFAULT_SORT;
  if ((sort.key !== 'ts' || sort.order !== 'asc') && api.features.sort !== false) {
    spec.sort = sort.key;
    spec.order = sort.order;
  }
  if (state.get('colorize') && api.features.colorRules !== false) {
    // A server without the analysis tables would answer derived fields through slow JSON lookups.
    const rules = serverRules(state.get('colorRules')).filter((r) => !brokenRules.has(r.id) && (api.features.derived || !usesDerivedFields(r.filter)));
    if (rules.length) spec.colorRules = rules;
  }
  return spec;
}

/** POST /api/views, dropping what the server rejects: an invalid coloring rule or an unknown sort. */
async function createView(spec) {
  for (let attempt = 0; ; attempt++) {
    try {
      const v = await api.createView(spec);
      if (spec.sort && spec.sort !== 'ts' && spec.sort !== 'seq') api.features.sort = true;
      return { v, spec };
    } catch (err) {
      if (attempt > 4 || err.status !== 400) throw err;
      const ruleId = err.data?.error?.ruleId;
      if (err.code === 'color_rule' && ruleId && spec.colorRules) {
        brokenRules.add(ruleId);
        const rule = rulesById.get(ruleId);
        toast(`The coloring rule “${rule?.name ?? ruleId}” is not a valid filter on this server and was skipped.`, 'warn');
        spec = { ...spec, colorRules: spec.colorRules.filter((r) => r.id !== ruleId) };
        continue;
      }
      if (spec.sort && /\b(sort|order)\b/i.test(err.message ?? '')) {
        api.features.sort = false;
        const { sort, order, ...rest } = spec;
        spec = rest;
        savePref('events.sort', DEFAULT_SORT);
        state.set({ sort: DEFAULT_SORT });
        toast('This AgentShark server can only order events by time; showing them oldest first.', 'warn');
        continue;
      }
      throw err;
    }
  }
}

function onViewInputs(_s, changed) {
  const only = (keys) => changed.every((k) => keys.includes(k));
  if (only(['indexVersion'])) {
    // Index runs that do not touch the scoped sessions leave the view alone.
    if (!app.changeAffects(state.get('scope').sessions)) return;
    const wait = lastRebuild + LIVE_REFRESH_MS - Date.now();
    if (wait > 0) {
      if (!refreshTimer) refreshTimer = setTimeout(() => onViewInputs(null, ['indexVersion']), wait);
      return;
    }
  }
  if (only(['colorRules', 'colorize']) && api.features.colorRules === false) return;
  clearTimeout(refreshTimer);
  refreshTimer = 0;
  const reason = only(['indexVersion']) ? 'refresh' : only(['colorRules', 'colorize']) ? 'refresh' : only(['sort']) ? 'sort' : 'query';
  rebuildView(reason);
}

async function rebuildView(reason = 'query') {
  const seq = ++viewSeq;
  lastRebuild = Date.now();
  state.set({ viewLoading: true, viewPending: reason, viewError: reason === 'refresh' ? state.get('viewError') : null });
  try {
    const { v, spec } = await createView(viewSpec());
    if (seq !== viewSeq) return;
    state.set({ view: { ...v, spec, reason }, viewLoading: false, viewError: null });
  } catch (err) {
    if (seq !== viewSeq) return;
    // A refresh that fails keeps the loaded view; a new query must not show the previous result as if current.
    if (reason === 'refresh' && state.get('view')) state.set({ viewLoading: false });
    else state.set({ view: null, viewLoading: false, viewError: err });
  }
}

// ---------------------------------------------------------------------------
// Hash routing: #/<workspace>?filter=…&session=a,b&from=…&to=…&event=…
// The URL carries the whole navigation state. Workspace, scope and filter changes push a history
// entry; selection changes replace the current one, so Back returns to the previous investigation
// with the event that was selected in it. Restoring an entry restores all of it (SPEC §7.8).

function readHash() {
  const m = /^#\/?([a-z]*)(?:\?(.*))?$/.exec(location.hash);
  if (!m) return null;
  const p = new URLSearchParams(m[2] ?? '');
  const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const sessions = (p.get('session') ?? '').split(',').filter(Boolean);
  // The old Conversation and Flow routes open those Session modes.
  const alias = MODE_ROUTES[m[1]];
  const workspace = alias ? 'session' : WORKSPACES.some((w) => w.name === m[1]) ? m[1] : m[1] ? 'events' : null;
  const mode = alias ?? (SESSION_MODES.includes(p.get('mode')) ? p.get('mode') : null);
  const lens = /^(episode|claim|delegation|signature|session):(.+)$/.exec(p.get('lens') ?? '');
  return {
    workspace,
    mode,
    filter: p.get('filter') ?? '',
    scope: { sessions: sessions.length ? sessions : null, from: num(p.get('from')), to: num(p.get('to')) },
    event: p.get('event') || null,
    lens: lens ? { kind: lens[1], id: lens[2] } : null,
  };
}

let restoring = false;

function writeHash(push) {
  const p = new URLSearchParams();
  const f = state.get('filter');
  const sc = state.get('scope');
  const ev = state.get('selectedEvent');
  if (f) p.set('filter', f);
  if (sc.sessions?.length) p.set('session', sc.sessions.join(','));
  if (sc.from != null) p.set('from', String(sc.from));
  if (sc.to != null) p.set('to', String(sc.to));
  if (ev) p.set('event', ev);
  if (state.get('workspace') === 'session') p.set('mode', state.get('sessionMode'));
  const lens = state.get('lensItem');
  if (state.get('workspace') === 'failures' && lens) p.set('lens', `${lens.kind}:${lens.id}`);
  const qs = p.toString();
  const hash = `#/${state.get('workspace')}${qs ? '?' + qs : ''}`;
  if (hash === location.hash) return;
  if (push && !restoring) history.pushState(null, '', hash);
  else history.replaceState(null, '', hash);
}

function applyHash() {
  const r = readHash();
  if (!r) return;
  restoring = true;
  try {
    state.set({
      ...(r.workspace ? { workspace: r.workspace } : {}),
      ...(r.mode ? { sessionMode: r.mode } : {}),
      // A route without a Lens item clears it, as a route without an event clears the selection.
      lensItem: r.lens,
      filter: r.filter,
      ...(sameScope(state.get('scope'), r.scope) ? {} : { scope: r.scope }),
      // A route without an event clears the selection.
      selectedEvent: r.event,
    });
    ensureMeta(r.scope.sessions ?? []);
  } finally {
    restoring = false;
  }
}

// ---------------------------------------------------------------------------
// Keyboard

const narrowQuery = matchMedia('(max-width: 900px)');

function toggleSidebar(force) {
  const hidden = force ?? !document.body.classList.contains('sidebar-hidden');
  document.body.classList.toggle('sidebar-hidden', hidden);
  // In a narrow window the sidebar is a drawer; its open state is not a lasting preference.
  if (!narrowQuery.matches) savePref('layout.sidebarHidden', hidden);
}

function applyNarrow() {
  const narrow = narrowQuery.matches;
  document.body.classList.toggle('narrow-shell', narrow);
  toggleSidebar(narrow ? true : loadPref('layout.sidebarHidden', false));
}
narrowQuery.addEventListener('change', applyNarrow);

app.focusFilter = () => filterBar.focus();
app.toggleSidebar = () => toggleSidebar();

// ---------------------------------------------------------------------------
// Live updates (SSE)

let streamHandle = null;
let changeChain = Promise.resolve();

function connectStream() {
  streamHandle?.close();
  let progressTimer = 0;
  let pending = null;
  const flushProgress = () => {
    progressTimer = 0;
    const info = state.get('info');
    if (info && pending) state.set({ info: { ...info, indexing: { ...info.indexing, ...pending, running: true } } });
    pending = null;
  };
  streamHandle = api.stream((type, data) => {
    if (type === 'open' || type === 'hello') {
      state.set({ live: true, streamState: 'open' });
    } else if (type === 'error') {
      state.set({ live: false, streamState: 'closed' });
      // EventSource gives up for good on HTTP errors (readyState 2); retry later in that case.
      if (data?.readyState === 2) setTimeout(connectStream, 5000);
    } else if (type === 'index-progress') {
      pending = data ?? {};
      if (!progressTimer) progressTimer = setTimeout(flushProgress, 250);
    } else if (type === 'index-done') {
      clearTimeout(progressTimer);
      progressTimer = 0;
      pending = null;
      // Index runs are applied in order; each publishes which sessions it touched before indexVersion moves.
      changeChain = changeChain.then(() => onIndexDone(data)).catch((err) => console.error('index-done', err));
    } else if (type === 'alarm') {
      onAlarm(data);
    }
  });
}

// ---------------------------------------------------------------------------
// Derived state the shell keeps: firing alarms, sidebar marks and the status bar counts. Clock-dependent
// states (stall, expiry) never arrive by SSE, so alarms are re-read every minute while the page is open.

async function refreshAlarms() {
  if (!api.features.derived) return;
  const res = await api.alarms({ view: 'global', state: 'firing' }).catch(() => null);
  if (!res) return;
  const before = state.get('alarms');
  const rows = res.rows ?? [];
  state.set({ alarms: rows });
  // Stall and expiry change with the clock and never arrive by SSE: when the firing set moved, the status bar
  // counts and the sidebar ⟳ of the sessions involved move with it.
  const key = (list) => list.map((a) => a.id).sort().join('\n');
  if (key(before) !== key(rows)) {
    refreshAttention();
    refreshMarks([...new Set([...before, ...rows].map((a) => a.sessionId))]);
  }
}

async function refreshAttention() {
  if (!api.features.derived) return state.set({ attention: null });
  const res = await api.failuresSummary({ view: 'global' }).catch(() => null);
  if (res) state.set({ attention: { needAttention: res.needAttention ?? 0, openAlarms: res.openAlarms ?? 0 } });
}

/** Sidebar marks: all of them, or a batch after an index run (a requested id left out is clean). */
async function refreshMarks(ids = null) {
  if (!api.features.derived) return;
  const res = await api.sessionMarks(ids).catch(() => null);
  if (!res) return;
  const next = ids ? new Map(state.get('sessionMarks')) : new Map();
  for (const id of ids ?? []) next.delete(id);
  for (const m of res.rows ?? []) next.set(m.sessionId, m);
  state.set({ sessionMarks: next });
}

const refreshDerived = debounce((changed) => {
  refreshAttention();
  refreshAlarms();
  refreshMarks(changed);
}, 1500);

/** Where an alarm leads: its episode's Lens (with its Live chip), else its delegation, else Session · Steps at its turn. */
function openAlarmTarget(a) {
  if (a.episodeId) app.openEpisode(a.episodeId);
  else if (a.delegationId) app.openLens({ kind: 'delegation', id: a.delegationId });
  else app.showSession(a.sessionId, { turnId: a.turnId });
}

function onAlarm(data) {
  refreshDerived(data?.sessionId ? [data.sessionId] : null);
  if (data?.state !== 'firing' || !data.notify) return;
  const s = meta.get(data.sessionId);
  const where = [s ? fmt.agentLabel(s.agent) : null, s?.project ?? s?.title].filter(Boolean).join(' · ');
  toast(`${ALARM[data.kind]?.word ?? data.kind}${where ? ` · ${where}` : ''}`, 'warn', { label: 'Show', onClick: () => openAlarmTarget(data) });
  notifyAlarm(data);
}

// ---------------------------------------------------------------------------
// Desktop notifications (SPEC §12.7): off by default and offered once; only the consecutive and blocker
// alarms notify, and only while the page is not in front (the in-page toast covers that case).

const notified = new Set();
const alertPrefs = () => {
  const p = loadPref('alerts', null) ?? {};
  return { ...ALERT_DEFAULTS, ...p, kinds: { ...ALERT_DEFAULTS.kinds, ...p.kinds } };
};
const notifyPermission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** Turn notifications on (asking the browser for permission) or off; resolves to whether they are on. */
async function setNotifications(on) {
  if (on && notifyPermission() === 'default') await Notification.requestPermission().catch(() => null);
  const granted = notifyPermission() === 'granted';
  savePref('alerts', { ...alertPrefs(), offered: true, enabled: on && granted });
  if (on && !granted) {
    toast(notifyPermission() === 'unsupported' ? 'This browser cannot show notifications.' : 'Notifications are blocked for this page; allow them in the browser’s site settings, then turn them on again.', 'warn');
  }
  return on && granted;
}

async function notifyAlarm(data) {
  const prefs = alertPrefs();
  const focused = document.visibilityState === 'visible' && document.hasFocus();
  const decision = notifyDecision(data, prefs, notifyPermission(), { focused });
  if (decision === 'offer') {
    savePref('alerts', { ...prefs, offered: true });
    const th = state.get('analysis')?.alarmThresholds;
    toast(`Get a desktop notification when an agent fails ${th?.consecutive ?? 6} times in a row or hits repeated environment blocks? (Offered once; View ▸ Alerts… changes it.)`, 'info', {
      label: 'Turn on notifications', onClick: () => setNotifications(true).then((on) => on && toast('Notifications are on (View ▸ Alerts…)', 'ok')),
    });
    return;
  }
  if (decision !== 'notify' || notified.has(data.id)) return;
  notified.add(data.id);
  const s = meta.get(data.sessionId);
  // The family names the block ("2 sandbox denials"); without it the text stays general.
  const family = data.kind === 'blocker' && data.episodeId
    ? await Promise.race([api.episode(data.episodeId, { outputChars: 0 }).then((l) => l?.episode?.signature?.family ?? null, () => null), new Promise((r) => setTimeout(() => r(null), 1500))])
    : null;
  const text = alarmNotification({ kind: data.kind, agent: s ? fmt.agentLabel(s.agent) : null, where: s?.project ?? s?.title ?? null, family, thresholds: state.get('analysis')?.alarmThresholds });
  if (!text) return;
  const n = new Notification(text.title, { body: text.body, tag: data.id });
  n.onclick = () => {
    window.focus();
    openAlarmTarget(data);
    n.close();
  };
}

/** View ▸ Alerts…: the notification switch, the kinds that may notify and the thresholds in effect. */
function openAlerts() {
  const p = alertPrefs();
  const perm = notifyPermission();
  const on = h('input', { type: 'checkbox', checked: p.enabled && perm === 'granted', disabled: perm === 'unsupported' });
  const kinds = ['consecutive', 'blocker'].map((k) => ({ k, box: h('input', { type: 'checkbox', checked: p.kinds[k] !== false }) }));
  const th = state.get('analysis')?.alarmThresholds;
  // A browser that blocks notifications is said beside the switch it disables, with how to allow them.
  const status = perm === 'unsupported' || perm === 'denied'
    ? h('p', { class: 'dialog-note alert-blocked', role: 'status' }, icon('warning', 12), perm === 'unsupported'
      ? 'This browser cannot show notifications.'
      : 'Notifications are blocked for this page. To allow them, open the site settings from the icon left of the address, set Notifications to Allow, then reload.')
    : null;
  const syncKinds = () => {
    for (const { box } of kinds) {
      box.disabled = !on.checked;
      box.closest('label')?.classList.toggle('is-disabled', !on.checked);
    }
  };
  on.addEventListener('change', syncKinds);
  // Thresholds are a server setting: editable when the server takes PUT (feature-detected) and is not a capture.
  const fields = th ? THRESHOLD_FIELDS.map((f) => ({ ...f, input: h('input', { class: 'text-input', type: 'number', min: '1', step: '1', value: String(th[f.key]), disabled: true, 'aria-label': f.label }) })) : [];
  const thNote = h('p', { class: 'dialog-note' }, th ? 'Checking whether this server takes threshold changes…' : 'This server reports no alarm thresholds.');
  if (th) {
    api.alarmThresholdsWritable().then((ok) => {
      const capture = state.get('info')?.mode === 'capture';
      for (const f of fields) f.input.disabled = !ok || capture;
      thNote.textContent = capture ? 'A capture keeps the thresholds it was written with.'
        : ok ? 'A server setting shared by every reader of this index. Saving a change re-runs the failure analysis of every session; alarms update when it finishes.'
        : 'This server does not take threshold changes (an older AgentShark); these are the values in effect.';
    });
  }
  openDialog({
    title: 'Alerts',
    body: [
      h('label', { class: 'check-row' }, on, ' Desktop notifications'),
      status,
      h('p', { class: 'dialog-note' }, 'Off by default. Only two alarms notify, because an offline replay found them precise; the others show as badges in the sidebar (⟳), the status bar and Failures.'),
      ...kinds.map(({ k, box }) => h('label', { class: 'check-row indent' }, box, ` ${ALARM[k].word}`,
        h('span', { class: 'muted' }, k === 'consecutive'
          ? ` · ${th?.consecutive ?? 6} non-benign failures with no success between them`
          : ` · ${th?.blocker ?? 2} sandbox, policy or network failures in one turn`))),
      th ? h('div', { class: 'alert-thresholds', role: 'group', 'aria-label': 'Alarm thresholds' },
        fields.map((f) => h('label', { class: 'alert-th' }, h('span', null, f.label), f.input, h('span', { class: 'muted' }, f.unit)))) : null,
      thNote,
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        onClick: (close) => {
          savePref('alerts', { ...alertPrefs(), offered: true, kinds: Object.fromEntries(kinds.map(({ k, box }) => [k, box.checked])) });
          setNotifications(on.checked);
          const changed = {};
          for (const f of fields) {
            const v = Number(f.input.value);
            if (f.input.disabled || v === th[f.key]) continue;
            if (!Number.isInteger(v) || v < 1) {
              thNote.textContent = `${f.label}: enter a whole number of at least 1.`;
              f.input.focus();
              return false;
            }
            changed[f.key] = v;
          }
          if (!Object.keys(changed).length) return true;
          thNote.textContent = 'Saving…';
          api.setAlarmThresholds(changed).then((analysis) => {
            state.set({ analysis: analysis ?? state.get('analysis') });
            toast('Alarm thresholds saved; the failure analysis re-runs for every session.', 'ok');
            close();
            refreshInfo();
            refreshAlarms();
          }, (err) => {
            thNote.textContent = err.code === 'index-busy'
              ? 'Another AgentShark process is writing this index right now; try again in a moment.'
              : `Could not save the thresholds: ${err.message}`;
          });
          return false;
        },
      },
    ],
  });
  syncKinds();
}

/** The alarm thresholds Alerts… edits (AlarmThresholds in src/model/types.ts). */
const THRESHOLD_FIELDS = [
  { key: 'consecutive', label: 'Consecutive failures', unit: 'failures in a row' },
  { key: 'blocker', label: 'Environment blocks', unit: 'in one turn' },
  { key: 'stallMin', label: 'Stall after', unit: 'minutes without a write' },
  { key: 'windowMin', label: 'Alarms expire after', unit: 'minutes without a write' },
];

async function onIndexDone(data) {
  // A truncated change list (a run that touched very many sessions) means "anything may have changed".
  const truncated = !!data?.changedSessionsTruncated;
  const changed = Array.isArray(data?.changedSessions) && !truncated ? data.changedSessions : null;
  let ids = changed;
  try {
    if (truncated) sidebar?.reload();
    else ids = sidebar ? await sidebar.applyChange(changed) : changed;
  } catch (err) {
    console.error('session refresh failed', err);
  }
  const version = state.get('indexVersion') + 1;
  state.set({ lastChange: { version, sessions: ids ?? null } });
  state.set({ indexVersion: version });
  refreshInfo();
  refreshDerived(truncated || !Array.isArray(changed) ? null : changed);
}

async function refreshInfo() {
  try {
    const info = await api.info();
    // Schema-4 servers report their analysis pass; older ones lack it, and the derived views say so.
    api.features.derived = !!info?.analysis;
    state.set({ info, analysis: info?.analysis ?? null, bootError: null });
    return true;
  } catch (err) {
    if (!state.get('info')) state.set({ bootError: err });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Boot

const filterBar = createFilterBar();
let sidebar = null;

function buildShell() {
  const root = document.getElementById('app');
  clear(root);
  sidebar = createSidebar();
  const splitter = h('div', { class: 'splitter splitter-x side-splitter', role: 'separator', 'aria-label': 'Resize the sessions sidebar and the workspace' });
  // A width the user chose persists; otherwise the sidebar takes its default for the window width (§8.1).
  const setSideWidth = (w) => {
    const v = Math.round(Math.max(220, Math.min(320, w)));
    document.documentElement.style.setProperty('--sidebar-w', `${v}px`);
    return v;
  };
  const stored = loadPref('layout.sidebarWidth', null);
  if (stored != null) setSideWidth(stored);
  makeSplitter(splitter, {
    axis: 'x',
    min: 220,
    max: 320,
    onStart: () => sidebar.el.getBoundingClientRect().width,
    onDrag: setSideWidth,
    onEnd: (w) => savePref('layout.sidebarWidth', setSideWidth(w)),
    onReset: () => {
      document.documentElement.style.removeProperty('--sidebar-w');
      savePref('layout.sidebarWidth', null);
      return sidebar.el.getBoundingClientRect().width;
    },
  });
  const host = createWorkspaceHost();
  host.append(createOverlay());
  root.append(createTopBar(), h('div', { class: 'body' }, sidebar.el, splitter, host), createStatusBar(), toastHost);
  root.removeAttribute('aria-busy');
  applyNarrow();
  // Choosing a session in the drawer closes it.
  state.subscribe(['scope'], () => {
    if (narrowQuery.matches) toggleSidebar(true);
  });
}

async function boot() {
  state.set({ bootError: null });
  const ok = await refreshInfo();
  if (!ok) return;
  if (!streamHandle) connectStream();
  if (!state.get('view') && !state.get('viewLoading')) rebuildView('query');
  if (!api.features.derived) return;
  refreshAttention();
  refreshMarks();
  await refreshAlarms();
  entryRule();
}

/**
 * SPEC §12.7 Entry: when alarms fire or attention items arrived since the last visit, open Failures on the
 * top item and set a removable "Since 23:04 (last visit)" chip. A route that restores an event, a filter or
 * sessions wins; otherwise the last workspace stays.
 */
async function entryRule() {
  if (bootRoute?.event || bootRoute?.filter || bootRoute?.scope.sessions || bootRoute?.lens) return;
  const lastVisit = state.get('lastVisit');
  const res = await api.failuresQueue({ view: 'global', group: 'attention', since: lastVisit ?? undefined, limit: 20 }).catch(() => null);
  const fresh = (res?.rows ?? []).filter((r) => NEEDS_ATTENTION.includes(r.section) && (lastVisit == null || r.ts >= lastVisit));
  // "Newer than the last visit" applies to alarms too: one that already fired then does not move the viewer again.
  const firing = state.get('alarms').filter((a) => lastVisit == null || a.firstTs >= lastVisit);
  if (!fresh.length && !firing.length) return;
  if (lastVisit != null && fresh.length) {
    state.set({ sinceChip: { from: lastVisit } });
    app.setTimeRange(lastVisit, null);
  }
  app.switchWorkspace('failures');
  if (fresh.length) await app.openQueueRow(fresh[0], { reveal: true, auto: true });
  else await app.openQueueRow({ kind: 'alarm', id: firing[0].id, sessionId: firing[0].sessionId, turnId: firing[0].turnId }, { reveal: true, auto: true });
}
/** The Lens item a rule opened (by identity): entryRule() or Failures filling an empty Lens, until the user picks another. */
let entryLens = null;

/** The end of this visit, for the next visit's Since chip: written every minute and when the page hides. */
function markVisit() {
  savePref('prefs.lastVisit', Date.now() * 1000);
}

applyDensity();
buildShell();
applyTheme();
const bootRoute = readHash();
applyHash();
state.subscribe(['filter', 'scope', 'showInherited', 'showDup', 'indexVersion', 'sort', 'colorRules', 'colorize'], onViewInputs);
state.subscribe(['workspace', 'filter', 'scope', 'selectedEvent', 'sessionMode', 'lensItem'], (_s, changed) => writeHash(changed.some((k) => k !== 'selectedEvent' && k !== 'lensItem')));
state.subscribe(['workspace'], (s) => savePref('workspace', s.workspace));
state.subscribe(['sessionMode'], (s) => savePref('session.mode', s.sessionMode));
state.subscribe(['stepsDescendants'], (s) => savePref('steps.descendants', s.stepsDescendants));
// The Since chip belongs to the time range it set; a new range drops it.
state.subscribe(['scope'], (s) => {
  if (s.sinceChip && s.scope.from !== s.sinceChip.from) state.set({ sinceChip: null });
});
setInterval(markVisit, 60_000);
window.addEventListener('pagehide', markVisit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') markVisit();
  else refreshAlarms();
});
setInterval(() => {
  if (document.visibilityState === 'visible') refreshAlarms();
}, 60_000);
window.addEventListener('hashchange', applyHash);
window.addEventListener('popstate', applyHash);
installKeys(app);
showWorkspace(state.get('workspace'));
boot();

// Exposed for debugging from the browser console.
window.agentshark = app;
