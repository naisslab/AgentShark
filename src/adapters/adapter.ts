// Adapter contract and helpers shared by every source adapter (SPEC §2, §4).

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';
import { platformAppSupport, readSourceConfig } from '../source-config.ts';
import { TOOL_OUTPUT_TAIL } from '../model/types.ts';
import type { AgentKind, ChangeFile, IndexRecord, SourceKind, SourceRec, ToolKindTag } from '../model/types.ts';

export interface DiscoverEnv {
  home: string;
  /** ~/Library/Application Support on macOS; adapters must tolerate it being absent. */
  appSupport: string;
  /** Additional agent data directories; defaults stay enabled unless autoDiscover is false. */
  claudeRoots?: string[];
  codexRoots?: string[];
  autoDiscover?: boolean;
  /** Restrict discovery to these agents (undefined = all). */
  agents?: AgentKind[];
  /** Start of the index run (ms); adapters may cache directory listings for the length of one run. */
  runAt?: number;
}

export function defaultEnv(): DiscoverEnv {
  const home = homedir();
  const config = readSourceConfig();
  return { home, appSupport: platformAppSupport(home), ...config };
}

export function agentRoots(env: DiscoverEnv, agent: 'claude' | 'codex'): string[] {
  return [...new Set([...(env.autoDiscover === false ? [] : [join(env.home, `.${agent}`)]),
    ...(agent === 'claude' ? env.claudeRoots ?? [] : env.codexRoots ?? [])])];
}

export interface SourceFile {
  path: string;
  agent: AgentKind;
  kind: SourceKind;
  /** Adapter name that parses this file (see registry.ts). */
  adapter: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

export interface RecordSink {
  emit(rec: IndexRecord): void;
}

export interface ParseContext {
  sourceId: string;
  file: SourceFile;
  /** The discovery environment of the index run (absent when a file is parsed on its own, e.g. in tests). */
  env?: DiscoverEnv;
}

/** Per-file statistics returned by parse(); merged into the `sources` table. */
export interface ParseStats {
  parsedBytes: number;
  /** SHA-256 of exactly the original bytes in [0, parsedBytes), when supplied by this adapter. */
  sha256?: string;
  lines: number;
  malformed: number;
  unknown: number;
  skipped: number;
  inherited: number;
  dialect?: string;
}

export interface Adapter {
  /** Unique adapter name, e.g. 'claude', 'codex'. */
  name: string;
  discover(env: DiscoverEnv): Promise<SourceFile[]>;
  parse(ctx: ParseContext, sink: RecordSink): Promise<ParseStats>;
  /**
   * Files whose records depend on each other return the same key (Codex continuation pages of one thread);
   * when one of them changes or disappears, the indexer re-parses the whole group.
   */
  groupKey?(path: string): string | undefined;
}

export function emptyStats(): ParseStats {
  return { parsedBytes: 0, lines: 0, malformed: 0, unknown: 0, skipped: 0, inherited: 0 };
}

// ---------------------------------------------------------------------------
// Identifiers (SPEC §3.1)

export function sourceId(path: string): string {
  return 's_' + createHash('sha1').update(path).digest('hex').slice(0, 12);
}

/** Pass `block` only when the line yields more than one event. */
export function eventId(sourceId: string, line: number, block?: number): string {
  return block === undefined ? `${sourceId}:${line}` : `${sourceId}:${line}.${block}`;
}

export function spanId(session: string, kind: string, key: string | number): string {
  return `${session}#${kind}:${key}`;
}

export async function fileInfo(path: string, agent: AgentKind, kind: SourceKind, adapter: string): Promise<SourceFile | null> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    return { path, agent, kind, adapter, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return null;
  }
}

/** Paths an adapter must never open (SPEC §4.4). */
export function isCredentialPath(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  return (
    base === 'auth.json' ||
    base.endsWith('.key') ||
    base === '.audit-key' ||
    base === 'Cookies' ||
    base === 'buddy-tokens.json' ||
    /\/(Local Storage|IndexedDB|Session Storage|mcp-oauth[^/]*|oauth[^/]*)\//i.test(path)
  );
}

