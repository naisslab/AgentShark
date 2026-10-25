/** Offline OTLP/JSON and OpenInference mapping. No network transport or collector is started.
 * References: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
 * https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 */
import { Data, type Row, digest, evidence, fail, ids, measured, object, parse } from './data.ts';
import { WORKBENCH_SCHEMA, WORKBENCH_VERSION } from './types.ts';
export interface TelemetryExportSpec {
    sessions?: string[];
    includeText?: boolean;
}
export interface TelemetryImportOptions {
    maxSpans?: number;
}
export interface TelemetrySpan {
    id: string;
    sessionId: string;
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    name: string | null;
    kind: 'llm' | 'tool' | 'agent' | 'workflow' | 'unknown';
    startUs: number | null;
    endUs: number | null;
    durationUs: number | null;
    status: 'ok' | 'error' | 'unknown';
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    attributes: Row;
    resource: Row;
    scope: Row;
    native: Row;
    evidence: {
        source: 'otlp-json';
        pointer: string;
        confidence: 'observed';
    };
}
function array(value: unknown, name: string, max: number): any[] {
    if (!Array.isArray(value) || value.length > max)
        fail(`${name} must be an array with at most ${max} entries`);
    return value as any[];
}
function anyValue(value: unknown, depth = 0): unknown {
    if (depth > 24)
        fail('telemetry attributes exceed the nesting limit');
    object(value, 'OTLP AnyValue');
    if ('stringValue' in value) {
        if (typeof value.stringValue !== 'string')
            fail('stringValue must be a string');
        return value.stringValue;
    }
    if ('boolValue' in value) {
        if (typeof value.boolValue !== 'boolean')
            fail('boolValue must be boolean');
        return value.boolValue;
    }
    if ('intValue' in value) {
        const v = value.intValue;
        if (typeof v === 'number' && Number.isSafeInteger(v))
            return v;
        if (typeof v === 'string' && /^-?\d{1,20}$/.test(v)) {
            const n = Number(v);
            return Number.isSafeInteger(n) ? n : v;
        }
        fail('intValue must be a decimal integer');
    }
    if ('doubleValue' in value) {
        if (typeof value.doubleValue !== 'number' || !Number.isFinite(value.doubleValue))
            fail('doubleValue must be finite');
        return value.doubleValue;
    }
    if ('arrayValue' in value) {
        object(value.arrayValue, 'arrayValue');
        return array(value.arrayValue.values ?? [], 'arrayValue.values', 10000).map(v => anyValue(v, depth + 1));
    }
    if ('kvlistValue' in value) {
        object(value.kvlistValue, 'kvlistValue');
        return attributes(value.kvlistValue.values ?? [], depth + 1);
    }
    if ('bytesValue' in value) {
        if (typeof value.bytesValue !== 'string')
            fail('bytesValue must be base64 text');
        return { base64: value.bytesValue };
    }
    return null;
}
function attributes(value: unknown, depth = 0): Row {
    const out: Row = Object.create(null);
    for (const a of array(value ?? [], 'attributes', 10000)) {
        object(a, 'attribute');
        if (typeof a.key !== 'string' || !a.key || a.key.length > 2000)
            fail('attribute key is invalid');
        if (Object.hasOwn(out, a.key))
            fail('duplicate telemetry attribute key');
        out[a.key] = anyValue(a.value, depth);
    }
    return out;
}
function hex(value: unknown, length: number, name: string): string {
    if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/i.test(value) || /^0+$/.test(value))
        fail(`${name} must contain ${length} nonzero hexadecimal characters`);
    return (value as string).toLowerCase();
}
function nano(value: unknown, gaps: Set<string>): number | null {
    if (value === undefined || value === null || value === '0' || value === 0) {
        gaps.add('timestamp-missing');
        return null;
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value))
        fail('nanosecond numbers must be safe integers; use decimal strings');
    if (!['number', 'string'].includes(typeof value) || !/^\d{1,20}$/.test(String(value)))
        fail('nanosecond timestamps must be nonnegative decimal integers');
    const n = BigInt(String(value)), us = n / 1000n;
    if (us > BigInt(Number.MAX_SAFE_INTEGER))
        fail('timestamp exceeds the safe microsecond range');
    if (n % 1000n)
        gaps.add('nanoseconds-rounded-down-to-microseconds');
    return Number(us);
}
function stringOrNull(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function counter(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
/** Pure conversion keeps unknown provider identity and absent timestamps null. It does not mutate an index. */
export function importTelemetryDocument(document: unknown, options: TelemetryImportOptions = {}) {
    object(options, 'telemetry import options');
    const maxSpans = options.maxSpans ?? 10000;
    if (!Number.isSafeInteger(maxSpans) || maxSpans < 1 || maxSpans > 50000)
        fail('maxSpans must be an integer from 1 to 50000');
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(document);
    }
    catch {
        fail('telemetry document must be serializable JSON');
    }
    if (typeof encoded !== 'string')
        fail('telemetry document must be an object');
    if (encoded!.length > 20 * 1024 * 1024)
        fail('telemetry document exceeds 20 MiB');
    object(document, 'telemetry document');
    let wrapper: Row | null = null;
    if (document.schemaVersion === WORKBENCH_SCHEMA && document.mappingVersion === 'otlp-openinference@1' && document.document) {
        wrapper = structuredClone(document);
        document = document.document;
        object(document, 'wrapped telemetry document');
    }
    const resources = array(document.resourceSpans, 'resourceSpans', 1000), gaps = new Set<string>(), spans: TelemetrySpan[] = [];
    if (wrapper)
        gaps.add('workbench-export-envelope-coverage-not-verified');
    const identities = new Set<string>();
    for (const [ri, resource] of resources.entries()) {
        object(resource, 'resourceSpans entry');
        const resourceAttrs = attributes(resource.resource?.attributes ?? []);
        const scopes = array(resource.scopeSpans ?? [], 'scopeSpans', 1000);
        for (const [si, scope] of scopes.entries()) {
            object(scope, 'scopeSpans entry');
            const ss = array(scope.spans ?? [], 'spans', maxSpans);
            for (const [i, s] of ss.entries()) {
                if (spans.length >= maxSpans)
                    fail('telemetry span count exceeds maxSpans');
                object(s, 'span');
                const traceId = hex(s.traceId, 32, 'traceId'), spanId = hex(s.spanId, 16, 'spanId'), id = `otlp:${traceId}:${spanId}`;
                if (identities.has(id))
                    fail('duplicate trace/span identity');
                identities.add(id);
                const attrs = attributes(s.attributes ?? []);
                let startUs = nano(s.startTimeUnixNano, gaps), endUs = nano(s.endTimeUnixNano, gaps);
                if (startUs !== null && endUs !== null && endUs < startUs) {
                    gaps.add('span-time-inversion');
                    endUs = null;
                }
                const oi = attrs['openinference.span.kind'];
                const kind = oi === 'LLM' ? 'llm' : oi === 'TOOL' ? 'tool' : oi === 'AGENT' ? 'agent' : oi === 'CHAIN' ? 'workflow' : 'unknown';
                if (kind === 'unknown')
                    gaps.add('unmapped-span-kind');
                const parent = s.parentSpanId ? hex(s.parentSpanId, 16, 'parentSpanId') : null;
                const status = s.status?.code;
                if (status !== undefined && ![0, 1, 2].includes(status))
                    fail('OTLP status code must be 0, 1, or 2');
                spans.push({ id, sessionId: `otlp:${traceId}`, traceId, spanId, parentSpanId: parent, name: stringOrNull(s.name), kind, startUs, endUs, durationUs: startUs !== null && endUs !== null ? endUs - startUs : null, status: status === 1 ? 'ok' : status === 2 ? 'error' : 'unknown', model: stringOrNull(attrs['llm.model_name'] ?? attrs['gen_ai.response.model'] ?? attrs['gen_ai.request.model']), inputTokens: counter(attrs['llm.token_count.prompt'] ?? attrs['gen_ai.usage.input_tokens']), outputTokens: counter(attrs['llm.token_count.completion'] ?? attrs['gen_ai.usage.output_tokens']), attributes: attrs, resource: structuredClone(resource.resource ?? {}), scope: structuredClone(scope.scope ?? {}), native: structuredClone(s), evidence: { source: 'otlp-json', pointer: `/resourceSpans/${ri}/scopeSpans/${si}/spans/${i}`, confidence: 'observed' } });
                if ((s.droppedAttributesCount ?? 0) > 0 || (s.droppedEventsCount ?? 0) > 0 || (s.droppedLinksCount ?? 0) > 0)
                    gaps.add('telemetry-reports-dropped-data');
                // Resource attributes are preserved separately; merging them into span attributes could overwrite evidence.
                if (Object.keys(resourceAttrs).length === 0)
                    gaps.add('resource-attributes-unavailable');
            }
        }
    }
    const sessions = [...new Map(spans.map(s => [s.sessionId, s.traceId])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, traceId]) => ({ id, agent: null, title: null, traceId, providerIdentity: 'unknown' as const }));
    for (const span of spans)
        if (span.parentSpanId && !identities.has(`otlp:${span.traceId}:${span.parentSpanId}`))
            gaps.add('parent-span-outside-document');
    return { schemaVersion: WORKBENCH_SCHEMA, analysisVersion: WORKBENCH_VERSION, documentVersion: 'agentshark.telemetry.v1', mappingVersion: 'otlp-openinference@1', sessions, spans,
        coverage: { spansImported: spans.length, gaps: [...gaps].sort(), complete: false },
        nativeDocument: structuredClone(document),
        ...(wrapper ? { sourceEnvelope: wrapper } : {}),
        caveats: ['Generic telemetry has no inferred coding-agent identity.', 'This conversion preserves original resource, scope, span, event, link, and attribute records.', 'Imported spans are portable records; this function does not write them into the coding-agent index.', 'Missing timestamps and outcomes remain unknown.'] };
}
const attr = (key: string, value: unknown): Row => ({ key, value: typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value } : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } });
const ns = (us: number): string => (BigInt(us) * 1000n).toString();
/** Export only spans with known start/end timestamps; omitted spans are explicit coverage gaps. */
export function exportTelemetry(data: Data, spec: TelemetryExportSpec = {}) {
    object(spec, 'telemetry export');
    if (spec.includeText !== undefined && typeof spec.includeText !== 'boolean')
        fail('includeText must be boolean');
    const loaded = data.load(ids(spec.sessions)), sessionIds = loaded.sessions.map(s => s.id), sessions = new Map(loaded.sessions.map(s => [s.id, s]));
    const rows = data.derived('spans', sessionIds).filter(s => !s.inherited), events = loaded.events;
    const eligible = rows.filter(s => Number.isSafeInteger(s.start_ts) && Number.isSafeInteger(s.end_ts) && s.start_ts >= 0 && s.end_ts >= s.start_ts);
    const present = new Set(eligible.map(s => s.id));
    const eventsBySpan = new Map<string, typeof events>();
    for (const e of events)
        if (e.span_id && present.has(e.span_id) && e.ts_src === 'logged' && Number.isSafeInteger(e.ts) && e.ts >= 0) {
            const list = eventsBySpan.get(e.span_id) ?? [];
            list.push(e);
            eventsBySpan.set(e.span_id, list);
        }
    const spansBySession = new Map<string, typeof eligible>();
    for (const span of eligible) {
        const list = spansBySession.get(span.session_id) ?? [];
        list.push(span);
        spansBySession.set(span.session_id, list);
    }
    const omitted = rows.filter(s => !present.has(s.id)).map(s => ({ spanId: s.id, sessionId: s.session_id, reason: 'known start and end timestamps are required for OTLP export' }));
    const trace = (sid: string) => { const session = sessions.get(sid)!; return digest(['trace', session.root_id && sessions.has(session.root_id) ? session.root_id : sid]).slice(0, 32); };
    const spanId = (id: string) => digest(['span', id]).slice(0, 16);
    const resourceSpans = loaded.sessions.map(session => ({ resource: { attributes: [attr('service.name', 'agentshark'), attr('agentshark.agent', session.agent), attr('agentshark.session_id', session.id)] }, scopeSpans: [{ scope: { name: 'agentshark.workbench', version: WORKBENCH_VERSION }, spans: (spansBySession.get(session.id) ?? []).map(s => {
                    const a = parse(s.attrs);
                    const values = [attr('agentshark.span_id', s.id), attr('agentshark.span_kind', s.kind), attr('agentshark.duration_source', s.dur_src ?? 'unknown')];
                    const oi = s.kind === 'llm' ? 'LLM' : ['tool', 'exec'].includes(s.kind) ? 'TOOL' : ['session', 'turn', 'workflow', 'phase'].includes(s.kind) ? 'CHAIN' : null;
                    if (oi)
                        values.push(attr('openinference.span.kind', oi));
                    if (typeof a.llm?.model === 'string')
                        values.push(attr('llm.model_name', a.llm.model));
                    if (measured(a.tokens?.input) !== null)
                        values.push(attr('llm.token_count.prompt', a.tokens.input));
                    if (measured(a.tokens?.output) !== null)
                        values.push(attr('llm.token_count.completion', a.tokens.output));
                    if (spec.includeText)
                        values.push(attr('agentshark.normalized_attributes_json', a));
                    const included = eventsBySpan.get(s.id) ?? [];
                    return { traceId: trace(s.session_id), spanId: spanId(s.id), ...(s.parent_id && present.has(s.parent_id) ? { parentSpanId: spanId(s.parent_id) } : {}), name: spec.includeText ? s.name ?? s.kind : s.kind, kind: 1, startTimeUnixNano: ns(s.start_ts), endTimeUnixNano: ns(s.end_ts), attributes: values, status: { code: s.status === 'ok' ? 1 : s.status === 'error' ? 2 : 0 }, events: included.map(e => ({ timeUnixNano: ns(e.ts), name: e.kind, attributes: [attr('agentshark.event_id', e.id), attr('agentshark.source_id', e.src_id), ...(e.src_line === null ? [] : [attr('agentshark.source_line', e.src_line)]), ...(spec.includeText ? [attr('agentshark.normalized_attributes_json', e.a), attr('agentshark.summary', e.summary)] : [])] })) };
                }) }] }));
    if (omitted.length)
        loaded.coverage.gaps.push('telemetry-spans-omitted-for-missing-timestamps');
    const includedEvents = new Set([...eventsBySpan.values()].flatMap(list => list.map(e => e.id)));
    const unexportedEvents = events.filter(e => !includedEvents.has(e.id));
    if (unexportedEvents.length)
        loaded.coverage.gaps.push('telemetry-events-outside-exported-spans');
    return { ...data.envelope(loaded.coverage), mappingVersion: 'otlp-openinference@1', document: { resourceSpans }, exportedSpans: eligible.length, omittedSpans: omitted, unexportedEventCount: unexportedEvents.length, includeText: spec.includeText === true,
        caveats: ['Trace and span IDs are deterministic mappings; original IDs are preserved as attributes.', 'Parent links describe span containment, not execution dependencies.', 'Missing timestamps are never replaced by a fabricated duration.', 'Text is omitted unless includeText is enabled; identifiers and measurement metadata remain.', 'This is an offline OTLP/JSON document, not a live telemetry collector.'] };
}
