import Foundation

/// The two workbench analyses the Mac draws natively (ANALYSIS-UX §4.1, §5.3). A protocol, so the request policy
/// can be tested against a fake engine.
protocol WorkbenchClient: Sendable {
    func perf(session: String) async throws -> PerfResult
    func diff(left: String, right: String, children: Bool, limit: Int?) async throws -> DiffResult
}

/// A workbench failure code (`src/server/workbench.ts`, `src/server/query-host.ts`; ANALYSIS-UX §4.11, §5.13).
struct WorkbenchErrorCode: StringKind {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    /// 503: indexing has not finished, so the engine does not run analyses yet.
    static let unavailable: WorkbenchErrorCode = "workbench-unavailable"
    /// 503: the job passed 30 s; the engine stopped it and restarted a query worker.
    static let timeout: WorkbenchErrorCode = "query-timeout"
    static let sessionNotFound: WorkbenchErrorCode = "session-not-found"
    static let sessionTreeLimit: WorkbenchErrorCode = "session-tree-limit"
    static let rowLimit: WorkbenchErrorCode = "row-limit"
    /// Any other input the engine refused.
    static let input: WorkbenchErrorCode = "workbench-input"
    /// 400: the engine serves `POST /api/workbench/:operation` but predates this analysis.
    static let unknownOperation: WorkbenchErrorCode = "workbench-operation"
    static let known: [WorkbenchErrorCode] = [.unavailable, .timeout, .sessionNotFound, .sessionTreeLimit, .rowLimit, .input,
                                              .unknownOperation]
}

extension APIError {
    /// 503 `workbench-unavailable`: the index is not ready; the request can run again after the next index run.
    var isWorkbenchUnavailable: Bool { status == 503 && code == WorkbenchErrorCode.unavailable.rawValue }

    /// The engine cannot run this analysis at all: it has no workbench route, or a workbench without the operation
    /// (400 `workbench-operation`). The view offers "needs a newer engine", never Retry (ANALYSIS-UX §4.11 Old engine).
    var isWorkbenchNotServed: Bool { isNotServed || workbenchCode == .unknownOperation }

    /// The failure by analysis 1.1.0's codes; nil for a failure that is not the workbench's, such as an unreachable
    /// engine, a missing route or an unreadable response. An older engine sends every input error as 400 `error`, so
    /// its message decides: those sentences come from src/workbench/data.ts.
    var workbenchCode: WorkbenchErrorCode? {
        guard let code else { return nil }
        if status == 400, code == "error" {
            if message.hasPrefix("session not found") { return .sessionNotFound }
            if message.hasPrefix("session tree exceeds") { return .sessionTreeLimit }
            if message.contains("-row limit") { return .rowLimit }
            return .input
        }
        let known = WorkbenchErrorCode(rawValue: code)
        return WorkbenchErrorCode.known.contains(known) ? known : nil
    }

    /// The session a `session-not-found` names ("session not found: {id}"), so Compare can say which run is gone
    /// (ANALYSIS-UX §5.13).
    var missingSession: String? {
        guard workbenchCode == .sessionNotFound, let colon = message.range(of: ": ") else { return nil }
        let id = message[colon.upperBound...].trimmingCharacters(in: .whitespaces)
        return id.isEmpty ? nil : id
    }
}

extension APIClient: WorkbenchClient {
    private struct PerfRequest: Encodable {
        let session: String
    }

    private struct DiffRequest: Encodable {
        let left: String
        let right: String
        let children: Bool
        /// Omitted for the engine's default of 1,500 actions per run.
        let limit: Int?
    }

    // A result is up to a megabyte of JSON (3,000 aligned rows, 2,000 path segments). `@concurrent` keeps decoding off
    // the caller's actor, usually the main actor, whatever the module's default isolation becomes.

    /// `POST /api/workbench/perf`: the critical path of `session` and its descendants.
    @concurrent func perf(session: String) async throws -> PerfResult {
        try await workbench("perf", body: PerfRequest(session: session))
    }

    /// `POST /api/workbench/diff`: run A (`left`) aligned with run B (`right`). `children` includes each run's
    /// subagents; `limit` caps the actions per run (1 to 2,000).
    @concurrent func diff(left: String, right: String, children: Bool, limit: Int?) async throws -> DiffResult {
        try await workbench("diff", body: DiffRequest(left: left, right: right, children: children, limit: limit))
    }

    private func workbench<T: Decodable, B: Encodable>(_ operation: String, body: B) async throws -> T {
        var req = request("POST", "/api/workbench/" + operation)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        return try Self.decode(T.self, from: try await send(req))
    }
}