// ---------------------------------------------------------------------------
// Source bytes

/** A zstd-compressed source (a finished Codex rollout, `.jsonl.zst`). Its offsets, lengths and hashes refer to the decompressed bytes. */
export function isZstd(path: string): boolean {
  return path.endsWith('.zst');
}

/** Positional reads of a source file: a FileHandle, or the decompressed bytes of a zstd file. */
export interface SourceHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  stat(): Promise<Stats>;
  close(): Promise<void>;
}

/** Open a source file for reading; `zstd` (by default from the name) reads it as its decompressed bytes. */
export async function openSource(path: string, zstd = isZstd(path)): Promise<SourceHandle> {
  const fh = await open(path, 'r');
  return zstd ? new ZstdSource(fh, path) : fh;
}

/**
 * The decompressed bytes of a single-frame zstd file. A read at or after the previous read's position continues the
 * current decompression pass, so reading front to back costs one pass; a read before it starts a new pass.
 */
class ZstdSource implements SourceHandle {
  private fh: FileHandle;
  private path: string;
  private pass?: AsyncGenerator<Buffer>;
  /** Decompressed bytes [at, end) of the current pass, from the chunk that holds the previous read's position. */
  private chunks: Buffer[] = [];
  private at = 0;
  private end = 0;

  constructor(fh: FileHandle, path: string) {
    this.fh = fh;
    this.path = path;
  }

  stat(): Promise<Stats> {
    return this.fh.stat();
  }

  async read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> {
    if (!this.pass || position < this.at) {
      await this.pass?.return(undefined);
      this.pass = zstdChunks(this.fh, this.path);
      this.chunks = [];
      this.at = this.end = 0;
    }
    for (;;) {
      while (this.chunks.length && this.at + this.chunks[0].length <= position) this.at += this.chunks.shift()!.length;
      if (this.end >= position + length) break;
      const next = await this.pass.next();
      if (next.done) break;
      this.chunks.push(next.value);
      this.end += next.value.length;
    }
    let n = 0;
    let p = this.at;
    for (const c of this.chunks) {
      if (n === length) break;
      const from = position + n - p;
      if (from < c.length) n += c.copy(buffer, offset + n, from, Math.min(c.length, from + length - n));
      p += c.length;
    }
    return { bytesRead: n };
  }

  async close(): Promise<void> {
    await this.pass?.return(undefined);
    await this.fh.close();
  }
}

async function* zstdChunks(fh: FileHandle, path: string): AsyncGenerator<Buffer> {
  const { size } = await fh.stat();
  const z = createZstdDecompress();
  // Decoding errors end the iteration; the pipeline's own callback has nothing to add.
  yield* pipeline(fh.createReadStream({ start: 0, autoClose: false, highWaterMark: 1 << 20 }), z, () => {});
  // Node's decoder ends after the first frame and leaves any later frames unread.
  if (z.bytesWritten < size) throw new Error(`${path}: only single-frame zstd files can be read`);
}

// ---------------------------------------------------------------------------
// Streaming line reader

export interface LineInfo {
  /** 1-based line number. */
  line: number;
  /** Byte offset of the first byte of the line. */
  offset: number;
  /** Byte length excluding the newline. */
  length: number;
  /** True for a final line with no trailing newline (possibly still being written). */
  tail: boolean;
}

/**
 * Read a file line by line with exact byte offsets (of the decompressed bytes for a zstd file). Lines may be tens of MB.
 * `start`/`end` restrict the byte range; `line` numbering starts at `firstLine`.
 */
