// Stores one tree's derived rows: delete the tree's rows from every per-session derived table, insert the new ones.

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { TreeRows } from './pool.ts';

/** Per-session derived tables (schema.sql); `signatures` is aggregated separately. */
export const SESSION_TABLES = [
  'steps', 'step_events', 'failures', 'episodes', 'episode_attempts', 'turn_rollup', 'session_rollup', 'delegations',
  'processes', 'process_events', 'changes', 'interventions', 'claims', 'alarms', 'call_stats', 'call_keys', 'session_stats',
] as const;

type Row = Record<string, unknown>;

/** Insert order and columns per table; values come from the camelCase row fields. */
const COLUMNS: Record<string, string[]> = {
  steps: ['id', 'session_id', 'turn_id', 'n', 'llm_span_id', 'start_ts', 'end_ts', 'ctx_tokens', 'ctx_window', 'ctx_window_src', 'tok_out', 'tok_uncached',
    'n_calls', 'n_fail', 'model_us', 'model_src', 'tool_us', 'intent', 'intent_src', 'compaction_before', 'attachments', 'seg_src'],
  step_events: ['rid', 'step_id', 'session_id'],
  failures: ['rid', 'session_id', 'turn_id', 'step_id', 'call_rid', 'ts', 'tier', 'source', 'rule', 'family', 'class', 'sig_id', 'target_key', 'exit_code',
    'exit_src', 'error_line', 'episode_id', 'attempt'],
  episodes: ['id', 'session_id', 'root_id', 'turn_id', 'target_key', 'sig_id', 'family', 'class', 'tier', 'opener_rid', 'last_rid', 'closer_rid', 'n_attempts',
    'first_step', 'last_step', 'n_steps', 'start_ts', 'end_ts', 'wall_us', 'wall_src', 'tok_out', 'tok_in_ub', 'outcome', 'outcome_src', 'actor', 'loop',
    'blind', 'corrected', 'unattended', 'section'],
  episode_attempts: ['episode_id', 'n', 'session_id', 'rid', 'step_id', 'gap_us', 'gap_steps', 'change_class', 'similarity', 'edits', 'reread', 'parallel'],
  turn_rollup: ['turn_id', 'session_id', 'root_id', 'n', 'origin', 'start_ts', 'end_ts', 'last_ts', 'open', 'waiting', 'impact', 'impact_basis', 'n_steps',
    'n_episodes', 'n_unrecovered', 'claim_evidence', 'unattended', 'wall_us', 'wall_src', 'call_kinds'],
  session_rollup: ['session_id', 'root_id', 'worst_impact', 'worst_rank', 'worst_turn', 'n_turns', 'n_steps', 'n_episodes', 'n_attention', 'silent_children',
    'unverified_claims', 'unattended', 'last_ts'],
  delegations: ['id', 'session_id', 'parent_turn', 'parent_step', 'child_session', 'kind', 'task_excerpt', 'outcome', 'outcome_src', 'child_impact',
    'parent_told', 'silent', 'result_rid', 'tok_in_tree', 'tok_out_tree', 'parent_wait_us', 'start_ts', 'end_ts', 'task_chars'],
  processes: ['id', 'session_id', 'proc_key', 'open_rid', 'close_rid', 'program', 'n_polls', 'n_inputs', 'exit_code', 'exit_src', 'status', 'start_ts', 'end_ts'],
  process_events: ['rid', 'process_id', 'session_id', 'role'],
  changes: ['rid', 'path', 'session_id', 'turn_id', 'step_id', 'ts', 'op', 'src', 'added', 'removed', 'outside_cwd'],
  interventions: ['rid', 'session_id', 'turn_id', 'step_id', 'ts', 'kind', 'actor', 'actor_src', 'wait_us', 'near_episode'],
  claims: ['turn_id', 'session_id', 'final_rid', 'ts', 'evidence', 'rule', 'test_rid', 'last_edit_rid', 'pattern'],
  alarms: ['id', 'session_id', 'turn_id', 'kind', 'rule', 'first_ts', 'last_ts', 'episode_id', 'delegation_id', 'notify', 'cleared_ts'],
  call_stats: ['session_id', 'kind', 'key', 'calls', 'durs', 'dur_src', 'tiers', 'first_ts', 'last_ts'],
  call_keys: ['span_id', 'session_id', 'kind', 'key'],
  session_stats: ['session_id', 'kind', 'key', 'n', 'bytes', 'durs', 'tokens'],
};

