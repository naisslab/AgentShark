// Flow workspace (SPEC §7.5, §7.8): a sequence diagram of one session, or of the selected turn.
// It honors the session set (exactly one session, with an explicit picker when several are
// selected) and the time range; the display filter does not apply.
// Lanes: User, Agent, one lane per tool kind the session used, one lane per subagent. Each
// event of a seq-sorted view is one row, so the diagram is a virtual list whose rows each draw
// their own slice of the lifelines plus one arrow, note or turn separator.

import { toolKindOf } from '../lib/colors.js';
import { clear, h, on, placeholder, svg } from '../lib/dom.js';
import { formatClock, formatDuration, formatInt, formatRelative, shortId } from '../lib/format.js';
import { createVirtualList, pagesForRange } from '../lib/virtual.js';
import { loadEvent, loadSessionDetail, rowsOf } from './timeline.js';

const ROW_H = 28;
const GUTTER_W = 96;
const MIN_LANE_W = 136;
const PAGE = 300;
const MAX_SUBAGENT_LANES = 12;
/** Index runs that touch the drawn session redraw it at most this often. */
const LIVE_REFRESH_MS = 15_000;
/** Average label glyph width at --fs-xs, used to truncate labels without measuring. */
const CHAR_W = 6.4;
const ARROW_Y = ROW_H - 9;

// `kind in {...}` instead of bare layer words: a bare `agent` would name the session.agent field.
const FLOW_KINDS = [
  'user.prompt', 'llm.text', 'llm.error', 'tool.call', 'tool.result',
  'agent.spawn', 'agent.message', 'agent.status', 'turn.start', 'turn.end', 'turn.abort',
];
const FLOW_FILTER = `kind in {${FLOW_KINDS.map((k) => JSON.stringify(k)).join(', ')}}`;

const TOOL_LANES = ['shell', 'file', 'web', 'mcp', 'agent', 'plan', 'other'];
const TOOL_LABEL = { shell: 'Shell', file: 'Files', web: 'Web', mcp: 'MCP', agent: 'Agent tools', plan: 'Plan', other: 'Other tools' };

const laneKind = (k) => (TOOL_LANES.includes(k) ? k : 'other');
const short = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);

