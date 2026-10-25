// File changes (SPEC §12.3.8): edits from attrs.change.files (Edit, MultiEdit, Write, NotebookEdit, apply_patch, Codex
// FileChange) of calls that did not fail, reads from Read and Codex parsed_cmd, external edits (edited_text_file),
// file-history backups, and grey `shell-mention` rows for shell commands that name a path next to `sed -i`, `>`, `tee`,
// `mv`, `cp`, `rm` or `git checkout|restore`. Shell mentions never claim a change and never carry a diff.

import { posix } from 'node:path';
import type { ChangeOp, ChangeRow, Prov } from '../../model/types.ts';
import { isFlagged, shellish } from './failures.ts';
import type { Action, Derived } from './model.ts';
import { absPath, dropPrefix, progName, splitSegments, stripRedirects } from './target.ts';
import type { Ev, Ses } from './tree.ts';

export const SHELL_MENTION_RULE = 'shell-mention@1';
/** Ops that change a file (ChangeOp minus read, backup and shell-mention). */
export const EDIT_OPS: readonly ChangeOp[] = ['add', 'update', 'delete', 'move', 'write'];
/** Redirections that write a file (`>`, `>>`, `2>`, `&>`, `>|`); a fd duplication (`2>&`) names no file. */
const WRITE_REDIRECT = /^(\d*|&)>>?\|?$/;

type Draft = Omit<ChangeRow, 'sessionId' | 'turnId' | 'stepId' | 'ts' | 'outsideCwd'>;

export function deriveChanges(d: Derived): void {
  for (const s of d.tree.sessions) {
    const rows = new Map<string, ChangeRow>();
    // The first row of an (event, path) wins: edits, then reads, then mentions.
    const add = (ev: Ev, r: Draft) => {
      const k = `${r.rid}\u0000${r.path}`;
      if (rows.has(k)) return;
      rows.set(k, {
        ...r, sessionId: s.id, turnId: ev.turn, stepId: d.stepOf.get(ev.rid)?.id ?? null, ts: ev.ts,
        outsideCwd: !!s.cwd && r.path.startsWith('/') && r.path !== s.cwd && !r.path.startsWith(s.cwd.endsWith('/') ? s.cwd : `${s.cwd}/`),
      });
    };
    for (const a of d.actions.get(s.id) ?? []) {
      const ev = a.call ?? a.result;
      if (!ev || (a.kind !== 'tool' && a.kind !== 'item')) continue;
      const cwd = cwdOf(ev, s);
      // A failed call changed or read nothing; a call without a result is not known to have.
      const done = !!a.result && !isFlagged(a.result);
      if (done) for (const r of [...edits(a, ev, cwd), ...reads(a, ev, cwd)]) add(ev, r);
      for (const r of mentions(a, ev, cwd)) add(ev, r);
    }
    const backups = new Set<string>();
    for (const e of s.events) {
      if (e.kind === 'context.attachment' && e.proto.endsWith('edited_text_file')) {
        const f = e.nat?.attachment?.filename;
        if (typeof f === 'string' && f) add(e, { rid: e.rid, path: absPath(f, s.cwd), op: 'external', src: 'logged:edited_text_file', added: null, removed: null });
      } else if (e.kind === 'harness.file' && e.nat) {
        // A snapshot lists every tracked file again: a backup is a (path, version) not seen before.
        for (const b of backupsOf(e, s)) {
          const k = `${b.path}\u0000${b.version}`;
          if (backups.has(k)) continue;
          backups.add(k);
          add(e, { rid: e.rid, path: b.path, op: 'backup', src: 'logged:file-history', added: null, removed: null });
        }
      }
    }
    for (const r of rows.values()) d.changes.push(r);
  }
}

function edits(a: Action, ev: Ev, cwd: string | null): Draft[] {
  const files = ev.a.change?.files;
  if (!Array.isArray(files)) return [];
  const src: Prov = ev.proto.endsWith('FileChange') ? 'logged:FileChange' : a.tool === 'apply_patch' ? 'parsed:apply_patch' : `logged:${a.tool ?? 'tool'}`;
  const out: Draft[] = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    out.push({ rid: ev.rid, path: absPath(f.path, cwd), op: f.op, src, added: num(f.added), removed: num(f.removed) });
    // A move also names its target, without counts (they are on the source row).
    if (f.op === 'move' && typeof f.to === 'string' && f.to) out.push({ rid: ev.rid, path: absPath(f.to, cwd), op: 'move', src, added: null, removed: null });
  }
  return out;
}

