// Normalized record types shared by adapters, the index, the capture format and the server.
// Semantics are specified in docs/SPEC.md §3; capture framing in docs/FORMAT.md.
// Times are integer microseconds since the Unix epoch (UTC); durations are integer microseconds.

export type AgentKind = 'claude-code' | 'claude-cowork' | 'codex' | 'copilot';
export type AgentPrefix = 'cc' | 'cw' | 'cx' | 'cp';

export const AGENT_PREFIX: Record<AgentKind, AgentPrefix> = {
  'claude-code': 'cc',
  'claude-cowork': 'cw',
  codex: 'cx',
  copilot: 'cp',
};

export type SourceKind =
  | 'transcript' // Claude main transcript
  | 'subagent-transcript' // Claude Agent-tool subagent
  | 'workflow-transcript' // Claude workflow agent
  | 'rollout' // Codex rollout (main or child thread)
  | 'audit' // Cowork audit.jsonl
  | 'registry' // desktop session registry JSON (local_*.json)
  | 'state-db' // Codex state_5.sqlite
  | 'chat-session' // VS Code Copilot chat session JSON or mutation log
  | 'session-events'; // Copilot CLI session-state events.jsonl

export type SessionRole = 'main' | 'subagent' | 'workflow-agent' | 'guardian' | 'review' | 'fork' | 'automation';
export type SessionState = 'ok' | 'missing-transcript' | 'source-deleted';

export type Actor = 'user' | 'assistant' | 'tool' | 'system' | 'harness' | 'agent';

export type EventKind =
  | 'session.meta' | 'session.state'
  | 'user.prompt' | 'user.inject'
  | 'llm.text' | 'llm.thinking' | 'llm.usage' | 'llm.error' | 'llm.refusal'
  | 'tool.call' | 'tool.result' | 'tool.exec'
  | 'agent.spawn' | 'agent.message' | 'agent.status'
  | 'context.attachment' | 'context.compaction' | 'context.snapshot'
  | 'turn.start' | 'turn.end' | 'turn.abort'
  | 'hook.run'
  | 'permission.request' | 'permission.decision'
  | 'harness.queue' | 'harness.ratelimit' | 'harness.status' | 'harness.file' | 'harness.vcs' | 'harness.other'
  | 'raw.unknown';

export type SpanKind =
  | 'session' | 'turn' | 'llm' | 'tool' | 'exec' | 'workflow' | 'phase'
  | 'compaction' | 'hook' | 'retry' | 'permission';

export type SpanStatus = 'ok' | 'error' | 'cancelled' | 'interrupted' | 'open' | 'unknown';

/** How a timestamp was obtained. */
export type TsSrc = 'logged' | 'inherited' | 'none';

/** How a duration was obtained: 'logged:<field>' | 'derived:ts-gap' | 'parsed:<what>' | 'unknown'. */
export type DurSrc = string;

export type EventFlag =
  | 'error' | 'inherited' | 'dup' | 'orphan' | 'inferred' | 'truncated' | 'abandoned' | 'meta' | 'sidechain';

/** Bit positions for EventFlag in the index column `flag_bits`. */
export const FLAG_BITS: Record<EventFlag, number> = {
  error: 1,
  inherited: 2,
  dup: 4,
  orphan: 8,
  inferred: 16,
  truncated: 32,
  abandoned: 64,
  meta: 128,
  sidechain: 256,
};

export type ToolKindTag = 'builtin' | 'mcp' | 'shell' | 'file' | 'web' | 'agent' | 'custom' | 'plan' | 'other';

export interface TokenUsage {
  /** All prompt tokens including cached ones. */
  input?: number;
  /** Prompt tokens not served from cache. */
  uncached?: number;
  cache_read?: number;
  cache_write?: number;
  output?: number;
  /** Reasoning/thinking tokens (subset of output where the provider reports it). */
  reasoning?: number;
  total?: number;
  context_window?: number;
}

/** Normalized attributes (SPEC §3.7). Every field is optional; adapters fill what the source provides. */
export interface Attrs {
  text?: string;
  text_len?: number;
  tool?: {
    name?: string;
    call_id?: string;
    server?: string;
    kind?: ToolKindTag;
    input?: unknown;
    input_summary?: string;
    command?: string;
    path?: string;
    output?: string;
    output_len?: number;
    is_error?: boolean;
    exit_code?: number;
    status?: string;
    persisted_path?: string;
    reported_wall_ms?: number;
    /** Schema 4: the last TOOL_OUTPUT_TAIL.chars characters of the output when output_len > TOOL_OUTPUT_TAIL.minLen (SPEC §12.3.1). */
    output_tail?: string;
    /**
     * Schema 4: the background process this call opens, polls or writes to. Codex: N of "Process running with session
     * ID N" and `write_stdin` input.session_id. Claude: toolUseResult.backgroundTaskId and the task ids of TaskOutput,
     * task_status and <task-notification>.
     */
    proc_id?: string;
    /** Schema 4, Codex exec-* items: the call_id of the code-mode exec or wait call that ran the item. */
    parent_call_id?: string;
    /** Schema 4, Codex code-mode results and their tool spans: nested exec items that failed. */
    inner_errors?: number;
    /** Codex: the command's working directory (also copied onto the call an item mirrors). */
    cwd?: string;
    /** Codex CommandExecution parsed_cmd, compacted to [{type, cmd, name?, path?, query?}] (also on the call an item mirrors). */
    parsed_cmd?: unknown;
    [k: string]: unknown;
  };
  llm?: {
    model?: string;
    message_id?: string;
    request_id?: string;
    response_id?: string;
    stop_reason?: string;
    stop_reason_src?: 'logged' | 'inferred';
    effort?: string;
    service_tier?: string;
    block_index?: number;
    thinking_ms?: number;
    ttft_ms?: number;
    latency_ms?: number;
    [k: string]: unknown;
  };
  tokens?: TokenUsage;
  agent?: {
    id?: string;
    type?: string;
    path?: string;
    nickname?: string;
    role?: string;
    description?: string;
    link_session?: string;
    [k: string]: unknown;
  };
  turn?: { id?: string; index?: number; origin?: string; [k: string]: unknown };
  hook?: { name?: string; event?: string; exit_code?: number; command?: string; duration_ms?: number; [k: string]: unknown };
  error?: { type?: string; status?: number; message?: string; retry_attempt?: number; retry_in_ms?: number; [k: string]: unknown };
  permission?: { mode?: string; decision?: string; reason?: string; tool?: string; [k: string]: unknown };
  context?: { type?: string; [k: string]: unknown };
  file?: { path?: string; version?: number; backup?: string; [k: string]: unknown };
  /** resets_at is in µs since the epoch, like every timestamp. */
  ratelimit?: { used_percent?: number; window_minutes?: number; resets_at?: number; [k: string]: unknown };
  cost?: { usd?: number; [k: string]: unknown };
  /**
   * Schema 4: files a tool call changes, computed from the full input strings before the index caps them: Edit,
   * MultiEdit, Write, NotebookEdit, each file of an apply_patch, and Codex FileChange (SPEC §12.3.1).
   */
  change?: { files?: ChangeFile[]; [k: string]: unknown };
  /** sha256 refs to blob records (captures) or side files. */
  blob_refs?: string[];
  [k: string]: unknown;
}

/** Pointer from a normalized event back to its source bytes. */
export interface RawRef {
  source: string;
  /** 1-based line number in the source file (0 for non-line sources such as registry JSON). */
  line: number;
  /** Byte offset of the line start. */
  offset: number;
  /** Byte length of the line, excluding the newline. */
  length: number;
  /** Content block index when one line yields several events. */
  block?: number;
  /** Only in capture files: the exact source line. */
  text?: string;
  /** SHA-256 of text's UTF-8 bytes, when embedded in a capture. */
  sha256?: string;
}

export interface SourceRec {
  rec: 'source';
  id: string;
  agent: AgentKind;
  kind: SourceKind;
  path: string;
  size: number;
  mtimeMs: number;
  ino?: number;
  /** Bytes consumed up to the last complete line. */
  parsedBytes?: number;
  lines?: number;
  malformed?: number;
  unknown?: number;
  skipped?: number;
  inherited?: number;
  dialect?: string;
  sha256?: string;
}

