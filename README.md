<p align="center">
  <img src="web/assets/app-icon-128.png" width="96" height="96" alt="AgentShark icon">
</p>

<h1 align="center">AgentShark</h1>

<p align="center">
  <strong>Find out what your coding agent did, and why the run failed.</strong><br>
  A local, Wireshark-style inspector for Claude Code, Codex, Claude Cowork and GitHub Copilot Chat logs.
</p>

<p align="center">
  <a href="#build-the-macos-app">Build the App</a> ·
  <a href="#run-without-the-app">CLI and Browser</a> ·
  <a href="#supported-agents">Supported Agents</a> ·
  <a href="#mcp-server-for-agents">MCP</a> ·
  <a href="#privacy-and-safety">Privacy</a>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="macOS 15 or newer" src="https://img.shields.io/badge/macOS-15%2B-lightgrey">
  <img alt="Node.js 24.12 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2024.12-brightgreen">
  <img alt="No runtime dependencies" src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen">
</p>

Coding agents already write a detailed record of every prompt, model step, tool call and error to your disk. Those records are hard to read: one session can span thousands of JSON lines across several subagents, and each agent writes its own format. AgentShark reads the files where they are, indexes them into one local SQLite database, and takes you from "this run failed" to the exact source line that shows why.

The interface follows Wireshark: an overview of sessions, a filterable event list, a decoded detail tree and the raw record behind it. The resemblance ends there, and AgentShark does not read or write pcap files.

Everything runs locally. AgentShark needs no account, API key or agent plugin, it never modifies the logs it reads, and it sends no data off your machine.

## What This Repository Contains

This repository holds the source that builds the macOS app and the `agentshark` command, and nothing else:

| Path | Contents |
|---|---|
| `src/`, `bin/` | The engine and CLI in TypeScript: log adapters, the SQLite index, failure analysis, the HTTP and MCP servers |
| `web/` | The browser viewer and Workbench, plain HTML, CSS and JavaScript with no build step |
| `mac/` | The native macOS app (SwiftUI and AppKit) and the script that bundles it with the engine |
| `scripts/` | `build.mjs` compiles the engine into `build/`; `fetch-runtime.mjs` downloads the Node runtime the app bundles |
| `test/fixtures/` | The synthetic Claude Code and Codex traces behind the bundled demo; no real user data |

## Build the macOS App

You need:

