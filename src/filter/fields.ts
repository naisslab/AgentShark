// Display filter field registry (SPEC §5.3 field table and the §3.7 attribute paths).
// Units: duration fields take us, ms, s, m, min, h, d, and a bare number means milliseconds.
// Number fields take k, K (thousand), M (million), KB, MB, GB.

import type { FieldInfo } from '../index/api.ts';
import { EVENT_KINDS, LAYERS, SPAN_KINDS } from '../model/kinds.ts';
import {
  AGENT_PREFIX, ALARM_KINDS, CLAIM_EVIDENCE, EPISODE_OUTCOMES, FAILURE_FAMILIES, FAILURE_SOURCES, FAILURE_TIERS, FLAG_BITS,
  INTERVENTION_KINDS,
  type Actor, type EventFlag, type SessionRole, type SessionState, type SpanStatus, type ToolKindTag, type TsSrc,
} from '../model/types.ts';

export interface FieldDef extends FieldInfo {
  /**
   * SQL expression over the aliases e (events), p (the event's payload: attrs, native), s (its session) and sp (its span).
   * For a field with `semi`, the scalar value one event shows in a custom column.
   */
  sql: string;
  /**
   * Derived fields (SPEC §12.3.1): a semi-join template that filters use instead of `sql`. Each `?` is a slot that the
   * compiler fills with the operator and the value over the derived column (`= ?`, `IN (?, ?)`, `LIKE ? ESCAPE '\'`,
   * `REGEXP ?`, or `NOT IN (0, '')` for a bare field), so no derived field joins event_payload.
   */
  semi?: string;
  join?: 'session' | 'span';
  /** The expression (for a `semi` field: the semi-join) is never NULL, so comparisons on it never yield NULL. */
  notNull?: boolean;
  /** Duration fields: microseconds per stored unit (1 for µs columns, 1000 for the *_ms attributes). */
  scale?: number;
  /** Keywords (layers, flags, event kinds): `sql` is already a parenthesized boolean predicate. */
  predicate?: boolean;
  /** JSON fields whose sub-paths can be filtered, e.g. tool.input.command or native.payload.type. */
  json?: { col: string; path: string };
  /** Other accepted spellings of enum values. */
  aliases?: Record<string, string>;
}

const BARE_MS = 'bare numbers are ms';

function keysOf<T extends string>(r: Record<T, unknown>): T[] {
  return Object.keys(r) as T[];
}

const ACTORS = keysOf<Actor>({ user: 1, assistant: 1, tool: 1, system: 1, harness: 1, agent: 1 });
const ROLES = keysOf<SessionRole>({ main: 1, subagent: 1, 'workflow-agent': 1, guardian: 1, review: 1, fork: 1, automation: 1 });
const STATES = keysOf<SessionState>({ ok: 1, 'missing-transcript': 1, 'source-deleted': 1 });
const SPAN_STATUSES = keysOf<SpanStatus>({ ok: 1, error: 1, cancelled: 1, interrupted: 1, open: 1, unknown: 1 });
const TOOL_KINDS = keysOf<ToolKindTag>({ builtin: 1, mcp: 1, shell: 1, file: 1, web: 1, agent: 1, custom: 1, plan: 1, other: 1 });
const TS_SRCS = keysOf<TsSrc>({ logged: 1, inherited: 1, none: 1 });
const AGENTS = Object.keys(AGENT_PREFIX);
const AGENT_ALIASES = Object.fromEntries(Object.entries(AGENT_PREFIX).map(([agent, prefix]) => [prefix, agent]));

const FLAG_DESCRIPTIONS: Record<EventFlag, string> = {
  error: 'the event is a failure',
  inherited: 'context copied from another session (resumed prefix, subagent history)',
  dup: 'the same information appears in another event',
  orphan: 'a result whose call was never found',
  inferred: 'a link or value that was guessed',
  truncated: 'text was cut in the index',
  abandoned: 'a branch that a later rewind or continuation replaced',
  meta: 'a harness-injected prompt',
  sidechain: 'a Claude sidechain record',
};