export interface SessionRec {
  rec: 'session';
  id: string;
  agent: AgentKind;
  nativeId: string;
  role: SessionRole;
  state?: SessionState;
  parentId?: string;
  parentSpanId?: string;
  title?: string;
  cwd?: string;
  project?: string;
  git?: { branch?: string; commit?: string; repo?: string };
  models?: string[];
  version?: string;
  originator?: string;
  entrypoint?: string;
  /** Logged creation time when the source has one (otherwise the linker uses the first event). */
  createdTs?: number;
  meta?: Record<string, unknown>;
}

export interface EventRec {
  rec: 'event';
  id: string;
  session: string;
  ts: number;
  tsSrc: TsSrc;
  /** Order within the session's source file(s); file order, not time order. */
  seq: number;
  kind: EventKind;
  proto: string;
  actor: Actor;
  summary: string;
  span?: string;
  turn?: string;
  /** Duration of `span` when this event opens or closes it (copied for fast filtering). */
  dur?: number;
  attrs: Attrs;
  native?: unknown;
  raw: RawRef;
  flags?: EventFlag[];
}

/** Spans carry no flags; a span built from inherited records says so in `attrs.inherited` (SPEC §3.5). */
export interface SpanRec {
  rec: 'span';
  id: string;
  session: string;
  kind: SpanKind;
  name: string;
  parent?: string;
  start: number;
  end?: number;
  dur?: number;
  durSrc: DurSrc;
  status: SpanStatus;
  /** Child session this span spawned (Agent tool, spawn_agent, workflow agent). */
  linkSession?: string;
  firstEvent?: string;
  lastEvent?: string;
  attrs: Attrs;
}

export type ExpertSeverity = 'error' | 'warn' | 'note' | 'chat';
export type ExpertGroup =
  | 'malformed' | 'undecoded' | 'unpaired' | 'tool-error' | 'api-error' | 'retry' | 'refusal'
  | 'interrupted' | 'permission-denied' | 'compaction' | 'logging-gap' | 'sequence' | 'rate-limit';

/**
 * SPEC §3.8: the severity of each group whose entries weigh the same for every agent, so Diagnostics files the group
 * under one heading. The others depend on the entry: an unpaired call in an open turn is a note, an API error that
 * the harness retries a warning, a missing transcript a warning but a timestamp inversion only information.
 */
export const GROUP_SEVERITY: Partial<Record<ExpertGroup, ExpertSeverity>> = {
  malformed: 'warn', undecoded: 'note', 'tool-error': 'warn', retry: 'warn', refusal: 'warn', interrupted: 'note',
  'permission-denied': 'warn', 'rate-limit': 'warn', compaction: 'note', sequence: 'note',
};

export interface ExpertRec {
  rec: 'expert';
  session?: string;
  event?: string;
  span?: string;
  severity: ExpertSeverity;
  group: ExpertGroup;
  message: string;
}

/** Metadata about a session that comes from a different source (desktop registry, Codex state DB). */
export interface EnrichRec {
  rec: 'enrich';
  session: string;
  /** Fields that override or fill SessionRec fields (title, parentId, ...). */
  fields?: Partial<Pick<SessionRec, 'title' | 'parentId' | 'cwd' | 'project' | 'git' | 'models' | 'role'>>;
  meta: Record<string, unknown>;
}

export interface BlobRec {
  rec: 'blob';
  sha256: string;
  size: number;
  mediaType: string;
  encoding: 'utf8' | 'base64';
  origin?: { path?: string; role?: string };
  data?: string;
}

export type IndexRecord = SessionRec | EventRec | SpanRec | ExpertRec | EnrichRec | BlobRec;

// ---------------------------------------------------------------------------
// Row shapes returned by the index query layer and the HTTP API (SPEC §6).

export interface SessionRow {
  id: string;
  agent: AgentKind;
  nativeId: string;
  role: SessionRole;
  state: SessionState;
  parentId: string | null;
  parentSpanId: string | null;
  rootId: string;
  title: string | null;
  cwd: string | null;
  project: string | null;
  gitBranch: string | null;
  models: string[];
  version: string | null;
  originator: string | null;
  entrypoint: string | null;
  start: number | null;
  end: number | null;
  nEvents: number;
  nLlm: number;
  nTools: number;
  nTurns: number;
  nErrors: number;
  nChildren: number;
  tokens: TokenUsage;
  costUsd: number | null;
}

export interface EventRow {
  /** View row number (1-based) when returned from a view; otherwise null. */
  no: number | null;
  id: string;
  rid: number;
  session: string;
  agent: AgentKind;
  ts: number;
  tsSrc: TsSrc;
  seq: number;
  kind: EventKind;
  proto: string;
  actor: Actor;
  summary: string;
  span: string | null;
  turn: string | null;
  toolName: string | null;
  model: string | null;
  dur: number | null;
  tokIn: number | null;
  tokOut: number | null;
  flags: EventFlag[];
  /** Id of the first of the view's coloring rules that matches the row, or null (only when the view has rules). */
  colorRule?: string | null;
  /** Values of the custom columns a rows request asked for, keyed by field name. */
  extra?: Record<string, unknown>;
}

export interface SpanRow {
  id: string;
  session: string;
  kind: SpanKind;
  name: string;
  parent: string | null;
  start: number;
  end: number | null;
  dur: number | null;
  durSrc: DurSrc;
  status: SpanStatus;
  linkSession: string | null;
  firstEvent: string | null;
  lastEvent: string | null;
  depth: number;
  attrs: Attrs;
}

export type ConversationItemType =
  | 'prompt' | 'inject' | 'text' | 'thinking' | 'tool' | 'exec' | 'subagent' | 'compaction' | 'error' | 'turn-end' | 'status';

export interface ConversationItem {
  type: ConversationItemType;
  event: string;
  ts: number;
  text?: string;
  textLen?: number;
  tool?: { name: string; kind?: ToolKindTag; inputSummary?: string; input?: unknown; output?: string; outputLen?: number; isError?: boolean; exitCode?: number; dur?: number; resultEvent?: string };
  subagent?: { session: string; title?: string; type?: string };
  llm?: { model?: string; tokens?: TokenUsage };
  /**
   * `exec` items (commands, patches and MCP calls run inside a Codex code-mode script): the tool call event whose
   * card they belong under. Clients show them nested and collapsed under that card.
   */
  parentEvent?: string;
  meta?: Record<string, unknown>;
}

export type Capability =
  | 'timestamps' | 'llm-latency' | 'ttft' | 'tool-durations' | 'exit-codes' | 'token-usage' | 'cache-tokens'
  | 'reasoning-text' | 'system-prompt' | 'tool-definitions' | 'subagent-tree' | 'file-diffs' | 'cost'
  | 'raw-http' | 'permission-decisions';

export type CapabilityLevel = 'logged' | 'derived' | 'partial' | 'absent';

/** Advice attached to a finding: prose, plus code that can be copied and run as is (never mixed with prose). */
export interface HealthRecommendation {
  text: string;
  code?: { lang: 'sh' | 'toml' | 'json'; snippet: string };
  /**
   * What following the advice changes, e.g. "Configures an external OTLP collector; AgentShark does not ingest this
   * data" or "AgentShark keeps more history to index".
   */
  effect?: string;
}

export interface HealthFinding {
  severity: ExpertSeverity;
  title: string;
  detail: string;
  recommendation?: HealthRecommendation;
}

export interface HealthReport {
  agent: AgentKind | string;
  label: string;
  detected: boolean;
  parsed: boolean;
  /** Locations that exist and were read (in a capture: the captured files' folders). */
  roots: string[];
  /** Every location this machine's report checked for the agent, found or not (absent in a capture report). */
  searched?: string[];
  files: number;
  bytes: number;
  firstTs: number | null;
  lastTs: number | null;
  versions: string[];
  parse: { lines: number; malformed: number; unknown: number; skipped: number; inherited: number };
  capabilities: { capability: Capability; level: CapabilityLevel; note: string }[];
  findings: HealthFinding[];
}

