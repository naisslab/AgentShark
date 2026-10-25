-- AgentShark index schema (SPEC §5, §12.3). Bump SCHEMA_VERSION in src/index/db.ts when this changes.

-- Keys: schema_version (db.ts), link_pending (indexer), capture_* (capture reader), and for the analysis pass
-- (src/index/derive.ts, SPEC §12.3.1):
--   analysis_version  integer ANALYSIS_VERSION of the build that wrote the derived tables. Absent, or another value:
--                     every tree is re-derived on the next writable open or index run, without re-parsing sources.
--   sig_version       'sigv2' (SIG_VERSION). Another value re-derives failures.sig_id and signatures too.
--   analysis_pending  JSON array of session ids whose derivation waited more than 3 s in a live run; the next run
--                     derives them first. Absent or '[]' when nothing waits.
--   analysis_ms       duration of the last analysis pass, ms.
--   alarm_thresholds  JSON Partial<AlarmThresholds> (types.ts) over ALARM_THRESHOLDS; absent = the defaults. Written
--                     only by setAlarmThresholds (derive.ts, P1), which also deletes analysis_version, so the next run
--                     re-derives every tree with the new values.
--   last_change_at    µs of the last committed change: an index run that changed sessions, or an analysis pass that
--                     wrote rows. MCP index_age_s and RunReport.indexAgeS are measured from it.
-- Read-only opens never write these; a mismatch is reported as the gap 'analysis-outdated'.
-- Files beside the index (never inside it): `<index>.lock` (the writer's pid, SPEC §5.1) and `<index>.watch.<pid>`
-- (JSON {intervalMs, since}: written by a server while its watch loop runs, removed at close; a file whose pid is
-- gone is stale). MCP `indexer` reads both.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per source file ever indexed. exists_now = 0 marks files that disappeared from disk.
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  agent        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  path         TEXT NOT NULL UNIQUE,
  size         INTEGER,
  mtime_ms     REAL,
  ino          INTEGER,
  parsed_bytes INTEGER,
  lines        INTEGER NOT NULL DEFAULT 0,
  malformed    INTEGER NOT NULL DEFAULT 0,
  unknown      INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  inherited    INTEGER NOT NULL DEFAULT 0,
  dialect      TEXT,
  sha256       TEXT,
  indexed_at   INTEGER,
  parse_ms     REAL,
  status       TEXT NOT NULL DEFAULT 'ok',   -- ok | error | deleted | stale (queued by a full re-index)
  error        TEXT,
  exists_now   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  agent           TEXT NOT NULL,
  native_id       TEXT NOT NULL,
  role            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'ok',
  parent_id       TEXT,
  parent_span_id  TEXT,
  root_id         TEXT,
  title           TEXT,
  cwd             TEXT,
  project         TEXT,
  git_branch      TEXT,
  git_commit      TEXT,
  git_repo        TEXT,
  models          TEXT,            -- JSON array
  version         TEXT,
  originator      TEXT,
  entrypoint      TEXT,
  created_ts      INTEGER,
  start_ts        INTEGER,
  end_ts          INTEGER,
  n_events        INTEGER NOT NULL DEFAULT 0,
  n_llm           INTEGER NOT NULL DEFAULT 0,
  n_tools         INTEGER NOT NULL DEFAULT 0,
  n_turns         INTEGER NOT NULL DEFAULT 0,
  n_errors        INTEGER NOT NULL DEFAULT 0,
  n_children      INTEGER NOT NULL DEFAULT 0,
  tok_in          INTEGER,
  tok_uncached    INTEGER,
  tok_cache_read  INTEGER,
  tok_cache_write INTEGER,
  tok_out         INTEGER,
  tok_reasoning   INTEGER,
  cost_usd        REAL,
  meta            TEXT,            -- JSON from the defining transcript
  meta_enriched   TEXT,            -- JSON merged from enrich rows by the linker
  src_id          TEXT,            -- source that last defined the session (NULL for registry-only)
  sources         TEXT,            -- JSON array of the source ids that hold its events (linker)
  measures        TEXT             -- JSON logging-health counters of its own events and spans (linker, SPEC §8)
);
CREATE INDEX IF NOT EXISTS ses_parent ON sessions(parent_id);
CREATE INDEX IF NOT EXISTS ses_root   ON sessions(root_id);
CREATE INDEX IF NOT EXISTS ses_start  ON sessions(start_ts);

