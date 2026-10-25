// Replay plan (docs/REPLAY.md §3, §5): one session and its subagents → ordered, batched, classified tool calls with
// full inputs, recorded results and the waits that reproduce the recorded pacing. Reads the index and raw records only.

import { posix as path } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fromFileUri, shellArgvScript, toolKind, tryJson } from '../adapters/adapter.ts';
import { stripWrappers } from '../index/derive/signature.ts';
import { patchFiles } from '../index/derive/target.ts';
import { readLiveLine } from '../index/queries.ts';
import { FLAG_BITS } from '../model/types.ts';

export type CallClass = 'shell' | 'shell-bg' | 'read' | 'write' | 'edit' | 'patch' | 'skip';
export type SkipReason = 'search' | 'external' | 'harness' | 'process' | 'script' | 'notebook' | 'rejected' | 'input-truncated' | 'unsupported';

interface ShellInput {
  script: string;
  workdir: string;
  timeoutMs: number | null;
  /** Claude Bash: the working directory carries over to the session's next call. */
  keepCwd: boolean;
}

export type Action =
  | ({ cls: 'shell' } & ShellInput)
  | ({ cls: 'shell-bg' } & ShellInput)
  | { cls: 'read'; path: string }
  | { cls: 'write'; path: string; content: string }
  | { cls: 'edit'; path: string; edits: { old: string; new: string; all: boolean }[] }
  | { cls: 'patch'; text: string; base: string }
  | { cls: 'skip'; reason: SkipReason };

export interface RecordedResult {
  ok: boolean;
  exitCode: number | null;
  /** What the command printed, harness wrappers removed: all of it, or only its head when `cut`. */
  output: string | null;
  /** When `cut`, the end of the output (null when the index kept none). */
  outputTail: string | null;
  cut: boolean;
  outputLen: number | null;
  endTs: number;
  durUs: number;
}

export interface PlannedCall {
  /** 1-based position in the plan. */
  n: number;
  event: string;
  session: string;
  /** 1-based batch number; calls of one batch run concurrently. */
  batch: number;
  ts: number;
  tool: string;
  action: Action;
  inputSrc: 'raw' | 'index' | null;
  summary: string;
  recorded: RecordedResult | null;
  /** Wait before this call's batch starts (first call of a batch only), recorded µs, unscaled. */
  gapUs: number;
  /** A skipped call holds its slot this long, recorded µs, unscaled. */
  holdUs: number;
}

export interface ReplayPlan {
  session: string;
  agent: string;
  cwd: string;
  gitCommit: string | null;
  /** `/Users/<name>` or `/home/<name>` when the cwd lies under one (§4.2). */
  home: string | null;
  sessions: string[];
  calls: PlannedCall[];
}

export class PlanError extends Error {}

const HIDDEN = FLAG_BITS.inherited | FLAG_BITS.dup;
const ERR = FLAG_BITS.error;
const INFERRED = FLAG_BITS.inferred;
const CLAUDE_BASH_TIMEOUT_MS = 120_000;
/** Raw records read at once while planning. */
const READ_CONCURRENCY = 16;
/** Logged Claude streams up to this size are compared whole; longer ones by head and tail like index copies. */
const STREAMS_MAX = 1 << 20;
const HEAD_CHARS = 4096;
const TAIL_CHARS = 2048;

const SEARCH = new Set(['Glob', 'Grep', 'LS', 'view_image']);
const PROCESS = new Set(['BashOutput', 'KillShell', 'KillBash', 'TaskOutput', 'TaskStop', 'Monitor', 'write_stdin']);
/** Tools the harness answers itself (questions, scheduling, waiting, tool loading, goals); they never reach the environment. */
const HARNESS = new Set([
  'AskUserQuestion', 'ExitPlanMode', 'StructuredOutput', 'ToolSearch', 'Skill', 'ScheduleWakeup', 'CronCreate', 'CronDelete',
  'CronList', 'SendUserFile', 'SubagentHandback', 'request_user_input', 'request_user_input_async', 'get_goal', 'update_goal', 'sleep',
]);
/** Tools that publish to or read from a service outside the container. */
const EXTERNAL = new Set(['Artifact', 'ArtifactData', 'ArtifactComments', 'PushNotification', 'RemoteTrigger', 'image_gen']);
const NOTEBOOK = new Set(['NotebookEdit', 'NotebookRead']);
const SHELL_TOOLS = new Set(['exec_command', 'shell_command', 'shell', 'local_shell']);
const EXECUTABLE = new Set(['Bash', 'apply_patch', 'Read', 'Write', 'Edit', 'MultiEdit', ...SHELL_TOOLS]);

