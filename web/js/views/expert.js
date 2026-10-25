// Diagnostics workspace (SPEC §3.8, §7.5, §7.8): entries grouped by severity, then by group.
// The route and the API keep the name "expert"; the UI says Diagnostics, and the lowest
// severity (API "chat") is shown as Info. "Current view only" (default on) never falls back to
// the whole index when the view is loading or failed. Clicking an entry jumps to its event.

import { h, icon, mark, agentDot, placeholder, showMenu, autoTitle, setScopeLabel, debounce } from '../lib/dom.js';
import { formatInt, formatAgo, shortId, stampTitle, agentLabel, agentColor, plural } from '../lib/format.js';
import { loadPref, savePref } from '../state.js';

const SEVERITIES = ['error', 'warn', 'note', 'chat'];
const SEV_LABEL = { error: 'Errors', warn: 'Warnings', note: 'Notes', chat: 'Info' };
const SEV_BADGE = { error: 'error', warn: 'warning', note: 'note', chat: 'info' };
/** The severity mark (§6.3) and its color (§5.2 item 1). */
const SEV_MARK = { error: ['failed', 'var(--err)'], warn: ['degraded', 'var(--warn)'], note: ['info', 'var(--note)'], chat: ['info', 'var(--fg-muted)'] };
const SORTS = [{ id: 'time', label: 'Newest first' }, { id: 'count', label: 'Count' }];

const GROUP_INFO = {
  malformed: 'Source lines that are not valid JSON',
  undecoded: 'Record types AgentShark does not decode yet',
  unpaired: 'Calls without a result, or results without a call',
  'tool-error': 'Tool calls that failed',
  'api-error': 'Model API errors',
  retry: 'API retries with backoff',
  refusal: 'Model refusals',
  interrupted: 'Turns or tools interrupted by the user or the harness',
  'permission-denied': 'Permission requests that were denied',
  compaction: 'Context compactions',
  'logging-gap': 'Missing transcripts, timestamp inversions and other logging gaps',
  sequence: 'Ordering anomalies between records',
  'rate-limit': 'Rate-limit events',
  loop: 'Failure episodes with five or more attempts of one signature',
  'silent-child': 'Subagents that failed while the parent was not told',
  audit: 'Permission posture notes (advisory)',
};

/** Items rendered per "show more" step inside one group. */
const ITEM_PAGE = 100;
/** Whole-index diagnostics follow index runs at most this often. */
const GLOBAL_REFRESH_MS = 30_000;

const exact = formatInt;

