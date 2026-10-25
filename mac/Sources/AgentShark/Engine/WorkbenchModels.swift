import Foundation

// Codable mirrors of the two workbench analyses the Mac draws natively: AgentPerf (`POST /api/workbench/perf`,
// src/workbench/perf.ts) and AgentDiff (`POST /api/workbench/diff`, src/workbench/diff.ts). Property names equal the
// JSON keys; times are Int64 µs since the epoch, durations Int64 µs, and shares 0…1 of the critical path.
// Values the engine cannot determine are null and decode as nil, never 0. Every field that analysis 1.1.0 added
// (docs/analyses/ANALYSIS-UX.md §7, E1–E12) is optional, so results of a 1.0.0 engine decode too.

// MARK: - Vocabularies (StringKind: values a newer engine adds still decode)

/// A vocabulary that keys a JSON object (`byClass`, `ops`, `failureResponses`). Without `CodingKeyRepresentable`,
/// `JSONDecoder` reads a dictionary with non-String keys as a flat array of keys and values.
protocol StringKeyed: StringKind, CodingKeyRepresentable {}

extension StringKeyed {
    var codingKey: CodingKey { VocabularyKey(stringValue: rawValue) }
    init?<T: CodingKey>(codingKey: T) { self.init(rawValue: codingKey.stringValue) }
}

private struct VocabularyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

/// The critical path's buckets are the turn-time buckets plus `human-gap`, `continuation`, `coordination` and
/// `unattributed` (`Bucket` in perf.ts).
extension TimeBucketName: StringKeyed {
    /// 1.1.0 (E11): a coalesced segment whose parts are in more than one bucket; never a key of `byBucket`.
    static let mixed: TimeBucketName = "mixed"
}

/// How directly the logs establish a value (`Confidence` in types.ts; its marks are ANALYSIS-UX decision 13).
struct WorkbenchConfidence: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let observed: WorkbenchConfidence = "observed"
    static let derived: WorkbenchConfidence = "derived"
    static let candidate: WorkbenchConfidence = "candidate"
    static let unknown: WorkbenchConfidence = "unknown"
    static let known: [WorkbenchConfidence] = [.observed, .derived, .candidate, .unknown]
}

/// A class of critical-path time (`Class` in perf.ts); each bucket belongs to one (`CLASS_OF`).
struct PathClass: StringKeyed {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let model: PathClass = "model"
    static let tools: PathClass = "tools"
    static let harness: PathClass = "harness"
    static let coordination: PathClass = "coordination"
    static let people: PathClass = "people"
    static let idle: PathClass = "idle"
    static let unattributed: PathClass = "unattributed"
    /// 1.1.0 (E11): a coalesced segment whose parts are in more than one class. It is a segment's class only, never a
    /// key of `byClass`, so `known` leaves it out.
    static let mixed: PathClass = "mixed"
    /// In the class bar's fixed order (ANALYSIS-UX §4.7), so two runs read alike.
    static let known: [PathClass] = [.model, .tools, .harness, .coordination, .people, .idle, .unattributed]
}

/// 1.1.0 (E8): what a path segment's interval was (`RefKind` in perf.ts).
struct SegmentRefKind: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    /// A step's model time.
    static let step: SegmentRefKind = "step"
    /// A tool call or another span.
    static let call: SegmentRefKind = "call"
    /// A wait on a subagent.
    static let child: SegmentRefKind = "child"
    static let known: [SegmentRefKind] = [.step, .call, .child]
}

/// What an action did (`Op` in actions.ts). `wait` never reaches the alignment.
struct ActionOp: StringKeyed {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let edit: ActionOp = "edit"
    static let read: ActionOp = "read"
    static let search: ActionOp = "search"
    static let wait: ActionOp = "wait"
    static let known: [ActionOp] = [.edit, .read, .search, "test", "build", "typecheck", "vcs", "install", "run", "web", "mcp", "delegate",
                                    .wait, "plan", "ask", "other"]
}

