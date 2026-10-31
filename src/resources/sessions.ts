import { processCollector } from './processes.ts';
import { macProcessCollector } from './mac-processes.ts';
import { macNetworkCollector } from './mac-network.ts';
import { resourceCommand } from './command.ts';
import { readlink } from 'node:fs/promises';
import type { ProcessActivity, SessionActivity, SessionBinding, SessionProcess } from './types.ts';

export const SESSION_REASONS = ['disabled', 'unsupported-platform', 'gpu-asleep', 'gpu-power-state-unknown',
  'collector-not-installed', 'collector-timeout', 'collector-unavailable', 'per-process-network-unavailable', 'no-process-counters'] as const;
export function validateBindings(bindings: SessionBinding[]): void {
  if (!Array.isArray(bindings) || bindings.length > 64 || bindings.filter((b) => !b.discovered).length > 16) throw new Error('Session recording accepts at most 64 discovered sessions or 16 manual bindings');
  const sessions = new Set<string>(), owners = new Map<number, SessionBinding>();
  for (const b of bindings) {
    if (typeof b.session !== 'string' || !b.session.trim() || b.session.length > 512 || /[\x00-\x1f]/.test(b.session)
      || sessions.has(b.session) || !Array.isArray(b.roots) || !b.roots.length) throw new Error('Each session binding needs one unique session ID and positive root PIDs');
    sessions.add(b.session);
    if (new Set(b.roots).size !== b.roots.length || (b.discovered && (!b.starts || b.starts.length !== b.roots.length
      || b.starts.some((s) => !/^\d+$/.test(s)) || !['codex','claude-code','claude-cowork','copilot','antigravity'].includes(b.agent ?? '')))) throw new Error('Invalid discovered process identity');
    for (const pid of b.roots) {
      const owner = owners.get(pid);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1 || (owner && !(owner.discovered && b.discovered && owner.shared && b.shared
        && owner.starts![owner.roots.indexOf(pid)] === b.starts![b.roots.indexOf(pid)]))) throw new Error('Shared root PIDs require verified automatic discovery');
      owners.set(pid, b);
    }
  }
  if (owners.size > 16) throw new Error('Session recording accepts at most 16 root PIDs in total');
}

/** NVIDIA reports driver PIDs. A different PID namespace cannot establish that identity by number alone. */
export async function verifyGpuPidNamespace(read = () => readlink('/proc/self/ns/pid')) {
  // Linux UAPI PID_NS_INIT_INO, include/uapi/linux/nsfs.h. Unknown kernels fail closed.
  if (await read().catch(() => '') !== 'pid:[4026531836]') throw Object.assign(new Error('GPU PID namespace is unverified'), { code: 'RESOURCE_UNSUPPORTED' });
}

