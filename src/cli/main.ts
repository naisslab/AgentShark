// CLI entry (SPEC §9): command registry, argument parsing, help, and friendly error reporting.
// Command implementations are imported on demand, so `--help` and light commands load quickly.

import { parseArgs } from 'node:util';
import { type Args, CliError, err, out, table, version } from './util.ts';

interface OptionSpec {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  /** Placeholder shown in help for string options. */
  arg?: string;
  help: string;
}

interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  options: Record<string, OptionSpec>;
  /** Names of positional arguments; extra positionals are an error. */
  positionals?: string[];
  details?: string;
  run: (args: Args) => Promise<number>;
}

const INDEX_OPT: OptionSpec = { type: 'string', arg: 'PATH', help: 'index database (default ~/.agentshark/index.sqlite or $AGENTSHARK_HOME)' };
const AGENT_OPT: OptionSpec = { type: 'string', multiple: true, arg: 'cc|cw|cx|cp', help: 'only this agent; repeat or comma-separate for several' };
const FILTER_OPT: OptionSpec = { type: 'string', short: 'f', arg: 'EXPR', help: 'display filter, e.g. \'tool.name == "Bash" && dur > 2s\'' };
const SESSION_OPT: OptionSpec = { type: 'string', short: 's', multiple: true, arg: 'ID', help: 'only this session and its subagents (repeatable)' };
const JSON_OPT: OptionSpec = { type: 'boolean', help: 'machine-readable output' };
const HANDSHAKE_OPT: OptionSpec = {
  type: 'boolean',
  help: 'print one JSON line {"event":"ready",url,token,mode,indexPath,version} on stdout when listening; other output goes to stderr',
};

