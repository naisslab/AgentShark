// Coloring rules (SPEC §7.6) and a client-side evaluator for the part of the display-filter
// language that can be answered from an EventRow. The server checks rule syntax through
// /api/filter/validate; matching happens here so the event list can color rows without a round trip.
// Pure module: no DOM access.

export const LAYERS = ['session', 'user', 'llm', 'tool', 'agent', 'context', 'turn', 'hook', 'permission', 'harness', 'raw'];

export const FLAGS = ['error', 'inherited', 'dup', 'orphan', 'inferred', 'truncated', 'abandoned', 'meta', 'sidechain'];

/** Event flags as one letter in the Events gutter, most important first: [flag, letter, meaning]. */
export const FLAG_GLYPHS = [
  ['error', '!', 'Error'],
  ['orphan', 'O', 'Orphan: a result without its call'],
  ['abandoned', 'A', 'Abandoned: a call that never got a result'],
  ['truncated', 'T', 'Truncated: the agent cut this record short'],
  ['inferred', 'I', 'Inferred: AgentShark derived the timing or pairing'],
  ['sidechain', 'S', 'Sidechain: a subagent or side-branch record'],
  ['inherited', 'H', 'Inherited from a parent or resumed session'],
  ['dup', 'D', 'Duplicate of another record'],
  ['meta', 'M', 'Metadata record'],
];

/** Event kinds with short descriptions (mirrors src/model/kinds.ts, which the browser cannot import). */
export const EVENT_KINDS = {
  'session.meta': 'Session metadata',
  'session.state': 'Session state change',
  'user.prompt': 'Prompt typed by a human',
  'user.inject': 'Harness-injected user-role content',
  'llm.text': 'Assistant text output',
  'llm.thinking': 'Assistant thinking or reasoning block',
  'llm.usage': 'Token usage report',
  'llm.error': 'Model API error or retry',
  'llm.refusal': 'Model refusal',
  'tool.call': 'Tool invocation',
  'tool.result': 'Tool result',
  'tool.exec': 'Execution item nested in a tool call',
  'agent.spawn': 'Subagent launch',
  'agent.message': 'Message between agents',
  'agent.status': 'Subagent status or completion',
  'context.attachment': 'Context injected by the harness',
  'context.compaction': 'Context compaction',
  'context.snapshot': 'System prompt or tool list snapshot',
  'turn.start': 'Start of a turn',
  'turn.end': 'End of a turn',
  'turn.abort': 'Turn aborted or interrupted',
  'hook.run': 'Hook execution',
  'permission.request': 'Permission requested',
  'permission.decision': 'Permission decision',
  'harness.queue': 'Prompt queue operation',
  'harness.ratelimit': 'Rate-limit status',
  'harness.status': 'Harness status change',
  'harness.file': 'File-history snapshot',
  'harness.vcs': 'Version-control link',
  'harness.other': 'Other harness record',
  'raw.unknown': 'Record type AgentShark does not decode',
};

// Tool kind mapping, mirrored from toolKind() in src/adapters/adapter.ts because EventRow carries
// only the tool name.
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'exec_command', 'write_stdin', 'shell_command', 'shell', 'local_shell', 'mcp__workspace__bash']);
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS', 'apply_patch', 'view_image']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch', 'web_search', 'web_search_call', 'mcp__workspace__web_fetch']);
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'SendMessage', 'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'interrupt_agent', 'close_agent', 'send_input', 'wait']);
const PLAN_TOOLS = new Set(['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput', 'update_plan', 'ExitPlanMode', 'EnterPlanMode']);

export function toolKindOf(name) {
  if (!name) return null;
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (WEB_TOOLS.has(name)) return 'web';
  if (name.startsWith('mcp__')) return 'mcp';
  if (FILE_TOOLS.has(name)) return 'file';
  if (AGENT_TOOLS.has(name)) return 'agent';
  if (PLAN_TOOLS.has(name)) return 'plan';
  if (name === 'exec') return 'custom';
  return 'other';
}

