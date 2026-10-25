/**
 * Replay in the Workbench (docs/REPLAY.md, docs/WORKBENCH.md): what `agentshark replay` would run for a session, and
 * a report it wrote, checked against the recording. Neither runs a call; replay itself stays a CLI command.
 */
import { batchesOf, PlanError, planReplay, type PlannedCall, type RecordedResult, revOf, shellQuote } from '../replay/plan.ts';
import { projectMs } from '../replay/run.ts';
import { type Data, evidence, fail, integer, object, type Row, textId } from './data.ts';
import type { Coverage, EvidenceRef } from './types.ts';

const EXCERPT = 200;
const MAX_REPORT_CALLS = 50_000;
const VERDICTS = ['same', 'output', 'status', 'unrecorded', 'started', 'skipped', 'error'] as const;
type Verdict = (typeof VERDICTS)[number];

/** The replay plan of a session and its subagents: classes, skip reasons, input sources and projected duration. */
export async function replayPlan(data: Data, mode: 'live' | 'capture', input: Row) {
    const session = textId(input.session, 'session');
    data.session(session);
    const limit = integer(input.limit, 2000, 1, 20000, 'limit');
    let plan;
    try {
        plan = await planReplay(data.db, mode, session);
    }
    catch (e) {
        if (e instanceof PlanError) fail(e.message);
        throw e;
    }
    for (const id of plan.sessions) data.assertAllowed(id);
    const refs = evidenceOf(data, plan.calls.slice(0, limit).map(c => c.event), plan.sessions);
    const executable = plan.calls.filter(c => c.action.cls !== 'skip');
    const count = (key: (c: PlannedCall) => string | null) => {
        const out: Record<string, number> = {};
        for (const c of plan.calls) {
            const k = key(c);
            if (k !== null) out[k] = (out[k] ?? 0) + 1;
        }
        return out;
    };
    const skipReasons = count(c => (c.action.cls === 'skip' ? c.action.reason : null));
    const coverage: Coverage = {
        sessionIds: plan.sessions, eventsAvailable: plan.calls.length, eventsExamined: plan.calls.length, truncated: plan.calls.length > limit,
        gaps: ['starting-filesystem-not-recorded', 'replay-environment-differs-from-recording'], indexAnalysisVersion: data.meta('analysis_version'),
        snapshotAt: data.options.now ?? Date.now() * 1000,
    };
    if (skipReasons['input-truncated']) coverage.gaps.push('replay-input-incomplete');
    if (skipReasons.script) coverage.gaps.push('code-mode-script-logic-not-replayed');
    const rev = revOf(plan);
    return {
        ...data.envelope(coverage),
        sessionId: session,
        agent: plan.agent,
        summary: {
            calls: plan.calls.length, executable: executable.length, skipped: plan.calls.length - executable.length, batches: batchesOf(plan.calls).length,
            inputsFromRawRecords: executable.filter(c => c.inputSrc === 'raw').length, inputsFromIndex: executable.filter(c => c.inputSrc === 'index').length,
            recordedFailures: executable.filter(c => c.recorded && !c.recorded.ok).length, unrecordedResults: executable.filter(c => !c.recorded).length,
            projectedSeconds: Math.round(projectMs(plan, { speed: 1, maxGapMs: null }) / 1000),
            projectedSecondsAtMaxSpeed: Math.round(projectMs(plan, { speed: 'max', maxGapMs: null }) / 1000),
        },
        command: `agentshark replay ${shellQuote(session)} --workspace DIR${rev ? ` --rev ${rev}` : ''} --speed max --json -o replay.jsonl`,
        start: { cwd: plan.cwd, gitCommit: plan.gitCommit, home: plan.home, sessions: plan.sessions },
        classes: count(c => (c.action.cls === 'skip' ? null : c.action.cls)),
        skipReasons,
        calls: plan.calls.slice(0, limit).map(c => ({
            n: c.n, tool: c.tool, class: c.action.cls === 'skip' ? `skip: ${c.action.reason}` : c.action.cls, input: excerpt(c.summary),
            recorded: outcome(c.recorded), inputSource: c.inputSrc, batch: c.batch, evidence: refs.get(c.event) ?? null,
        })),
        caveats: [
            'The plan replays recorded actions open-loop: no model is called, so later calls do not adapt to replayed results.',
            'The trace does not contain the starting files; the result of a replay depends on the workspace you supply.',
            'Replay runs in a Linux container without network by default; tools that behave differently there produce output differences.',
        ],
    };
}

/**
 * A report from `agentshark replay --json`, joined to the recording: verdict counts, the divergence point and every
 * call with its recorded event. `records` are the report's JSON lines; `jsonl` is the same as text.
 */
