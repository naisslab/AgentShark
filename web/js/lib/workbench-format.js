// Pure text for the Workbench page (docs/analyses/ANALYSIS-UX.md §6.4): durations, shares, counts with nouns, clock
// times, run titles, gap sentences, the Critical Path (§4.3–§4.9) and Compare Runs (§5.5–§5.10) summaries, failure
// states, and how a recipe's input splits between the pickers and Advanced JSON. No DOM access, so
// test/web/workbench-format.test.ts checks every row of the §5.14 table against these functions.

import { AGENTS, agentLabel, formatClock, formatClockCompact, formatDuration, formatInt, formatShortDate, formatTokens, plural, sameDay, tzOffset } from './format.js';

export const DASH = '—';
export const NOT_DETERMINED = 'Not determined by the logs';
export const PRECISION = 'Precision not yet checked.';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const trimZero = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Values

/** A duration from µs (DESIGN §9): "0.85ms" below a millisecond and "0ms" for a measured zero, else formatDuration. */
export function duration(us) {
  if (!isNum(us)) return '';
  const a = Math.abs(us);
  if (a >= 1000) return formatDuration(us);
  return (us < 0 ? '−' : '') + (a === 0 ? '0ms' : `${trimZero((a / 1000).toPrecision(3))}ms`);
}

