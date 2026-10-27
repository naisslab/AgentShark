// Keyboard controls and a status line for a replay on a terminal (docs/REPLAY.md §5.1). Keys pause, step and stop the
// run loop and skip recorded waits; while it is paused they also open a shell in the container, show the last call's
// output and save the state. The status line on stderr says what the replay is doing.

import { emitKeypressEvents } from 'node:readline';
import type { PlannedCall } from '../replay/plan.ts';
import type { Control, PauseReason, Resume } from '../replay/run.ts';
import { err, fmtDur, out, width, write } from './util.ts';

/** What the keys do beyond driving the loop, supplied by the command. */
export interface PausedActions {
  /** Open a shell in the container and return when it exits. */
  shell(): void;
  /** The last executed call's recorded and replayed output. */
  output(): string;
  /** Save the state before `next`; returns the message for the user. */
  save(next: PlannedCall): Promise<string>;
  /** Ctrl-C: end the replay. It aborts the signal the control was made with. */
  abort(): void;
  /** A second Ctrl-C: leave at once. */
  exit(): void;
}

interface Key {
  name?: string;
  ctrl?: boolean;
}

type State =
  | { kind: 'idle' }
  | { kind: 'running'; batch: PlannedCall[]; since: number }
  | { kind: 'waiting'; next: PlannedCall; until: number; done: () => void }
  | { kind: 'paused'; next: PlannedCall | null; why: PauseReason; resolve: (r: Resume) => void };

/**
 * One status line: parts shown in order, each with a rank (0 is always shown), its keys from the longest wording to
 * the shortest, and a last resort that only names the keys.
 */
interface Line {
  parts: [text: string, rank: number][];
  keys: string[];
  tiny?: string;
}

const RUN_KEYS = { keys: ['space pause · f skip waits · q stop', 'space pause · f skip · q stop'], tiny: 'keys: space f q' };
const PAUSE_KEYS = {
  keys: ['space continue · n step · o output · s shell · w save · q stop', 'space go · n step · o out · s shell · w save · q stop'],
  tiny: 'keys: space n o s w q',
};
const END_KEYS = { keys: ['space finish · o output · s shell · q keep the container', 'space finish · o out · s shell · q keep'], tiny: 'keys: space o s q' };

export class TerminalControl implements Control {
  private state: State = { kind: 'idle' };
  private request: 'pause' | 'stop' | null = null;
  /** Holds of skipped calls in the running batch; `f`, space and `q` end them. */
  private readonly holds = new Set<() => void>();
  /** A save is in progress, and Ctrl-C asked to abort once it ends. */
  private busy = false;
  private abortAfterSave = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private readonly actions: PausedActions;
  private readonly signal: AbortSignal;
  private readonly onKey = (_s: string | undefined, key: Key | undefined) => void this.key(key ?? {});

  /** `signal` is the replay's: when it aborts, a pause stops and every wait ends. */
  constructor(actions: PausedActions, signal: AbortSignal) {
    this.actions = actions;
    this.signal = signal;
    signal.addEventListener('abort', () => {
      const s = this.state;
      if (s.kind === 'paused') s.resolve('stop');
      if (s.kind === 'waiting') s.done();
      this.endHolds();
      this.draw();
    }, { once: true });
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', this.onKey);
    process.stdin.resume();
    this.timer = setInterval(() => this.draw(), 250).unref();
  }

  /** Gives the terminal back. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.clear();
    this.closed = true;
    clearInterval(this.timer);
    process.stdin.off('keypress', this.onKey);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  /** Writes `text` to stdout above the status line. */
  async print(text: string): Promise<void> {
    // The run loop reports a batch's calls once all of them have finished.
    if (this.state.kind === 'running') this.state = { kind: 'idle' };
    this.clear();
    await write(text);
    this.draw();
  }

  async pause(next: PlannedCall | null, why: PauseReason): Promise<Resume> {
    // A breakpoint says once, above the status line, where it stopped and why.
    if (why.kind === 'call' || why.kind === 'verdict') {
      await this.print(out.yellow(`⏸ Paused ${next ? `before #${next.n}` : 'after the last call'}: ${reasonText(why)}`) + '\n');
    }
    if (this.signal.aborted) return 'stop';
    return new Promise((resolve) => {
      this.state = { kind: 'paused', next, why, resolve };
      this.draw();
    });
  }

  wait(ms: number, call: PlannedCall, kind: 'gap' | 'hold'): Promise<void> {
    if (ms <= 0 || this.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.holds.delete(done);
        if (this.state.kind === 'waiting' && this.state.done === done) this.state = { kind: 'idle' };
        resolve();
      };
      const timer = setTimeout(done, ms);
      if (kind === 'hold') this.holds.add(done);
      else this.state = { kind: 'waiting', next: call, until: performance.now() + ms, done };
      this.draw();
    });
  }

  takeRequest(): 'pause' | 'stop' | null {
    const r = this.request;
    this.request = null;
    return r;
  }

  running(batch: PlannedCall[]): void {
    this.state = { kind: 'running', batch, since: performance.now() };
    this.draw();
  }