/// `ok`, `failed` or `unknown` (`Outcome` in actions.ts); also the last check before an action (`checkBefore`).
struct ActionOutcome: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let ok: ActionOutcome = "ok"
    static let failed: ActionOutcome = "failed"
    static let unknown: ActionOutcome = "unknown"
}

/// How the two runs' actions in one alignment row relate (`Status` in diff.ts).
struct AlignmentStatus: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let same: AlignmentStatus = "same"
    static let outcomeDiffers: AlignmentStatus = "outcome-differs"
    static let objectDiffers: AlignmentStatus = "object-differs"
    static let leftOnly: AlignmentStatus = "left-only"
    static let rightOnly: AlignmentStatus = "right-only"
    static let known: [AlignmentStatus] = [.same, .outcomeDiffers, .objectDiffers, .leftOnly, .rightOnly]
}

/// What a session did right after a failed action (failure-response@1), in the order of ANALYSIS-UX §5.7.
struct FailureResponse: StringKeyed {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [FailureResponse] = ["retry-same", "retry-modified", "edit", "inspect", "delegate", "stop", "other"]
}

/// A data-gap code in `coverage.gaps`. The constants are the codes the clients act on; `coverage.notes` holds the
/// sentence for every code.
struct WorkbenchGap: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let eventLimit: WorkbenchGap = "event-limit"
    static let actionLimit: WorkbenchGap = "action-limit"
    static let crossSessionOrder: WorkbenchGap = "cross-session-order-from-timestamps"
    static let mostlyUnexplained: WorkbenchGap = "critical-path-mostly-unexplained"
    static let windowPartial: WorkbenchGap = "critical-path-window-partial"
    static let segmentLimit: WorkbenchGap = "critical-path-segment-limit"
    static let childMatchedByTime: WorkbenchGap = "child-matched-by-time"
    static let structuralAlignment: WorkbenchGap = "alignment-is-structural-not-causal"
    static let shellChangesInvisible: WorkbenchGap = "shell-changes-invisible"
    static let alignmentRowLimit: WorkbenchGap = "alignment-row-limit"
    static let regionLimit: WorkbenchGap = "region-limit"
    static let completeExecutionNotEstablished: WorkbenchGap = "logs-do-not-establish-complete-execution"
    /// Always present on a diff; ANALYSIS-UX §5.8 shows them on the divergence card's caveat line only.
    static let permanentDiffGaps: [WorkbenchGap] = [.structuralAlignment, .shellChangesInvisible]
    /// The gaps true of every result whatever its data (`PERMANENT_GAPS` in gap-text.ts), for an engine whose notes do
    /// not say `permanent`.
    static let permanent: Set<WorkbenchGap> = [.completeExecutionNotEstablished, "queue-time-not-logged", .structuralAlignment, .shellChangesInvisible]
}

// MARK: - Envelope

/// The event behind a finding (`EvidenceRef` in types.ts). `eventId` opens with `GET /api/events/:id`.
struct EvidenceRef: Codable, Hashable, Sendable {
    var eventId: String
    var sessionId: String
    var source: String
    var line: Int?
    var confidence: WorkbenchConfidence
}

/// 1.1.0 (E5): a gap's sentence for people, with this result's figures filled in. Both fields are optional like every
/// 1.1.0 field, so one malformed note costs only itself, never the whole result.
struct GapNote: Codable, Hashable, Sendable {
    var code: WorkbenchGap?
    var text: String?
    /// The gap holds for every result, whatever its data (`PERMANENT_GAPS` in gap-text.ts).
    var permanent: Bool?
}

/// What an analysis read (`Coverage` in types.ts).
struct WorkbenchCoverage: Codable, Hashable, Sendable {
    /// Every session analysed: the root runs and their descendants.
    var sessionIds: [String]
    var eventsAvailable: Int
    var eventsExamined: Int
    var truncated: Bool
    /// Sorted gap codes.
    var gaps: [WorkbenchGap]
    var indexAnalysisVersion: String?
    var snapshotAt: Int64
    /// 1.1.0 (E5): one sentence per gap from the engine's table, so both clients use the same words.
    var notes: [GapNote]?

