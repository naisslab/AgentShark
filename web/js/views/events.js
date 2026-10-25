// Events workspace (SPEC §7.1, §7.3, §7.4, §7.8): timeline strip, virtualized event list,
// detail tree and raw pane, with splitters whose sizes persist. Sorting, coloring and find run
// on the server when it supports them (MAC-CONTRACT §3); otherwise the list falls back.

import { h, clear, isTyping, icon, showMenu, openDialog, makeSplitter, placeholder, copyText, ensureVisible, debounce, setScopeLabel, autoTitle, middleEllipsis, scrollShadows } from '../lib/dom.js';
import { createVirtualList, pagesForRange, clampIndex } from '../lib/virtual.js';
import { loadPref, savePref } from '../state.js';
import {
  formatClock, formatDuration, formatTime, formatTokens, formatInt, formatBytes, formatUsd, formatPercent, stampTitle, tzOffset, plural,
  shortId, lineCount, prettyJson, pointerGet, pointerEscape, pointerSegments, agentLabel, kindColor,
} from '../lib/format.js';
import { EVENT_KINDS, toolKindOf, isTierRule } from '../lib/colors.js';
import { COMBINE_MODES, fieldPredicate, nextSort } from '../lib/scope.js';
import { OUTCOME, TIER, CLAIM, DELEGATION, provMark, provTitle, ruleTitle, refTime, stepNumber, noteText } from '../lib/derived.js';
import { openDiff } from './lens.js';

const PAGE = 200;
const MAX_PAGES = 80;
const RAW_MAX_STRING = 4000;
const TEXT_PREVIEW = 2048;
const MAX_PRETTY_CHARS = 3_000_000;
const MAX_PRETTY_LINES = 20_000;
const AUTO_IMAGE_BYTES = 2_000_000;
/** Rows the browser scans for Find when the server has no find endpoint. */
const LOCAL_FIND_ROWS = 20_000;

/** Summary takes the remaining width but never less than this, nor less than 45% of the table (docs/DESIGN.md §4.4). */
const SUMMARY_MIN = 320;
const SUMMARY_SHARE = 0.45;
/** The 3 px kind bar leads every row (§4.4 Kind bar, §5.2 item 3). */
const GUTTER_W = 3;

/**
 * Columns (§4.4): widths are the compact minimums; Summary flexes to the pane edge. `prio` is the hiding priority:
 * P4 hides first, then P3, the rightmost first within a priority; P1 and P2 never hide. `sort` is the server sort
 * key a header click applies; `adv` marks the Advanced preset.
 */
const COLUMNS = [
  { id: 'no', label: 'No.', width: 56, align: 'right', sort: 'ts', prio: 1 },
  { id: 'time', label: 'Time', width: 104, align: 'right', sort: 'ts', prio: 1 },
  { id: 'delta', label: 'Δ', width: 64, align: 'right', adv: true, prio: 4, title: 'Time since the previous displayed event' },
  { id: 'session', label: 'Session', width: 120, sort: 'session', prio: 3 },
  { id: 'kind', label: 'Kind', width: 104, sort: 'kind', prio: 2 },
  { id: 'proto', label: 'Record type', width: 180, adv: true, prio: 4, title: 'The native record type of the source log (proto)' },
  { id: 'actor', label: 'Actor', width: 72, adv: true, prio: 4 },
  { id: 'tool', label: 'Tool', width: 112, adv: true, sort: 'tool', prio: 4 },
  { id: 'model', label: 'Model', width: 136, adv: true, prio: 4 },
  { id: 'dur', label: 'Duration', width: 64, align: 'right', sort: 'dur', prio: 2, title: 'Duration of the span this event opens or closes' },
  // Wide enough for the widest pair ("89.9k→12.4k"): a number never cuts (§3.5); the column hides (P3) instead.
  { id: 'tok', label: 'Tokens', width: 104, align: 'right', sort: 'tokOut', prio: 3, title: 'Tokens: input → output (sorts by output)' },
  { id: 'tokIn', label: 'Tok In', width: 72, align: 'right', adv: true, sort: 'tokIn', prio: 4, title: 'Input tokens' },
  { id: 'tokOut', label: 'Tok Out', width: 72, align: 'right', adv: true, sort: 'tokOut', prio: 4, title: 'Output tokens' },
  // Derived columns (SPEC §12.7 Events): values come from the rows request as custom columns.
  { id: 'step', label: 'Step', width: 56, align: 'right', adv: true, derived: 'step', prio: 4, title: 'Session-wide step number: one model response with its calls' },
  { id: 'tier', label: 'Tier', width: 64, derived: 'failure.tier', prio: 2, title: 'Failure tier of this event: failure, suspect (an upper bound), benign or deferred' },
  { id: 'sig', label: 'Signature', width: 112, adv: true, derived: 'signature', prio: 4, title: 'Error signature (sigv1) of this failure' },
  { id: 'outcome', label: 'Outcome', width: 116, adv: true, derived: 'episode.outcome', prio: 4, title: 'Outcome of the failure episode this event belongs to' },
  { id: 'summary', label: 'Summary', width: SUMMARY_MIN, flex: true, prio: 1, title: 'What happened, in words' },
];
const DEFAULT_SHOWN = ['no', 'time', 'session', 'kind', 'dur', 'tok', 'tier', 'summary'];
const ADVANCED_SHOWN = COLUMNS.map((c) => c.id);
const SORT_LABEL = { ts: 'time', seq: 'file order', dur: 'duration', tokIn: 'input tokens', tokOut: 'output tokens', kind: 'kind', tool: 'tool', session: 'session' };

/** The detail tree's layer name for a failure row of each tier. */
const TIER_LAYER = { failure: 'Failure', suspect: 'Suspect result', benign: 'Benign exit', deferred: 'Deferred result' };

/** Partner kinds for Ctrl+→. */
const PARTNER = {
  'tool.call': ['tool.result'],
  'tool.result': ['tool.call'],
  'agent.spawn': ['agent.status'],
  'agent.status': ['agent.spawn'],
  'permission.request': ['permission.decision'],
  'permission.decision': ['permission.request'],
  'turn.start': ['turn.end', 'turn.abort'],
  'turn.end': ['turn.start'],
  'turn.abort': ['turn.start'],
};

const DECODED_LABELS = {
  'tool.call': 'Tool call',
  'tool.result': 'Tool result',
  'tool.exec': 'Tool execution',
  'llm.text': 'Model output',
  'llm.thinking': 'Thinking',
  'llm.usage': 'Token usage',
  'llm.error': 'Model API error',
  'llm.refusal': 'Refusal',
  'user.prompt': 'User prompt',
  'user.inject': 'Injected content',
  'agent.spawn': 'Subagent launch',
  'agent.message': 'Agent message',
  'agent.status': 'Subagent status',
  'context.compaction': 'Compaction',
  'hook.run': 'Hook',
};

const ATTR_ORDER = ['text', 'tool', 'llm', 'tokens', 'agent', 'turn', 'hook', 'error', 'permission', 'context', 'file', 'ratelimit', 'cost'];
const MS_FIELDS = new Set(['thinking_ms', 'ttft_ms', 'latency_ms', 'reported_wall_ms', 'retry_in_ms', 'duration_ms']);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IDENT = /^[A-Za-z_][\w]*$/;

