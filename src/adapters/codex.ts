// Codex rollout adapter (SPEC §4.2). One file is one page of one Codex thread:
// ~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<thread uuid>[_<page uuid>].jsonl[.zst]
// Field map and caveats: docs/research/codex-rollouts.md and docs/research/critic.md.

import { open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  Actor, Attrs, ChangeFile, EventFlag, EventKind, EventRec, ExpertGroup, ExpertRec, ExpertSeverity, SessionRec,
  SessionRole, SpanKind, SpanRec, SpanStatus, TokenUsage, ToolKindTag,
} from '../model/types.ts';
import { fmtBytes, fmtDur as fmtUs } from '../model/format.ts';
import {
  INDEX_INPUT_MAX_STRING, INDEX_TEXT_MAX, agentRoots, compact, diffCounts, emptyStats, eventId, fileInfo, fromFileUri, isoToUs, isZstd, lineCount,
  oneLine, openSource, outputTail, patchChanges, readJsonl, shellArgvScript, spanId, summarizeToolInput, toolKind, truncate, tryJson,
  type Adapter, type DiscoverEnv, type LineInfo, type ParseContext, type ParseStats, type RecordSink, type SourceFile,
} from './adapter.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Captures the thread uuid and, for continuation pages, the page uuid. */
const ROLLOUT_RE = new RegExp(`^rollout-.*?(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`);

export const codexAdapter: Adapter = {
  name: 'codex',

  async discover(env: DiscoverEnv): Promise<SourceFile[]> {
    if (env.agents && !env.agents.includes('codex')) return [];
    const paths = (await Promise.all(agentRoots(env, 'codex').map(homeRollouts))).flat();
    const out: SourceFile[] = [];
    for (let i = 0; i < paths.length; i += 64) {
      const batch = await Promise.all(paths.slice(i, i + 64).map((p) => fileInfo(p, 'codex', 'rollout', 'codex')));
      for (const f of batch) if (f) out.push(f);
    }
    return out;
  },

  // A base file's abandoned lines depend on the next page of the same thread.
  groupKey(path: string): string | undefined {
    return ROLLOUT_RE.exec(basename(path))?.[1];
  },

  async parse(ctx: ParseContext, sink: RecordSink): Promise<ParseStats> {
    const parser = new RolloutParser(ctx, await abandonedFrom(ctx.file.path, ctx.env?.runAt), await copiedPrefix(ctx.file.path));
    const { parsedBytes, lines, sha256 } = await readJsonl(
      ctx.file.path,
      (obj, info) => parser.onRecord(obj, info),
      (info, err) => parser.malformed(info, err),
    );
    parser.finish(sink);
    return { ...parser.stats, parsedBytes, lines, sha256 };
  },
};

/**
 * Rollouts under one ~/.codex directory. Codex compresses finished rollouts to `.jsonl.zst`; a rollout present in
 * both forms is listed once, as the plain file, which can still be growing.
 */
async function homeRollouts(home: string): Promise<string[]> {
  const paths = [...await listRollouts(join(home, 'sessions'), true), ...await listRollouts(join(home, 'archived_sessions'), false)];
  const plain = new Set(paths.filter((p) => !isZstd(p)).map((p) => basename(p)));
  return paths.filter((p) => !isZstd(p) || !plain.has(basename(p, '.zst')));
}

async function listRollouts(dir: string, recursive: boolean): Promise<string[]> {
  try {
    const names = await readdir(dir, { recursive });
    return names.filter((n) => /^rollout-.*\.jsonl(\.zst)?$/.test(basename(n))).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Continuation pages. A page's session_meta.history_base names the byte offset where it branched off the
// previous file of the same thread; the previous file's lines past that offset are an abandoned branch.

const pageCache = new Map<string, { at: number; runAt?: number; pages: Map<string, string[]> }>();

/**
 * Continuation pages per thread under one ~/.codex directory, sorted by page uuid (UUIDv7 = creation order).
 * The listing is cached for one index run (or 10 s outside a run), so a page that appears is seen by the next run.
 */
async function threadPages(codexHome: string, runAt?: number): Promise<Map<string, string[]>> {
  const hit = pageCache.get(codexHome);
  if (hit && (runAt !== undefined ? hit.runAt === runAt : Date.now() - hit.at < 10_000)) return hit.pages;
  const pages = new Map<string, string[]>();
  for (const path of await homeRollouts(codexHome)) {
    const m = ROLLOUT_RE.exec(basename(path));
    if (!m?.[2]) continue;
    const list = pages.get(m[1]) ?? [];
    list.push(path);
    pages.set(m[1], list);
  }
  for (const list of pages.values()) list.sort((a, b) => basename(a).split('_').pop()!.localeCompare(basename(b).split('_').pop()!));
  pageCache.set(codexHome, { at: Date.now(), runAt, pages });
  return pages;
}

async function abandonedFrom(path: string, runAt?: number): Promise<{ offset: number; page: string } | undefined> {
  const m = ROLLOUT_RE.exec(basename(path));
  const i = Math.max(path.lastIndexOf('/sessions/'), path.lastIndexOf('/archived_sessions/'));
  if (!m || i < 0) return undefined;
  const pages = (await threadPages(path.slice(0, i), runAt)).get(m[1]);
  if (!pages) return undefined;
  const next = m[2] ? pages[pages.indexOf(path) + 1] : pages[0];
  if (!next) return undefined;
  const base = (await firstRecord(next))?.payload?.history_base;
  if (!base || typeof base.end_byte_offset !== 'number' || (base.thread_id && base.thread_id !== m[1])) return undefined;
  return { offset: base.end_byte_offset, page: next };
}

/** Envelope prefix (timestamp, ordinal) of the file's last line, read backwards from the end (forwards in a zstd file). */
async function lastEnvelope(path: string): Promise<Envelope | undefined> {
  if (isZstd(path)) {
    let last = '';
    await scanLines(path, (head) => { last = head; return true; });
    const m = ENVELOPE_RE.exec(last);
    return m ? { timestamp: m[1], ordinal: Number(m[2]) } : undefined;
  }
  const fh = await open(path, 'r').catch(() => undefined);
  if (!fh) return undefined;
  try {
    const { size } = await fh.stat();
    const CHUNK = 64 << 10;
    const buf = Buffer.allocUnsafe(CHUNK);
    // Search backwards for the newline before the last line, ignoring a final newline (lines can be tens of MB).
    let end = size > 0 && (await fh.read(buf, 0, 1, size - 1)).bytesRead && buf[0] === 10 ? size - 1 : size;
    let lineStart = 0;
    while (end > 0 && size - end < 64 << 20) {
      const from = Math.max(0, end - CHUNK);
      const { bytesRead } = await fh.read(buf, 0, end - from, from);
      const nl = buf.subarray(0, bytesRead).lastIndexOf(10);
      if (nl >= 0) {
        lineStart = from + nl + 1;
        break;
      }
      end = from;
    }
    const { bytesRead } = await fh.read(buf, 0, 256, lineStart);
    const m = ENVELOPE_RE.exec(buf.toString('utf8', 0, bytesRead));
    return m ? { timestamp: m[1], ordinal: Number(m[2]) } : undefined;
  } finally {
    await fh.close();
  }
}

interface Envelope {
  timestamp: string;
  ordinal: number;
}

/** Where a child thread's copy of its parent's history ends: records with ordinal < end are inherited. */
interface PrefixPlan {
  end?: number;
  how: string;
  /** A logging-gap note for the session when the evidence was not conclusive. */
  note?: string;
}

/** Two usage reports of the same response: equal input, cached, output and reasoning counts. */
function sameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return a.input === b.input && a.cache_read === b.cache_read && a.output === b.output && a.reasoning === b.reasoning;
}

/** Milliseconds since the epoch encoded in a UUIDv7; undefined for any other id. */
export function uuidV7Ms(id: unknown): number | undefined {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return undefined;
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

const TURN_ID_RE = /"turn_id":"([^"]+)"/;
const SYNTHETIC_TURN_RE = /^(rollout-)?\d+$/;

/** A copy of the parent's history is written in one burst when the child thread is created. */
const COPY_BURST_MS = 1000;
const ENVELOPE_RE = /^\{"timestamp":"([^"]+)","ordinal":(\d+),"type":"([a-z_]+)"(?:,"payload":\{"type":"([A-Za-z_]+)")?/;
const MODEL_OUTPUT = new Set(['reasoning', 'function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call']);

/**
 * The copied prefix of a child rollout. `session_meta.subagent_history_start_ordinal` marks it when a record
 * at or past that ordinal exists. In about 1,400 files on this machine (review, guardian and spawned threads up
 * to CLI 0.158) the value instead equals the record count. For those the turn ids decide: thread and turn ids
 * are UUIDv7, so a turn that started after the thread was created is the child's own, and the records before
 * its first record are the parent's copy when they hold a parent turn (an older or synthetic turn id) or model
 * output. The rewrite that collapsed many of these files to a single timestamp kept the turn ids.
 * Files without UUIDv7 turn ids fall back to the creation burst (see copiedBurst).
 */
async function copiedPrefix(path: string): Promise<PrefixPlan | undefined> {
  const first = await firstRecord(path);
  const start = first?.payload?.subagent_history_start_ordinal;
  if (first?.type !== 'session_meta' || typeof start !== 'number') return undefined;
  const last = await lastEnvelope(path);
  if (!last || last.ordinal >= start) return { end: start, how: 'start ordinal' };
  const threadMs = uuidV7Ms(first.payload?.id ?? ROLLOUT_RE.exec(basename(path))?.[1]);
  if (threadMs !== undefined) {
    let ownTurn: number | undefined;
    let parentEvidence = false;
    let olderTurns = 0;
    await scanLines(path, (head) => {
      const m = ENVELOPE_RE.exec(head);
      if (!m) return true;
      const ordinal = Number(m[2]);
      if (ordinal === 0) return true;
      const turnRecord = (m[3] === 'event_msg' && m[4] === 'task_started') || m[3] === 'turn_context';
      const turn = turnRecord ? TURN_ID_RE.exec(head)?.[1] : undefined;
      const ms = uuidV7Ms(turn);
      if (ms !== undefined && ms > threadMs) {
        ownTurn = ordinal;
        return false;
      }
      if (ms !== undefined) olderTurns++;
      if ((turn && (ms !== undefined || SYNTHETIC_TURN_RE.test(turn))) || isModelOutput(m, head)) parentEvidence = true;
      return true;
    });
    if (ownTurn !== undefined) {
      return parentEvidence ? { end: ownTurn, how: 'turn ids' } : { end: undefined, how: 'none (no parent turn before the first own turn)' };
    }
    if (olderTurns > 0) return { end: start, how: 'whole file copied (every turn id predates the thread)' };
  }
  return copiedBurst(path, first, start);
}

function isModelOutput(m: RegExpExecArray, head: string): boolean {
  return m[3] === 'response_item' && (MODEL_OUTPUT.has(m[4]) || (m[4] === 'message' && head.includes('"role":"assistant"')));
}

/**
 * Fallback for child files without UUIDv7 turn ids: the copy is the burst of records written within a second of
 * creation. A fresh thread produces no model output that fast, so model output in the burst is copied history,
 * and the child's own work starts at the next turn start (task_started). Timestamps alone never hide a whole
 * file: when the burst covers every record (a rewrite can collapse all timestamps to one), nothing is flagged.
 */
async function copiedBurst(path: string, first: any, start: number): Promise<PrefixPlan> {
  const t0 = Date.parse(first.timestamp);
  let lastOutput = -1;
  let ownStart: number | undefined;
  let afterBurst = 0;
  let firstAfter: number | undefined;
  await scanLines(path, (head) => {
    const m = ENVELOPE_RE.exec(head);
    if (!m) return true;
    const ordinal = Number(m[2]);
    const inBurst = afterBurst === 0 && Date.parse(m[1]) - t0 <= COPY_BURST_MS;
    if (!inBurst) {
      if (lastOutput < 0) return false; // nothing was copied
      afterBurst++;
      firstAfter ??= ordinal;
    }
    const output = isModelOutput(m, head);
    if (inBurst && output) {
      lastOutput = ordinal;
      ownStart = undefined;
    } else if (lastOutput >= 0 && ownStart === undefined && m[3] === 'event_msg' && m[4] === 'task_started') {
      ownStart = ordinal;
    }
    // No turn start right after the burst: the child's own records start where the burst ends.
    if (!inBurst && ownStart === undefined && afterBurst > 3) ownStart = firstAfter;
    return inBurst || ownStart === undefined;
  });
  if (lastOutput < 0) return { end: undefined, how: 'none (start ordinal past the last record)' };
  ownStart ??= firstAfter;
  if (ownStart === undefined) {
    return {
      end: undefined,
      how: 'unknown (every record written at creation)',
      note: `subagent_history_start_ordinal (${start}) is past the last record and every record carries the creation time, ` +
        'so the copied parent history cannot be told apart from this thread\'s own records; nothing is marked inherited',
    };
  }
  return { end: ownStart, how: 'creation burst' };
}