export function replayReport(data: Data, input: Row) {
    const records = reportRecords(input);
    const plan = records.find(r => r.type === 'plan');
    if (!plan) fail('The report has no plan record; pass every line that agentshark replay --json wrote');
    const session = textId(plan!.session, 'plan.session');
    data.session(session);
    const tree = Array.isArray(plan!.sessions) ? plan!.sessions.map((s: unknown) => textId(s, 'plan.sessions')) : [session];
    for (const id of tree) data.assertAllowed(id);
    const calls = records.filter(r => r.type === 'call');
    if (calls.length > MAX_REPORT_CALLS) fail(`The report has more than ${MAX_REPORT_CALLS} calls`);
    const summary = records.find(r => r.type === 'summary');
    const refs = evidenceOf(data, calls.map(c => String(c.event ?? '')), tree);
    const missing = calls.filter(c => !refs.has(String(c.event ?? ''))).length;
    const counts = Object.fromEntries(VERDICTS.map(v => [v, 0])) as Record<Verdict, number>;
    for (const c of calls) if (VERDICTS.includes(c.verdict)) counts[c.verdict as Verdict]++;
    const first = calls.find(c => c.verdict === 'status') ?? null;
    const planned = Array.isArray(plan!.calls) ? plan!.calls.length : calls.length;
    const coverage: Coverage = {
        sessionIds: tree, eventsAvailable: planned, eventsExamined: calls.length, truncated: calls.length < planned,
        gaps: ['replay-environment-differs-from-recording'], indexAnalysisVersion: data.meta('analysis_version'),
        snapshotAt: data.options.now ?? Date.now() * 1000,
    };
    if (!summary || summary.interrupted === true) coverage.gaps.push('replay-interrupted');
    if (missing) coverage.gaps.push('report-events-missing-from-index');
    const row = (c: Row) => ({
        n: c.n, tool: c.tool, verdict: c.verdict, input: excerpt(c.summary), recorded: outcome(c.recorded), replayed: outcome(c.replayed),
        difference: c.diff ? `line ${c.diff.line}: ${excerpt(c.diff.recorded) || '(none)'} → ${excerpt(c.diff.replayed) || '(none)'}`
            : excerpt(c.reason) || excerpt(c.replayed?.stderrHead) || null,
        evidence: refs.get(String(c.event ?? '')) ?? null,
    });
    return {
        ...data.envelope(coverage),
        sessionId: session,
        summary: { calls: calls.length, executed: calls.length - counts.skipped, ...counts, eventsNotInIndex: missing },
        environment: {
            image: plan!.image ?? null, network: plan!.network ?? null, workspace: plan!.workspace ?? null,
            rev: plan!.rev ?? (plan!.workspace ? 'working tree' : null),
            speed: plan!.speed ?? null, wallSeconds: typeof summary?.wallMs === 'number' ? Math.round(summary.wallMs / 1000) : null,
            interrupted: summary ? summary.interrupted === true : null,
        },
        divergence: first ? row(first) : null,
        calls: calls.map(row),
        caveats: [
            'A status difference shows that the same action had another outcome in the replay environment; it does not say why.',
            'Every call after the first status difference ran in a state the recording never saw.',
            'Output differences are common across machines; compare them with the environment before reading them as regressions.',
        ],
    };
}

function reportRecords(input: Row): Row[] {
    if (typeof input.jsonl === 'string') {
        return input.jsonl.split('\n').filter(l => l.trim()).map((l, i) => {
            try {
                const v = JSON.parse(l);
                object(v, `line ${i + 1}`);
                return v as Row;
            }
            catch (e) {
                return fail(e instanceof SyntaxError ? `line ${i + 1} of the report is not JSON` : (e as Error).message);
            }
        });
    }
    if (!Array.isArray(input.records)) fail('Pass the report as records (its JSON lines, parsed) or jsonl (its text)');
    return (input.records as unknown[]).map((v, i) => {
        object(v, `records[${i}]`);
        return v as Row;
    });
}

/** Evidence references, by id, of the events that exist in `sessions`. */
function evidenceOf(data: Data, ids: string[], sessions: string[]): Map<string, EvidenceRef> {
    const rows = data.rows(`SELECT id, session_id, src_id, src_line FROM events
        WHERE id IN (SELECT value FROM json_each(?)) AND session_id IN (SELECT value FROM json_each(?))`, JSON.stringify([...new Set(ids)]), JSON.stringify(sessions));
    return new Map(rows.map(r => [r.id as string, evidence(r)]));
}

/** "ok · exit 0 · 1.2 s" for a recorded or replayed status; null when there is none. */
function outcome(s: (Partial<RecordedResult> & { durMs?: number; timedOut?: boolean }) | null | undefined): string | null {
    if (!s || typeof s !== 'object') return null;
    const ms = typeof s.durMs === 'number' ? s.durMs : typeof s.durUs === 'number' ? s.durUs / 1000 : null;
    return [s.timedOut ? 'timed out' : s.ok ? 'ok' : 'failed', typeof s.exitCode === 'number' ? `exit ${s.exitCode}` : null,
        ms === null ? null : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`].filter(Boolean).join(' · ');
}

function excerpt(value: unknown): string {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return text.length > EXCERPT ? text.slice(0, EXCERPT - 1) + '…' : text;
}
