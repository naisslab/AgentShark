// Raw source-line helpers for the raw pane (SPEC §6 /api/events/:id/raw, §7.4 byte highlighting).
// Both scanners are single-pass and iterative so 20 MB lines and deep nesting stay cheap.

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJ = 0x7b;
const CLOSE_OBJ = 0x7d;
const OPEN_ARR = 0x5b;
const CLOSE_ARR = 0x5d;

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

function skipWs(text: string, i: number): number {
  while (i < text.length && isWs(text.charCodeAt(i))) i++;
  return i;
}

/** `text[i]` is an opening quote. Returns the index just past the closing quote, or -1 when unterminated. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  for (;;) {
    const q = text.indexOf('"', j);
    if (q < 0) return -1;
    let b = q - 1;
    while (text.charCodeAt(b) === BACKSLASH) b--;
    // An even number of backslashes before the quote means the quote itself is not escaped.
    if ((q - 1 - b) % 2 === 0) return q + 1;
    j = q + 1;
  }
}

function pointerToken(text: string, start: number, end: number): string {
  let key = text.slice(start + 1, end - 1);
  if (key.includes('\\')) {
    try {
      key = JSON.parse(text.slice(start, end));
    } catch {
      // Keep the escaped form when the key is not valid JSON.
    }
  }
  if (key.includes('~') || key.includes('/')) key = key.replace(/~/g, '~0').replace(/\//g, '~1');
  return key;
}

interface Frame {
  pointer: string;
  isArray: boolean;
  index: number;
  start: number;
}

/**
 * Character ranges [start, end) of every value in a JSON text, keyed by JSON Pointer (RFC 6901); "" is the root.
 * Malformed or truncated input yields the ranges found before the first syntax error.
 */
export function jsonRanges(text: string): Record<string, [number, number]> {
  const ranges: Record<string, [number, number]> = {};
  const stack: Frame[] = [];
  const n = text.length;
  let i = skipWs(text, 0);
  let pointer = '';

  // Reads `"key" :` at i inside an object frame; sets `pointer` and returns false on a syntax error.
  const readKey = (frame: Frame): boolean => {
    i = skipWs(text, i);
    if (text.charCodeAt(i) !== QUOTE) return false;
    const end = stringEnd(text, i);
    if (end < 0) return false;
    pointer = frame.pointer + '/' + pointerToken(text, i, end);
    i = skipWs(text, end);
    if (text.charCodeAt(i) !== COLON) return false;
    i = skipWs(text, i + 1);
    return true;
  };

  scan: while (i < n) {
    const start = i;
    const c = text.charCodeAt(i);
    if (c === OPEN_OBJ || c === OPEN_ARR) {
      const frame: Frame = { pointer, isArray: c === OPEN_ARR, index: 0, start };
      i = skipWs(text, i + 1);
      const close = text.charCodeAt(i);
      if (close === (frame.isArray ? CLOSE_ARR : CLOSE_OBJ)) {
        i++;
        ranges[pointer] = [start, i];
      } else {
        stack.push(frame);
        if (frame.isArray) pointer = frame.pointer + '/0';
        else if (!readKey(frame)) break;
        continue;
      }
    } else if (c === QUOTE) {
      i = stringEnd(text, i);
      if (i < 0) break;
      ranges[pointer] = [start, i];
    } else {
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === COMMA || d === CLOSE_ARR || d === CLOSE_OBJ || isWs(d)) break;
        i++;
      }
      if (i === start) break;
      ranges[pointer] = [start, i];
    }

    // After a value: close finished containers, or move to the next member.
    for (;;) {
      i = skipWs(text, i);
      const frame = stack[stack.length - 1];
      if (!frame || i >= n) break scan;
      const d = text.charCodeAt(i);
      if (d === COMMA) {
        i = skipWs(text, i + 1);
        if (frame.isArray) {
          frame.index++;
          pointer = frame.pointer + '/' + frame.index;
        } else if (!readKey(frame)) {
          break scan;
        }
        continue scan;
      }
      if (d !== (frame.isArray ? CLOSE_ARR : CLOSE_OBJ)) break scan;
      i++;
      ranges[frame.pointer] = [frame.start, i];
      stack.pop();
    }
  }
  return ranges;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * End of the longest prefix of the string content starting at `from` that has at most `max` source chars
 * and does not split an escape sequence or a surrogate pair (raw or `\uXXXX`-escaped).
 */
function safeCut(text: string, from: number, max: number): number {
  const limit = from + max;
  let j = from;
  let lastStart = from;
  let lastHigh = false;
  while (j < limit) {
    let next: number;
    let code: number;
    if (text.charCodeAt(j) === BACKSLASH) {
      if (text.charCodeAt(j + 1) === 0x75 /* u */) {
        next = j + 6;
        code = parseInt(text.slice(j + 2, j + 6), 16);
      } else {
        next = j + 2;
        code = 0;
      }
    } else {
      next = j + 1;
      code = text.charCodeAt(j);
    }
    if (next > limit) break;
    lastStart = j;
    lastHigh = isHighSurrogate(code);
    j = next;
  }
  return lastHigh ? lastStart : j;
}

/**
 * Shorten string values longer than `maxString` source chars to their prefix plus `…[+N chars]`, where N counts the
 * removed source chars. Object keys are kept whole. The result stays valid JSON when the input is valid JSON.
 */
export function shortenJson(text: string, maxString: number): { text: string; truncated: boolean } {
  if (!(maxString >= 0) || maxString === Infinity) return { text, truncated: false };
  const parts: string[] = [];
  let copied = 0;
  let i = 0;
  for (;;) {
    const q = text.indexOf('"', i);
    if (q < 0) break;
    const closed = stringEnd(text, q);
    const end = closed < 0 ? text.length : closed;
    const contentEnd = closed < 0 ? end : end - 1;
    i = end;
    if (contentEnd - (q + 1) <= maxString) continue;
    if (closed >= 0 && text.charCodeAt(skipWs(text, end)) === COLON) continue;
    const cut = safeCut(text, q + 1, maxString);
    parts.push(text.slice(copied, cut), `…[+${contentEnd - cut} chars]"`);
    copied = end;
  }
  if (copied === 0) return { text, truncated: false };
  parts.push(text.slice(copied));
  return { text: parts.join(''), truncated: true };
}
