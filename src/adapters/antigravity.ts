// Google Antigravity conversations (SPEC §4.3): `~/.gemini/antigravity/conversations/<id>.db` (and `antigravity-ide/`),
// plus `brain/<id>/.system_generated/logs/transcript_full.jsonl` (or `transcript.jsonl`), which recovers conversations
// whose primary file is an encrypted `.pb` and supplies live uncheckpointed `.db-wal` steps with verified JSONL byte
// offsets. Also exports shared Cortex trajectory discovery/parsing for Gemini macOS App Code Mode (`source === 21`).

import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AgentKind, AgentPrefix, Attrs, EventFlag, EventKind, EventRec, IndexRecord, SpanRec, SpanStatus, TokenUsage } from '../model/types.ts';
import {
  type Adapter, type DiscoverEnv, type LineInfo, type ParseContext, type ParseStats, type RecordSink, type SourceFile,
  INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, agentRoots, compact, editChanges, emptyStats, eventId, fileInfo,
  fromFileUri, isoToUs, oneLine, outputTail, readJsonl, sourceId, spanId, summarizeToolInput, toolKind, truncate, tryJson,
} from './adapter.ts';
import { openReadOnly } from './codex-state.ts';

/** CortexTrajectorySource value for the native macOS Gemini.app (`com.google.GeminiMacOS`) Code Mode server. */
export const CORTEX_SOURCE_GEMINI_APP = 21;

const TRAJECTORY_ENTRYPOINTS: Record<number, string> = {
  1: 'app', // CASCADE_CLIENT (Antigravity desktop app)
  12: 'cli', // INTERACTIVE_CASCADE
  15: 'sdk', // SDK
  17: 'cli', // CLI
  19: 'api', // AGENT_API
  21: 'app', // GEMINI_APP (Gemini macOS app)
  22: 'ide', // VSCODE / Antigravity IDE
  23: 'ide', // VISUAL_STUDIO
};

// CortexStepType values the adapter decodes.
const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const FINISH = 2;
const ERROR_MESSAGE = 17;
const CHECKPOINT = 23;
const MCP_TOOL = 38;
const TASK_BOUNDARY = 81;
const NOTIFY_USER = 82;
const WAIT = 102;
const CRITIQUE = 118;
const FINDINGS = 119;
const ASK_QUESTION = 138;
const CONTEXT_STEPS: Record<number, string> = {
  29: 'memory', 34: 'retrieved memory', 55: 'brain update', 89: 'knowledge generation',
  90: 'ephemeral message', 98: 'conversation history', 99: 'knowledge artifacts',
  101: 'system message', 116: 'knowledge insertion', 139: 'directory rules',
};

// CortexStepStatus values; the others (pending, running, generating, queued, waiting) leave a step open.
const DONE = 3;
const INVALID = 4;
const CLEARED = 5;
const CANCELED = 6;
const ERROR = 7;
const INTERRUPTED = 12;
const STATUS: Record<number, SpanStatus> = {
  [DONE]: 'ok', [INVALID]: 'cancelled', [CLEARED]: 'cancelled', [CANCELED]: 'cancelled', [ERROR]: 'error', [INTERRUPTED]: 'interrupted',
};

const TEXT_STATUS: Record<string, SpanStatus> = {
  DONE: 'ok', INVALID: 'cancelled', CLEARED: 'cancelled', CANCELED: 'cancelled', CANCELLED: 'cancelled', ERROR: 'error', INTERRUPTED: 'interrupted',
};

// CortexStepSource: an implicit user step is input the harness sent on the user's behalf.
const USER_IMPLICIT = 3;

const STOP_REASONS: Record<number, string> = {
  1: 'incomplete', 2: 'stop', 3: 'max_tokens', 10: 'function_call', 11: 'content_filter', 13: 'error', 15: 'other', 16: 'client_canceled',
};

// Field numbers of gemini_coder.Step and the exa.cortex_pb / exa.codeium_common_pb messages it holds.
const STEP = {
  type: 1, status: 4, metadata: 5, userInput: 19, planner: 20, errorMessage: 24, runCommand: 28,
  error: 31, requested: 56, shellExec: 127, generic: 140, invokeSubagent: 143, completed: 147,
};
const META = { created: 1, source: 3, toolCall: 4, completed: 8, usage: 9, finishedGenerating: 7 };
const CALL = { id: 1, name: 2, args: 3 };
const USAGE = { input: 2, output: 3, cacheWrite: 4, cacheRead: 5, messageId: 7, thinking: 9 };
const CHAT = { usage: 4, retries: 14, ttft: 11, streaming: 12, model: 19, display: 21 };

export interface CortexTarget {
  agent: AgentKind;
  prefix: AgentPrefix;
  protoPrefix: string;
}

const ANTIGRAVITY_TARGET: CortexTarget = { agent: 'antigravity', prefix: 'ag', protoPrefix: 'antigravity' };

/** Group `conversations/<id>.db` and `brain/<id>/.system_generated/logs/transcript*.jsonl` so checkpointing re-parses both. */
export function trajectoryGroupKey(path: string): string | undefined {
  const norm = path.replaceAll('\\', '/');
  const dbMatch = /\/conversations\/([^/]+)\.db$/.exec(norm);
  if (dbMatch) return dbMatch[1];
  const trMatch = /\/brain\/([^/]+)\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/.exec(norm);
  if (trMatch) return trMatch[1];
  return undefined;
}

/** Normalize a configured root that may point at `<root>`, `<root>/conversations`, or `<root>/brain`. */
function normalizeCortexBase(root: string): string {
  const b = basename(root);
  return b === 'conversations' || b === 'brain' ? dirname(root) : root;
}

/** Fast read-only peek of `trajectory_meta.source` or `conversation_summaries.source` for a conversation. */
export function peekTrajectorySource(baseDir: string, conv: string): number | undefined {
  let db;
  try {
    db = openReadOnly(join(baseDir, 'conversations', `${conv}.db`));
    const row = db.prepare('SELECT source FROM trajectory_meta LIMIT 1').get() as { source?: unknown } | undefined;
    if (typeof row?.source === 'number') return row.source;
  } catch {
    // Missing or unreadable .db; fall back to conversation_summaries.db.
  } finally {
    db?.close();
  }
  let sumDb;
  try {
    sumDb = openReadOnly(join(baseDir, 'conversation_summaries.db'));
    const row = sumDb.prepare('SELECT source FROM conversation_summaries WHERE conversation_id = ?').get(conv) as { source?: unknown } | undefined;
    if (typeof row?.source === 'number') return row.source;
  } catch {
    // Summaries database absent or without a row.
  } finally {
    sumDb?.close();
  }
  return undefined;
}

