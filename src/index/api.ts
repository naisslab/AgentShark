// Read-side contract between the index (src/index/queries.ts implements it) and the server/CLI.
// Every HTTP route in SPEC §6 maps to exactly one method here; the JSON body is the return value.

import type {
  AdviceKind, AgentKind, AlarmItem, AlarmKind, AlarmState, AlarmThresholds, AttentionSection, ChangeOp, ClaimEvidence, ClaimRow,
  ConversationItem, DailyCounts, DelegationOutcome, DerivedExpertGroup, DelegationRow, DiffOp, EpisodeOutcome, EpisodeRow, EpisodeSection, EventRow,
  ExpertGroup, ExpertSeverity, FailureClass, FailureFamily, FailureSource, FailureTier, FollowItem, FollowKind, Gap, HealthReport,
  InterventionActor, InterventionKind, InterventionRow, LensPayload, LensWhere, ObservedFix, StepPosition, ProcessEventRole, ProcessRow,
  ProcessStatus, Prov, QueueGroup, QueueRow, RuleId, RuleInfo, RunReport, RunStatus, SessionRole, SessionRow, SignatureStatus,
  SpanKind, SpanRow, TimeBreakdown, TimeBucket, TimeBucketName, TokenUsage, ToolKindTag, TurnImpact,
} from '../model/types.ts';

/** What a capture file says about itself (docs/FORMAT.md): its header, stream completeness and evidence coverage. */
export interface CaptureInfo {
  integrity?: import('../capture/reader.ts').CaptureIntegrity;
  analysis?: import('../capture/reader.ts').CaptureLoadResult['analysis'];
  path: string;
  /** The capture header record: created, tool, host, scope, options. */
  header: Record<string, unknown> | null;
  /** When the capture was written (µs), from the header. */
  createdAt: number | null;
  /** The stream ended with its end record. A complete stream can still miss evidence: see coverage. */
  complete: boolean;
  coverage: CaptureCoverage;
  /** When this server loaded the capture into its index (µs). */
  loadedAt: number | null;
}

export interface CaptureCoverage {
  /** Source lines whose raw bytes could not be read when the capture was written (file deleted or changed). */
  rawUnavailable: number;
  rawUnavailableBySource: Record<string, number>;
  /** Raw lines left out on purpose (--no-raw). */
  rawOmitted: boolean;
  sidecarsOmitted: { path: string; role: string; reason: 'missing' | 'too-large' | 'credential' | 'unreadable' | 'disabled' }[];
  /** Captures written before coverage was recorded: the numbers above are unknown, not zero. */
  known: boolean;
}

/** Population that a statistic or diagnostics response describes. */
export interface StatsScope {
  kind: 'view' | 'all';
  viewId: string | null;
  events: number;
}

export interface FieldInfo {
  name: string;
  type: 'string' | 'int' | 'duration' | 'time' | 'bool' | 'enum' | 'json';
  description: string;
  values?: string[];
}

export interface FilterCheck {
  ok: boolean;
  error?: { message: string; start: number; end: number };
  warning?: string;
}

export interface InfoResult {
  version: string;
  mode: 'live' | 'capture';
  indexPath: string;
  capturePath?: string;
  counts: { sources: number; sessions: number; events: number; spans: number; expert: number };
  firstTs: number | null;
  lastTs: number | null;
  /** `since` (µs): during a staged run, every changed file written after it is indexed (SPEC §5.1). */
  indexing: { running: boolean; done: number; total: number; currentPath?: string; since?: number; lastRunAt: number | null; lastRunMs: number | null };
  /** Whether the server re-indexes when source files change, and how often it checks. Disabled in capture mode. */
  watch: { enabled: boolean; intervalMs: number | null };
  /** End of the last index run that finished without an error (µs), and the error of the last failed run. */
  lastIndexOkAt: number | null;
  lastIndexError: string | null;
  /** End of the last index run that changed sessions (µs). */
  lastChangeAt: number | null;
  /** Capture mode only. */
  capture?: CaptureInfo;
  /** Schema 4: state of the analysis pass (SPEC §12.3.1). Absent from servers that predate it. */
  analysis?: AnalysisStatus;
}

export interface SessionQuery {
  /** These sessions only (a batch refresh after index-done); other criteria still apply. */
  ids?: string[];
  agent?: AgentKind;
  /** Case-insensitive substring of the id, title, cwd or project, over every indexed session. */
  q?: string;
  from?: number;
  to?: number;
  role?: string;
  state?: string;
  limit?: number;
  offset?: number;
}

export interface SessionDetail {
  session: SessionRow & { meta: Record<string, unknown>; enriched: Record<string, unknown> };
  children: SessionRow[];
  turns: SpanRow[];
  sources: { id: string; path: string; kind: string }[];
}

export type ViewSort = 'ts' | 'seq' | 'dur' | 'tokIn' | 'tokOut' | 'kind' | 'tool' | 'session';

export interface ColorRule {
  id: string;
  filter: string;
}

export interface ViewSpec {
  filter?: string;
  sessions?: string[];
  /** Include descendants (subagents) of the listed sessions. Default true. */
  descendants?: boolean;
  from?: number;
  to?: number;
  /** Row order: time (default), file order, or a column; ties fall back to time order. */
  sort?: ViewSort;
  order?: 'asc' | 'desc';
  includeInherited?: boolean;
  includeDup?: boolean;
  /** Each row reports the id of the first rule whose filter matches it (`EventRow.colorRule`). */
  colorRules?: ColorRule[];
}

export interface ViewInfo {
  viewId: string;
  count: number;
  firstTs: number | null;
  lastTs: number | null;
}

export interface Histogram {
  from: number;
  to: number;
  binUs: number;
  bins: { count: number; errors: number; tokens: number }[];
}

export interface FieldRef {
  /** Filter field that selects this value, e.g. tool.name or native.message.model. */
  field: string;
  value: string | number | boolean | null;
}

export interface EventDetail {
  event: EventRow & { attrs: Record<string, unknown>; native: unknown; raw: { source: string; path: string | null; line: number; offset: number; length: number; block: number | null } };
  span: SpanRow | null;
  /** Ancestors of `span`, outermost first (session → turn → ...). */
  spanChain: SpanRow[];
  /** Partner events: call ↔ result, other blocks of the same llm span, nested exec items. */
  related: EventRow[];
  session: SessionRow | null;
  /**
   * Scalar leaves of the document {event, attrs, native}, by JSON Pointer (/event/kind, /attrs/tool/name,
   * /native/message/model), with the filter field that matches each one.
   */
  fieldMap: Record<string, FieldRef>;
}