    /// The engine's sentence for `gap`; nil from a 1.0.0 engine, which sends none.
    func note(_ gap: WorkbenchGap) -> String? {
        notes?.first { $0.code == gap }?.text
    }

    /// `gap` holds for every result whatever its data: as the engine's note says, else as `WorkbenchGap.permanent` does.
    func isPermanent(_ gap: WorkbenchGap) -> Bool {
        notes?.first { $0.code == gap }?.permanent ?? WorkbenchGap.permanent.contains(gap)
    }
}

/// 1.1.0 (E4): who a session in `coverage.sessionIds` is, so runs and subagent lanes have titles even when the
/// sidebar has not loaded those sessions. Every field is optional, as `SessionRow` would leave it unknown.
struct WorkbenchSession: Codable, Hashable, Sendable {
    var title: String?
    var agent: AgentKind?
    /// `main` for a top-level run, else the subagent's role, as `SessionRow.role`.
    var role: String?
    var parentId: String?
    /// The top-level run the session belongs to, its own id for a top-level run (`root_id`).
    var rootId: String?
    var startTs: Int64?
    var endTs: Int64?
}

/// The envelope every workbench result carries (`Envelope` in types.ts).
protocol WorkbenchResult: Codable, Hashable, Sendable {
    /// `agentshark.workbench.v1`.
    var schemaVersion: String { get }
    /// `1.0.0`, or `1.1.0` once the engine sends the fields of ANALYSIS-UX §7.
    var analysisVersion: String { get }
    var coverage: WorkbenchCoverage { get }
    /// 1.1.0 (E4): keyed by every id in `coverage.sessionIds`.
    var sessions: [String: WorkbenchSession]? { get }
}

// MARK: - AgentPerf

/// `POST /api/workbench/perf` (docs/analyses/AGENTPERF.md): the critical path of one run with its subagents, the
/// time spent on rework, and how its subagents overlapped.
struct PerfResult: WorkbenchResult {
    var schemaVersion: String
    var analysisVersion: String
    var coverage: WorkbenchCoverage
    var sessions: [String: WorkbenchSession]?
    /// The analysed root; its descendants are always included.
    var sessionId: String
    var criticalPath: CriticalPath
    var rework: Rework
    var collaboration: Collaboration
    /// Timing the logs do not record, each with the sentence that says what it hides.
    var missing: [MissingTiming]
    var summary: Summary
    var rules: [String]
    var caveats: [String]

    struct CriticalPath: Codable, Hashable, Sendable {
        /// The analysed window: the root's first and last loaded activity; nil when nothing is timed.
        var startTs: Int64?
        var endTs: Int64?
        /// The path's length; nil when the root has no activity.
        var wallUs: Int64?
        /// Only classes with time on the path.
        var byClass: [PathClass: ClassShare]
        /// Only buckets with time on the path.
        var byBucket: [TimeBucketName: ClassShare]
        /// Each session's time on the path, largest first: the track's lane order.
        var bySession: [SessionShare]
        /// The class with the largest share.
        var binding: PathClass?
        /// The largest class other than waiting on people and idle time (1.1.0 also leaves out `unattributed`).
        var agentBinding: PathClass?
        /// 1.1.0 (E2): the largest class other than `unattributed`, for the "Not established" verdict.
        var largestAttributedClass: PathClass?
        /// `derived:largest-share`.
        var bindingSrc: Prov
        /// The engine's fixed sentence for `binding` and `agentBinding`, shown verbatim.
        var advice: [Advice]
        var topTools: [Contributor]
        var topSteps: [Contributor]
        /// In time order; at most 2,000 (the `critical-path-segment-limit` gap marks the cut).
        var segments: [PathSegment]
        /// 1.1.0 (E11): segments before the 2,000 cap.
        var segmentsTotal: Int?
        /// 1.1.0 (E1): the part of the session the loaded events cover.
        var window: PerfWindow?
        /// Every tool target and every model step with time on the path, before the top ten; nil from an engine that
        /// does not count them.
        var topToolsTotal: Int?
        var topStepsTotal: Int?
    }

