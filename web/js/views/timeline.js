// Timeline workspace (SPEC §7.2) and the compact strip above the Events list.
// Overview mode (no session in scope) draws one bar per session, grouped by project, with
// subagents nested under their parent. Session mode draws one lane per session and subagent,
// each with flame-graph rows: turns, then model/tool/other spans, then nested exec items.
// Everything is drawn on canvas; colors come from the CSS tokens at draw time.

import { toolKindOf } from '../lib/colors.js';
import { clear, debounce, h, icon, on, placeholder, setScopeLabel, showMenu } from '../lib/dom.js';
import { formatClock, formatDayTime, formatDuration, formatInt, formatTokens, plural, shortId } from '../lib/format.js';
import { BREAK_PX, K_MAX, createScale, findGaps, fitView, focusRange, gapThreshold, generateTicks, panView, zoomAround } from '../lib/timescale.js';
import { loadPref, savePref } from '../state.js';
import { DELEGATION, TIME_BUCKET, contextSeries, timeSegments } from '../lib/derived.js';

const HEADER_W = 240;
const AXIS_H = 26;
const MINIMAP_H = 40;
const ROW_H = 16;
const BAR_H = 12;
const SUB_ROW_H = 7;
const LANE_TOP = 8;
/** A session track's title and metadata lines (§7.12): its span rows start below them, each with a lane title. */
const TRACK_HEAD = 36;
/** Lane titles of the span levels (Mac notes 9): turns, calls, then exec and phases. */
const LEVEL_TITLE = ['Turns', 'Calls', 'Exec'];
const LANE_BOTTOM = 6;
const LANE_MIN_H = 36;
const MAX_SUBROWS = 6;
const FIT_PAD = 16;
const SPAN_LIMIT = 20000;
const MAX_TREE = 300;
const COLLAPSE_PREF = 'timeline.collapseGaps';
/** The optional Context lane (SPEC §12.7): one strip per root session in scope, at most CTX_ROOTS. */
const CTX_PREF = 'timeline.contextLane';
const CTX_H = 58;
const CTX_ROOTS = 3;
const CTX_CAPTION = 'cost and latency, not a failure cause';
const NO_GAPS = Object.freeze([]);
/** Session trees larger than this skip the full span list and load spans per visible range (W07). */
const LOD_TREE = 8;
/** A root with more descendants than this draws them as one packed "Subagents" band. */
const SUBAGENT_LANES = 6;
/** In the overview, collapsed gaps are thin dividers rather than wide bands. */
const OVERVIEW_BREAK_PX = 8;
/** More projects than this start collapsed in the overview. */
const MANY_PROJECTS = 12;
/**
 * Process and delegation lanes (SPEC §12.7): rows under a session lane's spans, at most KIND_ROWS of each, from
 * /api/processes and /api/delegations. The time-bucket strip sits under the turn bars, one per turn at least
 * STRIP_MIN_PX wide, from /api/time?turn= (TIME_FETCHES at a time, the most recently drawn first).
 */
const KIND_ROWS = 3;
const KIND_BAR_H = 10;
const STRIP_H = 7;
/** The Failures row of a session lane: failure bands of its episodes, BAND_H tall and at least BAND_MIN_W wide. */
const FAIL_ROW_H = 14;
const BAND_H = 8;
const BAND_MIN_W = 8;
/** Descendants of a banded tree that have an unrecovered episode get their own lane, the worst first, at most this many. */
const AUTO_LANES = 8;
const STRIP_MIN_PX = 14;
const TIME_FETCHES = 4;
const TIME_QUEUE = 64;
/** Theme color of each time bucket (the Session · Steps bar uses the same tokens). */
const BUCKET_KEY = { 'wait-human': 'user', 'wait-agent': 'agent', 'wait-process': 'shell', 'api-retry': 'err', compaction: 'compaction', hook: 'hook', tool: 'file', model: 'llm' };
/** Index runs that touch the drawn sessions reload them at most this often; the overview less often. */
const SESSION_REFRESH_MS = 15_000;
const OVERVIEW_REFRESH_MS = 60_000;

// ---------------------------------------------------------------------------
// Theme: canvas colors are read from the CSS tokens and re-read on theme change.

const TOKENS = {
  bg: '--bg', bgElev: '--bg-elev', bgSunken: '--bg-sunken', fg: '--fg', fgMuted: '--fg-muted', fgFaint: '--fg-faint',
  border: '--border', borderStrong: '--border-strong', accent: '--accent', focus: '--focus',
  err: '--err', warn: '--warn', note: '--note',
  user: '--c-user', llm: '--c-llm', shell: '--c-tool-shell', file: '--c-tool-file', web: '--c-tool-web', mcp: '--c-tool-mcp',
  agent: '--c-agent', context: '--c-context', compaction: '--c-compaction', hook: '--c-hook', harness: '--c-harness',
  claude: '--agent-claude', cowork: '--agent-cowork', codex: '--agent-codex', copilot: '--agent-copilot', antigravity: '--agent-antigravity',
  bandBad: '--band-unrecovered', bandSlow: '--band-slow', hatch: '--hatch-derived',
};

const AGENT_COLOR = { 'claude-code': 'claude', 'claude-cowork': 'cowork', codex: 'codex', copilot: 'copilot', antigravity: 'antigravity' };

const SPAN_LEGEND = [
  ['Turn', 'user'], ['Model call', 'llm'], ['Shell', 'shell'], ['File', 'file'], ['Web', 'web'], ['MCP', 'mcp'],
  ['Agent', 'agent'], ['Other tool', 'harness'], ['Compaction', 'compaction'], ['Hook', 'hook'], ['Retry', 'warn'], ['Permission', 'note'],
];
const AGENT_LEGEND = [['Claude Code', 'claude'], ['Cowork', 'cowork'], ['Codex', 'codex'], ['Copilot', 'copilot'], ['Antigravity', 'antigravity']];
/**
 * Failure bands (SPEC §12.7 Timeline): unrecovered episodes hatched red, recoveries after ≥3 attempts dotted amber.
 * A band is a pattern on a pale fill, never a solid bar, so it reads apart from a Shell span (a darker gold).
 */
const BAND_LEGEND = [['Unrecovered episode (hatched)', 'bandBad'], ['Recovered after ≥3 attempts (dotted)', 'bandSlow']];
const BAND_SWATCH = { bandBad: 'tl-swatch-hatch', bandSlow: 'tl-swatch-dots' };
const UNRECOVERED_SECTIONS = new Set(['blocked', 'unrecovered']);
const END_GLYPH = { recovered: '↺', 'parallel-ok': '↺', 'recovered-later': '△', pivoted: '△', interrupted: '‖', 'ended-on-failure': '✕', open: '…' };
const OUTCOME_WORD = { recovered: 'recovered', 'parallel-ok': 'parallel ok', 'recovered-later': 'recovered later', pivoted: 'pivoted', interrupted: 'interrupted', 'ended-on-failure': 'ended on failure', open: 'still open' };

/** Which band an episode gets: 'bad' (unrecovered), 'slow' (recovered after ≥3 attempts) or null. */
export function bandKind(ep) {
  if (UNRECOVERED_SECTIONS.has(ep.section) || ep.outcome === 'ended-on-failure') return 'bad';
  if ((ep.outcome === 'recovered' || ep.outcome === 'recovered-later') && ep.nAttempts >= 3) return 'slow';
  return null;
}

let probe = null;
/** Resolve any CSS color to sRGB by painting one pixel. */
function rgbOf(css) {
  probe ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#808080';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const remPx = parseFloat(cs.fontSize) || 16;
  const px = (name, fallback) => {
    const v = cs.getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? (/r?em$/.test(v) ? n * remPx : n) : fallback;
  };
  const color = {};
  for (const [key, name] of Object.entries(TOKENS)) color[key] = cs.getPropertyValue(name).trim() || '#808080';
  // Label color on a filled bar: whichever of --fg and --bg contrasts more with the fill.
  const fg = rgbOf(color.fg);
  const bg = rgbOf(color.bg);
  const ink = {};
  for (const key of Object.keys(color)) {
    const c = rgbOf(color[key]);
    ink[key] = contrast(c, fg) >= contrast(c, bg) ? color.fg : color.bg;
  }
  return {
    color,
    ink,
    fontUi: cs.getPropertyValue('--font-ui').trim() || 'sans-serif',
    fsXs: px('--fs-xs', 11),
    fsSm: px('--fs-sm', 12),
  };
}

let themeCache = null;
const theme = () => (themeCache ??= readTheme());

/** Calls redraw after the theme changes; returns the remover. */
function watchTheme(redraw) {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    themeCache = null;
    redraw();
  };
  window.addEventListener('agentshark:theme', handler);
  mq.addEventListener('change', handler);
  return () => {
    window.removeEventListener('agentshark:theme', handler);
    mq.removeEventListener('change', handler);
  };
}

// ---------------------------------------------------------------------------
// Data access shared with the Flow workspace. Results are cached until the index changes.

const memo = { version: null, map: new Map() };

function cached(app, key, fetch) {
  const version = app.state.get('indexVersion') ?? 0;
  if (memo.version !== version) {
    memo.version = version;
    memo.map.clear();
  }
  let p = memo.map.get(key);
  if (!p) {
    p = fetch().catch((err) => {
      if (memo.map.get(key) === p) memo.map.delete(key);
      throw err;
    });
    memo.map.set(key, p);
    if (memo.map.size > 500) memo.map.delete(memo.map.keys().next().value);
  }
  return p;
}

/** GET /api/sessions/:id, cached per index version. */
export const loadSessionDetail = (app, id) => cached(app, 'session:' + id, () => app.api.session(id));
/** GET /api/events/:id, cached per index version. */
export const loadEvent = (app, id) => cached(app, 'event:' + id, () => app.api.event(id));
const loadOverview = (app) =>
  cached(app, 'overview', async () => ((await app.api.overview({}))?.sessions ?? []).filter((s) => Number.isFinite(s.start)));

/** Rows of a view page; accepts both `{rows}` (SPEC §6) and a bare array (IndexQueries.viewRows). */
export const rowsOf = (res) => (Array.isArray(res) ? res : res?.rows ?? []);
/** Turn spans of a session detail; accepts both `turns` (api.ts) and `spans.turns` (SPEC §6). */
const turnsOf = (detail) => detail?.turns ?? detail?.spans?.turns ?? [];

/**
 * The scoped sessions and their descendants in display order: each session followed by its
 * children by start time. Only sessions with children are fetched; leaf children come from
 * their parent's `children` list.
 */
/** The tree's top sessions; /api/spans adds their descendants, so a tree of hundreds of subagents stays a short URL. */
function rootIds(tree) {
  return tree.filter((n) => n.depth === 0).map((n) => n.session.id);
}

async function loadSessionTree(app, ids) {
  const nodes = new Map();
  let level = [...new Set(ids)];
  while (level.length && nodes.size < MAX_TREE) {
    const details = await Promise.all(level.map((id) => loadSessionDetail(app, id).catch(() => null)));
    const next = new Set();
    level.forEach((id, i) => {
      const d = details[i];
      if (!d?.session) return;
      nodes.set(id, { session: d.session, turns: turnsOf(d) });
      for (const c of d.children ?? []) {
        if (nodes.has(c.id)) continue;
        if (c.nChildren > 0) next.add(c.id);
        else nodes.set(c.id, { session: c, turns: [] });
      }
    });
    level = [...next].filter((id) => !nodes.has(id)).slice(0, Math.max(0, MAX_TREE - nodes.size));
  }
  const kids = new Map();
  for (const n of nodes.values()) {
    const p = n.session.parentId;
    if (p && p !== n.session.id && nodes.has(p)) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(n);
    }
  }
  const out = [];
  const seen = new Set();
  const visit = (n, depth) => {
    if (seen.has(n.session.id)) return;
    seen.add(n.session.id);
    out.push({ ...n, depth });
    const children = (kids.get(n.session.id) ?? []).sort((a, b) => (a.session.start ?? 0) - (b.session.start ?? 0));
    for (const c of children) visit(c, depth + 1);
  };
  const isRoot = (n) => !(n.session.parentId && nodes.has(n.session.parentId));
  for (const id of ids) if (nodes.has(id) && isRoot(nodes.get(id))) visit(nodes.get(id), 0);
  for (const n of nodes.values()) visit(n, 0);
  return out;
}

/** [min start, max end] over items with a finite start, or null. */
function extentOf(items) {
  let a = Infinity;
  let b = -Infinity;
  for (const it of items) {
    if (!Number.isFinite(it?.start)) continue;
    a = Math.min(a, it.start);
    b = Math.max(b, Number.isFinite(it.end) ? it.end : it.start);
  }
  return a <= b ? [a, Math.max(b, a + 1000)] : null;
}

/**
 * Per-time-bin event counts of a view across [from, to]. Each uncollapsed segment gets its own
 * request so busy stretches keep their resolution; with many segments one request covers all.
 * @returns {Promise<{from: number, binUs: number, bins: {count: number, errors: number}[]}[]>}
 */
async function loadDensity(app, viewId, s, from, to, width) {
  const segs = s.segments(from, to).filter((g) => g.end > g.start);
  const parts =
    segs.length <= 16
      ? segs.map((g) => ({ ...g, bins: Math.max(1, Math.min(500, Math.round((s.x(g.end) - s.x(g.start)) / 3))) }))
      : [{ start: from, end: to, bins: Math.max(1, Math.min(1000, Math.round(width / 3))) }];
  const res = await Promise.all(
    parts.map((p) => app.api.histogram(viewId, p.bins, Math.floor(p.start), Math.ceil(p.end)).catch(() => null)),
  );
  return res.filter((r) => r && Array.isArray(r.bins) && r.binUs > 0);
}

/**
 * Id of the view row whose time is closest to t. Small views are scanned whole, which is exact
 * for any sort order; larger ones are binary-searched, which assumes rows sorted by time.
 */
