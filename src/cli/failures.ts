// `agentshark failures` and `agentshark sig` (SPEC §12.6): the failure queue and error lookup for the terminal. With
// --json they print the MCP list_failures and lookup_error output.

import { readFileSync } from 'node:fs';
import { callTool, type McpToolContext } from '../mcp/tools.ts';
import { MCP_LIMITS, type McpToolName } from '../mcp/schemas.ts';
import { type Args, CliError, fmtDur, fmtNum, fmtPct, fmtTime, out, parseInt10, parseTime, shortSession, string, table, write } from './util.ts';
import { openCliContext } from './why.ts';

type Content = Record<string, any>;

async function call(ctx: McpToolContext, name: McpToolName, args: Record<string, unknown>): Promise<Content> {
  const r = await callTool(ctx, name, args);
  if (r.isError) throw new CliError(r.message ?? `${name} failed`, 2);
  return r.structuredContent;
}

const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ');

export async function failures(a: Args): Promise<number> {
  const since = string(a.values.since) ?? '7d';
  const sinceUs = parseTime(since, '--since');
  const session = string(a.values.session);
  const limit = parseInt10(string(a.values.limit), '--limit', 1) ?? MCP_LIMITS.listFailuresMax;
  const { ctx, close } = await openCliContext(a);
  try {
    if (a.values.signatures) {
      const list = ctx.derived.signatures({ since: sinceUs, sort: 'impact', limit, ...(session !== undefined && { session }) });
      await write((a.values.json ? JSON.stringify(list, null, 2) : signaturesTable(list.rows)) + '\n');
      return 0;
    }
    // Pages of list_failures, merged: with --limit up to 20 the JSON is exactly the tool's output.
    const args = { since, section: a.values.all ? 'all' : 'attention', ...(session !== undefined && { session }) };
    const content = await call(ctx, 'list_failures', { ...args, limit: Math.min(limit, MCP_LIMITS.listFailuresMax) });
    while (content.next_cursor && content.episodes.length < limit) {
      const more = await call(ctx, 'list_failures', { ...args, limit: Math.min(limit - content.episodes.length, MCP_LIMITS.listFailuresMax), cursor: content.next_cursor });
      content.episodes.push(...more.episodes);
      content.next_cursor = more.next_cursor;
    }
    const title = a.values.all ? 'Episodes' : 'Episodes needing attention';
    await write((a.values.json ? JSON.stringify(content, null, 2) : episodesTable(content, title, since)) + '\n');
    return 0;
  } finally {
    close();
  }
}

export function episodesTable(c: Content, what: string, since: string): string {
  const head = `${out.bold(what)} since ${since}: ${fmtNum(c.episodes.length)} of ${fmtNum(c.total)}`;
  const notes = c.gaps.map((g: Content) => out.dim(`  note: ${g.message}`));
  if (!c.episodes.length) return [head, ...notes].join('\n');
  const rows = [
    ['TIME', 'SECTION', 'OUTCOME', 'TRIES', 'WALL', 'FAMILY', 'SIGNATURE', 'SESSION', 'EPISODE'].map((h) => out.dim(h)),
    ...c.episodes.map((e: Content) => [
      fmtTime(e.ts).slice(0, 16),
      e.section === 'blocked' || e.section === 'unrecovered' ? out.red(e.section) : e.section,
      e.outcome,
      String(e.attempts),
      e.wall_us == null ? '?' : fmtDur(e.wall_us),
      e.family,
      oneLine(e.signature_excerpt).slice(0, 60),
      shortSession(e.session_id),
      e.id,
    ]),
  ];
  return [head, table(rows, ['l', 'l', 'l', 'r', 'r']), ...notes].join('\n');
}

export function signaturesTable(rows: Content[]): string {
  if (!rows.length) return 'No signatures in this range.';
  return table([
    ['RANK', 'FAILURES', 'SESSIONS', 'UNRECOVERED', 'STATUS', 'FAMILY', 'SIGNATURE', 'ID'].map((h) => out.dim(h)),
    ...rows.map((s) => [
      s.rank.toFixed(1), fmtNum(s.n), fmtNum(s.sessions), s.unrecoveredRate == null ? '' : fmtPct(s.unrecoveredRate, 1),
      s.status, s.family, oneLine(s.text).slice(0, 70), s.id,
    ]),
  ], ['r', 'r', 'r', 'r']);
}

/** `agentshark sig "<text>"`, `agentshark sig sig_…`, or the text on stdin (`-` or no argument). */
export async function sig(a: Args): Promise<number> {
  let text = a.positionals[0];
  if (text === undefined || text === '-') {
    if (text === undefined && process.stdin.isTTY) throw new CliError('pass the error text, a signature id, or - to read it from stdin\nUsage: agentshark sig "<text>"', 2);
    text = readFileSync(0, 'utf8');
  }
  const args = /^sig_[0-9a-f]{12}$/.test(text.trim()) ? { signature_id: text.trim() } : { text };
  const { ctx, close } = await openCliContext(a);
  try {
    const c = await call(ctx, 'lookup_error', args);
    await write((a.values.json ? JSON.stringify(c, null, 2) : lookupText(c)) + '\n');
    return 0;
  } finally {
    close();
  }
}

export function lookupText(c: Content): string {
  const lines: string[] = [];
  const match = c.match === 'exact' ? 'seen before' : c.match === 'family' ? 'not seen; its family is' : 'not seen in this index';
  lines.push(table([
    ['Signature', c.signature ? `${c.signature.id}  ${out.dim(match)}` : out.dim(match)],
    ['Text', c.signature?.text_excerpt ?? c.normalized_excerpt ?? ''],
    ['Family', c.family],
    ['Seen', `${fmtNum(c.sessions)} sessions${c.recovered_rate == null ? '' : ` · ${fmtPct(c.recovered_rate, 1)} recovered`}${c.status ? ` · ${c.status}` : ''}`],
    ['Advice', c.advice_kind],
  ].map(([k, v]) => [out.bold(k), v])));
  if (c.fixes.length) {
    lines.push(out.bold('Observed in past recoveries, not verified:'));
    lines.push(table(c.fixes.map((f: Content) => [`  ${f.kind}`, oneLine(f.pattern_excerpt), `${fmtNum(f.n)} of ${fmtNum(f.of)}`, out.dim(`e.g. ${f.example_episode}`)])));
  }
  for (const g of c.gaps) lines.push(out.dim(`note: ${g.message}`));
  return lines.join('\n');
}
