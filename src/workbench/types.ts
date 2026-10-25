/** Portable workbench contracts. All times and durations use integer microseconds. */
export const WORKBENCH_SCHEMA = 'agentshark.workbench.v1' as const;
export const WORKBENCH_VERSION = '1.1.0' as const;
export type Confidence = 'observed' | 'derived' | 'candidate' | 'unknown';
export interface EvidenceRef {
    eventId: string;
    sessionId: string;
    source: string;
    line: number | null;
    confidence: Confidence;
}
export interface Coverage {
    sessionIds: string[];
    eventsAvailable: number;
    eventsExamined: number;
    truncated: boolean;
    gaps: string[];
    indexAnalysisVersion: string | null;
    snapshotAt: number;
}
/** One gap's sentence for people, with the figures of this result filled in (src/workbench/gap-text.ts). */
export interface GapNote {
    code: string;
    text: string;
    /** True for a limit of the method or the logs that every result of the analysis carries, not a gap in this data. */
    permanent: boolean;
}
/** Who a session in `coverage.sessionIds` is, so clients can name runs and subagents without another request. */
export interface SessionIdentity {
    title: string | null;
    agent: string;
    role: string;
    parentId: string | null;
    /** The top of its run (the session itself for a root), which may be outside this result when it covers a subagent's subtree. */
    rootId: string;
    startTs: number | null;
    endTs: number | null;
}
/** AgentPerf's analysed window (`criticalPath.window`): the root's loaded events, beside the root's own first and last event. */
export interface PerfWindow {
    analyzedStartTs: number | null;
    analyzedEndTs: number | null;
    analyzedUs: number | null;
    sessionStartTs: number | null;
    sessionEndTs: number | null;
    sessionUs: number | null;
    /** `analyzedUs` over `sessionUs`, the share the partial-window note states; null without both. */
    share: number | null;
}
export interface Envelope {
    schemaVersion: typeof WORKBENCH_SCHEMA;
    analysisVersion: typeof WORKBENCH_VERSION;
    coverage: Coverage & { notes: GapNote[] };
    sessions: Record<string, SessionIdentity>;
}
export interface WorkbenchOptions {
    mode?: string;
    indexPath?: string;
    now?: number;
    maxEvents?: number;
    allowedSessions?: readonly string[];
}
export interface ContextOptions {
    atEventId?: string;
    stepId?: string;
    limit?: number;
}
export interface CompareSpec {
    left: string;
    right: string;
    limit?: number;
}
export type CheckRuleName = 'tests-after-edit' | 'unresolved-delegations' | 'repeated-failed-actions' | 'token-budget';
export interface CheckRule {
    rule: CheckRuleName;
    threshold?: number;
}
export interface ChecksSpec {
    sessions?: string[];
    rules?: (CheckRuleName | CheckRule)[];
}
export interface SequencePredicate {
    kind?: string | string[];
    tool?: string;
    textIncludes?: string;
    exitCode?: number;
    failure?: boolean;
    repeat?: number;
    sameAsPrevious?: ('tool' | 'target')[];
}
export interface SearchSpec {
    sessions?: string[];
    sequence: SequencePredicate[];
    withinUs?: number;
    maxGapEvents?: number;
    limit?: number;
}
export interface ResearchRun {
    sessionId: string;
    taskId: string;
    condition: string;
    trial: number;
    split?: 'train' | 'validation' | 'test';
    seed?: number;
    model?: string;
    repositoryRevision?: string;
    evaluatorVersion?: string;
    outcome?: 'success' | 'failure' | 'unknown';
    taskGroup?: string;
}
export interface ResearchManifest {
    schemaVersion: 'agentshark.manifest.v1';
    id: string;
    title: string;
    runs: ResearchRun[];
}
export interface Annotation {
    schemaVersion: 'agentshark.annotation.v1';
    id: string;
    subjectId: string;
    label: string;
    author: string;
    createdAt: string;
    rubricVersion: string;
    reviewed: boolean;
    evidenceEventIds: string[];
    note?: string;
}
export interface DatasetSpec {
    episodeIds?: string[];
    sessionIds?: string[];
    annotations?: Annotation[];
    manifest?: ResearchManifest;
    redact?: boolean;
    includeUnreviewed?: boolean;
    limit?: number;
}
export interface CohortSpec {
    manifest?: ResearchManifest;
    sessions?: string[];
    groupBy?: 'condition' | 'agent' | 'model';
}
export type ExportTable = 'sessions' | 'events' | 'steps' | 'failures' | 'changes' | 'annotations';
export interface ExportSpec {
    table: ExportTable;
    sessions?: string[];
    format: 'csv' | 'jsonl';
    annotations?: Annotation[];
    limit?: number;
    redact?: boolean;
}
export interface InvestigationSpec {
    title: string;
    sessions: string[];
    question?: string;
    annotations?: Annotation[];
    manifest?: ResearchManifest;
    findings?: {
        text: string;
        evidenceEventIds: string[];
        confidence: Confidence;
    }[];
}
export interface ValidationResult {
    valid: boolean;
    errors: string[];
}
