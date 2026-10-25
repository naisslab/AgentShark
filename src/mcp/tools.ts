// The eight read-only tools of `agentshark mcp` (SPEC §12.6). Each tool calls the derived queries (or, for `query` and
// `get_event`, the index queries), renames trace text to `*_excerpt` keys, redacts it and adds the envelope. The CLI
// mirrors (`agentshark why|failures|sig --json`) print the same structured content.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CliError, parseTime } from '../cli/util.ts';
import type { DerivedQueries, EpisodeItem, EventDerived, IndexQueries, QueueQuery, RunRef } from '../index/api.ts';
import { QueryError } from '../index/queries.ts';
import {
  AGENT_PREFIX, EPISODE_SECTIONS, type AgentKind, type Attrs, type EpisodeSection, type EventRow, type Gap, type QueueRow,
} from '../model/types.ts';
import { excerpt, excerptTail, fitBytes, redactText } from './redact.ts';
import {
  MCP_DROPPED, MCP_LIMITS, MCP_TRACE_TEXT, mcpTool, type FindRunsInput, type GetEpisodeInput, type GetEventInput,
  type JsonSchema, type ListFailuresInput, type LookupErrorInput, type McpEnvelope, type McpToolName, type QueryInput,
  type RunReportInput, type WatchInput,
} from './schemas.ts';
import type { McpServerOptions } from './server.ts';
import { runWorkbench } from '../server/workbench.ts';

export interface McpToolContext {
  /** createDerivedQueries(db, { mode, indexPath, project }) */
  derived: DerivedQueries;
  /** For query and get_event. */
  queries: IndexQueries;
  opts: McpServerOptions;
  /** The project root under --scope project; null under --scope all. */
  project: string | null;
  /** The read-only index connection: meta keys and project membership for query and get_event. */
  db: DatabaseSync;
}

/** The structured content of a successful call matches the tool's outputSchema; an error carries only `error`. */
export interface ToolResult {
  structuredContent: Record<string, unknown>;
  isError: boolean;
  /** Why the call failed (isError), in words for the calling agent. */
  message?: string;
}

/** Arguments the caller can fix: answered as a tool error, never as a protocol error. */
export class ToolInputError extends Error {}

/** src/index/derived-queries.ts did not load: query and get_event still answer from the index alone. */
export class DerivedUnavailableError extends Error {}

type Cut = McpEnvelope['cut'][number];
type Body = Record<string, unknown>;

interface ToolOutput {
  body: Body;
  /** The derived response's analysisVersion; absent: meta.analysis_version. */
  analysisVersion?: number | null;
  gaps?: Gap[];
  cut?: Cut[];
}

const TOOLS: Record<McpToolName, (ctx: McpToolContext, a: any) => ToolOutput | Promise<ToolOutput>> = {
  find_runs: findRuns,
  run_report: (ctx, a: RunReportInput) => runReport(ctx, { session: a.session }, time(ctx, a.since, 'since')),
  list_failures: listFailures,
  get_episode: getEpisode,
  lookup_error: lookupError,
  watch,
  query,
  get_event: getEvent,
  analyze_trace: analyzeTrace,
};

/** Validate the arguments, run the tool, add the envelope and keep the result under --max-bytes. */
export async function callTool(ctx: McpToolContext, name: McpToolName, args: unknown): Promise<ToolResult> {
  const input = args ?? {};
  const problems = validate(mcpTool(name).inputSchema, input);
  if (problems.length) return failure(`Invalid arguments for ${name}: ${problems.join('; ')}`);
  try {
    return finish(ctx, await TOOLS[name](ctx, input));
  } catch (e) {
    if (e instanceof ToolInputError || e instanceof DerivedUnavailableError || (e instanceof QueryError && e.status < 500) || (e as { status?: number }).status === 400) {
      return failure((e as Error).message);
    }
    throw e;
  }
}

