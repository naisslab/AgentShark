# Build and Validate a Release

Do not publish from a dirty developer checkout. Run the source checks and installed-package smoke test, review `npm pack --dry-run --json`, and ensure the package contains only the release allowlist. The npm package has no runtime dependencies and must contain JavaScript rather than TypeScript entry points.

## Desktop Build

`npm run desktop:build` compiles the engine and native client, bundles a pinned official Node 24 LTS runtime, includes runtime license notices, and verifies the app signature. The default ad hoc signature is for local testing. `--without-node` creates a developer-only bundle and must never be distributed as the end-user application.

The bundle goes to `dist/AgentShark.app`, or to `APP_OUTPUT` when set. iCloud Drive's Desktop and Documents folders add Finder information to every bundle, which `codesign` rejects, so the script refuses an output path inside them. For a checkout in such a folder, set `APP_OUTPUT` to a path outside it.

Run `PATH=/usr/bin:/bin dist/AgentShark.app/Contents/MacOS/AgentShark --verify-bundle` to exercise the native launcher, bundled runtime, synthetic indexing, authenticated API, and temporary-data cleanup without a system Node on PATH. This headless check does not open personal traces or replace a graphical clean-machine launch review.

Offline builds run `bash mac/scripts/build-app.sh` with `NODE=/absolute/path/to/node-v24.x-darwin-ARCH/bin/node` and `NODE_LICENSE=/absolute/path/to/node-v24.x-darwin-ARCH/LICENSE`. `npm run` replaces `NODE` with its own interpreter, which the script ignores. The script rejects a runtime that cannot run after relocation or links non-system libraries. It tests SQLite and zstd support before assembly. Use an architecture-matched runtime.

The runtime download helper retrieves the exact version's archive and official SHASUMS256.txt over HTTPS, checks SHA-256, rejects unexpected archive paths, and preserves the runtime LICENSE. Update the pinned version through a reviewed change and rerun compatibility checks. The runtime is fetched at build time; application users do not download dependencies on first launch.

## Signing and Notarization

The Desktop Artifact workflow runs only when a maintainer dispatches it. Unsigned test artifacts require no Apple secrets and are labeled accordingly. Select signing only after configuring APPLE_CERTIFICATE_P12, APPLE_CERTIFICATE_PASSWORD, CODESIGN_IDENTITY, APPLE_ID, APPLE_APP_PASSWORD, and APPLE_TEAM_ID. The workflow imports the certificate into a temporary keychain, signs the runtime and app, notarizes, staples, and verifies the result. Signing credentials never enter the app bundle.

The workflow uploads a zip and SHA-256 manifest as CI artifacts. It does not publish npm packages or create a public release automatically. Review and authorize public publication separately. Include release notes, supported source dialects, minimum OS/runtime versions, checksums, and explicit known limitations.

## Release Acceptance

- Launch each native artifact on a clean Mac without Node, npm, a checkout, or a developer signing environment.
- Confirm automatic discovery, first-index progress, no-source state, source selection, quit/restart, demo, and capture open.
- Open the native Research workbench and test its browser export action.
- Install the packed npm artifact on Linux, Windows, and macOS, run the sample, and verify capture round trips and MCP access.
- Verify that a blocked or unavailable source produces an honest diagnostic and does not erase indexed evidence.
- Run the native HTTP fixture decoding test against the same engine revision.
- Check package contents and ensure no personal logs, output directories, worktrees, build caches, or credentials are included.

Only record a platform as verified after its tests or clean-machine checks actually pass. Local ad hoc signing and a successful build are not notarization.
