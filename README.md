<p align="center">
  <img src="web/assets/app-icon-128.png" width="96" height="96" alt="AgentShark icon">
</p>

<h1 align="center">AgentShark</h1>

<p align="center">
  <strong>Find out what your coding agent did, and why the run failed.</strong><br>
  A local, Wireshark-style inspector for agent traces.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#supported-agents">Supported Agents</a> ·
  <a href="#a-tour-of-the-viewer">Tour</a> ·
  <a href="#mcp-server-for-agents">MCP</a> ·
  <a href="#privacy-and-safety">Privacy</a> ·
  <a href="#documentation">Docs</a>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Node.js 24.12 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2024.12-brightgreen">
  <img alt="No runtime dependencies" src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen">
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/failures-dark.png">
  <img alt="The Failures workspace in the macOS app: an attention queue with a blocked npm install and success claims no test backs up, and the Lens showing the failed command, where it ran and its output." src="docs/images/failures-light.png">
</picture>
<p align="center"><sub>The macOS app on real Claude Code and Codex sessions from AgentShark's own development, with the home folder pseudonymized.</sub></p>

Coding agents already write a detailed record of every prompt, model step, tool call and error to your disk. Those records are hard to read: one session can span thousands of JSON lines across several subagents, and each agent writes its own format. AgentShark reads the files where they are, indexes them into one local SQLite database, and takes you from "this run failed" to the exact source line that shows why.

The interface follows Wireshark: an overview of sessions, a filterable event list, a decoded detail tree and the raw record behind it. The resemblance ends there, and AgentShark does not read or write pcap files.

Everything runs locally. AgentShark needs no account, API key or agent plugin, it never modifies the logs it reads, and it sends no data off your machine.

## Why AgentShark

- **Failures come first.** An attention queue groups failures into episodes (repeated attempts at one command or file within a turn) and ranks them: blocked by the sandbox, a policy or the network; never recovered; subagents that failed without telling their parent; and claims such as "all tests pass" that no passing test in the logs backs up.
- **It shows evidence and names no cause.** Each derived value is marked as logged, derived (≈), parsed (~) or inferred by a named rule (?). Missing data appears as a stated gap, never as a zero. AgentShark runs no model.
- **Every field leads back to its bytes.** The decoded detail tree sits beside the original source record, so you can check any conclusion against the log itself.
- **Your agent can ask too.** A read-only MCP server lets Claude Code or Codex diagnose its own runs, with home paths and secrets redacted.
- **Evidence you can keep.** A capture file outlives the agents' own log cleanup, and a shareable profile strips free text and pseudonymizes paths.
- **Replay without a model.** Run a session's recorded tool calls again in a Docker container without network, and see where the results first diverge.

## Quick Start

Choose the **macOS app** for a native desktop interface, or the **web viewer** on macOS, Linux or Windows. Both build from source for now; there is no signed app download or published npm package yet.

