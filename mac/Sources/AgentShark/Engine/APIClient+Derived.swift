import Foundation

/// Scope of the derived list routes. The Mac sends `view` (a view id or `global`); `session` and `view` exclude each
/// other on the wire, so `session` and `descendants` are left out whenever `view` is set.
struct DerivedScopeQuery: Hashable, Sendable {
    var view: String?
    var session: String?
    var descendants: Bool?
    var since: Int64?
    var until: Int64?

    static let global = DerivedScopeQuery(view: "global")

    var items: [(String, String?)] {
        var out: [(String, String?)] = [("view", view)]
        if view == nil {
            out.append(("session", session))
            if session != nil { out.append(("descendants", descendants.map { $0 ? "true" : "false" })) }
        }
        out.append(("since", since.map(String.init)))
        out.append(("until", until.map(String.init)))
        return out
    }
}

/// `GET /api/failures/queue` parameters (QueueQuery in api.ts).
struct QueueRequest: Hashable, Sendable {
    var scope: DerivedScopeQuery
    var group: QueueGroup?
    var tiers: [FailureTier] = []
    var outcomes: [EpisodeOutcome] = []
    var families: [FailureFamily] = []
    var agents: [AgentKind] = []
    var roles: [String] = []
    var unattended: Bool?
    var section: AttentionSection?
    var signature: String?
    var sort: String?
    var limit: Int = 200
    var offset: Int = 0
}

/// `GET /api/sessions/:id/steps` parameters (StepsQuery in api.ts).
struct StepsRequest: Hashable, Sendable {
    /// The window's view: steps report `match`, the page `total` and `matched`.
    var view: String?
    var turn: String?
    var after: String?
    var limit: Int = 500
    var sort: String?
    var order: String?
    var descendants: Bool?
    var foldClean: Bool?
    var onlyFailed: Bool?
    var bucket: TimeBucketName?
}

extension APIError {
    /// The engine does not serve this agent-native route: an older engine (no route), a server without the analysis
    /// routes, or a method this engine build has not implemented (501 `not-implemented`).
    var isNotServed: Bool { isMissingRoute || status == 501 }
}

/// One method per `DerivedQueries` route (MAC-CONTRACT §5.4). Lists are comma-separated and parameter names
/// snake_case; every id in a path is percent-encoded, because derived ids contain `#`, `:`, `/` and `.`.
extension APIClient {
    private static func list<T: StringKind>(_ values: [T]) -> String? {
        values.isEmpty ? nil : values.map(\.rawValue).joined(separator: ",")
    }

    private static func flag(_ b: Bool?) -> String? { b.map { $0 ? "true" : "false" } }

    func failuresSummary(_ q: DerivedScopeQuery, tiers: [FailureTier] = []) async throws -> FailuresSummary {
        try await get("/api/failures/summary", q.items + [("tier", Self.list(tiers))])
    }

    func failuresQueue(_ q: QueueRequest) async throws -> QueuePage {
        try await get("/api/failures/queue", q.scope.items + [
            ("group", q.group?.rawValue), ("tier", Self.list(q.tiers)), ("outcome", Self.list(q.outcomes)),
            ("family", Self.list(q.families)), ("agent", Self.list(q.agents)),
            ("role", q.roles.isEmpty ? nil : q.roles.joined(separator: ",")), ("unattended", Self.flag(q.unattended)),
            ("section", q.section?.rawValue), ("signature", q.signature), ("sort", q.sort),
            ("limit", String(q.limit)), ("offset", String(q.offset)),
        ])
    }

    func episode(_ id: String, outputChars: Int? = nil) async throws -> Enveloped<LensPayload> {
        try await get("/api/episodes/" + Self.segment(id), [("output_chars", outputChars.map(String.init))])
    }

    func claim(turn: String, outputChars: Int? = nil) async throws -> ClaimLens {
        try await get("/api/claims/" + Self.segment(turn), [("output_chars", outputChars.map(String.init))])
    }

    func delegation(span: String, outputChars: Int? = nil) async throws -> DelegationLens {
        try await get("/api/delegations/" + Self.segment(span), [("output_chars", outputChars.map(String.init))])
    }

    /// `format`: `md | brief | json`. Always the JSON envelope (text plus the redactions).
    func episodeReport(_ id: String, format: String) async throws -> EpisodeReport {
        try await get("/api/episodes/\(Self.segment(id))/report", [("format", format)])
    }

    func signatures(_ q: DerivedScopeQuery, families: [FailureFamily] = [], statuses: [SignatureStatus] = [],
                    tiers: [FailureTier] = [], sort: String? = nil, limit: Int = 200, offset: Int = 0) async throws -> SignatureList {
        try await get("/api/signatures", q.items + [
            ("family", Self.list(families)), ("status", Self.list(statuses)), ("tier", Self.list(tiers)), ("sort", sort),
            ("limit", String(limit)), ("offset", String(offset)),
        ])
    }

    func signature(_ id: String, splitAt: Int64? = nil) async throws -> SignatureDetail {
        try await get("/api/signatures/" + Self.segment(id), [("split_at", splitAt.map(String.init))])
    }

