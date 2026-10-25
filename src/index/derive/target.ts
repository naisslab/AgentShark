// Target keys (SPEC §12.3.4): what a call acts on, so retries of one command or one file group into one episode.
// Pure functions over a call's input; no database access.

import { posix } from 'node:path';
import type { ToolKindTag } from '../../model/types.ts';

export const TARGET_RULE = 'target@2';

export interface TargetInput {
  tool: string | null;
  kind: ToolKindTag | null;
  input: unknown;
  /** attrs.tool.command */
  command?: string | null;
  /** Codex parsed_cmd when logged: [{type, cmd, path?}] (objects; a list of type strings carries no command). */
  parsedCmd?: unknown;
  server?: string | null;
  /** attrs.tool.path */
  path?: string | null;
  cwd?: string | null;
  hook?: { event?: string; command?: string } | null;
  /** llm.error and refusals: key 'api'. */
  api?: boolean;
  /** write_stdin, BashOutput, TaskOutput, ...: the target key of the call that opened the process, when known. */
  proc?: string | null;
  /** The process id the call names, used when the opener is unknown (`proc:#N`). */
  procId?: string | null;
  /** The call's output: an apply_patch failure keys on the file its error names. */
  output?: string | null;
}

/** Segments that set up the shell, print, or wait: the key is the next segment's program (`date; curl …` is curl). */
const SKIP_SEGMENT = new Set(['cd', 'export', 'source', '.', 'set', 'pushd', 'popd', 'echo', 'printf', 'date', 'sleep', 'pwd', 'true', ':', 'clear']);
const DROP_WORD = new Set(['sudo', 'env', 'time', 'nohup', 'npx']);
const WITH_SUB = new Set(['git', 'npm', 'pnpm', 'yarn', 'cargo', 'go', 'uv', 'pip', 'docker', 'gh', 'make', 'swift', 'xcodebuild', 'brew']);
const VIEWERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl']);
const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish']);
/** Options that take a value, per program (only where the value would otherwise read as the subcommand). */
const VALUE_FLAGS: Record<string, Set<string>> = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']),
  make: new Set(['-C', '-f', '-j', '-I', '-o', '-W', '--directory', '--file']),
  npm: new Set(['--prefix', '-C', '--workspace', '-w']),
  pnpm: new Set(['-C', '--dir', '--filter', '-F']),
  yarn: new Set(['--cwd']),
  cargo: new Set(['--manifest-path', '-Z', '--config', '-C']),
  docker: new Set(['-H', '--host', '--context', '-c', '--config', '-l', '--log-level']),
  uv: new Set(['--directory', '--project', '--python', '-p', '--cache-dir']),
  gh: new Set(['-R', '--repo']),
  swift: new Set(['--package-path', '-C']),
  go: new Set(['-C']),
  head: new Set(['-n', '-c']),
  tail: new Set(['-n', '-c']),
  bat: new Set(['-l', '--language', '-r', '--line-range', '-H', '--highlight-line']),
  ssh: new Set(['-p', '-i', '-o', '-l', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-I']),
  python: new Set(['-W', '-X', '--check-hash-based-pycs']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-U', '-r', '-t']),
  uvrun: new Set(['--with', '--python', '-p', '--project', '--directory', '--extra', '--group', '--env-file', '--package', '--with-requirements']),
};
const XCODE_ACTIONS = new Set(['build', 'build-for-testing', 'analyze', 'archive', 'test', 'test-without-building', 'installsrc', 'install', 'clean', 'docbuild']);

/** The key of one call (SPEC §12.3.4). */
export function targetKey(t: TargetInput): string {
  if (t.api) return 'api';
  if (t.hook) return `hook:${t.hook.event ?? '?'}:${t.hook.command ?? '?'}`;
  const tool = t.tool ?? '';
  const input = obj(t.input);
  if (tool === 'write_stdin' || PROC_TOOLS.has(tool)) {
    if (t.proc) return `proc:${t.proc}`;
    if (t.procId) return `proc:#${t.procId}`;
    return `tool:${tool}`;
  }
  if (tool === 'exec' && t.kind !== 'shell') return codeModeTarget(str(t.input) ?? str(input?.code) ?? '', t.cwd ?? null);
  if (t.kind === 'shell' || SHELL_TOOLS.has(tool)) {
    const cmd = t.command ?? str(input?.command) ?? str(input?.cmd) ?? '';
    return shellTarget(cmd, t.parsedCmd, t.cwd ?? null);
  }
  if (tool === 'Read' || tool === 'view_image' || tool === 'ImageView') {
    const p = str(input?.file_path) ?? str(input?.path) ?? t.path;
    return p ? `read:${absPath(p, t.cwd)}` : `tool:${tool}`;
  }
  if (EDIT_TOOLS.has(tool)) {
    const p = str(input?.file_path) ?? str(input?.notebook_path) ?? t.path;
    return p ? `edit:${absPath(p, t.cwd)}` : `tool:${tool}`;
  }
  if (tool === 'apply_patch' || tool === 'FileChange') {
    const files = patchFiles(typeof t.input === 'string' ? t.input : str(input?.patch) ?? str(input?.input) ?? '');
    if (!files.length && t.path) files.push(t.path);
    const named = t.output ? files.find((f) => t.output!.includes(f) || t.output!.includes(absPath(f, t.cwd))) : undefined;
    const f = named ?? files[0];
    return f ? `edit:${absPath(f, t.cwd)}` : `tool:${tool}`;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) {
    const url = t.kind === 'web' ? host(str(input?.url)) : null;
    return url ? `web:${url}` : `mcp:${t.server ?? mcp[1]}.${mcp[2]}`;
  }
  if (t.kind === 'web') {
    const h = host(str(input?.url));
    return h ? `web:${h}` : `tool:${tool}`;
  }
  if (tool === 'Agent' || tool === 'Task') return `agent:${str(input?.subagent_type) ?? 'general-purpose'}`;
  if (tool === 'spawn_agent') return `agent:${str(input?.agent_type) ?? 'default'}`;
  return `tool:${tool || '?'}`;
}

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell_command', 'mcp__workspace__bash', 'CommandExecution']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Calls that poll, read or stop a background process opened by an earlier call. */
export const PROC_TOOLS = new Set(['BashOutput', 'KillShell', 'TaskOutput', 'TaskStop']);

/**
 * The key of a shell command (SPEC §12.3.4 rules 1–4). `parsedCmd` (Codex parsed_cmd objects) wins when logged;
 * `cwd` makes the paths of shell viewers absolute.
 */
export function shellTarget(command: string, parsedCmd?: unknown, cwd: string | null = null): string {
  const parsed = firstParsed(parsedCmd);
  if (parsed) {
    if (parsed.type === 'read' && parsed.path) return `read:${absPath(parsed.path, cwd)}`;
    if (parsed.cmd) command = parsed.cmd;
  }
  return shellKey(command, cwd, 0);
}

/** The first parsed command that is not a skipped segment, else the first one. */
function firstParsed(p: unknown): { type?: string; cmd?: string; path?: string } | null {
  if (!Array.isArray(p)) return null;
  const all = p.filter((x) => x && typeof x === 'object' && (typeof x.cmd === 'string' || typeof x.path === 'string'));
  const o = all.find((x) => typeof x.path === 'string' || !SKIP_SEGMENT.has(String(x.cmd).trim().split(/\s+/)[0])) ?? all[0];
  return o ? { type: str(o.type) ?? undefined, cmd: str(o.cmd) ?? undefined, path: str(o.path) ?? undefined } : null;
}

function shellKey(command: string, cwd: string | null, depth: number): string {
  const segments = splitSegments(command);
  let first: string[] | null = null;
  for (const words of segments) {
    if (!words.length) continue;
    first ??= words;
    if (SKIP_SEGMENT.has(words[0]) || words.every(isAssignment)) continue;
    const key = segmentKey(words, cwd, depth);
    if (key) return key;
  }
  return `sh:${first ? base(first[0]) : '?'}`;
}

/** Key of one simple command, or null when only dropped words remain. */
function segmentKey(words: string[], cwd: string | null, depth: number): string | null {
  let w = dropPrefix(stripRedirects(words));
  if (!w.length) return null;
  const prog = progName(w[0]);
  const args = w.slice(1);
  // bash -lc '<script>': the script decides.
  if (SHELLS.has(prog) && depth < 3) {
    const i = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (i >= 0 && args[i + 1] !== undefined) return shellKey(args[i + 1], cwd, depth + 1);
  }
  if (prog === 'python') return `sh:${pythonKey(args)}`;
  if (prog === 'ssh') return `sh:${sshKey(args, depth)}`;
  const viewed = viewerPath(prog, args, words);
  if (viewed) return `read:${absPath(viewed, cwd)}`;
  if (prog === 'xcodebuild') {
    const action = args.find((a) => XCODE_ACTIONS.has(a));
    return `sh:xcodebuild${action ? ' ' + action : ''}`;
  }
  if (WITH_SUB.has(prog)) {
    const sub = firstArg(args, VALUE_FLAGS[prog], prog === 'cargo');
    return `sh:${prog}${sub ? ' ' + sub.slice(0, 40) : ''}`;
  }
  return `sh:${prog}`;
}

/** Leading assignments, sudo, env, time, nohup, `timeout N`, `uv run`, `poetry run` and npx. */
export function dropPrefix(w: string[]): string[] {
  for (let guard = 0; guard < 20 && w.length; guard++) {
    const b = base(w[0]);
    if (isAssignment(w[0])) w = w.slice(1);
    else if (DROP_WORD.has(b)) w = skipFlags(w.slice(1), b === 'sudo' ? VALUE_FLAGS.sudo : undefined);
    else if (b === 'timeout') {
      w = skipFlags(w.slice(1), new Set(['-s', '--signal', '-k', '--kill-after']));
      if (w.length && /^\d+(\.\d+)?[smhd]?$/.test(w[0])) w = w.slice(1);
    } else if ((b === 'uv' || b === 'poetry' || b === 'pipenv' || b === 'pdm') && w[1] === 'run') w = skipFlags(w.slice(2), VALUE_FLAGS.uvrun);
    else break;
  }
  return w;
}

function skipFlags(w: string[], valued?: Set<string>): string[] {
  let i = 0;
  while (i < w.length && w[i].startsWith('-') && w[i] !== '-') {
    i += valued?.has(w[i]) ? 2 : 1;
  }
  return w.slice(i);
}

/** First argument that is not an option (or an option's value); `+toolchain` for cargo. */
function firstArg(args: string[], valued?: Set<string>, plusToolchain = false): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (valued?.has(a) && !a.includes('=')) i++;
      continue;
    }
    if (plusToolchain && a.startsWith('+')) continue;
    return a;
  }
  return null;
}