/** Shared discovery for Cortex stores (`antigravity` takes non-21 trajectories; `gemini` takes `source === 21`). */
export async function discoverCortexSources(
  env: DiscoverEnv,
  roots: string[],
  targetAgent: 'antigravity' | 'gemini',
  adapterName: string,
): Promise<SourceFile[]> {
  if (env.agents && !env.agents.includes(targetAgent)) return [];
  const out: SourceFile[] = [];
  const seenDb = new Set<string>();
  const seenTranscript = new Set<string>();
  const bases = [...new Set(roots.map(normalizeCortexBase))];

  for (const base of bases) {
    const matchesTarget = (conv: string): boolean => {
      const src = peekTrajectorySource(base, conv);
      return targetAgent === 'gemini' ? src === CORTEX_SOURCE_GEMINI_APP : src !== CORTEX_SOURCE_GEMINI_APP;
    };

    const convDir = join(base, 'conversations');
    const convEntries = await readdir(convDir).catch(() => [] as string[]);
    for (const name of convEntries) {
      if (!name.endsWith('.db')) continue;
      const conv = name.slice(0, -3);
      if (seenDb.has(conv) || !matchesTarget(conv)) continue;
      const f = await fileInfo(join(convDir, name), targetAgent, 'trajectory-db', adapterName);
      if (f) {
        seenDb.add(conv);
        out.push(f);
      }
    }

    const brainDir = join(base, 'brain');
    const brainEntries = await readdir(brainDir, { withFileTypes: true }).catch(() => []);
    for (const entry of brainEntries) {
      if (!entry.isDirectory()) continue;
      const conv = entry.name;
      if (seenTranscript.has(conv) || !matchesTarget(conv)) continue;
      const logsDir = join(brainDir, conv, '.system_generated', 'logs');
      const full = await fileInfo(join(logsDir, 'transcript_full.jsonl'), targetAgent, 'antigravity-transcript', adapterName);
      const compactLog = full ?? await fileInfo(join(logsDir, 'transcript.jsonl'), targetAgent, 'antigravity-transcript', adapterName);
      if (compactLog) {
        seenTranscript.add(conv);
        out.push(compactLog);
      }
    }
  }
  return out;
}

export async function parseCortexSource(ctx: ParseContext, sink: RecordSink, target: CortexTarget = ANTIGRAVITY_TARGET): Promise<ParseStats> {
  const isTranscript = ctx.file.kind === 'antigravity-transcript';
  const base = isTranscript ? dirname(dirname(dirname(dirname(dirname(ctx.file.path))))) : dirname(dirname(ctx.file.path));
  const conv = trajectoryGroupKey(ctx.file.path) ?? basename(ctx.file.path, '.db');
  const dbFile = isTranscript ? await fileInfo(join(base, 'conversations', `${conv}.db`), target.agent, 'trajectory-db', ctx.file.adapter) : ctx.file;
  const logs = join(base, 'brain', conv, '.system_generated', 'logs');
  const transcriptFile = isTranscript ? ctx.file :
    await fileInfo(join(logs, 'transcript_full.jsonl'), target.agent, 'antigravity-transcript', ctx.file.adapter)
    ?? await fileInfo(join(logs, 'transcript.jsonl'), target.agent, 'antigravity-transcript', ctx.file.adapter);
  const dbRecords: IndexRecord[] = [];
  const transcriptRecords: IndexRecord[] = [];
  let dbStats = emptyStats();
  if (dbFile) {
    try {
      dbStats = await parseTrajectoryDb({ ...ctx, file: dbFile, sourceId: sourceId(dbFile.path) }, { emit: r => { dbRecords.push(r); } }, target);
    } catch (error) {
      if (!isTranscript) throw error;
      // A missing/unreadable checkpoint must not prevent recovery from the transcript.
      dbRecords.length = 0;
    }
  }
  const transcriptStats = transcriptFile ? await parseTranscriptJsonl(
    { ...ctx, file: transcriptFile, sourceId: sourceId(transcriptFile.path) },
    { emit: r => { transcriptRecords.push(r); } }, target, dbRecords,
  ) : emptyStats();

  // Each turn keeps one source owner. Both parser jobs compute the same complete bounds, so worker
  // completion order cannot overwrite a full turn with a checkpoint-only version.
  const combined = [...dbRecords, ...transcriptRecords];
  const turns = new Map(combined.filter((r): r is SpanRec => r.rec === 'span' && r.kind === 'turn').map(r => [r.id, r]));
  const last = new Map<string, EventRec>();
  for (const r of combined) {
    if (r.rec !== 'event' || !r.turn) continue;
    const turn = turns.get(r.turn);
    if (!turn) continue;
    turn.end = Math.max(turn.end ?? turn.start, r.ts);
    const previous = last.get(turn.id);
    if (!previous || r.ts >= previous.ts) { last.set(turn.id, r); turn.lastEvent = r.id; }
    if (r.flags?.includes('error') && r.kind.startsWith('llm.')) turn.status = 'error';
  }
  for (const turn of turns.values()) if (turn.end !== undefined) turn.dur = turn.end - turn.start;
  for (const r of isTranscript ? transcriptRecords : dbRecords) sink.emit(r);
  return isTranscript ? transcriptStats : dbStats;
}

export const antigravityAdapter: Adapter = {
  name: 'antigravity',
  groupKey: trajectoryGroupKey,

  async discover(env) {
    return discoverCortexSources(env, agentRoots(env, 'antigravity'), 'antigravity', 'antigravity');
  },

  async parse(ctx, sink) {
    return parseCortexSource(ctx, sink, ANTIGRAVITY_TARGET);
  },
};

// ---------------------------------------------------------------------------
// SQLite trajectory-db parser (`conversations/<id>.db`)

