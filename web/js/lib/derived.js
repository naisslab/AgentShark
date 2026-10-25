// Words, glyphs and labels for the agent-native model (SPEC §12, WEB-CONTRACT "Glyphs and marks").
// Shared by Failures, the Lens, Session · Steps, Events, the Timeline and the sidebar, so every view
// names an impact, tier, outcome or provenance the same way. Color is never the only cue: each value
// has a glyph and a word. Pure module: no DOM access.

/** SPEC §12.3.6, worst first. `tone` picks --impact-bad, --impact-warn or --impact-ok. */
export const IMPACT = {
  failed: { glyph: '✕', word: 'failed', tone: 'bad' },
  blocked: { glyph: '⊘', word: 'blocked', tone: 'bad' },
  interrupted: { glyph: '‖', word: 'interrupted', tone: 'warn' },
  masked: { glyph: '◐', word: 'masked', tone: 'warn' },
  degraded: { glyph: '△', word: 'degraded', tone: 'warn' },
  slow: { glyph: '◷', word: 'slow', tone: 'warn' },
  recovered: { glyph: '↺', word: 'recovered', tone: 'ok' },
  clean: { glyph: '✓', word: 'clean', tone: 'ok' },
};
export const TURN_IMPACTS = Object.keys(IMPACT);

/** Rank of an impact, 0 = worst; unknown values rank after clean. */
export const impactRank = (v) => {
  const i = TURN_IMPACTS.indexOf(v);
  return i < 0 ? TURN_IMPACTS.length : i;
};

/** The worse of two impacts (null when both are null). */
export const worseImpact = (a, b) => (a == null ? b ?? null : b == null ? a : impactRank(a) <= impactRank(b) ? a : b);

/** SPEC §12.3.3. Suspect counts are upper bounds, so they carry the derived mark after the count: "212≈". */
export const TIERS = ['failure', 'suspect', 'benign', 'deferred'];
export const TIER = {
  failure: { word: 'failure', label: 'Failures', approx: false },
  suspect: { word: 'suspect', label: 'suspect', approx: true },
  benign: { word: 'benign', label: 'benign', approx: false },
  deferred: { word: 'deferred', label: 'deferred', approx: false },
};

/** SPEC §12.3.5 outcomes. Glyphs follow the impact each outcome leads to. */
export const OUTCOME = {
  recovered: { glyph: '↺', word: 'recovered', tone: 'ok' },
  interrupted: { glyph: '‖', word: 'interrupted', tone: 'warn' },
  'parallel-ok': { glyph: '⇉', word: 'parallel ok', tone: 'ok' },
  'recovered-later': { glyph: '△', word: 'recovered later', tone: 'warn' },
  pivoted: { glyph: '△', word: 'pivoted', tone: 'warn' },
  'ended-on-failure': { glyph: '✕', word: 'ended on failure', tone: 'bad' },
  open: { glyph: '…', word: 'still open', tone: 'warn' },
};

/** Delegation outcomes (SPEC §12.3.7). Logged sources draw a filled dot, every other source an outlined one. */
export const DELEGATION = {
  completed: { word: 'completed', tone: 'ok' },
  failed: { word: 'failed', tone: 'bad' },
  blocked: { word: 'blocked', tone: 'bad' },
  killed: { word: 'killed', tone: 'warn' },
  stopped: { word: 'stopped', tone: 'warn' },
  running: { word: 'running', tone: 'muted' },
  unknown: { word: 'outcome unknown', tone: 'muted' },
};
export const delegationDot = (src) => (provKind(src) === 'logged' ? '●' : '○');

/** Claim evidence (SPEC §12.3.8). A claim chip is never red: the worst tone is warn. */
export const CLAIM = {
  'passed-after-last-edit': { word: 'tests passed after the last edit', short: 'verified', tone: 'ok' },
  'edited-after-last-test': { word: 'edited after the last test', short: 'edited after test', tone: 'warn' },
  'last-test-failed': { word: 'last test failed', short: 'last test failed', tone: 'warn' },
  'no-test-in-turn': { word: 'no test run in this turn', short: 'no test run', tone: 'warn' },
  unknown: { word: 'evidence unknown', short: 'unknown', tone: 'muted' },
};
export const UNVERIFIED_CLAIMS = ['edited-after-last-test', 'last-test-failed', 'no-test-in-turn'];