export interface RawResult {
  available: boolean;
  /** Legacy indexes lack fingerprints. Captured evidence has separate capture-integrity metadata. */
  verification?: 'verified' | 'unverified' | 'captured';
  /** Whole-capture integrity, independent of whether this line was embedded in it. */
  captureIntegrity?: 'verified' | 'unverified' | 'failed';
  /** Why raw bytes are unavailable (file deleted, changed since indexing, ...). */
  reason?: string;
  source: { id: string; path: string | null; line: number; offset: number; length: number };
  /** The source line; long strings are shortened to `maxString` chars with a `…[+N chars]` marker. */
  text: string;
  truncated: boolean;
  /** JSON Pointer (RFC 6901) → [start, end) character offsets into `text`. "" is the whole record. */
  ranges: Record<string, [number, number]>;
}

export interface SpanQuery {
  sessions?: string[];
  from?: number;
  to?: number;
  kinds?: SpanKind[];
  minDur?: number;
  limit?: number;
}

export interface SpanDetail {
  span: SpanRow;
  events: EventRow[];
  children: SpanRow[];
}

export interface OverviewSession {
  id: string;
  agent: AgentKind;
  role: string;
  parentId: string | null;
  title: string | null;
  project: string | null;
  start: number | null;
  end: number | null;
  nEvents: number;
  nErrors: number;
  tokOut: number;
}

export interface StatsSummary {
  scope: StatsScope;
  events: number;
  sessions: number;
  firstTs: number | null;
  lastTs: number | null;
  byAgent: { agent: string; sessions: number; events: number }[];
  tokens: TokenUsage;
  llmCalls: number;
  toolCalls: number;
  errors: number;
  loggedCostUsd: number | null;
}

export interface KindNode {
  name: string;
  count: number;
  bytes: number;
  children: KindNode[];
}

export interface ToolStat {
  tool: string;
  kind: string;
  calls: number;
  errors: number;
  /** Calls with a known duration; the percentiles, max and total cover only these. */
  durKnown: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
  total: number;
  agents: string[];
}

export interface ModelStat {
  model: string;
  calls: number;
  tokens: TokenUsage;
  cacheHitRatio: number | null;
  latencyP50: number | null;
  latencyP90: number | null;
}

/** Per-model call performance; duration percentiles are whole µs, rates are output tokens per second. */
export interface PerformanceStat {
  model: string;
  calls: number;
  latencyKnown: number;
  latencyEstimated: number;
  latencyP50: number | null;
  latencyP90: number | null;
  ttftKnown: number;
  ttftP50: number | null;
  ttftP90: number | null;
  outputRateKnown: number;
  outputRateEstimated: number;
  /** Output tokens / whole call duration, including waiting. Each call is one sample. */
  outputRateP50: number | null;
  outputRateP10: number | null;
  /** Token-weighted cache reads / inclusive input, over calls with both counts. */
  cacheHitRatio: number | null;
  cacheKnown: number;
}

/** Longest completed intervals to inspect, not a critical-path or causal diagnosis. */
export interface PerformanceBottleneck {
  spanId: string;
  sessionId: string;
  eventId: string | null;
  name: string;
  bucket: TimeBucketName;
  start: number;
  duration: number;
  estimated: boolean;
  ttft: number | null;
  cacheHitRatio: number | null;
}

/** One bin of Performance over time (SPEC §6): busy time by bucket in µs, and the calls that started in it. */
export interface PerformanceBin {
  t: number;
  busy: Partial<Record<TimeBucketName, number>>;
  calls: number;
  tools: number;
  failed: number;
  latencyP50: number | null;
  latencyP90: number | null;
  ttftP50: number | null;
  ttftP90: number | null;
  rateP50: number | null;
  rateP10: number | null;
  cacheHitRatio: number | null;
  inputP50: number | null;
}

/** Busy segments of a view, binned; the time between segments is idle and clients collapse it. */
export interface PerformanceTimeline {
  binUs: number;
  segments: { start: number; end: number }[];
  bins: PerformanceBin[];
  busy: Partial<Record<TimeBucketName, number>>;
}

export interface PerformanceResult {
  scope: StatsScope;
  /** Every call of the view; `model` is ''. */
  overall: PerformanceStat;
  models: PerformanceStat[];
  bottlenecks: PerformanceBottleneck[];
  timeline: PerformanceTimeline;
}

export type IoMetric = 'events' | 'errors' | 'tokens.input' | 'tokens.output' | 'tool.calls' | 'llm.calls' | 'latency.mean' | 'ttft.mean' | 'output.rate.mean' | DerivedIoMetric;

/**
 * SPEC §12.7 Statistics: I/O graph metrics over the derived tables. `context.tokens` is the peak `steps.ctx_tokens`
 * per bin (sparse: a bin without a step has no value); `failures.<tier>` counts failure rows of that tier. A view holds
 * a step or a failure row when it holds one of its events. A schema-3 index answers an empty series.
 */
export type DerivedIoMetric = 'context.tokens' | 'failures.failure' | 'failures.suspect' | 'failures.benign' | 'failures.deferred';

export interface IoSeries {
  scope: StatsScope;
  binUs: number;
  metric: IoMetric;
  /** `n` counts valid samples for performance means, so clients can merge bins without averaging averages. */
  series: { t: number; v: number; n?: number }[];
}

export interface PairStat {
  a: string;
  b: string;
  count: number;
  dur: number;
  errors: number;
}

export interface ExpertQuery {
  viewId?: string;
  session?: string;
  severity?: ExpertSeverity;
  group?: ExpertGroup | DerivedExpertGroup;
  limit?: number;
}

export interface ExpertResult {
  scope: StatsScope;
  groups: {
    severity: ExpertSeverity;
    /** On an analysed index (schema 4) the groups of DerivedExpertGroup join, with severity `warn` and negative item ids. */
    group: ExpertGroup | DerivedExpertGroup;
    count: number;
    /** `episodeId` (schema 4): the episode a failure item belongs to, for the Diagnostics link; absent on a schema-3 index. */
    items: { id: number; session: string | null; event: string | null; span: string | null; message: string; ts: number | null; episodeId?: string | null }[];
  }[];
}

export interface SourceRow {
  id: string;
  agent: string;
  kind: string;
  path: string;
  size: number;
  mtimeMs: number;
  lines: number;
  malformed: number;
  unknown: number;
  skipped: number;
  inherited: number;
  dialect: string | null;
  status: string;
  error: string | null;
  existsNow: boolean;
  indexedAt: number | null;
  parseMs: number | null;
}

export interface FileResult {
  contentType: string;
  data: Buffer;
}

export interface SourcesResult {
  /** 'captured': the evidence inside the open capture; 'local': this machine's agents, settings and index. */
  scope: 'local' | 'captured';
  /** Machine the report describes: this host, or the host named in the capture header. */
  host: string | null;
  /** Capture mode: when the capture was written (µs). */
  capturedAt?: number | null;
  agents: HealthReport[];
  sources: SourceRow[];
}

