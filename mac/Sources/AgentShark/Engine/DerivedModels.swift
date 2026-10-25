import Foundation

// Codable mirrors of the agent-native derived model (src/model/types.ts §12 part, src/index/api.ts DerivedQueries;
// docs/MAC-CONTRACT.md §5.3). Property names equal the JSON keys; times are Int64 µs since the epoch, durations Int64 µs.
// Values the logs do not carry are null and decode as nil, never 0.

// MARK: - Vocabularies (StringKind: unknown values decode)

struct FailureTier: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let failure: FailureTier = "failure"
    static let suspect: FailureTier = "suspect"
    static let benign: FailureTier = "benign"
    static let deferred: FailureTier = "deferred"
    static let known: [FailureTier] = [.failure, .suspect, .benign, .deferred]
}

struct FailureSource: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [FailureSource] = ["flag", "inner", "api", "policy", "hook", "process", "text"]
}

struct FailureFamily: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [FailureFamily] = ["api", "policy", "sandbox", "network", "stale-edit", "test-failure", "missing-module", "missing-file",
                                         "harness", "hook", "exception", "error-text", "other"]
    /// Families that mean "blocked by the environment" (SPEC §12.4 step 5).
    static let blocked: Set<FailureFamily> = ["sandbox", "policy", "network"]
    var isBlocked: Bool { Self.blocked.contains(self) }
}

struct FailureClass: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [FailureClass] = ["environment", "harness", "agent-work"]
}

struct EpisodeOutcome: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let recovered: EpisodeOutcome = "recovered"
    static let interrupted: EpisodeOutcome = "interrupted"
    static let parallelOK: EpisodeOutcome = "parallel-ok"
    static let recoveredLater: EpisodeOutcome = "recovered-later"
    static let pivoted: EpisodeOutcome = "pivoted"
    static let endedOnFailure: EpisodeOutcome = "ended-on-failure"
    static let open: EpisodeOutcome = "open"
    static let known: [EpisodeOutcome] = [.recovered, .interrupted, .parallelOK, .recoveredLater, .pivoted, .endedOnFailure, .open]
    /// Did not recover within its turn.
    var isUnrecovered: Bool { [.endedOnFailure, .pivoted, .interrupted, .recoveredLater].contains(self) }
}

struct EpisodeSection: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [EpisodeSection] = ["blocked", "unrecovered", "other", "recovered"]
}

struct TurnImpact: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let failed: TurnImpact = "failed"
    static let blocked: TurnImpact = "blocked"
    static let interrupted: TurnImpact = "interrupted"
    static let masked: TurnImpact = "masked"
    static let degraded: TurnImpact = "degraded"
    static let slow: TurnImpact = "slow"
    static let recovered: TurnImpact = "recovered"
    static let clean: TurnImpact = "clean"
    /// Worst first (SPEC §12.3.6).
    static let known: [TurnImpact] = [.failed, .blocked, .interrupted, .masked, .degraded, .slow, .recovered, .clean]
    /// 0 = worst; unknown values rank just above clean.
    var rank: Int { Self.known.firstIndex(of: self) ?? Self.known.count - 1 }
    var isProblem: Bool { rank <= TurnImpact.degraded.rank }
}

struct DelegationOutcome: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [DelegationOutcome] = ["completed", "failed", "blocked", "killed", "stopped", "running", "unknown"]
    var isFailure: Bool { ["failed", "blocked", "killed"].contains(rawValue) }
}

struct ClaimEvidence: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [ClaimEvidence] = ["passed-after-last-edit", "edited-after-last-test", "last-test-failed", "no-test-in-turn", "unknown"]
    static let unverified: Set<ClaimEvidence> = ["edited-after-last-test", "last-test-failed", "no-test-in-turn"]
    var isUnverified: Bool { Self.unverified.contains(self) }
}

struct InterventionKind: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [InterventionKind] = ["interrupt", "abort-child", "tool-rejected", "policy-rejected", "hook-blocked", "permission-decision",
                                            "question", "external-edit", "correction"]
}

struct AlarmKind: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let consecutive: AlarmKind = "consecutive"
    static let blocker: AlarmKind = "blocker"
    static let known: [AlarmKind] = [.consecutive, .blocker, "blind-loop", "loop", "stall", "silent-child"]
    /// Only these may notify (SPEC §12.3.9).
    static let notifying: [AlarmKind] = [.consecutive, .blocker]
}

struct AlarmState: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let firing: AlarmState = "firing"
    static let cleared: AlarmState = "cleared"
    static let expired: AlarmState = "expired"
    static let known: [AlarmState] = [.firing, .cleared, .expired]
}

struct SignatureStatus: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [SignatureStatus] = ["new", "recurring", "dormant", "regressed"]
}

