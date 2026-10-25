/** AgentPerf (docs/analyses/AGENTPERF.md): the critical path of a run, its rework time and its delegation. */
import { TIME_BUCKETS } from '../model/types.ts';
import { sessionIntervals, type TimeInterval } from '../index/derive/time.ts';
import { type Action, type Run, actionLabel, addGaps, loadRun, refs, rework } from './actions.ts';
import { type Data, type Event, evidence, object, oneLine, textId, union } from './data.ts';
import { type GapFigures, gapText } from './gap-text.ts';
import type { EvidenceRef, PerfWindow } from './types.ts';

export interface PerfSpec {
    session: string;
}
type Bucket = (typeof TIME_BUCKETS)[number] | 'human-gap' | 'continuation' | 'coordination' | 'unattributed';
type Class = 'model' | 'tools' | 'people' | 'idle' | 'coordination' | 'harness' | 'unattributed';
interface Seg {
    sessionId: string;
    bucket: Bucket;
    start: number;
    end: number;
    logged: boolean;
    ref: string | null;
}
interface Timeline {
    agent: string;
    intervals: (TimeInterval | { start: number; end: number; bucket: Bucket; logged: boolean; ref?: string })[];
    active: [number, number] | null;
}
const PRIORITY: Bucket[] = [...TIME_BUCKETS, 'human-gap', 'continuation'];
const RANK = new Map(PRIORITY.map((b, i) => [b, i]));
export const CLASS_OF: Record<Bucket, Class> = {
    model: 'model', 'api-retry': 'model', tool: 'tools', 'wait-process': 'tools', hook: 'tools', 'wait-human': 'people', 'human-gap': 'people',
    coordination: 'coordination', continuation: 'idle', 'wait-agent': 'coordination', compaction: 'harness', unattributed: 'unattributed',
};
const BUSY = new Set<Bucket>(['model', 'api-retry', 'tool', 'wait-process', 'hook', 'compaction']);
const ADVICE: Record<Class, string> = {
    model: 'Model latency bound the path: response length, context size, model and reasoning effort are the levers.',
    tools: 'Tool runtime bound the path: the slowest targets on the path are listed.',
    people: 'The run waited on people: questions, approvals and pauses between prompts.',
    idle: 'The run sat idle between turns that no person started: background-task notifications, scheduled wakeups and goal continuations.',
    coordination: 'Waiting on other agents without attributed activity bound the path: delegation and scheduling are the levers.',
    harness: 'Compaction bound the path.',
    unattributed: 'The logs do not explain most of the path; see the data gaps.',
};
const PEOPLE_UNLOGGED_APPROVALS = 'The run waited on people: questions and pauses between prompts (approval waits are not logged).';
const SKEW_US = 1_000_000;
const SEGMENT_CAP = 2000;
const LABEL_CHARS = 120;
/** What a segment's interval was: a step's model time, a call or other span, or a wait on a child run (§3.2). */
type RefKind = 'step' | 'call' | 'child';
interface Part {
    sessionId: string;
    bucket: Bucket;
    class: Class;
    us: number;
    segments: number;
}
/** A returned segment: one path segment, or a run of short ones combined (`parts` and `members` set). */
interface Shown {
    sessionId: string;
    bucket: Bucket | 'mixed';
    class: Class | 'mixed';
    start: number;
    end: number;
    logged: boolean;
    ref: string | null;
    parts?: Part[];
    members?: Seg[];
}

/**
 * Segments shorter than `minUs` combine in path order into groups that close once they span `minUs`, or when a longer
 * segment follows; longer segments, and groups of one, stay as they are. Every long segment and every group closed by
 * its span lasts at least `minUs`, and each other group ends where a long segment starts or where the path ends, so
 * at `minUs` = wallUs/1000 at most 2,000 segments remain and the cap reaches the end of the path.
 */
function coalesce(path: Seg[], minUs: number): Shown[] {
    const out: Shown[] = [];
    let group: Seg[] = [], span = 0;
    const close = () => {
        if (group.length === 1) out.push({ ...group[0], class: CLASS_OF[group[0].bucket] });
        else if (group.length) out.push(combine(group));
        group = [];
        span = 0;
    };
    for (const s of path) {
        if (s.end - s.start >= minUs) {
            close();
            out.push({ ...s, class: CLASS_OF[s.bucket] });
            continue;
        }
        group.push(s);
        span += s.end - s.start;
        if (span >= minUs) close();
    }
    close();
    return out;
}

