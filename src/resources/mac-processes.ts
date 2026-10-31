import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, setPriority } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ProcessActivity } from './types.ts';

/** One resident native process replaces ten ps launches per second. Each request/output is bounded. */
export function macProcessCollector(roots: number[]) {
  let child: ChildProcessWithoutNullStreams | undefined, directory: string | undefined, closed = false;
  let starting: Promise<void> | undefined, bytes = '';
  let helperPath: string | undefined;
  let retryAt = 0;
  let waiting: { resolve(v: ProcessActivity): void; reject(e: Error): void; timer: NodeJS.Timeout } | undefined;
  const failure = () => Object.assign(new Error('Native process collector unavailable'), { code: 'RESOURCE_UNAVAILABLE' });
  const fail = () => { if (waiting) { clearTimeout(waiting.timer); waiting.reject(failure()); waiting = undefined; } };
  const start = async () => {
    const source = new URL('./native/darwin.c', import.meta.url);
    const bundled = [new URL('./native/darwin-counter', import.meta.url), new URL('../../build/src/resources/native/darwin-counter', import.meta.url)].find((p) => existsSync(p) && statSync(p).mtimeMs >= statSync(source).mtimeMs);
    let path: string;
    if (bundled) path = fileURLToPath(bundled);
    else {
      directory ??= await mkdtemp(join(tmpdir(), 'agentshark-libproc-'));
      path = join(directory, 'counter');
      const developer = process.env.DEVELOPER_DIR ?? (existsSync('/Library/Developer/CommandLineTools') ? '/Library/Developer/CommandLineTools' : undefined);
      await promisify(execFile)('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', fileURLToPath(new URL('./native/darwin.c', import.meta.url)), '-o', path],
        { timeout: 5000, maxBuffer: 65536, env: { ...process.env, ...(developer ? { DEVELOPER_DIR: developer } : {}) } });
    }
    if (closed) return;
    helperPath = path;
    bytes = '';
    const spawned = child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stopped = () => {
      if (child !== spawned) return;
      fail(); child = undefined; retryAt = performance.now() + 5000;
      spawned.kill('SIGKILL');
    };
    if (spawned.pid) try { setPriority(spawned.pid, 19); } catch { /* best effort */ }
    spawned.stderr.resume();
    spawned.stdin.on('error', stopped);
    spawned.once('error', stopped); spawned.once('exit', stopped);
    spawned.stdout.setEncoding('utf8');
    spawned.stdout.on('data', (chunk: string) => {
      if (child !== spawned) return;
      bytes += chunk;
      if (bytes.length > 65536) { fail(); child?.kill('SIGKILL'); return; }
      const end = bytes.indexOf('\n');
      if (end < 0) return;
      const line = bytes.slice(0, end); bytes = bytes.slice(end + 1);
      if (!waiting) return;
      const pending = waiting; waiting = undefined; clearTimeout(pending.timer);
      try {
        const frame = JSON.parse(line);
        if (!Array.isArray(frame.entries) || frame.entries.length > 128 || !Array.isArray(frame.unavailablePids) || frame.unavailablePids.length > 128) throw failure();
        pending.resolve({ roots, descendants: 'tracked', ...frame });
      } catch { pending.reject(failure()); child?.kill('SIGKILL'); }
    });
  };
  const collect = async (): Promise<ProcessActivity> => {
    if (closed) throw failure();
    if (!child) {
      if (performance.now() < retryAt) throw failure();
      if (!starting) starting = start().catch(() => { retryAt = performance.now() + 30_000; throw failure(); }).finally(() => { starting = undefined; });
      await starting;
    }
    if (!child || waiting) throw failure();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail(); child?.kill('SIGKILL'); }, 1000);
      waiting = { resolve, reject, timer };
      child!.stdin.write(roots.join(' ') + '\n', (e) => { if (e) fail(); });
    });
  };
  return Object.assign(collect, { helperPath: () => helperPath, close: async () => {
    closed = true; fail();
    await starting?.catch(() => {});
    child?.kill('SIGKILL'); child = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  } });
}
