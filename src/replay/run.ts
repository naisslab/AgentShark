// Replay loop (docs/REPLAY.md §5, §7.2): batches in order, recorded waits scaled by the speed, calls of one batch
// concurrently, one result record per call. Between batches a replay can pause, step or stop (§5.1), and a stopped
// replay leaves a state in its container that a later run resumes (§5.2).

import { setTimeout as sleep } from 'node:timers/promises';
import { tryJson } from '../adapters/adapter.ts';
import { verdictOf, type OutputDiff, type Verdict } from './compare.ts';
import { DockerError, type Executor } from './executor.ts';
import { batchesOf, PlanError, type CallClass, type PlannedCall, type ReplayPlan } from './plan.ts';
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
  /** The replay ended before this call, which a resume runs first. */
  stoppedBefore: number | null;
  /** The replay stopped at a pause after its last batch, so that its final state can be kept. */
  stoppedAtEnd: boolean;
}

/** Where a replay pauses (§5.1). */
export interface Breaks {
  /** Before the batch that contains one of these calls. */
  calls: Set<number>;
  /** After a batch in which a call got one of these verdicts. */
  verdicts: Set<Verdict>;
}

/** Why a replay paused before a batch. */
export type PauseReason =
  | { kind: 'call'; n: number }
  | { kind: 'verdict'; verdict: Verdict; n: number }
  | { kind: 'step' }
  | { kind: 'request' };

/** After a pause: run on with the recorded pacing, run one batch at once and pause again, or stop before the batch. */
export type Resume = 'continue' | 'step' | 'stop';

/** How a replay is driven between batches. A terminal maps keys onto it; without one, every pause stops the replay. */
export interface Control {
  /** Paused before `next`, the first call of the next batch, or after the last batch when `next` is null. */
  pause(next: PlannedCall | null, why: PauseReason): Promise<Resume>;
  /** Waits `ms`: the recorded gap before `call`'s batch, or the slot a skipped `call` holds. May end early. */
  wait(ms: number, call: PlannedCall, kind: 'gap' | 'hold', signal?: AbortSignal): Promise<void>;
  /** A pause or stop asked for while the replay ran. Reading it clears it. */
  takeRequest(): 'pause' | 'stop' | null;
  /** The batch about to run. */
  running?(batch: PlannedCall[]): void;
}

