// Where replayed calls run (docs/REPLAY.md §4.1). `Executor` is the narrow interface tools.ts needs; `DockerExecutor`
// implements it over the docker CLI, so replay adds no npm dependency. Tests supply their own executor over `run`.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  /** Output bytes past `maxBytes`, counted but not kept. */
  dropped: number;
  /** null when the process was killed. */
  exitCode: number | null;
  /** The client-side guard killed the call after its timeout. */
  timedOut: boolean;
  durMs: number;
}

export interface ExecOptions {
  stdin?: string | Buffer;
  timeoutMs?: number;
  /** Keep at most this many bytes of each stream. */
  maxBytes?: number;
}

export interface Executor {
  /** A folder inside the sandbox for replay state (the Claude Bash working directory per session). */
  readonly stateDir: string;
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Start a process without waiting for it. */
  start(argv: string[]): Promise<ExecResult>;
}

/** The folder in a replay container that holds replay state (§4.1, §5.2). */
export const STATE_DIR = '/tmp/.agentshark-replay';

/** Docker is missing or not running, or the container is gone. A replay cannot continue past it. */
export class DockerError extends Error {}

export interface DockerOptions {
  image: string;
  network: string;
  env: Record<string, string>;
  /** The session, as the `agentshark.replay` label. A saved state's image carries the label already. */
  label?: string;
}

/** Extra time the client waits past a call's timeout before it kills `docker exec` itself. */
const GUARD_MS = 15_000;
const DAEMON = /^(?:Error response from daemon|Error: No such container|Cannot connect to the Docker daemon|error during connect)|docker daemon is not running/i;
const DAEMON_DOWN = /Cannot connect to the Docker daemon|docker daemon is not running|error during connect|failed to connect to the docker API/i;

export class DockerExecutor implements Executor {
  readonly stateDir = STATE_DIR;
  readonly name: string;
  private closed = false;

  private constructor(name: string) {
    this.name = name;
  }

  /** Create and start the container. It idles until calls arrive; `--init` reaps the orphans they leave. */
  static async create(o: DockerOptions): Promise<DockerExecutor> {
    const name = `agentshark-replay-${randomBytes(4).toString('hex')}`;
    const env = Object.entries(o.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const label = o.label === undefined ? [] : ['--label', `agentshark.replay=${o.label}`];
    const r = await docker([
      'run', '-d', '--init', '--network', o.network, '--name', name, ...label, ...env,
      '--entrypoint', 'sh', o.image, '-c', 'trap "exit 0" TERM; while :; do sleep 3600; done',
    ]);
    if (r.exitCode !== 0) throw new DockerError(`docker run failed: ${dockerMessage(r)}`);
    return new DockerExecutor(name);
  }

  /** Continue in an existing replay container, starting it again when it has stopped. */
  static async attach(name: string): Promise<DockerExecutor> {
    const r = await docker(['start', name]);
    if (r.exitCode !== 0) throw new DockerError(`cannot start the container ${name}: ${dockerMessage(r)}`);
    return new DockerExecutor(name);
  }

  /**
   * Whether `name` names a replay container (with its image and network) or an image saved from one, by the
   * `agentshark.replay` label both carry; null when it names neither. Nothing is started.
   */
  static async inspect(name: string): Promise<{ kind: 'container'; image: string; network: string } | { kind: 'image' } | null> {
    for (const kind of ['container', 'image'] as const) {
      const r = await docker([kind, 'inspect', name]);
      if (r.exitCode !== 0) {
        if (DAEMON_DOWN.test(r.stderr.toString('utf8'))) throw new DockerError(dockerMessage(r));
        continue;
      }
      let info;
      try {
        info = JSON.parse(r.stdout.toString('utf8'))[0];
      } catch {
        return null;
      }
      if (!info?.Config?.Labels?.['agentshark.replay']) return null;
      return kind === 'image' ? { kind } : { kind, image: String(info.Config.Image), network: String(info.HostConfig?.NetworkMode ?? 'none') };
    }
    return null;
  }

  /** Whether an image `tag` exists. */
  static async exists(tag: string): Promise<boolean> {
    return (await docker(['image', 'inspect', tag])).exitCode === 0;
  }

  /** A file in the state folder of a container or an image, read without starting either; null when it is missing. */
  static async readState(name: string, kind: 'container' | 'image', file: string): Promise<string | null> {
    // An image is read through a container that is created, never started, and removed.
    let source = name;
    if (kind === 'image') {
      const c = await docker(['create', '--network', 'none', '--entrypoint', 'true', name]);
      if (c.exitCode !== 0) throw new DockerError(`cannot read ${name}: ${dockerMessage(c)}`);
      source = c.stdout.toString('utf8').trim();
    }
    try {
      const r = await docker(['cp', `${source}:${STATE_DIR}/${file}`, '-']);
      return r.exitCode === 0 ? untar(r.stdout) : null;
    } finally {
      if (kind === 'image') await docker(['rm', '-f', source]);
    }
  }

  /** Save the container's files, environment and labels as the image `tag`. Running processes are not saved. */
  async commit(tag: string): Promise<void> {
    const r = await docker(['commit', this.name, tag]);
    if (r.exitCode !== 0) throw new Error(`docker commit failed: ${dockerMessage(r)}`);
  }

  /** Copy the contents of a host folder to `dest` in the container, creating `dest`. */
  async copyIn(hostDir: string, dest: string): Promise<void> {
    const mk = await this.exec(['mkdir', '-p', dest]);
    if (mk.exitCode !== 0) throw new DockerError(`cannot create ${dest} in the container: ${dockerMessage(mk)}`);
    const r = await docker(['cp', `${hostDir.replace(/\/+$/, '')}/.`, `${this.name}:${dest}`]);
    if (r.exitCode !== 0) throw new DockerError(`docker cp failed: ${dockerMessage(r)}`);
  }

  async exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const args = ['exec', ...(opts.stdin !== undefined ? ['-i'] : []), this.name, ...argv];
    return this.checked(await docker(args, { ...opts, timeoutMs: opts.timeoutMs === undefined ? undefined : opts.timeoutMs + GUARD_MS }));
  }

