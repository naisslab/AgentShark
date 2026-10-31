# Capture Evidence and Reproducibility

This guide is for researchers sharing datasets and engineers preserving a debugging session. A capture has three independent properties: whether its stream finished, whether expected evidence was included, and whether its integrity checks passed. The API reports these as `complete`, `coverage` and `integrity`.

<a id="record-host-resources-alongside-traces"></a>

## Record Session Resources Alongside Traces

In the native macOS app, open **Statistics > Resources** and click **Start recording**. AgentShark automatically discovers local agent processes and links them to indexed session IDs. Select sessions in the sidebar to inspect their totals; the agent summary groups processes by Codex, Claude Code, Claude Cowork or Copilot Chat. Recording starts at a 100 ms target without restarting the engine. The collapsed **Advanced: manual process binding** control adds or replaces a session's root PIDs while recording; **Detach** preserves its history. **Stop recording** stops the engine's resource recorder for every attached session and flushes pending measurements. Recording is off by default and stops when the engine quits.

For the web viewer, run `agentshark serve --record-resources` and open **Statistics > Resources**. To supply a manual binding at startup:

```bash
agentshark serve --record-resources --resource-session cx:SESSION-ID=12345
```

Use the exact indexed session ID. The binding can precede indexing. Repeat `--resource-session SESSION=PID` for several roots or sessions, with at most 16 roots in total. Manual bindings cannot assign the same root PID to two sessions. Automatic discovery can link a verified shared writer to several sessions and records that shared attribution. The viewer can attach or detach bindings while recording; detaching preserves stored history. The old `--resource-pid` option remains an unbound process counter under Host context and does not establish session ownership.

Discovery runs outside the 100 ms sampling path. On macOS it uses a bounded, low-priority native helper; Linux inspects writable `/proc` descriptors. It considers at most 8,192 indexed transcripts, 8,192 processes, 4,096 descriptors per process, 65,536 descriptors overall, 64 sessions and 16 roots. The scan has a 1.5-second enumeration budget and backs off from 10 to 60 seconds when expensive. Missing, inaccessible, remote or briefly opened transcripts may have no discoverable writer. The UI reports missing coverage and discovery limits; it never guesses a PID from names or working directories. New indexed sessions join on the next discovery pass. An established association survives transcript closure while the same process lifetime remains observable.

A manual binding must name a dedicated local process tree. Bind additional dedicated worker/service roots to the same session when needed. Automatic discovery matches writable transcript descriptors by device and inode and verifies process lifetimes before recording. It reads no transcript contents, commands or environment variables. Shared writers and their descendants are counted once across selected sessions; their totals include other sessions and cannot be apportioned by session ID. Remote hosts require a recorder on that host. Tool IDs such as Codex's background process session number are not OS PIDs. AgentShark does not infer ownership from those IDs, command names, working directories or overlapping timestamps. Old host-only samples remain host context and cannot become session measurements retroactively.

### Session Measurements

| Measurement | Scope and Meaning |
|---|---|
| CPU | User + system CPU time across every thread in each tracked process, converted to an interval percentage; 100% means one logical core, and totals can exceed 100% |
| RAM | Sum of resident bytes (RSS) across unique tracked processes; shared pages can be counted more than once |
| Disk I/O | Cumulative physical read/write bytes and interval rates for each process; unavailable permissions/counters remain unknown |
| GPU | Supported Linux NVIDIA process SM utilization and frame-buffer memory from `nvidia-smi pmon`; device-wide utilization, power and temperature are never attributed to a session |
| Network | macOS process summaries from a persistent PID-filtered `nettop`; reported process bytes and rates, with their own observation timestamps |