/** SPEC §12.3.9. Only consecutive and blocker may notify. */
export const ALARM = {
  consecutive: { word: 'consecutive failures', notify: true },
  blocker: { word: 'repeated environment block', notify: true },
  'blind-loop': { word: 'blind loop', notify: false },
  loop: { word: 'loop', notify: false },
  stall: { word: 'stalled', notify: false },
  'silent-child': { word: 'silent child', notify: false },
};

/** Attention sections in display order (SPEC §12.7); `other` and `recovered` start collapsed. */
export const SECTIONS = ['alarms', 'blocked', 'unrecovered', 'silent-child', 'unverified-claims', 'recurring', 'other', 'recovered'];
export const SECTION = {
  alarms: { label: 'Alarms', short: 'Alarms', unit: 'alarm', attention: true },
  blocked: { label: 'Blocked by environment', short: 'Blocked', unit: 'episode', attention: true },
  unrecovered: { label: 'Unrecovered', short: 'Unrecovered', unit: 'episode', attention: true },
  'silent-child': { label: 'Silent child failures', short: 'Silent', unit: 'delegation', attention: true },
  'unverified-claims': { label: 'Unverified claims', short: 'Claims', unit: 'claim', attention: true },
  recurring: { label: 'Recurring signatures', short: 'Recurring', unit: 'signature', attention: true },
  other: { label: 'Other', short: 'Other', unit: 'episode', attention: false, collapsed: true },
  recovered: { label: 'Recovered', short: 'Recovered', unit: 'episode', attention: false, collapsed: true },
};
/** Rows an open attention section shows before its "Show all N" row, so every section header stays within reach. */
export const SECTION_PREVIEW = 8;
export const NEEDS_ATTENTION = SECTIONS.filter((s) => SECTION[s].attention);

export const QUEUE_GROUPS = [
  { id: 'attention', label: 'Attention' },
  { id: 'episode', label: 'Episode' },
  { id: 'signature', label: 'Signature' },
  { id: 'session', label: 'Session' },
  { id: 'delegation', label: 'Delegation' },
];
export const QUEUE_SORTS = [
  { id: 'attention', label: 'Attention' },
  { id: 'recent', label: 'Most recent' },
  { id: 'impact', label: 'Impact' },
  { id: 'attempts', label: 'Attempts' },
  { id: 'wall', label: 'Wall time' },
  { id: 'sessions', label: 'Sessions spanned' },
];

export const FAMILIES = [
  'api', 'policy', 'sandbox', 'network', 'stale-edit', 'test-failure', 'missing-module', 'missing-file',
  'harness', 'hook', 'exception', 'error-text', 'other',
];
export const BLOCKED_FAMILIES = ['sandbox', 'policy', 'network'];
export const ROLES = ['main', 'subagent', 'workflow-agent', 'guardian', 'review', 'fork', 'automation'];

export const CHANGE_CLASS = {
  identical: 'identical',
  'flags-only': 'flags only',
  small: 'small change',
  moderate: 'moderate change',
  rewrite: 'rewrite',
};

/** What a family needs, worded as an association, never as a cause (Lens "Seen before"). */
export const ADVICE = {
  environment: 'Environment: the sandbox, a policy or the network refused the call. Retrying the same call does not change the environment.',
  dependency: 'Dependency: a module or package was missing where the call ran.',
  code: 'Code: the failure came from the work itself (tests, edits, exceptions).',
  harness: 'Harness: the agent harness, a hook or the model API reported the failure.',
};

export const TIME_BUCKET = {
  'wait-human': 'waiting for a human',
  'wait-agent': 'waiting for a subagent',
  'wait-process': 'waiting for a process',
  'api-retry': 'API retries',
  compaction: 'compaction',
  hook: 'hooks',
  tool: 'tools (includes any approval wait)',
  model: 'model',
};

// ---------------------------------------------------------------------------
// Provenance (SPEC §12.1 principle 5): logged has no mark, derived ≈, parsed ~, inferred ?.

export function provKind(p) {
  if (typeof p !== 'string' || !p) return null;
  const head = p.split(':')[0];
  return ['logged', 'derived', 'parsed', 'inferred'].includes(head) ? head : null;
}

