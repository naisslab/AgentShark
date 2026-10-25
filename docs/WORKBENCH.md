# AgentShark Workbench

The Workbench serves engineers debugging runs and researchers building trace datasets. It reads the indexed record of an execution. It does not run agent commands, infer a hidden prompt, or use a model to judge task success. Running recorded commands again is `agentshark replay` ([REPLAY.md](REPLAY.md)); the Workbench shows a replay's plan before it runs and its report after.

Open Workbench from the web viewer's toolbar, or in the macOS application with Analyze ▸ Open Research Tools in Browser, which opens it in the default browser, where downloads and file inputs work. The Mac draws two of the tools natively: Critical Path (AgentPerf) and Compare Runs (AgentDiff) are its Session modes Critical Path (⌥⌘4) and Compare (⌥⌘5), which read the run selected in the sidebar. Analyze ▸ Explore Bundled Demo opens the Workbench of a synthetic sample in a window of its own.

Select a session, choose an analysis and follow its evidence links back to the event viewer. Each link opens the viewer in a new tab, so the result stays on the page. Saved recipes contain a request, not copies of trace records. Browser recipes stay in local storage; export a recipe JSON file to keep or share it. A loaded recipe's `session`, `sessions`, `left` and `right` set the session pickers, which always decide those four fields over the Advanced Request JSON. Human labels remain in memory until downloaded.

The page lists its tools by the question they answer and opens on Critical Path:

| Group | Tools (operation) |
|---|---|
| Where did the time go? | Critical Path (`perf`), Cache Anatomy (`cache`), Span Dependencies (`profile`) |
| What did the agent see and change? | Context Inspector (`context`), Change and Verification (`verification`), Localization Map (`localization`), Capability Envelope (`capabilities`) |
| Two runs | Compare Runs (`diff`), Compare Records (`compare`) |
| Patterns and checks | Sequence Search (`search`), Behavioral Checks (`checks`), Agent Coordination (`coordination`) |
| Datasets and export | Dataset Builder (`dataset`), Research Cohorts (`cohort`), Table Export (`exportTable`), Telemetry Export (`exportTelemetry`) |
| Investigation and replay | Investigation (`investigation`), Replay Plan (`replayPlan`), Replay Report (`replayReport`) |

"Compare Runs" means AgentDiff in both clients. Span Dependencies and Compare Records each carry a pointer to the tool that answers their usual question: Span Dependencies "follows only dependency edges a span records", so where a run's time went is Critical Path; Compare Records "aligns raw records by kind and tool name", so two runs of one task are Compare Runs. The operation names in the CLI, HTTP and MCP stay `profile` and `compare`. Session pickers read "{title} · {date time} · {agent}", so two runs with one title stay apart; the Compare Runs pickers list top-level runs only, and Run B starts empty.

## Evidence and Confidence

Each response has `schemaVersion: agentshark.workbench.v1`, `analysisVersion`, `coverage` and `sessions`. Coverage reports the selected sessions, available and examined event counts, truncation, gaps, index analysis version and snapshot clock. Its `notes` hold one sentence per gap, in the order of `gaps`, from one table (`src/workbench/gap-text.ts`) with this result's figures filled in, so every client words a gap alike; the code is for tooltips and programs. A note's `permanent` is true for a limit of the method or the logs that every result of the analysis carries whatever its data (`logs-do-not-establish-complete-execution`, `queue-time-not-logged`, `alignment-is-structural-not-causal`, `shell-changes-invisible`), so a client can keep it off a count of data gaps. `sessions` names each session in `coverage.sessionIds`: `title`, `agent`, `role`, `parentId`, `rootId` (the top of its run), `startTs` and `endTs`, so a client can title runs and subagents without another request; under a permitted scope it holds only permitted sessions. A single analysis reads a consistent SQLite snapshot. HTTP analyses run in the query worker pool with a deadline; requests examine at most 50,000 events and 500 selected sessions.

| Confidence | Meaning |
|---|---|
| `observed` | A recorded event supplies the stated evidence. |
| `derived` | A documented calculation or alignment uses recorded evidence. |
| `candidate` | A pattern warrants human review; alternative explanations remain. |
| `unknown` | The required evidence is absent, incomplete or ambiguous. |