/** Feed the first 256 bytes of each line to `onHead` until it returns false or the file ends. */
async function scanLines(path: string, onHead: (head: string) => boolean): Promise<void> {
  const fh = await openSource(path);
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let pos = 0;
    let atLineStart = true;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) return;
      let i = 0;
      while (i < bytesRead) {
        if (atLineStart) {
          if (i + 256 > bytesRead && bytesRead === buf.length) break; // the head crosses the chunk: re-read from here
          if (!onHead(buf.toString('utf8', i, Math.min(bytesRead, i + 256)))) return;
          atLineStart = false;
        }
        const nl = buf.indexOf(10, i);
        if (nl < 0 || nl >= bytesRead) {
          i = bytesRead;
          break;
        }
        i = nl + 1;
        atLineStart = true;
      }
      pos += i;
    }
  } finally {
    await fh.close();
  }
}

async function firstRecord(path: string): Promise<any> {
  const fh = await openSource(path).catch(() => undefined);
  if (!fh) return undefined;
  try {
    const chunks: Buffer[] = [];
    for (let pos = 0; pos < 16 << 20; ) {
      const buf = Buffer.allocUnsafe(256 << 10);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      const nl = buf.subarray(0, bytesRead).indexOf(10);
      chunks.push(buf.subarray(0, nl < 0 ? bytesRead : nl));
      if (nl >= 0) break;
      pos += bytesRead;
    }
    return tryJson(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Formatting

/** §9 durations; '?' when the time is not logged. */
function fmtDur(us: number | undefined): string {
  return us === undefined ? '?' : fmtUs(us);
}

function fmtTok(n: number | undefined): string {
  if (n === undefined) return '?';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

function fmtWindow(min: unknown): string {
  if (typeof min !== 'number') return '';
  if (min % 1440 === 0) return `${min / 1440} d`;
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** oneLine() over a bounded prefix: flattening a 50 KB text to show 160 chars is wasted work. */
function flat(s: string | undefined | null, n = 160): string {
  return oneLine(s && s.length > 4 * n ? s.slice(0, 4 * n) : s, n);
}

/** Info-column text: each part flattened to one line, empty parts dropped, parts joined by two spaces. */
function infoLine(...parts: unknown[]): string {
  const out = parts.map((p) => (p === undefined || p === null || p === false ? '' : flat(String(p)))).filter(Boolean).join('  ');
  return out.length > 240 ? out.slice(0, 239) + '…' : out;
}

function shortId(id: unknown): string {
  return typeof id === 'string' ? id.slice(0, 13) : '';
}

function imagesNote(n: number): string {
  return n ? `[+${n} image${n > 1 ? 's' : ''}]` : '';
}

// ---------------------------------------------------------------------------
// Payload helpers

/** Text of a message content list (input_text, output_text, text) and the number of images in it. */
function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: '', images: 0 };
  const parts: string[] = [];
  let images = 0;
  for (const c of content) {
    if (typeof c === 'string') parts.push(c);
    else if (c && typeof c === 'object') {
      if (typeof c.text === 'string') parts.push(c.text);
      else if (/image/.test(String(c.type)) || c.image_url) images++;
    }
  }
  return { text: parts.join('\n'), images };
}

/** Codex input_tokens include cached tokens (SPEC §3.7). */
function codexTokens(u: any, contextWindow?: number): TokenUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const t: TokenUsage = {};
  const input = num(u.input_tokens);
  const cached = num(u.cached_input_tokens);
  if (input !== undefined) {
    t.input = input;
    t.uncached = Math.max(0, input - (cached ?? 0));
  }
  if (cached !== undefined) t.cache_read = cached;
  if (num(u.cache_write_input_tokens) !== undefined) t.cache_write = u.cache_write_input_tokens;
  if (num(u.output_tokens) !== undefined) t.output = u.output_tokens;
  if (num(u.reasoning_output_tokens) !== undefined) t.reasoning = u.reasoning_output_tokens;
  if (num(u.total_tokens) !== undefined) t.total = u.total_tokens;
  if (contextWindow) t.context_window = contextWindow;
  return t;
}

function tokSummary(model: string | undefined, t: TokenUsage | undefined): string {
  if (!t) return `${model ?? 'llm'}  usage`;
  return `${model ?? 'llm'}  in ${fmtTok(t.input)} (cached ${fmtTok(t.cache_read ?? 0)}) out ${fmtTok(t.output)} reasoning ${fmtTok(t.reasoning ?? 0)}`;
}

function rateLimits(rl: any): Attrs['ratelimit'] | undefined {
  if (!rl || typeof rl !== 'object') return undefined;
  const p = rl.primary ?? {};
  const s = rl.secondary ?? {};
  const out: NonNullable<Attrs['ratelimit']> = {
    used_percent: num(p.used_percent),
    window_minutes: num(p.window_minutes),
    resets_at: num(p.resets_at) !== undefined ? p.resets_at * 1e6 : undefined,
    secondary_used_percent: num(s.used_percent),
    secondary_window_minutes: num(s.window_minutes),
    limit_id: str(rl.limit_id),
    plan_type: str(rl.plan_type),
    reached: str(rl.rate_limit_reached_type),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

function rateSummary(r: Attrs['ratelimit']): string {
  if (!r) return '';
  const parts: string[] = [];
  if (r.used_percent !== undefined) parts.push(`${r.used_percent}% of ${fmtWindow(r.window_minutes)}`.trim());
  if (r.secondary_used_percent !== undefined) parts.push(`${r.secondary_used_percent}% of ${fmtWindow(r.secondary_window_minutes)}`.trim());
  return parts.length ? `limit ${parts.join(', ')}` : '';
}

/** `{secs, nanos}` (Rust Duration), milliseconds, or a "1.2s" string → µs. */
function rustDurUs(d: any): number | undefined {
  if (d && typeof d === 'object' && typeof d.secs === 'number') return d.secs * 1e6 + Math.round((d.nanos ?? 0) / 1000);
  if (typeof d === 'number') return Math.round(d * 1000);
  if (typeof d === 'string') {
    const m = /^([\d.]+)\s*(ms|s)$/.exec(d.trim());
    if (m) return Math.round(Number(m[1]) * (m[2] === 'ms' ? 1000 : 1e6));
  }
  return undefined;
}

/** Shell command line from an argv such as [/bin/zsh, -lc, <cmd>]. */
function commandLine(command: unknown): string | undefined {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return undefined;
  const a = command.map(String);
  return shellArgvScript(a) ?? a.join(' ');
}

/** Info-column summary of a code-mode `exec` script: the tools it calls and its first shell command. */
function execScriptSummary(code: string): string {
  const calls = new Map<string, number>();
  for (const m of code.matchAll(/\btools\.([A-Za-z_]\w*)\s*\(/g)) calls.set(m[1], (calls.get(m[1]) ?? 0) + 1);
  if (!calls.size) return flat(code, 160);
  const list = [...calls].slice(0, 4).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ');
  const cmd = /tools\.exec_command\(\s*\{\s*cmd:\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(code)?.[2];
  return cmd ? `${list}  ${flat(cmd.replace(/\\[nrt]/g, ' ').replace(/\\(.)/g, '$1'), 120)}` : list;
}

const INJECTED_RE = /^\s*(<[A-Za-z_][\w-]*[\s>/]|# AGENTS\.md|# Context from )/;
/** Item ids invented by the legacy_to_paginated_v1 migration. */
const SYNTHETIC_ID_RE = /^item-\d+$/;
const ERROR_HEAD_RE =
  /^(apply_patch verification failed|exec_command failed|write_stdin failed|collab (spawn|tool) failed|patch rejected|agent with id .* not found|unsupported call|failed to |error: )/i;

interface OutputInfo {
  text: string;
  images: number;
  exitCode?: number;
  wallMs?: number;
  status?: string;
  /** N of "Process running with session ID N": the background process the call opened or polled. */
  procId?: string;
  isError?: boolean;
  json?: any;
}

/** Decode a function/custom tool output: a string, a content list, or JSON inside a string. */
function parseOutput(raw: unknown): OutputInfo {
  const { text: rawText, images } = contentText(raw);
  const info: OutputInfo = { text: rawText, images };
  if (typeof raw === 'string' && raw.startsWith('{')) {
    const j = tryJson(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      info.json = j;
      const out = j as any;
      if (typeof out.output === 'string') info.text = out.output;
      const md = out.metadata;
      if (md && typeof md === 'object') {
        info.exitCode = num(md.exit_code);
        if (num(md.duration_seconds) !== undefined) info.wallMs = md.duration_seconds * 1000;
      }
    }
  }
  // Exit code and timing live in the header before "Output:"; never scan megabytes of output.
  const t = info.text;
  const cut = t.indexOf('\nOutput:');
  const head = t.slice(0, cut >= 0 ? Math.min(cut, 65536) : 4096);
  const exit = /Process exited with code (-?\d+)/.exec(head) ?? /^Exit code: (-?\d+)/m.exec(head);
  if (exit) info.exitCode = Number(exit[1]);
  const wall = /Wall time:? ([\d.]+) seconds/.exec(head);
  if (wall && info.wallMs === undefined) info.wallMs = Number(wall[1]) * 1000;
  const running = /Process running with session ID (\d+)/.exec(head);
  if (running) {
    info.status = `running (session ${running[1]})`;
    info.procId = running[1];
  }
  const script = /^Script (completed|failed|terminated|running with cell ID (\d+))/.exec(head);
  if (script) info.status = script[2] ? `running (cell ${script[2]})` : script[1];
  if (/^aborted by user/.test(head)) info.status = 'cancelled';
  if (info.status === 'failed' || ERROR_HEAD_RE.test(head) || (info.exitCode !== undefined && info.exitCode !== 0)) info.isError = true;
  return info;
}

/** Copy of a record for the index, without the bulk that repeats other records or is opaque. */
function nativeCopy(o: any, type: string, p: any): unknown {
  if (p && typeof p === 'object') {
    const count = (v: unknown) => (Array.isArray(v) ? { $omitted: 'items', count: v.length } : v);
    if (type === 'compacted') {
      o = { ...o, payload: { ...p, replacement_history: count(p.replacement_history), guardian_history: count(p.guardian_history) } };
    } else if (type === 'session_meta' && Array.isArray(p.dynamic_tools)) {
      o = { ...o, payload: { ...p, dynamic_tools: p.dynamic_tools.map((t: any) => t?.name) } };
    } else if (p.type === 'tool_search_output' && Array.isArray(p.tools)) {
      o = { ...o, payload: { ...p, tools: p.tools.map((t: any) => t?.name) } };
    }
  }
  return compact(o);
}

/**
 * Files of a FileChange item: {type add|delete, content} or {type update, unified_diff, move_path}. Legacy
 * patch_apply events key the body by its type instead: {add: {content}}, {update: {unified_diff, move_path}}.
 */
function fileChanges(changes: unknown): ChangeFile[] {
  if (!changes || typeof changes !== 'object') return [];
  return Object.entries(changes).map(([key, c]: [string, any]): ChangeFile => {
    const type = c?.type ?? Object.keys(c ?? {})[0];
    const body = (c?.type ? c : c?.[type]) ?? {};
    const path = fromFileUri(key) ?? key;
    const lines = typeof body.content === 'string' ? lineCount(body.content) : null;
    if (type === 'add') return { path, op: 'add', added: lines, removed: 0 };
    if (type === 'delete') return { path, op: 'delete', added: 0, removed: lines };
    const counts = typeof body.unified_diff === 'string' ? diffCounts(body.unified_diff.split('\n'), true) : { added: null, removed: null };
    const to = fromFileUri(body.move_path);
    return to ? { path, op: 'move', ...counts, to } : { path, op: 'update', ...counts };
  });
}

/** A numeric `write_stdin` session id; malformed ids (objects, words) name no process. */
function sessionKey(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return typeof v === 'string' && /^\d+$/.test(v) ? v : undefined;
}

function toolDisplayName(name: string, namespace: unknown): { name: string; server?: string } {
  if (typeof namespace === 'string' && namespace.startsWith('mcp__')) {
    const server = namespace.slice(5).replace(/_+$/, '');
    return { name: `mcp__${server}__${name}`, server };
  }
  return { name };
}

// ---------------------------------------------------------------------------
// Parser state

interface ToolState {
  callId: string;
  name: string;
  kind: ToolKindTag;
  span: string;
  parent: string;
  call: EventRec;
  result?: EventRec;
  start: number;
  tool: NonNullable<Attrs['tool']>;
  agent?: NonNullable<Attrs['agent']>;
  linkSession?: string;
  /** Code-mode `exec` script or its `wait` continuation: brackets nested exec-* items. */
  codeMode: boolean;
  /** web_search_call has no output record. */
  noResult?: boolean;
  status?: string;
  turn?: TurnState;
  /** Failed exec-* items nested under this code-mode call (SPEC §12.3.3 source `inner`). */
  innerErrors?: number;
}

interface TurnState {
  span: string;
  turnId?: string;
  index: number;
  start: number;
  startEv: EventRec;
  lastEv: EventRec;
  endEv?: EventRec;
  dur?: number;
  durSrc: string;
  status: SpanStatus;
  ttftMs?: number;
  model?: string;
  lastCodeTool?: ToolState;
}

interface LlmRun {
  /** llm.text and llm.thinking events; tool calls keep their tool span. */
  events: EventRec[];
  first: EventRec;
  lastOut: EventRec;
  start: number;
  parent: string;
  inputSeen: boolean;
  closer?: EventRec;
  hasRecord: boolean;
  hasCount: boolean;
  /** Usage from this response's token_usage_record; preferred over countTokens. */
  recordTokens?: TokenUsage;
  /** Usage from the token_count that closed the run, unless that count only repeated earlier usage. */
  countTokens?: TokenUsage;
  turnId?: string;
  rec?: SpanRec;
  itemStartMs?: number;
  itemEndMs?: number;
  counts: { text: number; thinking: number; calls: number };
}

interface CompactionState {
  rec: SpanRec;
  parts: EventRec[];
  record?: EventRec;
  items: EventRec[];
}

type Waiter = { ev: EventRec; keys: string[]; timing?: [number | undefined, number | undefined] };

class RolloutParser {
  stats: ParseStats = emptyStats();
  src: string;
  file: SourceFile;
  abandon?: { offset: number; page: string };
  threadId: string;
  pageTag = '';
  sid: string;
  session?: SessionRec;
  sessionSpan = '';
  metaCount = 0;
  historyStart?: number;

  events: EventRec[] = [];
  spans: SpanRec[] = [];
  experts: ExpertRec[] = [];
  spanIds = new Set<string>();

  // Per-line context
  curLine = 0;
  inh = false;
  lastTs?: number;
  prevTs?: number;

  model?: string;
  effort?: string;
  serviceTier?: string;
  contextWindow?: number;
  models = new Set<string>();

  turn?: TurnState;
  turns: TurnState[] = [];
  llm?: LlmRun;
  lastRun?: LlmRun;
  runs: LlmRun[] = [];
  runOf = new Map<EventRec, LlmRun>();
  lastInputTs?: number;
  lastCountTotal?: number;
  /** Usage of the latest token_usage_record; a token_count that repeats it is a dup. */
  lastRecordTokens?: TokenUsage;

  tools = new Map<string, ToolState>();
  toolList: ToolState[] = [];
  openCode: ToolState[] = [];
  compaction?: CompactionState;
  compactions: CompactionState[] = [];
  pendingWebSearch?: EventRec;

  /** Mirror records (item_completed, legacy event_msg) and their primary response_item meet in either order. */
  mirrorWait = new Map<string, Waiter>();
  primaryWait = new Map<string, Waiter>();
  mirrorOf = new Map<EventRec, EventRec>();
  userMsgs: EventRec[] = [];
  userItems: { ev: EventRec; text: string }[] = [];
  /** Uncapped text of long user messages awaiting their UserMessage item (attrs.text is capped). */
  fullTexts = new Map<EventRec, string>();

  unknown = new Map<string, { count: number; first: string }>();
  rateWarned = new Set<string>();
  syntheticIds = false;
  inheritedCount = 0;
  abandonedFirst?: number;
  dialect = 'paginated';

  /** Where the copied parent history ends (see copiedPrefix); absent when the file is not a child thread. */
  prefix?: PrefixPlan;

  constructor(ctx: ParseContext, abandon?: { offset: number; page: string }, prefix?: PrefixPlan) {
    this.src = ctx.sourceId;
    this.file = ctx.file;
    this.abandon = abandon;
    this.prefix = prefix;
    const m = ROLLOUT_RE.exec(basename(ctx.file.path));
    this.threadId = m?.[1] ?? basename(ctx.file.path).replace(/\.jsonl(\.zst)?$/, '');
    if (m?.[2]) this.pageTag = m[2].slice(-12);
    this.sid = `cx:${this.threadId}`;
  }

  /** Positional span key (a line number), page-qualified so continuation pages never collide with their base. */
  posKey(line = this.curLine): string {
    return this.pageTag ? `${this.pageTag}.${line}` : String(line);
  }

  uniqueSpan(kind: SpanKind, key: string): string {
    let id = spanId(this.sid, kind, key);
    if (this.spanIds.has(id)) id = spanId(this.sid, kind, `${key}~${this.posKey()}`);
    this.spanIds.add(id);
    return id;
  }

  container(): string {
    return this.turn && !this.inh ? this.turn.span : this.sessionSpan;
  }

  expert(severity: ExpertSeverity, group: ExpertGroup, message: string, ev?: EventRec, span?: string): void {
    this.experts.push({ rec: 'expert', session: this.sid, event: ev?.id, span, severity, group, message });
  }

  malformed(info: LineInfo, err: Error): void {
    this.stats.malformed++;
    this.expert('warn', 'malformed', `line ${info.line}: ${flat(err.message, 120)}`);
  }

  // -------------------------------------------------------------------------
  // Line dispatch

  onRecord(o: any, info: LineInfo): void {
    this.curLine = info.line;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      if (!this.session) this.initSession(undefined, undefined);
      const ev = this.newEvent(info, {}, 'codex/?', '?', undefined);
      ev.native = compact(o);
      this.unknownEvent(ev);
      return;
    }
    let type: string = o.type;
    let p: any = o.payload;
    // Pre-envelope rollouts: a bare meta line, bare response items and {record_type: state} markers.
    if (p === undefined) {
      if (typeof o.record_type === 'string') type = 'state';
      else if (info.line === 1 && !type && typeof o.id === 'string') type = 'session_meta';
      else if (typeof type === 'string') type = 'response_item';
      p = o;
      this.dialect = 'bare';
    } else if (typeof o.ordinal !== 'number' && this.dialect === 'paginated') {
      this.dialect = 'envelope';
    }
    if (type === 'session_meta') this.metaCount++;
    if (!this.session) this.initSession(type === 'session_meta' ? p : undefined, o);

    this.inh =
      this.historyStart !== undefined && typeof o.ordinal === 'number' && o.ordinal < this.historyStart &&
      !(type === 'session_meta' && this.metaCount === 1);
    const sub = type === 'event_msg' || type === 'response_item' ? p?.type : undefined;
    const item = sub === 'item_completed' ? p?.item?.type : undefined;
    const proto = ['codex', type ?? '?', sub, item].filter((s) => typeof s === 'string').join('/');
    const ev = this.newEvent(info, o, proto, type, p);
    this.dispatch(ev, type, p);
    if (this.turn && !this.inh && ev.turn === this.turn.span) this.turn.lastEv = ev;
  }

  dispatch(ev: EventRec, type: string, p: any): void {
    switch (type) {
      case 'session_meta': return this.sessionMeta(ev, p);
      case 'turn_context': return this.turnContext(ev, p);
      case 'response_item': return this.responseItem(ev, p);
      case 'event_msg': return this.eventMsg(ev, p);
      case 'token_usage_record': return this.tokenUsageRecord(ev, p);
      case 'compacted': return this.compacted(ev, p);
      case 'world_state': return this.worldState(ev, p);
      case 'inter_agent_communication_metadata':
        return this.set(ev, 'harness.other', 'harness', `inter-agent metadata  trigger_turn=${p?.trigger_turn}`);
      case 'realtime_item':
        return this.set(ev, 'harness.status', 'harness', `realtime ${flat(String(p?.type ?? ''), 60)}`);
      case 'state':
        return this.set(ev, 'harness.other', 'harness', 'state marker');
      default:
        return this.unknownEvent(ev);
    }
  }

  newEvent(info: LineInfo, o: any, proto: string, type: string, p: any): EventRec {
    const logged = isoToUs(o.timestamp);
    const ts = logged ?? this.lastTs ?? this.session?.createdTs ?? 0;
    this.prevTs = this.lastTs;
    this.lastTs = ts;
    const flags: EventFlag[] = [];
    if (this.inh) {
      flags.push('inherited');
      this.inheritedCount++;
    }
    if (this.abandon && info.offset >= this.abandon.offset) {
      flags.push('abandoned');
      this.abandonedFirst ??= info.line;
    }
    const ev: EventRec = {
      rec: 'event',
      id: eventId(this.src, info.line),
      session: this.sid,
      ts,
      tsSrc: logged !== undefined ? 'logged' : ts ? 'inherited' : 'none',
      seq: typeof o.ordinal === 'number' ? o.ordinal : info.line - 1,
      kind: 'raw.unknown',
      proto,
      actor: 'harness',
      summary: '',
      span: this.container(),
      turn: this.inh ? undefined : this.turn?.span,
      attrs: {},
      native: nativeCopy(o, type, p),
      raw: { source: this.src, line: info.line, offset: info.offset, length: info.length },
    };
    if (flags.length) ev.flags = flags;
    this.events.push(ev);
    return ev;
  }

  set(ev: EventRec, kind: EventKind, actor: Actor, summary: string): void {
    ev.kind = kind;
    ev.actor = actor;
    ev.summary = summary;
  }

  flag(ev: EventRec, f: EventFlag): void {
    if (!ev.flags) ev.flags = [f];
    else if (!ev.flags.includes(f)) ev.flags.push(f);
  }

  unflag(ev: EventRec, f: EventFlag): void {
    if (ev.flags) ev.flags = ev.flags.filter((x) => x !== f);
    if (ev.flags?.length === 0) delete ev.flags;
  }

  setText(ev: EventRec, text: string): void {
    if (!text) return;
    ev.attrs.text = truncate(text, INDEX_TEXT_MAX);
    ev.attrs.text_len = text.length;
    if (text.length > INDEX_TEXT_MAX) this.flag(ev, 'truncated');
  }

  unknownEvent(ev: EventRec): void {
    ev.kind = 'raw.unknown';
    ev.summary = `undecoded ${ev.proto}`;
    this.stats.unknown++;
    const u = this.unknown.get(ev.proto);
    if (u) u.count++;
    else this.unknown.set(ev.proto, { count: 1, first: ev.id });
  }

  // -------------------------------------------------------------------------
  // Session

  initSession(p: any, o: any): void {
    p = p && typeof p === 'object' ? p : {};
    const id = str(p.id) ?? this.threadId;
    this.sid = `cx:${id}`;
    this.sessionSpan = spanId(this.sid, 'session', this.pageTag ? `${id}.${this.pageTag}` : id);
    this.spanIds.add(this.sessionSpan);
    const src = p.source;
    const sub = src && typeof src === 'object' ? src.subagent : undefined;
    const spawn = sub && typeof sub === 'object' ? sub.thread_spawn : undefined;
    let role: SessionRole = 'main';
    let parent: string | undefined = str(p.parent_thread_id);
    if (spawn) {
      role = 'subagent';
      parent = str(spawn.parent_thread_id) ?? parent;
    } else if ((sub && typeof sub === 'object' && sub.other === 'guardian') || p.thread_source === 'guardian_review') role = 'guardian';
    else if (sub === 'review') role = 'review';
    else if (p.forked_from_id) {
      role = 'fork';
      parent ??= str(p.forked_from_id);
    } else if (p.thread_source === 'automation') role = 'automation';
    else if (sub) role = 'subagent';
    if (parent === id) parent = undefined;

    const cwd = str(p.cwd);
    const git = p.git && typeof p.git === 'object' ? p.git : undefined;
    const provenanceModel = str(p.base_instructions?.provenance?.model);
    if (provenanceModel) this.model = provenanceModel;
    const historyStart = num(p.subagent_history_start_ordinal);
    this.historyStart = this.prefix ? this.prefix.end : historyStart;
    const meta: Record<string, unknown> = {
      session_id: p.session_id,
      source: typeof src === 'string' ? src : sub !== undefined ? compact(src) : undefined,
      thread_source: p.thread_source,
      model_provider: p.model_provider,
      history_mode: p.history_mode,
      multi_agent_version: p.multi_agent_version,
      agent_path: p.agent_path ?? spawn?.agent_path,
      agent_nickname: p.agent_nickname ?? spawn?.agent_nickname,
      agent_role: p.agent_role ?? spawn?.agent_role,
      depth: spawn?.depth,
      forked_from_id: p.forked_from_id,
      subagent_history_start_ordinal: historyStart,
      history_prefix: this.prefix && this.prefix.how !== 'start ordinal' ? this.prefix.how : undefined,
      history_base: p.history_base,
      page: this.pageTag ? basename(this.file.path) : undefined,
      context_window_id: p.context_window?.window_id,
      dynamic_tools: Array.isArray(p.dynamic_tools) ? p.dynamic_tools.map((t: any) => t?.name) : undefined,
      runtime_workspace_roots: p.runtime_workspace_roots,
      base_instructions: p.base_instructions
        ? { bytes: String(p.base_instructions.text ?? '').length, provenance: p.base_instructions.provenance }
        : undefined,
    };
    for (const k of Object.keys(meta)) if (meta[k] === undefined || meta[k] === null) delete meta[k];
    this.session = {
      rec: 'session',
      id: this.sid,
      agent: 'codex',
      nativeId: id,
      role,
      parentId: parent ? `cx:${parent}` : undefined,
      cwd,
      project: cwd ? basename(cwd) || undefined : undefined,
      git: git ? { branch: str(git.branch), commit: str(git.commit_hash), repo: str(git.repository_url) } : undefined,
      version: str(p.cli_version),
      originator: str(p.originator),
      entrypoint: typeof src === 'string' ? src : sub !== undefined ? 'subagent' : undefined,
      createdTs: isoToUs(p.timestamp) ?? isoToUs(o?.timestamp),
      meta,
    };
  }

  sessionMeta(ev: EventRec, p: any): void {
    const s = p?.source;
    const spawn = s?.subagent?.thread_spawn;
    let what: string;
    if (spawn) what = `subagent ${spawn.agent_nickname ?? ''} ${spawn.agent_path ?? ''} (${spawn.agent_role ?? 'default'}, depth ${spawn.depth ?? '?'})`;
    else if (s?.subagent?.other) what = String(s.subagent.other);
    else if (s?.subagent) what = `subagent ${typeof s.subagent === 'string' ? s.subagent : 'other'}`;
    else what = `${p?.originator ?? ''} ${p?.cli_version ?? ''}  ${typeof s === 'string' ? s : ''}`;
    if (p?.history_base) what += `  continues at ordinal ${p.history_base.end_ordinal_exclusive}`;
    this.set(ev, 'session.meta', 'harness', `session_meta${this.inh ? ' (parent copy)' : ''}  ${flat(what, 140)}`);
    ev.attrs.context = { type: 'session_meta' };
    if (spawn) ev.attrs.agent = { path: spawn.agent_path, nickname: spawn.agent_nickname, role: spawn.agent_role };
  }

  noteModel(model: unknown, effort?: unknown, tier?: unknown): void {
    if (typeof model === 'string' && model) {
      this.model = model;
      this.models.add(model);
      if (this.turn) this.turn.model = model;
    }
    if (typeof effort === 'string' && effort) this.effort = effort;
    if (typeof tier === 'string' && tier) this.serviceTier = tier;
  }

  turnContext(ev: EventRec, p: any): void {
    p ??= {};
    if (!this.inh) this.noteModel(p.model, p.effort ?? p.collaboration_mode?.settings?.reasoning_effort);
    const sandbox = p.sandbox_policy?.type ?? p.permission_profile?.type;
    this.set(ev, 'session.state', 'harness',
      infoLine('turn_context', `${p.model ?? ''} ${p.effort ?? ''}`, `approval=${p.approval_policy ?? '?'}`, `sandbox=${sandbox ?? '?'}`));
    ev.attrs.llm = { model: str(p.model), effort: str(p.effort) };
    ev.attrs.permission = { mode: str(p.approval_policy) };
    ev.attrs.context = { type: 'turn_context', sandbox, collaboration_mode: p.collaboration_mode?.mode, cwd: str(p.cwd) };
    if (p.turn_id) ev.attrs.turn = { id: String(p.turn_id) };
  }

  worldState(ev: EventRec, p: any): void {
    const state = p?.state && typeof p.state === 'object' ? p.state : {};
    if (!this.inh && typeof state.model === 'string') this.noteModel(state.model);
    const parts = Object.keys(state).slice(0, 10).map((k) => {
      const v = state[k];
      if (k === 'model' && typeof v === 'string') return `model ${v}`;
      if (k === 'agents_md' && typeof v?.text === 'string') return `agents_md ${fmtBytes(v.text.length)}`;
      if (k === 'tools' && v && typeof v === 'object') return `tools ${Object.keys(v).length}`;
      return k;
    });
    this.set(ev, 'context.snapshot', 'harness', infoLine(`world_state ${p?.full ? 'full' : 'delta'}`, parts.join(', ')));
    ev.attrs.context = { type: 'world_state', full: !!p?.full, keys: Object.keys(state) };
  }

  // -------------------------------------------------------------------------
  // response_item

  responseItem(ev: EventRec, p: any): void {
    p ??= {};
    switch (p.type) {
      case 'message': return this.message(ev, p);
      case 'reasoning': return this.reasoning(ev, p);
      case 'function_call':
      case 'custom_tool_call':
      case 'tool_search_call':
      case 'local_shell_call':
      case 'web_search_call':
        return this.toolCall(ev, p);
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'tool_search_output':
        return this.toolOutput(ev, p);
      case 'compaction': {
        const n = typeof p.encrypted_content === 'string' ? p.encrypted_content.length : 0;
        this.set(ev, 'context.compaction', 'assistant', `compaction summary${n ? `  encrypted (${fmtBytes(n)})` : ''}`);
        ev.attrs.context = { type: 'compaction' };
        if (!this.inh) this.compactionPart(ev, 'summary');
        return;
      }
      case 'agent_message': {
        const { text } = contentText(p.content);
        this.set(ev, 'agent.message', 'agent', infoLine(`${p.author ?? '?'} → ${p.recipient ?? '?'}`, text));
        this.setText(ev, text);
        ev.attrs.agent = { path: str(p.author), recipient: str(p.recipient) };
        if (!this.inh) this.llmInput(ev);
        return;
      }
      default:
        return this.unknownEvent(ev);
    }
  }

  message(ev: EventRec, p: any): void {
    const { text, images } = contentText(p.content);
    const extra = imagesNote(images) || (text ? '' : '(empty message)');
    this.setText(ev, text);
    if (images) ev.attrs.images = images;
    if (p.role === 'assistant') {
      this.set(ev, 'llm.text', 'assistant', infoLine(text, extra));
      ev.attrs.llm = { message_id: str(p.id), phase: str(p.phase) };
      if (this.inh) return;
      this.llmOutput(ev, 'text');
      this.primary(ev, [p.id && `id:${p.id}`, text && `a:${text}`]);
    } else if (p.role === 'user') {
      const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
      const prompt = Array.isArray(kinds) ? kinds.includes('user.text') : !INJECTED_RE.test(text);
      this.setUserKind(ev, prompt);
      ev.summary = infoLine(text, extra);
      if (Array.isArray(kinds)) ev.attrs.context = { type: 'user', kinds: [...new Set(kinds)] };
      if (this.inh) return;
      this.llmInput(ev);
      const hit = text ? this.userItems.findIndex((u) => text.includes(u.text)) : -1;
      if (hit >= 0) this.linkUser(ev, this.userItems.splice(hit, 1)[0].ev);
      else {
        this.userMsgs.push(ev);
        if (text.length > INDEX_TEXT_MAX) this.fullTexts.set(ev, text);
      }
    } else {
      this.set(ev, 'context.attachment', 'harness', infoLine(p.role ?? 'message', text, extra));
      ev.attrs.context = { type: String(p.role ?? 'message') };
      this.flag(ev, 'meta');
      if (!this.inh) this.llmInput(ev);
    }
  }

  setUserKind(ev: EventRec, prompt: boolean): void {
    ev.kind = prompt ? 'user.prompt' : 'user.inject';
    ev.actor = prompt ? 'user' : 'harness';
    if (prompt) this.unflag(ev, 'meta');
    else this.flag(ev, 'meta');
  }

  /** A UserMessage item (or legacy user_message) mirrors the response_item message that carries the prompt. */
  linkUser(msg: EventRec, item: EventRec): void {
    this.setUserKind(msg, true);
    this.flag(item, 'dup');
    this.mirrorOf.set(item, msg);
  }

  userItem(ev: EventRec, text: string, images: number): void {
    this.set(ev, 'user.prompt', 'user', infoLine(text, imagesNote(images)));
    this.setText(ev, text);
    if (this.inh || !text) return;
    const hit = this.userMsgs.findIndex((m) => (m.attrs.text_len ?? 0) >= text.length && this.fullText(m).includes(text));
    if (hit >= 0) this.linkUser(this.userMsgs.splice(hit, 1)[0], ev);
    else this.userItems.push({ ev, text });
  }

  fullText(ev: EventRec): string {
    return this.fullTexts.get(ev) ?? String(ev.attrs.text ?? '');
  }

  reasoning(ev: EventRec, p: any): void {
    const summary = Array.isArray(p.summary) ? p.summary.map((s: any) => s?.text).filter((t: any) => typeof t === 'string').join('\n') : '';
    const text = summary || contentText(p.content).text;
    const enc = typeof p.encrypted_content === 'string' ? p.encrypted_content.length : 0;
    this.set(ev, 'llm.thinking', 'assistant', text ? flat(text) : enc ? `encrypted (${Math.max(1, Math.round(enc / 1024))} KB)` : 'reasoning (empty)');
    this.setText(ev, text);
    ev.attrs.llm = { reasoning_id: str(p.id), encrypted_bytes: enc || undefined };
    if (this.inh) return;
    this.llmOutput(ev, 'thinking');
    this.primary(ev, [p.id && `id:${p.id}`, text && `r:${text}`]);
  }

  // -------------------------------------------------------------------------
  // Tools

  toolCall(ev: EventRec, p: any): void {
    let name: string;
    let input: unknown;
    let callId: string | undefined = str(p.call_id);
    switch (p.type) {
      case 'function_call':
        name = String(p.name ?? '?');
        input = typeof p.arguments === 'string' ? (tryJson(p.arguments) ?? p.arguments) : p.arguments;
        break;
      case 'custom_tool_call':
        name = String(p.name ?? '?');
        input = p.input;
        break;
      case 'tool_search_call':
        name = 'tool_search';
        input = p.arguments;
        break;
      case 'local_shell_call':
        name = 'local_shell';
        input = p.action;
        break;
      default:
        name = 'web_search';
        input = p.action;
        callId = str(p.id) ?? `web:${this.posKey()}`;
    }
    const { name: display, server } = toolDisplayName(name, p.namespace);
    const args = input && typeof input === 'object' ? (input as any) : {};
    const codeMode = (p.type === 'custom_tool_call' && name === 'exec') || (name === 'wait' && args.cell_id !== undefined);
    const kind: ToolKindTag = codeMode ? 'custom' : toolKind(display, p.namespace);
    let inputSummary = '';
    if (codeMode && typeof input === 'string') inputSummary = execScriptSummary(input);
    else if (p.type === 'web_search_call') inputSummary = flat(`${args.type && args.type !== 'search' ? args.type + ' ' : ''}${args.query ?? args.queries?.[0] ?? args.url ?? args.pattern ?? ''}`, 160);
    const capped = compact(input, { maxString: INDEX_INPUT_MAX_STRING });
    if (!inputSummary) inputSummary = summarizeToolInput(display, typeof input === 'string' && name === 'apply_patch' ? input : capped);
    const tool: NonNullable<Attrs['tool']> = { name: display, call_id: callId, kind, input: capped, input_summary: inputSummary };
    if (server) tool.server = server;
    if (typeof p.namespace === 'string') tool.namespace = p.namespace;
    const command = commandLine(args.cmd ?? args.command);
    if (command && kind === 'shell') tool.command = truncate(command, INDEX_INPUT_MAX_STRING);
    if (typeof args.path === 'string' && kind === 'file') tool.path = fromFileUri(args.path);
    if (name === 'apply_patch' && typeof input === 'string') tool.path = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(input)?.[1];
    const proc = name === 'write_stdin' ? sessionKey(args.session_id) : undefined;
    if (proc) tool.proc_id = proc;
    // apply_patch as a custom tool, as a function ({input}), or as a shell command carrying the patch text.
    const patch = name === 'apply_patch' ? (typeof input === 'string' ? input : args.input) : kind === 'shell' ? command : undefined;
    if (typeof patch === 'string' && patch.includes('*** Begin Patch')) {
      const files = patchChanges(patch);
      if (files.length) ev.attrs.change = { files };
    }
    ev.attrs.tool = tool;
    this.set(ev, 'tool.call', 'assistant', `${display}  ${inputSummary}`.trim());
    if (this.inh) return;
    this.llmOutput(ev, 'calls');
    if (!callId) {
      this.expert('warn', 'unpaired', `${display} call without call_id`, ev);
      return;
    }
    const st: ToolState = {
      callId,
      name: display,
      kind,
      span: this.uniqueSpan('tool', callId),
      parent: this.container(),
      call: ev,
      start: ev.ts,
      tool: { ...tool },
      codeMode,
      turn: this.turn,
    };
    if (p.type === 'web_search_call') {
      st.noResult = true;
      st.status = str(p.status);
      this.takeWebSearchMirror(st);
    }
    ev.span = st.span;
    this.tools.set(callId, st);
    this.toolList.push(st);
    if (codeMode) {
      this.openCode.push(st);
      if (this.turn) this.turn.lastCodeTool = st;
    }
  }

  toolOutput(ev: EventRec, p: any): void {
    const callId = str(p.call_id);
    const out: OutputInfo =
      p.type === 'tool_search_output'
        ? { text: `${Array.isArray(p.tools) ? p.tools.length : 0} tools found`, images: 0 }
        : parseOutput(p.output);
    const tool: NonNullable<Attrs['tool']> = {
      call_id: callId,
      output: truncate(out.text, INDEX_TEXT_MAX),
      output_len: out.text.length,
    };
    if (out.text.length > INDEX_TEXT_MAX) this.flag(ev, 'truncated');
    const tail = outputTail(out.text);
    if (tail !== undefined) tool.output_tail = tail;
    if (out.exitCode !== undefined) tool.exit_code = out.exitCode;
    if (out.isError) tool.is_error = true;
    if (out.json?.timed_out === true) out.status = 'timed out';
    if (out.status) tool.status = out.status;
    if (out.procId) tool.proc_id = out.procId;
    if (out.wallMs !== undefined) tool.reported_wall_ms = out.wallMs;
    if (out.images) tool.images = out.images;
    ev.attrs.tool = tool;
    this.set(ev, 'tool.result', 'tool', `→ ${out.status ?? 'output'}`);
    if (out.isError) this.flag(ev, 'error');
    if (!this.inh && p.id) this.primary(ev, [`id:${p.id}`]);
    if (!callId) {
      // Automation outputs (automation_update) arrive with name+namespace and no call.
      const { name } = toolDisplayName(String(p.name ?? '?'), p.namespace);
      tool.name = name;
      if (typeof p.namespace === 'string') tool.namespace = p.namespace;
      tool.kind = toolKind(name, p.namespace);
      ev.summary = `${name}  → output without call_id  ${flat(out.text, 100)}`;
      this.flag(ev, 'orphan');
      if (!this.inh) this.expert('note', 'unpaired', `${name} output without call_id (harness-injected)`, ev);
      return;
    }
    if (this.inh) return;
    this.llmInput(ev);
    const st = this.tools.get(callId);
    if (!st) {
      this.flag(ev, 'orphan');
      ev.summary = `→ output for unknown call ${callId}`;
      this.expert('warn', 'unpaired', `output for call ${callId} without a matching call`, ev);
      return;
    }
    if (st.result) {
      // A yielded code-mode script ("Script running with cell ID N") keeps emitting outputs under its call_id.
      ev.span = st.span;
      Object.assign(tool, { name: st.name, kind: st.kind, late: true });
      ev.summary = infoLine('→ late output', fmtBytes(out.text.length), imagesNote(out.images));
      st.tool.late_outputs = (Number(st.tool.late_outputs) || 0) + 1;
      return;
    }
    st.result = ev;
    ev.span = st.span;
    tool.name = st.name;
    tool.kind = st.kind;
    // The call that opens or polls a process and its result both name it: exec_command learns N from its result,
    // a write_stdin result that only says "Process exited" takes N from its call.
    const callTool = st.call.attrs.tool!;
    if (tool.proc_id) callTool.proc_id ??= tool.proc_id;
    else if (callTool.proc_id) tool.proc_id = callTool.proc_id;
    Object.assign(st.tool, tool, { name: st.name, kind: st.kind, input: st.tool.input });
    const i = this.openCode.indexOf(st);
    if (i >= 0) this.openCode.splice(i, 1);
    const json = out.json;
    if (st.name === 'spawn_agent') {
      // A successful spawn returns JSON ({agent_id, nickname} in v1, {task_name} in v2); plain text is a refusal.
      if (!json) st.tool.is_error = true;
      else {
        if (typeof json.agent_id === 'string') st.linkSession = `cx:${json.agent_id}`;
        st.agent = { ...st.agent, nickname: str(json.nickname) ?? st.agent?.nickname, path: str(json.task_name) ?? st.agent?.path };
      }
    }
  }

  /** Item or legacy event that mirrors a model-level call: fold its facts into the tool span. */
  mergeIntoTool(st: ToolState, ev: EventRec): void {
    this.flag(ev, 'dup');
    ev.span = st.span;
    const t = ev.attrs.tool ?? {};
    for (const k of ['exit_code', 'is_error', 'command', 'path', 'server', 'files', 'parsed_cmd', 'requested_ms', 'query', 'results']) {
      if (t[k] !== undefined && st.tool[k] === undefined) st.tool[k] = t[k];
    }
    if (t.status !== undefined) st.tool.exec_status = t.status;
    if (t.output_len !== undefined) st.tool.exec_output_len = t.output_len;
    if (t.item_duration_ms !== undefined) st.tool.item_duration_ms = t.item_duration_ms;
    if (t.is_error) st.tool.is_error = true;
    // The item is a dup, so the call event keeps what derivation reads from it: the parsed command and its cwd.
    const call = st.call.attrs.tool!;
    if (t.parsed_cmd !== undefined) call.parsed_cmd ??= t.parsed_cmd;
    if (t.cwd !== undefined) call.cwd ??= t.cwd;
  }

  takeWebSearchMirror(st: ToolState): void {
    const m = this.pendingWebSearch;
    if (!m || m.turn !== st.call.turn) return;
    this.pendingWebSearch = undefined;
    this.mergeIntoTool(st, m);
  }

  // -------------------------------------------------------------------------
  // LLM runs: consecutive model-output items, closed by token_usage_record or token_count.

  llmOutput(ev: EventRec, what: keyof LlmRun['counts']): void {
    this.compaction = undefined;
    let run = this.llm;
    if (run?.inputSeen) {
      this.closeRun(run);
      run = undefined;
    }
    if (!run) {
      run = {
        events: [], first: ev, lastOut: ev, start: this.lastInputTs ?? ev.ts, parent: this.container(),
        inputSeen: false, hasRecord: false, hasCount: false, turnId: this.turn?.turnId,
        counts: { text: 0, thinking: 0, calls: 0 },
      };
      this.llm = run;
      this.runs.push(run);
    }
    if (ev.kind !== 'tool.call') run.events.push(ev);
    run.lastOut = ev;
    run.counts[what]++;
    this.runOf.set(ev, run);
  }

  llmInput(ev: EventRec, keepCompaction = false): void {
    if (!keepCompaction) this.compaction = undefined;
    if (this.llm) this.llm.inputSeen = true;
    this.lastInputTs = ev.ts;
  }

  closeRun(run: LlmRun, closer?: EventRec, tokens?: TokenUsage, src?: 'record' | 'count', responseId?: string): void {
    const end = closer && !run.inputSeen ? closer.ts : run.lastOut.ts;
    const start = Math.min(run.start, run.first.ts);
    const id = this.uniqueSpan('llm', responseId ?? this.posKey(run.first.raw.line));
    const dur = end - start;
    const rec: SpanRec = {
      rec: 'span',
      id,
      session: this.sid,
      kind: 'llm',
      name: this.model ?? 'llm',
      parent: run.parent,
      start,
      end,
      dur,
      durSrc: 'derived:ts-gap',
      status: 'ok',
      firstEvent: run.first.id,
      lastEvent: (closer ?? run.lastOut).id,
      attrs: {
        llm: { model: this.model, effort: this.effort, service_tier: this.serviceTier, response_id: responseId, latency_ms: dur / 1000, outputs: run.counts },
      },
    };
    for (const e of run.events) e.span = id;
    if (closer) {
      closer.span = id;
      closer.dur = dur;
      run.closer = closer;
      if (src === 'record') {
        run.hasRecord = true;
        run.recordTokens = tokens;
      } else {
        run.hasCount = true;
        run.countTokens = tokens;
      }
    }
    run.rec = rec;
    this.spans.push(rec);
    this.llm = undefined;
    this.lastRun = run;
  }

  /**
   * A usage event (token_usage_record or token_count) closes the open run. Records are the preferred token source
   * (they carry the response id). A token_count only echoes earlier usage when its cumulative total repeats the
   * previous count or its last usage equals the latest record; an echo is a dup and gives its run no tokens, so
   * no response is counted twice (CLI 0.153+ writes the record, then a token_count repeating it).
   */
  llmUsage(ev: EventRec, tokens: TokenUsage | undefined, src: 'record' | 'count', responseId?: string, repeat = false): void {
    if (src === 'record') return this.recordUsage(ev, tokens, responseId);
    const echo = repeat || (tokens !== undefined && this.lastRecordTokens !== undefined && sameUsage(tokens, this.lastRecordTokens));
    if (echo) this.flag(ev, 'dup');
    if (this.llm) return this.closeRun(this.llm, ev, echo ? undefined : tokens, src);
    // The token_count written after a token_usage_record reports the same response.
    const last = this.lastRun;
    if (last?.rec && last.hasRecord && !last.hasCount) {
      last.hasCount = true;
      ev.span = last.rec.id;
      this.flag(ev, 'dup');
      if (ev.attrs.ratelimit) last.rec.attrs.ratelimit = ev.attrs.ratelimit;
    }
  }

  recordUsage(ev: EventRec, tokens: TokenUsage | undefined, responseId?: string): void {
    this.lastRecordTokens = tokens;
    if (this.llm) return this.closeRun(this.llm, ev, tokens, 'record', responseId);
    // A record after its run was closed by a token_count or a turn boundary, in the same turn: that run's usage.
    const last = this.lastRun;
    const turnId = str(ev.attrs.turn?.id);
    const sameTurn = !turnId || !last?.turnId || turnId === last.turnId;
    if (last?.rec && !last.recordTokens && sameTurn && (!last.countTokens || (tokens && sameUsage(last.countTokens, tokens)))) {
      last.hasRecord = true;
      last.recordTokens = tokens;
      ev.span = last.rec.id;
      if (responseId) last.rec.attrs.llm!.response_id = responseId;
      if (last.closer?.proto.endsWith('/token_count')) this.flag(last.closer, 'dup');
      return;
    }
    // A model call that wrote no output items (a compaction request, for example) still used tokens: a span of its own.
    const run: LlmRun = {
      events: [], first: ev, lastOut: ev, start: this.lastInputTs ?? ev.ts, parent: this.container(), inputSeen: false,
      hasRecord: false, hasCount: false, turnId, counts: { text: 0, thinking: 0, calls: 0 },
    };
    this.runs.push(run);
    this.closeRun(run, ev, tokens, 'record', responseId);
    run.rec!.attrs.llm!.no_output = true;
  }

  tokenUsageRecord(ev: EventRec, p: any): void {
    p ??= {};
    const tokens = codexTokens(p.usage, this.contextWindow);
    this.set(ev, 'llm.usage', 'harness', tokSummary(this.model, tokens));
    ev.attrs.tokens = tokens;
    ev.attrs.llm = { model: this.model, response_id: str(p.response_id) };
    ev.attrs.tokens_turn = codexTokens(p.turn_token_usage);
    ev.attrs.tokens_thread = codexTokens(p.thread_token_usage);
    if (p.turn_id) ev.attrs.turn = { id: String(p.turn_id) };
    if (!this.inh) this.llmUsage(ev, tokens, 'record', str(p.response_id));
  }

  tokenCount(ev: EventRec, p: any): void {
    // Very old token_count payloads carried the usage fields directly.
    const info = p.info ?? (p.input_tokens !== undefined ? { last_token_usage: p } : null);
    const rate = rateLimits(p.rate_limits);
    if (rate) ev.attrs.ratelimit = rate;
    if (!this.inh && rate) this.rateLimitExpert(ev, rate);
    if (!info) {
      this.set(ev, 'harness.ratelimit', 'harness', rateSummary(rate) || 'token_count (no usage)');
      return;
    }
    if (!this.inh && num(info.model_context_window)) this.contextWindow = info.model_context_window;
    const tokens = codexTokens(info.last_token_usage, this.contextWindow);
    this.set(ev, 'llm.usage', 'harness', `${tokSummary(this.model, tokens)}${rate ? '  ' + rateSummary(rate) : ''}`);
    ev.attrs.tokens = tokens;
    ev.attrs.tokens_cumulative = codexTokens(info.total_token_usage);
    ev.attrs.llm = { model: this.model };
    if (this.inh) return;
    const total = num(info.total_token_usage?.total_tokens);
    const repeat = total !== undefined && total === this.lastCountTotal;
    this.lastCountTotal = total;
    this.llmUsage(ev, tokens, 'count', undefined, repeat);
  }

  rateLimitExpert(ev: EventRec, r: NonNullable<Attrs['ratelimit']>): void {
    const hit = (r.used_percent ?? 0) >= 100 || (num(r.secondary_used_percent) ?? 0) >= 100 || r.reached;
    const key = `${r.limit_id ?? ''}:${r.reached ?? 'full'}`;
    if (!hit || this.rateWarned.has(key)) return;
    this.rateWarned.add(key);
    this.expert('warn', 'rate-limit', `rate limit reached: ${rateSummary(r)}${r.reached ? ` (${r.reached})` : ''}`, ev);
  }

  // -------------------------------------------------------------------------
  // Mirrors: item_completed AgentMessage/Reasoning and legacy agent_message/agent_reasoning repeat a response_item.

  primary(ev: EventRec, keys: unknown[]): void {
    const ks = keys.filter((k): k is string => typeof k === 'string' && k.length > 2).map((k) => k.slice(0, 2000));
    for (const k of ks) {
      const m = this.mirrorWait.get(k);
      if (m) {
        for (const mk of m.keys) this.mirrorWait.delete(mk);
        this.link(m, ev);
        return;
      }
    }
    const w: Waiter = { ev, keys: ks };
    for (const k of ks) this.primaryWait.set(k, w);
  }

  mirror(ev: EventRec, key: string | undefined, timing?: [number | undefined, number | undefined]): void {
    if (!key) return;
    key = key.slice(0, 2000);
    const w: Waiter = { ev, keys: [key], timing };
    const p = this.primaryWait.get(key);
    if (p) {
      for (const k of p.keys) this.primaryWait.delete(k);
      this.link(w, p.ev);
    } else this.mirrorWait.set(key, w);
  }

  link(m: Waiter, primary: EventRec): void {
    this.flag(m.ev, 'dup');
    this.mirrorOf.set(m.ev, primary);
    const run = this.runOf.get(primary);
    const [s, e] = m.timing ?? [];
    if (run && s && e && e >= s) {
      run.itemStartMs = Math.min(run.itemStartMs ?? s, s);
      run.itemEndMs = Math.max(run.itemEndMs ?? e, e);
    }
  }

  // -------------------------------------------------------------------------
  // event_msg

  eventMsg(ev: EventRec, p: any): void {
    p ??= {};
    switch (p.type) {
      case 'token_count': return this.tokenCount(ev, p);
      case 'task_started': return this.taskStarted(ev, p);
      case 'task_complete': return this.taskEnded(ev, p, false);
      case 'turn_aborted': return this.taskEnded(ev, p, true);
      case 'item_completed': return this.itemCompleted(ev, p);
      case 'thread_settings_applied': {
        const s = p.thread_settings ?? {};
        if (!this.inh) this.noteModel(s.model, s.reasoning_effort, s.service_tier);
        this.set(ev, 'session.state', 'harness',
          infoLine('settings', `${s.model ?? ''} ${s.reasoning_effort ?? ''}`, `tier=${s.service_tier ?? '?'}`, `approval=${s.approval_policy ?? '?'}`));
        ev.attrs.llm = { model: str(s.model), effort: str(s.reasoning_effort), service_tier: str(s.service_tier) };
        ev.attrs.permission = { mode: str(s.approval_policy) };
        ev.attrs.context = { type: 'thread_settings' };
        return;
      }
      case 'thread_goal_updated': {
        const g = p.goal ?? {};
        this.set(ev, 'session.state', 'harness', infoLine(
          `goal ${g.status ?? '?'}`, num(g.timeUsedSeconds) !== undefined && fmtDur(g.timeUsedSeconds * 1e6), num(g.tokensUsed) !== undefined && `${fmtTok(g.tokensUsed)} tokens`, g.objective));
        ev.attrs.context = { type: 'goal', status: str(g.status), tokens_used: num(g.tokensUsed), time_used_s: num(g.timeUsedSeconds) };
        return;
      }
      // Legacy event_msg types (rollouts written before the legacy_to_paginated_v1 migration).
      case 'user_message': {
        const text = String(p.message ?? '');
        return this.userItem(ev, text, Array.isArray(p.images) ? p.images.length : 0);
      }
      case 'agent_message': {
        const text = String(p.message ?? '');
        this.set(ev, 'llm.text', 'assistant', flat(text));
        this.setText(ev, text);
        if (!this.inh) this.mirror(ev, text && `a:${text}`);
        return;
      }
      case 'agent_reasoning':
      case 'agent_reasoning_raw_content': {
        const text = String(p.text ?? '');
        this.set(ev, 'llm.thinking', 'assistant', flat(text) || 'reasoning');
        this.setText(ev, text);
        if (!this.inh) this.mirror(ev, text && `r:${text}`);
        return;
      }
      case 'exec_command_begin':
      case 'exec_command_end':
      case 'patch_apply_begin':
      case 'patch_apply_end':
      case 'mcp_tool_call_begin':
      case 'mcp_tool_call_end':
      case 'web_search_begin':
      case 'web_search_end':
      case 'view_image_tool_call':
        return this.legacyExec(ev, p);
      case 'exec_approval_request':
      case 'apply_patch_approval_request': {
        const cmd = commandLine(p.command);
        this.set(ev, 'permission.request', 'harness', infoLine(`${p.type === 'exec_approval_request' ? 'exec' : 'apply_patch'} approval`, cmd, p.reason));
        ev.attrs.permission = { tool: p.type === 'exec_approval_request' ? 'exec_command' : 'apply_patch', reason: str(p.reason) };
        ev.attrs.tool = { call_id: str(p.call_id), command: cmd };
        return;
      }
      case 'error':
      case 'stream_error': {
        this.set(ev, 'llm.error', 'system', infoLine(p.type, p.message));
        ev.attrs.error = { type: p.type, message: truncate(str(p.message), 1024) };
        this.flag(ev, 'error');
        if (!this.inh) this.expert(p.type === 'error' ? 'error' : 'warn', 'api-error', flat(String(p.message ?? p.type), 200), ev);
        return;
      }
      case 'background_event':
        return this.set(ev, 'harness.status', 'harness', flat(String(p.message ?? 'background event'), 160));
      case 'turn_diff':
        return this.set(ev, 'harness.file', 'harness', `turn diff  ${fmtBytes(String(p.unified_diff ?? '').length)}`);
      case 'plan_update': {
        const steps = Array.isArray(p.plan) ? p.plan.length : 0;
        return this.set(ev, 'harness.other', 'harness', infoLine('plan update', `${steps} steps`, p.explanation));
      }
      case 'entered_review_mode':
      case 'exited_review_mode':
        return this.set(ev, 'agent.status', 'agent', p.type === 'entered_review_mode' ? 'review mode entered' : 'review mode exited');
      case 'context_compacted':
        this.set(ev, 'context.compaction', 'harness', 'context compacted');
        if (!this.inh) this.compactionPart(ev, 'item');
        return;
      case 'session_configured':
      case 'shutdown_complete':
        return this.set(ev, 'session.state', 'harness', `${p.type}${p.model ? '  ' + p.model : ''}`);
      default:
        return this.unknownEvent(ev);
    }
  }

  legacyExec(ev: EventRec, p: any): void {
    const t = String(p.type);
    const begin = t.endsWith('_begin');
    const tool: NonNullable<Attrs['tool']> = { call_id: str(p.call_id) };
    let what: string;
    if (t.startsWith('exec_command')) {
      const cmd = commandLine(p.command);
      Object.assign(tool, { name: 'exec_command', kind: 'shell', command: cmd && truncate(cmd, INDEX_INPUT_MAX_STRING) });
      if (Array.isArray(p.parsed_cmd)) tool.parsed_cmd = compact(p.parsed_cmd, { maxString: INDEX_INPUT_MAX_STRING });
      what = `exec_command ${begin ? 'begin' : 'end'}  ${flat(cmd, 120)}`;
      if (!begin) {
        tool.exit_code = num(p.exit_code);
        const out = String(p.aggregated_output ?? p.formatted_output ?? `${p.stdout ?? ''}${p.stderr ?? ''}`);
        tool.output_len = out.length;
        tool.output = truncate(out, INDEX_TEXT_MAX);
        const tail = outputTail(out);
        if (tail !== undefined) tool.output_tail = tail;
        what += `  → exit ${tool.exit_code ?? '?'}`;
      }
    } else if (t.startsWith('patch_apply')) {
      const files = p.changes && typeof p.changes === 'object' ? Object.keys(p.changes) : [];
      Object.assign(tool, { name: 'apply_patch', kind: 'file', path: files[0] });
      if (files.length) tool.files = files.length;
      // Begin carries the request; a later end may repeat it, and the files count once.
      if (begin && files.length) ev.attrs.change = { files: fileChanges(p.changes) };
      what = `apply_patch ${begin ? 'begin' : p.success === false ? 'failed' : 'end'}  ${files.map((f) => basename(f)).slice(0, 3).join(', ')}`;
      if (p.success === false) tool.is_error = true;
    } else if (t.startsWith('mcp_tool_call')) {
      const inv = p.invocation ?? {};
      Object.assign(tool, { name: `mcp__${inv.server}__${inv.tool}`, kind: 'mcp', server: str(inv.server) });
      const err = p.result && typeof p.result === 'object' && ('Err' in p.result || p.result.Ok?.isError);
      if (err) tool.is_error = true;
      what = `mcp ${inv.server}.${inv.tool} ${begin ? 'begin' : err ? 'error' : 'end'}`;
    } else if (t.startsWith('web_search')) {
      Object.assign(tool, { name: 'web_search', kind: 'web', query: str(p.query) });
      what = `web_search ${begin ? 'begin' : 'end'}  ${flat(p.query, 120)}`;
    } else {
      Object.assign(tool, { name: 'view_image', kind: 'file', path: fromFileUri(p.path) });
      what = `view_image  ${basename(String(p.path ?? ''))}`;
    }
    const d = rustDurUs(p.duration);
    if (d !== undefined && d >= 1000) tool.item_duration_ms = d / 1000;
    ev.attrs.tool = tool;
    this.set(ev, 'tool.exec', 'tool', flat(what, 200));
    if (tool.is_error || (tool.exit_code !== undefined && tool.exit_code !== 0)) this.flag(ev, 'error');
    if (this.inh) return;
    const st = tool.call_id ? this.tools.get(tool.call_id) : undefined;
    if (st) this.mergeIntoTool(st, ev);
  }

  // -------------------------------------------------------------------------
  // Turns

  taskStarted(ev: EventRec, p: any): void {
    this.set(ev, 'turn.start', 'harness', 'turn start');
    if (p.turn_id != null) ev.attrs.turn = { id: String(p.turn_id) };
    if (this.inh) return;
    if (this.turn) this.closeTurn(undefined);
    if (this.llm) this.closeRun(this.llm);
    const turnId = p.turn_id != null ? String(p.turn_id) : undefined;
    if (turnId && /^(rollout-)?\d+$/.test(turnId)) this.syntheticIds = true;
    const span = this.uniqueSpan('turn', turnId ?? this.posKey());
    const turn: TurnState = {
      span, turnId, index: this.turns.length + 1, start: ev.ts, startEv: ev, lastEv: ev,
      durSrc: 'unknown', status: 'open', model: this.model,
    };
    this.turns.push(turn);
    this.turn = turn;
    ev.span = span;
    ev.turn = span;
    ev.attrs.turn = { id: turnId, index: turn.index, origin: str(p.turn_attribution?.turn_trigger) };
    this.lastInputTs = ev.ts;
    this.lastRun = undefined;
    this.openCode = [];
    this.compaction = undefined;
    this.pendingWebSearch = undefined;
    this.mirrorWait.clear();
    this.primaryWait.clear();
    this.userMsgs = [];
    this.userItems = [];
    this.fullTexts.clear();
    if (num(p.model_context_window)) this.contextWindow = p.model_context_window;
  }

  taskEnded(ev: EventRec, p: any, aborted: boolean): void {
    this.set(ev, aborted ? 'turn.abort' : 'turn.end', 'harness', aborted ? `turn aborted (${p.reason ?? '?'})` : 'turn done');
    if (p.turn_id != null) ev.attrs.turn = { id: String(p.turn_id) };
    if (typeof p.last_agent_message === 'string') this.setText(ev, p.last_agent_message);
    if (p.error) {
      ev.attrs.error = { type: str(p.error.codex_error_info) ?? 'error', message: truncate(str(p.error.message), 1024) };
      this.flag(ev, 'error');
    }
    if (this.inh) return;
    const t = this.turn;
    if (!t) {
      this.expert('note', 'sequence', `${p.type} without an open turn`, ev);
      return;
    }
    if (this.llm) this.closeRun(this.llm);
    ev.span = t.span;
    ev.turn = t.span;
    const logged = num(p.duration_ms);
    if (logged !== undefined) {
      t.dur = Math.round(logged * 1000);
      t.durSrc = `logged:${aborted ? 'turn_aborted' : 'task_complete'}.duration_ms`;
    }
    t.ttftMs = num(p.time_to_first_token_ms);
    t.status = aborted ? (p.reason === 'interrupted' ? 'interrupted' : 'cancelled') : p.error ? 'error' : 'ok';
    this.closeTurn(ev);
    if (aborted) this.expert('note', 'interrupted', `turn ${t.index} aborted (${p.reason ?? '?'})`, ev, t.span);
    if (p.error) this.expert('error', 'api-error', flat(`turn ${t.index} failed: ${p.error.message ?? p.error.codex_error_info ?? ''}`, 200), ev, t.span);
  }

  closeTurn(endEv: EventRec | undefined): void {
    const t = this.turn!;
    t.endEv = endEv;
    if (!endEv) t.status = 'unknown';
    this.turn = undefined;
    this.lastRun = undefined;
  }

  // -------------------------------------------------------------------------
  // item_completed

  itemCompleted(ev: EventRec, p: any): void {
    const it = p.item && typeof p.item === 'object' ? p.item : {};
    const id = str(it.id);
    if (id && SYNTHETIC_ID_RE.test(id)) this.syntheticIds = true;
    const started = num(p.started_at_ms);
    const completed = num(p.completed_at_ms) || undefined;
    const timing: [number | undefined, number | undefined] = [started, completed];
    switch (it.type) {
      case 'UserMessage': {
        const { text, images } = contentText(it.content);
        return this.userItem(ev, text, images);
      }
      case 'AgentMessage': {
        const { text } = contentText(it.content);
        this.set(ev, 'llm.text', 'assistant', flat(text) || `${Array.isArray(it.questions) ? it.questions.length + ' questions' : 'agent message'}`);
        this.setText(ev, text);
        ev.attrs.llm = { message_id: id, phase: str(it.phase) };
        if (this.inh) return;
        const st = id ? this.tools.get(id) : undefined;
        if (st) return this.mergeIntoTool(st, ev);
        return this.mirror(ev, id && !SYNTHETIC_ID_RE.test(id) ? `id:${id}` : text && `a:${text}`, timing);
      }
      case 'Reasoning': {
        const text = Array.isArray(it.summary_text) ? it.summary_text.join('\n') : contentText(it.summary).text;
        this.set(ev, 'llm.thinking', 'assistant', flat(text) || 'reasoning');
        this.setText(ev, text);
        ev.attrs.llm = { reasoning_id: id };
        if (this.inh) return;
        return this.mirror(ev, id && !SYNTHETIC_ID_RE.test(id) ? `id:${id}` : text && `r:${text}`, timing);
      }
      case 'CommandExecution':
      case 'FileChange':
      case 'McpToolCall':
      case 'DynamicToolCall':
      case 'ImageView':
      case 'WebSearch':
      case 'Extension':
        return this.execItem(ev, it, timing);
      case 'SubAgentActivity': {
        const link = str(it.agent_thread_id) && `cx:${it.agent_thread_id}`;
        this.set(ev, it.kind === 'started' ? 'agent.spawn' : 'agent.status', 'agent',
          infoLine(`subagent ${it.kind ?? '?'}`, it.agent_path, shortId(it.agent_thread_id)));
        ev.attrs.agent = { link_session: link, path: str(it.agent_path), status: str(it.kind) };
        if (this.inh) return;
        const st = id ? this.tools.get(id) : undefined;
        if (!st) return;
        this.mergeIntoTool(st, ev);
        st.agent = { ...st.agent, path: str(it.agent_path) ?? st.agent?.path, link_session: link ?? st.agent?.link_session };
        if (st.name === 'spawn_agent' && link) st.linkSession = link;
        return;
      }
      case 'CollabAgentToolCall': {
        const receivers = Array.isArray(it.receiver_thread_ids) ? it.receiver_thread_ids.map((r: unknown) => `cx:${r}`) : [];
        this.set(ev, 'agent.status', 'agent', infoLine(`${it.tool ?? 'collab'} ${it.status ?? ''}`, `${receivers.length} agent${receivers.length === 1 ? '' : 's'}`));
        ev.attrs.agent = { receivers };
        if (this.inh) return;
        const st = id ? this.tools.get(id) : undefined;
        if (st) this.mergeIntoTool(st, ev);
        return;
      }
      case 'ContextCompaction':
        this.set(ev, 'context.compaction', 'harness', 'context compaction item');
        ev.attrs.context = { type: 'compaction' };
        if (!this.inh) this.compactionPart(ev, 'item', timing);
        return;
      case 'EnteredReviewMode':
        return this.set(ev, 'agent.status', 'agent', infoLine('review mode entered', `${it.target?.type ?? ''} ${it.target?.branch ?? ''}`));
      case 'ExitedReviewMode': {
        const r = it.review_output ?? {};
        const n = Array.isArray(r.findings) ? r.findings.length : 0;
        this.set(ev, 'agent.status', 'agent', infoLine('review done', `${n} finding${n === 1 ? '' : 's'}`, r.overall_correctness));
        if (typeof r.overall_explanation === 'string') this.setText(ev, r.overall_explanation);
        return;
      }
      case 'Plan':
        this.set(ev, 'llm.text', 'assistant', infoLine('plan', it.text));
        this.setText(ev, String(it.text ?? ''));
        return;
      case 'FunctionCallOutput': {
        const out = parseOutput(it.output);
        this.set(ev, 'tool.result', 'tool', infoLine(it.name ?? 'output', `→ ${flat(out.text, 100)}`));
        ev.attrs.tool = { name: str(it.name), output: truncate(out.text, INDEX_TEXT_MAX), output_len: out.text.length };
        const tail = outputTail(out.text);
        if (tail !== undefined) ev.attrs.tool.output_tail = tail;
        if (!this.inh && id) this.mirror(ev, `id:${id}`);
        return;
      }
      default:
        return this.unknownEvent(ev);
    }
  }

  /** Execution items: nested exec-* items get their own span; items whose id is a call_id mirror that call. */
  execItem(ev: EventRec, it: any, timing: [number | undefined, number | undefined]): void {
    const d = describeExecItem(it);
    ev.attrs.tool = d.tool;
    if (d.files?.length) ev.attrs.change = { files: d.files };
    this.set(ev, 'tool.exec', 'tool', d.summary);
    if (d.error) this.flag(ev, 'error');
    // Logged item durations under 1 ms are placeholders (SPEC §3.2).
    const [s, c] = timing;
    let dur: number | undefined;
    let durSrc = 'unknown';
    const itemDur = rustDurUs(it.duration);
    if (itemDur !== undefined && itemDur >= 1000) {
      dur = itemDur;
      durSrc = 'logged:item.duration';
    } else if (s !== undefined && c !== undefined && c - s >= 1) {
      dur = (c - s) * 1000;
      durSrc = 'logged:item_completed.started_at_ms';
    }
    if (dur !== undefined) {
      d.tool.item_duration_ms = dur / 1000;
      ev.summary += ` · ${fmtDur(dur)}`;
    }
    if (this.inh) return;
    const id = str(it.id);
    const st = id ? this.tools.get(id) : undefined;
    if (st) return this.mergeIntoTool(st, ev);
    if (it.type === 'WebSearch' && !id?.startsWith('exec-')) {
      this.pendingWebSearch = ev;
      return;
    }
    if (!id?.startsWith('exec-')) return;

    let parent = this.openCode[this.openCode.length - 1];
    let inferred = false;
    if (!parent && this.turn?.lastCodeTool) {
      parent = this.turn.lastCodeTool;
      inferred = true;
    }
    if (parent) {
      // The script that ran this item, so an item that failed under a script reported ok can be told apart.
      d.tool.parent_call_id = parent.callId;
      if (d.error) parent.innerErrors = (parent.innerErrors ?? 0) + 1;
    }
    const end = c !== undefined ? c * 1000 : ev.ts;
    const start = dur !== undefined ? end - dur : s !== undefined ? s * 1000 : end;
    const span = this.uniqueSpan('exec', id);
    ev.span = span;
    if (dur !== undefined) ev.dur = dur;
    if (inferred) this.flag(ev, 'inferred');
    this.spans.push({
      rec: 'span',
      id: span,
      session: this.sid,
      kind: 'exec',
      name: d.name,
      parent: parent?.span ?? this.container(),
      start,
      end,
      dur,
      durSrc,
      status: d.error ? 'error' : 'ok',
      firstEvent: ev.id,
      lastEvent: ev.id,
      attrs: { tool: { ...d.tool, output: undefined, output_tail: undefined }, ...(inferred ? { inferred: true } : {}) },
    });
  }

  // -------------------------------------------------------------------------
  // Compaction: the `compacted` record, the ContextCompaction item and the compaction response_item describe one event.

  compacted(ev: EventRec, p: any): void {
    p ??= {};
    const items = Array.isArray(p.replacement_history) ? p.replacement_history.length : 0;
    this.set(ev, 'context.compaction', 'harness',
      infoLine('compacted', `${items} items kept`, num(p.window_number) !== undefined && `window ${p.window_number}`));
    ev.attrs.context = { type: 'compacted', items, window_number: num(p.window_number), window_id: str(p.window_id), response_id: str(p.compaction_response_id) };
    if (p.message) this.setText(ev, String(p.message));
    if (this.inh) return;
    this.llmInput(ev, true);
    this.compactionPart(ev, 'record');
  }

  compactionPart(ev: EventRec, part: 'record' | 'item' | 'summary', timing?: [number | undefined, number | undefined]): void {
    let c = this.compaction;
    if (!c) {
      const id = this.uniqueSpan('compaction', this.posKey());
      const start = this.prevTs ?? ev.ts;
      c = {
        rec: { rec: 'span', id, session: this.sid, kind: 'compaction', name: 'compaction', parent: this.container(), start, end: ev.ts,
          dur: ev.ts - start, durSrc: 'derived:ts-gap', status: 'ok', firstEvent: ev.id, lastEvent: ev.id, attrs: { context: { type: 'compaction' } } },
        parts: [],
        items: [],
      };
      this.compaction = c;
      this.compactions.push(c);
      this.spans.push(c.rec);
    }
    c.parts.push(ev);
    ev.span = c.rec.id;
    c.rec.lastEvent = ev.id;
    if (part === 'record') c.record = ev;
    if (part === 'item') c.items.push(ev);
    const [s, e] = timing ?? [];
    if (s !== undefined && e !== undefined && e - s >= 1) {
      c.rec.start = s * 1000;
      c.rec.end = e * 1000;
      c.rec.dur = (e - s) * 1000;
      c.rec.durSrc = 'logged:item_completed.started_at_ms';
    } else if (c.rec.durSrc === 'derived:ts-gap' && part === 'record') {
      c.rec.end = ev.ts;
      c.rec.dur = ev.ts - c.rec.start;
    }
  }

  // -------------------------------------------------------------------------
  // Finish: resolve spans and summaries, then emit in contract order.

  finish(sink: RecordSink): void {
    if (!this.session) this.initSession(undefined, undefined);
    if (this.llm) this.closeRun(this.llm);
    const openTurn = this.turn;
    if (openTurn) this.turn = undefined;

    for (const [m, prim] of this.mirrorOf) if (prim.span) m.span = prim.span;
    this.finishRuns();
    this.finishTools(openTurn);
    this.finishCompactions();
    const prompts = this.finishTurns(openTurn);
    this.finishSession(prompts);

    this.stats.inherited = this.inheritedCount;
    this.stats.dialect = this.dialect;
    for (const [proto, u] of this.unknown) {
      this.experts.push({ rec: 'expert', session: this.sid, event: u.first, severity: 'note', group: 'undecoded', message: `${u.count}× undecoded record ${proto}` });
    }
    if (this.inheritedCount) {
      this.expert('note', 'logging-gap', `${this.inheritedCount} records copied from the parent thread (ordinal < ${this.historyStart}) carry this thread's creation time`);
    }
    if (this.prefix?.note) this.expert('note', 'logging-gap', this.prefix.note);
    if (this.syntheticIds) {
      this.expert('note', 'logging-gap', 'rollout rewritten by legacy_to_paginated_v1: synthetic item and turn ids, item times equal write times');
    }
    if (this.abandon && this.abandonedFirst !== undefined) {
      this.expert('note', 'sequence', `lines ${this.abandonedFirst}+ (bytes ≥ ${this.abandon.offset}) were replaced by continuation page ${basename(this.abandon.page)}`);
    }

    sink.emit(this.session!);
    for (const e of this.events) sink.emit(e);
    for (const s of this.spans) sink.emit(s);
    for (const x of this.experts) sink.emit(x);
  }

  finishRuns(): void {
    for (const run of this.runs) {
      const rec = run.rec;
      if (!rec) continue;
      const tokens = run.recordTokens ?? run.countTokens;
      if (tokens) rec.attrs.tokens = tokens;
      if (run.itemStartMs !== undefined) {
        const ttft = run.itemStartMs - rec.start / 1000;
        if (ttft >= 0) rec.attrs.llm!.ttft_ms = ttft;
        if (run.itemEndMs !== undefined) rec.attrs.llm!.stream_ms = run.itemEndMs - run.itemStartMs;
      }
      if (run.closer) run.closer.summary = tokSummary(rec.name, run.closer.attrs.tokens) + (run.closer.attrs.ratelimit ? `  ${rateSummary(run.closer.attrs.ratelimit)}` : '');
    }
  }

  finishTools(openTurn: TurnState | undefined): void {
    for (const st of this.toolList) {
      const r = st.result;
      const t = st.tool;
      let status: SpanStatus;
      if (r) status = t.is_error ? 'error' : t.status === 'cancelled' ? 'cancelled' : 'ok';
      else if (st.noResult) status = st.status && st.status !== 'completed' ? 'unknown' : 'ok';
      else if (st.turn && st.turn === openTurn) status = 'open';
      else if (st.turn?.status === 'interrupted' || st.turn?.status === 'cancelled') status = 'interrupted';
      else status = 'unknown';
      if (status === 'ok' && t.exit_code !== undefined && t.exit_code !== 0) status = 'error';
      const dur = r ? r.ts - st.start : undefined;
      if (st.innerErrors) {
        // The script's own status stays as logged; the count makes the hidden failures visible on the call.
        t.inner_errors = st.innerErrors;
        if (r) r.attrs.tool!.inner_errors = st.innerErrors;
      }
      const agent = st.agent ?? (st.linkSession ? {} : undefined);
      if (agent && st.linkSession) agent.link_session = st.linkSession;
      this.spans.push({
        rec: 'span',
        id: st.span,
        session: this.sid,
        kind: 'tool',
        name: st.name,
        parent: st.parent,
        start: st.start,
        end: r ? r.ts : undefined,
        dur,
        durSrc: r ? 'derived:ts-gap' : 'unknown',
        status,
        linkSession: st.linkSession,
        firstEvent: st.call.id,
        lastEvent: r?.id ?? st.call.id,
        attrs: { tool: { ...t, output: undefined, output_tail: undefined }, ...(agent ? { agent } : {}) },
      });
      if (agent) st.call.attrs.agent = agent;
      st.call.dur = dur;
      if (r) {
        r.dur = dur;
        r.summary = resultSummary(st, status, dur);
        if (status === 'error') {
          this.flag(r, 'error');
          this.expert('warn', 'tool-error', `${st.name} ${r.summary}`, r, st.span);
        }
      } else if (!st.noResult) {
        const sev: ExpertSeverity = status === 'interrupted' || status === 'open' ? 'note' : 'warn';
        this.expert(sev, 'unpaired', `${st.name} call ${st.callId} has no output (${status})`, st.call, st.span);
      }
    }
  }

  finishCompactions(): void {
    for (const c of this.compactions) {
      if (c.record) for (const it of c.items) this.flag(it, 'dup');
      for (const e of c.parts) e.dur = c.rec.dur;
      const win = c.record?.attrs.context?.window_number;
      this.expert('note', 'compaction', `context compacted${win !== undefined ? ` (window ${win})` : ''}  ${fmtDur(c.rec.dur)}`, c.parts[0], c.rec.id);
    }
  }

  /** Emits turn spans; returns the first prompt of each turn by span id. */
  finishTurns(openTurn: TurnState | undefined): Map<string, EventRec> {
    const prompts = new Map<string, EventRec>();
    for (const e of this.events) {
      if (e.kind === 'user.prompt' && e.turn && !e.flags?.includes('dup') && !prompts.has(e.turn)) prompts.set(e.turn, e);
    }
    for (const t of this.turns) {
      const endEv = t.endEv ?? t.lastEv;
      const end = endEv.ts;
      if (t.dur === undefined) {
        t.dur = end - t.start;
        t.durSrc = t.endEv ? 'derived:ts-gap' : 'unknown';
      }
      if (t === openTurn) t.status = 'open';
      const prompt = prompts.get(t.span);
      const excerpt = prompt ? flat(String(prompt.attrs.text ?? prompt.summary), 100) : '';
      this.spans.push({
        rec: 'span',
        id: t.span,
        session: this.sid,
        kind: 'turn',
        name: excerpt || `turn ${t.index}`,
        parent: this.sessionSpan,
        start: t.start,
        end,
        dur: t.durSrc === 'unknown' ? undefined : t.dur,
        durSrc: t.durSrc,
        status: t.status,
        firstEvent: t.startEv.id,
        lastEvent: endEv.id,
        attrs: { turn: { id: t.turnId, index: t.index }, llm: { model: t.model, ttft_ms: t.ttftMs } },
      });
      t.startEv.summary = infoLine(`turn ${t.index}`, t.model, excerpt);
      t.startEv.dur = t.dur;
      if (t.endEv) {
        t.endEv.dur = t.dur;
        const ttft = t.ttftMs !== undefined ? `  ttft ${fmtDur(t.ttftMs * 1000)}` : '';
        if (t.status === 'interrupted' || t.status === 'cancelled') t.endEv.summary = `turn ${t.index} aborted  ${fmtDur(t.dur)}`;
        else if (t.status === 'error') t.endEv.summary = infoLine(`turn ${t.index} failed`, fmtDur(t.dur), t.endEv.attrs.error?.message);
        else t.endEv.summary = `turn ${t.index} done  ${fmtDur(t.dur)}${ttft}`;
      }
    }
    return prompts;
  }

  finishSession(prompts: Map<string, EventRec>): void {
    const s = this.session!;
    s.models = [...this.models];
    if (!s.models.length && this.model) s.models = [this.model];
    const nick = s.meta?.agent_nickname;
    const path = s.meta?.agent_path;
    const first = prompts.values().next().value;
    if (s.role === 'subagent' && (nick || path)) s.title = flat(`${nick ?? ''} ${path ?? ''}`, 80);
    else if (s.role === 'guardian') s.title = 'guardian review';
    else if (first) s.title = flat(String(first.attrs.text ?? first.summary), 80);

    if (!this.events.length) return;
    let start = Infinity;
    let end = -Infinity;
    for (const e of this.events) {
      if (e.ts < start) start = e.ts;
      if (e.ts > end) end = e.ts;
    }
    this.spans.unshift({
      rec: 'span',
      id: this.sessionSpan,
      session: this.sid,
      kind: 'session',
      name: s.title ?? s.nativeId,
      start,
      end,
      dur: end - start,
      durSrc: 'derived:ts-gap',
      status: 'ok',
      firstEvent: this.events[0].id,
      lastEvent: this.events[this.events.length - 1].id,
      attrs: {},
    });
  }
}

// ---------------------------------------------------------------------------
// Execution items (CommandExecution, FileChange, McpToolCall, ...)

function describeExecItem(it: any): { name: string; tool: NonNullable<Attrs['tool']>; summary: string; error: boolean; files?: ChangeFile[] } {
  const status = str(it.status);
  switch (it.type) {
    case 'CommandExecution': {
      const cmd = commandLine(it.command) ?? '';
      const out = typeof it.aggregated_output === 'string' ? it.aggregated_output : '';
      const exit = num(it.exit_code);
      const error = status === 'failed' || (exit !== undefined && exit !== 0);
      const tool: NonNullable<Attrs['tool']> = {
        name: 'exec_command', kind: 'shell', command: truncate(cmd, INDEX_INPUT_MAX_STRING), exit_code: exit, status,
        output: truncate(out, INDEX_TEXT_MAX), output_len: out.length, cwd: fromFileUri(it.cwd),
      };
      const tail = outputTail(out);
      if (tail !== undefined) tool.output_tail = tail;
      // [{type read|search|list_files|unknown, cmd, name?, path?, query?}]: target keys and reads (SPEC §12.3.4, §12.3.8).
      if (Array.isArray(it.parsed_cmd)) tool.parsed_cmd = compact(it.parsed_cmd, { maxString: INDEX_INPUT_MAX_STRING });
      if (error) tool.is_error = true;
      return { name: 'exec_command', tool, error, summary: infoLine('exec_command', flat(cmd, 120), `→ exit ${exit ?? status ?? '?'}`) };
    }
    case 'FileChange': {
      const changes = it.changes && typeof it.changes === 'object' ? Object.entries(it.changes) : [];
      const files = changes.map(([p, c]: [string, any]) => `${c?.type ?? 'change'} ${basename(p)}`);
      const error = status === 'failed';
      const tool: NonNullable<Attrs['tool']> = { name: 'apply_patch', kind: 'file', status, files: changes.length, path: changes[0]?.[0] };
      if (error) tool.is_error = true;
      return {
        name: 'apply_patch', tool, error, files: fileChanges(it.changes),
        summary: infoLine('apply_patch', files.slice(0, 3).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : ''), status),
      };
    }
    case 'McpToolCall': {
      const error = status === 'failed' || it.result?.isError === true;
      const tool: NonNullable<Attrs['tool']> = {
        name: `mcp__${it.server}__${it.tool}`, kind: 'mcp', server: str(it.server), status,
        input: compact(it.arguments, { maxString: INDEX_INPUT_MAX_STRING }),
      };
      if (error) tool.is_error = true;
      return { name: tool.name!, tool, error, summary: infoLine(`mcp ${it.server}.${it.tool}`, `→ ${error ? 'error' : status ?? 'done'}`) };
    }
    case 'DynamicToolCall': {
      const error = it.success === false || status === 'failed';
      const tool: NonNullable<Attrs['tool']> = { name: String(it.tool ?? 'dynamic_tool'), kind: 'other', status, input: compact(it.arguments, { maxString: INDEX_INPUT_MAX_STRING }) };
      if (error) tool.is_error = true;
      return { name: tool.name!, tool, error, summary: infoLine(tool.name, `→ ${error ? 'error' : status ?? 'done'}`) };
    }
    case 'ImageView': {
      const path = fromFileUri(it.path);
      return { name: 'view_image', tool: { name: 'view_image', kind: 'file', path }, error: false, summary: `view_image  ${basename(path ?? '')}` };
    }
    default: {
      // WebSearch, and Extension items: web.search, clock.sleep, image_gen.generation, ...
      const kind = it.type === 'WebSearch' ? 'web.search' : String(it.kind ?? 'extension');
      if (kind === 'web.search') {
        const q = str(it.query) ?? str(it.action?.query) ?? str(it.action?.url) ?? '';
        const results = Array.isArray(it.results) ? it.results.length : undefined;
        return {
          name: 'web_search', tool: { name: 'web_search', kind: 'web', query: q, results }, error: false,
          summary: infoLine('web_search', q, results !== undefined && `→ ${results} results`),
        };
      }
      if (kind === 'clock.sleep') {
        return { name: 'sleep', tool: { name: 'sleep', kind: 'other', requested_ms: num(it.durationMs) }, error: false, summary: `sleep  ${fmtDur((num(it.durationMs) ?? 0) * 1000)} requested` };
      }
      const error = !!it.failure || status === 'failed';
      const name = kind.replace(/\.generation$/, '');
      return {
        name, tool: { name, kind: 'other', status, path: str(it.savedPath), ...(error ? { is_error: true } : {}) }, error,
        summary: infoLine(name, it.revisedPrompt, error && '→ failed'),
      };
    }
  }
}

/** DESIGN.md §9 Event Summary: "exit 1 · 11 B · 160ms · Exit code 1": the status, the size, the time, then the error text. */
function resultSummary(st: ToolState, status: SpanStatus, dur: number | undefined): string {
  const t = st.tool;
  const d = dur !== undefined && fmtDur(dur);
  const out = String(t.output ?? '');
  const who = st.agent?.nickname ?? st.agent?.path;
  const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' · ');
  if (st.linkSession) return join(`spawned ${who ? who + ' ' : ''}${st.linkSession.slice(0, 16)}`, d);
  const size = typeof t.output_len === 'number' && fmtBytes(t.output_len);
  if (t.exit_code !== undefined) return join(`exit ${t.exit_code}`, t.status?.startsWith('running') && t.status, size, d);
  const inner = t.inner_errors ? `${t.inner_errors} inner failed` : undefined;
  if (t.status) return join(t.status, d, inner, status === 'error' && flat(out.replace(/^Script \w+\s*/, ''), 80));
  if (status === 'error') return join('error', d, flat(out, 100));
  return join('ok', fmtBytes(t.output_len ?? out.length), d);
}
