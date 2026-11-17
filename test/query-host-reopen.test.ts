import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openIndex } from '../src/index/db.ts';
import { createQueries } from '../src/index/queries.ts';
import { createDerivedQueries } from '../src/index/derived-queries.ts';
import { QueryHost } from '../src/server/query-host.ts';

test('derived API uses the replacement connection after the previous index closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentshark-query-reopen-'));
  const indexPath = join(dir, 'index.sqlite');
  let original: ReturnType<typeof openIndex> | undefined = openIndex(indexPath);
  let replacement: ReturnType<typeof openIndex> | undefined;
  let host: QueryHost | undefined;
  const queries = (db: ReturnType<typeof openIndex>) => {
    const local = createQueries(db, {
      mode: 'live', indexPath,
      getIndexing: () => ({ running: false, done: 0, total: 0, lastRunAt: null, lastRunMs: null }),
    });
    return { local, localDerived: createDerivedQueries(db, { mode: 'live', indexPath, resolveView: local.resolveView }) };
  };
  try {
    host = new QueryHost({ mode: 'live', indexPath, workers: 1, ...queries(original) });
    const api = host.derivedApi();
    const readStatus = api.analysisStatus;
    const initial = await readStatus();
    replacement = openIndex(indexPath);
    const next = queries(replacement);
    host.reopen(next.local, next.localDerived);
    original.close();
    original = undefined;
    const current = await readStatus();
    assert.equal(current.expected, initial.expected);
    assert.deepEqual(await api.analysisStatus(), current);
  } finally {
    await host?.close();
    original?.close();
    replacement?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