export interface IndexQueries {
  info(): InfoResult;
  fields(): FieldInfo[];
  validateFilter(filter: string): FilterCheck;
  listSessions(q: SessionQuery): { total: number; sessions: SessionRow[] };
  getSession(id: string): SessionDetail | null;
  /**
   * Throws FilterError (src/filter/compile.ts) on an invalid filter, and QueryError 400 `color_rule` (with `ruleId`,
   * `start`, `end`) on an invalid coloring rule.
   */
  createView(spec: ViewSpec): ViewInfo;
  /** `columns`: filter field names whose values each row reports in `extra`. */
  viewRows(viewId: string, offset: number, limit: number, columns?: string[]): EventRow[];
  locate(viewId: string, eventId: string): number | null;
  /** Row number of the next (or previous) row after `from` whose full text contains `q`; null when there is none. */
  find(viewId: string, q: string, from: number | undefined, dir: 'next' | 'prev'): number | null;
  histogram(viewId: string, bins: number, from?: number, to?: number): Histogram;
  getEvent(id: string): EventDetail | null;
  getRaw(id: string, maxString?: number): Promise<RawResult>;
  listSpans(q: SpanQuery): { spans: SpanRow[]; truncated: boolean };
  getSpan(id: string): SpanDetail | null;
  overview(q: { from?: number; to?: number; agent?: AgentKind }): { sessions: OverviewSession[] };
  /** `next` is an opaque cursor to pass back as `after`: the last seq, or a row offset for a multi-file session. */
  conversation(sessionId: string, after?: number, limit?: number): { items: ConversationItem[]; next: number | null };
  // Statistics take a view id, or GLOBAL_VIEW ('global') for every indexed event that is not a hidden copy. An
  // absent id also means global (kept for older clients). An unknown or expired id throws QueryError 404 `view_expired`.
  statsSummary(viewId?: string): StatsSummary;
  statsKinds(viewId?: string): { scope: StatsScope; tree: KindNode[] };
  statsTools(viewId?: string): { scope: StatsScope; tools: ToolStat[] };
  statsModels(viewId?: string): { scope: StatsScope; models: ModelStat[] };
  statsPerformance(viewId?: string): PerformanceResult;
  statsIo(viewId: string | undefined, intervalUs: number | undefined, metric: IoMetric): IoSeries;
  statsPairs(viewId?: string): { scope: StatsScope; pairs: PairStat[] };
  expert(q: ExpertQuery): ExpertResult;
  /** In capture mode the captured evidence; `local` asks for this machine's logging health instead. */
  sources(opts?: { local?: boolean }): Promise<SourcesResult>;
  /** Side files the index references (persisted outputs, file-history backups, sidecars), or a capture blob by sha256. */
  file(q: { path?: string; blob?: string }): Promise<FileResult | null>;
  /**
   * An index run changed these sessions (null: anything may have changed). Cached global statistics and views over
   * those sessions are rebuilt on their next request; views over other sessions stay cached.
   */
  noteChanges(sessions: string[] | null): void;
}

/** View id that selects global statistics explicitly. */
export const GLOBAL_VIEW = 'global';

// ===========================================================================
// Derived queries (SPEC §12.5, §12.6). src/index/derived-queries.ts implements DerivedQueries over the schema-4
// tables; the HTTP routes, `agentshark why|failures|sig` and `agentshark mcp` all call it, so every reader sees the
// same derivation. One method per route; the JSON body is the return value. Methods throw QueryError (queries.ts):
// 404 `view_expired` for a `view` id that names no live view, 400 `bad-param` for a bad parameter. A method that
// returns null answers 404 `not-found`.

/** State of the analysis pass, from `meta` (schema.sql). */
export interface AnalysisStatus {
  /** meta.analysis_version, or null when this index was never derived. */
  version: number | null;
  /** ANALYSIS_VERSION of this build; version !== expected yields the gap 'analysis-outdated'. */
  expected: number;
  /** meta.sig_version (SIG_VERSION), or null. */
  sigVersion: string | null;
  /** Root session ids waiting in meta.analysis_pending. */
  pending: string[];
  /** Failed roots retain their last good rows and remain pending until a successful retry. */
  failed?: { root: string; error: string }[];
  /** meta.analysis_ms of the last pass. */
  lastMs: number | null;
  /** Thresholds in effect: meta.alarm_thresholds over ALARM_THRESHOLDS (Settings ▸ Alerts shows them). */
  alarmThresholds: AlarmThresholds;
  /** Every versioned rule with its hand-checked precision (`RULES` in derive.ts): the `?` provenance tooltip reads it. */
  rules: RuleInfo[];
}

/** The population a derived response describes. Every derived response carries it (SPEC §12.5). */
export interface DerivedScope {
  /** `view`: the items with an event in a view; `all`: the whole index; `session`: one session (and descendants); `item`: one episode, signature, turn or stream. */
  kind: 'view' | 'all' | 'session' | 'item';
  viewId: string | null;
  sessionId: string | null;
  /** Session scopes include descendants. */
  descendants: boolean;
  /** Items whose newest evidence is at or after this time (µs). */
  since: number | null;
  until: number | null;
  /** Events the view or the whole index covers; null for session and item scopes. */
  events: number | null;
  /** MCP project restriction (a cwd root) when one applies; the gap 'scope-limited' says so. */
  project: string | null;
}

/** Fields every derived response carries (SPEC §12.10 acceptance 5). */
export interface DerivedEnvelope {
  scope: DerivedScope;
  /** meta.analysis_version, or null when the index was never derived. */
  analysisVersion: number | null;
  gaps: Gap[];
}

/**
 * Scope of the list routes. `view` (a view id or GLOBAL_VIEW) is what the web and Mac clients send: an item belongs
 * to the view when any of its events does (SPEC §12.5). The CLI and MCP send `session` or `since` instead.
 * HTTP: `view=&session=&descendants=&since=&until=` (times as in SPEC §6).
 */
export interface DerivedScopeQuery {
  view?: string;
  session?: string;
  /** With `session`: include descendants (default true). */
  descendants?: boolean;
  since?: number;
  until?: number;
}

// ---- GET /api/failures/summary -------------------------------------------------------------------------------

/** HTTP: `tier=` as in the queue (the counts per tier ignore it; outcomes and sections follow it). */
export interface FailuresSummaryQuery extends DerivedScopeQuery {
  tier?: FailureTier[];
}

/** Counts for the facets and the scope label ("41 episodes · 12 need attention"). */
export interface FailuresSummary extends DerivedEnvelope {
  /** Failure rows per tier, for the tier toggle ("Failures 1,204 · +suspect ≈212 · +benign 61 · +deferred 9"). */
  tiers: Record<FailureTier, number>;
  /** Episodes per outcome, over the requested tiers. */
  outcomes: Record<EpisodeOutcome, number>;
  /** Items per attention section. */
  sections: Record<AttentionSection, number>;
  families: Partial<Record<FailureFamily, number>>;
  episodes: number;
  /** Items in NEEDS_ATTENTION sections. */
  needAttention: number;
  /** Alarms whose state is `firing`. */
  openAlarms: number;
}

