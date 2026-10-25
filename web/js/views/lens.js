// The Failure Lens, titled "Observed chain" (SPEC §12.7): one frame for an episode, a claim, a delegation,
// a signature or a run (the queue row kinds of QueueRow in src/model/types.ts). It puts the evidence in
// order and names no cause: associations carry their rule, every value its provenance glyph, and missing
// data is a stated gap. Trace text goes in through text nodes only.

import { h, svg, clear, placeholder, icon, mark, agentDot, badge, autoTitle, proseBlock, codeBlock, clampLines, splitLines, onCodeWidth, scrollShadows, showMenu, openDialog, copyText } from '../lib/dom.js';
import { formatClock, formatDuration, formatInt, formatTokens, formatAgo, formatShortDate, stampTitle, agentLabel, agentColor, shortId, plural, tzOffset } from '../lib/format.js';
import {
  IMPACT, OUTCOME, TIER, CLAIM, DELEGATION, CHANGE_CLASS, ADVICE, SECTION, BLOCKED_FAMILIES, INTERVENTION, INTERVENTION_ACTOR,
  provKind, provMark, provTitle, ruleTitle, placeholderRuns, sparkPoints, refTime, sessionOfDerivedId, impactRank, redactionRuns, splitSummary, sig2, stepWords, diffRuns, noteText,
} from '../lib/derived.js';

const OUTPUT_CHARS = 2000;
const KIND_LABEL = { episode: 'Episode', claim: 'Claim', delegation: 'Delegation', signature: 'Signature', session: 'Run' };

/** The mark (docs/DESIGN.md §6.3) of each episode outcome and delegation outcome. */
export const OUTCOME_MARK = {
  recovered: 'recovered', interrupted: 'interrupted', 'parallel-ok': 'clean', 'recovered-later': 'recovered', pivoted: 'degraded', 'ended-on-failure': 'failed', open: 'slow',
};
const DELEGATION_MARK = { completed: 'clean', failed: 'failed', blocked: 'blocked', killed: 'interrupted', stopped: 'interrupted', running: 'live', unknown: 'info' };
const TONE_COLOR = { bad: 'var(--err)', warn: 'var(--warn)', ok: 'var(--ok)', note: 'var(--note)', muted: 'var(--fg-muted)', accent: 'var(--accent)' };
const PROV_WORD = { derived: 'derived', parsed: 'parsed', inferred: 'inferred' };

// ---------------------------------------------------------------------------
// Small renderers shared by every frame (and by failures.js, session.js, follow.js and stats.js).

const rulesOf = (app) => app.state.get('info')?.analysis?.rules ?? [];

/**
 * The provenance mark of a value (§3.3): a suffix with no space, `≈` derived, `~` parsed, `?` inferred, nothing for
 * logged. Its tooltip names the source; assistive technology reads it as a word ("7m 29s, derived").
 */
export function provEl(app, p) {
  const m = provMark(p);
  if (!m) return null;
  return h('span', { class: 'prov', title: provTitle(p, rulesOf(app)) }, h('span', { 'aria-hidden': 'true' }, m), h('span', { class: 'sr-only' }, `, ${PROV_WORD[provKind(p)]}`));
}

export function impactChip(v) {
  const m = IMPACT[v];
  return m ? badge('plain', m.word, { tone: m.tone, markName: v }) : null;
}

/**
 * A tier (§6.1, §6.2): failure is Solid only on the object's own header (`solid`), else a Plain "✕ failure" in
 * --err; the other tiers are Outline in their tier color.
 */
export function tierChip(tier, { solid = false } = {}) {
  if (!tier) return null;
  const word = TIER[tier]?.word ?? tier;
  if (tier === 'failure') return solid ? badge('solid', word, { tone: 'failure' }) : badge('plain', word, { tone: 'bad', markName: 'failed' });
  return badge('outline', word, { tone: tier });
}

/** A claim status is never red: Plain claim mark and text in --warn (§6.2). */
export function claimChip(app, evidence, src = 'inferred:claim@1') {
  const m = CLAIM[evidence];
  // The claim mark already says the status is inferred: provenance goes in the tooltip, not a "?" suffix (§3.3, §6.3).
  return m ? h('span', { class: ['b-plain', `tone-${m.tone}`], title: `Claim check: ${m.word}\n${provTitle(`${src}/${evidence}`, rulesOf(app))}` }, mark(m.tone === 'ok' ? 'clean' : 'claim'), m.short) : null;
}

/** A signature in the UI font, its placeholders (<url>, <n>) in --fg-muted (§3.2). */
export function signatureText(text) {
  return h('span', { class: 'sig-text' }, placeholderRuns(text).map((r) => (r.ph ? h('span', { class: 'sig-ph' }, r.text) : r.text)));
}