export const PROV_MARK = { logged: '', derived: '≈', parsed: '~', inferred: '?' };

/** The glyph shown next to a value; '' for logged values and for a missing provenance. */
export const provMark = (p) => PROV_MARK[provKind(p)] ?? '';

/** `inferred:claim@1` → `claim@1`; null for other provenances. */
export const provRule = (p) => (provKind(p) === 'inferred' ? p.slice('inferred:'.length) : null);

/**
 * Tooltip for a provenance. `rules` is AnalysisStatus.rules: the inferred tooltip names the rule and the
 * share of hand-checked items it got right, or "not yet checked".
 */
export function provTitle(p, rules = []) {
  const kind = provKind(p);
  if (!kind) return 'Provenance not reported';
  const detail = p.includes(':') ? p.slice(p.indexOf(':') + 1) : '';
  if (kind === 'logged') return `Logged by the agent${detail ? ` (${detail})` : ''}`;
  if (kind === 'derived') return `Derived from logged values${detail ? ` (${detail})` : ''}`;
  if (kind === 'parsed') return `Parsed from output text${detail ? ` (${detail})` : ''}`;
  return ruleTitle(detail, rules, 'Inferred by rule');
}

/** "Inferred by rule claim@1: … · precision 92% of 50 checked" or "… · precision not yet checked". */
export function ruleTitle(rule, rules = [], lead = 'Rule') {
  const info = (rules ?? []).find((r) => r.rule === rule);
  const what = info?.description ? `: ${info.description}` : '';
  const precision = info?.precision != null
    ? `precision ${Math.round(info.precision * 100)}%${info.checked != null ? ` of ${info.checked} checked` : ''} (historical local sample)`
    : 'precision not yet checked';
  const validation = info?.advisory ? ' · Advisory: unvalidated heuristic'
    : info?.validation === 'structural' ? ` · ${info.basis === 'logged' ? 'Logged observation' : 'Deterministic derivation'}; empirical accuracy not measured`
    : info?.validation === 'suppressed' ? ' · Suppressed: below the label threshold' : '';
  return `${lead} ${rule}${what} · ${precision}${validation}`;
}

// ---------------------------------------------------------------------------
// Labels

const int = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0');

/** The tier toggle (docs/DESIGN.md §3.3): "Failures 1,204 · +suspect 212≈ · +benign 61 · +deferred 9". */
export function tierToggleParts(tiers) {
  return TIERS.map((t) => {
    const n = tiers?.[t] ?? null;
    const count = n == null ? '—' : `${int(n)}${TIER[t].approx ? '≈' : ''}`;
    return { tier: t, text: t === 'failure' ? `${TIER[t].label} ${count}` : `+${TIER[t].label} ${count}` };
  });
}
export const tierToggleLabel = (tiers) => tierToggleParts(tiers).map((p) => p.text).join(' · ');

/** "41 episodes · 12 need attention · filter + since 23:04" (SPEC §12.7 §7.8 row). */
export function failuresLabel({ episodes, needAttention, scopeParts = [] }) {
  const parts = [`${int(episodes)} episode${episodes === 1 ? '' : 's'}`, `${int(needAttention)} need${needAttention === 1 ? 's' : ''} attention`];
  if (scopeParts.length) parts.push(scopeParts.join(' + '));
  return parts.join(' · ');
}

/**
 * The Steps scope label (docs/DESIGN.md §7.8): "213 steps · filter highlights 14". The session title is in the run
 * report strip only. `by` names what highlights ('filter' or 'time range'); nothing is said when nothing narrows the
 * steps (matched null) or everything matches.
 */
export function stepsLabel({ total, matched, by = 'filter' }) {
  const parts = [`${int(total)} step${total === 1 ? '' : 's'}`];
  if (matched != null && matched !== total) parts.push(`${by} highlights ${int(matched)}`);
  return parts.join(' · ');
}

/**
 * Status bar: "3 need attention · 1 alarm" over the whole index; with `scoped` (the count of the scope Failures
 * shows), "21 of 3,032 need attention". Null when there is nothing to report.
 */
