// Cowork `local_<uuid>/audit.jsonl` (SPEC §4.3): the Agent SDK stream-json log of a Cowork session.
// Its user and assistant records duplicate the transcript and are skipped; everything the transcript
// lacks (turn results with logged durations and cost, retries, rate limits, permission waits, status)
// becomes events of the `cw:<session_id>` session.

import { glob } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Actor, Attrs, EventFlag, EventKind, EventRec, ExpertGroup, ExpertSeverity, SessionRec, SpanRec } from '../model/types.ts';
import {
  type Adapter, type ParseStats, type RecordSink, type SourceFile, INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, compact, emptyStats, eventId, fileInfo,
  isoToUs, msToUs, oneLine, readJsonl, spanId, summarizeToolInput, toolKind, truncate,
} from './adapter.ts';
import { findTranscript, readRegistry } from './claude-desktop.ts';

interface Decoded {
  kind: EventKind;
  actor: Actor;
  summary: string;
  attrs: Attrs;
  flags?: EventFlag[];
  dur?: number;
  expert?: { severity: ExpertSeverity; group: ExpertGroup; message: string };
}

const RATE_WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10080 };

export const coworkAuditAdapter: Adapter = {
  name: 'cowork-audit',

  async discover(env) {
    if (env.agents && !env.agents.includes('claude-cowork')) return [];
    const base = join(env.appSupport, 'Claude', 'local-agent-mode-sessions');
    const out: SourceFile[] = [];
    for await (const rel of glob(['*/*/local_*/audit.jsonl', '*/*/agent/local_ditto_*/audit.jsonl'], { cwd: base })) {
      const f = await fileInfo(join(base, rel), 'claude-cowork', 'audit', 'cowork-audit');
      if (f) out.push(f);
    }
    return out;
  },

  async parse(ctx, sink) {
    const stats: ParseStats = { ...emptyStats(), dialect: 'sdk-stream-json' };
    const sessionDir = dirname(ctx.file.path);
    const reg = await readRegistry(`${sessionDir}.json`);
    // The session the registry adapter already owns (its CLI id, or the registry id when there is none).
    const regSid = reg ? str(reg.cliSessionId) ?? str(reg.sessionId) ?? basename(sessionDir) : undefined;
    // App-injected records written before system/init carry a session_id that matches no CLI session;
    // they belong to the session that is current at that point.
    let current = str(reg?.cliSessionId);
    const known = new Set<string>(current ? [current] : []);
    const inits = new Map<string, any>();
    const events: EventRec[] = [];
    const spans: SpanRec[] = [];
    const pending = new Map<string, EventRec[]>();
    const undecoded = new Set<string>();
    let lastTs = 0;

    const read = await readJsonl(
      ctx.file.path,
      (o, info) => {
        const type = str(o?.type) ?? typeof o;
        const subtype = str(o?.subtype);
        const key = subtype ? `${type}/${subtype}` : type;
        if (type === 'assistant' || type === 'user') {
          stats.skipped++;
          return;
        }
        if (key === 'system/init' && str(o.session_id)) {
          known.add(o.session_id);
          current = o.session_id;
          if (!inits.has(o.session_id)) inits.set(o.session_id, o);
        }
        const sid = known.has(o?.session_id) ? o.session_id : current ?? str(o?.session_id) ?? basename(sessionDir);
        const session = `cw:${sid}`;
        const ts = isoToUs(o?.timestamp) ?? isoToUs(o?._audit_timestamp);
        const d = decode(key, o);
        if (!d) {
          stats.unknown++;
          if (!undecoded.has(key)) {
            undecoded.add(key);
            sink.emit({ rec: 'expert', session, event: eventId(ctx.sourceId, info.line), severity: 'note', group: 'undecoded', message: `Unknown audit record type ${key}` });
          }
        }
        const { _audit_hmac, ...rest } = o && typeof o === 'object' ? o : { value: o };
        const ev: EventRec = {
          rec: 'event',
          id: eventId(ctx.sourceId, info.line),
          session,
          ts: ts ?? lastTs,
          tsSrc: ts !== undefined ? 'logged' : lastTs ? 'inherited' : 'none',
          // The session spans the transcript and this file, so seq follows the multi-file rule.
          seq: info.line * 1000,
          kind: d?.kind ?? 'raw.unknown',
          proto: `cowork-audit/${key}`,
          actor: d?.actor ?? 'harness',
          summary: d?.summary ?? key,
          attrs: d?.attrs ?? {},
          native: compact(rest),
          raw: { source: ctx.sourceId, line: info.line, offset: info.offset, length: info.length },
          flags: d?.flags,
          dur: d?.dur,
        };
        if (ts !== undefined) lastTs = ts;
        if (d?.expert) sink.emit({ rec: 'expert', session, event: ev.id, ...d.expert });
        if (key === 'system/permission_request' || key === 'system/permission_response') {
          pairPermission(ev, o, pending, spans, sink);
        }
        events.push(ev);
      },
      (info, err) => {
        stats.malformed++;
        sink.emit({ rec: 'expert', session: current ? `cw:${current}` : undefined, severity: 'warn', group: 'malformed', message: `line ${info.line}: ${err.message}` });
      },
    );
    stats.parsedBytes = read.parsedBytes;
    stats.sha256 = read.sha256;
    stats.lines = read.lines;

    for (const queue of pending.values()) {
      for (const req of queue) {
        spans.push(permissionSpan(req, undefined));
        sink.emit({ rec: 'expert', session: req.session, event: req.id, severity: 'note', group: 'unpaired', message: `Permission request for ${req.attrs.permission?.tool ?? 'a tool'} has no response` });
      }
    }

    // Emit a session only when no other source defines it: the transcript or the registry normally do.
    const projectsDir = join(sessionDir, '.claude', 'projects');
    for (const id of new Set(events.map((e) => e.session))) {
      const sid = id.slice(3);
      if (sid === regSid || (await findTranscript(projectsDir, sid))) continue;
      const init = inits.get(sid);
      const rec: SessionRec = {
        rec: 'session',
        id,
        agent: 'claude-cowork',
        nativeId: sid,
        role: 'main',
        state: 'missing-transcript',
        cwd: str(init?.cwd),
        models: str(init?.model) ? [init.model] : undefined,
        version: str(init?.claude_code_version),
        entrypoint: 'local-agent',
      };
      sink.emit(rec);
      sink.emit({ rec: 'expert', session: id, severity: 'warn', group: 'logging-gap', message: `No transcript found for session ${sid}; only its audit log remains` });
    }
    for (const ev of events) sink.emit(ev);
    for (const sp of spans) sink.emit(sp);
    return stats;
  },
};

