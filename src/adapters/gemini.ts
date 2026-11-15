// Google Gemini sessions:
// 1. Gemini macOS App (`Gemini.app` / `com.google.GeminiMacOS`) Code Mode trajectories (`trajectory_meta.source === 21`
//    in `~/.gemini/antigravity/{conversations,brain}`) and exported Runtime Inspector `VegaTrajectoryArchives/*.json`.
// 2. Gemini CLI (`@google/gemini-cli`) chat recordings under `~/.gemini/tmp/<project>/chats/session-*.json`.
// Standard cloud-only chats in Gemini.app stay server-side unless Code Mode or Runtime Inspector writes local traces.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Attrs, EventFlag, EventKind, EventRec, SpanRec, SpanStatus, TokenUsage } from '../model/types.ts';
import {
  type Adapter, type ParseContext, type ParseStats, type RecordSink, type SourceFile,
  INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, agentRoots, compact, editChanges, emptyStats, eventId, fileInfo,
  isoToUs, msToUs, oneLine, outputTail, secToUs, sha256, spanId, summarizeToolInput, toolKind, truncate, tryJson,
} from './adapter.ts';
import { type CortexTarget, discoverCortexSources, parseCortexSource, trajectoryGroupKey } from './antigravity.ts';

const GEMINI_CORTEX_TARGET: CortexTarget = { agent: 'gemini', prefix: 'gm', protoPrefix: 'gemini-cortex' };

export const geminiAdapter: Adapter = {
  name: 'gemini',
  groupKey: trajectoryGroupKey,

  async discover(env) {
    if (env.agents && !env.agents.includes('gemini')) return [];
    const out: SourceFile[] = [];
    const seen = new Set<string>();
    const add = (f: SourceFile | null) => {
      if (f && !seen.has(f.path)) {
        seen.add(f.path);
        out.push(f);
      }
    };

    const roots = agentRoots(env, 'gemini');

    // 1. Gemini.app Code Mode Cortex trajectories (`trajectory_meta.source === 21`).
    const cortexBases = [
      ...roots.map((r) => join(r, 'antigravity')),
      ...roots,
      ...(env.antigravityRoots ?? []),
    ];
    for (const f of await discoverCortexSources(env, cortexBases, 'gemini', 'gemini')) add(f);

    // 2. Gemini CLI session JSONs (`<root>/tmp/<project>/chats/session-*.json`, or direct `chats/` / `tmp/` roots).
    for (const root of roots) {
      const tmpDir = basename(root) === 'tmp' ? root : join(root, 'tmp');
      const projects = await readdir(tmpDir, { withFileTypes: true }).catch(() => []);
      for (const proj of projects) {
        if (!proj.isDirectory()) continue;
        const chatsDir = join(tmpDir, proj.name, 'chats');
        for (const name of await readdir(chatsDir).catch(() => [] as string[])) {
          if (name.startsWith('session-') && name.endsWith('.json')) {
            add(await fileInfo(join(chatsDir, name), 'gemini', 'gemini-session', 'gemini'));
          }
        }
      }
      // Also support pointing a custom geminiRoot directly at a `chats` folder or a `<project>` folder.
      for (const directChats of [root, join(root, 'chats')]) {
        for (const name of await readdir(directChats).catch(() => [] as string[])) {
          if (name.startsWith('session-') && name.endsWith('.json')) {
            add(await fileInfo(join(directChats, name), 'gemini', 'gemini-session', 'gemini'));
          }
        }
      }
    }

    // 3. Gemini.app VegaTrajectoryArchives JSON exports.
    const vegaDirs = [
      ...(env.autoDiscover === false ? [] : [
        join(env.appSupport, 'com.google.GeminiMacOS', 'VegaTrajectoryArchives'),
        join(env.home, 'Library', 'Caches', 'com.google.GeminiMacOS', 'VegaTrajectoryArchives'),
      ]),
      ...roots.flatMap((r) => basename(r) === 'VegaTrajectoryArchives' ? [r] : [join(r, 'VegaTrajectoryArchives')]),
    ];
    for (const dir of [...new Set(vegaDirs)]) {
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (name.endsWith('.json')) {
          add(await fileInfo(join(dir, name), 'gemini', 'gemini-session', 'gemini'));
        }
      }
    }

    return out;
  },

  async parse(ctx, sink) {
    if (ctx.file.kind === 'trajectory-db' || ctx.file.kind === 'antigravity-transcript') {
      return parseCortexSource(ctx, sink, GEMINI_CORTEX_TARGET);
    }
    return parseGeminiJson(ctx, sink);
  },
};

