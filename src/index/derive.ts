// The analysis pass (SPEC §12.3.1, linker pass 6): for each root tree that holds a changed session, recompute the
// derived rows of the changed sessions and of the sessions that read them (derive/plan.ts; every session of every
// tree when the analysis version changed), atomically per tree, then re-aggregate `signatures`. Every concept is one
// file under derive/; deriveTree runs them in dependency order. Time accounting (derive/time.ts) is computed on read.

import type { DatabaseSync } from 'node:sqlite';
import { ALARM_THRESHOLDS, type AlarmRow, type AlarmThresholds, CLAIM_EVIDENCE, type RuleInfo } from '../model/types.ts';
import type { AlarmStreamEvent, AnalysisStatus } from './api.ts';
import { deriveActions } from './derive/actions.ts';
import { deriveCallStats } from './derive/calls.ts';
import { ALARM_RULES, deriveAlarms } from './derive/alarms.ts';
import { deriveChanges, SHELL_MENTION_RULE } from './derive/changes.ts';
import { CLAIM_RULE, deriveClaims } from './derive/claims.ts';
import { deriveDelegations, PARENT_TOLD_RULE } from './derive/delegations.ts';
import { CORRECTION_RULE, deriveEpisodes, INTERRUPT_ACTOR_RULE, PROCESS_EXIT_RULE } from './derive/episodes.ts';
import { deriveFailures, FAILURE_RULE_IDS } from './derive/failures.ts';
import { deriveSessionRollup, deriveTurnRollup } from './derive/impact.ts';
import { deriveInterventions, EXTERNAL_EDIT_RULE, NEAR_EPISODE_RULE } from './derive/interventions.ts';
import { type Derived, newDerived, type SigInfo } from './derive/model.ts';
import { Planner, type Unit } from './derive/plan.ts';
import { derivePooled, POOL_MIN_TREES, poolSize, type TreeOutcome, treeRows } from './derive/pool.ts';
import { PRECISION, ruleAudit } from './derive/precision.ts';
import { deriveProcesses } from './derive/processes.ts';
import { aggregateSignatures } from './derive/signatures.ts';
import { CROSS_TURN_RULE, CTX_WINDOW_RULE, deriveSteps, TRAILING_RULE } from './derive/steps.ts';
import { SANDBOX_LINE_RULE, SIG_RULE } from './derive/signature.ts';
import { CHECK_RUN_RULE, TARGET_RULE } from './derive/target.ts';
import { TreeLoader, type TreeInput } from './derive/tree.ts';
import { deriveTurns, idleOpenSessions, UNATTENDED_RULE } from './derive/turns.ts';
import { DeriveWriter } from './derive/write.ts';

/** Bump when any rule in derive/*.ts changes; stored as meta.analysis_version. */
export const ANALYSIS_VERSION = 14;
export const SIG_VERSION = SIG_RULE;

export interface DeriveOptions {
  /** Changed sessions: they and the sessions that read them are re-derived (derive/plan.ts); undefined = every tree. */
  sessions?: string[];
  /** Live runs pass 3,000: the sessions of trees not started within it move to meta.analysis_pending. */
  budgetMs?: number;
  /** µs; only the window of DeriveResult.alarms reads it, never a row (tests pin it). */
  now?: number;
  /** false: leave meta.last_change_at to the caller, which moves it in the commit that records its run (runIndex). */
  markChange?: boolean;
}

export interface DeriveResult {
  ms: number;
  /** Trees derived in this pass (wholly or in part). */
  roots: number;
  /** Session ids left in meta.analysis_pending. */
  pending: string[];
  /** Alarms that fired or cleared in this pass, with their last evidence within windowMin of `now` (SSE `alarm`). */
  alarms: AlarmStreamEvent[];
  /** Trees whose derivation threw; their old rows were kept. */
  errors?: { root: string; error: string }[];
}

/** One tree, in dependency order: each step reads what the earlier ones added to `d`. */
const PIPELINE: ((d: Derived) => void)[] = [
  deriveTurns, deriveSteps, deriveActions, deriveFailures, deriveCallStats, deriveProcesses, deriveChanges, deriveEpisodes, deriveTurnRollup, deriveDelegations,
  deriveInterventions, deriveClaims, deriveAlarms, deriveSessionRollup,
];

