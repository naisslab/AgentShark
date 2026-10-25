// Analysis worker (derive/pool.ts): claims units from the shared counter, derives each from a read-only connection
// and posts its rows.

import { type MessagePort, workerData } from 'node:worker_threads';
import type { AlarmThresholds } from '../../model/types.ts';
import { openIndex } from '../db.ts';
import { deriveUnit } from '../derive.ts';
import type { Unit } from './plan.ts';
import { TreeLoader } from './tree.ts';

const { path, units, thresholds, shared, port } = workerData as {
  path: string; units: Unit[]; thresholds: AlarmThresholds; shared: Int32Array; port: MessagePort;
};

const notify = () => {
  Atomics.add(shared, 2, 1);
  Atomics.notify(shared, 2);
};

try {
  const db = openIndex(path, { readOnly: true });
  const loader = new TreeLoader(db);
  while (!Atomics.load(shared, 1)) {
    const i = Atomics.add(shared, 0, 1);
    if (i >= units.length) break;
    port.postMessage({ type: 'tree', outcome: deriveUnit(loader, units[i], thresholds) });
    notify();
  }
  db.close();
  port.postMessage({ type: 'done' });
} catch (err) {
  port.postMessage({ type: 'fatal', error: String((err as Error)?.message ?? err) });
}
notify();
