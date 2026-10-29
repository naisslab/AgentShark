// `agentshark replay` (docs/REPLAY.md): plan a session's tool calls from the index, run them in a Docker container
// at the recorded or a scaled pace, and report how each result compares with the recording. A replay can pause at
// breakpoints, take keys on a terminal, and stop in a state that a later run resumes.

import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { oneLine } from '../adapters/adapter.ts';
import { defaultIndexPath } from '../index/db.ts';
import { normalize, type Verdict, VERDICTS } from '../replay/compare.ts';
import { DockerError, DockerExecutor } from '../replay/executor.ts';
import { PlanError, planReplay, type PlannedCall, type ReplayPlan, resolveSession, revOf, shellQuote } from '../replay/plan.ts';
import {
  type Breaks, type CallOutcome, clearResumeState, DEFAULT_TIMEOUT_MS, type Pacing, parseResumeState, projectMs, RESUME_FILE,
  resumeAt, type ResumeState, runReplay, saveResumeState, type Summary, waitMs,
} from '../replay/run.ts';
import { missingPrograms, openSandbox, type Sandbox } from '../replay/tools.ts';
import { openQueries } from './inspect.ts';
import { TerminalControl } from './replay-control.ts';
import { openCaptureIndex } from './serve.ts';
import { type Args, CliError, err, fmtDur, out, pad, parseDuration, string, strings, tildify, write } from './util.ts';

const DEFAULT_IMAGE = 'node:24-bookworm';
/** Exit code when at least one executed call's status differs from the recording. */
const EXIT_DIVERGED = 3;

/** A stopped replay to continue: its container, or an image saved from one, and the state it left (§5.2). */
interface Saved {
  name: string;
  kind: 'container' | 'image';
  /** The image the container started from, or the saved image itself. */
  image: string;
  /** A container's own network; an image runs on --network. */
  network: string | null;
  state: ResumeState;
}

