// Codex apply_patch for replay (docs/REPLAY.md §4.4): parse the `*** Begin Patch` format and apply update chunks
// to file text the way Codex locates them. Chunks converted from unified diffs (§3.6) also carry their line. Pure
// functions; tools.ts does the file I/O in the container.

export class PatchError extends Error {}

export interface PatchChunk {
  /** Text after `@@ `: a line to seek to before matching the chunk. */
  context: string | null;
  /** A unified-diff hunk header (`@@ -12,3 +12,4 @@`): the 0-based line where its old lines start. */
  line?: number;
  oldLines: string[];
  newLines: string[];
  /** `*** End of File`: the chunk must match at the end of the file. */
  eof: boolean;
}

export type PatchOp =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo: string | null; chunks: PatchChunk[] };

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

/** The operations of a patch. `text` may carry anything before `*** Begin Patch` (a heredoc command line). */
export function parsePatch(text: string): PatchOp[] {
  const start = text.indexOf(BEGIN);
  if (start < 0) throw new PatchError('The patch has no "*** Begin Patch" line');
  const lines = text.slice(start).split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const ops: PatchOp[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === END) return ops;
    const m = FILE.exec(line.trim());
    if (!m) {
      if (line.trim() === '') continue;
      throw new PatchError(`Unexpected line in patch: ${line}`);
    }
    const path = m[2].trim();
    if (m[1] === 'Delete') {
      ops.push({ type: 'delete', path });
      continue;
    }
    if (m[1] === 'Add') {
      const body: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith('+')) body.push(lines[++i].slice(1));
      ops.push({ type: 'add', path, content: body.length ? body.join('\n') + '\n' : '' });
      continue;
    }
    let moveTo: string | null = null;
    if (lines[i + 1]?.startsWith('*** Move to: ')) moveTo = lines[++i].slice('*** Move to: '.length).trim();
    const chunks: PatchChunk[] = [];
    let chunk: PatchChunk | null = null;
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.startsWith('*** ') && next !== '*** End of File') break;
      i++;
      if (next.startsWith('@@')) {
        const unified = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(next);
        chunk = unified
          ? { context: null, line: Math.max(0, Number(unified[1]) - 1), oldLines: [], newLines: [], eof: false }
          : { context: next.length > 2 ? next.slice(2).trim() || null : null, oldLines: [], newLines: [], eof: false };
        chunks.push(chunk);
        continue;
      }
      if (next === '*** End of File') {
        if (chunk) chunk.eof = true;
        continue;
      }
      if (!chunk) {
        chunk = { context: null, oldLines: [], newLines: [], eof: false };
        chunks.push(chunk);
      }
      const op = next[0];
      const body = next.slice(1);
      if (op === '+') chunk.newLines.push(body);
      else if (op === '-') chunk.oldLines.push(body);
      else if (op === ' ' || next === '') {
        chunk.oldLines.push(next === '' ? '' : body);
        chunk.newLines.push(next === '' ? '' : body);
      } else throw new PatchError(`Unexpected line in update of ${path}: ${next}`);
    }
    if (!chunks.length) throw new PatchError(`Update of ${path} has no hunks`);
    ops.push({ type: 'update', path, moveTo, chunks });
  }
  throw new PatchError('The patch has no "*** End Patch" line');
}

/** Apply update chunks to a file's text. Throws PatchError when a chunk cannot be located. */
export function applyChunks(original: string, chunks: PatchChunk[], path: string): string {
  const lines = original.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const replacements: [start: number, removed: number, added: string[]][] = [];
  let at = 0;
  for (const c of chunks) {
    if (c.context !== null) {
      const ctx = seek(lines, [c.context], at, false);
      if (ctx < 0) throw new PatchError(`Failed to find context "${c.context}" in ${path}`);
      at = ctx + 1;
    }
    if (!c.oldLines.length) {
      replacements.push([lines.length, 0, c.newLines]);
      continue;
    }
    let oldLines = c.oldLines;
    let newLines = c.newLines;
    // A unified hunk names its line; the search from there on is the fallback when the file has moved.
    const exact = c.line !== undefined && c.line >= at && oldLines.every((l, j) => lines[c.line! + j] === l);
    let found = exact ? c.line! : seek(lines, oldLines, at, c.eof);
    if (found < 0 && oldLines.at(-1) === '') {
      // A trailing blank line in the chunk often stands for the end of the file.
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === '') newLines = newLines.slice(0, -1);
      found = seek(lines, oldLines, at, c.eof);
    }
    if (found < 0) throw new PatchError(`Failed to find expected lines in ${path}:\n${c.oldLines.join('\n')}`);
    replacements.push([found, oldLines.length, newLines]);
    at = found + oldLines.length;
  }
  for (const [start, removed, added] of replacements.sort((a, b) => b[0] - a[0])) lines.splice(start, removed, ...added);
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Index of `pattern` in `lines` at or after `from`: exact, then ignoring trailing, then surrounding whitespace. */
function seek(lines: string[], pattern: string[], from: number, eof: boolean): number {
  const tests: ((a: string, b: string) => boolean)[] = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ];
  const last = lines.length - pattern.length;
  for (const eq of tests) {
    const begin = eof ? last : from;
    for (let i = Math.max(begin, 0); i <= last; i++) {
      if (pattern.every((p, j) => eq(lines[i + j], p))) return i;
    }
  }
  return -1;
}