type GpuRow = Omit<NonNullable<SessionActivity['gpu']>['entries'][number], 'startId'>;
type NetRow = Pick<NonNullable<SessionActivity['network']>['entries'][number], 'pid' | 'rxBytes' | 'txBytes'>;
export function parseProcessGpu(text: string): GpuRow[] {
  let header: string[] | undefined;
  const rows: GpuRow[] = [];
  for (const line of text.trim().split('\n')) {
    const f = line.trim().replace(/^#\s*/, '').split(/\s+/);
    if (line.trim().startsWith('#')) { if (f.includes('gpu') && f.includes('pid')) header = f; continue; }
    if (!header || f.length < 4 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1])) continue;
    const value = (name: string, scale = 1) => {
      const s = f[header!.indexOf(name)]; return s && /^\d+(\.\d+)?$/.test(s) ? Number(s) * scale : null;
    };
    // MPS reports a shared server process. Leave those counters unattributed.
    if (f[header.indexOf('type')]?.includes('M')) continue;
    rows.push({ index: Number(f[0]), pid: Number(f[1]), smPercent: value('sm'), memoryUsedBytes: value('fb', 1024 ** 2) });
  }
  if (!header) throw new Error('Unsupported GPU process format');
  return rows.slice(0, 512);
}
export function parseProcessNetwork(text: string): NetRow[] {
  const lines = text.trim().split('\n').map((s) => s.split(','));
  const header = lines.shift() ?? [], rx = header.indexOf('bytes_in'), tx = header.indexOf('bytes_out');
  if (rx < 0 || tx < 0) throw new Error('Unsupported process network format');
  return lines.flatMap((f) => {
    const pid = /\.(\d+)$/.exec(f[0])?.[1];
    if (!pid || !/^\d+$/.test(f[rx] ?? '') || !/^\d+$/.test(f[tx] ?? '')) return [];
    return [{ pid: Number(pid), rxBytes: Number(f[rx]), txBytes: Number(f[tx]) }];
  }).slice(0, 128);
}
const errorReason = (e: any) => e?.code === 'RESOURCE_DISABLED' ? 'disabled' : e?.code === 'RESOURCE_UNSUPPORTED' ? 'unsupported-platform'
  : e?.code === 'RESOURCE_GPU_ASLEEP' ? 'gpu-asleep' : e?.code === 'RESOURCE_GPU_POWER_UNKNOWN' ? 'gpu-power-state-unknown'
  : e?.code === 'ENOENT' ? 'collector-not-installed' : e?.killed ? 'collector-timeout' : 'collector-unavailable';
interface SessionInputs {
  platform?: string; now?: () => number; wall?: () => number; mode?: 'auto' | 'off' | 'always'; guard?: () => Promise<void>;
  readProcesses?: (roots: number[]) => Promise<ProcessActivity>;
  gpu?: () => Promise<GpuRow[]>; network?: (pids: number[]) => Promise<NetRow[]>;
}