    /// Time on the path and its share; nil share when the path has no length.
    struct ClassShare: Codable, Hashable, Sendable {
        var us: Int64
        var share: Double?
        /// 1.1.0 (E12): the part of `us` the logs do not time directly, hatched on the class bar.
        var derivedUs: Int64?
    }

    struct SessionShare: Codable, Hashable, Sendable {
        var sessionId: String
        var us: Int64
        var share: Double?
    }

    struct Advice: Codable, Hashable, Sendable {
        var `class`: PathClass
        var text: String
    }

    /// A tool target (`topTools`, key like `sh:pytest`) or a model step (`topSteps`, key like `cc:…#step:40`).
    struct Contributor: Codable, Hashable, Sendable {
        var key: String
        var us: Int64
        var share: Double?
        /// The first event of the contributor's first span on the path; empty when none is known.
        var evidence: [EvidenceRef]
        /// 1.1.0 (E3), steps only: the step's session, number, intent and turn.
        var sessionId: String?
        var stepN: Int?
        var intent: String?
        var turnId: String?
        /// The part of `us` whose interval is derived from timestamps rather than logged, as `ClassShare.derivedUs`; nil
        /// from an engine that does not send it.
        var derivedUs: Int64?
    }

    /// A stretch of the path in one session and one bucket, or (1.1.0) a run of short ones coalesced.
    struct PathSegment: Codable, Hashable, Sendable {
        var sessionId: String
        /// `mixed` for a coalesced run whose parts are in more than one bucket.
        var bucket: TimeBucketName
        /// `mixed` for a coalesced run whose parts are in more than one class.
        var `class`: PathClass
        var start: Int64
        var end: Int64
        var us: Int64
        /// False when the interval is derived from timestamps rather than logged.
        var logged: Bool
        /// Empty for gaps between turns and unattributed time: no event marks them.
        var evidence: [EvidenceRef]
        /// 1.1.0 (E8): what the segment did, the step it belongs to, and whether it is a step, a tool call or a child.
        var label: String?
        var stepId: String?
        var refKind: SegmentRefKind?
        /// 1.1.0 (E11): a coalesced run's time per bucket, largest first. Only the order inside the run is lost.
        var parts: Tolerant<[SegmentPart]>?

        var mixedParts: [SegmentPart] { parts?.value ?? [] }
        /// The coalesced parts span more than one class, so no class color fits the segment.
        var isMixed: Bool { `class` == .mixed }
    }

    /// One bucket's share of a coalesced segment.
    struct SegmentPart: Codable, Hashable, Sendable {
        var bucket: TimeBucketName?
        var `class`: PathClass
        var us: Int64
        /// The path segments of this bucket the run combines.
        var segments: Int?
    }

    /// 1.1.0 (E1). The engine loads at most 50,000 events, so the analysed window can be a fraction of the session.
    struct PerfWindow: Codable, Hashable, Sendable {
        var analyzedStartTs: Int64?
        var analyzedEndTs: Int64?
        var analyzedUs: Int64?
        var sessionStartTs: Int64?
        var sessionEndTs: Int64?
        var sessionUs: Int64?
        /// `analyzedUs` over `sessionUs`; nil from an engine that does not send it.
        var share: Double?
    }

    /// Repeated or undone work (rework@1 rules), not necessarily waste.
    struct Rework: Codable, Hashable, Sendable {
        var rereads: ReworkFinding
        var reverts: ReworkFinding
        var blindRetries: ReworkFinding
        var repeatedSearches: ReworkFinding
        var fixLoops: ReworkFinding
    }

    struct ReworkFinding: Codable, Hashable, Sendable {
        var count: Int
        /// Time of the repeated actions, and the part of it on the critical path.
        var us: Int64
        var onPathUs: Int64
        /// At most 50 events.
        var evidence: [EvidenceRef]
    }

    struct Collaboration: Codable, Hashable, Sendable {
        var delegations: [Delegation]
        /// Busy time summed over every session in the run.
        var workUs: Int64
        /// The path without its waits on people and idle time.
        var spanUs: Int64?
        /// `workUs / spanUs`; nil when the span is zero or unknown.
        var parallelism: Double?
        var coordinationUs: Int64
    }

