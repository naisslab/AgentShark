// DeepSeek Harness (`DeepSeek Harness.app` and `dsh` CLI):
// `<dshRoot>/sessions/<workspace-slug>/<session-dir>/session.v4.jsonl.zstd` (and `.jsonl` / older `v0..vN` files).
// DeepSeek Harness appends one Zstandard frame per flush; `readJsonl` streams all frames via `openSource()` and
// fingerprints the exact decompressed bytes so raw-pane byte highlights and capture verification work natively.

import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Attrs, EventFlag, EventKind, EventRec, SpanRec, SpanStatus, TokenUsage } from '../model/types.ts';
import {
  type Adapter, type DiscoverEnv, type LineInfo, type ParseStats, type SourceFile,
  INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, INTERRUPT_NOTE, agentRoots, compact, editChanges, emptyStats, eventId,
  fileInfo, msToUs, oneLine, outputTail, readJsonl, spanId, summarizeToolInput, toolKind, truncate, tryJson,
} from './adapter.ts';

const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd|\.zst)?$/;

/** Pick the highest format generation in a session directory (`session.v4.jsonl.zstd` > `session.v3...` > `session.jsonl.zstd`). */
function pickCanonicalSessionFile(names: string[]): string | undefined {
  let bestName: string | undefined;
  let bestGen = -1;
  let bestPlain = false;
  for (const name of names) {
    const m = SESSION_FILE_RE.exec(name);
    if (!m) continue;
    const gen = m[1] !== undefined ? Number(m[1]) : 0;
    const plain = !m[2]; // If both uncompressed and zstd exist at the same generation, prefer plain `.jsonl`.
    if (gen > bestGen || (gen === bestGen && plain && !bestPlain)) {
      bestGen = gen;
      bestPlain = plain;
      bestName = name;
    }
  }
  return bestName;
}

interface WorkspaceMeta {
  bySessionId: Map<string, { workspaceTitle?: string; workspacePath?: string }>;
}

const workspaceCache = new Map<string, Promise<WorkspaceMeta>>();

function readWorkspaceMeta(dshRoot: string, runAt?: number): Promise<WorkspaceMeta> {
  const cacheKey = `${runAt ?? 0}:${dshRoot}`;
  let cached = workspaceCache.get(cacheKey);
  if (!cached) {
    if (workspaceCache.size > 32) workspaceCache.clear();
    cached = (async (): Promise<WorkspaceMeta> => {
      const bySessionId = new Map<string, { workspaceTitle?: string; workspacePath?: string }>();
      const raw = await readFile(join(dshRoot, 'storages', 'workspace.json'), 'utf8').catch(() => '');
      const doc = tryJson(raw) as Record<string, any> | undefined;
      const workspaces = doc?.tables?.workspaces;
      if (workspaces && typeof workspaces === 'object') {
        const list = Array.isArray(workspaces) ? workspaces : Object.values(workspaces);
        for (const ws of list) {
          if (!ws || typeof ws !== 'object') continue;
          const wsPath = str(ws.path);
          const wsTitle = str(ws.title);
          const ids: unknown[] = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
          for (const id of ids) {
            if (typeof id === 'string' && id) bySessionId.set(id, { workspaceTitle: wsTitle, workspacePath: wsPath });
          }
        }
      }
      return { bySessionId };
    })();
    workspaceCache.set(cacheKey, cached);
  }
  return cached;
}

function findDshRoot(filePath: string): string | undefined {
  // <dshRoot>/sessions/<workspace>/<session>/session.v4.jsonl.zstd
  const sessionDir = dirname(filePath);
  const wsDir = dirname(sessionDir);
  const sessionsDir = dirname(wsDir);
  return basename(sessionsDir) === 'sessions' ? dirname(sessionsDir) : undefined;
}

