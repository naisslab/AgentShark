import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultIndexPath, openIndex } from '../index/db.ts';
import { runWorkbench, validOperation, WORKBENCH_OPERATIONS } from '../server/workbench.ts';
import { readSourceConfig, sourceConfigPath, writeSourceConfig } from '../source-config.ts';
import { type Args, CliError, string, strings, write } from './util.ts';

/** The CLI and HTTP surface use the same bounded, snapshot-based analyses. */
export async function analyze(a: Args, checksOnly = false): Promise<number> {
  const operation = checksOnly ? 'checks' : a.positionals[0];
  if (!operation || !validOperation(operation)) throw new CliError(`Choose an analysis: ${WORKBENCH_OPERATIONS.join(', ')}`, 2);
  let input: Record<string, unknown> = {};
  const inputPath = string(a.values.input);
  if (inputPath) {
    try {
      const text = await readFile(resolve(inputPath), 'utf8');
      // A replay report is the JSON lines `agentshark replay --json` wrote (one line when it planned no calls).
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (e) {
        if (operation !== 'replayReport') throw e;
      }
      if (operation === 'replayReport' && (value === undefined || (value as { type?: unknown } | null)?.type === 'plan')) value = { jsonl: text };
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
      input = value as Record<string, unknown>;
    } catch (e) { throw new CliError(`Cannot read --input: ${(e as Error).message}`, 2); }
  }
  const sessions = strings(a.values.session);
  if (sessions?.length) {
    input.sessions = sessions;
    input.sessionIds = sessions;
    input.session = sessions[0];
  }
  for (const key of ['left', 'right', 'table', 'format', 'title']) {
    const v = string(a.values[key]);
    if (v !== undefined) input[key] = v;
  }
  const rules = strings(a.values.rule);
  if (rules?.length) input.rules = rules;
  const indexPath = string(a.values.index) ?? defaultIndexPath();
  const db = openIndex(indexPath, { readOnly: true });
  try {
    const result = await runWorkbench(db, operation, input, { indexPath }) as Record<string, unknown>;
    const text = JSON.stringify(result, null, 2) + '\n';
    const output = string(a.values.out);
    if (output) await writeFile(resolve(output), text, { flag: 'wx', mode: 0o600 });
    else await write(text);
    if (!checksOnly) return 0;
    // Absence of a known passing result is not a pass. This also fails closed on future schema changes.
    const summary = result.summary as { pass?: number; fail?: number; unknown?: number } | undefined;
    if (summary && Number(summary.fail) > 0) return 1;
    if (summary && Number(summary.pass) > 0 && summary.fail === 0 && summary.unknown === 0) return 0;
    return 3;
  } catch (e) {
    if ((e as { status?: number }).status === 400) throw new CliError((e as Error).message, 2);
    throw e;
  } finally { db.close(); }
}

export async function configureSources(a: Args): Promise<number> {
  const config = readSourceConfig();
  const agent = string(a.values.agent);
  const add = strings(a.values.add) ?? [];
  const remove = strings(a.values.remove) ?? [];
  if ((add.length || remove.length) && agent !== 'claude' && agent !== 'codex') throw new CliError('--agent must be claude or codex when changing roots', 2);
  if (a.values['auto-discover'] && a.values['no-auto-discover']) throw new CliError('Choose --auto-discover or --no-auto-discover', 2);
  if (agent === 'claude' || agent === 'codex') {
    const key = agent === 'claude' ? 'claudeRoots' : 'codexRoots';
    const absolute = (p: string) => resolve(p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? homedir() + p.slice(1) : p);
    const excluded = new Set(remove.map(absolute));
    config[key] = [...new Set([...config[key], ...add.map(absolute)])].filter(p => !excluded.has(p));
  }
  if (a.values['auto-discover']) config.autoDiscover = true;
  if (a.values['no-auto-discover']) config.autoDiscover = false;
  if (add.length || remove.length || a.values['auto-discover'] || a.values['no-auto-discover']) writeSourceConfig(config);
  await write(JSON.stringify({ path: sourceConfigPath(), config, note: 'Restart a running viewer after changing source locations.' }, null, 2) + '\n');
  return 0;
}
