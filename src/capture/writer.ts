// .agentcap writer (docs/FORMAT.md): selected sessions with their records, raw source lines and side files.

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { hostname, release } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createGzip, createZstdCompress } from 'node:zlib';
import { isCredentialPath, sha256 } from '../adapters/adapter.ts';
import { flagsFromBits } from '../index/writer.ts';
import { VerifiedSource } from '../raw/evidence.ts';
import { captureManifest, type CaptureAnalysisManifest } from './manifest.ts';
import { CaptureRedactor, type CaptureRedactionReport } from './redact.ts';
import type { AgentKind, BlobRec, EventRec, SessionRec, SourceKind, SourceRec, SpanRec } from '../model/types.ts';

export const CAPTURE_VERSION = 1;

export interface CaptureOptions {
  out: string;
  /** Shareable exports retain numeric measures/relations and remove arbitrary trace content. */
  profile?: 'forensic' | 'shareable';
  /** Optional secret identity key for pseudonyms stable across exports; never written into the capture. */
  redactionKey?: string;
  /** Perform the same selection and transformation, returning a preview without opening an output file. */
  dryRun?: boolean;
  previewLimit?: number;
  compress?: 'zstd' | 'gzip' | 'none';
  since?: number;
  until?: number;
  agents?: AgentKind[];
  sessions?: string[];
  filter?: string;
  raw?: boolean;
  sidecars?: boolean;
  /** Index the capture is taken from; recorded in the header. */
  indexPath?: string;
  /** Side files larger than this many bytes are left out (default 64 MiB). */
  blobMax?: number;
  onProgress?: (p: { done: number; total: number }) => void;
}

/** What the capture could not include, written to the trailer (docs/FORMAT.md §2.5). */
export interface CaptureCoverage {
  rawUnavailable: number;
  rawUnavailableBySource: Record<string, number>;
  rawOmitted: boolean;
  sidecarsOmitted: { path: string; role: string; reason: OmitReason }[];
  known: true;
}

type OmitReason = 'missing' | 'too-large' | 'credential' | 'unreadable';

export interface CaptureResult {
  path: string;
  bytes: number;
  counts: Record<string, number>;
  coverage: CaptureCoverage;
  ms: number;
  manifest?: CaptureAnalysisManifest;
  integrity?: { algorithm: 'sha256'; digest: string; records: number };
  preview?: CapturePreview;
}

export interface CapturePreview {
  profile: 'forensic' | 'shareable';
  counts: Record<string, number>;
  /** Forensic previews contain counts only, so a dry run does not accidentally print private records. */
  sample: unknown[];
  redaction?: CaptureRedactionReport;
  estimatedBytes: number;
}

export async function previewCapture(db: DatabaseSync, opts: Omit<CaptureOptions, 'out' | 'dryRun'> = {}): Promise<CapturePreview> {
  return (await writeCapture(db, { ...opts, out: '', dryRun: true })).preview!;
}

/** Side files larger than this are left out of a capture. */
const BLOB_MAX = 64 << 20;
const FLUSH_CHARS = 1 << 20;

const TOOL_VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version;

/** SQL NULL → absent field. */
const u = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export async function writeCapture(db: DatabaseSync, opts: CaptureOptions): Promise<CaptureResult> {
  // A read transaction pins all SELECTs to one generation while live writers continue in WAL mode.
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN');
  try { return await writeSnapshot(db, opts); }
  finally { if (own && db.isTransaction) db.exec('ROLLBACK'); }
}