export function attentionStatus({ needAttention = 0, openAlarms = 0, scoped = null }) {
  const parts = [];
  if (needAttention) parts.push(`${scoped != null ? `${int(scoped)} of ` : ''}${int(needAttention)} need${needAttention === 1 ? 's' : ''} attention`);
  if (openAlarms) parts.push(`${int(openAlarms)} alarm${openAlarms === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : null;
}

/** Time from a reference: "+1:02:03.456" or "−0:00:01.250". */
export function refTime(ts, ref) {
  if (!Number.isFinite(ts) || !Number.isFinite(ref)) return '';
  const d = ts - ref;
  const a = Math.abs(d);
  const ms = Math.floor(a / 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d < 0 ? '−' : '+'}${h}:${p(m)}:${p(s)}.${p(f, 3)}`;
}

/** Id helpers: derived ids embed session ids (`<sid>#step:<n>`, `<sid>#ep:<event>`, `<turn>#alarm:…`). */
export function sessionOfDerivedId(id) {
  if (typeof id !== 'string') return null;
  const i = id.indexOf('#');
  return i > 0 ? id.slice(0, i) : null;
}

/** `<sid>#step:12` → 12. */
export function stepNumber(id) {
  const m = /#step:(\d+)$/.exec(id ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * A step position in the canonical words (docs/DESIGN.md §9): "step 164 · 6 of 44 in turn 3", or "step 164 · 6 of 44"
 * when the turn is named beside it (`turn` null). The session-wide number is the Steps No. column; an older server
 * sends only the place in the turn.
 */
export function stepWords(step, turn = null) {
  if (!step) return '';
  const inTurn = `${int(step.n)} of ${int(step.of)}${turn != null ? ` in turn ${int(turn)}` : ''}`;
  return step.session != null ? `step ${int(step.session)} · ${inTurn}` : `step position ${inTurn}`;
}

/** A failure note without the tier its row already names ("failure: error flag exit 1" → "error flag exit 1"). */
export function noteText(f) {
  const note = String(f?.note ?? '');
  return f?.tier && note.startsWith(`${f.tier}: `) ? note.slice(f.tier.length + 2) : note;
}

/** Signature texts are cut at this many code points (src/index/derive/signature.ts MAX_TEXT). */
export const SIGNATURE_MAX = 88;

/**
 * The Lens headline of an episode: its signature, unless the error line says the same thing in full. A signature
 * the index cut mid-word ends at its last whole word with "…". `error` is the error line to show under the
 * headline, null when the headline is the error line itself.
 */
export function sigHeadline(sig, errorLine) {
  const text = String(sig ?? '');
  const cps = [...text];
  const cut = cps.length >= SIGNATURE_MAX;
  const literal = !placeholderRuns(text).some((r) => r.ph);
  if (errorLine && literal && String(errorLine).startsWith(text.trimEnd())) return { text: String(errorLine), fromError: true, error: null };
  let shown = text;
  if (cut) {
    const space = text.trimEnd().lastIndexOf(' ');
    shown = `${space > text.length * 0.6 ? text.slice(0, space) : text.trimEnd()}…`;
  }
  return { text: shown, fromError: false, error: errorLine || null };
}

/**
 * Runs of an attempt's word diff (DiffOp[] from the server, whose ops lose the spaces between them): a space
 * between ops, and an arrow from a deletion to the insertion that replaced it.
 */
export function diffRuns(ops) {
  const out = [];
  for (const [i, o] of (ops ?? []).entries()) {
    if (i) out.push({ op: 'sep', text: ops[i - 1].op === 'del' && o.op === 'add' ? ' → ' : ' ' });
    out.push({ op: o.op, text: o.text });
  }
  return out;
}

/**
 * Segments of a stacked time bar: each bucket's share of `wall`, split into its logged and derived parts,
 * then unattributed time. Shares sum to at most 1; with no wall time the bucket total is the denominator.
 */
export function timeSegments({ buckets = [], unattributedUs = 0, wallUs = null }) {
  const sum = buckets.reduce((a, b) => a + (b.us ?? 0), 0) + (unattributedUs ?? 0);
  const total = Math.max(1, wallUs ?? 0, sum);
  const out = [];
  for (const b of buckets) {
    if (!b.us) continue;
    const logged = Math.max(0, Math.min(b.us, b.loggedUs ?? 0));
    out.push({ name: b.name, us: b.us, frac: b.us / total, loggedFrac: logged / b.us });
  }
  if (unattributedUs) out.push({ name: 'unattributed', us: unattributedUs, frac: unattributedUs / total, loggedFrac: 0 });
  return out;
}

/** Points of a sparkline over `n` values, in a w × h box (y grows down); a flat line for no data. */
export function sparkPoints(values, w, h) {
  const n = values?.length ?? 0;
  if (!n) return [];
  const max = Math.max(1, ...values);
  const step = n > 1 ? w / (n - 1) : 0;
  return values.map((v, i) => [Math.round(i * step * 10) / 10, Math.round((h - (Math.max(0, v) / max) * h) * 10) / 10]);
}

/** A signature or target text split into literal runs and `<placeholder>` runs (Lens header highlighting). */
export function placeholderRuns(text) {
  const out = [];
  const re = /<(?:path|file|q|url|uuid|hex|n|secret:[\w-]+:\d+|no output|python traceback[^>]*)>/g;
  let last = 0;
  for (const m of String(text ?? '').matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), ph: false });
    out.push({ text: m[0], ph: true });
    last = m.index + m[0].length;
  }
  if (last < String(text ?? '').length) out.push({ text: String(text).slice(last), ph: false });
  return out;
}

