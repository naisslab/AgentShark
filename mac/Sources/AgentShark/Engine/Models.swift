import Foundation

// Codable mirrors of the engine's JSON (src/model/types.ts, src/index/api.ts, docs/MAC-CONTRACT.md §2.1).
// Property names equal the JSON keys. Times are Int64 µs since the epoch; durations are Int64 µs.

// MARK: - String kinds that tolerate unknown values

/// A string enum that decodes any value, so new engine values never fail decoding.
protocol StringKind: RawRepresentable, Codable, Hashable, Sendable, Comparable, ExpressibleByStringLiteral,
    CustomStringConvertible where RawValue == String {
    init(rawValue: String)
}

extension StringKind {
    init(stringLiteral value: String) { self.init(rawValue: value) }
    var description: String { rawValue }
    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
}

struct AgentKind: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let claudeCode: AgentKind = "claude-code"
    static let claudeCowork: AgentKind = "claude-cowork"
    static let codex: AgentKind = "codex"
    static let copilot: AgentKind = "copilot"
    static let antigravity: AgentKind = "antigravity"
    static let known: [AgentKind] = [.claudeCode, .claudeCowork, .codex, .copilot, .antigravity]

    var label: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .claudeCowork: return "Claude Cowork"
        case .codex: return "Codex"
        case .copilot: return "Copilot"
        case .antigravity: return "Antigravity"
        default: return rawValue
        }
    }

    /// Session ID prefix (`cc`, `cw`, `cx`, `cp`, `ag`).
    var prefix: String {
        switch self {
        case .claudeCode: return "cc"
        case .claudeCowork: return "cw"
        case .codex: return "cx"
        case .copilot: return "cp"
        case .antigravity: return "ag"
        default: return rawValue
        }
    }
}

struct EventKind: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    /// The first level of the taxonomy (`tool` for `tool.call`).
    var layer: String { rawValue.split(separator: ".", maxSplits: 1).first.map(String.init) ?? rawValue }

    static let sessionMeta: EventKind = "session.meta"
    static let sessionState: EventKind = "session.state"
    static let userPrompt: EventKind = "user.prompt"
    static let userInject: EventKind = "user.inject"
    static let llmText: EventKind = "llm.text"
    static let llmThinking: EventKind = "llm.thinking"
    static let llmUsage: EventKind = "llm.usage"
    static let llmError: EventKind = "llm.error"
    static let llmRefusal: EventKind = "llm.refusal"
    static let toolCall: EventKind = "tool.call"
    static let toolResult: EventKind = "tool.result"
    static let toolExec: EventKind = "tool.exec"
    static let agentSpawn: EventKind = "agent.spawn"
    static let agentMessage: EventKind = "agent.message"
    static let agentStatus: EventKind = "agent.status"
    static let contextAttachment: EventKind = "context.attachment"
    static let contextCompaction: EventKind = "context.compaction"
    static let contextSnapshot: EventKind = "context.snapshot"
    static let turnStart: EventKind = "turn.start"
    static let turnEnd: EventKind = "turn.end"
    static let turnAbort: EventKind = "turn.abort"
    static let hookRun: EventKind = "hook.run"
    static let permissionRequest: EventKind = "permission.request"
    static let permissionDecision: EventKind = "permission.decision"
    static let harnessQueue: EventKind = "harness.queue"
    static let harnessRatelimit: EventKind = "harness.ratelimit"
    static let harnessStatus: EventKind = "harness.status"
    static let harnessFile: EventKind = "harness.file"
    static let harnessVcs: EventKind = "harness.vcs"
    static let harnessOther: EventKind = "harness.other"
    static let rawUnknown: EventKind = "raw.unknown"

    static let layers = ["session", "user", "llm", "tool", "agent", "context", "turn", "hook", "permission", "harness", "raw"]
}

struct SpanKind: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let session: SpanKind = "session"
    static let turn: SpanKind = "turn"
    static let llm: SpanKind = "llm"
    static let tool: SpanKind = "tool"
    static let exec: SpanKind = "exec"
    static let workflow: SpanKind = "workflow"
    static let phase: SpanKind = "phase"
    static let compaction: SpanKind = "compaction"
    static let hook: SpanKind = "hook"
    static let retry: SpanKind = "retry"
    static let permission: SpanKind = "permission"
}

