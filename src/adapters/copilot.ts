// VS Code Copilot Chat sessions (SPEC §4.3, best effort): `workspaceStorage/*/chatSessions/*` and
// `globalStorage/emptyWindowChatSessions/*`. Before VS Code 1.109 a session is one pretty-printed JSON
// document (`.json`); from 1.109 it is an append log of mutations (`.jsonl`) that replays to the same
// document, and VS Code reads the log in preference to a `.json` of the same id. Either way every
// event's raw ref is line 0 covering the whole file, and `block` numbers the events within it.

import { glob, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor, Attrs, EventRec, SpanRec, SpanStatus } from '../model/types.ts';
import {
  type Adapter, type ParseStats, type RecordSink, type SourceFile, INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, compact, emptyStats, eventId, fileInfo,
  msToUs, oneLine, sha256, spanId, summarizeToolInput, toolKind, truncate, tryJson,
} from './adapter.ts';

const VSCODE_FLAVORS = ['Code', 'Code - Insiders'];

// requests[].modelState.value in VS Code 1.109+ (ResponseModelState); NeedsInput (4) is a paused request.
const MODEL_PENDING = 0;
const MODEL_CANCELLED = 2;
const MODEL_FAILED = 3;

const EVENT_TYPES = {
  'user.prompt': ['copilot/request', 'user'],
  'tool.call': ['copilot/toolCall', 'assistant'],
  'tool.result': ['copilot/toolCallResult', 'tool'],
  'llm.text': ['copilot/response', 'assistant'],
} as const satisfies Record<string, readonly [string, Actor]>;

