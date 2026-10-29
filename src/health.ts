// Logging-health report (SPEC §8; `agentshark sources`, GET /api/sources). For each agent: what is on
// disk and in the index, which capabilities its logs provide (measured from the index where possible,
// otherwise taken from docs/research), what was lost, and how to log more.

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type DiscoverEnv, agentRoots, defaultEnv } from './adapters/adapter.ts';
import { openReadOnly } from './adapters/codex-state.ts';
import { emptySessionMeasures, measureSessions, type SessionMeasures } from './index/linker.ts';
import { type AgentKind, type Capability, type CapabilityLevel, FLAG_BITS, type HealthFinding, type HealthRecommendation, type HealthReport } from './model/types.ts';

type Known = Record<Capability, [CapabilityLevel, string]>;
type Counts = Record<string, number>;

const CAPABILITIES: Capability[] = [
  'timestamps', 'llm-latency', 'ttft', 'tool-durations', 'exit-codes', 'token-usage', 'cache-tokens', 'reasoning-text',
  'system-prompt', 'tool-definitions', 'subagent-tree', 'file-diffs', 'cost', 'raw-http', 'permission-decisions',
];

// What each agent's logs provide according to docs/research; used where the index cannot measure it.
const CLAUDE_KNOWN: Known = {
  timestamps: ['logged', 'Every transcript record carries an ISO-8601 timestamp.'],
  'llm-latency': ['derived', 'No latency field; derived from the gap between request and response records.'],
  ttft: ['absent', 'Transcripts do not record time to first token.'],
  'tool-durations': ['derived', 'tool_use to tool_result timestamp gap; WebFetch, WebSearch and Agent results log their own duration.'],
  'exit-codes': ['partial', 'Bash results report interruption and a return-code interpretation in toolUseResult.'],
  'token-usage': ['logged', 'message.usage on every assistant record.'],
  'cache-tokens': ['logged', 'cache_read_input_tokens and cache_creation_input_tokens in message.usage.'],
  'reasoning-text': ['partial', 'Thinking blocks are logged when the model returns readable thinking.'],
  'system-prompt': ['partial', 'Transcripts omit the system prompt; the desktop registry keeps only the appended part.'],
  'tool-definitions': ['partial', 'Deferred-tool records and attachments list tool names, not schemas.'],
  'subagent-tree': ['logged', 'Subagent meta.json files link each subagent to the Agent call that spawned it.'],
  'file-diffs': ['logged', 'file-history snapshots keep pre-edit copies of changed files.'],
  cost: ['absent', 'Transcripts carry no cost; Claude Code OpenTelemetry api_request events do.'],
  'raw-http': ['absent', 'Request and response bodies are not logged; OpenTelemetry can write them (OTEL_LOG_RAW_API_BODIES).'],
  'permission-decisions': ['partial', 'Permission-mode changes and, in newer versions, permissionDecision fields; no wait times.'],
};

