// Formatting helpers for times, durations, sizes and JSON. Pure functions: no DOM access.
// Times are integer microseconds since the epoch; durations are integer microseconds.

const US_PER_MS = 1_000;
const US_PER_S = 1_000_000;
const US_PER_MIN = 60 * US_PER_S;
const US_PER_H = 60 * US_PER_MIN;
const US_PER_D = 24 * US_PER_H;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Microseconds from a timestamp of unknown unit (seconds, milliseconds or microseconds) or an ISO string; null otherwise. */
export function toMicros(t) {
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms * 1000;
  }
  if (!isNum(t) || t <= 0) return null;
  if (t > 1e14) return t;
  if (t > 1e11) return t * 1e3;
  return t * 1e6;
}

export function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** 12345 → "12,345". */
export function formatInt(n) {
  if (!isNum(n)) return '';
  return Math.round(n).toLocaleString('en-US');
}

/** Compact token or count: 812, 4.5k, 45.1k, 451k, 1.23M. */
/** "1 step", "52 steps", "1,204 calls". */
export function plural(n, word) {
  return `${formatInt(n)} ${word}${n === 1 ? '' : /(s|x|ch|sh)$/.test(word) ? 'es' : 's'}`;
}

export function formatTokens(n) {
  if (!isNum(n)) return '';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a < 1000) return sign + String(Math.round(a));
  if (a < 100_000) return sign + trimZero((a / 1000).toFixed(1)) + 'k';
  if (a < 1_000_000) return sign + Math.round(a / 1000) + 'k';
  if (a < 10_000_000) return sign + trimZero((a / 1e6).toFixed(2)) + 'M';
  if (a < 1_000_000_000) return sign + trimZero((a / 1e6).toFixed(1)) + 'M';
  return sign + trimZero((a / 1e9).toFixed(2)) + 'B';
}

