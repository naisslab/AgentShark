import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { acquireWriterLock } from '../index/indexer.ts';
import { createResourceSampler, type SamplerOptions } from './sampler.ts';
import { openResourceDatabase, putResourceRecording, putResourceSample } from './store.ts';
import { packResourceSample } from './codec.ts';
import { recordingContext } from './context.ts';
import { validateBindings } from './sessions.ts';
import type { ResourceRecording, ResourceSample, SessionBinding } from './types.ts';
import { retainLiveBindings, type DiscoveryResult, type ResourceDiscoveryStatus } from './discovery.ts';

export const DEFAULT_RESOURCE_INTERVAL_MS = 100;
export const RESOURCE_FLUSH_MS = 1000;
export const RESOURCE_BUFFER_SAMPLES = 100;
export const RESOURCE_RECENT_SAMPLES = 256;
export const RESOURCE_BUFFER_BYTES = 1_048_576;
/** Fast mode budgets 5% elapsed collection duty; slower modes retain the 1% target. No catch-up bursts. */
export function resourceInterval(intervalMs: number, durationMs: number, failures = 0): number {
  return Math.min(300_000, Math.max(intervalMs, Math.ceil(durationMs * (intervalMs < 1000 ? 20 : 100)), failures ? intervalMs * 2 ** Math.min(failures, 6) : 0));
}
export function validateResourceInterval(ms: number): void {
  if (!Number.isInteger(ms) || ms < 100 || ms > 60_000) throw new Error('resource interval must be an integer from 100 to 60000 ms');
}

export interface ResourceRecorder {
  status(): { enabled: boolean; recording: string; intervalMs: number; effectiveIntervalMs: number; samples: number; skipped: number;
    buffered: number; observedIntervalMs: number | null; lastDurationMs: number; lastTs: number | null; lastError: string | null; bindings: SessionBinding[]; sessionError: string | null; discovery?: ResourceDiscoveryStatus };
  bind(session: string, roots: number[]): void;
  snapshot(): { samples: ResourceSample[]; document: ResourceRecording };
  close(): Promise<void>;
}

