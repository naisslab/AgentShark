# Contributing to AgentShark

Use Node.js 24 LTS and `npm ci`, then run `npm run typecheck`, `npm test`, and `npm run test:package`. The package smoke test builds, packs, installs into a temporary directory, indexes synthetic traces, opens a capture, and checks the HTTP viewer. It must pass without a checkout on the installed package's module path.

Develop and measure on an official Node.js build: one from nodejs.org, or the runtime the desktop app ships, which `node scripts/fetch-runtime.mjs` downloads into `.runtime/` and whose `node` path it prints. Homebrew's `node` links Homebrew's SQLite, which is built with `SQLITE_ENABLE_MEMORY_MANAGEMENT` (its `PRAGMA compile_options` lists `ENABLE_MEMORY_MANAGEMENT`). Every SQLite connection in the process then shares one page cache behind a global mutex, so the derive pool and the query workers scale worse than in the shipped app. AgentShark runs correctly there, but performance measured on it does not represent the app, and raising `AGENTSHARK_QUERY_WORKERS` there can make concurrent queries slower than running them one at a time.

The desktop client uses Swift Package Manager and requires macOS 15 or later. Run `AGENTSHARK_DERIVE_FIXTURES="$PWD/test/fixtures/derive/http" swift test --package-path mac`. `npm run desktop:build` assembles a self-contained application and downloads a checksum-verified Node runtime for the build. Set `NODE` and `NODE_LICENSE` to an official unpacked runtime for offline builds. See docs/RELEASE.md.

## Data and Evidence

Use synthetic or explicitly consented, redacted fixtures. Never submit private agent logs, index databases, tokens, generated analysis output, or local build caches. A report should identify the source agent/version, observed problem, minimal reproducer, and expected behavior. Captures contain source text unless explicitly redacted; removing raw lines alone does not anonymize them.

## Add an Adapter

Implement the `Adapter` contract in `src/adapters/adapter.ts`: discover only relevant files, parse into normalized records, retain unknown records, and preserve source pointers. Register it in `src/adapters/registry.ts`. Add a fixture generator and tests covering missing fields, malformed records, append/truncation, duplicate records, and parent/child relationships. Document the observed dialect and which fields are logged, derived, or unavailable. Do not infer timestamps or outcomes without exposing provenance.

## Interfaces and Tests

When you change a payload that the web viewer or the macOS app reads, update the TypeScript and native decoding fixtures together. Keep analysis correctness tests separate from timing assertions; `npm run test:perf` runs performance budgets sequentially and should run on an otherwise quiet machine.

Keep changes focused and describe what changed, why, and what was tested. Include screenshots for interface changes and use the bundled sample. CI checks source correctness and the shipped artifact; documentation alone does not establish compatibility.

The full engine suite runs on Linux and macOS. Windows runs type checking and installed-package checks; port the remaining Unix signal and HOME-based fixtures before enabling the full suite there. The demo test checks graceful signal cleanup on POSIX because Windows process termination does not invoke the same handlers.
