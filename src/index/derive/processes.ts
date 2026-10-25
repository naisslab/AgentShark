// Background processes (SPEC §12.3.8). A result that leaves a process running opens it, keyed by (session, N): Codex
// "Process running with session ID N", a Claude background shell or monitor (the §12.3.1 proc_id). Polls, inputs,
// stops and task notifications that name N join it in seq order: process_events is the stream. The exit line, a stop
// or a notification's final status closes it; "stdin is closed" and "Unknown process id" attach as errors. The next
// opener of N starts another process. A deferred failure row keeps its logged status; process_events links it to the
// process, whose exit is its outcome.

import type { ProcessEventRole, ProcessRow, Prov } from '../../model/types.ts';
import type { Action, Derived } from './model.ts';
import { stripWrappers } from './signature.ts';
import type { Ev } from './tree.ts';

const KILLS = new Set(['KillShell', 'TaskStop']);
const PROC_ERROR = /Unknown process id|stdin is closed|^write_stdin failed/;
/** Claude TaskOutput and BashOutput results: `<status>completed</status>` … `<exit_code>0</exit_code>`. */
const TASK_STATUS = /<status>(completed|failed|killed)<\/status>/;
const TASK_EXIT = /<exit_code>(-?\d+)<\/exit_code>/;
/** Task notification summaries: "completed (exit code 0)", "failed with exit code 1". */
const NOTE_EXIT = /exit code (-?\d+)/;
const NOTE_FINAL = new Set(['completed', 'failed', 'killed', 'stopped']);

type Entry = { ev: Ev; id: string; kind: 'open' | 'poll' | 'input' | 'kill' | 'result' | 'note'; action: Action | null };

interface Proc {
  row: ProcessRow;
  closed: boolean;
  /** The stop call whose result confirms the stop. */
  kill: Action | null;
}

export function deriveProcesses(d: Derived): void {
  for (const s of d.tree.sessions) {
    const entries: Entry[] = [];
    for (const a of d.actions.get(s.id) ?? []) {
      if (a.kind !== 'tool') continue;
      const id = a.opens ?? a.procId;
      if (!id) continue;
      const kind = a.opens ? 'open' : KILLS.has(a.tool ?? '') ? 'kill' : a.tool === 'write_stdin' && charsOf(a) ? 'input' : 'poll';
      if (a.call) entries.push({ ev: a.call, id, kind, action: a });
      if (a.result) entries.push({ ev: a.result, id, kind: a.call ? 'result' : kind, action: a });
    }
    for (const e of s.events) {
      const id = e.kind === 'agent.status' || e.kind === 'context.attachment' ? e.a.tool?.proc_id : undefined;
      if (typeof id === 'string') entries.push({ ev: e, id, kind: 'note', action: null });
    }
    if (!entries.length) continue;
    entries.sort((a, b) => a.ev.seq - b.ev.seq);
    const current = new Map<string, Proc>();
    const procs: Proc[] = [];
    const start = (x: Entry, program: string | null): Proc => {
      // A reused N: the earlier process ended without a logged end.
      const prev = current.get(x.id);
      if (prev) prev.closed = true;
      const p: Proc = {
        row: {
          id: `${s.id}#proc:${x.id}:${x.ev.seq}`, sessionId: s.id, procKey: x.id, openRid: x.ev.rid, closeRid: null, program, nPolls: 0, nInputs: 0,
          exitCode: null, exitSrc: null, status: 'unknown', startTs: x.ev.ts, endTs: null,
        },
        closed: false, kill: null,
      };
      current.set(x.id, p);
      procs.push(p);
      return p;
    };
    for (const x of entries) {
      if (d.processOf.has(x.ev.rid)) continue;
      // An opener starts a new process; anything else naming an unseen N starts one whose opening is not logged.
      const p = x.kind === 'open' ? start(x, programOf(x.action!)) : current.get(x.id) ?? start(x, null);
      const role = roleOf(x, p);
      d.processOf.set(x.ev.rid, p.row);
      d.processEvents.push({ rid: x.ev.rid, processId: p.row.id, sessionId: s.id, role });
    }
    // Not closed: running while the session's newest turn is open, else its end is not logged.
    const turns = d.turnsBySession.get(s.id) ?? [];
    const live = turns.length > 0 && turns[turns.length - 1].open;
    for (const p of procs) {
      if (!p.closed) p.row.status = live ? 'running' : 'unknown';
      d.processes.push(p.row);
    }
  }
}

/** The entry's role in the stream; closes the process when the entry ends it. */
function roleOf(x: Entry, p: Proc): ProcessEventRole {
  const close = (status: ProcessRow['status'], exit: { code: number | null; src: Prov | null } | null): ProcessEventRole => {
    if (p.closed) return 'output';
    p.closed = true;
    Object.assign(p.row, { status, closeRid: x.ev.rid, endTs: x.ev.ts });
    if (exit) Object.assign(p.row, { exitCode: exit.code, exitSrc: exit.src });
    return 'close';
  };
  switch (x.kind) {
    case 'open':
      return 'open';
    case 'poll':
      p.row.nPolls++;
      return 'poll';
    case 'input':
      p.row.nInputs++;
      return 'input';
    case 'kill':
      if (!p.closed) {
        close('killed', null);
        p.kill = x.action;
      }
      return 'kill';
    case 'note': {
      const st = x.ev.a.agent?.status ?? /<status>(\w+)<\/status>/.exec(text(x.ev))?.[1];
      if (typeof st !== 'string' || !NOTE_FINAL.has(st)) return 'output';
      const m = NOTE_EXIT.exec(text(x.ev));
      return close(st === 'killed' || st === 'stopped' ? 'killed' : 'exited', m ? { code: Number(m[1]), src: 'parsed:task-notification' } : null);
    }
    case 'result': {
      // The stop's own result confirms it.
      if (x.action && x.action === p.kill) {
        Object.assign(p.row, { closeRid: x.ev.rid, endTs: x.ev.ts });
        return 'close';
      }
      const out = text(x.ev);
      if (PROC_ERROR.test(out.slice(0, 300))) {
        if (!p.closed) close('closed', null);
        return 'error';
      }
      const s = stripWrappers(out);
      if (s.running !== null) return 'output';
      if (s.exitCode !== null) return close('exited', { code: s.exitCode, src: 'parsed:exit-line' });
      const task = TASK_STATUS.exec(out);
      if (task) {
        const m = TASK_EXIT.exec(out);
        return close(task[1] === 'killed' ? 'killed' : 'exited', m ? { code: Number(m[1]), src: 'parsed:task-output' } : null);
      }
      return 'output';
    }
  }
}

function programOf(a: Action): string | null {
  return a.key.startsWith('sh:') ? a.key.slice(3) : a.tool;
}

function charsOf(a: Action): string {
  const chars = (a.call?.a.tool?.input as Record<string, unknown> | undefined)?.chars;
  return typeof chars === 'string' ? chars : '';
}

function text(e: Ev): string {
  const t = e.a.tool?.output ?? e.a.text;
  return typeof t === 'string' ? t : '';
}