const KNOWN: Record<AgentKind, Known> = {
  'claude-code': CLAUDE_KNOWN,
  'claude-cowork': {
    ...CLAUDE_KNOWN,
    'llm-latency': ['partial', 'audit result.duration_api_ms gives API time per turn, not per model call.'],
    ttft: ['partial', 'audit result.ttft_ms per turn, from CLI 2.1.142.'],
    'system-prompt': ['logged', 'The session registry stores the full system prompt (AgentShark indexes its length only).'],
    'tool-definitions': ['partial', 'audit system/init lists tool and MCP server names.'],
    'file-diffs': ['absent', 'Cowork transcripts have no file-history snapshots.'],
    cost: ['logged', 'audit result.total_cost_usd per turn.'],
    'permission-decisions': ['logged', 'audit permission_request and permission_response records.'],
  },
  codex: {
    timestamps: ['logged', 'Every rollout envelope carries a timestamp.'],
    'llm-latency': ['derived', 'Derived from rollout timestamps; per-request timing exists only in logs_2.sqlite (rolling window) and Codex OpenTelemetry.'],
    ttft: ['absent', 'Not in rollouts; Codex OpenTelemetry codex.sse_event records stream timing.'],
    'tool-durations': ['derived', 'Call to output timestamp gap; logged item durations under 1 ms are placeholders.'],
    'exit-codes': ['logged', 'Item exit codes and "Process exited with code N" in outputs.'],
    'token-usage': ['logged', 'token_count and token_usage_record events.'],
    'cache-tokens': ['logged', 'cached_input_tokens in token usage.'],
    'reasoning-text': ['partial', 'Reasoning items are mostly encrypted; summaries are sometimes readable.'],
    'system-prompt': ['logged', 'session_meta.base_instructions.'],
    'tool-definitions': ['partial', 'dynamic_tools in session_meta; built-in tool schemas are not logged.'],
    'subagent-tree': ['partial', 'Spawned threads link to their parent; review subagents have no parent link.'],
    'file-diffs': ['logged', 'apply_patch inputs and file-change items carry diffs.'],
    cost: ['absent', 'Codex logs tokens but no cost.'],
    'raw-http': ['absent', 'logs_2.sqlite keeps response headers for a few days; bodies are not logged.'],
    'permission-decisions': ['partial', 'Approval policy per turn and guardian reviews; codex.tool_decision only through OpenTelemetry.'],
  },
  copilot: {
    timestamps: ['partial', 'Chat-session documents: one timestamp per request; CLI and newer VS Code agent logs: every event.'],
    'llm-latency': ['logged', 'Chat-session result.timings.totalElapsed (elapsedMs); agent session.usage_record.usage.duration or retained assistant.usage.duration.'],
    ttft: ['logged', 'Chat-session result.timings.firstProgress; agent usage.timeToFirstTokenMs when recorded.'],
    'tool-durations': ['partial', 'Agent-mode tool parts log start and end; agent event logs pair tool starts and completions. Elapsed time can include approval waits.'],
    'exit-codes': ['partial', 'Terminal tool parts and agent shellExecution.exitCode; other tool results carry none.'],
    'token-usage': ['partial', 'Chat-session promptTokens and completionTokens; agent session.usage_record.usage or retained assistant.usage. Older logs may lack usage.'],
    'cache-tokens': ['partial', 'Agent usage records report cache reads and writes when recorded.'],
    'reasoning-text': ['partial', 'Agent assistant.reasoning events; chat-session documents store none.'],
    'system-prompt': ['partial', 'Newer agent logs include system.message and skill context; chat-session documents omit the system prompt.'],
    'tool-definitions': ['absent', 'Tool definitions are not stored.'],
    'subagent-tree': ['partial', 'Agent subagent events stay in the parent session, nested under the task call; chat-session documents have none.'],
    'file-diffs': ['partial', 'textEditGroup responses, chatEditingSessions snapshots and CLI fileEdits (not parsed).'],
    cost: ['absent', 'No cost is stored; the CLI counts premium requests at shutdown.'],
    'raw-http': ['absent', 'Requests and responses are not stored.'],
    'permission-decisions': ['partial', 'Agent permission.requested and permission.completed events; chat-session documents store none.'],
  },

};

interface AgentDef {
  agent: AgentKind;
  label: string;
  roots: (env: DiscoverEnv) => string[];
  /** Paths whose presence shows the agent is installed even when nothing was indexed. */
  detect: (env: DiscoverEnv) => string[];
}

const AGENTS: AgentDef[] = [
  {
    agent: 'claude-code',
    label: 'Claude Code',
    roots: (e) => [...agentRoots(e, 'claude').map((root) => join(root, 'projects')), ...(e.autoDiscover === false ? [] : [join(e.appSupport, 'Claude', 'claude-code-sessions')])],
    detect: (e) => agentRoots(e, 'claude'),
  },
  {
    agent: 'claude-cowork',
    label: 'Claude Cowork',
    roots: (e) => e.autoDiscover === false ? [] : [join(e.appSupport, 'Claude', 'local-agent-mode-sessions')],
    detect: (e) => e.autoDiscover === false ? [] : [join(e.appSupport, 'Claude', 'local-agent-mode-sessions')],
  },
  {
    agent: 'codex',
    label: 'Codex',
    roots: (e) => agentRoots(e, 'codex').flatMap((root) => [join(root, 'sessions'), join(root, 'archived_sessions'), join(root, 'state_5.sqlite')]),
    detect: (e) => agentRoots(e, 'codex'),
  },
  {
    agent: 'copilot',
    label: 'GitHub Copilot (VS Code Chat, CLI)',
    roots: (e) => e.autoDiscover === false ? [] : [join(e.appSupport, 'Code', 'User', 'workspaceStorage'), join(e.appSupport, 'Code', 'User', 'globalStorage', 'emptyWindowChatSessions'), join(e.home, '.copilot', 'session-state')],
    detect: (e) => e.autoDiscover === false ? [] : [join(e.appSupport, 'Code', 'User', 'globalStorage', 'github.copilot-chat'), join(e.home, '.copilot')],
  },
];

