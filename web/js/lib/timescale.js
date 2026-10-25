// Time-axis math for the timeline views (SPEC §7.2): a piecewise-linear time → pixel mapping
// that collapses idle gaps into fixed-width breaks, local-time ticks from years down to
// microseconds, and zoom/pan/fit helpers. Pure functions, no DOM.
// All times are integer microseconds since the epoch; a view is { t0, k } where t0 is the
// time at the left edge and k is pixels per microsecond of uncollapsed time.

export const GAP_MIN_US = 5 * 60e6;
export const BREAK_PX = 24;
/** Deepest zoom: one microsecond spans 4 px. */
export const K_MAX = 4;

const MS = 1e3;
const S = 1e6;
const MIN = 60e6;
const H = 3600e6;
const D = 86400e6;
const MAX_TICKS = 2000;

/**
 * Idle gaps longer than `minGap` between busy intervals. Intervals may overlap and may have a
 * null or inverted end (treated as a point).
 * @param {{start: number, end?: number|null}[]} intervals
 * @returns {{start: number, end: number}[]} sorted and disjoint
 */
export function findGaps(intervals, minGap = GAP_MIN_US) {
  const iv = [];
  for (const it of intervals) {
    if (!Number.isFinite(it?.start)) continue;
    iv.push([it.start, Number.isFinite(it.end) && it.end > it.start ? it.end : it.start]);
  }
  iv.sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let reach = -Infinity;
  for (const [a, b] of iv) {
    if (reach > -Infinity && a - reach > minGap) gaps.push({ start: reach, end: a });
    if (b > reach) reach = b;
  }
  return gaps;
}

/** Index of the last i in [0, n) with key(i) <= v (keys ascending), or -1. */
function lastAtOrBelow(n, key, v) {
  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(mid) <= v) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Mapping for one zoom level. A gap is collapsed only when its linear width would exceed
 * `breakPx`, so a gap never takes more room than it would uncollapsed and the total width is
 * continuous in k. Time inside a break maps linearly across the break, which keeps the mapping
 * monotonic and invertible everywhere.
 * @param {{t0: number, k: number, gaps?: {start: number, end: number}[], breakPx?: number}} opts
 */
export function createScale({ t0, k, gaps = [], breakPx = BREAK_PX }) {
  const active = gaps.filter((g) => (g.end - g.start) * k > breakPx);
  const n = active.length;
  // gx[i]: unshifted pixel position of break i's left edge.
  const gx = new Float64Array(n);
  let removed = 0;
  for (let i = 0; i < n; i++) {
    gx[i] = (active[i].start - t0 - removed) * k + i * breakPx;
    removed += active[i].end - active[i].start;
  }
  const raw = (t) => {
    const i = lastAtOrBelow(n, (j) => active[j].start, t);
    if (i < 0) return (t - t0) * k;
    const g = active[i];
    if (t < g.end) return gx[i] + ((t - g.start) / (g.end - g.start)) * breakPx;
    return gx[i] + breakPx + (t - g.end) * k;
  };
  const x0 = raw(t0);
  const x = (t) => raw(t) - x0;
  const t = (px) => {
    const v = px + x0;
    const i = lastAtOrBelow(n, (j) => gx[j], v);
    if (i < 0) return t0 + v / k;
    const g = active[i];
    if (v < gx[i] + breakPx) return g.start + ((v - gx[i]) / breakPx) * (g.end - g.start);
    return g.end + (v - gx[i] - breakPx) / k;
  };
  return {
    t0,
    k,
    breakPx,
    x,
    t,
    /** Collapsed gaps intersecting [from, to] with the pixel position of their left edge. */
    breaks(from, to) {
      const out = [];
      for (const g of active) {
        if (g.start >= to) break;
        if (g.end > from) out.push({ start: g.start, end: g.end, x: x(g.start) });
      }
      return out;
    },
    /** Uncollapsed stretches of [from, to] between breaks. */
    segments(from, to) {
      const out = [];
      let a = from;
      for (const g of active) {
        if (g.start >= to) break;
        if (g.end <= a) continue;
        if (g.start > a) out.push({ start: a, end: g.start });
        a = g.end;
      }
      if (a < to) out.push({ start: a, end: to });
      return out;
    },
  };
}

/**
 * View that shows [from, to] across `width` px with `pad` px on each side. With gaps the width
 * depends on which gaps collapse at a given k, so k is found by bisection (width grows
 * monotonically with k).
 */
