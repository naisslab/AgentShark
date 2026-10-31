import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { resourceCommand as command } from './command.ts';
import { extendedCollectors, EXTENDED_INTERVAL_MS, SPACE_INTERVAL_MS } from './extended.ts';
import { processCollector } from './processes.ts';
import { createSessionCollector } from './sessions.ts';
import { macInterfaceCollector } from './mac-interfaces.ts';
import type { DiskCounter, FilesystemSpace, MemoryPressure, ProcessActivity, ResourceSample, SessionActivity, SessionBinding } from './types.ts';

export interface NetworkCounter { name: string; rxBytes: number; txBytes: number }
export type GpuMode = 'auto' | 'off' | 'always';
export interface SamplerOptions { gpuMode?: GpuMode; pids?: number[]; paths?: string[]; intervalMs?: number; sessions?: SessionBinding[]; bindings?: () => SessionBinding[] }
export interface SamplerInputs {
  platform: string;
  wallTime(): number;
  monotonicTime(): number;
  cpu(): { cores: number; total: number; idle: number };
  memory(): ResourceSample['memory'];
  load(): number[] | null;
  network(): Promise<NetworkCounter[]>;
  gpu(): Promise<NonNullable<ResourceSample['gpu']>>;
  pressure?(): Promise<MemoryPressure>;
  disk?(): Promise<DiskCounter[]>;
  filesystems?(): Promise<FilesystemSpace>;
  processes?(): Promise<ProcessActivity>;
  sessions?(): Promise<SessionActivity>;
  close?(): Promise<void>;
}

/** Failure backoff avoids spawning a missing utility on every sample. No stale values are reused. */
export function retryingProbe<T>(probe: () => Promise<T>, now: () => number): () => Promise<T> {
  let next = -Infinity, failures = 0, error: any;
  return async () => {
    if (now() < next) throw error;
    try { const value = await probe(); failures = 0; return value; }
    catch (e) {
      error = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      next = code === 'RESOURCE_DISABLED' || code === 'RESOURCE_UNSUPPORTED' ? Infinity
        : now() + (code === 'RESOURCE_GPU_ASLEEP' ? 1000 : Math.min(300_000, 30_000 * 2 ** Math.min(failures++, 4)));
      throw e;
    }
  };
}

