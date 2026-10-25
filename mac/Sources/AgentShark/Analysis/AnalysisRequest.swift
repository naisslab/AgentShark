import Foundation
import Observation

// MARK: - What to compute

/// One analysis a window asks the engine for (ANALYSIS-UX §4.1, §5.3).
struct AnalysisSpec<Value: Sendable>: Sendable {
    /// `perf|<session>` or `diff|A|B|children|limit`; equal keys share one cached result.
    let key: String
    /// The analysed root runs: the result is stale once one of them records later activity.
    let runs: [String]
    let fetch: @Sendable (any WorkbenchClient) async throws -> Value
}

extension AnalysisSpec where Value == PerfResult {
    /// Critical Path: the whole run of `session`, subagents included.
    static func perf(session: String) -> AnalysisSpec {
        AnalysisSpec(key: "perf|" + session, runs: [session]) { try await $0.perf(session: session) }
    }
}

extension AnalysisSpec where Value == DiffResult {
    /// Compare: run A (`left`) aligned with run B (`right`). A nil `limit` keeps the engine's 1,500 actions per run.
    static func diff(left: String, right: String, children: Bool = true, limit: Int? = nil) -> AnalysisSpec {
        let key = ["diff", left, right, String(children), limit.map(String.init) ?? ""].joined(separator: "|")
        return AnalysisSpec(key: key, runs: [left, right]) { try await $0.diff(left: left, right: right, children: children, limit: limit) }
    }
}

/// What a window's analyses read from the window. The requests observe `workbenchClient` and `indexGeneration`, so a
/// host whose reads are observable needs no calls when the engine comes up or an index run finishes.
@MainActor protocol AnalysisHost: AnyObject {
    /// The engine's client; nil while the engine is down.
    var workbenchClient: (any WorkbenchClient)? { get }
    /// Results by key, kept for the window's life, so Back and Forward restore an analysis without a request.
    var panels: PanelCache { get }
    /// Increments after every finished index run.
    var indexGeneration: Int { get }
    /// A run's `SessionRow.end`; nil while its row is not loaded.
    func runEnd(_ session: String) -> Int64?
}

extension WindowModel: AnalysisHost {
    var workbenchClient: (any WorkbenchClient)? { engine.api }
    var indexGeneration: Int { store.indexGeneration }
    func runEnd(_ session: String) -> Int64? { store.sessionsByID[session]?.end }
}

// MARK: - The window's analyses

/// The analyses of one window (`WindowModel.analyses`). Critical Path and Compare share one request slot, so the window
/// never has more than one analysis in flight. The requests hold their host weakly.
@MainActor final class WindowAnalyses {
    let perf: AnalysisRequest<PerfResult>
    let diff: AnalysisRequest<DiffResult>

    init(host: any AnalysisHost, clock: any Clock<Duration> = ContinuousClock()) {
        let gate = AnalysisGate()
        perf = AnalysisRequest(host: host, gate: gate, clock: clock)
        diff = AnalysisRequest(host: host, gate: gate, clock: clock)
    }

    /// A run's title from the shown Critical Path or Compare result (its `sessions` map, analysis 1.1), which names
    /// every run the result covers whether or not the catalog has loaded it; nil when neither result has a title.
    func runTitle(of session: String) -> String? {
        perf.value?.sessions?[session]?.title ?? diff.value?.sessions?[session]?.title
    }
}

/// The window's one analysis slot (ANALYSIS-UX decision 14). The engine finishes a job even after the client stops
/// listening, and holds one of its two query workers until then, so the slot stays taken until the response arrives,
/// whether or not anyone still wants it.
@MainActor final class AnalysisGate {
    /// The key whose request the engine is running.
    private(set) var running: String?
    private var finished: Task<Void, Never>?

    /// Runs `job` once no other request of the window is in flight, unless `skip` then says nobody wants it any more
    /// (nil, nothing sent); `onStart` runs just before it is sent. A caller cancelled while it waits sends nothing; one
    /// cancelled after its job started still waits for the response.
    func run<T: Sendable>(_ key: String, skip: () -> Bool = { false }, onStart: () -> Void,
                          _ job: @escaping @Sendable () async throws -> T) async throws -> T? {
        while let previous = finished { await previous.value }
        try Task.checkCancellation()
        if skip() { return nil }
        onStart()
        running = key
        let task = Task { try await job() }
        finished = Task { [weak self] in
            _ = await task.result
            self?.running = nil
            self?.finished = nil
        }
        return try await task.value
    }
}

// MARK: - Request policy

