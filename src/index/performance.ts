// Statistics ▸ Performance (SPEC §6): shared SQL expressions for its call samples and I/O graph metrics (`sp` is an
// llm span), the per-call summaries, and Performance over time. Rates cover the whole call, including waiting;
// timestamp gaps are estimates, not decode throughput.

import { TIME_BUCKETS, type TimeBucketName } from '../model/types.ts';
import type { PerformanceBin, PerformanceStat, PerformanceTimeline } from './api.ts';

const ttft = "json_extract(sp.attrs, '$.llm.ttft_ms')";
const output = "json_extract(sp.attrs, '$.tokens.output')";
const numeric = (path: string, value: string) =>
  `json_type(sp.attrs, '${path}') IN ('integer', 'real') AND ${value} >= 0 AND ${value} <= 9007199254740991`;

/** Completed calls only; zero is a valid latency but cannot be a rate's denominator. */
export const CALL_LATENCY = `CASE WHEN sp.status <> 'open' AND sp.dur >= 0 AND sp.dur <= 9007199254740991 THEN sp.dur END`;
/** Milliseconds in the source, whole microseconds in the API. Missing or inconsistent timing stays missing. */
export const CALL_TTFT = `CASE WHEN ${numeric('$.llm.ttft_ms', ttft)}
  AND ${ttft} * 1000 <= 9007199254740991
  AND (sp.dur IS NULL OR sp.status = 'open' OR ${ttft} * 1000 <= sp.dur)
  THEN round(${ttft} * 1000) END`;
export const CALL_OUTPUT_RATE = `CASE WHEN (${CALL_LATENCY}) > 0 AND ${numeric('$.tokens.output', output)}
  THEN ${output} * 1000000.0 / sp.dur END`;

const input = "json_extract(sp.attrs, '$.tokens.input')";
const read = "json_extract(sp.attrs, '$.tokens.cache_read')";
/** Valid inclusive input tokens of a call (its prompt size). */
export const CALL_INPUT = `CASE WHEN ${numeric('$.tokens.input', input)} THEN ${input} END`;
/** Adapters normalize input to include cache reads and writes. Missing cache counts are not misses. */
const cacheValid = `${numeric('$.tokens.input', input)} AND ${input} > 0
  AND ${numeric('$.tokens.cache_read', read)} AND ${read} <= ${input}`;
export const CACHE_INPUT = `CASE WHEN ${cacheValid} THEN ${input} END`;
export const CACHE_READ = `CASE WHEN ${cacheValid} THEN ${read} END`;

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], p: number): number | null {
  return sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
}

/** One model call; each metric is null where the call has no valid value. */
export interface CallSample {
  start: number | null;
  latency: number | null;
  ttft: number | null;
  rate: number | null;
  /** The duration is estimated from timestamps, not logged. */
  estimated: boolean;
  cacheInput: number | null;
  cacheRead: number | null;
  input: number | null;
  failed: boolean;
}

/** The samples of a set of calls (a model, every call, or one bin), summarized as percentiles with their coverage. */
export class CallStats {
  calls = 0;
  failed = 0;
  private latency: number[] = [];
  private ttft: number[] = [];
  private rate: number[] = [];
  private input: number[] = [];
  private latencyEstimated = 0;
  private rateEstimated = 0;
  private cacheKnown = 0;
  private cacheInput = 0;
  private cacheRead = 0;

  add(s: CallSample): void {
    this.calls++;
    if (s.failed) this.failed++;
    if (s.latency != null) {
      this.latency.push(s.latency);
      if (s.estimated) this.latencyEstimated++;
    }
    if (s.ttft != null) this.ttft.push(s.ttft);
    if (s.rate != null && Number.isFinite(s.rate)) {
      this.rate.push(s.rate);
      if (s.estimated) this.rateEstimated++;
    }
    if (s.input != null) this.input.push(s.input);
    if (s.cacheInput != null && s.cacheRead != null) {
      this.cacheKnown++;
      this.cacheInput += s.cacheInput;
      this.cacheRead += s.cacheRead;
    }
  }

  private sorted(): void {
    for (const a of [this.latency, this.ttft, this.rate, this.input]) a.sort((x, y) => x - y);
  }