// ---------------------------------------------------------------------------
// JSON session parser (Gemini CLI `session-*.json` & Gemini.app `VegaTrajectoryArchive`)

async function parseGeminiJson(ctx: ParseContext, sink: RecordSink): Promise<ParseStats> {
  const { path } = ctx.file;
  const bytes = await readFile(path);
  const stats: ParseStats = { ...emptyStats(), parsedBytes: bytes.length, sha256: sha256(bytes) };
  const doc = tryJson(bytes.toString('utf8')) as Record<string, any> | undefined;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    stats.malformed = 1;
    sink.emit({ rec: 'expert', severity: 'warn', group: 'malformed', message: `${basename(path)} is not a JSON object` });
    return stats;
  }

  if (Array.isArray(doc.messages)) {
    return parseGeminiCliSession(ctx, sink, doc, stats);
  }
  if (Array.isArray(doc.steps) || Array.isArray(doc.modelCalls) || (doc.trajectory && typeof doc.trajectory === 'object')) {
    return parseVegaArchive(ctx, sink, doc, stats);
  }

  stats.unknown = 1;
  stats.skipped = 1;
  sink.emit({ rec: 'expert', severity: 'note', group: 'undecoded', message: `Unrecognized Gemini JSON document shape in ${basename(path)}` });
  return stats;
}

