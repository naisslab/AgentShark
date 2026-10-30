// Shareable captures preserve structure and numeric measures while removing arbitrary text. Pattern-only secret
// replacement cannot promise safe sharing: source code, prompts, names and provider-specific metadata also matter.
import { createHmac, randomBytes } from 'node:crypto';
import { EVENT_KINDS, SPAN_KINDS } from '../model/kinds.ts';

export interface CaptureRedactionReport {
  profile: 'shareable';
  version: 1;
  keyId: string;
  replacements: number;
  omitted: string[];
}

const ID_KEYS = new Set(['id', 'session', 'source', 'src', 'span', 'turn', 'parentId', 'parentSpanId', 'parent', 'linkSession', 'link_session',
  'firstEvent', 'lastEvent', 'event', 'call_id', 'parent_call_id', 'proc_id', 'message_id', 'request_id', 'response_id', 'nativeId']);
const PATH_KEYS = new Set(['path', 'cwd', 'project', 'persisted_path', 'to']);
const NUMERIC_ATTRS = new Set(['tokens', 'cost']);
const SAFE_TOOL = new Set(['kind', 'exit_code', 'is_error', 'output_len', 'reported_wall_ms', 'inner_errors']);
const SAFE_TEXT = new Set(['agent', 'kind', 'role', 'state', 'tsSrc', 'actor', 'durSrc', 'status', 'severity', 'group', 'rec', 'op', 'src']);
const STRUCTURAL = new Set([...Object.keys(EVENT_KINDS), ...Object.keys(SPAN_KINDS),
  'source', 'event', 'span', 'expert', 'enrich', 'claude-code', 'claude-cowork', 'codex', 'copilot', 'antigravity',
  'transcript', 'subagent-transcript', 'workflow-transcript', 'rollout', 'audit', 'registry', 'state-db', 'chat-session', 'trajectory-db',
  'main', 'subagent', 'workflow-agent', 'guardian', 'review', 'fork', 'automation', 'missing-transcript', 'source-deleted',
  'logged', 'inherited', 'none', 'user', 'assistant', 'system', 'harness', 'agent', 'ok', 'error', 'cancelled',
  'interrupted', 'open', 'unknown', 'warn', 'note', 'chat', 'malformed', 'undecoded', 'unpaired', 'tool-error',
  'api-error', 'retry', 'refusal', 'permission-denied', 'logging-gap', 'sequence', 'rate-limit']);
const NUMERIC_KEYS = new Set(['input', 'uncached', 'cache_read', 'cache_write', 'output', 'reasoning', 'total', 'context_window', 'usd', 'cumulative']);

export class CaptureRedactor {
  readonly report: CaptureRedactionReport;
  private key: string | Buffer;
  constructor(key?: string) {
    if (key !== undefined && Buffer.byteLength(key) < 16) throw new Error('A redaction identity key must contain at least 16 bytes');
    this.key = key ?? randomBytes(32);
    this.report = { profile: 'shareable', version: 1, keyId: this.token('key', 'identity'), replacements: 0,
      omitted: ['raw source lines', 'sidecar files', 'native records', 'free-form text', 'tool inputs and outputs', 'unrecognized metadata'] };
  }

  private token(kind: string, value: string): string {
    return createHmac('sha256', this.key).update(kind).update('\0').update(value).digest('hex').slice(0, 24);
  }
  id(value: string): string {
    // Preserve the agent prefix that existing filters use; the rest is a keyed opaque identity.
    const prefix = /^(?:cc|cw|cx|cp):/.exec(value)?.[0] ?? (value.startsWith('s_') ? 's_' : 'id_');
    return prefix + this.token('id', value);
  }
  private text(value: string, kind = 'text'): string {
    this.report.replacements++;
    return `<${kind}:${this.token(kind, value)}>`;
  }

  record(input: any): any {
    const rec = structuredClone(input);
    if (rec.rec === 'capture') {
      rec.host = { platform: rec.host.platform, arch: rec.host.arch };
      rec.scope.index = null;
      rec.scope.filter = rec.scope.filter ? this.text(rec.scope.filter) : null;
      rec.scope.sessions = rec.scope.sessions?.map((s: string) => this.id(s)) ?? null;
      rec.analysis.snapshot.pending = rec.analysis.snapshot.pending.map((s: string) => this.id(s));
      rec.analysis.snapshot.failed = rec.analysis.snapshot.failed.map((s: string) => this.id(s));
      rec.privacy = { ...this.report, replacements: undefined };
      return rec;
    }
    if (rec.rec === 'end') return { ...rec, privacy: { ...this.report } };
    delete rec.native;
    delete rec.meta;
    delete rec.fields;
    delete rec.git;
    delete rec.models;
    delete rec.sha256; // An original content digest can be used to correlate a private source with known data.
    for (const [key, value] of Object.entries(rec)) {
      if (typeof value !== 'string') continue;
      if (ID_KEYS.has(key)) rec[key] = this.id(value);
      else if (PATH_KEYS.has(key)) rec[key] = `/redacted/${this.token('path', value)}`;
      else if (!SAFE_TEXT.has(key) || !STRUCTURAL.has(value)) rec[key] = this.text(value);
    }
    if (rec.raw) {
      rec.raw.source = this.id(rec.raw.source);
      delete rec.raw.text;
      delete rec.raw.sha256;
    }
    if (rec.attrs) rec.attrs = this.attrs(rec.attrs);
    return rec;
  }

  private attrs(attrs: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    // Span inheritance controls counting after import; it is structural evidence, not free-form metadata.
    if (typeof attrs.inherited === 'boolean') out.inherited = attrs.inherited;
    for (const key of NUMERIC_ATTRS) if (attrs[key]) out[key] = Object.fromEntries(Object.entries(attrs[key]).filter(([k, v]) => NUMERIC_KEYS.has(k) && (typeof v === 'number' || typeof v === 'boolean')));
    if (typeof attrs.text_len === 'number') out.text_len = attrs.text_len;
    if (attrs.tool) {
      out.tool = {};
      for (const [key, value] of Object.entries(attrs.tool)) {
        if (ID_KEYS.has(key) && typeof value === 'string') out.tool[key] = this.id(value);
        else if (SAFE_TOOL.has(key) && (typeof value === 'number' || typeof value === 'boolean' || ['builtin','mcp','shell','file','web','agent','custom','plan','other'].includes(String(value)))) out.tool[key] = value;
      }
      if (typeof attrs.tool.name === 'string') out.tool.name = this.text(attrs.tool.name, 'tool');
    }
    if (attrs.llm) {
      out.llm = {};
      for (const [k, v] of Object.entries(attrs.llm)) {
        if (ID_KEYS.has(k) && typeof v === 'string') out.llm[k] = this.id(v);
        else if (typeof v === 'number' && ['thinking_ms', 'ttft_ms', 'latency_ms', 'block_index'].includes(k)) out.llm[k] = v;
      }
    }
    if (attrs.agent?.link_session) out.agent = { link_session: this.id(attrs.agent.link_session) };
    return out;
  }
}
