// Virtual list: renders only the rows in view, over a fixed row height.
// Browsers cap element heights (about 17.9M px in Firefox, 33.5M px in Chrome), so lists taller than
// MAX_SCROLL_PX use a scaled scrollbar: one scroll pixel stands for `ratio` content pixels.
// The math helpers are pure and unit-tested; createVirtualList wires them to the DOM.

export const MAX_SCROLL_PX = 8_000_000;

/** Scroll geometry for `total` rows. */
export function layout(total, rowHeight, viewportHeight, maxScroll = MAX_SCROLL_PX) {
  const contentHeight = Math.max(0, total) * rowHeight;
  const scrollHeight = Math.min(contentHeight, maxScroll);
  const ratio =
    contentHeight > scrollHeight && scrollHeight > viewportHeight
      ? (contentHeight - viewportHeight) / (scrollHeight - viewportHeight)
      : 1;
  return { contentHeight, scrollHeight, ratio };
}

/**
 * Rows to render for a scroll position. `top` is the content offset of the viewport, so row i is
 * drawn at y = i * rowHeight - top inside the viewport. `end` is exclusive.
 */
export function visibleRange(scrollTop, viewportHeight, total, rowHeight, ratio = 1, overscan = 6) {
  const top = Math.max(0, scrollTop * ratio);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + viewportHeight) / rowHeight);
  return {
    start: Math.max(0, Math.min(total, first - overscan)),
    end: Math.max(0, Math.min(total, last + overscan)),
    top,
  };
}

/** Number of whole rows that fit in the viewport (at least 1). */
export function rowsPerPage(viewportHeight, rowHeight) {
  return Math.max(1, Math.floor(viewportHeight / rowHeight));
}

/**
 * scrollTop that brings row `index` into view, or null when it is already fully visible
 * (align 'auto'). align: 'auto' | 'start' | 'center' | 'end'.
 */
export function scrollTopForIndex(index, { rowHeight, viewportHeight, scrollTop, ratio = 1, align = 'auto' }) {
  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  const top = scrollTop * ratio;
  let target;
  if (align === 'start') target = rowTop;
  else if (align === 'end') target = rowBottom - viewportHeight;
  else if (align === 'center') target = rowTop - (viewportHeight - rowHeight) / 2;
  else if (rowTop < top) target = rowTop;
  else if (rowBottom > top + viewportHeight) target = rowBottom - viewportHeight;
  else return null;
  return Math.max(0, target / ratio);
}

/** Page numbers covering rows [start, end). */
export function pagesForRange(start, end, pageSize) {
  if (end <= start) return [];
  const pages = [];
  for (let p = Math.floor(start / pageSize); p <= Math.floor((end - 1) / pageSize); p++) pages.push(p);
  return pages;
}

/** Clamp a row index into [0, total - 1]; -1 when the list is empty. */
export function clampIndex(i, total) {
  if (total <= 0) return -1;
  return Math.max(0, Math.min(total - 1, i));
}

/**
 * Attach a virtual list to `scroller` (an element with overflow: auto).
 * opts: { rowHeight, createRow(): HTMLElement, renderRow(el, index), onScroll?(scroller), onRange?(start, end) }
 */
