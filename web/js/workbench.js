// The Workbench page (docs/WORKBENCH.md; docs/analyses/ANALYSIS-UX.md §6). workbench.html lists the tools grouped by
// the question they answer; this module runs them. Critical Path and Compare Runs open on summaries of their own
// (§4, §5); every other field goes through one renderer that prints durations, shares, clock times and run titles
// (lib/workbench-format.js) instead of raw microseconds, fractions and ids.

import { loadPref, savePref } from './state.js';
import { copyText, debounce, h } from './lib/dom.js';
import { formatInt, plural } from './lib/format.js';
import {
  BUCKET_NAME, DASH, DEFAULT_ACTION_LIMIT, DERIVED_SHARE, LEAD, NOT_DETERMINED, OP_WORD, PERF_SCOPE, PERMANENT_GAPS, PRECISION, REWORK, STATUS_WORD,
  actionObject, actionState, actionText, alignmentFooters, behaviorRows, caveatLine, className, classRows, clock, columnLabel, confidenceMark,
  confidenceNote, count, countNoun, coverageLine, diffHeader, divergence, duration, failure, fieldKind, fieldLabel, formatField, fullTime, gapLine,
  gapNotes, laneName, mergeAdvanced, midId, parallelLine, pathShareHeader, perfHeader, perfVerdict, perfWindow, recipePickers, regionHeader, rootOf,
  runCautions, runsGrid, sessionInfo, sessionOption, sessionTitle, share, stepName, summaryChips,
} from './lib/workbench-format.js';

const $ = (id) => document.getElementById(id);
// The viewer's theme and density preferences apply here too.
const theme = loadPref('theme', 'system');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
document.documentElement.dataset.density = loadPref('density', 'compact') === 'comfortable' ? 'comfortable' : 'compact';

// What each tool does. Names live on the nav buttons in workbench.html; `pointer` sends a reader of an older tool
// to the newer one that answers the usual question (§6.3).
const TOOLS = {
  perf: { text: 'Follow the critical path through model, tool, human and subagent waits, and see which class of time takes the largest share of it. Missing timing information is listed instead of guessed.' },
  cache: { text: 'Trace prompt-cache reuse per model request, the breaks and their causes: Claude logs its reasons, Codex causes come from surrounding events.' },
  profile: {
    text: 'Measure recorded spans and observed dependencies. Unrecorded waits and dependencies remain unknown.',
    pointer: ["Follows only dependency edges a span records. For where a run's time went, use ", 'perf', '.'],
  },
  context: { text: 'Reconstruct instructions, tool outputs and compaction records visible in the transcript. Exact model inputs and attention remain unknown.' },
  verification: { text: 'Connect recorded edits with later test commands. Chronology does not establish that a test exercised a changed file.' },
  localization: { text: 'See how quickly a run found the files it changed, what it explored on the way, and which edits had no read of the current version. Localization describes the search, not whether the edits were right.' },
  capabilities: { text: 'Compare the sandbox, approval and network grants with the commands, writes and network a run used. A report only: AgentShark never writes agent configuration.' },
  diff: { text: 'Align two runs of one task by operation, object and outcome to find where they part and how each answered failures. The first divergence is a lead for an experiment, not a cause.' },
  compare: {
    text: 'Align raw records across two runs by event kind and tool name. Repeated records can make the alignment ambiguous; inspect the evidence before interpreting a difference.',
    pointer: ['Aligns raw records by kind and tool name. For two runs of one task, use ', 'diff', '.'],
  },
  search: { text: 'Find ordered and repeated behavior, such as an unsuccessful command followed by another attempt. Search only examines the selected trace.' },
  checks: { text: 'Evaluate explicit rules against recorded evidence. A passing check describes the trace; missing evidence produces unknown.' },
  coordination: { text: 'Inspect delegation and shared file activity. Overlaps and stale reads are candidates for review, not causal findings.' },
  dataset: { text: 'Export failure examples with reviewed labels, provenance and split checks. Redaction reduces exposure; review exported text before sharing.' },
  cohort: { text: 'Compare recorded runs by condition, agent or model. A manifest identifies tasks and repeated trials; descriptive differences do not establish causal effects.' },
  exportTable: { text: 'Export stable CSV or JSONL records with analysis versions and coverage. Redaction is enabled for exports.' },
  exportTelemetry: { text: 'Export observed spans as OTLP JSON with OpenInference attributes. The export reports omitted spans and unknown timing. Trace text is omitted by default.' },
  investigation: { text: 'Package a question, selected sessions, evidence references and human labels into a portable investigation document.' },
  replayPlan: { text: 'See which recorded tool calls agentshark replay would run again in a container, which it would skip and why, and the command that runs it. Nothing runs here.' },
  replayReport: { text: 'Load the JSON lines that agentshark replay --json wrote to review each verdict next to its recorded event. The first status difference is where the replay diverged.' },
};
const TWO_RUNS = new Set(['compare', 'diff']);
const SCOPED = new Set(['checks', 'search', 'dataset', 'cohort', 'exportTable', 'investigation', 'exportTelemetry']);

let operation = null, manifest, annotations = [], report = null, active = 0, listGeneration = 0;
// A recipe's multi-run `sessions` list, offered as an Analysis Scope choice (the pickers decide `sessions`, §6.5).
let recipeSessions = [];
// Picker lists: every role, and top-level runs only for Compare Runs (§6.5).
const lists = { all: { sessions: [], total: 0 }, main: { sessions: [], total: 0 } };
// Run identities by id, from the picker lists, each result's `sessions` map and title lookups.
const known = new Map();

const navButtons = () => [...$('analyses').querySelectorAll('button[data-operation]')];
const navButton = (op) => navButtons().find((b) => b.dataset.operation === op);
const toolName = (op) => {
  const b = navButton(op);
  return b?.dataset.engine ? `${b.textContent} (${b.dataset.engine})` : b?.textContent ?? op;
};

function status(text, error = false, actions = []) {
  $('status').replaceChildren(h('span', null, text), ...actions);
  $('status').className = error ? 'error' : '';
}

const download = (name, text, type = 'application/json') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** JSON from the engine; a failure carries the HTTP status and the engine's error code for `failure()`. */
async function request(path, body) {
  const response = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let value = null;
  try {
    value = await response.json();
  } catch {
    // A non-JSON answer (a 401 page) is reported by its status below.
  }
  if (!response.ok) throw Object.assign(new Error(value?.error?.message || value?.message || `Request failed (${response.status})`), { status: response.status, code: value?.error?.code ?? null });
  return value;
}

// ---------------------------------------------------------------------------
// Form

const field = (text, id, value = '', type = 'text', props = {}) => h('label', null, text, h('input', { id, type, value, ...props }));
const choice = (text, id, options) => h('label', null, text, h('select', { id }, options.map(([value, name]) => h('option', { value }, name))));
const checkbox = (text, id, checked) => h('label', { class: 'check' }, h('input', { type: 'checkbox', id, checked }), text);
const named = (values) => values.map((v) => [v, fieldLabel(v)]);

