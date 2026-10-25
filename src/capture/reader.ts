// .agentcap reader (docs/FORMAT.md §3): streams a capture into a capture index.

import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { constants, createGunzip, createZstdDecompress } from 'node:zlib';
import { runLinker } from '../index/linker.ts';
import { IndexWriter } from '../index/writer.ts';
import type { BlobRec, IndexRecord, SourceRec } from '../model/types.ts';
import { CAPTURE_VERSION } from './writer.ts';
import { validateRecordedManifest, type CaptureAnalysisManifest } from './manifest.ts';
import { ALARM_THRESHOLDS } from '../model/types.ts';

export interface CaptureLoadOptions {
  /** Recorded settings are the default for manifested captures; incompatible builds require explicit current. */
  analysis?: 'recorded' | 'current';
  /** Strict rejects corrupt manifested captures atomically. Recover imports surviving records and marks failure. */
  integrity?: 'strict' | 'recover';
  maxRecordBytes?: number;
  maxDecodedBytes?: number;
}

export interface CaptureIntegrity {
  status: 'verified' | 'unverified' | 'failed';
  streamChecksum: 'verified' | 'missing' | 'failed';
  checkedBlobs: number;
  checkedRawLines: number;
  errors: string[];
}

export interface CaptureLoadResult {
  counts: Record<string, number>; complete: boolean; header: unknown; coverage: unknown;
  integrity: CaptureIntegrity;
  analysis: { mode: 'recorded' | 'current'; clock: number; original?: CaptureAnalysisManifest; reason?: string };
}

/** Records per write transaction. */
const BATCH_RECORDS = 5000;
/** Raw text held before a flush, in characters. */
const BATCH_RAW_CHARS = 32 << 20;
/** Source id for records that name none (captures from other writers). */
const UNKNOWN_SOURCE = 'capture';

export async function loadCapture(
  capturePath: string,
  db: DatabaseSync,
  onProgress?: (bytes: number) => void,
  opts: CaptureLoadOptions = {},
): Promise<CaptureLoadResult> {
  db.exec('SAVEPOINT capture_import');
  try {
    const result = await loadCaptureRecords(capturePath, db, onProgress, opts);
    db.exec('RELEASE capture_import');
    return result;
  } catch (e) { db.exec('ROLLBACK TO capture_import; RELEASE capture_import'); throw e; }
}

