// Failure tiers (SPEC §12.3.3): every action with a failure signal gets a row with a tier (failure, suspect, benign,
// deferred), the most specific source, the versioned rule that fired, and its sigv1 signature (SPEC §12.4).

import type { FailureRow, FailureSource, FailureTier, Prov, RuleId } from '../../model/types.ts';
import { FLAG_BITS } from '../../model/types.ts';
import type { Action, Derived } from './model.ts';
import { ships } from './precision.ts';
import { SHELL_INIT_NOISE, sigv1, stripWrappers } from './signature.ts';
import { isCheckRun } from './target.ts';
import type { Ev, Ses } from './tree.ts';

/** Versioned rules of this file; RULES in derive.ts lists them. */
export const FAILURE_RULE_IDS = {
  flag: 'flag@1', inner: 'inner@1', api: 'api@1', policy: 'policy@1', hook: 'hook@1', process: 'process@1',
  traceback: 'traceback@2', 'tests-failed': 'tests-failed@2', 'not-found': 'not-found@1', timeout: 'timeout@3', sandbox: 'sandbox@2',
  benign: 'benign-exit@1', deferred: 'process-running@1',
} as const satisfies Record<string, RuleId>;

const BENIGN_PROGRAMS = new Set(['rg', 'grep', 'egrep', 'pgrep', 'pkill', 'ps', 'test', '[', 'diff', 'cmp', 'which', 'lsof']);
const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell_command', 'write_stdin', 'mcp__workspace__bash']);
const VIEWING = new Set([
  'cat', 'sed', 'grep', 'egrep', 'rg', 'head', 'tail', 'less', 'more', 'bat', 'awk', 'nl', 'wc', 'ls', 'find', 'jq', 'git show', 'git diff', 'git log',
  // Listers: their output is a listing, not a message.
  'ps', 'pgrep', 'lsof', 'du', 'df', 'tree', 'stat',
]);
const POLICY_TEXT = /^(?:patch rejected|exec_command failed: CreateProcess \{ message: \\?"Rejected|The user doesn't want to proceed)|rejected by (?:the )?user|blocked by policy|PreToolUse:\S+ hook (?:error|blocked)|Blocked by (?:a )?hook/i;
const TEST_FAIL = /(?:^|\n)=+ .*\b\d+ (?:failed|errors?)\b.*=+|\bFAILED \((?:failures|errors)=\d+|test result: FAILED|\bTests?:\s+\d+ failed|\*\* TEST FAILED \*\*|\b\d+ failing\b|^# fail [1-9]/m;
const NOT_FOUND = /(?:zsh|bash|sh)(?::\d+)?: (?:command not found: \S+|\S+: command not found)|(?:^|\n)\S+: command not found/;
/**
 * A Python traceback block: the header at the start of a line, then a frame. A header inside a JSON string, a log
 * line's prefix or a quoted list is a report's content.
 */
const TRACEBACK = /^Traceback \(most recent call last\):\n[ \t]+File "/m;
/**
 * A timeout the command reported itself, at the start of a line: curl's error 28 (and its -v trace), Python's
 * TimeoutExpired, a harness's "Command timed out". The same words inside a report, a log line or source code are content.
 */
const TIMEOUT = /^(?:curl: \(28\) |\* (?:Connection|Operation|Resolving) timed out after |(?:subprocess\.)?TimeoutExpired: |Command timed out\b)/m;
const SANDBOX = /Operation not permitted|Sandbox\(Denied/i;
/** The command names a log (a .log, .out or .err file, $…LOG, journalctl, a grep for Traceback): it may print one. */
const NAMES_LOG = /\.(?:log|out|err)\b|\$\{?\w*LOG\w*\b|\bjournalctl\b|\bgrep\b[^|;&]*Traceback/i;
/** The harness, not the command, wrote the output: a denial or a failure to start. */
const HARNESS_ERROR = /Sandbox\(Denied|SandboxDenied|exec_command failed|CreateProcess/;

interface Tier {
  tier: FailureTier;
  source: FailureSource;
  rule: RuleId;
  suspect?: string;
}

export function deriveFailures(d: Derived): void {
  for (const s of d.tree.sessions) {
    const hookErrorTurns = new Set(s.events.filter((e) => e.kind === 'hook.run' && isFlagged(e) && /hook_(non_)?blocking_error$/.test(e.proto)).map((e) => e.turn));
    const denials = s.events.filter((e) => e.kind === 'permission.decision')
      .map((e) => ({ seq: e.seq, tool: e.a.permission?.tool, deny: e.a.permission?.decision === 'deny' || e.a.permission?.granted === false }));
    const ctx = { hookErrorTurns, denials };
    for (const a of d.actions.get(s.id) ?? []) {
      const t = classify(a, ctx);
      if (!t) continue;
      a.status = t.tier === 'failure' || t.tier === 'suspect' ? 'fail' : t.tier === 'benign' ? 'ok' : 'neutral';
      a.failure = failureRow(d, s, a, t);
    }
  }
  // nFail: calls whose result, or one of whose inner items, has a failure-tier row.
  const failedCalls = new Map<string, Set<number>>();
  for (const f of d.failures) {
    if (f.tier !== 'failure' || !f.stepId || f.callRid === null) continue;
    const ev = d.tree.byRid.get(f.callRid);
    const exec = ev?.kind === 'tool.exec' && ev.span ? d.tree.span.get(d.tree.span.get(ev.span)?.parent ?? '') : undefined;
    const callRid = exec?.firstEvent ? d.tree.byId.get(exec.firstEvent)?.rid ?? f.callRid : f.callRid;
    let set = failedCalls.get(f.stepId);
    if (!set) failedCalls.set(f.stepId, (set = new Set()));
    set.add(callRid);
  }
  for (const st of d.steps) st.nFail = failedCalls.get(st.id)?.size ?? 0;
}

interface Ctx {
  hookErrorTurns: Set<string | null>;
  denials: { seq: number; tool: unknown; deny: boolean }[];
}

/** The tier of an action, or null when it carries no failure signal; sets `status` for actions without a row. */
function classify(a: Action, ctx: Ctx): Tier | null {
  const r = a.result;
  if (!r) return null;
  if (a.kind === 'usage') {
    a.status = 'ok';
    return null;
  }
  if (a.kind === 'api') return { tier: 'failure', source: 'api', rule: FAILURE_RULE_IDS.api };
  if (a.kind === 'hook') {
    if (!isFlagged(r)) {
      a.status = 'ok';
      return null;
    }
    // The Stop hook's summary repeats the error its attachment already logged.
    if (r.proto.endsWith('stop_hook_summary') && ctx.hookErrorTurns.has(r.turn)) return null;
    if (r.proto.endsWith('hook_blocking_error')) return { tier: 'failure', source: 'policy', rule: FAILURE_RULE_IDS.policy };
    return { tier: 'failure', source: 'hook', rule: FAILURE_RULE_IDS.hook };
  }
  let base: Tier | null = null;
  if (a.kind === 'item') {
    // Inside a failed code-mode exec, the exec result is the evidence; elsewhere the item's own error is (SPEC: inner).
    if (isFlagged(r)) {
      if (a.parent?.result && isFlagged(a.parent.result)) return null;
      base = { tier: 'failure', source: 'inner', rule: FAILURE_RULE_IDS.inner };
    }
  } else if (isFlagged(r)) {
    if (isPolicy(a, r, ctx)) base = { tier: 'failure', source: 'policy', rule: FAILURE_RULE_IDS.policy };
    else if (a.tool === 'write_stdin' && r.exit !== null && r.exit !== 0) base = { tier: 'failure', source: 'process', rule: FAILURE_RULE_IDS.process };
    else base = { tier: 'failure', source: 'flag', rule: FAILURE_RULE_IDS.flag };
  } else if (a.tool === 'write_stdin' && r.exit !== null && r.exit !== 0) {
    base = { tier: 'failure', source: 'process', rule: FAILURE_RULE_IDS.process };
  }
  const running = isRunning(r);
  if (base) {
    if (running) return { tier: 'deferred', source: base.source, rule: FAILURE_RULE_IDS.deferred };
    if (isBenign(a, r)) return { tier: 'benign', source: base.source, rule: FAILURE_RULE_IDS.benign };
    return base;
  }
  const rule = shellish(a, r) ? suspectRule(a, r) : null;
  if (rule) return running ? { tier: 'deferred', source: 'text', rule: FAILURE_RULE_IDS.deferred } : { tier: 'suspect', source: 'text', rule: FAILURE_RULE_IDS[rule], suspect: rule };
  // A result that leaves a process running, or a code-mode script (its items are the real calls), closes nothing.
  a.status = running || (a.tool === 'exec' && a.kind === 'tool' && a.key !== 'tool:exec') ? 'neutral' : 'ok';
  return null;
}

function isPolicy(a: Action, r: Ev, ctx: Ctx): boolean {
  const t = r.a.tool;
  if (r.a.permission?.decision === 'deny' || t?.status === 'rejected') return true;
  if (POLICY_TEXT.test(head(r).slice(0, 400))) return true;
  // Cowork logs the denial as a permission decision before the tool result.
  let last: { deny: boolean } | undefined;
  for (const p of ctx.denials) if (p.seq < r.seq && p.tool === a.tool) last = p;
  return last?.deny === true;
}

/** "Process running with session ID N": the outcome arrives on a later poll (SPEC §12.3.3 deferred). */
function isRunning(r: Ev): boolean {
  const st = r.a.tool?.status;
  return (typeof st === 'string' && st.startsWith('running (session ')) || /^(?:[^\n]*\n){0,4}Process running with session ID \d+/.test(head(r).slice(0, 400));
}

/** Exit 1 with empty output from a program whose exit 1 means "no match" or "false" (SPEC §12.3.3 benign). */
function isBenign(a: Action, r: Ev): boolean {
  if (!a.key.startsWith('sh:')) return false;
  const s = stripWrappers(head(r));
  if ((r.exit ?? s.exitCode) !== 1 || s.text.trim() || tail(r)) return false;
  const prog = a.key.slice(3);
  if (BENIGN_PROGRAMS.has(prog)) return true;
  if (prog === 'command') return /\bcommand\s+-v\b/.test(a.input);
  if (prog === 'git diff') return /--quiet\b/.test(a.input);
  return false;
}

/** A shell command: a shell tool call, or a Codex code-mode exec_command item. */
export function shellish(a: Action, r: Ev): boolean {
  return a.kind === 'item' ? a.tool === 'exec_command' : r.toolKind === 'shell' || SHELL_TOOLS.has(a.tool ?? '');
}

/** The first suspect rule, in this order, that fires on an unflagged shell result's head and tail. */
function suspectRule(a: Action, r: Ev): 'traceback' | 'tests-failed' | 'not-found' | 'timeout' | 'sandbox' | null {
  const text = tail(r) ? `${head(r)}\n${tail(r)}` : head(r);
  if (!text) return null;
  const prog = a.key.startsWith('sh:') ? a.key.slice(3) : null;
  // Output that may be a file's content: a viewer's, a poll of one (`tail -f`, a read: process), or that of any
  // command that names a log.
  const content = isViewing(a.key.replace(/^proc:/, '')) || NAMES_LOG.test(a.input);
  if (!content && TRACEBACK.test(text)) return 'traceback';
  if (isCheckRun('test', a.key, a.input) && TEST_FAIL.test(text)) return 'tests-failed';
  if (NOT_FOUND.test(text) && !/\b(which|command -v|type)\b/.test(a.input) && prog !== 'which' && prog !== 'command') return 'not-found';
  if (!content && TIMEOUT.test(text)) return 'timeout';
  // A file view that the sandbox denied exits non-zero, so sandbox words in an ok read: are content.
  if (ships(FAILURE_RULE_IDS.sandbox) && !a.key.startsWith('read:') && SANDBOX.test(text.replace(SHELL_INIT_NOISE, ''))) return 'sandbox';
  return null;
}

/**
 * The target key starts with a file viewer or lister, so its output is file content: a `read:` key, or cat, sed, rg,
 * ls, ..., also as the remote program of `ssh <host> <program>`.
 */
function isViewing(key: string): boolean {
  if (key.startsWith('read:')) return true;
  if (!key.startsWith('sh:')) return false;
  const prog = key.startsWith('sh:ssh ') ? key.slice(3).split(' ').slice(2).join(' ') : key.slice(3);
  return prog.startsWith('read:') || VIEWING.has(prog);
}

function failureRow(d: Derived, s: Ses, a: Action, t: Tier): FailureRow {
  const ev = a.result!;
  // The program alone (`rg`, `python`), not its arguments: rule (f) names it.
  const program = a.key.startsWith('sh:') ? a.key.slice(3).split(' ')[0] : a.key.startsWith('read:') ? 'read' : a.tool ?? a.key.split(':')[0];
  const err = ev.a.error;
  const api = a.kind === 'api' ? { type: str(err?.type) ?? (ev.kind === 'llm.refusal' ? 'refusal' : undefined), message: str(err?.message) ?? str(ev.a.text) ?? undefined } : null;
  const sig = sigv1({ head: a.kind === 'hook' ? hookText(ev) : head(ev), tail: tail(ev), program, exitCode: ev.exit, api, source: t.source, suspect: t.suspect ?? null,
    viewer: shellish(a, ev) && isViewing(a.key) && t.source !== 'policy' && !HARNESS_ERROR.test(head(ev).slice(0, 300)), fixed: a.kind === 'hook' && ev.proto.endsWith('hook_blocking_error') ? hookBlocked(ev) : null });
  if (!d.sigs.has(sig.id)) d.sigs.set(sig.id, { text: sig.text, family: sig.family, class: sig.class });
  const exit = exitOf(a, ev);
  const row: FailureRow = {
    rid: ev.rid, sessionId: s.id, turnId: a.turn, stepId: a.step?.id ?? null, callRid: a.kind === 'tool' || a.kind === 'item' ? a.call?.rid ?? null : null,
    ts: ev.ts, tier: t.tier, source: t.source, rule: t.rule, family: sig.family, class: sig.class, sigId: sig.id, targetKey: a.key,
    exitCode: exit.code, exitSrc: exit.src, errorLine: sig.line, episodeId: null, attempt: null,
  };
  d.failures.push(row);
  return row;
}

function exitOf(a: Action, ev: Ev): { code: number | null; src: Prov | null } {
  if (a.kind === 'hook') {
    const c = ev.a.hook?.exit_code;
    return typeof c === 'number' ? { code: c, src: 'logged:hook.exit_code' } : { code: null, src: null };
  }
  if (ev.exit === null) {
    const parsed = stripWrappers(head(ev)).exitCode;
    return parsed === null ? { code: null, src: null } : { code: parsed, src: 'parsed:exit-line' };
  }
  if (a.kind === 'item') return { code: ev.exit, src: 'logged:tool.exit_code' };
  return { code: ev.exit, src: /^(?:Chunk ID|Exit code|Process exited|Wall time)/.test(head(ev)) ? 'parsed:exit-line' : 'logged:tool.exit_code' };
}

export function isFlagged(e: Ev): boolean {
  return (e.flags & FLAG_BITS.error) !== 0;
}

function head(e: Ev): string {
  return str(e.a.tool?.output) ?? '';
}

function tail(e: Ev): string | null {
  return str(e.a.tool?.output_tail);
}

/** A Stop hook's blocking reason is free prose: the signature names the hook instead. */
function hookBlocked(e: Ev): string {
  const command = str(e.a.hook?.command) ?? str(e.a.hook?.name) ?? '?';
  return `${str(e.a.hook?.event) ?? 'hook'} hook blocked [${command.split(/\s+/)[0].split('/').pop()}]`;
}

function hookText(e: Ev): string {
  return str(e.a.text) ?? str(e.a.hook?.stderr) ?? str(e.a.hook?.output) ?? `${e.a.hook?.event ?? 'hook'} hook failed`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
