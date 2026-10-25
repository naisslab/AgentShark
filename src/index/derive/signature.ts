// Error signature normalization (SPEC §12.4): one line per failure, placeholders for the parts that vary, a family
// and a stable id. Pure functions; C calls sigv1() for `lookupError`. `sigv2` adds rule (s): a failed command's
// canonical sandbox denial is its line, whatever else it printed.

import { createHash } from 'node:crypto';
import { FAMILY_CLASS, type FailureClass, type FailureFamily, type FailureSource } from '../../model/types.ts';

export const SIG_RULE = 'sigv2';
/** Rule (s) of pickLine, registered with its hand-checked precision (derive.ts RULES). */
export const SANDBOX_LINE_RULE = 'sandbox-line@1';

export interface SigInput {
  head: string;
  tail?: string | null;
  /** The target key's program, for rule (f). */
  program?: string | null;
  exitCode?: number | null;
  /** `error.type: error.message` for api rows. */
  api?: { type?: string; message?: string } | null;
  /** The failure row's source: `policy` and `hook` rows name their family. */
  source?: FailureSource | null;
  /** A suspect text rule that fired (`tests-failed` makes the family test-failure). */
  suspect?: string | null;
  /**
   * The command starts with a file viewer or lister (a `read:` key, or cat, sed, rg, ls, ...): its output is file
   * content, so rules (d) and (e) would pick content. Only a diagnostic line names its error.
   */
  viewer?: boolean;
  /** A fixed signature text (rule f), for rows whose output is free prose: a Stop hook's blocking reason. */
  fixed?: string | null;
}

export interface Sig {
  /** 'sig_' + sha1(family + '\n' + the text's first 88 code points)[0:12] */
  id: string;
  /** At most 88 code points; a longer text is cut at a word boundary and ends with an ellipsis. */
  text: string;
  family: FailureFamily;
  class: FailureClass;
  /** The picked line before placeholders (FailureRow.errorLine), at most 300 characters; null for rules (f) and (b) without a line. */
  line: string | null;
  /** `c2`: a `<program>: ...` diagnostic line (No such file or directory, Permission denied, ...); `s`: a canonical sandbox denial. */
  rule: 'a' | 's' | 'b' | 'c' | 'c2' | 'd' | 'e' | 'f';
}

const MAX_TEXT = 88;
const MAX_LINE = 300;

// Step 1 -------------------------------------------------------------------------------------------------------

/** Shell start-up noise, not the command's output: Homebrew's shellenv.sh runs /bin/ps, which the sandbox denies. */
export const SHELL_INIT_NOISE = /^\/\S+: line \d+: \/bin\/ps: Operation not permitted\n?/gm;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/**
 * curl's progress meter: its two header lines and the rows it redraws after a CR. The error curl prints next starts on
 * the last row's line ("…  0curl: (6) Could not resolve host"), so a row's numbers go and what follows them stays.
 */
const CURL_METER = /^[ \t]*% Total[ \t]+% Received.*\n?|^[ \t]*Dload[ \t]+Upload[ \t]+Total.*\n?|^[ \t]*(?:\d+(?:\.\d+)?[kMGTP]?[ \t]+){6,8}(?:[\d-]+:[\d-]{2}:[\d-]{2}[ \t]+){3}\d+(?:\.\d+)?[kMGTP]?\n?/gm;
/** A user's own "no" to a tool call (Claude, Cowork), as the harness words it. */
export const USER_REJECTED = /^(?:The user doesn't want to proceed|User rejected)/;
const CODEX_HEADER = /^(?:Chunk ID: \S*|Wall time:? [\d.]+ seconds?|Original token count: \d+|Output:|Exit code:? (-?\d+)|Process exited with code (-?\d+)|Process running with session ID (\d+))\s*$/;
const SCRIPT_STATUS = /^Script (completed|failed|running with cell ID \d+)\b.*$/;

export interface Stripped {
  text: string;
  exitCode: number | null;
  /** Unwrapped <tool_use_error> text or MCP `error_type: message` (rule a). */
  markA: string | null;
  codeMode: boolean;
  /** Codex "Process running with session ID N". */
  running: string | null;
  /** The output came out of a `SandboxDenied { message }` wrapper. */
  sandboxed?: boolean;
}

/** Output as a terminal would leave it: no ANSI escapes, a CR (alone or before LF) is a line break, no curl meter. */
export function cleanOutput(raw: string): string {
  return raw.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CURL_METER, '');
}