// ===========================================================================
// Agent-native derived model (SPEC §12.3). The analysis pass (src/index/derive.ts, linker pass 6) writes these rows
// into the schema-4 tables of schema.sql; src/index/derived-queries.ts reads them for the HTTP API, the CLI and MCP.
//
// Row ↔ column mapping: a *Row field is the camelCase of its snake_case column (`ctxWindowSrc` ↔ `ctx_window_src`).
// Booleans are stored as 0/1. `*Src` fields hold a Prov. A value the logs do not carry is null, never 0, and the
// response that shows it lists a Gap (SPEC §12.9). Values that depend on the clock (alarm state, signature status,
// `stall`) have no column: the API *Item types compute them on read from DerivedContext.now.
//
// Durations: a duration or wall time without a `*Src` sibling is `derived:ts-gap` (the difference of two event
// timestamps). A logged duration always comes with its `*Src`.
//
// Ids: every id a client sees is stable across re-parses: built from session, span and event ids (SPEC §3.1), step
// numbers, or hashes. `rid` columns (`events.rid`) are index-internal join keys that a re-parse of a source renumbers;
// no exposed id embeds one, and each API *Item adds the event id of every rid it carries (`resultRid` → `resultEventId`).
//
// Trace text: any string whose characters come from the logs' free text: titles, prompts, commands, outputs, model
// text, file paths and cwd, and the strings built from them (target keys, signature text, error lines, fix
// patterns). Ids AgentShark builds, enum values, provenance, tool names and model names are not trace text. MCP puts
// trace text only in `*_excerpt` keys (src/mcp/schemas.ts).

/**
 * A versioned rule: `<name>@<version>` (`traceback@1`, `claim@1`, `consecutive@1`, `near-3-calls@1`). Every `rule`
 * field holds this bare form; a Prov `inferred:<RuleId>` embeds one. AnalysisStatus.rules lists every rule.
 */
export type RuleId = `${string}@${string}`;

/**
 * One entry of the rule registry (`RULES` in src/index/derive.ts, served as AnalysisStatus.rules). `rule` is a RuleId,
 * or `<rule>/<state>` for one state of a rule's label (`claim@1/last-test-failed`, `parent-told@2/silent`).
 */
export interface RuleInfo {
  /** Audit classification; absence in an older index never implies empirical validation. */
  basis?: 'logged' | 'deterministic' | 'heuristic';
  validation?: 'structural' | 'measured' | 'unvalidated' | 'suppressed';
  advisory?: boolean;
  rule: RuleId;
  /** What the rule decides, one line ("Python traceback in an unflagged result"). */
  description: string;
  /**
   * Share of hand-checked items the rule got right (SPEC §12.10 acceptance 4), 0..1; null until checked. A label ships
   * only at ≥ 0.8: a rule below it labels nothing (derive/precision.ts). The `?` tooltip shows it.
   */
  precision: number | null;
  /** Items hand-checked for `precision`. */
  checked: number | null;
}

/**
 * Provenance of a derived value (SPEC §12.1 principle 5):
 * - `logged` or `logged:<field>`: the agent wrote it (`logged:llm.latency_ms`, `logged:workflow`);
 * - `derived` or `derived:<how>`: computed from logged values (`derived:ts-gap`, `derived:child`);
 * - `parsed` or `parsed:<what>`: extracted from output text (`parsed:exit-line`, `parsed:wait-status`);
 * - `inferred:<RuleId>`: a versioned heuristic (`inferred:ctx-window@1`, `inferred:correction@1`).
 */
export type Prov =
  | 'logged' | `logged:${string}`
  | 'derived' | `derived:${string}`
  | 'parsed' | `parsed:${string}`
  | `inferred:${RuleId}`;

/**
 * attrs.tool.output_tail: kept when the output is longer than minLen characters (SPEC §12.3.1). The FTS body gets
 * the whole tail after its head parts (src/index/writer.ts).
 */
export const TOOL_OUTPUT_TAIL = { chars: 2048, minLen: 4096 } as const;

/** apply_patch `*** Add/Update/Delete File`, `*** Move to`; `write` when a Write may have replaced an existing file. */
export type ChangeFileOp = 'add' | 'update' | 'delete' | 'move' | 'write';

/** One file a tool call changed (attrs.change.files). Line counts are null when the input does not determine them. */
export interface ChangeFile {
  path: string;
  op: ChangeFileOp;
  added: number | null;
  removed: number | null;
  /** Target path of a move. */
  to?: string;
}

// ---------------------------------------------------------------------------
// Vocabularies (SPEC §12.3.3–§12.3.9). Arrays are in the order the UI lists them.

/** SPEC §12.3.3. Only `failure` counts by default; the tier toggle adds the others. */
export const FAILURE_TIERS = ['failure', 'suspect', 'benign', 'deferred'] as const;
export type FailureTier = (typeof FAILURE_TIERS)[number];

/**
 * Where the failure signal came from. For tier `failure` the most specific of: `flag` (error flag), `inner` (Codex
 * tool.exec error under an ok exec), `api` (llm.error, refusal), `policy` (approval rejection, hook block, Cowork deny),
 * `hook` (the user's own hook command failed), `process` (an unflagged closing poll with a non-zero exit). `text`:
 * no logged signal, only a text rule (tier `suspect`). Benign and deferred rows keep the source they were reclassified
 * from (an `rg` exit 1 flagged as an error is `benign` with source `flag`).
 */
export const FAILURE_SOURCES = ['flag', 'inner', 'api', 'policy', 'hook', 'process', 'text'] as const;
export type FailureSource = (typeof FAILURE_SOURCES)[number];

/** Text rules of the `suspect` tier (FailureRow.rule is `<rule>@<version>`, e.g. `traceback@1`). */
export const SUSPECT_RULES = ['traceback', 'tests-failed', 'not-found', 'timeout', 'sandbox'] as const;
export type SuspectRule = (typeof SUSPECT_RULES)[number];

/** SPEC §12.4 step 5, in the order the families are checked. `user-rejected`: the user said no to the call. */
export const FAILURE_FAMILIES = [
  'api', 'user-rejected', 'policy', 'sandbox', 'network', 'stale-edit', 'test-failure', 'missing-module', 'missing-file',
  'harness', 'hook', 'exception', 'error-text', 'other',
] as const;
export type FailureFamily = (typeof FAILURE_FAMILIES)[number];

export type FailureClass = 'environment' | 'harness' | 'agent-work';

export const FAMILY_CLASS: Record<FailureFamily, FailureClass> = {
  sandbox: 'environment', policy: 'environment', network: 'environment', 'missing-module': 'environment',
  harness: 'harness', hook: 'harness', api: 'harness',
  'stale-edit': 'agent-work', 'test-failure': 'agent-work', 'user-rejected': 'agent-work', 'missing-file': 'agent-work', exception: 'agent-work',
  'error-text': 'agent-work', other: 'agent-work',
};

/** Families that mean "blocked by the environment" (SPEC §12.4 step 5). */
export const BLOCKED_FAMILIES: readonly FailureFamily[] = ['sandbox', 'policy', 'network'];

/**
 * SPEC §12.3.5, in rule order (the first match wins). `open`: the turn has not ended (a possibly-running run), so the
 * outcome is not decided yet; it becomes one of the others when the turn ends.
 */
export const EPISODE_OUTCOMES = ['recovered', 'interrupted', 'parallel-ok', 'recovered-later', 'pivoted', 'ended-on-failure', 'open'] as const;
export type EpisodeOutcome = (typeof EPISODE_OUTCOMES)[number];

/** Who ended an interrupted episode: human in main sessions; elsewhere a parent stop looks the same (§12.9 limit 3). */
export type EpisodeActor = 'human' | 'parent-or-human';

/** SPEC §12.3.5 transitions: `1 − levenshtein / maxlen` over 400 normalized characters. */
export const CHANGE_CLASSES = ['identical', 'flags-only', 'small', 'moderate', 'rewrite'] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