/** run_report for a RunRef (`agentshark why --cwd` resolves by directory, which the MCP input does not offer). */
export function runReportFor(ctx: McpToolContext, ref: RunRef, since?: number): ToolResult {
  return finish(ctx, runReport(ctx, ref, since));
}

function failure(message: string): ToolResult {
  return { structuredContent: { error: message }, isError: true, message };
}

function finish(ctx: McpToolContext, out: ToolOutput): ToolResult {
  const content = { ...out.body, ...envelope(ctx, out) };
  return { structuredContent: fitBytes(content, ctx.opts.maxBytes).content, isError: false };
}

// ---------------------------------------------------------------------------
// Envelope (McpEnvelope)

function envelope(ctx: McpToolContext, out: ToolOutput): McpEnvelope {
  const gaps = [...(out.gaps ?? [])];
  if (ctx.project) {
    gaps.push({
      code: 'scope-limited', limit: null,
      message: 'Only runs whose working directory is under the project root are visible (--scope project).',
    });
  }
  return {
    index_age_s: indexAgeS(ctx),
    indexer: indexerState(ctx.opts.indexPath),
    analysis_version: out.analysisVersion !== undefined ? out.analysisVersion : metaNumber(ctx.db, 'analysis_version'),
    gaps: mergeGaps(ctx, gaps),
    cut: out.cut ?? [],
    scope: { mode: ctx.opts.scope, root: ctx.project ? redactText(ctx.project, ctx.opts.redact).text : null },
  };
}

