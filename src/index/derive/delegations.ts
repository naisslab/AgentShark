// Delegations (SPEC §12.3.7): one row per spawn, its outcome from the first source available, whether the parent was
// told of a child's failure, and `masked` on the parent turn when the child failed. Children are processed before their
// parents.

import { BLOCKED_FAMILIES, type DelegationKind, type DelegationOutcome, type DelegationRow, type Prov, type TurnImpact } from '../../model/types.ts';
import { isFlagged } from './failures.ts';
import { raiseImpact, sessionWorst } from './impact.ts';
import type { Derived } from './model.ts';
import { clip } from './signature.ts';
import type { Ev, Ses, Span } from './tree.ts';

export const PARENT_TOLD_RULE = 'parent-told@2';
/** The result the parent saw mentions a failure (first 600 characters). */
const FAILURE_LEXICON = /unable to|could not|couldn'?t|\bfailed\b|failure|\berror(ed)?\b|blocked|not found|permission denied|denied|timed out|无法|失败|错误|未能|incomplete|did not complete|was not able/i;
const TASK_EXCERPT = 300;
/** Episode outcomes that end a child's turn on its failure. */
const ENDED_ON = new Set<string>(['ended-on-failure', 'interrupted']);
const WAIT_STATUS: Record<string, DelegationOutcome> = {
  completed: 'completed', errored: 'failed', failed: 'failed', shutdown: 'killed', interrupted: 'killed', cancelled: 'stopped',
  running: 'running', pending_init: 'running', not_found: 'unknown',
};
const NOTIFICATION: Record<string, DelegationOutcome> = { completed: 'completed', failed: 'failed', killed: 'killed', stopped: 'stopped' };
/** workflowProgress `state` (done, error, progress) and the run journal's (completed, failed). */
const WORKFLOW: Record<string, DelegationOutcome> = { done: 'completed', completed: 'completed', error: 'failed', failed: 'failed', progress: 'running', running: 'running' };

/** Per-session lookups: results and task notifications by call id, agent waits in order, children. */
interface Idx {
  results: Map<string, Ev>;
  notes: Map<string, Ev>;
  waits: Ev[];
}

interface Spawn {
  id: string;
  parent: Ses;
  child: string | null;
  kind: DelegationKind;
  call: Ev | null;
  span: Span | null;
  /** When the spawn happened: the spawn span's start, or for a workflow agent the call that launched its run. */
  start: number | null;
}

/** A workflow agent whose first record precedes its launching call by up to this still belongs to that call. */
const LAUNCH_SKEW_US = 60_000_000;

export function deriveDelegations(d: Derived): void {
  const spawns: Spawn[] = [];
  for (const s of d.tree.sessions) {
    for (const sp of s.spans) {
      if (sp.kind !== 'tool' || !sp.link || sp.link === s.id) continue;
      const call = sp.firstEvent ? d.tree.byId.get(sp.firstEvent) ?? null : null;
      spawns.push({ id: sp.id, parent: s, child: sp.link, kind: kindOf(call?.tool ?? null), call, span: sp, start: sp.start ?? call?.ts ?? null });
    }
  }
  for (const c of d.tree.session.values()) {
    if (c.role !== 'workflow-agent' || !c.parentSpanId) continue;
    const wf = d.tree.span.get(c.parentSpanId);
    const parent = wf ? d.tree.session.get(wf.sid) : undefined;
    if (!wf || !parent) continue;
    const call = launchCall(parent, c) ?? (wf.firstEvent ? d.tree.byId.get(wf.firstEvent) ?? null : null);
    spawns.push({ id: `${wf.id}:${c.id.slice(c.id.lastIndexOf('/') + 1)}`, parent, child: c.id, kind: 'workflow-agent', call, span: wf, start: call?.ts ?? wf.start });
  }
  const depth = (sid: string | null) => (sid ? d.tree.session.get(sid)?.depth ?? 0 : 0);
  spawns.sort((a, b) => depth(b.child) - depth(a.child) || (a.id < b.id ? -1 : 1));
  const idx = new Map<string, Idx>();
  const index = (s: Ses): Idx => {
    let x = idx.get(s.id);
    if (x) return x;
    x = { results: new Map(), notes: new Map(), waits: [] };
    for (const e of s.events) {
      const cid = e.a.tool?.call_id;
      if (e.kind === 'tool.result') {
        if (typeof cid === 'string' && !x.results.has(cid)) x.results.set(cid, e);
        if (e.tool === 'wait' || e.tool === 'wait_agent') x.waits.push(e);
      } else if (e.kind === 'agent.status' && typeof cid === 'string') x.notes.set(cid, e);
    }
    idx.set(s.id, x);
    return x;
  };
  const children = new Map<string, Ses[]>();
  for (const s of d.tree.session.values()) {
    if (!s.parentId) continue;
    const list = children.get(s.parentId);
    if (list) list.push(s);
    else children.set(s.parentId, [s]);
  }
  for (const sp of spawns) {
    const row = delegationRow(d, sp, index(sp.parent), children);
    d.delegations.push(row);
    if ((row.outcome === 'failed' || row.outcome === 'blocked') && row.parentTurn) raiseImpact(d.turnRow.get(row.parentTurn), 'masked', row.id);
  }
}

