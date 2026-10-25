// Conversation workspace ("Follow stream"): a chat-style reconstruction of one session (SPEC §7.5).
// It shows exactly one full session (SPEC §7.8): the display filter and the time range do not
// apply, and several selected sessions get an explicit picker. Long sessions get day dividers, a
// turn rail with jumps, and a bounded DOM. All untrusted text is inserted with text nodes; the
// markdown subset below builds DOM nodes directly.

import { h, placeholder, svg, agentDot, autoTitle } from '../lib/dom.js';
import { agentColor, agentLabel, formatClock, formatDate, formatDayLabel, formatDuration, formatInt, formatTokens, shortId, stampTitle } from '../lib/format.js';

const PAGE = 200;
/** maxString passed to the raw API when the user asks for a full output or text. */
const FULL_MAX = 4_000_000;
/** Items kept in the DOM; older ones are dropped from the top and reloaded on demand. */
const MAX_MOUNTED = 2400;
const KEEP_MOUNTED = 1600;
/** Pages fetched at most to reach a turn when the cursor cannot jump. */
const MAX_WALK_PAGES = 150;

const clock = (ts) => formatClock(ts, { digits: 0, date: false });
const timeEl = (ts) => h('time', { class: 'cv-time', title: stampTitle(ts) || null }, clock(ts));

/** Item durations live in `meta` under a few names; µs unless the key says ms. */
function metaDurUs(meta) {
  if (!meta) return null;
  if (typeof meta.dur === 'number') return meta.dur;
  for (const k of ['durMs', 'durationMs', 'duration_ms', 'thinkingMs', 'thinking_ms']) {
    if (typeof meta[k] === 'number') return meta[k] * 1000;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Safe markdown subset: paragraphs, headings, lists, quotes, fenced code, inline code,
// bold and italic. Links render as plain text followed by their URL. Never uses innerHTML.

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE = /^\s*\|.*\|\s*$/;
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__(?!\w)|(?<![\w*])\*(?=\S)([^*]*?\S)\*(?!\w)|(?<!\w)_(?=\S)([^_]*?\S)_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const isBlockStart = (l) => FENCE.test(l) || HEADING.test(l) || LIST.test(l) || QUOTE.test(l) || TABLE.test(l);

function inline(text, depth = 0) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const strong = m[3] ?? m[4];
    const em = m[5] ?? m[6];
    if (m[1]) frag.append(h('code', { class: 'cv-icode' }, m[2].replace(/^ (.+) $/, '$1')));
    else if (strong) frag.append(h('strong', null, depth < 3 ? inline(strong, depth + 1) : strong));
    else if (em) frag.append(h('em', null, depth < 3 ? inline(em, depth + 1) : em));
    else if (m[7]) {
      frag.append(h('span', { class: 'cv-link', title: m[8] }, m[7]));
      if (m[7] !== m[8]) frag.append(h('span', { class: 'cv-url' }, ` (${m[8]})`));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function codeBlock(text, lang) {
  return h('div', { class: 'cv-codeblock' }, lang ? h('div', { class: 'cv-code-lang' }, lang) : null, h('pre', { class: 'cv-pre' }, text));
}

function linesWithBreaks(el, lines) {
  lines.forEach((l, k) => {
    if (k) el.append(h('br'));
    el.append(inline(l));
  });
  return el;
}

function renderMarkdown(src) {
  const out = document.createDocumentFragment();
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = FENCE.exec(line))) {
      const close = m[1][0].repeat(m[1].length);
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      out.append(codeBlock(body.join('\n'), m[2]));
    } else if (!line.trim()) {
      i++;
    } else if ((m = HEADING.exec(line))) {
      out.append(h('div', { class: 'cv-h' }, inline(m[1])));
      i++;
    } else if (TABLE.test(line)) {
      // Tables keep their column alignment in a monospace block.
      const rows = [];
      while (i < lines.length && TABLE.test(lines[i])) rows.push(lines[i++].trim());
      out.append(h('pre', { class: 'cv-pre cv-table' }, rows.join('\n')));
    } else if (QUOTE.test(line)) {
      const rows = [];
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) {
        rows.push(m[1]);
        i++;
      }
      out.append(linesWithBreaks(h('blockquote', { class: 'cv-quote' }), rows));
    } else if ((m = LIST.exec(line))) {
      const ordered = /\d/.test(m[2]);
      const list = h(ordered ? 'ol' : 'ul', { class: 'cv-list-md', start: ordered && parseInt(m[2], 10) !== 1 ? parseInt(m[2], 10) : null });
      let li = null;
      while (i < lines.length) {
        const l = lines[i];
        const lm = LIST.exec(l);
        if (lm) {
          // A nested bullet inside a numbered list keeps its bullet marker.
          const bullet = ordered && !/\d/.test(lm[2]);
          li = h('li', { class: [lm[1].length >= 2 && 'cv-nested', bullet && 'cv-bullet'] }, inline(lm[3]));
          list.append(li);
        } else if (!l.trim()) {
          if (!LIST.test(lines[i + 1] ?? '')) break;
        } else if (/^\s/.test(l) && li && !FENCE.test(l)) {
          li.append(h('br'), inline(l.trim()));
        } else {
          break;
        }
        i++;
      }
      out.append(list);
    } else {
      const para = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
      out.append(linesWithBreaks(h('p', { class: 'cv-p' }), para));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pulling full text out of a raw source record (Claude and Codex shapes).

function contentText(c) {
  if (c == null) return null;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x) => (typeof x === 'string' ? x : (x?.text ?? (/image/.test(x?.type ?? '') ? '[image]' : ''))))
      .join('\n');
  }
  if (typeof c.text === 'string') return c.text;
  return JSON.stringify(c, null, 2);
}