function pythonKey(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m') return args[i + 1] ? `python -m ${args[i + 1]}` : 'python -m';
    if (a === '-c' || /^-[A-Za-z]*c$/.test(a)) return 'python -c';
    if (a === '-') return 'python -';
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.python.has(a)) i++;
      continue;
    }
    return `python ${a}`;
  }
  return 'python';
}

function sshKey(args: string[], depth: number): string {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += VALUE_FLAGS.ssh.has(args[i]) ? 2 : 1;
  const hostArg = args[i];
  if (!hostArg) return 'ssh';
  const remote = args.slice(i + 1).join(' ');
  if (!remote || depth >= 3) return `ssh ${hostArg}`;
  const k = shellKey(remote, null, depth + 1);
  const prog = k.startsWith('sh:') ? k.slice(3).split(' ')[0] : k;
  return `ssh ${hostArg} ${prog}`;
}

/** The file a shell viewer (cat, head, tail, less, more, bat, nl, sed -n) shows, or null. */
function viewerPath(prog: string, args: string[], words: string[]): string | null {
  if (words.some((x) => x === '>' || x === '>>' || x === '&>' || x === '>|')) return null;
  if (prog === 'sed') {
    if (!args.includes('-n') || args.some((a) => a.startsWith('-i'))) return null;
    const rest = args.filter((a) => !a.startsWith('-'));
    return rest.length >= 2 ? rest[rest.length - 1] : null;
  }
  if (!VIEWERS.has(prog)) return null;
  const valued = VALUE_FLAGS[prog];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a !== '-') {
      if (valued?.has(a)) i++;
      continue;
    }
    if (a.startsWith('+') && (prog === 'tail' || prog === 'less' || prog === 'more')) continue;
    if (a === '-' || a.startsWith('<')) return null;
    return a;
  }
  return null;
}