Both clients show the categories as marks after a value in Critical Path and Compare Runs: none for `observed`, `≈` for `derived`, `?` for `candidate`, and `—` with its reason for `unknown`. A mark's tooltip says what it qualifies and "Precision not yet checked.", and names the rule where the result gives one. These labels are categories, not probabilities. Synthetic regression tests validate known cases and failure handling. They do not establish population precision on real research workloads. Context reconstruction, action alignment, possible stale reads and file verification therefore retain explicit limits.

## CLI and HTTP

```sh
agentshark analyze context --session 'cx:SESSION'
agentshark analyze compare --left 'cx:BASELINE' --right 'cx:CANDIDATE'
agentshark analyze coordination --session 'cx:SESSION'
agentshark analyze verification --session 'cx:SESSION'
agentshark analyze profile --session 'cx:SESSION'
agentshark analyze search --input sequence.json --out findings.json
agentshark analyze exportTable --session 'cx:SESSION' --table events --format csv
agentshark analyze investigation --session 'cx:SESSION' --title 'Why did verification stop?'
agentshark analyze replayPlan --session 'cx:SESSION'
agentshark analyze replayReport --input replay.jsonl
agentshark analyze localization --session 'cx:SESSION'
agentshark analyze diff --left 'cx:BASELINE' --right 'cx:CANDIDATE'
agentshark analyze perf --session 'cx:SESSION'
agentshark analyze cache --session 'cc:SESSION'
agentshark analyze capabilities --session 'cx:SESSION'
```

`--input` accepts the request object. Explicit flags override fields from the file. `--session` can repeat. `--out` creates a file with owner-only permissions and refuses to overwrite an existing file. Standard output is JSON, including table exports: their `content` field contains CSV or JSONL, alongside provenance and coverage. The browser offers a separate Download Table action.

The authenticated HTTP equivalent is `POST /api/workbench/OPERATION` with a JSON object. Use the running server's cookie or `X-AgentShark-Token` header. Bodies are limited to 1 MiB, except `replayReport` (16 MiB). `GET /api/workbench` lists supported operations. Single-session operations take `{ "session": "cx:SESSION" }`; the two-run operations take `left` and `right`. Other operations use `sessions`, except dataset selection, which uses `sessionIds`. A refused request is HTTP 400 with an `error.code` that names the cause: `session-not-found`, `session-tree-limit` (more than 500 sessions in a run), `row-limit` (a derived table holds more rows for the run than the event limit; its message is a sentence for people) or `workbench-input`; an unknown operation is `workbench-operation`. A job past the 30 s query deadline is HTTP 503 `query-timeout`.

MCP exposes `analyze_trace` for context, comparison, checks, coordination, verification, search, profiling, cohorts and the five agent-native analyses below. Its request has `operation` and `input`. Project scope applies to every session and evidence reference. All returned text becomes a redacted, length-limited `*_excerpt` field. Complete research exports remain available through the local CLI and Workbench.

## Context and Comparison

Context requests accept `atEventId` or `stepId`, plus `limit` up to 500. The response separates recorded context records from transcript reconstruction. Compaction shows a recorded boundary; the app cannot establish which details the next model request retained. Stale-read candidates are the files another writer changed after the session last read or wrote them (`stale-view@1`); the session's own edits are never stale.

Compare Records (`compare`) aligns action signatures across two sessions with a bounded sequence alignment. It reports changed, unchanged and unmatched actions, ambiguity and metric differences. Repeated actions can have several plausible alignments. Matching signatures do not establish equivalent repository state, model inputs or outcomes.

## Behavioral Checks in CI

```sh
agentshark check --session 'cx:SESSION' --input checks.json --out check-report.json
```

```json
{
  "rules": [
    "tests-after-edit",
    "unresolved-delegations",
    { "rule": "repeated-failed-actions", "threshold": 3 },
    { "rule": "token-budget", "threshold": 100000 }
  ]
}
```

Exit codes are **0 pass**, **1 fail**, **2 invalid request**, and **3 unknown**. Any failure takes precedence over unknown results. An empty result never passes. Unknown token counts, missing completion evidence, trace gaps and missing verification can prevent a pass. A recorded exceedance or explicit unsuccessful result can establish a failure even when other evidence is missing.