/** The session whose id is `ref`, or the one session whose id starts with `ref`. */
export function resolveSession(db: DatabaseSync, ref: string): string {
  const exact = db.prepare('SELECT id FROM sessions WHERE id = ?').get(ref) as { id: string } | undefined;
  if (exact) return exact.id;
  const rows = db.prepare('SELECT id FROM sessions WHERE substr(id, 1, length(?)) = ? ORDER BY id LIMIT 3').all(ref, ref) as { id: string }[];
  if (rows.length === 1) return rows[0].id;
  if (!rows.length) throw new PlanError(`no session ${ref} in the index`);
  throw new PlanError(`${ref} matches several sessions (${rows.map((r) => r.id).join(', ')}, ...); give more of the id`);
}

interface EventRow {
  id: string;
  session_id: string;
  ts: number;
  kind: string;
  span_id: string | null;
  tool_name: string | null;
  flag_bits: number;
  dur: number | null;
  src_id: string;
  src_line: number | null;
  src_off: number | null;
  src_len: number | null;
  src_block: number | null;
  src_path: string | null;
  attrs: string | null;
}

/** An event row with its attrs parsed and, for a nested item, its start (§3.1). */
interface Row extends EventRow {
  a: Record<string, any>;
  start: number;
}

/** Reads one event's raw record: the source line in live mode, the stored line in capture mode. */
type RawReader = (r: EventRow) => Promise<any>;

type Planned = { action: Action; inputSrc: 'raw' | 'index' | null };
const skip = (reason: SkipReason): Planned => ({ action: { cls: 'skip', reason }, inputSrc: null });

