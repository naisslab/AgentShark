// Replay loop (docs/REPLAY.md §5, §7.2): batches in order, recorded waits scaled by the speed, calls of one batch
// concurrently, one result record per call.

import { setTimeout as sleep } from 'node:timers/promises';
import { verdictOf, type OutputDiff, type Verdict } from './compare.ts';
import { DockerError } from './executor.ts';
import { batchesOf, type CallClass, type PlannedCall, type ReplayPlan } from './plan.ts';
import { callTimeoutMs, execute, type Sandbox } from './tools.ts';

export interface Pacing {
  /** 1 keeps recorded waits; 2 halves them; 'max' inserts none. */
  speed: number | 'max';
  /** Upper bound on any single inserted wait, ms. */
  maxGapMs: number | null;
}

export interface CallOutcome {
  type: 'call';
  n: number;
  event: string;
  session: string;
  tool: string;
  class: CallClass;
  summary: string;
  /** Replay clock when the call started, ms. */
  startedMs: number;
  recorded: { ok: boolean; exitCode: number | null; durMs: number; outputLen: number | null } | null;
  replayed: {
    ok: boolean; exitCode: number | null; durMs: number; timedOut: boolean;
    stdoutLen: number; stderrLen: number; stdoutHead: string; stderrHead: string;
  } | null;
  verdict: Verdict;
  /** The skip reason, or the replayer's error message. */
  reason?: string;
  diff?: OutputDiff;
}

export interface Summary {
  type: 'summary';
  counts: Partial<Record<Verdict, number>>;
  /** Number of the first call whose status differs. */
  firstDivergence: number | null;
  wallMs: number;
  interrupted: boolean;
}

const HEAD_MAX = 4096;

/** The wait inserted for a recorded interval, ms. */
export function waitMs(us: number, p: Pacing): number {
  if (p.speed === 'max' || us <= 0) return 0;
  const ms = us / 1000 / p.speed;
  return p.maxGapMs === null ? ms : Math.min(ms, p.maxGapMs);
}

/** `--timeout` when none is given: the longest one call may run. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Projected wall time (§5): inserted waits plus the recorded durations of awaited calls, each capped at the timeout it
 * would run under. Background calls are not awaited.
 */
export function projectMs(plan: ReplayPlan, p: Pacing, maxTimeoutMs = DEFAULT_TIMEOUT_MS): number {
  const runMs = (c: PlannedCall) => {
    const a = c.action;
    if (a.cls === 'skip') return waitMs(c.holdUs, p);
    if (a.cls === 'shell-bg') return 0;
    return Math.min((c.recorded?.durUs ?? 0) / 1000, callTimeoutMs(a, maxTimeoutMs));
  };
  let total = 0;
  for (const batch of batchesOf(plan.calls)) total += waitMs(batch[0].gapUs, p) + Math.max(0, ...batch.map(runMs));
  return total;
}

/** Runs the plan's batches in order. A lost container (DockerError) ends the replay; other failures mark one call. */
export async function runReplay(
  plan: ReplayPlan, sb: Sandbox, p: Pacing, onCall: (o: CallOutcome) => void | Promise<void>, signal?: AbortSignal,
): Promise<Summary> {
  const t0 = performance.now();
  const clock = () => performance.now() - t0;
  const counts: Summary['counts'] = {};
  let firstDivergence: number | null = null;
  const pause = async (ms: number) => {
    if (ms > 0) await sleep(ms, undefined, { signal }).catch(() => {});
  };

  const one = async (c: PlannedCall): Promise<CallOutcome> => {
    const base = {
      type: 'call' as const, n: c.n, event: c.event, session: c.session, tool: c.tool, class: c.action.cls, summary: c.summary,
      startedMs: Math.round(clock()),
      recorded: c.recorded && { ok: c.recorded.ok, exitCode: c.recorded.exitCode, durMs: c.recorded.durUs / 1000, outputLen: c.recorded.outputLen },
    };
    if (c.action.cls === 'skip') {
      await pause(waitMs(c.holdUs, p));
      return { ...base, replayed: null, verdict: 'skipped', reason: c.action.reason };
    }
    let r;
    try {
      r = await execute(c.action, c.session, sb);
    } catch (e) {
      if (e instanceof DockerError) throw e;
      return { ...base, replayed: null, verdict: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
    const replayed = {
      ok: r.ok, exitCode: r.exitCode, durMs: Math.round(r.durMs), timedOut: r.timedOut,
      stdoutLen: r.stdout.length, stderrLen: r.stderr.length, stdoutHead: r.stdout.slice(0, HEAD_MAX), stderrHead: r.stderr.slice(0, HEAD_MAX),
    };
    if (c.action.cls === 'shell-bg') return { ...base, replayed, verdict: 'started' };
    const output = [r.stdout.replace(/\n$/, ''), r.stderr.replace(/\n$/, '')].filter(Boolean).join('\n');
    const { verdict, diff } = verdictOf(c.action.cls, c.recorded, r, output, r.dropped === 0);
    return { ...base, replayed, verdict, ...(diff && { diff }) };
  };

  for (const [i, batch] of batchesOf(plan.calls).entries()) {
    if (signal?.aborted) break;
    if (i > 0) await pause(waitMs(batch[0].gapUs, p));
    if (signal?.aborted) break;
    const outcomes = await Promise.all(batch.map(one));
    for (const o of outcomes) {
      counts[o.verdict] = (counts[o.verdict] ?? 0) + 1;
      if (o.verdict === 'status' && firstDivergence === null) firstDivergence = o.n;
      await onCall(o);
    }
  }
  return { type: 'summary', counts, firstDivergence, wallMs: Math.round(clock()), interrupted: signal?.aborted === true };
}