struct AttentionSection: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let alarms: AttentionSection = "alarms"
    static let other: AttentionSection = "other"
    static let recovered: AttentionSection = "recovered"
    /// Display order (SPEC §12.7).
    static let known: [AttentionSection] = [.alarms, "blocked", "unrecovered", "silent-child", "unverified-claims", "recurring", .other, .recovered]
    /// Sections whose items are episodes; their counts add up to the summary's `episodes`.
    static let episodeSections: [AttentionSection] = ["blocked", "unrecovered", .other, .recovered]
    /// Sections that count toward "n need attention".
    var needsAttention: Bool { self != .other && self != .recovered && Self.known.contains(self) }
    var startsCollapsed: Bool { self == .other || self == .recovered }
    /// What a section counts when it is not episodes or alarms: "14 signatures", "655 turns", "54 delegations".
    var unit: String? {
        switch rawValue {
        case "recurring": return "signature"
        case "unverified-claims": return "turn"
        case "silent-child": return "delegation"
        default: return nil
        }
    }
}

struct QueueGroup: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let attention: QueueGroup = "attention"
    static let episode: QueueGroup = "episode"
    static let signature: QueueGroup = "signature"
    static let session: QueueGroup = "session"
    static let delegation: QueueGroup = "delegation"
    static let known: [QueueGroup] = [.attention, .episode, .signature, .session, .delegation]
}

struct QueueRowKind: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let episode: QueueRowKind = "episode"
    static let alarm: QueueRowKind = "alarm"
    static let delegation: QueueRowKind = "delegation"
    static let claim: QueueRowKind = "claim"
    static let signature: QueueRowKind = "signature"
    static let session: QueueRowKind = "session"
}

struct ChangeClass: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [ChangeClass] = ["identical", "flags-only", "small", "moderate", "rewrite"]
}

struct ChangeOp: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [ChangeOp] = ["read", "add", "update", "delete", "move", "write", "external", "backup", "shell-mention"]
}

struct TimeBucketName: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let known: [TimeBucketName] = ["wait-human", "wait-agent", "wait-process", "api-retry", "compaction", "hook", "tool", "model"]
}

struct GapCode: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let analysisPending: GapCode = "analysis-pending"
    static let analysisOutdated: GapCode = "analysis-outdated"
    static let rawUnavailable: GapCode = "raw-unavailable"
}

/// Provenance of a derived value (SPEC §12.1 principle 5): `logged[:field]`, `derived[:how]`, `parsed[:what]` or
/// `inferred:<rule>@<version>`.
struct Prov: StringKind {
    enum Family: String, Hashable, Sendable { case logged, derived, parsed, inferred }

    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    var family: Family {
        let head = rawValue.split(separator: ":", maxSplits: 1).first.map(String.init) ?? rawValue
        return Family(rawValue: head) ?? .derived
    }

    /// The bare `<rule>@<v>` of an inferred value, or `<rule>@<v>/<state>` for one state of its label.
    var rule: String? {
        guard family == .inferred, let colon = rawValue.firstIndex(of: ":") else { return nil }
        return String(rawValue[rawValue.index(after: colon)...])
    }

    /// The glyph beside a value: none for logged, ≈ derived, ~ parsed, ? inferred (WEB-CONTRACT "Glyphs and marks").
    var mark: String {
        switch family {
        case .logged: return ""
        case .derived: return "≈"
        case .parsed: return "~"
        case .inferred: return "?"
        }
    }

    /// "logged (llm.latency_ms)", "derived (ts-gap)", … for tooltips.
    var words: String {
        guard let colon = rawValue.firstIndex(of: ":") else { return rawValue }
        return "\(family.rawValue) (\(rawValue[rawValue.index(after: colon)...]))"
    }
}

// MARK: - Envelope

struct DerivedScope: Codable, Hashable, Sendable {
    /// `view | all | session | item`.
    var kind: String
    var viewId: String?
    var sessionId: String?
    var descendants: Bool?
    var since: Int64?
    var until: Int64?
    var events: Int?
    var project: String?
}

struct Gap: Codable, Hashable, Sendable, Identifiable {
    var code: GapCode
    var message: String
    /// SPEC §12.9 data-limit number (1–12), or nil for an index state.
    var limit: Int?
    var field: String?
    var count: Int?
    var id: String { "\(code.rawValue)|\(field ?? "")" }
}

struct AlarmThresholds: Codable, Hashable, Sendable {
    var consecutive: Int
    var blocker: Int
    var stallMin: Double
    var windowMin: Double

    /// `ALARM_THRESHOLDS` in types.ts.
    static let defaults = AlarmThresholds(consecutive: 6, blocker: 2, stallMin: 10, windowMin: 15)
}