/** SPEC §12.3.6, worst first. Shown as a glyph and a word, never as a score. */
export const TURN_IMPACTS = ['failed', 'blocked', 'interrupted', 'masked', 'degraded', 'slow', 'recovered', 'clean'] as const;
export type TurnImpact = (typeof TURN_IMPACTS)[number];

/** SPEC §12.3.7. `running`: the child has not finished; `unknown`: no source names an outcome (§12.9 limit 9). */
export const DELEGATION_OUTCOMES = ['completed', 'failed', 'blocked', 'killed', 'stopped', 'running', 'unknown'] as const;
export type DelegationOutcome = (typeof DELEGATION_OUTCOMES)[number];

/** Spawning mechanism of a delegation. */
export type DelegationKind = 'agent' | 'task' | 'spawn-agent' | 'workflow-agent';

/** `exited`: "Process exited with code N"; `closed`: "stdin is closed" or "Unknown process id" ended it; `killed`: KillShell/TaskStop. */
export const PROCESS_STATUSES = ['running', 'exited', 'closed', 'killed', 'unknown'] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

/** Role of an event in a process stream (SPEC §12.3.8). `poll`: write_stdin with empty chars; `input`: with chars. */
export type ProcessEventRole = 'open' | 'poll' | 'input' | 'output' | 'close' | 'error' | 'kill';

/**
 * Change rows (SPEC §12.3.8). Edit rows come from attrs.change.files, `read` from Read and Codex parsed_cmd,
 * `external` from edited_text_file, `backup` from harness.file, `shell-mention` from a shell command naming a path
 * next to `sed -i`, `>`, `tee`, `mv`, `cp`, `rm` or `git checkout|restore` (never with a diff).
 */
export const CHANGE_OPS = ['read', 'add', 'update', 'delete', 'move', 'write', 'external', 'backup', 'shell-mention'] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

/** SPEC §12.3.8. */
export const INTERVENTION_KINDS = [
  'interrupt', 'abort-child', 'tool-rejected', 'policy-rejected', 'hook-blocked', 'permission-decision', 'question',
  'external-edit', 'correction',
] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

/** Who acted. `policy` and `hook` are automatic, not a live human. */
export type InterventionActor = 'human' | 'parent-or-human' | 'policy' | 'hook' | 'harness';

/** SPEC §12.3.8 claim check. A claim chip is never red. */
export const CLAIM_EVIDENCE = ['passed-after-last-edit', 'edited-after-last-test', 'last-test-failed', 'no-test-in-turn', 'unknown'] as const;
export type ClaimEvidence = (typeof CLAIM_EVIDENCE)[number];

/** Claim states that count as "unverified" in the attention queue and the Run report. */
export const UNVERIFIED_CLAIMS: readonly ClaimEvidence[] = ['edited-after-last-test', 'last-test-failed', 'no-test-in-turn'];

/**
 * SPEC §12.3.9. Only `consecutive` and `blocker` may notify (NOTIFYING_ALARMS); the others are badges. Alarms are
 * stateless: the `alarms` table is a pure function of the events (one row per instance, on every turn), and the
 * clock only decides the state on read (ALARM_STATES). An instance holds from its first evidence until it clears:
 * - `consecutive`: from the Nth consecutive non-benign failure row of the turn (tiers failure and suspect; benign and
 *   deferred rows neither count nor break the run); clears at the next tool result of the turn with no failure or
 *   suspect row;
 * - `blocker`: from the Nth failure row of a BLOCKED_FAMILIES family in the turn; clears at the closing call of the
 *   last of those episodes to close;
 * - `loop`, `blind-loop`: from the attempt that sets the episode's `loop` (`blind`) flag; clears at its closing call;
 * - `silent-child`: from the parent's view of a child result that hid a failure (DelegationRow.silent); clears at the
 *   end of the parent turn;
 * - `stall`: depends on the clock, so it is never stored: computed on read for an open turn whose newest own event is
 *   at least `stallMin` old and does not wait on a running process or a question (TurnRollupRow.waiting).
 * Every stored instance also clears when its turn ends. N comes from AlarmThresholds.
 */
export const ALARM_KINDS = ['consecutive', 'blocker', 'blind-loop', 'loop', 'stall', 'silent-child'] as const;
export type AlarmKind = (typeof ALARM_KINDS)[number];
export const NOTIFYING_ALARMS: readonly AlarmKind[] = ['consecutive', 'blocker'];

/**
 * Computed on read: `cleared` when clearedTs is set; otherwise `firing` while now − lastTs ≤ windowMin (for `stall`,
 * while now − lastTs < stallMin + windowMin), else `expired`: the turn wrote nothing for that long without ending, and
 * the alarm no longer counts as open. Only `firing` alarms are open (queue section `alarms`, sidebar ⟳, counts).
 */
export const ALARM_STATES = ['firing', 'cleared', 'expired'] as const;
export type AlarmState = (typeof ALARM_STATES)[number];

/**
 * Alarm thresholds (SPEC §12.3.9 "Thresholds are settings"). They are a server setting, one per index, so every
 * reader sees the same alarms: the analysis pass reads `meta.alarm_thresholds` (a partial override, schema.sql) over
 * these defaults, and AnalysisStatus.alarmThresholds reports the values in effect. Clients never send thresholds;
 * changing them re-derives every tree.
 */
export interface AlarmThresholds {
  /** `consecutive`: non-benign failures with no ok call between them. */
  consecutive: number;
  /** `blocker`: failures of a blocked family in one turn. */
  blocker: number;
  /** `stall`: minutes without an own event in an open turn. */
  stallMin: number;
  /** An alarm that still holds expires when its turn writes nothing for this many minutes (`stall`: after it fired). */
  windowMin: number;
}
export const ALARM_THRESHOLDS: AlarmThresholds = { consecutive: 6, blocker: 2, stallMin: 10, windowMin: 15 };

/**
 * SPEC §12.4 step 6, computed on read from SignatureRow (first match): `dormant` when now − lastTs ≥ 14 days and
 * turnsSinceLast ≥ 20; `new` when now − firstTs < 7 days; `regressed` when regressedTs is set and now − regressedTs
 * < 7 days; else `recurring`.
 */
export const SIGNATURE_STATUSES = ['new', 'recurring', 'dormant', 'regressed'] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];

/** Turn wall-time buckets in priority order (SPEC §12.3.9); what none claims is `unattributed`, never model time. */
export const TIME_BUCKETS = ['wait-human', 'wait-agent', 'wait-process', 'api-retry', 'compaction', 'hook', 'tool', 'model'] as const;
export type TimeBucketName = (typeof TIME_BUCKETS)[number];

/**
 * Failures workspace attention sections, in display order (SPEC §12.7). Each queue item sits in exactly one:
 * - `alarms`: alarms whose state is `firing`;
 * - `blocked`, `unrecovered`, `other`, `recovered`: episodes, by EpisodeRow.section (EPISODE_SECTIONS);
 * - `silent-child`: delegations with `silent`;
 * - `unverified-claims`: claims whose evidence is in UNVERIFIED_CLAIMS;
 * - `recurring`: signatures whose status is `regressed`, or `recurring` with an unrecovered episode in scope.
 * `other` and `recovered` start collapsed.
 */
export const ATTENTION_SECTIONS = [
  'alarms', 'blocked', 'unrecovered', 'silent-child', 'unverified-claims', 'recurring', 'other', 'recovered',
] as const;
export type AttentionSection = (typeof ATTENTION_SECTIONS)[number];
/** Sections that count toward "n need attention". */
export const NEEDS_ATTENTION: readonly AttentionSection[] = ['alarms', 'blocked', 'unrecovered', 'silent-child', 'unverified-claims', 'recurring'];

/**
 * The sections an episode can sit in, stored as EpisodeRow.section by the analysis pass (first match):
 * `recovered` (outcome recovered or parallel-ok); `other` (family user-rejected: the user's own "no" needs no
 * attention); `blocked` (family in BLOCKED_FAMILIES); `unrecovered` (outcome ended-on-failure, `loop`, interrupted with
 * actor `human`, or pivoted with family test-failure); else `other`.
 */