/** @param {HTMLElement} root @param {any} app */
export default function createFlowWorkspace(root, app) {
  root.classList.add('fl-root');

  const st = {
    visible: false,
    key: null,
    seq: 0,
    view: null,
    base: 0,
    pages: new Map(),
    pending: new Set(),
    lanes: [],
    laneX: new Map(),
    laneW: MIN_LANE_W,
    width: 0,
    spawn: new Map(), // tool or workflow span id → subagent lane key
    toolKinds: new Map(), // tool name → lane kind
    selected: null,
    selIndex: -1,
    ownClick: null,
    picked: null, // session chosen in the picker when several are in scope
    refresh: 0, // bumps when an index run touched the drawn session
    lastRefresh: 0,
  };

  const title = h('div', { class: 'fl-title' });
  const picker = h('div', { class: 'fl-picker', hidden: true });
  const scopeLine = h('div', { class: 'fl-scope' });
  const turnOnly = h('input', { type: 'checkbox', onChange: () => sync() });
  const status = h('span', { class: 'fl-status', role: 'status' });
  const headInner = h('div', { class: 'fl-head-inner' });
  const head = h('div', { class: 'fl-head', 'data-scroll-mirror': '' }, headInner);
  const scroller = h('div', { class: 'fl-scroll', tabindex: '0', 'aria-label': 'Sequence diagram. Arrow keys move the selection, Enter shows the event.' });
  const empty = h('div', { class: 'fl-empty', hidden: true });
  // The Session header carries the scope label and "Selected turn only" (§7.3); the lanes head is the only row here.
  app.setModeControls?.([h('label', { class: 'ws-ctl', title: 'Show only the turn that contains the selected event' }, turnOnly, 'Selected turn only'), picker]);
  root.append(head, h('div', { class: 'fl-body' }, scroller, empty));

  const list = createVirtualList(scroller, { rowHeight: ROW_H, createRow, renderRow, onRange: ensurePages });

  // -- data ----------------------------------------------------------------

  /** "Showing 1 of N selected sessions" and a picker; Flow draws one session and says which. */
  function renderPicker(ids, sid) {
    picker.hidden = ids.length < 2;
    if (ids.length < 2) return;
    const sel = h('select', { class: 'select fl-select', 'aria-label': 'Session to draw' },
      ids.map((id) => {
        const s = app.sessionById(id);
        return h('option', { value: id, selected: id === sid }, `${s?.title || s?.nativeId?.split('/').pop() || shortId(id)} (${shortId(id)})`);
      }));
    sel.addEventListener('change', () => {
      st.picked = sel.value;
      sync();
    });
    picker.replaceChildren(h('span', { class: 'fl-picker-label' }, `1 of ${ids.length} sessions`), sel);
  }

  function publishScope(sid, count) {
    const scope = app.state.get('scope') ?? {};
    const timed = scope.from != null || scope.to != null;
    const parts = [
      count != null ? `${formatInt(count)} events drawn` : sid ? 'Loading events…' : 'No session',
      timed ? `time range ${formatClock(scope.from, { digits: 0 }) || '…'} → ${formatClock(scope.to, { digits: 0 }) || '…'} applied` : 'whole session',
      'filter does not apply',
    ];
    const text = parts.join(' · ');
    scopeLine.textContent = text;
    app.setWorkspaceStatus('flow', text);
  }

  async function sync() {
    if (!st.visible) return;
    const scope = app.state.get('scope') ?? {};
    const sel = app.state.get('selectedEvent') ?? null;
    const ids = scope.sessions ?? [];
    if (st.picked && !ids.includes(st.picked)) st.picked = null;
    let sid = ids.length ? (st.picked ?? ids[0]) : null;
    let turn = null;
    if (!sid || turnOnly.checked) {
      const detail = sel ? await loadEvent(app, sel).catch(() => null) : null;
      sid ??= detail?.event?.session ?? null;
      if (turnOnly.checked) turn = detail?.event?.turn ?? null;
    }
    renderPicker(ids, sid);
    const key = [sid, turn, scope.from ?? '', scope.to ?? '', st.refresh, !!app.state.get('showInherited')].join('|');
    if (key !== st.key) await load(sid, turn, key);
    select(sel);
  }

  async function load(sid, turn, key) {
    const mine = ++st.seq;
    // A live refresh of the same session keeps the reader's place.
    const keepTop = st.key && st.key.split('|')[0] === String(sid) && st.key.split('|')[1] === String(turn) ? scroller.scrollTop : 0;
    st.key = key;
    st.view = null;
    st.pages = new Map();
    st.pending = new Set();
    st.selIndex = -1;
    list.setCount(0);
    showEmpty(null);
    clear(title);
    if (!sid) {
      status.textContent = '';
      title.append('Flow');
      publishScope(null, null);
      showEmpty(placeholder('empty', 'No session selected', 'Flow draws one session. Open a session in the sidebar, or select an event, to see its sequence diagram.'));
      return;
    }
    status.textContent = 'Loading…';
    publishScope(sid, null);
    const scope = app.state.get('scope') ?? {};
    try {
      const detail = await loadSessionDetail(app, sid);
      if (detail?.session) app.rememberSessions([detail.session, ...(detail.children ?? [])]);
      const filter = turn ? `(${FLOW_FILTER}) && turn == ${JSON.stringify(turn)}` : FLOW_FILTER;
      // Dup events mirror other events and would draw every arrow twice, so they stay hidden.
      const view = await app.api.createView({
        filter,
        sessions: [sid],
        descendants: false,
        sort: 'seq',
        from: scope.from ?? undefined,
        to: scope.to ?? undefined,
        includeInherited: !!app.state.get('showInherited'),
        includeDup: false,
      });
      const [tools, workflows] = await Promise.all([
        app.api.stats('tools', { view: view.viewId }).catch(() => null),
        app.api.spans({ sessions: [sid], kinds: ['workflow'], limit: 1000 }).catch(() => null),
      ]);
      if (mine !== st.seq) return;
      buildLanes(detail, tools?.tools ?? null, workflows?.spans ?? []);
      layoutLanes();
      st.view = view;
      st.base = view.firstTs ?? detail.session?.start ?? 0;
      const s = detail.session ?? {};
      title.append(h('span', { class: 'fl-title-name', title: s.id ?? sid }, s.title || shortId(sid)));
      if (turn) title.append(h('span', { class: 'fl-title-sub' }, 'selected turn'));
      status.textContent = `${formatInt(view.count)} events`;
      publishScope(sid, view.count);
      list.setCount(view.count);
      if (keepTop) scroller.scrollTop = keepTop;
      if (!view.count) {
        const timed = scope.from != null || scope.to != null;
        showEmpty(placeholder('empty', 'Nothing to draw',
          turn ? 'The selected turn has no prompts, model text or tool calls.' : timed ? 'Nothing in this session falls inside the time range.' : 'This session has no prompts, model text or tool calls.',
          timed ? { label: 'Widen range', onClick: () => app.setTimeRange(null, null) } : null));
      }
      if (st.selected) locateSelected(st.selected);
    } catch (err) {
      if (mine !== st.seq) return;
      status.textContent = '';
      st.key = null;
      showEmpty(placeholder('error', 'Could not load the flow. Your selection is preserved.', err?.message ?? String(err), { label: 'Retry', onClick: () => sync() }));
    }
  }

  function buildLanes(detail, tools, workflows) {
    st.toolKinds = new Map((tools ?? []).map((t) => [t.tool, laneKind(t.kind ?? toolKindOf(t.tool))]));
    // Without tool statistics every tool lane is shown, so no call loses its target.
    const used = tools ? new Set(st.toolKinds.values()) : new Set(TOOL_LANES);
    const session = detail.session ?? {};
    const children = (detail.children ?? []).filter((c) => c.parentSpanId).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    const shown = children.slice(0, MAX_SUBAGENT_LANES);
    st.lanes = [
      { key: 'user', label: 'User' },
      { key: 'agent', label: 'Agent', sub: session.models?.join(', ') || session.agent },
      ...TOOL_LANES.filter((k) => used.has(k)).map((k) => ({ key: 'tool:' + k, label: TOOL_LABEL[k] })),
      ...shown.map((c) => ({ key: 'sub:' + c.id, label: c.title || shortId(c.id), sub: c.role, session: c })),
    ];
    if (children.length > shown.length) st.lanes.push({ key: 'sub:*', label: `${children.length - shown.length} more subagents` });

    // A child's parentSpanId is the tool span that launched it; workflow agents hang off a
    // workflow span whose parent is the Workflow tool span.
    const wfParent = new Map(workflows.map((sp) => [sp.id, sp.parent]));
    st.spawn = new Map();
    for (const c of children) {
      const lane = shown.includes(c) ? 'sub:' + c.id : 'sub:*';
      for (const spanId of [c.parentSpanId, wfParent.get(c.parentSpanId)]) {
        if (spanId && !st.spawn.has(spanId)) st.spawn.set(spanId, lane);
      }
    }
  }

  function layoutLanes() {
    const n = Math.max(1, st.lanes.length);
    st.laneW = Math.max(MIN_LANE_W, Math.floor((scroller.clientWidth - GUTTER_W) / n));
    st.laneX = new Map(st.lanes.map((l, i) => [l.key, GUTTER_W + st.laneW * (i + 0.5)]));
    st.width = GUTTER_W + st.laneW * n;
    root.style.setProperty('--fl-width', `${st.width}px`);
    clear(headInner);
    headInner.append(h('div', { class: 'fl-lane-head fl-gutter-head', style: { left: '0px', width: `${GUTTER_W}px` } }, 'Time'));
    for (const lane of st.lanes) {
      const style = { left: `${st.laneX.get(lane.key) - st.laneW / 2}px`, width: `${st.laneW}px` };
      const body = [h('span', { class: 'fl-lane-name' }, lane.label), lane.sub ? h('span', { class: 'fl-lane-sub' }, lane.sub) : null];
      headInner.append(
        lane.session
          ? h('button', { class: 'fl-lane-head fl-lane-link', type: 'button', style, title: `Open ${lane.session.id} in Flow`, onClick: () => app.openSession(lane.session.id, { workspace: 'flow' }) }, ...body)
          : h('div', { class: 'fl-lane-head', style, title: lane.label }, ...body),
      );
    }
  }

  function rowAt(i) {
    return st.pages.get(Math.floor(i / PAGE))?.[i % PAGE] ?? null;
  }

  function ensurePages(start, end) {
    if (!st.view) return;
    for (const p of pagesForRange(start, end, PAGE)) if (!st.pages.has(p) && !st.pending.has(p)) fetchPage(p);
  }

  async function fetchPage(p) {
    const { view, pending } = st;
    pending.add(p);
    try {
      const rows = rowsOf(await app.api.viewRows(view.viewId, p * PAGE, PAGE));
      if (st.view !== view) return;
      st.pages.set(p, rows);
      list.refresh();
    } catch (err) {
      if (st.view === view) status.textContent = err?.message ?? String(err);
    } finally {
      pending.delete(p);
    }
  }

  // -- selection -----------------------------------------------------------

  function select(id) {
    if (id === st.selected) return;
    st.selected = id;
    list.refresh();
    if (id && id !== st.ownClick) locateSelected(id);
    st.ownClick = null;
  }

  async function locateSelected(id) {
    const view = st.view;
    if (!view) return;
    const res = await app.api.locate(view.viewId, id).catch(() => null);
    if (st.view !== view || st.selected !== id || res?.no == null) return;
    st.selIndex = res.no - 1;
    list.scrollToIndex(st.selIndex, 'center');
  }

  function choose(i, reveal) {
    const ev = rowAt(i);
    if (!ev) return;
    st.selIndex = i;
    st.ownClick = ev.id;
    app.selectEvent(ev.id, { reveal });
  }

  const rowIndex = (e) => {
    const row = e.target instanceof Element ? e.target.closest('.fl-row') : null;
    return row ? Number(row.dataset.i) : -1;
  };
  on(scroller, 'click', (e) => choose(rowIndex(e), false));
  on(scroller, 'dblclick', (e) => choose(rowIndex(e), true));
  on(scroller, 'scroll', () => {
    headInner.style.transform = `translateX(${-scroller.scrollLeft}px)`;
  });
  on(scroller, 'keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' && st.selected) {
      e.preventDefault();
      app.selectEvent(st.selected);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.count) {
      e.preventDefault();
      const next = Math.max(0, Math.min(list.count - 1, st.selIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      list.scrollToIndex(next);
      choose(next, false);
    }
  });

  // -- rows ----------------------------------------------------------------

  function createRow() {
    return h('div', { class: 'fl-row' }, svg('svg', { class: 'fl-svg', height: ROW_H, 'aria-hidden': 'true' }));
  }

  function renderRow(el, i) {
    const ev = rowAt(i);
    el.dataset.i = String(i);
    el.classList.toggle('fl-sel', !!ev && ev.id === st.selected);
    el.title = ev ? `${ev.kind}  ${ev.summary}` : '';
    const g = clear(el.firstChild);
    g.setAttribute('width', String(st.width));
    for (const x of st.laneX.values()) g.append(svg('line', { class: 'fl-life', x1: x, x2: x, y1: 0, y2: ROW_H }));
    if (!ev) {
      g.append(svg('text', { class: 'fl-time', x: 8, y: ARROW_Y + 4 }, '…'));
      return;
    }
    const offset = ev.ts - st.base;
    g.append(svg('text', { class: 'fl-time', x: 8, y: ARROW_Y + 4 }, (offset >= 0 ? '+' : '') + formatRelative(offset)));
    const d = classify(ev);
    if (d.sep) drawSeparator(g, d);
    else if (d.note || !st.laneX.has(d.from) || !st.laneX.has(d.to) || d.from === d.to) drawNote(g, d);
    else drawArrow(g, d);
  }

  /** What one event draws: an arrow between lanes, a note on a lane, or a turn separator. */
  function classify(ev) {
    const err = ev.flags?.includes('error');
    const label = ev.summary || ev.kind;
    const toolLane = () => st.spawn.get(ev.span) ?? 'tool:' + laneKind(st.toolKinds.get(ev.toolName) ?? toolKindOf(ev.toolName));
    switch (ev.kind) {
      case 'user.prompt':
        return { from: 'user', to: 'agent', cls: 'fl-prompt', label };
      case 'llm.text':
        return { from: 'agent', to: 'user', cls: 'fl-text', label };
      case 'tool.call': {
        const to = toolLane();
        return { from: 'agent', to, cls: to.startsWith('sub:') ? 'fl-spawn' : `fl-call fl-k-${to.slice(5)}`, label };
      }
      case 'tool.result': {
        const from = toolLane();
        const took = formatDuration(ev.dur);
        const cls = `fl-return ${err ? 'fl-err' : from.startsWith('sub:') ? 'fl-spawn' : `fl-k-${from.slice(5)}`}`;
        return { from, to: 'agent', cls, label: took ? `${label} · ${took}` : label };
      }
      case 'agent.spawn':
      case 'agent.message':
        return { from: 'agent', to: st.spawn.get(ev.span) ?? 'tool:agent', cls: 'fl-spawn', label };
      case 'agent.status': {
        const from = st.spawn.get(ev.span);
        return from ? { from, to: 'agent', cls: 'fl-spawn fl-return', label } : { note: 'agent', cls: 'fl-info', label };
      }
      case 'turn.start':
      case 'turn.end':
      case 'turn.abort': {
        const took = ev.kind !== 'turn.start' ? formatDuration(ev.dur) : '';
        const cls = err || ev.kind === 'turn.abort' ? 'fl-err' : ev.kind === 'turn.start' ? 'fl-turn-start' : 'fl-turn-end';
        return { sep: true, cls, label: took ? `${label} · ${took}` : label };
      }
      default:
        return { note: 'agent', cls: err ? 'fl-err' : 'fl-info', label };
    }
  }

  function drawArrow(g, d) {
    const x1 = st.laneX.get(d.from);
    const x2 = st.laneX.get(d.to);
    const dir = x2 > x1 ? 1 : -1;
    g.append(
      svg('line', { class: `fl-arrow ${d.cls}`, x1, y1: ARROW_Y, x2: x2 - dir * 6, y2: ARROW_Y }),
      svg('path', { class: `fl-head ${d.cls}`, d: `M${x2} ${ARROW_Y} l${-dir * 7} -4 v8 z` }),
    );
    const n = Math.floor((Math.abs(x2 - x1) - 14) / CHAR_W);
    if (n >= 3) g.append(svg('text', { class: 'fl-label', x: Math.min(x1, x2) + 7, y: ARROW_Y - 5 }, short(d.label, n)));
  }

  function drawNote(g, d) {
    const lane = st.laneX.has(d.note ?? d.from) ? (d.note ?? d.from) : 'agent';
    const x = st.laneX.get(lane);
    g.append(
      svg('circle', { class: `fl-dot ${d.cls}`, cx: x, cy: ARROW_Y, r: 3.5 }),
      svg('text', { class: `fl-label fl-note ${d.cls}`, x: x + 8, y: ARROW_Y + 4 }, short(d.label, Math.floor((st.width - x - 12) / CHAR_W))),
    );
  }

  function drawSeparator(g, d) {
    const y = ROW_H / 2;
    const text = short(d.label, Math.max(4, Math.floor((st.width - GUTTER_W - 24) / CHAR_W)));
    g.append(
      svg('line', { class: `fl-sep ${d.cls}`, x1: GUTTER_W - 8, x2: st.width, y1: y, y2: y }),
      svg('rect', { class: 'fl-sep-bg', x: GUTTER_W, y: y - 8, width: text.length * CHAR_W + 12, height: 16, rx: 3 }),
      svg('text', { class: `fl-sep-label ${d.cls}`, x: GUTTER_W + 6, y: y + 4 }, text),
    );
  }

  function showEmpty(content) {
    clear(empty);
    empty.hidden = !content;
    if (content) empty.append(content);
  }

  // -- lifecycle -----------------------------------------------------------

  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = scroller.clientWidth;
    if (!w || w === lastWidth) return;
    lastWidth = w;
    if (st.lanes.length) {
      layoutLanes();
      list.refresh();
    }
  }).observe(scroller);

  app.state.subscribe(['scope', 'selectedEvent', 'showInherited'], () => sync());
  let refreshTimer = 0;
  app.state.subscribe(['indexVersion'], () => {
    // Redraw only when the index run touched the drawn session, and at most every 15 s.
    const sid = st.key?.split('|')[0];
    if (!sid || !app.changeAffects([sid]) || refreshTimer) return;
    const wait = Math.max(0, st.lastRefresh + LIVE_REFRESH_MS - Date.now());
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      st.lastRefresh = Date.now();
      st.refresh++;
      sync();
    }, wait);
  });

  return {
    show() {
      st.visible = true;
      sync();
    },
    hide() {
      st.visible = false;
    },
  };
}
