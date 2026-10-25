# Trace Replay Specification

`agentshark replay` takes one indexed session and runs its recorded tool calls again, in order, inside a Docker container. It paces the calls at the recorded speed or a scaled speed, and compares each new result with the recorded one. The question it answers is: given this environment, do the same actions produce the same results?

## 1. Semantics

Replay is open-loop. The model's decisions come from the trace: every tool call is issued exactly as recorded, whatever the replayed results turn out to be. No model is called. A replay therefore never reproduces what an agent would have done differently; it reproduces what the recorded actions do in a chosen environment.

After the first divergence, later calls still run, because a later call can show whether the environment converged again. The report marks the first call whose status differs, since every call after it ran in a state the recording never saw.

A replay changes nothing outside its container. It never writes to the index, the source logs, or the workspace directory it starts from.

## 2. Command

```text
agentshark replay SESSION --workspace DIR [--rev REV] [--image IMAGE] [--speed N|max] [--max-gap DUR]
                  [--network none|NAME] [--env KEY=VALUE]... [--timeout DUR] [--keep] [--dry-run]
                  [--json] [-o FILE] [--capture FILE | --index PATH]
```

| Option | Meaning | Default |
|---|---|---|
| `SESSION` | Session id, or a prefix that matches exactly one session | required |
| `--workspace DIR` | Starting filesystem state, copied into the container (§4.2) | required unless `--dry-run` |
| `--rev REV` | Start from this git revision of `DIR` instead of its working tree | working tree |
| `--image IMAGE` | Container image | `node:24-bookworm` |
| `--speed N\|max` | Pacing factor: `1` keeps recorded waits, `2` halves them, `max` removes them (§5) | `1` |
| `--max-gap DUR` | Upper bound on any single inserted wait | none |
| `--network` | Docker network for the container | `none` |
| `--env KEY=VALUE` | Environment variable for every call (repeatable) | none |
| `--timeout DUR` | Upper bound on one call's run time | `10m` |
| `--keep` | Leave the container running afterwards and print its name | off |
| `--dry-run` | Print the plan and projected duration; start no container | off |
| `--json` | One JSON object per line on stdout (§7.2) | off |
| `-o FILE` | Also write the JSON lines to `FILE` | none |
| `--capture FILE` | Read the session from a `.agentcap` capture instead of the live index | live index |

Exit codes: `0` when every executed call has the recorded status, `3` when at least one status differs, `1` for errors, `2` for usage errors.

## 3. Plan

The planner turns one session into an ordered list of calls. It reads the index read-only and never needs Docker, so `--dry-run` works anywhere.

### 3.1 Selection and order

The plan contains the `tool.call` events of the session and of its descendant sessions (subagents), and the `tool.exec` items that Codex code-mode scripts ran (§3.6), excluding events flagged `inherited` or `dup`. Subagents are included because they usually worked in the same files; leaving their edits out would make the parent's later calls diverge for reasons the replay itself caused.

Calls are ordered by recorded start time, then session, then file order. A nested item is logged when it completes, so its start is its completion time minus its duration, and never earlier than its script's call. Each call is paired with its result through `attrs.tool.call_id` (the shared tool span); a nested item is its own result.

### 3.2 Batches

A batch is a maximal run of consecutive calls in one session with no `tool.result` of that session between them. A batch is what one model step issued at once: Claude logs parallel `tool_use` blocks before their results, and Codex logs a parallel batch as N calls followed by N outputs. Calls in one batch run concurrently; batches run one after another. The nested items of a code-mode script form batches by their recorded times: an item that started while an earlier item of the same script was still running joins that item's batch (the script awaited them together, as with `Promise.all`); any other item starts a batch of its own.

### 3.3 Full inputs

The index caps tool input strings at 1,024 characters, so the planner reads each call's input from its raw record: the `tool_use` content block `src_block` for Claude, and `function_call.arguments`, `custom_tool_call.input` or `local_shell_call.action` for Codex. Raw records come from the source file in live mode and from the capture's `raw_store` in capture mode.

When the raw record is unavailable, the normalized `attrs.tool.input` is used only if it is intact: no string ends in a `…[+N]` truncation marker and no value was replaced (`$omitted`, `<redacted>`). Otherwise the call is skipped with reason `input-truncated`. Every planned call records its input source, `raw` or `index`.

### 3.4 Recorded results

The recorded status of a call is its result event's `exit_code` and `is_error`, and its duration is the call span's. The recorded output of a shell call is, in order of preference:

1. Claude `Bash`: the logged `toolUseResult.stdout` and `stderr`, joined by a newline. They are complete and carry no harness text, unlike the `tool_result` text, which may be a preview of an output saved to a file. Streams longer than 1 MB are kept as a 4 KB head and a 2 KB tail.
2. Otherwise the result event's `output` (first 4 KB) and `output_tail` (last 2 KB), with harness wrappers removed by the same rules as error signatures (SPEC §12.4 step 1): Codex headers such as `Chunk ID`, `Wall time`, `Process exited with code` and `Output:`, a leading Claude `Exit code N` line, and shell start-up noise. When `output_len` exceeds the head, the output counts as cut.

A call without a result event (the session ended or was interrupted) is still executed; its verdict is `unrecorded`.

### 3.5 Tool classes

Each call gets one class. The class decides how it is executed (§4.4) and compared (§6).

| Class | Tools | Executed | Compared |
|---|---|---|---|
| `shell` | Claude `Bash`; Codex `exec_command`, `shell_command`, `shell`, `local_shell`, and a script's `CommandExecution` items | yes | status and output |
| `shell-bg` | Claude `Bash` with `run_in_background`; Codex `exec_command` whose recorded result says the process was still running, and a script's process that a signal ended after the script returned (§3.6) | started, not awaited | no |
| `read` | Claude `Read` | yes | status |
| `write` | Claude `Write` | yes | status |
| `edit` | Claude `Edit`, `MultiEdit` | yes | status |
| `patch` | Codex `apply_patch` (custom tool, function, or an `apply_patch` heredoc in a shell command), and a script's `FileChange` items | yes | status |
| `skip` | everything else, with a reason | no | no |

Skip reasons:

- `search`: `Glob`, `Grep`, `LS`, `view_image`. They read the filesystem and change nothing, so skipping them never changes later state.
- `external`: web tools, `mcp__*` tools, image generation and tools that publish to a service (`Artifact`, `PushNotification`). Their results depend on services outside the container.
- `harness`: planning, task and subagent tools (`TodoWrite`, `Agent`, `Task`, `update_plan`, `spawn_agent`, and so on), and tools the harness answers itself: questions to the user, scheduling and sleeping, tool and skill loading, structured output and goals (`AskUserQuestion`, `ScheduleWakeup`, `sleep`, `ToolSearch`, `Skill`, `StructuredOutput`, `update_goal`). A sleep holds its recorded time (§5). The harness executes them, not the environment, and a subagent's own calls are already in the plan.
- `process`: calls that address a process started by an earlier call (`BashOutput`, `KillShell`, `Monitor`, `write_stdin`).
- `script`: Codex code-mode `exec` scripts and their `wait` continuations. The JavaScript is not run; the commands and file changes it made are planned in its place (§3.6).
- `notebook`: `NotebookEdit`, `NotebookRead`.
- `rejected`: the recording shows the user rejected or a permission rule denied the call, so it never ran.
- `input-truncated`: see §3.3.
- `unsupported`: any other tool, or an input without the fields its class needs.

### 3.6 Codex code-mode scripts

From CLI 0.144 the Codex model writes JavaScript (`custom_tool_call` named `exec`) that calls tools itself. Codex logs each tool the script ran as an `item_completed` record with an id `exec-<uuid>`, and the adapter indexes it as a `tool.exec` event under its script (`attrs.tool.parent_call_id`, SPEC §12.3.3). Replay plans those items instead of the script:

- A `CommandExecution` runs as a `shell` call. Its script comes from the raw item's `command` argv (a shell running `-c` gives its script, other argv is quoted), else from the index copy when it is intact; its directory is the item's `cwd`, resolved against the session `cwd` when relative. Its recorded output is the item's whole `aggregated_output` (§6). An item the user `declined` never ran and is skipped as `rejected`.
- A `FileChange` applies as a `patch`: added files with their content, deleted files, and updates whose unified-diff hunks become patch chunks, with file headers and `\ No newline at end of file` markers dropped. A hunk keeps its `@@ -line` number: its lines are taken at that line when they match there, so repeated text is changed where the diff says, and searched for from there on otherwise.
- Other items are skipped by kind: MCP, web search and image generation as `external`, `view_image` as `search`, a sleep as `harness`.
- An item that completed after its script returned is linked to that script by inference (flag `inferred`). When a signal ended it (exit code 129 to 159, for example a server stopped with its session) it is `shell-bg`; otherwise it ran to completion and is awaited.
- The script call is skipped as `script`. When it has nested items it holds no time, since the items account for it; without any it holds its recorded duration.

The script's own logic is not reproduced. Its control flow was open-loop already: whatever the replayed commands return, the planned items are those the recording shows.

## 4. Environment

### 4.1 Container

