import Foundation

/// Where a running engine listens (from its ready handshake).
struct EngineEndpoint: Sendable, Hashable {
    let baseURL: URL
    let token: String
    let mode: String
    let indexPath: String
    let version: String
    /// The handshake's writer-lock role (`writer` or `follower`) and, for a follower, the writer's pid.
    var role: String?
    var writerPid: Int?
}

/// `{error: {message, code, start, end}}` from the engine, or a transport failure (`status` 0).
struct APIError: Error, LocalizedError, Hashable, Sendable {
    let status: Int
    let message: String
    let code: String?
    let start: Int?
    let end: Int?
    /// The failing coloring rule for `code == "color_rule"`.
    var ruleId: String? = nil

    var errorDescription: String? { message }

    /// The engine could not be reached at all.
    var isUnreachable: Bool { status == 0 }
    /// The view ID belongs to an earlier engine run or was evicted; rebuild the view.
    var isViewGone: Bool { code == "view-not-found" }
    /// The engine does not have this route (an older engine).
    var isMissingRoute: Bool { status == 404 && code == "not-found" && message.hasPrefix("No API route") }

    static func unreachable(_ underlying: Error) -> APIError {
        APIError(status: 0, message: "Cannot reach the AgentShark engine. \(underlying.localizedDescription)", code: "unreachable",
                 start: nil, end: nil)
    }
}

/// HTTP client for one engine (SPEC §6 plus MAC-CONTRACT §3). Every call is async and cancellable.
final class APIClient: Sendable {
    let endpoint: EngineEndpoint
    private let session: URLSession
    private let streamSession: URLSession

    init(endpoint: EngineEndpoint) {
        self.endpoint = endpoint
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 300
        config.httpMaximumConnectionsPerHost = 8
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpAdditionalHeaders = ["X-AgentShark-Token": endpoint.token, "Accept": "application/json"]
        session = URLSession(configuration: config)
        let streamConfig = URLSessionConfiguration.ephemeral
        // The server sends a heartbeat every 15 s; anything longer than this means the connection is gone.
        streamConfig.timeoutIntervalForRequest = 45
        streamConfig.timeoutIntervalForResource = .infinity
        streamConfig.httpAdditionalHeaders = ["X-AgentShark-Token": endpoint.token, "Accept": "text/event-stream"]
        streamSession = URLSession(configuration: streamConfig)
    }

    deinit {
        session.invalidateAndCancel()
        streamSession.invalidateAndCancel()
    }

    // MARK: Index and filter

    func info() async throws -> InfoResult { try await get("/api/info") }
    func fields() async throws -> [FieldInfo] { try await get("/api/fields") }

    func validate(_ filter: String) async throws -> FilterCheck {
        try await post("/api/filter/validate", body: ["filter": filter])
    }

    // MARK: Sessions

    /// `role`: `main` for top-level runs only, or a subagent role such as `subagent`.
    func sessions(agent: String? = nil, query: String? = nil, role: String? = nil, from: Int64? = nil, to: Int64? = nil,
                  limit: Int = 20000, offset: Int = 0) async throws -> SessionList {
        try await get("/api/sessions", [("agent", agent), ("q", query), ("role", role), ("from", from.map(String.init)),
                                         ("to", to.map(String.init)), ("limit", String(limit)), ("offset", String(offset))])
    }

    func session(_ id: String) async throws -> SessionDetail {
        try await get("/api/sessions/" + Self.segment(id))
    }

    // MARK: Views

    func createView(_ spec: ViewSpec) async throws -> ViewInfo { try await post("/api/views", body: spec) }

    func rows(view: String, offset: Int, limit: Int, columns: [String] = []) async throws -> [EventRow] {
        struct Rows: Decodable { let rows: [EventRow] }
        let r: Rows = try await get("/api/views/\(Self.segment(view))/rows",
                                    [("offset", String(offset)), ("limit", String(limit)),
                                     ("columns", columns.isEmpty ? nil : columns.joined(separator: ","))])
        return r.rows
    }

    func locate(view: String, event: String) async throws -> Int? {
        let r: RowNumber = try await get("/api/views/\(Self.segment(view))/locate", [("event", event)])
        return r.no
    }

    /// Next (or previous) row whose full text matches, starting after view row number `from` (1-based; 0 = before the first).
    func find(view: String, query: String, from: Int, forward: Bool) async throws -> Int? {
        let r: RowNumber = try await get("/api/views/\(Self.segment(view))/find",
                                         [("q", query), ("from", String(from)), ("dir", forward ? "next" : "prev")])
        return r.no
    }

    func histogram(view: String, bins: Int, from: Int64? = nil, to: Int64? = nil) async throws -> Histogram {
        try await get("/api/views/\(Self.segment(view))/histogram",
                      [("bins", String(bins)), ("from", from.map(String.init)), ("to", to.map(String.init))])
    }

    // MARK: Events

