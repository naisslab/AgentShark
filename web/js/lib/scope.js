// The investigation scope model (SPEC §7.8): session set, time range and display filter, the
// view states every scoped workspace shares, filter combination for drill-down, and the test
// that decides whether an index change touches the current scope. Pure module: no DOM access.

/** Wireshark-style ways to combine a new predicate with the applied filter. */
export const COMBINE_MODES = [
  { id: 'replace', label: 'Selected', hint: 'replace the filter' },
  { id: 'not', label: 'Not selected', hint: 'replace with the negation' },
  { id: 'and', label: '…and selected' },
  { id: 'or', label: '…or selected' },
  { id: 'and-not', label: '…and not selected' },
  { id: 'or-not', label: '…or not selected' },
];

/** Wrap an expression in parentheses unless it is a single term. */
function group(expr) {
  const e = expr.trim();
  return /^[\w.$-]+(\s*(==|!=|>=|<=|>|<|~|contains|matches)\s*("([^"\\]|\\.)*"|[\w.$-]+))?$/.test(e) ? e : `(${e})`;
}

/**
 * Combine `expr` with the applied filter `current`. The default 'and' narrows: drill-down never
 * widens the population. With no current filter, 'and'/'or' reduce to `expr` and the negating
 * modes to `!expr`.
 */
export function combineFilter(current, expr, mode = 'and') {
  const cur = (current ?? '').trim();
  const add = (expr ?? '').trim();
  if (!add) return cur;
  // A negation always gets parentheses unless it negates a single word (a flag, layer or kind).
  const neg = /^[\w.$-]+$/.test(add) ? `!${add}` : `!(${add})`;
  switch (mode) {
    case 'replace':
      return add;
    case 'not':
      return neg;
    case 'or':
      return cur ? `${group(cur)} || ${group(add)}` : add;
    case 'and-not':
      return cur ? `${group(cur)} && ${neg}` : neg;
    case 'or-not':
      return cur ? `${group(cur)} || ${neg}` : neg;
    default:
      return cur ? `${group(cur)} && ${group(add)}` : add;
  }
}

/** A filter literal for a JSON value, or null when the value cannot be compared. */
export function filterLiteral(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

/** `field == value` for a scalar, `field` alone for `true`, null when not expressible. */
export function fieldPredicate(field, value) {
  if (!field) return null;
  if (value === true) return field;
  if (value === false) return `!${field}`;
  const lit = filterLiteral(value);
  return lit == null ? null : `${field} == ${lit}`;
}

/**
 * The state of a workspace that depends on the materialized view:
 * 'loading' | 'failed' | 'ready-empty' | 'ready'. A refresh of an existing view stays 'ready'.
 */
export function viewStatus({ view, viewLoading, viewError }) {
  if (viewError && !viewLoading) return 'failed';
  if (viewLoading && (!view || view.reason !== 'refresh')) return 'loading';
  if (!view) return viewError ? 'failed' : 'loading';
  return view.count === 0 ? 'ready-empty' : 'ready';
}

/** True for API errors that mean the view no longer exists on the server. */
export function isViewExpired(err) {
  const code = err?.data?.error?.code;
  return err?.status === 404 && (code === 'view-not-found' || code === 'view_expired' || code === 'view-expired');
}

const sameList = (a, b) => (a ?? []).join('\n') === (b ?? []).join('\n');

/** Equality of two scopes ({sessions, from, to}). */
export function sameScope(a, b) {
  return sameList(a?.sessions, b?.sessions) && (a?.from ?? null) === (b?.from ?? null) && (a?.to ?? null) === (b?.to ?? null);
}

/**
 * Whether an index change can alter what a scope shows. `changed` is the list of changed session
 * ids, or null when unknown (every scope is affected). `scopeIds` null means all sessions.
 * `parentOf(id)` returns the parent session id from the metadata cache.
 */
export function changeAffects(changed, scopeIds, parentOf) {
  if (changed == null) return true;
  if (!changed.length) return false;
  if (!scopeIds?.length) return true;
  const want = new Set(scopeIds);
  for (const id of changed) {
    let cur = id;
    for (let depth = 0; cur && depth < 12; depth++) {
      if (want.has(cur)) return true;
      cur = parentOf(cur);
    }
  }
  return false;
}

/**
 * Short parts naming the active scope, e.g. ['filter', '2 sessions', '10:02–10:07'].
 * fmtRange(from, to) formats the time range.
 */
export function scopeParts({ scope, filter }, fmtRange) {
  const parts = [];
  if (filter) parts.push('filter');
  const n = scope?.sessions?.length ?? 0;
  if (n === 1) parts.push('1 session + subagents');
  else if (n > 1) parts.push(`${n} sessions + subagents`);
  if (scope?.from != null || scope?.to != null) parts.push(fmtRange(scope.from, scope.to));
  return parts;
}

/** Sort keys the server accepts (MAC-CONTRACT §3) and their natural first direction. */
export const SORT_KEYS = { ts: 'asc', seq: 'asc', dur: 'desc', tokIn: 'desc', tokOut: 'desc', kind: 'asc', tool: 'asc', session: 'asc' };

/** Next sort after clicking a header bound to `key`: the same key flips, a new key starts natural. */
export function nextSort(cur, key) {
  if (cur?.key === key) return { key, order: cur.order === 'asc' ? 'desc' : 'asc' };
  return { key, order: SORT_KEYS[key] ?? 'asc' };
}