async function parseGeminiCliSession(
  ctx: ParseContext,
  sink: RecordSink,
  doc: Record<string, any>,
  stats: ParseStats,
): Promise<ParseStats> {
  stats.dialect = 'gemini-cli-session';
  const messages: any[] = doc.messages;
  stats.lines = messages.length;
  if (!messages.length) {
    stats.skipped = 1;
    return stats;
  }

  const nativeId = str(doc.sessionId) ?? basename(ctx.file.path, '.json');
  const session = `gm:${nativeId}`;
  const cwd = await resolveGeminiCliCwd(ctx.file.path, str(doc.projectHash));
  const createdTs = anyTimeUs(doc.startTime);
  const parentNative = str(doc.parentSessionId);
  const role = doc.kind === 'subagent' || parentNative ? 'subagent' : 'main';

  const events: EventRec[] = [];
  const spans: SpanRec[] = [];
  const models = new Set<string>();
  let firstPrompt: string | undefined;
  let turn: SpanRec | undefined;
  let turnIndex = 0;
  let block = 0;
  let lastTs = createdTs ?? 0;

  const emit = (
    kind: EventKind,
    proto: string,
    actor: EventRec['actor'],
    summaryText: string,
    attrs: Attrs,
    at?: number,
    native?: unknown,
    flags?: EventFlag[],
  ): EventRec => {
    const ts = at ?? lastTs;
    const ev: EventRec = {
      rec: 'event',
      id: eventId(ctx.sourceId, 0, block),
      session,
      ts,
      tsSrc: at !== undefined ? 'logged' : lastTs ? 'inherited' : 'none',
      seq: events.length,
      kind,
      proto,
      actor,
      summary: summaryText,
      span: turn?.id,
      turn: turn?.id,
      attrs,
      native,
      raw: { source: ctx.sourceId, line: 0, offset: 0, length: stats.parsedBytes, block },
      flags,
    };
    block++;
    if (at !== undefined) lastTs = Math.max(lastTs, at);
    if (turn) {
      turn.end = Math.max(turn.end ?? turn.start, ev.ts);
      turn.lastEvent = ev.id;
      if (flags?.includes('error') && kind.startsWith('llm.') && turn.status === 'ok') turn.status = 'error';
    }
    events.push(ev);
    return ev;
  };

  messages.forEach((msg, msgIdx) => {
    if (!msg || typeof msg !== 'object') {
      stats.malformed++;
      return;
    }
    const type = str(msg.type) ?? 'unknown';
    const ts = anyTimeUs(msg.timestamp);
    const msgId = str(msg.id) ?? String(msgIdx);
    const text = extractGeminiContent(msg.content);

    if (type === 'user') {
      if (!firstPrompt && text) firstPrompt = oneLine(text, 120);
      turn = undefined;
      const ev = emit('user.prompt', 'gemini-cli/user', 'user', oneLine(text), {
        text: truncate(text, INDEX_TEXT_MAX), text_len: text.length,
      }, ts, compact({ id: msg.id, type }));
      turn = {
        rec: 'span',
        id: spanId(session, 'turn', msgId),
        session,
        kind: 'turn',
        name: oneLine(text, 80),
        start: ev.ts,
        durSrc: 'derived:ts-gap',
        status: 'ok',
        firstEvent: ev.id,
        lastEvent: ev.id,
        attrs: { turn: { index: turnIndex } },
      };
      ev.turn = ev.span = turn.id;
      ev.attrs.turn = { index: turnIndex++ };
      spans.push(turn);
      return;
    }

    if (type === 'gemini' || type === 'model' || type === 'assistant') {
      const model = str(msg.model);
      if (model) models.add(model);
      const tokens = geminiCliTokens(msg.tokens);
      const thoughts: any[] = Array.isArray(msg.thoughts) ? msg.thoughts : [];
      const calls: any[] = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
      const callNames = calls.map((c) => str(c?.name)).filter((n): n is string => !!n);

      const prevEventTs = events.at(-1)?.ts;
      const llmStart = thoughts.length ? (anyTimeUs(thoughts[0]?.timestamp) ?? prevEventTs ?? ts ?? lastTs) : (prevEventTs ?? ts ?? lastTs);
      const llmEnd = ts ?? lastTs;
      const llmDur = ts !== undefined && prevEventTs !== undefined && llmEnd >= llmStart ? llmEnd - llmStart : undefined;

      const thoughtEvents: EventRec[] = [];
      for (const th of thoughts) {
        const subject = str(th?.subject);
        const desc = str(th?.description) ?? str(th?.text) ?? '';
        const body = subject && desc ? `${subject}: ${desc}` : (subject ?? desc);
        if (!body) continue;
        thoughtEvents.push(emit('llm.thinking', 'gemini-cli/thought', 'assistant', oneLine(body), {
          text: truncate(body, INDEX_TEXT_MAX), text_len: body.length,
        }, anyTimeUs(th?.timestamp) ?? ts));
      }

      const llmMeta = cleanObj({ model, message_id: str(msg.id), latency_ms: llmDur !== undefined ? llmDur / 1000 : undefined });
      const textEv = emit('llm.text', 'gemini-cli/gemini', 'assistant', text ? oneLine(text) : callNames.length ? `→ ${callNames.join(', ')}` : '(empty)', {
        text: truncate(text, INDEX_TEXT_MAX),
        text_len: text.length,
        llm: llmMeta,
        tokens,
        tool_requests: callNames.length || undefined,
      }, ts, compact({ id: msg.id, type, model, tokens: msg.tokens }));

      const llmSpanId = spanId(session, 'llm', msgId);
      const firstEv = thoughtEvents[0] ?? textEv;
      spans.push({
        rec: 'span',
        id: llmSpanId,
        session,
        kind: 'llm',
        name: model ?? 'gemini',
        parent: turn?.id,
        start: llmStart,
        end: llmDur !== undefined ? llmEnd : undefined,
        dur: llmDur,
        durSrc: llmDur !== undefined ? 'derived:ts-gap' : 'unknown',
        status: 'ok',
        firstEvent: firstEv.id,
        lastEvent: textEv.id,
        attrs: { llm: llmMeta, tokens },
      });
      for (const e of [...thoughtEvents, textEv]) e.span = llmSpanId;
      textEv.dur = llmDur;

      calls.forEach((tc, tcIdx) => {
        if (!tc || typeof tc !== 'object') return;
        const name = str(tc.name) ?? 'tool';
        const callId = str(tc.id) ?? `${msgId}-call-${tcIdx}`;
        const input = tc.args ?? {};
        const kind = toolKind(name);
        const inputSummary = summarizeToolInput(name, input);
        const command = kind === 'shell' ? str(input?.command) ?? str(input?.cmd) : undefined;
        const changes = editChanges(name, input);
        const callTs = anyTimeUs(tc.timestamp) ?? ts;
        const callEv = emit('tool.call', 'gemini-cli/toolCall', 'assistant', `${name}  ${inputSummary}`, {
          tool: { name, call_id: callId, kind, command, input: compact(input, { maxString: INDEX_INPUT_MAX_STRING }), input_summary: inputSummary },
          ...(changes.length ? { change: { files: changes } } : {}),
        }, callTs, compact({ id: tc.id, name, status: tc.status }));

        const statusStr = (str(tc.status) ?? '').toLowerCase();
        const hasResult = tc.result !== undefined || tc.resultDisplay !== undefined || ['success', 'ok', 'completed', 'error', 'failed', 'cancelled', 'canceled'].includes(statusStr);
        const spId = spanId(session, 'tool', callId);
        if (hasResult) {
          const { output, exitCode, errMsg } = extractGeminiToolResult(tc);
          const isError = statusStr === 'error' || statusStr === 'failed' || errMsg !== undefined || (exitCode !== undefined && exitCode !== 0);
          const cancelled = statusStr === 'cancelled' || statusStr === 'canceled';
          const resTs = anyTimeUs(tc.completedAt) ?? callEv.ts;
          const dur = resTs >= callEv.ts && tc.completedAt !== undefined ? resTs - callEv.ts : undefined;
          const resEv = emit('tool.result', 'gemini-cli/toolResult', 'tool', `${name}  ${isError ? 'error →' : cancelled ? 'cancelled →' : '→'} ${oneLine(output, 120)}`.trim(), {
            tool: {
              name, call_id: callId, kind, output: truncate(output, INDEX_TEXT_MAX), output_len: output.length,
              output_tail: outputTail(output), exit_code: exitCode, is_error: isError, status: statusStr || undefined,
            },
            error: errMsg ? { message: truncate(errMsg, 1024) } : undefined,
          }, resTs, undefined, isError ? ['error'] : undefined);
          const spanStatus: SpanStatus = cancelled ? 'cancelled' : isError ? 'error' : 'ok';
          spans.push({
            rec: 'span', id: spId, session, kind: 'tool', name, parent: turn?.id,
            start: callEv.ts, end: dur !== undefined ? resTs : undefined, dur,
            durSrc: dur !== undefined ? 'logged:toolCall.completedAt' : 'unknown',
            status: spanStatus, firstEvent: callEv.id, lastEvent: resEv.id, attrs: { tool: { name, kind } },
          });
          callEv.span = spId;
          resEv.span = spId;
          resEv.dur = dur;
        } else {
          callEv.span = spId;
          spans.push({
            rec: 'span', id: spId, session, kind: 'tool', name, parent: turn?.id,
            start: callEv.ts, durSrc: 'unknown', status: 'open',
            firstEvent: callEv.id, lastEvent: callEv.id, attrs: { tool: { name, kind } },
          });
        }
      });
      return;
    }

    if (type === 'error') {
      const ev = emit('llm.error', 'gemini-cli/error', 'harness', `error ${oneLine(text, 140)}`.trim(), {
        text: truncate(text, INDEX_TEXT_MAX), text_len: text.length, error: { message: truncate(text || 'error', 1024) },
      }, ts, compact({ id: msg.id, type }), ['error']);
      sink.emit({ rec: 'expert', session, event: ev.id, severity: 'error', group: 'api-error', message: `Gemini CLI error: ${oneLine(text || 'error', 200)}` });
      return;
    }

    if (type === 'warning' || type === 'info') {
      emit('harness.status', `gemini-cli/${type}`, 'harness', oneLine(text || type, 140), {
        text: truncate(text, INDEX_TEXT_MAX), text_len: text.length,
      }, ts, compact({ id: msg.id, type }));
      return;
    }

    stats.unknown++;
    emit('raw.unknown', `gemini-cli/${type}`, 'harness', `message ${type}`, {}, ts, compact({ id: msg.id, type }));
  });

  if (!events.length) {
    stats.skipped = 1;
    return stats;
  }

  sink.emit({
    rec: 'session',
    id: session,
    agent: 'gemini',
    nativeId,
    role,
    parentId: parentNative ? `gm:${parentNative}` : undefined,
    title: str(doc.summary) ?? str(doc.title) ?? firstPrompt,
    cwd,
    project: cwd ? basename(cwd) : undefined,
    models: [...models],
    entrypoint: 'cli',
    createdTs,
    meta: cleanObj({ projectHash: str(doc.projectHash), lastUpdatedTs: anyTimeUs(doc.lastUpdated) }),
  });
  for (const ev of events) sink.emit(ev);
  for (const sp of spans) {
    if (sp.kind === 'turn' && sp.end !== undefined) sp.dur = sp.end - sp.start;
    sink.emit(sp);
  }
  return stats;
}