- a Mac with Apple silicon or Intel running macOS 15 or later (the app runs on macOS 15; building it takes the macOS 26 SDK),
- Xcode 26 or later, or its Command Line Tools,
- [Node.js](https://nodejs.org/) 24.12 or newer, for the build scripts,
- a network connection on the first build, which downloads TypeScript from npm and a Node 24 runtime from nodejs.org.

```bash
git clone https://github.com/naisslab/AgentShark.git
cd AgentShark
npm ci
npm run desktop:build
```

The build compiles the engine, downloads the official Node 24 runtime for your Mac and checks its SHA-256 against the published `SHASUMS256.txt`, compiles the Swift app, and writes `dist/AgentShark.app`. Drag it to `/Applications` to keep it.

The app bundles the engine and its own Node runtime, so the person using it needs no terminal, Node or agent configuration. It discovers and watches local Claude Code and Codex logs when it opens.

The build signs the app ad hoc, which suits your own Mac. To give the app to others, sign it with a Developer ID and notarize it.

| Setting | Effect |
|---|---|
| `APP_OUTPUT=PATH` | Write the app somewhere other than `dist/AgentShark.app`. Required when the checkout sits in an iCloud-synced Desktop or Documents folder, because iCloud adds Finder information that `codesign` rejects. |
| `NODE=PATH` and `NODE_LICENSE=PATH` | Bundle a Node binary you already have instead of downloading one. It must be an official nodejs.org build, 24.12 or newer. |
| `CODESIGN_IDENTITY="Developer ID Application: …"` | Sign with your certificate and the hardened runtime instead of ad hoc. |
| `BUILD_NUMBER=N` | The bundle's build number. It defaults to the commit count, so set it when building from a source archive rather than a clone. |
| `npm run desktop:build -- --debug` | A debug build of the Swift app. |

## Using the App

The app opens on **Failures** when something needs attention; otherwise it reopens where you left off.

| Workspace | What it shows |
|---|---|
| **Failures** | An attention queue that groups failures into episodes (repeated attempts at one command or file within a turn) and ranks them: blocked by the sandbox, a policy or the network; never recovered; subagents that failed without telling their parent; and claims such as "all tests pass" that no passing test in the logs backs up |
| **Events** | A filterable list of every event, the decoded detail tree and the raw source record with its byte offsets |
| **Session** | One run as Steps, as a Transcript or as a Flow diagram; **Critical Path** (⌥⌘4) shows which class of time (model, tools, people or other agents) dominates the run, and **Compare** (⌥⌘5) shows where two runs of one task part |
| **Timeline** | Sessions, subagents, tool calls, background processes and failure bands on one time axis |
| **Statistics** | Summary, tools, models and turns; Performance shows where time went, and the I/O graph plots any metric over time |
| **Diagnostics** | Tool and API errors, retries, refusals, denied permissions, unpaired calls and unparseable records, grouped by severity |
| **Sources** | Per-agent logging health: what the logs on this machine record and what they lack |

Each derived value is marked as logged, derived (≈), parsed (~) or inferred by a named rule (?). Missing data appears as a stated gap, never as a zero, and AgentShark runs no model. The **Analyze** menu opens Critical Path and Compare for the selected run, the Workbench in your browser (**Open Research Tools in Browser**), and the bundled synthetic traces (**Explore Bundled Demo**).

## Run Without the App

On Linux, or without Xcode, use the CLI and the browser viewer. Node runs the TypeScript source directly, so a fresh clone works without `npm install`:

```bash
node bin/agentshark.ts demo     # the bundled synthetic traces, in a temporary index
node bin/agentshark.ts serve    # your own logs
```

`serve` finds the logs of every supported agent on this machine, indexes them into `~/.agentshark/index.sqlite` and opens the viewer at a URL such as `http://127.0.0.1:7373/?token=…`. The token changes each time the server restarts. The first index works newest first, and afterwards AgentShark watches the files and parses again only the ones that change. The index is a cache of your logs, so deleting it is safe. Set `AGENTSHARK_HOME` to keep it in another folder.

To type `agentshark` instead of `node bin/agentshark.ts`, build and link the package:

```bash
npm ci
npm run build
npm link
```

## Supported Agents

| Source | Status | What is read |
|---|---|---|
| Claude Code transcripts (`~/.claude/projects`), CLI and desktop Code tab | Fully parsed | Every record type; subagents, workflows, persisted outputs, file history |
| Claude Cowork transcripts and `audit.jsonl` | Fully parsed | Transcripts as above; the audit log adds turn timing, time to first token, cost, permissions and retries |
| Claude desktop registries (`local_*.json`) | Metadata only | Titles, models, permission mode, worktrees and pull requests; sessions whose transcripts were deleted |
| Codex rollouts (`~/.codex/sessions`, `archived_sessions`): CLI, Desktop, exec, VS Code | Fully parsed | Every envelope and legacy record type; continuation pages, child threads, zstd-compressed (`.jsonl.zst`) rollouts |
| Codex `state_5.sqlite` | Metadata only | Titles, archive state, spawn edges |
| GitHub Copilot Chat in VS Code (`chatSessions/*.json`) | Partially parsed | Prompts, responses, request timing and tool calls; edits are not decoded |
| Google Antigravity, ChatGPT desktop, Copilot CLI, Gemini CLI, Cursor, Windsurf, Ollama, opencode | Detected, not parsed | `agentshark sources` reports that the agent is installed and why its logs cannot be read |

AgentShark keeps records it does not understand as `raw.unknown` events with their full source line, so nothing is dropped silently. If your agents keep their data in a custom location, add it with `agentshark config --agent claude --add PATH` (or `--agent codex`), or in the app under Settings ▸ Sources.

## Diagnose from the Terminal

```bash
agentshark why                       # the latest finished run: what failed and what needs attention
agentshark failures --since 7d       # failure episodes that need attention
agentshark sig "Error: Cannot find module 'left-pad'"   # have agents hit this error before, and what got past it?
agentshark list -f 'tool.name == "Bash" && dur > 2s'    # events matching a Wireshark-style display filter
```

`why` prints a run report in Markdown, ready for an issue or a pull request. Add `--json` to `why`, `failures` or `sig` for the same JSON the MCP server returns, and run `agentshark fields` for every filter field.

## MCP Server for Agents

`agentshark mcp` lets a coding agent query the index about its own runs, with nine tools: `find_runs`, `run_report`, `list_failures`, `get_episode`, `lookup_error`, `watch`, `query`, `get_event` and `analyze_trace`. The server speaks JSON-RPC over stdin and stdout, opens the index read-only and opens no socket. It never indexes, so keep `agentshark serve` or the app running for fresh data.

AgentShark never edits agent configuration; register the server yourself:

```bash
claude mcp add agentshark -- agentshark mcp
```

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.agentshark]
command = "agentshark"
args = ["mcp"]
```

The server shows only runs under the agent's own git root unless you register it with `--scope all`. It replaces your home folder with `~`, your user name with `<user>` and secret-shaped strings with `<secret:class:length>`, and it marks text from the logs as data for the agent, never as instructions.

## Captures, Replay and the Workbench

- **Captures.** `agentshark capture -o FILE.agentcap.zst --since 7d` writes the selected sessions to one self-contained file that outlives the agents' own log cleanup, and `agentshark open FILE` views it later. A default capture keeps private text; `--profile shareable` removes free text, raw records and side files and pseudonymizes identifiers and paths.
- **Replay.** `agentshark replay SESSION --workspace DIR` runs a session's recorded shell and file tool calls again in a Docker container without network and reports where the results first diverge. It calls no model.
- **Workbench.** Critical Path, Compare Runs, Cache Anatomy, Context Inspector, Localization Map, Capability Envelope, Sequence Search, Behavioral Checks and more, in the browser or through `agentshark analyze`. Each tool states the limit of its evidence, and `agentshark check` runs behavioral checks in CI.

## Privacy and Safety

Agent logs contain source code, prompts and sometimes credentials, so AgentShark treats them carefully:

- It reads agent logs and never modifies them. It never reads credential files (`~/.codex/auth.json`, `*.key`, cookies, browser storage).
- The viewer binds to `127.0.0.1` and requires a token that changes with every server start.
- The MCP server is read-only, limited to the agent's own project by default, and redacts home paths, your user name and secret-shaped strings.
- A default capture contains private text. Only the shareable profile removes it, and even then, review a capture before you share it.

Never attach a real trace or index database to a public issue.

## Command Reference

```text
agentshark serve [--port 7373] [--no-open] [--no-watch]      start the viewer on the live index
agentshark open FILE.agentcap[.zst|.gz]                      view a capture
agentshark index [--full|--rederive] [--agent cc|cw|cx|cp]   build or update the index
agentshark capture -o FILE [--since 7d] [--session ID]...    write a capture
agentshark list [-f FILTER] [--session ID] [--utc] [--json]  print events
agentshark stats [--view summary|tools|models|kinds|pairs]   print statistics
agentshark sources [--json]                                  logging health
agentshark config [--agent codex|claude] [--add PATH]        configure additional source folders
agentshark demo                                              open bundled synthetic traces
agentshark analyze OPERATION [--session ID] [--input FILE]   run Workbench analysis or export
agentshark check [--session ID] [--input FILE]               CI checks: pass, fail, invalid or unknown
agentshark telemetry import|export [--input FILE]            offline OTLP/OpenInference conversion
agentshark fields                                            filter fields
agentshark why [--last|--session ID|--cwd DIR] [--since 8h]  why a run failed: its run report (--json, --md)
agentshark failures [--since 7d] [--signatures] [--json]     failure episodes that need attention
agentshark sig "<error text>"                                have agents hit this error before, and what got past it
agentshark mcp [--scope project|all] [--max-bytes 16384]     read-only MCP server for agents (stdio)
agentshark replay SESSION --workspace DIR [--speed N|max]    re-run a session's tool calls in a Docker container
```

`agentshark <command> --help` describes each command's options.

## Project Status

AgentShark is at version 0.1.0. There is no signed and notarized release yet, so the app builds from source. Its inferred findings are heuristics: their precision has been checked by hand only on a sample, and their recall has not been measured, so treat them as advisory.

## License

[MIT](LICENSE). The macOS app bundles an official Node.js runtime under its own license; see [NOTICE](NOTICE).
