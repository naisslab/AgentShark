// Execution of one planned call (docs/REPLAY.md §4.4). Shell calls run in the sandbox's shell. File tools are the
// harness's own logic, so they run here and touch the sandbox only through cat, test, mkdir and rm.

import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';
import type { ExecResult, Executor } from './executor.ts';
import { applyChunks, PatchError, parsePatch } from './patch.ts';
import type { Action, PlannedCall } from './plan.ts';
import { programsOf } from './shell.ts';

export type RunAction = Exclude<Action, { cls: 'skip' }>;

export interface Sandbox {
  exec: Executor;
  shell: 'bash' | 'sh';
  /** The image has `timeout`, which ends a call's whole process group inside the sandbox. */
  hasTimeout: boolean;
  /** `--timeout`: upper bound on one call. */
  maxTimeoutMs: number;
}

export interface Replayed {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durMs: number;
  stdout: string;
  stderr: string;
  /** Output bytes past KEEP_BYTES per stream, not kept. */
  dropped: number;
}

/** Shell output kept per stream; a longer output is compared by its head only (§6). */
const KEEP_BYTES = 8 << 20;

/** Create the state folder and find the shell and `timeout`, in one call (§4.1). */
export async function openSandbox(exec: Executor, maxTimeoutMs: number): Promise<Sandbox> {
  const script = 'mkdir -p "$1" || exit 1; for c in bash timeout; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done; true';
  const r = await exec.exec(['sh', '-c', script, 'sh', exec.stateDir]);
  if (r.exitCode !== 0) throw new Error(`cannot prepare the sandbox: ${stderrOf(r) || `exit ${r.exitCode}`}`);
  const found = new Set(r.stdout.toString('utf8').split('\n'));
  return { exec, shell: found.has('bash') ? 'bash' : 'sh', hasTimeout: found.has('timeout'), maxTimeoutMs };
}

/**
 * Runs a command in a working directory. With a state file (Claude Bash), the previous call's final directory is
 * restored first and an EXIT trap saves this call's final directory, however the command ends. Positional parameters
 * are cleared, so the command sees none of the wrapper's.
 */
const WRAPPER = `__cmd=$1; __wd=$2; __state=$3; set --
__dir=$__wd
if [ -n "$__state" ]; then
  if [ -s "$__state" ]; then __dir=$(cat "$__state"); fi
  trap 'pwd > "$__state"' EXIT
fi
cd -- "$__dir" 2>/dev/null || cd -- "$__wd" || exit 1
eval "$__cmd" </dev/null`;

/** Paths are absolute, so `dirname` needs no `--` (BusyBox's does not accept it). */
const WRITE = 'mkdir -p "$(dirname "$1")" && cat > "$1"';

/** The longest a call may run: its own timeout capped by `--timeout`; file tools have no timeout of their own. */
export function callTimeoutMs(a: RunAction, maxTimeoutMs: number): number {
  return a.cls === 'shell' || a.cls === 'shell-bg' ? Math.min(a.timeoutMs ?? maxTimeoutMs, maxTimeoutMs) : maxTimeoutMs;
}

export async function execute(a: RunAction, session: string, sb: Sandbox): Promise<Replayed> {
  if (a.cls === 'shell' || a.cls === 'shell-bg') return shell(a, session, sb);
  const t0 = performance.now();
  const error = await fileTool(a, sb);
  return { ok: error === null, exitCode: null, timedOut: false, durMs: performance.now() - t0, stdout: '', stderr: error ?? '', dropped: 0 };
}

async function shell(a: Extract<Action, { cls: 'shell' | 'shell-bg' }>, session: string, sb: Sandbox): Promise<Replayed> {
  const state = a.keepCwd ? `${sb.exec.stateDir}/${createHash('sha1').update(session).digest('hex').slice(0, 16)}.cwd` : '';
  const argv = [sb.shell, '-c', WRAPPER, 'agentshark-replay', a.script, a.workdir, state];
  const timeoutMs = callTimeoutMs(a, sb.maxTimeoutMs);
  const limited = sb.hasTimeout ? ['timeout', '-k', '5', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ...argv] : argv;
  const r = a.cls === 'shell-bg' ? await sb.exec.start(argv) : await sb.exec.exec(limited, { timeoutMs, maxBytes: KEEP_BYTES });
  // GNU timeout exits 124; BusyBox's ends the command with SIGTERM (143) or, after the grace period, SIGKILL (137).
  const expired = r.exitCode === 124 || ((r.exitCode === 143 || r.exitCode === 137) && r.durMs >= timeoutMs);
  return {
    ok: r.exitCode === 0, exitCode: r.exitCode, timedOut: r.timedOut || (sb.hasTimeout && a.cls === 'shell' && expired), durMs: r.durMs,
    stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), dropped: r.dropped,
  };
}

