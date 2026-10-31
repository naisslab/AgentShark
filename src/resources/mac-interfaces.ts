import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setPriority } from 'node:os';
import { prepareMacHelper } from './mac-helper.ts';
import type { NetworkCounter } from './sampler.ts';

/** One sleeping helper, one bounded request per actual interface observation. */
export function macInterfaceCollector() {
  let helper: Awaited<ReturnType<typeof prepareMacHelper>> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined, starting: Promise<void> | undefined, closed = false, bytes = '';
  let waiting: { resolve(v: NetworkCounter[]): void; reject(e: Error): void; timer: NodeJS.Timeout } | undefined;
  const stop = () => {
    const p = child; child = undefined; bytes = ''; p?.kill('SIGKILL');
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(new Error('Interface collector unavailable')); waiting = undefined; }
  };
  const start = async () => {
    helper ??= await prepareMacHelper();
    if (closed) return;
    const p = child = spawn(helper.path, ['--interfaces'], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (p.pid) try { setPriority(p.pid, 19); } catch { /* Best effort. */ }
    p.stderr.resume(); p.stdout.setEncoding('utf8');
    const failed = () => { if (child === p) stop(); };
    p.on('error', failed); p.on('exit', failed); p.stdin.on('error', failed);
    p.stdout.on('data', (chunk: string) => {
      if (child !== p) return;
      bytes += chunk;
      if (bytes.length > 65536) { stop(); return; }
      const end = bytes.indexOf('\n'); if (end < 0) return;
      const line = bytes.slice(0, end); bytes = bytes.slice(end + 1);
      if (!waiting) return;
      try {
        const rows = JSON.parse(line);
        if (!Array.isArray(rows) || !rows.length || rows.length > 512 || rows.some((r) => typeof r.name !== 'string'
          || !Number.isSafeInteger(r.rxBytes) || r.rxBytes < 0 || !Number.isSafeInteger(r.txBytes) || r.txBytes < 0)) throw new Error('Invalid counters');
        clearTimeout(waiting.timer); waiting.resolve(rows); waiting = undefined;
      } catch { stop(); }
    });
  };
  const collect = async (): Promise<NetworkCounter[]> => {
    if (closed || waiting) throw new Error('Interface collector unavailable');
    if (!child) {
      starting ??= start().finally(() => { starting = undefined; });
      await starting;
    }
    if (!child || closed) throw new Error('Interface collector unavailable');
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject, timer: setTimeout(stop, 1000) };
      child!.stdin.write('\n');
    });
  };
  return Object.assign(collect, { close: async () => { closed = true; stop(); await starting?.catch(() => {}); await helper?.close(); } });
}