  get cacheHitRatio(): number | null {
    return this.cacheInput > 0 ? this.cacheRead / this.cacheInput : null;
  }

  stat(model: string): PerformanceStat {
    this.sorted();
    return {
      model, calls: this.calls, latencyKnown: this.latency.length, latencyEstimated: this.latencyEstimated,
      latencyP50: percentile(this.latency, 50), latencyP90: percentile(this.latency, 90),
      ttftKnown: this.ttft.length, ttftP50: percentile(this.ttft, 50), ttftP90: percentile(this.ttft, 90),
      outputRateKnown: this.rate.length, outputRateEstimated: this.rateEstimated,
      outputRateP50: percentile(this.rate, 50), outputRateP10: percentile(this.rate, 10),
      cacheKnown: this.cacheKnown, cacheHitRatio: this.cacheHitRatio,
    };
  }

  /** The call fields of a Performance over time bin. */
  bin(): Omit<PerformanceBin, 't' | 'busy' | 'tools' | 'failed'> {
    this.sorted();
    return {
      calls: this.calls,
      latencyP50: percentile(this.latency, 50), latencyP90: percentile(this.latency, 90),
      ttftP50: percentile(this.ttft, 50), ttftP90: percentile(this.ttft, 90),
      rateP50: percentile(this.rate, 50), rateP10: percentile(this.rate, 10),
      cacheHitRatio: this.cacheHitRatio, inputP50: percentile(this.input, 50),
    };
  }
}

// ---------------------------------------------------------------------------
// Performance over time

/** A completed span of one session, µs, with the time bucket it belongs to. */
export interface BusyInterval {
  session: string;
  start: number;
  end: number;
  bucket: TimeBucketName;
}

/** A tool call's start. */
export interface ToolStart {
  start: number;
  failed: boolean;
}

const SEC = 1e6;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** Bin widths, smallest first. */
export const BIN_WIDTHS = [
  ...[1, 2, 5, 10, 15, 30].map((n) => n * SEC),
  ...[1, 2, 5, 10, 15, 30].map((n) => n * MIN),
  ...[1, 3, 6, 12, 24].map((n) => n * HOUR),
];
export const TARGET_BINS = 120;
/** Idle gaps at least this long, and at least three bins, collapse; at most MAX_BREAKS of them, the longest. */
export const GAP_MIN_US = 5 * MIN;
export const MAX_BREAKS = 40;

type Run = [start: number, end: number];