struct SpanStatus: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let ok: SpanStatus = "ok"
    static let error: SpanStatus = "error"
    static let cancelled: SpanStatus = "cancelled"
    static let interrupted: SpanStatus = "interrupted"
    static let open: SpanStatus = "open"
    static let unknown: SpanStatus = "unknown"
}

/// Who produced an event (`user`, `assistant`, `tool`, `system`, `harness`, `agent`).
/// Note: this module-level type shadows the standard library's `Actor` protocol inside AgentShark.
struct Actor: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let user: Actor = "user"
    static let assistant: Actor = "assistant"
    static let tool: Actor = "tool"
    static let system: Actor = "system"
    static let harness: Actor = "harness"
    static let agent: Actor = "agent"
}

// MARK: - Rows

struct TokenUsage: Codable, Hashable, Sendable {
    var input: Int?
    var uncached: Int?
    var cache_read: Int?
    var cache_write: Int?
    var output: Int?
    var reasoning: Int?
    var total: Int?
    var context_window: Int?
}

struct EventRow: Codable, Hashable, Sendable, Identifiable {
    /// 1-based view row number when the row comes from a view.
    var no: Int?
    var id: String
    var rid: Int64
    var session: String
    var agent: AgentKind
    var ts: Int64
    var tsSrc: String
    var seq: Int
    var kind: EventKind
    var proto: String
    var actor: Actor
    var summary: String
    var span: String?
    var turn: String?
    var toolName: String?
    var model: String?
    var dur: Int64?
    var tokIn: Int?
    var tokOut: Int?
    var flags: [String]
    /// First matching coloring rule id (MAC-CONTRACT §3).
    var colorRule: String?
    /// Values of custom columns requested with `columns=`.
    var extra: [String: JSONValue]?

    func hasFlag(_ flag: String) -> Bool { flags.contains(flag) }
    var isError: Bool { hasFlag("error") }
    /// Inherited context or a duplicate record: shown dimmed.
    var isDimmed: Bool { hasFlag("inherited") || hasFlag("dup") }
}

struct SessionRow: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var agent: AgentKind
    var nativeId: String
    var role: String
    var state: String
    var parentId: String?
    var parentSpanId: String?
    var rootId: String
    var title: String?
    var cwd: String?
    var project: String?
    var gitBranch: String?
    var models: [String]
    var version: String?
    var originator: String?
    var entrypoint: String?
    var start: Int64?
    var end: Int64?
    var nEvents: Int
    var nLlm: Int
    var nTools: Int
    var nTurns: Int
    var nErrors: Int
    var nChildren: Int
    var tokens: TokenUsage
    var costUsd: Double?

    /// The title, or the native ID cut in the middle (DESIGN.md §3.5) when the session has none: "cx:0190a0…0001". UUIDv7
    /// and ULID ids share their leading characters within a day, so the last four tell two untitled sessions apart.
    var displayTitle: String {
        if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return t }
        return "\(agent.prefix):\(Formatters.middleEllipsis(nativeId))"
    }

    /// `missing-transcript` or `source-deleted`: the transcript is gone.
    var isMissingSource: Bool { state != "ok" }
    var isSubsession: Bool { parentId != nil }
    var lastActivity: Int64? { end ?? start }
}

struct SpanRow: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var session: String
    var kind: SpanKind
    var name: String
    var parent: String?
    var start: Int64
    var end: Int64?
    var dur: Int64?
    var durSrc: String
    var status: SpanStatus
    var linkSession: String?
    var firstEvent: String?
    var lastEvent: String?
    var depth: Int
    var attrs: JSONValue?
}

// MARK: - Index and filter

struct InfoResult: Codable, Hashable, Sendable {
    struct Counts: Codable, Hashable, Sendable {
        var sources: Int
        var sessions: Int
        var events: Int
        var spans: Int
        var expert: Int?
    }

    struct Indexing: Codable, Hashable, Sendable {
        var running: Bool
        var done: Int
        var total: Int
        var currentPath: String?
        /// µs. During a staged run, every changed file written after it is indexed (SPEC §5.1).
        var since: Int64?
        var lastRunAt: Int64?
        var lastRunMs: Int?
    }

    /// Capture provenance (SPEC §7.8): the header, stream completeness and the coverage report.
    struct Capture: Codable, Hashable, Sendable {
        var path: String?
        var header: JSONValue?
        /// When the capture was written (µs).
        var createdAt: Int64?
        var complete: Bool?
        /// `{rawUnavailable, rawUnavailableBySource, rawOmitted, sidecarsOmitted: [{path, role, reason}], known}`.
        var coverage: JSONValue?
        /// When this engine loaded the capture (µs).
        var loadedAt: Int64?
        var integrity: JSONValue?
        var analysis: JSONValue?

