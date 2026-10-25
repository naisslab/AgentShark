// Failures workspace (SPEC §12.7): facets, the attention queue grouped by section (or by episode,
// signature, session or delegation), the Lens ("Observed chain") and an evidence pane with the selected
// event's derived note and raw source. It honors the session set, the time range and the display filter
// (an item matches when any of its events does; a toggle turns the filter off), shows its §7.8 label
// "41 episodes · 12 need attention · filter + since 23:04" and the four view states. A failed view never
// falls back to the whole index.

import { h, clear, placeholder, showMenu, closeMenu, icon, mark, agentDot, badge, debounce, autoTitle, setScopeLabel, foldRow } from '../lib/dom.js';
import { createVariableList } from '../lib/virtual.js';
import { formatInt, formatDuration, formatAgo, formatShortDate, formatDayTime, stampTitle, agentLabel, agentColor, shortId, plural, AGENTS } from '../lib/format.js';
import { savePref } from '../state.js';
import {
  SECTIONS, SECTION, SECTION_PREVIEW, QUEUE_GROUPS, QUEUE_SORTS, TIERS, TIER, OUTCOME, IMPACT, CLAIM, DELEGATION, FAMILIES, ROLES, ALARM, STATE_GAPS, NEEDS_ATTENTION,
  tierToggleParts, failuresLabel, splitSummary, localDay, dayStart, provMark, provTitle,
} from '../lib/derived.js';

const TONE_VAR = { bad: 'err', warn: 'warn', ok: 'ok', note: 'note', muted: 'fg-muted', accent: 'accent' };
const toneVar = (t) => TONE_VAR[t] ?? 'fg-muted';
import { createLens, createEventPane, signatureText, sparkline, OUTCOME_MARK } from './lens.js';

const PAGE = 100;
const ROW_H = { section: 28, item: 40, more: 40, note: 200 };
const LIVE_REFRESH_MS = 15_000;
const WIDE_PX = 1400;

