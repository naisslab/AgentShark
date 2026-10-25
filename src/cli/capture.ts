// `agentshark capture`: write selected sessions to a self-contained .agentcap file (docs/FORMAT.md).

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeCapture } from '../capture/writer.ts';
import { defaultIndexPath, IndexOpenError, openIndex } from '../index/db.ts';
import { IndexBusyError } from '../index/indexer.ts';
import { indexUnderLock } from './indexing.ts';
import { type Args, CliError, err, filterError, fmtBytes, fmtNum, out, parseAgents, parseTime, progress, string, strings, tildify } from './util.ts';

const COMPRESSIONS = ['zstd', 'gzip', 'none'] as const;

export async function capture(a: Args): Promise<number> {
  const outFile = string(a.values.out);
  const preview = a.values.preview === true;
  if (!outFile && !preview) throw new CliError('capture needs an output file or --preview: agentshark capture -o FILE.agentcap', 2);
  const profile = string(a.values.profile) ?? 'forensic';
  if (profile !== 'forensic' && profile !== 'shareable') throw new CliError('--profile expects forensic or shareable', 2);
  const keyFile = string(a.values['redaction-key-file']);
  const redactionKey = keyFile ? (await readFile(resolve(keyFile), 'utf8')).trim() : undefined;
  if (keyFile && (!redactionKey || redactionKey.length < 16 || redactionKey.length > 4096)) throw new CliError('Redaction key must contain 16 to 4096 characters', 2);
  const compress = string(a.values.compress);
  if (compress !== undefined && !COMPRESSIONS.includes(compress as (typeof COMPRESSIONS)[number])) {
    throw new CliError(`--compress expects one of ${COMPRESSIONS.join(', ')} (got '${compress}')`, 2);
  }
  // Parsed before indexing, so a typo fails fast.
  const [since, until] = (['since', 'until'] as const).map((k) => {
    const v = string(a.values[k]);
    return v === undefined ? undefined : parseTime(v, `--${k}`);
  });
  const filter = string(a.values.filter);
  const agents = parseAgents(strings(a.values.agent));
  const indexPath = string(a.values.index) ?? defaultIndexPath();
  const mode = string(a.values.progress);
  if (mode !== undefined && mode !== 'json') throw new CliError(`--progress expects json (got '${mode}')`, 2);
  const json = mode === 'json';
  // JSON progress: one line per update on stdout, at most every 100 ms plus the last one of each phase.
  const reporter = (phase: string) => {
    if (!json) return progress(phase === 'index' ? 'updating index' : 'writing capture');
    let last = 0;
    return {
      update(done: number, total: number) {
        const now = Date.now();
        if (now - last < 100 && done !== total) return;
        last = now;
        process.stdout.write(JSON.stringify({ event: 'progress', phase, done, total }) + '\n');
      },
      done() {},
    };
  };

  let db;
  try {
    if (a.values['no-index'] !== true) {
      const bar = reporter('index');
      try {
        await indexUnderLock(indexPath, (building) => ({ agents: building ? undefined : agents, onProgress: (p) => bar.update(p.done, p.total) }));
      } catch (e) {
        // A running server is updating the index: capture what it has committed so far.
        if (!(e instanceof IndexBusyError)) throw e;
        console.error(`${e.message} Capturing the index as it is.`);
      } finally {
        bar.done();
      }
    }
    // The capture only reads, so a server may keep writing meanwhile.
    db = openIndex(indexPath, { readOnly: true });
  } catch (e) {
    if (e instanceof IndexOpenError) throw new CliError(e.message);
    throw e;
  }
  try {
    const bar = reporter('capture');
    const result = await writeCapture(db, {
      out: outFile ? resolve(outFile) : '',
      profile,
      dryRun: preview,
      redactionKey,
      compress: compress as (typeof COMPRESSIONS)[number] | undefined,
      since,
      until,
      agents,
      sessions: strings(a.values.session),
      filter,
      raw: a.values['no-raw'] !== true,
      sidecars: a.values['no-sidecars'] !== true,
      indexPath,
      onProgress: (p) => bar.update(p.done, p.total),
    })
      .catch((e) => {
        throw (filter !== undefined && filterError(e, filter)) || e;
      })
      .finally(() => bar.done());
    if (preview) {
      process.stdout.write(JSON.stringify(result.preview, null, 2) + '\n');
      return 0;
    }
    if (json) {
      const { path, bytes, counts, coverage, ms } = result;
      process.stdout.write(JSON.stringify({ event: 'done', path, bytes, counts, coverage, ms: Math.round(ms) }) + '\n');
      return 0;
    }
    const counts = Object.entries(result.counts).filter(([k]) => k !== 'rawUnavailable').map(([k, v]) => `${fmtNum(v)} ${k}`).join(', ');
    console.log(`${out.bold('Wrote')} ${tildify(result.path)}  ${fmtBytes(result.bytes)} in ${(result.ms / 1000).toFixed(1)} s`);
    console.log(`  ${counts || 'no records'}`);
    const c = result.coverage;
    if (c.rawUnavailable) console.error(err.yellow(`warning: ${fmtNum(c.rawUnavailable)} raw source lines were unavailable (files deleted or rewritten since indexing).`));
    if (c.sidecarsOmitted.length) console.error(err.yellow(`warning: ${fmtNum(c.sidecarsOmitted.length)} side files were left out (${[...new Set(c.sidecarsOmitted.map((s) => s.reason))].join(', ')}).`));
    if (!result.counts.sessions) console.error(err.yellow('warning: no session matched the selection.'));
    return 0;
  } finally {
    db.close();
  }
}