  private async key(k: Key): Promise<void> {
    if (k.ctrl && k.name === 'c') {
      // A second Ctrl-C leaves at once, as a second SIGINT would: nothing else ends a call that is running.
      if (this.signal.aborted || this.abortAfterSave) return this.actions.exit();
      // A save in progress finishes first, so that its image is complete.
      if (this.busy) this.abortAfterSave = true;
      else this.actions.abort();
      return this.draw();
    }
    const s = this.state;
    if (this.signal.aborted || this.busy) return;
    if (s.kind !== 'paused') {
      if (k.name === 'f' || k.name === 'space' || k.name === 'q') {
        if (s.kind === 'waiting') s.done();
        this.endHolds();
      }
      if (k.name === 'space' || k.name === 'q') {
        this.request = k.name === 'q' ? 'stop' : (this.request ?? 'pause');
        this.draw();
      }
      return;
    }
    // After the last call, stepping and continuing both finish the replay.
    const step = s.next === null ? 'continue' : 'step';
    const resume = ({ space: 'continue', c: 'continue', return: 'continue', n: step, q: 'stop' } as const)[k.name as string];
    if (resume) {
      this.state = { kind: 'idle' };
      this.clear();
      s.resolve(resume);
    } else if (k.name === 's') this.suspend(() => this.actions.shell());
    else if (k.name === 'o') await this.print(this.actions.output() + '\n');
    else if (k.name === 'w' && s.next !== null) {
      this.busy = true;
      this.draw();
      try {
        await this.print((await this.actions.save(s.next).catch((e: Error) => `Cannot save the state: ${e.message}`)) + '\n');
      } finally {
        this.busy = false;
        if (this.abortAfterSave) this.actions.abort();
        this.draw();
      }
    }
  }

  private endHolds(): void {
    for (const done of [...this.holds]) done();
  }

  /** Runs `fn` with the terminal in its normal mode, for a program that takes it over. */
  private suspend(fn: () => void): void {
    this.clear();
    process.stdin.setRawMode(false);
    process.stdin.pause();
    try {
      fn();
    } finally {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      this.draw();
    }
  }

  private line(): Line | null {
    const s = this.state;
    const now = performance.now();
    const run = err.green('▶');
    switch (s.kind) {
      case 'running': {
        const first = s.batch[0];
        const a = first.action;
        const recorded = Math.max(...s.batch.map((c) => (c.recorded?.durUs ?? 0) / 1000));
        const what = s.batch.length > 1 ? `#${first.n}-${s.batch.at(-1)!.n}` : `#${first.n}`;
        const detail = s.batch.length > 1 ? `${s.batch.length} calls`
          : `${first.tool}${a.cls === 'skip' ? ` (skipped: ${a.reason}, holds its recorded time)` : ''}`;
        if (this.signal.aborted) return { parts: [[`${err.red('■')} aborting: ${what} is still running`, 0]], keys: ['Ctrl-C again exits now'] };
        const parts: Line['parts'] = [[`${run} ${what}`, 0], [`${clock(now - s.since)} of ${fmtDur(recorded * 1000) || '0'} recorded`, 1], [detail, 2]];
        if (this.request) return { parts, keys: [`${this.request === 'stop' ? 'stopping' : 'pausing'} after this batch · Ctrl-C aborts`] };
        return { parts, ...RUN_KEYS };
      }
      case 'waiting':
        return { parts: [[`${run} ${clock(s.until - now)} before #${s.next.n}`, 0], [s.next.tool, 2], ['(recorded gap)', 1]], ...RUN_KEYS };
      case 'paused': {
        const pause = err.yellow('⏸');
        if (this.busy) {
          return {
            parts: [[`${pause} saving the state before #${s.next!.n}…`, 0]],
            keys: [this.abortAfterSave ? 'aborting after the save · Ctrl-C again exits now' : 'Ctrl-C aborts once the save ends'],
          };
        }
        if (s.next === null) return { parts: [[`${pause} after the last call`, 0], [`(${reasonText(s.why)})`, 1]], ...END_KEYS };
        return { parts: [[`${pause} before #${s.next.n}`, 0], [s.next.tool, 2], [`(${reasonText(s.why)})`, 1]], ...PAUSE_KEYS };
      }
      default:
        return null;
    }
  }

  private draw(): void {
    const line = this.closed ? null : this.line();
    if (line === null) return;
    process.stderr.write('\r\x1b[2K' + fit(line, (process.stderr.columns || 80) - 1));
  }

  private clear(): void {
    if (!this.closed) process.stderr.write('\r\x1b[2K');
  }
}

/**
 * The line within `room` columns, so that it never wraps and a carriage return can redraw it. The keys take a shorter
 * wording before a detail goes, the least important detail first; then the keys are only named, and only then is the
 * line cut.
 */
export function fit(line: Line, room: number): string {
  const ranks = [...new Set(line.parts.map(([, r]) => r))].sort((x, y) => y - x);
  const join = (max: number, keys: string) => `${line.parts.filter(([, r]) => r <= max).map(([t]) => t).join(' ')}   ${keys}`;
  for (const max of ranks) {
    for (const keys of line.keys) if (width(join(max, keys)) <= room) return join(max, keys);
  }
  const text = join(0, line.tiny ?? line.keys.at(-1)!);
  const over = width(text) - room;
  return over > 0 ? text.slice(0, text.length - over - 1) + '…' : text;
}

function reasonText(why: PauseReason): string {
  switch (why.kind) {
    case 'call':
      return 'breakpoint';
    case 'verdict':
      return `#${why.n} got ${why.verdict}`;
    case 'step':
      return 'step';
    case 'request':
      return 'paused';
  }
}

/** A clock that counts in tenths of a second, so that it does not flicker. */
function clock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : fmtDur(Math.round(s) * 1e6);
}