/** Segments aligned outward to multiples of `w`; segments that touch after alignment merge. Ends are exclusive. */
function align(runs: Run[], w: number): Run[] {
  const out: Run[] = [];
  for (const [a, b] of runs) {
    const s = Math.floor(a / w) * w;
    const e = (Math.floor((b - 1) / w) + 1) * w;
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const binCount = (segments: Run[], w: number) => segments.reduce((n, [s, e]) => n + (e - s) / w, 0);

/**
 * Busy segments, bins and busy time by bucket (SPEC §6 Performance over time). Intervals and starts must already be
 * clipped to the view's time range. Each session's time goes to one bucket per instant, in TIME_BUCKETS priority.
 */
export function performanceTimeline(intervals: BusyInterval[], calls: CallSample[], tools: ToolStart[]): PerformanceTimeline {
  // Ends are exclusive, so an instant (a call's start) covers its own microsecond.
  const marks: Run[] = intervals.map((iv) => [iv.start, Math.max(iv.end, iv.start + 1)]);
  for (const c of calls) if (c.start != null) marks.push([c.start, c.start + 1]);
  for (const t of tools) marks.push([t.start, t.start + 1]);
  if (!marks.length) return { binUs: BIN_WIDTHS[0], segments: [], bins: [], busy: {} };
  marks.sort((x, y) => x[0] - y[0]);
  // Runs: activity joined across gaps shorter than GAP_MIN_US. Their gaps are the candidates to collapse.
  const runs: Run[] = [];
  for (const [a, b] of marks) {
    const last = runs.at(-1);
    if (last && a - last[1] < GAP_MIN_US) last[1] = Math.max(last[1], b);
    else runs.push([a, b]);
  }
  // A wider bin collapses fewer gaps, which may need a wider bin again: widen until the width holds.
  let binUs = BIN_WIDTHS[0];
  let segments: Run[] = [];
  for (let i = 0; i <= BIN_WIDTHS.length; i++) {
    const cut = new Set(runs.slice(1).map((r, j) => ({ j: j + 1, len: r[0] - runs[j][1] }))
      .filter((g) => g.len >= Math.max(GAP_MIN_US, 3 * binUs))
      .sort((x, y) => y.len - x.len || x.j - y.j).slice(0, MAX_BREAKS).map((g) => g.j));
    const merged: Run[] = [];
    runs.forEach(([a, b], j) => {
      const last = merged.at(-1);
      if (last && !cut.has(j)) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    });
    const next = BIN_WIDTHS.find((w) => w >= binUs && binCount(align(merged, w), w) <= TARGET_BINS) ?? BIN_WIDTHS.at(-1)!;
    segments = align(merged, next);
    if (next === binUs) break;
    binUs = next;
  }

  // Dense bins per segment; `base[k]` is the index of segment k's first bin.
  const base: number[] = [];
  const starts: number[] = [];
  for (const [s, e] of segments) {
    base.push(starts.length);
    for (let t = s; t < e; t += binUs) starts.push(t);
  }
  const binAt = (t: number): number => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < segments[mid][0]) hi = mid - 1;
      else if (t >= segments[mid][1]) lo = mid + 1;
      else return base[mid] + Math.floor((t - segments[mid][0]) / binUs);
    }
    return -1;
  };

  // Busy time: per session, the highest-priority open bucket claims each instant; the pieces fill the bins they cover.
  const busy = starts.map(() => new Array<number>(TIME_BUCKETS.length).fill(0));
  const rank = new Map<TimeBucketName, number>(TIME_BUCKETS.map((b, i) => [b, i]));
  const bySession = new Map<string, BusyInterval[]>();
  for (const iv of intervals) {
    if (iv.end <= iv.start) continue;
    const list = bySession.get(iv.session);
    if (list) list.push(iv);
    else bySession.set(iv.session, [iv]);
  }
  const addPiece = (a: number, b: number, bucket: number) => {
    for (let i = binAt(a); i >= 0 && i < starts.length && starts[i] < b; i++) {
      busy[i][bucket] += Math.min(b, starts[i] + binUs) - Math.max(a, starts[i]);
    }
  };
  for (const list of bySession.values()) {
    const points: [t: number, delta: number, bucket: number][] = [];
    for (const iv of list) {
      const k = rank.get(iv.bucket)!;
      points.push([iv.start, 1, k], [iv.end, -1, k]);
    }
    points.sort((x, y) => x[0] - y[0]);
    const open = new Array<number>(TIME_BUCKETS.length).fill(0);
    let prev = points[0][0];
    for (const [t, delta, k] of points) {
      if (t > prev) {
        const top = open.findIndex((n) => n > 0);
        if (top >= 0) addPiece(prev, t, top);
        prev = t;
      }
      open[k] += delta;
    }
  }

  const perBin = starts.map(() => new CallStats());
  const toolCounts = starts.map(() => ({ tools: 0, failed: 0 }));
  for (const c of calls) {
    const i = c.start == null ? -1 : binAt(c.start);
    if (i >= 0) perBin[i].add(c);
  }
  for (const t of tools) {
    const i = binAt(t.start);
    if (i < 0) continue;
    toolCounts[i].tools++;
    if (t.failed) toolCounts[i].failed++;
  }
  const byName = (us: number[]) => {
    const out: Partial<Record<TimeBucketName, number>> = {};
    us.forEach((v, k) => { if (v > 0) out[TIME_BUCKETS[k]] = v; });
    return out;
  };
  const total = new Array<number>(TIME_BUCKETS.length).fill(0);
  for (const us of busy) us.forEach((v, k) => { total[k] += v; });
  return {
    binUs,
    segments: segments.map(([start, end]) => ({ start, end })),
    bins: starts.map((t, i) => ({
      t, busy: byName(busy[i]), ...perBin[i].bin(), tools: toolCounts[i].tools, failed: perBin[i].failed + toolCounts[i].failed,
    })),
    busy: byName(total),
  };
}
