// `agentshark serve` (live index) and `agentshark open FILE` (capture file): start the viewer.

import { createHash } from 'node:crypto';
import { createReadStream, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadCapture, type CaptureLoadOptions } from '../capture/reader.ts';
import { engineDigest } from '../capture/manifest.ts';
import { defaultHome, defaultIndexPath, IndexOpenError, openIndex } from '../index/db.ts';
import { startServer, type StartedServer, type StartServerOptions } from '../server/server.ts';
import { type Args, CliError, err, fmtBytes, fmtNum, fmtTime, out, parseInt10, progress, string, tildify, version } from './util.ts';

const DEFAULT_PORT = 7373;
/** `open` without --port tries this many ports from the default before giving up. */
const PORT_ATTEMPTS = 20;

/** Open an index for writing; another program's database is refused untouched. */
function openWritable(indexPath: string) {
  try {
    return openIndex(indexPath);
  } catch (e) {
    if (e instanceof IndexOpenError) throw new CliError(e.message);
    throw e;
  }
}

/**
 * With --handshake, stdout carries exactly one JSON line once the server listens (the Mac app reads it); everything
 * else goes to stderr. Without it, the human-readable banner goes to stdout.
 */
function announce(a: Args, server: StartedServer, mode: 'live' | 'capture', indexPath: string, lines: string[]): void {
  if (a.values.handshake === true) {
    process.stdout.write(JSON.stringify({ event: 'ready', url: server.url, token: server.token, port: server.port, mode, indexPath, version: version() }) + '\n');
    for (const l of lines) console.error(l);
  } else {
    for (const l of lines) console.log(l);
  }
}

/**
 * The server opens the index itself: it writes it when no other process does (the first `serve` or Mac app engine on
 * an index), and otherwise follows the process that does, reading and reporting its changes.
 */
export async function serve(a: Args): Promise<number> {
  const indexPath = resolve(string(a.values.index) ?? defaultIndexPath());
  const port = parseInt10(string(a.values.port), '--port') ?? DEFAULT_PORT;
  const watch = a.values['no-watch'] !== true;
  let first = true;
  const bar = progress('indexing');
  let server: StartedServer;
  try {
    server = await listen(
      {
        port,
        open: a.values['no-open'] !== true,
        watch,
        mode: 'live',
        indexPath,
        onIndex: (event, data) => {
          if (!first) return;
          if (event === 'index-progress') return bar.update(data.done, data.total, data.currentPath ? tildify(data.currentPath) : '');
          bar.done();
          first = false;
          if (data.error) console.error(`${err.red('indexing failed:')} ${data.error}`);
          else if (data.parsed !== undefined) console.error(err.dim(`indexed ${fmtNum(data.parsed)} changed of ${fmtNum(data.sources)} sources in ${(data.ms / 1000).toFixed(1)} s`));
        },
      },
      1,
    );
  } catch (e) {
    if (e instanceof IndexOpenError) throw new CliError(e.message);
    throw e;
  }
  const policy = server.writer
    ? `AgentShark (pid ${server.writer}) indexes this index; this server follows its changes${watch ? ' and takes over when it exits' : ''}`
    : `Indexing runs in the background${watch ? ' and follows file changes' : '; files are not watched (POST /api/reindex or restart to refresh)'}`;
  announce(a, server, 'live', indexPath, [
    `${out.bold('AgentShark')}  live index ${tildify(indexPath)}`,
    `  viewer  ${out.cyan(server.url)}`,
    out.dim(`  ${policy}. Press Ctrl+C to stop.`),
  ]);
  return untilSignal(server);
}

export async function openCapture(a: Args): Promise<number> {
  const file = a.positionals[0];
  if (!file) throw new CliError('open needs a capture file: agentshark open FILE.agentcap', 2);
  const explicitPort = parseInt10(string(a.values.port), '--port');
  const analysis = string(a.values.analysis);
  const integrity = string(a.values.integrity);
  if (analysis !== undefined && analysis !== 'recorded' && analysis !== 'current') throw new CliError('--analysis expects recorded or current', 2);
  if (integrity !== undefined && integrity !== 'strict' && integrity !== 'recover') throw new CliError('--integrity expects strict or recover', 2);
  const { db, capturePath, indexPath } = await openCaptureIndex(file, { analysis, integrity });
  const server = await listen(
    { port: explicitPort ?? DEFAULT_PORT, open: a.values['no-open'] !== true, db, mode: 'capture', indexPath, capturePath },
    explicitPort === undefined ? PORT_ATTEMPTS : 1,
  );
  announce(a, server, 'capture', indexPath, [
    `${out.bold('AgentShark')}  capture ${tildify(capturePath)}`,
    `  viewer  ${out.cyan(server.url)}`,
    out.dim('  Press Ctrl+C to stop.'),
  ]);
  return untilSignal(server, db);
}

/**
 * The index of a capture file, kept in ~/.agentshark/captures and reused while the file is unchanged. Prints what the
 * capture could not include.
 */
