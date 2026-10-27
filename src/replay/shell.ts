// Reading a shell script for the programs it starts (docs/REPLAY.md §4.1), so that the preflight check can ask the
// image for each. The scanner follows bash's grammar as far as finding command names needs: quotes, expansions,
// command and process substitution, arithmetic, here-documents and here-strings, compound commands, case patterns and
// function definitions. It never runs anything.

/** A name `command -v` can look up: no path, variable or expansion, and not only digits. */
const NAME = /^(?!\d+$)[\w][\w.+-]*$/;
/** Reserved words after which the next word is a command. */
const PREFIX = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time']);
/** Reserved words that end a compound command; redirections may follow them. */
const END = new Set(['}', 'fi', 'done', 'esac']);
const REDIRECT = /^(?:\d+|\{\w+\})?(<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/;
const ASSIGNMENT = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/;

/** The program names at command positions of a shell script, in order of first use, less the functions it defines. */
export function programsOf(script: string): string[] {
  const scan = new Scan(script);
  try {
    scan.list(null);
  } catch (e) {
    // Nesting deeper than the stack, or input that would keep the scanner from advancing: keep the names found so far.
    if (!(e instanceof RangeError || e instanceof OutOfSteps)) throw e;
  }
  return [...scan.names].filter((n) => !scan.defined.has(n));
}

/** The scanner read far more words than the script can hold; a defect would otherwise hang the preflight. */
class OutOfSteps extends Error {}

/** What ends a list of commands: a subshell's or `$(`'s parenthesis, a closing backquote, or the end of the script. */
type Closer = ')' | '`' | null;

interface Word {
  /** The text with quotes and escapes removed. */
  text: string;
  /** Nothing in the word expands. */
  literal: boolean;
  /** The word is `NAME=value`. */
  assign: boolean;
}

class Scan {
  readonly names = new Set<string>();
  readonly defined = new Set<string>();
  private readonly s: string;
  private i = 0;
  /** Here-documents whose bodies start after the next newline; an unquoted delimiter lets the body expand. */
  private heredocs: { delim: string; tabs: boolean; quoted: boolean }[] = [];
  /** Open `case` commands, and whether a pattern comes next. */
  private cases = 0;
  private pattern = false;
  /** The closers of the lists being read, innermost last: inside backquotes, a backquote ends the word and the list. */
  private readonly closers: Closer[] = [];
  /** Words left to read: a few per character of the script is far more than any script needs. */
  private steps: number;
  /** Names added to `names` or `defined`, in order, so that a failed probe can take back its own. */
  private readonly journal: [Set<string>, string][] = [];

  constructor(s: string) {
    this.s = s;
    this.steps = 4 * s.length + 64;
  }

  /** Commands up to `close`, which is consumed, or to the end of the script. */
  list(close: Closer): void {
    // A substitution is a script of its own: a case around it does not reach into it.
    // Its here-documents too: a body is read after a newline of the list that holds the redirection.
    const outer = { cases: this.cases, pattern: this.pattern, heredocs: this.heredocs };
    this.cases = 0;
    this.pattern = false;
    this.heredocs = [];
    this.closers.push(close);
    try {
      while (this.i < this.s.length) {
        this.gap();
        const c = this.s[this.i];
        if (c === undefined) return;
        if (c === close) {
          this.i++;
          return;
        }
        const at = this.i;
        this.command(close);
        if (this.i === at) this.i++; // a stray `)`
      }
    } finally {
      this.closers.pop();
      // A body the substitution did not reach starts after the next newline outside it.
      ({ cases: this.cases, pattern: this.pattern } = outer);
      this.heredocs = [...outer.heredocs, ...this.heredocs];
    }
  }

  /** One command: assignments, redirections and reserved words, then its name, its words and its redirections. */
  private command(close: Closer): void {
    const s = this.s;
    if (this.pattern) return this.casePattern();
    let afterTime = false;
    for (;;) {
      this.blanks();
      if (this.atEnd(close)) return;
      if (s[this.i] === '#') return this.comment();
      if (this.redirect()) continue;
      // `!(...)` here negates a subshell; elsewhere it is an extended glob.
      if (s[this.i] === '!' && s[this.i + 1] === '(') {
        this.i++;
        continue;
      }
      if (s[this.i] === '(') {
        this.i++;
        // `((` is arithmetic, unless what follows does not close as arithmetic: then it is two subshells.
        const at = this.i;
        if (s[this.i] !== '(' || (this.i++, !this.probeArithmetic())) {
          this.i = at;
          this.list(')');
        }
        return this.rest(close);
      }
      const start = this.i;
      const w = this.word();
      if (this.i === start) return;
      const t = w.text;
      if (w.assign || (afterTime && t.startsWith('-'))) continue;
      if (!w.literal) return this.rest(close);
      afterTime = t === 'time';
      if (PREFIX.has(t)) continue;
      if (END.has(t)) {
        if (t === 'esac') this.cases = Math.max(0, this.cases - 1);
        return this.rest(close);
      }
      if (t === 'for' || t === 'select') return this.forHead(close);
      if (t === 'case') return this.caseHead();
      if (t === '[[') return this.test(close);
      if (t === 'coproc') {
        // `coproc NAME {...}` and `coproc NAME (...)` name the coprocess; otherwise the next word is the command.
        this.blanks();
        if (s[this.i] === '(') continue;
        const name = this.word();
        if (name.text === '{' && name.literal) continue;
        this.blanks();
        if (name.literal && (s[this.i] === '(' || (s[this.i] === '{' && /\s/.test(s[this.i + 1] ?? '')))) continue;
        if (name.literal && NAME.test(name.text)) this.record(this.names, name.text);
        return this.rest(close);
      }
      if (t === 'function') {
        this.blanks();
        const name = this.word();
        if (name.literal) this.record(this.defined, name.text);
        this.parens();
        continue;
      }
      // `name ()` defines a function; its body follows as the next command.
      if (this.parens()) {
        this.record(this.defined, t);
        return;
      }
      if (NAME.test(t)) this.record(this.names, t);
      return this.rest(close);
    }
  }

  /** The words and redirections after a command's name, up to the operator that ends the command. */
  private rest(close: Closer): void {
    for (;;) {
      this.blanks();
      if (this.atEnd(close)) return;
      if (this.s[this.i] === '#') return this.comment();
      if (this.redirect()) continue;
      const start = this.i;
      this.word();
      if (this.i === start) this.i++; // a `(` where bash would report a syntax error
    }
  }

  /** One word. Substitutions inside it are scanned for their own commands. */
  private word(): Word {
    if (--this.steps < 0) throw new OutOfSteps();
    const s = this.s;
    const start = this.i;
    let text = '';
    let literal = true;
    if ((s[this.i] === '<' || s[this.i] === '>') && s[this.i + 1] === '(') {
      // Process substitution: `<(...)` or `>(...)`.
      this.i += 2;
      this.list(')');
      literal = false;
    }
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') {
        if (s[this.i + 1] !== '\n') text += s[this.i + 1] ?? '';
        this.i += 2;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        text += s.slice(this.i + 1, end < 0 ? s.length : end);
        this.i = end < 0 ? s.length : end + 1;
      } else if (c === '"') {
        this.i++;
        const q = this.doubleQuoted();
        text += q.text;
        literal &&= q.literal;
      } else if (c === '`' && this.closers.at(-1) === '`') break;
      else if (c === '$' && s[this.i + 1] === "'") {
        // ANSI-C quoting is literal text: a backslash escapes the next character, a quote included.
        for (this.i += 2; this.i < s.length && s[this.i] !== "'"; this.i++) {
          if (s[this.i] === '\\') this.i++;
          text += s[this.i] ?? '';
        }
        this.i++;
      } else if ('!@+*?'.includes(c) && s[this.i + 1] === '(') {
        // An extended glob such as `!(a|b)`: its alternatives are part of the word.
        const end = this.closing(this.i + 2);
        text += s.slice(this.i, end);
        this.i = end;
      } else if (c === '$' || c === '`') {
        this.expansion(false);
        literal = false;
      } else if (c === '(' && ASSIGNMENT.test(s.slice(start, this.i)) && s[this.i - 1] === '=') {
        this.i++;
        this.array();
        literal = false;
      } else if (/[\s;&|<>()]/.test(c)) break;
      else {
        text += c;
        this.i++;
      }
    }
    return { text, literal, assign: ASSIGNMENT.test(s.slice(start, this.i)) };
  }

  /** The inside of a double-quoted string, after its opening quote. */
  private doubleQuoted(): { text: string; literal: boolean } {
    const s = this.s;
    let text = '';
    let literal = true;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '"') {
        this.i++;
        break;
      }
      if (c === '`' && this.closers.at(-1) === '`') break;
      if (c === '\\') {
        const n = s[this.i + 1] ?? '';
        text += n === '\n' ? '' : '"\\$`'.includes(n) ? n : c + n;
        this.i += 2;
      } else if (c === '$' || c === '`') {
        this.expansion(true);
        literal = false;
      } else {
        text += c;
        this.i++;
      }
    }
    return { text, literal };
  }

  /** An expansion at `$` or a backquote. Substitutions are scanned for their commands; the rest is skipped. */
  private expansion(quoted: boolean): void {
    const s = this.s;
    if (s[this.i] === '`') {
      this.i++;
      return this.list('`');
    }
    this.i++;
    const c = s[this.i];
    if (c === '(') {
      this.i++;
      // `$((` is arithmetic, unless what follows does not close as arithmetic: then it is `$(` and a subshell.
      const at = this.i;
      if (s[this.i] !== '(' || (this.i++, !this.probeArithmetic())) {
        this.i = at;
        this.list(')');
      }
    } else if (c === '{') {
      this.i++;
      this.braced();
    } else if (c === "'" && !quoted) {
      // ANSI-C quoting: a backslash escapes the next character, a quote included.
      for (this.i++; this.i < s.length && s[this.i] !== "'"; this.i++) if (s[this.i] === '\\') this.i++;
      this.i++;
    } else if (c === '"' && !quoted) {
      this.i++;
      this.doubleQuoted();
    } else if (c === '[') {
      const end = s.indexOf(']', this.i);
      this.i = end < 0 ? s.length : end + 1;
    } else if (c !== undefined && /\w/.test(c)) {
      while (this.i < s.length && /\w/.test(s[this.i])) this.i++;
    } else if (c !== undefined && /[?$#@*!-]/.test(c)) this.i++;
  }

  /** The inside of `${...}`, after its opening brace. */
  private braced(): void {
    const s = this.s;
    let depth = 0;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') this.i += 2;
      else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        this.i = end < 0 ? s.length : end + 1;
      } else if (c === '"') {
        this.i++;
        this.doubleQuoted();
      } else if (c === '$' || c === '`') this.expansion(false);
      else {
        this.i++;
        if (c === '{') depth++;
        else if (c === '}' && depth-- === 0) return;
      }
    }
  }

  private record(set: Set<string>, name: string): void {
    if (set.has(name)) return;
    set.add(name);
    this.journal.push([set, name]);
  }

  /** `arithmetic()`, taking back what it recorded when the text turns out not to be arithmetic. */
  private probeArithmetic(): boolean {
    const mark = this.journal.length;
    const heredocs = this.heredocs.length;
    if (this.arithmetic()) return true;
    for (const [set, name] of this.journal.splice(mark)) set.delete(name);
    this.heredocs.length = Math.min(this.heredocs.length, heredocs);
    return false;
  }

  /**
   * The inside of `((...))` or `$((...))`, after its opening parentheses; substitutions in it are scanned. False, with
   * the position left anywhere, when a `)` closes it alone: bash then reads the text as nested subshells instead.
   */
  private arithmetic(): boolean {
    const s = this.s;
    let depth = 0;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') this.i += 2;
      else if (c === '$' || c === '`') this.expansion(false);
      else if (c === '"') {
        this.i++;
        this.doubleQuoted();
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        this.i = end < 0 ? s.length : end + 1;
      } else {
        this.i++;
        if (c === '(') depth++;
        else if (c === ')') {
          if (depth > 0) depth--;
          else if (s[this.i] === ')') {
            this.i++;
            return true;
          } else return false;
        }
      }
    }
    return false;
  }

  /** The position after the `)` that closes a parenthesis opened before `from`, past nested ones and quotes. */
  private closing(from: number): number {
    const s = this.s;
    let depth = 0;
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === "'" || c === '"') {
        const end = s.indexOf(c, i + 1);
        i = end < 0 ? s.length : end;
      } else if (c === '(') depth++;
      else if (c === ')' && depth-- === 0) return i + 1;
    }
    return s.length;
  }

  /** The values of `name=(...)`, after the opening parenthesis. */
  private array(): void {
    while (this.i < this.s.length) {
      this.blanks();
      const c = this.s[this.i];
      if (c === ')') {
        this.i++;
        return;
      }
      if (c === '\n') this.newline();
      else if (c === '#') this.comment();
      else {
        const start = this.i;
        this.word();
        if (this.i === start) this.i++;
      }
    }
  }

  /** The words of `[[ ... ]]`, after its opening word. They name no commands, though substitutions in them run. */
  private test(close: Closer): void {
    const s = this.s;
    while (this.i < s.length) {
      this.blanks();
      if (s.startsWith(']]', this.i) && /^[\s;&|)`]?$/.test(s[this.i + 2] ?? '')) {
        this.i += 2;
        return this.rest(close);
      }
      const c = s[this.i];
      const substitution = (c === '<' || c === '>') && s[this.i + 1] === '(';
      if (c === '\n') this.newline();
      else if (!substitution && '()<>&|!'.includes(c)) this.i++;
      else {
        const start = this.i;
        this.word();
        if (this.i === start) this.i++;
      }
    }
  }

  /** `for NAME [in WORDS]` or `for ((...))`, up to the `do` that follows. */
  private forHead(close: Closer): void {
    this.blanks();
    if (this.s.startsWith('((', this.i)) {
      this.i += 2;
      this.arithmetic();
      return;
    }
    this.word();
    this.blanks();
    if (/^in(?=[\s;]|$)/.test(this.s.slice(this.i, this.i + 3))) {
      this.i += 2;
      this.rest(close);
    }
  }

  /** `case WORD in`; a pattern comes next. */
  private caseHead(): void {
    this.blanks();
    this.word();
    for (let c = this.s[this.i]; c !== undefined && /\s/.test(c); c = this.s[this.i]) {
      if (c === '\n') this.newline();
      else this.i++;
    }
    if (/^in(?=[\s;]|$)/.test(this.s.slice(this.i, this.i + 3))) this.i += 2;
    this.cases++;
    this.pattern = true;
  }

  /** A case pattern up to its `)`, or the `esac` that ends the case. */
  private casePattern(): void {
    const s = this.s;
    this.pattern = false;
    this.blanks();
    if (/^esac(?=[\s;&|)`]|$)/.test(s.slice(this.i, this.i + 5))) {
      this.i += 4;
      this.cases = Math.max(0, this.cases - 1);
      return;
    }
    if (s[this.i] === '(') this.i++;
    let depth = 0;
    while (this.i < s.length) {
      const c = s[this.i];
      // A backquote that ends the list ends the pattern too; the list closes it.
      if (c === '`' && this.closers.at(-1) === '`') return;
      if (c === '\\') this.i += 2;
      else if (c === '\n') this.newline();
      else if (c === "'" || c === '"' || c === '$' || c === '`') {
        const at = this.i;
        this.word();
        if (this.i === at) this.i++;
      } else {
        this.i++;
        if (c === '(') depth++;
        else if (c === ')' && depth-- === 0) return;
      }
    }
  }

  /** A redirection and its target. A here-document's body is skipped after the next newline. */
  private redirect(): boolean {
    const m = REDIRECT.exec(this.s.slice(this.i, this.i + 16));
    if (!m || ((m[1] === '<' || m[1] === '>') && this.s[this.i + m[0].length] === '(')) return false;
    this.i += m[0].length;
    this.blanks();
    const at = this.i;
    const target = this.word();
    if (m[1] === '<<' || m[1] === '<<-') {
      this.heredocs.push({ delim: target.text, tabs: m[1] === '<<-', quoted: /['"\\]/.test(this.s.slice(at, this.i)) });
    }
    return true;
  }

  /** `()` after a function's name; whether it was there. */
  private parens(): boolean {
    const m = /^[ \t]*\([ \t]*\)/.exec(this.s.slice(this.i, this.i + 64));
    if (m) this.i += m[0].length;
    return m !== null;
  }

  /** Blanks, comments, newlines with the here-document bodies they start, and the operators between commands. */
  private gap(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      const next = s[this.i + 1];
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '\\' && next === '\n') this.i += 2;
      else if (c === '#') this.comment();
      else if (c === '\n') this.newline();
      else if (c === ';') {
        // `;;`, `;&` and `;;&` end a case clause, and a pattern follows.
        const clause = next === ';' || next === '&';
        if (clause && this.cases) this.pattern = true;
        this.i += s.startsWith(';;&', this.i) ? 3 : clause ? 2 : 1;
      } else if (c === '&' && next !== '>') this.i += next === '&' ? 2 : 1;
      else if (c === '|') this.i += next === '|' || next === '&' ? 2 : 1;
      else return;
    }
  }

  /** Spaces, tabs and escaped newlines. */
  private blanks(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '\\' && this.s[this.i + 1] === '\n') this.i += 2;
      else return;
    }
  }

  /** A newline, and the bodies of the here-documents it starts. */
  private newline(): void {
    this.i++;
    this.bodies();
  }

  private comment(): void {
    while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
  }

  /**
   * Reads the bodies of pending here-documents, each up to the line that is exactly its delimiter. A body whose
   * delimiter was not quoted expands as a double-quoted string does, so its substitutions are scanned.
   */
  private bodies(): void {
    const s = this.s;
    for (const h of this.heredocs.splice(0)) {
      while (this.i < s.length) {
        const end = s.indexOf('\n', this.i);
        let line = s.slice(this.i, end < 0 ? s.length : end).replace(/\r$/, '');
        if (h.tabs) line = line.replace(/^\t+/, '');
        if (line === h.delim || h.quoted) {
          this.i = end < 0 ? s.length : end + 1;
          if (line === h.delim) break;
          continue;
        }
        while (this.i < s.length && s[this.i] !== '\n') {
          const c = s[this.i];
          if (c === '\\') this.i += 2;
          else if (c === '$' || c === '`') this.expansion(true);
          else this.i++;
        }
        this.i++;
      }
    }
  }

  /** Whether the next character ends the current command. */
  private atEnd(close: Closer): boolean {
    const c = this.s[this.i];
    return c === undefined || c === ';' || c === '\n' || c === '|' || c === ')'
      || (c === '&' && this.s[this.i + 1] !== '>') || (c === '`' && close === '`');
  }
}