    func sessionSteps(_ sessionID: String, _ q: StepsRequest) async throws -> StepsPage {
        try await get("/api/sessions/\(Self.segment(sessionID))/steps", [
            ("view", q.view), ("turn", q.turn), ("after", q.after), ("limit", String(q.limit)), ("sort", q.sort), ("order", q.order),
            ("descendants", Self.flag(q.descendants)), ("fold_clean", Self.flag(q.foldClean)), ("only_failed", Self.flag(q.onlyFailed)),
            ("bucket", q.bucket?.rawValue),
        ])
    }

    func runReport(session: String, since: Int64? = nil) async throws -> Enveloped<RunReport> {
        try await get("/api/report/" + Self.segment(session), [("since", since.map(String.init))])
    }

    func runReportMarkdown(session: String, since: Int64? = nil) async throws -> String {
        var req = request("GET", "/api/report/" + Self.segment(session), query: [("since", since.map(String.init)), ("format", "md")])
        req.setValue("text/markdown", forHTTPHeaderField: "Accept")
        return String(decoding: try await send(req), as: UTF8.self)
    }

    private func rows<Row>(_ path: String, _ q: DerivedScopeQuery, limit: Int, offset: Int,
                           extra: [(String, String?)] = []) async throws -> RowsPage<Row> {
        try await get(path, q.items + extra + [("limit", String(limit)), ("offset", String(offset))])
    }

    func delegations(_ q: DerivedScopeQuery, limit: Int = 500, offset: Int = 0) async throws -> RowsPage<DelegationItem> {
        try await rows("/api/delegations", q, limit: limit, offset: offset)
    }

    func claims(_ q: DerivedScopeQuery, limit: Int = 500, offset: Int = 0) async throws -> RowsPage<ClaimItem> {
        try await rows("/api/claims", q, limit: limit, offset: offset)
    }

    func interventions(_ q: DerivedScopeQuery, limit: Int = 500, offset: Int = 0) async throws -> RowsPage<InterventionItem> {
        try await rows("/api/interventions", q, limit: limit, offset: offset)
    }

    func alarms(_ q: DerivedScopeQuery, state: AlarmState? = nil, kinds: [AlarmKind] = [], limit: Int = 500,
                offset: Int = 0) async throws -> RowsPage<AlarmItem> {
        try await rows("/api/alarms", q, limit: limit, offset: offset, extra: [("state", state?.rawValue), ("kind", Self.list(kinds))])
    }

    func episodes(_ q: DerivedScopeQuery, limit: Int = 500, offset: Int = 0) async throws -> RowsPage<EpisodeItem> {
        try await rows("/api/episodes", q, limit: limit, offset: offset)
    }

    func processes(_ q: DerivedScopeQuery, limit: Int = 500, offset: Int = 0) async throws -> RowsPage<ProcessItem> {
        try await rows("/api/processes", q, limit: limit, offset: offset)
    }

    func eventDerived(_ eventID: String) async throws -> EventDerived {
        try await get("/api/events/\(Self.segment(eventID))/derived")
    }

    func sessionMarks(ids: [String] = []) async throws -> SessionMarks {
        try await get("/api/session-marks", [("ids", ids.isEmpty ? nil : ids.joined(separator: ","))])
    }

    func diff(event: String, path: String? = nil, maxLines: Int? = nil) async throws -> ChangeDiff {
        try await get("/api/changes/\(Self.segment(event))/diff", [("path", path), ("max_lines", maxLines.map(String.init))])
    }

    func follow(_ target: FollowTarget, after: String? = nil, limit: Int = 500, outputChars: Int? = nil) async throws -> FollowPage {
        var query: [(String, String?)] = [("after", after), ("limit", String(limit)), ("output_chars", outputChars.map(String.init))]
        let path: String
        switch target {
        case .call(let id): path = "/api/follow/call/" + Self.segment(id)
        case .delegation(let id): path = "/api/follow/delegation/" + Self.segment(id)
        case .process(let id): path = "/api/follow/process/" + Self.segment(id)
        case .file(let session, let p):
            path = "/api/follow/file"
            query += [("session", session), ("path", p)]
        }
        return try await get(path, query)
    }

    func time(session: String? = nil, turn: String? = nil) async throws -> Enveloped<TimeBreakdown> {
        try await get("/api/time", [("session", session), ("turn", turn)])
    }

    /// `group`: `tool | server | program | host | model`.
    func statsSRT(view: String?, group: String) async throws -> SrtResponse {
        try await get("/api/stats/tools", [("view", view), ("group", group)])
    }

    func statsEndpoints(view: String?, kind: String? = nil) async throws -> EndpointsResponse {
        try await get("/api/stats/endpoints", [("view", view), ("kind", kind)])
    }

    /// `PUT /api/settings/alarm-thresholds` (Settings ▸ Alerts): the index's thresholds, shared by every reader. The
    /// engine re-derives every tree with them and answers the new analysis status (409 `capture-mode` for a capture).
    func setAlarmThresholds(_ t: AlarmThresholds) async throws -> AnalysisStatus {
        var req = request("PUT", "/api/settings/alarm-thresholds")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(t)
        return try Self.decode(AnalysisStatus.self, from: try await send(req))
    }
}
