// In-memory state of one tree's derivation. Each derive/<concept>.ts reads the tree and the concepts derived before
// it, and adds its rows here; derive/write.ts stores them.

import {
  ALARM_THRESHOLDS, type AlarmRow, type AlarmThresholds, type ChangeRow, type ClaimRow, type DelegationRow, type EpisodeAttemptRow, type EpisodeRow,
  type FailureClass, type FailureFamily, type FailureRow, type FailureTier, type InterventionRow, type ProcessEventRow, type ProcessRow, type SessionRollupRow,
  type StepEventRow, type StepRow, type TokenUsage, type TurnRollupRow,
} from '../../model/types.ts';
import type { Ev, Span, TreeInput } from './tree.ts';

/** What happened to one call (or one api error, hook run or model response) for the failure and episode rules. */
export interface Action {
  kind: 'tool' | 'item' | 'api' | 'hook' | 'usage';
  /** The call event: tool.call, or the event itself for items, api errors, hooks and usage. */
  call: Ev | null;
  /** The evidence event: tool.result, tool.exec item, llm.error/refusal, hook.run, llm.usage; null while no result exists. */
  result: Ev | null;
  /** Codex code-mode `exec` call of an item. */
  parent: Action | null;
  tool: string | null;
  key: string;
  turn: string | null;
  /** seq and ts of the evidence (the result when there is one). */
  seq: number;
  ts: number;
  step: StepRef | null;
  /** fail: a failure or suspect row; ok: a result that closes episodes of its key; neutral: neither. */
  status: 'fail' | 'ok' | 'neutral';
  failure: FailureRow | null;
  /** Normalized input for transitions (command text or JSON), ≤ 400 characters. */
  input: string;
  /** Process id this call opened (a still-running result). */
  opens: string | null;
  /** Process id a poll, input or stop names (write_stdin, BashOutput, TaskOutput, KillShell, TaskStop). */
  procId: string | null;
}

export interface StepRef {
  id: string;
  n: number;
}

export interface TurnInfo {
  id: string;
  span: Span | null;
  firstSeq: number;
  lastSeq: number;
  startTs: number;
  lastTs: number;
  open: boolean;
  /** turn.abort events, by seq. */
  abortSeqs: number[];
  interrupted: boolean;
  /** Human prompts (user.prompt) in the turn. */
  prompts: number;
  unattended: boolean;
}

/** `call_stats` (schema.sql): one session's calls of one group key, for Statistics ▸ Tools and Endpoints. */
export interface CallStatRow {
  sessionId: string;
  kind: 'tool' | 'server' | 'program' | 'host' | 'agent' | 'model' | 'hook';
  key: string;
  calls: number;
  /** Known durations (µs), ascending. */
  durs: number[];
  /** Calls per duration source; 'unknown' for calls without a known duration. */
  durSrc: Record<string, number>;
  /** Calls per tier of their worst failure row. */
  tiers: Partial<Record<FailureTier, number>>;
  firstTs: number | null;
  lastTs: number | null;
}

/** `call_keys` (schema.sql): the group key of one keyed call, by its span. */
export interface CallKeyRow {
  spanId: string;
  sessionId: string;
  kind: 'server' | 'program' | 'host' | 'agent';
  key: string;
}

/** `session_stats` (schema.sql): one session's events of one kind and proto, or llm spans of one model. */
export interface SessionStatRow {
  sessionId: string;
  kind: 'event' | 'model';
  key: string;
  n: number;
  bytes: number | null;
  /** model: known span durations (µs), ascending. */
  durs: number[] | null;
  tokens: TokenUsage | null;
}

export interface SigInfo {
  text: string;
  family: FailureFamily;
  class: FailureClass;
}

/** An episode's actions, for the rules after episodes.ts (alarms, interventions). */
export interface EpisodeRun {
  attempts: Action[];
  closer: Action | null;
  /** Index in `attempts` of the attempt that set `loop` (`blind`), or null. */
  loopAt: number | null;
  blindAt: number | null;
}

export interface Derived {
  tree: TreeInput;
  /** meta.alarm_thresholds over ALARM_THRESHOLDS. */
  thresholds: AlarmThresholds;
  steps: StepRow[];
  stepEvents: StepEventRow[];
  /** rid → step, for every event that belongs to a step. */
  stepOf: Map<number, StepRef>;
  /** Steps of a session by n (index n − 1). */
  stepsBySession: Map<string, StepRow[]>;
  actions: Map<string, Action[]>;
  callStats: CallStatRow[];
  callKeys: CallKeyRow[];
  sessionStats: SessionStatRow[];
  turns: Map<string, TurnInfo>;
  turnsBySession: Map<string, TurnInfo[]>;
  failures: FailureRow[];
  sigs: Map<string, SigInfo>;
  episodes: EpisodeRow[];
  attempts: EpisodeAttemptRow[];
  episodeRuns: Map<string, EpisodeRun>;
  processes: ProcessRow[];
  processEvents: ProcessEventRow[];
  /** rid → process, for every event of a process stream. */
  processOf: Map<number, ProcessRow>;
  changes: ChangeRow[];
  interventions: InterventionRow[];
  claims: ClaimRow[];
  alarms: AlarmRow[];
  delegations: DelegationRow[];
  turnRollup: TurnRollupRow[];
  /** turnRollup by turn id. */
  turnRow: Map<string, TurnRollupRow>;
  sessionRollup: SessionRollupRow[];
}

export function newDerived(tree: TreeInput, thresholds: AlarmThresholds = ALARM_THRESHOLDS): Derived {
  return {
    tree, thresholds,
    steps: [], stepEvents: [], stepOf: new Map(), stepsBySession: new Map(),
    actions: new Map(), callStats: [], callKeys: [], sessionStats: [], turns: new Map(), turnsBySession: new Map(),
    failures: [], sigs: new Map(), episodes: [], attempts: [], episodeRuns: new Map(),
    processes: [], processEvents: [], processOf: new Map(), changes: [], interventions: [], claims: [], alarms: [],
    delegations: [], turnRollup: [], turnRow: new Map(), sessionRollup: [],
  };
}

/** Outcomes that end an episode without a recovery in its turn (signature and turn rates). */
export const UNRECOVERED = new Set(['interrupted', 'recovered-later', 'pivoted', 'ended-on-failure']);
