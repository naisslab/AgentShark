/**
 * Gap sentences (docs/analyses/ANALYSIS-UX.md §7 E5). One table serves `coverage.notes` of every workbench result and
 * AgentPerf's `missing[].effect`, so the browser, the Mac app and agents read the same words for a gap.
 */
import { fmtDur } from '../model/format.ts';
import type { GapCode } from '../model/types.ts';
import type { Coverage, GapNote } from './types.ts';

/** Figures an analysis knows when it builds its result. A sentence whose figure is absent uses a form without it. */
export interface GapFigures {
    /**
     * AgentDiff: each run whose limit left out a comparable action, with the comparable actions it aligned and those it
     * had. The clients call the left run A and the right run B.
     */
    actionLimit?: { side: 'A' | 'B'; aligned: number; alignable: number }[];
    /** AgentDiff: each run whose events passed the event limit. Each run has its own limit. */
    eventLimit?: { side: 'A' | 'B'; examined: number; available: number }[];
    /** AgentDiff: alignment rows before the 3,000-row cap. */
    rows?: number;
    /** AgentDiff: difference regions before the 100-region cap. */
    regions?: number;
    /** AgentPerf: path segments before the 2,000-segment cap. */
    segmentsTotal?: number;
    /** AgentPerf: the time on the critical path no interval explains, of the path's length, with its share from 0 to 1. */
    unexplained?: { us: number; wallUs: number; share: number };
    /** AgentPerf: the analysed window, of the root session's time span, with its share from 0 to 1. */
    window?: { analyzedUs: number; sessionUs: number; share: number };
    /** AgentPerf: the agents of the run's sessions. */
    agents?: string[];
}
type Text = string | ((f: GapFigures, c: Coverage) => string);

/**
 * Gaps every result of an analysis carries, whatever its data: limits of the method or of the logs. Clients can show
 * them apart from the gaps found in this data, as the Compare caveat line does (ANALYSIS-UX §5.8).
 */
export const PERMANENT_GAPS: ReadonlySet<string> = new Set(['logs-do-not-establish-complete-execution', 'queue-time-not-logged', 'alignment-is-structural-not-causal', 'shell-changes-invisible']);

const count = (n: number) => n.toLocaleString('en-US');
/**
 * "the first 2 of 3 actions in A and the first 1 of 2 in B": the noun follows the first run only. `lead` comes before
 * each run's figure: "the first " where the analysis keeps a run's first items, nothing where it does not establish it.
 */
function perSide(cuts: [side: string, kept: number, of: number][], noun: string, lead = 'the first '): string {
    return cuts.map(([side, kept, of], i) => `${lead}${count(kept)} of ${count(of)}${i ? '' : ` ${noun}`} in ${side}`).join(' and ');
}
/** A share as people read it: never 0% for some time, never 100% for less than all of it. */
function percent(share: number): string {
    if (share > 0 && share < 0.005) return '<1%';
    if (share < 1 && share > 0.995) return '>99%';
    return `${Math.round(share * 100)}%`;
}