export async function openCaptureIndex(file: string, opts: CaptureLoadOptions = {}): Promise<{ db: DatabaseSync; capturePath: string; indexPath: string }> {
  const capturePath = resolve(file);
  const st = statSync(capturePath, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new CliError(`no such capture file: ${file}`);
  const indexPath = join(defaultHome(), 'captures', createHash('sha1').update(capturePath).digest('hex') + '.sqlite');
  const { db, notes } = await captureIndex(capturePath, indexPath, st, opts);
  for (const n of notes) console.error(n);
  return { db, capturePath, indexPath };
}

// Keys in the capture index's meta table that record which capture file it was built from.
const META_SIZE = 'cli.capture_size';
const META_MTIME = 'cli.capture_mtime_ms';
const META_LOAD_OPTIONS = 'cli.capture_load_options';
const META_DIGEST = 'cli.capture_sha256';

/**
 * Reuse the capture's index when the file is unchanged since it was loaded; otherwise rebuild it. Either way the notes
 * describe the capture from its stored header, completeness and coverage, so a cached reopen warns exactly as the
 * first one did.
 */
export async function captureIndex(capturePath: string, indexPath: string, st: { size: number; mtimeMs: number }, opts: CaptureLoadOptions = {}): Promise<{ db: DatabaseSync; notes: string[] }> {
  let db = openWritable(indexPath);
  const meta = new Map(
    (db.prepare('SELECT key, value FROM meta WHERE key IN (?, ?, ?, ?)').all(META_SIZE, META_MTIME, META_LOAD_OPTIONS, META_DIGEST) as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );
  const notes: string[] = [];
  const loadOptions = JSON.stringify({ analysis: opts.analysis ?? 'recorded', integrity: opts.integrity ?? 'strict', engine: engineDigest() });
  const hash = createHash('sha256');
  try { for await (const chunk of createReadStream(capturePath)) hash.update(chunk); }
  catch (error) { db.close(); throw error; }
  const sha256 = hash.digest('hex');
  if (meta.get(META_SIZE) !== String(st.size) || meta.get(META_MTIME) !== String(st.mtimeMs) || meta.get(META_LOAD_OPTIONS) !== loadOptions || meta.get(META_DIGEST) !== sha256) {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(indexPath + suffix, { force: true });
    db = openWritable(indexPath);
    const bar = progress('loading capture');
    try {
      const res = await loadCapture(capturePath, db, (bytes) => bar.update(Math.min(bytes, st.size), st.size), opts);
      bar.done();
      notes.push(err.dim(`loaded ${fmtBytes(st.size)}: ${Object.entries(res.counts).map(([k, v]) => `${fmtNum(v)} ${k}`).join(', ')}`));
    } catch (e) {
      bar.done();
      db.close();
      throw new CliError(`cannot load ${tildify(capturePath)}: ${(e as Error).message}`);
    }
    const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    put.run(META_SIZE, String(st.size));
    put.run(META_MTIME, String(st.mtimeMs));
    put.run(META_LOAD_OPTIONS, loadOptions);
    put.run(META_DIGEST, sha256);
  }
  return { db, notes: [...captureNotes(db), ...notes] };
}

/** Origin, completeness and coverage of the capture loaded into `db`, from its meta table. */
export function captureNotes(db: DatabaseSync): string[] {
  const meta = new Map((db.prepare("SELECT key, value FROM meta WHERE key LIKE 'capture_%'").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const parse = (k: string) => {
    try {
      return JSON.parse(meta.get(k) ?? 'null');
    } catch {
      return null;
    }
  };
  const header = parse('capture_header') ?? {};
  const coverage = parse('capture_coverage');
  const integrity = parse('capture_integrity');
  const analysis = parse('capture_analysis');
  const notes: string[] = [];
  const host = header.host?.hostname ? ` on ${header.host.hostname}` : '';
  const created = typeof header.created === 'number' ? ` at ${fmtTime(header.created)}` : '';
  notes.push(err.dim(`capture written${created}${host} by ${header.tool?.name ?? 'an unknown writer'} ${header.tool?.version ?? ''}`.trimEnd()));
  notes.push(err.dim(`integrity: ${integrity?.status ?? 'unverified'}; analysis: ${analysis?.mode ?? 'legacy'}`));
  if (integrity?.status === 'failed') notes.push(err.yellow('warning: recovered evidence failed integrity checks; inspect the reported errors before using it.'));
  if (header.privacy) notes.push(err.yellow('note: this capture removes private evidence; some analyses will be unknown.'));
  if (meta.get('capture_complete') !== '1') notes.push(err.yellow('warning: the capture is truncated (no end record); showing what it contains.'));
  if (header.options?.raw === false) notes.push(err.yellow('note: written with --no-raw; the raw pane has no source lines.'));
  if (coverage?.known === false) {
    // The coverage report travels in the end record: a truncated stream lost it, an older writer never wrote one.
    notes.push(err.dim(meta.get('capture_complete') !== '1'
      ? 'note: the coverage report was in the missing end record; missing raw lines and side files are not known.'
      : 'note: this capture predates coverage records; missing raw lines and side files are not known.'));
  }
  if (coverage?.rawUnavailable > 0) notes.push(err.yellow(`warning: ${fmtNum(coverage.rawUnavailable)} raw source lines were unavailable when the capture was written.`));
  if (coverage?.sidecarsOmitted?.length) notes.push(err.yellow(`warning: ${fmtNum(coverage.sidecarsOmitted.length)} side files were left out (${[...new Set(coverage.sidecarsOmitted.map((s: { reason: string }) => s.reason))].join(', ')}).`));
  return notes;
}

/** Start the server, moving to the next port while the requested one is taken (up to `attempts` ports). */
async function listen(opts: StartServerOptions, attempts: number) {
  for (let i = 0; ; i++) {
    try {
      return await startServer({ ...opts, port: opts.port + i });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      if (i + 1 >= attempts) {
        throw new CliError(`port ${opts.port + i} is already in use (is another agentshark running?). Choose one with --port.`);
      }
    }
  }
}

async function untilSignal(server: { close(): Promise<void> }, db?: DatabaseSync): Promise<never> {
  await new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  process.stderr.write('\nstopping…\n');
  await server.close();
  db?.close();
  // Worker threads of an index run in flight would keep the process alive. A file's rows and its sources
  // row commit together, so exiting mid-run leaves a consistent index; uncommitted files are re-parsed next run.
  process.exit(0);
}
