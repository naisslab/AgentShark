// Incremental indexing: discover sources, re-parse changed files in a worker pool, write, link (SPEC §5.1).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { availableParallelism } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { defaultEnv, emptyStats, sourceId, sourceRecFrom, type DiscoverEnv, type ParseStats, type SourceFile } from '../adapters/adapter.ts';
import { ADAPTERS } from '../adapters/registry.ts';
import { discoverSources } from '../discover.ts';
import type { AgentKind, AlarmThresholds } from '../model/types.ts';
import type { AlarmStreamEvent, IndexDoneAnalysis, InfoResult } from './api.ts';
import { analyze, nextIndexPath } from './db.ts';
import { analysisOutdated, type DeriveResult, runDerive, setAlarmThresholds } from './derive.ts';
import { runLinker } from './linker.ts';
import { parseFile, type WorkerReply, type WorkerRequest } from './worker.ts';
import { IndexWriter, type WriterRecord } from './writer.ts';

export interface IndexRunOptions {
  full?: boolean;
  agents?: AgentKind[];
  env?: DiscoverEnv;
  /** Worker threads; 0 parses in the main thread. Default min(cpus − 2, 8). */
  workers?: number;
  onProgress?: (p: IndexProgress) => void;
  /**
   * After each stage's record is stored but the last (a server announces it then instead of at its next poll). The
   * last stage is announced as a one-stage run is, after the run: by then the run no longer reports itself running.
   */
  onStage?: () => void;
  /** How long files share one commit (default GROUP_COMMIT_MS; tests use 0). */
  groupCommitMs?: number;
  /** A run parsing more bytes than this is staged (default STAGED_RUN_BYTES; tests use a few KB). */
  stageBytes?: number;
  /** Parse nothing and re-derive every tree (`agentshark index --rederive`); sources.indexed_at stays unchanged. */
  rederive?: boolean;
  /** The server's live runs pass 3,000: trees not derived within it wait in meta.analysis_pending. The CLI derives all. */
  analysisBudgetMs?: number;
  /** The caller holds the index's writer lock for as long as it serves (a live server's index thread). */
  lockHeld?: boolean;
  /**
   * The sources a caller has just discovered with the same env (the live watcher's snapshot), so the run does not
   * discover again; discovery reads every source directory and costs about 120 ms of CPU on a large machine.
   */
  sources?: SourceFile[];
}

/** Progress of a run: files parsed of those it parses, and in a staged run how far back history is complete. */
export interface IndexProgress {
  done: number;
  total: number;
  currentPath?: string;
  /** µs. Every changed file written after this time is indexed (planStages); absent until a stage of a staged run ends. */
  since?: number;
}

export interface IndexRunResult {
  sources: number;
  parsed: number;
  unchanged: number;
  removed: number;
  /** Events and spans written in this run. */
  events: number;
  spans: number;
  ms: number;
  changedSessions: string[];
  errors: { path: string; error: string }[];
  /** Peak resident memory of the process (parser workers included) so far, in MB. */
  peakRssMb: number;
  /**
   * Data changed beyond `changedSessions`, so every cache over the index is stale: another process committed to the
   * index since this connection's previous run or during this one, or an earlier run failed after committing files.
   */
  unlistedChanges?: boolean;
  /** The analysis pass (linker pass 6) of this run; absent when it did not run. */
  analysis?: { ms: number; pending: number; alarms: AlarmStreamEvent[] };
}

/** Another process holds the index's writer lock (`<index>.lock`); this run did nothing and can be retried. */
export class IndexBusyError extends Error {
  readonly owner: number | null;
  constructor(owner: number | null, serving = false) {
    super(`Another AgentShark process${owner ? ` (pid ${owner})` : ''} is updating this index; ` +
      (serving ? 'it keeps the index current while it serves.' : 'indexing resumes when it finishes.'));
    this.name = 'IndexBusyError';
    this.owner = owner;
  }
}