        /// Integrity, replay settings, and redaction are independent of stream completeness.
        var evidenceNotes: [String] {
            var notes: [String] = []
            switch integrity?["status"]?.stringValue {
            case "verified": notes.append("Integrity verified: the embedded checksums match. This does not establish the author's identity or the truth of the trace.")
            case "failed": notes.append("Integrity failed: some capture bytes do not match their checksums. Recovered records are incomplete evidence.")
            default: notes.append("Integrity unverified: this capture has no verified checksum record.")
            }
            switch analysis?["mode"]?.stringValue {
            case "recorded": notes.append("Analysis mode: recorded settings and fixed capture clock.")
            case "current": notes.append("Analysis mode: reanalyzed with the current engine; results can differ from the recorded analysis.")
            default: notes.append("Analysis mode was not reported by this engine.")
            }
            if let reason = analysis?["reason"]?.stringValue { notes.append(reason) }
            if analysis?["original"]?["evidence"]?.stringValue == "redacted"
                || header?["analysis"]?["evidence"]?.stringValue == "redacted" {
                notes.append("Redacted capture: free text, raw lines and side files were removed. Use the original forensic capture when exact source evidence is required.")
            }
            return notes
        }
    }

    /// The refresh policy: whether the engine re-indexes when source files change.
    struct Watch: Codable, Hashable, Sendable {
        var enabled: Bool
        var intervalMs: Int?
    }

    /// One writer per index: this engine indexes (`writer`), or it serves what another live process indexes
    /// (`follower`, with that writer's pid). The engine decides at startup.
    struct Indexer: Codable, Hashable, Sendable {
        var role: String?
        var writerPid: Int?
    }

    var version: String
    var mode: String
    var indexPath: String
    var capturePath: String?
    var counts: Counts
    var firstTs: Int64?
    var lastTs: Int64?
    var indexing: Indexing
    /// Absent from older engines, which always watch under the app.
    var watch: Watch?
    /// End of the last index run that succeeded (µs), and the error of the last run when it failed.
    var lastIndexOkAt: Int64?
    var lastIndexError: String?
    /// End of the last index run that changed data (µs).
    var lastChangeAt: Int64?
    var capture: Capture?
    /// Schema 4: state of the analysis pass (SPEC §12.3.1). Absent from engines that predate it.
    var analysis: AnalysisStatus?
    /// The writer lock's role, nested or at the top level. Absent from engines that predate it (they always index).
    var indexer: Indexer?
    var role: String?
    var writerPid: Int?

    var isCapture: Bool { mode == "capture" }
    var watching: Bool? { watch?.enabled }
    /// This engine follows another writer of the index: it does not index, and reports that writer's pid when known.
    var isFollower: Bool { (indexer?.role ?? role) == "follower" }
    var followedWriterPid: Int? { isFollower ? indexer?.writerPid ?? writerPid : nil }
}

struct FieldInfo: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var type: String
    var description: String
    var values: [String]?
    var id: String { name }
}

struct FilterCheck: Codable, Hashable, Sendable {
    struct Problem: Codable, Hashable, Sendable {
        var message: String
        var start: Int
        var end: Int
    }

    var ok: Bool
    var error: Problem?
    var warning: String?

    static let valid = FilterCheck(ok: true, error: nil, warning: nil)
}

// MARK: - Sessions

struct SessionList: Codable, Hashable, Sendable {
    var total: Int
    var sessions: [SessionRow]
}

struct SessionDetail: Codable, Hashable, Sendable {
    /// `SessionRow & {meta, enriched}`; SessionRow fields are reachable directly (`detail.session.title`).
    @dynamicMemberLookup
    struct Session: Codable, Hashable, Sendable {
        var row: SessionRow
        var meta: JSONValue?
        var enriched: JSONValue?

        subscript<T>(dynamicMember keyPath: KeyPath<SessionRow, T>) -> T { row[keyPath: keyPath] }

        private enum Keys: String, CodingKey { case meta, enriched }

        init(row: SessionRow, meta: JSONValue? = nil, enriched: JSONValue? = nil) {
            self.row = row
            self.meta = meta
            self.enriched = enriched
        }

