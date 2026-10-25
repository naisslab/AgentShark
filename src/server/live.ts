// The live index of a server (SPEC §5.1, §6). One process writes an index: a watching server that holds the index's writer
// lock leads, indexing in its index thread; every other server on the same index follows and only reads, and a follower
// takes over when the leader exits. Leader and followers alike tell their clients about changes from the index itself
// (IndexFeed: the run record the writer stores and the stored alarm rows), so the Mac app's engine and a `serve` in a
// terminal send the same `index-done` and `alarm` events, whichever of them started first.

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { DiscoverEnv } from '../adapters/adapter.ts';
import { discoverSources } from '../discover.ts';
import type { AnalysisStatus, InfoResult } from '../index/api.ts';
import { IndexOpenError, openIndex, READABLE_OLD_SCHEMAS } from '../index/db.ts';
import { AlarmTracker } from '../index/derive.ts';
import {
  acquireWriterLock, IndexBusyError, type IndexCounts, type IndexRunRecord, readIndexCounts, readRunRecord, writerLockOwner,
} from '../index/indexer.ts';
import type { AlarmThresholds } from '../model/types.ts';
import { IndexThread } from './index-thread.ts';
import { idleStatus, type IndexEventName, isBusy, LIVE_ANALYSIS_BUDGET_MS, LiveIndexer } from './server.ts';

/** How often every live server reads the index for changes, and a watching follower looks for a vacant writer lock. */
export const FEED_INTERVAL_MS = 1000;
/** How long a server waits for the writer to create a missing index before it gives up. */
const CREATE_WAIT_MS = 30_000;

export interface LiveOptions {
  indexPath: string;
  watch: boolean;
  watchIntervalMs: number;
  watchMinGapMs: number;
  /** Discovery roots (tests); the user's home by default. */
  env?: DiscoverEnv;
  emit(event: IndexEventName, data: unknown): void;
  /** Caches over the read connections drop what the changed sessions touched (null: everything). */
  onChanges(sessions: string[] | null): void;
  /** The index file was replaced (a promoted rebuild): read through this connection from now on. */
  onReopen(reader: DatabaseSync): void;
}

/** The `/api/info` fields a live server knows beyond the counts. */
export type LiveInfo = Pick<InfoResult, 'indexing' | 'watch' | 'lastIndexOkAt' | 'lastIndexError' | 'lastChangeAt'>;

export class LiveIndex {
  /** The HTTP thread's read-only connection. */
  reader!: DatabaseSync;
  /** This process's indexer: a watching server's while it leads, or a server's without watch for its own runs. */
  indexer: LiveIndexer | null = null;
  /** What changed in the index, and the counts `/api/info` reports. */
  feed!: IndexFeed;
  private readonly opts: LiveOptions;
  private readerIno: number | null = null;
  private thread: IndexThread | null = null;
  private release: (() => void) | null = null;
  private marker: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  /** A takeover or a step down in progress. */
  private switching = false;
  /** The leader's watch policy, as its watch marker states it (a follower's `watch`). */
  private leaderWatch: InfoResult['watch'] = { enabled: false, intervalMs: null };
  private readonly onExit = () => {
    removeWatchMarker(this.marker);
    this.release?.();
  };

  private constructor(opts: LiveOptions) {
    this.opts = opts;
  }

  /** Lead when the writer lock is free (creating a missing index), else follow; then start indexing or following. */
  static async open(opts: LiveOptions): Promise<LiveIndex> {
    const live = new LiveIndex(opts);
    process.on('exit', live.onExit);
    try {
      await live.lead().catch((err) => {
        if (!isBusy(err)) throw err;
      });
      ({ db: live.reader, ino: live.readerIno } = await openReader(opts.indexPath));
      live.feed = new IndexFeed(live, opts);
      if (opts.watch && !live.leading) live.checkWriter();
      if (!opts.watch) live.indexer = live.newIndexer();
      live.indexer?.start();
      live.timer = setInterval(() => live.tick(), FEED_INTERVAL_MS).unref();
      return live;
    } catch (err) {
      await live.close();
      throw err;
    }
  }

