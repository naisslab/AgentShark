// Record batches → SQL. The only code that inserts adapter records into the index (SPEC §5.1).

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  BlobRec, EnrichRec, EventFlag, EventRec, ExpertRec, IndexRecord, SessionRec, SourceRec, SpanRec,
} from '../model/types.ts';
import { FLAG_BITS } from '../model/types.ts';

/** Cap on the full-text body of one event, and on the share of it a tool output may take. */
const FTS_BODY_MAX = 4096;
const FTS_OUTPUT_MAX = 1024;

export interface SourceMeta {
  parseMs: number;
  status?: string;
  error?: string;
}

export function flagBits(flags: EventFlag[] | undefined): number {
  let bits = 0;
  for (const f of flags ?? []) bits |= FLAG_BITS[f] ?? 0;
  return bits;
}

export function flagsFromBits(bits: number): EventFlag[] {
  return (Object.keys(FLAG_BITS) as EventFlag[]).filter((f) => (bits & FLAG_BITS[f]) !== 0);
}

const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function ftsBody(e: EventRec): string {
  const tool = e.attrs?.tool;
  const output = typeof tool?.output === 'string' ? tool.output.slice(0, FTS_OUTPUT_MAX) : undefined;
  const parts = [e.summary, e.attrs?.text, tool?.input_summary, output].filter((s) => typeof s === 'string' && s);
  const body = parts.join('\n');
  const head = body.length > FTS_BODY_MAX ? body.slice(0, FTS_BODY_MAX) : body;
  // The output tail (SPEC §12.3.1, at most TOOL_OUTPUT_TAIL.chars) follows the cut, so a long head never pushes it out.
  const tail = tool?.output_tail;
  return typeof tail === 'string' && tail ? `${head}\n${tail}` : head;
}

/** The `events` columns read from attrs, in the order putEvent binds them. */
type AttrColumns = [
  toolName: string | null, toolKind: string | null, exitCode: number | null, model: string | null,
  tokIn: number | null, tokOut: number | null, costUsd: number | null, costCum: number | null,
];

/** What the writer stores of an event's attrs and native record. */
interface EventWire {
  attrs: string;
  native: string | null;
  fts: string;
  cols: AttrColumns;
}

/** What the writer stores of a span's attrs. */
interface SpanWire {
  attrs: string;
  inherited: boolean;
}

/** An event or span as a parser worker posts it (toWire): stored strings in place of the objects. */
type WireEvent = Omit<EventRec, 'attrs' | 'native'> & { wire: EventWire };
type WireSpan = Omit<SpanRec, 'attrs'> & { wire: SpanWire };
/** A record the writer accepts: as an adapter emits it, or as a parser worker posts it. */
export type WriterRecord = IndexRecord | WireEvent | WireSpan;

function eventWire(e: EventRec): EventWire {
  const a = e.attrs ?? {};
  const cost = num(a.cost?.usd);
  return {
    attrs: JSON.stringify(a),
    native: json(e.native),
    fts: ftsBody(e),
    cols: [
      nn(a.tool?.name), typeof a.tool?.kind === 'string' ? a.tool.kind : null, num(a.tool?.exit_code), nn(a.llm?.model),
      num(a.tokens?.input), num(a.tokens?.output), cost, cost === null ? null : a.cost?.cumulative === true ? 1 : 0,
    ],
  };
}

function spanWire(s: SpanRec): SpanWire {
  return { attrs: JSON.stringify(s.attrs ?? {}), inherited: s.attrs?.inherited === true };
}

/**
 * The record with its events' and spans' stored strings computed: parser workers post this, so the writer's thread
 * neither stringifies the attrs and native objects nor receives them. Other records pass unchanged.
 */
export function toWire(r: IndexRecord): WriterRecord {
  if (r.rec === 'event') {
    const { attrs, native, ...rest } = r;
    return { ...rest, wire: eventWire(r) };
  }
  if (r.rec === 'span') {
    const { attrs, ...rest } = r;
    return { ...rest, wire: spanWire(r) };
  }
  return r;
}

export class IndexWriter {
  /** Session ids whose rows were written or cleared through this writer; the linker input. */
  readonly touched = new Set<string>();
  /**
   * Enrich rows of a source as they were before it was cleared (session → fields and meta). A state database names
   * thousands of sessions and changes often: only sessions whose enrich row changed count as touched.
   */
  private enrichBefore = new Map<string, Map<string, string>>();