/** @param {HTMLElement} root @param {any} app */
export default function createEventsWorkspace(root, app) {
  const { state, api } = app;
  let visible = false;
  let revealOnShow = null; // scroll alignment for the selection, waiting for show() (reveal())
  let locating = false; // the first locate of a new view is in flight (endLocating())
  const rowH = () => (state.get('density') === 'comfortable' ? 26 : 22);

  // ---------------------------------------------------------------------------
  // Layout

  // Workspace header (§7.3): the scope label, then Columns ▾ and how many columns are hidden to fit.
  const scopeLine = h('div', { class: 'ws-scope ev-scope', 'aria-live': 'polite' });
  const colsBtn = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu' }, 'Columns', icon('down', 10));
  const hiddenBtn = h('button', { class: 'tool-btn ev-hidden-cols', type: 'button', hidden: true, 'aria-haspopup': 'menu' });
  // The timeline strip is collapsible from the header (§4.5: 96 tall at ≤900 window height, 160 above).
  const stripHead = h('button', { class: 'tool-btn ev-strip-toggle', type: 'button', 'aria-pressed': 'true' }, 'Timeline');
  const wsHead = h('div', { class: 'ws-head ev-wshead' }, scopeLine, h('div', { class: 'ws-controls' }, hiddenBtn, stripHead, colsBtn));
  const stripBody = h('div', { class: 'ev-strip-body' });
  const strip = h('div', { class: 'ev-strip' }, stripBody);

  const headInner = h('div', { class: 'ev-head-inner', role: 'row' });
  const head = h('div', { class: 'ev-head', 'data-scroll-mirror': '' }, headInner);
  const scroller = h('div', { class: 'ev-scroll', tabindex: '0', role: 'grid', 'aria-label': 'Events', 'aria-rowcount': '0' });
  const notice = h('div', { class: 'ev-notice', hidden: true, role: 'status' });
  const listOverlay = h('div', { class: 'ev-overlay', hidden: true });

  const findInput = h('input', { class: 'ev-find-input', type: 'search', placeholder: 'Find text in this view', spellcheck: 'false', 'aria-label': 'Find text in the event list' });
  const findStatus = h('span', { class: 'ev-find-status', role: 'status' });
  const findBar = h(
    'div',
    { class: 'ev-find', hidden: true, role: 'search' },
    icon('find', 12),
    findInput,
    h('button', { class: 'icon-btn', title: 'Previous match (Shift+Enter)', 'aria-label': 'Previous match', onClick: () => find('prev') }, icon('up', 12)),
    h('button', { class: 'icon-btn', title: 'Next match (Enter)', 'aria-label': 'Next match', onClick: () => find('next') }, icon('down', 12)),
    findStatus,
    h('div', { class: 'spacer' }),
    h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close find', onClick: () => closeFind() }, icon('close', 11)),
  );
  const listPane = h('div', { class: 'ev-list-pane', 'data-f6': '' }, findBar, head, notice, h('div', { class: 'ev-scroll-wrap' }, scroller, listOverlay));

  const detailTitle = h('span', { class: 'pane-sub' });
  const treeBody = scrollShadows(h('div', { class: 'dt-body', tabindex: '0', role: 'tree', 'aria-label': 'Event detail' }));
  const detailPane = h(
    'div',
    { class: 'pane ev-detail-pane', 'data-shows-selection': '', 'data-f6': '' },
    h(
      'div',
      { class: 'pane-head' },
      h('span', { class: 'pane-title' }, 'Detail'),
      detailTitle,
      h('div', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Expand all layers', 'aria-label': 'Expand all layers', onClick: () => setAllLayers(true) }, icon('down', 12)),
      h('button', { class: 'icon-btn', title: 'Collapse all layers', 'aria-label': 'Collapse all layers', onClick: () => setAllLayers(false) }, icon('up', 12)),
      h('button', { class: 'icon-btn', title: 'Copy the decoded event as JSON', 'aria-label': 'Copy event JSON', onClick: copyEventJson }, icon('copy', 12)),
    ),
    treeBody,
  );

  // The file name (§7.11): text with a middle ellipsis and the full path as its tooltip; Copy is the button.
  const rawSource = h('span', { class: 'raw-source' });
  const rawModeBtn = h('div', { class: 'seg small', role: 'group', 'aria-label': 'Raw display' });
  const wrapBtn = h('button', { class: 'tool-btn small', title: 'Wrap long lines', 'aria-pressed': 'false' }, 'Wrap');
  const rawBody = h('div', { class: 'raw-body', tabindex: '0', 'aria-label': 'Raw source' });
  const rawFoot = h('div', { class: 'raw-foot' });
  const rawPane = h(
    'div',
    { class: 'pane ev-raw-pane' },
    h(
      'div',
      { class: 'pane-head' },
      h('span', { class: 'pane-title' }, 'Raw'),
      rawSource,
      h('div', { class: 'spacer' }),
      rawModeBtn,
      wrapBtn,
      h('button', { class: 'icon-btn', title: 'Copy the source line', 'aria-label': 'Copy source line', onClick: copyRawLine }, icon('copy', 12)),
    ),
    rawBody,
    rawFoot,
  );

  const splitY = h('div', { class: 'splitter splitter-y', role: 'separator', 'aria-label': 'Resize the event list' });
  const splitX = h('div', { class: 'splitter splitter-x', role: 'separator', 'aria-label': 'Resize the detail pane' });
  // At narrow widths the two lower panes become one inspector with Detail and Raw tabs (F17).
  // In a short window an open Follow panel becomes a third tab here (placeFollow).
  let inspectorTab = loadPref('events.inspectorTab', 'detail');
  const insTabs = h('div', { class: 'ev-ins-tabs', role: 'tablist', 'aria-label': 'Inspector' });
  const renderInsTabs = () => {
    const tabs = [['detail', 'Detail'], ['raw', 'Raw']];
    insTabs.replaceChildren(...tabs.map(([id, label]) =>
      h('button', {
        class: ['ev-ins-tab', inspectorTab === id && 'on'],
        role: 'tab',
        'aria-selected': String(inspectorTab === id),
        onClick: () => {
          inspectorTab = id;
          savePref('events.inspectorTab', id);
          renderInsTabs();
        },
      }, label)));
    bottom.dataset.tab = inspectorTab;
  };
  const bottom = h('div', { class: 'ev-bottom', 'data-follow-host': '' }, insTabs, detailPane, splitX, rawPane);
  renderInsTabs();
  const updateStacked = () => bottom.classList.toggle('stacked', bottom.clientWidth > 0 && bottom.clientWidth < 760);
  new ResizeObserver(updateStacked).observe(bottom);
  const main = h('div', { class: 'ev-main' }, listPane, splitY, bottom);
  root.append(wsHead, strip, main);

  // Pane sizes are stored as fractions so they survive window resizes.
  let listFrac = loadPref('events.listFrac', 0.52);
  let detailFrac = loadPref('events.detailFrac', 0.5);
  const applySizes = () => {
    root.style.setProperty('--ev-list-h', `${(listFrac * 100).toFixed(2)}%`);
    root.style.setProperty('--ev-detail-w', `${(detailFrac * 100).toFixed(2)}%`);
  };
  applySizes();
  makeSplitter(splitY, {
    axis: 'y',
    onStart: () => listPane.getBoundingClientRect().height,
    onDrag: (px) => {
      const total = main.getBoundingClientRect().height;
      listFrac = Math.max(0.12, Math.min(0.88, px / Math.max(1, total)));
      applySizes();
      return listFrac * total;
    },
    onEnd: () => savePref('events.listFrac', listFrac),
  });
  makeSplitter(splitX, {
    axis: 'x',
    onStart: () => detailPane.getBoundingClientRect().width,
    onDrag: (px) => {
      const total = bottom.getBoundingClientRect().width;
      detailFrac = Math.max(0.15, Math.min(0.85, px / Math.max(1, total)));
      applySizes();
      return detailFrac * total;
    },
    onEnd: () => savePref('events.detailFrac', detailFrac),
  });

  // ---------------------------------------------------------------------------
  // Timeline strip host. The strip comes from another module; the shell must work without it.

  let timelineStrip = null;
  let stripCollapsed = loadPref('events.stripCollapsed', false);
  const refreshStrip = () => {
    try {
      timelineStrip?.refresh();
    } catch (err) {
      console.error('timeline strip refresh failed', err);
    }
  };
  const renderStripState = () => {
    stripHead.setAttribute('aria-pressed', String(!stripCollapsed));
    strip.hidden = stripCollapsed;
  };
  stripHead.addEventListener('click', () => {
    stripCollapsed = !stripCollapsed;
    savePref('events.stripCollapsed', stripCollapsed);
    renderStripState();
    if (!stripCollapsed) refreshStrip();
  });
  renderStripState();
  stripBody.append(placeholder('loading', 'Loading timeline…'));
  import('./timeline.js')
    .then((mod) => {
      timelineStrip = mod.createTimelineStrip(app);
      clear(stripBody).append(timelineStrip.el);
      if (visible && !stripCollapsed) refreshStrip();
    })
    .catch((err) => {
      console.error('timeline strip unavailable', err);
      clear(stripBody).append(placeholder('error', 'Timeline strip unavailable', err?.message ?? String(err)));
    });

  // ---------------------------------------------------------------------------
  // Columns: a default preset, an Advanced preset and custom columns (Apply as Column).

  let colPrefs = loadPref('events.columns2', null) ?? { shown: DEFAULT_SHOWN, widths: {}, custom: [], tierShown: true };
  colPrefs.custom ??= [];
  colPrefs.widths ??= {};
  colPrefs.shown ??= DEFAULT_SHOWN;
  const saveCols = () => savePref('events.columns2', colPrefs);
  // Column sets saved before the failure tiers existed gain the Tier column once.
  if (!colPrefs.tierShown) {
    colPrefs.tierShown = true;
    if (!colPrefs.shown.includes('tier')) colPrefs.shown = [...colPrefs.shown, 'tier'];
    saveCols();
  }

  /** Every column in display order: built-in ones, then custom fields, then Summary. */
  function allColumns() {
    const custom = colPrefs.custom.map((field, i) => ({ id: `x${i}`, label: field, width: 120, custom: field, title: `Custom column: ${field}` }));
    return [...COLUMNS.slice(0, -1), ...custom, COLUMNS[COLUMNS.length - 1]];
  }
  /** Columns hidden for now because the list is too narrow for them and a readable Summary. */
  let autoHidden = new Set();
  /** Hiding order (§4.4): P4, then P3, the rightmost first within a priority; P1 and P2 never hide. */
  const shedOrder = () => {
    const cols = chosenColumns();
    return [4, 3].flatMap((p) => cols.filter((c) => (c.custom ? 4 : c.prio) === p).reverse().map((c) => c.id));
  };
  const chosenColumns = () => allColumns().filter((c) => c.custom || c.flex || colPrefs.shown.includes(c.id));
  const shownColumns = () => chosenColumns().filter((c) => !autoHidden.has(c.id));
  /** Fields the rows request computes: custom columns, plus the derived columns shown (schema-4 servers only). */
  const customFields = () => {
    const derived = app.features.derived ? shownColumns().filter((c) => c.derived).map((c) => c.derived) : [];
    return [...new Set([...colPrefs.custom, ...derived])];
  };

  let noWidth = 56;
  const scaleW = () => (state.get('density') === 'comfortable' ? 1.08 : 1);
  /** Time grows to fit the short date prefix when the view spans more than one day (§4.4: 104–168). */
  const timeWidth = () => (view?.firstTs != null && view?.lastTs != null && formatClock(view.firstTs).slice(0, 10) !== formatClock(view.lastTs).slice(0, 10) ? 150 : 104);
  const colWidth = (c) => colPrefs.widths[c.id] ?? (c.id === 'no' ? noWidth : c.id === 'time' ? Math.round(timeWidth() * scaleW()) : Math.round(c.width * scaleW()));

  /** The No. column fits the largest row number of the view. */
  function fitNoWidth() {
    const digits = formatInt(Math.max(1, view?.count ?? 1)).length;
    const charW = state.get('density') === 'comfortable' ? 7.9 : 7.3;
    const w = Math.max(56, Math.ceil(digits * charW + 16));
    if (w === noWidth) return false;
    noWidth = w;
    return true;
  }

  /**
   * Fit the chosen columns to the list width (§4.4): hide P4, then P3 columns while Summary would be narrower than its
   * minimum or than 45% of the table. Not saved as a preference; the header says how many columns are hidden.
   */
  function fitColumns(width) {
    if (!width) return false;
    let fixed = GUTTER_W;
    for (const c of chosenColumns()) if (!c.flex) fixed += colWidth(c);
    const tooNarrow = () => width - fixed < Math.max(SUMMARY_MIN, SUMMARY_SHARE * width);
    const next = new Set();
    for (const id of shedOrder()) {
      if (!tooNarrow()) break;
      const c = chosenColumns().find((x) => x.id === id);
      if (!c) continue;
      next.add(id);
      fixed -= colWidth(c);
    }
    const changed = next.size !== autoHidden.size || [...next].some((id) => !autoHidden.has(id));
    autoHidden = next;
    hiddenBtn.hidden = !next.size;
    hiddenBtn.textContent = `${plural(next.size, 'column')} hidden`;
    return changed;
  }

  function applyColumnWidths() {
    let total = GUTTER_W;
    for (const c of shownColumns()) {
      if (c.flex) continue;
      root.style.setProperty(`--w-${c.id}`, `${colWidth(c)}px`);
      total += colWidth(c);
    }
    root.style.setProperty('--w-summary-min', `${SUMMARY_MIN}px`);
    root.style.setProperty('--ev-cols-w', `${total + SUMMARY_MIN}px`);
  }

  function headerLabel(c) {
    if (c.id !== 'time') return c.label;
    if (state.get('timeRef') != null) return 'Time from Ref';
    const tf = state.get('timeFormat');
    if (tf === 'local') return `Times ${tzOffset(view?.lastTs ?? undefined)}`;
    if (tf === 'utc') return 'Time UTC';
    return { 'rel-first': 'Time since first', 'delta-prev': 'Time Δ', 'rel-session': 'Since session' }[tf] ?? 'Time';
  }

  function headerTitle(c, active, sort) {
    const bits = [c.title ?? c.label];
    if (c.id === 'time') bits[0] = state.get('timeFormat') === 'local' ? `Local time, UTC${tzOffset()}; the date shows where it changes. Hover a cell for the full timestamp.` : 'Time';
    if (c.id === 'no') bits[0] = 'Row number in the current view';
    if (c.sort) {
      if (active) bits.push(`Sorted by ${SORT_LABEL[sort.key]}, ${sort.order === 'asc' ? (sort.key === 'ts' ? 'oldest first' : 'ascending') : sort.key === 'ts' ? 'newest first' : 'descending'}; click to flip`);
      else bits.push(`Click to sort by ${SORT_LABEL[c.sort]}`);
    }
    return bits.join('\n');
  }

  function renderHeader() {
    clear(headInner);
    headInner.append(h('span', { class: 'ev-gutter', role: 'columnheader', 'aria-label': 'Kind' }));
    const sort = state.get('sort') ?? { key: 'ts', order: 'asc' };
    let indicated = false;
    for (const c of shownColumns()) {
      const active = !!c.sort && c.sort === sort.key && !indicated;
      if (active) indicated = true;
      const handle = h('span', { class: 'col-resize', 'aria-hidden': 'true' });
      makeSplitter(handle, {
        axis: 'x',
        keyboard: false,
        onStart: () => (c.flex ? SUMMARY_MIN : colWidth(c)),
        onDrag: (w) => {
          if (c.flex) return SUMMARY_MIN;
          const v = Math.max(32, Math.min(1600, Math.round(w)));
          colPrefs.widths = { ...colPrefs.widths, [c.id]: v };
          applyColumnWidths();
          return v;
        },
        onEnd: saveCols,
      });
      const cell = h(
        'span',
        {
          class: ['ev-hcell', `c-${c.id}`, c.custom && 'c-custom', c.align === 'right' && 'right', c.sort && 'sortable', active && 'sorted'],
          role: 'columnheader',
          tabindex: c.sort ? '0' : null,
          'aria-sort': active ? (sort.order === 'asc' ? 'ascending' : 'descending') : null,
          title: headerTitle(c, active, sort),
          style: c.custom ? { flex: `0 0 var(--w-${c.id})` } : null,
        },
        h('span', { class: 'ev-hlabel' }, headerLabel(c)),
        active ? h('span', { class: 'ev-sort', 'aria-hidden': 'true' }, sort.order === 'asc' ? '▴' : '▾') : null,
        c.flex ? null : handle,
      );
      if (c.sort) {
        const go = () => app.setSort(nextSort(sort.key === c.sort ? sort : null, c.sort));
        cell.addEventListener('click', (e) => {
          if (!e.target.closest('.col-resize')) go();
        });
        cell.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            go();
          }
        });
      }
      headInner.append(cell);
    }
  }

  function setShown(ids) {
    const before = customFields().join('\n');
    colPrefs.shown = [...ids];
    saveCols();
    rebuildColumns();
    // A derived column needs its values in the rows: fetch the pages again.
    if (customFields().join('\n') !== before) {
      pages.clear();
      stalePages.clear();
      ensureVisiblePages();
    }
  }

  function addColumn(field) {
    if (!field || colPrefs.custom.includes(field)) return;
    colPrefs.custom = [...colPrefs.custom, field];
    saveCols();
    pages.clear();
    stalePages.clear();
    rebuildColumns();
    ensureVisiblePages();
    if (app.features.columns === false) app.toast('This AgentShark server does not compute custom columns yet; the column stays empty until it is updated.', 'warn');
  }

  function removeColumn(field) {
    colPrefs.custom = colPrefs.custom.filter((f) => f !== field);
    saveCols();
    rebuildColumns();
  }

  function addColumnDialog() {
    const input = h('input', { class: 'text-input mono', type: 'text', placeholder: 'e.g. tool.exit_code or native.message.usage.service_tier', list: 'ev-field-list', 'aria-label': 'Field name' });
    const datalist = h('datalist', { id: 'ev-field-list' });
    api.fields().then((fields) => datalist.append(...(fields ?? []).map((f) => h('option', { value: f.name }, f.description ?? '')))).catch(() => {});
    const dlg = openDialog({
      title: 'Add a column',
      body: [input, datalist, h('p', { class: 'dialog-note' }, 'Any filter field, a native.* path or an attribute path. The server computes the values.')],
      actions: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => addColumn(input.value.trim()) }],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dlg.el.querySelector('.btn.primary')?.click();
    });
    input.focus();
  }

  function columnsMenu(at) {
    const shown = new Set(colPrefs.shown);
    const isDefault = DEFAULT_SHOWN.every((id) => shown.has(id)) && shown.size === DEFAULT_SHOWN.length;
    const isAdvanced = ADVANCED_SHOWN.every((id) => shown.has(id));
    showMenu(at, [
      { header: 'Presets' },
      { label: 'Default', hint: 'No., Time, Session, Kind, Duration, Tokens, Tier, Summary', checked: isDefault, onSelect: () => setShown(DEFAULT_SHOWN) },
      { label: 'Advanced', hint: '+ Δ, Record type, Actor, Tool, Model, Tok In, Tok Out, Step, Signature, Outcome', checked: isAdvanced, onSelect: () => setShown(ADVANCED_SHOWN) },
      { header: 'Columns' },
      ...COLUMNS.filter((c) => !c.flex).map((c) => ({
        label: c.id === 'delta' ? 'Δ (time since previous)' : c.label,
        checked: shown.has(c.id),
        onSelect: () => setShown(shown.has(c.id) ? colPrefs.shown.filter((x) => x !== c.id) : [...colPrefs.shown, c.id]),
      })),
      { label: 'Summary', checked: true, disabled: true },
      ...(colPrefs.custom.length ? [{ header: 'Custom columns' }, ...colPrefs.custom.map((f) => ({ label: f, hint: 'remove', onSelect: () => removeColumn(f) }))] : []),
      ...(autoHidden.size ? [{ label: `Hidden to fit: ${[...autoHidden].map((id) => COLUMNS.find((c) => c.id === id)?.label ?? id).join(', ')}`, disabled: true }] : []),
      { separator: true },
      { label: 'Add a column…', onSelect: addColumnDialog },
      {
        label: 'Reset columns',
        onSelect: () => {
          colPrefs = { shown: DEFAULT_SHOWN, widths: {}, custom: [], tierShown: true };
          saveCols();
          rebuildColumns();
        },
      },
    ], { align: 'end', minWidth: 260 });
  }
  colsBtn.addEventListener('click', () => columnsMenu(colsBtn));
  hiddenBtn.addEventListener('click', () => columnsMenu(hiddenBtn));
  new ResizeObserver(() => {
    if (fitColumns(listPane.clientWidth)) rebuildColumns();
  }).observe(listPane);
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    columnsMenu({ x: e.clientX, y: e.clientY });
  });

  // ---------------------------------------------------------------------------
  // Event list data

  let view = null;
  const pages = new Map(); // page number → EventRow[] (insertion order = LRU)
  const stalePages = new Map(); // rows of the previous view, shown until a refresh replaces them
  const inflight = new Map(); // page number → Promise
  const failedPages = new Map(); // page number → Error
  let selIndex = -1;
  let selId = state.get('selectedEvent');
  const backStack = [];
  let navigatingBack = false;
  const marks = new Set(loadPref('events.marks', []));
  state.set({ markCount: marks.size });

  function rowAt(i) {
    if (i < 0) return null;
    const p = Math.floor(i / PAGE);
    return pages.get(p)?.[i % PAGE] ?? stalePages.get(p)?.[i % PAGE] ?? null;
  }
  const isFresh = (i) => !!pages.get(Math.floor(i / PAGE))?.[i % PAGE];

  /** Feature detection from the first rows a current server returns. */
  function detectFeatures(rows, v, cols) {
    if (!rows.length) return;
    if (v.spec?.colorRules?.length && app.features.colorRules == null) {
      app.features.colorRules = 'colorRule' in rows[0];
    }
    if (colPrefs.custom.length && cols.length && app.features.columns == null) {
      app.features.columns = 'extra' in rows[0];
      if (!app.features.columns) app.toast('This AgentShark server does not compute custom columns yet; they stay empty until it is updated.', 'warn');
    }
  }

  function ensurePages(start, end) {
    if (!view) return;
    const v = view;
    const cols = customFields();
    for (const p of pagesForRange(Math.max(0, start - 20), Math.min(v.count, end + 20), PAGE)) {
      if (pages.has(p)) {
        const rows = pages.get(p);
        pages.delete(p);
        pages.set(p, rows);
        continue;
      }
      if (inflight.has(p) || failedPages.has(p)) continue;
      const req = api
        .viewRows(v.viewId, p * PAGE, PAGE, cols.length ? cols : undefined)
        .then((res) => {
          if (v !== view) return;
          const rows = res?.rows ?? [];
          detectFeatures(rows, v, cols);
          pages.set(p, rows);
          stalePages.delete(p);
          while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value);
          list.refresh();
          if (pendingCommit != null && Math.floor(pendingCommit / PAGE) === p) commitIndex(pendingCommit);
          if (!failedPages.size && notice.dataset.kind === 'page') hideNotice();
        })
        .catch((err) => {
          if (v !== view || app.handleViewError(err)) return;
          failedPages.set(p, err);
          showNotice(`Could not load rows ${formatInt(p * PAGE + 1)}–${formatInt(Math.min(v.count, (p + 1) * PAGE))}: ${err.message}`, 'page', [
            {
              label: 'Retry',
              onClick: () => {
                failedPages.clear();
                hideNotice();
                ensureVisiblePages();
              },
            },
          ]);
        })
        .finally(() => inflight.delete(p));
      inflight.set(p, req);
    }
  }

  let lastRange = { start: 0, end: 0 };
  const ensureVisiblePages = () => ensurePages(lastRange.start, lastRange.end);

  // ---------------------------------------------------------------------------
  // Row rendering: a leading color bar and a light wash for the coloring rule, text color for
  // rules that set one, and one flag glyph in the gutter. Color is never the only cue.

  function createRow() {
    const el = h('div', { class: 'ev-row', role: 'row' });
    const gutter = h('span', { class: 'ev-gutter', role: 'gridcell', 'aria-hidden': 'true' }, h('span', { class: 'ev-bar' }));
    const cells = { gutter };
    el.append(gutter);
    for (const c of shownColumns()) {
      cells[c.id] = h('span', {
        class: ['ev-cell', `c-${c.id}`, c.custom && 'c-custom', c.align === 'right' && 'right'],
        role: 'gridcell',
        style: c.custom ? { flex: `0 0 var(--w-${c.id})` } : null,
      });
      el.append(cells[c.id]);
    }
    el._cells = cells;
    el._cols = shownColumns();
    return el;
  }

  function setText(el, text, title) {
    if (el.textContent !== text) el.textContent = text;
    if (title !== undefined && el.title !== title) el.title = title;
  }

  /** The Session column within a one-session scope names the subagent, not the repeated root title. */
  function sessionLabel(r) {
    const s = app.sessionById(r.session);
    const scoped = state.get('scope').sessions;
    const title = s?.title || (s?.role && s.role !== 'main' ? s?.nativeId?.split('/').pop() : null) || shortId(r.session);
    if (scoped?.length === 1) {
      if (r.session === scoped[0]) return { text: s?.role && s.role !== 'main' ? 'this subagent' : 'main', muted: true };
      return { text: `↳ ${title}`, muted: false };
    }
    return { text: title, muted: false };
  }

  const dash = (cell, why) => {
    setText(cell, '—', why);
    cell.classList.add('missing');
  };

  function renderRow(el, i) {
    const r = rowAt(i);
    const cells = el._cells;
    el.dataset.i = String(i);
    el.classList.toggle('selected', i === selIndex);
    el.setAttribute('aria-selected', String(i === selIndex));
    el.setAttribute('aria-rowindex', String(i + 1));
    if (!r) {
      el.classList.add('pending');
      el.classList.remove('tinted', 'fg', 'marked', 'is-error', 'stale');
      for (const [id, cell] of Object.entries(cells)) {
        if (id === 'no') setText(cell, formatInt(i + 1));
        else if (id !== 'gutter') setText(cell, '', '');
        cell.classList?.remove('missing');
      }
      return;
    }
    el.classList.remove('pending');
    el.classList.toggle('stale', !isFresh(i));
    const rule = app.colors.ruleFor(r);
    const bar = rule?.bg ?? rule?.fg ?? null;
    const fg = rule?.fg && !isTierRule(rule) ? rule.fg : null;
    el.classList.toggle('tinted', !!rule?.bg);
    el.classList.toggle('fg', !!fg);
    el.classList.toggle('barred', !!bar);
    if (bar) el.style.setProperty('--row-tint', bar);
    if (fg) el.style.setProperty('--row-fg', fg);
    el.classList.toggle('outlined', !!rule?.outline);
    if (rule?.outline) {
      el.style.setProperty('--row-outline', rule.outline);
      el.dataset.outline = rule.outlineStyle ?? 'solid';
    }
    el.classList.toggle('marked', marks.has(r.id));
    const flags = r.flags ?? [];
    el.classList.toggle('is-error', flags.includes('error'));
    el.classList.toggle('dim', flags.includes('inherited') || flags.includes('dup'));
    // The leading bar carries the kind color, or the coloring rule's when one applies (§5.2 items 1 and 3).
    el.style.setProperty('--kind', kindColor(r.kind));
    cells.no.title = marks.has(r.id) ? 'Marked (m)' : '';

    const prev = rowAt(i - 1);
    const sorted = (state.get('sort')?.key ?? 'ts') !== 'ts';
    for (const [id, cell] of Object.entries(cells)) {
      if (id !== 'gutter') cell.classList.remove('missing');
      switch (id) {
        case 'gutter':
          break;
        case 'no':
          setText(cell, formatInt(r.no ?? i + 1));
          break;
        case 'time':
          if (state.get('timeRef') != null) {
            setText(cell, refTime(r.ts, state.get('timeRef')), `${stampTitle(r.ts)}\nfrom the time reference (t clears it)`);
            cell.classList.toggle('faint', r.tsSrc !== 'logged');
            break;
          }
          setText(
            cell,
            formatTime(r.ts, state.get('timeFormat'), {
              first: view?.firstTs,
              prev: sorted || i === topIdx ? undefined : prev?.ts,
              sessionStart: app.sessionById(r.session)?.start,
              compact: true,
            }),
            `${stampTitle(r.ts)}${r.tsSrc !== 'logged' ? `\nTimestamp ${r.tsSrc}` : ''}`,
          );
          cell.classList.toggle('faint', r.tsSrc !== 'logged');
          break;
        case 'delta': {
          const d = prev ? r.ts - prev.ts : null;
          setText(cell, d == null ? '' : d === 0 ? '0' : formatDuration(d), d != null && d < 0 ? 'Timestamp earlier than the previous event (out of order in the source)' : '');
          cell.classList.toggle('neg', d != null && d < 0);
          break;
        }
        case 'session': {
          const { text, muted } = sessionLabel(r);
          setText(cell, text, text);
          cell.classList.toggle('muted-cell', muted);
          break;
        }
        case 'kind':
          // Kind values are filter vocabulary (§3.2); the kind color is the row's leading bar, never the text.
          setText(cell, r.kind, r.kind);
          break;
        case 'proto':
          setText(cell, r.proto, r.proto);
          break;
        case 'actor':
          setText(cell, r.actor);
          break;
        case 'tool':
          if (r.toolName) setText(cell, r.toolName, r.toolName);
          else setText(cell, '', '');
          break;
        case 'model':
          setText(cell, r.model ?? '', r.model ?? '');
          break;
        case 'dur':
          if (r.dur != null) setText(cell, r.dur === 0 ? '0' : formatDuration(r.dur), r.dur === 0 ? '0' : formatDuration(r.dur));
          else dash(cell, 'No duration: this event does not open or close a span with a known duration');
          break;
        case 'tok':
          if (r.tokIn != null || r.tokOut != null) {
            setText(cell, `${r.tokIn != null ? formatTokens(r.tokIn) : '—'}→${r.tokOut != null ? formatTokens(r.tokOut) : '—'}`, `${formatInt(r.tokIn) || 'unknown'} in · ${formatInt(r.tokOut) || 'unknown'} out`);
          } else dash(cell, 'No token count was logged for this event');
          break;
        case 'tokIn':
          if (r.tokIn != null) setText(cell, formatTokens(r.tokIn), formatInt(r.tokIn));
          else dash(cell, 'Not logged');
          break;
        case 'tokOut':
          if (r.tokOut != null) setText(cell, formatTokens(r.tokOut), formatInt(r.tokOut));
          else dash(cell, 'Not logged');
          break;
        case 'summary':
          setText(cell, r.summary ?? '', r.summary ?? '');
          break;
        case 'step':
        case 'tier':
        case 'sig':
        case 'outcome':
          derivedCell(cell, id, r);
          break;
        default: {
          const col = el._cols.find((c) => c.id === id);
          if (!col?.custom) break;
          const v = r.extra?.[col.custom];
          if (v === undefined || v === null) dash(cell, r.extra ? `${col.custom} is not set on this event` : 'This server does not compute custom columns');
          else {
            const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
            setText(cell, text, text);
          }
        }
      }
    }
  }

  /** A derived column cell: a word with a glyph or mark, never color alone; '—' says why it is empty. */
  function derivedCell(cell, id, r) {
    for (const c of [...cell.classList]) if (c.startsWith('tier-') || c.startsWith('tone-')) cell.classList.remove(c);
    if (!app.features.derived) return dash(cell, 'This server does not build the failure analysis (schema 4)');
    const field = COLUMNS.find((c) => c.id === id).derived;
    const v = r.extra?.[field];
    if (!r.extra || !(field in r.extra)) return setText(cell, '', 'Loading…');
    if (v == null || v === '') {
      setText(cell, '', id === 'tier' ? 'No failure signal on this event' : id === 'step' ? 'Not part of a step' : 'Not part of a failure episode');
      return;
    }
    if (id === 'step') return setText(cell, String(stepNumber(String(v)) ?? v), String(v));
    if (id === 'sig') return setText(cell, String(v), `Signature ${v}`);
    // The Tier column (§6.2): failure as a Plain word in --err; the other tiers as Outline badges.
    if (id === 'tier') {
      if (v === 'failure') {
        cell.classList.add('tone-bad');
        return setText(cell, 'failure', 'failure');
      }
      cell.title = v === 'suspect' ? 'A text rule fired on an unflagged result; counts are upper bounds' : '';
      return clear(cell).append(h('span', { class: ['b-outline', `tone-${v}`] }, TIER[v]?.word ?? v));
    }
    const o = OUTCOME[v];
    cell.classList.add(`tone-${o?.tone ?? 'muted'}`);
    setText(cell, o ? o.word : String(v), o ? o.word : String(v));
  }

  let list = null;
  let topIdx = 0;
  /** The top visible row always shows its date, so the reader knows which day it is. */
  function syncTop() {
    const t = list?.topIndex() ?? 0;
    if (t === topIdx) return;
    const old = topIdx;
    topIdx = t;
    list.refreshIndex(old);
    list.refreshIndex(t);
  }
  new ResizeObserver(() => requestAnimationFrame(syncTop)).observe(scroller);
  function buildList() {
    list?.destroy();
    list = createVirtualList(scroller, {
      rowHeight: rowH(),
      createRow,
      renderRow,
      onScroll: () => {
        headInner.style.transform = `translateX(${-scroller.scrollLeft}px)`;
        syncTop();
      },
      onRange: (start, end) => {
        lastRange = { start, end };
        // Hidden, the list has no viewport and its range is meaningless; show() fetches what is in view.
        if (visible && !locating) scheduleFetch(start, end);
      },
    });
    list.setCount(view?.count ?? 0);
  }
  let fetchTimer = 0;
  function scheduleFetch(start, end) {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => ensurePages(start, end), 40);
  }
  function rebuildColumns() {
    fitNoWidth();
    fitColumns(listPane.clientWidth);
    applyColumnWidths();
    renderHeader();
    const top = scroller.scrollTop;
    buildList();
    scroller.scrollTop = top;
    list.refresh();
  }
  rebuildColumns();

  // ---------------------------------------------------------------------------
  // Selection

  let pendingCommit = null;

  function select(i, align = 'auto') {
    if (!view) return;
    i = clampIndex(i, view.count);
    if (i < 0) return;
    setSelIndex(i);
    list.scrollToIndex(i, align);
    commitIndex(i);
  }

  function setSelIndex(i) {
    const old = selIndex;
    selIndex = i;
    list.refreshIndex(old);
    if (i >= 0) list.refreshIndex(i);
    state.set({ selectedNo: i >= 0 ? i + 1 : null });
  }

  /** Publish the selection once the row's data has arrived. */
  function commitIndex(i) {
    const r = isFresh(i) ? rowAt(i) : null;
    if (!r) {
      pendingCommit = i;
      ensurePages(i, i + 1);
      return;
    }
    pendingCommit = null;
    if (i !== selIndex) return;
    setSelectedId(r.id);
  }

  function setSelectedId(id) {
    if (id === selId) return;
    if (selId && !navigatingBack) {
      backStack.push(selId);
      if (backStack.length > 200) backStack.shift();
    }
    selId = id;
    hideNotice();
    state.set({ selectedEvent: id });
  }

  function clearSelection() {
    hideNotice();
    setSelIndex(-1);
    if (selId) {
      selId = null;
      state.set({ selectedEvent: null });
    }
  }

  /**
   * Find the selected event in the current view and move the highlight there.
   * clearIfMissing: the scope changed, so an event outside it no longer belongs to the investigation.
   * quiet: a live refresh; a vanished event just loses its highlight.
   */
  async function locateSelected(align, { clearIfMissing = false, quiet = false } = {}) {
    const v = view;
    const id = selId;
    if (!v || !id) return;
    const known = isFresh(selIndex) ? rowAt(selIndex) : null;
    if (known?.id === id) {
      hideNotice();
      if (align) reveal(align);
      endLocating();
      return;
    }
    try {
      const res = await api.locate(v.viewId, id);
      if (v !== view || id !== selId) return;
      if (res?.no == null) {
        endLocating();
        setSelIndex(-1);
        if (clearIfMissing) {
          clearSelection();
          followEnd();
        } else if (!quiet) {
          showNotice('The selected event is not in the current view. The detail below still shows it.', 'selection');
        }
        return;
      }
      hideNotice();
      setSelIndex(res.no - 1);
      if (align) reveal(align);
      // After the scroll, so the rows fetched are the ones around the selection.
      endLocating();
    } catch (err) {
      endLocating();
      if (!app.handleViewError(err)) console.error('locate failed', err);
    }
  }

  /**
   * Scroll the selection into view. A hidden list cannot scroll (it has no box), so the scroll waits for
   * show() and the rows around the selection load now, ready for the switch (W2: Show in Events).
   */
  function reveal(align) {
    if (!visible) {
      revealOnShow = align;
      ensurePages(selIndex, selIndex + 1);
      return;
    }
    list.scrollToIndex(selIndex, align);
  }

  /**
   * A new view with a selected event opens at that event: until the first locate answers, the rows at the
   * top are neither fetched nor drawn, so no skeleton rows flash at the wrong place.
   */
  function endLocating() {
    if (!locating) return;
    locating = false;
    scroller.classList.remove('locating');
    if (visible) ensureVisiblePages();
  }

  /**
   * The notice above the list. Its actions never widen the investigation: only the selection,
   * the filter or the time range can be cleared here (never "all sessions").
   */
  function showNotice(message, kind = 'info', actions = null) {
    clear(notice).append(icon('warning', 13), h('span', null, message));
    notice.dataset.kind = kind;
    const acts = actions ?? [
      { label: 'Clear selection', onClick: clearSelection },
      state.get('filter') ? { label: 'Clear filter', onClick: () => app.setFilter('') } : null,
      state.get('scope').from != null || state.get('scope').to != null ? { label: 'Clear time range', onClick: () => app.setTimeRange(null, null) } : null,
    ];
    for (const a of acts.filter(Boolean)) notice.append(h('button', { class: 'link-btn', onClick: a.onClick }, a.label));
    notice.append(h('button', { class: 'icon-btn', 'aria-label': 'Dismiss', onClick: hideNotice }, icon('close', 11)));
    notice.hidden = false;
  }
  function hideNotice() {
    notice.hidden = true;
    delete notice.dataset.kind;
  }

  /** While a new view loads, rows belong to the previous scope: clicks on them are ignored. */
  const loadingQuery = () => state.get('viewLoading') && state.get('viewPending') !== 'refresh';

  scroller.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    if (loadingQuery()) return;
    const row = e.target.closest('.ev-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (i !== selIndex) select(i, null);
  });
  scroller.addEventListener('dblclick', (e) => {
    if (!loadingQuery() && e.target.closest('.ev-row')) focusTree();
  });

  /** Menu items for one predicate: click narrows (AND); the submenu offers every combine mode. */
  function filterItem(label, expr, hint) {
    if (!expr) return null;
    return {
      label,
      hint: hint ?? expr,
      title: `Narrow the filter with ${expr}`,
      onSelect: () => app.narrowFilter(expr, 'and'),
      items: [
        { header: 'Apply as filter' },
        ...COMBINE_MODES.map((m) => ({ label: m.label, hint: m.hint, onSelect: () => app.narrowFilter(expr, m.id) })),
        { header: 'Prepare as filter' },
        ...COMBINE_MODES.map((m) => ({ label: m.label, onSelect: () => app.prepareFilter(expr, m.id) })),
      ],
    };
  }

  /** The row menu from the keyboard (ContextMenu key or Shift+F10), anchored to the selected row. */
  function rowMenuFromKeyboard() {
    const el = scroller.querySelector('.ev-row.selected:not([hidden])');
    if (!el) return;
    const b = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 120, clientY: b.bottom }));
  }

  scroller.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.ev-row');
    const r = row && !loadingQuery() && rowAt(Number(row.dataset.i));
    if (!r) return;
    e.preventDefault();
    const q = (v) => JSON.stringify(v);
    const items = [
      { header: state.get('filter') ? 'Filter on (narrows the current filter)' : 'Filter on' },
      filterItem('This kind', `kind == ${q(r.kind)}`),
      filterItem('This record type', `proto == ${q(r.proto)}`),
      r.toolName ? filterItem('This tool', `tool.name == ${q(r.toolName)}`) : null,
      r.model ? filterItem('This model', `model == ${q(r.model)}`) : null,
      filterItem('This session', `session == ${q(r.session)}`),
      r.turn ? filterItem('This turn', `turn == ${q(r.turn)}`, 'turn == …') : null,
      { separator: true },
      { label: 'Open this session', hint: 'replaces the session scope', onSelect: () => app.openSession(r.session) },
      { label: 'Show in Conversation', onSelect: () => app.openSession(r.session, { workspace: 'conversation' }) },
      { label: 'Show in Timeline', onSelect: () => app.switchWorkspace('timeline') },
      { separator: true },
      { label: marks.has(r.id) ? 'Unmark' : 'Mark', hint: 'Ctrl+M', onSelect: () => toggleMark(r.id) },
      { label: 'Copy event id', onSelect: () => copyText(r.id) },
      { label: 'Copy timestamp', hint: formatClock(r.ts, { offset: true }), onSelect: () => copyText(formatClock(r.ts, { digits: 6, offset: true })) },
      { label: 'Copy summary', onSelect: () => copyText(r.summary ?? '') },
    ].filter(Boolean);
    showMenu({ x: e.clientX, y: e.clientY }, items);
  });

  // ---------------------------------------------------------------------------
  // Find (Ctrl/Cmd+F): jumps between matches without filtering.

  let findSeq = 0;

  function openFind() {
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
  }
  function closeFind() {
    findBar.hidden = true;
    findStatus.textContent = '';
    findInput.classList.remove('no-match');
    scroller.focus({ preventScroll: true });
  }

  async function find(dir) {
    const q = findInput.value.trim();
    if (!q || !view) return;
    const v = view;
    const seq = ++findSeq;
    findInput.classList.remove('no-match');
    findStatus.textContent = 'Searching…';
    const start = selIndex >= 0 ? selIndex + 1 : dir === 'next' ? 0 : v.count + 1;
    let no = null;
    let wrapped = false;
    let limited = false;
    try {
      ({ no, limited } = await findFrom(v, q, start, dir));
      if (no == null && !limited) {
        ({ no, limited } = await findFrom(v, q, dir === 'next' ? 0 : v.count + 1, dir));
        wrapped = no != null;
      }
    } catch (err) {
      if (seq === findSeq) findStatus.textContent = app.handleViewError(err) ? 'The view was rebuilt; try again.' : err.message;
      return;
    }
    if (seq !== findSeq || v !== view) return;
    if (no == null) {
      findInput.classList.add('no-match');
      findStatus.textContent = limited ? `No match in the next ${formatInt(LOCAL_FIND_ROWS)} rows (this server cannot search the whole view)` : 'No match in this view';
      return;
    }
    select(no - 1, 'center');
    findStatus.textContent = `No. ${formatInt(no)}${wrapped ? ' · wrapped around' : ''}`;
  }

  /** {no, limited}: the next match after row `from` (1-based; 0 = before the first row). */
  async function findFrom(v, q, from, dir) {
    if (app.features.find !== false) {
      try {
        const res = await api.find(v.viewId, q, from, dir);
        app.features.find = true;
        return { no: res?.no ?? null, limited: false };
      } catch (err) {
        if (!(err.status === 404 && err.code === 'not-found')) throw err;
        app.features.find = false;
      }
    }
    // Fallback: scan summaries page by page, up to LOCAL_FIND_ROWS rows.
    const needle = q.toLowerCase();
    const step = 1000;
    const forward = dir !== 'prev';
    let scanned = 0;
    let offset = forward ? from : Math.max(0, from - 1 - step);
    while (scanned < LOCAL_FIND_ROWS && (forward ? offset < v.count : offset >= 0)) {
      const res = await api.viewRows(v.viewId, offset, step);
      const rows = res?.rows ?? [];
      const ordered = forward ? rows : [...rows].reverse();
      for (const r of ordered) {
        const no = r.no ?? 0;
        if (forward ? no <= from : no >= from) continue;
        if ([r.summary, r.kind, r.toolName, r.model, r.proto].some((x) => typeof x === 'string' && x.toLowerCase().includes(needle))) return { no, limited: false };
      }
      scanned += rows.length;
      if (!rows.length) break;
      if (forward) offset += step;
      else if (offset === 0) break;
      else offset = Math.max(0, offset - step);
    }
    return { no: null, limited: scanned >= LOCAL_FIND_ROWS };
  }

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      find(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  });
  findInput.addEventListener('input', () => {
    findInput.classList.remove('no-match');
    findStatus.textContent = '';
  });

  // ---------------------------------------------------------------------------
  // Marks and navigation

  function toggleMark(id = selId) {
    if (!id) return;
    if (marks.has(id)) marks.delete(id);
    else marks.add(id);
    const arr = [...marks];
    savePref('events.marks', arr.slice(-5000));
    state.set({ markCount: marks.size });
    list.refresh();
  }

  async function jumpMark(dir) {
    if (!view || !marks.size) return app.toast('No marked events. Press Ctrl+M to mark the selected event.');
    const v = view;
    const ids = [...marks].slice(-300);
    const nos = (await Promise.all(ids.map((id) => api.locate(v.viewId, id).then((r) => r?.no ?? null).catch(() => null))))
      .filter((n) => n != null)
      .map((n) => n - 1)
      .sort((a, b) => a - b);
    if (v !== view) return;
    if (!nos.length) return app.toast('No marked events in the current view.');
    const target = dir > 0 ? (nos.find((n) => n > selIndex) ?? nos[0]) : ([...nos].reverse().find((n) => n < selIndex) ?? nos[nos.length - 1]);
    select(target, 'center');
  }

  function partnerOf(d) {
    const ev = d.event;
    const rel = (d.related ?? []).filter((r) => r.id !== ev.id);
    const want = PARTNER[ev.kind];
    const target = want ? rel.find((r) => want.includes(r.kind)) : null;
    if (!target && d.span) {
      const other = d.span.firstEvent === ev.id ? d.span.lastEvent : d.span.firstEvent;
      if (other && other !== ev.id) return other;
    }
    return (target ?? rel[0])?.id ?? null;
  }

  function goPartner() {
    if (!detail || detail.event.id !== selId) return;
    const id = partnerOf(detail);
    if (id) app.selectEvent(id);
    else app.toast('This event has no paired event.');
  }

  function goBack() {
    const id = backStack.pop();
    if (!id) return app.toast('No earlier selection.');
    navigatingBack = true;
    app.selectEvent(id);
    navigatingBack = false;
  }

  const spanCache = new Map();
  async function stepInSpan(dir) {
    if (!detail) return;
    const spanId = detail.event.span ?? detail.event.turn;
    if (!spanId) return app.toast('This event is not part of a span.');
    try {
      if (!spanCache.has(spanId)) spanCache.set(spanId, await api.span(spanId));
      if (spanCache.size > 50) spanCache.delete(spanCache.keys().next().value);
      const events = spanCache.get(spanId)?.events ?? [];
      const i = events.findIndex((e) => e.id === selId);
      const target = events[i + dir];
      if (target) app.selectEvent(target.id);
      else app.toast(dir > 0 ? 'Last event in this span.' : 'First event in this span.');
    } catch (err) {
      app.toast(err.message, 'error');
    }
  }

  function goToDialog() {
    const input = h('input', { class: 'text-input mono', type: 'text', placeholder: 'No. or event id', 'aria-label': 'Go to event' });
    // Returns false to keep the dialog open after an out-of-range number.
    const go = () => {
      const v = input.value.trim();
      if (!v || !view) return true;
      if (/^\d+$/.test(v)) {
        const n = Number(v);
        if (n < 1 || n > view.count) {
          app.toast(`No. must be between 1 and ${formatInt(view.count)}.`, 'warn');
          return false;
        }
        select(n - 1, 'center');
      } else {
        app.selectEvent(v);
      }
      return true;
    };
    const dlg = openDialog({
      title: 'Go to event',
      body: [input, h('p', { class: 'dialog-note' }, view ? `The current view has ${formatInt(view.count)} events.` : 'No view loaded.')],
      actions: [{ label: 'Cancel' }, { label: 'Go', primary: true, onClick: go }],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (go()) dlg.close();
      }
    });
    input.focus();
  }

  // ---------------------------------------------------------------------------
  // Keyboard

  /** Shortcuts that work anywhere in the workspace except text fields. */
  function globalAction(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && !e.shiftKey && key === 'f') return openFind;
    if (ctrl && !e.shiftKey && key === 'g') return goToDialog;
    if (e.ctrlKey && !e.shiftKey && key === 'm') return () => toggleMark();
    if (e.ctrlKey && e.shiftKey && key === 'n') return () => jumpMark(1);
    if (e.ctrlKey && e.shiftKey && key === 'b') return () => jumpMark(-1);
    if (ctrl && key === 'arrowright') return goPartner;
    if (ctrl && key === 'arrowleft') return goBack;
    if (ctrl && key === '.') return () => stepInSpan(1);
    if (ctrl && key === ',') return () => stepInSpan(-1);
    if (e.key === 'F3') return () => (findInput.value ? find(e.shiftKey ? 'prev' : 'next') : openFind());
    return null;
  }

  /** Navigation keys for the event list (focus on the list or nowhere in particular). */
  function listAction(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !view) return null;
    if (e.shiftKey && e.key !== 'F10') return null;
    const at = Math.max(0, selIndex);
    switch (e.key) {
      case 'ArrowDown': return () => select(selIndex < 0 ? 0 : selIndex + 1);
      case 'ArrowUp': return () => select(selIndex < 0 ? 0 : selIndex - 1);
      case 'PageDown': return () => select(at + list.pageRows());
      case 'PageUp': return () => select(at - list.pageRows());
      case 'Home': return () => select(0);
      case 'End': return () => select(view.count - 1);
      case 'Enter': return focusTree;
      case 'ContextMenu': return rowMenuFromKeyboard;
      case 'F10': return e.shiftKey ? rowMenuFromKeyboard : null;
      case 'm':
      case 'M': return () => toggleMark();
    }
    return null;
  }

  function onKey(e) {
    if (!visible || e.defaultPrevented || isTyping(e) || document.querySelector('dialog[open]')) return;
    const inList = document.activeElement === scroller || document.activeElement === document.body;
    const action = globalAction(e) ?? (inList && !loadingQuery() ? listAction(e) : null);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  }
  document.addEventListener('keydown', onKey);

  // ---------------------------------------------------------------------------
  // View lifecycle

  let overlayTimer = 0;
  function renderOverlay() {
    clearTimeout(overlayTimer);
    const vs = app.viewState();
    const busy = loadingQuery();
    scroller.classList.toggle('busy', busy);
    clear(listOverlay);
    listOverlay.classList.remove('translucent');
    if (vs.status === 'failed') {
      const filterErr = vs.error?.code === 'filter';
      listOverlay.append(
        filterErr
          ? placeholder('error', 'The filter is not valid', vs.error.message, { label: 'Edit the filter', onClick: () => app.prepareFilter(state.get('filter')) })
          : placeholder('error', 'Could not load this view. Your selection is preserved.', vs.error?.message, { label: 'Retry', onClick: app.retryView }),
      );
      listOverlay.hidden = false;
    } else if (busy) {
      // Shown only for slow queries so fast filters do not flicker; rows underneath are inert.
      overlayTimer = setTimeout(() => {
        clear(listOverlay).append(placeholder('loading', `Loading ${app.scopeText()}…`));
        listOverlay.classList.toggle('translucent', !!view);
        listOverlay.hidden = false;
      }, 150);
      listOverlay.hidden = true;
    } else if (view && view.count === 0) {
      const sc = state.get('scope');
      const filter = state.get('filter');
      const timed = sc.from != null || sc.to != null;
      const actions = [
        filter ? { label: 'Clear filter', onClick: () => app.setFilter('') } : null,
        timed ? { label: 'Widen range', onClick: () => app.setTimeRange(null, null) } : null,
      ].filter(Boolean);
      listOverlay.append(
        placeholder(
          'empty',
          filter || timed || sc.sessions ? 'No events match this filter and scope' : 'No events',
          [filter ? `Filter: ${filter}` : null, sc.sessions ? `${sc.sessions.length} session${sc.sessions.length > 1 ? 's' : ''} in scope` : null, timed ? 'a time range is set' : null, !state.get('showInherited') ? 'inherited events hidden (View menu)' : null].filter(Boolean).join(' · '),
          actions.length ? actions : null,
        ),
      );
      listOverlay.hidden = false;
    } else {
      listOverlay.hidden = true;
    }
  }

  const atEnd = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - rowH() * 1.5;

  /**
   * A fresh all-sessions view in time order opens at its newest rows, where the sidebar's
   * "just now" sessions are, instead of at events from a year ago.
   */
  function followEnd() {
    if (!view || selId || view.reason === 'refresh') return;
    const sort = state.get('sort') ?? { key: 'ts', order: 'asc' };
    if (sort.key === 'ts' && sort.order === 'asc' && !view.spec?.sessions?.length && view.count > 0) list.scrollToIndex(view.count - 1, 'end');
  }

  let lastSessionsKey = null;
  function onView() {
    const next = state.get('view');
    if (next === view) {
      renderOverlay();
      return;
    }
    if (next && view && next.viewId === view.viewId && next.count === view.count) {
      view = next;
      renderOverlay();
      return;
    }
    const prev = view;
    const refresh = next?.reason === 'refresh' && !!prev;
    const tail = refresh && atEnd();
    view = next;
    inflight.clear();
    failedPages.clear();
    pendingCommit = null;
    if (refresh) {
      // Keep showing the old rows until the replacement pages arrive, so nothing blanks.
      stalePages.clear();
      for (const [p, rows] of pages) stalePages.set(p, rows);
    } else {
      stalePages.clear();
    }
    pages.clear();
    scroller.setAttribute('aria-rowcount', String(view?.count ?? 0));
    if (fitNoWidth()) applyColumnWidths();
    renderHeader();
    if (!refresh) scroller.scrollTop = 0;
    list.setCount(view?.count ?? 0);
    renderOverlay();
    if (!view) return;
    if (refresh) {
      if (tail) list.scrollToIndex(view.count - 1, 'end');
      if (selId) locateSelected(null, { quiet: true });
      return;
    }
    setSelIndex(-1);
    // Compare with the last view that loaded, so a failed request in between does not count as a scope change.
    const sessionsKey = (view.spec?.sessions ?? []).join('\n');
    const sessionsChanged = lastSessionsKey !== null && lastSessionsKey !== sessionsKey;
    lastSessionsKey = sessionsKey;
    if (selId) {
      locating = true;
      scroller.classList.add('locating');
      locateSelected('center', { clearIfMissing: sessionsChanged });
    } else {
      endLocating();
      hideNotice();
      followEnd();
    }
  }
  state.subscribe(['view'], onView);
  state.subscribe(['viewLoading', 'viewError', 'viewPending'], renderOverlay);
  /** The scope label (§7.3, §9 Counts): "54,272 of 2,156,784 events · 1 session + subagents · no filter". */
  function renderScope() {
    const vs = app.viewState();
    const total = state.get('info')?.counts?.events;
    const marked = state.get('markCount');
    let text;
    if (vs.status === 'loading') text = `Loading ${app.scopeText()}…`;
    else if (vs.status === 'failed') text = 'Could not load this view';
    else if (vs.view) {
      const n = vs.view.count;
      text = `${total != null && total !== n ? `${formatInt(n)} of ${formatInt(total)}` : formatInt(n)} events · ${app.scopeText()}${marked ? ` · ${formatInt(marked)} marked` : ''}`;
    } else text = '';
    setScopeLabel(scopeLine, text);
    app.setWorkspaceStatus('events', text);
  }
  state.subscribe(['view', 'viewLoading', 'viewError', 'info', 'markCount', 'scope', 'filter'], renderScope);
  renderScope();
  state.subscribe(['timeFormat', 'colorRules', 'colorize', 'metaVersion', 'scope', 'timeRef'], () => list.refresh());
  state.subscribe(['timeFormat', 'sort', 'timeRef'], renderHeader);
  state.subscribe(['density'], rebuildColumns);
  state.subscribe(['selectedEvent'], (s) => {
    const id = s.selectedEvent;
    if (id !== selId) {
      if (selId && id && !navigatingBack) backStack.push(selId);
      selId = id;
      if (id) locateSelected('center');
      else {
        endLocating();
        setSelIndex(-1);
      }
    }
    loadSelected(id);
  });

  // ---------------------------------------------------------------------------
  // Detail tree

  let detail = null;
  let detailStatus = 'empty'; // empty | loading | ok | error
  let detailError = null;
  let raw = null;
  let rawStatus = 'empty';
  let rawError = null;
  let derived = null; // EventDerived of the selected event (the Step and Failure layers), or null
  let loadSeq = 0;
  let layers = [];
  const layerOpen = { step: true, failure: true, ...loadPref('events.layers', { event: false, session: false, turn: false, span: true, decoded: true, related: false, native: false }) };
  const openNodes = new Set(); // node ids opened below the layer level, kept across selections
  let selectedNode = null;
  let treeRows = [];
  const fullValues = new Map(); // node id → full string fetched from raw

  function loadSelected(id) {
    const seq = ++loadSeq;
    // Headers of the previous event must not linger over the new one while it decodes.
    detailTitle.textContent = '';
    rawSource.textContent = '';
    rawSource.hidden = true;
    fullValues.clear();
    for (const url of imageUrls.values()) URL.revokeObjectURL(url);
    imageUrls.clear();
    derived = null;
    if (id && app.features.derived) {
      api.eventDerived(id).then((d) => {
        if (seq !== loadSeq) return;
        derived = d;
        if (detail?.event) {
          layers = buildLayers(detail);
          renderTree();
        }
      }).catch(() => {});
    }
    if (!id) {
      detail = null;
      raw = null;
      detailStatus = rawStatus = 'empty';
      state.set({ selectedDetail: null });
      renderTree();
      renderRaw();
      return;
    }
    detailStatus = rawStatus = 'loading';
    const delayed = setTimeout(() => {
      if (seq === loadSeq) {
        if (detailStatus === 'loading') renderTree();
        if (rawStatus === 'loading') renderRaw();
      }
    }, 120);
    api
      .event(id)
      .then((d) => {
        if (seq !== loadSeq) return;
        detail = d;
        detailStatus = d?.event ? 'ok' : 'error';
        detailError = d?.event ? null : new Error('Event not found');
        layers = d?.event ? buildLayers(d) : [];
        state.set({ selectedDetail: d ?? null });
        renderTree();
        if (rawStatus === 'ok' && !raw.available) renderRaw();
      })
      .catch((err) => {
        if (seq !== loadSeq) return;
        detail = null;
        detailStatus = 'error';
        detailError = err;
        state.set({ selectedDetail: null });
        renderTree();
      });
    api
      .raw(id, RAW_MAX_STRING)
      .then((r) => {
        if (seq !== loadSeq) return;
        raw = r;
        rawStatus = 'ok';
        renderRaw();
      })
      .catch((err) => {
        if (seq !== loadSeq) return;
        raw = null;
        rawStatus = 'error';
        rawError = err;
        renderRaw();
      })
      .finally(() => clearTimeout(delayed));
  }

  // Node: { id, label, value?, cls?, ptr?, children?: Node[] | () => Node[], text?, link?, image?, filter?, copy?, hint? }

  function kids(node) {
    if (typeof node.children === 'function') node.children = node.children();
    return node.children ?? [];
  }

  /** Lazy children count as expandable without being built. */
  function hasKids(node) {
    return typeof node.children === 'function' || (Array.isArray(node.children) && node.children.length > 0);
  }

  function isOpen(node, depth) {
    if (depth === 0) return !!layerOpen[node.layer];
    return openNodes.has(node.id) || (node.defaultOpen && !openNodes.has('!' + node.id));
  }

  function setOpen(node, depth, open) {
    if (depth === 0) {
      layerOpen[node.layer] = open;
      savePref('events.layers', layerOpen);
    } else if (node.defaultOpen) {
      if (open) openNodes.delete('!' + node.id);
      else openNodes.add('!' + node.id);
    } else if (open) {
      openNodes.add(node.id);
    } else {
      openNodes.delete(node.id);
    }
  }

  function setAllLayers(open) {
    for (const l of layers) layerOpen[l.layer] = open;
    savePref('events.layers', layerOpen);
    renderTree();
  }

  const qv = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

  function kv(id, label, value, extra = {}) {
    return { id, label, value: value == null || value === '' ? '—' : String(value), cls: value == null || value === '' ? 'muted' : extra.cls, ...extra };
  }

  function eventLink(id, label, eventId, hint) {
    return { id, label, value: hint ?? eventId, link: { event: eventId }, copy: eventId };
  }

  function sessionLink(id, label, sessionId) {
    const s = app.sessionById(sessionId);
    return { id, label, value: s?.title ? `${s.title}  (${shortId(sessionId)})` : sessionId, link: { session: sessionId }, copy: sessionId };
  }

  function buildLayers(d) {
    const ev = d.event;
    const out = [];
    const finder = pointerFinder(ev.native, ev.raw?.block);

    // 1. Event
    out.push({
      id: 'L:event',
      layer: 'event',
      label: `Event${ev.no != null ? ` No. ${formatInt(ev.no)}` : ''}`,
      value: `${ev.kind} · ${ev.actor} · ${formatClock(ev.ts, { offset: true })}`,
      ptr: '',
      children: [
        kv('ev/kind', 'Kind', ev.kind, { filter: `kind == ${qv(ev.kind)}`, hint: EVENT_KINDS[ev.kind], cptr: '/event/kind' }),
        kv('ev/proto', 'Record type', ev.proto, { filter: `proto == ${qv(ev.proto)}`, cptr: '/event/proto' }),
        kv('ev/actor', 'Actor', ev.actor, { filter: `actor == ${qv(ev.actor)}`, cptr: '/event/actor' }),
        kv('ev/ts', 'Time', `${formatClock(ev.ts, { digits: 6, offset: true })} · ${formatClock(ev.ts, { utc: true, digits: 6, offset: true })}`, { hint: `timestamp ${ev.tsSrc}`, copy: formatClock(ev.ts, { digits: 6, offset: true }) }),
        kv('ev/seq', 'Seq', ev.seq, { filter: `seq == ${ev.seq}`, cptr: '/event/seq' }),
        kv('ev/flags', 'Flags', (ev.flags ?? []).join(', ') || 'none', { cls: ev.flags?.includes('error') ? 'err' : undefined }),
        ev.dur != null ? kv('ev/dur', 'Duration', formatDuration(ev.dur), { filter: `dur >= ${ev.dur}us`, hint: `${formatInt(ev.dur)} µs` }) : null,
        ev.tokIn != null || ev.tokOut != null ? kv('ev/tok', 'Tokens', `${formatInt(ev.tokIn) || '—'} in · ${formatInt(ev.tokOut) || '—'} out`, { title: '— means the agent did not log this count' }) : null,
        ev.toolName ? kv('ev/tool', 'Tool', ev.toolName, { filter: `tool.name == ${qv(ev.toolName)}`, hint: toolKindOf(ev.toolName), cptr: '/event/toolName' }) : null,
        ev.model ? kv('ev/model', 'Model', ev.model, { filter: `model == ${qv(ev.model)}`, cptr: '/event/model' }) : null,
        kv('ev/id', 'Event id', ev.id, { copy: ev.id, mono: true }),
        ev.raw
          ? kv('ev/src', 'Source', `${ev.raw.path ?? ev.raw.source}:${ev.raw.line}`, {
              hint: `byte ${formatInt(ev.raw.offset)}, ${formatBytes(ev.raw.length)}${ev.raw.block != null ? `, block ${ev.raw.block}` : ''}`,
              copy: `${ev.raw.path ?? ev.raw.source}:${ev.raw.line}`,
              mono: true,
            })
          : null,
      ].filter(Boolean),
    });

    // 2. Session
    const s = d.session ?? app.sessionById(ev.session);
    out.push({
      id: 'L:session',
      layer: 'session',
      label: 'Session',
      value: s ? `${agentLabel(s.agent)} · ${s.title || shortId(s.id)}` : ev.session,
      children: s
        ? [
            sessionLink('se/id', 'Session', s.id),
            kv('se/agent', 'Agent', agentLabel(s.agent), { filter: `agent == ${qv(s.agent)}` }),
            kv('se/role', 'Role', s.role, { filter: `session.role == ${qv(s.role)}` }),
            kv('se/state', 'State', s.state, { cls: s.state !== 'ok' ? 'warn' : undefined }),
            kv('se/title', 'Title', s.title),
            kv('se/project', 'Project', s.project, { filter: s.project ? `project == ${qv(s.project)}` : undefined }),
            kv('se/cwd', 'Working directory', s.cwd, { mono: true }),
            kv('se/branch', 'Git branch', s.gitBranch),
            kv('se/models', 'Models', (s.models ?? []).join(', ')),
            kv('se/version', 'Version', s.version),
            kv('se/entry', 'Entrypoint', [s.entrypoint, s.originator].filter(Boolean).join(' · ')),
            kv('se/span', 'Active', s.start != null ? `${formatClock(s.start, { digits: 0 })} → ${formatClock(s.end, { digits: 0, offset: true })}` : null, {
              hint: s.start != null && s.end != null ? formatDuration(s.end - s.start) : undefined,
            }),
            kv('se/counts', 'Counts', `${formatInt(s.nEvents)} events · ${formatInt(s.nTurns)} turns · ${formatInt(s.nLlm)} model calls · ${formatInt(s.nTools)} tool calls · ${formatInt(s.nErrors)} errors`),
            s.tokens ? kv('se/tokens', 'Tokens', `${formatTokens(s.tokens.input)} in · ${formatTokens(s.tokens.output)} out`, { hint: s.costUsd != null ? `logged cost ${formatUsd(s.costUsd)}` : undefined }) : null,
            s.parentId ? sessionLink('se/parent', 'Parent session', s.parentId) : null,
            s.parentSpanId ? kv('se/pspan', 'Spawned by span', s.parentSpanId, { mono: true, copy: s.parentSpanId }) : null,
            s.rootId && s.rootId !== s.id ? sessionLink('se/root', 'Root session', s.rootId) : null,
            s.nChildren ? kv('se/children', 'Subagents', formatInt(s.nChildren)) : null,
          ].filter(Boolean)
        : [sessionLink('se/id', 'Session', ev.session)],
    });

    // 3. Turn
    const turn = d.spanChain?.find((x) => x.kind === 'turn') ?? (d.span?.kind === 'turn' ? d.span : null);
    if (turn) {
      out.push({
        id: 'L:turn',
        layer: 'turn',
        label: `Turn${turn.attrs?.turn?.index != null ? ` ${turn.attrs.turn.index}` : ''}`,
        value: `${turn.name || '(no prompt)'}${turn.dur != null ? ` · ${formatDuration(turn.dur)}` : ''}`,
        children: spanChildren('tu', turn),
      });
    }

    // 4. Span
    const span = d.span && d.span.kind !== 'turn' ? d.span : null;
    if (span) {
      const chain = (d.spanChain ?? []).map((x) => x.kind).concat(span.kind).join(' › ');
      out.push({
        id: 'L:span',
        layer: 'span',
        label: `Span: ${span.kind}`,
        value: `${span.name || span.id}${span.dur != null ? ` · ${formatDuration(span.dur)}` : ''} · ${span.status}`,
        children: [kv('sp/chain', 'Nesting', chain), ...spanChildren('sp', span)],
      });
    }

    // Step and Failure layers (SPEC §12.7 Events), from GET /api/events/:id/derived.
    if (derived) out.push(...derivedLayers(derived, ev));

    // 5. Decoded attributes
    const attrs = ev.attrs ?? {};
    const keys = Object.keys(attrs).sort((a, b) => rank(a) - rank(b));
    if (keys.length) {
      const name = attrs.tool?.name ?? attrs.llm?.model ?? attrs.agent?.type ?? attrs.hook?.name ?? '';
      out.push({
        id: 'L:decoded',
        layer: 'decoded',
        label: DECODED_LABELS[ev.kind] ?? `Decoded ${ev.kind}`,
        value: name || ev.summary || '',
        children: keys.map((k) => attrNode(`at/${k}`, k, attrs[k], k, finder)),
      });
    }

    // Related events (call/result partners, blocks of the same response).
    if (d.related?.length) {
      out.push({
        id: 'L:related',
        layer: 'related',
        label: 'Related events',
        value: `${d.related.length}`,
        children: d.related.map((r, i) => eventLink(`re/${i}`, r.kind, r.id, `${r.summary || r.id}`)),
      });
    }

    // 6. Native record
    out.push({
      id: 'L:native',
      layer: 'native',
      label: 'Native record',
      value: ev.proto,
      ptr: '',
      children: () => objectChildren('na', ev.native, '', 'native'),
    });
    return out;
  }

  function rank(k) {
    const i = ATTR_ORDER.indexOf(k);
    return i < 0 ? 100 : i;
  }

  /** "derived: ts-gap" style hint for a provenance, with its glyph. */
  const provHint = (p) => (p ? provTitle(p, state.get('info')?.analysis?.rules) : undefined);

  function derivedLayers(d, ev) {
    const out = [];
    const rules = state.get('info')?.analysis?.rules;
    if (d.step) {
      const st = d.step;
      out.push({
        id: 'L:step',
        layer: 'step',
        // The canonical step position (§9): "Step 46 · 5 of 6".
        label: st.inTurn ? `Step ${formatInt(st.n)} · ${formatInt(st.inTurn.n)} of ${formatInt(st.inTurn.of)}` : `Step ${formatInt(st.n)}`,
        value: st.inTurn ? '' : 'outside any turn',
        children: [
          kv('st/id', 'Step id', st.id, { mono: true, copy: st.id, filter: `step == ${qv(st.id)}` }),
          kv('st/seg', 'Grouping', st.segSrc, { hint: provHint(st.segSrc) }),
          { id: 'st/show', label: 'Session · Steps', value: 'Show this step', link: { step: ev.id } },
        ],
      });
    }
    const f = d.failure;
    if (f || d.episode || d.process || d.delegation || d.changes?.length || d.intervention || d.claim) {
      const kids = [];
      if (f) {
        kids.push(
          kv('fa/tier', 'Tier', f.tier, { cls: `tier-${f.tier}`, filter: `failure.tier == ${qv(f.tier)}`, hint: f.tier === 'suspect' ? 'a text rule fired on an unflagged result; an upper bound' : undefined }),
          kv('fa/source', 'Source', f.source, { filter: `failure.source == ${qv(f.source)}` }),
          kv('fa/rule', 'Rule', f.rule, { mono: true, hint: ruleTitle(f.rule, rules) }),
          kv('fa/family', 'Family', `${f.family} · ${f.class}`, { filter: `failure.family == ${qv(f.family)}` }),
          { id: 'fa/sig', label: 'Signature', value: f.signature, link: { lens: { kind: 'signature', id: f.signatureId } }, filter: `signature == ${qv(f.signatureId)}`, copy: f.signatureId },
          kv('fa/target', 'Target', f.targetKey, { mono: true, filter: `failure.target == ${qv(f.targetKey)}` }),
          kv('fa/exit', 'Exit code', f.exitCode != null ? `${f.exitCode}${provMark(f.exitSrc)}` : null, { hint: f.exitCode != null ? provHint(f.exitSrc) : 'not logged' }),
          f.errorLine ? kv('fa/line', 'Error line', f.errorLine, { mono: true }) : null,
        );
      }
      if (d.episode) {
        const o = OUTCOME[d.episode.outcome];
        kids.push(
          { id: 'fa/ep', label: 'Episode', value: `${o ? o.word : d.episode.outcome}${provMark(d.episode.outcomeSrc)} · ${f?.attempt ? `attempt ${f.attempt} of ${d.episode.nAttempts}` : d.episode.role === 'closer' ? 'the closing call' : 'a call of an attempt'}`, link: { lens: { kind: 'episode', id: d.episode.id } }, filter: `episode == ${qv(d.episode.id)}`, copy: d.episode.id, hint: provHint(d.episode.outcomeSrc) },
          kv('fa/section', 'Section', d.episode.section),
        );
      }
      if (d.process) {
        const p = d.process;
        kids.push(kv('fa/proc', 'Process', `${p.role} · ${p.status}${p.exitCode != null ? ` · exit ${p.exitCode}` : ''}${p.closeStep != null ? ` at step ${p.closeStep}` : ''}`, { filter: `process == ${qv(p.id)}`, copy: p.id, hint: p.exitSrc ? provHint(p.exitSrc) : undefined }));
        if (p.closeEventId) kids.push(eventLink('fa/proc-close', 'Process closed by', p.closeEventId));
      }
      if (d.delegation) {
        const g = d.delegation;
        kids.push({ id: 'fa/deleg', label: 'Delegation', value: `${DELEGATION[g.outcome]?.word ?? g.outcome}${g.silent ? ' · silent: parent told: no' : ''}`, cls: g.silent ? 'err' : undefined, link: { lens: { kind: 'delegation', id: g.id } }, hint: provHint(g.outcomeSrc) });
        if (g.childSessionId) kids.push(sessionLink('fa/child', 'Child session', g.childSessionId));
      }
      for (const [i, c] of (d.changes ?? []).entries()) {
        kids.push({ id: `fa/chg/${i}`, label: c.op === 'read' ? 'Reads' : 'Changes', value: `${c.path}${c.added != null ? ` +${c.added}` : ''}${c.removed != null ? ` −${c.removed}` : ''}${c.outsideCwd ? ' (outside the working directory)' : ''}`, mono: true, hint: provHint(c.src), link: c.diffAvailable ? { diff: { eventId: ev.id, path: c.path } } : undefined, filter: `change.path == ${qv(c.path)}` });
      }
      if (d.intervention) kids.push(kv('fa/int', 'Intervention', `${d.intervention.kind} by ${d.intervention.actor}`, { filter: `intervention.kind == ${qv(d.intervention.kind)}`, hint: provHint(d.intervention.actorSrc) }));
      if (d.claim) kids.push({ id: 'fa/claim', label: 'Claim', value: CLAIM[d.claim.evidence]?.word ?? d.claim.evidence, link: { lens: { kind: 'claim', id: d.claim.turnId } }, hint: ruleTitle(d.claim.rule, rules), filter: `claim.evidence == ${qv(d.claim.evidence)}` });
      out.push({
        id: 'L:failure',
        layer: 'failure',
        // The layer names the tier ("Failure", "Benign exit"); its note follows without repeating it.
        label: f ? TIER_LAYER[f.tier] ?? 'Failure' : 'Derived',
        // The Failure layer carries the Solid tier badge once (§6.1, §7.10); other tiers take their Outline badge.
        badge: f ? h('span', { class: [f.tier === 'failure' ? 'b-solid' : 'b-outline', `tone-${f.tier}`] }, TIER[f.tier]?.word ?? f.tier) : null,
        value: f ? noteText(f) : d.episode ? `in an episode (${OUTCOME[d.episode.outcome]?.word ?? d.episode.outcome})` : d.claim ? 'claim check' : d.delegation ? 'delegation' : d.process ? 'process' : 'changes',
        children: kids.filter(Boolean),
      });
    }
    return out;
  }

  function spanChildren(prefix, span) {
    const isTool = span.kind === 'tool';
    return [
      kv(`${prefix}/name`, 'Name', span.name, { filter: span.name ? `span.name == ${qv(span.name)}` : undefined }),
      kv(`${prefix}/status`, 'Status', span.status, { cls: span.status === 'error' ? 'err' : span.status === 'ok' ? undefined : 'warn', filter: `span.status == ${qv(span.status)}` }),
      kv(`${prefix}/time`, 'Start', formatClock(span.start, { digits: 6, offset: true }), { hint: span.end != null ? `end ${formatClock(span.end, { digits: 6 })}` : 'no end recorded' }),
      kv(`${prefix}/dur`, 'Duration', span.dur != null ? formatDuration(span.dur) : 'unknown', { hint: `source: ${span.durSrc}` }),
      span.firstEvent ? eventLink(`${prefix}/first`, isTool ? 'Call event' : 'First event', span.firstEvent) : null,
      span.lastEvent && span.lastEvent !== span.firstEvent ? eventLink(`${prefix}/last`, isTool ? 'Result event' : 'Last event', span.lastEvent) : null,
      span.linkSession ? sessionLink(`${prefix}/child`, 'Child session', span.linkSession) : null,
      kv(`${prefix}/id`, 'Span id', span.id, { mono: true, copy: span.id }),
      span.attrs && Object.keys(span.attrs).length
        ? { id: `${prefix}/attrs`, label: 'Attributes', value: summarize(span.attrs), cls: 'muted', children: () => objectChildren(`${prefix}/attrs`, span.attrs, null, null) }
        : null,
    ].filter(Boolean);
  }

  /** A node for one normalized attribute; `path` is the dotted filter field. */
  function attrNode(id, key, v, path, finder) {
    const fieldPath = path && path.split('.').every((p) => IDENT.test(p)) ? path : null;
    if (key === 'tokens' && v && typeof v === 'object') return tokensNode(id, v, finder);
    if (v && typeof v === 'object' && !Array.isArray(v) && !('$omitted' in v)) {
      const ptr = path === 'tool.input' ? finder.object(v) : null;
      return {
        id,
        label: key,
        value: summarize(v),
        cls: 'muted',
        ptr,
        defaultOpen: !path.includes('.'),
        children: () =>
          Object.entries(v).map(([k, x]) => {
            const childPath = `${path}.${k}`;
            if (ptr != null && (path === 'tool.input' || path.startsWith('tool.input.'))) {
              return valueNode(`${id}/${k}`, k, x, ptr + '/' + pointerEscape(k), childPath.split('.').every((p) => IDENT.test(p)) ? childPath : null);
            }
            return attrNode(`${id}/${k}`, k, x, childPath, finder);
          }),
      };
    }
    const node = valueNode(id, key, v, finder.find(v, key), fieldPath);
    if (typeof v === 'number' && MS_FIELDS.has(key)) node.hint = formatDuration(v * 1000);
    if (key === 'usd' && typeof v === 'number') node.hint = formatUsd(v);
    if (typeof v === 'string' && (key === 'persisted_path' || key === 'backup' || (key === 'path' && path?.startsWith('file')))) {
      node.link = { file: v };
      if (IMAGE_EXT.test(v)) node.image = { url: api.fileUrl({ path: v }) };
    }
    if (key === 'link_session' && typeof v === 'string') node.link = { session: v };
    return node;
  }

  function tokensNode(id, t, finder) {
    const ratio = t.input ? (t.cache_read ?? 0) / t.input : null;
    const rows = ['input', 'uncached', 'cache_read', 'cache_write', 'output', 'reasoning', 'total', 'context_window']
      .filter((k) => t[k] != null)
      .map((k) => {
        const n = valueNode(`${id}/${k}`, k, t[k], finder.find(t[k], k), `tokens.${k}`);
        n.value = formatInt(t[k]);
        return n;
      });
    if (ratio != null) rows.push(kv(`${id}/hit`, 'cache hit ratio', formatPercent(ratio)));
    return { id, label: 'tokens', value: `${formatTokens(t.input)} in · ${formatTokens(t.output)} out`, cls: 'muted', defaultOpen: true, children: rows };
  }

  /** Generic JSON value node. `ptr` is its pointer into the raw record (null when unknown). */
  function valueNode(id, label, v, ptr, fieldPath, parent) {
    if (v && typeof v === 'object' && '$omitted' in v) return omittedNode(id, label, v, ptr, parent);
    if (Array.isArray(v)) {
      return {
        id,
        label,
        value: `[${v.length}]`,
        cls: 'muted',
        ptr,
        children: v.length ? () => v.map((x, i) => valueNode(`${id}/${i}`, `[${i}]`, x, ptr != null ? `${ptr}/${i}` : null, null, v)) : undefined,
      };
    }
    if (v && typeof v === 'object') {
      return { id, label, value: summarize(v), cls: 'muted', ptr, children: Object.keys(v).length ? () => objectChildren(id, v, ptr, fieldPath) : undefined };
    }
    const filter = fieldPath && v != null ? `${fieldPath} == ${qv(v)}` : undefined;
    if (typeof v === 'string') {
      const long = v.length > 140 || v.includes('\n');
      const first = v.split('\n', 1)[0];
      return {
        id,
        label,
        value: long ? first.slice(0, 140) + (first.length > 140 || v.includes('\n') ? ' …' : '') : JSON.stringify(v),
        cls: 'str',
        ptr,
        text: long ? v : null,
        hint: long ? `${formatInt(v.length)} characters · ${formatInt(lineCount(v))} lines` : undefined,
        filter: long ? undefined : filter,
        copy: v,
        truncatedMarker: /…\[\+(\d+)\]$/.exec(v)?.[1],
      };
    }
    return { id, label, value: String(v), cls: v === null ? 'muted' : typeof v === 'number' ? 'num' : 'lit', ptr, filter, copy: String(v) };
  }

  function objectChildren(id, obj, ptr, fieldPath) {
    if (obj == null || typeof obj !== 'object') return [valueNode(`${id}/v`, 'value', obj, ptr, fieldPath)];
    return Object.entries(obj).map(([k, x]) => {
      const childField = fieldPath && IDENT.test(k) ? `${fieldPath}.${k}` : null;
      return valueNode(`${id}/${pointerEscape(k)}`, k, x, ptr != null ? `${ptr}/${pointerEscape(k)}` : null, childField, obj);
    });
  }

  function omittedNode(id, label, v, ptr, parent) {
    const mediaType = v.mediaType ?? parent?.media_type ?? parent?.mediaType ?? parent?.mime_type ?? null;
    const isImage = typeof mediaType === 'string' && mediaType.startsWith('image/') && ptr != null;
    return {
      id,
      label,
      value: `‹${v.$omitted}${v.bytes ? ` · ${formatBytes(v.bytes)}` : ''}${v.count ? ` · ${formatInt(v.count)} more items` : ''}${mediaType ? ` · ${mediaType}` : ''}›`,
      cls: 'muted',
      ptr,
      image: isImage ? { ptr, mediaType, bytes: v.bytes ?? 0 } : null,
      defaultOpen: isImage,
    };
  }

  function summarize(o) {
    if (Array.isArray(o)) return `[${o.length}]`;
    const keys = Object.keys(o);
    const bits = [];
    for (const k of ['type', 'name', 'role', 'subtype', 'id']) if (typeof o[k] === 'string') bits.push(`${k}: ${JSON.stringify(o[k].length > 40 ? o[k].slice(0, 40) + '…' : o[k])}`);
    return bits.length ? `{${bits.join(', ')}${keys.length > bits.length ? ', …' : ''}}` : `{${keys.length} ${keys.length === 1 ? 'field' : 'fields'}}`;
  }

  /**
   * Heuristic map from normalized attribute values to pointers in the native record, so decoded
   * fields can highlight their source bytes. Searches the event's own content block first.
   */
  function pointerFinder(native, block) {
    let leaves = null;
    const prefer = block != null && pointerGet(native, `/message/content/${block}`) !== undefined ? `/message/content/${block}` : null;
    const norm = (k) => String(k).toLowerCase().replace(/[_-]/g, '');
    const collect = () => {
      leaves = [];
      let budget = 20000;
      const walk = (x, ptr) => {
        if (budget-- <= 0) return;
        if (x && typeof x === 'object') {
          if ('$omitted' in x) return;
          leaves.push({ ptr, v: x });
          for (const [k, y] of Object.entries(x)) walk(y, `${ptr}/${pointerEscape(k)}`);
        } else {
          leaves.push({ ptr, v: x });
        }
      };
      walk(native, '');
      if (prefer) leaves.sort((a, b) => Number(!a.ptr.startsWith(prefer)) - Number(!b.ptr.startsWith(prefer)));
    };
    const strip = (s) => s.replace(/…\[\+\d+\]$/, '');
    return {
      find(value, key) {
        if (native == null || value == null || typeof value === 'object') return null;
        if (!leaves) collect();
        if (typeof value === 'string') {
          if (value.length < 3) return null;
          const a = strip(value).slice(0, 200);
          const hit = leaves.find((l) => typeof l.v === 'string' && (strip(l.v).startsWith(a) || (a.startsWith(strip(l.v)) && l.v.length >= 24)));
          return hit?.ptr ?? null;
        }
        const k = norm(key);
        const hit = leaves.find((l) => l.v === value && norm(pointerSegments(l.ptr).pop() ?? '') === k);
        return hit?.ptr ?? null;
      },
      object(obj) {
        if (native == null || !obj) return null;
        if (!leaves) collect();
        const keys = Object.keys(obj);
        if (!keys.length) return null;
        const hit = leaves.find((l) => l.v && typeof l.v === 'object' && !Array.isArray(l.v) && keys.every((k) => k in l.v));
        return hit?.ptr ?? null;
      },
    };
  }

  // Rendering -----------------------------------------------------------------

  function renderTree() {
    clear(treeBody);
    treeRows = [];
    if (detailStatus === 'empty') {
      detailTitle.textContent = '';
      treeBody.append(placeholder('empty', 'Select an event to decode it', 'Click a row or use the arrow keys.'));
      return;
    }
    if (detailStatus === 'loading') {
      treeBody.append(placeholder('loading', 'Decoding…'));
      return;
    }
    if (detailStatus === 'error') {
      detailTitle.textContent = '';
      treeBody.append(placeholder('error', 'Could not load the event', detailError?.status === 404 ? 'The event is no longer in the index; it may have been re-indexed.' : detailError?.message));
      return;
    }
    const ev = detail.event;
    detailTitle.textContent = `${ev.kind}${ev.no != null ? ` · No. ${formatInt(ev.no)}` : ''}`;
    const frag = document.createDocumentFragment();
    const walk = (node, depth, parent) => {
      const expandable = hasKids(node) || !!node.text || !!node.image;
      const open = expandable && isOpen(node, depth);
      const row = renderNode(node, depth, expandable, open);
      frag.append(row);
      treeRows.push({ node, depth, parent, el: row, expandable, open });
      if (open) {
        if (node.image) frag.append(imageBlock(node, depth));
        if (node.text) frag.append(textBlock(node, depth));
        for (const c of kids(node)) walk(c, depth + 1, node);
      }
    };
    for (const l of layers) walk(l, 0, null);
    treeBody.append(frag);
    // Node ids are paths, so the selected field stays selected when the next event has it too.
    const sel = treeRows.find((r) => r.node.id === selectedNode);
    sel?.el.classList.add('selected');
    highlightRaw(sel?.node.ptr ?? null, false);
  }

  /** One outline row (§7.10): the label column (with its disclosure) and the value; a layer row spans both. */
  function renderNode(node, depth, expandable, open) {
    const valueEl = h('span', { class: ['dt-value', node.cls, node.mono && 'mono', node.link && 'dt-link'], title: node.title ?? (node.value === '—' ? 'Not recorded for this event' : null) }, node.value ?? '');
    if (!valueEl.title && node.value) autoTitle(valueEl, node.value);
    if (node.link) {
      valueEl.setAttribute('role', 'link');
      valueEl.title = node.link.event ? 'Go to this event' : node.link.session ? 'Open this session' : node.link.lens ? `Open this ${node.link.lens.kind} in the Lens` : node.link.step ? 'Show in Session (⇧↩)' : node.link.diff ? 'Show the diff' : 'Open this file';
    }
    const layer = depth === 0;
    const twisty = expandable ? h('span', { class: ['twisty', open && 'open'], dataset: { twisty: '1' } }, icon('chevron', 10)) : h('span', { class: 'twisty-gap' });
    const label = h('span', { class: 'dt-label' }, node.label);
    const extra = [
      node.hint ? h('span', { class: 'dt-hint', title: node.hint }, node.hint) : null,
      node.link?.file ? h('a', { class: 'dt-ext', href: api.fileUrl({ path: node.link.file }), target: '_blank', rel: 'noopener', title: 'Open the file', 'aria-label': 'Open the file' }, icon('external', 11)) : null,
    ];
    return h(
      'div',
      {
        class: ['dt-row', layer && 'dt-layer', node.ptr != null && 'has-ptr'],
        role: 'treeitem',
        'aria-level': String(depth + 1),
        'aria-expanded': expandable ? String(open) : null,
        dataset: { id: node.id },
        style: { '--depth': String(depth) },
      },
      layer
        ? h('span', { class: 'dt-key' }, twisty, label, node.badge ?? null, node.value != null && node.value !== '' ? valueEl : null, extra)
        : [h('span', { class: 'dt-key' }, twisty, label), h('span', { class: 'dt-val' }, node.value != null ? valueEl : null, extra)],
    );
  }

  function textBlock(node, depth) {
    const full = fullValues.get(node.id) ?? node.text;
    const shown = full.length > TEXT_PREVIEW && !node.showAll ? full.slice(0, TEXT_PREVIEW) : full;
    const block = h('div', { class: 'dt-text', style: { marginLeft: `${20 + depth * 14}px` } }, h('pre', null, shown));
    const actions = h('div', { class: 'dt-text-actions' });
    if (shown.length < full.length) {
      actions.append(h('button', { class: 'link-btn', onClick: () => ((node.showAll = true), renderTree()) }, `Show all ${formatInt(full.length)} characters`));
    }
    if (node.truncatedMarker && node.ptr != null && !fullValues.has(node.id)) {
      actions.append(
        h('button', { class: 'link-btn', onClick: () => loadFull(node, Number(node.truncatedMarker) + full.length) }, `Load the full value from the source (+${formatInt(Number(node.truncatedMarker))} characters)`),
      );
    }
    actions.append(h('button', { class: 'link-btn', onClick: () => copyText(full).then(() => app.toast('Copied', 'ok')) }, 'Copy'));
    block.append(actions);
    return block;
  }

  async function loadFull(node, length) {
    try {
      const value = await fetchRawValue(node.ptr, length);
      if (typeof value === 'string') {
        fullValues.set(node.id, value);
        node.showAll = false;
        renderTree();
      } else {
        app.toast('The source value is not available.', 'warn');
      }
    } catch (err) {
      app.toast(err.message, 'error');
    }
  }

  async function fetchRawValue(ptr, length) {
    const id = selId;
    const res = await api.raw(id, Math.max(RAW_MAX_STRING, length + 64));
    if (id !== selId) throw new Error('Selection changed');
    if (!res?.available || !res.text) throw new Error(res?.reason ?? 'Raw bytes are unavailable');
    return pointerGet(JSON.parse(res.text), ptr);
  }

  const imageUrls = new Map(); // node id → object URL, revoked when the selection changes
  function imageBlock(node, depth) {
    const box = h('div', { class: 'dt-image', style: { marginLeft: `${20 + depth * 14}px` } });
    const img = node.image;
    const show = (src) => {
      clear(box).append(
        h('img', {
          src,
          alt: `Image ${img.mediaType ?? ''}`,
          loading: 'lazy',
          onError: () => clear(box).append(h('span', { class: 'muted' }, 'The image could not be displayed.')),
          onClick: () => window.open(src, '_blank', 'noopener'),
        }),
      );
    };
    if (img.url) {
      show(img.url);
    } else if (imageUrls.has(node.id)) {
      show(imageUrls.get(node.id));
    } else {
      const load = async () => {
        clear(box).append(h('span', { class: 'spinner small' }), ' Loading image…');
        try {
          const value = await fetchRawValue(img.ptr, img.bytes);
          const url = imageObjectUrl(value, img.mediaType);
          if (!url) throw new Error('No image data at this field');
          imageUrls.set(node.id, url);
          show(url);
        } catch (err) {
          clear(box).append(h('span', { class: 'muted' }, `Preview unavailable: ${err.message}`));
        }
      };
      if (img.bytes && img.bytes <= AUTO_IMAGE_BYTES) load();
      else box.append(h('button', { class: 'btn small', onClick: load }, icon('image', 12), ` Load image preview (${formatBytes(img.bytes)})`));
    }
    return box;
  }

  /** Build a blob: URL from base64 or a data: URL string. */
  function imageObjectUrl(value, mediaType) {
    if (typeof value !== 'string') return null;
    let b64 = value;
    let type = mediaType;
    const m = /^data:([^;,]+)[^,]*,/.exec(value);
    if (m) {
      type = m[1];
      b64 = value.slice(m[0].length);
    }
    if (!type?.startsWith('image/')) return null;
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type }));
  }

  // Interaction ---------------------------------------------------------------

  function rowInfo(el) {
    const row = el?.closest('.dt-row');
    return row ? treeRows.find((r) => r.el === row) : null;
  }

  function selectTreeRow(info, { focus = false } = {}) {
    for (const r of treeRows) r.el.classList.toggle('selected', r === info);
    selectedNode = info?.node.id ?? null;
    if (info) {
      ensureVisible(treeBody, info.el);
      if (focus) treeBody.focus({ preventScroll: true });
    }
    highlightRaw(info?.node.ptr ?? null);
  }

  function toggleRow(info, open = !info.open) {
    if (!info?.expandable) return;
    setOpen(info.node, info.depth, open);
    renderTree();
    selectTreeRow(treeRows.find((r) => r.node.id === info.node.id));
  }

  function followLink(link) {
    if (link.event) app.selectEvent(link.event);
    else if (link.session) app.openSession(link.session);
    else if (link.file) window.open(api.fileUrl({ path: link.file }), '_blank', 'noopener');
    else if (link.lens) app.openLens(link.lens);
    else if (link.step) app.showInSession(link.step);
    else if (link.diff) openDiff(app, link.diff.eventId, link.diff.path);
  }

  treeBody.addEventListener('click', (e) => {
    const info = rowInfo(e.target);
    if (!info) return;
    if (e.target.closest('[data-twisty]')) return toggleRow(info);
    if (e.target.closest('.dt-link') && info.node.link) return followLink(info.node.link);
    selectTreeRow(info);
  });
  treeBody.addEventListener('dblclick', (e) => {
    const info = rowInfo(e.target);
    if (info && !e.target.closest('[data-twisty], .dt-link')) toggleRow(info);
  });
  /** Composite pointer of a node into {event, attrs, native}, the document fieldMap addresses. */
  function compositePointer(node) {
    if (node.cptr) return node.cptr;
    if (node.id.startsWith('at/')) return '/attrs/' + node.id.slice(3);
    if ((node.id === 'L:native' || node.id.startsWith('na/')) && node.ptr != null) return '/native' + node.ptr;
    return null;
  }

  /** {field, value, expr} for a node: the server's fieldMap first, the local heuristics second. */
  function nodeField(node) {
    const ref = detail?.fieldMap?.[compositePointer(node)];
    if (ref?.field) {
      const expr = fieldPredicate(ref.field, ref.value);
      if (expr) return { field: ref.field, value: ref.value, expr };
    }
    if (!node.filter) return null;
    const m = /^([\w.$-]+)\s*(==|>=)/.exec(node.filter);
    return { field: m?.[1] ?? null, value: node.copy ?? node.value, expr: node.filter };
  }

  treeBody.addEventListener('contextmenu', (e) => {
    const info = rowInfo(e.target);
    if (!info) return;
    e.preventDefault();
    selectTreeRow(info);
    const n = info.node;
    const f = nodeField(n);
    const modes = (fn) => COMBINE_MODES.map((m) => ({ label: m.label, hint: m.hint, onSelect: () => fn(f.expr, m.id) }));
    showMenu({ x: e.clientX, y: e.clientY }, [
      {
        label: 'Apply as filter',
        hint: f ? (state.get('filter') ? `…and ${f.expr}` : f.expr) : 'no filter field',
        disabled: !f,
        title: f ? 'Narrows the current filter; the submenu has every combination' : 'This value has no filter field',
        onSelect: f ? () => app.narrowFilter(f.expr, 'and') : undefined,
        items: f ? modes(app.narrowFilter) : null,
      },
      { label: 'Prepare as filter', disabled: !f, items: f ? modes(app.prepareFilter) : null },
      { label: 'Apply as column', hint: f?.field ?? '', disabled: !f?.field, onSelect: () => addColumn(f.field) },
      { separator: true },
      { label: 'Copy value', disabled: n.copy == null && n.value == null, onSelect: () => copyText(String(fullValues.get(n.id) ?? n.copy ?? n.value)) },
      { label: 'Copy field name', disabled: !f?.field, onSelect: () => copyText(f.field) },
      { label: 'Copy JSON pointer', disabled: n.ptr == null, onSelect: () => copyText(n.ptr) },
      n.link ? { label: n.link.event ? 'Go to event' : n.link.session ? 'Open session' : 'Open file', onSelect: () => followLink(n.link) } : null,
      { separator: true },
      { label: 'Expand subtree', disabled: !info.expandable, onSelect: () => expandSubtree(info) },
      { label: 'Collapse all', onSelect: () => (openNodes.clear(), setAllLayers(false)) },
    ].filter(Boolean), { minWidth: 240 });
  });

  function expandSubtree(info) {
    const visit = (node, depth, budget) => {
      if (budget.n-- <= 0) return;
      setOpen(node, depth, true);
      for (const c of kids(node)) visit(c, depth + 1, budget);
    };
    visit(info.node, info.depth, { n: 400 });
    renderTree();
  }

  treeBody.addEventListener('keydown', (e) => {
    // Ctrl/Cmd/Alt combinations (Ctrl+→ partner, Ctrl+. next in span, …) are workspace shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!treeRows.length) return;
    let i = treeRows.findIndex((r) => r.node.id === selectedNode);
    const cur = treeRows[i];
    const move = (j) => selectTreeRow(treeRows[Math.max(0, Math.min(treeRows.length - 1, j))]);
    let used = true;
    switch (e.key) {
      case 'ArrowDown':
        move(i + 1);
        break;
      case 'ArrowUp':
        move(i < 0 ? 0 : i - 1);
        break;
      case 'ArrowRight':
        if (cur?.expandable && !cur.open) toggleRow(cur, true);
        else if (cur?.open) move(i + 1);
        break;
      case 'ArrowLeft':
        if (cur?.open) toggleRow(cur, false);
        else if (cur?.parent) selectTreeRow(treeRows.find((r) => r.node === cur.parent));
        break;
      case 'Enter':
      case ' ':
        if (cur?.node.link && e.key === 'Enter') followLink(cur.node.link);
        else if (cur) toggleRow(cur);
        break;
      case 'Escape':
        scroller.focus();
        break;
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) {
          used = false;
          break;
        }
        if (cur) {
          const b = cur.el.getBoundingClientRect();
          cur.el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 60, clientY: b.bottom }));
        }
        break;
      case '*':
        if (cur) expandSubtree(cur);
        break;
      default:
        used = false;
    }
    if (used) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  function focusTree() {
    treeBody.focus({ preventScroll: true });
    if (!selectedNode && treeRows.length) selectTreeRow(treeRows[0]);
  }

  /** Reveal the native-record node for a raw pointer (raw → tree direction). */
  function revealPointer(ptr) {
    const nativeLayer = layers.find((l) => l.layer === 'native');
    if (!nativeLayer) return;
    if (!layerOpen.native) setOpen(nativeLayer, 0, true);
    let node = nativeLayer;
    let depth = 0;
    let target = nativeLayer;
    for (const seg of pointerSegments(ptr)) {
      const next = kids(node).find((c) => c.ptr != null && pointerSegments(c.ptr).pop() === seg);
      if (!next) break;
      setOpen(node, depth, true);
      node = next;
      depth++;
      target = next;
    }
    renderTree();
    const info = treeRows.find((r) => r.node === target);
    if (info) selectTreeRow(info);
  }

  function copyEventJson() {
    if (!detail) return;
    copyText(JSON.stringify(detail.event, null, 2)).then(() => app.toast('Event JSON copied', 'ok'));
  }

  // ---------------------------------------------------------------------------
  // Raw pane

  let rawMode = loadPref('events.rawMode', 'pretty');
  let rawWrap = loadPref('events.rawWrap', false);
  let rawModel = null; // { text, parsed, lineEls }
  let rawPtr = null;

  function renderRawControls() {
    clear(rawModeBtn);
    for (const [id, label] of [['pretty', 'Pretty'], ['line', 'Exact']]) {
      rawModeBtn.append(
        h(
          'button',
          {
            class: ['seg-btn', rawMode === id && 'on'],
            'aria-pressed': String(rawMode === id),
            title: id === 'pretty' ? 'Pretty-printed JSON with syntax colors' : 'The source line exactly as stored',
            onClick: () => {
              rawMode = id;
              savePref('events.rawMode', rawMode);
              renderRawControls();
              renderRaw();
            },
          },
          label,
        ),
      );
    }
    wrapBtn.setAttribute('aria-pressed', String(rawWrap));
    wrapBtn.classList.toggle('on', rawWrap);
    rawBody.classList.toggle('wrap', rawWrap);
  }
  wrapBtn.addEventListener('click', () => {
    rawWrap = !rawWrap;
    savePref('events.rawWrap', rawWrap);
    renderRawControls();
  });
  renderRawControls();

  rawSource.addEventListener('dblclick', () => {
    if (rawSource.dataset.loc) copyText(rawSource.dataset.loc).then(() => app.toast('Source location copied', 'ok'));
  });

  function copyRawLine() {
    if (rawModel?.text) copyText(rawModel.text).then(() => app.toast(raw?.truncated ? 'Copied (long strings shortened)' : 'Source line copied', 'ok'));
  }

  function renderRaw() {
    clear(rawBody);
    clear(rawFoot);
    rawModel = null;
    const src = raw?.source;
    const loc = src ? `${src.path ?? src.id}:${src.line}` : '';
    rawSource.dataset.loc = loc;
    // A path cuts in the middle and keeps its file name whole (§3.5); the full path is its name and tooltip.
    rawSource.textContent = loc ? middleEllipsis(loc, Math.max(120, (rawSource.parentElement?.clientWidth ?? 400) - 260), 12) : '';
    rawSource.title = src ? `${loc} · byte offset ${formatInt(src.offset)}, ${formatBytes(src.length)}` : '';
    rawSource.hidden = !loc;

    if (rawStatus !== 'ok') {
      rawBody.append(
        rawStatus === 'loading'
          ? placeholder('loading', 'Reading source…')
          : rawStatus === 'error'
            ? placeholder('error', 'Could not read the source', rawError?.message)
            : placeholder('empty', 'No event selected', 'The source line of the selected event appears here.'),
      );
      return;
    }

    let text = raw.text;
    if (raw.available && (raw.verification === 'unverified' || raw.captureIntegrity && raw.captureIntegrity !== 'verified')) {
      rawBody.append(h('div', { class: 'raw-banner' }, icon('warning', 13), h('span', null,
        raw.captureIntegrity === 'failed' ? 'Recovered capture evidence failed integrity validation.'
          : 'Evidence identity is unverified. This source predates fingerprints or the capture has no verified checksum.')));
    }
    if (!raw.available) {
      const reason = raw.reason ?? 'the source file cannot be read';
      const fallback = !text && detail?.event?.native != null;
      if (fallback) text = JSON.stringify(detail.event.native);
      rawBody.append(
        h(
          'div',
          { class: 'raw-banner' },
          icon('warning', 13),
          h('span', null, `Raw bytes unavailable: ${reason}.${fallback ? ' Showing the indexed copy (long strings capped at 512 characters).' : ''}`),
        ),
      );
    }
    if (!text) {
      rawBody.append(placeholder('empty', 'No source text', raw.available ? null : 'Neither the source line nor an indexed copy is available.'));
      return;
    }

    let parsed = null;
    if (text.length <= MAX_PRETTY_CHARS) {
      try {
        parsed = prettyJson(text);
      } catch {
        parsed = null;
      }
    }
    rawModel = { text, parsed, lineEls: [] };
    if (rawMode === 'pretty' && parsed) renderPretty(parsed);
    else rawBody.append(h('pre', { class: 'raw-flat' }, text));
    const notes = [`${formatInt(text.length)} characters`];
    if (raw.truncated) notes.push(`strings longer than ${formatInt(RAW_MAX_STRING)} characters shortened`);
    if (!parsed) notes.push(text.length > MAX_PRETTY_CHARS ? 'too large to pretty-print' : 'not valid JSON');
    rawFoot.append(h('span', { class: 'raw-sel' }), h('span', { class: 'raw-notes' }, notes.join(' · ')));
    highlightRaw(rawPtr, false);
  }

  function renderPretty(parsed) {
    const pre = h('div', { class: 'raw-pretty' });
    const frag = document.createDocumentFragment();
    const n = Math.min(parsed.lines.length, MAX_PRETTY_LINES);
    for (let li = 0; li < n; li++) {
      const div = document.createElement('div');
      div.className = 'raw-line';
      const ln = document.createElement('span');
      ln.className = 'raw-ln';
      ln.textContent = String(li + 1);
      div.append(ln);
      for (const seg of parsed.lines[li]) {
        if (seg.c === 'ws') {
          div.append(seg.t);
          continue;
        }
        const sp = document.createElement('span');
        sp.className = `tok-${seg.c}`;
        sp.textContent = seg.t;
        if (seg.p != null) sp.dataset.p = seg.p;
        div.append(sp);
      }
      frag.append(div);
      rawModel.lineEls.push(div);
    }
    pre.append(frag);
    rawBody.append(pre);
    if (parsed.lines.length > n) {
      rawBody.append(h('div', { class: 'raw-banner' }, `Showing the first ${formatInt(n)} of ${formatInt(parsed.lines.length)} lines. Switch to Line view for the whole record.`));
    }
  }

  function highlightRaw(ptr, scroll = true) {
    rawPtr = ptr;
    if (!rawModel) return;
    const sel = rawFoot.querySelector('.raw-sel');
    for (const el of rawBody.querySelectorAll('.hl, .hl-line')) el.classList.remove('hl', 'hl-line');
    const range = ptr != null ? rawModel.parsed?.ptrs.get(ptr) : null;
    if (sel) sel.textContent = ptr == null ? '' : range ? `${ptr || '(whole record)'} · characters ${formatInt(range.s)}–${formatInt(range.e)}` : `${ptr} · not in the source line`;
    const flat = rawBody.querySelector('.raw-flat');
    if (flat) {
      const t = rawModel.text;
      clear(flat);
      if (range && ptr !== '') {
        const mark = h('mark', { class: 'hl' }, t.slice(range.s, range.e));
        flat.append(t.slice(0, range.s), mark, t.slice(range.e));
        if (scroll) ensureVisible(rawBody, mark, 24);
      } else {
        flat.append(t);
      }
      return;
    }
    if (!range || ptr === '') return;
    const prefix = ptr + '/';
    let first = null;
    for (let li = range.l0; li <= range.l1 && li < rawModel.lineEls.length; li++) {
      const line = rawModel.lineEls[li];
      line.classList.add('hl-line');
      first ??= line;
      for (const sp of line.querySelectorAll('[data-p]')) {
        const p = sp.dataset.p;
        if (p === ptr || p.startsWith(prefix)) sp.classList.add('hl');
      }
    }
    if (scroll && first) ensureVisible(rawBody, first, 24);
  }

  rawBody.addEventListener('click', (e) => {
    const sp = e.target.closest('[data-p]');
    if (!sp || !detail) return;
    revealPointer(sp.dataset.p);
  });

  // ---------------------------------------------------------------------------
  // Initial state and workspace interface

  onView();
  loadSelected(selId);

  // ---------------------------------------------------------------------------
  // Follow (views/follow.js) takes over the lower region in place (§7.9): the Raw pane at a window of 1440 px or
  // more, so the call's Detail reads beside its stream, and the whole lower region below that. The list keeps its
  // height; the selected row is scrolled back into the middle.

  function placeFollow() {
    const open = bottom.classList.contains('follow-on');
    bottom.classList.toggle('follow-wide', open && window.innerWidth >= 1440);
    renderInsTabs();
    updateStacked();
    if (visible && open) {
      requestAnimationFrame(() => {
        list.resize();
        if (selIndex >= 0) list.scrollToIndex(selIndex, 'center');
      });
    }
  }
  window.addEventListener('agentshark:follow', (e) => {
    if (e.detail.host === bottom || !e.detail.open) placeFollow();
  });
  window.addEventListener('resize', debounce(placeFollow, 120));

  return {
    show() {
      visible = true;
      placeFollow();
      list.resize();
      if (revealOnShow && selIndex >= 0) list.scrollToIndex(selIndex, revealOnShow);
      revealOnShow = null;
      list.refresh();
      if (!locating) ensureVisiblePages();
      if (!stripCollapsed) refreshStrip();
      if (document.activeElement === document.body) scroller.focus({ preventScroll: true });
    },
    hide() {
      visible = false;
      // Another workspace shows Follow in the dock.
      placeFollow();
      clearTimeout(fetchTimer);
      for (const url of imageUrls.values()) URL.revokeObjectURL(url);
      imageUrls.clear();
    },
  };
}
