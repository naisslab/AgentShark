// Compiles a display filter (SPEC §5.3) into a parameterized SQL boolean expression.

import { closest, resolveName, type FieldDef } from './fields.ts';
import { FilterError, UNITS, parseNumber, type CmpOp, type Token } from './lexer.ts';
import { parse, type Node } from './parser.ts';

export { FilterError };

export interface CompiledFilter {
  /**
   * Boolean SQL over the aliases e (events) and p (event_payload). Session and span fields compile to semi-joins
   * (`e.session_id IN (SELECT s.id FROM sessions s WHERE …)`, `e.span_id IN (SELECT sp.id FROM spans sp WHERE …)`),
   * which read the small tables once instead of joining every event row.
   */
  sql: string;
  /** Positional ? parameters, in order. */
  params: (string | number)[];
  /**
   * `payload`: the SQL reads p.attrs or p.native, so the caller adds `LEFT JOIN event_payload p ON p.rid = e.rid`.
   * `session` and `span` are always false: those fields compile to semi-joins.
   */
  joins: { session: boolean; span: boolean; payload: boolean };
  warnings: string[];
  /** The filter searches the full-text index (a bare quoted string). */
  fts: boolean;
  /** The filter has a relative time (`ts > -2h`), anchored at compile time. */
  usesNow: boolean;
  /**
   * A span field is a term of the top-level AND (or the whole filter): every match lies in the spans that term selects,
   * so the events' span index can drive the query.
   */
  spanDriven: boolean;
}

type Param = string | number;

interface Frag {
  sql: string;
  /** The expression can be NULL (a missing field); NOT must then treat NULL as false. */
  nullable: boolean;
  /** `sql` is already enclosed in parentheses or a function call. */
  closed: boolean;
  /** Relative evaluation cost: 0 column, 1 subquery, 2 JSON or LIKE, 3 regular expression. AND and OR test cheap terms first. */
  cost?: number;
}

const PAYLOAD_RE = /\bp\.(attrs|native)\b/;

/** Longest accepted regular expression, and the shape of nested quantifiers that backtrack catastrophically. */
const REGEX_MAX = 500;
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

export interface CompileOptions {
  /** Epoch ms that anchors relative times such as `ts > -2h` (default now). */
  now?: number;
  /**
   * How attrs and native fields read the payload table. 'join' (default): over `p`, which the caller joins per event
   * (`joins.payload`); right for a few rows (one session, a page of rows, coloring rules). 'semi': each such predicate
   * becomes `e.rid IN (SELECT p.rid FROM event_payload p WHERE …)`, one sequential pass over the payload table;
   * right for a filter over the whole index, which would otherwise look up the payload of every event in time order.
   */
  payload?: 'join' | 'semi';
}

/**
 * Compile `src`. Throws FilterError with the character range of the problem.
 */