/** A sparkline of daily counts (DailyCounts.n) with its text equivalent (§10.3). */
export function sparkline(values, { w = 80, h: ht = 18, label = '' } = {}) {
  const v = values ?? [];
  const pts = sparkPoints(v, w, ht - 2);
  const total = v.reduce((a, b) => a + b, 0);
  const box = svg('svg', { class: 'spark', width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, role: 'img', 'aria-label': label || `Last ${v.length} days: ${formatInt(total)} in all, at most ${formatInt(Math.max(0, ...v))} a day` });
  if (pts.length) {
    box.append(svg('polyline', { points: pts.map(([x, y]) => `${x},${y + 1}`).join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25' }));
    const [lx, ly] = pts[pts.length - 1];
    box.append(svg('circle', { cx: lx, cy: ly + 1, r: 1.8, fill: 'currentColor' }));
  }
  return box;
}

const when = (app, ts) => {
  const ref = app.state.get('timeRef');
  return ref != null ? refTime(ts, ref) : formatClock(ts, { digits: 0, date: false });
};

function timeEl(app, ts) {
  if (!Number.isFinite(ts)) return h('span', { class: 'faint', title: 'No timestamp recorded' }, '—');
  return h('time', { class: 'lens-time', title: stampTitle(ts) }, when(app, ts));
}

/** A duration with its provenance; "—" with the reason when it is unknown. */
function wallEl(app, us, src, why = 'Not measured') {
  if (us == null) return h('span', { class: 'faint', title: why }, '—');
  return h('span', null, formatDuration(us), provEl(app, src ?? 'derived:ts-gap'));
}

/** A Lens section: a 1 px divider, the section label (with optional metadata on its right), then the content. */
function section(title, ...children) {
  const [label, aside] = Array.isArray(title) ? title : [title, null];
  return h('section', { class: 'lens-sec' }, h('h3', { class: 'lens-h' }, h('span', { class: 'sec-label' }, label), aside ? h('span', { class: 't-meta' }, aside) : null), ...children);
}

/**
 * What the times of a section are in (§7.9): "Times +08:00", or the time reference when one is set. Hovering a
 * time gives it in local time and UTC.
 */
export function tzNote(app) {
  const ref = app.state.get('timeRef') != null;
  return h('span', { class: 'lens-tz t-meta', title: ref ? 'Times count from the time reference (t clears it)' : null }, ref ? 'Times from the reference' : `Times ${tzOffset()}`);
}

/** A two-column grid row: the label in Row secondary, the value in Row primary. */
function kv(label, ...value) {
  return h('div', { class: 'lens-kv' }, h('span', { class: 'lens-k' }, label), h('span', { class: 'lens-v' }, ...value));
}

const notLogged = (why = 'The trace did not log this') => h('span', { class: 'faint', title: why }, 'not logged');

/** Gaps (§7.7): plain sentences; internal ids (rule, SPEC limit, field) only in the tooltip. */
function gapList(gaps) {
  if (!gaps?.length) return null;
  return h('ul', { class: 'lens-gaps' }, gaps.map((g) => h('li', { title: [g.code, g.limit != null ? `SPEC §12.9 limit ${g.limit}` : null, g.field ? `field ${g.field}` : null].filter(Boolean).join(' · ') },
    g.message, g.count != null ? h('span', { class: 'muted' }, ` (${plural(g.count, 'item')} affected)`) : null)));
}

/** A link to an event: "Event ›", or an icon with a name. */
function evLink(onEvent, eventId, child = 'Event ›', title = 'Show this event') {
  if (!eventId) return typeof child === 'string' ? null : child;
  return h('button', { class: 'lens-link', type: 'button', 'aria-label': typeof child === 'string' ? null : title, title: typeof child === 'string' ? null : title, onClick: (e) => { e.stopPropagation(); onEvent(eventId); } }, child);
}

/** An attempt's input against the previous one: deletions struck, insertions underlined, "→" from one to the other. */
function wordDiff(ops) {
  if (!ops?.length) return null;
  return h('code', { class: 'wdiff' }, diffRuns(ops).map((o) => (o.op === 'eq' ? o.text
    : o.op === 'sep' ? h('span', { class: 'wdiff-sep' }, o.text)
      : h(o.op === 'add' ? 'ins' : 'del', null, o.text))));
}

/** The edits between two attempts as one Plain link, "2 edits ›", whose menu opens each diff (§6.2). */
function editsLink(app, edits, lead = '') {
  if (!edits?.length) return null;
  const btn = h('button', { class: 'lens-link', type: 'button', 'aria-haspopup': 'menu' }, `${lead}${plural(edits.length, 'edit')} ›`);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (edits.length === 1) return openDiff(app, edits[0].eventId, edits[0].path);
    showMenu(btn, edits.map((e) => ({ label: e.path.split('/').pop(), hint: [e.added != null && `+${e.added}`, e.removed != null && `−${e.removed}`].filter(Boolean).join(' '), title: e.path, onSelect: () => openDiff(app, e.eventId, e.path) })));
  });
  return btn;
}

// ---------------------------------------------------------------------------
// Dialogs: a change's diff, and Copy Report with its redaction preview.

/** Load the diff of one change event (GET /api/changes/:eventId/diff) into `body`, optionally one path. */
export async function loadDiff(app, body, eventId, path) {
  clear(body).append(placeholder('loading', 'Loading the diff…'));
  try {
    const res = await app.api.diff(eventId, { path });
    const files = res?.files ?? [];
    clear(body);
    if (!files.length) body.append(placeholder('empty', 'No diff for this event', 'The event changed no file AgentShark can show.'));
    for (const f of files) {
      body.append(h('div', { class: 'diff-file' },
        h('div', { class: 'diff-head' }, h('code', null, f.path), h('span', { class: 'muted' }, f.op), provEl(app, f.src),
          f.added != null ? h('span', { class: 'ok' }, `+${f.added}`) : null, f.removed != null ? h('span', { class: 'err' }, `−${f.removed}`) : null),
        f.newOnly ? h('p', { class: 'lens-note' }, 'The old content was not logged; the lines below are the new content only.') : null,
        f.hunks
          ? f.hunks.map((hk) => h('pre', { class: 'diff-hunk' },
            hk.oldStart != null || hk.newStart != null ? h('div', { class: 'diff-at' }, `@@ ${hk.oldStart ?? '?'} → ${hk.newStart ?? '?'} @@`) : null,
            hk.lines.map((l) => h('div', { class: `diff-${l.op}` }, `${l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '} ${l.text}`))))
          : h('p', { class: 'lens-note' }, f.reason ?? 'No diff can be shown for this change.'),
        f.truncated ? h('p', { class: 'lens-note' }, 'The diff was cut at the line limit.') : null));
    }
  } catch (err) {
    clear(body).append(placeholder('error', 'Could not load the diff', err.status === 404 ? 'This server does not serve diffs yet, or the event changed no file.' : err.message));
  }
}

/** The diff of one change event in a dialog. */
export function openDiff(app, eventId, path) {
  const body = h('div', { class: 'diff-body' });
  openDialog({ title: path ? `Diff · ${path}` : 'Diff', className: 'dialog-wide', body });
  loadDiff(app, body, eventId, path);
}

const REPORT_FORMATS = [
  { id: 'md', label: 'Markdown', hint: 'for an issue' },
  { id: 'brief', label: 'Agent brief', hint: 'for a fresh agent' },
  { id: 'json', label: 'JSON', hint: 'the redacted Lens payload' },
];
const REDACTION_LABEL = {
  home: 'home folder → ~', user: 'user name → <user>', sk: 'sk- API keys', ghp: 'GitHub tokens', github_pat: 'GitHub fine-grained tokens',
  slack: 'Slack tokens', aws: 'AWS keys', bearer: 'Bearer tokens', jwt: 'JSON web tokens', pem: 'PEM private keys',
};

/**
 * Copy Report (c): pick a format, check what was redacted, then copy. Every Lens kind has it (§7.7); a server
 * without the kind's report route says so in the dialog.
 */
export function openCopyReport(app, episodeId, kind = 'episode') {
  let format = 'md';
  let text = '';
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Report format' });
  const redactions = h('div', { class: 'report-redactions', 'aria-live': 'polite' });
  const preview = h('pre', { class: 'report-preview', tabindex: '0', 'aria-label': 'Report preview' });
  const status = h('span', { class: 't-meta' });
  const load = async () => {
    seg.replaceChildren(...REPORT_FORMATS.map((f) => h('button', { class: ['seg-btn', f.id === format && 'on'], 'aria-pressed': String(f.id === format), title: f.hint, onClick: () => { format = f.id; load(); } }, f.label)));
    text = '';
    preview.textContent = '';
    redactions.replaceChildren(h('span', { class: 't-meta' }, 'Redacting…'));
    try {
      const r = await app.api.itemReport(kind, episodeId, format);
      text = r?.text ?? '';
      preview.replaceChildren(...redactionRuns(text).map((x) => (x.mark ? h('mark', { class: 'redacted', title: 'Redacted' }, x.text) : x.text)));
      const list = (r?.redactions ?? []).filter((x) => x.count > 0);
      redactions.replaceChildren(list.length
        ? h('span', null, 'Redacted before copying (marked in the preview): ', list.map((x, i) => [i ? ', ' : '', `${formatInt(x.count)} × ${REDACTION_LABEL[x.class] ?? x.class}`]))
        : h('span', null, 'Nothing matched a redaction rule. Check the preview for anything private before sharing.'));
      status.textContent = `${formatInt(text.length)} characters`;
    } catch (err) {
      redactions.replaceChildren(h('span', { class: 'err' }, err.status === 404 ? `This server cannot write a report for a ${kind} yet.` : `Could not build the report: ${err.message}`));
    }
  };
  openDialog({
    title: 'Copy Report',
    className: 'dialog-wide',
    body: [
      h('div', { class: 'report-top' }, seg, status),
      redactions,
      preview,
      h('p', { class: 'lens-note' }, 'The report quotes trace text (commands, outputs, paths). It describes what was observed; it does not say why it happened.'),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Copy',
        primary: true,
        onClick: () => {
          if (!text) return false;
          copyText(text).then((ok) => app.toast(ok ? 'Report copied' : 'Could not copy the report', ok ? 'ok' : 'error'));
        },
      },
    ],
  });
  load();
}

// ---------------------------------------------------------------------------
// The Lens frame (docs/DESIGN.md §7.7): a pane header with four actions, a header block (status line, title,
// signature block), then Where, Trigger, Attempts, Close, Cost, Seen before, Related and Gaps.

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Whether the server writes reports for each Lens kind: true, false (404), or unknown until asked. */
const REPORTS = {};
const FOLD_WIDTH = 640;
const LADDER_KEEP = 3;

/** Where an attempt's error line sits in its output, for the --err wash (§7.7 Trigger ▸ Output). */
function matchRuns(text, needle) {
  const t = String(text ?? '');
  const n = String(needle ?? '').trim();
  const i = n.length >= 4 ? t.indexOf(n) : -1;
  if (i < 0) return [t];
  return [t.slice(0, i), h('mark', { class: 'lens-match' }, t.slice(i, i + n.length)), t.slice(i + n.length)];
}

/**
 * @param {any} app
 * @param {{ onBack?: () => void, onEvent?: (eventId: string) => void, onSplitDate?: () => void }} opts
 */
