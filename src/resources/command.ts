import { execFile } from 'node:child_process';
import { setPriority } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/** Fixed arguments, no shell, bounded output/runtime, reduced child priority when permitted. */
export async function resourceCommand(file: string, args: string[], timeoutMs = 1000): Promise<string> {
  const pending = exec(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  if (pending.child.pid) try { setPriority(pending.child.pid, 19); } catch { /* best effort */ }
  return (await pending).stdout;
}
