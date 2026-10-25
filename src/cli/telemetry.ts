import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultIndexPath, openIndex } from '../index/db.ts';
import { createWorkbench, importTelemetryDocument } from '../workbench/index.ts';
import { type Args, CliError, string, strings, write } from './util.ts';

/** Offline interchange. Import preserves unknown provider/timing instead of inventing native-agent records. */
export async function telemetry(a: Args): Promise<number> {
  const direction = a.positionals[0];
  if (direction !== 'import' && direction !== 'export') throw new CliError('telemetry requires import or export', 2);
  let result: unknown;
  try {
    if (direction === 'import') {
      const input = string(a.values.input);
      if (!input) throw new CliError('telemetry import requires --input FILE.json', 2);
      const path = resolve(input);
      if ((await stat(path)).size > 20 * 1024 * 1024) throw new CliError('Telemetry input exceeds 20 MiB; split it into smaller documents', 2);
      let document: unknown;
      try { document = JSON.parse(await readFile(path, 'utf8')); }
      catch (e) { throw new CliError(`Cannot read telemetry JSON: ${(e as Error).message}`, 2); }
      result = importTelemetryDocument(document);
    } else {
      if (a.values.input) throw new CliError('--input is only used for telemetry import', 2);
      const indexPath = string(a.values.index) ?? defaultIndexPath();
      const db = openIndex(indexPath, { readOnly: true });
      try { result = createWorkbench(db, { indexPath }).exportTelemetry({ sessions: strings(a.values.session), includeText: a.values['include-text'] === true }); }
      finally { db.close(); }
    }
  } catch (e) {
    if ((e as { status?: number }).status === 400) throw new CliError((e as Error).message, 2);
    throw e;
  }
  const output = string(a.values.out), text = JSON.stringify(result, null, 2) + '\n';
  if (output) await writeFile(resolve(output), text, { flag: 'wx', mode: 0o600 });
  else await write(text);
  return 0;
}
