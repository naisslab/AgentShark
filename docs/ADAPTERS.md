# Adapter Contract

This guide is for contributors adding a trace source. An adapter discovers explicitly scoped files and emits normalized records through `RecordSink`. Register it in `src/adapters/registry.ts`; the registry resolves duplicate paths in order. Runtime loading of third-party code is not part of this contract.

## Evidence and Identity

Use `sourceId`, `eventId` and `spanId` from `src/adapters/adapter.ts`. Keep raw byte offsets and lengths exact. Several normalized events may reference one source line; distinguish their block indexes. Preserve unknown records as `raw.unknown` and count malformed complete lines. An unfinished final JSON line must remain available for a later append.

`ParseStats.sha256` identifies the original bytes from offset zero through `parsedBytes`. `readJsonl` computes this while parsing, including CRLF and blank lines and excluding an unfinished invalid tail. JSON-document adapters hash the exact Buffer they parse. Never hash a later reread and call it the parsed evidence. A state database may omit the fingerprint when its evidence cannot be represented as one stable file prefix.

The raw reader verifies that indexed prefix before serving evidence. Appends are allowed; rewrites require reindexing. A zstd source (`.zst` or `.zstd`, including multi-frame append streams) is parsed, hashed and served as its decompressed bytes: open it with `openSource`, which `readJsonl` and the raw reader already use. The Zstandard reader finds complete frame boundaries before decoding and excludes a torn final frame until its append completes. Older sources without fingerprints are explicitly unverified. Do not claim that newline boundaries establish byte identity.

## Normalized Semantics

The Antigravity adapter reads both `conversations/*.db` and `brain/<id>/.system_generated/logs/transcript_full.jsonl` (falling back to `transcript.jsonl`) under `~/.gemini/antigravity` and `~/.gemini/antigravity-ide`. Both sources share a `groupKey` per conversation ID so re-indexing checkpoints cleanly without duplicates: checkpointed `.db` rows decode rich protobuf metadata (TTFT, streaming duration, `ModelUsageStats`, tool interactions), while `transcript_full.jsonl` supplies missing or unfinished steps and recovers sessions stored only as encrypted `.pb` files, complete with exact JSONL byte offsets. Reconciliation uses each decoded step rather than a maximum checkpoint index. Pending tool calls are tracked through checkpointed results, and turn spans cover events from both sources. Each span has one source owner, independent of parser completion order.

Databases open with `immutable=1`. Checkpointed `.db` events reference the database and step index with a zero-length raw reference, whereas live or `.pb`-backed JSONL steps carry exact raw byte ranges. Unsupported step types emit `raw.unknown`; malformed rows emit diagnostics while other rows remain readable.

Use integer UTC microseconds for timestamps and durations. Mark whether a timestamp or duration is logged, derived or unknown. Missing usage stays missing; it is not zero. Distinguish inherited context, mirrored records and newly executed work before aggregating. Pair tool calls and results through logged identifiers when available, and retain unpaired records with diagnostics.

Do not turn command text, filenames or quoted error examples into observed failures. Logged error flags and process exits are structural observations. Text-based classifications are heuristics and need labeled positive and negative fixtures. The rule registry reports empirical audits separately from deterministic behavior; synthetic regression checks do not establish population precision.

## Conformance Checks

The adapter regression tests cover compressed raw reads under backpressure, torn frames, checkpoint transitions, and content-token TTFT. Broader conformance fixtures described below remain future work.

The shared conformance fixture verifies explicit root isolation, malformed-line accounting, partial-tail recovery, append fingerprints, stable identifiers and idempotent reindexing. Add source-specific fixtures for duplicate messages, out-of-order timestamps, missing call results, inherited history and deleted or rewritten files. Keep every fixture synthetic or deliberately sanitized.

For a new normalization or derivation rule, document the source field and unsupported cases. Bump the relevant schema or analysis version when semantics change. Captures hash the semantic contract, so source and compiled installations can reproduce each other's recorded analysis.

## Copilot Sources

The VS Code adapter replays JSONL mutation logs into chat-session documents and also reads older JSON documents. It prefers a JSONL file when both formats exist for the same session. Raw references cover the parsed file prefix because one normalized event can depend on several mutations. An unfinished invalid final line stays outside that prefix.

The `copilot-cli` adapter reads `~/.copilot/session-state/<id>/events.jsonl`, with workspace metadata from `workspace.yaml`, and older flat `<id>.jsonl` files. Newer VS Code agents also use this format. It pairs tool calls, permissions and hooks by their logged IDs. Subagent events remain in the parent session, and `parentToolCallId` links their tool spans. Tool durations measure the gap between start and completion, which can include approval waits.

