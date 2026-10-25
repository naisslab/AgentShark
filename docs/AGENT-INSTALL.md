# Install AgentShark: Instructions for a Coding Agent

The reader is a coding agent (Claude Code, Codex or another) that a person asked to install AgentShark. Run each step yourself, in order, and check its result before you continue. Report back at the end as the last step describes.

Stay inside these limits. Never use `sudo`. Change nothing outside the checkout, npm's global package links and your own MCP configuration. Do not open, quote or summarize the person's agent logs; AgentShark reads them locally, and nothing in this guide needs their contents.

## 1. Check Node.js

```bash
node --version
```

AgentShark needs Node.js 24.12.0 or newer. If `node` is missing or older, stop and ask the person how they want to install Node.js 24 LTS (the installer from nodejs.org, a version manager such as `nvm install 24` or `fnm install 24`, or their package manager). Continue once `node --version` prints v24.12.0 or newer.

## 2. Get the Checkout

If your working directory is already an AgentShark checkout (its `package.json` has `"name": "agentshark"`), use it. Otherwise clone the repository into `~/agentshark`, or into the folder the person named. If that folder already holds an AgentShark checkout, update it with `git pull --ff-only` instead of cloning again.

Run every later command from the checkout's root.

## 3. Build and Link

```bash
npm ci
npm run build
npm link
```

`npm ci` installs TypeScript, which the build uses; AgentShark itself has no runtime dependencies. `npm link` puts an `agentshark` command on the PATH. If it fails with a permission error (`EACCES`), do not retry with `sudo`. Skip the link instead, and wherever this guide writes `agentshark`, use `node <checkout>/bin/agentshark.ts` with the checkout's absolute path.

Check the result:

```bash
agentshark --help
```

It prints a list of commands that starts with `telemetry` and `demo`.

## 4. Build the Index

```bash
agentshark index
agentshark sources
```

`index` finds the logs of every supported agent on this machine and indexes them into `~/.agentshark/index.sqlite`. A large history can take a minute or more. `sources` reports which agents it found and what their logs record. If `index` reports zero sources, tell the person which agents `sources` lists, and point them to Settings ▸ Sources in the macOS app or to `agentshark config --agent claude|codex --add PATH` for logs in a custom folder.

## 5. Register the MCP Server

The read-only MCP server lets you and later sessions ask AgentShark about past runs. Register it with the agent you are, unless the person said not to. Check first whether a server named `agentshark` already exists, and leave it alone if it does.

Claude Code:

```bash
claude mcp get agentshark || claude mcp add --scope user agentshark -- agentshark mcp
```

Codex:

```bash
codex mcp get agentshark || codex mcp add agentshark -- agentshark mcp
```

For any other agent, give the person the stdio command `agentshark mcp` and let them register it. If you skipped `npm link` in step 3, register `node` with the arguments `<checkout>/bin/agentshark.ts mcp` instead. The new tools appear in the agent's next session, not in the current one.

## 6. Optional: Build the macOS App

Do this only if the person asked for the desktop app. It needs macOS 15 or later and a Swift toolchain (`swift --version` must work).

```bash
npm run desktop:build
```

The app is written to `dist/AgentShark.app`. If the checkout sits in an iCloud-synced Desktop or Documents folder, the build refuses that output path; set `APP_OUTPUT` to a path outside it, for example `APP_OUTPUT=~/Applications/AgentShark.app npm run desktop:build`. Ask before you move or replace anything in `/Applications`.

## 7. Report Back

Tell the person, briefly:

- the checkout path and the Node.js version used;
- whether `agentshark` is on the PATH, or which `node … bin/agentshark.ts` command replaces it;
- how many sources `agentshark index` parsed, and which agents `agentshark sources` found;
- which agent you registered the MCP server with, and that it takes effect in a new session;
- the macOS app's path, if you built it.

Then give them the next command to run in their own terminal. `agentshark serve` opens the viewer on their logs; it keeps running until Ctrl+C, so do not start it in a way that blocks you. `agentshark demo` opens a tour on synthetic data instead.

To uninstall later: `npm uninstall -g agentshark`, `claude mcp remove agentshark` or `codex mcp remove agentshark`, then delete the checkout. `~/.agentshark` holds only the rebuildable index and source settings, and can be deleted as well.
