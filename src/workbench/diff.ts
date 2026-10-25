/** AgentDiff (docs/analyses/AGENTDIFF.md): where two runs of one task part, and how each behaved. */
import { type Action, type Run, actionLabel, actionText, loadRun, ref, refs, rework } from './actions.ts';
import { type Data, type Row, fail, integer, measured, object, textId } from './data.ts';
import type { GapFigures } from './gap-text.ts';
import type { Confidence, Coverage } from './types.ts';

export interface DiffSpec {
    left: string;
    right: string;
    limit?: number;
    children?: boolean;
}
type Status = 'same' | 'outcome-differs' | 'object-differs' | 'left-only' | 'right-only';
interface Item {
    a: Action;
    editsBefore: number | null;
    checkBefore: 'ok' | 'failed' | null;
}
interface AlignedRow {
    status: Status;
    left: Item | null;
    right: Item | null;
    score: number;
    ambiguous: boolean;
}
const EXCERPT = 400;
const PATHISH = /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}\b/g;

/** Comparable items with their state descriptor (§2). */
function items(run: Run): Item[] {
    const edits = new Map<string, number>();
    let check: 'ok' | 'failed' | null = null;
    const out: Item[] = [];
    for (const a of run.actions) {
        if (a.op === 'wait') continue;
        const file = a.files.find(f => f.access === 'write') ?? a.files.find(f => f.access === 'read');
        out.push({ a, editsBefore: file ? edits.get(file.path) ?? 0 : null, checkBefore: check });
        for (const f of a.files) if (f.access !== 'read') edits.set(f.path, (edits.get(f.path) ?? 0) + 1);
        if ((a.op === 'test' || a.op === 'build' || a.op === 'typecheck') && a.outcome !== 'unknown') check = a.outcome;
    }
    return out;
}

function pairScore(x: Item, y: Item): number {
    if (x.a.op !== y.a.op) return -1;
    return 2 + (x.a.object === y.a.object ? 3 : 0) + (x.a.outcome === y.a.outcome ? 1 : 0) + (x.editsBefore === y.editsBefore && x.checkBefore === y.checkBefore ? 1 : 0);
}

/** Weighted LCS over actions of equal op (weighted-action-lcs@1); ties prefer pairing, then skipping the left action. */
function align(a: Item[], b: Item[]): AlignedRow[] {
    const n = a.length, m = b.length, w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--) {
            const s = pairScore(a[i], b[j]);
            dp[i * w + j] = Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1], s >= 0 ? s + dp[(i + 1) * w + j + 1] : -1);
        }
    const count = (xs: Item[]) => {
        const c = new Map<string, number>();
        for (const x of xs) c.set(x.a.op + '\0' + x.a.object, (c.get(x.a.op + '\0' + x.a.object) ?? 0) + 1);
        return c;
    };
    const ca = count(a), cb = count(b);
    const rows: AlignedRow[] = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
        const s = i < n && j < m ? pairScore(a[i], b[j]) : -1;
        if (s >= 0 && s + dp[(i + 1) * w + j + 1] === dp[i * w + j]) {
            const x = a[i++], y = b[j++];
            const k = x.a.op + '\0' + x.a.object;
            const status: Status = x.a.object !== y.a.object ? 'object-differs' : x.a.outcome !== y.a.outcome ? 'outcome-differs' : 'same';
            rows.push({ status, left: x, right: y, score: s, ambiguous: (ca.get(k) ?? 0) > 1 || (cb.get(y.a.op + '\0' + y.a.object) ?? 0) > 1 });
        } else if (i < n && (j === m || dp[(i + 1) * w + j] === dp[i * w + j])) rows.push({ status: 'left-only', left: a[i++], right: null, score: 0, ambiguous: false });
        else rows.push({ status: 'right-only', left: null, right: b[j++], score: 0, ambiguous: false });
    }
    return rows;
}

