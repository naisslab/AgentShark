/** Evidence-backed failure handling, repeated observations and advisory budget policies. No commands run here. */
import { posix } from 'node:path';
import { normalize } from '../replay/compare.ts';
import { type Action, type Run, addGaps, loadRun, median } from './actions.ts';
import { type Data, type Event, digest, evidence, fail, fileIdentity, integer, measured, object, parse, textId, union } from './data.ts';
import type { Confidence, EvidenceRef } from './types.ts';

export interface ReliabilitySpec {
    session: string;
    minRepeats?: number;
    stopAfterRepeats?: number;
    /** Each session's own recorded input + output tokens; descendants have separate counters. */
    tokenBudget?: number;
    timeBudgetUs?: number;
    /** Explicit exemptions for intentional polling or sampling. */
    allowedRepeatTools?: string[];
    /** Reviewer-confirmed exemptions for one tool and its exact recorded input, not every call to that tool. */
    allowedRepeatCalls?: { tool: string; inputDigest: string; outputDigest: string }[];
}
interface HandlingFinding {
    rule: 'timeout-as-empty@1' | 'failed-write-assumed-success@1';
    sessionId: string;
    confidence: 'candidate';
    message: string;
    target: string;
    evidence: EvidenceRef[];
}
interface Repetition {
    rule: 'unchanged-observation@1';
    sessionId: string;
    confidence: 'candidate';
    tool: string | null;
    outcome: Action['outcome'];
    target: string;
    attempts: number;
    evidence: EvidenceRef[];
    measurement: {
        inputDigest: string;
        outputDigest: string;
        state: 'no-observed-change';
        wallUs: number | null;
        toolUs: number | null;
        tokens: number | null;
        usageEvents: number;
        medianTokensPerRepeat: number | null;
        tokenSamples: number;
        medianUsPerRepeat: number | null;
    };
    active: boolean;
}
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'apply_patch', 'FileChange', 'NotebookEdit']);
const REPEAT_OPS = new Set(['edit', 'read', 'search', 'test', 'build', 'typecheck', 'vcs', 'install', 'run', 'web', 'mcp']);
const CUT = /…\[\+\d+\]|<redacted>|\[REDACTED\]|\$omitted|\boutput truncated\b|\btruncated \d+ (?:characters|tokens|lines)\b/i;
const TIMEOUT = /\btimed? out\b|\btimeout(?:expired|error)?\b|超时/i;
const EMPTY = /\b(?:no (?:relevant |matching )?(?:results|matches|papers|documents)|(?:found|returned) (?:no |zero )(?:results|matches|papers|documents)|search returned nothing)\b|(?:未找到|没有找到|未发现)(?:任何)?(?:相关|匹配)?(?:结果|论文|文献|文件)|(?:搜索|查询)(?:结果)?为空/i;
const WRITE_SUCCESS = /\b(?:successfully (?:wrote|written|updated|saved|created|patched)|(?:file|changes?|patch) (?:was |were |has been |have been )?(?:written|updated|saved|applied|created)(?: successfully)?)\b|\b(?:updated|saved|created|wrote|patched)\b|(?:已|成功)(?:写入|保存|更新|创建|修改|应用)/i;
const HEDGE = /\b(?:no|not|never|without|unable|unsuccess\w*|fail\w*|cannot|could not|can['’]?t|couldn['’]?t|does not|did not|didn['’]?t|if|unless|until|would|should|will|must|may|might|perhaps|assum\w*|expect\w*|plan\w*|need\w*|try\w*|tried|attempt\w*|want\w*|claim\w*|say|says|said|example)\b|不|没|未|如果|是否|吗|可能|假设|计划|尝试|需要|声称|例如/i;
const BOUNDARY = new Set(['user.prompt', 'user.inject', 'context.compaction', 'turn.end', 'turn.abort']);

/** Missing, redacted and cut text cannot establish equality. */
function intact(value: unknown): boolean {
    return value !== undefined && value !== null && !CUT.test(JSON.stringify(value));
}
function output(a: Action): string | null {
    const e = a.result, t = e?.a.tool;
    const text = typeof t?.output === 'string' ? t.output : typeof e?.a.text === 'string' ? e.a.text : null;
    if (!e || text === null || (e.flag_bits & 32) || !intact(text) || (t?.output_len ?? 0) > text.length) return null;
    // Codex shell headers carry a new chunk ID and timing on every call. Strip only a recognized header block;
    // progress counters, timestamps and other numbers in the actual output remain significant.
    const lines = normalize(text);
    if (/^(?:Chunk ID: \S+|Wall time:? [\d.]+ seconds?)$/.test(lines[0] ?? '') && ['run', 'test', 'build', 'typecheck', 'read', 'search'].includes(a.op)) {
        const end = lines.indexOf('Output:');
        const header = /^(?:Chunk ID: \S+|Wall time:? [\d.]+ seconds?|Process exited with code -?\d+|Exit code:? -?\d+|Original token count: \d+|)$/;
        if (end > 0 && lines.slice(0, end).every(l => header.test(l))) return lines.slice(end + 1).join('\n');
    }
    return lines.join('\n');
}
function lookup(a: Action): boolean {
    return ['search', 'web'].includes(a.op) || /(?:^|[\s/:_.-])(?:search|query|fetch|find|lookup|browse|curl|wget|read|list|get)(?:$|[\s/:_.-])/i.test(`${a.tool} ${a.key}`);
}
/** Recognize narrow, explicit wait protocols, not arbitrary commands that merely mention sleep or polling. */
function intentionalWait(a: Action): boolean {
    if (a.outcome !== 'ok') return false;
    const t = a.call?.a.tool ?? {}, input = parse(t.input);
    if (a.tool === 'mcp__session_info__read_transcript' && typeof input.session_id === 'string'
        && typeof input.max_wait_seconds === 'number' && input.max_wait_seconds > 0
        && /^Session "[^\n]+": running\r?\n/.test(a.result?.a.tool?.output ?? '')
        && /Call read_transcript again to wait for completion/.test(a.result?.a.tool?.output ?? '')) return true;
    if (t.kind !== 'shell') return false;
    const cmd = input.cmd ?? input.command ?? t.command;
    if (typeof cmd !== 'string') return false;
    if (/^\s*sleep\s+(?:\d+(?:\.\d+)?|\.\d+)[smhd]?\s*;?\s*$/.test(cmd) && parseFloat(cmd.trim().split(/\s+/)[1]) > 0) return true;
    // A bounded loop that only tests a literal file, sleeps, then reads that same file. Substitutions, writes,
    // additional commands and failed waits stay eligible for review.
    const wait = /^\s*for\s+\w+\s+in\s+\$\(\s*seq\s+(?:\d+\s+)?[1-9]\d*\s*\)\s*;\s*do\s+\[\s+-(?:s|e|f)\s+("[^"$`\\\n]+"|'[^'\n]+'|[^\s;&|<>()$`"'\\]+)\s*\]\s*&&\s*break\s*;\s*sleep\s+((?:\d+(?:\.\d+)?|\.\d+)[smhd]?)\s*;\s*done\s*;\s*cat\s+\1\s*;?\s*$/.exec(cmd);
    return !!wait && parseFloat(wait[2]) > 0;
}
function paths(a: Action, run: Run): string[] {
    if (!WRITE_TOOLS.has(a.tool ?? '')) return [];
    const t = a.call?.a.tool ?? {}, p = parse(t.input);
    const values = [t.path, p.file_path, p.path, p.notebook_path, ...a.files.filter(f => f.access === 'write').map(f => f.path)];
    if (a.tool === 'apply_patch' && typeof t.input === 'string') {
        for (const m of t.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) values.push(m[1]);
    }
    return [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v).map(v => fileIdentity(v, run.sessions.get(a.sessionId)?.cwd ?? null)).filter((v): v is string => !!v))];
}
function clauses(e: Event): string[] {
    if (e.kind !== 'llm.text' || typeof e.a.text !== 'string') return [];
    // Quoted examples and code are not the assistant's assertions.
    return e.a.text.replace(/```[^]*?```/g, '').split('\n').filter(l => !/^\s*>/.test(l))
        .flatMap(l => l.split(/(?<=[.!?。！？;；])\s+|(?<=[。！？；])/)).filter(l => l.trim() && !/^\s*['"“‘]/.test(l) && !/[?？]\s*$/.test(l));
}
function handling(run: Run): HandlingFinding[] {
    const out: HandlingFinding[] = [];
    for (const [sid, actions] of run.bySession) {
        const resultOf = new Map(actions.filter(a => a.result).map(a => [a.result!.rid, a]));
        let search: Action | null = null;
        const writes = new Map<string, Action>(), knownWrites = new Set<string>();
        let turn: string | null = null;
        for (const e of run.loaded.events.filter(e => e.session_id === sid)) {
            if (BOUNDARY.has(e.kind) || (turn && e.turn_id && e.turn_id !== turn)) { search = null; writes.clear(); knownWrites.clear(); }
            if (e.turn_id) turn = e.turn_id;
            const a = resultOf.get(e.rid);
            if (a?.call) {
                if (lookup(a)) {
                    if (a.outcome === 'failed' && TIMEOUT.test(a.result?.a.tool?.output ?? a.result?.a.text ?? '')) search = a;
                    else if (a.outcome === 'ok') search = null;
                }
                for (const path of paths(a, run)) {
                    knownWrites.add(path);
                    if (a.outcome === 'failed') writes.set(path, a);
                    else if (a.outcome === 'ok') writes.delete(path);
                }
            }
            for (const clause of clauses(e)) {
                if (search && EMPTY.test(clause) && !HEDGE.test(clause.replace(EMPTY, ''))) {
                    out.push({ rule: 'timeout-as-empty@1', sessionId: sid, confidence: 'candidate',
                        message: 'A lookup timed out, then the assistant asserted an empty result without a successful lookup in between.',
                        target: search.object, evidence: [evidence(search.call!), evidence(search.result!), evidence(e)] });
                    search = null;
                }
                // "No results" needs negation; a successful-write assertion must have none.
                if (!WRITE_SUCCESS.test(clause) || HEDGE.test(clause)) continue;
                // A link's destination names the file. Its short label may name a different, previously failed path.
                const namedText = clause.replace(/\[[^\]\n]*\]\(<?([^\)\n]+?)>?\)/g, '$1');
                for (const [path, failed] of writes) {
                    const base = posix.basename(path);
                    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const mentions = [...namedText.matchAll(new RegExp(`(?:^|[^\\w./-])((?:[\\w.@+-]*\\/)*${escaped})(?=$|[^\\w.-]|\\.(?:\\s|$))`, 'g'))].map(m => m[1]);
                    const ambiguous = [...knownWrites].filter(p => posix.basename(p) === base).length > 1;
                    const named = base.length >= 3 && mentions.some(p => p.includes('/')
                        ? fileIdentity(p, run.sessions.get(sid)?.cwd ?? null) === path : !ambiguous);
                    if (!named) continue;
                    out.push({ rule: 'failed-write-assumed-success@1', sessionId: sid, confidence: 'candidate',
                        message: 'A write failed, then the assistant asserted an update to that file without a successful write in between.',
                        target: run.display(path, sid), evidence: [evidence(failed.call!), evidence(failed.result!), evidence(e)] });
                    writes.delete(path);
                }
            }
        }
    }
    return out;
}

function usage(e: Event): number | null {
    if (e.kind !== 'llm.usage' || e.proto.startsWith('cowork-audit/')) return null;
    const input = measured(e.a.tokens?.input), out = measured(e.a.tokens?.output);
    return input === null || out === null ? null : input + out;
}

function repetitions(run: Run, min: number, allowed: Set<string>, allowedCalls: Set<string>): Repetition[] {
    const out: Repetition[] = [];
    // A write by any agent or an external edit breaks equality, even if it was later reverted.
    const writes = run.files.filter(f => f.kind !== 'read' && f.event).map(f => f.event!.ts).sort((a, b) => a - b);
    const stateAt = (ts: number) => {
        let lo = 0, hi = writes.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (writes[mid] <= ts) lo = mid + 1; else hi = mid; }
        return lo;
    };
    for (const [sid, list] of run.bySession) {
        const events = run.loaded.events.filter(e => e.session_id === sid);
        const byRid = new Map(events.map((e, i) => [e.rid, i]));
        const boundary = new Map<number, number>();
        let epoch = 0, context: string | null = null;
        for (const e of events) {
            if (BOUNDARY.has(e.kind) || (e.kind === 'llm.text' && e.a.llm?.phase === 'final_answer')) epoch++;
            else if (e.kind === 'context.snapshot' || e.kind === 'session.state') {
                const next = digest(e.a);
                if (context !== next) { context = next; epoch++; }
            }
            boundary.set(e.rid, epoch);
        }
        let chain: Action[] = [], fingerprint: string | null = null;
        const close = () => {
            if (chain.length < min) return;
            const first = chain[0], last = chain.at(-1)!;
            const window = events.slice(byRid.get(first.call!.rid)!, byRid.get(last.result!.rid)! + 1);
            const usages = window.filter(e => e.kind === 'llm.usage' && !e.proto.startsWith('cowork-audit/'));
            const totals = usages.map(usage);
            const samples: number[] = [], times: number[] = [];
            for (let i = 1; i < chain.length; i++) {
                const prev = chain[i - 1], a = chain[i];
                const between = events.slice(byRid.get(prev.call!.rid)! + 1, byRid.get(a.call!.rid)! + 1)
                    .filter(e => e.kind === 'llm.usage' && !e.proto.startsWith('cowork-audit/'));
                const ts = between.map(usage);
                if (ts.length && ts.every((n): n is number => n !== null)) samples.push(ts.reduce((s, n) => s + n, 0));
                if (a.call!.ts_src === 'logged' && prev.call!.ts_src === 'logged' && a.start >= prev.start) times.push(a.start - prev.start);
            }
            const timed = chain.every(a => a.durSrc !== 'unknown' && a.end >= a.start);
            const clock = first.call!.ts_src === 'logged' && last.result!.ts_src === 'logged' && last.end >= first.start;
            out.push({ rule: 'unchanged-observation@1', sessionId: sid, confidence: 'candidate', tool: first.tool, outcome: first.outcome, target: first.object,
                attempts: chain.length, evidence: (chain.length > 25 ? [...chain.slice(0, 24), last] : chain).flatMap(a => [evidence(a.call!), evidence(a.result!)]),
                measurement: { inputDigest: first.inputDigest, outputDigest: digest(output(first)), state: 'no-observed-change',
                    wallUs: clock ? last.end - first.start : null, toolUs: timed ? union(chain.map(a => [a.start, a.end])) : null,
                    tokens: totals.length && totals.every((n): n is number => n !== null) ? totals.reduce((s, n) => s + n, 0) : null,
                    usageEvents: usages.length, medianTokensPerRepeat: samples.length >= 2 ? median(samples) : null, tokenSamples: samples.length,
                    medianUsPerRepeat: times.length >= 2 ? median(times) : null },
                active: last === list.at(-1) && boundary.get(last.call!.rid) === boundary.get(events.at(-1)!.rid)
                    && stateAt(last.start) === stateAt(events.at(-1)!.ts) });
        };
        for (const a of list) {
            const input = a.call?.a.tool?.input ?? a.call?.a.tool?.command;
            const text = output(a), prev = chain.at(-1);
            const eligible = a.call && a.result && REPEAT_OPS.has(a.op) && !allowed.has(a.tool ?? '') && a.outcome !== 'unknown'
                && !(a.outcome === 'ok' && allowedCalls.has(`${a.tool}\0${a.inputDigest}\0${digest(text)}`)) && !intentionalWait(a)
                && !(a.call.flag_bits & 32) && !a.inputTruncated && intact(input) && text !== null
                && !/\b(?:process running|still running|session id|polling|pending)\b/i.test(text);
            const key = eligible ? digest([a.tool, a.key, a.call!.a.tool?.cwd, a.inputDigest, text, a.outcome, a.exitCode, stateAt(a.start), boundary.get(a.call!.rid), a.turnId]) : null;
            // Parallel calls are not retries. A result must precede the next call in this session's record.
            const sequential = !prev || !!a.call && byRid.get(prev.result!.rid)! < byRid.get(a.call.rid)!;
            if (key === null || key !== fingerprint || !sequential) { close(); chain = []; }
            if (key !== null) chain.push(a);
            fingerprint = key;
        }
        close();
    }
    return out;
}

export function reliability(d: Data, spec: ReliabilitySpec) {
    object(spec, 'reliability');
    const sessionId = textId(spec.session, 'session');
    const minRepeats = integer(spec.minRepeats, 3, 2, 100, 'minRepeats');
    const stopAfterRepeats = integer(spec.stopAfterRepeats, Math.max(5, minRepeats), minRepeats, 1000, 'stopAfterRepeats');
    const tokenBudget = spec.tokenBudget === undefined ? null : integer(spec.tokenBudget, 0, 1, Number.MAX_SAFE_INTEGER, 'tokenBudget');
    const timeBudgetUs = spec.timeBudgetUs === undefined ? null : integer(spec.timeBudgetUs, 0, 1, Number.MAX_SAFE_INTEGER, 'timeBudgetUs');
    if (spec.allowedRepeatTools !== undefined && (!Array.isArray(spec.allowedRepeatTools) || spec.allowedRepeatTools.length > 100 || spec.allowedRepeatTools.some(t => typeof t !== 'string' || !t.trim() || t.length > 200)))
        fail('allowedRepeatTools must contain at most 100 nonempty tool names of at most 200 characters');
    if (spec.allowedRepeatCalls !== undefined && (!Array.isArray(spec.allowedRepeatCalls) || spec.allowedRepeatCalls.length > 100 || spec.allowedRepeatCalls.some(c => !c || typeof c !== 'object'
        || typeof c.tool !== 'string' || !c.tool.trim() || c.tool.length > 200 || typeof c.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(c.inputDigest)
        || typeof c.outputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(c.outputDigest))))
        fail('allowedRepeatCalls must contain at most 100 tool names and lowercase SHA-256 input and output digests');
    const run = loadRun(d, sessionId);
    const handlingAll = handling(run), repetitionsAll = repetitions(run, minRepeats, new Set(spec.allowedRepeatTools ?? []),
        new Set((spec.allowedRepeatCalls ?? []).map(c => `${c.tool}\0${c.inputDigest}\0${c.outputDigest}`)));
    const failureHandling = handlingAll.slice(0, 200), noProgress = repetitionsAll.slice(0, 200);
    if (handlingAll.length > 200 || repetitionsAll.length > 200) addGaps(run.loaded, 'reliability-finding-limit');
    addGaps(run.loaded, 'shell-changes-invisible', 'reliability-semantic-rules-limited', 'environment-state-not-captured');
    const decisions = run.sessionIds.map(sid => {
        const s = run.sessions.get(sid)!, events = run.loaded.events.filter(e => e.session_id === sid);
        const last = events.at(-1);
        const input = measured(s.tok_in), output = measured(s.tok_out);
        const usedTokens = input === null || output === null ? null : input + output;
        const knownTokens = (input ?? 0) + (output ?? 0);
        const usedUs = last?.ts_src === 'logged' && measured(s.start_ts) !== null && last.ts >= s.start_ts ? last.ts - s.start_ts : null;
        const remainingTokens = tokenBudget === null || usedTokens === null ? null : Math.max(0, tokenBudget - usedTokens);
        const remainingUs = timeBudgetUs === null || usedUs === null ? null : Math.max(0, timeBudgetUs - usedUs);
        const repeated = repetitionsAll.find(r => r.sessionId === sid && r.active);
        const perToken = repeated?.measurement.medianTokensPerRepeat ?? null, perTime = repeated?.measurement.medianUsPerRepeat ?? null;
        const tokenForecast = remainingTokens === null || perToken === null || perToken <= 0 ? null : Math.floor(remainingTokens / perToken);
        const timeForecast = remainingUs === null || perTime === null || perTime <= 0 ? null : Math.floor(remainingUs / perTime);
        const budget = { scope: 'session-own-counters', tokenBudget, usedTokens, knownTokens, remainingTokens, timeBudgetUs, usedUs, remainingUs,
            forecast: { rule: 'recent-repeat-rate@1', confidence: (tokenForecast === null && timeForecast === null ? 'unknown' : 'candidate') as Confidence,
                repeatsWithinTokenBudget: tokenForecast, repeatsWithinTimeBudget: timeForecast,
                tokenSamples: repeated?.measurement.tokenSamples ?? 0,
                basis: 'Median consumption between repeated calls; this estimates repetitions affordable at that rate, not work needed to finish.' } };
        const compromised = run.loaded.coverage.truncated || run.loaded.coverage.gaps.some(g => ['capture-integrity-failed', 'capture-incomplete', 'capture-evidence-redacted', 'event-payload-missing', 'invalid-or-empty-event-payload'].includes(g));
        let decision = 'no-trigger', confidence: Confidence = 'derived', reason = 'No configured policy threshold was observed.';
        if (compromised) { decision = 'unknown'; confidence = 'unknown'; reason = 'Incomplete or untrusted evidence prevents a current stopping recommendation.'; }
        else if ((tokenBudget !== null && knownTokens >= tokenBudget) || (remainingUs === 0)) {
            decision = 'stop'; reason = 'A configured budget is exhausted by recorded consumption.';
        } else if (repeated) {
            decision = repeated.attempts >= stopAfterRepeats ? 'stop' : 'change-strategy'; confidence = 'candidate';
            reason = repeated.attempts >= stopAfterRepeats ? 'The latest repeated observation reached the configured stopping limit; review intentional repetition before acting.' : 'The latest calls repeat complete inputs and outputs without an observed state change; inspect the cause or change strategy.';
        } else if (handlingAll.some(f => f.sessionId === sid)) {
            decision = 'review'; confidence = 'candidate'; reason = 'A failure-handling claim needs review against its tool result.';
        } else if ((tokenBudget !== null && usedTokens === null) || (timeBudgetUs !== null && usedUs === null)) {
            decision = 'unknown'; confidence = 'unknown'; reason = 'The configured budget cannot be evaluated because consumption is missing.';
        }
        const budgetEvidence = events.filter(e => usage(e) !== null).slice(-10).map(e => evidence(e));
        return { sessionId: sid, decision, confidence, reason, evidence: decision === 'stop' && confidence === 'derived' ? budgetEvidence : repeated?.evidence ?? (last ? [evidence(last)] : []), budget };
    });
    return { ...d.envelope(run.loaded.coverage), sessionId,
        policy: { minRepeats, stopAfterRepeats, tokenBudget, timeBudgetUs, allowedRepeatTools: spec.allowedRepeatTools ?? [], allowedRepeatCalls: spec.allowedRepeatCalls ?? [], advisoryOnly: true },
        summary: { failureHandlingCandidates: handlingAll.length, repeatedObservationChains: repetitionsAll.length, stopRecommendations: decisions.filter(d => d.decision === 'stop').length },
        failureHandling, noProgress, decisions,
        caveats: ['Findings are candidates, not proof that an agent misunderstood a result or wasted work.',
            'Identical indexed observations establish no observed change; external services and shell side effects may change unrecorded state.',
            'Failure-handling rules recognize explicit English and Chinese assertions within one turn; implicit assumptions and unrecognized wording remain outside coverage.',
            'Budgets apply separately to each session and include recorded input and output tokens. Forecasts require at least two complete repeat intervals.',
            'Stopping decisions are advisory. AgentShark never interrupts a running agent.'] };
}