export const GAP_TEXT: Readonly<Record<string, Text>> = {
    // Every analysis: the loaded events and the index (Data.load).
    'analysis-failed': 'The analysis pass failed on some run trees, so their derived rows may be missing.',
    'analysis-outdated': 'The derived tables come from another analysis version or were never written (run agentshark index --rederive).',
    'analysis-pending': 'Some run trees still wait for the analysis pass, so their derived rows may be missing or old.',
    'capture-coverage-unknown': 'The capture does not record which evidence it includes.',
    'capture-evidence-omitted': 'The capture leaves out some raw records or sidecar files, so some evidence cannot be opened.',
    'capture-evidence-redacted': 'The capture was redacted for privacy, so some text is replaced.',
    'capture-incomplete': 'The capture stream did not finish, so sessions or events may be missing.',
    'capture-integrity-failed': 'The capture failed its integrity checks, so its records may differ from what was exported.',
    'capture-integrity-unverified': "The capture's integrity was not verified.",
    'cross-source-order-reconstructed': 'Events from several source files were merged in timestamp order.',
    // A cut load always fills the limit, so eventsExamined is the limit (50,000 over HTTP and MCP, 20,000 in the CLI).
    // Merged sources load in sequence order, so the loaded events need not start at a session's start: no "first".
    'event-limit': (f, c) => f.eventLimit?.length
        ? `Only ${perSide(f.eventLimit.map(s => [s.side, s.examined, s.available]), 'events', '')} were analysed.`
        : `Only ${count(c.eventsExamined)} of ${count(c.eventsAvailable)} events were analysed.`,
    'event-payload-missing': 'Some events have no stored payload, so their text and tool details are missing.',
    'indexed-text-truncated': 'Some text was shortened when it was indexed, so text matches can miss the cut parts.',
    'invalid-or-empty-event-payload': 'Some event payloads could not be read and count as empty.',
    'logs-do-not-establish-complete-execution': 'The logs hold what the agents recorded, which is not necessarily everything that ran.',
    'malformed-source-records': 'Some source lines could not be parsed and are not in the index.',
    'timestamps-inferred-or-missing': 'Some events have inferred or missing timestamps, so times near them are approximate.',
    'unknown-record-kinds': 'Some records are of a kind this version does not decode, so they are kept as raw records.',
    'unknown-source-records': 'Some source records are of a type this version does not recognise.',
    // The action stream (ACTIONS.md).
    // Waits count toward the limit but are never aligned, so the first figure is the comparable actions kept, not the limit.
    'action-limit': f => f.actionLimit?.length
        ? `Aligned ${perSide(f.actionLimit.map(s => [s.side, s.aligned, s.alignable]), 'actions')}.`
        : 'A run has more actions than the limit, so only its first actions were analysed.',
    'cross-session-order-from-timestamps': 'Order across subagents comes from timestamps.',
    'edit-inputs-truncated': 'Some edit inputs were truncated in the logs, so edits may compare as equal when they differ.',
    'shell-changes-invisible': 'Shell commands can change files without a logged edit.',
    // AgentDiff.
    'alignment-is-structural-not-causal': 'The alignment pairs actions by structure, not cause.',
    'alignment-row-limit': f => f.rows === undefined ? 'Only the first 3,000 aligned rows were returned.' : `Only the first 3,000 of ${count(f.rows)} aligned rows were returned.`,
    'region-limit': f => f.regions === undefined ? 'Only the first 100 difference regions were returned.' : `Only the first 100 of ${count(f.regions)} difference regions were returned.`,
    // AgentPerf (its `missing` list).
    'approvals-not-logged': 'Approvals are not logged, so approval waits count as tool time.',
    'child-matched-by-time': 'A wait was expanded into the child that overlapped it, so the critical child is inferred.',
    'critical-path-mostly-unexplained': ({ unexplained: u }) => `${u ? `${fmtDur(u.us)} of the ${fmtDur(u.wallUs)} critical path (${percent(u.share)})` : 'More than a quarter of the critical path'} has no logged or derived interval, so its largest class is not established.`,
    'critical-path-segment-limit': f => f.segmentsTotal === undefined ? 'Only the first 2,000 path segments were returned.' : `Only the first 2,000 of ${count(f.segmentsTotal)} path segments were returned.`,
    // The loaded events need not start at the session's start (merged sources load in sequence order), so no "first".
    'critical-path-window-partial': ({ window: w }) => w
        ? `The critical path covers only the loaded events: ${fmtDur(w.analyzedUs)} of this session's ${fmtDur(w.sessionUs)} (${percent(w.share)}).`
        : "The critical path covers only the loaded events, not all of this session's time span.",
    'model-time-not-logged': ({ agents }) => {
        const claude = 'Claude model time is only its logged latency (the rest is unattributed)', codex = 'Codex model time is a timestamp gap';
        const hasClaude = agents?.some(a => a.startsWith('claude')), hasCodex = agents?.includes('codex');
        return `${hasClaude && !hasCodex ? claude : hasCodex && !hasClaude ? codex : `${claude}, and ${codex}`}.`;
    },
    'queue-time-not-logged': 'Request queueing at the provider is inside model or unattributed time.',
};

/** Codes that carry a value after the colon (`session-state:source-deleted`). */
const VALUE_TEXT: Readonly<Record<string, (value: string) => string>> = {
    'session-state': v => v === 'source-deleted' ? "A session's source file was deleted, but the index keeps the events it read." : `A session is in the index state ${v}.`,
    'source-status': v => v === 'error' ? 'A source file failed to parse, so records after the failure may be missing.'
        : v === 'deleted' ? 'A source file was deleted after indexing, so its raw records cannot be opened.'
            : v === 'stale' ? 'A source file waits for re-indexing, so its events may be out of date.'
                : `A source file has the status ${v}.`,
};

/**
 * Gap codes of the derived queries (`Gap.code`) that the analyses report too. The derived queries word them from this
 * table (ANALYSIS-UX Decision 12, DESIGN §9), so the Steps run report and Critical Path name a gap in the same words.
 */
export const SHARED_GAP_CODES = ['analysis-outdated', 'analysis-pending', 'approvals-not-logged', 'model-time-not-logged', 'shell-changes-invisible'] as const;
export type SharedGapCode = Extract<GapCode, (typeof SHARED_GAP_CODES)[number]>;

/**
 * A shared gap's sentence as the derived queries' `Gap.message`: without the final period, since clients follow a
 * message with their own suffix ("… (data limit 2)"), and without a semicolon inside, since clients join messages
 * with one ("3 data gaps: …; …; …"). `figures` picks a sentence's narrower form: `agents` names the run's agents for
 * `model-time-not-logged`. No shared sentence reads the coverage; without figures each takes its general form.
 */
export function gapClause(code: SharedGapCode, figures: GapFigures = {}): string {
    const text = GAP_TEXT[code];
    return (typeof text === 'function' ? text(figures, {} as Coverage) : text).replace(/\.$/, '');
}

/** The sentence for one gap code, or null when the table has none. */
export function gapText(code: string, coverage: Coverage, figures: GapFigures = {}): string | null {
    const text = GAP_TEXT[code];
    if (text !== undefined) return typeof text === 'string' ? text : text(figures, coverage);
    const colon = code.indexOf(':');
    const valued = colon > 0 ? VALUE_TEXT[code.slice(0, colon)] : undefined;
    return valued ? valued(code.slice(colon + 1)) : null;
}

/** One note per gap of `coverage` that has a sentence, in the order of `coverage.gaps`. */
export function gapNotes(coverage: Coverage, figures: GapFigures = {}): GapNote[] {
    return coverage.gaps.flatMap(code => {
        const text = gapText(code, coverage, figures);
        return text === null ? [] : [{ code, text, permanent: PERMANENT_GAPS.has(code) }];
    });
}
