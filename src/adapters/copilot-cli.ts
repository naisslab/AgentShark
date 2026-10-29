// Copilot agent sessions (CLI and the newer VS Code harness): `~/.copilot/session-state/<id>/events.jsonl`, and the
// flat `session-state/<id>.jsonl` of earlier versions. Each line is one session event
// `{id, timestamp, parentId, type, data}` (the Copilot SDK's session-events schema). A user message opens a
// turn; session.usage_record persists model usage in newer logs. SDK recorders can also retain the ephemeral
// assistant.usage event. Both describe the same call, so its usage identity prevents double counting. tool.execution_start and
// tool.execution_complete pair by toolCallId. Subagent events stay in the parent's file and nest under the
// tool call that started them (data.parentToolCallId).

import { glob, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Actor, Attrs, EventFlag, EventKind, EventRec, ExpertGroup, ExpertRec, ExpertSeverity, SpanRec, SpanStatus, TokenUsage } from '../model/types.ts';
import {
  type Adapter, type ParseStats, type SourceFile, INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, compact, emptyStats, eventId, fileInfo,
  isoToUs, msToUs, oneLine, readJsonl, spanId, summarizeToolInput, toolKind, truncate,
} from './adapter.ts';

interface Decoded {
  kind: EventKind;
  actor: Actor;
  summary: string;
  attrs: Attrs;
  flags?: EventFlag[];
  expert?: { severity: ExpertSeverity; group: ExpertGroup; message: string };
}

