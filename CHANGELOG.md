# Changelog

## Unreleased

- Read Google Antigravity conversations (`~/.gemini/antigravity/conversations/*.db`) as a new agent, `ag`: prompts, responses, model calls with logged latency, time to first token and tokens, tool calls with timing, exit codes and permission prompts, and subagent links.
- Bundle the JavaScript engine and Node runtime in the macOS application. Discover supported local Claude and Codex sources automatically, with explicit folder selection and an isolated demo.
- Add the Workbench: context inspection, run comparison, behavioral checks, coordination, change verification, sequence search, dependency profiling, and reviewed dataset export.
- Add experiment manifests, annotations, cohort summaries, table exports, investigation documents, and offline OTLP/OpenInference conversion.
- Expose bounded analysis through the browser, CLI, HTTP workers, and project-scoped MCP.
- Preserve failed analysis for retry, verify raw evidence against indexed source bytes, export consistent capture snapshots, and record analysis settings and integrity status.
- Add structural capture redaction, compiled npm artifacts, installed-package checks, native bundle verification, cross-platform CI, and optional signed macOS release automation.
- Add `agentshark replay`: run a session's recorded tool calls again, open-loop, in a Docker container without network, and compare each result with the recording. Codex code-mode scripts replay through the commands and file changes Codex logged for them.
- Add the Workbench's Replay Plan (what a replay would run, skip and why, linked to the recorded events) and Replay Report (a replay's verdicts joined to the recording, with its divergence point).
- Replay works like an emulator: `--break N|VERDICT` pauses before a call or after a verdict, and on a terminal keys pause, step, skip a recorded wait, open a shell in the container, show a call's output and save the state as an image. A status line shows the running call or the remaining wait. A replay that stops before its last call keeps its container, and `--resume` continues it or starts again from a saved image. The header lists the programs the recorded commands start that the image lacks.
- The demo indexes the whole synthetic corpus: Claude Code subagents and a workflow, and Codex sessions with failures, a goal run and a code-mode script.
- The Workbench page follows the viewer's type scale, tokens, theme and density.
- Statistics ▸ Performance: headline figures, then lanes on one time axis (where time went, the slowest intervals, call duration, first token, output speed, cache reuse, prompt size and calls). Idle time between busy periods collapses, one cursor reads every lane, dragging zooms into a period, and an interval opens in Timeline. The slowest intervals and a per-model comparison follow.
- Cowork diagnostics name the cause of a failed turn instead of "(success)" or "(completed)".
- A first index works newest first in stages: live sessions appear within about a second of a cold start (about 40 seconds before, on 4 GB of real transcripts), the last day's within a few seconds, and older history fills in behind them. The status says how far back history is complete ("Indexing n/m · since 21:52"). The whole first index is about 8% faster.

Local validation uses synthetic fixtures. Public signing, notarization, clean-machine installation, and empirical rule accuracy require separate release evidence.