/** Filter fields answerable from an EventRow. */
const ROW_FIELDS = {
  kind: (r) => r.kind,
  proto: (r) => r.proto,
  actor: (r) => r.actor,
  ts: (r) => r.ts,
  seq: (r) => r.seq,
  dur: (r) => r.dur,
  'tool.duration': (r) => r.dur,
  'span.duration': (r) => r.dur,
  summary: (r) => r.summary,
  session: (r) => r.session,
  'session.id': (r) => r.session,
  agent: (r) => r.agent,
  'session.agent': (r) => r.agent,
  'tool.name': (r) => r.toolName,
  'tool.kind': (r) => toolKindOf(r.toolName),
  'llm.model': (r) => r.model,
  model: (r) => r.model,
  'tokens.input': (r) => r.tokIn,
  'tokens.output': (r) => r.tokOut,
  turn: (r) => r.turn,
  'turn.id': (r) => r.turn,
  // Derived fields (SPEC §12.3.1) are known only when a rows request asked for them as columns; the
  // Events workspace asks for failure.tier with its Tier column. Otherwise the server colors the row.
  'failure.tier': (r) => r.extra?.['failure.tier'] ?? undefined,
  failure: (r) => (r.extra && 'failure.tier' in r.extra ? r.extra['failure.tier'] === 'failure' : undefined),
};

const UNIT_SCALE = {
  us: 1, ms: 1e3, s: 1e6, m: 60e6, min: 60e6, h: 3.6e9, d: 86.4e9,
  k: 1e3, K: 1e3, M: 1e6, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3,
};

const COMPARE_WORDS = { eq: '==', ne: '!=', gt: '>', ge: '>=', lt: '<', le: '<=' };

export class FilterSyntaxError extends Error {
  constructor(message, start, end) {
    super(message);
    this.start = start;
    this.end = end;
  }
}

// ---------------------------------------------------------------------------
// Lexer

function lex(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const s = i;
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      out.push({ t: two, s, e: (i += 2) });
    } else if ('()<>{},!~'.includes(ch)) {
      out.push({ t: ch, s, e: ++i });
    } else if (ch === '"' || ch === "'") {
      let v = '';
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const nx = src[i + 1];
          v += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
          i += 2;
        } else {
          v += src[i++];
        }
      }
      if (i >= src.length) throw new FilterSyntaxError('Unterminated string', s, src.length);
      out.push({ t: 'str', v, s, e: ++i });
    } else {
      const num = /^-?\d+(?:\.\d+)?(us|ms|min|s|m|h|d|KB|MB|GB|k|K|M)?(?![\w.])/.exec(src.slice(i));
      if (num) {
        const unit = num[1];
        const base = parseFloat(unit ? num[0].slice(0, -unit.length) : num[0]);
        out.push({ t: 'num', v: base * (unit ? UNIT_SCALE[unit] : 1), unit, s, e: (i += num[0].length) });
        continue;
      }
      const word = /^[A-Za-z_$][\w.\-$]*/.exec(src.slice(i));
      if (!word) throw new FilterSyntaxError(`Unexpected character "${ch}"`, s, s + 1);
      out.push({ t: 'word', v: word[0], s, e: (i += word[0].length) });
    }
  }
  out.push({ t: 'eof', s: src.length, e: src.length });
  return out;
}

// ---------------------------------------------------------------------------
// Parser → predicate closures

/**
 * Compile a display filter into a predicate over EventRow objects.
 * Returns { test(row, nowUs?) → boolean, unsupported: string[] }. `unsupported` lists fields that
 * an EventRow cannot answer (e.g. native.*); those terms evaluate to false.
 * Throws FilterSyntaxError with character positions on a syntax error.
 */