/** index-done lists at most this many changed sessions (a full index changes thousands); clients refetch the rest. */
export const CHANGED_SESSIONS_MAX = 2000;

/**
 * What `index-done` reports of one run (SPEC §6), stored in meta.last_run with its number in meta.run_seq, so every
 * server reading the index reports the same runs, whichever process wrote them.
 */
export interface IndexRunRecord {
  seq: number;
  sources: number;
  parsed: number;
  unchanged: number;
  removed: number;
  events: number;
  spans: number;
  ms: number;
  peakRssMb: number;
  errors: number;
  /** At most CHANGED_SESSIONS_MAX. */
  changedSessions: string[];
  changedCount: number;
  /** changedSessions is incomplete: cut at the maximum, or another process wrote the index (`unlistedChanges`). */
  changedSessionsTruncated?: true;
  analysis?: IndexDoneAnalysis;
}

/** `/api/info` counts and time range, stored in meta.index_counts by every run that changed the index. */
export type IndexCounts = InfoResult['counts'] & { firstTs: number | null; lastTs: number | null };

/** Files written since the last commit share one transaction for about this long (each file is a savepoint). */
const GROUP_COMMIT_MS = 500;

/**
 * A file's records are buffered and written in one transaction. Beyond this many buffered records
 * (multi-hundred-MB rollouts) the file is written batch by batch instead, which bounds memory;
 * its spans are still held back to the final batch so span depth resolves within one batch. The group
 * transaction is not committed while such a file is half written, so readers never see it half empty.
 */
const STREAM_THRESHOLD = 5000;
/** Files above this size are "big": at most MAX_BIG_IN_FLIGHT of them parse at once, other workers take small files. */
const BIG_FILE_BYTES = 50 << 20;
const MAX_BIG_IN_FLIGHT = 2;
/** A stage of at most this many files and bytes parses without worker threads (the live run of a working agent). */
const INLINE_MAX_FILES = 4;
const INLINE_MAX_BYTES = 32 << 20;
/** Heap limit of one parser worker: a pathological file fails its own job instead of the whole process. */
const WORKER_HEAP_MB = 4096;

interface SourceRow {
  id: string;
  path: string;
  agent: string;
  size: number | null;
  mtime_ms: number | null;
  ino: number | null;
  status: string;
  exists_now: number;
  sha256: string | null;
}

interface Job {
  file: SourceFile;
  id: string;
  pending: WriterRecord[];
  streaming: boolean;
  finished?: boolean;
  failed?: string;
}

/** `PRAGMA data_version` after each connection's last run; it changes only when another connection commits. */
const versionAfterRun = new WeakMap<DatabaseSync, number>();

/**
 * Index the sources into `db`. One process writes an index at a time: a web `serve` and the Mac app may share
 * one, and an index run holds its write transaction for seconds while a big file streams in, longer than the
 * other writer's busy timeout. A run that finds the lock taken throws `IndexBusyError` without writing.
 * Every run, or each stage of a staged run, ends by storing its record (IndexRunRecord) and, when it changed the
 * index, the counts of `/api/info`.
 */
export async function runIndex(db: DatabaseSync, opts: IndexRunOptions = {}): Promise<IndexRunResult> {
  const release = opts.lockHeld ? () => {} : acquireWriterLock(db.location());
  try {
    const seen = versionAfterRun.get(db);
    let before = dataVersion(db);
    let total: IndexRunResult | null = null;
    // Every stage stores its record, so servers announce each stage's sessions as it lands.
    for await (const { run, changed, last } of indexRun(db, opts)) {
      const after = dataVersion(db);
      const unlisted = (total === null && seen !== undefined && seen !== before) || after !== before;
      const result: IndexRunResult = unlisted ? { ...run, unlistedChanges: true } : run;
      versionAfterRun.set(db, after);
      before = after;
      recordRun(db, result, changed);
      total = total ? mergeStages(total, result) : result;
      if (!last) opts.onStage?.();
    }
    return total!;
  } finally {
    release();
  }
}

