// A disposable, synthetic first run. The person's HOME, sources and index stay untouched.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSourceConfig } from '../source-config.ts';
import { serve } from './serve.ts';
import { type Args, CliError } from './util.ts';

/**
 * The synthetic sample: Codex sessions, and the analysis corpus (test/fixtures/derive) with a Claude Code session,
 * its subagents and workflow, and Codex sessions with failures. scripts/build.mjs copies them into samples/.
 */
export function demoRoots(): { claudeRoots: string[]; codexRoots: string[] } {
  const at = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
  const packaged = { claudeRoots: [at('samples/claude/')], codexRoots: [at('samples/codex/'), at('samples/codex-failures/')] };
  const source = {
    claudeRoots: [at('test/fixtures/derive/home/.claude/')],
    codexRoots: [at('test/fixtures/codex/home/.codex/'), at('test/fixtures/derive/home/.codex/')],
  };
  for (const roots of [packaged, source]) if ([...roots.claudeRoots, ...roots.codexRoots].every((p) => existsSync(p))) return roots;
  throw new CliError('The synthetic sample is missing. Reinstall AgentShark or rebuild the package.');
}

export async function demo(a: Args): Promise<number> {
  const roots = demoRoots();
  const temp = mkdtempSync(join(tmpdir(), 'agentshark-demo-'));
  const previousHome = process.env.AGENTSHARK_HOME;
  const previousConfig = process.env.AGENTSHARK_SOURCE_CONFIG;
  const config = join(temp, 'sources.json');
  writeSourceConfig({ version: 1, autoDiscover: false, ...roots }, config);
  process.env.AGENTSHARK_HOME = temp;
  process.env.AGENTSHARK_SOURCE_CONFIG = config;
  const cleanup = () => rmSync(temp, { recursive: true, force: true });
  process.once('exit', cleanup);
  console.error('Synthetic demo: only the bundled sample is indexed. This temporary index is removed when you close the demo.');
  try { return await serve({ ...a, values: { ...a.values, index: join(temp, 'index.sqlite'), 'no-watch': true } }); }
  finally {
    if (previousHome === undefined) delete process.env.AGENTSHARK_HOME; else process.env.AGENTSHARK_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.AGENTSHARK_SOURCE_CONFIG; else process.env.AGENTSHARK_SOURCE_CONFIG = previousConfig;
    process.removeListener('exit', cleanup);
    cleanup();
  }
}
