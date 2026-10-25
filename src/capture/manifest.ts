// A capture records the implementation, settings and clock needed to analyze its embedded evidence again.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ANALYSIS_VERSION, SIG_VERSION, RULES, analysisStatus } from '../index/derive.ts';
import { SCHEMA_VERSION } from '../index/db.ts';
import { ALARM_THRESHOLDS, type AlarmThresholds } from '../model/types.ts';

export interface CaptureAnalysisManifest {
  version: 1;
  engineDigest: string;
  indexSchema: number;
  analysisVersion: number;
  signatureVersion: string;
  ruleVersions: string[];
  thresholds: AlarmThresholds;
  /** Fixed UTC epoch microseconds for replay; independent of the recipient's clock. */
  clock: number;
  snapshot: { generation: number; lastChangeAt: number | null; pending: string[]; failed: string[] };
  evidence: 'original' | 'redacted';
}

let digest: string | undefined;
export function engineDigest(): string {
  if (digest) return digest;
  // Hash the semantic contract, not executable source: TypeScript and compiled JavaScript distributions must
  // reproduce each other's captures. Rule/normalizer changes must bump analysis/schema versions respectively.
  const schema = readFileSync(join(import.meta.dirname, '../index/schema.sql'), 'utf8').replace(/\r\n/g, '\n');
  return digest = createHash('sha256').update(schema).update(JSON.stringify({
    analysis: ANALYSIS_VERSION, signature: SIG_VERSION, index: SCHEMA_VERSION, rules: RULES, thresholds: ALARM_THRESHOLDS,
  })).digest('hex');
}

export function captureManifest(db: DatabaseSync, clock: number, redacted: boolean): CaptureAnalysisManifest {
  const status = analysisStatus(db);
  const meta = new Map((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  return {
    version: 1, engineDigest: engineDigest(), indexSchema: SCHEMA_VERSION, analysisVersion: ANALYSIS_VERSION,
    signatureVersion: SIG_VERSION, ruleVersions: status.rules.map((r) => r.rule).sort(), thresholds: status.alarmThresholds, clock,
    snapshot: { generation: Number(meta.get('run_seq') ?? 0), lastChangeAt: meta.has('last_change_at') ? Number(meta.get('last_change_at')) : null,
      pending: status.pending, failed: (status.failed ?? []).map((r) => r.root) },
    evidence: redacted ? 'redacted' : 'original',
  };
}

/** Recorded mode never silently substitutes a different implementation or configuration. */
export function validateRecordedManifest(value: unknown): CaptureAnalysisManifest {
  const m = value as CaptureAnalysisManifest | undefined;
  if (!m || m.version !== 1 || m.engineDigest !== engineDigest() || m.analysisVersion !== ANALYSIS_VERSION || m.signatureVersion !== SIG_VERSION
    || m.indexSchema !== SCHEMA_VERSION) throw new Error('Capture analysis implementation differs from this build; use analysis: "current" to explicitly reanalyze');
  if (!Number.isSafeInteger(m.clock) || m.clock < 0 || !m.thresholds || Object.keys(ALARM_THRESHOLDS)
    .some((k) => !Number.isFinite(m.thresholds[k as keyof AlarmThresholds]) || m.thresholds[k as keyof AlarmThresholds] <= 0)) {
    throw new Error('Capture analysis manifest has an invalid clock or thresholds');
  }
  return m;
}