async function loadCaptureRecords(capturePath: string, db: DatabaseSync, onProgress: ((bytes: number) => void) | undefined, opts: CaptureLoadOptions): Promise<CaptureLoadResult> {
  const codec = await detectCompression(capturePath);
  const writer = new IndexWriter(db);
  const hash = createHash('sha256');
  let hashedRecords = 0;
  const integrity: CaptureIntegrity = { status: 'unverified', streamChecksum: 'missing', checkedBlobs: 0, checkedRawLines: 0, errors: [] };
  const issue = (message: string) => { if (integrity.errors.length < 100) integrity.errors.push(message); };
  const maxRecord = opts.maxRecordBytes ?? 128 * 1024 * 1024;
  const maxDecoded = opts.maxDecodedBytes ?? 4 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRecord) || maxRecord < 1 || !Number.isSafeInteger(maxDecoded) || maxDecoded < 1) throw new Error('Capture limits must be positive byte counts');
  db.exec('CREATE TEMP TABLE IF NOT EXISTS capture_ids (kind TEXT, id TEXT, PRIMARY KEY(kind, id)); DELETE FROM temp.capture_ids');
  const seen = db.prepare('INSERT OR IGNORE INTO temp.capture_ids VALUES (?, ?)');

  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  let header: Record<string, any> | undefined;
  let trailer: Record<string, any> | undefined;
  let analysis: CaptureLoadResult['analysis'];

  // Pending writes, grouped by contributing source.
  let pending = new Map<string, IndexRecord[]>();
  let raws: [string, number, string][] = [];
  let blobs: BlobRec[] = [];
  let pendingRecords = 0;
  let pendingChars = 0;
  /** Source of each session's events, for records that carry no source of their own. */
  const sessionSource = new Map<string, string>();

  const flush = () => {
    if (!pendingRecords && !raws.length && !blobs.length) return;
    const groups = pending;
    const rawRows = raws;
    const blobRows = blobs;
    pending = new Map();
    raws = [];
    blobs = [];
    pendingRecords = 0;
    pendingChars = 0;
    writer.transaction(() => {
      for (const [src, recs] of groups) writer.appendRecords(src, recs);
      for (const [src, line, text] of rawRows) writer.putRaw(src, line, text);
      for (const b of blobRows) writer.putBlob(b);
      writer.flushFts();
    });
  };
  const queue = (src: string, rec: IndexRecord) => {
    const list = pending.get(src);
    if (list) list.push(rec);
    else pending.set(src, [rec]);
    pendingRecords++;
  };

  const handle = (rec: Record<string, any>) => {
    if (!header) {
      if (rec.rec !== 'capture' || rec.format !== 'agentcap') throw new Error('Not an AgentCap capture: the first record is not a capture header');
      if (!Number.isInteger(rec.version) || rec.version < 1 || rec.version > CAPTURE_VERSION) {
        throw new Error(`Capture format version ${rec.version} is newer than the supported version ${CAPTURE_VERSION}; upgrade AgentShark`);
      }
      header = rec;
      const mode = opts.analysis ?? (rec.analysis ? 'recorded' : 'current');
      if (mode === 'recorded' && !rec.analysis) throw new Error('Capture has no recorded analysis manifest; use analysis: "current"');
      const original = mode === 'recorded' ? validateRecordedManifest(rec.analysis) : rec.analysis as CaptureAnalysisManifest | undefined;
      const clock = mode === 'recorded' ? original!.clock : (Number.isSafeInteger(rec.created) && rec.created > 0 ? rec.created : Date.now() * 1000);
      analysis = { mode, clock, ...(original ? { original } : { reason: 'Legacy capture has no recorded analysis manifest' }) };
      // A capture index holds exactly one capture.
      writer.transaction(() => {
        db.exec(`DELETE FROM sources; DELETE FROM sessions; DELETE FROM events; DELETE FROM event_payload; DELETE FROM spans; DELETE FROM expert;
                 DELETE FROM enrich; DELETE FROM raw_store; DELETE FROM blobs;
                 INSERT INTO events_fts (events_fts) VALUES ('delete-all');`);
        db.exec("DELETE FROM meta WHERE key LIKE 'capture_%' OR key IN ('analysis_version', 'sig_version', 'analysis_failed', 'analysis_pending', 'alarm_thresholds')");
        const put = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
        put.run('capture_analysis_clock', String(clock));
        put.run('alarm_thresholds', JSON.stringify(mode === 'recorded' ? original!.thresholds : ALARM_THRESHOLDS));
      });
      return;
    }
    if (!valid(rec)) { issue(`Invalid ${String(rec.rec)} record`); return bump('invalid'); }
    if (['source', 'session', 'event', 'span'].includes(rec.rec) && seen.run(rec.rec, rec.id).changes === 0) {
      issue(`Duplicate ${rec.rec} identifier`); return bump('invalid');
    }
    switch (rec.rec) {
      case 'source':
        flush();
        writer.putSource(rec as SourceRec, { parseMs: 0 });
        break;
      case 'session':
        queue(rec.src ?? UNKNOWN_SOURCE, rec as IndexRecord);
        break;
      case 'event': {
        const src: string = rec.raw?.source ?? rec.src ?? UNKNOWN_SOURCE;
        if (!sessionSource.has(rec.session)) sessionSource.set(rec.session, src);
        if (typeof rec.raw?.text === 'string' && typeof rec.raw.line === 'number') {
          if (rec.raw.sha256) {
            integrity.checkedRawLines++;
            if (createHash('sha256').update(rec.raw.text).digest('hex') !== rec.raw.sha256) {
              issue('Raw line hash mismatch'); delete rec.raw.text;
            }
          }
        }
        if (typeof rec.raw?.text === 'string' && typeof rec.raw.line === 'number') {
          raws.push([src, rec.raw.line, rec.raw.text]);
          pendingChars += rec.raw.text.length;
          delete rec.raw.text;
          bump('raw');
        }
        queue(src, rec as IndexRecord);
        break;
      }
      case 'span':
        queue(rec.src ?? sourceOfEvent(rec.firstEvent) ?? sessionSource.get(rec.session) ?? UNKNOWN_SOURCE, rec as IndexRecord);
        break;
      case 'expert':
        queue(rec.src ?? sourceOfEvent(rec.event) ?? sessionSource.get(rec.session) ?? UNKNOWN_SOURCE, rec as IndexRecord);
        break;
      case 'enrich':
        queue(rec.src ?? UNKNOWN_SOURCE, rec as IndexRecord);
        break;
      case 'blob':
        if (typeof rec.data !== 'string' || !['utf8', 'base64'].includes(rec.encoding)) { issue('Invalid blob payload'); return bump('invalid'); }
        const bytes = Buffer.from(rec.data, rec.encoding === 'base64' ? 'base64' : 'utf8');
        integrity.checkedBlobs++;
        if (createHash('sha256').update(bytes).digest('hex') !== rec.sha256 || rec.size !== bytes.length) {
          issue('Blob hash or size mismatch'); return bump('invalid');
        }
        blobs.push(rec as BlobRec);
        pendingChars += rec.data?.length ?? 0;
        break;
      case 'end':
        trailer = rec;
        return;
      default:
        return bump('ignored'); // unknown record types are skipped (FORMAT §1)
    }
    bump(rec.rec);
    if (pendingRecords >= BATCH_RECORDS || pendingChars >= BATCH_RAW_CHARS) flush();
  };

  // Errors from our own handling abort the load; stream errors (truncation, corruption) end it early.
  let fatal: unknown;
  const handleLine = (text: string, last: boolean) => {
    if (trailer) { if (text.trim()) issue('Records appear after the end marker'); return; }
    if (!text.trim()) { hash.update(text + (last ? '' : '\n')); return; }
    let rec: any;
    try {
      rec = JSON.parse(text);
    } catch {
      hash.update(text + (last ? '' : '\n')); hashedRecords++;
      if (!header && !last) {
        fatal = new Error('Not an AgentCap capture: the first line is not JSON');
        throw fatal;
      }
      if (!last) { bump('malformed'); issue('Malformed JSON record'); }
      return;
    }
    try {
      if (rec?.rec !== 'end') { hash.update(text + (last ? '' : '\n')); hashedRecords++; }
      if (rec && typeof rec === 'object' && !trailer) handle(rec);
    } catch (err) {
      fatal = err;
      throw err;
    }
  };

  let carry: Buffer[] = [];
  let carryBytes = 0;
  let decodedBytes = 0;
  const consume = async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      decodedBytes += chunk.length;
      if (decodedBytes > maxDecoded) { fatal = new Error('Capture exceeds the decoded byte limit'); throw fatal; }
      let start = 0;
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, nl);
        if (carryBytes + piece.length > maxRecord) { fatal = new Error('Capture exceeds the record byte limit'); throw fatal; }
        const line = carry.length ? Buffer.concat([...carry, piece]) : piece;
        carry = [];
        carryBytes = 0;
        handleLine(line.toString('utf8'), false);
        start = nl + 1;
      }
      if (start < chunk.length) { carry.push(chunk.subarray(start)); carryBytes += chunk.length - start; }
      if (carryBytes > maxRecord) { fatal = new Error('Capture exceeds the record byte limit'); throw fatal; }
      onProgress?.(input.bytesRead);
    }
  };
  const input = createReadStream(capturePath);
  let streamFailed = false;
  try {
    if (codec) await pipeline(input, codec, consume);
    else await pipeline(input, consume);
  } catch (err) {
    if (fatal) throw err;
    streamFailed = true;
  }
  if (carry.length) handleLine(Buffer.concat(carry).toString('utf8'), true);
  if (!header) throw new Error('Not an AgentCap capture: no capture header found');
  flush();

  const complete = !streamFailed && trailer !== undefined && trailer.complete !== false;
  if (trailer?.integrity) {
    const expected = trailer.integrity;
    integrity.streamChecksum = expected.algorithm === 'sha256' && expected.digest === hash.digest('hex') && expected.records === hashedRecords ? 'verified' : 'failed';
    if (integrity.streamChecksum === 'failed') issue('Capture stream hash or record count mismatch');
  }
  const plural: Record<string, string> = { sources: 'source', sessions: 'session', events: 'event', spans: 'span', expert: 'expert', enrich: 'enrich', blobs: 'blob' };
  if (complete) for (const [key, kind] of Object.entries(plural)) {
    if (typeof trailer?.counts?.[key] === 'number' && trailer.counts[key] !== (counts[kind] ?? 0)) issue(`Capture ${key} count mismatch`);
  }
  // A complete manifested capture selects whole sessions. Parents and linked sessions can legitimately sit outside
  // its scope; the source and session owning each contained record must still be present.
  if (complete && (header.analysis || opts.integrity === 'strict')) {
    const references: [string, string][] = [
      ['Event references a missing session', 'SELECT 1 FROM events e LEFT JOIN sessions s ON s.id=e.session_id WHERE s.id IS NULL LIMIT 1'],
      ['Event references a missing source', 'SELECT 1 FROM events e LEFT JOIN sources s ON s.id=e.src_id WHERE s.id IS NULL LIMIT 1'],
      ['Span references a missing session', 'SELECT 1 FROM spans e LEFT JOIN sessions s ON s.id=e.session_id WHERE s.id IS NULL LIMIT 1'],
      ['Span references a missing source', 'SELECT 1 FROM spans e LEFT JOIN sources s ON s.id=e.src_id WHERE s.id IS NULL LIMIT 1'],
      ['Session references a missing source', 'SELECT 1 FROM sessions e LEFT JOIN sources s ON s.id=e.src_id WHERE e.src_id IS NOT NULL AND s.id IS NULL LIMIT 1'],
    ];
    for (const [message, sql] of references) if (db.prepare(sql).get()) issue(message);
  }
  integrity.status = integrity.errors.length ? 'failed' : integrity.streamChecksum === 'verified' ? 'verified' : 'unverified';
  // A missing trailer cannot downgrade a manifested capture's known corruption to implicit recovery.
  // Ordinary truncation has no integrity errors and remains incomplete/unverified.
  if (integrity.status === 'failed' && opts.integrity !== 'recover' && (header.analysis || trailer?.integrity || opts.integrity === 'strict')) {
    throw new Error(`Capture integrity validation failed: ${integrity.errors.join('; ')}`);
  }
  runLinker(db, undefined, { derive: { now: analysis!.clock } });
  // Coverage comes from the trailer. Captures written before it was recorded say nothing about missing evidence,
  // which is marked unknown rather than reported as none.
  const coverage = trailer?.coverage && typeof trailer.coverage === 'object'
    ? { rawUnavailableBySource: {}, sidecarsOmitted: [], rawOmitted: header.options?.raw === false, ...trailer.coverage, known: true }
    : {
        rawUnavailable: typeof trailer?.counts?.rawUnavailable === 'number' ? trailer.counts.rawUnavailable : 0,
        rawUnavailableBySource: {}, rawOmitted: header.options?.raw === false, sidecarsOmitted: [], known: false,
      };
  const putMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  putMeta.run('capture_complete', complete ? '1' : '0');
  putMeta.run('capture_header', JSON.stringify(header));
  putMeta.run('capture_coverage', JSON.stringify(coverage));
  putMeta.run('capture_loaded_at', String(Date.now() * 1000));
  putMeta.run('capture_integrity', JSON.stringify(integrity));
  putMeta.run('capture_analysis', JSON.stringify(analysis!));
  return { counts, complete, header, coverage, integrity, analysis: analysis! };
}