  get leading(): boolean {
    return this.thread !== null;
  }

  /** The pid of the process that writes the index when it is not this one. */
  get writer(): number | null {
    return this.leading ? null : writerLockOwner(this.opts.indexPath);
  }

  /** A follower reports the leader's watch policy: its clients see changes as they happen either way. */
  status(): LiveInfo {
    const off = { enabled: false, intervalMs: null };
    return {
      indexing: { ...(this.indexer?.status ?? idleStatus()) },
      watch: !this.opts.watch ? off : this.leading ? { enabled: true, intervalMs: this.opts.watchIntervalMs } : this.leaderWatch,
      lastIndexOkAt: this.feed.lastRunAt,
      lastIndexError: this.indexer?.lastError ?? null,
      lastChangeAt: this.feed.lastChangeAt,
    };
  }

  /** POST /api/reindex: false while a run is in flight, and on a follower (the leader indexes). */
  reindex(): boolean {
    return this.indexer?.start() ?? false;
  }

  /** Settings ▸ Alerts. A watching follower answers 409 index-busy: the leader holds the writer lock. */
  async setAlarmThresholds(t: Partial<AlarmThresholds>): Promise<AnalysisStatus> {
    if (!this.indexer) throw new IndexBusyError(writerLockOwner(this.opts.indexPath), true);
    let status: AnalysisStatus | undefined;
    await this.indexer.configure(() => this.write(async (thread) => (status = await thread.storeThresholds(t))));
    return status!;
  }

  /** Reopen the read connection on the file now at the index path; throws, keeping the old one, when it cannot be read. */
  reopen(): DatabaseSync {
    const { db, ino } = openReaderNow(this.opts.indexPath);
    const old = this.reader;
    this.reader = db;
    this.readerIno = ino;
    this.opts.onReopen(db);
    old.close();
    return db;
  }

  /** True when the file at the index path is no longer the one the reader has open. */
  replaced(): boolean {
    const ino = inode(this.opts.indexPath);
    return ino !== null && ino !== this.readerIno;
  }

  /**
   * Stop following and indexing. A run in flight is not awaited (a full index can take minutes): its thread, and the
   * writer lock, end with the process.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.indexer?.stop();
    if (!this.indexer?.current) {
      await this.unlead();
      process.off('exit', this.onExit);
    }
    this.reader?.close();
  }

  // -------------------------------------------------------------------------

  private newIndexer(): LiveIndexer {
    return new LiveIndexer({
      run: async (onProgress, sources) => {
        // Each stage of a staged run reaches the clients as soon as it is stored (SPEC §5.1).
        const result = await this.write((thread) => thread.run(onProgress, LIVE_ANALYSIS_BUDGET_MS, () => {
          if (!this.closed) this.feed.poll();
        }, sources));
        // The leader's own clients need not wait for the next tick.
        this.feed.poll();
        return result;
      },
      discover: () => discoverSources(this.opts.env),
      emit: this.opts.emit,
    });
  }

  /** Run `fn` on the index thread. A server without watch takes the writer lock for each run (IndexBusyError when taken). */
  private async write<T>(fn: (thread: IndexThread) => Promise<T>): Promise<T> {
    if (!this.thread) await this.lead();
    try {
      return await fn(this.thread!);
    } finally {
      if (!this.opts.watch) await this.unlead();
    }
  }

