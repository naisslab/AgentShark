import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { replay } from '../../src/cli/replay.ts';
import { openIndex } from '../../src/index/db.ts';
import { DockerExecutor, type ExecOptions } from '../../src/replay/executor.ts';
import { type ResumeState } from '../../src/replay/run.ts';

test('a stopped replay resumes from its original default index after AGENTSHARK_HOME changes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentshark-resume-index-'));
  const previousHome = process.env.AGENTSHARK_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.AGENTSHARK_HOME;
    else process.env.AGENTSHARK_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.AGENTSHARK_HOME = dir;
  const index = join(dir, 'index.sqlite');
  const session = 'cc:resume-index-test';
  const db = openIndex(index);
  try {
    db.prepare('INSERT INTO sessions (id, agent, native_id, role, cwd) VALUES (?, ?, ?, ?, ?)')
      .run(session, 'claude', 'resume-index-test', 'root', '/work');
    // Two separate batches of skipped calls exercise the CLI's stop/resume path without running commands.
    for (let n = 1; n <= 2; n++) {
      for (const [i, kind] of ['tool.call', 'tool.result'].entries()) {
        const result = db.prepare(`INSERT INTO events
          (id, session_id, src_id, ts, ts_src, seq, kind, proto, actor, summary, tool_name)
          VALUES (?, ?, 'synthetic', ?, 'recorded', ?, ?, 'tool', 'assistant', 'search', 'Glob')`)
          .run(`${kind}-${n}`, session, n * 1e6 + i * 5e5, n * 2 + i, kind);
        db.prepare('INSERT INTO event_payload (rid, attrs) VALUES (?, ?)').run(result.lastInsertRowid,
          JSON.stringify({ tool: { name: 'Glob', call_id: `call-${n}` }, llm: { message_id: `message-${n}` } }));
      }
    }
  } finally {
    db.close();
  }

  // Keep the real CLI, planner and resume-state serialization; replace only the Docker boundary.
  let state: string | null = null;
  const executor = {
    name: 'agentshark-replay-test', stateDir: '/tmp/.agentshark-replay',
    async exec(argv: string[], options: ExecOptions = {}) {
      if (options.stdin !== undefined) state = String(options.stdin);
      if (argv[0] === 'rm') state = null;
      return { stdout: Buffer.from('bash\ntimeout\n'), stderr: Buffer.alloc(0), dropped: 0, exitCode: 0, timedOut: false, durMs: 0 };
    },
    async copyIn() {},
    async close() {},
  } as unknown as DockerExecutor;
  t.mock.method(DockerExecutor, 'create', async () => executor);
  t.mock.method(DockerExecutor, 'attach', async () => executor);
  t.mock.method(DockerExecutor, 'inspect', async () => ({ kind: 'container' as const, image: 'test', network: 'none' }));
  t.mock.method(DockerExecutor, 'readState', async () => state);
  const closed = t.mock.method(executor, 'close');
  t.mock.method(process.stdout, 'write', () => true);
  t.mock.method(console, 'error', () => {});

  assert.equal(await replay({ positionals: [session], values: { workspace: dir, speed: 'max', break: ['2'], json: true } }), 0);
  assert.notEqual(state, null);
  const saved = JSON.parse(state!) as ResumeState;
  assert.equal(saved.next, 2);
  assert.equal(closed.mock.callCount(), 0, 'a stopped replay keeps its container');

  process.env.AGENTSHARK_HOME = join(dir, 'another-home');
  const output = join(dir, 'resumed.jsonl');
  assert.equal(await replay({ positionals: [], values: { resume: executor.name, speed: 'max', json: true, output } }), 0);
  const records = readFileSync(output, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(saved.index, resolve(index));
  assert.equal(saved.capture, null);
  assert.equal(records[0].from, 2);
  assert.deepEqual(records.filter((r) => r.type === 'call').map((r) => r.n), [2]);
  assert.equal(records.at(-1).stoppedBefore, null);
  assert.equal(closed.mock.callCount(), 1, 'the resumed replay finishes and removes its container');
});