struct RuleInfo: Codable, Hashable, Sendable {
    var rule: String
    var description: String
    var precision: Double?
    var checked: Int?
    var basis: String?
    var validation: String?
    var advisory: Bool?
}

/// State of the analysis pass (`InfoResult.analysis`).
struct AnalysisStatus: Codable, Hashable, Sendable {
    var version: Int?
    var expected: Int
    var sigVersion: String?
    var pending: [String]
    var lastMs: Double?
    var alarmThresholds: AlarmThresholds
    var rules: [RuleInfo]

    var isOutdated: Bool { version != expected }

    /// The `?` tooltip for an inferred value: the rule and its hand-checked precision.
    func ruleNote(_ prov: Prov?) -> String? {
        guard let prov, let rule = prov.rule else { return prov.map { $0.words } }
        return "Inferred by rule " + (ruleDescription(rule) ?? "\(rule).")
    }

    /// "traceback@1: Python traceback in an unflagged result (precision 92% on 50 hand-checked items)."
    func ruleDescription(_ rule: String) -> String? {
        guard let info = rules.first(where: { $0.rule == rule }) else { return nil }
        let precision: String
        if info.validation == "structural" {
            precision = "\(info.basis == "logged" ? "logged" : "deterministic") observation; no empirical precision claim"
        } else if info.validation == "unvalidated" || info.advisory == true {
            precision = "unvalidated heuristic; advisory only"
        } else if info.validation == "suppressed" {
            precision = "suppressed: validation does not meet the display threshold"
        } else if let value = info.precision {
            precision = "historical local sample: precision \(Int((value * 100).rounded()))% on \(Formatters.count(info.checked ?? 0)) hand-checked items; not a general accuracy guarantee"
        } else {
            precision = "precision not yet checked"
        }
        return "\(rule): \(info.description) (\(precision))."
    }
}

/// A payload plus the envelope fields beside it in the same JSON object (LensResponse, RunReportResponse, TimeResponse).
struct Enveloped<Payload: Decodable & Hashable & Sendable>: Decodable, Hashable, Sendable {
    let scope: DerivedScope
    let analysisVersion: Int?
    /// The envelope's gaps (TimeResponse); LensResponse and RunReportResponse keep theirs in the payload.
    let gaps: [Gap]
    let payload: Payload

    private enum Keys: String, CodingKey { case scope, analysisVersion, gaps }

    init(scope: DerivedScope, analysisVersion: Int?, gaps: [Gap] = [], payload: Payload) {
        self.scope = scope
        self.analysisVersion = analysisVersion
        self.gaps = gaps
        self.payload = payload
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        scope = try c.decode(DerivedScope.self, forKey: .scope)
        analysisVersion = try c.decodeIfPresent(Int.self, forKey: .analysisVersion)
        gaps = try c.decodeIfPresent([Gap].self, forKey: .gaps) ?? []
        payload = try Payload(from: decoder)
    }
}

// MARK: - Failures summary and queue

struct FailuresSummary: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var tiers: [String: Int]
    var outcomes: [String: Int]
    var sections: [String: Int]
    var families: [String: Int]
    var episodes: Int
    var needAttention: Int
    var openAlarms: Int

    func tierCount(_ t: FailureTier) -> Int { tiers[t.rawValue] ?? 0 }
    func sectionCount(_ s: AttentionSection) -> Int { sections[s.rawValue] ?? 0 }
}

/// Per-day counts for sparklines: n[i] is the day start + i (local days).
struct DailyCounts: Codable, Hashable, Sendable {
    var start: Int64
    var n: [Int]
}

struct QueueRow: Codable, Hashable, Sendable, Identifiable {
    var kind: QueueRowKind
    var id: String
    var section: AttentionSection?
    var ts: Int64
    var sessionId: String?
    var turnId: String?
    var title: String?
    var agent: AgentKind?
    var role: String?
    var target: String?
    var signature: String?
    var signatureId: String?
    var family: FailureFamily?
    var tier: FailureTier?
    /// Episode outcome, delegation outcome, claim evidence or alarm state, by `kind`.
    var outcome: String?
    var outcomeSrc: Prov?
    var alarmKind: AlarmKind?
    var signatureStatus: SignatureStatus?
    var impact: TurnImpact?
    var attempts: Int?
    var wallUs: Int64?
    var wallSrc: Prov?
    var seenSessions: Int?
    var live: Bool
    var unattended: Bool
    var members: Int?
    var errorLine: String?
    /// Rows of kind `claim`: the sentence of the final text that claims success, and the claim pattern it matched.
    var quote: String?
    var pattern: String?
    var daily: DailyCounts?

    /// Unique within a page even when two kinds share an id (an episode and its alarm never do, but be safe).
    var rowKey: String { "\(kind.rawValue)|\(id)" }
}

struct QueuePage: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var total: Int
    var rows: [QueueRow]
}