        init(from decoder: Decoder) throws {
            row = try SessionRow(from: decoder)
            let c = try decoder.container(keyedBy: Keys.self)
            meta = try c.decodeIfPresent(JSONValue.self, forKey: .meta)
            enriched = try c.decodeIfPresent(JSONValue.self, forKey: .enriched)
        }

        func encode(to encoder: Encoder) throws {
            try row.encode(to: encoder)
            var c = encoder.container(keyedBy: Keys.self)
            try c.encodeIfPresent(meta, forKey: .meta)
            try c.encodeIfPresent(enriched, forKey: .enriched)
        }
    }

    struct Source: Codable, Hashable, Sendable, Identifiable {
        var id: String
        var path: String
        var kind: String
    }

    var session: Session
    var children: [SessionRow]
    var turns: [SpanRow]
    var sources: [Source]
}

// MARK: - Views and events

struct ColorRuleSpec: Codable, Hashable, Sendable {
    var id: String
    var filter: String
}

struct ViewSpec: Codable, Hashable, Sendable {
    var filter: String?
    var sessions: [String]?
    /// Include descendants (subagents) of the listed sessions. The engine defaults to true.
    var descendants: Bool?
    var from: Int64?
    var to: Int64?
    /// `ts | seq | dur | tokIn | tokOut | kind | tool | session`.
    var sort: String?
    /// `asc | desc`.
    var order: String?
    var includeInherited: Bool?
    var includeDup: Bool?
    var colorRules: [ColorRuleSpec]?

    init(filter: String? = nil, sessions: [String]? = nil, descendants: Bool? = nil, from: Int64? = nil, to: Int64? = nil,
         sort: String? = nil, order: String? = nil, includeInherited: Bool? = nil, includeDup: Bool? = nil,
         colorRules: [ColorRuleSpec]? = nil) {
        self.filter = filter
        self.sessions = sessions
        self.descendants = descendants
        self.from = from
        self.to = to
        self.sort = sort
        self.order = order
        self.includeInherited = includeInherited
        self.includeDup = includeDup
        self.colorRules = colorRules
    }
}

struct ViewInfo: Codable, Hashable, Sendable {
    var viewId: String
    var count: Int
    var firstTs: Int64?
    var lastTs: Int64?
}

struct Histogram: Codable, Hashable, Sendable {
    struct Bin: Codable, Hashable, Sendable {
        var count: Int
        var errors: Int
        var tokens: Int
    }

    var from: Int64
    var to: Int64
    var binUs: Int64
    var bins: [Bin]
}

/// `{field, value}`: how a detail node maps to a filter expression (MAC-CONTRACT §3.5).
struct FieldRef: Codable, Hashable, Sendable {
    var field: String
    var value: JSONValue
}

struct EventDetail: Codable, Hashable, Sendable {
    /// Pointer from the event to its source bytes.
    struct RawRef: Codable, Hashable, Sendable {
        var source: String
        var path: String?
        var line: Int
        var offset: Int64
        var length: Int
        var block: Int?
    }

    /// `EventRow & {attrs, native, raw}`; EventRow fields are reachable directly (`detail.event.kind`).
    @dynamicMemberLookup
    struct Event: Codable, Hashable, Sendable {
        var row: EventRow
        /// Normalized attributes in engine order.
        var attrs: JSONValue
        /// Compact copy of the source record, in source order.
        var native: JSONValue?
        var raw: RawRef

        subscript<T>(dynamicMember keyPath: KeyPath<EventRow, T>) -> T { row[keyPath: keyPath] }

        private enum Keys: String, CodingKey { case attrs, native, raw }

        init(row: EventRow, attrs: JSONValue, native: JSONValue?, raw: RawRef) {
            self.row = row
            self.attrs = attrs
            self.native = native
            self.raw = raw
        }

        init(from decoder: Decoder) throws {
            row = try EventRow(from: decoder)
            let c = try decoder.container(keyedBy: Keys.self)
            attrs = try c.decodeIfPresent(JSONValue.self, forKey: .attrs) ?? .object([:])
            native = try c.decodeIfPresent(JSONValue.self, forKey: .native)
            raw = try c.decode(RawRef.self, forKey: .raw)
        }

        func encode(to encoder: Encoder) throws {
            try row.encode(to: encoder)
            var c = encoder.container(keyedBy: Keys.self)
            try c.encode(attrs, forKey: .attrs)
            try c.encodeIfPresent(native, forKey: .native)
            try c.encode(raw, forKey: .raw)
        }
    }

