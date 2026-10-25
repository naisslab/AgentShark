// Claude Code and Claude Cowork transcript adapter (SPEC §4.1).
//
// One transcript file holds one session: a main conversation, an Agent-tool subagent or a workflow agent.
// parse() reads the file into per-line drafts first and builds structure afterwards, for two reasons: the
// session record (title, models) must be emitted before the events but is only known at the end of the
// file, and a re-appended uuid keeps its first position but takes its last content.

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fmtBytes, fmtDur } from '../model/format.ts';
import { SPAN_DEPTH } from '../model/kinds.ts';
import { AGENT_PREFIX } from '../model/types.ts';
import type {
  Actor, AgentKind, Attrs, EventFlag, EventKind, ExpertGroup, ExpertSeverity, SessionRec, SessionRole, SourceKind,
  SpanKind, SpanRec, SpanStatus, TokenUsage, TsSrc,
} from '../model/types.ts';
import {
  compact, editChanges, emptyStats, eventId, fileInfo, INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, INTERRUPT_NOTE, isCredentialPath, isoToUs,
  msToUs, oneLine, outputTail, readJsonl, sourceId, spanId, splitMcp, summarizeToolInput, toolKind, truncate,
} from './adapter.ts';
import { agentRoots, type Adapter, type DiscoverEnv, type LineInfo, type ParseContext, type ParseStats, type RecordSink, type SourceFile } from './adapter.ts';

export const claudeAdapter: Adapter = { name: 'claude', discover, parse };

// ---------------------------------------------------------------------------
// Discovery

type Found = [path: string, agent: AgentKind, kind: SourceKind];

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function subdirs(dir: string): Promise<string[]> {
  return (await entries(dir)).filter((e) => e.isDirectory()).map((e) => e.name);
}

const AGENT_FILE = /^agent-.+\.jsonl$/;

async function discover(env: DiscoverEnv): Promise<SourceFile[]> {
  const wanted = (a: AgentKind) => !env.agents || env.agents.includes(a);
  const found: Found[] = [];
  if (wanted('claude-code')) for (const root of agentRoots(env, 'claude')) await scanProjects(join(root, 'projects'), 'claude-code', found);
  if (wanted('claude-cowork') && env.autoDiscover !== false) {
    const root = join(env.appSupport, 'Claude', 'local-agent-mode-sessions');
    for (const account of await subdirs(root)) {
      for (const org of await subdirs(join(root, account))) {
        const orgDir = join(root, account, org);
        // Cowork sessions are local_<uuid>/ dirs; the persistent Dispatch agent lives in agent/local_ditto_<org>/.
        const sessionDirs = [
          ...(await subdirs(orgDir)).map((d) => join(orgDir, d)),
          ...(await subdirs(join(orgDir, 'agent'))).map((d) => join(orgDir, 'agent', d)),
        ].filter((d) => basename(d).startsWith('local_'));
        for (const d of sessionDirs) await scanProjects(join(d, '.claude', 'projects'), 'claude-cowork', found);
      }
    }
  }
  const files = await Promise.all(
    found.filter(([p]) => !isCredentialPath(p)).map(([p, agent, kind]) => fileInfo(p, agent, kind, 'claude')),
  );
  return files.filter((f): f is SourceFile => f !== null);
}