/** `tool.input.command` → `$.tool.input.command`; keys outside [A-Za-z_]\w* are quoted. */
function jsonPath(path: string): string {
  if (!path) return '$';
  return '$' + path.split('.').map((seg) => {
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(seg)!;
    return (/^[A-Za-z_]\w*$/.test(m[1]) ? '.' + m[1] : `."${m[1]}"`) + m[2];
  }).join('');
}

/** Field names a user may type: dotted keys with optional array indexes, e.g. native.message.content[0].type. */
const FIELD_PATH_RE = /^[A-Za-z_$][\w$-]*(?:\[\d+\])*(?:\.[\w$-]+(?:\[\d+\])*)*$/;

type FieldType = FieldInfo['type'];

function col(name: string, type: FieldType, sql: string, description: string, more: Partial<FieldDef> = {}): FieldDef {
  return { name, type, sql, description, ...more };
}

function attr(name: string, type: FieldType, description: string, more: Partial<FieldDef> = {}): FieldDef {
  return { name, type, sql: `json_extract(p.attrs, '${jsonPath(name)}')`, description, ...more };
}

/**
 * The agent of an event's session, read from the session id prefix (SPEC §3.1: cc, cw, cx, cp). The prefix is part of
 * ev_ts, so agent filters need neither a join nor a table row.
 */
export const AGENT_SQL = `CASE substr(e.session_id, 1, 3) ${Object.entries(AGENT_PREFIX).map(([agent, prefix]) => `WHEN '${prefix}:' THEN '${agent}'`).join(' ')} END`;

const NOT_NULL = { notNull: true } as const;
const SESSION = { join: 'session' } as const;
const SPAN = { join: 'span' } as const;
const STORED_MS = { scale: 1000 } as const;