async function eventNear(app, view, t) {
  const page = async (offset, limit) => rowsOf(await app.api.viewRows(view.viewId, offset, limit));
  let rows;
  if (view.count <= 2000) rows = [...(await page(0, 1000)), ...(view.count > 1000 ? await page(1000, 1000) : [])];
  else {
    let lo = 0;
    let hi = view.count - 1;
    while (hi - lo > 64) {
      const mid = (lo + hi) >> 1;
      const r = (await page(mid, 1))[0];
      if (!r) break;
      if (r.ts < t) lo = mid;
      else hi = mid;
    }
    rows = await page(lo, Math.min(1000, hi - lo + 1));
  }
  let best = null;
  for (const r of rows) if (!best || Math.abs(r.ts - t) < Math.abs(best.ts - t)) best = r;
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// Items and rows. An item is one bar; a row holds start-sorted items plus a running maximum of
// their ends, so the bars overlapping a time range are found by binary search even when they
// overlap each other.

const LEVEL = { turn: 0, exec: 2, phase: 2 };
const TOOL_COLOR = { shell: 'shell', file: 'file', web: 'web', mcp: 'mcp', agent: 'agent' };

function spanColor(sp) {
  switch (sp.kind) {
    case 'turn':
      return 'user';
    case 'llm':
      return 'llm';
    case 'tool':
      if (sp.linkSession) return 'agent';
      return TOOL_COLOR[sp.attrs?.tool?.kind ?? toolKindOf(sp.attrs?.tool?.name ?? sp.name)] ?? 'harness';
    case 'exec':
      return 'shell';
    case 'workflow':
    case 'phase':
      return 'agent';
    case 'compaction':
      return 'compaction';
    case 'hook':
      return 'hook';
    case 'retry':
      return 'warn';
    case 'permission':
      return 'note';
    default:
      return 'context';
  }
}

function spanItem(sp) {
  const end = sp.end ?? (sp.dur != null ? sp.start + sp.dur : sp.start);
  return { start: sp.start, end: Math.max(end, sp.start), color: spanColor(sp), label: sp.name || sp.kind, err: sp.status === 'error', span: sp };
}

function sessionItem(s) {
  return { start: s.start, end: Math.max(s.end ?? s.start, s.start), color: AGENT_COLOR[s.agent] ?? 'harness', label: s.title || shortId(s.id), session: s };
}

/**
 * End of a process or delegation bar with no end logged: a run still `running` reaches the end of its session
 * (`until`); any other has no known end and stays a stub at its start (drawn with a dashed tail).
 */
const openEnd = (start, running, until) => (running ? Math.max(until ?? start, start) : start);

/** A background process bar. */
export function processItem(p, until) {
  const open = p.endTs == null;
  const end = open ? openEnd(p.startTs, p.status === 'running', until) : Math.max(p.endTs, p.startTs);
  const exit = p.exitCode != null ? ` · exit ${p.exitCode}` : p.status === 'running' || p.status === 'killed' ? ` · ${p.status}` : open ? ' · no end logged' : '';
  return { start: p.startTs, end, color: 'shell', label: `${p.program ?? 'process'}${exit}`, err: (p.exitCode ?? 0) !== 0, open, running: open && p.status === 'running', proc: p };
}

/** A delegation bar from spawn to the child's end; a silent child failure is marked ⇣ and outlined. */
export function delegationItem(d, until) {
  const open = d.endTs == null;
  const end = open ? openEnd(d.startTs, d.outcome === 'running', until) : Math.max(d.endTs, d.startTs);
  const what = d.childTitle || d.taskExcerpt || 'delegation';
  return {
    start: d.startTs, end, color: 'agent', label: `${d.silent ? '⇣ ' : ''}${what} · ${DELEGATION[d.outcome]?.word ?? d.outcome}`,
    err: d.silent || d.outcome === 'failed' || d.outcome === 'blocked', open, running: open && d.outcome === 'running', deleg: d,
  };
}

const byStart = (a, b) => a.start - b.start;

function makeRow(items, y, rowH, barH) {
  const maxEnd = new Float64Array(items.length);
  let m = -Infinity;
  items.forEach((it, i) => {
    m = Math.max(m, it.end);
    maxEnd[i] = m;
    it.y = y + Math.round((rowH - barH) / 2);
    it.h = barH;
  });
  return { y, h: rowH, items, maxEnd };
}

/** First-fit packing of start-sorted items into non-overlapping rows; overflow shares the last row. */
function pack(items, maxRows) {
  const rows = [];
  const ends = [];
  for (const it of items) {
    let r = ends.findIndex((e) => e <= it.start);
    if (r < 0) {
      if (rows.length < maxRows) {
        r = rows.length;
        rows.push([]);
        ends.push(-Infinity);
      } else r = rows.length - 1;
    }
    rows[r].push(it);
    ends[r] = Math.max(ends[r], it.end);
  }
  return rows;
}

function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const NO_EXTRA = Object.freeze({});
/** A /api/time answer that is on its way. */
const TIME_LOADING = Object.freeze({ loading: true });

/**
 * Lane for one session: flame-graph rows of its spans, the time-bucket strip under its turns (extra.strip),
 * then its delegations and processes (extra.delegs, extra.procs). `kinds` names those rows for the header.
 */
function sessionLane(node, spansOf, y, itemById, extra = NO_EXTRA) {
  const s = node.session;
  const levels = [[], [], []];
  let band = Number.isFinite(s.start) ? { start: s.start, end: s.end ?? s.start } : null;
  for (const sp of spansOf(s.id)) {
    if (sp.kind === 'session') {
      band = spanItem(sp);
      continue;
    }
    const it = spanItem(sp);
    itemById.set(sp.id, it);
    levels[LEVEL[sp.kind] ?? 1].push(it);
  }
  const rows = [];
  const kinds = [];
  let ry = y + TRACK_HEAD;
  levels.forEach((items, level) => {
    if (level === 2 && !items.length) return;
    items.sort(byStart);
    if (items.length) kinds.push({ y: ry, h: ROW_H, label: `${LEVEL_TITLE[level]} ${formatInt(items.length)}` });
    for (const packed of items.length ? pack(items, MAX_SUBROWS) : [[]]) {
      rows.push(makeRow(packed, ry, ROW_H, BAR_H));
      ry += ROW_H;
    }
    if (level === 0 && items.length && extra.strip) {
      rows.push({ y: ry, h: STRIP_H, items: [], maxEnd: new Float64Array(0), strip: items });
      ry += STRIP_H;
    }
  });
  const until = band?.end ?? s.end ?? null;
  for (const [label, list, item] of [['Delegations', extra.delegs, delegationItem], ['Processes', extra.procs, processItem]]) {
    if (!list?.length) continue;
    const packed = pack(list.map((x) => item(x, until)).filter((it) => Number.isFinite(it.start)).sort(byStart), KIND_ROWS);
    kinds.push({ y: ry, h: packed.length * ROW_H, label: `${label} ${formatInt(list.length)}` });
    for (const items of packed) {
      rows.push(makeRow(items, ry, ROW_H, KIND_BAR_H));
      ry += ROW_H;
    }
  }
  // Its own row for the failure bands, named in the header like the rows above.
  let failY = null;
  if (extra.fails) {
    kinds.push({ y: ry, h: FAIL_ROW_H, label: `Failures ${formatInt(extra.fails)}` });
    failY = ry;
    ry += FAIL_ROW_H;
  }
  return { y, h: Math.max(LANE_MIN_H, ry - y + LANE_BOTTOM), rows, band, session: s, depth: node.depth, kinds, failY };
}

/**
 * Session mode lanes. A root with few subagents keeps one lane per subagent; a root with many
 * gets one packed "Subagents (N)" band of session bars under its lane, and only subagents the
 * user expanded (or that are in scope) get their own lanes, sorted by start.
 */
export function layoutSessions(tree, spans, expanded = new Set(), extraOf = () => NO_EXTRA) {
  const bySession = new Map();
  for (const sp of spans) {
    if (!Number.isFinite(sp.start)) continue;
    if (!bySession.has(sp.session)) bySession.set(sp.session, []);
    bySession.get(sp.session).push(sp);
  }
  const spansOf = (id) => bySession.get(id) ?? [];
  const groups = [];
  for (const node of tree) {
    if (node.depth === 0 || !groups.length) groups.push({ root: node, desc: [] });
    else groups[groups.length - 1].desc.push(node);
  }
  const lanes = [];
  const itemById = new Map();
  let y = 0;
  const push = (lane) => {
    lane.index = lanes.length;
    lanes.push(lane);
    y += lane.h;
  };
  const lane = (node) => sessionLane(node, spansOf, y, itemById, extraOf(node.session.id));
  for (const { root, desc } of groups) {
    push(lane(root));
    if (desc.length <= SUBAGENT_LANES) {
      for (const node of desc) push(lane(node));
      continue;
    }
    const items = desc.filter((n) => Number.isFinite(n.session.start)).map((n) => ({ ...sessionItem(n.session), inBand: true })).sort(byStart);
    const rows = [];
    let ry = y + 6;
    for (const packed of pack(items, MAX_SUBROWS)) {
      rows.push(makeRow(packed, ry, SUB_ROW_H, SUB_ROW_H - 2));
      ry += SUB_ROW_H;
    }
    const failing = desc.filter((n) => extraOf(n.session.id).bad).length;
    push({ y, h: Math.max(30, ry - y + 6), rows, band: null, session: null, bandOf: root.session, count: desc.length, failing, depth: 1 });
    const open = desc.filter((n) => expanded.has(n.session.id)).sort((a, b) => (a.session.start ?? 0) - (b.session.start ?? 0));
    for (const node of open) push({ ...lane(node), depth: 1, closable: true });
  }
  return { lanes, height: y, itemById };
}

function layoutOverview(sessions, collapsedGroups) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const kids = new Map();
  const roots = [];
  for (const s of sessions) {
    const parent = s.parentId && s.parentId !== s.id ? byId.get(s.parentId) : null;
    if (!parent) roots.push(s);
    else {
      if (!kids.has(parent.id)) kids.set(parent.id, []);
      kids.get(parent.id).push(s);
    }
  }
  const descendants = (s) => {
    const out = [];
    const stack = [...(kids.get(s.id) ?? [])];
    const seen = new Set();
    while (stack.length) {
      const c = stack.pop();
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      stack.push(...(kids.get(c.id) ?? []));
    }
    return out;
  };
  const groups = new Map();
  for (const r of roots) {
    const key = r.project || '(no project)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const lastEnd = (list) => Math.max(...list.map((s) => s.end ?? s.start));
  const ordered = [...groups.entries()].sort((a, b) => lastEnd(b[1]) - lastEnd(a[1]));

  const lanes = [];
  let y = 0;
  for (const [project, members] of ordered) {
    const items = members.map(sessionItem).sort(byStart);
    const collapsed = collapsedGroups.has(project);
    const rows = [];
    let ry = y + LANE_TOP;
    let subCount = 0;
    for (const track of collapsed ? [items] : pack(items, Infinity)) {
      rows.push(makeRow(track, ry, ROW_H, BAR_H));
      ry += ROW_H;
      const subs = track.flatMap((it) => descendants(it.session)).map(sessionItem).sort(byStart);
      subCount += subs.length;
      if (collapsed) continue;
      for (const packed of subs.length ? pack(subs, MAX_SUBROWS) : []) {
        rows.push(makeRow(packed, ry, SUB_ROW_H, SUB_ROW_H - 2));
        ry += SUB_ROW_H;
      }
    }
    const lh = Math.max(collapsed ? 24 : LANE_MIN_H, ry - y + LANE_BOTTOM);
    lanes.push({ index: lanes.length, y, h: lh, rows, project, count: members.length, subCount, collapsed });
    y += lh;
  }
  return { lanes, height: y, itemById: new Map() };
}

/** Rows of derived list pages grouped by sessionId; `keep` filters them. */
function bySession(pages, keep = () => true) {
  const by = new Map();
  for (const r of pages.flatMap((p) => p?.rows ?? [])) {
    if (!keep(r)) continue;
    if (!by.has(r.sessionId)) by.set(r.sessionId, []);
    by.get(r.sessionId).push(r);
  }
  return by;
}

/** Lanes intersecting [top, top + height) of the lane coordinate space. */
function visibleLanes(lanes, top, height) {
  let lo = 0;
  let hi = lanes.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (lanes[m].y + lanes[m].h <= top) lo = m + 1;
    else hi = m;
  }
  const out = [];
  for (let i = lo; i < lanes.length && lanes[i].y < top + height; i++) out.push(lanes[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Drawing helpers shared by the workspace and the strip.

function setupCanvas(canvas, w, hgt) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(hgt * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function fitText(ctx, text, maxW) {
  if (maxW <= 0 || !text) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, m) + '…').width <= maxW) lo = m;
    else hi = m - 1;
  }
  return lo ? text.slice(0, lo) + '…' : '';
}

/**
 * Draw the bars of `rows` that intersect [tA, tB]. Bars narrower than a pixel are merged per
 * pixel column, and fills are batched per color so tens of thousands of bars stay cheap.
 */
function drawItems(ctx, T, s, rows, { tA, tB, ox, oy, xMin, xMax }) {
  const batches = new Map();
  const errs = [];
  const labels = [];
  for (const row of rows) {
    const { items, maxEnd } = row;
    let lastPx = -Infinity;
    // Bars of one row can overlap (a collapsed lane); a label never runs into the previous one.
    let labelEnd = -Infinity;
    for (let i = lowerBound(maxEnd, tA); i < items.length; i++) {
      const it = items[i];
      if (it.start > tB) break;
      if (it.end < tA) continue;
      let x0 = ox + s.x(it.start);
      let x1 = ox + s.x(it.end);
      if (x1 - x0 < 1) {
        const px = Math.floor(x0);
        if (px === lastPx) continue;
        lastPx = px;
        x1 = x0 + 1;
      }
      x0 = Math.max(x0, xMin - 2);
      x1 = Math.min(x1, xMax + 2);
      const y = oy + it.y;
      if (!batches.has(it.color)) batches.set(it.color, []);
      batches.get(it.color).push(x0, y, x1 - x0, it.h);
      if (it.err) errs.push(x0, y, x1 - x0, it.h);
      if (x1 - x0 > 30 && it.h >= 10 && x0 >= labelEnd) {
        labels.push(it, x0, y, x1 - x0);
        labelEnd = x1;
      }
    }
  }
  for (const [color, b] of batches) {
    ctx.fillStyle = T.color[color] ?? T.color.harness;
    ctx.beginPath();
    for (let i = 0; i < b.length; i += 4) ctx.rect(b[i], b[i + 1], b[i + 2], b[i + 3]);
    ctx.fill();
  }
  if (errs.length) {
    ctx.strokeStyle = T.color.err;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < errs.length; i += 4) ctx.rect(errs[i] + 1, errs[i + 1] + 1, Math.max(0, errs[i + 2] - 2), errs[i + 3] - 2);
    ctx.stroke();
  }
  if (labels.length) {
    ctx.font = `${T.fsXs}px ${T.fontUi}`;
    ctx.textBaseline = 'middle';
    const charW = T.fsXs * 0.58;
    for (let i = 0; i < labels.length; i += 4) {
      const [it, x, y, w] = [labels[i], labels[i + 1], labels[i + 2], labels[i + 3]];
      const lx = Math.max(x, xMin);
      const max = Math.floor((x + w - lx - 8) / charW);
      if (max < 2) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(lx, y, x + w - lx, it.h);
      ctx.clip();
      ctx.fillStyle = T.ink[it.color] ?? T.color.fg;
      ctx.fillText(it.label.length > max ? it.label.slice(0, max - 1) + '…' : it.label, lx + 4, y + it.h / 2 + 0.5);
      ctx.restore();
    }
  }
}

/** Axis band with tick marks and labels; labels that would run into a break are left out. */
function drawAxis(ctx, T, s, ticks, x0, width, height) {
  const breaks = s.breaks(s.t(0), s.t(width)).map((b) => x0 + b.x);
  ctx.fillStyle = T.color.bgElev;
  ctx.fillRect(x0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, 0, width, height);
  ctx.clip();
  ctx.font = `${T.fsXs}px ${T.fontUi}`;
  ctx.textBaseline = 'middle';
  let right = -Infinity;
  for (const tk of ticks.ticks) {
    const x = Math.round(x0 + tk.x);
    const len = tk.major ? 8 : 5;
    ctx.fillStyle = T.color.fgFaint;
    ctx.fillRect(x, height - len, 1, len);
    const tw = ctx.measureText(tk.text).width;
    const lx = x + 3;
    if (lx < right + 8 || lx + tw > x0 + width) continue;
    if (breaks.some((bx) => lx < bx + BREAK_PX + 2 && lx + tw > bx - 2)) continue;
    ctx.fillStyle = tk.major ? T.color.fg : T.color.fgMuted;
    ctx.fillText(tk.text, lx, height / 2 - 1);
    right = lx + tw;
  }
  ctx.restore();
  ctx.fillStyle = T.color.border;
  ctx.fillRect(x0, height - 1, width, 1);
}

/**
 * Collapsed gaps: a sunken band with zigzag edges, optionally labeled with the gap length. The
 * 'line' style (overview) draws a thin dashed divider; its label goes on the axis.
 */
