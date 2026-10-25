// File diffs of one change event, read from its raw record (GET /api/changes/:eventId/diff, docs/MODULES.md C
// "Diffs"). The index caps tool inputs, so the hunks come from the raw JSON line: Claude Edit, MultiEdit, Write and
// NotebookEdit inputs, apply_patch text (custom tool string, function arguments, or a shell heredoc), and Codex
// FileChange `changes` maps. Pure functions over parsed JSON; derived-queries.ts reads the bytes.

import type { DiffHunk } from './api.ts';
import type { DiffOp } from '../model/types.ts';

/** One file's hunks as the raw record states them. `path` is the path the record names. */
export interface RawFileDiff {
  path: string;
  hunks: DiffHunk[] | null;
  /** The old content is not in the record (Write, NotebookEdit, an added file): the hunks show the new content only. */
  newOnly: boolean;
  reason: string | null;
  src: string;
}

const PATCH_BEGIN = '*** Begin Patch';
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MAX_DEPTH = 8;

/** The files a raw record changes, with hunks. `block` is the content block of a Claude tool_use (events.src_block). */
export function rawFileDiffs(record: unknown, block: number | null): RawFileDiff[] {
  if (block != null) {
    const node = (record as any)?.message?.content?.[block];
    if (node?.type === 'tool_use' && node.input && typeof node.input === 'object') {
      const own = editInputDiffs(node.input);
      if (own.length) return own;
    }
  }
  return findIn(record, 0) ?? [];
}

