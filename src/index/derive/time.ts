// Time accounting (SPEC §12.3.9), computed on read from the stored spans, steps and turns. A turn's wall time is split
// by bucket in priority order (TIME_BUCKETS: wait-human > wait-agent > wait-process > api-retry > compaction > hook >
// tool > model): where intervals overlap, the first bucket claims the time. Each bucket reports its logged part (spans
// with a logged duration, Claude's llm.latency_ms) and its derived part (timestamp gaps). Time no bucket claims is
// `unattributed`, never model time: Claude's model time is its logged latency only (an llm span's timestamp gap also
// holds waiting), Codex's the llm span (`derived:ts-gap`). The gap before a turn of a main session is `human-gap` when
// the turn starts with a human prompt, else `continuation` (goal continuations, task notifications, scheduled and peer
// turns, and every turn of a child session, whose prompts come from its parent).

import type { DatabaseSync } from 'node:sqlite';
import { TIME_BUCKETS, type TimeBreakdown, type TimeBucket, type TimeBucketName } from '../../model/types.ts';
import { QUESTION_TOOLS } from './interventions.ts';

/** Waits on a child agent or workflow. */
export const WAIT_AGENT_TOOLS = new Set(['wait', 'wait_agent', 'Agent', 'Task', 'Workflow']);
/** Waits on a running process: polls (an empty `write_stdin`), sleeps, task output and monitors. */
export const WAIT_PROCESS_TOOLS = new Set(['write_stdin', 'sleep', 'BashOutput', 'TaskOutput', 'Monitor']);
const SLEEP = /^\s*sleep\s+\d/;
const BUCKET = new Map<TimeBucketName, number>(TIME_BUCKETS.map((b, i) => [b, i]));

/** A span or model interval, µs, with the bucket it belongs to. */
export interface TimeInterval {
  start: number;
  end: number;
  bucket: TimeBucketName;
  logged: boolean;
  /** The span id, or the step id of a model interval. */
  ref?: string;
}

export interface TurnWindow {
  turnId: string;
  start: number;
  /** The turn's end; its newest own event while it is open. */
  end: number;
  /** The turn starts with a human prompt (its gap before is human-gap). */
  human: boolean;
}

/** Split [start, end) among overlapping intervals by bucket priority; the rest is unattributed. */
export function splitWindow(start: number, end: number, intervals: TimeInterval[]): { buckets: TimeBucket[]; unattributedUs: number } {
  const us = new Array<number>(TIME_BUCKETS.length).fill(0);
  const logged = new Array<number>(TIME_BUCKETS.length).fill(0);
  const points: [number, number, number][] = [];
  for (const iv of intervals) {
    const a = Math.max(start, iv.start);
    const b = Math.min(end, iv.end);
    if (b <= a) continue;
    const k = BUCKET.get(iv.bucket)! * 2 + (iv.logged ? 1 : 0);
    points.push([a, 1, k], [b, -1, k]);
  }
  points.sort((x, y) => x[0] - y[0]);
  const active = new Array<number>(TIME_BUCKETS.length * 2).fill(0);
  let prev = start;
  for (const [t, delta, k] of points) {
    if (t > prev) {
      for (let b = 0; b < TIME_BUCKETS.length; b++) {
        if (!active[2 * b] && !active[2 * b + 1]) continue;
        us[b] += t - prev;
        if (active[2 * b + 1]) logged[b] += t - prev;
        break;
      }
      prev = t;
    }
    active[k] += delta;
  }
  const buckets = TIME_BUCKETS.map((name, b) => ({ name, us: us[b], loggedUs: logged[b], derivedUs: us[b] - logged[b] }));
  return { buckets, unattributedUs: Math.max(0, end - start - us.reduce((x, y) => x + y, 0)) };
}

/** Per-turn breakdowns of a session's turns (in start order); the gap before the first turn is null. */
function turnBreakdowns(turns: TurnWindow[], intervals: TimeInterval[]): Map<string, TimeBreakdown> {
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  const own = sorted.map(() => [] as TimeInterval[]);
  for (const iv of intervals) {
    // Turn windows do not overlap: the turns an interval touches end at or after its start.
    let i = lastStartingBefore(sorted, iv.end);
    for (; i >= 0 && sorted[i].end > iv.start; i--) own[i].push(iv);
  }
  const out = new Map<string, TimeBreakdown>();
  sorted.forEach((t, i) => {
    const end = Math.max(t.start, t.end);
    const { buckets, unattributedUs } = splitWindow(t.start, end, own[i]);
    const gap = i ? Math.max(0, t.start - Math.max(sorted[i - 1].start, sorted[i - 1].end)) : null;
    out.set(t.turnId, {
      wallUs: end - t.start, buckets, unattributedUs, humanGapUs: gap === null ? null : t.human ? gap : 0, continuationUs: gap === null ? null : t.human ? 0 : gap,
    });
  });
  return out;
}