/** One sampler per index. Bounded batching reduces WAL traffic without delaying the live ring. */
export async function startResourceRecorder(indexPath: string, intervalMs = DEFAULT_RESOURCE_INTERVAL_MS,
  sample?: () => Promise<ResourceSample>, options: SamplerOptions & { discovery?: (() => Promise<DiscoveryResult>) & { close?: () => Promise<void> } } = {}): Promise<ResourceRecorder> {
  validateResourceInterval(intervalMs);
  validateBindings(options.sessions ?? []);
  if (options.sessions?.some((b) => b.roots.includes(process.pid))) throw new Error('Choose an agent PID, not the AgentShark recorder PID');
  let bindings = (options.sessions ?? []).map((b) => ({ ...b, roots: b.roots.slice() }));
  const manual = new Map(bindings.map((b) => [b.session, b]));
  const detached = new Set<string>();
  if (options.pids && (options.pids.length > 16 || options.pids.some((p) => !Number.isSafeInteger(p) || p < 1 || p > 2 ** 31 - 1))) throw new Error('Resource tracking accepts at most 16 positive root PIDs');
  if (options.paths && (options.paths.length > 4 || options.paths.some((p) => typeof p !== 'string' || !p))) throw new Error('Resource capacity accepts at most 4 paths');
  const release = acquireWriterLock(`${indexPath}.resources`);
  const recording = randomUUID();
  options = { ...options, intervalMs, paths: [...new Set((options.paths ?? [process.cwd(), dirname(indexPath)]).map((p) => resolve(p)))].slice(0, 4) };
  let document: ResourceRecording;
  try {
    const startedTs = Date.now() * 1000;
    document = { rec: 'resource-recording', id: recording, startedTs, stoppedTs: null, context: await recordingContext(options),
      health: { updatedTs: startedTs, samples: 0, skipped: 0, lastDurationMs: 0, effectiveIntervalMs: intervalMs, lastTs: null, lastError: null } };
  } catch (e) { release(); throw e; }
  const sampler = sample ? undefined : createResourceSampler(undefined, recording, { ...options, bindings: () => bindings });
  const collect = sample ?? sampler!;
  const state = { enabled: true, recording, intervalMs, effectiveIntervalMs: intervalMs, samples: 0, skipped: 0, buffered: 0, observedIntervalMs: null as number | null,
    lastDurationMs: 0, lastTs: null as number | null, lastError: null as string | null, sessionError: null as string | null };
  const fast = intervalMs < 1000;
  let db: DatabaseSync | undefined, inode: number | undefined;
  let timer: NodeJS.Timeout | undefined, pending: Promise<void>;
  let failures = 0, sequence = 0, checkpoint = -Infinity, nextFlush = -Infinity, metadataDirty = true;
  let scheduledAt = performance.now();
  let bufferedBytes = 0, recentBytes = 0;
  let discovery: ResourceDiscoveryStatus | undefined = options.discovery ? { state: 'searching', intervalMs: 10_000 } : undefined;
  let discoveryTimer: NodeJS.Timeout | undefined, discoveryPending: Promise<void> | undefined;
  const updateBindings = (next: SessionBinding[]) => {
    validateBindings(next);
    if (JSON.stringify(next) === JSON.stringify(bindings)) return;
    bindings = next; document.context.sessionBindings = next.map((b) => ({ ...b, roots: b.roots.slice() })); metadataDirty = true;
  };
  const discover = async () => {
    const start = performance.now();
    try {
      const found = await options.discovery!();
      if (!state.enabled) return;
      const last = recent.at(-1)?.sample;
      const alive = last && Date.now() * 1000 - last.ts < 2_000_000 ? last.sessionResources?.entries ?? [] : [];
      const result = retainLiveBindings(bindings, found, alive);
      const manualRoots = new Set([...manual.values()].flatMap((b) => b.roots));
      const next = result.bindings.filter((b) => !manual.has(b.session) && !detached.has(b.session) && !b.roots.some((p) => manualRoots.has(p)));
      updateBindings([...manual.values(), ...next].slice(0, 64));
      discovery = { state: 'ready', checkedTs: Date.now() * 1000, durationMs: performance.now() - start,
        intervalMs: Math.min(60_000, Math.max(10_000, Math.ceil((performance.now() - start) * 100))), truncated: result.truncated };
    } catch {
      discovery = { ...discovery, state: 'unavailable', intervalMs: 30_000 };
    } finally {
      if (state.enabled) discoveryTimer = setTimeout(() => { discoveryPending = discover(); }, discovery!.intervalMs).unref();
    }
  };
  const buffer: { sample: ResourceSample; bytes: number; json: string }[] = [];
  const recent: typeof buffer = [];
  const health = () => ({ updatedTs: Date.now() * 1000, samples: state.samples, skipped: state.skipped, lastDurationMs: state.lastDurationMs,
    effectiveIntervalMs: state.effectiveIntervalMs, lastTs: state.lastTs, lastError: state.lastError });
  const discard = () => { const old = buffer.shift()!; bufferedBytes -= old.bytes; state.skipped++; state.buffered = buffer.length; metadataDirty = true; };
  const flush = () => {
    nextFlush = performance.now() + RESOURCE_FLUSH_MS;
    const count = buffer.length;
    try {
      const nextInode = statSync(indexPath).ino;
      if (!db || inode !== nextInode) {
        db?.close(); db = undefined; db = openResourceDatabase(indexPath); inode = nextInode; metadataDirty = true;
      }
      const saveMetadata = metadataDirty || performance.now() - checkpoint >= 60_000;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const item of buffer) putResourceSample(db, item.sample, item.json);
        if (saveMetadata) {
          document.health = { ...health(), samples: state.samples + count, lastError: null };
          putResourceRecording(db, document);
        }
        db.exec('COMMIT');
      } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
      buffer.length = 0; bufferedBytes = 0; state.buffered = 0;
      state.samples += count; state.lastError = null;
      if (saveMetadata) { checkpoint = performance.now(); metadataDirty = false; }
    } catch (e) {
      metadataDirty = true;
      const code = (e as { errcode?: number })?.errcode;
      if (code !== undefined && [5, 6].includes(code & 0xff)) state.lastError = fast ? 'Trace index busy; resource batch pending' : 'Trace index busy; resource sample skipped';
      else { state.lastError = 'Resource sample could not be collected or stored; retrying'; db?.close(); db = undefined; }
      // Fast mode retries a bounded batch once a second while collection and display continue.
      if (!fast) { while (buffer.length) discard(); failures++; }
    }
  };
  const onExit = () => release();
  process.on('exit', onExit);
  const tick = async () => {
    const start = performance.now();
    try {
      let result = await collect();
      if (result.recording !== recording) result = { ...result, recording, id: `${recording}:${sequence}` };
      sequence++;
      if (!state.enabled) return;
      if (result.unavailable.some((u) => u.metric === 'sessions')) state.sessionError = result.unavailable.find((u) => u.metric === 'sessions')!.reason;
      else if (result.sessionResources) state.sessionError = null;
      result.health = { collectorDurationMs: performance.now() - start, skippedTotal: state.skipped };
      const json = JSON.stringify(packResourceSample(result)), bytes = Buffer.byteLength(json);
      // Cap both cardinality and payload bytes, even when the trace writer holds the database.
      if (bytes > RESOURCE_BUFFER_BYTES) throw new Error('Resource sample exceeds buffer budget');
      while (buffer.length >= RESOURCE_BUFFER_SAMPLES || bufferedBytes + bytes > RESOURCE_BUFFER_BYTES) discard();
      const item = { sample: result, bytes, json };
      buffer.push(item); bufferedBytes += bytes; state.buffered = buffer.length;
      recent.push(item); recentBytes += bytes;
      while (recent.length > RESOURCE_RECENT_SAMPLES || recentBytes > RESOURCE_BUFFER_BYTES) recentBytes -= recent.shift()!.bytes;
      if (result.intervalMs !== null && result.intervalMs > 0) state.observedIntervalMs = state.observedIntervalMs === null
        ? result.intervalMs : state.observedIntervalMs * 0.8 + result.intervalMs * 0.2;
      state.lastTs = result.ts; failures = 0;
      if (performance.now() >= nextFlush) flush();
    } catch {
      state.skipped++; failures++; metadataDirty = true;
      state.lastError = 'Resource sample could not be collected or stored; retrying';
    } finally {
      state.lastDurationMs = performance.now() - start;
      state.effectiveIntervalMs = resourceInterval(intervalMs, state.lastDurationMs, failures);
      scheduledAt += state.effectiveIntervalMs;
      // Correct ordinary timer drift, but skip an overrun instead of running catch-up samples.
      if (scheduledAt <= performance.now()) scheduledAt = performance.now() + state.effectiveIntervalMs;
      if (state.enabled) timer = setTimeout(() => { pending = tick(); }, Math.max(1, Math.ceil(scheduledAt - performance.now()))).unref();
    }
  };
  pending = tick(); await pending;
  if (options.discovery) discoveryPending = discover();
  return { status: () => ({ ...state, ...(discovery ? { discovery: { ...discovery } } : {}), bindings: bindings.map((b) => ({ ...b, roots: b.roots.slice() })) }),
    bind: (session, roots) => {
      if (roots.includes(process.pid)) throw new Error('Choose an agent PID, not the AgentShark recorder PID');
      validateBindings([{ session, roots: roots.length ? roots : [1] }]);
      const next = bindings.filter((b) => b.session !== session);
      if (roots.length) next.push({ session, roots: [...new Set(roots)] });
      updateBindings(next);
      if (roots.length) { manual.set(session, next.find((b) => b.session === session)!); detached.delete(session); }
      else { manual.delete(session); detached.add(session); }
    }, snapshot: () => ({ samples: recent.map((r) => r.sample), document: { ...document, health: health() } }), close: async () => {
    state.enabled = false; clearTimeout(timer); clearTimeout(discoveryTimer); await pending; await discoveryPending;
    await options.discovery?.close?.(); await sampler?.close();
    flush();
    while (buffer.length) discard();
    try {
      db ??= openResourceDatabase(indexPath);
      document.stoppedTs = Math.max(document.startedTs, Date.now() * 1000); document.health = health();
      putResourceRecording(db, document);
    } catch { /* Shutdown never waits for a contended writer; the last checkpoint stays explicitly open. */ }
    db?.close(); db = undefined; release(); process.off('exit', onExit);
  } };
}