-- Events hold the columns that views, filters, statistics and lookups read (about 400 bytes a row); the JSON
-- payload (attrs and native, about 2 KB a row) lives in event_payload under the same rid.
CREATE TABLE IF NOT EXISTS events (
  rid        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  src_id     TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  ts_src     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  proto      TEXT NOT NULL,
  actor      TEXT NOT NULL,
  summary    TEXT NOT NULL,
  span_id    TEXT,
  turn_id    TEXT,
  tool_name  TEXT,
  tool_kind  TEXT,                 -- attrs.tool.kind
  exit_code  INTEGER,              -- attrs.tool.exit_code
  model      TEXT,
  dur        INTEGER,
  tok_in     INTEGER,
  tok_out    INTEGER,
  cost_usd   REAL,                 -- attrs.cost.usd
  cost_cum   INTEGER,              -- 1 when cost_usd is a running total (attrs.cost.cumulative)
  flag_bits  INTEGER NOT NULL DEFAULT 0,
  src_line   INTEGER,
  src_off    INTEGER,
  src_len    INTEGER,
  src_block  INTEGER
);
CREATE TABLE IF NOT EXISTS event_payload (
  rid    INTEGER PRIMARY KEY,      -- events.rid
  attrs  TEXT,                     -- JSON (Attrs)
  native TEXT                      -- JSON (compact native record)
);
CREATE INDEX IF NOT EXISTS ev_session_seq ON events(session_id, seq);
-- ev_ts covers every column that time-ordered views read and that the common filters test (kind, flags, tokens,
-- duration, tool, exit code, model, and the agent through the session id prefix), so those views scan the index in display
-- order instead of the table. ev_kind covers the kind statistics.
CREATE INDEX IF NOT EXISTS ev_ts          ON events(ts, session_id, seq, flag_bits, kind, tok_in, tok_out, dur, tool_name, tool_kind, exit_code, model);
CREATE INDEX IF NOT EXISTS ev_kind        ON events(kind, proto, flag_bits, src_block, src_len);
CREATE INDEX IF NOT EXISTS ev_tool        ON events(tool_name) WHERE tool_name IS NOT NULL;
-- Models of a session in order of first use (linker).
CREATE INDEX IF NOT EXISTS ev_model       ON events(session_id, model, seq, flag_bits) WHERE model IS NOT NULL;
CREATE INDEX IF NOT EXISTS ev_span        ON events(span_id);
CREATE INDEX IF NOT EXISTS ev_turn        ON events(turn_id);
CREATE INDEX IF NOT EXISTS ev_src         ON events(src_id);

-- Full-text index over summary, text, tool input summary and tool output. rowid = events.rid.
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(body, content='', contentless_delete=1, tokenize='unicode61');

CREATE TABLE IF NOT EXISTS spans (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  src_id       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  name         TEXT,
  parent_id    TEXT,
  start_ts     INTEGER,
  end_ts       INTEGER,
  dur          INTEGER,
  dur_src      TEXT,
  status       TEXT,
  link_session TEXT,
  first_event  TEXT,
  last_event   TEXT,
  depth        INTEGER NOT NULL DEFAULT 0,
  inherited    INTEGER NOT NULL DEFAULT 0,   -- 1: the span opens on an inherited event (copied context)
  attrs        TEXT
);
CREATE INDEX IF NOT EXISTS sp_session ON spans(session_id, kind, start_ts);
CREATE INDEX IF NOT EXISTS sp_parent  ON spans(parent_id);
CREATE INDEX IF NOT EXISTS sp_link    ON spans(link_session) WHERE link_session IS NOT NULL;
CREATE INDEX IF NOT EXISTS sp_src     ON spans(src_id);
CREATE INDEX IF NOT EXISTS sp_start   ON spans(start_ts);
CREATE INDEX IF NOT EXISTS sp_status  ON spans(status, kind);
-- llm spans by the event that closes them: a view's statistics find the model responses its events close (queries.ts).
CREATE INDEX IF NOT EXISTS sp_llm_last ON spans(last_event) WHERE kind = 'llm';