// ---- GET /api/failures/queue ---------------------------------------------------------------------------------

export type QueueSort = 'attention' | 'recent' | 'impact' | 'attempts' | 'wall' | 'sessions';

/**
 * HTTP: `group=&tier=&outcome=&family=&agent=&role=&unattended=&section=&signature=&sort=&limit=&offset=`; list
 * parameters are comma-separated. Default: group `attention`, tier `failure`, sort `attention` (section order, then
 * impact, then newest), limit 200 (at most 1,000).
 */
export interface QueueQuery extends DerivedScopeQuery {
  group?: QueueGroup;
  /** Episodes by EpisodeRow.tier (`failure` when any attempt is a failure row); failure rows of other kinds by their own tier. */
  tier?: FailureTier[];
  outcome?: EpisodeOutcome[];
  family?: FailureFamily[];
  agent?: AgentKind[];
  role?: SessionRole[];
  /** Items whose turn is unattended (TurnRollupRow.unattended). */
  unattended?: boolean;
  /** One attention section only (MCP list_failures `section`). */
  section?: AttentionSection;
  /** Episodes of one signature id. */
  signature?: string;
  sort?: QueueSort;
  limit?: number;
  offset?: number;
}

export interface QueuePage extends DerivedEnvelope {
  total: number;
  rows: QueueRow[];
}

// ---- GET /api/episodes/:id, /api/episodes/:id/report -----------------------------------------------------------

/**
 * HTTP: `output_chars=` (head and tail length each, and the length of other trace text the frame quotes; default
 * 2,000, at most 20,000; MCP at most 2,000). Also taken by the claim and delegation frames.
 */
export interface LensQuery {
  outputChars?: number;
}

/** The Lens payload plus the envelope. `gaps` is the payload's own list. */
export type LensResponse = Omit<DerivedEnvelope, 'gaps'> & LensPayload;

export type EpisodeReportFormat = 'md' | 'brief' | 'json';

/** What a redaction replaced (SPEC §12.6 privacy), for the preview before Copy Report. */
export type RedactionClass = 'home' | 'user' | 'sk' | 'ghp' | 'github_pat' | 'slack' | 'aws' | 'bearer' | 'jwt' | 'pem';

export interface Redaction {
  class: RedactionClass;
  count: number;
}

/** `md`: Markdown for an issue; `brief`: a short agent brief; `json`: the redacted Lens payload as text. */
export interface EpisodeReport extends DerivedEnvelope {
  format: EpisodeReportFormat;
  text: string;
  redactions: Redaction[];
}

// ---- GET /api/signatures, /api/signatures/:id ----------------------------------------------------------------

/**
 * HTTP: `family=&status=&tier=&sort=impact|count|recent&limit=&offset=`. Default sort `impact` (rank), limit 200.
 * Status is computed on read, so a status filter compiles to conditions on first_ts, last_ts, regressed_ts and
 * turns_since_last at DerivedContext.now.
 */
export interface SignatureQuery extends DerivedScopeQuery {
  family?: FailureFamily[];
  status?: SignatureStatus[];
  tier?: FailureTier[];
  sort?: 'impact' | 'count' | 'recent';
  limit?: number;
  offset?: number;
}

export interface SignatureItem {
  id: string;
  text: string;
  family: FailureFamily;
  class: FailureClass;
  /** Failure rows in scope, and the sessions they are in. */
  n: number;
  sessions: number;
  /**
   * Episodes in scope and the sessions they are in: the pair the Lens title prints ("6 episodes in 6 sessions"), as the
   * signature's queue row does (QueueRow.members and seenSessions). This and the outcome counts are absent before
   * analysis version 14.
   */
  episodes?: number;
  episodeSessions?: number;
  /** Closed episodes (recovered + unrecovered); parallel-ok and open episodes count in neither. */
  closed?: number;
  recovered?: number;
  unrecovered?: number;
  /** unrecovered / closed; null without a closed episode. */
  unrecoveredRate: number | null;
  wallLostUs: number;
  firstTs: number;
  lastTs: number;
  status: SignatureStatus;
  agents: AgentKind[];
  rank: number;
  /** Sparkline: the last 30 local days. */
  daily: DailyCounts;
}

export interface SignatureList extends DerivedEnvelope {
  total: number;
  rows: SignatureItem[];
}

/** HTTP: `split_at=` (a time, SPEC §6) splits the counts into before and after. */
export interface SignatureDetailQuery {
  splitAt?: number;
}

export interface SignatureSplitSide {
  days: number;
  n: number;
  sessions: number;
  /** Sessions active on those days (the split divides by them, SPEC §12.2 row 7). */
  activeSessions: number;
  perActiveSession: number | null;
}

export interface SignatureDetail extends DerivedEnvelope, SignatureItem {
  /** Every day from firstTs to today (local `YYYY-MM-DD`). */
  days: { d: string; n: number; activeSessions: number }[];
  /** Recent episodes, newest first, at most 10. `errorLine` is trace text. */
  examples: { episodeId: string; sessionId: string; agent: AgentKind; ts: number; outcome: EpisodeOutcome; errorLine: string | null }[];
  /** At most 3, "observed in past recoveries, not verified". */
  fixes: ObservedFix[];
  split?: { at: number; before: SignatureSplitSide; after: SignatureSplitSide };
}

// ---- GET /api/sessions/:id/steps -------------------------------------------------------------------------------

/**
 * `dur`: wall time; `active`: model plus tool time (StepItem.activeUs); `gap`: wall time beyond it (StepItem.gapUs);
 * `tokIn`: new prompt tokens (tokens.uncached); `ctx`: context size (tokens.input).
 */
export type StepSort = 'seq' | 'dur' | 'active' | 'gap' | 'tokIn' | 'tokOut' | 'ctx';

/**
 * HTTP: `view=&turn=&after=&limit=&sort=&order=&descendants=&fold_clean=&only_failed=&bucket=`. Sorting by anything
 * but `seq` flattens turns into one step list (clients add a Turn column). `after` is the opaque `next` of the
 * previous page. Default limit 500 (at most 5,000).
 */
export interface StepsQuery {
  /**
   * The window's view (display filter and time range). It never hides a step: each step and call reports `match`, and
   * the page counts them, for "Session X · 213 steps · filter highlights 14". Runs in the view's worker.
   */
  view?: string;
  turn?: string;
  after?: string;
  limit?: number;
  sort?: StepSort;
  order?: 'asc' | 'desc';
  descendants?: boolean;
  /** Clean turns come back with their steps left out (the turn row stays). */
  foldClean?: boolean;
  /** Only turns with at least one failure-tier row. */
  onlyFailed?: boolean;
  /** Only steps with time in this bucket (the turn time bar's segments). */
  bucket?: TimeBucketName;
}