/**
 * One segment over the members' combined interval. The parts keep each session's and bucket's time; only the order
 * inside the group is lost. A group can cross sessions, as it does where a wait expands into a child, and then belongs
 * to the session with most of its time.
 */
function combine(members: Seg[]): Shown {
    const byKey = new Map<string, Part>(), bySession = new Map<string, number>();
    for (const m of members) {
        const key = m.sessionId + '\0' + m.bucket;
        const p = byKey.get(key) ?? byKey.set(key, { sessionId: m.sessionId, bucket: m.bucket, class: CLASS_OF[m.bucket], us: 0, segments: 0 }).get(key)!;
        p.us += m.end - m.start;
        p.segments++;
        bySession.set(m.sessionId, (bySession.get(m.sessionId) ?? 0) + m.end - m.start);
    }
    const parts = [...byKey.values()].sort((x, y) => y.us - x.us || x.bucket.localeCompare(y.bucket) || x.sessionId.localeCompare(y.sessionId));
    const buckets = new Set(parts.map(p => p.bucket)), classes = new Set(parts.map(p => p.class));
    return {
        sessionId: [...bySession].reduce((best, s) => s[1] > best[1] ? s : best)[0],
        bucket: buckets.size === 1 ? parts[0].bucket : 'mixed', class: classes.size === 1 ? parts[0].class : 'mixed',
        start: members[0].start, end: members[members.length - 1].end, logged: members.every(m => m.logged), ref: null, parts, members,
    };
}

/** Split [a, b) among intervals by bucket priority; time no interval covers is unattributed (§3.2). */
function split(sessionId: string, a: number, b: number, intervals: Timeline['intervals']): Seg[] {
    const points = new Set<number>([a, b]);
    const clipped = intervals.filter(iv => iv.end > a && iv.start < b).map(iv => ({ ...iv, start: Math.max(a, iv.start), end: Math.min(b, iv.end) }));
    for (const iv of clipped) points.add(iv.start).add(iv.end);
    const sorted = [...points].sort((x, y) => x - y);
    const byStart = [...clipped].sort((x, y) => x.start - y.start);
    const active: typeof clipped = [];
    const out: Seg[] = [];
    let next = 0;
    for (let k = 0; k + 1 < sorted.length; k++) {
        const p = sorted[k], q = sorted[k + 1];
        while (next < byStart.length && byStart[next].start <= p) active.push(byStart[next++]);
        for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= p) active.splice(i, 1);
        let best: (typeof clipped)[number] | null = null;
        for (const iv of active) {
            const r = RANK.get(iv.bucket as Bucket)!, br = best ? RANK.get(best.bucket as Bucket)! : Infinity;
            if (r < br || r === br && iv.logged && !best!.logged) best = iv;
        }
        const seg: Seg = best ? { sessionId, bucket: best.bucket as Bucket, start: p, end: q, logged: best.logged, ref: best.ref ?? null } : { sessionId, bucket: 'unattributed', start: p, end: q, logged: false, ref: null };
        const last = out[out.length - 1];
        if (last && last.bucket === seg.bucket && last.ref === seg.ref && last.end === seg.start) last.end = seg.end;
        else out.push(seg);
    }
    return out;
}

function timelines(d: Data, run: Run): Map<string, Timeline> {
    const out = new Map<string, Timeline>();
    const ts = new Map<string, number[]>();
    for (const e of run.loaded.events) if (e.ts_src === 'logged') (ts.get(e.session_id) ?? ts.set(e.session_id, []).get(e.session_id)!).push(e.ts);
    for (const sid of run.sessionIds) {
        const s = sessionIntervals(d.db, sid);
        const own = ts.get(sid) ?? [];
        const intervals: Timeline['intervals'] = [...(s?.intervals ?? [])];
        const turns = [...(s?.turns ?? [])].sort((x, y) => x.start - y.start);
        for (let i = 1; i < turns.length; i++) {
            const gapStart = Math.max(turns[i - 1].start, turns[i - 1].end);
            if (turns[i].start > gapStart) intervals.push({ start: gapStart, end: turns[i].start, bucket: turns[i].human ? 'human-gap' : 'continuation', logged: false });
        }
        out.set(sid, { agent: s?.agent ?? '', intervals, active: own.length ? [Math.min(...own), Math.max(...own)] : null });
    }
    return out;
}