// Agents AgentShark cannot parse; detected by existence only (SPEC §8 findings).
const OTHER_AGENTS: { agent: string; label: string; paths: (e: DiscoverEnv) => string[]; detail: string }[] = [
  {
    agent: 'antigravity',
    label: 'Google Antigravity',
    paths: (e) => [join(e.home, '.gemini', 'antigravity')],
    detail: 'Conversation trajectories (conversations/*.pb) are encrypted; only titles, step counts, artifacts and screenshots are readable.',
  },
  {
    agent: 'chatgpt-desktop',
    label: 'ChatGPT desktop',
    paths: (e) => [join(e.appSupport, 'com.openai.chat')],
    detail: 'The conversation cache (conversations-v3-*/*.data) is encrypted with a key held in the Keychain.',
  },
  { agent: 'gemini-cli', label: 'Gemini CLI', paths: (e) => [join(e.home, '.gemini', 'tmp')], detail: 'AgentShark v1 has no Gemini CLI adapter.' },
  { agent: 'cursor', label: 'Cursor', paths: (e) => [join(e.home, '.cursor'), join(e.appSupport, 'Cursor')], detail: 'AgentShark v1 has no Cursor adapter.' },
  { agent: 'windsurf', label: 'Windsurf', paths: (e) => [join(e.appSupport, 'Windsurf'), join(e.home, '.codeium', 'windsurf')], detail: 'AgentShark v1 has no Windsurf adapter.' },
  {
    agent: 'ollama',
    label: 'Ollama app',
    paths: (e) => [join(e.appSupport, 'Ollama', 'db.sqlite')],
    detail: 'Chats and tool calls live in a SQLite database that AgentShark v1 does not parse.',
  },
  { agent: 'opencode', label: 'opencode', paths: (e) => [join(e.home, '.local', 'share', 'opencode')], detail: 'AgentShark v1 has no opencode adapter.' },
];

const CLAUDE_OTEL: HealthRecommendation = {
  text:
    'Export these variables in the shell that starts Claude Code, and run an OTLP collector at 127.0.0.1:4318. For spans (beta) also set ' +
    'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 and OTEL_TRACES_EXPORTER=otlp. Prompts, tool details and response bodies stay redacted unless ' +
    'OTEL_LOG_USER_PROMPTS, OTEL_LOG_TOOL_DETAILS, OTEL_LOG_TOOL_CONTENT, OTEL_LOG_ASSISTANT_RESPONSES or OTEL_LOG_RAW_API_BODIES is set.',
  code: {
    lang: 'sh',
    snippet: 'export CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318',
  },
  effect: 'Configures an external OTLP collector; AgentShark does not ingest this data',
};

const CODEX_OTEL: HealthRecommendation = {
  text: 'Add this table to ~/.codex/config.toml and run an OTLP collector at 127.0.0.1:4318. Keep log_user_prompt = false unless prompts should be exported.',
  code: {
    lang: 'toml',
    snippet: '[otel]\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }\nlog_user_prompt = false',
  },
  effect: 'Configures an external OTLP collector; AgentShark does not ingest this data',
};

const DURABLE_CAPTURE: HealthRecommendation = {
  text: 'Write a capture of the last 30 days now and then, for example from a daily cron job. The command assumes agentshark is on your PATH (npm link in the AgentShark checkout); otherwise run node bin/agentshark.ts from the checkout.',
  code: { lang: 'sh', snippet: 'mkdir -p ~/agentshark && agentshark capture -o ~/agentshark/agentshark-$(date +%F).agentcap.zst --since 30d' },
  effect: 'Keeps a self-contained copy that AgentShark can open after the agent deletes or rewrites its logs',
};

const RETENTION: HealthRecommendation = {
  text: 'Set cleanupPeriodDays in ~/.claude/settings.json to a large value, keeping the other keys of that file. Raising it does not restore files that were already deleted.',
  code: { lang: 'json', snippet: '{ "cleanupPeriodDays": 3650 }' },
  effect: 'Claude Code keeps transcripts longer, so AgentShark can index more history',
};

/** SPEC §12.6: the lines that register `agentshark mcp`; the user runs them, AgentShark writes no agent configuration. */
const MCP_DETAIL =
  'agentshark mcp lets an agent ask this index about its own runs (find_runs, run_report, list_failures, get_episode, lookup_error, watch): ' +
  'read-only, limited to the git root the agent works in, with home paths, the user name and secrets redacted.';

const MCP_CLAUDE: HealthRecommendation = {
  text: 'Run this once. Add --scope user after "mcp add" to register it for every project. The command assumes agentshark is on your PATH (npm link in the AgentShark checkout).',
  code: { lang: 'sh', snippet: 'claude mcp add agentshark -- agentshark mcp' },
  effect: "Claude Code starts a read-only AgentShark server; the command writes Claude Code's own MCP settings, AgentShark writes none",
};

const MCP_CODEX: HealthRecommendation = {
  text: 'Add this table to ~/.codex/config.toml. It assumes agentshark is on your PATH (npm link in the AgentShark checkout).',
  code: { lang: 'toml', snippet: '[mcp_servers.agentshark]\ncommand = "agentshark"\nargs = ["mcp"]' },
  effect: 'Codex starts a read-only AgentShark server; AgentShark writes no agent configuration',
};

export interface HealthOptions {
  /**
   * 'local' (default): this machine's agents, settings and logs plus the index. 'captured': only what the index holds
   * (an opened capture); nothing about the reader's machine is read, so the report is the same on every machine.
   */
  scope?: 'local' | 'captured';
}

