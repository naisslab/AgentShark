import Foundation
import Observation

/// Everything the app knows about one engine: info, the session catalog, filter fields, indexing progress and
/// the event-stream connection. The live engine's store backs `AppModel`; each capture window has its own.
@MainActor @Observable final class EngineStore {
    enum Connection: Hashable, Sendable {
        /// The engine is not ready.
        case offline
        case connecting
        case connected
        /// The event stream dropped; it reconnects automatically.
        case disconnected
    }

    enum LoadPhase: Hashable, Sendable {
        case idle, loading, failed(APIError), ready
    }

    /// The status indicator's states (SPEC §7.8 "Status is truthful").
    enum LiveStatus: Hashable, Sendable {
        case engineStarting(String)
        case engineStopped(String)
        case indexing(done: Int, total: Int)
        case watching
        /// Another live process writes the index; this engine serves its results (pid when reported).
        case following(writerPid: Int?)
        case manualRefresh
        case capture(name: String, complete: Bool?)
        case disconnected
    }

    let engine: EngineProcess
    /// The derived model of this engine (SPEC §12): sidebar marks, firing alarms, the attention count.
    let derived = DerivedStore()
    private(set) var info: InfoResult?
    private(set) var infoError: APIError?
    /// All sessions, most recently active first.
    private(set) var sessions: [SessionRow] = []
    private(set) var sessionsByID: [String: SessionRow] = [:]
    private(set) var childrenByParent: [String: [String]] = [:]
    private(set) var sessionsPhase: LoadPhase = .idle
    /// The session list came from the on-disk cache of an earlier run and the engine has not answered yet.
    private(set) var sessionsAreCached = false
    private(set) var fields: [FieldInfo] = []
    private(set) var fieldNames: Set<String> = []
    /// The run in flight, once it has run for `indexingShownAfter`. While an agent works, the engine indexes its
    /// transcript every few seconds in well under a second; showing each of those runs redrew the toolbar twice per run.
    private(set) var indexing: IndexProgress?
    private(set) var connection: Connection = .offline
    /// Increments after every finished index run.
    private(set) var indexGeneration = 0
    /// Increments when what event rows show of their session changes (title, start, agent, role) or sessions come and
    /// go. Most index runs change only the activity of the sessions they touched.
    private(set) var sessionLabelsGeneration = 0
    private(set) var lastIndexDoneAt: Date?

    typealias IndexProgress = (done: Int, total: Int, path: String?, since: Int64?)
    static let indexingShownAfter: Duration = .seconds(1)
    /// The latest progress of the run in flight, before `indexing` shows it.
    @ObservationIgnored private var runProgress: IndexProgress?
    @ObservationIgnored private var showIndexing: Task<Void, Never>?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var sessionsTask: Task<Void, Never>?
    @ObservationIgnored private var scheduledFullRefresh: Task<Void, Never>?
    @ObservationIgnored private var lastFullRefresh = Date.distantPast
    @ObservationIgnored private var observers: [Observer] = []
    @ObservationIgnored private let cacheURL: URL?

    private struct Observer {
        weak var owner: AnyObject?
        let ready: @MainActor () -> Void
        let indexDone: @MainActor () -> Void
    }

    /// Changed-session batches larger than this trigger a full list refresh instead of per-session requests.
    static let incrementalLimit = 200
    static let fullRefreshInterval: TimeInterval = 60