/** A 0..1 share as a whole percentage (§4.7): "51%", and "<1%" for a non-zero share below 0.5%. */
export function share(p) {
  if (!isNum(p)) return '';
  return p > 0 && p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`;
}

/** "5m 52s of 11m 30s (51%)". The share comes from the API, so the page never divides (§4.6). */
export function part(us, wholeUs, p) {
  const s = share(p);
  return `${duration(us)} of ${duration(wholeUs)}${s ? ` (${s})` : ''}`;
}

/** A count with its noun in the right number: count(1, ['reread', 'rereads']) → "1 reread". */
export function count(n, [one, many]) {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

/** Plain numbers: integers (and anything from 100 up) with separators, smaller fractions to three significant digits. */
export function number(n) {
  if (!isNum(n)) return '';
  return Number.isInteger(n) || Math.abs(n) >= 100 ? formatInt(n) : n.toLocaleString('en-US', { maximumSignificantDigits: 3 });
}

/** Clock time for lists that sit under a "Times +08:00" header; the short date prefix appears when the date changes. */
export function clock(ts, prev) {
  return isNum(ts) ? formatClockCompact(ts, prev) : '';
}

/** The full form, for tooltips only: "2026-10-12 14:03:07.348 +08:00". */
export function fullTime(ts) {
  return isNum(ts) ? formatClock(ts, { offset: true }) : '';
}

/** "Times +08:00", the header every list of clock times sits under. */
export function timesHeader(ts) {
  return `Times ${tzOffset(isNum(ts) ? ts : undefined)}`;
}

/** "2026-10-12 14:03:07 → 18:20:11 +08:00": a clock range with its offset; the second date only when it differs. */
export function clockRange(a, b) {
  if (!isNum(a) || !isNum(b)) return DASH;
  const end = formatClock(b, { digits: 0, date: !sameDay(a, b) });
  return `${formatClock(a, { digits: 0 })} → ${end} ${tzOffset(a)}`;
}

/** "Oct 21 14:02": a run's start in picker options and run cells. */
export function dateTime(ts, now = Date.now() * 1000) {
  if (!isNum(ts)) return '';
  return `${formatShortDate(ts, now)} ${formatClock(ts, { digits: 0, date: false }).slice(0, 5)}`;
}

/** An identifier cut in the middle (DESIGN §3.5): 6 leading and 4 trailing characters. */
export function midId(id) {
  const s = String(id ?? '');
  return s.length > 11 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/** A "2.03×" ratio. */
export function ratio(r) {
  return isNum(r) ? `${r.toFixed(2)}×` : '';
}

// ---------------------------------------------------------------------------
// Runs and sessions

/**
 * One shape for a run's identity, from the engine's envelope `sessions` map (`startTs`, `endTs`) or from an
 * /api/sessions row (`start`, `end`, `nativeId`).
 */
export function sessionInfo(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    title: row.title ?? null, agent: row.agent ?? null, role: row.role ?? null, parentId: row.parentId ?? null,
    startTs: row.startTs ?? row.start ?? null, endTs: row.endTs ?? row.end ?? null, nativeId: row.nativeId ?? null,
  };
}

/** A run's title (§5.14: never the id when a title exists); a subagent without one is named by its native id. */
export function sessionTitle(id, known) {
  const s = known?.get(id);
  return s?.title?.trim() || (s?.nativeId && s.role && s.role !== 'main' ? s.nativeId.split('/').pop() : '') || midId(id);
}

/** A picker option (§6.5): "{title} · {date time} · {agent}", so two runs with one title stay apart. */
export function sessionOption(row, now) {
  const s = sessionInfo(row);
  return [sessionTitle(row.id, new Map([[row.id, s]])), dateTime(s.startTs, now), s.agent ? agentLabel(s.agent) : ''].filter(Boolean).join(' · ');
}

/** The root of a subagent, through the `parentId` chain of the known runs (§4.3 Show Whole Run). */
export function rootOf(id, known) {
  const seen = new Set();
  let at = id;
  while (known?.get(at)?.parentId && !seen.has(at)) {
    seen.add(at);
    at = known.get(at).parentId;
  }
  return at;
}

const sameTitle = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

// ---------------------------------------------------------------------------
// Coverage

/**
 * One sentence per gap (§4.4, Decision 12): the engine's `coverage.notes` text, else a perf `missing` effect, else
 * the code. The code itself belongs in a tooltip.
 */
export function gapNotes(result) {
  const cov = result?.coverage ?? {};
  const notes = new Map((Array.isArray(cov.notes) ? cov.notes : []).filter((n) => n?.code).map((n) => [n.code, n.text]));
  const effects = new Map((Array.isArray(result?.missing) ? result.missing : []).filter((m) => m?.code).map((m) => [m.code, m.effect]));
  const codes = [...new Set([...(cov.gaps ?? []), ...notes.keys()])];
  return codes.map((code) => ({ code, text: notes.get(code) || effects.get(code) || code }));
}

/** Words that keep their capital after a semicolon: the agents' names. */
const AGENT_NAMES = new Set(AGENTS.flatMap((a) => a.label.split(' ')));

/**
 * The one-line data-gap line of every analysis and derived view (§4.4, §5.8; DESIGN §1.7), the Mac's
 * `AnalysisVocabulary.gapHeadline` word for word: one gap reads as its sentence; several read "3 data gaps: Request
 * queueing at the provider is inside model or unattributed time; approvals are not logged, so approval waits count as
 * tool time; …", every gap included. The engine's sentences hold no semicolon, so each "; " parts two gaps. A later
 * sentence starts lowercase unless its first word is a name: an agent's ("Claude", "Codex"), or one with a capital
 * past its first letter ("MCP"). Two gap codes can carry one sentence, which reads, and counts, once. The line cuts at
 * its tail, so the list under it keeps the full sentences. Empty for no gap.
 */
export function gapHeadline(sentences) {
  const parts = [...new Set(sentences.map((s) => s.replace(/\.$/, '')))];
  if (parts.length < 2) return parts.length ? `${parts[0]}.` : '';
  const continuation = (s) => {
    const word = s.match(/^\p{L}*/u)[0];
    return AGENT_NAMES.has(word) || /\p{Lu}/u.test(word.slice(1)) ? s : s.charAt(0).toLowerCase() + s.slice(1);
  };
  return `${count(parts.length, ['data gap', 'data gaps'])}: ${parts.map((s, i) => (i ? continuation(s) : s)).join('; ')}`;
}

/** The evidence line's data-gap line, from `gapNotes`. */
export function gapLine(notes) {
  return gapHeadline(notes.map((n) => n.text));
}

/** "6,262 of 6,262 events · Times +08:00" (§4.4), plus the session count when the analysis spans several. */
export function coverageLine(result) {
  const cov = result?.coverage ?? {};
  const n = cov.sessionIds?.length ?? 0;
  return [
    isNum(cov.eventsExamined) && isNum(cov.eventsAvailable) ? `${formatInt(cov.eventsExamined)} of ${plural(cov.eventsAvailable, 'event')}` : null,
    n > 1 ? plural(n, 'session') : null,
    timesHeader(cov.snapshotAt),
  ].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Critical Path (AgentPerf, §4)

/** Engine classes in the fixed order of the class bar (§4.7), so two runs read alike. */
export const CLASSES = [
  ['model', 'Model'], ['tools', 'Tools'], ['harness', 'Compaction'], ['coordination', 'Waiting on other agents'],
  ['people', 'Waiting on people'], ['idle', 'Idle between turns'], ['unattributed', 'Unattributed'],
];
const CLASS_NAME = Object.fromEntries(CLASSES);
export const className = (c) => CLASS_NAME[c] ?? String(c);

/** Time buckets as the viewer names them, plus the four the critical path adds. */
export const BUCKET_NAME = {
  model: 'Model', 'api-retry': 'API retries', tool: 'Tools', 'wait-process': 'Waiting for a process', hook: 'Hooks', compaction: 'Compaction',
  'wait-agent': 'Waiting for a subagent', 'wait-human': 'Waiting for a human', 'human-gap': 'Between prompts', continuation: 'Idle between turns',
  coordination: 'Waiting on other agents', unattributed: 'Unattributed',
};

export const DERIVED_SHARE = `Derived: the largest share of the critical path (rule derived:largest-share). ${PRECISION}`;
export const PERF_SCOPE = 'Whole run: subagents are always included.';

/** The header line (§4.3): "11m 30s critical path · 5 of 37 sessions on the path". */
export function perfHeader(result, known) {
  const cp = result?.criticalPath ?? {};
  const onPath = cp.bySession?.length ?? 0;
  const total = result?.coverage?.sessionIds?.length ?? onPath;
  const role = known?.get(result?.sessionId)?.role;
  return [
    isNum(cp.wallUs) && cp.wallUs > 0 ? `${duration(cp.wallUs)} critical path` : 'Critical path',
    role && role !== 'main' ? 'Subagent run' : null,
    `${formatInt(onPath)} of ${plural(total, 'session')} on the path`,
  ].filter(Boolean).join(' · ');
}

/**
 * The partial-window warning (§4.5), or null. Engine 1.1 states the window: "Analysed 50,000 of 84,340 events: " and
 * the engine's note for the gap, verbatim. Merged sources load in sequence order, so the loaded events need not start
 * at the session's start and neither part says "first". Against an older engine the event limit shows the analysed
 * range beside the session's own, again without "first", and the page computes no duration.
 */
export function perfWindow(result, root) {
  const cov = result?.coverage ?? {};
  const cp = result?.criticalPath ?? {};
  const gaps = cov.gaps ?? [];
  const counts = `${formatInt(cov.eventsExamined)} of ${plural(cov.eventsAvailable, 'event')}`;
  const w = cp.window;
  if (gaps.includes('critical-path-window-partial')) {
    const note = (Array.isArray(cov.notes) ? cov.notes : []).find((n) => n?.code === 'critical-path-window-partial')?.text;
    if (note) return `Analysed ${counts}: ${note}`;
    if (w) return `Analysed ${counts}: the path covers ${duration(w.analyzedUs)} of this session's ${duration(w.sessionUs)}${isNum(w.share) ? ` (${share(w.share)})` : ''}.`;
  }
  if (w || !gaps.includes('event-limit')) return null;
  const session = root && isNum(root.startTs) && isNum(root.endTs) ? ` Session: ${clockRange(root.startTs, root.endTs)}.` : '';
  return `Analysed ${counts}. Analysed: ${clockRange(cp.startTs, cp.endTs)}.${session}`;
}