export async function healthReport(db: DatabaseSync, env: DiscoverEnv = defaultEnv(), opts: HealthOptions = {}): Promise<HealthReport[]> {
  const captured = opts.scope === 'captured';
  const measures = measureIndex(db);
  const reports: HealthReport[] = [];
  for (const def of AGENTS) {
    if (env.agents && !env.agents.includes(def.agent)) continue;
    const m = measures.get(def.agent) ?? emptyMeasures();
    if (captured && m.files === 0) continue;
    const roots = captured ? capturedRoots(db, def.agent) : await existing(def.roots(env));
    const detected = m.files > 0 || roots.length > 0 || (!captured && (await existing(def.detect(env))).length > 0);
    const measured = measuredCapabilities(m, def.agent);
    reports.push({
      agent: def.agent,
      label: def.label,
      detected,
      parsed: m.files > 0,
      roots,
      ...(captured ? {} : { searched: def.roots(env) }),
      files: m.files,
      bytes: m.bytes,
      firstTs: m.first,
      lastTs: m.last,
      versions: [...m.versions].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      parse: { lines: m.lines, malformed: m.malformed, unknown: m.unknown, skipped: m.skipped, inherited: m.inherited },
      capabilities: CAPABILITIES.map((capability) => {
        const [level, note] = measured[capability] ?? KNOWN[def.agent][capability];
        return { capability, level, note };
      }),
      findings: detected ? await findings(def, m, env, captured) : [],
    });
  }
  if (!env.agents && !captured && env.autoDiscover !== false) {
    for (const other of OTHER_AGENTS) {
      const roots = await existing(other.paths(env), true);
      if (!roots.length) continue;
      reports.push({
        agent: other.agent,
        label: other.label,
        detected: true,
        parsed: false,
        roots,
        files: 0,
        bytes: 0,
        firstTs: null,
        lastTs: null,
        versions: [],
        parse: { lines: 0, malformed: 0, unknown: 0, skipped: 0, inherited: 0 },
        capabilities: [],
        findings: [{ severity: 'note', title: `${other.label} detected but not parsed`, detail: other.detail }],
      });
    }
  }
  return reports;
}

/** Folders of the captured source files: where the capture's machine kept them, not where the reader keeps anything. */
function capturedRoots(db: DatabaseSync, agent: string): string[] {
  const dirs = new Set((db.prepare('SELECT path FROM sources WHERE agent = ?').all(agent) as { path: string }[]).map((r) => dirname(r.path)));
  // Collapse to the shortest prefixes so a capture of many days of rollouts shows its sessions folder once.
  const sorted = [...dirs].sort();
  return sorted.filter((d, i) => !sorted.slice(0, i).some((p) => d.startsWith(p + '/'))).slice(0, 20);
}

// ---------------------------------------------------------------------------
// Index measurements

interface Measures {
  files: number;
  bytes: number;
  lines: number;
  malformed: number;
  unknown: number;
  skipped: number;
  inherited: number;
  sourceKinds: Counts;
  first: number | null;
  last: number | null;
  missing: number;
  missingFirst: number | null;
  missingLast: number | null;
  deleted: number;
  children: number;
  /** Sessions that should have a parent but have none, by role. */
  orphans: Counts;
  versions: Set<string>;
  /** Sums of the linker's per-session counters (sessions.measures). */
  m: SessionMeasures;
  /** Claude tool results in subagent and workflow transcripts, and those that carry toolUseResult. */
  subResults: number;
  subWithResult: number;
  /** Turn aborts in child sessions: a human interrupt or a parent stop (SPEC §12.9 limit 3). */
  childAborts: number;
}

function emptyMeasures(): Measures {
  return {
    files: 0, bytes: 0, lines: 0, malformed: 0, unknown: 0, skipped: 0, inherited: 0, sourceKinds: {},
    first: null, last: null, missing: 0, missingFirst: null, missingLast: null, deleted: 0, children: 0,
    orphans: {}, versions: new Set(), m: emptySessionMeasures(), subResults: 0, subWithResult: 0, childAborts: 0,
  };
}

const MEASURE_KEYS: (keyof SessionMeasures)[] = [
  'ts_n', 'ts_logged', 'llm_n', 'llm_logged', 'llm_derived', 'llm_parsed', 'llm_tokens', 'llm_cache', 'llm_ttft', 'tool_n',
  'tool_logged', 'tool_derived', 'tool_parsed', 'thinking_n', 'thinking_text', 'shell_n', 'shell_exit', 'turnend_n',
  'turnend_ttft', 'turnend_cost', 'state_cost', 'claude_results', 'claude_tur', 'perm_req', 'perm_dec', 'file_n',
];

/**
 * Inventory from the sources and sessions tables, capability counters from the linker's per-session measures
 * (exact counts that the linker keeps current as sessions change). An index without measures (written by hand
 * in tests) is measured on the spot.
 */
