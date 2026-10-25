// Re-aggregates `signatures` over every failure row after each analysis pass (SPEC §12.4 step 6). The clock-dependent
// status is computed on read (SIGNATURE_STATUSES); this stores what it needs: first/last occurrence, turns_since_last
// (recounted for every signature in every pass) and regressed_ts. Only rows whose values changed are written.

import type { DatabaseSync } from 'node:sqlite';
import type { AgentKind, FailureTier } from '../../model/types.ts';
import { AGENT_PREFIX } from '../../model/types.ts';
import { UNRECOVERED, type SigInfo } from './model.ts';
import { SIG_RULE } from './signature.ts';

const DORMANT_GAP_US = 14 * 86_400_000_000;
const DORMANT_TURNS = 20;
const AGENT_OF = new Map(Object.entries(AGENT_PREFIX).map(([agent, prefix]) => [prefix, agent as AgentKind]));

interface Acc {
  n: number;
  sessions: Set<string>;
  agents: Set<AgentKind>;
  tiers: Partial<Record<FailureTier, number>>;
  times: number[];
  newest: { ts: number; sid: string; callRid: number | null };
  nEpisodes: number;
  nRecovered: number;
  nUnrecovered: number;
  wallLost: number;
}

/** Rebuild every signature row from `failures` and `episodes`; `pass` holds the texts of signatures seen in this pass. */
export function aggregateSignatures(db: DatabaseSync, pass: Map<string, SigInfo>): number {
  const text = new Map<string, SigInfo>(pass);
  for (const r of db.prepare('SELECT id, text, family, class FROM signatures').all() as Record<string, any>[]) {
    if (!text.has(r.id)) text.set(r.id, { text: r.text, family: r.family, class: r.class });
  }
  const acc = new Map<string, Acc>();
  for (const r of db.prepare('SELECT sig_id, session_id, ts, tier, call_rid FROM failures ORDER BY sig_id, ts').iterate() as Iterable<Record<string, any>>) {
    let a = acc.get(r.sig_id);
    if (!a) {
      acc.set(r.sig_id, (a = {
        n: 0, sessions: new Set(), agents: new Set(), tiers: {}, times: [], newest: { ts: -Infinity, sid: r.session_id, callRid: null },
        nEpisodes: 0, nRecovered: 0, nUnrecovered: 0, wallLost: 0,
      }));
    }
    a.n++;
    a.sessions.add(r.session_id);
    const agent = AGENT_OF.get(r.session_id.slice(0, 2));
    if (agent) a.agents.add(agent);
    a.tiers[r.tier as FailureTier] = (a.tiers[r.tier as FailureTier] ?? 0) + 1;
    a.times.push(r.ts);
    if (r.ts >= a.newest.ts) a.newest = { ts: r.ts, sid: r.session_id, callRid: r.call_rid };
  }
  for (const r of db.prepare('SELECT sig_id, outcome, wall_us FROM episodes').iterate() as Iterable<Record<string, any>>) {
    const a = acc.get(r.sig_id);
    if (!a) continue;
    a.nEpisodes++;
    if (r.outcome === 'recovered') a.nRecovered++;
    else if (UNRECOVERED.has(r.outcome)) {
      a.nUnrecovered++;
      a.wallLost += r.wall_us ?? 0;
    }
  }
  const turns = turnStarts(db);
  const kindOf = db.prepare('SELECT tool_kind FROM events WHERE rid = ?');
  const cols = ['id', 'text', 'family', 'class', 'sigv', 'n', 'n_sessions', 'n_episodes', 'n_recovered', 'n_unrecovered', 'wall_lost_us', 'first_ts', 'last_ts',
    'turns_since_last', 'regressed_ts', 'agents', 'rank', 'tier_counts'];
  const stored = new Map((db.prepare(`SELECT ${cols.join(', ')} FROM signatures`).all() as Record<string, unknown>[]).map((r) => [r.id as string, JSON.stringify(cols.map((c) => r[c]))]));
  const upsert = db.prepare(`INSERT OR REPLACE INTO signatures (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const drop = db.prepare('DELETE FROM signatures WHERE id = ?');
  const kept = new Set<string>();
  for (const [id, a] of acc) {
    const t = text.get(id);
    if (!t) continue;
    kept.add(id);
    // Turns of the agent and tool kind of the newest failure that hold a call of that kind.
    const kind = a.newest.callRid !== null ? (kindOf.get(a.newest.callRid) as { tool_kind: string | null } | undefined)?.tool_kind ?? null : null;
    const starts = turns.get(`${a.newest.sid.slice(0, 2)}|${kind ?? '*'}`) ?? [];
    const last = a.times[a.times.length - 1];
    let regressed: number | null = null;
    for (let i = a.times.length - 1; i > 0; i--) {
      const [p, q] = [a.times[i - 1], a.times[i]];
      if (q - p >= DORMANT_GAP_US && countBetween(starts, p, q) >= DORMANT_TURNS) {
        regressed = q;
        break;
      }
    }
    const decided = a.nRecovered + a.nUnrecovered;
    const rank = decided ? a.sessions.size * (a.nUnrecovered / decided) : 0;
    const row = [
      id, t.text, t.family, t.class, SIG_RULE, a.n, a.sessions.size, a.nEpisodes, a.nRecovered, a.nUnrecovered, a.wallLost,
      a.times[0], last, countBetween(starts, last, Infinity), regressed, JSON.stringify([...a.agents].sort()), Math.round(rank * 1000) / 1000,
      JSON.stringify(a.tiers),
    ];
    if (stored.get(id) !== JSON.stringify(row)) upsert.run(...row);
  }
  for (const id of stored.keys()) if (!kept.has(id)) drop.run(id);
  return acc.size;
}

/**
 * Start times of the turns that hold a call, per `<agent prefix>|<tool kind>` (and `|*` for any kind), sorted: from
 * the tool kinds the analysis pass stores on each turn (turn_rollup.call_kinds).
 */
function turnStarts(db: DatabaseSync): Map<string, number[]> {
  const seen = new Map<string, Set<number>>();
  const mark = (key: string, start: number) => {
    let s = seen.get(key);
    if (!s) seen.set(key, (s = new Set()));
    s.add(start);
  };
  for (const r of db.prepare('SELECT session_id, start_ts, call_kinds FROM turn_rollup WHERE call_kinds IS NOT NULL').iterate() as Iterable<Record<string, any>>) {
    const prefix = (r.session_id as string).slice(0, 2);
    for (const kind of (r.call_kinds as string).split(' ')) mark(`${prefix}|${kind}`, r.start_ts);
    mark(`${prefix}|*`, r.start_ts);
  }
  const out = new Map<string, number[]>();
  for (const [k, s] of seen) out.set(k, [...s].sort((a, b) => a - b));
  return out;
}

/** Entries strictly between from and to in a sorted list. */
function countBetween(sorted: number[], from: number, to: number): number {
  return lowerBound(sorted, to) - upperBound(sorted, from);
}

function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
