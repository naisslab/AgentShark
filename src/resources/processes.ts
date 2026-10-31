import { open, readFile, readdir } from 'node:fs/promises';
import { resourceCommand } from './command.ts';
import { unsupported } from './extended.ts';
import type { ProcessActivity } from './types.ts';

export const MAX_RESOURCE_PROCESSES = 128;
async function childIds(path: string): Promise<{ text: string; truncated: boolean }> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead === buffer.length;
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (truncated && !/\s$/.test(text)) text = text.replace(/\S+$/, '');
    return { text, truncated };
  } finally { await file.close(); }
}
export function parseLinuxProcess(stat: string, status: string, io: string, hz: number, pageSize?: number): ProcessActivity['entries'][number] {
  const end = stat.lastIndexOf(')');
  const pid = Number(stat.slice(0, stat.indexOf(' '))), fields = stat.slice(end + 2).split(/\s+/);
  if (end < 0 || fields.length < 22 || !Number.isInteger(pid) || !(hz > 0)
    || ![fields[1], fields[11], fields[12], fields[19]].every((s) => /^\d+$/.test(s))) throw new Error('Invalid process counters');
  const number = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(io); return m ? Number(m[1]) : null;
  };
  const resident = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  const residentBytes = resident ? Number(resident[1]) * 1024 : pageSize && /^\d+$/.test(fields[21]) ? Number(fields[21]) * pageSize : null;
  if (residentBytes === null) throw new Error('Missing resident memory');
  return { pid, parentPid: Number(fields[1]), startId: fields[19], cpuTimeUs: (Number(fields[11]) + Number(fields[12])) * 1e6 / hz,
    residentBytes, readBytes: number('read_bytes'), writeBytes: number('write_bytes') };
}

export function parseMacProcesses(text: string): ProcessActivity['entries'] {
  return text.trim().split('\n').filter(Boolean).map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]+\s+[A-Za-z]+\s+\d+\s+[\d:]+\s+\d{4})\s+([\d:.\-]+)\s+(\d+)\s*$/.exec(line);
    if (!m) throw new Error('Invalid process counters');
    const [days, clock] = m[4].includes('-') ? m[4].split('-') : ['0', m[4]];
    const time = clock.split(':').map(Number);
    if (time.length < 2 || time.length > 3 || time.some((v) => !Number.isFinite(v))) throw new Error('Invalid process time');
    const seconds = Number(days) * 86400 + time.reduce((n, v) => n * 60 + v, 0);
    return { pid: Number(m[1]), parentPid: Number(m[2]), startId: m[3].replace(/\s+/g, ' '), cpuTimeUs: seconds * 1e6,
      residentBytes: Number(m[5]) * 1024, readBytes: null, writeBytes: null };
  });
}

