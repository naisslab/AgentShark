// Runs the read API in a small pool of worker threads (query-worker.ts), each with its own read-only connection.
// The HTTP thread keeps serving the viewer, the event stream and the watch loop while a filter or statistic runs.
// Views live in the connection that built them: a view id names its worker, and requests for it go there.

import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { DerivedQueries, IndexQueries } from '../index/api.ts';
import type { QueryWorkerData, QueryWorkerReply, QueryWorkerRequest, SerializedError } from './query-worker.ts';

/** IndexQueries whose methods may also answer with a promise (the routes await every result). */
export type ApiQueries = {
  [K in keyof IndexQueries]: (...args: Parameters<IndexQueries[K]>) => ReturnType<IndexQueries[K]> | Promise<Awaited<ReturnType<IndexQueries[K]>>>;
};

/** DerivedQueries whose methods may also answer with a promise. */
export type ApiDerivedQueries = {
  [K in keyof DerivedQueries]: (...args: Parameters<DerivedQueries[K]>) => ReturnType<DerivedQueries[K]> | Promise<Awaited<ReturnType<DerivedQueries[K]>>>;
};

/** Cheap lookups that stay on the HTTP thread's own connection. */
const LOCAL = new Set<keyof IndexQueries>(['info', 'fields', 'validateFilter', 'listSessions', 'getSession', 'overview']);
/** Methods whose first argument is a view id. */
const VIEW_FIRST = new Set<keyof IndexQueries>([
  'viewRows', 'locate', 'find', 'histogram', 'statsSummary', 'statsKinds', 'statsTools', 'statsModels', 'statsPerformance', 'statsIo', 'statsPairs',
]);

export const DEFAULT_QUERY_WORKERS = 2;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

interface Job {
  id: number;
  type: 'call' | 'derived' | 'workbench';
  method: string;
  args: unknown[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: Worker;
  instance: string;
  ready: boolean;
  queue: Job[];
  current: Job | null;
  timer: NodeJS.Timeout | null;
}

export interface QueryHostOptions {
  indexPath: string;
  mode: 'live' | 'capture';
  capturePath?: string;
  /** Queries on the HTTP thread's connection, for the cheap lookups and as the source of truth for noteChanges. */
  local: IndexQueries;
  /** Derived queries on the same connection: analysisStatus answers there, everything else in a worker. */
  localDerived?: DerivedQueries;
  /** Fixed clock (µs) for the workers' derived queries (capture mode). */
  now?: number;
  workers?: number;
  timeoutMs?: number;
}

export class QueryHost {
  private opts: QueryHostOptions;
  private slots: Slot[] = [];
  private nextId = 0;
  private closed = false;
  readonly timeoutMs: number;

  constructor(opts: QueryHostOptions) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    const n = Math.max(1, opts.workers ?? DEFAULT_QUERY_WORKERS);
    for (let i = 0; i < n; i++) this.slots.push(this.spawn([]));
  }

  /** The API object the routes use. */
  api(): ApiQueries {
    const api: Record<string, unknown> = {};
    for (const method of Object.keys(this.opts.local) as (keyof IndexQueries)[]) {
      api[method] = (...args: unknown[]) => this.call(method, args);
    }
    return api as ApiQueries;
  }

  /** The derived API the routes use. Methods whose query names a `view` run in the worker that holds the view. */
  derivedApi(): ApiDerivedQueries {
    const local = this.opts.localDerived as unknown as Record<string, (...a: unknown[]) => unknown> | undefined;
    return new Proxy({} as ApiDerivedQueries, {
      get: (_, method) => (...args: unknown[]) => {
        if (typeof method !== 'string') return undefined;
        if (method === 'noteChanges') return this.call('noteChanges', args);
        if (local && (method === 'analysisStatus' || this.closed)) return local[method](...args);
        const viewId = args.map((a) => (a && typeof a === 'object' ? (a as { view?: unknown }).view : undefined)).find((v) => typeof v === 'string');
        return this.enqueue('derived', method, args, viewId as string | undefined);
      },
    });
  }

  call(method: keyof IndexQueries, args: unknown[]): unknown {
    const local = this.opts.local as unknown as Record<string, (...a: unknown[]) => unknown>;
    if (method === 'noteChanges') {
      local.noteChanges(...args);
      this.opts.localDerived?.noteChanges(args[0] as string[] | null);
      for (const s of this.slots) this.post(s, { type: 'changes', sessions: args[0] as string[] | null });
      return undefined;
    }
    if (LOCAL.has(method) || this.closed) return local[method](...args);
    const viewId = VIEW_FIRST.has(method) ? args[0] : method === 'expert' ? (args[0] as { viewId?: string } | undefined)?.viewId : undefined;
    return this.enqueue('call', method, args, typeof viewId === 'string' ? viewId : undefined);
  }

  /** `info()` answered by a worker: it counts rows, which the HTTP thread must not do on a large index. */
  workerInfo(): Promise<ReturnType<IndexQueries['info']>> {
    return this.enqueue('call', 'info', [], undefined) as Promise<ReturnType<IndexQueries['info']>>;
  }