The replayer drives the `docker` CLI; it adds no npm dependency. It creates one container per replay:

```text
docker run -d --init --network none --name agentshark-replay-<random> --label agentshark.replay=SESSION [-e K=V]... --entrypoint sh IMAGE -c 'while :; do sleep 3600; done'
```

No host directory is mounted and no host environment variable is passed. The workspace is copied in (§4.2), so a replayed `rm -rf` or `git push` can reach neither the host nor the network. `--network NAME` opts into a network. The container is removed when the replay ends, fails or is interrupted, unless `--keep` is given.

At start the replayer probes the image once for `bash` and `timeout`. Shell calls run under `bash` when present and `sh` otherwise. The probe results appear in the plan header.

### 4.2 Workspace

The trace does not contain the starting filesystem, so the user supplies it. `--workspace DIR` is copied into the container at the session's recorded `cwd`, so absolute paths in commands and file tools resolve unchanged.

- Without `--rev`, the working tree of `DIR` is copied as it is now, including `.git` and untracked files.
- With `--rev REV`, `DIR` is cloned into a temporary host directory, `REV` is checked out, the clone is copied in, and the temporary directory is deleted. The user's repository is never modified.
- When the session records a git commit (Codex does; Claude Code records only the branch) and `--rev` is absent, the plan header suggests `--rev <commit>`.

`HOME` is set to the recorded home directory when the recorded `cwd` lies under `/Users/<name>` or `/home/<name>`, so `~` in commands names the same paths as in the recording. Otherwise the image's `HOME` is kept.

### 4.3 Differences the replay cannot remove

The image is Linux, while most recordings ran on macOS, so tool behavior can differ (`sed -i`, `stat`, `open`). Recorded environment variables, credentials, agent configuration, package caches and services the agent reached are not in the container. These differences are the point of a controlled environment, but they also mean `output` verdicts are common.

### 4.4 Execution by class

- **`shell`:** The command runs as `bash -c` in the call's working directory: Codex `workdir` (or `working_directory`, resolved against the session `cwd` when relative) when given, otherwise the session `cwd`. A Codex argv of the form `[bash|sh|zsh, -c|-lc, SCRIPT]` runs `SCRIPT` this way, so a recorded `zsh` needs no `zsh` in the image; any other argv is quoted into one command. Claude `Bash` keeps its working directory between calls of one session, as Claude Code does: a wrapper restores the previous call's final directory before the command, and an `EXIT` trap saves the final directory however the command ends. The timeout is the call's own (`timeout` for Claude Bash, default 120 s; `timeout_ms` for Codex `shell_command`, `shell` and `local_shell`), capped by `--timeout`. When the image has `timeout`, it enforces the limit inside the container: the call timed out when it exits 124 (GNU `timeout`), or 143 or 137 after running the whole limit (BusyBox `timeout` ends it with SIGTERM, then SIGKILL). Stdout and stderr are kept separately, up to 8 MB each; bytes past that are counted, not kept.
- **`shell-bg`:** The command starts detached (`docker exec -d`). Its result is not compared.
- **`read`, `write`, `edit`, `patch`:** These tools are executed by the agent harness, not by a shell, so the replayer implements their semantics itself and performs only file I/O in the container (`cat`, `mkdir -p`, `rm`). `Read` fails when the file is missing. `Write` creates parent directories. `Edit` fails when `old_string` is absent, or occurs more than once without `replace_all`. `MultiEdit` applies its edits in order and fails as a whole. `apply_patch` applies `*** Add`, `*** Update` (with `*** Move to`) and `*** Delete File` sections; an update hunk is located after the previous hunk by its context and removed lines, matched exactly, then ignoring trailing whitespace, then ignoring surrounding whitespace, as Codex does. A failed patch changes no file.

## 5. Pacing

Recorded time between calls is model time and human time: after a result, the agent thinks before issuing its next batch. Replay keeps that time and lets tools take their real time.

- The **gap** before batch *i* is the recorded time from the end of batch *i−1* (its latest result) to the first call of batch *i*, clamped at zero. After batch *i−1* finishes in the replay, the replayer waits `gap / speed`. A skipped call that holds no time (its subagent's or script's calls follow it and account for its time) ends where it starts.
- A **skipped call holds** its slot for `recorded duration / speed`, so skipping a 5-second web fetch does not make the replay 5 seconds faster. A skipped call that spawned a subagent whose calls are in the plan holds for zero, because the subagent's calls account for that time.
- `--max-gap` caps every inserted wait, gaps and holds alike. With `--speed max` no wait is inserted.
- The dry run projects the duration as the sum of the waits plus the recorded durations of awaited calls, each capped at the timeout it runs under (§4.4). Background calls (`shell-bg`) count zero.

