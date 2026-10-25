// HTTP server (SPEC §2, §4.4, §6): static viewer, authenticated JSON API, Server-Sent Events,
// and the live-mode indexer that keeps the index current while the viewer is open.

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DiscoverEnv, SourceFile } from '../adapters/adapter.ts';
import type { AlarmThresholds } from '../model/types.ts';
import type { AnalysisStatus, DerivedQueries, InfoResult } from '../index/api.ts';
import type { IndexProgress, IndexRunResult } from '../index/indexer.ts';
import { DEFAULT_QUERY_TIMEOUT_MS, DEFAULT_QUERY_WORKERS, QueryHost, type ApiDerivedQueries, type ApiQueries } from './query-host.ts';
import { handleApi, sendJson } from './routes.ts';
import { runWorkbench, type WorkbenchDispatch } from './workbench.ts';

export const DEFAULT_WEB_ROOT = resolve(import.meta.dirname, '../../web');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// ---------------------------------------------------------------------------
// Server-Sent Events

export class EventHub {
  clients = new Set<ServerResponse>();
  timer: NodeJS.Timeout;
  hello: () => unknown;

  constructor(hello: () => unknown, heartbeatMs = 15_000) {
    this.hello = hello;
    // A comment line keeps idle connections open through proxies without waking client handlers.
    this.timer = setInterval(() => this.write(': heartbeat\n\n'), heartbeatMs);
    this.timer.unref();
  }