export default function createFailuresWorkspace(root, app) {
  const { state, api } = app;
  const rulesOf = () => state.get('info')?.analysis?.rules ?? [];
  root.classList.add('fx-root');
  let visible = false;

  // ---------------------------------------------------------------------------
  // Layout

  // Chrome (docs/DESIGN.md §4.5): the workspace header, the facet bar and, under Group by Attention, the section
  // index. Each is one 28 px row across the workspace; nothing wraps.
  const scopeLine = h('div', { class: 'ws-scope fx-scope', 'aria-live': 'polite' });
  const groupBtn = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu' });
  const sortBtn = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu' });
  const matchBox = h('input', { type: 'checkbox' });
  // Always in the header (§7.3, as on the Mac); without a display filter it is disabled and says why.
  const matchCtl = h('label', { class: 'ws-ctl' }, matchBox, 'Display filter applies');
  const head = h('div', { class: 'ws-head fx-head' }, scopeLine, h('div', { class: 'ws-controls' }, groupBtn, sortBtn, matchCtl));

  const tierSeg = h('div', { class: 'fx-tiers', role: 'group', 'aria-label': 'Tiers counted' });
  const facetMenus = h('div', { class: 'fx-facet-menus', role: 'group', 'aria-label': 'Facets' });
  const facetMore = h('button', { class: 'tool-btn', type: 'button', hidden: true, 'aria-haspopup': 'menu' });
  // Split at (§7.4): a button naming the day; its popover takes an ISO date. Shown under Group by Signature, or while
  // a date is set, so a date in force stays visible.
  const splitBtn = h('button', { class: 'tool-btn fx-split-btn', type: 'button', 'aria-haspopup': 'dialog', title: 'Compare each signature before and after a day: failures per session active on those days' });
  const facetBar = h('div', { class: 'fx-facets' }, h('span', { class: 'fx-facet-label' }, 'Tiers'), tierSeg, facetMenus, h('span', { class: 'spacer' }), splitBtn);
  // Section index (§7.5): one item per non-empty section; items that do not fit go to a trailing "+n ▾" menu.
  const indexBar = h('nav', { class: 'fx-index', hidden: true, 'aria-label': 'Attention sections' });
  const gapBar = h('div', { class: 'fx-gaps', hidden: true, role: 'status' });

  const queueEl = h('div', { class: 'fx-queue', tabindex: '0', role: 'listbox', 'aria-label': 'Failures queue', 'data-f6': '' });
  const queuePane = h('div', { class: 'fx-queue-pane' }, queueEl);
  const lens = createLens(app, {
    onBack: () => setPane('queue'),
    onEvent: (id) => evidence.show(id),
    onSplitDate: () => openSplit(splitBtn),
  });
  const evidence = createEventPane(app, {
    onShow: (id) => state.set({ selectedEvent: id, failuresEvidence: true }),
    // Closing the pane in Failures drops its event, so the keys act on the Lens item again.
    onHide: () => state.set({ failuresEvidence: false, selectedEvent: state.get('workspace') === 'failures' ? null : state.get('selectedEvent') }),
  });
  const grid = h('div', { class: 'fx-grid', dataset: { pane: 'queue' }, 'data-follow-host': '' }, queuePane, lens.el, evidence.el);
  const notice = h('div', { class: 'fx-notice', hidden: true });
  root.append(head, facetBar, indexBar, gapBar, notice, grid);

  new ResizeObserver(() => renderFacets(summary)).observe(facetBar);
  const narrowQuery = matchMedia('(max-width: 1099px)');
  const layout = () => {
    const w = root.clientWidth;
    root.classList.toggle('is-narrow', narrowQuery.matches || (w > 0 && w < 640));
    root.classList.toggle('is-wide', w >= WIDE_PX);
  };
  narrowQuery.addEventListener('change', layout);
  new ResizeObserver(layout).observe(root);
  const setPane = (p) => {
    grid.dataset.pane = p;
    if (p === 'queue') queueEl.focus({ preventScroll: true });
  };

  // ---------------------------------------------------------------------------
  // Facets

  const facets = () => state.get('failureFacets');
  const setFacets = (patch) => {
    const next = { ...facets(), ...patch };
    savePref('failures.facets', next);
    state.set({ failureFacets: next });
  };

  function renderToolbar(summary) {
    const f = facets();
    const parts = tierToggleParts(summary?.tiers ?? null);
    const calls = summary?.tiers?.failure;
    // The toggles count calls (failure rows); the scope label counts the episodes they group into.
    const baseTitle = calls == null ? 'Failure-tier calls are always counted'
      : `${plural(calls, 'failed call')}${summary.episodes != null ? ` in ${plural(summary.episodes, 'episode')}` : ''}; failure-tier calls are always counted`;
    // The summary route counts tiers in the scope only: with facets set, the toggles say they count across them
    // (Principle 5) until the server scopes the counts by facet.
    const facetNote = facetParts().length ? '\nCounted across all facets; the facets narrow the queue only' : '';
    tierSeg.replaceChildren(...parts.map((p) => {
      if (p.tier === 'failure') return h('button', { class: 'tool-btn fx-tier', type: 'button', 'aria-pressed': 'true', 'aria-disabled': 'true', title: baseTitle + facetNote }, p.text);
      const on = f.tier.includes(p.tier);
      // A toggle whose count is 0 is hidden unless it is pressed (§7.4).
      if (!on && summary?.tiers?.[p.tier] === 0) return null;
      return h('button', {
        class: ['tool-btn', 'fx-tier', `tone-${p.tier}`], type: 'button', 'aria-pressed': String(on),
        title: { suspect: 'Add unflagged results where a text rule fired; the counts are upper bounds', benign: 'Add benign exits, such as rg with no match', deferred: 'Add “still running” results' }[p.tier] + facetNote,
        onClick: () => setFacets({ tier: on ? f.tier.filter((t) => t !== p.tier) : TIERS.filter((t) => t === 'failure' || t === p.tier || f.tier.includes(t)) }),
      }, p.text);
    }).filter(Boolean));
    groupBtn.replaceChildren(`Group: ${QUEUE_GROUPS.find((g) => g.id === f.group)?.label ?? f.group}`, icon('down', 10));
    sortBtn.replaceChildren(`Sort: ${QUEUE_SORTS.find((x) => x.id === f.sort)?.label ?? f.sort}`, icon('down', 10));
    const at = state.get('signatureSplitAt');
    splitBtn.hidden = f.group !== 'signature' && at == null && state.get('lensItem')?.kind !== 'signature';
    splitBtn.replaceChildren(at != null ? `Split at ${formatShortDate(at)}` : 'Split at…', icon('down', 10));
    matchBox.checked = f.matchFilter;
    matchBox.disabled = !state.get('filter');
    matchCtl.title = matchBox.disabled ? 'No display filter is set; set one to narrow the queue to items with a matching event'
      : 'An item matches when any of its events does; turn this off to see every failure in the sessions and time range';
    renderFacets(summary);
  }

  /** A facet menu button, or, once set, one token "Family: sandbox ▾ ×" in its place (§7.4). */
  function facetMenu(label, key, values, counts, fmt = (v) => v) {
    const sel = facets()[key];
    const open = (anchor) => showMenu(anchor, [
      { label: 'Any', checked: !sel.length, onSelect: () => setFacets({ [key]: [] }) },
      { separator: true },
      ...values.map((v) => ({
        label: fmt(v),
        hint: counts?.[v] != null ? formatInt(counts[v]) : '',
        checked: sel.includes(v),
        onSelect: () => setFacets({ [key]: sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v] }),
      })),
    ], { minWidth: 220 });
    if (!sel.length) {
      const btn = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu' }, label, icon('down', 10));
      btn.addEventListener('click', () => open(btn));
      return Object.assign(btn, { _fold: { label, open } });
    }
    return Object.assign(facetToken(label, sel.map(fmt).join(', '), open, () => setFacets({ [key]: [] })), { _fold: { label: `${label}: ${sel.map(fmt).join(', ')}`, open } });
  }

  function facetToken(label, value, open, onClear) {
    const menuBtn = h('button', { class: 'fx-token-open', type: 'button', 'aria-haspopup': 'menu', 'aria-label': `${label}: ${value}, change` },
      h('span', { class: 'chip-kind' }, `${label}:`), h('span', { class: 'chip-label' }, value), icon('down', 10));
    if (open) menuBtn.addEventListener('click', () => open(menuBtn));
    return autoTitle(h('span', { class: 'chip fx-token' }, menuBtn,
      h('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove the ${label.toLowerCase()} facet`, onClick: onClear }, icon('close', 10))), `${label}: ${value}`);
  }

  function renderFacets(summary) {
    const f = facets();
    const word = (v) => OUTCOME[v]?.word ?? v;
    const unattOpen = (anchor) => showMenu(anchor, [
      { label: 'Any', checked: f.unattended == null, onSelect: () => setFacets({ unattended: null }) },
      { label: 'Unattended only', hint: 'subagents, goal runs, no recent prompt', checked: f.unattended === true, onSelect: () => setFacets({ unattended: true }) },
      { label: 'Attended only', checked: f.unattended === false, onSelect: () => setFacets({ unattended: false }) },
    ]);
    let unatt;
    if (f.unattended == null) {
      unatt = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu' }, 'Unattended', icon('down', 10));
      unatt.addEventListener('click', () => unattOpen(unatt));
    } else unatt = facetToken('Unattended', f.unattended ? 'only' : 'attended only', unattOpen, () => setFacets({ unattended: null }));
    unatt._fold = { label: 'Unattended', open: unattOpen };
    const set = ['outcome', 'family', 'agent', 'role'].filter((k) => f[k].length).length + (f.unattended != null) + (f.signature ? 1 : 0);
    facetMenus.replaceChildren(...[
      facetMenu('Outcome', 'outcome', Object.keys(OUTCOME), summary?.outcomes, word),
      facetMenu('Family', 'family', FAMILIES, summary?.families),
      facetMenu('Agent', 'agent', AGENTS.map((a) => a.id), null, agentLabel),
      facetMenu('Role', 'role', ROLES, null),
      unatt,
      f.signature ? facetToken('Signature', shortId(f.signature, 16), null, () => setFacets({ signature: null })) : null,
      set >= 2 ? h('button', { class: 'tool-btn', type: 'button', onClick: () => setFacets({ outcome: [], family: [], agent: [], role: [], unattended: null, signature: null }) }, 'Clear Facets') : null,
    ].filter(Boolean), facetMore);
    // Facet menus that do not fit fold, from the right, into "More ▾" (§7.4).
    requestAnimationFrame(() => foldRow(facetBar, [...facetMenus.children].filter((el) => el !== facetMore).map((el) => ({
      el, label: el._fold?.label ?? el.textContent, open: el._fold?.open ?? (() => el.click()),
    })), facetMore));
  }

  /** The Split at popover: an ISO date field and a month grid; Return applies, Clear removes the date. */
  function openSplit(anchor) {
    const at = state.get('signatureSplitAt');
    const today = new Date();
    let month = at != null ? new Date(at / 1000) : today;
    month = new Date(month.getFullYear(), month.getMonth(), 1);
    const field = h('input', { class: 'text-input mono fx-split-iso', type: 'text', inputmode: 'numeric', placeholder: 'YYYY-MM-DD', 'aria-label': 'Split date, YYYY-MM-DD', value: at != null ? localDay(at) : '' });
    const grid = h('div', { class: 'cal-grid', role: 'grid', 'aria-label': 'Choose a day' });
    const title = h('span', { class: 't-group' });
    const apply = (v) => {
      const us = dayStart(v);
      if (us == null) {
        field.classList.add('invalid');
        return;
      }
      closeMenu();
      state.set({ signatureSplitAt: us });
    };
    const paint = () => {
      title.textContent = month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const first = (month.getDay() + 6) % 7;
      const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
      grid.replaceChildren(...['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => h('span', { class: 'cal-dow', role: 'columnheader' }, d)),
        ...Array.from({ length: first }, () => h('span')),
        ...Array.from({ length: days }, (_, i) => {
          const d = new Date(month.getFullYear(), month.getMonth(), i + 1);
          const iso = localDay(d.getTime() * 1000);
          return h('button', { class: ['cal-day', iso === field.value && 'on'], type: 'button', role: 'gridcell', 'aria-label': iso, onClick: () => apply(iso) }, String(i + 1));
        }));
    };
    const nav = (d) => {
      month = new Date(month.getFullYear(), month.getMonth() + d, 1);
      paint();
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply(field.value.trim());
    });
    paint();
    const prev = h('button', { class: 'icon-btn cal-prev', type: 'button', 'aria-label': 'Previous month', onClick: () => nav(-1) }, icon('chevron', 12));
    showMenu(anchor, [], {
      align: 'end',
      label: 'Split at',
      content: h('div', { class: 'cal' },
        h('div', { class: 'cal-foot' }, field, h('button', { class: 'btn primary', type: 'button', onClick: () => apply(field.value.trim()) }, 'Apply'),
          at != null ? h('button', { class: 'btn', type: 'button', onClick: () => { closeMenu(); state.set({ signatureSplitAt: null }); } }, 'Clear') : null),
        h('div', { class: 'cal-head' }, prev, title, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', onClick: () => nav(1) }, icon('chevron', 12))),
        grid),
    });
  }

  groupBtn.addEventListener('click', () => showMenu(groupBtn, QUEUE_GROUPS.map((g) => ({ label: g.label, checked: facets().group === g.id, onSelect: () => setFacets({ group: g.id }) }))));
  sortBtn.addEventListener('click', () => showMenu(sortBtn, QUEUE_SORTS.map((x) => ({ label: x.label, checked: facets().sort === x.id, onSelect: () => setFacets({ sort: x.id }) }))));
  splitBtn.addEventListener('click', () => openSplit(splitBtn));
  state.subscribe(['signatureSplitAt'], () => {
    renderToolbar(summary);
    if (visible && status === 'ready') list.refresh();
  });
  matchBox.addEventListener('change', () => setFacets({ matchFilter: matchBox.checked }));

  // ---------------------------------------------------------------------------
  // Scope: the shared view when the filter applies; otherwise a view of the sessions and time range alone.

  let own = { key: null, view: null, error: null, loading: false };
  function ownView(scope) {
    const key = JSON.stringify([scope.sessions, scope.from, scope.to, state.get('showInherited'), state.get('showDup')]);
    if (own.key !== key) {
      own = { key, view: null, error: null, loading: true };
      api.createView({ sessions: scope.sessions ?? undefined, descendants: true, from: scope.from ?? undefined, to: scope.to ?? undefined, includeInherited: state.get('showInherited'), includeDup: state.get('showDup') })
        .then((v) => { if (own.key === key) own = { key, view: v, error: null, loading: false }; })
        .catch((err) => { if (own.key === key) own = { key, view: null, error: err, loading: false }; })
        .finally(() => { if (own.key === key) load(); });
    }
    if (own.loading) return { status: 'loading' };
    if (own.error) return { status: 'failed', error: own.error, retry: () => { own.key = null; load(); } };
    return { status: own.view.count ? 'ready' : 'ready-empty', view: own.view.viewId };
  }

  /** {status, view?, error?, retry?} of the population the queue describes. */
  function scopeRef() {
    const scope = state.get('scope');
    const filter = state.get('filter');
    const applies = !!filter && facets().matchFilter;
    const unscoped = !scope.sessions?.length && scope.from == null && scope.to == null;
    if (unscoped && !applies) return { status: 'ready', view: 'global' };
    if (!applies && filter) return ownView(scope);
    const vs = app.viewState();
    if (vs.status === 'ready' || vs.status === 'ready-empty') return { status: vs.status, view: vs.view.viewId };
    return { status: vs.status, error: vs.error, retry: () => app.retryView() };
  }

  function scopeParts() {
    const scope = state.get('scope');
    const parts = [];
    if (state.get('filter') && facets().matchFilter) parts.push('filter');
    const n = scope.sessions?.length ?? 0;
    if (n) parts.push(n === 1 ? '1 session' : `${n} sessions`);
    if (scope.from != null || scope.to != null) {
      const since = state.get('sinceChip');
      parts.push(since?.from === scope.from && scope.to == null ? `since ${formatDayTime(scope.from)}` : 'time range');
    }
    return parts;
  }

  /** The facets in force, in words ("family sandbox"), for the scope label. */
  function facetParts() {
    const f = facets();
    const word = { agent: agentLabel, outcome: (v) => OUTCOME[v]?.word ?? v };
    const parts = ['outcome', 'family', 'agent', 'role'].filter((k) => f[k].length).map((k) => `${k} ${f[k].map(word[k] ?? String).join(', ')}`);
    if (f.unattended != null) parts.push(f.unattended ? 'unattended' : 'attended');
    if (f.signature) parts.push('one signature');
    return parts;
  }

  // ---------------------------------------------------------------------------
  // Data

  let summary = null;
  let facetCounts = null; // {episodes, needAttention (null outside Attention grouping)} under active facets
  let sections = new Map(); // section → {total, rows, open, loading}
  let flat = { total: 0, rows: [], loading: false };
  let status = 'loading'; // loading | failed | ready | ready-empty | unsupported
  let error = null;
  let retry = null;
  let loadSeq = 0;
  let loadedKey = null;
  let lastLoad = 0;
  let refreshTimer = 0;
  const openState = new Map(); // section → open, chosen by the user in this visit
  const shownAll = new Set(); // open sections whose rows go past SECTION_PREVIEW, chosen by the user in this visit
  let pendingJump = null; // section to scroll to once its rows are in the model

  const isOpen = (s) => openState.get(s) ?? !SECTION[s].collapsed;

  function queueQuery(ref, extra = {}) {
    const f = facets();
    return {
      view: ref.view, group: f.group, tier: f.tier, outcome: f.outcome, family: f.family, agent: f.agent, role: f.role,
      unattended: f.unattended ?? undefined, signature: f.signature ?? undefined, sort: f.sort, limit: PAGE, ...extra,
    };
  }

  async function load({ force = false } = {}) {
    if (!visible) return;
    if (!api.features.derived) {
      status = 'unsupported';
      publish();
      return render();
    }
    const ref = scopeRef();
    if (ref.status !== 'ready') {
      status = ref.status;
      error = ref.error ?? null;
      retry = ref.retry ?? null;
      // Counts of another scope must not stay on screen as if they described this one.
      if (status !== 'loading') summary = null;
      renderToolbar(summary);
      publish();
      return render();
    }
    renderToolbar(summary);
    const key = JSON.stringify([ref.view, facets(), state.get('indexVersion')]);
    if (!force && key === loadedKey && status === 'ready') return;
    const seq = ++loadSeq;
    lastLoad = Date.now();
    if (status !== 'ready') {
      status = 'loading';
      render();
    }
    try {
      const f = facets();
      const sum = await api.failuresSummary({ view: ref.view, tier: f.tier });
      if (seq !== loadSeq) return;
      summary = sum;
      if (f.group === 'attention') {
        const next = new Map();
        await Promise.all(SECTIONS.filter((s) => (sum.sections?.[s] ?? 0) > 0).map(async (s) => {
          const open = isOpen(s);
          const page = await api.failuresQueue(queueQuery(ref, { section: s, limit: open ? PAGE : 1 }));
          next.set(s, { total: page.total, rows: open ? page.rows : [], open });
        }));
        if (seq !== loadSeq) return;
        sections = next;
      } else {
        const page = await api.failuresQueue(queueQuery(ref));
        if (seq !== loadSeq) return;
        flat = { total: page.total, rows: page.rows };
      }
      const counts = facetParts().length ? await facetTotals(ref) : null;
      if (seq !== loadSeq) return;
      facetCounts = counts;
      loadedKey = key;
      status = 'ready';
      error = null;
      renderToolbar(summary);
    } catch (err) {
      if (seq !== loadSeq) return;
      if (app.handleViewError(err)) return;
      status = 'failed';
      error = err;
      retry = () => load({ force: true });
    }
    publish();
    render();
    syncSelection();
    autoSelect();
  }

  /**
   * The summary counts the scope without facets. Under facets the label counts the faceted episodes and, in
   * Attention grouping, the faceted attention items (the section totals).
   */
  async function facetTotals(ref) {
    const f = facets();
    const episodes = f.group === 'episode' ? flat.total : (await api.failuresQueue(queueQuery(ref, { group: 'episode', limit: 1 }))).total;
    const needAttention = f.group === 'attention' ? NEEDS_ATTENTION.reduce((n, s) => n + (sections.get(s)?.total ?? 0), 0) : null;
    return { episodes, needAttention };
  }

  /** What the user scoped the queue to (the sort only orders it); a Lens item picked under another scope is not kept. */
  const scopeKey = () => {
    const { sort: _sort, ...f } = facets();
    return JSON.stringify([state.get('scope'), f.matchFilter ? state.get('filter') : null, f]);
  };
  let lensScope = null;

  /**
   * Open the first item that needs attention (the entry rule's choice) when the Lens is empty, or when it shows an
   * item picked under another scope (or chosen by this rule) that the queue no longer lists. An item the user
   * picked in this scope stays, even when the queue does not list it (a signature, an example episode). Narrow
   * windows keep the queue in front.
   */
  function autoSelect() {
    if (status !== 'ready' || !visible || root.classList.contains('is-narrow')) return;
    const cur = state.get('lensItem');
    if (cur && cur !== app.autoLensItem() && lensScope === scopeKey()) return;
    const rows = facets().group === 'attention' ? NEEDS_ATTENTION.flatMap((s) => sections.get(s)?.rows ?? []) : flat.rows;
    if (cur && rows.some((r) => rowKey(r) === lensKey())) return;
    if (rows[0]) app.openQueueRow(rows[0], { reveal: false, auto: true });
  }

  /** One section's rows (after the user opened it, or for "Load more"). */
  async function loadSection(s, { more = false } = {}) {
    const ref = scopeRef();
    if (ref.status !== 'ready') return;
    const cur = sections.get(s) ?? { total: 0, rows: [] };
    const seq = loadSeq;
    cur.loading = true;
    render();
    try {
      const page = await api.failuresQueue(queueQuery(ref, { section: s, offset: more ? cur.rows.length : 0 }));
      if (seq !== loadSeq) return;
      sections.set(s, { total: page.total, rows: more ? [...cur.rows, ...page.rows] : page.rows, open: true });
    } catch (err) {
      app.toast(`Could not load ${SECTION[s].label}: ${err.message}`, 'error');
      cur.loading = false;
    }
    render();
  }

  async function loadMoreFlat() {
    const ref = scopeRef();
    if (ref.status !== 'ready' || flat.loading) return;
    flat.loading = true;
    render();
    const seq = loadSeq;
    try {
      const page = await api.failuresQueue(queueQuery(ref, { offset: flat.rows.length }));
      if (seq === loadSeq) flat = { total: page.total, rows: [...flat.rows, ...page.rows] };
    } catch (err) {
      app.toast(err.message, 'error');
    }
    flat.loading = false;
    render();
  }

  function publish() {
    let text;
    if (status === 'unsupported') text = 'Failure analysis needs a newer AgentShark server';
    else if (status === 'loading') text = 'Loading failures…';
    else if (status === 'failed') text = 'Could not load this view';
    else if (status === 'ready-empty') text = failuresLabel({ episodes: 0, needAttention: 0, scopeParts: [...scopeParts(), ...facetParts()] });
    else {
      const fc = facetCounts;
      const parts = [...scopeParts(), ...(fc ? facetParts() : [])];
      text = fc && fc.needAttention == null
        ? `${plural(fc.episodes, 'episode')} · ${parts.join(' + ')} · ${formatInt(summary?.needAttention ?? 0)} need attention without facets`
        : failuresLabel({ episodes: fc?.episodes ?? summary?.episodes ?? 0, needAttention: fc?.needAttention ?? summary?.needAttention ?? 0, scopeParts: parts });
    }
    setScopeLabel(scopeLine, text);
    app.setWorkspaceStatus('failures', text);
    // The status bar puts the scoped count beside the whole index's ("21 of 3,032 need attention"): the faceted
    // count in Attention grouping, else the count of the sessions and time range when they narrow the index.
    const scoped = facetCounts?.needAttention ?? (scopeParts().length ? summary?.needAttention ?? null : null);
    state.set({ failuresAttention: status === 'ready' ? scoped : null });
    const gaps = (summary?.gaps ?? []).filter((g) => STATE_GAPS.includes(g.code));
    gapBar.hidden = !gaps.length || status !== 'ready';
    gapBar.replaceChildren(...gaps.map((g) => h('span', { class: ['fx-gap', `gap-${g.code}`], title: g.field ?? '' }, g.message)));
  }

  // ---------------------------------------------------------------------------
  // Queue rendering

  let model = [];
  let selectedKey = null;
  const rowKey = (r) => `${r.kind}:${r.id}`;
  const list = createVariableList(queueEl, { renderRow: (i) => renderModelRow(model[i]) });

  const lensKey = () => {
    const it = state.get('lensItem');
    return it ? `${it.kind}:${it.id}` : null;
  };

  function buildModel() {
    const out = [];
    if (facets().group === 'attention') {
      const keep = new Set([selectedKey, lensKey()]);
      for (const s of SECTIONS) {
        const sec = sections.get(s);
        const total = sec?.total ?? summary?.sections?.[s] ?? 0;
        if (!total) continue;
        out.push({ type: 'section', s, total, open: isOpen(s) });
        if (!isOpen(s)) continue;
        const rows = sec?.rows ?? [];
        // A section shows a page of rows until "Show all"; the selected row keeps its section unfolded.
        const all = shownAll.has(s) || rows.slice(SECTION_PREVIEW).some((r) => keep.has(rowKey(r)));
        for (const r of all ? rows : rows.slice(0, SECTION_PREVIEW)) out.push({ type: 'item', r });
        if (sec?.loading) out.push({ type: 'more', s, loading: true });
        else if (!all && total > SECTION_PREVIEW) out.push({ type: 'more', s, showAll: true, total });
        else if (rows.length < total) out.push({ type: 'more', s, left: total - rows.length });
      }
    } else {
      for (const r of flat.rows) out.push({ type: 'item', r });
      if (flat.rows.length < flat.total) out.push({ type: 'more', left: flat.total - flat.rows.length, loading: flat.loading });
    }
    if (!out.length) out.push({ type: 'none' });
    return out;
  }

  function render() {
    if (status === 'ready') {
      model = buildModel();
      queueEl.hidden = false;
      clear(notice).hidden = true;
      list.setRows(model.map((m) => (m.type === 'none' ? ROW_H.note : ROW_H[m.type])));
      renderIndex();
      if (pendingJump && isOpen(pendingJump)) jumpTo(pendingJump);
      return;
    }
    model = [];
    list.setRows([]);
    renderIndex();
    queueEl.hidden = true;
    notice.hidden = false;
    clear(notice);
    if (status === 'unsupported') {
      notice.append(placeholder('empty', 'This AgentShark server predates failure analysis',
        'Failures, the Lens and Session · Steps need a server that builds the schema-4 analysis tables. The Events workspace still works.',
        { label: 'Open Events', onClick: () => app.switchWorkspace('events') }));
    } else if (status === 'loading') {
      notice.append(placeholder('loading', 'Loading failures…'));
    } else if (status === 'failed') {
      notice.append(placeholder('error', 'Could not load this view.', ['Your selection is preserved.', error?.message ? h('div', { class: 't-meta' }, error.message) : null], retry ? { label: 'Retry', onClick: retry } : null));
    } else if (status === 'ready-empty') {
      notice.append(emptyState('No events match this scope', 'The display filter, sessions and time range leave no events, so there are no failures to show.'));
    }
  }

  /** An empty state with the actions that can widen it; `tiers` offers adding the suspect tier. */
  function emptyState(title, detail, { tiers = false } = {}) {
    const actions = [];
    if (state.get('filter')) actions.push({ label: 'Clear filter', onClick: () => app.setFilter('') });
    const sc = state.get('scope');
    if (sc.from != null || sc.to != null) actions.push({ label: 'Widen range', onClick: () => app.setTimeRange(null, null) });
    if (tiers && !facets().tier.includes('suspect')) actions.push({ label: 'Include suspect', onClick: () => setFacets({ tier: [...new Set(['failure', 'suspect', ...facets().tier])] }) });
    return placeholder('empty', title, detail, actions);
  }

  function renderModelRow(m) {
    if (!m) return h('div');
    if (m.type === 'section') {
      const label = SECTION[m.s].label;
      // Under Group by Attention the section index holds the counts, so the header omits them (§7.5).
      return h('div', {
        class: ['fx-section', `sec-${m.s}`, m.open && 'open', SECTION[m.s].attention && m.s !== 'recurring' && m.s !== 'unverified-claims' && 'needs'], role: 'button', tabindex: '-1', 'aria-expanded': String(m.open), dataset: { section: m.s },
        'aria-label': `${label}, ${formatInt(m.total)} ${m.total === 1 ? SECTION[m.s].unit : `${SECTION[m.s].unit}s`}`,
      }, h('span', { class: ['twisty', m.open && 'open'] }, icon('chevron', 10)), h('span', { class: 'fx-sec-label' }, label));
    }
    if (m.type === 'more') {
      if (m.showAll) {
        return h('div', { class: 'fx-more' }, h('button', { class: 'btn', type: 'button', dataset: { showAll: m.s } }, `Show All ${formatInt(m.total)}`),
          h('span', { class: 't-meta' }, `${formatInt(SECTION_PREVIEW)} of ${formatInt(m.total)} shown`));
      }
      return h('div', { class: 'fx-more' }, m.loading
        ? h('span', { class: 't-meta' }, `Loading ${formatInt(Math.min(PAGE, m.left ?? PAGE))} more…`)
        : h('button', { class: 'btn', type: 'button', dataset: { more: m.s ?? '' } }, `Load ${formatInt(Math.min(PAGE, m.left))} More`),
        m.loading ? null : h('span', { class: 't-meta' }, `${formatInt(m.left)} not loaded`));
    }
    if (m.type === 'none') return emptyState('No failures in this scope', 'Nothing matches the tiers and facets. Suspect rows are upper bounds and stay off until you add them.', { tiers: true });
    return itemRow(m.r);
  }

  /** The impact mark of a row (§6.3) and its color. */
  function rowMark(r) {
    switch (r.kind) {
      case 'alarm': return { name: 'alarm', tone: ALARM[r.alarmKind]?.notify ? 'bad' : 'warn' };
      case 'claim': return { name: 'claim', tone: 'warn' };
      case 'delegation': return { name: r.section === 'silent-child' ? 'silent' : OUTCOME_MARK[r.outcome] ?? 'failed', tone: 'bad', outlined: r.outcomeSrc && !/^logged:/.test(r.outcomeSrc) };
      case 'signature': return { name: r.signatureStatus === 'regressed' ? 'regressed' : 'loop', tone: r.signatureStatus === 'regressed' ? 'warn' : 'muted' };
      default: {
        const imp = IMPACT[r.impact];
        if (imp) return { name: r.impact, tone: imp.tone };
        const o = OUTCOME[r.outcome];
        return { name: OUTCOME_MARK[r.outcome] ?? 'failed', tone: o?.tone ?? 'bad' };
      }
    }
  }

  /** The outcome slot of line 2 (§7.6): outcome word, claim status, "silent · parent told: no" or alarm state. */
  function outcomeSlot(r) {
    switch (r.kind) {
      case 'claim': return badge('plain', CLAIM[r.outcome]?.short === 'no test' ? 'no test run' : CLAIM[r.outcome]?.short ?? 'unverified', { tone: 'warn' });
      case 'delegation': return r.section === 'silent-child'
        ? badge('plain', 'silent · parent told: no', { tone: 'bad' })
        : badge('plain', DELEGATION[r.outcome]?.word ?? r.outcome ?? 'outcome unknown', { tone: DELEGATION[r.outcome]?.tone ?? 'muted' });
      case 'alarm': return badge('plain', r.outcome ?? 'firing', { tone: 'bad' });
      case 'signature': {
        const st = r.signatureStatus;
        if (!st) return null;
        return st === 'regressed' ? badge('plain', 'regressed', { tone: 'warn', markName: 'regressed' })
          : st === 'new' ? badge('plain', 'new', { tone: 'note' })
            : badge('plain', st === 'recurring' ? 'recurring' : st, { tone: 'muted' });
      }
      default: {
        const o = OUTCOME[r.outcome];
        return o ? badge('plain', o.word, { tone: o.tone }) : null;
      }
    }
  }

  /** The subject of line 1 by row kind (§7.6): signature, claim quote, delegation task, alarm text. */
  function subject(r) {
    if (r.kind === 'claim') {
      // A claim leads with its quote; without one it says so, never the session title line 2 already shows (§7.6).
      return r.quote ? { text: `“${r.quote}”`, el: `“${r.quote}”` } : { text: 'Claim without quoted text', el: h('span', { class: 'muted' }, 'Claim without quoted text') };
    }
    if (r.kind === 'alarm') return { text: ALARM[r.alarmKind]?.word ?? r.alarmKind ?? 'alarm', el: null };
    if (r.signature) return { text: r.signature, el: signatureText(r.signature) };
    const t = r.target ?? r.title ?? r.id;
    return { text: t, el: t };
  }

  function itemRow(r) {
    const key = rowKey(r);
    const subj = subject(r);
    const mk = rowMark(r);
    // A delegation names its child on line 1, so line 2 names the parent session; a signature spans sessions.
    const title = r.kind === 'delegation' ? app.sessionById(r.sessionId)?.title ?? null : r.kind === 'signature' ? null : r.title;
    const wall = r.wallUs != null ? `${formatDuration(r.wallUs)}${provMark(r.wallSrc ?? 'derived:ts-gap')} lost` : null;
    // A signature's "in N sessions" drops first (§7.6 Line 2 priority); its episode count and the wall figure stay.
    const counts = r.kind === 'signature' && r.members != null
      ? [plural(r.members, 'episode'), r.seenSessions != null ? h('span', { dataset: { drop: '1' } }, ` in ${plural(r.seenSessions, 'session')}`) : null]
      : r.attempts != null ? plural(r.attempts, 'attempt') : null;
    const l1 = h('div', { class: 'fx-l1' },
      h('span', { class: 'fx-mark', style: { color: `var(--${toneVar(mk.tone)})` } }, mark(mk.name, { outlined: mk.outlined })),
      r.kind === 'signature' ? h('span', { class: 'fx-spark', 'aria-hidden': 'true' }, sparkline(r.daily?.n, { w: 48, h: 14 })) : null,
      autoTitle(h('span', { class: 'fx-text' }, subj.el ?? subj.text), subj.text),
      r.live ? badge('plain', 'Live', { tone: 'accent', markName: 'live', cls: 'fx-live' }) : null,
      h('span', { class: 'fx-age', title: stampTitle(r.ts) }, formatAgo(r.ts)));
    const l2 = h('div', { class: 'fx-l2' },
      outcomeSlot(r),
      r.tier && r.tier !== 'failure' ? badge('outline', TIER[r.tier]?.word ?? r.tier, { tone: r.tier }) : null,
      r.kind === 'signature' && state.get('signatureSplitAt') != null ? splitChip(r.id) : null,
      r.agent ? h('span', { class: 'fx-agent' }, agentDot(agentColor(r.agent)), agentLabel(r.agent)) : null,
      title ? autoTitle(h('span', { class: 'fx-title' }, title), r.kind === 'delegation' ? `Parent session: ${title}` : title) : null,
      r.step != null ? h('span', { class: 'fx-step', dataset: { drop: '3' } }, `step ${formatInt(r.step)}`) : null,
      r.family ? h('span', { class: 'fx-fam', dataset: { drop: '2' } }, r.family) : null,
      r.unattended ? h('span', { class: 'fx-unatt', dataset: { drop: '2' } }, 'unattended') : null,
      h('span', { class: 'fx-l2-gap' }),
      counts ? h('span', { class: 'fx-num', dataset: { drop: r.kind === 'signature' ? '' : '4' } }, counts) : null,
      wall ? h('span', { class: 'fx-num fx-wall', title: provTitle(r.wallSrc ?? 'derived:ts-gap', rulesOf()) }, wall) : null,
      r.kind !== 'signature' && r.seenSessions != null ? h('span', { class: 'fx-num', dataset: { drop: '1' } }, `in ${plural(r.seenSessions, 'session')}`) : null);
    const row = h('div', {
      class: ['fx-item', key === selectedKey && 'selected'],
      role: 'option', tabindex: '-1', 'aria-selected': String(key === selectedKey), dataset: { key },
      'aria-label': [outcomeSlot(r)?.textContent, subj.text, r.agent && agentLabel(r.agent), title, r.step != null && `step ${r.step}`, wall, formatAgo(r.ts)].filter(Boolean).join(', '),
    }, l1, l2);
    requestAnimationFrame(() => fitLine2(l2));
    return row;
  }

  /**
   * Line 2 priority (§7.6): while it does not fit, drop "in N sessions", then the family and "unattended", then
   * "step N", then the attempts count. The session title then cuts, down to its minimum; the outcome word, the
   * agent and the wall figure never drop.
   */
  function fitLine2(l2) {
    if (!l2.isConnected) return;
    // Measure with the title at its natural width: elements drop before the title cuts at all. A signature's rate
    // change (drop 3, after the family) cuts to its 96 px minimum before it drops into the line's tooltip.
    l2.classList.add('measuring');
    const rate = l2.querySelector('.fx-split');
    const slack = () => (rate && !rate.hidden ? Math.max(0, rate.offsetWidth - 96) : 0);
    for (const p of ['1', '2', '3', '4']) {
      const over = l2.scrollWidth - l2.clientWidth - 1;
      if (over <= 0 || (p >= '3' && over <= slack())) break;
      for (const el of l2.querySelectorAll(`[data-drop="${p}"]`)) el.hidden = true;
    }
    l2.classList.remove('measuring');
    l2.title = rate?.hidden ? rate.title : '';
    // The first element shown right of the gap starts its group: no separator before it.
    const gap = l2.querySelector('.fx-l2-gap');
    let first = gap?.nextElementSibling;
    while (first?.hidden) first = first.nextElementSibling;
    for (const el of l2.querySelectorAll('.right-first')) el.classList.remove('right-first');
    first?.classList.add('right-first');
    // A last resort for an outcome longer than the design measured ("silent · parent told: no"): the title may cut
    // below its minimum, so nothing is clipped without an ellipsis.
    l2.classList.toggle('tight', l2.scrollWidth > l2.clientWidth + 1);
  }

  // Split chips load per visible signature row, a few at a time, and are cached per split date and index version.
  const splitCache = new Map();
  const splitQueue = [];
  let splitInFlight = 0;

  function splitChip(id) {
    const key = `${id}|${state.get('signatureSplitAt')}|${state.get('indexVersion')}`;
    const c = splitCache.get(key);
    if (!c) {
      splitCache.set(key, { loading: true });
      splitQueue.push({ id, key, at: state.get('signatureSplitAt') });
      pumpSplits();
    }
    if (!c || c.loading) return h('span', { class: 'fx-split t-meta' }, 'rate…');
    if (c.error) return h('span', { class: 'fx-split t-meta', title: c.error }, 'rate unavailable');
    const sum = splitSummary(c.split);
    // Plain text; only the arrow takes color (§6.2 Rate change).
    return sum ? h('span', { class: 'fx-split', dataset: { drop: '3' }, title: `Failures before → after ${localDay(state.get('signatureSplitAt'))}\n${sum.title}` }, sum.rates.replace(/ [▲▼≈].*$/, ''),
      sum.dir === 'higher' ? h('span', { class: 'err' }, ' ▲') : sum.dir === 'lower' ? h('span', { class: 'ok' }, ' ▼') : null) : null;
  }

  function pumpSplits() {
    while (splitInFlight < 4 && splitQueue.length) {
      const job = splitQueue.shift();
      splitInFlight++;
      api.signature(job.id, { splitAt: job.at })
        .then((d) => splitCache.set(job.key, { split: d?.split ?? null }), (err) => splitCache.set(job.key, { error: err.message }))
        .finally(() => {
          splitInFlight--;
          pumpSplits();
          if (visible) list.refresh();
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Selection and keyboard

  const itemIndexes = () => model.map((m, i) => (m.type === 'item' ? i : -1)).filter((i) => i >= 0);

  function select(i, { focusLens = false } = {}) {
    const m = model[i];
    if (m?.type !== 'item') return;
    selectedKey = rowKey(m.r);
    list.scrollToIndex(i, 30);
    list.refresh();
    queueEl.setAttribute('aria-activedescendant', '');
    app.openQueueRow(m.r, { reveal: false });
    if (root.classList.contains('is-narrow')) setPane('lens');
    if (focusLens) lens.focus();
  }

  /** Select the queue row that matches the Lens item, when it is loaded. */
  function syncSelection() {
    const it = state.get('lensItem');
    if (!it) return;
    const key = `${it.kind}:${it.id}`;
    const find = () => model.findIndex((m) => m.type === 'item' && rowKey(m.r) === key);
    let i = find();
    // A loaded row past a section's preview page unfolds that section (buildModel keeps the Lens item in view).
    if (i < 0 && status === 'ready' && [...sections.values()].some((sec) => sec.rows.some((r) => rowKey(r) === key))) {
      render();
      i = find();
    }
    if (i >= 0 && selectedKey !== key) {
      selectedKey = key;
      list.scrollToIndex(i, 30);
      list.refresh();
    }
  }

  // ---------------------------------------------------------------------------
  // Section index (§7.5): name and count per non-empty section, attention sections with a dot, the section at the
  // top of the queue marked; items that do not fit collapse into a trailing "+n ▾" menu, so it never wraps.

  let indexItems = [];
  function renderIndex() {
    const secs = status === 'ready' && facets().group === 'attention' ? model.filter((m) => m.type === 'section') : [];
    indexBar.hidden = !secs.length;
    indexItems = secs.map((m) => h('button', {
      class: ['fx-idx', SECTION[m.s].attention && ['alarms', 'blocked', 'unrecovered', 'silent-child'].includes(m.s) && 'needs'], type: 'button', dataset: { jump: m.s },
      'aria-label': `${SECTION[m.s].label}, ${formatInt(m.total)} ${m.total === 1 ? SECTION[m.s].unit : `${SECTION[m.s].unit}s`}`,
    }, h('span', { class: 'fx-idx-name' }, SECTION[m.s].short), h('span', { class: 'fx-idx-n' }, formatInt(m.total))));
    const more = h('button', { class: 'tool-btn fx-idx-more', type: 'button', 'aria-haspopup': 'menu', hidden: true });
    indexBar.replaceChildren(...indexItems, more);
    if (indexBar.hidden) return;
    // Move trailing items into the menu until the row fits.
    requestAnimationFrame(() => {
      const hiddenItems = [];
      for (let i = indexItems.length - 1; i > 0 && indexBar.scrollWidth > indexBar.clientWidth + 1; i--) {
        indexItems[i].hidden = true;
        hiddenItems.unshift(secs[i]);
        more.hidden = false;
        more.replaceChildren(`+${hiddenItems.length}`, icon('down', 10));
      }
      more.onclick = () => showMenu(more, hiddenItems.map((m) => ({ label: SECTION[m.s].label, hint: formatInt(m.total), onSelect: () => jumpTo(m.s) })));
      markIndex();
    });
  }

  /**
   * Mark the section whose rows are at the top of the queue (a header just below the top edge counts, since a
   * selected row scrolls in with a margin); at the bottom, the last section whose header shows.
   */
  function markIndex() {
    if (indexBar.hidden) return;
    let cur = null;
    const probe = queueEl.scrollTop + 40;
    let top = Math.max(0, list.firstVisible());
    while (top + 1 < model.length && list.offsetOf(top + 1) <= probe) top++;
    for (let i = top; i >= 0 && !cur; i--) if (model[i]?.type === 'section') cur = model[i].s;
    if (queueEl.scrollTop + queueEl.clientHeight >= queueEl.scrollHeight - 2) {
      model.forEach((m, i) => {
        if (m.type === 'section' && list.offsetOf(i) >= queueEl.scrollTop) cur = m.s;
      });
    }
    for (const b of indexItems) {
      b.classList.toggle('on', b.dataset.jump === cur);
      b.setAttribute('aria-current', b.dataset.jump === cur ? 'true' : 'false');
    }
    currentSection = cur;
  }
  let currentSection = null;

  /** Scroll a section header to the top, opening the section first when it is collapsed. */
  function jumpTo(s) {
    pendingJump = s;
    if (!isOpen(s)) return toggleSection(s);
    const i = model.findIndex((m) => m.type === 'section' && m.s === s);
    if (i < 0 || sections.get(s)?.loading) return; // render() comes back once the rows are in
    pendingJump = null;
    queueEl.scrollTop = list.offsetOf(i);
    markIndex();
  }

  /** Alt+↑ and Alt+↓: the previous or next section (§7.5). */
  function stepSection(dir) {
    const secs = model.filter((m) => m.type === 'section').map((m) => m.s);
    if (!secs.length) return;
    const i = secs.indexOf(currentSection);
    jumpTo(secs[Math.max(0, Math.min(secs.length - 1, (i < 0 ? 0 : i + dir)))]);
  }
  root.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.target.closest('input, textarea, select')) return;
    e.preventDefault();
    stepSection(e.key === 'ArrowDown' ? 1 : -1);
  });

  indexBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-jump]');
    if (b) jumpTo(b.dataset.jump);
  });
  queueEl.addEventListener('scroll', () => requestAnimationFrame(markIndex), { passive: true });

  queueEl.addEventListener('click', (e) => {
    const all = e.target.closest('[data-show-all]');
    if (all) {
      shownAll.add(all.dataset.showAll);
      return render();
    }
    const more = e.target.closest('[data-more]');
    if (more) return more.dataset.more ? loadSection(more.dataset.more, { more: true }) : loadMoreFlat();
    const sec = e.target.closest('[data-section]');
    if (sec) {
      pendingJump = null;
      return toggleSection(sec.dataset.section);
    }
    const row = e.target.closest('[data-vi]');
    if (row) select(Number(row.dataset.vi));
  });

  function toggleSection(s) {
    const open = !isOpen(s);
    openState.set(s, open);
    const sec = sections.get(s);
    if (open && (!sec || sec.rows.length < Math.min(sec.total, PAGE))) loadSection(s);
    else render();
  }

  queueEl.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const items = itemIndexes();
    const cur = model.findIndex((m) => m.type === 'item' && rowKey(m.r) === selectedKey);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      const k = items.indexOf(cur);
      const next = k < 0 ? items[0] : items[Math.max(0, Math.min(items.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)))];
      select(next);
    } else if (e.key === 'Enter' && cur >= 0) {
      e.preventDefault();
      lens.focus();
    }
  });

  // ---------------------------------------------------------------------------
  // Wiring

  const reload = debounce(() => load(), 60);
  state.subscribe(['failureFacets'], () => {
    renderToolbar(summary);
    reload();
  });
  state.subscribe(['view', 'viewLoading', 'viewError', 'scope', 'filter'], () => {
    if (visible) reload();
  });
  state.subscribe(['indexVersion'], () => {
    if (!visible) return;
    const wait = lastLoad + LIVE_REFRESH_MS - Date.now();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => load(), Math.max(0, wait));
  });
  state.subscribe(['lensItem'], (s) => {
    lensScope = scopeKey();
    renderToolbar(summary);
    if (s.lensItem) lens.show(s.lensItem);
    else lens.clear();
    if (s.lensItem && root.classList.contains('is-narrow')) setPane('lens');
    syncSelection();
  });
  state.subscribe(['info'], () => {
    if (visible && status === 'unsupported' && api.features.derived) load({ force: true });
  });

  layout();
  if (state.get('lensItem')) {
    lensScope = scopeKey();
    lens.show(state.get('lensItem'));
  }

  return {
    show() {
      visible = true;
      layout();
      load();
      publish();
    },
    hide() {
      visible = false;
      clearTimeout(refreshTimer);
    },
  };
}
