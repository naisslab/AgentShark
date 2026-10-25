# Install AgentShark: Instructions for a Coding Agent

The reader is a coding agent (Claude Code, Codex or another) that a person asked to install AgentShark. Run each step yourself, in order, and check its result before you continue. Report back at the end as the last step describes.

On macOS, install the native app and CLI unless the person explicitly requests web-only use. On Linux and Windows, install the CLI and web viewer. The macOS app is part of the default installation, not an optional extra.

Never use `sudo`. Installation writes the checkout and build output, npm's global package links, `~/.agentshark` and your own MCP configuration. Do not quote or summarize private trace text; verification needs only connection status and counts. Ask before replacing an existing app or writing to `/Applications`.

## 1. Check Prerequisites

```bash
node --version
```

AgentShark needs Node.js 24.12.0 or newer. If `node` is missing or older, stop and ask the person how they want to install Node.js 24 LTS (the installer from nodejs.org, a version manager such as `nvm install 24` or `fnm install 24`, or their package manager). Continue once `node --version` prints v24.12.0 or newer. Check `git --version` as well.

For a native macOS install, check `sw_vers -productVersion` and `swift --version`. The app needs macOS 15 or later and Swift 6 or later. If Swift is missing, tell the person to run `xcode-select --install` and finish Apple's installer. Report a missing prerequisite instead of silently substituting a web-only installation.

## 2. Get the Checkout

If you already cloned AgentShark for this request, use that checkout and do not clone again. If your working directory is an AgentShark checkout (its `package.json` has `"name": "agentshark"`), use it. Otherwise clone the repository into `~/agentshark`, or into the folder the person named. If that folder already holds an AgentShark checkout, update it with `git pull --ff-only` instead of cloning again.

Run every later command from the checkout's root.

## 3. Build and Link

```bash
npm ci
npm run build
npm link
```

`npm ci` installs TypeScript, which the build uses; AgentShark itself has no runtime dependencies. `npm link` puts an `agentshark` command on the PATH. If it fails with a permission error (`EACCES`), or succeeds but `agentshark` is not found on the PATH, do not retry with `sudo`. Skip the link instead, and wherever this guide writes `agentshark`, use `node <checkout>/bin/agentshark.ts` with the checkout's absolute path.

Check the result:

```bash
agentshark --help
```

It prints the AgentShark version and a list of commands that starts with `serve` and `demo`.

## 4. Build the Index

```bash
agentshark index
agentshark sources
```

`index` finds the logs of every supported agent on this machine and indexes them into `~/.agentshark/index.sqlite`. A large history takes minutes (about 3.5 minutes for 12 GB of logs on one machine), which is longer than many agents let one command run, and `index` prints nothing until it finishes unless its output is a terminal. Run it with a timeout of at least 10 minutes, or in the background, and wait for its summary. If it is cut off, run it again; it keeps the files it already indexed. `sources` reports which agents it found and what their logs record. If `index` reports zero sources, report the agents listed by `sources`. For logs in a custom folder, use Settings ▸ Sources in the macOS app, or `agentshark config --agent claude --add PATH` (use `--agent codex` for Codex).

## 5. Register the MCP Server

The read-only MCP server lets you and later sessions ask AgentShark about past runs. Register it with the agent you are, unless the person said not to. Check first whether a server named `agentshark` already exists. Preserve an existing configuration, but check its connection and report a broken or stale command instead of claiming success.

Claude Code:

```bash
claude mcp get agentshark || claude mcp add --scope user agentshark -- agentshark mcp
```

Codex:

```bash
codex mcp get agentshark || codex mcp add agentshark -- agentshark mcp
```

For any other agent, give the person the stdio command `agentshark mcp` and let them register it. If you skipped `npm link` in step 3, register `node` with the arguments `<checkout>/bin/agentshark.ts mcp` instead. The new tools appear in the agent's next session, not in the current one.

## 6. Build and Open the macOS App

On macOS, complete this step unless the person explicitly requested web-only use. Other platforms continue to step 7.

```bash
npm run desktop:build
PATH=/usr/bin:/bin dist/AgentShark.app/Contents/MacOS/AgentShark --verify-bundle
open dist/AgentShark.app
```

The app is written to `dist/AgentShark.app`. A checkout under an iCloud-synced Desktop or Documents folder cannot use that output path. Set `APP_OUTPUT` outside iCloud, for example `APP_OUTPUT=~/Applications/AgentShark.app npm run desktop:build`, and use that same app path for verification and opening. Ask before replacing an app that already exists there.

The build checks the signature. `--verify-bundle` tests the native launcher, bundled Node runtime, synthetic indexing, authenticated API and temporary-data cleanup without a system Node on PATH. Wait for its success message and zero exit status.

Then check the actual app window. It must load sessions or show an explicit no-sources state, rather than a missing-runtime or engine error. Choose **Analyze ▸ Explore Bundled Demo**, select a session and click **Run Analysis** to check the bundled demo. Build success alone does not verify graphical launch. If you cannot inspect the UI, report that limitation and give the person the launch check to perform.

## 7. Verify MCP and Keep the Index Current

Run `claude mcp get agentshark` or `codex mcp get agentshark` after registration. Claude Code reports a connection status; Codex prints the saved configuration, which alone does not test a connection.

Verify that the registered command launches and answers the MCP `initialize` and `tools/list` requests over stdio. The tool list must contain nine tools, including `find_runs`, `run_report` and `query`. Use the registered executable and arguments, including the absolute `node` fallback if step 3 needed it. If launch fails because the agent cannot find an executable, register its absolute path. Record connection failures separately from registration success.

In a new coding-agent session, started from the person's project rather than the AgentShark checkout, give them this verification prompt:

```text
Use AgentShark find_runs for this project. Report only the run count, scope, index_age_s and indexer.
```

An empty result can be correct. The default MCP scope includes only runs under the current project's git root. The AgentShark checkout usually has none of the person's other projects' runs. Do not widen scope automatically; explain `agentshark mcp --scope all` if the person wants all projects.

Installation builds the index once. MCP reads that index and never refreshes it. Keep the macOS app open, leave `agentshark serve` running in a terminal, or run `agentshark index` before querying. `indexer: "watching"` indicates an active watcher; `indexer: "none"` means new logs wait for the next index run. If the app uses a custom index location, point MCP at the same database with `--index PATH`.

For a web-only install, open the viewer with `agentshark serve` using a persistent terminal or a background process whose printed URL and lifecycle you can report. Verify that the authenticated page loads. If you cannot keep that process running after the installation session, give the person `agentshark serve` to run in their terminal and explain that it must remain open.

## 8. Report Back

Tell the person, briefly:

- the checkout path and Node.js version;
- whether the native app or web-only path was installed;
- the app path, bundle verification and graphical launch result on macOS;
- whether `agentshark` is on the PATH, or the absolute `node` command that replaces it;
- the source count and agents found, without quoting trace text;
- MCP registration and connection results, plus the new-session verification prompt;
- which app or server keeps the index current, or the command they need to run.

Distinguish completed checks from checks that need the person's action. Do not call a native installation complete if only the CLI was built.

To uninstall later: quit the app or viewer, run `npm uninstall -g agentshark`, remove its MCP registration (`claude mcp remove agentshark --scope user` or `codex mcp remove agentshark`), and delete the checkout and app. `~/.agentshark` contains the index, source settings and cached captures; remove it separately only if the person wants those deleted.