export const copilotCliAdapter: Adapter = {
  name: 'copilot-cli',

  async discover(env) {
    if (env.agents && !env.agents.includes('copilot')) return [];
    const base = join(env.home, '.copilot', 'session-state');
    const out: SourceFile[] = [];
    for await (const rel of glob(['*/events.jsonl', '*.jsonl'], { cwd: base })) {
      const f = await fileInfo(join(base, rel), 'copilot', 'session-events', 'copilot-cli');
      if (f) out.push(f);
    }
    return out;
  },

  async parse(ctx, sink) {
    const { path } = ctx.file;
    const stats: ParseStats = { ...emptyStats(), dialect: 'session-events' };
    const nested = basename(path) === 'events.jsonl';
    const workspace = nested ? await readWorkspace(join(dirname(path), 'workspace.yaml')) : {};
    let sid = nested ? basename(dirname(path)) : basename(path, '.jsonl');
    const session = () => `cp:${sid}`;
    const events: EventRec[] = [];
    const experts: ExpertRec[] = [];
    const spans = new Map<string, SpanRec>();
    const models = new Set<string>();
    const undecoded = new Set<string>();
    const usageIds = new Set<string>();
    const messages: { event: EventRec; callId?: string; toolIds: string[] }[] = [];
    let start: any;
    let title: string | undefined;
    let turn: SpanRec | undefined;
    let turnIndex = 0;
    let lastTs = 0;

    const read = await readJsonl(
      path,
      (o, info) => {
        const type = str(o?.type) ?? typeof o;
        const data = o?.data && typeof o.data === 'object' ? o.data : {};
        const usage = type === 'assistant.usage' ? data
          : type === 'session.usage_record' && data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage) ? data.usage : undefined;
        if (type === 'session.start' && !start) {
          start = data;
          const previous = session();
          sid = str(data.sessionId) ?? sid;
          if (session() !== previous) {
            const rename = (id: string | undefined) => id?.startsWith(`${previous}#`) ? session() + id.slice(previous.length) : id;
            for (const ev of events) { ev.turn = rename(ev.turn); ev.span = rename(ev.span); }
            const priorSpans = [...spans.values()];
            spans.clear();
            for (const sp of priorSpans) {
              sp.id = rename(sp.id)!;
              sp.parent = rename(sp.parent);
              spans.set(sp.id, sp);
            }
          }
        }
        if (type === 'session.title_changed') title = str(data.title) ?? title;
        for (const m of [data.selectedModel, data.newModel, data.model, usage?.model]) if (str(m)) models.add(m);
        const ts = isoToUs(o?.timestamp);
        let d = decode(type, data);
        const usageId = str(usage?.accounting?.usageId) ?? str(usage?.apiCallId);
        const usageKey = usageId ? JSON.stringify([str(usage?.accounting?.sourceSessionId) ?? sid, usageId]) : undefined;
        const duplicateUsage = usageKey !== undefined && usageIds.has(usageKey);
        if (usageKey) usageIds.add(usageKey);
        if (duplicateUsage) d = { kind: 'harness.other', actor: 'harness', summary: 'duplicate model usage', attrs: {}, flags: ['dup'] };
        if (!d) {
          stats.unknown++;
          if (!undecoded.has(type)) {
            undecoded.add(type);
            experts.push({ rec: 'expert', session: session(), event: eventId(ctx.sourceId, info.line), severity: 'note', group: 'undecoded', message: `Unknown Copilot CLI event type ${type}` });
          }
        }
        const ev: EventRec = {
          rec: 'event',
          id: eventId(ctx.sourceId, info.line),
          session: session(),
          ts: ts ?? lastTs,
          tsSrc: ts !== undefined ? 'logged' : lastTs ? 'inherited' : 'none',
          seq: events.length,
          kind: d?.kind ?? 'raw.unknown',
          proto: `copilot-cli/${type}`,
          actor: d?.actor ?? 'harness',
          summary: d?.summary ?? type,
          attrs: d?.attrs ?? {},
          native: compact(o),
          raw: { source: ctx.sourceId, line: info.line, offset: info.offset, length: info.length },
          flags: d?.flags,
        };
        if (ts !== undefined) lastTs = ts;
        if (d?.expert) experts.push({ rec: 'expert', session: ev.session, event: ev.id, ...d.expert });

        if (type === 'user.message') {
          turn = {
            rec: 'span', id: spanId(ev.session, 'turn', str(data.interactionId) ?? ev.id), session: ev.session, kind: 'turn', name: oneLine(str(data.content), 80),
            start: ev.ts, durSrc: 'derived:ts-gap', status: 'ok', firstEvent: ev.id, attrs: { turn: { id: str(data.interactionId), index: turnIndex } },
          };
          ev.attrs.turn = { id: str(data.interactionId), index: turnIndex++ };
          spans.set(turn.id, turn);
        }
        // Persisted usage belongs to the active turn; other session records describe the session itself.
        if (turn && (!type.startsWith('session.') || type === 'session.error' || usage !== undefined)) {
          ev.turn = turn.id;
          ev.span ??= turn.id;
          turn.end = Math.max(turn.end ?? turn.start, ev.ts);
          turn.lastEvent = ev.id;
          if (type === 'session.error' && turn.status === 'ok') turn.status = 'error';
        }
        if (type === 'abort' && turn) {
          turn.status = 'cancelled';
          turn = undefined;
        }
        const parentCall = str(usage?.parentToolCallId) ?? str(data.parentToolCallId);
        const parent = parentCall ? spanId(ev.session, 'tool', parentCall) : ev.turn;
        if (type === 'assistant.message') messages.push({ event: ev, callId: str(data.apiCallId) ?? str(data.requestId),
          toolIds: Array.isArray(data.toolRequests) ? data.toolRequests.map((t: any) => str(t?.toolCallId)).filter(Boolean) : [] });
        if (type === 'tool.execution_start' || type === 'tool.execution_complete') toolSpan(ev, data, parent, spans);
        else if (type.startsWith('subagent.') && str(data.toolCallId)) ev.span = spanId(ev.session, 'tool', data.toolCallId);
        else if (usage && !duplicateUsage) llmSpan(ev, usage, parent, spans,
          type === 'session.usage_record' ? 'session.usage_record.usage.duration' : 'assistant.usage.duration');
        else if (type === 'permission.requested' || type === 'permission.completed') pairedSpan(ev, 'permission', str(data.requestId), parent, spans);
        else if (type === 'hook.start' || type === 'hook.end') pairedSpan(ev, 'hook', str(data.hookInvocationId), parent, spans);
        events.push(ev);
      },
      (info, err) => {
        stats.malformed++;
        experts.push({ rec: 'expert', session: session(), severity: 'warn', group: 'malformed', message: `line ${info.line}: ${err.message}` });
      },
    );
    stats.parsedBytes = read.parsedBytes;
    stats.sha256 = read.sha256;
    stats.lines = read.lines;
    for (const expert of experts) sink.emit({ ...expert, session: session() });
    if (!events.length) {
      stats.skipped = 1;
      return stats;
    }

    const ctxt = start?.context ?? {};
    const cwd = str(ctxt.cwd) ?? workspace.cwd;
    const root = str(ctxt.gitRoot) ?? workspace.git_root ?? cwd;
    const git = { branch: str(ctxt.branch) ?? workspace.branch, commit: str(ctxt.headCommit), repo: str(ctxt.repository) ?? workspace.repository };
    // Usage may precede or follow its message. Join by logged call IDs, never by proximity or the entire turn.
    const byId = new Map(events.map(ev => [ev.id, ev]));
    const toolEvents = new Map<string, EventRec[]>();
    for (const ev of events) if (ev.kind === 'tool.call' && ev.attrs.tool?.call_id) {
      const id = ev.attrs.tool.call_id;
      const list = toolEvents.get(id) ?? [];
      list.push(ev);
      toolEvents.set(id, list);
    }
    for (const { event: ev, callId, toolIds } of messages) {
      const llm = callId ? spans.get(spanId(session(), 'llm', callId)) : undefined;
      ev.span = llm?.id;
      const mid = ev.attrs.llm?.message_id;
      if (!mid) continue;
      const usageEvent = llm?.firstEvent ? byId.get(llm.firstEvent) : undefined;
      if (usageEvent?.attrs.llm) usageEvent.attrs.llm.message_id = mid;
      for (const id of toolIds) for (const tool of toolEvents.get(id) ?? []) {
        tool.attrs.llm = { message_id: mid, model: ev.attrs.llm?.model };
        const sp = tool.span ? spans.get(tool.span) : undefined;
        if (llm && sp && sp.parent === tool.turn) sp.parent = llm.id;
      }
    }
    sink.emit({
      rec: 'session',
      id: session(),
      agent: 'copilot',
      nativeId: sid,
      role: 'main',
      title: title ?? workspace.summary,
      cwd,
      project: root ? basename(root) : undefined,
      git: Object.values(git).some(Boolean) ? git : undefined,
      models: [...models],
      version: str(start?.copilotVersion),
      entrypoint: str(start?.producer) ?? 'cli',
      createdTs: isoToUs(start?.startTime),
      meta: { reasoningEffort: str(start?.reasoningEffort), format: nested ? 'session-dir' : 'flat' },
    });
    // Events seen before the session.start that names the session belong to it too.
    for (const ev of events) {
      ev.session = session();
      sink.emit(ev);
    }
    for (const sp of spans.values()) {
      sp.session = session();
      if (sp.kind === 'turn' && sp.end !== undefined) sp.dur = sp.end - sp.start;
      sink.emit(sp);
    }
    return stats;
  },
};

