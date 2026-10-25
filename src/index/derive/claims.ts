// Claim check (SPEC §12.3.8, inferred): a turn whose final llm.text claims success, and what the turn's own verifying
// runs and edits say about it. The runs are those of the claim's kind: test commands for test claims, builds for build
// claims, type checkers for typecheck claims. A deferred run's outcome is its process's exit. A claim is never red.

import type { ClaimEvidence } from '../../model/types.ts';
import { EDIT_OPS } from './changes.ts';
import { shellish } from './failures.ts';
import type { Action, Derived } from './model.ts';
import { type CheckKind, isCheckRun } from './target.ts';
import type { Ev } from './tree.ts';

export const CLAIM_RULE = 'claim@1';

interface Claim {
  /** The lexicon entry (SPEC §12.3.8), stored as ClaimRow.pattern; readers compile it with flag `i`. */
  pattern: string;
  re: RegExp;
  /** The runs that verify it (rule check-run@1). */
  runs: CheckKind;
}
const claim = (pattern: string, re: RegExp, runs: CheckKind): Claim => ({ pattern, re, runs });
const CLAIMS: Claim[] = [
  claim('tests? pass', /\btests? pass/gi, 'test'),
  claim('\\d+ passed', /\b(?!0 )\d+ passed\b/gi, 'test'),
  claim('build (succeeds|passes)', /\bbuild (?:succeeds|passes)\b/gi, 'build'),
  claim('typecheck (passes|is clean)', /\btypecheck (?:passes|is clean)\b/gi, 'typecheck'),
  claim('测试(全部)?通过', /测试(?:全部)?通过/g, 'test'),
];
/** A negation, condition or requirement earlier in the clause ("not all tests pass", "until the tests pass"): no claim. */
const HEDGE_BEFORE = /\b(?:not|never|no longer|until|unless|if|whether|once|so that|make sure|ensure|should|would|will|must|to make)\b|n't\b|不|未|没|如果|直到|保证|确保|应该|需要|必须/i;
/** Failures in the same sentence ("41 passed, 2 failed", "4 failed, 639 passed"): no claim. */
const FAILURES = /\b[1-9]\d* (?:failed|failing|errors?)\b|失败/i;

export function deriveClaims(d: Derived): void {
  const editsBySession = new Map<string, Ev[]>();
  for (const c of d.changes) {
    if (!EDIT_OPS.includes(c.op)) continue;
    const list = editsBySession.get(c.sessionId) ?? [];
    if (list[list.length - 1]?.rid !== c.rid) list.push(d.tree.byRid.get(c.rid)!);
    editsBySession.set(c.sessionId, list);
  }
  for (const s of d.tree.sessions) {
    const finals = new Map<string, Ev>();
    for (const e of s.events) {
      if (e.kind !== 'llm.text' || !e.turn || typeof e.a.text !== 'string') continue;
      // Codex marks its final answer: commentary after it is not the turn's final text.
      const prev = finals.get(e.turn);
      if (!prev || e.a.llm?.phase === 'final_answer' || prev.a.llm?.phase !== 'final_answer') finals.set(e.turn, e);
    }
    const shell = (d.actions.get(s.id) ?? []).filter((a) => (a.kind === 'tool' || a.kind === 'item') && a.call && shellish(a, a.call));
    const edits = (editsBySession.get(s.id) ?? []).sort((a, b) => a.seq - b.seq);
    // Verifying runs of each claim kind, once per session.
    const runsOf = new Map<CheckKind, Action[]>();
    for (const t of d.turnsBySession.get(s.id) ?? []) {
      const fin = finals.get(t.id);
      const c = fin ? claimOf(fin.a.text as string) : null;
      if (!fin || !c) continue;
      if (!runsOf.has(c.runs)) runsOf.set(c.runs, shell.filter((a) => isCheckRun(c.runs, a.key, a.input)));
      const runs = runsOf.get(c.runs)!;
      const inTurn = runs.filter((a) => a.turn === t.id);
      const last = inTurn[inTurn.length - 1] ?? null;
      const lastEdit = edits.filter((e) => e.turn === t.id).pop() ?? null;
      let evidence: ClaimEvidence;
      if (!last) evidence = 'no-test-in-turn';
      else {
        const outcome = runOutcome(d, last);
        evidence = outcome === 'unknown' ? 'unknown' : outcome === 'failed' ? 'last-test-failed'
          : lastEdit && lastEdit.seq > last.call!.seq ? 'edited-after-last-test' : 'passed-after-last-edit';
      }
      // `no-test-in-turn` links the latest earlier run.
      const test = last ?? runs.filter((a) => a.call!.seq < t.firstSeq).pop() ?? null;
      d.claims.push({
        turnId: t.id, sessionId: s.id, finalRid: fin.rid, ts: fin.ts, evidence, rule: CLAIM_RULE, testRid: test?.call?.rid ?? null,
        lastEditRid: lastEdit?.rid ?? null, pattern: c.pattern,
      });
      const tr = d.turnRow.get(t.id);
      if (tr) tr.claimEvidence = evidence;
    }
  }
}

/** The first lexicon entry with a match that no hedge precedes in its clause and no failure count shares a sentence with. */
export function claimOf(text: string): Claim | null {
  for (const c of CLAIMS) {
    c.re.lastIndex = 0;
    for (let m = c.re.exec(text); m; m = c.re.exec(text)) {
      const before = text.slice(Math.max(0, m.index - 80), m.index);
      const sentence = `${before.split(/[.!?\n。！？]/).pop()}${text.slice(m.index, m.index + 120).split(/[.!?\n。！？]/)[0]}`;
      if (!HEDGE_BEFORE.test(before.split(/[.!?;:\n。！？；：]/).pop() ?? '') && !FAILURES.test(sentence)) return c;
    }
  }
  return null;
}

/** `unknown`: no result yet, a still-running result, or a deferred run whose process exit is not logged. */
function runOutcome(d: Derived, a: Action): 'passed' | 'failed' | 'unknown' {
  if (!a.result) return 'unknown';
  const tier = a.failure?.tier;
  if (tier === 'failure' || tier === 'suspect') return 'failed';
  if (tier === 'deferred' || a.opens) {
    const exit = d.processOf.get(a.result.rid)?.exitCode;
    return exit == null ? 'unknown' : exit === 0 ? 'passed' : 'failed';
  }
  return a.status === 'neutral' ? 'unknown' : 'passed';
}
