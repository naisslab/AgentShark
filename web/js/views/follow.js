// Follow (docs/DESIGN.md §7.9): the stream of one tool call, delegation, process or file. It never adds a pane: it
// takes over the region of the workspace it was opened from (the element marked data-follow-host): the Lens column
// in Failures, the Raw pane (or the whole lower region below 1440 px) in Events, the inspector in Session · Steps.
// Esc returns. `f` opens the stream that fits the selection; tabs switch to the other streams of the same event.
// Markers say where the index cut text. Trace text goes in through text nodes only.

import { h, clear, placeholder, icon, mark, openDialog, copyText, codeBlock, proseBlock, autoTitle, scrollShadows } from '../lib/dom.js';
import { formatInt, formatDuration, formatClock, formatShortDate, stampTitle, shortId, plural, sameDay, tzOffset } from '../lib/format.js';
import { FOLLOW_LABEL, followKey, followLabel, procName, reassembleOutput, refTime, sessionOfDerivedId } from '../lib/derived.js';
import { provEl, tierChip, loadDiff } from './lens.js';

let panel = null;

/**
 * Open the panel on `target`. `targets` lists every stream the selection belongs to (lib/derived.js
 * followTargets); the panel shows them as tabs.
 * @param {{kind:'call', eventId}|{kind:'delegation', spanId}|{kind:'process', id}|{kind:'file', session, path}} target
 */
export function openFollow(app, target, { targets } = {}) {
  panel ??= createPanel(app);
  panel.open(target, targets?.length ? targets : [target]);
}

/** The session a stream belongs to (for Export Capture). */
function sessionOf(target, items) {
  if (target.kind === 'file') return target.session;
  if (target.kind === 'process') return sessionOfDerivedId(target.id);
  return items.find((i) => i.sessionId)?.sessionId ?? null;
}

const ROLE = {
  call: 'call', result: 'result', persisted: 'persisted', exec: 'exec',
  task: 'task', 'child-step': 'step', 'child-failure': 'failure', 'child-final': 'final message', 'parent-saw': 'parent saw', 'parent-next': 'next',
  open: 'open', poll: 'poll', input: 'input', output: 'output', deferred: 'deferred', close: 'closed', error: 'error', kill: 'killed',
  read: 'read', edit: 'edit', write: 'write', patch: 'patch', external: 'external edit', backup: 'backup', 'shell-mention': 'shell mention', marker: 'index cut',
};
/** The length the engine cuts a delegation task excerpt to; an excerpt this long is taken as cut. */
const TASK_EXCERPT = 300;

/**
 * The full text an excerpt was cut from: the longest string in the event's decoded fields that starts with it
 * (whitespace folded), or null.
 */
async function fullText(app, eventId, excerpt) {
  const fold = (t) => t.replace(/\s+/g, ' ').trim();
  const stem = fold(excerpt.replace(/…$/, '')).slice(0, 200);
  const ev = await app.api.event(eventId).catch(() => null);
  let best = null;
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.length > excerpt.length && (!best || v.length > best.length) && fold(v).startsWith(stem)) best = v;
    } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(ev?.event?.attrs);
  return best;
}

/** File change ops worth a word beside the role ("edit · new file"); the others repeat the role. */
const FILE_OP = { add: 'new file', delete: 'deleted', move: 'moved' };

