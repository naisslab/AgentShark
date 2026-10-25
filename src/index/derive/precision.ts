// Historical local audit of the versioned rules (SPEC §12.10 acceptance 4): hand-checked index samples and alarm
// replay. These figures do not estimate performance on a new corpus. Synthetic regression tests do not update them.
// Unchecked heuristics can remain advisory labels; canNotify requires structural evidence or a passing audit.
// `<rule>/<state>` keys hold the audit of one label state (a claim's evidence, a delegation's told or silent).

export const LABEL_MIN = 0.8;

export interface Precision {
  /** Share of the checked items the rule got right, 0..1. */
  precision: number;
  /** Items checked. */
  checked: number;
}

const p = (precision: number, checked: number): Precision => ({ precision, checked });

export interface RuleAudit {
  basis: 'logged' | 'deterministic' | 'heuristic';
  validation: 'structural' | 'measured' | 'unvalidated' | 'suppressed';
  advisory: boolean;
}
const LOGGED_RULES = new Set(['flag@1', 'inner@1', 'api@1', 'policy@1', 'hook@1', 'process@1']);
const DETERMINISTIC_RULES = new Set(['target@2', 'sigv2', 'process-exit@1', 'near-3-calls@1']);

/** Empirical precision and structural observations are different evidence. Missing audits are never reported as 100%. */
export function ruleAudit(rule: string): RuleAudit {
  const basis = LOGGED_RULES.has(rule) ? 'logged' : DETERMINISTIC_RULES.has(rule) ? 'deterministic' : 'heuristic';
  const measured = PRECISION[rule];
  const validation = measured ? measured.precision >= LABEL_MIN ? 'measured' : 'suppressed' : basis === 'heuristic' ? 'unvalidated' : 'structural';
  return { basis, validation, advisory: validation === 'unvalidated' };
}

/** Historical local audit of the 2026-10-12 index. Rules without an entry have no empirical audit. */
export const PRECISION: Readonly<Record<string, Precision>> = {
  'traceback@2': p(0.95, 20),
  // The tests-failed@1 sample's items that tests-failed@2 still marks.
  'tests-failed@2': p(1, 22),
  'not-found@1': p(0.96, 50),
  // Every row of the rule on the index.
  'timeout@3': p(1, 8),
  // 49 of 50 were incidental denials (mostly git's xcrun cache warning) in commands that exited 0.
  'sandbox@2': p(0.02, 50),
  // A seeded draw of the 104 failure rows sigv2 moves to the sandbox family: 29 failed on the denial (a module cache, a
  // temporary directory); one only quoted a denial in a review report. Denied log files are excluded: those runs failed
  // on something else.
  'sandbox-line@1': p(0.97, 30),
  'benign-exit@1': p(1, 50),
  'process-running@1': p(1, 50),
  'process-exit@1': p(1, 50),
  'shell-mention@1': p(0.99, 100),
  'correction@1': p(0.94, 100),
  // 48 of 50 were the agent's own shell edits or a sibling agent's, not the human.
  'external-edit@1': p(0.04, 50),
  'near-3-calls@1': p(1, 50),
  'claim@1': p(0.96, 50),
  'claim@1/passed-after-last-edit': p(0.98, 50),
  'claim@1/edited-after-last-test': p(1, 50),
  'claim@1/last-test-failed': p(0.9, 20),
  'claim@1/no-test-in-turn': p(0.88, 50),
  'claim@1/unknown': p(0.85, 13),
  'parent-told@2': p(1, 40),
  'parent-told@2/told': p(1, 20),
  'parent-told@2/silent': p(1, 20),
  // The alarm marks a silent child: the parent-told@2/silent sample.
  'silent-child@1': p(1, 20),
  // Offline replay: ended turns where the alarm fired that ended failed, blocked or interrupted.
  'consecutive@1': p(0.88, 135),
  'blocker@1': p(0.91, 369),
};

/** Whether a label from this rule (or `<rule>/<state>`) may be shown: unchecked, or checked at LABEL_MIN or better. */
export function ships(rule: string): boolean {
  const c = PRECISION[rule];
  return !c || c.precision >= LABEL_MIN;
}

/** Notifications require a logged/deterministic observation or a measured passing rule; missing audits never pass. */
export function canNotify(rule: string): boolean {
  const audit = ruleAudit(rule);
  return audit.validation === 'structural' || audit.validation === 'measured';
}
