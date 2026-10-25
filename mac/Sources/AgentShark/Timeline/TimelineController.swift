import AppKit
import Observation

/// State and data of one Timeline workspace: what to draw (overview or session tracks), where (viewport, idle gaps),
/// and how it follows the window (scope, view density, selection). `TimelineView` draws it; `TimelineWorkspace`
/// shows its status. Hot drawing state is not observed, so panning never re-renders SwiftUI.
///
/// Scope contract (SPEC §7.8): the session set picks the tracks; the time range zooms (and dims the rest); the
/// display filter appears only as the density of the current view. A failed load shows Retry and never falls back
/// to other data; a failed refresh keeps the earlier data marked stale.
@MainActor @Observable final class TimelineController {
    enum Mode: Equatable { case overview, sessions }
    enum Phase: Equatable { case idle, loading, failed(APIError), ready }
    /// What the footer describes: the selected span, process or delegation, or the selected session bar in the overview.
    enum Focus: Equatable {
        case span(SpanRow)
        case session(OverviewSession)
        case process(ProcessItem)
        case delegation(DelegationItem)
    }

    let model: WindowModel
    private(set) var mode: Mode = .overview
    private(set) var phase: Phase = .idle
    /// A reload is running while earlier data stays on screen.
    private(set) var isRefreshing = false
    /// A refresh failed; the drawn data is stale.
    private(set) var refreshError: APIError?
    private(set) var trackCount = 0
    private(set) var spanCount = 0
    private(set) var sessionCount = 0
    private(set) var treeTruncated = false
    /// Spans shown are at least this long (level of detail), when the session has more spans than one request holds.
    private(set) var lodMinDur: Double?
    /// Even at this level of detail the engine returned only the longest spans.
    private(set) var lodTruncated = false
    private(set) var focus: Focus?

    // MARK: Drawing state (not observed)

    @ObservationIgnored private(set) var layout = TimelineLayout()
    @ObservationIgnored private(set) var viewport = TimeViewport(t0: 0, k: 1e-6)
    @ObservationIgnored private(set) var extent: (lo: Double, hi: Double)?
    @ObservationIgnored private(set) var density: [Histogram] = []
    @ObservationIgnored private(set) var densityViewID: String?
    /// Highlighted item (span or overview session ID).
    @ObservationIgnored private(set) var highlighted: String?
    /// Time of the selected event, when it belongs to a drawn track.
    @ObservationIgnored private(set) var marker: Double?
    @ObservationIgnored var hover: TimelineHit?
    /// An inspection range being dragged, in time.
    @ObservationIgnored var brush: (from: Double, to: Double)?
    @ObservationIgnored weak var view: TimelineView?
    /// Width of the time plot; the view sets it.
    @ObservationIgnored var plotWidth: Double = 0 {
        didSet {
            guard plotWidth != oldValue, plotWidth > 0 else { return }
            updateMinK()
            if fitted || oldValue <= 0 { fit(animated: false) } else { setViewport(viewport) }
        }
    }

    @ObservationIgnored private var gaps: [TimeGap] = []
    @ObservationIgnored private var busy: [(start: Double, end: Double?)] = []
    @ObservationIgnored private var overviewSessions: [OverviewSession] = []
    @ObservationIgnored private var nodes: [TimelineNode] = []
    @ObservationIgnored private var spans: [SpanRow] = []
    @ObservationIgnored private var collapsed: Set<String> = []
    @ObservationIgnored private var zoomHistory: [TimeViewport] = []
    @ObservationIgnored private var fitted = true
    @ObservationIgnored private var minK = 0.0
    @ObservationIgnored private var loadSeq = 0
    @ObservationIgnored private var scopeKey: String?
    @ObservationIgnored private var generation = -1
    @ObservationIgnored private var lastLoadAt = Date.distantPast
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var lastTimeRange: [Int64?] = [nil, nil]
    @ObservationIgnored private var gapSettings: (Bool, Int64) = (true, 0)
    @ObservationIgnored private var lod: [LodEntry] = []
    @ObservationIgnored private var appliedLod = ""
    @ObservationIgnored private var lodTask: Task<Void, Never>?
    @ObservationIgnored private var densityTask: Task<Void, Never>?
    @ObservationIgnored private var densityLoaded: TimelineData.DensityKey?
    @ObservationIgnored private var syncedEvent: String?
    @ObservationIgnored private var ownSelection: String?
    @ObservationIgnored private var animation: (from: TimeViewport, to: TimeViewport, start: CFTimeInterval, fitted: Bool)?
    /// Failure bands by session: unrecovered episodes and recoveries that took ≥ 3 attempts (SPEC §12.7 Timeline).
    @ObservationIgnored private(set) var bands: [String: [EpisodeItem]] = [:]
    @ObservationIgnored private var bandsTask: Task<Void, Never>?
    /// Bands drawn, for the status line.
    private(set) var bandCount = 0
    /// Context points by session for the optional Context lane (SPEC §12.7 Timeline), loaded while it is shown.
    @ObservationIgnored private(set) var context: [String: [ContextPoint]] = [:]
    @ObservationIgnored private var contextTask: Task<Void, Never>?
    @ObservationIgnored private var contextShown = false
    /// Sessions with a Context lane, for the status line.
    private(set) var contextLaneCount = 0
    private(set) var contextLoading = false
    /// Process and delegation lanes by session (SPEC §12.7 Timeline).
    @ObservationIgnored private(set) var lanes: [String: TimelineLanes] = [:]
    @ObservationIgnored private var lanesTask: Task<Void, Never>?
    /// Processes and delegations drawn, for the status line.
    private(set) var processCount = 0
    private(set) var delegationCount = 0
    /// Time buckets of the turns drawn wide enough for a strip, loaded as they come into view (`/api/time?turn=`).
    @ObservationIgnored private(set) var turnTimes: [String: TimeBreakdown] = [:]
    @ObservationIgnored private var turnTimesRequested: Set<String> = []
    @ObservationIgnored private var turnTimesTask: Task<Void, Never>?
    /// Overview: unrecovered episodes by session, for the ticks on the session bars.
    @ObservationIgnored private(set) var ticks: [String: [EpisodeItem]] = [:]
    @ObservationIgnored private var ticksTask: Task<Void, Never>?
    @ObservationIgnored private var ticksLoadedAt = Date.distantPast
    /// Ticks drawn in the overview, for the status line; partial when only the newest episodes were read.
    private(set) var tickCount = 0
    private(set) var ticksPartial = false