async function writeSnapshot(db: DatabaseSync, opts: CaptureOptions): Promise<CaptureResult> {
  const t0 = performance.now();
  const shareable = opts.profile === 'shareable';
  const raw = !shareable && opts.raw !== false;
  const sidecars = !shareable && opts.sidecars !== false;
  const redactor = shareable ? new CaptureRedactor(opts.redactionKey) : undefined;
  const sessions = await selectSessions(db, opts);
  const sources = selectSources(db, sessions);
  const recordedClock = (db.prepare("SELECT value FROM meta WHERE key = 'capture_analysis_clock'").get() as { value: string } | undefined)?.value;
  const clock = recordedClock ? Number(recordedClock) : Date.now() * 1000;
  const manifest = captureManifest(db, clock, shareable);
  const counts: Record<string, number> = {
    sources: 0, sessions: 0, events: 0, spans: 0, expert: 0, enrich: 0, blobs: 0, rawUnavailable: 0,
  };
  const coverage: CaptureCoverage = { rawUnavailable: 0, rawUnavailableBySource: {}, rawOmitted: !raw, sidecarsOmitted: [], known: true };

  const out = new LineSink(opts.out, opts.compress ?? compressionFor(opts.out), !!opts.dryRun, redactor, opts.previewLimit);
  const lines = new RawLines(db, sources);
  try {
    await out.write({
      rec: 'capture', format: 'agentcap', version: CAPTURE_VERSION, created: Date.now() * 1000,
      tool: { name: 'agentshark', version: TOOL_VERSION },
      analysis: manifest,
      host: { hostname: hostname(), platform: process.platform, arch: process.arch, osRelease: release() },
      scope: {
        agents: opts.agents ?? null, since: opts.since ?? null, until: opts.until ?? null,
        sessions: opts.sessions ?? null, filter: opts.filter ?? null,
        // What the selection resolved to, and where it was read from.
        resolved: { sessions: sessions.length, sources: sources.size }, index: opts.indexPath ?? null,
      },
      options: { raw, sidecars },
    });
    for (const s of sources.values()) {
      const rec = sourceRec(s);
      // sha256 describes the bytes actually parsed, not whichever file happens to exist at export time.
      await out.write(rec);
      counts.sources++;
    }

    const blobs = new BlobWriter(out, counts, coverage, opts.blobMax ?? BLOB_MAX, db);
    const q = {
      session: db.prepare('SELECT * FROM sessions WHERE id = ?'),
      events: db.prepare(`SELECT e.*, p.attrs, p.native FROM events e LEFT JOIN event_payload p ON p.rid = e.rid
        WHERE e.session_id = ? ORDER BY e.seq, e.rid`),
      spans: db.prepare('SELECT * FROM spans WHERE session_id = ? ORDER BY depth, start_ts, id'),
      expert: db.prepare('SELECT * FROM expert WHERE session_id = ? ORDER BY id'),
      enrich: db.prepare('SELECT * FROM enrich WHERE session_id = ? ORDER BY src_id'),
    };
    let done = 0;
    for (const id of sessions) {
      const row = q.session.get(id) as Record<string, any> | undefined;
      if (!row) continue;
      await out.write(sessionRec(row));
      counts.sessions++;

      const withText = new Set<string>(); // only the first event of a source line carries its text
      const sessionSources = new Set<string>();
      for (const e of q.events.iterate(id) as Iterable<Record<string, any>>) {
        const rec = eventRec(e);
        sessionSources.add(e.src_id);
        const lineKey = `${e.src_id}:${e.src_line}`;
        if (raw && !withText.has(lineKey)) {
          withText.add(lineKey);
          const text = await lines.read(e.src_id, e.src_line, e.src_off, e.src_len);
          if (text === undefined) {
            counts.rawUnavailable++;
            coverage.rawUnavailable++;
            coverage.rawUnavailableBySource[e.src_id] = (coverage.rawUnavailableBySource[e.src_id] ?? 0) + 1;
          } else { rec.raw.text = text; rec.raw.sha256 = sha256(text); }
        }
        const persisted = rec.attrs.tool?.persisted_path;
        if (sidecars) for (const hash of rec.attrs.blob_refs ?? []) await blobs.addStored(hash);
        if (sidecars && typeof persisted === 'string' && persisted.includes('/tool-results/')) {
          const sha = await blobs.add(persisted, 'persisted-output');
          if (sha) rec.attrs.blob_refs = [...new Set([...(rec.attrs.blob_refs ?? []), sha])];
        }
        await out.write(rec);
        counts.events++;
      }
      await lines.close();

      for (const sp of q.spans.all(id) as Record<string, any>[]) {
        await out.write(spanRec(sp));
        counts.spans++;
      }
      for (const x of q.expert.all(id) as Record<string, any>[]) {
        await out.write(expertRec(x));
        counts.expert++;
      }
      for (const en of q.enrich.all(id) as Record<string, any>[]) {
        await out.write({ rec: 'enrich', session: en.session_id, fields: parse(en.fields), meta: parse(en.meta) ?? {}, src: en.src_id });
        counts.enrich++;
      }
      if (sidecars) {
        for (const srcId of sessionSources) {
          const s = sources.get(srcId);
          if (s) for (const [path, role] of await sidecarsOf(s.path, s.kind)) await blobs.add(path, role);
        }
      }
      opts.onProgress?.({ done: ++done, total: sessions.length });
    }

    // A whole-capture reexport must retain stored workflow sidecars even after their source directories disappear.
    if (sidecars && sessions.length === Number((db.prepare('SELECT count(*) n FROM sessions').get() as { n: number }).n)) {
      for (const row of db.prepare('SELECT sha256 FROM blobs ORDER BY sha256').iterate() as Iterable<{ sha256: string }>) await blobs.addStored(row.sha256);
    }

    // Diagnostics that belong to a captured source but to no session.
    const srcIds = [...sources.keys()];
    if (srcIds.length) {
      const loose = db
        .prepare(`SELECT * FROM expert WHERE session_id IS NULL AND src_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
        .all(JSON.stringify(srcIds)) as Record<string, any>[];
      for (const x of loose) {
        await out.write(expertRec(x));
        counts.expert++;
      }
    }

    // `complete` says the stream was written to its end; `coverage` says which evidence it could not include.
    await out.write({ rec: 'end', counts, complete: true, coverage, integrity: out.integrity() });
    await out.close();
  } catch (err) {
    await out.close().catch(() => {});
    throw err;
  } finally { await lines.close(); }
  const bytes = opts.dryRun ? out.bytes : (await stat(opts.out)).size;
  return { path: opts.dryRun ? '' : opts.out, bytes, counts, coverage, ms: performance.now() - t0, manifest, integrity: out.integrity(),
    ...(opts.dryRun ? { preview: { profile: opts.profile ?? 'forensic', counts, sample: out.sample,
      ...(redactor ? { redaction: redactor.report } : {}), estimatedBytes: out.bytes } } : {}) };
}

function compressionFor(path: string): 'zstd' | 'gzip' | 'none' {
  if (path.endsWith('.zst')) return 'zstd';
  if (path.endsWith('.gz')) return 'gzip';
  return 'none';
}

// ---------------------------------------------------------------------------
// Selection

/** Session ids in scope, oldest first. All criteria must hold. */
async function selectSessions(db: DatabaseSync, opts: CaptureOptions): Promise<string[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.agents?.length) {
    where.push(`ses.agent IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(opts.agents));
  }
  // Time scope on session time: the session overlaps [since, until].
  if (opts.since !== undefined) {
    where.push('COALESCE(ses.end_ts, ses.start_ts, ses.created_ts) >= ?');
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    where.push('COALESCE(ses.start_ts, ses.created_ts, ses.end_ts) <= ?');
    params.push(opts.until);
  }
  if (opts.sessions?.length) {
    where.push(`ses.id IN (
      WITH RECURSIVE tree(id) AS (
        SELECT value FROM json_each(?)
        UNION SELECT c.id FROM sessions c JOIN tree ON c.parent_id = tree.id)
      SELECT id FROM tree)`);
    params.push(JSON.stringify(opts.sessions));
  }
  if (opts.filter?.trim()) {
    // Loaded on demand: most captures have no filter.
    const { compileFilter } = await import('../filter/compile.ts');
    const f = compileFilter(opts.filter);
    const joins = f.joins.payload ? 'LEFT JOIN event_payload p ON p.rid = e.rid' : '';
    where.push(`ses.id IN (SELECT DISTINCT e.session_id FROM events e ${joins} WHERE ${f.sql})`);
    params.push(...f.params);
  }
  const rows = db
    .prepare(`SELECT ses.id FROM sessions ses ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
              ORDER BY COALESCE(ses.start_ts, ses.created_ts), ses.id`)
    .all(...params) as { id: string }[];
  return rows.map((r) => r.id);
}

interface SourceRow {
  id: string;
  agent: AgentKind;
  kind: SourceKind;
  path: string;
  size: number | null;
  mtime_ms: number | null;
  ino: number | null;
  parsed_bytes: number | null;
  lines: number;
  malformed: number;
  unknown: number;
  skipped: number;
  inherited: number;
  dialect: string | null;
  sha256: string | null;
}

/** Every source that contributed a row to a selected session. */
function selectSources(db: DatabaseSync, sessions: string[]): Map<string, SourceRow> {
  const ids = JSON.stringify(sessions);
  const rows = db
    .prepare(`
      WITH sel(id) AS (SELECT value FROM json_each(?))
      SELECT * FROM sources WHERE id IN (
        SELECT src_id FROM events WHERE session_id IN sel
        UNION SELECT src_id FROM spans WHERE session_id IN sel
        UNION SELECT src_id FROM expert WHERE session_id IN sel
        UNION SELECT src_id FROM enrich WHERE session_id IN sel
        UNION SELECT src_id FROM sessions WHERE id IN sel)
      ORDER BY path`)
    .all(ids) as unknown as SourceRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Rows → capture records. Records carry an extra `src` (the contributing source id) where the
// record type has no source field of its own, so a reader can attribute rows per source.

function parse(text: string | null): any {
  return text == null ? undefined : JSON.parse(text);
}

function sourceRec(s: SourceRow): SourceRec {
  return {
    rec: 'source', id: s.id, agent: s.agent, kind: s.kind, path: s.path, size: s.size ?? 0, mtimeMs: s.mtime_ms ?? 0,
    ino: u(s.ino), parsedBytes: u(s.parsed_bytes), lines: s.lines, malformed: s.malformed, unknown: s.unknown,
    skipped: s.skipped, inherited: s.inherited, dialect: u(s.dialect), sha256: u(s.sha256),
  };
}

/** Columns the linker filled from enrich rows are left out: the enrich records restore them. */
function sessionRec(r: Record<string, any>): SessionRec & { src?: string } {
  const applied: Record<string, unknown> = parse(r.meta_enriched)?.$applied ?? {};
  const own = (col: string) => (col in applied && applied[col] === r[col] ? undefined : u(r[col]));
  const git = { branch: own('git_branch'), commit: own('git_commit'), repo: own('git_repo') };
  const models = own('models');
  return {
    rec: 'session', id: r.id, agent: r.agent, nativeId: r.native_id, role: r.role, state: r.state,
    parentId: own('parent_id'), parentSpanId: u(r.parent_span_id), title: own('title'), cwd: own('cwd'),
    project: own('project'), git: git.branch || git.commit || git.repo ? git : undefined,
    models: models ? JSON.parse(models as string) : undefined, version: u(r.version), originator: u(r.originator),
    entrypoint: u(r.entrypoint), createdTs: u(r.created_ts), meta: parse(r.meta), src: u(r.src_id),
  };
}

function eventRec(e: Record<string, any>): EventRec {
  const flags = flagsFromBits(e.flag_bits);
  return {
    rec: 'event', id: e.id, session: e.session_id, ts: e.ts, tsSrc: e.ts_src, seq: e.seq, kind: e.kind, proto: e.proto,
    actor: e.actor, summary: e.summary, span: u(e.span_id), turn: u(e.turn_id), dur: u(e.dur), attrs: parse(e.attrs) ?? {},
    native: parse(e.native),
    raw: { source: e.src_id, line: e.src_line, offset: e.src_off, length: e.src_len, block: u(e.src_block) },
    flags: flags.length ? flags : undefined,
  };
}

function spanRec(s: Record<string, any>): SpanRec & { src: string } {
  return {
    rec: 'span', id: s.id, session: s.session_id, kind: s.kind, name: s.name ?? '', parent: u(s.parent_id),
    start: s.start_ts, end: u(s.end_ts), dur: u(s.dur), durSrc: s.dur_src ?? 'unknown', status: s.status ?? 'unknown',
    linkSession: u(s.link_session), firstEvent: u(s.first_event), lastEvent: u(s.last_event), attrs: parse(s.attrs) ?? {},
    src: s.src_id,
  };
}

function expertRec(x: Record<string, any>) {
  return {
    rec: 'expert', session: u(x.session_id), event: u(x.event_id), span: u(x.span_id), severity: x.severity,
    group: x.grp, message: x.message, src: u(x.src_id),
  };
}

// ---------------------------------------------------------------------------
// Raw source lines

interface OpenSource {
  fh: VerifiedSource | null;
  fromStore: boolean;
  buf: Buffer;
  start: number;
  len: number;
}

/**
 * Reads source lines by offset with a read-ahead buffer (events arrive in file order).
 * A capture index has no source files; its lines come from raw_store.
 */
class RawLines {
  private db: DatabaseSync;
  private sources: Map<string, SourceRow>;
  private open = new Map<string, OpenSource>();
  private hasStore: ReturnType<DatabaseSync['prepare']>;
  private fromStore: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync, sources: Map<string, SourceRow>) {
    this.db = db;
    this.sources = sources;
    this.hasStore = db.prepare('SELECT 1 FROM raw_store WHERE src_id = ? LIMIT 1');
    this.fromStore = db.prepare('SELECT text FROM raw_store WHERE src_id = ? AND line = ?');
  }

  async read(srcId: string, line: number, offset: number, length: number): Promise<string | undefined> {
    const s = this.sources.get(srcId);
    if (!s || s.kind === 'state-db' || !(length > 0)) return undefined;
    let o = this.open.get(srcId);
    if (!o) {
      const fromStore = !!this.hasStore.get(srcId);
      const fh = fromStore || isCredentialPath(s.path) ? null : await VerifiedSource.open(s.path,
        s.sha256 && s.parsed_bytes != null ? { sha256: s.sha256, bytes: s.parsed_bytes } : undefined).catch(() => null);
      o = { fh, fromStore, buf: Buffer.alloc(0), start: 0, len: 0 };
      this.open.set(srcId, o);
    }
    if (o.fromStore) return (this.fromStore.get(srcId, line) as { text: string } | undefined)?.text;
    if (!o.fh) return undefined;
    if (o.fh.fingerprint) {
      try { return (await o.fh.read(offset, length)).toString('utf8'); }
      catch { return undefined; }
    }
    // Legacy sources without fingerprints retain boundary checks, and never acquire a claimed indexed hash.
    const need = length + 1;
    if (offset < o.start || offset + need > o.start + o.len) {
      if (o.buf.length < need) o.buf = Buffer.allocUnsafe(Math.max(need, 1 << 20));
      const bytes = await o.fh.read(offset, Math.min(o.buf.length, Math.max(0, (s.size ?? 0) - offset))).catch(() => Buffer.alloc(0));
      const bytesRead = bytes.copy(o.buf);
      o.start = offset;
      o.len = bytesRead;
    }
    const at = offset - o.start;
    const avail = o.len - at;
    if (avail < length) return undefined; // file shrank or was rewritten
    const first = o.buf[at];
    const after = avail > length ? o.buf[at + length] : 10;
    if ((first !== 0x7b && first !== 0x5b) || after !== 10) return undefined; // not the indexed JSON line any more
    return o.buf.toString('utf8', at, at + length);
  }

  async close(): Promise<void> {
    for (const o of this.open.values()) await o.fh?.close();
    this.open.clear();
  }
}

// ---------------------------------------------------------------------------
// Side files

const MEDIA_TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.jsonl': 'application/x-ndjson',
  '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf',
};