function measureIndex(db: DatabaseSync): Map<string, Measures> {
  const by = new Map<string, Measures>();
  const get = (agent: string) => {
    let m = by.get(agent);
    if (!m) by.set(agent, (m = emptyMeasures()));
    return m;
  };
  const rows = (sql: string) => db.prepare(sql).all() as any[];

  for (const r of rows(`SELECT agent, kind, count(*) AS files, sum(size) AS bytes, sum(lines) AS lines, sum(malformed) AS malformed,
      sum(unknown) AS unknown, sum(skipped) AS skipped, sum(inherited) AS inherited
      FROM sources WHERE exists_now = 1 GROUP BY agent, kind`)) {
    const m = get(r.agent);
    m.sourceKinds[r.kind] = r.files;
    m.files += r.files;
    for (const k of ['bytes', 'lines', 'malformed', 'unknown', 'skipped', 'inherited'] as const) m[k] += r[k] ?? 0;
  }

  for (const r of rows(`SELECT agent,
      min(coalesce(start_ts, created_ts)) AS first, max(coalesce(end_ts, start_ts, created_ts)) AS last,
      sum(state = 'missing-transcript') AS missing,
      min(CASE WHEN state = 'missing-transcript' THEN created_ts END) AS missingFirst,
      max(CASE WHEN state = 'missing-transcript' THEN created_ts END) AS missingLast,
      sum(state = 'source-deleted') AS deleted, sum(parent_id IS NOT NULL) AS children
      FROM sessions GROUP BY agent`)) {
    Object.assign(get(r.agent), {
      first: r.first, last: r.last, missing: r.missing, missingFirst: r.missingFirst, missingLast: r.missingLast,
      deleted: r.deleted, children: r.children,
    });
  }

  // Main and automation sessions are top-level by nature; the other roles should link to a parent.
  for (const r of rows(`SELECT agent, role, count(*) AS n FROM sessions
      WHERE role IN ('subagent', 'workflow-agent', 'guardian', 'review') AND parent_id IS NULL GROUP BY agent, role`)) {
    get(r.agent).orphans[r.role] = r.n;
  }
  for (const r of rows(`SELECT s.agent, count(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE e.kind = 'turn.abort' AND s.role <> 'main' AND (e.flag_bits & ${FLAG_BITS.inherited | FLAG_BITS.dup}) = 0 GROUP BY s.agent`)) {
    get(r.agent).childAborts = r.n;
  }
  for (const r of rows(`SELECT DISTINCT agent, version FROM sessions WHERE version IS NOT NULL AND version <> ''`)) {
    get(r.agent).versions.add(r.version);
  }

  const sessions = rows('SELECT id, agent, role, measures FROM sessions');
  const stored = sessions.some((s) => s.measures != null);
  const computed = stored ? null : measureSessions(db, '1', false);
  for (const s of sessions) {
    const sm: SessionMeasures | undefined = stored ? (s.measures ? JSON.parse(s.measures) : undefined) : computed!.get(s.id);
    if (!sm) continue;
    const m = get(s.agent);
    for (const k of MEASURE_KEYS) m.m[k] += sm[k] ?? 0;
    if (s.role !== 'main') {
      m.subResults += sm.claude_results ?? 0;
      m.subWithResult += sm.claude_tur ?? 0;
    }
  }
  return by;
}

// ---------------------------------------------------------------------------
// Capability levels measured from the index

function measuredCapabilities(x: Measures, agent: AgentKind): Partial<Known> {
  const out: Partial<Known> = {};
  const m = x.m;
  if (m.ts_n >= 30) out.timestamps = shareLevel(m.ts_logged, m.ts_n, 'events carry a logged timestamp', 0.95);
  if (m.llm_n) {
    out['llm-latency'] = durationLevel(m.llm_n, m.llm_logged, m.llm_derived, m.llm_parsed, 'model calls');
    out['token-usage'] = shareLevel(m.llm_tokens, m.llm_n, 'model calls report token usage');
    out['cache-tokens'] = shareLevel(m.llm_cache, m.llm_n, 'model calls report cache tokens');
  }
  if (m.llm_ttft) out.ttft = shareLevel(m.llm_ttft, m.llm_n, 'model calls carry a TTFT');
  else if (m.turnend_ttft) out.ttft = shareLevel(m.turnend_ttft, m.turnend_n, 'turn results carry a TTFT');
  if (m.tool_n) out['tool-durations'] = durationLevel(m.tool_n, m.tool_logged, m.tool_derived, m.tool_parsed, 'tool calls');
  if (m.shell_n) {
    // Claude Bash results name an exit code only in "Exit code N" output; success is a status, not a logged code.
    const [level, note] = shareLevel(m.shell_exit, m.shell_n, 'shell results carry a logged exit code');
    const claude = agent === 'claude-code' || agent === 'claude-cowork';
    out['exit-codes'] = claude && level !== 'logged'
      ? ['partial', `${note.slice(0, -1)}; the others report success or failure only (is_error, interrupted).`]
      : [level, note];
  }
  if (m.thinking_n) out['reasoning-text'] = shareLevel(m.thinking_text, m.thinking_n, 'reasoning blocks have readable text');
  const orphans = Object.values(x.orphans).reduce((a, b) => a + b, 0);
  if (x.children + orphans > 0) {
    const roles = Object.entries(x.orphans).map(([role, n]) => `${fmt(n)} ${role}`).join(', ');
    out['subagent-tree'] = [
      orphans === 0 ? 'logged' : x.children > 0 ? 'partial' : 'absent',
      `${fmt(x.children)} child sessions link to a parent${orphans ? `; ${roles} sessions have none` : ''}.`,
    ];
  }
  if (m.file_n) out['file-diffs'] = ['logged', `${fmt(m.file_n)} file-history events.`];
  const costs = m.turnend_cost + m.state_cost;
  if (costs > 0) out.cost = [m.turnend_n && m.turnend_cost / m.turnend_n >= 0.9 ? 'logged' : 'partial', `${fmt(costs)} events carry a logged cost.`];
  if (m.perm_req + m.perm_dec > 0) out['permission-decisions'] = ['logged', `${fmt(m.perm_req)} permission requests, ${fmt(m.perm_dec)} decisions.`];
  return out;
}