async function detectCompression(path: string) {
  const fh = await open(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await fh.read(magic, 0, 4, 0);
    if (bytesRead >= 4 && magic.readUInt32BE(0) === 0x28b52ffd) return createZstdDecompress();
    // Sync flush: a truncated gzip stream yields everything before the break instead of failing.
    if (bytesRead >= 2 && magic[0] === 0x1f && magic[1] === 0x8b) return createGunzip({ finishFlush: constants.Z_SYNC_FLUSH });
    return null;
  } finally {
    await fh.close();
  }
}

/** Event ids are `<sourceId>:<line>[.<block>]`. */
function sourceOfEvent(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  const i = id.indexOf(':');
  return i > 0 ? id.slice(0, i) : undefined;
}

/** The fields the index needs to store a record; anything less is skipped. */
function valid(r: Record<string, any>): boolean {
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  switch (r.rec) {
    case 'source': return str(r.id) && str(r.path) && str(r.agent) && str(r.kind);
    case 'session': return str(r.id) && str(r.agent) && str(r.nativeId) && str(r.role);
    case 'event': return str(r.id) && str(r.session) && Number.isSafeInteger(r.ts) && str(r.kind) && str(r.proto) && str(r.actor) && str(r.tsSrc) && Number.isSafeInteger(r.seq);
    case 'span': return str(r.id) && str(r.session) && str(r.kind);
    case 'expert': return str(r.severity) && str(r.group) && typeof r.message === 'string';
    case 'enrich': return str(r.session);
    case 'blob': return str(r.sha256);
    default: return true;
  }
}