/** Writes each distinct side file once, keyed by content hash, and records the ones it had to leave out. */
class BlobWriter {
  private out: LineSink;
  private counts: Record<string, number>;
  private coverage: CaptureCoverage;
  private max: number;
  private byPath = new Map<string, string | undefined>();
  private written = new Set<string>();
  private db: DatabaseSync;

  constructor(out: LineSink, counts: Record<string, number>, coverage: CaptureCoverage, max: number, db: DatabaseSync) {
    this.out = out;
    this.counts = counts;
    this.coverage = coverage;
    this.max = max;
    this.db = db;
  }

  async addStored(hash: string): Promise<string | undefined> {
    if (this.written.has(hash)) return hash;
    const row = this.db.prepare('SELECT * FROM blobs WHERE sha256 = ?').get(hash) as Record<string, any> | undefined;
    if (!row?.data) return undefined;
    const data = Buffer.from(row.data);
    if (data.length > this.max || sha256(data) !== hash) return undefined;
    const text = utf8OrUndefined(data);
    await this.out.write({ rec: 'blob', sha256: hash, size: data.length, mediaType: row.media_type,
      encoding: text === undefined ? 'base64' : 'utf8', origin: { path: row.origin_path, role: row.role }, data: text ?? data.toString('base64') });
    this.written.add(hash);
    this.counts.blobs++;
    return hash;
  }

