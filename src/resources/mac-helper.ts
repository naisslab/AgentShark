import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export async function prepareMacHelper() {
  const source = new URL('./native/darwin.c', import.meta.url);
  const bundled = [new URL('./native/darwin-counter', import.meta.url), new URL('../../build/src/resources/native/darwin-counter', import.meta.url)]
    .find((p) => existsSync(p) && statSync(p).mtimeMs >= statSync(source).mtimeMs);
  if (bundled) return { path: fileURLToPath(bundled), close: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), 'agentshark-discovery-'));
  const path = join(directory, 'counter');
  const close = () => rm(directory, { recursive: true, force: true });
  try {
    const developer = process.env.DEVELOPER_DIR ?? (existsSync('/Library/Developer/CommandLineTools') ? '/Library/Developer/CommandLineTools' : undefined);
    await promisify(execFile)('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', fileURLToPath(source), '-o', path],
      { timeout: 5000, maxBuffer: 65536, env: { ...process.env, ...(developer ? { DEVELOPER_DIR: developer } : {}) } });
    return { path, close };
  } catch (error) { await close(); throw error; }
}