export async function readLines(
  path: string,
  onLine: (text: string, info: LineInfo, bytes: Buffer) => void,
  opts: { start?: number; end?: number; firstLine?: number } = {},
): Promise<{ bytesRead: number; lines: number }> {
  const fh = await openSource(path);
  const CHUNK = 4 << 20;
  const buf = Buffer.allocUnsafe(CHUNK);
  const end = opts.end ?? Infinity;
  let pos = opts.start ?? 0;
  let lineStart = pos;
  let lineNo = (opts.firstLine ?? 1) - 1;
  let carry: Buffer[] = [];
  let carryLen = 0;
  try {
    while (pos < end) {
      const want = Math.min(CHUNK, end - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      let i = 0;
      while (i < bytesRead) {
        let nl = buf.indexOf(10, i);
        if (nl === -1 || nl >= bytesRead) {
          carry.push(Buffer.from(buf.subarray(i, bytesRead)));
          carryLen += bytesRead - i;
          break;
        }
        let lineBuf: Buffer;
        if (carryLen) {
          carry.push(buf.subarray(i, nl));
          lineBuf = Buffer.concat(carry, carryLen + (nl - i));
          carry = [];
          carryLen = 0;
        } else {
          lineBuf = buf.subarray(i, nl);
        }
        lineNo++;
        const length = lineBuf.length;
        onLine(lineBuf.toString('utf8'), { line: lineNo, offset: lineStart, length, tail: false }, lineBuf);
        lineStart += length + 1;
        i = nl + 1;
      }
      pos += bytesRead;
    }
    if (carryLen) {
      lineNo++;
      const lineBuf = Buffer.concat(carry, carryLen);
      onLine(lineBuf.toString('utf8'), { line: lineNo, offset: lineStart, length: lineBuf.length, tail: true }, lineBuf);
    }
  } finally {
    await fh.close();
  }
  return { bytesRead: pos - (opts.start ?? 0), lines: lineNo - ((opts.firstLine ?? 1) - 1) };
}

/**
 * Read a JSONL file. Each complete line is parsed; malformed complete lines go to onBad.
 * A tail line without newline that fails to parse is treated as still being written:
 * it is neither delivered nor counted, and parsedBytes stops before it.
 */
export async function readJsonl(
  path: string,
  onRecord: (obj: any, info: LineInfo) => void,
  onBad: (info: LineInfo, err: Error) => void,
  opts: { start?: number; end?: number; firstLine?: number } = {},
): Promise<{ parsedBytes: number; lines: number; sha256?: string }> {
  let parsedBytes = opts.start ?? 0;
  let lines = 0;
  const hash = (opts.start ?? 0) === 0 ? createHash('sha256') : undefined;
  const recordBytes = (bytes: Buffer, tail: boolean) => { hash?.update(bytes); if (!tail) hash?.update('\n'); };
  await readLines(
    path,
    (text, info, bytes) => {
      if (text.length === 0 || (text.length === 1 && text === '\r')) {
        recordBytes(bytes, info.tail);
        parsedBytes = info.offset + info.length + (info.tail ? 0 : 1);
        return;
      }
      let obj: any;
      try {
        obj = JSON.parse(text);
      } catch (err) {
        if (info.tail) return;
        recordBytes(bytes, false);
        lines++;
        parsedBytes = info.offset + info.length + 1;
        onBad(info, err as Error);
        return;
      }
      lines++;
      recordBytes(bytes, info.tail);
      parsedBytes = info.offset + info.length + (info.tail ? 0 : 1);
      onRecord(obj, info);
    },
    opts,
  );
  return { parsedBytes, lines, ...(hash ? { sha256: hash.digest('hex') } : {}) };
}

/** Read exactly `length` bytes at `offset` (raw pane). */
export async function readRange(path: string, offset: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Time

/** ISO-8601 string → epoch µs. Returns undefined for invalid input. */
export function isoToUs(iso: unknown): number | undefined {
  if (typeof iso !== 'string' || !iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  // Keep sub-millisecond digits when present (e.g. 2026-10-11T09:37:04.777123Z).
  const m = /\.(\d{4,9})/.exec(iso);
  if (m) {
    const frac = m[1].padEnd(6, '0').slice(0, 6);
    return Math.floor(ms / 1000) * 1_000_000 + Number(frac);
  }
  return ms * 1000;
}

export function msToUs(ms: unknown): number | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms * 1000) : undefined;
}

export function secToUs(s: unknown): number | undefined {
  return typeof s === 'number' && Number.isFinite(s) ? Math.round(s * 1_000_000) : undefined;
}

// ---------------------------------------------------------------------------
// Compacting native records for the index (SPEC §3.4)

const REDACT_KEYS = new Set([
  'creator_user_id', 'creator_account_id', 'emailAddress', 'accountName', 'oauthAccount', 'auth',
  'organizationUuid', 'accountUuid', 'ownerAccountUuid', 'ownerOrganizationUuid', 'userEmail', 'account_uuid',
  'organization_uuid', 'device_id',
]);
const OPAQUE_KEYS = new Set(['encrypted_content', 'signature', '_audit_hmac']);
const BASE64_RE = /^[A-Za-z0-9+/=\r\n_-]+$/;

export interface CompactOptions {
  maxString?: number;
  maxArray?: number;
  maxDepth?: number;
}

export function looksBase64(s: string): boolean {
  if (s.length < 1024) return false;
  return BASE64_RE.test(s.slice(0, 512)) && BASE64_RE.test(s.slice(-256));
}

/** Copy `value` with long strings truncated, binary payloads replaced by placeholders, and identity fields redacted. */
export function compact(value: unknown, opts: CompactOptions = {}, depth = 0, key = ''): unknown {
  const maxString = opts.maxString ?? 512;
  const maxArray = opts.maxArray ?? 50;
  const maxDepth = opts.maxDepth ?? 14;
  if (value === null || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    if (REDACT_KEYS.has(key)) return '<redacted>';
    if (OPAQUE_KEYS.has(key)) return { $omitted: 'opaque', bytes: value.length };
    if (value.startsWith('data:') && value.length > 256) {
      const mediaType = value.slice(5, value.indexOf(';') > 0 ? value.indexOf(';') : 40);
      return { $omitted: 'data-url', bytes: value.length, mediaType };
    }
    if (looksBase64(value)) return { $omitted: 'base64', bytes: value.length };
    if (value.length > maxString) return value.slice(0, maxString) + `…[+${value.length - maxString}]`;
    return value;
  }
  if (REDACT_KEYS.has(key)) return '<redacted>';
  if (depth >= maxDepth) return { $omitted: 'depth' };
  if (Array.isArray(value)) {
    const out = value.slice(0, maxArray).map((v) => compact(v, opts, depth + 1, ''));
    if (value.length > maxArray) out.push({ $omitted: 'items', count: value.length - maxArray });
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = compact(v, opts, depth + 1, k);
  }
  return out;
}

export function truncate(s: string | undefined | null, n: number): string | undefined {
  if (s == null) return undefined;
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n}]` : s;
}

export function oneLine(s: string | undefined | null, n = 160): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

/**
 * The Diagnostics note of a turn abort. In a child session a human interrupt and a parent stopping the child look
 * the same (SPEC §12.9 limit 3), so only a main session's abort names the user.
 */
export const INTERRUPT_NOTE = { main: 'turn interrupted by the user', child: 'turn interrupted (user or parent stop)' } as const;

/** Index copy limits (SPEC §3.4, §3.7). */
export const INDEX_TEXT_MAX = 4096;
export const INDEX_INPUT_MAX_STRING = 1024;

// ---------------------------------------------------------------------------
// Tools

const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'exec_command', 'write_stdin', 'shell_command', 'shell', 'local_shell', 'mcp__workspace__bash']);
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS', 'apply_patch', 'view_image']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch', 'web_search', 'web_search_call', 'mcp__workspace__web_fetch']);
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'SendMessage', 'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'interrupt_agent', 'close_agent', 'send_input', 'wait']);
const PLAN_TOOLS = new Set(['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput', 'update_plan', 'ExitPlanMode', 'EnterPlanMode']);

export function toolKind(name: string | undefined, namespace?: string): ToolKindTag {
  if (!name) return 'other';
  if (name.startsWith('mcp__') && !SHELL_TOOLS.has(name) && !WEB_TOOLS.has(name)) return 'mcp';
  if (namespace && namespace.startsWith('mcp__')) return 'mcp';
  if (namespace === 'collaboration') return 'agent';
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (FILE_TOOLS.has(name)) return 'file';
  if (WEB_TOOLS.has(name)) return 'web';
  if (AGENT_TOOLS.has(name)) return 'agent';
  if (PLAN_TOOLS.has(name)) return 'plan';
  if (name === 'exec') return 'custom';
  return 'other';
}

/** The script of a shell argv such as [/bin/zsh, -lc, <cmd>], or null for an argv that does not run a shell script. */
export function shellArgvScript(argv: string[]): string | null {
  return argv.length >= 3 && /(^|\/)[a-z]*sh$/.test(argv[0]) && /^-\w*c$/.test(argv[1]) ? argv.slice(2).join(' ') : null;
}

/** A path from a `file://` URI (Codex item paths and cwds); other strings unchanged. */
export function fromFileUri(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p) return undefined;
  if (!p.startsWith('file://')) return p;
  try {
    return decodeURIComponent(p.slice(7));
  } catch {
    return p.slice(7);
  }
}