export const EPISODE_SECTIONS = ['blocked', 'unrecovered', 'other', 'recovered'] as const;
export type EpisodeSection = (typeof EPISODE_SECTIONS)[number];

export const QUEUE_GROUPS = ['attention', 'episode', 'signature', 'session', 'delegation'] as const;
export type QueueGroup = (typeof QUEUE_GROUPS)[number];
export type QueueRowKind = 'episode' | 'alarm' | 'delegation' | 'claim' | 'signature' | 'session';

/** `possibly-running`: the run's newest event is less than 60 s old (SPEC §12.3.1). */
export type RunStatus = 'finished' | 'possibly-running';

/**
 * Stated gaps (SPEC §12.9). The first twelve are the data limits 1–12 in order; the rest are states of this index.
 * A response lists the gaps that apply to what it shows, so a missing value is never read as zero.
 */
export const GAP_CODES = [
  'output-tail-missing', // 1: output indexed before schema 4, or longer than head + tail
  'approvals-not-logged', // 2: Claude Code and Codex log no approvals and no approval wait
  'interrupt-actor-ambiguous', // 3: in a child session a human interrupt looks like a parent stop
  'api-errors-not-logged', // 4: Codex logs no API errors or retries
  'model-time-not-logged', // 5: model time is logged only for Claude; TTFT for 30% of Codex spans
  'cost-not-logged', // 6: cost_usd only for Claude main sessions
  'context-not-logged', // 7: context composition, and Claude's context window
  'shell-changes-invisible', // 8: file changes made through the shell
  'child-outcome-free-text', // 9: plain subagents return free text only
  'exit-code-not-logged', // 10: Claude Bash successes carry no exit code; suspect counts are upper bounds
  'thinking-redacted', // 11: thinking text exists in only 12–28% of blocks
  'dissatisfaction-not-logged', // 12: no structured signal of user dissatisfaction
  'analysis-pending', // trees waiting in meta.analysis_pending
  'analysis-outdated', // meta.analysis_version or sig_version differs from this build, or the index was never derived
  'not-derived', // a P1/P2 table this build does not fill yet (claims, changes, interventions, ...)
  'raw-unavailable', // raw bytes are gone (source deleted or changed); Export Capture keeps them
  'scope-limited', // MCP: sessions outside the caller's project are hidden (--scope project)
  'truncated', // a limit or --max-bytes cut the response; `count` says how many items were left out
  'possibly-running', // the run is live: open outcomes and counts can still change
] as const;
export type GapCode = (typeof GAP_CODES)[number];

export interface Gap {
  code: GapCode;
  /** One sentence for the UI and for agents, e.g. "Codex logs no API errors or retries". */
  message: string;
  /** SPEC §12.9 data-limit number (1–12), or null for an index state. */
  limit: number | null;
  /** The field or section the gap applies to, e.g. `episode.wallUs` or `attempts[2].result.tail`. */
  field?: string;
  /** Items affected or left out, when countable. */
  count?: number;
}

// ---------------------------------------------------------------------------
// Rows of the schema-4 tables (SPEC §12.3.1). One interface per table.

/** `steps`: one model response with its calls and their results (SPEC §12.3.2). */
export interface StepRow {
  /** `<sid>#step:<n>` */
  id: string;
  sessionId: string;
  turnId: string | null;
  /** 1-based, in seq order within the session. */
  n: number;
  /** The step's llm span; null for a Codex trailing step (calls after the turn's last usage). */
  llmSpanId: string | null;
  startTs: number;
  endTs: number | null;
  /** tokens.input of the step's usage: the context size the model saw. */
  ctxTokens: number | null;
  ctxWindow: number | null;
  /** `logged:tokens.context_window` (Codex) or `inferred:ctx-window@1` (Claude: 1M if the session ever exceeds 200k, else 200k). */
  ctxWindowSrc: Prov | null;
  tokOut: number | null;
  /** tokens.uncached of the step's usage (new prompt tokens). */
  tokUncached: number | null;
  nCalls: number;
  /** Calls whose result has a `failure`-tier row. */
  nFail: number;
  /** Claude `logged:llm.latency_ms`; Codex `derived:ts-gap`. */
  modelUs: number | null;
  modelSrc: Prov | null;
  /** Union of the step's tool spans, including any approval wait (SPEC §12.9 limit 2). */
  toolUs: number | null;
  /** Trace text, at most 200 characters: Claude Bash input.description, else the step's first line of text. */
  intent: string | null;
  /** `logged:tool.input.description` or `derived:first-text-line`; null with intent null means "not logged". */
  intentSrc: Prov | null;
  /** A compaction happened between the previous step and this one. */
  compactionBefore: boolean;
  /** context.attachment events injected before this step, by attrs.context.type (context lane, P1); null until P1 fills it. */
  attachments: Record<string, number> | null;
  /** `logged:llm.message_id` (Claude), `derived:next-usage` (Codex), `inferred:cross-turn@1` or `inferred:trailing@1`. */
  segSrc: Prov;
}

/** `step_events`: the step an event belongs to. */
export interface StepEventRow {
  rid: number;
  stepId: string;
  sessionId: string;
}

/** `failures`: one row per event that carries a failure signal of any tier (SPEC §12.3.3). */
export interface FailureRow {
  /** The event with the evidence: tool.result, tool.exec, llm.error, llm.refusal, hook.run or permission.decision. */
  rid: number;
  sessionId: string;
  turnId: string | null;
  stepId: string | null;
  /** The call event of a tool result (its input and target key); null for api and hook rows. */
  callRid: number | null;
  ts: number;
  tier: FailureTier;
  source: FailureSource;
  /** The tier rule that fired: `flag@1`, `inner@1`, `traceback@1`, `benign-exit@1`, `process-running@1`, ... */
  rule: RuleId;
  family: FailureFamily;
  class: FailureClass;
  /** `sig_<hex12>` (SPEC §12.4). */
  sigId: string;
  /**
   * SPEC §12.3.4, e.g. `sh:git status`, `edit:/abs/path`, `mcp:server.tool`, `api` (trace text). A call that changes
   * several files (apply_patch) has one key: `edit:` of the file its error names, else of its first file.
   */
  targetKey: string;
  exitCode: number | null;
  /** `logged:tool.exit_code` or `parsed:exit-line`. */
  exitSrc: Prov | null;
  /** The line the signature rule (SPEC §12.4 step 2) picked, before placeholders; trace text, at most 300 characters. */
  errorLine: string | null;
  /** Null for benign and deferred rows: only failure and suspect rows open or join episodes. */
  episodeId: string | null;
  /** 1-based attempt number inside the episode. */
  attempt: number | null;
}

/** `episodes`: same-target failures within one turn until the first ok call with that key in a later step (SPEC §12.3.5). */
export interface EpisodeRow {
  /** `<sid>#ep:<event id of the opening failure row>`, e.g. `cx:0190…a1#ep:s_3f9a0c1b2d4e:812`. Stable across re-parses. */
  id: string;
  sessionId: string;
  rootId: string;
  turnId: string | null;
  /** Trace text. */
  targetKey: string;
  /** Signature of the opening failure. */
  sigId: string;
  family: FailureFamily;
  class: FailureClass;
  /**
   * `failure` when any attempt is a failure-tier row, else `suspect`. The tier facet filters on it, so `tier=failure`
   * keeps an episode that a suspect row opened and a failure row continued. nAttempts counts attempts of both tiers.
   */
  tier: FailureTier;
  openerRid: number;
  /** The last failing attempt. */
  lastRid: number;
  /** The ok call that closed it; null when it did not close in the turn. */
  closerRid: number | null;
  nAttempts: number;
  firstStep: string | null;
  lastStep: string | null;
  nSteps: number;
  startTs: number;
  /** Newest evidence: the closing call's result, else the last attempt. */
  endTs: number;
  /** First failing call to the result of the closing call, or of the last attempt. */
  wallUs: number | null;
  wallSrc: Prov | null;
  tokOut: number | null;
  /** Input tokens processed over the episode's steps: an upper bound on recovery cost. */
  tokInUb: number | null;
  outcome: EpisodeOutcome;
  /** `derived:outcome`; `inferred:<rule>@<v>` where a rule guessed (the actor of an interrupt in a child session). */
  outcomeSrc: Prov;
  /** Set for `interrupted`. */
  actor: EpisodeActor | null;
  /** ≥5 attempts with one signature. */
  loop: boolean;
  /** ≥3 identical attempts with no edit between them. */
  blind: boolean;
  /** Next main-session prompt starts like a correction (`inferred:correction@1`); a secondary chip only. */
  corrected: boolean;
  /** The turn is unattended (TurnRollupRow.unattended). */
  unattended: boolean;
  /** Attention section (EPISODE_SECTIONS rules). Event-determined, so it is stored and indexed. */
  section: EpisodeSection;
}

