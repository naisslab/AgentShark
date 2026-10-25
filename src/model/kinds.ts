// Event and span taxonomy (SPEC §3.5, §3.6) with descriptions for the UI and the filter field list.

import type { EventKind, SpanKind } from './types.ts';

export const LAYERS = ['session', 'user', 'llm', 'tool', 'agent', 'context', 'turn', 'hook', 'permission', 'harness', 'raw'] as const;
export type Layer = (typeof LAYERS)[number];

export const EVENT_KINDS: Record<EventKind, string> = {
  'session.meta': 'Session metadata: session_meta, environment, init, prompt snapshot',
  'session.state': 'Session state change: title, mode, permission mode, worktree, cost state',
  'user.prompt': 'Prompt typed by a human',
  'user.inject': 'Harness-injected user-role content: meta prompts, command output, task notifications',
  'llm.text': 'Assistant text output',
  'llm.thinking': 'Assistant thinking or reasoning block',
  'llm.usage': 'Token usage report for a model response',
  'llm.error': 'Model API error or retry',
  'llm.refusal': 'Model refusal or refusal fallback',
  'tool.call': 'Tool invocation emitted by the model',
  'tool.result': 'Tool result returned to the model',
  'tool.exec': 'Execution item nested in a tool call (commands, patches, MCP calls)',
  'agent.spawn': 'Subagent launch',
  'agent.message': 'Message between agents',
  'agent.status': 'Subagent status or completion notification',
  'context.attachment': 'Context injected by the harness: reminders, instructions, tool lists',
  'context.compaction': 'Context compaction boundary or summary',
  'context.snapshot': 'Snapshot of the system prompt, tool definitions or world state',
  'turn.start': 'Start of a turn',
  'turn.end': 'End of a turn',
  'turn.abort': 'Turn aborted or interrupted',
  'hook.run': 'Hook execution',
  'permission.request': 'Permission requested for a tool call',
  'permission.decision': 'Permission decision for a tool call',
  'harness.queue': 'Prompt queue operation',
  'harness.ratelimit': 'Rate-limit status',
  'harness.status': 'Harness status change (requesting, compacting)',
  'harness.file': 'File-history snapshot or backup',
  'harness.vcs': 'Version-control link (pull request)',
  'harness.other': 'Other harness record',
  'raw.unknown': 'Record type AgentShark does not decode; kept verbatim',
};

export const SPAN_KINDS: Record<SpanKind, string> = {
  session: 'Whole session',
  turn: 'One user turn: prompt to final answer',
  llm: 'One model API response',
  tool: 'One tool call: invocation to result',
  exec: 'Execution nested inside a tool call',
  workflow: 'Workflow run launched by a tool call',
  phase: 'Workflow phase',
  compaction: 'Context compaction',
  hook: 'Hook execution',
  retry: 'API retry with backoff',
  permission: 'Wait for a permission decision',
};

export function layerOf(kind: string): string {
  const i = kind.indexOf('.');
  return i < 0 ? kind : kind.slice(0, i);
}

/** Display order of span kinds in timeline lanes (outermost first). */
export const SPAN_DEPTH: Record<SpanKind, number> = {
  session: 0,
  turn: 1,
  workflow: 2,
  phase: 3,
  llm: 2,
  tool: 2,
  compaction: 2,
  hook: 2,
  retry: 2,
  permission: 2,
  exec: 3,
};
