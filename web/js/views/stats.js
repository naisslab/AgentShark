// Statistics workspace (SPEC §7.5, §7.8, §12.7): Summary, Kinds, Tools (with SRT grouping), Models, Turns,
// Time, Endpoints, I/O Graph and Pairs. The view tabs follow the current view (filter + scope); without a
// ready view they show the view's loading or failed state and send no request, so statistics never fall
// back to the whole index. Turns and Time follow the session set and time range only, and say so.
// Drill-down narrows the filter with AND; Replace is an explicit menu choice.

import { createChart, fillSeries, formatValue } from '../lib/chart.js';
import { BUSY_LABEL, BUSY_ORDER, INTERVAL_LABEL, binTime, createPerfLanes, formatRate, formatShare } from '../lib/perfchart.js';
import { h, placeholder, autoTitle, showMenu, icon } from '../lib/dom.js';
import { agentLabel, formatBytes, formatClock, formatDuration, formatInt, formatPercent, formatTokens, formatUsd, plural, shortId, stampTitle, tzOffset } from '../lib/format.js';
import { combineFilter, COMBINE_MODES } from '../lib/scope.js';
import { TIME_BUCKET, endpointFilter, provKind, stepTimes, timeSegments } from '../lib/derived.js';
import { loadPref, savePref } from '../state.js';
import { provEl, impactChip, claimChip, tierChip } from './lens.js';
import { timeBar, BUCKET_COLOR } from './session.js';

/**
 * `scope: true`: the tab reads the session set and time range, not the view (it needs no ready view).
 * `derived: true`: only a schema-4 server answers it.
 */
const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'kinds', label: 'Kinds' },
  { id: 'tools', label: 'Tools' },
  { id: 'models', label: 'Models' },
  { id: 'performance', label: 'Performance' },
  { id: 'turns', label: 'Turns', scope: true },
  { id: 'time', label: 'Time', scope: true, derived: true },
  { id: 'endpoints', label: 'Endpoints', derived: true },
  { id: 'io', label: 'I/O Graph' },
  { id: 'pairs', label: 'Pairs' },
];

/** SRT groups of the Tools tab (SPEC §12.7): `tool` falls back to the SPEC §6 table on an older server. */
const SRT_GROUPS = [
  { id: 'tool', label: 'Tool', filter: (k) => `tool.name == ${quote(k)}` },
  { id: 'server', label: 'MCP server', filter: (k) => `tool.server == ${quote(k)}` },
  { id: 'program', label: 'Program' },
  { id: 'host', label: 'Web host' },
  { id: 'model', label: 'Model', filter: (k) => `llm.model == ${quote(k)}` },
];
const ENDPOINT_KINDS = [
  { id: '', label: 'All kinds' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'host', label: 'Web hosts' },
  { id: 'hook', label: 'Hooks' },
  { id: 'program', label: 'Programs' },
  { id: 'agent', label: 'Agent types' },
];
const TURN_LIMIT = 500;
const TIME_SESSIONS = 20;

/** IoMetric values from src/index/api.ts. */
const IO_METRICS = [
  { id: 'events', label: 'Events' },
  { id: 'errors', label: 'Errors', colorVar: '--err' },
  { id: 'tokens.input', label: 'Input tokens' },
  { id: 'tokens.output', label: 'Output tokens' },
  { id: 'tool.calls', label: 'Tool calls' },
  { id: 'llm.calls', label: 'Model calls' },
  { id: 'latency.mean', label: 'Mean model latency', unit: 'us' },
  { id: 'ttft.mean', label: 'Mean time to first token', unit: 'us', note: 'Only calls with a recorded or derived TTFT contribute. Missing timing leaves a gap.' },
  { id: 'output.rate.mean', label: 'Mean output tokens/s (end-to-end)', unit: 'tokens/s', mean: true, note: 'Mean of per-call output tokens ÷ whole call duration, grouped by call start. Includes waiting and estimated durations; this is not decode speed. Missing timing or token counts leave gaps.' },
  // DerivedIoMetric (schema-4 servers): peak context per bin and failure rows per tier.
  { id: 'context.tokens', label: 'Context tokens (peak)', derived: true, peak: true },
  { id: 'failures.failure', label: 'Failures', colorVar: '--err', derived: true },
  { id: 'failures.suspect', label: 'Suspect rows (upper bound)', derived: true },
  { id: 'failures.benign', label: 'Benign exits', derived: true },
  { id: 'failures.deferred', label: 'Deferred results', derived: true },
];

/** Interval label → bin width in µs (null lets the server choose). */
const INTERVALS = { auto: null, '1s': 1e6, '1m': 60e6, '5m': 300e6, '1h': 3600e6, '1d': 86400e6 };

const LAYERS = new Set(['session', 'user', 'llm', 'tool', 'agent', 'context', 'turn', 'hook', 'permission', 'harness', 'raw']);

/** The flexing first column of a fitted table stops claiming its 45% share at its maximum width (§4.4 SRT). */
const NAME_MAX = 320;

const formatTime = (t) => `${formatClock(t, { digits: 0 })} ${tzOffset(t)}`;
const NA = 'Not available: the agents did not log it and it cannot be derived';
/** Quote a value for the display filter language. */
const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const pct = (x) => formatPercent(x, x != null && x < 0.1 ? 2 : 1) || '—';
const exact = formatInt;

/** Horizontal share bar, `share` in [0, 1]. */
const bar = (share) => h('div', { class: 'pn-bar' }, h('span', { style: `width:${Math.max(0, Math.min(1, share || 0)) * 100}%` }));

/**
 * Dense table sorted by clicking a header. Columns: { key, label, num?, value(row), render?(row), title?, cls?, prio? }.
 * Nulls sort last in both directions. With `controls`, the first column flexes and columns hide by `prio` (P4
 * first, then P3, the rightmost first) while the table overflows or the first column is narrower than its share;
 * "n columns hidden" in `controls` brings one back (§4.4).
 */