/**
 * Every versioned rule of derive/*.ts, with its hand-checked precision from PRECISION (derive/precision.ts). A
 * `<rule>/<state>` entry carries the figure of one state of the rule's label.
 */
export const RULES: RuleInfo[] = [
  rule(FAILURE_RULE_IDS.flag, 'Tool result carries the logged error flag'),
  rule(FAILURE_RULE_IDS.inner, 'Codex inner tool.exec item failed under a code-mode exec that did not fail'),
  rule(FAILURE_RULE_IDS.api, 'API error or model refusal (llm.error, llm.refusal)'),
  rule(FAILURE_RULE_IDS.policy, 'Approval rejection, hook block or Cowork deny'),
  rule(FAILURE_RULE_IDS.hook, "The user's own hook command failed"),
  rule(FAILURE_RULE_IDS.process, 'A poll of a background process returned a non-zero exit'),
  rule(FAILURE_RULE_IDS.traceback, 'A Python traceback block (header at a line start, then a frame) in an unflagged result of a command that neither views a file nor names a log'),
  rule(FAILURE_RULE_IDS['tests-failed'], 'Test summary reports failures in an unflagged test command'),
  rule(FAILURE_RULE_IDS['not-found'], '"command not found" in an unflagged result (not which/command -v)'),
  rule(FAILURE_RULE_IDS.timeout, 'A timeout reported at a line start (curl error 28, TimeoutExpired, "Command timed out") in an unflagged result of a command that neither views a file nor names a log'),
  rule(FAILURE_RULE_IDS.sandbox, 'Sandbox or "Operation not permitted" text in an unflagged result that is not a file read (below 0.8: marks nothing)'),
  rule(SANDBOX_LINE_RULE, 'A failed command (non-zero exit) whose output holds a canonical sandbox denial (a path: Operation not permitted, a here-document temp file, no usable temporary directory) signs as that denial'),
  rule(FAILURE_RULE_IDS.benign, 'Exit 1 with empty output from a no-match or test program (rg, grep, ps, test, diff, …)'),
  rule(FAILURE_RULE_IDS.deferred, 'Result says "Process running with session ID N": the outcome arrives later'),
  rule(TARGET_RULE, 'Target key of a call (SPEC §12.3.4)'),
  rule(CHECK_RUN_RULE, 'A call runs tests, a build or a type check when its program says so (pytest, npm test, cargo test, tsc, ...), not its command text'),
  rule(CROSS_TURN_RULE, 'Codex call whose next usage is in a later turn joins its own turn\'s last step'),
  rule(TRAILING_RULE, 'Codex calls after the last usage form a trailing step'),
  rule(CTX_WINDOW_RULE, 'Claude context window: 1M if the session ever exceeds 200k tokens, else 200k'),
  rule(CORRECTION_RULE, 'Next main-session prompt starts like a correction (no, don\'t, stop, why, wait, revert, actually, 不, 别, 为什么, 等等)'),
  rule(INTERRUPT_ACTOR_RULE, 'An interrupt in a child session was the parent or a human'),
  rule(PROCESS_EXIT_RULE, 'A poll that sees a background process exit 0 recovers the episode of the call that opened it'),
  rule(UNATTENDED_RULE, 'Role is not main, a Codex goal is active, or approval is never with no prompt in the last 3 turns'),
  rule(PARENT_TOLD_RULE, 'A failed child: the result the parent saw is flagged, carries a failed status, lists the workflow agent under its failures, or (not a workflow) mentions a failure'),
  rule(`${PARENT_TOLD_RULE}/told`, 'Parent told: the result the parent saw names the failure of a failed child'),
  rule(`${PARENT_TOLD_RULE}/silent`, 'Silent child: the child failed or was blocked, and the result the parent saw does not say so'),
  rule(SHELL_MENTION_RULE, 'A shell command names a path next to sed -i, >, tee, mv, cp, rm or git checkout|restore (never a diff)'),
  rule(EXTERNAL_EDIT_RULE, 'An edited_text_file attachment means the human edited the file (below 0.8: no intervention row)'),
  rule(NEAR_EPISODE_RULE, 'An intervention is associated with the episode of the newest failure within 3 calls (association only)'),
  rule(CLAIM_RULE, 'The turn\'s final text claims success (tests pass, N passed, build succeeds, typecheck passes, 测试通过), unhedged'),
  ...CLAIM_EVIDENCE.map((e) => rule(`${CLAIM_RULE}/${e}`, `Claim evidence "${e}" from the turn's check runs (check-run@1) and edits`)),
  rule(ALARM_RULES.consecutive, 'Consecutive non-benign failures with no clean tool result between them (offline replay)'),
  rule(ALARM_RULES.blocker, 'Sandbox, policy or network failures in one turn whose episodes have not all closed (offline replay)'),
  rule(ALARM_RULES.loop, 'An episode reached the loop threshold (5 attempts with one signature)'),
  rule(ALARM_RULES['blind-loop'], 'An episode reached 3 identical attempts with no edit between them'),
  rule(ALARM_RULES['silent-child'], 'The parent saw a child result that hid the child\'s failure'),
  // Computed on read by derived-queries.ts (it depends on the clock); registered here with every other rule.
  rule('stall@1', 'An open turn wrote nothing for stallMin minutes and waits on no running process or question'),
];