export function compileFilter(src: string, opts: CompileOptions = {}): CompiledFilter {
  const out: CompiledFilter = {
    sql: '1', params: [], joins: { session: false, span: false, payload: false }, warnings: [], fts: false, usesNow: false, spanDriven: false,
  };
  const ast = parse(src);
  if (!ast) return out;
  const nowUs = (opts.now ?? Date.now()) * 1000;
  const semi = opts.payload === 'semi';

  const warn = (w: string) => {
    if (!out.warnings.includes(w)) out.warnings.push(w);
  };
  const fail = (msg: string, t: { start: number; end: number }): never => {
    throw new FilterError(msg, t.start, t.end);
  };

  function field(tok: Token, bare: boolean): FieldDef {
    const r = resolveName(tok.value, bare);
    if ('error' in r) return fail(r.error, tok);
    if (r.warning) warn(r.warning);
    if (!semi && PAYLOAD_RE.test(r.def.sql)) out.joins.payload = true;
    return r.def;
  }

  /** A predicate over a session or span field becomes a semi-join on the event's session or span id. */
  function scoped(def: FieldDef, f: Frag): Frag {
    const cost = Math.max(1, f.cost ?? 0);
    if (semi && PAYLOAD_RE.test(def.sql)) {
      return { sql: `e.rid IN (SELECT p.rid FROM event_payload p WHERE ${f.sql})`, nullable: false, closed: false, cost: Math.max(2, cost) };
    }
    if (def.join === 'session') return { sql: `e.session_id IN (SELECT s.id FROM sessions s WHERE ${f.sql})`, nullable: false, closed: false, cost };
    if (def.join === 'span') return { sql: `e.span_id IN (SELECT sp.id FROM spans sp WHERE ${f.sql})`, nullable: false, closed: false, cost };
    return f;
  }

  const costOf = (def: FieldDef, base = 0) => Math.max(base, def.json || def.sql.startsWith('json_extract') ? 2 : 0);

  /**
   * A derived field (SPEC §12.3.1): fill each `?` slot of its semi-join template with `tail` (the operator and its
   * placeholders) and push `values` once per slot. Cost class "subquery".
   */
  function semiJoin(def: FieldDef, tail: string, values: Param[]): Frag {
    const parts = def.semi!.split('?');
    let sql = parts[0];
    for (const part of parts.slice(1)) {
      sql += tail + part;
      out.params.push(...values);
    }
    return { sql, nullable: !def.notNull, closed: false, cost: 1 };
  }

  function compile(n: Node): Frag {
    switch (n.type) {
      case 'or':
      case 'and': {
        // Each part pushes its own parameters, so cheap parts move first together with their parameters.
        const compiled = n.items.map((item) => {
          const at = out.params.length;
          const frag = compile(item);
          return { frag, params: out.params.splice(at) };
        });
        compiled.sort((a, b) => (a.frag.cost ?? 0) - (b.frag.cost ?? 0));
        for (const c of compiled) out.params.push(...c.params);
        const parts = compiled.map((c) => c.frag);
        const sql = parts.map((p) => p.sql).join(n.type === 'or' ? ' OR ' : ' AND ');
        return { sql: `(${sql})`, nullable: parts.some((p) => p.nullable), closed: true, cost: Math.max(...parts.map((p) => p.cost ?? 0)) };
      }
      case 'not': {
        const x = compile(n.expr);
        const sql = x.nullable ? `coalesce(${x.sql}, 0)` : x.closed ? x.sql : `(${x.sql})`;
        return { sql: `NOT ${sql}`, nullable: false, closed: false, cost: x.cost };
      }
      case 'word': {
        const def = field(n.name, true);
        // A bare field is true when present and not false, 0 or ''.
        if (def.semi) return semiJoin(def, "NOT IN (0, '')", []);
        const sql = def.predicate ? def.sql : `coalesce(${def.sql} NOT IN (0, ''), 0)`;
        return scoped(def, { sql, nullable: false, closed: true, cost: costOf(def) });
      }
      case 'search': {
        const text = n.text.value.trim();
        if (!text) fail('empty search string', n.text);
        // One FTS5 phrase: the words must appear next to each other, in this order. Quoting the whole string
        // also makes FTS5 operators and punctuation in it literal.
        out.params.push(`"${text.replaceAll('"', '""')}"`);
        out.fts = true;
        return { sql: 'e.rid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)', nullable: false, closed: false, cost: 1 };
      }
      case 'compare': {
        const def = field(n.field, false);
        if (def.semi) return semiJoin(def, `${n.op === '==' ? '=' : n.op} ?`, [param(def, n.value)]);
        return scoped(def, compare(def, n.op, param(def, n.value)));
      }
      case 'in': {
        const def = field(n.field, false);
        const values = n.values.map((v) => param(def, v));
        if (def.semi) return semiJoin(def, `IN (${values.map(() => '?').join(', ')})`, values);
        if (def.type === 'json') {
          const parts = values.map((v) => compare(def, '==', v).sql);
          return scoped(def, { sql: `(${parts.join(' OR ')})`, nullable: true, closed: true, cost: 2 });
        }
        out.params.push(...values);
        return scoped(def, { sql: `${def.sql} IN (${values.map(() => '?').join(', ')})`, nullable: !def.notNull, closed: false, cost: costOf(def) });
      }
      case 'contains':
      case 'matches': {
        const def = field(n.field, false);
        if (def.type === 'bool') fail(`'${n.type}' needs a text field, but '${def.name}' is true or false`, n.field);
        const text = n.value.value;
        if (n.type === 'contains') {
          const pattern = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
          if (def.semi) return semiJoin(def, "LIKE ? ESCAPE '\\'", [pattern]);
          out.params.push(pattern);
          return scoped(def, { sql: `${def.sql} LIKE ? ESCAPE '\\'`, nullable: !def.notNull, closed: false, cost: 2 });
        }
        if (text.length > REGEX_MAX) fail(`regular expression longer than ${REGEX_MAX} characters`, n.value);
        if (NESTED_QUANTIFIER_RE.test(text)) fail('nested quantifiers such as (a+)+ can take exponential time; simplify the expression', n.value);
        try {
          new RegExp(text);
        } catch (err) {
          fail(`invalid regular expression: ${(err as Error).message.replace(/^Invalid regular expression: /, '')}`, n.value);
        }
        // `x REGEXP ?` is SQLite's spelling of regexp(?, x).
        if (def.semi) return semiJoin(def, 'REGEXP ?', [text]);
        out.params.push(text);
        return scoped(def, { sql: `regexp(?, ${def.sql})`, nullable: !def.notNull, closed: true, cost: 3 });
      }
    }
  }

  function compare(def: FieldDef, op: CmpOp, value: Param): Frag {
    const sqlOp = op === '==' ? '=' : op;
    out.params.push(value);
    let lhs = def.sql;
    // JSON values can be numbers or strings. A number compares against numeric values and
    // numeric-looking strings; a string compares against the value's text form. This keeps
    // `x > 5` from matching every string (SQLite sorts all text above all numbers).
    if (def.type === 'json') lhs = typeof value === 'number' ? numericOf(def.sql) : `CAST(${def.sql} AS TEXT)`;
    return { sql: `${lhs} ${sqlOp} ?`, nullable: !def.notNull, closed: false, cost: costOf(def) };
  }

  /** Convert a literal to the parameter for `def`, applying units, times and enum checks. */
  function param(def: FieldDef, v: Token): Param {
    const text = v.value;
    const n = v.type === 'number' ? { num: v.num!, unit: v.unit } : v.type === 'string' ? parseNumber(text) : null;
    const unit = n?.unit ? UNITS[n.unit] : undefined;
    const badUnit = !n && (def.type === 'duration' || def.type === 'time' || def.type === 'int') ? UNIT_TAIL_RE.exec(text) : null;
    if (badUnit) fail(`unknown unit '${badUnit[1]}'; use ${def.type === 'int' ? NUMBER_UNITS : DURATION_UNITS}`, v);
    switch (def.type) {
      case 'duration': {
        if (!n) return fail(`expected a duration for '${def.name}', such as 500ms or 2s`, v);
        if (unit && unit.dim !== 'duration') fail(`'${v.text}' is not a duration; use ${DURATION_UNITS}`, v);
        const us = unit ? n.num * unit.factor : n.num * 1000;
        return us / (def.scale ?? 1);
      }
      case 'time': {
        if (!n) return parseTime(text) ?? fail(`expected a time for '${def.name}', such as "2026-10-11 09:00", "2026-10-11T09:00+08:00" or -2h`, v);
        if (!unit) {
          // Epoch microseconds since 1973; smaller numbers are almost always milliseconds or seconds.
          if (n.num > 0 && n.num < 1e14) fail(`${text} looks like milliseconds or seconds; times are µs since the epoch, or use an ISO date such as "2026-10-11 09:00"`, v);
          return n.num;
        }
        if (unit.dim !== 'duration') fail(`'${v.text}' is not a time; use a relative time such as -2h`, v);
        if (!/^[+-]/.test(text)) fail(`relative times need a sign: -${text} means ${text} ago`, v);
        out.usesNow = true;
        return nowUs + n.num * unit.factor;
      }
      case 'int': {
        if (!n) return fail(`expected a number for '${def.name}'`, v);
        if (unit?.dim === 'duration') fail(`'${v.text}' is a duration, but '${def.name}' is a number`, v);
        return unit ? n.num * unit.factor : n.num;
      }
      case 'bool': {
        const t = text.toLowerCase();
        if (t === 'true' || t === 'false') return t === 'true' ? 1 : 0;
        if (n && !unit && (n.num === 0 || n.num === 1)) return n.num;
        return fail(`expected true or false for '${def.name}'`, v);
      }
      case 'json': {
        if (v.type === 'word' && /^(true|false)$/i.test(text)) return text.toLowerCase() === 'true' ? 1 : 0;
        if (v.type !== 'number') return text;
        if (unit?.dim === 'duration') fail(`'${def.name}' has no known unit; compare it with a plain number`, v);
        return unit ? n!.num * unit.factor : n!.num;
      }
      default: {
        const s = def.aliases?.[text] ?? text;
        if (def.values && !def.values.includes(s)) {
          const near = closest(s, def.values);
          warn(`unknown ${def.name} value '${s}'${near ? `; did you mean '${near}'?` : ''}`);
        }
        return s;
      }
    }
  }

  out.sql = compile(ast).sql;
  const top = ast.type === 'and' ? ast.items : [ast];
  out.spanDriven = top.some((n) => {
    if (n.type !== 'compare' && n.type !== 'in' && n.type !== 'contains' && n.type !== 'matches') return false;
    const r = resolveName(n.field.value, false);
    return 'def' in r && r.def.join === 'span';
  });
  return out;
}

const DURATION_UNITS = 'us, ms, s, m, min, h or d';
const NUMBER_UNITS = 'k, K, M, KB, MB or GB';
const UNIT_TAIL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)([A-Za-zµ]+)$/;

function numericOf(x: string): string {
  return `(CASE WHEN typeof(${x}) IN ('integer', 'real') THEN ${x} WHEN CAST(${x} AS NUMERIC) || '' = ${x} THEN CAST(${x} AS NUMERIC) END)`;
}

const TIME_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6})\d*)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * "2026-10-11", "2026-10-11 09:00", "2026-10-11T09:00:05.123456+02:00" → epoch µs.
 * Times without a zone are local time, date-only values included.
 */
export function parseTime(text: string): number | undefined {
  const m = TIME_RE.exec(text.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0));
  const frac = m[7] ? Number(m[7].padEnd(6, '0')) : 0;
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return undefined;
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return undefined;
  const zone = m[8]?.toUpperCase();
  let ms: number;
  if (zone) {
    const offMin = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
    ms = Date.UTC(y, mo - 1, d, h, mi, s) - offMin * 60_000;
  } else {
    ms = new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  return ms * 1000 + frac;
}
