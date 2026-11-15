import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileInfo, sourceId } from '../src/adapters/adapter.ts';
import { geminiAdapter } from '../src/adapters/gemini.ts';
import { openIndex, READABLE_OLD_SCHEMAS, SCHEMA_VERSION } from '../src/index/db.ts';
import type { IndexRecord } from '../src/model/types.ts';

async function parseArchive(archive: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'agentshark-vega-'));
  try {
    const path = join(dir, 'archive.json');
    writeFileSync(path, JSON.stringify(archive));
    const file = (await fileInfo(path, 'gemini', 'gemini-session', 'gemini'))!;
    const records: IndexRecord[] = [];
    await geminiAdapter.parse({ file, sourceId: sourceId(path) }, { emit: r => { records.push(r); } });
    return {
      events: records.filter(r => r.rec === 'event'),
      spans: records.filter(r => r.rec === 'span'),
      session: records.find(r => r.rec === 'session'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Vega role-tagged strings preserve both speakers without duplicating the archive prompt', async () => {
  const r = await parseArchive({
    id: 'roles', title: 'Archive title', prompt: 'Hello Vega',
    steps: [
      { role: 'user', content: 'Hello Vega', timestamp: '2026-11-15T01:00:00Z' },
      { role: 'model', content: 'Hi from Vega!', timestamp: '2026-11-15T01:00:01Z' },
    ],
  });
  assert.deepEqual(r.events.map(e => [e.kind, e.actor, e.attrs.text]), [
    ['user.prompt', 'user', 'Hello Vega'], ['llm.text', 'assistant', 'Hi from Vega!'],
  ]);
  assert.equal(r.session?.title, 'Archive title');
  assert.equal(r.spans.filter(s => s.kind === 'llm').length, 1);
});

test('Vega nested archives retain structured content and assistant roles', async () => {
  const r = await parseArchive({
    trajectory: {
      id: 'structured', title: 'Structured archive',
      steps: [
        { role: 'user', content: [{ text: 'Inspect' }, 'this file'], timestamp: '2026-11-15T01:00:00Z' },
        { role: 'assistant', content: { parts: [{ text: 'It contains' }, { text: 'sample data.' }] },
          thinking: 'Read the file', model: 'gemini-test', timestamp: '2026-11-15T01:00:01Z' },
      ],
    },
  });
  assert.deepEqual(r.events.map(e => [e.kind, e.attrs.text]), [
    ['user.prompt', 'Inspect\nthis file'], ['llm.thinking', 'Read the file'], ['llm.text', 'It contains\nsample data.'],
  ]);
  assert.equal(r.events.at(-1)?.attrs.llm?.model, 'gemini-test');
});

test('Vega model-call archives retain explicit prompts and timing without inventing title prompts', async () => {
  const modelCalls = [{ model: 'gemini-test', reply: 'Legacy reply',
    startedAt: '2026-11-15T01:00:00Z', completedAt: '2026-11-15T01:00:02Z' }];
  const r = await parseArchive({ id: 'legacy', prompt: 'Actual prompt', modelCalls });
  assert.deepEqual(r.events.map(e => [e.kind, e.attrs.text]), [
    ['user.prompt', 'Actual prompt'], ['llm.text', 'Legacy reply'],
  ]);
  assert.equal(r.events.at(-1)?.attrs.llm?.latency_ms, 2000);
  const titleOnly = await parseArchive({ id: 'title-only', title: 'Archive label', modelCalls });
  assert.deepEqual(titleOnly.events.map(e => e.kind), ['llm.text']);
  assert.equal(titleOnly.session?.title, 'Archive label');
});

test('schema 7 Vega indexes remain readable during replacement and rebuild on a writable open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentshark-vega-migration-'));
  let db: ReturnType<typeof openIndex> | undefined;
  try {
    const path = join(dir, 'index.sqlite');
    db = openIndex(path);
    db.exec("INSERT INTO sessions (id, agent, native_id, role) VALUES ('gm:old', 'gemini', 'old', 'main')");
    db.exec("UPDATE meta SET value = '7' WHERE key = 'schema_version'");
    db.close();
    db = undefined;
    db = openIndex(path, { readOnly: true, acceptSchema: READABLE_OLD_SCHEMAS });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
    db.close();
    db = undefined;
    db = openIndex(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value, String(SCHEMA_VERSION));
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