// MARK: - Lens

/// A word diff between two inputs, or one line of a file diff.
struct DiffOp: Codable, Hashable, Sendable {
    /// `eq | add | del`.
    var op: String
    var text: String
}

struct ObservedFix: Codable, Hashable, Sendable {
    /// `edit | install | read | other`.
    var kind: String
    var pattern: String
    var n: Int
    var of: Int
    var exampleEpisode: String
    var verified: Bool
}

struct LensWhere: Codable, Hashable, Sendable {
    struct Crumb: Codable, Hashable, Sendable {
        /// `run | session | turn | step`.
        var kind: String
        var id: String
        var label: String?
    }

    /// Step k of m within its turn.
    struct StepOf: Codable, Hashable, Sendable {
        var n: Int
        var of: Int
    }

    /// The step: its session-wide number (the Steps "No." column and the attempts use it) and its place in the turn.
    /// The engine sends `{session, n, of}` (n of `of` in the turn); earlier engines sent `{n, inTurn: {n, of}}` or
    /// only the place in the turn as `{n, of}`.
    struct StepAt: Codable, Hashable, Sendable {
        var n: Int?
        var inTurn: StepOf?

        init(n: Int?, inTurn: StepOf?) {
            self.n = n
            self.inTurn = inTurn
        }

        private enum CodingKeys: String, CodingKey { case n, of, inTurn, session }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if let of = try c.decodeIfPresent(Int.self, forKey: .of), !c.contains(.inTurn) {
                self.init(n: try c.decodeIfPresent(Int.self, forKey: .session), inTurn: StepOf(n: try c.decode(Int.self, forKey: .n), of: of))
            } else {
                self.init(n: try c.decodeIfPresent(Int.self, forKey: .n), inTurn: try c.decodeIfPresent(StepOf.self, forKey: .inTurn))
            }
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(n, forKey: .session)
            try c.encodeIfPresent(inTurn?.n, forKey: .n)
            try c.encodeIfPresent(inTurn?.of, forKey: .of)
        }

        /// "step 46 · 5 of 6 in turn 6" (DESIGN.md §9); after a turn crumb, "step 46 · 5 of 6".
        func text(turn: Int? = nil, afterTurnCrumb: Bool = false) -> String {
            Formatters.stepPosition(n, inTurn: inTurn.map { ($0.n, $0.of) }, turn: turn, afterTurnCrumb: afterTurnCrumb)
        }
    }

    struct Posture: Codable, Hashable, Sendable {
        var approval: String?
        var sandbox: String?
        var permissionMode: String?
        var src: Prov?
    }

    struct Ctx: Codable, Hashable, Sendable {
        var tokens: Int?
        var window: Int?
        var windowSrc: Prov?
    }

    struct PathStep: Codable, Hashable, Sendable {
        var spanId: String
        var sessionId: String
        var outcome: DelegationOutcome?
    }

    var breadcrumb: [Crumb]
    var step: StepAt?
    var model: String?
    var posture: Posture
    var ctx: Ctx
    var delegationPath: [PathStep]
    var live: Bool
}

struct EditRef: Codable, Hashable, Sendable {
    var path: String
    var added: Int?
    var removed: Int?
    var eventId: String
}

struct CallRef: Codable, Hashable, Sendable {
    var eventId: String
    var tool: String?
    var target: String?
    var tier: FailureTier?
}

struct LensAttemptResult: Codable, Hashable, Sendable {
    var exitCode: Int?
    var exitSrc: Prov?
    var errorLine: String?
    var head: String?
    var tail: String?
    var tailAvailable: Bool
}

struct LensAttempt: Codable, Hashable, Sendable, Identifiable {
    var n: Int
    var eventId: String
    var callEventId: String?
    var ts: Int64
    var tier: FailureTier
    var step: Int?
    var gapUs: Int64?
    var gapSteps: Int?
    var input: String?
    var changeClass: ChangeClass?
    var inputDiff: [DiffOp]?
    var editsBetween: [EditRef]
    var reread: Bool
    var parallel: Bool
    var deferredPolls: Int
    var result: LensAttemptResult
    var id: Int { n }
}

struct LensEpisode: Codable, Hashable, Sendable {
    struct Signature: Codable, Hashable, Sendable {
        var id: String
        var text: String
        var family: FailureFamily
        var `class`: FailureClass
        var sigv: String
    }

    var id: String
    var targetKey: String
    var tier: FailureTier
    var signature: Signature
    var outcome: EpisodeOutcome
    var outcomeSrc: Prov
    var actor: String?
    var loop: Bool
    var blind: Bool
    var corrected: Bool
    var nAttempts: Int
    var nSteps: Int
    var wallUs: Int64?
    var wallSrc: Prov?
    var tokOut: Int?
    var tokInUpperBound: Int?
    var unattended: Bool
}