/** The result of a whole run from the results of its stages. */
function mergeStages(a: IndexRunResult, b: IndexRunResult): IndexRunResult {
  return {
    ...b,
    parsed: a.parsed + b.parsed,
    removed: a.removed + b.removed,
    events: a.events + b.events,
    spans: a.spans + b.spans,
    ms: a.ms + b.ms,
    changedSessions: [...new Set([...a.changedSessions, ...b.changedSessions])],
    errors: [...a.errors, ...b.errors],
    ...(a.unlistedChanges || b.unlistedChanges ? { unlistedChanges: true } : {}),
    ...(a.analysis || b.analysis
      ? { analysis: { ms: (a.analysis?.ms ?? 0) + (b.analysis?.ms ?? 0), pending: b.analysis?.pending ?? a.analysis!.pending, alarms: [...(a.analysis?.alarms ?? []), ...(b.analysis?.alarms ?? [])] } }
      : {}),
  };
}

/**
 * The end of a run, in one commit, so a reader never sees the run's markers move without its record: last_run_at and
 * last_run_ms, last_change_at when the run changed sessions or derived rows, the record, and the counts.
 */
function recordRun(db: DatabaseSync, r: IndexRunResult, changed: boolean): void {
  const { errors, changedSessions, unlistedChanges, analysis, ...counts } = r;
  const meta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const now = String(Date.now() * 1000);
  db.exec('BEGIN');
  try {
    put.run('last_run_at', now);
    put.run('last_run_ms', String(Math.round(r.ms)));
    if (changed) put.run('last_change_at', now);
    const record: IndexRunRecord = {
      seq: Number((meta.get('run_seq') as { value: string } | undefined)?.value ?? 0) + 1,
      ...counts, errors: errors.length, changedSessions: changedSessions.slice(0, CHANGED_SESSIONS_MAX), changedCount: changedSessions.length,
      ...(unlistedChanges || changedSessions.length > CHANGED_SESSIONS_MAX ? { changedSessionsTruncated: true } : {}),
      ...(analysis ? { analysis: { ms: Math.round(analysis.ms), pending: analysis.pending } } : {}),
    };
    put.run('run_seq', String(record.seq));
    put.run('last_run', JSON.stringify(record));
    if (changed || unlistedChanges || !meta.get('index_counts')) put.run('index_counts', JSON.stringify(countIndex(db)));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function countIndex(db: DatabaseSync): IndexCounts {
  const n = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const range = db.prepare('SELECT (SELECT min(ts) FROM events WHERE ts > 0) AS lo, (SELECT max(ts) FROM events) AS hi').get() as {
    lo: number | null; hi: number | null;
  };
  return { sources: n('sources'), sessions: n('sessions'), events: n('events'), spans: n('spans'), expert: n('expert'), firstTs: range.lo, lastTs: range.hi };
}

/** The record of the last run, if a run of this build wrote one (read-only connections may call it). */
export function readRunRecord(db: DatabaseSync): IndexRunRecord | null {
  return metaJson<IndexRunRecord>(db, 'last_run');
}

/** The counts the last changing run stored, if any (read-only connections may call it). */
export function readIndexCounts(db: DatabaseSync): IndexCounts | null {
  return metaJson<IndexCounts>(db, 'index_counts');
}

function metaJson<T>(db: DatabaseSync, key: string): T | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

/** Settings ▸ Alerts: store the thresholds under the writer lock; the next run re-derives every tree with them. */
export function storeAlarmThresholds(db: DatabaseSync, t: Partial<AlarmThresholds>, lockHeld = false): void {
  const release = lockHeld ? () => {} : acquireWriterLock(db.location());
  try {
    setAlarmThresholds(db, t);
  } finally {
    release();
  }
}

function dataVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
}

/** Lock files this process holds, so a stale lock carrying a recycled pid equal to ours is still taken over. */
const heldLocks = new Set<string>();

/** The index a connection writes: its own path, or the one whose new schema it builds at `<path>.next`. */
function indexOf(location: string): string {
  const next = nextIndexPath('');
  return location.endsWith(next) ? location.slice(0, -next.length) : location;
}

/** The pid of the live process that holds the index's writer lock, or null when it is free or stale. */
export function writerLockOwner(indexPath: string): number | null {
  const lock = `${indexOf(indexPath)}.lock`;
  const owner = readLockOwner(lock);
  return owner !== null && (owner === process.pid ? heldLocks.has(lock) : processAlive(owner)) ? owner : null;
}

/**
 * Take `<index>.lock` (it holds the owner's pid) or throw `IndexBusyError`; the returned function releases it. A lock
 * whose process is gone is stale and taken over. Two processes taking over the same stale lock at once can both
 * proceed: the file then names one of them, and a live server that finds another pid there stops writing
 * (writerLockOwner); SQLite serializes the writes meanwhile. In-memory indexes need no lock.
 */
export function acquireWriterLock(indexPath: string | null): () => void {
  if (!indexPath) return () => {};
  const index = indexOf(indexPath);
  const lock = `${index}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  if (heldLocks.has(lock)) throw new IndexBusyError(process.pid);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      heldLocks.add(lock);
      return () => {
        heldLocks.delete(lock);
        if (readLockOwner(lock) === process.pid) rmSync(lock, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = readLockOwner(lock);
      // An empty file is a lock being written right now, or one whose writer died before writing its pid.
      const stale = owner === null ? lockAgeMs(lock) > 10_000 : owner === process.pid || !processAlive(owner);
      if (!stale || attempt > 0) throw new IndexBusyError(owner, owner !== null && existsSync(`${index}.watch.${owner}`));
      rmSync(lock, { force: true });
    }
  }
}

function readLockOwner(lock: string): number | null {
  try {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function lockAgeMs(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return Infinity;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One stage of a run; `changed` says whether it changed sessions or derived rows (recordRun then moves meta.last_change_at). */
interface StageResult {
  run: IndexRunResult;
  changed: boolean;
  last: boolean;
}

/**
 * One run, as the stages it records (planStages): each stage parses its files, commits, links and derives their
 * sessions, and yields its result for runIndex to record. Most runs are one stage.
 */
async function* indexRun(db: DatabaseSync, opts: IndexRunOptions): AsyncGenerator<StageResult> {
  let t0 = performance.now();
  if (opts.rederive) {
    const d = runDerive(db, { markChange: false });
    const run: IndexRunResult = {
      sources: 0, parsed: 0, unchanged: 0, removed: 0, events: 0, spans: 0, ms: performance.now() - t0, changedSessions: [], errors: derivedErrors(d),
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024), analysis: analysisOf(d),
    };
    yield { run, changed: d.roots > 0, last: true };
    return;
  }
  const env: DiscoverEnv = { ...(opts.env ?? defaultEnv()), runAt: Date.now() };
  if (opts.agents) env.agents = opts.agents;
  const found = opts.sources && !opts.agents ? opts.sources : await discoverSources(env);
  const known = db
    .prepare('SELECT id, path, agent, size, mtime_ms, ino, status, exists_now, sha256 FROM sources')
    .all() as unknown as SourceRow[];
  const byPath = new Map(known.map((r) => [r.path, r]));

  // Sources that disappeared from disk (only among the agents this run looked at).
  const present = new Set(found.map((f) => f.path));
  const gone = known.filter((r) => r.exists_now && !present.has(r.path) && (!env.agents || env.agents.includes(r.agent as AgentKind)));
  const removed = gone.length;

  const changed = found.filter((f) => {
    const r = byPath.get(f.path);
    return opts.full || !r || !r.exists_now || r.status !== 'ok' || r.size !== f.size || r.mtime_ms !== f.mtimeMs || r.ino !== f.ino
      || (f.kind !== 'state-db' && !r.sha256);
  });
  // Files that depend on each other (Codex continuation pages) are re-parsed together when one changes or vanishes.
  const dirtyGroups = new Set<string>();
  for (const f of changed) addGroup(dirtyGroups, f.path);
  for (const r of known) if (r.exists_now && !present.has(r.path)) addGroup(dirtyGroups, r.path);
  if (dirtyGroups.size) {
    const queued = new Set(changed.map((f) => f.path));
    for (const f of found) if (!queued.has(f.path) && dirtyGroups.has(groupOf(f.path) ?? '')) changed.push(f);
  }
  // `--full` stays one stage: it clears the index first, and a full link after a first stage would drop the sessions
  // of every file later stages had yet to parse.
  const stages = planStages(changed, env.runAt!, opts.full ? Infinity : opts.stageBytes);

  // Each stage links the sessions it touched. A run that fails after committing some files would leave those
  // sessions unlinked (their files then look unchanged), so the first write of a run records that a full link is due,
  // and only the last stage's successful link clears it.
  const linkPending = db.prepare("SELECT 1 FROM meta WHERE key = 'link_pending'").get() !== undefined;
  if (changed.length || removed) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('link_pending', '1')").run();
  const firstRun = known.length === 0;
  const workers = opts.workers ?? Math.max(1, Math.min(availableParallelism() - 2, 8));
  let done = 0;

  // A big run writes gigabytes: a larger page cache and rarer checkpoints write each page fewer times. The WAL file
  // keeps at most 64 MB once a checkpoint resets it.
  const big = stages.length > 1;
  const pragma = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0];
  const saved = big ? ['cache_size', 'wal_autocheckpoint', 'journal_size_limit'].map((name) => `PRAGMA ${name} = ${pragma(name)}`) : [];
  if (big) db.exec('PRAGMA cache_size = -524288; PRAGMA wal_autocheckpoint = 100000; PRAGMA journal_size_limit = 67108864');
  let since: number | undefined;
  try {
    for (const [n, { files, since: stageSince }] of stages.entries()) {
      const first = n === 0;
      const last = n === stages.length - 1;
      const writer = new IndexWriter(db);
      const errors: IndexRunResult['errors'] = [];
      if (first) {
        for (const r of gone) writer.markSourceDeleted(r.id, r.path);
        // A full run over every agent clears the index in one go instead of replacing each file's rows.
        if (opts.full && !env.agents && known.length) writer.clearAll();
      }

      let events = 0;
      let spans = 0;
      const count = (records: WriterRecord[]) => {
        for (const r of records) {
          if (r.rec === 'event') events++;
          else if (r.rec === 'span') spans++;
        }
      };
      const jobs: Job[] = files.map((file) => ({ file, id: sourceId(file.path), pending: [], streaming: false }));
      const finish = (job: Job) => {
        job.pending = [];
        job.finished = true;
        opts.onProgress?.({ done: ++done, total: changed.length, currentPath: job.file.path, since });
      };
      const fail = (job: Job, error: string, parseMs: number) => {
        errors.push({ path: job.file.path, error });
        const src = sourceRecFrom(job.file, emptyStats());
        // A streamed file has already lost its old rows; otherwise they stay until the next successful parse.
        if (job.streaming) writer.putSource(src, { parseMs, status: 'error', error });
        else writer.markSourceError(src, error);
        finish(job);
      };

      // Per-file commits rewrite the same index pages into the WAL over and over, so files are grouped.
      // The group stays open across awaits; code sharing this connection meanwhile runs inside it.
      let groupStart = 0;
      const groupCommitMs = opts.groupCommitMs ?? GROUP_COMMIT_MS;
      const grouped = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
        if (!db.isTransaction) {
          db.exec('BEGIN');
          groupStart = performance.now();
        }
        try {
          fn(...args);
        } finally {
          // A file written batch by batch has lost its old rows; committing now would show it half empty.
          if (performance.now() - groupStart >= groupCommitMs && !jobs.some((j) => j.streaming && !j.finished)) commit();
        }
      };
      const commit = () => {
        writer.flushFts();
        db.exec('COMMIT');
      };

      const handlers: PoolHandlers = {
        batch(i, records) {
          const job = jobs[i];
          if (job.failed) return;
          try {
            job.pending.push(...records);
            if (!job.streaming && job.pending.length <= STREAM_THRESHOLD) return;
            const now = job.pending.filter((r) => r.rec !== 'span');
            job.pending = job.pending.filter((r) => r.rec === 'span');
            writer.transaction(() => {
              if (!job.streaming) writer.clearSource(job.id);
              writer.appendRecords(job.id, now);
            });
            job.streaming = true;
            count(now);
          } catch (err) {
            job.failed = String((err as Error).message ?? err);
          }
        },
        done(i, stats, parseMs) {
          const job = jobs[i];
          if (job.failed) return fail(job, job.failed, parseMs);
          const src = sourceRecFrom(job.file, stats);
          try {
            if (job.streaming) {
              writer.transaction(() => {
                writer.appendRecords(job.id, job.pending);
                writer.putSource(src, { parseMs });
              });
            } else {
              writer.replaceSource(src, job.pending, { parseMs });
            }
            count(job.pending);
            finish(job);
          } catch (err) {
            fail(job, String((err as Error).message ?? err), parseMs);
          }
        },
        error(i, error, parseMs) {
          fail(jobs[i], error, parseMs);
        },
      };
      // A live run re-parses a few small files: starting and compiling worker threads would cost more than the parsing
      // (a 10 MB transcript parses in about 80 ms), so such a stage parses on this thread.
      const small = opts.workers === undefined && files.length <= INLINE_MAX_FILES && files.reduce((n, f) => n + f.size, 0) <= INLINE_MAX_BYTES;
      try {
        await parseInPool(files, small ? 0 : workers, env, {
          batch: grouped(handlers.batch),
          done: grouped(handlers.done),
          error: grouped(handlers.error),
        });
      } catch (err) {
        // A write failed outside any one file (for example SQLITE_BUSY): the open group may hold a half-written file.
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
      if (db.isTransaction) commit();

      const budget = { budgetMs: opts.analysisBudgetMs, markChange: false };
      let derived: DeriveResult | null = null;
      // The sessions whose rows the linker rewrote beyond those the writer touched (a parent's child count, a copy's totals).
      let rewritten: string[] = [];
      if (files.length || removed || linkPending) {
        // The first stage links every session when a full link is due; on a first run those are its own.
        const all = first && (opts.full || firstRun || linkPending);
        const link = runLinker(db, all ? undefined : [...writer.touched], { derive: budget });
        derived = link.derive;
        rewritten = link.rewritten ?? [];
        if (last) db.prepare("DELETE FROM meta WHERE key = 'link_pending'").run();
        // Planner statistics (sampled, cheap): without them SQLite picks indexes for filtered views by guesswork. Only
        // the last stage measures: statistics of an index a first stage left nearly empty make SQLite scan the tables
        // that later stages fill.
        if (last) analyze(db);
      } else if (analysisOutdated(db)) {
        // Another build's analysis, or trees a live run deferred: re-derive without re-parsing.
        derived = runDerive(db, { ...budget, sessions: [] });
      }

      const run: IndexRunResult = {
        sources: found.length,
        parsed: files.length - errors.length,
        unchanged: found.length - changed.length,
        removed: first ? removed : 0,
        events,
        spans,
        ms: performance.now() - t0,
        changedSessions: [...new Set([...writer.touched, ...rewritten])],
        errors: derived ? [...errors, ...derivedErrors(derived)] : errors,
        peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
        ...(first && linkPending ? { unlistedChanges: true } : {}),
        ...(derived ? { analysis: analysisOf(derived) } : {}),
      };
      if (!last) {
        // Clients read how far back history is complete as soon as the stage lands (µs, whole: the Mac decodes Int64).
        since = Math.floor(stageSince * 1000);
        opts.onProgress?.({ done, total: changed.length, since });
      }
      yield { run, changed: writer.touched.size > 0 || rewritten.length > 0 || (derived?.roots ?? 0) > 0, last };
      t0 = performance.now();
    }
  } finally {
    if (saved.length) db.exec(saved.join('; '));
  }
}

/** A run larger than this (bytes to parse) is split into stages; smaller runs are one stage. */
const STAGED_RUN_BYTES = 64 << 20;
/** Files written this recently are live: when there are any, they alone make the first stage. */
const LIVE_STAGE_MS = 10 * 60_000;
/** Sources that are written continuously but hold no live session of their own: Codex's state database names every thread. */
const NEVER_LIVE: ReadonlySet<SourceFile['kind']> = new Set(['state-db']);

/**
 * Split a run's files into stages, newest first (SPEC §5.1): the live files, then the newest others in stages that
 * double in size from a quarter of `runBytes`, so a cold start shows live sessions within a second and fills history
 * in behind them. Files of one group (Codex continuation pages) stay in one stage. Within a stage, big files start
 * first for load balance.
 */
export function planStages(files: SourceFile[], now: number, runBytes = STAGED_RUN_BYTES): Stage[] {
  const bySize = (fs: SourceFile[]) => [...fs].sort((a, b) => b.size - a.size);
  if (files.reduce((sum, f) => sum + f.size, 0) <= runBytes) return [{ files: bySize(files), since: 0 }];
  const groups = new Map<string, SourceFile[]>();
  for (const f of files) {
    const key = groupOf(f.path) ?? f.path;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  const units = [...groups.values()].map((fs) => {
    const mtime = Math.max(...fs.map((f) => f.mtimeMs));
    return { fs, mtime, bytes: fs.reduce((sum, f) => sum + f.size, 0), live: now - mtime <= LIVE_STAGE_MS && fs.some((f) => !NEVER_LIVE.has(f.kind)) };
  });
  units.sort((a, b) => Number(b.live) - Number(a.live) || b.mtime - a.mtime);
  const stages: Stage[] = [];
  // After a stage, what is left starts with the newest file not yet indexed: everything written after it is.
  const take = (from: number, to: number) =>
    stages.push({ files: bySize(units.slice(from, to).flatMap((u) => u.fs)), since: units[to]?.mtime ?? 0 });
  let i = units.filter((u) => u.live).length;
  if (i) take(0, i);
  for (let budget = runBytes / 4; i < units.length; budget *= 2) {
    const from = i;
    for (let bytes = 0; i < units.length && (bytes < budget || i === from); i++) bytes += units[i].bytes;
    take(from, i);
  }
  return stages;
}

/** The files of one stage, and the write time (ms) of the newest file left after it: once it ends, all newer files are indexed. */
interface Stage {
  files: SourceFile[];
  since: number;
}

function analysisOf(d: DeriveResult): NonNullable<IndexRunResult['analysis']> {
  return { ms: d.ms, pending: d.pending.length, alarms: d.alarms };
}

/** A tree whose derivation failed is reported like a file that failed to parse. */
function derivedErrors(d: DeriveResult): IndexRunResult['errors'] {
  return (d.errors ?? []).map((e) => ({ path: `analysis of ${e.root}`, error: e.error.split('\n')[0] }));
}

function groupOf(path: string): string | undefined {
  for (const a of ADAPTERS) {
    const key = a.groupKey?.(path);
    if (key) return `${a.name}:${key}`;
  }
  return undefined;
}

function addGroup(groups: Set<string>, path: string): void {
  const key = groupOf(path);
  if (key) groups.add(key);
}

// ---------------------------------------------------------------------------
// Worker pool

interface PoolHandlers {
  batch(job: number, records: WriterRecord[]): void;
  done(job: number, stats: ParseStats, parseMs: number): void;
  error(job: number, error: string, parseMs: number): void;
}

/** Parse `files` with `size` workers, one file per worker at a time. Handlers run on the main thread. */
async function parseInPool(files: SourceFile[], size: number, env: DiscoverEnv, h: PoolHandlers): Promise<void> {
  if (size <= 0) {
    for (let i = 0; i < files.length; i++) {
      const t0 = performance.now();
      try {
        const { stats, parseMs } = await parseFile(files[i], (records) => h.batch(i, records), env);
        h.done(i, stats, parseMs);
      } catch (err) {
        h.error(i, String((err as Error)?.message ?? err), performance.now() - t0);
      }
    }
    return;
  }
  if (files.length === 0) return;
  // Files are handed out largest first, but big ones at most MAX_BIG_IN_FLIGHT at a time: eight 300 MB rollouts parsed
  // together would hold several GB of records. A worker that finds only big files waiting while the limit is reached
  // stays idle until a big file finishes.
  const taken = new Array<boolean>(files.length).fill(false);
  let remaining = files.length;
  let bigInFlight = 0;
  const idle: (() => void)[] = [];
  const isBig = (i: number) => files[i].size > BIG_FILE_BYTES;
  const take = (): number => {
    for (let i = 0; i < files.length; i++) {
      if (taken[i] || (isBig(i) && bigInFlight >= MAX_BIG_IN_FLIGHT)) continue;
      taken[i] = true;
      remaining--;
      if (isBig(i)) bigInFlight++;
      return i;
    }
    return -1;
  };
  let alive = 0;
  // A handler that throws (a write failed for a reason other than one file, such as SQLITE_BUSY) fails the whole
  // run: the workers stop and the promise rejects. Thrown inside a worker event listener it would crash the process.
  let failure: { error: unknown } | null = null;
  const pool = new Set<Worker>();
  const fail = (error: unknown) => {
    if (failure) return;
    failure = { error };
    remaining = 0;
    for (const w of pool) void w.terminate();
  };
  await new Promise<void>((resolve, reject) => {
    const spawn = () => {
      const acked = new SharedArrayBuffer(4);
      const ackCount = new Int32Array(acked);
      const worker = new Worker(new URL('./worker.ts', import.meta.url), {
        workerData: { agentsharkIndexWorker: true, acked },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
      pool.add(worker);
      alive++;
      let current = -1;
      let crash = 'worker exited';
      let retired = false;
      const release = () => {
        if (current >= 0 && isBig(current)) {
          bigInFlight--;
          // A big file finished: wake the workers that waited for the limit.
          for (const wake of idle.splice(0)) wake();
        }
        current = -1;
      };
      const feed = () => {
        if (remaining === 0) {
          retired = true;
          void worker.terminate();
          return;
        }
        const i = take();
        if (i < 0) {
          idle.push(feed);
          return;
        }
        current = i;
        worker.postMessage({ type: 'parse', job: current, file: files[current], env } satisfies WorkerRequest);
      };
      worker.on('message', (m: WorkerReply) => {
        if (failure) return;
        try {
          if (m.type === 'batch') {
            h.batch(m.job, m.records);
            Atomics.add(ackCount, 0, 1);
            Atomics.notify(ackCount, 0);
            return;
          }
          if (m.type === 'done') h.done(m.job, m.stats, m.parseMs);
          else h.error(m.job, m.error, m.parseMs);
          release();
          feed();
        } catch (err) {
          fail(err);
        }
      });
      worker.on('error', (err) => {
        crash = `worker crashed: ${err.message}`;
      });
      worker.on('exit', () => {
        alive--;
        pool.delete(worker);
        if (!retired && !failure) {
          try {
            if (current >= 0) h.error(current, crash, 0);
            release();
            if (remaining > 0) spawn();
          } catch (err) {
            fail(err);
          }
        }
        // Idle workers still waiting when every file is taken have nothing left to do.
        if (remaining === 0) for (const wake of idle.splice(0)) wake();
        if (alive === 0) {
          if (failure) reject(failure.error);
          else resolve();
        }
      });
      feed();
    };
    for (let i = 0; i < Math.min(size, files.length); i++) spawn();
  });
}
