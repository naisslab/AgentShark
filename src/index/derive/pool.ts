// Derives trees in worker threads for long passes (a rebuild, --rederive): each worker opens the index read-only,
// loads and derives the trees it claims, and posts their rows; the caller writes them. Synchronous for the caller:
// results are read with receiveMessageOnPort while Atomics.wait sleeps between them.

import { availableParallelism } from 'node:os';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import type {
  AlarmRow, AlarmThresholds, ChangeRow, ClaimRow, DelegationRow, EpisodeAttemptRow, EpisodeRow, FailureRow, InterventionRow, ProcessEventRow, ProcessRow,
  SessionRollupRow, StepEventRow, StepRow, TurnRollupRow,
} from '../../model/types.ts';
import type { CallKeyRow, CallStatRow, Derived, SessionStatRow, SigInfo } from './model.ts';
import type { Unit } from './plan.ts';

/** Everything derive/write.ts stores for one tree (its sessions derived in the pass), as plain data (what a worker posts). */
export interface TreeRows {
  root: string;
  /** The sessions derived: their old rows are replaced. */
  sessions: string[];
  steps: StepRow[];
  stepEvents: StepEventRow[];
  failures: FailureRow[];
  episodes: EpisodeRow[];
  attempts: EpisodeAttemptRow[];
  turnRollup: TurnRollupRow[];
  sessionRollup: SessionRollupRow[];
  delegations: DelegationRow[];
  processes: ProcessRow[];
  processEvents: ProcessEventRow[];
  changes: ChangeRow[];
  interventions: InterventionRow[];
  claims: ClaimRow[];
  alarms: AlarmRow[];
  callStats: CallStatRow[];
  callKeys: CallKeyRow[];
  sessionStats: SessionStatRow[];
  sigs: [string, SigInfo][];
}

export type TreeOutcome = TreeRows | { root: string; error: string };

export function treeRows(d: Derived): TreeRows {
  return {
    root: d.tree.rootId, sessions: d.tree.sessions.map((s) => s.id), steps: d.steps, stepEvents: d.stepEvents, failures: d.failures,
    episodes: d.episodes, attempts: d.attempts, turnRollup: d.turnRollup, sessionRollup: d.sessionRollup, delegations: d.delegations,
    processes: d.processes, processEvents: d.processEvents, changes: d.changes, interventions: d.interventions, claims: d.claims, alarms: d.alarms,
    callStats: d.callStats, callKeys: d.callKeys, sessionStats: d.sessionStats, sigs: [...d.sigs],
  };
}

/**
 * Passes with fewer trees derive in-process: starting workers costs more than it saves. From a few trees on, even one
 * worker pays: it derives while this thread writes (a stage of a cold run derives 10 to 30 large trees).
 */
export const POOL_MIN_TREES = 8;
/** A pool that posts nothing for this long has lost a worker. */
const STALL_MS = 300_000;

export function poolSize(trees: number): number {
  return Math.max(1, Math.min(availableParallelism() - 2, 8, Math.ceil(trees / 16)));
}

/**
 * Derive `units` in `workers` threads, yielding each unit's rows (or error) as it arrives. Closing the generator early
 * (a budget) stops the workers; units not yielded by then were not derived.
 */
export function* derivePooled(path: string, units: Unit[], workers: number, thresholds: AlarmThresholds): Generator<TreeOutcome, void, void> {
  // [0] next unit index to claim, [1] stop flag, [2] messages posted (Atomics.wait target).
  const shared = new Int32Array(new SharedArrayBuffer(12));
  const ports: MessagePort[] = [];
  const pool: Worker[] = [];
  let done = 0;
  try {
    for (let i = 0; i < workers; i++) {
      const { port1, port2 } = new MessageChannel();
      const worker = new Worker(new URL('./worker.ts', import.meta.url), {
        workerData: { agentsharkDeriveWorker: true, path, units, thresholds, shared, port: port2 }, transferList: [port2],
      });
      // A worker that dies (out of memory) posts nothing, and this loop ends at STALL_MS. Its 'error' event arrives
      // only after this synchronous loop returns; without a listener it would crash the thread that ran the pass.
      worker.on('error', () => {});
      pool.push(worker);
      ports.push(port1);
    }
    let last = Date.now();
    while (done < workers) {
      const posted = Atomics.load(shared, 2);
      let got = false;
      for (const port of ports) {
        for (let m = receiveMessageOnPort(port); m; m = receiveMessageOnPort(port)) {
          got = true;
          const msg = m.message as { type: 'tree'; outcome: TreeOutcome } | { type: 'done' } | { type: 'fatal'; error: string };
          if (msg.type === 'done') done++;
          else if (msg.type === 'fatal') throw new Error(`analysis worker failed: ${msg.error}`);
          else yield msg.outcome;
        }
      }
      if (got) last = Date.now();
      else if (Date.now() - last > STALL_MS) throw new Error('analysis workers stopped responding');
      else Atomics.wait(shared, 2, posted, 1000);
    }
  } finally {
    Atomics.store(shared, 1, 1);
    for (const w of pool) void w.terminate();
  }
}