/** Gap codes that describe this index rather than a data limit; they get a banner, not a footnote. */
export const STATE_GAPS = ['analysis-pending', 'analysis-outdated', 'not-derived', 'possibly-running', 'truncated', 'scope-limited', 'raw-unavailable'];

/** Words for a list of firing alarms, newest first: "consecutive failures in Codex · repo". */
export function alarmLine(alarm, session) {
  const what = ALARM[alarm?.kind]?.word ?? alarm?.kind ?? 'alarm';
  const where = session?.title || session?.project || alarm?.sessionId || '';
  return where ? `${what} · ${where}` : what;
}

/** Fields that only a schema-4 server knows; rules naming them are left out on an older server. */
const DERIVED_FIELD_HEADS = new Set(['failure', 'signature', 'episode', 'step', 'delegation', 'claim', 'intervention', 'process', 'change', 'alarm', 'unattended']);

/** Whether a filter names a derived field (outside quoted strings). */
export function usesDerivedFields(filter) {
  const bare = String(filter ?? '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const m of bare.matchAll(/[A-Za-z_][\w.]*/g)) if (DERIVED_FIELD_HEADS.has(m[0].split('.')[0])) return true;
  return false;
}

// ---------------------------------------------------------------------------
// P1: Follow streams, notifications, statistics drill-downs and the context lane.

/** Follow stream kinds in the order the panel lists them (SPEC §12.7 "Follow"). */
export const FOLLOW_KINDS = ['call', 'delegation', 'process', 'file'];
export const FOLLOW_LABEL = { call: 'Tool Call', delegation: 'Delegation', process: 'Process', file: 'File' };

const baseName = (p) => String(p ?? '').split('/').filter(Boolean).pop() ?? String(p ?? '');
const EDIT_OPS = ['add', 'update', 'delete', 'move', 'write', 'external'];

/**
 * The Follow streams that fit one event, in panel order, and the index of the one `f` opens: a
 * delegation, else a process, else a file the event edited, else the tool call. `event` is the EventRow
 * (kind, session), `related` its partner rows (a result follows its call), `derived` the EventDerived.
 */
export function followTargets({ eventId, event = null, related = [], derived = null }) {
  const out = [];
  const tool = /^tool\./.test(event?.kind ?? '') || !!derived?.failure || !!derived?.process;
  if (tool || (!derived?.delegation && !derived?.process && !derived?.changes?.length)) {
    const call = event?.kind === 'tool.result' ? related.find((r) => r.kind === 'tool.call')?.id ?? eventId : eventId;
    // "Tool Call · Bash": every tab names its subject, so sibling tabs read apart before selection (§7.9 Header).
    const toolName = event?.attrs?.tool?.name ?? event?.tool ?? related.find((r) => r.id === call)?.tool ?? null;
    out.push({ kind: 'call', eventId: call, label: followLabel('call', toolName) });
  }
  if (derived?.delegation) out.push({ kind: 'delegation', spanId: derived.delegation.id, label: FOLLOW_LABEL.delegation });
  if (derived?.process) out.push({ kind: 'process', id: derived.process.id, label: followLabel('process', procName(derived.process.id)) });
  const session = event?.session ?? sessionOfDerivedId(derived?.step?.id) ?? null;
  const seen = new Set();
  for (const c of derived?.changes ?? []) {
    if (!session || seen.has(c.path)) continue;
    seen.add(c.path);
    out.push({ kind: 'file', session, path: c.path, label: followLabel('file', baseName(c.path)), edit: EDIT_OPS.includes(c.op) });
  }
  const order = [out.findIndex((t) => t.kind === 'delegation'), out.findIndex((t) => t.kind === 'process'), out.findIndex((t) => t.kind === 'file' && t.edit)];
  return { targets: out, preferred: order.find((i) => i >= 0) ?? 0 };
}

/** A Follow tab label (docs/DESIGN.md §9): "Process · b24ht5e89", "File · serve.log", "Tool Call · Bash". */
export function followLabel(kind, subject) {
  return subject ? `${FOLLOW_LABEL[kind]} · ${subject}` : FOLLOW_LABEL[kind];
}

/** The short name of a process id (`<sid>#proc:b24ht5e89:490` → "b24ht5e89"). */
export function procName(id) {
  const m = /#proc:([^:]+)/.exec(String(id ?? ''));
  return m ? m[1] : null;
}

/** A stable key for a Follow target (the panel's tab identity). */
export function followKey(t) {
  if (!t) return '';
  return t.kind === 'call' ? `call:${t.eventId}` : t.kind === 'delegation' ? `delegation:${t.spanId}` : t.kind === 'process' ? `process:${t.id}` : `file:${t.session}\n${t.path}`;
}

/**
 * Process output reassembled from the stream: the head and tail of each output, deferred and close item in
 * seq order, with a cut wherever the index left text out (between a head and its tail, and at markers).
 * Returns [{kind: 'text', text, eventId} | {kind: 'cut', reason}].
 */
export function reassembleOutput(items) {
  const out = [];
  for (const it of items ?? []) {
    if (it.role === 'marker') {
      out.push({ kind: 'cut', reason: it.reason ?? 'The index left text out here' });
      continue;
    }
    if (!['output', 'deferred', 'close'].includes(it.role)) continue;
    const head = it.head ?? (it.role === 'output' ? it.excerpt : null);
    if (head) out.push({ kind: 'text', text: head, eventId: it.eventId });
    if (it.tail) out.push({ kind: 'cut', reason: 'The index keeps the head and the tail of this output' }, { kind: 'text', text: it.tail, eventId: it.eventId });
  }
  // Two cuts in a row say the same thing once.
  return out.filter((s, i) => !(s.kind === 'cut' && out[i - 1]?.kind === 'cut'));
}

/** Families that block, with the words a notification uses for a run of them. */
const BLOCK_WORDS = { sandbox: 'sandbox denials', policy: 'policy rejections', network: 'network blocks' };

/**
 * The text of a desktop notification for a notifying alarm (SPEC §12.7): "Codex · repo: 2 sandbox
 * denials; agents recover from these 2–7% of the time". `family` is the alarm episode's family when known,
 * `thresholds` AnalysisStatus.alarmThresholds. Returns null for alarms that never notify.
 */
export function alarmNotification({ kind, agent = null, where = null, family = null, thresholds = null }) {
  if (!ALARM[kind]?.notify) return null;
  const title = `${ALARM[kind].word[0].toUpperCase()}${ALARM[kind].word.slice(1)}`;
  const run = [agent, where].filter(Boolean).join(' · ') || 'An agent run';
  if (kind === 'blocker') {
    const n = thresholds?.blocker ?? 2;
    return { title, body: `${run}: ${n} ${BLOCK_WORDS[family] ?? 'environment blocks (sandbox, policy or network)'}; agents recover from these 2–7% of the time` };
  }
  const n = thresholds?.consecutive ?? 6;
  return { title, body: `${run}: ${n} failures in a row with no success between them; in past runs 89% of such turns ended failed, blocked or interrupted` };
}

/**
 * The display filter that selects an endpoint's calls (Statistics ▸ Endpoints drill-down), or null when no
 * filter field names it exactly (programs and web hosts live inside the command and the URL).
 */
export function endpointFilter(row) {
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (row?.kind === 'mcp') return `tool.server == ${q(row.endpoint)}`;
  if (row?.kind === 'agent') return `agent.type == ${q(row.endpoint)}`;
  if (row?.kind === 'hook') {
    const i = row.endpoint.indexOf(':');
    return i > 0 ? `hook.event == ${q(row.endpoint.slice(0, i))} && hook.command == ${q(row.endpoint.slice(i + 1))}` : null;
  }
  return null;
}

/**
 * The context lane of one session: points (ts, tokens) where the context size changes, the window with its
 * provenance (dashed when inferred), compactions and the injected context types. Steps without a logged
 * context size are left out, never drawn as zero.
 */
export function contextSeries(steps) {
  const points = [];
  const compactions = [];
  const attachments = {};
  let window = null;
  let windowSrc = null;
  for (const s of steps ?? []) {
    if (s.compactionBefore) compactions.push(s.startTs);
    for (const [k, n] of Object.entries(s.attachments ?? {})) attachments[k] = (attachments[k] ?? 0) + n;
    if (s.ctxWindow != null && (window == null || s.ctxWindow > window)) {
      window = s.ctxWindow;
      windowSrc = s.ctxWindowSrc ?? null;
    }
    if (s.ctxTokens != null) points.push({ ts: s.startTs, tokens: s.ctxTokens, step: s.n, window: s.ctxWindow ?? null });
  }
  points.sort((a, b) => a.ts - b.ts);
  const peak = points.reduce((m, p) => Math.max(m, p.tokens), 0);
  return { points, compactions, attachments, window, windowSrc, inferred: provKind(windowSrc) === 'inferred', peak };
}

/** Interventions (SPEC §12.3.8): words for each kind and actor. Association only, never a failure cause. */
export const INTERVENTION = {
  interrupt: 'interrupt',
  'abort-child': 'child aborted',
  'tool-rejected': 'tool call rejected',
  'policy-rejected': 'rejected by policy',
  'hook-blocked': 'blocked by a hook',
  'permission-decision': 'permission decision',
  question: 'question to the user',
  'external-edit': 'edited outside the agent',
  correction: 'correction',
};
export const INTERVENTION_ACTOR = { human: 'human', 'parent-or-human': 'parent or human', policy: 'policy', hook: 'hook', harness: 'harness' };

/**
 * Runs of a redacted report for the preview: the redaction placeholders (`~`, `<user>`, `<secret:class:len>`)
 * as their own runs so the preview can mark them.
 */
export function redactionRuns(text) {
  const out = [];
  const re = /<secret:[\w-]+:\d+>|<user>|(?<![\w/~.-])~(?=\/|$|\s)/g;
  let last = 0;
  const s = String(text ?? '');
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), mark: false });
    out.push({ text: m[0], mark: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), mark: false });
  return out;
}