/** Verified discovered writers or explicit bindings. Cwd and time overlap never establish ownership. */
export function createSessionCollector(bindings: () => SessionBinding[], options: SessionInputs = {}) {
  const platform = options.platform ?? process.platform, now = options.now ?? (() => performance.now()), wall = options.wall ?? Date.now;
  let key = '', reader: (() => Promise<ProcessActivity>) & { close?: () => Promise<void>; helperPath?: () => string | undefined };
  let previous = new Map<string, { at: number; entry: SessionProcess }>();
  const owners = new Map<string, string[]>(), pins = new Map<string, string>();
  let current: SessionProcess[] = [], stopped = false, revision = 0;
  const jobs = new Set<Promise<void>>();
  const nativeNetwork = platform === 'darwin' && !options.network ? macNetworkCollector(parseProcessNetwork, () => reader?.helperPath?.()) : undefined;
  const background = <T>(read: () => Promise<T | { entries: T; ts: number }>, unsupportedReason?: string) => {
    let due = -Infinity, pending = false, failures = 0, scopeRevision = -1, ready: { ts: number; reason: string | null; entries: T } | undefined;
    let failureFrame: typeof ready;
    return (empty: T) => {
      if (scopeRevision !== revision) { due = -Infinity; ready = undefined; failureFrame = undefined; scopeRevision = revision; }
      const value = ready; ready = undefined;
      if (!stopped && !pending && now() + 5 >= due) {
        const ts = wall() * 1000;
        if (unsupportedReason) { due = Infinity; ready = failureFrame = { ts, reason: unsupportedReason, entries: empty }; }
        else {
          const generation = revision;
          pending = true; due = now() + 1000;
          const job = read().then((result) => {
            if (generation !== revision) { due = -Infinity; return; }
            failures = 0;
            failureFrame = undefined;
            const stamped = !Array.isArray(result) && result && typeof result === 'object' && 'entries' in result && 'ts' in result ? result as { entries: T; ts: number } : { entries: result as T, ts };
            ready = { ...stamped, reason: null };
          }, (e) => {
            if (generation !== revision) { due = -Infinity; return; }
            const reason = errorReason(e); ready = failureFrame = { ts, reason, entries: empty };
            due = ['disabled', 'unsupported-platform'].includes(reason) ? Infinity : now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures++, 4));
          }).finally(() => { pending = false; });
          jobs.add(job); void job.finally(() => jobs.delete(job));
        }
      }
      return value ?? failureFrame;
    };
  };
  const snapshotIds = () => new Map(current.map((p) => [p.pid, p.startId]));
  const gpu = background(async () => {
    const ids = snapshotIds();
    if (!options.gpu) await verifyGpuPidNamespace();
    if (options.mode !== 'always') {
      if (!options.guard) throw Object.assign(new Error('No safe GPU power guard'), { code: 'RESOURCE_GPU_POWER_UNKNOWN' });
      await options.guard();
    }
    const rows = options.gpu ? await options.gpu() : parseProcessGpu(await resourceCommand('nvidia-smi', ['pmon', '-s', 'um', '-c', '1'], 2000));
    return rows.filter((r) => ids.has(r.pid) && current.some((p) => p.pid === r.pid && p.startId === ids.get(r.pid)))
      .map((r) => ({ ...r, startId: ids.get(r.pid)! }));
  }, options.mode === 'off' ? 'disabled' : platform !== 'linux' ? 'unsupported-platform' : undefined);
  const netPrevious = new Map<string, { at: number; row: NetRow }>();
  const network = background<NonNullable<SessionActivity['network']>['entries']>(async () => {
    const ids = snapshotIds(), generation = revision;
    const observation = options.network ? { rows: await options.network([...ids.keys()]), at: now(), ts: wall() * 1000 }
      : await nativeNetwork!([...ids.keys()]);
    const { rows, at, ts } = observation;
    if (generation !== revision) return { entries: [], ts };
    const result = rows.filter((r) => ids.has(r.pid) && current.some((p) => p.pid === r.pid && p.startId === ids.get(r.pid))).map((r) => {
      const startId = ids.get(r.pid)!, k = `${r.pid}:${startId}`, old = netPrevious.get(k), ms = old ? at - old.at : 0;
      const rate = (v: 'rxBytes' | 'txBytes') => old && ms > 0 && r[v] >= old.row[v] ? (r[v] - old.row[v]) * 1000 / ms : null;
      const value = { ...r, startId, rxBytesPerSecond: rate('rxBytes'), txBytesPerSecond: rate('txBytes') };
      netPrevious.set(k, { at, row: r }); return value;
    });
    for (const k of netPrevious.keys()) if (!result.some((r) => `${r.pid}:${r.startId}` === k)) netPrevious.delete(k);
    return { entries: result, ts };
  }, !options.network && platform !== 'darwin' ? 'per-process-network-unavailable' : undefined);
  const collect = async (): Promise<SessionActivity> => {
    const active = bindings(); validateBindings(active);
    if (!active.length) {
      if (key) { await reader?.close?.(); key = ''; revision++; nativeNetwork?.reset(); previous.clear(); owners.clear(); pins.clear(); current = []; }
      return { bindings: [], entries: [], descendants: 'tracked', truncated: false, unavailablePids: [] };
    }
    const nextKey = JSON.stringify(active);
    if (nextKey !== key) {
      await reader?.close?.(); key = nextKey; revision++; nativeNetwork?.reset();
      const roots = [...new Set(active.flatMap((b) => b.roots))];
      reader = options.readProcesses ? () => options.readProcesses!(roots) : platform === 'darwin' ? macProcessCollector(roots)
        : processCollector(roots, platform, '/proc', undefined, { now });
      previous.clear(); owners.clear(); netPrevious.clear();
      const livePins = new Set(active.flatMap((b) => b.roots.map((pid) => `${b.session}:${pid}`)));
      for (const pin of pins.keys()) if (!livePins.has(pin)) pins.delete(pin);
      for (const b of active) if (b.discovered) b.roots.forEach((pid, i) => pins.set(`${b.session}:${pid}`, b.starts![i]));
    }
    const at = now(), observed = await reader();
    const byPid = new Map(observed.entries.map((p) => [p.pid, p]));
    const rootOwners = new Map<number, string[]>();
    for (const b of active) for (const pid of b.roots) {
      const pin = `${b.session}:${pid}`, entry = byPid.get(pid);
      if (!pins.has(pin)) pins.set(pin, entry?.startId ?? 'exited');
      if (entry && pins.get(pin) === entry.startId) rootOwners.set(pid, [...(rootOwners.get(pid) ?? []), b.session]);
    }
    const next = new Map<string, { at: number; entry: SessionProcess }>();
    const unavailableProcesses = (observed.unavailablePids ?? []).map((pid) => {
      const sessions = new Set(active.filter((b) => b.roots.includes(pid)).map((b) => b.session));
      for (const [identity, names] of owners) if (identity.startsWith(`${pid}:`)) for (const name of names) sessions.add(name);
      return { pid, sessions: [...sessions].filter((s) => active.some((b) => b.session === s)) };
    }).filter((p) => p.sessions.length);
    const unknownMissing = (observed.unavailablePids ?? []).some((pid) => !unavailableProcesses.some((p) => p.pid === pid));
    current = [];
    for (const p of observed.entries) {
      if (p.pid === process.pid) continue;
      const identity = `${p.pid}:${p.startId}`, sessions = new Set<string>();
      let ancestor = p, visited = new Set<number>();
      while (ancestor && !visited.has(ancestor.pid)) {
        if (ancestor.pid === process.pid) { sessions.clear(); break; }
        visited.add(ancestor.pid); for (const owner of rootOwners.get(ancestor.pid) ?? []) sessions.add(owner);
        ancestor = byPid.get(ancestor.parentPid)!;
      }
      if (!sessions.size) for (const s of owners.get(identity) ?? []) if (active.some((b) => b.session === s)) sessions.add(s);
      if (!sessions.size) continue;
      owners.set(identity, [...sessions]);
      const old = previous.get(identity), ms = old ? at - old.at : 0;
      const rate = (v: 'readBytes' | 'writeBytes') => old && ms > 0 && p[v] !== null && old.entry[v] !== null && p[v]! >= old.entry[v]!
        ? (p[v]! - old.entry[v]!) * 1000 / ms : null;
      const shared = sessions.size > 1 || active.some((b) => sessions.has(b.session) && b.shared);
      const entry = { ...p, sessions: [...sessions], ...(shared ? { shared: true } : {}), cpuPercent: old && ms > 0 && p.cpuTimeUs >= old.entry.cpuTimeUs ? (p.cpuTimeUs - old.entry.cpuTimeUs) / (ms * 10) : null,
        readBytesPerSecond: rate('readBytes'), writeBytesPerSecond: rate('writeBytes') };
      next.set(identity, { at, entry }); current.push(entry);
    }
    previous = next;
    for (const identity of owners.keys()) if (!next.has(identity)) owners.delete(identity);
    const g = current.length ? gpu([]) : undefined, n = current.length ? network([]) : undefined;
    const alive = new Set(current.map((p) => `${p.pid}:${p.startId}`));
    if (g) g.entries = g.entries.filter((p) => alive.has(`${p.pid}:${p.startId}`));
    if (n) n.entries = n.entries.filter((p) => alive.has(`${p.pid}:${p.startId}`));
    return { bindings: active.map((b) => ({ ...b, roots: b.roots.slice() })), entries: current,
      descendants: unknownMissing ? 'unavailable' : observed.descendants, truncated: observed.truncated, unavailablePids: unavailableProcesses.map((p) => p.pid), unavailableProcesses,
      ...(g ? { gpu: { ...g, reason: g.reason ?? (g.entries.length ? null : 'no-process-counters') } } : {}),
      ...(n ? { network: { ...n, reason: n.reason ?? (n.entries.length ? null : 'no-process-counters') } } : {}) };
  };
  return Object.assign(collect, { close: async () => { stopped = true; await reader?.close?.(); await nativeNetwork?.close(); await Promise.all(jobs); } });
}