/**
 * A pairing is a candidate when another pairing could replace it (ambiguous) or when it pairs two targets by position
 * (object-differs); else it is derived. An unpaired action has no pairing to doubt, so it is derived too.
 */
function confidenceOf(r: AlignedRow): Confidence {
    if (r.status === 'left-only' || r.status === 'right-only') return 'derived';
    return r.ambiguous || r.status === 'object-differs' ? 'candidate' : 'derived';
}

/**
 * A region side's wall time: from the earlier of the anchor before's end and the side's earliest start, to the later of
 * the anchor after's start and the side's latest end. Subagent actions interleave with their parent's and a long action
 * can outlast the ones after it, so neither the first nor the last row bounds the side. Null when an action of the side
 * has no time, or when the side has no action and an anchor is missing.
 */
function regionWall(acts: Action[], before: number | undefined, after: number | undefined): number | null {
    if (acts.some(a => measured(a.start) === null || measured(a.end) === null)) return null;
    const starts = acts.map(a => a.start), ends = acts.map(a => a.end);
    if (measured(before) !== null) starts.push(before!);
    if (measured(after) !== null) ends.push(after!);
    if (!starts.length || !ends.length) return null;
    const start = Math.min(...starts), end = Math.max(...ends);
    return end >= start ? end - start : null;
}

function view(x: Item | null) {
    if (!x) return null;
    const a = x.a;
    return {
        id: a.id, sessionId: a.sessionId, stepId: a.stepId, op: a.op, object: a.object, label: actionLabel(a), tool: a.tool, outcome: a.outcome,
        start: a.start, end: a.end, editsBefore: x.editsBefore, checkBefore: x.checkBefore, evidence: [ref(a)],
    };
}

/** What a session did right after each failed action (failure-response@1). */
function failureResponses(run: Run): Record<string, number> {
    const out: Record<string, number> = { 'retry-same': 0, 'retry-modified': 0, edit: 0, inspect: 0, delegate: 0, stop: 0, other: 0 };
    for (const list of run.bySession.values())
        for (const a of list) {
            if (a.outcome !== 'failed') continue;
            const next = list[a.local + 1];
            if (!next || next.turnId !== a.turnId) out.stop++;
            else if (next.key === a.key) out[next.inputDigest === a.inputDigest ? 'retry-same' : 'retry-modified']++;
            else if (next.op === 'edit') out.edit++;
            else if (next.op === 'read' || next.op === 'search') out.inspect++;
            else if (next.op === 'run' && namesFrom(a, next)) out.inspect++;
            else if (next.op === 'delegate') out.delegate++;
            else out.other++;
        }
    return out;
}

/** A run action whose input names a path that the failed action's output named. */
function namesFrom(failed: Action, next: Action): boolean {
    const output = failed.result ? actionText({ ...failed, call: null }) : '';
    const tokens = [...new Set(output.match(PATHISH) ?? [])].filter(t => t.length >= 4).slice(0, 50);
    const input = next.call ? JSON.stringify(next.call.a.tool?.input ?? next.call.a.tool?.command ?? '') : '';
    return tokens.some(t => input.includes(t));
}

/**
 * The run's steps as the steps table counts them, over the same sessions as the other metrics: the figure the Steps
 * run report gives for a whole run ("53 steps (46 + 7 in subagents)"), so one word names one count. Text-only steps
 * and waits count, which the actions do not; an index whose analysis never ran has no steps table and no steps.
 */
function stepCount(d: Data, sessionIds: string[]): number {
    if (!d.has('steps')) return 0;
    return sessionIds.reduce((n, id) => n + Number(d.row('SELECT count(*) AS n FROM steps WHERE session_id=?', id)!.n), 0);
}