export const COMMANDS: CommandSpec[] = [
  {
    name: 'serve',
    summary: 'start the viewer on the live index (indexes in the background, watches sources)',
    usage: 'agentshark serve [--port 7373] [--no-open] [--no-watch] [--handshake] [--index PATH]',
    options: {
      port: { type: 'string', short: 'p', arg: 'N', help: 'port on 127.0.0.1 (default 7373; 0 picks a free port)' },
      'no-open': { type: 'boolean', help: 'do not open a browser' },
      'no-watch': { type: 'boolean', help: 'do not re-index when sources change (checked every 3 s, at most one run every 5 s)' },
      handshake: HANDSHAKE_OPT,
      index: INDEX_OPT,
    },
    details:
      'The first run indexes every supported log on this machine (Claude Code, Claude Cowork, Codex, Copilot Chat); later runs\n' +
      're-parse only changed files. The index lives in ~/.agentshark/index.sqlite (or $AGENTSHARK_HOME). Press Ctrl+C to stop.',
    run: async (a) => (await import('./serve.ts')).serve(a),
  },
  {
    name: 'demo', summary: 'open a bundled synthetic investigation in an isolated index',
    usage: 'agentshark demo [--port N] [--no-open]',
    options: { port: { type: 'string', arg: 'N', help: 'local port (default 0, an available port)' }, 'no-open': { type: 'boolean', help: 'do not open a browser' }, handshake: HANDSHAKE_OPT },
    run: async a => (await import('./demo.ts')).demo(a),
  },
  {
    name: 'open',
    summary: 'view a capture file',
    usage: 'agentshark open FILE.agentcap[.zst|.gz] [--port N] [--no-open] [--handshake]',
    positionals: ['FILE'],
    options: {
      analysis: { type: 'string', arg: 'recorded|current', help: 'use recorded analysis settings (default) or explicitly re-analyze with current rules' },
      integrity: { type: 'string', arg: 'strict|recover', help: 'reject altered complete captures (default strict); recover explicitly accepts damaged evidence' },
      port: { type: 'string', short: 'p', arg: 'N', help: 'port on 127.0.0.1 (default: 7373 or the next free one; 0 picks a free port)' },
      'no-open': { type: 'boolean', help: 'do not open a browser' },
      handshake: HANDSHAKE_OPT,
    },
    details:
      'The capture is loaded into ~/.agentshark/captures/ once and reused until the file changes. Every open prints the\n' +
      "capture's origin and what it could not include (truncated stream, raw lines unavailable, side files left out).",
    run: async (a) => (await import('./serve.ts')).openCapture(a),
  },
  {
    name: 'why',
    summary: 'explain a run: impact per turn, what needs attention, alarms and whether it is stalled',
    usage: 'agentshark why [--last|--session ID|--cwd DIR] [--since 8h] [--refresh] [--json|--md] [--index PATH]',
    options: {
      last: { type: 'boolean', help: 'the latest finished run (the default)' },
      session: { type: 'string', short: 's', arg: 'ID', help: 'this run (a root session id, or one of its subagents)' },
      cwd: { type: 'string', arg: 'DIR', help: 'the latest run whose working directory is DIR or below it' },
      since: { type: 'string', arg: 'WHEN', help: 'only evidence since: a duration back from now (8h) or an ISO date' },
      refresh: { type: 'boolean', help: 'index once first, unless another process holds the index lock' },
      json: { ...JSON_OPT, help: 'the MCP run_report output (trace text redacted, in *_excerpt fields)' },
      md: { type: 'boolean', help: 'Markdown for an issue or a pull request (the default output, redacted)' },
      index: INDEX_OPT,
    },
    details: 'The report shows the observed chain, never a cause. Home folders, the user name and secret-shaped strings are redacted.',
    run: async (a) => (await import('./why.ts')).why(a),
  },
  {
    name: 'failures',
    summary: 'list failure episodes that need attention, or the recurring error signatures',
    usage: 'agentshark failures [--since 7d] [--session ID] [--all] [--signatures] [--limit N] [--json] [--index PATH]',
    options: {
      since: { type: 'string', arg: 'WHEN', help: 'episodes with evidence since (default 7d): a duration or an ISO date' },
      session: { type: 'string', short: 's', arg: 'ID', help: 'only this run (with its subagents)' },
      all: { type: 'boolean', help: 'every episode, including recovered ones (default: blocked and unrecovered)' },
      signatures: { type: 'boolean', help: 'list error signatures by sessions × unrecovered rate instead' },
      limit: { type: 'string', short: 'n', arg: 'N', help: 'print at most N rows (default 20)' },
      json: { ...JSON_OPT, help: 'the MCP list_failures output (pages merged beyond 20)' },
      index: INDEX_OPT,
    },
    run: async (a) => (await import('./failures.ts')).failures(a),
  },
  {
    name: 'sig',
    summary: 'look up an error: its signature, how often agents hit it and what got past it',
    usage: 'agentshark sig "<error text>" | sig_… | - [--json] [--index PATH]',
    positionals: ['TEXT'],
    options: { json: { ...JSON_OPT, help: 'the MCP lookup_error output' }, index: INDEX_OPT },
    details: 'TEXT is error output (at most 4,096 bytes), a signature id, or - to read the text from stdin.',
    run: async (a) => (await import('./failures.ts')).sig(a),
  },
  {
    name: 'list',
    summary: 'print events like tshark',
    usage: 'agentshark list [-f FILTER] [--session ID] [--limit N] [--utc] [--json]',
    options: {
      filter: FILTER_OPT,
      session: SESSION_OPT,
      limit: { type: 'string', short: 'n', arg: 'N', help: 'print at most N events (default 1000; 0 = all)' },
      all: { type: 'boolean', help: 'include inherited and duplicate events' },
      utc: { type: 'boolean', help: 'print times in UTC (Z) instead of local time with its UTC offset' },
      json: { ...JSON_OPT, help: 'one JSON event row per line (times in µs since the epoch)' },
      index: INDEX_OPT,
    },
    details:
      'Times print as local time with their UTC offset (2026-10-12 00:36:59.970 +08:00). In filters, times without a zone\n' +
      'are local time: ts >= "2026-10-11" starts at local midnight; ts >= "2026-10-11T00:00Z" at UTC midnight; ts > -2h is relative.',
    run: async (a) => (await import('./inspect.ts')).list(a),
  },
  {
    name: 'stats',
    summary: 'print statistics tables',
    usage: 'agentshark stats [--view summary|tools|models|kinds|pairs] [-f FILTER] [--session ID]',
    options: {
      view: { type: 'string', arg: 'NAME', help: 'summary (default), tools, models, kinds or pairs' },
      filter: FILTER_OPT,
      session: SESSION_OPT,
      json: JSON_OPT,
      index: INDEX_OPT,
    },
    run: async (a) => (await import('./inspect.ts')).stats(a),
  },
  {
    name: 'fields',
    summary: 'list display filter fields',
    usage: 'agentshark fields [--json]',
    options: { json: JSON_OPT },
    run: async (a) => (await import('./inspect.ts')).fields(a),
  },
  {
    name: 'sources',
    summary: 'logging health: what each agent logs, what is missing, and how to log more',
    usage: 'agentshark sources [--json]',
    options: { json: JSON_OPT, index: INDEX_OPT },
    run: async (a) => (await import('./sources.ts')).sources(a),
  },
  {
    name: 'index',
    summary: 'build or update the live index',
    usage: 'agentshark index [--full | --rederive] [--agent cc|cw|cx|cp] [--index PATH]',
    options: {
      full: { type: 'boolean', help: 're-parse every source, not only changed ones' },
      rederive: { type: 'boolean', help: 're-derive the analysis tables (steps, failures, episodes, ...) without re-parsing' },
      agent: AGENT_OPT,
      index: INDEX_OPT,
      workers: { type: 'string', arg: 'N', help: 'parser worker threads (default min(cpus − 2, 8))' },
    },
    run: async (a) => (await import('./indexing.ts')).index(a),
  },
  {
    name: 'config', summary: 'show or configure the local Codex and Claude source folders',
    usage: 'agentshark config [--agent codex|claude --add PATH|--remove PATH] [--no-auto-discover|--auto-discover]',
    options: {
      agent: { type: 'string', arg: 'codex|claude', help: 'agent whose source folders should change' },
      add: { type: 'string', multiple: true, arg: 'PATH', help: 'add an agent data folder (.codex or .claude)' },
      remove: { type: 'string', multiple: true, arg: 'PATH', help: 'remove an explicit source folder' },
      'auto-discover': { type: 'boolean', help: 'also discover the default local source folders' },
      'no-auto-discover': { type: 'boolean', help: 'read only explicitly configured source folders' },
    },
    run: async a => (await import('./workbench.ts')).configureSources(a),
  },
  {
    name: 'capture',
    summary: 'write sessions to a self-contained .agentcap file',
    usage: 'agentshark capture -o FILE [--since 7d] [--until ISO] [--agent …] [--session ID]... [--filter EXPR] [--no-raw] [--no-sidecars] [--compress zstd|gzip|none] [--progress json]',
    options: {
      profile: { type: 'string', arg: 'forensic|shareable', help: 'forensic retains evidence; shareable removes free text/raw/side files and pseudonymizes identifiers' },
      preview: { type: 'boolean', help: 'preview selection and redaction without writing a capture' },
      'redaction-key-file': { type: 'string', arg: 'FILE', help: 'secret key for stable identities across shareable captures; never saved in the capture' },
      out: { type: 'string', short: 'o', arg: 'FILE', help: 'output file: .agentcap, .agentcap.gz or .agentcap.zst' },
      since: { type: 'string', arg: 'WHEN', help: 'sessions active since: a duration back from now (7d, 12h) or an ISO date (2026-10-11, 2026-10-11T09:00+08:00)' },
      until: { type: 'string', arg: 'WHEN', help: 'sessions active until this time (same forms as --since)' },
      agent: AGENT_OPT,
      session: SESSION_OPT,
      filter: { ...FILTER_OPT, help: 'only sessions with at least one event matching this display filter' },
      'no-raw': { type: 'boolean', help: 'omit the original source lines; normalized text and metadata stay (this is not redaction)' },
      'no-sidecars': { type: 'boolean', help: 'omit side files (persisted tool outputs, workflow and subagent metadata)' },
      compress: { type: 'string', arg: 'zstd|gzip|none', help: 'compression (default: from the file extension)' },
      progress: { type: 'string', arg: 'json', help: 'json: report progress as JSON lines on stdout instead of a progress bar' },
      'no-index': { type: 'boolean', help: 'skip the incremental index update before capturing' },
      index: INDEX_OPT,
    },
    details: [
      'A capture is a self-contained copy of the selected sessions. It contains:',
      '  - the normalized records: prompts, assistant text, thinking text, tool inputs and outputs (up to 4 KB per',
      '    field), token counts, timings, diagnostics, file paths, working directories and git branches;',
      '  - the original source lines, unless --no-raw (secrets that appear in prompts or tool output are copied too);',
      '  - side files: persisted tool outputs, subagent and workflow metadata, unless --no-sidecars;',
      '  - the host name, platform and the selection (agents, time range, sessions, filter) in its header.',
      '--no-raw makes a capture smaller; it is not redaction. --profile shareable removes arbitrary text and original',
      'records; use --preview to review its omissions. Every capture records what it could not include (raw lines',
      'of files deleted since indexing, side files that were missing or larger than 64 MiB) in its trailer.',
      'Times without a zone are local time; add Z or +08:00 for another zone. Opened captures are indexed into',
      '~/.agentshark/captures/.',
    ].join('\n'),
    run: async (a) => (await import('./capture.ts')).capture(a),
  },
  {
    name: 'replay',
    summary: "re-run a session's tool calls in a Docker container and compare the results",
    usage: 'agentshark replay SESSION --workspace DIR [--rev REV] [--image IMAGE] [--speed N|max] [--max-gap DUR] [--dry-run] [--json] [-o FILE]',
    positionals: ['SESSION'],
    options: {
      workspace: { type: 'string', arg: 'DIR', help: 'starting files, copied into the container at the recorded cwd (required unless --dry-run)' },
      rev: { type: 'string', arg: 'REV', help: 'start from this git revision of DIR instead of its working tree' },
      image: { type: 'string', arg: 'IMAGE', help: 'container image (default node:24-bookworm)' },
      speed: { type: 'string', arg: 'N|max', help: 'pacing: 1 keeps recorded waits (default), 2 halves them, max removes them' },
      'max-gap': { type: 'string', arg: 'DUR', help: 'cap every inserted wait, e.g. 30s' },
      network: { type: 'string', arg: 'NAME', help: 'docker network (default none)' },
      env: { type: 'string', multiple: true, arg: 'KEY=VALUE', help: 'environment variable for every call (repeatable)' },
      timeout: { type: 'string', arg: 'DUR', help: 'upper bound on one call (default 10m)' },
      keep: { type: 'boolean', help: 'leave the container running afterwards' },
      'dry-run': { type: 'boolean', help: 'print the plan without starting a container' },
      json: JSON_OPT,
      output: { type: 'string', short: 'o', arg: 'FILE', help: 'also write the JSON lines to FILE' },
      capture: { type: 'string', arg: 'FILE', help: 'read the session from a capture file instead of the live index' },
      index: INDEX_OPT,
    },
    details: [
      'Model decisions come from the trace: every recorded call is issued as logged, and no model is called. Shell',
      'commands and file edits (Bash, exec_command, shell_command, Read, Write, Edit, MultiEdit, apply_patch) run in',
      'the container, and so do the commands and file changes of Codex code-mode scripts; search, web, MCP, planning',
      'and subagent tools are skipped. Each result is compared with the recording: same, output (status matches,',
      'output differs) or status (the first one is the divergence point).',
      'Nothing on the host is mounted; the container has no network unless --network names one. Exit code 3 means',
      'at least one status differed. See docs/REPLAY.md.',
    ].join('\n'),
    run: async (a) => (await import('./replay.ts')).replay(a),
  },
  {
    name: 'mcp',
    summary: 'read-only MCP server over stdio, for agents that diagnose runs',
    usage: 'agentshark mcp [--index PATH] [--scope project|all] [--max-bytes 16384] [--allow-raw]',
    options: {
      index: INDEX_OPT,
      scope: { type: 'string', arg: 'project|all', help: 'project (default): only runs under the client\'s git root; all: every run' },
      'max-bytes': { type: 'string', arg: 'N', help: 'keep each tool result under N bytes (default 16384, at least 2048)' },
      'allow-raw': { type: 'boolean', help: 'let get_event include the native source record' },
    },
    details: [
      'Register it once; AgentShark never edits agent configuration:',
      '  Claude Code:  claude mcp add agentshark -- agentshark mcp',
      '  Codex:        add to ~/.codex/config.toml',
      '                [mcp_servers.agentshark]',
      '                command = "agentshark"',
      '                args = ["mcp"]',
      'The server opens the index read-only and never indexes; keep `agentshark serve` running for fresh data.',
      'Trace text appears only in *_excerpt fields, redacted (home, user name, secrets) and cut to 300 characters.',
    ].join('\n'),
    run: async (a) => (await import('../mcp/server.ts')).mcp(a),
  },
  {
    name: 'analyze', summary: 'run evidence-backed workbench analyses and research exports',
    usage: 'agentshark analyze OPERATION [--session ID] [--input FILE.json] [--out FILE.json] [--index PATH]',
    positionals: ['OPERATION'],
    options: {
      session: SESSION_OPT, index: INDEX_OPT,
      input: { type: 'string', arg: 'FILE', help: 'JSON request; see docs/WORKBENCH.md for schemas and examples' },
      out: { type: 'string', short: 'o', arg: 'FILE', help: 'create a JSON output file (refuses to overwrite)' },
      left: { type: 'string', arg: 'ID', help: 'left session for compare' }, right: { type: 'string', arg: 'ID', help: 'right session for compare' },
      table: { type: 'string', arg: 'TABLE', help: 'exportTable: sessions, events, steps, failures, changes or annotations' },
      format: { type: 'string', arg: 'csv|jsonl', help: 'exportTable format' },
      title: { type: 'string', arg: 'TEXT', help: 'portable investigation title' },
    },
    details: 'Operations: context, compare, checks, coordination, verification, dataset, search, profile, cohort, exportTable, investigation, exportTelemetry,\nreplayPlan, replayReport. replayReport takes the JSON lines of agentshark replay --json as --input.\nResults include coverage, evidence references and confidence. JSON requests and outputs are portable analysis recipes.',
    run: async a => (await import('./workbench.ts')).analyze(a),
  },
  {
    name: 'check', summary: 'evaluate trace behavior for CI: pass, fail or unknown',
    usage: 'agentshark check [--session ID] [--rule NAME] [--input FILE.json] [--out FILE.json]',
    options: {
      session: SESSION_OPT, index: INDEX_OPT,
      rule: { type: 'string', multiple: true, arg: 'NAME', help: 'tests-after-edit, unresolved-delegations, repeated-failed-actions or token-budget' },
      input: { type: 'string', arg: 'FILE', help: 'JSON checks request with optional thresholds' },
      out: { type: 'string', short: 'o', arg: 'FILE', help: 'create a JSON report (refuses to overwrite)' },
    },
    details: 'Exit status: 0 pass, 1 fail, 2 invalid input, 3 unknown. Incomplete evidence never silently passes.',
    run: async a => (await import('./workbench.ts')).analyze(a, true),
  },
  {
    name: 'telemetry', summary: 'convert offline OTLP/OpenInference JSON or export observed spans',
    usage: 'agentshark telemetry import --input FILE.json [--out FILE.json] | telemetry export [--session ID] [--out FILE.json]',
    positionals: ['DIRECTION'],
    options: {
      input: { type: 'string', arg: 'FILE', help: 'OTLP/JSON resourceSpans document to convert' },
      out: { type: 'string', short: 'o', arg: 'FILE', help: 'create the conversion or export document (refuses to overwrite)' },
      session: SESSION_OPT, index: INDEX_OPT,
      'include-text': { type: 'boolean', help: 'include trace text in the export; omitted by default' },
    },
    details: 'Import produces a portable conversion document with original records and explicit unknowns; it does not add generic telemetry to the native-agent index. Export includes an OTLP document plus coverage and omitted-span reports. No collector or network transport is used.',
    run: async a => (await import('./telemetry.ts')).telemetry(a),
  },
];