export const deepseekAdapter: Adapter = {
  name: 'deepseek',

  async discover(env: DiscoverEnv) {
    if (env.agents && !env.agents.includes('deepseek')) return [];
    const out: SourceFile[] = [];
    const seen = new Set<string>();
    const addSessionDir = async (sesPath: string) => {
      const files = await readdir(sesPath).catch(() => [] as string[]);
      const chosen = pickCanonicalSessionFile(files);
      if (!chosen) return;
      const full = join(sesPath, chosen);
      if (seen.has(full)) return;
      const info = await fileInfo(full, 'deepseek', 'dsh-session', 'deepseek');
      if (info) {
        seen.add(full);
        out.push(info);
      }
    };

    for (const root of agentRoots(env, 'deepseek')) {
      await addSessionDir(root);
      const sessionsRoot = basename(root) === 'sessions' ? root : join(root, 'sessions');
      const workspaces = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
      if (workspaces.length > 0) {
        for (const ws of workspaces) {
          if (!ws.isDirectory()) continue;
          const wsPath = join(sessionsRoot, ws.name);
          const sessionDirs = await readdir(wsPath, { withFileTypes: true }).catch(() => []);
          for (const ses of sessionDirs) {
            if (ses.isDirectory()) await addSessionDir(join(wsPath, ses.name));
          }
        }
      } else {
        // Support pointing a custom deepseekRoot directly at a single workspace folder.
        for (const child of await readdir(root, { withFileTypes: true }).catch(() => [])) {
          if (child.isDirectory()) await addSessionDir(join(root, child.name));
        }
      }
    }
    return out;
  },

  async parse(ctx, sink) {
    const { path } = ctx.file;
    const stats: ParseStats = { ...emptyStats(), dialect: 'dsh-session' };

    interface RawLine {
      rec: Record<string, any>;
      info: LineInfo;
    }
    const rawLines: RawLine[] = [];
    let malformedLines: { line: number; msg: string }[] = [];

    const readRes = await readJsonl(
      path,
      (obj, info) => {
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) rawLines.push({ rec: obj, info });
        else {
          stats.malformed++;
          malformedLines.push({ line: info.line, msg: 'expected JSON object' });
        }
      },
      (info, err) => {
        stats.malformed++;
        malformedLines.push({ line: info.line, msg: err.message });
      },
    );

    stats.parsedBytes = readRes.parsedBytes;
    stats.lines = readRes.lines;
    stats.sha256 = readRes.sha256;

    if (!rawLines.length) {
      for (const m of malformedLines) sink.emit({ rec: 'expert', severity: 'warn', group: 'malformed', message: `line ${m.line}: ${m.msg}` });
      if (!stats.malformed) stats.skipped = 1;
      return stats;
    }

    const rawHeader = rawLines[0].rec.type === 'session' ? rawLines[0].rec : undefined;
    const header = rawHeader?.header && typeof rawHeader.header === 'object' ? { ...rawHeader, ...rawHeader.header } : rawHeader;
    const version = num(header?.version ?? header?.v);
    if (version !== undefined) stats.dialect = `dsh v${version}`;

    const folderId = basename(dirname(path)).replace(/^session-/, '');
    const nativeId = str(header?.id) ?? folderId;
    const session = `ds:${nativeId}`;

    for (const m of malformedLines) {
      sink.emit({ rec: 'expert', session, severity: 'warn', group: 'malformed', message: `line ${m.line}: ${m.msg}` });
    }

    // Seeded subagent sessions copy parent history up to the final `session/end-seed` marker.
    const isSeeded = header?.isSeeded === true;
    let lastSeedLine = -1;
    if (isSeeded) {
      for (const { rec, info } of rawLines) {
        if (rec.type === 'session/end-seed') lastSeedLine = info.line;
      }
    }

    const parentNative = str(header?.parentSession);
    const isSubagent = header?.origin === 'subagent' || Boolean(parentNative) || (num(header?.delegationDepth) ?? 0) > 0;
    const role = isSubagent ? 'subagent' : 'main';
    let cwd = str(header?.cwd);
    const createdTs = msToUs(header?.createdAt);

    let title: string | undefined;
    let titleIsFallback = true;
    let subagentLabel: string | undefined;
    let firstPrompt: string | undefined;
    let contextWindow: number | undefined;
    let reasoningEffort: string | undefined;
    let activeModel: string | undefined;

    const models = new Set<string>();
    const events: EventRec[] = [];
    const spans: SpanRec[] = [];
    const undecoded = new Set<string>();

    // Open turns, steps, tool calls, jobs, and approvals.
    const openTurns = new Map<number, SpanRec>();
    let currentTurn: SpanRec | undefined;
    const stepStartUs = new Map<string, number>();
    const openTools = new Map<string, {
      callId: string;
      name: string;
      kind: ReturnType<typeof toolKind>;
      command?: string;
      callEv: EventRec;
      turnId?: string;
      inherited: boolean;
      linkSession?: string;
    }>();
    const settledJobs = new Map<string, {
      jobId: string;
      exitCode?: number;
      wallMs?: number;
      status?: string;
      detail?: string;
    }>();
    const pendingSubagentTools: string[] = [];
    const openApprovals = new Map<string, { askEv: EventRec; toolName?: string; callId?: string; turnId?: string; inherited: boolean }>();

    let lastTs = createdTs ?? 0;

    for (const { rec, info } of rawLines) {
      const type = str(rec.type) ?? 'unknown';
      const data = rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, any>) : rec;
      const at = msToUs(rec.time ?? rec.createdAt);
      if (at !== undefined) lastTs = Math.max(lastTs, at);
      const inherited = isSeeded && info.line <= lastSeedLine;
      if (inherited && type !== 'session' && type !== 'session/end-seed') stats.inherited++;

      let block = 0;
      const emit = (
        kind: EventKind,
        actor: EventRec['actor'],
        summaryText: string,
        attrs: Attrs,
        tsOverride = at,
        extraFlags?: EventFlag[],
        turnOverride?: SpanRec,
      ): EventRec => {
        const ts = tsOverride ?? lastTs;
        const activeTurn = turnOverride ?? currentTurn;
        const flags: EventFlag[] = [
          ...(inherited ? (['inherited'] as EventFlag[]) : []),
          ...(extraFlags ?? []),
        ];
        const ev: EventRec = {
          rec: 'event',
          id: eventId(ctx.sourceId, info.line, block === 0 ? undefined : block),
          session,
          ts,
          tsSrc: tsOverride !== undefined ? 'logged' : lastTs ? 'inherited' : 'none',
          seq: events.length,
          kind,
          proto: `dsh/${type}`,
          actor,
          summary: summaryText,
          span: activeTurn?.id,
          turn: activeTurn?.id,
          attrs,
          native: block === 0 ? compact(rec) : undefined,
          raw: { source: ctx.sourceId, line: info.line, offset: info.offset, length: info.length, ...(block > 0 ? { block } : {}) },
          ...(flags.length ? { flags } : {}),
        };
        block++;
        if (activeTurn) {
          activeTurn.end = Math.max(activeTurn.end ?? activeTurn.start, ev.ts);
          activeTurn.lastEvent = ev.id;
          if (!activeTurn.firstEvent) activeTurn.firstEvent = ev.id;
        }
        events.push(ev);
        return ev;
      };

      switch (type) {
        case 'session': {
          emit('session.meta', 'harness', words('session', version !== undefined ? `v${version}` : undefined, str(header?.agentPreset), cwd), {
            cwd,
            version: version !== undefined ? String(version) : undefined,
            deepseek: cleanObj({ preset: str(header?.agentPreset), origin: str(header?.origin), delegationDepth: num(header?.delegationDepth), isSeeded: header?.isSeeded === true || undefined }),
          }, createdTs ?? at, ['meta']);
          break;
        }

        case 'subagent/descriptor': {
          const label = str(data.label);
          const model = str(data.agentModel);
          const effort = str(data.agentReasoningEffort);
          if (label) subagentLabel = label;
          if (model) { activeModel = model; models.add(model); }
          if (effort) reasoningEffort = effort;
          emit('session.meta', 'harness', words('subagent', str(data.mode), label, model), {
            llm: cleanObj({ model, effort }),
            deepseek: cleanObj({ mode: str(data.mode), provider: str(data.agentProvider ?? data.provider), label }),
          }, at, ['meta']);
          break;
        }

        case 'session/title': {
          const t = str(data.title);
          const isFallback = data.source?.kind === 'fallback';
          if (t && (!title || titleIsFallback || !isFallback)) {
            title = t;
            titleIsFallback = isFallback;
          }
          emit('session.state', 'harness', words('title', t && oneLine(t, 100)), { text: t ? truncate(t, INDEX_TEXT_MAX) : undefined }, at, ['meta']);
          break;
        }

        case 'session/end-seed': {
          emit('context.snapshot', 'harness', 'end inherited seed context', { context: { type: 'seed-boundary' } }, at, ['meta']);
          break;
        }

        case 'sandbox/mode':
        case 'approval/policy':
        case 'permission/preset':
        case 'agent-preset/selected':
        case 'model/selection': {
          if (type === 'model/selection') {
            const m = str(data.model);
            if (m) { activeModel = m; models.add(m); }
            if (str(data.reasoningEffort)) reasoningEffort = str(data.reasoningEffort);
          }
          const val = str(data.mode ?? data.policy ?? data.preset ?? data.agentPreset ?? data.model);
          emit('session.state', 'harness', words(type, val), {
            llm: type === 'model/selection' ? cleanObj({ model: str(data.model), effort: str(data.reasoningEffort) }) : undefined,
            permission: type === 'approval/policy' || type === 'permission/preset' ? cleanObj({ mode: val }) : undefined,
          }, at, ['meta']);
          break;
        }

        case 'turn/start': {
          const turnNo = num(data.turn) ?? openTurns.size + 1;
          const spId = spanId(session, 'turn', `${turnNo}-${info.line}`);
          const turnSpan: SpanRec = {
            rec: 'span',
            id: spId,
            session,
            kind: 'turn',
            name: `Turn ${turnNo}`,
            start: at ?? lastTs,
            durSrc: 'logged:turn/end',
            status: 'open',
            attrs: { ...(inherited ? { inherited: true } : {}), turn: { index: turnNo } },
          };
          openTurns.set(turnNo, turnSpan);
          currentTurn = turnSpan;
          spans.push(turnSpan);
          const ev = emit('turn.start', 'harness', `turn ${turnNo}`, { turn: { index: turnNo } }, at, undefined, turnSpan);
          turnSpan.firstEvent = ev.id;
          break;
        }

        case 'turn/end': {
          const turnNo = num(data.turn);
          const turnSpan = (turnNo !== undefined ? openTurns.get(turnNo) : undefined) ?? currentTurn;
          const reasonKind = str(data.reason?.kind) ?? 'completed';
          const aborted = reasonKind === 'aborted' || reasonKind === 'interrupted' || reasonKind === 'cancelled' || reasonKind === 'canceled';
          const errored = reasonKind === 'error' || reasonKind === 'failed';
          if (aborted) {
            const ev = emit('turn.abort', 'user', `turn ${turnNo ?? ''} ${reasonKind}`.trim(), {
              deepseek: compact({ reason: data.reason }),
            }, at, undefined, turnSpan);
            if (!inherited) {
              sink.emit({
                rec: 'expert', session, event: ev.id, span: turnSpan?.id, severity: 'note', group: 'interrupted',
                message: role === 'main' ? INTERRUPT_NOTE.main : INTERRUPT_NOTE.child,
              });
            }
          } else {
            emit('turn.end', 'harness', `turn ${turnNo ?? ''} ${reasonKind}`.trim(), {
              deepseek: compact({ reason: data.reason }),
            }, at, errored ? ['error'] : undefined, turnSpan);
          }
          if (turnSpan) {
            const endTs = at ?? lastTs;
            turnSpan.end = Math.max(turnSpan.start, endTs);
            turnSpan.dur = turnSpan.end - turnSpan.start;
            turnSpan.durSrc = 'logged:turn/end';
            turnSpan.status = aborted ? 'interrupted' : errored ? 'error' : 'ok';
            if (turnNo !== undefined) openTurns.delete(turnNo);
            if (currentTurn === turnSpan) currentTurn = undefined;
          }
          break;
        }

        case 'step/start': {
          const key = `${data.turn ?? '?'}:${data.step ?? '?'}`;
          if (at !== undefined) stepStartUs.set(key, at);
          break;
        }

        case 'step/end': {
          // Step boundaries are folded into the step's llm span timing.
          break;
        }

        case 'request/context': {
          const cw = num(data.contextWindow);
          if (cw !== undefined && cw > 0) contextWindow = cw;
          const m = str(data.model);
          if (m) { activeModel = m; models.add(m); }
          break;
        }

        case 'request/header': {
          const cfg = data.header?.config;
          const m = str(cfg?.model);
          if (m) { activeModel = m; models.add(m); }
          if (str(cfg?.reasoningEffort)) reasoningEffort = str(cfg?.reasoningEffort);
          const toolsCount = Array.isArray(data.header?.tools) ? data.header.tools.length : undefined;
          const sysLen = typeof data.header?.system === 'string' ? data.header.system.length : undefined;
          emit('context.snapshot', 'harness', words('request header', m, toolsCount !== undefined ? `${toolsCount} tools` : undefined), {
            llm: cleanObj({ model: m, effort: str(cfg?.reasoningEffort) }),
            context: cleanObj({ system_len: sysLen, tools_count: toolsCount, context_window: contextWindow }),
          }, at, ['meta']);
          break;
        }

        case 'system/message':
        case 'developer/message': {
          const text = extractDshContent(data.message?.content ?? data.content);
          emit('context.attachment', 'system', words(type === 'system/message' ? 'system' : 'developer', oneLine(text, 100)), {
            text: truncate(text, INDEX_TEXT_MAX), text_len: text.length,
            context: { type: type === 'system/message' ? 'system' : 'developer' },
          }, at, ['meta']);
          break;
        }

        case 'agent/inbox/spliced': {
          const count = Array.isArray(data.inserted) ? data.inserted.length : undefined;
          emit('harness.queue', 'harness', words('inbox spliced', count !== undefined ? `${count} item(s)` : undefined), {
            deepseek: compact({ target: str(data.target), count }),
          }, at, ['meta']);
          break;
        }

        case 'user/message': {
          const text = extractDshContent(data.content ?? data.message?.content);
          const srcKind = str(data.source?.kind) ?? 'user';
          const isHuman = srcKind === 'user';
          if (isHuman && !inherited && !firstPrompt && text) firstPrompt = oneLine(text, 120);
          if (isHuman && currentTurn && currentTurn.name.startsWith('Turn ') && text) {
            currentTurn.name = oneLine(text, 80);
          }
          emit(isHuman ? 'user.prompt' : 'user.inject', isHuman ? 'user' : 'agent', oneLine(text), {
            text: truncate(text, INDEX_TEXT_MAX), text_len: text.length,
            deepseek: srcKind !== 'user' ? { source: data.source } : undefined,
          });
          break;
        }

        case 'assistant/message': {
          const msg = data.message && typeof data.message === 'object' ? data.message : {};
          const model = str(msg.source?.model) ?? activeModel;
          if (model) models.add(model);
          const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
          const reasoning = blocks.filter((b) => b?.type === 'reasoning' || b?.type === 'thinking').map((b) => str(b.text) ?? '').filter(Boolean).join('\n');
          const text = blocks.filter((b) => b?.type === 'text' || (!b?.type && typeof b?.text === 'string')).map((b) => str(b.text) ?? '').filter(Boolean).join('\n');

          const stepKey = `${data.turn ?? '?'}:${data.step ?? '?'}`;
          const stepStart = stepStartUs.get(stepKey);
          const stream: any[] = Array.isArray(data.stream) ? data.stream : [];
          const firstStreamUs = stream.length ? msToUs(stream[0]?.time0 ?? stream[0]?.time) : undefined;
          const finishItem = stream.findLast((s) => s?.chunk?.type === 'finish' || s?.type === 'finish');
          const lastStreamUs = stream.length ? msToUs(stream.at(-1)?.timeLast ?? stream.at(-1)?.time) : undefined;
          const endUs = lastStreamUs ?? at;
          const startUs = stepStart ?? firstStreamUs ?? endUs ?? lastTs;
          const dur = stepStart !== undefined && endUs !== undefined && endUs >= stepStart ? endUs - stepStart
            : (firstStreamUs !== undefined && endUs !== undefined && endUs > firstStreamUs ? endUs - firstStreamUs : undefined);
          const firstTokenUs = firstContentTimeUs(stream);
          const ttftUs = stepStart !== undefined && firstTokenUs !== undefined && firstTokenUs >= stepStart ? firstTokenUs - stepStart : undefined;
          const stopReason = str(finishItem?.chunk?.reason ?? finishItem?.reason);

          const rawUsage = data.usage ?? finishItem?.chunk?.usage ?? msg.usage;
          const tokens = dshTokens(rawUsage, contextWindow);

          const llmMeta = cleanObj({
            model,
            message_id: str(msg.id),
            stop_reason: stopReason,
            stop_reason_src: stopReason ? ('logged' as const) : undefined,
            effort: reasoningEffort,
            ttft_ms: ttftUs !== undefined ? ttftUs / 1000 : undefined,
            latency_ms: dur !== undefined ? dur / 1000 : undefined,
          });

          const thinkEv = reasoning
            ? emit('llm.thinking', 'assistant', oneLine(reasoning), { text: truncate(reasoning, INDEX_TEXT_MAX), text_len: reasoning.length }, firstStreamUs ?? endUs)
            : undefined;
          const textEv = emit('llm.text', 'assistant', text ? oneLine(text) : stopReason === 'tool-calls' || stopReason === 'tool_calls' ? '→ tool calls' : oneLine(reasoning || '(assistant)', 120), {
            text: truncate(text, INDEX_TEXT_MAX),
            text_len: text.length,
            llm: llmMeta,
            tokens,
          }, endUs);

          const llmSpanId = spanId(session, 'llm', str(msg.id) ?? `${data.turn ?? 0}-${data.step ?? 0}-${info.line}`);
          spans.push({
            rec: 'span',
            id: llmSpanId,
            session,
            kind: 'llm',
            name: model ?? 'deepseek',
            parent: currentTurn?.id,
            start: startUs,
            end: dur !== undefined ? startUs + dur : undefined,
            dur,
            durSrc: stepStart !== undefined && dur !== undefined ? 'logged:step/start..stream' : dur !== undefined ? 'logged:stream' : 'unknown',
            status: 'ok',
            firstEvent: (thinkEv ?? textEv).id,
            lastEvent: textEv.id,
            attrs: { ...(inherited ? { inherited: true } : {}), llm: llmMeta, tokens },
          });
          for (const e of thinkEv ? [thinkEv, textEv] : [textEv]) e.span = llmSpanId;
          textEv.dur = dur;
          break;
        }

        case 'assistant/attempt': {
          const stream: any[] = Array.isArray(data.stream) ? data.stream : [];
          const errItem = stream.findLast((s) => s?.type === 'error' || s?.chunk?.type === 'error');
          const errMsg = str(errItem?.error?.message ?? errItem?.chunk?.error ?? data.error) ?? 'aborted or retried stream attempt';
          const ev = emit('llm.error', 'assistant', words('stream attempt', oneLine(errMsg, 120)), {
            error: { message: truncate(errMsg, 1024) },
          }, at, ['abandoned']);
          if (!inherited && errItem) {
            sink.emit({ rec: 'expert', session, event: ev.id, severity: 'warn', group: 'retry', message: `DeepSeek stream attempt failed: ${oneLine(errMsg, 200)}` });
          }
          break;
        }

        case 'tool/call': {
          const name = str(data.name) ?? 'tool';
          const callId = str(data.callId) ?? `call-${info.line}`;
          const parsedArgs = typeof data.arguments === 'string' ? (tryJson(data.arguments) ?? data.arguments) : (data.arguments ?? {});
          const kind = toolKind(name);
          const inputSummary = summarizeToolInput(name, parsedArgs);
          const command = kind === 'shell' && parsedArgs && typeof parsedArgs === 'object' ? str((parsedArgs as any).command) : undefined;
          const cwdArg = parsedArgs && typeof parsedArgs === 'object' ? str((parsedArgs as any).workdir ?? (parsedArgs as any).cwd) : undefined;
          const changes = editChanges(name, parsedArgs);
          const callEv = emit('tool.call', 'assistant', `${name}  ${inputSummary}`, {
            tool: cleanObj({
              name, call_id: callId, kind, command, cwd: cwdArg,
              input: compact(parsedArgs, { maxString: INDEX_INPUT_MAX_STRING }),
              input_summary: inputSummary,
            }),
            ...(changes.length ? { change: { files: changes } } : {}),
          });
          openTools.set(callId, { callId, name, kind, command, callEv, turnId: currentTurn?.id, inherited });
          if (name === 'subagent' || name === 'subagent_fork' || name === 'spawn_teammate') {
            pendingSubagentTools.push(callId);
          }
          break;
        }

        case 'job/registered': {
          const callId = str(data.toolCall?.callId);
          const jobId = str(data.jobId);
          if (callId && jobId) {
            const pending = openTools.get(callId);
            if (pending?.callEv.attrs.tool) pending.callEv.attrs.tool.proc_id = jobId;
          }
          break;
        }

        case 'job/settled': {
          const callId = str(data.toolCall?.callId);
          const jobId = str(data.jobId) ?? '';
          const detail = str(data.detail);
          const exitMatch = detail ? /^exit code:\s*(-?\d+)/i.exec(detail) : null;
          const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
          const startedMs = num(data.startedAt);
          const finishedMs = num(data.finishedAt);
          const wallMs = startedMs !== undefined && finishedMs !== undefined && finishedMs >= startedMs ? finishedMs - startedMs : undefined;
          if (callId) {
            settledJobs.set(callId, { jobId, exitCode, wallMs, status: str(data.status), detail });
          }
          break;
        }

        case 'tool/result': {
          const msg = data.message && typeof data.message === 'object' ? data.message : {};
          const callId = str(msg.toolCallId ?? msg.source?.callId) ?? `result-${info.line}`;
          const pending = openTools.get(callId);
          if (pending) openTools.delete(callId);
          const job = settledJobs.get(callId);
          const name = pending?.name ?? 'tool';
          const kind = pending?.kind ?? 'other';
          const output = extractDshContent(msg.content);
          const exitCode = job?.exitCode;
          const isError = msg.isError === true || (exitCode !== undefined && exitCode !== 0);
          const resultCwd = str(data.meta?.cwd);

          // Check if subagent result text names a spawned child session ID.
          let linkSession = pending?.linkSession;
          if (!linkSession && (name === 'subagent' || name === 'subagent_fork' || name === 'spawn_teammate')) {
            const m = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(output);
            if (m) linkSession = `ds:${m[1]}`;
          }
          if (linkSession && pending) {
            pending.callEv.attrs.agent = { ...(pending.callEv.attrs.agent ?? {}), link_session: linkSession };
          }

          const resEv = emit('tool.result', 'tool', `${name}  ${words(isError ? 'error →' : '→', oneLine(output, 120))}`, {
            tool: cleanObj({
              name,
              call_id: callId,
              kind,
              output: truncate(output, INDEX_TEXT_MAX),
              output_len: output.length,
              output_tail: outputTail(output),
              exit_code: exitCode,
              is_error: isError,
              reported_wall_ms: job?.wallMs,
              proc_id: job?.jobId || undefined,
              cwd: resultCwd,
            }),
          }, at, [
            ...(isError ? (['error'] as EventFlag[]) : []),
            ...(!pending ? (['orphan'] as EventFlag[]) : []),
          ]);

          const spId = spanId(session, 'tool', callId);
          const startTs = pending?.callEv.ts ?? resEv.ts;
          const loggedDur = job?.wallMs !== undefined ? Math.round(job.wallMs * 1000) : undefined;
          const gapDur = pending && resEv.ts >= pending.callEv.ts ? resEv.ts - pending.callEv.ts : undefined;
          const dur = loggedDur ?? gapDur;
          const durSrc = loggedDur !== undefined ? 'logged:job/settled' : gapDur !== undefined ? 'logged:tool/result' : 'unknown';
          const spanStatus: SpanStatus = job?.status === 'killed' ? 'cancelled' : isError ? 'error' : 'ok';

          spans.push({
            rec: 'span',
            id: spId,
            session,
            kind: 'tool',
            name,
            parent: pending?.turnId ?? currentTurn?.id,
            start: startTs,
            end: dur !== undefined ? startTs + dur : resEv.ts,
            dur,
            durSrc,
            status: spanStatus,
            linkSession,
            firstEvent: pending?.callEv.id ?? resEv.id,
            lastEvent: resEv.id,
            attrs: { ...(inherited ? { inherited: true } : {}), tool: { name, kind } },
          });
          if (pending) pending.callEv.span = spId;
          resEv.span = spId;
          resEv.dur = dur;
          break;
        }

        case 'approval/asked': {
          const id = str(data.id) ?? `approval-${info.line}`;
          const toolName = str(data.toolName);
          const callId = str(data.callId);
          const reason = str(data.reason);
          const askEv = emit('permission.request', 'harness', words('permission?', toolName, reason && oneLine(reason, 100)), {
            permission: cleanObj({ tool: toolName }),
            tool: cleanObj({ name: toolName, call_id: callId }),
            text: reason ? truncate(reason, INDEX_TEXT_MAX) : undefined,
          });
          openApprovals.set(id, { askEv, toolName, callId, turnId: currentTurn?.id, inherited });
          break;
        }

        case 'approval/decided': {
          const id = str(data.id) ?? '';
          const outcome = str(data.outcome) ?? 'unknown';
          const granted = outcome.startsWith('allow');
          const pending = openApprovals.get(id);
          if (pending) openApprovals.delete(id);
          const decEv = emit('permission.decision', 'user', words('permission', outcome, pending?.toolName), {
            permission: cleanObj({ tool: pending?.toolName, decision: outcome, granted }),
            tool: cleanObj({ name: pending?.toolName, call_id: pending?.callId }),
          });
          if (pending) {
            const spId = spanId(session, 'permission', id);
            const dur = decEv.ts >= pending.askEv.ts ? decEv.ts - pending.askEv.ts : undefined;
            spans.push({
              rec: 'span', id: spId, session, kind: 'permission', name: pending.toolName ?? 'approval',
              parent: pending.turnId, start: pending.askEv.ts, end: decEv.ts, dur,
              durSrc: dur !== undefined ? 'logged:approval/decided' : 'unknown',
              status: granted ? 'ok' : 'cancelled',
              firstEvent: pending.askEv.id, lastEvent: decEv.id,
              attrs: { ...(pending.inherited ? { inherited: true } : {}), permission: { decision: outcome, granted } },
            });
            pending.askEv.span = spId;
            decEv.span = spId;
            decEv.dur = dur;
          }
          break;
        }

        case 'subagent/catalog': {
          const childId = str(data.childId);
          const label = str(data.label);
          const mode = str(data.mode);
          const link = childId ? `ds:${childId}` : undefined;
          // Pair with the most recent subagent tool call in this session if one is waiting.
          while (pendingSubagentTools.length) {
            const cid = pendingSubagentTools.shift()!;
            const pending = openTools.get(cid);
            if (pending && link) {
              pending.linkSession = link;
              pending.callEv.attrs.agent = { id: childId, type: mode, description: label, link_session: link };
              break;
            }
          }
          emit('agent.spawn', 'harness', words('subagent', mode, label, childId?.slice(0, 8)), {
            agent: cleanObj({ id: childId, type: mode, description: label, link_session: link }),
          });
          break;
        }

        case 'team/member': {
          const member = data.member && typeof data.member === 'object' ? data.member : {};
          const childId = str(member.id ?? member.sessionId);
          const link = childId ? `ds:${childId}` : undefined;
          emit('agent.status', 'agent', words('teammate', str(member.name), str(member.phase), str(member.description)), {
            agent: cleanObj({ id: childId, type: str(member.name), status: str(member.phase), description: str(member.description), link_session: link }),
          });
          break;
        }

        case 'command/run': {
          emit('harness.status', 'user', words(`/${str(data.name) ?? 'command'}`, str(data.args)), {
            deepseek: compact({ commandId: str(data.commandId), name: str(data.name), args: data.args }),
          });
          break;
        }

        case 'command/done': {
          const text = str(data.text);
          emit('harness.status', 'harness', words('command', str(data.kind), text && oneLine(text, 100)), {
            text: text ? truncate(text, INDEX_TEXT_MAX) : undefined,
            deepseek: compact({ commandId: str(data.commandId), kind: str(data.kind) }),
          });
          break;
        }

        case 'todo/write': {
          const count = Array.isArray(data.todos) ? data.todos.length : undefined;
          emit('harness.status', 'assistant', words('todo list', count !== undefined ? `${count} item(s)` : undefined), {
            deepseek: compact({ count }),
          });
          break;
        }

        case 'deliverables/presented':
        case 'workspace/changes': {
          const files = Array.isArray(data.files) ? data.files : undefined;
          emit('harness.file', 'harness', words(type, files ? `${files.length} file(s)` : undefined), {
            deepseek: compact({ turn: data.turn, files: files?.slice(0, 20) }),
          });
          break;
        }

        case 'web/deepseek-search-llm-request':
        case 'session/title-llm-request':
        case 'session-log-deepseek/delivery-accepted': {
          emit('harness.other', 'harness', type, {}, at, ['meta']);
          break;
        }

        default: {
          stats.unknown++;
          const ev = emit('raw.unknown', 'harness', `record ${type}`, {});
          if (!undecoded.has(type)) {
            undecoded.add(type);
            sink.emit({ rec: 'expert', session, event: ev.id, severity: 'note', group: 'undecoded', message: `Unknown DeepSeek Harness record type '${type}'` });
          }
          break;
        }
      }
    }

    // Emit open spans for any in-flight tool calls at EOF.
    for (const pending of openTools.values()) {
      pending.callEv.flags = [...new Set([...(pending.callEv.flags ?? []), 'abandoned' as EventFlag])];
      const spId = spanId(session, 'tool', pending.callId);
      pending.callEv.span = spId;
      spans.push({
        rec: 'span', id: spId, session, kind: 'tool', name: pending.name, parent: pending.turnId,
        start: pending.callEv.ts, durSrc: 'unknown', status: 'open',
        linkSession: pending.linkSession,
        firstEvent: pending.callEv.id, lastEvent: pending.callEv.id,
        attrs: { ...(pending.inherited ? { inherited: true } : {}), tool: { name: pending.name, kind: pending.kind } },
      });
    }

    if (!events.length) {
      stats.skipped = 1;
      return stats;
    }

    // Enrich cwd/workspace title from `<dshRoot>/storages/workspace.json` when present.
    const dshRoot = findDshRoot(path);
    const wsMeta = dshRoot ? (await readWorkspaceMeta(dshRoot, ctx.env?.runAt)).bySessionId.get(nativeId) : undefined;
    if (!cwd && wsMeta?.workspacePath) cwd = wsMeta.workspacePath;

    sink.emit({
      rec: 'session',
      id: session,
      agent: 'deepseek',
      nativeId,
      role,
      parentId: parentNative ? `ds:${parentNative}` : undefined,
      title: title ?? subagentLabel ?? firstPrompt,
      cwd,
      project: wsMeta?.workspaceTitle ?? (cwd ? basename(cwd) : undefined),
      models: [...models],
      version: version !== undefined ? `format-v${version}` : undefined,
      originator: str(header?.agentPreset),
      entrypoint: path.endsWith('.zstd') || path.endsWith('.zst') ? 'app-or-cli' : 'cli',
      createdTs: createdTs ?? events[0].ts,
      meta: cleanObj({
        formatVersion: version,
        agentPreset: str(header?.agentPreset),
        origin: str(header?.origin),
        delegationDepth: num(header?.delegationDepth),
        isSeeded: isSeeded || undefined,
        contextWindow,
      }),
    });

    for (const ev of events) sink.emit(ev);
    for (const sp of spans) {
      if (sp.kind === 'turn' && sp.dur === undefined && sp.end !== undefined) {
        sp.dur = sp.end - sp.start;
        sp.durSrc = 'derived:ts-gap';
      }
      sink.emit(sp);
    }
    return stats;
  },
};