export async function replay(a: Args): Promise<number> {
  const ref = a.positionals[0];
  const resumeArg = string(a.values.resume);
  if (!ref && resumeArg === undefined) throw new CliError('replay needs a session id: agentshark replay SESSION --workspace DIR', 2);
  const dry = a.values['dry-run'] === true;
  const workspaceArg = string(a.values.workspace);
  if (resumeArg !== undefined) {
    const extra = ['workspace', 'rev', 'image', 'dry-run'].find((k) => a.values[k] !== undefined);
    if (extra) throw new CliError(`--resume continues where a replay stopped, so it takes no --${extra}`, 2);
  } else if (!dry && !workspaceArg) {
    throw new CliError('replay needs --workspace DIR: the folder the session started from (or --dry-run)', 2);
  }
  const workspace = workspaceArg === undefined ? undefined : resolve(workspaceArg);
  if (workspace !== undefined && !statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new CliError(`--workspace ${workspaceArg} is not a folder`, 2);
  }
  const rev = string(a.values.rev);
  const pacing: Pacing = {
    speed: parseSpeed(string(a.values.speed)),
    maxGapMs: a.values['max-gap'] === undefined ? null : parseDuration(string(a.values['max-gap'])!, '--max-gap') / 1000,
  };
  const timeout = string(a.values.timeout);
  const timeoutMs = timeout === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(timeout, '--timeout') / 1000;
  const network = string(a.values.network);
  const env = parseEnv(strings(a.values.env));
  const breaks = parseBreaks(strings(a.values.break));
  const json = a.values.json === true;
  const outPath = string(a.values.output);

  // A resume reads the saved state first: it names the session, the call to continue from and where both came from.
  // Nothing is started until every check has passed.
  const saved = resumeArg === undefined ? null : await savedReplay(resumeArg);
  if (saved?.kind === 'container' && (network !== undefined || Object.keys(env).length)) {
    throw new CliError(`${saved.name} is a container, which keeps its network and environment; --network and --env apply to a saved image`, 2);
  }
  const capture = string(a.values.capture) ?? saved?.state.capture ?? undefined;
  // Save the actual live index even when it came from AGENTSHARK_HOME or the default home directory.
  const index = string(a.values.index) ?? saved?.state.index ?? (capture === undefined ? defaultIndexPath() : undefined);
  const { plan, from } = await withIndex(a, index, capture, async (db, mode) => {
    try {
      const session = resolveSession(db, ref ?? saved!.state.session);
      if (saved && session !== saved.state.session) throw new PlanError(`${saved.name} holds a replay of ${saved.state.session}, not ${session}`);
      const plan = await planReplay(db, mode, session);
      return { plan, from: saved ? resumeAt(plan, saved.state) : 1 };
    } catch (e) {
      if (e instanceof PlanError) throw new CliError(e.message);
      throw e;
    }
  });
  const beyond = [...breaks.calls].find((n) => n > plan.calls.length);
  if (beyond) throw new CliError(`--break ${beyond}: the plan has ${plan.calls.length} calls`, 2);

  const file = outPath === undefined ? null : createWriteStream(outPath);
  const emit = async (o: object) => {
    const line = JSON.stringify(o) + '\n';
    if (json) await write(line);
    if (file) await new Promise<void>((r) => (file.write(line) ? r() : file.once('drain', r)));
  };
  const setup: Setup = {
    workspace: workspace ?? null, rev: rev ?? null, image: saved?.image ?? string(a.values.image) ?? DEFAULT_IMAGE,
    network: saved?.network ?? network ?? saved?.state.network ?? 'none', timeoutMs, from, resumed: saved?.name ?? null,
  };
  try {
    if (dry) {
      await emit(planRecord(plan, setup, pacing, null));
      if (!json) {
        await write(header(plan, setup, pacing, breaks, null) + '\n');
        const w = String(plan.calls.length).length;
        for (const c of plan.calls) await write(planLine(c, w, pacing) + '\n');
      }
      return 0;
    }
    const run: Run = {
      env, breaks, keep: a.values.keep === true, json,
      capture: capture === undefined ? null : resolve(capture), index: index === undefined ? null : resolve(index),
      // The keys print to stdout and open a shell there, so every stream must be the terminal.
      interactive: !json && process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true,
    };
    const summary = await replayInDocker(plan, setup, pacing, saved, run, emit);
    return summary.firstDivergence !== null ? EXIT_DIVERGED : 0;
  } finally {
    if (file) await closeStream(file);
  }
}

interface Setup {
  workspace: string | null;
  rev: string | null;
  /** The image the container starts from: the chosen one, or a saved state's. */
  image: string;
  network: string;
  /** `--timeout`: the longest one call may run, ms. */
  timeoutMs: number;
  /** The first call this run executes. */
  from: number;
  /** The container or image a resumed replay continues. */
  resumed: string | null;
}

interface Run {
  env: Record<string, string>;
  breaks: Breaks;
  keep: boolean;
  json: boolean;
  /** Where the session came from, saved with a stopped replay so that its resume plans from the same place. */
  capture: string | null;
  index: string | null;
  /** Keys and a status line on the terminal. */
  interactive: boolean;
}