export function globalHelp(): string {
  const rows = COMMANDS.map((c) => ['  ' + out.bold(c.name), c.summary]);
  return [
    `${out.bold('AgentShark')} ${version()}: inspect supported local coding-agent logs, from session timelines to original records`,
    '',
    'Usage: agentshark <command> [options]',
    '',
    'Commands:',
    table(rows),
    '',
    "Run 'agentshark <command> --help' for a command's options.",
  ].join('\n');
}

export function commandHelp(c: CommandSpec): string {
  const opts = Object.entries({ ...c.options, help: { type: 'boolean', short: 'h', help: 'show this help' } as OptionSpec }).map(
    ([name, o]) => [`  ${o.short ? `-${o.short}, ` : '    '}--${name}${o.arg ? ' ' + o.arg : ''}`, o.help],
  );
  return [`${c.summary[0].toUpperCase()}${c.summary.slice(1)}.`, '', `Usage: ${c.usage}`, ...(c.details ? ['', c.details] : []), '', 'Options:', table(opts)].join('\n');
}

export function parseCommandArgs(c: CommandSpec, argv: string[]): Args & { help: boolean } {
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = { help: { type: 'boolean', short: 'h' } };
  // parseArgs rejects keys whose value is undefined, so copy only the ones that are set.
  for (const [name, { type, short, multiple }] of Object.entries(c.options)) {
    options[name] = { type, ...(short && { short }), ...(multiple && { multiple }) };
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    // parseArgs messages carry a long hint after the first sentence.
    const first = String((e as Error).message).split('. ')[0];
    throw new CliError(`${first}\nUsage: ${c.usage}`, 2);
  }
  const { help, ...values } = parsed.values as Args['values'];
  const max = c.positionals?.length ?? 0;
  if (!help && parsed.positionals.length > max) throw new CliError(`unexpected argument '${parsed.positionals[max]}'\nUsage: ${c.usage}`, 2);
  return { values, positionals: parsed.positionals, help: help === true };
}