Concurrent subagents are replayed one batch at a time in recorded order; their concurrency is lost (§8).

## 6. Comparison and verdicts

A call **succeeded** when it has no error flag and its exit code, if any, is 0. Two statuses **match** when both have exit codes and the codes are equal, or when either lacks one and both succeeded or both failed.

Shell outputs are compared line by line after normalization: terminal control sequences are removed, CRLF becomes LF, and trailing whitespace on each line and trailing blank lines are removed. The replayed side is stdout followed by stderr. Codex records one stream in which a command's stdout and stderr interleave as written (an `exec_command` output, a `CommandExecution` item's `aggregated_output`), so a command that writes to both can show an `output` verdict for the order alone. When the recorded output is cut (§3.4), only its head and tail are compared; when the replayed output passed the 8 MB limit, only its head is. In both cases the line a cut splits is ignored.

| Verdict | Meaning |
|---|---|
| `same` | Status matches; for `shell`, output matches as well |
| `output` | Status matches; shell output differs (the first differing line is reported) |
| `status` | Status differs. The first such call is the divergence point |
| `unrecorded` | Executed; the recording has no result to compare with |
| `started` | `shell-bg` started; not compared |
| `skipped` | Not executed, with the reason from §3.5 |
| `error` | The replayer could not run the call. Not counted as divergence. When Docker itself fails (the daemon stops or the container is gone), the replay ends with an error instead |

## 7. Output

### 7.1 Terminal

A header states the session, agent, call counts by class and by skip reason, workspace source and revision, image, network, shell, whether the image has `timeout`, pacing and projected duration. One line follows per call as it finishes: number, replay clock, tool, a one-line summary of the input, recorded status and duration, replayed status and duration, and verdict. A summary counts verdicts and names the divergence point.

### 7.2 JSON lines

With `--json` (stdout) or `-o FILE`, the replay writes one object per line:

- `{"type":"plan", session, agent, cwd, sessions, workspace, rev, image, network, timeoutMs, speed, maxGapMs, projectedMs, calls: [{n, event, session, batch, tool, class, reason?, inputSrc, gapMs, holdMs}]}`. `gapMs` and `holdMs` are already scaled by the speed and capped; `timeoutMs` is `--timeout`.
- `{"type":"call", n, event, session, tool, class, summary, startedMs, recorded: {ok, exitCode, durMs, outputLen} | null, replayed: {ok, exitCode, durMs, timedOut, stdoutLen, stderrLen, stdoutHead, stderrHead} | null, verdict, reason?, diff?: {line, recorded, replayed}}`. `reason` is the skip reason, or the replayer's error message.
- `{"type":"summary", counts: {verdict: n}, firstDivergence: n | null, wallMs, interrupted}`

Replayed output heads are cut to 4 KB.

## 8. Non-goals and limits of v1

- **Closed-loop replay.** Re-querying a model with the new results is re-running the agent, not replaying it.
- **Process tools.** `BashOutput`, `KillShell`, `Monitor` and `write_stdin` are skipped, so input written to a running process is not replayed. The dry run shows the share of executable calls.
- **Code-mode scripts** are replayed through the commands and file changes Codex logged for them (§3.6), not by running their JavaScript. A tool a script called that Codex did not log as an item is not replayed.
- **Search tools** are skipped (§3.5).
- **Concurrency across subagents** is serialized.
- **Claude Code's directory reset** (newer versions return the shell to the project directory after a command leaves it) is not modeled; the working directory simply persists.
- **Approvals and permission prompts** are not modeled; every recorded call is issued.
- **Nothing is redacted.** The replay output contains command output from the container.
- **Replays are not indexed.** The Workbench's Replay Report joins a report to its recording and links each call to the recorded event (docs/WORKBENCH.md); the replayed calls themselves do not become events.

## 9. Modules

| Module | Role |
|---|---|
| `src/replay/plan.ts` | Session → ordered, batched, classified calls with full inputs, recorded results and waits |
| `src/replay/patch.ts` | `apply_patch` parsing and application (pure) |
| `src/replay/tools.ts` | Execution of each class against an `Executor` |
| `src/replay/executor.ts` | `Executor` interface; `DockerExecutor` over the `docker` CLI |
| `src/replay/compare.ts` | Output normalization and verdicts (pure) |
| `src/replay/run.ts` | Pacing loop, batches, result records |
| `src/cli/replay.ts` | Command, plan header, call lines, JSON lines |
| `src/workbench/replay.ts` | Workbench operations `replayPlan` and `replayReport` (docs/WORKBENCH.md) |