export interface StepTurn {
  id: string;
  sessionId: string;
  /** 1-based within the session. */
  n: number;
  origin: string | null;
  /** Trace text. */
  promptExcerpt: string | null;
  startTs: number;
  endTs: number | null;
  open: boolean;
  wallUs: number | null;
  wallSrc: Prov | null;
  impact: TurnImpact;
  impactBasis: string | null;
  claim: ClaimEvidence | null;
  unattended: boolean;
  buckets: TimeBucket[];
  /** Null when time is not derived (gap not-derived). */
  unattributedUs: number | null;
  nSteps: number;
  nEpisodes: number;
  /** Steps of the turn with a match in the `view`; null without a view. Folded turns report it too. */
  matchedSteps: number | null;
}

export interface StepCall {
  /** The tool.call event. */
  eventId: string;
  resultEventId: string | null;
  tool: string | null;
  toolKind: ToolKindTag | null;
  target: string | null;
  /** Worst tier of the result's failure rows; null when the call is clean. */
  tier: FailureTier | null;
  episodeId: string | null;
  durUs: number | null;
  /** The tool span's durSrc; null when it is `unknown`. */
  durSrc: Prov | null;
  processId: string | null;
  childSessionId: string | null;
  childOutcome: DelegationOutcome | null;
  childOutcomeSrc: Prov | null;
  /** Spawn chips show "parent told: no". */
  parentTold: boolean | null;
  /** The call or its result is a row of the `view`; null without a view. */
  match: boolean | null;
}

export interface StepItem {
  id: string;
  /** Session-wide step number (StepRow.n): the Steps "No." column. */
  n: number;
  /** Its position with the canonical phrase ("step 46 · 5 of 6 in turn 6"), as the Lens and the reports give it; absent from older servers. */
  position?: StepPosition;
  sessionId: string;
  turnId: string | null;
  startTs: number;
  endTs: number | null;
  durUs: number | null;
  modelUs: number | null;
  modelSrc: Prov | null;
  toolUs: number | null;
  /** modelUs + toolUs, at most durUs (parallel calls overlap): the step's own work; null when neither is known. */
  activeUs: number | null;
  /** durUs − activeUs: waiting on a human, a process or nothing logged; null when either is unknown. */
  gapUs: number | null;
  /** Trace text. */
  intent: string | null;
  intentSrc: Prov | null;
  ctxTokens: number | null;
  ctxWindow: number | null;
  ctxWindowSrc: Prov | null;
  tokIn: number | null;
  tokOut: number | null;
  compactionBefore: boolean;
  /** StepRow.attachments (P1 context lane). */
  attachments: Record<string, number> | null;
  episodeIds: string[];
  calls: StepCall[];
  /** Any event of the step is a row of the `view`; null without a view. Non-matching steps are dimmed, never hidden. */
  match: boolean | null;
}

export interface StepsPage extends DerivedEnvelope {
  turns: StepTurn[];
  steps: StepItem[];
  /** Steps in the session (with descendants when asked) or the turn, before folding and paging. */
  total: number;
  /** Of those, steps with a match in the `view`; null without a view. */
  matched: number | null;
  /** Pass back as `after`; null at the end. */
  next: string | null;
}

// ---- GET /api/report/:sessionId ------------------------------------------------------------------------------

/** HTTP: `since=&format=json|md`. `md` answers text/markdown rendered from the same JSON (renderRunReportMarkdown). */
export interface RunReportQuery {
  since?: number;
}

/** The Run report plus the envelope. `gaps` is the report's own list. */
export type RunReportResponse = Omit<DerivedEnvelope, 'gaps'> & RunReport;

/** How `latest`, `--last` and `--cwd` pick a run (MCP run_report `resolved`, `agentshark why`). */
export interface RunRef {
  /** A session id, or 'latest'. */
  session?: string;
  /** Runs whose root cwd is this directory or below it. */
  cwd?: string;
  agent?: AgentKind;
  /** Never resolve to this run (the calling agent's own live session). */
  excludeSession?: string;
}

export interface RunCandidate {
  id: string;
  agent: AgentKind;
  /** Trace text. */
  title: string | null;
  cwd: string | null;
  end: number | null;
  status: RunStatus;
}

export interface RunResolution {
  /** Resolved root session id, or null. */
  id: string | null;
  /** `explicit`: the id given; `latest`: newest finished run in scope; `latest-live`: only a possibly-running run matched. */
  rule: 'explicit' | 'latest' | 'latest-live' | 'not-found';
  /** Up to 5 runs that also matched, newest first. */
  candidates: RunCandidate[];
}

// ---- GET /api/{delegations,claims,interventions,alarms,episodes,processes} ------------------------------------

/**
 * HTTP: `view=|session=` plus `since=&until=&limit=&offset=`; alarms also `state=&kind=`. Default limit 500. Rows
 * carry rids (index-internal); each *Item adds the event id of every rid, and clients navigate by event id only.
 */
export interface DerivedRowsQuery extends DerivedScopeQuery {
  limit?: number;
  offset?: number;
}

/** Stored alarms plus the `stall` alarms computed on read; `state` and the window use DerivedContext.now. */
export interface AlarmRowsQuery extends DerivedRowsQuery {
  state?: AlarmState;
  kind?: AlarmKind[];
}

export interface RowsPage<T> extends DerivedEnvelope {
  total: number;
  rows: T[];
}

export interface DelegationItem extends DelegationRow {
  /** Trace text. */
  childTitle: string | null;
  childAgent: AgentKind | null;
  childRole: SessionRole | null;
  resultEventId: string | null;
}

export interface ClaimItem extends ClaimRow {
  /** Trace text: the sentence that claims success. */
  claimExcerpt: string | null;
  finalEventId: string;
  testEventId: string | null;
  lastEditEventId: string | null;
}

export interface InterventionItem extends InterventionRow {
  /** Trace text. */
  excerpt: string | null;
  eventId: string;
}

/** `GET /api/episodes?view=|session=`: failure bands and loop brackets on the Timeline (startTs to endTs, end glyph by outcome). */
export interface EpisodeItem extends EpisodeRow {
  openerEventId: string;
  lastEventId: string;
  closerEventId: string | null;
}

/** `GET /api/processes?view=|session=`: process lanes on the Timeline. */
export interface ProcessItem extends ProcessRow {
  openEventId: string;
  closeEventId: string | null;
}

// ---- GET /api/claims/:turnId, /api/delegations/:spanId: the Lens frame for claims and delegations --------------