/**
 * The Workflow call that launched a workflow agent's run. A resumed run answers a later call with the same run id, and
 * its span is that later call's, so the agent belongs to the last call of its run that came before its first record.
 */
function launchCall(parent: Ses, child: Ses): Ev | null {
  const runId = child.meta?.workflow?.runId;
  if (typeof runId !== 'string' || child.startTs == null) return null;
  let best: Ev | null = null;
  for (const e of parent.events) {
    if (e.kind !== 'tool.call' || (e.a.workflow as { run_id?: unknown } | undefined)?.run_id !== runId) continue;
    if (e.ts <= child.startTs + LAUNCH_SKEW_US && (!best || e.ts >= best.ts)) best = e;
  }
  return best;
}

function kindOf(tool: string | null): DelegationKind {
  return tool === 'Task' ? 'task' : tool === 'spawn_agent' ? 'spawn-agent' : 'agent';
}

function delegationRow(d: Derived, sp: Spawn, idx: Idx, children: Map<string, Ses[]>): DelegationRow {
  const child = sp.child ? d.tree.session.get(sp.child) ?? null : null;
  const childImpact: TurnImpact | null = child ? sessionWorst(d, child.id).impact : null;
  const seen = parentSaw(d, sp, child, idx);
  const outcome = outcomeOf(d, sp, child, seen.notification, idx);
  const failed = outcome.outcome === 'failed' || outcome.outcome === 'blocked';
  // Told of a failure (only a failed child has one): the result is flagged or carries a failed status, the outcome came
  // from a wait status the parent read, a workflow's result lists the agent under its failures, or another result says
  // so in its first 600 characters. A workflow's result speaks for every agent, so its words name no one in particular.
  const label = str(child?.meta?.workflow?.label);
  const told = failed && seen.result
    ? isFlagged(seen.result) || seen.toldStatus || outcome.src === 'parsed:wait-status'
      || (sp.kind === 'workflow-agent'
        ? !!label && (failedAgents(seen.result).includes(label) || seen.text.includes(`[${label}] failed`))
        : FAILURE_LEXICON.test(seen.text.slice(0, 600)))
    : null;
  const tree = child ? subtree(child, children) : [];
  const sum = (f: (s: Ses) => number | null) => tree.reduce<number | null>((acc, s) => (f(s) === null ? acc : (acc ?? 0) + f(s)!), null);
  const task = taskOf(sp.kind, sp.call?.a.tool?.input as Record<string, any> | undefined, child?.meta);
  return {
    id: sp.id, sessionId: sp.parent.id, parentTurn: sp.call?.turn ?? null, parentStep: sp.call ? d.stepOf.get(sp.call.rid)?.id ?? null : null,
    childSession: sp.child, kind: sp.kind, taskExcerpt: task ? clip(task, TASK_EXCERPT) : null, taskChars: task ? Array.from(task).length : null,
    outcome: outcome.outcome, outcomeSrc: outcome.src,
    childImpact, parentTold: told, silent: told === false,
    resultRid: seen.result?.rid ?? null, tokInTree: sum((s) => s.tokIn), tokOutTree: sum((s) => s.tokOut), parentWaitUs: seen.waitUs,
    startTs: sp.start ?? child?.startTs ?? 0, endTs: child?.endTs ?? sp.span?.end ?? null,
  };
}

/** The task given to a child: a workflow agent's label or description, else the spawn call's prompt, description, message or task name. */
export function taskOf(kind: DelegationKind, input: Record<string, any> | null | undefined, childMeta: Record<string, any> | null | undefined): string | null {
  if (kind === 'workflow-agent') return str(childMeta?.workflow?.label) ?? str(childMeta?.agent?.description);
  return str(input?.prompt) ?? str(input?.description) ?? str(input?.message) ?? str(input?.task_name);
}

/**
 * SPEC §12.3.7 outcome ladder: workflow state, task notification, wait status, then the child's own episodes. From its
 * episodes a child failed only when its last turn ended on an unrecovered failure or was interrupted; a child that
 * pivoted or recovered later went on to finish.
 */