async function replayInDocker(
  plan: ReplayPlan, setup: Setup, pacing: Pacing, saved: Saved | null, o: Run, emit: (o: object) => Promise<void>,
): Promise<Summary> {
  if (!o.json && !saved) console.error(err.dim(`Starting ${setup.image} (docker pulls it when missing)...`));
  let ex: DockerExecutor;
  try {
    ex = saved?.kind === 'container'
      ? await DockerExecutor.attach(saved.name)
      : await DockerExecutor.create({
        image: setup.image, network: setup.network,
        // A saved image keeps the environment and label of the container it was saved from.
        env: saved ? o.env : { ...(plan.home ? { HOME: plan.home } : {}), ...o.env }, label: saved ? undefined : plan.session,
      });
  } catch (e) {
    if (e instanceof DockerError) throw new CliError(e.message);
    throw e;
  }
  const abort = new AbortController();
  // A resumed container holds the user's saved state: only a replay that reaches its last call removes it.
  let kept = o.keep || saved?.kind === 'container';
  let shell = 'sh';
  let told = false;
  /** The call before which the loop waits between batches; null while a batch runs. */
  let boundary: PlannedCall | null = null;
  const stateBefore = (next: PlannedCall): ResumeState => ({
    session: plan.session, next: next.n, event: next.event, capture: o.capture, index: o.index, network: setup.network,
  });
  /** Names a kept container once, whichever way the replay ends. */
  const tellKept = () => {
    if (!kept || told) return;
    told = true;
    console.error(`Container kept: docker exec -it ${ex.name} ${shell}   (remove it with: docker rm -f ${ex.name})`);
  };
  let control: TerminalControl | undefined;
  // The first Ctrl-C ends the replay once the running batch has finished; a second one leaves at once. The docker
  // processes have their own process group, so the terminal's Ctrl-C reaches only this process.
  const stop = () => {
    abort.abort();
    if (!o.interactive && !o.json) console.error(err.dim('Stopping after the running batch; press Ctrl-C again to leave now.'));
  };
  const leave = () => {
    control?.close();
    if (!kept) spawnSync('docker', ['rm', '-f', ex.name], { stdio: 'ignore' });
    else if (boundary && !told) {
      // Between two batches the container holds a state a resume can continue.
      const save = 'mkdir -p "$(dirname "$1")" && cat > "$1"';
      spawnSync('docker', ['exec', '-i', ex.name, 'sh', '-c', save, 'sh', `${ex.stateDir}/${RESUME_FILE}`], {
        input: JSON.stringify(stateBefore(boundary)) + '\n', stdio: ['pipe', 'ignore', 'ignore'],
      });
      told = true;
      console.error(stopText(boundary.n, ex.name, plan.cwd, shell));
    } else tellKept();
    process.exit(130);
  };
  const onSignal = () => (abort.signal.aborted ? leave() : stop());
  process.on('SIGINT', onSignal);
  try {
    if (!saved) await copyWorkspace(ex, setup.workspace!, setup.rev, plan.cwd);
    const sb = await openSandbox(ex, setup.timeoutMs);
    shell = sb.shell;
    const missing = await missingPrograms(plan.calls.filter((c) => c.n >= setup.from), sb);
    await emit(planRecord(plan, setup, pacing, { shell: sb.shell, hasTimeout: sb.hasTimeout, missing, container: ex.name }));
    if (!o.json) await write(header(plan, setup, pacing, o.breaks, { sb, missing, interactive: o.interactive, container: ex.name }) + '\n');
    const w = String(plan.calls.length).length;
    let lastRun: CallOutcome | null = null;
    if (o.interactive) {
      control = new TerminalControl({
        abort: stop,
        exit: leave,
        shell: () => {
          console.error(err.dim(`Shell in ${ex.name} at ${plan.cwd}; exit it to return to the replay.`));
          spawnSync('docker', ['exec', '-it', '-w', plan.cwd, ex.name, sb.shell], { stdio: 'inherit', env: { ...process.env, DOCKER_CLI_HINTS: 'false' } });
        },
        output: () => (lastRun ? outputView(lastRun, plan.calls[lastRun.n - 1]) : 'No call has run yet.'),
        save: async (next) => {
          // A new tag for every save, so that an earlier save of the same call stays as it was.
          const base = `agentshark-replay:${tagOf(plan.session)}-${next.n}`;
          let tag = base;
          for (let k = 2; await DockerExecutor.exists(tag); k++) tag = `${base}.${k}`;
          await saveResumeState(ex, stateBefore(next));
          try {
            await ex.commit(tag);
          } finally {
            // The image keeps the state; the running container moves past it.
            await clearResumeState(ex).catch(() => {});
          }
          return `Saved the state before #${next.n} as ${tag}. Start from it again with: agentshark replay --resume ${tag}`;
        },
      }, abort.signal);
    }
    let started = false;
    const summary = await runReplay(plan, sb, pacing, async (c) => {
      await emit(c);
      if (c.verdict !== 'skipped') lastRun = c;
      if (o.json) return;
      if (control) await control.print(callLine(c, w) + '\n');
      else await write(callLine(c, w) + '\n');
    }, {
      from: setup.from, resumed: saved !== null, breaks: o.breaks, control, signal: abort.signal,
      position: async (next) => {
        boundary = next;
        // The saved state holds until the first batch starts; a stop writes it again.
        if (next === null && saved && !started) await clearResumeState(ex);
        if (next === null) started = true;
      },
    });
    control?.close();
    // Stopping is resumable: the container keeps the state before the next call. So is an interrupted replay whose
    // container stays (--keep, or a resumed container), since a Ctrl-C lets the running batch finish.
    const stopped = summary.stoppedBefore;
    if (summary.stoppedAtEnd || (stopped !== null && !summary.interrupted)) kept = true;
    else if (stopped === null && !summary.interrupted) kept = o.keep;
    if (stopped !== null && kept) await saveResumeState(ex, stateBefore(plan.calls[stopped - 1]));
    await emit({ ...summary, container: kept ? ex.name : null });
    if (!o.json) await write(summaryText(summary) + '\n');
    if ((stopped !== null && kept) || summary.stoppedAtEnd) {
      told = true;
      console.error(stopText(stopped, ex.name, plan.cwd, sb.shell));
    }
    return summary;
  } catch (e) {
    if (e instanceof DockerError) throw new CliError(e.message);
    throw e;
  } finally {
    control?.close();
    process.off('SIGINT', onSignal);
    if (kept) tellKept();
    else await ex.close();
  }
}