CREATE TABLE IF NOT EXISTS expert (
  id         INTEGER PRIMARY KEY,
  src_id     TEXT,
  session_id TEXT,
  event_id   TEXT,
  span_id    TEXT,
  severity   TEXT NOT NULL,
  grp        TEXT NOT NULL,
  message    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ex_session ON expert(session_id);
CREATE INDEX IF NOT EXISTS ex_src     ON expert(src_id);

-- Session metadata contributed by other sources (desktop registry, Codex state DB).
CREATE TABLE IF NOT EXISTS enrich (
  src_id     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  fields     TEXT,
  meta       TEXT,
  PRIMARY KEY (src_id, session_id)
);
CREATE INDEX IF NOT EXISTS en_session ON enrich(session_id);

-- Capture mode only: exact source lines, so raw lookups work without the original files.
CREATE TABLE IF NOT EXISTS raw_store (
  src_id TEXT NOT NULL,
  line   INTEGER NOT NULL,
  text   TEXT NOT NULL,
  PRIMARY KEY (src_id, line)
) WITHOUT ROWID;

-- Capture mode only: content-addressed side files.
CREATE TABLE IF NOT EXISTS blobs (
  sha256      TEXT PRIMARY KEY,
  size        INTEGER,
  media_type  TEXT,
  encoding    TEXT,
  origin_path TEXT,
  role        TEXT,
  data        BLOB
);

-- ===========================================================================
-- Derived tables (schema 4, SPEC §12.3). Written only by the analysis pass (src/index/derive.ts, linker pass 6): for
-- each root tree holding a changed session, one savepoint deletes the tree's rows (session_id IN the tree's sessions,
-- alarms included) and inserts them again; then `signatures` is re-aggregated. Row shapes: the *Row types in
-- src/model/types.ts (camelCase of these columns). *_src columns hold a provenance (Prov). Booleans are 0/1.
-- NULL means "not logged"; derived code never writes 0 for a missing value. Every table but `signatures` carries
-- session_id. Event references are events.rid: index-internal join keys that a re-parse renumbers, so no id column
-- embeds a rid; ids embed event ids (SPEC §3.1), span ids and step numbers. Clock-dependent values (alarm state,
-- signature status, `stall`) have no column; queries compute them on read.