export function compileFilter(src) {
  const toks = lex(src ?? '');
  let k = 0;
  const unsupported = new Set();
  const peek = () => toks[k];
  const isWord = (tok, ...words) => tok.t === 'word' && words.includes(tok.v.toLowerCase());
  const expect = (t) => {
    const tok = toks[k];
    if (tok.t !== t) throw new FilterSyntaxError(`Expected "${t}"`, tok.s, Math.max(tok.e, tok.s + 1));
    k++;
    return tok;
  };

  const parseOr = () => {
    let left = parseAnd();
    while (peek().t === '||' || isWord(peek(), 'or')) {
      k++;
      const a = left;
      const b = parseAnd();
      left = (r, now) => a(r, now) || b(r, now);
    }
    return left;
  };
  const parseAnd = () => {
    let left = parseUnary();
    while (peek().t === '&&' || isWord(peek(), 'and')) {
      k++;
      const a = left;
      const b = parseUnary();
      left = (r, now) => a(r, now) && b(r, now);
    }
    return left;
  };
  const parseUnary = () => {
    if (peek().t === '!' || isWord(peek(), 'not')) {
      k++;
      const x = parseUnary();
      return (r, now) => !x(r, now);
    }
    return parsePrimary();
  };
  const parseValue = () => {
    const tok = toks[k];
    if (tok.t === 'str' || tok.t === 'num') {
      k++;
      return tok;
    }
    if (tok.t === 'word') {
      k++;
      const low = tok.v.toLowerCase();
      if (low === 'true' || low === 'false') return { t: 'bool', v: low === 'true' };
      return { t: 'str', v: tok.v };
    }
    throw new FilterSyntaxError('Expected a value', tok.s, Math.max(tok.e, tok.s + 1));
  };
  const parsePrimary = () => {
    const tok = peek();
    if (tok.t === '(') {
      k++;
      const x = parseOr();
      expect(')');
      return x;
    }
    if (tok.t === 'str') {
      k++;
      const needle = tok.v.toLowerCase();
      return (r) => typeof r.summary === 'string' && r.summary.toLowerCase().includes(needle);
    }
    if (tok.t !== 'word') {
      throw new FilterSyntaxError(tok.t === 'eof' ? 'Unexpected end of filter' : `Unexpected "${tok.t}"`, tok.s, Math.max(tok.e, tok.s + 1));
    }
    k++;
    const name = tok.v;
    const next = peek();
    const nextWord = next.t === 'word' ? next.v.toLowerCase() : '';
    const op = ['==', '!=', '>', '>=', '<', '<=', '~'].includes(next.t)
      ? next.t
      : COMPARE_WORDS[nextWord] ?? (['in', 'contains', 'matches'].includes(nextWord) ? nextWord : null);
    if (!op) return bareTerm(name);

    k++;
    const get = fieldGetter(name);
    if (op === 'in') {
      expect('{');
      const values = [parseValue()];
      while (peek().t === ',') {
        k++;
        values.push(parseValue());
      }
      expect('}');
      return (r, now) => values.some((v) => compare(get(r), '==', v, name, now));
    }
    if (op === 'contains') {
      const needle = String(parseValue().v).toLowerCase();
      return (r) => {
        const x = get(r);
        return x != null && String(x).toLowerCase().includes(needle);
      };
    }
    if (op === 'matches' || op === '~') {
      const vtok = toks[k];
      const pattern = String(parseValue().v);
      let re;
      try {
        re = pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'i') : new RegExp(pattern);
      } catch (err) {
        throw new FilterSyntaxError(`Invalid regular expression: ${err.message}`, vtok.s, vtok.e);
      }
      return (r) => {
        const x = get(r);
        return x != null && re.test(String(x));
      };
    }
    const value = parseValue();
    return (r, now) => compare(get(r), op, value, name, now);
  };

  const fieldGetter = (name) => {
    const g = ROW_FIELDS[name];
    if (g) return g;
    unsupported.add(name);
    return () => undefined;
  };

  // A bare word is a flag, a layer, a full kind name, or a field truth test, in that order.
  const bareTerm = (name) => {
    if (FLAGS.includes(name)) return (r) => Array.isArray(r.flags) && r.flags.includes(name);
    if (LAYERS.includes(name)) {
      const prefix = name + '.';
      return (r) => typeof r.kind === 'string' && r.kind.startsWith(prefix);
    }
    if (name in EVENT_KINDS) return (r) => r.kind === name;
    const get = fieldGetter(name);
    return (r) => {
      const v = get(r);
      return v != null && v !== false && v !== 0 && v !== '';
    };
  };

  if (peek().t === 'eof') return { test: () => true, unsupported: [] };
  const test = parseOr();
  const rest = peek();
  if (rest.t !== 'eof') throw new FilterSyntaxError(`Unexpected "${rest.v ?? rest.t}"`, rest.s, Math.max(rest.e, rest.s + 1));
  return {
    test: (row, now = Date.now() * 1000) => test(row, now),
    unsupported: [...unsupported],
  };
}

