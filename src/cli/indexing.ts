// `agentshark index`: build or update the live index and report what changed.

import { resolve } from 'node:path';
import { defaultIndexPath, IndexOpenError, nextIndexPath, openIndex, promoteIndex } from '../index/db.ts';
import { acquireWriterLock, IndexBusyError, type IndexRunOptions, type IndexRunResult, runIndex } from '../index/indexer.ts';
import { type Args, CliError, fmtNum, out, parseAgents, parseInt10, progress, string, strings, tildify } from './util.ts';

export async function index(a: Args): Promise<number> {
  const indexPath = resolve(string(a.values.index) ?? defaultIndexPath());
  const rederive = a.values.rederive === true;
  if (rederive && a.values.full === true) throw new CliError('--rederive re-derives the analysis without re-parsing; it cannot be combined with --full');
  let bar: ReturnType<typeof progress> | undefined;
  try {
    // A new index has nothing to re-derive, and replaces the old one complete: every agent is indexed from the sources.
    const result = await indexUnderLock(indexPath, (building) => {
      const b = (bar = progress(rederive && !building ? 're-deriving' : 'indexing'));
      return {
        rederive: rederive && !building,
        full: a.values.full === true,
        agents: building ? undefined : parseAgents(strings(a.values.agent)),
        workers: parseInt10(string(a.values.workers), '--workers', 1),
        onProgress: (p) => b.update(p.done, p.total, p.currentPath ? tildify(p.currentPath) : ''),
      };
    });
    bar?.done();
    console.log(`${out.bold('Indexed')} ${tildify(indexPath)}`);
    console.log(indexSummary(result));
    return 0;
  } catch (e) {
    bar?.done();
    if (e instanceof IndexBusyError || e instanceof IndexOpenError) throw new CliError(e.message);
    throw e;
  }
}

/**
 * One index run under the writer lock, so a command never writes beside a server that keeps the index current (it
 * throws IndexBusyError instead). An index of another schema keeps serving its readers while the new one builds at
 * `<index>.next`; the run then promotes it. `options` learns whether the run builds that new index.
 */
export async function indexUnderLock(indexPath: string, options: (building: boolean) => Omit<IndexRunOptions, 'lockHeld'>): Promise<IndexRunResult> {
  const release = acquireWriterLock(indexPath);
  let db;
  try {
    db = openIndex(indexPath, { rebuild: 'beside' });
  } catch (e) {
    release();
    throw e;
  }
  try {
    const building = !!db.location()?.endsWith(nextIndexPath(''));
    const result = await runIndex(db, { ...options(building), lockHeld: true });
    if (building) db = promoteIndex(db, indexPath);
    return result;
  } finally {
    db.close();
    release();
  }
}

export function indexSummary(r: IndexRunResult): string {
  const lines = [
    `  sources   ${fmtNum(r.sources)}: ${fmtNum(r.parsed)} parsed, ${fmtNum(r.unchanged)} unchanged, ${fmtNum(r.removed)} removed`,
    `  records   ${fmtNum(r.events)} events, ${fmtNum(r.spans)} spans in parsed files`,
    `  sessions  ${fmtNum(r.changedSessions.length)} changed`,
    `  time      ${(r.ms / 1000).toFixed(1)} s, peak memory ${fmtNum(r.peakRssMb)} MB`,
  ];
  if (r.analysis) {
    const share = r.ms > 0 ? ` (${Math.round((100 * r.analysis.ms) / r.ms)}% of the run)` : '';
    const pending = r.analysis.pending ? `, ${fmtNum(r.analysis.pending)} tree(s) pending` : '';
    lines.push(`  analysis  ${(r.analysis.ms / 1000).toFixed(1)} s${share}${pending}`);
  }
  if (r.errors.length) {
    lines.push(out.yellow(`  ${r.errors.length} file(s) failed:`));
    for (const e of r.errors.slice(0, 10)) lines.push(`    ${tildify(e.path)}: ${e.error}`);
    if (r.errors.length > 10) lines.push(out.dim(`    … ${r.errors.length - 10} more (see 'agentshark sources')`));
  }
  return lines.join('\n');
}