async function parseTrajectoryDb(ctx: ParseContext, sink: RecordSink, target: CortexTarget): Promise<ParseStats> {
  const { path } = ctx.file;
  const stats: ParseStats = { ...emptyStats(), parsedBytes: ctx.file.size, dialect: 'trajectory-db' };
  const metadataErrors: string[] = [];
  const metadata = (data: Uint8Array | null | undefined, label: string): Pb => {
    try {
      return pb(data);
    } catch (e) {
      stats.malformed++;
      metadataErrors.push(`${label}: ${(e as Error).message}`);
      return new Map();
    }
  };
  const db = openReadOnly(path);
  let rows: { idx: number; step_type: number; status: number; step_format: number; step_payload: Uint8Array | null; metadata: Uint8Array | null; error_details: Uint8Array | null }[];
  let traj: { trajectory_id?: string; cascade_id?: string; trajectory_type?: number; source?: number } | undefined;
  let tmeta: Pb;
  let gens: Pb[];
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
    if (!tables.has('steps')) {
      stats.skipped = 1;
      return stats;
    }
    const version = (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version;
    if (version) stats.dialect = `trajectory-db v${version}`;
    rows = db.prepare('SELECT idx, step_type, status, step_format, step_payload, metadata, error_details FROM steps ORDER BY idx').all() as typeof rows;
    if (tables.has('trajectory_meta')) {
      const cols = new Set((db.prepare('PRAGMA table_info(trajectory_meta)').all() as { name: string }[]).map((c) => c.name));
      const srcCol = cols.has('source') ? ', source' : '';
      traj = db.prepare(`SELECT trajectory_id, cascade_id, trajectory_type${srcCol} FROM trajectory_meta LIMIT 1`).get() as typeof traj;
    }
    const blob = tables.has('trajectory_metadata_blob') ? db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data?: Uint8Array } | undefined : undefined;
    tmeta = metadata(blob?.data, 'trajectory metadata');
    gens = tables.has('gen_metadata') ? (db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as { idx: number; data: Uint8Array | null }[]).map((g) => metadata(g.data, `generator ${g.idx}`)) : [];
  } finally {
    db.close();
  }
  stats.lines = rows.length;
  if (!rows.length) {
    stats.skipped = 1;
    return stats;
  }

  const baseDir = dirname(dirname(path));
  const conv = traj?.cascade_id || basename(path, '.db');
  const session = `${target.prefix}:${conv}`;
  for (const message of metadataErrors) sink.emit({ rec: 'expert', session, severity: 'warn', group: 'malformed', message });
  const summary = await readSummary(join(baseDir, 'conversation_summaries.db'), conv);
  const chatByStep = new Map<number, Pb>();
  for (const g of gens) for (const i of ints(g, 2)) chatByStep.set(i, sub(g, 1));

  const events: EventRec[] = [];
  const spans: SpanRec[] = [];
  const models = new Set<string>();
  const undecoded = new Set<number>();
  let turn: SpanRec | undefined;
  let turnIndex = 0;
  let lastTs = 0;

  for (const row of rows) {
    let step: Pb;
    let meta: Pb;
    let errorText: string | undefined;
    try {
      if (row.step_format !== 0) throw new Error(`step format ${row.step_format}`);
      step = pb(row.step_payload);
      meta = step.has(STEP.metadata) ? sub(step, STEP.metadata) : pb(row.metadata);
      errorText = errorMessage(row.error_details ? pb(row.error_details) : sub(step, STEP.error));
    } catch (e) {
      stats.malformed++;
      sink.emit({ rec: 'expert', session, severity: 'warn', group: 'malformed', message: `step ${row.idx}: ${(e as Error).message}` });
      continue;
    }
    const type = int(step, STEP.type) ?? row.step_type;
    const status = int(step, STEP.status) ?? row.status;
    const created = time(meta, META.created);
    const completed = time(meta, META.completed);
    const call = sub(meta, META.toolCall);
    let block = 0;
    const emit = (kind: EventKind, actor: EventRec['actor'], summaryText: string, attrs: Attrs, at = created, flags?: EventFlag[]) => {
      const ts = at ?? lastTs;
      const ev: EventRec = {
        rec: 'event', id: eventId(ctx.sourceId, row.idx + 1, block), session, ts, tsSrc: at !== undefined ? 'logged' : lastTs ? 'inherited' : 'none',
        seq: events.length, kind, proto: `${target.protoPrefix}/${type}`, actor, summary: summaryText, attrs, native: block === 0 ? nativeOf(step, meta) : undefined,
        raw: { source: ctx.sourceId, line: 0, offset: 0, length: 0, block: row.idx }, flags,
      };
      block++;
      if (at !== undefined) lastTs = Math.max(lastTs, at);
      if (turn) {
        ev.turn = turn.id;
        ev.span = turn.id;
        turn.end = Math.max(turn.end ?? turn.start, ev.ts);
        turn.lastEvent = ev.id;
        if (flags?.includes('error') && kind.startsWith('llm.') && turn.status === 'ok') turn.status = 'error';
      }
      events.push(ev);
      return ev;
    };

    if (type === USER_INPUT) {
      const input = sub(step, STEP.userInput);
      const rawText = str(input, 2) ?? str(input, 1) ?? list(input, 3).map((it) => str(it, 1)).filter(Boolean).join('\n');
      const clean = stripUserRequestTags(rawText);
      const implicit = int(meta, META.source) === USER_IMPLICIT;
      if (!implicit) turn = undefined;
      const ev = emit(implicit ? 'user.inject' : 'user.prompt', 'user', oneLine(clean), {
        text: truncate(clean, INDEX_TEXT_MAX), text_len: clean.length,
        antigravity: { queued: int(input, 6) === 1 || undefined, images: (input.get(5)?.length ?? 0) + (input.get(9)?.length ?? 0) || undefined },
      });
      if (!implicit) {
        turn = {
          rec: 'span', id: spanId(session, 'turn', row.idx), session, kind: 'turn', name: oneLine(clean, 80), start: ev.ts, durSrc: 'derived:ts-gap', status: 'ok',
          firstEvent: ev.id, lastEvent: ev.id, attrs: { turn: { index: turnIndex } },
        };
        ev.turn = ev.span = turn.id;
        ev.attrs.turn = { index: turnIndex++ };
        spans.push(turn);
      }
      continue;
    }

    if (type === PLANNER_RESPONSE) {
      const plan = sub(step, STEP.planner);
      const chat = chatByStep.get(row.idx) ?? new Map();
      const model = str(chat, CHAT.model) ?? str(chat, CHAT.display);
      if (model) models.add(model);
      const usage = chat.has(CHAT.usage) ? sub(chat, CHAT.usage) : sub(meta, META.usage);
      const tokens = tokenUsage(usage);
      const ttft = duration(chat, CHAT.ttft);
      const streaming = duration(chat, CHAT.streaming);
      const finished = time(meta, META.finishedGenerating);
      const logged = ttft !== undefined && streaming !== undefined ? ttft + streaming : undefined;
      const dur = logged ?? (finished !== undefined && created !== undefined && finished >= created ? finished - created : undefined);
      const failed = status === ERROR || errorText !== undefined;
      const stop = int(plan, 12);
      const thinking = str(plan, 3) ?? str(plan, 16);
      const text = str(plan, 8) ?? str(plan, 1) ?? '';
      const tools = list(plan, 7).map((c) => str(c, CALL.name)).filter((n): n is string => !!n);
      const llm = {
        model, display: str(chat, CHAT.display), message_id: str(plan, 6) ?? str(usage, USAGE.messageId),
        stop_reason: stop !== undefined ? STOP_REASONS[stop] ?? `stop_reason_${stop}` : undefined,
        ttft_ms: ttft !== undefined ? ttft / 1000 : undefined, latency_ms: dur !== undefined ? dur / 1000 : undefined,
        retries: int(chat, CHAT.retries) || undefined,
      };
      const end = created !== undefined && dur !== undefined ? created + dur : created;
      const first = thinking ? emit('llm.thinking', 'assistant', oneLine(thinking), { text: truncate(thinking, INDEX_TEXT_MAX), text_len: thinking.length }, end) : undefined;
      const ev = emit('llm.text', 'assistant', text ? oneLine(text) : words('→', tools.join(', ')), {
        text: truncate(text, INDEX_TEXT_MAX), text_len: text.length, llm, tokens, tool_requests: tools.length || undefined,
        error: failed ? { message: truncate(errorText, 1024) } : undefined,
      }, end, failed ? ['error'] : undefined);
      if (failed) sink.emit({ rec: 'expert', session, event: ev.id, severity: 'error', group: 'api-error', message: `${target.agent} model call failed: ${oneLine(errorText ?? 'step status error', 200)}` });
      const start = created ?? ev.ts;
      spans.push({
        rec: 'span', id: spanId(session, 'llm', row.idx), session, kind: 'llm', name: model ?? target.agent, parent: turn?.id, start,
        end: dur !== undefined ? start + dur : undefined, dur,
        durSrc: logged !== undefined ? 'logged:chat_model.time_to_first_token+streaming_duration' : dur !== undefined ? 'logged:metadata.finished_generating_at' : 'unknown',
        status: failed ? 'error' : STATUS[status] ?? 'open', firstEvent: (first ?? ev).id, lastEvent: ev.id, attrs: { llm, tokens },
      });
      for (const e of first ? [first, ev] : [ev]) e.span = spanId(session, 'llm', row.idx);
      ev.dur = dur;
      continue;
    }

    const name = str(call, CALL.name);
    if (name) {
      toolStep(row.idx, type, status, step, call, name, created, completed, errorText, emit, session, target.prefix, spans, turn);
      continue;
    }

    const failed = status === ERROR ? ['error' as const] : undefined;
    if (type === ERROR_MESSAGE) {
      const text = errorMessage(sub(sub(step, STEP.errorMessage), 3)) ?? errorText ?? '';
      const ev = emit('llm.error', 'harness', words('error', oneLine(text, 140)), { error: { message: truncate(text, 1024) } }, created, ['error']);
      sink.emit({ rec: 'expert', session, event: ev.id, severity: 'error', group: 'api-error', message: `${target.agent} error: ${oneLine(text, 200)}` });
    } else if (type === CHECKPOINT) {
      emit('context.compaction', 'harness', 'checkpoint', { context: { type: 'checkpoint' } }, created, failed);
    } else if (type === FINISH) {
      emit('turn.end', 'harness', 'finish', {}, created, failed);
    } else if (type === TASK_BOUNDARY) {
      emit('harness.status', 'assistant', 'task boundary', {}, created, failed);
    } else if (type === NOTIFY_USER) {
      emit('agent.message', 'assistant', 'notify user', {}, created, failed);
    } else if (type === WAIT) {
      emit('harness.status', 'harness', 'wait', {}, created, failed);
    } else if (type === CRITIQUE || type === FINDINGS) {
      emit('llm.thinking', 'assistant', type === CRITIQUE ? 'critique' : 'findings', {}, created, failed);
    } else if (type === ASK_QUESTION) {
      emit('permission.request', 'assistant', 'ask question', {}, created, failed);
    } else if (CONTEXT_STEPS[type]) {
      emit('context.attachment', 'harness', CONTEXT_STEPS[type], { context: { type: CONTEXT_STEPS[type] } }, created, failed);
    } else {
      stats.unknown++;
      const ev = emit('raw.unknown', 'harness', `step type ${type}`, {}, created, failed);
      if (!undecoded.has(type)) {
        undecoded.add(type);
        sink.emit({ rec: 'expert', session, event: ev.id, severity: 'note', group: 'undecoded', message: `Unknown ${target.agent} step type ${type}` });
      }
    }
  }
  if (!events.length) {
    stats.skipped = 1;
    return stats;
  }

  const ws = list(tmeta, 1)[0];
  const cwd = fromFileUri(str(ws, 1)) ?? fromFileUri(strs(tmeta, 7)[0]) ?? fromFileUri(summary?.workspace);
  const root = fromFileUri(str(ws, 2)) ?? cwd;
  const parent = str(tmeta, 5) ?? summary?.parent;
  const srcEnum = traj?.source ?? summary?.source;
  const entrypoint = (srcEnum !== undefined ? TRAJECTORY_ENTRYPOINTS[srcEnum] : undefined)
    ?? (basename(baseDir) === 'antigravity-ide' ? 'ide' : 'app');
  sink.emit({
    rec: 'session',
    id: session,
    agent: target.agent,
    nativeId: conv,
    role: parent ? 'subagent' : 'main',
    parentId: parent ? `${target.prefix}:${parent}` : undefined,
    title: summary?.title,
    cwd,
    project: root ? basename(root) : undefined,
    git: str(ws, 4) ? { branch: str(ws, 4) } : undefined,
    models: [...models],
    entrypoint,
    createdTs: time(tmeta, 2),
    meta: { trajectoryId: traj?.trajectory_id, trajectoryType: traj?.trajectory_type, trajectorySource: srcEnum, projectId: str(tmeta, 18), status: summary?.status },
  });
  for (const ev of events) sink.emit(ev);
  for (const sp of spans) {
    if (sp.kind === 'turn' && sp.end !== undefined) sp.dur = sp.end - sp.start;
    sink.emit(sp);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// JSONL transcript parser (`brain/<id>/.system_generated/logs/transcript_full.jsonl`)

interface PendingCall {
  callId: string;
  name: string;
  kind: ReturnType<typeof toolKind>;
  input: unknown;
  inputSummary: string;
  command?: string;
  callEv: EventRec;
  turnId?: string;
}

function peekTrajectoryWorkspace(dbPath: string): { cwd?: string; root?: string; branch?: string; parent?: string } | undefined {
  let db;
  try {
    db = openReadOnly(dbPath);
    const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data?: Uint8Array } | undefined;
    if (!row?.data?.length) return undefined;
    const tmeta = pb(row.data);
    const ws = list(tmeta, 1)[0];
    const cwd = fromFileUri(str(ws, 1)) ?? fromFileUri(strs(tmeta, 7)[0]);
    const root = fromFileUri(str(ws, 2)) ?? cwd;
    return { cwd, root, branch: str(ws, 4), parent: str(tmeta, 5) };
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

async function parseTranscriptJsonl(ctx: ParseContext, sink: RecordSink, target: CortexTarget, dbRecords: IndexRecord[]): Promise<ParseStats> {
  const { path } = ctx.file;
  const conv = trajectoryGroupKey(path) ?? basename(dirname(dirname(dirname(path))));
  // <base>/brain/<conv>/.system_generated/logs/transcript_full.jsonl → <base> is 4 levels up.
  const baseDir = dirname(dirname(dirname(dirname(dirname(path)))));
  const dbEvents = dbRecords.filter((r): r is EventRec => r.rec === 'event');
  const dbSpans = new Map(dbRecords.filter((r): r is SpanRec => r.rec === 'span').map(r => [r.id, r]));
  const dbSteps = new Map<number, EventRec[]>();
  for (const event of dbEvents) {
    const idx = event.raw.block;
    if (idx !== undefined) dbSteps.set(idx, [...(dbSteps.get(idx) ?? []), event]);
  }
  const replacedSteps = new Set<number>();
  const removedCalls = new Set<EventRec>();
  const hasDbSession = dbRecords.some(r => r.rec === 'session');
  const session = `${target.prefix}:${conv}`;
  const stats: ParseStats = { ...emptyStats(), dialect: basename(path) === 'transcript_full.jsonl' ? 'transcript-full-jsonl' : 'transcript-jsonl' };

  const events: EventRec[] = [];
  const spans: SpanRec[] = [];
  const pendingCalls: PendingCall[] = [];
  const seqOffset = hasDbSession ? 1_000_000 : 0;
  let currentTurnId: string | undefined;
  let currentTurnSpan: SpanRec | undefined;
  let turnIndex = 0;
  let firstPrompt: string | undefined;
  let firstTs: number | undefined;
  let lastTs = 0;

  const readRes = await readJsonl(
    path,
    (rec: Record<string, any>, info: LineInfo) => {
      if (!rec || typeof rec !== 'object') return;
      const stepIdx = typeof rec.step_index === 'number' ? rec.step_index : info.line - 1;
      const createdTs = isoToUs(rec.created_at);
      if (createdTs !== undefined) {
        if (firstTs === undefined) firstTs = createdTs;
        lastTs = Math.max(lastTs, createdTs);
      }
      const stepType = typeof rec.type === 'string' ? rec.type : 'UNKNOWN';
      const stepSrc = typeof rec.source === 'string' ? rec.source : '';

      const checkpoint = dbSteps.get(stepIdx);
      // A present row can still be in progress, or undecodable. A supported transcript record
      // supersedes that row; terminal decoded database records retain their richer metadata.
      const supported = ['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'RUN_COMMAND', 'SHELL_EXEC', 'MCP_TOOL',
        'SYSTEM_MESSAGE', 'CHECKPOINT', 'ERROR_MESSAGE'].includes(stepType);
      const dbOwnsStep = !!checkpoint && (!supported || checkpoint.some(e => {
        const span = e.span ? dbSpans.get(e.span) : undefined;
        return e.kind !== 'raw.unknown' && (!span || span.kind === 'turn' || span.status !== 'open');
      }));
      if (checkpoint && !dbOwnsStep) replacedSteps.add(stepIdx);

      if (stepType === 'USER_INPUT' && stepSrc !== 'USER_IMPLICIT') {
        currentTurnId = spanId(session, 'turn', stepIdx);
        currentTurnSpan = undefined;
        if (dbOwnsStep) turnIndex++;
      }

      // Consume checkpointed results too: a parallel batch may straddle the checkpoint.
      if (dbOwnsStep && ['GENERIC', 'RUN_COMMAND', 'SHELL_EXEC', 'MCP_TOOL'].includes(stepType)) {
        const pending = pendingCalls.shift();
        if (pending) removedCalls.add(pending.callEv);
      }
      if (dbOwnsStep && stepType !== 'PLANNER_RESPONSE') {
        stats.skipped++;
        return;
      }

      let block = 0;
      const emit = (kind: EventKind, actor: EventRec['actor'], summaryText: string, attrs: Attrs, at = createdTs, flags?: EventFlag[]): EventRec => {
        const ts = at ?? lastTs;
        const ev: EventRec = {
          rec: 'event',
          id: eventId(ctx.sourceId, info.line, block === 0 ? undefined : block),
          session,
          ts,
          tsSrc: at !== undefined ? 'logged' : lastTs ? 'inherited' : 'none',
          seq: seqOffset + events.length,
          kind,
          proto: `${target.protoPrefix}/${stepType}`,
          actor,
          summary: summaryText,
          span: currentTurnId,
          turn: currentTurnId,
          attrs,
          native: block === 0 ? compact({ step_index: stepIdx, type: stepType, source: stepSrc, status: rec.status }) : undefined,
          raw: { source: ctx.sourceId, line: info.line, offset: info.offset, length: info.length, ...(block > 0 ? { block } : {}) },
          flags,
        };
        block++;
        if (at !== undefined) lastTs = Math.max(lastTs, at);
        if (currentTurnSpan) {
          currentTurnSpan.end = Math.max(currentTurnSpan.end ?? currentTurnSpan.start, ev.ts);
          currentTurnSpan.lastEvent = ev.id;
          if (flags?.includes('error') && kind.startsWith('llm.') && currentTurnSpan.status === 'ok') currentTurnSpan.status = 'error';
        }
        events.push(ev);
        return ev;
      };

      if (stepType === 'USER_INPUT') {
        const rawContent = typeof rec.content === 'string' ? rec.content : '';
        const clean = stripUserRequestTags(rawContent);
        if (!firstPrompt && clean) firstPrompt = oneLine(clean, 120);
        const implicit = stepSrc === 'USER_IMPLICIT';
        const ev = emit(implicit ? 'user.inject' : 'user.prompt', 'user', oneLine(clean), {
          text: truncate(clean, INDEX_TEXT_MAX), text_len: clean.length,
          antigravity: { media: Array.isArray(rec.media) && rec.media.length ? rec.media.length : undefined },
        });
        if (!implicit) {
          currentTurnId = spanId(session, 'turn', stepIdx);
          currentTurnSpan = {
            rec: 'span', id: currentTurnId, session, kind: 'turn', name: oneLine(clean, 80), start: ev.ts,
            durSrc: 'derived:ts-gap', status: 'ok', firstEvent: ev.id, lastEvent: ev.id, attrs: { turn: { index: turnIndex } },
          };
          ev.turn = ev.span = currentTurnId;
          ev.attrs.turn = { index: turnIndex++ };
          spans.push(currentTurnSpan);
        }
        return;
      }

      if (stepType === 'PLANNER_RESPONSE') {
        const thinking = typeof rec.thinking === 'string' && rec.thinking ? rec.thinking : undefined;
        const text = typeof rec.content === 'string' ? rec.content : '';
        const calls: any[] = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
        const uncached = typeof rec.input_tokens === 'number' ? rec.input_tokens : undefined;
        const cacheRead = typeof rec.cache_read_tokens === 'number' ? rec.cache_read_tokens : undefined;
        const output = typeof rec.output_tokens === 'number' ? rec.output_tokens : undefined;
        const tokens: TokenUsage | undefined = uncached !== undefined || cacheRead !== undefined || output !== undefined
          ? { input: (uncached ?? 0) + (cacheRead ?? 0), uncached, cache_read: cacheRead, output }
          : undefined;
        const failed = rec.status === 'ERROR' || typeof rec.error === 'string';
        const toolNames = calls.map((c) => c?.name).filter((n): n is string => typeof n === 'string' && !!n);

        if (!dbOwnsStep) {
          const first = thinking ? emit('llm.thinking', 'assistant', oneLine(thinking), { text: truncate(thinking, INDEX_TEXT_MAX), text_len: thinking.length }) : undefined;
          const ev = emit('llm.text', 'assistant', text ? oneLine(text) : words('→', toolNames.join(', ')), {
            text: truncate(text, INDEX_TEXT_MAX), text_len: text.length,
            tokens,
            tool_requests: toolNames.length || undefined,
            error: failed ? { message: truncate(typeof rec.error === 'string' ? rec.error : 'step status ERROR', 1024) } : undefined,
          }, createdTs, failed ? ['error'] : undefined);
          const llmSpanId = spanId(session, 'llm', stepIdx);
          spans.push({
            rec: 'span', id: llmSpanId, session, kind: 'llm', name: target.agent, parent: currentTurnId,
            start: ev.ts, durSrc: 'unknown', status: failed ? 'error' : TEXT_STATUS[String(rec.status ?? '')] ?? 'open',
            firstEvent: (first ?? ev).id, lastEvent: ev.id, attrs: { tokens },
          });
          for (const e of first ? [first, ev] : [ev]) e.span = llmSpanId;

        } else { stats.skipped++; block = thinking ? 2 : 1; }

        calls.forEach((tc, i) => {
          const name = typeof tc?.name === 'string' && tc.name ? tc.name : 'tool';
          const input = camelKeys(tc?.args ?? tc?.arguments ?? {});
          const kind = toolKind(name);
          const inputSummary = summarizeToolInput(name, input);
          const command = kind === 'shell' ? strField(input, 'commandLine', 'command') : undefined;
          const callId = `step-${stepIdx}-call-${i}`;
          const changes = editChanges(name, input);
          const callEv = emit('tool.call', 'assistant', `${name}  ${inputSummary}`, {
            tool: { name, call_id: callId, kind, command, input: compact(input, { maxString: INDEX_INPUT_MAX_STRING }), input_summary: inputSummary },
            ...(changes.length ? { change: { files: changes } } : {}),
          });
          pendingCalls.push({ callId, name, kind, input, inputSummary, command, callEv, turnId: currentTurnId });
        });
        return;
      }

      if (stepType === 'GENERIC' || stepType === 'RUN_COMMAND' || stepType === 'SHELL_EXEC' || stepType === 'MCP_TOOL') {
        const rawOut = typeof rec.content === 'string' ? rec.content : '';
        const errStr = typeof rec.error === 'string' && rec.error ? rec.error : undefined;
        const parsed = parseTranscriptToolHeader(rawOut);
        const exitCode = parsed.exitCode ?? (typeof rec.exit_code === 'number' ? rec.exit_code : undefined);
        const pending = pendingCalls.shift();
        const name = pending?.name ?? (typeof rec.tool_name === 'string' && rec.tool_name ? rec.tool_name : 'tool');
        const kind = pending?.kind ?? toolKind(name);
        const callId = pending?.callId ?? `step-${stepIdx}`;
        const startAt = parsed.createdAt ?? pending?.callEv.ts ?? createdTs;
        const endAt = parsed.completedAt ?? createdTs;
        const isError = rec.status === 'ERROR' || errStr !== undefined || (exitCode !== undefined && exitCode !== 0);
        const outText = parsed.body || errStr || '';
        const child = name === 'invoke_subagent' ? parsed.subagentId : undefined;
        if (child && pending && events.includes(pending.callEv)) {
          pending.callEv.attrs.agent = { id: child, link_session: `${target.prefix}:${child}` };
        }
        const resEv = emit('tool.result', 'tool', `${name}  ${words(isError ? 'error →' : '→', oneLine(outText, 120))}`, {
          tool: {
            name, call_id: callId, kind, output: truncate(outText, INDEX_TEXT_MAX), output_len: outText.length,
            output_tail: outputTail(outText), exit_code: exitCode, is_error: isError,
          },
          error: errStr ? { message: truncate(errStr, 1024) } : undefined,
        }, endAt, isError ? ['error'] : undefined);
        const dur = startAt !== undefined && endAt !== undefined && endAt >= startAt ? endAt - startAt : undefined;
        const spId = spanId(session, 'tool', callId);
        const statusKey = TEXT_STATUS[String(rec.status ?? 'DONE')] ?? 'ok';
        const spanStatus: SpanStatus = isError && statusKey === 'ok' ? 'error' : statusKey;
        const firstEvId = pending && events.includes(pending.callEv) ? pending.callEv.id : resEv.id;
        spans.push({
          rec: 'span', id: spId, session, kind: 'tool', name, parent: pending?.turnId ?? currentTurnId,
          start: startAt ?? resEv.ts, end: dur !== undefined ? endAt : undefined, dur,
          durSrc: parsed.createdAt !== undefined && parsed.completedAt !== undefined ? 'logged:transcript.completed_at' : dur !== undefined ? 'derived:ts-gap' : 'unknown',
          status: spanStatus, firstEvent: firstEvId, lastEvent: resEv.id,
          linkSession: child ? `${target.prefix}:${child}` : undefined,
          attrs: { tool: { name, kind } },
        });
        if (pending && events.includes(pending.callEv)) pending.callEv.span = spId;
        resEv.span = spId;
        resEv.dur = dur;
        return;
      }

      if (stepType === 'SYSTEM_MESSAGE') {
        emit('context.attachment', 'system', 'system message', { context: { type: 'system message' } });
        return;
      }

      if (stepType === 'CHECKPOINT') {
        const uncached = typeof rec.input_tokens === 'number' ? rec.input_tokens : undefined;
        const cacheRead = typeof rec.cache_read_tokens === 'number' ? rec.cache_read_tokens : undefined;
        const output = typeof rec.output_tokens === 'number' ? rec.output_tokens : undefined;
        const tokens: TokenUsage | undefined = uncached !== undefined || cacheRead !== undefined || output !== undefined
          ? { input: (uncached ?? 0) + (cacheRead ?? 0), uncached, cache_read: cacheRead, output }
          : undefined;
        emit('context.compaction', 'harness', 'checkpoint', { context: { type: 'checkpoint' }, tokens });
        return;
      }

      if (stepType === 'ERROR_MESSAGE') {
        const msg = typeof rec.error === 'string' ? rec.error : typeof rec.content === 'string' ? rec.content : 'error';
        const ev = emit('llm.error', 'harness', words('error', oneLine(msg, 140)), { error: { message: truncate(msg, 1024) } }, createdTs, ['error']);
        sink.emit({ rec: 'expert', session, event: ev.id, severity: 'error', group: 'api-error', message: `${target.agent} error: ${oneLine(msg, 200)}` });
        return;
      }

      stats.unknown++;
      emit('raw.unknown', 'harness', `step ${stepType}`, {});
    },
    (info, err) => {
      stats.malformed++;
      sink.emit({ rec: 'expert', session, severity: 'warn', group: 'malformed', message: `line ${info.line}: ${err.message}` });
    },
  );

  stats.parsedBytes = readRes.parsedBytes;
  stats.lines = readRes.lines;
  stats.sha256 = readRes.sha256;

  for (let i = events.length - 1; i >= 0; i--) if (removedCalls.has(events[i])) events.splice(i, 1);
  events.forEach((event, i) => { event.seq = seqOffset + i; });
  const replacedIds = new Set(dbEvents.filter(e => replacedSteps.has(e.raw.block!)).map(e => e.id));
  for (let i = dbRecords.length - 1; i >= 0; i--) {
    const r = dbRecords[i];
    if ((r.rec === 'event' && replacedIds.has(r.id)) ||
        (r.rec === 'span' && r.kind !== 'turn' && ((r.firstEvent && replacedIds.has(r.firstEvent)) || (r.lastEvent && replacedIds.has(r.lastEvent)))) ||
        (r.rec === 'expert' && r.event && replacedIds.has(r.event))) dbRecords.splice(i, 1);
  }

  // Emit open tool spans for any in-flight tool calls at the tail of an active session.
  for (const pending of pendingCalls) {
    if (!events.includes(pending.callEv)) continue;
    const spId = spanId(session, 'tool', pending.callId);
    pending.callEv.span = spId;
    spans.push({
      rec: 'span', id: spId, session, kind: 'tool', name: pending.name, parent: pending.turnId,
      start: pending.callEv.ts, durSrc: 'unknown', status: 'open',
      firstEvent: pending.callEv.id, lastEvent: pending.callEv.id, attrs: { tool: { name: pending.name, kind: pending.kind } },
    });
  }

  if (!events.length) {
    stats.skipped ||= 1;
    return stats;
  }

  const dbPath = join(baseDir, 'conversations', `${conv}.db`);
  const summary = await readSummary(join(baseDir, 'conversation_summaries.db'), conv);
  const wsMeta = peekTrajectoryWorkspace(dbPath);
  const cwd = wsMeta?.cwd ?? fromFileUri(summary?.workspace);
  const root = wsMeta?.root ?? cwd;
  const parent = wsMeta?.parent ?? summary?.parent;
  const srcEnum = peekTrajectorySource(baseDir, conv) ?? summary?.source;
  const entrypoint = (srcEnum !== undefined ? TRAJECTORY_ENTRYPOINTS[srcEnum] : undefined)
    ?? (basename(baseDir) === 'antigravity-ide' ? 'ide' : 'app');

  // Define the session when no checkpointed `.db` steps exist; otherwise emit `enrich` so live WAL steps never leave metadata blank.
  if (!hasDbSession) {
    sink.emit({
      rec: 'session',
      id: session,
      agent: target.agent,
      nativeId: conv,
      role: parent ? 'subagent' : 'main',
      parentId: parent ? `${target.prefix}:${parent}` : undefined,
      title: summary?.title ?? firstPrompt,
      cwd,
      project: root ? basename(root) : undefined,
      git: wsMeta?.branch ? { branch: wsMeta.branch } : undefined,
      entrypoint,
      createdTs: firstTs,
      meta: { transcriptOnly: true, trajectorySource: srcEnum, status: summary?.status },
    });
  } else {
    sink.emit({
      rec: 'enrich',
      session,
      fields: {
        title: summary?.title ?? firstPrompt,
        cwd,
        project: root ? basename(root) : undefined,
        git: wsMeta?.branch ? { branch: wsMeta.branch } : undefined,
      },
      meta: { liveWalSteps: events.length },
    });
  }

  for (const ev of events) sink.emit(ev);
  for (const sp of spans) {
    if (sp.kind === 'turn' && sp.end !== undefined) sp.dur = sp.end - sp.start;
    sink.emit(sp);
  }
  return stats;
}

function stripUserRequestTags(text: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text);
  return m ? m[1] : text;
}

function parseTranscriptToolHeader(text: string): { createdAt?: number; completedAt?: number; exitCode?: number; subagentId?: string; body: string } {
  const lines = text.split('\n');
  let i = 0;
  let createdAt: number | undefined;
  let completedAt: number | undefined;
  while (i < Math.min(lines.length, 4)) {
    const cm = /^Created At:\s*(.+)$/.exec(lines[i]);
    if (cm) { createdAt = isoToUs(cm[1].trim()); i++; continue; }
    const dm = /^Completed At:\s*(.+)$/.exec(lines[i]);
    if (dm) { completedAt = isoToUs(dm[1].trim()); i++; continue; }
    break;
  }
  const rest = lines.slice(i).join('\n').trimStart();
  const exitMatch = /^Command exited with code (-?\d+)\./m.exec(rest);
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
  const subMatch = /conversationId["':\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(rest);
  return { createdAt, completedAt, exitCode, subagentId: subMatch?.[1], body: rest };
}

type Emit = (kind: EventKind, actor: EventRec['actor'], summary: string, attrs: Attrs, at?: number, flags?: EventFlag[]) => EventRec;

/**
 * A tool step: its call at the step's creation, any permission prompt and decision, and its result at
 * completion. The span runs from creation to completion, so it includes any wait for approval.
 */
function toolStep(
  idx: number, type: number, status: number, step: Pb, call: Pb, name: string, created: number | undefined, completed: number | undefined,
  errorText: string | undefined, emit: Emit, session: string, prefix: AgentPrefix, spans: SpanRec[], turn: SpanRec | undefined,
): void {
  const args = tryJson(str(call, CALL.args)) ?? str(call, CALL.args);
  const input = camelKeys(args);
  const kind = type === MCP_TOOL ? 'mcp' : toolKind(name);
  const inputSummary = summarizeToolInput(name, input);
  const command = kind === 'shell' ? strField(input, 'commandLine', 'command') : undefined;
  const changes = editChanges(name, input);
  const generic = sub(sub(step, STEP.generic), 2);
  const blocks = list(sub(generic, 3), 10);
  const terminal = blocks.map((b) => sub(b, 3)).find((t) => t.size);
  const subagent = sub(step, STEP.invokeSubagent);
  const child = str(subagent, 5) ?? list(subagent, 10).map((r) => str(r, 1)).find(Boolean) ?? blocks.map((b) => str(sub(b, 4), 1)).find(Boolean);
  const callEv = emit('tool.call', 'assistant', `${name}  ${inputSummary}`, {
    tool: { name, call_id: str(call, CALL.id), kind, command, input: compact(input, { maxString: INDEX_INPUT_MAX_STRING }), input_summary: inputSummary },
    ...(changes.length ? { change: { files: changes } } : {}),
    agent: child || str(subagent, 1) ? { id: child, type: str(subagent, 1), description: truncate(str(subagent, 2), 512), link_session: child ? `${prefix}:${child}` : undefined } : undefined,
  });
  const id = spanId(session, 'tool', str(call, CALL.id) ?? idx);
  const evs = [callEv];

  if (step.has(STEP.requested)) evs.push(emit('permission.request', 'harness', words('permission?', name, oneLine(command ?? inputSummary, 120)), { permission: { tool: name }, tool: { call_id: str(call, CALL.id), command } }));
  for (const done of list(step, STEP.completed)) {
    const response = sub(done, 2);
    const answer = [...response.keys()].filter((f) => ![1, 2, 24, 25].includes(f)).map((f) => sub(response, f))[0];
    const granted = answer ? int(answer, 1) === 1 : undefined;
    evs.push(emit('permission.decision', 'user', words('permission', granted === undefined ? undefined : granted ? 'allowed' : 'denied', int(response, 24) === 1 ? '(timed out)' : undefined), {
      permission: { decision: granted === undefined ? undefined : granted ? 'allow' : 'deny', granted },
    }));
  }

  const outcome = STATUS[status];
  let result: EventRec | undefined;
  if (outcome) {
    const rc = sub(step, STEP.runCommand);
    const sh = sub(step, STEP.shellExec);
    const exitCode = rc.has(6) ? int32(rc, 6) : step.has(STEP.shellExec) ? int32(sh, 2) ?? 0 : terminal?.has(3) ? int32(terminal, 3) : undefined;
    const output = str(sub(rc, 21), 1) ?? (words(str(rc, 4), str(rc, 5)) || undefined) ?? str(sh, 3) ?? str(generic, 1) ?? str(terminal, 4) ?? errorText ?? '';
    const rejected = int(rc, 14) === 1;
    const isError = outcome === 'error' || (exitCode !== undefined && exitCode !== 0) || errorText !== undefined || str(sh, 4) !== undefined;
    result = emit('tool.result', 'tool', `${name}  ${words(isError ? 'error →' : outcome === 'ok' ? '→' : `${outcome} →`, oneLine(output, 120))}`, {
      tool: {
        name, call_id: str(call, CALL.id), kind, output: truncate(output, INDEX_TEXT_MAX), output_len: output.length,
        output_tail: outputTail(output), exit_code: exitCode, is_error: isError,
      },
      error: errorText ? { message: truncate(errorText, 1024) } : undefined,
    }, completed, isError ? ['error'] : undefined);
    if (rejected) result.attrs.permission = { granted: false };
    evs.push(result);
  }
  const dur = completed !== undefined && created !== undefined && completed >= created ? completed - created : undefined;
  const spanStatus: SpanStatus = result?.attrs.tool?.is_error && outcome === 'ok' ? 'error' : outcome ?? 'open';
  spans.push({
    rec: 'span', id, session, kind: 'tool', name, parent: turn?.id, start: created ?? callEv.ts, end: result && dur !== undefined ? completed : undefined, dur: result ? dur : undefined,
    durSrc: result && dur !== undefined ? 'logged:metadata.completed_at' : 'unknown', status: spanStatus, firstEvent: callEv.id, lastEvent: evs.at(-1)!.id,
    linkSession: child ? `${prefix}:${child}` : undefined, attrs: { tool: { name, kind } },
  });
  for (const e of evs) e.span = id;
  if (result) result.dur = spans.at(-1)!.dur;
}

/** The conversation's row in conversation_summaries.db, next to the conversations folder (title, workspace, status, source). */
async function readSummary(path: string, conv: string): Promise<{ title?: string; workspace?: string; parent?: string; status?: string; source?: number } | undefined> {
  let db;
  try {
    db = openReadOnly(path);
    const r = db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(conv) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const uris = tryJson(r.workspace_uris);
    const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
      title: text(r.title),
      workspace: Array.isArray(uris) ? text(uris[0]) : undefined,
      parent: text(r.parent_conversation_id),
      status: text(r.status),
      source: typeof r.source === 'number' ? r.source : undefined,
    };
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** The step's decoded fields that are not repeated elsewhere in the event, for the detail view. */
function nativeOf(step: Pb, meta: Pb): unknown {
  const call = sub(meta, META.toolCall);
  return compact({
    type: int(step, STEP.type), status: int(step, STEP.status), source: int(meta, META.source),
    tool_call: call.size ? { id: str(call, CALL.id), name: str(call, CALL.name), arguments: tryJson(str(call, CALL.args)) ?? str(call, CALL.args) } : undefined,
    payload_fields: [...step.keys()].filter((f) => f !== STEP.type && f !== STEP.status && f !== STEP.metadata),
  });
}

function tokenUsage(u: Pb): TokenUsage | undefined {
  if (![USAGE.input, USAGE.output, USAGE.cacheRead, USAGE.cacheWrite, USAGE.thinking].some((f) => u.has(f))) return undefined;
  const uncached = int(u, USAGE.input) ?? 0;
  const output = int(u, USAGE.output) ?? 0;
  const cacheRead = int(u, USAGE.cacheRead);
  const cacheWrite = int(u, USAGE.cacheWrite);
  return { input: (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0), uncached, cache_read: cacheRead, cache_write: cacheWrite, output, reasoning: int(u, USAGE.thinking) };
}

function errorMessage(e: Pb): string | undefined {
  return str(e, 1) ?? str(e, 2) ?? str(e, 9) ?? str(e, 3);
}

function camelKeys(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.charAt(0).toLowerCase() + k.slice(1), x]));
}

