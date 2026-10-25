// Alarms (SPEC §12.3.9): every instance of the stored kinds on every turn, open or ended, as a pure function of the
// events; ALARM_KINDS in types.ts says when each holds and clears. An instance that still holds at the turn's end
// clears there. `stall` depends on the clock alone, so queries build it on read. Thresholds come from d.thresholds.

import type { DatabaseSync } from 'node:sqlite';
import { type AlarmKind, BLOCKED_FAMILIES, NOTIFYING_ALARMS, type RuleId, type TurnImpact } from '../../model/types.ts';
import { episodeImpact, rank } from './impact.ts';
import { type Action, type Derived, type TurnInfo, UNRECOVERED } from './model.ts';
import type { Ev } from './tree.ts';
import { canNotify } from './precision.ts';

export const ALARM_RULES = {
  consecutive: 'consecutive@1', blocker: 'blocker@1', loop: 'loop@1', 'blind-loop': 'blind-loop@1', 'silent-child': 'silent-child@1',
} as const satisfies Partial<Record<AlarmKind, RuleId>>;
type StoredKind = keyof typeof ALARM_RULES;

export function deriveAlarms(d: Derived): void {
  const emit = (kind: StoredKind, t: TurnInfo, first: Ev, clear: Ev | null, episodeId: string | null, delegationId: string | null = null) => {
    const sid = first.sid;
    const ended = !t.open ? t.span?.end ?? t.lastTs : null;
    d.alarms.push({
      id: `${t.id}#alarm:${kind}:${first.id}`, sessionId: sid, turnId: t.id, kind, rule: ALARM_RULES[kind], firstTs: first.ts,
      lastTs: clear ? clear.ts : t.lastTs, episodeId, delegationId,
      notify: NOTIFYING_ALARMS.includes(kind) && canNotify(ALARM_RULES[kind]), clearedTs: clear ? clear.ts : ended,
    });
  };
  // Episodes each action closes, for `blocker`.
  const closes = new Map<Action, string[]>();
  for (const [id, run] of d.episodeRuns) if (run.closer) push(closes, run.closer, id);
  for (const s of d.tree.sessions) {
    const byTurn = new Map<string, Action[]>();
    for (const a of d.actions.get(s.id) ?? []) if (a.turn) push(byTurn, a.turn, a);
    for (const [turnId, acts] of byTurn) {
      const t = d.turns.get(turnId);
      if (!t || !acts.some((a) => a.status === 'fail')) continue;
      consecutive(acts, d.thresholds.consecutive, (first, last, clear) => emit('consecutive', t, first, clear, last.failure!.episodeId));
      blocker(acts, d.thresholds.blocker, closes, (first, last, clear) => emit('blocker', t, first, clear, last.failure!.episodeId));
    }
  }
  for (const ep of d.episodes) {
    const run = d.episodeRuns.get(ep.id);
    const t = ep.turnId ? d.turns.get(ep.turnId) : undefined;
    if (!run || !t) continue;
    const clear = run.closer?.result ?? null;
    if (run.loopAt !== null) emit('loop', t, run.attempts[run.loopAt].result!, clear, ep.id);
    if (run.blindAt !== null) emit('blind-loop', t, run.attempts[run.blindAt].result!, clear, ep.id);
  }
  // One alarm per result the parent saw: a workflow's or a wait's result can hide several children (the first by id).
  const told = new Set<number>();
  for (const dl of d.delegations.filter((x) => x.silent && x.resultRid !== null).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const seen = d.tree.byRid.get(dl.resultRid!);
    const t = seen?.turn ? d.turns.get(seen.turn) : undefined;
    if (!seen || !t || told.has(seen.rid)) continue;
    told.add(seen.rid);
    emit('silent-child', t, seen, null, worstEpisode(d, dl.childSession), dl.id);
  }
}

type Fire = (first: Ev, last: Action, clear: Ev | null) => void;

