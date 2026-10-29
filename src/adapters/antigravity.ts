// Google Antigravity conversations (SPEC §4.3, best effort): `~/.gemini/antigravity/conversations/<id>.db`
// (and `antigravity-ide/`), one SQLite trajectory per conversation in recent versions; older conversations are
// encrypted `<id>.pb` files that cannot be read. Each `steps` row holds one protobuf step (gemini_coder.Step):
// the user's input, a planner (model) response, or a tool step that carries its call, timestamps, permission
// prompt and result. `gen_metadata` rows describe the model calls (model, tokens, time to first token). Field
// numbers come from the descriptors embedded in Antigravity's language server; there is no published schema.
// The database is opened immutable (SPEC §2.1), so steps still in its write-ahead log appear only once
// Antigravity checkpoints it.

import { glob } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Attrs, EventFlag, EventKind, EventRec, SpanRec, SpanStatus, TokenUsage } from '../model/types.ts';
import {
  type Adapter, type ParseStats, type SourceFile, INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, compact, emptyStats, eventId, fileInfo,
  fromFileUri, oneLine, spanId, summarizeToolInput, toolKind, truncate, tryJson,
} from './adapter.ts';
import { openReadOnly } from './codex-state.ts';

// CortexStepType values the adapter decodes.
const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const FINISH = 2;
const ERROR_MESSAGE = 17;
const CHECKPOINT = 23;
const MCP_TOOL = 38;
const CONTEXT_STEPS: Record<number, string> = {
  90: 'ephemeral message', 98: 'conversation history', 99: 'knowledge artifacts', 101: 'system message', 116: 'knowledge insertion', 139: 'directory rules',
};

// CortexStepStatus values; the others (pending, running, generating, queued, waiting) leave a step open.
const DONE = 3;
const INVALID = 4;
const CLEARED = 5;
const CANCELED = 6;
const ERROR = 7;
const INTERRUPTED = 12;
const STATUS: Record<number, SpanStatus> = { [DONE]: 'ok', [INVALID]: 'cancelled', [CLEARED]: 'cancelled', [CANCELED]: 'cancelled', [ERROR]: 'error', [INTERRUPTED]: 'interrupted' };

// CortexStepSource: an implicit user step is input the harness sent on the user's behalf.
const USER_IMPLICIT = 3;

const STOP_REASONS: Record<number, string> = {
  1: 'incomplete', 2: 'stop', 3: 'max_tokens', 10: 'function_call', 11: 'content_filter', 13: 'error', 15: 'other', 16: 'client_canceled',
};

// Field numbers of gemini_coder.Step and the exa.cortex_pb / exa.codeium_common_pb messages it holds.
const STEP = { type: 1, status: 4, metadata: 5, userInput: 19, planner: 20, errorMessage: 24, runCommand: 28, error: 31, requested: 56, shellExec: 127, generic: 140, invokeSubagent: 143, completed: 147 };
const META = { created: 1, source: 3, toolCall: 4, completed: 8, usage: 9, finishedGenerating: 7 };
const CALL = { id: 1, name: 2, args: 3 };
const USAGE = { input: 2, output: 3, cacheWrite: 4, cacheRead: 5, messageId: 7, thinking: 9 };
const CHAT = { usage: 4, retries: 14, ttft: 11, streaming: 12, model: 19, display: 21 };

