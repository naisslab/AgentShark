// Turn impact (SPEC §12.3.6) and the per-session rollup the sidebar reads. Each turn gets the worst level that applies;
// `masked` comes from the delegations (derive/delegations.ts), which need the children's impacts first.

import {
  BLOCKED_FAMILIES, TURN_IMPACTS, UNVERIFIED_CLAIMS, type EpisodeRow, type TurnImpact, type TurnRollupRow, type TurnWaiting,
} from '../../model/types.ts';
import { type Action, type Derived, UNRECOVERED } from './model.ts';
import { provOf } from './steps.ts';

const SLOW_US = 180_000_000;
const SLOW_STEPS = 10;
const PROCESS_WAITS = new Set(['write_stdin', 'wait', 'wait_agent', 'sleep', 'BashOutput', 'TaskOutput', 'Monitor']);
const QUESTIONS = new Set(['AskUserQuestion', 'request_user_input', 'request_user_input_async']);

/** Worst first: the index in TURN_IMPACTS. */
export const rank = (i: TurnImpact) => TURN_IMPACTS.indexOf(i);

/** The impact level one episode sets, or null (an open episode outside the blocked families, or a rejection the turn went past). */
export function episodeImpact(e: Pick<EpisodeRow, 'outcome' | 'family' | 'loop' | 'wallUs' | 'nSteps'>): TurnImpact | null {
  const recovered = e.outcome === 'recovered' || e.outcome === 'parallel-ok';
  // The user's own "no": when the turn stops on it, it stopped like an interrupt; otherwise the turn went on.
  if (e.family === 'user-rejected' && !recovered) return e.outcome === 'ended-on-failure' || e.outcome === 'interrupted' ? 'interrupted' : null;
  if (e.outcome === 'ended-on-failure' || (e.loop && !recovered)) return 'failed';
  if ((BLOCKED_FAMILIES as readonly string[]).includes(e.family) && !recovered) return 'blocked';
  if (e.outcome === 'interrupted') return 'interrupted';
  if (e.outcome === 'pivoted' || e.outcome === 'recovered-later') return 'degraded';
  if (e.outcome === 'recovered' && ((e.wallUs ?? 0) >= SLOW_US || e.nSteps >= SLOW_STEPS)) return 'slow';
  return recovered ? 'recovered' : null;
}

/** Turn rows with the impact of their own episodes; `masked` is applied later by raiseImpact. */
export function deriveTurnRollup(d: Derived): void {
  const eps = new Map<string, EpisodeRow[]>();
  for (const e of d.episodes) {
    if (!e.turnId) continue;
    const list = eps.get(e.turnId);
    if (list) list.push(e);
    else eps.set(e.turnId, [e]);
  }
  const stepsPerTurn = new Map<string, number>();
  for (const st of d.steps) if (st.turnId) stepsPerTurn.set(st.turnId, (stepsPerTurn.get(st.turnId) ?? 0) + 1);
  // The newest call of each turn, for what an open turn waits on.
  const lastCall = new Map<string, Action>();
  for (const acts of d.actions.values()) for (const a of acts) if (a.turn && (a.kind === 'tool' || a.kind === 'item') && a.call) lastCall.set(a.turn, a);
  for (const s of d.tree.sessions) {
    const kinds = new Map<string, Set<string>>();
    for (const e of s.events) {
      if (e.kind !== 'tool.call' || !e.toolKind || !e.turn) continue;
      let set = kinds.get(e.turn);
      if (!set) kinds.set(e.turn, (set = new Set()));
      set.add(e.toolKind);
    }
    for (const [i, t] of (d.turnsBySession.get(s.id) ?? []).entries()) {
      const list = (eps.get(t.id) ?? []).sort((a, b) => a.startTs - b.startTs);
      let impact: TurnImpact = 'clean';
      let basis: string | null = null;
      for (const e of list) {
        const level = episodeImpact(e);
        if (level && rank(level) < rank(impact)) [impact, basis] = [level, e.id];
      }
      const row: TurnRollupRow = {
        turnId: t.id, sessionId: s.id, rootId: d.tree.rootId, n: i + 1, origin: t.span?.origin ?? null, startTs: t.startTs,
        endTs: t.open ? null : t.span?.end ?? null, lastTs: t.lastTs, open: t.open, waiting: t.open ? waiting(lastCall.get(t.id)) : null, impact, impactBasis: basis,
        nSteps: stepsPerTurn.get(t.id) ?? 0, nEpisodes: list.length, nUnrecovered: list.filter((e) => UNRECOVERED.has(e.outcome)).length,
        claimEvidence: null, unattended: t.unattended, wallUs: t.span?.dur ?? null, wallSrc: t.span ? provOf(t.span.durSrc) : null,
        callKinds: kinds.has(t.id) ? [...kinds.get(t.id)!].sort().join(' ') : null,
      };
      d.turnRollup.push(row);
      d.turnRow.set(t.id, row);
    }
  }
}

