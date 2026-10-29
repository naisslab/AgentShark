// Opening and migrating the index database (SPEC §5.1).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Bump together with schema.sql; an AgentShark index of another version is rebuilt from the sources.
 * 4: the derived tables of SPEC §12.3 (steps, failures, episodes, signatures, ...) and the adapter fields
 * attrs.tool.output_tail, attrs.tool.proc_id and attrs.change.files.
 * 5: Copilot CLI events and VS Code mutation logs, timed tools, tokens and shell-tool classification.
 *
 * The analysis pass keeps two more versions in `meta` (see schema.sql): `analysis_version` (ANALYSIS_VERSION in
 * src/index/derive.ts) and `sig_version` (SIG_VERSION). A mismatch there never rebuilds the index: a writable open or
 * `agentshark index --rederive` re-derives the derived tables from the indexed events without re-parsing, and
 * read-only opens report the gap 'analysis-outdated' instead of failing.
 */
export const SCHEMA_VERSION = 5;

/** `PRAGMA application_id` of every AgentShark index ("ASK1"); a file without it is never modified or deleted. */
export const APPLICATION_ID = 0x41534b31;

export function defaultHome(): string {
  return process.env.AGENTSHARK_HOME || join(homedir(), '.agentshark');
}

export function defaultIndexPath(): string {
  return join(defaultHome(), 'index.sqlite');
}

/** The path cannot be used as an index: another program's database, another schema for a read-only open, or no file. */
export class IndexOpenError extends Error {}

export interface OpenIndexOptions {
  /**
   * Read-only commands (list, stats, sources, the server's query workers): never create, migrate or rebuild.
   * An index of another schema version is an error that names the command that rebuilds it.
   */
  readOnly?: boolean;
  /**
   * Read-only opens only: older schema versions to accept as well, so the old index keeps serving while a writable
   * open builds the new one beside it (SPEC §12.3.1). The server's query workers and `agentshark mcp` pass
   * READABLE_OLD_SCHEMAS; they check indexSchemaVersion() and answer derived queries with the gap 'analysis-outdated'.
   */
  acceptSchema?: number[];
  /**
   * Writable opens of an index of another schema version: delete it and index again in place ('replace', the default),
   * or leave it serving its readers and build the new index at `<path>.next` ('beside'), which promoteIndex() moves into
   * place once a run has completed it. A `.next` left by an interrupted build is resumed.
   */
  rebuild?: 'replace' | 'beside';
}

/** Older schema versions that readers keep serving while the new index builds beside them. */
export const READABLE_OLD_SCHEMAS = [3, 4];

export function nextIndexPath(path: string): string {
  return `${path}.next`;
}

const SCHEMA_SQL = readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8');

type Kind = { kind: 'empty' } | { kind: 'ours'; version: number | null } | { kind: 'foreign'; tables: string[] };

/**
 * Open (or create) an index. `:memory:` is accepted for tests. A file that holds tables but is not an AgentShark
 * index (no application id, no AgentShark tables) is refused and left untouched, also when it is not a database.
 */
export function openIndex(path: string, opts: OpenIndexOptions = {}): DatabaseSync {
  if (path === ':memory:') return prepare(new DatabaseSync(path));
  const present = existsSync(path) && statSync(path).size > 0;
  if (opts.readOnly) {
    if (!present) throw new IndexOpenError(`no index at ${path}; run 'agentshark index' first`);
    const db = openRaw(path, true);
    const k = classify(db, path);
    if (k.kind !== 'ours') {
      db.close();
      throw k.kind === 'empty' ? new IndexOpenError(`${path} is an empty database; run 'agentshark index' first`) : foreign(path, k.tables);
    }
    if (k.version !== SCHEMA_VERSION && !(k.version !== null && opts.acceptSchema?.includes(k.version))) {
      db.close();
      throw new IndexOpenError(`the index at ${path} uses schema ${k.version ?? '?'} (this AgentShark uses ${SCHEMA_VERSION}); run 'agentshark index' to rebuild it`);
    }
    configure(db, true);
    return db;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (!present) return prepare(openRaw(path, false));
  const db = openRaw(path, false);
  const k = classify(db, path);
  if (k.kind === 'foreign') {
    db.close();
    throw foreign(path, k.tables);
  }
  if (k.kind === 'empty' || k.version === SCHEMA_VERSION) return prepare(db);
  db.close();
  if (opts.rebuild === 'beside') return openIndex(nextIndexPath(path));
  // An AgentShark index of another schema version is a cache of the sources: delete the file (much faster than
  // dropping multi-GB tables, and it gives the space back) and index again.
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  return prepare(openRaw(path, false));
}

/**
 * Move the index built beside `path` (`db`, open on `<path>.next`) over the old one and reopen it. Readers of the old file
 * keep their open connections and see the old index until they reopen `path`: its WAL and shared-memory files are
 * unlinked first, so the new index never shares them. Throws, leaving both files as they were, while a connection
 * still holds the new index's WAL.
 */
export function promoteIndex(db: DatabaseSync, path: string): DatabaseSync {
  const next = nextIndexPath(path);
  const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number };
  if (r.busy || r.log > 0) throw new IndexOpenError(`cannot promote ${next}: another connection holds its write-ahead log`);
  db.close();
  for (const suffix of ['-wal', '-shm']) rmSync(path + suffix, { force: true });
  renameSync(next, path);
  for (const suffix of ['-wal', '-shm']) rmSync(next + suffix, { force: true });
  return openIndex(path);
}