export function createVirtualList(scroller, opts) {
  const { rowHeight, createRow, renderRow } = opts;
  const doc = scroller.ownerDocument;
  const layer = doc.createElement('div');
  layer.className = 'vl-layer';
  const spacer = doc.createElement('div');
  spacer.className = 'vl-spacer';
  scroller.append(layer, spacer);

  let total = 0;
  let geo = layout(0, rowHeight, 0);
  let viewportHeight = scroller.clientHeight;
  const live = new Map(); // row index → element
  const pool = [];
  let frame = 0;
  let lastRange = { start: 0, end: 0 };

  function measure() {
    viewportHeight = scroller.clientHeight;
    geo = layout(total, rowHeight, viewportHeight);
    layer.style.height = `${viewportHeight}px`;
    spacer.style.height = `${Math.max(0, geo.scrollHeight - viewportHeight)}px`;
  }

  function render(force = false) {
    frame = 0;
    const { start, end, top } = visibleRange(scroller.scrollTop, viewportHeight, total, rowHeight, geo.ratio);
    for (const [i, el] of live) {
      if (i < start || i >= end) {
        live.delete(i);
        el.hidden = true;
        pool.push(el);
      }
    }
    for (let i = start; i < end; i++) {
      let el = live.get(i);
      const fresh = !el;
      if (!el) {
        el = pool.pop() ?? layer.appendChild(createRow());
        el.hidden = false;
        live.set(i, el);
      }
      el.style.transform = `translateY(${i * rowHeight - top}px)`;
      if (fresh || force) renderRow(el, i);
    }
    if (start !== lastRange.start || end !== lastRange.end) {
      lastRange = { start, end };
      opts.onRange?.(start, end);
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => render(false));
  }

  const onScroll = () => {
    opts.onScroll?.(scroller);
    schedule();
  };
  // With a scaled scrollbar, translate wheel deltas so one notch still moves a few rows.
  const onWheel = (e) => {
    if (geo.ratio <= 1 || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * rowHeight : e.deltaMode === 2 ? e.deltaY * viewportHeight : e.deltaY;
    scroller.scrollTop += dy / geo.ratio;
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('wheel', onWheel, { passive: false });
  const ro = new ResizeObserver(() => {
    measure();
    render(false);
  });
  ro.observe(scroller);
  measure();

  return {
    /** New data set: re-renders every row and reports the range again even if it did not move. */
    setCount(n) {
      total = Math.max(0, n | 0);
      lastRange = { start: -1, end: -1 };
      measure();
      render(true);
    },
    get count() {
      return total;
    },
    /** Re-render every visible row (data or column change). */
    refresh() {
      render(true);
    },
    /** Measure the viewport again now (it has no size while an ancestor is display: none). */
    resize() {
      measure();
      render(false);
    },
    refreshIndex(i) {
      const el = live.get(i);
      if (el) renderRow(el, i);
    },
    pageRows() {
      return rowsPerPage(viewportHeight, rowHeight);
    },
    /** Index of the first row at least partly in view. */
    topIndex() {
      return Math.min(Math.max(0, total - 1), Math.floor((scroller.scrollTop * geo.ratio) / rowHeight));
    },
    scrollToIndex(i, align = 'auto') {
      const t = scrollTopForIndex(i, { rowHeight, viewportHeight, scrollTop: scroller.scrollTop, ratio: geo.ratio, align });
      if (t !== null) scroller.scrollTop = t;
      render(false);
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      layer.remove();
      spacer.remove();
    },
  };
}

/**
 * The scrollTop that reveals the row [top, bottom) in a viewport of `height`, or null when it needs no scroll. A
 * plain reveal keeps `margin` px clear at both edges; `center` centres a row that lies outside the middle 60%, for a
 * jump from elsewhere (Show in Session), where the eye has no place in the list to keep.
 */
export function revealScroll({ top, bottom, scrollTop, height, margin = 0, center = false }) {
  if (center) {
    if (top >= scrollTop + height * 0.2 && bottom <= scrollTop + height * 0.8) return null;
    return Math.max(0, Math.round((top + bottom - height) / 2));
  }
  if (top < scrollTop + margin) return Math.max(0, top - margin);
  if (bottom > scrollTop + height - margin) return Math.max(0, Math.min(top - margin, bottom - height + margin));
  return null;
}

// ---------------------------------------------------------------------------
// Variable-height list (the sessions sidebar): rows of a few known heights, a few thousand of them.

/** Prefix sums: offsets[i] is the top of row i, offsets[n] the total height. */
export function prefixOffsets(heights) {
  const out = new Float64Array(heights.length + 1);
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i];
  return out;
}

/** Index of the row containing y (clamped to [0, n - 1]); -1 for an empty list. */
export function indexAt(offsets, y) {
  const n = offsets.length - 1;
  if (n <= 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (offsets[m] <= y) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/**
 * Attach a variable-height virtual list to `scroller` (overflow: auto).
 * opts: { renderRow(index): HTMLElement, overscan?: px, onRender?(start, end) }.
 * setRows(heights) replaces the row model; refresh() re-renders the visible rows.
 */
export function createVariableList(scroller, opts) {
  const doc = scroller.ownerDocument;
  const inner = doc.createElement('div');
  inner.className = 'vv-inner';
  inner.style.position = 'relative';
  scroller.append(inner);
  const overscan = opts.overscan ?? 240;
  let offsets = prefixOffsets([]);
  let frame = 0;
  let range = { start: 0, end: 0 };

  function render(force) {
    frame = 0;
    const n = offsets.length - 1;
    const top = scroller.scrollTop;
    const vh = scroller.clientHeight || 600;
    const start = n ? Math.max(0, indexAt(offsets, top - overscan)) : 0;
    const end = n ? Math.min(n, indexAt(offsets, top + vh + overscan) + 1) : 0;
    if (!force && start === range.start && end === range.end) return;
    range = { start, end };
    const frag = doc.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const el = opts.renderRow(i);
      el.dataset.vi = String(i);
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.right = '0';
      el.style.top = `${offsets[i]}px`;
      el.style.height = `${offsets[i + 1] - offsets[i]}px`;
      frag.append(el);
    }
    inner.replaceChildren(frag);
    opts.onRender?.(start, end);
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => render(false));
  };
  scroller.addEventListener('scroll', schedule, { passive: true });
  const ro = new ResizeObserver(() => render(false));
  ro.observe(scroller);

  return {
    setRows(heights) {
      offsets = prefixOffsets(heights);
      inner.style.height = `${offsets[offsets.length - 1]}px`;
      render(true);
    },
    refresh() {
      render(true);
    },
    get count() {
      return offsets.length - 1;
    },
    /** Top offset of row i. */
    offsetOf(i) {
      return offsets[Math.max(0, Math.min(i, offsets.length - 1))];
    },
    firstVisible() {
      return indexAt(offsets, scroller.scrollTop);
    },
    /** Reveal row i (revealScroll): `margin` px clear of both edges, or centred with `center`. */
    scrollToIndex(i, margin = 0, { center = false } = {}) {
      if (i < 0 || i >= offsets.length - 1) return;
      const t = revealScroll({ top: offsets[i], bottom: offsets[i + 1], scrollTop: scroller.scrollTop, height: scroller.clientHeight, margin, center });
      if (t !== null) scroller.scrollTop = t;
      render(false);
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      scroller.removeEventListener('scroll', schedule);
      inner.remove();
    },
  };
}
