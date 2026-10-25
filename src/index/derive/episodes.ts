// Failure episodes (SPEC §12.3.5): same-key failures in one turn, until the first ok call with that key in a later
// step; their outcome, attempts and transitions, flags and cost.

import {
  BLOCKED_FAMILIES, type ChangeClass, type EpisodeActor, type EpisodeAttemptRow, type EpisodeOutcome, type EpisodeRow, type EpisodeSection, type Prov,
} from '../../model/types.ts';
import type { Action, Derived, TurnInfo } from './model.ts';
import { provOf } from './steps.ts';
import type { Ses } from './tree.ts';

export const CORRECTION_RULE = 'correction@1';
export const PROCESS_EXIT_RULE = 'process-exit@1';
export const INTERRUPT_ACTOR_RULE = 'interrupt-actor@1';
/** SPEC §12.3.5: the next main-session prompt starts with one of these words. */
export const CORRECTION = /^\s*(?:(?:no|don['’]?t|do not|stop|why|wait|revert|actually)\b|不|别|为什么|等等)/i;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);
const LOOP_MIN = 5;
const BLIND_MIN = 3;

interface Ep {
  key: string;
  attempts: Action[];
  closer: Action | null;
  parallelOk: boolean;
}

export function deriveEpisodes(d: Derived): void {
  for (const s of d.tree.sessions) {
    const actions = d.actions.get(s.id) ?? [];
    if (!actions.some((a) => a.status === 'fail')) continue;
    new SessionEpisodes(d, s, actions).run();
  }
}

class SessionEpisodes {
  private readonly okSeqs = new Map<string, number[]>();
  private readonly edits: { seq: number; files: number }[] = [];
  private readonly reads = new Map<string, number[]>();
  private readonly prompts: { seq: number; text: string }[];
  private readonly d: Derived;
  private readonly s: Ses;
  private readonly actions: Action[];

  constructor(d: Derived, s: Ses, actions: Action[]) {
    this.d = d;
    this.s = s;
    this.actions = actions;
    for (const a of actions) {
      if (a.status === 'ok') for (const k of okKeys(a)) push(this.okSeqs, k, a.seq);
      if (a.status !== 'fail' && EDIT_TOOLS.has(a.tool ?? '') && (a.kind === 'tool' || a.kind === 'item')) {
        const files = (a.call?.a.change as { files?: unknown[] } | undefined)?.files;
        this.edits.push({ seq: a.seq, files: Array.isArray(files) && files.length ? files.length : 1 });
      }
      if (a.status === 'ok' && a.key.startsWith('read:')) push(this.reads, a.key.slice(5), a.seq);
    }
    this.prompts = s.events.filter((e) => e.kind === 'user.prompt').map((e) => ({ seq: e.seq, text: typeof e.a.text === 'string' ? e.a.text : '' }));
  }

  run(): void {
    const byTurn = new Map<string | null, Action[]>();
    for (const a of this.actions) push(byTurn, a.turn, a);
    for (const [turnId, acts] of byTurn) {
      if (acts.some((a) => a.status === 'fail')) this.turn(turnId ? this.d.turns.get(turnId) ?? null : null, acts);
    }
  }

  private turn(t: TurnInfo | null, acts: Action[]): void {
    const open = new Map<string, Ep>();
    const done: Ep[] = [];
    const okSteps = new Map<string, Set<number>>();
    const okInTurn: Action[] = [];
    for (const a of acts) {
      if (a.status === 'fail') {
        const ep = open.get(a.key);
        if (ep) ep.attempts.push(a);
        else open.set(a.key, { key: a.key, attempts: [a], closer: null, parallelOk: a.key !== 'api' && !!a.step && !!okSteps.get(a.key)?.has(a.step.n) });
      } else if (a.status === 'ok') {
        okInTurn.push(a);
        for (const key of okKeys(a)) {
          if (a.step) {
            let set = okSteps.get(key);
            if (!set) okSteps.set(key, (set = new Set()));
            set.add(a.step.n);
          }
          const ep = open.get(key);
          if (!ep) continue;
          const last = ep.attempts[ep.attempts.length - 1];
          if (a.step && last.step ? a.step.n > last.step.n : a.seq > last.seq) {
            ep.closer = a;
            open.delete(key);
            done.push(ep);
          } else if (key !== 'api') ep.parallelOk = true;
        }
      }
    }
    for (const ep of done) this.emit(ep, t, 'recovered', null, ep.closer?.key !== ep.key ? `inferred:${PROCESS_EXIT_RULE}` : null);
    for (const ep of open.values()) {
      const last = ep.attempts[ep.attempts.length - 1];
      const aborted = t !== null && (t.abortSeqs.some((x) => x > last.seq) || (t.interrupted && !t.abortSeqs.length));
      let outcome: EpisodeOutcome;
      let actor: EpisodeActor | null = null;
      if (aborted) {
        outcome = 'interrupted';
        actor = this.s.role === 'main' ? 'human' : 'parent-or-human';
      } else if (ep.parallelOk) outcome = 'parallel-ok';
      else if (laterOk(this.okSeqs.get(ep.key), t ? t.lastSeq : last.seq)) outcome = 'recovered-later';
      else if (t?.open) outcome = 'open';
      else if (okInTurn.some((o) => o.seq > last.seq && o.key !== ep.key && (o.kind === 'tool' || o.kind === 'item'))) outcome = 'pivoted';
      else outcome = 'ended-on-failure';
      this.emit(ep, t, outcome, actor);
    }
  }

  private emit(ep: Ep, t: TurnInfo | null, outcome: EpisodeOutcome, actor: EpisodeActor | null, src: Prov | null = null): void {
    const first = ep.attempts[0];
    const last = ep.attempts[ep.attempts.length - 1];
    const f0 = first.failure!;
    const id = `${this.s.id}#ep:${first.result!.id}`;
    const startTs = (first.call ?? first.result!).ts;
    const end = ep.closer ?? last;
    const endTs = end.ts;
    const wall = this.wall(first, end, ep.attempts.length === 1 && !ep.closer);
    const steps = this.d.stepsBySession.get(this.s.id) ?? [];
    const firstStep = first.step;
    const lastStep = end.step ?? last.step;
    let tokOut: number | null = null;
    let tokIn: number | null = null;
    let nSteps = 0;
    if (firstStep && lastStep && lastStep.n >= firstStep.n) {
      nSteps = lastStep.n - firstStep.n + 1;
      for (let n = firstStep.n; n <= lastStep.n; n++) {
        const st = steps[n - 1];
        if (st?.tokOut != null) tokOut = (tokOut ?? 0) + st.tokOut;
        if (st?.ctxTokens != null) tokIn = (tokIn ?? 0) + st.ctxTokens;
      }
    } else nSteps = new Set(ep.attempts.map((a) => a.step?.n).filter((n) => n !== undefined)).size;
    const attempts = ep.attempts.map((a, i) => this.attempt(id, a, i === 0 ? null : ep.attempts[i - 1], i + 1));
    // The attempts that set `loop` (the LOOP_MINth with one signature) and `blind` (BLIND_MIN identical in a row, no edit).
    let loopAt: number | null = null;
    let blindAt: number | null = null;
    const bySig = new Map<string, number>();
    let run = 0;
    attempts.forEach((at, i) => {
      const sig = ep.attempts[i].failure!.sigId;
      bySig.set(sig, (bySig.get(sig) ?? 0) + 1);
      if (loopAt === null && bySig.get(sig)! >= LOOP_MIN) loopAt = i;
      run = i > 0 && at.changeClass === 'identical' && at.edits === 0 ? run + 1 : 1;
      if (blindAt === null && run >= BLIND_MIN) blindAt = i;
    });
    const loop = loopAt !== null;
    const blind = blindAt !== null;
    this.d.episodeRuns.set(id, { attempts: ep.attempts, closer: ep.closer, loopAt, blindAt });
    const corrected = this.s.role === 'main' && this.corrected(t ? t.lastSeq : last.seq);
    const tier = ep.attempts.some((a) => a.failure!.tier === 'failure') ? 'failure' : 'suspect';
    const row: EpisodeRow = {
      id, sessionId: this.s.id, rootId: this.s.rootId, turnId: t?.id ?? null, targetKey: ep.key, sigId: f0.sigId, family: f0.family, class: f0.class,
      tier, openerRid: first.result!.rid, lastRid: last.result!.rid, closerRid: ep.closer ? (ep.closer.call ?? ep.closer.result!).rid : null,
      nAttempts: ep.attempts.length, firstStep: firstStep?.id ?? null, lastStep: lastStep?.id ?? null, nSteps, startTs, endTs,
      wallUs: wall.us, wallSrc: wall.src, tokOut, tokInUb: tokIn, outcome,
      outcomeSrc: src ?? (actor === 'parent-or-human' ? `inferred:${INTERRUPT_ACTOR_RULE}` : 'derived:outcome') as Prov, actor, loop, blind, corrected,
      unattended: t ? t.unattended : this.s.role !== 'main', section: section(outcome, f0.family, loop, actor),
    };
    this.d.episodes.push(row);
    for (const at of attempts) this.d.attempts.push(at);
    ep.attempts.forEach((a, i) => {
      a.failure!.episodeId = id;
      a.failure!.attempt = i + 1;
    });
  }

  private attempt(episodeId: string, a: Action, prev: Action | null, n: number): EpisodeAttemptRow {
    const row: EpisodeAttemptRow = {
      episodeId, n, sessionId: this.s.id, rid: a.result!.rid, stepId: a.step?.id ?? null, gapUs: null, gapSteps: null,
      changeClass: null, similarity: null, edits: 0, reread: false, parallel: false,
    };
    if (!prev) return row;
    const from = prev.seq;
    const to = (a.call ?? a.result!).seq;
    row.gapUs = Math.max(0, callStart(this.d, a) - prev.ts);
    if (a.step && prev.step) {
      row.gapSteps = a.step.n - prev.step.n;
      row.parallel = a.step.n === prev.step.n;
    }
    if (a.input || prev.input) {
      const c = changeClass(prev.input, a.input);
      row.changeClass = c.cls;
      row.similarity = Math.round(c.sim * 1000) / 1000;
    }
    for (const e of between(this.edits, from, to)) row.edits += e.files;
    const path = /^(?:edit|read):(.+)$/.exec(a.key)?.[1];
    if (path) row.reread = (this.reads.get(path) ?? []).some((s) => s > from && s < to);
    return row;
  }

  /**
   * SPEC §12.3.5 cost: from the start of the first failing call to the result of the closer or of the last attempt. A
   * lone attempt that is its own call (a Codex item, an API error, a hook) measures its own span. Records that share
   * one timestamp, or an item without a logged duration, measure nothing: null, never 0.
   */
  private wall(first: Action, end: Action, alone: boolean): { us: number | null; src: Prov | null } {
    const own = ownSpan(this.d, first);
    if (alone && own) return { us: own.dur, src: provOf(own.durSrc) ?? 'derived' };
    const us = end.ts - callStart(this.d, first);
    return us > 0 ? { us, src: 'derived:ts-gap' } : { us: null, src: null };
  }

  private corrected(afterSeq: number): boolean {
    const next = this.prompts.find((p) => p.seq > afterSeq);
    return !!next && CORRECTION.test(next.text);
  }
}

/** First match of the EPISODE_SECTIONS rules (types.ts). */
function section(outcome: EpisodeOutcome, family: string, loop: boolean, actor: EpisodeActor | null): EpisodeSection {
  if (outcome === 'recovered' || outcome === 'parallel-ok') return 'recovered';
  if (family === 'user-rejected') return 'other';
  if ((BLOCKED_FAMILIES as readonly string[]).includes(family)) return 'blocked';
  if (outcome === 'ended-on-failure' || loop || (outcome === 'interrupted' && actor === 'human') || (outcome === 'pivoted' && family === 'test-failure')) return 'unrecovered';
  return 'other';
}

/** SPEC §12.3.5: `1 − levenshtein / maxlen` over the normalized inputs (≤ 400 characters). */
function changeClass(a: string, b: string): { cls: ChangeClass; sim: number } {
  if (a === b) return { cls: 'identical', sim: 1 };
  const sim = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
  const bare = (s: string) => s.split(' ').filter((t) => !t.startsWith('-')).join(' ');
  if (bare(a) === bare(b)) return { cls: 'flags-only', sim };
  return { cls: sim >= 0.8 ? 'small' : sim >= 0.5 ? 'moderate' : 'rewrite', sim };
}

function levenshtein(a: string, b: string): number {
  if (a.length < b.length) [a, b] = [b, a];
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** The span of an action that is its own call (an item, API error or hook), when the span has a known, non-zero duration. */
function ownSpan(d: Derived, a: Action): { start: number; dur: number; durSrc: string | null } | null {
  const ev = a.call === a.result ? a.result : null;
  const sp = ev?.span ? d.tree.span.get(ev.span) : undefined;
  return sp && sp.start != null && sp.dur != null && sp.dur > 0 && sp.start <= ev!.ts ? { start: sp.start, dur: sp.dur, durSrc: sp.durSrc } : null;
}

/** When an action's call started: its call record, else the start of its own span, else its evidence. */
function callStart(d: Derived, a: Action): number {
  return a.call && a.call !== a.result ? a.call.ts : ownSpan(d, a)?.start ?? a.ts;
}

function laterOk(seqs: number[] | undefined, after: number): boolean {
  return !!seqs && seqs.length > 0 && seqs[seqs.length - 1] > after;
}

function* between<T extends { seq: number }>(list: T[], from: number, to: number): Iterable<T> {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].seq > from) hi = mid;
    else lo = mid + 1;
  }
  for (let i = lo; i < list.length && list[i].seq < to; i++) yield list[i];
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * The keys an ok action closes: its own, and for a poll that saw its process exit 0, the key of the call that opened
 * the process (`proc:<open key>`). A "still running" result is neutral, so the exit is that call's success (SPEC §12.3.3).
 */
function okKeys(a: Action): string[] {
  return a.key.startsWith('proc:') && !a.key.startsWith('proc:#') && a.result?.exit === 0 ? [a.key, a.key.slice(5)] : [a.key];
}