function outcomeOf(d: Derived, sp: Spawn, child: Ses | null, notification: Ev | null, idx: Idx): { outcome: DelegationOutcome; src: Prov | null } {
  if (sp.kind === 'workflow-agent' && child) {
    const w = child.meta?.workflow ?? {};
    const st = WORKFLOW[w.progress?.state] ?? WORKFLOW[w.state];
    if (st) return { outcome: st, src: 'logged:workflow' };
  }
  const status = notification?.a.agent?.status;
  if (typeof status === 'string' && NOTIFICATION[status]) return { outcome: NOTIFICATION[status], src: 'logged:task-notification' };
  if (sp.kind === 'spawn-agent' && sp.child) {
    const parsed = waitStatus(sp, idx);
    if (parsed) return { outcome: parsed, src: 'parsed:wait-status' };
  }
  if (child) {
    const turns = d.turnsBySession.get(child.id) ?? [];
    const last = child.stored ? child.stored.lastTurn : turns[turns.length - 1];
    const eps = last ? (child.stored?.episodes ?? d.episodes).filter((e) => e.turnId === last.id && ENDED_ON.has(e.outcome)) : [];
    if (eps.length) {
      const blocked = eps.every((e) => (BLOCKED_FAMILIES as readonly string[]).includes(e.family));
      return { outcome: blocked ? 'blocked' : 'failed', src: 'derived:child' };
    }
    if (last?.open) return { outcome: 'running', src: 'derived:child' };
  }
  return { outcome: 'unknown', src: null };
}

/** The last terminal status the parent's wait results give for the child (patterns, since outputs can be truncated JSON). */
function waitStatus(sp: Spawn, idx: Idx): DelegationOutcome | null {
  const id = nativeId(sp.child!);
  const re = new RegExp(`"${escapeRe(id)}"\\s*:\\s*\\{\\s*"(\\w+)"`);
  let found: DelegationOutcome | null = null;
  for (const e of idx.waits) {
    const m = re.exec(str(e.a.tool?.output) ?? '');
    const o = m ? WAIT_STATUS[m[1]] : undefined;
    if (o && (o !== 'running' || !found)) found = o;
  }
  return found;
}

/**
 * The result the parent saw: Claude's Agent result (or, for a background agent, its task notification), Codex's first
 * wait result naming the child, a workflow's result. `waitUs`: how long the parent waited on it.
 */
function parentSaw(d: Derived, sp: Spawn, child: Ses | null, idx: Idx): { result: Ev | null; text: string; toldStatus: boolean; notification: Ev | null; waitUs: number | null } {
  const callId = sp.call?.a.tool?.call_id;
  const notification = typeof callId === 'string' ? idx.notes.get(callId) ?? null : null;
  if (sp.kind === 'spawn-agent' && sp.child) {
    const id = nativeId(sp.child);
    const path = str(child?.meta?.agent_path) ?? str((child?.meta as any)?.source?.subagent?.thread_spawn?.agent_path);
    let first: Ev | null = null;
    let waitUs = 0;
    for (const e of idx.waits) {
      const out = str(e.a.tool?.output) ?? '';
      if (!out.includes(id) && !(path && out.includes(path))) continue;
      first ??= e;
      const span = e.span ? d.tree.span.get(e.span) : undefined;
      waitUs += span?.dur ?? 0;
    }
    return { result: first, text: str(first?.a.tool?.output) ?? '', toldStatus: false, notification, waitUs: first ? waitUs : null };
  }
  const result = typeof callId === 'string' ? idx.results.get(callId) ?? null : null;
  if (result && result.a.tool?.status === 'async_launched') {
    const st = notification?.a.agent?.status;
    return {
      result: notification, text: str(notification?.a.text) ?? '', toldStatus: st === 'failed' || st === 'killed' || st === 'stopped', notification, waitUs: null,
    };
  }
  const waitUs = sp.kind === 'workflow-agent' ? null : sp.span?.dur ?? null;
  return { result, text: str(result?.a.tool?.output) ?? '', toldStatus: false, notification, waitUs };
}

/** The labels a workflow's notification lists under `<failures>` (the Claude adapter's task.failed_agents). */
function failedAgents(e: Ev): string[] {
  const list = (e.a.task as { failed_agents?: unknown } | undefined)?.failed_agents;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

function subtree(root: Ses, children: Map<string, Ses[]>): Ses[] {
  const out: Ses[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
    stack.push(...(children.get(s.id) ?? []));
  }
  return out;
}

function nativeId(sid: string): string {
  return sid.slice(sid.indexOf(':') + 1);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