    var event: Event
    var span: SpanRow?
    /// Ancestors of `span`, outermost first (session → turn → …).
    var spanChain: [SpanRow]
    /// Partner events: call ↔ result, other blocks of the same llm span, nested exec items.
    var related: [EventRow]
    var session: SessionRow?
    /// JSON pointer into `{"event": …, "attrs": …, "native": …}` → filter field and value.
    var fieldMap: [String: FieldRef]?

    /// The composite document that `fieldMap` pointers and the detail tree address:
    /// `{"event": {...EventRow}, "attrs": {...}, "native": {...}}`.
    var compositeDocument: JSONValue {
        .object(["event": .object(event.row.jsonObject), "attrs": event.attrs, "native": event.native ?? .null])
    }
}

extension EventRow {
    /// The row as an ordered JSON object, in the engine's key order.
    var jsonObject: JSONObject {
        func num<T: BinaryInteger>(_ v: T?) -> JSONValue { v.map { .number(Double($0)) } ?? .null }
        func str(_ v: String?) -> JSONValue { v.map(JSONValue.string) ?? .null }
        var o: JSONObject = [
            "no": num(no), "id": .string(id), "rid": num(rid), "session": .string(session), "agent": .string(agent.rawValue),
            "ts": num(ts), "tsSrc": .string(tsSrc), "seq": num(seq), "kind": .string(kind.rawValue), "proto": .string(proto),
            "actor": .string(actor.rawValue), "summary": .string(summary), "span": str(span), "turn": str(turn),
            "toolName": str(toolName), "model": str(model), "dur": num(dur), "tokIn": num(tokIn), "tokOut": num(tokOut),
            "flags": .array(flags.map(JSONValue.string)),
        ]
        if let colorRule { o["colorRule"] = .string(colorRule) }
        if let extra { o["extra"] = .object(JSONObject(extra)) }
        return o
    }
}

struct RawResult: Codable, Hashable, Sendable {
    struct Source: Codable, Hashable, Sendable {
        var id: String
        var path: String?
        var line: Int
        var offset: Int64
        var length: Int
    }

    var available: Bool
    /// Why raw bytes are unavailable (file deleted, changed since indexing, …).
    var reason: String?
    var source: Source
    /// The source line; long strings end in `…[+N chars]`.
    var text: String
    var truncated: Bool
    /// JSON Pointer into the source record → [start, end) UTF-16 offsets into `text`.
    var ranges: [String: [Int]]

    /// Range of a pointer into the source record ("" is the whole record).
    func range(for pointer: String) -> NSRange? {
        guard let r = ranges[pointer], r.count == 2, r[1] >= r[0] else { return nil }
        return NSRange(location: r[0], length: r[1] - r[0])
    }

    /// Range for a detail-tree pointer in the composite space (`/native/...`); nil for other layers.
    func range(forCompositePointer pointer: String) -> NSRange? {
        if pointer == "/native" { return range(for: "") }
        guard pointer.hasPrefix("/native/") else { return nil }
        return range(for: String(pointer.dropFirst("/native".count)))
    }

    /// The innermost pointer whose range contains `location`, for raw → detail selection.
    func pointer(containing location: Int) -> String? {
        var best: (String, Int)?
        for (p, r) in ranges where r.count == 2 && r[0] <= location && location < max(r[1], r[0] + 1) {
            let width = r[1] - r[0]
            if best == nil || width < best!.1 { best = (p, width) }
        }
        return best?.0
    }
}

// MARK: - Spans

struct SpanList: Codable, Hashable, Sendable {
    var spans: [SpanRow]
    var truncated: Bool
}

struct SpanDetail: Codable, Hashable, Sendable {
    var span: SpanRow
    var events: [EventRow]
    var children: [SpanRow]
}

struct OverviewSession: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var agent: AgentKind
    var role: String
    var parentId: String?
    var title: String?
    var project: String?
    var start: Int64?
    var end: Int64?
    var nEvents: Int
    var nErrors: Int
    var tokOut: Int
}

// MARK: - Conversation

struct ConversationItem: Codable, Hashable, Sendable, Identifiable {
    struct Tool: Codable, Hashable, Sendable {
        var name: String
        var kind: String?
        var inputSummary: String?
        var input: JSONValue?
        var output: String?
        var outputLen: Int?
        var isError: Bool?
        var exitCode: Int?
        var dur: Int64?
        var resultEvent: String?
    }