/**
 * The verdict (§4.6): `lines` (Title role) and `notes` (secondary), each `{ text, derived }`; a derived line ends
 * in ≈ with DERIVED_SHARE in its tooltip. Headlines state the largest share, never a cause (Decision 9).
 */
export function perfVerdict(result) {
  const cp = result?.criticalPath ?? {};
  const wall = cp.wallUs;
  const empty = { state: 'empty', lines: [{ text: "No timed activity on this run's critical path.", derived: false }], notes: [] };
  if (!isNum(wall) || wall <= 0 || !cp.binding) return empty;
  const of = (c) => part(cp.byClass?.[c]?.us ?? 0, wall, cp.byClass?.[c]?.share ?? null);
  if ((result.coverage?.gaps ?? []).includes('critical-path-mostly-unexplained')) {
    const u = cp.byClass?.unattributed;
    const lines = [{ text: `Not established: ${duration(u?.us ?? 0)} of the ${duration(wall)} critical path (${share(u?.share) || DASH}) is unattributed.`, derived: false }];
    if (cp.largestAttributedClass) lines.push({ text: `Largest attributed share: ${className(cp.largestAttributedClass)}, ${of(cp.largestAttributedClass)}`, derived: true });
    return { state: 'not-established', lines, notes: [{ text: 'The logs do not explain most of the path; see the data gaps.', derived: false }] };
  }
  const lines = [{ text: `Largest share of the critical path: ${className(cp.binding)}, ${of(cp.binding)}`, derived: true }];
  // An engine before 1.1 can name `unattributed` as the agent-side class; no line headlines unexplained time.
  const agent = cp.agentBinding && cp.agentBinding !== cp.binding && cp.agentBinding !== 'unattributed' ? cp.agentBinding : null;
  if (agent) lines.push({ text: `Largest agent-side share: ${className(agent)}, ${of(agent)}`, derived: true });
  const shown = new Set([cp.binding, agent]);
  const notes = (cp.advice ?? []).filter((a) => shown.has(a.class) && a.text).map((a) => ({ text: a.text, derived: true }));
  return { state: 'normal', lines, notes };
}

/** Legend rows (§4.7) in the fixed class order: name, time, share and the full "{part}" form for the bar's label. */
export function classRows(cp) {
  return CLASSES.filter(([c]) => cp?.byClass?.[c]).map(([c, name]) => {
    const v = cp.byClass[c];
    return { cls: c, name, us: v.us, share: v.share, time: duration(v.us), shareText: share(v.share) || DASH, part: part(v.us, cp.wallUs, v.share) };
  });
}