/// The request policy of one analysis in one window (ANALYSIS-UX decision 14, §4.1, §5.3). Analyses run on the
/// engine's two query workers, which also serve the event table, and a timeout kills a worker with the views built in
/// it. So:
/// - nothing is requested while the view is hidden or the engine is down;
/// - a request starts once its key has been unchanged for 400 ms;
/// - the window has at most one request in flight, and the latest key wins: a request or Refresh still waiting for the
///   slot when its key is left or hidden is never sent, and one the engine already runs finishes into its own key's
///   cache without being shown;
/// - results stay in the window's `PanelCache` by key, the most recent few of them;
/// - a result whose run has recorded later activity is marked stale, and is computed again only on Refresh;
/// - a request the engine refused while indexing (503 `workbench-unavailable`) runs again after the next index run,
///   once per run;
/// - a request the engine went down under (Engine ▸ Restart while it loads) runs again once the engine is up, once per
///   engine start.
@MainActor @Observable final class AnalysisRequest<Value: Sendable> {
    typealias Phase = PanelRequest<Value>.Phase

    /// The key of the analysis the view shows; nil when there is nothing to analyse.
    private(set) var key: String?
    /// Set by the view as it appears and disappears.
    var isVisible = false {
        didSet {
            guard isVisible != oldValue else { return }
            if isVisible {
                if let key { withdrawn.remove(key) }
                schedule()
                retryAfterIndexing()
            } else {
                hidden()
            }
        }
    }
    /// Each key's runs with their `SessionRow.end` when its request started (the stale rule).
    private var basis: [String: [String: Int64?]] = [:]

    @ObservationIgnored private weak var host: (any AnalysisHost)?
    @ObservationIgnored private let gate: AnalysisGate
    @ObservationIgnored private let clock: any Clock<Duration>
    @ObservationIgnored private let settleDelay: Duration
    /// Results are megabytes (a diff carries up to 3,000 aligned rows), so only this many keys keep theirs.
    @ObservationIgnored private let retained: Int
    @ObservationIgnored private var spec: AnalysisSpec<Value>?
    @ObservationIgnored private var settling: Task<Void, Never>?
    /// The index generation and the engine stop count (`engineStops`) each key's request started in.
    @ObservationIgnored private var startedIn: [String: (index: Int, engine: Int)] = [:]
    /// The engine was up when the host was last read.
    @ObservationIgnored private var engineUp = false
    /// How often the engine went down while this request watched it, which tells a request sent before the engine
    /// last stopped from one sent since.
    @ObservationIgnored private var engineStops = 0
    /// Keys with a result or a request, least recently shown first.
    @ObservationIgnored private var recent: [String] = []
    /// Keys whose Refresh was left while it waited for the slot: it is not sent, and the result it would have replaced
    /// stays.
    @ObservationIgnored private var withdrawn: Set<String> = []

    init(host: any AnalysisHost, gate: AnalysisGate, clock: any Clock<Duration> = ContinuousClock(),
         settleDelay: Duration = .milliseconds(400), retained: Int = 6) {
        self.host = host
        self.gate = gate
        self.clock = clock
        self.settleDelay = settleDelay
        self.retained = max(1, retained)
        observeHost()
    }

    /// The current key's request in the window's cache.
    var current: PanelRequest<Value>? {
        guard let key, let host else { return nil }
        return host.panels.request(key, Value.self)
    }

    /// What the view shows. A key still settling, waiting for the window's slot, or waiting for the engine reads as
    /// loading, as does one whose request the engine went down under, so a view checks `isWaitingForEngine` first
    /// (ANALYSIS-UX §4.11 puts Engine down before Loading).
    var phase: Phase {
        guard let key, let current else { return .idle }
        return startsByItself(current, key: key) ? .loading : current.phase
    }

    var value: Value? { current?.value }

    /// A Refresh is running while the previous result stays on screen.
    var isRefreshing: Bool { current?.isRefreshing ?? false }

    /// There is something to analyse but the engine is down; the request starts by itself once the engine is up.
    var isWaitingForEngine: Bool { key != nil && host?.workbenchClient == nil }

    /// A run recorded activity after the shown result was computed: the view shows "Run changed since this
    /// analysis · Refresh" (ANALYSIS-UX §4.1). Reading it tracks the window's session rows.
    var isStale: Bool {
        guard let key, let host, current?.value != nil, let recorded = basis[key] else { return false }
        return recorded.contains { session, end in
            guard let end, let now = host.runEnd(session) else { return false }
            return now != end
        }
    }

    /// Show `spec`'s analysis, or nothing. Call it whenever the key changes: with the same key it only starts a request
    /// the view still lacks.
    func want(_ spec: AnalysisSpec<Value>?) {
        self.spec = spec
        if spec?.key == key {
            schedule()
            return
        }
        settling?.cancel()
        settling = nil
        if let key { withdraw(key) }
        key = spec?.key
        if let key {
            withdrawn.remove(key)
            if current?.value != nil { touch(key) }
        }
        schedule()
    }

    /// The stale bar's Refresh: compute the current key again, keeping its result on screen until the new one arrives.
    func refresh() {
        guard let spec, value != nil, !isRefreshing else { return }
        start(spec, keepValue: true)
    }

    /// Retry after a failure.
    func retry() {
        guard let spec, case .failed? = current?.phase else { return }
        start(spec, keepValue: false)
    }

