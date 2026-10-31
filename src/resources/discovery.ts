import { execFile } from 'node:child_process';
import { setPriority } from 'node:os';
import { promisify } from 'node:util';
import { opendir, readFile, stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { prepareMacHelper } from './mac-helper.ts';
import type { SessionBinding } from './types.ts';

export const MAX_DISCOVERED_SESSIONS = 64;
export interface DiscoveryResult { bindings: SessionBinding[]; truncated: boolean }
export interface ResourceDiscoveryStatus { state: 'searching' | 'ready' | 'unavailable'; checkedTs?: number; durationMs?: number; intervalMs: number; truncated?: boolean }
export interface Writer { pid: number; startId: string; source: number }
export interface Writers { entries: Writer[]; truncated: boolean }
interface Source { id: string; path: string }
interface Session { id: string; agent: string; sources: string[] }

/** Closing a transcript between writes does not end an already verified process lifetime. */
export function retainLiveBindings(previous: SessionBinding[], found: DiscoveryResult, alive: {pid: number; startId: string}[]): DiscoveryResult {
  const identities = new Set(alive.map((p) => `${p.pid}:${p.startId}`));
  const sessions = new Map(found.bindings.map((b) => [b.session, { ...b, roots: b.roots.slice(), starts: b.starts!.slice() }]));
  for (const old of previous.filter((b) => b.discovered)) {
    for (let i = 0; i < old.roots.length; i++) {
      const pid = old.roots[i], start = old.starts![i];
      if (!identities.has(`${pid}:${start}`)) continue;
      let binding = sessions.get(old.session);
      if (!binding) { binding = { ...old, roots: [], starts: [] }; sessions.set(old.session, binding); }
      if (!binding.roots.includes(pid)) { binding.roots.push(pid); binding.starts!.push(start); }
      binding.shared ||= old.shared;
    }
  }
  const roots = new Set<number>(), bindings: SessionBinding[] = [];
  let truncated = found.truncated;
  for (const binding of sessions.values()) {
    if (bindings.length >= MAX_DISCOVERED_SESSIONS) { truncated = true; continue; }
    const keep = binding.roots.map((pid, i) => ({ pid, start: binding.starts![i] })).filter(({pid}) => {
      if (!roots.has(pid) && roots.size >= 16) { truncated = true; return false; }
      roots.add(pid); return true;
    }).sort((a, b) => a.pid - b.pid);
    if (keep.length) bindings.push({ ...binding, roots: keep.map((p) => p.pid), starts: keep.map((p) => p.start) });
  }
  const counts = new Map<number, number>();
  for (const b of bindings) for (const pid of b.roots) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  for (const b of bindings) b.shared ||= truncated || b.roots.some((pid) => counts.get(pid)! > 1);
  return { bindings: bindings.sort((a, b) => a.session.localeCompare(b.session)), truncated };
}

/** Only exact writable transcript ownership establishes a binding. Never inspect commands or environments. */
export function discoveredBindings(writers: Writers, sources: Source[], sessions: Session[]): DiscoveryResult {
  const owners = new Map<string, Map<string, Writer>>();
  for (const entry of writers.entries) {
    if (entry.pid === process.pid || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || entry.pid > 2 ** 31 - 1
      || !/^\d+$/.test(entry.startId) || !sources[entry.source]) continue;
    const source = sources[entry.source].id;
    const entries = owners.get(source) ?? new Map();
    entries.set(`${entry.pid}:${entry.startId}`, entry); owners.set(source, entries);
  }
  let truncated = writers.truncated;
  const identities = new Set<string>();
  const bindings: SessionBinding[] = [];
  for (const session of sessions.sort((a, b) => a.id.localeCompare(b.id))) {
    const entries = new Map<string, Writer>();
    for (const source of session.sources) for (const [key, entry] of owners.get(source) ?? []) entries.set(key, entry);
    if (!entries.size) continue;
    if (bindings.length >= MAX_DISCOVERED_SESSIONS) { truncated = true; continue; }
    const roots: number[] = [], starts: string[] = [];
    for (const [key, entry] of [...entries].sort((a, b) => a[1].pid - b[1].pid)) {
      if (!identities.has(key) && identities.size >= 16) { truncated = true; continue; }
      identities.add(key); roots.push(entry.pid); starts.push(entry.startId);
    }
    if (roots.length) bindings.push({ session: session.id, roots, starts, agent: session.agent, discovered: true });
  }
  const counts = new Map<number, number>();
  for (const b of bindings) for (const pid of b.roots) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  for (const b of bindings) b.shared = truncated || b.roots.some((pid) => counts.get(pid)! > 1);
  return { bindings, truncated };
}

// Linux discovery has the same limits and lifetime check as the native Mac helper.
// Directory iteration avoids unbounded arrays on hosts with many processes or FDs.
export async function linuxWriters(sources: Source[], proc = '/proc'): Promise<Writers> {
  const byFile = new Map<string, number[]>();
  for (let i = 0; i < sources.length; i++) try {
    const s = await stat(sources[i].path, { bigint: true });
    if (s.isFile()) { const key = `${s.dev}:${s.ino}`; byFile.set(key, [...(byFile.get(key) ?? []), i]); }
  } catch { /* A removed transcript has no current owner. */ }
  const result: Writers = { entries: [], truncated: false };
  if (!byFile.size) return result;
  const deadline = performance.now() + 1500;
  let processes = 0, descriptors = 0;
  const lifetime = async (pid: string) => {
    const text = await readFile(`${proc}/${pid}/stat`, 'utf8');
    const start = text.slice(text.lastIndexOf(')') + 2).split(/\s+/)[19];
    if (!/^\d+$/.test(start)) throw new Error('Invalid process identity');
    return start;
  };
  for await (const entry of await opendir(proc)) {
    if (!/^\d+$/.test(entry.name) || Number(entry.name) === process.pid) continue;
    if (++processes > 8192 || performance.now() > deadline || descriptors >= 65536 || result.entries.length >= 1024) { result.truncated = true; break; }
    try {
      if ((await stat(`${proc}/${entry.name}`)).uid !== process.getuid?.()) continue;
      const startId = await lifetime(entry.name), matches = new Set<number>();
      let count = 0;
      for await (const fd of await opendir(`${proc}/${entry.name}/fd`)) {
        if (++count > 4096 || ++descriptors > 65536 || performance.now() > deadline) { result.truncated = true; break; }
        try {
          const s = await stat(`${proc}/${entry.name}/fd/${fd.name}`, { bigint: true });
          const source = byFile.get(`${s.dev}:${s.ino}`); if (!source) continue;
          const info = await readFile(`${proc}/${entry.name}/fdinfo/${fd.name}`, 'utf8');
          const flags = /^flags:\s+([0-7]+)$/m.exec(info)?.[1];
          if (flags && (parseInt(flags, 8) & 3) !== 0) for (const index of source) matches.add(index);
        } catch { /* Exited, closed, or inaccessible descriptor. */ }
      }
      if (await lifetime(entry.name) !== startId) continue;
      for (const source of matches) {
        if (result.entries.length >= 1024) { result.truncated = true; break; }
        result.entries.push({ pid: Number(entry.name), startId, source });
      }
    } catch { /* Exit and permission races do not establish ownership. */ }
  }
  return result;
}

export function createResourceDiscovery(database: () => DatabaseSync, scan?: (sources: Source[]) => Promise<Writers>) {
  let helper: Awaited<ReturnType<typeof prepareMacHelper>> | undefined;
  const discover = async (): Promise<DiscoveryResult> => {
    const db = database();
    // Metadata only; never scan event payloads or open transcript contents.
    const sources = db.prepare(`SELECT id,path FROM sources WHERE exists_now=1 AND kind IN
      ('rollout','transcript','subagent-transcript','workflow-transcript','chat-session') ORDER BY mtime_ms DESC,id LIMIT 8193`).all() as unknown as Source[];
    const truncated = sources.length > 8192; sources.length = Math.min(sources.length, 8192);
    if (!sources.length) return { bindings: [], truncated };
    let writers: Writers;
    if (scan) writers = await scan(sources);
    else if (process.platform === 'darwin') {
      helper ??= await prepareMacHelper();
      const pending = promisify(execFile)(helper.path, ['--discover'], { timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 });
      if (pending.child.pid) try { setPriority(pending.child.pid, 19); } catch { /* Best effort. */ }
      pending.child.stdin!.on('error', () => {});
      pending.child.stdin!.end(sources.map((s) => s.path + '\0').join(''));
      writers = JSON.parse((await pending).stdout);
    } else if (process.platform === 'linux') writers = await linuxWriters(sources);
    else throw new Error('Automatic process discovery is unavailable on this platform');
    if (!Array.isArray(writers.entries) || writers.entries.length > 1024 || typeof writers.truncated !== 'boolean') throw new Error('Invalid discovery response');
    const sourceIds = [...new Set(writers.entries.map((w) => sources[w.source]?.id).filter(Boolean))];
    if (!sourceIds.length) return { bindings: [], truncated: truncated || writers.truncated };
    const rows = db.prepare(`SELECT id,agent,src_id,sources FROM sessions WHERE src_id IN (SELECT value FROM json_each(?))
      OR EXISTS (SELECT 1 FROM json_each(sessions.sources) WHERE value IN (SELECT value FROM json_each(?)))`).all(JSON.stringify(sourceIds), JSON.stringify(sourceIds)) as unknown as { id: string; agent: string; src_id: string | null; sources: string | null }[];
    const sessions = rows.map((s) => ({ id: s.id, agent: s.agent, sources: [...new Set([...(s.sources ? JSON.parse(s.sources) : []), ...(s.src_id ? [s.src_id] : [])])] }));
    return discoveredBindings({ ...writers, truncated: truncated || writers.truncated }, sources, sessions);
  };
  return Object.assign(discover, { close: async () => { await helper?.close(); helper = undefined; } });
}
