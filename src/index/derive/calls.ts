// Call statistics (the `call_stats` table): each session's tool calls and Codex inner items grouped as Statistics ▸
// Tools and Endpoints group them, by tool name, MCP server, program, host, agent type and the model that issued the
// call, from their target keys (SPEC §12.3.4), span timings and worst failure tiers; and its hook runs by hook. The read
// side then merges a few rows per session instead of reading every span. A tool call's duration that is `unbounded`
// counts in `dur_src` but stays out of `durs`.

import { FAILURE_TIERS, type FailureTier, type ToolKindTag } from '../../model/types.ts';
import type { CallKeyRow, CallStatRow, Derived, SessionStatRow } from './model.ts';
import type { Ev, Ses, Span } from './tree.ts';

type Kind = CallStatRow['kind'];

/** The idle gap (SPEC §7.2): a timestamp gap this long may hold idle time or an approval wait. */
export const IDLE_GAP_US = 300_000_000;

/**
 * A tool call's duration that bounds nothing: a timestamp gap of at least IDLE_GAP_US, which may hold idle time. A
 * delegation's gap is the child's run, so `agent` calls keep theirs.
 */
export function unbounded(dur: number | null, src: string | null, toolKind: ToolKindTag | null): boolean {
  return dur != null && dur >= IDLE_GAP_US && !!src?.startsWith('derived') && toolKind !== 'agent';
}

/** The keyed kinds by the tool kind of their calls; `tool` takes every tool span (not inner items) by name. */
const KIND_OF: Partial<Record<ToolKindTag, CallKeyRow['kind']>> = { mcp: 'server', shell: 'program', web: 'host', agent: 'agent' };

export function deriveCallStats(d: Derived): void {
  // A failure row belongs to the span of its call (an inner item's own span).
  const worst = new Map<string, FailureTier>();
  for (const f of d.failures) {
    const span = d.tree.byRid.get(f.callRid ?? f.rid)?.span;
    const prev = span ? worst.get(span) : undefined;
    if (span && (!prev || FAILURE_TIERS.indexOf(f.tier) < FAILURE_TIERS.indexOf(prev))) worst.set(span, f.tier);
  }
  for (const s of d.tree.sessions) {
    const rows = new Map<string, CallStatRow>();
    const row = (kind: Kind, key: string) => {
      let r = rows.get(`${kind}\n${key}`);
      if (!r) rows.set(`${kind}\n${key}`, (r = { sessionId: s.id, kind, key, calls: 0, durs: [], durSrc: {}, tiers: {}, firstTs: null, lastTs: null }));
      return r;
    };
    // Model and hook spans keep every duration (toolKind null); only tool calls can be unbounded.
    const add = (kind: Kind, key: string | null, dur: number | null, src: string | null, tier: FailureTier | null, start: number | null, toolKind: ToolKindTag | null) => {
      if (key == null) return;
      const r = row(kind, key);
      const known = dur != null && !!src && src !== 'unknown';
      r.calls++;
      if (known && !(toolKind && unbounded(dur, src, toolKind))) r.durs.push(dur);
      const source = known ? src : 'unknown';
      r.durSrc[source] = (r.durSrc[source] ?? 0) + 1;
      if (tier) r.tiers[tier] = (r.tiers[tier] ?? 0) + 1;
      if (start != null) {
        r.firstTs = r.firstTs == null ? start : Math.min(r.firstTs, start);
        r.lastTs = r.lastTs == null ? start : Math.max(r.lastTs, start);
      }
    };
    for (const a of d.actions.get(s.id) ?? []) {
      const call = a.call;
      const sp = (a.kind === 'tool' || a.kind === 'item') && call?.span ? d.tree.span.get(call.span) : undefined;
      if (!call || !sp || (sp.kind !== 'tool' && sp.kind !== 'exec') || sp.firstEvent !== call.id) continue;
      const tool = a.tool ?? '';
      const at = (kind: Kind, key: string | null) => add(kind, key, sp.dur, sp.durSrc, worst.get(sp.id) ?? null, sp.start, call.toolKind);
      if (sp.kind === 'tool') {
        at('tool', tool || '(unknown)');
        at('model', issuer(d, call, sp));
      }
      const kind = call.toolKind ? KIND_OF[call.toolKind] : undefined;
      const key = kind && (kind === 'server' ? str(call.a.tool?.server) ?? /^mcp__(.+?)__/.exec(tool)?.[1] ?? tool : groupKey(kind, a.key));
      if (kind && key != null) {
        at(kind, key);
        d.callKeys.push({ spanId: sp.id, sessionId: s.id, kind, key });
      }
    }
    // Hooks: their logged duration, else the span. Hook rows count no tiers.
    for (const sp of s.spans) {
      if (sp.kind !== 'hook' || !sp.hook) continue;
      const key = `${sp.hook.event ?? sp.name ?? '?'}:${sp.hook.command ?? '?'}`;
      if (sp.hook.ms != null) add('hook', key, Math.round(sp.hook.ms * 1000), 'logged:hook.duration_ms', null, sp.start, null);
      else add('hook', key, sp.dur, sp.durSrc, null, sp.start, null);
    }
    sessionStats(d, s);
    for (const r of rows.values()) {
      r.durs.sort((x, y) => x - y);
      d.callStats.push(r);
    }
  }
}

/**
 * The model that issued a tool call (Statistics ▸ Tools by model): the call's own model (Claude logs it on each call),
 * else its turn's (Codex logs one per turn), else `(unknown)`.
 */
function issuer(d: Derived, call: Ev, sp: Span): string {
  return call.model ?? (sp.parent ? d.tree.span.get(sp.parent)?.model : null) ?? '(unknown)';
}

/** Token fields of an llm span that Statistics ▸ Models sums. */
const TOKEN_FIELDS = ['input', 'uncached', 'cache_read', 'cache_write', 'output', 'reasoning'] as const;

/** `session_stats`: the session's own events by kind and proto, its llm spans by model (span durations, tokens). */
function sessionStats(d: Derived, s: Ses): void {
  const rows = new Map<string, SessionStatRow>();
  const row = (kind: SessionStatRow['kind'], key: string) => {
    let r = rows.get(`${kind}\n${key}`);
    if (!r) {
      r = kind === 'event' ? { sessionId: s.id, kind, key, n: 0, bytes: 0, durs: null, tokens: null } : { sessionId: s.id, kind, key, n: 0, bytes: null, durs: [], tokens: {} };
      rows.set(`${kind}\n${key}`, r);
    }
    r.n++;
    return r;
  };
  for (const e of s.events) row('event', `${e.kind} ${e.proto}`).bytes! += e.bytes;
  for (const sp of s.spans) {
    if (sp.kind !== 'llm') continue;
    const r = row('model', sp.model ?? (sp.name || null) ?? '(unknown)');
    if (sp.dur != null) r.durs!.push(sp.dur);
    for (const k of TOKEN_FIELDS) {
      const v = sp.tokens?.[k];
      if (typeof v === 'number') r.tokens![k] = (r.tokens![k] ?? 0) + v;
    }
  }
  for (const r of rows.values()) {
    r.durs?.sort((x, y) => x - y);
    d.sessionStats.push(r);
  }
}

/** The group of a program, host or agent call from its target key; null leaves the call out. */
export function groupKey(kind: string, t: string): string | null {
  if (kind === 'program') return t.startsWith('sh:') ? t.slice(3) : t.startsWith('read:') ? 'read' : null;
  // A web call without a URL (a search) keeps its `tool:` key.
  if (kind === 'host') return t.startsWith('web:') ? t.slice(4) : t;
  return t.startsWith('agent:') ? t.slice(6) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
