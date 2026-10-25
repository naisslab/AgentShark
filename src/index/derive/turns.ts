// Turns of each session in seq order, with the event-determined facts other rules read: open, interrupted, prompts,
// and the unattended rule (SPEC §12.3.5).

import type { DatabaseSync } from 'node:sqlite';
import type { AlarmThresholds } from '../../model/types.ts';
import type { Derived, TurnInfo } from './model.ts';
import { indexClock } from './tree.ts';

export const UNATTENDED_RULE = 'unattended@1';

/** How long a run must be idle before the index's newest event for its open turns to end (µs). */
const idleUs = (th: AlarmThresholds) => (th.stallMin + th.windowMin) * 60_000_000;

/**
 * Sessions whose stored open turn may have ended since they were derived, because their tree has gone idle: an
 * incremental pass derives them again, so it ends the same turns a pass over every tree would. A tree with a stored
 * event inside the idle window is not idle (changed sessions are derived anyway).
 */
export function idleOpenSessions(db: DatabaseSync, th: AlarmThresholds): string[] {
  const cut = indexClock(db) - idleUs(th);
  const rows = db.prepare(`SELECT DISTINCT t.session_id FROM turn_rollup t JOIN sessions s ON s.id = t.session_id
    WHERE t.open = 1 AND t.last_ts <= ?
      AND NOT EXISTS (SELECT 1 FROM sessions o JOIN session_rollup r ON r.session_id = o.id WHERE o.root_id = s.root_id AND r.last_ts > ?)`).all(cut, cut);
  return (rows as { session_id: string }[]).map((r) => r.session_id);
}

/**
 * Fills d.turns and d.turnsBySession. A turn its adapter left open stays open until its run (the tree) has been idle
 * for the stall window (stallMin + windowMin) before the index's newest event: by then a stall has expired, and the
 * run is over.
 */
export function deriveTurns(d: Derived): void {
  const idle = d.tree.indexTs - d.tree.newestTs >= idleUs(d.thresholds);
  for (const s of d.tree.sessions) {
    const list: TurnInfo[] = [];
    let goal: string | null = null;
    let approval: string | null = null;
    // A goal active at any event of the turn; approval as of the turn's newest event (Codex writes turn_context after
    // task_started).
    const state = new Map<string, { goal: boolean; approval: string | null }>();
    // A turn end that no turn holds (a Cowork audit result) ends the newest turn when nothing of that turn follows it.
    let looseEnd = -1;
    for (const e of s.events) {
      if (e.kind === 'session.state') {
        const c = e.a.context as { type?: string; status?: string } | undefined;
        if (c?.type === 'goal') goal = c.status ?? null;
        else if (typeof e.a.permission?.mode === 'string') approval = e.a.permission.mode;
      }
      if (!e.turn) {
        if (e.kind === 'turn.end') looseEnd = e.seq;
        continue;
      }
      let t = d.turns.get(e.turn);
      if (!t) {
        const span = d.tree.span.get(e.turn) ?? null;
        t = {
          id: e.turn, span, firstSeq: e.seq, lastSeq: e.seq, startTs: span?.start ?? e.ts, lastTs: e.ts,
          open: span?.status === 'open' && !idle, abortSeqs: [], interrupted: span?.status === 'interrupted', prompts: 0, unattended: false,
        };
        d.turns.set(e.turn, t);
        list.push(t);
      }
      state.set(e.turn, { goal: goal === 'active' || state.get(e.turn)?.goal === true, approval });
      t.lastSeq = e.seq;
      if (e.ts > t.lastTs) t.lastTs = e.ts;
      if (e.kind === 'turn.abort') {
        t.abortSeqs.push(e.seq);
        t.interrupted = true;
      } else if (e.kind === 'user.prompt') t.prompts++;
    }
    list.sort((a, b) => a.firstSeq - b.firstSeq);
    const newest = list.at(-1);
    if (newest && looseEnd > newest.lastSeq) newest.open = false;
    list.forEach((t, i) => {
      const st = state.get(t.id)!;
      const quiet = list.slice(Math.max(0, i - 2), i + 1).every((x) => x.prompts === 0);
      t.unattended = s.role !== 'main' || st.goal || (st.approval === 'never' && quiet);
    });
    d.turnsBySession.set(s.id, list);
  }
}