/** SPEC §12.4 step 1: remove wrappers, keep the exit code, unwrap tool_use_error and MCP error JSON. */
export function stripWrappers(raw: string): Stripped {
  let text = cleanOutput(raw).replace(SHELL_INIT_NOISE, '');
  // Legacy unified exec echoes the command (possibly several lines) before its header.
  if (text.startsWith('Command: ')) {
    const at = text.indexOf('\nChunk ID: ');
    if (at >= 0) text = text.slice(at + 1);
  }
  let exitCode: number | null = null;
  let running: string | null = null;
  let codeMode = false;
  let markA: string | null = null;
  let sandboxed = false;
  // Leading header lines (Codex unified exec, legacy shell_command, Claude "Exit code N", code-mode status).
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    const h = CODEX_HEADER.exec(l) ?? /^Exit code (-?\d+)$/.exec(l);
    if (h) {
      const code = h[1] ?? h[2];
      if (code !== undefined) exitCode = Number(code);
      if (h[3] !== undefined) running = h[3];
      continue;
    }
    const s = SCRIPT_STATUS.exec(l);
    if (s) {
      if (s[1] === 'failed') codeMode = true;
      continue;
    }
    if (/^Script error:\s*$/.test(l)) {
      codeMode = true;
      continue;
    }
    break;
  }
  text = lines.slice(i).join('\n');
  // Code mode prints the script's own output first; what follows "Script error:" is the failure.
  const se = /^Script error:[ \t]*/m.exec(text);
  if (se) {
    codeMode = true;
    text = text.slice(se.index + se[0].length);
  }
  const tue = /<tool_use_error>([\s\S]*?)(?:<\/tool_use_error>|$)/.exec(text);
  if (tue) markA = firstLine(tue[1]);
  // Codex sandbox denial: the command's own stderr (else stdout) is the message. The newer form,
  // `SandboxDenied { message: "<output>" }`, carries the output as one escaped string.
  if (!markA && /Sandbox\(Denied/.test(text)) {
    const inner = streamText(text, 'stderr') || streamText(text, 'stdout');
    text = inner ? inner : 'sandbox denied: no output';
  } else if (!markA && /SandboxDenied \{ message: /.test(text)) {
    const m = /SandboxDenied \{ message: "((?:[^"\\]|\\.)*)/.exec(text);
    text = m?.[1] ? unescapeJson(m[1]).trim() || 'sandbox denied: no output' : 'sandbox denied: no output';
    sandboxed = true;
  }
  if (!markA) markA = mcpError(text);
  if (!markA) text = contentList(text) ?? text;
  return { text, exitCode, markA, codeMode, running, sandboxed };
}

function streamText(text: string, stream: string): string {
  const m = new RegExp(`${stream}: StreamOutput \\{ text: \\\\?"((?:[^"\\\\]|\\\\.)*?)\\\\?"`).exec(text);
  if (!m) return '';
  return m[1].replace(/\\\\n|\\n/g, '\n').replace(/\\\\"|\\"/g, '"').replace(/\\\\/g, '\\').trim();
}

/** MCP output JSON (`{"error_type": .., "message": ..}`, or a content list whose text carries one). */
function mcpError(text: string): string | null {
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  let v: unknown;
  try {
    v = JSON.parse(t.length > 20000 ? t.slice(0, 20000) : t);
  } catch {
    const et = /"error_type"\s*:\s*"([^"]+)"/.exec(t);
    if (!et) return null;
    const msg = /"message"\s*:\s*"((?:[^"\\]|\\.){0,300})/.exec(t);
    return msg ? `${et[1]}: ${unescapeJson(msg[1])}` : et[1];
  }
  if (Array.isArray(v)) {
    const texts = v.map((x) => (x && typeof x === 'object' && typeof (x as any).text === 'string' ? (x as any).text : '')).filter(Boolean);
    return texts.length ? mcpError(texts.join('\n')) : null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const et = o.error_type ?? (o.error && typeof o.error === 'object' ? (o.error as any).type : undefined);
    const msg = o.message ?? (o.error && typeof o.error === 'object' ? (o.error as any).message : undefined);
    if (typeof et === 'string') return typeof msg === 'string' ? `${et}: ${firstLine(msg)}` : et;
  }
  return null;
}