/** `GET /api/claims/:turnId?output_chars=` (LensQuery): a claim in the Lens frame (SPEC §12.7). */
export interface ClaimLens extends DerivedEnvelope {
  claim: ClaimItem;
  where: LensWhere;
  /** Trace text: the final message, cut to output_chars. */
  finalText: string | null;
  /**
   * The evidence the state was read from, in seq order: the turn's test runs and edits. For `no-test-in-turn` the
   * latest earlier run comes first with `earlier: true`. `target` and `path` are trace text.
   */
  evidence: {
    kind: 'test' | 'edit';
    eventId: string;
    ts: number;
    /** Session-wide step number. */
    step: number | null;
    target: string | null;
    tier: FailureTier | null;
    exitCode: number | null;
    exitSrc: Prov | null;
    path: string | null;
    added: number | null;
    removed: number | null;
    earlier: boolean;
  }[];
}

/** `GET /api/delegations/:spanId?output_chars=` (LensQuery): a delegation in the Lens frame (SPEC §12.7). */
export interface DelegationLens extends DerivedEnvelope {
  delegation: DelegationItem;
  /** Where the parent spawned it. */
  where: LensWhere;
  /** Trace text: the whole task given to the child, cut to output_chars (a cut ends in `…`). */
  task: string | null;
  /** Code points of the whole task (DelegationItem.taskChars); absent before analysis version 14. */
  taskChars?: number | null;
  /** The child session (delegation.childSession); empty counts and nulls when it is not indexed. */
  child: {
    impact: TurnImpact | null;
    steps: number;
    /** The child's episodes outside the `recovered` section, attention order, at most 10. */
    episodes: QueueRow[];
    /** Trace text: the child's final message. */
    finalText: string | null;
  };
  /** The result the parent saw (trace text) and, for a failed child, whether it named the failure (`inferred:parent-told@2`). */
  parentSaw: { eventId: string; text: string | null; flagged: boolean; told: boolean | null; rule: RuleId } | null;
  /** The parent's next step after that result. */
  parentNext: { stepId: string; n: number; calls: { eventId: string; tool: string | null; target: string | null; tier: FailureTier | null }[] } | null;
}

// ---- GET /api/events/:id/derived: the Step and Failure layers of the Events detail tree ------------------------

/** Every derived fact about one event; null parts do not apply. MCP get_event `derived` is a subset. */
export interface EventDerived extends DerivedEnvelope {
  eventId: string;
  step: { id: string; n: number; turnId: string | null; inTurn: { n: number; of: number } | null; segSrc: Prov; position?: StepPosition } | null;
  failure: {
    tier: FailureTier;
    source: FailureSource;
    rule: RuleId;
    family: FailureFamily;
    class: FailureClass;
    signatureId: string;
    /** Trace text. */
    signature: string;
    /** Trace text. */
    targetKey: string;
    exitCode: number | null;
    exitSrc: Prov | null;
    /** Trace text. */
    errorLine: string | null;
    episodeId: string | null;
    attempt: number | null;
    /**
     * The layer's one line, built by derived-queries so both clients read the same words: the tier, then what decided
     * it ("benign: rg no match", "deferred: process exited 0 at step 52", "failure: inner exec exit 2"). Trace text.
     */
    note: string;
  } | null;
  /** The episode the event belongs to: as an attempt, an attempt's call, or the closing call. */
  episode: { id: string; role: 'attempt' | 'call' | 'closer'; outcome: EpisodeOutcome; outcomeSrc: Prov; nAttempts: number; section: EpisodeSection } | null;
  process: { id: string; role: ProcessEventRole; status: ProcessStatus; exitCode: number | null; exitSrc: Prov | null; closeEventId: string | null; closeStep: number | null } | null;
  /** The spawn call or result, or the result through which the parent saw the child. */
  delegation: { id: string; childSessionId: string | null; outcome: DelegationOutcome; outcomeSrc: Prov | null; silent: boolean } | null;
  changes: { path: string; op: ChangeOp; src: Prov; added: number | null; removed: number | null; outsideCwd: boolean; diffAvailable: boolean }[];
  intervention: { kind: InterventionKind; actor: InterventionActor; actorSrc: Prov } | null;
  /** The final llm.text of a claiming turn. */
  claim: { turnId: string; evidence: ClaimEvidence; rule: RuleId } | null;
}

// ---- GET /api/session-marks: sidebar glyphs ---------------------------------------------------------------------

/** HTTP: `ids=` (comma-separated; a batch refresh after index-done). Without ids: every session that has a mark. */
export interface SessionMarksQuery {
  ids?: string[];
}

/** One sidebar row's marks (SPEC §12.7 Entry): worst impact glyph, ⇣ silent child, ⟳ firing alarm. */
export interface SessionMark {
  sessionId: string;
  rootId: string;
  /** Null when the session has no derived turn (the envelope then lists 'analysis-pending' or 'analysis-outdated'). */
  worstImpact: TurnImpact | null;
  worstTurn: string | null;
  silentChildren: number;
  firingAlarms: number;
  /** Blocked and unrecovered episodes, silent children, unverified claims and firing alarms of the session. */
  needAttention: number;
  possiblyRunning: boolean;
}

/**
 * Without `ids`, sessions whose worst impact is `clean` and whose counts are 0 are left out: absent means clean,
 * unless the envelope lists 'analysis-pending' or 'analysis-outdated' (then it may not be derived yet).
 */
export interface SessionMarks extends DerivedEnvelope {
  rows: SessionMark[];
}

// ---- GET /api/changes/:eventId/diff ----------------------------------------------------------------------------

/** HTTP: `path=&max_lines=` (default 2,000 lines per file). Without `path`, every file the event changed. */
export interface DiffQuery {
  path?: string;
  maxLines?: number;
}

/** A line diff hunk. Line numbers are null when the input does not place the change in the file (an Edit's old_string). */
export interface DiffHunk {
  oldStart: number | null;
  newStart: number | null;
  lines: DiffOp[];
}

export interface FileDiff {
  /** Trace text. */
  path: string;
  op: ChangeOp;
  src: Prov;
  added: number | null;
  removed: number | null;
  /** Null when no diff can be shown; `reason` says why (a shell mention, raw bytes gone, ...). */
  hunks: DiffHunk[] | null;
  /** The old content is not logged (a Write over an existing file without a backup): the hunks show the new content only. */
  newOnly: boolean;
  /** `max_lines` cut the hunks. */
  truncated: boolean;
  reason: string | null;
}

/**
 * The diff of one change event (Edit, MultiEdit, Write, NotebookEdit, apply_patch, Codex FileChange, an external
 * edit), built from raw bytes by derived-queries, so no client parses tool shapes. The hunks are trace text.
 */
export interface ChangeDiff extends DerivedEnvelope {
  eventId: string;
  files: FileDiff[];
}

