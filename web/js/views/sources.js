// Sources workspace: the logging-health report (SPEC §8). It answers "am I logging correctly?":
// the most important findings first, then one card per agent, then every source file.
// The report is expensive on a large index, so it is fetched when the tab first opens and on
// Refresh, never on every index run (W01). In capture mode it describes the captured evidence,
// with this machine's health as a separately labeled alternative (SPEC §7.8).

import { copyText, debounce, h, placeholder, setScopeLabel } from '../lib/dom.js';
import { agentLabel, formatAgo, formatBytes, formatClock, formatDate, formatInt, formatStamp, formatTokens, plural, stampTitle, toMicros, tzOffset } from '../lib/format.js';
import { createVirtualList } from '../lib/virtual.js';

const SEV_RANK = { error: 0, warn: 1, note: 2, chat: 3 };

/** Capability order and labels (Capability in src/model/types.ts). */
const CAPABILITIES = {
  timestamps: 'Timestamps',
  'llm-latency': 'Model-call latency',
  ttft: 'Time to first token',
  'tool-durations': 'Tool durations',
  'exit-codes': 'Exit codes',
  'token-usage': 'Token usage',
  'cache-tokens': 'Cache tokens',
  'reasoning-text': 'Reasoning text',
  'system-prompt': 'System prompt',
  'tool-definitions': 'Tool definitions',
  'subagent-tree': 'Subagent tree',
  'file-diffs': 'File diffs / backups',
  cost: 'Cost',
  'raw-http': 'Raw HTTP',
  'permission-decisions': 'Permission decisions',
};
const CAP_ORDER = Object.keys(CAPABILITIES);

const LEVELS = {
  logged: 'The agent writes this value',
  derived: 'AgentShark computes it from other logged fields',
  partial: 'Present for some records only',
  absent: 'Not in the logs',
};

/** Lines in a recommendation that are configuration or commands, shown as copyable code. */
const CODE_LINE = [
  /^\s*(export\s+)?[A-Z][A-Z0-9_]*=\S*/, // environment variable assignment
  /^\s*\[[\w.-]+\]\s*$/, // TOML table header
  /^\s*[a-z_][\w.-]*\s*=\s*\S/, // TOML key = value
  /^\s*(\$\s+|agentshark\s)/, // shell command
  /^\s*[{}[\]],?\s*$|^\s*"[^"]+"\s*:/, // JSON
];

const FILE_COLS = [
  { key: 'path', label: 'Path' },
  { key: 'agent', label: 'Agent' },
  { key: 'kind', label: 'Kind' },
  { key: 'size', label: 'Size', num: true },
  { key: 'lines', label: 'Lines', num: true },
  { key: 'malformed', label: 'Malformed', num: true },
  { key: 'unknown', label: 'Unknown', num: true },
  { key: 'status', label: 'Status' },
  { key: 'indexedAt', label: 'Indexed', num: true },
];
const ROW_H = 24;
const MAX_VISIBLE_ROWS = 20;

const exact = (n) => formatInt(n) || '—';
// The API keeps the severity name `chat`; the viewer and the CLI call it info.
const SEV_TEXT = { chat: 'info' };
const sevBadge = (sev) => h('span', { class: `pn-badge pn-sev-${sev}` }, SEV_TEXT[sev] ?? sev);
const bySeverity = (a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9);

/** Shared in-flight requests, so two openings never compute the report twice. */
const inflight = new Map();
function fetchReport(app, local) {
  const key = local ? 'local' : 'default';
  if (!inflight.has(key)) {
    const p = app.api.sources(local ? { local: true } : {}).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return inflight.get(key);
}

const ISO = /\b(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))\b/g;
/** ISO timestamps inside finding text, shown in local time with the offset. */
function localizeIso(text) {
  return String(text ?? '').replace(ISO, (m) => {
    const ms = Date.parse(m);
    return Number.isNaN(ms) ? m : formatClock(ms * 1000, { digits: 0, offset: true });
  });
}

const isProblem = (s) => s.malformed > 0 || s.unknown > 0 || s.status !== 'ok' || !s.existsNow || !!s.error;