/**
 * Permission records carry no tool_use id, so a response pairs with the oldest open request for the
 * same tool in the same session. The pairing is flagged `inferred` when several requests were open.
 */
function pairPermission(ev: EventRec, o: any, pending: Map<string, EventRec[]>, spans: SpanRec[], sink: RecordSink): void {
  const tool = str(o.tool_name) ?? '?';
  const key = `${ev.session}\0${tool}`;
  if (ev.kind === 'permission.request') {
    ev.span = spanId(ev.session, 'permission', str(o.uuid) ?? ev.raw.line);
    const queue = pending.get(key) ?? [];
    queue.push(ev);
    pending.set(key, queue);
    return;
  }
  const queue = pending.get(key);
  const req = queue?.shift();
  if (!req) {
    ev.flags = [...(ev.flags ?? []), 'orphan'];
    sink.emit({ rec: 'expert', session: ev.session, event: ev.id, severity: 'note', group: 'unpaired', message: `Permission response for ${tool} has no request` });
    return;
  }
  if (queue!.length > 0) ev.flags = [...(ev.flags ?? []), 'inferred'];
  ev.span = req.span;
  const span = permissionSpan(req, ev);
  if (span.dur !== undefined) req.dur = ev.dur = span.dur;
  spans.push(span);
}

function permissionSpan(req: EventRec, resp: EventRec | undefined): SpanRec {
  const granted = resp?.attrs.permission?.granted;
  const dur = resp && req.tsSrc === 'logged' && resp.tsSrc === 'logged' ? Math.max(0, resp.ts - req.ts) : undefined;
  return {
    rec: 'span',
    id: req.span!,
    session: req.session,
    kind: 'permission',
    name: req.attrs.permission?.tool ?? 'permission',
    start: req.ts,
    end: dur !== undefined ? req.ts + dur : undefined,
    dur,
    durSrc: dur !== undefined ? 'derived:ts-gap' : 'unknown',
    status: !resp ? 'open' : granted === false ? 'cancelled' : granted === true ? 'ok' : 'unknown',
    firstEvent: req.id,
    lastEvent: resp?.id,
    attrs: { permission: { tool: req.attrs.permission?.tool, decision: resp?.attrs.permission?.decision } },
  };
}