/** `episode_attempts`: attempt n of an episode and the transition from attempt n−1 (null for n = 1). */
export interface EpisodeAttemptRow {
  episodeId: string;
  n: number;
  sessionId: string;
  /** The failure row's event. */
  rid: number;
  stepId: string | null;
  gapUs: number | null;
  gapSteps: number | null;
  changeClass: ChangeClass | null;
  /** 1 − levenshtein / maxlen, 0..1. */
  similarity: number | null;
  /** Edit, write or patch `changes` rows between attempt n−1 and n. */
  edits: number;
  /** A `read:` of the same path between the attempts. */
  reread: boolean;
  /** Same step as attempt n−1. */
  parallel: boolean;
}

/** `signatures`: one row per signature (SIG_VERSION) over all failure rows (SPEC §12.4). Status is computed on read (SIGNATURE_STATUSES). */
export interface SignatureRow {
  /** `sig_` + sha1(family + "\n" + text)[0:12] */
  id: string;
  /** Normalized, at most 88 code points. Trace text: placeholders replace paths and quoted strings, other words stay. */
  text: string;
  family: FailureFamily;
  class: FailureClass;
  /** The signature rule that made it (SIG_VERSION, `sigv2`) */
  sigv: string;
  /** Failure rows. */
  n: number;
  nSessions: number;
  /** Episodes opened under the signature; parallel-ok and open episodes count in neither rate. */
  nEpisodes: number;
  nRecovered: number;
  nUnrecovered: number;
  /** Sum of the episodes' wallUs that did not recover. */
  wallLostUs: number;
  firstTs: number;
  lastTs: number;
  /**
   * Turns that started after lastTs, of the agent and tool kind of the newest failure row, that hold a call of that
   * tool kind. Any new turn can change it, so every pass recounts it for every signature.
   */
  turnsSinceLast: number;
  /**
   * First occurrence after the newest dormant gap in the history (a gap of ≥ 14 days between two occurrences during
   * which ≥ 20 such turns started); null when there is none.
   */
  regressedTs: number | null;
  agents: AgentKind[];
  /** nSessions × unrecovered rate (SPEC §12.4 step 6). */
  rank: number;
  /** Failure rows per tier. */
  tierCounts: Partial<Record<FailureTier, number>>;
}

/** What an open turn's newest own event waits on; a `stall` alarm never fires while it is `process` or `question`. */
export type TurnWaiting = 'process' | 'question' | 'tool';

/** `turn_rollup`: one row per turn span (SPEC §12.3.6). */
export interface TurnRollupRow {
  turnId: string;
  sessionId: string;
  rootId: string;
  /** 1-based place of the turn in its session's event order: "turn 6" (StepPosition.inTurn.turn, the Steps T6 row). */
  n: number;
  /** attrs.turn.origin as logged (human, task_notification, sdk, ...). */
  origin: string | null;
  startTs: number;
  endTs: number | null;
  /** Newest own event of the turn: stall and alarm expiry are measured from it. */
  lastTs: number;
  /** The turn has not ended. */
  open: boolean;
  /** For an open turn: a poll or wait of a running process, a question without its answer, or a call without its result. */
  waiting: TurnWaiting | null;
  impact: TurnImpact;
  /** The episode id or delegation span id that set the impact; null for clean. */
  impactBasis: string | null;
  nSteps: number;
  nEpisodes: number;
  nUnrecovered: number;
  claimEvidence: ClaimEvidence | null;
  /** Role is not main, or a Codex goal is active, or approval is `never` with no prompt in the last 3 turns (SPEC §12.3.5). */
  unattended: boolean;
  wallUs: number | null;
  /** The turn span's durSrc (`logged:task_complete.duration_ms`, `derived:ts-gap`). */
  wallSrc: Prov | null;
  /** Tool kinds of the turn's own tool calls, space-separated and sorted (signature dormancy counts turns by kind); null: none. */
  callKinds: string | null;
}

/** `session_rollup`: one row per derived session; the sidebar marks and find_runs read it (SPEC §12.7 Entry). */
export interface SessionRollupRow {
  sessionId: string;
  rootId: string;
  /** Worst impact over the session's own turns, and its index in TURN_IMPACTS (0 = failed), for ordering. */
  worstImpact: TurnImpact;
  worstRank: number;
  /** The turn that set it; null when every turn is clean. */
  worstTurn: string | null;
  nTurns: number;
  nSteps: number;
  nEpisodes: number;
  /** Episodes in the `blocked` and `unrecovered` sections. */
  nAttention: number;
  /** Delegations this session spawned with `silent`. */
  silentChildren: number;
  /** Claims with evidence in UNVERIFIED_CLAIMS. */
  unverifiedClaims: number;
  unattended: boolean;
  /** Newest own event. */
  lastTs: number;
}

/** `delegations`: one row per spawn (SPEC §12.3.7). */
export interface DelegationRow {
  /**
   * The spawn span id (Agent, Task, spawn_agent tool span). Workflow agents share their workflow's span, so theirs is
   * `<workflow span id>:<agent id>`. GET /api/delegations/:id also accepts the child session id.
   */
  id: string;
  /** The parent session. */
  sessionId: string;
  parentTurn: string | null;
  parentStep: string | null;
  childSession: string | null;
  kind: DelegationKind;
  /** Trace text: the task given to the child, at most 300 code points; a cut ends in `…`. */
  taskExcerpt: string | null;
  /** Code points of the whole task: "Show all (2,310 characters)"; absent before analysis version 14. */
  taskChars?: number | null;
  outcome: DelegationOutcome;
  /** `logged:workflow`, `logged:task-notification`, `parsed:wait-status` or `derived:child`. */
  outcomeSrc: Prov | null;
  /** Worst impact over the child's turns. */
  childImpact: TurnImpact | null;
  /**
   * A failed or blocked child only: the result the parent saw is flagged or matches the failure lexicon
   * (`inferred:parent-told@2`). Null when the child did not fail or the parent saw no result.
   */
  parentTold: boolean | null;
  /** The child failed or was blocked and the parent was not told. */
  silent: boolean;
  /** The event whose result the parent saw: the Agent result (Claude) or the first wait result naming the child (Codex). */
  resultRid: number | null;
  tokInTree: number | null;
  tokOutTree: number | null;
  parentWaitUs: number | null;
  startTs: number;
  endTs: number | null;
}

/** `processes`: a background process keyed by (session, N); `seq` separates reuse of the same N (SPEC §12.3.8). */
export interface ProcessRow {
  /** `<sid>#proc:<N>:<seq>`, seq = seq of the opening event. */
  id: string;
  sessionId: string;
  /** N: the Codex session id or the Claude background task id. */
  procKey: string;
  openRid: number;
  closeRid: number | null;
  /** Program of the opening command (the `sh:` part of its target key). */
  program: string | null;
  nPolls: number;
  nInputs: number;
  exitCode: number | null;
  /** `parsed:exit-line` ("Process exited with code N") or `logged:...`. */
  exitSrc: Prov | null;
  status: ProcessStatus;
  startTs: number;
  endTs: number | null;
}

/** `process_events`: an event's role in a process stream. */
export interface ProcessEventRow {
  rid: number;
  processId: string;
  sessionId: string;
  role: ProcessEventRole;
}

