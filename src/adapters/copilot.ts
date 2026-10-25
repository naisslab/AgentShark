// VS Code Copilot Chat sessions (SPEC §4.3, best effort): `workspaceStorage/*/chatSessions/*.json` and
// `globalStorage/emptyWindowChatSessions/*.json`. Each file is one pretty-printed JSON document, so
// every event's raw ref is line 0 covering the whole file, and `block` numbers the events within it.

import { glob, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor, Attrs, EventRec, SpanRec, SpanStatus } from '../model/types.ts';
import {
  type Adapter, type ParseStats, type SourceFile, INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, compact, emptyStats, eventId, fileInfo,
  msToUs, oneLine, sha256, spanId, summarizeToolInput, toolKind, truncate, tryJson,
} from './adapter.ts';

const VSCODE_FLAVORS = ['Code', 'Code - Insiders'];

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
      for await (const rel of glob(['workspaceStorage/*/chatSessions/*.json', 'globalStorage/emptyWindowChatSessions/*.json'], { cwd: base })) {
        const f = await fileInfo(join(base, rel), 'copilot', 'chat-session', 'copilot');
        if (f) out.push(f);
      }
    }
    return out;
  },

  async parse(ctx, sink) {
    const { path } = ctx.file;
    const bytes = await readFile(path);
    const size = bytes.length;
    const stats: ParseStats = { ...emptyStats(), parsedBytes: size, sha256: sha256(bytes) };
    const doc = tryJson(bytes.toString('utf8')) as Record<string, any> | undefined;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      stats.malformed = 1;
      sink.emit({ rec: 'expert', severity: 'warn', group: 'malformed', message: `${basename(path)} is not a JSON object` });
      return stats;
    }
    stats.dialect = `chat-session v${doc.version ?? '?'}`;
    const requests: any[] = Array.isArray(doc.requests) ? doc.requests : [];
    if (!requests.length) {
      stats.skipped = 1;
      return stats;
    }
    stats.lines = requests.length;

    const session = `cp:${str(doc.sessionId) ?? basename(path, '.json')}`;
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
        raw: { source: ctx.sourceId, line: 0, offset: 0, length: size, block },
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
      const totalMs = num(result?.timings?.totalElapsed);
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

      // Tool rounds carry no timing; their events take the request time.
      for (const round of Array.isArray(metadata.toolCallRounds) ? metadata.toolCallRounds : []) {
        for (const call of Array.isArray(round?.toolCalls) ? round.toolCalls : []) {
          const name = str(call?.name) ?? '?';
          const callId = str(call?.id) ?? `${requestId}:${block}`;
          const tool = spanId(session, 'tool', callId);
          const kind = toolKind(name);
          const input = typeof call?.arguments === 'string' ? (tryJson(call.arguments) ?? call.arguments) : call?.arguments;
          const inputSummary = summarizeToolInput(name, input);
          const callEv = event('tool.call', ts, 'inherited', `${name}  ${inputSummary}`, {
            tool: { name, call_id: callId, kind, input: compact(input, { maxString: INDEX_INPUT_MAX_STRING }), input_summary: inputSummary },
          }, compact(call), { span: tool, turn });
          const out = metadata.toolCallResults?.[callId];
          const output = out === undefined ? '' : partsText(out?.content ?? out);
          const resultEv = out === undefined ? undefined : event('tool.result', ts, 'inherited', `${name}  → ${oneLine(output, 120)}`, {
            tool: { name, call_id: callId, kind, output: truncate(output, INDEX_TEXT_MAX), output_len: output.length },
          }, compact(out), { span: tool, turn });
          spans.push({
            rec: 'span', id: tool, session, kind: 'tool', name, parent: turn, start: ts, durSrc: 'unknown',
            status: resultEv ? 'ok' : 'unknown', firstEvent: callEv.id, lastEvent: resultEv?.id ?? callEv.id, attrs: { tool: { name, kind } },
          });
        }
      }

      const text = responseText(response);
      const error = str(result?.errorDetails?.message);
      const last = event('llm.text', end ?? ts, tsSrc, error ? `error: ${oneLine(error)}` : oneLine(text), {
        text: truncate(text, INDEX_TEXT_MAX),
        text_len: text.length,
        llm: { model, response_id: str(r?.responseId) ?? str(metadata.responseId), message_id: str(metadata.modelMessageId), ttft_ms: ttftMs, latency_ms: totalMs },
        error: error ? { message: truncate(error, 1024), type: str(result?.errorDetails?.code) } : undefined,
      }, compact({ responseId: r?.responseId, isCanceled: r?.isCanceled, response, result }), { span: llm, turn, dur, flags: error ? ['error'] : undefined });
      if (error) sink.emit({ rec: 'expert', session, event: last.id, severity: 'error', group: 'api-error', message: `Copilot request failed: ${oneLine(error, 200)}` });

      const status: SpanStatus = error ? 'error' : r?.isCanceled ? 'cancelled' : 'ok';
      const durSrc = dur !== undefined ? 'logged:result.timings.totalElapsed' : 'unknown';
      // totalElapsed covers the whole request, including any tool rounds inside it.
      spans.push({
        rec: 'span', id: llm, session, kind: 'llm', name: model ?? 'copilot', parent: turn, start: ts, end, dur, durSrc, status,
        firstEvent: last.id, lastEvent: last.id, attrs: { llm: { model, ttft_ms: ttftMs, latency_ms: totalMs } },
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