struct LensClose: Codable, Hashable, Sendable {
    struct Detail: Codable, Hashable, Sendable {
        var text: String?
        var actor: String?
        var calls: [CallRef]
        var claim: ClaimEvidence?
        var edits: [EditRef]
    }

    /// `recovered | parallel-ok | recovered-later | pivoted | interrupted | final-message | open`.
    var kind: String
    var eventId: String?
    var detail: Detail
}

struct LensSeenBefore: Codable, Hashable, Sendable {
    var sessions: Int
    /// Episodes of the signature and how many recovered, for "6 of 14 recovered (43%)"; an older engine sends only
    /// the rate.
    var episodes: Int?
    var recovered: Int?
    var recoveredRate: Double?
    var firstTs: Int64
    var lastTs: Int64
    var status: SignatureStatus
    var daily: DailyCounts
    var fixes: [ObservedFix]
    /// `environment | dependency | code | harness`.
    var advice: String?
}

struct LensRelated: Codable, Hashable, Sendable {
    /// `intervention | child-episode | parent-result | delegation`.
    var kind: String
    var id: String
    var eventId: String?
    var label: String?
    var rule: String
}

/// The Failure Lens payload (`GET /api/episodes/:id`).
struct LensPayload: Codable, Hashable, Sendable {
    struct Intent: Codable, Hashable, Sendable {
        var text: String?
        var src: Prov?
    }

    var episode: LensEpisode
    var `where`: LensWhere
    var intent: Intent
    var attempts: [LensAttempt]
    var close: LensClose
    var seenBefore: LensSeenBefore
    var related: [LensRelated]
    var gaps: [Gap]
}

struct ClaimItem: Codable, Hashable, Sendable {
    var turnId: String
    var sessionId: String
    var ts: Int64
    var evidence: ClaimEvidence
    var rule: String
    var pattern: String
    var claimExcerpt: String?
    var finalEventId: String
    var testEventId: String?
    var lastEditEventId: String?
}

struct ClaimLens: Codable, Hashable, Sendable {
    struct Evidence: Codable, Hashable, Sendable {
        /// `test | edit`.
        var kind: String
        var eventId: String
        var ts: Int64
        var step: Int?
        var target: String?
        var tier: FailureTier?
        var exitCode: Int?
        var exitSrc: Prov?
        var path: String?
        var added: Int?
        var removed: Int?
        var earlier: Bool
    }

    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var claim: ClaimItem
    var `where`: LensWhere
    var finalText: String?
    var evidence: [Evidence]
}

struct DelegationItem: Codable, Hashable, Sendable {
    var id: String
    var sessionId: String
    var parentTurn: String?
    var parentStep: String?
    var childSession: String?
    var kind: String
    var taskExcerpt: String?
    var outcome: DelegationOutcome
    var outcomeSrc: Prov?
    var childImpact: TurnImpact?
    var parentTold: Bool?
    var silent: Bool
    var tokInTree: Int?
    var tokOutTree: Int?
    var parentWaitUs: Int64?
    var startTs: Int64
    var endTs: Int64?
    var childTitle: String?
    var childAgent: AgentKind?
    var childRole: String?
    var resultEventId: String?
}

struct DelegationLens: Codable, Hashable, Sendable {
    struct Child: Codable, Hashable, Sendable {
        var impact: TurnImpact?
        var steps: Int
        var episodes: [QueueRow]
        var finalText: String?
    }

    struct ParentSaw: Codable, Hashable, Sendable {
        var eventId: String
        var text: String?
        var flagged: Bool
        var told: Bool?
        var rule: String
    }

    struct ParentNext: Codable, Hashable, Sendable {
        var stepId: String
        var n: Int
        var calls: [CallRef]
    }

    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var delegation: DelegationItem
    var `where`: LensWhere
    var task: String?
    var child: Child
    var parentSaw: ParentSaw?
    var parentNext: ParentNext?
}

struct Redaction: Codable, Hashable, Sendable {
    var `class`: String
    var count: Int
}

struct EpisodeReport: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    /// `md | brief | json`.
    var format: String
    var text: String
    var redactions: [Redaction]
}

// MARK: - Diffs

struct DiffHunk: Codable, Hashable, Sendable {
    var oldStart: Int?
    var newStart: Int?
    var lines: [DiffOp]
}

struct FileDiff: Codable, Hashable, Sendable {
    var path: String
    var op: ChangeOp
    var src: Prov
    var added: Int?
    var removed: Int?
    var hunks: [DiffHunk]?
    var newOnly: Bool
    var truncated: Bool
    var reason: String?
}

struct ChangeDiff: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var eventId: String
    var files: [FileDiff]
}

// MARK: - Signatures

