/** Cache Anatomy (docs/analyses/CACHE.md): prompt-cache reuse per model request, where it broke and why. */
import { addGaps, median } from './actions.ts';
import { type Data, type Event, type Row, evidence, integer, object, textId } from './data.ts';
import type { Confidence, EvidenceRef } from './types.ts';

export interface CacheSpec {
    session: string;
    idleMinutes?: number;
    limit?: number;
}
interface Request {
    eventId: string;
    ts: number;
    start: number;
    model: string | null;
    input: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    uncached: number | null;
    carried: number | null;
    missed: number | null;
    break: boolean;
    coldStart: boolean;
    inheritedRead: number | null;
    cause: string | null;
    causeSrc: string | null;
    confidence: Confidence | null;
    contributing: string[];
    latencyMs: number | null;
    evidence: EvidenceRef[];
}
const LOGGED: Record<string, string> = {
    system_changed: 'system-changed', tools_changed: 'tools-changed', model_changed: 'model-changed', messages_changed: 'messages-changed',
    previous_message_not_found: 'previous-request-not-found', unavailable: 'unavailable',
};
/** Claude attachments that change the request prefix (tools, instructions, the system prompt). */
const CLAUDE_PREFIX = new Set(['deferred_tools_delta', 'mcp_instructions_delta', 'agent_listing_delta', 'skill_listing', 'prompt_snapshot']);
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