/** One tool span per toolCallId, from its start event to its completion; nested under a subagent's call when it runs in one. */
function toolSpan(ev: EventRec, data: any, parent: string | undefined, spans: Map<string, SpanRec>): void {
  const id = spanId(ev.session, 'tool', str(data.toolCallId) ?? ev.id);
  ev.span = id;
  let sp = spans.get(id);
  if (!sp) {
    sp = {
      rec: 'span', id, session: ev.session, kind: 'tool', name: ev.attrs.tool?.name ?? '?', parent, start: ev.ts, durSrc: 'unknown', status: 'unknown',
      firstEvent: ev.id, lastEvent: ev.id, attrs: { tool: { name: ev.attrs.tool?.name, kind: ev.attrs.tool?.kind }, start_ts_src: ev.tsSrc },
    };
    spans.set(id, sp);
  }
  if (ev.kind !== 'tool.result') return;
  // Completions name only the call id; the name and kind come from its start.
  Object.assign(ev.attrs.tool!, sp.attrs.tool);
  ev.summary = `${sp.name}  ${ev.summary}`;
  sp.lastEvent = ev.id;
  sp.status = ev.attrs.tool?.is_error ? 'error' : 'ok';
  if (sp.firstEvent !== ev.id && sp.attrs.start_ts_src === 'logged' && ev.tsSrc === 'logged' && ev.ts >= sp.start) {
    sp.end = ev.ts;
    sp.dur = ev.dur = ev.ts - sp.start;
    sp.durSrc = 'derived:ts-gap';
  }
}

