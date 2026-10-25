// Statistics ▸ Performance over time (SPEC §6 Over time): lanes on one shared time axis with idle gaps collapsed,
// one cursor across every lane, drag-to-zoom and the slowest intervals drawn where they happened.
// The axis, lookup and summary math is pure (unit-tested in test/web/perfchart.test.ts); drawing reads the CSS
// tokens at draw time so theme changes repaint correctly.

import { createScale, fitView, generateTicks } from './timescale.js';
import { formatDuration, formatInt, formatPercent, formatShortDate, formatTokens, pad, plural } from './format.js';
import { niceTicks } from './chart.js';
import { h } from './dom.js';

export const MARGIN = { left: 56, right: 14 };
/** Width of a collapsed idle gap. */
export const BREAK_PX = 14;
const AXIS_H = 22;
const ROW_H = 14;
const MAX_ROWS = 5;

/** Stacking order of Where time went, bottom first: the work, then the waits. */
export const BUSY_ORDER = ['model', 'tool', 'hook', 'compaction', 'api-retry', 'wait-process', 'wait-agent', 'wait-human'];
export const BUSY_LABEL = {
  model: 'Model', tool: 'Tools', hook: 'Hooks', compaction: 'Compaction', 'api-retry': 'API retries',
  'wait-process': 'Waiting for a process', 'wait-agent': 'Waiting for a subagent', 'wait-human': 'Waiting for a human',
};
/** The kind of interval a bottleneck is, by its time bucket. */
export const INTERVAL_LABEL = {
  model: 'Model call', tool: 'Tool call', hook: 'Hook', compaction: 'Compaction', 'api-retry': 'API retry',
  'wait-process': 'Waiting for a process', 'wait-agent': 'Waiting for a subagent', 'wait-human': 'Waiting for a human',
};

const dur = (v) => (v == null ? '—' : formatDuration(v));
/** Output speed and shares as the lanes, the figures and the data table show them (the Mac uses the same digits). */
export const formatRate = (v) => (v == null ? '—' : `${Number(v.toFixed(v < 10 ? 1 : 0))} tok/s`);
export const formatShare = (v) => (v == null ? '—' : formatPercent(v, v < 0.1 ? 1 : 0));
const rate = formatRate;
const pct = formatShare;
const toks = (v) => (v == null ? '—' : `${formatTokens(v)} tokens`);

/**
 * The lanes, top to bottom. `series` lanes draw a solid primary line and a dashed secondary line; `peak` names the
 * bin a lane points at without a cursor ('max' or 'min' of `primary`, or of `secondary` when it says so).
 */
export const LANES = [
  { id: 'busy', label: 'Where time went', kind: 'busy', height: 96,
    help: 'Agent time in each bin by what it went to, as a share of the bin. Parallel sessions and subagents add up, so a bin can pass 100%.' },
  { id: 'intervals', label: 'Slowest intervals', kind: 'intervals',
    help: 'The ranked intervals, drawn where they happened. Click one to open it in Timeline.' },
  { id: 'duration', label: 'Call duration', kind: 'series', unit: 'us', height: 64, primary: 'latencyP50', secondary: 'latencyP90',
    names: ['p50', 'p90'], format: dur, peak: { key: 'latencyP90', pick: 'max', text: 'slowest p90' },
    help: 'Whole model call duration by call start, including waiting.' },
  { id: 'ttft', label: 'First token', kind: 'series', unit: 'us', height: 64, primary: 'ttftP50', secondary: 'ttftP90',
    names: ['p50', 'p90'], format: dur, peak: { key: 'ttftP90', pick: 'max', text: 'slowest p90' },
    help: 'Time before the first output token, where the agent logged it.' },
  { id: 'speed', label: 'Output speed', kind: 'series', unit: 'rate', height: 64, primary: 'rateP50', secondary: 'rateP10',
    names: ['p50', 'p10'], format: rate, peak: { key: 'rateP10', pick: 'min', text: 'slowest p10' },
    help: 'Output tokens per second over the whole call, including waiting; not decode speed.' },
  { id: 'cache', label: 'Cache reuse', kind: 'series', unit: 'ratio', height: 56, primary: 'cacheHitRatio',
    names: [''], format: pct, peak: { key: 'cacheHitRatio', pick: 'min', text: 'lowest' },
    help: 'Cached input tokens ÷ input tokens of the calls that started in the bin.' },
  { id: 'prompt', label: 'Prompt size', kind: 'series', unit: 'tokens', height: 56, primary: 'inputP50',
    names: ['median'], format: toks, peak: { key: 'inputP50', pick: 'max', text: 'largest' },
    help: 'Median input tokens per call, cached or not. Larger prompts take longer to process.' },
  { id: 'calls', label: 'Calls', kind: 'calls', height: 56,
    help: 'Model and tool calls started in each bin; a red dot marks bins with failed calls.' },
];

