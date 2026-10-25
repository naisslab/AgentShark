// Recursive-descent parser for the display filter language (SPEC §5.3).
// Precedence, loosest first: or, and, not. The parser checks syntax only;
// compile.ts resolves names against the field registry.

import { FilterError, lex, type CmpOp, type Token } from './lexer.ts';

export type Node =
  | { type: 'or' | 'and'; items: Node[]; start: number; end: number }
  | { type: 'not'; expr: Node; start: number; end: number }
  | { type: 'compare'; field: Token; op: CmpOp; value: Token; start: number; end: number }
  | { type: 'in'; field: Token; values: Token[]; start: number; end: number }
  | { type: 'contains' | 'matches'; field: Token; value: Token; start: number; end: number }
  /** Bare word: a layer, flag, event kind or field tested for truthiness. */
  | { type: 'word'; name: Token; start: number; end: number }
  /** Bare quoted string: full-text search. */
  | { type: 'search'; text: Token; start: number; end: number };

const VALUE_TYPES = new Set(['string', 'number', 'word']);
/** Limit on nested parentheses and nots, well below SQLite's expression depth limit. */
const MAX_DEPTH = 100;

/** Parse a filter. Returns null for an empty filter; throws FilterError on a syntax error. */
export function parse(src: string): Node | null {
  const toks = lex(src);
  let i = 0;
  let depth = 0;
  const peek = () => toks[i];
  function fail(msg: string, t: Token): never {
    throw new FilterError(msg, t.start, t.end);
  }
  function enter(t: Token): void {
    if (++depth > MAX_DEPTH) fail('filter is nested too deeply', t);
  }

  function parseList(type: 'or' | 'and', parseItem: () => Node): Node {
    const items = [parseItem()];
    while (peek().type === type) {
      i++;
      items.push(parseItem());
    }
    if (items.length === 1) return items[0];
    return { type, items, start: items[0].start, end: items[items.length - 1].end };
  }
  const parseOr = (): Node => parseList('or', parseAnd);
  const parseAnd = (): Node => parseList('and', parseUnary);

  function parseUnary(): Node {
    const t = peek();
    if (t.type !== 'not') return parsePrimary();
    i++;
    enter(t);
    const expr = parseUnary();
    depth--;
    return { type: 'not', expr, start: t.start, end: expr.end };
  }

  function parsePrimary(): Node {
    const t = peek();
    const prev = toks[i - 1];
    switch (t.type) {
      case '(': {
        i++;
        enter(t);
        const expr = parseOr();
        depth--;
        const close = peek();
        if (close.type === 'eof') fail("unclosed '('", t);
        if (close.type !== ')') fail(`expected 'and', 'or' or ')' before '${close.text}'`, close);
        i++;
        return expr;
      }
      case 'string':
        i++;
        return { type: 'search', text: t, start: t.start, end: t.end };
      case 'word':
        i++;
        return parseAfterField(t);
      case 'eof':
        // parse() returns early for an empty filter, so eof here always follows a token.
        return fail(`expected an expression after '${prev.text}'`, t);
      case 'cmp': case 'in': case 'contains': case 'matches':
        return fail(`expected a field name before '${t.text}'`, t);
      case 'number':
        return fail(`expected a field name, layer or quoted string, found '${t.text}'`, t);
      default:
        return fail(prev ? `expected an expression after '${prev.text}', found '${t.text}'` : `unexpected '${t.text}'`, t);
    }
  }

  function parseAfterField(field: Token): Node {
    const op = peek();
    const value = (what: string): Token => {
      const v = peek();
      if (!VALUE_TYPES.has(v.type)) fail(`expected ${what} after '${toks[i - 1].text}'`, v);
      i++;
      return v;
    };
    switch (op.type) {
      case 'cmp': {
        i++;
        const v = value('a value');
        return { type: 'compare', field, op: op.value as CmpOp, value: v, start: field.start, end: v.end };
      }
      case 'contains': case 'matches': {
        i++;
        const v = value('a string');
        return { type: op.type, field, value: v, start: field.start, end: v.end };
      }
      case 'in': {
        i++;
        const open = peek();
        if (open.type !== '{') fail("expected '{' after 'in'", open);
        i++;
        const values = [value('a value')];
        for (;;) {
          const t = peek();
          if (t.type === '}') {
            i++;
            return { type: 'in', field, values, start: field.start, end: t.end };
          }
          if (t.type === 'eof') fail("unclosed '{'", open);
          if (t.type !== ',') fail(`expected ',' or '}' before '${t.text}'`, t);
          i++;
          values.push(value('a value'));
        }
      }
      default:
        return { type: 'word', name: field, start: field.start, end: field.end };
    }
  }

  if (peek().type === 'eof') return null;
  const node = parseOr();
  const t = peek();
  if (t.type === ')') fail("unexpected ')' with no matching '('", t);
  if (t.type !== 'eof') fail(`expected 'and' or 'or' before '${t.text}'`, t);
  return node;
}