  private db: DatabaseSync;
  private st: Record<string, StatementSync>;
  /** Nesting depth of transaction(). */
  private depth = 0;
  /**
   * Full-text changes queued by transaction(). FTS5 flushes its pending terms into a new segment at every
   * SAVEPOINT and RELEASE once it has been written in the enclosing transaction, so full-text rows written
   * between per-file savepoints would cost one segment per file. Inside a transaction the caller opened,
   * they wait for flushFts(), which the caller runs right before its COMMIT.
   */
  private ftsDeletes: number[] = [];
  private ftsInserts: [number, string][] = [];

  constructor(db: DatabaseSync) {
    this.db = db;
    const p = (sql: string) => db.prepare(sql);
    this.st = {
      sessionsOfSource: p(`SELECT DISTINCT session_id AS id FROM events WHERE src_id = ?
                           UNION SELECT session_id FROM spans WHERE src_id = ?
                           UNION SELECT id FROM sessions WHERE src_id = ?`),
      enrichOfSource: p('SELECT session_id, fields, meta FROM enrich WHERE src_id = ?'),
      ridsOfSource: p('SELECT rid FROM events WHERE src_id = ?'),
      delFts: p('DELETE FROM events_fts WHERE rowid = ?'),
      delPayload: p('DELETE FROM event_payload WHERE rid IN (SELECT rid FROM events WHERE src_id = ?)'),
      delEvents: p('DELETE FROM events WHERE src_id = ?'),
      delSpans: p('DELETE FROM spans WHERE src_id = ?'),
      delExpert: p('DELETE FROM expert WHERE src_id = ?'),
      delEnrich: p('DELETE FROM enrich WHERE src_id = ?'),
      delRaw: p('DELETE FROM raw_store WHERE src_id = ?'),
      delSource: p('DELETE FROM sources WHERE id = ?'),
      putSource: p(`INSERT INTO sources (id, agent, kind, path, size, mtime_ms, ino, parsed_bytes, lines, malformed, unknown,
                      skipped, inherited, dialect, sha256, indexed_at, parse_ms, status, error, exists_now)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, kind = excluded.kind, path = excluded.path,
                      size = excluded.size, mtime_ms = excluded.mtime_ms, ino = excluded.ino, parsed_bytes = excluded.parsed_bytes,
                      lines = excluded.lines, malformed = excluded.malformed, unknown = excluded.unknown, skipped = excluded.skipped,
                      inherited = excluded.inherited, dialect = excluded.dialect, sha256 = excluded.sha256,
                      indexed_at = excluded.indexed_at, parse_ms = excluded.parse_ms, status = excluded.status,
                      error = excluded.error, exists_now = 1`),
      sourceError: p('UPDATE sources SET status = ?, error = ?, indexed_at = ? WHERE id = ?'),
      sessionMeta: p('SELECT meta FROM sessions WHERE id = ?'),
      // Non-null new values win; an absent state means the defining source exists, so the session is 'ok'.
      putSession: p(`INSERT INTO sessions (id, agent, native_id, role, state, parent_id, parent_span_id, title, cwd, project,
                       git_branch, git_commit, git_repo, models, version, originator, entrypoint, created_ts, meta, src_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, native_id = excluded.native_id,
                       role = excluded.role, state = excluded.state,
                       parent_id = COALESCE(excluded.parent_id, parent_id),
                       parent_span_id = COALESCE(excluded.parent_span_id, parent_span_id),
                       title = COALESCE(excluded.title, title), cwd = COALESCE(excluded.cwd, cwd),
                       project = COALESCE(excluded.project, project),
                       git_branch = COALESCE(excluded.git_branch, git_branch),
                       git_commit = COALESCE(excluded.git_commit, git_commit),
                       git_repo = COALESCE(excluded.git_repo, git_repo),
                       models = COALESCE(excluded.models, models), version = COALESCE(excluded.version, version),
                       originator = COALESCE(excluded.originator, originator),
                       entrypoint = COALESCE(excluded.entrypoint, entrypoint),
                       created_ts = COALESCE(excluded.created_ts, created_ts),
                       meta = excluded.meta, src_id = excluded.src_id`),
      putEvent: p(`INSERT INTO events (id, session_id, src_id, ts, ts_src, seq, kind, proto, actor, summary, span_id, turn_id, dur,
                     tool_name, tool_kind, exit_code, model, tok_in, tok_out, cost_usd, cost_cum, flag_bits, src_line, src_off, src_len, src_block)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO NOTHING`),
      putPayload: p('INSERT OR REPLACE INTO event_payload (rid, attrs, native) VALUES (?, ?, ?)'),
      putFts: p('INSERT INTO events_fts (rowid, body) VALUES (?, ?)'),
      spanDepth: p('SELECT depth FROM spans WHERE id = ?'),
      putSpan: p(`INSERT OR REPLACE INTO spans (id, session_id, src_id, kind, name, parent_id, start_ts, end_ts, dur, dur_src,
                    status, link_session, first_event, last_event, depth, inherited, attrs)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      putExpert: p('INSERT INTO expert (src_id, session_id, event_id, span_id, severity, grp, message) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      putEnrich: p('INSERT OR REPLACE INTO enrich (src_id, session_id, fields, meta) VALUES (?, ?, ?, ?)'),
      putRaw: p('INSERT OR REPLACE INTO raw_store (src_id, line, text) VALUES (?, ?, ?)'),
      putBlob: p(`INSERT OR IGNORE INTO blobs (sha256, size, media_type, encoding, origin_path, role, data)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`),
    };
  }

  /**
   * Run `fn` atomically: in its own transaction, or as a savepoint inside one the caller already
   * opened (the indexer groups many files per commit; each file still applies all-or-nothing).
   * In the second case the full-text changes wait for the caller's flushFts().
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn(); // already inside one of ours: the outer call is the atomic unit
    const nested = this.db.isTransaction;
    this.db.exec(nested ? 'SAVEPOINT writer' : 'BEGIN');
    this.depth++;
    const queued = [this.ftsDeletes.length, this.ftsInserts.length];
    try {
      const out = fn();
      if (nested) {
        this.db.exec('RELEASE writer');
      } else {
        this.flushFts();
        this.db.exec('COMMIT');
      }
      return out;
    } catch (err) {
      // Drop this call's full-text changes; earlier files of the caller's transaction keep theirs.
      this.ftsDeletes.length = queued[0];
      this.ftsInserts.length = queued[1];
      if (nested) this.db.exec('ROLLBACK TO writer; RELEASE writer');
      else if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  /**
   * Apply queued full-text changes: deletes of replaced rows first, since a new row may reuse a rowid.
   * A caller that wraps transaction() in a transaction of its own must call this before its COMMIT.
   */
  flushFts(): void {
    for (const rid of this.ftsDeletes) this.st.delFts.run(rid);
    for (const [rid, body] of this.ftsInserts) this.st.putFts.run(rid, body);
    this.ftsDeletes = [];
    this.ftsInserts = [];
  }

  /** Replace every row a source contributed, in one transaction. */
  replaceSource(src: SourceRec, records: WriterRecord[], meta: SourceMeta): void {
    this.transaction(() => {
      this.clearSource(src.id);
      this.appendRecords(src.id, records);
      this.putSource(src, meta);
    });
  }

  /** Delete a source and everything it contributed. */
  removeSource(sourceId: string): void {
    this.transaction(() => {
      this.clearSource(sourceId);
      this.flushEnrich(sourceId);
      this.st.delSource.run(sourceId);
    });
  }

  /**
   * The source file vanished: drop its rows but keep the sessions it defined, marked 'source-deleted'
   * with a logging-gap warning. Returns the ids of the sessions that lost their last events.
   */
  markSourceDeleted(sourceId: string, path: string): string[] {
    return this.transaction(() => {
      const sessions = this.clearSource(sourceId);
      this.flushEnrich(sourceId);
      const orphaned: string[] = [];
      const hasEvents = this.db.prepare('SELECT 1 FROM events WHERE session_id = ? LIMIT 1');
      const markDeleted = this.db.prepare("UPDATE sessions SET state = 'source-deleted' WHERE id = ? AND state = 'ok'");
      for (const id of sessions) {
        if (hasEvents.get(id)) continue;
        if (Number(markDeleted.run(id).changes) === 0) continue;
        orphaned.push(id);
        // Owned by the vanished source, so the warning disappears if the file comes back.
        this.st.putExpert.run(sourceId, id, null, null, 'warn', 'logging-gap', `Source file was deleted: ${path}`);
      }
      this.db.prepare("UPDATE sources SET exists_now = 0, status = 'deleted' WHERE id = ?").run(sourceId);
      return orphaned;
    });
  }

  /** Record a parse failure. Existing rows of the source stay; status 'error' makes the next run retry. */
  markSourceError(src: SourceRec, error: string): void {
    const now = Date.now() * 1000;
    const res = this.st.sourceError.run('error', error, now, src.id);
    if (Number(res.changes) === 0) this.putSource(src, { parseMs: 0, status: 'error', error });
  }

  /**
   * Drop every row the sources contributed before a full re-index: much faster than replacing them file by
   * file. Sessions stay (the linker collects the ones left empty), and so do the warnings of deleted sources.
   * Every present source is marked 'stale', so an interrupted run re-parses whatever it did not reach.
   */
  clearAll(): void {
    this.transaction(() => {
      this.db.exec(`INSERT INTO events_fts (events_fts) VALUES ('delete-all');
        DELETE FROM events; DELETE FROM event_payload; DELETE FROM spans; DELETE FROM enrich; DELETE FROM raw_store;
        DELETE FROM expert WHERE src_id IS NULL OR src_id NOT IN (SELECT id FROM sources WHERE exists_now = 0);
        UPDATE sources SET status = 'stale' WHERE exists_now = 1;`);
    });
  }

  /** Delete the rows of one source (no transaction of its own). Returns the affected session ids. */
  clearSource(sourceId: string): string[] {
    const rows = this.st.sessionsOfSource.all(sourceId, sourceId, sourceId) as { id: string }[];
    for (const r of rows) this.touched.add(r.id);
    const before = new Map<string, string>();
    for (const e of this.st.enrichOfSource.all(sourceId) as { session_id: string; fields: string | null; meta: string | null }[]) {
      before.set(e.session_id, enrichKey(e.fields, e.meta));
    }
    this.flushEnrich(sourceId);
    this.enrichBefore.set(sourceId, before);
    for (const r of this.st.ridsOfSource.all(sourceId) as { rid: number }[]) {
      if (this.depth > 0) this.ftsDeletes.push(r.rid);
      else this.st.delFts.run(r.rid);
    }
    this.st.delPayload.run(sourceId);
    this.st.delEvents.run(sourceId);
    this.st.delSpans.run(sourceId);
    this.st.delExpert.run(sourceId);
    this.st.delEnrich.run(sourceId);
    this.st.delRaw.run(sourceId);
    return [...new Set([...rows.map((r) => r.id), ...before.keys()])];
  }

  /** Sessions whose enrich row this source no longer writes are touched too; called when the source is done. */
  private flushEnrich(sourceId: string): void {
    for (const id of this.enrichBefore.get(sourceId)?.keys() ?? []) this.touched.add(id);
    this.enrichBefore.delete(sourceId);
  }

  /** Upsert the `sources` row (no transaction of its own); the source's records are all written. */
  putSource(src: SourceRec, meta: SourceMeta): void {
    this.flushEnrich(src.id);
    this.st.putSource.run(
      src.id, src.agent, src.kind, src.path, nn(src.size), nn(src.mtimeMs), nn(src.ino), nn(src.parsedBytes),
      src.lines ?? 0, src.malformed ?? 0, src.unknown ?? 0, src.skipped ?? 0, src.inherited ?? 0,
      nn(src.dialect), nn(src.sha256), Date.now() * 1000, meta.parseMs, meta.status ?? 'ok', nn(meta.error),
    );
  }

  /** Insert records attributed to `sourceId` without deleting anything (no transaction of its own). */
  appendRecords(sourceId: string, records: WriterRecord[]): { events: number; spans: number } {
    let events = 0;
    const spans: (SpanRec | WireSpan)[] = [];
    const enrich = new Map<string, EnrichRec>();
    for (const r of records) {
      switch (r.rec) {
        case 'session':
          this.putSession(sourceId, r);
          break;
        case 'event':
          if (this.putEvent(sourceId, r)) events++;
          break;
        case 'span':
          spans.push(r);
          break;
        case 'expert':
          this.putExpert(sourceId, r);
          break;
        case 'enrich': {
          // Several enrich records for one session from one source merge shallowly.
          const prev = enrich.get(r.session);
          enrich.set(r.session, prev
            ? { ...r, fields: { ...prev.fields, ...r.fields }, meta: { ...prev.meta, ...r.meta } }
            : r);
          break;
        }
        case 'blob':
          this.putBlob(r);
          break;
      }
    }
    const before = this.enrichBefore.get(sourceId);
    for (const e of enrich.values()) {
      const fields = json(e.fields);
      const meta = json(e.meta);
      if (before?.get(e.session) !== enrichKey(fields, meta)) this.touched.add(e.session);
      before?.delete(e.session);
      this.st.putEnrich.run(sourceId, e.session, fields, meta);
    }
    this.putSpans(sourceId, spans);
    return { events, spans: spans.length };
  }

  putRaw(srcId: string, line: number, text: string): void {
    this.st.putRaw.run(srcId, line, text);
  }

  putBlob(b: BlobRec): void {
    const data = b.data === undefined ? null : Buffer.from(b.data, b.encoding === 'base64' ? 'base64' : 'utf8');
    this.st.putBlob.run(b.sha256, b.size, b.mediaType, b.encoding, nn(b.origin?.path), nn(b.origin?.role), data);
  }

  private putSession(sourceId: string, s: SessionRec): void {
    this.touched.add(s.id);
    const prev = this.st.sessionMeta.get(s.id) as { meta: string | null } | undefined;
    const meta = prev?.meta ? { ...JSON.parse(prev.meta), ...s.meta } : s.meta;
    this.st.putSession.run(
      s.id, s.agent, s.nativeId, s.role, s.state ?? 'ok', nn(s.parentId), nn(s.parentSpanId), nn(s.title), nn(s.cwd),
      nn(s.project), nn(s.git?.branch), nn(s.git?.commit), nn(s.git?.repo), s.models?.length ? JSON.stringify(s.models) : null,
      nn(s.version), nn(s.originator), nn(s.entrypoint), nn(s.createdTs), json(meta), sourceId,
    );
  }

  private putEvent(sourceId: string, e: EventRec | WireEvent): boolean {
    this.touched.add(e.session);
    const w = 'wire' in e ? e.wire : eventWire(e);
    const res = this.st.putEvent.run(
      e.id, e.session, sourceId, num(e.ts) ?? 0, e.tsSrc, e.seq, e.kind, e.proto, e.actor, e.summary ?? '',
      nn(e.span), nn(e.turn), num(e.dur), ...w.cols,
      flagBits(e.flags), nn(e.raw?.line), nn(e.raw?.offset), nn(e.raw?.length), nn(e.raw?.block),
    );
    if (Number(res.changes) === 0) return false; // duplicate id: the first copy wins
    const rid = Number(res.lastInsertRowid);
    this.st.putPayload.run(rid, w.attrs, w.native);
    if (this.depth > 0) this.ftsInserts.push([rid, w.fts]);
    else this.st.putFts.run(rid, w.fts);
    return true;
  }

  private putExpert(sourceId: string, x: ExpertRec): void {
    if (x.session) this.touched.add(x.session);
    this.st.putExpert.run(sourceId, nn(x.session), nn(x.event), nn(x.span), x.severity, x.group, x.message);
  }

  /** Spans are written together so depth can follow parent links inside the batch. */
  private putSpans(sourceId: string, spans: (SpanRec | WireSpan)[]): void {
    const byId = new Map(spans.map((s) => [s.id, s]));
    const depths = new Map<string, number>();
    const depthOf = (s: SpanRec | WireSpan, seen: Set<string>): number => {
      const known = depths.get(s.id);
      if (known !== undefined) return known;
      let d = 0;
      if (s.parent && !seen.has(s.parent)) {
        seen.add(s.id);
        const parent = byId.get(s.parent);
        if (parent) d = depthOf(parent, seen) + 1;
        else {
          const row = this.st.spanDepth.get(s.parent) as { depth: number } | undefined;
          d = row ? row.depth + 1 : 0; // dangling parent: treat as a root
        }
      }
      depths.set(s.id, d);
      return d;
    };
    for (const s of spans) {
      this.touched.add(s.session);
      const w = 'wire' in s ? s.wire : spanWire(s);
      this.st.putSpan.run(
        s.id, s.session, sourceId, s.kind, s.name, nn(s.parent), num(s.start), num(s.end), num(s.dur), s.durSrc, s.status,
        nn(s.linkSession), nn(s.firstEvent), nn(s.lastEvent), depthOf(s, new Set()), w.inherited ? 1 : 0, w.attrs,
      );
    }
  }
}

function enrichKey(fields: string | null, meta: string | null): string {
  return `${fields ?? ''}\u0000${meta ?? ''}`;
}