    /// `cacheKey` names an on-disk cache of the session list, so a window shows the last-known list at once.
    init(engine: EngineProcess, cacheKey: String? = nil) {
        self.engine = engine
        if let cacheKey, let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            cacheURL = caches.appendingPathComponent("dev.agentshark.app/sessions-\(cacheKey).json")
        } else {
            cacheURL = nil
        }
        engine.observeStatus { [weak self] status in self?.engineStatusChanged(status) }
        loadCache()
    }

    var api: APIClient? { engine.api }
    var isCapture: Bool { engine.captureURL != nil }

    /// Run `ready` whenever the engine (re)starts and `indexDone` after each index run, while `owner` is alive.
    func observe(owner: AnyObject, ready: @escaping @MainActor () -> Void, indexDone: @escaping @MainActor () -> Void) {
        observers.append(Observer(owner: owner, ready: ready, indexDone: indexDone))
    }

    private func notify(_ pick: (Observer) -> @MainActor () -> Void) {
        observers.removeAll { $0.owner == nil }
        for o in observers { pick(o)() }
    }

    // MARK: Engine lifecycle

    private func engineStatusChanged(_ status: EngineProcess.Status) {
        guard case .ready = status, let api = engine.api else {
            streamTask?.cancel()
            streamTask = nil
            connection = .offline
            derived.engineStopped()
            return
        }
        connection = .connecting
        connect(api)
        refreshInfo()
        loadFields()
        refreshAllSessions()
        derived.engineReady(api)
        notify { $0.ready }
    }

    private func connect(_ api: APIClient) {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            let stream = api.streamMessages { up in
                Task { @MainActor in self?.connectionChanged(up) }
            }
            do {
                for try await m in stream {
                    for e in EngineEvent.events(from: m) { self?.handle(e) }
                }
            } catch {}
        }
    }

    private func connectionChanged(_ up: Bool) {
        guard engine.api != nil else { return }
        let wasDisconnected = connection == .disconnected
        connection = up ? .connected : .disconnected
        // Index runs may have finished while the stream was down.
        if up && wasDisconnected {
            refreshInfo()
            refreshAllSessions()
            derived.refreshAll()
        }
    }

    private func handle(_ event: EngineEvent) {
        switch event {
        case .hello:
            connection = .connected
        case .indexProgress(let done, let total, let path, let since):
            runProgress = (done, total, path, since)
            if indexing != nil {
                indexing = runProgress
            } else if showIndexing == nil {
                showIndexing = Task { [weak self] in
                    try? await Task.sleep(for: Self.indexingShownAfter)
                    guard !Task.isCancelled, let self else { return }
                    self.indexing = self.runProgress
                }
            }
        case .indexDone(let changed, let truncated):
            showIndexing?.cancel()
            showIndexing = nil
            runProgress = nil
            if indexing != nil { indexing = nil }
            lastIndexDoneAt = Date()
            indexGeneration += 1
            refreshInfo()
            updateSessions(changed, all: truncated)
            derived.indexDone(changedSessions: changed, truncated: truncated)
            notify { $0.indexDone }
        case .alarm(let a):
            derived.alarmEvent(a)
        case .analysisDone(let a):
            derived.analysisDone(a)
        }
    }

    // MARK: Loading

    func refreshInfo() {
        guard let api else { return }
        Task { [weak self] in
            do {
                let info = try await api.info()
                self?.info = info
                self?.infoError = nil
            } catch let e as APIError {
                self?.infoError = e
            } catch {}
        }
    }

    private func loadFields() {
        guard let api else { return }
        Task { [weak self] in
            guard let fields = try? await api.fields() else { return }
            self?.fields = fields
            self?.fieldNames = Set(fields.map(\.name))
        }
    }

    /// Load every session, paging through the engine's list.
    func refreshAllSessions() {
        guard let api else { return }
        sessionsTask?.cancel()
        scheduledFullRefresh?.cancel()
        if sessions.isEmpty || sessionsAreCached { sessionsPhase = .loading }
        lastFullRefresh = Date()
        sessionsTask = Task { [weak self] in
            do {
                var all: [SessionRow] = []
                while true {
                    let page = try await api.sessions(limit: 20000, offset: all.count)
                    all += page.sessions
                    if page.sessions.isEmpty || all.count >= page.total { break }
                }
                guard !Task.isCancelled, let self else { return }
                self.install(all)
                self.saveCache()
            } catch is CancellationError {
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.sessionsPhase = .failed(error as? APIError ?? .unreachable(error))
            }
        }
    }

    /// Merge the sessions an index run changed. A large batch, or an incomplete list (`all`), becomes one full
    /// refresh (at most every 60 s).
    func updateSessions(_ ids: [String], all: Bool = false) {
        guard !ids.isEmpty || all, let api else { return }
        if all || ids.count > Self.incrementalLimit {
            let wait = Self.fullRefreshInterval - Date().timeIntervalSince(lastFullRefresh)
            if wait <= 0 { refreshAllSessions(); return }
            guard scheduledFullRefresh == nil else { return }
            scheduledFullRefresh = Task { [weak self] in
                try? await Task.sleep(for: .seconds(wait))
                guard !Task.isCancelled else { return }
                self?.scheduledFullRefresh = nil
                self?.refreshAllSessions()
            }
            return
        }
        Task { [weak self] in
            var fetched: [SessionRow] = []
            await withTaskGroup(of: SessionDetail?.self) { group in
                var pending = ids[...]
                func addNext() {
                    guard let id = pending.popFirst() else { return }
                    group.addTask { try? await api.session(id) }
                }
                for _ in 0..<6 { addNext() }
                while let detail = await group.next() {
                    if let detail { fetched.append(detail.session.row); fetched += detail.children }
                    addNext()
                }
            }
            self?.merge(fetched)
        }
    }

    /// Replace or add the rows an index run changed. A run changes a few of thousands of sessions, so their rows move
    /// into place and only their parents' child lists are rebuilt; sorting and indexing every session again took tens of
    /// milliseconds of the main thread on every run.
    func merge(_ rows: [SessionRow]) {
        guard !rows.isEmpty else { return }
        let changed = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        var parents = Set(changed.values.compactMap(\.parentId))
        for id in changed.keys { if let p = sessionsByID[id]?.parentId { parents.insert(p) } }
        if changed.values.contains(where: { r in sessionsByID[r.id].map { !Self.sameLabel($0, r) } ?? true }) { sessionLabelsGeneration += 1 }
        var list = sessions.filter { changed[$0.id] == nil }
        for r in changed.values {
            var lo = 0, hi = list.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if Self.listedBefore(list[mid], r) { lo = mid + 1 } else { hi = mid }
            }
            list.insert(r, at: lo)
        }
        sessions = list
        for r in changed.values { sessionsByID[r.id] = r }
        for p in parents {
            var ids = Set(childrenByParent[p] ?? [])
            ids.formUnion(changed.values.lazy.filter { $0.parentId == p }.map(\.id))
            let kids = ids.compactMap { sessionsByID[$0] }.filter { $0.parentId == p }.sorted { Self.listedBefore($1, $0) }.map(\.id)
            childrenByParent[p] = kids.isEmpty ? nil : kids
        }
        if sessionsPhase != .ready { sessionsPhase = .ready }
        if sessionsAreCached { sessionsAreCached = false }
    }

    func install(_ rows: [SessionRow]) {
        sessions = rows.sorted(by: Self.listedBefore)
        sessionsByID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        var children: [String: [String]] = [:]
        for r in sessions.reversed() {
            if let p = r.parentId { children[p, default: []].append(r.id) }
        }
        childrenByParent = children
        sessionLabelsGeneration += 1
        sessionsPhase = .ready
        sessionsAreCached = false
    }

    private static func sameLabel(_ a: SessionRow, _ b: SessionRow) -> Bool {
        a.displayTitle == b.displayTitle && a.start == b.start && a.agent == b.agent && a.role == b.role
    }

    /// The list order: latest activity first; children lists are in the reverse order.
    private static func listedBefore(_ a: SessionRow, _ b: SessionRow) -> Bool {
        (a.lastActivity ?? 0, a.id) > (b.lastActivity ?? 0, b.id)
    }

    /// Ask the live engine to index now.
    func reindex() {
        guard let api, !isCapture else { return }
        Task { _ = try? await api.reindex() }
    }

    // MARK: Session helpers

    /// A session and all of its descendants.
    func descendants(of id: String) -> [String] {
        var out: [String] = []
        var stack = [id]
        while let next = stack.popLast() {
            out.append(next)
            stack += childrenByParent[next] ?? []
        }
        return out
    }

    func title(of sessionID: String) -> String {
        sessionsByID[sessionID]?.displayTitle ?? sessionID
    }

    // MARK: Status

    var liveStatus: LiveStatus {
        switch engine.status {
        case .idle, .starting:
            return .engineStarting(isCapture ? "Opening capture…" : "Starting engine…")
        case .locatingNode:
            return .engineStarting("Locating Node.js…")
        case .restarting(let attempt):
            return .engineStarting("Restarting engine (\(attempt) of \(EngineProcess.maxRestarts))…")
        case .failed(let message):
            return .engineStopped(message)
        case .ready:
            break
        }
        if let url = engine.captureURL { return .capture(name: url.lastPathComponent, complete: info?.capture?.complete) }
        if connection == .disconnected { return .disconnected }
        if let i = indexing { return .indexing(done: i.done, total: i.total) }
        if info?.indexing.running == true { return .indexing(done: info?.indexing.done ?? 0, total: info?.indexing.total ?? 0) }
        if isFollowing { return .following(writerPid: followedWriterPid) }
        return info?.watch?.enabled == false ? .manualRefresh : .watching
    }

    /// The engine follows another writer of the index (`/api/info`, or the handshake until info arrives).
    var isFollowing: Bool { info.map(\.isFollower) ?? (engine.endpoint?.role == "follower") }
    /// The pid of the process that writes the index, when this engine follows it and the engine reports it.
    var followedWriterPid: Int? { info.map(\.followedWriterPid) ?? engine.endpoint?.writerPid }

    /// How far back the run in flight has indexed history (µs), from its progress or `/api/info`.
    var indexingSince: Int64? { indexing?.since ?? (info?.indexing.running == true ? info?.indexing.since : nil) }

    /// Short text for the toolbar indicator.
    var statusTitle: String {
        switch liveStatus {
        case .engineStarting(let s): return s
        case .engineStopped: return "Engine stopped"
        case .indexing(let done, let total):
            // A staged run indexes the newest files first (SPEC §5.1): `since` says how far back history is complete.
            let now = Int64(Date().timeIntervalSince1970 * 1e6)
            let since = indexingSince.map { " · since " + (Formatters.sameDay($0, now) ? Formatters.shortClock($0) : Formatters.shortDateTime($0)) } ?? ""
            return total > 0 ? "Indexing \(Formatters.count(done))/\(Formatters.count(total))\(since)" : "Indexing…"
        case .watching: return "Watching"
        case .following(let pid): return pid.map { "Following \($0)" } ?? "Following"
        case .manualRefresh: return "Connected · manual refresh"
        case .capture(let name, let complete):
            return complete == false ? "Capture · \(name) · truncated" : "Capture · \(name)"
        case .disconnected: return "Disconnected"
        }
    }

    /// Detail for the indicator's popover and tooltip, including the last successful index.
    var statusDetail: String {
        var lines: [String] = []
        switch liveStatus {
        case .watching: lines.append("Live index. New and changed logs are indexed automatically.")
        case .following(let pid):
            lines.append("Another AgentShark process\(pid.map { " (pid \($0))" } ?? "") writes this index. This engine serves what that process indexes and does not index itself.")
        case .manualRefresh: lines.append("Live index without a file watch. Use File ▸ Reindex Now to pick up new logs.")
        case .indexing:
            if let s = indexingSince { lines.append("Sessions active since \(Formatters.timestamp(s)) are indexed; older history follows.") }
            if let p = indexing?.path { lines.append("Indexing \(p)") }
        case .disconnected: lines.append("The connection to the engine dropped. Reconnecting automatically.")
        case .engineStopped(let m): lines.append(m)
        case .engineStarting: break
        case .capture(_, let complete):
            if let path = engine.captureURL?.path { lines.append(path) }
            if let created = captureCreated { lines.append("Created \(created)") }
            switch complete {
            case true?: lines.append("The capture stream is complete.")
            case false?: lines.append("The capture is truncated: the writer stopped early. Showing what it contains.")
            case nil: lines.append("Completeness not reported by this engine.")
            }
            if let capture = info?.capture { lines.append(contentsOf: capture.evidenceNotes) }
        }
        if let info, !isCapture {
            if let error = info.lastIndexError { lines.append("The last index run failed: \(error)") }
            if let at = info.lastIndexOkAt ?? (info.lastIndexError == nil ? info.indexing.lastRunAt : nil) {
                lines.append("Last successful index \(Formatters.timestamp(at))")
            } else if info.lastIndexError != nil {
                lines.append("No index run has succeeded since the engine started.")
            }
        }
        return lines.joined(separator: "\n")
    }

    /// The live engine's last index run failed (for example another process was updating the index).
    var lastIndexFailed: Bool { !isCapture && info?.lastIndexError != nil }

    /// Capture creation time, with its UTC offset, when the engine reports it.
    var captureCreated: String? {
        if let us = info?.capture?.createdAt { return Formatters.timestamp(us) }
        guard let header = info?.capture?.header else { return nil }
        for key in ["created", "createdAt", "created_at", "ts"] {
            if let us = header[key]?.int64Value { return Formatters.timestamp(us > 10_000_000_000_000 ? us : us * 1000) }
            if let s = header[key]?.stringValue { return s }
        }
        return nil
    }

    // MARK: Cache

    private func loadCache() {
        guard let cacheURL else { return }
        Task { [weak self] in
            let rows = await Task.detached(priority: .userInitiated) { () -> [SessionRow]? in
                guard let data = try? Data(contentsOf: cacheURL) else { return nil }
                return try? JSONDecoder().decode([SessionRow].self, from: data)
            }.value
            guard let rows, let self, self.sessions.isEmpty else { return }
            self.install(rows)
            self.sessionsAreCached = true
        }
    }

    private func saveCache() {
        guard let cacheURL else { return }
        let rows = sessions
        Task.detached(priority: .background) {
            guard let data = try? JSONEncoder().encode(rows) else { return }
            try? FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: cacheURL, options: .atomic)
        }
    }
}
