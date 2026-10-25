import Foundation
import Observation

/// What one engine knows about the derived model (SPEC §12): sidebar marks, firing alarms and the whole-index
/// attention count for the status bar. Owned by `EngineStore`; every window of that engine reads it.
///
/// Alarms depend on the clock (`stall`, expiry), so the firing list is re-read on `alarm` and `index-done`, and at
/// least every 60 s while a run is possibly running (MAC-CONTRACT §5.6).
@MainActor @Observable final class DerivedStore {
    enum Availability: Hashable, Sendable {
        /// Not asked yet.
        case unknown
        case available
        /// The engine predates the agent-native routes.
        case missingRoutes
    }

    private(set) var availability: Availability = .unknown
    /// Sidebar marks by session id. A session left out is clean unless `marksGaps` lists a pending or outdated analysis.
    private(set) var marks: [String: SessionMark] = [:]
    private(set) var marksGaps: [Gap] = []
    private(set) var firingAlarms: [AlarmItem] = []
    /// Whole index: "3 need attention · 1 alarm".
    private(set) var summary: FailuresSummary?
    /// Increments when marks, alarms or the summary change, and after every analysis pass (views refresh on it).
    private(set) var generation = 0

    /// Called for each `alarm` stream event that fired (notifications).
    @ObservationIgnored var onAlarmFired: ((AlarmStreamEvent) -> Void)?
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var clockTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var lastSummaryAt = Date.distantPast

    static let clockInterval: TimeInterval = 60
    /// Whole-index summaries after index runs come at most this often.
    static let summaryInterval: TimeInterval = 20

    var isAvailable: Bool { availability == .available }
    var needAttention: Int? { summary?.needAttention }
    var openAlarms: Int { firingAlarms.count }
    /// The analysis has not run on part of the index (marks may be missing rather than clean).
    var analysisIncomplete: Bool { marksGaps.contains { $0.code == .analysisPending || $0.code == .analysisOutdated } }
    var hasLiveRun: Bool { marks.values.contains { $0.possiblyRunning } }

    // MARK: Engine lifecycle

    func engineReady(_ api: APIClient) {
        self.api = api
        availability = .unknown
        refreshAll()
        startClock()
    }

    func engineStopped() {
        api = nil
        clockTask?.cancel()
        clockTask = nil
    }

    func indexDone(changedSessions: [String], truncated: Bool) {
        refreshMarks(ids: truncated ? [] : changedSessions)
        refreshAlarms()
        if Date().timeIntervalSince(lastSummaryAt) >= Self.summaryInterval { refreshSummary() }
        generation += 1
    }

    /// An analysis pass finished: views that show derived data refresh.
    func analysisDone(_ a: IndexDoneAnalysis) {
        generation += 1
    }

    func alarmEvent(_ a: AlarmStreamEvent) {
        if a.state == .firing { onAlarmFired?(a) }
        refreshAlarms()
        refreshMarks(ids: [a.sessionId])
    }

    /// Reload marks, alarms and the summary now (Retry, a new engine).
    func refreshAll() {
        refreshMarks(ids: [])
        refreshAlarms()
        refreshSummary()
    }

    // MARK: Loading

    private func noteFailure(_ error: Error) {
        if let e = error as? APIError, e.isNotServed { availability = .missingRoutes }
    }

    /// `ids` empty: every marked session; otherwise those sessions only (merged).
    func refreshMarks(ids: [String]) {
        guard let api, availability != .missingRoutes else { return }
        Task { [weak self] in
            do {
                let page = try await api.sessionMarks(ids: ids)
                guard let self else { return }
                self.availability = .available
                if ids.isEmpty {
                    self.marks = Dictionary(page.rows.map { ($0.sessionId, $0) }, uniquingKeysWith: { _, b in b })
                } else {
                    var m = self.marks
                    for id in ids { m[id] = nil }
                    for r in page.rows { m[r.sessionId] = r }
                    self.marks = m
                }
                self.marksGaps = page.gaps
                self.generation += 1
            } catch {
                self?.noteFailure(error)
            }
        }
    }

    func refreshAlarms() {
        guard let api, availability != .missingRoutes else { return }
        Task { [weak self] in
            do {
                let page = try await api.alarms(.global, state: .firing, limit: 500)
                guard let self else { return }
                self.availability = .available
                if page.rows != self.firingAlarms {
                    self.firingAlarms = page.rows
                    self.generation += 1
                }
            } catch {
                self?.noteFailure(error)
            }
        }
    }

    func refreshSummary() {
        guard let api, availability != .missingRoutes else { return }
        lastSummaryAt = Date()
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            do {
                let s = try await api.failuresSummary(.global)
                guard !Task.isCancelled, let self else { return }
                self.availability = .available
                self.summary = s
            } catch {
                self?.noteFailure(error)
            }
        }
    }

    /// The clock re-reads alarms while a run may be live: `stall` and expiry never arrive by SSE.
    private func startClock() {
        clockTask?.cancel()
        clockTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.clockInterval))
                guard !Task.isCancelled, let self else { return }
                if self.hasLiveRun || !self.firingAlarms.isEmpty {
                    self.refreshAlarms()
                    self.refreshMarks(ids: self.marks.values.filter { $0.possiblyRunning || $0.firingAlarms > 0 }.map(\.sessionId))
                }
            }
        }
    }

    // MARK: Lookups

    func alarm(id: String) -> AlarmItem? { firingAlarms.first { $0.id == id } }

    /// The worst mark of a session and its descendants, for a collapsed sidebar parent.
    func subtreeMark(_ id: String, children: [String: [String]]) -> SessionMark? {
        var best = marks[id]
        var stack = children[id] ?? []
        var seen: Set<String> = [id]
        while let next = stack.popLast() {
            guard seen.insert(next).inserted else { continue }
            stack += children[next] ?? []
            guard let m = marks[next] else { continue }
            guard var b = best else { best = m; continue }
            if (m.worstImpact?.rank ?? 99) < (b.worstImpact?.rank ?? 99) { b.worstImpact = m.worstImpact }
            b.silentChildren += m.silentChildren
            b.firingAlarms += m.firingAlarms
            b.needAttention += m.needAttention
            b.possiblyRunning = b.possiblyRunning || m.possiblyRunning
            best = b
        }
        return best
    }
}