function choose(next, { replace = false } = {}) {
  if (!TOOLS[next]) return;
  const listChanged = (next === 'diff') !== (operation === 'diff');
  operation = next;
  report = null;
  recipeSessions = [];
  active++;
  $('run').disabled = false;
  $('results').replaceChildren();
  const button = navButton(next);
  $('heading').textContent = button.textContent;
  $('engine').textContent = button.dataset.engine ?? '';
  $('description').textContent = TOOLS[next].text;
  const pointer = TOOLS[next].pointer;
  $('pointer').hidden = !pointer;
  if (pointer) $('pointer').replaceChildren(pointer[0], h('a', { href: `#${pointer[1]}` }, toolName(pointer[1])), pointer[2]);
  for (const b of navButtons()) {
    const on = b === button;
    b.setAttribute('aria-current', on ? 'page' : 'false');
    // The tool list is one Tab stop; arrow keys move inside it (DESIGN §10.1).
    b.tabIndex = on ? 0 : -1;
  }
  // In the narrow layout the tools form one scrolling row; keep the current one visible.
  button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const twoRuns = TWO_RUNS.has(next);
  $('session-name').textContent = twoRuns ? 'Run A' : 'Session';
  $('right-label').hidden = !twoRuns;
  $('research-input').hidden = !['dataset', 'cohort', 'exportTable', 'investigation'].includes(next);
  const controls = $('controls');
  controls.replaceChildren();
  if (SCOPED.has(next)) controls.append(choice('Analysis Scope', 'scope-mode', [['selected-session', 'Selected session'], ['listed-sessions', 'Sessions listed in the picker'], ['manifest-sessions', 'Manifest sessions']]));
  if (next === 'context') controls.append(field('Inspect Before Event (optional event ID)', 'boundary'));
  if (next === 'checks') {
    const rules = ['tests-after-edit', 'unresolved-delegations', 'repeated-failed-actions', 'token-budget'];
    controls.append(
      h('div', { class: 'form-grid' }, rules.map((rule) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'rule', value: rule, checked: rule !== 'token-budget' }), fieldLabel(rule)))),
      field('Token Budget (input + output tokens)', 'budget', '100000', 'number'),
    );
  }
  if (next === 'search') controls.append(choice('Sequence Template', 'sequence-template', named(['failed-then-retry', 'read-then-edit', 'repeated-tool'])), field('Tool Name (optional)', 'tool-name'), field('Maximum Gap in Events', 'max-gap', '30', 'number'));
  if (next === 'localization') controls.append(choice('Windows', 'loc-scope', named(['turn', 'run'])));
  if (next === 'cache') controls.append(field('Idle Minutes Before a Cache Expires', 'idle-minutes', '5', 'number'));
  if (next === 'diff') controls.append(h('div', { class: 'form-grid' }, checkbox('Include subagents', 'diff-children', true), field('Actions per Run (up to 2,000)', 'diff-limit', '', 'number', { min: '1', max: '2000', step: '1', placeholder: formatInt(DEFAULT_ACTION_LIMIT) })));
  if (next === 'cohort') controls.append(choice('Group By', 'group-by', named(['agent', 'condition', 'model'])));
  if (next === 'exportTable') controls.append(choice('Table', 'export-table', named(['sessions', 'events', 'steps', 'failures', 'changes', 'annotations'])), choice('Format', 'export-format', [['csv', 'CSV'], ['jsonl', 'JSON lines']]));
  if (next === 'investigation') controls.append(field('Investigation Title', 'investigation-title', 'Trace investigation'), field('Question', 'investigation-question'));
  if (next === 'replayReport') {
    const input = h('input', { type: 'file', id: 'replay-file', accept: '.jsonl,.json,application/json,text/plain' });
    input.onchange = guard(async () => {
      report = null;
      const loaded = await replayRecords(input.files?.[0]);
      if (!loaded) return status('Choose a replay report file.');
      report = loaded;
      status(`Report loaded: ${plural(report.filter((r) => r.type === 'call').length, 'call')} of ${report[0].session}.`);
    });
    controls.append(h('label', null, 'Replay Report (JSON lines from agentshark replay --json or -o)', input));
  }
  if (next === 'dataset') controls.append(checkbox('Include unreviewed examples (clearly marked)', 'unreviewed', false));
  $('session').closest('.scope').hidden = next === 'replayReport';
  $('session').required = next !== 'replayReport';
  $('advanced').value = '';
  if (listChanged) fillPickers();
  sessionsStatus();
  status(twoRuns ? 'Choose two runs and run the analysis.' : 'Select a session and run the analysis.');
  if (location.hash.slice(1) !== next) {
    if (replace) history.replaceState(null, '', `#${next}`);
    else location.hash = next;
  }
}

function formInput() {
  if (operation === 'replayReport') {
    if (!report) throw new Error('Choose a replay report file first.');
    return { records: report };
  }
  const session = $('session').value;
  if (!session) throw new Error(TWO_RUNS.has(operation) ? 'Choose run A first.' : 'Select a session first.');
  const input = { session, sessions: [session] };
  const scope = $('scope-mode')?.value;
  if (scope === 'listed-sessions') input.sessions = pickerList().sessions.map((s) => s.id);
  if (scope === 'recipe-sessions') input.sessions = [...recipeSessions];
  if (scope === 'manifest-sessions') {
    if (!manifest) throw new Error('Load a research manifest before selecting manifest sessions.');
    input.sessions = [...new Set(manifest.runs.map((r) => r.sessionId))];
  }
  if (operation === 'context' && $('boundary').value.trim()) input.atEventId = $('boundary').value.trim();
  if (operation === 'localization') input.scope = $('loc-scope').value;
  if (operation === 'cache') input.idleMinutes = Number($('idle-minutes').value);
  if (TWO_RUNS.has(operation)) {
    const right = $('right').value;
    if (!right) throw new Error('Choose run B to compare with.');
    if (right === session) throw new Error('Choose two different runs.');
    input.left = session;
    input.right = right;
  }
  if (operation === 'diff') {
    if (!$('diff-children').checked) input.children = false;
    if ($('diff-limit').value.trim()) input.limit = Number($('diff-limit').value);
  }
  if (operation === 'checks') input.rules = [...document.querySelectorAll('input[name="rule"]:checked')].map((n) => (n.value === 'token-budget' ? { rule: n.value, threshold: Number($('budget').value) } : n.value));
  if (operation === 'search') {
    const tool = $('tool-name').value.trim(), p = tool ? { tool } : {};
    const template = $('sequence-template').value;
    input.maxGapEvents = Number($('max-gap').value);
    input.sequence = template === 'failed-then-retry'
      ? [{ ...p, kind: ['tool.result', 'tool.exec'], failure: true }, { ...p, kind: ['tool.call', 'tool.exec'], sameAsPrevious: ['tool', 'target'] }]
      : template === 'read-then-edit'
        ? [{ kind: 'tool.call', tool: 'Read' }, { kind: 'tool.call', tool: 'Edit', sameAsPrevious: ['target'] }]
        : [{ ...p, kind: ['tool.call', 'tool.exec'] }, { ...p, kind: ['tool.call', 'tool.exec'], sameAsPrevious: ['tool'], repeat: 2 }];
  }
  if (operation === 'dataset') Object.assign(input, { sessionIds: input.sessions, redact: true, includeUnreviewed: $('unreviewed').checked });
  if (operation === 'cohort') input.groupBy = $('group-by').value;
  if (operation === 'exportTable') Object.assign(input, { table: $('export-table').value, format: $('export-format').value, redact: true });
  if (operation === 'investigation') Object.assign(input, { title: $('investigation-title').value, ...($('investigation-question').value.trim() ? { question: $('investigation-question').value.trim() } : {}) });
  if (manifest && ['dataset', 'cohort', 'investigation'].includes(operation)) input.manifest = manifest;
  if (annotations.length && ['dataset', 'exportTable', 'investigation'].includes(operation)) input.annotations = annotations;
  return input;
}

/** The request: the form, then Advanced JSON, which never overrides the pickers (bug I4). */
const getInput = () => mergeAdvanced(formInput(), $('advanced').value);

/** A retry's patch applied to the controls, so the form shows what the next request sends. */
function applyPatch(patch) {
  if ('children' in patch && $('diff-children')) $('diff-children').checked = patch.children;
  if ('limit' in patch && $('diff-limit')) $('diff-limit').value = String(patch.limit);
}

// ---------------------------------------------------------------------------
// Session pickers

const pickerList = () => (operation === 'diff' ? lists.main : lists.all);
const optionFor = (id) => h('option', { value: id }, known.has(id) ? sessionOption({ id, ...known.get(id) }) : midId(id));

/** Rebuilds both pickers from the current list. A run chosen earlier stays chosen; "Run B" starts empty (§6.5). */
function fillPickers() {
  const ids = pickerList().sessions.map((s) => s.id);
  // Compare Runs aligns top-level runs; a subagent chosen for another tool does not carry over.
  const allowed = (id) => !!id && (operation !== 'diff' || (known.get(id)?.role ?? 'main') === 'main');
  for (const id of ['session', 'right']) {
    const select = $(id);
    const keep = allowed(select.value) ? select.value : '';
    const options = ids.map(optionFor);
    if (keep && !ids.includes(keep)) options.unshift(optionFor(keep));
    if (id === 'right') options.unshift(h('option', { value: '' }, 'Choose a run…'));
    else if (!options.length) options.push(h('option', { value: '' }, listGeneration ? 'No sessions' : 'Loading sessions…'));
    select.replaceChildren(...options);
    select.value = keep || (id === 'session' ? ids[0] ?? '' : '');
  }
}