function shareLevel(part: number, total: number, what: string, full = 0.9): [CapabilityLevel, string] {
  const level: CapabilityLevel = part / total >= full ? 'logged' : part > 0 ? 'partial' : 'absent';
  return [level, `${pct(part, total)} of ${fmt(total)} ${what}.`];
}

function durationLevel(n: number, logged: number, derived: number, parsed: number, what: string): [CapabilityLevel, string] {
  const known = logged + derived + parsed;
  const level: CapabilityLevel = logged / n >= 0.5 ? 'logged' : known / n >= 0.5 ? 'derived' : known > 0 ? 'partial' : 'absent';
  const parts = [`${pct(logged, n)} logged`, `${pct(derived, n)} derived from timestamps`];
  if (parsed) parts.push(`${pct(parsed, n)} parsed from output`);
  parts.push(`${pct(n - known, n)} unknown`);
  return [level, `${fmt(n)} ${what}: ${parts.join(', ')}.`];
}

// ---------------------------------------------------------------------------
// Findings and recommendations

async function findings(def: AgentDef, m: Measures, env: DiscoverEnv, captured: boolean): Promise<HealthFinding[]> {
  const out: HealthFinding[] = [];
  const claude = def.agent === 'claude-code' || def.agent === 'claude-cowork';
  if (def.agent === 'copilot') out.push({
    severity: 'note', title: 'Copilot support is partial',
    detail: 'Reads VS Code JSON and JSONL chat sessions and shared CLI/newer VS Code agent session-state logs. Newer agent logs persist per-call usage; older logs can lack tokens and model latency. Tool output can also be omitted. File edit snapshots are not decoded; cloud coding-agent sessions are not downloaded.',
    recommendation: captured ? undefined : DURABLE_CAPTURE,
  });
  if (m.missing > 0) {
    out.push({
      severity: 'warn',
      title: `${plural(m.missing, 'session')} ${m.missing === 1 ? 'has' : 'have'} no transcript`,
      detail:
        `The desktop registry lists ${plural(m.missing, 'session')}${dateRange(m.missingFirst, m.missingLast)} whose transcripts no longer exist. ` +
        'Only their registry metadata (title, model, turn count, pull requests) survives.',
      recommendation: captured ? undefined : {
        text: def.agent === 'claude-code'
          ? 'Claude Code deletes transcripts older than cleanupPeriodDays (desktop transcripts too, before version 2.1.248). Raise it and write captures regularly so the remaining history survives.'
          : 'Write captures regularly so the remaining history survives.',
        effect: 'Keeps history that the agent would delete',
      },
    });
  }
  if (m.deleted > 0) {
    out.push({
      severity: 'warn',
      title: `${plural(m.deleted, 'session')} lost ${m.deleted === 1 ? 'its source file' : 'their source files'}`,
      detail: 'These sessions were indexed before their files disappeared from disk. The index keeps what it parsed, but raw bytes are no longer available.',
      recommendation: captured ? undefined : DURABLE_CAPTURE,
    });
  }
  if (m.malformed > 0 || m.unknown > 0) {
    out.push({
      severity: m.malformed > 0 ? 'warn' : 'note',
      title: 'Parse problems',
      detail: `${fmt(m.lines)} lines parsed: ${fmt(m.malformed)} malformed, ${fmt(m.unknown)} of an unknown record type (kept as raw.unknown).`,
    });
  }
  for (const [role, n] of Object.entries(m.orphans)) {
    out.push({
      severity: 'note',
      title: `${plural(n, `${role} session`)} ${n === 1 ? 'has' : 'have'} no parent link`,
      detail:
        def.agent === 'codex' && role === 'review'
          ? 'Codex records no parent for review threads (source subagent = review), so they appear as top-level sessions.'
          : `The logs do not link these ${role} sessions to the session that started them.`,
    });
  }
  if (m.childAborts > 0) {
    out.push({
      severity: 'note',
      title: `${plural(m.childAborts, 'interrupt')} in child sessions name${m.childAborts === 1 ? 's' : ''} no actor`,
      detail:
        'In a subagent or other child session, pressing Esc looks the same as the parent stopping the child. ' +
        'Diagnostics lists these as "turn interrupted (user or parent stop)" and the Failure Lens gives the actor as parent-or-human; ' +
        'only a main-session interrupt puts its episode under Unrecovered.',
    });
  }
  // toolUseResult is a Claude transcript field; Codex results carry their exit codes in items and output text.
  if (claude && m.subResults && m.subWithResult / m.subResults < 0.5) {
    out.push({
      severity: 'note',
      title: 'Subagent tool results lack toolUseResult',
      detail:
        `Only ${pct(m.subWithResult, m.subResults)} of ${fmt(m.subResults)} tool results in subagent transcripts carry toolUseResult, ` +
        'so their exit codes, patches and logged durations are missing. Their tool durations fall back to timestamp gaps.',
    });
  }

  if ((def.agent === 'claude-code' || def.agent === 'codex') && m.files > 0 && !captured) {
    out.push({
      severity: 'chat',
      title: `Let ${def.label} read its own failures through MCP`,
      detail: MCP_DETAIL,
      recommendation: def.agent === 'codex' ? MCP_CODEX : MCP_CLAUDE,
    });
  }
  if (def.agent === 'claude-code') {
    if (!captured) out.push(...(await claudeRetention(env)));
    out.push({
      severity: 'chat',
      title: 'Claude Code OpenTelemetry gives measured latencies (external collector; not shown in AgentShark)',
      detail:
        'Transcripts carry no API latency, TTFT or tool execution time, so AgentShark derives them from timestamp gaps. ' +
        'Claude Code OpenTelemetry events (claude_code.api_request, claude_code.tool_result) carry measured duration_ms and cost_usd.',
      recommendation: CLAUDE_OTEL,
    });
  }
  if (def.agent === 'claude-cowork' && m.sourceKinds.audit) {
    out.push({
      severity: 'note',
      title: `Cowork audit logs available for ${plural(m.sourceKinds.audit, 'session')}`,
      detail:
        'audit.jsonl adds per-turn duration, API time, TTFT (CLI 2.1.142 and later), cost, rate limits, retries and permission waits. ' +
        'Its user and assistant records repeat the transcript, so AgentShark skips them.',
    });
  }
  if (def.agent === 'codex') {
    if (!captured) out.push(...codexDatabases(env));
    out.push({
      severity: 'chat',
      title: 'Codex OpenTelemetry gives measured latencies (external collector; not shown in AgentShark)',
      detail:
        'Rollouts carry no per-request latency or TTFT. Codex OpenTelemetry events (codex.api_request, codex.sse_event, codex.tool_result) carry measured durations.',
      recommendation: CODEX_OTEL,
    });
  }
  if (m.files > 0 && !captured) {
    out.push({
      severity: 'chat',
      title: 'Keep durable captures',
      detail: `${def.label} can delete or rewrite its own logs. A .agentcap capture is self-contained and outlives the source files.`,
      recommendation: DURABLE_CAPTURE,
    });
  }
  return out;
}