const camel = (c: string) => c.replace(/_(\w)/g, (_m, x: string) => x.toUpperCase());

function value(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number;
}

export class DeriveWriter {
  private readonly del: StatementSync[];
  private readonly addTree: StatementSync;
  private readonly treeAlarms: StatementSync;
  private readonly ins = new Map<string, { st: StatementSync; keys: string[] }>();
  private readonly db: DatabaseSync;
  private bulkIndexes: { name: string; sql: string }[] = [];

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('CREATE TEMP TABLE IF NOT EXISTS derive_tree (id TEXT PRIMARY KEY)');
    this.del = SESSION_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE session_id IN (SELECT id FROM temp.derive_tree)`));
    this.addTree = db.prepare('INSERT OR IGNORE INTO temp.derive_tree (id) VALUES (?)');
    this.treeAlarms = db.prepare('SELECT id, cleared_ts FROM alarms WHERE session_id IN (SELECT value FROM json_each(?))');
    for (const [table, cols] of Object.entries(COLUMNS)) {
      this.ins.set(table, {
        st: db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`),
        keys: cols.map(camel),
      });
    }
  }

  /** Delete every derived row of these sessions (also sessions that no longer exist). */
  clear(sessionIds: Iterable<string>): void {
    this.db.exec('DELETE FROM temp.derive_tree');
    for (const id of sessionIds) this.addTree.run(id);
    for (const st of this.del) st.run();
  }

  /** Stored alarm ids with their cleared_ts: of these sessions, or of every session. */
  alarmStates(sessions?: string[]): Map<string, number | null> {
    const rows = (sessions ? this.treeAlarms.all(JSON.stringify(sessions)) : this.db.prepare('SELECT id, cleared_ts FROM alarms').all()) as {
      id: string; cleared_ts: number | null;
    }[];
    return new Map(rows.map((r) => [r.id, r.cleared_ts]));
  }

  /** After a pass over every tree: rows of sessions that left the index. */
  dropOrphans(): void {
    for (const t of SESSION_TABLES) this.db.exec(`DELETE FROM ${t} WHERE session_id NOT IN (SELECT id FROM sessions)`);
  }

  /**
   * Before a pass that derives every tree: empty every per-session table and drop their secondary indexes, which
   * endBulk() re-creates from their stored SQL (building an index once is faster than maintaining it per row).
   */
  beginBulk(): void {
    for (const t of SESSION_TABLES) this.db.exec(`DELETE FROM ${t}`);
    const list = SESSION_TABLES.map((t) => `'${t}'`).join(', ');
    this.bulkIndexes = this.db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${list})`)
      .all() as { name: string; sql: string }[];
    for (const i of this.bulkIndexes) this.db.exec(`DROP INDEX ${i.name}`);
  }

  endBulk(): void {
    for (const i of this.bulkIndexes) this.db.exec(i.sql);
    this.bulkIndexes = [];
  }

  /** Store one tree's rows; `clear` deletes the tree's old rows first (not needed after beginBulk). */
  write(d: TreeRows, clear = true): void {
    if (clear) this.clear(d.sessions);
    this.insert('steps', d.steps);
    this.insert('step_events', d.stepEvents);
    this.insert('failures', d.failures);
    this.insert('episodes', d.episodes);
    this.insert('episode_attempts', d.attempts);
    this.insert('turn_rollup', d.turnRollup);
    this.insert('session_rollup', d.sessionRollup);
    this.insert('delegations', d.delegations);
    this.insert('processes', d.processes);
    this.insert('process_events', d.processEvents);
    this.insert('changes', d.changes);
    this.insert('interventions', d.interventions);
    this.insert('claims', d.claims);
    this.insert('alarms', d.alarms);
    this.insert('call_stats', d.callStats);
    this.insert('call_keys', d.callKeys);
    this.insert('session_stats', d.sessionStats);
  }

  private insert(table: string, rows: object[]): void {
    const { st, keys } = this.ins.get(table)!;
    for (const r of rows as Row[]) st.run(...keys.map((k) => value(r[k])));
  }
}