Both paths need [Node.js](https://nodejs.org/) 24.12 or newer and Git. Check with `node --version` and `git --version`. If you already cloned AgentShark, reuse that checkout.

### macOS App

You need macOS 15 or later and a Swift toolchain (`swift --version`). If Swift is missing, run `xcode-select --install`, finish Apple's installer, then retry.

```bash
git clone https://github.com/naisslab/AgentShark.git ~/agentshark
cd ~/agentshark
npm ci
npm run desktop:build
open dist/AgentShark.app
```

The app opens, discovers your agent logs and indexes them in the background. Keep it open to watch new sessions; no terminal process needs to stay running. To try synthetic data, choose **Analyze ▸ Explore Bundled Demo**.

The build bundles its own Node runtime and checks the app signature. It uses an ad hoc signature for local use. Keep the checkout outside iCloud Drive; for a synced checkout, set `APP_OUTPUT` to a folder outside it and open the app at that path. [Build options and verification](docs/RELEASE.md).

### Web Viewer Only

The web viewer runs directly from source, without `npm install` or a native build:

```bash
git clone https://github.com/naisslab/AgentShark.git ~/agentshark
cd ~/agentshark
node bin/agentshark.ts demo
```

This opens a browser on bundled synthetic traces. It does not scan your home folder or change saved settings, and it deletes its temporary index when you press Ctrl+C.

To inspect your own logs, stop the demo with Ctrl+C and run:

```bash
node bin/agentshark.ts serve
```

Keep this terminal running while using the viewer. The command prints an authenticated URL such as `http://127.0.0.1:7373/?token=…`; use the new URL after each restart. Windows support is partial; see [installation and troubleshooting](docs/INSTALL.md).

### Install with One Prompt

Paste this into Claude Code, Codex or another coding agent:

```text
Install AgentShark for me: clone https://github.com/naisslab/AgentShark, then follow docs/AGENT-INSTALL.md. On macOS, build, verify and open the native app; on other platforms, set up the web viewer. Also register and check the MCP server for this coding agent.
```

For the web viewer on any platform, use this version:

```text
Install AgentShark for web-only use: clone https://github.com/naisslab/AgentShark, then follow docs/AGENT-INSTALL.md. Set up the CLI and web viewer, and register and check the MCP server for this coding agent.
```

The [agent guide](docs/AGENT-INSTALL.md) checks prerequisites, builds the selected interface, indexes logs and verifies the installation. It never uses `sudo`. Missing Node or Swift requires installing that prerequisite before setup can finish.

### Try the Demo

In the web viewer, use `node bin/agentshark.ts demo`. In the macOS app, choose **Analyze ▸ Explore Bundled Demo**; **Open in Browser** opens the demo Workbench. Click **Back to viewer** there to follow the first two steps below. Keep the demo window open while using its browser page.

1. In the browser viewer, open **Failures** and select an item under **Blocked by environment**. The Lens shows the denied command and how the turn ended.
2. Click **Show in Session**, select the failed call, then expand **Raw source line** in the inspector.
3. Open **Workbench**, choose **Replay Plan**, select **Fix the failing test**, then click **Run Analysis**. The plan lists calls that replay can execute and explains what it skips.

The first index processes recent sessions first; a large history takes minutes. The index can approach the size of your source logs. [First-run behavior and data locations](docs/INSTALL.md#first-run-and-data-locations) explains storage, memory, progress and custom source folders.

## Install

The Quick Start covers both interfaces. To add the `agentshark` command to your PATH, run these commands from the checkout:

```bash
npm ci
npm run build
npm link
```

If linking fails with a permission error, use `node /absolute/path/to/agentshark/bin/agentshark.ts` wherever the docs say `agentshark`. [INSTALL.md](docs/INSTALL.md) covers upgrades, uninstalling and locally packed npm installs; [RELEASE.md](docs/RELEASE.md) covers macOS build options.

## Supported Agents

| Source | Status | What is read |
|---|---|---|
| Claude Code transcripts (`~/.claude/projects`), CLI and desktop Code tab | Fully parsed | Every record type; subagents, workflows, persisted outputs, file history |
| Claude Cowork transcripts and `audit.jsonl` | Fully parsed | Transcripts as above; the audit log adds turn timing, time to first token, cost, permissions and retries |
| Claude desktop registries (`local_*.json`) | Metadata only | Titles, models, permission mode, worktrees and pull requests; sessions whose transcripts were deleted |
| Codex rollouts (`~/.codex/sessions`, `archived_sessions`): CLI, Desktop, exec, VS Code | Fully parsed | Every envelope and legacy record type; continuation pages, child threads, zstd-compressed (`.jsonl.zst`) rollouts |
| Codex `state_5.sqlite` | Metadata only | Titles, archive state, spawn edges |
| GitHub Copilot Chat in VS Code (`chatSessions/*.json`) | Partially parsed | Prompts, responses, request timing and tool calls (which carry no timing of their own); edits are not decoded |
| Google Antigravity, ChatGPT desktop, Copilot CLI, Gemini CLI, Cursor, Windsurf, Ollama, opencode | Detected, not parsed | `agentshark sources` reports that the agent is installed and why its logs cannot be read |

AgentShark keeps records it does not understand as `raw.unknown` events with their full source line, so nothing is dropped silently; keeping a record is not the same as decoding it. `agentshark sources` (the Sources workspace in the viewer) measures which capabilities the logs on this machine actually provide for each agent: timestamps, latencies, exit codes, token usage, reasoning text and more.

## A Tour of the Viewer

The viewer opens on **Failures** when an alarm fires (for example, a run that loops, stalls or is blocked) or new items need attention since your last visit; otherwise it reopens where you left off. Alt+1 to Alt+7 switch between the seven workspaces.

| Workspace | What it shows |
|---|---|
| **Failures** | The attention queue, and the Lens: the observed chain of the selected failure, each attempt with the edits between attempts, how it closed, and whether earlier sessions hit the same error and what got past it |
| **Events** | A filterable list of every event, the decoded detail tree and the raw source record |
| **Session** | One run as Steps (turns, model steps, tool calls and a run report), as a Transcript or as a Flow diagram |
| **Timeline** | Sessions, subagents, tool calls, background processes and failure bands on one time axis |
| **Statistics** | Summary, tools, models and turns; Performance shows where time went, and the I/O graph plots any metric over time |
| **Diagnostics** | Like Wireshark's Expert Information: tool and API errors, retries, refusals, denied permissions, unpaired calls and unparseable records, grouped by severity and linked to their events |
| **Sources** | Per-agent logging health: what the logs on this machine record and what they lack |

The screenshots below show the macOS app; the browser viewer has the same workspaces and the same numbers.

**Session ▸ Steps** lays out one run as turns and model steps. Each turn shows its outcome, failed calls are marked in red, and the header strip splits wall time into waiting, tools, model and time that no log accounts for.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/session-dark.png">
  <img alt="Session Steps view of a Codex run that reviewed AgentShark's interface: 81 steps, 44 of them in subagents, a table of steps with intent, tool calls, active time, context size and model time, and the blocked call marked in red." src="docs/images/session-light.png">
</picture>

**Events** works like Wireshark's packet list. A strip above the list shows when events happened, the Detail pane decodes the selected event, and the Raw pane shows the source record with its byte offsets.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/events-dark.png">
  <img alt="Events view of the same Codex run, with a failed npm command selected, its decoded failure fields, and the raw rollout record beside byte offsets." src="docs/images/events-light.png">
</picture>

**Timeline** puts a run and its subagents on one axis, with lanes for turns, model calls, shell commands, delegations and failures.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/timeline-dark.png">
  <img alt="Timeline of the Codex run, its two review subagents and a guardian reviewer, with lanes for turns, model calls, shell commands and delegations." src="docs/images/timeline-light.png">
</picture>

**Statistics ▸ Performance** starts with headline figures (model calls, median call duration, first token, output speed, cache reuse and busy time), then puts lanes on one time axis: where time went (model, tools, compaction, API retries, and waiting for a process, a subagent or a human), the slowest intervals, call duration, first token, output speed and cache reuse. Idle time between busy periods collapses, one cursor reads every lane, and dragging across a lane zooms in.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/performance-dark.png">
  <img alt="Statistics Performance view over 13 runs: about 3,000 model calls with a median first token of 8 seconds and 98% cache reuse, and lanes for where time went, the slowest intervals, call duration, first token, output speed and cache reuse." src="docs/images/performance-light.png">
</picture>

**Statistics ▸ I/O Graph** plots one metric per interval, as Wireshark's I/O graph does: events, errors, input or output tokens, tool or model calls, model latency, time to first token, output speed, context size or failures. Dragging across the graph sets the time scope, and the bins copy as CSV.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/io-graph-dark.png">
  <img alt="Statistics I/O graph of events per hour across nine days, with bursts of agent activity and a table of bins below." src="docs/images/io-graph-light.png">
</picture>

A few keys move through an investigation quickly: `e` and `E` jump to the next or previous failure, `u` to the next attention item, and Shift+Enter shows the selection in its session step. `f` follows one tool call, subagent, background process or file as a stream, and `c` opens a redacted report to copy into an issue or hand to a fresh agent.

## Diagnose from the Terminal

```bash
agentshark why                       # the latest finished run
agentshark failures --since 7d       # failures that need attention
agentshark sig "Error: Cannot find module 'left-pad'"  # previous occurrences
```

`why` prints a run report with evidence links; add `--json` for structured output. The [CLI guide](docs/CLI.md) includes an example report, display filters and every command.

## MCP Server for Agents

The read-only MCP server lets a coding agent query past runs. The agent-assisted installer registers it; [manual setup and verification](docs/MCP.md) covers Claude Code and Codex.

Keep the macOS app or `agentshark serve` running to index new sessions, or run `agentshark index` before querying. MCP reads the index and does not refresh it. Restart your coding-agent session after registration and ask it to use AgentShark's `find_runs` tool.

By default, results cover only the project where your coding agent is working. An empty result from the AgentShark checkout does not mean installation failed. Start the agent in the project you want to inspect; use `--scope all` only when you want every project. [MCP scope, freshness and troubleshooting](docs/MCP.md#verify-and-keep-results-current).

## Keep and Share Evidence with Captures

`agentshark capture -o FILE.agentcap.zst --since 7d` saves a self-contained copy of selected sessions. `agentshark open FILE` opens it later, even after the source agent deletes its logs.

Default captures retain private text and raw records. For sharing, preview the redacted profile with `agentshark capture --profile shareable --preview --session ID`. Review the result before sharing. [Capture profiles and integrity](docs/CAPTURES.md).

## Replay a Session

`agentshark replay SESSION --dry-run` shows which recorded actions can run again. To execute the plan, supply the starting files with `--workspace DIR`; replay needs Docker and runs without network by default. It calls no model and compares new results with the recording. [Replay commands and limits](docs/REPLAY.md).

## Workbench for Engineers and Researchers

Open **Workbench** in the browser viewer, or **Analyze ▸ Open Research Tools in Browser** in the macOS app. Select a session, choose a tool and click **Run Analysis**.

Critical Path shows where time went; Compare Runs shows where two attempts diverged. Both also run natively in the macOS app. Other tools inspect context, edits and verification, cache behavior, coordination, replay plans and research datasets. Each analysis states the limits of its evidence. The [Workbench guide](docs/WORKBENCH.md) covers the tools, saved recipes, exports and CI checks.

## Privacy and Safety

Agent logs contain source code, prompts and sometimes credentials, so AgentShark treats them carefully:

- It reads agent logs and never modifies them. It never reads credential files (`~/.codex/auth.json`, `*.key`, `.audit-key`, cookies, browser storage).
- The viewer binds to `127.0.0.1` and requires a token that changes with every server start.
- The MCP server is read-only, limited to the agent's own project by default, and redacts home paths, your user name and secret-shaped strings.
- A default capture contains private text. Only the shareable profile removes it, and even then, review a capture before you share it.

Report security problems privately as described in [SECURITY.md](SECURITY.md), never with a real trace in a public issue.

## Command Reference

Run `agentshark --help` to list commands and `agentshark <command> --help` for options. See [CLI commands and display filters](docs/CLI.md) for examples and the complete reference.

## Documentation

| Document | Covers |
|---|---|
| [INSTALL.md](docs/INSTALL.md), [RELEASE.md](docs/RELEASE.md) | Installation, source configuration, troubleshooting, the app build and its bundled runtime |
| [CLI.md](docs/CLI.md), [MCP.md](docs/MCP.md) | Commands, display filters, agent integration, scope and freshness |
| [WORKBENCH.md](docs/WORKBENCH.md), [INTEROP.md](docs/INTEROP.md) | Analyses, research workflows, CI checks and offline telemetry conversion |
| [CAPTURES.md](docs/CAPTURES.md), [FORMAT.md](docs/FORMAT.md) | Capture integrity, recorded analysis, redacted sharing and the `.agentcap` format |
| [REPLAY.md](docs/REPLAY.md) | `agentshark replay` and what it cannot reproduce |
| [ADAPTERS.md](docs/ADAPTERS.md) | The contract for contributors who add a trace source |
| [AGENT-INSTALL.md](docs/AGENT-INSTALL.md) | The steps a coding agent follows to install AgentShark for you |

## Project Status

AgentShark is at version 0.1.0 and has not had a public release. There is no signed and notarized macOS build and no published npm package yet, so the paths above build from source. A hand audit of about 1,100 sampled findings from one index found six inferred rules below the 0.8 precision that AgentShark requires of a shipped label. Recall has not been measured, and no reviewed held-out trace set exists yet, so treat heuristic findings as advisory. [CHANGELOG.md](CHANGELOG.md) lists what has changed.

## Contributing

The test suites are not in this repository yet. Build a change with `npm ci` and `npm run build`, try it with `node bin/agentshark.ts demo` and on your own logs, and say in the pull request what you tested.

The macOS client builds with Swift Package Manager. Use only synthetic or explicitly consented, redacted fixtures, and never submit private agent logs or index databases. [CONTRIBUTING.md](CONTRIBUTING.md) covers adding an adapter, the data a contribution may include and measuring performance on an official Node build.

## License

[MIT](LICENSE). The macOS app bundles an official Node.js runtime under its own license; see [NOTICE](NOTICE).
