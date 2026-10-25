// Tokenizer for the display filter language (SPEC §5.3).
// Positions are UTF-16 offsets into the filter text: [start, end).

export class FilterError extends Error {
  start: number;
  end: number;
  constructor(message: string, start: number, end: number) {
    super(message);
    this.name = 'FilterError';
    this.start = start;
    this.end = end;
  }
}

export type CmpOp = '==' | '!=' | '>' | '>=' | '<' | '<=';

export type TokenType =
  | '(' | ')' | '{' | '}' | ','
  | 'cmp' | 'and' | 'or' | 'not' | 'in' | 'contains' | 'matches'
  | 'string' | 'number' | 'word' | 'eof';

export interface Token {
  type: TokenType;
  /** Source text of the token, quotes included. */
  text: string;
  /** Decoded string for 'string', normalized operator for 'cmp', otherwise the source text. */
  value: string;
  /** 'number' only: the numeric part, before any unit is applied. */
  num?: number;
  unit?: string;
  start: number;
  end: number;
}

export type UnitDim = 'duration' | 'count' | 'bytes';

/** Duration factors are microseconds; count and byte factors are plain multipliers. */
export const UNITS: Record<string, { dim: UnitDim; factor: number }> = {
  us: { dim: 'duration', factor: 1 },
  µs: { dim: 'duration', factor: 1 },
  ms: { dim: 'duration', factor: 1e3 },
  s: { dim: 'duration', factor: 1e6 },
  m: { dim: 'duration', factor: 60e6 },
  min: { dim: 'duration', factor: 60e6 },
  h: { dim: 'duration', factor: 3600e6 },
  d: { dim: 'duration', factor: 86400e6 },
  k: { dim: 'count', factor: 1e3 },
  K: { dim: 'count', factor: 1e3 },
  M: { dim: 'count', factor: 1e6 },
  KB: { dim: 'bytes', factor: 1024 },
  MB: { dim: 'bytes', factor: 1024 ** 2 },
  GB: { dim: 'bytes', factor: 1024 ** 3 },
};

const NUMBER_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([A-Za-zµ]*)$/;

/** Parse `12`, `-2h`, `1.5s`, `4KB`. Returns null for anything else, including unknown units. */
export function parseNumber(text: string): { num: number; unit?: string } | null {
  const m = NUMBER_RE.exec(text);
  if (!m || (m[2] && !(m[2] in UNITS))) return null;
  return { num: Number(m[1]), unit: m[2] || undefined };
}

const WORD_OPS: Record<string, [TokenType, CmpOp?]> = {
  eq: ['cmp', '=='],
  ne: ['cmp', '!='],
  gt: ['cmp', '>'],
  ge: ['cmp', '>='],
  lt: ['cmp', '<'],
  le: ['cmp', '<='],
  and: ['and'],
  or: ['or'],
  not: ['not'],
  in: ['in'],
  contains: ['contains'],
  matches: ['matches'],
};

// Everything else is part of a word, so bare literals such as claude-code,
// cc:abc/def or 2026-10-11 lex as one token.
const DELIMITERS = new Set([...'(){},"\'=!<>&|~']);

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };

export function lex(src: string): Token[] {
  const tokens: Token[] = [];
  const push = (type: TokenType, start: number, end: number, value?: string) => {
    const text = src.slice(start, end);
    tokens.push({ type, text, value: value ?? text, start, end });
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    const next = src[i + 1];
    switch (c) {
      case '(': case ')': case '{': case '}': case ',':
        push(c, i, ++i);
        continue;
      case '"': case "'": {
        const { value, end } = readString(src, i);
        push('string', start, end, value);
        i = end;
        continue;
      }
      case '=':
        if (next !== '=') throw new FilterError("use '==' to compare", i, i + 1);
        push('cmp', i, (i += 2), '==');
        continue;
      case '!':
        if (next === '=') push('cmp', i, (i += 2), '!=');
        else push('not', i, ++i);
        continue;
      case '<': case '>':
        if (next === '=') push('cmp', i, (i += 2));
        else push('cmp', i, ++i);
        continue;
      case '&': case '|':
        if (next !== c) throw new FilterError(`use '${c}${c}' for ${c === '&' ? 'and' : 'or'}`, i, i + 1);
        push(c === '&' ? 'and' : 'or', i, (i += 2));
        continue;
      case '~':
        push('matches', i, ++i);
        continue;
    }
    while (i < src.length && !DELIMITERS.has(src[i]) && !/\s/.test(src[i])) i++;
    const text = src.slice(start, i);
    const op = WORD_OPS[text.toLowerCase()];
    if (op) {
      push(op[0], start, i, op[1]);
      continue;
    }
    const n = parseNumber(text);
    if (n) tokens.push({ type: 'number', text, value: text, num: n.num, unit: n.unit, start, end: i });
    else push('word', start, i);
  }
  tokens.push({ type: 'eof', text: '', value: '', start: src.length, end: src.length });
  return tokens;
}

/**
 * Read a quoted string starting at `start`. Unknown escapes keep their backslash,
 * so regular expressions such as "\d+\.ts" need no double escaping.
 */
function readString(src: string, start: number): { value: string; end: number } {
  const quote = src[start];
  let out = '';
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === quote) return { value: out, end: i + 1 };
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const e = src[i + 1];
    if (e === undefined) break;
    const hex = e === 'x' ? /^[0-9a-fA-F]{2}/.exec(src.slice(i + 2)) : e === 'u' ? /^(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]{1,6}\})/.exec(src.slice(i + 2)) : null;
    const code = hex ? parseInt(hex[0].replace(/[{}]/g, ''), 16) : -1;
    if (hex && code <= 0x10ffff) {
      out += String.fromCodePoint(code);
      i += 2 + hex[0].length;
    } else {
      out += SIMPLE_ESCAPES[e] ?? '\\' + e;
      i += 2;
    }
  }
  throw new FilterError('unterminated string', start, src.length);
}