  /** Take the writer lock and start the index thread; a watching server then watches and indexes until it steps down. */
  private async lead(): Promise<void> {
    const release = acquireWriterLock(this.opts.indexPath);
    let thread: IndexThread;
    try {
      thread = await IndexThread.start(this.opts.indexPath, this.opts.env);
    } catch (err) {
      release();
      throw err;
    }
    // Closed while a takeover started the thread.
    if (this.closed) {
      await thread.close();
      return release();
    }
    this.thread = thread;
    this.release = release;
    if (!this.opts.watch) return;
    this.indexer = this.newIndexer();
    this.indexer.watch(this.opts.watchIntervalMs, undefined, this.opts.watchMinGapMs);
    this.marker = writeWatchMarker(this.opts.indexPath, this.opts.watchIntervalMs);
  }

  private async unlead(): Promise<void> {
    const thread = this.thread;
    this.thread = null;
    await thread?.close();
    removeWatchMarker(this.marker);
    this.marker = null;
    this.release?.();
    this.release = null;
  }

  /** Every FEED_INTERVAL_MS: report index changes, and check who writes the index. */
  private tick(): void {
    this.feed.poll();
    if (this.opts.watch && !this.switching) this.checkWriter();
  }

  /** A watching server takes over a vacant writer lock and steps down from a lost one; a follower notes the leader's watch policy. */
  private checkWriter(): void {
    const owner = writerLockOwner(this.opts.indexPath);
    if (this.leading && owner !== process.pid) {
      // Another process took the lock over at the same moment as this one (see acquireWriterLock): it writes alone.
      this.switch(async () => {
        const indexer = this.indexer;
        this.indexer = null;
        indexer?.stop();
        await indexer?.current;
        await this.unlead();
      });
    } else if (!this.leading && owner === null) {
      this.switch(async () => {
        await this.lead();
        this.indexer?.start();
      });
    } else if (!this.leading) {
      this.leaderWatch = readWatchMarker(this.opts.indexPath, owner!);
    }
  }

  private switch(fn: () => Promise<void>): void {
    this.switching = true;
    fn().catch((err) => {
      if (!isBusy(err)) console.error('agentshark: taking over the index failed:', err);
    }).finally(() => (this.switching = false));
  }
}

/**
 * Tells a server's clients what changed in the index, read from the index alone: `index-done` from the run record the
 * writer stores (meta.run_seq, meta.last_run), and `alarm` from the stored alarm rows (AlarmTracker). A writer that
 * stores no record (an older build) still moves meta.last_change_at; clients then refetch everything.
 */
type FeedSource = Pick<LiveIndex, 'reader' | 'reopen' | 'replaced'>;

export class IndexFeed {
  /** `/api/info` counts as the last changing run stored them; null for an index no run of this build has changed. */
  counts: IndexCounts | null = null;
  lastRunAt: number | null = null;
  lastChangeAt: number | null = null;
  /** Moves whenever the feed sees the index change (a key for caches of what it reads). */
  version = 0;
  private seq: number | null = null;
  private readonly tracker = new AlarmTracker();
  private readonly live: FeedSource;
  private readonly opts: Pick<LiveOptions, 'emit' | 'onChanges'>;

  constructor(live: FeedSource, opts: Pick<LiveOptions, 'emit' | 'onChanges'>) {
    this.live = live;
    this.opts = opts;
    this.baseline();
  }

  poll(): void {
    if (this.live.replaced()) return this.reopened();
    const db = this.live.reader;
    const m = runMeta(db);
    this.lastRunAt = m.runAt;
    if (m.seq === this.seq && m.changeAt === this.lastChangeAt) return;
    const record = m.seq !== this.seq ? readRunRecord(db) : null;
    const contiguous = record !== null && this.seq !== null && record.seq === this.seq + 1;
    this.mark(db, m);
    this.report(record, !contiguous || !!record?.changedSessionsTruncated);
  }

  private baseline(): void {
    const db = this.live.reader;
    this.mark(db, runMeta(db));
    this.tracker.reset(db);
  }

  private mark(db: DatabaseSync, m: ReturnType<typeof runMeta>): void {
    this.seq = m.seq;
    this.lastRunAt = m.runAt;
    this.lastChangeAt = m.changeAt;
    this.counts = readIndexCounts(db);
    this.version++;
  }

