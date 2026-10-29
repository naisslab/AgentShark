// Verdicts (docs/REPLAY.md §6): compare one replayed call with its recording. Pure functions.

import { stripVTControlCharacters } from 'node:util';
import type { CallClass, RecordedResult } from './plan.ts';

export const VERDICTS = ['same', 'output', 'status', 'unrecorded', 'started', 'skipped', 'error'] as const;
export type Verdict = (typeof VERDICTS)[number];

interface Status {
  ok: boolean;
  exitCode: number | null;
}

export interface OutputDiff {
  /** 1-based line of the normalized output where the two first differ. */
  line: number;
  recorded: string;
  replayed: string;
}

const LINE_MAX = 200;
const END = '<end of output>';

export function statusMatches(rec: Status, rep: Status): boolean {
  if (rec.exitCode !== null && rep.exitCode !== null) return rec.exitCode === rep.exitCode;
  return rec.ok === rep.ok;
}

/** `complete` is false when the replayed output was longer than the replayer keeps. */
export function verdictOf(cls: CallClass, rec: RecordedResult | null, rep: Status, output: string, complete = true): { verdict: Verdict; diff?: OutputDiff } {
  if (!rec) return { verdict: 'unrecorded' };
  if (!statusMatches(rec, rep)) return { verdict: 'status' };
  if (cls !== 'shell' || rec.output === null) return { verdict: 'same' };
  const diff = compareOutput(rec, output, complete);
  return diff ? { verdict: 'output', diff } : { verdict: 'same' };
}

export function normalize(s: string): string[] {
  const lines = stripVTControlCharacters(s).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * The first difference between the recorded and replayed outputs, or null when they agree. A side that kept only a
 * head (and, for the recording, a tail) is compared on what it kept, ignoring the line each cut splits.
 */
export function compareOutput(rec: RecordedResult, replayed: string, complete = true): OutputDiff | null {
  const rep = normalize(replayed);
  if (!complete) rep.pop();
  const head = normalize(rec.output ?? '');
  if (rec.cut) head.pop();
  const diff = firstDiff(complete ? head : head.slice(0, rep.length), rep, 0);
  if (diff || !complete) return diff;
  if (!rec.cut) return head.length === rep.length ? null : lengthDiff(head, rep);
  if (rec.outputTail === null) return null;
  const tail = normalize(rec.outputTail).slice(1);
  const offset = rep.length - tail.length;
  if (offset < 0) return lengthDiff(tail, rep);
  return firstDiff(tail, rep.slice(offset), offset);
}

/** First differing line among the recorded lines. */
function firstDiff(rec: string[], rep: string[], offset: number): OutputDiff | null {
  for (let i = 0; i < rec.length; i++) {
    if (rec[i] !== rep[i]) return { line: offset + i + 1, recorded: cut(rec[i]), replayed: cut(rep[i] ?? END) };
  }
  return null;
}

function lengthDiff(rec: string[], rep: string[]): OutputDiff {
  const i = Math.min(rec.length, rep.length);
  return { line: i + 1, recorded: cut(rec[i] ?? END), replayed: cut(rep[i] ?? END) };
}

function cut(s: string): string {
  return s.length > LINE_MAX ? s.slice(0, LINE_MAX) + '…' : s;
}