  /** Returns the blob's sha256, or undefined when the file is missing, too large or off limits (recorded in coverage). */
  async add(path: string, role: string): Promise<string | undefined> {
    if (this.byPath.has(path)) return this.byPath.get(path);
    const stored = this.db.prepare('SELECT sha256 FROM blobs WHERE origin_path = ?').get(path) as { sha256: string } | undefined;
    if (stored) return this.addStored(stored.sha256);
    let sha: string | undefined;
    let reason: OmitReason | undefined;
    try {
      const st = await stat(path);
      if (isCredentialPath(path)) reason = 'credential';
      else if (!st.isFile()) reason = 'unreadable';
      else if (st.size > this.max) reason = 'too-large';
      else {
        const data = await readFile(path);
        sha = sha256(data);
        if (!this.written.has(sha)) {
          this.written.add(sha);
          const text = utf8OrUndefined(data);
          const rec: BlobRec = {
            rec: 'blob', sha256: sha, size: data.length,
            mediaType: MEDIA_TYPES[extname(path).toLowerCase()] ?? (text === undefined ? 'application/octet-stream' : 'text/plain'),
            encoding: text === undefined ? 'base64' : 'utf8',
            origin: { path, role },
            data: text ?? data.toString('base64'),
          };
          await this.out.write(rec);
          this.counts.blobs++;
        }
      }
    } catch (err) {
      sha = undefined;
      reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    if (reason) this.coverage.sidecarsOmitted.push({ path, role, reason });
    this.byPath.set(path, sha);
    return sha;
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function utf8OrUndefined(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return UTF8.decode(data);
  } catch {
    return undefined;
  }
}

/** Side files of a transcript: subagent meta.json, workflow summaries and journals. */
async function sidecarsOf(path: string, kind: SourceKind): Promise<[string, string][]> {
  const dir = dirname(path);
  const name = basename(path);
  const out: [string, string][] = [];
  if (kind === 'subagent-transcript' || kind === 'workflow-transcript') {
    const m = /^agent-(.+?)(-[0-9a-f]{16})?\.jsonl$/.exec(name);
    if (m) out.push([join(dir, `agent-${m[1]}.meta.json`), 'subagent-meta']);
  }
  if (kind === 'workflow-transcript') {
    // <sid>/subagents/workflows/<runId>/agent-*.jsonl → <sid>/workflows/<runId>.json
    out.push([join(dir, 'journal.jsonl'), 'workflow-journal']);
    out.push([join(dir, '..', '..', '..', 'workflows', basename(dir) + '.json'), 'workflow-summary']);
  }
  if (kind === 'transcript' && name.endsWith('.jsonl')) {
    const wfDir = join(dir, name.slice(0, -'.jsonl'.length), 'workflows');
    const files = await readdir(wfDir).catch(() => [] as string[]);
    for (const f of files) if (f.startsWith('wf_') && f.endsWith('.json')) out.push([join(wfDir, f), 'workflow-summary']);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output stream

/** JSON Lines writer with optional whole-stream compression and backpressure. */
class LineSink {
  private stream?: Writable;
  private done?: Promise<void>;
  private parts: string[] = [];
  private chars = 0;
  private hash = createHash('sha256');
  private records = 0;
  bytes = 0;
  sample: unknown[] = [];
  private dryRun: boolean;
  private redactor?: CaptureRedactor;
  private previewLimit: number;

  constructor(path: string, compress: 'zstd' | 'gzip' | 'none', dryRun = false, redactor?: CaptureRedactor, previewLimit = 8) {
    this.dryRun = dryRun;
    this.redactor = redactor;
    this.previewLimit = previewLimit;
    if (dryRun) return;
    const file = createWriteStream(path, { mode: 0o600 });
    const codec = compress === 'zstd' ? createZstdCompress() : compress === 'gzip' ? createGzip() : null;
    this.stream = codec ?? file;
    this.done = codec ? pipeline(codec, file) : finished(file);
    this.done.catch(() => {}); // surfaced by write() and close()
  }

  async write(rec: unknown): Promise<void> {
    if (this.redactor) rec = this.redactor.record(rec);
    const line = JSON.stringify(rec) + '\n';
    this.bytes += Buffer.byteLength(line);
    if ((rec as any).rec !== 'end') { this.hash.update(line); this.records++; }
    if (this.dryRun) {
      if (this.redactor && !['capture', 'end'].includes((rec as any).rec) && this.sample.length < Math.min(50, Math.max(0, this.previewLimit))) this.sample.push(rec);
      return;
    }
    this.parts.push(line);
    this.chars += line.length;
    if (this.chars >= FLUSH_CHARS) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.parts.length) return;
    const chunk = this.parts.join('');
    this.parts = [];
    this.chars = 0;
    if (!this.stream!.write(chunk)) await Promise.race([once(this.stream!, 'drain'), this.done!]);
  }

  integrity(): { algorithm: 'sha256'; digest: string; records: number } {
    return { algorithm: 'sha256', digest: this.hash.copy().digest('hex'), records: this.records };
  }

  async close(): Promise<void> {
    if (this.dryRun) return;
    await this.flush();
    this.stream!.end();
    await this.done;
  }
}