function rule(id: string, description: string): RuleInfo {
  const c = PRECISION[id];
  return { rule: id as RuleInfo['rule'], description, precision: c?.precision ?? null, checked: c?.checked ?? null, ...ruleAudit(id) };
}

/** Units derived on this connection, in order; a unit whose rules throw yields its error and writes nothing. */
function* inProcess(loader: TreeLoader, units: Unit[], thresholds: AlarmThresholds): Generator<TreeOutcome> {
  for (const u of units) yield deriveUnit(loader, u, thresholds);
}

/** One unit's rows (this connection, the pool's workers), or the error its rules threw. */
export function deriveUnit(loader: TreeLoader, u: Unit, thresholds: AlarmThresholds): TreeOutcome {
  try {
    return treeRows(deriveTree(loader.load(u.root, u.only && new Set(u.only)), thresholds));
  } catch (err) {
    return { root: u.root, error: String((err as Error)?.stack ?? err) };
  }
}

/** All concepts of one tree, in memory (this connection, the pool's workers, tests). */
export function deriveTree(tree: TreeInput, thresholds: AlarmThresholds = ALARM_THRESHOLDS): Derived {
  const d = newDerived(tree, thresholds);
  for (const step of PIPELINE) step(d);
  return d;
}

/** How long trees share one commit in a long pass. */
const GROUP_COMMIT_MS = 500;

