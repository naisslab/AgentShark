// Canvas time-series chart for the Statistics I/O graph.
// Tick, scale, gap-filling and hit-test math is pure (unit-tested in test/web/chart.test.ts);
// drawing reads colors and fonts from the CSS tokens at draw time so theme changes repaint correctly.

import { formatBytes, formatClock, formatDuration, formatTokens, pad } from './format.js';

const MS = 1e3;
const SEC = 1e6;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Candidate time-axis steps in µs, smallest first. */
const TIME_STEPS = [
  ...[1, 2, 5, 10, 20, 50, 100, 200, 500].map((x) => x * MS),
  ...[1, 2, 5, 10, 15, 30].map((x) => x * SEC),
  ...[1, 2, 5, 10, 15, 30].map((x) => x * MIN),
  ...[1, 2, 3, 6, 12].map((x) => x * HOUR),
  ...[1, 2, 7, 14, 30, 91, 365].map((x) => x * DAY),
];

/** Round a raw step up to 1, 2 or 5 times a power of ten. */
export function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(raw));
  const f = raw / base;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * base;
}

/** Value-axis ticks covering [min, max] with at most about `maxTicks` intervals. */
export function niceTicks(min, max, maxTicks = 5) {
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max) || max <= min) max = min + 1;
  const step = niceStep((max - min) / Math.max(1, maxTicks));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  const n = Math.round((hi - lo) / step);
  // Multiply instead of accumulating so 0.1 + 0.2 style drift never reaches the labels.
  for (let i = 0; i <= n; i++) ticks.push(Number((lo + i * step).toPrecision(12)));
  return { min: lo, max: hi, step, ticks };
}

/** Smallest step from TIME_STEPS that keeps the tick count at or below `maxTicks`. */
export function timeStep(spanUs, maxTicks = 6) {
  const n = Math.max(1, maxTicks);
  return TIME_STEPS.find((s) => spanUs / s <= n) ?? TIME_STEPS[TIME_STEPS.length - 1];
}

/** Local-time offset from UTC in µs at instant `t` (positive east of Greenwich). */
export function localOffsetUs(t) {
  return -new Date(t / 1000).getTimezoneOffset() * MIN;
}

/**
 * Time-axis ticks in [from, to], aligned to local wall-clock multiples of the step
 * so that hour ticks land on full hours and day ticks on local midnight.
 */
export function timeTicks(from, to, maxTicks = 6, tzOffsetUs = localOffsetUs(from)) {
  if (!(to > from)) return { step: SEC, ticks: [from] };
  const step = timeStep(to - from, maxTicks);
  const first = Math.ceil((from + tzOffsetUs) / step) * step - tzOffsetUs;
  const ticks = [];
  for (let t = first; t <= to; t += step) ticks.push(t);
  return { step, ticks };
}

