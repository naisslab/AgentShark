import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resourceCommand } from './command.ts';
import type { DiskCounter, FilesystemSpace, MemoryPressure } from './types.ts';

export const EXTENDED_INTERVAL_MS = 10_000;
export const SPACE_INTERVAL_MS = 60_000;
export function unsupported(): never { throw Object.assign(new Error('Unsupported counter'), { code: 'RESOURCE_UNSUPPORTED' }); }
const nullable = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

export function keyNumbers(text: string): Record<string, number> {
  return Object.fromEntries(text.split('\n').flatMap((s) => {
    const m = /^([^:\s]+):?\s+(\d+)/.exec(s); return m ? [[m[1], Number(m[2])]] : [];
  }));
}
export function parsePressureStalls(text: string): { some: number | null; full: number | null } {
  const total = (kind: string) => nullable(Number(new RegExp(`^${kind} .*\\btotal=(\\d+)`, 'm').exec(text)?.[1] ?? NaN));
  return { some: total('some'), full: total('full') };
}
const emptyPressure = (): MemoryPressure => ({ availableBytes: null, compressedBytes: null, swapUsedBytes: null, swapTotalBytes: null,
  swapInPages: null, swapOutPages: null, swapInPagesPerSecond: null, swapOutPagesPerSecond: null,
  level: null, memoryStallSomeUs: null, memoryStallFullUs: null, ioStallSomeUs: null, ioStallFullUs: null });

export function parseLinuxPressure(meminfo: string, vmstat: string, memoryPsi = '', ioPsi = ''): MemoryPressure {
  const m = keyNumbers(meminfo), v = keyNumbers(vmstat), memory = parsePressureStalls(memoryPsi), io = parsePressureStalls(ioPsi);
  if (!Number.isFinite(m.MemTotal)) throw new Error('Invalid memory counters');
  return { ...emptyPressure(), availableBytes: nullable(m.MemAvailable * 1024), compressedBytes: nullable(m.Zswap * 1024),
    swapTotalBytes: nullable(m.SwapTotal * 1024), swapUsedBytes: nullable((m.SwapTotal - m.SwapFree) * 1024),
    swapInPages: nullable(v.pswpin), swapOutPages: nullable(v.pswpout), memoryStallSomeUs: memory.some, memoryStallFullUs: memory.full,
    ioStallSomeUs: io.some, ioStallFullUs: io.full };
}
export function parseMacPressure(vmstat: string, sysctl: string): MemoryPressure {
  const page = Number(/page size of (\d+) bytes/.exec(vmstat)?.[1]);
  if (!(page > 0)) throw new Error('Invalid VM counters');
  const pages = (key: string) => nullable(Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(vmstat)?.[1] ?? NaN));
  const size = (key: string) => {
    const m = new RegExp(`\\b${key} = ([\\d.]+)([KMG])`).exec(sysctl);
    return m ? Number(m[1]) * 1024 ** ({ K: 1, M: 2, G: 3 }[m[2]] ?? 0) : null;
  };
  const level = Number(/memorystatus_vm_pressure_level:\s*(\d+)/.exec(sysctl)?.[1]);
  const compressed = pages('Pages occupied by compressor');
  return { ...emptyPressure(), compressedBytes: compressed === null ? null : compressed * page,
    swapInPages: pages('Swapins'), swapOutPages: pages('Swapouts'), swapTotalBytes: size('total'), swapUsedBytes: size('used'),
    level: level === 1 ? 'normal' : level === 2 ? 'warning' : level === 4 ? 'critical' : null };
}