/** Puts a run into a picker even when the list does not hold it (a recipe, Open Subagent, Show Whole Run). */
function pick(selectId, id) {
  const select = $(selectId);
  if (![...select.options].some((o) => o.value === id)) select.add(optionFor(id), selectId === 'right' ? 1 : 0);
  select.value = id;
}

function sessionsStatus(error) {
  const el = $('sessions-status');
  el.className = error ? 'hint error' : 'hint';
  if (error) return void (el.textContent = error);
  if (!listGeneration) return void (el.textContent = '');
  const q = $('find').value.trim();
  const { sessions, total } = pickerList();
  const noun = operation === 'diff' ? ['top-level run', 'top-level runs'] : ['session', 'sessions'];
  const matching = q ? ` matching “${q}”` : '';
  if (!sessions.length) el.textContent = q ? `No ${noun[1]}${matching}.` : 'No sessions are indexed yet. Refresh when indexing finishes.';
  else if (total > sessions.length) el.textContent = `${formatInt(sessions.length)} of ${count(total, noun)}${matching}, newest first; search to find older ones.`;
  else el.textContent = `${count(total, noun)}${matching}, newest first.`;
}

/** Both picker lists, narrowed by the Find field: the 500 newest sessions of any role, and of top-level runs. */
async function loadSessions() {
  const q = $('find').value.trim();
  const url = (role) => `/api/sessions?${new URLSearchParams({ limit: '500', ...(role ? { role } : {}), ...(q ? { q } : {}) })}`;
  const generation = ++listGeneration;
  try {
    const [all, main] = await Promise.all([request(url()), request(url('main'))]);
    if (generation !== listGeneration) return;
    lists.all = { sessions: all.sessions ?? [], total: all.total ?? 0 };
    lists.main = { sessions: main.sessions ?? [], total: main.total ?? 0 };
    for (const s of [...lists.all.sessions, ...lists.main.sessions]) known.set(s.id, sessionInfo(s));
    fillPickers();
    sessionsStatus();
  } catch (e) {
    if (generation === listGeneration) sessionsStatus(e.message);
  }
}

/** The engine's identities for the runs of a result (engine 1.1 `sessions`), kept over the list rows. */
function absorb(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  for (const [id, s] of Object.entries(map)) if (s && typeof s === 'object') known.set(id, { ...sessionInfo(s), nativeId: known.get(id)?.nativeId ?? null });
}

/** Titles for runs no list or result has named yet, 50 per request. A run whose lookup fails shows its id. */
async function resolve(ids) {
  const missing = [...new Set(ids)].filter((id) => typeof id === 'string' && id && !known.has(id));
  const chunks = [];
  for (let i = 0; i < missing.length; i += 50) chunks.push(missing.slice(i, i + 50));
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const value = await request(`/api/sessions?${new URLSearchParams({ ids: chunk.join(','), limit: String(chunk.length) })}`);
      for (const s of value.sessions ?? []) known.set(s.id, sessionInfo(s));
    } catch {
      // The id stands in for the title.
    }
  }));
}

/** The parents of a subagent, so Show Whole Run can name its root (§4.3). */
async function resolveParents(id) {
  for (let at = id, depth = 0; at && depth < 10; depth++) {
    const parent = known.get(at)?.parentId;
    if (parent && !known.has(parent)) await resolve([parent]);
    at = parent;
  }
}

// ---------------------------------------------------------------------------
// Running

async function run(event) {
  event?.preventDefault();
  const generation = ++active;
  let input;
  try {
    input = getInput();
  } catch (e) {
    return status(e.message, true);
  }
  $('run').disabled = true;
  status(operation === 'perf' ? 'Following the critical path…' : operation === 'diff' ? 'Aligning the runs…' : 'Analyzing recorded evidence…');
  $('results').replaceChildren();
  try {
    const result = await request(`/api/workbench/${operation}`, input);
    if (generation !== active) return;
    absorb(result.sessions);
    await resolve([...(result.coverage?.sessionIds ?? []), result.sessionId, result.left?.session, result.right?.session]);
    if (operation === 'perf') await resolveParents(result.sessionId);
    if (generation !== active) return;
    render(result, input);
    status('Analysis complete. Review the data gaps before using the findings.');
  } catch (e) {
    if (generation !== active) return;
    const f = failure({ status: e.status, code: e.code, message: e.message }, operation, input);
    status(f.text, true, f.retries.map((r) => h('button', { type: 'button', onClick: () => { applyPatch(r.input); run(); } }, r.label)));
  } finally {
    if (generation === active) $('run').disabled = false;
  }
}

/** Opens another run in the current tool and runs it (Open Subagent, Show Whole Run). */
function openSession(id) {
  pick('session', id);
  run();
}

// ---------------------------------------------------------------------------
// Shared result parts

const dash = (title = NOT_DETERMINED) => h('span', { class: 'muted', title }, DASH);
const derivedMark = () => h('span', { class: 'mark', title: DERIVED_SHARE, 'aria-label': 'derived' }, '≈');
const section = (title, ...children) => h('section', { class: 'block' }, h('h2', null, title), ...children);
const timeCell = (us) => (us == null ? h('td', { class: 'num' }, dash()) : h('td', { class: 'num' }, duration(us)));
const numericKinds = new Set(['duration', 'ms', 'share', 'ratio', 'tokens', 'number']);

/** A link to the event in the web viewer. It opens a new tab, so the results stay (§6.5). */
function eventLink(ref, text, cls = null) {
  if (!ref?.eventId) return dash('No event marks this');
  if (ref.redacted || /^event_[a-f0-9]+$/.test(ref.eventId)) return h('span', { class: ['evidence', cls], title: 'Redacted reference' }, text ?? `${ref.eventId} (redacted)`);
  const href = `/#/events?${new URLSearchParams({ session: ref.sessionId || $('session').value, event: ref.eventId })}`;
  const where = ref.source ? `${ref.source}${ref.line == null ? '' : `:${ref.line}`}` : null;
  const title = [text ? ref.eventId : null, ref.sessionId ? sessionTitle(ref.sessionId, known) : null, where, ref.confidence].filter(Boolean).join(' · ');
  return h('a', { class: text ? cls : ['evidence', cls], href, target: '_blank', rel: 'noopener', title }, text ?? ref.eventId);
}

/** Up to 50 evidence events behind a count, listed on demand (§4.9 Rework). */
function evidenceList(refs, summary) {
  if (!refs?.length) return dash('No evidence returned');
  return h('details', { class: 'evidence-list' }, h('summary', null, summary ?? count(refs.length, ['event', 'events'])), h('ol', null, refs.map((ref) => h('li', null, eventLink(ref)))));
}

/** A table that renders `page` rows at a time behind "Show More", so 3,000 rows never block the page. */
function pagedTable(items, row, head, { page = 100, cls = null, noun = ['record', 'records'] } = {}) {
  const body = h('tbody');
  const more = h('button', { type: 'button', class: 'more' });
  let shown = 0;
  const step = () => {
    body.append(...items.slice(shown, shown + page).map(row));
    shown = Math.min(items.length, shown + page);
    more.hidden = shown >= items.length;
    more.textContent = `Show ${formatInt(Math.min(page, items.length - shown))} More (${formatInt(shown)} of ${count(items.length, noun)} shown)`;
  };
  more.addEventListener('click', step);
  step();
  return h('div', null, h('div', { class: 'table-wrap' }, h('table', { class: cls }, h('thead', null, head), body)), more);
}

const headRow = (...cells) => h('tr', null, cells.map(([text, num]) => h('th', { class: num ? 'num' : null }, text)));