/** "Share (of 11m 30s path)": the denominator every perf share is taken against. */
export function pathShareHeader(cp) {
  return isNum(cp?.wallUs) ? `Share (of ${duration(cp.wallUs)} path)` : 'Share of path';
}

/** A lane name (§4.8): the analysed run is "Main", its children "Subagent · {title}". */
export function laneName(id, rootId, known) {
  return id === rootId ? 'Main' : `Subagent · ${sessionTitle(id, known)}`;
}

/** A model step on the path (§4.9): "Step 40 · Run the auth tests" from engine 1.1, else "Step" and the id. */
export function stepName(step) {
  if (isNum(step?.stepN)) return step.intent ? `Step ${formatInt(step.stepN)} · ${step.intent}` : `Step ${formatInt(step.stepN)}`;
  return `Step ${midId(step?.key)}`;
}

export const REWORK = [
  ['rereads', 'Rereads', ['reread', 'rereads']], ['reverts', 'Reverts', ['revert', 'reverts']], ['blindRetries', 'Blind retries', ['blind retry', 'blind retries']],
  ['repeatedSearches', 'Repeated searches', ['repeated search', 'repeated searches']], ['fixLoops', 'Fix loops', ['fix loop', 'fix loops']],
];

/** "2.03× parallel: 18m 40s of agent work in a 9m 12s span · 1m 05s waiting on other agents" (§4.9). */
export function parallelLine(c) {
  if (!c) return '';
  const wait = `${duration(c.coordinationUs ?? 0)} waiting on other agents`;
  if (!isNum(c.parallelism) || !isNum(c.spanUs)) return `${duration(c.workUs ?? 0)} of agent work · ${wait}`;
  return `${ratio(c.parallelism)} parallel: ${duration(c.workUs)} of agent work in a ${duration(c.spanUs)} span · ${wait}`;
}

// ---------------------------------------------------------------------------
// Compare Runs (AgentDiff, §5)

export const LEAD = 'A lead for investigation, not a cause.';
/** The two gaps every diff carries; they live on the caveat line (§5.8), not the data-gap line. */
export const PERMANENT_GAPS = {
  'alignment-is-structural-not-causal': 'The alignment pairs actions by structure, not cause.',
  'shell-changes-invisible': 'Shell commands can change files without a logged edit.',
};
export const DEFAULT_ACTION_LIMIT = 1500;

export const OP_WORD = {
  edit: 'edit', read: 'read', search: 'search', test: 'test', build: 'build', typecheck: 'typecheck', vcs: 'version control', install: 'install',
  run: 'run', web: 'web', mcp: 'MCP', delegate: 'delegate', wait: 'wait', plan: 'plan', ask: 'ask', other: 'other',
};
export const STATUS_WORD = {
  same: 'Same', 'outcome-differs': 'Different outcome', 'object-differs': 'Different target', 'left-only': 'Only in A', 'right-only': 'Only in B',
};
const OUTCOME_WORD = { ok: 'succeeded', failed: 'failed', unknown: 'outcome not logged' };

/** An action's object without what the op word already says (§5.10); a search names its target, the digest is in the tooltip. */
export function actionObject(view) {
  const o = String(view?.object ?? '');
  if (o.startsWith('edit:') || o.startsWith('read:')) return { text: o.slice(5), title: null };
  if (view?.op === 'search') return { text: o.split('#')[0].replace(/^sh:/, ''), title: o };
  return { text: o, title: null };
}

/** "edit src/auth/session.ts", "search rg", "test sh:npm test". */
export function actionText(view) {
  return `${OP_WORD[view?.op] ?? view?.op ?? ''} ${actionObject(view).text}`.trim();
}

