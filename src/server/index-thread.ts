// The index writer of a live server, in a thread of its own (SPEC §5.1): parsing, writing, linking and the analysis pass
// never run on the HTTP thread, so the API keeps answering while a run is in flight. The thread owns the process's only
// writable connection, and the process that starts it holds the index's writer lock. An index of another schema stays
// in place for its readers while the new one builds beside it; the first complete run promotes the new one.

import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { DiscoverEnv, SourceFile } from '../adapters/adapter.ts';
import type { AnalysisStatus } from '../index/api.ts';
import type { IndexProgress, IndexRunResult } from '../index/indexer.ts';
import type { AlarmThresholds } from '../model/types.ts';

interface ThreadData {
  agentsharkIndexThread: true;
  indexPath: string;
  env?: DiscoverEnv;
}

type Request =
  | { type: 'run'; id: number; budgetMs?: number; sources?: SourceFile[] }
  | { type: 'thresholds'; id: number; t: Partial<AlarmThresholds> }
  | { type: 'close' };

type Reply =
  | { type: 'ready' }
  | { type: 'progress'; p: IndexProgress }
  | { type: 'stage' }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; error: ThreadError };

/** What survives the thread boundary of an error: enough for `isBusy` (name, errcode) and the message. */
interface ThreadError {
  message: string;
  name?: string;
  errcode?: number;
}

export class IndexThread {
  private worker: Worker;
  private nextId = 0;
  private calls = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  private onProgress: ((p: IndexProgress) => void) | null = null;
  private onStage: (() => void) | null = null;
  private exited: Promise<void>;

  private constructor(worker: Worker) {
    this.worker = worker;
    this.exited = new Promise((done) => worker.once('exit', () => done()));
    worker.on('message', (m: Reply) => {
      if (m.type === 'progress') return this.onProgress?.(m.p);
      if (m.type === 'stage') return this.onStage?.();
      if (m.type === 'ready') return;
      const call = this.calls.get(m.id);
      this.calls.delete(m.id);
      if (m.type === 'result') call?.resolve(m.value);
      else call?.reject(Object.assign(new Error(m.error.message), m.error));
    });
    worker.on('exit', () => {
      for (const c of this.calls.values()) c.reject(new Error('the index thread stopped'));
      this.calls.clear();
    });
  }

  /** Start the thread and open the index; rejects when it cannot be opened (another program's file, a disk error). */
  static async start(indexPath: string, env?: DiscoverEnv): Promise<IndexThread> {
    const worker = new Worker(new URL(import.meta.url), { workerData: { agentsharkIndexThread: true, indexPath, env } satisfies ThreadData });
    await new Promise<void>((resolve, reject) => {
      worker.once('message', (m: Reply) => (m.type === 'ready' ? resolve() : reject(new Error('index thread failed to start'))));
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`index thread exited (${code})`)));
    });
    return new IndexThread(worker);
  }

  /**
   * One index run (single-flight is the caller's job); `onStage` follows each stage's stored record. While the new
   * schema builds, the run derives everything and promotes.
   */
  run(onProgress: (p: IndexProgress) => void, budgetMs?: number, onStage?: () => void, sources?: SourceFile[]): Promise<IndexRunResult> {
    this.onProgress = onProgress;
    this.onStage = onStage ?? null;
    return this.call<IndexRunResult>({ type: 'run', id: ++this.nextId, budgetMs, sources }).finally(() => {
      this.onProgress = null;
      this.onStage = null;
    });
  }

  storeThresholds(t: Partial<AlarmThresholds>): Promise<AnalysisStatus> {
    return this.call({ type: 'thresholds', id: ++this.nextId, t });
  }

  /** Close the connection and end the thread; a run in flight finishes first. */
  async close(): Promise<void> {
    this.worker.postMessage({ type: 'close' } satisfies Request);
    await this.exited;
  }

  private call<T>(m: Exclude<Request, { type: 'close' }>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.calls.set(m.id, { resolve, reject });
      this.worker.postMessage(m);
    });
  }
}

if (!isMainThread && parentPort && (workerData as ThreadData | undefined)?.agentsharkIndexThread) {
  const port = parentPort;
  const data = workerData as ThreadData;
  const [{ nextIndexPath, openIndex, promoteIndex }, { runIndex, storeAlarmThresholds }, { analysisStatus }] = await Promise.all([
    import('../index/db.ts'), import('../index/indexer.ts'), import('../index/derive.ts'),
  ]);
  let db = openIndex(data.indexPath, { rebuild: 'beside' });
  const send = (r: Reply) => port.postMessage(r);
  // Requests run one at a time, in order: a close waits for the run in flight.
  let queue = Promise.resolve();
  port.on('message', (m: Request) => {
    queue = queue.then(async () => {
      if (m.type === 'close') {
        db.close();
        port.close();
        return;
      }
      try {
        if (m.type === 'thresholds') {
          storeAlarmThresholds(db, m.t, true);
          return send({ type: 'result', id: m.id, value: analysisStatus(db) });
        }
        const building = !!db.location()?.endsWith(nextIndexPath(''));
        const result = await runIndex(db, {
          env: data.env, lockHeld: true, sources: m.sources, onProgress: (p) => send({ type: 'progress', p }), onStage: () => send({ type: 'stage' }),
          // The new index replaces the old one complete: no analysis is left pending for later runs.
          analysisBudgetMs: building ? undefined : m.budgetMs,
        });
        if (building) db = promoteIndex(db, data.indexPath);
        send({ type: 'result', id: m.id, value: result });
      } catch (err) {
        const e = err as ThreadError;
        send({ type: 'error', id: m.id, error: { message: String(e?.message ?? err), name: e?.name, errcode: e?.errcode } });
      }
    });
  });
  send({ type: 'ready' });
}