/** "11m 30s critical path · 5 of 37 sessions on the path": what the results cover (§4.3, §5.5). */
const scopeLine = (text, title, ...extra) => h('p', { class: 'scope-line', title }, text, ...extra);

const rulesOf = (r) => [...new Set([r.method, r.comparisonRule, r.criticalPath?.bindingSrc, ...(Array.isArray(r.rules) ? r.rules : [])].filter((x) => typeof x === 'string'))];

/** The evidence line (§4.4): "ⓘ 2 data gaps: …" opening every sentence, and the events examined. */
function evidenceLine(result, notes) {
  const cov = result.coverage ?? {};
  const versions = `Analysis ${result.analysisVersion ?? 'unknown'} · index analysis ${cov.indexAnalysisVersion ?? 'unknown'} · snapshot ${fullTime(cov.snapshotAt) || 'unknown'}`;
  const rules = rulesOf(result);
  const rulesText = rules.length ? `Rules: ${rules.join(', ')}. ${PRECISION}` : null;
  const counts = h('span', { class: 'counts', title: versions }, coverageLine(result));
  if (!notes.length) return h('div', { class: 'evidence-line', title: rulesText }, counts);
  return h('details', { class: 'evidence-line gaps' },
    h('summary', null, h('span', { class: 'gap-line' }, h('span', { class: 'info', 'aria-hidden': 'true' }, 'ⓘ'), gapLine(notes)), counts),
    h('ul', null, notes.map((n) => h('li', { title: n.code }, n.text))),
    rulesText ? h('p', { class: 'muted' }, rulesText) : null);
}

function resultActions(result) {
  const actions = h('div', { class: 'result-actions' }, h('button', { type: 'button', onClick: () => download(`agentshark-${operation}.json`, JSON.stringify(result, null, 2)) }, 'Download JSON'));
  const content = result.content ?? result.text ?? result.data;
  if (operation === 'exportTable' && typeof content === 'string') actions.append(h('button', { type: 'button', onClick: () => download(`agentshark-${$('export-table').value}.${$('export-format').value}`, content, 'text/plain') }, 'Download Table'));
  if (operation === 'exportTelemetry' && result.document) actions.append(h('button', { type: 'button', onClick: () => download('agentshark-otlp.json', JSON.stringify(result.document, null, 2)) }, 'Download OTLP Document'));
  return actions;
}

/** The raw result, built only when opened: a Compare Runs result can be 800 KB. */
function completeJson(result) {
  const pre = h('pre');
  const details = h('details', { class: 'json' }, h('summary', null, 'Complete JSON'), pre);
  details.addEventListener('toggle', () => { if (details.open && !pre.firstChild) pre.textContent = JSON.stringify(result, null, 2); });
  return details;
}

// Fields that a summary or the evidence line already shows, so the generic renderer leaves them out. The envelope's
// `sessions` map is identity, not a finding; Cache Anatomy and Capability Envelope return a `sessions` list of their own.
const ENVELOPE = new Set(['schemaVersion', 'analysisVersion', 'coverage', 'summary', 'caveats', 'method', 'comparisonRule', 'rules']);
const isIdentityMap = (key, value) => key === 'sessions' && value && typeof value === 'object' && !Array.isArray(value);
const OWN = {
  perf: new Set(['sessionId', 'criticalPath', 'rework', 'collaboration', 'missing']),
  diff: new Set(['left', 'right', 'delta', 'firstDivergence', 'regions', 'alignment']),
};

function render(result, input) {
  const notes = gapNotes(result);
  const ctx = { known, notes: new Map(notes.map((n) => [n.code, n.text])), shareOf: null };
  const own = operation === 'perf' && result.criticalPath ? perfView(result, notes, ctx)
    : operation === 'diff' && Array.isArray(result.alignment) ? diffView(result, notes, input) : null;
  const out = own ?? [evidenceLine(result, notes), summaryTiles(result.summary, ctx), resultActions(result)];
  for (const [key, value] of Object.entries(result)) {
    if (ENVELOPE.has(key) || isIdentityMap(key, value) || (own && OWN[operation].has(key))) continue;
    out.push(section(fieldLabel(key), valueNode(key, value, ctx)));
  }
  if (Array.isArray(result.caveats) && result.caveats.length) out.push(section('Caveats', h('ul', { class: 'caveats' }, result.caveats.map((c) => h('li', null, c)))));
  if (own) out.push(resultActions(result));
  out.push(completeJson(result));
  $('results').replaceChildren(...out.filter(Boolean));
}

// ---------------------------------------------------------------------------
// The generic renderer (§6.4): every field by its kind, never raw µs, fractions or ids

const BADGES = new Map([
  ...['observed', 'derived', 'candidate', 'unknown', 'pass', 'fail', 'passed', 'failed', 'unchanged', 'changed', 'same', 'output', 'status', 'unrecorded', 'started', 'skipped', 'error'].map((w) => [w, w]),
  ['left-only', 'only in A'], ['right-only', 'only in B'], ['outcome-differs', 'different outcome'], ['object-differs', 'different target'],
]);
const isEvidence = (v) => v && typeof v === 'object' && typeof v.eventId === 'string';
const ruleTitle = (values) => (values.length ? `Rule: ${values.join(', ')}. ${PRECISION}` : null);

/** Summary counts as tiles, each count with its noun ("12 changes"); other summaries print by kind. */
function summaryTiles(summary, ctx) {
  if (!summary || typeof summary !== 'object') return null;
  const tiles = Object.entries(summary).filter(([, v]) => v === null || typeof v === 'number').map(([k, v]) => {
    const kind = v === null ? null : fieldKind(k, v);
    const f = formatField(k, v, ctx);
    const noun = kind === 'number' ? countNoun(k, v) : kind === 'tokens' ? `${fieldLabel(k).toLowerCase()} tokens` : columnLabel(k, v, ctx);
    return h('div', { class: 'metric' }, h('strong', { title: f.title }, f.text), h('span', null, noun));
  });
  return tiles.length ? h('div', { class: 'metrics' }, tiles) : null;
}

function valueNode(key, value, ctx, depth = 0) {
  if (value == null) return dash();
  if (typeof value !== 'object') {
    if (typeof value === 'string' && BADGES.has(value)) return h('span', { class: `badge ${value}` }, BADGES.get(value));
    const f = formatField(key, value, ctx);
    return h('span', { title: f.title }, f.text);
  }
  if (isEvidence(value)) return eventLink(value);
  if (Array.isArray(value)) return listNode(key, value, ctx, depth);
  return factsNode(value, ctx, depth);
}

function listNode(key, list, ctx, depth) {
  if (!list.length) return h('p', { class: 'muted' }, 'No matching records.');
  if (list.every(isEvidence)) return h('span', { class: 'evidence-row' }, list.slice(0, 50).map((ref) => eventLink(ref)));
  if (list.every((v) => v === null || typeof v !== 'object')) {
    // Run ids read as titles and gap codes as sentences.
    const items = list.slice(0, 100).map((v) => h('li', null, valueNode(key, v, ctx, depth + 1)));
    return h('div', null, h('ul', { class: 'plain' }, items), list.length > items.length ? h('p', { class: 'muted' }, `Showing ${formatInt(items.length)} of ${formatInt(list.length)}. The complete JSON below has every value.`) : null);
  }
  if (depth < 3 && list.every((v) => v && typeof v === 'object' && !Array.isArray(v) && !isEvidence(v))) return tableNode(list, ctx, depth);
  return h('div', null, list.slice(0, 100).map((item) => h('div', { class: depth ? null : 'card' }, valueNode(key, item, ctx, depth + 1))));
}