/** From the Nth non-benign failure row in a row (benign and deferred rows neither count nor break) to the next clean result. */
function consecutive(acts: Action[], n: number, fire: Fire): void {
  let run = 0;
  let inst: { first: Ev; last: Action } | null = null;
  for (const a of acts) {
    const tier = a.failure?.tier;
    if (tier === 'failure' || tier === 'suspect') {
      run++;
      if (inst) inst.last = a;
      else if (run >= n) inst = { first: a.result!, last: a };
    } else if ((a.kind === 'tool' || a.kind === 'item') && a.result && a.status === 'ok' && !a.failure) {
      if (inst) fire(inst.first, inst.last, a.result);
      inst = null;
      run = 0;
    }
  }
  if (inst) fire(inst.first, inst.last, null);
}

/** From the Nth failure of a blocked family in the turn until the last of their episodes closes. */
function blocker(acts: Action[], n: number, closes: Map<Action, string[]>, fire: Fire): void {
  let count = 0;
  const open = new Set<string>();
  let inst: { first: Ev; last: Action } | null = null;
  for (const a of acts) {
    const f = a.failure;
    if (f?.tier === 'failure' && BLOCKED_FAMILIES.includes(f.family)) {
      count++;
      if (f.episodeId) open.add(f.episodeId);
      if (inst) inst.last = a;
      else if (count >= n) inst = { first: a.result!, last: a };
    }
    for (const id of closes.get(a) ?? []) open.delete(id);
    if (inst && !open.size) {
      fire(inst.first, inst.last, a.result ?? a.call);
      inst = null;
    }
  }
  if (inst) fire(inst.first, inst.last, null);
}

/** The child's unrecovered episode with the worst impact (the newest among equals). */
function worstEpisode(d: Derived, child: string | null): string | null {
  let best: { id: string; r: number; ts: number } | null = null;
  for (const e of (child ? d.tree.session.get(child)?.stored?.episodes : null) ?? d.episodes) {
    if (e.sessionId !== child || !UNRECOVERED.has(e.outcome)) continue;
    const level = episodeImpact(e);
    const r = level ? rank(level) : 99;
    if (!best || r < best.r || (r === best.r && e.endTs > best.ts)) best = { id: e.id, r, ts: e.endTs };
  }
  return best?.id ?? null;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** Turn impacts an alarm warned of correctly: the turn went bad. */
const BAD: readonly TurnImpact[] = ['failed', 'blocked', 'interrupted'];

export interface AlarmReplay {
  kind: StoredKind;
  /** Ended turns where the kind fired. */
  turns: number;
  /** Of those, turns that ended failed, blocked or interrupted. */
  bad: number;
  /** bad / turns; null without turns. */
  precision: number | null;
  /** Turns where every instance cleared before the turn ended (a clean result, or the blocked episodes closed). */
  recovered: number;
  /** Median time from the first firing to the end of a bad turn. */
  medianWarningS: number | null;
}

/**
 * The offline replay (SPEC §12.3.9, §12.10 acceptance 4): over the stored alarms of ended turns, how often the turn the
 * kind fired in went bad, and how much warning the first firing gave. Notifying kinds ship only while it stays precise.
 */
export function replayAlarms(db: DatabaseSync): AlarmReplay[] {
  const rows = db.prepare(`SELECT a.kind, t.impact, min(a.first_ts) AS first, coalesce(t.end_ts, t.last_ts) AS turn_end,
      sum(a.cleared_ts IS NULL OR a.cleared_ts >= coalesce(t.end_ts, t.last_ts)) AS held
    FROM alarms a JOIN turn_rollup t ON t.turn_id = a.turn_id WHERE t.open = 0 GROUP BY a.kind, a.turn_id`).all() as Record<string, any>[];
  return (Object.keys(ALARM_RULES) as StoredKind[]).map((kind) => {
    const fired = rows.filter((r) => r.kind === kind);
    const bad = fired.filter((r) => BAD.includes(r.impact));
    const warnings = bad.map((r) => Math.max(0, r.turn_end - r.first) / 1e6).sort((a, b) => a - b);
    return {
      kind, turns: fired.length, bad: bad.length, precision: fired.length ? bad.length / fired.length : null,
      recovered: fired.filter((r) => !r.held).length, medianWarningS: warnings.length ? warnings[Math.floor(warnings.length / 2)] : null,
    };
  });
}
