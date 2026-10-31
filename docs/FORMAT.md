# AgentCap Capture Format, Version 1

An AgentCap file (`.agentcap`) is a self-contained, append-friendly recording of one or more agent sessions. It plays the role a pcap file plays for packets, but its structure follows agent concepts. A capture holds:

- the normalized records AgentShark derives (sessions, events, spans, expert diagnostics);
- the original source bytes of every record, so the capture stays useful after the agent deletes or rewrites its own logs;
- side files the records reference (persisted tool outputs, workflow summaries, subagent metadata), stored once by content hash.

## 1. Encoding

- **Text**: UTF-8 JSON Lines. Every line is one JSON object with a `rec` discriminator. Lines end with `\n`.
- **Compression**: optional, applied to the whole stream. `.agentcap.zst` means zstd and `.agentcap.gz` means gzip. Readers detect compression from the magic bytes, not the extension: zstd starts `28 B5 2F FD` and gzip starts `1F 8B`.
- **Order**: the first line must be the `capture` header and the last line must be the `end` trailer. Between them, `source`, `session`, `event`, `span`, `expert`, `enrich` and `blob` records may appear in any order. Writers emit them grouped per session (session record, then its events in sequence, then its spans and expert records) so that a reader can stream one session at a time.
- **Numbers**: timestamps and durations are integer microseconds (§3.2 of `SPEC.md`). Token counts are integers.
- **Unknown fields**: readers must ignore record types and fields they do not recognize. Writers must never reuse a field name with a different meaning in the same major version.

Resource recording adds optional `resource` records under version 1. Older readers skip them. Their TypeScript contract is `ResourceSample` in `src/resources/types.ts`: `id` uniquely identifies a sample, `recording` groups one recorder lifetime, `scope` is `host`, and `ts` uses epoch microseconds. `elapsedMs` and `intervalMs` use monotonic milliseconds, with a null interval for the first sample. Measurements carry units in their field names. Missing readings use null values and `unavailable` reasons. Host containers have no source or session foreign key; host correlation is temporal. Optional attributed session data uses explicit binding membership, as described below.

