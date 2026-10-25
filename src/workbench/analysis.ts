import { Data, type Event, type Row, type Loaded, WorkbenchInputError, canonical, command, digest, evidence, eventText, fail, fileIdentity, ids, integer, isFailure, measured, object, parse, target, textId, union } from './data.ts';
import type { ChecksSpec, CompareSpec, ContextOptions, Coverage, EvidenceRef, SearchSpec, SequencePredicate } from './types.ts';
import { isCheckRun, targetKey } from '../index/derive/target.ts';
import { type FileEvent, loadRun, staleViews } from './actions.ts';
const EDITS = new Set(['add', 'update', 'delete', 'move', 'write', 'external']);
const CONTEXT_KINDS = new Set(['user.prompt', 'user.inject', 'llm.text', 'tool.call', 'tool.result', 'agent.message', 'context.attachment', 'context.compaction', 'context.snapshot']);
function bySession(events: Event[]): Map<string, Event[]> {
    const out = new Map<string, Event[]>();
    for (const e of events) {
        const list = out.get(e.session_id) ?? [];
        list.push(e);
        out.set(e.session_id, list);
    }
    return out;
}
function addGap(coverage: Coverage, gap: string): void {
    if (!coverage.gaps.includes(gap))
        coverage.gaps.push(gap);
}
function boundedText(e: Event, limit = 1800): string { return eventText(e).slice(0, limit); }
function linkedResults(events: Event[]): Map<string, Event> {
    const results = new Map<string, Event>(), bySpan = new Map<string, Event>(), byId = new Map<string, Event>();
    for (const e of events) {
        if (e.kind === 'tool.call') {
            if (e.span_id)
                bySpan.set(e.span_id, e);
            if (typeof e.a.tool?.call_id === 'string')
                byId.set(e.a.tool.call_id, e);
        }
        else if (e.kind === 'tool.result') {
            const call = (e.span_id ? bySpan.get(e.span_id) : undefined) ?? (typeof e.a.tool?.call_id === 'string' ? byId.get(e.a.tool.call_id) : undefined);
            if (call && !results.has(call.id))
                results.set(call.id, e);
        }
    }
    return results;
}
/** Shell tools whose calls can run a test; the claim check's `shellish` (src/index/derive/failures.ts). */
const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell_command', 'mcp__workspace__bash']);
/**
 * A test run by `check-run@1` (SPEC §12.3.8), on the calls the claim check considers: a shell call, or a Codex code-mode
 * `exec_command` item. `cd app && npm test` runs a test; `echo "npm test"` and a code-mode script (its items are the runs) do not.
 */
function testCommand(e: Event): string | null {
    const kind = e.tool_kind ?? e.a.tool?.kind;
    const shell = e.kind === 'tool.exec' ? e.tool_name === 'exec_command' || kind === 'shell' : e.kind === 'tool.call' && (kind === 'shell' || SHELL_TOOLS.has(e.tool_name ?? ''));
    const input = shell ? command(e).trim() : '', t = e.a.tool ?? {};
    if (!input)
        return null;
    const key = targetKey({ tool: e.tool_name, kind: (e.tool_kind ?? t.kind ?? null) as never, input: t.input, command: typeof t.command === 'string' ? t.command : null, parsedCmd: t.parsed_cmd });
    return isCheckRun('test', key, input) ? input : null;
}
/** A result that leaves a process running (a background launch, a Codex "Process running" result); the run's outcome is its exit. */
function opensProcess(r: Event): boolean {
    const t = r.a.tool ?? {};
    return typeof t.background_task_id === 'string' || /^running \(session \d+\)/.test(String(t.status ?? '')) || /Process running with session ID \d+|Command running in background/.test(String(t.output ?? '').slice(0, 300));
}
/**
 * Files that another writer changed after the session last read or wrote them, at a boundary event (`stale-view@1`,
 * docs/analyses/ACTIONS.md §3.4); with no boundary, at the session's own last event. The widest tree the caller may see is
 * read (a sibling or parent agent may be that writer), with the inspected session loaded first so the event limit never cuts it.
 */
function staleAt(d: Data, sessionId: string, at: Event | null) {
    let top = sessionId;
    for (let p = d.session(sessionId).parent_id as string | null; p; p = d.row('SELECT parent_id FROM sessions WHERE id=?', p)?.parent_id ?? null) {
        try { d.assertAllowed(p); }
        catch (e) {
            if (!(e instanceof WorkbenchInputError)) throw e;
            break;
        }
        top = p;
    }
    const run = loadRun(d, top, { first: sessionId });
    const gaps = ['shell-changes-invisible'];
    if (run.sessionIds.length > 1) gaps.push('cross-session-order-from-timestamps');
    if (run.truncated || run.loaded.coverage.truncated) gaps.push('stale-view-tree-truncated');
    if (d.session(top).parent_id) gaps.push('stale-view-scope-limited');
    const mark = at ?? run.loaded.events.filter(e => e.session_id === sessionId).at(-1) ?? null;
    // An inspected event is a boundary the session acts at; with no boundary, the session's own last event is still known.
    const after = (fe: FileEvent) => !!fe.event && !!mark && (fe.sessionId === sessionId ? (at ? fe.event.seq >= mark.seq : fe.event.seq > mark.seq) : (at ? fe.event.ts >= mark.ts : fe.event.ts > mark.ts));
    const until = run.files.findIndex(after);
    const { known, current } = staleViews(run, until < 0 ? Infinity : until);
    const candidates = [...(known.get(sessionId) ?? [])].flatMap(([path, k]) => {
        const since = (current.get(path) ?? []).filter(w => w.after > k.after);
        return since.length ? [{ path, display: k.display, confidence: 'candidate' as const, rule: 'stale-view@1', reason: 'Another writer changed the file after this session last read or wrote it; messages or unseen reads may have refreshed its context.', evidence: [k.event, ...since.map(w => w.event)].filter((e): e is Event => !!e).slice(0, 50).map(e => evidence(e, 'candidate')) }] : [];
    });
    return { candidates, gaps };
}
function completed(events: Event[]): boolean {
    const lastEnd = events.findLastIndex(e => e.kind === 'turn.end');
    return lastEnd >= 0 && !events.slice(lastEnd + 1).some(e => ['turn.start', 'turn.abort', 'tool.call', 'tool.exec', 'agent.spawn', 'user.prompt', 'llm.text'].includes(e.kind));
}
function evidenceClean(c: Coverage): boolean { return !c.truncated && !c.gaps.some(g => !['logs-do-not-establish-complete-execution', 'cross-source-order-reconstructed'].includes(g)); }
/** Compare recorded semantics without treating execution IDs or measurements as behavioral content.
 * Strip only known metadata fields at their documented location. In particular, IDs inside tool input or
 * agent prompts remain content: those IDs can select different files, issues, or other task targets.
 */
