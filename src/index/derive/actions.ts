// Actions: every call with its result (and each Codex inner item, api error, hook run and model response) in evidence
// order, with its target key (SPEC §12.3.4). Failure tiers and episodes read these.

import type { Action, Derived } from './model.ts';
import { PROC_TOOLS, targetKey } from './target.ts';
import type { Ev, Ses } from './tree.ts';

const INPUT_MAX = 400;

export function deriveActions(d: Derived): void {
  for (const s of d.tree.sessions) d.actions.set(s.id, sessionActions(d, s));
}

function sessionActions(d: Derived, s: Ses): Action[] {
  const results = new Map<string, Ev>();
  for (const e of s.events) {
    const cid = e.kind === 'tool.result' ? e.a.tool?.call_id : undefined;
    if (typeof cid === 'string' && !results.has(cid)) results.set(cid, e);
  }
  const paired = new Set<number>();
  const bySpan = new Map<string, Action>();
  const list: Action[] = [];
  const add = (kind: Action['kind'], call: Ev | null, result: Ev | null, parent: Action | null = null): Action => {
    const ev = (result ?? call)!;
    const a: Action = {
      kind, call, result, parent, tool: (call ?? result)!.tool, key: '', turn: ev.turn ?? call?.turn ?? null,
      seq: ev.seq, ts: ev.ts, step: d.stepOf.get((call ?? ev).rid) ?? d.stepOf.get(ev.rid) ?? null,
      status: 'neutral', failure: null, input: '', opens: null, procId: null,
    };
    list.push(a);
    return a;
  };
  for (const e of s.events) {
    switch (e.kind) {
      case 'tool.call': {
        const cid = e.a.tool?.call_id;
        const r = typeof cid === 'string' ? results.get(cid) ?? null : null;
        if (r) paired.add(r.rid);
        const a = add('tool', e, r);
        if (e.span) bySpan.set(e.span, a);
        break;
      }
      case 'tool.exec': {
        const exec = e.span ? d.tree.span.get(e.span) : undefined;
        add('item', e, e, exec?.parent ? bySpan.get(exec.parent) ?? null : null);
        break;
      }
      case 'llm.error':
      case 'llm.refusal':
        add('api', e, e);
        break;
      case 'hook.run':
        add('hook', e, e);
        break;
      case 'llm.usage':
        if (!e.proto.startsWith('cowork-audit/')) add('usage', e, e);
        break;
    }
  }
  for (const e of s.events) if (e.kind === 'tool.result' && !paired.has(e.rid)) add('tool', null, e);
  list.sort((a, b) => a.seq - b.seq);
  // Keys in evidence order, so a process opened by an earlier result names its later polls (`proc:<open key>`).
  const opened = new Map<string, string>();
  for (const a of list) {
    a.procId = procIdOf(a);
    a.key = keyOf(a, s, opened);
    a.input = inputOf(a);
    a.opens = opensProcess(a);
    if (a.opens) opened.set(a.opens, a.key);
  }
  return list;
}

function keyOf(a: Action, s: Ses, opened: Map<string, string>): string {
  if (a.kind === 'api' || a.kind === 'usage') return 'api';
  const e = (a.call ?? a.result)!;
  if (a.kind === 'hook') return targetKey({ tool: null, kind: null, input: null, hook: { event: str(e.a.hook?.event) ?? '?', command: str(e.a.hook?.command) ?? str(e.a.hook?.name) ?? '?' } });
  const t = e.a.tool ?? {};
  const input = t.input as Record<string, any> | undefined;
  const procId = a.procId;
  return targetKey({
    tool: a.tool, kind: e.toolKind, input: t.input, command: str(t.command), parsedCmd: e.pcmd, server: str(t.server), path: str(t.path),
    cwd: str(input?.workdir) ?? str(t.cwd) ?? s.cwd, proc: procId ? opened.get(procId) ?? null : null, procId,
    output: a.tool === 'apply_patch' ? str(a.result?.a.tool?.output) : null,
  });
}

/** The background process a poll, input or stop names. */
function procIdOf(a: Action): string | null {
  const t = a.call?.a.tool;
  if (!t) return null;
  if (typeof t.proc_id === 'string' && (a.tool === 'write_stdin' || PROC_TOOLS.has(a.tool ?? ''))) return t.proc_id;
  const input = t.input as Record<string, any> | undefined;
  if (a.tool === 'write_stdin') return idString(input?.session_id);
  if (PROC_TOOLS.has(a.tool ?? '')) return idString(input?.bash_id ?? input?.shell_id ?? input?.task_id);
  return null;
}

/** A result that leaves a process running opens it: Codex "Process running with session ID N", a Claude background shell. */
function opensProcess(a: Action): string | null {
  if (a.kind !== 'tool' || !a.result || a.tool === 'write_stdin' || PROC_TOOLS.has(a.tool ?? '')) return null;
  const t = a.result.a.tool ?? {};
  if (typeof t.background_task_id === 'string') return t.background_task_id;
  if (typeof t.proc_id === 'string') return t.proc_id;
  const m = /^running \(session (\d+)\)/.exec(str(t.status) ?? '') ?? /Process running with session ID (\d+)/.exec((str(t.output) ?? '').slice(0, 300));
  return m ? m[1] : null;
}

function inputOf(a: Action): string {
  const e = a.call ?? a.result;
  if (!e || a.kind === 'api' || a.kind === 'usage' || a.kind === 'hook') return '';
  const t = e.a.tool ?? {};
  const input = t.input as Record<string, any> | string | undefined;
  const text = str(t.command) ?? (typeof input === 'string' ? input : input ? str(input.command) ?? str(input.cmd) ?? JSON.stringify(input) : '');
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, INPUT_MAX);
}

function idString(v: unknown): string | null {
  return typeof v === 'number' || (typeof v === 'string' && v) ? String(v) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