function reads(a: Action, ev: Ev, cwd: string | null): Draft[] {
  if (a.tool === 'Read') {
    const p = (ev.a.tool?.input as Record<string, unknown> | undefined)?.file_path;
    return typeof p === 'string' && p ? [{ rid: ev.rid, path: absPath(p, cwd), op: 'read', src: 'logged:Read', added: null, removed: null }] : [];
  }
  const parsed = ev.pcmd ?? ev.a.tool?.parsed_cmd;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((p) => p && p.type === 'read' && typeof p.path === 'string' && p.path
    ? [{ rid: ev.rid, path: absPath(p.path, cwd), op: 'read' as const, src: 'parsed:parsed_cmd' as const, added: null, removed: null }]
    : []);
}

/** Paths a shell command names next to a writing program or redirection (SPEC §12.3.8 shell-mention). */
function mentions(a: Action, ev: Ev, cwd: string | null): Draft[] {
  if (!shellish(a, ev)) return [];
  const t = ev.a.tool ?? {};
  const input = t.input as Record<string, unknown> | undefined;
  const cmd = str(t.command) ?? str(input?.command) ?? str(input?.cmd);
  if (!cmd) return [];
  const out: Draft[] = [];
  for (const path of mentionedPaths(cmd)) {
    out.push({ rid: ev.rid, path: absPath(path, cwd), op: 'shell-mention', src: `inferred:${SHELL_MENTION_RULE}`, added: null, removed: null });
  }
  return out;
}

/** A command that can mention a path at all (a cheap test before lexing it). */
const MAY_MENTION = />|\b(?:sed|tee|mv|cp|rm|git)\b/;

export function mentionedPaths(cmd: string): string[] {
  if (!MAY_MENTION.test(cmd)) return [];
  const out: string[] = [];
  for (const segment of splitSegments(cmd)) {
    // Redirection targets, in any segment.
    for (let i = 0; i < segment.length - 1; i++) if (WRITE_REDIRECT.test(segment[i])) out.push(segment[i + 1]);
    const words = dropPrefix(stripRedirects(segment));
    if (!words.length) continue;
    const prog = progName(words[0]);
    const args = words.slice(1);
    // Empty words too: macOS `sed -i ''` gives the backup suffix as one.
    const plain = args.filter((x) => x && !x.startsWith('-'));
    if (prog === 'sed' && args.some((x) => x.startsWith('-i') || x === '--in-place')) {
      // The first plain word is the script unless -e or -f gave it.
      out.push(...(args.some((x) => x === '-e' || x === '-f') ? plain : plain.slice(1)));
    } else if (prog === 'tee' || prog === 'mv' || prog === 'rm') out.push(...plain);
    else if (prog === 'cp' && plain.length >= 2) out.push(plain[plain.length - 1]);
    else if (prog === 'git') {
      const sub = plain[0];
      const dash = args.indexOf('--');
      if (sub === 'checkout' && dash >= 0) out.push(...args.slice(dash + 1));
      else if (sub === 'restore') out.push(...(dash >= 0 ? args.slice(dash + 1) : plain.slice(1)));
    }
  }
  return [...new Set(out.filter(isPathWord))];
}

/** A literal path: not a fd, a device, an option, a word with expansions or globs, or one the index cut (`…[+N]`). */
function isPathWord(w: string): boolean {
  return !!w && w !== '-' && !/^\d+$/.test(w) && !w.startsWith('&') && !w.startsWith('/dev/') && !/[$`*?{}]|…\[\+/.test(w);
}

/** file-history snapshot entries and deltas: the path (realParentDir is the file's own directory) and the version. */
function backupsOf(e: Ev, s: Ses): { path: string; version: unknown }[] {
  const n = e.nat!;
  const entries: [unknown, any][] = e.proto.endsWith('file-history-delta') ? [[n.trackingPath ?? e.a.file?.path, n.backup]] : Object.entries(n.snapshot?.trackedFileBackups ?? {});
  return entries.flatMap(([key, b]) => {
    if (typeof key !== 'string' || !key) return [];
    const dir = typeof b?.realParentDir === 'string' && b.realParentDir.startsWith('/') ? b.realParentDir : null;
    const path = key.startsWith('/') || !dir ? absPath(key, s.cwd) : posix.join(dir, posix.basename(key));
    return [{ path, version: b?.version ?? b?.backupFileName ?? null }];
  });
}

function cwdOf(ev: Ev, s: Ses): string | null {
  const t = ev.a.tool ?? {};
  return str((t.input as Record<string, unknown> | undefined)?.workdir) ?? str(t.cwd) ?? s.cwd;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