/** The first patch text or FileChange map anywhere in the record, depth first. */
function findIn(v: unknown, depth: number): RawFileDiff[] | null {
  if (depth > MAX_DEPTH || v == null) return null;
  if (typeof v === 'string') {
    if (v.includes(PATCH_BEGIN)) return patchDiffs(v.slice(v.indexOf(PATCH_BEGIN)));
    const t = v.trimStart();
    if (t.startsWith('{') && t.length < 50_000_000) {
      try {
        return findIn(JSON.parse(t), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findIn(x, depth + 1);
      if (r?.length) return r;
    }
    return null;
  }
  if (typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.changes && typeof o.changes === 'object' && !Array.isArray(o.changes)) {
    const r = fileChangeDiffs(o.changes as Record<string, unknown>);
    if (r.length) return r;
  }
  if (typeof o.file_path === 'string' || typeof o.notebook_path === 'string') {
    const r = editInputDiffs(o);
    if (r.length) return r;
  }
  for (const x of Object.values(o)) {
    const r = findIn(x, depth + 1);
    if (r?.length) return r;
  }
  return null;
}

/** Claude Edit, MultiEdit, Write and NotebookEdit inputs (one file). */
function editInputDiffs(i: Record<string, any>): RawFileDiff[] {
  const path = i.file_path ?? i.notebook_path;
  if (typeof path !== 'string' || !path) return [];
  const src = 'logged:tool.input';
  if (Array.isArray(i.edits)) {
    const hunks = i.edits
      .filter((e: any) => typeof e?.old_string === 'string' && typeof e?.new_string === 'string')
      .map((e: any) => replacementHunk(e.old_string, e.new_string));
    return [{ path, hunks, newOnly: false, reason: null, src }];
  }
  if (typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return [{ path, hunks: [replacementHunk(i.old_string, i.new_string)], newOnly: false, reason: null, src }];
  }
  if (typeof i.content === 'string') return [{ path, hunks: [addedHunk(i.content)], newOnly: true, reason: null, src }];
  if (typeof i.new_source === 'string') {
    if (i.edit_mode === 'delete') return [{ path, hunks: null, newOnly: false, reason: 'A cell delete logs no cell source', src }];
    return [{ path, hunks: [addedHunk(i.new_source)], newOnly: true, reason: null, src }];
  }
  return [];
}

/** An Edit's old_string against its new_string: common first and last lines as context, without line numbers. */
function replacementHunk(before: string, after: string): DiffHunk {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const lines: DiffOp[] = [
    ...a.slice(0, head).map((text) => ({ op: 'eq' as const, text })),
    ...a.slice(head, a.length - tail).map((text) => ({ op: 'del' as const, text })),
    ...b.slice(head, b.length - tail).map((text) => ({ op: 'add' as const, text })),
    ...a.slice(a.length - tail).map((text) => ({ op: 'eq' as const, text })),
  ];
  return { oldStart: null, newStart: null, lines };
}

function addedHunk(text: string): DiffHunk {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return { oldStart: null, newStart: 1, lines: lines.map((t) => ({ op: 'add', text: t })) };
}

/** apply_patch text: one entry per `*** Add/Update/Delete File`, a hunk per `@@` section. */
export function patchDiffs(patch: string): RawFileDiff[] {
  const out: RawFileDiff[] = [];
  let cur: RawFileDiff | undefined;
  let hunk: DiffHunk | undefined;
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = PATCH_FILE.exec(line);
    if (m) {
      const op = m[1];
      cur = op === 'Delete'
        ? { path: m[2].trim(), hunks: [], newOnly: false, reason: 'The patch does not contain the deleted text', src: 'parsed:apply_patch' }
        : { path: m[2].trim(), hunks: [], newOnly: op === 'Add', reason: null, src: 'parsed:apply_patch' };
      hunk = undefined;
      out.push(cur);
      continue;
    }
    if (!cur || line.startsWith('*** Move to: ')) continue;
    if (line.startsWith('*** End')) {
      cur = undefined;
      continue;
    }
    if (line.startsWith('@@')) {
      hunk = { oldStart: null, newStart: null, lines: [] };
      cur.hunks!.push(hunk);
      continue;
    }
    const op = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line[0] === ' ' || line === '' ? 'eq' : null;
    if (!op) continue;
    if (!hunk) {
      hunk = { oldStart: null, newStart: cur.newOnly ? 1 : null, lines: [] };
      cur.hunks!.push(hunk);
    }
    hunk.lines.push({ op, text: line.slice(1) });
  }
  for (const f of out) if (f.hunks?.length === 0 && f.reason) f.hunks = null;
  return out;
}

/** Codex FileChange `changes`: {path: {type add|delete, content} | {type update, unified_diff, move_path}} or {path: {add: {...}}}. */
function fileChangeDiffs(changes: Record<string, unknown>): RawFileDiff[] {
  const out: RawFileDiff[] = [];
  for (const [key, c] of Object.entries(changes)) {
    if (!c || typeof c !== 'object') continue;
    const type = (c as any).type ?? Object.keys(c)[0];
    const body = ((c as any).type ? c : (c as any)[type]) ?? {};
    const path = key.startsWith('file://') ? decodeURIComponent(key.slice(7)) : key;
    const src = 'logged:FileChange';
    if (type === 'add' && typeof body.content === 'string') out.push({ path, hunks: [addedHunk(body.content)], newOnly: true, reason: null, src });
    else if (type === 'delete') {
      const lines = typeof body.content === 'string' ? body.content.replace(/\n$/, '').split('\n') : null;
      out.push({ path, hunks: lines ? [{ oldStart: 1, newStart: null, lines: lines.map((text: string) => ({ op: 'del', text })) }] : null, newOnly: false, reason: lines ? null : 'The deleted text is not logged', src });
    } else if (typeof body.unified_diff === 'string') out.push({ path, hunks: unifiedHunks(body.unified_diff), newOnly: false, reason: null, src });
    else out.push({ path, hunks: null, newOnly: false, reason: 'The change logs no diff', src });
  }
  return out;
}

/** Hunks of a unified diff (`@@ -a,b +c,d @@`), file headers skipped. */
export function unifiedHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  for (const line of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      hunk = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith('\\')) continue;
    const op = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line[0] === ' ' ? 'eq' : null;
    if (op) hunk.lines.push({ op, text: line.slice(1) });
  }
  return hunks;
}

/** Cut hunks to `max` lines in total. */
export function capHunks(hunks: DiffHunk[], max: number): { hunks: DiffHunk[]; truncated: boolean } {
  let left = max;
  const out: DiffHunk[] = [];
  for (const h of hunks) {
    if (left <= 0) return { hunks: out, truncated: true };
    if (h.lines.length > left) {
      out.push({ ...h, lines: h.lines.slice(0, left) });
      return { hunks: out, truncated: true };
    }
    out.push(h);
    left -= h.lines.length;
  }
  return { hunks: out, truncated: false };
}

/** Whether a record path names the indexed path: equal, or one ends with the other at a `/` (relative patch paths). */
export function samePath(indexed: string, named: string): boolean {
  if (indexed === named) return true;
  const [long, short] = indexed.length > named.length ? [indexed, named] : [named, indexed];
  return long.endsWith('/' + short.replace(/^\.\//, ''));
}