export default function createExpert(root, app) {
  root.classList.add('ex-root');
  const saved = loadPref('expert.severities', SEVERITIES);
  const shown = new Set((Array.isArray(saved) ? saved : SEVERITIES).filter((s) => SEVERITIES.includes(s)));
  let viewOnly = loadPref('expert.viewOnly', true) !== false;
  let data = null;
  let loadedKey = null;
  let seq = 0;
  let visible = false;
  let globalVersion = 0;
  let lastGlobal = 0;
  /** Groups the user opened, kept across reloads. */
  const openGroups = new Set();

  // Workspace header (§7.3, §7.14): the scope label, then Sort ▾ and "Current view only".
  let sort = loadPref('expert.sort', 'time');
  const collapsed = new Set(SEVERITIES.filter((sev) => !shown.has(sev)));
  const viewBox = h('input', { type: 'checkbox', checked: viewOnly });
  const scopeLine = h('div', { class: 'ws-scope ex-scope', 'aria-live': 'polite' });
  const sortBtn = h('button', { class: 'tool-btn', type: 'button', 'aria-haspopup': 'menu' });
  const renderSort = () => sortBtn.replaceChildren(`Sort: ${SORTS.find((x) => x.id === sort)?.label}`, icon('down', 10));
  renderSort();
  sortBtn.addEventListener('click', () => showMenu(sortBtn, [
    ...SORTS.map((x) => ({ label: x.label, checked: sort === x.id, onSelect: () => {
      sort = x.id;
      savePref('expert.sort', sort);
      renderSort();
      render();
    } })),
    { separator: true },
    { header: 'Show' },
    ...SEVERITIES.map((sev) => ({ label: SEV_LABEL[sev], checked: !collapsed.has(sev), onSelect: () => toggleSeverity(sev) })),
  ]));
  // The message filter is the first inline control; Sort ▾ also shows or hides each severity (DESIGN Mac and Web
  // notes, so both clients offer the same controls).
  let query = '';
  const search = h('input', { class: 'pn-input ex-search', type: 'search', placeholder: 'Filter messages', 'aria-label': 'Filter diagnostic messages' });
  search.addEventListener('input', debounce(() => {
    query = search.value.trim().toLowerCase();
    render();
  }, 150));
  const list = h('div', { class: 'ex-list', 'data-f6': '' });
  root.append(
    h('div', { class: 'ws-head' }, scopeLine,
      h('div', { class: 'ws-controls' }, search, sortBtn,
        h('label', { class: 'ws-ctl', title: 'Only entries whose event or session is in the current view' }, viewBox, 'Current view only'))),
    list,
  );

  viewBox.addEventListener('change', () => {
    viewOnly = viewBox.checked;
    savePref('expert.viewOnly', viewOnly);
    load();
  });

  app.state.subscribe(['view', 'viewLoading', 'viewError'], () => {
    if (visible) load();
  });
  app.state.subscribe(['indexVersion'], () => {
    // The current view already follows index runs; the whole-index list refreshes on its own clock.
    if (viewOnly || !app.changeAffects(null) || Date.now() - lastGlobal < GLOBAL_REFRESH_MS) return;
    globalVersion++;
    if (visible) load();
  });

  /** The scope label (§7.3): "190 entries · current view · 1 session + subagents · no filter". */
  function publishScope(n) {
    const what = viewOnly ? `current view · ${app.scopeText()}` : 'whole index, the current view not applied';
    const text = n != null ? `${plural(n, 'entry').replace('entrys', 'entries')} · ${what}` : `Diagnostics · ${what}`;
    setScopeLabel(scopeLine, text);
    app.setWorkspaceStatus('expert', text);
  }

  /** Global requests name the whole index explicitly; an older server takes the absence of a view. */
  async function fetchGlobal() {
    if (app.features.globalView !== false) {
      try {
        const res = await app.api.expert({ view: 'global' });
        app.features.globalView = true;
        return res;
      } catch (err) {
        if (err.status !== 404) throw err;
        app.features.globalView = false;
      }
    }
    return app.api.expert({});
  }

  async function load() {
    const vs = app.viewState();
    if (viewOnly && vs.status !== 'ready' && vs.status !== 'ready-empty') {
      loadedKey = null;
      seq++;
      data = null;
      publishScope(null);
      list.replaceChildren(vs.status === 'failed'
        ? placeholder('error', 'Could not load this view.', ['Your selection is preserved.', h('div', { class: 't-meta' }, vs.error?.message ?? '')], { label: 'Retry', onClick: app.retryView })
        : placeholder('loading', `Loading ${app.scopeText()}…`));
      return;
    }
    const k = viewOnly ? `v:${vs.view.viewId}` : `g:${globalVersion}`;
    if (k === loadedKey) return;
    loadedKey = k;
    const mine = ++seq;
    list.replaceChildren(placeholder('loading', 'Loading diagnostics…'));
    try {
      const res = viewOnly ? await app.api.expert({ view: vs.view.viewId }) : await fetchGlobal();
      if (mine !== seq) return;
      if (!viewOnly) lastGlobal = Date.now();
      data = Array.isArray(res?.groups) ? res.groups : [];
      render();
    } catch (err) {
      if (mine !== seq) return;
      loadedKey = null;
      data = null;
      if (app.handleViewError(err)) {
        list.replaceChildren(placeholder('loading', 'The view expired on the server; rebuilding it…'));
        return;
      }
      list.replaceChildren(placeholder('error', 'Could not load this view.', ['Your selection is preserved.', h('div', { class: 't-meta' }, String(err?.message ?? err))], { label: 'Retry', onClick: load }));
    }
  }

  function toggleSeverity(sev) {
    if (collapsed.has(sev)) collapsed.delete(sev);
    else collapsed.add(sev);
    shown.clear();
    for (const x of SEVERITIES) if (!collapsed.has(x)) shown.add(x);
    savePref('expert.severities', [...shown]);
    render();
  }
  const matches = (it) => !query || it.message?.toLowerCase().includes(query) || app.sessionById(it.session)?.title?.toLowerCase().includes(query);

  /** Entries newest first (§7.14); groups by their newest entry, or by count. */
  const byTime = (a, b) => (b.ts ?? 0) - (a.ts ?? 0);
  const newest = (g) => Math.max(0, ...(g.items ?? []).map((it) => it.ts ?? 0));

  function render() {
    if (!data) return;
    const totals = {};
    for (const g of data) totals[g.severity] = (totals[g.severity] ?? 0) + (g.count ?? 0);
    publishScope(Object.values(totals).reduce((a, b) => a + b, 0));
    if (!data.length) {
      list.replaceChildren(placeholder('empty', 'No diagnostics', viewOnly ? 'Nothing was flagged for the events in the current view.' : 'The index has no diagnostics.',
        viewOnly ? { label: 'Show the Whole Index', onClick: () => { viewBox.checked = false; viewBox.dispatchEvent(new Event('change')); } } : null));
      return;
    }
    const sections = [];
    for (const sev of SEVERITIES) {
      const groups = data.filter((g) => g.severity === sev && (!query || (g.items ?? []).some(matches))).sort((a, b) => (sort === 'count' ? b.count - a.count : newest(b) - newest(a)));
      if (!groups.length) continue;
      const open = !collapsed.has(sev);
      const [mk, color] = SEV_MARK[sev];
      // Severity group header (§7.5 Group header): disclosure, mark and name, the count right-aligned.
      const head = h('button', { class: 'ex-sev-head', type: 'button', 'aria-expanded': String(open) },
        h('span', { class: ['twisty', open && 'open'] }, icon('chevron', 10)),
        h('span', { class: 'ex-sev-mark', style: { color } }, mark(mk)), SEV_LABEL[sev],
        h('span', { class: 'ex-n' }, exact(totals[sev] ?? 0)));
      head.addEventListener('click', () => toggleSeverity(sev));
      sections.push(h('section', { class: `ex-sev ex-sev-${sev}` }, head, open ? groups.map((g) => renderGroup(g, groups.length <= 2)) : null));
    }
    list.replaceChildren(...sections);
  }

  function renderGroup(g, openByDefault) {
    const id = `${g.severity}/${g.group}`;
    const items = (g.items ?? []).filter(matches).sort(byTime);
    const det = h('details', { class: 'ex-group', open: openGroups.has(id) || openByDefault || !!query },
      h('summary', null,
        h('span', { class: 'ex-group-name' }, GROUP_INFO[g.group] ?? g.group),
        h('span', { class: 'ex-n' }, exact(g.count))));
    const ul = h('ul', { class: 'ex-items' });
    let rendered = 0;
    const more = h('button', { class: 'btn' });
    const fill = () => {
      ul.append(...items.slice(rendered, rendered + ITEM_PAGE).map((it) => renderItem(it, g)));
      rendered = Math.min(items.length, rendered + ITEM_PAGE);
      more.textContent = `Show ${exact(Math.min(ITEM_PAGE, items.length - rendered))} More`;
      more.hidden = rendered >= items.length;
    };
    more.addEventListener('click', fill);
    det.addEventListener('toggle', () => {
      if (det.open) openGroups.add(id);
      else openGroups.delete(id);
      if (det.open && !rendered && items.length) fill();
    });
    det.append(ul, more);
    more.hidden = true;
    if (det.open && items.length) fill();
    if (items.length < g.count) det.append(h('div', { class: 'ex-note t-meta' }, `${exact(items.length)} of ${exact(g.count)} entries shown; narrow the view to see the rest.`));
    return det;
  }

  /**
   * An entry (§7.14): line 1 the severity mark and the message; line 2 the session title (not its id), the agent,
   * the time and the rule (muted).
   */
  function renderItem(it, g) {
    const openSession = () => app.openSession(it.session, { workspace: 'events' });
    const target = it.event ? () => app.selectEvent(it.event) : it.session ? openSession : null;
    const s = it.session ? app.sessionById(it.session) : null;
    const [mk, color] = SEV_MARK[g.severity] ?? SEV_MARK.note;
    const title = s?.title || (it.session ? shortId(it.session) : null);
    return h('li', {
      class: `ex-item${target ? ' is-clickable' : ''}`,
      tabindex: target ? 0 : null,
      onclick: target,
      onkeydown: target ? (e) => e.key === 'Enter' && target() : null,
    },
    h('div', { class: 'ex-l1' }, h('span', { class: 'ex-mark', style: { color } }, mark(mk, { label: SEV_BADGE[g.severity] })), autoTitle(h('span', { class: 'ex-msg' }, it.message ?? ''), it.message ?? '')),
    h('div', { class: 'ex-l2' },
      title ? autoTitle(h('span', { class: 'ex-title' }, title), title) : h('span', { class: 'faint' }, 'no session'),
      s?.agent ? h('span', { class: 'ex-agent' }, agentDot(agentColor(s.agent)), agentLabel(s.agent)) : null,
      h('time', { class: 'ex-time', title: it.ts != null ? stampTitle(it.ts, 0) : 'No timestamp recorded' }, it.ts != null ? formatAgo(it.ts) : '—'),
      h('span', { class: 'ex-rule faint' }, g.group),
      it.episodeId ? h('button', { class: 'lens-link', type: 'button', onclick: (e) => { e.stopPropagation(); app.openEpisode(it.episodeId); } }, 'Episode ›') : null));
  }

  return {
    show() {
      visible = true;
      publishScope(null);
      load();
    },
    hide() {
      visible = false;
    },
  };
}