const FIELD_LIST: FieldDef[] = [
  // Event columns (SPEC §5.3 table).
  col('kind', 'enum', 'e.kind', 'Event kind such as tool.call; a bare kind name is also a filter', { ...NOT_NULL, values: keysOf(EVENT_KINDS) }),
  col('proto', 'string', 'e.proto', 'Native dialect path, e.g. claude/assistant/tool_use', NOT_NULL),
  col('actor', 'enum', 'e.actor', 'Who produced the event', { ...NOT_NULL, values: ACTORS }),
  col('ts', 'time', 'e.ts', 'Event time: "2026-10-11 09:00" (local time), "2026-10-11T09:00Z" or "…+08:00" (explicit zone), relative -2h or -7d, or epoch µs', NOT_NULL),
  col('ts_src', 'enum', 'e.ts_src', 'How the timestamp was obtained', { ...NOT_NULL, values: TS_SRCS }),
  col('seq', 'int', 'e.seq', 'Position in the session source file (file order)', NOT_NULL),
  col('id', 'string', 'e.id', 'Event ID (<source>:<line>[.<block>])', NOT_NULL),
  col('dur', 'duration', 'e.dur', `Duration of the span this event opens or closes (${BARE_MS})`),
  col('tool.duration', 'duration', 'e.dur', `Tool call duration (${BARE_MS})`),
  col('span.duration', 'duration', 'e.dur', `Duration of the event's span (${BARE_MS})`),
  col('summary', 'string', 'e.summary', 'Summary column text: one human-readable line', NOT_NULL),
  col('session', 'string', 'e.session_id', 'Session ID; the bare word session matches session.* events', NOT_NULL),
  col('session.id', 'string', 'e.session_id', 'Session ID', NOT_NULL),
  col('agent', 'enum', AGENT_SQL, 'Agent that wrote the session (cc, cw, cx, cp also accepted); the bare word agent matches agent.* events', { values: AGENTS, aliases: AGENT_ALIASES }),
  col('session.agent', 'enum', AGENT_SQL, 'Agent that wrote the session', { values: AGENTS, aliases: AGENT_ALIASES }),
  col('session.role', 'enum', 's.role', 'Session role', { ...SESSION, values: ROLES }),
  col('session.state', 'enum', 's.state', 'Session state', { ...SESSION, values: STATES }),
  col('session.title', 'string', 's.title', 'Session title', SESSION),
  col('session.cwd', 'string', 's.cwd', 'Session working directory', SESSION),
  col('session.parent', 'string', 's.parent_id', 'Parent session ID (subagents, child threads)', SESSION),
  col('project', 'string', 's.project', 'Project (git root or cwd basename)', SESSION),
  col('branch', 'string', 's.git_branch', 'Git branch of the session', SESSION),
  col('tool.name', 'string', 'e.tool_name', 'Tool name, e.g. Bash or mcp__server__tool'),
  col('llm.model', 'string', 'e.model', 'Model name'),
  col('model', 'string', 'e.model', 'Model name'),
  col('tokens.input', 'int', 'e.tok_in', 'Prompt tokens including cached ones'),
  col('tokens.output', 'int', 'e.tok_out', 'Output tokens'),
  col('span', 'string', 'e.span_id', "ID of the event's innermost span"),
  col('span.id', 'string', 'e.span_id', "ID of the event's innermost span"),
  col('span.kind', 'enum', 'sp.kind', "Kind of the event's span", { ...SPAN, values: keysOf(SPAN_KINDS) }),
  col('span.status', 'enum', 'sp.status', "Status of the event's span", { ...SPAN, values: SPAN_STATUSES }),
  col('span.name', 'string', 'sp.name', "Name of the event's span (tool name, model, prompt excerpt)", SPAN),
  col('turn', 'string', 'e.turn_id', 'Turn span ID; the bare word turn matches turn.* events'),
  col('turn.id', 'string', 'e.turn_id', 'Turn span ID'),

  // Normalized attributes (SPEC §3.7).
  attr('text', 'string', 'Visible message or thinking text (index copy capped at 4 KB)'),
  attr('text_len', 'int', 'Length of the full text in characters'),
  attr('tool.call_id', 'string', 'Tool call ID that pairs a call with its result'),
  attr('tool.server', 'string', 'MCP server name'),
  col('tool.kind', 'enum', 'e.tool_kind', 'Tool category', { values: TOOL_KINDS }),
  attr('tool.input', 'json', 'Tool input object (capped); sub-paths such as tool.input.command work too', { json: { col: 'p.attrs', path: 'tool.input' } }),
  attr('tool.input_summary', 'string', 'One-line summary of the tool input'),
  attr('tool.command', 'string', 'Shell command'),
  attr('tool.path', 'string', 'File path the tool works on'),
  attr('tool.output', 'string', 'Tool output text (capped)'),
  attr('tool.output_len', 'int', 'Length of the full tool output'),
  attr('tool.is_error', 'bool', 'The tool reported an error'),
  col('tool.exit_code', 'int', 'e.exit_code', 'Process exit code, when the log names one'),
  attr('tool.status', 'string', 'Tool status as logged'),
  attr('tool.persisted_path', 'string', 'File holding the full persisted tool output'),
  attr('tool.reported_wall_ms', 'duration', `Wall time printed in the tool output (${BARE_MS})`, STORED_MS),
  attr('tool.logged_ms', 'duration', `Tool duration the agent logged, e.g. WebFetch durationMs (${BARE_MS})`, STORED_MS),
  attr('tool.item_duration_ms', 'duration', `Codex item duration of the call (${BARE_MS})`, STORED_MS),
  attr('tool.timed_out_ms', 'duration', `Timeout that ended the call (${BARE_MS})`, STORED_MS),
  attr('tool.http_status', 'int', 'HTTP status returned by a web tool'),
  attr('tool.run_id', 'string', 'Workflow run ID started by the Workflow tool'),
  attr('tool.workflow_name', 'string', 'Workflow name started by the Workflow tool'),
  attr('tool.background_task_id', 'string', 'Background task started by the call'),
  attr('tool.output_tail', 'string', 'Last 2,048 characters of an output longer than 4,096'),
  attr('tool.proc_id', 'string', 'Background process the call opens, polls, writes to or stops'),
  attr('tool.parent_call_id', 'string', 'Codex code-mode exec or wait call that ran this exec item'),
  attr('tool.inner_errors', 'int', 'Failed exec items inside a Codex code-mode script'),
  attr('tool.cwd', 'string', 'Working directory of a Codex command'),
  attr('tool.parsed_cmd', 'json', 'Codex parsed command entries [{type, cmd, name, path, query}]', { json: { col: 'p.attrs', path: 'tool.parsed_cmd' } }),
  attr('llm.message_id', 'string', 'Model message ID'),
  attr('llm.request_id', 'string', 'API request ID'),
  attr('llm.response_id', 'string', 'API response ID'),
  attr('llm.stop_reason', 'string', 'Stop reason, e.g. end_turn or tool_use'),
  attr('llm.stop_reason_src', 'enum', 'Whether the stop reason was logged or inferred', { values: ['logged', 'inferred'] }),
  attr('llm.effort', 'string', 'Reasoning effort setting'),
  attr('llm.service_tier', 'string', 'API service tier'),
  attr('llm.block_index', 'int', 'Content block index within the model response'),
  attr('llm.thinking_ms', 'duration', `Thinking time (${BARE_MS})`, STORED_MS),
  attr('llm.ttft_ms', 'duration', `Time to first token (${BARE_MS})`, STORED_MS),
  attr('llm.latency_ms', 'duration', `Model call latency (${BARE_MS})`, STORED_MS),
  attr('tokens.uncached', 'int', 'Prompt tokens not served from cache'),
  attr('tokens.cache_read', 'int', 'Prompt tokens read from cache'),
  attr('tokens.cache_write', 'int', 'Prompt tokens written to cache'),
  attr('tokens.reasoning', 'int', 'Reasoning tokens'),
  attr('tokens.total', 'int', 'Total tokens as reported'),
  attr('tokens.context_window', 'int', 'Model context window size'),
  attr('agent.id', 'string', 'Subagent ID'),
  attr('agent.type', 'string', 'Subagent type'),
  attr('agent.path', 'string', 'Subagent path'),
  attr('agent.nickname', 'string', 'Subagent nickname'),
  attr('agent.role', 'string', 'Subagent role'),
  attr('agent.description', 'string', 'Subagent task description'),
  attr('agent.link_session', 'string', 'Child session spawned by this event'),
  attr('agent.status', 'string', 'Subagent completion status'),
  attr('agent.total_tokens', 'int', 'Tokens the subagent used, as reported to the parent'),
  attr('agent.tool_uses', 'int', 'Tool calls the subagent made, as reported to the parent'),
  attr('llm.fallback_model', 'string', 'Model the request fell back to'),
  attr('llm.blocks', 'int', 'Content blocks in the model response'),
  attr('turn.index', 'int', 'Turn number within the session'),
  attr('turn.origin', 'string', 'What started the turn'),
  attr('hook.name', 'string', 'Hook name'),
  attr('hook.event', 'string', 'Hook event, e.g. PreToolUse'),
  attr('hook.exit_code', 'int', 'Hook exit code'),
  attr('hook.command', 'string', 'Hook command'),
  attr('hook.duration_ms', 'duration', `Hook run time (${BARE_MS})`, STORED_MS),
  attr('hook.count', 'int', 'Hooks run for one event'),
  attr('hook.errors', 'int', 'Hooks that failed'),
  attr('hook.prevented', 'bool', 'A hook stopped the action'),
  attr('error.type', 'string', 'Error type'),
  attr('error.status', 'int', 'HTTP status of an API error'),
  attr('error.message', 'string', 'Error message'),
  attr('error.retry_attempt', 'int', 'Retry attempt number'),
  attr('error.retry_in_ms', 'duration', `Delay before the next retry (${BARE_MS})`, STORED_MS),
  attr('permission.mode', 'string', 'Permission mode'),
  attr('permission.decision', 'string', 'Permission decision'),
  attr('permission.reason', 'string', 'Reason given for the permission decision'),
  attr('permission.tool', 'string', 'Tool the permission applies to'),
  attr('context.type', 'string', 'Type of injected context, e.g. attachment type'),
  attr('context.trigger', 'string', 'What started a compaction (manual or auto)'),
  attr('context.pre_tokens', 'int', 'Context tokens before a compaction'),
  attr('context.post_tokens', 'int', 'Context tokens after a compaction'),
  attr('context.duration_ms', 'duration', `Compaction run time (${BARE_MS})`, STORED_MS),
  attr('file.path', 'string', 'File path of a file-history record'),
  attr('file.version', 'int', 'File-history version'),
  attr('file.backup', 'string', 'File-history backup name'),
  attr('ratelimit.used_percent', 'int', 'Share of the rate-limit window used, in percent'),
  attr('ratelimit.window_minutes', 'int', 'Rate-limit window length in minutes'),
  attr('ratelimit.resets_at', 'time', 'When the rate-limit window resets (µs since the epoch)'),
  col('cost.usd', 'int', 'e.cost_usd', 'Logged cost in US dollars (decimals allowed)'),

  // Whole JSON documents.
  col('attrs', 'json', 'p.attrs', 'All normalized attributes as JSON; attrs.<path> reads any attribute', { json: { col: 'p.attrs', path: '' } }),
  col('native', 'json', 'p.native', 'Compact copy of the source record; native.<path> reads any native field (slower)', { json: { col: 'p.native', path: '' } }),

  ...derivedFields(),
];