`tests-after-edit` uses test runs recognized by `check-run@1` on shell calls and Codex `exec_command` items, as the claim check does, after recorded edits. A run's outcome follows the claim check too: a failure or suspect tier fails it (a piped `pytest | tail` fails through `tests-failed@2`), and a background launch waits for its process's exit and considers the latest recognized outcome. It does not measure line or file coverage. Custom runners and edits hidden inside shell commands may be unrecognized. `unresolved-delegations` distinguishes explicit unsuccessful outcomes from absent completion or delivery evidence. `repeated-failed-actions` reads failure episodes on an analysed index: it fails when an episode has `threshold` consecutive attempts with identical inputs and no edit between them, as the `blind-loop` alarm does. On an index the analysis pass has not run, it requires matching indexed inputs and explicit unsuccessful results, and a successful intervening action resets the streak. `token-budget` uses a session's own recorded input and output counters.

## Sequence Search

```json
{
  "sessions": ["cx:SESSION"],
  "sequence": [
    { "kind": "tool.result", "failure": true },
    { "kind": "tool.call", "tool": "exec_command", "textIncludes": "test" }
  ],
  "withinUs": 60000000,
  "maxGapEvents": 30,
  "limit": 100
}
```

Predicates support `kind`, `tool`, `textIncludes`, `exitCode`, `failure`, `repeat`, and `sameAsPrevious` for `tool` or `target`. Time windows are microseconds. Matching preserves recorded ordering within sources; reconstructed cross-source ordering remains a coverage gap. A missing failure status does not satisfy `failure: false`.

## Coordination and Profiling

Coordination joins the recorded session tree with delegation and file activity. It resolves relative paths against each session's working directory before comparing files. Overlapping file activity remains a candidate. A stale read is an edit a session made after another writer changed the file, without reading it again (`stale-view@1`, cause `changed-elsewhere`); a fresh read in between clears it. The trace may omit synchronization or context that explains the behavior.

Span Dependencies (`profile`) reports recorded spans, their interval union, overlapping categories and unattributed time. Containment and dependency edges are separate. Only observed dependency edges contribute to its longest observed dependency path. That path is not a proven critical path of the entire execution; missing dependencies and timing prevent that conclusion.

## Agent-Native Analyses

Five analyses read one normalized stream of actions: each tool call classified by operation, made comparable across working directories, and tied to the version of each file it read or wrote. They share its rules: `stale-view@1` for files changed without knowing their current version, and the rework rules `reread@1`, `revert@1`, `blind-retry@2`, `repeat-search@1` and `fix-loop@1`. Each single-run analysis covers the selected session and its descendants.

| Operation | Analysis | Request |
|---|---|---|
| `localization` | Localization Map: milestones to the files a run changed, explored files, blind edits | `{ "session", "scope": "turn" \| "run" }` |
| `diff` | Compare Runs (AgentDiff): weighted alignment of two runs, first divergence, regions, failure responses | `{ "left", "right", "limit", "children" }` |
| `perf` | Critical Path (AgentPerf): critical path through waits on people, processes and subagents; rework time; work and span | `{ "session" }` |
| `cache` | Cache Anatomy: prompt-cache reuse, breaks and their logged or derived causes | `{ "session", "idleMinutes" }` |
| `capabilities` | Capability Envelope: sandbox, approval and network grants against observed commands, writes and network use | `{ "session" }` |

The rework rules describe repetition and undoing, never waste. The first divergence of two runs is a lead for an experiment, not a cause. AgentPerf lists the timing it lacks (`missing`) instead of guessing, and the Capability Envelope never writes agent configuration.

## Replay Plans and Reports

Replay asks whether the recorded actions produce the same results in a controlled environment. It runs the recorded tool calls open-loop in a Docker container; no model is called ([REPLAY.md](REPLAY.md)).

**Replay Plan** (`replayPlan`, `{ "session": "cx:SESSION", "limit": 2000 }`) shows what `agentshark replay` would do without running anything: how many calls would execute, which are skipped and why, whether full inputs came from raw records or the index, the projected duration at recorded and maximum speed, and the command to run. Every planned call links to its recorded event. Codex code-mode scripts appear with the commands and file changes they ran. Use the plan to choose sessions that are worth replaying: `external` and `process` skips mark calls whose effects a replay cannot reproduce, and a `script` skip marks a code-mode script whose own logic is not run, although its commands and file changes are.

**Replay Report** (`replayReport`) reads the JSON lines that `agentshark replay --json` or `-o FILE` wrote, as `records` (the parsed lines) or `jsonl` (their text). It joins each call to its recorded event and reports verdict counts, the environment the replay ran in, the divergence point (the first call whose status differs) and every call with its recorded and replayed status. The browser trims replayed output heads before sending a report. Calls whose events are missing from this index keep their verdict without evidence and add the gap `report-events-missing-from-index`.

