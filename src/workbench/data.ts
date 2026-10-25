import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { ANALYSIS_VERSION } from '../index/derive.ts';
import { gapNotes, type GapFigures } from './gap-text.ts';
import { WORKBENCH_SCHEMA, WORKBENCH_VERSION, type Confidence, type Coverage, type Envelope, type EvidenceRef, type SessionIdentity, type WorkbenchOptions } from './types.ts';
export type Row = Record<string, any>;
export interface Event extends Row {
    rid: number;
    id: string;
    session_id: string;
    src_id: string;
    seq: number;
    ts: number;
    ts_src: string;
    kind: string;
    summary: string;
    tool_name: string | null;
    span_id: string | null;
    turn_id: string | null;
    flag_bits: number;
    exit_code: number | null;
    src_line: number | null;
    a: Row;
}
export interface Loaded {
    sessions: Row[];
    events: Event[];
    coverage: Coverage;
}
/** The HTTP error code of a refused request; clients choose their message and whether to offer Retry by it. */
export type WorkbenchInputCode = 'workbench-input' | 'session-not-found' | 'session-tree-limit' | 'row-limit';
export class WorkbenchInputError extends Error {
    readonly status = 400;
    readonly code: WorkbenchInputCode;
    constructor(message: string, code: WorkbenchInputCode = 'workbench-input') { super(message); this.name = 'WorkbenchInputError'; this.code = code; }
}
export const fail = (message: string, code?: WorkbenchInputCode): never => { throw new WorkbenchInputError(message, code); };
export function object(value: unknown, name: string): asserts value is Row {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(`${name} must be an object`);
}
export function textId(value: unknown, name = 'id'): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000)
        fail(`${name} must be a nonempty string of at most 2000 characters`);
    return value as string;
}
export function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
        fail(`${name} must be an integer from ${min} to ${max}`);
    return value as number;
}
export function ids(value: unknown, name = 'sessions'): string[] | undefined {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.length > 500)
        fail(`${name} must be an array with at most 500 IDs`);
    return [...new Set((value as unknown[]).map(v => textId(v, name)))];
}
export function parse(value: unknown): Row {
    try {
        const out = typeof value === 'string' ? JSON.parse(value) : value;
        return out && typeof out === 'object' && !Array.isArray(out) ? out : {};
    }
    catch {
        return {};
    }
}
export function canonical(value: unknown): string {
    if (value === undefined)
        return 'null';
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`).join(',')}}`;
    return JSON.stringify(value);
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function evidence(e: Event | Row, confidence: Confidence = 'observed'): EvidenceRef {
    return { eventId: e.id, sessionId: e.session_id, source: e.src_id, line: e.src_line ?? null, confidence };
}
export function eventText(e: Event): string {
    const input = e.a.tool?.input;
    const inputText = typeof e.a.tool?.command === 'string' ? e.a.tool.command : input === null || input === undefined ? null : typeof input === 'string' ? input : canonical(input);
    const parts = [e.a.text, inputText, e.a.tool?.output].filter((x): x is string => typeof x === 'string' && x.length > 0);
    return [...new Set(parts.length ? parts : [e.summary])].join('\n');
}
export function command(e: Event): string {
    const t = e.a.tool ?? {};
    if (typeof t.command === 'string')
        return t.command;
    if (typeof t.input === 'string') {
        const p = parse(t.input);
        return typeof p.command === 'string' ? p.command : typeof p.cmd === 'string' ? p.cmd : t.input;
    }
    return typeof t.input?.command === 'string' ? t.input.command : typeof t.input?.cmd === 'string' ? t.input.cmd : '';
}
export function target(e: Event): string | null {
    const t = e.a.tool ?? {};
    const input = parse(t.input);
    const value = t.path ?? input.path ?? input.file_path ?? e.a.file?.path;
    return typeof value === 'string' && value ? value : command(e) || null;
}
export function isFailure(e: Event): boolean | null {
    if (e.exit_code !== null && e.exit_code !== undefined)
        return e.exit_code !== 0;
    if (e.a.tool?.exit_code !== undefined)
        return e.a.tool.exit_code !== 0;
    if (e.flag_bits & 1 || e.a.tool?.is_error === true || ['llm.error', 'llm.refusal'].includes(e.kind))
        return true;
    if (e.a.tool?.is_error === false || e.a.tool?.status === 'completed')
        return false;
    return null;
}
export function own(e: Event): boolean { return (e.flag_bits & 6) === 0; }
/** Text on one line, cut to `max` code points with a trailing ellipsis; null when there is none. */
export function oneLine(text: unknown, max: number): string | null {
    if (typeof text !== 'string') return null;
    const chars = [...text.replace(/\s+/g, ' ').trim()];
    return !chars.length ? null : chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…';
}
export function measured(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
export function union(intervals: [
    number,
    number
][]): number {
    const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((a, b) => a[0] - b[0]);
    let total = 0, end = -Infinity;
    for (const [a, b] of sorted) {
        total += Math.max(0, b - Math.max(a, end));
        end = Math.max(end, b);
    }
    return total;
}
export function fileIdentity(path: string, cwd: string | null): string | null { return isAbsolute(path) ? resolve(path) : cwd ? resolve(cwd, path) : null; }
/** What a derived table holds, in the words of the clients, for the row-limit sentence that they show as it is. */
const ROW_NOUN = {
    changes: 'file changes', delegations: 'delegations', steps: 'steps', failures: 'failures', episodes: 'failure episodes', spans: 'spans',
    interventions: 'interventions', turn_rollup: 'turns',
} as const;
export class Data {
    readonly db: DatabaseSync;
    readonly options: WorkbenchOptions;
    readonly maxEvents: number;
    constructor(db: DatabaseSync, options: WorkbenchOptions = {}) {
        this.db = db;
        this.options = { ...options, ...(options.allowedSessions === undefined ? {} : { allowedSessions: [...new Set([...options.allowedSessions].map(id => textId(id, 'allowedSessions')))] }) };
        this.maxEvents = integer(options.maxEvents, 20000, 100, 50000, 'maxEvents');
        if (options.now !== undefined)
            integer(options.now, 0, 0, Number.MAX_SAFE_INTEGER, 'now');
    }
    rows(sql: string, ...args: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
    row(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
    has(table: string): boolean { return !!this.row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table); }
    meta(key: string): string | null { return this.row('SELECT value FROM meta WHERE key=?', key)?.value ?? null; }
    /** Nested read savepoints preserve a single SQLite snapshot, including when the caller owns a transaction. */
    snapshot<T>(fn: () => T): T {
        this.db.exec('SAVEPOINT agentshark_workbench_read');
        try {
            return fn();
        }
        finally {
            this.db.exec('RELEASE agentshark_workbench_read');
        }
    }
    session(id: string): Row {
        textId(id, 'session');
        this.assertAllowed(id);
        const row = this.row('SELECT * FROM sessions WHERE id=?', id);
        if (!row)
            fail(`session not found: ${id}`, 'session-not-found');
        return row!;
    }
    assertAllowed(id: string): void {
        if (this.options.allowedSessions !== undefined && !this.options.allowedSessions.includes(id))
            fail('session is outside the permitted scope');
    }
    descendants(id: string): string[] {
        this.session(id);
        const rows = this.options.allowedSessions === undefined
            ? this.rows(`WITH RECURSIVE family(id) AS (SELECT id FROM sessions WHERE id=? UNION SELECT s.id FROM sessions s JOIN family f ON s.parent_id=f.id) SELECT id,parent_id FROM sessions WHERE id IN family LIMIT 501`, id)
            : this.options.allowedSessions.map(sid => this.row('SELECT id,parent_id FROM sessions WHERE id=?', sid)).filter((r): r is Row => !!r);
        const found = new Set([id]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const r of rows)
                if (found.has(r.parent_id) && !found.has(r.id)) {
                    found.add(r.id);
                    changed = true;
                }
        }
        // Count the tree itself: under a permitted scope the rows hold every permitted session, most outside this tree.
        if (found.size > 500)
            fail('session tree exceeds the 500-session analysis limit', 'session-tree-limit');
        return [...found];
    }
    load(requested?: string[], limit = this.maxEvents): Loaded {
        const requestedIds = ids(requested ?? (this.options.allowedSessions === undefined ? undefined : [...this.options.allowedSessions]));
        const sessions = requestedIds === undefined ? this.rows('SELECT * FROM sessions ORDER BY id LIMIT 501') : requestedIds.map(id => this.session(id));
        if (sessions.length > 500)
            fail('choose at most 500 sessions for this analysis');
        let available = 0;
        const events: Event[] = [];
        const gaps = new Set<string>();
        for (const s of sessions) {
            available += this.row('SELECT count(*) AS n FROM events WHERE session_id=? AND (flag_bits & 6)=0', s.id)!.n;
            const remaining = Math.max(0, limit - events.length);
            if (remaining === 0)
                continue;
            const rows = this.rows(`SELECT e.*, p.attrs FROM events e LEFT JOIN event_payload p ON e.rid=p.rid WHERE e.session_id=? AND (e.flag_bits & 6)=0 ORDER BY e.seq,e.rid LIMIT ?`, s.id, remaining);
            const bySource = new Map<string, Event[]>();
            for (const r of rows) {
                const a = parse(r.attrs);
                const e = { ...r, a } as Event;
                delete e.attrs;
                if (r.attrs == null)
                    gaps.add('event-payload-missing');
                if (r.attrs && Object.keys(a).length === 0 && r.attrs !== '{}')
                    gaps.add('invalid-or-empty-event-payload');
                if ((e.flag_bits & 32) || (a.text_len ?? 0) > (a.text?.length ?? Infinity) || (a.tool?.output_len ?? 0) > (a.tool?.output?.length ?? Infinity))
                    gaps.add('indexed-text-truncated');
                if (e.ts_src !== 'logged')
                    gaps.add('timestamps-inferred-or-missing');
                if (e.kind === 'raw.unknown')
                    gaps.add('unknown-record-kinds');
                const list = bySource.get(e.src_id) ?? [];
                list.push(e);
                bySource.set(e.src_id, list);
            }
            // Preserve each source's event order; merge different sources by the next timestamp, with stable source ties.
            const streams = [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
            const at = streams.map(() => 0);
            while (true) {
                let best = -1;
                for (let k = 0; k < streams.length; k++)
                    if (at[k] < streams[k].length && (best < 0 || streams[k][at[k]].ts < streams[best][at[best]].ts))
                        best = k;
                if (best < 0)
                    break;
                events.push(streams[best][at[best]++]);
            }
            if (streams.length > 1)
                gaps.add('cross-source-order-reconstructed');
            if (s.state && s.state !== 'ok')
                gaps.add(`session-state:${s.state}`);
            const sources = this.rows('SELECT DISTINCT s.status,s.malformed,s.unknown FROM sources s JOIN events e ON e.src_id=s.id WHERE e.session_id=?', s.id);
            for (const source of sources) {
                if (source.status !== 'ok')
                    gaps.add(`source-status:${source.status}`);
                if (source.malformed)
                    gaps.add('malformed-source-records');
                if (source.unknown)
                    gaps.add('unknown-source-records');
            }
        }
        const indexAnalysisVersion = this.meta('analysis_version');
        if (indexAnalysisVersion !== String(ANALYSIS_VERSION))
            gaps.add('analysis-outdated');
        if (available > events.length)
            gaps.add('event-limit');
        if (this.meta('analysis_pending') && this.meta('analysis_pending') !== '[]')
            gaps.add('analysis-pending');
        if (this.meta('analysis_failed') && this.meta('analysis_failed') !== '[]')
            gaps.add('analysis-failed');
        if (this.meta('capture_complete') === '0')
            gaps.add('capture-incomplete');
        const captureCoverage = parse(this.meta('capture_coverage'));
        if (this.meta('capture_coverage')) {
            if (!captureCoverage.known)
                gaps.add('capture-coverage-unknown');
            if (captureCoverage.rawOmitted || captureCoverage.rawUnavailable || captureCoverage.sidecarsOmitted?.length)
                gaps.add('capture-evidence-omitted');
        }
        if (parse(this.meta('capture_header')).privacy)
            gaps.add('capture-evidence-redacted');
        const integrity = parse(this.meta('capture_integrity'));
        if (integrity.status === 'failed')
            gaps.add('capture-integrity-failed');
        else if (integrity.status === 'unverified')
            gaps.add('capture-integrity-unverified');
        else if (this.meta('capture_header') && integrity.status !== 'verified')
            gaps.add('capture-integrity-unverified');
        gaps.add('logs-do-not-establish-complete-execution');
        return { sessions, events, coverage: { sessionIds: sessions.map(s => s.id), eventsAvailable: available, eventsExamined: events.length, truncated: available > events.length, gaps: [...gaps].sort(), indexAnalysisVersion, snapshotAt: this.options.now ?? Date.now() * 1000 } };
    }
    /** Native records of the given events (the compact source copy), by rid. */
    natives(rids: number[]): Map<number, Row> {
        const out = new Map<number, Row>();
        for (let i = 0; i < rids.length; i += 500) {
            const batch = rids.slice(i, i + 500);
            for (const r of this.rows(`SELECT rid, native FROM event_payload WHERE rid IN (${batch.map(() => '?').join(',')})`, ...batch))
                out.set(r.rid, parse(r.native));
        }
        return out;
    }
    /** The shared head of every result: versions, coverage with its gap sentences, and who each covered session is. */
    envelope(coverage: Coverage, figures: GapFigures = {}): Envelope {
        return { schemaVersion: WORKBENCH_SCHEMA, analysisVersion: WORKBENCH_VERSION, coverage: { ...coverage, notes: gapNotes(coverage, figures) }, sessions: this.identities(coverage.sessionIds) };
    }
    /** Sessions the caller may see, by id; ids the index does not hold (a pseudonym, a report's stale id) are left out. */
    identities(sessionIds: string[]): Record<string, SessionIdentity> {
        const allowed = this.options.allowedSessions === undefined ? null : new Set(this.options.allowedSessions);
        const wanted = [...new Set(sessionIds)].filter(id => !allowed || allowed.has(id));
        const found = new Map<string, Row>();
        for (let i = 0; i < wanted.length; i += 500) {
            const batch = wanted.slice(i, i + 500);
            for (const r of this.rows(`SELECT id, title, agent, role, parent_id, root_id, start_ts, end_ts FROM sessions WHERE id IN (${batch.map(() => '?').join(',')})`, ...batch)) found.set(r.id, r);
        }
        return Object.fromEntries(wanted.flatMap(id => {
            const r = found.get(id);
            return r ? [[id, { title: r.title ?? null, agent: r.agent, role: r.role, parentId: r.parent_id ?? null, rootId: r.root_id ?? id, startTs: r.start_ts ?? null, endTs: r.end_ts ?? null }]] : [];
        }));
    }
    refs(eventIds: string[]): EvidenceRef[] {
        return [...new Set(eventIds)].map(id => {
            const e = this.row('SELECT * FROM events WHERE id=?', textId(id, 'event'));
            if (!e)
                fail(`event not found: ${id}`);
            this.assertAllowed(e!.session_id);
            return evidence(e!);
        });
    }
    derived(table: keyof typeof ROW_NOUN, sessionIds: string[]): Row[] {
        if (!this.has(table))
            return [];
        const out: Row[] = [];
        for (const id of sessionIds) {
            this.assertAllowed(id);
            const remaining = this.maxEvents - out.length;
            const rows = this.rows(`SELECT * FROM ${table} WHERE session_id=? LIMIT ?`, id, remaining + 1);
            if (rows.length > remaining)
                fail(`The sessions to analyse have more than ${this.maxEvents.toLocaleString('en-US')} ${ROW_NOUN[table]}, the analysis limit.`, 'row-limit');
            out.push(...rows);
        }
        return out;
    }
}
