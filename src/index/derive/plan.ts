// Which sessions an incremental analysis pass derives (SPEC §12.3.1). For each tree that holds a changed session, the
// pass derives: the changed sessions; the sessions whose turns reopen as their tree wakes (a turn span still open whose
// stored turn ended); the sessions whose stored rows name another root; and every session whose rows read theirs (its
// parent, and any session whose span spawned it), up to the root. The rest of the tree keeps its rows, and the sessions
// derived read a child's impact, last turn and episodes from them (TreeLoader `only`, Ses.stored).

import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** One tree of a pass; `only` lists the sessions to derive, null derives the whole tree. */
export interface Unit {
  root: string;
  only: string[] | null;
}

export class Planner {
  private readonly rootOf: StatementSync;
  private readonly tree: StatementSync;
  private readonly reRooted: StatementSync;
  private readonly reopened: StatementSync;
  private readonly spawners: StatementSync;
  private readonly spanOwner: StatementSync;

  constructor(db: DatabaseSync) {
    this.rootOf = db.prepare('SELECT COALESCE(root_id, id) AS r FROM sessions WHERE id = ?');
    this.tree = db.prepare('SELECT id, parent_id, parent_span_id FROM sessions WHERE root_id = ? OR id = ?');
    this.reRooted = db.prepare(`SELECT r.session_id FROM sessions s JOIN session_rollup r ON r.session_id = s.id
      WHERE (s.root_id = ? OR s.id = ?) AND r.root_id <> ?`);
    this.reopened = db.prepare(`SELECT DISTINCT t.session_id FROM sessions s JOIN turn_rollup t ON t.session_id = s.id JOIN spans sp ON sp.id = t.turn_id
      WHERE (s.root_id = ? OR s.id = ?) AND t.open = 0 AND sp.status = 'open'`);
    this.spawners = db.prepare('SELECT DISTINCT session_id FROM spans WHERE link_session = ?');
    this.spanOwner = db.prepare('SELECT session_id FROM spans WHERE id = ?');
  }

  /** The units that derive `seeds`; seeds no longer in the index are `gone`. */
  plan(seeds: Iterable<string>): { units: Unit[]; gone: string[] } {
    const byRoot = new Map<string, Set<string>>();
    const gone: string[] = [];
    for (const sid of new Set(seeds)) {
      const r = (this.rootOf.get(sid) as { r: string } | undefined)?.r;
      if (r === undefined) gone.push(sid);
      else if (byRoot.has(r)) byRoot.get(r)!.add(sid);
      else byRoot.set(r, new Set([sid]));
    }
    return { units: [...byRoot].map(([root, s]) => this.unit(root, s)), gone };
  }

  private unit(root: string, seeds: Set<string>): Unit {
    const rows = new Map((this.tree.all(root, root) as { id: string; parent_id: string | null; parent_span_id: string | null }[]).map((r) => [r.id, r]));
    const ids = (st: StatementSync, ...p: string[]) => (st.all(...p) as { session_id: string }[]).map((r) => r.session_id);
    const set = new Set([...seeds, ...ids(this.reRooted, root, root, root), ...ids(this.reopened, root, root)].filter((id) => rows.has(id)));
    const stack = [...set];
    while (stack.length) {
      const r = rows.get(stack.pop()!)!;
      const owner = r.parent_span_id ? (this.spanOwner.get(r.parent_span_id) as { session_id: string } | undefined)?.session_id : undefined;
      for (const up of [r.parent_id, owner, ...ids(this.spawners, r.id)]) {
        if (up && rows.has(up) && !set.has(up)) {
          set.add(up);
          stack.push(up);
        }
      }
    }
    return { root, only: set.size === rows.size ? null : [...set] };
  }
}