/** The sum of a session's turn breakdowns; gaps are null for a single turn. */
export function sumBreakdowns(parts: TimeBreakdown[]): TimeBreakdown | null {
  if (!parts.length) return null;
  const buckets = TIME_BUCKETS.map((name) => ({ name, us: 0, loggedUs: 0, derivedUs: 0 }));
  let wall = 0;
  let unattributed = 0;
  let human: number | null = null;
  let cont: number | null = null;
  for (const p of parts) {
    wall += p.wallUs ?? 0;
    unattributed += p.unattributedUs ?? 0;
    p.buckets.forEach((b, i) => {
      buckets[i].us += b.us;
      buckets[i].loggedUs += b.loggedUs;
      buckets[i].derivedUs += b.derivedUs;
    });
    if (p.humanGapUs !== null) human = (human ?? 0) + p.humanGapUs;
    if (p.continuationUs !== null) cont = (cont ?? 0) + p.continuationUs;
  }
  return { wallUs: wall, buckets, unattributedUs: unattributed, humanGapUs: human, continuationUs: cont };
}

/** Every turn of a session, from the index (read-only connections may call it). */
export function sessionTurnTimes(db: DatabaseSync, sessionId: string): Map<string, TimeBreakdown> {
  const s = sessionIntervals(db, sessionId);
  return s && s.turns.length ? turnBreakdowns(s.turns, s.intervals) : new Map();
}

/** A session's turn windows and the timed intervals that its turn breakdowns split (AgentPerf reads them too). */
export function sessionIntervals(db: DatabaseSync, sessionId: string): { agent: string; turns: TurnWindow[]; intervals: TimeInterval[] } | null {
  const s = db.prepare('SELECT agent, role FROM sessions WHERE id = ?').get(sessionId) as { agent: string; role: string } | undefined;
  if (!s) return null;
  const turns = (db.prepare(`SELECT t.turn_id, t.start_ts, t.end_ts, t.last_ts, t.origin,
      EXISTS (SELECT 1 FROM events e WHERE e.turn_id = t.turn_id AND e.kind = 'user.prompt' AND (e.flag_bits & 6) = 0) AS prompted
    FROM turn_rollup t WHERE t.session_id = ?`).all(sessionId) as Record<string, any>[])
    .map((t): TurnWindow => ({
      turnId: t.turn_id, start: t.start_ts, end: t.end_ts ?? t.last_ts, human: s.role === 'main' && !!t.prompted && (t.origin === null || t.origin === 'human'),
    }));
  const intervals: TimeInterval[] = [];
  for (const r of db.prepare(`SELECT id, kind, name, start_ts, end_ts, dur_src, json_extract(attrs, '$.tool.input.chars') AS chars,
      coalesce(json_extract(attrs, '$.tool.command'), json_extract(attrs, '$.tool.input.command'), json_extract(attrs, '$.tool.input.cmd')) AS cmd
    FROM spans WHERE session_id = ? AND inherited = 0 AND kind IN ('tool', 'exec', 'hook', 'retry', 'compaction', 'permission', 'workflow', 'phase')
      AND start_ts IS NOT NULL AND end_ts IS NOT NULL`).iterate(sessionId) as Iterable<Record<string, any>>) {
    intervals.push({ start: r.start_ts, end: r.end_ts, bucket: spanBucket(r), logged: logged(r.dur_src), ref: r.id });
  }
  // Model time per step: Claude's logged latency, ending at its llm span's end; Codex's llm span.
  for (const r of db.prepare(`SELECT st.id, st.model_us, st.model_src, sp.start_ts, sp.end_ts, sp.dur_src FROM steps st JOIN spans sp ON sp.id = st.llm_span_id
    WHERE st.session_id = ? AND sp.start_ts IS NOT NULL AND sp.end_ts IS NOT NULL`).iterate(sessionId) as Iterable<Record<string, any>>) {
    if (r.model_us !== null && logged(r.model_src)) intervals.push({ start: Math.max(r.start_ts, r.end_ts - r.model_us), end: r.end_ts, bucket: 'model', logged: true, ref: r.id });
    else if (s.agent === 'codex') intervals.push({ start: r.start_ts, end: r.end_ts, bucket: 'model', logged: logged(r.dur_src), ref: r.id });
  }
  return { agent: s.agent, turns, intervals };
}

export function sessionTime(db: DatabaseSync, sessionId: string): TimeBreakdown | null {
  return sumBreakdowns([...sessionTurnTimes(db, sessionId).values()]);
}

export function turnTime(db: DatabaseSync, turnId: string): TimeBreakdown | null {
  const t = db.prepare('SELECT session_id FROM turn_rollup WHERE turn_id = ?').get(turnId) as { session_id: string } | undefined;
  return t ? sessionTurnTimes(db, t.session_id).get(turnId) ?? null : null;
}

export function spanBucket(r: Record<string, any>): TimeBucketName {
  switch (r.kind) {
    case 'llm':
      return 'model';
    case 'permission':
      return 'wait-human';
    case 'workflow':
    case 'phase':
      return 'wait-agent';
    case 'retry':
      return 'api-retry';
    case 'compaction':
      return 'compaction';
    case 'hook':
      return 'hook';
  }
  const name = r.name ?? '';
  if (QUESTION_TOOLS.has(name)) return 'wait-human';
  if (WAIT_AGENT_TOOLS.has(name)) return 'wait-agent';
  // A write_stdin with keystrokes is input, not a wait.
  if ((WAIT_PROCESS_TOOLS.has(name) && !(name === 'write_stdin' && r.chars)) || (typeof r.cmd === 'string' && SLEEP.test(r.cmd))) return 'wait-process';
  return 'tool';
}

function logged(src: string | null): boolean {
  return typeof src === 'string' && src.startsWith('logged');
}

function lastStartingBefore(turns: TurnWindow[], t: number): number {
  let lo = 0;
  let hi = turns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid].start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