function fileStatus(s) {
  if (!s.existsNow) return { label: 'deleted', kind: 'warn', title: 'The file is gone from disk; its indexed rows are kept' };
  if (s.status !== 'ok' || s.error) return { label: s.status === 'ok' ? 'error' : s.status, kind: 'err', title: s.error ?? null };
  return { label: 'ok', kind: 'ok', title: null };
}

/** Copy `text`; on failure select `target` so the user can copy it by hand. */
async function copyWithFeedback(text, target, done) {
  if (await copyText(text)) {
    done('Copied');
  } else {
    getSelection()?.selectAllChildren(target);
    done('Selected: press Ctrl+C');
  }
}

function codeBlock(text, lang) {
  const pre = h('pre', { class: 'so-pre', 'data-lang': lang ?? null, 'aria-label': lang ? `${lang} snippet` : 'snippet' }, text);
  const btn = h('button', { class: 'btn pn-sm so-copy' }, 'Copy');
  btn.addEventListener('click', () => copyWithFeedback(text, pre, (msg) => {
    btn.textContent = msg;
    setTimeout(() => (btn.textContent = 'Copy'), 1600);
  }));
  return h('div', { class: 'so-code' }, lang ? h('span', { class: 'so-lang' }, lang) : null, pre, btn);
}

/**
 * A recommendation: structured {text, code: {lang, snippet}, effect} from a current server, so Copy
 * returns only runnable code; older servers send one string, parsed heuristically.
 */
function recommendation(rec) {
  if (rec && typeof rec === 'object') {
    return [
      rec.effect ? h('div', { class: 'so-effect' }, h('strong', null, 'Effect: '), rec.effect) : null,
      rec.text ? prose(rec.text) : null,
      rec.code?.snippet ? codeBlock(rec.code.snippet, rec.code.lang) : null,
    ].filter(Boolean);
  }
  return [richText(rec)];
}

/** Prose with `inline code` chips that copy on click. */
function prose(text) {
  const p = h('p', { class: 'so-p' });
  localizeIso(text).split(/`([^`]+)`/).forEach((part, i) => {
    if (!(i % 2)) {
      if (part) p.append(part);
      return;
    }
    const code = h('code', { class: 'so-icode', tabindex: '0', title: 'Click to copy' }, part);
    const copy = () => copyWithFeedback(part, code, () => {
      code.classList.add('is-copied');
      setTimeout(() => code.classList.remove('is-copied'), 1200);
    });
    code.addEventListener('click', copy);
    code.addEventListener('keydown', (e) => e.key === 'Enter' && copy());
    p.append(code);
  });
  return p;
}

/** Recommendation text: fenced blocks and config-looking lines become copyable code blocks. */
function richText(text) {
  const out = document.createDocumentFragment();
  String(text ?? '').split(/```[\w-]*\n?/).forEach((part, i) => {
    if (i % 2) {
      if (part.trim()) out.append(codeBlock(part.replace(/\n+$/, '')));
      return;
    }
    let words = [];
    let code = [];
    const flushWords = () => {
      if (words.length) out.append(prose(words.join(' ')));
      words = [];
    };
    const flushCode = () => {
      if (code.length) out.append(codeBlock(code.join('\n')));
      code = [];
    };
    for (const line of part.split('\n')) {
      if (!line.trim()) {
        flushWords();
        flushCode();
      } else if (CODE_LINE.some((re) => re.test(line))) {
        flushWords();
        code.push(line.replace(/^\s*\$\s+/, ''));
      } else {
        flushCode();
        words.push(line.trim());
      }
    }
    flushWords();
    flushCode();
  });
  return out;
}

// ---------------------------------------------------------------------------