/** The stopped replay that `--resume NAME` names: a kept container, or an image saved from one. */
async function savedReplay(name: string): Promise<Saved> {
  try {
    const found = await DockerExecutor.inspect(name);
    if (!found) throw new CliError(`--resume ${name}: no replay container, or image saved from one, has that name`, 2);
    const text = await DockerExecutor.readState(name, found.kind, RESUME_FILE);
    const state = text === null ? null : parseResumeState(text);
    if (!state) throw new CliError(`--resume ${name}: it holds no stopped replay (a replay saves its state when it stops before its last call)`);
    const container = found.kind === 'container' ? found : null;
    return { name, kind: found.kind, image: container?.image ?? name, network: container?.network ?? null, state };
  } catch (e) {
    if (e instanceof DockerError) throw new CliError(e.message);
    throw e;
  }
}

/** The plan's index: the live one at `index`, or the one `open` builds from a capture file. Closed after `fn`. */
async function withIndex<T>(
  a: Args, index: string | undefined, capture: string | undefined, fn: (db: DatabaseSync, mode: 'live' | 'capture') => Promise<T>,
): Promise<T> {
  const db = capture === undefined ? openQueries({ ...a, values: { ...a.values, index } }).db : (await openCaptureIndex(capture)).db;
  try {
    return await fn(db, capture === undefined ? 'live' : 'capture');
  } finally {
    db.close();
  }
}

/** Copy the starting files into the container at the recorded cwd (§4.2). The user's repository is never changed. */
async function copyWorkspace(ex: DockerExecutor, dir: string, rev: string | null, cwd: string): Promise<void> {
  if (rev === null) return ex.copyIn(dir, cwd);
  const tmp = mkdtempSync(join(tmpdir(), 'agentshark-replay-'));
  try {
    const clone = join(tmp, 'ws');
    git(['clone', '--quiet', '--no-checkout', '--', dir, clone], `cannot clone ${tildify(dir)}`);
    git(['-C', clone, 'checkout', '--quiet', '--detach', rev], `cannot check out ${rev} in ${tildify(dir)}`);
    await ex.copyIn(clone, cwd);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function git(args: string[], what: string): void {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.error) throw new CliError(`${what}: git is not available`);
  if (r.status !== 0) throw new CliError(`${what}: ${(r.stderr || '').trim().split('\n').at(-1)}`);
}

/** A docker tag for a saved state: the session id's last twelve characters, which differ even between UUIDv7 ids. */
function tagOf(session: string): string {
  return (session.split(':').pop() ?? session).toLowerCase().replace(/[^a-z0-9]/g, '').slice(-12);
}

// ---------------------------------------------------------------------------
// Arguments

function parseSpeed(s: string | undefined): number | 'max' {
  if (s === undefined) return 1;
  if (s === 'max') return 'max';
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`--speed expects a positive number or max (got '${s}')`, 2);
  return n;
}

