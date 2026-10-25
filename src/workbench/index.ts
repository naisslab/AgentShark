/** Read-only, evidence-grounded workbench shared by HTTP, CLI, MCP, and local clients. */
import type { DatabaseSync } from 'node:sqlite';
import { Data } from './data.ts';
import { Analysis } from './analysis.ts';
import { exportTelemetry, importTelemetryDocument, type TelemetryExportSpec } from './interop.ts';
import { replayPlan, replayReport } from './replay.ts';
import { localization, type LocalizationSpec } from './localization.ts';
import { diff, type DiffSpec } from './diff.ts';
import { perf, type PerfSpec } from './perf.ts';
import { cache, type CacheSpec } from './cache.ts';
import { capabilities, type CapabilitiesSpec } from './capabilities.ts';
import { Research, validateManifest, validateAnnotation } from './research.ts';
import type { ChecksSpec, CohortSpec, CompareSpec, ContextOptions, DatasetSpec, ExportSpec, InvestigationSpec, SearchSpec, WorkbenchOptions } from './types.ts';
export * from './types.ts';
export { WorkbenchInputError } from './data.ts';
export { validateManifest, validateAnnotation };
export { importTelemetryDocument } from './interop.ts';
export type { TelemetryExportSpec, TelemetryImportOptions, TelemetrySpan } from './interop.ts';
export type { LocalizationSpec, DiffSpec, PerfSpec, CacheSpec, CapabilitiesSpec };
export function createWorkbench(db: DatabaseSync, options: WorkbenchOptions = {}) {
    const data = new Data(db, options), analysis = new Analysis(data), research = new Research(data);
    return {
        context: (session: string, opts?: ContextOptions) => data.snapshot(() => analysis.context(session, opts)),
        compare: (spec: CompareSpec) => data.snapshot(() => analysis.compare(spec)),
        checks: (spec?: ChecksSpec) => data.snapshot(() => analysis.checks(spec)),
        coordination: (session: string) => data.snapshot(() => analysis.coordination(session)),
        verification: (session: string) => data.snapshot(() => analysis.verification(session)),
        search: (spec: SearchSpec) => data.snapshot(() => analysis.search(spec)),
        profile: (session: string) => data.snapshot(() => analysis.profile(session)),
        // Agent-native analyses over the versioned action stream (docs/analyses/).
        localization: (spec: LocalizationSpec) => data.snapshot(() => localization(data, spec)),
        diff: (spec: DiffSpec) => data.snapshot(() => diff(data, spec)),
        perf: (spec: PerfSpec) => data.snapshot(() => perf(data, spec)),
        cache: (spec: CacheSpec) => data.snapshot(() => cache(data, spec)),
        capabilities: (spec: CapabilitiesSpec) => data.snapshot(() => capabilities(data, spec)),
        dataset: (spec?: DatasetSpec) => data.snapshot(() => research.dataset(spec)),
        cohort: (spec?: CohortSpec) => data.snapshot(() => research.cohort(spec)),
        exportTable: (spec: ExportSpec) => data.snapshot(() => research.exportTable(spec)),
        investigation: (spec: InvestigationSpec) => data.snapshot(() => research.investigation(spec)),
        exportTelemetry: (spec?: TelemetryExportSpec) => data.snapshot(() => exportTelemetry(data, spec)),
        // Planning reads raw records from the source files, so it is asynchronous and reads no single snapshot.
        replayPlan: (input: Record<string, unknown>) => replayPlan(data, options.mode === 'capture' ? 'capture' : 'live', input),
        replayReport: (input: Record<string, unknown>) => data.snapshot(() => replayReport(data, input)),
        importTelemetryDocument,
        validateManifest, validateAnnotation,
    };
}
export type Workbench = ReturnType<typeof createWorkbench>;