/** Run the CLI and return the process exit code. */
export async function main(argv: string[]): Promise<number> {
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    // `agentshark list | head` closes the pipe early; that is not an error.
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  const [name, ...rest] = argv;
  try {
    if (name === undefined || name === '-h' || name === '--help' || name === 'help') {
      const c = COMMANDS.find((x) => x.name === rest[0]);
      console.log(c ? commandHelp(c) : globalHelp());
      return 0;
    }
    if (name === '-v' || name === '--version' || name === 'version') {
      console.log(version());
      return 0;
    }
    const command = COMMANDS.find((c) => c.name === name);
    if (!command) throw new CliError(`unknown command '${name}'. Commands: ${COMMANDS.map((c) => c.name).join(', ')}`, 2);
    const args = parseCommandArgs(command, rest);
    if (args.help) {
      console.log(commandHelp(command));
      return 0;
    }
    return await command.run(args);
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`${err.red('agentshark:')} ${e.message}`);
      return e.exitCode;
    }
    console.error(`${err.red('agentshark:')} ${(e as Error)?.message ?? e}`);
    if (process.env.AGENTSHARK_DEBUG) console.error(e);
    else console.error(err.dim('Set AGENTSHARK_DEBUG=1 for a stack trace.'));
    return 1;
  }
}