/** Read kernel bookkeeping before touching the NVIDIA driver. Cache device discovery for one minute. */
export function createLinuxGpuGuard(root = '/sys/bus/pci/drivers/nvidia', now: () => number = () => performance.now()) {
  let paths: string[] = [], refreshed = -Infinity;
  return async () => {
    if (now() - refreshed >= 60_000) {
      paths = (await readdir(root)).filter((s) => /^[\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.[0-7]$/i.test(s)).map((s) => join(root, s, 'power/runtime_status'));
      refreshed = now();
    }
    if (!paths.length) throw Object.assign(new Error('GPU power state unavailable'), { code: 'RESOURCE_GPU_POWER_UNKNOWN' });
    let states: string[];
    try { states = await Promise.all(paths.map((p) => readFile(p, 'utf8').then((s) => s.trim()))); }
    catch { throw Object.assign(new Error('GPU power state unavailable'), { code: 'RESOURCE_GPU_POWER_UNKNOWN' }); }
    if (states.some((s) => s === 'suspended' || s === 'suspending' || s === 'resuming')) {
      throw Object.assign(new Error('GPU is asleep'), { code: 'RESOURCE_GPU_ASLEEP' });
    }
    if (states.some((s) => s !== 'active')) {
      throw Object.assign(new Error('GPU power state unavailable'), { code: 'RESOURCE_GPU_POWER_UNKNOWN' });
    }
  };
}

export function parseLinuxNetwork(text: string): NetworkCounter[] {
  const rows: NetworkCounter[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const fields = match[2].trim().split(/\s+/);
    if (match[1] !== 'lo' && fields.length >= 16) rows.push({ name: match[1], rxBytes: Number(fields[0]), txBytes: Number(fields[8]) });
  }
  return validNetwork(rows);
}

/** netstat repeats an interface for its link, IPv4 and IPv6 addresses. Count it once. */
export function parseMacNetwork(text: string): NetworkCounter[] {
  const lines = text.trim().split('\n').map((s) => s.trim().split(/\s+/));
  const header = lines.shift() ?? [];
  const rx = header.indexOf('Ibytes');
  const tx = header.indexOf('Obytes');
  if (rx < 0 || tx < 0) throw new Error('unsupported-format');
  const rows = new Map<string, NetworkCounter>();
  for (const fields of lines) {
    // Read from the right: tunnel link rows can omit the Address column.
    if (fields[2]?.startsWith('<Link#') && !fields[0].startsWith('lo')) {
      const name = fields[0].replace(/\*$/, '');
      rows.set(name, { name, rxBytes: Number(fields[fields.length - (header.length - rx)]), txBytes: Number(fields[fields.length - (header.length - tx)]) });
    }
  }
  return validNetwork([...rows.values()]);
}

function validNetwork(rows: NetworkCounter[]): NetworkCounter[] {
  if (!rows.length || rows.some((r) => !Number.isSafeInteger(r.rxBytes) || r.rxBytes < 0 || !Number.isSafeInteger(r.txBytes) || r.txBytes < 0)) throw new Error('no-counters');
  return rows;
}

export function parseNvidiaGpu(text: string): NonNullable<ResourceSample['gpu']> {
  const number = (s: string | undefined, scale = 1) => {
    if (!s?.trim() || !/^[\d.]+$/.test(s.trim())) return null;
    const n = Number(s) * scale;
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const rows = text.trim().split('\n').filter(Boolean).map((line) => {
    const [index, busy, used, total, temp, power] = line.split(',').map((s) => s.trim());
    if (!/^\d+$/.test(index) || line.split(',').length !== 6) throw new Error('unsupported-format');
    return { index: Number(index), utilizationPercent: number(busy), memoryUsedBytes: number(used, 1024 ** 2),
      memoryTotalBytes: number(total, 1024 ** 2), temperatureC: number(temp), powerWatts: number(power) };
  });
  if (!rows.length) throw new Error('no-devices');
  return rows;
}

function systemInputs(options: SamplerOptions): SamplerInputs {
  const gpuGuard = createLinuxGpuGuard();
  const sessions = createSessionCollector(options.bindings ?? (() => options.sessions ?? []), { mode: options.gpuMode, guard: gpuGuard });
  const macInterfaces = process.platform === 'darwin' ? macInterfaceCollector() : undefined;
  return {
    sessions, close: async () => { await sessions.close(); await macInterfaces?.close(); },
    ...extendedCollectors(options.paths ?? [process.cwd()]),
    ...(options.pids?.length ? { processes: processCollector(options.pids) } : {}),
    platform: process.platform, wallTime: Date.now, monotonicTime: () => performance.now(),
    cpu: () => {
      const cores = cpus();
      return { cores: cores.length, total: cores.reduce((n, c) => n + Object.values(c.times).reduce((a, b) => a + b, 0), 0),
        idle: cores.reduce((n, c) => n + c.times.idle, 0) };
    },
    memory: () => { const totalBytes = totalmem(); const freeBytes = freemem(); return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes }; },
    load: () => process.platform === 'win32' ? null : loadavg(),
    network: async () => {
      if (process.platform === 'linux') return parseLinuxNetwork(await readFile('/proc/net/dev', 'utf8'));
      if (macInterfaces) return macInterfaces();
      throw Object.assign(new Error('unsupported-platform'), { code: 'RESOURCE_UNSUPPORTED' });
    },
    gpu: async () => {
      if (options.gpuMode === 'off') throw Object.assign(new Error('GPU sampling disabled'), { code: 'RESOURCE_DISABLED' });
      if (options.gpuMode !== 'always') {
        if (process.platform !== 'linux') throw Object.assign(new Error('Safe GPU probe unavailable'), { code: 'RESOURCE_GPU_POWER_UNKNOWN' });
        await gpuGuard();
      }
      return parseNvidiaGpu(await command('nvidia-smi', [
        '--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits',
      ]));
    },
  };
}

/** Deltas use a monotonic clock. Counter resets and newly attached interfaces have unknown rates. */
export function createResourceSampler(inputs: SamplerInputs | undefined = undefined, recording: string = randomUUID(), options: SamplerOptions = {}) {
  const source = inputs ?? systemInputs(options);
  const fast = (options.intervalMs ?? 5000) < 1000;
  const start = source.monotonicTime();
  let previous: { at: number; cpu: ReturnType<SamplerInputs['cpu']> } | undefined;
  let oldNetwork: { at: number; values: NetworkCounter[] } | undefined;
  let sequence = 0;
  let oldDisk: { at: number; values: DiskCounter[] } | undefined;
  let oldPressure: { at: number; value: MemoryPressure } | undefined;
  const outstanding = new Set<Promise<void>>();
  let closed = false;
  const periodic = <T>(probe: (() => Promise<T>) | undefined, interval: number, backoff = true) => {
    let due = -Infinity;
    const read = probe ? backoff ? retryingProbe(probe, source.monotonicTime) : probe : undefined;
    type Result = { sampled: false } | { sampled: true; at: number; ts: number; value?: T; error?: unknown };
    let pending = false, ready: Result = { sampled: false };
    return async (): Promise<Result> => {
      const at = source.monotonicTime();
      const ts = source.wallTime() * 1000;
      const run = async (): Promise<Result> => {
        try { return { sampled: true, at, ts, value: await read!() }; } catch (error) { return { sampled: true, at, ts, error }; }
      };
      if (!fast) {
        if (!read || at < due) return { sampled: false };
        due = at + interval;
        return run();
      }
      // One outstanding read per counter. Slow commands never delay the 100 ms CPU/RAM path.
      const result = ready; ready = { sampled: false };
      if (read && !closed && !pending && at + Math.min(5, interval * 0.05) >= due) {
        due = at + interval; pending = true;
        const job = run().then((r) => { ready = r; pending = false; });
        outstanding.add(job); void job.finally(() => outstanding.delete(job));
      }
      return result;
    };
  };
  const nativeInterval = fast && source.platform === 'linux' ? options.intervalMs! : EXTENDED_INTERVAL_MS;
  const pressureProbe = periodic(source.pressure?.bind(source), nativeInterval);
  const diskProbe = periodic(source.disk?.bind(source), nativeInterval);
  const spaceProbe = periodic(source.filesystems?.bind(source), SPACE_INTERVAL_MS);
  const processProbe = periodic(source.processes?.bind(source), fast && source.platform === 'linux' ? 1000 : EXTENDED_INTERVAL_MS);
  const sessionProbe = periodic(source.sessions ? async () => {
    const resourceBindings = (options.bindings?.() ?? options.sessions ?? []).map((b) => ({ ...b, roots: b.roots.slice() }));
    try { return await source.sessions!(); }
    catch (error) { throw { code: (error as any)?.code, killed: (error as any)?.killed, resourceBindings }; }
  } : undefined, 0, false);
  const networkProbe = periodic(() => source.network(), fast && source.platform !== 'linux' ? 1000 : 0);
  const gpuProbe = periodic(() => options.gpuMode === 'off'
    ? Promise.reject(Object.assign(new Error('GPU sampling disabled'), { code: 'RESOURCE_DISABLED' })) : source.gpu(), fast ? 1000 : 0);
  const sample = async (): Promise<ResourceSample> => {
    const at = source.monotonicTime();
    const ts = source.wallTime() * 1000;
    const cpu = source.cpu();
    const memory = source.memory();
    const loadAverage = source.load();
    const [results, pressure, disk, space, processes, sessions] = await Promise.all([
      Promise.all([networkProbe(), gpuProbe()]), pressureProbe(), diskProbe(), spaceProbe(), processProbe(), sessionProbe(),
    ]);
    const unavailable: ResourceSample['unavailable'] = [];
    // Store stable reasons only. Driver errors can contain private paths or identifiers.
    const reason = (e: any) => e?.code === 'ENOENT' ? 'collector-not-installed' : e?.killed || e?.code === 'RESOURCE_TIMEOUT' ? 'collector-timeout'
      : e?.code === 'RESOURCE_DISABLED' ? 'disabled' : e?.code === 'RESOURCE_UNSUPPORTED' ? 'unsupported-platform'
      : e?.code === 'RESOURCE_GPU_ASLEEP' ? 'gpu-asleep' : e?.code === 'RESOURCE_GPU_POWER_UNKNOWN' ? 'gpu-power-state-unknown' : 'collector-unavailable';
    const extra: Partial<ResourceSample> = {};
    const observed: NonNullable<ResourceSample['observed']> = {};
    for (const [metric, result] of [['network', results[0]], ['gpu', results[1]], ['pressure', pressure], ['disk', disk], ['filesystems', space], ['processes', processes]] as const) {
      if (result.sampled && fast) observed[metric] = result.ts;
    }
    if (fast) extra.observed = observed;
    if (sessions.sampled) {
      if (fast) observed.sessions = sessions.ts;
      if (sessions.value?.bindings.length) extra.sessionResources = sessions.value;
      else if (sessions.error) {
        const bindings: SessionBinding[] = (sessions.error as any)?.resourceBindings ?? options.bindings?.() ?? options.sessions ?? [];
        const missing = [...new Set(bindings.flatMap((b) => b.roots))].map((pid) => ({pid, sessions: bindings.filter((b) => b.roots.includes(pid)).map((b) => b.session)}));
        extra.sessionResources = bindings.length ? { bindings: bindings.map((b) => ({ ...b, roots: b.roots.slice() })), entries: [],
          descendants: 'unavailable', truncated: false, unavailablePids: missing.map((p) => p.pid), unavailableProcesses: missing } : null;
        unavailable.push({ metric: 'sessions', reason: reason(sessions.error) });
      }
    }
    for (const [metric, result] of [['pressure', pressure], ['disk', disk], ['filesystems', space], ['processes', processes]] as const) {
      if (result.sampled && result.error) { extra[metric] = null; unavailable.push({ metric, reason: reason(result.error) }); }
    }
    const rate = (now: number | null, before: number | null | undefined, ms: number | undefined) =>
      now !== null && before != null && ms && ms > 0 && now >= before ? (now - before) * 1000 / ms : null;
    if (pressure.sampled) {
      if (pressure.value) {
        const value = pressure.value, ms = oldPressure ? pressure.at - oldPressure.at : undefined;
        extra.pressure = { ...value, swapInPagesPerSecond: rate(value.swapInPages, oldPressure?.value.swapInPages, ms),
          swapOutPagesPerSecond: rate(value.swapOutPages, oldPressure?.value.swapOutPages, ms) };
        oldPressure = { at: pressure.at, value };
      } else oldPressure = undefined;
    }
    if (disk.sampled) {
      if (disk.value) {
        const ms = oldDisk && disk.at > oldDisk.at ? disk.at - oldDisk.at : null;
        extra.disk = { intervalMs: ms, devices: disk.value.map((d) => {
          const old = oldDisk?.values.find((p) => p.name === d.name);
          return { ...d, readBytesPerSecond: rate(d.readBytes, old?.readBytes, ms ?? undefined),
            writeBytesPerSecond: rate(d.writeBytes, old?.writeBytes, ms ?? undefined), bytesPerSecond: rate(d.transferredBytes, old?.transferredBytes, ms ?? undefined) };
        }) };
        oldDisk = { at: disk.at, values: disk.value };
      } else oldDisk = undefined;
    }
    if (space.sampled && space.value) extra.filesystems = space.value;
    if (processes.sampled && processes.value) extra.processes = processes.value;
    const networkResult = results[0], gpuResult = results[1];
    const network = networkResult.sampled ? networkResult.value ?? null : null;
    const gpu = gpuResult.sampled ? gpuResult.value ?? null : null;
    if (networkResult.sampled && networkResult.error) unavailable.push({ metric: 'network', reason: reason(networkResult.error) });
    if (gpuResult.sampled && gpuResult.error) unavailable.push({ metric: 'gpu', reason: reason(gpuResult.error) });
    const intervalMs = previous && at > previous.at ? at - previous.at : null;
    const total = previous ? cpu.total - previous.cpu.total : 0;
    const idle = previous ? cpu.idle - previous.cpu.idle : 0;
    const busyPercent = intervalMs !== null && previous?.cpu.cores === cpu.cores && total > 0 && idle >= 0 && idle <= total
      ? 100 * (1 - idle / total) : null;
    if (busyPercent === null) unavailable.push({ metric: 'cpu', reason: previous ? 'counter-reset-or-no-delta' : 'warming-up' });
    const interfaces = network?.map((n) => {
      const old = oldNetwork?.values.find((p) => p.name === n.name);
      const ms = networkResult.sampled && oldNetwork ? networkResult.at - oldNetwork.at : 0;
      const rate = (key: 'rxBytes' | 'txBytes') => old && ms > 0 && n[key] >= old[key] ? (n[key] - old[key]) * 1000 / ms : null;
      return { ...n, rxBytesPerSecond: rate('rxBytes'), txBytesPerSecond: rate('txBytes') };
    });
    if (networkResult.sampled) oldNetwork = network ? { at: networkResult.at, values: network } : undefined;
    previous = { at, cpu };
    return { rec: 'resource', id: `${recording}:${sequence++}`, recording, ts, elapsedMs: at - start, intervalMs, scope: 'host',
      platform: source.platform, cpu: { cores: cpu.cores, busyPercent, loadAverage }, memory,
      network: interfaces ? { interfaces } : null, gpu, ...extra, unavailable };
  };
  return Object.assign(sample, { close: async () => { closed = true; await source.close?.(); await Promise.all(outstanding); } });
}