    /// The event with `attrs` and `native` in source key order.
    func event(_ id: String) async throws -> EventDetail {
        let data = try await send(request("GET", "/api/events/" + Self.segment(id)))
        var detail = try Self.decode(EventDetail.self, from: data)
        // JSONDecoder loses key order; take the ordered subtrees from a second, order-preserving parse.
        if let tree = try? JSONValue.parse(data), let event = tree["event"] {
            if let attrs = event["attrs"] { detail.event.attrs = attrs }
            if let native = event["native"] { detail.event.native = native }
        }
        return detail
    }

    func raw(_ id: String, maxString: Int = 4000) async throws -> RawResult {
        try await get("/api/events/\(Self.segment(id))/raw", [("maxString", String(maxString))])
    }

    // MARK: Spans

    func spans(sessions: [String], from: Int64?, to: Int64?, kinds: [String] = [], minDur: Int64? = nil,
               limit: Int = 20000) async throws -> SpanList {
        try await get("/api/spans", [("sessions", sessions.isEmpty ? nil : sessions.joined(separator: ",")),
                                     ("from", from.map(String.init)), ("to", to.map(String.init)),
                                     ("kinds", kinds.isEmpty ? nil : kinds.joined(separator: ",")),
                                     ("minDur", minDur.map(String.init)), ("limit", String(limit))])
    }

    func span(_ id: String) async throws -> SpanDetail {
        try await get("/api/spans/" + Self.segment(id))
    }

    func overview(from: Int64? = nil, to: Int64? = nil, agent: String? = nil) async throws -> [OverviewSession] {
        struct Overview: Decodable { let sessions: [OverviewSession] }
        let r: Overview = try await get("/api/overview", [("from", from.map(String.init)), ("to", to.map(String.init)),
                                                          ("agent", agent)])
        return r.sessions
    }

    // MARK: Conversation

    func conversation(session: String, after: JSONValue? = nil, limit: Int = 200) async throws -> ConversationPage {
        let cursor = after.flatMap { $0.int64Value.map(String.init) ?? $0.stringValue }
        return try await get("/api/conversation/" + Self.segment(session), [("after", cursor), ("limit", String(limit))])
    }

    // MARK: Statistics

    func statsSummary(view: String?) async throws -> StatsSummary {
        try await get("/api/stats/summary", [("view", view)])
    }

    func statsKinds(view: String?) async throws -> [KindNode] {
        struct Kinds: Decodable { let tree: [KindNode] }
        let r: Kinds = try await get("/api/stats/kinds", [("view", view)])
        return r.tree
    }

    func statsTools(view: String?) async throws -> [ToolStat] {
        struct Tools: Decodable { let tools: [ToolStat] }
        let r: Tools = try await get("/api/stats/tools", [("view", view)])
        return r.tools
    }

    func statsModels(view: String?) async throws -> [ModelStat] {
        struct Models: Decodable { let models: [ModelStat] }
        let r: Models = try await get("/api/stats/models", [("view", view)])
        return r.models
    }

    func statsPerformance(view: String?) async throws -> PerformanceResult {
        try await get("/api/stats/performance", [("view", view)])
    }

    /// `metric`: `events | errors | tokens.input | tokens.output | tool.calls | llm.calls | latency.mean`.
    func statsIO(view: String?, intervalUs: Int64?, metric: String) async throws -> IoSeries {
        try await get("/api/stats/io", [("view", view), ("interval", intervalUs.map(String.init)), ("metric", metric)])
    }

    func statsPairs(view: String?) async throws -> [PairStat] {
        struct Pairs: Decodable { let pairs: [PairStat] }
        let r: Pairs = try await get("/api/stats/pairs", [("view", view)])
        return r.pairs
    }

    // MARK: Diagnostics and sources

    func expert(view: String? = nil, session: String? = nil, severity: String? = nil, group: String? = nil,
                limit: Int = 500) async throws -> ExpertResult {
        try await get("/api/expert", [("view", view), ("session", session), ("severity", severity), ("group", group),
                                      ("limit", String(limit))])
    }

    /// Logging health. In capture mode the report describes the captured evidence; `local` asks for this Mac's.
    func sources(local: Bool = false) async throws -> SourcesResult {
        try await get("/api/sources", local ? [("local", "1" as String?)] : [])
    }