/** Requests only explicit PIDs and known Linux descendants, with no global /proc walk or full ps listing. */
export function processCollector(roots: number[], platform: string = process.platform, procRoot = '/proc', tickHz?: number,
  fast?: { now?: () => number; pageSize?: number }) {
  roots = [...new Set(roots)].slice(0, 16);
  const identities = new Map<number, string>();
  const rejectedRoots = new Set<number>();
  let hz = tickHz;
  let pageSize = fast?.pageSize, discovered = -Infinity, lastTruncated = false, lastDescendants: ProcessActivity['descendants'] = 'tracked';
  let coordinatesChecked = false;
  return async (): Promise<ProcessActivity> => {
    if (platform === 'darwin') {
      const live = roots.filter((p) => !rejectedRoots.has(p));
      if (!live.length) return { roots, descendants: 'unavailable', truncated: false, entries: [], unavailablePids: roots };
      let text: string;
      try { text = await resourceCommand('/bin/ps', ['-p', live.join(','), '-o', 'pid=,ppid=,lstart=,time=,rss=']); }
      catch (e) { live.forEach((p) => rejectedRoots.add(p)); throw e; }
      const entries = parseMacProcesses(text);
      const accepted = entries.filter((p) => {
        const old = identities.get(p.pid); if (old && old !== p.startId) return false;
        identities.set(p.pid, p.startId); return true;
      });
      live.filter((p) => !accepted.some((e) => e.pid === p)).forEach((p) => rejectedRoots.add(p));
      return { roots, descendants: 'unavailable', truncated: false, entries: accepted, unavailablePids: roots.filter((p) => !accepted.some((e) => e.pid === p)) };
    }
    if (platform !== 'linux') return unsupported();
    if (fast && procRoot === '/proc' && !coordinatesChecked) {
      const self = await readFile('/proc/self/stat', 'utf8');
      if (Number(self.slice(0, self.indexOf(' '))) !== process.pid) return unsupported();
      coordinatesChecked = true;
    }
    hz ??= Number((await resourceCommand('getconf', ['CLK_TCK'])).trim());
    if (fast) pageSize ??= Number((await resourceCommand('getconf', ['PAGESIZE'])).trim());
    if (!Number.isFinite(hz) || hz <= 0) throw new Error('Clock tick frequency unavailable');
    const queue = [...new Set([...roots, ...identities.keys()])], visited = new Set<number>(), entries: ProcessActivity['entries'] = [];
    const unavailablePids: number[] = [];
    const now = fast?.now?.() ?? performance.now(), discover = !fast || now - discovered >= 995;
    let truncated = discover ? false : lastTruncated, descendants: ProcessActivity['descendants'] = discover ? 'tracked' : lastDescendants;
    let threadsRead = 0;
    if (discover) discovered = now;
    while (queue.length && visited.size < MAX_RESOURCE_PROCESSES) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      if (fast && pid === process.pid && !roots.includes(pid)) continue;
      visited.add(pid);
      if (rejectedRoots.has(pid)) { unavailablePids.push(pid); continue; }
      try {
        const [stat, status, io] = await Promise.all([readFile(`${procRoot}/${pid}/stat`, 'utf8'), fast ? Promise.resolve('') : readFile(`${procRoot}/${pid}/status`, 'utf8'),
          readFile(`${procRoot}/${pid}/io`, 'utf8').catch(() => '')]);
        const entry = parseLinuxProcess(stat, status, io, hz, pageSize);
        if (identities.has(pid) && identities.get(pid) !== entry.startId) {
          unavailablePids.push(pid);
          if (roots.includes(pid)) rejectedRoots.add(pid); else identities.delete(pid);
          continue;
        }
        let children = { text: '', truncated: false };
        if (discover && fast) {
          // Linux records children per thread. Bound discovery across all threads, once a second.
          const tids = (await readdir(`${procRoot}/${pid}/task`)).filter((s) => /^\d+$/.test(s));
          const remaining = Math.max(0, 128 - threadsRead);
          truncated ||= tids.length > remaining;
          for (const tid of tids.slice(0, remaining)) {
            threadsRead++;
            const found = await childIds(`${procRoot}/${pid}/task/${tid}/children`).catch(() => { descendants = 'unavailable'; return { text: '', truncated: false }; });
            children.text += ' ' + found.text; children.truncated ||= found.truncated;
          }
        } else if (discover) children = await childIds(`${procRoot}/${pid}/task/${pid}/children`).catch(() => { descendants = 'unavailable'; return { text: '', truncated: false }; });
        truncated ||= children.truncated;
        const verified = parseLinuxProcess(await readFile(`${procRoot}/${pid}/stat`, 'utf8'), status, io, hz, pageSize);
        if (verified.startId !== entry.startId) throw new Error('Process identity changed during sampling');
        identities.set(pid, entry.startId); entries.push(entry);
        for (const child of children.text.trim().split(/\s+/).filter(Boolean)) {
          if (!/^\d+$/.test(child)) continue;
          const n = Number(child);
          if (!visited.has(n) && !queue.includes(n)) {
            if (queue.length + visited.size >= MAX_RESOURCE_PROCESSES) truncated = true;
            else queue.push(n);
          }
        }
      } catch {
        unavailablePids.push(pid);
        if (roots.includes(pid)) rejectedRoots.add(pid); else identities.delete(pid);
      }
    }
    lastTruncated = truncated || queue.length > 0; lastDescendants = descendants;
    return { roots, descendants, truncated: truncated || queue.length > 0, entries, unavailablePids };
  };
}
