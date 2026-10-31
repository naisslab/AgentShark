import type { SessionActivity, SessionBinding } from './types.ts';
import { SESSION_REASONS } from './sessions.ts';
const fields = (o: any, keys: string[]) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
const num = (n: any) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const optional = (n: any) => n === null || num(n);
const pid = (n: any) => Number.isSafeInteger(n) && n > 0;
const id = (s: any) => typeof s === 'string' && s.length > 0 && s.length <= 512;
export function validBindings(v: any): v is SessionBinding[] {
  if (!(Array.isArray(v) && v.length <= 64 && v.every((b) => fields(b, ['session', 'roots', 'starts', 'agent', 'discovered', 'shared']) && id(b.session)
    && (b.agent === undefined || ['codex','claude-code','claude-cowork','copilot','antigravity'].includes(b.agent))
    && (b.discovered === undefined || b.discovered === true) && (b.shared === undefined || typeof b.shared === 'boolean')
    && (b.starts === undefined || Array.isArray(b.starts) && b.starts.length === b.roots?.length && b.starts.every(id))
    && (!b.discovered || b.starts && b.agent)
    && Array.isArray(b.roots) && b.roots.length > 0 && b.roots.length <= 16 && b.roots.every(pid) && new Set(b.roots).size === b.roots.length))) return false;
  const roots = v.flatMap((b) => b.roots);
  if (new Set(roots).size > 16 || new Set(v.map((b) => b.session)).size !== v.length) return false;
  for (const root of new Set(roots)) {
    const owners = v.filter((b) => b.roots.includes(root));
    if (owners.length > 1 && (!owners.every((b) => b.discovered && b.shared) || new Set(owners.map((b) => b.starts[b.roots.indexOf(root)])).size !== 1)) return false;
  }
  return true;
}
export function validSessionActivity(v: any): v is SessionActivity {
  if (!fields(v, ['bindings', 'entries', 'descendants', 'truncated', 'unavailablePids', 'unavailableProcesses', 'gpu', 'network']) || !validBindings(v.bindings)
    || !Array.isArray(v.entries) || v.entries.length > 128 || !['tracked', 'unavailable'].includes(v.descendants) || typeof v.truncated !== 'boolean'
    || !Array.isArray(v.unavailablePids) || v.unavailablePids.length > 128 || !v.unavailablePids.every(pid)) return false;
  const sessions = new Set(v.bindings.map((b: SessionBinding) => b.session));
  if (v.unavailableProcesses !== undefined && (!Array.isArray(v.unavailableProcesses) || v.unavailableProcesses.length > 128
    || !v.unavailableProcesses.every((p: any) => fields(p, ['pid', 'sessions']) && pid(p.pid) && Array.isArray(p.sessions) && p.sessions.length > 0
      && p.sessions.length <= 64 && p.sessions.every((s: any) => sessions.has(s)) && v.unavailablePids.includes(p.pid)))) return false;
  const identities = new Set<string>();
  for (const p of v.entries) {
    if (!fields(p, ['pid', 'parentPid', 'startId', 'cpuTimeUs', 'residentBytes', 'readBytes', 'writeBytes', 'sessions', 'shared', 'cpuPercent', 'readBytesPerSecond', 'writeBytesPerSecond'])
      || (p.shared !== undefined && typeof p.shared !== 'boolean')
      || !pid(p.pid) || !Number.isSafeInteger(p.parentPid) || p.parentPid < 0 || !id(p.startId) || !num(p.cpuTimeUs) || !num(p.residentBytes)
      || !['readBytes', 'writeBytes', 'cpuPercent', 'readBytesPerSecond', 'writeBytesPerSecond'].every((k) => optional(p[k]))
      || !Array.isArray(p.sessions) || !p.sessions.length || p.sessions.length > 64 || !p.sessions.every((s: any) => sessions.has(s))
      || identities.has(`${p.pid}:${p.startId}`)) return false;
    identities.add(`${p.pid}:${p.startId}`);
  }
  for (const key of ['gpu', 'network']) if (v[key] !== undefined) {
    const f = v[key];
    if (!fields(f, ['ts', 'reason', 'entries']) || !Number.isSafeInteger(f.ts) || f.ts < 0
      || !(f.reason === null || SESSION_REASONS.includes(f.reason)) || !Array.isArray(f.entries) || f.entries.length > 512) return false;
    const seen = new Set<string>();
    for (const p of f.entries) {
      if (!pid(p.pid) || !id(p.startId) || !identities.has(`${p.pid}:${p.startId}`)) return false;
      const identity = `${p.pid}:${p.startId}:${key === 'gpu' ? p.index : ''}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      if (key === 'gpu') {
        if (!fields(p, ['pid', 'startId', 'index', 'smPercent', 'memoryUsedBytes']) || !Number.isInteger(p.index) || p.index < 0
          || !optional(p.smPercent) || (p.smPercent !== null && p.smPercent > 100) || !optional(p.memoryUsedBytes)) return false;
      } else if (!fields(p, ['pid', 'startId', 'rxBytes', 'txBytes', 'rxBytesPerSecond', 'txBytesPerSecond'])
        || !num(p.rxBytes) || !num(p.txBytes) || !optional(p.rxBytesPerSecond) || !optional(p.txBytesPerSecond)) return false;
    }
  }
  return true;
}