/** `changes`: one row per (event, path). */
export interface ChangeRow {
  rid: number;
  path: string;
  sessionId: string;
  turnId: string | null;
  stepId: string | null;
  ts: number;
  op: ChangeOp;
  /** `logged:Edit`, `parsed:apply_patch`, `parsed:parsed_cmd`, `logged:edited_text_file`, `inferred:shell-mention@1`, ... */
  src: Prov;
  added: number | null;
  removed: number | null;
  /** The path is outside the session's cwd. */
  outsideCwd: boolean;
}

/** `interventions` (SPEC §12.3.8). `nearEpisode` records association only, never a cause. */
export interface InterventionRow {
  rid: number;
  sessionId: string;
  turnId: string | null;
  stepId: string | null;
  ts: number;
  kind: InterventionKind;
  actor: InterventionActor;
  actorSrc: Prov;
  /** `question`: the time until the answer. */
  waitUs: number | null;
  /** An episode within 3 calls. */
  nearEpisode: string | null;
}

/** `claims`: a turn whose final llm.text claims success (SPEC §12.3.8, `inferred`). */
export interface ClaimRow {
  turnId: string;
  sessionId: string;
  /** The final llm.text event. */
  finalRid: number;
  ts: number;
  evidence: ClaimEvidence;
  /** `claim@1` */
  rule: RuleId;
  /** The turn's last test run; for `no-test-in-turn`, the latest earlier run in the session (or null). */
  testRid: number | null;
  lastEditRid: number | null;
  /** The claim pattern that matched, e.g. `tests? pass` (not trace text). */
  pattern: string;
}

/**
 * `alarms` (SPEC §12.3.9): every instance of every stored kind on every turn, a pure function of the events
 * (ALARM_KINDS says when each holds and clears). `stall` rows are never stored; queries build them on read.
 */
export interface AlarmRow {
  /** `<turn id>#alarm:<kind>:<event id of the first evidence>`; for `stall`, of the turn's newest own event. Stable across re-parses. */
  id: string;
  sessionId: string;
  turnId: string;
  kind: AlarmKind;
  /** `consecutive@1`, `blocker@1`, ... */
  rule: RuleId;
  /** First evidence. */
  firstTs: number;
  /** Newest own event of the turn while the alarm held: the turn's newest own event while it still holds. */
  lastTs: number;
  /** The episode it concerns: the looping episode, the newest failure's episode (`consecutive`, `blocker`), or the child's worst unrecovered episode (`silent-child`). */
  episodeId: string | null;
  /** `silent-child`: the delegation. */
  delegationId: string | null;
  /** The kind may notify (NOTIFYING_ALARMS). */
  notify: boolean;
  /** The event that cleared it, or the turn's end; null while it holds at the turn's newest own event. */
  clearedTs: number | null;
}

/** An alarm as every response shows it: the row plus its state on read (ALARM_STATES). */
export interface AlarmItem extends AlarmRow {
  state: AlarmState;
}

/** P1 (module C, SPEC §12.7 Diagnostics): groups that join ExpertGroup when Diagnostics links failure items to episodes. */
export type DerivedExpertGroup = 'loop' | 'silent-child' | 'audit';

// ---------------------------------------------------------------------------
// Payloads assembled from the rows (SPEC §12.5). Shared by the HTTP API, the CLI and MCP.

export interface TimeBucket {
  name: TimeBucketName;
  us: number;
  /** Logged and derived parts of `us` (SPEC §12.3.9: each bucket reports both). */
  loggedUs: number;
  derivedUs: number;
}

/** Wall time split by bucket for a turn or a session (computed on read, cached per session). */
export interface TimeBreakdown {
  wallUs: number | null;
  buckets: TimeBucket[];
  /** Time no bucket claims. Never counted as model time. Null when time is not derived. */
  unattributedUs: number | null;
  /** Between turns: waiting for a human prompt, and auto-continued turns. Null for a single turn without a predecessor. */
  humanGapUs: number | null;
  continuationUs: number | null;
}

/**
 * One row of the Failures queue (`GET /api/failures/queue`) and of the Run report's `attention`. Selecting a row
 * fills the Lens frame from (api.ts): `episode` → episode(); `claim` → claim(); `delegation` → delegation(); `alarm`
 * → its episode, else its delegation, else Session · Steps at its turn; `signature` → signature(); `session` →
 * runReport().
 */
export interface QueueRow {
  kind: QueueRowKind;
  /** Episode id, alarm id, delegation span id, claim turn id, signature id or session id. */
  id: string;
  /** Set when grouped by attention. */
  section: AttentionSection | null;
  /** Newest evidence. */
  ts: number;
  sessionId: string | null;
  turnId: string | null;
  /** Session title (trace text). */
  title: string | null;
  agent: AgentKind | null;
  role: SessionRole | null;
  /** Target key (trace text). */
  target: string | null;
  /** Signature text (trace text) and id. */
  signature: string | null;
  signatureId: string | null;
  family: FailureFamily | null;
  tier: FailureTier | null;
  /** Episode outcome, delegation outcome, claim evidence or alarm state, by `kind`. */
  outcome: EpisodeOutcome | DelegationOutcome | ClaimEvidence | AlarmState | null;
  outcomeSrc: Prov | null;
  alarmKind: AlarmKind | null;
  signatureStatus: SignatureStatus | null;
  impact: TurnImpact | null;
  attempts: number | null;
  wallUs: number | null;
  wallSrc: Prov | null;
  /**
   * Sessions with an episode of the signature: every one in the index on episode and alarm rows (as the Lens Seen
   * before), the members' own on a signature row, so a signature row reads "{members} episodes in {seenSessions}
   * sessions" over one scope.
   */
  seenSessions: number | null;
  /** The run is possibly running. */
  live: boolean;
  unattended: boolean;
  /** Members of a group row (episodes of a signature, session or delegation); null for single items. */
  members: number | null;
  /** First attempt's error line (trace text). */
  errorLine: string | null;
  /**
   * Rows of kind `claim`: the sentence of the turn's final text that claims success (trace text, at most 120
   * characters) and the claim lexicon entry it matched (ClaimRow.pattern). Absent for other kinds.
   */
  quote?: string | null;
  pattern?: string | null;
  /** Rows of kind `signature`: the sparkline (the last 30 local days). Null for other kinds. */
  daily: DailyCounts | null;
}

/** A word diff between two inputs, or one line of a file diff (`text` is trace text). */
export interface DiffOp {
  op: 'eq' | 'add' | 'del';
  text: string;
}

/** An observed fix (SPEC §12.4): "observed in past recoveries, not verified". */
export interface ObservedFix {
  kind: 'edit' | 'install' | 'read' | 'other';
  /** Token diff from the last failed input to the closing call, e.g. `+PYTHONPATH=` or `+uv run` (trace text). */
  pattern: string;
  n: number;
  /** Recovered episodes the pattern was looked for in. */
  of: number;
  exampleEpisode: string;
  verified: false;
}

/** What kind of help a family needs (MCP lookup_error, Lens environment advice). */
export type AdviceKind = 'environment' | 'dependency' | 'code' | 'harness';

/** Per-day counts for sparklines: n[i] is the day start + i (local days). */
export interface DailyCounts {
  /** Local midnight of the first day, µs. */
  start: number;
  n: number[];
}

export interface LensAttempt {
  n: number;
  /** The failure row's event (result). */
  eventId: string;
  callEventId: string | null;
  ts: number;
  tier: FailureTier;
  /** Session-wide step number. */
  step: number | null;
  gapUs: number | null;
  gapSteps: number | null;
  /** The call input (trace text). */
  input: string | null;
  changeClass: ChangeClass | null;
  inputDiff: DiffOp[] | null;
  editsBetween: { path: string; added: number | null; removed: number | null; eventId: string }[];
  reread: boolean;
  /** Ran in the same step as the previous attempt (grouped in the ladder). */
  parallel: boolean;
  /** Deferred polls folded into this attempt. */
  deferredPolls: number;
  result: {
    exitCode: number | null;
    exitSrc: Prov | null;
    /** The line the signature came from (trace text). */
    errorLine: string | null;
    /** Output head and tail (trace text), each cut to the requested length. */
    head: string | null;
    tail: string | null;
    /** False when the index kept no tail for this output (SPEC §12.9 limit 1). */
    tailAvailable: boolean;
  };
}

