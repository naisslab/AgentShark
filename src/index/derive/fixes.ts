// Observed fixes (SPEC §12.4): what happened between the last failure and the closing call of past recoveries of one
// signature. Computed on read (derived-queries.ts caches it per signature); labelled "observed in past recoveries,
// not verified".

import type { DatabaseSync } from 'node:sqlite';
import type { ObservedFix } from '../../model/types.ts';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);
const INSTALL = /\b(?:pip3?|uv pip|uv add|uv sync|npm (?:i|install|ci|add)|pnpm (?:add|install|i)|yarn(?: add| install)?|bun (?:add|install)|brew install|cargo (?:add|install|fetch)|apt(?:-get)? install|conda install|poetry (?:add|install)|gem install|go (?:get|mod download)|swift package resolve)\b/;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'view_image']);
const VIEWER = /^\s*(?:cat|head|tail|less|more|bat|nl|sed -n|rg|grep|ls|find)\b/;
const EPISODES_MAX = 200;
const PATTERN_MAX = 80;

type Kind = ObservedFix['kind'];
const PRIORITY: Kind[] = ['edit', 'install', 'read', 'other'];

/** Top `limit` (kind, pattern) pairs over the signature's recovered episodes, most frequent first. */
export function observedFixes(db: DatabaseSync, sigId: string, limit = 3): ObservedFix[] {
  const eps = db.prepare(`
    SELECT ep.id, ep.session_id, l.src_id, l.seq AS last_seq, c.seq AS close_seq, lc.rid AS last_call, ep.closer_rid
    FROM episodes ep
    JOIN events l ON l.rid = ep.last_rid
    JOIN events c ON c.rid = ep.closer_rid
    LEFT JOIN failures f ON f.rid = ep.last_rid
    LEFT JOIN events lc ON lc.rid = COALESCE(f.call_rid, ep.last_rid)
    WHERE ep.sig_id = ? AND ep.outcome = 'recovered' AND ep.closer_rid IS NOT NULL
    ORDER BY ep.end_ts DESC LIMIT ${EPISODES_MAX}`).all(sigId) as Record<string, any>[];
  if (!eps.length) return [];
  const between = db.prepare(`
    SELECT e.tool_name, COALESCE(json_extract(p.attrs, '$.tool.command'), CASE WHEN e.tool_name = 'exec' THEN json_extract(p.attrs, '$.tool.input') END) AS cmd
    FROM events e JOIN event_payload p ON p.rid = e.rid
    WHERE e.session_id = ? AND e.src_id = ? AND e.seq > ? AND e.seq < ? AND e.kind IN ('tool.call', 'tool.exec') AND (e.flag_bits & 6) = 0`);
  const inputOf = db.prepare(`SELECT json_extract(attrs, '$.tool.command') AS cmd, json_extract(attrs, '$.tool.input') AS input FROM event_payload WHERE rid = ?`);
  const groups = new Map<string, ObservedFix>();
  for (const ep of eps) {
    const kinds = new Set<Kind>();
    for (const c of between.all(ep.session_id, ep.src_id, ep.last_seq, ep.close_seq) as { tool_name: string | null; cmd: string | null }[]) kinds.add(kindOf(c.tool_name, c.cmd));
    const kind = PRIORITY.find((k) => kinds.has(k)) ?? 'other';
    const pattern = tokenDiff(text(inputOf.get(ep.last_call)), text(inputOf.get(ep.closer_rid)));
    const key = `${kind}\n${pattern}`;
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { kind, pattern, n: 1, of: eps.length, exampleEpisode: ep.id, verified: false });
  }
  return [...groups.values()].sort((a, b) => b.n - a.n || PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind)).slice(0, limit);
}

function kindOf(tool: string | null, cmd: string | null): Kind {
  if (EDIT_TOOLS.has(tool ?? '') || (tool === 'exec' && /apply_patch/.test(cmd ?? ''))) return 'edit';
  if (cmd && INSTALL.test(cmd)) return 'install';
  if (READ_TOOLS.has(tool ?? '') || (cmd && VIEWER.test(cmd))) return 'read';
  return 'other';
}

function text(r: unknown): string {
  const row = r as { cmd: string | null; input: string | null } | undefined;
  if (!row) return '';
  if (row.cmd) return row.cmd;
  if (!row.input) return '';
  try {
    const v = JSON.parse(row.input);
    return typeof v === 'string' ? v : typeof v?.command === 'string' ? v.command : typeof v?.cmd === 'string' ? v.cmd : '';
  } catch {
    return row.input;
  }
}

/** Added and removed token runs from the last failed input to the closing input, values generalized: `+uv run`, `+PYTHONPATH=`. */
export function tokenDiff(before: string, after: string): string {
  const a = tokens(before);
  const b = tokens(after);
  if (a.join(' ') === b.join(' ')) return 'same input';
  // LCS over tokens (inputs are short), then contiguous runs of additions and deletions.
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const runs: string[] = [];
  let cur: { sign: string; toks: string[] } | null = null;
  const flush = () => {
    if (cur) runs.push(cur.sign + cur.toks.join(' '));
    cur = null;
  };
  const emit = (sign: string, t: string) => {
    if (cur?.sign !== sign) flush();
    if (!cur) cur = { sign, toks: [] };
    cur.toks.push(t);
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) emit('+', b[j++]);
    else emit('-', a[i++]);
  }
  flush();
  const plus = runs.filter((r) => r.startsWith('+'));
  return (plus.length ? plus : runs).slice(0, 3).join(' ').slice(0, PATTERN_MAX) || 'same input';
}

function tokens(s: string): string[] {
  return s.slice(0, 400).split(/\s+/).filter(Boolean).slice(0, 60).map((t) => {
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t);
    if (assign) return `${assign[1]}=`;
    if (/^['"].*['"]$/.test(t)) return '<q>';
    if (/^(?:~|\.\.?)?\/\S*\//.test(t) || /^\/\S+/.test(t)) return '<path>';
    if (/^\d+(?:\.\d+)?$/.test(t)) return '<n>';
    return t;
  });
}