/** A content list (`[{"type": "text", "text": ..}]`) is its texts. */
function contentList(text: string): string | null {
  const t = text.trimStart();
  if (!t.startsWith('[{')) return null;
  try {
    const v = JSON.parse(t);
    if (!Array.isArray(v)) return null;
    const texts = v.map((x) => (x && typeof x === 'object' && typeof x.text === 'string' ? x.text : '')).filter(Boolean);
    return texts.length ? texts.join('\n') : null;
  } catch {
    return null;
  }
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s.replace(/\\$/, '')}"`);
  } catch {
    return s;
  }
}

// Step 2 -------------------------------------------------------------------------------------------------------

const TRACEBACK = 'Traceback (most recent call last):';
const EXC_LINE = /^\s*[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b/;
/** An exception statement outside a traceback: `SyntaxError: invalid syntax`. */
const EXC_STATEMENT = /^\s*[A-Za-z_][\w.]*(Error|Exception): \S/;
/**
 * Test summary lines (rule c). Besides SPEC §12.4's list: pytest -q ("2 failed, 41 passed in 3.21s"), node --test
 * ("# fail 1"), mocha ("3 failing") and XCTest ("Executed 9 tests, with 1 failure").
 */
const TEST_SUMMARY = [
  /=+ .*\d+ (failed|error)/, /FAILED \(failures=/, /test result: FAILED/, /Tests: .*\d+ failed/, /^FAIL\b/, /\*\* TEST FAILED \*\*/,
  /^\d+ failed(, \d+ \w+)*( in [\d.]+s)?$/, /^# fail [1-9]/, /^\d+ failing$/, /^Executed \d+ tests?, with [1-9]\d* failures?/, /^FAILED \S+::\S/,
];
const ERROR_WORD = /\b(error|errno|fatal|fail(ed|ure)?|denied|not permitted|not found|no such|cannot|can't|could not|unable to|invalid|refused|timed? ?out|exception|panic|abort(ed)?)\b/i;
/**
 * Rule c2: a program's own diagnostic, `<program>[:<n>]: <operand>: <reason>`, as cat, sed, rg, ls and the shells print
 * them, or curl's numbered one, `curl: (<code>) <message>`.
 */
const DIAGNOSTIC = /^[\w.+-]+(?::\d+)?: .*\b(No such file or directory|Permission denied|Operation not permitted|Is a directory|Not a directory|command not found|IO error|cannot access|cannot open|Bad file descriptor|Read-only file system)\b|^curl: \(\d+\) \S/;
/**
 * A viewer's own error, as git and jq print them (`fatal: …`, `error: …`, `jq: error (at …)`). Only for viewers:
 * elsewhere rule (d) finds the first such line, and cargo's closing `error: could not compile` must not win.
 */
const VIEWER_ERROR = /^(?:[\w.+-]+: )?(?:fatal|error)(?::| \()/;
/**
 * Rule s: a canonical sandbox denial (the forms of §12.4 step 4): a path the sandbox kept a program from
 * (`… <path>: Operation not permitted`, also `(<path>): …`), the here-document temp file, Python's missing temporary
 * directory. Hand-checked as `sandbox-line@1` (precision.ts).
 */
const SANDBOX_DENIAL = /(?:^|[\s('"])(?:~|\.{1,2})?\/[^\s:'"]*['")]?: Operation not permitted|(?:can't|cannot) create temp file for here document|No usable temporary directory/i;
/** A denied log (`Error opening log file …`, `file logging disabled for …`) or a warning: the program went on without it. */
const INCIDENTAL_DENIAL = /\blog(?:s|ging)?\b|\.log\b|\bWARN(?:ING)?\b|^\s*warning:/i;
export const TRACEBACK_FALLBACK = '<python traceback, exception line not in index>';
export const STILL_RUNNING = '<process still running>';

/** SPEC §12.4 step 2: the one line a signature is built from. */
export function pickLine(s: Stripped, tail: string | null, exitCode: number | null, program: string | null, viewer = false): { rule: Sig['rule']; line: string | null; fixed: string | null } {
  // "Process running with session ID N": the outcome is not in this result (deferred tier), whatever it printed so far.
  if (s.running) return { rule: 'f', line: null, fixed: STILL_RUNNING };
  if (s.markA) return { rule: 'a', line: s.markA, fixed: null };
  // The harness's words for a user's rejection; what the user typed after them is not the error.
  const first = firstLine(s.text);
  if (USER_REJECTED.test(first)) return { rule: 'a', line: first, fixed: null };
  const all = tail ? `${s.text}\n${tail}` : s.text;
  // A command that failed on a canonical sandbox denial was blocked, whatever else it printed (a build's errors, a
  // traceback): the last denial is its line (a traceback quotes the source line that raised it first). A viewer's
  // output is file content, so only its own diagnostic (c2) counts.
  if (!viewer && exitCode !== null && exitCode !== 0) {
    const denial = all.split('\n').findLast((l) => SANDBOX_DENIAL.test(l) && !INCIDENTAL_DENIAL.test(l));
    if (denial) return { rule: 's', line: denial.trim(), fixed: null };
  }
  const tb = all.indexOf(TRACEBACK);
  if (tb >= 0) {
    const after = all.slice(tb + TRACEBACK.length).split('\n');
    for (let i = after.length - 1; i >= 0; i--) if (EXC_LINE.test(after[i])) return { rule: 'b', line: after[i].trim(), fixed: null };
    return { rule: 'b', line: null, fixed: TRACEBACK_FALLBACK };
  }
  const lines = all.split('\n');
  // Python prints a SyntaxError of `python -c` without a traceback header.
  if (!viewer) for (const l of lines) if (EXC_STATEMENT.test(l)) return { rule: 'b', line: l.trim(), fixed: null };
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l && TEST_SUMMARY.some((re) => re.test(l))) return { rule: 'c', line: l, fixed: null };
  }
  for (const l of lines) if (DIAGNOSTIC.test(l.trim()) || (viewer && VIEWER_ERROR.test(l.trim()))) return { rule: 'c2', line: l.trim(), fixed: null };
  if (viewer) {
    // File content is not an error message: name the exit and the program instead.
    return { rule: 'f', line: null, fixed: `<${all.trim() ? 'no error line' : 'no output'}> exit ${exitCode ?? '?'} [${program ?? '?'}]` };
  }
  for (const l of lines) if (ERROR_WORD.test(l)) return { rule: 'd', line: l.trim(), fixed: null };
  // A line without a letter (a progress meter, a row of numbers) is not a message.
  for (const l of lines) if (/\p{L}/u.test(l)) return { rule: 'e', line: l.trim(), fixed: null };
  return { rule: 'f', line: null, fixed: `<${all.trim() ? 'no error line' : 'no output'}> exit ${exitCode ?? '?'} [${program ?? '?'}]` };
}

// Step 3 -------------------------------------------------------------------------------------------------------

const FILE_EXT = 'py|pyi|pyc|ipynb|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonl|ndjson|md|mdx|txt|csv|tsv|yaml|yml|toml|ini|cfg|conf|env|lock|log|sh|zsh|bash|' +
  'html|htm|css|scss|xml|svg|png|jpe?g|gif|webp|pdf|tex|bib|docx?|pptx?|xlsx?|zip|gz|tgz|tar|parquet|pkl|npy|npz|pt|bin|db|sqlite3?|' +
  'swift|rs|go|java|kt|kts|c|cc|cpp|h|hpp|m|mm|rb|php|sql|lua|r|scala|cs|fs|vue|svelte|proto|wasm|so|dylib|plist|xcodeproj|pbxproj|app';
const RE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]]+/gi;
const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_PATH = /(?<![\w~.])(?:~|\.\.?)?\/[^\s:'"`,;()<>[\]{}|]+/g;
const RE_FILE = new RegExp(`(?<![\\w.<-])[\\w.-]*\\w\\.(?:${FILE_EXT})\\b(?![\\w-])`, 'gi');
const RE_HEX = /\b0x[0-9a-f]+\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi;
const RE_NUM = /(?<![A-Za-z0-9])\d+(?:[.,:]\d+)*(?:ms|s|m|h|KB|MB|GB)?(?![A-Za-z0-9])/g;
/** The host a network diagnostic names (curl's resolve and connect errors, getaddrinfo, wget). */
const RE_HOST = /\b(Could not resolve (?:host|proxy): |Failed to connect to |getaddrinfo (?:ENOTFOUND|EAI_AGAIN) |unable to resolve host address )['"‘“]?[\w.-]+['"’”]?/g;
const LONE_PLACEHOLDER = /^<(url|uuid|host|path|file|q|hex|n)>$/;

/** SPEC §12.4 step 3, in order: URLs, UUIDs, hosts, paths, file names, quoted strings, hex, numbers, whitespace. */
export function placeholders(line: string): string {
  let s = line.replace(RE_URL, '<url>').replace(RE_UUID, '<uuid>').replace(RE_HOST, '$1<host>');
  s = s.replace(RE_PATH, (m) => (m.startsWith('~') && !m.startsWith('~/') ? m : '<path>'));
  s = s.replace(RE_FILE, '<file>');
  const quote = (inner: string) => (LONE_PLACEHOLDER.test(inner) ? inner : '<q>');
  s = s.replace(/"([^"\n]{0,200})"/g, (_m, inner) => quote(inner));
  s = s.replace(/(?<!\w)'([^'\n]{0,200})'(?!\w)/g, (_m, inner) => quote(inner));
  s = s.replace(/`([^`\n]{0,200})`/g, (_m, inner) => quote(inner));
  s = s.replace(/[‘“]([^’”\n]{0,200})[’”]/g, (_m, inner) => quote(inner));
  s = s.replace(RE_HEX, '<hex>');
  s = s.replace(RE_NUM, '<n>');
  // A trailing colon introduces a listing ("...expected lines in <path>:"): the same message with or without one.
  return s.replace(/\s+/g, ' ').trim().replace(/:$/, '');
}

// Steps 4 and 5 -------------------------------------------------------------------------------------------------

const SANDBOX = /Sandbox\(Denied|operation not permitted|can't create temp file for here document|No usable temporary directory|sandbox-exec|seatbelt|^sandbox denied:/im;
const POLICY = /patch rejected|rejected by (the )?user|blocked by policy|approval (was )?(denied|rejected)|Rejected\(|doesn't want to proceed|denied by (the )?(user|policy|hook)|writing outside of the project/i;
const NETWORK_CODE = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_NETWORK)\b|net::ERR_/;
const NETWORK = /Could not resolve host|Failed to connect to \S+ port \d+|Couldn't connect to server|getaddrinfo|nodename nor servname|Name or service not known|Temporary failure in name resolution|Network is unreachable|Connection refused|Connection reset by peer|socket hang up|\begress|network access.{0,60}(blocked|denied|disabled|restricted|not allowed)|blocked by (the )?network|fetch failed/i;
const STALE_EDIT = /Failed to find expected lines|String to replace not found|has not been read yet|modified since read|has been modified since|Found \d+ matches of the string/i;
const MISSING_MODULE = /ModuleNotFoundError|No module named|Cannot find module|ImportError|Cannot find package|ERR_MODULE_NOT_FOUND|no such module|could not import module/i;
const MISSING_FILE = /No such file or directory|ENOENT|FileNotFoundError|\b(file|path|directory) (does not|doesn't) exist|File does not exist/i;
const HARNESS = /write_stdin failed|stdin is closed|Unknown process id|js execution timed out|kernel (was )?reset|exec_command failed|collab spawn failed|CreateProcess|code-mode/i;
const HOOK = /\b(PreToolUse|PostToolUse|UserPromptSubmit|SessionStart|Stop|SubagentStop) hook\b|hook (error|failed|blocked)/i;

/** SPEC §12.4 step 4 sandbox canonical forms (versioned with SIG_RULE). */
function sandboxForm(text: string): string {
  if (/(can't|cannot) create temp file for here document/i.test(text)) {
    const shell = /^(zsh|bash|dash|sh)\b/.exec(text)?.[1] ?? (/\bline <n>:/.test(text) ? 'bash' : 'sh');
    return `sandbox denied: ${shell}: can't create temp file for here document`;
  }
  if (/No usable temporary directory/i.test(text)) return 'sandbox denied: no usable temporary directory';
  // One signature for every program the sandbox stops on a path (§12.4's `<op>` is a placeholder, like `<path>`).
  if (/^[\w.-]+: \S+: Operation not permitted/i.test(text)) return 'sandbox denied: <op> <path>: Operation not permitted';
  return text.startsWith('sandbox denied: ') ? text : `sandbox denied: ${text}`;
}

