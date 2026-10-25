// Read-only commands over the live index: `list` (tshark-style event lines), `stats` and `fields`.

import type { DatabaseSync } from 'node:sqlite';
import { listFields } from '../filter/fields.ts';
import type { IndexQueries, KindNode, ModelStat, PairStat, StatsSummary, ToolStat, ViewSpec } from '../index/api.ts';
import { defaultIndexPath, IndexOpenError, openIndex } from '../index/db.ts';
import { createQueries } from '../index/queries.ts';
import type { EventRow, TokenUsage } from '../model/types.ts';
import { idleStatus } from '../server/server.ts';
import {
  type Args, CliError, err, filterError, fmtBytes, fmtDur, fmtNum, fmtPct, fmtTime, out, pad, parseInt10, shortSession, string, strings,
  table, tildify, width, write,
} from './util.ts';

const PAGE = 1000;

/** Read-only commands never create, migrate or rebuild an index (and never touch a file that is not one). */
export function openQueries(a: Args): { queries: IndexQueries; db: DatabaseSync; close(): void } {
  const indexPath = string(a.values.index) ?? defaultIndexPath();
  let db;
  try {
    db = openIndex(indexPath, { readOnly: true });
  } catch (e) {
    if (e instanceof IndexOpenError) throw new CliError(e.message.replace(indexPath, tildify(indexPath)));
    throw e;
  }
  return { queries: createQueries(db, { mode: 'live', indexPath, getIndexing: idleStatus }), db, close: () => db.close() };
}

function createView(queries: IndexQueries, spec: ViewSpec) {
  try {
    return queries.createView(spec);
  } catch (e) {
    throw filterError(e, spec.filter ?? '') ?? e;
  }
}

// ---------------------------------------------------------------------------
// list

export async function list(a: Args): Promise<number> {
  const filter = string(a.values.filter);
  const sessions = strings(a.values.session);
  const limit = parseInt10(string(a.values.limit), '--limit') ?? 1000;
  const all = a.values.all === true;
  const utc = a.values.utc === true;
  const { queries, close } = openQueries(a);
  try {
    const view = createView(queries, {
      filter,
      sessions,
      // One session reads best in file order; several interleave by time.
      sort: sessions?.length === 1 ? 'seq' : 'ts',
      includeInherited: all,
      includeDup: all,
    });
    const total = limit === 0 ? view.count : Math.min(limit, view.count);
    const line = lineFormatter(total, utc);
    const fmt = a.values.json ? (r: EventRow) => JSON.stringify(r) : line;
    if (!a.values.json && total > 0) await write(out.bold(line(null)) + '\n');
    for (let offset = 0; offset < total; offset += PAGE) {
      const rows = queries.viewRows(view.viewId, offset, Math.min(PAGE, total - offset));
      if (!rows.length) break;
      await write(rows.map((r) => fmt(r)).join('\n') + '\n');
    }
    if (total < view.count) console.error(err.dim(`showing ${fmtNum(total)} of ${fmtNum(view.count)} events; use --limit 0 for all`));
    else if (view.count === 0) console.error(err.dim('no events match'));
    return 0;
  } finally {
    close();
  }
}

/** Formatter for the aligned text listing; `null` yields the header line. Δ is the gap to the previous printed event. */
const ALIGNS: ('l' | 'r')[] = ['r', 'l', 'r', 'l', 'l', 'r'];

function lineFormatter(total: number, utc: boolean): (r: EventRow | null) => string {
  // No., Time (with its UTC offset), Δ, Session, Kind, Duration; Summary takes the rest of the line.
  const widths = [Math.max(3, String(total).length), utc ? 25 : 30, 9, 17, 19, 8];
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  let prevTs: number | null = null;
  return (r) => {
    const cells = r
      ? [
          String(r.no ?? ''),
          fmtTime(r.ts, utc),
          prevTs === null ? '0.000' : fmtDelta(r.ts - prevTs),
          shortSession(r.session),
          r.kind,
          fmtDur(r.dur),
        ]
      : ['No.', 'Time', 'Δ', 'Session', 'Kind', 'Duration'];
    if (r) prevTs = r.ts;
    const head = cells.map((c, i) => pad(c, widths[i], ALIGNS[i])).join('  ') + '  ';
    // Keep the summary's own spacing (columns like `Bash  npm test`), but stay on one line.
    let info = r ? r.summary.replace(/[\r\n\t]+/g, ' ') : 'Summary';
    if (columns && width(head) + info.length > columns) info = info.slice(0, Math.max(0, columns - width(head) - 1)) + '…';
    return r ? colorRow(r, head, info) : head + info;
  };
}

function fmtDelta(us: number): string {
  return Math.abs(us) < 1000e6 ? (us / 1e6).toFixed(3) : fmtDur(us);
}

function colorRow(r: EventRow, head: string, info: string): string {
  if (r.flags.includes('error')) return out.red(head + info);
  if (r.flags.includes('inherited') || r.flags.includes('dup')) return out.dim(head + info);
  const layer = r.kind.slice(0, r.kind.indexOf('.'));
  const paint = { user: out.green, llm: out.blue, tool: out.yellow, agent: out.magenta }[layer];
  return paint ? head + paint(info) : head + info;
}

// ---------------------------------------------------------------------------
// stats

const STATS_VIEWS = ['summary', 'tools', 'models', 'kinds', 'pairs'] as const;
type StatsView = (typeof STATS_VIEWS)[number];