export const copilotAdapter: Adapter = {
  name: 'copilot',

  async discover(env) {
    if (env.agents && !env.agents.includes('copilot')) return [];
    const out: SourceFile[] = [];
    for (const flavor of VSCODE_FLAVORS) {
      const base = join(env.appSupport, flavor, 'User');
      const paths = new Set<string>();
      for await (const rel of glob(['workspaceStorage/*/chatSessions/*.{json,jsonl}', 'globalStorage/emptyWindowChatSessions/*.{json,jsonl}'], { cwd: base })) {
        paths.add(join(base, rel));
      }
      for (const path of paths) {
        if (path.endsWith('.json') && paths.has(`${path}l`)) continue;
        const f = await fileInfo(path, 'copilot', 'chat-session', 'copilot');
        if (f) out.push(f);
      }
    }
    return out;
  },

  async parse(ctx, sink) {
    const { path } = ctx.file;
    const bytes = await readFile(path);
    const size = bytes.length;
    const stats: ParseStats = { ...emptyStats(), parsedBytes: size };
    const log = path.endsWith('.jsonl');
    const doc = (log ? replayLog(bytes, stats, sink) : tryJson(bytes.toString('utf8'))) as Record<string, any> | undefined;
    stats.sha256 = sha256(bytes.subarray(0, stats.parsedBytes));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      stats.malformed ||= 1;
      sink.emit({ rec: 'expert', severity: 'warn', group: 'malformed', message: `${basename(path)} is not a ${log ? 'chat session log' : 'JSON object'}` });
      return stats;
    }
    stats.dialect = `${log ? 'chat-session-log' : 'chat-session'} v${doc.version ?? '?'}`;
    const requests: any[] = Array.isArray(doc.requests) ? doc.requests : [];
    if (!requests.length) {
      stats.skipped = 1;
      return stats;
    }
    if (!log) stats.lines = requests.length;

    const session = `cp:${str(doc.sessionId) ?? basename(path, log ? '.jsonl' : '.json')}`;
    const cwd = await workspaceFolder(path);
    const models = [...new Set(requests.map((r) => str(r?.modelId)).filter((m): m is string => !!m))];
    sink.emit({
      rec: 'session',
      id: session,
      agent: 'copilot',
      nativeId: session.slice(3),
      role: 'main',
      title: str(doc.customTitle),
      cwd,
      project: cwd ? basename(cwd) : undefined,
      models,
      version: str(requests.findLast((r) => str(r?.agent?.extensionVersion))?.agent?.extensionVersion),
      entrypoint: str(doc.initialLocation),
      createdTs: msToUs(doc.creationDate),
      meta: { isImported: doc.isImported === true, requests: requests.length, lastMessageTs: msToUs(doc.lastMessageDate) },
    });

    const spans: SpanRec[] = [];
    let block = 0;
    let lastTs = msToUs(doc.creationDate) ?? 0;
    const event = (kind: keyof typeof EVENT_TYPES, ts: number, tsSrc: EventRec['tsSrc'], summary: string, attrs: Attrs, native: unknown, extra: Partial<EventRec> = {}): EventRec => {
      const ev: EventRec = {
        rec: 'event',
        id: eventId(ctx.sourceId, 0, block),
        session,
        ts,
        tsSrc,
        seq: block,
        kind,
        proto: EVENT_TYPES[kind][0],
        actor: EVENT_TYPES[kind][1],
        summary,
        attrs,
        native,
        raw: { source: ctx.sourceId, line: 0, offset: 0, length: stats.parsedBytes, block },
        ...extra,
      };
      block++;
      sink.emit(ev);
      return ev;
    };

    requests.forEach((r, index) => {
      const { response, result, ...request } = r ?? {};
      const requestId = str(r?.requestId) ?? String(index);
      const turn = spanId(session, 'turn', requestId);
      const llm = spanId(session, 'llm', str(r?.responseId) ?? requestId);
      const loggedTs = msToUs(r?.timestamp);
      const ts = loggedTs ?? lastTs;
      const tsSrc = loggedTs !== undefined ? 'logged' : 'inherited';
      lastTs = ts;
      const metadata = result?.metadata ?? {};
      const ttftMs = num(result?.timings?.firstProgress);
      const timedMs = num(result?.timings?.totalElapsed);
      const totalMs = timedMs ?? num(r?.elapsedMs);
      const dur = msToUs(totalMs);
      const end = dur !== undefined ? ts + dur : undefined;
      const model = str(r?.modelId);
      const prompt = str(r?.message?.text) ?? '';

      const first = event('user.prompt', ts, tsSrc, oneLine(prompt), {
        text: truncate(prompt, INDEX_TEXT_MAX),
        text_len: prompt.length,
        turn: { id: requestId, index },
        llm: { model },
        copilot: { participant: str(r?.agent?.id), command: str(r?.slashCommand?.name), variables: r?.variableData?.variables?.length },
      }, compact(request), { span: turn, turn });

      // Agent mode records each tool run as a response part, keyed by the stream id of the model's call.
      const invocations = new Map<string, any>();
      for (const p of Array.isArray(response) ? response : []) {
        if (p?.kind === 'toolInvocationSerialized' && str(p.toolCallId)) invocations.set(p.toolCallId, p);
      }
      const toolEvents = (name: string, callId: string, input: unknown, call: unknown, out: unknown, inv: any) => {
        const tool = spanId(session, 'tool', callId);
        const kind = toolKind(name);
        const inputSummary = summarizeToolInput(name, input);
        // Tool rounds carry no timing; without a timed invocation part the events take the request time.
        const started = msToUs(inv?.startedAt);
        const completed = msToUs(inv?.completedAt);
        const term = inv?.toolSpecificData?.kind === 'terminal' ? inv.toolSpecificData : undefined;
        const command = str(term?.commandLine?.toolEdited) ?? str(term?.commandLine?.userEdited) ?? str(term?.commandLine?.original)
          ?? (kind === 'shell' ? str((input as any)?.command) : undefined);
        const callEv = event('tool.call', started ?? ts, started !== undefined ? 'logged' : 'inherited', `${name}  ${command ?? inputSummary}`, {
          tool: { name, call_id: callId, kind, command, input: compact(input, { maxString: INDEX_INPUT_MAX_STRING }), input_summary: inputSummary },
        }, compact(call ?? inv), { span: tool, turn });
        const output = out !== undefined ? partsText((out as any)?.content ?? out) : invocationOutput(inv) ?? '';
        const done = out !== undefined || inv?.isComplete === true;
        const exitCode = num(term?.terminalCommandState?.exitCode);
        const isError = inv?.resultError !== undefined || inv?.resultDetails?.isError === true || (exitCode !== undefined && exitCode !== 0) || undefined;
        const timed = started !== undefined && completed !== undefined && completed >= started;
        const resultEv = !done ? undefined : event('tool.result', completed ?? ts, completed !== undefined ? 'logged' : 'inherited', `${name}  → ${oneLine(output, 120)}`, {
          tool: { name, call_id: callId, kind, output: truncate(output, INDEX_TEXT_MAX), output_len: output.length, exit_code: exitCode, is_error: isError },
        }, compact(out ?? inv), { span: tool, turn, dur: timed ? completed - started : undefined, flags: isError ? ['error'] : undefined });
        spans.push({
          rec: 'span', id: tool, session, kind: 'tool', name, parent: turn, start: started ?? ts,
          ...(timed ? { end: completed, dur: completed - started, durSrc: 'logged:toolInvocation.completedAt' } : { durSrc: 'unknown' }),
          status: !resultEv ? 'unknown' : isError ? 'error' : 'ok', firstEvent: callEv.id, lastEvent: resultEv?.id ?? callEv.id, attrs: { tool: { name, kind } },
        });
      };
      for (const round of Array.isArray(metadata.toolCallRounds) ? metadata.toolCallRounds : []) {
        for (const call of Array.isArray(round?.toolCalls) ? round.toolCalls : []) {
          const callId = str(call?.id) ?? `${requestId}:${block}`;
          const streamId = callId.split('__vscode')[0];
          const inv = invocations.get(streamId);
          invocations.delete(streamId);
          const input = typeof call?.arguments === 'string' ? (tryJson(call.arguments) ?? call.arguments) : call?.arguments;
          toolEvents(str(call?.name) ?? str(inv?.toolId) ?? '?', callId, input, call, metadata.toolCallResults?.[callId], inv);
        }
      }
      // Parts without a round: tools that participants other than Copilot's own agent invoked.
      for (const [callId, inv] of invocations) toolEvents(str(inv.toolId) ?? '?', callId, invocationInput(inv), undefined, undefined, inv);

      const text = responseText(response);
      const state = num(r?.modelState?.value);
      const error = str(result?.errorDetails?.message) ?? (state === MODEL_FAILED ? 'request failed' : undefined);
      const [promptTokens, completionTokens] = [num(r?.promptTokens), num(r?.completionTokens)];
      const tokens = promptTokens !== undefined || completionTokens !== undefined ? { input: promptTokens, output: completionTokens } : undefined;
      const last = event('llm.text', end ?? ts, tsSrc, error ? `error: ${oneLine(error)}` : oneLine(text), {
        text: truncate(text, INDEX_TEXT_MAX),
        text_len: text.length,
        llm: { model, response_id: str(r?.responseId) ?? str(metadata.responseId), message_id: str(metadata.modelMessageId), ttft_ms: ttftMs, latency_ms: totalMs },
        tokens,
        error: error ? { message: truncate(error, 1024), type: str(result?.errorDetails?.code) } : undefined,
      }, compact({ responseId: r?.responseId, isCanceled: r?.isCanceled, modelState: r?.modelState, response, result }), { span: llm, turn, dur, flags: error ? ['error'] : undefined });
      if (error) sink.emit({ rec: 'expert', session, event: last.id, severity: 'error', group: 'api-error', message: `Copilot request failed: ${oneLine(error, 200)}` });

      const status: SpanStatus = error ? 'error' : r?.isCanceled || state === MODEL_CANCELLED ? 'cancelled' : state === MODEL_PENDING ? 'open' : 'ok';
      const durSrc = dur === undefined ? 'unknown' : timedMs !== undefined ? 'logged:result.timings.totalElapsed' : 'logged:elapsedMs';
      // totalElapsed (elapsedMs in newer logs) covers the whole request, including any tool rounds inside it.
      spans.push({
        rec: 'span', id: llm, session, kind: 'llm', name: model ?? 'copilot', parent: turn, start: ts, end, dur, durSrc, status,
        firstEvent: last.id, lastEvent: last.id, attrs: { llm: { model, ttft_ms: ttftMs, latency_ms: totalMs }, tokens },
      });
      spans.push({
        rec: 'span', id: turn, session, kind: 'turn', name: oneLine(prompt, 80), start: ts, end, dur, durSrc, status,
        firstEvent: first.id, lastEvent: last.id, attrs: { turn: { id: requestId, index } },
      });
    });
    for (const sp of spans) sink.emit(sp);
    return stats;
  },
};