function trimZero(s) {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Byte size with binary units: 512 B, 1.5 KB, 12 MB. */
export function formatBytes(n) {
  if (!isNum(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? trimZero(v.toFixed(1)) : Math.round(v)} ${units[i]}`;
}

/**
 * Duration from µs (docs/DESIGN.md §9): three significant digits below a minute with no trailing zeros ("850µs",
 * "3.25ms", "2.4ms", "120ms", "7.14s", "42s"), then two units with the second padded ("4m 05s", "2h 03m", "3d 04h").
 */
export function formatDuration(us) {
  if (!isNum(us)) return '';
  if (us < 0) return '−' + formatDuration(-us);
  const sig3 = (v) => trimZero(v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0));
  if (us < US_PER_MS) return `${Math.round(us)}µs`;
  if (us < US_PER_S) {
    const ms = sig3(us / US_PER_MS);
    return ms === '1000' ? '1s' : `${ms}ms`;
  }
  if (us < US_PER_MIN) {
    const sec = sig3(us / US_PER_S);
    if (sec !== '60') return `${sec}s`;
  }
  const secs = Math.round(us / US_PER_S);
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${pad(secs % 60)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ${pad(mins % 60)}m`;
  const d = Math.floor(us / US_PER_D);
  return `${d}d ${pad(Math.floor((us % US_PER_D) / US_PER_H))}h`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date in labels (§9 Dates): "Oct 6" in the current year, "2025-10-06" in other years. */
export function formatShortDate(ts, now = Date.now() * 1000) {
  if (!isNum(ts)) return '';
  const d = new Date(Math.floor(ts / US_PER_MS));
  if (d.getFullYear() !== new Date(Math.floor(now / US_PER_MS)).getFullYear()) return formatDate(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** A day and a clock time to the minute for labels: "Oct 12 17:48" ("17:48" alone when `ts` is today). */
export function formatDayTime(ts, now = Date.now() * 1000) {
  if (!isNum(ts)) return '';
  const time = formatClock(ts, { digits: 0, date: false }).slice(0, 5);
  return sameDay(ts, now) ? time : `${formatShortDate(ts, now)} ${time}`;
}

/**
 * Local UTC offset at an instant, "+08:00" or "-04:30". `tzMinutes` overrides the zone
 * (minutes east of UTC) for tests.
 */
export function tzOffset(ts, tzMinutes) {
  const east = isNum(tzMinutes) ? tzMinutes : isNum(ts) ? -new Date(Math.floor(ts / US_PER_MS)).getTimezoneOffset() : -new Date().getTimezoneOffset();
  const sign = east < 0 ? '-' : '+';
  const a = Math.abs(east);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** "UTC+08:00" for the local zone at `ts`. */
export function offsetLabel(ts) {
  return `UTC${tzOffset(ts)}`;
}

/**
 * Wall-clock time "YYYY-MM-DD HH:MM:SS.mmm" (digits = fractional digits, 0, 3 or 6).
 * `date: false` drops the date part; `offset: true` appends the zone (" +08:00", or " UTC").
 */
export function formatClock(ts, { utc = false, digits = 3, date = true, offset = false } = {}) {
  if (!isNum(ts)) return '';
  const ms = Math.floor(ts / US_PER_MS);
  const d = new Date(ms);
  const Y = utc ? d.getUTCFullYear() : d.getFullYear();
  const M = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const D = utc ? d.getUTCDate() : d.getDate();
  const hh = utc ? d.getUTCHours() : d.getHours();
  const mm = utc ? d.getUTCMinutes() : d.getMinutes();
  const ss = utc ? d.getUTCSeconds() : d.getSeconds();
  let s = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  if (digits > 0) {
    const frac = pad(((ts % US_PER_S) + US_PER_S) % US_PER_S, 6).slice(0, digits);
    s += '.' + frac;
  }
  if (date) s = `${Y}-${pad(M)}-${pad(D)} ${s}`;
  if (offset) s += utc ? ' UTC' : ` ${tzOffset(ts)}`;
  return s;
}

/** Local date and time to the second for lists (Diagnostics, Conversation, Sources). */
export function formatStamp(ts, { seconds = true } = {}) {
  if (!isNum(ts)) return '';
  const s = formatClock(ts, { digits: 0 });
  return seconds ? s : s.slice(0, 16);
}

/** Tooltip text that leaves no doubt: local time with its offset, then UTC. */
export function stampTitle(ts, digits = 3) {
  if (!isNum(ts)) return '';
  return `${formatClock(ts, { digits, offset: true })}  ·  ${formatClock(ts, { digits, utc: true, offset: true })}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Day divider label: "Tue 2026-05-26". */
export function formatDayLabel(ts) {
  if (!isNum(ts)) return '';
  return `${WEEKDAYS[new Date(Math.floor(ts / US_PER_MS)).getDay()]} ${formatDate(ts)}`;
}

/** True when two instants fall on the same calendar day (local, or UTC with `utc`). */
export function sameDay(a, b, utc = false) {
  if (!isNum(a) || !isNum(b)) return false;
  return formatDate(a, { utc }) === formatDate(b, { utc });
}

/** Local calendar date "YYYY-MM-DD". */
export function formatDate(ts, { utc = false } = {}) {
  if (!isNum(ts)) return '';
  return formatClock(ts, { utc, digits: 0 }).slice(0, 10);
}

/**
 * Signed elapsed time for relative time columns: 0.000123, 12.345, 3:04.567, 1:02:03.456, 2d 01:02:03.
 * Values under one second keep microsecond digits.
 */
export function formatRelative(us) {
  if (!isNum(us)) return '';
  const sign = us < 0 ? '−' : '';
  const a = Math.abs(us);
  if (a < US_PER_S) return sign + (a / US_PER_S).toFixed(6);
  if (a < US_PER_MIN) return sign + (a / US_PER_S).toFixed(3);
  const ms = pad(Math.floor((a % US_PER_S) / US_PER_MS), 3);
  const s = pad(Math.floor((a % US_PER_MIN) / US_PER_S));
  if (a < US_PER_H) return `${sign}${Math.floor(a / US_PER_MIN)}:${s}.${ms}`;
  const m = pad(Math.floor((a % US_PER_H) / US_PER_MIN));
  if (a < US_PER_D) return `${sign}${Math.floor(a / US_PER_H)}:${m}:${s}.${ms}`;
  const h = pad(Math.floor((a % US_PER_D) / US_PER_H));
  return `${sign}${Math.floor(a / US_PER_D)}d ${h}:${m}:${s}`;
}

export const TIME_FORMATS = [
  { id: 'local', label: 'Date and time of day (local)' },
  { id: 'utc', label: 'Date and time of day (UTC)' },
  { id: 'rel-first', label: 'Seconds since first displayed event' },
  { id: 'delta-prev', label: 'Seconds since previous displayed event' },
  { id: 'rel-session', label: 'Seconds since session start' },
];

/**
 * Compact wall-clock time for a list (docs/DESIGN.md §9 Absolute time): "HH:MM:SS.mmm" when `prev` falls on the
 * same day, otherwise with the short date prefix ("Oct 12 21:02:54.509"), so the date shows once per day.
 */
export function formatClockCompact(ts, prev, utc = false) {
  if (!isNum(ts)) return '';
  const time = formatClock(ts, { utc, date: false });
  if (sameDay(ts, prev, utc)) return time;
  const d = new Date(Math.floor(ts / US_PER_MS));
  const year = utc ? d.getUTCFullYear() : d.getFullYear();
  if (year !== new Date().getFullYear()) return `${formatDate(ts, { utc })} ${time}`;
  return `${MONTHS[utc ? d.getUTCMonth() : d.getMonth()]} ${utc ? d.getUTCDate() : d.getDate()} ${time}`;
}

/**
 * Time column text for one event.
 * ctx: { first: ts of first displayed event, prev: ts of previous displayed event, sessionStart,
 *        compact: drop the date when the previous row has the same one }.
 */
export function formatTime(ts, mode, ctx = {}) {
  switch (mode) {
    case 'utc':
      return ctx.compact ? formatClockCompact(ts, ctx.prev, true) : formatClock(ts, { utc: true });
    case 'rel-first':
      return isNum(ctx.first) ? formatRelative(ts - ctx.first) : '';
    case 'delta-prev':
      return isNum(ctx.prev) ? formatRelative(ts - ctx.prev) : '';
    case 'rel-session':
      return isNum(ctx.sessionStart) ? formatRelative(ts - ctx.sessionStart) : '';
    default:
      return ctx.compact ? formatClockCompact(ts, ctx.prev) : formatClock(ts);
  }
}

/** Age for lists (§9 Relative time): "just now", "12m ago", "3h ago", "4d ago" under 7 days, then "Sep 11" or "2025-09-11". */
export function formatAgo(ts, now = Date.now() * 1000) {
  if (!isNum(ts)) return '';
  const d = now - ts;
  if (d < US_PER_MIN) return 'just now';
  if (d < US_PER_H) return `${Math.floor(d / US_PER_MIN)}m ago`;
  if (d < US_PER_D) return `${Math.floor(d / US_PER_H)}h ago`;
  if (d < 7 * US_PER_D) return `${Math.floor(d / US_PER_D)}d ago`;
  return formatShortDate(ts, now);
}

export function formatPercent(ratio, digits = 1) {
  if (!isNum(ratio)) return '';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatUsd(v) {
  if (!isNum(v)) return '';
  return v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export const AGENTS = [
  { id: 'claude-code', label: 'Claude Code', color: 'var(--agent-claude)' },
  { id: 'claude-cowork', label: 'Claude Cowork', color: 'var(--agent-cowork)' },
  { id: 'codex', label: 'Codex', color: 'var(--agent-codex)' },
  { id: 'copilot', label: 'Copilot', color: 'var(--agent-copilot)' },
  { id: 'antigravity', label: 'Antigravity', color: 'var(--agent-antigravity)' },
];

export function agentLabel(agent) {
  return AGENTS.find((a) => a.id === agent)?.label ?? String(agent ?? '');
}

/** CSS color (token reference) for an agent. */
export function agentColor(agent) {
  return AGENTS.find((a) => a.id === agent)?.color ?? 'var(--fg-muted)';
}

const LAYER_COLORS = {
  user: 'var(--c-user)', llm: 'var(--c-llm)', tool: 'var(--c-tool-shell)', agent: 'var(--c-agent)',
  context: 'var(--c-context)', hook: 'var(--c-hook)', harness: 'var(--c-harness)', raw: 'var(--c-raw)',
  session: 'var(--c-context)', turn: 'var(--c-hook)', permission: 'var(--warn)',
};

/** CSS color (token reference) for an event kind, by layer; thinking and compaction get their own. */
export function kindColor(kind) {
  if (kind === 'llm.thinking') return 'var(--c-thinking)';
  if (kind === 'context.compaction') return 'var(--c-compaction)';
  const layer = typeof kind === 'string' ? kind.split('.')[0] : '';
  return LAYER_COLORS[layer] ?? 'var(--fg-faint)';
}

/** Shorten an id or hash for display: keeps the agent prefix and the first `n` characters of the native part. */
export function shortId(id, n = 8) {
  if (typeof id !== 'string') return '';
  const m = /^([a-z]{2}):(.*)$/.exec(id);
  if (!m) return id.length > n + 2 ? id.slice(0, n) + '…' : id;
  const parts = m[2].split('/').map((p) => (p.length > n ? p.slice(0, n) : p));
  return `${m[1]}:${parts.join('/')}`;
}

/** Keep the end of a long path: "…/projects/demo/abc.jsonl". */
export function truncateStart(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s ?? '';
  return '…' + s.slice(s.length - n + 1);
}

export function lineCount(text) {
  if (typeof text !== 'string' || !text) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// JSON pointers (RFC 6901)

export function pointerEscape(key) {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function pointerSegments(ptr) {
  if (!ptr) return [];
  return ptr.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function pointerGet(value, ptr) {
  let cur = value;
  for (const seg of pointerSegments(ptr)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Pretty JSON with source offsets

/**
 * Pretty-print a JSON text into lines of classified segments while keeping a map from every
 * value's JSON pointer to its character range in the ORIGINAL text and to its segment span in
 * the output. Throws SyntaxError on invalid JSON.
 *
 * Segment: { c: 'key'|'str'|'num'|'lit'|'punc'|'ws', t: display text, p: pointer of the value it belongs to }
 * ptrs: Map pointer → { s, e, l0, l1 }  (s/e: [start, end) in text; l0/l1: first/last output line)
 */
export function prettyJson(text, { indent = 2 } = {}) {
  const lines = [];
  let line = [];
  const ptrs = new Map();
  let i = 0;
  const n = text.length;

  const fail = (what) => {
    throw new SyntaxError(`${what} at offset ${i}`);
  };
  const skipWs = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const push = (c, t, p) => line.push({ c, t, p });
  const newline = (depth) => {
    lines.push(line);
    line = depth > 0 ? [{ c: 'ws', t: ' '.repeat(depth * indent), p: null }] : [];
  };
  const scanString = () => {
    const start = i;
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 92) {
        i += 2;
      } else if (c === 34) {
        i++;
        return text.slice(start, i);
      } else {
        i++;
      }
    }
    return fail('Unterminated string');
  };

  const value = (ptr, depth) => {
    skipWs();
    const s = i;
    const l0 = lines.length;
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const isObj = ch === '{';
      const close = isObj ? '}' : ']';
      i++;
      skipWs();
      if (text[i] === close) {
        i++;
        push('punc', ch + close, ptr);
      } else {
        push('punc', ch, ptr);
        let index = 0;
        for (;;) {
          skipWs();
          newline(depth + 1);
          let child;
          if (isObj) {
            if (text[i] !== '"') fail('Expected key');
            const rawKey = scanString();
            child = ptr + '/' + pointerEscape(JSON.parse(rawKey));
            push('key', rawKey, child);
            skipWs();
            if (text[i] !== ':') fail('Expected ":"');
            i++;
            push('punc', ': ', child);
          } else {
            child = ptr + '/' + index;
          }
          value(child, depth + 1);
          index++;
          skipWs();
          if (text[i] === ',') {
            i++;
            push('punc', ',', ptr);
            continue;
          }
          if (text[i] === close) {
            i++;
            newline(depth);
            push('punc', close, ptr);
            break;
          }
          fail(`Expected "," or "${close}"`);
        }
      }
    } else if (ch === '"') {
      push('str', scanString(), ptr);
    } else {
      const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
      if (!m) fail('Unexpected token');
      i += m[0].length;
      push(m[0][0] === '-' || (m[0][0] >= '0' && m[0][0] <= '9') ? 'num' : 'lit', m[0], ptr);
    }
    ptrs.set(ptr, { s, e: i, l0, l1: lines.length });
  };

  value('', 0);
  skipWs();
  if (i < n) fail('Unexpected trailing text');
  lines.push(line);
  return { lines, ptrs };
}