function parseEnv(list: string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const kv of list ?? []) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new CliError(`--env expects KEY=VALUE (got '${kv}')`, 2);
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

function parseBreaks(list: string[] | undefined): Breaks {
  const breaks: Breaks = { calls: new Set(), verdicts: new Set() };
  for (const b of list ?? []) {
    if (/^[1-9]\d*$/.test(b)) breaks.calls.add(Number(b));
    else if ((VERDICTS as readonly string[]).includes(b)) breaks.verdicts.add(b as Verdict);
    else throw new CliError(`--break expects a call number or a verdict (${VERDICTS.join(', ')}); got '${b}'`, 2);
  }
  return breaks;
}

function closeStream(s: WriteStream): Promise<void> {
  return new Promise((r) => s.end(r));
}

// ---------------------------------------------------------------------------
// Output

interface SandboxFacts {
  shell: string;
  hasTimeout: boolean;
  missing: { name: string; calls: number }[];
  /** Named before the first call, so that a replay killed later still says which container it leaves. */
  container: string;
}

function planRecord(plan: ReplayPlan, setup: Setup, p: Pacing, sandbox: SandboxFacts | null) {
  return {
    type: 'plan', session: plan.session, agent: plan.agent, cwd: plan.cwd, sessions: plan.sessions, ...setup,
    speed: p.speed, maxGapMs: p.maxGapMs, projectedMs: Math.round(projectMs(plan, p, setup.timeoutMs, setup.from)), sandbox,
    calls: plan.calls.map((c) => ({
      n: c.n, event: c.event, session: c.session, batch: c.batch, tool: c.tool, class: c.action.cls,
      ...(c.action.cls === 'skip' && { reason: c.action.reason }),
      inputSrc: c.inputSrc, gapMs: Math.round(waitMs(c.gapUs, p)), holdMs: Math.round(waitMs(c.holdUs, p)),
    })),
  };
}

/** What a run has learned about its container, for the header. */
interface Live {
  sb: Sandbox;
  missing: SandboxFacts['missing'];
  interactive: boolean;
  container: string;
}

