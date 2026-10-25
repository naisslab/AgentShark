// Steps (SPEC §12.3.2): one model response with its calls and their results.
// Claude and Cowork: one step per API response (llm.message_id, logged). Codex: each call joins the first non-dup
// llm.usage after it in its turn (derived), with the cross-turn and trailing cases marked inferred.

import type { Prov, StepRow } from '../../model/types.ts';
import { IDLE_GAP_US, unbounded } from './calls.ts';
import type { Derived } from './model.ts';
import type { Ev, Ses } from './tree.ts';

export const CROSS_TURN_RULE = 'cross-turn@1';
export const TRAILING_RULE = 'trailing@1';
export const CTX_WINDOW_RULE = 'ctx-window@1';
const MEMBER_KINDS = new Set(['llm.text', 'llm.thinking', 'tool.call', 'llm.usage', 'llm.error', 'llm.refusal', 'agent.spawn']);
const INTENT_MAX = 200;

interface Draft {
  anchor: number;
  members: Ev[];
  usage: Ev | null;
  llmSpan: string | null;
  segSrc: Prov;
}

export function deriveSteps(d: Derived): void {
  for (const s of d.tree.sessions) {
    const drafts = s.agent === 'codex' ? codexDrafts(d, s) : claudeDrafts(s);
    if (!drafts.length) {
      d.stepsBySession.set(s.id, []);
      continue;
    }
    drafts.sort((a, b) => a.anchor - b.anchor);
    const rows = drafts.map((dr, i) => stepRow(d, s, dr, i + 1));
    finishSession(d, s, drafts, rows);
  }
}

/** Claude: events sharing llm.message_id form one step; thinking blocks (no attrs loaded) join through their llm span. */
function claudeDrafts(s: Ses): Draft[] {
  const spanMid = new Map<string, string>();
  for (const e of s.events) {
    const mid = e.a.llm?.message_id;
    if (typeof mid === 'string' && e.span) spanMid.set(e.span, mid);
  }
  const groups = new Map<string, Draft>();
  for (const e of s.events) {
    if (!MEMBER_KINDS.has(e.kind)) continue;
    const mid = (typeof e.a.llm?.message_id === 'string' ? e.a.llm.message_id : null) ?? (e.span ? spanMid.get(e.span) : undefined);
    if (!mid) continue;
    let g = groups.get(mid);
    if (!g) groups.set(mid, (g = { anchor: e.seq, members: [], usage: null, llmSpan: null, segSrc: 'logged:llm.message_id' }));
    g.members.push(e);
    if (e.kind === 'llm.usage') g.usage = e;
    if (!g.llmSpan && e.span && e.kind !== 'tool.call') g.llmSpan = e.span;
  }
  return [...groups.values()];
}

/** Codex: one step per non-dup llm.usage; model output and calls join the first usage after them in their turn. */
function codexDrafts(d: Derived, s: Ses): Draft[] {
  const byTurn = new Map<string | null, Draft[]>();
  const all: Draft[] = [];
  let lastUsageSeq = -1;
  for (const e of s.events) {
    if (e.kind !== 'llm.usage') continue;
    const sp = e.span ? d.tree.span.get(e.span) : undefined;
    const dr: Draft = { anchor: e.seq, members: [e], usage: e, llmSpan: sp?.kind === 'llm' ? sp.id : null, segSrc: 'derived:next-usage' };
    let list = byTurn.get(e.turn);
    if (!list) byTurn.set(e.turn, (list = []));
    list.push(dr);
    all.push(dr);
    lastUsageSeq = e.seq;
  }
  const trailing = new Map<string | null, Draft>();
  for (const e of s.events) {
    if (!MEMBER_KINDS.has(e.kind) || e.kind === 'llm.usage') continue;
    const list = byTurn.get(e.turn) ?? [];
    const next = firstAfter(list, e.seq);
    if (next) {
      next.members.push(e);
      continue;
    }
    if (e.seq < lastUsageSeq && list.length) {
      const last = list[list.length - 1];
      last.members.push(e);
      last.segSrc = `inferred:${CROSS_TURN_RULE}`;
      continue;
    }
    let tr = trailing.get(e.turn);
    if (!tr) {
      trailing.set(e.turn, (tr = { anchor: e.seq, members: [], usage: null, llmSpan: null, segSrc: `inferred:${TRAILING_RULE}` }));
      all.push(tr);
    }
    tr.members.push(e);
  }
  return all;
}