// ---------------------------------------------------------------------------
// Pure math

/** Idle gaps between consecutive segments. */
export function segmentGaps(segments) {
  const gaps = [];
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start > segments[i - 1].end) gaps.push({ start: segments[i - 1].end, end: segments[i].start });
  }
  return gaps;
}

/** The shared x mapping of a `plotWidth` px plot: the segments fill it, idle gaps collapse to BREAK_PX breaks. */
export function perfScale(segments, plotWidth, breakPx = BREAK_PX) {
  if (!segments.length || !(plotWidth > 0)) return null;
  const gaps = segmentGaps(segments);
  const view = fitView(segments[0].start, segments[segments.length - 1].end, plotWidth, { gaps, breakPx, kMax: Infinity });
  return createScale({ ...view, gaps, breakPx });
}

/** Index of the bin holding time `t` (bins sorted by `t`), or -1 in an idle gap or outside. */
export function binAt(bins, binUs, t) {
  let lo = 0;
  let hi = bins.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < bins[mid].t) hi = mid - 1;
    else if (t >= bins[mid].t + binUs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Busy time of a bin in µs, all buckets. */
export const busyUs = (bin) => Object.values(bin?.busy ?? {}).reduce((a, b) => a + b, 0);

/** The bin a lane points at: the largest or smallest value of `key`, the earliest on a tie; -1 without one. */
export function peakBin(bins, key, pick = 'max') {
  let best = -1;
  for (let i = 0; i < bins.length; i++) {
    const v = bins[i][key];
    if (v == null) continue;
    if (best < 0 || (pick === 'max' ? v > bins[best][key] : v < bins[best][key])) best = i;
  }
  return best;
}

const MS = 1e3;
const SEC = 1e6;
/** Round durations an axis may end at, µs. */
const NICE_DURATIONS = [
  ...[1, 2, 5, 10, 20, 50, 100, 200, 500].map((n) => n * MS),
  ...[1, 2, 5, 10, 15, 30].map((n) => n * SEC),
  ...[1, 2, 5, 10, 15, 30].map((n) => n * 60 * SEC),
  ...[1, 2, 3, 6, 12, 24].map((n) => n * 3600 * SEC),
];

/** The top of a lane's value axis: a round value at or above `v` (a round duration for 'us'). */
export function niceMax(v, unit) {
  if (!(v > 0)) return unit === 'ratio' ? 1 : unit === 'us' ? SEC : 1;
  if (unit === 'ratio') return 1;
  if (unit === 'us') return NICE_DURATIONS.find((d) => d >= v) ?? niceTicks(0, v, 4).max;
  return niceTicks(0, v, 4).max;
}

/**
 * The value a lane's axis should reach: its largest value, unless a few outliers sit far above the rest, in which
 * case the 95th percentile of all values with 25% headroom (outliers then draw clipped, with a mark at the top).
 */
export function laneTop(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const max = v[v.length - 1];
  if (v.length < 10) return max;
  const p95 = v[Math.ceil(0.95 * v.length) - 1];
  return max > 2 * p95 ? p95 * 1.25 : max;
}

/** Rows for interval bars ([x0, x1] px each) so that none overlaps: the first row with room, at most `max` rows. */
export function packRows(spans, max = MAX_ROWS, gapPx = 4) {
  const ends = [];
  const rows = new Array(spans.length);
  // Left to right, so each row's end is the only thing a new bar can collide with.
  const order = spans.map((_, i) => i).sort((a, b) => spans[a][0] - spans[b][0] || a - b);
  for (const i of order) {
    const [x0, x1] = spans[i];
    let row = ends.findIndex((end) => x0 >= end + gapPx);
    if (row < 0) row = ends.length < max ? ends.length : ends.indexOf(Math.min(...ends));
    ends[row] = Math.max(ends[row] ?? -Infinity, x1);
    rows[i] = row;
  }
  return rows;
}

/** Bins `a`..`b` (either order) as a time range: [first start, last end). */
export function binRange(bins, binUs, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return bins[lo] && bins[hi] ? { from: bins[lo].t, to: bins[hi].t + binUs } : null;
}

/** "17:24" within a day, "Oct 11 17:24" across days (§9 Dates); seconds when bins are shorter than a minute. */
export function binTime(t, { sameDay = true, seconds = false } = {}) {
  const d = new Date(t / 1000);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
  return sameDay ? clock : `${formatShortDate(t)} ${clock}`;
}

/** The text of a lane for bin `i`: what its header shows under the cursor. */
export function laneText(lane, bin, binUs) {
  if (!bin) return '';
  if (lane.kind === 'busy') {
    const total = busyUs(bin);
    return total ? `${pct(total / binUs)} busy` : 'idle';
  }
  if (lane.kind === 'calls') {
    return [plural(bin.calls ?? 0, 'model call'), plural(bin.tools ?? 0, 'tool call'), bin.failed ? `${formatInt(bin.failed)} failed` : null]
      .filter(Boolean).join(' · ');
  }
  if (lane.kind !== 'series') return '';
  if (!bin.calls) return 'no model calls';
  const values = [lane.primary, lane.secondary].filter(Boolean).map((k, j) => (bin[k] == null ? null : `${lane.names[j] ? `${lane.names[j]} ` : ''}${lane.format(bin[k])}`));
  return values.some((v) => v != null) ? values.filter(Boolean).join(' · ') : 'no samples';
}

/** One sentence per bin for the live region and the data table's accessible name. */
export function binSentence(bins, binUs, i, sameDay) {
  const b = bins[i];
  if (!b) return '';
  const busy = BUSY_ORDER.filter((k) => b.busy?.[k]).map((k) => `${BUSY_LABEL[k]} ${formatDuration(b.busy[k])}`).join(', ');
  return [`${binTime(b.t, { sameDay })} to ${binTime(b.t + binUs, { sameDay })}`, busy || 'idle',
    ...LANES.filter((l) => l.kind === 'series' || l.kind === 'calls').map((l) => `${l.label}: ${laneText(l, b, binUs)}`)].join('. ');
}

// ---------------------------------------------------------------------------
// Drawing (browser only)

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    v,
    fg: v('--fg'), muted: v('--fg-muted'), faint: v('--fg-faint'), border: v('--border'), sunken: v('--bg-sunken'),
    accent: v('--accent'), err: v('--err'), llm: v('--c-llm'), tool: v('--c-tool-file'), bg: v('--bg'),
    font: `${v('--fs-xs') || '11px'} ${v('--font-ui') || 'sans-serif'}`,
  };
}

