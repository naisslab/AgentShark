# Adapter Contract

This guide is for contributors adding a trace source. An adapter discovers explicitly scoped files and emits normalized records through `RecordSink`. Register it in `src/adapters/registry.ts`; the registry resolves duplicate paths in order. Runtime loading of third-party code is not part of this contract.

## Evidence and Identity

Use `sourceId`, `eventId` and `spanId` from `src/adapters/adapter.ts`. Keep raw byte offsets and lengths exact. Several normalized events may reference one source line; distinguish their block indexes. Preserve unknown records as `raw.unknown` and count malformed complete lines. An unfinished final JSON line must remain available for a later append.

`ParseStats.sha256` identifies the original bytes from offset zero through `parsedBytes`. `readJsonl` computes this while parsing, including CRLF and blank lines and excluding an unfinished invalid tail. JSON-document adapters hash the exact Buffer they parse. Never hash a later reread and call it the parsed evidence. A state database may omit the fingerprint when its evidence cannot be represented as one stable file prefix.

The raw reader verifies that indexed prefix before serving evidence. Appends are allowed; rewrites require reindexing. A zstd source (`.zst`) is parsed, hashed and served as its decompressed bytes: open it with `openSource`, which `readJsonl` and the raw reader already use. Older sources without fingerprints are explicitly unverified. Do not claim that newline boundaries establish byte identity.

## Normalized Semantics

Use integer UTC microseconds for timestamps and durations. Mark whether a timestamp or duration is logged, derived or unknown. Missing usage stays missing; it is not zero. Distinguish inherited context, mirrored records and newly executed work before aggregating. Pair tool calls and results through logged identifiers when available, and retain unpaired records with diagnostics.

Do not turn command text, filenames or quoted error examples into observed failures. Logged error flags and process exits are structural observations. Text-based classifications are heuristics and need labeled positive and negative fixtures. The rule registry reports empirical audits separately from deterministic behavior; synthetic regression checks do not establish population precision.

## Conformance Checks

The conformance tests are not in this repository yet; an adapter must still meet what they check.

The shared conformance fixture verifies explicit root isolation, malformed-line accounting, partial-tail recovery, append fingerprints, stable identifiers and idempotent reindexing. Add source-specific fixtures for duplicate messages, out-of-order timestamps, missing call results, inherited history and deleted or rewritten files. Keep every fixture synthetic or deliberately sanitized.

For a new normalization or derivation rule, document the source field and unsupported cases. Bump the relevant schema or analysis version when semantics change. Captures hash the semantic contract, so source and compiled installations can reproduce each other's recorded analysis.

## Copilot Sources

The VS Code adapter replays JSONL mutation logs into chat-session documents and also reads older JSON documents. It prefers a JSONL file when both formats exist for the same session. Raw references cover the parsed file prefix because one normalized event can depend on several mutations. An unfinished invalid final line stays outside that prefix.

The `copilot-cli` adapter reads `~/.copilot/session-state/<id>/events.jsonl`, with workspace metadata from `workspace.yaml`, and older flat `<id>.jsonl` files. Newer VS Code agents also use this format. It pairs tool calls, permissions and hooks by their logged IDs. Subagent events remain in the parent session, and `parentToolCallId` links their tool spans. Tool durations measure the gap between start and completion, which can include approval waits.

Per-call tokens and model latency come from `session.usage_record.data.usage` in newer logs or retained `assistant.usage` events. The [Copilot SDK event schema](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts) marks `assistant.usage` as ephemeral, so older saved logs may omit these measurements. The adapter counts each usage identity once if both forms appear, using `accounting.usageId` or `apiCallId`, scoped by `accounting.sourceSessionId` when present. Duplicate records remain available as raw evidence. Tool output may also be stripped. Missing measurements stay missing; file edit snapshots and cloud coding-agent sessions are outside this adapter. The [VS Code mutation-log implementation](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts) defines the initial, set, push and delete entries.

Fresh VS Code 1.144.0 with bundled Copilot Chat 0.72.0 produced persisted usage records in a local agent session. Its token totals matched the VS Code response metrics. The same run logged `system.message`, `skill.invoked` and `skill.context_delivered_ref`. The adapter exposes bounded system and skill text as context events and preserves content references without opening external files.

The adapter links usage and assistant messages by `apiCallId` (or `requestId`) and links tools through `toolRequests[].toolCallId`. This keeps step usage, latency and tools together even when usage arrives before the message. Unmatched messages keep their own timestamp and no measured model duration. Copilot context-window capacity remains unknown; the Claude-specific estimate does not apply.

Run `agentshark index --agent cp` to read local Copilot logs. Use `agentshark capture --agent cp -o copilot.agentcap.zst` to preserve the indexed evidence and `agentshark open copilot.agentcap.zst` to inspect it later. Workspace-only metadata changes require `agentshark index --full --agent cp`.
