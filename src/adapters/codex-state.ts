// Codex `~/.codex/state_5.sqlite` (SPEC §4.3): one enrich record per thread (title, archive state,
// cumulative tokens, model, rollout path, subagent identity) plus parent links from thread_spawn_edges.
// The database is one source with no events; rollouts stay the source of truth for sessions.

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Adapter, type ParseStats, agentRoots, emptyStats, fileInfo, secToUs } from './adapter.ts';

/**
 * Open an agent-owned SQLite file without touching it (SPEC §2.1). `immutable=1` reads the main file
 * only, so rows still in an un-checkpointed WAL are not visible.
 */
export function openReadOnly(path: string): DatabaseSync {
  const url = pathToFileURL(path);
  url.search = '?immutable=1';
  return new DatabaseSync(url, { readOnly: true });
}

// Columns copied into enrich meta. first_user_message is never read: it is the user's prompt.
const META_COLUMNS = [
  'archived', 'archived_at', 'tokens_used', 'model', 'reasoning_effort', 'git_branch', 'rollout_path',
  'agent_nickname', 'agent_role', 'agent_path',
] as const;

export const codexStateAdapter: Adapter = {
  name: 'codex-state',

  async discover(env) {
    if (env.agents && !env.agents.includes('codex')) return [];
    const files = await Promise.all(agentRoots(env, 'codex').map((root) =>
      fileInfo(join(root, 'state_5.sqlite'), 'codex', 'state-db', 'codex-state')));
    return files.filter((f) => f !== null);
  },

  async parse(ctx, sink) {
    const stats: ParseStats = { ...emptyStats(), parsedBytes: ctx.file.size };
    const db = openReadOnly(ctx.file.path);
    try {
      const has = (table: string) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name as string));
      const threadCols = has('threads');
      if (!threadCols.has('id')) return stats;
      if (has('_sqlx_migrations').has('version')) {
        const m = db.prepare('SELECT max(version) AS v FROM _sqlx_migrations').get() as { v: number | null } | undefined;
        if (m?.v != null) stats.dialect = `state_5 migration ${m.v}`;
      }

      const parents = new Map<string, string>();
      const edgeCols = has('thread_spawn_edges');
      if (edgeCols.has('parent_thread_id') && edgeCols.has('child_thread_id')) {
        for (const e of db.prepare('SELECT parent_thread_id AS p, child_thread_id AS c FROM thread_spawn_edges').iterate() as Iterable<any>) {
          if (e.p && e.c) parents.set(e.c, e.p);
        }
      }

      // Older schemas lack some columns; select only the ones present.
      const cols = ['id', 'title', 'name', ...META_COLUMNS].filter((c) => threadCols.has(c));
      for (const row of db.prepare(`SELECT ${cols.join(', ')} FROM threads`).iterate() as Iterable<any>) {
        stats.lines++;
        const id = row.id as string;
        const title = nonEmpty(row.name) ?? nonEmpty(row.title);
        const parent = parents.get(id);
        parents.delete(id);
        const meta: Record<string, unknown> = {};
        if (title) meta.title = title;
        for (const c of META_COLUMNS) {
          const v = row[c];
          if (v == null || v === '') continue;
          meta[c] = c === 'archived' ? v === 1 : c === 'archived_at' ? secToUs(v) : v;
        }
        sink.emit({
          rec: 'enrich',
          session: `cx:${id}`,
          fields: { ...(title && { title }), ...(parent && { parentId: `cx:${parent}` }) },
          meta,
        });
      }
      // Spawn edges whose child thread has no row (yet) still carry the parent link.
      for (const [child, parent] of parents) {
        sink.emit({ rec: 'enrich', session: `cx:${child}`, fields: { parentId: `cx:${parent}` }, meta: {} });
      }
    } finally {
      db.close();
    }
    return stats;
  },
};

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}