function createPanel(app) {
  const tabs = h('div', { class: 'follow-tabs', role: 'tablist', 'aria-label': 'Followed streams' });
  const tz = h('span', { class: 't-meta follow-tz' });
  const body = scrollShadows(h('div', { class: 'follow-body', tabindex: '-1' }));
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Back (Esc)', 'aria-label': 'Close Follow and go back', onClick: () => close() }, icon('close', 12));
  const el = h('section', { class: 'follow pane', role: 'region', 'aria-label': 'Follow', 'data-f6': '' },
    h('div', { class: 'pane-head' }, h('span', { class: 'pane-title' }, 'Follow'), tabs, h('span', { class: 'spacer' }), tz, closeBtn),
    body);
  el.hidden = true;
  let host = null;
  let opener = null;
  let target = null;
  let targets = [];
  let items = [];
  let page = null;
  let seq = 0;

  /**
   * Take over the opening workspace's Follow region. A workspace without one (Timeline, Statistics, Diagnostics,
   * Sources, Transcript, Flow) docks Follow under its content, 180–300 px tall (DESIGN Mac and Web notes).
   */
  const place = () => {
    const ws = app.state.get('workspace');
    const root = document.querySelector(`.workspace[data-ws="${ws}"]`);
    const session = ws === 'session' && app.state.get('sessionMode') !== 'steps';
    let next = session ? null : root?.querySelector('[data-follow-host]');
    if (!next && root) {
      next = root.querySelector(':scope > .follow-dock') ?? h('div', { class: 'follow-dock', 'data-follow-host': '' });
      root.append(next);
    }
    if (host && host !== next) host.classList.remove('follow-on');
    host = next;
    hostWs = host?.closest('.workspace')?.dataset.ws ?? null;
    host?.append(el);
    host?.classList.add('follow-on');
    window.dispatchEvent(new CustomEvent('agentshark:follow', { detail: { open: true, el, host } }));
  };
  const close = () => {
    if (el.hidden) return;
    el.hidden = true;
    host?.classList.remove('follow-on');
    window.dispatchEvent(new CustomEvent('agentshark:follow', { detail: { open: false, el, host } }));
    target = null;
    seq++;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden && !document.querySelector('dialog[open], .menu')) {
      e.preventDefault();
      close();
    }
  });
  // Leaving the workspace that hosts Follow closes it; the next `f` opens it where the user is.
  let hostWs = null;
  app.state.subscribe(['workspace'], (st) => {
    if (!el.hidden && hostWs && st.workspace !== hostWs) close();
  });
  // Times follow the time reference (t).
  app.state.subscribe(['timeRef'], () => {
    if (!el.hidden && page) render();
  });

  function renderTabs() {
    tabs.replaceChildren(...targets.map((t) => {
      const on = followKey(t) === followKey(target);
      const [kind, ...rest] = (t.label ?? FOLLOW_LABEL[t.kind]).split(' · ');
      return h('button', {
        class: ['follow-tab', on && 'on'], role: 'tab', type: 'button', 'aria-selected': String(on), tabindex: on ? '0' : '-1',
        title: t.kind === 'file' ? t.path : null, onClick: () => select(t),
      }, h('span', { class: 'follow-tab-kind' }, kind), rest.length ? [h('span', { class: 'follow-tab-sep', 'aria-hidden': 'true' }, '·'), autoTitle(h('span', { class: 'follow-tab-subject' }, rest.join(' · ')), rest.join(' · '))] : null);
    }));
  }
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = targets.findIndex((t) => followKey(t) === followKey(target));
    const next = targets[(i + (e.key === 'ArrowRight' ? 1 : -1) + targets.length) % targets.length];
    e.preventDefault();
    select(next).then(() => tabs.querySelector('[aria-selected="true"]')?.focus());
  });

  async function open(t, list) {
    opener = document.activeElement instanceof HTMLElement && !el.contains(document.activeElement) ? document.activeElement : opener;
    targets = list.some((x) => followKey(x) === followKey(t)) ? list : [t, ...list];
    el.hidden = false;
    place();
    await select(t);
    body.focus({ preventScroll: true });
  }

  async function select(t) {
    target = t;
    items = [];
    page = null;
    renderTabs();
    clear(body).append(placeholder('loading', 'Loading the stream…'));
    await load();
  }

  async function load(after) {
    const my = ++seq;
    try {
      const res = await app.api.follow(target, { after });
      if (my !== seq) return;
      page = res;
      items = after ? [...items, ...(res?.items ?? [])] : res?.items ?? [];
      if (target.kind === 'call' && !after) await loadCallSpan(my);
      render();
    } catch (err) {
      if (my !== seq) return;
      page = null;
      const ev = target.kind === 'call' ? target.eventId : null;
      const showEvents = target.kind === 'file'
        ? { label: 'Show Changes in Events', onClick: () => app.showFilterInEvents(`change.path == ${JSON.stringify(target.path)}`) }
        : ev ? { label: 'Show in Events', onClick: () => app.selectEvent(ev) } : null;
      clear(body).append(err.status === 501
        ? placeholder('empty', `${FOLLOW_LABEL[target.kind]} streams are not derived by this server`, 'The Lens, Session · Steps and the Events detail still show this evidence.', showEvents)
        : err.status === 404
          ? placeholder('empty', 'Nothing to follow', 'The stream is no longer in the index, or the selection has no such stream.', showEvents)
          : placeholder('error', 'Could not load this view.', ['Your selection is preserved.', h('div', { class: 't-meta' }, err.message)], { label: 'Retry', onClick: () => select(target) }));
    }
  }

  /** A call's duration is its span's (GET /api/spans/:id), with the span's provenance (§7.9 Tool Call). */
  let callSpan = null;
  async function loadCallSpan(my) {
    callSpan = null;
    const call = items.find((i) => i.role === 'call');
    const ev = await app.api.event(call?.eventId ?? target.eventId).catch(() => null);
    const spanId = ev?.event?.span;
    if (!spanId || my !== seq) return;
    callSpan = (await app.api.span(spanId).catch(() => null))?.span ?? null;
  }

  // ---------------------------------------------------------------------------
  // Shared pieces

  /** The first timestamp of the panel: later times carry a short date prefix when their day differs (§7.9). */
  let base = null;
  const when = (ts) => {
    if (ts == null) return h('span', { class: 'follow-time faint' }, '—');
    const ref = app.state.get('timeRef');
    const clock = formatClock(ts, { digits: 3, date: false });
    const text = ref != null ? refTime(ts, ref) : base != null && !sameDay(ts, base) ? `${formatShortDate(ts)} ${clock}` : clock;
    return h('time', { class: 'follow-time', title: stampTitle(ts) }, text);
  };
  const evLink = (id, label = 'Event ›') => (id ? h('button', { class: 'lens-link follow-ev', type: 'button', onClick: () => app.selectEvent(id) }, label) : h('span', { class: 'follow-ev' }));
  const exitEl = (code, src) => (code != null ? h('span', { class: code ? 'err' : null }, `exit ${code}`, provEl(app, src)) : h('span', { class: 'faint', title: 'No exit code was logged' }, 'exit —'));
  const cut = (reason) => h('div', { class: 'code-omitted follow-cut', title: reason }, `⋯ ${reason} ⋯`);
  /** A numbered stage: a section label and its content (§7.9 Body). */
  const stage = (n, title, ...children) => h('section', { class: 'follow-stage' }, h('h3', { class: 'sec-label follow-stage-head' }, n ? `${n} · ${title}` : title), ...children);

  /** Head and tail of one item, with the cut between them. */
  const headTail = (it) => [it.head ? codeBlock(it.head, { head: 6, tail: 4 }) : null, it.tail ? [cut('the index keeps the head and the tail'), codeBlock(it.tail, { head: 0, tail: 6 })] : null];

  /** A list row (§7.9 Process): word (64), time (120), description (flex), "Event ›" on the right of the same line. */
  function row(it, { word, desc, extra = null, cls = null } = {}) {
    const text = desc !== undefined ? desc : it.excerpt ?? it.head?.split('\n').find((x) => x.trim()) ?? '';
    return h('li', { class: ['follow-row', `role-${it.role}`, it.betweenAttempts && 'between', cls] },
      h('span', { class: 'follow-word' }, word ?? ROLE[it.role] ?? it.role),
      when(it.ts),
      autoTitle(h('span', { class: 'follow-desc' }, text, it.reason ? h('span', { class: 'muted' }, ` · ${it.reason}`) : null), text),
      // One grid cell for the extras, so "Event ›" always keeps the last cell of the same line.
      h('span', { class: 'follow-extra' }, extra),
      evLink(it.eventId));
  }

  /** Raw bytes gone (gap raw-unavailable, or a marker that says so): say why, offer Export Capture. */
  function rawBanner() {
    const gap = (page?.gaps ?? []).find((g) => g.code === 'raw-unavailable');
    const reasons = [...new Set(items.filter((i) => i.role === 'marker' && /raw/i.test(i.reason ?? '')).map((i) => i.reason))];
    if (!gap && !reasons.length) return null;
    const capture = app.state.get('info')?.mode === 'capture';
    const sid = sessionOf(target, items);
    return h('div', { class: 'follow-raw', role: 'status' },
      h('span', { class: 'warn' }, mark('info', { label: 'data gap' })),
      h('div', { class: 'prose' },
        gap?.count != null ? `Raw bytes are gone for ${plural(gap.count, 'item')}.` : 'Raw bytes are gone.',
        ' ', reasons.length ? reasons.join(' ') : gap?.message ?? '',
        ' ', capture ? 'This capture was written without them; only the index excerpts below remain.' : 'The excerpts below are what the index kept.'),
      capture
        ? h('button', { class: 'btn', type: 'button', onClick: () => app.showCaptureDetails?.() }, 'Capture Details')
        : h('button', { class: 'btn', type: 'button', onClick: () => exportCapture(app, sid) }, 'Export Capture'));
  }

  // ---------------------------------------------------------------------------
  // Per-kind views

  function callView() {
    const s = page?.subject ?? {};
    const call = items.find((i) => i.role === 'call');
    const results = items.filter((i) => i.role === 'result');
    const persisted = items.filter((i) => i.role === 'persisted');
    const execs = items.filter((i) => i.role === 'exec');
    const markers = items.filter((i) => i.role === 'marker' && !/raw/i.test(i.reason ?? ''));
    const last = results[results.length - 1];
    // First line: "Bash · 160ms≈ · exit 1~" (§7.9 Tool Call).
    const dur = callSpan?.dur != null ? h('span', null, formatDuration(callSpan.dur), provEl(app, callSpan.durSrc && !/^logged/.test(callSpan.durSrc) ? (callSpan.durSrc.includes(':') ? callSpan.durSrc : `derived:${callSpan.durSrc}`) : null))
      : h('span', { class: 'faint', title: 'The call has no measured span' }, 'duration —');
    return [
      h('div', { class: 'follow-first t-pane' }, h('span', null, s.tool ?? 'Tool call'), ' · ', dur, ' · ', exitEl(last?.exitCode ?? s.exitCode, last?.exitSrc ?? s.exitSrc),
        s.tier ? [' · ', tierChip(s.tier)] : null),
      stage(1, 'Input', call ? [h('div', { class: 'follow-meta' }, when(call.ts), evLink(call.eventId)), codeBlock(call.head ?? call.excerpt ?? '', { head: 6, tail: 4, label: 'input' })] : h('p', { class: 'lens-note' }, 'The call event is not in the index.')),
      stage(2, 'Output', results.length
        ? results.map((r) => [
          h('div', { class: 'follow-meta' }, when(r.ts), r.episodeId ? h('button', { class: 'lens-link', type: 'button', onClick: () => app.openEpisode(r.episodeId) }, 'Episode ›') : null, evLink(r.eventId)),
          r.head || r.tail ? headTail(r) : h('p', { class: 'lens-note' }, 'No output was logged for this result.'),
          r.reason ? h('p', { class: 'lens-note' }, r.reason) : null])
        : h('p', { class: 'lens-note' }, 'No result yet: the call has not returned, or its result was not logged.')),
      persisted.length ? stage(3, 'Persisted output', h('ul', { class: 'follow-rows' }, persisted.map((p) => row(p, {
        extra: p.path ? h('a', { class: 'lens-link', href: app.api.fileUrl({ path: p.path }), target: '_blank', rel: 'noopener' }, 'Open File ›') : null,
      })))) : null,
      execs.length ? stage(persisted.length ? 4 : 3, `Commands the script ran (${formatInt(execs.length)})`, h('ul', { class: 'follow-rows' }, execs.map((x) => row(x)))) : null,
      markers.length ? stage(3 + !!persisted.length + !!execs.length, 'Cuts', h('ul', { class: 'follow-rows' }, markers.map((m) => row(m)))) : null,
    ];
  }

  function delegationView() {
    const by = (role) => items.filter((i) => i.role === role);
    const child = items.filter((i) => i.role === 'child-step' || i.role === 'child-failure');
    // Failure bands: consecutive failing child rows of one episode share a band with its label.
    const childList = h('ol', { class: 'follow-rows' });
    const bands = [];
    let band = null;
    for (const it of child) {
      const bad = it.role === 'child-failure' || it.tier === 'failure' || it.tier === 'suspect';
      if (!bad) {
        band = null;
        childList.append(row(it, { word: 'step' }));
        continue;
      }
      if (!band || band.dataset.episode !== (it.episodeId ?? '')) {
        band = h('ol', { class: 'follow-rows', dataset: { episode: it.episodeId ?? '' } });
        const count = h('span', { class: 't-meta' });
        bands.push({ band, count });
        // One label per band with its step count: a 3 px bar and a flat wash, no hatching (§5.2 items 1 and 5).
        childList.append(h('li', { class: ['follow-band', it.tier === 'suspect' && 'suspect'] },
          h('div', { class: 'follow-band-head' }, h('span', { class: 'sec-label err' }, 'Failure band'), count,
            it.episodeId ? h('button', { class: 'lens-link', type: 'button', onClick: () => app.openEpisode(it.episodeId) }, 'Episode ›') : null),
          band));
      }
      band.append(row(it, { word: 'step', extra: it.tier ? tierChip(it.tier) : null }));
    }
    for (const b of bands) b.count.textContent = plural(b.band.childElementCount, 'step');
    const saw = by('parent-saw')[0];
    const s = page?.subject ?? {};
    const task = by('task')[0];
    return [
      stage(1, 'Task', task ? [h('div', { class: 'follow-meta' }, when(task.ts), evLink(task.eventId)), taskBlock(task)] : h('p', { class: 'lens-note' }, 'The task was not logged.')),
      stage(2, childHeading(child),
        child.length ? childList : h('p', { class: 'lens-note' }, s.childSessionId ? 'The child logged no calls.' : 'The child session is not indexed.'),
        s.childSessionId ? h('button', { class: 'lens-link', type: 'button', onClick: () => app.showSession(s.childSessionId) }, 'Open the Child in Session ›') : null),
      stage(3, 'Final message', ...(by('child-final').length ? by('child-final').map((f) => [h('div', { class: 'follow-meta' }, when(f.ts), evLink(f.eventId)), proseBlock(f.head ?? f.excerpt ?? '', { lines: 6 })]) : [h('p', { class: 'lens-note' }, 'The child returned no final message.')])),
      stage(4, 'Result the parent saw',
        saw ? [h('div', { class: 'follow-meta' }, when(saw.ts), saw.tier ? tierChip(saw.tier) : null,
          s.parentTold === false ? h('span', { class: 'err' }, 'parent told: no', provEl(app, 'inferred:parent-told@2')) : s.parentTold === true ? h('span', null, 'parent told: yes', provEl(app, 'inferred:parent-told@2')) : null,
          evLink(saw.eventId)), proseBlock(saw.head ?? saw.excerpt ?? '', { lines: 6 }), saw.reason ? h('p', { class: 'lens-note' }, saw.reason) : null]
          : h('p', { class: 'lens-note' }, 'The parent saw no result from this child.')),
      stage(5, 'Parent’s next step', by('parent-next').length ? h('ul', { class: 'follow-rows' }, by('parent-next').map((n) => row(n, { word: 'next' }))) : h('p', { class: 'lens-note' }, 'The parent made no further call in that turn.')),
    ];
  }

  /**
   * The task (§7.9 Delegation: prose clamp 4 lines and "Show all"). The stream carries an excerpt the engine cut
   * without "…" or its length (§12 engine), so the block ends in "…" and swaps in the full text from the task event.
   */
  function taskBlock(task) {
    const excerpt = task.excerpt ?? task.head ?? '';
    const host = h('div', null, proseBlock(excerpt, { lines: 4, cut: excerpt.length >= TASK_EXCERPT }));
    if (task.eventId) {
      const my = seq;
      fullText(app, task.eventId, excerpt).then((text) => {
        if (text && my === seq) host.replaceChildren(proseBlock(text, { lines: 4 }));
      });
    }
    return host;
  }

  /** "Child steps (63 steps · 4 failed calls)", "(63 steps so far)" while more pages remain. */
  function childHeading(child) {
    const steps = child.filter((i) => i.role === 'child-step').length;
    const fails = child.length - steps;
    const parts = [`${plural(steps, 'step')}${page?.next ? ' so far' : ''}`, fails ? plural(fails, 'failed call') : null].filter(Boolean);
    return `Child steps (${parts.join(' · ')})`;
  }

  function processView() {
    const open = items.find((i) => i.role === 'open');
    const s = page?.subject ?? {};
    const stream = items.filter((i) => i.role !== 'open');
    const parts = reassembleOutput(items);
    const n = (role) => stream.filter((i) => i.role === role).length;
    const ended = stream.find((i) => i.role === 'close' || i.role === 'kill' || i.role === 'error');
    const state = s.status === 'running' ? 'Running' : ended?.role === 'kill' ? 'Killed' : ended?.role === 'error' ? 'Ended on an error' : 'Exited';
    return [
      stage(1, 'Command', open ? [h('div', { class: 'follow-meta' }, when(open.ts), evLink(open.eventId)), codeBlock(open.head ?? open.excerpt ?? '', { head: 6, tail: 2, label: 'command' })] : codeBlock(s.program ?? '', {}),
        // "Exited · exit 0~ · 0 polls · 0 inputs" (§7.9 Process).
        h('div', { class: 'follow-first' }, `${state} · `, s.exitCode != null ? exitEl(s.exitCode, s.exitSrc) : h('span', { class: 'faint', title: 'No exit line was seen' }, 'exit —'),
          ` · ${plural(n('poll'), 'poll')} · ${plural(n('input'), 'input')}${n('deferred') ? ` · ${plural(n('deferred'), 'deferred result')}` : ''}`)),
      stage(2, 'Lifecycle', h('ol', { class: 'follow-rows' }, stream.map((it) => row(it, it.role === 'deferred' ? { word: 'deferred', desc: it.excerpt ?? 'still running' } : {})))),
      stage(3, 'Reassembled output', parts.length
        ? h('div', { class: 'follow-output' }, parts.map((p) => (p.kind === 'cut' ? cut(p.reason) : codeBlock(p.text, { head: 12, tail: 6 }))))
        : h('p', { class: 'lens-note' }, 'The process printed nothing the index kept.')),
    ];
  }

  function fileView() {
    const s = page?.subject ?? {};
    const notes = items.filter((it) => it.role === 'marker');
    const list = h('ol', { class: 'follow-rows' }, items.filter((it) => it.role !== 'marker').map((it) => {
      const diffHost = h('div', { class: 'diff-body follow-diff', hidden: true });
      const toggle = it.diffAvailable && it.eventId
        ? h('button', {
          class: 'lens-link', type: 'button', 'aria-expanded': 'false',
          onClick: (e) => {
            diffHost.hidden = !diffHost.hidden;
            e.currentTarget.setAttribute('aria-expanded', String(!diffHost.hidden));
            if (!diffHost.hidden && !diffHost.childElementCount) loadDiff(app, diffHost, it.eventId, it.path ?? target.path);
          },
        }, 'Diff ›')
        : null;
      const op = !it.head ? it.excerpt?.split(' ')[0] : null;
      const li = row(it, {
        desc: it.head ? it.excerpt ?? '' : FILE_OP[op] ?? '',
        extra: [
          it.added != null || it.removed != null ? h('span', { class: 'follow-stat' }, it.added != null ? h('span', { class: 'ok' }, `+${it.added}`) : null, ' ', it.removed != null ? h('span', { class: 'err' }, `−${it.removed}`) : null) : null,
          it.betweenAttempts ? h('span', { class: 'warn', title: 'This change falls between two failed attempts of an episode' }, 'between attempts') : null,
          toggle,
        ],
      });
      li.append(diffHost);
      return li;
    }));
    const caveats = notes.length ? notes.map((m) => m.reason).filter(Boolean) : ['Shell edits are not tracked.'];
    return [
      h('div', { class: 'follow-first' }, `${plural(s.reads ?? 0, 'read')} · ${plural(s.edits ?? 0, 'edit')} · ${plural(s.shellMentions ?? 0, 'shell mention')}`),
      list.childElementCount ? list : h('p', { class: 'lens-note' }, 'No read, edit or mention of this path in the session.'),
      ...caveats.map((c) => h('p', { class: 'lens-note' }, c)),
    ];
  }

  function render() {
    const s = page?.subject ?? {};
    tz.textContent = app.state.get('timeRef') != null ? 'Times from the reference' : `Times ${tzOffset()}`;
    // The tab names its subject once the stream is known ("Tool Call · Bash", "Delegation · <child>").
    const shown = targets.find((t) => followKey(t) === followKey(target));
    const child = s.childSessionId ? app.sessionById(s.childSessionId)?.title ?? s.childTitle ?? shortId(s.childSessionId, 12) : s.childTitle;
    const subject = target.kind === 'call' ? s.tool : target.kind === 'delegation' ? child : target.kind === 'process' ? procName(target.id) ?? s.program : null;
    if (shown && subject && !shown.label?.includes(' · ')) {
      shown.label = followLabel(target.kind, subject);
      renderTabs();
    }
    base = items.find((it) => it.ts != null)?.ts ?? null;
    const view = target.kind === 'call' ? callView() : target.kind === 'delegation' ? delegationView() : target.kind === 'process' ? processView() : fileView();
    clear(body).append(...followNodes(rawBanner(), view));
    if (page?.next) body.append(h('button', { class: 'btn', type: 'button', onClick: () => load(page.next) }, 'Load More'));
  }

  return { open, close };
}

