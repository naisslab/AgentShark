// One bounded, read-only dispatch contract shared by HTTP, CLI and MCP.
import type { DatabaseSync } from 'node:sqlite';
import { createWorkbench } from '../workbench/index.ts';

export const WORKBENCH_OPERATIONS = [
  'context', 'compare', 'checks', 'coordination', 'verification', 'dataset', 'search', 'profile', 'cohort', 'exportTable', 'investigation', 'exportTelemetry',
  'replayPlan', 'replayReport', 'localization', 'diff', 'perf', 'cache', 'capabilities',
] as const;
export type WorkbenchOperation = (typeof WORKBENCH_OPERATIONS)[number];
export type WorkbenchInput = Record<string, unknown>;
export interface WorkbenchOptions {
  mode?: 'live' | 'capture';
  indexPath?: string;
  now?: number;
  allowedSessions?: readonly string[];
}
export type WorkbenchDispatch = (operation: string, input: unknown) => unknown | Promise<unknown>;

export function validOperation(value: string): value is WorkbenchOperation {
  return WORKBENCH_OPERATIONS.includes(value as WorkbenchOperation);
}

export function workbenchInput(value: unknown): WorkbenchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError('Analysis input must be a JSON object');
  return value as WorkbenchInput;
}

export function inputError(message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status: 400, code: 'workbench-input' });
}

/**
 * Each synchronous analysis reads one consistent database snapshot, even during live indexing. The replay plan reads
 * raw records from source files, so it answers with a promise and outside the snapshot.
 */
export function runWorkbench(db: DatabaseSync, operation: string, raw: unknown, options: WorkbenchOptions = {}): unknown {
  if (!validOperation(operation)) throw inputError(`Unknown analysis '${operation}'`);
  const input = workbenchInput(raw);
  const wb = createWorkbench(db, { ...options, maxEvents: 50_000 });
  if (operation === 'replayPlan') return wb.replayPlan(input);
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN');
  try {
    let result: unknown;
    const session = () => {
      if (typeof input.session !== 'string' || !input.session.trim()) throw inputError('Choose a session');
      return input.session;
    };
    switch (operation) {
      case 'context': result = wb.context(session(), input); break;
      case 'coordination': result = wb.coordination(session()); break;
      case 'verification': result = wb.verification(session()); break;
      case 'profile': result = wb.profile(session()); break;
      case 'compare': result = wb.compare(input as unknown as Parameters<typeof wb.compare>[0]); break;
      case 'checks': result = wb.checks(input as Parameters<typeof wb.checks>[0]); break;
      case 'dataset': result = wb.dataset(input as Parameters<typeof wb.dataset>[0]); break;
      case 'search': result = wb.search(input as unknown as Parameters<typeof wb.search>[0]); break;
      case 'cohort': result = wb.cohort(input as Parameters<typeof wb.cohort>[0]); break;
      case 'exportTable': result = wb.exportTable(input as unknown as Parameters<typeof wb.exportTable>[0]); break;
      case 'investigation': result = wb.investigation(input as unknown as Parameters<typeof wb.investigation>[0]); break;
      case 'exportTelemetry': result = wb.exportTelemetry(input as Parameters<typeof wb.exportTelemetry>[0]); break;
      case 'replayReport': result = wb.replayReport(input); break;
      case 'localization': result = wb.localization({ ...input, session: session() } as Parameters<typeof wb.localization>[0]); break;
      case 'diff': result = wb.diff(input as unknown as Parameters<typeof wb.diff>[0]); break;
      case 'perf': result = wb.perf({ session: session() }); break;
      case 'cache': result = wb.cache({ ...input, session: session() } as Parameters<typeof wb.cache>[0]); break;
      case 'capabilities': result = wb.capabilities({ session: session() }); break;
    }
    if (own) db.exec('COMMIT');
    return result;
  } catch (err) {
    if (own && db.isTransaction) db.exec('ROLLBACK');
    if (err instanceof TypeError || err instanceof RangeError) throw inputError(err.message);
    throw err;
  }
}