// ---- GET /api/follow/... ---------------------------------------------------------------------------------------

/** `GET /api/follow/call/:eventId`, `/delegation/:spanId`, `/process/:id`, `/file?session=&path=`. */
export type FollowTarget =
  | { kind: 'call'; eventId: string }
  | { kind: 'delegation'; spanId: string }
  | { kind: 'process'; id: string }
  /** `session` names a tree: the session and its descendants (each item carries its own `sessionId`). */
  | { kind: 'file'; session: string; path: string };

/** HTTP: `after=&limit=&output_chars=`. Default limit 500, output_chars 2,000. */
export interface FollowQuery {
  after?: string;
  limit?: number;
  outputChars?: number;
}

export interface FollowPage extends DerivedEnvelope {
  kind: FollowKind;
  /** Header of the stream, by kind. */
  subject: {
    tool?: string | null;
    target?: string | null;
    tier?: FailureTier | null;
    childSessionId?: string | null;
    outcome?: DelegationOutcome | null;
    outcomeSrc?: Prov | null;
    parentTold?: boolean | null;
    silent?: boolean;
    program?: string | null;
    status?: ProcessStatus;
    exitCode?: number | null;
    exitSrc?: Prov | null;
    nPolls?: number;
    nInputs?: number;
    path?: string;
    reads?: number;
    edits?: number;
    shellMentions?: number;
  };
  items: FollowItem[];
  next: string | null;
}

// ---- GET /api/time -------------------------------------------------------------------------------------------

/** Exactly one of session or turn. */
export interface TimeQuery {
  session?: string;
  turn?: string;
}

export type TimeResponse = DerivedEnvelope & TimeBreakdown;

// ---- GET /api/stats/tools?group=, /api/stats/endpoints ---------------------------------------------------------

/**
 * Tool calls by `tool` (name), `server` (MCP server), `program` (the `sh:` target), `host` (web host) or `model` (the
 * model that issued the call; model latency is Statistics ▸ Models). `tool` and `model` group the same calls, so their
 * calls and failures sum alike.
 */
export type SrtGroup = 'tool' | 'server' | 'program' | 'host' | 'model';

/** Service response time row: durations cover only calls with a known duration (`durKnown` of `calls`). */
export interface SrtRow {
  key: string;
  calls: number;
  /** Calls with a known duration, `durUnbounded` among them. */
  durKnown: number;
  /**
   * Known durations that bound nothing: a tool call's timestamp gap of at least the 5-minute idle gap (SPEC §7.2),
   * which may hold idle time or an approval wait (delegations keep theirs). p50, p90, p99, max and total leave them out.
   */
  durUnbounded?: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
  total: number;
  /** Calls per duration source (`logged:…`, `derived:ts-gap`, `parsed:…`, `unknown`). */
  durSrcMix: Record<string, number>;
  /** These calls by the worst failure tier of each, from the failure rows in scope. */
  failures: Record<FailureTier, number>;
  agents: AgentKind[];
}

/** `GET /api/stats/tools?view=&group=`. Without `group` the route keeps its SPEC §6 response (IndexQueries.statsTools). */
export interface SrtQuery {
  view?: string;
  group: SrtGroup;
}

/** At most 1,000 rows, by calls; a longer list adds the gap `truncated` (field `rows`) with the count left out. */
export interface SrtResponse extends DerivedEnvelope {
  group: SrtGroup;
  rows: SrtRow[];
}

/** Endpoints (Wireshark Statistics ▸ Endpoints): MCP servers, web hosts, hooks, shell programs, agent types. */
export type EndpointKind = 'mcp' | 'host' | 'hook' | 'program' | 'agent';

export interface EndpointsQuery {
  view?: string;
  /** All kinds when absent. */
  kind?: EndpointKind;
}

export interface EndpointRow {
  kind: EndpointKind;
  /** `server`, `host`, `<event>:<command>`, program, or agent type. */
  endpoint: string;
  calls: number;
  sessions: number;
  failures: Record<FailureTier, number>;
  durKnown: number;
  /** As SrtRow.durUnbounded: counted in durKnown, left out of the percentiles. */
  durUnbounded?: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  firstTs: number | null;
  lastTs: number | null;
}

/** At most 1,000 rows per kind, by calls; a longer kind adds the gap `truncated` (field `rows[kind=<kind>]`) with its count. */
export interface EndpointsResponse extends DerivedEnvelope {
  rows: EndpointRow[];
}

// ---- MCP and CLI only (SPEC §12.6). mcp/tools.ts maps these to the MCP output schemas in mcp/schemas.ts. --------

export interface FindRunsQuery {
  cwd?: string;
  agent?: AgentKind;
  since?: number;
  excludeSession?: string;
  limit?: number;
}

export interface RunSummary {
  root: string;
  agent: AgentKind;
  /** Trace text. */
  title: string | null;
  cwd: string | null;
  start: number | null;
  end: number | null;
  status: RunStatus;
  unattended: boolean;
  /** Items in NEEDS_ATTENTION sections. */
  attention: number;
  worstImpact: TurnImpact;
  silentChild: number;
  unverifiedClaims: number;
  openAlarms: number;
}

export interface FindRunsResult extends DerivedEnvelope {
  runs: RunSummary[];
}

/** Exactly one of text (at most 4,096 UTF-8 bytes) or signatureId. */
export interface LookupErrorQuery {
  text?: string;
  signatureId?: string;
}

export interface LookupErrorResult extends DerivedEnvelope {
  /** sigv1 of the input text (or the signature's text). Trace text. */
  normalized: string;
  signature: { id: string; text: string; family: FailureFamily; class: FailureClass } | null;
  family: FailureFamily;
  /** `exact`: the signature is indexed; `family`: only its family is; `none`. */
  match: 'exact' | 'family' | 'none';
  sessions: number;
  recoveredRate: number | null;
  status: SignatureStatus | null;
  fixes: ObservedFix[];
  adviceKind: AdviceKind;
}

export interface WatchQuery {
  /** A session id or 'latest'. */
  session: string;
  /** Opaque cursor from the previous call; absent on the first call (then everything is new). */
  cursor?: string;
}

export interface WatchEpisode {
  id: string;
  targetKey: string;
  signatureId: string;
  signature: string;
  family: FailureFamily;
  outcome: EpisodeOutcome;
  attempts: number;
  /** Trace text. */
  errorLine: string | null;
}

export interface WatchResult extends DerivedEnvelope {
  cursor: string;
  sessionId: string;
  newEpisodes: WatchEpisode[];
  updatedEpisodes: { id: string; attempts: number; identicalRetries: number; editsBetween: number; outcome: EpisodeOutcome }[];
  /** Alarms whose firstTs, clearedTs or expiry falls after the cursor (a `stall` fires at lastTs + stallMin). */
  alarms: AlarmItem[];
  newClaims: ClaimItem[];
  turnOpen: boolean;
  stalledForS: number | null;
}