/** Markdown parts of a response: bare `{value}` parts (kind null) and `markdownContent` parts. */
function responseText(response: unknown): string {
  if (!Array.isArray(response)) return '';
  const out: string[] = [];
  for (const p of response) {
    if (p?.kind == null && typeof p?.value === 'string') out.push(p.value);
    else if (p?.kind === 'markdownContent' && typeof p?.content?.value === 'string') out.push(p.content.value);
  }
  return out.join('');
}

/**
 * Replays a `.jsonl` chat session log (VS Code objectMutationLog.ts): entry kind 0 is the whole document,
 * 1 sets the value at path `k`, 2 truncates the array at `k` to `i` when given and appends `v`, 3 deletes `k`.
 * A final line without a newline that does not parse is still being written; parsedBytes stops before it.
 */
function replayLog(bytes: Buffer, stats: ParseStats, sink: RecordSink): unknown {
  let state: any;
  let start = 0;
  stats.parsedBytes = 0;
  for (let line = 1; start < bytes.length; line++) {
    const nl = bytes.indexOf(10, start);
    const end = nl === -1 ? bytes.length : nl;
    const text = bytes.subarray(start, end).toString('utf8').trim();
    const entry = text ? tryJson(text) as any : null;
    if (entry === undefined && nl === -1) break;
    stats.parsedBytes = nl === -1 ? end : end + 1;
    start = end + 1;
    if (entry === null) continue;
    stats.lines++;
    try {
      if (entry?.kind === 0) state = entry.v;
      else if (state === undefined || !Array.isArray(entry?.k) || ![1, 2, 3].includes(entry.kind)) throw new Error('not a mutation of the session');
      else if (entry.k.length === 0) state = entry.kind === 1 ? entry.v : state;
      else {
        if (entry.k.some((key: unknown) =>
          !(typeof key === 'string' || (typeof key === 'number' && Number.isSafeInteger(key) && key >= 0))
          || ['__proto__', 'prototype', 'constructor'].includes(String(key)))) throw new Error('invalid mutation path');
        let parent = state;
        for (const key of entry.k.slice(0, -1)) {
          if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('missing mutation path');
          parent = parent[key];
        }
        const key = entry.k.at(-1);
        if (entry.kind === 1) parent[key] = entry.v;
        else if (entry.kind === 3) delete parent[key];
        else {
          const arr: unknown[] = Object.hasOwn(parent, key) && Array.isArray(parent[key]) ? parent[key] : [];
          if (entry.i !== undefined) {
            if (!Number.isSafeInteger(entry.i) || entry.i < 0 || entry.i > arr.length) throw new Error('invalid array truncation');
            arr.length = entry.i;
          }
          if (Array.isArray(entry.v)) for (const value of entry.v) arr.push(value);
          parent[key] = arr;
        }
      }
    } catch (err) {
      stats.malformed++;
      sink.emit({ rec: 'expert', severity: 'warn', group: 'malformed', message: `line ${line}: ${entry === undefined ? 'not JSON' : (err as Error).message}` });
    }
  }
  return state;
}