const ordinal = (n) => `${formatInt(n)}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** One side's state descriptor for a row tooltip: "3rd edit of this file; the last check before it failed". */
export function actionState(view) {
  if (!view) return '';
  const parts = [];
  if (isNum(view.editsBefore)) parts.push(view.op === 'edit' ? `${ordinal(view.editsBefore + 1)} edit of this file` : `${count(view.editsBefore, ['earlier edit', 'earlier edits'])} of this file`);
  if (view.checkBefore) parts.push(`the last check before it ${view.checkBefore === 'ok' ? 'passed' : 'failed'}`);
  return parts.join('; ');
}

/** The confidence mark of an aligned row (Decision 13): ≈ derived, ? candidate. */
export function confidenceMark(c) {
  return c === 'derived' ? '≈' : c === 'candidate' ? '?' : '';
}

/**
 * "Candidate pairing. This action occurs more than once in a run (ambiguous). Precision not yet checked." An action
 * only one run has is paired with nothing, so it has no confidence to state (its status cell has no mark).
 */
export function confidenceNote(row) {
  if (!row?.left || !row?.right) return `Unpaired action: no action of the other run is paired with it. Rule weighted-action-lcs@1. ${PRECISION}`;
  const kind = row.confidence === 'derived' ? 'Derived' : 'Candidate';
  return `${kind} pairing.${row.ambiguous ? ' This action occurs more than once in a run (ambiguous).' : ''} Rule weighted-action-lcs@1. ${PRECISION}`;
}

/** The header line (§5.5): "2 runs · 1,299 aligned rows · subagents included". */
export function diffHeader(result, input) {
  const rows = result?.summary?.rows ?? result?.alignment?.length ?? 0;
  return `2 runs · ${plural(rows, 'aligned row')} · subagents ${input?.children === false ? 'excluded' : 'included'}`;
}

function deltaWords(d, more, fewer, fmt) {
  if (!isNum(d)) return { text: DASH, title: NOT_DETERMINED };
  if (d === 0) return { text: 'Same', title: null };
  return { text: `${d < 0 ? '↓' : '↑'} ${fmt(Math.abs(d))}${d < 0 ? fewer : more}`, title: null };
}

const countDelta = (d, noun) => deltaWords(d, noun ? ` more ${noun[Math.abs(d) === 1 ? 0 : 1]}` : ' more', noun ? ` fewer ${noun[Math.abs(d) === 1 ? 0 : 1]}` : ' fewer', formatInt);

/**
 * The runs grid (§5.6): one row per measure with the A and B cells and the unsigned difference in words. Each cell is
 * `{ text, sub?, title? }`; a missing value reads `—` with its reason.
 */
export function runsGrid(result, known, { limit = DEFAULT_ACTION_LIMIT, now } = {}) {
  const sides = [result?.left, result?.right];
  const m = sides.map((s) => s?.metrics ?? {});
  const d = result?.delta ?? {};
  const cell = (fn) => sides.map((s, i) => fn(m[i], s));
  const known0 = (v, text) => (isNum(v) ? { text } : { text: DASH, title: NOT_DETERMINED });
  const run = (s) => {
    const info = known?.get(s?.session);
    return {
      text: sessionTitle(s?.session, known),
      sub: [dateTime(info?.startTs, now), info?.agent ? agentLabel(info.agent) : '', isNum(s?.metrics?.sessions) ? plural(s.metrics.sessions, 'session') : ''].filter(Boolean).join(' · '),
      title: midId(s?.session), id: s?.session,
    };
  };
  const tokens = (x) => (x.tokensIn == null && x.tokensOut == null
    ? { text: DASH, title: 'Not logged for this agent.' }
    : { text: `${x.tokensIn == null ? DASH : formatTokens(x.tokensIn)} in · ${x.tokensOut == null ? DASH : formatTokens(x.tokensOut)} out` });
  const actions = (x) => {
    if (!isNum(x.actions)) return { text: DASH, title: NOT_DETERMINED };
    const text = isNum(x.alignedActions) ? `${formatInt(x.alignedActions)} aligned of ${plural(x.actions, 'action')}` : plural(x.actions, 'action');
    return { text, title: `Waits are not aligned. Limit: ${formatInt(limit)} actions per run.` };
  };
  return [
    { label: 'Run', cells: sides.map(run), diff: null },
    { label: 'Wall time', cells: cell((x) => known0(x.wallUs, duration(x.wallUs))), diff: deltaWords(d.wallUs, ' longer', ' shorter', duration) },
    { label: 'Actions', cells: cell(actions), diff: countDelta(d.actions, ['action', 'actions']) },
    { label: 'Steps', cells: cell((x) => known0(x.steps, plural(x.steps, 'step'))), diff: countDelta(d.steps, ['step', 'steps']) },
    { label: 'Failed actions', cells: cell((x) => known0(x.failedActions, `${formatInt(x.failedActions)} failed`)), diff: countDelta(d.failedActions, null) },
    { label: 'Edits', cells: cell((x) => known0(x.edits, `${plural(x.edits, 'edit')} in ${plural(x.filesEdited ?? 0, 'file')}`)), diff: countDelta(d.edits, ['edit', 'edits']) },
    { label: 'Tokens', cells: cell(tokens), diff: deltaWords(d.tokensIn, ' more in', ' fewer in', formatTokens) },
    { label: 'Sessions', cells: cell((x) => known0(x.sessions, plural(x.sessions, 'session'))), diff: countDelta(d.sessions, ['session', 'sessions']) },
  ];
}

/** Caution lines under the runs grid (§5.6), when the titles or the agents differ. */
export function runCautions(result, known) {
  const [a, b] = [known?.get(result?.left?.session), known?.get(result?.right?.session)];
  const out = [];
  if (a?.title && b?.title && !sameTitle(a.title, b.title)) out.push('Different titles: the alignment assumes both runs attempt the same task.');
  if (a?.agent && b?.agent && a.agent !== b.agent) out.push('Different agents: the same action name may not do the same thing.');
  return out;
}

/** The first divergence card's title and second line (§5.8). It never claims a cause. */
export function divergence(result) {
  const rows = result?.summary?.rows ?? result?.alignment?.length ?? 0;
  const fd = result?.firstDivergence;
  if (!rows) return { title: 'Neither run has tool actions to align.', detail: null };
  if (!fd) return { title: `No divergence: all ${plural(rows, 'aligned action')} are the same.`, detail: null };
  const a = fd.anchor;
  return {
    title: `First divergence: row ${formatInt(fd.index + 1)} of ${formatInt(rows)}`,
    detail: a?.left
      ? `Last shared action: ${actionText(a.left)} (row ${formatInt(a.index + 1)}, ${OUTCOME_WORD[a.left.outcome] ?? a.left.outcome} in both runs)`
      : 'The runs differ from their first action; no shared action precedes it.',
  };
}

/** The always-visible caveat line (§5.8), from the two permanent gaps' sentences. */
export function caveatLine(result) {
  const notes = new Map(gapNotes(result).map((n) => [n.code, n.text]));
  return Object.entries(PERMANENT_GAPS).map(([code, text]) => (notes.get(code) && notes.get(code) !== code ? notes.get(code) : text)).join(' ');
}

/** Summary chips (§5.9): `{ key, text }`, the key being a row status, or `ambiguous`. */
export function summaryChips(summary) {
  const s = summary ?? {};
  return [
    { key: 'same', text: `${formatInt(s.same ?? 0)} same` },
    { key: 'outcome-differs', text: `${formatInt(s.outcomeDiffers ?? 0)} different outcome` },
    { key: 'object-differs', text: `${formatInt(s.objectDiffers ?? 0)} different target` },
    { key: 'left-only', text: `${formatInt(s.leftOnly ?? 0)} only in A` },
    { key: 'right-only', text: `${formatInt(s.rightOnly ?? 0)} only in B` },
    { key: 'ambiguous', text: `${formatInt(s.ambiguous ?? 0)} ambiguous` },
  ];
}

const opsText = (ops) => Object.entries(ops ?? {}).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([op, n]) => `${formatInt(n)} ${OP_WORD[op] ?? op}`).join(', ');

/** "Region 3 · rows 120–188 · A 12 actions in 4m 10s (6 edit, 4 run, 2 read) · B 31 actions in 9m 52s (…) · rejoins". */
export function regionHeader(region, n) {
  const side = (label, s) => {
    const ops = opsText(s?.ops);
    return `${label} ${plural(s?.actions ?? 0, 'action')}${isNum(s?.wallUs) ? ` in ${duration(s.wallUs)}` : ''}${ops ? ` (${ops})` : ''}`;
  };
  return [`Region ${formatInt(n)}`, `rows ${formatInt(region.from + 1)}–${formatInt(region.to + 1)}`, side('A', region.left), side('B', region.right), region.reconverged ? 'rejoins' : 'does not rejoin'].join(' · ');
}

/** Footers of the alignment table (§5.10): the region cap and the row cap. */
export function alignmentFooters(result) {
  const s = result?.summary ?? {};
  const regions = result?.regions?.length ?? 0;
  const rows = result?.alignment?.length ?? 0;
  const out = [];
  if (isNum(s.regions) && s.regions > regions) {
    const more = s.regions - regions;
    out.push(`${formatInt(more)} more ${more === 1 ? 'region was' : 'regions were'} not returned (limit ${formatInt(regions)}). Their rows are still listed.`);
  }
  if (isNum(s.rows) && s.rows > rows) out.push(`Showing ${formatInt(rows)} of ${plural(s.rows, 'aligned row')}.`);
  return out;
}

const FAILURE_RESPONSES = [
  ['retry-same', 'Retried unchanged'], ['retry-modified', 'Retried modified'], ['edit', 'Edited'], ['inspect', 'Inspected'],
  ['delegate', 'Delegated'], ['stop', 'Stopped'], ['other', 'Other'],
];

/**
 * Behavior rows (§5.7) for the mirrored bars: `{ label, a, b, aText, bText, evidence?, title?, group? }`. The four
 * profile counts carry evidence; responses to failure are counts only.
 */
export function behaviorRows(left, right) {
  const rows = REWORK.slice(0, 4).map(([key, label, noun]) => {
    const [a, b] = [left?.[key]?.count ?? 0, right?.[key]?.count ?? 0];
    return { label, a, b, aText: count(a, noun), bText: count(b, noun), evidence: key };
  });
  const loops = (p) => `${count(p?.fixLoops ?? 0, ['loop', 'loops'])}, ${formatInt(p?.fixLoopsResolved ?? 0)} resolved`;
  const cycles = (p) => count(p?.fixLoopCycles ?? 0, ['cycle', 'cycles']);
  rows.push({ label: 'Fix loops', a: left?.fixLoops ?? 0, b: right?.fixLoops ?? 0, aText: loops(left), bText: loops(right), title: `A: ${cycles(left)} · B: ${cycles(right)}` });
  for (const [key, label] of FAILURE_RESPONSES) {
    const [a, b] = [left?.failureResponses?.[key] ?? 0, right?.failureResponses?.[key] ?? 0];
    rows.push({ label, a, b, aText: count(a, ['failed action', 'failed actions']), bText: count(b, ['failed action', 'failed actions']), group: 'After a failure' });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The generic renderer: field kinds and labels (§6.4)

// Epoch µs under these keys; a small value (a row index in `from`, `to`) stays a number.
const TIME_KEYS = new Set(['start', 'end', 'from', 'to', 'snapshotAt', 'ts']);
const RULE_KEYS = new Set(['method', 'comparisonRule', 'bindingSrc', 'rules']);
const SESSION_KEYS = new Set(['session', 'sessionId', 'sessions', 'sessionIds', 'parent', 'child', 'left', 'right']);
const TOKEN_KEYS = new Set(['input', 'cacheRead', 'uncached', 'missed', 'tokensIn', 'tokensOut']);
const SESSION_ID = /^[a-z]{2,3}:\S+$/;
const LABELS = {
  us: 'Time', wallUs: 'Wall time', pathUs: 'Path time', onPathUs: 'On path', busyUs: 'Busy', parentWaitUs: 'Parent waited',
  siblingOverlapUs: 'Overlap with siblings', workUs: 'Agent work', spanUs: 'Span', coordinationUs: 'Waiting on other agents', durMs: 'Duration',
  startTs: 'Start', endTs: 'End', snapshotAt: 'Snapshot', ts: 'Time', sessionId: 'Session', sessionIds: 'Sessions', eventId: 'Event',
  left: 'Run A', right: 'Run B', leftExcerpt: 'Excerpt in A', rightExcerpt: 'Excerpt in B', cacheRead: 'Cache read', parallelism: 'Parallelism',
};

/**
 * How a field prints, by key and value (§6.4): `duration` (µs), `ms`, `time` (epoch µs), `share` (0..1),
 * `ratio`, `tokens`, `number`, `session` (an id shown as its title), `id` (another long identifier, shortened),
 * `agent`, `rule` (tooltip only), `boolean`, or `text`.
 */
export function fieldKind(key, value) {
  if (RULE_KEYS.has(key) || (key === 'rule' && typeof value === 'string' && /@\d+$/.test(value))) return 'rule';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    if (key === 'us' || /Us$/.test(key) || /^us[A-Z]/.test(key)) return 'duration';
    if (/Ms$/.test(key)) return 'ms';
    if ((TIME_KEYS.has(key) || /Ts$/.test(key)) && value > 1e14) return 'time';
    if (key === 'share' || /Share$/.test(key) || key === 'reuse') return 'share';
    if (key === 'parallelism') return 'ratio';
    if (TOKEN_KEYS.has(key)) return 'tokens';
    return 'number';
  }
  if (typeof value === 'string' && (SESSION_KEYS.has(key) || /Session$/.test(key)) && SESSION_ID.test(value)) return 'session';
  if (typeof value === 'string' && (key === 'id' || /Id$/.test(key)) && value.length > 16) return 'id';
  if (typeof value === 'string' && key === 'agent') return 'agent';
  return 'text';
}

/**
 * A field's label in sentence case (DESIGN §9), with the unit left out: `onPathUs` → "On path", `modelUs` → "Model
 * time", `usToFirstRelevantRead` → "Time to first relevant read".
 */
export function fieldLabel(key) {
  if (LABELS[key]) return LABELS[key];
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().split(/\s+/);
  const unit = words.length > 1 ? words[words.length - 1] : '';
  if (unit === 'Us' || unit === 'Ms') words.splice(-1, 1, 'time');
  else if (unit === 'Ts') words.pop();
  if (words[0] === 'us' && words.length > 1) words[0] = 'time';
  return sentence(words.join(' ').toLowerCase());
}

/** The denominator a share is taken against, named in its header (§6.4). */
export function shareDenominator(key, ctx = {}) {
  if (key === 'relevantReadShare' || key === 'medianRelevantReadShare') return 'of reads';
  if (key === 'reuse') return 'of input tokens';
  return ctx.shareOf ?? null;
}

/** A field label with its share denominator: "Model share (of 11m 30s path)". */
export function columnLabel(key, value, ctx) {
  const label = fieldLabel(key);
  const of = fieldKind(key, value) === 'share' ? shareDenominator(key, ctx) : null;
  return of ? `${label} (${of})` : label;
}

/**
 * A primitive field as `{ text, title }`. `ctx`: `known` (run identities), `prev` (the clock time above it in a list)
 * and `notes` (gap code → sentence). Null prints `—` with the reason in the tooltip, never 0.
 */
export function formatField(key, value, ctx = {}) {
  if (value == null) return { text: DASH, title: NOT_DETERMINED };
  const kind = fieldKind(key, value);
  switch (kind) {
    case 'duration': return { text: duration(value), title: null };
    case 'ms': return { text: duration(value * 1000), title: null };
    case 'time': return { text: clock(value, ctx.prev), title: fullTime(value) };
    case 'share': return { text: share(value), title: null };
    case 'ratio': return { text: ratio(value), title: null };
    case 'tokens': return { text: formatTokens(value), title: `${formatInt(value)} tokens` };
    case 'number': return { text: number(value), title: null };
    case 'boolean': return { text: value ? 'Yes' : 'No', title: null };
    case 'agent': return { text: agentLabel(value), title: null };
    case 'session': return { text: sessionTitle(value, ctx.known), title: midId(value) };
    // A derived id names its part after '#' ("turn:p1", "step:40"); the session shows in its own column.
    case 'id': return { text: value.includes('#') ? value.slice(value.indexOf('#') + 1) : midId(value), title: value };
    case 'rule': return { text: '', title: `Rule: ${Array.isArray(value) ? value.join(', ') : value}. ${PRECISION}` };
    default: {
      const note = typeof value === 'string' ? ctx.notes?.get(value) : null;
      return note && note !== value ? { text: note, title: value } : { text: String(value), title: null };
    }
  }
}

/** A summary count with its noun, from the key: `changes: 1` → "1 change", `staleReadCandidates` → "stale read candidates". */
export function countNoun(key, n) {
  const words = fieldLabel(key).toLowerCase();
  if (n !== 1) return words;
  return words.replace(/ies$/, 'y').replace(/(ch|sh|x|ss)es$/, '$1').replace(/([^s])s$/, '$1');
}

// ---------------------------------------------------------------------------
// Requests

/** The four keys the session pickers decide. Advanced JSON never overrides them (bug I4). */
export const PICKER_KEYS = ['session', 'sessions', 'left', 'right'];

/**
 * A saved recipe's input split for loading (§6.5): `session`, `right` and a multi-run `sessions` list set the
 * pickers; every other field goes to Advanced JSON.
 */
export function recipePickers(input) {
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const sessions = Array.isArray(input?.sessions) ? input.sessions.filter((s) => typeof s === 'string' && s) : [];
  const advanced = Object.fromEntries(Object.entries(input ?? {}).filter(([k]) => !PICKER_KEYS.includes(k)));
  return { session: str(input?.left) ?? str(input?.session) ?? sessions[0] ?? null, right: str(input?.right), sessions, advanced };
}

/** The request body: the form's fields, then Advanced JSON, except that the pickers' four keys always come from the form. */
export function mergeAdvanced(form, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ...form };
  const extra = JSON.parse(text);
  if (!extra || Array.isArray(extra) || typeof extra !== 'object') throw new Error('Advanced request must be a JSON object.');
  const out = { ...form, ...extra };
  for (const k of PICKER_KEYS) {
    if (k in form) out[k] = form[k];
    else delete out[k];
  }
  return out;
}

/**
 * A failed request as a sentence and the retries that can help (FEEDBACK F09), from the HTTP status, the engine's
 * error code and its message; engines before 1.1 send no code for input errors, so their messages are read too.
 * `retries` lists `{ label, input }` patches to the request; an empty patch is a plain Retry.
 */
export function failure({ status, code, message } = {}, operation, input = {}) {
  const msg = String(message ?? '').trim();
  const name = operation === 'perf' ? 'Critical Path' : operation === 'diff' ? 'Compare Runs' : 'This analysis';
  if (status === 503 && code === 'workbench-unavailable') return { text: `${name} needs the finished index. Indexing is still running; try again when it completes.`, retries: [{ label: 'Retry', input: {} }] };
  if (status === 503 && code === 'query-timeout') {
    const retries = [{ label: 'Retry', input: {} }];
    if (operation === 'diff') retries.push({ label: 'Retry Without Subagents', input: { children: false } }, { label: 'Retry With 500 Actions per Run', input: { limit: 500 } });
    return { text: `${operation === 'diff' ? 'Alignment' : 'Analysis'} took longer than 30 s. The engine stopped the job and restarted a query worker.`, retries };
  }
  if (code === 'session-not-found' || /^session not found/i.test(msg)) {
    const id = msg.split(': ').slice(1).join(': ');
    const side = id && id === input.right ? 'Run B' : id && id === input.left ? 'Run A' : 'This session';
    return { text: `${side} is no longer in the index.`, retries: [] };
  }
  if (code === 'session-tree-limit' || /500-session/.test(msg)) return { text: 'This run has more than 500 sessions, the analysis limit.', retries: [] };
  if (status === 400) return { text: msg ? sentence(msg.replace(/\.?$/, '.')) : 'The engine rejected this request.', retries: [] };
  return { text: `Could not load this analysis${msg ? `: ${msg.replace(/\.$/, '')}` : ''}. Your selection is preserved.`, retries: [{ label: 'Retry', input: {} }] };
}