export function runDerive(db: DatabaseSync, opts: DeriveOptions = {}): DeriveResult {
  const t0 = performance.now();
  const meta = readMeta(db);
  const outdated = meta.analysis_version !== String(ANALYSIS_VERSION) || meta.sig_version !== SIG_VERSION;
  const pendingBefore = parseList(meta.analysis_pending);
  const thresholds = alarmThresholds(meta);
  // Alarm changes are reported when their last evidence lies within the window.
  const since = (opts.now ?? Date.now() * 1000) - thresholds.windowMin * 60_000_000;
  const alarms: AlarmStreamEvent[] = [];
  const writer = new DeriveWriter(db);
  let units: Unit[];
  const everyTree = opts.sessions === undefined || outdated;
  if (everyTree) {
    // Largest trees first, so the longest tree does not finish last.
    units = (db.prepare('SELECT COALESCE(root_id, id) AS r FROM sessions GROUP BY r ORDER BY SUM(n_events) DESC, r').all() as { r: string }[])
      .map((x) => ({ root: x.r, only: null }));
  } else {
    // Sessions whose open turn went idle are derived again, so their turns end as in a pass over every tree.
    const plan = new Planner(db).plan([...pendingBefore, ...(opts.sessions ?? []), ...idleOpenSessions(db, thresholds)]);
    // Sessions that left the index keep no derived rows.
    if (plan.gone.length) inTransaction(db, () => writer.clear(plan.gone));
    units = plan.units;
  }
  const errors: { root: string; error: string }[] = [];
  const pass = new Map<string, SigInfo>();
  const written = new Set<string>();
  let derived = 0;
  let groupStart = performance.now();
  // Inside a caller's transaction (a capture import) trees write into it; otherwise trees share commits.
  const outer = db.isTransaction;
  let open = outer;
  // A full pass uses one transaction, but replaces only successfully derived trees. Clearing all tables first
  // would discard a failed tree's last good analysis and make an incomplete rebuild look clean.
  const fresh = everyTree && opts.budgetMs === undefined;
  // Workers read committed data only, so a pass inside the caller's transaction stays on this connection.
  const path = outer ? null : db.location();
  const outcomes: Iterable<TreeOutcome> = path && units.length >= POOL_MIN_TREES
    ? derivePooled(path, units, poolSize(units.length), thresholds)
    : inProcess(new TreeLoader(db), units, thresholds);
  const overBudget = () => opts.budgetMs !== undefined && performance.now() - t0 > opts.budgetMs;
  try {
    // Read the previous alarm states once for a full pass, before successful trees replace their rows.
    const before = fresh ? writer.alarmStates() : null;
    if (fresh) {
      if (!open) db.exec('BEGIN');
      open = true;
    }
    // The budget is checked before each tree starts (a live run passes 3,000 ms); trees not started wait in pending.
    const it = outcomes[Symbol.iterator]();
    while (!overBudget()) {
      const next = it.next();
      if (next.done) break;
      const out = next.value;
      if ('error' in out) {
        errors.push(out);
        continue;
      }
      if (!open) {
        db.exec('BEGIN');
        open = true;
        groupStart = performance.now();
      }
      const old = before ?? writer.alarmStates(out.sessions);
      writer.write(out);
      alarms.push(...alarmChanges(old, out.alarms, since));
      for (const [id, s] of out.sigs) pass.set(id, s);
      written.add(out.root);
      derived++;
      if (!outer && !fresh && performance.now() - groupStart >= GROUP_COMMIT_MS) {
        db.exec('COMMIT');
        open = false;
      }
    }
    it.return?.();
    const treeOf = db.prepare('SELECT id FROM sessions WHERE root_id = ? OR id = ?');
    const pending = units.filter((u) => !written.has(u.root))
      .flatMap((u) => u.only ?? (treeOf.all(u.root, u.root) as { id: string }[]).map((r) => r.id));
    if (!open) db.exec('BEGIN');
    open = true;
    if (everyTree) writer.dropOrphans();
    if (derived || outdated) aggregateSignatures(db, pass);
    const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    put.run('analysis_version', String(ANALYSIS_VERSION));
    put.run('sig_version', SIG_VERSION);
    if (pending.length) put.run('analysis_pending', JSON.stringify(pending));
    else db.prepare("DELETE FROM meta WHERE key = 'analysis_pending'").run();
    const failed = new Map(readFailures(meta.analysis_failed).map((e) => [e.root, e]));
    for (const root of written) failed.delete(root);
    for (const e of errors) failed.set(e.root, { root: e.root, error: e.error.split('\n')[0] });
    // Removed roots no longer need retry; retaining their error would make the index permanently stale.
    for (const root of failed.keys()) if (!treeOf.get(root, root)) failed.delete(root);
    if (failed.size) put.run('analysis_failed', JSON.stringify([...failed.values()]));
    else db.prepare("DELETE FROM meta WHERE key = 'analysis_failed'").run();
    const ms = performance.now() - t0;
    put.run('analysis_ms', String(Math.round(ms)));
    if (derived && opts.markChange !== false) put.run('last_change_at', String(Date.now() * 1000));
    if (!outer) db.exec('COMMIT');
    open = false;
    return { ms, roots: derived, pending, alarms, ...(errors.length ? { errors } : {}) };
  } catch (err) {
    if (open && !outer && db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

type AlarmState = Pick<AlarmRow, 'id' | 'kind' | 'sessionId' | 'turnId' | 'episodeId' | 'delegationId' | 'notify' | 'lastTs' | 'clearedTs'>;

/** A new alarm that holds fires; a stored one that held and now has cleared_ts clears. Only those after `since`. */
function alarmChanges(old: Map<string, number | null>, rows: AlarmState[], since: number): AlarmStreamEvent[] {
  const out: AlarmStreamEvent[] = [];
  for (const r of rows) {
    if (r.lastTs < since) continue;
    const was = old.get(r.id);
    const state = r.clearedTs === null ? (was === undefined ? 'firing' : null) : was === null ? 'cleared' : null;
    if (state) out.push({ id: r.id, kind: r.kind, sessionId: r.sessionId, turnId: r.turnId, episodeId: r.episodeId, delegationId: r.delegationId, state, notify: r.notify });
  }
  return out;
}

/**
 * SSE `alarm` for servers (SPEC §6): the alarms that fired or cleared between two reads of the stored rows, by the rule
 * of DeriveResult.alarms. Every server reading an index reports the same transitions, whichever process derived them.
 * Read-only connections may use it; an index without the alarms table (schema 3) has none.
 */
export class AlarmTracker {
  private states = new Map<string, number | null>();

  /** Start from the stored rows: alarms already stored are never reported as new. */
  reset(db: DatabaseSync): void {
    this.states = new Map(readAlarms(db).map((r) => [r.id, r.clearedTs]));
  }

  changes(db: DatabaseSync, now = Date.now() * 1000): AlarmStreamEvent[] {
    const rows = readAlarms(db);
    const since = now - alarmThresholds(readMeta(db)).windowMin * 60_000_000;
    const out = alarmChanges(this.states, rows, since);
    this.states = new Map(rows.map((r) => [r.id, r.clearedTs]));
    return out;
  }
}

function readAlarms(db: DatabaseSync): AlarmState[] {
  try {
    return (db.prepare(`SELECT id, kind, session_id AS sessionId, turn_id AS turnId, episode_id AS episodeId, delegation_id AS delegationId,
        notify, last_ts AS lastTs, cleared_ts AS clearedTs FROM alarms`).all() as unknown as (Omit<AlarmState, 'notify'> & { notify: number })[])
      .map((r) => ({ ...r, notify: !!r.notify }));
  } catch {
    return [];
  }
}

/** Reads meta; read-only connections may call it. */
export function analysisStatus(db: DatabaseSync): AnalysisStatus {
  const meta = readMeta(db);
  const version = meta.analysis_version !== undefined ? Number(meta.analysis_version) : null;
  const lastMs = meta.analysis_ms !== undefined ? Number(meta.analysis_ms) : null;
  return {
    version: Number.isFinite(version) ? version : null, expected: ANALYSIS_VERSION, sigVersion: meta.sig_version ?? null,
    pending: parseList(meta.analysis_pending), lastMs: Number.isFinite(lastMs) ? lastMs : null, alarmThresholds: alarmThresholds(meta), rules: RULES,
    ...(readFailures(meta.analysis_failed).length ? { failed: readFailures(meta.analysis_failed) } : {}),
  };
}

/** P1 (Settings ▸ Alerts): store the thresholds and force the next index run to re-derive every tree. */
export function setAlarmThresholds(db: DatabaseSync, t: Partial<AlarmThresholds>): void {
  const merged = { ...alarmThresholds(readMeta(db)), ...t };
  const valid = Object.fromEntries(Object.entries(merged).filter(([k, v]) => k in ALARM_THRESHOLDS && typeof v === 'number' && v > 0));
  inTransaction(db, () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('alarm_thresholds', ?)").run(JSON.stringify(valid));
    db.prepare("DELETE FROM meta WHERE key = 'analysis_version'").run();
  });
}

/** True when the stored analysis does not match this build (the next run re-derives every tree). */
export function analysisOutdated(db: DatabaseSync): boolean {
  const meta = readMeta(db);
  return meta.analysis_version !== String(ANALYSIS_VERSION) || meta.sig_version !== SIG_VERSION || parseList(meta.analysis_pending).length > 0 || readFailures(meta.analysis_failed).length > 0;
}

function alarmThresholds(meta: Record<string, string>): AlarmThresholds {
  let over: Partial<AlarmThresholds> = {};
  try {
    over = meta.alarm_thresholds ? JSON.parse(meta.alarm_thresholds) : {};
  } catch {
    over = {};
  }
  return { ...ALARM_THRESHOLDS, ...over };
}

function readMeta(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key IN ('analysis_version', 'sig_version', 'analysis_pending', 'analysis_failed', 'analysis_ms', 'alarm_thresholds')").all() as {
    key: string; value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function readFailures(v: string | undefined): { root: string; error: string }[] {
  try {
    const rows = JSON.parse(v ?? '[]');
    return Array.isArray(rows) ? rows.filter((r) => typeof r?.root === 'string' && typeof r?.error === 'string') : [];
  } catch { return []; }
}

function parseList(v: string | undefined): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function inTransaction(db: DatabaseSync, fn: () => void): void {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
