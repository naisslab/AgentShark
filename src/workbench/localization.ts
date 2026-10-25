/** Localization Map (docs/analyses/LOCALIZATION.md): how quickly a run found the files it changed. */
import { type Action, type Run, type StaleView, actionText, addGaps, loadRun, median, ref, refs, rework, staleViews } from './actions.ts';
import { type Data, type Row, evidence, fail, integer, object, textId } from './data.ts';
import type { EvidenceRef } from './types.ts';

export interface LocalizationSpec {
    session: string;
    scope?: 'turn' | 'run';
    limit?: number;
}
interface Milestone {
    evidence: EvidenceRef;
    step: number;
    us: number | null;
}
interface Window {
    turnId: string | null;
    actions: Action[];
}

/** The root turn each session's work belongs to: a child's delegation turn, walked up to the root. */
function windowKeys(d: Data, run: Run): (a: Action) => string | null {
    const delegations = d.derived('delegations', run.sessionIds);
    const byChild = new Map<string, Row>(delegations.filter(r => r.child_session).map(r => [r.child_session, r]));
    const turns = d.derived('turn_rollup', [run.rootId]).sort((a, b) => a.start_ts - b.start_ts);
    const cache = new Map<string, string | null>();
    const of = (sessionId: string, depth = 0): string | null => {
        if (cache.has(sessionId)) return cache.get(sessionId)!;
        let turn: string | null = null;
        const dl = byChild.get(sessionId);
        if (dl && depth < 20) turn = dl.session_id === run.rootId ? dl.parent_turn ?? null : of(dl.session_id, depth + 1);
        if (!turn) {
            // No delegation row: the root turn whose interval holds the child's first action.
            const first = run.bySession.get(sessionId)?.[0]?.ts;
            turn = first === undefined ? null : [...turns].reverse().find(t => t.start_ts <= first)?.turn_id ?? null;
        }
        cache.set(sessionId, turn);
        return turn;
    };
    return a => a.sessionId === run.rootId ? a.turnId : of(a.sessionId);
}

/** Blind edits (§6) are the run's stale views (`stale-view@1`, ACTIONS §3.4), by the action that made them. */
function blindEdits(run: Run): Map<Action, StaleView[]> {
    const out = new Map<Action, StaleView[]>();
    for (const v of staleViews(run).stale) (out.get(v.at.action!) ?? out.set(v.at.action!, []).get(v.at.action!)!).push(v);
    return out;
}

/** Writes that created their file (§3): an `add`, or a Write (`write`, which may also overwrite) of a file the run had not touched. */
function creations(run: Run): Set<string> {
    const touched = new Set<string>(), out = new Set<string>();
    for (const a of run.actions)
        for (const f of a.files) {
            if (f.access === 'write' && !touched.has(f.path) && (f.change === 'add' || f.change === 'write')) out.add(`${a.index}\0${f.path}`);
            touched.add(f.path);
        }
    return out;
}

