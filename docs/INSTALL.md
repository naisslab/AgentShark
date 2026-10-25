# Install and Open AgentShark

The desktop application includes the engine and its Node.js runtime. Once built, it needs no Node, npm, terminal, or agent configuration changes.

## macOS Application

There is no signed release yet, so build the app from a checkout. You need Node.js 24.12 or later and a Swift toolchain. Run `npm ci`, then `npm run desktop:build`, which writes `dist/AgentShark.app`; [RELEASE.md](RELEASE.md) covers the build's options. Move the app to Applications and open it. AgentShark automatically discovers supported Claude Code and Codex logs, builds a local index, and watches for changes. Desktop Claude and supported Copilot logs are discovered when available. The minimum OS is macOS 15.

The first index shows the sessions being written right now within about a second and fills in older history behind them; a large history takes minutes to complete (about 3.5 minutes for 12 GB of logs on one machine). Source files remain unchanged. Settings → Sources shows discovered locations and supports additional `.claude` folders containing `projects`, and `.codex` folders containing `sessions` or `archived_sessions`. Turn off automatic discovery to read only selected folders. Apply & Reindex saves the selection and restarts the engine.

Select a run in the sidebar and choose Session ▸ Critical Path (⌥⌘4) to see where its time went, or select two runs and choose Compare (⌥⌘5) to see where they part; the Analyze menu opens both. Analyze → Open Research Tools in Browser opens the other analyses, annotations, datasets and exports in your default browser, where downloads and file imports work. Analyze → Explore Bundled Demo opens a window on an isolated synthetic sample; its temporary index is removed when that window closes.

## Command Line and Web Viewer

The npm distribution contains compiled JavaScript and requires Node.js 24.12 or later. Node 24 LTS is the release compatibility target. Once the package is published, install it with `npm install -g agentshark`, then run `agentshark serve`. Before publication, use the locally packed `.tgz` with `npm install -g /path/to/agentshark-VERSION.tgz`, or run `npm ci`, `npm run build` and `npm link` in a checkout.

`agentshark demo` starts the bundled synthetic sample. It does not change HOME, scan personal sources, or use the live index. The server binds to localhost and opens an authenticated browser URL. Keep the terminal running while using the CLI viewer; the desktop application manages its engine automatically.

## Source Configuration

Both clients read `~/.agentshark/sources.json`, or `sources.json` inside `AGENTSHARK_HOME`. `AGENTSHARK_SOURCE_CONFIG` can select another file. The desktop source picker writes this document for you:

```json
{
  "version": 1,
  "autoDiscover": true,
  "claudeRoots": [],
  "codexRoots": []
}
```

Roots are absolute paths or start with `~/`. They identify agent data directories, not individual trace files. Missing disks are skipped by discovery and remain visible in source settings. Invalid configuration produces an error rather than silently reverting to broader discovery.

Platform defaults are `~/Library/Application Support` on macOS, `%APPDATA%` on Windows, and `$XDG_CONFIG_HOME` or `~/.config` on Linux. CLI logs use `~/.claude` and `~/.codex` on each platform. A location convention does not guarantee that the installed agent emits a supported trace dialect; Sources reports actual coverage.

## Troubleshooting

**No supported logs:** check Settings → Sources. Run the coding agent once, or select its data folder. AgentShark cannot reconstruct logs the source agent never wrote or already deleted.

**Unreadable folder:** reconnect the disk and grant the application normal filesystem access where macOS requests it. Do not grant unrelated permissions. Source settings preserve unavailable roots so they can reappear.

**Runtime unavailable:** reinstall the complete desktop application. A release includes the runtime; choosing a system Node binary is a developer fallback.

**Engine stopped:** open the engine log in the startup panel. Restart after correcting the reported path, runtime, or index error. Never delete your agent's original logs to repair AgentShark.

**Browser URL expired:** choose Analyze → Open Research Tools in Browser again in the running app, or use the URL printed by the current CLI process. The authentication token changes when the engine restarts, and the URL that carries it stays in the browser's history.

**Upgrade:** replace the application or npm package. The index is a rebuildable cache; incompatible index schemas are rebuilt from available sources. Save durable captures before deleting or moving source logs.

**Uninstall:** quit AgentShark, remove the application or run `npm uninstall -g agentshark`. The local index and source settings remain in `~/.agentshark` (or your selected folder). Remove that folder separately only if you want to erase its cache and settings. Captures you saved elsewhere remain your files.