/**
 * Fields over the derived tables (SPEC §12.3.1, docs/MODULES.md C). Filters compile `semi`, so they read the small
 * derived tables once; `sql` gives one event's value for a custom column (Step, Tier, Signature, Outcome).
 */
function derivedFields(): FieldDef[] {
  const derived = (name: string, type: FieldType, description: string, sql: string, semi: string, more: Partial<FieldDef> = {}): FieldDef =>
    ({ name, type, description, sql, semi, notNull: true, ...more });
  const failureCol = (name: string, c: string, type: FieldType, description: string, values?: readonly string[]) =>
    derived(name, type, description, `(SELECT ${c} FROM failures WHERE rid = e.rid)`, `e.rid IN (SELECT rid FROM failures WHERE ${c} ?)`,
      values ? { values: [...values] } : {});
  // The episode an event belongs to: as an attempt, an attempt's call, or the closing call.
  const episodeOf = `coalesce((SELECT episode_id FROM failures WHERE rid = e.rid),
    (SELECT episode_id FROM failures WHERE call_rid = e.rid AND episode_id IS NOT NULL LIMIT 1),
    (SELECT id FROM episodes WHERE closer_rid = e.rid LIMIT 1))`;
  // The events of the episodes whose column matches: the same membership as `episode`.
  const episodeCol = (name: string, c: string, type: FieldType, description: string, values?: readonly string[]) =>
    derived(name, type, description, `(SELECT ${c} FROM episodes WHERE id = ${episodeOf})`,
      `e.rid IN (SELECT f.rid FROM failures f JOIN episodes ep ON ep.id = f.episode_id WHERE ep.${c} ?
      UNION ALL SELECT f.call_rid FROM failures f JOIN episodes ep ON ep.id = f.episode_id WHERE ep.${c} ? AND f.call_rid IS NOT NULL
      UNION ALL SELECT closer_rid FROM episodes WHERE ${c} ? AND closer_rid IS NOT NULL)`,
      values ? { values: [...values] } : {});
  return [
    { name: 'failure', type: 'bool', description: 'The event has a failure-tier row (SPEC §12.3.3)', predicate: true, notNull: true,
      sql: "(e.rid IN (SELECT rid FROM failures WHERE tier = 'failure'))" },
    failureCol('failure.tier', 'tier', 'enum', 'Failure tier of the event: failure, suspect, benign or deferred', FAILURE_TIERS),
    failureCol('failure.source', 'source', 'enum', 'Where the failure signal came from', FAILURE_SOURCES),
    failureCol('failure.family', 'family', 'enum', 'Failure family of the error signature', FAILURE_FAMILIES),
    failureCol('failure.target', 'target_key', 'string', 'Target key of the failed call, e.g. sh:git status or edit:/abs/path'),
    failureCol('signature', 'sig_id', 'string', 'Error signature id (sig_…) of the event'),
    derived('signature.text', 'string', 'Normalized error signature text',
      '(SELECT g.text FROM failures f JOIN signatures g ON g.id = f.sig_id WHERE f.rid = e.rid)',
      'e.rid IN (SELECT f.rid FROM failures f JOIN signatures g ON g.id = f.sig_id WHERE g.text ?)'),
    derived('episode', 'string', 'Failure episode id: its failed attempts, their calls and the closing call', episodeOf,
      `e.rid IN (SELECT rid FROM failures WHERE episode_id ?
      UNION ALL SELECT call_rid FROM failures WHERE episode_id ? AND call_rid IS NOT NULL
      UNION ALL SELECT closer_rid FROM episodes WHERE id ? AND closer_rid IS NOT NULL)`),
    episodeCol('episode.outcome', 'outcome', 'enum', 'Outcome of the episode the event belongs to', EPISODE_OUTCOMES),
    episodeCol('episode.attempts', 'n_attempts', 'int', 'Attempts of the episode the event belongs to'),
    episodeCol('episode.loop', 'loop', 'bool', 'The episode the event belongs to is a loop (≥5 attempts with one signature)'),
    // turn_id can be NULL, so this semi-join can be NULL (NOT then treats it as false).
    derived('unattended', 'bool', 'The event lies in an unattended turn (SPEC §12.3.5)',
      '(SELECT unattended FROM turn_rollup WHERE turn_id = e.turn_id)',
      'e.turn_id IN (SELECT turn_id FROM turn_rollup WHERE unattended ?)', { notNull: false }),
    derived('step', 'string', 'Step id (<session>#step:<n>) of the event',
      '(SELECT step_id FROM step_events WHERE rid = e.rid)', 'e.rid IN (SELECT rid FROM step_events WHERE step_id ?)'),
    derived('step.failed', 'bool', "The event's step has a failed call",
      '(SELECT st.n_fail > 0 FROM step_events se JOIN steps st ON st.id = se.step_id WHERE se.rid = e.rid)',
      'e.rid IN (SELECT se.rid FROM step_events se JOIN steps st ON st.id = se.step_id WHERE (st.n_fail > 0) ?)'),
    derived('delegation.silent', 'bool', 'The spawn of a child that failed without the parent being told, or an event of that child',
      '(SELECT coalesce((SELECT silent FROM delegations WHERE id = e.span_id), (SELECT max(silent) FROM delegations WHERE child_session = e.session_id)))',
      '(coalesce(e.span_id IN (SELECT id FROM delegations WHERE silent ?), 0) OR e.session_id IN (SELECT child_session FROM delegations WHERE silent ? AND child_session IS NOT NULL))'),
    derived('claim.evidence', 'enum', "Evidence state of a turn's success claim, on its final message",
      '(SELECT evidence FROM claims WHERE turn_id = e.turn_id AND final_rid = e.rid)',
      'e.rid IN (SELECT final_rid FROM claims WHERE evidence ?)', { values: [...CLAIM_EVIDENCE] }),
    derived('intervention.kind', 'enum', 'Human, parent, policy or hook intervention at this event',
      '(SELECT kind FROM interventions WHERE rid = e.rid)', 'e.rid IN (SELECT rid FROM interventions WHERE kind ?)',
      { values: [...INTERVENTION_KINDS] }),
    derived('process', 'string', 'Background process id (<session>#proc:<N>:<seq>) the event opens, polls or closes',
      '(SELECT process_id FROM process_events WHERE rid = e.rid)', 'e.rid IN (SELECT rid FROM process_events WHERE process_id ?)'),
    derived('change.path', 'string', 'File the event reads or changes',
      '(SELECT path FROM changes WHERE rid = e.rid LIMIT 1)', 'e.rid IN (SELECT rid FROM changes WHERE path ?)'),
    derived('alarm.kind', 'enum', 'Kind of an alarm whose interval holds this failure',
      '(SELECT a.kind FROM failures f JOIN alarms a ON a.turn_id = f.turn_id WHERE f.rid = e.rid AND f.ts BETWEEN a.first_ts AND a.last_ts LIMIT 1)',
      'e.rid IN (SELECT f.rid FROM failures f JOIN alarms a ON a.turn_id = f.turn_id WHERE a.kind ? AND f.ts BETWEEN a.first_ts AND a.last_ts)',
      { values: [...ALARM_KINDS] }),
  ];
}