export interface RunOptions {
  /** The first call to run, which must start a batch: 1, or a resumed replay's next call. */
  from?: number;
  /** The run continues a stopped replay: a call breakpoint on its first batch is where it stopped, not a new stop. */
  resumed?: boolean;
  breaks?: Breaks;
  control?: Control;
  signal?: AbortSignal;
  /**
   * Where the loop is: between batches, before `next`, or inside a batch when `next` is null. It is told just before a
   * batch starts, so that state that holds only between batches can be dropped first.
   */
  position?(next: PlannedCall | null): void | Promise<void>;
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
 * Projected wall time (§5) of a run from call `from`: inserted waits plus the recorded durations of awaited calls, each
 * capped at the timeout it would run under. Background calls are not awaited, and nothing is waited for before the
 * first batch.
 */
export function projectMs(plan: ReplayPlan, p: Pacing, maxTimeoutMs = DEFAULT_TIMEOUT_MS, from = 1): number {
  const runMs = (c: PlannedCall) => {
    const a = c.action;
    if (a.cls === 'skip') return waitMs(c.holdUs, p);
    if (a.cls === 'shell-bg') return 0;
    return Math.min((c.recorded?.durUs ?? 0) / 1000, callTimeoutMs(a, maxTimeoutMs));
  };
  let total = 0;
  for (const [i, batch] of batchesOf(plan.calls).filter((b) => b[0].n >= from).entries()) {
    total += (i ? waitMs(batch[0].gapUs, p) : 0) + Math.max(0, ...batch.map(runMs));
  }
  return total;
}

/** Without a terminal, a pause stops the replay and waits are plain sleeps. */
const UNATTENDED: Control = {
  pause: async () => 'stop',
  wait: async (ms, _call, _kind, signal) => {
    if (ms > 0) await sleep(ms, undefined, { signal }).catch(() => {});
  },
  takeRequest: () => null,
};

/** Runs the plan's batches in order. A lost container (DockerError) ends the replay; other failures mark one call. */
export async function runReplay(
  plan: ReplayPlan, sb: Sandbox, p: Pacing, onCall: (o: CallOutcome) => void | Promise<void>, o: RunOptions = {},
): Promise<Summary> {
  const { signal, breaks, control = UNATTENDED } = o;
  const t0 = performance.now();
  const clock = () => performance.now() - t0;
  const counts: Summary['counts'] = {};
  let firstDivergence: number | null = null;
  let stoppedBefore: number | null = null;

  const one = async (c: PlannedCall, paced: boolean): Promise<CallOutcome> => {
    const base = {
      type: 'call' as const, n: c.n, event: c.event, session: c.session, tool: c.tool, class: c.action.cls, summary: c.summary,
      startedMs: Math.round(clock()),
      recorded: c.recorded && { ok: c.recorded.ok, exitCode: c.recorded.exitCode, durMs: c.recorded.durUs / 1000, outputLen: c.recorded.outputLen },
    };
    if (c.action.cls === 'skip') {
      if (paced) await control.wait(waitMs(c.holdUs, p), c, 'hold', signal);
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

  /** Between two batches: pause for `why` or for a key, then wait until `ready`. Says what to do with `next`. */
  const between = async (why: PauseReason | null, next: PlannedCall | null, ready: number): Promise<Resume> => {
    let decision: Resume = 'continue';
    for (let asked = control.takeRequest(); ;) {
      if (signal?.aborted || asked === 'stop') return 'stop';
      if (asked === 'pause') why ??= { kind: 'request' };
      if (why) decision = await control.pause(next, why);
      why = null;
      if (decision !== 'continue' || ready <= clock()) return signal?.aborted ? 'stop' : decision;
      await control.wait(ready - clock(), next!, 'gap', signal);
      asked = control.takeRequest();
      if (!asked) return signal?.aborted ? 'stop' : decision;
    }
  };

  let last: CallOutcome[] = [];
  let stepping = false;
  let stoppedAtEnd = false;
  const batches = batchesOf(plan.calls).filter((b) => b[0].n >= (o.from ?? 1));
  for (const [i, batch] of batches.entries()) {
    const next = batch[0];
    // The recorded gap runs from the end of the previous batch, so time spent paused counts toward it. A resume starts
    // where a breakpoint stopped it, so that breakpoint does not stop it again.
    const why = pauseBefore(batch, last, breaks, stepping, i === 0 && o.resumed === true);
    await o.position?.(next);
    const decision = await between(why, next, clock() + (i > 0 ? waitMs(next.gapUs, p) : 0));
    if (decision === 'stop') {
      // The batch has not started, so the sandbox holds the state before it.
      stoppedBefore = next.n;
      break;
    }
    // A step runs its batch at once: no gap before it and no holds inside it.
    stepping = decision === 'step';
    await o.position?.(null);
    control.running?.(batch);
    last = await Promise.all(batch.map((c) => one(c, !stepping)));
    for (const out of last) {
      counts[out.verdict] = (counts[out.verdict] ?? 0) + 1;
      if (out.verdict === 'status' && firstDivergence === null) firstDivergence = out.n;
      await onCall(out);
    }
  }
  // A verdict breakpoint, a step or a key can fall after the last batch: the replay then pauses once more.
  if (stoppedBefore === null && batches.length && !signal?.aborted) {
    const decision = await between(pauseBefore([], last, breaks, stepping, false), null, clock());
    // An abort there is an interruption, not a stop that keeps the final state.
    stoppedAtEnd = decision === 'stop' && !signal?.aborted;
  }
  return {
    type: 'summary', counts, firstDivergence, wallMs: Math.round(clock()), interrupted: signal?.aborted === true, stoppedBefore, stoppedAtEnd,
  };
}

function pauseBefore(
  batch: PlannedCall[], last: CallOutcome[], breaks: Breaks | undefined, stepping: boolean, resumed: boolean,
): PauseReason | null {
  // A breakpoint names itself even when a step reaches it.
  const hit = last.find((c) => breaks?.verdicts.has(c.verdict));
  if (hit) return { kind: 'verdict', verdict: hit.verdict, n: hit.n };
  const at = resumed ? undefined : batch.find((c) => breaks?.calls.has(c.n));
  if (at) return { kind: 'call', n: at.n };
  return stepping ? { kind: 'step' } : null;
}

// ---------------------------------------------------------------------------
// Resume state (§5.2)

/** What a stopped replay leaves in its container, so that a later run can continue it. */
export interface ResumeState {
  session: string;
  /** The next call to run, and its event: a resume plans the session again and checks that both still agree. */
  next: number;
  event: string;
  /** The capture file the session was read from; null for the live index. */
  capture: string | null;
  /** The `--index` the session was read from; null for the default one. */
  index: string | null;
  /** The network the replay ran on, which a run from a saved image uses unless `--network` names another. */
  network: string | null;
}

/** The resume state's file in the sandbox's state folder. */
export const RESUME_FILE = 'resume.json';
const stateFile = (ex: Executor) => `${ex.stateDir}/${RESUME_FILE}`;

export async function saveResumeState(ex: Executor, s: ResumeState): Promise<void> {
  const r = await ex.exec(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', stateFile(ex)], { stdin: JSON.stringify(s) + '\n' });
  if (r.exitCode !== 0) throw new Error(`cannot save the replay state: ${r.stderr.toString('utf8').trim() || `exit ${r.exitCode}`}`);
}

/** The state a stopped replay left, from the text of its file; null when it is not one. */
export function parseResumeState(text: string): ResumeState | null {
  const s = tryJson(text) as Partial<ResumeState> | undefined;
  if (!s || typeof s.session !== 'string' || !Number.isInteger(s.next) || typeof s.event !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return { session: s.session, next: s.next!, event: s.event, capture: str(s.capture), index: str(s.index), network: str(s.network) };
}

/** Removes the state once the replay has moved past it. */
export async function clearResumeState(ex: Executor): Promise<void> {
  await ex.exec(['rm', '-f', stateFile(ex)]);
}

/** The call a resumed replay starts at. Throws when the plan no longer holds that call where the state says. */
export function resumeAt(plan: ReplayPlan, s: ResumeState): number {
  const c = plan.calls[s.next - 1];
  if (s.session !== plan.session || !c || c.event !== s.event || plan.calls[s.next - 2]?.batch === c.batch) {
    throw new PlanError(`the index no longer matches the saved replay: call #${s.next} of ${s.session} is not the call it stopped before`);
  }
  return s.next;
}
