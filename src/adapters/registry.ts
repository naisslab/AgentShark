// All source adapters, in discovery order (MODULES.md). When two adapters claim the same path, the
// earlier one wins.

import type { Adapter } from './adapter.ts';
import { claudeAdapter } from './claude.ts';
import { claudeDesktopAdapter } from './claude-desktop.ts';
import { codexAdapter } from './codex.ts';
import { codexStateAdapter } from './codex-state.ts';
import { copilotAdapter } from './copilot.ts';
import { copilotCliAdapter } from './copilot-cli.ts';
import { coworkAuditAdapter } from './cowork-audit.ts';

export const ADAPTERS: Adapter[] = [claudeAdapter, claudeDesktopAdapter, coworkAuditAdapter, codexAdapter, codexStateAdapter, copilotAdapter, copilotCliAdapter];

export function adapterByName(name: string): Adapter {
  const adapter = ADAPTERS.find((a) => a.name === name);
  if (!adapter) throw new Error(`Unknown adapter: ${name}`);
  return adapter;
}