struct SignatureItem: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var text: String
    var family: FailureFamily
    var `class`: FailureClass
    var n: Int
    var sessions: Int
    var unrecoveredRate: Double?
    var wallLostUs: Int64
    var firstTs: Int64
    var lastTs: Int64
    var status: SignatureStatus
    var agents: [AgentKind]
    var rank: Double
    var daily: DailyCounts
}

struct SignatureList: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var total: Int
    var rows: [SignatureItem]
}

struct SignatureDay: Codable, Hashable, Sendable {
    var d: String
    var n: Int
    var activeSessions: Int
}

struct SignatureExample: Codable, Hashable, Sendable {
    var episodeId: String
    var sessionId: String
    var agent: AgentKind
    var ts: Int64
    var outcome: EpisodeOutcome
    var errorLine: String?
}

struct SignatureSplitSide: Codable, Hashable, Sendable {
    var days: Int
    var n: Int
    var sessions: Int
    var activeSessions: Int
    var perActiveSession: Double?
}

struct SignatureSplit: Codable, Hashable, Sendable {
    var at: Int64
    var before: SignatureSplitSide
    var after: SignatureSplitSide
}

/// `GET /api/signatures/:id`: the SignatureItem fields plus days, examples, fixes and the split.
struct SignatureDetail: Decodable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var item: SignatureItem
    var days: [SignatureDay]
    var examples: [SignatureExample]
    var fixes: [ObservedFix]
    var split: SignatureSplit?

    private enum Keys: String, CodingKey { case scope, analysisVersion, gaps, days, examples, fixes, split }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        scope = try c.decode(DerivedScope.self, forKey: .scope)
        analysisVersion = try c.decodeIfPresent(Int.self, forKey: .analysisVersion)
        gaps = try c.decodeIfPresent([Gap].self, forKey: .gaps) ?? []
        item = try SignatureItem(from: decoder)
        days = try c.decodeIfPresent([SignatureDay].self, forKey: .days) ?? []
        examples = try c.decodeIfPresent([SignatureExample].self, forKey: .examples) ?? []
        fixes = try c.decodeIfPresent([ObservedFix].self, forKey: .fixes) ?? []
        split = try c.decodeIfPresent(SignatureSplit.self, forKey: .split)
    }
}

// MARK: - Session steps

struct TimeBucket: Codable, Hashable, Sendable {
    var name: TimeBucketName
    var us: Int64
    var loggedUs: Int64
    var derivedUs: Int64
}

struct TimeBreakdown: Codable, Hashable, Sendable {
    var wallUs: Int64?
    var buckets: [TimeBucket]
    var unattributedUs: Int64?
    var humanGapUs: Int64?
    var continuationUs: Int64?
}

struct StepTurn: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var n: Int
    var origin: String?
    var promptExcerpt: String?
    var startTs: Int64
    var endTs: Int64?
    var open: Bool
    var wallUs: Int64?
    var wallSrc: Prov?
    var impact: TurnImpact
    var impactBasis: String?
    var claim: ClaimEvidence?
    var unattended: Bool
    var buckets: [TimeBucket]
    var unattributedUs: Int64?
    var nSteps: Int
    var nEpisodes: Int
    var matchedSteps: Int?
}

struct StepCall: Codable, Hashable, Sendable {
    var eventId: String
    var resultEventId: String?
    var tool: String?
    var toolKind: String?
    var target: String?
    var tier: FailureTier?
    var episodeId: String?
    var durUs: Int64?
    var durSrc: Prov?
    var processId: String?
    var childSessionId: String?
    var childOutcome: DelegationOutcome?
    var childOutcomeSrc: Prov?
    var parentTold: Bool?
    var match: Bool?
}

struct StepItem: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var n: Int
    var sessionId: String
    var turnId: String?
    var startTs: Int64
    var endTs: Int64?
    var durUs: Int64?
    var modelUs: Int64?
    var modelSrc: Prov?
    var toolUs: Int64?
    var intent: String?
    var intentSrc: Prov?
    var ctxTokens: Int?
    var ctxWindow: Int?
    var ctxWindowSrc: Prov?
    var tokIn: Int?
    var tokOut: Int?
    var compactionBefore: Bool
    /// Injected `context.attachment` types and counts (the Context lane); null until derived.
    var attachments: [String: Int]?
    var episodeIds: [String]
    var calls: [StepCall]
    var match: Bool?

    /// Model plus tool time, at most the wall time (the engine's StepItem.activeUs); nil when neither is known.
    var activeUs: Int64?
    /// Wall time minus active time (the engine's StepItem.gapUs): waiting on a person, a process or nothing logged;
    /// nil when either is unknown. No client computes it (DESIGN.md §7.8).
    var gapUs: Int64?
}

