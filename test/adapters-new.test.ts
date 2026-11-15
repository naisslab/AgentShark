import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { VerifiedSource } from '../src/raw/evidence.ts';

function encodeVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

function pbVarint(field: number, val: number): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(val)]);
}

function pbBytes(field: number, buf: Buffer): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(buf.length), buf]);
}

function pbStr(field: number, s: string): Buffer {
  return pbBytes(field, Buffer.from(s, 'utf8'));
}

test('Antigravity, Gemini, and DeepSeek Harness end-to-end discovery, indexing, and raw verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentshark-new-adapters-'));
  try {
    // 1. Antigravity: hybrid .db + WAL transcript_full.jsonl AND .pb-only transcript_full.jsonl
    const agRoot = join(root, 'antigravity-root');
    const agHybridId = 'aaaaaaaa-1111-4222-8333-444444444444';
    const agPbOnlyId = 'bbbbbbbb-1111-4222-8333-555555555555';
    mkdirSync(join(agRoot, 'conversations'), { recursive: true });
    mkdirSync(join(agRoot, 'brain', agHybridId, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(join(agRoot, 'brain', agPbOnlyId, '.system_generated', 'logs'), { recursive: true });

    const agDb = new DatabaseSync(join(agRoot, 'conversations', `${agHybridId}.db`));
    agDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, step_payload BLOB, metadata BLOB, error_details BLOB);
    `);
    agDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 0, 1)').run(agHybridId, agHybridId);
    const agWs = Buffer.concat([pbStr(1, 'file:///Users/test/ag-proj'), pbStr(2, 'file:///Users/test/ag-proj'), pbStr(4, 'main')]);
    agDb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', pbBytes(1, agWs));
    const step0Payload = Buffer.concat([pbVarint(1, 14), pbVarint(4, 3), pbBytes(14, pbStr(2, 'Inspect project'))]);
    const step0Meta = pbBytes(1, pbVarint(1, 1763168400));
    agDb.prepare('INSERT INTO steps VALUES (0, 14, 3, 0, ?, ?, NULL)').run(step0Payload, step0Meta);
    agDb.close();

    writeFileSync(
      join(agRoot, 'brain', agHybridId, '.system_generated', 'logs', 'transcript_full.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: '2026-11-15T01:00:00Z', content: 'Inspect project' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: '2026-11-15T01:00:01Z', content: 'Done.', input_tokens: 300, output_tokens: 25 }),
      ].join('\n') + '\n',
    );

    writeFileSync(
      join(agRoot, 'brain', agPbOnlyId, '.system_generated', 'logs', 'transcript_full.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: '2026-11-15T01:10:00Z', content: 'Recover pb-only session' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: '2026-11-15T01:10:01Z', content: 'Recovered!' }),
      ].join('\n') + '\n',
    );

    // 2. DeepSeek Harness: multi-frame .jsonl.zstd + skippable frame + torn 4th frame at EOF
    const dshRoot = join(root, 'dsh-root');
    const dshSess = join(dshRoot, 'sessions', 'ws1', 'dsh-torn-001');
    mkdirSync(dshSess, { recursive: true });

    const f1 = zstdCompressSync(Buffer.from(
      JSON.stringify({ type: 'session', header: { version: 4, id: 'dsh-torn-001', cwd: '/Users/test/dsh-proj', createdAt: 1763168400000 } }) + '\n' +
      JSON.stringify({ type: 'turn/start', time: 1763168401000, data: { turn: 1 } }) + '\n' +
      JSON.stringify({ type: 'user/message', time: 1763168401100, data: { content: 'Explain multi-frame zstd' } }) + '\n',
    ));
    const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x04, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const f2 = zstdCompressSync(Buffer.from(
      JSON.stringify({
        type: 'assistant/message',
        time: 1763168402000,
        data: {
          turn: 1, step: 1,
          message: { id: 'm1', source: { model: 'deepseek-reasoner' }, content: [{ type: 'reasoning', text: 'Frames concatenate.' }, { type: 'text', text: 'Zstd frames concatenate cleanly.' }] },
          usage: { inputTokens: 400, cacheReadTokens: 800, outputTokens: 80, totalTokens: 1280 },
        },
      }) + '\n' +
      JSON.stringify({ type: 'turn/end', time: 1763168403000, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n',
    ));
    const torn = zstdCompressSync(Buffer.from('{"type":"turn/start","partial":true}\n')).subarray(0, 6);
    writeFileSync(join(dshSess, 'session.v4.jsonl.zstd'), Buffer.concat([f1, skip, f2, torn]));

    // 3. Gemini: CLI session, Vega archive, and Code Mode hybrid trajectory (source === 21)
    const gmRoot = join(root, 'gemini-root');
    const cliDir = join(gmRoot, 'tmp', 'hash123', 'chats');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(gmRoot, 'tmp', 'hash123', '.project_root'), '/Users/test/my-gemini-app');
    writeFileSync(join(cliDir, 'session-2026-11-15T01-00-synth.json'), JSON.stringify({
      sessionId: 'synth-cli-001',
      projectHash: 'hash123',
      startTime: '2026-11-15T01:00:00.000Z',
      lastUpdated: '2026-11-15T01:00:05.000Z',
      messages: [
        { id: 'm1', timestamp: '2026-11-15T01:00:00.000Z', type: 'user', content: 'List files' },
        {
          id: 'm2', timestamp: '2026-11-15T01:00:02.000Z', type: 'gemini', model: 'gemini-2.5-pro',
          thoughts: [{ subject: 'Plan', description: 'Run ls' }],
          content: 'Checking directory.',
          tokens: { input: 1000, output: 200, cached: 400 },
          toolCalls: [{ id: 'tc1', name: 'run_shell_command', args: { command: 'ls' }, status: 'success', resultDisplay: 'README.md' }],
        },
      ],
    }));

    const vegaDir = join(gmRoot, 'VegaTrajectoryArchives');
    mkdirSync(vegaDir, { recursive: true });
    writeFileSync(join(vegaDir, 'vega-001.json'), JSON.stringify({
      id: 'vega-001',
      title: 'Vega Test',
      workspacePath: '/Users/test/vega-proj',
      createdAt: '2026-11-15T01:00:00.000Z',
      steps: [
        { role: 'user', content: 'Hello Vega', timestamp: '2026-11-15T01:00:00.000Z' },
        { role: 'model', thinking: 'Greeting user', content: 'Hi from Vega!', model: 'gemini-2.5-flash', timestamp: '2026-11-15T01:00:01.000Z' },
      ],
    }));

    const gmConvId = '11111111-2222-4333-8444-555555555555';
    mkdirSync(join(gmRoot, 'conversations'), { recursive: true });
    mkdirSync(join(gmRoot, 'brain', gmConvId, '.system_generated', 'logs'), { recursive: true });
    const cdb = new DatabaseSync(join(gmRoot, 'conversations', `${gmConvId}.db`));
    cdb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, step_payload BLOB, metadata BLOB, error_details BLOB);
    `);
    cdb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 0, 21)').run(gmConvId, gmConvId);
    const gmWs = Buffer.concat([pbStr(1, 'file:///Users/test/code-mode-proj'), pbStr(2, 'file:///Users/test/code-mode-proj'), pbStr(4, 'feat/gemini')]);
    cdb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', pbBytes(1, gmWs));
    cdb.prepare('INSERT INTO steps VALUES (0, 14, 3, 0, ?, ?, NULL)').run(step0Payload, step0Meta);
    cdb.close();

    writeFileSync(
      join(gmRoot, 'brain', gmConvId, '.system_generated', 'logs', 'transcript_full.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: '2026-11-15T01:00:00Z', content: 'Inspect project' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: '2026-11-15T01:00:01Z', thinking: 'Checking files', content: 'Running ls', input_tokens: 500, output_tokens: 50, tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls -la' } }] }),
        JSON.stringify({ step_index: 2, type: 'RUN_COMMAND', source: 'SYSTEM', status: 'DONE', created_at: '2026-11-15T01:00:02Z', content: 'Created At: 2026-11-15T01:00:01Z\nCompleted At: 2026-11-15T01:00:02Z\nCommand exited with code 0.\n\nCommand output:\nREADME.md' }),
      ].join('\n') + '\n',
    );

    const cliBin = new URL('../bin/agentshark.ts', import.meta.url).pathname;
    for (const args of [
      ['config', '--no-auto-discover'],
      ['config', '--agent', 'antigravity', '--add', agRoot],
      ['config', '--agent', 'gemini', '--add', gmRoot],
      ['config', '--agent', 'deepseek', '--add', dshRoot],
      ['index'],
    ]) {
      const res = spawnSync(process.execPath, [cliBin, ...args], {
        env: { ...process.env, AGENTSHARK_HOME: root },
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, `CLI ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    }

    const db = new DatabaseSync(join(root, 'index.sqlite'), { readOnly: true });
    try {
      const byId = Object.fromEntries((db.prepare('SELECT * FROM sessions').all() as Record<string, any>[]).map((s) => [s.id, s]));

      assert.equal(byId[`ag:${agHybridId}`].agent, 'antigravity');
      assert.equal(byId[`ag:${agHybridId}`].entrypoint, 'app');
      assert.equal(byId[`ag:${agHybridId}`].project, 'ag-proj');
      assert.equal(byId[`ag:${agHybridId}`].n_events, 2);
      assert.equal(byId[`ag:${agHybridId}`].tok_in, 300);

      assert.equal(byId[`ag:${agPbOnlyId}`].agent, 'antigravity');
      assert.equal(byId[`ag:${agPbOnlyId}`].n_events, 2);
      assert.equal(byId[`ag:${agPbOnlyId}`].n_turns, 1);

      assert.equal(byId['ds:dsh-torn-001'].agent, 'deepseek');
      assert.equal(byId['ds:dsh-torn-001'].project, 'dsh-proj');
      assert.equal(byId['ds:dsh-torn-001'].n_events, 6);
      assert.equal(byId['ds:dsh-torn-001'].tok_in, 1200);
      assert.equal(byId['ds:dsh-torn-001'].tok_out, 80);

      assert.equal(byId['gm:synth-cli-001'].entrypoint, 'cli');
      assert.equal(byId['gm:synth-cli-001'].project, 'my-gemini-app');
      assert.equal(byId['gm:synth-cli-001'].n_events, 5);

      assert.equal(byId['gm:vega-001'].entrypoint, 'app');
      assert.equal(byId['gm:vega-001'].project, 'vega-proj');
      assert.equal(byId['gm:vega-001'].n_events, 3);

      assert.equal(byId[`gm:${gmConvId}`].entrypoint, 'app');
      assert.equal(byId[`gm:${gmConvId}`].project, 'code-mode-proj');
      assert.equal(byId[`gm:${gmConvId}`].git_branch, 'feat/gemini');
      assert.equal(byId[`gm:${gmConvId}`].n_events, 5);
      assert.equal(byId[`gm:${gmConvId}`].n_tools, 1);

      const dshEv = db.prepare(
        'SELECT e.src_off, e.src_len, s.path, s.sha256, s.parsed_bytes FROM events e JOIN sources s ON s.id = e.src_id WHERE e.session_id = ? AND e.kind = ?',
      ).get('ds:dsh-torn-001', 'llm.text') as Record<string, any>;
      const vs = await VerifiedSource.open(dshEv.path, { sha256: dshEv.sha256, bytes: dshEv.parsed_bytes });
      const rawBytes = await vs.read(dshEv.src_off, dshEv.src_len);
      await vs.close();
      assert.equal(JSON.parse(rawBytes.toString('utf8')).type, 'assistant/message');
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
