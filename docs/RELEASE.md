# Build and Validate a Release

This guide covers building and checking the macOS app from a checkout. The maintainers build signed and notarized releases with a workflow and test suites that are not in this repository.

## Desktop Build

`npm run desktop:build` compiles the engine and native client, bundles a pinned official Node 24 LTS runtime, includes runtime license notices, and verifies the app signature. The default ad hoc signature is for local testing. `--without-node` creates a developer-only bundle and must never be distributed as the end-user application.

The bundle goes to `dist/AgentShark.app`, or to `APP_OUTPUT` when set. iCloud Drive's Desktop and Documents folders add Finder information to every bundle, which `codesign` rejects, so the script refuses an output path inside them. For a checkout in such a folder, set `APP_OUTPUT` to a path outside it.

Run `PATH=/usr/bin:/bin dist/AgentShark.app/Contents/MacOS/AgentShark --verify-bundle` to exercise the native launcher, bundled runtime, synthetic indexing, authenticated API, and temporary-data cleanup without a system Node on PATH. This headless check does not open personal traces or replace a graphical clean-machine launch review.

Offline builds run `bash mac/scripts/build-app.sh` with `NODE=/absolute/path/to/node-v24.x-darwin-ARCH/bin/node` and `NODE_LICENSE=/absolute/path/to/node-v24.x-darwin-ARCH/LICENSE`. `npm run` replaces `NODE` with its own interpreter, which the script ignores. The script rejects a runtime that cannot run after relocation or links non-system libraries. It tests SQLite and zstd support before assembly. Use an architecture-matched runtime.

The runtime download helper retrieves the exact version's archive and official SHASUMS256.txt over HTTPS, checks SHA-256, rejects unexpected archive paths, and preserves the runtime LICENSE. Update the pinned version through a reviewed change and rerun compatibility checks. The runtime is fetched at build time; application users do not download dependencies on first launch.