    /// Retry a request the engine refused while indexing, at most once per index run. The request observes the host's
    /// index generation and does this by itself.
    func indexAdvanced() {
        retryAfterIndexing()
    }

    // MARK: Private

    /// Follow the engine and the index: count the engine's stops, start a request the engine was down for or went down
    /// under, and retry one refused while indexing.
    private func observeHost() {
        guard let host else { return }
        engineUp = withObservationTracking {
            _ = host.indexGeneration
            return host.workbenchClient != nil
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let wasUp = self.engineUp
                self.observeHost()
                if wasUp, !self.engineUp { self.engineStops += 1 }
                self.schedule()
                self.retryAfterIndexing()
            }
        }
    }

    /// The key's request starts by itself once the view shows and the engine is up (§4.11): it has no result, request
    /// or failure yet, or it failed for want of the engine, as Engine ▸ Restart fails a request in flight. That is a
    /// transport failure (no HTTP status) of a request sent before the engine last stopped, so it runs again once per
    /// engine start; one that fails again before the engine stops shows its failure with Retry.
    private func startsByItself(_ request: PanelRequest<Value>, key: String) -> Bool {
        switch request.phase {
        case .idle: return true
        case .failed(let e): return e.isUnreachable && engineStops > startedIn[key]?.engine ?? -1
        case .loading, .loaded: return false
        }
    }

    /// Start the settle delay when the view is visible, the engine is up, and its key's request starts by itself.
    private func schedule() {
        guard isVisible, settling == nil, host?.workbenchClient != nil, let key, let current, startsByItself(current, key: key) else { return }
        settling = Task { [weak self, clock, settleDelay] in
            do { try await clock.sleep(for: settleDelay) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.settling = nil
            guard self.isVisible, self.key == key, let spec = self.spec else { return }
            self.start(spec, keepValue: false)
        }
    }

    private func start(_ spec: AnalysisSpec<Value>, keepValue: Bool) {
        guard let host, let api = host.workbenchClient else { return }
        let key = spec.key
        touch(key)
        withdrawn.remove(key)
        let request = host.panels.request(key, Value.self)
        let replaced = keepValue ? request.value : nil
        request.load(key: key, force: true, keepValue: keepValue) { [weak self, gate] in
            let skip = { self.map { $0.withdrawn.remove(key) != nil } ?? true }
            let value: Value?
            do {
                value = try await gate.run(key, skip: skip, onStart: { self?.started(spec) }, { try await spec.fetch(api) })
            } catch {
                // Once the failure is set: a request the engine went down under starts again if the engine is back.
                Task { [weak self] in self?.schedule() }
                throw error
            }
            guard let value else {
                // A withdrawn Refresh: the result it would have replaced stays, still stale.
                if let replaced { return replaced }
                throw CancellationError()
            }
            self?.received(value, for: spec)
            return value
        }
    }

    private func started(_ spec: AnalysisSpec<Value>) {
        guard let host else { return }
        basis[spec.key] = Dictionary(spec.runs.map { ($0, host.runEnd($0)) }, uniquingKeysWith: { first, _ in first })
        startedIn[spec.key] = (host.indexGeneration, engineStops)
    }

    /// A run whose `SessionRow` was not loaded when the request started takes its end from the result's `sessions` map
    /// (analysis 1.1.0), so the stale rule covers it too.
    private func received(_ value: Value, for spec: AnalysisSpec<Value>) {
        guard let sessions = (value as? any WorkbenchResult)?.sessions, var runs = basis[spec.key] else { return }
        for (run, end) in runs where end == nil {
            runs.updateValue(sessions[run]?.endTs, forKey: run)
        }
        basis[spec.key] = runs
    }

    private func hidden() {
        settling?.cancel()
        settling = nil
        if let key { withdraw(key) }
    }

    /// `key` left the screen. A request still waiting for the slot is never sent, and a Refresh waiting for it keeps
    /// the result it would have replaced. One the engine runs already is kept: the engine finishes it anyway, and its
    /// result fills `key`'s cache for when the view comes back.
    private func withdraw(_ key: String) {
        guard gate.running != key, let host else { return }
        let request = host.panels.request(key, Value.self)
        if request.isRefreshing {
            withdrawn.insert(key)
        } else if request.isLoading {
            request.cancel()
        }
    }

    private func retryAfterIndexing() {
        guard isVisible, let spec, let host, case .failed(let e)? = current?.phase, e.isWorkbenchUnavailable,
              host.indexGeneration > startedIn[spec.key]?.index ?? -1 else { return }
        start(spec, keepValue: false)
    }

    /// Mark `key` most recently shown, and drop the results of keys past `retained`.
    private func touch(_ key: String) {
        recent.removeAll { $0 == key }
        recent.append(key)
        while recent.count > retained, let host {
            let old = recent.removeFirst()
            host.panels.request(old, Value.self).cancel()
            basis[old] = nil
            startedIn[old] = nil
            withdrawn.remove(old)
        }
    }
}