/** Records as a table: rule ids move to the row tooltip, time columns drop a repeated date, numbers align right. */
function tableNode(items, ctx, depth) {
  const all = [...new Set(items.flatMap((v) => Object.keys(v)))];
  const ruleKeys = all.filter((k) => items.some((v) => v[k] != null && fieldKind(k, v[k]) === 'rule'));
  const keys = all.filter((k) => !ruleKeys.includes(k)).slice(0, 8);
  const sample = (k) => items.find((v) => v[k] != null)?.[k];
  const numeric = new Set(keys.filter((k) => numericKinds.has(fieldKind(k, sample(k)))));
  const head = h('tr', null, keys.map((k) => h('th', { class: numeric.has(k) ? 'num' : null }, columnLabel(k, sample(k), ctx))));
  const prev = {};
  const row = (item) => h('tr', { title: ruleTitle(ruleKeys.map((k) => item[k]).filter(Boolean)) }, keys.map((k) => {
    const cell = h('td', { class: numeric.has(k) ? 'num' : null }, valueNode(k, item[k], { ...ctx, prev: prev[k] }, depth + 1));
    if (typeof item[k] === 'number') prev[k] = item[k];
    return cell;
  }));
  const hidden = all.length - ruleKeys.length - keys.length;
  return h('div', null, pagedTable(items, row, head), hidden > 0 ? h('p', { class: 'muted' }, `${count(hidden, ['more field is', 'more fields are'])} in the complete JSON below.`) : null);
}

function factsNode(obj, ctx, depth) {
  const rules = [];
  const dl = h('dl', { class: 'facts' });
  for (const [key, v] of Object.entries(obj)) {
    if (v != null && fieldKind(key, v) === 'rule') {
      rules.push(...[v].flat());
      continue;
    }
    const deep = depth >= 4 && v && typeof v === 'object';
    dl.append(h('dt', null, columnLabel(key, v, ctx)), h('dd', null, deep ? h('details', null, h('summary', null, 'Show Details'), h('pre', null, JSON.stringify(v, null, 2))) : valueNode(key, v, ctx, depth + 1)));
  }
  if (rules.length) dl.title = ruleTitle(rules);
  return dl;
}

// ---------------------------------------------------------------------------
// Critical Path (AgentPerf, §4)

function perfView(result, notes, ctx) {
  const cp = result.criticalPath;
  ctx.shareOf = cp.wallUs ? `of ${duration(cp.wallUs)} path` : null;
  const root = result.sessionId;
  const info = known.get(root);
  const whole = info?.role && info.role !== 'main' && rootOf(root, known) !== root
    ? h('button', { type: 'button', class: 'inline', onClick: () => openSession(rootOf(root, known)) }, 'Show Whole Run') : null;
  const partial = perfWindow(result, info);
  const verdict = perfVerdict(result);
  const segments = segmentsSection(result, notes);
  return [
    scopeLine(perfHeader(result, known), PERF_SCOPE, whole),
    evidenceLine(result, notes),
    partial ? h('p', { class: 'warn-line' }, partial) : null,
    h('div', { class: `verdict ${verdict.state}` },
      verdict.lines.map((l) => h('p', { class: 'verdict-line' }, l.text, l.derived ? derivedMark() : null)),
      verdict.notes.map((n) => h('p', { class: 'verdict-note' }, n.text, n.derived ? derivedMark() : null))),
    classLegend(cp, segments.filter),
    lanesSection(result),
    contributorsSection(result),
    reworkSection(result),
    subagentsSection(result),
    segments.node,
  ];
}

/** The class bar and its legend (§4.7); the legend is the bar's text equivalent and filters the Segments table. */
function classLegend(cp, onPick) {
  const rows = classRows(cp);
  if (!rows.length) return null;
  const bar = h('div', { class: 'class-bar', role: 'img', 'aria-label': `Critical path by class: ${rows.map((r) => `${r.name}, ${r.part}`).join('; ')}` },
    rows.map((r) => h('span', { dataset: { cls: r.cls }, style: { flexGrow: String(r.share ?? 0) }, title: `${r.name}: ${r.part}` })));
  let picked = null;
  const buttons = rows.map((r) => h('button', {
    type: 'button', class: 'legend-name', 'aria-pressed': 'false', title: `Show only ${r.name} segments`, dataset: { cls: r.cls },
    onClick: () => {
      picked = picked === r.cls ? null : r.cls;
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.cls === picked));
      onPick(picked);
    },
  }, h('span', { class: 'swatch', dataset: { cls: r.cls } }), r.name));
  const legend = h('table', { class: 'legend' },
    h('thead', null, headRow(['Class'], ['Time', true], [pathShareHeader(cp), true])),
    h('tbody', null, rows.map((r, i) => h('tr', null, h('td', null, buttons[i]), h('td', { class: 'num' }, r.time), h('td', { class: 'num' }, r.shareText)))));
  const buckets = Object.entries(cp.byBucket ?? {}).sort((a, b) => b[1].us - a[1].us);
  const byBucket = buckets.length ? h('details', { class: 'buckets' }, h('summary', null, 'By time bucket'), h('table', { class: 'legend' },
    h('thead', null, headRow(['Bucket'], ['Time', true], [pathShareHeader(cp), true])),
    h('tbody', null, buckets.map(([b, v]) => h('tr', null, h('td', null, BUCKET_NAME[b] ?? b), h('td', { class: 'num' }, duration(v.us)), h('td', { class: 'num' }, share(v.share) || DASH)))))) : null;
  return h('div', { class: 'classes' }, bar, legend, byBucket);
}

/** Sessions on the path, in `bySession` order: the text form of the track's lanes (§4.8). */
function lanesSection(result) {
  const cp = result.criticalPath;
  if (!cp.bySession?.length) return null;
  return section('Sessions on the path', h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, headRow(['Session'], ['On the path', true], [pathShareHeader(cp), true])),
    h('tbody', null, cp.bySession.map((s) => h('tr', null,
      h('td', { title: midId(s.sessionId) }, laneName(s.sessionId, result.sessionId, known)), timeCell(s.us), h('td', { class: 'num' }, share(s.share) || DASH)))))));
}

/** Contributors (§4.9): tools by target, then model steps, each with its session and time on the path. */
function contributorsSection(result) {
  const cp = result.criticalPath;
  const shareHead = cp.wallUs ? `Share (of ${duration(cp.wallUs)})` : 'Share';
  const group = (title, list, name, empty) => [
    h('h3', null, title),
    list?.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, headRow(['Contributor'], ['Session'], ['On path', true], [shareHead, true], ['Evidence'])),
      h('tbody', null, list.map((c) => {
        const sid = c.sessionId ?? c.evidence?.[0]?.sessionId;
        return h('tr', null, h('td', { class: 'primary' }, name(c)), h('td', null, sid ? laneName(sid, result.sessionId, known) : dash()), timeCell(c.us),
          h('td', { class: 'num' }, share(c.share) || DASH), h('td', null, eventLink(c.evidence?.[0], 'Event')));
      })))) : h('p', { class: 'muted' }, empty),
  ];
  return section('Contributors',
    ...group('Tools on the path', cp.topTools, (t) => h('code', { title: t.key }, t.key), 'No tool time on the path.'),
    ...group('Model steps on the path', cp.topSteps, (s) => h('span', { title: s.key }, stepName(s)), 'No model step time on the path.'));
}

function reworkSection(result) {
  const rows = REWORK.map(([key, label, noun]) => [label, noun, result.rework?.[key]]).filter(([, , v]) => v);
  if (!rows.length) return null;
  const onPath = result.criticalPath.wallUs ? `On path (of ${duration(result.criticalPath.wallUs)})` : 'On path';
  return section('Rework', h('p', { class: 'muted' }, 'Repeated or reworked time, not waste.'), h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, headRow(['Pattern'], ['Count', true], ['Time', true], [onPath, true], ['Evidence'])),
    h('tbody', null, rows.map(([label, noun, v]) => h('tr', null,
      h('td', null, label), h('td', { class: 'num' }, count(v.count ?? 0, noun)), timeCell(v.us), timeCell(v.onPathUs), h('td', null, evidenceList(v.evidence))))))));
}