/** Exit codes that name a network failure by themselves (the program printed nothing, or only a progress meter). */
const NETWORK_EXIT: Record<string, readonly number[]> = { curl: [5, 6, 7], wget: [4] };

/**
 * SPEC §12.4 step 5, from the picked line (or the fixed text), the program and its exit code, never from other output
 * text: a KeyError whose output also mentions "Connection refused" is an exception, not a network block.
 */
function family(input: SigInput, s: Stripped, rule: Sig['rule'], line: string, exitCode: number | null): FailureFamily {
  if (input.api) return 'api';
  if (USER_REJECTED.test(line)) return 'user-rejected';
  if (input.source === 'policy' || POLICY.test(line)) return 'policy';
  if (s.sandboxed || SANDBOX.test(line)) return 'sandbox';
  if (NETWORK_CODE.test(line) || NETWORK.test(line)) return 'network';
  if (exitCode !== null && input.program && NETWORK_EXIT[input.program]?.includes(exitCode)) return 'network';
  if (STALE_EDIT.test(line)) return 'stale-edit';
  if (rule === 'c' || input.suspect === 'tests-failed') return 'test-failure';
  if (MISSING_MODULE.test(line)) return 'missing-module';
  if (MISSING_FILE.test(line)) return 'missing-file';
  if (s.codeMode || HARNESS.test(line)) return 'harness';
  if (input.source === 'hook' || HOOK.test(line)) return 'hook';
  if (rule === 'b' || EXC_LINE.test(line)) return 'exception';
  if (rule === 'd' || rule === 'c2') return 'error-text';
  return 'other';
}