Tool output comes from `tool.execution_complete.data.result.content`, falling back to a recorded `data.error.message`. Missing output leaves both `output` and `output_len` unset; an explicit empty string has length zero. Reliability Checks require recorded output to establish repeated observations. Index schema 6 reparses existing logs to preserve this distinction.

Per-call tokens and model latency come from `session.usage_record.data.usage` in newer logs or retained `assistant.usage` events. The [Copilot SDK event schema](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts) marks `assistant.usage` as ephemeral, so older saved logs may omit these measurements. The adapter counts each usage identity once if both forms appear, using `accounting.usageId` or `apiCallId`, scoped by `accounting.sourceSessionId` when present. Duplicate records remain available as raw evidence. Tool output may also be stripped. Missing measurements stay missing; file edit snapshots and cloud coding-agent sessions are outside this adapter. The [VS Code mutation-log implementation](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts) defines the initial, set, push and delete entries.

Fresh VS Code 1.144.0 with bundled Copilot Chat 0.72.0 produced persisted usage records in a local agent session. Its token totals matched the VS Code response metrics. The same run logged `system.message`, `skill.invoked` and `skill.context_delivered_ref`. The adapter exposes bounded system and skill text as context events and preserves content references without opening external files.

The adapter links usage and assistant messages by `apiCallId` (or `requestId`) and links tools through `toolRequests[].toolCallId`. This keeps step usage, latency and tools together even when usage arrives before the message. Unmatched messages keep their own timestamp and no measured model duration. Copilot context-window capacity remains unknown; the Claude-specific estimate does not apply.

Run `agentshark index --agent cp` to read local Copilot logs. Use `agentshark capture --agent cp -o copilot.agentcap.zst` to preserve the indexed evidence and `agentshark open copilot.agentcap.zst` to inspect it later. Workspace-only metadata changes require `agentshark index --full --agent cp`.

## Gemini and DeepSeek Harness Sources

The `gemini` adapter (`gm:`) covers both the `Gemini.app` macOS desktop app (`com.google.GeminiMacOS`) and Gemini CLI (`@google/gemini-cli`):
- **Gemini macOS App Code Mode & Runtime Inspector:** Trajectories written by `Gemini.app`'s embedded helper (`trajectory_meta.source === 21` in `~/.gemini/antigravity/{conversations,brain}`) reuse the Cortex `.db` + `transcript_full.jsonl` pipeline under the `gm:` namespace (`geminiAdapter` precedes `antigravityAdapter` in `ADAPTERS`). Exported `VegaTrajectoryArchives/*.json` documents in `~/Library/Application Support/com.google.GeminiMacOS/VegaTrajectoryArchives` are also indexed. Standard cloud-only chats in `Gemini.app` stay server-side and write no local transcript.
- **Gemini CLI:** Reads `~/.gemini/tmp/<project>/chats/session-*.json`, resolving workspace paths via `<project>/.project_root` and `~/.gemini/projects.json`, and extracting `thoughts`, `tokens` (`input`, `output`, `thoughts`, `tool`, `cached`), `toolCalls`, and paired `functionResponse` outputs.

Vega archives retain user and model text from role-tagged `content` fields, including text parts. Explicit archive prompts remain supported for model-call archives; archive titles are session labels, not conversation text. Index schema 8 reparses older cached archives to restore the missing text and search entries.

The `deepseek` adapter (`ds:`) covers `DeepSeek Harness.app` (`@deepseek-ai/dsh-desktop`) and the `dsh` CLI under `~/.dsh/sessions/<workspace>/<session>/`:
- **Multi-frame Zstandard streaming:** DeepSeek Harness flushes each append as a separate Zstandard frame into `session.v4.jsonl.zstd`. `openSource()` scans standard (`0xFD2FB528`) and skippable (`0x184D2A50..5F`) frame headers, stops cleanly before any torn trailing frame during a live write, and hashes the decompressed prefix so `VerifiedSource` raw byte inspection and `.agentcap` captures verify every record.
- **Record normalization:** Pairs `step/start` and `stream` chunks for exact TTFT and model call latency, reads `assistant/message` `data.usage` (`inputTokens + cacheReadTokens + cacheWriteTokens`), pairs `tool/call` + `job/registered` + `job/settled` + `tool/result` for logged shell durations, PIDs and exit codes, pairs `approval/asked` and `approval/decided` into permission spans, marks `session/end-seed` prefixes as `inherited`, and links `subagent/catalog` and `team/member` records to `ds:<childSessionId>`. Workspace titles and paths are enriched from `~/.dsh/storages/workspace.json`.