/** <root>/<project>/<sid>.jsonl, <sid>/subagents/agent-*.jsonl, <sid>/subagents/workflows/wf_*\/agent-*.jsonl */
async function scanProjects(root: string, agent: AgentKind, out: Found[]): Promise<void> {
  for (const project of await subdirs(root)) {
    const projectDir = join(root, project);
    for (const e of await entries(projectDir)) {
      const p = join(projectDir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push([p, agent, 'transcript']);
      if (!e.isDirectory()) continue;
      const sub = join(p, 'subagents');
      for (const f of await entries(sub)) {
        if (f.isFile() && AGENT_FILE.test(f.name)) out.push([join(sub, f.name), agent, 'subagent-transcript']);
      }
      const wfRoot = join(sub, 'workflows');
      for (const run of await subdirs(wfRoot)) {
        for (const f of await entries(join(wfRoot, run))) {
          if (f.isFile() && AGENT_FILE.test(f.name)) out.push([join(wfRoot, run, f.name), agent, 'workflow-transcript']);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// File layout and sidecars

interface Layout {
  agent: AgentKind;
  prefix: string;
  role: SessionRole;
  /** Native session id: the main file name, or the directory that holds subagents/. */
  sid: string;
  agentId?: string;
  runId?: string;
  /** <project>/<sid>/, which holds subagents/, workflows/ and tool-results/. */
  sidDir: string;
  /** The parsed session's id. */
  session: string;
}

function layoutOf(file: SourceFile): Layout {
  const p = file.path;
  const prefix = AGENT_PREFIX[file.agent];
  const wf = /\/([^/]+)\/subagents\/workflows\/(wf_[^/]+)\/agent-([^/]+)\.jsonl$/.exec(p);
  if (wf) {
    const [, sid, runId, agentId] = wf;
    const sidDir = p.slice(0, wf.index + 1 + sid.length);
    return { agent: file.agent, prefix, role: 'workflow-agent', sid, agentId, runId, sidDir, session: `${prefix}:${sid}/${agentId}` };
  }
  const sub = /\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/.exec(p);
  if (sub) {
    const [, sid, agentId] = sub;
    const sidDir = p.slice(0, sub.index + 1 + sid.length);
    return { agent: file.agent, prefix, role: 'subagent', sid, agentId, sidDir, session: `${prefix}:${sid}/${agentId}` };
  }
  const sid = basename(p, '.jsonl');
  return { agent: file.agent, prefix, role: 'main', sid, sidDir: join(dirname(p), sid), session: `${prefix}:${sid}` };
}

async function readJson(path: string): Promise<any> {
  if (isCredentialPath(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readJournal(path: string): Promise<any[]> {
  const out: any[] = [];
  try {
    await readJsonl(path, (o) => out.push(o), () => {});
  } catch {
    // A missing journal only loses the label.
  }
  return out;
}

/** Workflow-agent metadata from the run journal and the run summary (wf_<runId>.json). */
async function workflowAgentMeta(layout: Layout, filePath: string): Promise<Record<string, unknown> | undefined> {
  if (!layout.runId || !layout.agentId) return undefined;
  const id = layout.agentId;
  const out: Record<string, unknown> = { runId: layout.runId };
  for (const j of await readJournal(join(dirname(filePath), 'journal.jsonl'))) {
    if (j?.agentId !== id) continue;
    if (j.type === 'started') Object.assign(out, { label: j.label, phase: j.phase });
    else if (j.type === 'result') out.state = 'completed';
    else if (j.type === 'failed') out.state = 'failed';
  }
  const run = await readJson(join(layout.sidDir, 'workflows', `${layout.runId}.json`));
  if (run && typeof run === 'object') {
    out.workflowName = run.workflowName;
    const p = Array.isArray(run.workflowProgress) ? run.workflowProgress.find((e: any) => e?.agentId === id) : undefined;
    if (p) {
      const { promptPreview, resultPreview, lastToolSummary, ...timing } = p;
      out.progress = timing;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-line drafts

type Obj = Record<string, any>;

interface Draft {
  kind: EventKind;
  proto: string;
  actor: Actor;
  summary: string;
  attrs: Attrs;
  flags: EventFlag[];
  native: unknown;
  /** Content block index, for lines with several blocks. */
  block?: number;
  span?: string;
  turn?: string;
  dur?: number;
  id?: string;
  seq?: number;
  /** Task id this event names; it becomes attrs.tool.proc_id when the task is a background shell (linkProcesses). */
  procRef?: string;
}

/** One API response line: the fields that matter for grouping by message.id. */
interface Msg {
  id: string;
  model?: string;
  requestId?: string;
  stop?: string;
  usage?: Obj;
  synthetic: boolean;
  thinkingMs?: number;
}

interface Line {
  info: LineInfo;
  type: string;
  /** Logged timestamp (µs). */
  ts?: number;
  /** Resolved timestamp and how it was obtained. */
  rts: number;
  tsSrc: TsSrc;
  uuid?: string;
  parentUuid?: string;
  promptId?: string;
  turnOrigin?: string;
  events: Draft[];
  msg?: Msg;
  /** Set on a line that re-appends an earlier uuid; the earlier line keeps the position. */
  dupOf?: Line;
}

interface Call {
  id: string;
  name: string;
  d: Draft;
  line: Line;
  turn?: Turn;
  result?: Draft;
  resultLine?: Line;
}

interface Turn {
  key: string;
  /** Every promptId seen on lines of this turn; tool results can carry a new one mid-turn. */
  keys: Set<string>;
  span: string;
  index: number;
  origin?: string;
  name: string;
  start: number;
  end: number;
  first: Draft;
  last: Draft;
  closed: boolean;
  /** The newest model exchange ended the turn: a final response, or a child's handback call (turnSpans). */
  ended: boolean;
  aborted: boolean;
  loggedDurMs?: number;
}

interface Group {
  id: string;
  span: string;
  lines: Line[];
  events: Draft[];
  turn?: Turn;
}

interface Retry {
  key: string;
  events: Draft[];
  start: number;
  end: number;
  lastWaitMs: number;
  turn?: Turn;
}

interface SpanDraft {
  rec: SpanRec;
  first?: Draft;
  last?: Draft;
}

interface PendingExpert {
  severity: ExpertSeverity;
  group: ExpertGroup;
  message: string;
  draft?: Draft;
  span?: string;
}

// Text forms of user content that are not human prompts.
const WRAPPER = /^\s*<(command-name|command-message|command-args|local-command-[a-z-]+|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)>/;
const INTERRUPTED = /^\s*\[Request interrupted by user/;
const OPENS_TURN = new Set<EventKind>(['user.prompt', 'agent.message', 'agent.status']);
/** First event kinds of a user line that may start a new turn when its promptId changes (a tool result never does). */
const STARTS_TURN = new Set<EventKind>([...OPENS_TURN, 'user.inject', 'turn.abort']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** Calls that hand a child's result back to its parent: once one succeeds, the child's run is over. */
const HANDBACK_TOOLS = new Set(['StructuredOutput', 'SubagentHandback']);
/** User-line records the model answers: they leave the turn waiting on the model. */
const ANSWERED = new Set<EventKind>(['user.prompt', 'tool.result', 'agent.message', 'agent.status']);
/** Tools whose input names a file change (attrs.change.files). */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Input key naming the background task a tool polls or stops. Agents and workflows are tasks too (linkProcesses). */
const TASK_ID_KEY = new Map([['TaskOutput', 'task_id'], ['TaskStop', 'task_id'], ['BashOutput', 'bash_id'], ['KillShell', 'shell_id'], ['KillBash', 'shell_id']]);
/** Result text of a Bash command run or moved into the background, and of a Monitor (when toolUseResult lacks the id). */
const BACKGROUND_RE = /^(?:Command running in background with ID: |Command .{0,80}?moved to the background \(ID: |Monitor started \(task )(\w+)/;

// ---------------------------------------------------------------------------
// Parsing

async function parse(ctx: ParseContext, sink: RecordSink): Promise<ParseStats> {
  const layout = layoutOf(ctx.file);
  const t = new Transcript(ctx, layout);
  if (layout.agentId) {
    t.agentMeta = await readJson(join(dirname(ctx.file.path), `agent-${layout.agentId}.meta.json`));
    t.workflowMeta = await workflowAgentMeta(layout, ctx.file.path);
  }
  const { parsedBytes, lines, sha256 } = await readJsonl(ctx.file.path, (o, info) => t.add(o, info), (info, err) => t.malformed(info, err));
  t.stats.parsedBytes = parsedBytes;
  t.stats.sha256 = sha256;
  t.stats.lines = lines;
  await t.finish(sink);
  return t.stats;
}

class Transcript {
  readonly ctx: ParseContext;
  readonly layout: Layout;
  readonly src: string;
  readonly stats = emptyStats();
  agentMeta: any;
  workflowMeta: Record<string, unknown> | undefined;

  private readonly lines: Line[] = [];
  private readonly byUuid = new Map<string, Line>();
  private readonly experts: PendingExpert[] = [];
  private readonly spans = new Map<string, SpanDraft>();
  private readonly undecoded = new Map<string, number>();
  private readonly retracted = new Set<string>();
  private readonly sessionSpan: string;
  /** Ids of background shells and monitors this file starts; other task ids name agents or workflows. */
  private readonly procs = new Set<string>();
  /** Edit-tool calls waiting for their result, whose toolUseResult refines attrs.change.files. */
  private readonly edits = new Map<string, { name: string; input: unknown; attrs: Attrs }>();

  // Session description, filled from envelopes and state records.
  private cwd?: string;
  private inheritedCwd?: string;
  private branch?: string;
  private version?: string;
  private entrypoint?: string;
  private slug?: string;
  private readonly models: string[] = [];
  private readonly titles: { custom?: string; ai?: string; agentName?: string; summary?: string; prompt?: string } = {};
  private readonly state: Record<string, unknown> = {};
  private readonly prs: Obj[] = [];
  private readonly resumedFrom = new Set<string>();

  constructor(ctx: ParseContext, layout: Layout) {
    this.ctx = ctx;
    this.layout = layout;
    this.src = ctx.sourceId || sourceId(ctx.file.path);
    this.sessionSpan = spanId(layout.session, 'session', layout.agentId ?? layout.sid);
  }

  malformed(info: LineInfo, err: Error): void {
    this.stats.malformed++;
    this.expert('warn', 'malformed', `line ${info.line}: unparseable JSON (${err.message})`);
  }

  private expert(severity: ExpertSeverity, group: ExpertGroup, message: string, draft?: Draft, span?: string): void {
    this.experts.push({ severity, group, message, draft, span });
  }

  // -------------------------------------------------------------------------
  // Decoding one record into drafts

  add(o: any, info: LineInfo): void {
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      const line = this.newLine(info, '', undefined);
      line.events.push(this.unknown(o, `claude/${Array.isArray(o) ? 'array' : typeof o}`, []));
      this.lines.push(line);
      return;
    }
    const type = typeof o.type === 'string' ? o.type : '';
    const ts = isoToUs(o.timestamp) ?? (type === 'file-history-snapshot' ? isoToUs(o.snapshot?.timestamp) : undefined);
    const line = this.newLine(info, type, ts);
    if (typeof o.uuid === 'string') line.uuid = o.uuid;
    if (typeof o.parentUuid === 'string') line.parentUuid = o.parentUuid;
    if (typeof o.promptId === 'string') line.promptId = o.promptId;
    line.turnOrigin = o.turnOrigin ?? o.origin?.kind;

    const inherited = typeof o.sessionId === 'string' && o.sessionId !== this.layout.sid;
    const flags: EventFlag[] = [];
    if (inherited) {
      flags.push('inherited');
      this.stats.inherited++;
      this.resumedFrom.add(o.sessionId);
    }
    if (o.isSidechain === true) flags.push('sidechain');
    if (o.isMeta === true) flags.push('meta');
    this.noteEnvelope(o, inherited);

    const native = compact(o);
    line.events = this.decode(o, type, line, flags, native);

    if (line.uuid) {
      const first = this.byUuid.get(line.uuid);
      if (first) this.reappend(first, line);
      else this.byUuid.set(line.uuid, line);
    }
    this.lines.push(line);
  }

  private newLine(info: LineInfo, type: string, ts: number | undefined): Line {
    return { info, type, ts, rts: 0, tsSrc: 'none', events: [] };
  }

  /** Keep the first position, take the last content (SPEC §4.1). */
  private reappend(first: Line, again: Line): void {
    again.dupOf = first;
    if (first.events.length === again.events.length) {
      first.events = again.events.map((d, i) => ({ ...d, flags: [...d.flags], native: first.events[i].native, block: first.events[i].block }));
    }
    first.msg = again.msg ?? first.msg;
    first.promptId = again.promptId ?? first.promptId;
    first.parentUuid = again.parentUuid ?? first.parentUuid;
    for (const d of again.events) if (!d.flags.includes('dup')) d.flags.push('dup');
  }

  private noteEnvelope(o: Obj, inherited: boolean): void {
    if (typeof o.cwd === 'string' && o.cwd) {
      if (inherited) this.inheritedCwd ??= o.cwd;
      else this.cwd ??= o.cwd;
    }
    if (inherited) return;
    if (typeof o.gitBranch === 'string' && o.gitBranch && o.gitBranch !== 'HEAD') this.branch = o.gitBranch;
    if (typeof o.version === 'string') this.version = o.version;
    if (typeof o.entrypoint === 'string') this.entrypoint = o.entrypoint;
    if (typeof o.slug === 'string') this.slug = o.slug;
    if (typeof o.permissionMode === 'string') this.state.permissionMode = o.permissionMode;
    const model = o.type === 'assistant' ? o.message?.model : undefined;
    if (typeof model === 'string' && model !== '<synthetic>' && !this.models.includes(model)) this.models.push(model);
  }

  private draft(kind: EventKind, proto: string, actor: Actor, summary: string, attrs: Attrs, flags: EventFlag[], native: unknown, block?: number): Draft {
    return { kind, proto, actor, summary, attrs, flags: [...flags], native, block };
  }

  private unknown(native: unknown, proto: string, flags: EventFlag[], block?: number): Draft {
    this.stats.unknown++;
    this.undecoded.set(proto, (this.undecoded.get(proto) ?? 0) + 1);
    return this.draft('raw.unknown', proto, 'system', proto.replace(/^claude\//, ''), {}, flags, compact(native), block);
  }

  private decode(o: Obj, type: string, line: Line, flags: EventFlag[], native: unknown): Draft[] {
    const one = (kind: EventKind, actor: Actor, summary: string, attrs: Attrs = {}, proto = `claude/${type}`) => [
      this.draft(kind, proto, actor, summary, attrs, flags, native),
    ];
    switch (type) {
      case 'user':
        return this.decodeUser(o, flags, native);
      case 'assistant':
        return this.decodeAssistant(o, line, flags, native);
      case 'attachment':
        return [this.decodeAttachment(o, flags, native)];
      case 'system':
        return [this.decodeSystem(o, flags, native)];
      case 'progress':
        return [this.decodeProgress(o, flags, native)];
      case 'queue-operation': {
        const text = typeof o.content === 'string' ? o.content : undefined;
        const why = o.reason ? ` (${o.reason})` : '';
        return one('harness.queue', 'harness', `${o.operation ?? 'queue'}${why}${text ? ': ' + oneLine(text, 140) : ''}`, {
          ...textAttrs(text),
          queue: { operation: o.operation, reason: o.reason },
        });
      }
      case 'last-prompt':
        return one('session.state', 'harness', `last-prompt${o.lastPrompt ? ': ' + oneLine(o.lastPrompt, 140) : ''}`, {
          ...textAttrs(o.lastPrompt),
          state: { type, leaf_uuid: o.leafUuid },
        });
      case 'custom-title':
      case 'ai-title':
      case 'agent-name':
      case 'summary': {
        const value = String(o.customTitle ?? o.aiTitle ?? o.agentName ?? o.summary ?? '');
        if (type === 'custom-title') this.titles.custom = value;
        else if (type === 'ai-title') this.titles.ai = value;
        else if (type === 'agent-name') this.titles.agentName = value;
        else this.titles.summary = value;
        return one('session.state', 'harness', `${type}: ${oneLine(value, 140)}`, { text: value, state: { type, value } });
      }
      case 'mode':
      case 'permission-mode': {
        const value = o.mode ?? o.permissionMode;
        this.state[type === 'mode' ? 'mode' : 'permissionMode'] = value;
        const attrs: Attrs = { state: { type, value } };
        if (type === 'permission-mode') attrs.permission = { mode: value };
        return one('session.state', 'harness', `${type}: ${value}`, attrs);
      }
      case 'worktree-state': {
        const w = o.worktreeSession;
        this.state.worktree = w ?? null;
        return one('session.state', 'harness', w ? `worktree ${w.worktreeName ?? ''} ${w.worktreeBranch ?? ''}`.trim() : 'worktree exited', {
          state: { type, worktree: w?.worktreePath, branch: w?.worktreeBranch },
        });
      }
      case 'relocated':
        this.state.relocatedCwd = o.relocatedCwd;
        return one('session.state', 'harness', `relocated → ${o.relocatedCwd}`, { state: { type, cwd: o.relocatedCwd } });
      case 'cost-state': {
        // totalCostUSD is the session's running total, so the linker takes the largest value, not the sum.
        const cost = {
          usd: num(o.totalCostUSD), cumulative: true, api_ms: num(o.totalAPIDuration), tool_ms: num(o.totalToolDuration), total_ms: num(o.totalDuration),
        };
        this.state.cost = cost;
        const parts = [`cost $${(cost.usd ?? 0).toFixed(2)}`];
        if (cost.api_ms !== undefined) parts.push(`api ${fmtDur(msToUs(cost.api_ms))}`);
        if (cost.tool_ms !== undefined) parts.push(`tools ${fmtDur(msToUs(cost.tool_ms))}`);
        return one('session.state', 'harness', parts.join('  '), { cost, state: { type } });
      }
      case 'file-history-snapshot': {
        const files = Object.keys(o.snapshot?.trackedFileBackups ?? {}).length;
        return one('harness.file', 'harness', `file-history snapshot  ${files} file${files === 1 ? '' : 's'}`, {
          file: { count: files, message_id: o.messageId, update: o.isSnapshotUpdate === true },
        });
      }
      case 'file-history-delta': {
        const b = o.backup ?? {};
        return one('harness.file', 'harness', `file-history ${o.trackingPath ?? ''} v${b.version ?? '?'}`, {
          file: { path: o.trackingPath, version: b.version, backup: b.backupFileName ?? undefined, message_id: o.messageId },
        });
      }
      case 'pr-link':
        if (!this.prs.some((p) => p.url === o.prUrl)) this.prs.push({ number: o.prNumber, url: o.prUrl, repo: o.prRepository });
        return one('harness.vcs', 'harness', `PR #${o.prNumber} ${o.prRepository ?? ''}`.trim(), {
          vcs: { pr: o.prNumber, url: o.prUrl, repo: o.prRepository },
        });
      case 'atis-latch':
      case 'frame-link':
      case 'bridge-session':
      case 'artifact-autoreact-ledger':
      case 'artifact-comment-monitor':
        return one('harness.other', 'harness', type, { state: { type } });
      default:
        return [this.unknown(o, `claude/${type || '<no type>'}`, flags)];
    }
  }

  private decodeUser(o: Obj, flags: EventFlag[], native: unknown): Draft[] {
    const content = o.message?.content;
    if (typeof content === 'string') {
      const c = this.classifyText(content, o);
      return [this.draft(c.kind, c.proto, c.actor, c.summary, { ...textAttrs(content), ...c.attrs }, withTruncated(flags, content), native)];
    }
    if (!Array.isArray(content) || content.length === 0) {
      return [this.draft('user.inject', 'claude/user/empty', 'harness', '(empty user message)', {}, flags, native)];
    }
    const multi = content.length > 1;
    return content.map((b: any, i: number) => {
      const block = multi ? i : undefined;
      const type = b && typeof b === 'object' ? String(b.type) : typeof b;
      if (type === 'tool_result') return this.toolResult(b, o, flags, native, block);
      if (type === 'text') {
        const text = String(b.text ?? '');
        const c = this.classifyText(text, o);
        return this.draft(c.kind, c.proto, c.actor, c.summary, { ...textAttrs(text), ...c.attrs }, withTruncated(flags, text), native, block);
      }
      if (type === 'image' || type === 'document') {
        // Media takes the kind of the text it arrives with; a bare image is a prompt unless the line is meta.
        const kind: EventKind = o.isMeta === true || content.some((x: any) => x?.type === 'tool_result') ? 'user.inject' : 'user.prompt';
        const media = mediaInfo(b);
        const actor: Actor = kind === 'user.inject' ? 'harness' : this.layout.role === 'main' ? 'user' : 'agent';
        return this.draft(kind, `claude/user/${type}`, actor, `[${type} ${media.media_type ?? ''} ${fmtBytes(media.bytes)}]`, { media }, flags, native, block);
      }
      return this.unknown(b, `claude/user/${type}`, flags, block);
    });
  }

  private classifyText(text: string, o: Obj): { kind: EventKind; proto: string; actor: Actor; summary: string; attrs?: Attrs } {
    const origin = o.origin?.kind;
    if (o.isCompactSummary === true) {
      return { kind: 'context.compaction', proto: 'claude/user/compact_summary', actor: 'harness', summary: `compaction summary  ${fmtChars(text.length)}` };
    }
    if (text.trimStart().startsWith('<task-notification>') || origin === 'task-notification') {
      return { ...taskNotification(text), proto: 'claude/user/task_notification' };
    }
    if (INTERRUPTED.test(text)) return { kind: 'turn.abort', proto: 'claude/user/interrupt', actor: 'user', summary: oneLine(text, 120) };
    const w = WRAPPER.exec(text);
    if (w) {
      const tagName = w[1];
      if (tagName.startsWith('command-')) {
        const cmd = `${tag(text, 'command-name') ?? tag(text, 'command-message') ?? ''} ${tag(text, 'command-args') ?? ''}`;
        return { kind: 'user.inject', proto: 'claude/user/command', actor: 'user', summary: oneLine(cmd, 160) || 'command' };
      }
      if (tagName === 'bash-input') return { kind: 'user.inject', proto: 'claude/user/bash_input', actor: 'user', summary: '! ' + oneLine(tag(text, 'bash-input'), 150) };
      const proto = tagName === 'system-reminder' ? 'system_reminder' : tagName.startsWith('bash-') ? 'bash_output' : tagName === 'user-prompt-submit-hook' ? 'hook_output' : 'command_output';
      return { kind: 'user.inject', proto: `claude/user/${proto}`, actor: 'harness', summary: `${tagName}: ${oneLine(stripTags(text), 140)}` };
    }
    if (o.isMeta === true) return { kind: 'user.inject', proto: 'claude/user/meta', actor: 'harness', summary: oneLine(text, 160) };
    if (origin === 'peer' || origin === 'coordinator') {
      const from = o.origin?.from ?? o.origin?.name;
      return { kind: 'agent.message', proto: `claude/user/${origin}`, actor: 'agent', summary: `${from ? from + ': ' : ''}${oneLine(text, 150)}`, attrs: { agent: { nickname: from } } };
    }
    if (text.trim()) this.titles.prompt ??= text;
    // In subagent and workflow files the "user" is the parent agent.
    return { kind: 'user.prompt', proto: 'claude/user/prompt', actor: this.layout.role === 'main' ? 'user' : 'agent', summary: oneLine(text, 160) };
  }

  private toolResult(b: Obj, o: Obj, flags: EventFlag[], native: unknown, block: number | undefined, proto = 'claude/user/tool_result'): Draft {
    const text = resultText(b.content);
    const tur = o.toolUseResult;
    const tool: NonNullable<Attrs['tool']> = {
      call_id: b.tool_use_id,
      output: truncate(text, INDEX_TEXT_MAX),
      output_len: text.length,
      is_error: b.is_error === true,
    };
    // A persisted output shows the model a preview; toolUseResult keeps the streams, whose end the tail needs.
    const streams = typeof tur?.stdout === 'string' ? [tur.stdout, tur.stderr].filter((s) => typeof s === 'string' && s).join('\n') : '';
    const tail = outputTail(streams.length > text.length ? streams : text);
    if (tail !== undefined) tool.output_tail = tail;
    const attrs: Attrs = { tool };
    if (typeof tur === 'string') {
      tool.is_error = true;
      if (/^User rejected/i.test(tur)) tool.status = 'rejected';
    } else if (tur && typeof tur === 'object' && !Array.isArray(tur)) {
      if (tur.interrupted === true) tool.status = 'interrupted';
      else if (typeof tur.returnCodeInterpretation === 'string') tool.status = tur.returnCodeInterpretation;
      else if (tur.backgroundTaskId) tool.status = 'backgrounded';
      else if (typeof tur.status === 'string') tool.status = tur.status;
      if (tur.backgroundTaskId) tool.background_task_id = tur.backgroundTaskId;
      if (typeof tur.persistedOutputPath === 'string') tool.persisted_path = tur.persistedOutputPath;
      if (typeof tur.filePath === 'string') tool.path = tur.filePath;
      if (typeof tur.code === 'number') tool.http_status = tur.code;
      if (typeof tur.timedOutAfterMs === 'number') tool.timed_out_ms = tur.timedOutAfterMs;
      if (typeof tur.runId === 'string') tool.run_id = tur.runId;
      if (typeof tur.workflowName === 'string') tool.workflow_name = tur.workflowName;
      // Logged durations (SPEC §4.1): WebFetch durationMs, WebSearch durationSeconds, Agent totalDurationMs.
      if (typeof tur.durationMs === 'number') Object.assign(tool, { logged_ms: tur.durationMs, logged_src: 'toolUseResult.durationMs' });
      else if (typeof tur.durationSeconds === 'number') Object.assign(tool, { logged_ms: tur.durationSeconds * 1000, logged_src: 'toolUseResult.durationSeconds' });
      else if (typeof tur.totalDurationMs === 'number') Object.assign(tool, { logged_ms: tur.totalDurationMs, logged_src: 'toolUseResult.totalDurationMs' });
      if (typeof tur.agentId === 'string') {
        attrs.agent = { id: tur.agentId, type: tur.agentType, description: tur.description, total_tokens: tur.totalTokens, tool_uses: tur.totalToolUseCount };
      }
    }
    const exit = /^Exit code (\d+)/.exec(text);
    if (exit) tool.exit_code = Number(exit[1]);
    if (INTERRUPTED.test(text)) tool.status = 'interrupted';
    tool.persisted_path ??= /<persisted-output>[\s\S]*?saved to:\s*(\S+)/.exec(text)?.[1];
    if (o.toolDenialKind || o.permissionDecision) {
      const p = o.permissionDecision ?? {};
      attrs.permission = { decision: o.toolDenialKind ? 'deny' : p.decision, reason: o.toolDenialKind ?? p.reasonType, source: p.source };
    }
    const f = withTruncated(flags, text);
    if (tool.is_error) f.push('error');
    const d = this.draft('tool.result', proto, 'tool', '', attrs, f, native, block);
    // The result of an edit tool refines its call's files (Write: created or updated; the logged patch's counts).
    const edit = this.edits.get(b.tool_use_id);
    if (edit) {
      this.edits.delete(b.tool_use_id);
      const files = editChanges(edit.name, edit.input, tur);
      if (files.length) edit.attrs.change = { files };
    }
    // Background shells and monitors: logged ids first, else the id in the result text.
    const started = str(tur?.backgroundTaskId) ?? BACKGROUND_RE.exec(text.slice(0, 200))?.[1];
    // TaskOutput ({task: {task_id, task_type}}) and TaskStop ({task_id, task_type}) say whether the task is a shell.
    const task = tur?.task && typeof tur.task === 'object' ? tur.task : tur;
    const named = str(task?.task_id);
    if (started) this.procs.add(started);
    else if (named && task.task_type === 'local_bash') this.procs.add(named);
    d.procRef = started ?? named;
    return d;
  }

  private decodeAssistant(o: Obj, line: Line, flags: EventFlag[], native: unknown): Draft[] {
    const m = o.message ?? {};
    const synthetic = m.model === '<synthetic>' || o.isApiErrorMessage === true;
    line.msg = {
      id: typeof m.id === 'string' ? m.id : (line.uuid ?? `line-${line.info.line}`),
      model: m.model,
      requestId: o.requestId,
      stop: typeof m.stop_reason === 'string' ? m.stop_reason : undefined,
      usage: m.usage,
      synthetic,
      thinkingMs: num(o.thinkingDurationMs),
    };
    if (Array.isArray(o.supersedesUuids)) for (const u of o.supersedesUuids) this.retracted.add(u);
    const llm = { model: m.model, message_id: line.msg.id, request_id: o.requestId, effort: o.effort };
    const content: any[] = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
    if (content.length === 0) {
      return [this.draft('llm.text', 'claude/assistant/empty', 'assistant', '(empty response)', { llm }, flags, native)];
    }
    const multi = content.length > 1;
    const baseIndex = typeof o.apiBlockIndex === 'number' ? o.apiBlockIndex : undefined;
    return content.map((b: any, i: number) => {
      const block = multi ? i : undefined;
      const type = b && typeof b === 'object' ? String(b.type) : typeof b;
      const blockLlm = { ...llm, block_index: baseIndex !== undefined ? baseIndex + i : i };
      switch (type) {
        case 'text': {
          const text = String(b.text ?? '');
          if (synthetic) {
            const status = num(o.apiErrorStatus);
            const error = { type: o.error, status, message: truncate(text, 512) };
            return this.draft('llm.error', 'claude/assistant/api_error', 'system', `API error${status ? ' ' + status : ''}${o.error ? ' ' + o.error : ''}: ${oneLine(text, 140)}`,
              { ...textAttrs(text), llm: blockLlm, error }, [...flags, 'error'], native, block);
          }
          return this.draft('llm.text', 'claude/assistant/text', 'assistant', oneLine(text, 160) || '(empty text)', { ...textAttrs(text), llm: blockLlm }, withTruncated(flags, text), native, block);
        }
        case 'thinking':
        case 'redacted_thinking': {
          const text = type === 'thinking' ? String(b.thinking ?? '') : '';
          const ms = line.msg?.thinkingMs;
          const took = ms !== undefined ? fmtDur(msToUs(ms)) : '';
          const summary = type === 'redacted_thinking' ? 'thinking (redacted)'
            : text ? `thinking${took ? ` (${took})` : ''}  ${oneLine(text, 140)}`
            : `thinking (omitted${took ? ', ' + took : ''})`;
          return this.draft('llm.thinking', `claude/assistant/${type}`, 'assistant', summary,
            { ...textAttrs(text), llm: { ...blockLlm, thinking_ms: ms } }, withTruncated(flags, text), native, block);
        }
        case 'tool_use':
        case 'server_tool_use':
          return this.toolCall(b, type, blockLlm, flags, native, block);
        case 'web_search_tool_result':
        case 'web_fetch_tool_result':
        case 'code_execution_tool_result':
          // Server-side tools return their result inside the same response.
          return this.toolResult(b, {}, flags, native, block, `claude/assistant/${type}`);
        case 'fallback':
          return this.draft('llm.refusal', 'claude/assistant/fallback', 'assistant', `fallback ${b.from?.model ?? '?'} → ${b.to?.model ?? '?'}`,
            { llm: { ...blockLlm, fallback_model: b.to?.model } }, flags, native, block);
        default:
          return this.unknown(b, `claude/assistant/${type}`, flags, block);
      }
    });
  }

  private toolCall(b: Obj, type: string, llm: Obj, flags: EventFlag[], native: unknown, block: number | undefined): Draft {
    const name = String(b.name ?? '?');
    const input = b.input;
    const { server } = splitMcp(name);
    const tool: NonNullable<Attrs['tool']> = {
      name,
      call_id: b.id,
      kind: toolKind(name),
      input: compact(input, { maxString: INDEX_INPUT_MAX_STRING }),
      input_summary: summarizeToolInput(name, input),
    };
    if (server && name.startsWith('mcp__')) tool.server = server;
    if (typeof input?.command === 'string') tool.command = truncate(input.command, INDEX_TEXT_MAX);
    const path = input?.file_path ?? input?.notebook_path ?? (tool.kind === 'file' ? input?.path : undefined);
    if (typeof path === 'string') tool.path = path;
    const attrs: Attrs = { tool, llm };
    let summary = `${name}  ${tool.input_summary}`;
    if (name === 'Workflow') summary = `Workflow  ${oneLine(input?.description ?? input?.scriptPath ?? input?.resumeFromRunId ?? 'script', 140)}`;
    if (AGENT_TOOLS.has(name)) {
      attrs.agent = { type: input?.subagent_type ?? 'general-purpose', description: input?.description };
      summary = `${name} ▶ ${attrs.agent.type}: ${oneLine(input?.description ?? input?.prompt ?? '', 140)}`;
    }
    if (EDIT_TOOLS.has(name)) {
      const files = editChanges(name, input);
      if (files.length) attrs.change = { files };
      if (typeof b.id === 'string') this.edits.set(b.id, { name, input, attrs });
    }
    const d = this.draft('tool.call', `claude/assistant/${type}`, 'assistant', summary.trim(), attrs, flags, native, block);
    const taskKey = TASK_ID_KEY.get(name);
    if (taskKey) d.procRef = str(input?.[taskKey]);
    return d;
  }

  private decodeAttachment(o: Obj, flags: EventFlag[], native: unknown): Draft {
    const a: Obj = o.attachment && typeof o.attachment === 'object' ? o.attachment : {};
    const type = String(a.type ?? 'unknown');
    const proto = `claude/attachment/${type}`;
    if (type.startsWith('hook_')) return this.hookAttachment(a, type, proto, flags, native);
    if (type === 'queued_command' && a.commandMode === 'task-notification') {
      const text = typeof a.prompt === 'string' ? a.prompt : resultText(a.prompt);
      const n = taskNotification(text);
      const u = a.usage ?? {};
      if (n.attrs.task) Object.assign(n.attrs.task, { duration_ms: u.durationMs ?? n.attrs.task.duration_ms, total_tokens: u.totalTokens ?? n.attrs.task.total_tokens, tool_uses: u.toolUses ?? n.attrs.task.tool_uses });
      return this.draft('agent.status', proto, 'harness', n.summary, { ...textAttrs(text), ...n.attrs, context: { type } }, withTruncated(flags, text), native);
    }
    if (type === 'structured_output') {
      return this.draft('tool.result', proto, 'tool', 'structured output', { tool: { call_id: a.toolUseID, extra: 'structured_output' }, context: { type } }, flags, native);
    }
    const text = attachmentText(a, o);
    const kind: EventKind = type === 'prompt_snapshot' || type === 'deferred_tools_record' ? 'context.snapshot' : 'context.attachment';
    const d = this.draft(kind, proto, 'harness', attachmentSummary(type, a, text), { ...textAttrs(text), context: { type } }, withTruncated(flags, text ?? ''), native);
    if (type === 'task_status') {
      d.procRef = str(a.taskId);
      if (d.procRef && a.taskType === 'local_bash') this.procs.add(d.procRef);
    }
    return d;
  }

  private hookAttachment(a: Obj, type: string, proto: string, flags: EventFlag[], native: unknown): Draft {
    const hook = { name: a.hookName, event: a.hookEvent, exit_code: num(a.exitCode), command: a.command ?? a.blockingError?.command, duration_ms: num(a.durationMs), run: type };
    const blocking = a.blockingError?.blockingError ?? a.blockingError;
    const text = [a.stdout, a.stderr, typeof blocking === 'string' ? blocking : undefined, typeof a.content === 'string' ? a.content : undefined]
      .filter((s) => typeof s === 'string' && s).join('\n');
    const label = a.hookName ?? a.hookEvent ?? 'hook';
    const outcome = {
      hook_success: hook.exit_code !== undefined ? `exit ${hook.exit_code}` : 'ok',
      hook_non_blocking_error: `error${hook.exit_code !== undefined ? ' exit ' + hook.exit_code : ''}`,
      hook_blocking_error: 'blocked',
      hook_cancelled: 'cancelled',
    }[type] ?? type.replace(/^hook_/, '');
    const took = hook.duration_ms !== undefined ? `  (${fmtDur(msToUs(hook.duration_ms))})` : '';
    const detail = text && type !== 'hook_success' ? `: ${oneLine(text, 100)}` : '';
    const attrs: Attrs = { ...textAttrs(text || undefined), hook };
    if (typeof a.toolUseID === 'string' && a.toolUseID.startsWith('toolu_')) attrs.tool = { call_id: a.toolUseID };
    const f = withTruncated(flags, text);
    if (type === 'hook_non_blocking_error' || type === 'hook_blocking_error') f.push('error');
    return this.draft('hook.run', proto, 'harness', `${label}  ${outcome}${detail}${took}`, attrs, f, native);
  }

  private decodeSystem(o: Obj, flags: EventFlag[], native: unknown): Draft {
    const sub = String(o.subtype ?? '');
    const proto = `claude/system/${sub}`;
    const content = typeof o.content === 'string' ? o.content : undefined;
    switch (sub) {
      case 'api_error': {
        const e = o.error ?? {};
        const status = num(e.status) ?? num(o.cause?.status);
        const code = e.connection?.code ?? e.type ?? o.cause?.code;
        const message = typeof e.message === 'string' ? e.message : typeof e === 'string' ? e : undefined;
        const error = { type: code, status, message: truncate(message, 512), retry_attempt: num(o.retryAttempt), retry_in_ms: num(o.retryInMs), max_retries: num(o.maxRetries) };
        const retry = error.retry_attempt !== undefined ? `  retry ${error.retry_attempt}/${error.max_retries ?? '?'}${error.retry_in_ms !== undefined ? ' in ' + fmtDur(msToUs(error.retry_in_ms)) : ''}` : '';
        return this.draft('llm.error', proto, 'system', `API error ${status ?? code ?? ''}${retry}${message ? ': ' + oneLine(message, 100) : ''}`.replace(/ {3,}/g, '  '),
          { error }, [...flags, 'error'], native);
      }
      case 'compact_boundary': {
        const m = o.compactMetadata ?? {};
        const ctx = { type: sub, trigger: m.trigger, pre_tokens: num(m.preTokens), post_tokens: num(m.postTokens), duration_ms: num(m.durationMs) };
        const took = ctx.duration_ms !== undefined ? ` (${fmtDur(msToUs(ctx.duration_ms))})` : '';
        const sizes = ctx.pre_tokens !== undefined ? ` ${fmtTok(ctx.pre_tokens)} → ${fmtTok(ctx.post_tokens ?? 0)} tokens` : '';
        return this.draft('context.compaction', proto, 'harness', `compaction${sizes}${took}${m.trigger ? '  ' + m.trigger : ''}`, { context: ctx }, flags, native);
      }
      case 'model_refusal_fallback': {
        for (const u of Array.isArray(o.retractedMessageUuids) ? o.retractedMessageUuids : []) this.retracted.add(u);
        const error = { type: 'refusal', message: o.apiRefusalCategory, explanation: truncate(o.apiRefusalExplanation, 512) };
        return this.draft('llm.refusal', proto, 'system', `refusal${o.apiRefusalCategory ? ' (' + o.apiRefusalCategory + ')' : ''}: ${o.originalModel ?? '?'} → ${o.fallbackModel ?? '?'}`,
          { llm: { model: o.originalModel, fallback_model: o.fallbackModel, request_id: o.requestId }, error }, [...flags, 'error'], native);
      }
      case 'stop_hook_summary': {
        const infos: any[] = Array.isArray(o.hookInfos) ? o.hookInfos : [];
        const durations = infos.map((h) => num(h?.durationMs)).filter((d): d is number => d !== undefined);
        const errors = Array.isArray(o.hookErrors) ? o.hookErrors.length : 0;
        const hook = {
          name: 'stop_hook_summary', event: 'Stop', run: sub, count: num(o.hookCount) ?? infos.length, errors,
          prevented: o.preventedContinuation === true, duration_ms: durations.length ? Math.max(...durations) : undefined,
          command: infos.map((h) => h?.command).filter(Boolean).join(' ; ') || undefined,
        };
        const took = hook.duration_ms !== undefined ? `  (${fmtDur(msToUs(hook.duration_ms))})` : '';
        const summary = `Stop hooks ×${hook.count}${errors ? `  ${errors} error${errors > 1 ? 's' : ''}` : ''}${hook.prevented ? '  prevented continuation' : ''}${took}`;
        return this.draft('hook.run', proto, 'harness', summary, { ...textAttrs(o.stopReason), hook }, errors ? [...flags, 'error'] : flags, native);
      }
      case 'turn_duration': {
        const ms = num(o.durationMs);
        return this.draft('turn.end', proto, 'system', `turn end${ms !== undefined ? ' (' + fmtDur(msToUs(ms)) + ')' : ''}`, { turn: { duration_ms: ms } }, flags, native);
      }
      case 'local_command':
        return this.draft('user.inject', proto, 'harness', `local-command: ${oneLine(stripTags(content ?? ''), 140)}`, textAttrs(content), flags, native);
      case 'informational':
        return this.draft('harness.status', proto, 'system', oneLine(content ?? sub, 160), { ...textAttrs(content), status: { level: o.level } }, flags, native);
      default:
        return this.unknown(o, sub ? proto : 'claude/system', flags);
    }
  }

  private decodeProgress(o: Obj, flags: EventFlag[], native: unknown): Draft {
    const d: Obj = o.data && typeof o.data === 'object' ? o.data : {};
    const type = String(d.type ?? 'progress');
    const proto = `claude/progress/${type}`;
    if (type === 'hook_progress') {
      const hook = { name: d.hookName, event: d.hookEvent, command: d.command, run: type };
      const attrs: Attrs = { hook };
      if (typeof o.parentToolUseID === 'string') attrs.tool = { call_id: o.parentToolUseID };
      return this.draft('hook.run', proto, 'harness', `${d.hookName ?? d.hookEvent ?? 'hook'}  running`, attrs, flags, native);
    }
    if (type === 'agent_progress') return this.draft('agent.status', proto, 'agent', `agent progress ${d.agentId ?? ''}`.trim(), { agent: { id: d.agentId } }, flags, native);
    return this.draft('harness.status', proto, 'harness', `${type}${d.message ? ': ' + oneLine(String(d.message), 140) : ''}`, {}, flags, native);
  }

  // -------------------------------------------------------------------------
  // Structure: turns, model responses, tool calls, spans

  async finish(sink: RecordSink): Promise<void> {
    this.resolveTimestamps();
    const { calls, groups, turns } = this.walk();
    this.pairTools(calls, turns.at(-1));
    this.linkProcesses(calls);
    for (const g of groups.values()) this.llmSpan(g);
    this.turnSpans(turns);
    await this.workflowSpans([...calls.values()].filter((c) => c.name === 'Workflow'));
    this.followFirstOccurrence();
    this.markRetracted();
    this.sessionSpanDraft();
    this.assignIds();
    const L = this.layout;

    sink.emit(this.sessionRecord());
    for (const line of this.lines) {
      for (const d of line.events) {
        const n = line.events.length;
        sink.emit({
          rec: 'event', id: d.id!, session: L.session, ts: line.rts, tsSrc: line.tsSrc, seq: d.seq!,
          kind: d.kind, proto: d.proto, actor: d.actor, summary: d.summary, span: d.span, turn: d.turn, dur: d.dur,
          attrs: d.attrs, native: d.native,
          raw: { source: this.src, line: line.info.line, offset: line.info.offset, length: line.info.length, block: n > 1 ? d.block : undefined },
          flags: d.flags.length ? d.flags : undefined,
        });
      }
    }
    // Parents before children, so a consumer can resolve nesting while reading.
    const spans = [...this.spans.values()].sort((a, b) => SPAN_DEPTH[a.rec.kind] - SPAN_DEPTH[b.rec.kind]);
    for (const s of spans) {
      s.rec.firstEvent = s.first?.id;
      s.rec.lastEvent = s.last?.id;
      sink.emit(s.rec);
    }
    for (const [proto, count] of this.undecoded) this.expert('note', 'undecoded', `${count} record${count > 1 ? 's' : ''} of undecoded type ${proto}`);
    for (const x of this.experts) {
      sink.emit({ rec: 'expert', session: L.session, event: x.draft?.id, span: x.span, severity: x.severity, group: x.group, message: x.message });
    }
  }

  private resolveTimestamps(): void {
    let last: number | undefined;
    let inversions = 0;
    const pending: Line[] = [];
    for (const line of this.lines) {
      if (line.ts !== undefined) {
        if (last !== undefined && line.ts < last) inversions++;
        line.rts = line.ts;
        line.tsSrc = 'logged';
        last = line.ts;
      } else if (last !== undefined) {
        line.rts = last;
        line.tsSrc = 'inherited';
      } else {
        pending.push(line);
      }
    }
    // Leading records without a timestamp borrow the first logged one (or the file mtime) and keep tsSrc 'none'.
    const fallback = this.lines.find((l) => l.ts !== undefined)?.ts ?? Math.round(this.ctx.file.mtimeMs * 1000);
    for (const line of pending) line.rts = fallback;
    if (inversions) this.expert('chat', 'logging-gap', `${inversions} adjacent timestamp inversion${inversions > 1 ? 's' : ''} (file order is used for sequence)`);
  }

  private addSpan(kind: SpanKind, key: string, rec: Omit<SpanRec, 'rec' | 'id' | 'session' | 'kind'>, first?: Draft, last?: Draft, id?: string): SpanDraft {
    const sd: SpanDraft = { rec: { rec: 'span', id: id ?? spanId(this.layout.session, kind, key), session: this.layout.session, kind, ...rec }, first, last };
    this.spans.set(sd.rec.id, sd);
    return sd;
  }

  /** Walk lines in file order: turns, llm groups, tool calls, hooks, compactions, retries. */
  private walk(): { calls: Map<string, Call>; groups: Map<string, Group>; turns: Turn[] } {
    const S = this.layout.session;
    const calls = new Map<string, Call>();
    const groups = new Map<string, Group>();
    const turns: Turn[] = [];
    let turn: Turn | undefined;
    let retry: Retry | undefined;

    const closeRetry = (status: SpanStatus) => {
      if (!retry) return;
      const r = retry;
      retry = undefined;
      const end = r.end + (msToUs(r.lastWaitMs) ?? 0);
      const parent = r.turn?.span ?? this.sessionSpan;
      const sd = this.addSpan('retry', r.key, {
        name: `API retry ×${r.events.length}`, parent, start: r.start, end, dur: end - r.start, durSrc: 'derived:ts-gap', status,
        attrs: { error: { retry_attempt: r.events.length, status: r.events.at(-1)?.attrs.error?.status } },
      }, r.events[0], r.events.at(-1));
      for (const d of r.events) d.span = sd.rec.id;
      const msg = `${r.events.length} API ${r.events.length > 1 ? 'retries' : 'retry'} over ${fmtDur(end - r.start)}${status === 'ok' ? '' : ', no successful response'}`;
      this.expert('warn', 'retry', msg, r.events[0], sd.rec.id);
    };

    for (const line of this.lines) {
      if (line.dupOf) continue;
      const first = line.events[0];
      if (line.type === 'user' && first) {
        const key = line.promptId ?? (OPENS_TURN.has(first.kind) ? line.uuid ?? `line-${line.info.line}` : undefined);
        // Subagent and workflow transcripts change promptId on tool_result lines in the middle of one agent run;
        // such a line stays in the current turn, whose key set then includes the new promptId.
        if (key && turn && !turn.keys.has(key) && !STARTS_TURN.has(first.kind)) turn.keys.add(key);
        if (key && !turn?.keys.has(key)) {
          turn = {
            key, keys: new Set([key]), span: spanId(S, 'turn', key), index: turns.length + 1, origin: line.turnOrigin, name: turnName(first),
            start: line.rts, end: line.rts, first, last: first, closed: false, ended: false, aborted: false,
          };
          turns.push(turn);
          first.attrs.turn = { id: key, index: turn.index, origin: line.turnOrigin };
        }
      }
      if (line.type === 'user' || line.type === 'assistant') closeRetry(line.type === 'assistant' && !line.msg?.synthetic ? 'ok' : 'error');

      for (const d of line.events) {
        d.turn = turn?.span;
        d.span = turn?.span ?? this.sessionSpan;
      }
      if (line.msg) {
        let g = groups.get(line.msg.id);
        if (!g) groups.set(line.msg.id, (g = { id: line.msg.id, span: spanId(S, 'llm', line.msg.id), lines: [], events: [], turn }));
        g.lines.push(line);
        for (const d of line.events) {
          g.events.push(d);
          d.span = g.span;
          if (d.kind === 'tool.call' && d.attrs.tool?.call_id) {
            const id = String(d.attrs.tool.call_id);
            if (calls.has(id)) d.flags.push('dup');
            else calls.set(id, { id, name: String(d.attrs.tool.name), d, line, turn });
          }
        }
      }
      for (const d of line.events) this.singleLineSpans(d, line, turn);
      const errorEvent = line.type === 'system' ? line.events.find((d) => d.proto === 'claude/system/api_error') : undefined;
      if (errorEvent) {
        retry ??= { key: line.uuid ?? `line-${line.info.line}`, events: [], start: line.rts, end: line.rts, lastWaitMs: 0, turn };
        retry.events.push(errorEvent);
        retry.end = Math.max(retry.end, line.rts);
        retry.lastWaitMs = errorEvent.attrs.error?.retry_in_ms ?? 0;
      }
      if (turn) {
        const last = line.events.at(-1);
        const conversational = line.type === 'user' || line.type === 'assistant';
        // A stop_hook_summary closes the turn early; only further conversation reopens it.
        if (last && line.uuid && (!turn.closed || conversational)) {
          turn.end = Math.max(turn.end, line.rts);
          turn.last = last;
          if (conversational) turn.closed = false;
        }
        if (line.events.some((d) => d.proto === 'claude/system/stop_hook_summary' || d.kind === 'turn.end')) turn.closed = true;
        if (line.events.some((d) => d.kind === 'turn.abort')) turn.aborted = true;
        if (line.type === 'assistant' && line.msg) turn.ended = line.msg.synthetic || (line.msg.stop !== undefined && line.msg.stop !== 'tool_use' && line.msg.stop !== 'pause_turn');
        else if (line.type === 'user' && line.events.some((d) => ANSWERED.has(d.kind))) turn.ended = line.events.some((d) => handback(d, calls));
        const loggedTurn = line.events.find((d) => d.kind === 'turn.end')?.attrs.turn?.duration_ms;
        if (typeof loggedTurn === 'number') turn.loggedDurMs = loggedTurn;
      }
    }
    closeRetry('open');
    return { calls, groups, turns };
  }

  /**
   * Only the last turn can be open: until a logged end (stop_hook_summary, turn_duration, an interrupt), a final model
   * response (a logged stop reason other than tool_use, or a synthetic error message), or a child's successful handback.
   * Between a tool result and the next response the turn stays open. The analysis pass ends an open turn whose run
   * has been idle beyond the stall window (derive/turns.ts).
   */
  private turnSpans(turns: Turn[]): void {
    const lastTurn = turns.at(-1);
    for (const t of turns) {
      const loggedUs = msToUs(t.loggedDurMs);
      this.addSpan('turn', t.key, {
        name: t.name, parent: this.sessionSpan, start: t.start, end: loggedUs !== undefined ? t.start + loggedUs : t.end,
        dur: loggedUs ?? t.end - t.start, durSrc: loggedUs !== undefined ? 'logged:turn_duration.durationMs' : 'derived:ts-gap',
        status: t.aborted ? 'interrupted' : t === lastTurn && !t.closed && !t.ended ? 'open' : 'ok',
        attrs: { turn: { id: t.key, index: t.index, origin: t.origin } },
      }, t.first, t.last);
    }
  }

  /** Re-appended copies take the span and turn of their first occurrence. */
  private followFirstOccurrence(): void {
    for (const line of this.lines) {
      if (!line.dupOf) continue;
      const orig = line.dupOf.events;
      line.events.forEach((d, i) => {
        const o = orig[i] ?? orig[0];
        d.span = o?.span;
        d.turn = o?.turn;
        if (o && o.kind === d.kind) d.summary = o.summary;
      });
    }
  }

  /** Spans and expert entries that one record defines on its own. */
  private singleLineSpans(d: Draft, line: Line, turn: Turn | undefined): void {
    const parent = turn?.span ?? this.sessionSpan;
    const key = line.uuid ?? `line-${line.info.line}`;
    const hook = d.attrs.hook;
    // Only finished hook runs get a span; progress records and hook output attachments carry no outcome.
    if (d.kind === 'hook.run' && (hook?.duration_ms !== undefined || hook?.exit_code !== undefined || hook?.run === 'stop_hook_summary')) {
      const dur = msToUs(hook?.duration_ms);
      const sd = this.addSpan('hook', key, {
        name: String(hook?.name ?? hook?.event ?? 'hook'), parent, start: line.rts - (dur ?? 0), end: line.rts, dur,
        durSrc: dur !== undefined ? 'logged:durationMs' : 'unknown', status: d.flags.includes('error') ? 'error' : hook?.run === 'hook_cancelled' ? 'cancelled' : 'ok',
        attrs: { hook },
      }, d, d);
      d.span = sd.rec.id;
    } else if (d.kind === 'context.compaction' && d.proto === 'claude/system/compact_boundary') {
      const c = d.attrs.context ?? {};
      const dur = msToUs(c.duration_ms);
      const sd = this.addSpan('compaction', key, {
        name: `compaction${c.trigger ? ' (' + c.trigger + ')' : ''}`, parent, start: line.rts - (dur ?? 0), end: line.rts, dur,
        durSrc: dur !== undefined ? 'logged:compactMetadata.durationMs' : 'unknown', status: 'ok', attrs: { context: c },
      }, d, d);
      d.span = sd.rec.id;
      this.expert('note', 'compaction', d.summary, d, sd.rec.id);
    } else if (d.kind === 'llm.error' && d.proto === 'claude/assistant/api_error') {
      const e = d.attrs.error ?? {};
      const rate = e.type === 'rate_limit' || e.status === 429;
      this.expert(rate ? 'warn' : 'error', rate ? 'rate-limit' : 'api-error', d.summary, d);
    } else if (d.kind === 'llm.refusal' && d.proto === 'claude/system/model_refusal_fallback') {
      this.expert('warn', 'refusal', d.summary, d);
    } else if (d.kind === 'turn.abort') {
      this.expert('note', 'interrupted', this.layout.role === 'main' ? INTERRUPT_NOTE.main : INTERRUPT_NOTE.child, d);
    }
  }

  /** One API response = the lines sharing message.id (SPEC §3.5). */
  private llmSpan(g: Group): void {
    const firstLine = g.lines[0];
    const lastLine = g.lines.at(-1)!;
    const msg = lastLine.msg!;
    const loggedStop = [...g.lines].reverse().find((l) => l.msg?.stop)?.msg?.stop;
    const lastBlock = g.events.at(-1);
    const stop = loggedStop ?? (lastBlock?.kind === 'tool.call' ? 'tool_use' : 'end_turn');
    const stopSrc = loggedStop ? 'logged' : 'inferred';
    const firstTs = firstLine.rts;
    const end = Math.max(...g.lines.map((l) => l.rts));
    const anchor = this.requestStart(firstLine, g.id);
    const latency = anchor !== undefined && anchor <= firstTs ? firstTs - anchor : undefined;
    const start = latency !== undefined ? anchor! : firstTs;
    const thinking = g.lines.reduce((sum, l) => sum + (l.msg?.thinkingMs ?? 0), 0);
    const tokens = msg.synthetic ? undefined : claudeTokens(msg.usage);
    const llm = {
      model: msg.model, message_id: g.id, request_id: msg.requestId, stop_reason: stop, stop_reason_src: stopSrc as 'logged' | 'inferred',
      service_tier: msg.usage?.service_tier, latency_ms: latency !== undefined ? latency / 1000 : undefined, thinking_ms: thinking || undefined,
      blocks: g.events.length,
    };
    const status: SpanStatus = msg.synthetic || stop === 'refusal' ? 'error' : 'ok';
    let last = g.events.at(-1);
    if (tokens) {
      const flags: EventFlag[] = lastLine.events[0]?.flags.filter((f) => f === 'inherited' || f === 'sidechain') ?? [];
      if (stopSrc === 'inferred') flags.push('inferred');
      if (stop === 'refusal') flags.push('error');
      const cache = tokens.cache_read ? ` (cache ${fmtTok(tokens.cache_read)})` : '';
      const took = end > start ? `  (${fmtDur(end - start)})` : '';
      const summary = `${msg.model ?? 'model'}  in ${fmtTok(tokens.input ?? 0)}${cache} out ${fmtTok(tokens.output ?? 0)}  stop=${stop}${stopSrc === 'inferred' ? ' (inferred)' : ''}${took}`;
      const usage: Draft = {
        kind: 'llm.usage', proto: 'claude/assistant/usage', actor: 'assistant', summary, attrs: { llm, tokens }, flags,
        native: lastLine.events[0]?.native, span: g.span, turn: g.turn?.span,
      };
      lastLine.events.push(usage);
      last = usage;
    }
    if (stop === 'refusal' && !g.lines.some((l) => l.uuid && this.retracted.has(l.uuid))) this.expert('warn', 'refusal', `response refused (${msg.model ?? 'model'})`, last);
    this.addSpan('llm', g.id, {
      name: msg.model ?? 'model', parent: g.turn?.span ?? this.sessionSpan, start, end, dur: end - start,
      durSrc: 'derived:ts-gap', status, attrs: { llm, tokens, inherited: firstLine.events[0]?.flags.includes('inherited') || undefined },
    }, g.events[0], last);
  }

  /** Request start: the nearest user (prompt or tool result) or earlier response ancestor, skipping attachments and system records. */
  private requestStart(line: Line, msgId: string): number | undefined {
    let p = line.parentUuid;
    for (let guard = 0; p && guard < 100_000; guard++) {
      const a = this.byUuid.get(p);
      if (!a) return undefined;
      if (a.type === 'user' || (a.type === 'assistant' && a.msg?.id !== msgId)) return a.rts;
      p = a.parentUuid;
    }
    return undefined;
  }

  private pairTools(calls: Map<string, Call>, lastTurn: Turn | undefined): void {
    const L = this.layout;
    for (const line of this.lines) {
      if (line.dupOf) continue;
      for (const d of line.events) {
        if (d.kind !== 'tool.result') continue;
        const id = d.attrs.tool?.call_id;
        const call = typeof id === 'string' ? calls.get(id) : undefined;
        if (d.attrs.tool?.extra) {
          if (call) d.span = spanId(L.session, 'tool', call.id);
          continue;
        }
        if (!call) {
          d.flags.push('orphan');
          d.summary = resultSummary(d, undefined, undefined);
          this.expert('warn', 'unpaired', `tool result ${id ?? '(no id)'} has no tool call in this file`, d);
          continue;
        }
        if (call.result) {
          d.flags.push('dup');
          d.span = spanId(L.session, 'tool', call.id);
          d.summary = resultSummary(d, call, undefined);
          continue;
        }
        call.result = d;
        call.resultLine = line;
        if (line.info.line < call.line.info.line) this.expert('note', 'sequence', `tool result for ${call.name} ${call.id} is written before its call`, d);
      }
    }

    for (const call of calls.values()) {
      const r = call.result;
      const tool = r?.attrs.tool;
      const id = spanId(L.session, 'tool', call.id);
      call.d.span = id;
      if (r && tool) {
        r.span = id;
        tool.name = call.name;
        tool.kind = call.d.attrs.tool?.kind;
        // Bash results log no exit code unless the output starts with "Exit code N"; a result that is not an error
        // succeeded, which is recorded as a status, never as an exit code the log does not contain.
        if (call.name === 'Bash' && tool.exit_code === undefined && !tool.is_error && !tool.status) tool.status = 'ok';
        if (AGENT_TOOLS.has(call.name)) {
          const agentId = r.attrs.agent?.id ?? /agentId: ([\w-]+)/.exec(String(tool.output ?? ''))?.[1];
          if (agentId) {
            const link = `${L.prefix}:${L.sid}/${agentId}`;
            const fromCall = call.d.attrs.agent;
            r.attrs.agent = { ...r.attrs.agent, type: r.attrs.agent?.type ?? fromCall?.type, description: r.attrs.agent?.description ?? fromCall?.description, id: agentId, link_session: link };
            call.d.attrs.agent = { ...call.d.attrs.agent, id: agentId, link_session: link };
          }
        }
        if (call.name === 'Workflow') {
          tool.run_id ??= /\b(wf_[a-z0-9]+-[a-z0-9]+)\b/.exec(String(tool.output ?? ''))?.[1];
          if (typeof tool.workflow_name === 'string') call.d.summary = `Workflow ▶ ${tool.workflow_name}`;
        }
      }
      const end = call.resultLine?.rts;
      const logged = msToUs(tool?.logged_ms);
      const dur = logged ?? (end !== undefined ? end - call.line.rts : undefined);
      const start = logged !== undefined && end !== undefined ? end - logged : call.line.rts;
      const status: SpanStatus = !r ? (call.turn === lastTurn ? 'open' : 'unknown')
        : tool?.status === 'interrupted' ? 'interrupted'
        : tool?.status === 'rejected' || r.attrs.permission?.decision === 'deny' || r.attrs.permission?.decision === 'reject' ? 'cancelled'
        : tool?.is_error ? 'error' : 'ok';
      const link = call.d.attrs.agent?.link_session;
      this.addSpan('tool', call.id, {
        name: call.name, parent: call.turn?.span ?? this.sessionSpan, start, end: end !== undefined ? start + (dur ?? 0) : undefined, dur,
        durSrc: logged !== undefined ? `logged:${tool?.logged_src}` : dur !== undefined ? 'derived:ts-gap' : 'unknown', status,
        linkSession: typeof link === 'string' ? link : undefined,
        attrs: {
          tool: { name: call.name, call_id: call.id, kind: call.d.attrs.tool?.kind, server: call.d.attrs.tool?.server, input_summary: call.d.attrs.tool?.input_summary, exit_code: tool?.exit_code, is_error: tool?.is_error, status: tool?.status },
          agent: call.d.attrs.agent,
        },
      }, call.d, r ?? call.d);
      if (r) r.summary = resultSummary(r, call, dur);
      if (!r) this.expert('note', 'unpaired', `${call.name} call ${call.id} has no result`, call.d, id);
      else if (status === 'cancelled') this.expert('warn', 'permission-denied', `${call.name} denied${r.attrs.permission?.reason ? ' (' + r.attrs.permission.reason + ')' : ''}`, r, id);
      else if (status === 'interrupted') this.expert('note', 'interrupted', `${call.name} interrupted`, r, id);
      else if (status === 'error') this.expert('warn', 'tool-error', `${call.name} failed: ${oneLine(String(tool?.output ?? ''), 120)}`, r, id);
    }
  }

  /**
   * attrs.tool.proc_id (SPEC §12.3.8) on every event that names a background shell or monitor of this file: the call
   * that starts it and its result, TaskOutput/TaskStop/BashOutput/KillShell calls and results, task_status
   * attachments and <task-notification>s. The same tools and notifications also name agents and workflows; those get none.
   */
  private linkProcesses(calls: Map<string, Call>): void {
    for (const c of calls.values()) {
      if (!c.result) continue;
      c.d.procRef ??= c.result.procRef;
      c.result.procRef ??= c.d.procRef;
    }
    for (const line of this.lines) {
      for (const d of line.events) {
        const ref = d.procRef ?? (d.kind === 'agent.status' ? d.attrs.agent?.id : undefined);
        if (typeof ref === 'string' && this.procs.has(ref)) (d.attrs.tool ??= {}).proc_id = ref;
      }
    }
  }

  /** The main file reads <sid>/workflows/<runId>.json for each Workflow call and emits the run and its phases. */
  private async workflowSpans(calls: Call[]): Promise<void> {
    const L = this.layout;
    for (const call of calls) {
      const runId = call.result?.attrs.tool?.run_id;
      if (typeof runId !== 'string') continue;
      const run = await readJson(join(L.sidDir, 'workflows', `${runId}.json`));
      const id = spanId(L.session, 'wf', runId);
      const start = msToUs(run?.startTime) ?? call.line.rts;
      const dur = msToUs(run?.durationMs);
      const status = runStatus(run?.status);
      call.d.attrs.workflow = { run_id: runId };
      this.addSpan('workflow', runId, {
        name: String(run?.workflowName ?? runId), parent: call.turn?.span ?? this.sessionSpan, start, end: dur !== undefined ? start + dur : undefined, dur,
        durSrc: dur !== undefined ? 'logged:wf.durationMs' : 'unknown', status,
        attrs: {
          workflow: {
            run_id: runId, name: run?.workflowName, status: run?.status, agent_count: num(run?.agentCount),
            total_tokens: num(run?.totalTokens), total_tool_calls: num(run?.totalToolCalls), summary: truncate(run?.summary, 512),
          },
          tool: { call_id: call.id },
        },
      }, call.d, call.d, id);
      const progress: any[] = Array.isArray(run?.workflowProgress) ? run.workflowProgress : [];
      const phases = progress.filter((p) => p?.type === 'workflow_phase');
      for (const ph of phases) {
        const agents = progress.filter((p) => p?.type === 'workflow_agent' && p.phaseIndex === ph.index);
        const starts = agents.map((a) => num(a.startedAt) ?? num(a.queuedAt)).filter((v): v is number => v !== undefined);
        const ends = agents.map((a) => (num(a.startedAt) !== undefined && num(a.durationMs) !== undefined ? a.startedAt + a.durationMs : num(a.lastProgressAt)))
          .filter((v): v is number => v !== undefined);
        if (!starts.length) continue;
        const pStart = msToUs(Math.min(...starts))!;
        const pEnd = ends.length ? msToUs(Math.max(...ends)) : undefined;
        this.addSpan('phase', `${runId}.${ph.index}`, {
          name: String(ph.title ?? `phase ${ph.index}`), parent: id, start: pStart, end: pEnd, dur: pEnd !== undefined ? pEnd - pStart : undefined,
          durSrc: pEnd !== undefined ? 'derived:ts-gap' : 'unknown', status: phaseStatus(agents),
          attrs: { workflow: { run_id: runId, phase: ph.index, agents: agents.length, tokens: agents.reduce((s, a) => s + (num(a.tokens) ?? 0), 0) } },
        });
      }
    }
  }

  private markRetracted(): void {
    if (!this.retracted.size) return;
    for (const line of this.lines) {
      if (line.uuid && this.retracted.has(line.uuid)) for (const d of line.events) if (!d.flags.includes('abandoned')) d.flags.push('abandoned');
    }
  }

  private sessionSpanDraft(): void {
    const own = this.lines.filter((l) => l.events.length && !l.events[0].flags.includes('inherited'));
    const lines = own.length ? own : this.lines.filter((l) => l.events.length);
    if (!lines.length) return;
    let start = Infinity;
    let end = -Infinity;
    for (const l of lines) {
      start = Math.min(start, l.rts);
      end = Math.max(end, l.rts);
    }
    const L = this.layout;
    this.addSpan('session', L.agentId ?? L.sid, {
      name: this.title() ?? L.sid, start, end, dur: end - start, durSrc: 'derived:ts-gap', status: 'ok', attrs: { agent: { id: L.agentId, role: L.role } },
    }, lines[0].events[0], lines.at(-1)!.events.at(-1));
  }

  private assignIds(): void {
    let seq = 0;
    for (const line of this.lines) {
      const n = line.events.length;
      line.events.forEach((d, i) => {
        d.id = eventId(this.src, line.info.line, n > 1 ? i : undefined);
        d.seq = seq++;
      });
    }
    // An event that opens or closes its own span carries that span's duration.
    for (const line of this.lines) {
      for (const d of line.events) {
        const s = d.span ? this.spans.get(d.span) : undefined;
        if (s && (s.first === d || s.last === d) && s.rec.dur !== undefined) d.dur = s.rec.dur;
      }
    }
  }

  private title(): string | undefined {
    const t = this.titles;
    const meta = this.agentMeta;
    const label = this.workflowMeta?.label;
    const fromAgent = typeof label === 'string' ? label : typeof meta?.description === 'string' ? meta.description : undefined;
    const compaction = this.layout.agentId?.startsWith('acompact') ? 'compaction' : undefined;
    return t.custom || t.ai || t.agentName || t.summary || fromAgent || compaction || (t.prompt ? oneLine(t.prompt, 100) : undefined);
  }

  private sessionRecord(): SessionRec {
    const L = this.layout;
    const meta: Record<string, unknown> = { ...this.state };
    if (this.slug) meta.slug = this.slug;
    if (this.prs.length) meta.prs = this.prs;
    if (this.resumedFrom.size) meta.resumedFrom = [...this.resumedFrom].map((s) => `${L.prefix}:${s}`);
    if (this.titles.agentName) meta.agentName = this.titles.agentName;
    if (L.runId) meta.workflow = this.workflowMeta ?? { runId: L.runId };
    let parentId: string | undefined;
    let parentSpanId: string | undefined;
    if (L.role === 'subagent') {
      const m = this.agentMeta ?? {};
      meta.agent = { id: L.agentId, ...m };
      parentId = typeof m.parentAgentId === 'string' ? `${L.prefix}:${L.sid}/${m.parentAgentId}` : `${L.prefix}:${L.sid}`;
      if (typeof m.toolUseId === 'string') parentSpanId = spanId(parentId, 'tool', m.toolUseId);
    } else if (L.role === 'workflow-agent') {
      meta.agent = { id: L.agentId, ...(this.agentMeta ?? {}) };
      parentId = `${L.prefix}:${L.sid}`;
      parentSpanId = spanId(parentId, 'wf', L.runId!);
    }
    const cwd = this.cwd ?? this.inheritedCwd;
    return {
      rec: 'session', id: L.session, agent: L.agent, nativeId: L.agentId ? `${L.sid}/${L.agentId}` : L.sid, role: L.role,
      parentId, parentSpanId, title: this.title(), cwd, project: projectOf(cwd), git: this.branch ? { branch: this.branch } : undefined,
      models: this.models.length ? this.models : undefined, version: this.version, entrypoint: this.entrypoint, meta,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function textAttrs(text: unknown): Attrs {
  if (typeof text !== 'string' || !text) return {};
  return { text: truncate(text, INDEX_TEXT_MAX), text_len: text.length };
}

function withTruncated(flags: EventFlag[], text: string): EventFlag[] {
  return text.length > INDEX_TEXT_MAX ? [...flags, 'truncated'] : [...flags];
}

function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1].trim() : undefined;
}

function stripTags(text: string): string {
  return text.replace(/<\/?[a-z][a-z0-9_-]*>/gi, ' ');
}

/**
 * `<task-notification>` text: completion of a background agent or task. A workflow's notification ends with
 * `<failures>`, one `[label] failed: …` line per failed agent: `task.failed_agents` keeps the labels, which the
 * truncated text can lose.
 */
function taskNotification(text: string): { kind: EventKind; actor: Actor; summary: string; attrs: Attrs & { task?: Record<string, unknown> } } {
  const status = tag(text, 'status');
  const failed = [...(tag(text, 'failures') ?? '').matchAll(/^\[([^\]\n]+)\] failed\b/gm)].map((m) => m[1]);
  const summary = tag(text, 'summary');
  const usage = tag(text, 'usage') ?? '';
  const field = (k: string) => {
    const m = new RegExp(`${k}\\D{0,3}(\\d+)`).exec(usage);
    return m ? Number(m[1]) : undefined;
  };
  const attrs: Attrs & { task?: Record<string, unknown> } = {
    agent: { id: tag(text, 'task-id'), status },
    task: {
      output_file: tag(text, 'output-file'), total_tokens: field('total_tokens'), tool_uses: field('tool_uses'), duration_ms: field('duration_ms'),
      ...(failed.length ? { failed_agents: failed } : {}),
    },
  };
  const toolUseId = tag(text, 'tool-use-id');
  if (toolUseId) attrs.tool = { call_id: toolUseId };
  return { kind: 'agent.status', actor: 'harness', summary: `task ${status ?? 'notification'}${summary ? ': ' + oneLine(summary, 140) : ''}`, attrs };
}

function base64Bytes(data: unknown): number {
  return typeof data === 'string' ? Math.floor((data.length * 3) / 4) : 0;
}

function mediaInfo(b: Obj): { media_type?: string; bytes: number; source?: string } {
  const s = b?.source ?? {};
  return { media_type: s.media_type, bytes: base64Bytes(s.data), source: s.type };
}

/** Model-facing text of a tool_result content (string or list of blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return String(b.text ?? '');
      if (b.type === 'image' || b.type === 'document') {
        const m = mediaInfo(b);
        return `[${b.type} ${m.media_type ?? ''} ${fmtBytes(m.bytes)}]`;
      }
      if (b.type === 'tool_reference') return `[tool ${b.tool_name}]`;
      return `[${b.type}]`;
    })
    .join('\n');
}

function attachmentText(a: Obj, o: Obj): string | undefined {
  for (const v of [a.content, a.text, a.prompt, a.snippet]) if (typeof v === 'string' && v) return v;
  if (Array.isArray(a.content)) return resultText(a.content);
  if (Array.isArray(a.systemPrompt)) return a.systemPrompt.filter((s: unknown) => typeof s === 'string').join('\n');
  const rendered = Array.isArray(o.rendered) ? o.rendered.map((r: any) => r?.content).filter((c: unknown) => typeof c === 'string') : [];
  return rendered.length ? rendered.join('\n') : undefined;
}

function attachmentSummary(type: string, a: Obj, text: string | undefined): string {
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (type) {
    case 'deferred_tools_record':
      return `deferred tools  ${count(a.entries)}`;
    case 'deferred_tools_delta':
      return `deferred tools  +${count(a.addedNames)} −${count(a.removedNames)}`;
    case 'prompt_snapshot':
      return `prompt snapshot  ${fmtChars(text?.length ?? 0)} system prompt, ${count(a.tools)} tools`;
    case 'skill_listing':
      return `skills  ${a.skillCount ?? count(a.names)}`;
    case 'instructions':
      return `instructions  ${count(a.files)} file${count(a.files) === 1 ? '' : 's'}`;
    case 'environment':
      return `environment  ${[a.snapshot?.platform, a.snapshot?.shell, a.snapshot?.workingDirectory].filter(Boolean).join('  ')}`;
    case 'model':
      return `model  ${a.identity?.modelId ?? ''}`;
    case 'date':
      return `date  ${a.date ?? ''}`;
    case 'edited_text_file':
    case 'file':
    case 'compact_file_reference':
    case 'pdf_reference':
      return `${type}  ${a.filename ?? a.displayPath ?? ''}`;
    case 'queued_command':
      return `queued ${a.commandMode ?? 'command'}: ${oneLine(text, 140)}`;
    case 'task_status':
      return `task ${a.status ?? ''}: ${oneLine(a.description, 140)}`;
    case 'goal_status':
      return `goal ${a.met ? 'met' : 'not met'}${a.durationMs !== undefined ? ' (' + fmtDur(msToUs(a.durationMs)) + ')' : ''}`;
    default:
      return text ? `${type}  ${oneLine(text, 140)}` : type;
  }
}

/** A successful result of a handback call (HANDBACK_TOOLS). */
function handback(d: Draft, calls: Map<string, Call>): boolean {
  const id = d.kind === 'tool.result' ? d.attrs.tool?.call_id : undefined;
  return typeof id === 'string' && HANDBACK_TOOLS.has(calls.get(id)?.name ?? '') && !d.attrs.tool?.is_error;
}

function turnName(d: Draft): string {
  const text = d.kind === 'user.prompt' && typeof d.attrs.text === 'string' ? d.attrs.text : d.summary;
  return oneLine(text, 80) || d.kind;
}

function claudeTokens(u: Obj | undefined): TokenUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown) => num(v) ?? 0;
  const uncached = n(u.input_tokens);
  const read = n(u.cache_read_input_tokens);
  const write = n(u.cache_creation_input_tokens);
  const output = n(u.output_tokens);
  const t: TokenUsage = { input: uncached + read + write, uncached, cache_read: read, cache_write: write, output, total: uncached + read + write + output };
  const thinking = num(u.output_tokens_details?.thinking_tokens);
  if (thinking !== undefined) t.reasoning = thinking;
  return t;
}

/** DESIGN.md §9 Event Summary: "exit 1 · 11 B · 160ms · Exit code 1": the status, the size, the time, then the error text. */
function resultSummary(r: Draft, call: Call | undefined, dur: number | undefined): string {
  const t = r.attrs.tool ?? {};
  const a = r.attrs.agent;
  const parts: (string | false | undefined)[] = [];
  if (!call) parts.push('no call');
  if (t.status === 'interrupted') parts.push('interrupted');
  else if (t.status === 'rejected' || r.attrs.permission?.decision === 'deny' || r.attrs.permission?.decision === 'reject') parts.push('denied', r.attrs.permission?.reason);
  else if (call && AGENT_TOOLS.has(call.name) && a?.id) {
    if (t.status === 'async_launched') parts.push(`launched ${a.type ?? 'agent'} ${a.id}`, 'async');
    else parts.push(`${a.type ?? 'agent'} ${t.status ?? 'done'}`, a.tool_uses !== undefined && `${a.tool_uses} tools`, typeof a.total_tokens === 'number' && `${fmtTok(a.total_tokens)} tokens`);
  } else if (call?.name === 'Workflow' && t.run_id) parts.push(`launched ${t.run_id}`);
  else if (typeof t.exit_code === 'number') parts.push(`exit ${t.exit_code}`);
  else if (t.status === 'backgrounded') parts.push(`background ${t.background_task_id ?? ''}`.trim());
  else if (typeof t.status === 'string' && call?.name === 'Bash') parts.push(t.status);
  const error = t.is_error && t.status !== 'interrupted';
  if (error && !parts.some(Boolean)) parts.push('error');
  if (typeof t.output_len === 'number') parts.push(fmtBytes(t.output_len));
  if (dur !== undefined) parts.push(fmtDur(dur));
  if (error) parts.push(oneLine(String(t.output ?? ''), 100));
  return parts.filter(Boolean).join(' · ');
}

function runStatus(s: unknown): SpanStatus {
  if (s === 'completed') return 'ok';
  if (s === 'failed') return 'error';
  if (s === 'killed' || s === 'cancelled') return 'cancelled';
  if (s === 'running') return 'open';
  return 'unknown';
}

function phaseStatus(agents: Obj[]): SpanStatus {
  const states = agents.map((a) => String(a.state ?? ''));
  if (states.some((s) => s === 'failed' || s === 'error')) return 'error';
  if (states.some((s) => s === 'running' || s === 'queued' || s === 'started')) return 'open';
  if (states.some((s) => s === 'killed' || s === 'cancelled')) return 'cancelled';
  return 'ok';
}

/** Git root or cwd basename; worktrees map to their repository and Cowork sandboxes to 'cowork'. */
function projectOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (cwd.startsWith('/sessions/') || cwd.includes('/local-agent-mode-sessions/')) return 'cowork';
  const wt = /^(.*?)\/\.(?:claude\/)?worktrees\//.exec(cwd);
  return basename(wt ? wt[1] : cwd.replace(/\/+$/, '')) || cwd;
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function fmtChars(n: number): string {
  return `${fmtTok(n)} chars`;
}