  /** A promoted rebuild replaced the file: every client refetches, and alarms count from the new file's rows. */
  private reopened(): void {
    try {
      this.live.reopen();
    } catch (err) {
      // This build cannot read the new file (an older one); the old connection keeps serving.
      if (!(err instanceof IndexOpenError)) throw err;
      return;
    }
    this.baseline();
    this.report(readRunRecord(this.live.reader), true);
  }

  private report(record: IndexRunRecord | null, truncated: boolean): void {
    const db = this.live.reader;
    const { seq: _, ...done } = record ?? { seq: 0, changedSessions: [], changedCount: 0 };
    if (truncated || done.changedSessions.length) this.opts.onChanges(truncated ? null : done.changedSessions);
    for (const alarm of this.tracker.changes(db)) this.opts.emit('alarm', alarm);
    this.opts.emit('index-done', {
      ...done,
      ...(truncated ? { changedSessionsTruncated: true } : {}),
      ...(!truncated && done.changedSessions.length ? { sessions: describeSessions(db, done.changedSessions) } : {}),
    });
  }
}

/** The run markers in meta: the record number, and the ends of the last run and of the last changing run (µs). */
function runMeta(db: DatabaseSync): { seq: number | null; runAt: number | null; changeAt: number | null } {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key IN ('run_seq', 'last_run_at', 'last_change_at')").all() as { key: string; value: string }[];
  const m = new Map(rows.map((r) => [r.key, Number(r.value)]));
  return { seq: m.get('run_seq') ?? null, runAt: m.get('last_run_at') ?? null, changeAt: m.get('last_change_at') ?? null };
}

/** Current counts of changed sessions, sent with index-done so clients can update rows without a refetch. */
function describeSessions(db: DatabaseSync, sessions: string[]): unknown[] {
  return db.prepare(`SELECT id, n_events AS nEvents, n_errors AS nErrors, start_ts AS start, end_ts AS end FROM sessions
    WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(sessions)) as unknown[];
}

function inode(path: string): number | null {
  return statSync(path, { throwIfNoEntry: false })?.ino ?? null;
}

/** A read-only connection, and the file it opened (statted first: a file replaced in between is reopened at the next poll). */
function openReaderNow(path: string): { db: DatabaseSync; ino: number | null } {
  const ino = inode(path);
  return { db: openIndex(path, { readOnly: true, acceptSchema: READABLE_OLD_SCHEMAS }), ino };
}

/** Like openReaderNow, but waits while the writer lock's holder creates the index. */
async function openReader(path: string): Promise<{ db: DatabaseSync; ino: number | null }> {
  for (const start = Date.now(); ; await new Promise((r) => setTimeout(r, 200))) {
    try {
      return openReaderNow(path);
    } catch (err) {
      if (!(err instanceof IndexOpenError) || writerLockOwner(path) === null || Date.now() - start > CREATE_WAIT_MS) throw err;
    }
  }
}

/** `<index>.watch.<pid>` beside the index while this process watches it (MCP `indexer` and followers read it); null when it cannot be written. */
function writeWatchMarker(indexPath: string, intervalMs: number): string | null {
  const path = `${indexPath}.watch.${process.pid}`;
  try {
    writeFileSync(path, JSON.stringify({ intervalMs, since: Date.now() * 1000 }));
    return path;
  } catch {
    return null;
  }
}

function removeWatchMarker(path: string | null): void {
  if (path) rmSync(path, { force: true });
}

function readWatchMarker(indexPath: string, pid: number): InfoResult['watch'] {
  try {
    const m = JSON.parse(readFileSync(`${indexPath}.watch.${pid}`, 'utf8'));
    return { enabled: true, intervalMs: typeof m.intervalMs === 'number' ? m.intervalMs : null };
  } catch {
    return { enabled: false, intervalMs: null };
  }
}