const FIELDS = new Map(FIELD_LIST.map((f): [string, FieldDef] => [f.name, f]));

function keyword(name: string, sql: string, description: string): FieldDef {
  return { name, type: 'bool', sql, description, notNull: true, predicate: true };
}

/** Bare words that are not fields: layers, flags and event kinds. */
const KEYWORDS = new Map<string, FieldDef>([
  ...LAYERS.map((l) => keyword(l, `(e.kind GLOB '${l}.*')`, `Layer: every ${l}.* event`)),
  ...keysOf(FLAG_BITS).map((f) => keyword(f, `((e.flag_bits & ${FLAG_BITS[f]}) != 0)`, `Flag: ${FLAG_DESCRIPTIONS[f]}`)),
  ...keysOf(EVENT_KINDS).map((k) => keyword(k, `(e.kind = '${k}')`, `Kind: ${EVENT_KINDS[k]}`)),
].map((f): [string, FieldDef] => [f.name, f]));

const JSON_FIELDS = FIELD_LIST.filter((f) => f.json);
const FIELD_NAMES = [...FIELDS.keys()];
const ALL_NAMES = [...FIELD_NAMES, ...KEYWORDS.keys()];

const NATIVE_WARNING = 'native.* fields are read from the stored JSON of every event, which is slow';