/** What an open turn waits on (TurnWaiting): its newest call without a result, or a result whose process still runs. */
function waiting(a: Action | undefined): TurnWaiting | null {
  if (!a) return null;
  if (!a.result) return PROCESS_WAITS.has(a.tool ?? '') ? 'process' : QUESTIONS.has(a.tool ?? '') ? 'question' : 'tool';
  return a.opens || String(a.result.a.tool?.status ?? '').startsWith('running (session ') ? 'process' : null;
}

/** Raise a turn's impact (masked, from a failed child) when it is worse than what the turn has. */
export function raiseImpact(row: TurnRollupRow | undefined, level: TurnImpact, basis: string): void {
  if (row && rank(level) < rank(row.impact)) {
    row.impact = level;
    row.impactBasis = basis;
  }
}

/** Worst impact over a session's turns (and its turn-less episodes); a session this pass does not load: its stored one. */
export function sessionWorst(d: Derived, sid: string): { impact: TurnImpact; turn: string | null } {
  const stored = d.tree.session.get(sid)?.stored;
  if (stored) return { impact: stored.worst, turn: null };
  let impact: TurnImpact = 'clean';
  let turn: string | null = null;
  for (const t of d.turnsBySession.get(sid) ?? []) {
    const r = d.turnRow.get(t.id);
    if (r && rank(r.impact) < rank(impact)) [impact, turn] = [r.impact, r.turnId];
  }
  for (const e of d.episodes) {
    if (e.sessionId !== sid || e.turnId) continue;
    const level = episodeImpact(e);
    if (level && rank(level) < rank(impact)) [impact, turn] = [level, null];
  }
  return { impact, turn };
}

/** One session_rollup row per session with own events. */
export function deriveSessionRollup(d: Derived): void {
  for (const s of d.tree.sessions) {
    if (!s.events.length) continue;
    const w = sessionWorst(d, s.id);
    const turns = d.turnsBySession.get(s.id) ?? [];
    const eps = d.episodes.filter((e) => e.sessionId === s.id);
    let lastTs = -Infinity;
    for (const e of s.events) if (e.ts > lastTs) lastTs = e.ts;
    d.sessionRollup.push({
      sessionId: s.id, rootId: d.tree.rootId, worstImpact: w.impact, worstRank: rank(w.impact), worstTurn: w.impact === 'clean' ? null : w.turn,
      nTurns: turns.length, nSteps: d.stepsBySession.get(s.id)?.length ?? 0, nEpisodes: eps.length,
      nAttention: eps.filter((e) => e.section === 'blocked' || e.section === 'unrecovered').length,
      silentChildren: d.delegations.filter((x) => x.sessionId === s.id && x.silent).length,
      unverifiedClaims: d.claims.filter((c) => c.sessionId === s.id && UNVERIFIED_CLAIMS.includes(c.evidence)).length,
      unattended: s.role !== 'main' || turns.some((t) => t.unattended), lastTs,
    });
  }
}