export function perf(d: Data, spec: PerfSpec) {
    object(spec, 'perf');
    const rootId = textId(spec.session, 'session');
    const run = loadRun(d, rootId);
    const lines = timelines(d, run);
    const recorded = d.derived('delegations', run.sessionIds);
    const delegations = recorded.filter(r => r.child_session && run.sessions.has(r.child_session));
    const delegationOf = new Map(delegations.map(r => [r.child_session, r]));
    const childrenOf = new Map<string, string[]>();
    for (const sid of run.sessionIds) {
        const parent = run.sessions.get(sid)?.parent_id;
        if (parent && run.sessions.has(parent)) (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(sid);
    }
    let matchedByTime = false;
    // Critical path (§3.2): the root's own timeline, with each wait on an agent expanded into the child it waited on.
    const attribute = (sid: string, a: number, b: number, depth: number): Seg[] => {
        const out: Seg[] = [];
        for (const seg of split(sid, a, b, lines.get(sid)!.intervals)) {
            // A gap between turns while a child works (a background subagent, a teammate) is a wait on that child; the rest stays idle.
            const between = seg.bucket === 'continuation', rest: Bucket = between ? 'continuation' : 'coordination';
            if ((seg.bucket !== 'wait-agent' && !between) || depth >= 8) { out.push(seg); continue; }
            const candidates = (childrenOf.get(sid) ?? []).flatMap(c => {
                const act = lines.get(c)?.active, dl = delegationOf.get(c);
                return act && act[1] > seg.start && act[0] < seg.end && (!dl || dl.start_ts <= seg.end) ? [{ id: c, start: act[0], end: act[1], exact: !!dl && dl.id === seg.ref }] : [];
            });
            const exact = candidates.find(c => c.exact);
            const inside = candidates.filter(c => c.end <= seg.end + SKEW_US).sort((x, y) => y.end - x.end || x.id.localeCompare(y.id));
            const overlap = (c: { start: number; end: number }) => Math.min(seg.end, c.end) - Math.max(seg.start, c.start);
            const critical = exact ?? inside[0] ?? [...candidates].sort((x, y) => overlap(y) - overlap(x) || x.id.localeCompare(y.id))[0];
            if (!critical) { out.push({ ...seg, bucket: rest }); continue; }
            if (!critical.exact) matchedByTime = true;
            const from = Math.max(seg.start, critical.start), to = Math.min(seg.end, critical.end);
            if (from > seg.start) out.push({ ...seg, end: from, bucket: rest });
            out.push(...attribute(critical.id, from, to, depth + 1));
            if (seg.end > to) out.push({ ...seg, start: to, bucket: rest });
        }
        return out;
    };
    const rootActive = lines.get(rootId)?.active ?? null;
    const path = rootActive ? attribute(rootId, rootActive[0], rootActive[1], 0) : [];
    const pathUs = rootActive ? rootActive[1] - rootActive[0] : null;
    const eventsById = new Map(run.loaded.events.map(e => [e.id, e]));
    const spans = new Map(d.derived('spans', run.sessionIds).map(s => [s.id, s]));
    const steps = new Map(d.derived('steps', run.sessionIds).map(s => [s.id, s]));
    const evidenceOf = (ref: string | null): EvidenceRef[] => {
        if (!ref) return [];
        const span = spans.get(ref) ?? spans.get(steps.get(ref)?.llm_span_id);
        const e = span?.first_event ? eventsById.get(span.first_event) : undefined;
        return e ? [evidence(e as Event)] : [];
    };
    const sum = <K extends string>(key: (s: Seg) => K, only: (s: Seg) => boolean = () => true) => {
        const m = new Map<K, number>();
        for (const s of path) if (only(s)) m.set(key(s), (m.get(key(s)) ?? 0) + s.end - s.start);
        return m;
    };
    const share = (us: number) => pathUs ? us / pathUs : null;
    const byClass = sum(s => CLASS_OF[s.bucket]), byBucket = sum(s => s.bucket), bySession = sum(s => s.sessionId);
    const derivedByClass = sum(s => CLASS_OF[s.bucket], s => !s.logged);
    const ranked = [...byClass.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    // The agent-side class leaves out time the run spent waiting outside any turn's work (on people, or idle between turns)
    // and time no interval explains, which is no agent's activity.
    const binding = ranked[0]?.[0] ?? null, agentBinding = ranked.find(([c]) => c !== 'people' && c !== 'idle' && c !== 'unattributed')?.[0] ?? null;
    const largestAttributedClass = ranked.find(([c]) => c !== 'unattributed')?.[0] ?? null;
    // Top contributors (§3.4): tools by target key, model time by step.
    const keyBySpan = new Map<string, Action>();
    for (const a of run.actions) if (a.call?.span_id) keyBySpan.set(a.call.span_id, a);
    // What each segment's interval was (§3.5): a step's model time, a call or other span, or a wait on a child run.
    const delegationById = new Map(recorded.map(r => [r.id as string, r]));
    const describe = (ref: string | null): { refKind: RefKind | null; stepId: string | null; label: string | null } => {
        const step = ref ? steps.get(ref) : undefined;
        if (step) return { refKind: 'step', stepId: step.id, label: oneLine(step.intent ? `Step ${step.n} · ${step.intent}` : `Step ${step.n}`, LABEL_CHARS) };
        if (!ref) return { refKind: null, stepId: null, label: null };
        const action = keyBySpan.get(ref), dl = delegationById.get(ref);
        if (dl) return { refKind: 'child', stepId: dl.parent_step ?? action?.stepId ?? null, label: oneLine(dl.task_excerpt ?? run.sessions.get(dl.child_session)?.title, LABEL_CHARS) };
        return { refKind: 'call', stepId: action?.stepId ?? null, label: action ? actionLabel(action) ?? oneLine(action.object, LABEL_CHARS) : oneLine(spans.get(ref)?.name, LABEL_CHARS) };
    };
    // A key is counted per session, so one target run by the parent and by a subagent is two contributors. `derivedUs`
    // is the part of a contributor's time whose interval is derived rather than logged, as `byClass[*].derivedUs` is;
    // `total` counts every contributor before the top ten.
    const top = (cls: Class, keyOf: (s: Seg) => string | null) => {
        const m = new Map<string, { key: string; sessionId: string; us: number; derivedUs: number; ref: string | null }>();
        for (const s of path) {
            if (CLASS_OF[s.bucket] !== cls) continue;
            const key = keyOf(s);
            if (!key) continue;
            const id = s.sessionId + '\0' + key;
            const v = m.get(id) ?? m.set(id, { key, sessionId: s.sessionId, us: 0, derivedUs: 0, ref: s.ref }).get(id)!;
            v.us += s.end - s.start;
            if (!s.logged) v.derivedUs += s.end - s.start;
        }
        const rows = [...m.values()].sort((x, y) => y.us - x.us).slice(0, 10)
            .map(v => ({ key: v.key, sessionId: v.sessionId, us: v.us, derivedUs: v.derivedUs, share: share(v.us), evidence: evidenceOf(v.ref) }));
        return { rows, total: m.size };
    };
    const tools = top('tools', s => s.ref ? keyBySpan.get(s.ref)?.object ?? spans.get(s.ref)?.name ?? null : null);
    const modelSteps = top('model', s => s.ref && steps.has(s.ref) ? s.ref : null);
    const topTools = tools.rows;
    const topSteps = modelSteps.rows.map(t => {
        const step = steps.get(t.key)!;
        return { ...t, stepN: step.n as number, intent: step.intent ?? null, turnId: step.turn_id ?? null };
    });
    // Work and span (§5, work-span@1).
    const busyOf = new Map<string, number>();
    for (const [sid, line] of lines) busyOf.set(sid, union(line.intervals.filter(iv => BUSY.has(iv.bucket as Bucket)).map(iv => [iv.start, iv.end])));
    const workUs = [...busyOf.values()].reduce((x, y) => x + y, 0);
    const spanUs = pathUs === null ? null : pathUs - (byClass.get('people') ?? 0) - (byClass.get('idle') ?? 0);
    // Rework (§4): each finding's repeated action, and the part of it on the path.
    const pathBySession = new Map<string, [number, number][]>();
    for (const s of path) (pathBySession.get(s.sessionId) ?? pathBySession.set(s.sessionId, []).get(s.sessionId)!).push([s.start, s.end]);
    const onPath = (sid: string, a: number, b: number) => union((pathBySession.get(sid) ?? []).map(([x, y]) => [Math.max(x, a), Math.min(y, b)]));
    const found = rework(run);
    const reworkOf = (list: { sessionId: string; actions: Action[] }[]) => ({
        count: list.length,
        us: list.reduce((n, f) => n + Math.max(0, f.actions[f.actions.length - 1].end - f.actions[f.actions.length - 1].start), 0),
        onPathUs: list.reduce((n, f) => { const a = f.actions[f.actions.length - 1]; return n + onPath(f.sessionId, a.start, a.end); }, 0),
        evidence: list.slice(0, 50).flatMap(f => refs([f.actions[f.actions.length - 1]], 'derived')),
    });
    const loops = found.fixLoops;
    // Collaboration (§5).
    const readsBefore = (sids: string[], path: string, version: number, before: number) => sids.some(sid => (run.bySession.get(sid) ?? []).some(a => a.ts < before && a.files.some(f => f.access === 'read' && f.path === path && f.after === version)));
    const collaboration = delegations.map(dl => {
        const child = dl.child_session as string, act = lines.get(child)?.active ?? null;
        const parentWait = act ? union((lines.get(dl.session_id)?.intervals ?? []).filter(iv => iv.bucket === 'wait-agent').map(iv => [Math.max(iv.start, act[0]), Math.min(iv.end, act[1])])) : null;
        const siblings = delegations.filter(o => o !== dl && o.session_id === dl.session_id);
        const siblingOverlap = act ? union(siblings.flatMap(o => { const s = lines.get(o.child_session)?.active; return s ? [[Math.max(s[0], act[0]), Math.min(s[1], act[1])] as [number, number]] : []; })) : null;
        const earlier = siblings.filter(o => o.start_ts < dl.start_ts).map(o => o.child_session as string);
        const dups = (run.bySession.get(child) ?? []).filter(a => a.files.some(f => f.access === 'read' && readsBefore([dl.session_id, ...earlier], f.path, f.after, a.ts)));
        return {
            id: dl.id, parent: dl.session_id, child, kind: dl.kind, taskExcerpt: dl.task_excerpt ?? null, outcome: dl.outcome ?? null,
            start: act?.[0] ?? dl.start_ts, end: act?.[1] ?? dl.end_ts ?? null,
            busyUs: busyOf.get(child) ?? null, onPathUs: bySession.get(child) ?? 0, parentWaitUs: parentWait, siblingOverlapUs: siblingOverlap,
            duplicateReads: { count: dups.length, evidence: refs(dups, 'derived') },
        };
    });
    // The analysed window is the root's loaded events; the event limit can end it before the session ends (§3.5).
    const own = d.row("SELECT min(ts) AS first, max(ts) AS last FROM events WHERE session_id=? AND (flag_bits & 6)=0 AND ts_src='logged'", rootId);
    const sessionStart: number | null = own?.first ?? null, sessionEnd: number | null = own?.last ?? null;
    const sessionUs = sessionStart === null || sessionEnd === null ? null : sessionEnd - sessionStart;
    const window: PerfWindow = {
        analyzedStartTs: rootActive?.[0] ?? null, analyzedEndTs: rootActive?.[1] ?? null, analyzedUs: pathUs, sessionStartTs: sessionStart, sessionEndTs: sessionEnd, sessionUs,
        share: pathUs !== null && sessionUs ? pathUs / sessionUs : null,
    };
    const partial = sessionStart !== null && sessionEnd !== null && (!rootActive || rootActive[0] > sessionStart || rootActive[1] < sessionEnd);
    // Segments shorter than wallUs/2,000 combine (§3.5); when that still leaves more than the cap, the threshold doubles,
    // which always fits (see coalesce).
    const minUs = pathUs ? pathUs / SEGMENT_CAP : 0;
    let shown = coalesce(path, minUs);
    if (shown.length > SEGMENT_CAP) shown = coalesce(path, 2 * minUs);
    const unattributedShare = share(byClass.get('unattributed') ?? 0);
    const agents = new Set(run.loaded.sessions.map(s => s.agent as string));
    const figures: GapFigures = {
        segmentsTotal: shown.length, agents: [...agents],
        ...(pathUs && unattributedShare !== null ? { unexplained: { us: byClass.get('unattributed') ?? 0, wallUs: pathUs, share: unattributedShare } } : {}),
        ...(sessionUs ? { window: { analyzedUs: pathUs ?? 0, sessionUs, share: (pathUs ?? 0) / sessionUs } } : {}),
    };
    const codes = ['queue-time-not-logged'];
    if (agents.has('claude-code') || agents.has('codex')) codes.push('approvals-not-logged');
    if ([...agents].some(a => a.startsWith('claude')) || agents.has('codex')) codes.push('model-time-not-logged');
    if (matchedByTime) codes.push('child-matched-by-time');
    if (unattributedShare !== null && unattributedShare > 0.25) codes.push('critical-path-mostly-unexplained');
    if (partial) codes.push('critical-path-window-partial');
    const missing = codes.map(code => ({ code, effect: gapText(code, run.loaded.coverage, figures)! }));
    addGaps(run.loaded, ...codes);
    if (shown.length > SEGMENT_CAP) addGaps(run.loaded, 'critical-path-segment-limit');
    const classShare = (c: Class) => share(byClass.get(c) ?? 0);
    // The people sentence names only waits the run's agents log: Claude Code and Codex log no approvals (their wait
    // counts as tool time), so for them it names questions and pauses alone and says so.
    const adviceText = (c: Class) => c === 'people' && codes.includes('approvals-not-logged') ? PEOPLE_UNLOGGED_APPROVALS : ADVICE[c];
    const segment = (s: Shown) => {
        // A combined segment links to its longest part that has evidence.
        const evidence = s.members ? [...s.members].sort((x, y) => (y.end - y.start) - (x.end - x.start)).map(m => evidenceOf(m.ref)).find(e => e.length) ?? [] : evidenceOf(s.ref);
        return {
            sessionId: s.sessionId, bucket: s.bucket, class: s.class, start: s.start, end: s.end, us: s.end - s.start, logged: s.logged,
            ...describe(s.ref), evidence, ...(s.parts ? { parts: s.parts } : {}),
        };
    };
    return {
        ...d.envelope(run.loaded.coverage, figures), sessionId: rootId,
        criticalPath: {
            startTs: rootActive?.[0] ?? null, endTs: rootActive?.[1] ?? null, wallUs: pathUs, window,
            byClass: Object.fromEntries([...byClass].map(([k, v]) => [k, { us: v, share: share(v), derivedUs: derivedByClass.get(k) ?? 0 }])),
            byBucket: Object.fromEntries([...byBucket].map(([k, v]) => [k, { us: v, share: share(v) }])),
            bySession: [...bySession].sort((x, y) => y[1] - x[1]).map(([sessionId, us]) => ({ sessionId, us, share: share(us) })),
            binding, agentBinding, largestAttributedClass, bindingSrc: 'derived:largest-share',
            advice: [...new Set([binding, agentBinding].filter((c): c is Class => !!c))].map(c => ({ class: c, text: adviceText(c) })),
            topTools, topSteps, topToolsTotal: tools.total, topStepsTotal: modelSteps.total,
            segmentsTotal: shown.length,
            segments: shown.slice(0, SEGMENT_CAP).map(segment),
        },
        rework: {
            rereads: reworkOf(found.rereads), reverts: reworkOf(found.reverts), blindRetries: reworkOf(found.blindRetries), repeatedSearches: reworkOf(found.repeatedSearches),
            fixLoops: { count: loops.length, us: loops.reduce((n, l) => n + Math.max(0, l.end - l.start), 0), onPathUs: loops.reduce((n, l) => n + onPath(l.sessionId, l.start, l.end), 0), evidence: loops.slice(0, 50).flatMap(l => refs(l.actions.slice(0, 1), 'derived')) },
        },
        collaboration: { delegations: collaboration, workUs, spanUs, parallelism: spanUs ? workUs / spanUs : null, coordinationUs: byClass.get('coordination') ?? 0 },
        missing,
        summary: {
            wallUs: pathUs, pathUs: path.reduce((n, s) => n + s.end - s.start, 0), modelShare: classShare('model'), toolsShare: classShare('tools'), peopleShare: classShare('people'), idleShare: classShare('idle'),
            coordinationShare: classShare('coordination'), unattributedShare, parallelism: spanUs ? workUs / spanUs : null,
        },
        rules: ['critical-child@1', 'work-span@1', 'reread@1', 'revert@1', 'blind-retry@2', 'repeat-search@1', 'fix-loop@1'],
        caveats: ['The critical path follows the agent loop and recorded waits; unrecorded dependencies are not on it.', 'Rework is repeated or undone work, not necessarily wasted work.', 'Parallelism describes this run; whether more workers help is a comparison between runs.'],
    };
}