function subagentsSection(result) {
  const c = result.collaboration;
  if (!c) return null;
  const list = [...(c.delegations ?? [])].sort((a, b) => (b.onPathUs ?? 0) - (a.onPathUs ?? 0));
  let prev;
  const row = (d) => {
    const started = h('td', { title: fullTime(d.start) || null }, d.start == null ? dash() : clock(d.start, prev));
    prev = d.start;
    return h('tr', null,
      h('td', { class: 'primary', title: midId(d.child) }, sessionTitle(d.child, known)), started, timeCell(d.busyUs), timeCell(d.parentWaitUs), timeCell(d.onPathUs), timeCell(d.siblingOverlapUs),
      h('td', null, d.duplicateReads?.count ? evidenceList(d.duplicateReads.evidence, count(d.duplicateReads.count, ['read', 'reads'])) : '0 reads'),
      h('td', null, h('button', { type: 'button', class: 'inline', onClick: () => openSession(d.child) }, 'Open Subagent')));
  };
  return section('Subagents', h('p', null, parallelLine(c)), list.length
    ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, headRow(['Subagent'], ['Started'], ['Busy', true], ['Parent waited', true], ['On path', true], ['Overlap with siblings', true], ['Duplicate reads'], [''])),
      h('tbody', null, list.map(row))))
    : h('p', { class: 'muted' }, 'This run delegated no work to subagents.'));
}

/** Segments (§4.9): the path as rows, 200 at a time; a legend row narrows them to one class. */
function segmentsSection(result, notes) {
  const cp = result.criticalPath;
  const all = cp.segments ?? [];
  const heading = h('h2');
  const holder = h('div');
  const cap = notes.find((n) => n.code === 'critical-path-segment-limit');
  const filter = (cls) => {
    const items = cls ? all.filter((s) => s.class === cls) : all;
    heading.textContent = cls ? `Segments · ${className(cls)} · ${count(items.length, ['segment', 'segments'])}` : `Segments · ${count(all.length, ['segment', 'segments'])}`;
    let prev;
    const row = (s) => {
      const start = h('td', { title: fullTime(s.start) }, clock(s.start, prev));
      prev = s.start;
      return h('tr', null, start, h('td', { title: midId(s.sessionId) }, laneName(s.sessionId, result.sessionId, known)),
        h('td', null, h('span', { class: 'swatch', dataset: { cls: s.class } }), className(s.class)),
        h('td', { class: 'num' }, duration(s.us), s.logged ? null : h('span', { class: 'mark', title: 'Derived from timestamps' }, '≈')),
        h('td', null, s.evidence?.length ? eventLink(s.evidence[0], 'Event') : dash('No event marks this time')));
    };
    holder.replaceChildren(items.length
      ? pagedTable(items, row, headRow(['Start'], ['Session'], ['Class'], ['Duration', true], ['Evidence']), { page: 200, noun: ['segment', 'segments'] })
      : h('p', { class: 'muted' }, 'No segments of this class.'));
  };
  filter(null);
  return { node: h('section', { class: 'block' }, heading, holder, cap ? h('p', { class: 'muted', title: cap.code }, cap.text) : null), filter };
}

// ---------------------------------------------------------------------------
// Compare Runs (AgentDiff, §5)

function diffView(result, notes, input) {
  // The two permanent gaps live on the divergence card's caveat line (§5.8).
  const conditional = notes.filter((n) => !(n.code in PERMANENT_GAPS));
  const table = alignmentSection(result);
  return [
    scopeLine(diffHeader(result, input), null),
    evidenceLine(result, conditional),
    runsSection(result, input),
    behaviorSection(result),
    divergenceSection(result, table),
    table.node,
  ];
}

/** The runs grid (§5.6): A and B side by side with the difference in words; its open state is remembered. */
function runsSection(result, input) {
  const grid = runsGrid(result, known, { limit: input.limit ?? DEFAULT_ACTION_LIMIT });
  const cell = (c) => h('td', { title: c.title ?? null }, c.text, c.sub ? h('div', { class: 'sub' }, c.sub) : null);
  const runCell = (c) => h('td', null,
    h('button', { type: 'button', class: 'run-title', title: `${c.title} · Click to copy the run ID`, onClick: async () => status((await copyText(c.id)) ? 'Copied the run ID.' : 'Could not copy the run ID.') }, c.text),
    c.sub ? h('div', { class: 'sub' }, c.sub) : null);
  const rows = grid.map((r) => h('tr', null, h('th', { scope: 'row' }, r.label), ...r.cells.map(r.label === 'Run' ? runCell : cell),
    r.diff ? h('td', { title: r.diff.title ?? null }, r.diff.text) : h('td')));
  const details = h('details', { class: 'runs', open: loadPref('workbench.runsOpen', true) },
    h('summary', null, 'Runs'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'runs-grid' }, h('thead', null, headRow([''], ['A'], ['B'], ['Difference (B vs A)'])), h('tbody', null, rows))),
    runCautions(result, known).map((t) => h('p', { class: 'warn-line' }, t)));
  details.addEventListener('toggle', () => savePref('workbench.runsOpen', details.open));
  return details;
}

/** Behavior (§5.7): mirrored bars per row, A growing left and B right; the four rework counts open their evidence. */
function behaviorSection(result) {
  const [lp, rp] = [result.left?.profile, result.right?.profile];
  const findings = (p, key) => {
    const list = p?.[key]?.evidence ?? [];
    return list.length
      ? h('ol', { class: 'findings' }, list.map((f) => h('li', null, f.detail ? h('code', null, f.detail) : null,
        f.confidence === 'candidate' ? h('span', { class: 'mark', title: `Candidate. ${PRECISION}` }, '?') : null, ' ',
        (f.evidence ?? []).map((ref, i) => eventLink(ref, `Event ${i + 1}`, 'inline-link')))))
      : h('p', { class: 'muted' }, 'None.');
  };
  const body = h('tbody');
  let group = null;
  for (const r of behaviorRows(lp, rp)) {
    if (r.group && r.group !== group) {
      group = r.group;
      body.append(h('tr', { class: 'group' }, h('th', { colspan: 5, scope: 'rowgroup' }, group)));
    }
    const max = Math.max(r.a, r.b) || 1;
    const bar = (n, side) => h('td', { class: `bar ${side}`, 'aria-hidden': 'true' }, h('span', { style: { width: `${(n / max) * 100}%` } }));
    const tr = h('tr', { title: r.title ?? null }, h('th', { scope: 'row' }, r.label));
    if (r.evidence && (r.a || r.b)) {
      const detail = h('tr', { class: 'detail', hidden: true }, h('td', { colspan: 5 }, h('div', { class: 'detail-sides' },
        h('div', null, h('h4', null, `A: ${r.aText}`), findings(lp, r.evidence)), h('div', null, h('h4', null, `B: ${r.bText}`), findings(rp, r.evidence)))));
      const toggle = h('button', { type: 'button', class: 'link-btn', 'aria-expanded': 'false', onClick: () => {
        detail.hidden = !detail.hidden;
        toggle.setAttribute('aria-expanded', String(!detail.hidden));
      } }, 'Evidence');
      tr.append(h('td', { class: 'num' }, r.aText), bar(r.a, 'a'), bar(r.b, 'b'), h('td', null, r.bText, ' ', toggle));
      body.append(tr, detail);
    } else {
      tr.append(h('td', { class: 'num' }, r.aText), bar(r.a, 'a'), bar(r.b, 'b'), h('td', null, r.bText));
      body.append(tr);
    }
  }
  return h('details', { class: 'behavior' }, h('summary', null, 'Behavior: rereads, reverts, retries, fix loops, responses to failure'),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, headRow([''], ['A', true], [''], [''], ['B'])), body)),
    h('p', { class: 'muted' }, 'Responses to failure are counts only; the engine returns no evidence for them.'));
}

/** Four lines of an excerpt with Show All (§5.8). */
function excerptBlock(text) {
  const pre = h('pre', { class: 'excerpt' }, text);
  const long = text.split('\n').length > 4 || text.length > 320;
  if (!long) return pre;
  const toggle = h('button', { type: 'button', class: 'link-btn', onClick: () => {
    const open = pre.classList.toggle('open');
    toggle.textContent = open ? 'Show Less' : 'Show All';
  } }, 'Show All');
  return h('div', null, pre, toggle);
}

