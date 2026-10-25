// Worker entry: run one adapter over one source file and stream its records back, events and spans already serialized
// for the writer (toWire, SPEC §5.1). The indexer also calls parseFile() in-process when it runs without workers.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { sourceId, type DiscoverEnv, type SourceFile, type ParseStats } from '../adapters/adapter.ts';
import { adapterByName } from '../adapters/registry.ts';
import type { IndexRecord } from '../model/types.ts';
import { toWire, type WriterRecord } from './writer.ts';

/** Records per message posted to the main thread. */
export const BATCH_SIZE = 2000;
/** Batches a worker may post before the main thread has written them; bounds the message queue. */
export const MAX_UNACKED = 4;

export type WorkerRequest = { type: 'parse'; job: number; file: SourceFile; env?: DiscoverEnv };
export type WorkerReply =
  | { type: 'batch'; job: number; records: WriterRecord[] }
  | { type: 'done'; job: number; stats: ParseStats; parseMs: number }
  | { type: 'error'; job: number; error: string; parseMs: number };

export async function parseFile(
  file: SourceFile,
  onBatch: (records: IndexRecord[]) => void,
  env?: DiscoverEnv,
): Promise<{ stats: ParseStats; parseMs: number }> {
  const t0 = performance.now();
  let batch: IndexRecord[] = [];
  const stats = await adapterByName(file.adapter).parse(
    { sourceId: sourceId(file.path), file, env },
    {
      emit(rec) {
        batch.push(rec);
        if (batch.length >= BATCH_SIZE) {
          onBatch(batch);
          batch = [];
        }
      },
    },
  );
  if (batch.length) onBatch(batch);
  return { stats, parseMs: performance.now() - t0 };
}

if (!isMainThread && parentPort && workerData?.agentsharkIndexWorker) {
  const port = parentPort;
  // Count of batches the main thread has written; it increments and notifies after each one.
  const acked = new Int32Array(workerData.acked as SharedArrayBuffer);
  let posted = 0;
  /** Returns the milliseconds spent waiting for the main thread. */
  const postBatch = (job: number, records: IndexRecord[]): number => {
    port.postMessage({ type: 'batch', job, records: records.map(toWire) } satisfies WorkerReply);
    posted++;
    const t0 = performance.now();
    // Adapters emit synchronously, so the only way to pause them is to block this thread.
    for (let seen = Atomics.load(acked, 0); posted - seen > MAX_UNACKED; seen = Atomics.load(acked, 0)) {
      Atomics.wait(acked, 0, seen, 1000);
    }
    return performance.now() - t0;
  };
  port.on('message', async (msg: WorkerRequest) => {
    const t0 = performance.now();
    const reply = (r: WorkerReply) => port.postMessage(r);
    let waited = 0;
    try {
      const { stats, parseMs } = await parseFile(msg.file, (records) => (waited += postBatch(msg.job, records)), msg.env);
      reply({ type: 'done', job: msg.job, stats, parseMs: parseMs - waited });
    } catch (err) {
      reply({ type: 'error', job: msg.job, error: String((err as Error)?.message ?? err), parseMs: performance.now() - t0 });
    }
  });
}