    struct Subagent: Codable, Hashable, Sendable {
        var session: String
        var title: String?
        var type: String?
    }

    struct LLM: Codable, Hashable, Sendable {
        var model: String?
        var tokens: TokenUsage?
    }

    /// `prompt | inject | text | thinking | tool | subagent | compaction | error | turn-end | status`.
    var type: String
    var event: String
    var ts: Int64
    var text: String?
    var textLen: Int?
    var tool: Tool?
    var subagent: Subagent?
    var llm: LLM?
    var meta: JSONValue?

    var id: String { "\(event)#\(type)" }
}

struct ConversationPage: Codable, Hashable, Sendable {
    var items: [ConversationItem]
    /// Opaque cursor; pass it back as `after`. Nil on the last page.
    var next: JSONValue?
}

// MARK: - Statistics

struct StatsSummary: Codable, Hashable, Sendable {
    struct AgentCount: Codable, Hashable, Sendable {
        var agent: String
        var sessions: Int
        var events: Int
    }

    var events: Int
    var sessions: Int
    var firstTs: Int64?
    var lastTs: Int64?
    var byAgent: [AgentCount]
    var tokens: TokenUsage
    var llmCalls: Int
    var toolCalls: Int
    var errors: Int
    var loggedCostUsd: Double?
}

struct KindNode: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var count: Int
    var bytes: Int64
    var children: [KindNode]
    var id: String { name }
}

struct ToolStat: Codable, Hashable, Sendable, Identifiable {
    var tool: String
    var kind: String
    var calls: Int
    var errors: Int
    var p50: Int64?
    var p90: Int64?
    var p99: Int64?
    var max: Int64?
    var total: Int64
    var agents: [String]
    var id: String { tool }
}

struct ModelStat: Codable, Hashable, Sendable, Identifiable {
    var model: String
    var calls: Int
    var tokens: TokenUsage
    var cacheHitRatio: Double?
    var latencyP50: Int64?
    var latencyP90: Int64?
    var id: String { model }
}

struct PerformanceStat: Codable, Hashable, Sendable, Identifiable {
    var model: String
    var calls: Int
    var latencyKnown: Int
    var latencyEstimated: Int
    var latencyP50: Int64?
    var latencyP90: Int64?
    var ttftKnown: Int
    var ttftP50: Int64?
    var ttftP90: Int64?
    var outputRateKnown: Int
    var outputRateEstimated: Int
    var outputRateP50: Double?
    var outputRateP10: Double?
    var cacheHitRatio: Double?
    var cacheKnown: Int?
    var id: String { model }
}

struct PerformanceResult: Codable, Sendable {
    /// Every call of the view (`model` is ""); nil from an engine that predates it.
    var overall: PerformanceStat?
    var models: [PerformanceStat]
    var bottlenecks: [PerformanceBottleneck]
    var timeline: PerformanceTimeline?
}

/// Performance over time (SPEC §6): busy segments of the view and their bins; the time between segments is idle.
struct PerformanceTimeline: Codable, Hashable, Sendable {
    struct Segment: Codable, Hashable, Sendable {
        var start: Int64
        var end: Int64
    }

    var binUs: Int64
    var segments: [Segment]
    var bins: [PerformanceBin]
    /// Busy µs per time bucket over the whole view.
    var busy: [String: Int64]
}

struct PerformanceBin: Codable, Hashable, Sendable, Identifiable {
    var t: Int64
    /// Busy µs per time bucket in this bin; parallel sessions add up.
    var busy: [String: Int64]
    var calls: Int
    var tools: Int
    var failed: Int
    var latencyP50: Int64?
    var latencyP90: Int64?
    var ttftP50: Int64?
    var ttftP90: Int64?
    var rateP50: Double?
    var rateP10: Double?
    var cacheHitRatio: Double?
    var inputP50: Int?
    var id: Int64 { t }
    var busyUs: Int64 { busy.values.reduce(0, +) }
}

struct PerformanceBottleneck: Codable, Hashable, Sendable, Identifiable {
    var spanId: String
    var sessionId: String
    var eventId: String?
    var name: String
    var bucket: TimeBucketName
    var start: Int64
    var duration: Int64
    var estimated: Bool
    var ttft: Int64?
    var cacheHitRatio: Double?
    var id: String { spanId }
}