  async start(argv: string[]): Promise<ExecResult> {
    return this.checked(await docker(['exec', '-d', this.name, ...argv]));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await docker(['rm', '-f', this.name]);
  }

  /** A docker-looking error counts as docker's own only when the container is no longer running. */
  private async checked(r: ExecResult): Promise<ExecResult> {
    if (r.exitCode === 0 || !DAEMON.test(r.stderr.toString('utf8'))) return r;
    const state = await docker(['inspect', '-f', '{{.State.Running}}', this.name]);
    if (state.exitCode === 0 && state.stdout.toString('utf8').trim() === 'true') return r;
    throw new DockerError(this.closed ? 'replay interrupted' : `the container stopped: ${dockerMessage(r)}`);
  }
}

async function docker(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  try {
    // A process group of its own, so that the terminal's Ctrl-C reaches the replay, which decides what to stop.
    return await run('docker', args, { ...opts, group: true });
  } catch (e) {
    throw (e as NodeJS.ErrnoException).code === 'ENOENT' ? new DockerError('docker is not installed or not on PATH') : e;
  }
}

/** Run a program and collect its output. A timeout kills it, or with `group` its whole process group. */
export function run(cmd: string, args: string[], opts: ExecOptions & { group?: boolean } = {}): Promise<ExecResult> {
  const t0 = performance.now();
  const max = opts.maxBytes ?? Infinity;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: opts.group === true });
    let dropped = 0;
    const collect = (into: Buffer[]) => {
      let kept = 0;
      return (b: Buffer) => {
        const take = Math.min(b.length, max - kept);
        dropped += b.length - take;
        if (take > 0) into.push(take === b.length ? b : b.subarray(0, take));
        kept += take;
      };
    };
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    let timedOut = false;
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try {
        if (opts.group) process.kill(-child.pid!, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, opts.timeoutMs);
    child.stdout!.on('data', collect(out));
    child.stderr!.on('data', collect(errs));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(errs), dropped, exitCode: timedOut ? null : code, timedOut, durMs: performance.now() - t0 });
    });
    if (opts.stdin !== undefined) {
      child.stdin!.on('error', () => {}); // the process may exit before reading its input
      child.stdin!.end(opts.stdin);
    }
  });
}

/** The first regular file in a tar archive, which `docker cp ... -` writes, as text; null when there is none. */
function untar(tar: Buffer): string | null {
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) return null;
    const size = parseInt(header.toString('latin1', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = header[156];
    if (type === 0x30 || type === 0) return tar.toString('utf8', at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

function dockerMessage(r: ExecResult): string {
  const text = r.stderr.toString('utf8').trim() || r.stdout.toString('utf8').trim() || `exit ${r.exitCode}`;
  if (DAEMON_DOWN.test(text)) {
    return 'the Docker daemon is not running; start Docker Desktop (or colima) and retry';
  }
  // ~/.docker/config.json names a credsStore whose docker-credential-* program is not on PATH (common when the CLI
  // comes from Homebrew and the helper from Docker Desktop), so docker cannot pull the image.
  const helper = /error getting credentials.*?"(docker-credential-[\w-]+)"/s.exec(text)?.[1];
  if (helper) return `docker cannot run its credential helper ${helper} to pull the image; put it on PATH, or pull the image yourself with docker pull and retry`;
  return text.split('\n').slice(-3).join(' ');
}
