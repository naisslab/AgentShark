// Query worker: runs the read API (src/index/queries.ts) and the derived queries (src/index/derived-queries.ts) on
// its own read-only connection, so a slow filter or statistic never blocks the HTTP server, the event stream or the
// watch loop (see query-host.ts). Both objects share the connection, so derived queries can read the views it built.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { DerivedQueries, IndexQueries } from '../index/api.ts';
import { openIndex, READABLE_OLD_SCHEMAS } from '../index/db.ts';
import { createDerivedQueries } from '../index/derived-queries.ts';
import { createQueries } from '../index/queries.ts';
import { runWorkbench } from './workbench.ts';

export interface QueryWorkerData {
  agentsharkQueryWorker: true;
  indexPath: string;
  mode: 'live' | 'capture';
  capturePath?: string;
  /** View id prefix: names this worker, so the host routes a view's requests to the worker that holds it. */
  instance: string;
  /** Fixed clock (µs) for the derived queries: a capture's creation time. Absent: the wall clock. */
  now?: number;
}

export type QueryWorkerRequest =
  | { type: 'call'; id: number; method: keyof IndexQueries; args: unknown[] }
  | { type: 'derived'; id: number; method: keyof DerivedQueries; args: unknown[] }
  | { type: 'workbench'; id: number; method: string; args: unknown[] }
  | { type: 'changes'; sessions: string[] | null };

export type QueryWorkerReply =
  | { type: 'ready' }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; error: SerializedError };

export interface SerializedError {
  message: string;
  status?: number;
  code?: string;
  start?: number;
  end?: number;
  details?: Record<string, unknown>;
}

export function serializeError(err: unknown): SerializedError {
  const e = err as SerializedError & { message?: unknown };
  const out: SerializedError = { message: typeof e?.message === 'string' ? e.message : String(err) };
  for (const k of ['status', 'start', 'end'] as const) if (typeof e?.[k] === 'number') out[k] = e[k];
  if (typeof e?.code === 'string') out.code = e.code;
  if (e?.details && typeof e.details === 'object') out.details = e.details;
  return out;
}

if (!isMainThread && parentPort && (workerData as QueryWorkerData | undefined)?.agentsharkQueryWorker) {
  const port = parentPort;
  const data = workerData as QueryWorkerData;
  // An index of an older schema keeps serving while the new one builds; the derived queries then answer analysis-outdated.
  const db = openIndex(data.indexPath, { readOnly: true, acceptSchema: READABLE_OLD_SCHEMAS });
  // info() is answered on the HTTP thread, so the indexing status is never read here.
  const queries = createQueries(db, {
    mode: data.mode, indexPath: data.indexPath, capturePath: data.capturePath, instance: data.instance,
    getIndexing: () => ({ running: false, done: 0, total: 0, lastRunAt: null, lastRunMs: null }),
  });
  const derived = createDerivedQueries(db, {
    mode: data.mode, indexPath: data.indexPath, resolveView: queries.resolveView, ...(data.now != null && { now: () => data.now! }),
  });
  port.on('message', async (m: QueryWorkerRequest) => {
    if (m.type === 'changes') {
      queries.noteChanges(m.sessions);
      derived.noteChanges(m.sessions);
      return;
    }
    try {
      if (m.type === 'workbench') {
        const value = await runWorkbench(db, m.method, m.args[0], { mode: data.mode, indexPath: data.indexPath, now: data.now });
        port.postMessage({ type: 'result', id: m.id, value } satisfies QueryWorkerReply);
        return;
      }
      const target = (m.type === 'derived' ? derived : queries) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const value = await target[m.method](...m.args);
      port.postMessage({ type: 'result', id: m.id, value } satisfies QueryWorkerReply);
    } catch (err) {
      port.postMessage({ type: 'error', id: m.id, error: serializeError(err) } satisfies QueryWorkerReply);
    }
  });
  port.postMessage({ type: 'ready' } satisfies QueryWorkerReply);
}