struct StepsPage: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var turns: [StepTurn]
    var steps: [StepItem]
    var total: Int
    var matched: Int?
    var next: String?
}

// MARK: - Run report

struct AlarmItem: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var turnId: String
    var kind: AlarmKind
    var rule: String
    var firstTs: Int64
    var lastTs: Int64
    var episodeId: String?
    var delegationId: String?
    var notify: Bool
    var clearedTs: Int64?
    var state: AlarmState
}

struct RunReport: Codable, Hashable, Sendable {
    struct Run: Codable, Hashable, Sendable {
        var root: String
        var session: String
        var agent: AgentKind
        var title: String?
        var start: Int64?
        var end: Int64?
        /// `finished | possibly-running`.
        var status: String
        var unattended: Bool
        var isLive: Bool { status == "possibly-running" }
    }

    struct Turns: Codable, Hashable, Sendable {
        var total: Int
        var byOrigin: [String: Int]
    }

    struct Steps: Codable, Hashable, Sendable {
        var total: Int
        var withFailure: Int
    }

    struct SignatureRef: Codable, Hashable, Sendable {
        var id: String
        var text: String
        var family: FailureFamily
        var n: Int
        var sessions: Int
        var status: SignatureStatus
    }

    struct Delegations: Codable, Hashable, Sendable {
        var total: Int
        var silent: Int
        var byOutcome: [String: Int]
    }

    struct Claims: Codable, Hashable, Sendable {
        var byEvidence: [String: Int]
        var unverified: Int
    }

    struct Context: Codable, Hashable, Sendable {
        var peakTokens: Int?
        var window: Int?
        var windowSrc: Prov?
        var compactions: Int
    }

    struct Changes: Codable, Hashable, Sendable {
        var files: Int
        var added: Int
        var removed: Int
        var shellMentions: Int
    }

    struct Stall: Codable, Hashable, Sendable {
        var turnOpen: Bool
        var stalledForS: Double?
    }

    var run: Run
    var since: Int64?
    var turns: Turns
    var steps: Steps
    var impact: [String: Int]
    var attention: [QueueRow]
    var signatures: [SignatureRef]
    var delegations: Delegations
    var claims: Claims
    var interventions: [String: Int]
    var time: TimeBreakdown
    var context: Context
    var changes: Changes
    var alarms: [AlarmItem]
    var stall: Stall
    var gaps: [Gap]
    var indexAgeS: Double?
}

// MARK: - Rows

struct InterventionItem: Codable, Hashable, Sendable {
    var sessionId: String
    var turnId: String?
    var stepId: String?
    var ts: Int64
    var kind: InterventionKind
    var actor: String
    var actorSrc: Prov
    var waitUs: Int64?
    var nearEpisode: String?
    var excerpt: String?
    var eventId: String
}

struct EpisodeItem: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var rootId: String
    var turnId: String?
    var targetKey: String
    var sigId: String
    var family: FailureFamily
    var tier: FailureTier
    var nAttempts: Int
    var firstStep: String?
    var lastStep: String?
    var nSteps: Int
    var startTs: Int64
    var endTs: Int64
    var wallUs: Int64?
    var wallSrc: Prov?
    var outcome: EpisodeOutcome
    var outcomeSrc: Prov
    var loop: Bool
    var blind: Bool
    var unattended: Bool
    var section: EpisodeSection
    var openerEventId: String
    var lastEventId: String
    var closerEventId: String?
}

struct ProcessItem: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var procKey: String
    var program: String?
    var nPolls: Int
    var nInputs: Int
    var exitCode: Int?
    var exitSrc: Prov?
    var status: String
    var startTs: Int64
    var endTs: Int64?
    var openEventId: String
    var closeEventId: String?
}

struct RowsPage<Row: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var total: Int
    var rows: [Row]
}

// MARK: - Events and sidebar

/// `GET /api/events/:id/derived`: the Step and Failure layers of the Events detail tree.
struct EventDerived: Codable, Hashable, Sendable {
    struct Step: Codable, Hashable, Sendable {
        var id: String
        var n: Int
        var turnId: String?
        var inTurn: LensWhere.StepOf?
        var segSrc: Prov
    }

    struct Failure: Codable, Hashable, Sendable {
        var tier: FailureTier
        var source: FailureSource
        var rule: String
        var family: FailureFamily
        var `class`: FailureClass
        var signatureId: String
        var signature: String
        var targetKey: String
        var exitCode: Int?
        var exitSrc: Prov?
        var errorLine: String?
        var episodeId: String?
        var attempt: Int?
        var note: String
    }

    struct Episode: Codable, Hashable, Sendable {
        var id: String
        /// `attempt | call | closer`.
        var role: String
        var outcome: EpisodeOutcome
        var outcomeSrc: Prov
        var nAttempts: Int
        var section: EpisodeSection
    }