export async function planReplay(db: DatabaseSync, mode: 'live' | 'capture', sessionId: string): Promise<ReplayPlan> {
  const s = db.prepare('SELECT id, agent, cwd, git_commit FROM sessions WHERE id = ?').get(sessionId) as Record<string, string | null> | undefined;
  if (!s) throw new PlanError(`no session ${sessionId} in the index`);
  const cwd = s.cwd;
  if (!cwd) throw new PlanError(`session ${sessionId} records no working directory, so its paths cannot be placed`);
  const tree = db.prepare(`WITH RECURSIVE d(id) AS (SELECT ? UNION SELECT s.id FROM sessions s JOIN d ON s.parent_id = d.id)
    SELECT s.id, s.parent_span_id FROM sessions s JOIN d ON d.id = s.id`).all(sessionId) as { id: string; parent_span_id: string | null }[];
  const sessions = [sessionId, ...tree.map((r) => r.id).filter((id) => id !== sessionId)];
  const spawning = new Set(tree.map((r) => r.parent_span_id).filter((x): x is string => !!x));

  const rows = (db.prepare(`SELECT e.id, e.session_id, e.ts, e.kind, e.span_id, e.tool_name, e.flag_bits, e.dur,
      e.src_id, e.src_line, e.src_off, e.src_len, e.src_block, src.path AS src_path, p.attrs
    FROM events e LEFT JOIN event_payload p ON p.rid = e.rid LEFT JOIN sources src ON src.id = e.src_id
    WHERE e.session_id IN (SELECT value FROM json_each(?)) AND e.kind IN ('tool.call', 'tool.result', 'tool.exec') AND (e.flag_bits & ${HIDDEN}) = 0
    ORDER BY e.ts, e.session_id, e.seq, e.rid`).all(JSON.stringify(sessions)) as unknown as EventRow[])
    .map((r): Row => ({ ...r, a: parse(r.attrs), start: r.ts }))
    // Of the execution items, only those a code-mode script ran (§3.6); the others mirror a call already planned.
    .filter((r) => r.kind !== 'tool.exec' || typeof r.a.tool?.parent_call_id === 'string');
  const key = (r: Row, callId: unknown) => `${r.session_id}#${callId}`;
  // A nested item is logged when it completes; it takes its place by its start, never before its script.
  const callTs = new Map(rows.filter((r) => r.kind === 'tool.call').map((r) => [key(r, r.a.tool?.call_id), r.ts]));
  for (const r of rows) {
    if (r.kind === 'tool.exec') r.start = Math.max(r.dur ? r.ts - r.dur : r.ts, callTs.get(key(r, r.a.tool.parent_call_id)) ?? -Infinity);
  }
  rows.sort((x, y) => x.start - y.start);

  const results = new Map<string, Row>();
  // Scripts whose nested items are in the plan: those items account for the script's time.
  const scripts = new Set<string>();
  for (const r of rows) {
    if (r.kind === 'tool.result') results.set(pairKey(r), r);
    if (r.kind === 'tool.exec') scripts.add(key(r, r.a.tool.parent_call_id));
  }

  // Batches (§3.2): a call joins its session's open batch, or the batch of an earlier call from the same model message.
  // A nested item joins the batch of an earlier item of its script that was still running (the script awaited them
  // together); otherwise it starts a batch of its own.
  const open = new Map<string, { batch: number; msgId: string | null; open: boolean }>();
  const running = new Map<string, { batch: number; script: string; end: number }>();
  const drafts: { r: Row; res: Row | null; batch: number }[] = [];
  let batches = 0;
  for (const r of rows) {
    let o = open.get(r.session_id);
    if (r.kind === 'tool.result') {
      if (o) o.open = false;
      continue;
    }
    if (r.kind === 'tool.exec') {
      const script = key(r, r.a.tool.parent_call_id);
      let n = running.get(r.session_id);
      if (!n || n.script !== script || r.start >= n.end) running.set(r.session_id, (n = { batch: ++batches, script, end: r.ts }));
      n.end = Math.max(n.end, r.ts);
      drafts.push({ r, res: r, batch: n.batch });
      if (o) o.open = false;
      continue;
    }
    running.delete(r.session_id);
    const msgId = r.a.llm?.message_id ?? null;
    if (!o || !(o.open || (msgId !== null && o.msgId === msgId))) {
      o = { batch: ++batches, msgId, open: true };
      open.set(r.session_id, o);
    }
    o.open = true;
    drafts.push({ r, res: results.get(pairKey(r)) ?? null, batch: o.batch });
  }

  const raw = rawReader(db, mode);
  const calls = await mapLimit(drafts, READ_CONCURRENCY, async ({ r, res, batch }): Promise<PlannedCall> => {
    const attrs = r.a;
    const resAttrs = res?.a ?? {};
    const nested = r.kind === 'tool.exec';
    const item = nested ? (await raw(r))?.payload?.item : undefined;
    const { action, inputSrc } = nested ? nestedAction(r, item, cwd) : await actionOf(r, attrs, resAttrs, cwd, raw);
    const streams = nested ? itemOutput(item) : res && action.cls === 'shell' && attrs.tool?.name === 'Bash' ? toolUseResult(await raw(res)) : undefined;
    const recorded = res ? recordedResult(r, res, resAttrs, streams) : null;
    // A skipped call holds its slot unless calls in the plan account for its time: a subagent's, or a script's nested items.
    const covered = (r.span_id !== null && spawning.has(r.span_id)) || scripts.has(key(r, attrs.tool?.call_id));
    return {
      n: 0, event: r.id, session: r.session_id, batch, ts: r.start, tool: attrs.tool?.name ?? r.tool_name ?? '?', action, inputSrc,
      summary: summaryOf(action, attrs, cwd), recorded, gapUs: 0,
      holdUs: action.cls === 'skip' && !covered ? recorded?.durUs ?? 0 : 0,
    };
  });
  calls.sort((a, b) => a.batch - b.batch || a.ts - b.ts);
  calls.forEach((c, i) => (c.n = i + 1));

  // Gaps (§5): from the latest recorded end of the previous batch to the first call of this one. A call the replay does
  // not wait for ends where it starts: a background call, or a skipped call that holds no time because the calls of its
  // subagent or script, which follow it, account for the rest.
  const endOf = (c: PlannedCall) => (c.action.cls === 'shell-bg' || (c.action.cls === 'skip' && c.holdUs === 0) ? c.ts : c.recorded?.endTs ?? c.ts);
  let prevEnd: number | null = null;
  for (const b of batchesOf(calls)) {
    b[0].gapUs = prevEnd === null ? 0 : Math.max(0, b[0].ts - prevEnd);
    prevEnd = Math.max(...b.map(endOf));
  }

  const home = /^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/.exec(cwd)?.[1] ?? null;
  return { session: sessionId, agent: s.agent!, cwd, gitCommit: s.git_commit, home, sessions, calls };
}

/** Consecutive calls of one batch. */
export function batchesOf(calls: PlannedCall[]): PlannedCall[][] {
  const out: PlannedCall[][] = [];
  for (const c of calls) {
    if (out.at(-1)?.[0].batch === c.batch) out.at(-1)!.push(c);
    else out.push([c]);
  }
  return out;
}