function drawBreaks(ctx, T, s, tA, tB, x0, y0, y1, label, style = 'zigzag', breakPx = BREAK_PX) {
  for (const b of s.breaks(tA, tB)) {
    const x = x0 + b.x;
    if (style === 'line') {
      ctx.save();
      ctx.strokeStyle = T.color.borderStrong;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x + breakPx / 2) + 0.5, y0);
      ctx.lineTo(Math.round(x + breakPx / 2) + 0.5, y1);
      ctx.stroke();
      ctx.restore();
      if (label) {
        ctx.font = `${T.fsXs}px ${T.fontUi}`;
        ctx.textBaseline = 'middle';
        const text = formatDuration(b.end - b.start).split(' ')[0];
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = T.color.bgElev;
        ctx.fillRect(x + breakPx / 2 - tw / 2 - 2, y0 + 2, tw + 4, T.fsXs + 2);
        ctx.fillStyle = T.color.fgMuted;
        ctx.fillText(text, x + breakPx / 2 - tw / 2, y0 + 3 + T.fsXs / 2);
      }
      continue;
    }
    ctx.fillStyle = T.color.bgSunken;
    ctx.fillRect(x, y0, BREAK_PX, y1 - y0);
    ctx.strokeStyle = T.color.borderStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const ex of [x + 3.5, x + BREAK_PX - 3.5]) {
      ctx.moveTo(ex, y0);
      for (let y = y0, k = 0; y < y1; y += 4, k++) ctx.lineTo(ex + (k % 2 ? 2 : -2), y + 4);
    }
    ctx.stroke();
    if (!label) continue;
    ctx.save();
    ctx.translate(x + BREAK_PX / 2, y0 + 6);
    ctx.rotate(Math.PI / 2);
    ctx.font = `${T.fsXs}px ${T.fontUi}`;
    ctx.textBaseline = 'middle';
    const text = formatDuration(b.end - b.start);
    ctx.fillStyle = T.color.bgSunken;
    ctx.fillRect(-2, -T.fsXs / 2 - 1, ctx.measureText(text).width + 4, T.fsXs + 2);
    ctx.fillStyle = T.color.fgMuted;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

function drawDensity(ctx, T, s, parts, x0, top, height, fill) {
  let max = 0;
  for (const p of parts) for (const b of p.bins) max = Math.max(max, b.count ?? 0);
  if (!max) return;
  for (const [key, color] of [['count', fill], ['errors', T.color.err]]) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const p of parts) {
      p.bins.forEach((b, i) => {
        const v = b[key] ?? 0;
        if (!v) return;
        const xa = x0 + s.x(p.from + i * p.binUs);
        const xb = x0 + s.x(p.from + (i + 1) * p.binUs);
        const bh = Math.max(1, Math.sqrt(v / max) * height);
        ctx.rect(xa, top + height - bh, Math.max(1, xb - xa - 0.5), bh);
      });
    }
    ctx.fill();
  }
}

/** Dim the time outside the scope's [from, to] range and mark its edges. */
function drawScopeRange(ctx, T, s, scope, x0, y0, width, height) {
  if (scope?.from == null && scope?.to == null) return;
  const a = scope.from != null ? x0 + s.x(scope.from) : x0 - 1;
  const b = scope.to != null ? x0 + s.x(scope.to) : x0 + width + 1;
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = T.color.bg;
  if (a > x0) ctx.fillRect(x0, y0, Math.min(a, x0 + width) - x0, height);
  if (b < x0 + width) ctx.fillRect(Math.max(b, x0), y0, x0 + width - Math.max(b, x0), height);
  ctx.restore();
  ctx.fillStyle = T.color.accent;
  if (scope.from != null) ctx.fillRect(a - 1, y0, 2, height);
  if (scope.to != null) ctx.fillRect(b - 1, y0, 2, height);
}

function drawMarker(ctx, T, x, y0, height) {
  ctx.fillStyle = T.color.focus;
  ctx.fillRect(Math.round(x) - 1, y0, 2, height);
  ctx.beginPath();
  ctx.moveTo(x - 5, y0);
  ctx.lineTo(x + 5, y0);
  ctx.lineTo(x, y0 + 6);
  ctx.fill();
}

function drawBrush(ctx, T, xa, xb, y0, height) {
  const x = Math.min(xa, xb);
  const w = Math.abs(xb - xa);
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = T.color.accent;
  ctx.fillRect(x, y0, w, height);
  ctx.restore();
  ctx.fillStyle = T.color.accent;
  ctx.fillRect(x, y0, 1, height);
  ctx.fillRect(x + w - 1, y0, 1, height);
}

// ---------------------------------------------------------------------------
// Tooltips

const tipRow = (k, v) => h('div', { class: 'tl-tip-row' }, h('span', { class: 'tl-tip-k' }, k), h('span', { class: 'tl-tip-v' }, v));
const dur = (us) => formatDuration(us) || '—';

function spanTip(sp) {
  const d = sp.dur ?? (sp.end != null ? sp.end - sp.start : null);
  const tok = sp.attrs?.tokens;
  const toolKind = sp.attrs?.tool?.kind;
  return [
    h('div', { class: 'tl-tip-title' }, sp.name || sp.kind),
    tipRow('Kind', toolKind ? `${sp.kind} · ${toolKind}` : sp.kind),
    tipRow('Duration', `${dur(d)} (${sp.durSrc || 'unknown'})`),
    tipRow('Start', formatClock(sp.start)),
    tok && (tok.input != null || tok.output != null)
      ? tipRow('Tokens', `in ${formatTokens(tok.input) || '—'} · out ${formatTokens(tok.output) || '—'}`)
      : null,
    tipRow('Status', sp.status || 'unknown'),
    sp.attrs?.llm?.model ? tipRow('Model', sp.attrs.llm.model) : null,
    sp.attrs?.tool?.input_summary ? tipRow('Input', sp.attrs.tool.input_summary) : null,
    sp.linkSession ? tipRow('Subagent', shortId(sp.linkSession)) : null,
  ];
}

function sessionTip(s) {
  return [
    h('div', { class: 'tl-tip-title' }, s.title || shortId(s.id)),
    tipRow('Agent', [s.agent, s.role].filter(Boolean).join(' · ')),
    s.project ? tipRow('Project', s.project) : null,
    tipRow('Time', `${formatClock(s.start)} → ${formatClock(s.end ?? s.start, { date: false })}`),
    tipRow('Duration', dur((s.end ?? s.start) - s.start)),
    tipRow('Events', `${formatInt(s.nEvents ?? 0)}${s.nErrors ? ` · ${formatInt(s.nErrors)} errors` : ''}`),
    s.tokOut != null ? tipRow('Output tokens', formatTokens(s.tokOut) || '0') : null,
  ];
}

function processTip(it) {
  const p = it.proc;
  return [
    h('div', { class: 'tl-tip-title' }, `Process · ${p.program ?? 'unknown program'}`),
    tipRow('Key', p.procKey),
    tipRow('Status', `${p.status}${p.exitCode != null ? ` · exit ${p.exitCode}${p.exitSrc ? ` (${p.exitSrc})` : ''}` : ''}`),
    tipRow('Time', `${formatClock(p.startTs)} → ${p.endTs != null ? formatClock(p.endTs, { date: false }) : 'still open'}`),
    tipRow('Duration', p.endTs != null ? dur(p.endTs - p.startTs) : p.status === 'running' ? `≥ ${dur(it.end - it.start)} (still running)` : 'unknown (no end logged)'),
    tipRow('Polls', `${formatInt(p.nPolls)} polls · ${formatInt(p.nInputs)} inputs`),
    tipRow('Click', 'Follow the process'),
  ];
}

function delegationTip(it) {
  const d = it.deleg;
  return [
    h('div', { class: 'tl-tip-title' }, `${d.silent ? '⇣ Silent child failure · ' : ''}Delegation · ${DELEGATION[d.outcome]?.word ?? d.outcome}`),
    d.childTitle ? tipRow('Child', d.childTitle) : null,
    d.taskExcerpt ? tipRow('Task', d.taskExcerpt.length > 160 ? `${d.taskExcerpt.slice(0, 159)}…` : d.taskExcerpt) : null,
    tipRow('Kind', [d.kind, d.childRole].filter(Boolean).join(' · ')),
    tipRow('Outcome source', d.outcomeSrc ?? 'unknown'),
    // Set only for a failed child the parent saw a result of.
    d.parentTold != null ? tipRow('Parent told', d.parentTold ? 'yes' : 'no') : null,
    tipRow('Time', `${formatClock(d.startTs)} → ${d.endTs != null ? formatClock(d.endTs, { date: false }) : 'still open'}`),
    d.parentWaitUs != null ? tipRow('Parent waited', dur(d.parentWaitUs)) : null,
    tipRow('Click', 'Follow the delegation'),
  ];
}

/** The time-bucket strip of one turn: wall time by bucket, largest first; unattributed time is never model time. */
function stripTip(it, data) {
  const title = h('div', { class: 'tl-tip-title' }, `Turn time · ${it.label}`);
  if (data === undefined || data === TIME_LOADING) return [title, tipRow('Buckets', 'loading…')];
  if (!data) return [title, tipRow('Buckets', 'not available for this turn')];
  const segs = timeSegments({ buckets: data.buckets ?? [], unattributedUs: data.unattributedUs ?? 0, wallUs: data.wallUs }).sort((a, b) => b.us - a.us);
  return [
    title,
    tipRow('Wall', dur(data.wallUs)),
    ...segs.slice(0, 6).map((g) => tipRow(g.name === 'unattributed' ? 'unattributed' : TIME_BUCKET[g.name] ?? g.name,
      `${dur(g.us)} · ${Math.round(g.frac * 100)}%${g.loggedFrac < 1 && g.name !== 'unattributed' ? ` (${Math.round((1 - g.loggedFrac) * 100)}% derived)` : ''}`)),
    tipRow('Click', 'show the turn in Session · Steps'),
  ];
}

function gapTip(g) {
  return [
    h('div', { class: 'tl-tip-title' }, `Idle gap · ${dur(g.end - g.start)}`),
    tipRow('From', formatClock(g.start)),
    tipRow('To', formatClock(g.end)),
  ];
}

