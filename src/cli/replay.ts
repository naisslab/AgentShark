// `agentshark replay` (docs/REPLAY.md): plan a session's tool calls from the index, run them in a Docker container
// at the recorded or a scaled pace, and report how each result compares with the recording.

import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { oneLine } from '../adapters/adapter.ts';
import type { Verdict } from '../replay/compare.ts';
import { DockerError, DockerExecutor } from '../replay/executor.ts';
import { PlanError, planReplay, type PlannedCall, type ReplayPlan, resolveSession, revOf } from '../replay/plan.ts';
import { type CallOutcome, DEFAULT_TIMEOUT_MS, type Pacing, projectMs, runReplay, type Summary, waitMs } from '../replay/run.ts';
import { openSandbox, type Sandbox } from '../replay/tools.ts';
import { openQueries } from './inspect.ts';
import { openCaptureIndex } from './serve.ts';
import { type Args, CliError, err, fmtDur, out, pad, parseDuration, string, strings, tildify, write } from './util.ts';

const DEFAULT_IMAGE = 'node:24-bookworm';
/** Exit code when at least one executed call's status differs from the recording. */
const EXIT_DIVERGED = 3;

export async function replay(a: Args): Promise<number> {
  const ref = a.positionals[0];
  if (!ref) throw new CliError('replay needs a session id: agentshark replay SESSION --workspace DIR', 2);
  const dry = a.values['dry-run'] === true;
  const workspaceArg = string(a.values.workspace);
  if (!dry && !workspaceArg) throw new CliError('replay needs --workspace DIR: the folder the session started from (or --dry-run)', 2);
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
  const image = string(a.values.image) ?? DEFAULT_IMAGE;
  const network = string(a.values.network) ?? 'none';
  const env = parseEnv(strings(a.values.env));
  const json = a.values.json === true;
  const outPath = string(a.values.output);

  const plan = await withIndex(a, async (db, mode) => {
    try {
      return await planReplay(db, mode, resolveSession(db, ref));
    } catch (e) {
      if (e instanceof PlanError) throw new CliError(e.message);
      throw e;
    }
  });

  const file = outPath === undefined ? null : createWriteStream(outPath);
  const emit = async (o: object) => {
    const line = JSON.stringify(o) + '\n';
    if (json) await write(line);
    if (file) await new Promise<void>((r) => (file.write(line) ? r() : file.once('drain', r)));
  };
  const setup = { workspace: workspace ?? null, rev: rev ?? null, image, network, timeoutMs };
  try {
    await emit(planRecord(plan, setup, pacing));
    if (dry) {
      if (!json) {
        await write(header(plan, setup, pacing, null) + '\n');
        const w = String(plan.calls.length).length;
        for (const c of plan.calls) await write(planLine(c, w, pacing) + '\n');
      }
      return 0;
    }
    const summary = await replayInDocker(plan, { ...setup, workspace: workspace! }, pacing, { env, keep: a.values.keep === true, json }, emit);
    await emit(summary);
    if (!json) await write(summaryText(summary) + '\n');
    return summary.firstDivergence !== null ? EXIT_DIVERGED : 0;
  } finally {
    if (file) await closeStream(file);
  }
}

interface Setup {
  workspace: string | null;
  rev: string | null;
  image: string;
  network: string;
  /** `--timeout`: the longest one call may run, ms. */
  timeoutMs: number;
}

async function replayInDocker(
  plan: ReplayPlan, setup: Setup & { workspace: string }, pacing: Pacing,
  o: { env: Record<string, string>; keep: boolean; json: boolean }, emit: (o: object) => Promise<void>,
): Promise<Summary> {
  const env = { ...(plan.home ? { HOME: plan.home } : {}), ...o.env };
  if (!o.json) console.error(err.dim(`Starting ${setup.image} (docker pulls it when missing)...`));
  let ex: DockerExecutor;
  try {
    ex = await DockerExecutor.create({ image: setup.image, network: setup.network, env, label: plan.session });
  } catch (e) {
    if (e instanceof DockerError) throw new CliError(e.message);
    throw e;
  }
  const abort = new AbortController();
  const onSignal = () => {
    abort.abort();
    if (!o.keep) void ex.close();
  };
  process.once('SIGINT', onSignal);
  try {
    await copyWorkspace(ex, setup.workspace, setup.rev, plan.cwd);
    const sb = await openSandbox(ex, setup.timeoutMs);
    if (!o.json) await write(header(plan, setup, pacing, sb) + '\n');
    const w = String(plan.calls.length).length;
    return await runReplay(plan, sb, pacing, async (c) => {
      await emit(c);
      if (!o.json) await write(callLine(c, w) + '\n');
    }, abort.signal);
  } catch (e) {
    if (e instanceof DockerError) throw new CliError(abort.signal.aborted ? 'replay interrupted' : e.message);
    throw e;
  } finally {
    process.off('SIGINT', onSignal);
    if (o.keep) console.error(`Container kept: docker exec -it ${ex.name} sh   (remove it with: docker rm -f ${ex.name})`);
    else await ex.close();
  }
}