/** One entry per code and field, in the schema's shape; messages are AgentShark's but may quote a path. */
function mergeGaps(ctx: McpToolContext, gaps: Gap[]): McpEnvelope['gaps'] {
  const seen = new Set<string>();
  const out: McpEnvelope['gaps'] = [];
  for (const g of gaps) {
    const key = `${g.code}\n${g.field ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code: g.code,
      message: redactText(g.message, ctx.opts.redact).text,
      limit: g.limit,
      ...(g.field !== undefined && { field: g.field }),
      ...(g.count !== undefined && { count: g.count }),
    });
  }
  return out;
}

function nowUs(ctx: McpToolContext): number {
  return ctx.opts.now?.() ?? Date.now() * 1000;
}

function metaNumber(db: DatabaseSync, key: string): number | null {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function indexAgeS(ctx: McpToolContext): number | null {
  const changed = metaNumber(ctx.db, 'last_change_at');
  return changed === null ? null : Math.max(0, Math.round((nowUs(ctx) - changed) / 1e5) / 10);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The live pid in `<index>.lock` (a one-off index run or a server's indexer), or null. */
function lockHolder(indexPath: string): number | null {
  try {
    const pid = Number(readFileSync(`${indexPath}.lock`, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** From the files beside the index (schema.sql): a live `<index>.watch.<pid>`, else a live `<index>.lock`. */
export function indexerState(indexPath: string): McpEnvelope['indexer'] {
  const prefix = `${basename(indexPath)}.watch.`;
  try {
    for (const f of readdirSync(dirname(indexPath))) {
      const pid = Number(f.slice(prefix.length));
      if (f.startsWith(prefix) && Number.isInteger(pid) && pid > 0 && alive(pid)) return 'watching';
    }
  } catch {
    // No folder: no indexer.
  }
  return lockHolder(indexPath) === null ? 'none' : 'indexing';
}

// ---------------------------------------------------------------------------
// Shared helpers

const AGENT_BY_PREFIX = new Map(Object.entries(AGENT_PREFIX).map(([kind, prefix]) => [prefix as string, kind as AgentKind]));

function agentOf(sessionId: string): AgentKind | null {
  return AGENT_BY_PREFIX.get(sessionId.slice(0, sessionId.indexOf(':'))) ?? null;
}

/** An `_excerpt` value: redacted and cut to MCP_LIMITS.excerptChars. */
function ex(ctx: McpToolContext, text: string | null | undefined, max: number = MCP_LIMITS.excerptChars): string | null {
  return excerpt(text, max, ctx.opts.redact);
}

/** `30m`, `8h`, `7d` back from now, or an ISO date/time (local time without a zone). */
function time(ctx: McpToolContext, text: string | undefined, name: string): number | undefined {
  if (text === undefined) return undefined;
  try {
    return parseTime(text, name, nowUs(ctx) / 1000);
  } catch (e) {
    if (e instanceof CliError) throw new ToolInputError(e.message);
    throw e;
  }
}

/** `~` and relative paths against the server's home and cwd. */
function absolutePath(ctx: McpToolContext, path: string): string {
  const home = ctx.opts.redact?.home ?? homedir();
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  return resolve(ctx.opts.cwd, expanded);
}

/** A session id, or the latest finished run for 'latest' (null when there is none). */
function sessionRef(ctx: McpToolContext, ref: string): string | null {
  return ref === 'latest' ? ctx.derived.resolveRun({ session: 'latest' }).id : ref;
}

/** SQL over sessions `s`: the session's run root has its cwd at or below the project root (the rule C applies). */
const IN_PROJECT = `EXISTS (SELECT 1 FROM sessions r WHERE r.id = coalesce(s.root_id, s.id)
  AND (r.cwd = ?1 OR substr(r.cwd, 1, length(?1) + 1) = ?1 || '/'))`;

function inProject(ctx: McpToolContext, sessionId: string): boolean {
  if (!ctx.project) return true;
  return !!ctx.db.prepare(`SELECT 1 FROM sessions s WHERE s.id = ?2 AND ${IN_PROJECT}`).get(ctx.project, sessionId);
}

/** Run roots of the project (their descendants follow through the view's `descendants`). */
function projectRoots(ctx: McpToolContext): string[] {
  return (ctx.db.prepare(`SELECT s.id FROM sessions s WHERE s.id = coalesce(s.root_id, s.id) AND ${IN_PROJECT}`).all(ctx.project) as { id: string }[])
    .map((r) => r.id);
}

function analyzeTrace(ctx: McpToolContext, args: { operation: string; input: Record<string, unknown> }): ToolOutput {
  const allowedSessions = ctx.project
    ? (ctx.db.prepare(`SELECT s.id FROM sessions s WHERE ${IN_PROJECT}`).all(ctx.project) as { id: string }[]).map(r => r.id)
    : undefined;
  const result = runWorkbench(ctx.db, args.operation, args.input, { indexPath: ctx.opts.indexPath, allowedSessions });
  // Future workbench fields are private by default: every string becomes an excerpt. Arrays of text become
  // objects so their content also lives under an explicit *_excerpt key. No arbitrary trace key escapes this walk.
  const convert = (value: unknown): unknown => {
    if (typeof value === 'string') return { text_excerpt: excerpt(value, MCP_LIMITS.excerptChars, ctx.opts.redact) };
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => typeof v === 'string'
      ? [key.endsWith('_excerpt') ? key : `${key}_excerpt`, excerpt(v, MCP_LIMITS.excerptChars, ctx.opts.redact)]
      : [key, convert(v)]));
  };
  return { body: { analysis: convert(result) } };
}

/** Apply fn to each (object, key) that a dotted path names; `name[]` steps into every element of an array. */
function atPath(node: unknown, segments: string[], fn: (parent: Record<string, unknown>, key: string) => void): void {
  if (!node || typeof node !== 'object') return;
  const [seg, ...rest] = segments;
  const key = seg.replace(/\[\]$/, '');
  const obj = node as Record<string, unknown>;
  if (!rest.length) {
    if (key in obj) fn(obj, key);
    return;
  }
  const next = obj[key];
  for (const item of seg.endsWith('[]') ? (Array.isArray(next) ? next : []) : [next]) atPath(item, rest, fn);
}

/**
 * MCP form of the Run report and the Lens payload (schemas.ts): MCP_DROPPED keys removed, every MCP_TRACE_TEXT key
 * renamed to its `_excerpt` key, redacted and cut. Output heads and tails follow `outputChars`; tails keep their end.
 */
export function toMcpForm(value: unknown, kind: 'run_report' | 'get_episode', opts: { outputChars: number; redact?: McpServerOptions['redact'] }): unknown {
  const out = structuredClone(value);
  for (const path of MCP_DROPPED[kind]) atPath(out, path.split('.'), (parent, key) => delete parent[key]);
  for (const [path, renamed] of Object.entries(MCP_TRACE_TEXT[kind])) {
    atPath(out, path.split('.'), (parent, key) => {
      const v = parent[key];
      delete parent[key];
      const text = v == null ? null : String(v);
      parent[renamed] = renamed === 'tail_excerpt'
        ? excerptTail(text, opts.outputChars, opts.redact)
        : excerpt(text, renamed === 'head_excerpt' ? opts.outputChars : MCP_LIMITS.excerptChars, opts.redact);
    });
  }
  return out;
}

/** Strip the derived envelope from a payload that embeds it (the Run report, the Lens). */
function payload<T extends { scope?: unknown; analysisVersion?: unknown }>(r: T): Omit<T, 'scope' | 'analysisVersion'> {
  const { scope: _scope, analysisVersion: _version, ...rest } = r;
  return rest;
}

// ---------------------------------------------------------------------------
// The tools

function findRuns(ctx: McpToolContext, a: FindRunsInput): ToolOutput {
  const r = ctx.derived.findRuns({
    ...(a.cwd !== undefined && { cwd: absolutePath(ctx, a.cwd) }),
    ...(a.agent && { agent: a.agent }),
    ...(a.since !== undefined && { since: time(ctx, a.since, 'since') }),
    ...(a.exclude_session && { excludeSession: a.exclude_session }),
  });
  return {
    body: {
      runs: r.runs.map((x) => ({
        id: x.root, agent: x.agent, title_excerpt: ex(ctx, x.title), cwd_excerpt: ex(ctx, x.cwd), start: x.start, end: x.end,
        status: x.status, unattended: x.unattended, attention: x.attention, worst_impact: x.worstImpact,
        silent_child: x.silentChild, unverified_claims: x.unverifiedClaims, open_alarms: x.openAlarms,
      })),
    },
    analysisVersion: r.analysisVersion,
    gaps: r.gaps,
  };
}

function runReport(ctx: McpToolContext, ref: RunRef, since: number | undefined): ToolOutput {
  const resolved = ctx.derived.resolveRun(ref);
  const r = resolved.id ? ctx.derived.runReport(resolved.id, since === undefined ? {} : { since }) : null;
  return {
    body: {
      report: r ? toMcpForm(payload(r), 'run_report', { outputChars: MCP_LIMITS.excerptChars, redact: ctx.opts.redact }) : null,
      resolved: {
        id: r ? resolved.id : null,
        rule: r ? resolved.rule : 'not-found',
        candidates: resolved.candidates.slice(0, 5).map((c) => ({
          id: c.id, agent: c.agent, title_excerpt: ex(ctx, c.title), cwd_excerpt: ex(ctx, c.cwd), end: c.end, status: c.status,
        })),
      },
    },
    ...(r && { analysisVersion: r.analysisVersion }),
    gaps: r?.gaps ?? [],
  };
}

const CURSOR = /^lf1:(\d{1,9})$/;
const SECTIONS: Record<string, readonly EpisodeSection[]> = { attention: ['blocked', 'unrecovered'], all: EPISODE_SECTIONS };

/**
 * Episodes of the requested sections in attention order. The queue answers one section per call, so the sections
 * are read in turn and the cursor is an offset into their concatenation.
 */
function listFailures(ctx: McpToolContext, a: ListFailuresInput): ToolOutput {
  const limit = a.limit ?? MCP_LIMITS.listFailuresMax;
  let offset = 0;
  if (a.cursor !== undefined) {
    const m = CURSOR.exec(a.cursor);
    if (!m) throw new ToolInputError('cursor is not one this server returned; pass next_cursor unchanged');
    offset = Number(m[1]);
  }
  const empty = { body: { episodes: [], total: 0, next_cursor: null } };
  const session = a.session === undefined ? undefined : sessionRef(ctx, a.session);
  if (session === null) return empty;
  const base: QueueQuery = {
    group: 'attention',
    sort: 'attention',
    ...(session !== undefined && { session, descendants: true }),
    ...(a.since !== undefined && { since: time(ctx, a.since, 'since') }),
    ...(a.tier && { tier: [a.tier] }),
    ...(a.family && { family: [a.family] }),
    ...(a.signature && { signature: a.signature }),
  };
  const rows: { row: QueueRow; section: EpisodeSection }[] = [];
  const gaps: Gap[] = [];
  let analysisVersion: number | null | undefined;
  let total = 0;
  let skip = offset;
  for (const section of SECTIONS[a.section ?? 'attention'] ?? [a.section as EpisodeSection]) {
    const need = limit - rows.length;
    // With nothing left to fetch, one row still reads the section's total.
    const page = ctx.derived.failuresQueue({ ...base, section, offset: need > 0 ? skip : 0, limit: Math.max(need, 1) });
    analysisVersion = page.analysisVersion;
    gaps.push(...page.gaps);
    total += page.total;
    if (need <= 0) continue;
    if (skip >= page.total) skip -= page.total;
    else {
      rows.push(...page.rows.filter((r) => r.kind === 'episode').slice(0, need).map((row) => ({ row, section })));
      skip = 0;
    }
  }
  const evidence = episodeEvidence(ctx, rows.map((r) => r.row));
  const next = offset + rows.length;
  return {
    body: {
      episodes: rows.map((r) => episodeRow(ctx, r.row, r.section, evidence.get(r.row.id)!)),
      total,
      next_cursor: rows.length && next < total ? `lf1:${next}` : null,
    },
    analysisVersion,
    gaps,
  };
}

type Evidence = Pick<EpisodeItem,
  'id' | 'sessionId' | 'turnId' | 'targetKey' | 'sigId' | 'family' | 'tier' | 'outcome' | 'outcomeSrc' | 'nAttempts' | 'wallUs' |
  'wallSrc' | 'openerEventId' | 'lastEventId' | 'closerEventId'>;

/**
 * The episode facts behind queue rows, with their evidence event ids (QueueRow carries neither): each session's
 * episodes whose newest evidence is at or after its oldest row. An episode missing there (an index run committed
 * between the reads) is read from its Lens.
 */
function episodeEvidence(ctx: McpToolContext, rows: QueueRow[]): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  const since = new Map<string, number>();
  for (const r of rows) if (r.sessionId) since.set(r.sessionId, Math.min(since.get(r.sessionId) ?? Infinity, r.ts));
  const PAGE = 500;
  for (const [session, from] of since) {
    const want = rows.filter((r) => r.sessionId === session).map((r) => r.id);
    for (let offset = 0; ; offset += PAGE) {
      const page = ctx.derived.episodes({ session, descendants: false, since: from, limit: PAGE, offset });
      for (const e of page.rows) out.set(e.id, e);
      if (page.rows.length < PAGE || want.every((id) => out.has(id))) break;
    }
  }
  for (const r of rows) {
    if (out.has(r.id)) continue;
    const lens = ctx.derived.episode(r.id, { outputChars: 0 });
    if (!lens) throw new QueryError(`Episode ${r.id} changed while it was read; call again`, 409, 'changed');
    const ep = lens.episode;
    out.set(r.id, {
      id: r.id, sessionId: r.sessionId ?? '', turnId: r.turnId, targetKey: ep.targetKey, sigId: ep.signature.id,
      family: ep.signature.family, tier: ep.tier, outcome: ep.outcome, outcomeSrc: ep.outcomeSrc, nAttempts: ep.nAttempts,
      wallUs: ep.wallUs, wallSrc: ep.wallSrc, openerEventId: lens.attempts[0]?.eventId ?? '',
      lastEventId: lens.attempts.at(-1)?.eventId ?? '', closerEventId: lens.close.kind === 'recovered' ? lens.close.eventId : null,
    });
  }
  return out;
}

function episodeRow(ctx: McpToolContext, r: QueueRow, section: EpisodeSection, e: Evidence): Body {
  return {
    id: e.id,
    session_id: e.sessionId,
    turn_id: e.turnId,
    ts: r.ts,
    agent: r.agent ?? agentOf(e.sessionId),
    section,
    target_excerpt: ex(ctx, e.targetKey),
    signature_excerpt: ex(ctx, r.signature),
    signature_id: e.sigId,
    family: e.family,
    tier: e.tier,
    outcome: e.outcome,
    outcome_src: e.outcomeSrc,
    attempts: e.nAttempts,
    wall_us: e.wallUs,
    wall_src: e.wallSrc,
    // A signature is seen at least in the episode's own session.
    seen_sessions: r.seenSessions ?? 1,
    live: r.live,
    error_line_excerpt: ex(ctx, r.errorLine),
    evidence: { opener_event: e.openerEventId, last_event: e.lastEventId, closer_event: e.closerEventId },
  };
}

function getEpisode(ctx: McpToolContext, a: GetEpisodeInput): ToolOutput {
  const outputChars = a.output_chars ?? MCP_LIMITS.episodeOutputCharsDefault;
  const r = ctx.derived.episode(a.id, { outputChars });
  return {
    body: { episode: r ? toMcpForm(payload(r), 'get_episode', { outputChars, redact: ctx.opts.redact }) : null },
    ...(r && { analysisVersion: r.analysisVersion }),
    gaps: r?.gaps ?? [],
  };
}

function lookupError(ctx: McpToolContext, a: LookupErrorInput): ToolOutput {
  if ((a.text === undefined) === (a.signature_id === undefined)) throw new ToolInputError('pass exactly one of text or signature_id');
  if (a.text !== undefined && Buffer.byteLength(a.text) > MCP_LIMITS.lookupTextBytes) {
    throw new ToolInputError(`text is ${Buffer.byteLength(a.text)} UTF-8 bytes; at most ${MCP_LIMITS.lookupTextBytes} are accepted, so pass the error lines only`);
  }
  const r = ctx.derived.lookupError(a.text !== undefined ? { text: a.text } : { signatureId: a.signature_id });
  const fixes = r.fixes.slice(0, 3);
  return {
    body: {
      normalized_excerpt: ex(ctx, r.normalized),
      signature: r.signature ? { id: r.signature.id, text_excerpt: ex(ctx, r.signature.text) } : null,
      family: r.family,
      match: r.match,
      sessions: r.sessions,
      recovered_rate: r.recoveredRate,
      status: r.status,
      fixes: fixes.map((f) => ({ kind: f.kind, pattern_excerpt: ex(ctx, f.pattern), n: f.n, of: f.of, example_episode: f.exampleEpisode, verified: false })),
      advice_kind: r.adviceKind,
    },
    analysisVersion: r.analysisVersion,
    gaps: r.gaps,
    cut: r.fixes.length > fixes.length ? [{ path: 'fixes', reason: 'limit', omitted: r.fixes.length - fixes.length }] : [],
  };
}

function watch(ctx: McpToolContext, a: WatchInput): ToolOutput {
  const r = ctx.derived.watch({ session: a.session, ...(a.cursor !== undefined && { cursor: a.cursor }) });
  return {
    body: {
      cursor: r.cursor,
      session_id: r.sessionId,
      new_episodes: r.newEpisodes.map((e) => ({
        id: e.id, target_excerpt: ex(ctx, e.targetKey), signature_excerpt: ex(ctx, e.signature), signature_id: e.signatureId,
        family: e.family, outcome: e.outcome, attempts: e.attempts, error_line_excerpt: ex(ctx, e.errorLine),
      })),
      updated_episodes: r.updatedEpisodes.map((e) => ({
        id: e.id, attempts: e.attempts, identical_retries: e.identicalRetries, edits_between: e.editsBetween, outcome: e.outcome,
      })),
      alarms: r.alarms.map((x) => ({
        id: x.id, kind: x.kind, state: x.state, turn_id: x.turnId, episode_id: x.episodeId, delegation_id: x.delegationId,
        first_ts: x.firstTs, last_ts: x.lastTs, cleared_ts: x.clearedTs, notify: x.notify,
      })),
      new_claims: r.newClaims.map((c) => ({ turn_id: c.turnId, evidence: c.evidence, ts: c.ts, final_event: c.finalEventId })),
      turn_open: r.turnOpen,
      stalled_for_s: r.stalledForS,
    },
    analysisVersion: r.analysisVersion,
    gaps: r.gaps,
  };
}

function eventRow(ctx: McpToolContext, e: EventRow): Body {
  return {
    id: e.id, ts: e.ts, session_id: e.session, kind: e.kind, actor: e.actor, tool_name: e.toolName, model: e.model,
    dur_us: e.dur, tok_in: e.tokIn, tok_out: e.tokOut, flags: e.flags, summary_excerpt: ex(ctx, e.summary),
  };
}

function query(ctx: McpToolContext, a: QueryInput): ToolOutput {
  const limit = a.limit ?? 50;
  const none = { body: { rows: [], total: 0, filter_error: null } };
  let sessions: string[] | undefined;
  if (a.session !== undefined) {
    const id = sessionRef(ctx, a.session);
    if (id === null || !inProject(ctx, id)) return none;
    sessions = [id];
  } else if (ctx.project) {
    sessions = projectRoots(ctx);
    // An empty list would mean "every session" to createView.
    if (!sessions.length) return none;
  }
  let view;
  try {
    view = ctx.queries.createView({
      filter: a.filter, sessions, descendants: true, sort: 'ts', order: 'desc',
      ...(a.since !== undefined && { from: time(ctx, a.since, 'since') }),
    });
  } catch (e) {
    const fe = e as { message: string; start?: unknown; end?: unknown };
    if (typeof fe.start === 'number' && typeof fe.end === 'number') {
      return { body: { rows: [], total: null, filter_error: { message: fe.message, start: fe.start, end: fe.end } } };
    }
    throw e;
  }
  const rows = ctx.queries.viewRows(view.viewId, 0, limit);
  return {
    body: { rows: rows.map((r) => eventRow(ctx, r)), total: view.count, filter_error: null },
    cut: view.count > rows.length ? [{ path: 'rows', reason: 'limit', omitted: view.count - rows.length }] : [],
  };
}

function getEvent(ctx: McpToolContext, a: GetEventInput): ToolOutput {
  const max = a.max_chars ?? MCP_LIMITS.eventMaxCharsDefault;
  const d = ctx.queries.getEvent(a.id);
  if (!d || !inProject(ctx, d.event.session)) {
    return {
      body: {
        event: null, derived: null, attrs_excerpt: null, output_head_excerpt: null, output_tail_excerpt: null,
        ...(ctx.opts.allowRaw && { native_excerpt: null }),
      },
    };
  }
  let derived: EventDerived | null = null;
  try {
    derived = ctx.derived.eventDerived(a.id);
  } catch (e) {
    if (!(e instanceof DerivedUnavailableError)) throw e;
  }
  const attrs = structuredClone(d.event.attrs) as Attrs;
  const output = attrs.tool?.output;
  const outputTail = attrs.tool?.output_tail;
  if (attrs.tool) {
    delete attrs.tool.output;
    delete attrs.tool.output_tail;
  }
  const e = d.event;
  return {
    body: {
      event: {
        id: e.id, ts: e.ts, ts_src: e.tsSrc, seq: e.seq, kind: e.kind, proto: e.proto, actor: e.actor, session_id: e.session,
        turn_id: e.turn, span_id: e.span, tool_name: e.toolName, model: e.model, dur_us: e.dur, tok_in: e.tokIn, tok_out: e.tokOut,
        flags: e.flags, summary_excerpt: ex(ctx, e.summary),
      },
      derived: derived && (derived.step || derived.failure || derived.episode)
        ? {
          step_id: derived.step?.id ?? null,
          tier: derived.failure?.tier ?? null,
          family: derived.failure?.family ?? null,
          signature_id: derived.failure?.signatureId ?? null,
          episode_id: derived.episode?.id ?? derived.failure?.episodeId ?? null,
          target_key_excerpt: ex(ctx, derived.failure?.targetKey),
        }
        : null,
      attrs_excerpt: ex(ctx, JSON.stringify(attrs), max),
      output_head_excerpt: ex(ctx, typeof output === 'string' ? output : null, max),
      output_tail_excerpt: excerptTail(typeof outputTail === 'string' ? outputTail : null, max, ctx.opts.redact),
      ...(ctx.opts.allowRaw && { native_excerpt: ex(ctx, e.native === null ? null : JSON.stringify(e.native), max) }),
    },
    ...(derived && { analysisVersion: derived.analysisVersion }),
    gaps: derived?.gaps ?? [],
  };
}

// ---------------------------------------------------------------------------
// JSON Schema (the subset schemas.ts uses): inputs at run time, outputs in the tests.

function hasType(t: string, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return !!v && typeof v === 'object' && !Array.isArray(v);
    default: return false;
  }
}

/** Problems of `value` against `schema`, each as `<path>: <what>`; empty when it conforms. */
export function validate(schema: JsonSchema, value: unknown, root: JsonSchema = schema, path = '$'): string[] {
  const s = schema as Record<string, any>;
  if (s.$ref) return validate(root.$defs && (root.$defs as any)[String(s.$ref).slice('#/$defs/'.length)], value, root, path);
  if (s.anyOf) {
    const fits = (s.anyOf as JsonSchema[]).map((sub) => validate(sub, value, root, path));
    return fits.some((p) => !p.length) ? [] : fits.reduce((a, b) => (b.length < a.length ? b : a));
  }
  const out: string[] = [];
  if ('const' in s && value !== s.const) out.push(`${path}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !(s.enum as unknown[]).includes(value)) out.push(`${path}: must be one of ${(s.enum as unknown[]).map((x) => JSON.stringify(x)).join(', ')}`);
  if (s.type) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => hasType(t, value))) return [...out, `${path}: expected ${types.join(' or ')}`];
  }
  if (typeof value === 'string') {
    if (s.maxLength !== undefined && [...value].length > s.maxLength) out.push(`${path}: longer than ${s.maxLength} characters`);
    if (s.pattern && !new RegExp(s.pattern).test(value)) out.push(`${path}: does not match ${s.pattern}`);
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) out.push(`${path}: below ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) out.push(`${path}: above ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.maxItems !== undefined && value.length > s.maxItems) out.push(`${path}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => out.push(...validate(s.items, v, root, `${path}[${i}]`)));
  }
  if (hasType('object', value)) {
    const obj = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in obj)) out.push(`${path}: missing ${k}`);
    for (const [k, v] of Object.entries(obj)) {
      if (s.propertyNames?.enum && !s.propertyNames.enum.includes(k)) out.push(`${path}: unexpected key ${k}`);
      if (s.properties && k in s.properties) out.push(...validate(s.properties[k], v, root, `${path}.${k}`));
      else if (s.additionalProperties === false) out.push(`${path}: unexpected key ${k}`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push(...validate(s.additionalProperties, v, root, `${path}.${k}`));
    }
  }
  return out;
}