/** The first divergence card (§5.8). It never claims a cause. */
function divergenceSection(result, table) {
  const d = divergence(result);
  const fd = result.firstDivergence;
  const card = h('section', { class: 'divergence', 'aria-label': 'First divergence' },
    h('div', { class: 'dv-title' }, h('strong', null, d.title), fd ? h('span', { class: 'lead' }, LEAD) : null),
    d.detail ? h('p', null, d.detail) : null);
  if (fd) {
    const side = (label, s) => h('div', { class: 'dv-side' },
      h('h3', null, `${label} saw`),
      s?.observation ? [excerptBlock(s.observation.excerpt ?? ''), eventLink(s.observation.evidence?.[0], 'Show Event', 'inline-link')] : h('p', { class: 'muted' }, 'No observation recorded.'),
      h('h3', null, `${label} next`),
      s?.next?.length ? h('ul', { class: 'tokens' }, s.next.map((v) => h('li', null, eventLink(v.evidence?.[0], actionText(v), 'token')))) : h('p', { class: 'muted' }, 'No later actions.'));
    const row = result.alignment?.[fd.index];
    const show = (label, view, s) => {
      const ref = view?.evidence?.[0] ?? s?.next?.[0]?.evidence?.[0];
      return ref ? eventLink(ref, label, 'button') : null;
    };
    card.append(
      h('div', { class: 'dv-sides' }, side('A', fd.left), side('B', fd.right)),
      h('div', { class: 'dv-actions' }, h('button', { type: 'button', onClick: () => table.reveal(fd.index) }, 'Show Row'), show('Show A in Events', row?.left, fd.left), show('Show B in Events', row?.right, fd.right)));
  }
  card.append(h('p', { class: 'caveat-line', title: (result.caveats ?? []).join('\n') || null }, caveatLine(result)));
  return card;
}

const STATUS_GLYPH = { same: '=', 'outcome-differs': '!', 'object-differs': '⇄', 'left-only': '‹', 'right-only': '›' };

/**
 * Summary chips and the alignment table (§5.9, §5.10): region headers, runs of four or more same rows folded, chips
 * and Only differences filtering, 300 items at a time. `reveal(index)` shows one row wherever it is.
 */
function alignmentSection(result) {
  const rows = result.alignment;
  const regionAt = new Map((result.regions ?? []).map((r, i) => [r.from, [r, i + 1]]));
  const active = new Set();
  let onlyDiff = false, items = [], shown = 0;
  const body = h('tbody');
  const more = h('button', { type: 'button', class: 'more' });
  const matches = (r) => (!active.size || active.has(r.status) || (active.has('ambiguous') && r.ambiguous)) && (!onlyDiff || r.status !== 'same');

  const side = (v) => {
    if (!v) return h('td', { class: 'side empty' });
    const o = actionObject(v);
    return h('td', { class: 'side', title: v.outcome === 'unknown' ? 'Outcome not logged' : null },
      h('span', { class: 'op' }, OP_WORD[v.op] ?? v.op), ' ', eventLink(v.evidence?.[0], o.text, 'object'),
      v.outcome === 'failed' ? h('span', { class: 'failed' }, ' failed') : null);
  };
  const alignRow = (r) => h('tr', {
    id: `al-row-${r.index}`, class: r.status,
    title: [r.left && actionState(r.left) ? `A: ${actionState(r.left)}` : null, r.right && actionState(r.right) ? `B: ${actionState(r.right)}` : null].filter(Boolean).join('\n') || null,
  },
  h('td', { class: 'num' }, formatInt(r.index + 1)), side(r.left),
  h('td', { class: `status ${r.status}`, title: `${STATUS_WORD[r.status]}. ${confidenceNote(r)}` },
    h('span', { 'aria-hidden': 'true' }, STATUS_GLYPH[r.status] ?? ''), h('span', { class: 'sr-only' }, STATUS_WORD[r.status]), confidenceMark(r.left && r.right ? r.confidence : null)),
  side(r.right));
  const foldRow = (list) => {
    const label = `${count(list.length, ['same action', 'same actions'])} (rows ${formatInt(list[0].index + 1)}–${formatInt(list[list.length - 1].index + 1)})`;
    let open = null;
    const button = h('button', { type: 'button', class: 'link-btn', 'aria-expanded': 'false', dataset: { from: String(list[0].index), to: String(list[list.length - 1].index) }, onClick: () => {
      if (open) {
        open.forEach((n) => n.remove());
        open = null;
      } else {
        open = list.map(alignRow);
        tr.after(...open);
      }
      button.setAttribute('aria-expanded', String(!!open));
      button.textContent = `${open ? '▾' : '▸'} ${label}`;
    } }, `▸ ${label}`);
    const tr = h('tr', { class: 'fold' }, h('td', { colspan: 4 }, button));
    return tr;
  };
  const node = (it) => (it.region ? h('tr', { class: 'region' }, h('td', { colspan: 4 }, regionHeader(it.region, it.n))) : it.fold ? foldRow(it.fold) : alignRow(it.row));
  const step = () => {
    body.append(...items.slice(shown, shown + 300).map(node));
    shown = Math.min(items.length, shown + 300);
    more.hidden = shown >= items.length;
    more.textContent = `Show More (${formatInt(shown)} of ${count(items.length, ['item', 'items'])} shown)`;
  };
  const build = () => {
    // With a chip on, rows list flat; otherwise regions get headers and runs of same rows fold.
    const flat = active.size > 0;
    const list = rows.filter(matches);
    items = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!flat && regionAt.has(r.index)) {
        const [region, n] = regionAt.get(r.index);
        items.push({ region, n });
      }
      if (!flat && r.status === 'same') {
        let j = i;
        while (j < list.length && list[j].status === 'same') j++;
        if (j - i >= 4) {
          items.push({ fold: list.slice(i, j) });
          i = j - 1;
          continue;
        }
      }
      items.push({ row: r });
    }
    shown = 0;
    body.replaceChildren();
    step();
  };
  more.addEventListener('click', step);

  const chips = summaryChips(result.summary).map((c) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': 'false', disabled: /^0 /.test(c.text), dataset: { key: c.key },
    onClick: (e) => {
      const b = e.currentTarget;
      if (active.has(c.key)) active.delete(c.key);
      else active.add(c.key);
      b.setAttribute('aria-pressed', String(active.has(c.key)));
      build();
    },
  }, c.text));
  const only = h('input', { type: 'checkbox', onChange: () => { onlyDiff = only.checked; build(); } });
  build();
  const total = result.summary?.rows ?? rows.length;
  const reveal = (index) => {
    const r = rows[index];
    if (!r) return;
    if (!matches(r)) {
      active.clear();
      for (const b of chips) b.setAttribute('aria-pressed', 'false');
      onlyDiff = only.checked = false;
      build();
    }
    let tr = document.getElementById(`al-row-${index}`);
    while (!tr && shown < items.length) {
      step();
      tr = document.getElementById(`al-row-${index}`);
    }
    if (!tr) {
      const fold = [...body.querySelectorAll('.fold button')].find((b) => Number(b.dataset.from) <= index && index <= Number(b.dataset.to));
      fold?.click();
      tr = document.getElementById(`al-row-${index}`);
    }
    if (!tr) return;
    tr.scrollIntoView({ block: 'center' });
    tr.classList.add('flash');
    setTimeout(() => tr.classList.remove('flash'), 1600);
  };
  return {
    reveal,
    node: h('section', { class: 'block alignment-block' },
      h('div', { class: 'chips' }, h('span', { class: 'chips-lead' }, `${plural(total, 'aligned row')}:`), chips, h('label', { class: 'check' }, only, 'Only differences')),
      h('div', { class: 'table-wrap align-wrap' }, h('table', { class: 'alignment' },
        h('thead', null, h('tr', null, h('th', { class: 'num' }, '#'), h('th', null, 'A'), h('th', null, h('span', { class: 'sr-only' }, 'Status')), h('th', null, 'B'))), body)),
      more,
      alignmentFooters(result).map((t) => h('p', { class: 'muted' }, t))),
  };
}

// ---------------------------------------------------------------------------
// Recipes and research files