function comparisonContent(event: Event): { payload: string | null; summary: string | null; truncated: boolean } {
    const omitted: Record<string, ReadonlySet<string>> = {
        tool: new Set(['call_id', 'parent_call_id', 'proc_id', 'reported_wall_ms']),
        llm: new Set(['message_id', 'request_id', 'response_id', 'block_index', 'thinking_ms', 'ttft_ms', 'latency_ms']),
        agent: new Set(['id', 'link_session']),
        turn: new Set(['id', 'index']),
    };
    const attrs: Row = Object.create(null);
    let comparable = false;
    for (const [key, value] of Object.entries(event.a)) {
        if (['tokens', 'cost', 'text_len'].includes(key) || value === undefined || value === null) continue;
        if (Object.hasOwn(omitted, key) && typeof value === 'object' && !Array.isArray(value)) {
            const fields = Object.entries(value).filter(([field, content]) => !omitted[key].has(field) && content !== undefined && content !== null);
            if (!fields.length) continue;
            attrs[key] = Object.fromEntries(fields);
            // A tool's name and category are alignment anchors; they do not establish its input or result.
            if (key !== 'tool' || fields.some(([field]) => !['name', 'kind', 'server'].includes(field))) comparable = true;
        } else {
            attrs[key] = value;
            if (typeof value !== 'object' || Object.keys(value).length > 0) comparable = true;
        }
    }
    if (event.exit_code !== null && event.exit_code !== undefined) { attrs.exitCode = event.exit_code; comparable = true; }
    const tool = event.a.tool;
    const truncated = !!(event.flag_bits & 32)
        || typeof event.a.text_len === 'number' && typeof event.a.text === 'string' && event.a.text_len > event.a.text.length
        || typeof tool?.output_len === 'number' && typeof tool?.output === 'string' && tool.output_len > tool.output.length;
    const summary = event.summary.trim();
    return { payload: comparable ? canonical(attrs) : null, summary: summary && summary !== event.kind ? summary : null, truncated };
}
export class Analysis {
    readonly data: Data;
    constructor(data: Data) { this.data = data; }
    context(sessionId: string, options: ContextOptions = {}) {
        object(options, 'context options');
        const d = this.data, loaded = d.load([textId(sessionId)]), events = loaded.events;
        const limit = integer(options.limit, 100, 1, 500, 'context limit');
        if (options.stepId !== undefined && options.atEventId !== undefined)
            fail('choose atEventId or stepId, not both');
        let boundary = events.length, at: Event | undefined;
        if (options.atEventId !== undefined) {
            at = events.find(e => e.id === textId(options.atEventId, 'atEventId'));
            if (!at)
                fail('atEventId is not in the selected session or loaded event window');
            boundary = events.indexOf(at!);
        }
        if (options.stepId !== undefined) {
            textId(options.stepId, 'stepId');
            const step = d.has('step_events') ? d.row('SELECT e.id FROM step_events se JOIN events e ON e.rid=se.rid WHERE se.step_id=? AND se.session_id=? ORDER BY e.seq,e.rid LIMIT 1', options.stepId, sessionId) : undefined;
            if (!step)
                fail('stepId is not in the selected session');
            at = events.find(e => e.id === step!.id);
            if (!at)
                fail('stepId is outside the loaded event window');
            boundary = events.indexOf(at!);
        }
        const prior = events.slice(0, boundary);
        const compaction = [...prior].reverse().find(e => e.kind === 'context.compaction');
        const compactionAt = compaction ? prior.indexOf(compaction) : -1;
        const relevant = prior.filter(e => CONTEXT_KINDS.has(e.kind));
        const selected = relevant.slice(-limit);
        if (relevant.length > selected.length) {
            loaded.coverage.truncated = true;
            addGap(loaded.coverage, 'context-item-limit');
        }
        addGap(loaded.coverage, 'exact-model-request-payload-unavailable');
        const items = selected.map(e => ({ kind: e.kind, excerpt: boundedText(e), evidence: evidence(e),
            visibility: e.kind.startsWith('context.') ? 'recorded-context-record' as const : 'reconstructed-from-transcript' as const,
            beforeLastCompaction: compactionAt >= 0 && prior.indexOf(e) < compactionAt, inclusionInNextRequest: 'unknown' as const }));
        const stale = staleAt(d, sessionId, at ?? null), staleReadCandidates = stale.candidates;
        stale.gaps.forEach(g => addGap(loaded.coverage, g));
        return { ...d.envelope(loaded.coverage), sessionId, boundary: at ? evidence(at) : null,
            visibility: 'reconstruction' as const, exactPromptAvailable: false, recorded: items.filter(i => i.visibility === 'recorded-context-record'),
            reconstructed: items.filter(i => i.visibility === 'reconstructed-from-transcript'), compaction: compaction ? evidence(compaction) : null,
            staleReadCandidates, caveats: ['A logged record does not establish inclusion in a model request.', 'Compaction summaries do not establish which earlier details were retained.'] };
    }
    compare(spec: CompareSpec) {
        object(spec, 'compare');
        const d = this.data;
        const limit = integer(spec.limit, 800, 1, 1500, 'compare limit');
        const left = d.load([textId(spec.left, 'left')]), right = d.load([textId(spec.right, 'right')]);
        const useful = (e: Event) => !['llm.usage', 'session.meta', 'session.state', 'harness.status'].includes(e.kind);
        const ls = left.events.filter(useful), rs = right.events.filter(useful);
        const a = ls.slice(0, limit), b = rs.slice(0, limit);
        const key = (e: Event) => `${e.kind}\0${e.tool_name ?? ''}`;
        const count = (xs: Event[]) => {
            const m = new Map<string, number>();
            for (const e of xs)
                m.set(key(e), (m.get(key(e)) ?? 0) + 1);
            return m;
        };
        const lc = count(a), rc = count(b);
        const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
        for (let i = a.length - 1; i >= 0; i--)
            for (let j = b.length - 1; j >= 0; j--)
                dp[i][j] = key(a[i]) === key(b[j]) ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
        const semantic = new Map([...a, ...b].map(e => [e, comparisonContent(e)]));
        const alignment: {
            status: 'unchanged' | 'changed' | 'unknown' | 'left-only' | 'right-only';
            confidence: 'derived' | 'candidate' | 'unknown';
            comparisonBasis?: 'normalized-attributes' | 'summary-only' | 'missing-content' | 'truncated-content';
            left: EvidenceRef | null;
            right: EvidenceRef | null;
            leftExcerpt: string | null;
            rightExcerpt: string | null;
            ambiguous: boolean;
        }[] = [];
        let i = 0, j = 0;
        while (i < a.length || j < b.length) {
            if (i < a.length && j < b.length && key(a[i]) === key(b[j])) {
                const x = a[i++], y = b[j++], ambiguous = (lc.get(key(x)) ?? 0) > 1 || (rc.get(key(y)) ?? 0) > 1;
                const leftContent = semantic.get(x)!, rightContent = semantic.get(y)!;
                let status: 'unchanged' | 'changed' | 'unknown' = 'unknown';
                let comparisonBasis: 'normalized-attributes' | 'summary-only' | 'missing-content' | 'truncated-content' = 'missing-content';
                if (leftContent.payload !== null && rightContent.payload !== null) {
                    status = leftContent.payload === rightContent.payload ? 'unchanged' : 'changed';
                    comparisonBasis = 'normalized-attributes';
                    if (status === 'unchanged' && (leftContent.truncated || rightContent.truncated)) {
                        status = 'unknown'; comparisonBasis = 'truncated-content';
                    }
                } else if (leftContent.payload === null && rightContent.payload === null && leftContent.summary !== null && rightContent.summary !== null) {
                    // Different summaries establish a displayed-record difference. Matching lossy summaries cannot prove equality.
                    status = leftContent.summary !== rightContent.summary ? 'changed' : 'unknown';
                    comparisonBasis = 'summary-only';
                }
                alignment.push({ status, comparisonBasis, confidence: status === 'unknown' ? 'unknown' : ambiguous || comparisonBasis === 'summary-only' ? 'candidate' : 'derived', left: evidence(x), right: evidence(y), leftExcerpt: boundedText(x, 400), rightExcerpt: boundedText(y, 400), ambiguous });
            }
            else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1])) {
                const x = a[i++];
                alignment.push({ status: 'left-only', confidence: 'candidate', left: evidence(x), right: null, leftExcerpt: boundedText(x, 400), rightExcerpt: null, ambiguous: true });
            }
            else {
                const y = b[j++];
                alignment.push({ status: 'right-only', confidence: 'candidate', left: null, right: evidence(y), leftExcerpt: null, rightExcerpt: boundedText(y, 400), ambiguous: true });
            }
        }
        const coverage: Coverage = { ...left.coverage, sessionIds: [spec.left, spec.right], eventsAvailable: left.coverage.eventsAvailable + right.coverage.eventsAvailable, eventsExamined: left.coverage.eventsExamined + right.coverage.eventsExamined, truncated: left.coverage.truncated || right.coverage.truncated || ls.length > a.length || rs.length > b.length, gaps: [...new Set([...left.coverage.gaps, ...right.coverage.gaps, 'alignment-is-structural-not-causal'])] };
        if (ls.length > a.length || rs.length > b.length)
            addGap(coverage, 'alignment-event-limit');
        if (alignment.some(row => row.status === 'unknown')) addGap(coverage, 'comparison-content-unavailable-or-incomplete');
        const metrics = ['tok_in', 'tok_out', 'cost_usd'] as const;
        return { ...d.envelope(coverage), left: spec.left, right: spec.right, method: 'ordered-structural-lcs@1', comparisonRule: 'normalized-record-content@2', alignment,
            metrics: metrics.map(metric => { const l = measured(left.sessions[0][metric]), r = measured(right.sessions[0][metric]); return { metric, left: l, right: r, delta: l === null || r === null ? null : r - l }; }),
            summary: { unchanged: alignment.filter(r => r.status === 'unchanged').length, unknown: alignment.filter(r => r.status === 'unknown').length, changed: alignment.filter(r => r.status === 'changed').length, unmatched: alignment.filter(r => r.status.endsWith('-only')).length, ambiguous: alignment.filter(r => r.ambiguous).length },
            caveats: ['Alignment uses event kind and tool name; repeated actions can have several valid alignments.', 'An unmatched region is not evidence that behavior never occurred.', 'This comparison does not establish matched tasks or equivalent initial environments.', 'Unchanged means equal comparable indexed attributes after known execution identifiers and timing/token/cost measurements are excluded. Matching summaries or absent content produce unknown.'] };
    }
    verification(sessionId: string) {
        const d = this.data, loaded = d.load([textId(sessionId)]), events = loaded.events, positions = new Map(events.map((e, i) => [e.rid, i]));
        const changes = d.derived('changes', [sessionId]).filter(c => EDITS.has(c.op) && positions.has(c.rid)).sort((a, b) => positions.get(a.rid)! - positions.get(b.rid)!);
        const resultByCall = linkedResults(events), eventsByRid = new Map(events.map(e => [e.rid, e]));
        const nextWriteByKey = new Map<string, Row>(), lastWriteByPath = new Map<string, Row>();
        for (let i = changes.length - 1; i >= 0; i--) {
            const c = changes[i], next = lastWriteByPath.get(c.path);
            if (next)
                nextWriteByKey.set(c.rid + '\0' + c.path, next);
            lastWriteByPath.set(c.path, c);
        }
        // A run's outcome as the claim check reads it: failure tiers first (a piped `pytest | tail` fails through tests-failed@2),
        // and a background launch takes its process's exit, never the launch notice.
        const tiers = new Map(d.derived('failures', [sessionId]).map(f => [f.rid, f.tier]));
        // Every event of a process (the launch call, its result, polls) links to it, as the claim check's processOf does.
        const exits = new Map(d.has('process_events') ? d.rows('SELECT pe.rid, p.exit_code FROM process_events pe JOIN processes p ON p.id = pe.process_id WHERE pe.session_id=?', sessionId).map(p => [p.rid, p.exit_code]) : []);
        const outcomeOf = (r: Event | undefined): 'passed' | 'failed' | 'unknown' => {
            if (!r)
                return 'unknown';
            const tier = tiers.get(r.rid);
            if (tier === 'failure' || tier === 'suspect')
                return 'failed';
            if (tier === 'deferred' || exits.has(r.rid) || opensProcess(r)) {
                const exit = exits.get(r.rid);
                return exit === undefined || exit === null ? 'unknown' : exit === 0 ? 'passed' : 'failed';
            }
            const status = isFailure(r);
            return status === true ? 'failed' : status === false ? 'passed' : 'unknown';
        };
        const runs = events.flatMap(e => {
            const cmd = testCommand(e);
            if (!cmd)
                return [];
            const r = e.kind === 'tool.exec' ? e : resultByCall.get(e.id);
            return [{ id: e.id, command: cmd, start: positions.get(e.rid)!, end: r ? positions.get(r.rid)! : null, outcome: outcomeOf(r), evidence: [evidence(e), ...(r && r !== e ? [evidence(r)] : [])] }];
        });
        const links = changes.map(c => {
            const e = eventsByRid.get(c.rid)!;
            const p = positions.get(c.rid)!;
            const latest = runs.at(-1), next = latest && latest.start > p ? latest : undefined;
            const nextWrite = nextWriteByKey.get(c.rid + '\0' + c.path);
            const superseded = nextWrite && (!next || positions.get(nextWrite.rid)! < next.start);
            return { path: c.path, operation: c.op, change: evidence(e), status: superseded ? 'superseded-before-check' as const : !next ? 'no-later-check-observed' as const : next.outcome === 'passed' ? 'later-check-passed' as const : next.outcome === 'failed' ? 'later-check-failed' as const : 'check-outcome-unknown' as const, verification: next ?? null, fileCoverage: 'unknown' as const, confidence: 'candidate' as const };
        });
        addGap(loaded.coverage, 'test-command-recognition-is-conservative');
        addGap(loaded.coverage, 'file-level-test-coverage-unavailable');
        return { ...d.envelope(loaded.coverage), sessionId, checks: runs, changes: links, summary: { changes: links.length, laterCheckPassed: links.filter(l => l.status === 'later-check-passed').length, unverified: links.filter(l => l.status !== 'later-check-passed').length }, caveats: ['Temporal association does not establish that a test exercised a changed file.', 'Shell edits, compound shell commands, and custom test runners may be missing.', 'A successful command exit is not a task-correctness judgment.'] };
    }
    checks(spec: ChecksSpec = {}) {
        object(spec, 'checks');
        const d = this.data, loaded = d.load(ids(spec.sessions));
        const requested = spec.rules ?? ['tests-after-edit', 'unresolved-delegations', 'repeated-failed-actions', 'token-budget'];
        if (!Array.isArray(requested) || requested.length > 20)
            fail('rules must contain at most 20 checks');
        const rules = requested.map(r => typeof r === 'string' ? { rule: r } : r);
        const names = new Set(['tests-after-edit', 'unresolved-delegations', 'repeated-failed-actions', 'token-budget']);
        for (const r of rules) {
            object(r, 'rule');
            if (!names.has(r.rule))
                fail('unsupported check rule');
            if (r.threshold !== undefined)
                integer(r.threshold, 0, 1, Number.MAX_SAFE_INTEGER, 'threshold');
        }
        const results: {
            sessionId: string;
            rule: string;
            status: 'pass' | 'fail' | 'unknown';
            reason: string;
            evidence: EvidenceRef[];
            details?: unknown;
        }[] = [];
        for (const s of loaded.sessions) {
            const events = loaded.events.filter(e => e.session_id === s.id);
            const resultByCall = linkedResults(events);
            for (const r of rules) {
                if (r.rule === 'tests-after-edit') {
                    const v = this.verification(s.id);
                    const changed = v.changes.filter(c => c.status !== 'superseded-before-check');
                    const failed = changed.filter(c => c.status === 'later-check-failed');
                    const status = failed.length ? 'fail' : changed.length && changed.every(c => c.status === 'later-check-passed') && evidenceClean(loaded.coverage) && completed(events) ? 'pass' : 'unknown';
                    results.push({ sessionId: s.id, rule: r.rule, status, reason: status === 'pass' ? 'All selected edits have a later recognized successful test command; file coverage remains unknown.' : status === 'fail' ? 'A recognized test command after an edit failed.' : 'No conclusive successful verification was recorded for every edit, or no edits were recorded.', evidence: changed.map(c => c.change), details: v.summary });
                }
                else if (r.rule === 'unresolved-delegations') {
                    const rows = d.derived('delegations', [s.id]);
                    const failures = rows.filter(x => ['failed', 'blocked', 'killed'].includes(x.outcome));
                    const unresolved = rows.filter(x => ['unknown', 'running'].includes(x.outcome) || x.parent_told === null);
                    const refs = rows.flatMap(x => { const e = events.find(e => e.rid === x.result_rid); return e ? [evidence(e)] : []; });
                    results.push({ sessionId: s.id, rule: r.rule, status: failures.length ? 'fail' : unresolved.length || !evidenceClean(loaded.coverage) || !completed(events) ? 'unknown' : 'pass', reason: failures.length ? 'A delegation has a recorded unsuccessful outcome.' : unresolved.length ? 'A delegation is running or its completion/result delivery is unrecorded.' : 'No unresolved delegation appears in the indexed delegation records.', evidence: refs, details: { total: rows.length, unsuccessful: failures.length, unresolved: unresolved.length } });
                }
                else if (r.rule === 'repeated-failed-actions') {
                    const threshold = integer(r.threshold, 3, 2, 100, 'repeat threshold');
                    // On an analysed index the rule reads failure episodes (SPEC §12.3.5), as the blind-loop alarm and the Lens do.
                    if (d.has('session_rollup') && d.has('episode_attempts') && d.row('SELECT 1 FROM session_rollup WHERE session_id=?', s.id)) {
                        const byRid = new Map(events.map(e => [e.rid, e]));
                        const matches: { count: number; key: string; evidence: EvidenceRef[] }[] = [];
                        let streak: Row[] = [];
                        const close = () => { if (streak.length >= threshold) matches.push({ count: streak.length, key: streak[0].episode_id, evidence: streak.flatMap(x => byRid.has(x.rid) ? [evidence(byRid.get(x.rid)!)] : []) }); };
                        for (const at of d.rows('SELECT episode_id, n, rid, change_class, edits, parallel FROM episode_attempts WHERE session_id=? ORDER BY episode_id, n', s.id)) {
                            if (streak.length && streak[streak.length - 1].episode_id === at.episode_id && at.change_class === 'identical' && !at.edits) streak.push(at);
                            else { close(); streak = [at]; }
                        }
                        close();
                        results.push({ sessionId: s.id, rule: r.rule, status: matches.length ? 'fail' : evidenceClean(loaded.coverage) && completed(events) ? 'pass' : 'unknown', reason: matches.length ? 'A failure episode has consecutive identical attempts with no edit between them.' : 'No failure episode repeats an identical attempt the threshold number of times.', evidence: matches.flatMap(m => m.evidence), details: { threshold, matches, source: 'episodes' } });
                        continue;
                    }
                    const streaks: {
                        count: number;
                        key: string;
                        evidence: EvidenceRef[];
                    }[] = [];
                    let streak: {
                        count: number;
                        key: string;
                        evidence: EvidenceRef[];
                    } | null = null;
                    for (const e of events) {
                        if (!['tool.call', 'tool.exec'].includes(e.kind))
                            continue;
                        const result = e.kind === 'tool.exec' ? e : resultByCall.get(e.id);
                        const failed = result ? isFailure(result) : null;
                        const key = digest({ tool: e.tool_name, input: e.a.tool?.input, command: command(e) });
                        if (failed !== true || (!command(e) && e.a.tool?.input == null)) {
                            streak = null;
                            continue;
                        }
                        const previous = streak as {
                            count: number;
                            key: string;
                            evidence: EvidenceRef[];
                        } | null;
                        if (previous && previous.key === key) {
                            previous.count++;
                            previous.evidence.push(evidence(result!));
                        }
                        else {
                            streak = { count: 1, key, evidence: [evidence(result!)] };
                            streaks.push(streak);
                        }
                    }
                    const matches = streaks.filter(s => s.count >= threshold);
                    results.push({ sessionId: s.id, rule: r.rule, status: matches.length ? 'fail' : evidenceClean(loaded.coverage) && completed(events) ? 'pass' : 'unknown', reason: matches.length ? 'Consecutive calls with identical indexed inputs have explicit failure results.' : 'No qualifying consecutive failure streak was found in the examined events.', evidence: matches.flatMap(m => m.evidence), details: { threshold, matches } });
                }
                else {
                    const threshold = r.threshold;
                    const input = measured(s.tok_in), output = measured(s.tok_out);
                    const known = (input ?? 0) + (output ?? 0), missing = input === null || output === null;
                    results.push({ sessionId: s.id, rule: r.rule, status: threshold === undefined ? 'unknown' : known > threshold ? 'fail' : missing || !evidenceClean(loaded.coverage) || !completed(events) ? 'unknown' : 'pass', reason: threshold === undefined ? 'Provide a token-budget threshold.' : known > threshold ? 'Recorded session input plus output tokens exceed the threshold.' : missing || !evidenceClean(loaded.coverage) || !completed(events) ? 'Token counters, source coverage, or completed-turn evidence are incomplete.' : 'Recorded session input plus output tokens are within the threshold.', evidence: events.filter(e => e.kind === 'llm.usage').slice(0, 100).map(e => evidence(e)), details: { threshold: threshold ?? null, input, output, knownTokens: known, scope: 'session-own-tokens' } });
                }
            }
        }
        return { ...d.envelope(loaded.coverage), results, summary: { pass: results.filter(r => r.status === 'pass').length, fail: results.filter(r => r.status === 'fail').length, unknown: results.filter(r => r.status === 'unknown').length }, caveats: ['Checks describe indexed evidence; pass does not establish task success.', 'Absent verification or delivery evidence produces unknown.'] };
    }
    search(spec: SearchSpec) {
        object(spec, 'search');
        const d = this.data, loaded = d.load(ids(spec.sessions));
        if (!Array.isArray(spec.sequence) || !spec.sequence.length || spec.sequence.length > 20)
            fail('sequence must contain 1 to 20 predicates');
        const limit = integer(spec.limit, 100, 1, 1000, 'search limit');
        const within = spec.withinUs === undefined ? undefined : integer(spec.withinUs, 0, 0, Number.MAX_SAFE_INTEGER, 'withinUs');
        const maxGap = spec.maxGapEvents === undefined ? undefined : integer(spec.maxGapEvents, 0, 0, 50000, 'maxGapEvents');
        const sequence: SequencePredicate[] = [];
        for (const p of spec.sequence) {
            object(p, 'sequence predicate');
            const accepted = new Set(['kind', 'tool', 'textIncludes', 'exitCode', 'failure', 'repeat', 'sameAsPrevious']);
            for (const key of Object.keys(p))
                if (!accepted.has(key))
                    fail(`unsupported sequence predicate: ${key}`);
            if (p.kind !== undefined) {
                const kinds = Array.isArray(p.kind) ? p.kind : [p.kind];
                if (!kinds.length || kinds.length > 30)
                    fail('kind requires 1 to 30 kinds');
                kinds.forEach(k => textId(k, 'kind'));
            }
            if (p.tool !== undefined)
                textId(p.tool, 'tool');
            if (p.textIncludes !== undefined)
                textId(p.textIncludes, 'textIncludes');
            if (p.failure !== undefined && typeof p.failure !== 'boolean')
                fail('failure must be boolean');
            if (p.exitCode !== undefined && !Number.isSafeInteger(p.exitCode))
                fail('exitCode must be an integer');
            if (p.sameAsPrevious !== undefined && (!Array.isArray(p.sameAsPrevious) || p.sameAsPrevious.length > 2 || p.sameAsPrevious.some(x => !['tool', 'target'].includes(x))))
                fail('sameAsPrevious supports tool and target');
            const repeat = integer(p.repeat, 1, 1, 32, 'repeat');
            for (let i = 0; i < repeat; i++)
                sequence.push(p);
        }
        if (sequence.length > 64)
            fail('expanded sequence exceeds 64 events');
        if (sequence[0].sameAsPrevious?.length)
            fail('the first predicate cannot use sameAsPrevious');
        const matches: {
            sessionId: string;
            evidence: EvidenceRef[];
            durationUs: number | null;
            confidence: 'derived';
        }[] = [];
        const uncertainMatches: {
            sessionId: string;
            evidence: EvidenceRef[];
            reason: string;
        }[] = [];
        let operations = 0, exhausted = false;
        // A tool result often omits the tool name and input. Resolve them only through recorded call IDs or spans.
        const identities = new Map<string, {
            tool: string | null;
            target: string | null;
        }>();
        for (const events of bySession(loaded.events).values()) {
            const callsBySpan = new Map<string, Event>(), callsById = new Map<string, Event>();
            for (const e of events) {
                const call = e.kind === 'tool.result' ? (e.span_id ? callsBySpan.get(e.span_id) : undefined) ?? (typeof e.a.tool?.call_id === 'string' ? callsById.get(e.a.tool.call_id) : undefined) : undefined;
                identities.set(e.id, { tool: e.tool_name ?? call?.tool_name ?? null, target: target(e) ?? (call ? target(call) : null) });
                if (e.kind === 'tool.call') {
                    if (e.span_id)
                        callsBySpan.set(e.span_id, e);
                    if (typeof e.a.tool?.call_id === 'string')
                        callsById.set(e.a.tool.call_id, e);
                }
            }
        }
        const matchesPredicate = (e: Event, p: SequencePredicate, previous?: Event) => {
            if (p.kind !== undefined && !(Array.isArray(p.kind) ? p.kind : [p.kind]).includes(e.kind))
                return false;
            if (p.tool !== undefined && p.tool !== identities.get(e.id)?.tool)
                return false;
            if (p.textIncludes !== undefined && !eventText(e).toLowerCase().includes(p.textIncludes.toLowerCase()))
                return false;
            if (p.exitCode !== undefined && e.exit_code !== p.exitCode)
                return false;
            if (p.failure !== undefined && isFailure(e) !== p.failure)
                return false;
            for (const field of p.sameAsPrevious ?? []) {
                const x = identities.get(e.id)?.[field], y = previous ? identities.get(previous.id)?.[field] : null;
                if (!x || !y || x !== y)
                    return false;
            }
            return true;
        };
        for (const [sessionId, events] of bySession(loaded.events)) {
            for (let start = 0; start < events.length; start++) {
                if (matches.length + uncertainMatches.length >= limit || exhausted)
                    break;
                if (!matchesPredicate(events[start], sequence[0]))
                    continue;
                const find = (path: number[], q: number): number[] | null => {
                    if (q === sequence.length)
                        return path;
                    const prev = path[path.length - 1];
                    const end = maxGap === undefined ? events.length : Math.min(events.length, prev + maxGap + 2);
                    for (let i = prev + 1; i < end; i++) {
                        if (++operations > 1000000) {
                            exhausted = true;
                            return null;
                        }
                        const e = events[i], first = events[path[0]];
                        if (within !== undefined && first.ts_src === 'logged' && e.ts_src === 'logged' && e.ts >= first.ts && e.ts - first.ts > within)
                            continue;
                        if (!matchesPredicate(e, sequence[q], events[prev]))
                            continue;
                        const found = find([...path, i], q + 1);
                        if (found)
                            return found;
                        if (exhausted)
                            return null;
                    }
                    return null;
                };
                const found = find([start], 1);
                if (!found)
                    continue;
                const selected = found.map(i => events[i]);
                const temporalKnown = selected.every(e => e.ts_src === 'logged') && selected.every((e, i) => i === 0 || e.ts >= selected[i - 1].ts);
                const refs = selected.map(e => evidence(e));
                if (within !== undefined && !temporalKnown)
                    uncertainMatches.push({ sessionId, evidence: refs, reason: 'The event sequence matches, but its time window cannot be verified from logged timestamps.' });
                else
                    matches.push({ sessionId, evidence: refs, durationUs: temporalKnown ? selected[selected.length - 1].ts - selected[0].ts : null, confidence: 'derived' });
            }
        }
        if (exhausted) {
            loaded.coverage.truncated = true;
            addGap(loaded.coverage, 'search-state-limit');
        }
        if (matches.length + uncertainMatches.length >= limit) {
            loaded.coverage.truncated = true;
            addGap(loaded.coverage, 'search-match-limit');
        }
        return { ...d.envelope(loaded.coverage), matches, uncertainMatches, semantics: { ordering: 'source-order-with-timestamp-merge', repetition: 'distinct-events', maxGapEvents: maxGap ?? null, withinUs: within ?? null, matching: 'first-valid-match-per-start' }, examinedStates: operations };
    }
    coordination(sessionId: string) {
        const d = this.data, sessionIds = d.descendants(textId(sessionId)), loaded = d.load(sessionIds), events = new Map(loaded.events.map(e => [e.rid, e]));
        const sessions = new Map(loaded.sessions.map(s => [s.id, s])), spans = d.derived('spans', sessionIds), spanById = new Map(spans.map(s => [s.id, s]));
        const changes = d.derived('changes', sessionIds).filter(c => events.has(c.rid) && ['read', ...EDITS].includes(c.op));
        const activity: (Row & {
            identity: string | null;
            start: number;
            end: number;
            intervalKnown: boolean;
            event: Event;
        })[] = changes.map(c => {
            const e = events.get(c.rid)!;
            const span = e.span_id ? spanById.get(e.span_id) : null;
            const valid = span && measured(span.start_ts) !== null && measured(span.end_ts) !== null && span.end_ts >= span.start_ts;
            return { ...c, identity: fileIdentity(c.path, sessions.get(c.session_id)?.cwd ?? null), start: valid ? span.start_ts : e.ts, end: valid ? span.end_ts : e.ts, intervalKnown: !!valid, event: e };
        });
        if (activity.some(a => a.identity === null))
            addGap(loaded.coverage, 'relative-file-path-without-working-directory');
        const groups = new Map<string, typeof activity>();
        for (const a of activity) {
            if (!a.identity)
                continue;
            const list = groups.get(a.identity) ?? [];
            list.push(a);
            groups.set(a.identity, list);
        }
        const overlaps: {
            path: string;
            sessions: string[];
            operations: string[];
            overlapUs: number;
            evidence: EvidenceRef[];
            confidence: 'candidate';
        }[] = [];
        const versioned = loadRun(d, sessionId);
        addGap(loaded.coverage, 'shell-changes-invisible');
        if (versioned.sessionIds.length > 1)
            addGap(loaded.coverage, 'cross-session-order-from-timestamps');
        const staleReads = staleViews(versioned).stale.filter(v => v.cause === 'changed-elsewhere').slice(0, 500).map(v => {
            const writer = v.since.find(w => w.sessionId !== v.sessionId) ?? v.since[0];
            return { path: v.path, readerSession: v.sessionId, writerSession: writer?.kind === 'external' ? 'external' : writer?.sessionId ?? null, evidence: [v.known?.event, ...v.since.map(w => w.event), v.at.event].filter((e): e is Event => !!e).slice(0, 50).map(e => evidence(e)), confidence: 'candidate' as const, rule: v.rule, reason: 'This session changed the file after another writer changed it, without reading it again; messages or unseen reads may have refreshed its context.' };
        });
        let pairOperations = 0;
        const budget = 500000;
        groupLoop: for (const [path, rows] of groups) {
            rows.sort((a, b) => a.start - b.start || a.event.id.localeCompare(b.event.id));
            for (let i = 0; i < rows.length; i++)
                for (let j = i + 1; j < rows.length; j++) {
                    if (++pairOperations > budget)
                        break groupLoop;
                    const a = rows[i], b = rows[j];
                    if (overlaps.length >= 500)
                        break;
                    if (b.start > a.end)
                        break;
                    if (a.session_id === b.session_id || a.op === 'read' && b.op === 'read' || !a.intervalKnown || !b.intervalKnown)
                        continue;
                    const overlapUs = Math.min(a.end, b.end) - Math.max(a.start, b.start);
                    if (overlapUs > 0)
                        overlaps.push({ path, sessions: [a.session_id, b.session_id], operations: [a.op, b.op], overlapUs, evidence: [evidence(a.event), evidence(b.event)], confidence: 'candidate' });
                }
        }
        if (pairOperations > budget) {
            loaded.coverage.truncated = true;
            addGap(loaded.coverage, 'coordination-comparison-limit');
        }
        const delegations = d.derived('delegations', sessionIds).map(row => ({ id: row.id, parentSession: row.session_id, childSession: row.child_session && sessions.has(row.child_session) ? row.child_session : null, outcome: row.outcome, parentSawResult: row.parent_told === null ? null : !!row.parent_told, startTs: row.start_ts, endTs: row.end_ts, evidence: events.has(row.result_rid) ? [evidence(events.get(row.result_rid)!)] : [] }));
        if (overlaps.length >= 500 || staleReads.length >= 500) {
            loaded.coverage.truncated = true;
            addGap(loaded.coverage, 'coordination-finding-limit');
        }
        return { ...d.envelope(loaded.coverage), sessionId, delegations, overlaps, staleReads, summary: { sessions: sessionIds.length, delegations: delegations.length, overlappingFileActivities: overlaps.length, staleReadCandidates: staleReads.length }, caveats: ['Overlapping tool intervals do not establish simultaneous filesystem writes or a conflict.', 'Path identity uses recorded working directories; symlinks and isolated hosts are not resolved.', 'A stale-read candidate does not prove that the agent used stale content.'] };
    }
    profile(sessionId: string) {
        const d = this.data, sessionIds = d.descendants(textId(sessionId)), loaded = d.load(sessionIds), events = new Map(loaded.events.map(e => [e.id, e]));
        const spans = d.derived('spans', sessionIds).filter(s => !s.inherited && !['session', 'turn'].includes(s.kind));
        const known = spans.filter(s => measured(s.start_ts) !== null && measured(s.end_ts) !== null && s.end_ts >= s.start_ts);
        const idsKnown = new Set(known.map(s => s.id)), knownById = new Map(known.map(s => [s.id, s])), spanById = new Map(spans.map(s => [s.id, s]));
        const containing = spans.flatMap(s => s.parent_id && spanById.has(s.parent_id) ? [{ parent: s.parent_id, child: s.id, relation: 'containment' as const }] : []);
        const dependencyEdges: {
            from: string;
            to: string;
            source: 'recorded-attribute';
        }[] = [];
        const invalidDependencies: {
            from: string;
            to: string;
            reason: string;
        }[] = [];
        for (const s of spans) {
            const attrs = parse(s.attrs), dep = attrs.dependencies ?? attrs.depends_on;
            if (dep === undefined)
                continue;
            if (!Array.isArray(dep)) {
                addGap(loaded.coverage, 'invalid-dependency-attribute');
                continue;
            }
            if (dep.length > 100) {
                loaded.coverage.truncated = true;
                addGap(loaded.coverage, 'dependency-edge-limit');
            }
            if (dependencyEdges.length + invalidDependencies.length >= 100000) {
                loaded.coverage.truncated = true;
                addGap(loaded.coverage, 'dependency-edge-limit');
                break;
            }
            for (const from of [...new Set(dep.slice(0, 100))]) {
                if (typeof from !== 'string')
                    continue;
                const p = knownById.get(from);
                if (!p || !idsKnown.has(s.id)) {
                    invalidDependencies.push({ from: spanById.has(from) ? from : 'outside-analysis-scope', to: s.id, reason: 'dependency endpoint or duration unavailable' });
                    continue;
                }
                if (p.end_ts > s.start_ts) {
                    invalidDependencies.push({ from, to: s.id, reason: 'dependency conflicts with recorded time ordering' });
                    continue;
                }
                dependencyEdges.push({ from, to: s.id, source: 'recorded-attribute' });
            }
        }
        const costs = new Map(known.map(s => [s.id, s.end_ts - s.start_ts]));
        const score = new Map<string, number>(costs), predecessor = new Map<string, string>(), indegree = new Map(known.map(s => [s.id, 0])), outgoing = new Map<string, string[]>();
        for (const edge of dependencyEdges) {
            indegree.set(edge.to, indegree.get(edge.to)! + 1);
            const list = outgoing.get(edge.from) ?? [];
            list.push(edge.to);
            outgoing.set(edge.from, list);
        }
        const queue = known.filter(s => indegree.get(s.id) === 0).map(s => s.id).sort();
        for (let i = 0; i < queue.length; i++)
            for (const next of outgoing.get(queue[i]) ?? []) {
                const candidate = score.get(queue[i])! + costs.get(next)!;
                if (candidate > score.get(next)!) {
                    score.set(next, candidate);
                    predecessor.set(next, queue[i]);
                }
                indegree.set(next, indegree.get(next)! - 1);
                if (indegree.get(next) === 0)
                    queue.push(next);
            }
        const cycle = queue.length < known.length;
        const longest = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
        const longestPath: string[] = [];
        if (!cycle && longest)
            for (let id: string | undefined = longest[0]; id; id = predecessor.get(id))
                longestPath.push(id);
        longestPath.reverse();
        const bounds = loaded.events.filter(e => e.ts_src === 'logged').map(e => e.ts);
        const start = bounds.length ? Math.min(...bounds) : null, end = bounds.length ? Math.max(...bounds) : null;
        const wallUs = start === null || end === null ? null : end - start;
        const intervals = known.map(s => [s.start_ts, s.end_ts] as [
            number,
            number
        ]);
        const activeUs = union(intervals);
        const categories = [...new Set(spans.map(s => s.kind))].sort().map(kind => { const selected = known.filter(s => s.kind === kind); return { kind, spans: spans.filter(s => s.kind === kind).length, knownDurations: selected.length, unionUs: union(selected.map(s => [s.start_ts, s.end_ts])), sumUs: selected.reduce((n, s) => n + s.end_ts - s.start_ts, 0) }; });
        if (spans.length !== known.length)
            addGap(loaded.coverage, 'missing-or-invalid-span-durations');
        if (!dependencyEdges.length)
            addGap(loaded.coverage, 'dependency-edges-unavailable');
        if (cycle)
            addGap(loaded.coverage, 'dependency-cycle');
        return { ...d.envelope(loaded.coverage), sessionId, wallUs, activeUnionUs: activeUs, unattributedUs: wallUs === null ? null : Math.max(0, wallUs - union(intervals.map(([a, b]) => [Math.max(a, start!), Math.min(b, end!)]))), categories,
            spans: spans.map(s => ({ id: s.id, sessionId: s.session_id, kind: s.kind, name: s.name, startTs: s.start_ts, endTs: s.end_ts, durationUs: costs.get(s.id) ?? null, durationSource: s.dur_src, evidence: [s.first_event, s.last_event].filter((id, index, all) => id && all.indexOf(id) === index && events.has(id)).map(id => evidence(events.get(id)!)) })),
            containmentEdges: containing, dependencyEdges, invalidDependencies,
            criticalPath: { status: cycle ? 'unknown' as const : dependencyEdges.length ? 'partial' as const : 'unknown' as const, observedDependencyPathUs: cycle || !dependencyEdges.length ? null : longest?.[1] ?? null, spanIds: cycle || !dependencyEdges.length ? [] : longestPath, complete: false },
            caveats: ['Containment and timestamp order do not establish dependencies.', 'Category durations can overlap and must not be summed as wall time.', 'Unattributed time is not automatically model thinking or idle time.', 'The critical path covers only explicit dependencies recorded in span attributes.'] };
    }
}