/** A CSS color that may be `var(--name)`, resolved for canvas. */
function resolve(tk, color) {
  const m = /^var\((--[\w-]+)\)$/.exec(color ?? '');
  return m ? tk.v(m[1]) : color;
}

/**
 * The lanes inside `host`. `timeline` is the server's PerformanceTimeline, `intervals` the ranked bottlenecks.
 * Callbacks: onZoom(from, to) after a drag or Return; onOpen(interval); onHoverInterval(spanId | null).
 * @returns {{ el: HTMLElement, highlight(spanId: string | null): void, reveal(laneId: string): void, focusBin(i: number): void, destroy(): void }}
 */
export function createPerfLanes(host, { timeline, intervals = [], bucketColor = {}, folded = new Set(), onFold, onZoom, onOpen, onHoverInterval }) {
  const bins = timeline.bins ?? [];
  const binUs = timeline.binUs;
  const segments = timeline.segments ?? [];
  const sameDay = !bins.length || new Date(bins[0].t / 1000).toDateString() === new Date((bins[bins.length - 1].t + binUs - 1) / 1000).toDateString();
  const seconds = binUs < 60e6;
  const when = (t) => binTime(t, { sameDay, seconds });
  const hasValues = (lane) => lane.kind !== 'series' || bins.some((b) => b[lane.primary] != null);

  const state = { hover: -1, cursor: -1, anchor: -1, drag: null, hoverInterval: null, linked: null };
  let scale = null;
  let width = 0;
  let packed = [];
  let tk = null;

  const root = document.createElement('div');
  root.className = 'pf-lanes';
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Performance over time. Arrow keys move the cursor between bins, Shift+arrows select bins, Return zooms to them, Escape clears.');
  const axis = document.createElement('div');
  axis.className = 'pf-axis';
  const axisCanvas = document.createElement('canvas');
  axisCanvas.setAttribute('aria-hidden', 'true');
  const cursorLabel = document.createElement('div');
  cursorLabel.className = 'pf-cursor-time';
  cursorLabel.hidden = true;
  axis.append(axisCanvas, cursorLabel);
  const tip = document.createElement('div');
  tip.className = 'chart-tip pf-tip';
  tip.hidden = true;
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  root.append(axis);

  const lanes = LANES.map((lane) => {
    const sec = document.createElement('section');
    sec.className = `pf-lane pf-lane-${lane.id}`;
    sec.dataset.lane = lane.id;
    const head = document.createElement('div');
    head.className = 'pf-lane-head';
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'pf-fold';
    fold.title = lane.help;
    const readout = document.createElement('span');
    readout.className = 'pf-readout';
    head.append(fold, readout);
    const canvas = document.createElement('canvas');
    canvas.className = 'pf-plot';
    canvas.setAttribute('aria-hidden', 'true');
    sec.append(head, canvas);
    root.append(sec);
    const item = { lane, sec, fold, readout, canvas, folded: folded.has(lane.id) };
    fold.addEventListener('click', () => setFolded(item, !item.folded));
    return item;
  });
  root.append(tip, live);
  host.append(root);

  function setFolded(item, value) {
    item.folded = value;
    item.sec.classList.toggle('is-folded', value);
    item.fold.setAttribute('aria-expanded', String(!value));
    item.fold.replaceChildren(value ? '▸ ' : '▾ ', item.lane.label);
    onFold?.(item.lane.id, value);
    paint();
  }
  for (const item of lanes) {
    item.sec.classList.toggle('is-folded', item.folded);
    item.fold.setAttribute('aria-expanded', String(!item.folded));
    item.fold.replaceChildren(item.folded ? '▸ ' : '▾ ', item.lane.label);
  }

  /** An interval bar's x range, clamped to the plot: an interval may begin before the view's range or end after it. */
  const barSpan = (r) => {
    const x0 = Math.max(MARGIN.left, xOf(r.start));
    return [x0, Math.min(width - MARGIN.right, Math.max(xOf(r.start + r.duration), x0 + 3))];
  };
  const heightOf = (lane) => (lane.kind === 'intervals' ? 8 + ROW_H * Math.max(1, Math.max(0, ...packed) + 1) : lane.height);
  const xOf = (t) => MARGIN.left + scale.x(t);

  function layout() {
    width = Math.floor(root.clientWidth);
    scale = perfScale(segments, width - MARGIN.left - MARGIN.right);
    // A rank that does not fit inside its bar sits after it, so a row needs room for both.
    packed = scale ? packRows(intervals.map((r, i) => {
      const [x0, x1] = barSpan(r);
      const label = 7 * String(i + 1).length + 4;
      return [x0, x1 - x0 >= label + 6 ? x1 : x1 + label + 3];
    })) : [];
  }

  function size(canvas, h) {
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx?.clearRect(0, 0, width, h);
    return ctx;
  }

  /** The selected bins: a drag, a Shift+arrow selection, or nothing. */
  function selection() {
    if (state.drag && state.drag.moved) return [state.drag.a, state.drag.b];
    if (state.anchor >= 0 && state.cursor >= 0 && state.anchor !== state.cursor) return [state.anchor, state.cursor];
    return null;
  }
  const active = () => (state.hover >= 0 ? state.hover : state.cursor);

  /** Grid, idle breaks, selection and cursor: what every lane shares. */
  function frame(ctx, h, ticks) {
    ctx.strokeStyle = tk.border;
    ctx.lineWidth = 1;
    for (const t of ticks) {
      const x = Math.round(t.x + MARGIN.left) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (const g of scale.breaks(segments[0].start, segments[segments.length - 1].end)) {
      const x0 = xOf(g.start);
      const x1 = xOf(g.end);
      ctx.fillStyle = tk.sunken;
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.strokeStyle = tk.faint;
      ctx.setLineDash([2, 3]);
      for (const x of [x0, x1]) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    const sel = selection();
    if (sel) {
      const r = binRange(bins, binUs, sel[0], sel[1]);
      ctx.fillStyle = tk.accent;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(xOf(r.from), 0, xOf(r.to) - xOf(r.from), h);
      ctx.globalAlpha = 1;
    }
    const i = active();
    if (i >= 0 && bins[i]) {
      const x0 = xOf(bins[i].t);
      const x1 = xOf(bins[i].t + binUs);
      ctx.fillStyle = tk.fg;
      ctx.globalAlpha = 0.06;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = tk.faint;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      const x = Math.round((x0 + x1) / 2) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Value axis on the left: 0 and the top tick. */
  function yAxis(ctx, h, max, format) {
    ctx.fillStyle = tk.muted;
    ctx.font = tk.font;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(format(max), MARGIN.left - 6, 8);
    ctx.fillText('0', MARGIN.left - 6, h - 6);
    ctx.strokeStyle = tk.border;
    ctx.beginPath();
    ctx.moveTo(MARGIN.left, h - 0.5);
    ctx.lineTo(width - MARGIN.right, h - 0.5);
    ctx.stroke();
  }

  const barX = (b) => [xOf(b.t), Math.max(1, xOf(b.t + binUs) - xOf(b.t) - (xOf(b.t + binUs) - xOf(b.t) > 3 ? 1 : 0))];

  function drawBusy(ctx, h) {
    let top = 1;
    for (const b of bins) top = Math.max(top, busyUs(b) / binUs);
    const y = niceTicks(0, top, 2);
    const k = (h - 6) / y.max;
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      const [x, w] = barX(b);
      let base = h;
      for (const name of BUSY_ORDER) {
        const us = b.busy?.[name];
        if (!us) continue;
        const bh = (us / binUs) * k;
        ctx.fillStyle = resolve(tk, bucketColor[name]) || tk.faint;
        ctx.globalAlpha = active() < 0 || active() === i ? 0.9 : 0.6;
        ctx.fillRect(x, base - bh, w, bh);
        base -= bh;
      }
    }
    ctx.globalAlpha = 1;
    // 100%: one session busy the whole bin.
    if (y.max > 1) {
      const y100 = Math.round(h - k) + 0.5;
      ctx.strokeStyle = tk.faint;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y100);
      ctx.lineTo(width - MARGIN.right, y100);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    yAxis(ctx, h, y.max, (v) => formatPercent(v, 0));
  }

  function drawCalls(ctx, h) {
    let top = 1;
    for (const b of bins) top = Math.max(top, (b.calls ?? 0) + (b.tools ?? 0));
    const y = niceTicks(0, top, 2);
    const k = (h - 8) / y.max;
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      const [x, w] = barX(b);
      ctx.globalAlpha = active() < 0 || active() === i ? 0.9 : 0.6;
      const llm = (b.calls ?? 0) * k;
      const tool = (b.tools ?? 0) * k;
      ctx.fillStyle = tk.llm;
      ctx.fillRect(x, h - llm, w, llm);
      ctx.fillStyle = tk.tool;
      ctx.fillRect(x, h - llm - tool, w, tool);
      if (b.failed) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = tk.err;
        ctx.beginPath();
        ctx.arc(x + w / 2, Math.max(4, h - llm - tool - 4), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    yAxis(ctx, h, y.max, (v) => formatTokens(v));
  }

  function drawSeries(ctx, h, lane) {
    const keys = [lane.primary, lane.secondary].filter(Boolean);
    const max = niceMax(laneTop(bins.flatMap((b) => keys.map((k) => b[k]))), lane.unit);
    // Values above the axis draw at its top with a caret; the header and the data table give the real value.
    const yOf = (v) => h - 2 - (Math.min(v, max) / max) * (h - 8);
    const half = binUs / 2;
    keys.forEach((key, j) => {
      ctx.strokeStyle = tk.llm;
      ctx.fillStyle = tk.llm;
      ctx.globalAlpha = j ? 0.55 : 1;
      ctx.lineWidth = j ? 1 : 1.5;
      ctx.setLineDash(j ? [4, 3] : []);
      for (let i = 0; i < bins.length; i++) {
        const v = bins[i][key];
        if (v == null) continue;
        const x = xOf(bins[i].t + half);
        const prev = bins[i - 1];
        const joined = prev && prev.t + binUs === bins[i].t && prev[key] != null;
        if (joined) {
          ctx.beginPath();
          ctx.moveTo(xOf(prev.t + half), yOf(prev[key]));
          ctx.lineTo(x, yOf(v));
          ctx.stroke();
        }
        const next = bins[i + 1];
        const isolated = !joined && !(next && bins[i].t + binUs === next.t && next[key] != null);
        if (v > max) {
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(x - 3.5, 7);
          ctx.lineTo(x + 3.5, 7);
          ctx.lineTo(x, 1);
          ctx.closePath();
          ctx.fill();
          ctx.setLineDash(j ? [4, 3] : []);
        } else if (isolated || active() === i) {
          ctx.beginPath();
          ctx.arc(x, yOf(v), active() === i ? 3 : 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.setLineDash([]);
    });
    ctx.globalAlpha = 1;
    yAxis(ctx, h, max, lane.unit === 'us' ? formatDuration : lane.unit === 'ratio' ? (v) => formatPercent(v, 0)
      : lane.unit === 'rate' ? (v) => `${formatTokens(v)}/s` : formatTokens);
  }

  function drawIntervals(ctx, h) {
    ctx.font = tk.font;
    ctx.textBaseline = 'middle';
    intervals.forEach((r, i) => {
      const [x0, x1] = barSpan(r);
      const y = 4 + packed[i] * ROW_H;
      const on = state.hoverInterval === r.spanId || state.linked === r.spanId;
      ctx.fillStyle = resolve(tk, bucketColor[r.bucket]) || tk.faint;
      ctx.globalAlpha = on || !(state.hoverInterval || state.linked) ? 0.9 : 0.45;
      ctx.fillRect(x0, y, x1 - x0, ROW_H - 4);
      ctx.globalAlpha = 1;
      if (on) {
        ctx.strokeStyle = tk.fg;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 - 1, y - 1, x1 - x0 + 2, ROW_H - 2);
      }
      // The rank sits inside a wide bar, else after it.
      const label = String(i + 1);
      const lw = ctx.measureText(label).width;
      const inside = x1 - x0 >= lw + 6;
      ctx.fillStyle = inside ? tk.bg : tk.fg;
      ctx.textAlign = 'left';
      ctx.fillText(label, inside ? x0 + 3 : Math.min(x1 + 3, width - lw - 2), y + (ROW_H - 4) / 2);
    });
  }

  function drawAxis(ticks) {
    const ctx = size(axisCanvas, AXIS_H);
    if (!ctx) return;
    ctx.font = tk.font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const g of scale.breaks(segments[0].start, segments[segments.length - 1].end)) {
      ctx.fillStyle = tk.sunken;
      ctx.fillRect(xOf(g.start), 0, xOf(g.end) - xOf(g.start), AXIS_H);
      // A broken-axis mark: two slanted strokes.
      const mid = (xOf(g.start) + xOf(g.end)) / 2;
      ctx.strokeStyle = tk.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const dx of [-2, 2]) {
        ctx.moveTo(mid + dx - 2, AXIS_H / 2 + 5);
        ctx.lineTo(mid + dx + 2, AXIS_H / 2 - 5);
      }
      ctx.stroke();
    }
    // Each segment is labeled at its start, with the date when the lanes span days; those labels go first, then the
    // ticks where they fit. A segment too narrow for its label leaves it to the cursor and the break's tooltip.
    const label = (t, text, lead, room = Infinity) => {
      const w = ctx.measureText(text).width;
      const x = lead ? xOf(t) + 3 + w / 2 : xOf(t);
      return { text, w, lead, fits: room >= w / 2, x: Math.min(Math.max(x, MARGIN.left + w / 2), width - MARGIN.right - w / 2) };
    };
    const labels = [
      ...segments.map((g) => label(g.start, binTime(g.start, { sameDay, seconds }), true, xOf(g.end) - xOf(g.start))),
      ...ticks.filter((t) => !t.edge && !segments.some((g) => g.start === t.t)).map((t) => label(t.t, t.text, false)),
    ].filter((l) => l.fits);
    const placed = [];
    for (const l of labels) {
      if (placed.some((p) => Math.abs(p.x - l.x) < (p.w + l.w) / 2 + 8)) continue;
      placed.push(l);
      ctx.fillStyle = l.lead ? tk.fg : tk.muted;
      ctx.fillText(l.text, l.x, AXIS_H / 2);
    }
  }

  function paint() {
    if (!scale) layout();
    if (!scale || !width) return;
    tk = tokens();
    const ticks = generateTicks(scale, width - MARGIN.left - MARGIN.right, 96).ticks;
    drawAxis(ticks);
    for (const item of lanes) {
      updateReadout(item);
      if (item.folded) continue;
      const h = heightOf(item.lane);
      const ctx = size(item.canvas, h);
      if (!ctx) continue;
      frame(ctx, h, ticks);
      if (item.lane.kind === 'busy') drawBusy(ctx, h);
      else if (item.lane.kind === 'calls') drawCalls(ctx, h);
      else if (item.lane.kind === 'intervals') drawIntervals(ctx, h);
      else if (hasValues(item.lane)) drawSeries(ctx, h, item.lane);
      else {
        ctx.fillStyle = tk.muted;
        ctx.font = tk.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Not recorded in this view', (width + MARGIN.left) / 2, h / 2);
      }
    }
    const i = active();
    cursorLabel.hidden = i < 0;
    if (i >= 0 && bins[i]) {
      cursorLabel.textContent = `${when(bins[i].t)}–${binTime(bins[i].t + binUs, { sameDay: true, seconds })}`;
      const x = xOf(bins[i].t + binUs / 2);
      const w = cursorLabel.offsetWidth;
      cursorLabel.style.left = `${Math.min(Math.max(0, x - w / 2), width - w)}px`;
    }
  }

  /** The header: values of the bin under the cursor, else the bin to look at first (a button that moves the cursor there). */
  function updateReadout(item) {
    const { lane, readout } = item;
    const i = active();
    const parts = [];
    if (lane.kind === 'busy') {
      const totals = i >= 0 ? bins[i].busy ?? {} : timeline.busy ?? {};
      if (i >= 0) parts.push(h('strong', null, laneText(lane, bins[i], binUs)));
      for (const name of BUSY_ORDER) {
        if (!totals[name]) continue;
        const sw = h('span', { class: 'pf-swatch', style: `background:${bucketColor[name] ?? 'var(--fg-faint)'}` });
        parts.push(h('span', null, sw, `${BUSY_LABEL[name]} ${formatDuration(totals[name])}`));
      }
      if (!parts.length) parts.push(h('span', null, 'No timed work in this view'));
    } else if (lane.kind === 'intervals') {
      const r = intervals.find((x) => x.spanId === (state.hoverInterval ?? state.linked));
      if (r) {
        const rank = intervals.indexOf(r) + 1;
        parts.push(h('strong', null, `${rank}. ${r.name}`), h('span', null, `${INTERVAL_LABEL[r.bucket] ?? r.bucket} · ${formatDuration(r.duration)}${r.estimated ? '≈' : ''} · ${when(r.start)}`));
      } else {
        parts.push(h('span', null, intervals.length ? `${plural(intervals.length, 'interval')}, numbered as in the list below` : 'No completed, timed intervals in this view'));
      }
    } else if (i >= 0) {
      parts.push(h('span', null, laneText(lane, bins[i], binUs)));
    } else if (lane.peak) {
      const p = peakBin(bins, lane.peak.key, lane.peak.pick);
      if (p >= 0) {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'pf-peak';
        go.title = 'Move the cursor to this bin';
        go.textContent = `${lane.peak.text} ${lane.format(bins[p][lane.peak.key])} at ${when(bins[p].t)}`;
        go.addEventListener('click', () => focusBin(p));
        parts.push(go);
      } else parts.push(h('span', null, 'Not recorded in this view'));
    } else if (lane.kind === 'calls') {
      const p = peakBin(bins.map((b) => ({ n: (b.calls ?? 0) + (b.tools ?? 0) || null })), 'n', 'max');
      const failed = bins.reduce((a, b) => a + (b.failed ?? 0), 0);
      if (p >= 0) {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'pf-peak';
        go.title = 'Move the cursor to this bin';
        go.textContent = `busiest ${plural((bins[p].calls ?? 0) + (bins[p].tools ?? 0), 'call')} at ${when(bins[p].t)}`;
        go.addEventListener('click', () => focusBin(p));
        parts.push(go, h('span', null, failed ? `${formatInt(failed)} failed in all` : 'none failed'));
      }
    }
    readout.replaceChildren(...parts);
  }

  // ---- Pointer

  function binFromEvent(ev, canvas) {
    if (!scale) return -1;
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left;
    if (px < MARGIN.left || px > width - MARGIN.right) return -1;
    return binAt(bins, binUs, scale.t(px - MARGIN.left));
  }

  function intervalAt(ev, canvas) {
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    for (let i = intervals.length - 1; i >= 0; i--) {
      const it = intervals[i];
      const [x0, x1] = barSpan(it);
      const y = 4 + packed[i] * ROW_H;
      if (px >= x0 - 2 && px <= x1 + 2 && py >= y - 2 && py <= y + ROW_H) return it;
    }
    return null;
  }

  function showTip(ev, text) {
    if (!text) {
      tip.hidden = true;
      return;
    }
    tip.textContent = text;
    tip.hidden = false;
    const r = root.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const flip = x > r.width - 260;
    tip.style.left = flip ? '' : `${x + 12}px`;
    tip.style.right = flip ? `${r.width - x + 12}px` : '';
    tip.style.top = `${ev.clientY - r.top + 14}px`;
  }

  function breakAt(ev, canvas) {
    if (!scale) return null;
    const px = ev.clientX - canvas.getBoundingClientRect().left;
    return scale.breaks(segments[0].start, segments[segments.length - 1].end).find((g) => px >= xOf(g.start) && px <= xOf(g.end)) ?? null;
  }

  for (const item of [...lanes.map((l) => ({ canvas: l.canvas, lane: l.lane })), { canvas: axisCanvas, lane: null }]) {
    const { canvas, lane } = item;
    canvas.addEventListener('mousemove', (ev) => {
      let changed = false;
      if (lane?.kind === 'intervals') {
        const it = intervalAt(ev, canvas);
        if ((it?.spanId ?? null) !== state.hoverInterval) {
          state.hoverInterval = it?.spanId ?? null;
          onHoverInterval?.(state.hoverInterval);
          changed = true;
        }
        canvas.style.cursor = it ? 'pointer' : 'crosshair';
        showTip(ev, it ? `${it.name} · ${INTERVAL_LABEL[it.bucket] ?? it.bucket} · ${formatDuration(it.duration)}${it.estimated ? '≈ estimated' : ''} · ${when(it.start)}. Click to open it in Timeline.` : null);
      } else {
        const g = breakAt(ev, canvas);
        showTip(ev, g ? `Idle ${formatDuration(g.end - g.start)}, collapsed` : null);
      }
      const i = binFromEvent(ev, canvas);
      if (state.drag) {
        if (i >= 0 && i !== state.drag.b) {
          state.drag.b = i;
          state.drag.moved = true;
          changed = true;
        }
      }
      if (i !== state.hover) {
        state.hover = i;
        changed = true;
      }
      if (changed) paint();
    });
    canvas.addEventListener('mouseleave', () => {
      tip.hidden = true;
      if (state.hoverInterval) onHoverInterval?.(null);
      state.hoverInterval = null;
      state.hover = -1;
      paint();
    });
    canvas.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || (lane?.kind === 'intervals' && intervalAt(ev, canvas))) return;
      const i = binFromEvent(ev, canvas);
      if (i < 0) return;
      ev.preventDefault();
      root.focus({ preventScroll: true });
      state.drag = { a: i, b: i, moved: false };
    });
    canvas.addEventListener('click', (ev) => {
      if (lane?.kind === 'intervals') {
        const it = intervalAt(ev, canvas);
        if (it) onOpen?.(it);
      }
    });
  }
  const onUp = () => {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    if (d.moved) {
      const r = binRange(bins, binUs, d.a, d.b);
      if (r) onZoom?.(r.from, r.to);
    } else {
      // A click pins the cursor on the bin, or unpins it.
      state.cursor = state.cursor === d.a ? -1 : d.a;
      state.anchor = -1;
    }
    paint();
  };
  window.addEventListener('mouseup', onUp);

  // ---- Keyboard

  function focusBin(i) {
    state.cursor = Math.max(0, Math.min(bins.length - 1, i));
    state.anchor = -1;
    paint();
    live.textContent = binSentence(bins, binUs, state.cursor, sameDay);
  }

  root.addEventListener('keydown', (ev) => {
    if (ev.target !== root || !bins.length) return;
    const cur = state.cursor;
    const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
    if (step) {
      ev.preventDefault();
      if (ev.shiftKey && state.anchor < 0) state.anchor = cur < 0 ? 0 : cur;
      if (!ev.shiftKey) state.anchor = -1;
      state.cursor = Math.max(0, Math.min(bins.length - 1, cur < 0 ? (step > 0 ? 0 : bins.length - 1) : cur + step));
    } else if (ev.key === 'Home' || ev.key === 'End') {
      ev.preventDefault();
      if (!ev.shiftKey) state.anchor = -1;
      else if (state.anchor < 0) state.anchor = Math.max(0, cur);
      state.cursor = ev.key === 'Home' ? 0 : bins.length - 1;
    } else if (ev.key === 'Enter' && cur >= 0) {
      ev.preventDefault();
      const r = binRange(bins, binUs, state.anchor >= 0 ? state.anchor : cur, cur);
      if (r) onZoom?.(r.from, r.to);
      return;
    } else if (ev.key === 'Escape' && (cur >= 0 || state.anchor >= 0)) {
      ev.preventDefault();
      state.cursor = -1;
      state.anchor = -1;
      paint();
      return;
    } else return;
    paint();
    const sel = selection();
    live.textContent = sel
      ? `Selected ${plural(Math.abs(sel[1] - sel[0]) + 1, 'bin')}, ${when(bins[Math.min(...sel)].t)} to ${when(bins[Math.max(...sel)].t + binUs)}. Press Return to zoom.`
      : binSentence(bins, binUs, state.cursor, sameDay);
  });

  window.addEventListener('agentshark:theme', paint);
  let lastWidth = -1;
  const ro = new ResizeObserver(() => {
    if (!root.isConnected || root.clientWidth === lastWidth) return;
    lastWidth = root.clientWidth;
    layout();
    paint();
  });
  ro.observe(root);

  return {
    el: root,
    /** Outline one interval (a list row is hovered), or none. */
    highlight(spanId) {
      state.linked = spanId;
      paint();
    },
    /** Unfold a lane and scroll it into view. */
    reveal(laneId) {
      const item = lanes.find((l) => l.lane.id === laneId);
      if (!item) return;
      if (item.folded) setFolded(item, false);
      item.sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      item.sec.classList.remove('is-flash');
      void item.sec.offsetWidth;
      item.sec.classList.add('is-flash');
    },
    focusBin,
    destroy() {
      ro.disconnect();
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('agentshark:theme', paint);
      root.remove();
    },
  };
}
