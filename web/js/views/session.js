// Session workspace (SPEC §12.7): one session (plus a descendants toggle) in three modes. Steps is the
// default: a Run report strip, then turns and their steps (one model response with its calls) with call
// chips, an episode gutter and time bars. Transcript and Flow mount the former Conversation and Flow
// workspaces. The display filter and the time range highlight and dim steps, never hide them; the label
// reads "Session X · 213 steps · filter highlights 14".

import { h, clear, placeholder, icon, mark, agentDot, badge, showMenu, debounce, makeSplitter, autoTitle, setScopeLabel } from '../lib/dom.js';
import { createVariableList } from '../lib/virtual.js';
import { formatDuration, formatInt, formatTokens, formatClock, formatDayTime, stampTitle, shortId, agentColor, agentLabel, plural } from '../lib/format.js';
import { loadPref, savePref } from '../state.js';
import {
  IMPACT, TIME_BUCKET, ALARM, DELEGATION, CLAIM, UNVERIFIED_CLAIMS, impactRank, refTime, stepsLabel, stepTimes, timeSegments, } from '../lib/derived.js';
import { gapHeadline } from '../lib/workbench-format.js';
import { provEl, impactChip, claimChip, createEventPane } from './lens.js';

const PAGE = 1000;
const MAX_SEEK_PAGES = 20;
const ROW_H = { turn: 28, step: 22, folded: 22, more: 40, outside: 28 };
const LIVE_REFRESH_MS = 15_000;
/** A revealed row keeps this many pixels (about a row and a half) clear of the list's edges. */
const ROW_MARGIN = 40;
const MODES = [
  { id: 'steps', label: 'Steps' },
  { id: 'transcript', label: 'Transcript', file: './conversation.js', status: 'conversation' },
  { id: 'flow', label: 'Flow', file: './flow.js', status: 'flow' },
];
// Active time (model + tool) ranks the slow steps; wall time runs to the next step, so it also ranks idle gaps.
const SORTS = [
  { id: 'seq', label: 'No. (tree)', order: 'asc' },
  { id: 'active', label: 'Active time', order: 'desc' },
  { id: 'dur', label: 'Wall time (with gap)', order: 'desc' },
  { id: 'tokIn', label: 'Tokens in', order: 'desc' },
  { id: 'tokOut', label: 'Tokens out', order: 'desc' },
  { id: 'ctx', label: 'Context', order: 'desc' },
];
/** Bucket colors of the stacked time bar (also the swatches of Statistics ▸ Time). */
export const BUCKET_COLOR = {
  'wait-human': 'var(--c-user)', 'wait-agent': 'var(--c-agent)', 'wait-process': 'var(--c-tool-shell)', 'api-retry': 'var(--err)',
  compaction: 'var(--c-compaction)', hook: 'var(--c-hook)', tool: 'var(--c-tool-file)', model: 'var(--c-llm)', unattributed: 'var(--bg-sunken)',
};
const GUTTER_LANES = 3;

/** A stacked time bar: one segment per bucket, its derived part hatched. onPick(bucket) narrows the steps. */
export function timeBar(segments, { onPick, picked } = {}) {
  const bar = h('div', { class: 'tbar', role: onPick ? 'group' : 'img', 'aria-label': 'Time by bucket' });
  for (const s of segments) {
    const pct = `${(s.frac * 100).toFixed(2)}%`;
    const label = `${TIME_BUCKET[s.name] ?? s.name}: ${formatDuration(s.us)}${s.loggedFrac < 1 && s.name !== 'unattributed' ? ` (${Math.round((1 - s.loggedFrac) * 100)}% derived, hatched)` : ''}${s.name === 'unattributed' ? ' (no bucket claims it; never counted as model time)' : ''}`;
    const seg = h(onPick && s.name !== 'unattributed' ? 'button' : 'span', {
      class: ['tseg', `tseg-${s.name}`, picked === s.name && 'on'], type: onPick ? 'button' : null, title: label, 'aria-label': label,
      style: { width: pct },
      onClick: onPick && s.name !== 'unattributed' ? (e) => { e.stopPropagation(); onPick(s.name); } : null,
    });
    // Custom properties need setProperty; a plain style assignment drops them.
    seg.style.setProperty('--seg', BUCKET_COLOR[s.name] ?? 'var(--fg-faint)');
    seg.style.setProperty('--logged', `${(s.loggedFrac * 100).toFixed(1)}%`);
    bar.append(seg);
  }
  return bar;
}

