// Enumerate tests ourselves so npm scripts work in cmd.exe as well as POSIX shells.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const files = readdirSync('test', { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile() && f.name.endsWith('.test.ts')).map((f) => join(f.parentPath, f.name)).sort();
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