export function progName(word: string): string {
  const b = base(word);
  if (/^python(\d+(\.\d+)*)?$/.test(b)) return 'python';
  if (/^pip\d+(\.\d+)*$/.test(b)) return 'pip';
  return b;
}

function base(word: string): string {
  const w = word.replace(/\/+$/, '');
  const i = w.lastIndexOf('/');
  return i >= 0 && i < w.length - 1 ? w.slice(i + 1) : w;
}

const isAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
/** Redirection operators as the lexer emits them (`>`, `2>`, `2>&`, `&>`, `<<`, `<<<`). */
const REDIRECT_OP = /^(\d*|&)(>>?|>\||<<?<?-?)&?$/;

/** Words without redirections; an operator takes its target with it (a here-document's delimiter is gone already). */
export function stripRedirects(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!REDIRECT_OP.test(w)) out.push(w);
    else if (!/^<<-?$/.test(w)) i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// A small shell lexer: quotes, escapes, operators (&& || ; | & newline), subshell parens and here-documents.

/** Simple commands of a script, as word lists, in order. Redirection targets stay attached to their operator. */
export function splitSegments(script: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  const heredocs: string[] = [];
  const push = () => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const end = () => {
    push();
    if (words.length) out.push(words);
    words = [];
  };
  const s = script.length > 4000 ? script.slice(0, 4000) : script;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] !== '\n') {
        cur += s[i + 1];
        has = true;
      }
      i++;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, j < 0 ? s.length : j);
      has = true;
      i = j < 0 ? s.length : j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) j++;
        cur += s[j];
      }
      has = true;
      i = j;
    } else if (c === ' ' || c === '\t') {
      push();
    } else if (c === '\n') {
      end();
      if (heredocs.length) i = skipHeredocs(s, i + 1, heredocs) - 1;
    } else if (c === ';' || c === '(' || c === ')' || c === '{' && !has && (s[i + 1] === ' ' || s[i + 1] === '\n') || c === '}' && !has) {
      end();
    } else if (c === '<' || c === '>' || c === '&' && s[i + 1] === '>') {
      // Redirection: `>`, `>>`, `2>`, `2>&` (its fd follows as a word), `&>`, `<<EOF` (the body is skipped), `<<<`.
      let op = /^\d+$/.test(cur) ? cur : '';
      if (!op) push();
      op += c;
      while ('<>&|-'.includes(s[i + 1] ?? ' ') && op.length < 4) op += s[++i];
      cur = '';
      has = false;
      words.push(op);
      if (/^<<-?$/.test(op)) {
        let j = i + 1;
        while (s[j] === ' ') j++;
        const m = /^(['"]?)([A-Za-z_0-9.-]+)\1/.exec(s.slice(j, j + 80));
        if (m) {
          heredocs.push(m[2]);
          i = j + m[0].length - 1;
        }
      }
    } else if (c === '&' || c === '|') {
      end();
      if (s[i + 1] === c) i++;
    } else {
      cur += c;
      has = true;
    }
  }
  end();
  return out;
}

