import { createHmac, randomBytes } from 'node:crypto';
import { Data, type Row, canonical, digest, evidence, eventText, fail, ids, integer, object, textId } from './data.ts';
import { redactText, sanitize } from '../mcp/redact.ts';
import type { Annotation, CohortSpec, DatasetSpec, ExportSpec, InvestigationSpec, ResearchManifest, ValidationResult } from './types.ts';
function validString(value: unknown, name: string, errors: string[], max = 2000): void {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        errors.push(`${name} must be a nonempty string of at most ${max} characters`);
}
export function validateManifest(value: unknown): ValidationResult {
    const errors: string[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return { valid: false, errors: ['manifest must be an object'] };
    const m = value as Row;
    if (m.schemaVersion !== 'agentshark.manifest.v1')
        errors.push('manifest schemaVersion must be agentshark.manifest.v1');
    validString(m.id, 'manifest id', errors);
    validString(m.title, 'manifest title', errors);
    if (!Array.isArray(m.runs) || m.runs.length > 500)
        errors.push('manifest runs must be an array of at most 500 rows');
    else {
        const sessions = new Set(), trials = new Set();
        for (const [i, r] of m.runs.entries()) {
            if (!r || typeof r !== 'object' || Array.isArray(r)) {
                errors.push(`run ${i} must be an object`);
                continue;
            }
            for (const field of ['sessionId', 'taskId', 'condition'])
                validString(r[field], `run ${i} ${field}`, errors);
            if (!Number.isSafeInteger(r.trial) || r.trial < 0)
                errors.push(`run ${i} trial must be a nonnegative integer`);
            if (r.seed !== undefined && !Number.isSafeInteger(r.seed))
                errors.push(`run ${i} seed must be an integer`);
            if (r.split !== undefined && !['train', 'validation', 'test'].includes(r.split))
                errors.push(`run ${i} split is invalid`);
            if (r.outcome !== undefined && !['success', 'failure', 'unknown'].includes(r.outcome))
                errors.push(`run ${i} outcome is invalid`);
            for (const field of ['model', 'repositoryRevision', 'evaluatorVersion', 'taskGroup'])
                if (r[field] !== undefined)
                    validString(r[field], `run ${i} ${field}`, errors);
            if (sessions.has(r.sessionId))
                errors.push(`run ${i} repeats a session`);
            sessions.add(r.sessionId);
            const key = canonical([r.taskId, r.condition, r.trial]);
            if (trials.has(key))
                errors.push(`run ${i} repeats a task/condition/trial`);
            trials.add(key);
        }
    }
    return { valid: errors.length === 0, errors };
}
export function validateAnnotation(value: unknown): ValidationResult {
    const errors: string[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return { valid: false, errors: ['annotation must be an object'] };
    const a = value as Row;
    if (a.schemaVersion !== 'agentshark.annotation.v1')
        errors.push('annotation schemaVersion must be agentshark.annotation.v1');
    for (const k of ['id', 'subjectId', 'label', 'author', 'rubricVersion'])
        validString(a[k], k, errors);
    if (typeof a.reviewed !== 'boolean')
        errors.push('reviewed must be boolean');
    if (typeof a.createdAt !== 'string' || !/Z$|[+-]\d\d:\d\d$/.test(a.createdAt) || !Number.isFinite(Date.parse(a.createdAt)))
        errors.push('createdAt must be an ISO timestamp with a timezone');
    if (!Array.isArray(a.evidenceEventIds) || a.evidenceEventIds.length > 100)
        errors.push('evidenceEventIds must contain at most 100 IDs');
    else
        a.evidenceEventIds.forEach((id: unknown) => validString(id, 'evidenceEventId', errors));
    if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 10000))
        errors.push('note must be a string of at most 10000 characters');
    return { valid: errors.length === 0, errors };
}
function checkedManifest(value: ResearchManifest | undefined): ResearchManifest | undefined {
    if (value === undefined)
        return;
    const v = validateManifest(value);
    if (!v.valid)
        fail(v.errors.join('; '));
    return value;
}
function annotationRows(value: Annotation[] | undefined): Annotation[] {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 1000)
        fail('annotations must contain at most 1000 rows');
    const unique = new Set();
    return value.map(a => {
        const v = validateAnnotation(a);
        if (!v.valid)
            fail(v.errors.join('; '));
        if (unique.has(a.id))
            fail('annotation IDs must be unique');
        unique.add(a.id);
        return { schemaVersion: a.schemaVersion, id: a.id, subjectId: a.subjectId, label: a.label, author: a.author, createdAt: a.createdAt, rubricVersion: a.rubricVersion, reviewed: a.reviewed, evidenceEventIds: [...new Set(a.evidenceEventIds)], ...(a.note === undefined ? {} : { note: a.note }) };
    });
}
function clean(value: unknown): any {
    if (typeof value === 'string')
        return redactText(sanitize(value)).text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '<email>');
    if (Array.isArray(value))
        return value.map(clean);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
}
function textTokens(s: string): Set<string> { return new Set(s.toLowerCase().replace(/\b\d+\b/g, '#').split(/[^\p{L}\p{N}_#]+/u).filter(t => t.length > 1)); }
function jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size && !b.size)
        return 1;
    let same = 0;
    for (const k of a)
        if (b.has(k))
            same++;
    return same / (a.size + b.size - same);
}
function csvCell(value: unknown): string {
    let s = value === null || value === undefined ? '' : typeof value === 'object' ? canonical(value) : String(value);
    if (/^[\t\r ]*[=+@-]/.test(s))
        s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function mean(values: (number | null)[]): {
    mean: number | null;
    known: number;
    missing: number;
} { const known = values.filter((n): n is number => n !== null && Number.isFinite(n)); return { mean: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null, known: known.length, missing: values.length - known.length }; }
export class Research {
    readonly data: Data;
    constructor(data: Data) { this.data = data; }
    private annotations(input: Annotation[] | undefined, sessionIds: string[]): Annotation[] {
        const rows = annotationRows(input), allowed = new Set(sessionIds), d = this.data;
        for (const a of rows) {
            const subject = d.row('SELECT id AS session_id FROM sessions WHERE id=?', a.subjectId) ?? (d.has('episodes') ? d.row('SELECT session_id FROM episodes WHERE id=?', a.subjectId) : undefined) ?? d.row('SELECT session_id FROM events WHERE id=?', a.subjectId);
            if (!subject || !allowed.has(subject.session_id))
                fail('annotation subject is outside the selected sessions');
            d.assertAllowed(subject!.session_id);
            for (const ref of d.refs(a.evidenceEventIds))
                if (!allowed.has(ref.sessionId))
                    fail('annotation evidence is outside the selected sessions');
        }
        return rows;
    }
    dataset(spec: DatasetSpec = {}) {
        object(spec, 'dataset');
        const d = this.data, manifest = checkedManifest(spec.manifest), limit = integer(spec.limit, 200, 1, 1000, 'dataset limit');
        const selected = ids(spec.sessionIds ?? manifest?.runs.map(r => r.sessionId));
        const episodeIds = ids(spec.episodeIds, 'episodeIds');
        let sessions = selected;
        if (episodeIds !== undefined) {
            const episodeSessions = episodeIds.map(id => {
                const row = d.has('episodes') ? d.row('SELECT session_id FROM episodes WHERE id=?', id) : undefined;
                if (!row)
                    fail(`episode not found: ${id}`);
                d.assertAllowed(row!.session_id);
                if (selected && !selected.includes(row!.session_id))
                    fail('episode is outside selected sessions');
                return row!.session_id as string;
            });
            sessions = [...new Set(episodeSessions)];
        }
        const loaded = d.load(sessions);
        const sessionIds = loaded.sessions.map(s => s.id);
        const annotations = this.annotations(spec.annotations, sessionIds);
        if (spec.redact !== undefined && typeof spec.redact !== 'boolean')
            fail('redact must be boolean');
        if (spec.includeUnreviewed !== undefined && typeof spec.includeUnreviewed !== 'boolean')
            fail('includeUnreviewed must be boolean');
        const redacted = spec.redact !== false;
        const key = randomBytes(32);
        const pseudonym = (kind: string, value: string) => `${kind}_${createHmac('sha256', key).update(kind + '\0' + value).digest('hex').slice(0, 24)}`;
        const refs = (refs: ReturnType<typeof evidence>[]) => redacted ? refs.map(r => ({ ...r, eventId: pseudonym('event', r.eventId), sessionId: pseudonym('session', r.sessionId), source: pseudonym('source', r.source), redacted: true })) : refs;
        const events = new Map(loaded.events.map(e => [e.rid, e]));
        const episodes = d.derived('episodes', sessionIds).filter(e => episodeIds === undefined || episodeIds.includes(e.id)).sort((a, b) => a.session_id.localeCompare(b.session_id) || a.start_ts - b.start_ts || a.id.localeCompare(b.id));
        const chosen = episodes.filter(e => spec.includeUnreviewed || annotations.some(a => a.subjectId === e.id && a.reviewed));
        if (chosen.length > limit) {
            loaded.coverage.truncated = true;
            loaded.coverage.gaps.push('dataset-episode-limit');
        }
        const internal = chosen.slice(0, limit).map(ep => {
            const es = [ep.opener_rid, ep.last_rid, ep.closer_rid].filter((rid, i, all) => rid !== null && all.indexOf(rid) === i).map(rid => events.get(rid)).filter(e => e !== undefined);
            const task = manifest?.runs.find(r => r.sessionId === ep.session_id);
            const tokens = textTokens([ep.family, ep.class, ep.target_key, ...es.map(e => eventText(e))].join(' '));
            const labels = annotations.filter(a => a.subjectId === ep.id && (spec.includeUnreviewed || a.reviewed));
            const sessionEvents = loaded.events.filter(e => e.session_id === ep.session_id);
            const low = sessionEvents.findIndex(e => e.rid === ep.opener_rid), high = sessionEvents.findIndex(e => e.rid === (ep.closer_rid ?? ep.last_rid));
            const slice = low >= 0 && high >= low ? sessionEvents.slice(low, high + 1) : es;
            const fixture = slice.filter(e => ['tool.call', 'tool.result', 'tool.exec'].includes(e.kind)).map(e => ({ eventId: e.id, kind: e.kind, callId: e.a.tool?.call_id ?? null, tool: e.tool_name, input: e.a.tool?.input ?? null, output: e.a.tool?.output ?? null, exitCode: e.exit_code, recorded: true }));
            return { ep, tokens, task, row: { id: redacted ? pseudonym('episode', ep.id) : ep.id, sessionId: redacted ? pseudonym('session', ep.session_id) : ep.session_id, family: ep.family, class: ep.class, observedOutcome: ep.outcome, outcomeSource: ep.outcome_src, attempts: ep.n_attempts, wallUs: ep.wall_us,
                    evidence: refs(es.map(e => evidence(e))), evidenceComplete: es.length === new Set([ep.opener_rid, ep.last_rid, ...(ep.closer_rid === null ? [] : [ep.closer_rid])]).size,
                    labels: labels.map(a => redacted ? { label: pseudonym('label', a.label), reviewed: a.reviewed, rubricVersion: pseudonym('rubric', a.rubricVersion), author: pseudonym('author', a.author), createdAt: a.createdAt, evidence: refs(d.refs(a.evidenceEventIds)) } : a),
                    taskId: task ? (redacted ? pseudonym('task', task.taskId) : task.taskId) : null, split: task?.split ?? null, splitGroup: '',
                    excerpt: redacted ? null : es.map(e => eventText(e).slice(0, 2000)).join('\n'),
                    replayFixture: redacted ? { mode: 'mocked-recorded-tools', executable: false, available: false, reason: 'Tool inputs and outputs were omitted by structural redaction.' } : { mode: 'mocked-recorded-tools', executable: false, available: true, records: fixture, expectedLabels: labels.map(a => a.label), limitations: ['Recorded fixtures do not recreate filesystem state or prove a changed agent will succeed.', 'Fixtures contain observed calls and results only; no tools are executed.'] } } };
        });
        // Connected components keep all near-duplicate examples together, including transitive similarities.
        const parent = internal.map((_, i) => i), find = (i: number): number => {
            while (parent[i] !== i) {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            return i;
        };
        const duplicates: {
            left: string;
            right: string;
            similarity: number;
            reason: string;
        }[] = [];
        let comparisons = 0;
        pairs: for (let i = 0; i < internal.length; i++)
            for (let j = i + 1; j < internal.length; j++) {
                if (++comparisons > 50000) {
                    loaded.coverage.truncated = true;
                    loaded.coverage.gaps.push('near-duplicate-comparison-limit');
                    break pairs;
                }
                const a = internal[i], b = internal[j];
                const similarity = jaccard(a.tokens, b.tokens);
                const sameTask = !!a.task && !!b.task && (a.task.taskGroup ?? a.task.taskId) === (b.task.taskGroup ?? b.task.taskId);
                if (sameTask || (typeof a.ep.sig_id === 'string' && a.ep.sig_id.length > 0 && a.ep.sig_id === b.ep.sig_id) || similarity >= 0.85) {
                    parent[find(j)] = find(i);
                    duplicates.push({ left: a.row.id, right: b.row.id, similarity, reason: sameTask ? 'same-task-group' : (typeof a.ep.sig_id === 'string' && a.ep.sig_id.length > 0 && a.ep.sig_id === b.ep.sig_id) ? 'same-failure-signature' : 'token-overlap-candidate' });
                }
            }
        const groups = new Map<number, typeof internal>();
        internal.forEach((r, i) => { const root = find(i), g = groups.get(root) ?? []; g.push(r); groups.set(root, g); });
        for (const group of groups.values()) {
            const id = redacted ? pseudonym('group', group.map(r => r.ep.id).sort().join('|')) : 'group_' + digest(group.map(r => r.ep.id).sort()).slice(0, 16);
            group.forEach(r => r.row.splitGroup = id);
        }
        const splitConflicts = [...groups.values()].filter(g => new Set(g.map(r => r.row.split).filter(Boolean)).size > 1).map(g => ({ splitGroup: g[0].row.splitGroup, splits: [...new Set(g.map(r => r.row.split).filter(Boolean))], ids: g.map(r => r.row.id) }));
        const coverage = redacted ? { ...loaded.coverage, sessionIds: loaded.coverage.sessionIds.map(id => pseudonym('session', id)) } : loaded.coverage;
        return { ...d.envelope(coverage), datasetVersion: 'agentshark.dataset.v1', entries: internal.map(r => r.row), nearDuplicates: duplicates, splitConflicts, summary: { availableEpisodes: episodes.length, selectedEpisodes: chosen.length, exportedEpisodes: internal.length, excludedUnreviewed: episodes.length - chosen.length, splitConflicts: splitConflicts.length },
            redaction: { enabled: redacted, profile: redacted ? 'structural-omission' : 'none', omitted: redacted ? ['trace text', 'tool inputs and outputs', 'paths', 'annotation notes', 'original identities', 'original label names'] : [], labels: redacted ? 'Stable pseudonyms preserve label groups within this export.' : 'Original reviewed labels.' },
            caveats: ['Near-duplicate groups are conservative candidates, not proof of a shared root cause.', 'Dataset entries retain observed outcomes separately from reviewer labels.', 'Structural redaction intentionally removes executable replay inputs; export without redaction only for a trusted local workflow.'] };
    }
    cohort(spec: CohortSpec = {}) {
        object(spec, 'cohort');
        const d = this.data, manifest = checkedManifest(spec.manifest);
        const loaded = d.load(ids(spec.sessions ?? manifest?.runs.map(r => r.sessionId)));
        const groupBy = spec.groupBy ?? (manifest ? 'condition' : 'agent');
        if (!['condition', 'agent', 'model'].includes(groupBy))
            fail('groupBy must be condition, agent, or model');
        if (groupBy === 'condition' && !manifest)
            fail('condition grouping requires a manifest');
        const runMap = new Map(manifest?.runs.map(r => [r.sessionId, r]) ?? []);
        const rows = loaded.sessions.map(s => { const run = runMap.get(s.id); return { sessionId: s.id, group: groupBy === 'condition' ? run?.condition ?? 'unknown' : groupBy === 'agent' ? s.agent : run?.model ?? String(s.models ?? 'unknown'), taskId: run?.taskId ?? null, trial: run?.trial ?? null, outcome: run?.outcome ?? 'unknown', wallUs: s.start_ts !== null && s.end_ts !== null && s.end_ts >= s.start_ts ? s.end_ts - s.start_ts : null, tokens: s.tok_in !== null && s.tok_out !== null ? s.tok_in + s.tok_out : null, costUsd: s.cost_usd ?? null, errors: s.n_errors }; });
        const keys = [...new Set(rows.map(r => r.group))].sort();
        const groups = keys.map(group => { const members = rows.filter(r => r.group === group), known = members.filter(r => r.outcome !== 'unknown'); return { group, runs: members.length, knownOutcomes: known.length, successRate: known.length ? known.filter(r => r.outcome === 'success').length / known.length : null, wallUs: mean(members.map(r => r.wallUs)), tokens: mean(members.map(r => r.tokens)), costUsd: mean(members.map(r => r.costUsd)) }; });
        const paired: {
            leftGroup: string;
            rightGroup: string;
            taskId: string;
            trial: number;
            leftSession: string;
            rightSession: string;
            deltaWallUs: number | null;
            deltaTokens: number | null;
            deltaCostUsd: number | null;
        }[] = [];
        if (manifest) {
            for (let i = 0; i < keys.length; i++)
                for (let j = i + 1; j < keys.length; j++)
                    for (const a of rows.filter(r => r.group === keys[i])) {
                        const b = rows.find(r => r.group === keys[j] && r.taskId === a.taskId && r.trial === a.trial);
                        if (!b || a.taskId === null || a.trial === null)
                            continue;
                        const delta = (a: number | null, b: number | null) => a === null || b === null ? null : b - a;
                        paired.push({ leftGroup: keys[i], rightGroup: keys[j], taskId: a.taskId, trial: a.trial, leftSession: a.sessionId, rightSession: b.sessionId, deltaWallUs: delta(a.wallUs, b.wallUs), deltaTokens: delta(a.tokens, b.tokens), deltaCostUsd: delta(a.costUsd, b.costUsd) });
                    }
        }
        return { ...d.envelope(loaded.coverage), groupBy, groups, runs: rows, pairedComparisons: paired, manifestId: manifest?.id ?? null, caveats: ['Outcome labels come from the manifest; error counts are not task outcomes.', 'Pairing uses task ID and trial; equal IDs do not establish equivalent environments.', 'Means report known and missing counts and do not impute missing measurements.', 'These are descriptive comparisons, not causal effect estimates.'] };
    }
    exportTable(spec: ExportSpec) {
        object(spec, 'export');
        const d = this.data;
        const allowed = new Set(['sessions', 'events', 'steps', 'failures', 'changes', 'annotations']);
        if (!allowed.has(spec.table))
            fail('unsupported export table');
        if (!['csv', 'jsonl'].includes(spec.format))
            fail('format must be csv or jsonl');
        const limit = integer(spec.limit, 10000, 1, 50000, 'export limit'), loaded = d.load(ids(spec.sessions));
        const sessionIds = loaded.sessions.map(s => s.id);
        const definitions: Record<string, string[]> = { sessions: ['id', 'agent', 'role', 'parent_id', 'root_id', 'title', 'project', 'git_commit', 'start_ts', 'end_ts', 'tok_in', 'tok_out', 'cost_usd'], events: ['id', 'session_id', 'src_id', 'src_line', 'ts', 'ts_src', 'seq', 'kind', 'tool_name', 'exit_code', 'summary'], steps: ['id', 'session_id', 'turn_id', 'n', 'start_ts', 'end_ts', 'ctx_tokens', 'tok_out', 'n_calls', 'n_fail'], failures: ['session_id', 'eventId', 'callEventId', 'tier', 'source', 'rule', 'family', 'class', 'sig_id', 'target_key', 'exit_code', 'error_line', 'episode_id'], changes: ['session_id', 'eventId', 'path', 'ts', 'op', 'src', 'added', 'removed'], annotations: ['schemaVersion', 'id', 'subjectId', 'label', 'author', 'createdAt', 'rubricVersion', 'reviewed', 'evidenceEventIds', 'note'] };
        const columns = definitions[spec.table];
        let rows: Row[];
        if (spec.table === 'sessions')
            rows = loaded.sessions.map(s => ({ ...s, parent_id: s.parent_id && sessionIds.includes(s.parent_id) ? s.parent_id : null, root_id: s.root_id && sessionIds.includes(s.root_id) ? s.root_id : null }));
        else if (spec.table === 'events')
            rows = loaded.events;
        else if (spec.table === 'annotations')
            rows = this.annotations(spec.annotations, sessionIds);
        else {
            rows = d.derived(spec.table, sessionIds);
            if (spec.table === 'failures' || spec.table === 'changes')
                rows = rows.map(r => ({ ...r, eventId: d.row('SELECT id FROM events WHERE rid=?', r.rid)?.id ?? null, ...(spec.table === 'failures' ? { callEventId: r.call_rid === null ? null : (() => { const call = d.row('SELECT id,session_id FROM events WHERE rid=?', r.call_rid); return call && sessionIds.includes(call.session_id) ? call.id : null; })() } : {}) }));
        }
        rows = rows.map(row => Object.fromEntries(columns.map(k => [k, row[k] ?? null]))).sort((a, b) => canonical(a).localeCompare(canonical(b)));
        if (rows.length > limit) {
            loaded.coverage.truncated = true;
            loaded.coverage.gaps.push('export-row-limit');
        }
        const total = rows.length;
        if (spec.redact !== undefined && typeof spec.redact !== 'boolean')
            fail('redact must be boolean');
        const out = rows.slice(0, limit).map(row => spec.redact === false ? row : clean(row));
        const content = spec.format === 'jsonl' ? out.map(row => JSON.stringify(row)).join('\n') + (out.length ? '\n' : '') : [columns.join(','), ...out.map(row => columns.map(k => csvCell(row[k])).join(','))].join('\n') + '\n';
        return { ...d.envelope(loaded.coverage), table: spec.table, format: spec.format, columns, rows: out.length, totalRows: total, content, mimeType: spec.format === 'csv' ? 'text/csv' : 'application/x-ndjson', redaction: spec.redact === false ? 'none' : 'heuristic-secret-and-personal-patterns', caveats: ['Table redaction removes known patterns; arbitrary sensitive text can remain. Use structural dataset export for stronger omission.', 'CSV cells that could be interpreted as formulas are escaped.', 'Null measurements are empty CSV cells and JSON null; they are never converted to zero.'] };
    }
    investigation(spec: InvestigationSpec) {
        object(spec, 'investigation');
        const d = this.data;
        const title = textId(spec.title, 'title');
        if (spec.question !== undefined)
            textId(spec.question, 'question');
        const sessionIds = ids(spec.sessions) ?? [];
        if (!sessionIds.length)
            fail('investigation requires at least one session');
        const loaded = d.load(sessionIds), manifest = checkedManifest(spec.manifest);
        if (manifest && manifest.runs.some(r => !sessionIds.includes(r.sessionId)))
            fail('manifest contains a session outside the investigation');
        const annotations = this.annotations(spec.annotations, sessionIds);
        const findings = spec.findings ?? [];
        if (!Array.isArray(findings) || findings.length > 1000)
            fail('findings must contain at most 1000 items');
        const validated = findings.map(f => {
            object(f, 'finding');
            textId(f.text, 'finding text');
            if (!['observed', 'derived', 'candidate', 'unknown'].includes(f.confidence))
                fail('invalid finding confidence');
            const evidenceIds = ids(f.evidenceEventIds, 'evidenceEventIds') ?? [];
            if (f.evidenceEventIds === undefined)
                fail('finding requires evidenceEventIds');
            const refs = d.refs(evidenceIds);
            if (refs.some(r => !sessionIds.includes(r.sessionId)))
                fail('finding evidence is outside investigation sessions');
            if (f.confidence === 'observed' && !refs.length)
                fail('an observed finding requires evidence');
            return { text: f.text, confidence: f.confidence, evidence: refs };
        });
        const fingerprint = digest(loaded.events.map(e => ({ id: e.id, source: e.src_id, seq: e.seq, kind: e.kind, attrs: e.a })));
        return { ...d.envelope(loaded.coverage), documentVersion: 'agentshark.investigation.v1', title, question: spec.question ?? null, sessionIds, corpusFingerprint: fingerprint, findings: validated, annotations, manifest: manifest ?? null, analysisSettings: { maxEvents: d.maxEvents, indexAnalysisVersion: loaded.coverage.indexAnalysisVersion, alarmThresholds: d.meta('alarm_thresholds') }, caveats: ['The corpus fingerprint covers indexed events in this document scope; it is not a source-file integrity proof.', 'A saved document preserves judgments and references; exact reanalysis also requires the matching capture and analyzer.'] };
    }
}