/** `mcp__server__tool` → { server, tool } */
export function splitMcp(name: string): { server?: string; tool: string } {
  if (!name.startsWith('mcp__')) return { tool: name };
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  return i < 0 ? { server: rest, tool: rest } : { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/** Short human description of a tool input for the Info column. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') {
    if (name === 'apply_patch' || input.startsWith('*** Begin Patch')) {
      const files = [...input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]);
      return files.length ? files.join(', ') : oneLine(input, 120);
    }
    return oneLine(input, 160);
  }
  if (typeof input !== 'object') return String(input);
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v) return v;
      if (Array.isArray(v) && v.length && typeof v[0] === 'string') return v.join(' ');
    }
    return undefined;
  };
  const s =
    pick('command', 'cmd', 'commandLine') ??
    pick('file_path', 'notebook_path', 'path', 'filePath', 'notebookPath', 'uri', 'dirPath') ??
    (o.pattern ? `${o.pattern}${o.path ? '  in ' + o.path : ''}` : undefined) ??
    pick('url', 'query', 'description', 'subject', 'task_name', 'prompt', 'message', 'skill', 'title', 'code', 'chars', 'target', 'explanation', 'filePaths');
  if (s) return oneLine(String(s), 160);
  try {
    return oneLine(JSON.stringify(o), 160);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Schema-4 tool fields (SPEC §12.3.1), computed from the full strings before the index caps them.

/** attrs.tool.output_tail: the last TOOL_OUTPUT_TAIL.chars characters of an output longer than TOOL_OUTPUT_TAIL.minLen. */
export function outputTail(output: string): string | undefined {
  return output.length > TOOL_OUTPUT_TAIL.minLen ? output.slice(-TOOL_OUTPUT_TAIL.chars) : undefined;
}

/** Number of lines in a text; a final newline does not start another line. */
export function lineCount(text: string): number {
  return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
}

/** Lines a diff adds and removes. With `headers`, `---`/`+++` file headers before the first `@@` are skipped. */
export function diffCounts(lines: readonly unknown[], headers = false): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let hunk = !headers;
  for (const l of lines) {
    if (typeof l !== 'string') continue;
    if (l.startsWith('@@')) hunk = true;
    else if (!hunk && (l.startsWith('---') || l.startsWith('+++'))) continue;
    else if (l[0] === '+') added++;
    else if (l[0] === '-') removed++;
  }
  return { added, removed };
}

const PATCH_FILE_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

/**
 * One entry per file of an apply_patch text: `*** Add File` → add, `Update` → update, `Delete` → delete (its removed
 * lines are not in the patch, so null), `*** Move to` → move with `to`. Counts are the + and − lines of each file.
 */
export function patchChanges(patch: string): ChangeFile[] {
  const out: ChangeFile[] = [];
  let cur: ChangeFile | undefined;
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = PATCH_FILE_RE.exec(line);
    if (m) {
      const op = m[1] === 'Add' ? 'add' : m[1] === 'Delete' ? 'delete' : 'update';
      cur = { path: m[2].trim(), op, added: 0, removed: op === 'delete' ? null : 0 };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('*** Move to: ')) Object.assign(cur, { op: 'move', to: line.slice(13).trim() });
    else if (line.startsWith('*** End Patch')) cur = undefined;
    else if (line[0] === '+') cur.added = (cur.added ?? 0) + 1;
    else if (line[0] === '-' && cur.removed !== null) cur.removed++;
  }
  return out;
}