export function cache(d: Data, spec: CacheSpec) {
    object(spec, 'cache');
    const rootId = textId(spec.session, 'session');
    const idleUs = integer(spec.idleMinutes, 5, 1, 120, 'idleMinutes') * 60_000_000;
    const limit = integer(spec.limit, 2000, 1, 5000, 'cache limit');
    const sessionIds = d.descendants(rootId), loaded = d.load(sessionIds);
    const spans = new Map(d.derived('spans', sessionIds).map(s => [s.id, s]));
    const wanted = loaded.events.filter(e => (e.kind === 'llm.usage' && e.proto.startsWith('claude/')) || e.proto === 'codex/turn_context');
    const natives = d.natives(wanted.map(e => e.rid));
    const bySession = new Map<string, Event[]>();
    for (const e of loaded.events) (bySession.get(e.session_id) ?? bySession.set(e.session_id, []).get(e.session_id)!).push(e);
    const sessions: Row[] = [];
    const all: (Request & { sessionId: string })[] = [];
    let codex = false, claude = false, unlogged = false, cut = false;
    for (const sid of sessionIds) {
        const events = bySession.get(sid) ?? [];
        const requests: Request[] = [];
        let prev: Request | null = null, prevOneHour = false;
        let model: string | null = null, settings: string | null = null;
        let compaction: Event | null = null, context: Event | null = null, modelEvent: Event | null = null;
        for (const e of events) {
            if (e.kind === 'context.compaction') compaction ??= e;
            else if ((e.kind === 'context.attachment' || e.kind === 'context.snapshot') && (CLAUDE_PREFIX.has(e.a.context?.type) || e.proto === 'codex/world_state')) context ??= e;
            else if (e.proto === 'codex/turn_context') {
                const p = natives.get(e.rid)?.payload ?? {};
                const next = JSON.stringify([p.effort ?? null, p.approval_policy ?? null, p.sandbox_policy?.type ?? null]);
                if (settings !== null && next !== settings) context ??= e;
                settings = next;
                if (typeof p.model === 'string' && p.model !== model) {
                    if (model !== null) modelEvent ??= e;
                    model = p.model;
                }
            } else if (e.kind === 'llm.usage' && !e.proto.startsWith('cowork-audit/') && e.a.tokens) {
                const t = e.a.tokens, n = natives.get(e.rid) ?? {};
                const reqModel = e.proto.startsWith('claude/') ? (e.a.llm?.model ?? e.model ?? null) : model;
                const reason = n.message?.diagnostics?.cache_miss_reason;
                const span = e.span_id ? spans.get(e.span_id) : undefined;
                const r: Request = {
                    eventId: e.id, ts: e.ts, start: num(span?.start_ts) ?? e.ts, model: reqModel, input: num(t.input), cacheRead: num(t.cache_read), cacheWrite: e.proto.startsWith('claude/') ? num(t.cache_write) : null,
                    uncached: num(t.uncached), carried: null, missed: null, break: false, coldStart: !prev, inheritedRead: null, cause: null, causeSrc: null, confidence: null,
                    contributing: [], latencyMs: num(e.a.llm?.latency_ms), evidence: [evidence(e)],
                };
                if (r.input === null) unlogged = true;
                if (!prev) r.inheritedRead = r.cacheRead;
                else {
                    r.carried = e.proto.startsWith('claude/') ? (prev.cacheRead === null && prev.cacheWrite === null ? null : (prev.cacheRead ?? 0) + (prev.cacheWrite ?? 0)) : prev.input;
                    const loggedMissed = num(reason?.cache_missed_input_tokens);
                    r.missed = loggedMissed ?? (r.carried === null || r.cacheRead === null ? null : Math.max(0, r.carried - r.cacheRead));
                    r.break = !!reason?.type || (r.missed !== null && r.carried !== null && r.missed > Math.max(1024, 0.05 * r.carried));
                    if (r.break) {
                        // Causes in order (§4); later matches are contributing.
                        const causes: [string, string, Confidence, Event | null][] = [];
                        if (reason?.type) causes.push([LOGGED[reason.type] ?? String(reason.type).replace(/_/g, '-'), 'logged:cache_miss_reason', 'observed', e]);
                        if (compaction) causes.push(['compaction', 'derived', 'derived', compaction]);
                        if (prev.model && r.model && prev.model !== r.model) causes.push(['model-changed', 'derived', 'derived', modelEvent ?? e]);
                        const ttl = e.proto.startsWith('claude/') && prevOneHour ? 3_600_000_000 : idleUs;
                        if (r.start - prev.ts > ttl) causes.push(['idle-expiry', 'inferred:cache-ttl@1', 'candidate', e]);
                        if (context) causes.push(['context-changed', 'inferred:cache-context-change@1', 'candidate', context]);
                        const [first, ...rest] = causes;
                        if (first) {
                            [r.cause, r.causeSrc, r.confidence] = first;
                            if (first[3] && first[3] !== e) r.evidence.push(evidence(first[3]));
                            r.contributing = [...new Set(rest.map(c => c[0]).filter(c => c !== first[0]))];
                        } else [r.cause, r.causeSrc, r.confidence] = ['unknown', null, 'unknown'];
                    }
                }
                if (e.proto.startsWith('claude/')) claude = true;
                else codex = true;
                requests.push(r);
                prev = r;
                prevOneHour = (num(n.message?.usage?.cache_creation?.ephemeral_1h_input_tokens) ?? 0) > 0;
                compaction = context = modelEvent = null;
            }
        }
        if (!requests.length) continue;
        const total = (k: 'input' | 'cacheRead' | 'cacheWrite' | 'uncached' | 'missed') => {
            const known = requests.map(r => r[k]).filter((v): v is number => v !== null);
            return known.length ? known.reduce((x, y) => x + y, 0) : null;
        };
        const input = total('input'), cacheRead = total('cacheRead');
        if (requests.length > limit) cut = true;
        sessions.push({
            sessionId: sid, agent: loaded.sessions.find(s => s.id === sid)?.agent ?? null, requests: requests.length, coldStarts: requests.filter(r => r.coldStart).length, breaks: requests.filter(r => r.break).length,
            input, cacheRead, cacheWrite: total('cacheWrite'), uncached: total('uncached'), missed: total('missed'), reuse: input && cacheRead !== null ? cacheRead / input : null,
            items: requests.slice(0, limit),
        });
        all.push(...requests.map(r => ({ ...r, sessionId: sid })));
    }
    const breaks = all.filter(r => r.break).sort((a, b) => (b.missed ?? 0) - (a.missed ?? 0));
    const byCause = new Map<string, { breaks: number; missed: number }>();
    for (const r of breaks) {
        const v = byCause.get(r.cause!) ?? { breaks: 0, missed: 0 };
        v.breaks++;
        v.missed += r.missed ?? 0;
        byCause.set(r.cause!, v);
    }
    const latencies = (pick: (r: Request) => boolean) => all.filter(r => pick(r) && r.latencyMs !== null).map(r => r.latencyMs!);
    const breakLat = latencies(r => r.break), reuseLat = latencies(r => !r.break && !r.coldStart);
    const gaps: string[] = [];
    if (codex) gaps.push('cache-cause-codex-derived');
    if (claude) gaps.push('cache-breakpoints-not-logged');
    if (unlogged) gaps.push('usage-not-logged');
    if (cut) gaps.push('cache-request-limit');
    if (breaks.length > 200) gaps.push('cache-break-limit');
    addGaps(loaded, ...gaps);
    const sumAll = (k: 'input' | 'cacheRead' | 'uncached' | 'missed') => sessions.reduce((n, s) => n + (s[k] ?? 0), 0);
    return {
        ...d.envelope(loaded.coverage), sessionId: rootId,
        sessions,
        breaks: breaks.slice(0, 200),
        byCause: [...byCause].sort((a, b) => b[1].missed - a[1].missed).map(([cause, v]) => ({ cause, ...v })),
        latency: breakLat.length || reuseLat.length ? { breakMedianMs: median(breakLat), reuseMedianMs: median(reuseLat), breaks: breakLat.length, reuses: reuseLat.length } : null,
        summary: { requests: all.length, breaks: breaks.length, input: sumAll('input'), cacheRead: sumAll('cacheRead'), uncached: sumAll('uncached'), missed: sumAll('missed'), reuse: sumAll('input') ? sumAll('cacheRead') / sumAll('input') : null },
        rules: ['cache-break@1', 'cache-ttl@1', 'cache-context-change@1'],
        caveats: ['Missed tokens are prompt tokens a request read at full price again; dollar amounts are out of scope.', 'A break latency difference is an association: breaks also follow pauses and large changes.', 'Codex logs no miss reason; its causes come from the events around a break.'],
    };
}