function compare(actual, op, value, field, now) {
  if (actual == null) return false;
  let expected = value.v;
  if (field === 'ts') {
    if (value.t === 'str') {
      const ms = Date.parse(String(value.v).replace(' ', 'T'));
      if (Number.isNaN(ms)) return false;
      expected = ms * 1000;
    } else if (value.t === 'num' && value.unit && value.v < 0) {
      expected = now + value.v;
    }
  }
  if (typeof actual === 'number' && typeof expected === 'number') {
    switch (op) {
      case '==': return actual === expected;
      case '!=': return actual !== expected;
      case '>': return actual > expected;
      case '>=': return actual >= expected;
      case '<': return actual < expected;
      case '<=': return actual <= expected;
    }
  }
  if (value.t === 'bool') {
    const truthy = Boolean(actual);
    return op === '!=' ? truthy !== expected : op === '==' ? truthy === expected : false;
  }
  const a = String(actual);
  const b = String(expected);
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rules

/** Colors a rule may use: theme tokens (adapt to dark mode) or a custom #rrggbb. */
export const PALETTE = [
  { label: 'Red', value: 'var(--err)' },
  { label: 'Green', value: 'var(--c-user)' },
  { label: 'Blue', value: 'var(--c-llm)' },
  { label: 'Violet', value: 'var(--c-thinking)' },
  { label: 'Amber', value: 'var(--c-tool-shell)' },
  { label: 'Sand', value: 'var(--c-tool-file)' },
  { label: 'Cyan', value: 'var(--c-tool-web)' },
  { label: 'Teal', value: 'var(--c-tool-mcp)' },
  { label: 'Purple', value: 'var(--c-agent)' },
  { label: 'Orange', value: 'var(--c-compaction)' },
  { label: 'Slate', value: 'var(--c-hook)' },
  { label: 'Grey', value: 'var(--c-context)' },
  { label: 'Olive', value: 'var(--c-raw)' },
  { label: 'Faint text', value: 'var(--fg-faint)' },
];

/**
 * Failure tiers come first (WEB-CONTRACT "Default coloring rules"): a red fill for `failure`, a dashed red
 * outline for suspect rows, an amber outline for benign and deferred rows. Stable ids, so a stored rule list
 * can gain them once (withTierDefaults).
 */
export const TIER_RULES = [
  { id: 'f0', name: 'Failures', filter: 'failure', fg: null, bg: 'var(--tier-failure)', outline: null, outlineStyle: null, enabled: true },
  { id: 'f1', name: 'Suspect failures', filter: 'failure.tier == "suspect"', fg: null, bg: null, outline: 'var(--tier-suspect)', outlineStyle: 'dashed', enabled: true },
  { id: 'f2', name: 'Benign and deferred', filter: 'failure.tier in {"benign", "deferred"}', fg: null, bg: null, outline: 'var(--tier-benign)', outlineStyle: 'solid', enabled: true },
];

// Errors use the text color only, so the row stays readable and the error cue survives selection;
// the other rules give a light wash and a leading color bar.
const BASE_RULES = [
  { name: 'Errors', filter: 'error', fg: 'var(--err)', bg: null },
  { name: 'User prompts', filter: 'user.prompt', fg: null, bg: 'var(--c-user)' },
  { name: 'Thinking', filter: 'llm.thinking', fg: null, bg: 'var(--c-thinking)' },
  { name: 'Model output', filter: 'llm', fg: null, bg: 'var(--c-llm)' },
  { name: 'Shell tools', filter: 'tool.kind == "shell"', fg: null, bg: 'var(--c-tool-shell)' },
  { name: 'File tools', filter: 'tool.kind == "file"', fg: null, bg: 'var(--c-tool-file)' },
  { name: 'Web tools', filter: 'tool.kind == "web"', fg: null, bg: 'var(--c-tool-web)' },
  { name: 'MCP tools', filter: 'tool.kind == "mcp"', fg: null, bg: 'var(--c-tool-mcp)' },
  { name: 'Agents', filter: 'agent || tool.kind == "agent"', fg: null, bg: 'var(--c-agent)' },
  { name: 'Compaction', filter: 'context.compaction', fg: null, bg: 'var(--c-compaction)' },
  { name: 'Hooks', filter: 'hook', fg: null, bg: 'var(--c-hook)' },
  { name: 'Inherited or duplicate', filter: 'inherited || dup', fg: 'var(--fg-faint)', bg: null },
].map((r, i) => ({ id: `d${i}`, ...r, outline: null, outlineStyle: null, enabled: true }));

export const DEFAULT_RULES = [...TIER_RULES, ...BASE_RULES];

/**
 * Whether a rule is one of the tier rules: those color a row only through its bar and wash, never its text, even when
 * a stored list from an older build gives them a foreground (§5.2 item 1; the Tier cell carries the word's color).
 */
export const isTierRule = (rule) => TIER_RULES.some((t) => t.filter.replace(/\s+/g, '') === String(rule?.filter ?? '').replace(/\s+/g, ''));

/** A stored rule list from before the tier rules gains the ones it lacks, in front, once. */
export function withTierDefaults(rules) {
  const have = new Set(rules.map((r) => r.filter.replace(/\s+/g, '')));
  const taken = new Set(rules.map((r) => r.id));
  const add = [];
  for (const r of TIER_RULES) {
    if (have.has(r.filter.replace(/\s+/g, ''))) continue;
    const id = taken.has(r.id) ? newRuleId(taken) : r.id;
    taken.add(id);
    add.push({ ...r, id });
  }
  return [...add, ...rules];
}

const OUTLINE_STYLES = ['solid', 'dashed', 'dotted'];

const COLOR_RE = /^(#[0-9a-fA-F]{6}|var\(--[a-z0-9-]+\))$/;

function cleanColor(c) {
  return typeof c === 'string' && COLOR_RE.test(c) ? c : null;
}

const ID_RE = /^[\w-]{1,32}$/;

/** A rule id unique within `taken`. */
export function newRuleId(taken = new Set()) {
  for (let i = 1; ; i++) if (!taken.has(`r${i}`)) return `r${i}`;
}

/** Validate stored rules; anything malformed falls back to the defaults. Every rule gets a unique id. */
export function normalizeRules(value) {
  if (!Array.isArray(value)) return DEFAULT_RULES.map((r) => ({ ...r }));
  const out = [];
  const taken = new Set();
  for (const r of value) {
    if (!r || typeof r.filter !== 'string') continue;
    const id = typeof r.id === 'string' && ID_RE.test(r.id) && !taken.has(r.id) ? r.id : newRuleId(taken);
    taken.add(id);
    out.push({
      id,
      name: typeof r.name === 'string' ? r.name : r.filter,
      filter: r.filter,
      fg: cleanColor(r.fg),
      bg: cleanColor(r.bg),
      outline: cleanColor(r.outline),
      outlineStyle: OUTLINE_STYLES.includes(r.outlineStyle) ? r.outlineStyle : null,
      enabled: r.enabled !== false,
    });
  }
  return out;
}

/** First enabled rule whose filter matches wins. Rules that fail to compile never match. */
export function createColorizer(rules) {
  const compiled = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    try {
      compiled.push({ rule, test: compileFilter(rule.filter).test });
    } catch {
      // A broken rule is reported in the rule editor; here it simply never matches.
    }
  }
  return {
    ruleFor(row) {
      if (!row) return null;
      const now = Date.now() * 1000;
      for (const c of compiled) if (c.test(row, now)) return c.rule;
      return null;
    },
  };
}

/** The `colorRules` field of POST /api/views: enabled rules with a filter, in order. */
export function serverRules(rules) {
  return rules.filter((r) => r.enabled !== false && r.filter.trim()).map((r) => ({ id: r.id, filter: r.filter }));
}