function pairKey(r: Row): string {
  return r.span_id ?? `${r.session_id}#${r.a.tool?.call_id}`;
}

function parse(json: string | null): Record<string, any> {
  return (tryJson(json) ?? {}) as Record<string, any>;
}

function rawReader(db: DatabaseSync, mode: 'live' | 'capture'): RawReader {
  const stored = db.prepare('SELECT text FROM raw_store WHERE src_id = ? AND line = ?');
  return async (r) => {
    const text = mode === 'capture'
      ? (stored.get(r.src_id, r.src_line ?? 0) as { text: string } | undefined)?.text
      : r.src_path && r.src_len ? await readLiveLine(r.src_path, r.src_line ?? 0, r.src_off ?? 0, r.src_len) : undefined;
    return typeof text === 'string' ? tryJson(text) : undefined;
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Claude's logged stdout and stderr of a result line that holds one tool result, joined by a newline. */
function toolUseResult(rec: any): string | undefined {
  const tur = rec?.toolUseResult;
  if (!tur || typeof tur !== 'object' || rec?.message?.content?.length !== 1 || typeof tur.stdout !== 'string') return undefined;
  return [tur.stdout, tur.stderr].filter((x) => typeof x === 'string' && x).join('\n');
}

/** A Codex CommandExecution item's whole output, stdout and stderr as the process wrote them. */
function itemOutput(item: any): string | undefined {
  return item?.type === 'CommandExecution' && typeof item.aggregated_output === 'string' ? item.aggregated_output : undefined;
}

function recordedResult(call: EventRow, res: EventRow, attrs: Record<string, any>, streams: string | undefined): RecordedResult {
  const t = attrs.tool ?? {};
  const exitCode = typeof t.exit_code === 'number' ? t.exit_code : null;
  return {
    ok: t.is_error !== true && (exitCode ?? 0) === 0 && (res.flag_bits & ERR) === 0,
    exitCode,
    ...recordedOutput(t, streams),
    endTs: res.ts,
    durUs: res.dur ?? call.dur ?? Math.max(0, res.ts - call.ts),
  };
}

/**
 * The recorded output (§6): the logged streams when present (Claude's stdout and stderr, a Codex item's output), which
 * are complete and carry no harness text; otherwise the index copy with its wrappers stripped, cut to a head and a tail
 * when the output was long.
 */
function recordedOutput(t: Record<string, any>, all: string | undefined): Pick<RecordedResult, 'output' | 'outputTail' | 'cut' | 'outputLen'> {
  if (all !== undefined) {
    const cut = all.length > STREAMS_MAX;
    return { output: cut ? all.slice(0, HEAD_CHARS) : all, outputTail: cut ? all.slice(-TAIL_CHARS) : null, cut, outputLen: all.length };
  }
  if (typeof t.output !== 'string') return { output: null, outputTail: null, cut: false, outputLen: null };
  const head = t.output.replace(/…\[\+\d+\]$/, '');
  const len = typeof t.output_len === 'number' ? t.output_len : head.length;
  return { output: stripWrappers(head).text, outputTail: typeof t.output_tail === 'string' ? t.output_tail : null, cut: len > head.length, outputLen: len };
}

// ---------------------------------------------------------------------------
// Inputs and classes (§3.3, §3.5)

async function actionOf(r: EventRow, attrs: Record<string, any>, resAttrs: Record<string, any>, cwd: string, raw: RawReader): Promise<Planned> {
  const name: string = attrs.tool?.name ?? r.tool_name ?? '';
  if (resAttrs.tool?.status === 'rejected' || resAttrs.permission?.decision === 'deny') return skip('rejected');
  const pre = classOf(name, attrs.tool?.kind);
  if (pre) return skip(pre);
  if (!EXECUTABLE.has(name)) return skip('unsupported');

  const full = await fullInput(r, attrs, raw);
  if (full === undefined) return skip('input-truncated');
  const { input, src } = full;
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const ms = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);
  const done = (action: Action): Planned => ({ action, inputSrc: src });

  if (SHELL_TOOLS.has(name)) {
    const script = shellScript(o.cmd ?? o.command);
    if (script === null) return skip('unsupported');
    const wd = str(o.workdir) ?? str(o.working_directory);
    const workdir = wd === null ? cwd : path.isAbsolute(wd) ? wd : path.join(cwd, wd);
    if (/^\s*apply_patch\b/.test(script) && script.includes('*** Begin Patch')) return done({ cls: 'patch', text: script, base: workdir });
    const running = typeof resAttrs.tool?.status === 'string' && resAttrs.tool.status.startsWith('running');
    return done({ cls: running ? 'shell-bg' : 'shell', script, workdir, timeoutMs: ms(o.timeout_ms), keepCwd: false });
  }
  switch (name) {
    case 'Bash': {
      const script = str(o.command);
      if (script === null) return skip('unsupported');
      const bg = o.run_in_background === true || typeof resAttrs.tool?.background_task_id === 'string';
      return done({ cls: bg ? 'shell-bg' : 'shell', script, workdir: cwd, timeoutMs: ms(o.timeout) ?? CLAUDE_BASH_TIMEOUT_MS, keepCwd: !bg });
    }
    case 'apply_patch': {
      const text = typeof input === 'string' ? input : str(o.input) ?? str(o.patch);
      return text === null ? skip('unsupported') : done({ cls: 'patch', text, base: cwd });
    }
    case 'Read': {
      const path = str(o.file_path);
      return path === null ? skip('unsupported') : done({ cls: 'read', path });
    }
    case 'Write': {
      const path = str(o.file_path);
      const content = str(o.content);
      return path === null || content === null ? skip('unsupported') : done({ cls: 'write', path, content });
    }
    default: {
      const path = str(o.file_path);
      const list = name === 'Edit' ? [o] : Array.isArray(o.edits) ? o.edits : [];
      const edits = list.map((e: any) => ({ old: str(e?.old_string), new: str(e?.new_string), all: e?.replace_all === true }));
      const whole = edits.filter((e: { old: string | null; new: string | null }): e is { old: string; new: string; all: boolean } => e.old !== null && e.new !== null);
      return path === null || !edits.length || whole.length !== edits.length ? skip('unsupported') : done({ cls: 'edit', path, edits: whole });
    }
  }
}

/** Skip reason by tool name and kind, or null for a tool that may execute. */
function classOf(name: string, kind: string | undefined): SkipReason | null {
  if (SEARCH.has(name)) return 'search';
  if (PROCESS.has(name)) return 'process';
  if (NOTEBOOK.has(name)) return 'notebook';
  const k = kind ?? toolKind(name);
  // Codex code-mode `exec` scripts and their `wait {cell_id}` continuations (§3.6); a multi-agent `wait` is not one.
  if (k === 'custom') return 'script';
  if (name.startsWith('mcp__') || k === 'mcp' || k === 'web' || EXTERNAL.has(name)) return 'external';
  if (k === 'agent' || k === 'plan' || HARNESS.has(name)) return 'harness';
  return null;
}

/**
 * A nested item of a Codex code-mode script (§3.6): a CommandExecution runs as a shell call, a FileChange applies as a
 * patch. Inputs come from the raw item, or from the index when its copy is intact. Other items are skipped by kind.
 */
function nestedAction(r: Row, item: any, cwd: string): Planned {
  const t = r.a.tool;
  // A command the user declined never ran.
  if (t.status === 'declined') return skip('rejected');
  if (t.name === 'exec_command') {
    let script = shellScript(item?.command);
    let src: 'raw' | 'index' = 'raw';
    if (script === null && typeof t.command === 'string' && !/…\[\+\d+\]$/.test(t.command)) [script, src] = [t.command, 'index'];
    if (script === null) return skip('input-truncated');
    const wd = fromFileUri(item?.cwd) ?? (typeof t.cwd === 'string' ? t.cwd : undefined);
    const workdir = wd === undefined ? cwd : path.isAbsolute(wd) ? wd : path.join(cwd, wd);
    // An inferred item completed after its script returned: a process the script left running. One that a signal ended
    // (exit 129 to 159), such as a server stopped with its session, starts in the background; the others are awaited.
    const signaled = typeof t.exit_code === 'number' && t.exit_code > 128 && t.exit_code < 160;
    const cls = (r.flag_bits & INFERRED) !== 0 && signaled ? 'shell-bg' : 'shell';
    return { action: { cls, script, workdir, timeoutMs: null, keepCwd: false }, inputSrc: src };
  }
  if (t.name === 'apply_patch') {
    const text = fileChangePatch(item?.changes);
    return text === null ? skip('input-truncated') : { action: { cls: 'patch', text, base: cwd }, inputSrc: 'raw' };
  }
  return skip(classOf(String(t.name ?? ''), t.kind) ?? 'unsupported');
}

/**
 * A FileChange item's changes as an apply_patch patch: added files with their content, deleted files, and updates
 * whose unified-diff hunks become patch chunks. Null when a change lacks the text it needs.
 */
export function fileChangePatch(changes: unknown): string | null {
  if (!changes || typeof changes !== 'object') return null;
  const out = ['*** Begin Patch'];
  for (const [key, c] of Object.entries(changes as Record<string, any>)) {
    const type = c?.type ?? Object.keys(c ?? {})[0];
    const body = (c?.type ? c : c?.[type]) ?? {};
    const file = fromFileUri(key) ?? key;
    if (type === 'delete') {
      out.push(`*** Delete File: ${file}`);
    } else if (type === 'add') {
      if (typeof body.content !== 'string') return null;
      const lines = body.content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      out.push(`*** Add File: ${file}`, ...lines.map((l: string) => `+${l}`));
    } else if (type === 'update') {
      if (typeof body.unified_diff !== 'string') return null;
      const move = fromFileUri(body.move_path);
      out.push(`*** Update File: ${file}`, ...(move ? [`*** Move to: ${move}`] : []));
      const lines: string[] = body.unified_diff.split('\n');
      while (lines.at(-1) === '') lines.pop();
      // File headers before the first hunk are dropped, and so are `\ No newline at end of file` markers. A hunk
      // header keeps its line numbers, which tell repeated text apart (patch.ts), and drops its section heading.
      let hunk = false;
      for (const line of lines) {
        if (line.startsWith('@@')) {
          out.push(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line)?.[0] ?? '@@');
          hunk = true;
        } else if (hunk && !line.startsWith('\\')) {
          out.push(line);
        }
      }
      if (!hunk) return null;
    } else {
      return null;
    }
  }
  out.push('*** End Patch');
  return out.length > 2 ? out.join('\n') : null;
}