A status difference says that the same action had another outcome in the replay environment; it does not say why. Every call after the divergence point ran in a state the recording never saw. Output differences are common across machines and images.

## Research Manifests and Labels

```json
{
  "schemaVersion": "agentshark.manifest.v1",
  "id": "test-runner-comparison",
  "title": "Test runner comparison",
  "runs": [
    {
      "sessionId": "cx:SESSION",
      "taskId": "repair-001",
      "condition": "baseline",
      "trial": 0,
      "seed": 42,
      "split": "train",
      "taskGroup": "repair-001",
      "model": "recorded-model-name",
      "repositoryRevision": "COMMIT",
      "evaluatorVersion": "rubric-1",
      "outcome": "unknown"
    }
  ]
}
```

A manifest permits at most 500 runs. Session IDs and task/condition/trial combinations must be unique. Cohorts can group by `condition`, `agent` or `model`. Outcome rates use human-supplied outcomes, with unknowns counted separately. Mean measurements report known and missing counts. Paired comparisons match task ID and trial; matching identifiers alone does not establish comparable environments.

```json
{
  "schemaVersion": "agentshark.annotation.v1",
  "id": "label-001",
  "subjectId": "EPISODE_OR_SESSION_OR_EVENT_ID",
  "label": "dependency unavailable",
  "author": "reviewer-1",
  "createdAt": "2026-10-13T00:00:00Z",
  "rubricVersion": "1",
  "reviewed": true,
  "evidenceEventIds": ["EVENT_ID"],
  "note": "The recorded tool output reports the missing dependency."
}
```

Annotations travel as an array. Subject and evidence references must belong to the selected sessions. A human label remains separate from an observed episode outcome. The browser's label form creates this document and can download it for later analysis.

## Datasets, Exports and Investigations

A dataset request accepts `sessionIds`, `episodeIds`, `annotations`, `manifest`, `includeUnreviewed` and `redact`. Reviewed episode labels are required by default. Structural redaction removes arbitrary text, paths, tool input/output and original identities, including label names. Consistent pseudonyms preserve groups within the export. Redacted references cannot navigate back to the original local events.

Near-duplicate grouping combines task groups, failure signatures and candidate text similarity. Connected components keep transitive matches together. An export reports a split conflict when one group crosses train, validation or test. Review these candidates before using a dataset; they are not a leakage-proof benchmark design.

`redact: false` includes recorded tool calls and outputs as a non-executable mock fixture. The fixture does not restore filesystem state or replay a live agent. Use this only in a trusted local workflow. Table exports use pattern-based redaction instead of structural omission; arbitrary sensitive text can remain. CSV output escapes formula-like cells.

Investigation documents record the question, session IDs, human annotations, cited findings, analysis settings and a fingerprint of the examined indexed events. Preserve a matching capture with the document for offline review. The fingerprint identifies the indexed corpus; it is not proof of source-file integrity.

### Use Table Exports in Python or DuckDB

The CLI returns a JSON envelope so coverage travels with the exported table. Save that envelope and extract `content` for analysis. These examples require pandas or DuckDB in your research environment; AgentShark does not install either package.

```sh
agentshark analyze exportTable --session 'cx:SESSION' --table events --format csv --out events-export.json
```

```python
import io
import json
import pandas as pd

with open("events-export.json", encoding="utf-8") as source:
    exported = json.load(source)
print(exported["coverage"])
events = pd.read_csv(io.StringIO(exported["content"]))
print(events.head())
```

For DuckDB, write the content to a separate CSV file after inspecting coverage, then query it locally:

```python
from pathlib import Path
import duckdb

Path("events.csv").write_text(exported["content"], encoding="utf-8")
print(duckdb.sql("SELECT count(*) AS exported_events FROM read_csv_auto('events.csv')"))
```

## Validation and Release Boundaries

Offline telemetry interchange uses `agentshark telemetry export --session ID --out export.json` and `agentshark telemetry import --input export.json --out converted.json`. The importer accepts OTLP JSON or an AgentShark telemetry envelope. It preserves the original records and reports unknown provider fields and timing. Conversion produces a portable document; it does not insert generic telemetry into the native-agent index. See [INTEROP.md](INTEROP.md) for mapping details and limits.

The release workflow prepares signed and notarized macOS artifacts when maintainer credentials are configured. Successful local builds do not establish clean-machine installation, Windows/Linux compatibility or empirical accuracy on private real-world traces. Record those results separately before making broader release claims.
