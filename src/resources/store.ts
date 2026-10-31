import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { APPLICATION_ID, SCHEMA_VERSION } from '../index/db.ts';
import type { ResourceRecording, ResourceSample } from './types.ts';
import { validBindings, validSessionActivity } from './validation.ts';
import { packResourceSample, parseResourceSample } from './codec.ts';
import { selectResourceSessions } from './selection.ts';

/** Additive storage, independent of trace normalization and the recorded analysis digest. */
export function ensureResourceTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS resource_samples (
    id TEXT PRIMARY KEY, recording TEXT NOT NULL, ts INTEGER NOT NULL, sample TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS resource_samples_ts ON resource_samples(ts, id);
  CREATE TABLE IF NOT EXISTS resource_recordings (id TEXT PRIMARY KEY, document TEXT NOT NULL);`);
}

export function hasResources(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_samples'").get();
}

export function putResourceSample(db: DatabaseSync, sample: ResourceSample, json = JSON.stringify(packResourceSample(sample))): void {
  let insert = inserts.get(db);
  if (!insert) { insert = db.prepare('INSERT INTO resource_samples VALUES (?, ?, ?, ?)'); inserts.set(db, insert); }
  insert.run(sample.id, sample.recording, sample.ts, json);
}
const inserts = new WeakMap<DatabaseSync, StatementSync>();
const recordingInserts = new WeakMap<DatabaseSync, StatementSync>();
export function putResourceRecording(db: DatabaseSync, recording: ResourceRecording): void {
  let insert = recordingInserts.get(db);
  if (!insert) { insert = db.prepare('INSERT INTO resource_recordings VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document'); recordingInserts.set(db, insert); }
  insert.run(recording.id, JSON.stringify(recording));
}
export function resourceRecordings(db: DatabaseSync, ids?: string[], limit?: number): ResourceRecording[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='resource_recordings'").get()) return [];
  const where = ids ? 'WHERE id IN (SELECT value FROM json_each(?))' : '';
  return (db.prepare(`SELECT document FROM resource_recordings ${where} ORDER BY ${limit ? 'rowid DESC' : 'id'} ${limit ? 'LIMIT ?' : ''}`)
    .all(...(ids ? [JSON.stringify(ids)] : []), ...(limit ? [limit] : [])) as { document: string }[])
    .map((r) => JSON.parse(r.document));
}

/** Open an existing WAL index without migrations, schema recreation, or waiting for the trace writer. */
export function openResourceDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    const app = db.prepare('PRAGMA application_id').get() as { application_id: number };
    if (app.application_id !== APPLICATION_ID) throw new Error('Resource recording requires an AgentShark index');
    const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    if (Number(version?.value) !== SCHEMA_VERSION) throw new Error('Resource recording waits for the current index schema');
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    if (journal.journal_mode !== 'wal') throw new Error('Resource recording requires WAL mode');
    db.exec('PRAGMA synchronous=NORMAL; PRAGMA cache_size=-512');
    ensureResourceTable(db);
    return db;
  } catch (e) { db.close(); throw e; }
}

export interface ResourceQuery { from?: number; to?: number; sessions?: string[]; after?: string; limit?: number; order?: 'asc' | 'desc'; live?: boolean; scope?: 'host' | 'session' }

export function resourceCursor(value: string): [number, string] {
  let cursor: any;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { /* validated below */ }
  if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isSafeInteger(cursor[0]) || typeof cursor[1] !== 'string') {
    throw new Error('Invalid resource cursor');
  }
  return cursor as [number, string];
}

/** A sample overlaps a selected session by time; it is never attributed to an agent process. */
export function resourceWhere(q: ResourceQuery): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  for (const [key, op] of [['from', '>='], ['to', '<=']] as const) if (q[key] !== undefined) {
    where.push(`r.ts ${op} ?`); params.push(q[key]!);
  }
  if (q.after) { where.push(`(r.ts, r.id) ${q.order === 'desc' ? '<' : '>'} (?, ?)`); params.push(...resourceCursor(q.after)); }
  if (q.scope === 'session') {
    where.push("json_type(r.sample, '$.sessionResources') = 'object'");
    if (q.sessions?.length) {
      where.push("EXISTS (SELECT 1 FROM json_each(r.sample, '$.sessionResources.bindings') b WHERE json_extract(b.value, '$.session') IN (SELECT value FROM json_each(?)))");
      params.push(JSON.stringify(q.sessions));
    }
  } else if (q.sessions?.length) {
    // Bound the time index before checking individual overlaps, even for a session far back in a long recording.
    where.push(`r.ts BETWEEN
      (SELECT min(COALESCE(start_ts, created_ts)) FROM sessions WHERE id IN (SELECT value FROM json_each(?))) AND
      (SELECT max(COALESCE(end_ts, start_ts, created_ts)) FROM sessions WHERE id IN (SELECT value FROM json_each(?)))`);
    params.push(JSON.stringify(q.sessions), JSON.stringify(q.sessions));
    where.push(`EXISTS (SELECT 1 FROM sessions s WHERE s.id IN (SELECT value FROM json_each(?))
      AND r.ts >= COALESCE(s.start_ts, s.created_ts) AND r.ts <= COALESCE(s.end_ts, s.start_ts, s.created_ts))`);
    params.push(JSON.stringify(q.sessions));
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

/** New session measurements follow identity; older host context retains temporal selection. */
export function resourceCaptureWhere(q: ResourceQuery) {
  if (!q.sessions?.length) return resourceWhere(q);
  const host = resourceWhere(q), session = resourceWhere({ ...q, scope: 'session' });
  return { sql: `WHERE ((${host.sql.slice(6)}) AND json_type(r.sample, '$.sessionResources') IS NULL) OR (${session.sql.slice(6)})`,
    params: [...host.params, ...session.params] };
}

export function queryResources(db: DatabaseSync, q: ResourceQuery = {}) {
  if (!hasResources(db)) return { scope: q.scope ?? 'host', samples: [], next: null };
  const limit = Math.min(5000, Math.max(1, q.limit ?? 1000));
  const { sql, params } = resourceWhere(q);
  const order = q.order === 'desc' ? 'DESC' : 'ASC';
  const samples = (db.prepare(`SELECT sample FROM resource_samples r ${sql} ORDER BY ts ${order}, id ${order} LIMIT ?`).all(...params, limit + 1) as { sample: string }[])
    .map((r) => selectResourceSessions(parseResourceSample(r.sample), q.sessions));
  const more = samples.length > limit;
  if (more) samples.pop();
  const last = samples.at(-1);
  const ids = [...new Set(samples.map((s) => s.recording))];
  const recordings = resourceRecordings(db, ids.length || q.sessions?.length || q.from !== undefined || q.to !== undefined || q.after ? ids : undefined, ids.length ? undefined : 64);
  return { scope: q.scope ?? 'host', samples, recordings, next: more && last ? Buffer.from(JSON.stringify([last.ts, last.id])).toString('base64url') : null };
}

/** Reject arbitrary nested payloads, non-finite numbers and malformed imported measurements. */
export function validResourceSample(v: any): v is ResourceSample {
  const num = (n: any) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const optional = (n: any) => n === null || num(n);
  const fields = (o: any, keys: string[]) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
  return fields(v, ['rec', 'id', 'recording', 'ts', 'elapsedMs', 'intervalMs', 'scope', 'platform', 'cpu', 'memory', 'network', 'gpu', 'unavailable',
    'pressure', 'disk', 'filesystems', 'processes', 'health', 'observed', 'sessionResources'])
    && v.rec === 'resource' && typeof v.id === 'string' && v.id.length > 0 && typeof v.recording === 'string' && v.recording.length > 0
    && Number.isSafeInteger(v.ts) && v.ts >= 0 && v.scope === 'host' && ['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix', 'android'].includes(v.platform)
    && num(v.elapsedMs) && optional(v.intervalMs)
    && (v.observed === undefined || fields(v.observed, ['network', 'gpu', 'pressure', 'disk', 'filesystems', 'processes', 'sessions'])
      && Object.values(v.observed).every((n) => Number.isSafeInteger(n) && num(n)))
    && fields(v.cpu, ['cores', 'busyPercent', 'loadAverage']) && Number.isInteger(v.cpu.cores) && v.cpu.cores >= 0 && optional(v.cpu.busyPercent) && (v.cpu.busyPercent === null || v.cpu.busyPercent <= 100)
    && (v.cpu.loadAverage === null || (Array.isArray(v.cpu.loadAverage) && v.cpu.loadAverage.length === 3 && v.cpu.loadAverage.every(num)))
    && fields(v.memory, ['totalBytes', 'freeBytes', 'usedBytes']) && ['totalBytes', 'freeBytes', 'usedBytes'].every((k) => num(v.memory[k]))
    && (v.network === null || (fields(v.network, ['interfaces']) && Array.isArray(v.network.interfaces) && v.network.interfaces.every((n: any) =>
      fields(n, ['name', 'rxBytes', 'txBytes', 'rxBytesPerSecond', 'txBytesPerSecond']) && typeof n.name === 'string' && num(n.rxBytes) && num(n.txBytes) && optional(n.rxBytesPerSecond) && optional(n.txBytesPerSecond))))
    && (v.gpu === null || (Array.isArray(v.gpu) && v.gpu.every((g: any) => fields(g, ['index', 'utilizationPercent', 'memoryUsedBytes', 'memoryTotalBytes', 'temperatureC', 'powerWatts'])
      && Number.isInteger(g.index) && g.index >= 0 && ['utilizationPercent', 'memoryUsedBytes', 'memoryTotalBytes', 'temperatureC', 'powerWatts'].every((k) => optional(g[k]))
      && (g.utilizationPercent === null || g.utilizationPercent <= 100))))
    && (v.pressure === undefined || v.pressure === null || (fields(v.pressure, ['availableBytes', 'compressedBytes', 'swapUsedBytes', 'swapTotalBytes',
      'swapInPages', 'swapOutPages', 'swapInPagesPerSecond', 'swapOutPagesPerSecond', 'level', 'memoryStallSomeUs', 'memoryStallFullUs', 'ioStallSomeUs', 'ioStallFullUs'])
      && [null, 'normal', 'warning', 'critical'].includes(v.pressure.level)
      && ['availableBytes', 'compressedBytes', 'swapUsedBytes', 'swapTotalBytes', 'swapInPages', 'swapOutPages', 'swapInPagesPerSecond',
        'swapOutPagesPerSecond', 'memoryStallSomeUs', 'memoryStallFullUs', 'ioStallSomeUs', 'ioStallFullUs'].every((k) => optional(v.pressure[k]))))
    && (v.disk === undefined || v.disk === null || (fields(v.disk, ['intervalMs', 'devices']) && optional(v.disk.intervalMs) && Array.isArray(v.disk.devices)
      && v.disk.devices.length <= 32 && v.disk.devices.every((d: any) => fields(d, ['name', 'readBytes', 'writeBytes', 'readOperations', 'writeOperations', 'transferredBytes', 'transfers',
        'readBytesPerSecond', 'writeBytesPerSecond', 'bytesPerSecond']) && typeof d.name === 'string' && d.name.length < 256
        && ['transferredBytes', 'transfers'].every((k) => num(d[k])) && ['readBytes', 'writeBytes', 'readOperations', 'writeOperations', 'readBytesPerSecond', 'writeBytesPerSecond', 'bytesPerSecond'].every((k) => optional(d[k])))))
    && (v.filesystems === undefined || v.filesystems === null || (fields(v.filesystems, ['volumes']) && Array.isArray(v.filesystems.volumes) && v.filesystems.volumes.length <= 4
      && v.filesystems.volumes.every((f: any) => fields(f, ['path', 'device', 'totalBytes', 'freeBytes', 'availableBytes']) && typeof f.path === 'string' && f.path.length <= 4096
        && typeof f.device === 'string' && f.device.length < 256 && ['totalBytes', 'freeBytes', 'availableBytes'].every((k) => num(f[k])))))
    && (v.processes === undefined || v.processes === null || (fields(v.processes, ['roots', 'descendants', 'truncated', 'entries', 'unavailablePids']) && pids(v.processes.roots)
      && (v.processes.unavailablePids === undefined || pids(v.processes.unavailablePids))
      && ['tracked', 'unavailable'].includes(v.processes.descendants) && typeof v.processes.truncated === 'boolean' && Array.isArray(v.processes.entries)
      && v.processes.entries.length <= 128 && v.processes.entries.every((p: any) => fields(p, ['pid', 'parentPid', 'startId', 'cpuTimeUs', 'residentBytes', 'readBytes', 'writeBytes'])
        && Number.isSafeInteger(p.pid) && p.pid > 0 && Number.isSafeInteger(p.parentPid) && p.parentPid >= 0 && typeof p.startId === 'string' && p.startId.length <= 256
        && num(p.cpuTimeUs) && num(p.residentBytes) && optional(p.readBytes) && optional(p.writeBytes))))
    && (v.health === undefined || (fields(v.health, ['collectorDurationMs', 'skippedTotal']) && num(v.health.collectorDurationMs) && Number.isSafeInteger(v.health.skippedTotal) && v.health.skippedTotal >= 0))
    && (v.sessionResources === undefined || v.sessionResources === null || validSessionActivity(v.sessionResources))
    && Array.isArray(v.unavailable) && v.unavailable.every((u: any) => fields(u, ['metric', 'reason']) && ['cpu', 'network', 'gpu', 'disk', 'pressure', 'filesystems', 'processes', 'sessions'].includes(u.metric)
      && ['collector-not-installed', 'collector-timeout', 'collector-unavailable', 'counter-reset-or-no-delta', 'warming-up',
        'disabled', 'unsupported-platform', 'gpu-asleep', 'gpu-power-state-unknown'].includes(u.reason));
}

function pids(v: any): boolean { return Array.isArray(v) && v.length <= 128 && v.every((n: any) => Number.isSafeInteger(n) && n > 0); }
export function validResourceRecording(v: any): v is ResourceRecording {
  const fields = (o: any, keys: string[]) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
  const num = (n: any) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const optional = (n: any) => n === null || num(n);
  return fields(v, ['rec', 'id', 'startedTs', 'stoppedTs', 'context', 'health']) && v.rec === 'resource-recording'
    && typeof v.id === 'string' && v.id.length > 0 && Number.isSafeInteger(v.startedTs) && v.startedTs >= 0 && (v.stoppedTs === null || Number.isSafeInteger(v.stoppedTs) && v.stoppedTs >= v.startedTs)
    && fields(v.context, ['hostname', 'platform', 'arch', 'osRelease', 'cpuModel', 'gpuModels', 'logicalCores', 'totalMemoryBytes', 'toolVersion', 'gpuMode', 'rootPids', 'sessionBindings', 'paths', 'cpuLimitCores', 'memoryLimitBytes'])
    && (v.context.sessionBindings === undefined || validBindings(v.context.sessionBindings))
    && (v.context.gpuModels === undefined || Array.isArray(v.context.gpuModels) && v.context.gpuModels.length <= 32 && v.context.gpuModels.every((s: any) => typeof s === 'string' && s.length <= 256))
    && ['hostname', 'platform', 'arch', 'osRelease', 'cpuModel', 'toolVersion'].every((k) => typeof v.context[k] === 'string' && v.context[k].length <= 512)
    && num(v.context.logicalCores) && num(v.context.totalMemoryBytes) && ['auto', 'off', 'always'].includes(v.context.gpuMode) && pids(v.context.rootPids)
    && Array.isArray(v.context.paths) && v.context.paths.length <= 4 && v.context.paths.every((p: any) => typeof p === 'string' && p.length <= 4096)
    && optional(v.context.cpuLimitCores) && optional(v.context.memoryLimitBytes)
    && fields(v.health, ['updatedTs', 'samples', 'skipped', 'lastDurationMs', 'effectiveIntervalMs', 'lastTs', 'lastError'])
    && ['updatedTs', 'samples', 'skipped', 'lastDurationMs', 'effectiveIntervalMs'].every((k) => num(v.health[k])) && optional(v.health.lastTs)
    && [null, 'Trace index busy; resource sample skipped', 'Trace index busy; resource batch pending', 'Resource sample could not be collected or stored; retrying'].includes(v.health.lastError);
}