function sortableTable(cols, rows, { sortKey, desc = true, onRow, onMenu, rowTitle, controls = null } = {}) {
  let key = sortKey ?? cols[0].key;
  let descending = desc;
  const thead = h('thead');
  const tbody = h('tbody');
  const table = h('table', { class: ['pn-table', onRow && 'is-clickable', controls && 'fit-cols'] }, thead, tbody);
  let hidden = new Set();
  const forced = new Set();
  const applyHidden = () => {
    cols.forEach((c, i) => {
      for (const tr of table.rows) if (tr.cells[i]) tr.cells[i].hidden = hidden.has(c.key);
    });
  };
  function paint() {
    thead.replaceChildren(
      h('tr', null, cols.map((c) =>
        h('th', { class: [c.num && 'num', c.cls], title: c.title ?? null, 'aria-sort': c.key === key ? (descending ? 'descending' : 'ascending') : null },
          h('button', {
            class: 'pn-sort',
            onclick: () => {
              if (key === c.key) descending = !descending;
              else {
                key = c.key;
                descending = !!c.num;
              }
              paint();
            },
          }, c.label, c.key === key ? (descending ? ' ▾' : ' ▴') : '')))),
    );
    const col = cols.find((c) => c.key === key) ?? cols[0];
    const sorted = rows.slice().sort((a, b) => {
      const x = col.value(a);
      const y = col.value(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return descending ? -r : r;
    });
    tbody.replaceChildren(...sorted.map((r) =>
      h('tr', {
        tabindex: onRow ? 0 : null,
        title: rowTitle?.(r) ?? null,
        onclick: onRow ? () => onRow(r) : null,
        oncontextmenu: onMenu ? (e) => {
          e.preventDefault();
          onMenu(r, { x: e.clientX, y: e.clientY });
        } : null,
        onkeydown: onRow ? (e) => {
          if (e.key === 'Enter') onRow(r);
          else if (onMenu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
            e.preventDefault();
            const b = e.currentTarget.getBoundingClientRect();
            onMenu(r, { x: b.left + 20, y: b.bottom });
          }
        } : null,
      }, cols.map((c) => {
        const content = c.render ? c.render(r) : (c.value(r) ?? '—');
        return h('td', { class: [c.num && 'num', c.cls], title: content === '—' ? NA : null }, content);
      }))));
    applyHidden();
  }
  paint();
  const wrap = h('div', { class: 'pn-table-wrap' }, table);
  if (!controls) return wrap;
  const more = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu', hidden: true });
  more.addEventListener('click', () => showMenu(more, cols.filter((c) => hidden.has(c.key)).map((c) => ({
    label: `Show ${c.label}`, onSelect: () => { forced.add(c.key); fit(); },
  })), { align: 'end' }));
  controls.append(more);
  const fit = () => {
    const width = wrap.clientWidth;
    if (!width) return;
    hidden = new Set();
    applyHidden();
    const share = Math.min(0.45 * width, NAME_MAX);
    const order = [4, 3].flatMap((p) => cols.filter((c) => c.prio === p && !forced.has(c.key)).reverse());
    for (const c of order) {
      if (table.scrollWidth <= width + 1 && (thead.rows[0]?.cells[0]?.offsetWidth ?? width) >= share) break;
      hidden.add(c.key);
      applyHidden();
    }
    more.hidden = !hidden.size;
    more.replaceChildren(`${plural(hidden.size, 'column')} hidden`, icon('down', 10));
  };
  let last = -1;
  new ResizeObserver(() => {
    if (!wrap.isConnected || wrap.clientWidth === last) return;
    last = wrap.clientWidth;
    fit();
  }).observe(wrap);
  return wrap;
}

const dur = (v) => formatDuration(v) || '—';
/** A key cell (tool, program, endpoint, model): capped with an ellipsis so the numbers stay in view; the full key is its tooltip. */
const keyCell = (text) => autoTitle(h('span', { class: 'st-key' }, text), text ?? '');
const num = (v) => (v == null ? '—' : h('span', { title: exact(v) }, formatTokens(v)));

// ---------------------------------------------------------------------------

export default function createStats(root, app) {
  root.classList.add('st-root');
  let active = loadPref('stats.tab', 'summary');
  if (!TABS.some((t) => t.id === active)) active = 'summary';
  let ioMetric = loadPref('stats.ioMetric', 'events');
  let ioInterval = loadPref('stats.ioInterval', 'auto');
  let toolsGroup = loadPref('stats.toolsGroup', 'tool');
  if (!SRT_GROUPS.some((g) => g.id === toolsGroup)) toolsGroup = 'tool';
  let endpointKind = loadPref('stats.endpointKind', '');
  let visible = false;
  /** Whether the server serves SRT grouping: null until a request tells (asked again on every show). */
  let srtServed = null;

  /** The right-click menu of a drill-down: every way to combine `expr` with the current filter. */
  const drillMenu = (expr, at) => showMenu(at, [
    { header: 'Apply as filter' },
    ...COMBINE_MODES.map((m) => ({ label: m.label, hint: m.hint, onSelect: () => app.narrowFilter(expr, m.id) })),
    { header: 'Prepare as filter' },
    ...COMBINE_MODES.map((m) => ({ label: m.label, onSelect: () => app.prepareFilter(expr, m.id) })),
  ]);

  const scopeLabel = h('div', { class: 'ws-scope st-scope' });
  const tabButtons = {};
  const panes = {};
  const loadedKey = {};
  const requestSeq = {};

  const tabs = h('div', { class: 'pn-tabs', role: 'tablist', 'aria-label': 'Statistics' }, TABS.map((t) => {
    tabButtons[t.id] = h('button', { class: 'pn-tab', role: 'tab', type: 'button', onclick: () => activate(t.id) }, t.label);
    return tabButtons[t.id];
  }));
  // The tab strip is one Tab stop; arrows move between tabs (§10.1).
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = TABS.findIndex((t) => t.id === active);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
    e.preventDefault();
    activate(next.id);
    tabButtons[next.id].focus();
  });
  const body = h('div', { class: 'st-body' });
  for (const t of TABS) {
    panes[t.id] = h('div', { class: `st-pane st-pane-${t.id}`, role: 'tabpanel', hidden: true });
    body.append(panes[t.id]);
  }
  root.append(h('div', { class: 'ws-head st-head' }, tabs, scopeLabel), body);

  // The I/O pane keeps its controls and chart between loads; only the data changes.
  const ioContent = h('div', { class: 'st-io-info' });
  const metricSel = h('select', { class: 'pn-select', 'aria-label': 'Metric' });
  /** Derived metrics are offered only by a schema-4 server. */
  const metricOptions = () => {
    const keep = metricSel.value || ioMetric;
    metricSel.replaceChildren(...IO_METRICS.filter((m) => !m.derived || app.api.features.derived).map((m) => h('option', { value: m.id }, m.label)));
    metricSel.value = IO_METRICS.some((m) => m.id === keep && (!m.derived || app.api.features.derived)) ? keep : 'events';
  };
  metricOptions();
  const intervalSel = h('select', { class: 'pn-select', 'aria-label': 'Interval' }, Object.keys(INTERVALS).map((k) => h('option', { value: k }, k)));
  intervalSel.value = ioInterval in INTERVALS ? ioInterval : 'auto';
  ioMetric = metricSel.value;
  ioInterval = intervalSel.value;
  metricSel.addEventListener('change', () => {
    ioMetric = metricSel.value;
    savePref('stats.ioMetric', ioMetric);
    load('io');
  });
  intervalSel.addEventListener('change', () => {
    ioInterval = intervalSel.value;
    savePref('stats.ioInterval', ioInterval);
    load('io');
  });
  const chartHost = h('div', { class: 'st-chart' });
  panes.io.append(
    h('div', { class: 'st-io-controls' },
      h('label', null, 'Metric ', metricSel),
      h('label', null, 'Interval ', intervalSel),
      h('span', { class: 'st-hint' }, 'Click a bin to set the time range to it.')),
    chartHost,
    ioContent,
  );
  const chart = createChart(chartHost, {
    fill: true,
    minHeight: 240,
    onClick: (bin, binUs) => app.setTimeRange(bin.t, bin.t + binUs),
  });

  app.state.subscribe(['view', 'viewLoading', 'viewError'], () => {
    updateScope();
    if (visible) load(active);
  });

  /** The ready view's id; null while the view loads or after it failed. */
  const viewId = () => {
    const vs = app.viewState();
    return vs.status === 'ready' || vs.status === 'ready-empty' ? vs.view.viewId : null;
  };

  function updateScope() {
    const vs = app.viewState();
    if (TABS.find((t) => t.id === active)?.scope) {
      // Turns and Time read the session set and time range only (SPEC §7.8: each tab states what it honors).
      const sc = app.state.get('scope');
      const sessions = sc.sessions?.length ? `${exact(sc.sessions.length)} session${sc.sessions.length === 1 ? '' : 's'}` : 'all sessions';
      scopeLabel.replaceChildren(h('b', null, sessions), `${active === 'turns' && (sc.from != null || sc.to != null) ? ' in the time range' : ''} · the display filter does not apply`);
      return;
    }
    // The filter is in the scope bar's field; the label names the population, its leading count in --fg 600.
    if (vs.status === 'failed') scopeLabel.replaceChildren(h('span', { class: 'st-err' }, 'Could not load this view; no statistics are shown'));
    else if (vs.status === 'loading') scopeLabel.replaceChildren(`Loading ${app.scopeText()}…`);
    else scopeLabel.replaceChildren(h('b', null, `${exact(vs.view.count)} events`), ` in the current view · ${app.scopeText()}`);
    autoTitle(scopeLabel, scopeLabel.textContent);
  }

  function activate(id) {
    active = id;
    savePref('stats.tab', id);
    updateScope();
    for (const t of TABS) {
      panes[t.id].hidden = t.id !== id;
      tabButtons[t.id].setAttribute('aria-selected', String(t.id === id));
      tabButtons[t.id].tabIndex = t.id === id ? 0 : -1;
      tabButtons[t.id].classList.toggle('is-active', t.id === id);
    }
    load(id);
  }

  /** Tools: SRT rows for the group, or the SPEC §6 table when the server serves no SRT (only for `tool`). */
  async function fetchTools() {
    const view = viewId();
    if (srtServed !== false && app.api.features.derived) {
      try {
        const res = await app.api.statsSrt(view, toolsGroup);
        srtServed = true;
        return { srt: res };
      } catch (err) {
        if (err.status !== 501 && err.status !== 400) throw err;
        srtServed = false;
      }
    }
    if (toolsGroup !== 'tool') return { unsupported: true };
    return { legacy: await app.api.stats('tools', { view }) };
  }

  /** Turns: the longest turn spans in the session set and time range (the display filter does not apply). */
  function fetchTurns() {
    const sc = app.state.get('scope');
    return app.api.spans({ sessions: sc.sessions ?? undefined, from: sc.from ?? undefined, to: sc.to ?? undefined, kinds: ['turn'], limit: TURN_LIMIT });
  }

  /** Time: GET /api/time per scoped session (at most TIME_SESSIONS); a 501 reports "not derived". */
  async function fetchTime() {
    const ids = (app.state.get('scope').sessions ?? []).slice(0, TIME_SESSIONS);
    if (!ids.length) return { ids, rows: [] };
    const rows = [];
    for (let i = 0; i < ids.length; i += 4) {
      // A 501 (not derived) fails the tab; a session the analysis does not know yet is a row of its own.
      rows.push(...await Promise.all(ids.slice(i, i + 4).map((session) => app.api.time({ session }).then((t) => ({ session, t }),
        (err) => (err.status === 501 ? Promise.reject(err) : { session, error: err })))));
    }
    return { ids, rows, more: (app.state.get('scope').sessions?.length ?? 0) - ids.length };
  }

  const FETCH = {
    summary: () => app.api.stats('summary', { view: viewId() }),
    kinds: () => app.api.stats('kinds', { view: viewId() }),
    tools: fetchTools,
    models: () => app.api.stats('models', { view: viewId() }),
    performance: () => app.api.stats('performance', { view: viewId() }),
    turns: fetchTurns,
    time: fetchTime,
    endpoints: () => app.api.statsEndpoints(viewId(), endpointKind || undefined),
    pairs: () => app.api.stats('pairs', { view: viewId() }),
    io: () => app.api.stats('io', { view: viewId(), metric: ioMetric, interval: INTERVALS[ioInterval] }),
  };

  const RENDER = { summary: renderSummary, kinds: renderKinds, tools: renderTools, models: renderModels, performance: renderPerformance, turns: renderTurns, time: renderTime, endpoints: renderEndpoints, pairs: renderPairs, io: renderIo };

  /** What a tab's data depends on besides the view: its own controls, or the scope for the scope tabs. */
  function extraKey(tab) {
    const sc = app.state.get('scope');
    if (tab === 'io') return `${ioMetric}|${ioInterval}`;
    if (tab === 'tools') return toolsGroup;
    if (tab === 'endpoints') return endpointKind;
    if (TABS.find((t) => t.id === tab)?.scope) return JSON.stringify([sc.sessions, sc.from, sc.to, app.state.get('indexVersion')]);
    return '';
  }

  async function load(tab) {
    const target = tab === 'io' ? ioContent : panes[tab];
    const vs = app.viewState();
    const scopeTab = !!TABS.find((t) => t.id === tab)?.scope;
    const id = scopeTab ? 'scope' : viewId();
    if (!id) {
      // No ready view: say why and request nothing, so no unscoped numbers can appear.
      loadedKey[tab] = null;
      requestSeq[tab] = (requestSeq[tab] ?? 0) + 1;
      if (tab === 'io') chart.setData(null);
      target.replaceChildren(vs.status === 'failed'
        ? placeholder('error', 'Could not load this view. Your selection is preserved.', vs.error?.message, { label: 'Retry', onClick: app.retryView })
        : placeholder('loading', `Loading ${app.scopeText()}…`));
      return;
    }
    if (TABS.find((t) => t.id === tab)?.derived && !app.api.features.derived) {
      loadedKey[tab] = null;
      target.replaceChildren(placeholder('empty', 'This statistic needs a newer AgentShark server', 'It reads the schema-4 analysis tables, which this server does not build. The other tabs still work.'));
      return;
    }
    const key = [id, extraKey(tab)].join('|');
    if (loadedKey[tab] === key) return;
    loadedKey[tab] = key;
    const seq = (requestSeq[tab] = (requestSeq[tab] ?? 0) + 1);
    if (tab === 'io') chartHost.classList.add('is-loading');
    if (tab === 'performance') {
      perfLanes?.destroy();
      perfLanes = null;
    }
    target.replaceChildren(placeholder('loading', 'Loading…'));
    try {
      const data = await FETCH[tab]();
      if (seq !== requestSeq[tab]) return;
      target.replaceChildren();
      RENDER[tab](target, data ?? {});
    } catch (err) {
      if (seq !== requestSeq[tab]) return;
      loadedKey[tab] = null;
      if (app.handleViewError(err)) {
        target.replaceChildren(placeholder('loading', 'The view expired on the server; rebuilding it…'));
        return;
      }
      // 501, or a 400 for a derived I/O metric (DerivedIoMetric), means this build does not serve it yet.
      const unserved = err?.status === 501 || (tab === 'io' && err?.status === 400 && IO_METRICS.find((m) => m.id === ioMetric)?.derived);
      target.replaceChildren(unserved
        ? placeholder('empty', 'Not derived by this server yet', 'This AgentShark build does not serve this statistic yet. The other tabs and metrics still work.')
        : placeholder('error', 'Could not load these statistics. Your selection is preserved.', String(err?.message ?? err), { label: 'Retry', onClick: () => load(tab) }));
      if (tab === 'io') chart.setData(null);
    } finally {
      if (seq === requestSeq[tab] && tab === 'io') chartHost.classList.remove('is-loading');
    }
  }

  // ---- Summary

  function tile(label, value, title, kind = '') {
    return h('div', { class: `st-tile${kind ? ` is-${kind}` : ''}`, title: title ?? null }, h('div', { class: 'st-tile-v' }, value), h('div', { class: 'st-tile-k' }, label));
  }

  function renderSummary(el, d) {
    if (!d.events) {
      el.append(placeholder('empty', 'No events match this filter and scope', 'Statistics follow the current view.', [
        app.state.get('filter') ? { label: 'Clear filter', onClick: () => app.setFilter('') } : null,
        app.state.get('scope').from != null || app.state.get('scope').to != null ? { label: 'Widen range', onClick: () => app.setTimeRange(null, null) } : null,
      ]));
      return;
    }
    const span = d.firstTs != null && d.lastTs != null ? d.lastTs - d.firstTs : null;
    el.append(h('div', { class: 'st-tiles' },
      tile('Events', formatTokens(d.events), exact(d.events)),
      tile('Sessions', formatTokens(d.sessions), exact(d.sessions)),
      tile('Model calls', formatTokens(d.llmCalls), exact(d.llmCalls)),
      tile('Tool calls', formatTokens(d.toolCalls), exact(d.toolCalls)),
      tile('Errors', formatTokens(d.errors), exact(d.errors), d.errors > 0 ? 'err' : ''),
      tile('Time span', span != null ? formatDuration(span) : '—', span != null ? `${stampTitle(d.firstTs, 0)}\n→ ${stampTitle(d.lastTs, 0)}` : NA),
      d.loggedCostUsd != null
        ? tile('Logged cost', formatUsd(d.loggedCostUsd), 'Sum of the costs the agents logged. AgentShark does not estimate prices.')
        : tile('Logged cost', '—', 'Not available: none of these agents logged a cost, and AgentShark does not estimate prices.'),
    ));

    const t = d.tokens ?? {};
    const tokenRows = [
      ['Input (all prompt tokens)', t.input],
      ['Uncached input', t.uncached],
      ['Cache read', t.cache_read],
      ['Cache write', t.cache_write],
      ['Output', t.output],
      ['Reasoning (part of output)', t.reasoning],
    ].filter(([, v]) => v != null);
    const cacheHit = t.input ? (t.cache_read ?? 0) / t.input : null;
    const maxTok = Math.max(1, ...tokenRows.map(([, v]) => v));
    el.append(h('div', { class: 'st-grid2' },
      h('section', { class: 'st-section' },
        h('h3', null, 'Tokens'),
        tokenRows.length
          ? h('table', { class: 'pn-table' }, h('tbody', null,
            tokenRows.map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'num' }, num(v)), h('td', { class: 'st-barcell' }, bar(v / maxTok)))),
            h('tr', null, h('td', null, 'Cache hit ratio'), h('td', { class: 'num' }, t.input ? share(t.cache_read ?? 0, t.input, 'input tokens read from the cache') : '—'), h('td', { class: 'st-barcell' }, bar(cacheHit ?? 0)))))
          : placeholder('empty', 'No token usage logged in this view')),
      h('section', { class: 'st-section' },
        h('h3', null, 'By agent'),
        sortableTable([
          { key: 'agent', label: 'Agent', value: (r) => agentLabel(r.agent) },
          { key: 'sessions', label: 'Sessions', num: true, value: (r) => r.sessions, render: (r) => num(r.sessions) },
          { key: 'events', label: 'Events', num: true, value: (r) => r.events, render: (r) => num(r.events) },
          { key: 'share', label: 'Share', value: (r) => r.events, render: (r) => bar(r.events / d.events) },
        ], d.byAgent ?? [], { sortKey: 'events' })),
    ));
  }

  // ---- Kinds

  const expandedKinds = new Set();

  function filterForKind(name) {
    if (name.includes('/')) return `proto == ${quote(name)}`;
    if (LAYERS.has(name)) return name;
    return `kind == ${quote(name)}`;
  }

  function renderKinds(el, d) {
    const tree = Array.isArray(d.tree) ? d.tree : [];
    if (!tree.length) {
      el.append(placeholder('empty', 'No events in this view'));
      return;
    }
    const total = tree.reduce((a, n) => a + (n.count ?? 0), 0) || 1;
    const tbody = h('tbody');
    const paint = () => {
      const rows = [];
      const walk = (nodes, depth, prefix) => {
        for (const n of nodes.slice().sort((a, b) => b.count - a.count)) {
          const path = `${prefix}/${n.name}`;
          const kids = Array.isArray(n.children) ? n.children : [];
          const open = expandedKinds.has(path);
          rows.push(h('tr', null,
            h('td', { class: 'st-kind', style: `padding-left:${4 + depth * 16}px` },
              kids.length
                ? h('button', {
                  class: 'st-twisty',
                  'aria-expanded': String(open),
                  'aria-label': open ? 'Collapse' : 'Expand',
                  onclick: () => {
                    if (open) expandedKinds.delete(path);
                    else expandedKinds.add(path);
                    paint();
                  },
                }, open ? '▾' : '▸')
                : h('span', { class: 'st-twisty' }),
              h('span', { class: 'st-kind-name' }, n.name)),
            h('td', { class: 'num' }, num(n.count)),
            h('td', { class: 'num' }, pct(n.count / total)),
            h('td', { class: 'st-barcell' }, bar(n.count / total)),
            h('td', { class: 'num', title: exact(n.bytes) }, formatBytes(n.bytes) || '—'),
            h('td', null, h('button', {
              class: 'btn pn-sm',
              title: `Narrow the filter with ${filterForKind(n.name)} (right-click for other ways)`,
              onclick: () => app.narrowFilter(filterForKind(n.name)),
              oncontextmenu: (e) => {
                e.preventDefault();
                drillMenu(filterForKind(n.name), { x: e.clientX, y: e.clientY });
              },
            }, 'Filter'))));
          if (open) walk(kids, depth + 1, path);
        }
      };
      walk(tree, 0, '');
      tbody.replaceChildren(...rows);
    };
    const setAll = (open) => {
      expandedKinds.clear();
      if (open) {
        const add = (nodes, prefix) => nodes.forEach((n) => {
          if (n.children?.length) {
            expandedKinds.add(`${prefix}/${n.name}`);
            add(n.children, `${prefix}/${n.name}`);
          }
        });
        add(tree, '');
      }
      paint();
    };
    paint();
    el.append(
      h('div', { class: 'st-actions' },
        h('button', { class: 'btn pn-sm', onclick: () => setAll(true) }, 'Expand all'),
        h('button', { class: 'btn pn-sm', onclick: () => setAll(false) }, 'Collapse all'),
        h('span', { class: 'st-hint' }, 'Bytes are the size of the source records.')),
      h('div', { class: 'pn-table-wrap' },
        h('table', { class: 'pn-table st-kinds' },
          h('thead', null, h('tr', null,
            h('th', null, 'Layer / kind / protocol'), h('th', { class: 'num' }, 'Events'), h('th', { class: 'num' }, '%'),
            h('th', null, ''), h('th', { class: 'num' }, 'Bytes'), h('th', null, ''))),
          tbody)),
    );
  }

  // ---- Tools, Models, Pairs

  /** Failures by tier: the failure count, then suspect rows as an upper bound; every tier in the tooltip. */
  const FAIL_TITLE = 'Failed calls; "+14≈" adds the suspect rows, an upper bound';
  /** Failures (§4.4): "118" in --err, then "+34≈" for the suspect rows, the mark after the count (§3.3). */
  function tierCell(f) {
    if (!f) return '—';
    return h('span', null, f.failure ? h('span', { class: 'st-err' }, exact(f.failure)) : '0', f.suspect ? h('span', { class: 'st-hint' }, ` +${exact(f.suspect)}≈`) : null);
  }
  /** A share with its denominator in the tooltip (§9 Rates and shares). */
  const share = (k, n, unit) => (n ? h('span', { title: `${exact(k)} of ${exact(n)} ${unit}` }, pct(k / n)) : '—');

  /** "75% logged · 25% ≈ derived": the duration sources of a row, by provenance kind; null when none. */
  function srcMixText(mix) {
    const groups = {};
    let total = 0;
    for (const [src, n] of Object.entries(mix ?? {})) {
      const k = provKind(src) ?? 'unknown';
      groups[k] = (groups[k] ?? 0) + n;
      total += n;
    }
    if (!total) return null;
    const mark = { logged: '', derived: '≈ ', parsed: '~ ', inferred: '? ', unknown: '' };
    const order = ['logged', 'derived', 'parsed', 'inferred', 'unknown'];
    const kinds = order.filter((k) => groups[k]);
    // One source needs no share: "≈ derived" rather than "100% ≈ derived". A mix never rounds a part to 0% or 100%.
    const share = (n) => {
      const x = (n / total) * 100;
      return x < 1 ? '<1' : x > 99 ? '>99' : String(Math.round(x));
    };
    return kinds.map((k) => `${kinds.length > 1 ? `${share(groups[k])}% ` : ''}${mark[k]}${k === 'unknown' ? 'not timed' : k}`).join(' · ');
  }

  /** The words for a duration source every row shares ("≈ derived" → "≈ derived from timestamps"). */
  const ONE_SOURCE = { logged: 'logged by the agent', '≈ derived': '≈ derived from timestamps', '~ parsed': '~ parsed from the output', '? inferred': '? inferred' };

  /** Known durations (§4.4): "73 of 73", the calls with a known duration of all calls. */
  const coverage = (known, calls) => (calls ? `${exact(known)} of ${exact(calls)}` : '—');

  function renderTools(el, d) {
    const groupSel = h('select', { class: 'pn-select', 'aria-label': 'Group by' }, SRT_GROUPS.map((g) => h('option', { value: g.id }, g.label)));
    groupSel.value = toolsGroup;
    groupSel.addEventListener('change', () => {
      toolsGroup = groupSel.value;
      savePref('stats.toolsGroup', toolsGroup);
      load('tools');
    });
    const group = SRT_GROUPS.find((g) => g.id === toolsGroup);
    const hint = h('span', { class: 'st-hint' });
    const actions = h('div', { class: 'st-actions' }, h('label', null, 'Group by ', groupSel), hint);
    el.append(actions);
    requestAnimationFrame(() => autoTitle(hint, hint.textContent));
    if (d.unsupported) {
      el.append(placeholder('empty', `Grouping by ${group.label.toLowerCase()} is not served by this server yet`, 'This AgentShark build only groups by tool name.', { label: 'Group by Tool', onClick: () => { groupSel.value = 'tool'; groupSel.dispatchEvent(new Event('change')); } }));
      return;
    }
    if (d.legacy) return renderLegacyTools(el, d.legacy);
    const rows = d.srt?.rows ?? [];
    if (!rows.length) {
      el.append(placeholder('empty', `No ${group.label.toLowerCase()} calls in this view`));
      return;
    }
    const drill = group.filter ?? null;
    // One header note states the duration source and the suspect bound (§7.13).
    const mixes = new Set(rows.map((r) => srcMixText(r.durSrcMix)));
    const oneSource = mixes.size === 1 ? [...mixes][0] : null;
    hint.textContent = [
      `Durations are ${oneSource ? ONE_SOURCE[oneSource] ?? oneSource : 'logged by the agent where it wrote them, else ≈ derived from timestamps'}; percentiles use only the calls with a known duration.`,
      'Suspect rows (+n≈) are an upper bound.',
    ].join(' ');
    el.append(sortableTable([
      { key: 'key', label: group.label, value: (r) => r.key, render: (r) => keyCell(r.key) },
      { key: 'calls', label: 'Calls', num: true, value: (r) => r.calls, render: (r) => num(r.calls) },
      { key: 'fail', label: 'Failures', num: true, title: FAIL_TITLE, value: (r) => r.failures?.failure ?? 0, render: (r) => tierCell(r.failures) },
      { key: 'rate', label: 'Fail %', num: true, value: (r) => (r.calls ? (r.failures?.failure ?? 0) / r.calls : null), render: (r) => share(r.failures?.failure ?? 0, r.calls, 'calls') },
      { key: 'p50', label: 'p50', num: true, value: (r) => r.p50, render: (r) => dur(r.p50) },
      { key: 'p90', label: 'p90', num: true, value: (r) => r.p90, render: (r) => dur(r.p90) },
      { key: 'p99', label: 'p99', num: true, prio: 3, value: (r) => r.p99, render: (r) => dur(r.p99) },
      { key: 'max', label: 'Max', num: true, prio: 4, value: (r) => r.max, render: (r) => dur(r.max) },
      { key: 'cov', label: 'Known durations', num: true, prio: 3, title: 'Calls with a known duration, of all calls; the percentiles use only these', value: (r) => (r.calls ? r.durKnown / r.calls : null), render: (r) => coverage(r.durKnown, r.calls) },
      { key: 'total', label: 'Total time', num: true, value: (r) => (r.durKnown ? r.total : null), render: (r) => (r.durKnown ? dur(r.total) : '—') },
      { key: 'agents', label: 'Agents', prio: 3, value: (r) => (r.agents ?? []).map(agentLabel).join(', '), render: (r) => keyCell((r.agents ?? []).map(agentLabel).join(', ')) },
    ].filter(Boolean), rows, {
      controls: actions,
      sortKey: 'calls',
      onRow: drill ? (r) => app.narrowFilter(drill(r.key)) : null,
      onMenu: drill ? (r, at) => drillMenu(drill(r.key), at) : null,
      rowTitle: drill ? (r) => `Narrow the filter to ${combineFilter(app.state.get('filter'), drill(r.key))}` : (r) => `${r.key}: no filter field names this ${group.label.toLowerCase()} exactly`,
    }), ...[gapNote(d.srt?.gaps)].filter(Boolean));
  }

  /** The SPEC §6 tools table, for a server that serves no SRT grouping. */
  function renderLegacyTools(el, d) {
    const tools = Array.isArray(d.tools) ? d.tools : [];
    if (!tools.length) {
      el.append(placeholder('empty', 'No tool calls in this view'));
      return;
    }
    el.append(
      h('div', { class: 'st-actions' }, h('span', { class: 'st-hint' }, 'Durations use logged values where the agent wrote them, otherwise the gap between call and result; percentiles cover only calls with a known duration. Click a row to narrow the filter to that tool; right-click to replace it instead.')),
      sortableTable([
        { key: 'tool', label: 'Tool', value: (r) => r.tool, render: (r) => [keyCell(r.tool), r.kind ? h('span', { class: 'pn-chip' }, r.kind) : null] },
        { key: 'calls', label: 'Calls', num: true, value: (r) => r.calls, render: (r) => num(r.calls) },
        { key: 'errors', label: 'Errors', num: true, value: (r) => r.errors, render: (r) => (r.errors ? h('span', { class: 'st-err' }, exact(r.errors)) : '0') },
        { key: 'rate', label: 'Error %', num: true, value: (r) => (r.calls ? r.errors / r.calls : null), render: (r) => pct(r.calls ? r.errors / r.calls : null) },
        ...(tools.some((r) => typeof (r.durKnown ?? r.withDur ?? r.durCount) === 'number')
          ? [{ key: 'cov', label: 'Timed', num: true, title: 'Calls with a known duration, of all calls; the percentiles use only these', value: (r) => r.durKnown ?? r.withDur ?? r.durCount ?? null, render: (r) => `${exact(r.durKnown ?? r.withDur ?? r.durCount)} / ${exact(r.calls)}` }]
          : []),
        { key: 'p50', label: 'p50', num: true, value: (r) => r.p50, render: (r) => dur(r.p50) },
        { key: 'p90', label: 'p90', num: true, value: (r) => r.p90, render: (r) => dur(r.p90) },
        { key: 'p99', label: 'p99', num: true, value: (r) => r.p99, render: (r) => dur(r.p99) },
        { key: 'max', label: 'Max', num: true, value: (r) => r.max, render: (r) => dur(r.max) },
        { key: 'total', label: 'Total time', num: true, value: (r) => r.total, render: (r) => (r.durKnown === 0 ? '—' : dur(r.total)) },
        { key: 'agents', label: 'Agents', value: (r) => (r.agents ?? []).map(agentLabel).join(', ') },
      ], tools, {
        sortKey: 'calls',
        onRow: (r) => app.narrowFilter(`tool.name == ${quote(r.tool)}`),
        onMenu: (r, at) => drillMenu(`tool.name == ${quote(r.tool)}`, at),
        rowTitle: (r) => `Narrow the filter to ${combineFilter(app.state.get('filter'), `tool.name == ${quote(r.tool)}`)}`,
      }),
    );
  }

  /** Data limits a derived answer states (SPEC §12.9), one line each; state gaps stay out of the way. */
  function gapNote(gaps) {
    const list = (gaps ?? []).filter((g) => g.limit != null || g.code === 'not-derived' || g.code === 'truncated');
    if (!list.length) return null;
    return h('ul', { class: 'st-gaps' }, list.map((g) => h('li', null, g.limit != null ? `Limit ${g.limit}: ` : '', g.message,
      g.field ? h('span', { class: 'st-hint' }, ` (${g.field})`) : null, g.count != null ? h('span', { class: 'st-hint' }, ` · ${exact(g.count)} left out`) : null)));
  }

  // ---- Turns: the longest turns, then the slowest steps and calls of the one picked (SPEC §12.8 W9)

  function renderTurns(el, d) {
    const spans = (d.spans ?? []).filter((sp) => sp.kind === 'turn');
    el.append(h('div', { class: 'st-actions' }, h('span', { class: 'st-hint' },
      `Turns in the session set and time range, longest first${d.truncated ? ` (the ${exact(TURN_LIMIT)} longest)` : ''}. The display filter does not apply. Pick a turn to see where its time went.`)));
    if (!spans.length) {
      el.append(placeholder('empty', 'No turns in this scope', 'Widen the time range or pick other sessions.'));
      return;
    }
    const detail = h('div', { class: 'st-turn-detail' }, placeholder('empty', 'Pick a turn', 'Its time buckets and its slowest steps and calls appear here.'));
    const table = sortableTable([
      { key: 'session', label: 'Session', value: (r) => app.sessionById(r.session)?.title ?? r.session, render: (r) => h('span', { title: r.session }, app.sessionById(r.session)?.title || shortId(r.session, 14)) },
      { key: 'prompt', label: 'Turn', value: (r) => r.name ?? '', render: (r) => h('span', { class: 'st-ellipsis', title: r.name ?? '' }, r.name || h('span', { class: 'st-hint' }, '(no prompt)')) },
      { key: 'start', label: 'Start', num: true, value: (r) => r.start, render: (r) => h('span', { title: stampTitle(r.start) }, formatClock(r.start, { digits: 0 })) },
      { key: 'dur', label: 'Wall', num: true, value: (r) => r.dur, render: (r) => (r.dur != null ? h('span', null, dur(r.dur), provEl(app, r.durSrc)) : '—') },
      { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => (r.status === 'open' ? h('span', { class: 'st-hint' }, 'open') : r.status ?? '—') },
    ], spans, { sortKey: 'dur', onRow: (r) => showTurn(detail, r) });
    table.addEventListener('click', (e) => {
      const tr = e.target.closest('tbody tr');
      if (!tr) return;
      for (const x of table.querySelectorAll('tr.is-selected')) x.classList.remove('is-selected');
      tr.classList.add('is-selected');
    });
    el.append(h('div', { class: 'st-turns' }, table, detail));
  }

  async function showTurn(el, sp) {
    if (!app.api.features.derived) {
      el.replaceChildren(placeholder('empty', 'Steps and time buckets need a newer AgentShark server', 'This server does not build the schema-4 analysis tables.',
        { label: 'Show the turn in Events', onClick: () => app.showFilterInEvents(`turn == ${quote(sp.id)}`) }));
      return;
    }
    el.replaceChildren(placeholder('loading', 'Loading the turn…'));
    try {
      // Slowest by active time (model + tool): wall time runs to the next step and would rank idle gaps. A server
      // that cannot sort by active time gives its 50 longest by wall time, ranked here.
      const q = { turn: sp.id, order: 'desc', descendants: false };
      const page = await app.api.sessionSteps(sp.session, { ...q, sort: 'active', limit: 10 }).catch((err) => {
        if (err.status !== 400) throw err;
        return app.api.sessionSteps(sp.session, { ...q, sort: 'dur', limit: 50 }).then((p) => p && {
          ...p, steps: p.steps.slice().sort((a, b) => (stepTimes(b).active ?? -1) - (stepTimes(a).active ?? -1)).slice(0, 10),
        });
      });
      const t = page?.turns?.find((x) => x.id === sp.id) ?? null;
      const steps = page?.steps ?? [];
      const segs = t ? timeSegments({ buckets: t.buckets ?? [], unattributedUs: t.unattributedUs ?? 0, wallUs: t.wallUs }) : [];
      el.replaceChildren(
        h('div', { class: 'st-actions' },
          h('strong', null, `T${t?.n ?? '?'}`), t ? impactChip(t.impact) : null, t?.claim ? claimChip(app, t.claim) : null,
          h('span', { class: 'st-ellipsis', title: sp.name ?? '' }, sp.name ?? ''),
          h('button', { class: 'btn pn-sm', onclick: () => app.showSession(sp.session, { turnId: sp.id }) }, 'Show in Session')),
        segs.length
          ? h('div', { class: 'st-actions' }, h('span', { class: 'st-hint' }, `Wall ${t.wallUs != null ? formatDuration(t.wallUs) : '—'}`), timeBar(segs), bucketLegend(segs))
          : h('p', { class: 'st-hint' }, t?.unattributedUs == null ? 'Time buckets are not derived by this server yet.' : 'No time was attributed in this turn.'),
        steps.length
          ? sortableTable([
            { key: 'n', label: 'Step', num: true, value: (s) => s.n },
            { key: 'intent', label: 'Intent', value: (s) => s.intent ?? '', render: (s) => [s.intent ?? h('span', { class: 'st-hint' }, 'not logged'), provEl(app, s.intentSrc)] },
            { key: 'active', label: 'Active', num: true, title: 'Model + tool time', value: (s) => stepTimes(s).active, render: (s) => dur(stepTimes(s).active) },
            { key: 'gap', label: 'Gap', num: true, title: 'Wall time the model and tools did not use, mostly idle before the next step', value: (s) => stepTimes(s).gap, render: (s) => dur(stepTimes(s).gap) },
            { key: 'model', label: 'Model', num: true, value: (s) => s.modelUs, render: (s) => (s.modelUs != null ? [dur(s.modelUs), provEl(app, s.modelSrc)] : '—') },
            { key: 'call', label: 'Slowest call', value: (s) => slowest(s)?.durUs ?? null, render: (s) => slowestCall(s) },
          ], steps, { sortKey: 'active', onRow: (s) => app.showSession(s.sessionId, { stepId: s.id, turnId: s.turnId }) })
          : h('p', { class: 'st-hint' }, 'The turn has no steps in the index.'));
    } catch (err) {
      el.replaceChildren(placeholder('error', 'Could not load this turn', err.status === 404 ? 'The session is not in the analysis yet.' : err.message, { label: 'Retry', onClick: () => showTurn(el, sp) }));
    }
  }

  const slowest = (s) => (s.calls ?? []).reduce((m, c) => (c.durUs != null && (!m || c.durUs > m.durUs) ? c : m), null);
  function slowestCall(s) {
    const c = slowest(s);
    if (!c) return h('span', { class: 'st-hint' }, s.calls?.length ? 'durations unknown' : 'no calls');
    return h('button', {
      class: 'btn pn-sm st-call', title: `${c.tool ?? 'call'} ${c.target ?? ''}\nShow this call`,
      onclick: (e) => {
        e.stopPropagation();
        app.selectEvent(c.eventId);
      },
    }, `${c.tool ?? 'call'} `, h('span', { class: 'st-mono' }, dur(c.durUs)), provEl(app, c.durSrc), tierChip(c.tier));
  }

  function bucketLegend(segs) {
    return h('span', { class: 'st-hint' }, segs.slice().sort((a, b) => b.us - a.us).slice(0, 3).map((x) => `${TIME_BUCKET[x.name] ?? x.name} ${formatDuration(x.us)}`).join(' · '));
  }

  // ---- Time: wall time by bucket per session (SPEC §12.3.9)

  function renderTime(el, d) {
    el.append(h('div', { class: 'st-actions' }, h('span', { class: 'st-hint' },
      'Wall time of whole sessions split by bucket, in priority order; derived parts are hatched. Time no bucket claims is unattributed and never counted as model time. The time range and the display filter do not apply.')));
    if (!d.ids?.length) {
      const ev = app.state.get('selectedDetail')?.event?.session ?? null;
      el.append(placeholder('empty', 'Time accounting is per session', 'Pick sessions in the sidebar (they become the session set), or open one from Turns.',
        ev ? { label: 'Use the selected event’s session', onClick: () => app.setSessions(ev) } : null));
      return;
    }
    const ok = d.rows.filter((r) => r.t);
    const total = new Map();
    let unattributed = 0;
    let wall = 0;
    let humanGap = null;
    let continuation = null;
    for (const { t } of ok) {
      wall += t.wallUs ?? 0;
      if (t.unattributedUs != null) unattributed += t.unattributedUs;
      if (t.humanGapUs != null) humanGap = (humanGap ?? 0) + t.humanGapUs;
      if (t.continuationUs != null) continuation = (continuation ?? 0) + t.continuationUs;
      for (const b of t.buckets ?? []) {
        const m = total.get(b.name) ?? { name: b.name, us: 0, loggedUs: 0, derivedUs: 0 };
        m.us += b.us;
        m.loggedUs += b.loggedUs ?? 0;
        m.derivedUs += b.derivedUs ?? 0;
        total.set(b.name, m);
      }
    }
    const buckets = [...total.values()];
    const segs = timeSegments({ buckets, unattributedUs: unattributed, wallUs: wall });
    const share = (us) => (wall ? pct(us / wall) : '—');
    // A zero here is a measured zero (the bucket has no logged or no derived part), shown as such.
    const durz = (us) => (us === 0 ? '0 s' : dur(us));
    const swatch = (name) => h('span', { class: 'st-swatch', style: `background:${BUCKET_COLOR[name] ?? 'var(--fg-faint)'}` });
    el.append(h('section', { class: 'st-section' },
      h('h3', null, ok.length === 1 ? app.sessionById(ok[0].session)?.title || 'Session' : `${exact(ok.length)} sessions`),
      segs.length ? h('div', { class: 'st-actions' }, h('span', { class: 'st-hint' }, `Wall ${formatDuration(wall)}`), timeBar(segs)) : null,
      h('table', { class: 'pn-table st-time' },
        h('thead', null, h('tr', null, h('th', null, 'Bucket'), h('th', { class: 'num' }, 'Time'), h('th', { class: 'num' }, 'Share'), h('th', { class: 'num', title: 'Measured from logged durations' }, 'Logged'), h('th', { class: 'num', title: 'Derived from timestamp gaps (hatched)' }, '≈ Derived'))),
        h('tbody', null,
          buckets.map((b) => h('tr', null, h('td', null, swatch(b.name), TIME_BUCKET[b.name] ?? b.name), h('td', { class: 'num' }, durz(b.us)), h('td', { class: 'num' }, share(b.us)), h('td', { class: 'num' }, durz(b.loggedUs)), h('td', { class: 'num' }, durz(b.derivedUs)))),
          h('tr', { class: 'st-unattributed' }, h('td', null, swatch('unattributed'), 'unattributed (never counted as model time)'), h('td', { class: 'num' }, durz(unattributed)), h('td', { class: 'num' }, share(unattributed)), h('td', { class: 'num' }, '—'), h('td', { class: 'num' }, '—')))),
      h('p', { class: 'st-hint' }, `Between turns: ${humanGap != null ? `${durz(humanGap)} waiting for a human prompt` : 'human wait not measured'} · ${continuation != null ? `${durz(continuation)} before auto-continued turns` : 'continuations not measured'}.`),
      gapNote([...new Map(ok.flatMap(({ t }) => t.gaps ?? []).map((g) => [`${g.code}|${g.field ?? ''}`, g])).values()])));
    if (d.rows.length > 1 || d.more > 0 || d.rows.some((r) => r.error)) {
      el.append(h('section', { class: 'st-section' }, h('h3', null, 'Per session'),
        h('table', { class: 'pn-table' }, h('tbody', null, d.rows.map((r) => h('tr', null,
          h('td', null, h('button', { class: 'tl-link st-link', title: r.session, onclick: () => app.showSession(r.session) }, app.sessionById(r.session)?.title || shortId(r.session, 14))),
          r.t
            ? [h('td', { class: 'num' }, dur(r.t.wallUs)), h('td', null, timeBar(timeSegments({ buckets: r.t.buckets ?? [], unattributedUs: r.t.unattributedUs ?? 0, wallUs: r.t.wallUs })))]
            : h('td', { colspan: '2', class: 'st-hint' }, r.error?.status === 404 ? 'not in the analysis yet' : `could not load: ${r.error?.message ?? ''}`))))),
        d.more > 0 ? h('p', { class: 'st-hint' }, `First ${exact(TIME_SESSIONS)} sessions of the set; ${exact(d.more)} more are left out.`) : null));
    }
  }

  // ---- Endpoints (Wireshark Statistics ▸ Endpoints): MCP servers, web hosts, hooks, programs, agent types

  function renderEndpoints(el, d) {
    const kindSel = h('select', { class: 'pn-select', 'aria-label': 'Endpoint kind' }, ENDPOINT_KINDS.map((k) => h('option', { value: k.id }, k.label)));
    kindSel.value = endpointKind;
    kindSel.addEventListener('change', () => {
      endpointKind = kindSel.value;
      savePref('stats.endpointKind', endpointKind);
      load('endpoints');
    });
    el.append(h('div', { class: 'st-actions' }, h('label', null, 'Kind ', kindSel),
      h('span', { class: 'st-hint' }, 'Who the agents talked to. Click an MCP server, hook or agent type to narrow the filter; programs and hosts have no exact filter field.')));
    const rows = d.rows ?? [];
    if (!rows.length) {
      el.append(placeholder('empty', 'No endpoints in this view'));
      return;
    }
    el.append(sortableTable([
      { key: 'kind', label: 'Kind', value: (r) => r.kind, render: (r) => h('span', { class: 'pn-chip' }, ENDPOINT_KINDS.find((k) => k.id === r.kind)?.label.replace(/s$/, '') ?? r.kind) },
      { key: 'endpoint', label: 'Endpoint', value: (r) => r.endpoint, render: (r) => keyCell(r.endpoint) },
      { key: 'calls', label: 'Calls', num: true, value: (r) => r.calls, render: (r) => num(r.calls) },
      { key: 'sessions', label: 'Sessions', num: true, value: (r) => r.sessions, render: (r) => num(r.sessions) },
      { key: 'fail', label: 'Failures', num: true, title: FAIL_TITLE, value: (r) => r.failures?.failure ?? 0, render: (r) => tierCell(r.failures) },
      { key: 'rate', label: 'Fail %', num: true, value: (r) => (r.calls ? (r.failures?.failure ?? 0) / r.calls : null), render: (r) => pct(r.calls ? (r.failures?.failure ?? 0) / r.calls : null) },
      { key: 'cov', label: 'Timed', num: true, value: (r) => (r.calls ? r.durKnown / r.calls : null), render: (r) => coverage(r.durKnown, r.calls) },
      { key: 'p50', label: 'p50', num: true, value: (r) => r.p50, render: (r) => dur(r.p50) },
      { key: 'p90', label: 'p90', num: true, value: (r) => r.p90, render: (r) => dur(r.p90) },
      { key: 'p99', label: 'p99', num: true, value: (r) => r.p99, render: (r) => dur(r.p99) },
      { key: 'last', label: 'Last seen', num: true, value: (r) => r.lastTs, render: (r) => (r.lastTs != null ? h('span', { title: `${stampTitle(r.firstTs)} → ${stampTitle(r.lastTs)}` }, formatClock(r.lastTs, { digits: 0 })) : '—') },
    ], rows, {
      sortKey: 'calls',
      onRow: (r) => {
        const f = endpointFilter(r);
        if (f) app.narrowFilter(f);
        else app.toast(`No filter field names ${r.kind === 'program' ? 'a program' : 'a web host'} exactly.`, 'info');
      },
      onMenu: (r, at) => {
        const f = endpointFilter(r);
        if (f) drillMenu(f, at);
      },
      rowTitle: (r) => (endpointFilter(r) ? `Narrow the filter to ${combineFilter(app.state.get('filter'), endpointFilter(r))}` : null),
    }), ...[gapNote(d.gaps)].filter(Boolean));
  }

  function renderModels(el, d) {
    const models = Array.isArray(d.models) ? d.models : [];
    if (!models.length) {
      el.append(placeholder('empty', 'No model calls in this view'));
      return;
    }
    const tok = (k) => ({ num: true, value: (r) => r.tokens?.[k] ?? null, render: (r) => num(r.tokens?.[k] ?? null) });
    el.append(
      h('div', { class: 'st-actions' }, h('span', { class: 'st-hint' }, 'Input counts every prompt token, cached or not. Latency is shown only where the agent logged it or it could be derived; — means not available. Click a row to narrow the filter to that model; right-click to replace it instead.')),
      sortableTable([
        { key: 'model', label: 'Model', value: (r) => r.model, render: (r) => keyCell(r.model) },
        { key: 'calls', label: 'Calls', num: true, value: (r) => r.calls, render: (r) => num(r.calls) },
        { key: 'in', label: 'Input', ...tok('input') },
        { key: 'out', label: 'Output', ...tok('output') },
        { key: 'cr', label: 'Cache read', ...tok('cache_read') },
        { key: 'cw', label: 'Cache write', ...tok('cache_write') },
        { key: 'hit', label: 'Cache hit', num: true, value: (r) => r.cacheHitRatio, render: (r) => pct(r.cacheHitRatio), title: 'Cache read ÷ input tokens' },
        { key: 'l50', label: 'Latency p50', num: true, value: (r) => r.latencyP50, render: (r) => dur(r.latencyP50) },
        { key: 'l90', label: 'Latency p90', num: true, value: (r) => r.latencyP90, render: (r) => dur(r.latencyP90) },
      ], models, {
        sortKey: 'calls',
        onRow: (r) => app.narrowFilter(`llm.model == ${quote(r.model)}`),
        onMenu: (r, at) => drillMenu(`llm.model == ${quote(r.model)}`, at),
        rowTitle: (r) => `Narrow the filter to ${combineFilter(app.state.get('filter'), `llm.model == ${quote(r.model)}`)}`,
      }),
    );
  }

  // ---- Performance (SPEC §6): headline figures, the lanes over time, the slowest intervals, then the models

  /** The time ranges the lanes zoomed from, newest last; Zoom Out restores them. */
  const zoomStack = [];
  let perfLanes = null;
  const rateText = (v) => (v == null ? '—' : formatValue(v, 'tokens/s'));

  function zoomTo(from, to) {
    const sc = app.state.get('scope');
    zoomStack.push({ prev: { from: sc.from ?? null, to: sc.to ?? null }, next: { from, to } });
    app.setTimeRange(from, to);
  }

  /** Back to the range before the last zoom; with no zoom of ours on record, the whole time. */
  function zoomOut() {
    const sc = app.state.get('scope');
    const top = zoomStack.pop();
    if (top && top.next.from === sc.from && top.next.to === sc.to) app.setTimeRange(top.prev.from, top.prev.to);
    else {
      zoomStack.length = 0;
      app.setTimeRange(null, null);
    }
  }

  /** Open an interval in Timeline: its session and padded interval, its span and event selected. */
  function openInterval(r) {
    const pad = Math.max(1e6, Math.round(r.duration * 0.1));
    app.setSessions(r.sessionId);
    app.setTimeRange(r.start - pad, r.start + r.duration + pad);
    app.state.set({ selectedSpan: r.spanId });
    app.selectEvent(r.eventId, { reveal: false });
    app.switchWorkspace('timeline');
  }

  function renderPerformance(el, d) {
    perfLanes?.destroy();
    perfLanes = null;
    const models = Array.isArray(d.models) ? d.models : [];
    const rows = (d.bottlenecks ?? []).slice().sort((a, b) => b.duration - a.duration || a.start - b.start || a.spanId.localeCompare(b.spanId));
    const timeline = d.timeline?.bins?.length ? d.timeline : null;
    if (!models.length && !rows.length && !timeline) {
      el.append(placeholder('empty', 'No timed calls or waits in this view', 'Performance follows the current view.',
        app.state.get('scope').from != null ? { label: 'Zoom Out', onClick: zoomOut } : null));
      return;
    }
    if (d.overall) el.append(renderFigures(d.overall, timeline));
    if (timeline) renderOverTime(el, timeline, rows);
    el.append(renderBottlenecks(rows), renderModelCompare(models));
  }

  /** Headline figures over every call of the view; each opens its lane. */
  function renderFigures(o, timeline) {
    const bins = timeline?.bins ?? [];
    const tools = bins.reduce((a, b) => a + (b.tools ?? 0), 0);
    const busy = Object.values(timeline?.busy ?? {}).reduce((a, b) => a + b, 0);
    const of = (k) => `${exact(k)} of ${exact(o.calls)} calls`;
    const est = (n) => (n ? '≈' : '');
    const fig = (lane, label, value, sub, title) => h('button', {
      class: 'pf-fig', type: 'button', title: `${title}\nShow its lane in Over time.`, disabled: timeline ? null : true,
      onclick: () => perfLanes?.reveal(lane),
    }, h('span', { class: 'pf-fig-k' }, label), h('span', { class: 'pf-fig-v' }, value), h('span', { class: 'pf-fig-sub' }, sub));
    return h('div', { class: 'pf-figs' },
      fig('calls', 'Model calls', formatTokens(o.calls), tools ? plural(tools, 'tool call') : 'no tool calls', `${exact(o.calls)} model calls in this view`),
      fig('duration', 'Median call duration', o.latencyP50 == null ? 'Not recorded' : `${dur(o.latencyP50)}${est(o.latencyEstimated)}`,
        o.latencyP50 == null ? of(0) : `p90 ${dur(o.latencyP90)} · ${of(o.latencyKnown)}`,
        `Whole call duration, including waiting.${o.latencyEstimated ? ` ${exact(o.latencyEstimated)} durations are estimated from timestamps (≈).` : ''}`),
      fig('ttft', 'Median first token', o.ttftP50 == null ? 'Not recorded' : dur(o.ttftP50),
        o.ttftP50 == null ? of(0) : `p90 ${dur(o.ttftP90)} · ${of(o.ttftKnown)}`, 'Time before the first output token, where the agent logged it.'),
      fig('speed', 'Median output speed', o.outputRateP50 == null ? 'Not recorded' : `${formatRate(o.outputRateP50)}${est(o.outputRateEstimated)}`,
        o.outputRateP50 == null ? of(0) : `p10 ${formatRate(o.outputRateP10)} · ${of(o.outputRateKnown)}`,
        'Output tokens ÷ whole call duration, including waiting; not decode speed.'),
      fig('cache', 'Cache reuse', o.cacheHitRatio == null ? 'Not recorded' : formatShare(o.cacheHitRatio), of(o.cacheKnown),
        'Cached input tokens ÷ input tokens, weighted by tokens, over calls with both counts.'),
      fig('busy', 'Busy time', busy ? formatDuration(busy) : '—', timeline ? plural(timeline.segments.length, 'busy period') : '—',
        'Agent time the spans of this view cover. Parallel sessions and subagents add up.'),
    );
  }

  /** Over time, appended to `el`; the lanes size themselves once laid out. */
  function renderOverTime(el, timeline, rows) {
    const sc = app.state.get('scope');
    const host = h('div', { class: 'pf-lanes-host' });
    const table = h('div');
    const details = h('details', { class: 'st-performance-help pf-table' }, h('summary', null, 'Data table'), table);
    details.addEventListener('toggle', () => {
      if (details.open && !table.childElementCount) table.append(perfTable(timeline));
    });
    const section = h('section', { class: 'st-section pf-over' },
      h('div', { class: 'pf-over-head' },
        h('h3', null, 'Over time'),
        h('span', { class: 'st-hint' }, `${plural(timeline.bins.length, 'bin')} of ${formatDuration(timeline.binUs)} · idle time between busy periods is collapsed. Hover to read every lane at one time; drag across a lane to zoom in.`),
        h('span', { class: 'pf-over-actions' },
          h('button', { class: 'btn pn-sm', type: 'button', disabled: sc.from == null && sc.to == null ? true : null, onclick: zoomOut, title: 'Restore the time range before the last zoom' }, 'Zoom Out'),
          h('button', { class: 'btn pn-sm', type: 'button', onclick: () => app.switchWorkspace('timeline'), title: 'Show this time range in Timeline' }, 'Show in Timeline'))),
      host, details);
    el.append(section);
    const folded = new Set(loadPref('stats.performanceFolded', []));
    perfLanes = createPerfLanes(host, {
      timeline, intervals: rows, bucketColor: BUCKET_COLOR, folded,
      onFold: (id, value) => {
        if (value) folded.add(id);
        else folded.delete(id);
        savePref('stats.performanceFolded', [...folded]);
      },
      onZoom: zoomTo,
      onOpen: openInterval,
      onHoverInterval: (id) => {
        for (const row of panes.performance.querySelectorAll('.st-bottleneck')) row.classList.toggle('is-linked', row.dataset.span === id);
      },
    });
  }

  /** The lanes' text equivalent: one row per bin. */
  function perfTable(timeline) {
    const { bins, binUs } = timeline;
    const sameDay = new Date(bins[0].t / 1000).toDateString() === new Date(bins[bins.length - 1].t / 1000).toDateString();
    const busy = (b) => Object.values(b.busy ?? {}).reduce((x, y) => x + y, 0);
    const top = (b) => BUSY_ORDER.filter((k) => b.busy?.[k]).sort((x, y) => b.busy[y] - b.busy[x])[0];
    return h('div', { class: 'pn-table-wrap pf-table-wrap' }, h('table', { class: 'pn-table', 'aria-label': 'Performance over time by bin' },
      h('thead', null, h('tr', null, ['Bin start', 'Busy', 'Most time', 'Model calls', 'Tool calls', 'Failed', 'Duration p50', 'Duration p90', 'First token p50', 'Speed p50', 'Cache reuse', 'Prompt p50']
        .map((t, i) => h('th', { class: i > 2 || i === 1 ? 'num' : null }, t)))),
      h('tbody', null, bins.map((b) => h('tr', null,
        h('td', { title: stampTitle(b.t, 0) }, binTime(b.t, { sameDay, seconds: binUs < 60e6 })),
        h('td', { class: 'num' }, busy(b) ? formatShare(busy(b) / binUs) : '—'),
        h('td', null, top(b) ? BUSY_LABEL[top(b)] : '—'),
        h('td', { class: 'num' }, exact(b.calls)), h('td', { class: 'num' }, exact(b.tools)),
        h('td', { class: 'num' }, b.failed ? h('span', { class: 'st-err' }, exact(b.failed)) : '0'),
        h('td', { class: 'num' }, dur(b.latencyP50)), h('td', { class: 'num' }, dur(b.latencyP90)), h('td', { class: 'num' }, dur(b.ttftP50)),
        h('td', { class: 'num' }, formatRate(b.rateP50)), h('td', { class: 'num' }, formatShare(b.cacheHitRatio)),
        h('td', { class: 'num' }, b.inputP50 == null ? '—' : formatTokens(b.inputP50)))))));
  }

  function renderModelCompare(models) {
    const section = h('section', { class: 'st-section st-model-performance' }, h('h3', null, 'Compare models'));
    if (!models.length) {
      section.append(placeholder('empty', 'No model calls in this view'));
      return section;
    }
    const metrics = [
      { id: 'latency', label: 'Call duration', primary: 'latencyP90', typical: 'latencyP50', known: 'latencyKnown', estimated: 'latencyEstimated', format: dur,
        column: 'Slow calls (p90)', direction: 'Lower is faster', note: 'Whole call duration, including waiting.' },
      { id: 'ttft', label: 'First token', primary: 'ttftP90', typical: 'ttftP50', known: 'ttftKnown', format: dur,
        column: 'Slow calls (p90)', direction: 'Lower is faster', note: 'Time before the first output token arrives.' },
      { id: 'rate', label: 'Output speed', primary: 'outputRateP10', typical: 'outputRateP50', known: 'outputRateKnown', estimated: 'outputRateEstimated', format: rateText,
        column: 'Slow calls (p10)', direction: 'Higher is faster', note: 'Output tokens per second across the whole call, including waiting.' },
      { id: 'cache', label: 'Cache reuse', primary: 'cacheHitRatio', known: 'cacheKnown', format: pct,
        column: 'Input reused', direction: 'Higher means more reuse', note: 'Cached input tokens ÷ total input tokens, over calls with both counts.' },
    ];
    let selected = loadPref('stats.performanceMetric', 'latency');
    if (!metrics.some((m) => m.id === selected)) selected = 'latency';
    const controls = h('div', { class: 'st-metric-picker', role: 'group', 'aria-label': 'Compare models by' });
    const content = h('div');
    const buttons = metrics.map((m) => h('button', {
      class: 'btn pn-sm', type: 'button', onclick: () => {
        selected = m.id;
        savePref('stats.performanceMetric', selected);
        paint();
      },
    }, m.label));
    controls.append(...buttons);
    section.append(controls, content);
    function paint() {
      const m = metrics.find((m) => m.id === selected);
      buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(metrics[i].id === selected)));
      const max = m.id === 'cache' ? 1 : Math.max(...models.map((r) => r[m.primary] ?? 0), 1);
      const cols = [
        { key: 'model', label: 'Model', value: (r) => r.model, render: (r) => keyCell(r.model) },
        { key: 'primary', label: m.column, num: true, value: (r) => r[m.primary], render: (r) => r[m.primary] == null
          ? h('span', { class: 'st-hint' }, 'Not recorded')
          : h('div', { class: 'st-metric-value' }, h('strong', null, m.format(r[m.primary])),
            h('span', { class: 'st-metric-rail', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.min(100, r[m.primary] / max * 100)}%` }))) },
        ...(m.typical ? [{ key: 'typical', label: 'Typical (median)', num: true, value: (r) => r[m.typical], render: (r) => m.format(r[m.typical]) }] : []),
        { key: 'coverage', label: 'Calls with data', num: true, value: (r) => r[m.known], render: (r) => h('span', null,
          `${exact(r[m.known] ?? 0)} / ${exact(r.calls)}`,
          r[m.estimated] ? h('div', { class: 'st-hint' }, `${exact(r[m.estimated])} estimated`) : null) },
        { key: 'action', label: 'Action', value: (r) => r.model, render: () => h('span', { class: 'st-filter-action' }, 'Filter →') },
      ];
      content.replaceChildren(
        h('p', { class: 'st-hint st-performance-note' }, h('strong', null, m.direction), ' · ', m.note),
        sortableTable(cols, models, {
          sortKey: 'primary', desc: m.id === 'latency' || m.id === 'ttft',
          onRow: (r) => app.narrowFilter(`llm.model == ${quote(r.model)}`),
          onMenu: (r, at) => drillMenu(`llm.model == ${quote(r.model)}`, at),
          rowTitle: (r) => `Filter this view to ${r.model}`,
        }),
        h('details', { class: 'st-performance-help' }, h('summary', null, 'How to read these metrics'),
          h('p', null, 'The median describes a typical call. p90 marks the high end of durations; p10 marks the low end of output speed. Models with few measured calls have less reliable percentiles. Output speed here is not decode speed.'),
          h('p', null, 'Missing values stay unrecorded, not zero. Cache reuse is weighted by input tokens; low reuse alone does not explain a slowdown. Estimated durations come from log timing.')),
      );
    }
    paint();
    return section;
  }

  function renderBottlenecks(rows) {
    const max = Math.max(...rows.map((r) => r.duration), 1);
    const section = h('section', { class: 'st-section st-bottlenecks' },
      h('h3', null, 'Slowest intervals'),
      h('p', { class: 'st-hint st-performance-note' }, 'Longest calls and waits in this view, numbered as in the Slowest intervals lane. Open one to inspect what happened around it.'));
    if (!rows.length) section.append(h('p', { class: 'st-hint' }, 'No completed, timed intervals in this view.'));
    const list = h('div', { class: 'st-bottleneck-list', role: 'group', 'aria-label': 'Longest intervals' });
    section.append(list);
    rows.forEach((r, i) => {
      const details = [INTERVAL_LABEL[r.bucket] ?? r.bucket, formatTime(r.start), r.estimated ? 'Estimated timing' : null].filter(Boolean).join(' · ');
      const row = h('button', {
        class: ['st-bottleneck', i === 0 && 'is-longest'], type: 'button', hidden: i >= 3, 'data-span': r.spanId,
        'aria-label': `Show in Timeline: ${r.name}, ${details}, ${dur(r.duration)}`,
        onclick: () => openInterval(r),
        onmouseenter: () => perfLanes?.highlight(r.spanId),
        onmouseleave: () => perfLanes?.highlight(null),
        onfocus: () => perfLanes?.highlight(r.spanId),
        onblur: () => perfLanes?.highlight(null),
      },
      h('span', { class: 'st-bottleneck-rank' }, String(i + 1)),
      h('span', { class: 'st-bottleneck-name' }, autoTitle(h('strong', null, r.name), r.name), h('small', { title: details }, details)),
      h('span', { class: 'st-bottleneck-track', 'aria-hidden': 'true' }, h('span', {
        class: 'st-bottleneck-fill', style: `width:${r.duration / max * 100}%;background-color:${BUCKET_COLOR[r.bucket] ?? 'var(--fg-faint)'}`,
      })),
      h('span', { class: 'st-bottleneck-value' }, `${dur(r.duration)}${r.estimated ? '≈' : ''}`),
      h('span', { class: 'st-bottleneck-action' }, 'Show in Timeline →'));
      list.append(row);
    });
    if (rows.length > 3) {
      let expanded = false;
      const more = h('button', { class: 'btn pn-sm', type: 'button', 'aria-expanded': 'false', onclick: () => {
        expanded = !expanded;
        [...list.children].forEach((row, i) => { row.hidden = !expanded && i >= 3; });
        more.textContent = expanded ? 'Show top 3' : `Show all ${rows.length} intervals`;
        more.setAttribute('aria-expanded', String(expanded));
      } }, `Show all ${rows.length} intervals`);
      section.append(more);
    }
    section.append(h('details', { class: 'st-performance-help' }, h('summary', null, 'About this ranking'),
      h('p', null, `Up to 10 completed intervals, ranked by duration on one scale. They may overlap, so their durations do not add up to wall time. A long interval is an investigation lead, not proof of a bottleneck. ≈ means estimated timing. Where time went shows which kind of work filled each period; Statistics → Time separates model, tool and waiting time per session.`)));
    return section;
  }

  function renderPairs(el, d) {
    const pairs = Array.isArray(d.pairs) ? d.pairs : [];
    if (!pairs.length) {
      el.append(placeholder('empty', 'No pairs in this view'));
      return;
    }
    el.append(
      h('div', { class: 'st-actions' }, h('span', { class: 'st-hint' }, 'Each row counts the exchanges between A and B (an actor or a tool), with their total duration and errors.')),
      sortableTable([
        { key: 'a', label: 'A', value: (r) => r.a, render: (r) => keyCell(r.a) },
        { key: 'b', label: 'B', value: (r) => r.b, render: (r) => keyCell(r.b) },
        { key: 'count', label: 'Count', num: true, value: (r) => r.count, render: (r) => num(r.count) },
        { key: 'dur', label: 'Total time', num: true, value: (r) => r.dur, render: (r) => dur(r.dur) },
        { key: 'mean', label: 'Mean', num: true, value: (r) => (r.count ? r.dur / r.count : null), render: (r) => dur(r.count ? r.dur / r.count : null) },
        { key: 'errors', label: 'Errors', num: true, value: (r) => r.errors, render: (r) => (r.errors ? h('span', { class: 'st-err' }, exact(r.errors)) : '0') },
      ], pairs, { sortKey: 'count' }),
    );
  }

  // ---- I/O graph

  function renderIo(el, d) {
    const metric = IO_METRICS.find((m) => m.id === (d.metric ?? ioMetric)) ?? IO_METRICS[0];
    const binUs = d.binUs > 0 ? d.binUs : 1e6;
    const raw = Array.isArray(d.series) ? d.series.filter((p) => Number.isFinite(p?.t)).sort((a, b) => a.t - b.t) : [];
    const series = fillSeries(raw, binUs, metric.unit === 'us' || metric.mean || metric.peak ? null : 0);
    if (!series.length) {
      chart.setData(null);
      el.append(placeholder('empty', 'No data for this metric in the current view'));
      return;
    }
    chart.setData({ series, binUs, unit: metric.unit, label: metric.label, colorVar: metric.colorVar });
    let peak = null;
    let total = 0;
    for (const p of series) {
      if (p.v == null) continue;
      total += p.v;
      if (!peak || p.v > peak.v) peak = p;
    }
    const statsText = [
      `${exact(series.length)} bins of ${formatDuration(binUs)}`,
      metric.unit === 'us' || metric.mean || metric.peak ? null : `total ${formatValue(total, metric.unit)}`,
      peak ? `peak ${formatValue(peak.v, metric.unit)} at ${formatTime(peak.t)}` : null,
    ].filter(Boolean);
    chartHost.setAttribute('role', 'img');
    chartHost.setAttribute('aria-label', `${metric.label} over time: ${statsText.join(', ')}. The data table below lists every bin.`);
    el.append(h('div', { class: 'st-io-stats' }, statsText.map((t) => h('span', null, t))));
    if (metric.note) el.append(h('div', { class: 'st-hint st-performance-note' }, metric.note));
    // The chart's text equivalent (§7.13, §10.3): the data table, open by default, scrolling inside its strip.
    const rows = series.slice(0, 2000);
    el.append(h('div', { class: 'st-io-table' },
      h('div', { class: 'pn-table-wrap' }, h('table', { class: 'pn-table' },
        h('thead', null, h('tr', null, h('th', null, h('span', { class: 'pn-sort' }, `Bin start, times ${tzOffset(rows[0]?.t)}`)), h('th', { class: 'num' }, h('span', { class: 'pn-sort' }, metric.label)))),
        h('tbody', null, rows.map((p) => h('tr', null, h('td', null, formatClock(p.t, { digits: 0 })), h('td', { class: 'num', title: p.v == null ? NA : null }, p.v == null ? '—' : formatValue(p.v, metric.unit))))))),
      series.length > rows.length ? h('div', { class: 'st-hint' }, `First ${exact(rows.length)} of ${exact(series.length)} bins shown.`) : null));
  }

  return {
    show() {
      visible = true;
      srtServed = null;
      metricOptions();
      ioMetric = metricSel.value;
      updateScope();
      activate(active);
    },
    hide() {
      visible = false;
    },
  };
}
