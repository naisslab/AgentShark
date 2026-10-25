// `agentshark why`: the Run report of one run (SPEC §12.6), as Markdown, or with --json as the MCP run_report.

import { resolve } from 'node:path';
import type { RunRef, RunResolution } from '../index/api.ts';
import { defaultIndexPath, IndexOpenError } from '../index/db.ts';
import { IndexBusyError } from '../index/indexer.ts';
import { redactText } from '../mcp/redact.ts';
import { derivedModule, openToolContext } from '../mcp/server.ts';
import { runReportFor, type McpToolContext } from '../mcp/tools.ts';
import { indexUnderLock } from './indexing.ts';
import { type Args, CliError, err, parseTime, progress, string, tildify, write } from './util.ts';

/** The tool context the CLI mirrors share: the whole index (no project scope), no byte cap. */
export async function openCliContext(a: Args): Promise<{ ctx: McpToolContext; close(): void }> {
  const indexPath = string(a.values.index) ?? defaultIndexPath();
  try {
    return await openToolContext({ indexPath, scope: 'all', maxBytes: Infinity, allowRaw: false, cwd: process.cwd() }, null);
  } catch (e) {
    if (e instanceof IndexOpenError) throw new CliError(e.message.replace(indexPath, tildify(indexPath)));
    throw e;
  }
}

export async function why(a: Args): Promise<number> {
  const session = string(a.values.session);
  const cwd = string(a.values.cwd);
  if (session !== undefined && (a.values.last || cwd !== undefined)) throw new CliError('--session names one run; drop --last and --cwd', 2);
  if (a.values.json && a.values.md) throw new CliError('choose one of --json and --md', 2);
  const sinceText = string(a.values.since);
  const since = sinceText === undefined ? undefined : parseTime(sinceText, '--since');
  if (a.values.refresh) await refresh(string(a.values.index) ?? defaultIndexPath());

  const ref: RunRef = session !== undefined ? { session } : { session: 'latest', ...(cwd !== undefined && { cwd: resolve(cwd) }) };
  const { ctx, close } = await openCliContext(a);
  try {
    if (a.values.json) {
      const { structuredContent } = runReportFor(ctx, ref, since);
      await write(JSON.stringify(structuredContent, null, 2) + '\n');
      return structuredContent.report ? 0 : 1;
    }
    const resolved = ctx.derived.resolveRun(ref);
    const report = resolved.id ? ctx.derived.runReport(resolved.id, since === undefined ? {} : { since }) : null;
    if (!report) throw new CliError(notFound(ref));
    console.error(err.dim(resolution(resolved)));
    const md = (await derivedModule()).renderRunReportMarkdown(report);
    await write(redactText(md).text + '\n');
    return 0;
  } finally {
    close();
  }
}

function notFound(ref: RunRef): string {
  if (ref.session !== 'latest') return `no run ${ref.session} in the index`;
  return `no run found${ref.cwd ? ` under ${tildify(ref.cwd)}` : ''}; run 'agentshark index' first, or pass --refresh`;
}

function resolution(r: RunResolution): string {
  const how = r.rule === 'explicit' ? 'Run' : r.rule === 'latest' ? 'Latest finished run' : 'Latest run (possibly running; no finished run matched)';
  const others = r.candidates.filter((c) => c.id !== r.id).map((c) => c.id);
  return `${how} ${r.id}${others.length ? `; other recent runs: ${others.join(', ')}` : ''}`;
}

/** --refresh: one index pass when `<index>.lock` is free; otherwise the index is used as it is. */
async function refresh(indexPath: string): Promise<void> {
  const bar = progress('indexing');
  try {
    await indexUnderLock(indexPath, () => ({ onProgress: (p) => bar.update(p.done, p.total, p.currentPath ? tildify(p.currentPath) : '') }));
  } catch (e) {
    if (e instanceof IndexOpenError) throw new CliError(e.message);
    if (!(e instanceof IndexBusyError)) throw e;
    console.error(err.dim(`${e.message} Using the index as it is.`));
  } finally {
    bar.done();
  }
}