/** The children of a Follow view as a flat list of nodes: views nest arrays at any depth, and append() would print one. */
export function followNodes(...parts) {
  return parts.flat(Infinity).filter((x) => x != null && x !== false);
}

/** Export Capture from the web viewer: the CLI command that writes one, since the browser cannot. */
function exportCapture(app, sessionId) {
  const name = `${(sessionId ?? 'session').replace(/^[a-z]+:/, '').replace(/[^\w.-]+/g, '-').slice(0, 40)}.agentcap`;
  const cmd = `agentshark capture -o ${name}${sessionId ? ` --session '${sessionId}'` : ''}`;
  openDialog({
    title: 'Export Capture',
    body: [
      h('p', null, 'A capture keeps this session in one file: the index excerpts and every raw line that still exists. It cannot bring back bytes that are already gone. Run this where AgentShark is installed:'),
      h('pre', { class: 'code-block' }, cmd),
      h('p', { class: 'dialog-note' }, 'Open it later with agentshark open FILE. A capture holds prompts, outputs and paths; review it before you share it.'),
    ],
    actions: [
      { label: 'Close' },
      { label: 'Copy Command', primary: true, onClick: () => { copyText(cmd).then((ok) => app.toast(ok ? 'Command copied' : 'Could not copy the command', ok ? 'ok' : 'error')); } },
    ],
  });
}