export type LensCloseKind = 'recovered' | 'parallel-ok' | 'recovered-later' | 'pivoted' | 'interrupted' | 'final-message' | 'open';

/**
 * Where a step sits (DESIGN.md §9 "Step position"), computed once by derived-queries for the Lens, the Steps rows, the
 * Events detail and the reports, so every reader phrases it the same way.
 */
export interface StepPosition {
  /** Session-wide step number (StepRow.n): the Steps "No." column and LensAttempt.step. */
  n: number;
  /** Steps in the session. */
  of: number;
  /** Its place in its turn, and the turn's number in the session (TurnRollupRow.n; null before analysis version 13). */
  inTurn: { n: number; of: number; turn: number | null } | null;
  /** The canonical phrase: "step 46 · 5 of 6 in turn 6"; "step 46" outside a turn. A label that starts with it reads "Step 46 · …". */
  text: string;
  /** The phrase right after a turn crumb: "step 46 · 5 of 6". */
  crumb: string;
}

/** Where an item happened: the Where section of every Lens frame (episode, claim, delegation). */
export interface LensWhere {
  /** run › child › turn › step; labels are session titles and prompt excerpts (trace text). */
  breadcrumb: { kind: 'run' | 'session' | 'turn' | 'step'; id: string; label: string | null }[];
  /**
   * The step, when it belongs to a turn: `session` is its session-wide number (StepRow.n: the Steps "No." column and
   * LensAttempt.step; analysis version 11 and later), `n` of `of` its place within the turn.
   */
  step: { session?: number; n: number; of: number } | null;
  /** The step's position with its canonical phrase (supersedes `step`, which stays for older clients); absent from older servers. */
  position?: StepPosition | null;
  model: string | null;
  posture: { approval: string | null; sandbox: string | null; permissionMode: string | null; src: Prov | null };
  ctx: { tokens: number | null; window: number | null; windowSrc: Prov | null };
  /** Spawn chain from the run root to this session. */
  delegationPath: { spanId: string; sessionId: string; outcome: DelegationOutcome | null }[];
  live: boolean;
}

/** The Failure Lens ("Observed chain"), `GET /api/episodes/:id` and MCP get_episode (SPEC §12.5). */
export interface LensPayload {
  episode: {
    id: string;
    /** Trace text. */
    targetKey: string;
    tier: FailureTier;
    signature: { id: string; text: string; family: FailureFamily; class: FailureClass; sigv: string };
    outcome: EpisodeOutcome;
    outcomeSrc: Prov;
    actor: EpisodeActor | null;
    loop: boolean;
    blind: boolean;
    corrected: boolean;
    nAttempts: number;
    nSteps: number;
    wallUs: number | null;
    wallSrc: Prov | null;
    tokOut: number | null;
    tokInUpperBound: number | null;
    unattended: boolean;
  };
  where: LensWhere;
  /** `text` is trace text: the step's intent (StepRow.intent). */
  intent: { text: string | null; src: Prov | null };
  attempts: LensAttempt[];
  close: {
    kind: LensCloseKind;
    eventId: string | null;
    /**
     * recovered: the recovering call (`text` = its input) and the edits before it; pivoted: the next calls;
     * interrupted: the actor; final-message: the final text (trace text) and its claim.
     */
    detail: {
      text: string | null;
      actor: EpisodeActor | null;
      calls: { eventId: string; tool: string | null; target: string | null; tier: FailureTier | null }[];
      claim: ClaimEvidence | null;
      edits: { path: string; added: number | null; removed: number | null; eventId: string }[];
    };
  };
  /**
   * The signature's episodes in the whole index: "14 episodes in 11 sessions · 6 of 14 recovered (43%)". The counts
   * are absent before analysis version 14.
   */
  seenBefore: {
    episodes?: number;
    /** Sessions with an episode of the signature (QueueRow.seenSessions of its episode rows). */
    sessions: number;
    /** Closed episodes (recovered + unrecovered); parallel-ok and open episodes count in neither. */
    closed?: number;
    recovered?: number;
    unrecovered?: number;
    /** recovered / closed. */
    recoveredRate: number | null;
    firstTs: number;
    lastTs: number;
    status: SignatureStatus;
    daily: DailyCounts;
    fixes: ObservedFix[];
    /** Set for blocked and dependency families. */
    advice: AdviceKind | null;
  };
  /**
   * Association only (SPEC §12.7 Lens section 8): interventions within 3 calls, child episodes, the parent's result.
   * `label` is trace text; `rule` names the association rule (`near-3-calls@1`).
   */
  related: { kind: 'intervention' | 'child-episode' | 'parent-result' | 'delegation'; id: string; eventId: string | null; label: string | null; rule: RuleId }[];
  gaps: Gap[];
}

/** The Run report (SPEC §12.5): combines the derived tables, adds no heuristics. Session header, `agentshark why`, MCP. */
export interface RunReport {
  run: {
    /** Root session id. */
    root: string;
    /** The session asked for (the root or a descendant). */
    session: string;
    agent: AgentKind;
    /** Root session title (trace text). */
    title: string | null;
    start: number | null;
    end: number | null;
    status: RunStatus;
    unattended: boolean;
  };
  /** Report covers evidence at or after this time (µs); null for the whole run. */
  since: number | null;
  turns: { total: number; byOrigin: Record<string, number> };
  steps: { total: number; withFailure: number };
  impact: Record<TurnImpact, number>;
  /** At most 20 queue rows, attention order. */
  attention: QueueRow[];
  /** At most 5, by rank. */
  signatures: { id: string; text: string; family: FailureFamily; n: number; sessions: number; status: SignatureStatus }[];
  delegations: { total: number; silent: number; byOutcome: Partial<Record<DelegationOutcome, number>> };
  claims: { byEvidence: Partial<Record<ClaimEvidence, number>>; unverified: number };
  interventions: Partial<Record<InterventionKind, number>>;
  time: TimeBreakdown;
  context: { peakTokens: number | null; window: number | null; windowSrc: Prov | null; compactions: number };
  changes: { files: number; added: number; removed: number; shellMentions: number };
  alarms: AlarmItem[];
  stall: { turnOpen: boolean; stalledForS: number | null };
  gaps: Gap[];
  /** Seconds since meta.last_change_at (the last committed index or analysis change); null when the key is absent. */
  indexAgeS: number | null;
}

/** Follow streams (SPEC §12.7): Tool Call, Delegation, Process, File. */
export type FollowKind = 'call' | 'delegation' | 'process' | 'file';

export type FollowRole =
  // call
  | 'call' | 'result' | 'persisted' | 'exec'
  // delegation
  | 'task' | 'child-step' | 'child-failure' | 'child-final' | 'parent-saw' | 'parent-next'
  // process
  | 'open' | 'poll' | 'input' | 'output' | 'deferred' | 'close' | 'error' | 'kill'
  // file
  | 'read' | 'edit' | 'write' | 'patch' | 'external' | 'backup' | 'shell-mention'
  // any stream: the index cut text here, or raw bytes are gone
  | 'marker';

export interface FollowItem {
  /** Null for a marker. */
  eventId: string | null;
  ts: number | null;
  role: FollowRole;
  /** One line (trace text). */
  excerpt: string | null;
  /** Content head and tail (trace text). */
  head: string | null;
  tail: string | null;
  /** The task item: code points of the whole task that `head` starts and `excerpt` cuts ("Show all (2,310 characters)"). */
  chars?: number | null;
  /** `GET /api/changes/:eventId/diff` can load a diff from raw bytes (edits, patches, external edits). */
  diffAvailable: boolean;
  /** Why a diff or bytes are unavailable, or what a marker marks ("shell edits are not tracked"). */
  reason?: string;
  sessionId?: string;
  stepId?: string | null;
  path?: string;
  added?: number | null;
  removed?: number | null;
  exitCode?: number | null;
  exitSrc?: Prov | null;
  tier?: FailureTier | null;
  episodeId?: string | null;
  /** File stream: the edit falls between two failed attempts of an episode. */
  betweenAttempts?: boolean;
}