    /// A subagent the run started.
    struct Delegation: Codable, Hashable, Sendable {
        var id: String
        var parent: String
        var child: String
        /// `agent`, `task`, `spawn-agent` or `workflow-agent`.
        var kind: String
        /// The child's active span.
        var start: Int64
        var end: Int64?
        var busyUs: Int64?
        var onPathUs: Int64
        var parentWaitUs: Int64?
        var siblingOverlapUs: Int64?
        var duplicateReads: DuplicateReads
        /// 1.1.0 (E10): the task text (at most 300 characters) and how the delegation ended.
        var taskExcerpt: String?
        var outcome: DelegationOutcome?
    }

    struct DuplicateReads: Codable, Hashable, Sendable {
        var count: Int
        var evidence: [EvidenceRef]
    }

    struct MissingTiming: Codable, Hashable, Sendable {
        var code: WorkbenchGap
        /// What the missing timing hides, as one sentence.
        var effect: String
    }

    struct Summary: Codable, Hashable, Sendable {
        var wallUs: Int64?
        var pathUs: Int64
        var modelShare: Double?
        var toolsShare: Double?
        var peopleShare: Double?
        var idleShare: Double?
        var coordinationShare: Double?
        var unattributedShare: Double?
        var parallelism: Double?
    }
}

// MARK: - AgentDiff

/// `POST /api/workbench/diff` (docs/analyses/AGENTDIFF.md): where two runs of one task part, aligned action by
/// action, and how each behaved. `left` is run A, `right` run B.
struct DiffResult: WorkbenchResult {
    var schemaVersion: String
    var analysisVersion: String
    var coverage: WorkbenchCoverage
    var sessions: [String: WorkbenchSession]?
    /// `weighted-action-lcs@1`.
    var method: String
    var left: RunSide
    var right: RunSide
    /// Right minus left per metric; nil when either side is unknown.
    var delta: MetricsDelta
    /// Nil when every aligned row is the same.
    var firstDivergence: Divergence?
    /// At most 100 (`region-limit`); `summary.regions` counts them all.
    var regions: [Region]
    /// At most 3,000 rows (`alignment-row-limit`).
    var alignment: [AlignmentRow]
    var summary: DiffSummary
    var rules: [String]
    var caveats: [String]

    /// Aligned rows before the 3,000-row cap; a 1.0.0 engine reports only the rows it returned.
    var alignedRows: Int { summary.rows ?? alignment.count }

    struct RunSide: Codable, Hashable, Sendable {
        /// The root run.
        var session: String
        /// The run's whole tree when subagents are included, else the root alone.
        var sessions: [String]
        var metrics: RunMetrics
        var profile: BehaviorProfile
    }

    struct RunMetrics: Codable, Hashable, Sendable {
        var sessions: Int
        var steps: Int
        /// Every action, waits included.
        var actions: Int
        var failedActions: Int
        var edits: Int
        var filesEdited: Int
        /// First to last logged event over all of the run's sessions.
        var wallUs: Int64?
        var tokensIn: Int64?
        var tokensOut: Int64?
        /// 1.1.0 (E6): actions other than waits, after and before the action limit.
        var alignedActions: Int?
        var alignableActions: Int?
    }

    struct MetricsDelta: Codable, Hashable, Sendable {
        var sessions: Int64?
        var steps: Int64?
        var actions: Int64?
        var failedActions: Int64?
        var edits: Int64?
        var filesEdited: Int64?
        var wallUs: Int64?
        var tokensIn: Int64?
        var tokensOut: Int64?
        var alignedActions: Int64?
        var alignableActions: Int64?
    }

    struct BehaviorProfile: Codable, Hashable, Sendable {
        var rereads: ProfileFinding
        var reverts: ProfileFinding
        var blindRetries: ProfileFinding
        var repeatedSearches: ProfileFinding
        var fixLoops: Int
        var fixLoopCycles: Int
        var fixLoopsResolved: Int
        /// Counts only; the engine returns no evidence for them.
        var failureResponses: [FailureResponse: Int]
    }