/** A shell command string; argv of a shell running `-c` becomes its script, other argv is quoted. */
function shellScript(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string')) return null;
  return shellArgvScript(v) ?? v.map(shellQuote).join(' ');
}

/** `s` as one shell word. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The recorded commit as a `--rev` value, or null when the log holds something other than a commit hash. */
export function revOf(plan: ReplayPlan): string | null {
  return plan.gitCommit && /^[0-9a-f]{7,64}$/i.test(plan.gitCommit) ? plan.gitCommit : null;
}

/**
 * The call's input from its raw record, else from the index when the index copy is intact.
 * Undefined when neither holds the complete input.
 */
async function fullInput(r: EventRow, attrs: Record<string, any>, raw: RawReader): Promise<{ input: unknown; src: 'raw' | 'index' } | undefined> {
  const fromRaw = inputInRecord(await raw(r), r.src_block, attrs.tool?.call_id);
  if (fromRaw !== undefined) return { input: fromRaw, src: 'raw' };
  const input = attrs.tool?.input;
  if (input === undefined || /…\[\+\d+\]"|"\$omitted"|"<redacted>"/.test(JSON.stringify(input))) return undefined;
  return { input: typeof input === 'string' ? (tryJson(input) ?? input) : input, src: 'index' };
}

/** The tool input inside one raw record: a Claude tool_use block, or a Codex call payload. */
function inputInRecord(rec: any, block: number | null, callId: string | undefined): unknown {
  const content = rec?.message?.content;
  if (Array.isArray(content)) {
    const b = (block !== null ? content[block] : undefined) ?? content.find((c: any) => c?.type === 'tool_use' && c.id === callId);
    return b?.type === 'tool_use' ? b.input : undefined;
  }
  const p = rec?.payload;
  switch (p?.type) {
    case 'function_call':
      return typeof p.arguments === 'string' ? (tryJson(p.arguments) ?? p.arguments) : p.arguments;
    case 'custom_tool_call':
      return p.input;
    case 'local_shell_call':
      return p.action;
  }
  return undefined;
}

function summaryOf(a: Action, attrs: Record<string, any>, cwd: string): string {
  const rel = (p: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p);
  switch (a.cls) {
    case 'shell':
    case 'shell-bg':
      return a.script.split('\n')[0];
    case 'read':
    case 'write':
    case 'edit':
      return rel(a.path);
    case 'patch':
      return patchFiles(a.text).map(rel).join(', ');
    case 'skip':
      return String(attrs.tool?.input_summary ?? attrs.tool?.command ?? '').split('\n')[0];
  }
}