/** A tool part's input: the terminal command, else the JSON input of its input/output details. */
function invocationInput(inv: any): unknown {
  const command = inv?.toolSpecificData?.commandLine?.original;
  if (typeof command === 'string') return { command };
  const input = inv?.resultDetails?.input;
  return typeof input === 'string' ? (tryJson(input) ?? input) : undefined;
}

/** A tool part's output: terminal output, else the text parts of its input/output details. */
function invocationOutput(inv: any): string | undefined {
  const term = inv?.toolSpecificData?.terminalCommandOutput?.text;
  if (typeof term === 'string') return term;
  const out = inv?.resultDetails?.output;
  if (Array.isArray(out)) return out.filter((p) => p?.type === 'embed' && p.isText && typeof p.value === 'string').map((p) => p.value).join('\n');
  return str(inv?.resultError) ?? str(inv?.resultError?.message);
}

function partsText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (typeof p === 'string' ? p : typeof p?.value === 'string' ? p.value : typeof p?.text === 'string' ? p.text : '')).join('');
  return v == null ? '' : JSON.stringify(v);
}

/** The folder a workspace-storage hash belongs to, from its sibling workspace.json. */
async function workspaceFolder(sessionPath: string): Promise<string | undefined> {
  const dir = dirname(dirname(sessionPath));
  if (basename(dirname(dir)) !== 'workspaceStorage') return undefined;
  let ws: any;
  try {
    ws = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const uri = str(ws?.folder) ?? str(ws?.workspace);
  if (!uri) return undefined;
  try {
    return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
