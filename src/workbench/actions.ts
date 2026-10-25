/** Versioned actions (docs/analyses/ACTIONS.md): one normalized action stream per run, with file versions and rework primitives. */
import { homedir } from 'node:os';
import { isCheckRun, targetKey } from '../index/derive/target.ts';
import { QUESTION_TOOLS } from '../index/derive/interventions.ts';
import { WAIT_AGENT_TOOLS, WAIT_PROCESS_TOOLS } from '../index/derive/time.ts';
import { type Data, type Event, type Loaded, type Row, command, digest, evidence, eventText, fileIdentity, isFailure, measured, oneLine, parse } from './data.ts';
import type { Confidence, EvidenceRef } from './types.ts';

export type Op = 'edit' | 'read' | 'search' | 'test' | 'build' | 'typecheck' | 'vcs' | 'install' | 'run' | 'web' | 'mcp' | 'delegate' | 'wait' | 'plan' | 'ask' | 'other';
export type Outcome = 'ok' | 'failed' | 'unknown';
export interface FileTouch {
    path: string;
    display: string;
    access: 'read' | 'write' | 'uncertain';
    /** The `changes` op of a write (`add`, `update`, `delete`, `move`, `write`). */
    change: string | null;
    before: number;
    after: number;
    certain: boolean;
}
export interface Action {
    id: string;
    sessionId: string;
    turnId: string | null;
    stepId: string | null;
    /** Position in run order (§2.1). */
    index: number;
    /** Position within its session. */
    local: number;
    ts: number;
    start: number;
    end: number;
    durSrc: string;
    tool: string | null;
    op: Op;
    key: string;
    object: string;
    files: FileTouch[];
    outcome: Outcome;
    exitCode: number | null;
    inputDigest: string;
    inputTruncated: boolean;
    /** Compactions of the session before this action (§3.3). */
    epoch: number;
    /** Line range of a read, `all` when the whole file. */
    range: string;
    call: Event | null;
    result: Event | null;
}
export interface Run {
    rootId: string;
    sessionIds: string[];
    sessions: Map<string, Row>;
    loaded: Loaded;
    actions: Action[];
    bySession: Map<string, Action[]>;
    /** Every file read, write, uncertain write and external edit of the run, in run order (§3). */
    files: FileEvent[];
    /** Failure-episode attempts of the run's sessions when the index analysed it, else null (§4 blind-retry@2). */
    attempts: Row[] | null;
    display: (path: string, sessionId?: string) => string;
}
export interface FileEvent {
    path: string;
    display: string;
    sessionId: string;
    kind: 'read' | 'write' | 'uncertain' | 'external';
    change: string | null;
    before: number;
    after: number;
    epoch: number;
    action: Action | null;
    event: Event | null;
}
export interface StaleView {
    rule: 'stale-view@1';
    sessionId: string;
    path: string;
    display: string;
    /** `never-read`: the session never read or wrote the file; `changed-elsewhere`: another writer changed it since; `compacted`: known only before a compaction. */
    cause: 'never-read' | 'changed-elsewhere' | 'compacted';
    at: FileEvent;
    known: FileEvent | null;
    /** The writes by others between what the session knew and the version it changed. */
    since: FileEvent[];
}
export interface Finding {
    rule: string;
    sessionId: string;
    confidence: Confidence;
    actions: Action[];
    detail?: string;
}
export interface FixLoop {
    rule: 'fix-loop@1';
    sessionId: string;
    key: string;
    cycles: number;
    resolved: boolean;
    start: number;
    end: number;
    actions: Action[];
}
export interface Rework {
    rereads: Finding[];
    reverts: Finding[];
    blindRetries: Finding[];
    repeatedSearches: Finding[];
    fixLoops: FixLoop[];
    gaps: string[];
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch', 'FileChange']);
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'view_image', 'ImageView']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS']);
const SEARCH_PROGRAMS = /^(?:rg|grep|egrep|fgrep|ag|ack|find|fd|ls|tree|git grep)\b/;
const INSTALL = /^(?:(?:npm|pnpm|yarn|bun) (?:install|add|ci|i)|pip3? install|uv (?:add|sync|pip)|cargo (?:install|add)|brew install|go get|gem install)\b/;
const DELEGATE_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'spawn_agent', 'send_message', 'followup_task']);
const PLAN_TOOLS = new Set(['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'update_plan', 'ExitPlanMode', 'EnterPlanMode']);
const EDIT_OPS = new Set(['add', 'update', 'delete', 'move', 'write']);
const READ_RANGE = /\bsed\s+-n\s+['"]?(\d+)\s*,\s*(\d+)p/;
const HEAD_TAIL = /\b(head|tail)\s+-n?\s*(\d+)/;
const TRUNCATED = /…\[\+\d+\]/;
/** The `cmd` or `command` string of a code-mode script's first `tools.exec_command` or `tools.shell_command` call. */
const SCRIPT_COMMAND = /tools\.(?:exec_command|shell_command)\s*\(\s*\{[^]*?\b(?:cmd|command)\s*:\s*(["'`])((?:\\[^]|(?!\1)[^\\])*)\1/;
/** Ops whose identical failed repeats are blind retries (waits, plans and questions repeat by design). */
const RETRYABLE = new Set<Op>(['edit', 'read', 'search', 'test', 'build', 'typecheck', 'vcs', 'install', 'run', 'web', 'mcp']);

/** `~` for the home folder of this machine and of common home layouts in logs from elsewhere. */
function tilde(path: string): string {
    const home = homedir();
    if (home && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length);
    return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}
function relative(path: string, cwd: string | null | undefined): string | null {
    if (!cwd || !path.startsWith('/')) return null;
    const base = cwd.endsWith('/') ? cwd : cwd + '/';
    return path.startsWith(base) ? path.slice(base.length) : null;
}
function str(v: unknown): string | null { return typeof v === 'string' && v ? v : null; }

/** Merge per-session sequences (each in seq order) by the timestamp at each head, so no session is reordered internally. */
function mergeByTime<T>(lists: T[][], ts: (x: T) => number): T[] {
    const at = lists.map(() => 0), out: T[] = [];
    while (true) {
        let best = -1;
        for (let k = 0; k < lists.length; k++)
            if (at[k] < lists[k].length && (best < 0 || ts(lists[k][at[k]]) < ts(lists[best][at[best]]))) best = k;
        if (best < 0) return out;
        out.push(lists[best][at[best]++]);
    }
}

function opOf(tool: string | null, kind: string | null, key: string, cmd: string, changeOps: Set<string>, parsed: unknown): Op {
    const name = tool ?? '';
    if (EDIT_TOOLS.has(name) || [...changeOps].some(op => EDIT_OPS.has(op))) return 'edit';
    if (READ_TOOLS.has(name) || key.startsWith('read:') || changeOps.has('read')) return 'read';
    const types = Array.isArray(parsed) ? parsed.map(p => p && typeof p === 'object' ? (p as Row).type : null) : [];
    if (SEARCH_TOOLS.has(name) || types.some(t => t === 'search' || t === 'list_files')) return 'search';
    if (key.startsWith('sh:')) {
        const program = key.slice(3);
        for (const check of ['test', 'build', 'typecheck'] as const) if (isCheckRun(check, key, cmd)) return check;
        if (SEARCH_PROGRAMS.test(program)) return 'search';
        if (program.startsWith('git ') || program === 'git') return 'vcs';
        if (INSTALL.test(cmd.replace(/^\s*(?:sudo\s+)?/, '')) || INSTALL.test(program)) return 'install';
        return 'run';
    }
    if (kind === 'web' || key.startsWith('web:')) return 'web';
    if (name.startsWith('mcp__')) return 'mcp';
    if (DELEGATE_TOOLS.has(name)) return 'delegate';
    if (WAIT_AGENT_TOOLS.has(name) && !DELEGATE_TOOLS.has(name) || WAIT_PROCESS_TOOLS.has(name) || /^\s*sleep\s+\d/.test(cmd)) return 'wait';
    if (PLAN_TOOLS.has(name)) return 'plan';
    if (QUESTION_TOOLS.has(name)) return 'ask';
    if (kind === 'shell') return 'run';
    return 'other';
}

function rangeOf(e: Event | null, cmd: string): string {
    const input = e?.a.tool?.input;
    if (input && typeof input === 'object' && (input.offset !== undefined || input.limit !== undefined)) return `${input.offset ?? 0}:${input.limit ?? ''}`;
    const sed = READ_RANGE.exec(cmd);
    if (sed) return `${sed[1]}-${sed[2]}`;
    const ht = HEAD_TAIL.exec(cmd);
    return ht ? `${ht[1]}:${ht[2]}` : 'all';
}

/**
 * Load the run of `rootId` (the session and, unless `children` is false, its descendants) and build its action stream.
 * `limit` bounds the actions per run; `truncated` says whether it cut any, and `pastLimit` counts the cut ones that are
 * not waits, which AgentDiff reports as the gap `action-limit`. Events past the event limit hold actions no count sees.
 * `first` names a session of the run to load before the others, so the event limit never cuts it.
 */
export function loadRun(d: Data, rootId: string, opts: { children?: boolean; limit?: number; first?: string } = {}): Run & { truncated: boolean; pastLimit: number } {
    const tree = opts.children === false ? [d.session(rootId).id] : d.descendants(rootId);
    const sessionIds = opts.first && tree.includes(opts.first) ? [opts.first, ...tree.filter(id => id !== opts.first)] : tree;
    const loaded = d.load(sessionIds);
    const sessions = new Map(loaded.sessions.map(s => [s.id, s]));
    const root = sessions.get(rootId)!;
    const changes = d.derived('changes', sessionIds), failures = d.derived('failures', sessionIds), spans = d.derived('spans', sessionIds);
    const changesByRid = new Map<number, Row[]>();
    for (const c of changes) {
        const list = changesByRid.get(c.rid) ?? [];
        list.push(c);
        changesByRid.set(c.rid, list);
    }
    const tierByRid = new Map(failures.map(f => [f.rid, f.tier]));
    const spanById = new Map(spans.map(s => [s.id, s]));
    const stepByRid = new Map<number, string>();
    if (d.has('step_events'))
        for (const sid of sessionIds)
            for (const r of d.rows('SELECT rid, step_id FROM step_events WHERE session_id=?', sid)) stepByRid.set(r.rid, r.step_id);
    const display = (path: string, sessionId?: string) => {
        const own = sessionId ? sessions.get(sessionId)?.cwd : null;
        return relative(path, own) ?? relative(path, root?.cwd) ?? tilde(path);
    };
    const relKey = (key: string, sessionId: string) => {
        const cwds = [sessions.get(sessionId)?.cwd, root?.cwd].filter((c): c is string => !!c && c.startsWith('/'));
        let out = key;
        for (const cwd of cwds) out = out.split(cwd.endsWith('/') ? cwd : cwd + '/').join('');
        return tilde(out);
    };
    // Pair calls and results per session: by span, then by call id (as linkedResults does).
    type Pair = { call: Event | null; result: Event | null; ts: number };
    const perSession = new Map<string, Pair[]>(sessionIds.map(sid => [sid, []]));
    const bySpan = new Map<string, Pair>(), byCallId = new Map<string, Pair>();
    const epochOf = new Map<number, number>(), compactions = new Map<string, number>();
    const open = (e: Event, pair: Pair) => {
        perSession.get(e.session_id)!.push(pair);
        return pair;
    };
    for (const e of loaded.events) {
        if (!perSession.has(e.session_id)) continue;
        const k = (id: unknown) => typeof id === 'string' ? e.session_id + '\0' + id : null;
        if (e.kind === 'context.compaction') compactions.set(e.session_id, (compactions.get(e.session_id) ?? 0) + 1);
        // Every event knows its session's epoch, so an external edit shown after a compaction counts as new knowledge.
        epochOf.set(e.rid, compactions.get(e.session_id) ?? 0);
        if (e.kind === 'tool.exec') open(e, { call: e, result: e, ts: e.ts });
        else if (e.kind === 'tool.call') {
            const pair = open(e, { call: e, result: null, ts: e.ts });
            if (k(e.span_id)) bySpan.set(k(e.span_id)!, pair);
            if (k(e.a.tool?.call_id)) byCallId.set(k(e.a.tool.call_id)!, pair);
        } else if (e.kind === 'tool.result') {
            const pair = bySpan.get(k(e.span_id) ?? '') ?? byCallId.get(k(e.a.tool?.call_id) ?? '');
            if (!pair) open(e, { call: null, result: e, ts: e.ts });
            else if (!pair.result) pair.result = e;
        }
    }
    const merged = mergeByTime([...perSession.values()], x => x.ts);
    const limit = opts.limit ?? Infinity, truncated = merged.length > limit;
    const classify = ({ call, result }: Pair) => {
        const e = (call ?? result)!;
        const t = e.a.tool ?? {}, rt = result?.a.tool ?? {};
        const tool = e.tool_name ?? result?.tool_name ?? str(t.name) ?? null;
        const cmd = command(e);
        const input = t.input as Row | undefined;
        const cwd = str(input?.workdir) ?? str(t.cwd) ?? sessions.get(e.session_id)?.cwd ?? null;
        const key = targetKey({ tool, kind: (e.tool_kind ?? t.kind ?? null) as never, input: t.input, command: str(t.command), parsedCmd: t.parsed_cmd, server: str(t.server), path: str(t.path), cwd, output: tool === 'apply_patch' ? str(rt.output) : null });
        const rows = changesByRid.get(e.rid) ?? (result && result !== e ? changesByRid.get(result.rid) : undefined) ?? [];
        const op = opOf(tool, e.tool_kind ?? t.kind ?? null, key, cmd, new Set(rows.map(r => r.op)), t.parsed_cmd);
        return { e, t, rt, tool, cmd, cwd, key, rows, op };
    };
    // Actions past the limit are only classified, so a comparison can say how many comparable actions it left out.
    const pastLimit = truncated ? merged.slice(limit).filter(p => classify(p).op !== 'wait').length : 0;
    const actions: Action[] = [];
    for (const pair of merged.slice(0, limit)) {
        const { call, result } = pair;
        const { e, t, rt, tool, cmd, cwd, key, rows, op } = classify(pair);
        const tier = result ? tierByRid.get(result.rid) : undefined;
        const failed = result ? isFailure(result) : null;
        const outcome: Outcome = tier === 'failure' || tier === 'suspect' ? 'failed' : tier === 'benign' ? 'ok' : tier === 'deferred' || !result ? 'unknown' : failed === true ? 'failed' : failed === false ? 'ok' : 'unknown';
        const span = e.span_id ? spanById.get(e.span_id) : undefined;
        const known = span && measured(span.start_ts) !== null && measured(span.end_ts) !== null && span.end_ts >= span.start_ts && ['tool', 'exec'].includes(span.kind);
        const rawInput = t.input ?? (cmd || null);
        const files: FileTouch[] = [];
        const seen = new Set<string>();
        const touch = (path: string, access: FileTouch['access'], change: string | null = null) => {
            const abs = fileIdentity(path, cwd);
            if (!abs || seen.has(abs + access)) return;
            seen.add(abs + access);
            files.push({ path: abs, display: display(abs, e.session_id), access, change, before: 0, after: 0, certain: true });
        };
        for (const r of rows) {
            if (EDIT_OPS.has(r.op)) touch(r.path, 'write', r.op);
            else if (r.op === 'read') touch(r.path, 'read');
            else if (r.op === 'shell-mention') touch(r.path, 'uncertain');
        }
        if (op === 'read' && key.startsWith('read:') && !files.some(f => f.access === 'read')) touch(key.slice(5), 'read');
        const first = files.find(f => f.access === 'write') ?? files.find(f => f.access === 'read');
        const inputDigest = digest(rawInput);
        const object = op === 'edit' && first ? `edit:${first.display}` : op === 'read' && first ? `read:${first.display}` : op === 'search' ? `${relKey(key, e.session_id)}#${inputDigest.slice(0, 12)}` : relKey(key, e.session_id);
        const exit = result?.exit_code ?? (typeof rt.exit_code === 'number' ? rt.exit_code : null);
        actions.push({
            id: e.id, sessionId: e.session_id, turnId: e.turn_id ?? result?.turn_id ?? null, stepId: stepByRid.get(e.rid) ?? (result ? stepByRid.get(result.rid) : undefined) ?? null,
            index: actions.length, local: 0, ts: e.ts, start: known ? span.start_ts : e.ts, end: known ? span.end_ts : (result?.ts ?? e.ts), durSrc: known ? span.dur_src ?? 'unknown' : 'unknown',
            tool, op, key, object, files, outcome, exitCode: exit, inputDigest, inputTruncated: TRUNCATED.test(JSON.stringify(rawInput ?? '')),
            epoch: epochOf.get(e.rid) ?? 0, range: op === 'read' ? rangeOf(call, cmd) : 'all', call, result,
        });
    }
    const files = assignVersions(actions, changes, sessions, new Map(loaded.events.map(e => [e.rid, e])), epochOf, display);
    const bySession = new Map<string, Action[]>();
    for (const a of actions) {
        const list = bySession.get(a.sessionId) ?? [];
        a.local = list.length;
        list.push(a);
        bySession.set(a.sessionId, list);
    }
    if (sessionIds.length > 1) loaded.coverage.gaps = [...new Set([...loaded.coverage.gaps, 'cross-session-order-from-timestamps'])].sort();
    // Repeated failures come from the analysis pass's episodes when it has run, so every view counts them alike.
    const analysed = d.has('session_rollup') && d.has('episode_attempts') && !!d.row('SELECT 1 FROM session_rollup WHERE session_id=?', rootId);
    const attempts = analysed ? sessionIds.flatMap(sid => d.rows('SELECT episode_id, n, rid, change_class, edits, parallel FROM episode_attempts WHERE session_id=? ORDER BY episode_id, n', sid)) : null;
    return { rootId, sessionIds, sessions, loaded, actions, bySession, files, attempts, display, truncated, pastLimit };
}

/** File versions (§3): certain and uncertain writes, plus external edits, in run order. Returns the file timeline. */
function assignVersions(actions: Action[], changes: Row[], sessions: Map<string, Row>, events: Map<number, Event>, epochOf: Map<number, number>, display: Run['display']): FileEvent[] {
    const version = new Map<string, { n: number; certain: boolean }>();
    const external = changes.filter(c => c.op === 'external').flatMap(c => {
        const path = fileIdentity(c.path, sessions.get(c.session_id)?.cwd ?? null), event = events.get(c.rid);
        return path && event ? [{ ts: c.ts as number, path, sessionId: c.session_id as string, event }] : [];
    }).sort((a, b) => a.ts - b.ts);
    const timeline: FileEvent[] = [];
    let x = 0;
    const flush = (until: number) => {
        for (; x < external.length && external[x].ts <= until; x++) {
            const ext = external[x], v = version.get(ext.path) ?? { n: 0, certain: true };
            version.set(ext.path, { n: v.n + 1, certain: true });
            timeline.push({ path: ext.path, display: display(ext.path, ext.sessionId), sessionId: ext.sessionId, kind: 'external', change: null, before: v.n, after: v.n + 1, epoch: epochOf.get(ext.event.rid) ?? 0, action: null, event: ext.event });
        }
    };
    for (const a of actions) {
        flush(a.ts);
        for (const f of a.files) {
            const v = version.get(f.path) ?? { n: 0, certain: true };
            f.before = v.n;
            if (f.access === 'read') {
                f.after = v.n;
                f.certain = v.certain;
            } else {
                const certain = f.access === 'write';
                f.after = v.n + 1;
                f.certain = certain;
                version.set(f.path, { n: v.n + 1, certain });
            }
            timeline.push({ path: f.path, display: f.display, sessionId: a.sessionId, kind: f.access, change: f.change, before: f.before, after: f.after, epoch: a.epoch, action: a, event: a.call ?? a.result });
        }
    }
    flush(Infinity);
    return timeline;
}

/**
 * Stale views (`stale-view@1`, §3.4): a session changed a file (op `update`) without knowing its current version. Knowledge
 * is the version a session last read, wrote, or was shown as an external edit, within its current context epoch. `until`
 * stops the walk at a timeline position; `known` then holds what each session knew at that point.
 */
export function staleViews(run: Run, until = Infinity): { stale: StaleView[]; known: Map<string, Map<string, FileEvent>>; current: Map<string, FileEvent[]> } {
    const known = new Map<string, Map<string, FileEvent>>(), current = new Map<string, FileEvent[]>(), stale: StaleView[] = [];
    run.files.slice(0, until === Infinity ? undefined : until).forEach(fe => {
        const mine = known.get(fe.sessionId) ?? known.set(fe.sessionId, new Map()).get(fe.sessionId)!;
        const k = mine.get(fe.path);
        if (fe.kind === 'write' && fe.change === 'update' && (!k || k.after !== fe.before || k.epoch < fe.epoch)) {
            const since = k ? (current.get(fe.path) ?? []).filter(w => w.after > k.after && w.after <= fe.before) : [];
            stale.push({ rule: 'stale-view@1', sessionId: fe.sessionId, path: fe.path, display: fe.display, cause: !k ? 'never-read' : k.after !== fe.before ? 'changed-elsewhere' : 'compacted', at: fe, known: k ?? null, since });
        }
        mine.set(fe.path, fe);
        if (fe.kind !== 'read') (current.get(fe.path) ?? current.set(fe.path, []).get(fe.path)!).push(fe);
    });
    return { stale, known, current };
}

/** Rework primitives (§4). */
export function rework(run: Run): Rework {
    const out: Rework = { rereads: [], reverts: [], blindRetries: [], repeatedSearches: [], fixLoops: [], gaps: [] };
    const editsByPath = new Map<string, Action[]>();
    for (const [sessionId, list] of run.bySession) {
        const reads = new Map<string, Action>();
        const lastByKey = new Map<string, Action>();
        const searches = new Map<string, Action>();
        let lastEdit = -1, lastShell = -1;
        const loops = new Map<string, { failedAt: Action; edits: number; chain: FixLoop | null }>();
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            // reread@1: same file, version, context epoch and range.
            if (a.op === 'read')
                for (const f of a.files.filter(f => f.access === 'read')) {
                    const k = `${f.path}\0${f.after}\0${a.epoch}\0${a.range}`;
                    const prev = reads.get(k);
                    if (prev && f.certain) out.rereads.push({ rule: 'reread@1', sessionId, confidence: lastShell > prev.local ? 'candidate' : 'derived', actions: [prev, a], detail: f.display });
                    reads.set(k, a);
                }
            // blind-retry@2 without episodes: same key and input, both failed, no edit between.
            const prevKey = lastByKey.get(a.key);
            if (!run.attempts && RETRYABLE.has(a.op) && a.outcome === 'failed' && prevKey?.outcome === 'failed' && prevKey.inputDigest === a.inputDigest && lastEdit < prevKey.local)
                out.blindRetries.push({ rule: 'blind-retry@2', sessionId, confidence: 'derived', actions: [prevKey, a], detail: a.object });
            lastByKey.set(a.key, a);
            // repeat-search@1: same search input with no edit since.
            if (a.op === 'search') {
                const k = `${a.key}\0${a.inputDigest}`, prev = searches.get(k);
                if (prev && lastEdit < prev.local) out.repeatedSearches.push({ rule: 'repeat-search@1', sessionId, confidence: 'derived', actions: [prev, a], detail: a.object });
                searches.set(k, a);
            }
            // fix-loop@1: fail, edits, rerun of the same check key.
            if (a.op === 'test' || a.op === 'build' || a.op === 'typecheck') {
                const state = loops.get(a.key);
                if (state && state.edits > 0 && a.outcome !== 'unknown') {
                    const chain = state.chain ?? { rule: 'fix-loop@1' as const, sessionId, key: a.key, cycles: 0, resolved: false, start: state.failedAt.start, end: a.end, actions: [state.failedAt] };
                    chain.cycles++;
                    chain.end = a.end;
                    chain.actions.push(a);
                    if (!state.chain) out.fixLoops.push(chain);
                    if (a.outcome === 'ok') {
                        chain.resolved = true;
                        loops.delete(a.key);
                    } else loops.set(a.key, { failedAt: a, edits: 0, chain });
                } else if (a.outcome === 'failed') loops.set(a.key, { failedAt: state?.failedAt ?? a, edits: 0, chain: state?.chain ?? null });
                else if (a.outcome === 'ok') loops.delete(a.key);
            }
            if (a.op === 'edit') {
                lastEdit = a.local;
                for (const s of loops.values()) s.edits++;
                for (const f of a.files.filter(f => f.access === 'write')) {
                    const prior = editsByPath.get(f.path) ?? [];
                    const reverted = revertOf(a, prior);
                    if (reverted) out.reverts.push({ rule: 'revert@1', sessionId, confidence: 'derived', actions: [reverted, a], detail: f.display });
                    prior.push(a);
                    editsByPath.set(f.path, prior);
                }
            }
            if (a.op === 'run' || a.op === 'install' || a.op === 'vcs') lastShell = a.local;
            // git checkout -- <file> / git restore <file> after an edit of that file.
            if (a.op === 'vcs' && /\bgit\s+(?:checkout|restore)\b/.test(command(a.call ?? a.result!)))
                for (const f of a.files.filter(f => f.access === 'uncertain')) {
                    const prior = editsByPath.get(f.path);
                    if (prior?.length) out.reverts.push({ rule: 'revert@1', sessionId, confidence: 'candidate', actions: [prior[prior.length - 1], a], detail: f.display });
                }
        }
    }
    if (run.attempts) out.blindRetries = episodeRetries(run);
    if (run.actions.some(a => a.op === 'edit' && a.tool === 'Edit' && a.inputTruncated)) out.gaps.push('edit-inputs-truncated');
    return out;
}

/** blind-retry@2 from failure episodes: an attempt identical to the previous one with no edit between, the condition behind the episode `blind` flag (SPEC §12.3.5). */
function episodeRetries(run: Run): Finding[] {
    const byRid = new Map<number, Action>();
    for (const a of run.actions) for (const e of [a.result, a.call]) if (e) byRid.set(e.rid, a);
    const out: Finding[] = [];
    let prev: Row | null = null;
    for (const at of run.attempts!) {
        if (prev && prev.episode_id === at.episode_id && at.change_class === 'identical' && !at.edits) {
            const x = byRid.get(prev.rid), y = byRid.get(at.rid);
            if (x && y) out.push({ rule: 'blind-retry@2', sessionId: y.sessionId, confidence: 'derived', actions: [x, y], detail: y.object });
        }
        prev = at;
    }
    return out;
}

/** An earlier Edit of the same file whose old and new strings this Edit swaps; both inputs must be complete. */
function revertOf(a: Action, prior: Action[]): Action | null {
    if (a.tool !== 'Edit' || a.inputTruncated) return null;
    const input = a.call?.a.tool?.input;
    if (!input || typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null;
    for (let i = prior.length - 1; i >= 0; i--) {
        const p = prior[i], pi = p.call?.a.tool?.input;
        if (p.tool !== 'Edit' || p.inputTruncated || !pi) continue;
        if (pi.old_string === input.new_string && pi.new_string === input.old_string) return p;
    }
    return null;
}

export function ref(a: Action, confidence: Confidence = 'observed'): EvidenceRef { return evidence((a.call ?? a.result)!, confidence); }
/** At most 120 characters of what an action ran or looked for: a shell command, a search or web tool's query, or a fetched URL. */
export function actionLabel(a: Action): string | null {
    const e = (a.call ?? a.result)!, t = e.a.tool ?? {};
    if (a.tool === 'exec' && (e.tool_kind ?? t.kind) !== 'shell') {
        // A Codex code-mode script: the first command it runs, the one its target key names.
        const m = SCRIPT_COMMAND.exec(typeof t.input === 'string' ? t.input : str(t.input?.code) ?? '');
        return m ? oneLine(m[2].replace(/\\(.)/g, (_, c: string) => c === 'n' ? '\n' : c === 't' ? '\t' : c), 120) : null;
    }
    if (a.key.startsWith('sh:')) return oneLine(command(e), 120);
    if (a.op !== 'search' && a.op !== 'web') return null;
    const input = parse(e.a.tool?.input);
    return oneLine([input.pattern, input.query, input.url, input.path].find(v => typeof v === 'string' && v.trim()), 120);
}
export function refs(actions: Action[], confidence: Confidence = 'observed'): EvidenceRef[] { return actions.slice(0, 50).map(a => ref(a, confidence)); }
/** The action's recorded text (input and output) for text matching; output includes the indexed tail. */
export function actionText(a: Action): string {
    const parts = [a.call ? eventText(a.call) : '', a.result && a.result !== a.call ? eventText(a.result) : '', str(a.result?.a.tool?.output_tail) ?? ''];
    return parts.filter(Boolean).join('\n');
}
export function median(values: number[]): number | null {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function addGaps(loaded: Loaded, ...gaps: string[]): void { loaded.coverage.gaps = [...new Set([...loaded.coverage.gaps, ...gaps])].sort(); }