// ---------------------------------------------------------------------------
// Helpers

/** Block headers and finish records are protocol metadata, not generated tokens. */
function firstContentTimeUs(stream: any[]): number | undefined {
  for (const item of stream) {
    if ((item?.type === 'text-chunks' || item?.type === 'reasoning-chunks') && Array.isArray(item.texts)) {
      const index = item.texts.findIndex((text: unknown) => typeof text === 'string' && text.length > 0);
      if (index < 0) continue;
      // time0 timestamps the first fragment; dt stores the gaps between later fragments.
      const base = num(item.time0);
      const gaps = Array.isArray(item.dt) ? item.dt.slice(0, index) : [];
      if (base !== undefined && gaps.length === index && gaps.every((gap: unknown) => num(gap) !== undefined)) {
        return msToUs(base + gaps.reduce((sum: number, gap: number) => sum + gap, 0));
      }
    }
    const chunk = item?.chunk;
    if ((chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') && typeof chunk.text === 'string' && chunk.text) {
      const at = msToUs(item.time);
      if (at !== undefined) return at;
    }
  }
  return undefined;
}

function extractDshContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if ((b as any).type === 'reasoning' || (b as any).type === 'thinking') return '';
      if (typeof (b as any).text === 'string') return (b as any).text;
      if ((b as any).type === 'image') return '[image]';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object' && typeof (content as any).text === 'string') return (content as any).text;
  return '';
}

function dshTokens(u: unknown, contextWindow?: number): TokenUsage | undefined {
  if (!u || typeof u !== 'object') return contextWindow !== undefined ? { context_window: contextWindow } : undefined;
  const o = u as Record<string, unknown>;
  const uncached = num(o.inputTokens);
  const output = num(o.outputTokens);
  const cacheRead = num(o.cacheReadTokens);
  const cacheWrite = num(o.cacheWriteTokens);
  const total = num(o.totalTokens);
  if (uncached === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined && total === undefined) {
    return contextWindow !== undefined ? { context_window: contextWindow } : undefined;
  }
  // In DeepSeek Harness, `inputTokens` is uncached prompt tokens (`inputTokens + cacheReadTokens + outputTokens === totalTokens`).
  const input = uncached !== undefined || cacheRead !== undefined || cacheWrite !== undefined
    ? (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
    : undefined;
  return cleanObj({
    input,
    uncached,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    output,
    total,
    context_window: contextWindow,
  });
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function words(...parts: unknown[]): string {
  return parts.filter((p) => typeof p === 'string' && p).join(' ');
}