When included, the header has `options.resources: true` and the trailer has `counts.resources`. Resource records participate in stream integrity, count checks, duplicate ID checks and atomic import. Shareable exports pseudonymize sample IDs, recording IDs and interface names while preserving numeric values. See [resource recording](CAPTURES.md#record-session-resources-alongside-traces) for collector semantics and selection.

Optional `pressure`, `disk`, `filesystems`, `processes`, `health` and `observed` fields extend resource samples. `observed` maps an asynchronous metric name to its observation start time in UTC epoch microseconds. Fast samples emit each completed probe once; a missing `observed.network` or `observed.gpu` with a null value means no new probe result. Availability reasons distinguish failed observations. Historical samples without `observed` use the enclosing sample timestamp. A field absent between its scheduled observations means no new measurement was made. Null denotes a failed or unsupported observation; individual unavailable counters are also null. Disk and pressure counters use actual elapsed time for rates and reset their baselines after failures. Process CPU time is cumulative microseconds, RSS is bytes, and `startId` distinguishes PID lifetimes.

Optional `sessionResources` holds verified automatic or explicit manual `bindings` and unique process `entries`, per-process CPU percentages and disk rates, lifetime identities, descendant coverage, and unavailable-process ownership. CPU percentages use one logical core as 100% and can exceed 100%. `observed.sessions` timestamps that asynchronous process observation. Optional `gpu` and `network` observations within the frame carry their own `ts`, fixed availability reasons and PID-lifetime joins. Session selection uses binding membership and prunes unrelated processes. Missing or partial coverage never substitutes host CPU/RAM. Automatic bindings add `discovered: true`, `agent`, aligned `starts` (root process lifetimes), and `shared`. A process entry may carry `shared: true`; this flag survives session filtering so a shared process never appears exclusive after export. Bindings support up to 64 sessions, 16 unique roots and 128 process entries. Recording context can include optional `sessionBindings`; shareable exports pseudonymize those session and process IDs consistently with samples and trace records.

`resource-recording` records contain `id`, `startedTs`, nullable `stoppedTs`, `context`, and `health`, as defined by `ResourceRecording` in `src/resources/types.ts`. Their ID matches the sample's `recording`. They describe the collecting host independently of the capture header's exporting host. They participate in stream integrity and duplicate/count checks (`counts.recordings`). Old captures can lack these records. Shareable exports pseudonymize hostnames, paths, devices, numeric process IDs and process start identities consistently across metadata and samples.

## 2. Records

### 2.1 `capture` (header, first line)

```json
{"rec":"capture","format":"agentcap","version":1,
 "created":1791729600000000,
 "tool":{"name":"agentshark","version":"0.1.0"},
 "host":{"hostname":"…","platform":"darwin","arch":"arm64","osRelease":"…"},
 "scope":{"agents":["claude-code","codex"],"since":1791100000000000,"until":null,"sessions":null,"filter":null,
          "resolved":{"sessions":30,"sources":12},"index":"/Users/u/.agentshark/index.sqlite"},
 "options":{"raw":true,"sidecars":true}}
```

`scope` records how the capture was selected, what the selection resolved to, and the index it was read from. `options.raw = false` means the event records carry no `raw.text`. A capture is not anonymized: besides the raw lines it holds the normalized text (prompts, responses, tool input and output), paths and the host name.

### 2.2 `source`

One record for each file the capture draws from. Its fields match the `SourceRec` type in `src/model/types.ts`.

```json
{"rec":"source","id":"s_3f9a0c1b2d4e","agent":"codex","kind":"rollout",
 "path":"/Users/u/.codex/sessions/2026/10/11/rollout-….jsonl",
 "size":1048576,"mtimeMs":1791729500000,"ino":123456,
 "lines":812,"malformed":0,"unknown":3,"skipped":0,"inherited":24,
 "dialect":"codex@0.162.0","sha256":"…"}
```

`sha256` covers the bytes the parser consumed: the file prefix up to the last complete line.

### 2.3 `session`, `event`, `span`, `expert`, `enrich`

These records use the TypeScript shapes `SessionRec`, `EventRec`, `SpanRec`, `ExpertRec` and `EnrichRec` from `src/model/types.ts`. They are the records adapters emit, plus one optional field: `session`, `span`, `expert` and `enrich` records carry `src`, the id of the `source` record that contributed them (events name their source in `raw.source`). Readers that find no `src` attribute the record to the source of its first event, then to the source of the session's events, then to a placeholder source `capture`.

For an `event`, the `raw` pointer gains one extra field in a capture:

```json
"raw":{"source":"s_3f9a0c1b2d4e","line":812,"offset":2452908,"length":1534,"block":0,
       "text":"{\"timestamp\":\"2026-10-11T09:37:04.777Z\",…}"}
```

- `text` holds the exact source line, without the trailing newline. Base64 images and encrypted blobs inside it are kept as-is, so the capture is lossless.
- When one source line produces several events (Claude multi-block lines), only the first event of that line (`block` 0) carries `text`. The others refer to it through the same `source` and `line`.
- With `options.raw = false`, `text` is absent.

### 2.4 `blob`

```json
{"rec":"blob","sha256":"…","size":48213,"mediaType":"text/plain","encoding":"utf8",
 "origin":{"path":"/Users/u/.claude/projects/…/tool-results/abc123def.txt","role":"persisted-output"},
 "data":"…"}
```

- `encoding` is `utf8` or `base64`.
- `origin.role` is one of `persisted-output`, `subagent-meta`, `workflow-summary`, `workflow-journal`, `file-backup`, `image` or `registry`.
- Events refer to a blob by its `sha256` through `attrs.blob_refs[]`. Writers store each distinct blob once.

### 2.5 `end` (trailer, last line)

```json
{"rec":"end","counts":{"sources":12,"sessions":30,"events":48211,"spans":20113,"expert":311,"blobs":40,"rawUnavailable":3},
 "complete":true,
 "coverage":{"rawUnavailable":3,"rawUnavailableBySource":{"s_3f9a0c1b2d4e":3},"rawOmitted":false,
             "sidecarsOmitted":[{"path":"/Users/u/.claude/projects/…/tool-results/big.txt","role":"persisted-output","reason":"too-large"}],
             "known":true}}
```

`complete` says only that the writer reached the end of the stream. `complete: false` (or a missing `end` line) means the writer stopped early; readers must still load everything before the break and report the capture as truncated, on every open.

`coverage` says which evidence the writer could not include, independently of `complete`:

- `rawUnavailable`: source lines whose bytes could not be read (the file was deleted or rewritten after indexing), in total and per source. These events have no `raw.text`.
- `rawOmitted`: the capture was written with `--no-raw`.
- `sidecarsOmitted`: side files left out, with `reason` `missing`, `too-large` (over 64 MiB), `credential` or `unreadable`.

Captures written before coverage existed have no `coverage`; readers report it as unknown (`known: false`), not as complete.

## 3. Reading a capture into the viewer

`agentshark open FILE` streams the capture into a capture index (`~/.agentshark/captures/<sha1>.sqlite`), using the same schema as the live index. Raw lines go into the `raw_store` table, so raw-pane lookups work without the original files. Blobs go into the `blobs` table and are served through `/api/file?blob=<sha256>`.

## 4. Versioning

- `version` is an integer that changes only for incompatible changes.
- New optional fields and new record types may be added within a version.
- A reader rejects a capture whose major version is newer than the one it supports, with a clear error.