function metrics(d: Data, run: Run & { pastLimit: number }, aligned: number) {
    const ts = run.loaded.events.filter(e => e.ts_src === 'logged').map(e => e.ts);
    const sum = (key: string) => {
        const known = run.loaded.sessions.map(s => s[key]).filter((v): v is number => typeof v === 'number');
        return known.length ? known.reduce((x, y) => x + y, 0) : null;
    };
    return {
        sessions: run.sessionIds.length, steps: stepCount(d, run.sessionIds), actions: run.actions.length,
        // Waits are actions but are never aligned; past the limit, comparable actions are counted and not loaded.
        alignedActions: aligned, alignableActions: aligned + run.pastLimit,
        failedActions: run.actions.filter(a => a.outcome === 'failed').length, edits: run.actions.filter(a => a.op === 'edit').length,
        filesEdited: new Set(run.actions.flatMap(a => a.files.filter(f => f.access === 'write').map(f => f.path))).size,
        wallUs: ts.length ? Math.max(...ts) - Math.min(...ts) : null, tokensIn: sum('tok_in'), tokensOut: sum('tok_out'),
    };
}

function profile(run: Run) {
    const r = rework(run);
    const finding = (list: { actions: Action[]; confidence: Confidence; detail?: string }[]) => ({ count: list.length, evidence: list.slice(0, 50).map(f => ({ detail: f.detail ?? null, confidence: f.confidence, evidence: refs(f.actions, f.confidence) })) });
    return {
        rereads: finding(r.rereads), reverts: finding(r.reverts), blindRetries: finding(r.blindRetries), repeatedSearches: finding(r.repeatedSearches),
        fixLoops: r.fixLoops.length, fixLoopCycles: r.fixLoops.reduce((n, l) => n + l.cycles, 0), fixLoopsResolved: r.fixLoops.filter(l => l.resolved).length,
        failureResponses: failureResponses(run), gaps: r.gaps,
    };
}