export async function stats(a: Args): Promise<number> {
  const name = (string(a.values.view) ?? 'summary') as StatsView;
  if (!STATS_VIEWS.includes(name)) throw new CliError(`--view expects one of ${STATS_VIEWS.join(', ')} (got '${name}')`, 2);
  const filter = string(a.values.filter);
  const sessions = strings(a.values.session);
  const { queries, close } = openQueries(a);
  const show = <T>(data: T, render: (d: T) => string) => console.log(a.values.json ? JSON.stringify(data, null, 2) : render(data));
  try {
    const viewId = filter || sessions ? createView(queries, { filter, sessions }).viewId : undefined;
    if (name === 'summary') show(queries.statsSummary(viewId), renderSummary);
    else if (name === 'tools') show(queries.statsTools(viewId), renderTools);
    else if (name === 'models') show(queries.statsModels(viewId), renderModels);
    else if (name === 'kinds') show(queries.statsKinds(viewId), renderKinds);
    else show(queries.statsPairs(viewId), renderPairs);
    return 0;
  } finally {
    close();
  }
}

const header = (cells: string[]) => cells.map((c) => out.bold(c));

function renderSummary(s: StatsSummary): string {
  const rows = [
    ['Events', fmtNum(s.events)],
    ['Sessions', fmtNum(s.sessions)],
    ['Time span', s.firstTs === null ? '' : `${fmtTime(s.firstTs)} → ${fmtTime(s.lastTs)}  (${fmtDur((s.lastTs ?? s.firstTs) - s.firstTs)})`],
    ['LLM calls', fmtNum(s.llmCalls)],
    ['Tool calls', fmtNum(s.toolCalls)],
    ['Errors', fmtNum(s.errors)],
    ['Tokens', fmtTokens(s.tokens)],
    ['Logged cost', s.loggedCostUsd === null ? 'not logged' : `$${s.loggedCostUsd.toFixed(2)}`],
  ].map(([k, v]) => [out.bold(k), v]);
  const agents = s.byAgent.map((b) => ['  ' + b.agent, `${fmtNum(b.sessions)} sessions`, `${fmtNum(b.events)} events`]);
  return table(rows) + (agents.length ? '\n' + out.bold('By agent') + '\n' + table(agents, ['l', 'r', 'r']) : '');
}

function renderTools({ tools }: { tools: ToolStat[] }): string {
  // A dash marks a duration no call logged or implied; 0 would read as a measured zero.
  const d = (us: number | null) => (us == null ? '—' : fmtDur(us));
  const rows = tools.map((t) => [
    t.tool, t.kind, fmtNum(t.calls), fmtNum(t.errors), fmtPct(t.errors, t.calls), `${fmtNum(t.durKnown)}/${fmtNum(t.calls)}`,
    d(t.p50), d(t.p90), d(t.p99), d(t.max), t.durKnown ? fmtDur(t.total) : '—',
  ]);
  return table([header(['Tool', 'Kind', 'Calls', 'Errors', 'Err%', 'Timed', 'p50', 'p90', 'p99', 'Max', 'Total']), ...rows], ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r']) +
    '\n' + out.dim('Timed: calls with a known duration; the percentiles, Max and Total cover only these.');
}

function renderModels({ models }: { models: ModelStat[] }): string {
  const rows = models.map((m) => [
    m.model, fmtNum(m.calls), fmtNum(m.tokens.input), fmtNum(m.tokens.output), fmtNum(m.tokens.cache_read),
    m.cacheHitRatio === null ? '' : `${(m.cacheHitRatio * 100).toFixed(1)}%`, fmtDur(m.latencyP50), fmtDur(m.latencyP90),
  ]);
  return table([header(['Model', 'Calls', 'Input', 'Output', 'Cache read', 'Cache hit', 'Latency p50', 'p90']), ...rows], ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r']);
}

function renderKinds({ tree }: { tree: KindNode[] }): string {
  const total = tree.reduce((n, k) => n + k.count, 0);
  const rows: string[][] = [];
  const walk = (nodes: KindNode[], depth: number) => {
    for (const k of nodes) {
      rows.push(['  '.repeat(depth) + k.name, fmtNum(k.count), fmtPct(k.count, total), fmtBytes(k.bytes)]);
      walk(k.children, depth + 1);
    }
  };
  walk(tree, 0);
  return table([header(['Kind', 'Events', '%', 'Bytes']), ...rows], ['l', 'r', 'r', 'r']);
}

function renderPairs({ pairs }: { pairs: PairStat[] }): string {
  const rows = pairs.map((p) => [p.a, p.b, fmtNum(p.count), fmtDur(p.dur), fmtNum(p.errors)]);
  return table([header(['A', 'B', 'Count', 'Duration', 'Errors']), ...rows], ['l', 'l', 'r', 'r', 'r']);
}

function fmtTokens(t: TokenUsage): string {
  const parts = (['input', 'uncached', 'cache_read', 'cache_write', 'output', 'reasoning'] as const)
    .filter((k) => t[k] != null)
    .map((k) => `${k.replace('_', ' ')} ${fmtNum(t[k])}`);
  return parts.join(', ') || 'none logged';
}

// ---------------------------------------------------------------------------
// fields

export async function fields(a: Args): Promise<number> {
  const list = listFields();
  if (a.values.json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  const rows = list.map((f) => [f.name, out.dim(f.type), f.description + (f.values?.length ? out.dim(`  (${f.values.join(', ')})`) : '')]);
  console.log(table([[out.bold('Field'), out.bold('Type'), out.bold('Description')], ...rows]));
  return 0;
}