CPU/RAM/disk counters target **100 ms (10 Hz)**. `--resource-interval` accepts integer milliseconds from 100 to 60,000 and requires `--record-resources`. CPU deltas use monotonic elapsed time and verify process lifetime identity. New processes and reset counters start with unknown rates. macOS CPU counters convert the machine's Mach timebase before producing microseconds, following [Apple's own counter tests](https://github.com/apple-oss-distributions/xnu/blob/main/tests/recount/recount_perf_tests.c).

Fast Linux sampling reads only known `/proc/PID` paths. It checks thread child lists so children forked from non-leader threads can be found. macOS uses one small resident libproc helper, including native CPU, RSS, disk counters and child discovery. Each recorder tracks at most 128 processes. Child discovery runs once per second, with a global 128-thread discovery budget on Linux. Short-lived children can start and exit between discoveries, and CPU from those missed processes is unavailable. A reused root PID is rejected; known surviving descendants can continue after their parent exits. AgentShark excludes its own collector process tree.

Nested explicitly bound trees can share descendant membership. Selecting both sessions counts each process identity once. When discovery is truncated or known processes become inaccessible, the viewer marks partial coverage and leaves aggregate CPU/RAM/disk totals unknown. Per-process rows retain the observations that succeeded. This is sampled process-tree attribution, not complete kernel accounting of every transient process.

GPU and network probes run independently, at most once per second. They join verified PID lifetimes, discard unrelated processes, and retain their actual observation start time. Numeric results are emitted once. Availability errors can repeat with the original timestamp. NVIDIA process attribution requires the initial Linux PID namespace; unverified container PID mappings remain unknown. The namespace check uses the [Linux UAPI identifier](https://github.com/torvalds/linux/blob/master/include/uapi/linux/nsfs.h). NVIDIA support also depends on the driver and device; MIG/MPS and unsupported counters remain unknown. SM percentages stay separate per process because they can overlap. See [NVIDIA process-monitoring documentation](https://docs.nvidia.com/deploy/nvidia-smi/). On Linux, this lightweight collector does not install kernel network accounting, so per-process network traffic is unknown. macOS network summaries cover reported processes and can include loopback endpoints; the viewer labels these as observed counters. Windows session process counters and macOS Metal GPU counters are currently unavailable.

### Host Context and Live Display

The web viewer's separate **Host context** view retains whole-machine CPU, RAM, network, NVIDIA device counters, disk activity, memory pressure, swap, filesystem capacity, hardware/OS information and collection health. These values can include other applications. Temperature, power, free space and host memory pressure describe shared hardware and cannot be assigned to a session by PID. The native Resources tab presents session counters; host context is still recorded and included in captures.

`--resource-gpu auto` checks Linux runtime power state before touching the NVIDIA driver; asleep or unverifiable devices produce an availability reason. `off` skips GPU probes, including GPU metadata; `always` permits driver queries that can wake a GPU. No clocks, power or persistence settings change. GPU discovery is cached for one minute. Other platforms do not have the Linux sleep guard. The [Linux power interface](https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-devices-power) describes that check.

Host CPU and RAM are native OS reads. Host Linux network/disk/pressure can use the fast interval; host macOS network uses at most one command per second and disk/pressure at most one set per ten seconds. Filesystem capacity uses native calls once per minute for at most four paths. `--resource-path DIR` replaces the current/index-directory defaults. Filesystems are deduplicated by device; pending capacity requests are bounded and time out after one second without queuing another native request.

The viewer keeps 600 samples, fetches only new samples, reuses canvases and paints visible charts. Session projections are cached per sample. Tables render on demand. Live refresh stops while the workspace/tab is hidden. The requested rate and observed rate appear above the charts; slow sensors retain their freshness labels. Session selection follows explicit membership, including measurements after the last trace event. An explicit time range still bounds the chart. Display filters do not establish process ownership.

The native tab draws bounded Canvas paths for CPU, resident memory, disk I/O and network. It displays GPU availability and supported per-process GPU counters separately. Network freshness uses the actual observation time, rather than the 10 Hz UI clock. Process rows update at most once per second. Polling is single-flight, pauses when the window is occluded or the tab closes, and backs off after errors. The recorder continues collecting while the UI is hidden. Capture windows show stored measurements and offer no recording controls.

### Storage, Capture and Platform Support

Process rows use lossless numeric tuples with a per-frame dictionary for shared session membership. Each frame remains independently decodable. Historical readers accept both old and compact rows; exports retain the original capture schema. The native app opts into `format=compact` on resource requests. Other API clients receive the original schema.

One recorder runs per index. Fast mode batches writes about once per second with prepared statements and a 512 KiB SQLite page-cache target. Pending writes are limited to 100 samples and 1 MiB of serialized payload. The live tail retains at most 256 samples and 1 MiB. These payload limits do not bound the entire JavaScript heap. Writer contention never waits: a bounded batch retries and overflow counts as skipped. Slow mode retains immediate writes. Graceful shutdown flushes pending samples; an abrupt exit can lose roughly the last second, or the pending queue during contention.

Fast scheduling budgets at most 5% elapsed duty for the fast tick and batch storage; slower modes retain the earlier 1% target. Background probes have separate cadence and output/time bounds. Slow ticks reduce the effective rate without catch-up bursts. These are scheduling targets, not CPU or battery guarantees. Utility failures back off. Packet contents, connections, process names, commands and environment variables are not retained.

macOS builds include a universal native helper when Command Line Tools are available. A source checkout or package built on another OS can compile the included helper once on first attachment. Without a helper or compiler, session counters report unavailable. The helper uses bounded stdio requests and output, runs at reduced priority where permitted, and exits with the recorder. macOS network uses one persistent `nettop` instance rather than launching it every second. Up to 20 processes use native PID filters. Larger trees use one process-summary sampler and filter rows inside the native helper, which emits only selected PIDs and counters. Changes to that PID filter reuse the running collector. Host network context uses a separate sleeping helper that reads the public 64-bit interface MIB once per second. Process counters verify lifetime at 10 Hz; parent metadata refreshes with child discovery at 1 Hz. A native PTY proxy ensures frames flush promptly and terminates the network child on shutdown. A network frame is emitted after its next CSV header, adding about one second of framing delay; the original observation timestamp remains visible.

Captures include committed resource samples and recording context by default; `capture --no-resources` omits both. Scoped exports select new measurements by bound session identity, not temporal coincidence, and strip unrelated attached session bindings/process counters. Host context remains shared and can include other applications. Legacy host-only context keeps temporal selection. Shareable captures pseudonymize session IDs, process IDs and lifetime identities consistently with the trace records. They retain numeric resource measurements. Context and health checkpoint at startup, about once per minute, after binding changes/recovery and on graceful shutdown. Samples remain in the index without automatic retention limits.

`GET /api/resources` uses normal viewer authentication and accepts `scope=session|host`, `sessions`, `from`, `to`, `limit` (1–5,000), `order`, and `after`. With `scope=session`, selection requires recorded membership; host context uses time overlap. For compatibility, stored resource containers retain `scope: "host"` and their original host fields; the `sessionResources` object contains the attributed process data. Session charts exclusively read that object. `live=1` reads the bounded recent tail in ascending order, including pending samples, with a `cursor` for the next delta. `reset: true` asks the client to reload history. `POST /api/resources/bind` accepts `{session, roots}` in live recording mode; empty roots detach the binding. Capture mode reads embedded measurements and never samples the recipient's machine.

`POST /api/resources/recording` accepts `{enabled: true, bindings?: [{session, roots}]}` or `{enabled: false}` with the same authentication. Omitting bindings enables automatic discovery. Passing bindings, including an empty array, chooses manual recording. Initial bindings are validated before starting. An active recorder accepts an idempotent start without bindings; use the binding endpoint to change its processes. Concurrent changes, a recorder owned by another process, and capture-mode writes return 409. `canRecord` in resource responses tells clients whether controls are available. An idle live-tail request returns an empty delta without querying history.

### Measured Recorder Overhead

The 2026-10-30 comparison used this Mac, prebuilt native helpers, an isolated index, and the same idle 41-process tree attributed to 12 synthetic sessions. Two 20-second runs per version compared commit `7e649bd` with native build 287. GPU probing was off. Every run had zero skipped samples.

| Measurement | Before | Build 287 |
|---|---:|---:|
| Mean serialized bytes per sample | 37,910 | 6,127 |
| Mean final SQLite size | 8.23 MB | 1.91 MB |
| Peak RSS, including historical readback | 100–107 MiB | 72–80 MiB |
| Node CPU, percentage of one core | 1.43–1.72% | 1.16–1.65% |
| OS user + system CPU, including startup and helpers | 0.90–1.00 s | 0.70–0.98 s |
| Observed process sample rate | 9.89–9.95 Hz | 9.97–10.00 Hz |

Sample payloads shrank by 84% and final database size by 77%. CPU differences were smaller and varied between runs. These runs isolate recording with fixed bindings; they exclude discovery, trace indexing, UI rendering and the workload's own CPU. Peak RSS includes a final readback of recorded history, not just retained live samples.

A separate optimized Swift decoding benchmark decoded 4,000 equivalent frames with 41 processes and 12 shared sessions. Decode time fell from 0.962 to 0.237 seconds (75%); frame size fell from 37,146 to 5,225 bytes. This measures decoding alone, not total UI CPU.

A 30-second session run on the same Apple M4 Pro tracked a separate parent/child workload, including functioning persistent macOS process-network collection. It stored 299 base samples and 293 attributed process observations (startup included), averaging 9.79 Hz. Node used 287.9 ms CPU, about 0.96% of one core; OS user + system CPU was 1.18 seconds, including startup and collector helpers. The observed workload used roughly 7.7% of one core, reported separately from recorder overhead. Measurement JSON was 481,704 bytes. This run excludes browser rendering, trace indexing and the workload's own CPU from overhead. It does not measure NVIDIA or Linux process-tree cost. The UI reports observed cadence rather than guaranteeing real-time delivery under load.

The earlier host-only measurements below provide context; they do not include session process attribution.

The 10 Hz recorder benchmark uses an isolated index and real OS counters. It excludes trace indexing and browser rendering. `nodeCpuMs` measures Node CPU in the recording window. OS `time` also includes process startup, cleanup and utility subprocesses. RSS includes Node itself and its runtime; it is not incremental recording memory.

A 30-second run on an Apple M4 Pro (14 logical cores, 48 GiB RAM), with GPU auto mode and process tracking off, recorded 300 samples with zero skips. A separate run exercised a 10 Hz HTTP delta client against the live server:

| Measurement | Recorder Only | Recorder + Server + Node HTTP Client |
|---|---:|---:|
| Stored samples | 300 | 300 |
| Node CPU during recording window | 226.9 ms (0.76% of one core) | 913.4 ms (3.03% of one core) |
| OS user + system CPU, including startup and utilities | 0.61 s | 1.59 s |
| Stored measurement JSON | 251,944 bytes | 251,922 bytes |
| HTTP responses / total bytes | Not applicable | 301 / 598,549 bytes |
| Mean / maximum HTTP request duration | Not applicable | 1.75 / 14.89 ms |

These are local measurements, with no NVIDIA device queries, browser rendering or trace indexing. The HTTP column includes client CPU and the server's existing query worker. Startup is included in OS time, so that column is not a steady-state overhead percentage. Short runs are sensitive to scheduling noise. The measured JSON size extrapolates to roughly 30 MB per hour before SQLite index and row overhead.

For long recordings, choose a slower interval if storage growth matters. Samples remain in the index without automatic retention limits. Hardware refresh, NVIDIA overhead, battery impact, and Linux process-tree cost require measurement on the target host.

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