export function localization(d: Data, spec: LocalizationSpec) {
    object(spec, 'localization');
    const root = textId(spec.session, 'session');
    const scope = spec.scope ?? 'turn';
    if (scope !== 'turn' && scope !== 'run') fail('scope must be turn or run');
    const limit = integer(spec.limit, 200, 1, 1000, 'localization limit');
    const run = loadRun(d, root);
    const blind = blindEdits(run), creates = creations(run);
    const reworkFound = rework(run);
    const rereadActions = new Set(reworkFound.rereads.map(f => f.actions[1]));
    // Windows in run order.
    const windows: Window[] = [];
    if (scope === 'run') windows.push({ turnId: null, actions: run.actions });
    else {
        const keyOf = windowKeys(d, run), byTurn = new Map<string, Window>();
        for (const a of run.actions) {
            const turn = keyOf(a) ?? '';
            let w = byTurn.get(turn);
            if (!w) byTurn.set(turn, w = { turnId: turn || null, actions: [] });
            w.actions.push(a);
        }
        windows.push(...byTurn.values());
    }
    const rootTurns = scope === 'turn' ? d.derived('turn_rollup', [root]).length || new Set(run.bySession.get(root)?.map(a => a.turnId)).size : 0;
    const withEdits = windows.filter(w => w.actions.some(a => a.files.some(f => f.access === 'write')));
    let listCut = false;
    const results = withEdits.slice(0, limit).map(w => {
        const start = w.actions[0];
        const stepOf = new Map<Action, number>();
        // An action without a step counts as a step of its own.
        let step = 0, last: string | null = null;
        for (const a of w.actions) {
            if (a.stepId === null || a.stepId !== last) step++;
            last = a.stepId;
            stepOf.set(a, step);
        }
        const milestone = (a: Action | undefined): Milestone | null => a ? { evidence: ref(a), step: stepOf.get(a)!, us: start.ts && a.ts >= start.ts ? a.ts - start.ts : null } : null;
        const files = new Map<string, { path: string; display: string; created: boolean; edits: number; reads: number; read?: Action; edited?: Action; seen?: Action }>();
        const uncertain = new Map<string, { display: string; actions: Action[] }>();
        for (const a of w.actions)
            for (const f of a.files)
                if (f.access === 'write') {
                    const entry = files.get(f.path) ?? { path: f.path, display: f.display, created: creates.has(`${a.index}\0${f.path}`), edits: 0, reads: 0 };
                    entry.edits++;
                    entry.edited ??= a;
                    files.set(f.path, entry);
                }
        for (const a of w.actions)
            for (const f of a.files) {
                const entry = files.get(f.path);
                if (f.access === 'read' && entry) {
                    entry.reads++;
                    entry.read ??= a;
                } else if (f.access === 'uncertain' && !files.has(f.path)) {
                    const u = uncertain.get(f.path) ?? { display: f.display, actions: [] };
                    u.actions.push(a);
                    uncertain.set(f.path, u);
                }
            }
        // seen: the first action whose recorded text names the file (inferred:seen-in-text@1).
        for (const entry of files.values()) {
            const needles = [entry.path, entry.display].filter(n => n.length >= 3);
            entry.seen = w.actions.find(a => {
                const text = actionText(a);
                return needles.some(n => text.includes(n));
            });
        }
        const located = [...files.values()].filter(f => !f.created);
        const readSteps = located.flatMap(f => f.read ? [stepOf.get(f.read)!] : []);
        const firstRelevant = readSteps.length ? Math.min(...readSteps) : null;
        const firstRelevantAction = located.map(f => f.read).filter((a): a is Action => !!a).sort((a, b) => a.index - b.index)[0];
        const touched = located.map(f => Math.min(...[f.read, f.edited].filter((a): a is Action => !!a).map(a => stepOf.get(a)!)));
        const reads = w.actions.filter(a => a.files.some(f => f.access === 'read'));
        const relevantReads = reads.filter(a => a.files.some(f => f.access === 'read' && files.has(f.path) && !files.get(f.path)!.created));
        const explored = new Map<string, { display: string; actions: Action[] }>();
        for (const a of reads)
            for (const f of a.files.filter(f => f.access === 'read' && !files.has(f.path))) {
                const e = explored.get(f.path) ?? { display: f.display, actions: [] };
                e.actions.push(a);
                explored.set(f.path, e);
            }
        const fileList = [...files.values()];
        if (fileList.length > 200 || explored.size > 50) listCut = true;
        return {
            turnId: w.turnId, start: start.ts, end: w.actions[w.actions.length - 1].end, steps: step,
            files: fileList.slice(0, 200).map(f => ({ path: f.path, display: f.display, created: f.created, seen: milestone(f.seen), read: milestone(f.read), edited: milestone(f.edited), edits: f.edits, reads: f.reads })),
            uncertainEdits: [...uncertain.entries()].slice(0, 200).map(([path, u]) => ({ path, display: u.display, evidence: refs(u.actions, 'candidate') })),
            measures: {
                stepsToFirstRelevantRead: firstRelevant,
                stepsToAllRelevantTouched: touched.length && touched.every(Number.isFinite) ? Math.max(...touched) : null,
                usToFirstRelevantRead: firstRelevantAction && firstRelevantAction.ts >= start.ts ? firstRelevantAction.ts - start.ts : null,
                searchesBeforeFirstRelevantRead: firstRelevant === null ? null : w.actions.filter(a => a.op === 'search' && stepOf.get(a)! < firstRelevant).length,
                reads: reads.length, relevantReads: relevantReads.length, relevantReadShare: reads.length ? relevantReads.length / reads.length : null,
                exploredFiles: explored.size, rereads: w.actions.filter(a => rereadActions.has(a)).length,
            },
            blindEdits: w.actions.flatMap(a => (blind.get(a) ?? []).map(v => ({ path: v.path, display: v.display, cause: v.cause, evidence: [ref(a, 'candidate'), ...v.since.flatMap(w => w.event ? [evidence(w.event, 'candidate')] : [])].slice(0, 50), confidence: 'candidate' as const, rule: v.rule }))),
            explored: [...explored.entries()].sort((a, b) => b[1].actions.length - a[1].actions.length).slice(0, 50).map(([path, e]) => ({ path, display: e.display, reads: e.actions.length, evidence: refs(e.actions) })),
        };
    });
    const gaps = ['shell-changes-invisible', 'shell-reads-partially-recognized', 'seen-limited-to-indexed-text'];
    if (withEdits.length > limit) gaps.push('localization-window-limit');
    if (listCut) gaps.push('localization-list-limit');
    if (run.truncated) gaps.push('action-limit');
    addGaps(run.loaded, ...gaps);
    const edited = new Set(results.flatMap(w => w.files.filter(f => !f.created).map(f => f.path)));
    const created = new Set(results.flatMap(w => w.files.filter(f => f.created).map(f => f.path)));
    return {
        ...d.envelope(run.loaded.coverage), sessionId: root, scope, windows: results,
        summary: {
            windows: results.length, turnsWithoutEdits: scope === 'turn' ? Math.max(0, rootTurns - withEdits.length) : 0, editedFiles: edited.size, createdFiles: created.size,
            blindEdits: results.reduce((n, w) => n + w.blindEdits.length, 0),
            medianStepsToFirstRelevantRead: median(results.map(w => w.measures.stepsToFirstRelevantRead).filter((x): x is number => x !== null)),
            medianRelevantReadShare: median(results.map(w => w.measures.relevantReadShare).filter((x): x is number => x !== null)),
        },
        rules: ['seen-in-text@1', 'stale-view@1', 'reread@1'],
        caveats: ['Localization latency describes the search, not whether the edits were right.', 'A file read but never edited may still have been necessary.', 'A blind edit may draw on a search hit, a diff or a message; review its evidence.'],
    };
}