/** A permission prompt (requestId) or hook run (hookInvocationId): its first record opens the span, the second closes it. */
function pairedSpan(ev: EventRec, kind: 'permission' | 'hook', key: string | undefined, parent: string | undefined, spans: Map<string, SpanRec>): void {
  if (!key) return;
  const id = spanId(ev.session, kind, key);
  ev.span = id;
  const sp = spans.get(id);
  if (!sp) {
    const name = kind === 'hook' ? ev.attrs.hook?.name : ev.attrs.permission?.tool;
    spans.set(id, { rec: 'span', id, session: ev.session, kind, name: name ?? kind, parent, start: ev.ts, durSrc: 'unknown', status: 'open', firstEvent: ev.id, lastEvent: ev.id, attrs: {} });
    return;
  }
  const granted = ev.attrs.permission?.granted;
  const status: SpanStatus = ev.flags?.includes('error') ? 'error' : granted === false ? 'cancelled' : 'ok';
  Object.assign(sp, { lastEvent: ev.id, status, end: ev.ts, dur: ev.ts - sp.start, durSrc: 'derived:ts-gap' });
  ev.dur = sp.dur;
}

/** A usage record closes one model call: it ends at the record's time and lasts the logged duration. */
function llmSpan(ev: EventRec, data: any, parent: string | undefined, spans: Map<string, SpanRec>, durationField: string): void {
  const dur = msToUs(data.duration);
  const id = spanId(ev.session, 'llm', str(data.apiCallId) ?? str(data.requestId) ?? ev.id);
  ev.span = id;
  ev.dur = dur;
  spans.set(id, {
    rec: 'span', id, session: ev.session, kind: 'llm', name: str(data.model) ?? 'copilot', parent, start: dur !== undefined ? ev.ts - dur : ev.ts, end: ev.ts, dur,
    durSrc: dur !== undefined ? `logged:${durationField}` : 'unknown', status: 'ok', firstEvent: ev.id, lastEvent: ev.id,
    attrs: { llm: ev.attrs.llm, tokens: ev.attrs.tokens },
  });
}