  add(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(frame('hello', this.hello()));
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  broadcast(event: string, data: unknown): void {
    this.write(frame(event, data));
  }

  write(chunk: string): void {
    for (const res of this.clients) res.write(chunk);
  }

  close(): void {
    clearInterval(this.timer);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Live indexing: single-flight runs, progress events, and cheap change detection for watch mode

export type IndexingStatus = InfoResult['indexing'];
/** SSE events of the index loop: progress, the end of a run, and one `alarm` per fired or cleared alarm. */
export type IndexEventName = 'index-progress' | 'index-done' | 'alarm';

export interface IndexerDeps {
  /** `sources` is the snapshot the run starts from, which the run uses instead of discovering again. */
  run: (onProgress: (p: IndexProgress) => void, sources?: SourceFile[]) => Promise<IndexRunResult>;
  discover: () => Promise<SourceFile[]>;
  /**
   * `index-progress`, and `index-done` for a run that failed. A run that succeeds is reported from the index by
   * IndexFeed (live.ts), like the runs of any other process.
   */
  emit: (event: IndexEventName, data: unknown) => void;
}

interface Snapshot {
  sources: SourceFile[];
  /** path → "size:mtimeMs" */
  files: Map<string, string>;
  /** Parent directories of the files → mtimeMs; a new file in a known directory changes it. */
  dirs: Map<string, number>;
  /** The files and directories that changed within HOT_WINDOW_MS of the snapshot: the ones agents are writing. */
  hotFiles: [string, string][];
  hotDirs: [string, number][];
  at: number;
  /** When every file and directory was last checked. */
  checkedAt: number;
}

const PROGRESS_EVERY_MS = 250;
/** Default watch policy: check every 3 s; while files keep changing, start a run at most every 5 s. */
export const WATCH_INTERVAL_MS = 3000;
export const WATCH_MIN_GAP_MS = 5000;
/**
 * Most sources are old sessions that never change again. Each tick stats only the files and directories that changed
 * within the last day; the rest are checked every COLD_CHECK_MS. Statting every file every tick cost about 120 ms of
 * CPU per 3 s on an index of 5,500 files, a steady 4% of a core while nothing changed.
 */
export const HOT_WINDOW_MS = 24 * 3600_000;
export const COLD_CHECK_MS = 60_000;
/** Live runs derive for at most this long; later trees wait for the next run (SPEC §12.10 acceptance 3). */
export const LIVE_ANALYSIS_BUDGET_MS = 3000;

export class LiveIndexer {
  status: IndexingStatus = { running: false, done: 0, total: 0, lastRunAt: null, lastRunMs: null };
  deps: IndexerDeps;
  current: Promise<void> | null = null;
  snapshot: Snapshot | null = null;
  timer: NodeJS.Timeout | null = null;
  /** A run requested by the watch loop, waiting for the minimum gap since the previous start. */
  pending: NodeJS.Timeout | null = null;
  stopped = false;
  minGapMs = 0;
  lastStartAt = 0;
  /** The error of the last run, null once a run succeeds. */
  lastError: string | null = null;
  /** The last run deferred analysis of some trees. */
  analysisPending = false;

  constructor(deps: IndexerDeps) {
    this.deps = deps;
  }

  /** Start an incremental run unless one is already running. */
  start(): boolean {
    if (this.current || this.stopped) return false;
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    this.lastStartAt = Date.now();
    this.current = this.run().finally(() => {
      this.current = null;
      // Trees past the live analysis budget wait in meta.analysis_pending; the next run derives them first.
      if (this.analysisPending && !this.stopped) this.request();
    });
    return true;
  }

  /**
   * Every `intervalMs`, stat the recently changed source files and directories, and every `coldMs` all of them; at
   * most every `rediscoverMs`, rerun discovery to catch new directories. Index when anything changed, but start runs at
   * least `minGapMs` apart: while an agent keeps writing, its bursts of appends coalesce into one run every few seconds.
   */
  watch(intervalMs = WATCH_INTERVAL_MS, rediscoverMs = 30_000, minGapMs = WATCH_MIN_GAP_MS, coldMs = COLD_CHECK_MS): void {
    this.minGapMs = minGapMs;
    const tick = async () => {
      try {
        if (!this.current && !this.pending && (await this.changed(rediscoverMs, coldMs))) this.request();
      } catch (err) {
        console.error('agentshark: watch check failed:', err);
      }
      if (!this.stopped) this.timer = setTimeout(tick, intervalMs).unref();
    };
    this.timer = setTimeout(tick, intervalMs).unref();
  }

  private request(): void {
    const wait = this.lastStartAt + this.minGapMs - Date.now();
    if (wait <= 0) {
      this.start();
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = null;
      this.start();
    }, wait);
    this.pending.unref();
  }

  /** Apply a change to the index settings once no run is in flight, then start a run that picks it up. */
  async configure(apply: () => unknown): Promise<void> {
    while (this.current) await this.current;
    await apply();
    this.start();
  }

  /** Stop watching and refuse new runs. A run in flight is not awaited: a full index can take minutes. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }

  async run(): Promise<void> {
    const t0 = Date.now();
    Object.assign(this.status, { running: true, done: 0, total: 0, currentPath: undefined, since: undefined });
    let lastSent = 0;
    try {
      // Snapshot before indexing, so a file that changes during the run differs at the next tick.
      this.snapshot = await takeSnapshot(this.deps.discover);
      const result = await this.deps.run((p) => {
        Object.assign(this.status, { done: p.done, total: p.total, currentPath: p.currentPath, since: p.since });
        const now = Date.now();
        if (now - lastSent >= PROGRESS_EVERY_MS || p.done === p.total) {
          lastSent = now;
          this.deps.emit('index-progress', { done: p.done, total: p.total, currentPath: p.currentPath, since: p.since });
        }
      }, this.snapshot.sources);
      this.lastError = null;
      this.analysisPending = !!result.analysis?.pending;
    } catch (err) {
      this.lastError = (err as Error).message ?? String(err);
      // Another writer had the index: the files are not indexed yet, so the next watch tick must not see them as current.
      if (isBusy(err)) this.snapshot = null;
      this.deps.emit('index-done', { changedSessions: [], error: this.lastError });
    } finally {
      Object.assign(this.status, { running: false, currentPath: undefined, since: undefined, lastRunAt: Date.now() * 1000, lastRunMs: Date.now() - t0 });
    }
  }

  async changed(rediscoverMs: number, coldMs = COLD_CHECK_MS): Promise<boolean> {
    const snap = this.snapshot;
    if (!snap) return true;
    const all = Date.now() - snap.checkedAt >= coldMs;
    const fileSigs = await Promise.all((all ? [...snap.files] : snap.hotFiles).map(async ([path, sig]) => (await fileSig(path)) !== sig));
    if (fileSigs.includes(true)) return true;
    const dirSigs = await Promise.all((all ? [...snap.dirs] : snap.hotDirs).map(async ([dir, mtime]) => (await statOrNull(dir))?.mtimeMs !== mtime));
    if (dirSigs.includes(true)) return true;
    if (all) snap.checkedAt = Date.now();
    if (Date.now() - snap.at < rediscoverMs) return false;
    const fresh = await takeSnapshot(this.deps.discover);
    if (fresh.files.size !== snap.files.size || [...fresh.files].some(([path, sig]) => snap.files.get(path) !== sig)) return true;
    this.snapshot = fresh;
    return false;
  }
}

/** The index was locked by another process (`IndexBusyError`) or SQLite gave up waiting for it (SQLITE_BUSY, SQLITE_LOCKED). */
export function isBusy(err: unknown): boolean {
  const e = err as { name?: string; errcode?: number };
  return e?.name === 'IndexBusyError' || (e?.errcode !== undefined && [5, 6].includes(e.errcode & 0xff));
}

async function takeSnapshot(discover: () => Promise<SourceFile[]>): Promise<Snapshot> {
  const at = Date.now();
  const sources = await discover();
  const files = new Map(sources.map((f) => [f.path, `${f.size}:${f.mtimeMs}`]));
  const dirs = new Map<string, number>();
  await Promise.all(
    [...new Set(sources.map((f) => dirname(f.path)))].map(async (dir) => {
      const st = await statOrNull(dir);
      if (st) dirs.set(dir, st.mtimeMs);
    }),
  );
  const hot = at - HOT_WINDOW_MS;
  const hotFiles = sources.filter((f) => f.mtimeMs >= hot).map((f): [string, string] => [f.path, files.get(f.path)!]);
  const hotDirs = [...dirs].filter(([, mtime]) => mtime >= hot);
  return { sources, files, dirs, hotFiles, hotDirs, at, checkedAt: at };
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function fileSig(path: string): Promise<string> {
  const st = await statOrNull(path);
  return st ? `${st.size}:${st.mtimeMs}` : 'missing';
}

export function idleStatus(): IndexingStatus {
  return { running: false, done: 0, total: 0, lastRunAt: null, lastRunMs: null };
}

// ---------------------------------------------------------------------------
// HTTP layer

export interface HttpOptions {
  port: number;
  queries: ApiQueries;
  /** The derived routes (SPEC §12.5). Absent: they answer 501 not-implemented. */
  derived?: ApiDerivedQueries;
  workbench?: WorkbenchDispatch;
  mode: 'live' | 'capture';
  /** POST /api/reindex (live mode): start a run; false while one runs or another process writes the index. */
  reindex?: () => boolean;
  /** Settings ▸ Alerts (live mode): store alarm thresholds and re-derive. */
  setAlarmThresholds?: (t: Partial<AlarmThresholds>) => Promise<AnalysisStatus>;
  webRoot?: string;
  /** Fields of the stream's hello frame beyond `mode` (indexing status, watch policy, capture header). */
  hello?: () => Record<string, unknown>;
}

export interface HttpServer {
  url: string;
  port: number;
  token: string;
  hub: EventHub;
  close(): Promise<void>;
}

/** Listen on 127.0.0.1 and serve the viewer and API. Rejects with EADDRINUSE when the port is taken. */
export async function startHttpServer(opts: HttpOptions): Promise<HttpServer> {
  const token = randomBytes(32).toString('hex');
  const webRoot = resolve(opts.webRoot ?? DEFAULT_WEB_ROOT);
  const hub = new EventHub(() => ({ mode: opts.mode, indexing: idleStatus(), ...(opts.hello?.() ?? {}) }));
  const api = {
    queries: opts.queries,
    derived: opts.derived,
    workbench: opts.workbench,
    reindex: opts.mode === 'live' ? opts.reindex : undefined,
    setAlarmThresholds: opts.mode === 'live' ? opts.setAlarmThresholds : undefined,
    openStream: (res: ServerResponse) => hub.add(res),
  };
  let port = opts.port;
  // Several servers on one host share a cookie jar regardless of port, so the cookie name carries the port.
  const cookieName = () => `as_token_${port}`;

  // Session lists travel in query strings, so allow URLs beyond Node's 16 KiB header default.
  const server = createServer({ maxHeaderSize: 256 << 10 }, (req, res) => {
    handle(req, res).catch((err) => {
      console.error('agentshark: request failed:', err);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const host = req.headers.host ?? '';
    // DNS rebinding: a hostile name resolving to 127.0.0.1 still carries its own Host header.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return sendError(req, res, 403, 'bad-host', 'Requests must use 127.0.0.1 or localhost with this port');
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    const authed = hasToken(req, token, cookieName());

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) {
        return sendError(req, res, 403, 'bad-origin', 'Cross-origin API requests are not allowed');
      }
      if (!authed) return sendError(req, res, 401, 'unauthorized', 'Missing or invalid AgentShark token');
      return handleApi(api, req, res, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendPage(res, 405, 'Method not allowed.');
    }
    const launchToken = url.searchParams.get('token');
    if (['/', '/workbench.html'].includes(url.pathname) && launchToken !== null) {
      if (!tokenMatches(launchToken, token)) {
        return sendPage(res, 403, 'This link is from an earlier AgentShark run. Use the URL printed by <code>agentshark serve</code>.');
      }
      url.searchParams.delete('token');
      res.writeHead(302, {
        'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        Location: url.pathname + url.search,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    if (!authed) {
      return sendPage(res, 401, 'Open AgentShark with the URL printed by <code>agentshark serve</code>; it carries an access token.');
    }
    return serveStatic(req, res, url, webRoot);
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    hub,
    close: () =>
      new Promise<void>((resolveClose) => {
        hub.close();
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}

function hasToken(req: IncomingMessage, token: string, cookieName: string): boolean {
  const header = req.headers['x-agentshark-token'];
  if (typeof header === 'string' && tokenMatches(header, token)) return true;
  const cookie = req.headers.cookie;
  if (!cookie) return false;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === cookieName && tokenMatches(part.slice(eq + 1).trim(), token)) return true;
  }
  return false;
}

function tokenMatches(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function sendError(req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string): Promise<void> {
  await sendJson(req, res, status, { error: { message, code } });
}

function sendPage(res: ServerResponse, status: number, html: string): void {
  const body = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>AgentShark</title>` +
    `<p style="font:15px system-ui;margin:3em auto;max-width:40em">${html}</p>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL, webRoot: string): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendPage(res, 400, 'Malformed URL.');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = resolve(webRoot, '.' + rel);
  // Reject anything that resolves outside web/ (encoded "..", backslashes, NUL) and dotfiles.
  const inside = file.startsWith(webRoot + sep) && !file.includes('\0');
  if (!inside || file.slice(webRoot.length).split(sep).some((seg) => seg.startsWith('.'))) {
    return sendPage(res, 404, 'Not found.');
  }
  const st = await statOrNull(file);
  if (!st?.isFile()) return sendPage(res, 404, 'Not found.');

  const ext = extname(file).toLowerCase();
  const headers: Record<string, string | number> = {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    // Always revalidate, so an edited web/ file shows up on the next reload.
    'Cache-Control': 'no-cache',
  };
  let data: Buffer;
  if (ext === '.html') {
    data = await readFile(file);
    headers['Content-Security-Policy'] = contentSecurityPolicy(data.toString('utf8'));
  } else {
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    data = await readFile(file);
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

/**
 * The viewer renders agent output, which can contain arbitrary markup. Scripts are limited to
 * files from web/ plus the page's own inline scripts (allowed by hash), so injected markup cannot run.
 */
function contentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
  );
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// ---------------------------------------------------------------------------
// Entry point used by the CLI (docs/MODULES.md)

export interface StartServerOptions {
  port: number;
  host?: '127.0.0.1';
  open?: boolean;
  watch?: boolean;
  /** Capture mode: the loaded capture index. A live server opens the index at `indexPath` itself (live.ts). */
  db?: DatabaseSync;
  mode: 'live' | 'capture';
  indexPath: string;
  capturePath?: string;
  /** Live mode: the discovery roots (tests); the user's home by default. */
  env?: DiscoverEnv;
  /** Query worker threads (default 2); 0 answers every request on the HTTP thread (tests, `:memory:` indexes). */
  queryWorkers?: number;
  /** Budget of one query in a worker before it is stopped with 503 query-timeout. */
  queryTimeoutMs?: number;
  /** Watch policy (live mode with watch). */
  watchIntervalMs?: number;
  watchMinGapMs?: number;
  /** Receives the same index events the SSE stream carries (the CLI prints them). */
  onIndex?: (event: IndexEventName, data: any) => void;
}

export interface StartedServer {
  url: string;
  port: number;
  token: string;
  /** Live mode: the pid of the process that writes the index when it is not this one (this server follows it). */
  writer?: number | null;
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions): Promise<StartedServer> {
  // Loaded on demand so the HTTP layer and its tests do not pull in the indexer and adapters.
  const [{ createQueries }, { createDerivedQueries }] = await Promise.all([import('../index/queries.ts'), import('../index/derived-queries.ts')]);
  let hub: EventHub | null = null;
  let host: QueryHost | null = null;
  let api: ApiQueries | null = null;
  let local!: ReturnType<typeof createQueries>;
  let localDerived!: DerivedQueries;
  let workbench!: WorkbenchDispatch;
  let captureNow: number | undefined;
  const connect = (db: DatabaseSync) => {
    local = createQueries(db, {
      mode: opts.mode, indexPath: opts.indexPath, capturePath: opts.capturePath,
      getIndexing: () => live?.status().indexing ?? idleStatus(), getLive: live ? () => live.status() : undefined,
    });
    // A capture reads as it did when it was written: its derived clock stops at the capture's creation time.
    if (opts.mode === 'capture') {
      const capture = local.info().capture;
      captureNow ??= capture?.analysis?.clock ?? capture?.createdAt ?? undefined;
    }
    localDerived = createDerivedQueries(db, {
      mode: opts.mode, indexPath: opts.indexPath, resolveView: local.resolveView, ...(captureNow != null && { now: () => captureNow! }),
    });
    workbench = (operation, input) => runWorkbench(db, operation, input, { mode: opts.mode, indexPath: opts.indexPath, now: captureNow });
  };
  const live = opts.mode === 'live' ? await (await import('./live.ts')).LiveIndex.open({
    indexPath: opts.indexPath, watch: opts.watch ?? false, env: opts.env,
    watchIntervalMs: opts.watchIntervalMs ?? WATCH_INTERVAL_MS, watchMinGapMs: opts.watchMinGapMs ?? WATCH_MIN_GAP_MS,
    emit: (event, data) => {
      hub?.broadcast(event, data);
      opts.onIndex?.(event, data);
    },
    onChanges: (sessions) => {
      api?.noteChanges(sessions);
      if (!host) localDerived.noteChanges(sessions);
    },
    onReopen: (db) => {
      connect(db);
      host?.reopen(local, localDerived);
    },
  }) : null;
  try {
    connect(live ? live.reader : opts.db!);
    const workers = opts.indexPath === ':memory:' ? 0 : (opts.queryWorkers ?? envInt('AGENTSHARK_QUERY_WORKERS') ?? DEFAULT_QUERY_WORKERS);
    if (workers > 0) {
      host = new QueryHost({
        indexPath: opts.indexPath, mode: opts.mode, capturePath: opts.capturePath, local, localDerived, now: captureNow, workers,
        timeoutMs: opts.queryTimeoutMs ?? envInt('AGENTSHARK_QUERY_TIMEOUT_MS') ?? DEFAULT_QUERY_TIMEOUT_MS,
      });
    }
    api = host ? host.api() : current<ApiQueries>(() => local);
    if (live) {
      const { version } = await import('../cli/util.ts');
      // /api/info never counts rows on the HTTP thread: the writer stores the counts after every changing run. An index
      // no run of this build has changed is counted by a query worker, once per change.
      let counted: { version: number; info: Promise<InfoResult> } | null = null;
      api.info = async () => {
        let stored = live.feed.counts;
        if (!stored) {
          if (counted?.version !== live.feed.version) counted = { version: live.feed.version, info: Promise.resolve(host ? host.workerInfo() : local.info()) };
          const info = await counted.info;
          stored = { ...info.counts, firstTs: info.firstTs, lastTs: info.lastTs };
        }
        const { firstTs, lastTs, ...counts } = stored;
        return { version: version(), mode: 'live', indexPath: opts.indexPath, counts, firstTs, lastTs, ...live.status() };
      };
    }
    const http = await startHttpServer({
      port: opts.port, queries: api, derived: host ? host.derivedApi() : current<ApiDerivedQueries>(() => localDerived), mode: opts.mode,
      workbench: (operation, input) => host ? host.workbench(operation, input) : workbench(operation, input),
      reindex: live ? () => live.reindex() : undefined,
      setAlarmThresholds: live ? async (t) => {
        try {
          return await live.setAlarmThresholds(t);
        } catch (err) {
          // Another process (the Mac app's engine, a CLI run) holds the writer lock: the client may retry.
          if (isBusy(err)) throw Object.assign(new Error((err as Error).message), { status: 409, code: 'index-busy' });
          throw err;
        }
      } : undefined,
      hello: () => {
        if (live) return live.status();
        const info = local.info();
        return { watch: info.watch, lastIndexOkAt: info.lastIndexOkAt, lastIndexError: info.lastIndexError, lastChangeAt: info.lastChangeAt, ...(info.capture ? { capture: info.capture } : {}) };
      },
    });
    hub = http.hub;
    if (opts.open) openBrowser(http.url);
    return {
      url: http.url,
      port: http.port,
      token: http.token,
      ...(live && { writer: live.writer }),
      close: async () => {
        await http.close();
        await host?.close();
        await live?.close();
      },
    };
  } catch (err) {
    await host?.close();
    await live?.close();
    throw err;
  }
}

/** An API object whose methods call the current query object (a live server reopens its connection on a promoted rebuild). */
function current<T extends object>(get: () => object): T {
  const target = get() as Record<string, (...args: unknown[]) => unknown>;
  return Object.fromEntries(Object.keys(target).map((k) => [k, (...args: unknown[]) => (get() as typeof target)[k](...args)])) as T;
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
}

/** Open the URL in the default browser. Arguments go straight to the program, never through a shell. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['explorer.exe', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser launcher available; the CLI prints the URL anyway.
  }
}