/** Index of the first draft anchored after `seq` (drafts in anchor order), or list.length. */
function indexAfter(list: Draft[], seq: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].anchor > seq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function firstAfter(list: Draft[], seq: number): Draft | null {
  return list[indexAfter(list, seq)] ?? null;
}

function stepRow(d: Derived, s: Ses, dr: Draft, n: number): StepRow {
  const span = dr.llmSpan ? d.tree.span.get(dr.llmSpan) : undefined;
  const tokens = dr.usage?.a.tokens;
  let start = span?.start ?? Infinity;
  let end = span?.end ?? -Infinity;
  for (const m of dr.members) {
    if (m.ts < start) start = m.ts;
    if (m.ts > end) end = m.ts;
  }
  let modelUs: number | null = null;
  let modelSrc: Prov | null = null;
  const latency = num(dr.usage?.a.llm?.latency_ms);
  if (s.agent !== 'codex' && latency !== null) {
    modelUs = Math.round(latency * 1000);
    modelSrc = 'logged:llm.latency_ms';
  } else if (span?.dur != null) {
    modelUs = span.dur;
    modelSrc = provOf(span.durSrc);
  }
  const intent = intentOf(dr.members);
  const turn = dr.members.find((m) => m.turn)?.turn ?? null;
  return {
    id: `${s.id}#step:${n}`, sessionId: s.id, turnId: turn, n, llmSpanId: dr.llmSpan, startTs: start, endTs: end === -Infinity ? null : end,
    ctxTokens: num(tokens?.input), ctxWindow: null, ctxWindowSrc: null, tokOut: num(tokens?.output), tokUncached: num(tokens?.uncached),
    nCalls: dr.members.filter((m) => m.kind === 'tool.call').length, nFail: 0, modelUs, modelSrc, toolUs: null,
    intent: intent?.text ?? null, intentSrc: intent?.src ?? null, compactionBefore: false, attachments: null, segSrc: dr.segSrc,
  };
}

/** Claude Bash `input.description`, else the first line of the step's text. */
function intentOf(members: Ev[]): { text: string; src: Prov } | null {
  for (const m of members) {
    const desc = m.kind === 'tool.call' && m.tool === 'Bash' ? (m.a.tool?.input as any)?.description : undefined;
    if (typeof desc === 'string' && desc.trim()) return { text: desc.trim().slice(0, INTENT_MAX), src: 'logged:tool.input.description' };
  }
  for (const m of members) {
    if (m.kind !== 'llm.text' || typeof m.a.text !== 'string') continue;
    const line = m.a.text.split('\n').find((l) => l.trim());
    if (line) return { text: line.trim().slice(0, INTENT_MAX), src: 'derived:first-text-line' };
  }
  return null;
}