function decode(key: string, o: any): Decoded | undefined {
  switch (key) {
    case 'system/init': {
      const tools = Array.isArray(o.tools) ? o.tools.length : undefined;
      return {
        kind: 'session.meta',
        actor: 'harness',
        summary: words('init', o.model, str(o.claude_code_version) && `v${o.claude_code_version}`, o.permissionMode, tools !== undefined && `${tools} tools`),
        attrs: {
          llm: { model: str(o.model) },
          permission: { mode: str(o.permissionMode) },
          version: str(o.claude_code_version),
          cwd: str(o.cwd),
          tools,
          mcp_servers: Array.isArray(o.mcp_servers) ? o.mcp_servers.length : undefined,
        },
      };
    }
    case 'system/status':
      return { kind: 'harness.status', actor: 'harness', summary: `status ${o.status ?? 'cleared'}`, attrs: { status: o.status ?? null } };
    case 'system/thinking_tokens':
      // A streaming estimate, not a usage report: only the reasoning count is set so token sums stay exact.
      return {
        kind: 'llm.usage',
        actor: 'assistant',
        summary: `thinking ≈${o.estimated_tokens ?? '?'} tokens`,
        attrs: { tokens: { reasoning: num(o.estimated_tokens) }, llm: { estimated: true, reasoning_delta: num(o.estimated_tokens_delta) } },
      };
    case 'system/api_retry': {
      const status = num(o.error_status);
      const message = truncate(typeof o.error === 'string' ? o.error : o.error == null ? undefined : JSON.stringify(o.error), 1024);
      return {
        kind: 'llm.error',
        actor: 'harness',
        flags: ['error'],
        summary: words('API retry', `${o.attempt ?? '?'}/${o.max_retries ?? '?'}`, status !== undefined && `(status ${status})`, num(o.retry_delay_ms) !== undefined && `in ${fmtMs(o.retry_delay_ms)}`),
        attrs: { error: { status, message, retry_attempt: num(o.attempt), retry_in_ms: num(o.retry_delay_ms), max_retries: num(o.max_retries) } },
        expert: { severity: 'warn', group: 'retry', message: `API retry ${o.attempt ?? '?'}/${o.max_retries ?? '?'}${status !== undefined ? ` after status ${status}` : ''}` },
      };
    }
    case 'system/permission_request': {
      const name = str(o.tool_name) ?? '?';
      const inputSummary = summarizeToolInput(name, o.tool_input);
      return {
        kind: 'permission.request',
        actor: 'harness',
        summary: words('permission?', name, inputSummary),
        attrs: {
          permission: { tool: name },
          tool: { name, kind: toolKind(name), input: compact(o.tool_input, { maxString: INDEX_INPUT_MAX_STRING }), input_summary: inputSummary },
        },
      };
    }
    case 'system/permission_response': {
      const name = str(o.tool_name) ?? '?';
      const granted = typeof o.granted === 'boolean' ? o.granted : undefined;
      return {
        kind: 'permission.decision',
        actor: 'user',
        summary: words('permission', o.decision, granted === undefined ? undefined : granted ? '→ granted' : '→ denied', name),
        attrs: { permission: { tool: name, decision: str(o.decision), granted } },
        expert: granted === false ? { severity: 'warn', group: 'permission-denied', message: `Permission denied for ${name}` } : undefined,
      };
    }
    case 'system/compact_boundary': {
      const m = o.compact_metadata ?? {};
      return {
        kind: 'context.compaction',
        actor: 'harness',
        // The transcript records the same compaction (compact_boundary with compactMetadata).
        flags: ['dup'],
        dur: msToUs(m.duration_ms),
        summary: words('compaction', str(m.trigger) && `(${m.trigger})`, m.pre_tokens != null && `${m.pre_tokens} → ${m.post_tokens ?? '?'} tokens`, num(m.duration_ms) !== undefined && `(${fmtMs(m.duration_ms)})`),
        attrs: { context: { type: 'compaction', trigger: str(m.trigger), pre_tokens: num(m.pre_tokens), post_tokens: num(m.post_tokens), duration_ms: num(m.duration_ms) } },
      };
    }
    case 'system/commands_changed': {
      const n = Array.isArray(o.commands) ? o.commands.length : undefined;
      return { kind: 'harness.other', actor: 'harness', summary: words('commands changed', n !== undefined && `(${n})`), attrs: { commands: n } };
    }
    case 'tool_use_summary': {
      const text = str(o.summary);
      return {
        kind: 'harness.other',
        actor: 'harness',
        summary: words('tool summary:', oneLine(text, 140)),
        attrs: { text: truncate(text, INDEX_TEXT_MAX), text_len: text?.length, tool_use_ids: Array.isArray(o.preceding_tool_use_ids) ? o.preceding_tool_use_ids : undefined },
      };
    }
    case 'rate_limit_event':
      return rateLimit(o.rate_limit_info ?? {});
    case 'command_lifecycle':
      return { kind: 'harness.queue', actor: 'harness', summary: words('command', o.state), attrs: { command: { uuid: str(o.command_uuid), state: str(o.state) } } };
  }
  return key.startsWith('result') ? result(o) : undefined;
}