  /** Bounded analyses share the worker pool's deadline and cancellation behavior. */
  workbench(operation: string, input: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(httpError(503, 'shutting-down', 'The server is stopping'));
    return this.enqueue('workbench', operation, [input], undefined);
  }

  /**
   * The index file was replaced (a promoted rebuild): answer from fresh connections. Requests in flight run again in
   * the new workers; views built in the old ones are gone, and clients create them again.
   */
  reopen(local: IndexQueries, localDerived?: DerivedQueries): void {
    this.opts = { ...this.opts, local, localDerived };
    for (const slot of [...this.slots]) this.replace(slot, [...(slot.current ? [slot.current] : []), ...slot.queue]);
  }

  private enqueue(type: Job['type'], method: string, args: unknown[], viewId: string | undefined): Promise<unknown> {
    const slot = this.slotFor(viewId);
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.nextId, type, method, args, resolve, reject };
      slot.queue.push(job);
      this.pump(slot);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map((s) => {
      if (s.timer) clearTimeout(s.timer);
      for (const j of [...s.queue, ...(s.current ? [s.current] : [])]) j.reject(httpError(503, 'shutting-down', 'The server is stopping'));
      return s.worker.terminate();
    }));
  }

  private slotFor(viewId: string | undefined): Slot {
    if (viewId) {
      // `<instance>-<n>`: the worker that built the view. An id from a restarted worker or an earlier run goes to any
      // worker, which answers that the view is unknown.
      const owner = this.slots.find((s) => viewId.startsWith(s.instance + '-'));
      if (owner) return owner;
    }
    return this.slots.reduce((a, b) => (load(b) < load(a) ? b : a));
  }

  private spawn(queue: Job[]): Slot {
    const instance = `w${randomBytes(3).toString('hex')}`;
    const data: QueryWorkerData = {
      agentsharkQueryWorker: true, indexPath: this.opts.indexPath, mode: this.opts.mode, capturePath: this.opts.capturePath, instance,
      ...(this.opts.now != null && { now: this.opts.now }),
    };
    const worker = new Worker(new URL('./query-worker.ts', import.meta.url), { workerData: data });
    worker.unref();
    const slot: Slot = { worker, instance, ready: false, queue, current: null, timer: null };
    worker.on('message', (m: QueryWorkerReply) => {
      if (m.type === 'ready') {
        slot.ready = true;
        this.pump(slot);
        return;
      }
      const job = slot.current;
      if (!job || job.id !== m.id) return;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      slot.current = null;
      if (m.type === 'result') job.resolve(job.method === 'file' ? fileResult(m.value) : m.value);
      else job.reject(deserialize(m.error));
      this.pump(slot);
    });
    worker.on('error', (err) => {
      // A worker that cannot open the index fails every request it holds; the next request spawns a fresh one.
      const failed = [...slot.queue, ...(slot.current ? [slot.current] : [])];
      slot.queue = [];
      slot.current = null;
      for (const j of failed) j.reject(httpError(500, 'query-worker', `Query worker failed: ${err.message}`));
      this.replace(slot, []);
    });
    return slot;
  }

  private pump(slot: Slot): void {
    if (!slot.ready || slot.current || !slot.queue.length) return;
    const job = slot.queue.shift()!;
    slot.current = job;
    slot.timer = setTimeout(() => this.timeout(slot, job), this.timeoutMs);
    slot.timer.unref();
    this.post(slot, { type: job.type, id: job.id, method: job.method, args: job.args } as QueryWorkerRequest);
  }

  /** A request ran past the budget: stop its worker (SQLite cannot be interrupted from outside) and start another. */
  private timeout(slot: Slot, job: Job): void {
    if (slot.current !== job) return;
    slot.current = null;
    job.reject(httpError(503, 'query-timeout',
      `The query took longer than ${Math.round(this.timeoutMs / 1000)} s and was stopped; narrow the filter or scope. Views built earlier must be created again.`));
    this.replace(slot, slot.queue);
  }

  private replace(slot: Slot, queue: Job[]): void {
    if (slot.timer) clearTimeout(slot.timer);
    void slot.worker.terminate();
    const i = this.slots.indexOf(slot);
    if (i < 0 || this.closed) return;
    this.slots[i] = this.spawn(queue);
  }

  private post(slot: Slot, m: QueryWorkerRequest): void {
    slot.worker.postMessage(m);
  }
}

function load(s: Slot): number {
  return s.queue.length + (s.current ? 1 : 0) + (s.ready ? 0 : 0.5);
}

function httpError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function deserialize(e: SerializedError): Error {
  const err = Object.assign(new Error(e.message), e);
  return err;
}

/** Buffers arrive from a worker as plain Uint8Arrays. */
function fileResult(v: unknown): unknown {
  const f = v as { contentType: string; data: Uint8Array } | null;
  return f ? { contentType: f.contentType, data: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength) } : f;
}