    static let refreshInterval: TimeInterval = 5
    static let animationDuration: CFTimeInterval = 0.25

    init(model: WindowModel) {
        self.model = model
        let p = model.app.preferences
        gapSettings = (p.collapseIdleGaps, p.idleGapMicroseconds)
        contextShown = p.showContextLane
        observe()
    }

    private var preferences: Preferences { model.app.preferences }

    // MARK: Scale

    var activeGaps: [TimeGap] { gapSettings.0 ? gaps : [] }
    var scale: TimeScale { TimeScale(viewport, gaps: activeGaps) }
    var hasData: Bool { !layout.tracks.isEmpty }

    // MARK: Following the window

    private func observe() {
        withObservationTracking {
            _ = model.scope
            _ = model.view
            _ = model.viewError
            _ = model.eventDetail
            _ = model.selectedEvent
            _ = model.inspectionRange
            _ = model.store.indexGeneration
            _ = model.engine.api
            _ = preferences.collapseIdleGaps
            _ = preferences.idleGapMinutes
            _ = preferences.showContextLane
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.observe()
                self.sync()
            }
        }
    }

    /// Bring the timeline up to date with the window.
    func sync() {
        guard let api = model.engine.api else {
            if !hasData { phase = .idle }
            return
        }
        let key = api.endpoint.baseURL.absoluteString + "\n" + model.scope.sessions.joined(separator: "\n")
        if key != scopeKey {
            load(newScope: true)
        } else if model.store.indexGeneration != generation {
            scheduleRefresh()
        }
        let range = [model.scope.from, model.scope.to]
        if range != lastTimeRange {
            lastTimeRange = range
            // Filter to Range from the menu: the applied range is now the scope, so it is no longer an inspection range.
            if let r = model.inspectionRange, model.scope.from == r.lowerBound, model.scope.to == r.upperBound { model.inspectionRange = nil }
            if hasData { fit(animated: true) }
        }
        let settings = (preferences.collapseIdleGaps, preferences.idleGapMicroseconds)
        if settings != gapSettings { applyGapSettings(settings) }
        if preferences.showContextLane != contextShown {
            contextShown = preferences.showContextLane
            if mode == .sessions { loadContext(roots: model.scope.sessions) }
        }
        if model.view?.viewId != densityViewID {
            density = []
            densityViewID = model.view?.viewId
            densityLoaded = nil
        }
        requestDensity(immediately: true)
        syncSelection()
        view?.redrawAll()
    }

    /// Retry after a failure: repeats the same request.
    func retry() {
        refreshError = nil
        load(newScope: !hasData)
    }

    private func scheduleRefresh() {
        guard refreshTask == nil else { return }
        let wait = Self.refreshInterval - Date().timeIntervalSince(lastLoadAt)
        refreshTask = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled, let self else { return }
            self.refreshTask = nil
            self.load(newScope: false)
        }
    }

    // MARK: Loading

    private func load(newScope: Bool) {
        guard let api = model.engine.api else { return }
        refreshTask?.cancel()
        refreshTask = nil
        loadSeq += 1
        let seq = loadSeq
        let ids = model.scope.sessions
        let generation = model.store.indexGeneration
        scopeKey = api.endpoint.baseURL.absoluteString + "\n" + ids.joined(separator: "\n")
        self.generation = generation
        lastLoadAt = Date()
        if newScope {
            phase = .loading
            refreshError = nil
            install(TimelineLayout())
            focus = nil
            highlighted = nil
            marker = nil
            syncedEvent = nil
            zoomHistory = []
            collapsed = []
            extent = nil
            lastTimeRange = [model.scope.from, model.scope.to]
        }
        isRefreshing = true
        Task { [weak self] in
            do {
                if ids.isEmpty {
                    let sessions = try await TimelineData.overview(api: api, generation: generation)
                    guard let self, seq == self.loadSeq else { return }
                    self.installOverview(sessions, newScope: newScope)
                } else {
                    // The engine adds descendants to a span query, so spans load beside the tree.
                    async let spansRequest = api.spans(sessions: ids, from: nil, to: nil, limit: TimelineData.spanLimit)
                    let tree = try await TimelineData.sessionTree(roots: ids, api: api, generation: generation)
                    let list = try await spansRequest
                    guard let self, seq == self.loadSeq else { return }
                    self.installSessions(tree.nodes, truncated: tree.truncated, spans: list, newScope: newScope)
                }
                guard let self, seq == self.loadSeq else { return }
                self.phase = .ready
                self.refreshError = nil
                self.isRefreshing = false
            } catch {
                guard let self, seq == self.loadSeq else { return }
                let e = error as? APIError ?? .unreachable(error)
                self.isRefreshing = false
                if self.hasData && !newScope {
                    self.refreshError = e
                } else {
                    self.phase = .failed(e)
                }
            }
        }
    }

    private func installOverview(_ sessions: [OverviewSession], newScope: Bool) {
        mode = .overview
        bands = [:]
        bandCount = 0
        lanesTask?.cancel()
        lanes = [:]
        processCount = 0
        delegationCount = 0
        contextTask?.cancel()
        context = [:]
        contextLaneCount = 0
        overviewSessions = sessions
        nodes = []
        spans = []
        lod = []
        lodMinDur = nil
        lodTruncated = false
        treeTruncated = false
        sessionCount = sessions.count
        busy = sessions.map { (start: Double($0.start ?? 0), end: $0.end.map(Double.init)) }
        extent = Self.extent(sessions.compactMap { s in s.start.map { (Double($0), Double(s.end ?? $0)) } })
        finishInstall(newScope: newScope)
        loadTicks(force: newScope)
    }

    private func installSessions(_ tree: [TimelineNode], truncated: Bool, spans list: SpanList, newScope: Bool) {
        mode = .sessions
        overviewSessions = []
        ticksTask?.cancel()
        ticks = [:]
        tickCount = 0
        if newScope {
            turnTimes = [:]
            turnTimesRequested = []
            lanes = [:]
        } else {
            // A live refresh: the open turns' buckets grow, so ask for them again.
            turnTimesRequested.subtract(list.spans.filter { $0.kind == .turn && ($0.end == nil || $0.status == .open) }.map(\.id))
        }
        nodes = tree
        spans = list.spans
        treeTruncated = truncated
        sessionCount = tree.count
        // A truncated first list holds every span at least as long as its shortest one (the engine keeps the longest),
        // so it is complete at that level of detail and serves zoomed-out views.
        let shortest = list.spans.compactMap { sp in sp.dur ?? sp.end.map { $0 - sp.start } }.min().map(Double.init) ?? 0
        lod = list.truncated ? [LodEntry(from: -.infinity, to: .infinity, minDur: shortest, spans: list.spans, truncated: false)] : []
        appliedLod = lod.first?.key ?? ""
        lodMinDur = list.truncated ? shortest : nil
        lodTruncated = false
        // Idle means no calls: turns and sessions count only at their ends, so a turn or a subagent that waits for
        // hours with nothing running still collapses.
        busy = []
        for sp in list.spans where sp.kind != .session {
            if sp.kind == .turn {
                busy.append((start: Double(sp.start), end: nil))
                if let e = sp.end { busy.append((start: Double(e), end: nil)) }
            } else {
                busy.append((start: Double(sp.start), end: sp.end.map(Double.init)))
            }
        }
        for n in tree {
            if let a = n.session.start { busy.append((start: Double(a), end: nil)) }
            if let b = n.session.end { busy.append((start: Double(b), end: nil)) }
        }
        var points = tree.compactMap { n in n.session.start.map { (Double($0), Double(n.session.end ?? $0)) } }
        points += list.spans.map { (Double($0.start), Double($0.end ?? $0.start)) }
        extent = Self.extent(points)
        finishInstall(newScope: newScope)
        loadBands(roots: model.scope.sessions)
        loadLanes(roots: model.scope.sessions)
        loadContext(roots: model.scope.sessions)
        requestTurnTimes()
    }

    // MARK: Failure bands

    /// Whether an episode gets a band: unrecovered (red, hatched) or a recovery that took ≥ 3 attempts (amber). The
    /// rule is the web's `bandKind` (web/js/views/timeline.js), so both clients band the same episodes.
    static func isBand(_ e: EpisodeItem) -> Bool {
        isUnrecoveredBand(e) || ((e.outcome == .recovered || e.outcome == .recoveredLater) && e.nAttempts >= 3)
    }

    static func isUnrecoveredBand(_ e: EpisodeItem) -> Bool {
        e.section.rawValue == "unrecovered" || e.section.rawValue == "blocked" || e.outcome == .endedOnFailure
    }

    /// The mark after a band's end, by outcome (§7.12 Failure bands): failed for an unrecovered band, recovered for an
    /// amber one; an episode still open at its last event has none (its band reaches the live edge).
    static func endMark(_ o: EpisodeOutcome) -> Mark? {
        switch o.rawValue {
        case "recovered", "parallel-ok", "recovered-later": return .recovered
        case "pivoted": return .degraded
        case "interrupted": return .interrupted
        case "ended-on-failure": return .failed
        default: return nil
        }
    }

    private func loadBands(roots: [String]) {
        bandsTask?.cancel()
        guard let api = model.engine.api, !roots.isEmpty, model.derived.availability != .missingRoutes else {
            bands = [:]
            bandCount = 0
            return
        }
        let seq = loadSeq
        bandsTask = Task { [weak self] in
            var found: [EpisodeItem] = []
            for root in roots.prefix(8) {
                guard let page = try? await api.episodes(DerivedScopeQuery(session: root, descendants: true), limit: 5000) else { continue }
                found += page.rows.filter(Self.isBand)
            }
            guard !Task.isCancelled, let self, seq == self.loadSeq else { return }
            self.bands = Dictionary(grouping: found, by: \.sessionId)
            self.bandCount = found.count
            // The Failures lane needs room in its track.
            self.relayout()
        }
    }

    // MARK: Process and delegation lanes

    /// Load the processes and delegations of each root tree (at most 8 roots) and lay out their lanes.
    private func loadLanes(roots: [String]) {
        lanesTask?.cancel()
        guard let api = model.engine.api, !roots.isEmpty, model.derived.availability != .missingRoutes else {
            if !lanes.isEmpty {
                lanes = [:]
                relayout()
            }
            processCount = 0
            delegationCount = 0
            return
        }
        let seq = loadSeq
        lanesTask = Task { [weak self] in
            var processes: [ProcessItem] = []
            var delegations: [DelegationItem] = []
            for root in roots.prefix(8) {
                let q = DerivedScopeQuery(session: root, descendants: true)
                async let p = api.processes(q, limit: 5000)
                async let d = api.delegations(q, limit: 5000)
                processes += (try? await p)?.rows ?? []
                delegations += (try? await d)?.rows ?? []
            }
            guard !Task.isCancelled, let self, seq == self.loadSeq else { return }
            let drawn = Set(self.nodes.map(\.session.id))
            self.lanes = TimelineLanes.group(processes: processes.filter { drawn.contains($0.sessionId) },
                                             delegations: delegations.filter { drawn.contains($0.sessionId) })
            self.processCount = self.lanes.values.reduce(0) { $0 + $1.processes.count }
            self.delegationCount = self.lanes.values.reduce(0) { $0 + $1.delegations.count }
            self.relayout()
            self.view?.redrawAll()
        }
    }

    // MARK: Turn time strips

    /// Request the time buckets of visible turns drawn wide enough for a strip (debounced, at most 6 at a time).
    private func requestTurnTimes() {
        guard mode == .sessions, plotWidth > 0, let api = model.engine.api, model.derived.availability != .missingRoutes else { return }
        let s = scale
        let tA = s.t(0), tB = s.t(plotWidth)
        var wanted: [String] = []
        for track in layout.tracks where !track.collapsed {
            guard let row = track.rows.first else { continue }
            var i = row.firstIndex(endingAtOrAfter: tA)
            while i < row.items.count, wanted.count < 200 {
                let it = row.items[i]
                i += 1
                if it.start > tB { break }
                guard it.span?.kind == .turn, !turnTimesRequested.contains(it.id),
                      CGFloat(s.x(it.end) - s.x(it.start)) >= TimelineLaneDrawing.minStripWidth else { continue }
                wanted.append(it.id)
            }
        }
        guard !wanted.isEmpty else { return }
        turnTimesTask?.cancel()
        let seq = loadSeq
        turnTimesTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled, let self, seq == self.loadSeq else { return }
            self.turnTimesRequested.formUnion(wanted)
            // Not a child of the debounce: panning on must not cancel requests already sent.
            Task { await self.fetchTurnTimes(wanted, api: api) }
        }
    }

    /// Turn ids are unique across sessions, so a result that arrives after a reload still belongs to its turn.
    private func fetchTurnTimes(_ ids: [String], api: APIClient) async {
        await withTaskGroup(of: (String, TimeBreakdown?).self) { group in
            var pending = ids[...]
            func addNext() {
                guard let id = pending.popFirst() else { return }
                group.addTask { (id, try? await api.time(turn: id).payload) }
            }
            for _ in 0..<6 { addNext() }
            while let (id, t) = await group.next() {
                if let t { turnTimes[id] = t }
                addNext()
            }
        }
        view?.redrawAll()
    }

    // MARK: Overview ticks

    /// Unrecovered episodes across the index (newest first, up to 20,000), for ticks on the overview's session bars.
    /// A live refresh reloads them at most once a minute.
    private func loadTicks(force: Bool) {
        guard force || Date().timeIntervalSince(ticksLoadedAt) > 60 else { return }
        ticksTask?.cancel()
        guard let api = model.engine.api, model.derived.availability != .missingRoutes else {
            ticks = [:]
            tickCount = 0
            return
        }
        ticksLoadedAt = Date()
        ticksTask = Task { [weak self] in
            var found: [EpisodeItem] = []
            var offset = 0, total = 0
            while offset < 20_000, !Task.isCancelled {
                guard let page = try? await api.episodes(.global, limit: 5000, offset: offset) else { break }
                found += page.rows.filter(Self.isUnrecoveredBand)
                offset += page.rows.count
                total = page.total
                if page.rows.isEmpty || offset >= page.total { break }
            }
            // Ticks cover the whole index, so a live refresh that started meanwhile does not make them stale.
            guard !Task.isCancelled, let self, self.mode == .overview else { return }
            // A subagent's episode ticks its own bar when the overview draws it, else its root's.
            var bySession: [String: [EpisodeItem]] = [:]
            for e in found {
                let key = self.layout.paths[e.sessionId] != nil ? e.sessionId : e.rootId
                bySession[key, default: []].append(e)
            }
            self.ticks = bySession
            self.tickCount = found.count
            self.ticksPartial = offset < total
            self.view?.redrawAll()
        }
    }

    // MARK: Context lane

    /// Load each session's context sizes through the steps route (all pages of each root tree, at most 8 roots).
    private func loadContext(roots: [String]) {
        contextTask?.cancel()
        guard contextShown, let api = model.engine.api, !roots.isEmpty, model.derived.availability != .missingRoutes else {
            contextLoading = false
            if !context.isEmpty {
                context = [:]
                contextLaneCount = 0
                relayout()
            }
            return
        }
        let seq = loadSeq
        contextLoading = true
        contextTask = Task { [weak self] in
            var steps: [StepItem] = []
            for root in roots.prefix(8) {
                var after: String?
                var pages = 0
                repeat {
                    guard let page = try? await api.sessionSteps(root, StepsRequest(after: after, limit: 5000, descendants: true)) else { break }
                    steps += page.steps
                    after = page.next
                    pages += 1
                } while after != nil && pages < 8 && !Task.isCancelled
            }
            guard !Task.isCancelled, let self, seq == self.loadSeq, self.contextShown else { return }
            self.contextLoading = false
            self.context = ContextPoint.series(steps)
            self.contextLaneCount = self.context.count
            self.relayout()
            self.view?.redrawAll()
        }
    }

    func band(id: String) -> EpisodeItem? {
        for list in bands.values { if let e = list.first(where: { $0.id == id }) { return e } }
        for list in ticks.values { if let e = list.first(where: { $0.id == id }) { return e } }
        return nil
    }

    private func finishInstall(newScope: Bool) {
        gaps = TimeScale.findGaps(busy, minGap: Double(gapSettings.1))
        relayout()
        updateMinK()
        if newScope || fitted { fit(animated: false) } else { setViewport(viewport) }
        // A live refresh keeps the selection's outline and marker but does not move the view to it.
        syncedEvent = nil
        syncSelection(reveal: newScope)
        requestDensity(immediately: true)
        requestLod()
    }

    private static func extent(_ items: [(Double, Double)]) -> (lo: Double, hi: Double)? {
        var lo = Double.infinity, hi = -Double.infinity
        for (a, b) in items where a.isFinite && a > 0 {
            lo = min(lo, a)
            hi = max(hi, b.isFinite ? b : a)
        }
        return lo <= hi ? (lo, max(hi, lo + 1000)) : nil
    }

    private func relayout() {
        let l = mode == .overview ? TimelineLayout.overview(overviewSessions, collapsed: collapsed)
            : TimelineLayout.sessions(nodes, spans: spans, collapsed: collapsed, contextLanes: contextShown ? Set(context.keys) : [], lanes: lanes,
                                      bands: bands.mapValues(\.count))
        install(l)
    }

    private func install(_ l: TimelineLayout) {
        layout = l
        trackCount = l.tracks.count
        spanCount = mode == .overview ? overviewSessions.count : l.spanCount
        hover = nil
        if let id = highlighted, l.paths[id] == nil, focus != nil {
            // The highlighted span is not drawn at this level of detail; keep the footer, drop the outline.
            highlighted = nil
        }
        view?.layoutChanged()
    }

    // MARK: Idle gaps

    private func applyGapSettings(_ settings: (Bool, Int64)) {
        // Keep the visible time window while the mapping changes.
        let s = scale
        let a = s.t(0), b = s.t(plotWidth)
        let minChanged = settings.1 != gapSettings.1
        gapSettings = settings
        if minChanged { gaps = TimeScale.findGaps(busy, minGap: Double(settings.1)) }
        updateMinK()
        if fitted { fit(animated: false) } else if plotWidth > 0 { setViewport(TimeScale.fit(from: a, to: b, width: plotWidth, gaps: activeGaps)) }
        requestDensity(immediately: true)
    }

    // MARK: Viewport

    private func updateMinK() {
        guard let e = extent, plotWidth > 0 else { return }
        minK = TimeScale.fit(from: e.lo, to: e.hi, width: plotWidth, gaps: activeGaps, pad: TimelineMetrics.fitPadding).k / 4
    }

    func setViewport(_ v: TimeViewport, fitted: Bool = false) {
        viewport = TimeScale.keepInView(v, extent: extent, width: plotWidth, gaps: activeGaps)
        self.fitted = fitted
        view?.viewportChanged()
        requestLod()
        requestDensity(immediately: false)
        requestTurnTimes()
    }

    /// The range ⌘0 fits: the scope's time range when set, else everything.
    private var fitRange: (lo: Double, hi: Double)? {
        guard let e = extent else { return nil }
        let lo = model.scope.from.map(Double.init) ?? e.lo
        let hi = model.scope.to.map(Double.init) ?? e.hi
        return hi > lo ? (lo, hi) : e
    }

    private func fit(animated: Bool) {
        guard let r = fitRange, plotWidth > 0 else { return }
        let v = TimeScale.fit(from: r.lo, to: r.hi, width: plotWidth, gaps: activeGaps, pad: TimelineMetrics.fitPadding)
        if animated { animate(to: v, fitted: true) } else {
            animation = nil
            setViewport(v, fitted: true)
        }
    }

    private func pushHistory() {
        if zoomHistory.last != viewport { zoomHistory.append(viewport) }
        if zoomHistory.count > 50 { zoomHistory.removeFirst() }
    }

    /// Record the current view so Escape can return to it (call at the start of a pinch or ⌘-scroll gesture).
    func beginZoomGesture() {
        animation = nil
        pushHistory()
    }

    func zoomIn() { zoom(by: 1.6) }
    func zoomOut() { zoom(by: 1 / 1.6) }

    private func zoom(by factor: Double) {
        pushHistory()
        let v = TimeScale.zoom(viewport, around: plotWidth / 2, factor: factor, gaps: activeGaps, minK: minK)
        animate(to: v, fitted: false)
    }

    /// Continuous zoom around `x` (pinch, ⌘-scroll).
    func zoom(around x: Double, factor: Double) {
        animation = nil
        setViewport(TimeScale.zoom(viewport, around: x, factor: factor, gaps: activeGaps, minK: minK))
    }

    func pan(by dx: Double) {
        animation = nil
        setViewport(TimeScale.pan(viewport, by: dx, gaps: activeGaps))
    }

    func zoomToFit() {
        pushHistory()
        fit(animated: true)
    }

    /// Zoom so [from, to] fills the plot with some context on both sides.
    func zoom(to from: Double, _ to: Double) {
        guard plotWidth > 0 else { return }
        pushHistory()
        let pad = min(80, plotWidth / 6)
        animate(to: TimeScale.fit(from: from, to: max(to, from + 1000), width: plotWidth, gaps: activeGaps, pad: pad), fitted: false)
    }

    /// Escape: back to the previous zoom. Returns false when there is nothing to go back to.
    @discardableResult func zoomBack() -> Bool {
        guard let v = zoomHistory.popLast() else {
            if fitted { return false }
            fit(animated: true)
            return true
        }
        animate(to: v, fitted: false)
        return true
    }

    var canZoomBack: Bool { !zoomHistory.isEmpty || !fitted }

    // MARK: Animation (driven by the view's display link)

    private func animate(to target: TimeViewport, fitted: Bool) {
        guard plotWidth > 0, view != nil, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            animation = nil
            setViewport(target, fitted: fitted)
            return
        }
        animation = (viewport, target, CACurrentMediaTime(), fitted)
        view?.startAnimation()
    }

    /// Advance the running animation; returns whether another frame is needed.
    func stepAnimation(_ now: CFTimeInterval) -> Bool {
        guard let a = animation else { return false }
        let p = min(1, (now - a.start) / Self.animationDuration)
        if p >= 1 {
            animation = nil
            setViewport(a.to, fitted: a.fitted)
            return false
        }
        // Ease in-out; the center time moves linearly in eased time while the zoom changes geometrically.
        let e = p < 0.5 ? 4 * p * p * p : 1 - pow(-2 * p + 2, 3) / 2
        let mid = plotWidth / 2
        let c0 = TimeScale(a.from, gaps: activeGaps).t(mid), c1 = TimeScale(a.to, gaps: activeGaps).t(mid)
        let k = a.from.k * pow(a.to.k / a.from.k, e)
        viewport = TimeScale.place(c0 + (c1 - c0) * e, at: mid, k: k, gaps: activeGaps)
        view?.viewportChanged()
        return true
    }

    // MARK: Level of detail

    private var lodRoots: [String] { model.scope.sessions }

    /// Spans of [from, to] at least `minDur` long; the first entry holds the initial, whole-range list.
    private struct LodEntry {
        var from: Double
        var to: Double
        var minDur: Double
        var spans: [SpanRow]
        var truncated: Bool
        var key: String { "\(from)|\(to)|\(minDur)" }
    }

    private func requestLod() {
        // Only a truncated first list has level-of-detail entries.
        guard mode == .sessions, !lod.isEmpty, plotWidth > 0 else { return }
        lodTask?.cancel()
        lodTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(160))
            guard !Task.isCancelled else { return }
            await self?.fetchLod()
        }
    }

    /// Fetch the spans of the visible range (plus half a screen on each side) that are at least a quarter point
    /// long; shorter ones would merge into their neighbors' pixel columns anyway.
    private func fetchLod() async {
        guard let api = model.engine.api else { return }
        let s = scale
        let a = s.t(0), b = s.t(plotWidth)
        let minDur = pow(2, (log2(max(1, 0.25 / viewport.k))).rounded(.down))
        if let hit = lod.first(where: { $0.from <= a && $0.to >= b && $0.minDur <= minDur }) {
            if hit.key != appliedLod { apply(hit) }
            return
        }
        let seq = loadSeq
        let pad = (b - a) / 2
        let from = (a - pad).rounded(.down), to = (b + pad).rounded(.up)
        do {
            let res = try await api.spans(sessions: lodRoots, from: Int64(from), to: Int64(to), minDur: Int64(minDur), limit: TimelineData.spanLimit)
            guard seq == loadSeq, !Task.isCancelled else { return }
            let entry = LodEntry(from: from, to: to, minDur: minDur, spans: res.spans, truncated: res.truncated)
            // Keep the full-range entry (first) for zoomed-out views.
            lod = Array(([lod.first].compactMap { $0 } + [entry] + lod.dropFirst()).prefix(6))
            apply(entry)
        } catch {
            guard seq == loadSeq, !Task.isCancelled else { return }
            refreshError = error as? APIError ?? .unreachable(error)
        }
    }

    private func apply(_ entry: LodEntry) {
        appliedLod = entry.key
        spans = entry.spans
        lodMinDur = entry.minDur
        lodTruncated = entry.truncated
        relayout()
        view?.redrawAll()
    }

    // MARK: View density (the display filter, SPEC §7.8)

    private func requestDensity(immediately: Bool) {
        guard let api = model.engine.api, let v = model.view, extent != nil, plotWidth > 0 else {
            densityTask?.cancel()
            return
        }
        let s = scale
        let a = s.t(0), b = s.t(plotWidth)
        let pad = (b - a) / 2
        let key = TimelineData.DensityKey(view: v.viewId, width: Int(plotWidth), gaps: activeGaps, from: a, to: b)
        if densityLoaded?.serves(key) == true { return }
        densityTask?.cancel()
        let viewID = v.viewId
        let width = plotWidth * 2
        densityTask = Task { [weak self] in
            if !immediately { try? await Task.sleep(for: .milliseconds(150)) }
            guard !Task.isCancelled else { return }
            let parts = await TimelineData.density(api: api, view: viewID, scale: s, from: a - pad, to: b + pad, width: width)
            guard !Task.isCancelled, let self, self.model.view?.viewId == viewID else { return }
            self.density = parts
            self.densityLoaded = key
            self.view?.densityChanged()
        }
    }

    // MARK: Selection

    /// Follow the window's selected event: mark its time and outline the innermost drawn span around it.
    private func syncSelection(reveal shouldReveal: Bool = true) {
        guard let id = model.selectedEvent else {
            if marker != nil || syncedEvent != nil {
                marker = nil
                syncedEvent = nil
                view?.redrawAll()
            }
            return
        }
        guard let d = model.eventDetail, d.event.id == id, syncedEvent != id else { return }
        syncedEvent = id
        let own = ownSelection == id
        ownSelection = nil
        let drawn = mode == .overview ? layout.paths[d.event.session] != nil : layout.tracks.contains { $0.id == d.event.session }
        marker = drawn ? Double(d.event.ts) : nil
        guard !own, drawn else {
            view?.redrawAll()
            return
        }
        if mode == .sessions {
            let chain = ([d.span] + d.spanChain.reversed()).compactMap { $0 }
            if let sp = chain.first(where: { $0.id == model.selectedSpan && layout.paths[$0.id] != nil })
                ?? chain.first(where: { layout.paths[$0.id] != nil }) {
                highlighted = sp.id
                focus = .span(sp)
            }
        } else if let s = layout.item(id: d.event.session)?.session {
            highlighted = s.id
            focus = .session(s)
        }
        if shouldReveal { reveal(time: marker, item: layout.item(id: highlighted)) }
        view?.redrawAll()
    }

    /// Bring a time (and an item's row) into view after a selection from elsewhere.
    private func reveal(time t: Double?, item: TimelineItem?) {
        if let t, plotWidth > 0 {
            let s = scale
            if t < s.t(0) || t > s.t(plotWidth) {
                animate(to: TimeScale.place(t, at: plotWidth / 2, k: viewport.k, gaps: activeGaps), fitted: false)
            }
        }
        if let item { view?.scrollRowToVisible(y: item.y, height: item.h) }
    }

    /// Select a drawn item: a span selects its first event (the table and detail follow); a session bar is focused.
    func select(_ path: TimelineItemPath?) {
        guard let path else {
            highlighted = nil
            focus = nil
            model.selectedSpan = nil
            view?.redrawAll()
            return
        }
        let it = layout[path]
        highlighted = it.id
        switch it.ref {
        case .span(let sp):
            focus = .span(sp)
            model.selectedSpan = sp.id
            if let first = sp.firstEvent {
                ownSelection = first
                model.select(event: first, reveal: false)
            }
        case .session(let s):
            focus = .session(s)
        case .process(let p):
            focus = .process(p)
            ownSelection = p.openEventId
            model.select(event: p.openEventId, reveal: false)
        case .delegation(let d):
            focus = .delegation(d)
            if let e = d.resultEventId {
                ownSelection = e
                model.select(event: e, reveal: false)
            }
        }
        view?.redrawAll()
    }

    var highlightedPath: TimelineItemPath? { highlighted.flatMap { layout.paths[$0] } }

    /// Show the selected span's first event in the Events workspace.
    func showInEvents() {
        if case .span(let sp)? = focus, let first = sp.firstEvent { model.select(event: first, reveal: true) }
    }

    /// Return: show a span's first event in Events, open an overview session, or follow a process or delegation.
    func activateFocus() {
        switch focus {
        case .span?: showInEvents()
        case .session(let s)?: model.openSession(s.id, workspace: .timeline)
        case .process(let p)?: model.followTarget = .process(id: p.id)
        case .delegation(let d)?: model.followTarget = .delegation(spanId: d.id)
        case nil: NSSound.beep()
        }
    }

    enum Move { case previous, next, up, down }

    /// Keyboard browsing: previous/next bar in the same row, or the overlapping bar in the row above/below.
    func moveSelection(_ move: Move) {
        let rows = layout.tracks.enumerated().flatMap { t, track in track.rows.indices.map { (t, $0) } }
            .filter { !layout.tracks[$0.0].rows[$0.1].items.isEmpty }
        guard !rows.isEmpty else { return }
        guard let cur = highlightedPath else {
            let s = scale
            let a = s.t(0)
            for (t, r) in rows {
                let row = layout.tracks[t].rows[r]
                let i = row.firstIndex(endingAtOrAfter: a)
                if i < row.items.count { return select(TimelineItemPath(track: t, row: r, item: i), reveal: true) }
            }
            return select(TimelineItemPath(track: rows[0].0, row: rows[0].1, item: 0), reveal: true)
        }
        let items = layout.tracks[cur.track].rows[cur.row].items
        switch move {
        case .previous, .next:
            let i = cur.item + (move == .next ? 1 : -1)
            guard items.indices.contains(i) else { return NSSound.beep() }
            select(TimelineItemPath(track: cur.track, row: cur.row, item: i), reveal: true)
        case .up, .down:
            guard let at = rows.firstIndex(where: { $0 == (cur.track, cur.row) }) else { return }
            let j = at + (move == .down ? 1 : -1)
            guard rows.indices.contains(j) else { return NSSound.beep() }
            let (t, r) = rows[j]
            let center = (items[cur.item].start + items[cur.item].end) / 2
            let target = layout.tracks[t].rows[r].items
            let i = target.indices.min { abs((target[$0].start + target[$0].end) / 2 - center) < abs((target[$1].start + target[$1].end) / 2 - center) } ?? 0
            select(TimelineItemPath(track: t, row: r, item: i), reveal: true)
        }
    }

    private func select(_ path: TimelineItemPath, reveal: Bool) {
        select(path)
        guard reveal else { return }
        let it = layout[path]
        let s = scale
        if it.end < s.t(0) || it.start > s.t(plotWidth) {
            animate(to: TimeScale.place((it.start + it.end) / 2, at: plotWidth / 2, k: viewport.k, gaps: activeGaps), fitted: false)
        }
        view?.scrollRowToVisible(y: it.y, height: it.h)
    }

    // MARK: Tracks

    func toggleCollapsed(track index: Int) {
        guard layout.tracks.indices.contains(index) else { return }
        let track = layout.tracks[index]
        let key: String
        if case .project(let name, _, _) = track.kind { key = name } else { key = track.id }
        if collapsed.contains(key) { collapsed.remove(key) } else { collapsed.insert(key) }
        relayout()
    }

    // MARK: Inspection range

    /// Set the inspection range (dragged on the ruler or the tracks); Filter to Range applies it as the time scope.
    func setInspectionRange(_ a: Double, _ b: Double) {
        let lo = Int64(min(a, b).rounded(.down)), hi = Int64(max(a, b).rounded(.up))
        model.inspectionRange = lo < hi ? lo...hi : nil
    }

    func clearInspectionRange() { model.inspectionRange = nil }

    /// Apply the inspection range as the time scope (`sync` then clears the inspection range).
    func filterToRange() { model.filterToInspectionRange() }

    // MARK: Status

    /// "3 sessions · 12,345 spans", plus level-of-detail and truncation notes.
    var statusText: String {
        switch mode {
        case .overview:
            return Formatters.count(sessionCount, "session") + " · " + Formatters.count(trackCount, "project")
                + (tickCount > 0 ? " · " + Formatters.count(tickCount, "unrecovered episode") + (ticksPartial ? " (newest 20,000 episodes read)" : "") : "")
        case .sessions:
            var parts = [Formatters.count(sessionCount, "session") + (treeTruncated ? " (first \(TimelineData.maxTreeSessions))" : ""),
                         Formatters.count(spanCount, "span")]
            if let m = lodMinDur { parts.append("showing spans ≥ \(Formatters.duration(Int64(m)))") }
            if lodTruncated { parts.append("longest \(Formatters.count(TimelineData.spanLimit)) only") }
            if bandCount > 0 { parts.append(Formatters.count(bandCount, "failure band")) }
            if processCount > 0 { parts.append(Formatters.count(processCount, "process", plural: "processes")) }
            if delegationCount > 0 { parts.append(Formatters.count(delegationCount, "delegation")) }
            if contextShown {
                parts.append(contextLoading ? "reading context…" : contextLaneCount > 0 ? Formatters.count(contextLaneCount, "context lane") : "no context sizes")
            }
            return parts.joined(separator: " · ")
        }
    }
}
