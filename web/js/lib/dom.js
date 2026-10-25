// DOM helpers shared by the shell and the workspaces. Text always goes in through text nodes,
// never innerHTML, so trace content cannot inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    // Custom properties (--clamp) need setProperty: assigning them to el.style is silently ignored.
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, x) : (el.style[p] = x);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && !(el instanceof SVGElement) && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** h('div', { class: 'x', onClick }, 'text', child, [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** addEventListener that returns its own remover. */
export function on(el, evt, fn, opts) {
  el.addEventListener(evt, fn, opts);
  return () => el.removeEventListener(evt, fn, opts);
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** True when a key event targets a text field, so single-key shortcuts must not fire. */
export function isTyping(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range', 'color'].includes(t.type);
}

/** Scroll `container` just enough to show `el`. Unlike scrollIntoView, outer ancestors never move. */
export function ensureVisible(container, el, margin = 0) {
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < c.top + margin) container.scrollTop -= c.top + margin - r.top;
  else if (r.bottom > c.bottom - margin) container.scrollTop += r.bottom - c.bottom + margin;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Icons (16px, stroke-based, currentColor)

const ICONS = {
  chevron: 'M6 4l4 4-4 4',
  down: 'M4 6l4 4 4-4',
  close: 'M4 4l8 8M12 4l-8 8',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5L14 14',
  bookmark: 'M4 2h8v12l-4-3-4 3z',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.8h2.8M8 5v3l2 1.5',
  clock: 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13zM8 4.5V8l2.5 1.5',
  sun: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1',
  moon: 'M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z',
  monitor: 'M2 3h12v8H2zM6 14h4M8 11v3',
  warning: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.5',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1',
  copy: 'M5.5 5.5h8v8h-8zM3 10.5H2.5v-8h8V3',
  refresh: 'M13.5 8A5.5 5.5 0 1 1 11.9 4M13.5 2v3h-3',
  filter: 'M2 3h12l-4.5 5.5V13l-3 1.5v-6z',
  help: 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13zM6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.3v.2',
  sliders: 'M3 4h10M3 8h10M3 12h10M6 2.5v3M10 6.5v3M5 10.5v3',
  play: 'M5 3l8 5-8 5z',
  dot: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  external: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4',
  image: 'M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6.5h.01',
  mark: 'M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5z',
  plus: 'M8 3v10M3 8h10',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9',
  up: 'M4 10l4-4 4 4',
  sidebar: 'M2 3h12v10H2zM6 3v10',
  inspector: 'M2 3h12v10H2zM2 9h12',
  columns: 'M2 3h12v10H2zM6.5 3v10M10.5 3v10',
  find: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5L14 14',
  more: 'M4 8h.01M8 8h.01M12 8h.01',
  arrowUp: 'M8 13V3M4 7l4-4 4 4',
  arrowDown: 'M8 3v10M4 9l4 4 4-4',
};

export function icon(name, size = 14) {
  return svg(
    'svg',
    { class: 'icon', width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    svg('path', { d: ICONS[name] ?? ICONS.dot }),
  );
}

// ---------------------------------------------------------------------------
// Marks (docs/DESIGN.md §6.3): one inline SVG per value, never a text glyph. The filled form knocks its symbol
// out of the shape through a mask, so the row's own background shows through, as an SF Symbol's does; the
// outlined form (parsed, derived or inferred delegation outcomes) strokes both.

const CIRCLE = 'M8 1.25a6.75 6.75 0 1 1 0 13.5a6.75 6.75 0 1 1 0-13.5z';
const TRIANGLE = 'M8 1.4l7 12.4H1z';
const MARKS = {
  failed: { shape: CIRCLE, knock: 'M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8', name: 'failed' },
  blocked: { shape: CIRCLE, knock: 'M4.9 11.1l6.2-6.2', name: 'blocked' },
  interrupted: { shape: CIRCLE, knock: 'M6.4 5.3v5.4M9.6 5.3v5.4', name: 'interrupted' },
  masked: { shape: CIRCLE, half: true, name: 'masked' },
  degraded: { shape: TRIANGLE, knock: 'M8 6.2v3.4M8 11.7v.1', name: 'degraded' },
  slow: { shape: CIRCLE, knock: 'M8 4.5V8l2.4 1.6', name: 'slow' },
  recovered: { shape: CIRCLE, knock: 'M4.9 8.6a3.2 3.2 0 1 0 1-3M5.6 3.6v2.2h2.2', name: 'recovered' },
  clean: { shape: CIRCLE, knock: 'M5.1 8.3l2 2 3.8-4.4', name: 'clean' },
  silent: { shape: CIRCLE, knock: 'M8 4.2v4.9M6 7.2L8 9.2l2-2M5.3 11.4h5.4', name: 'silent child' },
  loop: { shape: CIRCLE, knock: 'M5 7.4a3.1 3.1 0 0 1 5.5-1.6M11 8.6a3.1 3.1 0 0 1-5.5 1.6M10.9 3.9v2.2H8.7M5.1 12.1V9.9h2.2', name: 'loop' },
  alarm: { shape: 'M8 1.6c-2.4 0-4.1 1.8-4.1 4.2v2.9L2.4 11.2h11.2l-1.5-2.5V5.8c0-2.4-1.7-4.2-4.1-4.2zM6.3 12.5a1.7 1.7 0 0 0 3.4 0z', name: 'alarm firing' },
  regressed: { shape: 'M8 3.2l5.6 9.6H2.4z', name: 'regressed' },
  claim: { shape: CIRCLE, knock: 'M6.2 6.3a1.8 1.8 0 1 1 2.6 1.6c-.5.3-.8.6-.8 1.2v.3M8 11.4v.1', name: 'unverified claim' },
  live: { shape: 'M8 4.4a3.6 3.6 0 1 1 0 7.2a3.6 3.6 0 1 1 0-7.2z', name: 'live' },
  info: { shape: CIRCLE, knock: 'M8 7.3v4M8 4.9v.1', outline: true, name: 'data gap' },
};

function markDefs() {
  if (document.getElementById('as-mark-defs')) return;
  const defs = svg('defs');
  for (const [name, m] of Object.entries(MARKS)) {
    if (!m.knock) continue;
    defs.append(svg('mask', { id: `as-mk-${name}`, maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: '16', height: '16' },
      svg('rect', { width: '16', height: '16', fill: '#fff' }),
      svg('path', { d: m.knock, fill: 'none', stroke: '#000', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
  }
  document.body.append(svg('svg', { id: 'as-mark-defs', width: '0', height: '0', 'aria-hidden': 'true', style: { position: 'absolute', width: '0', height: '0', overflow: 'hidden' } }, defs));
}

/**
 * A mark as a 1em inline SVG in currentColor. `label`: true names it with its §6.3 name, a string with that text;
 * without one the mark is hidden from assistive technology, because the word beside it says the same.
 */
export function mark(name, { label = null, outlined = false } = {}) {
  const m = MARKS[name] ?? MARKS.live;
  const named = label === true ? m.name : label;
  const box = svg('svg', {
    class: ['mk', `mk-${name}`], viewBox: '0 0 16 16', width: '1em', height: '1em', focusable: 'false',
    ...(named ? { role: 'img', 'aria-label': named } : { 'aria-hidden': 'true' }),
  });
  const line = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const half = svg('path', { d: 'M8 1.25a6.75 6.75 0 0 0 0 13.5z', fill: 'currentColor' });
  if (m.half) box.append(svg('path', { d: m.shape, ...line }), half);
  else if (m.outline || outlined) {
    box.append(svg('path', { d: m.shape, ...line }));
    if (m.knock) box.append(svg('path', { d: m.knock, ...line, 'stroke-width': '1.5' }));
  }
  else {
    if (m.knock) markDefs();
    box.append(svg('path', { d: m.shape, fill: 'currentColor', ...(m.knock ? { mask: `url(#as-mk-${name})` } : {}) }));
  }
  return box;
}

/** The 8 px agent dot (§5.2 item 4). Always followed by the agent's name, so it is hidden from assistive technology. */
export function agentDot(color) {
  return h('span', { class: 'agent-dot', style: { background: color }, 'aria-hidden': 'true' });
}

// ---------------------------------------------------------------------------
// Badges (§6.1): Solid for the object's own failure tier, Outline for the other tiers and removable tokens, Plain
// for everything else. `tone` is a tier (failure, suspect, benign, deferred) or bad, warn, ok, note, muted, faint.

export function badge(style, content, { tone = null, title = null, markName = null, outlined = false, cls = null } = {}) {
  return h('span', { class: [`b-${style}`, tone && `tone-${tone}`, cls], title },
    markName ? mark(markName, { outlined }) : null, content);
}

// ---------------------------------------------------------------------------
// Text measurement, for middle truncation (§3.5).

let measureCtx = null;
/** Width in px of `text` set in the UI font at `size` px and `weight`. */
export function textWidth(text, size = 12, weight = 400) {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-ui') || 'system-ui';
  measureCtx.font = `${weight} ${size}px ${family}`;
  return measureCtx.measureText(String(text ?? '')).width;
}

/**
 * The full text of a cut element as its tooltip, only while it is cut (§3.6: a tooltip never repeats the visible
 * text of an element that is not cut). Watches the element's size.
 */
function syncCutTitle(el) {
  const full = el.dataset.fullText;
  if (full == null || !el.isConnected) return;
  const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  if (cut) el.title = full;
  else if (el.title === full) el.removeAttribute('title');
}
const cutWatch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
  for (const { target } of entries) syncCutTitle(target);
});
export function autoTitle(el, text) {
  el.dataset.fullText = String(text ?? el.textContent);
  cutWatch?.observe(el);
  // New text in an element of unchanged size: the observer stays silent, so check once after layout.
  if (el.isConnected) requestAnimationFrame(() => syncCutTitle(el));
  return el;
}

/** A scope label (§7.3): the leading count in --fg 600, the rest in Row secondary. */
export function setScopeLabel(el, text) {
  const [first, ...rest] = String(text ?? '').split(' · ');
  el.replaceChildren(h('b', null, first), rest.length ? ` · ${rest.join(' · ')}` : '');
  return autoTitle(el, text);
}

/**
 * Middle truncation for paths and ids (§3.5): keeps the last path component whole, cuts the middle with "…" until
 * the text fits `maxPx` at `size` px.
 */
export function middleEllipsis(text, maxPx, size = 11) {
  const s = String(text ?? '');
  if (textWidth(s, size) <= maxPx) return s;
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const tail = slash >= 0 ? s.slice(slash) : s.slice(-Math.ceil(s.length / 3));
  let lo = 0;
  let hi = s.length - tail.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${s.slice(0, mid)}…${tail}`, size) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${s.slice(0, lo)}…${tail}` : `…${tail}`;
}

/**
 * Fold the controls of a chrome row that does not fit (§7.3, §7.4): hide `items` from the right until `row` stops
 * overflowing, and list them in `more` (a menu button), whose entries call each item's `open(anchor)`. `keep` items
 * never fold. Items: { el, label, open(anchor) }.
 */
export function foldRow(row, items, more, { keep = 0, title = 'More' } = {}) {
  for (const it of items) it.el.hidden = false;
  more.hidden = true;
  const hidden = [];
  for (let i = items.length - 1; i >= keep && row.scrollWidth > row.clientWidth + 1; i--) {
    if (more.hidden) more.hidden = false;
    items[i].el.hidden = true;
    hidden.unshift(items[i]);
  }
  more.replaceChildren(title, icon('down', 10));
  more.onclick = () => showMenu(more, hidden.map((it) => it.menuItem ?? { label: it.label, onSelect: () => it.open?.(more) }), { align: 'end', minWidth: 220 });
  return hidden;
}

// ---------------------------------------------------------------------------
// Prose and code clamps (§3.5): a prose block clamps at `lines` and offers "Show all (2,310 characters)"; a code
// block keeps its head and tail lines around "⋯ 38 lines omitted ⋯" and offers "Show full output".

/** Markdown fence lines (```sh, ```) are markup, not prose: a prose block drops them (§3.2). Pure, for tests. */
export const stripFences = (text) => String(text ?? '').replace(/^[ \t]*```[\w+-]*[ \t]*(?:\n|$)/gm, '');

/**
 * A prose block clamped at `lines`, with "Show all (2,310 characters)". `cut`: the text is an excerpt the engine cut,
 * so it ends in "…" even when it fits (§3.5: a cut without an ellipsis is a defect).
 */
export function proseBlock(text, { lines = 6, cls = null, cut = false } = {}) {
  const shown = stripFences(text).replace(/\s+$/, '');
  const full = cut && !shown.endsWith('…') ? `${shown}…` : shown;
  const body = h('div', { class: ['prose-clamp', cls], style: { '--clamp': String(lines) } }, full);
  const label = `Show all (${formatCount(shown.length)} characters)`;
  const more = h('button', { class: 'link-btn clamp-toggle', type: 'button', hidden: true }, label);
  let open = false;
  more.addEventListener('click', () => {
    open = !open;
    body.classList.toggle('open', open);
    more.textContent = open ? 'Show less' : label;
  });
  // Whether the text is cut is known only once it is laid out.
  const ro = new ResizeObserver(() => {
    if (!body.isConnected || !body.clientHeight) return;
    if (!open) more.hidden = body.scrollHeight <= body.clientHeight + 1;
  });
  ro.observe(body);
  return h('div', { class: 'prose-wrap' }, body, more);
}

const formatCount = (n) => Math.round(n).toLocaleString('en-US');

/** Lines as a terminal shows them: CRLF and a lone CR (progress output) both end a line. */
export const splitLines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');

/**
 * Lines of a code block that a clamp keeps: the first `head` and the last `tail` rendered rows, and how many logical
 * lines it leaves out. `cols` is the characters per rendered row (wrap-aware, §3.5); a line longer than the rows left
 * is cut with "…", and `cut` says the text was shortened at all. Pure, for tests.
 */
export function clampLines(text, head, tail, cols = Infinity) {
  const all = splitLines(text);
  const rows = (line) => Math.max(1, Math.ceil(line.length / cols));
  if (all.reduce((a, l) => a + rows(l), 0) <= head + tail + 1) return { head: all, tail: [], omitted: 0, cut: false };
  let partial = false;
  const take = (lines, budget) => {
    const out = [];
    for (const line of lines) {
      if (budget <= 0) break;
      const r = rows(line);
      if (r > budget) {
        out.push(line.slice(0, budget * cols - 1) + '…');
        partial = true;
        break;
      }
      out.push(line);
      budget -= r;
    }
    return out;
  };
  const kept = take(all, head);
  const rest = all.slice(kept.length);
  const back = tail ? take([...rest].reverse().map((l) => [...l].reverse().join('')), tail).map((l) => [...l].reverse().join('')).reverse() : [];
  // A tail line cut from its start reads "…end" once reversed back.
  const omitted = all.length - kept.length - back.length;
  return { head: kept, tail: back, omitted, cut: partial || omitted > 0 };
}

/** Characters per rendered row of a wrapping code block, a little under the measure so word wrap never adds a row. */
export function codeCols(pre) {
  const cs = getComputedStyle(pre);
  const width = pre.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ctx = (measureCtx ??= document.createElement('canvas').getContext('2d'));
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const ch = ctx.measureText('0'.repeat(40)).width / 40;
  return width > 0 && ch > 0 ? Math.max(8, Math.floor((width / ch) * 0.94)) : Infinity;
}

/**
 * Re-run `paint(cols)` whenever a code block's width changes, so a clamp counts rendered rows rather than logical
 * lines (§3.5 Code block, §7.7 fold acceptance).
 */
export function onCodeWidth(pre, paint) {
  let last = -1;
  new ResizeObserver(() => {
    if (!pre.isConnected || pre.clientWidth === last) return;
    last = pre.clientWidth;
    paint(codeCols(pre));
  }).observe(pre);
}

/**
 * A code block clamped to `head` and `tail` lines; `render(text)` may return runs (highlighting) instead of text.
 * `wrap`: count rendered rows, not logical lines (the Lens clamps).
 */
export function codeBlock(text, { head = 6, tail = 4, label = 'output', cls = null, render = null, wrap = false } = {}) {
  const all = splitLines(text).join('\n');
  const pre = h('pre', { class: ['code-block', cls] });
  const size = `${formatCount(String(text).length)} characters`;
  const btn = h('button', { class: 'link-btn clamp-toggle', type: 'button' }, `Show full ${label} (${size})`);
  let c = clampLines(all, head, tail);
  let full = false;
  const part = (lines) => [].concat(render ? render(lines.join('\n')) : lines.join('\n'));
  const paint = () => {
    btn.hidden = !c.cut;
    if (full || !c.cut) return pre.replaceChildren(...[].concat(render ? render(all) : all));
    const sep = c.omitted ? ['\n', h('span', { class: 'code-omitted' }, `⋯ ${formatCount(c.omitted)} line${c.omitted === 1 ? '' : 's'} omitted ⋯`)] : [];
    pre.replaceChildren(...part(c.head), ...sep, ...(c.tail.length ? ['\n', ...part(c.tail)] : []));
  };
  paint();
  btn.addEventListener('click', () => {
    full = !full;
    paint();
    btn.textContent = full ? 'Show less' : `Show full ${label} (${size})`;
  });
  if (wrap) {
    onCodeWidth(pre, (cols) => {
      c = clampLines(all, head, tail, cols);
      paint();
    });
  } else if (!c.cut) return pre;
  return h('div', { class: 'code-wrap' }, pre, btn);
}

/**
 * Top and bottom scroll shadows on a scroll region (§7.9 Body): sticky 12 px gradients, each shown only while the
 * region can scroll that way, so no row is cut partway without a shadow over it.
 */
export function scrollShadows(el) {
  el.classList.add('scroll-shadows');
  let frame = 0;
  const update = () => {
    frame = 0;
    const rest = el.scrollHeight - el.scrollTop - el.clientHeight;
    el.classList.toggle('can-up', el.scrollTop > 0);
    el.classList.toggle('can-down', rest > 1);
  };
  const later = () => {
    frame ||= requestAnimationFrame(update);
  };
  el.addEventListener('scroll', later, { passive: true });
  new ResizeObserver(later).observe(el);
  new MutationObserver(later).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  return el;
}

// ---------------------------------------------------------------------------
// Popup menu

let menuStack = []; // open menus, outermost first
let menuCleanup = null;
let menuAnchor = null; // the control or point the open menu belongs to

export function closeMenu() {
  for (const m of menuStack) m.remove();
  menuStack = [];
  menuCleanup?.();
  menuCleanup = null;
}

/** Close the submenus above `level` (0 = the root menu stays open). */
function closeAbove(level) {
  while (menuStack.length > level + 1) menuStack.pop().remove();
}

function placeMenu(menu, r, align, side) {
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x;
  let y;
  if (side) {
    x = r.right - 2;
    if (x + mw > innerWidth - 4) x = Math.max(4, r.left - mw + 2);
    y = Math.min(r.top - 4, innerHeight - mh - 4);
  } else {
    x = align === 'end' ? r.right - mw : r.left;
    y = r.bottom + 2;
    if (y + mh > innerHeight - 4) y = Math.max(4, r.top - mh - 2);
  }
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - mw - 4))}px`;
  menu.style.top = `${Math.max(4, y)}px`;
}

function buildMenu(items, level, { minWidth } = {}) {
  const buttons = [];
  const menu = h('div', { class: 'menu', role: 'menu', tabindex: '-1' });
  menu._buttons = buttons;
  let hoverTimer = 0;
  for (const it of items) {
    if (!it) continue;
    if (it.separator) {
      menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
    } else if (it.header) {
      menu.append(h('div', { class: 'menu-header', role: 'presentation' }, it.header));
    } else {
      const sub = Array.isArray(it.items) && it.items.length ? it.items : null;
      const openSub = (focus) => {
        closeAbove(level);
        const child = buildMenu(sub, level + 1, { minWidth: it.subMinWidth });
        document.body.append(child);
        menuStack.push(child);
        placeMenu(child, btn.getBoundingClientRect(), 'start', true);
        btn.setAttribute('aria-expanded', 'true');
        child._parentButton = btn;
        if (focus) (child._buttons.find((b) => !b.disabled) ?? child).focus({ preventScroll: true });
      };
      const btn = h(
        'button',
        {
          class: ['menu-item', it.danger && 'danger', sub && 'has-sub'],
          role: it.checked != null ? 'menuitemcheckbox' : 'menuitem',
          'aria-checked': it.checked != null ? String(!!it.checked) : null,
          'aria-haspopup': sub ? 'menu' : null,
          'aria-expanded': sub ? 'false' : null,
          disabled: !!it.disabled,
          title: it.title ?? null,
          onClick: () => {
            if (sub && !it.onSelect) return openSub(true);
            // Focus goes back to the control that opened the menu first, so a dialog the item opens returns there
            // when it closes (§10.1).
            const opener = menuAnchor;
            closeMenu();
            if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
            it.onSelect?.();
          },
          onMouseenter: () => {
            clearTimeout(hoverTimer);
            if (btn.disabled) return;
            hoverTimer = setTimeout(() => {
              if (sub) openSub(false);
              else closeAbove(level);
            }, 120);
          },
        },
        h('span', { class: 'menu-check' }, it.checked ? '✓' : ''),
        h('span', { class: 'menu-label' }, it.label),
        it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null,
        sub ? h('span', { class: 'menu-sub' }, '▸') : null,
      );
      btn._openSub = sub ? openSub : null;
      buttons.push(btn);
      menu.append(btn);
    }
  }
  if (minWidth) menu.style.minWidth = `${minWidth}px`;
  return menu;
}

/**
 * Show a popup menu at an anchor element (below it) or at {x, y}.
 * items: { label, hint?, checked?, disabled?, danger?, title?, onSelect?(), items?: submenu }
 *      | { separator: true } | { header: string }. An item with `items` and no onSelect opens a submenu;
 * with both, clicking runs onSelect and the arrow or hover opens the submenu.
 */
export function showMenu(anchor, items, { align = 'start', minWidth, content = null, label = null } = {}) {
  closeMenu();
  const menu = buildMenu(items, 0, { minWidth });
  // A popover: the same placement, dismissal and focus return, with its own content (a dialog, not a menu).
  if (content) {
    menu.classList.add('popover');
    menu.setAttribute('role', 'dialog');
    if (label) menu.setAttribute('aria-label', label);
    menu.append(content);
  }
  document.body.append(menu);
  menuStack = [menu];
  menuAnchor = anchor;
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  placeMenu(menu, r, align, false);

  const onDown = (e) => {
    if (!menuStack.some((m) => m.contains(e.target))) closeMenu();
  };
  const onKey = (e) => {
    const top = menuStack[menuStack.length - 1];
    if (!top) return;
    const enabled = top._buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement);
    if (e.key === 'Escape' || (e.key === 'ArrowLeft' && menuStack.length > 1)) {
      e.preventDefault();
      e.stopPropagation();
      if (menuStack.length > 1) {
        const parentBtn = top._parentButton;
        menuStack.pop().remove();
        parentBtn?.setAttribute('aria-expanded', 'false');
        parentBtn?.focus();
      } else {
        closeMenu();
        if (anchor instanceof HTMLElement) anchor.focus();
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      enabled[(i + d + enabled.length) % enabled.length]?.focus();
    } else if (e.key === 'ArrowRight' && document.activeElement?._openSub) {
      e.preventDefault();
      document.activeElement._openSub(true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', closeMenu);
  menuCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', closeMenu);
  };
  (content?.querySelector('input, button') ?? menu._buttons.find((b) => !b.disabled) ?? menu).focus({ preventScroll: true });
  return menu;
}

// ---------------------------------------------------------------------------
// Modal dialog

/**
 * Open a modal <dialog>. actions: [{ label, primary?, onClick?(close) → false to keep open }]
 * Returns { el, body, close }.
 */
let dialogSeq = 0;

export function openDialog({ title, body, actions = [{ label: 'Close', primary: true }], className, onClose }) {
  const content = h('div', { class: 'dialog-body' }, body);
  const footer = h('div', { class: 'dialog-actions' });
  const titleId = `dialog-title-${++dialogSeq}`;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dlg = h(
    'dialog',
    { class: ['dialog', className], 'aria-labelledby': titleId },
    h('div', { class: 'dialog-head' }, h('h2', { id: titleId }, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => close() }, icon('close'))),
    content,
    actions.length ? footer : null,
  );
  const close = () => {
    if (dlg.open) dlg.close();
  };
  for (const a of actions) {
    footer.append(
      h(
        'button',
        {
          class: ['btn', a.primary && 'primary'],
          onClick: () => {
            if (a.onClick?.(close) !== false) close();
          },
        },
        a.label,
      ),
    );
  }
  dlg.addEventListener('close', () => {
    onClose?.();
    dlg.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  document.body.append(dlg);
  dlg.showModal();
  // showModal() focuses the first focusable element, the close button; Enter should act instead. Focus the first
  // form field of the body, else the primary action. Esc still closes.
  const target = content.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])') ?? footer.querySelector('.btn.primary');
  target?.focus();
  return { el: dlg, body: content, close };
}

// ---------------------------------------------------------------------------
// Splitter

/**
 * Make `handle` drag-resize something (§10.1). axis 'x' reports horizontal deltas, 'y' vertical. onStart() returns the
 * starting size; onDrag(size) receives startSize + delta and may return the clamped size; onEnd(size) persists it.
 * The handle is a focusable separator: arrows move 8 px, Shift+arrows 64 px, Home and End go to `min` and `max`, and
 * Return calls onReset() (the default size). aria-valuenow, -valuemin and -valuemax follow, in px.
 */
export function makeSplitter(handle, { axis, onStart, onDrag, onEnd, onReset, invert = false, step = 8, min = 0, max = 4000, keyboard = true }) {
  if (keyboard) {
    handle.tabIndex = 0;
    if (!handle.getAttribute('role')) handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
    handle.setAttribute('aria-valuemin', String(Math.round(min)));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    const report = (v) => {
      if (Number.isFinite(v)) handle.setAttribute('aria-valuenow', String(Math.round(v)));
    };
    handle.addEventListener('focus', () => report(onStart()));
    // A value before the first focus, so the separator is complete for assistive technology.
    requestAnimationFrame(() => report(onStart()));
    handle.addEventListener('keydown', (e) => {
      const keys = axis === 'x' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
      let size;
      if (keys[e.key]) size = onStart() + keys[e.key] * step * (e.shiftKey ? 8 : 1) * (invert ? -1 : 1);
      else if (e.key === 'Home') size = min;
      else if (e.key === 'End') size = max;
      else if (e.key === 'Enter' && onReset) size = onReset();
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Enter') {
        size = onDrag(size) ?? size;
        onEnd?.(size);
      }
      report(size);
    });
  }
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const base = onStart();
    let size = base;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (ev) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      size = base + (invert ? -d : d);
      size = onDrag(size) ?? size;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-x', 'resizing-y');
      onEnd?.(size);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/**
 * A view state (docs/DESIGN.md §7.15), rendered inside its pane. kind: 'empty' | 'loading' | 'error'.
 * Loading shows nothing for 150 ms, then skeleton rows, then after 1 s the title as metadata ("Loading 12,339
 * episodes…"). Empty and failed states center a title, one sentence and their actions (the first is primary when
 * there are several). action: { label, onClick } or an array of them.
 */
export function placeholder(kind, title, detail, action) {
  if (kind === 'loading') {
    return h('div', { class: 'placeholder placeholder-loading', role: 'status', 'aria-live': 'polite' },
      Array.from({ length: 6 }, () => h('div', { class: 'skeleton-row', 'aria-hidden': 'true' })),
      h('div', { class: 't-meta' }, title));
  }
  const actions = (Array.isArray(action) ? action : [action]).filter(Boolean);
  return h(
    'div',
    { class: ['placeholder', `placeholder-${kind}`], role: kind === 'error' ? 'alert' : 'status' },
    h('div', { class: 'placeholder-title' }, title),
    detail ? h('div', { class: 'placeholder-detail' }, detail) : null,
    actions.length
      ? h('div', { class: 'placeholder-actions' }, actions.map((a, i) => h('button', { class: ['btn', i === 0 && 'primary'], type: 'button', title: a.title ?? null, onClick: a.onClick }, a.label)))
      : null,
  );
}
