import type { ResourceSample, SessionActivity } from './types.ts';

/** Retain only actual session membership, including after the last trace event. Never infer ownership from time. */
export function selectSessionActivity(frame: SessionActivity, sessions: string[]): SessionActivity {
  const wanted = new Set(sessions);
  const bindings = frame.bindings.filter((b) => wanted.has(b.session));
  const entries = frame.entries.filter((p) => p.sessions.some((s) => wanted.has(s)))
    .map((p) => ({ ...p, sessions: p.sessions.filter((s) => wanted.has(s)) }));
  const identities = new Set(entries.map((p) => `${p.pid}:${p.startId}`));
  const pids = new Set([...entries.map((p) => p.pid), ...bindings.flatMap((b) => b.roots)]);
  const unavailableProcesses = frame.unavailableProcesses?.filter((p) => p.sessions.some((s) => wanted.has(s))).map((p) => ({ ...p, sessions: p.sessions.filter((s) => wanted.has(s)) }));
  return { ...frame, bindings, entries, ...(unavailableProcesses ? { unavailableProcesses } : {}),
    unavailablePids: unavailableProcesses ? unavailableProcesses.map((p) => p.pid) : frame.unavailablePids.filter((p) => pids.has(p)),
    ...(frame.gpu ? { gpu: { ...frame.gpu, entries: frame.gpu.entries.filter((p) => identities.has(`${p.pid}:${p.startId}`)) } } : {}),
    ...(frame.network ? { network: { ...frame.network, entries: frame.network.entries.filter((p) => identities.has(`${p.pid}:${p.startId}`)) } } : {}) };
}
export function selectResourceSessions(sample: ResourceSample, sessions?: string[]): ResourceSample {
  return sessions?.length && sample.sessionResources ? { ...sample, sessionResources: selectSessionActivity(sample.sessionResources, sessions) } : sample;
}