const recipeKey = 'agentshark.workbench.recipes.v1';
function recipes() {
  try {
    const v = JSON.parse(localStorage.getItem(recipeKey) || '[]');
    return Array.isArray(v) ? v.slice(0, 30) : [];
  } catch {
    return [];
  }
}
function refreshRecipes() {
  $('recipes').replaceChildren(h('option', { value: '' }, 'Load a Saved Recipe'), ...recipes().map((r, i) => h('option', { value: String(i) }, r.name)));
}
function recipe() {
  if (operation === 'replayReport') throw new Error('A replay report is its file; keep the file instead of a recipe.');
  return { schemaVersion: 'agentshark.recipe.v1', name: `${toolName(operation)} · ${new Date().toLocaleDateString()}`, operation, input: getInput() };
}

// Recipe fields that a control on the form shows. Loading a recipe sets the control, so a later change to it counts.
const CONTROLS = {
  limit: 'diff-limit', children: 'diff-children', atEventId: 'boundary', idleMinutes: 'idle-minutes', scope: 'loc-scope', groupBy: 'group-by', table: 'export-table',
  format: 'export-format', title: 'investigation-title', question: 'investigation-question', maxGapEvents: 'max-gap', includeUnreviewed: 'unreviewed',
};

/** Sets the controls a recipe's fields belong to and returns the fields no control shows. */
function restoreControls(fields) {
  const rest = { ...fields };
  for (const [key, id] of Object.entries(CONTROLS)) {
    const control = $(id), value = rest[key];
    if (!control || !(key in rest)) continue;
    if (control.type === 'checkbox') {
      if (typeof value !== 'boolean') continue;
      control.checked = value;
    } else if (control.tagName === 'SELECT') {
      if (![...control.options].some((o) => o.value === String(value))) continue;
      control.value = String(value);
    } else {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      control.value = String(value);
    }
    delete rest[key];
  }
  // Dataset Builder derives `sessionIds` from the pickers, as every tool does `sessions`.
  delete rest.sessionIds;
  // A field the form already sends with the same value needs no override.
  let form = {};
  try {
    form = formInput();
  } catch {
    // An incomplete form (no run B yet) keeps every remaining field.
  }
  for (const key of Object.keys(rest)) if (JSON.stringify(rest[key]) === JSON.stringify(form[key])) delete rest[key];
  return rest;
}

/** A recipe's runs set the pickers and its fields the controls; only the rest goes to Advanced JSON (I4). */
async function loadRecipe(r) {
  if (r?.schemaVersion !== 'agentshark.recipe.v1' || !TOOLS[r.operation] || r.operation === 'replayReport' || !r.input || typeof r.input !== 'object' || Array.isArray(r.input)) throw new Error('Unsupported recipe.');
  choose(r.operation);
  const { session, right, sessions, advanced } = recipePickers(r.input);
  if (session) pick('session', session);
  if (right && TWO_RUNS.has(r.operation)) pick('right', right);
  if (sessions.length > 1 && $('scope-mode')) {
    recipeSessions = sessions;
    $('scope-mode').add(h('option', { value: 'recipe-sessions' }, `Sessions from the recipe (${formatInt(sessions.length)})`));
    $('scope-mode').value = 'recipe-sessions';
  }
  const rest = restoreControls(advanced);
  $('advanced').value = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
  status('Recipe loaded. Review the request and run the analysis.');
  // Name runs the lists do not hold.
  await resolve([session, right]);
  for (const [id, value] of [['session', session], ['right', right]]) {
    const option = value && [...$(id).options].find((o) => o.value === value);
    if (option && known.has(value)) option.textContent = sessionOption({ id: value, ...known.get(value) });
  }
}

/** A replay report's records without replayed stdout heads and with long texts cut, so large reports fit one request. */
async function replayRecords(file) {
  if (!file) return null;
  if (file.size > 64000000) throw new Error('Choose a report smaller than 64 MB.');
  const records = (await file.text()).split('\n').filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`Line ${i + 1} of the report is not JSON.`);
    }
  });
  if (records[0]?.type !== 'plan') throw new Error('The first line must be the plan record that agentshark replay --json writes.');
  const cut = (v) => (typeof v === 'string' ? v.slice(0, 400) : v);
  return records.map((r) => (r.type === 'plan' ? { ...r, calls: (r.calls || []).map((c) => ({ n: c.n, event: c.event })) }
    : r.type !== 'call' ? r : {
      ...r, summary: cut(r.summary), reason: cut(r.reason), diff: r.diff && { line: r.diff.line, recorded: cut(r.diff.recorded), replayed: cut(r.diff.replayed) },
      replayed: r.replayed && { ok: r.replayed.ok, exitCode: r.replayed.exitCode, durMs: r.replayed.durMs, timedOut: r.replayed.timedOut, stderrHead: cut(r.replayed.stderrHead || '') },
    }));
}

async function fileJson(input) {
  const file = input.files?.[0];
  if (!file) return undefined;
  if (file.size > 1000000) throw new Error('Choose a JSON file smaller than 1 MB.');
  return JSON.parse(await file.text());
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      status(e.message, true);
    }
  };
}

// ---------------------------------------------------------------------------
// Wiring

for (const b of navButtons()) b.addEventListener('click', () => choose(b.dataset.operation));
$('analyses').addEventListener('keydown', (e) => {
  const buttons = navButtons();
  const at = buttons.indexOf(document.activeElement);
  if (at < 0) return;
  const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: buttons.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  buttons[Math.max(0, Math.min(buttons.length - 1, to))].focus();
});
$('analysis-form').onsubmit = run;
$('refresh').onclick = loadSessions;
$('find').addEventListener('input', debounce(loadSessions, 250));
$('save-recipe').onclick = guard(() => {
  const list = recipes();
  list.unshift(recipe());
  localStorage.setItem(recipeKey, JSON.stringify(list.slice(0, 30)));
  refreshRecipes();
  status('Recipe saved in this browser.');
});
$('recipes').onchange = guard(async () => {
  if ($('recipes').value !== '') await loadRecipe(recipes()[Number($('recipes').value)]);
});
$('export-recipe').onclick = guard(() => download('agentshark-recipe.json', JSON.stringify(recipe(), null, 2)));
$('import-recipe').onchange = guard(async () => loadRecipe(await fileJson($('import-recipe'))));
const researchStatus = () => {
  $('research-status').textContent = `${manifest ? `Manifest: ${manifest.title || manifest.id || 'loaded'}` : 'No manifest'} · ${count(annotations.length, ['human label', 'human labels'])}`;
};
$('manifest').onchange = guard(async () => {
  const v = await fileJson($('manifest'));
  if (v?.schemaVersion !== 'agentshark.manifest.v1' || !Array.isArray(v.runs)) throw new Error('Expected agentshark.manifest.v1 with runs.');
  manifest = v;
  researchStatus();
});
$('annotations').onchange = guard(async () => {
  const v = await fileJson($('annotations'));
  if (!Array.isArray(v)) throw new Error('Annotations must be an array.');
  annotations = v;
  researchStatus();
});
$('add-label').onclick = guard(() => {
  const subjectId = $('label-subject').value.trim(), text = $('label-text').value.trim(), author = $('label-author').value.trim(), rubricVersion = $('label-rubric').value.trim();
  if (!subjectId || !text || !author || !rubricVersion) throw new Error('Complete subject, label, reviewer and rubric.');
  annotations.push({
    schemaVersion: 'agentshark.annotation.v1', id: crypto.randomUUID(), subjectId, label: text, author, rubricVersion, createdAt: new Date().toISOString(),
    reviewed: $('label-reviewed').checked, evidenceEventIds: $('label-evidence').value.split(',').map((s) => s.trim()).filter(Boolean),
  });
  researchStatus();
  status('Label added in memory. Download Labels to keep it.');
});
$('download-labels').onclick = () => download('agentshark-annotations.json', JSON.stringify(annotations, null, 2));
// The page opens on Critical Path (§6.3); a tool named in the address opens instead.
choose(TOOLS[location.hash.slice(1)] ? location.hash.slice(1) : 'perf', { replace: true });
// Back and forward move between tools as their links do.
window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1);
  if (TOOLS[next] && next !== operation) choose(next);
});
refreshRecipes();
loadSessions();
