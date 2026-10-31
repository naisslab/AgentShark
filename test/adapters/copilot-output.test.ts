import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileInfo, sourceId } from '../../src/adapters/adapter.ts';
import { copilotCliAdapter } from '../../src/adapters/copilot-cli.ts';
import { openIndex, SCHEMA_VERSION } from '../../src/index/db.ts';
import { runIndex } from '../../src/index/indexer.ts';
import type { EventRec } from '../../src/model/types.ts';
import { createWorkbench } from '../../src/workbench/index.ts';

async function parse(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-output-'));
  try {
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, text);
    const file = (await fileInfo(path, 'copilot', 'session-events', 'copilot-cli'))!;
    const events: EventRec[] = [];
    await copilotCliAdapter.parse({ sourceId: sourceId(path), file }, { emit: r => { if (r.rec === 'event') events.push(r); } });
    return { events };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const lines = (items: unknown[]) => items.map(x => JSON.stringify(x)).join('\n') + '\n';
const cli = (type: string, data: object, timestamp = '2026-09-21T14:13:20.000Z') => ({ type, data, timestamp });

test('CLI distinguishes missing output from empty content and retains recorded errors', async () => {
  const cases = [
    { data: {}, output: undefined },
    { data: { result: {} }, output: undefined },
    { data: { result: { content: null } }, output: undefined },
    { data: { result: { content: '' } }, output: '' },
    { data: { success: false, error: { message: 'Command failed' } }, output: 'Command failed' },
    { data: { result: { content: '' }, error: { message: 'Command failed' } }, output: '' },
  ];
  const r = await parse(lines(cases.map(({ data }, i) =>
    cli('tool.execution_complete', { toolCallId: `t${i}`, success: true, ...data }))));
  assert.equal(r.events.length, cases.length);
  for (const [i, { output }] of cases.entries()) {
    assert.equal(r.events[i].attrs.tool?.output, output);
    assert.equal(r.events[i].attrs.tool?.output_len, output?.length);
  }
});

for (const recorded of [false, true]) test(`CLI reliability requires recorded output, including empty strings (recorded: ${recorded})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-reliability-'));
  const db = openIndex(':memory:');
  try {
    const path = join(dir, 'session.jsonl');
    const events = [cli('user.message', { content: 'Run the tests' })];
    for (let i = 0; i < 5; i++) {
      const toolCallId = `t${i}`;
      const timestamp = (offset: number) => new Date(1790000000000 + (i * 2 + offset) * 1000).toISOString();
      events.push(
        cli('tool.execution_start', { toolCallId, toolName: 'bash', arguments: { command: 'node --test' } }, timestamp(1)),
        cli('tool.execution_complete', { toolCallId, success: true, shellExecution: { exitCode: 0 },
          ...(recorded ? { result: { content: '' } } : {}) }, timestamp(2)),
      );
    }
    writeFileSync(path, lines(events));
    const file = (await fileInfo(path, 'copilot', 'session-events', 'copilot-cli'))!;
    const indexed = await runIndex(db, { sources: [file], workers: 0 });
    assert.deepEqual(indexed.errors, []);
    const report = createWorkbench(db).reliability({ session: 'cp:session' });
    assert.equal(report.summary.repeatedObservationChains, recorded ? 1 : 0);
    assert.equal(report.summary.stopRecommendations, recorded ? 1 : 0);
    assert.equal(report.noProgress.length, recorded ? 1 : 0);
    if (recorded) assert.equal(report.noProgress[0].attempts, 5);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('schema 5 cached observations are discarded for reparsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-output-migration-'));
  let db: ReturnType<typeof openIndex> | undefined;
  try {
    const path = join(dir, 'index.sqlite');
    db = openIndex(path);
    db.exec("INSERT INTO sessions (id, agent, native_id, role) VALUES ('cp:old', 'copilot', 'old', 'main')");
    db.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'");
    db.close();
    db = undefined;
    db = openIndex(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value, String(SCHEMA_VERSION));
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});