export function fitView(from, to, width, { gaps = [], breakPx = BREAK_PX, pad = 0, kMax = K_MAX } = {}) {
  if (!(to > from)) to = from + MS;
  const target = Math.max(1, width - 2 * pad);
  const widthAt = (k) => createScale({ t0: from, k, gaps, breakPx }).x(to);
  let lo = target / (to - from);
  let hi = lo;
  for (let i = 0; i < 80 && widthAt(hi) < target; i++) hi *= 2;
  for (let i = 0; i < 60 && hi / lo > 1 + 1e-9; i++) {
    const mid = Math.sqrt(lo * hi);
    if (widthAt(mid) < target) lo = mid;
    else hi = mid;
  }
  const k = Math.min(hi, kMax);
  return { t0: createScale({ t0: from, k, gaps, breakPx }).t(-pad), k };
}

/** Scale the view by `factor` while the time under pixel `x` stays under `x`. */
export function zoomAround(view, x, factor, { gaps = [], breakPx = BREAK_PX, kMin = 0, kMax = K_MAX } = {}) {
  const anchor = createScale({ ...view, gaps, breakPx }).t(x);
  const k = Math.min(kMax, Math.max(kMin, view.k * factor));
  return { t0: createScale({ t0: anchor, k, gaps, breakPx }).t(-x), k };
}

/** Move the view so that the time now at pixel `dx` becomes the left edge. */
export function panView(view, dx, { gaps = [], breakPx = BREAK_PX } = {}) {
  return { t0: createScale({ ...view, gaps, breakPx }).t(dx), k: view.k };
}

// ---------------------------------------------------------------------------
// Ticks

const STEPS = [
  ...[1, 2, 5, 10, 20, 50, 100, 200, 500].map((n) => ({ us: n, unit: 'us', n })),
  ...[1, 2, 5, 10, 20, 50, 100, 200, 500].map((n) => ({ us: n * MS, unit: 'ms', n })),
  ...[1, 2, 5, 10, 15, 30].map((n) => ({ us: n * S, unit: 's', n })),
  ...[1, 2, 5, 10, 15, 30].map((n) => ({ us: n * MIN, unit: 'min', n })),
  ...[1, 2, 3, 6, 12].map((n) => ({ us: n * H, unit: 'h', n })),
  ...[1, 2, 7, 14].map((n) => ({ us: n * D, unit: 'd', n })),
  ...[1, 3, 6].map((n) => ({ us: n * 30.44 * D, unit: 'mo', n })),
  ...[1, 2, 5, 10].map((n) => ({ us: n * 365.25 * D, unit: 'y', n })),
];

/** Smallest tick step whose spacing at `k` px/µs is at least `minPx`. */
export function pickStep(k, minPx = 80) {
  return STEPS.find((s) => s.us * k >= minPx) ?? STEPS[STEPS.length - 1];
}

/** Local UTC offset at time t, in µs (east of UTC is positive). */
function tzOffsetUs(t) {
  return -new Date(Math.floor(t / MS)).getTimezoneOffset() * MIN;
}

function dayNumber(d) {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
}

/**
 * Tick times in [from, to] aligned to local time: sub-hour steps by arithmetic on local time,
 * hours and larger by stepping a local Date so ticks stay on hour, midnight, month and year
 * boundaries across DST changes.
 */
export function tickTimes(from, to, step) {
  const out = [];
  if (!(to >= from)) return out;
  if (step.unit === 'us' || step.unit === 'ms' || step.unit === 's' || step.unit === 'min') {
    const off = tzOffsetUs(from);
    for (let t = Math.ceil((from + off) / step.us) * step.us - off; t <= to && out.length < MAX_TICKS; t += step.us) out.push(t);
    return out;
  }
  const n = step.n;
  const d = new Date(Math.floor(from / MS));
  if (step.unit === 'h') {
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() - (d.getHours() % n));
  } else if (step.unit === 'd') {
    d.setHours(0, 0, 0, 0);
    while (dayNumber(d) % n) d.setDate(d.getDate() - 1);
  } else if (step.unit === 'mo') {
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    d.setMonth(d.getMonth() - ((d.getFullYear() * 12 + d.getMonth()) % n));
  } else {
    d.setHours(0, 0, 0, 0);
    d.setMonth(0, 1);
    d.setFullYear(d.getFullYear() - (d.getFullYear() % n));
  }
  let prev = -Infinity;
  for (let guard = 0; guard < 2 * MAX_TICKS && out.length < MAX_TICKS; guard++) {
    const t = d.getTime() * MS;
    if (t > to) break;
    if (t >= from && t > prev) out.push(t);
    prev = t;
    if (step.unit === 'h') d.setHours(d.getHours() + n);
    else if (step.unit === 'd') d.setDate(d.getDate() + n);
    else if (step.unit === 'mo') d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
  }
  return out;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (v) => String(v).padStart(2, '0');