    struct Process: Codable, Hashable, Sendable {
        var id: String
        var role: String
        var status: String
        var exitCode: Int?
        var exitSrc: Prov?
        var closeEventId: String?
        var closeStep: Int?
    }

    struct Delegation: Codable, Hashable, Sendable {
        var id: String
        var childSessionId: String?
        var outcome: DelegationOutcome
        var outcomeSrc: Prov?
        var silent: Bool
    }

    struct Change: Codable, Hashable, Sendable {
        var path: String
        var op: ChangeOp
        var src: Prov
        var added: Int?
        var removed: Int?
        var outsideCwd: Bool
        var diffAvailable: Bool
    }

    struct Intervention: Codable, Hashable, Sendable {
        var kind: InterventionKind
        var actor: String
        var actorSrc: Prov
    }

    struct Claim: Codable, Hashable, Sendable {
        var turnId: String
        var evidence: ClaimEvidence
        var rule: String
    }

    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var eventId: String
    var step: Step?
    var failure: Failure?
    var episode: Episode?
    var process: Process?
    var delegation: Delegation?
    var changes: [Change]
    var intervention: Intervention?
    var claim: Claim?
}

struct SessionMark: Codable, Hashable, Sendable {
    var sessionId: String
    var rootId: String
    var worstImpact: TurnImpact?
    var worstTurn: String?
    var silentChildren: Int
    var firingAlarms: Int
    var needAttention: Int
    var possiblyRunning: Bool
}

struct SessionMarks: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var rows: [SessionMark]
}

// MARK: - Follow

/// The stream a Follow panel shows (SPEC §12.7).
enum FollowTarget: Codable, Hashable, Sendable {
    case call(eventId: String)
    case delegation(spanId: String)
    case process(id: String)
    case file(session: String, path: String)

    var title: String {
        switch self {
        case .call: return "Follow Tool Call"
        case .delegation: return "Follow Delegation"
        case .process: return "Follow Process"
        case .file: return "Follow File"
        }
    }
}

struct FollowSubject: Codable, Hashable, Sendable {
    var tool: String?
    var target: String?
    var tier: FailureTier?
    var childSessionId: String?
    var outcome: DelegationOutcome?
    var outcomeSrc: Prov?
    var parentTold: Bool?
    var silent: Bool?
    var program: String?
    var status: String?
    var exitCode: Int?
    var exitSrc: Prov?
    var nPolls: Int?
    var nInputs: Int?
    var path: String?
    var reads: Int?
    var edits: Int?
    var shellMentions: Int?
}

struct FollowItem: Codable, Hashable, Sendable {
    var eventId: String?
    var ts: Int64?
    var role: String
    var excerpt: String?
    var head: String?
    var tail: String?
    var diffAvailable: Bool
    var reason: String?
    var sessionId: String?
    var stepId: String?
    var path: String?
    var added: Int?
    var removed: Int?
    var exitCode: Int?
    var exitSrc: Prov?
    var tier: FailureTier?
    var episodeId: String?
    var betweenAttempts: Bool?
}

struct FollowPage: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    /// `call | delegation | process | file`.
    var kind: String
    var subject: FollowSubject
    var items: [FollowItem]
    var next: String?
}

// MARK: - Statistics

struct SrtRow: Codable, Hashable, Sendable, Identifiable {
    var key: String
    var calls: Int
    var durKnown: Int
    var p50: Int64?
    var p90: Int64?
    var p99: Int64?
    var max: Int64?
    var total: Int64
    var durSrcMix: [String: Int]
    var failures: [String: Int]
    var agents: [AgentKind]
    var id: String { key }
}

struct SrtResponse: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var group: String
    var rows: [SrtRow]
}

struct EndpointRow: Codable, Hashable, Sendable {
    var kind: String
    var endpoint: String
    var calls: Int
    var sessions: Int
    var failures: [String: Int]
    var durKnown: Int
    var p50: Int64?
    var p90: Int64?
    var p99: Int64?
    var firstTs: Int64?
    var lastTs: Int64?
}

struct EndpointsResponse: Codable, Hashable, Sendable {
    var scope: DerivedScope
    var analysisVersion: Int?
    var gaps: [Gap]
    var rows: [EndpointRow]
}

// MARK: - Stream

/// SSE `alarm`: an alarm fired or cleared in the last index run.
struct AlarmStreamEvent: Codable, Hashable, Sendable {
    var id: String
    var kind: AlarmKind
    var sessionId: String
    var turnId: String
    var episodeId: String?
    var delegationId: String?
    /// `firing | cleared`.
    var state: AlarmState
    var notify: Bool
}

/// `index-done` gains `analysis`.
struct IndexDoneAnalysis: Codable, Hashable, Sendable {
    var ms: Double
    var pending: Int
}