struct IoSeries: Codable, Hashable, Sendable {
    struct Point: Codable, Hashable, Sendable {
        var t: Int64
        var v: Double
        var n: Int? = nil
    }

    var binUs: Int64
    var metric: String
    var series: [Point]
}

struct PairStat: Codable, Hashable, Sendable, Identifiable {
    var a: String
    var b: String
    var count: Int
    var dur: Int64
    var errors: Int
    var id: String { "\(a)\u{0}\(b)" }
}

// MARK: - Diagnostics (API name: expert)

struct ExpertResult: Codable, Hashable, Sendable {
    struct Item: Codable, Hashable, Sendable, Identifiable {
        var id: Int
        var session: String?
        var event: String?
        var span: String?
        var message: String
        var ts: Int64?
        /// The failure episode of the entry (analysed indexes only; SPEC §12.7 Diagnostics).
        var episodeId: String?
    }

    struct Group: Codable, Hashable, Sendable, Identifiable {
        /// API severity: `error | warn | note | chat`. Present it with `Severity.label(_:)`.
        var severity: String
        var group: String
        var count: Int
        var items: [Item]
        var id: String { "\(severity)/\(group)" }
    }

    var groups: [Group]
}

/// Presentation names for diagnostic severities (SPEC §7.8: Error, Warning, Note, Info).
enum Severity {
    static let order = ["error", "warn", "note", "chat"]

    static func label(_ apiSeverity: String) -> String {
        switch apiSeverity {
        case "error": return "Error"
        case "warn": return "Warning"
        case "note": return "Note"
        case "chat", "info": return "Info"
        default: return apiSeverity.capitalized
        }
    }
}

// MARK: - Sources

struct HealthReport: Codable, Hashable, Sendable, Identifiable {
    struct Parse: Codable, Hashable, Sendable {
        var lines: Int
        var malformed: Int
        var unknown: Int
        var skipped: Int
        var inherited: Int
    }

    struct CapabilityRow: Codable, Hashable, Sendable, Identifiable {
        var capability: String
        /// `logged | derived | partial | absent`.
        var level: String
        var note: String
        var id: String { capability }
    }

    struct Finding: Codable, Hashable, Sendable {
        var severity: String
        var title: String
        var detail: String
        /// A string today; kept polymorphic so structured recommendations decode too.
        var recommendation: JSONValue?

        var recommendationText: String? {
            switch recommendation {
            case .string(let s)?: return s
            case .object(let o)?: return o["text"]?.stringValue ?? o["summary"]?.stringValue
            default: return nil
            }
        }
    }

    var agent: String
    var label: String
    var detected: Bool
    var parsed: Bool
    var roots: [String]
    var files: Int
    var bytes: Int64
    var firstTs: Int64?
    var lastTs: Int64?
    var versions: [String]
    var parse: Parse
    var capabilities: [CapabilityRow]
    var findings: [Finding]
    var id: String { agent }
}

struct SourceRow: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var agent: String
    var kind: String
    var path: String
    var size: Int64
    var mtimeMs: Double
    var lines: Int
    var malformed: Int
    var unknown: Int
    var skipped: Int
    var inherited: Int
    var dialect: String?
    var status: String
    var error: String?
    var existsNow: Bool
    var indexedAt: Int64?
    var parseMs: Double?
}

struct SourcesResult: Codable, Hashable, Sendable {
    /// `captured`: the evidence inside the open capture only; `local`: this Mac's agents, settings and index.
    var scope: String?
    /// The machine the report describes: this host, or the host named in the capture header.
    var host: String?
    /// Capture mode: when the capture was written (µs).
    var capturedAt: Int64?
    var agents: [HealthReport]
    var sources: [SourceRow]

    var isCaptured: Bool { scope == "captured" }
}

// MARK: - Engine events (SSE /api/stream)

enum EngineEvent: Hashable, Sendable {
    case hello
    case indexProgress(done: Int, total: Int, currentPath: String?, since: Int64? = nil)
    /// `truncated`: the list is incomplete (too many changes, or another process wrote the index); refetch everything.
    case indexDone(changedSessions: [String], truncated: Bool = false)
    /// An alarm fired or cleared in the last index run (SPEC §12.5).
    case alarm(AlarmStreamEvent)
    /// Emitted right after `indexDone` when `index-done` carries `analysis`.
    case analysisDone(IndexDoneAnalysis)
}