-- One model response with its calls and results (SPEC §12.3.2). id = '<sid>#step:<n>'.
CREATE TABLE IF NOT EXISTS steps (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  turn_id           TEXT,
  n                 INTEGER NOT NULL,            -- 1-based in seq order within the session
  llm_span_id       TEXT,                        -- NULL: Codex trailing step
  start_ts          INTEGER NOT NULL,
  end_ts            INTEGER,
  ctx_tokens        INTEGER,
  ctx_window        INTEGER,
  ctx_window_src    TEXT,
  tok_out           INTEGER,
  tok_uncached      INTEGER,
  n_calls           INTEGER NOT NULL DEFAULT 0,
  n_fail            INTEGER NOT NULL DEFAULT 0,
  model_us          INTEGER,
  model_src         TEXT,
  tool_us           INTEGER,
  intent            TEXT,                        -- trace text, <= 200 chars
  intent_src        TEXT,
  compaction_before INTEGER NOT NULL DEFAULT 0,
  attachments       TEXT,                        -- JSON {context type: n}; NULL until P1 fills it
  seg_src           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS st_session_n ON steps(session_id, n);
CREATE INDEX IF NOT EXISTS st_turn      ON steps(turn_id, n);
CREATE INDEX IF NOT EXISTS st_llm       ON steps(llm_span_id) WHERE llm_span_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS step_events (
  rid        INTEGER PRIMARY KEY,
  step_id    TEXT NOT NULL,
  session_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS se_step    ON step_events(step_id);
CREATE INDEX IF NOT EXISTS se_session ON step_events(session_id);

-- Every event with a failure signal, any tier (SPEC §12.3.3). tier: failure | suspect | benign | deferred.
CREATE TABLE IF NOT EXISTS failures (
  rid        INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id    TEXT,
  step_id    TEXT,
  call_rid   INTEGER,
  ts         INTEGER NOT NULL,
  tier       TEXT NOT NULL,
  source     TEXT NOT NULL,                      -- flag | inner | api | policy | hook | process | text
  rule       TEXT NOT NULL,                      -- '<rule>@<version>'
  family     TEXT NOT NULL,
  class      TEXT NOT NULL,
  sig_id     TEXT NOT NULL,
  target_key TEXT NOT NULL,                      -- trace text; apply_patch: the file the error names, else the first
  exit_code  INTEGER,
  exit_src   TEXT,
  error_line TEXT,                               -- trace text, <= 300 chars
  episode_id TEXT,                               -- NULL for benign and deferred
  attempt    INTEGER
);
CREATE INDEX IF NOT EXISTS fa_session ON failures(session_id, ts);
CREATE INDEX IF NOT EXISTS fa_turn    ON failures(turn_id);
CREATE INDEX IF NOT EXISTS fa_episode ON failures(episode_id, attempt) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fa_sig     ON failures(sig_id, ts);
CREATE INDEX IF NOT EXISTS fa_tier    ON failures(tier, family, ts);
CREATE INDEX IF NOT EXISTS fa_ts      ON failures(ts);
CREATE INDEX IF NOT EXISTS fa_call    ON failures(call_rid) WHERE call_rid IS NOT NULL;

-- Failure episodes (SPEC §12.3.5). id = '<sid>#ep:<event id of the opening failure row>'.
CREATE TABLE IF NOT EXISTS episodes (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  root_id     TEXT NOT NULL,
  turn_id     TEXT,
  target_key  TEXT NOT NULL,
  sig_id      TEXT NOT NULL,
  family      TEXT NOT NULL,
  class       TEXT NOT NULL,
  tier        TEXT NOT NULL,                     -- failure when any attempt is a failure row, else suspect
  opener_rid  INTEGER NOT NULL,
  last_rid    INTEGER NOT NULL,
  closer_rid  INTEGER,
  n_attempts  INTEGER NOT NULL,                  -- attempts of both tiers
  first_step  TEXT,
  last_step   TEXT,
  n_steps     INTEGER NOT NULL DEFAULT 0,
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,                  -- newest evidence: the closing call's result, else the last attempt
  wall_us     INTEGER,
  wall_src    TEXT,
  tok_out     INTEGER,
  tok_in_ub   INTEGER,                           -- upper bound
  outcome     TEXT NOT NULL,
  outcome_src TEXT NOT NULL,
  actor       TEXT,
  loop        INTEGER NOT NULL DEFAULT 0,
  blind       INTEGER NOT NULL DEFAULT 0,
  corrected   INTEGER NOT NULL DEFAULT 0,
  unattended  INTEGER NOT NULL DEFAULT 0,
  section     TEXT NOT NULL                      -- blocked | unrecovered | other | recovered (EPISODE_SECTIONS)
);
CREATE INDEX IF NOT EXISTS ep_session ON episodes(session_id, start_ts);
CREATE INDEX IF NOT EXISTS ep_section ON episodes(section, end_ts);
CREATE INDEX IF NOT EXISTS ep_root    ON episodes(root_id, start_ts);
CREATE INDEX IF NOT EXISTS ep_turn    ON episodes(turn_id);
CREATE INDEX IF NOT EXISTS ep_sig     ON episodes(sig_id, start_ts);
CREATE INDEX IF NOT EXISTS ep_outcome ON episodes(outcome, family, start_ts);
CREATE INDEX IF NOT EXISTS ep_start   ON episodes(start_ts);
CREATE INDEX IF NOT EXISTS ep_closer  ON episodes(closer_rid) WHERE closer_rid IS NOT NULL;

CREATE TABLE IF NOT EXISTS episode_attempts (
  episode_id   TEXT NOT NULL,
  n            INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  rid          INTEGER NOT NULL,
  step_id      TEXT,
  gap_us       INTEGER,
  gap_steps    INTEGER,
  change_class TEXT,                             -- identical | flags-only | small | moderate | rewrite
  similarity   REAL,
  edits        INTEGER NOT NULL DEFAULT 0,
  reread       INTEGER NOT NULL DEFAULT 0,
  parallel     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (episode_id, n)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ea_rid     ON episode_attempts(rid);
CREATE INDEX IF NOT EXISTS ea_session ON episode_attempts(session_id);

-- Error signatures over all failure rows (SPEC §12.4). Re-aggregated after each analysis pass; no session_id.
-- Status is computed on read from first_ts, last_ts, regressed_ts and turns_since_last (SIGNATURE_STATUSES).
CREATE TABLE IF NOT EXISTS signatures (
  id               TEXT PRIMARY KEY,             -- 'sig_' + sha1(family || '\n' || text)[0:12]
  text             TEXT NOT NULL,                -- trace text with placeholders
  family           TEXT NOT NULL,
  class            TEXT NOT NULL,
  sigv             TEXT NOT NULL,
  n                INTEGER NOT NULL,
  n_sessions       INTEGER NOT NULL,
  n_episodes       INTEGER NOT NULL DEFAULT 0,
  n_recovered      INTEGER NOT NULL DEFAULT 0,
  n_unrecovered    INTEGER NOT NULL DEFAULT 0,
  wall_lost_us     INTEGER NOT NULL DEFAULT 0,
  first_ts         INTEGER NOT NULL,
  last_ts          INTEGER NOT NULL,
  turns_since_last INTEGER NOT NULL DEFAULT 0,   -- recounted for every signature in each pass
  regressed_ts     INTEGER,                      -- first occurrence after the newest dormant gap
  agents           TEXT NOT NULL,                -- JSON array of AgentKind
  rank             REAL NOT NULL DEFAULT 0,      -- n_sessions x unrecovered rate
  tier_counts      TEXT NOT NULL                 -- JSON {tier: n}
);
CREATE INDEX IF NOT EXISTS sg_rank      ON signatures(rank DESC);
CREATE INDEX IF NOT EXISTS sg_family    ON signatures(family, rank DESC);
CREATE INDEX IF NOT EXISTS sg_first     ON signatures(first_ts);
CREATE INDEX IF NOT EXISTS sg_last      ON signatures(last_ts);
CREATE INDEX IF NOT EXISTS sg_regressed ON signatures(regressed_ts) WHERE regressed_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS sg_n         ON signatures(n DESC);

-- One row per turn span (SPEC §12.3.6).
CREATE TABLE IF NOT EXISTS turn_rollup (
  turn_id        TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  root_id        TEXT NOT NULL,
  n              INTEGER,                        -- 1-based in seq order within the session: "turn 6", the Steps T6 row
  origin         TEXT,
  start_ts       INTEGER NOT NULL,
  end_ts         INTEGER,
  last_ts        INTEGER NOT NULL,               -- newest own event: stall and alarm expiry are measured from it
  open           INTEGER NOT NULL DEFAULT 0,
  waiting        TEXT,                           -- open turns: process | question | tool (TurnWaiting)
  impact         TEXT NOT NULL,                  -- failed | blocked | interrupted | masked | degraded | slow | recovered | clean
  impact_basis   TEXT,
  n_steps        INTEGER NOT NULL DEFAULT 0,
  n_episodes     INTEGER NOT NULL DEFAULT 0,
  n_unrecovered  INTEGER NOT NULL DEFAULT 0,
  claim_evidence TEXT,
  unattended     INTEGER NOT NULL DEFAULT 0,
  wall_us        INTEGER,
  wall_src       TEXT,
  call_kinds     TEXT                            -- tool kinds of the turn's own tool calls, space-separated, sorted; NULL: none
);
CREATE INDEX IF NOT EXISTS tr_session ON turn_rollup(session_id, start_ts);
CREATE INDEX IF NOT EXISTS tr_root    ON turn_rollup(root_id, start_ts);
CREATE INDEX IF NOT EXISTS tr_impact  ON turn_rollup(impact, start_ts);
CREATE INDEX IF NOT EXISTS tr_open    ON turn_rollup(last_ts) WHERE open = 1;
CREATE INDEX IF NOT EXISTS tr_unattended ON turn_rollup(start_ts) WHERE unattended = 1;

-- One row per derived session (sidebar marks, find_runs). worst_rank = index of worst_impact in TURN_IMPACTS.
CREATE TABLE IF NOT EXISTS session_rollup (
  session_id        TEXT PRIMARY KEY,
  root_id           TEXT NOT NULL,
  worst_impact      TEXT NOT NULL,
  worst_rank        INTEGER NOT NULL,
  worst_turn        TEXT,
  n_turns           INTEGER NOT NULL DEFAULT 0,
  n_steps           INTEGER NOT NULL DEFAULT 0,
  n_episodes        INTEGER NOT NULL DEFAULT 0,
  n_attention       INTEGER NOT NULL DEFAULT 0,  -- episodes in the blocked and unrecovered sections
  silent_children   INTEGER NOT NULL DEFAULT 0,
  unverified_claims INTEGER NOT NULL DEFAULT 0,
  unattended        INTEGER NOT NULL DEFAULT 0,
  last_ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sr_root  ON session_rollup(root_id, worst_rank);
CREATE INDEX IF NOT EXISTS sr_marks ON session_rollup(worst_rank) WHERE worst_impact <> 'clean' OR silent_children > 0 OR n_attention > 0 OR unverified_claims > 0;

-- Spawns (SPEC §12.3.7). id = the spawn span id; session_id = the parent session.
CREATE TABLE IF NOT EXISTS delegations (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  parent_turn    TEXT,
  parent_step    TEXT,
  child_session  TEXT,
  kind           TEXT NOT NULL,                  -- agent | task | spawn-agent | workflow-agent
  task_excerpt   TEXT,                           -- trace text, <= 300 code points; a cut ends in …
  outcome        TEXT NOT NULL,
  outcome_src    TEXT,
  child_impact   TEXT,
  parent_told    INTEGER,                        -- NULL: the parent saw no result
  silent         INTEGER NOT NULL DEFAULT 0,
  result_rid     INTEGER,
  tok_in_tree    INTEGER,
  tok_out_tree   INTEGER,
  parent_wait_us INTEGER,
  start_ts       INTEGER NOT NULL,
  end_ts         INTEGER,
  task_chars     INTEGER                         -- code points of the whole task (task_excerpt may be cut)
);
CREATE INDEX IF NOT EXISTS dl_session ON delegations(session_id, start_ts);
CREATE INDEX IF NOT EXISTS dl_child   ON delegations(child_session) WHERE child_session IS NOT NULL;
CREATE INDEX IF NOT EXISTS dl_turn    ON delegations(parent_turn);
CREATE INDEX IF NOT EXISTS dl_silent  ON delegations(start_ts) WHERE silent = 1;

-- Background processes (SPEC §12.3.8). id = '<sid>#proc:<N>:<seq of the opening event>'.
CREATE TABLE IF NOT EXISTS processes (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  proc_key   TEXT NOT NULL,                      -- N
  open_rid   INTEGER NOT NULL,
  close_rid  INTEGER,
  program    TEXT,
  n_polls    INTEGER NOT NULL DEFAULT 0,
  n_inputs   INTEGER NOT NULL DEFAULT 0,
  exit_code  INTEGER,
  exit_src   TEXT,
  status     TEXT NOT NULL,                      -- running | exited | closed | killed | unknown
  start_ts   INTEGER NOT NULL,
  end_ts     INTEGER
);
CREATE INDEX IF NOT EXISTS pr_session ON processes(session_id, proc_key, start_ts);
CREATE INDEX IF NOT EXISTS pr_open    ON processes(open_rid);

CREATE TABLE IF NOT EXISTS process_events (
  rid        INTEGER PRIMARY KEY,
  process_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL                       -- open | poll | input | output | close | error | kill
);
CREATE INDEX IF NOT EXISTS pe_process ON process_events(process_id, rid);
CREATE INDEX IF NOT EXISTS pe_session ON process_events(session_id);

-- File reads, edits, external edits, backups and shell mentions (SPEC §12.3.8). Diffs load lazily from raw.
CREATE TABLE IF NOT EXISTS changes (
  rid         INTEGER NOT NULL,
  path        TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  turn_id     TEXT,
  step_id     TEXT,
  ts          INTEGER NOT NULL,
  op          TEXT NOT NULL,                     -- read | add | update | delete | move | write | external | backup | shell-mention
  src         TEXT NOT NULL,
  added       INTEGER,
  removed     INTEGER,
  outside_cwd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rid, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ch_session_path ON changes(session_id, path, ts);
CREATE INDEX IF NOT EXISTS ch_session_ts   ON changes(session_id, ts);
CREATE INDEX IF NOT EXISTS ch_path         ON changes(path);
CREATE INDEX IF NOT EXISTS ch_step         ON changes(step_id);

-- Human, parent, policy and hook interventions (SPEC §12.3.8). near_episode is association only.
CREATE TABLE IF NOT EXISTS interventions (
  rid          INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL,
  turn_id      TEXT,
  step_id      TEXT,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  actor        TEXT NOT NULL,
  actor_src    TEXT NOT NULL,
  wait_us      INTEGER,
  near_episode TEXT
);
CREATE INDEX IF NOT EXISTS iv_session ON interventions(session_id, ts);
CREATE INDEX IF NOT EXISTS iv_turn    ON interventions(turn_id);
CREATE INDEX IF NOT EXISTS iv_kind    ON interventions(kind, ts);

-- Success claims in a turn's final text and their evidence (SPEC §12.3.8, inferred).
CREATE TABLE IF NOT EXISTS claims (
  turn_id       TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  final_rid     INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  evidence      TEXT NOT NULL,                   -- passed-after-last-edit | edited-after-last-test | last-test-failed | no-test-in-turn | unknown
  rule          TEXT NOT NULL,                   -- 'claim@1'
  test_rid      INTEGER,
  last_edit_rid INTEGER,
  pattern       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cl_session  ON claims(session_id, ts);
CREATE INDEX IF NOT EXISTS cl_evidence ON claims(evidence, ts);

-- Alarms (SPEC §12.3.9): every instance on every turn, a pure function of the events (ALARM_KINDS in types.ts).
-- id = '<turn id>#alarm:<kind>:<event id of the first evidence>'. `stall` rows are never stored, and state is
-- computed on read: cleared when cleared_ts is set, else firing or expired by last_ts and the clock (ALARM_STATES).
CREATE TABLE IF NOT EXISTS alarms (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,                   -- consecutive | blocker | blind-loop | loop | silent-child
  rule          TEXT NOT NULL,                   -- '<kind>@<version>'
  first_ts      INTEGER NOT NULL,
  last_ts       INTEGER NOT NULL,                -- newest own event of the turn while the alarm held
  episode_id    TEXT,
  delegation_id TEXT,
  notify        INTEGER NOT NULL DEFAULT 0,
  cleared_ts    INTEGER                          -- NULL: holds at the turn's newest own event
);
CREATE INDEX IF NOT EXISTS al_session ON alarms(session_id, last_ts);
CREATE INDEX IF NOT EXISTS al_open    ON alarms(last_ts) WHERE cleared_ts IS NULL;
CREATE INDEX IF NOT EXISTS al_turn    ON alarms(turn_id);

-- Statistics ▸ Tools and Endpoints per session (SPEC §12.5): the tool calls and Codex inner items of a session grouped
-- by tool name (`tool`, tool spans only), MCP server (`server`), program (`program`, from the target key; `read` for
-- file reads), host (`host`) and agent type (`agent`), its model responses by model (`model`) and its hook runs by
-- `<event>:<command>` (`hook`), so the whole index reads a few rows per session instead of every span and payload.
-- Added within schema 4: a writable open creates it, the analysis pass fills it, and readers scan spans while a kind
-- has no rows.
CREATE TABLE IF NOT EXISTS call_stats (
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL,                     -- tool | server | program | host | agent | model | hook
  key        TEXT NOT NULL,
  calls      INTEGER NOT NULL,
  durs       TEXT NOT NULL,                     -- JSON array of the known durations (µs), ascending
  dur_src    TEXT NOT NULL,                     -- JSON {dur_src: calls}; calls without a known duration count as 'unknown'
  tiers      TEXT NOT NULL,                     -- JSON {tier: calls whose worst failure row has that tier}
  first_ts   INTEGER,                           -- first and last call start
  last_ts    INTEGER,
  PRIMARY KEY (session_id, kind, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cs_kind ON call_stats(kind);

-- The group key of each keyed call (a call_stats row of kind server, program, host or agent counts it), so a view's
-- statistics read its calls' keys instead of their payloads. Added within schema 4, like call_stats.
CREATE TABLE IF NOT EXISTS call_keys (
  span_id    TEXT PRIMARY KEY,                  -- the call's tool or exec span
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL,                     -- server | program | host | agent
  key        TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ck_session ON call_keys(session_id);

-- Per-session aggregates behind Statistics ▸ Kinds and Models (derive/calls.ts), so the whole index, or a view of
-- whole sessions, sums a few rows per session instead of every event and llm span. Added within schema 4, like
-- call_stats.
CREATE TABLE IF NOT EXISTS session_stats (
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL,                     -- event | model
  key        TEXT NOT NULL,                     -- event: '<kind> <proto>' of its own events; model: the llm spans' model
  n          INTEGER NOT NULL,                  -- events, or llm spans
  bytes      INTEGER,                           -- event: source bytes, counted on the first event of each line
  durs       TEXT,                              -- model: JSON array of the known span durations (µs), ascending
  tokens     TEXT,                              -- model: JSON TokenUsage sums of the spans' tokens
  PRIMARY KEY (session_id, kind, key)
) WITHOUT ROWID;