    /// A side file (persisted tool output, backup, image) under a discovered source root.
    func file(path: String) async throws -> (data: Data, contentType: String) {
        let (data, response) = try await perform(request("GET", "/api/file", query: [("path", path)]))
        return (data, response.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream")
    }

    /// Start an incremental index run (live mode). Returns false when one is already running.
    @discardableResult
    func reindex() async throws -> Bool {
        struct Started: Decodable { let started: Bool }
        let r: Started = try await post("/api/reindex", body: [String: String]())
        return r.started
    }

    // MARK: Stream

    /// Server-Sent Events from /api/stream, reconnecting automatically until the consumer stops iterating.
    func stream() -> AsyncThrowingStream<EngineEvent, Error> {
        let messages = SSEClient.messages(request: request("GET", "/api/stream"), session: streamSession, onConnection: { _ in })
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await m in messages {
                        for e in EngineEvent.events(from: m) { continuation.yield(e) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The raw SSE stream with connection-state callbacks (used by `EngineStore` for the live status).
    func streamMessages(onConnection: @escaping @Sendable (Bool) -> Void) -> AsyncThrowingStream<SSEClient.Message, Error> {
        SSEClient.messages(request: request("GET", "/api/stream"), session: streamSession, onConnection: onConnection)
    }

    // MARK: Plumbing

    private struct RowNumber: Decodable { let no: Int? }

    func get<T: Decodable>(_ path: String, _ query: [(String, String?)] = []) async throws -> T {
        try Self.decode(T.self, from: try await send(request("GET", path, query: query)))
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        var req = request("POST", path)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        return try Self.decode(T.self, from: try await send(req))
    }

    func request(_ method: String, _ path: String, query: [(String, String?)] = []) -> URLRequest {
        let items = query.compactMap { k, v in v.map { "\(Self.component(k))=\(Self.component($0))" } }
        let suffix = items.isEmpty ? "" : "?" + items.joined(separator: "&")
        var base = endpoint.baseURL.absoluteString
        if base.hasSuffix("/") { base.removeLast() }
        var req = URLRequest(url: URL(string: base + path + suffix)!)
        req.httpMethod = method
        return req
    }

    func send(_ req: URLRequest) async throws -> Data {
        try await perform(req).data
    }

    private func perform(_ req: URLRequest) async throws -> (data: Data, response: HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError.unreachable(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, message: "The engine sent an invalid response.", code: "bad-response", start: nil, end: nil)
        }
        guard (200..<300).contains(http.statusCode) else { throw Self.apiError(status: http.statusCode, data: data) }
        return (data, http)
    }

    static func apiError(status: Int, data: Data) -> APIError {
        struct Envelope: Decodable {
            struct Body: Decodable {
                let message: String
                let code: String?
                let start: Int?
                let end: Int?
                let ruleId: String?
            }
            let error: Body
        }
        if let e = try? JSONDecoder().decode(Envelope.self, from: data) {
            return APIError(status: status, message: e.error.message, code: e.error.code, start: e.error.start, end: e.error.end,
                            ruleId: e.error.ruleId)
        }
        return APIError(status: status, message: "The engine answered with HTTP \(status).", code: nil, start: nil, end: nil)
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(status: 200, message: "Could not read the engine's response: \(Self.describe(error))", code: "decode",
                           start: nil, end: nil)
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error as? DecodingError {
        case .keyNotFound(let key, let ctx)?:
            return "missing \(key.stringValue) at \(path(ctx.codingPath))"
        case .typeMismatch(_, let ctx)?, .valueNotFound(_, let ctx)?, .dataCorrupted(let ctx)?:
            return "\(ctx.debugDescription) at \(path(ctx.codingPath))"
        default:
            return error.localizedDescription
        }
    }

    private static func path(_ keys: [CodingKey]) -> String {
        keys.isEmpty ? "the top level" : keys.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue }.joined(separator: ".")
    }

    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// Percent-encode a query component; '+' and '&' are always encoded.
    static func component(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s
    }

    /// Percent-encode one path segment (IDs contain ':', '/', '#').
    static func segment(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: unreserved.union(CharacterSet(charactersIn: ":"))) ?? s
    }
}

extension EngineEvent {
    /// Decode an SSE message from /api/stream: one message can carry two events (`index-done` with `analysis`).
    static func events(from m: SSEClient.Message) -> [EngineEvent] {
        guard let e = EngineEvent(message: m) else { return [] }
        guard case .indexDone = e else { return [e] }
        struct A: Decodable { let analysis: IndexDoneAnalysis? }
        if let a = try? JSONDecoder().decode(A.self, from: Data(m.data.utf8)).analysis { return [e, .analysisDone(a)] }
        return [e]
    }

    /// Decode an SSE message from /api/stream; nil for events the app does not use.
    init?(message m: SSEClient.Message) {
        let data = Data(m.data.utf8)
        switch m.event {
        case "hello":
            self = .hello
        case "index-progress":
            struct P: Decodable { let done: Int?; let total: Int?; let currentPath: String?; let since: Int64? }
            guard let p = try? JSONDecoder().decode(P.self, from: data) else { return nil }
            self = .indexProgress(done: p.done ?? 0, total: p.total ?? 0, currentPath: p.currentPath, since: p.since)
        case "index-done":
            struct D: Decodable { let changedSessions: [String]?; let changedSessionsTruncated: Bool? }
            let d = try? JSONDecoder().decode(D.self, from: data)
            self = .indexDone(changedSessions: d?.changedSessions ?? [], truncated: d?.changedSessionsTruncated ?? false)
        case "alarm":
            guard let a = try? JSONDecoder().decode(AlarmStreamEvent.self, from: data) else { return nil }
            self = .alarm(a)
        default:
            return nil
        }
    }
}