/** Lines a string replacement removes and adds: the old and new strings without their common first and last lines. */
function replacementCounts(before: string, after: string): { added: number; removed: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { removed: a.length - head - tail, added: b.length - head - tail };
}

/**
 * Claude Edit and MultiEdit (`update`), Write (`write`; `add` or `update` when toolUseResult.type says so) and
 * NotebookEdit (`update`), one file each. Counts come from toolUseResult.structuredPatch when the result has one,
 * else from the full input strings; null when neither determines them (replace_all, an overwritten file).
 */
export function editChanges(tool: string, input: unknown, result?: unknown): ChangeFile[] {
  if (!input || typeof input !== 'object') return [];
  const i = input as Record<string, any>;
  const path = i.file_path ?? i.notebook_path;
  if (typeof path !== 'string' || !path) return [];
  const r = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, any>) : undefined;
  const hunks: unknown[] = Array.isArray(r?.structuredPatch) ? r.structuredPatch : [];
  const logged = hunks.length ? diffCounts(hunks.flatMap((h: any) => (Array.isArray(h?.lines) ? h.lines : []))) : undefined;
  const unknown = { added: null, removed: null };
  switch (tool) {
    case 'Write': {
      const added = typeof i.content === 'string' ? lineCount(i.content) : null;
      if (r?.type === 'create') return [{ path, op: 'add', added, removed: 0 }];
      if (r?.type === 'update') return [{ path, op: 'update', ...(logged ?? unknown) }];
      return [{ path, op: 'write', added, removed: null }];
    }
    case 'Edit':
    case 'MultiEdit': {
      if (logged) return [{ path, op: 'update', ...logged }];
      const edits: any[] = tool === 'Edit' ? [i] : Array.isArray(i.edits) ? i.edits : [];
      const sum = { added: 0, removed: 0 };
      for (const e of edits) {
        if (typeof e?.old_string !== 'string' || typeof e.new_string !== 'string' || e.replace_all === true) return [{ path, op: 'update', ...unknown }];
        const c = replacementCounts(e.old_string, e.new_string);
        sum.added += c.added;
        sum.removed += c.removed;
      }
      return [{ path, op: 'update', ...sum }];
    }
    case 'NotebookEdit': {
      const mode = i.edit_mode ?? 'replace';
      const source = typeof i.new_source === 'string' ? lineCount(i.new_source) : null;
      return [{ path, op: 'update', added: mode === 'delete' ? 0 : source, removed: mode === 'insert' ? 0 : null }];
    }
    default:
      return [];
  }
}

/** Parse a JSON string, returning undefined on failure. */
export function tryJson(s: unknown): unknown {
  if (typeof s !== 'string') return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sourceRecFrom(file: SourceFile, stats: ParseStats): SourceRec {
  return {
    rec: 'source',
    id: sourceId(file.path),
    agent: file.agent,
    kind: file.kind,
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ino: file.ino,
    ...stats,
  };
}
