# AgentShark Workbench

The Workbench serves engineers debugging runs and researchers building trace datasets. It reads the indexed record of an execution. It does not run agent commands, infer a hidden prompt, or use a model to judge task success. Running recorded commands again is `agentshark replay` ([REPLAY.md](REPLAY.md)); the Workbench shows a replay's plan before it runs and its report after.

Open Workbench from the browser toolbar or Research menu in the macOS application. Select a session, choose an analysis and follow its evidence links back to the event viewer. Saved recipes contain a request, not copies of trace records. Browser recipes stay in local storage; export a recipe JSON file to keep or share it. Human labels remain in memory until downloaded.

## Evidence and Confidence

Each response has `schemaVersion: agentshark.workbench.v1`, `analysisVersion`, and `coverage`. Coverage reports the selected sessions, available and examined event counts, truncation, gaps, index analysis version and snapshot clock. A single analysis reads a consistent SQLite snapshot. HTTP analyses run in the query worker pool with a deadline; requests examine at most 50,000 events and 500 selected sessions.

| Confidence | Meaning |
|---|---|
| `observed` | A recorded event supplies the stated evidence. |
| `derived` | A documented calculation or alignment uses recorded evidence. |
| `candidate` | A pattern warrants human review; alternative explanations remain. |
| `unknown` | The required evidence is absent, incomplete or ambiguous. |

These labels are categories, not probabilities. Synthetic regression tests validate known cases and failure handling. They do not establish population precision on real research workloads. Context reconstruction, action alignment, possible stale reads and file verification therefore retain explicit limits.

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
```

`--input` accepts the request object. Explicit flags override fields from the file. `--session` can repeat. `--out` creates a file with owner-only permissions and refuses to overwrite an existing file. Standard output is JSON, including table exports: their `content` field contains CSV or JSONL, alongside provenance and coverage. The browser offers a separate Download Table action.

The authenticated HTTP equivalent is `POST /api/workbench/OPERATION` with a JSON object. Use the running server's cookie or `X-AgentShark-Token` header. Bodies are limited to 1 MiB, except `replayReport` (16 MiB). `GET /api/workbench` lists supported operations. Single-session operations take `{ "session": "cx:SESSION" }`; comparison takes `left` and `right`. Other operations use `sessions`, except dataset selection, which uses `sessionIds`.

MCP exposes `analyze_trace` for context, comparison, checks, coordination, verification, search, profiling and cohorts. Its request has `operation` and `input`. Project scope applies to every session and evidence reference. All returned text becomes a redacted, length-limited `*_excerpt` field. Complete research exports remain available through the local CLI and Workbench.

## Context and Comparison

Context requests accept `atEventId` or `stepId`, plus `limit` up to 500. The response separates recorded context records from transcript reconstruction. Compaction shows a recorded boundary; the app cannot establish which details the next model request retained.

Comparison aligns action signatures across two sessions with a bounded sequence alignment. It reports changed, unchanged and unmatched actions, ambiguity and metric differences. Repeated actions can have several plausible alignments. Matching signatures do not establish equivalent repository state, model inputs or outcomes.

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

`tests-after-edit` uses recognized test commands after recorded edits and considers the latest recognized outcome. It does not measure line or file coverage. Custom runners and edits hidden inside shell commands may be unrecognized. `unresolved-delegations` distinguishes explicit unsuccessful outcomes from absent completion or delivery evidence. `repeated-failed-actions` requires matching indexed inputs and explicit unsuccessful results; a successful intervening action resets the streak. `token-budget` uses a session's own recorded input and output counters.

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

Coordination joins the recorded session tree with delegation and file activity. It resolves relative paths against each session's working directory before comparing files. Overlapping file activity and reads followed by another agent's edit remain candidates. The trace may omit synchronization or context that explains the behavior.

Profiling reports recorded spans, their interval union, overlapping categories and unattributed time. Containment and dependency edges are separate. Only observed dependency edges contribute to its longest observed dependency path. That path is not a proven critical path of the entire execution; missing dependencies and timing prevent that conclusion.

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

Synthetic tests cover incomplete evidence, ambiguous alignment, scoped access, missing measurements, sequence matching, split conflicts, stable columns, formula escaping and read-only snapshots. HTTP, CLI and MCP integration tests cover their actual dispatch paths. Installed-package tests exercise compiled workers rather than TypeScript from the source tree.

The release workflow prepares signed and notarized macOS artifacts when maintainer credentials are configured. Successful local builds do not establish clean-machine installation, Windows/Linux compatibility or empirical accuracy on private real-world traces. Record those results separately before making broader release claims.