function result(o: any): Decoded {
  const usage = o.usage ?? {};
  const uncached = num(usage.input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const input = uncached === undefined ? undefined : uncached + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const models = o.modelUsage && typeof o.modelUsage === 'object' ? (o.modelUsage as Record<string, any>) : {};
  const byModel: Record<string, number> = {};
  for (const [model, u] of Object.entries(models)) if (num(u?.costUSD) !== undefined) byModel[model] = u.costUSD;
  const cost = num(o.total_cost_usd);
  const isError = o.is_error === true || (str(o.subtype) ?? 'success') !== 'success';
  const denials = Array.isArray(o.permission_denials) ? o.permission_denials.length : 0;
  return {
    kind: 'turn.end',
    actor: 'harness',
    flags: isError ? ['error'] : undefined,
    dur: msToUs(o.duration_ms),
    summary: words(
      'result',
      o.subtype,
      num(o.duration_ms) !== undefined && fmtMs(o.duration_ms),
      num(o.duration_api_ms) !== undefined && `· api ${fmtMs(o.duration_api_ms)}`,
      num(o.ttft_ms) !== undefined && `· ttft ${fmtMs(o.ttft_ms)}`,
      cost !== undefined && `· $${cost.toFixed(4)}`,
    ),
    attrs: {
      text_len: typeof o.result === 'string' ? o.result.length : undefined,
      turn: { duration_ms: num(o.duration_ms), num_turns: num(o.num_turns), prompt_uuid: str(o.user_message_uuid) },
      llm: {
        api_ms: num(o.duration_api_ms),
        ttft_ms: num(o.ttft_ms),
        ttft_stream_ms: num(o.ttft_stream_ms),
        time_to_request_ms: num(o.time_to_request_ms),
        stop_reason: str(o.stop_reason),
        terminal_reason: str(o.terminal_reason),
        models: Object.keys(models),
      },
      tokens: { input, uncached, cache_read: cacheRead, cache_write: cacheWrite, output: num(usage.output_tokens) },
      cost: { usd: cost, by_model: Object.keys(byModel).length ? byModel : undefined },
      permission: denials ? { denials } : undefined,
      error: isError ? { status: num(o.api_error_status), type: str(o.subtype) } : undefined,
    },
    expert: isError ? { severity: 'error', group: 'api-error', message: turnErrorMessage(o) } : undefined,
  };
}

function rateLimit(r: any): Decoded {
  const status = str(r.status);
  const type = str(r.rateLimitType);
  const used = num(r.utilization) !== undefined ? Math.round(r.utilization * 1000) / 10 : undefined;
  const severity: ExpertSeverity | undefined = status === 'rejected' || status === 'allowed_warning' ? 'warn' : undefined;
  return {
    kind: 'harness.ratelimit',
    actor: 'harness',
    flags: status === 'rejected' ? ['error'] : undefined,
    summary: words('rate limit', type, status, used !== undefined && `${used}%`),
    attrs: {
      ratelimit: {
        used_percent: used,
        window_minutes: type ? RATE_WINDOW_MINUTES[type] : undefined,
        // resetsAt is epoch seconds; AgentShark times are µs.
        resets_at: num(r.resetsAt) !== undefined ? r.resetsAt * 1_000_000 : undefined,
        status,
        type,
        overage: typeof r.isUsingOverage === 'boolean' ? r.isUsingOverage : undefined,
      },
    },
    expert: severity ? { severity, group: 'rate-limit', message: `Rate limit ${type ?? ''} ${status}${used !== undefined ? ` at ${used}%` : ''}`.replace(/\s+/g, ' ') } : undefined,
  };
}

/**
 * A failed turn's cause. A turn can end with is_error while its subtype stays 'success' and terminal_reason
 * 'completed'; neither names the error, so the final result text (the API error message) does.
 */
function turnErrorMessage(o: any): string {
  const subtype = str(o.subtype);
  const reason = str(o.terminal_reason);
  const cause = num(o.api_error_status) ?? (subtype && subtype !== 'success' ? subtype : reason && reason !== 'completed' ? reason : undefined);
  const text = typeof o.result === 'string' ? oneLine(o.result, 160) : undefined;
  return `Turn ended with an error${cause !== undefined ? ` (${cause})` : ''}${text ? `: ${text}` : ''}`;
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
