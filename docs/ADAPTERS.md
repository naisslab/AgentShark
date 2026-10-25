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

Run `node --test test/adapters/conformance.test.ts` plus the adapter's own tests. The shared fixture verifies explicit root isolation, malformed-line accounting, partial-tail recovery, append fingerprints, stable identifiers and idempotent reindexing. Add source-specific fixtures for duplicate messages, out-of-order timestamps, missing call results, inherited history and deleted or rewritten files. Keep every fixture synthetic or deliberately sanitized.

For a new normalization or derivation rule, document the source field and unsupported cases. Bump the relevant schema or analysis version when semantics change. Captures hash the semantic contract, so source and compiled installations can reproduce each other's recorded analysis.