// ---- SSE additions (GET /api/stream) ---------------------------------------------------------------------------

/**
 * SSE `alarm`: an alarm fired or cleared in the last index run (DeriveResult.alarms): the difference between a
 * tree's alarm rows before and after the pass, for alarms whose lastTs lies within windowMin of `now`, so a rebuild
 * or --rederive announces nothing old. `stall` and expiry depend on the clock and never arrive here; clients
 * re-read `/api/alarms?state=firing` at least every 60 s while a run is possibly running or has an open turn.
 */
export interface AlarmStreamEvent {
  id: string;
  kind: AlarmKind;
  sessionId: string;
  turnId: string;
  episodeId: string | null;
  delegationId: string | null;
  state: 'firing' | 'cleared';
  notify: boolean;
}

/** `index-done` gains `analysis` (SPEC §12.5). */
export interface IndexDoneAnalysis {
  ms: number;
  /** Root trees deferred to meta.analysis_pending. */
  pending: number;
}

// ---- The query object -----------------------------------------------------------------------------------------

/** How derived queries see a `view` id: the view lives in the connection that built it (queries.ts, query-host.ts). */
export interface ViewRef {
  /** Temp table holding the view's rids (`temp.<table>`, column `rid`), or null when the view holds every visible event. */
  table: string | null;
  events: number;
  /**
   * Set when the view holds every visible event of these sessions (descendants included) and nothing else: no filter,
   * time range or options. Derived queries then scope by session, which gives the same items without the view's rows.
   */
  sessions?: string[];
}

export interface DerivedContext {
  mode: 'live' | 'capture';
  indexPath: string;
  /**
   * Resolves `view` (a view id, GLOBAL_VIEW or undefined → null = the whole index). queries.ts provides it on the
   * same connection; it throws QueryError 404 `view_expired` for an unknown id. Absent for MCP and the CLI, which
   * scope by session and time instead (a `view` parameter is then 400 `bad-param`).
   */
  resolveView?: (viewId: string | undefined) => ViewRef | null;
  /**
   * MCP `--scope project`: only runs whose root session cwd is this directory or below it are visible; every
   * response then carries scope.project and the gap 'scope-limited'. Undefined: everything.
   */
  project?: string;
  /**
   * Clock in µs for everything computed on read (alarm state, `stall`, signature status, possibly-running). Default
   * Date.now() × 1000; in capture mode the capture's creation time, so a capture reads as it did when it was written.
   * Tests pin it.
   */
  now?: () => number;
}

/**
 * Read side of the derived tables. Implemented by createDerivedQueries(db, ctx) in src/index/derived-queries.ts.
 * Methods that read raw bytes (follow streams, reports with diffs) return promises.
 */
export interface DerivedQueries {
  /** `GET /api/failures/summary` */
  failuresSummary(q: FailuresSummaryQuery): FailuresSummary;
  /** `GET /api/failures/queue` */
  failuresQueue(q: QueueQuery): QueuePage;
  /** `GET /api/episodes/:id`: the Lens payload. */
  episode(id: string, q?: LensQuery): LensResponse | null;
  /** `GET /api/episodes/:id/report?format=`: redacted report plus what was redacted. */
  episodeReport(id: string, format: EpisodeReportFormat): Promise<EpisodeReport | null>;
  /** `GET /api/signatures` */
  signatures(q: SignatureQuery): SignatureList;
  /** `GET /api/signatures/:id?split_at=` */
  signature(id: string, q?: SignatureDetailQuery): SignatureDetail | null;
  /** `GET /api/sessions/:id/steps` */
  sessionSteps(sessionId: string, q: StepsQuery): StepsPage | null;
  /** `GET /api/report/:sessionId`. sessionId may be 'latest' (resolved with resolveRun). */
  runReport(sessionId: string, q?: RunReportQuery): RunReportResponse | null;
  /** `GET /api/delegations` */
  delegations(q: DerivedRowsQuery): RowsPage<DelegationItem>;
  /** `GET /api/delegations/:spanId`: the delegation Lens frame, by DelegationRow.id or by the child session id. */
  delegation(spanId: string, q?: LensQuery): DelegationLens | null;
  /** `GET /api/claims` */
  claims(q: DerivedRowsQuery): RowsPage<ClaimItem>;
  /** `GET /api/claims/:turnId`: the claim Lens frame. */
  claim(turnId: string, q?: LensQuery): ClaimLens | null;
  /** `GET /api/interventions` */
  interventions(q: DerivedRowsQuery): RowsPage<InterventionItem>;
  /** `GET /api/alarms` */
  alarms(q: AlarmRowsQuery): RowsPage<AlarmItem>;
  /** `GET /api/episodes` (Timeline bands and loop brackets). */
  episodes(q: DerivedRowsQuery): RowsPage<EpisodeItem>;
  /** `GET /api/processes` (Timeline process lanes). */
  processes(q: DerivedRowsQuery): RowsPage<ProcessItem>;
  /** `GET /api/events/:id/derived`: the Step and Failure layers of the Events detail tree. */
  eventDerived(eventId: string): EventDerived | null;
  /** `GET /api/session-marks?ids=`: sidebar glyphs. */
  sessionMarks(q: SessionMarksQuery): SessionMarks;
  /** `GET /api/changes/:eventId/diff?path=&max_lines=`: reads raw bytes. */
  diff(eventId: string, q?: DiffQuery): Promise<ChangeDiff | null>;
  /** `GET /api/follow/{call/:eventId, delegation/:spanId, process/:id, file?session=&path=}` */
  follow(target: FollowTarget, q?: FollowQuery): Promise<FollowPage | null>;
  /** `GET /api/time?session=|turn=` */
  time(q: TimeQuery): TimeResponse | null;
  /** `GET /api/stats/tools?group=` (service response time). */
  statsSrt(q: SrtQuery): SrtResponse;
  /** `GET /api/stats/endpoints?kind=` */
  statsEndpoints(q: EndpointsQuery): EndpointsResponse;
  /** MCP find_runs. */
  findRuns(q: FindRunsQuery): FindRunsResult;
  /** MCP run_report `resolved`, `agentshark why --last|--session|--cwd`. */
  resolveRun(ref: RunRef): RunResolution;
  /** MCP lookup_error, `agentshark sig`. */
  lookupError(q: LookupErrorQuery): LookupErrorResult;
  /** MCP watch: what changed in a run since the cursor. */
  watch(q: WatchQuery): WatchResult;
  /** Also served as InfoResult.analysis. */
  analysisStatus(): AnalysisStatus;
  /** Same contract as IndexQueries.noteChanges: an index run changed these sessions (null: anything). */
  noteChanges(sessions: string[] | null): void;
}