/**
 * Local-time tick label. `major` marks a boundary of the next larger unit (midnight, whole
 * second, ...). Sub-second ticks show only the fraction; whole seconds show the clock time.
 */
export function formatTick(t, step) {
  const d = new Date(Math.floor(t / MS));
  const sub = ((t % S) + S) % S;
  const hhmm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const date = `${MON[d.getMonth()]} ${d.getDate()}`;
  switch (step.unit) {
    case 'y':
      return { text: String(d.getFullYear()), major: false };
    case 'mo':
      return d.getMonth() === 0 ? { text: String(d.getFullYear()), major: true } : { text: MON[d.getMonth()], major: false };
    case 'd':
      return { text: date, major: d.getDate() === 1 };
    case 'h':
    case 'min':
      return hhmm === '00:00' && d.getSeconds() === 0 && sub === 0 ? { text: date, major: true } : { text: hhmm, major: false };
    case 's':
      return { text: `${hhmm}:${p2(d.getSeconds())}`, major: d.getSeconds() === 0 };
    default: {
      if (sub === 0) return { text: `${hhmm}:${p2(d.getSeconds())}`, major: true };
      const frac = step.unit === 'ms' || sub % MS === 0 ? String(Math.floor(sub / MS)).padStart(3, '0') : String(sub).padStart(6, '0');
      return { text: '.' + frac, major: false };
    }
  }
}

/** Context for the left end of the axis: the parts of the time the tick labels leave out. */
export function formatContext(t, step) {
  const d = new Date(Math.floor(t / MS));
  if (step.us >= D) return String(d.getFullYear());
  const day = `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
  if (step.us >= S) return day;
  return `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * Ticks for the visible part of `scale`, generated per uncollapsed segment. A segment that
 * starts after a break gets an extra `edge` tick at its start when no regular tick is close,
 * so every stretch of the axis carries a time reference.
 * @returns {{ step: object, context: string, ticks: {t: number, x: number, text: string, major: boolean, edge?: boolean}[] }}
 */
export function generateTicks(scale, width, minPx = 80) {
  const step = pickStep(scale.k, minPx);
  const from = scale.t(0);
  const to = scale.t(width);
  const ticks = [];
  for (const seg of scale.segments(from, to)) {
    const times = tickTimes(seg.start, seg.end, step);
    if (seg.start > from && !(times.length && scale.x(times[0]) - scale.x(seg.start) < minPx / 2)) {
      ticks.push({ t: seg.start, x: scale.x(seg.start), ...formatTick(seg.start, step), edge: true });
    }
    for (const t of times) ticks.push({ t, x: scale.x(t), ...formatTick(t, step) });
  }
  return { step, context: formatContext(from, step), ticks };
}

/**
 * The time range an overview should open on: the last `recentUs` when anything started in it,
 * otherwise the range holding the latest `share` of starts (dropping the oldest outliers).
 * Returns [from, to] or null when nothing has a start.
 */
export function focusRange(items, now, { recentUs = 30 * 86_400e6, share = 0.95 } = {}) {
  const starts = [];
  let end = -Infinity;
  for (const it of items) {
    if (!Number.isFinite(it?.start)) continue;
    starts.push(it.start);
    end = Math.max(end, Number.isFinite(it.end) ? it.end : it.start);
  }
  if (!starts.length) return null;
  starts.sort((a, b) => a - b);
  const last = starts[starts.length - 1];
  if (last >= now - recentUs) return [Math.max(starts[0], Math.min(now, end) - recentUs), Math.max(end, last + 1000)];
  const from = starts[Math.min(starts.length - 1, Math.floor(starts.length * (1 - share)))];
  return [from, Math.max(end, from + 1000)];
}

/** Gaps worth collapsing in a range: at least 5% of it, and never under GAP_MIN_US. */
export function gapThreshold(spanUs, share = 0.05) {
  return Math.max(GAP_MIN_US, Number.isFinite(spanUs) ? spanUs * share : 0);
}