export default function createSources(root, app) {
  root.classList.add('so-root');
  let visible = false;
  let seq = 0;
  let report = null;
  let fetchedAt = null; // µs; the server's computedAt when it reports one
  let local = false; // capture mode: show this machine instead of the captured evidence

  // Refresh shows only while the index changed after the report (the report is never refetched on its own).
  const refreshBtn = h('button', { class: 'tool-btn', type: 'button', hidden: true, onclick: () => load(true) }, 'Refresh');
  const age = h('span', { class: 'so-age t-meta' });
  const scopeToggle = h('div', { class: 'seg', role: 'group', 'aria-label': 'Which machine the report describes', hidden: true });
  const headline = h('div', { class: 'ws-scope so-headline' });
  const provenance = h('section', { class: 'so-capture', hidden: true });
  const top = h('section', { class: 'so-top' });
  const cards = h('div', { class: 'so-cards' });
  const legend = h('div', { class: 'so-legend' }, 'Capability levels:',
    Object.entries(LEVELS).map(([lvl, desc]) => h('span', { class: `so-level is-${lvl}`, title: desc }, lvl)));
  const files = createFileTable();
  const title = h('h2', null, 'Logging health');
  // Workspace header (§7.3): the scope label; Sources has no inline controls beyond the capture toggle.
  root.append(h('div', { class: 'ws-head so-wshead' }, headline, h('div', { class: 'ws-controls' }, scopeToggle, age, refreshBtn)), h('div', { class: 'so-body', 'data-f6': '' },
    provenance,
    top,
    h('section', { class: 'so-agents' }, h('div', { class: 'so-section-head' }, h('h3', null, 'Agents'), legend), cards),
    files.el));

  const capture = () => app.state.get('info')?.mode === 'capture';

  /** Report age, and whether the index changed since; the report is never refetched on its own. */
  function renderAge() {
    if (!fetchedAt) return age.replaceChildren();
    const info = app.state.get('info');
    // Only a server that reports when sessions last changed can say the report is behind.
    const changed = toMicros(info?.lastChangeAt);
    const outdated = !capture() && changed && changed > fetchedAt;
    age.replaceChildren(...[
      h('span', { title: stampTitle(fetchedAt, 0) }, `Report from ${formatAgo(fetchedAt)}`),
      report?.stale ? h('span', { class: 'so-stale' }, ' · being recomputed') : null,
      outdated ? h('span', { class: 'so-stale' }, ' · the index changed since') : null,
    ].filter(Boolean));
    refreshBtn.hidden = !outdated;
  }

  function publishScope() {
    const scope = report?.scope ?? (capture() && !local ? 'captured' : 'local');
    const text = scope === 'captured'
      ? `Captured sources${report?.host ? ` from ${report.host}` : ''} · the evidence inside the capture`
      : capture()
        ? 'This machine (local) · not the machine that wrote the capture'
        : 'All indexed sources (local machine) · the session, time and filter scope does not apply';
    title.textContent = scope === 'captured' ? 'Captured sources' : capture() ? 'Logging health of this machine' : 'Logging health';
    app.setWorkspaceStatus('sources', text);
  }

  function renderToggle() {
    scopeToggle.hidden = !capture();
    if (!capture()) return;
    scopeToggle.replaceChildren(...[[false, 'Captured sources'], [true, 'This machine']].map(([v, label]) =>
      h('button', {
        class: `seg-btn${local === v ? ' on' : ''}`,
        'aria-pressed': String(local === v),
        title: v ? 'Logging health of the machine running this viewer; it says nothing about the capture' : 'The evidence inside the capture file',
        onclick: () => {
          if (local === v) return;
          local = v;
          report = null;
          renderToggle();
          load(true);
        },
      }, label)));
  }

  function renderProvenance() {
    const facts = capture() && !local ? app.captureFacts?.().facts ?? [] : [];
    provenance.hidden = !facts.length;
    if (!facts.length) return;
    provenance.replaceChildren(
      h('h3', null, 'Capture'),
      h('dl', { class: 'so-capture-facts' }, facts.flatMap(([k, v, warn]) => [h('dt', null, k), h('dd', { class: warn ? 'is-warn' : null }, v)])),
    );
  }

  async function load(force = false) {
    if (report && !force) {
      renderAge();
      return;
    }
    const mine = ++seq;
    refreshBtn.disabled = true;
    renderToggle();
    renderProvenance();
    publishScope();
    if (!report) top.replaceChildren(placeholder('loading', 'Checking every agent’s logs… On a large index the first report can take half a minute.'));
    try {
      const res = await fetchReport(app, capture() && local);
      if (mine !== seq) return;
      report = {
        agents: Array.isArray(res?.agents) ? res.agents : [],
        sources: Array.isArray(res?.sources) ? res.sources : [],
        scope: res?.scope ?? null,
        host: res?.host ?? null,
        stale: !!res?.stale,
      };
      fetchedAt = toMicros(res?.computedAt) ?? Date.now() * 1000;
      render();
      publishScope();
      renderAge();
    } catch (err) {
      if (mine !== seq) return;
      top.replaceChildren(placeholder('error', 'Could not build the logging-health report', String(err?.message ?? err), { label: 'Retry', onClick: () => load(true) }));
    } finally {
      if (mine === seq) refreshBtn.disabled = false;
    }
  }

  app.state.subscribe(['info'], () => {
    if (!visible) return;
    renderAge();
    renderToggle();
    renderProvenance();
    publishScope();
  });
  setInterval(() => visible && renderAge(), 30_000);

  function render() {
    // Detected agents first, then the one with the most severe finding, then the largest.
    const worst = (a) => Math.min(9, ...(a.findings ?? []).map((f) => SEV_RANK[f.severity] ?? 9));
    const agents = report.agents.slice().sort((a, b) =>
      Number(b.detected) - Number(a.detected) || worst(a) - worst(b) || (b.files ?? 0) - (a.files ?? 0));
    const findings = agents
      .flatMap((a) => (a.findings ?? []).map((f) => ({ ...f, agent: a.agent, label: a.label || agentLabel(a.agent) })))
      .sort(bySeverity);
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warns = findings.filter((f) => f.severity === 'warn').length;
    const detected = agents.filter((a) => a.detected);
    const totalFiles = detected.reduce((n, a) => n + (a.files ?? 0), 0);
    const totalBytes = detected.reduce((n, a) => n + (a.bytes ?? 0), 0);

    setScopeLabel(headline, `${detected.length} of ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} found · ${exact(totalFiles)} files · ${formatBytes(totalBytes) || '0 B'}`);

    const verdict = !detected.length
      ? h('div', { class: 'so-verdict is-warn' }, h('strong', null, 'No supported agent logs found. '),
        report.scope === 'captured' ? 'This capture holds no source files.' : 'Each agent card below lists the locations that were checked.')
      : errors || warns
      ? h('div', { class: `so-verdict ${errors ? 'is-err' : 'is-warn'}` },
        h('strong', null, 'Needs attention: '),
        [errors ? plural(errors, 'error') : null, warns ? plural(warns, 'warning') : null].filter(Boolean).join(', '),
        '. The list below starts with the most important one.')
      : h('div', { class: 'so-verdict is-ok' }, h('strong', null, 'Logging looks healthy. '), findings.length ? 'The notes below show how to log even more.' : 'No findings.');
    const TOP_N = 5;
    const jump = (agent) => cards.querySelector(`[data-agent="${CSS.escape(String(agent))}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    top.replaceChildren(...[
      verdict,
      findings.length
        ? h('ol', { class: 'so-top-list' }, findings.slice(0, TOP_N).map((f) =>
          h('li', null,
            h('button', { class: 'so-top-item', title: 'Show this finding in its agent card', onclick: () => jump(f.agent) },
              sevBadge(f.severity), h('span', { class: 'so-top-agent' }, f.label), h('span', { class: 'so-top-title' }, localizeIso(f.title)),
              f.recommendation?.effect ? h('span', { class: 'so-top-effect' }, f.recommendation.effect) : null))))
        : null,
      findings.length > TOP_N ? h('div', { class: 'so-more' }, `${findings.length - TOP_N} more findings in the agent cards below.`) : null,
    ].filter(Boolean));

    cards.replaceChildren(...(agents.length ? agents.map(agentCard) : [placeholder('empty', 'No agents reported')]));
    files.setData(report.sources);
  }

  function agentCard(a) {
    const findings = (a.findings ?? []).slice().sort(bySeverity);
    const head = h('header', { class: 'so-card-head' },
      h('h3', null, a.label || agentLabel(a.agent)),
      h('span', { class: `pn-chip${a.detected ? ' is-ok' : ''}` }, a.detected ? 'detected' : 'not found'),
      a.detected ? h('span', { class: `pn-chip ${a.parsed ? 'is-ok' : 'is-warn'}` }, a.parsed ? 'parsed' : 'not parsed') : null,
      h('span', { class: 'pn-spacer' }),
      ['error', 'warn'].map((sev) => {
        const n = findings.filter((f) => f.severity === sev).length;
        return n ? h('span', { class: `pn-badge pn-sev-${sev}` }, `${n} ${sev}`) : null;
      }));
    const card = h('article', { class: `so-card so-ag-${a.agent}${a.detected ? '' : ' is-absent'}`, 'data-agent': String(a.agent) }, head);

    if (a.detected) card.append(...[inventory(a), capabilityGrid(a.capabilities ?? [])].filter(Boolean));
    else {
      const looked = a.searched?.length ? a.searched : a.roots ?? [];
      if (looked.length) card.append(h('div', { class: 'so-roots' }, 'Looked in: ', looked.map((r) => h('code', { class: 'so-path', title: r }, r))));
    }

    if (findings.length) {
      card.append(h('ol', { class: 'so-findings' }, findings.map((f) =>
        h('li', { class: `so-finding is-${f.severity}` },
          h('div', { class: 'so-finding-head' }, sevBadge(f.severity), h('strong', null, localizeIso(f.title))),
          f.detail ? prose(f.detail) : null,
          f.recommendation ? h('div', { class: 'so-rec' }, h('div', { class: 'so-rec-label' }, 'Recommendation'), recommendation(f.recommendation)) : null))));
    }
    return card;
  }

  function inventory(a) {
    const p = a.parse ?? {};
    const range = a.firstTs != null && a.lastTs != null ? `${formatDate(a.firstTs)} → ${formatDate(a.lastTs)} (${tzOffset(a.lastTs)})` : '—';
    const versions = a.versions ?? [];
    const item = (k, v, cls = '', title = null) => h('div', { class: `so-inv-item ${cls}`, title }, h('dt', null, k), h('dd', null, v));
    return h('div', { class: 'so-inv' },
      h('dl', { class: 'so-inv-grid' },
        item('Files', exact(a.files)),
        item('Size', formatBytes(a.bytes) || '—', '', exact(a.bytes)),
        item('Date range', range, 'is-wide', a.firstTs != null ? `${stampTitle(a.firstTs, 0)}\n→ ${stampTitle(a.lastTs, 0)}` : 'No timestamps'),
        item('Versions', versions.length ? `${versions.slice(0, 4).join(', ')}${versions.length > 4 ? ` +${versions.length - 4}` : ''}` : '—', '', versions.join(', ') || null),
        item('Lines', formatTokens(p.lines) || '—', '', exact(p.lines)),
        item('Malformed', exact(p.malformed), p.malformed ? 'is-warn' : ''),
        item('Unknown', exact(p.unknown), p.unknown ? 'is-warn' : '', 'Records kept as raw.unknown'),
        item('Skipped', exact(p.skipped), '', 'Records skipped on purpose because they duplicate another source'),
        item('Inherited', exact(p.inherited), '', 'Records copied from a parent or resumed session')),
      a.roots?.length ? h('div', { class: 'so-roots' }, a.roots.map((r) => h('code', { class: 'so-path', title: r }, r))) : null);
  }

  function capabilityGrid(caps) {
    if (!caps.length) return null;
    const rank = (c) => {
      const i = CAP_ORDER.indexOf(c.capability);
      return i < 0 ? CAP_ORDER.length : i;
    };
    return h('div', { class: 'so-caps', role: 'list', 'aria-label': 'Capabilities' }, caps.slice().sort((x, y) => rank(x) - rank(y)).map((c) => {
      const label = CAPABILITIES[c.capability] ?? c.capability;
      const note = `${label}: ${c.level}. ${c.note || LEVELS[c.level] || ''}`;
      return h('div', { class: 'so-cap', role: 'listitem', tabindex: '0', title: note, 'aria-label': note },
        h('span', { class: 'so-cap-name' }, label),
        h('span', { class: `so-level is-${c.level}` }, c.level));
    }));
  }

  // ---- Source files (virtualized)

  function createFileTable() {
    let all = [];
    let rows = [];
    let sortKey = 'path';
    let desc = false;
    const filter = h('input', { class: 'pn-input', type: 'search', placeholder: 'Filter by path, agent, kind or status', 'aria-label': 'Filter source files' });
    const problems = h('input', { type: 'checkbox' });
    const count = h('span', { class: 'so-count' });
    const header = h('div', { class: 'so-frow so-fhead', role: 'row' });
    const viewport = h('div', { class: 'so-fviewport' });
    const empty = h('div', { class: 'so-fempty', hidden: true }, 'No source files match.');
    const el = h('section', { class: 'so-files' },
      h('div', { class: 'so-section-head' },
        h('h3', null, 'Source files'), count, h('span', { class: 'pn-spacer' }),
        h('label', { class: 'so-problems' }, problems, ' Problems only'), filter),
      h('div', { class: 'so-ftable', role: 'table' }, header, viewport, empty));

    const list = createVirtualList(viewport, {
      rowHeight: ROW_H,
      createRow: () => h('div', { class: 'so-frow', role: 'row' }),
      renderRow: (rowEl, i) => rowEl.replaceChildren(...cells(rows[i])),
    });
    filter.addEventListener('input', debounce(apply, 120));
    problems.addEventListener('change', apply);

    function paintHeader() {
      header.replaceChildren(...FILE_COLS.map((c) =>
        h('button', {
          class: `so-fcell so-sort${c.num ? ' num' : ''}`,
          role: 'columnheader',
          'aria-sort': c.key === sortKey ? (desc ? 'descending' : 'ascending') : null,
          onclick: () => {
            if (sortKey === c.key) desc = !desc;
            else {
              sortKey = c.key;
              desc = !!c.num;
            }
            apply();
          },
        }, c.label, c.key === sortKey ? (desc ? ' ▾' : ' ▴') : '')));
    }

    function apply() {
      const q = filter.value.trim().toLowerCase();
      rows = all.filter((s) => (!problems.checked || isProblem(s)) &&
        (!q || [s.path, s.agent, s.kind, s.dialect, fileStatus(s).label].some((v) => v?.toLowerCase().includes(q))));
      const val = (s) => (sortKey === 'status' ? fileStatus(s).label : s[sortKey]);
      rows.sort((a, b) => {
        const x = val(a);
        const y = val(b);
        if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
        const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return desc ? -r : r;
      });
      count.textContent = rows.length === all.length ? `${exact(all.length)} files` : `${exact(rows.length)} of ${exact(all.length)} files`;
      viewport.style.height = `${Math.min(rows.length, MAX_VISIBLE_ROWS) * ROW_H}px`;
      empty.hidden = rows.length > 0;
      paintHeader();
      list.setCount(rows.length);
    }

    function cells(s) {
      if (!s) return [];
      const st = fileStatus(s);
      const indexed = toMicros(s.indexedAt);
      return [
        h('span', { class: 'so-fcell so-fpath', title: s.path }, h('bdi', null, s.path)),
        h('span', { class: 'so-fcell' }, agentLabel(s.agent)),
        h('span', { class: 'so-fcell', title: s.dialect ?? null }, s.kind),
        h('span', { class: 'so-fcell num', title: exact(s.size) }, formatBytes(s.size) || '—'),
        h('span', { class: 'so-fcell num' }, exact(s.lines)),
        h('span', { class: `so-fcell num${s.malformed ? ' is-warn' : ''}` }, exact(s.malformed)),
        h('span', { class: `so-fcell num${s.unknown ? ' is-warn' : ''}` }, exact(s.unknown)),
        h('span', { class: 'so-fcell' }, h('span', { class: `pn-chip is-${st.kind}`, title: st.title }, st.label)),
        h('span', { class: 'so-fcell num', title: [indexed ? stampTitle(indexed, 0) : 'Never indexed', s.parseMs != null ? `parsed in ${Math.round(s.parseMs)} ms` : null].filter(Boolean).join('\n') },
          indexed ? formatStamp(indexed, { seconds: false }).slice(5) : '—'),
      ];
    }

    return {
      el,
      setData(next) {
        all = next;
        apply();
      },
    };
  }

  return {
    show() {
      visible = true;
      renderToggle();
      renderProvenance();
      publishScope();
      load();
    },
    hide() {
      visible = false;
    },
  };
}
