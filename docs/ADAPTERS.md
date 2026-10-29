# Adapter Contract

This guide is for contributors adding a trace source. An adapter discovers explicitly scoped files and emits normalized records through `RecordSink`. Register it in `src/adapters/registry.ts`; the registry resolves duplicate paths in order. Runtime loading of third-party code is not part of this contract.

## Evidence and Identity

Use `sourceId`, `eventId` and `spanId` from `src/adapters/adapter.ts`. Keep raw byte offsets and lengths exact. Several normalized events may reference one source line; distinguish their block indexes. Preserve unknown records as `raw.unknown` and count malformed complete lines. An unfinished final JSON line must remain available for a later append.

`ParseStats.sha256` identifies the original bytes from offset zero through `parsedBytes`. `readJsonl` computes this while parsing, including CRLF and blank lines and excluding an unfinished invalid tail. JSON-document adapters hash the exact Buffer they parse. Never hash a later reread and call it the parsed evidence. A state database may omit the fingerprint when its evidence cannot be represented as one stable file prefix.

The raw reader verifies that indexed prefix before serving evidence. Appends are allowed; rewrites require reindexing. A zstd source (`.zst`) is parsed, hashed and served as its decompressed bytes: open it with `openSource`, which `readJsonl` and the raw reader already use. Older sources without fingerprints are explicitly unverified. Do not claim that newline boundaries establish byte identity.

## Normalized Semantics

The Antigravity adapter reads `conversations/*.db` under `~/.gemini/antigravity` and `~/.gemini/antigravity-ide`. It prefers the app copy when both folders contain the same conversation filename. The adapter uses protobuf field numbers from the installed language server's descriptors, so support remains partial and version-dependent. Older encrypted `.pb` conversations are excluded.

Databases open with `immutable=1`: uncheckpointed WAL rows are not visible. Antigravity events reference the database and step index with a zero-length raw reference. The detail view contains selected decoded metadata, not a recoverable raw step. Unsupported step types emit `raw.unknown`; malformed rows emit diagnostics while other rows remain readable. Unchanged database files use size, modification time and inode for incremental indexing, as Codex state databases do. Changes only to `conversation_summaries.db` appear when the conversation is reparsed, including with `index --full`.

Use integer UTC microseconds for timestamps and durations. Mark whether a timestamp or duration is logged, derived or unknown. Missing usage stays missing; it is not zero. Distinguish inherited context, mirrored records and newly executed work before aggregating. Pair tool calls and results through logged identifiers when available, and retain unpaired records with diagnostics.

Do not turn command text, filenames or quoted error examples into observed failures. Logged error flags and process exits are structural observations. Text-based classifications are heuristics and need labeled positive and negative fixtures. The rule registry reports empirical audits separately from deterministic behavior; synthetic regression checks do not establish population precision.

## Conformance Checks

The conformance tests are not in this repository yet; an adapter must still meet what they check.

The shared conformance fixture verifies explicit root isolation, malformed-line accounting, partial-tail recovery, append fingerprints, stable identifiers and idempotent reindexing. Add source-specific fixtures for duplicate messages, out-of-order timestamps, missing call results, inherited history and deleted or rewritten files. Keep every fixture synthetic or deliberately sanitized.

For a new normalization or derivation rule, document the source field and unsupported cases. Bump the relevant schema or analysis version when semantics change. Captures hash the semantic contract, so source and compiled installations can reproduce each other's recorded analysis.