export function listFields(): FieldInfo[] {
  const keywords = [...KEYWORDS.values()].filter((k) => !FIELDS.has(k.name));
  return [...FIELD_LIST, ...keywords].map(({ name, type, description, values }) => (values ? { name, type, description, values } : { name, type, description }));
}

export type Resolution = { def: FieldDef; warning?: string } | { error: string };

/**
 * Resolve a name typed in a filter. A bare word prefers keywords (the layer `agent`),
 * a comparison prefers fields (`agent == codex`). Unknown dotted names close to a known
 * name are errors with a suggestion; other unknown dotted names read attrs with a warning.
 */
export function resolveName(name: string, bare: boolean): Resolution {
  const known = bare ? (KEYWORDS.get(name) ?? FIELDS.get(name)) : (FIELDS.get(name) ?? KEYWORDS.get(name));
  if (known) return { def: known };
  const unknown = bare ? `unknown field or keyword '${name}' (quote text to search for it)` : `unknown field '${name}'`;
  if (!FIELD_PATH_RE.test(name)) return { error: unknown };
  for (const base of JSON_FIELDS) {
    if (!name.startsWith(base.name + '.')) continue;
    const { col, path } = base.json!;
    const sub = name.slice(base.name.length + 1);
    const def = untyped(name, `json_extract(${col}, '${jsonPath(path ? `${path}.${sub}` : sub)}')`);
    return col === 'p.native' ? { def, warning: NATIVE_WARNING } : { def };
  }
  const near = closest(name, bare ? ALL_NAMES : FIELD_NAMES);
  if (near) return { error: `${unknown}. Did you mean '${near}'?` };
  if (name.includes('.')) {
    return { def: untyped(name, `json_extract(p.attrs, '${jsonPath(name)}')`), warning: `'${name}' is not a known field; matching attrs.${name}` };
  }
  return { error: unknown };
}

function untyped(name: string, sql: string): FieldDef {
  return { name, type: 'json', sql, description: '' };
}

/** Closest candidate within a small edit distance, or undefined. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  const limit = name.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDist = limit + 1;
  for (const c of candidates) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  // closest() never accepts a distance above 2, so skip the table for far-apart lengths.
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