/** cleanupPeriodDays and the last cleanup sweep. Only these keys are read from settings.json. */
async function claudeRetention(env: DiscoverEnv): Promise<HealthFinding[]> {
  if (env.autoDiscover === false) return [];
  const out: HealthFinding[] = [];
  const settingsPath = join(env.home, '.claude', 'settings.json');
  let settings: Record<string, unknown> | undefined;
  let unreadable = false;
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    settings = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    unreadable = (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const days = settings?.cleanupPeriodDays;
  const desktopDays = settings?.desktopSessionCleanupPeriodDays;
  const desktopNote =
    typeof desktopDays === 'number'
      ? ` desktopSessionCleanupPeriodDays = ${desktopDays} also limits desktop and Cowork transcripts.`
      : ' Claude Code 2.1.248 and later keeps desktop and Cowork transcripts at any age unless desktopSessionCleanupPeriodDays is set; earlier versions deleted them after cleanupPeriodDays.';
  if (unreadable) {
    out.push({ severity: 'note', title: 'Could not read ~/.claude/settings.json', detail: 'The transcript retention setting could not be checked.' });
  } else if (typeof days !== 'number') {
    out.push({
      severity: 'warn',
      title: 'cleanupPeriodDays is not set',
      detail:
        `${settings ? '~/.claude/settings.json does not set cleanupPeriodDays' : 'There is no ~/.claude/settings.json'}, so Claude Code deletes transcripts, ` +
        'subagent transcripts and file-history snapshots older than the default retention period (30 days per the Claude Code documentation) when it starts.' +
        desktopNote,
      recommendation: RETENTION,
    });
  } else {
    out.push({
      severity: 'note',
      title: `cleanupPeriodDays = ${days}`,
      detail: `Claude Code deletes transcripts older than ${days} days when it starts.${desktopNote}`,
      recommendation: days < 365 ? RETENTION : undefined,
    });
  }

  const marker = join(env.home, '.claude', '.last-cleanup');
  try {
    const text = (await readFile(marker, 'utf8')).trim();
    const ms = Date.parse(text);
    const when = Number.isNaN(ms) ? (await stat(marker)).mtime : new Date(ms);
    out.push({
      severity: 'note',
      title: `Last Claude Code cleanup sweep: ${when.toISOString()}`,
      detail: 'Claude Code records the time of its last retention sweep in ~/.claude/.last-cleanup.',
    });
  } catch {
    // No marker: no sweep recorded.
  }
  return out;
}

/** Findings from Codex's own SQLite stores, opened read-only and immutable. */
function codexDatabases(env: DiscoverEnv): HealthFinding[] {
  if (env.autoDiscover === false) return [];
  const out: HealthFinding[] = [];
  const query = (file: string, fn: (db: DatabaseSync, tables: Set<string>) => void) => {
    let db: DatabaseSync | undefined;
    try {
      db = openReadOnly(join(env.home, '.codex', file));
      const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]).map((r) => r.name as string));
      fn(db, tables);
    } catch {
      // Missing or unreadable database: nothing to report.
    } finally {
      db?.close();
    }
  };

  query('state_5.sqlite', (db, tables) => {
    if (!tables.has('rollout_migration_state')) return;
    for (const r of db.prepare('SELECT * FROM rollout_migration_state').all() as any[]) {
      const updated = typeof r.updated_at === 'number' ? ` (last updated ${new Date(r.updated_at * 1000).toISOString().slice(0, 10)})` : '';
      out.push({
        severity: 'note',
        title: `Codex rewrote its rollouts (${r.migration_id})`,
        detail:
          `state_5.sqlite records the ${r.migration_id} rollout migration${updated}. Rewritten rollouts carry synthetic item ids (item-N) ` +
          'and may differ from the bytes Codex originally wrote.',
        recommendation: { text: 'Keep captures of the current files; earlier bytes cannot be recovered.', code: DURABLE_CAPTURE.code, effect: DURABLE_CAPTURE.effect },
      });
    }
  });

  query('logs_2.sqlite', (db, tables) => {
    if (!tables.has('logs')) return;
    const r = db.prepare('SELECT min(ts) AS first, max(ts) AS last, count(*) AS n FROM logs').get() as any;
    if (!r?.n) return;
    const written = tables.has('sqlite_sequence')
      ? ((db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'logs'`).get() as any)?.seq ?? 0)
      : 0;
    const days = (r.last - r.first) / 86400;
    out.push({
      severity: 'note',
      title: `Codex logs_2.sqlite keeps only ${days < 1 ? `${Math.max(1, Math.round(days * 24))} hours` : `${days.toFixed(1)} days`} of logs`,
      detail:
        `The log table covers ${new Date(r.first * 1000).toISOString()} to ${new Date(r.last * 1000).toISOString()} (${fmt(r.n)} rows` +
        `${written > r.n ? `; about ${fmt(written)} rows were written and pruned` : ''}). ` +
        'Per-request HTTP timing and tool-call timing from these logs exist only for this window. Rows still in the write-ahead log are not counted.',
      recommendation: { text: 'Enable Codex OpenTelemetry (see the OpenTelemetry finding) to keep per-request latency beyond the rolling window.', effect: CODEX_OTEL.effect },
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers

/** Paths that exist. With `nonEmpty`, a directory counts only when it has entries. */
async function existing(paths: string[], nonEmpty = false): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    try {
      const st = await stat(p);
      if (nonEmpty && st.isDirectory() && (await readdir(p)).length === 0) continue;
      out.push(p);
    } catch {
      // Absent.
    }
  }
  return out;
}

function dateRange(fromUs: number | null, toUs: number | null): string {
  if (fromUs == null || toUs == null) return '';
  const d = (us: number) => new Date(us / 1000).toISOString().slice(0, 10);
  return ` (created ${d(fromUs)} to ${d(toUs)})`;
}

function pct(part: number, total: number): string {
  if (!total) return '0%';
  const p = (part / total) * 100;
  if (part > 0 && p < 1) return '<1%';
  if (part < total && p > 99) return '>99%';
  return `${Math.round(p)}%`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number, noun: string): string {
  return `${fmt(n)} ${noun}${n === 1 ? '' : 's'}`;
}