function decode(type: string, d: any): Decoded | undefined {
  switch (type) {
    case 'session.usage_record':
      return d.usage && typeof d.usage === 'object' && !Array.isArray(d.usage) ? decode('assistant.usage', d.usage) : undefined;
    case 'system.message': {
      const text = str(d.content) ?? '';
      return { kind: 'context.snapshot', actor: 'system', summary: words(d.role ?? 'system', `prompt (${text.length} chars)`),
        attrs: { text: truncate(text, INDEX_TEXT_MAX), text_len: text.length, context: { type: 'system-prompt', role: str(d.role) } } };
    }
    case 'skill.invoked': {
      const text = str(d.content) ?? '';
      return { kind: 'context.attachment', actor: 'harness', summary: words('skill', d.name),
        attrs: { text: truncate(text, INDEX_TEXT_MAX), text_len: text.length,
          context: { type: 'skill', name: str(d.name), path: str(d.path), source: str(d.source) }, llm: { model: str(d.model) } } };
    }
    case 'skill.context_delivered_ref':
      return { kind: 'context.attachment', actor: 'harness', summary: 'skill context reference',
        attrs: { context: { type: 'skill-reference', content_id: str(d.contentId), source: str(d.source) } } };
    case 'session.start':
    case 'session.resume':
      return {
        kind: 'session.meta',
        actor: 'harness',
        summary: words(type === 'session.start' ? 'start' : 'resume', str(d.copilotVersion) && `v${d.copilotVersion}`, d.selectedModel, d.context?.cwd),
        attrs: { llm: { model: str(d.selectedModel), effort: str(d.reasoningEffort) }, version: str(d.copilotVersion), cwd: str(d.context?.cwd), producer: str(d.producer) },
      };
    case 'session.model_change':
      return { kind: 'session.meta', actor: 'harness', summary: words('model', d.previousModel, '→', d.newModel), attrs: { llm: { model: str(d.newModel), effort: str(d.reasoningEffort) } } };
    case 'session.title_changed':
      return { kind: 'session.meta', actor: 'harness', summary: words('title', oneLine(str(d.title), 120)), attrs: { title: str(d.title) } };
    case 'session.shutdown':
      return {
        kind: 'session.state',
        actor: 'harness',
        summary: words('shutdown', d.shutdownType, num(d.totalPremiumRequests) !== undefined && `· ${d.totalPremiumRequests} premium requests`,
          num(d.codeChanges?.linesAdded) !== undefined && `· +${d.codeChanges.linesAdded} −${d.codeChanges.linesRemoved ?? 0} lines`),
        attrs: { premium_requests: num(d.totalPremiumRequests), api_ms: num(d.totalApiDurationMs), files_modified: d.codeChanges?.filesModified?.length },
        flags: d.shutdownType === 'error' ? ['error'] : undefined,
      };
    case 'session.error':
      return {
        kind: 'llm.error',
        actor: 'harness',
        flags: ['error'],
        summary: words('error', d.errorType, num(d.statusCode) !== undefined && `(status ${d.statusCode})`, oneLine(str(d.message), 140)),
        attrs: { error: { type: str(d.errorType), status: num(d.statusCode), message: truncate(str(d.message), 1024) } },
        expert: { severity: 'error', group: 'api-error', message: `Copilot CLI error${d.errorType ? ` (${d.errorType})` : ''}: ${oneLine(str(d.message), 200)}` },
      };
    case 'session.warning':
    case 'session.info':
      return { kind: 'harness.status', actor: 'harness', summary: words(type.slice(8), oneLine(str(d.message), 140)), attrs: { text: truncate(str(d.message), INDEX_TEXT_MAX) } };
    case 'session.compaction_start':
    case 'session.compaction_complete':
      return {
        kind: 'context.compaction',
        actor: 'harness',
        summary: words('compaction', type.endsWith('start') ? 'started' : d.success === false ? 'failed' : 'done',
          num(d.preCompactionTokens) !== undefined && `${d.preCompactionTokens} → ${d.postCompactionTokens ?? '?'} tokens`),
        attrs: { context: { type: 'compaction', pre_tokens: num(d.preCompactionTokens), post_tokens: num(d.postCompactionTokens) } },
        flags: d.success === false ? ['error'] : undefined,
      };
    case 'user.message': {
      const text = str(d.content) ?? '';
      return {
        kind: 'user.prompt',
        actor: 'user',
        summary: oneLine(text),
        attrs: { text: truncate(text, INDEX_TEXT_MAX), text_len: text.length, copilot: { mode: str(d.agentMode), source: str(d.source), attachments: d.attachments?.length } },
      };
    }
    case 'assistant.turn_start':
    case 'assistant.turn_end':
      return { kind: type.endsWith('start') ? 'turn.start' : 'turn.end', actor: 'harness', summary: words(type.slice(10).replace('_', ' '), d.turnId), attrs: { llm: { model: str(d.model) } } };
    case 'assistant.message': {
      const text = str(d.content) ?? '';
      const tools = Array.isArray(d.toolRequests) ? d.toolRequests.map((t: any) => str(t?.name)).filter(Boolean) : [];
      return {
        kind: 'llm.text',
        actor: 'assistant',
        summary: text ? oneLine(text) : words('→', tools.join(', ')),
        attrs: { text: truncate(text, INDEX_TEXT_MAX), text_len: text.length, llm: { model: str(d.model), message_id: str(d.messageId), request_id: str(d.requestId) }, tool_requests: tools.length || undefined },
      };
    }
    case 'assistant.reasoning': {
      const text = str(d.content) ?? '';
      return { kind: 'llm.thinking', actor: 'assistant', summary: oneLine(text), attrs: { text: truncate(text, INDEX_TEXT_MAX), text_len: text.length } };
    }
    case 'assistant.usage': {
      const tokens: TokenUsage = {
        input: num(d.inputTokens), cache_read: num(d.cacheReadTokens), cache_write: num(d.cacheWriteTokens), output: num(d.outputTokens), reasoning: num(d.reasoningTokens),
      };
      return {
        kind: 'llm.usage',
        actor: 'assistant',
        summary: words(d.model ?? 'model', `in ${d.inputTokens ?? '?'}`, num(d.cacheReadTokens) ? `(cache ${d.cacheReadTokens})` : undefined, `out ${d.outputTokens ?? '?'}`, num(d.duration) !== undefined && `(${fmtMs(d.duration)})`),
        attrs: { tokens, llm: { model: str(d.model), request_id: str(d.requestId), stop_reason: str(d.finishReason), latency_ms: num(d.duration), ttft_ms: num(d.timeToFirstTokenMs), effort: str(d.reasoningEffort) } },
      };
    }
    case 'tool.execution_start': {
      const name = str(d.toolName) ?? '?';
      const inputSummary = summarizeToolInput(name, d.arguments);
      const kind = toolKind(name);
      return {
        kind: 'tool.call',
        actor: 'assistant',
        summary: `${name}  ${inputSummary}`,
        attrs: {
          tool: {
            name, call_id: str(d.toolCallId), kind: d.mcpServerName ? 'mcp' : kind, server: str(d.mcpServerName), command: kind === 'shell' ? str(d.arguments?.command) : undefined,
            input: compact(d.arguments, { maxString: INDEX_INPUT_MAX_STRING }), input_summary: inputSummary,
          },
        },
      };
    }
    case 'tool.execution_complete': {
      const output = str(d.result?.content) ?? str(d.error?.message) ?? '';
      const exitCode = num(d.shellExecution?.exitCode);
      const isError = d.success === false || (exitCode !== undefined && exitCode !== 0);
      return {
        kind: 'tool.result',
        actor: 'tool',
        flags: isError ? ['error'] : undefined,
        summary: words(isError ? 'error →' : '→', oneLine(output, 120)),
        attrs: { tool: { call_id: str(d.toolCallId), output: truncate(output, INDEX_TEXT_MAX), output_len: output.length, exit_code: exitCode, is_error: isError } },
      };
    }
    case 'subagent.started':
      return {
        kind: 'agent.spawn',
        actor: 'agent',
        summary: words('subagent', d.agentDisplayName ?? d.agentName, oneLine(str(d.agentDescription), 120)),
        attrs: { agent: { id: str(d.toolCallId), type: str(d.agentName), description: truncate(str(d.agentDescription), 512) }, llm: { model: str(d.model) } },
      };
    case 'subagent.completed':
    case 'subagent.failed':
      return {
        kind: 'agent.status',
        actor: 'agent',
        flags: type === 'subagent.failed' ? ['error'] : undefined,
        summary: words('subagent', d.agentDisplayName ?? d.agentName, type === 'subagent.failed' ? `failed: ${oneLine(str(d.error), 120)}` : d.cancelled ? 'cancelled' : 'completed'),
        attrs: { agent: { id: str(d.toolCallId), type: str(d.agentName), total_tokens: num(d.totalTokens), tool_uses: num(d.totalToolCalls), duration_ms: num(d.durationMs) } },
      };
    case 'abort':
      return { kind: 'turn.abort', actor: 'user', summary: words('abort', d.reason), attrs: { reason: str(d.reason) }, expert: { severity: 'note', group: 'interrupted', message: `Turn aborted (${d.reason ?? 'unknown reason'})` } };
    case 'hook.start':
    case 'hook.end': {
      const failed = d.success === false;
      return {
        kind: 'hook.run',
        actor: 'harness',
        flags: failed ? ['error'] : undefined,
        summary: words('hook', d.hookType, type === 'hook.start' ? 'started' : failed ? `failed: ${oneLine(str(d.error?.message), 120)}` : 'done'),
        attrs: { hook: { name: str(d.hookType), event: str(d.hookType) }, error: failed ? { message: truncate(str(d.error?.message), 1024) } : undefined },
      };
    }
    case 'permission.requested': {
      const req = d.permissionRequest ?? {};
      const what = str(req.fullCommandText) ?? str(req.intention);
      return {
        kind: 'permission.request',
        actor: 'harness',
        summary: words('permission?', req.kind, oneLine(what, 120)),
        attrs: { permission: { tool: str(req.kind), mode: str(d.permissionMode), request_id: str(d.requestId) }, tool: { call_id: str(req.toolCallId), command: str(req.fullCommandText) } },
      };
    }
    case 'permission.completed': {
      const decision = str(d.result?.kind);
      const denied = decision?.startsWith('denied') ?? false;
      return {
        kind: 'permission.decision',
        actor: d.decisionSource === 'human_response' ? 'user' : 'harness',
        summary: words('permission', decision, d.decisionSource && `(${d.decisionSource})`),
        attrs: { permission: { decision, granted: decision ? decision.startsWith('approved') : undefined, reason: str(d.decisionSource), request_id: str(d.requestId) } },
        expert: denied ? { severity: 'warn', group: 'permission-denied', message: `Permission ${decision}` } : undefined,
      };
    }
  }
  // The remaining session.* records describe the harness (tools, skills, MCP servers loaded or changed).
  return type.startsWith('session.') ? { kind: 'harness.other', actor: 'harness', summary: type.slice(8).replace(/_/g, ' '), attrs: {} } : undefined;
}

/** The flat `key: value` lines of workspace.yaml (cwd, git_root, repository, branch, summary). */
async function readWorkspace(path: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^([a-z_]+):[ \t]*(.+?)[ \t]*$/gm)) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  return out;
}

function words(...parts: unknown[]): string {
  return parts.filter((p) => typeof p === 'string' && p).join(' ');
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