/** The plan's index: the live one, or the one `open` builds from a capture file. Closed after `fn`. */
async function withIndex<T>(a: Args, fn: (db: DatabaseSync, mode: 'live' | 'capture') => Promise<T>): Promise<T> {
  const capture = string(a.values.capture);
  const db = capture === undefined ? openQueries(a).db : (await openCaptureIndex(capture)).db;
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

function closeStream(s: WriteStream): Promise<void> {
  return new Promise((r) => s.end(r));
}

// ---------------------------------------------------------------------------
// Output

function planRecord(plan: ReplayPlan, setup: Setup, p: Pacing) {
  return {
    type: 'plan', session: plan.session, agent: plan.agent, cwd: plan.cwd, sessions: plan.sessions, ...setup,
    speed: p.speed, maxGapMs: p.maxGapMs, projectedMs: Math.round(projectMs(plan, p, setup.timeoutMs)),
    calls: plan.calls.map((c) => ({
      n: c.n, event: c.event, session: c.session, batch: c.batch, tool: c.tool, class: c.action.cls,
      ...(c.action.cls === 'skip' && { reason: c.action.reason }),
      inputSrc: c.inputSrc, gapMs: Math.round(waitMs(c.gapUs, p)), holdMs: Math.round(waitMs(c.holdUs, p)),
    })),
  };
}

function header(plan: ReplayPlan, setup: Setup, p: Pacing, sb: Sandbox | null): string {
  const tally = (pick: (c: PlannedCall) => string | null) => {
    const m = new Map<string, number>();
    for (const c of plan.calls) {
      const k = pick(c);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    const total = [...m.values()].reduce((x, y) => x + y, 0);
    return { total, text: [...m].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k}`).join(', ') };
  };
  const run = tally((c) => (c.action.cls === 'skip' ? null : c.action.cls));
  const skip = tally((c) => (c.action.cls === 'skip' ? c.action.reason : null));
  const batches = new Set(plan.calls.map((c) => c.batch)).size;
  const subs = plan.sessions.length - 1;
  const speed = p.speed === 'max' ? 'no waits' : `speed ${p.speed}x${p.maxGapMs !== null ? `, waits capped at ${fmtMs(p.maxGapMs)}` : ''}`;
  const where = setup.workspace === null
    ? 'none given'
    : `${tildify(setup.workspace)} ${setup.rev ? `at ${setup.rev}` : 'working tree'} -> ${plan.cwd}`;
  const sandbox = [setup.image, `network ${setup.network}`, ...(sb ? [sb.shell, sb.hasTimeout ? 'timeout available' : 'no timeout command'] : [])].join(', ');
  const lines = [
    `${out.bold('Replay')} ${plan.session} (${plan.agent}), ${plan.calls.length} tool calls in ${batches} batches${subs ? `, ${subs} subagent session${subs > 1 ? 's' : ''}` : ''}`,
    `  executes  ${run.total}${run.total ? ': ' + run.text : ''}`,
    `  skips     ${skip.total}${skip.total ? ': ' + skip.text : ''}`,
    `  workspace ${where}`,
    `  sandbox   ${sandbox}`,
    `  pacing    ${speed}; projected ${fmtMs(projectMs(plan, p, setup.timeoutMs))}`,
  ];
  const rev = revOf(plan);
  if (rev && !setup.rev) lines.push(out.dim(`  note      the session records commit ${rev}; pass --rev ${rev} to start from it`));
  if (plan.calls.some((c) => c.inputSrc === 'index')) lines.push(out.dim('  note      some inputs come from the index because their raw records are unavailable'));
  return lines.join('\n') + '\n';
}

function planLine(c: PlannedCall, w: number, p: Pacing): string {
  const gap = c.gapUs ? `+${fmtMs(waitMs(c.gapUs, p))}` : '';
  const cls = c.action.cls === 'skip' ? out.dim(`skip: ${c.action.reason}`) : c.action.cls;
  const rec = c.recorded ? `${recStatus(c.recorded)} ${fmtMs(c.recorded.durUs / 1000)}` : 'no result';
  return [pad(String(c.n), w, 'r'), pad(`b${c.batch}`, 5), pad(gap, 9), pad(c.tool, 14), pad(cls, 22), pad(oneLine(c.summary, 48), 48), rec].join('  ');
}

function callLine(c: CallOutcome, w: number): string {
  const rec = c.recorded ? `${recStatus(c.recorded)} ${fmtMs(c.recorded.durMs)}` : '-';
  const rep = c.replayed ? `${repStatus(c.replayed)} ${fmtMs(c.replayed.durMs)}` : '-';
  const verdict = paintVerdict(c.verdict, c.verdict === 'skipped' || c.verdict === 'error' ? `${c.verdict}: ${c.reason}` : c.verdict);
  const line = [
    pad(String(c.n), w, 'r'), pad(fmtMs(c.startedMs), 8), pad(c.tool, 14), pad(oneLine(c.summary, 40), 40), pad(rec, 16), pad(rep, 16), verdict,
  ].join('  ');
  const indent = ' '.repeat(w + 2);
  if (c.diff) return `${line}\n${indent}${out.dim(`line ${c.diff.line}: recorded ${JSON.stringify(c.diff.recorded)}, replayed ${JSON.stringify(c.diff.replayed)}`)}`;
  if (c.verdict === 'status' && c.replayed?.stderrHead) return `${line}\n${indent}${out.dim(oneLine(c.replayed.stderrHead.trim().split('\n')[0], 120))}`;
  return line;
}

/** Verdicts of calls that were executed. */
const EXECUTED: Verdict[] = ['same', 'output', 'status', 'unrecorded', 'started', 'error'];

function summaryText(s: Summary): string {
  const n = (v: Verdict) => s.counts[v] ?? 0;
  const ran = EXECUTED.reduce((sum, v) => sum + n(v), 0);
  const parts = EXECUTED.filter((v) => n(v)).map((v) => `${n(v)} ${v}`);
  const first = s.firstDivergence !== null ? `; first status divergence at #${s.firstDivergence}` : '';
  return [
    '',
    `${out.bold(s.interrupted ? 'Interrupted' : 'Done')}: ${ran} executed${parts.length ? ` (${parts.join(', ')})` : ''}${first}; ${n('skipped')} skipped; wall ${fmtMs(s.wallMs)}`,
  ].join('\n');
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