/** meta.schema_version of an open index (another version only after a read-only open with `acceptSchema`). */
export function indexSchemaVersion(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

function foreign(path: string, tables: string[]): IndexOpenError {
  const shown = tables.slice(0, 5).join(', ') + (tables.length > 5 ? ', …' : '');
  return new IndexOpenError(`${path} is not an AgentShark index (it holds ${shown}); it was left untouched. Choose another --index path.`);
}

function openRaw(path: string, readOnly: boolean): DatabaseSync {
  const db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** What a database file holds, read without writing to it. */
function classify(db: DatabaseSync, path: string): Kind {
  let appId: number;
  let tables: string[];
  try {
    appId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
    tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((r) => r.name);
  } catch (err) {
    db.close();
    throw new IndexOpenError(`${path} is not an AgentShark index (${(err as Error).message}); it was left untouched. Choose another --index path.`);
  }
  if (!tables.length && appId === 0) return { kind: 'empty' };
  // Indexes written before application_id was set are recognized by their tables.
  const legacy = ['meta', 'sources', 'sessions', 'events', 'spans'].every((t) => tables.includes(t));
  if (appId !== APPLICATION_ID && !legacy) return { kind: 'foreign', tables };
  let version: number | null = null;
  if (tables.includes('meta')) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    version = row ? Number(row.value) : null;
  }
  return { kind: 'ours', version };
}

function configure(db: DatabaseSync, readOnly: boolean): void {
  db.exec(`
    ${readOnly ? '' : 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;'}
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -65536;
    PRAGMA mmap_size = 268435456;
    PRAGMA busy_timeout = 5000;
  `);
  registerFunctions(db);
}

/**
 * Columns schema.sql gained within schema 4. A writable open adds them to an older file; the analysis pass of the
 * analysis version that introduced them fills them (its version bump re-derives every tree).
 */
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ['turn_rollup', 'n', 'INTEGER'], ['turn_rollup', 'call_kinds', 'TEXT'], ['delegations', 'task_chars', 'INTEGER'],
];

function prepare(db: DatabaseSync): DatabaseSync {
  configure(db, false);
  const stored = (db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() as { ok: number } | undefined)
    ? (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)
    : undefined;
  db.exec(SCHEMA_SQL); // IF NOT EXISTS everywhere: creates a new index, restores anything missing in an existing one
  for (const [table, column, type] of ADDED_COLUMNS) {
    if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  if (!stored) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  return db;
}

/** Refresh the planner statistics; cheap (sampled) and run after each index run. */
export function analyze(db: DatabaseSync): void {
  db.exec('PRAGMA analysis_limit = 2000; PRAGMA optimize = 0x10002;');
}

const REGEXP_CACHE_MAX = 64;
/** Patterns longer than this are refused; the filter compiler reports the same limit. */
export const REGEXP_MAX_LENGTH = 500;

/** SQL functions every index connection has: `regexp(pattern, value)` for the filter's `matches` and `~`. */
export function registerFunctions(db: DatabaseSync): void {
  const cache = new Map<string, RegExp>();
  db.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (value == null || pattern == null) return 0;
    const key = String(pattern);
    let re = cache.get(key);
    if (re) {
      // Move to the most-recent position.
      cache.delete(key);
    } else {
      if (key.length > REGEXP_MAX_LENGTH) throw new Error(`regular expression longer than ${REGEXP_MAX_LENGTH} characters`);
      re = new RegExp(key);
      if (cache.size >= REGEXP_CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, re);
    return re.test(String(value)) ? 1 : 0;
  });
}