/** Short local-time label for a tick; the step decides the precision. Midnight shows the date. */
export function formatTimeTick(t, step) {
  const d = new Date(t / 1000);
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (step >= DAY) return date;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (step >= MIN) return d.getHours() === 0 && d.getMinutes() === 0 ? date : hm;
  if (step >= SEC) return `${hm}:${pad(d.getSeconds())}`;
  return `${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Format a value of the given unit: 'us' (duration), 'bytes', otherwise a compact count. */
export function formatValue(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'us') return formatDuration(v);
  if (unit === 'bytes') return formatBytes(v);
  if (unit === 'tokens/s') return `${Number(v.toFixed(2))} tok/s`;
  return Math.abs(v) < 1000 && !Number.isInteger(v) ? String(Number(v.toFixed(2))) : formatTokens(v);
}

/**
 * Insert the empty bins a server may omit so that lines drop to `fill` instead of
 * bridging gaps. Use 0 for counts and null for means (a gap in the line).
 * Series longer than `maxBins` after filling are returned unchanged.
 */
export function fillSeries(series, binUs, fill = 0, maxBins = 50_000) {
  if (!series.length || !(binUs > 0)) return series.slice();
  const t0 = series[0].t;
  const n = Math.round((series[series.length - 1].t - t0) / binUs) + 1;
  if (n > maxBins || n <= series.length) return series.slice();
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * binUs;
    while (j < series.length && series[j].t < t - binUs / 2) j++;
    if (j < series.length && Math.abs(series[j].t - t) < binUs / 2) out.push(series[j++]);
    else out.push({ t, v: fill });
  }
  return out;
}

/** Index of the bin that contains time `t` (series sorted by t), or -1. */
export function binIndexAt(series, t, binUs) {
  let lo = 0;
  let hi = series.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 && t < series[found].t + binUs ? found : -1;
}

/** Plot-area margins in CSS pixels: room for value labels on the left and time labels below. */
export const MARGIN = { left: 56, right: 14, top: 10, bottom: 24 };

/**
 * Pure layout for a time series: plot rectangle, scales and ticks.
 * The time domain is [first bin start, last bin end]; the value axis starts at 0.
 */
export function chartLayout(width, height, series, binUs) {
  const plot = {
    x: MARGIN.left,
    y: MARGIN.top,
    w: Math.max(1, width - MARGIN.left - MARGIN.right),
    h: Math.max(1, height - MARGIN.top - MARGIN.bottom),
  };
  const t0 = series.length ? series[0].t : 0;
  const t1 = series.length ? series[series.length - 1].t + binUs : t0 + binUs;
  let vmax = 0;
  for (const p of series) if (p.v != null && p.v > vmax) vmax = p.v;
  const y = niceTicks(0, vmax > 0 ? vmax : 1, Math.max(2, Math.floor(plot.h / 32)));
  const x = timeTicks(t0, t1, Math.max(2, Math.floor(plot.w / 96)));
  const span = Math.max(1, t1 - t0);
  return {
    plot,
    t0,
    t1,
    yMax: y.max,
    yTicks: y.ticks,
    xStep: x.step,
    xTicks: x.ticks,
    xOf: (t) => plot.x + ((t - t0) / span) * plot.w,
    yOf: (v) => plot.y + plot.h - (v / y.max) * plot.h,
    tAt: (px) => t0 + ((px - plot.x) / plot.w) * span,
  };
}

/** Bars when every bin gets at least 3 px; a line with a light area fill otherwise. */
export function chartMode(plotWidth, bins) {
  return bins > 0 && plotWidth / bins >= 3 ? 'bar' : 'line';
}

// ---------------------------------------------------------------------------
// Drawing (browser only)

function readTokens(colorVar) {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    series: v(colorVar || '--fg-muted') || v('--fg'),
    muted: v('--fg-muted'),
    faint: v('--fg-faint'),
    border: v('--border'),
    font: `${v('--fs-xs') || '11px'} ${v('--font-ui') || 'sans-serif'}`,
  };
}

function draw(ctx, w, h, data, hover) {
  const tk = readTokens(data.colorVar);
  const color = tk.series;
  ctx.clearRect(0, 0, w, h);
  ctx.font = tk.font;
  const L = chartLayout(w, h, data.series, data.binUs);
  const { plot } = L;

  // Value grid and labels.
  ctx.strokeStyle = tk.border;
  ctx.fillStyle = tk.muted;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of L.yTicks) {
    const y = Math.round(L.yOf(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillText(formatValue(v, data.unit), plot.x - 6, y);
  }

  // Time labels.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of L.xTicks) {
    const x = Math.round(L.xOf(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, plot.y + plot.h);
    ctx.lineTo(x, plot.y + plot.h + 4);
    ctx.stroke();
    // Keep edge labels inside the canvas instead of clipping them.
    const label = formatTimeTick(t, L.xStep);
    const labelHalf = ctx.measureText(label).width / 2;
    ctx.fillText(label, Math.min(Math.max(x, labelHalf + 1), w - labelHalf - 1), plot.y + plot.h + 6);
  }

  const series = data.series;
  const mode = chartMode(plot.w, series.length);
  const base = plot.y + plot.h;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (mode === 'bar') {
    const bw = Math.max(1, L.xOf(series[0].t + data.binUs) - L.xOf(series[0].t) - 1);
    for (let i = 0; i < series.length; i++) {
      const p = series[i];
      if (p.v == null || p.v <= 0) continue;
      ctx.globalAlpha = hover === i ? 1 : 0.75;
      const y = L.yOf(p.v);
      ctx.fillRect(L.xOf(p.t), y, bw, base - y);
    }
    ctx.globalAlpha = 1;
  } else {
    // Each point sits at its bin centre; null values break the line.
    const half = data.binUs / 2;
    let open = false;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const p of series) {
      if (p.v == null) {
        open = false;
        continue;
      }
      const x = L.xOf(p.t + half);
      const y = L.yOf(p.v);
      if (open) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      open = true;
    }
    ctx.stroke();
    ctx.globalAlpha = 0.15;
    for (let i = 0; i < series.length; ) {
      if (series[i].v == null) {
        i++;
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(L.xOf(series[i].t + half), base);
      while (i < series.length && series[i].v != null) {
        ctx.lineTo(L.xOf(series[i].t + half), L.yOf(series[i].v));
        i++;
      }
      ctx.lineTo(L.xOf(series[i - 1].t + half), base);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Crosshair on the hovered bin.
  if (hover >= 0 && series[hover]) {
    const p = series[hover];
    const x = Math.round(L.xOf(p.t + data.binUs / 2)) + 0.5;
    ctx.strokeStyle = tk.faint;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, base);
    if (p.v != null) {
      const y = Math.round(L.yOf(p.v)) + 0.5;
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (p.v != null) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, L.yOf(p.v), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return L;
}

/** Accessible name of a chart: what it plots, its bins and its peak. */
function describe(d) {
  const pts = (d?.series ?? []).filter((p) => p.v != null);
  if (!pts.length) return `${d?.label ?? 'Chart'}: no data`;
  const peak = pts.reduce((a, b) => (b.v > a.v ? b : a));
  return `${d.label ?? 'Value'} over time in ${d.series.length} bins of ${formatDuration(d.binUs)}; ` +
    `peak ${formatValue(peak.v, d.unit)} at ${formatClock(peak.t, { digits: 0 })}. Use the arrow keys to read each bin.`;
}

/**
 * Interactive chart inside `container`: resizes with it, repaints on theme change,
 * shows a crosshair tooltip and reports clicked bins.
 * @param {HTMLElement} container
 * `fill` sizes the chart to its container's height (at least `minHeight`), so it takes the room it is given.
 * @param {{ height?: number, fill?: boolean, minHeight?: number, onClick?: (bin: {t:number, v:number|null}, binUs: number) => void }} [opts]
 */
export function createChart(container, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  const canvas = document.createElement('canvas');
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  // Keyboard and screen-reader access: the canvas is focusable, arrow keys step through the bins,
  // and each bin's text is announced through a polite live region.
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  wrap.append(canvas, tip, live);
  container.append(wrap);

  /** @type {{series: {t:number, v:number|null}[], binUs: number, unit?: string, label?: string, colorVar?: string} | null} */
  let data = null;
  let layout = null;
  let hover = -1;
  let width = 0;
  let height = opts.height ?? 280;
  const fillHeight = () => Math.max(opts.minHeight ?? 240, Math.floor(container.clientHeight) - 4);

  function repaint() {
    if (!data || !data.series.length || width <= 0) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      layout = null;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout = draw(ctx, width, height, data, hover);
  }

  function binFromEvent(ev) {
    if (!layout || !data) return -1;
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    const { plot } = layout;
    if (px < plot.x || px > plot.x + plot.w || py < plot.y || py > plot.y + plot.h) return -1;
    return binIndexAt(data.series, layout.tAt(px), data.binUs);
  }

  const binText = (p) => ({
    time: `${formatClock(p.t, { digits: 0 })} + ${formatDuration(data.binUs)}`,
    value: `${data.label ?? 'value'}: ${p.v == null ? 'no data' : formatValue(p.v, data.unit)}`,
  });

  function showTip(i, ev) {
    if (i < 0 || !data) {
      tip.hidden = true;
      return;
    }
    const text = binText(data.series[i]);
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'chart-tip-time';
    head.textContent = text.time;
    const val = document.createElement('div');
    val.className = 'chart-tip-value';
    val.textContent = text.value;
    tip.append(head, val);
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const flip = x > r.width - 220;
    tip.style.left = flip ? '' : `${x + 12}px`;
    tip.style.right = flip ? `${r.width - x + 12}px` : '';
    tip.style.top = `${Math.max(0, ev.clientY - r.top - 40)}px`;
  }

  const onMove = (ev) => {
    const i = binFromEvent(ev);
    showTip(i, ev);
    canvas.style.cursor = i >= 0 && opts.onClick ? 'pointer' : 'crosshair';
    if (i !== hover) {
      hover = i;
      repaint();
    }
  };
  const onLeave = () => {
    tip.hidden = true;
    if (hover !== -1) {
      hover = -1;
      repaint();
    }
  };
  const onClick = (ev) => {
    const i = binFromEvent(ev);
    if (i >= 0 && data && opts.onClick) opts.onClick(data.series[i], data.binUs);
  };
  /** Arrow keys move between bins (Home/End jump), Enter acts like a click on the focused bin. */
  const onKey = (ev) => {
    if (!data?.series.length || !layout) return;
    const n = data.series.length;
    const cur = hover >= 0 ? hover : -1;
    const next = { ArrowRight: cur + 1, ArrowLeft: cur < 0 ? n - 1 : cur - 1, Home: 0, End: n - 1 }[ev.key];
    if (ev.key === 'Enter' && cur >= 0) {
      ev.preventDefault();
      opts.onClick?.(data.series[cur], data.binUs);
      return;
    }
    if (next == null) return;
    ev.preventDefault();
    hover = Math.max(0, Math.min(n - 1, next));
    repaint();
    const p = data.series[hover];
    const r = canvas.getBoundingClientRect();
    showTip(hover, { clientX: r.left + layout.xOf(p.t + data.binUs / 2), clientY: r.top + layout.plot.y + 40 });
    const text = binText(p);
    live.textContent = `${text.time}. ${text.value}.`;
  };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('blur', onLeave);
  window.addEventListener('agentshark:theme', repaint);

  const ro = new ResizeObserver(() => {
    const w = Math.floor(wrap.clientWidth);
    const hgt = opts.fill ? fillHeight() : height;
    if (w !== width || hgt !== height) {
      width = w;
      height = hgt;
      repaint();
    }
  });
  ro.observe(wrap);
  if (opts.fill) ro.observe(container);

  return {
    el: wrap,
    setData(next) {
      data = next;
      hover = -1;
      tip.hidden = true;
      width = Math.floor(wrap.clientWidth);
      if (opts.fill) height = fillHeight();
      canvas.setAttribute('aria-label', describe(next));
      repaint();
    },
    destroy() {
      ro.disconnect();
      window.removeEventListener('agentshark:theme', repaint);
      wrap.remove();
    },
  };
}