/** A file tool's error message, or null when it succeeded. */
async function fileTool(a: Exclude<RunAction, { cls: 'shell' | 'shell-bg' }>, sb: Sandbox): Promise<string | null> {
  switch (a.cls) {
    case 'read': {
      const r = await sb.exec.exec(['sh', '-c', 'cat -- "$1" >/dev/null', 'sh', a.path]);
      return r.exitCode === 0 ? null : stderrOf(r) || `cannot read ${a.path}`;
    }
    case 'write':
      return writeFile(sb, a.path, a.content);
    case 'edit':
      return edit(a, sb);
    case 'patch':
      return patch(a, sb);
  }
}

/** Claude Edit and MultiEdit: every edit applies to the result of the previous one, or nothing is written. */
async function edit(a: Extract<Action, { cls: 'edit' }>, sb: Sandbox): Promise<string | null> {
  let text = await readFile(sb, a.path);
  for (const e of a.edits) {
    if (e.old === e.new) return 'old_string and new_string are the same';
    if (e.old === '') {
      // An empty old_string creates the file; Claude Code refuses it when the file already has content.
      if (text) return `cannot create ${a.path}: the file already exists`;
      text = e.new;
      continue;
    }
    if (text === null) return `${a.path} does not exist`;
    const at = text.indexOf(e.old);
    if (at < 0) return `old_string not found in ${a.path}`;
    if (!e.all && text.indexOf(e.old, at + e.old.length) >= 0) return `old_string matches more than once in ${a.path} and replace_all is not set`;
    text = e.all ? text.replaceAll(e.old, () => e.new) : text.slice(0, at) + e.new + text.slice(at + e.old.length);
  }
  return writeFile(sb, a.path, text ?? '');
}

/** Codex apply_patch: every file is computed first, so a failed patch changes nothing. */
async function patch(a: Extract<Action, { cls: 'patch' }>, sb: Sandbox): Promise<string | null> {
  const pending = new Map<string, string | null>();
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(a.base, p));
  try {
    for (const op of parsePatch(a.text)) {
      const p = abs(op.path);
      if (op.type === 'add') pending.set(p, op.content);
      else if (op.type === 'delete') {
        const exists = pending.has(p) ? pending.get(p) !== null : (await sb.exec.exec(['test', '-e', p])).exitCode === 0;
        if (!exists) return `cannot delete ${op.path}: no such file`;
        pending.set(p, null);
      } else {
        const cur = pending.has(p) ? pending.get(p)! : await readFile(sb, p);
        if (cur === null) return `cannot update ${op.path}: no such file`;
        const next = applyChunks(cur, op.chunks, op.path);
        if (op.moveTo) pending.set(p, null);
        pending.set(op.moveTo ? abs(op.moveTo) : p, next);
      }
    }
  } catch (e) {
    if (e instanceof PatchError) return e.message;
    throw e;
  }
  for (const [p, text] of pending) {
    if (text !== null) {
      const error = await writeFile(sb, p, text);
      if (error) return error;
    } else if ((await sb.exec.exec(['rm', '-f', '--', p])).exitCode !== 0) return `cannot delete ${p}`;
  }
  return null;
}

async function readFile(sb: Sandbox, p: string): Promise<string | null> {
  const r = await sb.exec.exec(['cat', '--', p]);
  return r.exitCode === 0 ? r.stdout.toString('utf8') : null;
}

async function writeFile(sb: Sandbox, p: string, text: string): Promise<string | null> {
  const r = await sb.exec.exec(['sh', '-c', WRITE, 'sh', p], { stdin: text });
  return r.exitCode === 0 ? null : stderrOf(r) || `cannot write ${p}`;
}

function stderrOf(r: ExecResult): string {
  return r.stderr.toString('utf8').trim();
}

// ---------------------------------------------------------------------------
// Preflight (§4.1)

/** Programs that the plan's shell calls start and the sandbox lacks, each with the number of calls that start it. */
export async function missingPrograms(calls: PlannedCall[], sb: Sandbox): Promise<{ name: string; calls: number }[]> {
  const uses = new Map<string, number>();
  for (const c of calls) {
    if (c.action.cls !== 'shell' && c.action.cls !== 'shell-bg') continue;
    for (const p of programsOf(c.action.script)) uses.set(p, (uses.get(p) ?? 0) + 1);
  }
  if (!uses.size) return [];
  const script = 'for c in "$@"; do command -v "$c" >/dev/null 2>&1 || echo "$c"; done';
  const r = await sb.exec.exec([sb.shell, '-c', script, 'sh', ...uses.keys()]);
  if (r.exitCode !== 0) return [];
  return r.stdout.toString('utf8').split('\n').filter((n) => uses.has(n))
    .map((name) => ({ name, calls: uses.get(name)! })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}