    struct ProfileFinding: Codable, Hashable, Sendable {
        var count: Int
        /// At most 50 findings.
        var evidence: [ProfileEvidence]
    }

    struct ProfileEvidence: Codable, Hashable, Sendable {
        var detail: String?
        var confidence: WorkbenchConfidence
        var evidence: [EvidenceRef]
    }

    /// One action of one run in the alignment.
    struct ActionView: Codable, Hashable, Sendable {
        /// The tool call's event id, or the result's when no call was logged.
        var id: String
        var sessionId: String
        var op: ActionOp
        /// `edit:<path>`, `read:<path>`, a search as `<target>#<input digest>`, otherwise the target (`sh:git status`).
        var object: String
        var outcome: ActionOutcome
        /// Earlier edits of the same file in this run; nil for objects that are not files.
        var editsBefore: Int?
        /// The outcome of the last test, build or typecheck before this action.
        var checkBefore: ActionOutcome?
        var evidence: [EvidenceRef]
        /// 1.1.0 (E9): when the action ran, its tool, its step, and a readable label (at most 120 characters of the
        /// command or search query).
        var start: Int64?
        var end: Int64?
        var tool: String?
        var stepId: String?
        var label: String?
    }

    struct AlignmentRow: Codable, Hashable, Sendable {
        var index: Int
        var status: AlignmentStatus
        /// `candidate` for an ambiguous or object-differs pair, else `derived`; an engine before 1.1 also sent `candidate`
        /// for unpaired rows, whose status the client shows without a mark.
        var confidence: WorkbenchConfidence
        /// The row's op and object occur more than once in either run.
        var ambiguous: Bool
        /// 0 for unpaired rows, 2 to 7 for pairs.
        var score: Int
        var left: ActionView?
        var right: ActionView?
    }

    /// A maximal stretch of rows that are not the same, between same rows.
    struct Region: Codable, Hashable, Sendable {
        /// Inclusive row indexes.
        var from: Int
        var to: Int
        var anchorBefore: Int?
        var anchorAfter: Int?
        var left: RegionSide
        var right: RegionSide
        /// A same row follows the region.
        var reconverged: Bool
    }

    struct RegionSide: Codable, Hashable, Sendable {
        var actions: Int
        var ops: [ActionOp: Int]
        /// From the earlier of the anchor before's end and the side's first start to the later of the anchor after's start
        /// and its last end; nil when an action has no time, or a side without actions lacks an anchor.
        var wallUs: Int64?
    }

    struct Divergence: Codable, Hashable, Sendable {
        /// The first row that is not the same.
        var index: Int
        /// The last same row before it; nil when the runs differ from their first action.
        var anchor: Anchor?
        var left: DivergenceSide
        var right: DivergenceSide
    }

    struct Anchor: Codable, Hashable, Sendable {
        var index: Int
        var left: ActionView?
        var right: ActionView?
    }

    struct DivergenceSide: Codable, Hashable, Sendable {
        /// What the run saw last before the divergence; nil when no result was recorded.
        var observation: Observation?
        /// Up to five actions from the divergence on.
        var next: [ActionView]
    }

    struct Observation: Codable, Hashable, Sendable {
        /// At most 400 characters.
        var excerpt: String
        var evidence: [EvidenceRef]
    }

    struct DiffSummary: Codable, Hashable, Sendable {
        var same: Int
        var outcomeDiffers: Int
        var objectDiffers: Int
        var leftOnly: Int
        var rightOnly: Int
        var ambiguous: Int
        /// Every region, including those past the 100 returned.
        var regions: Int
        /// -1 when the runs never diverge; `firstDivergence` says the same.
        var firstDivergenceIndex: Int
        /// 1.1.0 (E6): aligned rows before the 3,000-row cap.
        var rows: Int?
    }
}

// MARK: - Shapes still settling

/// A field whose shape the engine has not fixed yet: a value of another shape decodes as nil instead of failing the
/// whole result.
struct Tolerant<Value: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
    var value: Value?

    init(_ value: Value?) { self.value = value }

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(value)
    }
}