export function createLens(app, { onBack, onEvent, onSplitDate } = {}) {
  const goEvent = onEvent ?? ((id) => app.selectEvent(id));
  const backBtn = h('button', { class: 'tool-btn lens-back', type: 'button', hidden: !onBack, onClick: () => onBack?.() }, '‹ Queue');
  const kindEl = h('span', { class: 'pane-sub' });
  const barActions = h('div', { class: 'lens-bar-actions', role: 'toolbar', 'aria-label': 'Lens actions' });
  const body = scrollShadows(h('div', { class: 'lens-body', tabindex: '-1' }));
  const el = h('div', { class: 'lens is-empty', role: 'region', 'aria-label': 'Observed chain', 'data-shows-selection': '', 'data-f6': '' },
    h('div', { class: 'pane-head lens-bar' }, backBtn, h('span', { class: 'pane-title' }, 'Observed chain'), kindEl, h('span', { class: 'spacer' }), barActions), body);

  let item = null;
  let data = null;
  let seq = 0;
  let attemptEls = [];
  let focused = -1;
  let actions = [];

  // Below a Lens width of 640 the secondary actions fold into "⋯" (§7.7).
  new ResizeObserver(() => renderActions()).observe(el);

  function empty() {
    el.classList.add('is-empty');
    actions = [];
    renderActions();
    clear(body).append(placeholder('empty', 'Select an item to see its observed chain', 'The Lens puts the evidence in order: where it happened, each attempt, how it closed, and what is missing.',
      { label: 'Open Next Attention Item', title: 'u', onClick: () => app.nextAttention() }));
  }
  empty();

  async function show(next) {
    if (!next?.kind || !next.id) return clearLens();
    item = next;
    data = null;
    const my = ++seq;
    el.classList.remove('is-empty');
    kindEl.textContent = KIND_LABEL[next.kind] ?? next.kind;
    const slow = setTimeout(() => {
      if (my === seq) clear(body).append(placeholder('loading', 'Loading the observed chain…'));
    }, 120);
    try {
      const api = app.api;
      const res = next.kind === 'episode' ? await api.episode(next.id, { outputChars: OUTPUT_CHARS })
        : next.kind === 'claim' ? await api.claim(next.id, { outputChars: OUTPUT_CHARS })
          : next.kind === 'delegation' ? await api.delegation(next.id, { outputChars: OUTPUT_CHARS })
            : next.kind === 'signature' ? await api.signature(next.id, { splitAt: app.state.get('signatureSplitAt') ?? undefined })
              : next.kind === 'session' ? await api.runReport(next.id, { since: app.state.get('scope')?.from ?? undefined })
                : null;
      if (my !== seq) return;
      data = res;
      render();
    } catch (err) {
      if (my !== seq) return;
      clear(body).append(placeholder('error', 'Could not load this item.',
        err.status === 404 ? 'It is no longer in the index, or this server does not serve it.' : ['Your selection is preserved.', h('div', { class: 't-meta' }, err.message)],
        { label: 'Retry', onClick: () => show(item) }));
    } finally {
      clearTimeout(slow);
    }
  }

  function clearLens() {
    item = null;
    data = null;
    seq++;
    kindEl.textContent = '';
    attemptEls = [];
    focused = -1;
    app.lensContext = null;
    app.setSelectionText('failures', null);
    empty();
  }

  /** What the shell's keys act on while this frame shows (Shift+Enter, s, f, c, t). */
  function publishContext() {
    const ctx = { item, signatureId: null, eventId: null, callEventId: null, ts: null, focusedEvent: null };
    if (item.kind === 'episode') {
      const last = data.attempts?.[data.attempts.length - 1];
      Object.assign(ctx, { signatureId: data.episode?.signature?.id ?? null, eventId: last?.eventId ?? null, callEventId: last?.callEventId ?? null, ts: data.attempts?.[0]?.ts ?? null });
    } else if (item.kind === 'claim') Object.assign(ctx, { eventId: data.claim?.finalEventId ?? null, ts: data.claim?.ts ?? null });
    else if (item.kind === 'delegation') Object.assign(ctx, { eventId: data.parentSaw?.eventId ?? null, ts: data.delegation?.startTs ?? null });
    else if (item.kind === 'signature') ctx.signatureId = data.id;
    app.lensContext = ctx;
    app.setSelectionText('failures', selectionText());
  }

  /** The Lens item in words, for a status bar that shows it while the Lens is hidden (§7.16, §9 Selection). */
  function selectionText() {
    const step = data.where?.step ? ` · ${stepWords(data.where.step)}` : '';
    switch (item.kind) {
      case 'episode': return `episode ${data.episode?.signature?.text ? `“${data.episode.signature.text.slice(0, 40)}”` : ''}${step}`;
      case 'claim': return `claim${step}`;
      case 'delegation': return `delegation ${data.delegation?.childTitle || shortId(data.delegation?.childSession ?? item.id, 12)}`;
      case 'signature': return `signature ${data.id ?? item.id}`;
      default: return `run ${data.run?.title || shortId(item.id, 12)}`;
    }
  }

  function render() {
    attemptEls = [];
    focused = -1;
    publishContext();
    const frame = item.kind === 'episode' ? episodeFrame(data)
      : item.kind === 'claim' ? claimFrame(data)
        : item.kind === 'delegation' ? delegationFrame(data)
          : item.kind === 'signature' ? signatureFrame(data)
            : runFrame(data);
    clear(body).append(frame);
    body.scrollTop = 0;
  }

  // -- pane header ------------------------------------------------------------

  /**
   * Four actions on every kind (§7.7): one primary, then Show in Events, Follow and Copy Report. An action that does
   * not apply is disabled with the reason in its tooltip; shortcuts are in tooltips, never on the buttons.
   */
  function setActions(list) {
    actions = list;
    renderActions();
  }
  function renderActions() {
    const btn = (a) => h('button', {
      class: ['btn', a.primary && 'primary'], type: 'button', disabled: !!a.disabled, 'aria-disabled': a.disabled ? 'true' : null,
      title: a.disabled ? a.disabled : a.key ? `${a.label} (${a.key})` : null, onClick: a.onClick,
    }, a.label);
    if (!actions.length) return barActions.replaceChildren();
    const fold = el.clientWidth > 0 && el.clientWidth < FOLD_WIDTH;
    const [primary, ...rest] = actions;
    if (!fold) return barActions.replaceChildren(...actions.map(btn));
    const more = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'More actions', title: 'More actions' }, '⋯');
    more.addEventListener('click', () => showMenu(more, rest.map((a) => ({ label: a.label, hint: a.key ?? '', disabled: !!a.disabled, title: a.disabled || null, onSelect: a.onClick })), { align: 'end' }));
    barActions.replaceChildren(btn(primary), more);
  }

  // -- header block -----------------------------------------------------------

  /** Status line (Row secondary), items joined by " · ", with an optional right side. */
  function statusLine(items, right = []) {
    const left = items.filter(Boolean);
    return h('div', { class: 'lens-status' },
      h('div', { class: 'lens-status-items' }, left.map((x, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · ') : null, x])),
      right.length ? h('div', { class: 'lens-status-right' }, right.filter(Boolean).map((x, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · ') : null, x])) : null);
  }
  const agentItem = (agent) => (agent ? h('span', { class: 'lens-agent' }, agentDot(agentColor(agent)), agentLabel(agent)) : null);
  const liveItem = (live) => (live ? badge('plain', 'Live', { tone: 'accent', markName: 'live', cls: 'live-mark', title: 'The run wrote an event in the last 60 s; outcomes and counts can still change' }) : null);
  const unattItem = (u) => (u ? h('span', { class: 'muted', title: 'No human was watching this turn' }, 'unattended') : null);

  /** The title (Title role), led by its mark in the impact color; built from structured fields only. */
  function titleLine(markName, tone, text, { outlined = false } = {}) {
    return h('h2', { class: 'lens-title t-title' }, h('span', { class: 'lens-title-mark', style: { color: TONE_COLOR[tone] ?? 'inherit' } }, mark(markName, { outlined })), h('span', null, text));
  }

  /** The signature block (§7.7): a code block, placeholders muted, never clamped. */
  function sigBlock(text) {
    return h('pre', { class: 'code-block sig-block' }, placeholderRuns(text).map((r) => (r.ph ? h('span', { class: 'sig-ph' }, r.text) : r.text)));
  }

  // -- shared sections ------------------------------------------------------

  /** Where (§7.7): breadcrumb, metadata line and the parent line. */
  function whereSection(where) {
    if (!where) return null;
    // Consecutive crumbs with the same text merge into one; the step crumb drops "in turn N" after the turn crumb.
    const raw = (where.breadcrumb ?? []).map((c) => ({ ...c, text: c.kind === 'step' && where.step ? stepWords(where.step) : c.label || (c.kind === 'turn' ? 'turn' : shortId(c.id)) }));
    if (where.step && !raw.some((c) => c.kind === 'step')) raw.push({ kind: 'step', id: null, text: stepWords(where.step) });
    const crumbs = raw.filter((c, i) => i === 0 || c.text !== raw[i - 1].text);
    const crumbEls = crumbs.map((c, i) => [
      i ? h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›') : null,
      // Crumbs are links: each cuts at the tail within 12–40ch, with its full text as the tooltip (§3.5).
      autoTitle(h('a', {
        class: ['crumb', c.kind === 'step' && 'crumb-step'], href: '#',
        onClick: (e) => {
          e.preventDefault();
          const sid = c.kind === 'run' || c.kind === 'session' ? c.id : sessionOfDerivedId(c.id ?? item.id);
          if (sid) app.showSession(sid, c.kind === 'step' && c.id ? { stepId: c.id } : c.kind === 'turn' ? { turnId: c.id } : {});
        },
      }, c.text), c.text),
    ]);
    const posture = where.posture ?? {};
    const meta = (k, v) => h('span', { class: 'lens-meta-item' }, h('span', { class: 'muted' }, `${k} `), v ?? notLogged());
    const parent = where.delegationPath?.length ? where.delegationPath[where.delegationPath.length - 1] : null;
    const parentTitle = parent ? app.sessionById(parent.sessionId)?.title || shortId(parent.sessionId, 12) : null;
    return section('Where',
      h('nav', { class: 'crumbs', 'aria-label': 'Where' }, crumbEls),
      // The line wraps between its items (Lens content, not chrome): a figure never cuts (§3.5 Number).
      h('div', { class: 'lens-meta' },
        meta('Model', where.model),
        meta('Approval', posture.approval ? h('span', null, posture.approval, provEl(app, posture.src)) : null),
        meta('Sandbox', posture.sandbox ? h('span', null, posture.sandbox, provEl(app, posture.src)) : null),
        posture.permissionMode ? meta('Permissions', posture.permissionMode) : null,
        meta('Context', where.ctx?.tokens != null ? h('span', null, `${formatTokens(where.ctx.tokens)}${where.ctx.window ? ` of ${formatTokens(where.ctx.window)}` : ''}`, provEl(app, where.ctx.windowSrc)) : null)),
      parent ? h('div', { class: 'lens-parent' }, h('button', { class: 'lens-link', type: 'button', onClick: () => app.openLens({ kind: 'delegation', id: parent.spanId }) },
        `Spawned by ${parentTitle}${parent.outcome ? ` (${DELEGATION[parent.outcome]?.word ?? parent.outcome})` : ''} ›`)) : null);
  }

  // -- episode --------------------------------------------------------------

  function episodeFrame(d) {
    const ep = d.episode;
    const sig = ep.signature;
    const last = d.attempts[d.attempts.length - 1];
    const seen = d.seenBefore;
    const o = OUTCOME[ep.outcome] ?? { word: ep.outcome, tone: 'muted' };
    const sessionId = sessionOfDerivedId(ep.id);
    const agent = app.sessionById(sessionId)?.agent ?? null;
    const statusWord = { recurring: ['recurring', 'muted', 'recovered'], regressed: ['regressed', 'warn', 'regressed'], new: ['new', 'note', null], dormant: ['dormant', 'muted', null] }[seen?.status];
    const seenLink = seen ? h('button', { class: 'lens-link', type: 'button', onClick: () => body.querySelector('.lens-seen')?.scrollIntoView({ block: 'start' }) }, 'Seen before ›') : null;
    const head = h('header', { class: 'lens-header' },
      statusLine([tierChip(ep.tier, { solid: true }), h('span', { class: 'muted' }, sig.family), agentItem(agent), liveItem(d.where?.live), unattItem(ep.unattended),
        ep.loop ? badge('plain', 'loop', { tone: 'warn', markName: 'loop', title: '5 or more attempts with one signature' }) : null,
        ep.blind ? h('span', { class: 'warn', title: '3 or more identical attempts with no edit between them' }, 'blind retries') : null,
        ep.actor ? h('span', { class: 'muted', title: ep.actor === 'parent-or-human' ? 'In a child session a human interrupt looks like a parent stop' : 'Interrupted by a human' }, `by ${ep.actor === 'parent-or-human' ? 'parent or human' : 'human'}`) : null],
      [statusWord ? badge('plain', statusWord[0], { tone: statusWord[1], markName: statusWord[2] }) : null, seenLink]),
      titleLine(OUTCOME_MARK[ep.outcome] ?? 'failed', o.tone, `${cap(o.word)} after ${plural(ep.nAttempts, 'attempt')}`),
      sigBlock(sig.text));

    const first = d.attempts[0];
    const trigger = section('Trigger',
      h('div', { class: 'lens-grid' },
        kv('Intent', d.intent?.text ? h('span', { class: 'prose' }, d.intent.text, provEl(app, d.intent.src)) : notLogged('The step logged no intent')),
        kv('Target', h('code', { class: 'code-token' }, ep.targetKey)),
        first ? kv('Input', first.input ? codeBlock(first.input, { head: 2, tail: 0, label: 'input', wrap: true }) : h('span', { class: 'faint' }, '—')) : null,
        first ? kv('Output', outputBlock(first, sig.text)) : null));

    return h('div', { class: 'lens-frame' },
      head,
      whereSection(d.where),
      trigger,
      attemptsSection(d.attempts, ep.nAttempts),
      closeSection(d.close, ep),
      section('Cost', h('div', { class: 'lens-grid wide' },
        kv('Wall time lost', wallEl(app, ep.wallUs, ep.wallSrc, 'The episode has no measurable span')),
        kv('Attempts', formatInt(ep.nAttempts)),
        kv('Steps', formatInt(ep.nSteps)),
        kv('Tokens out', ep.tokOut != null ? formatTokens(ep.tokOut) : notLogged()),
        kv('Tokens in', ep.tokInUpperBound != null ? h('span', { title: 'Input tokens processed over the episode’s steps: an upper bound, not the cost of the failure' }, `≤${formatTokens(ep.tokInUpperBound)} (upper bound)`) : notLogged()))),
      seenBeforeSection(seen, sig),
      relatedSection(d.related, sessionId),
      gapsSection(d.gaps),
      setActionsFor('episode', d, {
        primary: { label: 'Show in Session', key: '⇧↩', primary: true, onClick: () => app.showInSession(last?.eventId) },
        events: { label: 'Show in Events', onClick: () => app.showEpisodeInEvents(ep.id, last?.eventId) },
        follow: { label: 'Follow', key: 'f', onClick: () => app.openFollow({ kind: 'call', eventId: last?.callEventId ?? last?.eventId }) },
        report: { label: 'Copy Report', key: 'c', onClick: () => openCopyReport(app, ep.id, 'episode') },
      }));
  }

  /**
   * Install the four actions and return nothing for the frame (keeps the frame expression flat). Copy Report on a
   * claim, delegation or signature needs its report route (§12 engine change): until the server answers it, the
   * action is disabled with that reason, as on the Mac.
   */
  function setActionsFor(kind, _d, a) {
    const report = { ...a.report };
    if (kind !== 'episode' && kind !== 'session' && !report.disabled) {
      const why = `This server cannot write a report for a ${kind} yet`;
      if (REPORTS[kind] === false) report.disabled = why;
      else if (REPORTS[kind] == null) {
        const mine = seq;
        app.api.itemReport(kind, item.id, 'md').then(() => {
          REPORTS[kind] = true;
        }, (err) => {
          if (err.status !== 404) return;
          REPORTS[kind] = false;
          if (mine === seq) setActions(actions.map((x) => (x.label === report.label ? { ...x, disabled: why } : x)));
        });
      }
    }
    setActions([a.primary, a.events, a.follow, report]);
    return null;
  }

  /**
   * Output (§3.5 Lens clamp): head 4 rendered rows and tail 2, the error line on an --err wash; "Show full output".
   * Rows count after wrapping, and a carriage return ends a line as it does in a terminal (progress output).
   */
  function outputBlock(a, sigText = null) {
    const r = a.result ?? {};
    if (!r.head && !r.tail) return h('span', { class: 'faint', title: 'No output was logged for this result' }, 'no output');
    // A literal signature that is the error line already shows in the header: the Output does not mark it again.
    const match = sigText && r.errorLine && sigText.trim() === r.errorLine.trim() ? null : r.errorLine;
    const runs = (text) => matchRuns(text, match);
    const cut = (text) => h('span', { class: 'code-omitted' }, `⋯ ${text} ⋯`);
    const headText = splitLines(r.head ?? '').join('\n');
    const tailText = r.tail ? splitLines(r.tail).join('\n') : null;
    const pre = h('pre', { class: 'code-block lens-output' });
    const label = `Show full output (${formatInt((r.head?.length ?? 0) + (r.tail?.length ?? 0))} characters)`;
    const toggle = h('button', { class: 'link-btn clamp-toggle', type: 'button' }, label);
    let full = false;
    let head;
    let tail;
    const paint = () => {
      toggle.hidden = !head.cut && !tailText;
      const parts = full ? runs(headText) : [...runs(head.head.join('\n')), ...(head.omitted ? ['\n', cut(`${plural(head.omitted, 'line')} omitted`)] : []), ...(head.tail.length ? ['\n', ...runs(head.tail.join('\n'))] : [])];
      if (tailText) parts.push('\n', cut(full ? 'the index keeps the head and the tail' : 'omitted'), '\n', ...runs(full ? tailText : tail.tail.join('\n')));
      pre.replaceChildren(...parts);
    };
    const clamp = (cols) => {
      head = clampLines(headText, 4, tailText ? 0 : 2, cols);
      tail = tailText ? clampLines(tailText, 0, 2, cols) : null;
      paint();
    };
    clamp(Infinity);
    onCodeWidth(pre, clamp);
    toggle.addEventListener('click', () => {
      full = !full;
      paint();
      toggle.textContent = full ? 'Show less' : label;
    });
    return h('div', { class: 'code-wrap' }, pre, toggle);
  }

  /**
   * Attempts (§7.7): a block per attempt; a ladder of more than three keeps the first, the focused and the last,
   * and folds the rest into "+n attempts" rows that expand in place.
   */
  function attemptsSection(attempts, n) {
    const ladder = h('ol', { class: 'ladder', 'aria-label': 'Attempts' });
    // A result line that repeats an earlier one (often the Trigger's output) says so instead of repeating it.
    const firstOf = new Map();
    const blocks = attempts.map((a) => {
      const line = a.result?.errorLine ?? null;
      const sameAs = line && firstOf.has(line) ? { line, n: firstOf.get(line) } : { line: null, n: null };
      if (line && !firstOf.has(line)) firstOf.set(line, a.n);
      return attemptRow(a, sameAs);
    });
    let group = null;
    attempts.forEach((a, i) => {
      const row = blocks[i];
      if (!a.parallel || i === 0) {
        group = null;
        ladder.append(row);
        return;
      }
      if (!group) {
        const prev = ladder.lastElementChild;
        group = h('li', { class: 'ladder-group' }, h('div', { class: 'ladder-group-label t-meta' }, 'Same step (parallel)'), h('ol', { class: 'ladder-inner' }));
        ladder.replaceChild(group, prev);
        group.lastChild.append(prev);
      }
      group.lastChild.append(row);
    });
    if (attempts.length > LADDER_KEEP) foldLadder(ladder, blocks);
    return section([`Attempts (${formatInt(n)})`, tzNote(app).textContent], ladder);
  }

  /**
   * Fold every attempt but the first, the focused and the last into "+n attempts" rows. A parallel group folds as a
   * unit, so its label never stands alone.
   */
  function foldLadder(ladder, blocks) {
    for (const f of ladder.querySelectorAll('.ladder-fold')) f.remove();
    const top = [...ladder.children];
    const unitOf = (b) => top.find((t) => t === b || t.contains(b));
    const keep = new Set([unitOf(blocks[0]), unitOf(blocks[blocks.length - 1]), unitOf(blocks[focused >= 0 ? focused : 0])]);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const hidden = run;
      run = [];
      const n = hidden.reduce((a, t) => a + (t.matches('.attempt') ? 1 : t.querySelectorAll('.attempt').length), 0);
      const fold = h('li', { class: 'ladder-fold' }, h('button', { class: 'lens-link', type: 'button', onClick: () => {
        for (const t of hidden) t.hidden = false;
        fold.remove();
      } }, `+${plural(n, 'attempt')}`));
      hidden[0].before(fold);
    };
    for (const t of top) {
      t.hidden = !keep.has(t);
      if (t.hidden) run.push(t);
      else flush();
    }
    flush();
  }

  function attemptRow(a, sameAs = { line: null, n: null }) {
    const r = a.result ?? {};
    const parts = [
      h('span', { class: 'attempt-n' }, `#${a.n}`),
      a.step != null ? h('span', null, `step ${formatInt(a.step)}`) : null,
      timeEl(app, a.ts),
      a.n > 1 ? h('span', { title: 'Time since the previous attempt' }, a.gapUs != null ? `+${formatDuration(a.gapUs)}` : '+—') : null,
      a.n > 1 && a.gapSteps != null ? h('span', { title: 'Steps since the previous attempt' }, `+${plural(a.gapSteps, 'step')}`) : null,
    ].filter(Boolean);
    const exit = r.exitCode != null
      ? h('span', { class: r.exitCode !== 0 ? 'err' : null }, r.exitCode !== 0 ? mark('failed') : null, ` exit ${r.exitCode}`, provEl(app, r.exitSrc))
      : h('span', { class: 'faint', title: 'No exit code was logged' }, 'exit —');
    // Attempt #1's command and result are Trigger ▸ Input and Output; they are not repeated here (§1 one fact).
    const cmd = a.n > 1 && a.input ? h('code', { class: 'code-token attempt-cmd', tabindex: '0', role: 'button', 'aria-expanded': 'false', title: 'Show the whole command' }, a.input) : null;
    cmd?.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = cmd.classList.toggle('open');
      cmd.setAttribute('aria-expanded', String(open));
    });
    const li = h('li', { class: ['attempt', `tier-${a.tier}`], tabindex: '-1', dataset: { event: a.eventId } },
      h('div', { class: 'attempt-line' },
        h('span', { class: 'attempt-meta' }, parts.map((x, i) => [i ? ' · ' : null, x])),
        a.tier && a.tier !== 'failure' ? tierChip(a.tier) : null,
        h('span', { class: 'spacer' }),
        exit,
        evLink(goEvent, a.eventId, 'Event ›')),
      cmd,
      a.n > 1 && r.errorLine ? (r.errorLine === sameAs.line ? h('div', { class: 't-row2' }, `Same result as #${sameAs.n}`) : h('pre', { class: 'attempt-result' }, r.errorLine)) : null,
      a.n > 1 && (a.changeClass || a.inputDiff?.length) ? h('div', { class: 'attempt-diff' },
        a.changeClass ? h('span', { class: 'muted', title: 'How much the input changed from the previous attempt' }, cap(CHANGE_CLASS[a.changeClass] ?? a.changeClass)) : null,
        wordDiff(a.inputDiff)) : null,
      a.editsBetween?.length || a.reread
        ? h('div', { class: 'attempt-edits' }, editsLink(app, a.editsBetween), a.reread ? h('span', { class: 'muted', title: 'The same path was read again between the attempts' }, 're-read') : null)
        : null,
      a.deferredPolls ? h('div', { class: 't-meta' }, `+${plural(a.deferredPolls, 'poll')}`) : null);
    li.addEventListener('click', (e) => {
      if (e.target.closest('button, summary, a, code')) return;
      focusIndex(attemptEls.indexOf(li));
    });
    li.addEventListener('dblclick', (e) => {
      if (!e.target.closest('button, summary')) goEvent(a.eventId);
    });
    attemptEls.push(li);
    return li;
  }

  function closeSection(close, ep) {
    if (!close) return null;
    const d = close.detail ?? {};
    const calls = (d.calls ?? []).map((c) => evLink(goEvent, c.eventId, h('code', { class: 'code-token' }, [c.tool ?? 'call', c.target].filter(Boolean).join(' ')), 'Show this call'));
    const what = {
      recovered: 'Recovered by a later call with the same target',
      'parallel-ok': 'The same target succeeded in the same step',
      'recovered-later': 'The target succeeded in a later turn',
      pivoted: 'Other targets succeeded and the turn ended normally',
      interrupted: `The turn was aborted${d.actor ? ` by ${d.actor === 'parent-or-human' ? 'the parent or a human' : 'a human'}` : ''}`,
      'final-message': 'The turn ended with this message',
      open: 'Still open: the turn has not ended',
    }[close.kind] ?? close.kind;
    return section('Close',
      h('p', { class: 'lens-sentence' }, `${what}.`, close.eventId ? [' ', evLink(goEvent, close.eventId, 'Event ›')] : null),
      d.text ? proseBlock(d.text, { lines: 6 }) : null,
      d.claim ? h('div', { class: 'lens-row' }, h('span', { class: 'muted' }, 'Claim '), claimChip(app, d.claim)) : null,
      d.edits?.length ? h('div', { class: 'lens-row' }, editsLink(app, d.edits, 'Before it: ')) : null,
      calls.length ? h('div', { class: 'lens-row wrap' }, h('span', { class: 'muted' }, close.kind === 'pivoted' ? 'Next calls ' : 'Calls '), calls) : null);
  }

  function seenBeforeSection(seen, sig) {
    if (!seen) return null;
    const blocked = BLOCKED_FAMILIES.includes(sig.family);
    const daily = seen.daily?.n ?? [];
    const rec = seen.episodes != null && seen.recovered != null
      ? `${formatInt(seen.recovered)} of ${plural(seen.episodes, 'episode')} recovered (${Math.round((seen.recovered / Math.max(1, seen.episodes)) * 100)}%)`
      : seen.recoveredRate != null ? null : 'no closed episode yet';
    return h('div', { class: 'lens-seen' }, section('Seen before',
      h('div', { class: 'lens-spark' }, sparkline(daily, { w: 160, h: 28, label: `Last 30 days: ${plural(daily.reduce((a, b) => a + b, 0), 'failure')}, at most ${formatInt(Math.max(0, ...daily))} a day` }), h('span', { class: 't-meta' }, 'last 30 days')),
      h('p', { class: 'lens-row' },
        seen.episodes != null ? `${plural(seen.episodes, 'episode')} in ${plural(seen.sessions, 'session')}` : `In ${plural(seen.sessions, 'session')}`,
        ' · ', h('span', { title: stampTitle(seen.firstTs) }, `first ${formatShortDate(seen.firstTs)}`), ' · ', h('span', { title: stampTitle(seen.lastTs) }, `last ${formatAgo(seen.lastTs)}`)),
      rec ? h('p', { class: 'lens-row' }, rec)
        : h('p', { class: 'lens-row', title: 'Share of this signature’s closed episodes that recovered; the server does not send the counts yet' }, `${Math.round(seen.recoveredRate * 100)}% of closed episodes recovered`),
      fixesList(seen.fixes),
      seen.advice || blocked ? h('p', { class: 'advice prose' }, ADVICE[seen.advice ?? 'environment']) : null,
      h('div', { class: 'lens-sig-id', title: `Signature version ${sig.sigv}` }, h('code', { class: 'faint' }, sig.id))));
  }

  /** Up to three observed fixes, labelled as unverified (SPEC §12.4). */
  function fixesList(fixes) {
    if (!fixes?.length) return h('p', { class: 'lens-note' }, 'No recovery of this signature was observed yet.');
    return h('div', { class: 'fixes' },
      h('div', { class: 't-row2' }, 'Observed in past recoveries, not verified'),
      h('ul', null, fixes.slice(0, 3).map((f) => h('li', null,
        h('span', { class: 'muted' }, `${f.kind} `), autoTitle(h('code', { class: 'code-token' }, f.pattern), f.pattern), ` · ${formatInt(f.n)} of ${formatInt(f.of)} recoveries `,
        h('button', { class: 'lens-link', type: 'button', onClick: () => app.openLens({ kind: 'episode', id: f.exampleEpisode }) }, 'Example ›')))));
  }

  function relatedSection(related, sessionId) {
    if (!related?.length) return null;
    const label = { intervention: 'Intervention', 'child-episode': 'Child episode', 'parent-result': 'Parent’s result', delegation: 'Delegation' };
    const rules = rulesOf(app);
    const details = new Map(); // event id → the slot an intervention's kind and actor fill
    const list = h('ul', { class: 'related' }, related.map((r) => {
      const slot = r.kind === 'intervention' && r.eventId ? h('span', { class: 'rel-detail' }) : null;
      if (slot) details.set(r.eventId, slot);
      const ruleText = rules.find((x) => x.rule === r.rule)?.description ?? r.rule;
      return h('li', null,
        h('button', {
          class: 'lens-link', type: 'button',
          onClick: () => (r.kind === 'child-episode' ? app.openLens({ kind: 'episode', id: r.id }) : r.kind === 'delegation' ? app.openLens({ kind: 'delegation', id: r.id }) : r.eventId ? goEvent(r.eventId) : null),
        }, label[r.kind] ?? r.kind),
        slot,
        r.label ? [' ', h('span', null, r.label)] : null,
        ' ', h('span', { class: 'muted', title: ruleTitle(r.rule, rules, 'Associated by rule') }, ruleText.toLowerCase()));
    }));
    if (details.size && sessionId) fillInterventions(details, sessionId, seq);
    return section('Related', list);
  }

  function gapsSection(gaps) {
    const list = gapList(gaps);
    return list ? section('Gaps', list) : null;
  }

  /** Kind, actor (with its provenance) and wait of the interventions in Related, from /api/interventions. */
  async function fillInterventions(slots, sessionId, my) {
    const res = await app.api.interventions({ session: sessionId, descendants: true, limit: 500 }).catch(() => null);
    if (my !== seq) return;
    for (const iv of res?.rows ?? []) {
      const slot = slots.get(iv.eventId);
      if (!slot) continue;
      slot.replaceChildren(...[' ', h('span', null, INTERVENTION[iv.kind] ?? iv.kind),
        h('span', { class: 'muted' }, ` by ${INTERVENTION_ACTOR[iv.actor] ?? iv.actor}`), provEl(app, iv.actorSrc),
        iv.waitUs != null ? h('span', { class: 'muted' }, ` · waited ${formatDuration(iv.waitUs)}`) : null].filter(Boolean));
    }
  }

  // -- claim ----------------------------------------------------------------

  function claimFrame(d) {
    const c = d.claim;
    const m = CLAIM[c.evidence] ?? { word: c.evidence, tone: 'warn' };
    const verified = c.evidence === 'passed-after-last-edit';
    const agent = app.sessionById(c.sessionId)?.agent ?? null;
    const meta = app.sessionById(c.sessionId);
    return h('div', { class: 'lens-frame' },
      h('header', { class: 'lens-header' },
        statusLine([agentItem(agent), liveItem(d.where?.live), unattItem(meta?.unattended)]),
        titleLine(verified ? 'clean' : 'claim', verified ? 'ok' : 'warn', `${verified ? 'Verified' : 'Unverified'} claim · ${m.word}`),
        c.claimExcerpt ? h('blockquote', { class: 'lens-quote prose', title: `Matched the claim pattern “${c.pattern}”\n${provTitle(`inferred:${c.rule}/${c.evidence}`, rulesOf(app))}` }, `“${c.claimExcerpt}”`) : null),
      whereSection(d.where),
      d.finalText && d.finalText.trim() !== c.claimExcerpt?.trim() ? section('Final message', proseBlock(d.finalText, { lines: 6 })) : null,
      section(['Evidence', tzNote(app).textContent],
        d.evidence?.length
          ? h('ol', { class: 'evidence' }, d.evidence.map((e) => h('li', { class: e.earlier ? 'earlier' : null },
            h('span', null, e.kind === 'test' ? 'Test run' : 'Edit'),
            e.step != null ? h('span', { class: 'muted' }, ` · step ${formatInt(e.step)}`) : null,
            ' · ', timeEl(app, e.ts),
            e.target ? [' · ', h('code', { class: 'code-token' }, e.target)] : null,
            e.path ? [' · ', h('code', { class: 'code-token' }, e.path)] : null,
            e.added != null ? h('span', { class: 'ok' }, ` +${e.added}`) : null,
            e.removed != null ? h('span', { class: 'err' }, ` −${e.removed}`) : null,
            e.tier ? [' ', tierChip(e.tier)] : null,
            e.exitCode != null ? h('span', { class: e.exitCode ? 'err' : null }, ` · exit ${e.exitCode}`, provEl(app, e.exitSrc)) : null,
            e.earlier ? h('span', { class: 'muted' }, ' · before this turn') : null,
            ' ', evLink(goEvent, e.eventId, 'Event ›'))))
          : h('p', { class: 'lens-note' }, 'The turn ran no test and made no edit.')),
      gapsSection(d.gaps),
      setActionsFor('claim', d, {
        primary: { label: 'Show in Session', key: '⇧↩', primary: true, onClick: () => app.showInSession(c.finalEventId) },
        events: { label: 'Show in Events', onClick: () => app.showFilterInEvents(`turn == ${JSON.stringify(c.turnId)}`, c.finalEventId) },
        follow: { label: 'Follow', key: 'f', onClick: () => app.openFollow({ kind: 'call', eventId: c.testEventId ?? c.finalEventId }), disabled: c.testEventId ? null : 'The turn ran no test to follow' },
        report: { label: 'Copy Report', key: 'c', onClick: () => openCopyReport(app, item.id, 'claim') },
      }));
  }

  // -- delegation -----------------------------------------------------------

  function delegationFrame(d) {
    const g = d.delegation;
    const child = d.child ?? {};
    const m = DELEGATION[g.outcome] ?? { word: g.outcome ?? 'outcome unknown', tone: 'muted' };
    const told = g.parentTold === true ? 'yes' : g.parentTold === false ? 'no' : 'unknown';
    const role = { subagent: 'subagent', 'workflow-agent': 'workflow', guardian: 'guardian' }[g.childRole] ?? g.childRole;
    const childLive = app.sessionById(g.childSession)?.live;
    return h('div', { class: 'lens-frame' },
      h('header', { class: 'lens-header' },
        statusLine([role ? h('span', { class: 'muted' }, role) : null, agentItem(g.childAgent), liveItem(d.where?.live || childLive), unattItem(app.sessionById(g.childSession)?.unattended)],
          [g.silent ? badge('plain', 'silent child', { tone: 'bad', markName: 'silent', title: 'The child failed or was blocked and the result the parent saw did not say so' }) : null]),
        titleLine(g.silent ? 'silent' : DELEGATION_MARK[g.outcome] ?? 'info', m.tone, `Child ${m.word} · parent told: ${told}`, { outlined: provKind(g.outcomeSrc) !== 'logged' }),
        g.childTitle ? h('div', { class: 't-row2' }, g.childTitle) : null,
        d.task ? proseBlock(d.task, { lines: 6, cls: 'lens-task' }) : null),
      whereSection(d.where),
      section('Child',
        h('p', { class: 'lens-row' }, child.impact ? impactChip(child.impact) : h('span', { class: 'faint' }, 'impact unknown'), ` · ${plural(child.steps ?? 0, 'step')}`,
          g.tokInTree != null ? h('span', { class: 'muted' }, ` · ${formatTokens(g.tokInTree)} in, ${formatTokens(g.tokOutTree)} out over the child tree`) : null),
        child.episodes?.length
          ? h('ul', { class: 'mini-queue' }, child.episodes.map((r) => h('li', null, h('button', { class: 'lens-link', type: 'button', onClick: () => app.openQueueRow(r) },
            r.impact ? impactChip(r.impact) : null, ' ', signatureText(r.signature ?? r.target ?? r.id)))))
          : h('p', { class: 'lens-note' }, 'No unrecovered episode in the child.'),
        child.finalText ? h('div', null, h('div', { class: 't-row2' }, 'Final message'), proseBlock(child.finalText, { lines: 4 })) : null),
      section('What the parent saw',
        d.parentSaw
          ? [h('p', { class: 'lens-row' },
            d.parentSaw.flagged ? h('span', { class: 'err' }, 'Flagged as an error') : h('span', null, 'Not flagged as an error'),
            d.parentSaw.told != null ? h('span', { title: ruleTitle(d.parentSaw.rule, rulesOf(app), 'Inferred by rule') }, ` · told: ${d.parentSaw.told ? 'yes' : 'no'}`, provEl(app, `inferred:${d.parentSaw.rule}`)) : null,
            ' ', evLink(goEvent, d.parentSaw.eventId, 'Event ›')),
          proseBlock(d.parentSaw.text ?? '', { lines: 4 })]
          : h('p', { class: 'lens-note' }, 'The parent saw no result from this child.'),
        d.parentNext
          ? h('p', { class: 'lens-row wrap' }, h('span', { class: 'muted' }, `Next step ${formatInt(d.parentNext.n)} `), d.parentNext.calls.map((c) => evLink(goEvent, c.eventId, h('code', { class: ['code-token', c.tier === 'failure' && 'tone-bad'] }, [c.tool ?? 'call', c.target].filter(Boolean).join(' ')), 'Show this call')))
          : null),
      gapsSection(d.gaps),
      setActionsFor('delegation', d, {
        primary: { label: 'Show in Session', primary: true, onClick: () => app.showSession(g.childSession), disabled: g.childSession ? null : 'The child session is not indexed' },
        events: { label: 'Show in Events', onClick: () => app.showFilterInEvents(`session == ${JSON.stringify(g.childSession)}`), disabled: g.childSession ? null : 'The child session is not indexed' },
        follow: { label: 'Follow', key: 'f', onClick: () => app.openFollow({ kind: 'delegation', spanId: g.id }) },
        report: { label: 'Copy Report', key: 'c', onClick: () => openCopyReport(app, g.id, 'delegation') },
      }));
  }

  // -- signature ------------------------------------------------------------

  function signatureFrame(d) {
    const days = d.days ?? [];
    const daily = d.daily?.n ?? days.map((x) => x.n);
    const st = { recurring: ['recovered', 'muted'], regressed: ['regressed', 'warn'], new: ['info', 'note'], dormant: ['slow', 'muted'] }[d.status] ?? ['info', 'muted'];
    const agents = d.agents ?? [];
    // The title counts what the queue row counts (§7.7, Principle 7): episodes from the same field as the row, until
    // the signature route ships them itself; `n` counts failed calls and stays in Counts under its own label.
    const row = app.lastQueueRow?.kind === 'signature' && app.lastQueueRow.id === d.id ? app.lastQueueRow : null;
    const episodes = d.episodes ?? row?.members ?? null;
    const sessions = row?.seenSessions ?? d.sessions;
    return h('div', { class: 'lens-frame' },
      h('header', { class: 'lens-header' },
        statusLine([h('span', { class: 'muted' }, d.family), ...agents.slice(0, 3).map(agentItem), agents.length > 3 ? h('span', { class: 'muted' }, `+${agents.length - 3}`) : null]),
        titleLine(st[0], st[1], `${cap(d.status ?? 'signature')} · ${episodes != null ? `${plural(episodes, 'episode')} in ${plural(sessions, 'session')}` : plural(sessions, 'session')}`),
        sigBlock(d.text)),
      section('Counts', h('div', { class: 'lens-grid wide' },
        d.n != null ? kv('Failed calls', formatInt(d.n)) : null,
        kv('Unrecovered', d.unrecoveredRate != null ? h('span', { title: 'Share of the closed episodes that did not recover' }, `${Math.round(d.unrecoveredRate * 100)}% of closed episodes`) : notLogged('No closed episode yet')),
        kv('Wall time lost', d.wallLostUs ? h('span', null, formatDuration(d.wallLostUs), provEl(app, 'derived:sum')) : '0'),
        kv('First and last', h('span', { title: `${stampTitle(d.firstTs)} → ${stampTitle(d.lastTs)}` }, `${formatShortDate(d.firstTs)} → ${formatAgo(d.lastTs)}`))),
        h('div', { class: 'lens-spark' }, sparkline(daily, { w: 260, h: 34 }), h('span', { class: 't-meta' }, 'last 30 days'))),
      splitSection(d),
      section('Recent episodes',
        d.examples?.length
          ? h('ul', { class: 'mini-queue' }, d.examples.map((x) => h('li', null,
            h('button', { class: 'lens-link', type: 'button', onClick: () => app.openLens({ kind: 'episode', id: x.episodeId }) }, cap(OUTCOME[x.outcome]?.word ?? x.outcome), ' ›'),
            h('span', { class: 'muted' }, ' · ', agentLabel(x.agent)), h('span', { class: 'muted' }, ` · ${formatAgo(x.ts)}`),
            x.errorLine ? autoTitle(h('div', { class: 'code-token ellipsis' }, x.errorLine), x.errorLine) : null)))
          : h('p', { class: 'lens-note' }, 'No episodes in scope.')),
      section('Observed fixes', fixesList(d.fixes)),
      gapsSection(d.gaps),
      h('div', { class: 'lens-sig-id' }, h('code', { class: 'faint' }, d.id)),
      setActionsFor('signature', d, {
        primary: { label: 'List Its Episodes', primary: true, onClick: () => app.showSignatureEpisodes(d.id) },
        events: { label: 'Show in Events', onClick: () => app.showFilterInEvents(`signature == ${JSON.stringify(d.id)}`) },
        follow: { label: 'Follow', key: 'f', disabled: 'A signature spans sessions; open one of its episodes to follow a call' },
        report: { label: 'Copy Report', key: 'c', onClick: () => openCopyReport(app, d.id, 'signature') },
      }));
  }

  /**
   * Split at (SPEC §12.2 row 7): counts before and after a day, divided by the sessions active then. The date is the
   * one Split at in the facet bar sets, so the queue and this section always compare the same day.
   */
  function splitSection(d) {
    const change = onSplitDate ? h('button', { class: 'lens-link', type: 'button', onClick: onSplitDate }, d.split ? 'Change ›' : 'Choose a Day ›') : null;
    if (!d.split) return section('Split at', h('p', { class: 'lens-note' }, 'Compare the rate before and after a day. ', change));
    const sum = splitSummary(d.split);
    return section(['Split at', formatShortDate(d.split.at)],
      h('div', { class: 'lens-grid wide' }, kv('Before', splitSide(d.split.before)), kv('After', splitSide(d.split.after)),
        sum ? kv('Rate', h('span', { title: sum.title }, sum.rates.replace(/ [▲▼≈].*$/, ''), sum.dir === 'higher' ? h('span', { class: 'err' }, ' ▲') : sum.dir === 'lower' ? h('span', { class: 'ok' }, ' ▼') : null)) : null),
      h('p', { class: 'lens-note' }, 'A comparison of rates, not a verdict on a fix: other changes on those days count too. ', change));
  }

  function splitSide(s) {
    return `${plural(s.n, 'failure')} in ${plural(s.days, 'day')} · ${plural(s.sessions, 'session')}${s.perActiveSession != null ? ` · ${sig2(s.perActiveSession)} per active session` : ''}`;
  }

  // -- run (session row) ----------------------------------------------------

  function runFrame(r) {
    const impacts = Object.entries(r.impact ?? {}).filter(([, n]) => n > 0).sort((a, b) => impactRank(a[0]) - impactRank(b[0]));
    return h('div', { class: 'lens-frame' },
      h('header', { class: 'lens-header' },
        statusLine([agentItem(r.run.agent), r.run.status === 'possibly-running' ? liveItem(true) : h('span', { class: 'muted' }, 'finished'), unattItem(r.run.unattended)]),
        h('h2', { class: 'lens-title t-title' }, r.run.title || shortId(r.run.root, 16)),
        h('div', { class: 't-row2', title: `${stampTitle(r.run.start)} → ${stampTitle(r.run.end)}` }, `${formatClock(r.run.start, { digits: 0 })} → ${formatClock(r.run.end, { digits: 0, date: false })}`)),
      section('Run report',
        h('p', { class: 'lens-row wrap' }, impacts.map(([k, n], i) => [i ? ' · ' : null, h('span', { class: `tone-${IMPACT[k]?.tone} b-plain` }, mark(k), `${formatInt(n)} ${IMPACT[k]?.word ?? k}`)])),
        h('div', { class: 'lens-grid wide' },
          kv('Turns', formatInt(r.turns?.total)),
          kv('Steps', `${formatInt(r.steps?.total)} · ${formatInt(r.steps?.withFailure)} with a failure`),
          kv('Delegations', `${formatInt(r.delegations?.total)} · ${formatInt(r.delegations?.silent)} silent`),
          kv('Claims', `${formatInt(r.claims?.unverified)} unverified`),
          r.stall?.stalledForS ? kv('Stall', h('span', { class: 'warn' }, `no event for ${formatDuration(r.stall.stalledForS * 1e6)}`)) : null)),
      r.attention?.length
        ? section('Needs attention', h('ul', { class: 'mini-queue' }, r.attention.map((q) => h('li', null, h('button', { class: 'lens-link', type: 'button', onClick: () => app.openQueueRow(q) },
          `${SECTION[q.section]?.label ?? q.kind}: `, signatureText(q.signature ?? q.target ?? q.id))))))
        : null,
      gapsSection(r.gaps),
      setActionsFor('session', r, {
        primary: { label: 'Show in Session', primary: true, onClick: () => app.showSession(r.run.session) },
        events: { label: 'Show in Events', onClick: () => app.showFilterInEvents(`session == ${JSON.stringify(r.run.session)}`) },
        follow: { label: 'Follow', key: 'f', disabled: 'Select an item of the run to follow a call' },
        report: { label: 'Copy Report', key: 'c', disabled: 'Use the run report in Session · Steps' },
      }));
  }

  // -- keyboard -------------------------------------------------------------

  function focusIndex(i) {
    if (!attemptEls.length) return;
    focused = Math.max(0, Math.min(attemptEls.length - 1, i));
    for (const [k, li] of attemptEls.entries()) li.classList.toggle('focused', k === focused);
    // ↑ and ↓ expand a folded attempt when they reach it (with the parallel group it belongs to).
    let unit = attemptEls[focused].closest('.ladder > li');
    if (unit?.hidden) {
      while (unit && !unit.classList.contains('ladder-fold')) unit = unit.previousElementSibling;
      unit?.querySelector('button')?.click();
    }
    if (app.lensContext) {
      const a = data?.attempts?.[focused];
      Object.assign(app.lensContext, { focusedEvent: a?.eventId ?? null, ts: a?.ts ?? app.lensContext.ts });
    }
    attemptEls[focused].focus({ preventScroll: false });
  }

  function focusAttempt(dir) {
    focusIndex(focused < 0 ? (dir > 0 ? 0 : attemptEls.length - 1) : focused + dir);
  }

  // Times follow the time reference (t); the frame keeps its scroll position.
  app.state.subscribe(['timeRef'], () => {
    if (!data) return;
    const top = body.scrollTop;
    render();
    body.scrollTop = top;
  });
  // A signature shows the split date in force: a new date reloads it.
  app.state.subscribe(['signatureSplitAt'], () => {
    if (item?.kind === 'signature') show(item);
  });

  el.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.target.closest('input, textarea, select')) return;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && attemptEls.length) {
      e.preventDefault();
      focusAttempt(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && !e.shiftKey && focused >= 0 && document.activeElement === attemptEls[focused]) {
      e.preventDefault();
      goEvent(attemptEls[focused].dataset.event);
    }
  });

  return {
    el,
    show,
    clear: clearLens,
    focusAttempt,
    /** The item shown and its payload (null while loading). */
    current: () => ({ item, data, focusedEvent: focused >= 0 ? attemptEls[focused]?.dataset.event ?? null : null }),
    focus: () => body.focus({ preventScroll: true }),
  };
}