export default function createSessionWorkspace(root, app) {
  const { state, api } = app;
  root.classList.add('ss-root');
  let visible = false;

  // ---------------------------------------------------------------------------
  // Workspace header (§7.3): the mode switch and the scope label; on the right "Only turns with failures",
  // Descendants, Inspector and "Options ▾" (Sort, Fold clean turns, Columns).

  const pickerEl = h('button', { class: 'tool-btn ss-picker', type: 'button', hidden: true, 'aria-haspopup': 'menu' });
  const modeSeg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Session mode' });
  const descBox = h('input', { type: 'checkbox', checked: state.get('stepsDescendants') });
  const sortSel = { value: 'seq' };
  let foldClean = loadPref('steps.foldClean', false);
  const failBox = h('input', { type: 'checkbox', checked: loadPref('steps.onlyFailed', false) });
  const inspectBtn = h('button', { class: 'tool-btn ss-ins-btn', type: 'button', 'aria-pressed': 'false' }, 'Inspector');
  const hiddenCols = h('button', { class: 'tool-btn', type: 'button', hidden: true, 'aria-haspopup': 'menu' });
  const optionsBtn = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu' }, 'Options', icon('down', 10));
  const descCtl = h('label', { class: 'ws-ctl', title: 'Include the subagents of this session' }, descBox, 'Descendants');
  const stepsCtl = h('div', { class: 'ws-controls ss-steps-ctl' },
    h('label', { class: 'ws-ctl' }, failBox, 'Only turns with failures'),
    descCtl, inspectBtn, hiddenCols, optionsBtn);
  const scopeLine = h('div', { class: 'ws-scope ss-scope', 'aria-live': 'polite' });
  // Transcript and Flow put their own inline controls here (§7.3).
  const modeCtl = h('div', { class: 'ws-controls ss-mode-ctl' });
  const wsHead = h('div', { class: 'ws-head ss-wshead' }, modeSeg, scopeLine, pickerEl, stepsCtl, modeCtl);
  root.append(wsHead);
  // When the header is full, inline controls fold into Options ▾ from the right; the first never folds (§7.3).
  let folded = [];
  new ResizeObserver(() => {
    descCtl.hidden = false;
    inspectBtn.hidden = false;
    folded = [];
    for (const el of [inspectBtn, descCtl]) {
      if (wsHead.scrollWidth <= wsHead.clientWidth + 1) break;
      el.hidden = true;
      folded.push(el);
    }
  }).observe(wsHead);

  const strip = h('div', { class: 'ss-report' });
  const colHead = h('div', { class: 'ss-head', role: 'row' });
  const listEl = h('div', { class: 'ss-list', tabindex: '0', role: 'treegrid', 'aria-label': 'Turns and steps', 'data-f6': '' });
  const stepsNotice = h('div', { class: 'ss-notice', hidden: true });
  // Inspector (§8.1, §8.2): a right-hand column, 400 wide (360–560), hidden by default below 1728. Follow takes it
  // over in place (§7.9), opening it when it is closed.
  const inspector = createEventPane(app, { showInSession: false, onHide: () => syncInspector() });
  const insRegion = h('div', { class: 'ss-inspector', hidden: true, 'data-follow-host': '', 'data-shows-selection': '' }, inspector.el);
  const insSplit = h('div', { class: 'splitter splitter-x', role: 'separator', 'aria-label': 'Resize the steps and the inspector', hidden: true });
  const stepsMain = h('div', { class: 'ss-main' }, strip, colHead, stepsNotice, listEl);
  const stepsPane = h('div', { class: 'ss-mode ss-steps' }, stepsMain, insSplit, insRegion);
  let insW = loadPref('steps.inspectorW', 400);
  const applyInsW = () => insRegion.style.setProperty('width', `${Math.round(insW)}px`);
  applyInsW();
  makeSplitter(insSplit, {
    axis: 'x',
    invert: true,
    min: 360,
    max: 560,
    onStart: () => insRegion.getBoundingClientRect().width,
    onDrag: (px) => {
      insW = Math.max(360, Math.min(560, px));
      applyInsW();
      return insW;
    },
    onEnd: () => {
      savePref('steps.inspectorW', insW);
      revealSelected();
    },
    onReset: () => {
      insW = 400;
      applyInsW();
      savePref('steps.inspectorW', insW);
      return insW;
    },
  });
  window.addEventListener('agentshark:follow', (e) => {
    if (e.detail.host !== insRegion) return;
    insRegion.hidden = !e.detail.open && inspector.el.hidden;
    syncInspector();
  });
  function syncInspector() {
    const open = !inspector.el.hidden || insRegion.classList.contains('follow-on');
    insRegion.hidden = !open;
    insSplit.hidden = !open;
    inspectBtn.setAttribute('aria-pressed', String(open));
    requestAnimationFrame(() => fitColumns());
    // The list is shorter once the inspector opens: the selected step stays in view.
    requestAnimationFrame(revealSelected);
  }
  /** Select a call's event and show it in the inspector (a call chip click). */
  function inspect(eventId) {
    app.selectEvent(eventId, { reveal: false });
    inspector.show(eventId);
    syncInspector();
  }
  inspectBtn.addEventListener('click', () => {
    if (!inspector.el.hidden) return inspector.hide();
    if (insRegion.classList.contains('follow-on')) return document.querySelector('.follow .icon-btn[aria-label^="Close Follow"]')?.click();
    const id = state.get('selectedEvent');
    if (!id) return app.toast('Select a call first: the inspector shows its event.', 'info');
    inspect(id);
  });
  const modePanes = { steps: stepsPane };
  for (const m of MODES.slice(1)) modePanes[m.id] = h('section', { class: ['ss-mode', `ss-${m.id}`, 'ss-mounted'], hidden: true, 'aria-label': m.label });
  root.append(stepsPane, modePanes.transcript, modePanes.flow);

  optionsBtn.addEventListener('click', () => showMenu(optionsBtn, [
    ...(folded.includes(descCtl) ? [{ label: 'Descendants', checked: descBox.checked, onSelect: () => { descBox.checked = !descBox.checked; descBox.dispatchEvent(new Event('change')); } }] : []),
    ...(folded.includes(inspectBtn) ? [{ label: 'Inspector', checked: inspectBtn.getAttribute('aria-pressed') === 'true', onSelect: () => inspectBtn.click() }] : []),
    ...(folded.length ? [{ separator: true }] : []),
    { header: 'Sort' },
    ...SORTS.map((x) => ({ label: x.label, checked: sortSel.value === x.id, onSelect: () => setSort(x.id) })),
    { separator: true },
    { label: 'Fold clean turns', checked: foldClean, title: 'Leave out the steps of turns without failures; their turn rows stay', onSelect: () => {
      foldClean = !foldClean;
      savePref('steps.foldClean', foldClean);
      loadSteps();
    } },
    { separator: true },
    { header: 'Columns' },
    ...COLS.filter((c) => c.prio > 1 && !c.flatOnly).map((c) => ({ label: c.label, checked: !colOff.has(c.id), onSelect: () => toggleCol(c.id) })),
  ], { align: 'end', minWidth: 240 }));

  // ---------------------------------------------------------------------------
  // Which session: the Session focus (Show in Session, a Lens link) when the scope covers it, else the
  // scope's sessions with an explicit picker, else the selected event's session.

  let picked = null;
  let current = null;

  function covered(sid, ids) {
    for (let id = sid, depth = 0; id && depth < 12; depth++) {
      if (ids.includes(id)) return true;
      id = app.sessionById(id)?.parentId ?? null;
    }
    return false;
  }

  function resolve() {
    const ids = state.get('scope').sessions ?? [];
    const focus = state.get('sessionFocus');
    if (focus?.session && (!ids.length || covered(focus.session, ids))) return { sid: focus.session, ids };
    if (ids.length) return { sid: picked && ids.includes(picked) ? picked : ids[0], ids };
    return { sid: state.get('selectedDetail')?.event?.session ?? null, ids };
  }

  function renderHeader(sid, ids) {
    pickerEl.hidden = ids.length < 2;
    if (ids.length >= 2) {
      pickerEl.replaceChildren(`1 of ${ids.length} sessions`, icon('down', 10));
      pickerEl.onclick = () => showMenu(pickerEl, ids.map((id) => ({ label: app.sessionById(id)?.title || shortId(id), checked: id === sid, onSelect: () => {
        picked = id;
        state.set({ sessionFocus: null });
        sync();
      } })), { minWidth: 280 });
    }
    const mode = state.get('sessionMode');
    modeSeg.replaceChildren(...MODES.map((m) => h('button', {
      class: ['seg-btn', m.id === mode && 'on'], role: 'tab', type: 'button', 'aria-selected': String(m.id === mode), tabindex: m.id === mode ? '0' : '-1',
      onClick: () => app.switchWorkspace('session', { mode: m.id }),
    }, m.label)));
    stepsCtl.hidden = mode !== 'steps';
    modeCtl.hidden = mode === 'steps';
  }
  modeSeg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = MODES.findIndex((m) => m.id === state.get('sessionMode'));
    const next = MODES[(i + (e.key === 'ArrowRight' ? 1 : -1) + MODES.length) % MODES.length];
    e.preventDefault();
    app.switchWorkspace('session', { mode: next.id });
    requestAnimationFrame(() => modeSeg.querySelector('[aria-selected="true"]')?.focus());
  });

  // ---------------------------------------------------------------------------
  // Transcript and Flow: the former workspaces, mounted with the resolved session as their scope.

  const mounted = {};
  const modeControls = {};
  const modeStatus = {};
  function childApp(mode) {
    const wrapped = Object.create(app);
    wrapped.state = {
      get: (k) => (k === 'scope' ? { ...state.get('scope'), sessions: current ? [current] : state.get('scope').sessions } : state.get(k)),
      set: (patch) => state.set(patch),
      subscribe: (keys, fn) => state.subscribe(keys, fn),
    };
    // Transcript and Flow publish their scope label and inline controls into the Session header (§7.3).
    wrapped.setWorkspaceStatus = (_name, text) => {
      modeStatus[mode] = text;
      if (state.get('sessionMode') !== mode) return;
      setScopeLabel(scopeLine, text);
      app.setWorkspaceStatus('session', text);
    };
    wrapped.setModeControls = (els) => {
      modeControls[mode] = els.filter(Boolean);
      if (state.get('sessionMode') === mode) modeCtl.replaceChildren(...modeControls[mode]);
    };
    return wrapped;
  }

  async function showMode(mode) {
    for (const [id, pane] of Object.entries(modePanes)) pane.hidden = id !== mode;
    modeCtl.replaceChildren(...(modeControls[mode] ?? []));
    if (mode !== 'steps' && modeStatus[mode]) setScopeLabel(scopeLine, modeStatus[mode]);
    else if (mode === 'steps') publish();
    for (const [id, m] of Object.entries(mounted)) if (id !== mode) m.instance?.hide();
    if (mode === 'steps') return;
    const spec = MODES.find((m) => m.id === mode);
    let m = mounted[mode];
    if (!m) {
      m = mounted[mode] = { instance: null, loading: null };
      clear(modePanes[mode]).append(placeholder('loading', `Loading ${spec.label}…`));
      m.loading = import(spec.file).then((mod) => {
        clear(modePanes[mode]);
        m.instance = mod.default(modePanes[mode], childApp(mode));
      }).catch((err) => {
        delete mounted[mode];
        clear(modePanes[mode]).append(placeholder('error', `${spec.label} failed to load`, err.message, { label: 'Retry', onClick: () => showMode(mode) }));
      });
    }
    await m.loading;
    if (visible && state.get('sessionMode') === mode) m.instance?.show();
  }

  // ---------------------------------------------------------------------------
  // Steps data

  let page = null; // StepsPage, with steps merged across pages
  let report = null;
  let status = 'empty'; // empty | loading | failed | ready | unsupported
  let error = null;
  let loadSeq = 0;
  let loadedKey = null;
  let lastLoad = 0;
  let refreshTimer = 0;
  let bucket = null;
  const turnOpen = new Map(); // turn id → open (default open)
  const foldedSteps = new Map(); // turn id → steps fetched for a folded turn
  let selected = null; // 'turn:<id>' | 'step:<id>'
  let focusDone = null; // the sessionFocus request already shown

  const sortSpec = () => SORTS.find((s) => s.id === sortSel.value) ?? SORTS[0];
  const flat = () => sortSpec().id !== 'seq';

  /** The window's view when a filter or time range should highlight steps; null when there is nothing to highlight. */
  function highlightView() {
    const sc = state.get('scope');
    if (!state.get('filter') && sc.from == null && sc.to == null) return { view: null };
    const vs = app.viewState();
    if (vs.status === 'ready' || vs.status === 'ready-empty') return { view: vs.view.viewId };
    return { view: null, pending: vs.status === 'loading', failed: vs.status === 'failed' };
  }

  function stepsQuery(extra = {}) {
    const s = sortSpec();
    return {
      view: highlightView().view ?? undefined, sort: s.id, order: s.order, descendants: descBox.checked,
      foldClean, onlyFailed: failBox.checked, bucket: bucket ?? undefined, limit: PAGE, ...extra,
    };
  }

  async function loadSteps({ force = false } = {}) {
    if (!visible || state.get('sessionMode') !== 'steps') return;
    if (!api.features.derived) {
      status = 'unsupported';
      return renderSteps();
    }
    if (!current) {
      status = 'empty';
      return renderSteps();
    }
    const q = stepsQuery();
    const key = JSON.stringify([current, q, state.get('indexVersion'), state.get('scope').from]);
    if (!force && key === loadedKey && status === 'ready') return seekFocus();
    const seq = ++loadSeq;
    lastLoad = Date.now();
    const sid = current;
    // A refresh of the same session keeps its rows on screen until the new page arrives.
    if (status !== 'ready' || page?.sid !== sid) {
      status = 'loading';
      renderSteps();
    }
    try {
      const [steps, rep] = await Promise.all([
        api.sessionSteps(sid, q),
        api.runReport(sid, { since: state.get('scope').from ?? undefined }).catch((err) => ({ error: err })),
      ]);
      if (seq !== loadSeq) return;
      if (!steps) throw Object.assign(new Error('This session has no steps in the index.'), { status: 404 });
      page = { ...steps, sid };
      report = rep?.error ? null : rep;
      foldedSteps.clear();
      loadedKey = key;
      status = 'ready';
      error = null;
    } catch (err) {
      if (seq !== loadSeq) return;
      if (app.handleViewError(err)) return;
      status = 'failed';
      error = err;
    }
    renderSteps();
    seekFocus();
  }

  async function loadMore() {
    if (!page?.next || page.loadingMore) return false;
    page.loadingMore = true;
    renderList();
    const seq = loadSeq;
    try {
      const more = await api.sessionSteps(current, stepsQuery({ after: page.next }));
      if (seq !== loadSeq) return false;
      const turnIds = new Set(page.turns.map((t) => t.id));
      page = { ...page, turns: [...page.turns, ...more.turns.filter((t) => !turnIds.has(t.id))], steps: [...page.steps, ...more.steps], next: more.next, loadingMore: false };
    } catch (err) {
      page.loadingMore = false;
      app.toast(`Could not load more steps: ${err.message}`, 'error');
    }
    renderList();
    return true;
  }

  async function unfold(turnId) {
    try {
      const res = await api.sessionSteps(current, stepsQuery({ turn: turnId, foldClean: false, onlyFailed: false, after: undefined }));
      foldedSteps.set(turnId, res.steps);
      turnOpen.set(turnId, true);
      renderList();
    } catch (err) {
      app.toast(err.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Model: turn rows and step rows (tree), or step rows only (sorted).

  let model = [];
  let lanes = new Map(); // episode id → lane
  const list = createVariableList(listEl, { renderRow: (i) => renderRow(model[i], i), onRender: fitAllCalls });
  // A wider or narrower Calls column refits its chips.
  let listW = 0;
  new ResizeObserver(() => {
    if (listEl.clientWidth === listW) return;
    listW = listEl.clientWidth;
    list.refresh();
  }).observe(listEl);

  function buildModel() {
    const out = [];
    if (!page) return out;
    if (flat()) {
      for (const s of page.steps) out.push({ type: 'step', s });
    } else {
      const byTurn = new Map();
      const outside = [];
      for (const s of page.steps) {
        if (!s.turnId) outside.push(s);
        else {
          if (!byTurn.has(s.turnId)) byTurn.set(s.turnId, []);
          byTurn.get(s.turnId).push(s);
        }
      }
      for (const t of page.turns) {
        const open = turnOpen.get(t.id) ?? true;
        out.push({ type: 'turn', t, open });
        if (!open) continue;
        const steps = byTurn.get(t.id) ?? foldedSteps.get(t.id) ?? [];
        for (const s of steps) out.push({ type: 'step', s, t });
        if (!steps.length && t.nSteps > 0) out.push({ type: 'folded', t });
      }
      if (outside.length) {
        out.push({ type: 'outside', n: outside.length });
        for (const s of outside) out.push({ type: 'step', s });
      }
    }
    if (page.next) out.push({ type: 'more' });
    return out;
  }

  /** Lanes for the episode gutter: each episode gets the first lane free over its range of rows. */
  function assignLanes(rows) {
    const ranges = new Map();
    rows.forEach((m, i) => {
      if (m.type !== 'step') return;
      for (const ep of m.s.episodeIds ?? []) {
        const r = ranges.get(ep);
        if (r) r.end = i;
        else ranges.set(ep, { start: i, end: i });
      }
    });
    const out = new Map();
    const laneEnd = [];
    for (const [ep, r] of [...ranges].sort((a, b) => a[1].start - b[1].start)) {
      let lane = laneEnd.findIndex((end) => end < r.start);
      if (lane < 0) lane = laneEnd.length;
      laneEnd[lane] = r.end;
      out.set(ep, { lane: lane % GUTTER_LANES, ...r });
    }
    return out;
  }

  const rowKey = (m) => (m.type === 'turn' ? `turn:${m.t.id}` : m.type === 'step' ? `step:${m.s.id}` : null);

  function renderList() {
    model = buildModel();
    lanes = assignLanes(model);
    list.setRows(model.map((m) => ROW_H[m.type] ?? 26));
  }

  function renderSteps() {
    fitColumns();
    renderHeadRow();
    publish();
    if (status === 'ready' && (page.steps.length || page.turns.length)) {
      stepsNotice.hidden = true;
      listEl.hidden = false;
      renderReport();
      return renderList();
    }
    model = [];
    list.setRows([]);
    listEl.hidden = true;
    clear(strip);
    stepsNotice.hidden = false;
    if (status === 'unsupported') stepsNotice.replaceChildren(placeholder('empty', 'Steps need a newer AgentShark server', 'This server does not build the schema-4 analysis tables. Transcript and Flow still work.', { label: 'Open Transcript', onClick: () => app.switchWorkspace('session', { mode: 'transcript' }) }));
    else if (status === 'empty') stepsNotice.replaceChildren(placeholder('empty', 'Pick a session', 'Click a session in the sidebar, or use Show in Session on a failure or an event.', { label: 'Open Failures', onClick: () => app.switchWorkspace('failures') }));
    else if (status === 'loading') stepsNotice.replaceChildren(placeholder('loading', 'Loading steps…'));
    else if (status === 'ready') {
      renderReport();
      stepsNotice.replaceChildren(failBox.checked || bucket
        ? placeholder('empty', 'No turn matches these options', failBox.checked ? 'No turn of this session has a failure.' : 'No step spent time in this bucket.', { label: 'Show All Turns', onClick: () => { failBox.checked = false; savePref('steps.onlyFailed', false); if (bucket) pickBucket(bucket); else loadSteps({ force: true }); } })
        : placeholder('empty', 'No steps in this session', 'The session has no model responses in the index (a registry entry, or analysis pending).'));
    }
    else stepsNotice.replaceChildren(placeholder('error', 'Could not load this view.', error?.status === 404 ? 'The session is not in the analysis yet (analysis pending or outdated).' : ['Your selection is preserved.', h('div', { class: 't-meta' }, error?.message ?? '')], { label: 'Retry', onClick: () => loadSteps({ force: true }) }));
  }

  /** The scope label (§7.8): "79 steps · filter highlights 14"; the session title is in the run report only. */
  function publish() {
    if (state.get('sessionMode') !== 'steps') return;
    let text;
    if (!current) text = 'No session';
    else if (status === 'ready' && page) text = stepsLabel({ total: page.total, matched: page.matched, by: state.get('filter') ? 'filter' : 'time range' });
    else if (status === 'failed') text = 'Could not load steps';
    else text = 'Loading steps…';
    const hv = highlightView();
    if (status === 'ready' && hv.pending) text += ' · highlights pending';
    if (status === 'ready' && hv.failed) text += ' · highlights unavailable';
    setScopeLabel(scopeLine, text);
    app.setWorkspaceStatus('session', text);
  }

  // ---------------------------------------------------------------------------
  // Run report strip

  /**
   * The run report strip (§7.8): a title line (collapsible, persisted per viewer), a summary line of links, the
   * time bar labeled "Wall 45m 13s", and one data-gap line that discloses the server's notes.
   */
  let stripCollapsed = loadPref('steps.reportCollapsed', false);
  function renderReport() {
    clear(strip);
    const r = report;
    const s = current ? app.sessionById(current) : null;
    const title = r?.run?.title || s?.title || shortId(current ?? '', 16);
    const stalled = r?.stall?.stalledForS != null && r.stall.stalledForS >= 60;
    const live = r?.run?.status === 'possibly-running' && !stalled;
    const since = r?.since != null ? (state.get('sinceChip')?.from === r.since ? `since ${formatDayTime(r.since)} (last visit)` : `since ${formatDayTime(r.since)}`) : null;
    const role = { subagent: 'subagent', 'workflow-agent': 'workflow', guardian: 'guardian' }[s?.role];
    const twisty = h('button', { class: 'icon-btn ss-report-toggle', type: 'button', 'aria-expanded': String(!stripCollapsed), 'aria-label': stripCollapsed ? 'Expand the run report' : 'Collapse the run report' },
      h('span', { class: ['twisty', !stripCollapsed && 'open'] }, icon('chevron', 10)));
    twisty.addEventListener('click', () => {
      stripCollapsed = !stripCollapsed;
      savePref('steps.reportCollapsed', stripCollapsed);
      renderReport();
    });
    strip.append(h('div', { class: 'ss-report-title' },
      twisty,
      s?.agent ? h('span', { class: 'ss-agent' }, agentDot(agentColor(s.agent)), agentLabel(s.agent)) : null,
      autoTitle(h('h2', { class: 't-title ss-title-text' }, title), title),
      role ? h('span', { class: 'muted' }, role) : null,
      live ? badge('plain', 'Live', { tone: 'accent', markName: 'live', cls: 'live-mark' }) : stalled ? h('span', { class: 'warn', title: 'An open turn wrote nothing for this long and waits on no known process or question' }, `stalled ${formatDuration(r.stall.stalledForS * 1e6)}`) : r ? h('span', { class: 'muted' }, 'Finished') : null,
      r?.run.unattended ? h('span', { class: 'muted' }, 'unattended') : null,
      since ? h('span', { class: 't-meta', title: 'The report covers evidence at or after this time' }, since) : null));
    if (stripCollapsed) return;
    if (!r) {
      strip.append(h('div', { class: 'ss-report-row t-row2' }, 'The run report is unavailable for this session.'));
      return;
    }
    strip.append(summaryLine(r));
    const segs = timeSegments({ buckets: r.time?.buckets ?? [], unattributedUs: r.time?.unattributedUs ?? 0, wallUs: r.time?.wallUs });
    if (segs.length) {
      const bar = timeBar(segs, { onPick: pickBucket, picked: bucket });
      // The legend is the bar's tooltip (§7.8): each bucket and its time, and what hatching means.
      bar.title = [...segs.map((x) => `${TIME_BUCKET[x.name] ?? x.name} ${formatDuration(x.us)}`), segs.some((x) => x.loggedFrac < 1 && x.name !== 'unattributed') ? 'Hatched: derived from timestamps' : null].filter(Boolean).join('\n');
      strip.append(h('div', { class: 'ss-report-row ss-timebar' },
        h('span', { class: 't-row2' }, `Wall ${r.time?.wallUs != null ? formatDuration(r.time.wallUs) : '—'}`), bar,
        bucket ? h('span', { class: 'chip' }, h('span', { class: 'chip-kind' }, 'Bucket:'), h('span', { class: 'chip-label' }, TIME_BUCKET[bucket] ?? bucket),
          h('button', { class: 'chip-x', type: 'button', 'aria-label': 'Show all steps again', onClick: () => pickBucket(bucket) }, icon('close', 10))) : null));
    }
    const gaps = gapLine([...(r.gaps ?? []), ...(page?.gaps ?? [])]);
    if (gaps) strip.append(gaps);
  }

  /**
   * The summary line (§7.8): "21 turns · 79 steps (65 + 14 in subagents) · ✕ 5 failed · ↺ 1 recovered · ? 3 unverified
   * claims · peak context 85.2k of 258k · 3 files +43 −7". Items that do not fit move into "More ▾" in this order:
   * files, peak context, the subagent breakdown, turns.
   */
  function summaryLine(r) {
    const total = r.steps?.total ?? 0;
    const own = page?.total ?? null;
    const sub = own != null && !descBox.checked && total > own ? total - own : 0;
    const impacts = Object.entries(r.impact ?? {}).filter(([k, n]) => n > 0 && k !== 'clean').sort((a, b) => impactRank(a[0]) - impactRank(b[0]));
    const ctx = r.context ?? {};
    const link = (content, onClick, title) => h('button', { class: 'lens-link', type: 'button', title: title ?? null, onClick }, content);
    const items = [
      { key: 'turns', el: h('span', null, plural(r.turns?.total ?? 0, 'turn')) },
      { key: 'steps', el: link(plural(total, 'step'), () => { failBox.checked = false; savePref('steps.onlyFailed', false); if (bucket) pickBucket(bucket); else loadSteps({ force: true }); }) },
      sub ? { key: 'sub', el: h('span', { class: 'muted' }, `(${formatInt(own)} + ${formatInt(sub)} in subagents)`), glue: true } : null,
      ...impacts.map(([k, n]) => ({ key: k, el: link(h('span', { class: ['b-plain', `tone-${IMPACT[k].tone}`] }, mark(k), `${formatInt(n)} ${IMPACT[k].word}`), () => { failBox.checked = true; savePref('steps.onlyFailed', true); loadSteps(); }, `Only turns with failures`) })),
      r.delegations?.silent ? { key: 'silent', el: h('span', { class: 'b-plain tone-bad' }, mark('silent'), `${formatInt(r.delegations.silent)} silent ${r.delegations.silent === 1 ? 'child' : 'children'}`) } : null,
      r.claims?.unverified ? { key: 'claims', el: link(h('span', { class: 'b-plain tone-warn' }, mark('claim'), `${plural(r.claims.unverified, 'unverified claim')}`), (e) => claimMenu(e.currentTarget)) } : null,
      ctx.peakTokens != null ? { key: 'ctx', el: link(h('span', null, `peak context ${formatTokens(ctx.peakTokens)}${ctx.window ? ` of ${formatTokens(ctx.window)}` : ''}`, provEl(app, ctx.windowSrc)), () => setSort('ctx'), 'Sort the steps by context') } : null,
      r.changes?.files ? { key: 'files', el: h('span', { title: r.changes.shellMentions ? `${plural(r.changes.shellMentions, 'shell mention')} not counted: shell edits are not tracked` : null }, `${plural(r.changes.files, 'file')} `, h('span', { class: 'ok' }, `+${formatInt(r.changes.added)}`), ' ', h('span', { class: 'err' }, `−${formatInt(r.changes.removed)}`)) } : null,
      ...(r.alarms ?? []).filter((a) => a.state === 'firing').map((a) => ({ key: `alarm-${a.kind}`, el: h('span', { class: ['b-plain', ALARM[a.kind]?.notify ? 'tone-bad' : 'tone-warn'] }, mark('alarm'), ALARM[a.kind]?.word ?? a.kind) })),
    ].filter(Boolean);
    const line = h('div', { class: 'ss-report-row ss-summary' });
    const more = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu', hidden: true }, 'More', icon('down', 10));
    const paint = (omit) => {
      const shown = items.filter((x) => !omit.has(x.key));
      line.replaceChildren(...shown.flatMap((x, i) => [i && !x.glue ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '·') : null, x.el]).filter(Boolean), more);
      more.hidden = !omit.size;
    };
    // Then the impacts other than failed and recovered, rightmost first; the step count, failed, recovered,
    // unverified claims, silent children and alarms never move.
    const order = ['files', 'ctx', 'sub', 'turns', ...impacts.map(([k]) => k).filter((k) => k !== 'failed' && k !== 'recovered').reverse()];
    let omit = new Set();
    more.onclick = () => showMenu(more, items.filter((x) => omit.has(x.key)).map((x) => ({ label: x.el.textContent, onSelect: x.el.tagName === 'BUTTON' ? () => x.el.click() : null, disabled: x.el.tagName !== 'BUTTON' })));
    // Fold again on every width change (the inspector opening or closing narrows the strip), not once at build.
    const fit = () => {
      omit = new Set();
      paint(omit);
      for (const key of order) {
        if (line.scrollWidth <= line.clientWidth + 1) break;
        if (!items.some((x) => x.key === key)) continue;
        omit.add(key);
        paint(omit);
      }
    };
    paint(omit);
    let width = -1;
    new ResizeObserver(() => {
      if (!line.isConnected || line.clientWidth === width) return;
      width = line.clientWidth;
      fit();
    }).observe(line);
    return line;
  }

  /** "ⓘ 3 data gaps: Approvals are not logged, so approval waits count as tool time; …" (`gapHeadline`): one line that discloses the full notes (§7.8). */
  function gapLine(gaps) {
    const seen = new Map();
    for (const g of gaps) if (!seen.has(g.code)) seen.set(g.code, g);
    if (!seen.size) return null;
    const notes = [...seen.values()];
    const text = gapHeadline(notes.map((g) => g.message));
    const open = h('button', { class: 'lens-link', type: 'button', 'aria-expanded': 'false' }, 'Details');
    const list = h('ul', { class: 'ss-gap-list', hidden: true }, notes.map((g) => h('li', { title: [g.code, g.limit != null ? `SPEC §12.9 limit ${g.limit}` : null, g.field].filter(Boolean).join(' · ') }, g.message)));
    open.addEventListener('click', () => {
      list.hidden = !list.hidden;
      open.setAttribute('aria-expanded', String(!list.hidden));
      open.textContent = list.hidden ? 'Details' : 'Hide';
    });
    return h('div', { class: 'ss-gaps' },
      h('div', { class: 'ss-report-row' }, h('span', { class: 'muted' }, mark('info', { label: 'data gap' })), autoTitle(h('span', { class: 'ss-gap-line' }, text), text), open),
      list);
  }

  /** The note the server sends for a missing value of `field` ("steps[].gapUs"), for its "—" tooltip (§7.8). */
  const gapNote = (field) => (page?.gaps ?? []).find((g) => g.field === `steps[].${field}`)?.message ?? null;

  /** The unverified claims of this session, each opening its claim check in the Lens. */
  async function claimMenu(anchor) {
    const res = await api.claims({ session: current, descendants: true, limit: 50 }).catch(() => null);
    const rows = (res?.rows ?? []).filter((c) => UNVERIFIED_CLAIMS.includes(c.evidence));
    showMenu(anchor, rows.length
      ? [{ header: 'Unverified claims: open one to see its evidence' }, ...rows.map((c) => ({
        label: `T${turnOf(c.turnId)?.n ?? '?'} · ${CLAIM[c.evidence]?.short ?? c.evidence}`,
        hint: (c.claimExcerpt ?? '').slice(0, 60),
        onSelect: () => app.openLens({ kind: 'claim', id: c.turnId }),
      }))]
      : [{ header: res ? 'No unverified claim in this session' : 'Could not load the claims' }]);
  }

  /** Right-click on a call chip: Follow its streams, open its episode or Lens, show its event. */
  async function callMenu(chipEl, at) {
    const id = chipEl.dataset.event;
    const s = model.find((m) => m.type === 'step' && m.s.calls.some((c) => c.eventId === id))?.s;
    const c = s?.calls.find((x) => x.eventId === id);
    const { targets } = await app.followTargets(id);
    showMenu(at, [
      { header: `${c?.tool ?? 'call'}${c?.target ? ` · ${c.target}` : ''}` },
      ...targets.map((t) => ({ label: `Follow ${t.label}`, hint: t.kind === 'file' ? t.path : null, onSelect: () => app.openFollow(t, { targets }) })),
      { separator: true },
      c?.episodeId ? { label: 'Open the episode', hint: '⟳', onSelect: () => app.openEpisode(c.episodeId) } : null,
      c?.childSessionId ? { label: 'Open the delegation in the Lens', onSelect: () => app.openLens({ kind: 'delegation', id: c.childSessionId }) } : null,
      c?.childSessionId ? { label: 'Open the child in Session', onSelect: () => app.showSession(c.childSessionId) } : null,
      { label: 'Show the event', onSelect: () => app.selectEvent(id) },
    ], { minWidth: 240 });
  }

  function pickBucket(name) {
    bucket = bucket === name ? null : name;
    loadSteps({ force: true });
  }

  // ---------------------------------------------------------------------------
  // Rows

  /**
   * Columns (§4.4 Session · Steps): widths are the compact minimums; Intent and Calls flex. P4 hides first, then P3,
   * the rightmost first, when the primary columns would fall below 45% of the table; the header says how many.
   */
  const COLS = [
    { id: 'no', label: 'No.', sort: 'seq', w: 44, prio: 1, right: true },
    // A flat list with Descendants names each row's session: child sessions number their own steps (§4.4). It sits
    // left of Time, so Time hides first when P2 columns must go.
    { id: 'session', label: 'Session', flatOnly: true, descOnly: true, w: 120, prio: 2 },
    { id: 'time', label: 'Time', w: 112, prio: 2, right: true },
    { id: 'delta', label: 'Δ', w: 64, prio: 4, right: true, title: 'Time since the previous step' },
    { id: 'turn', label: 'Turn', flatOnly: true, w: 48, prio: 1 },
    { id: 'intent', label: 'Intent', w: 160, prio: 1, flex: true },
    { id: 'calls', label: 'Calls', w: 180, prio: 1, flex: true },
    { id: 'active', label: 'Active', sort: 'active', w: 72, prio: 1, right: true, title: 'Model plus tool time of the step; sorting by it flattens the turns' },
    { id: 'gap', label: 'Gap', w: 64, prio: 2, right: true, title: 'Wall time the model and tools did not use: mostly the idle stretch before the next step' },
    { id: 'ctx', label: 'Ctx', sort: 'ctx', w: 56, prio: 3, right: true },
    { id: 'out', label: 'Out', sort: 'tokOut', w: 48, prio: 3, right: true },
    { id: 'model', label: 'Model time', w: 88, prio: 3, right: true, title: 'Time the model took to answer this step' },
  ];
  const colOff = new Set(loadPref('steps.colsOff', []));
  let colAuto = new Set();
  const toggleCol = (id) => {
    if (colOff.has(id)) colOff.delete(id);
    else colOff.add(id);
    savePref('steps.colsOff', [...colOff]);
    fitColumns();
  };
  /** Whether a column applies to the current list: flat-only columns in a sorted list, Session with Descendants too. */
  const applies = (c) => (!c.flatOnly || flat()) && (!c.descOnly || descBox.checked);
  const shownCols = () => COLS.filter((c) => applies(c) && !colOff.has(c.id) && !colAuto.has(c.id));

  function fitColumns() {
    const width = listEl.clientWidth || stepsMain.clientWidth;
    if (!width) return;
    const cols = COLS.filter((c) => applies(c) && !colOff.has(c.id));
    let fixed = 12 + cols.filter((c) => !c.flex).reduce((a, c) => a + c.w, 0);
    const primary = 160 + 180;
    const next = new Set();
    // P4, then P3, then (Mac notes 5) P2, the rightmost first within each, before any column leaves the visible width.
    const order = [4, 3, 2].flatMap((p) => cols.filter((c) => c.prio === p).reverse());
    for (const c of order) {
      // P2 columns go only when the row does not fit at all, not for the 45% share.
      if (width - fixed >= (c.prio === 2 ? primary : Math.max(primary, 0.45 * width))) break;
      next.add(c.id);
      fixed -= c.w;
    }
    const changed = next.size !== colAuto.size || [...next].some((id) => !colAuto.has(id));
    colAuto = next;
    hiddenCols.hidden = !next.size;
    hiddenCols.textContent = `${plural(next.size, 'column')} hidden`;
    hiddenCols.onclick = () => optionsBtn.click();
    if (changed) {
      renderHeadRow();
      list.refresh();
    }
  }
  new ResizeObserver(() => fitColumns()).observe(stepsMain);

  /** A column a whole session lacks shows "ⓘ" in its header with the server's note (§7.8 Missing values). */
  function missingNote(id) {
    const field = { gap: 'gapUs', model: 'modelUs', ctx: 'ctxTokens', out: 'tokOut', active: 'activeUs' }[id];
    if (!field || !page?.steps?.length || page.steps.some((x) => x[field] != null)) return null;
    return gapNote(field) ?? 'Not logged for this session';
  }

  function renderHeadRow() {
    const sortId = sortSpec().id;
    colHead.replaceChildren(h('span', { class: 'ss-gutter' }), ...shownCols().map((c) => {
      const note = missingNote(c.id);
      const label = [c.label, c.sort && c.sort === sortId && c.sort !== 'seq' ? ' ▾' : '', note ? h('span', { class: 'ss-col-note', title: note, 'aria-label': note }, ' ', mark('info')) : null];
      const cls = ['ss-c', `ss-${c.id}`, c.right && 'right'];
      return c.sort
        ? h('button', { class: [...cls, 'ss-sort', c.sort === sortId && 'on'], type: 'button', title: c.sort === 'seq' ? 'Back to the turn tree' : `Sort by ${c.label.toLowerCase()}; flattens the turns`, onClick: () => setSort(c.sort) }, label)
        : h('span', { class: cls, title: c.title ?? null }, label);
    }));
  }

  /** A new order starts at its top (the slowest step for Active time), not at the old scroll offset. */
  function setSort(id) {
    sortSel.value = id;
    savePref('steps.sortBy', id);
    renderHeadRow();
    loadSteps().then(() => {
      listEl.scrollTop = 0;
    });
  }

  const turnOf = (id) => page?.turns.find((t) => t.id === id) ?? null;

  /** The session a step belongs to: its turn's, else the prefix of its id. */
  const stepSession = (s) => turnOf(s.turnId)?.sessionId ?? String(s.id).split('#')[0];
  const childTitle = (s) => {
    const sid = stepSession(s);
    return sid === current ? null : app.sessionById(sid)?.title || shortId(sid, 12);
  };

  /** Session cell (flat with Descendants): "this session" muted, or the child's agent dot and title. */
  function sessionCell(s) {
    const title = childTitle(s);
    if (!title) return h('span', { class: 'ss-c ss-session faint' }, 'this session');
    const agent = app.sessionById(stepSession(s))?.agent;
    return h('span', { class: 'ss-c ss-session' }, agent ? agentDot(agentColor(agent)) : null, autoTitle(h('span', { class: 'ss-session-title' }, title), title));
  }

  function gutter(s) {
    const child = flat() ? childTitle(s) : null;
    const eps = s.episodeIds?.length ? `${s.episodeIds.length} episode${s.episodeIds.length === 1 ? '' : 's'} (click to open)` : '';
    const g = h('span', { class: 'ss-gutter', title: [child ? `In ${child}` : null, eps].filter(Boolean).join('\n') });
    const i = model.findIndex((m) => m.type === 'step' && m.s === s);
    for (const [ep, r] of lanes) {
      if (i < r.start || i > r.end) continue;
      const hit = s.episodeIds?.includes(ep);
      g.append(h('span', { class: ['lane', `lane-${r.lane}`, hit && 'hit', i === r.start && 'first', i === r.end && 'last'], dataset: { episode: ep } }));
    }
    return g;
  }

  /**
   * A call token (§6.2 Call chips, §7.8): inline code with the tool and a short argument; a failure is Solid with
   * its mark, the other tiers Outline in their color; "⟳" follows a call inside an episode.
   */
  function callChip(c) {
    const spawn = c.childSessionId != null;
    const target = c.target?.replace(/^(sh|read|edit|web|mcp|agent|tool):/, '');
    const text = [c.tool ?? 'call', target && target !== c.tool ? target : null].filter(Boolean).join(' ');
    const cls = ['call-chip', 'call-token', c.tier && `tier-${c.tier}`, c.tier === 'failure' && 'is-failure', c.tier && c.tier !== 'failure' && `tone-${c.tier}`, c.match === false && 'nomatch', spawn && 'spawn', c.eventId === state.get('selectedEvent') && 'selected'];
    const name = [text, c.tier ? `tier ${c.tier}` : null, c.durUs != null ? formatDuration(c.durUs) : null, c.episodeId ? 'inside an episode' : null,
      spawn ? `child ${DELEGATION[c.childOutcome]?.word ?? 'outcome unknown'}${c.parentTold === false ? ', parent told: no' : ''}` : null].filter(Boolean).join(', ');
    return h('button', { class: cls, type: 'button', 'aria-label': name, dataset: { event: c.eventId, episode: c.episodeId ?? '' } },
      c.tier === 'failure' ? mark('failed') : null,
      autoTitle(h('span', { class: 'call-text' }, text), text),
      spawn ? h('span', { class: ['call-child', `tone-${DELEGATION[c.childOutcome]?.tone ?? 'muted'}`] }, ` ${DELEGATION[c.childOutcome]?.word ?? '?'}`, provEl(app, c.childOutcomeSrc)) : null,
      spawn && c.parentTold === false ? h('span', { class: 'call-told' }, ' · parent told: no') : null,
      c.episodeId ? h('span', { class: 'ep-mark', dataset: { openEpisode: c.episodeId }, title: 'Inside an episode: open it' }, mark('loop')) : null);
  }

  const timeRef = () => state.get('timeRef');
  function stepTime(s, t) {
    const ref = timeRef();
    if (ref != null) return { text: refTime(s.startTs, ref), title: `${stampTitle(s.startTs)}\nfrom the time reference` };
    const start = t?.startTs ?? turnOf(s.turnId)?.startTs;
    return start != null ? { text: refTime(s.startTs, start), title: `${stampTitle(s.startTs)}\nfrom the turn start` } : { text: formatClock(s.startTs, { digits: 3, date: false }), title: stampTitle(s.startTs) };
  }

  function renderRow(m, i) {
    if (!m) return h('div');
    const key = rowKey(m);
    const sel = key && key === selected;
    if (m.type === 'turn') return turnRow(m, sel);
    if (m.type === 'folded') return h('div', { class: 'ss-folded', role: 'row' }, h('button', { class: 'link-btn', type: 'button', dataset: { unfold: m.t.id } }, `Show ${plural(m.t.nSteps, 'folded clean step')}`));
    if (m.type === 'outside') return h('div', { class: 'ss-outside t-group', role: 'row' }, `${plural(m.n, 'step')} outside any turn`);
    if (m.type === 'more') return h('div', { class: 'ss-more', role: 'row' }, page?.loadingMore ? h('span', { class: 't-meta' }, 'Loading more steps…') : h('button', { class: 'btn', type: 'button', dataset: { more: '1' } }, 'Load More Steps'));
    const s = m.s;
    const prev = model[i - 1]?.type === 'step' ? model[i - 1].s : null;
    const t = stepTime(s, m.t);
    const tm = stepTimes(s);
    const failing = s.calls.some((c) => c.tier === 'failure');
    // A missing value is "—" in --fg-faint with the server's reason (§7.8); no figure is computed here.
    const miss = (cls, field, fallback) => h('span', { class: ['ss-c', cls, 'right', 'faint'], title: gapNote(field) ?? fallback }, '—');
    const cells = {
      no: h('span', { class: 'ss-c ss-no right' }, formatInt(s.n)),
      time: h('span', { class: 'ss-c ss-time right', title: t.title }, t.text),
      delta: h('span', { class: 'ss-c ss-delta right' }, prev && !flat() ? formatDuration(Math.abs(s.startTs - prev.startTs)) : ''),
      session: flat() ? sessionCell(s) : null,
      turn: flat() ? h('span', { class: 'ss-c ss-turn' }, turnOf(s.turnId)?.n != null ? `T${turnOf(s.turnId).n}` : '—') : null,
      intent: s.intent ? autoTitle(h('span', { class: 'ss-c ss-intent' }, s.intent, provEl(app, s.intentSrc)), s.intent) : h('span', { class: 'ss-c ss-intent faint', title: gapNote('intent') ?? 'The agent logged no intent for this step' }, '—'),
      calls: h('span', { class: 'ss-c ss-calls', dataset: { step: s.id } }, s.calls.map(callChip)),
      active: tm.active != null ? h('span', { class: 'ss-c ss-active right' }, formatDuration(tm.active)) : miss('ss-active', 'activeUs', 'Neither model nor tool time was measured'),
      gap: tm.gap != null ? h('span', { class: 'ss-c ss-gap right' }, formatDuration(tm.gap)) : miss('ss-gap', 'gapUs', 'The server sent no gap for this step'),
      ctx: s.ctxTokens != null ? h('span', { class: 'ss-c ss-ctx right' }, formatTokens(s.ctxTokens), s.compactionBefore ? h('span', { class: 'muted', title: 'A compaction happened before this step' }, ' c') : null) : miss('ss-ctx', 'ctxTokens', 'Context size not logged'),
      out: s.tokOut != null ? h('span', { class: 'ss-c ss-out right' }, formatTokens(s.tokOut)) : miss('ss-out', 'tokOut', 'Output tokens not logged'),
      model: s.modelUs != null ? h('span', { class: 'ss-c ss-model right' }, formatDuration(s.modelUs), provEl(app, s.modelSrc)) : miss('ss-model', 'modelUs', 'Model time not logged'),
    };
    return h('div', {
      class: ['ss-step', sel && 'selected', s.match === false && 'nomatch', s.match === true && 'match', failing && 'failing', s.calls.some((c) => c.eventId === state.get('selectedEvent')) && 'has-selected'],
      role: 'row', 'aria-selected': String(!!sel), dataset: { key },
    }, gutter(s), ...shownCols().map((c) => cells[c.id]));
  }

  /** Turn row (§7.8): disclosure, "T6", the prompt excerpt, outcome, claim mark, wall time and a 120 px time bar. */
  function turnRow(m, sel) {
    const t = m.t;
    const segs = timeSegments({ buckets: t.buckets ?? [], unattributedUs: t.unattributedUs ?? 0, wallUs: t.wallUs });
    const s = t.sessionId !== current ? app.sessionById(t.sessionId) : null;
    const role = { subagent: 'subagent', 'workflow-agent': 'workflow', guardian: 'guardian' }[s?.role] ?? s?.role ?? 'child';
    const bar = segs.length ? timeBar(segs, { onPick: pickBucket, picked: bucket }) : h('span', { class: 'tbar empty', title: 'No time was attributed in this turn' });
    if (segs.length) bar.title = segs.map((x) => `${TIME_BUCKET[x.name] ?? x.name} ${formatDuration(x.us)}`).join('\n');
    return h('div', { class: ['ss-trow', sel && 'selected', `impact-${t.impact}`], role: 'row', 'aria-expanded': String(m.open), 'aria-selected': String(!!sel), dataset: { key: rowKey(m) } },
      h('span', { class: ['twisty', m.open && 'open'], dataset: { toggle: t.id } }, icon('chevron', 10)),
      // A descendant's turn names its session: its turns count from T1 within that session.
      // The role word merges into a title that already starts with it ("guardian review", not "guardian guardian review").
      s || t.sessionId !== current ? h('span', { class: 'ss-child' }, s?.agent ? agentDot(agentColor(s.agent)) : null,
        new RegExp(`^${role}\\b`, 'i').test(s?.title ?? '') ? null : h('span', { class: 'muted' }, role),
        autoTitle(h('span', { class: 'ss-child-title' }, s?.title || shortId(t.sessionId, 12)), s?.title || t.sessionId)) : null,
      h('span', { class: 'ss-tn' }, `T${t.n}`),
      autoTitle(h('span', { class: 'ss-prompt' }, t.promptExcerpt ?? h('span', { class: 'faint' }, 'no prompt')), t.promptExcerpt ?? ''),
      impactChip(t.impact),
      t.claim ? h('button', { class: 'claim-btn', type: 'button', 'aria-label': `Open the claim check: ${CLAIM[t.claim]?.word ?? t.claim}`, dataset: { claim: t.id } }, claimChip(app, t.claim)) : null,
      t.unattended ? h('span', { class: 'muted' }, 'unattended') : null,
      t.open ? h('span', { class: 'warn', title: 'The turn has not ended' }, 'open') : null,
      h('span', { class: 'ss-tmeta' }, t.matchedSteps != null ? `${formatInt(t.matchedSteps)} of ${plural(t.nSteps, 'step')}` : plural(t.nSteps, 'step')),
      h('span', { class: 'ss-twall' }, t.wallUs != null ? formatDuration(t.wallUs) : '—', provEl(app, t.wallSrc)),
      bar);
  }

  // ---------------------------------------------------------------------------
  // Selection, keyboard and focus requests

  function indexOfKey(key) {
    return model.findIndex((m) => rowKey(m) === key);
  }

  /** Select row i; `center` for a jump from elsewhere, which centres a row outside the middle of the list. */
  function selectIndex(i, { scroll = true, center = false } = {}) {
    const m = model[i];
    if (!m || !rowKey(m)) return;
    selected = rowKey(m);
    if (scroll) list.scrollToIndex(i, ROW_MARGIN, { center });
    list.refresh();
    publishSelection(m);
  }

  /** Keep the selected row in view after the list's height changes (the inspector opened or was resized). */
  function revealSelected() {
    const i = selected ? indexOfKey(selected) : -1;
    if (i >= 0) list.scrollToIndex(i, ROW_MARGIN);
  }

  /** The selected step or turn in the canonical words (§9): "step 46 · 5 of 6 in turn 6", "turn 6". */
  function publishSelection(m) {
    const turn = m?.type === 'step' ? m.t ?? turnOf(m.s.turnId) : m?.type === 'turn' ? m.t : null;
    const child = turn && turn.sessionId !== current ? ` of ${app.sessionById(turn.sessionId)?.title || shortId(turn.sessionId, 12)}` : '';
    let text = null;
    if (m?.type === 'step') {
      const inTurn = turn ? page.steps.filter((x) => x.turnId === turn.id).sort((a, b) => a.n - b.n) : [];
      const k = inTurn.findIndex((x) => x.id === m.s.id);
      text = turn && k >= 0 ? `step ${formatInt(m.s.n)} · ${k + 1} of ${formatInt(turn.nSteps ?? inTurn.length)} in turn ${turn.n}${child}` : `step ${formatInt(m.s.n)}`;
    } else if (m?.type === 'turn') text = `turn ${m.t.n}${child}`;
    app.setSelectionText('session', text);
  }

  function setTurnOpen(id, open) {
    const t = turnOf(id);
    turnOpen.set(id, open);
    if (open && t && !page.steps.some((s) => s.turnId === id) && t.nSteps > 0 && !foldedSteps.has(id)) return unfold(id);
    renderList();
  }

  /** The event a step row stands for: its first failing call, else its first call. */
  const stepEvent = (s) => (s.calls.find((c) => c.tier === 'failure') ?? s.calls.find((c) => c.tier) ?? s.calls[0])?.eventId ?? null;

  /** Select a step's event; an open inspector follows it. */
  function selectStepEvent(s) {
    const id = stepEvent(s);
    if (!id) return;
    if (inspector.el.hidden) app.selectEvent(id, { reveal: false });
    else inspect(id);
  }

  // ---------------------------------------------------------------------------
  // Calls column: chips that do not fit give way to a "+n" chip that lists them.

  function fitAllCalls() {
    for (const cell of listEl.querySelectorAll('.ss-calls[data-step]')) fitCalls(cell);
  }

  function fitCalls(cell) {
    const chips = [...cell.children].filter((c) => c.classList.contains('call-chip'));
    if (!chips.length) return;
    const right = cell.offsetLeft + cell.clientWidth - 6;
    const fits = (el) => el.offsetLeft + el.offsetWidth <= right;
    if (fits(chips[chips.length - 1])) return;
    const clamp = (el, end) => {
      el.style.maxWidth = `${Math.max(40, end - el.offsetLeft)}px`;
    };
    if (chips.length === 1) return clamp(chips[0], right);
    const more = h('button', { class: 'call-chip call-token call-more', type: 'button', dataset: { moreCalls: cell.dataset.step } });
    cell.append(more);
    let shown = chips.length;
    const show = (n) => {
      shown = n;
      chips.forEach((c, i) => {
        c.hidden = i >= n;
      });
      more.textContent = `+${formatInt(chips.length - n)}`;
    };
    show(chips.length - 1);
    while (shown > 1 && !fits(more)) show(shown - 1);
    // One chip left that is still too wide: it ends in an ellipsis before the "+n".
    if (!fits(more)) clamp(chips[0], right - more.offsetWidth - 4);
    more.setAttribute('aria-label', `${plural(chips.length - shown, 'more call')}: list them`);
  }

  function hiddenCallsMenu(more) {
    const s = model.find((m) => m.type === 'step' && m.s.id === more.dataset.moreCalls)?.s;
    if (!s) return;
    showMenu(more, [{ header: `Step ${formatInt(s.n)}: ${plural(s.calls.length, 'call')}` }, ...s.calls.map((c) => ({
      label: `${c.tool ?? 'call'}${c.target && c.target !== c.tool ? ` ${c.target}` : ''}`,
      hint: c.tier ?? '',
      checked: c.eventId === state.get('selectedEvent'),
      onSelect: () => inspect(c.eventId),
    }))], { minWidth: 280 });
  }

  listEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) return loadMore();
    const unf = e.target.closest('[data-unfold]');
    if (unf) return unfold(unf.dataset.unfold);
    const tog = e.target.closest('[data-toggle]');
    if (tog) return setTurnOpen(tog.dataset.toggle, !(turnOpen.get(tog.dataset.toggle) ?? true));
    const ep = e.target.closest('[data-open-episode], .lane[data-episode]');
    if (ep) return app.openEpisode(ep.dataset.openEpisode ?? ep.dataset.episode);
    const claim = e.target.closest('[data-claim]');
    if (claim) return app.openLens({ kind: 'claim', id: claim.dataset.claim });
    const callEl = e.target.closest('.call-chip[data-event]');
    const row = e.target.closest('[data-vi]');
    const more = e.target.closest('.call-more[data-more-calls]');
    if (row) selectIndex(Number(row.dataset.vi), { scroll: false });
    if (more) return hiddenCallsMenu(more);
    if (callEl) inspect(callEl.dataset.event);
    else if (row && model[Number(row.dataset.vi)]?.type === 'step') selectStepEvent(model[Number(row.dataset.vi)].s);
  });
  listEl.addEventListener('contextmenu', (e) => {
    const callEl = e.target.closest('.call-chip[data-event]');
    if (!callEl) return;
    e.preventDefault();
    app.selectEvent(callEl.dataset.event, { reveal: false });
    callMenu(callEl, { x: e.clientX, y: e.clientY });
  });
  listEl.addEventListener('dblclick', (e) => {
    const callEl = e.target.closest('.call-chip[data-event]');
    if (callEl) app.selectEvent(callEl.dataset.event);
  });

  listEl.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    const keys = model.map((m, i) => (rowKey(m) ? i : -1)).filter((i) => i >= 0);
    if (!keys.length) return;
    let cur = indexOfKey(selected);
    const pos = keys.indexOf(cur);
    const m = model[cur];
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const turns = model.map((x, i) => (x.type === 'turn' ? i : -1)).filter((i) => i >= 0);
      const next = e.key === 'ArrowDown' ? turns.find((i) => i > cur) : [...turns].reverse().find((i) => i < cur);
      if (next != null) selectIndex(next);
      return;
    }
    if (e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const k = pos < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, pos + (e.key === 'ArrowDown' ? 1 : -1)));
      selectIndex(keys[k]);
    } else if (e.key === 'ArrowRight' && m) {
      e.preventDefault();
      if (m.type === 'turn' && !m.open) setTurnOpen(m.t.id, true);
      else if (pos >= 0 && pos < keys.length - 1) selectIndex(keys[pos + 1]);
    } else if (e.key === 'ArrowLeft' && m) {
      e.preventDefault();
      if (m.type === 'turn' && m.open) setTurnOpen(m.t.id, false);
      else if (m.type === 'step' && m.t) selectIndex(indexOfKey(`turn:${m.t.id}`));
    } else if (e.key === 'Enter' && m?.type === 'step') {
      e.preventDefault();
      selectStepEvent(m.s);
    } else if (e.key === 'Enter' && m?.type === 'turn') {
      e.preventDefault();
      setTurnOpen(m.t.id, !m.open);
    }
  });

  /** Whether the page holds the focused step, or the focused turn with its steps folded away. */
  const focusLoaded = (f) => page.steps.some((s) => s.id === f.stepId)
    || (!!f.turnId && !!turnOf(f.turnId) && (!f.stepId || !page.steps.some((s) => s.turnId === f.turnId)));

  /** Show in Session asked for a step or turn: load pages until it appears, open its turn, select it once. */
  async function seekFocus() {
    const f = state.get('sessionFocus');
    if (!f || f.session !== current || status !== 'ready' || focusDone === f || (!f.stepId && !f.turnId)) return;
    focusDone = f;
    for (let n = 0; n < MAX_SEEK_PAGES && !focusLoaded(f) && page.next; n++) if (!(await loadMore())) break;
    const step = page.steps.find((s) => s.id === f.stepId) ?? null;
    const turnId = step?.turnId ?? f.turnId ?? null;
    if (turnId) {
      turnOpen.set(turnId, true);
      // A folded turn's steps are not in the page: fetch them.
      if (f.stepId && !step) await unfold(turnId);
    }
    renderList();
    const i = indexOfKey(f.stepId && indexOfKey(`step:${f.stepId}`) >= 0 ? `step:${f.stepId}` : `turn:${turnId}`);
    if (i < 0) return;
    selectIndex(i, { center: true });
    listEl.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------
  // Sync

  function sync() {
    if (!visible) return;
    const { sid, ids } = resolve();
    const changed = sid !== current;
    current = sid;
    if (changed) {
      page = null;
      report = null;
      bucket = null;
      turnOpen.clear();
      selected = null;
      loadedKey = null;
      app.setSelectionText('session', null);
    }
    renderHeader(sid, ids);
    const mode = state.get('sessionMode');
    showMode(mode);
    if (mode === 'steps') loadSteps();
    else if (changed) mounted[mode]?.instance?.show();
  }

  const syncSoon = debounce(sync, 40);
  state.subscribe(['scope', 'sessionFocus', 'sessionMode', 'filter', 'view', 'viewLoading', 'viewError'], () => syncSoon());
  state.subscribe(['selectedDetail'], () => {
    if (visible && !(state.get('scope').sessions ?? []).length && !state.get('sessionFocus')) syncSoon();
  });
  state.subscribe(['metaVersion'], () => {
    if (visible && current) renderHeader(current, state.get('scope').sessions ?? []);
  });
  state.subscribe(['timeRef'], () => list.refresh());
  // The step that owns the selected event is marked (and its chip), wherever the selection came from.
  state.subscribe(['selectedEvent'], () => {
    if (visible && status === 'ready') list.refresh();
  });
  state.subscribe(['indexVersion'], () => {
    if (!visible || state.get('sessionMode') !== 'steps' || !current || !app.changeAffects([current])) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadSteps(), Math.max(0, lastLoad + LIVE_REFRESH_MS - Date.now()));
  });
  descBox.addEventListener('change', () => {
    state.set({ stepsDescendants: descBox.checked });
    loadSteps();
  });
  // 'steps.sort' saved "Duration", which was wall time; that choice now means active time ('steps.sortBy').
  const oldSort = loadPref('steps.sort', 'seq');
  sortSel.value = loadPref('steps.sortBy', oldSort === 'dur' ? 'active' : oldSort);
  failBox.addEventListener('change', () => {
    savePref('steps.onlyFailed', failBox.checked);
    loadSteps();
  });
  colHead.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu({ x: e.clientX, y: e.clientY }, SORTS.map((s) => ({ label: `Sort by ${s.label}`, checked: sortSel.value === s.id, onSelect: () => setSort(s.id) })));
  });

  return {
    show() {
      visible = true;
      sync();
    },
    hide() {
      visible = false;
      clearTimeout(refreshTimer);
      for (const m of Object.values(mounted)) m.instance?.hide();
    },
    /** The selected step's or turn's start (the time reference key `t`). */
    selectionTs() {
      const m = model[indexOfKey(selected)];
      return m?.type === 'step' ? m.s.startTs : m?.type === 'turn' ? m.t.startTs : null;
    },
  };
}