function strField(o: unknown, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = (o as Record<string, unknown> | undefined)?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

function words(...parts: unknown[]): string {
  return parts.filter((p) => typeof p === 'string' && p).join(' ');
}

// ---------------------------------------------------------------------------
// Protobuf wire format, decoded without a schema: field number → values in order.

type Pb = Map<number, (number | bigint | Buffer)[]>;

function pb(data: Uint8Array | null | undefined): Pb {
  const out: Pb = new Map();
  if (!data?.length) return out;
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const at = { i: 0 };
  while (at.i < b.length) {
    const key = varint(b, at);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    const size = wire === 0 ? 0 : wire === 2 ? varint(b, at) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (field === 0 || size < 0) throw new RangeError(`bad field key ${key}`);
    if (at.i + size > b.length) throw new RangeError(`field ${field} overruns its message`);
    const v = wire === 0 ? scalar(b, at) : b.subarray(at.i, at.i + size);
    at.i += size;
    const vs = out.get(field);
    if (vs) vs.push(v);
    else out.set(field, [v]);
  }
  return out;
}

function varint(b: Buffer, at: { i: number }): number {
  const n = scalar(b, at);
  if (typeof n !== 'number') throw new RangeError('oversized varint');
  return n;
}

function scalar(b: Buffer, at: { i: number }): number | bigint {
  let r = 0n;
  for (let shift = 0n; shift <= 63n; shift += 7n) {
    if (at.i >= b.length) throw new RangeError('truncated varint');
    const x = b[at.i++];
    if (shift === 63n && x > 1) throw new RangeError('oversized varint');
    r |= BigInt(x & 0x7f) << shift;
    if (x < 0x80) return r <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(r) : r;
  }
  throw new RangeError('oversized varint');
}

function sub(m: Pb, f: number): Pb {
  const v = m.get(f)?.at(-1);
  if (!Buffer.isBuffer(v)) return new Map();
  try {
    return pb(v);
  } catch {
    return new Map();
  }
}

function list(m: Pb | undefined, f: number): Pb[] {
  return (m?.get(f) ?? []).filter(Buffer.isBuffer).map((v) => {
    try {
      return pb(v);
    } catch {
      return new Map();
    }
  });
}

function str(m: Pb | undefined, f: number): string | undefined {
  const v = m?.get(f)?.at(-1);
  return Buffer.isBuffer(v) && v.length ? v.toString('utf8') : undefined;
}

function strs(m: Pb, f: number): string[] {
  return (m.get(f) ?? []).filter(Buffer.isBuffer).map((v) => v.toString('utf8'));
}

function int(m: Pb | undefined, f: number): number | undefined {
  const v = m?.get(f)?.at(-1);
  return typeof v === 'number' ? v : undefined;
}

function int32(m: Pb, f: number): number | undefined {
  const v = m.get(f)?.at(-1);
  return typeof v === 'number' || typeof v === 'bigint' ? Number(BigInt.asIntN(32, BigInt(v))) : undefined;
}

function ints(m: Pb, f: number): number[] {
  const out: number[] = [];
  for (const v of m.get(f) ?? []) {
    if (typeof v === 'number') out.push(v);
    else if (Buffer.isBuffer(v)) {
      const at = { i: 0 };
      try {
        while (at.i < v.length) out.push(varint(v, at));
      } catch {
        // A truncated packed run keeps the values before the cut.
      }
    }
  }
  return out;
}

function time(m: Pb, f: number): number | undefined {
  const t = sub(m, f);
  const s = int(t, 1);
  return s ? s * 1e6 + Math.floor((int(t, 2) ?? 0) / 1000) : undefined;
}

function duration(m: Pb, f: number): number | undefined {
  if (!m.has(f)) return undefined;
  const d = sub(m, f);
  return (int(d, 1) ?? 0) * 1e6 + Math.floor((int(d, 2) ?? 0) / 1000);
}