/** The plan header. A resumed run counts and projects only the calls it has left. */
function header(plan: ReplayPlan, setup: Setup, p: Pacing, breaks: Breaks, live: Live | null): string {
  const left = plan.calls.filter((c) => c.n >= setup.from);
  const tally = (pick: (c: PlannedCall) => string | null) => {
    const m = new Map<string, number>();
    for (const c of left) {
      const k = pick(c);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    const total = [...m.values()].reduce((x, y) => x + y, 0);
    return { total, text: [...m].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k}`).join(', ') };
  };
  const exec = tally((c) => (c.action.cls === 'skip' ? null : c.action.cls));
  const skip = tally((c) => (c.action.cls === 'skip' ? c.action.reason : null));
  const batches = new Set(plan.calls.map((c) => c.batch)).size;
  const subs = plan.sessions.length - 1;
  const speed = p.speed === 'max' ? 'no waits' : `speed ${p.speed}x${p.maxGapMs !== null ? `, waits capped at ${fmtMs(p.maxGapMs)}` : ''}`;
  const where = setup.resumed !== null
    ? `the state saved in ${setup.resumed}`
    : setup.workspace === null ? 'none given' : `${tildify(setup.workspace)} ${setup.rev ? `at ${setup.rev}` : 'working tree'} -> ${plan.cwd}`;
  const sb = live?.sb;
  const sandbox = [
    setup.image, `network ${setup.network}`, ...(sb ? [sb.shell, sb.hasTimeout ? 'timeout available' : 'no timeout command'] : []),
    ...(live ? [`container ${live.container}`] : []),
  ].join(', ');
  const lines = [
    `${out.bold('Replay')} ${plan.session} (${plan.agent}), ${plan.calls.length} tool calls in ${batches} batches${subs ? `, ${subs} subagent session${subs > 1 ? 's' : ''}` : ''}`,
    `  executes  ${exec.total}${exec.total ? ': ' + exec.text : ''}`,
    `  skips     ${skip.total}${skip.total ? ': ' + skip.text : ''}`,
    `  workspace ${where}`,
    `  sandbox   ${sandbox}`,
    `  pacing    ${speed}; projected ${fmtMs(projectMs(plan, p, setup.timeoutMs, setup.from))}`,
  ];
  if (setup.resumed !== null) lines.splice(1, 0, `  resumes   before #${setup.from}, with ${left.length} of the calls left`);
  const stops = [...[...breaks.calls].sort((x, y) => x - y).map((n) => `before #${n}`), ...[...breaks.verdicts].map((v) => `after ${v}`)];
  if (stops.length) lines.push(`  breaks    ${stops.join(', ')}`);
  if (live?.missing.length) {
    const list = live.missing.map((m, i) => `${m.name} (${m.calls}${i === 0 ? ` call${m.calls > 1 ? 's' : ''}` : ''})`).join(', ');
    lines.push(out.yellow(`  missing   ${list}: programs the recorded commands start that the image lacks`));
  }
  const rev = revOf(plan);
  if (rev && !setup.rev && setup.resumed === null) lines.push(out.dim(`  note      the session records commit ${rev}; pass --rev ${rev} to start from it`));
  if (plan.calls.some((c) => c.inputSrc === 'index')) lines.push(out.dim('  note      some inputs come from the index because their raw records are unavailable'));
  if (live?.interactive) lines.push(out.dim('  keys      space pause, f skip a wait, q stop; while paused, n step, s shell, o output, w save'));
  return lines.join('\n') + '\n';
}

function planLine(c: PlannedCall, w: number, p: Pacing): string {
  const gap = c.gapUs ? `+${fmtMs(waitMs(c.gapUs, p))}` : '';
  const cls = c.action.cls === 'skip' ? out.dim(`skip: ${c.action.reason}`) : c.action.cls;
  const rec = c.recorded ? `${recStatus(c.recorded)} ${fmtMs(c.recorded.durUs / 1000)}` : 'no result';
  return [pad(String(c.n), w, 'r'), pad(`b${c.batch}`, 5), pad(gap, 9), pad(oneLine(c.tool, 14), 14), pad(cls, 22), pad(oneLine(c.summary, 48), 48), rec].join('  ');
}

function callLine(c: CallOutcome, w: number): string {
  const rec = c.recorded ? `${recStatus(c.recorded)} ${fmtMs(c.recorded.durMs)}` : '-';
  const rep = c.replayed ? `${repStatus(c.replayed)} ${fmtMs(c.replayed.durMs)}` : '-';
  const verdict = paintVerdict(c.verdict, c.verdict === 'skipped' || c.verdict === 'error' ? `${c.verdict}: ${c.reason}` : c.verdict);
  const line = [
    pad(String(c.n), w, 'r'), pad(fmtMs(c.startedMs), 8), pad(oneLine(c.tool, 14), 14), pad(oneLine(c.summary, 40), 40), pad(rec, 16), pad(rep, 16), verdict,
  ].join('  ');
  const indent = ' '.repeat(w + 2);
  if (c.diff) return `${line}\n${indent}${out.dim(`line ${c.diff.line}: recorded ${JSON.stringify(c.diff.recorded)}, replayed ${JSON.stringify(c.diff.replayed)}`)}`;
  if (c.verdict === 'status' && c.replayed?.stderrHead) return `${line}\n${indent}${out.dim(oneLine(c.replayed.stderrHead.trim().split('\n')[0], 120))}`;
  return line;
}

/** Lines of each output that `o` shows. */
const VIEW_LINES = 20;

/** A call's recorded and replayed output, as `o` shows it while the replay is paused. */
function outputView(o: CallOutcome, c: PlannedCall): string {
  const block = (text: string) => {
    const lines = normalize(text);
    if (!lines.length) return '    (no output)';
    const shown = lines.slice(0, VIEW_LINES).map((l) => '    ' + l);
    if (lines.length > VIEW_LINES) shown.push(out.dim(`    … ${lines.length - VIEW_LINES} more lines`));
    return shown.join('\n');
  };
  const rec = c.recorded;
  const recorded = rec?.output == null ? null : rec.cut && rec.outputTail ? `${rec.output}\n…\n${rec.outputTail}` : rec.output;
  const replayed = o.replayed ? [o.replayed.stdoutHead, o.replayed.stderrHead].filter(Boolean).join('\n') : (o.reason ?? '');
  return [
    out.bold(`#${o.n} ${o.tool}  ${oneLine(o.summary, 100)}`),
    `  recorded  ${rec ? recStatus(rec) : 'no result'}`,
    ...(recorded === null ? [] : [block(recorded)]),
    `  replayed  ${o.replayed ? repStatus(o.replayed) : o.verdict}`,
    block(replayed),
  ].join('\n');
}

/** What a stopped replay leaves and the commands that use it. */
/** What a stopped replay leaves and the commands that use it; `next` is null after the last call. */
function stopText(next: number | null, name: string, cwd: string, shell: string): string {
  return [
    '',
    `The container ${name} holds the state ${next === null ? 'after the last call' : `from before #${next}`}:`,
    `  look inside  docker exec -it -w ${shellQuote(cwd)} ${name} ${shell}`,
    ...(next === null ? [`  save a copy  docker commit ${name} NAME`] : [
      `  continue     agentshark replay --resume ${name}`,
      `  save a copy  docker commit ${name} NAME, then agentshark replay --resume NAME as often as you like`,
    ]),
    `  remove       docker rm -f ${name}`,
  ].join('\n');
}

/** Verdicts of calls that were executed. */
const EXECUTED: Verdict[] = ['same', 'output', 'status', 'unrecorded', 'started', 'error'];

function summaryText(s: Summary): string {
  const n = (v: Verdict) => s.counts[v] ?? 0;
  const ran = EXECUTED.reduce((sum, v) => sum + n(v), 0);
  const parts = EXECUTED.filter((v) => n(v)).map((v) => `${n(v)} ${v}`);
  const first = s.firstDivergence !== null ? `; first status divergence at #${s.firstDivergence}` : '';
  const how = s.interrupted ? 'Interrupted' : s.stoppedBefore !== null ? `Stopped before #${s.stoppedBefore}` : s.stoppedAtEnd ? 'Stopped after the last call' : 'Done';
  return ['', `${out.bold(how)}: ${ran} executed${parts.length ? ` (${parts.join(', ')})` : ''}${first}; ${n('skipped')} skipped; wall ${fmtMs(s.wallMs)}`].join('\n');
}

function fmtMs(ms: number): string {
  return fmtDur(ms * 1000) || '0';
}

function recStatus(r: { ok: boolean; exitCode: number | null }): string {
  return r.exitCode !== null ? `exit ${r.exitCode}` : r.ok ? 'ok' : 'error';
}

function repStatus(r: { ok: boolean; exitCode: number | null; timedOut: boolean }): string {
  return r.timedOut ? 'timeout' : recStatus(r);
}

function paintVerdict(v: Verdict, text: string): string {
  switch (v) {
    case 'same':
      return out.green(text);
    case 'output':
      return out.yellow(text);
    case 'status':
      return out.red(text);
    case 'error':
      return out.magenta(text);
    default:
      return out.dim(text);
  }
}