export function diff(d: Data, spec: DiffSpec) {
    object(spec, 'diff');
    const leftId = textId(spec.left, 'left'), rightId = textId(spec.right, 'right');
    if (leftId === rightId) fail('left and right must be different sessions');
    const limit = integer(spec.limit, 1500, 1, 2000, 'diff limit');
    if (spec.children !== undefined && typeof spec.children !== 'boolean') fail('children must be boolean');
    const left = loadRun(d, leftId, { children: spec.children, limit }), right = loadRun(d, rightId, { children: spec.children, limit });
    const a = items(left), b = items(right);
    const rows = align(a, b);
    const isSame = (r: AlignedRow) => r.status === 'same';
    const div = rows.findIndex(r => !isSame(r));
    const lastBefore = (index: number, side: 'left' | 'right') => {
        for (let k = index - 1; k >= 0; k--) if (rows[k][side]) return rows[k][side]!;
        return null;
    };
    const observation = (x: Item | null) => x?.a.result ? { excerpt: actionText({ ...x.a, call: null }).slice(0, EXCERPT), evidence: [ref(x.a)] } : null;
    const next = (index: number, side: 'left' | 'right') => rows.slice(index).flatMap(r => r[side] ? [view(r[side])!] : []).slice(0, 5);
    const anchorIndex = div < 0 ? -1 : rows.slice(0, div).findLastIndex(isSame);
    const firstDivergence = div < 0 ? null : {
        index: div, anchor: anchorIndex < 0 ? null : { index: anchorIndex, left: view(rows[anchorIndex].left), right: view(rows[anchorIndex].right) },
        left: { observation: observation(lastBefore(div, 'left')), next: next(div, 'left') },
        right: { observation: observation(lastBefore(div, 'right')), next: next(div, 'right') },
    };
    // Regions: maximal stretches of non-same rows between same rows.
    const regions: Row[] = [];
    for (let k = 0; k < rows.length;) {
        if (isSame(rows[k])) { k++; continue; }
        const from = k;
        while (k < rows.length && !isSame(rows[k])) k++;
        const to = k - 1, before = from > 0 ? rows[from - 1] : null, after = k < rows.length ? rows[k] : null;
        const side = (s: 'left' | 'right') => {
            const acts = rows.slice(from, to + 1).flatMap(r => r[s] ? [r[s]!.a] : []);
            const ops: Record<string, number> = {};
            for (const x of acts) ops[x.op] = (ops[x.op] ?? 0) + 1;
            return { actions: acts.length, ops, wallUs: regionWall(acts, before?.[s]?.a.end, after?.[s]?.a.start) };
        };
        regions.push({ from, to, anchorBefore: before ? from - 1 : null, anchorAfter: after ? k : null, left: side('left'), right: side('right'), reconverged: !!after });
    }
    const lm = metrics(d, left, a.length), rm = metrics(d, right, b.length);
    const sides = [['A', left, lm], ['B', right, rm]] as const;
    // Each run has its own limits. A run counts toward the action limit only when the limit left out an action the
    // alignment could have used; a cut that removes only waits changes nothing aligned.
    const actionLimit = sides.flatMap(([side, , m]) => m.alignableActions > m.alignedActions ? [{ side, aligned: m.alignedActions, alignable: m.alignableActions }] : []);
    const eventLimit = sides.flatMap(([side, run]) => run.loaded.coverage.truncated ? [{ side, examined: run.loaded.coverage.eventsExamined, available: run.loaded.coverage.eventsAvailable }] : []);
    const figures: GapFigures = { rows: rows.length, regions: regions.length, actionLimit, eventLimit };
    const { gaps: leftGaps, ...leftProfile } = profile(left), { gaps: rightGaps, ...rightProfile } = profile(right);
    const extra = [...left.loaded.coverage.gaps, ...right.loaded.coverage.gaps, ...leftGaps, ...rightGaps, 'alignment-is-structural-not-causal', 'shell-changes-invisible'];
    if (actionLimit.length) extra.push('action-limit');
    if (rows.length > 3000) extra.push('alignment-row-limit');
    if (regions.length > 100) extra.push('region-limit');
    const coverage: Coverage = {
        ...left.loaded.coverage,
        // A run compared with its own subagent shares that subagent's sessions; each is listed once.
        sessionIds: [...new Set([...left.sessionIds, ...right.sessionIds])],
        eventsAvailable: left.loaded.coverage.eventsAvailable + right.loaded.coverage.eventsAvailable,
        eventsExamined: left.loaded.coverage.eventsExamined + right.loaded.coverage.eventsExamined,
        truncated: eventLimit.length > 0 || actionLimit.length > 0,
        gaps: [...new Set(extra)].sort(),
    };
    const delta = Object.fromEntries(Object.entries(lm).map(([k, v]) => { const r = (rm as Row)[k]; return [k, typeof v === 'number' && typeof r === 'number' ? r - v : null]; }));
    const count = (s: Status) => rows.filter(r => r.status === s).length;
    return {
        ...d.envelope(coverage, figures), method: 'weighted-action-lcs@1',
        left: { session: leftId, sessions: left.sessionIds, metrics: lm, profile: leftProfile },
        right: { session: rightId, sessions: right.sessionIds, metrics: rm, profile: rightProfile },
        delta,
        firstDivergence,
        regions: regions.slice(0, 100),
        alignment: rows.slice(0, 3000).map((r, index) => ({ index, status: r.status, confidence: confidenceOf(r), ambiguous: r.ambiguous, score: r.score, left: view(r.left), right: view(r.right) })),
        summary: { rows: rows.length, same: count('same'), outcomeDiffers: count('outcome-differs'), objectDiffers: count('object-differs'), leftOnly: count('left-only'), rightOnly: count('right-only'), ambiguous: rows.filter(r => r.ambiguous).length, regions: regions.length, firstDivergenceIndex: div < 0 ? -1 : div },
        rules: ['weighted-action-lcs@1', 'failure-response@1', 'reread@1', 'revert@1', 'blind-retry@2', 'repeat-search@1', 'fix-loop@1'],
        caveats: ['Paired actions do not establish equal repository state, model input or task.', 'An unpaired action is not evidence that the other run lacked an equivalent behavior.', 'The first divergence is where the recorded actions part; the decision that caused it may come earlier.'],
    };
}