async function parseVegaArchive(
  ctx: ParseContext,
  sink: RecordSink,
  doc: Record<string, any>,
  stats: ParseStats,
): Promise<ParseStats> {
  stats.dialect = 'vega-trajectory-archive';
  const root = doc.trajectory && typeof doc.trajectory === 'object' ? (doc.trajectory as Record<string, any>) : doc;
  const steps: any[] = Array.isArray(root.steps) ? root.steps : [];
  const modelCalls: any[] = Array.isArray(root.modelCalls) ? root.modelCalls : [];
  const items = steps.length ? steps : modelCalls;
  stats.lines = items.length;
  if (!items.length) {
    stats.skipped = 1;
    return stats;
  }

  const nativeId = str(doc.id) ?? str(doc.threadId) ?? str(doc.taskId) ?? str(root.id) ?? basename(ctx.file.path, '.json');
  const session = `gm:${nativeId}`;
  const createdTs = anyTimeUs(doc.createdAt ?? root.createdAt ?? doc.timestamp);
  const cwd = str(doc.workspacePath) ?? str(root.workspacePath);
  const models = new Set<string>();
  const events: EventRec[] = [];
  const spans: SpanRec[] = [];
  let block = 0;
  let lastTs = createdTs ?? 0;

  const turnId = spanId(session, 'turn', 0);
  const emit = (kind: EventKind, proto: string, actor: EventRec['actor'], summaryText: string, attrs: Attrs, at?: number, flags?: EventFlag[]): EventRec => {
    const ts = at ?? lastTs;
    const ev: EventRec = {
      rec: 'event', id: eventId(ctx.sourceId, 0, block), session, ts, tsSrc: at !== undefined ? 'logged' : lastTs ? 'inherited' : 'none',
      seq: events.length, kind, proto, actor, summary: summaryText, span: turnId, turn: turnId, attrs,
      raw: { source: ctx.sourceId, line: 0, offset: 0, length: stats.parsedBytes, block }, flags,
    };
    block++;
    if (at !== undefined) lastTs = Math.max(lastTs, at);
    events.push(ev);
    return ev;
  };

  const prompt = str(doc.prompt) ?? str(root.prompt) ?? str(doc.title) ?? str(root.title);
  if (prompt) emit('user.prompt', 'vega/prompt', 'user', oneLine(prompt), { text: truncate(prompt, INDEX_TEXT_MAX), text_len: prompt.length }, createdTs);

  items.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const ts = anyTimeUs(item.timestamp ?? item.createdAt ?? item.startedAt);
    const endTs = anyTimeUs(item.completedAt ?? item.finishedAt);
    const dur = ts !== undefined && endTs !== undefined && endTs >= ts ? endTs - ts : undefined;
    const model = str(item.model);
    if (model) models.add(model);

    if (item.thought || item.thinking) {
      const th = String(item.thought ?? item.thinking);
      emit('llm.thinking', 'vega/thought', 'assistant', oneLine(th), { text: truncate(th, INDEX_TEXT_MAX), text_len: th.length }, ts);
    }
    if (item.toolName || item.functionCall || item.toolCall) {
      const tc = item.functionCall ?? item.toolCall ?? item;
      const name = str(tc.name ?? item.toolName) ?? 'tool';
      const input = tc.args ?? tc.arguments ?? {};
      const kind = toolKind(name);
      const inputSummary = summarizeToolInput(name, input);
      const callId = str(tc.id ?? item.toolCallId) ?? `vega-${idx}`;
      const callEv = emit('tool.call', 'vega/toolCall', 'assistant', `${name}  ${inputSummary}`, {
        tool: { name, call_id: callId, kind, input: compact(input, { maxString: INDEX_INPUT_MAX_STRING }), input_summary: inputSummary },
      }, ts);
      const outText = str(item.result ?? item.output ?? tc.result) ?? '';
      const isErr = item.status === 'error' || item.status === 'failed' || Boolean(item.error);
      const resEv = emit('tool.result', 'vega/toolResult', 'tool', `${name}  ${isErr ? 'error →' : '→'} ${oneLine(outText, 120)}`.trim(), {
        tool: { name, call_id: callId, kind, output: truncate(outText, INDEX_TEXT_MAX), output_len: outText.length, is_error: isErr },
      }, endTs ?? ts, isErr ? ['error'] : undefined);
      const spId = spanId(session, 'tool', callId);
      spans.push({
        rec: 'span', id: spId, session, kind: 'tool', name, parent: turnId,
        start: callEv.ts, end: dur !== undefined ? endTs : undefined, dur,
        durSrc: dur !== undefined ? 'logged:completedAt' : 'unknown', status: isErr ? 'error' : 'ok',
        firstEvent: callEv.id, lastEvent: resEv.id, attrs: { tool: { name, kind } },
      });
      callEv.span = spId;
      resEv.span = spId;
      resEv.dur = dur;
      return;
    }
    const reply = str(item.reply ?? item.text ?? item.title ?? item.summary) ?? '';
    if (reply || model) {
      const ev = emit('llm.text', 'vega/modelCall', 'assistant', oneLine(reply || model || 'step'), {
        text: truncate(reply, INDEX_TEXT_MAX), text_len: reply.length, llm: cleanObj({ model, latency_ms: dur !== undefined ? dur / 1000 : undefined }),
      }, endTs ?? ts);
      const spId = spanId(session, 'llm', idx);
      spans.push({
        rec: 'span', id: spId, session, kind: 'llm', name: model ?? 'gemini', parent: turnId,
        start: ts ?? ev.ts, end: dur !== undefined ? endTs : undefined, dur,
        durSrc: dur !== undefined ? 'logged:completedAt' : 'unknown', status: 'ok',
        firstEvent: ev.id, lastEvent: ev.id, attrs: { llm: cleanObj({ model }) },
      });
      ev.span = spId;
      ev.dur = dur;
    }
  });

  if (!events.length) {
    stats.skipped = 1;
    return stats;
  }

  const firstEv = events[0];
  const lastEv = events.at(-1)!;
  spans.unshift({
    rec: 'span', id: turnId, session, kind: 'turn', name: oneLine(prompt ?? str(doc.title) ?? 'Gemini task', 80),
    start: firstEv.ts, end: lastEv.ts, dur: lastEv.ts - firstEv.ts, durSrc: 'derived:ts-gap', status: 'ok',
    firstEvent: firstEv.id, lastEvent: lastEv.id, attrs: { turn: { index: 0 } },
  });

  sink.emit({
    rec: 'session',
    id: session,
    agent: 'gemini',
    nativeId,
    role: 'main',
    title: str(doc.title ?? root.title) ?? (prompt ? oneLine(prompt, 120) : undefined),
    cwd,
    project: cwd ? basename(cwd) : undefined,
    models: [...models],
    entrypoint: 'app',
    createdTs: createdTs ?? firstEv.ts,
  });
  for (const ev of events) sink.emit(ev);
  for (const sp of spans) sink.emit(sp);
  return stats;
}