/** A rate to two significant figures ("0.0091", "0.35", "14"), or "—" when unknown. */
export function sig2(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return x === 0 ? '0' : String(Number(x.toPrecision(2)));
}

/** A split names a direction only when the rate moved by at least this share; smaller moves read "≈". */
export const SPLIT_CHANGE = 0.25;

/**
 * Words for a signature split at a date (SPEC §12.2 row 7): the failures per active session before and after, as a
 * queue chip (`text`) and in the Lens (`rates`, with the direction in words), and a direction only when the rate
 * moved by SPLIT_CHANGE or more. The chip shows the rates the arrow compares; the raw counts over unequal windows
 * go to the tooltip, where they cannot contradict it. The direction is a comparison, never a verdict on a fix.
 */
export function splitSummary(split) {
  if (!split?.before || !split?.after) return null;
  const { before: b, after: a } = split;
  const rb = b.perActiveSession;
  const ra = a.perActiveSession;
  let dir = null;
  let change = null;
  if (rb != null && ra != null) {
    change = rb === 0 ? (ra === 0 ? 0 : Infinity) : (ra - rb) / rb;
    dir = change <= -SPLIT_CHANGE ? 'lower' : change >= SPLIT_CHANGE ? 'higher' : 'same';
  }
  const glyph = { lower: '▼', higher: '▲', same: '≈' }[dir] ?? '';
  const word = { lower: 'lower', higher: 'higher', same: 'about the same' }[dir] ?? '';
  const side = (x, label) => `${label} (${int(x.days)} day${x.days === 1 ? '' : 's'}): ${int(x.n)} failure${x.n === 1 ? '' : 's'} in ${int(x.sessions)} of ${int(x.activeSessions)} active sessions`;
  const pct = change != null && Number.isFinite(change) ? ` (${change > 0 ? '+' : change < 0 ? '−' : '±'}${Math.round(Math.abs(change) * 100)}%)` : '';
  // Rates under 0.01 rescale to "per 1,000 active sessions" (docs/DESIGN.md §9 Rate change).
  const small = [rb, ra].every((x) => x == null || x < 0.01);
  const k = small ? 1000 : 1;
  const rates = `${sig2(rb == null ? rb : rb * k)} → ${sig2(ra == null ? ra : ra * k)} per ${small ? '1,000 active sessions' : 'active session'}`;
  return {
    text: `${rates}${glyph ? ` ${glyph}` : ''}`,
    rates: `${rates}${glyph ? ` ${glyph} ${word}` : ''}`,
    dir,
    title: `${rates}${pct}\n${side(b, 'Before')}\n${side(a, 'After')}\nFailures per session active on those days; ▲ or ▼ only for a change of ${Math.round(SPLIT_CHANGE * 100)}% or more. A comparison, not a verdict on a fix.`,
  };
}

