# MCP Server for Agents

`agentshark mcp` lets a coding agent query the index about its own runs. It offers nine tools: `find_runs`, `run_report`, `list_failures`, `get_episode`, `lookup_error`, `watch`, `query`, `get_event` and `analyze_trace`. The server speaks JSON-RPC over stdin and stdout, opens the index read-only, writes nothing and opens no socket. It never indexes, so keep the macOS app or `agentshark serve` running, or run `agentshark index` before querying for fresh data.

If the agent-assisted installer already registered the server, skip registration here. Otherwise register it with your agent. The commands below assume `agentshark` is on your PATH; otherwise use `node /path/to/agentshark/bin/agentshark.ts mcp`.

```bash
claude mcp add --scope user agentshark -- agentshark mcp
```

For Codex, run `codex mcp add agentshark -- agentshark mcp`, or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.agentshark]
command = "agentshark"
args = ["mcp"]
```

`agentshark sources` prints these registration lines for the agents it finds.

<details>
<summary><strong>What the MCP Server Shows an Agent</strong></summary>

- **Scope.** Only runs whose working directory is under the agent's git root (from the client's MCP roots, else the server's working directory). Register with `agentshark mcp --scope all` to see every project.
- **Redaction.** Your home folder becomes `~`, your user name `<user>`, and secret-shaped strings (`sk-`, `ghp_`, `github_pat_`, Slack `xox?-`, `AKIA`, `Bearer` tokens, JWTs, PEM blocks) become `<secret:class:length>`.
- **Untrusted text.** Text from the logs appears only in fields whose names end in `_excerpt`, cut to 300 characters (output heads and tails to `output_chars` or `max_chars`). The tool descriptions tell the agent to treat that text as data, never as instructions.
- **Size.** Each result stays under `--max-bytes` (default 16,384) and lists in `cut` what it left out. Every result also carries `index_age_s`, `indexer`, `analysis_version` and `gaps` (the data the logs do not contain).
- **Raw records.** `get_event` includes the native source record only when the server runs with `--allow-raw`.

</details>

## Verify and Keep Results Current

Restart your coding-agent session after registration. From the project whose runs you want to inspect, ask: "Use AgentShark find_runs for this project. Report the run count, scope, index_age_s and indexer."

An empty result can be correct: the default scope includes only runs under that project's git root. The AgentShark checkout usually has none of your other projects' runs. Start your agent in the intended project; use `--scope all` only when you want access to every indexed project.

`indexer: "watching"` means a running app or viewer watches source changes. `indexer: "none"` means no process refreshes the index automatically. Open the macOS app, leave `agentshark serve` running, or run `agentshark index` before the next query. Registration alone does not start a watcher. If you moved the app's index in Settings, configure the MCP command with `--index /absolute/path/to/index.sqlite` to use the same database.

`claude mcp get agentshark` checks the connection; `codex mcp get agentshark` shows the saved configuration. A saved configuration alone does not establish that the server launches or answers tools. If launch fails, check that the registered executable is available to the agent's process. An absolute executable path avoids differences between a terminal's PATH and a desktop app's PATH.