// ---------------------------------------------------------------------------
// Helpers

async function resolveGeminiCliCwd(sessionPath: string, projectHash?: string): Promise<string | undefined> {
  // <geminiRoot>/tmp/<projectDir>/chats/session-*.json
  const chatsDir = dirname(sessionPath);
  const projectDir = basename(chatsDir) === 'chats' ? dirname(chatsDir) : chatsDir;
  const rootMarker = await readFile(join(projectDir, '.project_root'), 'utf8').catch(() => '');
  if (rootMarker.trim()) return rootMarker.trim();

  const tmpDir = dirname(projectDir);
  const geminiRoot = basename(tmpDir) === 'tmp' ? dirname(tmpDir) : undefined;
  if (!geminiRoot) return undefined;
  const projectsJson = tryJson(await readFile(join(geminiRoot, 'projects.json'), 'utf8').catch(() => '')) as Record<string, any> | undefined;
  const map = projectsJson?.projects;
  if (!map || typeof map !== 'object') return undefined;
  const folderName = basename(projectDir);
  for (const [workspacePath, slug] of Object.entries(map)) {
    if (slug === folderName) return workspacePath;
    if (projectHash && createHash('sha256').update(workspacePath).digest('hex') === projectHash) return workspacePath;
  }
  return undefined;
}

function extractGeminiContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        if (typeof (part as any).text === 'string') return (part as any).text;
        if ((part as any).inlineData) return `[inline ${(part as any).inlineData.mimeType ?? 'media'}]`;
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object' && typeof (content as any).text === 'string') return (content as any).text;
  return '';
}

function geminiCliTokens(t: unknown): TokenUsage | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const o = t as Record<string, unknown>;
  const input = num(o.input ?? o.prompt);
  const output = num(o.output ?? o.candidates);
  const cached = num(o.cached);
  const thoughts = num(o.thoughts);
  const total = num(o.total);
  if (input === undefined && output === undefined && cached === undefined && thoughts === undefined && total === undefined) return undefined;
  return {
    input,
    uncached: input !== undefined ? Math.max(0, input - (cached ?? 0)) : undefined,
    cache_read: cached,
    output,
    reasoning: thoughts,
    total,
  };
}

function extractGeminiToolResult(tc: Record<string, any>): { output: string; exitCode?: number; errMsg?: string } {
  const display = typeof tc.resultDisplay === 'string' ? tc.resultDisplay : tc.resultDisplay && typeof tc.resultDisplay === 'object'
    ? (str(tc.resultDisplay.output) ?? str(tc.resultDisplay.diff) ?? JSON.stringify(tc.resultDisplay))
    : undefined;
  let output = display ?? '';
  let errMsg = str(tc.error);
  let exitCode = typeof tc.exitCode === 'number' ? tc.exitCode : undefined;

  const resList = Array.isArray(tc.result) ? tc.result : tc.result !== undefined ? [tc.result] : [];
  for (const item of resList) {
    if (typeof item === 'string' && !output) output = item;
    const resp = item?.functionResponse?.response;
    if (resp && typeof resp === 'object') {
      if (!output && typeof resp.output === 'string') output = resp.output;
      if (!errMsg && typeof resp.error === 'string' && resp.error) errMsg = resp.error;
      if (exitCode === undefined && typeof resp.exitCode === 'number') exitCode = resp.exitCode;
    }
  }
  if (!output && errMsg) output = errMsg;
  if (exitCode === undefined && output) {
    const m = /(?:^|\n)Exit Code:\s*(-?\d+)/i.exec(output);
    if (m) exitCode = Number(m[1]);
  }
  return { output, exitCode, errMsg };
}

function anyTimeUs(v: unknown): number | undefined {
  if (typeof v === 'string') return isoToUs(v);
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? msToUs(v) : secToUs(v);
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function cleanObj<T extends Record<string, unknown>>(obj: T): T | undefined {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
      any = true;
    }
  }
  return any ? (out as T) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