/** Block index from an event id `<source>:<line>.<block>`. */
function blockOf(eventId) {
  const m = /:\d+\.(\d+)$/.exec(eventId);
  return m ? Number(m[1]) : null;
}

function parseRecord(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractOutput(rec, block) {
  const content = rec?.message?.content;
  if (Array.isArray(content)) {
    const results = content.filter((b) => b?.type === 'tool_result');
    const b = content[block]?.type === 'tool_result' ? content[block] : results.length === 1 ? results[0] : null;
    if (b) return contentText(b.content);
  }
  const tur = rec?.toolUseResult;
  if (typeof tur === 'string') return tur;
  if (tur && typeof tur.stdout === 'string') return tur.stderr ? `${tur.stdout}\n[stderr]\n${tur.stderr}` : tur.stdout;
  const p = rec?.payload;
  if (p) {
    if (p.output != null) {
      const s = contentText(p.output);
      const inner = parseRecord(s);
      return typeof inner?.output === 'string' ? inner.output : s;
    }
    for (const k of ['aggregated_output', 'formatted_output', 'stdout']) if (typeof p[k] === 'string') return p[k];
    if (typeof p.item?.aggregatedOutput === 'string') return p.item.aggregatedOutput;
  }
  return null;
}

function extractText(rec, block) {
  const content = rec?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const b = block != null ? content[block] : content.find((x) => typeof x?.text === 'string');
    if (b) return b.text ?? b.thinking ?? contentText(b.content);
  }
  const p = rec?.payload;
  if (p) {
    if (typeof p.message === 'string') return p.message;
    if (typeof p.text === 'string') return p.text;
    if (Array.isArray(p.content)) return contentText(p.content);
    if (Array.isArray(p.summary)) return contentText(p.summary);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Icons by tool kind (16×16 stroke paths).

const ICONS = {
  shell: 'M2 3h12v10H2z M4.5 6l2 2-2 2 M8 10h3.5',
  file: 'M4 1.5h5l3 3v10H4z M9 1.5v3h3',
  web: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2z M2 8h12 M8 2c2.2 2 2.2 10 0 12 M8 2c-2.2 2-2.2 10 0 12',
  mcp: 'M6 1.5v3 M10 1.5v3 M4.5 4.5h7v3a3.5 3.5 0 0 1-7 0z M8 11v3.5',
  agent: 'M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M1.5 13c0-2.2 1.8-4 4-4s4 1.8 4 4 M11 7.5a1.6 1.6 0 1 0 0-3.2 M12 9.2c1.5.4 2.5 1.8 2.5 3.8',
  plan: 'M2 4l1.2 1.2L5.5 3 M7.5 4.2h6.5 M2 9l1.2 1.2L5.5 8 M7.5 9.2h6.5 M7.5 13h6.5',
  other: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.4 3.4l1.4 1.4 M11.2 11.2l1.4 1.4 M3.4 12.6l1.4-1.4 M11.2 4.8l1.4-1.4',
};

function toolIcon(kind) {
  const key = ICONS[kind] ? kind : 'other';
  return svg('svg', { class: `cv-icon cv-k-${key}`, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svg('path', { d: ICONS[key] }));
}

function exitBadge(t) {
  if (typeof t.exitCode === 'number') {
    return h('span', { class: `cv-badge ${t.exitCode === 0 && !t.isError ? 'is-ok' : 'is-err'}` }, `exit ${t.exitCode}`);
  }
  return t.isError ? h('span', { class: 'cv-badge is-err' }, 'error') : null;
}

const prettyJson = (v) => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

function looksTruncated(text, len) {
  if (text == null) return true;
  return (typeof len === 'number' && len > text.length) || /…\[\+\d+\]\s*$/.test(text);
}

// ---------------------------------------------------------------------------

export default function createConversation(root, app) {
  root.classList.add('cv-root');
  const head = h('header', { class: 'cv-head', hidden: true });
  const scroller = h('div', { class: 'cv-scroll' });
  const top = h('div', { class: 'cv-top', hidden: true });
  const list = h('div', { class: 'cv-stream' });
  const foot = h('div', { class: 'cv-foot' });
  const empty = h('div', { class: 'cv-empty-wrap' });
  // The session's facts scroll with the transcript, so the Session header is its only chrome row (§4.5).
  scroller.append(head, top, list, foot);
  root.append(scroller, empty);

  let sessionId = null;
  let shownKey; // session id, or '#<n>' for the empty state with n sessions in scope
  let picked = null; // the session chosen in the picker when several are in scope
  let cursor; // `after` for the next page
  let endCursor; // `after` of the last page, reused to fetch new data once the end was reached
  let startCursor; // `after` the mounted window started from (undefined = session start)
  let done = false;
  let loading = false;
  let generation = 0; // drops responses that belong to a previously shown session or window
  let visible = false;
  let count = 0;
  let mode = null; // cursor kind: 'seq' (jumps possible) or 'offset'; null until a page tells
  let turns = [];
  let detailSession = null;
  let lastDay = null;
  let dropped = false; // items above the window were removed or never loaded
  let staleData = false;
  const seen = new Set(); // event ids mounted in this window

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore();
  }, { root: scroller, rootMargin: '800px 0px' });
  observer.observe(foot);

  app.state.subscribe(['scope'], () => {
    if (visible) sync();
  });
  app.state.subscribe(['indexVersion'], () => {
    if (sessionId && app.changeAffects([sessionId])) {
      staleData = true;
      head.querySelector('.cv-stale')?.removeAttribute('hidden');
    }
  });

  function scopedSessions() {
    const s = app.state.get('scope')?.sessions;
    return Array.isArray(s) ? s : [];
  }

  /** The scope label (§7.3): "1,234 items · full session · the filter and time range do not apply". */
  function publishScope() {
    const parts = [
      sessionId ? `${formatInt(count)} items` : 'No session',
      'full session',
      'the filter and time range do not apply',
    ];
    app.setWorkspaceStatus('conversation', parts.join(' · '));
  }

  function sync() {
    const s = scopedSessions();
    if (picked && !s.includes(picked)) picked = null;
    const sid = s.length ? (picked ?? s[0]) : null;
    const key = sid ? `${sid}|${s.length}` : `#${s.length}`;
    if (key === shownKey) return publishScope();
    shownKey = key;
    open(sid);
  }

  function resetWindow(after) {
    generation++;
    cursor = after;
    startCursor = after;
    endCursor = undefined;
    done = false;
    loading = false;
    count = 0;
    lastDay = null;
    dropped = after != null;
    seen.clear();
    list.replaceChildren();
    foot.replaceChildren();
    scroller.scrollTop = 0;
    renderTop();
  }

  function open(sid) {
    sessionId = sid;
    mode = null;
    turns = [];
    detailSession = null;
    staleData = false;
    head.replaceChildren();
    empty.replaceChildren();
    resetWindow(undefined);
    head.hidden = !sid;
    scroller.hidden = !sid;
    empty.hidden = !!sid;
    publishScope();
    if (!sid) {
      empty.append(placeholder('empty', 'Pick one session', 'Conversation shows one whole session: prompts, answers, thinking, tool calls and subagents in order. Select a session in the sidebar; the display filter and time range do not apply here.'));
      return;
    }
    loadHeader(sid);
    loadMore();
  }

  // ---- header and turn rail

  async function loadHeader(sid) {
    const gen = generation;
    head.replaceChildren(h('div', { class: 'cv-head-row' }, h('span', { class: 'cv-title' }, sid)));
    let detail = null;
    try {
      detail = await app.api.session(sid);
    } catch (err) {
      if (sessionId === sid) head.append(h('div', { class: 'cv-head-err' }, `Session details unavailable: ${err?.message ?? err}`));
      return;
    }
    if (sessionId !== sid || !detail?.session || gen < 0) return;
    app.rememberSessions([detail.session, ...(detail.children ?? [])]);
    detailSession = detail.session;
    turns = (detail.turns ?? []).filter((t) => t.firstEvent).sort((a, b) => a.start - b.start);
    renderHeader(detail.session);
  }

  function fact(label, value, title) {
    if (value == null || value === '') return null;
    return h('span', { class: 'cv-fact', title: title ?? null }, h('span', { class: 'cv-fact-k' }, label), h('span', { class: 'cv-fact-v' }, value));
  }

  function picker() {
    const ids = scopedSessions();
    if (ids.length < 2) return null;
    const sel = h('select', { class: 'select cv-select', 'aria-label': 'Session to show' },
      ids.map((id) => {
        const s = app.sessionById(id);
        return h('option', { value: id, selected: id === sessionId }, `${s?.title || s?.nativeId?.split('/').pop() || shortId(id)} (${shortId(id)})`);
      }));
    sel.addEventListener('change', () => {
      picked = sel.value;
      sync();
    });
    return h('div', { class: 'cv-picker' }, h('span', null, `Showing 1 of ${ids.length} selected sessions:`), sel);
  }

  function turnLabel(t, i) {
    const when = formatClock(t.start, { digits: 0 });
    const name = (t.name || '').replace(/\s+/g, ' ').slice(0, 60);
    return `Turn ${i + 1} · ${when}${name ? ` · ${name}` : ''}`;
  }

  function turnRail() {
    if (!turns.length) return null;
    const sel = h('select', { class: 'select cv-turn-select', 'aria-label': 'Jump to turn' },
      h('option', { value: '' }, `Jump to turn… (${formatInt(turns.length)})`),
      turns.map((t, i) => h('option', { value: String(i) }, turnLabel(t, i))));
    sel.addEventListener('change', () => {
      const i = Number(sel.value);
      sel.value = '';
      if (Number.isInteger(i)) jumpToTurn(i);
    });
    // Start and End are the Session header's inline controls (§7.3); "Jump to turn" stays with the facts.
    app.setModeControls?.([
      h('button', { class: 'tool-btn', type: 'button', title: 'Back to the first item', onclick: () => jumpToStart() }, 'Start'),
      h('button', { class: 'tool-btn', type: 'button', title: 'Jump to the last turn', onclick: () => jumpToTurn(turns.length - 1, true) }, 'End'),
    ]);
    return h('div', { class: 'cv-rail' }, sel);
  }

  function renderHeader(s) {
    const tok = s.tokens ?? {};
    const tokens = [
      tok.input != null ? `in ${formatTokens(tok.input)}` : null,
      tok.output != null ? `out ${formatTokens(tok.output)}` : null,
      tok.cache_read ? `cache ${formatTokens(tok.cache_read)}` : null,
    ].filter(Boolean).join(' · ');
    const dur = s.start != null && s.end != null ? formatDuration(s.end - s.start) : null;
    const reload = h('button', { class: 'btn cv-stale', hidden: !staleData, title: 'The index changed since this conversation was loaded' }, 'Load New Items');
    reload.addEventListener('click', refreshNew);
    head.replaceChildren(...[
      h('div', { class: 'cv-head-row' },
        h('span', { class: 'cv-agent' }, agentDot(agentColor(s.agent)), agentLabel(s.agent)),
        autoTitle(h('h2', { class: 'cv-title t-title' }, s.title || s.nativeId || s.id), s.title || s.nativeId || s.id),
        s.role && s.role !== 'main' ? h('span', { class: 'muted' }, s.role) : null,
        s.state && s.state !== 'ok' ? h('span', { class: 'warn' }, s.state) : null,
        h('span', { class: 'cv-spacer' }),
        reload,
        s.parentId ? h('button', { class: 'btn', onclick: () => app.openSession(s.parentId, { workspace: 'conversation' }) }, 'Parent Session') : null,
      ),
      picker(),
      // Key-value metadata (§7.7 metadata line): keys muted, values in --fg; machine text (cwd) as code.
      h('div', { class: 'cv-facts' },
        fact('Model', (s.models ?? []).join(', ') || null),
        fact('Folder', s.cwd ? h('code', null, s.cwd) : null),
        fact('Tokens', tokens || null),
        fact('Active', s.start != null ? `${formatClock(s.start, { digits: 0 })} → ${formatClock(s.end, { digits: 0, date: formatDate(s.start) !== formatDate(s.end) })}` : null),
        fact('Duration', dur),
        fact('Turns', s.nTurns ? formatInt(s.nTurns) : null),
        fact('Events', s.nEvents != null ? formatInt(s.nEvents) : null),
        s.nErrors ? fact('Errors', formatInt(s.nErrors)) : null,
        s.nChildren ? fact('Subagents', formatInt(s.nChildren)) : null,
      ),
      turnRail(),
    ].filter(Boolean));
  }

  /** The bar above the stream when the window does not start at the session start. */
  function renderTop() {
    top.hidden = !dropped;
    if (!dropped) return top.replaceChildren();
    top.replaceChildren(...[
      h('span', null, 'Earlier items are not loaded.'),
      mode === 'seq' && turns.length ? h('button', { class: 'btn pn-sm', onclick: loadEarlier }, 'Load the previous turn') : null,
      h('button', { class: 'btn pn-sm', onclick: () => jumpToStart() }, 'Back to the start'),
    ].filter(Boolean));
  }

  // ---- paging

  function setFoot(kind, err) {
    foot.replaceChildren();
    if (kind === 'loading') foot.append(placeholder('loading', 'Loading…'));
    else if (kind === 'more') foot.append(h('button', { class: 'btn', onclick: loadMore }, 'Load more'));
    else if (kind === 'end') foot.append(h('div', { class: 'cv-foot-note' }, `End of session · ${formatInt(count)} items in view`));
    else if (kind === 'empty') {
      foot.append(placeholder('empty', 'Nothing to show', 'This session has no conversation items. Its events may all be metadata; check the Events workspace.'));
    } else if (kind === 'error') {
      foot.append(placeholder('error', 'Could not load the conversation. Your place is kept.', String(err?.message ?? err), { label: 'Retry', onClick: loadMore }));
    }
  }

  function footNearView() {
    const f = foot.getBoundingClientRect();
    const r = scroller.getBoundingClientRect();
    return r.height > 0 && f.top < r.bottom + 800;
  }

  /** Render items into a fragment with day dividers; `day` is the day of the item before them. */
  function renderBatch(items, day) {
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const it of items) {
      if (it?.event && seen.has(it.event)) continue;
      if (it?.event) seen.add(it.event);
      // exec items (commands run inside a code-mode call) nest, collapsed, under their call's card.
      if (it?.type === 'exec' && it.parentEvent) {
        const sel = `[data-event="${CSS.escape(it.parentEvent)}"]`;
        const parent = frag.querySelector(sel) ?? list.querySelector(sel);
        if (parent) {
          execHost(parent).append(renderTool(it));
          n++;
          continue;
        }
      }
      const d = Number.isFinite(it?.ts) ? formatDate(it.ts) : day;
      if (d && d !== day) {
        frag.append(h('div', { class: 'cv-day' }, h('span', null, formatDayLabel(it.ts))));
        day = d;
      }
      frag.append(renderItem(it));
      n++;
    }
    return { frag, day, n };
  }

  async function fetchPage(after) {
    const res = await app.api.conversation(sessionId, after, PAGE);
    const items = Array.isArray(res?.items) ? res.items : [];
    const next = res?.next ?? null;
    // A row-offset cursor always advances by the item count; a seq cursor almost never does.
    if (next != null && mode !== 'seq') mode = next === (after ?? 0) + items.length ? (mode ?? 'offset') : 'seq';
    return { items, next };
  }

  async function loadMore() {
    if (!sessionId || loading || done) return;
    const gen = generation;
    loading = true;
    setFoot('loading');
    try {
      const after = cursor;
      const { items, next } = await fetchPage(after);
      if (gen !== generation) return;
      const { frag, day, n } = renderBatch(items, lastDay);
      lastDay = day;
      list.append(frag);
      count += n;
      // A repeated cursor would loop forever; treat it as the end.
      done = next == null || next === cursor || items.length === 0;
      if (done) endCursor = after;
      else cursor = next;
      setFoot(done ? (count ? 'end' : 'empty') : 'more');
      trimTop();
      renderTop();
      publishScope();
    } catch (err) {
      if (gen === generation) setFoot('error', err);
      return;
    } finally {
      if (gen === generation) loading = false;
    }
    // The observer fires only on intersection changes, so keep filling while the footer stays in reach.
    if (gen === generation && visible && !done && footNearView()) loadMore();
  }

  /** Keep the DOM bounded: drop the oldest items once the window is large (seq cursors only). */
  function trimTop() {
    if (mode !== 'seq' || !turns.length) return;
    const items = list.querySelectorAll(':scope > .cv-item');
    if (items.length <= MAX_MOUNTED) return;
    const cut = items[items.length - KEEP_MOUNTED];
    const h0 = scroller.scrollHeight;
    while (list.firstChild && list.firstChild !== cut) {
      const ev = list.firstChild.dataset?.event;
      if (ev) seen.delete(ev);
      list.firstChild.remove();
      count--;
    }
    scroller.scrollTop -= h0 - scroller.scrollHeight;
    dropped = true;
    // The window now starts mid-turn at an unknown cursor.
    startCursor = null;
  }

  /** Index of the turn that contains ts (the last turn starting at or before it). */
  function turnAt(ts) {
    let lo = 0;
    let hi = turns.length - 1;
    let best = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (turns[m].start <= ts) {
        best = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return best;
  }

  async function seqOf(eventId) {
    const d = await app.api.event(eventId).catch(() => null);
    return d?.event?.seq ?? null;
  }

  function reveal(eventId) {
    const el = list.querySelector(`[data-event="${CSS.escape(eventId)}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: 'start' });
    el.classList.add('cv-flash');
    setTimeout(() => el.classList.remove('cv-flash'), 1200);
    return true;
  }

  async function jumpToStart() {
    if (!dropped) {
      scroller.scrollTop = 0;
      return;
    }
    resetWindow(undefined);
    await loadMore();
  }

  /** Jump to turn i: with a seq cursor the window restarts there; otherwise pages are walked. */
  async function jumpToTurn(i, toEnd = false) {
    const t = turns[i];
    if (!t || !sessionId) return;
    if (reveal(t.firstEvent) && !toEnd) return;
    if (mode === 'seq') {
      const seq = await seqOf(t.firstEvent);
      if (seq != null) {
        resetWindow(seq - 1);
        await loadMore();
        if (toEnd) scroller.scrollTop = scroller.scrollHeight;
        return;
      }
    }
    const gen = generation;
    for (let pages = 0; pages < MAX_WALK_PAGES && !done && gen === generation; pages++) {
      foot.replaceChildren(placeholder('loading', `Loading up to turn ${i + 1} of ${turns.length}…`));
      while (loading) await new Promise((r) => setTimeout(r, 50));
      if (list.querySelector(`[data-event="${CSS.escape(t.firstEvent)}"]`)) break;
      await loadMore();
    }
    if (gen !== generation) return;
    if (!reveal(t.firstEvent)) app.toast(`Turn ${i + 1} is further than ${MAX_WALK_PAGES} pages ahead; scroll on to reach it.`, 'warn');
    if (toEnd) scroller.scrollTop = scroller.scrollHeight;
  }

  /** Prepend the turn before the window (seq cursors), keeping the reader's place. */
  async function loadEarlier() {
    const first = list.querySelector(':scope > .cv-item');
    const firstEvent = first?.dataset.event;
    const firstTs = Number(first?.dataset.ts);
    if (!firstEvent || mode !== 'seq') return;
    // The turn holding the first mounted item; when the window starts at that turn, take the one before.
    let ti = turnAt(firstTs);
    let seq = ti >= 0 ? await seqOf(turns[ti].firstEvent) : null;
    if (seq != null && startCursor != null && seq - 1 >= startCursor) {
      ti--;
      seq = ti >= 0 ? await seqOf(turns[ti].firstEvent) : null;
    }
    if (ti < 0) return jumpToStart();
    if (seq == null) return;
    const gen = generation;
    const collected = [];
    let after = seq - 1;
    for (let pages = 0; pages < 40; pages++) {
      const { items, next } = await fetchPage(after);
      if (gen !== generation) return;
      const stop = items.findIndex((it) => it.event === firstEvent);
      collected.push(...(stop >= 0 ? items.slice(0, stop) : items));
      if (stop >= 0 || next == null) break;
      after = next;
    }
    const h0 = scroller.scrollHeight;
    const { frag, day, n } = renderBatch(collected, null);
    // The old first divider repeats the last prepended day; drop it.
    if (list.firstChild?.classList.contains('cv-day') && day === formatDate(firstTs)) list.firstChild.remove();
    list.prepend(frag);
    count += n;
    startCursor = seq - 1;
    dropped = ti > 0;
    scroller.scrollTop += scroller.scrollHeight - h0;
    renderTop();
    publishScope();
  }

  /** New data after an index run: fetch only what follows the loaded items; the scroll stays. */
  async function refreshNew() {
    staleData = false;
    head.querySelector('.cv-stale')?.setAttribute('hidden', '');
    if (sessionId) {
      const sid = sessionId;
      app.api.session(sid).then((d) => {
        if (sessionId !== sid || !d?.session) return;
        turns = (d.turns ?? []).filter((t) => t.firstEvent).sort((a, b) => a.start - b.start);
        renderHeader(d.session);
      }).catch(() => {});
    }
    if (!done) return loadMore();
    done = false;
    cursor = endCursor;
    await loadMore();
  }

  // ---- full text and output

  async function loadFull(eventId, btn, pick, apply) {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const raw = await app.api.raw(eventId, FULL_MAX);
      if (!raw?.available) {
        btn.replaceWith(h('div', { class: 'cv-note' }, `Raw source unavailable${raw?.reason ? `: ${raw.reason}` : ''}.`));
        return;
      }
      const text = pick(parseRecord(raw.text), blockOf(eventId));
      apply(text ?? raw.text);
      const notes = [];
      if (text == null) notes.push('No known field matched, so this is the whole source record.');
      if (raw.truncated) notes.push('The server still shortened some very long strings.');
      const note = h('div', { class: 'cv-note', hidden: !notes.length }, notes.join(' '));
      btn.replaceWith(note);
      if (text && text.includes('<persisted-output>')) addPersistedLink(eventId, note);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      app.toast(`Could not load the full text: ${err?.message ?? err}`, 'error');
    }
  }

  async function addPersistedLink(eventId, after) {
    try {
      const d = await app.api.event(eventId);
      const path = d?.event?.attrs?.tool?.persisted_path;
      if (typeof path === 'string') {
        after.append(' ', h('a', { href: app.api.fileUrl({ path }), target: '_blank', rel: 'noopener' }, 'Open the persisted output file'));
        after.hidden = false;
      }
    } catch {
      // The link is optional; the truncated text is already shown.
    }
  }

  function fullButton(label, onclick) {
    return h('button', { class: 'btn pn-sm', onclick }, label);
  }

  /** Markdown body; offers the full text from the raw record when the index copy was capped. */
  function textBody(it, markdown = true) {
    const body = h('div', { class: markdown ? 'cv-md' : 'cv-md cv-plain' });
    const render = (text) => body.replaceChildren(markdown ? renderMarkdown(text) : text);
    render(it.text ?? '');
    if (!it.text || !looksTruncated(it.text, it.textLen)) return body;
    const btn = fullButton(`Show full text${it.textLen ? ` (${formatTokens(it.textLen)} chars)` : ''}`, () => loadFull(it.event, btn, extractText, render));
    return h('div', null, body, btn);
  }

  // ---- items

  function bubble(role, it, ...meta) {
    return h('div', { class: `cv-bubble cv-${role}` },
      h('div', { class: 'cv-meta' }, h('span', { class: 'cv-who' }, role === 'user' ? 'User' : 'Assistant'), ...meta, timeEl(it.ts)),
      textBody(it));
  }

  function renderText(it) {
    const tok = it.llm?.tokens;
    return bubble('assistant', it,
      it.llm?.model ? h('span', { class: 'cv-model' }, it.llm.model) : null,
      tok?.output != null ? h('span', { class: 'cv-tok', title: 'Output tokens of this model response' }, `${formatTokens(tok.output)} out`) : null);
  }

  function renderThinking(it) {
    const len = it.textLen ?? it.text?.length ?? 0;
    const dur = metaDurUs(it.meta);
    const stats = [
      it.text ? `${formatTokens(len)} chars` : len ? `text omitted (${formatTokens(len)} chars)` : 'text omitted',
      dur != null ? formatDuration(dur) : null,
      it.llm?.tokens?.reasoning != null ? `${formatTokens(it.llm.tokens.reasoning)} reasoning tokens` : null,
    ].filter(Boolean).join(' · ');
    const label = [h('span', { class: 'cv-think-label' }, 'Thinking'), h('span', { class: 'cv-think-stats' }, stats), timeEl(it.ts)];
    if (!it.text) return h('div', { class: 'cv-thinking is-empty', title: 'The agent did not log the thinking text' }, label);
    const det = h('details', { class: 'cv-thinking' }, h('summary', null, label));
    det.addEventListener('toggle', () => {
      if (det.open && det.childElementCount === 1) det.append(textBody(it, false));
    });
    return det;
  }

  function renderTool(it) {
    const t = it.tool ?? { name: 'tool' };
    const card = h('div', { class: `cv-card${t.isError ? ' is-error' : ''}` });
    const body = h('div', { class: 'cv-card-body', hidden: true });
    const headBtn = h('button', { class: 'cv-card-head', 'aria-expanded': 'false' },
      toolIcon(t.kind),
      h('span', { class: 'cv-tool-name' }, t.name || 'tool'),
      h('span', { class: 'cv-tool-sum', title: t.inputSummary ?? null }, t.inputSummary ?? ''),
      t.dur != null ? h('span', { class: 'cv-tool-dur' }, formatDuration(t.dur)) : null,
      exitBadge(t),
      timeEl(it.ts));
    headBtn.addEventListener('click', () => {
      const opening = body.hidden;
      if (opening && !body.childElementCount) buildToolBody(body, it);
      body.hidden = !opening;
      headBtn.setAttribute('aria-expanded', String(opening));
    });
    card.append(headBtn, body);
    return card;
  }

  function buildToolBody(body, it) {
    const t = it.tool ?? {};
    if (t.input !== undefined) {
      body.append(h('div', { class: 'cv-sec' }, h('div', { class: 'cv-sec-title' }, 'Input'), h('pre', { class: 'cv-pre' }, prettyJson(t.input))));
    }
    const out = h('pre', { class: 'cv-pre cv-out' }, t.output ?? '');
    const title = h('div', { class: 'cv-sec-title' }, 'Output', t.outputLen != null ? ` · ${formatTokens(t.outputLen)} chars` : '');
    const sec = h('div', { class: 'cv-sec' }, title);
    if (t.output == null && !t.resultEvent) {
      sec.append(h('div', { class: 'cv-note' }, 'No result was recorded for this call.'));
    } else {
      if (t.output != null) sec.append(out);
      if (t.resultEvent && looksTruncated(t.output, t.outputLen)) {
        const btn = fullButton('Show full output', () => loadFull(t.resultEvent, btn, extractOutput, (text) => {
          out.textContent = text;
          if (!out.isConnected) btn.before(out);
        }));
        sec.append(btn);
      }
      if (t.resultEvent) sec.append(h('button', { class: 'btn pn-sm', onclick: () => app.selectEvent(t.resultEvent) }, 'Result in Events'));
    }
    body.append(sec);
  }

  function renderSubagent(it) {
    const s = it.subagent ?? {};
    const t = it.tool;
    const card = h('div', { class: `cv-card cv-agentcard${t?.isError ? ' is-error' : ''}` },
      h('div', { class: 'cv-card-head is-static' },
        toolIcon('agent'),
        h('span', { class: 'cv-tool-name' }, s.type ? `Subagent · ${s.type}` : 'Subagent'),
        h('span', { class: 'cv-tool-sum', title: s.title ?? t?.inputSummary ?? null }, s.title ?? t?.inputSummary ?? ''),
        t?.dur != null ? h('span', { class: 'cv-tool-dur' }, formatDuration(t.dur)) : null,
        t ? exitBadge(t) : null,
        timeEl(it.ts)),
      h('div', { class: 'cv-agent-actions' },
        s.session
          ? h('button', { class: 'btn', onclick: () => app.openSession(s.session, { workspace: 'conversation' }) }, 'Open subagent conversation')
          : h('span', { class: 'cv-note' }, 'The child session was not found in the index.'),
        s.session ? h('span', { class: 'cv-sid' }, s.session) : null));
    if (t?.output) {
      const det = h('details', { class: 'cv-agent-result' }, h('summary', null, 'Result returned to the parent'));
      det.addEventListener('toggle', () => {
        if (det.open && det.childElementCount === 1) det.append(h('div', { class: 'cv-md' }, renderMarkdown(t.output)));
      });
      card.append(det);
    }
    return card;
  }

  function renderCompaction(it) {
    const pre = it.meta?.preTokens ?? it.meta?.pre_tokens;
    const label = ['Context compacted', it.meta?.trigger ? `(${it.meta.trigger})` : null, typeof pre === 'number' ? `· ${formatTokens(pre)} tokens before` : null]
      .filter(Boolean).join(' ');
    const div = h('div', { class: 'cv-divider' }, h('span', { class: 'cv-divider-label' }, label, ' · ', clock(it.ts)));
    if (!it.text) return div;
    const det = h('details', { class: 'cv-compact-summary' }, h('summary', null, 'Summary carried into the new context'));
    det.addEventListener('toggle', () => {
      if (det.open && det.childElementCount === 1) det.append(textBody(it));
    });
    return [div, det];
  }

  function renderTurnEnd(it) {
    const dur = metaDurUs(it.meta);
    const status = it.meta?.status ?? it.meta?.stopReason ?? it.meta?.stop_reason;
    const out = it.llm?.tokens?.output;
    const parts = [
      'Turn ended',
      dur != null ? formatDuration(dur) : null,
      out != null ? `${formatTokens(out)} tokens out` : null,
      typeof status === 'string' && status !== 'ok' ? status : null,
    ].filter(Boolean);
    return h('div', { class: `cv-turnend${/abort|interrupt|cancel/i.test(String(status ?? '')) ? ' is-warn' : ''}` }, h('span', null, parts.join(' · ')), timeEl(it.ts));
  }

  function renderInject(it) {
    const first = (it.text ?? '').trim().split('\n')[0] ?? '';
    const det = h('details', { class: 'cv-inject' }, h('summary', null, h('span', { class: 'cv-inject-label' }, 'Injected'), h('span', { class: 'cv-inject-first' }, first), timeEl(it.ts)));
    det.addEventListener('toggle', () => {
      if (det.open && det.childElementCount === 1) det.append(textBody(it, false));
    });
    return det;
  }

  /** The collapsed "commands run by this call" list inside a tool card. */
  function execHost(parent) {
    let det = parent.querySelector(':scope > .cv-execs');
    if (!det) {
      det = h('details', { class: 'cv-execs' }, h('summary', null, ''), h('div', { class: 'cv-exec-list' }));
      parent.append(det);
    }
    const listEl = det.querySelector('.cv-exec-list');
    queueMicrotask(() => {
      const n = listEl.childElementCount;
      det.querySelector('summary').textContent = `${n} ${n === 1 ? 'command' : 'commands'} run inside this call`;
    });
    return listEl;
  }

  const RENDER = {
    prompt: (it) => bubble('user', it),
    exec: (it) => renderTool(it),
    text: renderText,
    thinking: renderThinking,
    tool: renderTool,
    subagent: renderSubagent,
    compaction: renderCompaction,
    'turn-end': renderTurnEnd,
    inject: renderInject,
    error: (it) => h('div', { class: 'cv-banner' }, h('span', { class: 'cv-banner-label' }, 'Error'), h('span', { class: 'cv-banner-text' }, it.text || 'Unknown error'), timeEl(it.ts)),
    status: (it) => h('div', { class: 'cv-status' }, h('span', null, it.text ?? ''), timeEl(it.ts)),
  };

  function renderItem(it) {
    const render = RENDER[it?.type] ?? RENDER.status;
    const flags = it?.meta?.flags;
    const dim = Array.isArray(flags) && flags.some((f) => f === 'inherited' || f === 'dup');
    return h('div', { class: `cv-item cv-t-${it?.type ?? 'status'}${dim ? ' is-dim' : ''}`, 'data-event': it?.event ?? null, 'data-ts': Number.isFinite(it?.ts) ? String(it.ts) : null },
      render(it),
      it?.event ? h('button', { class: 'cv-goto', title: 'Show this item in the Events workspace', onclick: () => app.selectEvent(it.event) }, 'Show in Events') : null);
  }

  return {
    show() {
      visible = true;
      sync();
      publishScope();
      if (sessionId && !done && !loading && footNearView()) loadMore();
    },
    hide() {
      visible = false;
    },
  };
}
