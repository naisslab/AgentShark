# Command Line and Display Filters

Build and link the command as described in [INSTALL.md](INSTALL.md). Without a global link, replace `agentshark` with `node /absolute/path/to/agentshark/bin/agentshark.ts`.

## Diagnose from the Terminal

The analysis behind the Failures workspace also answers on the command line:

```bash
agentshark why                       # the latest finished run: what failed and what needs attention
agentshark failures --since 7d       # failure episodes that need attention
agentshark sig "Error: Cannot find module 'left-pad'"   # have agents hit this error before, and what got past it?
```

`why` prints a run report in Markdown, ready for an issue or a pull request. This excerpt comes from the demo's Claude Code run, with IDs shortened and some lines left out:

```text
# Run report: Run the tests

claude-code · finished · unattended · 2026-10-11T09:00:00Z to 2026-10-11T09:30:30Z

**Turns** 16 (human 15 · task-notification 1) · **Steps** 53, 14 with a failure
**Impact** failed 4 · blocked 1 · interrupted 1 · masked 2 · degraded 2 · recovered 4 · clean 2

## Needs attention

- **blocked** episode `…:24`: PreToolUse:Bash hook error: [<path>]: Blocked: rm -rf is not allowed in this repo on `sh:rm` (pivoted), 1 attempts
- **unrecovered** episode `…:92`: tests failed on `sh:pytest` (ended-on-failure), 2 attempts
- **silent-child** delegation `…toolu_m19`: check docs (failed)
- **unverified-claims** claim `…p89`: “All tests pass.” (last-test-failed)
- **unverified-claims** claim `…p75`: “The build succeeds.” (edited-after-last-test)
```

Add `--json` to `why`, `failures` or `sig` for the same JSON the MCP server returns. `why` prints the run's session ID on its first line (`Run cc:22222222-…`); commands that take `--session ID` or a `SESSION` argument accept that ID or a unique prefix of it.

## Display Filters

The viewer's filter bar and `agentshark list -f` take Wireshark-style expressions over agent fields:

```text
error                                   events flagged as failures
tool.name == "Bash" && dur > 2s         slow shell calls (bare numbers are milliseconds for durations)
agent == codex && kind == "tool.call"   one agent's tool calls
"npm test"                              full-text phrase: the words next to each other
"npm" && "test"                         both words anywhere
ts >= "2026-10-11 09:00"                local time
ts >= "2026-10-11T09:00Z"               UTC; "2026-10-11T09:00+08:00" names any other zone
ts > -2h                                relative to now
```

`agentshark list` prints the matching events like `tshark`:

```text
$ agentshark list -f 'tool.name == "Bash" && dur > 2s' -n 5
No.  Time                                    Δ  Session            Kind                 Duration  Summary
  1  2026-10-11 17:00:04.000 +08:00      0.000  cc:22222222        tool.call                  5s  Bash  pytest -q
  2  2026-10-11 17:00:09.000 +08:00      5.000  cc:22222222        tool.result                5s  exit 1 · 58 B · 5s · Exit code 1 ..F.F ===== 2 failed, 41 passed in 3.21s =====
  3  2026-10-11 17:00:18.000 +08:00      9.000  cc:22222222        tool.call                  4s  Bash  pytest -q
  4  2026-10-11 17:00:22.000 +08:00      4.000  cc:22222222        tool.result                4s  ok · 18 B · 4s
  5  2026-10-11 17:02:42.000 +08:00    140.000  cc:22222222        tool.call                  4s  Bash  pytest -q
showing 5 of 30 events; use --limit 0 for all
```

Run `agentshark fields` for every filter field. Times without a zone are local time everywhere: in filters, in `--since` and `--until`, and in the HTTP API. Printed times always show their UTC offset, and `agentshark list --utc` prints UTC.

## Command Reference

```text
agentshark serve [--port 7373] [--no-open] [--no-watch]      start the viewer on the live index
agentshark demo                                              open bundled synthetic traces
agentshark open FILE.agentcap[.zst|.gz]                      view a capture
agentshark why [--last|--session ID|--cwd DIR] [--since 8h]  why a run failed: its run report (--json, --md)
agentshark failures [--since 7d] [--signatures] [--json]     failure episodes that need attention
agentshark sig "<error text>"                                have agents hit this error before, and what got past it
agentshark list [-f FILTER] [--session ID] [--utc] [--json]  print events
agentshark stats [--view summary|tools|models|kinds|pairs]   print statistics
agentshark fields                                            filter fields
agentshark sources [--json]                                  logging health
agentshark index [--full|--rederive] [--agent cc|cw|cx|cp]   build or update the index; --rederive recomputes the analysis only
agentshark config [--agent codex|claude] [--add PATH]        configure additional source folders
agentshark capture -o FILE [--since 7d] [--session ID]...    write a capture
agentshark replay SESSION --workspace DIR [--speed N|max]    re-run a session's tool calls in a Docker container
agentshark mcp [--scope project|all] [--max-bytes 16384]     read-only MCP server for agents (stdio)
agentshark analyze OPERATION [--session ID] [--input FILE]   run Workbench analysis or export
agentshark check [--session ID] [--input FILE]               CI checks: pass, fail, invalid or unknown
agentshark telemetry import|export [--input FILE]            offline OTLP/OpenInference conversion
```

`agentshark <command> --help` describes each command's options.