function placeTooltip(tip, content, x, y, w, hgt) {
  if (!content) {
    tip.hidden = true;
    return;
  }
  clear(tip).append(...content.filter(Boolean));
  tip.hidden = false;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = x + 14;
  if (left + tw > w - 4) left = x - tw - 14;
  let top = y + 16;
  if (top + th > hgt - 4) top = y - th - 10;
  tip.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, top)}px)`;
}

/**
 * The legend: a single metadata line (§7.12). Items that do not fit go to a trailing "+n ▾" menu, so nothing is cut
 * silently.
 */
function renderLegend(el, entries) {
  clear(el);
  const items = entries.map(([label, key, pinned = false]) => {
    const sw = key ? h('span', { class: ['tl-swatch', BAND_SWATCH[key]], style: BAND_SWATCH[key] ? { color: `var(${TOKENS[key]})` } : { background: `var(${TOKENS[key]})` } }) : null;
    return { label, pinned, el: h('span', { class: 'tl-legend-item' }, sw, label) };
  });
  if (entries.includes(SPAN_LEGEND[0])) items.push({ label: 'Error', el: h('span', { class: 'tl-legend-item' }, h('span', { class: 'tl-swatch tl-swatch-err' }), 'Error') });
  const more = h('button', { class: 'tool-btn tl-legend-more', type: 'button', hidden: true, 'aria-haspopup': 'menu' });
  el.append(...items.map((x) => x.el), more);
  requestAnimationFrame(() => {
    const hidden = [];
    for (let i = items.length - 1; i > 0 && el.scrollWidth > el.clientWidth + 1; i--) {
      if (items[i].pinned) continue;
      items[i].el.hidden = true;
      hidden.unshift(items[i]);
      more.hidden = false;
      more.textContent = `+${hidden.length} more`;
    }
    more.onclick = () => showMenu(more, hidden.map((x) => ({ label: x.label, disabled: true })));
  });
}

/** Hatching for a band: diagonal strokes inside the rectangle. */
function hatch(ctx, x, y, w, hgt, color) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, hgt);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -hgt; i < w; i += 4) {
    ctx.moveTo(x + i, y + hgt);
    ctx.lineTo(x + i + hgt, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Dots for a band of a slow recovery: a pattern no span uses. */
function dots(ctx, x, y, w, hgt, color) {
  ctx.fillStyle = color;
  for (let dx = 2; dx < w - 1; dx += 4) {
    for (let dy = 2; dy < hgt - 1; dy += 3) ctx.fillRect(x + dx, y + dy, 1.5, 1.5);
  }
}

const wheelDelta = (e, d) => d * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);

/** Pan a view so that part of `extent` stays on screen after a pan or zoom. */
function keepInView(v, extent, width, opts) {
  if (!extent) return v;
  const s = createScale({ ...v, ...opts });
  const xa = s.x(extent[0]);
  const xb = s.x(extent[1]);
  const margin = Math.min(width / 4, 120);
  if (xb < margin) return panView(v, xb - margin, opts);
  if (xa > width - margin) return panView(v, xa - (width - margin), opts);
  return v;
}

// ---------------------------------------------------------------------------
// Timeline workspace

/** @param {HTMLElement} root @param {any} app */
export default function createTimelineWorkspace(root, app) {
  root.classList.add('tl-root');

  const st = {
    visible: false,
    size: { w: 0, h: 0 },
    mode: null, // 'overview' | 'session'
    scopeKey: null,
    version: null,
    loading: false,
    error: null,
    tree: [],
    overview: [],
    spans: [],
    complete: true,
    lod: [],
    lodMinDur: 0,
    lodTruncated: false,
    gaps: [],
    extent: null,
    layout: { lanes: [], height: 0, itemById: new Map() },
    view: { t0: 0, k: 1e-6 },
    kMin: 0,
    fitted: true,
    scrollY: 0,
    collapse: loadPref(COLLAPSE_PREF, true),
    collapsedGroups: new Set(),
    groupsTouched: false, // the user expanded or collapsed a project lane
    expandedLanes: new Set(), // subagents shown as their own lane in a banded tree
    autoLanes: new Set(), // subagents given a lane because they have an unrecovered episode (AUTO_LANES)
    autoClosed: new Set(), // of those, the ones the user closed
    colorsDrawn: new Set(), // span color keys in the layout, for the legend
    focus: null, // overview: the range the view opens on (recent activity)
    dataVersion: 0, // bumps when an index run touched the drawn sessions
    lastData: 0,
    hover: null,
    selEvent: undefined,
    selSpanState: undefined,
    selectedSpan: null,
    ownSelection: null,
    marker: null,
    density: [],
    densityKey: null,
    selectMode: false,
    drag: null,
    brush: null,
    tween: 0,
    // Failure marks: episodes of the drawn sessions (session mode) and unrecovered ticks (overview).
    episodes: new Map(), // session id → EpisodeItem[]
    ticks: [],
    marksKey: null,
    bandHits: [],
    // Process and delegation lanes: session id → ProcessItem[] / DelegationItem[]; turn id → /api/time answer.
    procs: new Map(),
    delegs: new Map(),
    turnTime: new Map(),
    // Context lane: root session id → contextSeries() of its steps (lib/derived.js).
    contextOn: loadPref(CTX_PREF, false) === true,
    context: new Map(),
    contextKey: null,
    contextNote: null,
  };
  let loadSeq = 0;
  let frame = 0;
  // Turn time-bucket strips: answers are kept across data reloads and asked again (stale while revalidating).
  const timeQueue = []; // turn ids waiting for /api/time, the most recently drawn last
  const timeWanted = new Set(); // queued or in flight
  let timeStale = new Set(); // answered before the last data reload
  let timeInFlight = 0;
  let timeScope = 0; // bumps with the scope, so answers for the previous one are dropped
  let timeServed = true; // false once the server answers 501: no strips, and no room kept for them

  // DOM
  // Workspace header (§7.3, §7.12): the scope label, then Zoom (− and + as one segmented control), Fit and Select
  // range; Options ▾ holds All time, Clear range, Collapse idle gaps and the Context lane.
  const crumb = h('div', { class: 'tl-crumb', hidden: true });
  const tbtn = (label, title, onClick) => h('button', { class: 'tool-btn', type: 'button', title, onClick }, label);
  const selectBtn = tbtn('Select Range', 'Drag across the timeline to set the time range (or Alt-drag)', () =>
    setSelectMode(!st.selectMode),
  );
  selectBtn.setAttribute('aria-pressed', 'false');
  const clearRangeBtn = { hidden: true };
  const allTimeBtn = { hidden: false };
  const collapseBox = { checked: st.collapse };
  const contextBox = { checked: st.contextOn };
  const contextCtl = { hidden: true };
  const status = h('div', { class: 'ws-scope tl-status', role: 'status' });
  const zoomSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Zoom' },
    h('button', { class: 'seg-btn', type: 'button', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onClick: () => zoomBy(1 / 1.6) }, '−'),
    h('button', { class: 'seg-btn', type: 'button', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onClick: () => zoomBy(1.6) }, '+'));
  const optionsBtn = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu' }, 'Options', icon('down', 10));
  optionsBtn.addEventListener('click', () => showMenu(optionsBtn, [
    { label: 'All Time', disabled: allTimeBtn.hidden, title: allTimeBtn.hidden ? 'The timeline shows the sessions in scope' : null, onSelect: () => fitExtent(true) },
    { label: 'Clear Range', disabled: clearRangeBtn.hidden, title: clearRangeBtn.hidden ? 'No time range is set' : null, onSelect: () => app.setTimeRange(null, null) },
    { separator: true },
    { label: 'Collapse idle gaps', hint: 'over 5 minutes', checked: collapseBox.checked, onSelect: () => setCollapse(!collapseBox.checked) },
    { label: 'Context lane', checked: contextBox.checked, disabled: contextCtl.hidden, title: contextCtl.hidden ? 'Open one session to see its context lane' : null, onSelect: () => setContextLane(!contextBox.checked) },
  ], { align: 'end', minWidth: 240 }));
  const toolbar = h('div', { class: 'ws-head tl-toolbar' }, crumb, status,
    h('div', { class: 'ws-controls' }, zoomSeg, tbtn('Fit', 'Fit the scope (0)', () => fitAll(true)), selectBtn, optionsBtn));
  const canvas = h('canvas', { class: 'tl-canvas', tabindex: '0', role: 'img', 'data-f6': '', 'aria-label': 'Timeline of the sessions in scope. Wheel zooms, drag pans, Alt-drag selects a time range, + − 0 zoom, n and p select the next and previous span, Enter shows it in Events.' });
  const tooltip = h('div', { class: 'tl-tooltip', hidden: true });
  const empty = h('div', { class: 'tl-empty', hidden: true });
  const main = h('div', { class: 'tl-main' }, canvas, tooltip, empty);
  const minimap = h('canvas', { class: 'tl-minimap', role: 'img', 'aria-label': 'Overview of the whole time range; drag to move the view' });
  const ctxCanvas = h('canvas', { class: 'tl-ctx', hidden: true, role: 'img', 'aria-label': `Context lane: ${CTX_CAPTION}` });
  const legend = h('div', { class: 'tl-legend' });
  const selInfo = h('div', { class: 'tl-selinfo', 'aria-live': 'polite' });
  root.append(toolbar, main, ctxCanvas, minimap, h('div', { class: 'tl-footer' }, legend, selInfo));

  const plotW = () => Math.max(1, st.size.w - HEADER_W);
  const plotH = () => Math.max(1, st.size.h - AXIS_H);
  const breakPx = () => (st.mode === 'overview' ? OVERVIEW_BREAK_PX : BREAK_PX);
  const gapOpts = () => ({ gaps: st.collapse ? st.gaps : NO_GAPS, breakPx: breakPx() });
  const scale = () => createScale({ ...st.view, ...gapOpts() });
  const clampScroll = (y) => Math.max(0, Math.min(y, st.layout.height - plotH() + 8));

  function render() {
    if (!frame && st.visible) frame = requestAnimationFrame(draw);
  }

  // -- data ----------------------------------------------------------------

  function sync() {
    if (!st.visible) return;
    const scope = app.state.get('scope') ?? {};
    const ids = scope.sessions?.length ? scope.sessions : null;
    const key = ids ? ids.join('\n') : '*';
    const version = st.dataVersion;
    clearRangeBtn.hidden = scope.from == null && scope.to == null;
    allTimeBtn.hidden = !!ids;
    // load() syncs the density and the selection itself once the new lanes exist.
    if (key !== st.scopeKey || version !== st.version) load(ids, key, version);
    else if (!st.loading) {
      syncDensity();
      syncSelection();
    }
    render();
  }

  async function load(ids, key, version) {
    const seq = ++loadSeq;
    const newScope = key !== st.scopeKey;
    st.scopeKey = key;
    st.version = version;
    timeStale = new Set(st.turnTime.keys());
    if (newScope) {
      st.procs = new Map();
      st.delegs = new Map();
      st.turnTime = new Map();
      timeQueue.length = 0;
      timeWanted.clear();
      timeScope++;
    }
    st.loading = true;
    st.error = null;
    updateStatus();
    try {
      if (!ids) {
        const sessions = await loadOverview(app);
        if (seq !== loadSeq) return;
        app.rememberSessions?.(sessions);
        Object.assign(st, { mode: 'overview', overview: sessions, tree: [], spans: [], complete: true, lod: [], lodTruncated: false });
        st.extent = extentOf(sessions);
        // Open on recent activity, and collapse only gaps that matter at that scale (W08).
        st.focus = focusRange(sessions, Date.now() * 1000) ?? st.extent;
        st.gaps = findGaps(sessions, gapThreshold(st.focus ? st.focus[1] - st.focus[0] : null));
        if (!st.groupsTouched) {
          const projects = new Set(sessions.filter((x) => !x.parentId).map((x) => x.project || '(no project)'));
          st.collapsedGroups = projects.size > MANY_PROJECTS ? projects : new Set();
        }
      } else {
        const tree = await loadSessionTree(app, ids);
        if (seq !== loadSeq) return;
        app.rememberSessions?.(tree.map((n) => n.session));
        // Large trees (hundreds of subagents) skip the full span list: it would be truncated and
        // replaced as soon as level-of-detail applies. They load spans for the visible range only.
        const big = tree.length > LOD_TREE;
        const keep = !newScope && big && st.mode === 'session';
        const res = !tree.length || big ? { spans: keep ? st.spans : [], truncated: true } : await app.api.spans({ sessions: rootIds(tree), limit: SPAN_LIMIT });
        if (seq !== loadSeq) return;
        const spans = res?.spans ?? [];
        Object.assign(st, { mode: 'session', tree, spans, complete: !res?.truncated, lod: [], lodMinDur: keep ? st.lodMinDur : 0, lodTruncated: !big && !!res?.truncated, overview: [], focus: null });
        if (newScope) {
          st.expandedLanes = new Set(ids);
          st.autoClosed = new Set();
        }
        // Idle gaps are fixed after the first load so the axis does not jump as detail arrives.
        if (newScope || !st.gaps.length) {
          const busy = [
            ...tree.flatMap((n) => n.turns),
            ...tree.filter((n) => n.depth > 0 || !n.turns.length).map((n) => n.session),
            ...spans.filter((sp) => sp.kind !== 'session'),
          ];
          st.gaps = findGaps(busy);
        }
        st.extent = extentOf([...tree.map((n) => n.session), ...spans]);
      }
      if (newScope) {
        st.density = [];
        st.scrollY = 0;
        st.hover = null;
        placeTooltip(tooltip, null);
        st.selectedSpan = null;
        st.selSpanState = undefined;
        st.selEvent = undefined;
        if (st.mode === 'overview') st.expandedLanes.clear();
      }
      relayout();
      refreshLimits();
      if (newScope) fitAll(false);
      else setView(st.view, st.fitted);
      syncSelection();
    } catch (err) {
      if (seq === loadSeq) st.error = err?.message ?? String(err);
    } finally {
      if (seq === loadSeq) {
        st.loading = false;
        updateStatus();
        updateCrumb();
        updateEmpty();
        st.densityKey = null;
        syncDensity();
        render();
        loadMarks();
        loadContext();
      }
    }
  }

  // Span kinds absent from the drawn spans are left out, so close colors (Model call and Permission) rarely meet.
  const legendEntries = () => (st.mode === 'overview' ? AGENT_LEGEND : [
    ...SPAN_LEGEND.filter(([, key]) => key === 'user' || st.colorsDrawn.has(key)),
    ...(st.mode === 'session' && st.episodes.size ? BAND_LEGEND : []),
    // The two end cues never fold into "+n more" (§7.12 Bar ends).
    ...(st.mode === 'session' && (st.procs.size || st.delegs.size) ? [['▸ still running', null, true], ['Dashed: no end logged', null, true]] : []),
    ...(st.mode === 'session' && app.api.features.derived && timeServed ? [['Strip under each turn: its time by bucket (hover)', null]] : []),
    ...(st.mode === 'session' && st.contextOn ? [['Context tokens (window dashed when inferred)', 'context']] : []),
  ]);

  /** Episodes for the failure bands, or the unrecovered episodes for the overview ticks. */
  async function loadMarks() {
    const key = `${st.mode}|${st.scopeKey}|${st.version}|${app.state.get('indexVersion')}`;
    if (!app.api.features.derived || key === st.marksKey) return;
    st.marksKey = key;
    try {
      if (st.mode === 'session') {
        // Episodes for the bands, processes and delegations for their lanes: each root with its descendants.
        const each = (fetch) => Promise.all(rootIds(st.tree).map((id) => fetch({ session: id, descendants: true, limit: 5000 }).catch((err) => {
          console.warn('timeline lanes: a derived list is unavailable', err);
          return null;
        })));
        const [eps, procs, delegs] = await Promise.all([each(app.api.episodes), each(app.api.processes), each(app.api.delegations)]);
        if (st.marksKey !== key) return;
        st.episodes = bySession(eps, bandKind);
        st.procs = bySession(procs);
        st.delegs = bySession(delegs);
        relayout();
        updateStatus();
      } else if (st.mode === 'overview') {
        const pages = await Promise.all(['blocked', 'unrecovered'].map((section) => app.api.failuresQueue({ view: 'global', group: 'attention', section, sort: 'recent', limit: 1000 })));
        if (st.marksKey !== key) return;
        st.ticks = pages.flatMap((p) => p?.rows ?? []).filter((r) => r.kind === 'episode' && r.sessionId);
      }
      renderLegend(legend, legendEntries());
    } catch (err) {
      console.warn('timeline failure marks unavailable', err);
    }
    render();
  }

  // -- context lane ------------------------------------------------------------

  function setContextLane(on) {
    st.contextOn = on;
    contextBox.checked = on;
    savePref(CTX_PREF, on);
    updateContextVisibility();
    renderLegend(legend, legendEntries());
    loadContext();
    render();
  }

  function updateContextVisibility() {
    const show = st.contextOn && st.mode === 'session';
    contextCtl.hidden = st.mode !== 'session';
    ctxCanvas.hidden = !show;
    ctxCanvas.style.height = `${CTX_H * Math.max(1, Math.min(CTX_ROOTS, rootIds(st.tree).length))}px`;
  }

  /** Steps of the root sessions in scope (context size per step); never drawn as zero where not logged. */
  async function loadContext() {
    updateContextVisibility();
    if (!st.contextOn || st.mode !== 'session' || !app.api.features.derived) return;
    const roots = rootIds(st.tree).slice(0, CTX_ROOTS);
    const key = `${roots.join('\n')}|${st.version}|${app.state.get('indexVersion')}`;
    if (key === st.contextKey) return;
    st.contextKey = key;
    try {
      const out = new Map();
      for (const id of roots) {
        const steps = [];
        let after;
        for (let page = 0; page < 4; page++) {
          const res = await app.api.sessionSteps(id, { limit: 5000, after, descendants: false });
          steps.push(...(res?.steps ?? []));
          after = res?.next ?? null;
          if (!after) break;
        }
        out.set(id, contextSeries(steps));
      }
      if (st.contextKey !== key) return;
      st.context = out;
      st.contextNote = null;
    } catch (err) {
      if (st.contextKey !== key) return;
      st.context = new Map();
      st.contextNote = err.status === 404 ? 'The session is not in the analysis yet' : `Context unavailable: ${err.message}`;
    }
    render();
  }

  /** One strip per root: context tokens per step (area), the window (dashed when inferred), compactions. */
  function drawContext(T, s) {
    if (ctxCanvas.hidden) return;
    const roots = rootIds(st.tree).slice(0, CTX_ROOTS);
    const w = st.size.w;
    const H = CTX_H * Math.max(1, roots.length);
    const ctx = setupCanvas(ctxCanvas, w, H);
    const pw = plotW();
    ctx.fillStyle = T.color.bg;
    ctx.fillRect(0, 0, w, H);
    ctx.fillStyle = T.color.bgElev;
    ctx.fillRect(0, 0, HEADER_W, H);
    ctx.fillStyle = T.color.borderStrong;
    ctx.fillRect(HEADER_W - 1, 0, 1, H);
    ctx.fillStyle = T.color.border;
    ctx.fillRect(0, 0, w, 1);
    ctx.textBaseline = 'middle';
    const labels = [];
    roots.forEach((id, i) => {
      const y0 = i * CTX_H;
      const ser = st.context.get(id);
      const title = app.sessionById?.(id)?.title || shortId(id);
      ctx.font = `600 ${T.fsXs}px ${T.fontUi}`;
      ctx.fillStyle = T.color.fg;
      ctx.fillText(fitText(ctx, roots.length > 1 ? `Context · ${title}` : 'Context', HEADER_W - 16), 8, y0 + 12);
      ctx.font = `${T.fsXs}px ${T.fontUi}`;
      ctx.fillStyle = T.color.fgMuted;
      ctx.fillText(fitText(ctx, CTX_CAPTION, HEADER_W - 16), 8, y0 + 26);
      if (i) {
        ctx.fillStyle = T.color.border;
        ctx.fillRect(0, y0, w, 1);
      }
      if (!ser || !ser.points.length) {
        ctx.fillStyle = T.color.fgMuted;
        ctx.fillText(st.contextNote ?? (ser ? 'Context size is not logged for this session' : 'Loading…'), HEADER_W + 8, y0 + CTX_H / 2);
        labels.push(`${title}: ${st.contextNote ?? 'context size not logged'}`);
        return;
      }
      const top = y0 + 6;
      const ph = CTX_H - 12;
      const max = Math.max(ser.window ?? 0, ser.peak) * 1.05 || 1;
      const y = (v) => top + ph - (v / max) * ph;
      ctx.fillStyle = T.color.fgMuted;
      ctx.fillText(`peak ${formatTokens(ser.peak)}${ser.window ? ` of ${formatTokens(ser.window)}${ser.inferred ? ' (window inferred)' : ''}` : ''}`, 8, y0 + 40);
      ctx.save();
      ctx.beginPath();
      ctx.rect(HEADER_W, y0, pw, CTX_H);
      ctx.clip();
      // Steps hold their context size until the next step.
      const xs = ser.points.map((p) => HEADER_W + s.x(p.ts));
      const right = HEADER_W + pw;
      ctx.beginPath();
      ctx.moveTo(xs[0], top + ph);
      ser.points.forEach((p, k) => {
        const x1 = k + 1 < xs.length ? xs[k + 1] : Math.min(right, xs[k] + 6);
        ctx.lineTo(xs[k], y(p.tokens));
        ctx.lineTo(x1, y(p.tokens));
      });
      ctx.lineTo(Math.min(right, xs[xs.length - 1] + 6), top + ph);
      ctx.closePath();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = T.color.context;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = T.color.context;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      if (ser.window) {
        // Logged window: solid; inferred (Claude: 1M once a session exceeds 200k, else 200k): dashed.
        ctx.strokeStyle = ser.inferred ? T.color.hatch : T.color.fgMuted;
        ctx.setLineDash(ser.inferred ? [5, 4] : []);
        ctx.beginPath();
        ctx.moveTo(HEADER_W, Math.round(y(ser.window)) + 0.5);
        ctx.lineTo(right, Math.round(y(ser.window)) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = T.color.compaction;
      ctx.fillStyle = T.color.compaction;
      for (const c of ser.compactions) {
        const x = Math.round(HEADER_W + s.x(c)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + ph);
        ctx.stroke();
        ctx.fillText('compaction', x + 3, top + 6);
      }
      ctx.restore();
      const types = Object.entries(ser.attachments).map(([k, n]) => `${k} ×${n}`).join(', ');
      labels.push(`${title}: peak ${formatTokens(ser.peak)} tokens${ser.window ? ` of a ${formatTokens(ser.window)} window${ser.inferred ? ' (inferred)' : ' (logged)'}` : ''}, ${ser.compactions.length} compaction${ser.compactions.length === 1 ? '' : 's'}${types ? `, injected context: ${types}` : ''}`);
    });
    ctxCanvas.setAttribute('aria-label', `Context lane (${CTX_CAPTION}). ${labels.join('. ')}`);
  }

  /** Hover on the context lane: the step under the pointer, its tokens and the share of the window. */
  ctxCanvas.addEventListener('pointermove', (e) => {
    const r = ctxCanvas.getBoundingClientRect();
    const x = e.clientX - r.left - HEADER_W;
    const root = rootIds(st.tree).slice(0, CTX_ROOTS)[Math.floor((e.clientY - r.top) / CTX_H)];
    const ser = root ? st.context.get(root) : null;
    if (x < 0 || !ser?.points.length) {
      ctxCanvas.title = `Context lane: ${CTX_CAPTION}`;
      return;
    }
    const t = scale().t(x);
    let p = null;
    for (const q of ser.points) if (q.ts <= t) p = q;
    const win = p?.window ?? ser.window;
    ctxCanvas.title = p
      ? `Step ${p.step}: ${formatInt(p.tokens)} tokens${win ? ` of ${formatInt(win)} (${Math.round((p.tokens / win) * 100)}%)${ser.inferred ? ', window inferred' : ''}` : ''}\n${CTX_CAPTION}`
      : `Before the first step · ${CTX_CAPTION}`;
  });

  function relayout() {
    const fails = (id) => st.episodes.get(id)?.length ?? 0;
    const bad = (id) => (st.episodes.get(id) ?? []).filter((ep) => bandKind(ep) === 'bad').length;
    const extraOf = (id) => ({ procs: st.procs.get(id), delegs: st.delegs.get(id), strip: !!app.api.features.derived && timeServed, fails: fails(id), bad: bad(id) });
    // Subagents with an unrecovered episode get a lane of their own, the most episodes first (the user can close them).
    st.autoLanes = new Set(st.mode === 'session'
      ? st.tree.filter((n) => n.depth > 0 && !st.autoClosed.has(n.session.id) && bad(n.session.id)).sort((a, b) => bad(b.session.id) - bad(a.session.id)).slice(0, AUTO_LANES).map((n) => n.session.id)
      : []);
    st.layout = st.mode === 'overview' ? layoutOverview(st.overview, st.collapsedGroups) : layoutSessions(st.tree, st.spans, new Set([...st.expandedLanes, ...st.autoLanes]), extraOf);
    st.colorsDrawn = new Set([...st.layout.itemById.values()].map((it) => it.color));
    spanOrder = null;
    st.scrollY = clampScroll(st.scrollY);
    st.hover = null;
    renderLegend(legend, legendEntries());
    if (!st.loading) updateEmpty();
    updateSelInfo();
  }

  // Level of detail for session trees larger than SPAN_LIMIT: fetch the spans of the visible
  // range (plus half a screen on each side) that are at least one pixel long.
  const requestLod = debounce(fetchLod, 160);
  async function fetchLod() {
    if (st.mode !== 'session' || st.complete || !st.visible) return;
    const s = scale();
    const a = s.t(0);
    const b = s.t(plotW());
    const minDur = 2 ** Math.floor(Math.log2(Math.max(1, 1 / st.view.k)));
    const hit = st.lod.find((e) => e.from <= a && e.to >= b && e.minDur <= minDur);
    if (hit) {
      if (hit.spans !== st.spans) applyLod(hit);
      return;
    }
    const seq = loadSeq;
    const pad = (b - a) / 2;
    const entry = { from: Math.floor(a - pad), to: Math.ceil(b + pad), minDur, spans: [], truncated: false };
    try {
      const res = await app.api.spans({ sessions: rootIds(st.tree), from: entry.from, to: entry.to, minDur, limit: SPAN_LIMIT });
      if (seq !== loadSeq) return;
      entry.spans = res?.spans ?? [];
      entry.truncated = !!res?.truncated;
      st.lod = [entry, ...st.lod].slice(0, 6);
      applyLod(entry);
    } catch (err) {
      if (seq === loadSeq) app.toast?.(`Timeline: ${err?.message ?? err}`, 'error');
    }
  }

  function applyLod(entry) {
    st.spans = entry.spans;
    st.lodMinDur = entry.minDur;
    st.lodTruncated = entry.truncated;
    relayout();
    updateStatus();
    render();
  }

  async function syncDensity() {
    const view = app.state.get('view');
    const key = [view?.viewId, st.extent?.join('-'), st.collapse, st.size.w].join('|');
    if (key === st.densityKey) return;
    st.densityKey = key;
    if (!view?.viewId || !st.extent || !st.size.w) {
      st.density = [];
      return;
    }
    const ms = miniScale();
    const parts = await loadDensity(app, view.viewId, ms, st.extent[0], st.extent[1], plotW());
    if (key !== st.densityKey) return;
    st.density = parts;
    render();
  }

  async function syncSelection() {
    const id = app.state.get('selectedEvent') ?? null;
    const spanState = app.state.get('selectedSpan') ?? null;
    if (id === st.selEvent && spanState === st.selSpanState) return;
    st.selEvent = id;
    st.selSpanState = spanState;
    const own = id && id === st.ownSelection;
    st.ownSelection = null;
    if (!id) {
      st.marker = null;
      st.selectedSpan = spanState;
      updateSelInfo();
      render();
      return;
    }
    const detail = await loadEvent(app, id).catch(() => null);
    if (st.selEvent !== id || !detail?.event) return;
    // In session mode only events of the drawn sessions get a marker; others would point
    // at a time outside every lane.
    const drawn = st.mode !== 'session' || st.tree.some((n) => n.session.id === detail.event.session);
    st.marker = drawn ? detail.event.ts : null;
    if (!own && drawn) {
      // Highlight the innermost drawn span on the event's span chain.
      const chain = [detail.span, ...[...(detail.spanChain ?? [])].reverse()].filter(Boolean);
      st.selectedSpan = (chain.find((sp) => sp.id === spanState && st.layout.itemById.has(sp.id))
        ?? chain.find((sp) => st.layout.itemById.has(sp.id)))?.id ?? spanState;
      reveal(st.marker, st.layout.itemById.get(st.selectedSpan));
    }
    updateSelInfo();
    render();
  }

  /** Bring a time (and an item's row) into view when the selection came from elsewhere. */
  function reveal(t, item) {
    if (st.mode !== 'session' || !Number.isFinite(t)) return;
    const s = scale();
    if (t < s.t(0) || t > s.t(plotW())) {
      animateTo({ t0: createScale({ t0: t, k: st.view.k, ...gapOpts() }).t(-plotW() / 2), k: st.view.k });
    }
    if (item && (item.y < st.scrollY || item.y + item.h > st.scrollY + plotH())) {
      st.scrollY = clampScroll(item.y - plotH() / 2);
    }
  }

  // -- view ----------------------------------------------------------------

  function refreshLimits() {
    if (!st.extent) return;
    st.kMin = fitView(st.extent[0], st.extent[1], plotW(), { ...gapOpts(), pad: FIT_PAD }).k / 4;
  }

  function setView(v, fitted = false) {
    st.view = keepInView(v, st.extent, plotW(), gapOpts());
    st.fitted = fitted;
    render();
    requestLod();
  }

  function cancelTween() {
    if (st.tween) cancelAnimationFrame(st.tween);
    st.tween = 0;
  }

  /** Animate to a view: the center time moves linearly while the zoom changes geometrically. */
  function animateTo(target, fitted = false) {
    cancelTween();
    const pw = plotW();
    const from = st.view;
    const c0 = scale().t(pw / 2);
    const c1 = createScale({ ...target, ...gapOpts() }).t(pw / 2);
    const startAt = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - startAt) / 260);
      if (p >= 1) {
        st.tween = 0;
        setView(target, fitted);
        return;
      }
      const e = 1 - (1 - p) ** 3;
      const k = from.k * (target.k / from.k) ** e;
      st.view = { t0: createScale({ t0: c0 + (c1 - c0) * e, k, ...gapOpts() }).t(-pw / 2), k };
      draw();
      st.tween = requestAnimationFrame(step);
    };
    st.tween = requestAnimationFrame(step);
  }

  /** Fit the scope; the overview fits its recent-activity focus range. */
  function fitAll(animate) {
    fitRange(st.mode === 'overview' && st.focus ? st.focus : st.extent, animate);
  }

  /** Fit the whole extent ("All time"). */
  function fitExtent(animate) {
    fitRange(st.extent, animate);
  }

  function fitRange(range, animate) {
    if (!range || !st.size.w) return;
    const v = fitView(range[0], range[1], plotW(), { ...gapOpts(), pad: FIT_PAD });
    if (animate) animateTo(v, true);
    else {
      cancelTween();
      setView(v, true);
    }
  }

  function zoomAt(px, factor) {
    cancelTween();
    setView(zoomAround(st.view, px, factor, { ...gapOpts(), kMin: st.kMin, kMax: K_MAX }));
  }

  const zoomBy = (factor) => zoomAt(plotW() / 2, factor);

  function zoomTo(start, end) {
    const pw = plotW();
    animateTo(fitView(start, end, pw, { ...gapOpts(), pad: Math.min(80, pw / 6) }));
  }

  function setCollapse(on) {
    // Keep the visible time window while the mapping changes.
    const s = scale();
    const a = s.t(0);
    const b = s.t(plotW());
    st.collapse = on;
    collapseBox.checked = on;
    savePref(COLLAPSE_PREF, on);
    refreshLimits();
    if (st.fitted) fitAll(false);
    else setView(fitView(a, b, plotW(), gapOpts()));
    syncDensity();
  }

  function setSelectMode(on) {
    st.selectMode = on;
    selectBtn.setAttribute('aria-pressed', String(on));
    canvas.classList.toggle('tl-selecting', on);
  }

  // -- drawing -------------------------------------------------------------

  function draw() {
    frame = 0;
    const { w, h: hgt } = st.size;
    if (!w || !hgt || !st.visible) return;
    const T = theme();
    const ctx = setupCanvas(canvas, w, hgt);
    const pw = plotW();
    const s = scale();
    const tA = s.t(0);
    const tB = s.t(pw);
    const oy = AXIS_H - st.scrollY;
    const lanes = visibleLanes(st.layout.lanes, st.scrollY, plotH());
    const ticks = generateTicks(s, pw, 90);

    ctx.fillStyle = T.color.bg;
    ctx.fillRect(0, 0, w, hgt);

    // Plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, AXIS_H, pw, hgt - AXIS_H);
    ctx.clip();
    ctx.fillStyle = T.color.bgElev;
    for (const lane of lanes) if (lane.index % 2) ctx.fillRect(HEADER_W, oy + lane.y, pw, lane.h);
    ctx.fillStyle = T.color.border;
    for (const tk of ticks.ticks) ctx.fillRect(Math.round(HEADER_W + tk.x), AXIS_H, 1, hgt - AXIS_H);
    for (const lane of lanes) ctx.fillRect(HEADER_W, oy + lane.y + lane.h - 1, pw, 1);
    for (const lane of lanes) {
      if (!lane.band) continue;
      const x0 = HEADER_W + s.x(lane.band.start);
      const x1 = HEADER_W + s.x(lane.band.end);
      ctx.fillStyle = T.color[AGENT_COLOR[lane.session.agent]] ?? T.color.harness;
      ctx.fillRect(Math.max(x0, HEADER_W - 2), oy + lane.y + 2, Math.max(1, Math.min(x1, w) - Math.max(x0, HEADER_W - 2)), 3);
    }
    const rows = lanes.flatMap((l) => l.rows).filter((r) => r.y + r.h >= st.scrollY && r.y <= st.scrollY + plotH());
    drawItems(ctx, T, s, rows, { tA, tB, ox: HEADER_W, oy, xMin: HEADER_W, xMax: w });
    if (st.mode === 'session') {
      drawOpenEnds(ctx, T, s, rows, oy, tA, tB, w);
      drawStrips(ctx, T, s, rows, oy, tA, tB, w);
    }
    st.bandHits = [];
    if (st.mode === 'session' && st.episodes.size) drawBands(ctx, T, s, lanes, oy, tA, tB, w);
    if (st.mode === 'overview' && st.ticks.length) drawTicks(ctx, T, s, lanes, oy, tA, tB);
    const brkStyle = st.mode === 'overview' ? 'line' : 'zigzag';
    drawBreaks(ctx, T, s, tA, tB, HEADER_W, AXIS_H, hgt, brkStyle === 'zigzag', brkStyle, breakPx());
    drawScopeRange(ctx, T, s, app.state.get('scope'), HEADER_W, AXIS_H, pw, hgt - AXIS_H);
    const outline = (it, color, width) => {
      if (!it) return;
      const x0 = HEADER_W + s.x(it.start);
      const x1 = HEADER_W + s.x(it.end);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(x0 - width / 2, oy + it.y - width / 2, Math.max(1, x1 - x0) + width, it.h + width);
    };
    if (st.hover?.kind === 'item') outline(st.hover.item, T.color.fg, 1);
    outline(st.layout.itemById.get(st.selectedSpan), T.color.focus, 2);
    if (st.marker != null) drawMarker(ctx, T, HEADER_W + s.x(st.marker), AXIS_H, hgt - AXIS_H);
    if (st.brush) drawBrush(ctx, T, HEADER_W + st.brush.x0, HEADER_W + st.brush.x1, AXIS_H, hgt - AXIS_H);
    ctx.restore();

    // Axis, with break bands continued through it
    drawAxis(ctx, T, s, ticks, HEADER_W, pw, AXIS_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, 0, pw, AXIS_H - 1);
    ctx.clip();
    drawBreaks(ctx, T, s, tA, tB, HEADER_W, 0, AXIS_H - 1, brkStyle === 'line', brkStyle, breakPx());
    ctx.restore();

    // Lane headers
    ctx.fillStyle = T.color.bgElev;
    ctx.fillRect(0, 0, HEADER_W, hgt);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, AXIS_H, HEADER_W, hgt - AXIS_H);
    ctx.clip();
    ctx.textBaseline = 'middle';
    for (const lane of lanes) {
      const y = oy + lane.y;
      if (st.hover?.kind === 'header' && st.hover.lane === lane) {
        ctx.fillStyle = T.color.bgSunken;
        ctx.fillRect(0, y, HEADER_W, lane.h);
      }
      ctx.fillStyle = T.color.border;
      ctx.fillRect(0, y + lane.h - 1, HEADER_W, 1);
      if (lane.session) drawSessionHeader(ctx, T, lane, y, oy);
      else if (lane.bandOf) drawBandHeader(ctx, T, lane, y);
      else drawGroupHeader(ctx, T, lane, y);
    }
    ctx.restore();
    ctx.font = `${T.fsXs}px ${T.fontUi}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = T.color.fgMuted;
    ctx.fillText(fitText(ctx, ticks.context, HEADER_W - 16), 8, AXIS_H / 2 - 1);
    ctx.fillStyle = T.color.border;
    ctx.fillRect(0, AXIS_H - 1, HEADER_W, 1);
    ctx.fillStyle = T.color.borderStrong;
    ctx.fillRect(HEADER_W - 1, 0, 1, hgt);

    // Vertical scrollbar
    const content = st.layout.height;
    if (content > plotH()) {
      const ph = plotH();
      const th = Math.max(24, (ph * ph) / content);
      const ty = AXIS_H + (st.scrollY / Math.max(1, content - ph)) * (ph - th);
      ctx.fillStyle = T.color.borderStrong;
      ctx.beginPath();
      ctx.roundRect(w - 7, ty, 5, th, 2.5);
      ctx.fill();
    }
    drawMinimap(T, s);
    drawContext(T, s);
  }

  /**
   * Episode bands in each session lane's Failures row, with end glyphs and loop brackets; on the packed Subagents
   * band, a red tick at each unrecovered episode of a subagent without its own lane.
   */
  function drawBands(ctx, T, s, lanes, oy, tA, tB, w) {
    ctx.font = `${T.fsXs}px ${T.fontUi}`;
    ctx.textBaseline = 'middle';
    for (const lane of lanes) {
      if (lane.bandOf) {
        drawSubagentTicks(ctx, T, s, lane, oy, tA, tB);
        continue;
      }
      const eps = lane.session ? st.episodes.get(lane.session.id) : null;
      if (!eps) continue;
      const bh = lane.failY != null ? BAND_H : 5;
      const y = lane.failY != null ? oy + lane.failY + (FAIL_ROW_H - BAND_H) / 2 : oy + lane.y + lane.h - 8;
      for (const ep of eps) {
        if (ep.endTs < tA || ep.startTs > tB) continue;
        const kind = bandKind(ep);
        const color = kind === 'bad' ? T.color.bandBad : T.color.bandSlow;
        const x0 = Math.max(HEADER_W - 2, HEADER_W + s.x(ep.startTs));
        const x1 = Math.min(w + 2, Math.max(x0 + BAND_MIN_W, HEADER_W + s.x(ep.endTs)));
        ctx.globalAlpha = kind === 'bad' ? 0.22 : 0.18;
        ctx.fillStyle = color;
        ctx.fillRect(x0, y, x1 - x0, bh);
        ctx.globalAlpha = 1;
        if (kind === 'bad') hatch(ctx, x0, y, x1 - x0, bh, color);
        else dots(ctx, x0, y, x1 - x0, bh, color);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, bh - 1);
        if (ep.loop) {
          // Loop bracket: ⌐ … ¬ above the band.
          ctx.beginPath();
          ctx.moveTo(x0 + 0.5, y + 1);
          ctx.lineTo(x0 + 0.5, y - 3.5);
          ctx.lineTo(x1 - 0.5, y - 3.5);
          ctx.lineTo(x1 - 0.5, y + 1);
          ctx.stroke();
        }
        // The end glyph always shows: after the band, or inside its end when the band reaches the right edge.
        const glyph = END_GLYPH[ep.outcome];
        if (glyph) {
          ctx.fillStyle = color;
          ctx.fillText(glyph, Math.min(x1 + 2, w - 12), y + bh / 2);
        }
        st.bandHits.push({ x0, x1: x1 + (glyph ? 10 : 0), y0: y - 4, y1: y + bh + 2, ep });
      }
    }
  }

  function drawSubagentTicks(ctx, T, s, lane, oy, tA, tB) {
    ctx.fillStyle = T.color.bandBad;
    for (const row of lane.rows) {
      for (const it of row.items) {
        for (const ep of st.episodes.get(it.session?.id) ?? []) {
          if (bandKind(ep) !== 'bad' || ep.startTs < tA || ep.startTs > tB) continue;
          ctx.fillRect(Math.round(HEADER_W + s.x(ep.startTs)) - 1, oy + it.y - 1, 2, it.h + 2);
        }
      }
    }
  }

  /**
   * Bar ends (§7.12): a process or delegation still running reaches its session's end with a "▸" cap; one with no
   * end logged is a 24 px stub with a dashed outline. Neither reads as an end that was logged.
   */
  function drawOpenEnds(ctx, T, s, rows, oy, tA, tB, w) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = T.color.fgMuted;
    ctx.fillStyle = T.color.fg;
    for (const row of rows) {
      for (const it of row.items) {
        if (!it.open || it.end < tA || it.start > tB) continue;
        const x0 = Math.max(HEADER_W - 2, HEADER_W + s.x(it.start));
        const y = oy + it.y;
        if (it.running) {
          const x1 = Math.min(w, HEADER_W + s.x(it.end));
          if (x1 - x0 < 8) continue;
          ctx.beginPath();
          ctx.moveTo(x1 - 7, y + 1);
          ctx.lineTo(x1 - 1, y + it.h / 2);
          ctx.lineTo(x1 - 7, y + it.h - 1);
          ctx.closePath();
          ctx.fill();
          continue;
        }
        ctx.setLineDash([3, 2]);
        const x1 = Math.min(w + 2, x0 + 24);
        ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(1, x1 - x0 - 1), it.h - 1);
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  /**
   * The time-bucket strip under each turn wide enough to read: the turn's wall time split by bucket in priority
   * order, derived parts a little lighter (the tooltip gives the share), unattributed time last (never model
   * time). Answers load as turns come in view.
   */
  function drawStrips(ctx, T, s, rows, oy, tA, tB, w) {
    for (const row of rows) {
      if (!row.strip) continue;
      const y = oy + row.y + 1;
      const sh = STRIP_H - 2;
      for (const it of row.strip) {
        if (it.end < tA || it.start > tB) continue;
        const x0 = HEADER_W + s.x(it.start);
        const x1 = HEADER_W + s.x(it.end);
        if (x1 - x0 < STRIP_MIN_PX) continue;
        const d = turnTime(it.span.id);
        if (!d) continue;
        if (d === TIME_LOADING) {
          ctx.fillStyle = T.color.border;
          ctx.fillRect(Math.max(x0, HEADER_W - 2), y + 1, Math.min(x1, w + 2) - Math.max(x0, HEADER_W - 2), sh - 2);
          continue;
        }
        let x = x0;
        for (const g of timeSegments({ buckets: d.buckets ?? [], unattributedUs: d.unattributedUs ?? 0, wallUs: d.wallUs })) {
          const gw = g.frac * (x1 - x0);
          if (g.name === 'unattributed') ctx.fillStyle = T.color.bgSunken;
          else ctx.fillStyle = T.color[BUCKET_KEY[g.name]] ?? T.color.harness;
          const logged = gw * g.loggedFrac;
          ctx.fillRect(x, y, logged, sh);
          ctx.globalAlpha = 0.7;
          ctx.fillRect(x + logged, y, gw - logged, sh);
          ctx.globalAlpha = 1;
          x += gw;
        }
        ctx.strokeStyle = T.color.borderStrong;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(1, Math.round(x1 - x0) - 1), sh - 1);
      }
    }
  }

  /** The /api/time answer of a turn (null when the server has none), or TIME_LOADING; asks for it when missing or stale. */
  function turnTime(id) {
    const have = st.turnTime.get(id);
    if ((have === undefined || timeStale.has(id)) && !timeWanted.has(id)) {
      timeWanted.add(id);
      timeQueue.push(id);
      // Panning queues many turns; the oldest requests are dropped and asked again when they come back in view.
      if (timeQueue.length > TIME_QUEUE) timeWanted.delete(timeQueue.shift());
      pumpTime();
    }
    return have === undefined ? TIME_LOADING : have;
  }

  function pumpTime() {
    while (timeInFlight < TIME_FETCHES && timeQueue.length) {
      const id = timeQueue.pop();
      const scope = timeScope;
      timeInFlight++;
      app.api.time({ turn: id })
        .then((d) => d ?? null, (err) => {
          if (err?.status === 501 && timeServed) {
            timeServed = false;
            relayout();
          }
          return null;
        })
        .then((d) => {
          if (scope !== timeScope) return;
          st.turnTime.set(id, d);
          timeStale.delete(id);
          timeWanted.delete(id);
        })
        .finally(() => {
          timeInFlight--;
          render();
          pumpTime();
        });
    }
  }

  /** Overview: a tick on a session bar at each unrecovered episode. */
  function drawTicks(ctx, T, s, lanes, oy, tA, tB) {
    const items = new Map();
    for (const lane of lanes) for (const row of lane.rows) for (const it of row.items) if (it.session) items.set(it.session.id, it);
    ctx.fillStyle = T.color.bandBad;
    for (const t of st.ticks) {
      if (t.ts < tA || t.ts > tB) continue;
      const it = items.get(t.sessionId) ?? items.get(app.sessionById?.(t.sessionId)?.rootId);
      if (!it) continue;
      const x = HEADER_W + s.x(t.ts);
      ctx.fillRect(Math.round(x) - 1, oy + it.y - 2, 2, it.h + 4);
    }
  }

  /** A session track's title row (§7.12): agent dot, title, then "≈1d 07h · 360 events · 16 errors" as metadata. */
  function drawSessionHeader(ctx, T, lane, y, oy) {
    const sess = lane.session;
    const x = 8 + Math.min(lane.depth, 6) * 12;
    const key = AGENT_COLOR[sess.agent] ?? 'harness';
    ctx.fillStyle = T.color[key];
    ctx.beginPath();
    ctx.arc(x + 4, y + 14, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `${T.fsSm}px ${T.fontUi}`;
    ctx.fillStyle = T.color.fg;
    ctx.fillText(fitText(ctx, sess.title || shortId(sess.id), HEADER_W - x - 26), x + 14, y + 14.5);
    ctx.font = `${T.fsXs}px ${T.fontUi}`;
    ctx.fillStyle = T.color.fgMuted;
    const dur = sess.start != null && sess.end != null ? `${formatDuration(sess.end - sess.start)}≈` : null;
    const sub = [sess.role && sess.role !== 'main' ? sess.role : null, dur, `${formatInt(sess.nEvents ?? 0)} events`, sess.nErrors ? `${formatInt(sess.nErrors)} errors` : null].filter(Boolean).join(' · ');
    ctx.fillText(fitText(ctx, sub, HEADER_W - x - 10), x, y + 29);
    // Each sub-lane's title with its count ("Delegations 96", "Processes 4", "Failures 1").
    ctx.fillStyle = T.color.fgMuted;
    for (const k of lane.kinds ?? []) ctx.fillText(fitText(ctx, k.label, HEADER_W - x - 10), x, oy + k.y + ROW_H / 2);
  }

  function drawGroupHeader(ctx, T, lane, y) {
    if (lane.collapsed) {
      // One line, so a collapsed project needs only a short lane; the count sits at the right edge.
      ctx.font = `${T.fsXs}px ${T.fontUi}`;
      const count = formatInt(lane.count);
      const cw = ctx.measureText(count).width;
      ctx.fillStyle = T.color.fgMuted;
      ctx.fillText(count, HEADER_W - 10 - cw, y + lane.h / 2);
      ctx.font = `600 ${T.fsSm}px ${T.fontUi}`;
      ctx.fillStyle = T.color.fg;
      ctx.fillText(fitText(ctx, `▸ ${lane.project}`, HEADER_W - 26 - cw), 8, y + lane.h / 2);
      return;
    }
    ctx.font = `600 ${T.fsSm}px ${T.fontUi}`;
    ctx.fillStyle = T.color.fg;
    ctx.fillText(fitText(ctx, `▾ ${lane.project}`, HEADER_W - 16), 8, y + 14.5);
    ctx.font = `${T.fsXs}px ${T.fontUi}`;
    ctx.fillStyle = T.color.fgMuted;
    const sub = `${formatInt(lane.count)} sessions${lane.subCount ? ` · ${formatInt(lane.subCount)} subagents` : ''}`;
    ctx.fillText(fitText(ctx, sub, HEADER_W - 24), 20, y + 29);
  }

  function drawBandHeader(ctx, T, lane, y) {
    ctx.font = `600 ${T.fsXs}px ${T.fontUi}`;
    ctx.fillStyle = T.color.fg;
    ctx.fillText(fitText(ctx, `Subagents ${formatInt(lane.count)}`, HEADER_W - 28), 20, y + 11);
    ctx.font = `${T.fsXs}px ${T.fontUi}`;
    ctx.fillStyle = T.color.fgMuted;
    ctx.fillText(fitText(ctx, lane.failing ? `${formatInt(lane.failing)} unrecovered (red ticks) · click a bar` : 'click a bar to give it a lane', HEADER_W - 28), 20, y + 24);
  }

  let mini = { extent: null, gaps: null, w: 0, scale: null };
  function miniScale() {
    const { gaps } = gapOpts();
    if (mini.extent !== st.extent || mini.gaps !== gaps || mini.w !== plotW()) {
      const v = fitView(st.extent[0], st.extent[1], plotW(), { gaps, pad: 4 });
      mini = { extent: st.extent, gaps, w: plotW(), scale: createScale({ ...v, gaps }) };
    }
    return mini.scale;
  }

  function drawMinimap(T, s) {
    const w = st.size.w;
    const ctx = setupCanvas(minimap, w, MINIMAP_H);
    ctx.fillStyle = T.color.bgElev;
    ctx.fillRect(0, 0, w, MINIMAP_H);
    ctx.fillStyle = T.color.bgSunken;
    ctx.fillRect(HEADER_W, 0, plotW(), MINIMAP_H);
    ctx.fillStyle = T.color.borderStrong;
    ctx.fillRect(HEADER_W - 1, 0, 1, MINIMAP_H);
    if (!st.extent) return;
    const ms = miniScale();
    ctx.font = `${T.fsXs}px ${T.fontUi}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = T.color.fgMuted;
    ctx.fillText(fitText(ctx, `${formatClock(st.extent[0], { digits: 0 })} → ${formatDuration(st.extent[1] - st.extent[0])}`, HEADER_W - 16), 8, MINIMAP_H / 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, 0, plotW(), MINIMAP_H);
    ctx.clip();
    if (st.density.length) drawDensity(ctx, T, ms, st.density, HEADER_W, 4, MINIMAP_H - 8, T.color.fgFaint);
    else {
      // Without a view histogram, show where the lanes have bars.
      ctx.fillStyle = T.color.fgFaint;
      for (const lane of st.layout.lanes) {
        for (const it of lane.rows[0]?.items ?? []) {
          const x0 = HEADER_W + ms.x(it.start);
          ctx.fillRect(x0, MINIMAP_H / 2 - 3, Math.max(1, ms.x(it.end) - ms.x(it.start)), 6);
        }
      }
    }
    drawBreaks(ctx, T, ms, st.extent[0], st.extent[1], HEADER_W, 0, MINIMAP_H, false);
    drawScopeRange(ctx, T, ms, app.state.get('scope'), HEADER_W, 0, plotW(), MINIMAP_H);
    const va = HEADER_W + ms.x(s.t(0));
    const vb = HEADER_W + ms.x(s.t(plotW()));
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = T.color.bg;
    ctx.fillRect(HEADER_W, 0, Math.max(0, va - HEADER_W), MINIMAP_H);
    ctx.fillRect(vb, 0, Math.max(0, w - vb), MINIMAP_H);
    ctx.restore();
    ctx.strokeStyle = T.color.accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(va, 1, Math.max(2, vb - va), MINIMAP_H - 2);
    if (st.marker != null) drawMarker(ctx, T, HEADER_W + ms.x(st.marker), 0, MINIMAP_H);
    ctx.restore();
  }

  // -- status and side panels ---------------------------------------------

  function updateStatus() {
    status.classList.toggle('tl-status-err', !!st.error);
    if (st.loading) status.textContent = 'Loading…';
    else if (st.error) status.textContent = st.error;
    else if (st.mode === 'overview') setScopeLabel(status, `${plural(st.overview.length, 'session')} · overview`);
    else if (st.mode === 'session') {
      // One form on both clients (§7.12): sessions, spans, the visibility threshold, then the lanes' counts.
      const lod = !st.complete && st.lodMinDur > 1 ? ` · showing spans ≥ ${formatDuration(st.lodMinDur)}` : '';
      const truncated = st.lodTruncated ? ' · too many to draw, zoom in' : '';
      const total = (m, keep = () => true) => [...m.values()].reduce((a, list) => a + list.filter(keep).length, 0);
      const lanes = [[total(st.episodes), 'failure band'], [total(st.procs), 'process'], [total(st.delegs), 'delegation']]
        .filter(([n]) => n).map(([n, unit]) => ` · ${plural(n, unit)}`).join('');
      setScopeLabel(status, `${plural(st.tree.length, 'session')} · ${plural(st.spans.length, 'span')}${lod}${truncated}${lanes}`);
      status.title = lod
        ? `Spans shorter than ${formatDuration(st.lodMinDur)} are hidden at this zoom so the timeline stays fast. Zoom in to see them.`
        : '';
    } else status.textContent = '';
    publishScope();
  }

  function publishScope() {
    const scope = app.state.get('scope') ?? {};
    const timed = scope.from != null || scope.to != null;
    const filter = app.state.get('filter');
    const what = st.mode === 'overview'
      ? `Overview of ${formatInt(st.overview.length)} sessions`
      : `Spans: full session context${st.tree.length > 1 ? ` (${formatInt(st.tree.length - 1)} subagents)` : ''}`;
    const text = [what, filter ? 'filter shown as density' : 'density of the current view', timed ? 'time range shown, outside dimmed' : null].filter(Boolean).join(' · ');
    app.setWorkspaceStatus('timeline', text);
  }

  function updateCrumb() {
    clear(crumb);
    if (st.mode !== 'session') {
      crumb.append(h('span', { class: 'tl-crumb-current' }, 'All sessions'));
      return;
    }
    const rootSession = st.tree[0]?.session;
    crumb.append(
      h('button', { class: 'tl-link', type: 'button', onClick: () => app.state.set({ scope: { ...(app.state.get('scope') ?? {}), sessions: null } }) }, 'All sessions'),
      h('span', { class: 'tl-crumb-sep', 'aria-hidden': 'true' }, '›'),
      h('span', { class: 'tl-crumb-current', title: rootSession?.id ?? '' }, rootSession ? rootSession.title || shortId(rootSession.id) : 'Session'),
    );
    const subagents = st.tree.filter((n) => n.depth > 0).length;
    if (subagents) crumb.append(h('span', { class: 'tl-crumb-count' }, `+${subagents} subagents`));
  }

  function updateEmpty() {
    let content = null;
    if (st.error) {
      content = placeholder('error', 'Could not load the timeline. Your selection is preserved.', st.error, {
        label: 'Retry',
        onClick: () => {
          st.scopeKey = null;
          sync();
        },
      });
    }
    else if (st.mode === 'overview' && !st.overview.length) content = placeholder('empty', 'No sessions yet', 'Sessions appear here once the index has data.');
    else if (st.mode === 'session' && !st.tree.length) content = placeholder('empty', 'Session not found', 'The scoped session is not in the index.');
    else if (st.mode === 'session' && !st.spans.length) content = placeholder('empty', 'No spans', 'This session has no turns, model calls or tool calls.');
    empty.hidden = !content;
    clear(empty);
    if (content) empty.append(content);
  }

  function updateSelInfo() {
    clear(selInfo);
    const it = st.layout.itemById.get(st.selectedSpan);
    if (!it) return;
    const sp = it.span;
    selInfo.append(
      h('span', { class: 'tl-sel-kind' }, sp.kind),
      h('span', { class: 'tl-sel-name', title: sp.name }, it.label),
      h('span', { class: 'tl-sel-dur' }, dur(sp.dur ?? it.end - it.start)),
    );
    if (sp.firstEvent) {
      const title = 'Select the first event of this span in the Events workspace (Enter)';
      selInfo.append(h('button', { class: 'tl-btn', type: 'button', title, onClick: () => app.selectEvent(sp.firstEvent) }, 'Show in Events'));
    }
  }

  // -- interaction ---------------------------------------------------------

  function hitTest(x, y) {
    if (y < AXIS_H || y > st.size.h) return null;
    const ly = y - AXIS_H + st.scrollY;
    const lane = visibleLanes(st.layout.lanes, ly, 1)[0] ?? null;
    if (x < HEADER_W) return lane ? { kind: 'header', lane } : null;
    const band = st.bandHits.find((b) => x >= b.x0 - 1 && x <= b.x1 + 1 && y >= b.y0 && y <= b.y1);
    if (band) return { kind: 'episode', ep: band.ep };
    const s = scale();
    const px = x - HEADER_W;
    const brk = s.breaks(s.t(px - BREAK_PX), s.t(px + 1)).find((b) => px >= b.x && px < b.x + BREAK_PX);
    if (brk) return { kind: 'break', gap: brk };
    const row = lane?.rows.find((r) => ly >= r.y && ly < r.y + r.h);
    if (!row) return null;
    const t = s.t(px);
    if (row.strip) {
      const it = row.strip.find((x) => t >= x.start && t <= x.end);
      return it && s.x(it.end) - s.x(it.start) >= STRIP_MIN_PX ? { kind: 'strip', item: it } : null;
    }
    const tA = s.t(px - 3);
    const tB = s.t(px + 3);
    let best = null;
    let bestD = Infinity;
    for (let i = lowerBound(row.maxEnd, tA); i < row.items.length; i++) {
      const it = row.items[i];
      if (it.start > tB) break;
      if (it.end < tA) continue;
      const d = t < it.start ? it.start - t : t > it.end ? t - it.end : 0;
      if (d < bestD || (d === bestD && it.end - it.start < best.end - best.start)) {
        best = it;
        bestD = d;
      }
    }
    return best ? { kind: 'item', item: best } : null;
  }

  function tipFor(hit) {
    if (!hit) return null;
    if (hit.kind === 'strip') return stripTip(hit.item, st.turnTime.get(hit.item.span.id));
    if (hit.kind === 'item') {
      const it = hit.item;
      return it.proc ? processTip(it) : it.deleg ? delegationTip(it) : it.span ? spanTip(it.span) : sessionTip(it.session);
    }
    if (hit.kind === 'episode') {
      const ep = hit.ep;
      return [
        h('div', { class: 'tl-tip-title' }, `${END_GLYPH[ep.outcome] ?? ''} Episode · ${OUTCOME_WORD[ep.outcome] ?? ep.outcome}`),
        tipRow('Target', ep.targetKey),
        tipRow('Family', ep.family),
        tipRow('Attempts', `${formatInt(ep.nAttempts)}${ep.loop ? ' · loop' : ''}${ep.blind ? ' · blind' : ''}`),
        tipRow('Wall time', ep.wallUs != null ? formatDuration(ep.wallUs) : '—'),
        tipRow('Click', 'open the observed chain'),
      ];
    }
    if (hit.kind === 'break') return gapTip(hit.gap);
    if (hit.lane.bandOf) return [h('div', { class: 'tl-tip-title' }, `${formatInt(hit.lane.count)} subagents of ${hit.lane.bandOf.title || shortId(hit.lane.bandOf.id)}`), tipRow('Click a bar', 'give that subagent its own lane')];
    if (hit.lane.closable) return [...sessionTip(hit.lane.session), tipRow('Click', 'return it to the Subagents band')];
    if (hit.lane.session) return sessionTip(hit.lane.session);
    return [h('div', { class: 'tl-tip-title' }, hit.lane.project), tipRow('Sessions', formatInt(hit.lane.count)), tipRow('Click', hit.lane.collapsed ? 'expand' : 'collapse')];
  }

  const hoverKey = (hit) => (hit ? hit.item ?? hit.ep ?? hit.lane ?? hit.gap.start : null);

  function hover(x, y) {
    const hit = hitTest(x, y);
    const same = hoverKey(hit) === hoverKey(st.hover);
    st.hover = hit;
    canvas.classList.toggle('tl-pointer', !!hit && hit.kind !== 'break');
    placeTooltip(tooltip, tipFor(hit), x, y, st.size.w, st.size.h);
    if (!same) render();
  }

  function click(x, y) {
    const hit = hitTest(x, y);
    if (hit?.kind === 'episode') app.openEpisode(hit.ep.id);
    else if (hit?.kind === 'strip') app.showSession(hit.item.span.session, { turnId: hit.item.span.id });
    else if (hit?.kind === 'item' && hit.item.proc) app.openFollow({ kind: 'process', id: hit.item.proc.id });
    else if (hit?.kind === 'item' && hit.item.deleg) app.openFollow({ kind: 'delegation', spanId: hit.item.deleg.id });
    else if (hit?.kind === 'item' && hit.item.span) selectSpan(hit.item.span);
    else if (hit?.kind === 'item' && hit.item.inBand) toggleLane(hit.item.session.id);
    else if (hit?.kind === 'item' && hit.item.session) app.openSession(hit.item.session.id, { workspace: 'timeline' });
    else if (hit?.kind === 'header' && hit.lane.closable) toggleLane(hit.lane.session.id);
    else if (hit?.kind === 'header' && hit.lane.bandOf) {
      /* the band header only explains itself */
    } else if (hit?.kind === 'header' && !hit.lane.session) {
      st.groupsTouched = true;
      const p = hit.lane.project;
      if (st.collapsedGroups.has(p)) st.collapsedGroups.delete(p);
      else st.collapsedGroups.add(p);
      relayout();
      render();
    } else if (hit?.kind === 'header' && !(app.state.get('scope')?.sessions ?? []).includes(hit.lane.session.id)) {
      app.openSession(hit.lane.session.id, { workspace: 'timeline' });
    }
  }

  /** Give a subagent of a banded tree its own lane, or take it away again. */
  function toggleLane(id) {
    if (st.expandedLanes.has(id) || st.autoLanes.has(id)) {
      st.expandedLanes.delete(id);
      st.autoClosed.add(id);
    } else {
      st.expandedLanes.add(id);
      st.autoClosed.delete(id);
    }
    relayout();
    render();
  }

  // Keyboard access to spans without pointer hit-testing (F16): n / p step through them in time order.
  let spanOrder = null;
  function stepSpan(dir) {
    spanOrder ??= [...st.layout.itemById.values()].sort(byStart);
    if (!spanOrder.length) return;
    const cur = st.layout.itemById.get(st.selectedSpan);
    let i = cur ? spanOrder.indexOf(cur) + dir : spanOrder.findIndex((it) => it.start >= scale().t(0));
    i = Math.max(0, Math.min(spanOrder.length - 1, i < 0 ? 0 : i));
    const it = spanOrder[i];
    selectSpan(it.span);
    reveal((it.start + it.end) / 2, it);
  }

  function selectSpan(sp) {
    st.selectedSpan = sp.id;
    st.selSpanState = sp.id;
    app.state.set({ selectedSpan: sp.id });
    if (sp.firstEvent) {
      st.ownSelection = sp.firstEvent;
      app.selectEvent(sp.firstEvent, { reveal: false });
    }
    updateSelInfo();
    render();
  }

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  on(canvas, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    cancelTween();
    const { x, y } = local(e);
    const overflow = st.layout.height > plotH();
    if (overflow && x > st.size.w - 10 && y > AXIS_H) st.drag = { type: 'scrollbar', y, scrollY: st.scrollY };
    else if (x < HEADER_W || y < AXIS_H) st.drag = { type: 'click', x, y };
    else if (e.altKey || st.selectMode) {
      st.drag = { type: 'brush' };
      st.brush = { x0: x - HEADER_W, x1: x - HEADER_W };
    } else st.drag = { type: 'pan', x, y, view: st.view, scrollY: st.scrollY, moved: false };
    canvas.setPointerCapture(e.pointerId);
    placeTooltip(tooltip, null);
  });

  on(canvas, 'pointermove', (e) => {
    const { x, y } = local(e);
    const d = st.drag;
    if (!d) return hover(x, y);
    if (d.type === 'pan') {
      if (!d.moved && Math.abs(x - d.x) + Math.abs(y - d.y) < 4) return;
      d.moved = true;
      canvas.classList.add('tl-grabbing');
      st.scrollY = clampScroll(d.scrollY - (y - d.y));
      setView(panView(d.view, d.x - x, gapOpts()));
    } else if (d.type === 'brush') {
      st.brush.x1 = Math.max(0, Math.min(plotW(), x - HEADER_W));
      render();
    } else if (d.type === 'scrollbar') {
      const ph = plotH();
      st.scrollY = clampScroll(d.scrollY + ((y - d.y) * st.layout.height) / ph);
      render();
    }
  });

  const endDrag = (e) => {
    const d = st.drag;
    if (!d) return;
    st.drag = null;
    canvas.classList.remove('tl-grabbing');
    const { x, y } = local(e);
    if (e.type === 'pointerup' && (d.type === 'click' || (d.type === 'pan' && !d.moved))) click(x, y);
    if (d.type === 'brush') {
      const { x0, x1 } = st.brush;
      st.brush = null;
      if (e.type === 'pointerup' && Math.abs(x1 - x0) > 3) {
        const s = scale();
        app.setTimeRange(Math.floor(s.t(Math.min(x0, x1))), Math.ceil(s.t(Math.max(x0, x1))));
        setSelectMode(false);
      }
      render();
    }
  };
  on(canvas, 'pointerup', endDrag);
  on(canvas, 'pointercancel', endDrag);

  on(canvas, 'pointerleave', () => {
    if (st.drag) return;
    st.hover = null;
    placeTooltip(tooltip, null);
    render();
  });

  on(canvas, 'dblclick', (e) => {
    const { x, y } = local(e);
    if (x < HEADER_W || y < AXIS_H) return;
    const hit = hitTest(x, y);
    if (hit?.kind === 'item' && hit.item.span) zoomTo(hit.item.start, Math.max(hit.item.end, hit.item.start + 1000));
    else if (hit?.kind === 'break') zoomTo(hit.gap.start, hit.gap.end);
    else if (!hit) zoomAt(x - HEADER_W, 2);
  });

  on(
    canvas,
    'wheel',
    (e) => {
      e.preventDefault();
      cancelTween();
      const { x } = local(e);
      const dx = wheelDelta(e, e.deltaX);
      const dy = wheelDelta(e, e.deltaY);
      if (x < HEADER_W) {
        st.scrollY = clampScroll(st.scrollY + dy);
        render();
      } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) setView(panView(st.view, e.shiftKey && !dx ? dy : dx, gapOpts()));
      else zoomAt(x - HEADER_W, Math.exp(-dy * 0.0025));
      placeTooltip(tooltip, null);
    },
    { passive: false },
  );

  on(canvas, 'keydown', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const pw = plotW();
    const handled = {
      '+': () => zoomBy(1.6),
      '=': () => zoomBy(1.6),
      '-': () => zoomBy(1 / 1.6),
      _: () => zoomBy(1 / 1.6),
      0: () => fitAll(true),
      ArrowLeft: () => setView(panView(st.view, -pw * 0.15, gapOpts())),
      ArrowRight: () => setView(panView(st.view, pw * 0.15, gapOpts())),
      ArrowUp: () => ((st.scrollY = clampScroll(st.scrollY - 40)), render()),
      ArrowDown: () => ((st.scrollY = clampScroll(st.scrollY + 40)), render()),
      Enter: () => {
        const sp = st.layout.itemById.get(st.selectedSpan)?.span;
        if (sp?.firstEvent) app.selectEvent(sp.firstEvent);
      },
      n: () => stepSpan(1),
      p: () => stepSpan(-1),
      Escape: () => {
        setSelectMode(false);
        if (st.drag?.type === 'brush') st.drag = null;
        st.brush = null;
        render();
      },
    }[e.key];
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    handled();
  });

  // Minimap: drag moves the view; grabbing inside the view rectangle keeps the grab offset.
  on(minimap, 'pointerdown', (e) => {
    if (e.button !== 0 || !st.extent) return;
    cancelTween();
    const ms = miniScale();
    const s = scale();
    const x = e.clientX - minimap.getBoundingClientRect().left - HEADER_W;
    const va = ms.x(s.t(0));
    const vb = ms.x(s.t(plotW()));
    const grab = x >= va && x <= vb ? x - (va + vb) / 2 : 0;
    const moveTo = (cx) => {
      const center = ms.t(cx - grab);
      setView({ t0: createScale({ t0: center, k: st.view.k, ...gapOpts() }).t(-plotW() / 2), k: st.view.k });
    };
    moveTo(x);
    minimap.setPointerCapture(e.pointerId);
    const move = (ev) => moveTo(ev.clientX - minimap.getBoundingClientRect().left - HEADER_W);
    const up = () => {
      minimap.removeEventListener('pointermove', move);
      minimap.removeEventListener('pointerup', up);
      minimap.removeEventListener('pointercancel', up);
    };
    minimap.addEventListener('pointermove', move);
    minimap.addEventListener('pointerup', up);
    minimap.addEventListener('pointercancel', up);
  });

  // -- lifecycle -----------------------------------------------------------

  function measure() {
    const w = main.clientWidth;
    const hgt = main.clientHeight;
    if (w === st.size.w && hgt === st.size.h) return;
    const first = !st.size.w;
    st.size = { w, h: hgt };
    if (!w || !hgt) return;
    refreshLimits();
    st.scrollY = clampScroll(st.scrollY);
    if (st.extent && (first || st.fitted)) fitAll(false);
    syncDensity();
    render();
  }

  new ResizeObserver(() => {
    if (st.visible) measure();
  }).observe(main);
  watchTheme(render);
  app.state.subscribe(['scope', 'view', 'selectedEvent', 'selectedSpan'], () => sync());
  // Index runs reload the drawn sessions only when they touched them, and at most every 15 s
  // (the overview every 60 s); a refresh keeps the spans and reloads only the visible range.
  let dataTimer = 0;
  app.state.subscribe(['indexVersion'], () => {
    const ids = app.state.get('scope')?.sessions ?? null;
    if (!app.changeAffects(ids?.length ? ids : null) || dataTimer) return;
    const every = ids?.length ? SESSION_REFRESH_MS : OVERVIEW_REFRESH_MS;
    dataTimer = setTimeout(() => {
      dataTimer = 0;
      st.lastData = Date.now();
      st.dataVersion++;
      sync();
    }, Math.max(0, st.lastData + every - Date.now()));
  });

  return {
    show() {
      st.visible = true;
      measure();
      sync();
    },
    hide() {
      st.visible = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      cancelTween();
      requestLod.cancel();
      st.drag = null;
      st.brush = null;
      placeTooltip(tooltip, null);
    },
  };
}

// ---------------------------------------------------------------------------
// Timeline strip for the Events workspace

const STRIP_AXIS_H = 18;
const STRIP_PAD = 8;

/**
 * Compact timeline of the current scope: the current view's event density, the turns of the
 * scoped sessions and the selected event. Drag selects a time range, click jumps to the
 * nearest event (or a turn's first event), the wheel zooms, double-click fits.
 * @returns {{ el: HTMLElement, refresh(): void, destroy(): void }}
 */
export function createTimelineStrip(app) {
  // A chart's text equivalent (§10.3): role img with a sentence naming the series and the range.
  const canvas = h('canvas', {
    class: 'tl-strip-canvas',
    role: 'img',
    'aria-label': 'Event density over time for the current scope',
  });
  const tooltip = h('div', { class: 'tl-tooltip', hidden: true });
  const clearBtn = h('button', { class: 'tl-btn', type: 'button', hidden: true, onClick: () => app.setTimeRange(null, null) }, 'Clear range');
  const openBtn = h('button', { class: 'tl-btn', type: 'button', onClick: () => app.switchWorkspace('timeline') }, 'Open in Timeline');
  const el = h('div', { class: 'tl-strip' }, canvas, h('div', { class: 'tl-strip-actions' }, clearBtn, openBtn), tooltip);

  const st = {
    w: 0,
    h: 0,
    key: null,
    extent: null,
    gaps: [],
    overview: false,
    dataVersion: 0,
    lastData: 0,
    collapse: true,
    turns: null,
    view: null,
    zoomed: false,
    density: [],
    densityKey: null,
    marker: null,
    selEvent: undefined,
    drag: null,
    hoverX: null,
  };
  let seq = 0;
  let frame = 0;
  let alive = true;

  const pw = () => Math.max(1, st.w - 2 * STRIP_PAD);
  const gapOpts = () => ({ gaps: st.collapse ? st.gaps : NO_GAPS, breakPx: st.overview ? OVERVIEW_BREAK_PX : BREAK_PX });
  const scale = () => createScale({ ...st.view, ...gapOpts() });
  const turnRowY = () => st.h - 16;
  const render = () => {
    if (!frame && alive) frame = requestAnimationFrame(draw);
  };

  function fit() {
    if (!st.extent || !st.w) return;
    st.view = fitView(st.extent[0], st.extent[1], pw(), { ...gapOpts(), pad: 2 });
    st.zoomed = false;
  }

  async function refresh() {
    if (!alive) return;
    const scope = app.state.get('scope') ?? {};
    clearBtn.hidden = scope.from == null && scope.to == null;
    const ids = scope.sessions?.length ? scope.sessions : null;
    const collapse = loadPref(COLLAPSE_PREF, true);
    const key = [ids ? ids.join('\n') : '*', st.dataVersion].join('|');
    if (key !== st.key || collapse !== st.collapse) {
      st.key = key;
      st.collapse = collapse;
      const mine = ++seq;
      try {
        let busy;
        let extentItems;
        let turns = [];
        if (ids) {
          const details = (await Promise.all(ids.map((id) => loadSessionDetail(app, id).catch(() => null)))).filter((d) => d?.session);
          turns = details.flatMap(turnsOf);
          const children = details.flatMap((d) => d.children ?? []);
          extentItems = [...details.map((d) => d.session), ...children];
          busy = [...turns, ...details.filter((d) => !turnsOf(d).length).map((d) => d.session), ...children];
        } else {
          extentItems = await loadOverview(app);
          busy = extentItems;
          const info = app.state.get('info');
          if (!extentItems.length && info?.firstTs != null) extentItems = [{ start: info.firstTs, end: info.lastTs }];
        }
        if (mine !== seq) return;
        st.extent = extentOf(extentItems);
        st.overview = !ids;
        if (st.extent) canvas.setAttribute('aria-label', `Event density over time for the current scope, ${formatDayTime(st.extent[0])} to ${formatDayTime(st.extent[1])}; drag to set the time range`);
        // Across months, only long gaps are worth collapsing, and they become thin dividers (W08).
        st.gaps = st.overview ? findGaps(busy, gapThreshold(st.extent ? st.extent[1] - st.extent[0] : null)) : findGaps(busy);
        st.turns = turns.length ? makeRow(turns.filter((t) => Number.isFinite(t.start)).map(spanItem).sort(byStart), 0, 12, 10) : null;
        fit();
        st.densityKey = null;
      } catch {
        if (mine === seq) st.extent = null;
      }
    }
    syncDensity();
    syncMarker();
    render();
  }

  async function syncDensity() {
    const view = app.state.get('view');
    if (!st.view || !view?.viewId) {
      st.density = [];
      return;
    }
    const s = scale();
    const a = s.t(0);
    const b = s.t(pw());
    const key = [view.viewId, Math.round(a), Math.round(b), st.w, st.collapse].join('|');
    if (key === st.densityKey) return;
    st.densityKey = key;
    const parts = await loadDensity(app, view.viewId, s, a, b, pw());
    if (key !== st.densityKey) return;
    st.density = parts;
    render();
  }
  const syncDensitySoon = debounce(syncDensity, 150);

  async function syncMarker() {
    const id = app.state.get('selectedEvent') ?? null;
    if (id === st.selEvent) return;
    st.selEvent = id;
    st.marker = null;
    if (!id) return render();
    const detail = await loadEvent(app, id).catch(() => null);
    if (st.selEvent === id) {
      st.marker = detail?.event?.ts ?? null;
      render();
    }
  }

  function draw() {
    frame = 0;
    const { w, h: hgt } = st;
    if (!w || !hgt || !alive) return;
    const T = theme();
    const ctx = setupCanvas(canvas, w, hgt);
    ctx.fillStyle = T.color.bg;
    ctx.fillRect(0, 0, w, hgt);
    if (!st.view || !st.extent) {
      ctx.font = `${T.fsSm}px ${T.fontUi}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = T.color.fgMuted;
      ctx.fillText(st.key ? 'No events in scope' : 'Loading…', STRIP_PAD, hgt / 2);
      return;
    }
    const s = scale();
    const width = pw();
    const tA = s.t(0);
    const tB = s.t(width);
    const ticks = generateTicks(s, width, 90);
    ctx.fillStyle = T.color.bgElev;
    ctx.fillRect(0, 0, w, STRIP_AXIS_H);
    drawAxis(ctx, T, s, ticks, STRIP_PAD, width, STRIP_AXIS_H);

    ctx.save();
    ctx.beginPath();
    ctx.rect(STRIP_PAD, STRIP_AXIS_H, width, hgt - STRIP_AXIS_H);
    ctx.clip();
    ctx.fillStyle = T.color.border;
    for (const tk of ticks.ticks) ctx.fillRect(Math.round(STRIP_PAD + tk.x), STRIP_AXIS_H, 1, hgt - STRIP_AXIS_H);
    const densityTop = STRIP_AXIS_H + 4;
    const densityBottom = st.turns ? turnRowY() - 4 : hgt - 4;
    drawDensity(ctx, T, s, st.density, STRIP_PAD, densityTop, densityBottom - densityTop, T.color.fgMuted);
    if (st.turns) drawItems(ctx, T, s, [st.turns], { tA, tB, ox: STRIP_PAD, oy: turnRowY(), xMin: STRIP_PAD, xMax: STRIP_PAD + width });
    drawBreaks(ctx, T, s, tA, tB, STRIP_PAD, STRIP_AXIS_H, hgt, false, st.overview ? 'line' : 'zigzag', gapOpts().breakPx);
    drawScopeRange(ctx, T, s, app.state.get('scope'), STRIP_PAD, STRIP_AXIS_H, width, hgt - STRIP_AXIS_H);
    if (st.marker != null) drawMarker(ctx, T, STRIP_PAD + s.x(st.marker), STRIP_AXIS_H, hgt - STRIP_AXIS_H);
    if (st.drag?.moved) drawBrush(ctx, T, STRIP_PAD + st.drag.x0, STRIP_PAD + st.drag.x1, STRIP_AXIS_H, hgt - STRIP_AXIS_H);
    else if (st.hoverX != null) {
      ctx.fillStyle = T.color.fgFaint;
      ctx.fillRect(Math.round(st.hoverX), STRIP_AXIS_H, 1, hgt - STRIP_AXIS_H);
    }
    ctx.restore();
  }

  const localX = (e) => e.clientX - canvas.getBoundingClientRect().left - STRIP_PAD;
  const localY = (e) => e.clientY - canvas.getBoundingClientRect().top;

  function turnAt(px, y) {
    if (!st.turns || y < turnRowY() || y > turnRowY() + 12) return null;
    const s = scale();
    const t = s.t(px);
    const tA = s.t(px - 2);
    const { items, maxEnd } = st.turns;
    let best = null;
    for (let i = lowerBound(maxEnd, tA); i < items.length && items[i].start <= s.t(px + 2); i++) {
      if (items[i].end >= tA && (!best || Math.abs(items[i].start - t) < Math.abs(best.start - t))) best = items[i];
    }
    return best;
  }

  function binTip(t) {
    for (const p of st.density) {
      const i = Math.floor((t - p.from) / p.binUs);
      if (i < 0 || i >= p.bins.length) continue;
      const b = p.bins[i];
      const from = p.from + i * p.binUs;
      return [
        h('div', { class: 'tl-tip-title' }, `${formatInt(b.count ?? 0)} events${b.errors ? ` · ${formatInt(b.errors)} errors` : ''}`),
        tipRow('Time', `${formatClock(from)} → ${formatClock(from + p.binUs, { date: false })}`),
      ];
    }
    return null;
  }

  on(canvas, 'pointerdown', (e) => {
    if (e.button !== 0 || !st.view) return;
    const x = Math.max(0, Math.min(pw(), localX(e)));
    st.drag = { x0: x, x1: x, y: localY(e), moved: false };
    canvas.setPointerCapture(e.pointerId);
    placeTooltip(tooltip, null);
  });

  on(canvas, 'pointermove', (e) => {
    if (!st.view) return;
    const x = localX(e);
    const y = localY(e);
    const d = st.drag;
    if (d) {
      d.x1 = Math.max(0, Math.min(pw(), x));
      d.moved ||= Math.abs(d.x1 - d.x0) > 3;
      return render();
    }
    st.hoverX = x >= 0 && x <= pw() ? STRIP_PAD + x : null;
    const turn = turnAt(x, y);
    placeTooltip(tooltip, turn ? spanTip(turn.span) : binTip(scale().t(x)), x + STRIP_PAD, y, st.w, st.h);
    render();
  });

  const endDrag = async (e) => {
    const d = st.drag;
    if (!d) return;
    st.drag = null;
    render();
    if (e.type !== 'pointerup') return;
    const s = scale();
    if (d.moved) {
      app.setTimeRange(Math.floor(s.t(Math.min(d.x0, d.x1))), Math.ceil(s.t(Math.max(d.x0, d.x1))));
      return;
    }
    const turn = turnAt(d.x0, d.y);
    if (turn?.span.firstEvent) return app.selectEvent(turn.span.firstEvent);
    const view = app.state.get('view');
    if (!view?.viewId || !view.count) return;
    const id = await eventNear(app, view, s.t(d.x0)).catch(() => null);
    if (id) app.selectEvent(id);
  };
  on(canvas, 'pointerup', endDrag);
  on(canvas, 'pointercancel', endDrag);
  on(canvas, 'pointerleave', () => {
    st.hoverX = null;
    placeTooltip(tooltip, null);
    render();
  });
  on(canvas, 'dblclick', () => {
    fit();
    syncDensity();
    render();
  });
  on(
    canvas,
    'wheel',
    (e) => {
      if (!st.view) return;
      e.preventDefault();
      const dx = wheelDelta(e, e.deltaX);
      const dy = wheelDelta(e, e.deltaY);
      const kMin = st.extent ? fitView(st.extent[0], st.extent[1], pw(), gapOpts()).k / 2 : 0;
      const next =
        e.shiftKey || Math.abs(dx) > Math.abs(dy)
          ? panView(st.view, e.shiftKey && !dx ? dy : dx, gapOpts())
          : zoomAround(st.view, localX(e), Math.exp(-dy * 0.0025), { ...gapOpts(), kMin, kMax: K_MAX });
      st.view = keepInView(next, st.extent, pw(), gapOpts());
      st.zoomed = true;
      placeTooltip(tooltip, null);
      render();
      syncDensitySoon();
    },
    { passive: false },
  );

  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    const hgt = el.clientHeight;
    if (w === st.w && hgt === st.h) return;
    st.w = w;
    st.h = hgt;
    if (!st.zoomed) fit();
    syncDensity();
    render();
  });
  ro.observe(el);
  const unwatch = watchTheme(render);
  const refreshSoon = debounce(refresh, 30);
  const unsub = app.state.subscribe(['scope', 'view', 'selectedEvent'], refreshSoon);
  let dataTimer = 0;
  const unsubIndex = app.state.subscribe(['indexVersion'], () => {
    const ids = app.state.get('scope')?.sessions ?? null;
    if (!app.changeAffects(ids?.length ? ids : null) || dataTimer) return;
    const every = ids?.length ? SESSION_REFRESH_MS : OVERVIEW_REFRESH_MS;
    dataTimer = setTimeout(() => {
      dataTimer = 0;
      st.lastData = Date.now();
      st.dataVersion++;
      refreshSoon();
    }, Math.max(0, st.lastData + every - Date.now()));
  });
  refresh();

  return {
    el,
    refresh,
    destroy() {
      alive = false;
      unsub();
      unsubIndex();
      clearTimeout(dataTimer);
      unwatch();
      ro.disconnect();
      refreshSoon.cancel();
      syncDensitySoon.cancel();
      if (frame) cancelAnimationFrame(frame);
      el.remove();
    },
  };
}