/** A time (µs) as the local day `YYYY-MM-DD`, the value of a date input. */
export function localDay(us) {
  const d = new Date(us / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A date input value (`YYYY-MM-DD`) as its local midnight in µs, or null. */
export function dayStart(value) {
  const ms = value ? new Date(`${value}T00:00`).getTime() : NaN;
  return Number.isFinite(ms) ? ms * 1000 : null;
}

/**
 * Where a step's wall time went (Session · Steps), as the server reports it (StepItem): `active` is model plus tool
 * time, at most the wall time (null when neither is known); `gap` is the rest of the wall time, mostly the idle
 * stretch before the next step. A step's wall time runs to the next step, so ranking by it ranks gaps.
 */
export function stepTimes(s) {
  return { active: s.activeUs ?? null, gap: s.gapUs ?? null, wall: s.durUs ?? null };
}

/**
 * The first (or, `fromEnd`, the last) few lines of an output head or tail, at most `chars` characters: what the
 * Lens shows until "Show full output". `cut` says whether anything was left out.
 */
export function clipOutput(text, fromEnd = false, { lines = fromEnd ? 2 : 4, chars = fromEnd ? 160 : 320 } = {}) {
  if (!text) return { text: '', cut: false };
  const all = text.split('\n');
  let out = (fromEnd ? all.slice(-lines) : all.slice(0, lines)).join('\n');
  if (out.length > chars) out = fromEnd ? out.slice(-chars) : out.slice(0, chars);
  return { text: out, cut: out.length < text.length };
}

/** Alert preferences (View ▸ Alerts…): notifications are off by default and offered once. */
export const ALERT_DEFAULTS = { enabled: false, offered: false, kinds: { consecutive: true, blocker: true } };

/**
 * What to do with an SSE alarm (AlarmStreamEvent): 'notify' (a desktop notification), 'offer' (offer
 * notifications once), or null. Only firing `consecutive` and `blocker` alarms qualify (SPEC §12.7); a page
 * the user is looking at shows its in-page toast instead of a desktop notification.
 */
export function notifyDecision(alarm, prefs, permission, { focused = false } = {}) {
  if (!alarm?.notify || alarm.state !== 'firing' || !ALARM[alarm.kind]?.notify) return null;
  if (!prefs?.enabled) return prefs?.offered || permission === 'denied' || permission === 'unsupported' ? null : 'offer';
  if (permission !== 'granted' || prefs.kinds?.[alarm.kind] === false || focused) return null;
  return 'notify';
}