/** Results and Codex items join their call's step; context windows, tool time and compactions need the whole session. */
function finishSession(d: Derived, s: Ses, drafts: Draft[], rows: StepRow[]): void {
  const callStep = new Map<string, number>();
  const own = new Map<number, number>();
  drafts.forEach((dr, i) => {
    for (const m of dr.members) {
      own.set(m.rid, i);
      const cid = m.kind === 'tool.call' ? m.a.tool?.call_id : undefined;
      if (typeof cid === 'string') callStep.set(cid, i);
    }
  });
  const toolSpans: [number, number][][] = rows.map(() => []);
  const join = (e: Ev, i: number) => {
    own.set(e.rid, i);
    if (e.ts > (rows[i].endTs ?? -Infinity)) rows[i].endTs = e.ts;
  };
  for (const e of s.events) {
    if (e.kind === 'tool.result') {
      const i = callStep.get(e.a.tool?.call_id as string);
      if (i !== undefined) join(e, i);
    } else if (e.kind === 'tool.exec') {
      const exec = e.span ? d.tree.span.get(e.span) : undefined;
      const parent = exec?.parent ? d.tree.span.get(exec.parent) : undefined;
      const call = parent?.firstEvent ? d.tree.byId.get(parent.firstEvent) : undefined;
      const i = call ? own.get(call.rid) : undefined;
      if (i !== undefined) join(e, i);
    }
  }
  drafts.forEach((dr, i) => {
    for (const m of dr.members) {
      if (m.kind !== 'tool.call' || !m.span) continue;
      const sp = d.tree.span.get(m.span);
      // An unbounded timestamp gap counts up to the idle gap; the rest of it is the step's gap, not tool time.
      if (sp?.start != null && sp.end != null && sp.end >= sp.start) toolSpans[i].push([sp.start, unbounded(sp.dur, sp.durSrc, m.toolKind) ? sp.start + IDLE_GAP_US : sp.end]);
    }
  });
  // Claude's context window is not logged: 1M if the session ever goes above 200k tokens, else 200k.
  const claudeWindow = s.agent === 'codex' ? null : rows.some((r) => (r.ctxTokens ?? 0) > 200_000) ? 1_000_000 : 200_000;
  const compactions = s.events.filter((e) => e.kind === 'context.compaction').map((e) => e.seq);
  let prevEnd = -Infinity;
  rows.forEach((r, i) => {
    const dr = drafts[i];
    const window = s.agent === 'codex' ? num(dr.usage?.a.tokens?.context_window) : claudeWindow;
    if (window !== null) {
      r.ctxWindow = window;
      r.ctxWindowSrc = s.agent === 'codex' ? 'logged:tokens.context_window' : `inferred:${CTX_WINDOW_RULE}`;
    }
    r.toolUs = toolSpans[i].length ? unionUs(toolSpans[i]) : null;
    let first = Infinity;
    let last = -Infinity;
    for (const m of dr.members) {
      first = Math.min(first, m.seq);
      last = Math.max(last, m.seq);
    }
    r.compactionBefore = compactions.some((c) => c > prevEnd && c < first);
    prevEnd = last;
  });
  // The context lane: attachments injected before a step, counted by type on the first step after them.
  for (const e of s.events) {
    const type = e.kind === 'context.attachment' ? e.a.context?.type : undefined;
    const i = typeof type === 'string' ? indexAfter(drafts, e.seq) : drafts.length;
    if (i === drafts.length) continue;
    const counts = (rows[i].attachments ??= {});
    counts[type as string] = (counts[type as string] ?? 0) + 1;
  }
  for (const [rid, i] of own) {
    d.stepOf.set(rid, { id: rows[i].id, n: rows[i].n });
    d.stepEvents.push({ rid, stepId: rows[i].id, sessionId: s.id });
  }
  for (const r of rows) d.steps.push(r);
  d.stepsBySession.set(s.id, rows);
}

function unionUs(iv: [number, number][]): number {
  iv.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = iv[0];
  for (let i = 1; i < iv.length; i++) {
    const [a, b] = iv[i];
    if (a <= ce) ce = Math.max(ce, b);
    else {
      total += ce - cs;
      [cs, ce] = [a, b];
    }
  }
  return total + ce - cs;
}

export function provOf(src: string | null | undefined): Prov | null {
  if (!src || src === 'unknown') return null;
  return /^(logged|derived|parsed)(:|$)|^inferred:.+@/.test(src) ? (src as Prov) : `derived:${src}`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
