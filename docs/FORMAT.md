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
