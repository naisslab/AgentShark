// Shared CLI helpers: errors, colors, number and time formatting, argument conversion, tables.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { stripVTControlCharacters, styleText } from 'node:util';
import { parseTime as parseIsoTime } from '../filter/compile.ts';
import { AGENT_PREFIX, type AgentKind } from '../model/types.ts';

export { fmtBytes, fmtDur } from '../model/format.ts';

/** An expected failure: printed as one friendly line, without a stack trace. */
export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Parsed command line: option values by long name, plus positionals. */
export interface Args {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return String(pkg.version);
}

// ---------------------------------------------------------------------------
// Output

type Style = Parameters<typeof styleText>[0];

/** Color helpers for one stream; styleText drops the codes unless the stream is a TTY (and honors NO_COLOR). */
function painter(stream: NodeJS.WriteStream = process.stdout) {
  const paint = (style: Style) => (s: string) => styleText(style, s, { stream });
  return {
    bold: paint('bold'),
    dim: paint('dim'),
    red: paint('red'),
    green: paint('green'),
    yellow: paint('yellow'),
    blue: paint('blue'),
    magenta: paint('magenta'),
    cyan: paint('cyan'),
  };
}

export const out = painter(process.stdout);
export const err = painter(process.stderr);

/** Write and wait for the stream to drain, so huge listings do not buffer in memory. */
export async function write(text: string): Promise<void> {
  if (!process.stdout.write(text)) await new Promise((r) => process.stdout.once('drain', r));
}

/** Visible width of a string that may contain color codes. */
export function width(s: string): number {
  return stripVTControlCharacters(s).length;
}

export function pad(s: string, n: number, align: 'l' | 'r' = 'l'): string {
  const fill = ' '.repeat(Math.max(0, n - width(s)));
  return align === 'r' ? fill + s : s + fill;
}

/** Fixed-width columns sized to the widest cell. The last column is not padded. */
export function table(rows: string[][], align: ('l' | 'r')[] = []): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, width(cell))));
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 && align[i] !== 'r' ? cell : pad(cell, widths[i], align[i]))).join('  '))
    .join('\n');
}

/** One-line progress on a TTY stderr; silent otherwise. */
export function progress(label: string) {
  const tty = process.stderr.isTTY;
  let last = 0;
  return {
    update(done: number, total: number, detail = '') {
      if (!tty) return;
      const now = Date.now();
      if (now - last < 100 && done !== total) return;
      last = now;
      const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
      const head = `${label} ${pct}% ${fmtNum(done)}/${fmtNum(total)} `;
      const room = Math.max(0, (process.stderr.columns ?? 80) - head.length - 1);
      const tail = detail.length > room ? '…' + detail.slice(detail.length - room + 1) : detail;
      process.stderr.write(`\r\x1b[K${head}${err.dim(tail)}`);
    },
    done() {
      if (tty) process.stderr.write('\r\x1b[K');
    },
  };
}

export function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

// ---------------------------------------------------------------------------
// Formatting

export function fmtNum(n: number | null | undefined): string {
  return n == null ? '' : n.toLocaleString('en-US');
}

/**
 * Epoch µs → `YYYY-MM-DD HH:MM:SS.mmm +08:00` in local time, or `… Z` in UTC. The zone is always printed, so a time
 * copied from the terminal into a bug report means the same instant everywhere.
 */
export function fmtTime(us: number | null | undefined, utc = false): string {
  if (us == null) return '';
  const d = new Date(Math.floor(us / 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  if (utc) {
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)} Z`;
  }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} ${fmtOffset(d)}`;
}

/** The local UTC offset at that date, e.g. `+08:00` or `-04:30`. */
export function fmtOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${off < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function fmtPct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '';
}

// ---------------------------------------------------------------------------
// Option conversion

const DUR_UNITS_US: Record<string, number> = { us: 1, ms: 1e3, s: 1e6, m: 60e6, min: 60e6, h: 3600e6, d: 86_400e6, w: 7 * 86_400e6 };

export function parseDuration(s: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)(us|ms|s|min|m|h|d|w)$/.exec(s.trim());
  if (!m) throw new CliError(`${flag} expects a duration such as 30m, 12h or 7d (got '${s}')`, 2);
  return Math.round(Number(m[1]) * DUR_UNITS_US[m[2]]);
}

/**
 * A point in time as epoch µs: a duration back from now (`7d`, `-2h`) or an ISO date. Dates and times without a zone are
 * local time (`2026-10-11` is local midnight), exactly as in the display filter and the HTTP API; add `Z` or `+08:00`
 * for another zone.
 */
export function parseTime(s: string, flag: string, nowMs = Date.now()): number {
  const rel = s.trim().replace(/^-/, '');
  if (/^\d+(\.\d+)?[a-z]+$/.test(rel)) return nowMs * 1000 - parseDuration(rel, flag);
  const us = parseIsoTime(s);
  if (us === undefined) throw new CliError(`${flag} expects an ISO date such as 2026-10-11, 2026-10-11T09:00 or 2026-10-11T09:00+08:00, or a duration such as 7d (got '${s}')`, 2);
  return us;
}

export function parseInt10(s: string | undefined, flag: string, min = 0): number | undefined {
  if (s === undefined) return undefined;
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n) || n < min) throw new CliError(`${flag} expects an integer ≥ ${min} (got '${s}')`, 2);
  return n;
}

/** `cc,cx` or `claude-code` → AgentKind[]; accepts repeated flags and comma lists. */
export function parseAgents(values: string[] | undefined): AgentKind[] | undefined {
  if (!values?.length) return undefined;
  const byPrefix = new Map(Object.entries(AGENT_PREFIX).map(([kind, prefix]) => [prefix as string, kind as AgentKind]));
  const kinds = values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean).map((v) => {
    const kind = byPrefix.get(v) ?? (v in AGENT_PREFIX ? (v as AgentKind) : undefined);
    if (!kind) throw new CliError(`unknown agent '${v}'; use ${[...byPrefix.keys()].join(', ')} or ${Object.keys(AGENT_PREFIX).join(', ')}`, 2);
    return kind;
  });
  return [...new Set(kinds)];
}

export function strings(v: Args['values'][string]): string[] | undefined {
  if (v === undefined || typeof v === 'boolean') return undefined;
  return Array.isArray(v) ? v : [v];
}

export function string(v: Args['values'][string]): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Render a FilterError (recognized by its start/end offsets) as the filter text with a caret line. */
export function filterError(e: unknown, filter: string): CliError | null {
  const fe = e as { message?: string; start?: unknown; end?: unknown };
  if (typeof fe?.start !== 'number' || typeof fe?.end !== 'number') return null;
  const caret = ' '.repeat(fe.start) + '^'.repeat(Math.max(1, fe.end - fe.start));
  return new CliError(`invalid filter: ${fe.message}\n  ${filter}\n  ${err.red(caret)}`, 2);
}

/** Short session label for tables: `cc:8c1e2f3a` or `cc:8c1e2f3a/a3687`. */
export function shortSession(id: string): string {
  const colon = id.indexOf(':');
  const [main, child] = id.slice(colon + 1).split('/');
  return id.slice(0, colon + 1) + main.slice(0, 8) + (child ? '/' + child.replace(/^agent-/, '').slice(0, 5) : '');
}
