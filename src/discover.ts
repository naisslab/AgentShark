// Source discovery across all adapters (MODULES.md): run every adapter's discover() in parallel,
// drop credential paths and agents outside env.agents, and keep one entry per path.

import { type DiscoverEnv, type SourceFile, defaultEnv, isCredentialPath } from './adapters/adapter.ts';
import { ADAPTERS } from './adapters/registry.ts';

export async function discoverSources(env: DiscoverEnv = defaultEnv()): Promise<SourceFile[]> {
  const results = await Promise.allSettled(ADAPTERS.map((a) =>
    env.autoDiscover === false && !['claude', 'codex', 'codex-state'].includes(a.name) ? Promise.resolve([]) : a.discover(env)));
  const byPath = new Map<string, SourceFile>();
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      // One adapter failing to list its directories must not hide every other agent.
      process.emitWarning(`discover failed for adapter ${ADAPTERS[i].name}: ${(r.reason as Error)?.message ?? r.reason}`);
      return;
    }
    for (const f of r.value) {
      if (isCredentialPath(f.path) || byPath.has(f.path)) continue;
      if (env.agents && !env.agents.includes(f.agent)) continue;
      byPath.set(f.path, f);
    }
  });
  return [...byPath.values()];
}
