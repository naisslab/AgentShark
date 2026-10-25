// Compile a self-contained engine without shipping checkout files or runtime dependencies.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const output = new URL('build/', root);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const directory of ['bin', 'src']) {
  const base = new URL(`${directory}/`, root);
  for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const rel = relative(fileURLToPath(base), file).replaceAll('\\', '/');
    const dest = new URL(`${directory}/${rel.replace(/\.ts$/, '.js')}`, output);
    mkdirSync(new URL('.', dest), { recursive: true });
    if (!rel.endsWith('.ts')) {
      const allowed = directory === 'src' && (rel === 'index/schema.sql' || /^workbench\/schemas\/[^/]+\.schema\.json$/.test(rel));
      if (!allowed) throw new Error(`Unexpected source asset ${directory}/${rel}; review it before extending the release allowlist.`);
      cpSync(file, dest);
      continue;
    }
    const result = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
        rewriteRelativeImportExtensions: true, verbatimModuleSyntax: true, sourceMap: false },
    });
    const errors = result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) throw new Error(`${rel}: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')}`);
    // TypeScript rewrites imports, but worker URL literals are ordinary strings.
    const code = result.outputText.replace(/new URL\((['"])([^'"]+)\.ts\1/g, 'new URL($1$2.js$1');
    writeFileSync(dest, code);
  }
}
cpSync(new URL('web/', root), new URL('web/', output), { recursive: true });
// The demo's synthetic sample (src/cli/demo.ts): Codex sessions, and the analysis corpus with Claude Code subagents,
// a workflow and Codex failures.
cpSync(new URL('test/fixtures/codex/home/.codex/', root), new URL('samples/codex/', output), { recursive: true });
cpSync(new URL('test/fixtures/derive/home/.claude/', root), new URL('samples/claude/', output), { recursive: true });
cpSync(new URL('test/fixtures/derive/home/.codex/', root), new URL('samples/codex-failures/', output), { recursive: true });
const { name, version, type, license } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
writeFileSync(new URL('package.json', output), JSON.stringify({ name, version, type, license }, null, 2) + '\n');
chmodSync(new URL('bin/agentshark.js', output), 0o755);
console.log(`Built ${name} ${version}: JavaScript engine, workers, SQL, viewer, and synthetic sample.`);