// ---------------------------------------------------------------------------
// Event pane: the event an attempt, evidence row or call chip names, with its derived note and raw source. Failures
// docks it beside the Lens; Session · Steps shows it as its inspector.

function pretty(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * @param {any} app
 * @param {{ onShow?: (eventId: string) => void, onHide?: () => void, showInSession?: boolean }} opts
 * @returns {{ el: HTMLElement, show(eventId: string): Promise<void>, hide(): void, current(): string | null }}
 */
export function createEventPane(app, { onShow, onHide, showInSession = true } = {}) {
  const title = h('code', { class: 'pane-sub id-text' });
  const body = scrollShadows(h('div', { class: 'fx-ev-body' }));
  let current = null;
  let seq = 0;
  const el = h('aside', { class: 'pane fx-evidence', hidden: true, 'aria-label': 'Event evidence', 'data-shows-selection': '', 'data-f6': '' },
    h('div', { class: 'pane-head' },
      h('span', { class: 'pane-title' }, 'Event'), title, h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', type: 'button', onClick: () => current && app.selectEvent(current) }, 'Show in Events'),
      showInSession ? h('button', { class: 'btn small', type: 'button', title: 'Show in Session (⇧↩)', onClick: () => current && app.showInSession(current) }, 'Show in Session') : null,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close the event pane', title: 'Close (Esc)', onClick: () => hide() }, icon('close', 12))),
    body);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hide();
    }
  });

  function hide() {
    if (el.hidden) return;
    el.hidden = true;
    current = null;
    seq++;
    onHide?.();
  }

  async function show(eventId) {
    const my = ++seq;
    current = eventId;
    el.hidden = false;
    // Identifiers cut in the middle: 6 leading and 4 trailing characters (§3.5); the full id is the accessible name.
    title.textContent = eventId.length > 14 ? `${eventId.slice(0, 6)}…${eventId.slice(-4)}` : eventId;
    title.title = eventId;
    title.setAttribute('aria-label', eventId);
    // The shell's selection follows, so Shift+Enter, f and t act on this event.
    onShow?.(eventId);
    clear(body).append(placeholder('loading', 'Loading the event…'));
    const [ev, der, raw] = await Promise.allSettled([app.api.event(eventId), app.api.eventDerived(eventId), app.api.raw(eventId, 4000)]);
    if (my !== seq) return;
    // A call's duration is its span's, with the span's provenance (§7.9 Tool Call first line, FP4-12).
    const spanId = ev.status === 'fulfilled' ? ev.value?.event?.span : null;
    const span = spanId ? (await app.api.span(spanId).catch(() => null))?.span ?? null : null;
    if (my !== seq) return;
    clear(body);
    if (ev.status !== 'fulfilled' || !ev.value?.event) {
      body.append(placeholder('error', 'Could not load this event.', ev.reason?.message ?? 'It is no longer in the index.'));
      return;
    }
    const e = ev.value.event;
    const d = der.status === 'fulfilled' ? der.value : null;
    const tool = e.attrs?.tool ?? {};
    // Element.append writes null as the text "null": parts that do not apply are left out.
    const exit = tool.exit_code ?? d?.failure?.exitCode ?? null;
    body.append(...[
      tool.name || span?.dur != null ? h('div', { class: 'follow-first t-pane' }, tool.name ?? span?.name ?? e.kind,
        span?.dur != null ? [' · ', formatDuration(span.dur), provEl(app, span.durSrc && span.durSrc.includes(':') ? span.durSrc : span.durSrc ? `derived:${span.durSrc}` : null)] : null,
        exit != null ? h('span', { class: exit ? 'err' : null }, ` · exit ${exit}`, provEl(app, d?.failure?.exitSrc)) : null) : null,
      h('div', { class: 'fx-ev-sum' }, h('code', { class: 'code-token' }, e.kind), ' ', e.summary ?? ''),
      h('div', { class: 't-meta', title: stampTitle(e.ts) }, formatClock(e.ts, { digits: 3, offset: true })),
      d?.failure ? h('div', { class: 'fx-ev-note' }, tierChip(d.failure.tier, { solid: true }), ' ', h('span', null, noteText(d.failure)), provEl(app, `inferred:${d.failure.rule}`)) : null,
      d?.step ? h('div', { class: 't-row2' }, cap(stepWords({ session: d.step.n, n: d.step.inTurn?.n ?? 1, of: d.step.inTurn?.of ?? 1 })), provEl(app, d.step.segSrc)) : null,
      tool.command || tool.input_summary ? codeBlock(tool.command ?? tool.input_summary, { head: 6, tail: 4, label: 'input' }) : null,
      typeof tool.output === 'string' ? h('div', null, h('div', { class: 'sec-label' }, 'Output'), codeBlock(tool.output, { head: 6, tail: 4 })) : null,
      typeof tool.output_tail === 'string' ? h('div', null, h('div', { class: 'sec-label' }, 'Output tail'), codeBlock(tool.output_tail, { head: 0, tail: 6 })) : null,
      h('details', { class: 'fx-raw' }, h('summary', { class: 'sec-label' }, 'Raw source line'),
        raw.status === 'fulfilled' && raw.value?.available
          ? h('pre', { class: 'code-block' }, pretty(raw.value.text))
          : h('p', { class: 'lens-note' }, raw.value?.reason ?? raw.reason?.message ?? 'Raw bytes are unavailable.')),
    ].filter(Boolean));
  }

  return { el, show, hide, current: () => current };
}