export function sigId(family: string, text: string): string {
  return 'sig_' + createHash('sha1').update(`${family}\n${text}`).digest('hex').slice(0, 12);
}

function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n).join('');
}

/**
 * A text cut for display to at most `n` code points: at the last space in the second half of the cut, else at the
 * cut, with an ellipsis. Text that fits stays as it is.
 */
export function clip(s: string, n: number): string {
  const cps = Array.from(s);
  if (cps.length <= n) return s;
  const kept = cps.slice(0, n - 1).join('');
  const space = kept.lastIndexOf(' ');
  return `${(space >= kept.length / 2 ? kept.slice(0, space) : kept).trimEnd()}…`;
}

/** SPEC §12.4: the signature of one failure (SIG_RULE; the name stays for its callers). */
export function sigv1(input: SigInput): Sig {
  const head = input.api ? `${input.api.type ?? 'error'}: ${input.api.message ?? ''}`.trim() : input.head ?? '';
  const s = stripWrappers(head);
  const tail = input.tail ? stripWrappers(input.tail).text : null;
  const exit = input.exitCode ?? s.exitCode;
  const picked = input.fixed ? { rule: 'f' as const, line: null, fixed: input.fixed } : pickLine(s, tail, exit, input.program ?? null, input.viewer ?? false);
  const line = picked.line !== null ? cut(picked.line, MAX_LINE) : null;
  let text = picked.fixed ?? placeholders(line ?? '');
  if (picked.rule === 'c') text = 'tests failed';
  const fam = family(input, s, picked.rule, line ?? text, exit);
  if (fam === 'sandbox' || s.sandboxed) text = sandboxForm(text);
  // SPEC §12.4 step 6: the id hashes the plain cut; the text is its display form.
  return { id: sigId(fam, cut(text, MAX_TEXT)), text: clip(text, MAX_TEXT), family: fam, class: FAMILY_CLASS[fam], line, rule: picked.rule };
}

function firstLine(s: string): string {
  for (const l of s.split('\n')) if (l.trim()) return l.trim();
  return '';
}
