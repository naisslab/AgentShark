# Capture Evidence and Reproducibility

This guide is for researchers sharing datasets and engineers preserving a debugging session. A capture has three independent properties: whether its stream finished, whether expected evidence was included, and whether its integrity checks passed. The API reports these as `complete`, `coverage` and `integrity`.

## Forensic and Shareable Profiles

The default `forensic` profile preserves normalized records, available raw lines and sidecar files. It can contain prompts, source code, outputs, private paths and credentials printed by tools. `--no-raw` removes original lines, but normalized text may still contain the same information.

The `shareable` profile preserves event relationships, timestamps, numeric usage and structural statuses. It removes raw lines, sidecars, native records, arbitrary text and unrecognized metadata. Source paths and identifiers become keyed pseudonyms. Tool names and descriptions become opaque tokens. This reduces the evidence available to text-based rules; the manifest identifies the evidence as redacted. Timings and usage remain visible by design.

Preview an export before writing it:

```sh
agentshark capture --profile shareable --preview
agentshark capture --profile shareable -o study.agentcap.zst
```

Each export uses a fresh random identity key unless a key file is supplied through `--redaction-key-file`. Reusing a secret key preserves pseudonyms for matching identifiers across exports. The file must contain at least 16 bytes. The capture stores a nonsecret key identifier, never the key. Forensic previews contain counts only; shareable previews contain transformed sample records and an omission report.

## Source Identity and Snapshot Consistency

Export holds a SQLite read snapshot across selection and every record read. A concurrent live indexer can keep writing without mixing database generations in the capture.

Adapters hash the exact source bytes they parse. The raw reader checks that prefix before returning evidence. Appending to the file is permitted. A same-length rewrite fails verification, as does replacing earlier source content. Missing raw lines are recorded in coverage instead of silently substituting new evidence. Legacy sources without indexed fingerprints remain unverified until reindexed.

Captures add SHA-256 hashes to embedded raw lines and blobs. Their trailer hashes the preceding uncompressed JSONL stream and records its record count. These checks detect content changes and corruption; they do not authenticate the publisher.

## Recorded Analysis and Reanalysis

The analysis manifest records the index schema, analysis/signature versions, rule registry digest, thresholds, fixed clock and database generation. Its semantic digest is the same in source and compiled distributions. Contributors must bump the schema or analysis version when normalization or rule semantics change.

`open --analysis recorded` reconstructs findings using the recorded settings and clock. This is the default when a manifest exists. A different semantic implementation is rejected with instructions to opt into reanalysis. `open --analysis current` explicitly uses the installed rules and default thresholds. The original manifest remains available beside the effective mode.

Reproducibility applies to the evidence embedded in the capture. A filtered or redacted export can have fewer observations than its source index. Captures written before manifests existed use current analysis and identify that limitation in their metadata.

## Integrity and Recovery

Import verifies the stream checksum, raw-line hashes, blob hashes and sizes, duplicate identifiers, declared record counts, and source/session references. A corrupt manifested capture is rejected atomically, leaving the previous index intact. `open --integrity recover` imports surviving records and explicitly marks integrity as failed. A truncated capture without its end marker remains incomplete and unverified.

The library also accepts `maxRecordBytes` and `maxDecodedBytes` import limits. Defaults are 128 MiB per record and 4 GiB of decoded input. Applications importing larger trusted corpora can raise these limits explicitly.

## Library Interface

`writeCapture(db, options)` adds `profile`, `redactionKey`, `dryRun` and `previewLimit` options. `previewCapture(db, options)` returns counts, a sanitized sample for the shareable profile, estimated uncompressed bytes and an omission report without creating a file.

`loadCapture(path, db, onProgress?, options?)` accepts `analysis`, `integrity` and the byte limits. The returned object includes effective analysis settings and integrity results. HTTP `/api/info` exposes them through `capture.analysis` and `capture.integrity`. Raw responses identify available evidence with `verification`; captured lines also include `captureIntegrity`, so embedded storage never implies a passing integrity check.
