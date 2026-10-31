import type { DatabaseSync } from 'node:sqlite';
import type { ResourceRecorder } from './recorder.ts';
import { resourceCursor, type ResourceQuery } from './store.ts';
import { selectResourceSessions } from './selection.ts';

/** Small in-memory tail, including samples waiting for the next batch commit. Never queries sample history. */
export function liveResources(db: DatabaseSync, recorder: ResourceRecorder, q: ResourceQuery) {
  const snapshot = recorder.snapshot();
  const after = q.after ? resourceCursor(q.after) : undefined;
  const compare = (s: { ts: number; id: string }, cursor: [number, string]) => s.ts - cursor[0] || (s.id < cursor[1] ? -1 : s.id > cursor[1] ? 1 : 0);
  // Session intervals retain exactly the same overlap semantics as durable queries.
  const ranges = q.scope !== 'session' && q.sessions?.length ? db.prepare(`SELECT COALESCE(start_ts, created_ts) lo,
    COALESCE(end_ts, start_ts, created_ts) hi FROM sessions WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(q.sessions)) as { lo: number; hi: number }[] : undefined;
  const samples = snapshot.samples.filter((s) => (!after || compare(s, after) > 0)
    && (q.from === undefined || s.ts >= q.from) && (q.to === undefined || s.ts <= q.to)
    && (!ranges || ranges.some((r) => s.ts >= r.lo && s.ts <= r.hi))
    && (q.scope !== 'session' || s.sessionResources && (!q.sessions?.length || s.sessionResources.bindings.some((b) => q.sessions!.includes(b.session)))))
    .map((s) => selectResourceSessions(s, q.sessions));
  if (q.order === 'desc') samples.reverse();
  const limit = Math.min(5000, Math.max(1, q.limit ?? 256));
  const more = samples.length > limit;
  samples.length = Math.min(samples.length, limit);
  const newest = snapshot.samples.at(-1), oldest = snapshot.samples[0];
  // When truncated, advance only through the returned page. Otherwise consume even out-of-scope observations.
  const tail = more ? samples.at(-1) : newest;
  const cursor = tail ? Buffer.from(JSON.stringify([tail.ts, tail.id])).toString('base64url') : q.after ?? null;
  const scoped = q.sessions?.length || q.from !== undefined || q.to !== undefined;
  return { scope: q.scope ?? 'host', samples, recordings: samples.length || !scoped ? [snapshot.document] : [], next: more ? cursor : null, cursor,
    reset: !!(after && oldest && after[0] < oldest.ts - Math.max(1, oldest.intervalMs ?? 100) * 2000) };
}