function skipHeredocs(s: string, from: number, delims: string[]): number {
  let i = from;
  while (delims.length && i < s.length) {
    const nl = s.indexOf('\n', i);
    const line = s.slice(i, nl < 0 ? s.length : nl);
    if (line.trim() === delims[0]) delims.shift();
    i = nl < 0 ? s.length : nl + 1;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Check runs (rule check-run@1): a call runs tests, a build or a type check when its program says so (the target key,
// and for npm-style runners the script), never because the command text names a test somewhere (`git log`, `ps | grep
// pytest`, `tail pytest.log`).

export const CHECK_RUN_RULE = 'check-run@1';
export type CheckKind = 'test' | 'build' | 'typecheck';

/** The program part of a shell target key (`sh:` dropped; a poll's `proc:` key is its process's command). */
const CHECK_PROGRAMS: Record<CheckKind, RegExp> = {
  test: /^(?:pytest|py\.test|python -m (?:pytest|unittest)|cargo (?:test|nextest)|go test|swift test|xcodebuild test(?:-without-building)?|vitest|jest|mocha|rspec|phpunit|ctest|tox|make (?:test|check)|(?:npm|pnpm|yarn|bun) (?:test|t))$/,
  build: /^(?:(?:cargo|swift|go) build|xcodebuild(?: build| build-for-testing| archive)?|make(?: (?!test$|check$|clean$)\S+)?|gradlew?(?: \S+)?|mvn|tsc|webpack)$/,
  typecheck: /^(?:tsc|mypy|pyright|python -m mypy|cargo check)$/,
};
/** npm, pnpm, yarn and bun scripts of each kind (`npm run test:unit`, `yarn build`). */
const CHECK_SCRIPTS: Record<CheckKind, RegExp> = {
  test: /^(?:test|t)(?:[:._-]\S*)?$/, build: /^build(?:[:._-]\S*)?$/, typecheck: /^(?:typecheck|type-check|tsc|check-types)(?:[:._-]\S*)?$/,
};
/** Programs whose first argument names the check: `vite build`, `next build`, `deno test`, `node --test`. */
const CHECK_SUBCOMMANDS: Record<CheckKind, Record<string, string>> = {
  test: { deno: 'test', node: '--test', bun: 'test' }, build: { vite: 'build', next: 'build' }, typecheck: { deno: 'check' },
};
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Whether a call with this target key and command runs a check of `kind` (rule check-run@1). */
export function isCheckRun(kind: CheckKind, key: string, command: string): boolean {
  const k = key.startsWith('proc:') ? key.slice(5) : key;
  if (!k.startsWith('sh:')) return false;
  let program = k.slice(3);
  // `ssh <host> <program>`: the remote program decides.
  if (program.startsWith('ssh ')) program = program.split(' ').slice(2).join(' ');
  if (CHECK_PROGRAMS[kind].test(program)) return true;
  const prog = program.split(' ')[0];
  const sub = CHECK_SUBCOMMANDS[kind][prog];
  if (!sub && !SCRIPT_RUNNERS.has(prog)) return false;
  const args = programArgs(command, prog);
  if (!args) return false;
  if (sub && (sub.startsWith('-') ? args.includes(sub) : args[0] === sub)) return true;
  if (!SCRIPT_RUNNERS.has(prog)) return false;
  const i = args[0] === 'run' || args[0] === 'run-script' ? 1 : 0;
  return args[i] !== undefined && CHECK_SCRIPTS[kind].test(args[i]);
}

/** Arguments of the first simple command run by `prog` (prefixes such as env, sudo and `uv run` dropped). */
function programArgs(command: string, prog: string): string[] | null {
  for (const words of splitSegments(command)) {
    const w = dropPrefix(stripRedirects(words));
    if (w.length && progName(w[0]) === prog) return w.slice(1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Code-mode `exec` scripts (Codex): the first `tools.<name>(...)` call decides.

function codeModeTarget(js: string, cwd: string | null): string {
  const m = /tools\.(\w+)\s*\(/.exec(js);
  if (!m) return 'tool:exec';
  const name = m[1];
  const rest = js.slice(m.index + m[0].length);
  if (name === 'exec_command' || name === 'shell_command') {
    const cmd = jsStringField(rest, name === 'exec_command' ? 'cmd' : 'command');
    return cmd !== null ? shellTarget(cmd, undefined, cwd) : 'sh:?';
  }
  if (name === 'apply_patch') {
    const f = patchFiles(unescapeJs(rest.slice(0, 2000)))[0];
    return f ? `edit:${absPath(f, cwd)}` : 'tool:apply_patch';
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `mcp:${mcp[1]}.${mcp[2]}`;
  if (name === 'write_stdin') return 'tool:write_stdin';
  return `tool:${name}`;
}

/** `{cmd: "..."}` or `{cmd: '...'}` or a template literal, from the start of a JS call's argument list. */
function jsStringField(src: string, field: string): string | null {
  const m = new RegExp(`\\b${field}\\s*:\\s*(["'\`])`).exec(src.slice(0, 1500));
  if (!m) return null;
  const q = m[1];
  let out = '';
  for (let i = m.index + m[0].length; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const n = src[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else if (c === q) return out;
    else out += c;
  }
  return out;
}

function unescapeJs(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["'\\])/g, '$1');
}

/** Files of an apply_patch text, in order: Add, Update and Delete File, and Move to. */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$|^\*\*\* Move to: (.+?)\s*$/gm;
  for (let m = re.exec(patch); m; m = re.exec(patch)) {
    const f = (m[1] ?? m[2]).replace(/["'`]+$/, '');
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** `p` made absolute against `cwd` (a `file://` URL decoded, `~` kept). */
export function absPath(p: string, cwd: string | null | undefined): string {
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7));
  if (p.startsWith('/')) return posix.normalize(p);
  if (p.startsWith('~')) return p;
  return cwd && cwd.startsWith('/') ? posix.join(cwd, p) : p;
}

function host(url: string | null): string | null {
  if (!url) return null;
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s:]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

function obj(v: unknown): Record<string, any> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