export function parseLinuxDisks(text: string, devices?: Set<string>): DiskCounter[] {
  return text.trim().split('\n').flatMap((line) => {
    const f = line.trim().split(/\s+/); const name = f[2];
    if (f.length < 14 || (devices && !devices.has(name)) || /^(loop|ram)/.test(name)) return [];
    const n = [f[3], f[5], f[7], f[9]].map(Number);
    if (n.some((v) => !Number.isSafeInteger(v) || v < 0)) throw new Error('Invalid disk counters');
    return [{ name, readOperations: n[0], readBytes: n[1] * 512, writeOperations: n[2], writeBytes: n[3] * 512,
      transferredBytes: (n[1] + n[3]) * 512, transfers: n[0] + n[2] }];
  }).slice(0, 32);
}
export function parseMacDisks(text: string): DiskCounter[] {
  const lines = text.trim().split('\n').map((s) => s.trim().split(/\s+/));
  const names = lines[0], values = lines[2];
  if (!names?.length || !values || !lines[1].includes('xfrs') || values.length !== names.length * 3) throw new Error('Invalid disk counters');
  return names.slice(0, 32).map((name, i) => {
    const transfers = Number(values[i * 3 + 1]), bytes = Number(values[i * 3 + 2]) * 1024 ** 2;
    if (!/^disk\d+$/.test(name) || !Number.isFinite(bytes) || bytes < 0 || !Number.isSafeInteger(transfers) || transfers < 0) throw new Error('Invalid disk counters');
    return { name, transfers, transferredBytes: bytes, readBytes: null, writeBytes: null, readOperations: null, writeOperations: null };
  });
}

/** Native filesystem calls, at most four explicit local paths, deduplicated by filesystem device. */
export async function filesystemSpace(paths: string[]): Promise<FilesystemSpace> {
  const volumes: FilesystemSpace['volumes'] = [], seen = new Set<string>();
  for (const path of [...new Set(paths.map((p) => resolve(p)))].slice(0, 4)) {
    const device = String((await stat(path)).dev);
    if (seen.has(device)) continue;
    const fs = await statfs(path);
    volumes.push({ path, device, totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bfree * fs.bsize, availableBytes: fs.bavail * fs.bsize });
    seen.add(device);
  }
  return { volumes };
}

export function extendedCollectors(paths: string[], platform = process.platform, readSpace = filesystemSpace) {
  let blockDevices: Set<string> | undefined, discovered = -Infinity;
  let capacityPending: Promise<FilesystemSpace> | undefined;
  return {
    pressure: async () => {
      if (platform === 'linux') {
        const [mem, vm, psi, io] = await Promise.all([readFile('/proc/meminfo', 'utf8'), readFile('/proc/vmstat', 'utf8'),
          readFile('/proc/pressure/memory', 'utf8').catch(() => ''), readFile('/proc/pressure/io', 'utf8').catch(() => '')]);
        return parseLinuxPressure(mem, vm, psi, io);
      }
      if (platform === 'darwin') {
        const [vm, sys] = await Promise.all([resourceCommand('/usr/bin/vm_stat', []),
          resourceCommand('/usr/sbin/sysctl', ['kern.memorystatus_vm_pressure_level', 'vm.swapusage']).catch((e) => typeof e?.stdout === 'string' ? e.stdout : '')]);
        return parseMacPressure(vm, sys);
      }
      return unsupported();
    },
    disk: async () => {
      if (platform === 'linux') {
        if (performance.now() - discovered >= 60_000) { blockDevices = new Set(await readdir('/sys/block')); discovered = performance.now(); }
        return parseLinuxDisks(await readFile('/proc/diskstats', 'utf8'), blockDevices);
      }
      if (platform === 'darwin') return parseMacDisks(await resourceCommand('/usr/sbin/iostat', ['-Id', '-n', '16']));
      return unsupported();
    },
    filesystems: async () => {
      const timeout = () => Object.assign(new Error('Capacity query timed out'), { code: 'RESOURCE_TIMEOUT' });
      if (capacityPending) throw timeout();
      const pending = readSpace(paths);
      capacityPending = pending;
      // A timed-out native request may still be in libuv. Never queue another behind it.
      pending.then(() => { capacityPending = undefined; }, () => { capacityPending = undefined; });
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout()), 1000); })]); }
      finally { clearTimeout(timer); }
    },
  };
}