export const antigravityAdapter: Adapter = {
  name: 'antigravity',

  async discover(env) {
    if (env.agents && !env.agents.includes('antigravity')) return [];
    const out: SourceFile[] = [];
    // The IDE's folder can hold a copy of a conversation the app migrated; the app's copy wins.
    const seen = new Set<string>();
    for (const dir of ['antigravity', 'antigravity-ide']) {
      const base = join(env.home, '.gemini', dir, 'conversations');
      for await (const rel of glob('*.db', { cwd: base })) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const f = await fileInfo(join(base, rel), 'antigravity', 'trajectory-db', 'antigravity');
        if (f) out.push(f);
      }
    }
    return out;
  },

  async parse(ctx, sink) {
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
    let traj: { trajectory_id?: string; cascade_id?: string; trajectory_type?: number } | undefined;
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
      traj = tables.has('trajectory_meta') ? db.prepare('SELECT trajectory_id, cascade_id, trajectory_type FROM trajectory_meta LIMIT 1').get() as typeof traj : undefined;
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

    const conv = traj?.cascade_id || basename(path, '.db');
    const session = `ag:${conv}`;
    for (const message of metadataErrors) sink.emit({ rec: 'expert', session, severity: 'warn', group: 'malformed', message });
    const summary = await readSummary(join(dirname(dirname(path)), 'conversation_summaries.db'), conv);
    // Each model call's generator metadata names the steps it produced; the planner response among them is the call.
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
          seq: events.length, kind, proto: `antigravity/${type}`, actor, summary: summaryText, attrs, native: block === 0 ? nativeOf(step, meta) : undefined,
          raw: { source: ctx.sourceId, line: 0, offset: 0, length: 0, block: row.idx }, flags,
        };
        block++;
        if (at !== undefined) lastTs = Math.max(lastTs, at);
        if (turn) {
          ev.turn = turn.id;
          ev.span = turn.id;
          turn.end = Math.max(turn.end ?? turn.start, ev.ts);
          turn.lastEvent = ev.id;
          // A failed model call fails the turn; a failed tool is the model's to handle.
          if (flags?.includes('error') && kind.startsWith('llm.') && turn.status === 'ok') turn.status = 'error';
        }
        events.push(ev);
        return ev;
      };

      if (type === USER_INPUT) {
        const input = sub(step, STEP.userInput);
        const text = str(input, 2) ?? str(input, 1) ?? list(input, 3).map((it) => str(it, 1)).filter(Boolean).join('\n');
        const implicit = int(meta, META.source) === USER_IMPLICIT;
        if (!implicit) turn = undefined;
        const ev = emit(implicit ? 'user.inject' : 'user.prompt', 'user', oneLine(text), {
          text: truncate(text, INDEX_TEXT_MAX), text_len: text.length, antigravity: { queued: int(input, 6) === 1 || undefined, images: (input.get(5)?.length ?? 0) + (input.get(9)?.length ?? 0) || undefined },
        });
        if (!implicit) {
          turn = {
            rec: 'span', id: spanId(session, 'turn', row.idx), session, kind: 'turn', name: oneLine(text, 80), start: ev.ts, durSrc: 'derived:ts-gap', status: 'ok',
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
          model, display: str(chat, CHAT.display), message_id: str(plan, 6) ?? str(usage, USAGE.messageId), stop_reason: stop !== undefined ? STOP_REASONS[stop] ?? `stop_reason_${stop}` : undefined,
          ttft_ms: ttft !== undefined ? ttft / 1000 : undefined, latency_ms: dur !== undefined ? dur / 1000 : undefined, retries: int(chat, CHAT.retries) || undefined,
        };
        // The response is complete when generation ends, so its records carry that time.
        const end = created !== undefined && dur !== undefined ? created + dur : created;
        const first = thinking ? emit('llm.thinking', 'assistant', oneLine(thinking), { text: truncate(thinking, INDEX_TEXT_MAX), text_len: thinking.length }, end) : undefined;
        const ev = emit('llm.text', 'assistant', text ? oneLine(text) : words('→', tools.join(', ')), {
          text: truncate(text, INDEX_TEXT_MAX), text_len: text.length, llm, tokens, tool_requests: tools.length || undefined,
          error: failed ? { message: truncate(errorText, 1024) } : undefined,
        }, end, failed ? ['error'] : undefined);
        if (failed) sink.emit({ rec: 'expert', session, event: ev.id, severity: 'error', group: 'api-error', message: `Antigravity model call failed: ${oneLine(errorText ?? 'step status error', 200)}` });
        const start = created ?? ev.ts;
        spans.push({
          rec: 'span', id: spanId(session, 'llm', row.idx), session, kind: 'llm', name: model ?? 'antigravity', parent: turn?.id, start,
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
        toolStep(row.idx, type, status, step, call, name, created, completed, errorText, emit, session, spans, turn);
        continue;
      }

      const failed = status === ERROR ? ['error' as const] : undefined;
      if (type === ERROR_MESSAGE) {
        const text = errorMessage(sub(sub(step, STEP.errorMessage), 3)) ?? errorText ?? '';
        const ev = emit('llm.error', 'harness', words('error', oneLine(text, 140)), { error: { message: truncate(text, 1024) } }, created, ['error']);
        sink.emit({ rec: 'expert', session, event: ev.id, severity: 'error', group: 'api-error', message: `Antigravity error: ${oneLine(text, 200)}` });
      } else if (type === CHECKPOINT) {
        emit('context.compaction', 'harness', 'checkpoint', { context: { type: 'checkpoint' } }, created, failed);
      } else if (type === FINISH) {
        emit('turn.end', 'harness', 'finish', {}, created, failed);
      } else if (CONTEXT_STEPS[type]) {
        emit('context.attachment', 'harness', CONTEXT_STEPS[type], { context: { type: CONTEXT_STEPS[type] } }, created, failed);
      } else {
        stats.unknown++;
        const ev = emit('raw.unknown', 'harness', `step type ${type}`, {}, created, failed);
        if (!undecoded.has(type)) {
          undecoded.add(type);
          sink.emit({ rec: 'expert', session, event: ev.id, severity: 'note', group: 'undecoded', message: `Unknown Antigravity step type ${type}` });
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
    sink.emit({
      rec: 'session',
      id: session,
      agent: 'antigravity',
      nativeId: conv,
      role: parent ? 'subagent' : 'main',
      parentId: parent ? `ag:${parent}` : undefined,
      title: summary?.title,
      cwd,
      project: root ? basename(root) : undefined,
      git: str(ws, 4) ? { branch: str(ws, 4) } : undefined,
      models: [...models],
      entrypoint: basename(dirname(dirname(path))) === 'antigravity-ide' ? 'ide' : 'app',
      createdTs: time(tmeta, 2),
      meta: { trajectoryId: traj?.trajectory_id, trajectoryType: traj?.trajectory_type, projectId: str(tmeta, 18), status: summary?.status },
    });
    for (const ev of events) sink.emit(ev);
    for (const sp of spans) {
      if (sp.kind === 'turn' && sp.end !== undefined) sp.dur = sp.end - sp.start;
      sink.emit(sp);
    }
    return stats;
  },
};

type Emit = (kind: EventKind, actor: EventRec['actor'], summary: string, attrs: Attrs, at?: number, flags?: EventFlag[]) => EventRec;

/**
 * A tool step: its call at the step's creation, any permission prompt and decision, and its result at
 * completion. The span runs from creation to completion, so it includes any wait for approval.
 */
function toolStep(
  idx: number, type: number, status: number, step: Pb, call: Pb, name: string, created: number | undefined, completed: number | undefined,
  errorText: string | undefined, emit: Emit, session: string, spans: SpanRec[], turn: SpanRec | undefined,
): void {
  const args = tryJson(str(call, CALL.args)) ?? str(call, CALL.args);
  const input = camelKeys(args);
  const kind = type === MCP_TOOL ? 'mcp' : toolKind(name);
  const inputSummary = summarizeToolInput(name, input);
  const command = kind === 'shell' ? strField(input, 'commandLine', 'command') : undefined;
  // Generic steps (most tools in recent versions) keep the model-facing result text and render blocks: a
  // terminal block with the command's exit code, an agent block naming a subagent's conversation.
  const generic = sub(sub(step, STEP.generic), 2);
  const blocks = list(sub(generic, 3), 10);
  const terminal = blocks.map((b) => sub(b, 3)).find((t) => t.size);
  const subagent = sub(step, STEP.invokeSubagent);
  const child = str(subagent, 5) ?? list(subagent, 10).map((r) => str(r, 1)).find(Boolean) ?? blocks.map((b) => str(sub(b, 4), 1)).find(Boolean);
  const callEv = emit('tool.call', 'assistant', `${name}  ${inputSummary}`, {
    tool: { name, call_id: str(call, CALL.id), kind, command, input: compact(input, { maxString: INDEX_INPUT_MAX_STRING }), input_summary: inputSummary },
    agent: child || str(subagent, 1) ? { id: child, type: str(subagent, 1), description: truncate(str(subagent, 2), 512), link_session: child ? `ag:${child}` : undefined } : undefined,
  });
  const id = spanId(session, 'tool', str(call, CALL.id) ?? idx);
  const evs = [callEv];

  // Permission prompts: the requested interaction, then the user's answer, whose oneof message leads with allow or confirm.
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
    // run_command and terminal render blocks have optional exit codes. ShellExec's int32 is not
    // optional: an omitted scalar in an existing message means zero, per its protobuf descriptor.
    const exitCode = rc.has(6) ? int32(rc, 6) : step.has(STEP.shellExec) ? int32(sh, 2) ?? 0 : terminal?.has(3) ? int32(terminal, 3) : undefined;
    const output = str(sub(rc, 21), 1) ?? (words(str(rc, 4), str(rc, 5)) || undefined) ?? str(sh, 3) ?? str(generic, 1) ?? str(terminal, 4) ?? errorText ?? '';
    const rejected = int(rc, 14) === 1;
    const isError = outcome === 'error' || (exitCode !== undefined && exitCode !== 0) || errorText !== undefined || str(sh, 4) !== undefined;
    result = emit('tool.result', 'tool', `${name}  ${words(isError ? 'error →' : outcome === 'ok' ? '→' : `${outcome} →`, oneLine(output, 120))}`, {
      tool: { name, call_id: str(call, CALL.id), kind, output: truncate(output, INDEX_TEXT_MAX), output_len: output.length, exit_code: exitCode, is_error: isError },
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
    linkSession: child ? `ag:${child}` : undefined, attrs: { tool: { name, kind } },
  });
  for (const e of evs) e.span = id;
  if (result) result.dur = spans.at(-1)!.dur;
}

/** The conversation's row in conversation_summaries.db, next to the conversations folder (title, workspace, status). */
async function readSummary(path: string, conv: string): Promise<{ title?: string; workspace?: string; parent?: string; status?: string } | undefined> {
  let db;
  try {
    db = openReadOnly(path);
    const r = db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(conv) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const uris = tryJson(r.workspace_uris);
    const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return { title: text(r.title), workspace: Array.isArray(uris) ? text(uris[0]) : undefined, parent: text(r.parent_conversation_id), status: text(r.status) };
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
  // Scalar zeros are omitted by protobuf, including all-cached input and empty output.
  const uncached = int(u, USAGE.input) ?? 0;
  const output = int(u, USAGE.output) ?? 0;
  const cacheRead = int(u, USAGE.cacheRead);
  const cacheWrite = int(u, USAGE.cacheWrite);
  // input_tokens excludes cached tokens; TokenUsage.input counts them.
  return { input: (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0), uncached, cache_read: cacheRead, cache_write: cacheWrite, output, reasoning: int(u, USAGE.thinking) };
}

/** CortexErrorDetails: the user-facing message, else the short or model-facing one. */
function errorMessage(e: Pb): string | undefined {
  return str(e, 1) ?? str(e, 2) ?? str(e, 9) ?? str(e, 3);
}

/** Antigravity tool arguments use PascalCase keys (CommandLine, AbsolutePath); the shared summaries expect camelCase. */
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

/** Keep sign-extended int32 values exact until their field type is known. */
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

/** A nested message (the last occurrence); empty when absent or not a message. */
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

/** A repeated integer field, packed or not. */
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

/** google.protobuf.Timestamp {seconds, nanos} in µs. */
function time(m: Pb, f: number): number | undefined {
  const t = sub(m, f);
  const s = int(t, 1);
  return s ? s * 1e6 + Math.floor((int(t, 2) ?? 0) / 1000) : undefined;
}

/** google.protobuf.Duration {seconds, nanos} in µs. */
function duration(m: Pb, f: number): number | undefined {
  if (!m.has(f)) return undefined;
  const d = sub(m, f);
  return (int(d, 1) ?? 0) * 1e6 + Math.floor((int(d, 2) ?? 0) / 1000);
}
