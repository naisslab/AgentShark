import AppKit
import Foundation
import Observation

/// The state of one window or tab: workspace, investigation scope, filter, the materialized view, selection
/// and navigation history (MAC-CONTRACT §2.3, SPEC §7.8).
///
/// View inputs (scope, applied filter, sort, inherited/duplicate options, coloring rules) rebuild the view
/// automatically, coalesced to one rebuild per run-loop turn. Navigation changes (workspace, scope, filter,
/// selected event) are recorded in `history`, so Back and Forward restore all of them.
@MainActor @Observable final class WindowModel {
    let app: AppModel
    /// The live engine, or this window's capture engine.
    let engine: EngineProcess
    /// Catalog of `engine`: sessions, info and fields for this window (capture windows have their own).
    let store: EngineStore
    let history = NavigationHistory()

    // MARK: Navigation state

    var workspace: Workspace { didSet { if workspace != oldValue { navigationChanged() } } }
    /// The Session workspace's mode: Steps, Transcript, Flow, Critical Path or Compare (SPEC §12.7).
    var sessionMode: SessionMode = .steps { didSet { if sessionMode != oldValue { navigationChanged() } } }
    /// Session · Compare's pair, side order and request options.
    var compare = CompareNav() { didSet { if compare != oldValue { navigationChanged() } } }
    /// What the Lens frame shows (Failures workspace).
    var lensItem: LensItem? { didSet { if lensItem != oldValue { navigationChanged() } } }
    /// Session set and time range. Changing it rebuilds the view.
    var scope = Scope() {
        didSet {
            guard scope != oldValue else { return }
            if scope.from != oldValue.from { entrySince = nil }
            if !isRestoring { pruneSelectionOnNextView = true }
            navigationChanged()
            scheduleRebuild()
        }
    }
    /// The filter field's text while editing; validated 150 ms after the last change.
    var filterText = "" { didSet { if filterText != oldValue { scheduleValidation() } } }
    /// The filter the view uses. Use `applyFilter(_:)` to validate first.
    var appliedFilter = "" {
        didSet {
            guard appliedFilter != oldValue else { return }
            if !isRestoring { pruneSelectionOnNextView = true }
            navigationChanged()
            scheduleRebuild()
        }
    }
    var filterCheck: FilterCheck?

    // MARK: View

    var view: ViewInfo?
    /// The last view request failed. With `view` nil the workspaces show the failure; with a view, that view is stale.
    var viewError: APIError?
    var pager: EventPager?
    /// `no | ts | dur | tokIn | tokOut | kind | tool | session`.
    var sort: (key: String, ascending: Bool) = ("no", true) {
        didSet { if sort != oldValue { scheduleRebuild() } }
    }
    /// Apply as Column fields; rows carry their values in `extra`.
    var customColumns: [String] = [] { didSet { if customColumns != oldValue { remakePager() } } }
    private(set) var isBuildingView = false
    private(set) var viewChangeReason: ViewChangeReason = .query
    /// Increments whenever `view` or `pager` is replaced.
    private(set) var viewGeneration = 0
    /// A page of rows failed to load (not a view failure); the table shows it with Retry.
    private(set) var rowsError: APIError?
    /// Coloring rules the engine rejected; they are left out until the rules change.
    private(set) var invalidColorRuleIDs: Set<String> = []

    // MARK: Selection

    var selectedEvent: String? {
        didSet {
            guard selectedEvent != oldValue else { return }
            navigationChanged()
            selectionChanged()
        }
    }
    var selectedRow: Int?
    var eventDetail: EventDetail?
    var raw: RawResult?
    private(set) var isLoadingDetail = false
    private(set) var detailError: APIError?
    private(set) var rawError: APIError?
    /// Selected node in the composite document (`/event/…`, `/attrs/…`, `/native/…`); highlights raw bytes.
    var selectedPointer: String?
    /// The filter fragment of the selected detail node, including nodes outside the composite document (session,
    /// turn, span, step and failure layers), for Filter ▸ Apply as Filter.
    var selectedNodeFragment: String?
    /// The derived layers of the selected event (Step, Failure, Episode, …); nil while loading or without analysis.
    private(set) var eventDerived: EventDerived?
    var selectedSpan: String?
    /// Increments to ask the event table to scroll the selected row into view.
    private(set) var revealRequest = 0

    // MARK: Options

    var timeFormat: TimeFormat
    var showInherited = false { didSet { if showInherited != oldValue { scheduleRebuild() } } }
    var showDup = false { didSet { if showDup != oldValue { scheduleRebuild() } } }
    /// Capture windows: Sources shows this Mac's logging health instead of the captured evidence.
    var sourcesShowLocal = false
    var marks: Set<String> = []
    var showTimelineTrack = true
    var showInspector = false
    var columnPreset: ColumnPreset = .standard
    /// Events columns the table hid because they do not fit (DESIGN.md §4.4), for the header's "2 columns hidden".
    var autoHiddenEventColumns: [String] = []
    /// The window's event table, for the Columns menu of the Events header.
    @ObservationIgnored weak var eventTable: EventTableController?
    /// The timeline's inspection range (dragged on the ruler); Filter to Range applies it as the time scope.
    var inspectionRange: ClosedRange<Int64>?
    /// Session: which of several selected sessions is shown.
    var singleSessionChoice: String?

    /// The window's width: Follow's placement in Events depends on it (§7.9).
    var windowWidth: CGFloat = 1440

    /// Follow takes over a region of this workspace: the Lens column, the Events lower region, the Steps inspector.
    /// Critical Path and Compare keep their inspector for the evidence of the selected mark or row, so Follow docks
    /// under them as it does under the other workspaces.
    var followHasRegion: Bool {
        workspace == .failures || workspace == .events || (workspace == .session && sessionMode == .steps)
    }

    /// ⌥⌘I and the toolbar's inspector toggle: the detail and raw panes in Failures and Session, the session inspector
    /// elsewhere.
    var inspectorShown: Bool {
        get { workspace == .failures || workspace == .session ? showDerivedInspector : showInspector }
        set { if workspace == .failures || workspace == .session { showDerivedInspector = newValue } else { showInspector = newValue } }
    }

    // MARK: Agent-native state (SPEC §12.7, MAC-CONTRACT §5.2)

    var failureFacets = FailureFacets()
    /// ⌃⌘T: times show as +h:mm:ss.SSS from this instant, with a Ref chip.
    var timeReference: Int64?
    /// The open Follow panel.
    var followTarget: FollowTarget?
    /// The episode the report preview (⇧⌘C) builds a report for, fixed when it opens.
    var reportEpisodeID: String?
    /// Failures grouped by Signature: the day the facet bar's "Split at" compares before and after (§7.4).
    var signatureSplitAt: Int64?
    /// ⌥⌘I in Failures and Session: the detail outline with the raw pane. Hidden by default (DESIGN.md §8.2).
    var showDerivedInspector = false
    /// The edit chip or close diff being shown.
    var diffRequest: DiffRequest?
    /// The entry rule opened Failures (SPEC §12.7 Entry): the time chip reads "Since 23:04 (last visit)", or on the
    /// first launch "All Time (first visit)". Any change to the start of the time range removes it.
    var entrySince: EntrySince?
    /// The Failures workspace's queue and Lens state (kept across workspace switches).
    let failures = FailuresModel()
    /// The Session workspace's Steps state.
    let steps = StepsModel()
    /// Critical Path's and Compare's requests, which share the window's one analysis slot. Like the models below, they
    /// go when the window does.
    @ObservationIgnored private(set) lazy var analyses = WindowAnalyses(host: self)
    /// Session · Critical Path's selection, zoom and cached content.
    @ObservationIgnored private(set) lazy var criticalPathModel = CriticalPathModel(window: self)
    /// Session · Compare's result, chips, folds and selection.
    @ObservationIgnored private(set) lazy var compareModel = CompareModel(window: self)
    /// Statistics results per view and section, so re-entering a section does not compute it again.
    let panels = PanelCache()

    // MARK: Find and sheets

    var presentedSheet: SheetKind?
    var findQuery = ""
    var isFindBarVisible = false
    private(set) var findStatus: String?
    /// Increments to move keyboard focus to the filter field or the find field.
    private(set) var filterFocusRequest = 0
    private(set) var findFocusRequest = 0
    /// Set by the filter field while it has keyboard focus (⌘⌫ clears the filter only then).
    var filterFieldIsFocused = false

    // MARK: Private

    @ObservationIgnored private var rebuildPending = false
    @ObservationIgnored private var historyPending = false
    @ObservationIgnored private var isRestoring = false
    @ObservationIgnored private var viewTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var validationTask: Task<Void, Never>?
    @ObservationIgnored private var applyTask: Task<Void, Never>?
    @ObservationIgnored private var detailTask: Task<Void, Never>?
    @ObservationIgnored private var rawTask: Task<Void, Never>?
    @ObservationIgnored private var locateTask: Task<Void, Never>?
    @ObservationIgnored private var lastBuildAt = Date.distantPast
    @ObservationIgnored private var lastSpec: ViewSpec?
    @ObservationIgnored private var pendingRowForEvent: (event: String, row: Int)?
    @ObservationIgnored private var turnCache: (turn: String, events: [EventRow])?
    @ObservationIgnored private var derivedTask: Task<Void, Never>?
    /// Scope or filter changed (not a history restore): an event the new view does not hold leaves the selection.
    @ObservationIgnored private var pruneSelectionOnNextView = false
    @ObservationIgnored var entryChecked = false
    /// The window showing this model (set by `WindowRoot`).
    @ObservationIgnored weak var hostWindow: NSWindow? {
        didSet {
            guard hostWindow !== oldValue else { return }
            if let occlusionObserver { NotificationCenter.default.removeObserver(occlusionObserver) }
            occlusionObserver = hostWindow.map {
                NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: $0, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.occlusionChanged() }
                }
            }
        }
    }
    @ObservationIgnored private var occlusionObserver: NSObjectProtocol?
    var isKeyWindow: Bool { hostWindow?.isKeyWindow ?? false }
    /// Whether anyone can see the window: not minimized, hidden, on another Space or fully covered.
    private var isOnScreen: Bool { hostWindow?.occlusionState.contains(.visible) ?? true }
    /// An index run finished while the window was off screen; its live refresh runs when the window comes back.
    @ObservationIgnored private var missedIndexRun = false

    /// Live refreshes after index runs happen at most this often.
    static let liveRefreshInterval: TimeInterval = 5
    /// A rebuild reads every event in scope (an unfiltered view of 1.8 million events costs the engine about 350 ms), so
    /// a large view refreshes less often: 5 s up to 250,000 rows, then proportionally longer, at most 30 s.
    static func liveRefreshInterval(rows: Int) -> TimeInterval {
        liveRefreshInterval * min(6, max(1, Double(rows) / 250_000))
    }

    init(app: AppModel, engine: EngineProcess, store: EngineStore) {
        self.app = app
        self.engine = engine
        self.store = store
        workspace = app.preferences.defaultWorkspace
        timeFormat = app.preferences.timeFormat
        history.reset(to: navState)
        failures.window = self
        steps.window = self
        store.observe(owner: self, ready: { [weak self] in self?.engineDidBecomeReady() },
                      indexDone: { [weak self] in self?.indexDidFinish() })
        observeColorRules()
        if engine.api != nil { rebuildView() }
    }

    // MARK: Engine data for this window

    var info: InfoResult? { store.info }
    var sessions: [SessionRow] { store.sessions }
    var sessionsByID: [String: SessionRow] { store.sessionsByID }
    var childrenByParent: [String: [String]] { store.childrenByParent }
    var fields: [FieldInfo] { store.fields }
    var isCapture: Bool { engine.captureURL != nil }

    var navState: NavState {
        NavState(workspace: workspace, sessionMode: sessionMode, scope: scope, filter: appliedFilter, selectedEvent: selectedEvent,
                 lensItem: lensItem, compare: compare)
    }

    /// The derived model of this window's engine.
    var derived: DerivedStore { store.derived }

    /// Which parts of the scope the current workspace honors, with the Session mode taken into account.
    var honorsTimeRange: Bool { workspace == .session ? sessionMode.honorsTimeRange : workspace.honorsTimeRange }
    var honorsFilter: Bool {
        switch workspace {
        case .session: return sessionMode.honorsFilter
        case .failures: return failureFacets.matchFilter
        default: return workspace.honorsFilter
        }
    }

    // MARK: View state (SPEC §7.8)

    var viewPhase: ViewPhase {
        if let view { return view.count == 0 ? .empty : .ready }
        if let viewError { return .failed(viewError) }
        if engine.api == nil { return .waitingForEngine }
        return .loading
    }

    /// The shown view could not be refreshed: its data is stale.
    var viewIsStale: Bool { view != nil && viewError != nil }

    /// The view ID to scope requests with. Nil while there is no valid view: never query without it.
    var scopedViewID: String? { view?.viewId }

    // MARK: Filter

    /// Validate, then apply as the view's filter. An invalid filter stays in the field with its error.
    func applyFilter(_ expr: String) {
        let text = expr.trimmingCharacters(in: .whitespacesAndNewlines)
        filterText = text
        applyTask?.cancel()
        guard !text.isEmpty else {
            filterCheck = nil
            appliedFilter = ""
            return
        }
        applyTask = Task { [weak self] in
            if let api = self?.engine.api, let check = try? await api.validate(text) {
                guard !Task.isCancelled, let self else { return }
                self.filterCheck = check
                guard check.ok else {
                    self.filterFocusRequest += 1
                    return
                }
            }
            guard !Task.isCancelled, let self else { return }
            self.appliedFilter = text
            self.app.preferences.noteRecentFilter(text)
        }
    }

    /// Apply as Filter: combine `fragment` with the applied filter.
    func applyFilter(fragment: String, mode: FilterCombine) {
        applyFilter(mode.combine(existing: appliedFilter, fragment: fragment))
    }

    /// Drill-down from Statistics, Diagnostics, the detail tree or the timeline: narrows with AND (SPEC §7.8).
    func drillDown(_ fragment: String) {
        applyFilter(fragment: fragment, mode: .andSelected)
    }

    /// Prepare as Filter: put the combination in the field without applying it.
    func prepareFilter(fragment: String, mode: FilterCombine) {
        let base = filterText.trimmingCharacters(in: .whitespaces).isEmpty ? appliedFilter : filterText
        filterText = mode.combine(existing: base, fragment: fragment)
        focusFilterField()
    }

    /// Escape in the filter field: back to the applied filter.
    func revertFilterText() {
        filterText = appliedFilter
    }

    func clearFilter() { applyFilter("") }

    func focusFilterField() { filterFocusRequest += 1 }

    /// The filter fragment for the selected detail node (Apply/Prepare as Filter), or nil.
    var selectedFieldFragment: String? {
        if let f = selectedNodeFragment { return f }
        guard let p = selectedPointer, let detail = eventDetail else { return nil }
        return FilterExpression.fragment(forPointer: p, in: detail)
    }

    private func scheduleValidation() {
        validationTask?.cancel()
        let text = filterText
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            filterCheck = nil
            return
        }
        validationTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled, let api = self?.engine.api, let check = try? await api.validate(text) else { return }
            guard !Task.isCancelled, let self, self.filterText == text else { return }
            self.filterCheck = check
        }
    }

    // MARK: Scope (each part independent, SPEC §7.8)

    func setScope(_ scope: Scope) { self.scope = scope }

    /// Replace the session set and keep the time range.
    func openSession(_ id: String, workspace: Workspace? = nil) {
        scope.sessions = [id]
        singleSessionChoice = id
        if let workspace { self.workspace = workspace }
    }

    /// Open a session in the Session workspace in the given mode.
    func openSession(_ id: String, mode: SessionMode) {
        sessionMode = mode
        openSession(id, workspace: .session)
    }

    func openSessions(_ ids: [String]) {
        scope.sessions = ids
        singleSessionChoice = ids.first
    }

    func setTimeRange(from: Int64?, to: Int64?) {
        scope.from = from
        scope.to = to
    }

    /// The session chip's close control: removes only the session set.
    func clearSessionScope() { scope.sessions = [] }

    /// The time chip's close control: removes only the time range.
    func clearTimeScope() { setTimeRange(from: nil, to: nil) }

    /// Reset scope: sessions, time range and filter.
    func resetScope() {
        scope = Scope()
        clearFilter()
    }

    /// Timeline ▸ Filter to Range.
    func filterToInspectionRange() {
        guard let r = inspectionRange else { return }
        setTimeRange(from: r.lowerBound, to: r.upperBound)
    }

    // MARK: Single-session workspaces

    /// The session the single-session modes show (all but Compare): the chosen one of the selected sessions, else the
    /// first, else the selected event's session.
    var focusedSessionID: String? {
        if !scope.sessions.isEmpty {
            if let c = singleSessionChoice, scope.sessions.contains(c) { return c }
            return scope.sessions.first
        }
        return eventDetail?.event.session ?? singleSessionChoice
    }

    /// "Showing 1 of 3 selected sessions" when several are selected; they never pick one silently.
    var singleSessionNote: String? {
        scope.sessions.count > 1 ? "Showing 1 of \(scope.sessions.count) selected sessions" : nil
    }

    /// Whether the visible workspace shows one session: Session, except in Compare, which aligns two runs (SPEC §7.8,
    /// ANALYSIS-UX Decision 3). Call sites that note how many of the selected sessions are shown ask this.
    var sessionIsSingle: Bool { workspace == .session && sessionMode != .compare }

    /// The scope bar's Sessions token adds `singleSessionNote` only where the visible workspace shows one of them.
    var shownSessionNote: String? { sessionIsSingle ? singleSessionNote : nil }

    /// Session ▸ a mode, from any workspace (View ▸ Session Mode, Analyze).
    func showSessionMode(_ mode: SessionMode) {
        sessionMode = mode
        workspace = .session
    }

    // MARK: Session · Compare (ANALYSIS-UX §5.1)

    /// The top-level runs Compare can align: the scope's roots (`scopeRootSessions`, so a run selected with its own
    /// subagent counts once) that have no parent. A session the catalog does not know counts as a run, so the engine
    /// can say that it is no longer in the index (§5.13) instead of the run silently leaving the comparison.
    var compareRoots: [String] {
        scopeRootSessions.filter { sessionsByID[$0]?.parentId == nil }
    }

    /// The shape of the scope, which decides what Compare shows (§5.1 table).
    var compareScope: CompareScope {
        let roots = compareRoots
        switch roots.count {
        case 0: return scope.hasSessions ? .subagents(scopeRootSessions) : .empty
        case 1: return .oneRun(roots[0], withOwnSubagent: scope.sessions.contains { $0 != roots[0] && hasAncestor($0, in: [roots[0]]) })
        default: return .runs(roots)
        }
    }

    /// The top-level run a session belongs to; the session itself when the catalog has not loaded it.
    func rootSession(of id: String) -> String { sessionsByID[id]?.rootId ?? id }

    /// Use Whole Run: each scoped subagent gives way to its top-level run, so Compare has runs to align (§5.1).
    func useWholeRuns() {
        var runs: [String] = []
        for root in scope.sessions.map(rootSession(of:)) where !runs.contains(root) { runs.append(root) }
        openSessions(runs)
    }

    /// Runs A and B: the stored pair (`compare.pair`, in start order) once it is locked, else the two roots that started
    /// first. A is the earlier start, whatever order the sidebar selected them in, and Swap flips the sides. A stored pair
    /// is never ordered again, so the request's key does not flip when a run's catalog row, and its start, arrives after
    /// the request went out. Nil with fewer than two top-level runs in scope, and while the catalog's first session list
    /// has not arrived (Compare then shows its loading state instead of sides chosen by id order).
    var compareSides: CompareSides? {
        let roots = compareRoots
        guard roots.count >= 2, let pair = lockedComparePair(roots) ?? resolvedComparePair(roots) else { return nil }
        return compare.swapped ? CompareSides(a: pair[1], b: pair[0]) : CompareSides(a: pair[0], b: pair[1])
    }

    /// Lock the sides as Compare sends its request: the resolved pair goes into `compare.pair`, so a flipped key never
    /// sends a second request while the first holds the window's one analysis slot (Decision 14). Locking completes the
    /// state on screen rather than navigating, so it records no history entry of its own.
    func lockCompareSides() {
        let roots = compareRoots
        guard roots.count >= 2, lockedComparePair(roots) == nil, let pair = resolvedComparePair(roots) else { return }
        isRestoring = true
        compare.pair = pair
        isRestoring = false
    }

    /// Swap: B becomes A. It changes only the request; the scope, and so the event view, stays as it is (Decision 8).
    func swapCompareSides() { compare.swapped.toggle() }

    /// The A ▾ and B ▾ pickers: compare these two of the selected runs, `a` on the A side.
    func setCompareSides(a: String, b: String) {
        var c = compare
        c.pair = startOrder([a, b])
        c.swapped = c.pair?.first != a
        compare = c
    }

    /// The stored pair, while it still names two of `roots`.
    private func lockedComparePair(_ roots: [String]) -> [String]? {
        compare.pair.flatMap { p in p.count == 2 && p[0] != p[1] && p.allSatisfy(roots.contains) ? p : nil }
    }

    /// The two roots that started first, in start order, or nil while the catalog's first session list has not arrived
    /// and the alignment on screen does not give every start. Once the list has arrived, a run it lacks sorts last. A
    /// pair whose key already has a result keeps that key, whatever the catalog's starts say.
    private func resolvedComparePair(_ roots: [String]) -> [String]? {
        let catalogLoaded = !store.sessions.isEmpty || store.indexGeneration > 0 || store.sessionsPhase == .ready
        guard catalogLoaded || roots.allSatisfy({ compareStart($0) != nil }) else { return nil }
        let pair = Array(startOrder(roots).prefix(2))
        let reversed = Array(pair.reversed())
        return !hasDiffResult(pair) && hasDiffResult(reversed) ? reversed : pair
    }

    /// The window's cache holds an alignment for `pair` (in start order) with the current side order and options.
    private func hasDiffResult(_ pair: [String]) -> Bool {
        let a = compare.swapped ? pair[1] : pair[0], b = compare.swapped ? pair[0] : pair[1]
        let key = AnalysisSpec<DiffResult>.diff(left: a, right: b, children: compare.subagents, limit: compare.limit).key
        return panels.request(key, DiffResult.self).value != nil
    }

    /// A run's start for the side order: the alignment on screen's (analysis 1.1) before the catalog's.
    private func compareStart(_ id: String) -> Int64? {
        analyses.diff.value?.sessions?[id]?.startTs ?? sessionsByID[id]?.start
    }

    /// Compare Runs: scope the two runs (keeping the time range), forget the previous pair's choices and show them.
    func compareRuns(_ a: String, _ b: String) {
        openSessions([a, b])
        compare = CompareNav()
        showSessionMode(.compare)
    }

    /// Sessions by `compareStart`, ties by id; a session with no known start sorts last.
    private func startOrder(_ ids: [String]) -> [String] {
        ids.sorted { x, y in
            let sx = compareStart(x) ?? .max, sy = compareStart(y) ?? .max
            return sx != sy ? sx < sy : x < y
        }
    }

    /// Session · Compare is the visible workspace.
    var isComparing: Bool { workspace == .session && sessionMode == .compare }

    /// Go ▸ Next and Previous Difference Region (⌥⌘↓, ⌥⌘↑, §3.10) act on this: Compare's alignment table, which sets
    /// itself here while it shows an alignment and sets nil when the alignment goes away (loading, failed, the run
    /// chooser, another mode). The window holds it weakly, so the table and its controller never outlive the view.
    weak var differenceRegions: (any DifferenceRegionNavigating)?

    /// Whether Go ▸ Next (`forward`) or Previous Difference Region is enabled: only in Session · Compare, with an
    /// alignment that has a region in that direction.
    func canGoToDifferenceRegion(forward: Bool) -> Bool {
        isComparing && differenceRegions?.canStepDifferenceRegion(forward: forward) == true
    }

    func goToDifferenceRegion(forward: Bool) {
        guard canGoToDifferenceRegion(forward: forward), let regions = differenceRegions else { return NSSound.beep() }
        regions.stepDifferenceRegion(forward: forward)
    }

    // MARK: Scope labels (SPEC §7.8)

    /// Parts of the scope in words: "filter", the session count and the time range. The scope tokens name the session.
    var scopeParts: [String] {
        var parts: [String] = []
        if !appliedFilter.isEmpty { parts.append("filter") }
        if scope.hasSessions { parts.append(Formatters.count(scope.sessions.count, "session")) }
        if scope.hasTimeRange { parts.append(ScopeBar.rangeLabel(from: scope.from, to: scope.to)) }
        return parts
    }

    /// The label each workspace shows, with its own count.
    func scopeLabel(for w: Workspace) -> String {
        let events = view.map { Formatters.count($0.count, "event") }
        switch w {
        case .events:
            let lead = events ?? "Events"
            return scopeParts.isEmpty ? "\(lead) · all sessions" : "\(lead) · " + scopeParts.joined(separator: " + ")
        case .timeline:
            var parts = [scope.sessions.isEmpty ? "All sessions overview" : "Spans: full session context"]
            if scope.hasTimeRange { parts.append("time range applied") }
            if !appliedFilter.isEmpty { parts.append("filter shown as density") }
            return parts.joined(separator: " · ")
        case .failures:
            return failures.scopeLabel
        case .session:
            return sessionScopeLabel(sessionMode)
        case .stats:
            let lead = events ?? "Events"
            return scopeParts.isEmpty ? "\(lead) in the current view · all sessions · no filter" : "\(lead) in the current view · " + scopeParts.joined(separator: " + ")
        case .diagnostics:
            let lead = events ?? "Events"
            return scopeParts.isEmpty ? "Diagnostics of \(lead.lowercased()) · all sessions" : "Diagnostics of \(lead.lowercased()) · " + scopeParts.joined(separator: " + ")
        case .sources:
            let count = info.map { Formatters.count($0.counts.sources, "source") } ?? "Sources"
            guard isCapture else { return count + " · logging health of this Mac · the scope does not apply" }
            if !sourcesShowLocal { return count + " · captured evidence · the scope does not apply" }
            return "Logging health of this Mac, not the capture · the scope does not apply"
        }
    }

    /// The label of a Session mode (SPEC §7.8 rows; Steps: "Session X · 213 steps · filter highlights 14"). Critical Path
    /// and Compare show theirs until their result arrives; their scope note is the label's tooltip (`sessionScopeHelp`).
    func sessionScopeLabel(_ mode: SessionMode) -> String {
        // Compare reads the scope's runs, never the session of the selected event.
        if mode == .compare { return compareScopeLabel() }
        guard let id = focusedSessionID else {
            return "Select a session" + (mode == .transcript || mode == .flow ? " · filter does not apply" : "")
        }
        switch mode {
        case .steps:
            return steps.scopeLabel()
        case .transcript:
            var parts = [sessionEvents(id), "full session", "filter does not apply"].compactMap { $0 }
            if scope.hasTimeRange { parts.append("time range does not apply") }
            return parts.joined(separator: " · ")
        case .flow:
            return [sessionEvents(id) ?? "Flow", scope.hasTimeRange ? "time range applied" : nil, "filter does not apply"]
                .compactMap { $0 }.joined(separator: " · ")
        case .criticalPath:
            return "Critical path · " + runLabel(of: id)
        case .compare:
            return compareScopeLabel()
        }
    }

    /// The scope label's tooltip in the analyses, which read whole runs (ANALYSIS-UX §4.3); nil where the label says how
    /// the scope applies.
    func sessionScopeHelp(_ mode: SessionMode) -> String? {
        switch mode {
        case .criticalPath: return "Whole run: the filter and time range do not apply. Subagents are always included."
        case .compare: return "Whole runs: the filter and time range do not apply."
        case .steps, .transcript, .flow: return nil
        }
    }

    /// Critical Path's label once its result arrives (§4.3): "11m 30s critical path · 5 of 37 sessions on the path", or
    /// "Subagent run · 4 sessions" when the focused session is a subagent and the analysis covers its subtree.
    static func criticalPathScopeLabel(wallUs: Int64?, sessionsOnPath: Int, sessions: Int, subagent: Bool) -> String {
        if subagent { return "Subagent run · " + Formatters.count(sessions, "session") }
        let lead = wallUs.map { Formatters.duration($0) + " critical path" } ?? "Critical path"
        return lead + " · \(Formatters.count(sessionsOnPath)) of " + Formatters.count(sessions, "session") + " on the path"
    }

    /// Compare's label (§5.1, §5.5): "2 runs · 1,299 aligned rows · subagents included", with `rows` once the alignment
    /// arrives. With more top-level runs in scope, "Comparing 2 of 5 selected runs" says that only two are aligned.
    func compareScopeLabel(rows: Int? = nil) -> String {
        switch compareScope {
        case .empty: return "Select two runs"
        case .subagents(let ids): return Formatters.count(ids.count, "subagent") + " · no top-level run"
        case .oneRun: return "1 run · choose a run to compare with"
        case .runs(let roots):
            return [roots.count == 2 ? "2 runs" : "Comparing 2 of \(roots.count) selected runs", rows.map { Formatters.count($0, "aligned row") },
                    compare.subagents ? "subagents included" : "subagents excluded"].compactMap { $0 }.joined(separator: " · ")
        }
    }

    /// "854 events" for a session's own events, when the catalog knows it.
    private func sessionEvents(_ id: String) -> String? {
        sessionsByID[id].map { Formatters.count($0.nEvents, "event") }
    }

    /// Window title: the capture file or the scoped session.
    var windowTitle: String {
        let scopeTitle: String
        switch scope.sessions.count {
        case 0: scopeTitle = "All Sessions"
        case 1: scopeTitle = runLabel(of: scope.sessions[0])
        default: scopeTitle = "\(scope.sessions.count) Sessions"
        }
        if let url = engine.captureURL { return "\(url.lastPathComponent) — \(scopeTitle)" }
        return scopeTitle
    }

    // MARK: Run names (DESIGN.md §9 Sessions)

    /// A run's title: the catalog's, else the one the window's shown analysis result carries, so a run the catalog
    /// lacks, or a capture's run before its catalog loads, reads by its title (ANALYSIS-UX Decision 12).
    func runTitle(of id: String) -> String? {
        sessionsByID[id]?.title ?? analyses.runTitle(of: id)
    }

    /// "Port tests to vitest", or "Untitled · cx:0190a0…0001", never the id alone: a run's name in the scope bar, the
    /// window title and the session pickers. Its tooltip is `AnalysisVocabulary.runHelp`, with the full id.
    func runLabel(of id: String) -> String {
        AnalysisVocabulary.runLabel(title: runTitle(of: id), id: id)
    }

    // MARK: Building the view

    /// Rebuild now (Retry, or after an option change).
    func rebuildView() { rebuildView(reason: .query) }

    func rebuildView(reason: ViewChangeReason) {
        rebuildPending = false
        viewTask?.cancel()
        refreshTask?.cancel()
        refreshTask = nil
        if reason == .query { discardView() }
        guard let api = engine.api else { return }
        let spec = makeSpec()
        isBuildingView = true
        lastBuildAt = Date()
        viewTask = Task { [weak self] in
            do {
                let info = try await api.createView(spec)
                guard !Task.isCancelled, let self else { return }
                self.install(info, spec: spec, reason: reason, api: api)
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled, let self else { return }
                self.viewFailed(error as? APIError ?? .unreachable(error), reason: reason)
            }
        }
    }

    func makeSpec() -> ViewSpec {
        var spec = ViewSpec(
            filter: appliedFilter.isEmpty ? nil : appliedFilter,
            sessions: scope.sessions.isEmpty ? nil : scope.sessions,
            descendants: scope.sessions.isEmpty ? nil : true,
            from: scope.from, to: scope.to,
            includeInherited: showInherited ? true : nil,
            includeDup: showDup ? true : nil)
        if sort.key != "no" {
            spec.sort = sort.key
            spec.order = sort.ascending ? "asc" : "desc"
        } else if !sort.ascending {
            spec.sort = "ts"
            spec.order = "desc"
        }
        let rules = app.colorRules.specs(excluding: invalidColorRuleIDs)
        if !rules.isEmpty { spec.colorRules = rules }
        return spec
    }

    private func scheduleRebuild() {
        guard !rebuildPending else { return }
        rebuildPending = true
        Task { [weak self] in
            guard let self, self.rebuildPending else { return }
            self.rebuildView(reason: .query)
        }
    }

    private func discardView() {
        pager?.cancel()
        pager = nil
        if view != nil || viewError != nil { viewGeneration += 1 }
        view = nil
        viewError = nil
        rowsError = nil
    }

    private func install(_ info: ViewInfo, spec: ViewSpec, reason: ViewChangeReason, api: APIClient) {
        pager?.cancel()
        let p = EventPager(api: api, view: info, columns: pagerColumns)
        p.onError = { [weak self] e in self?.rowsFailed(e) }
        pager = p
        view = info
        lastSpec = spec
        viewChangeReason = reason
        viewError = nil
        rowsError = nil
        isBuildingView = false
        viewGeneration += 1
        let prune = pruneSelectionOnNextView && reason == .query
        pruneSelectionOnNextView = false
        relocateSelection(prune: prune)
    }

    private func viewFailed(_ e: APIError, reason: ViewChangeReason) {
        // A rule the engine rejects is skipped (and reported in Settings) rather than failing the view.
        if e.code == "color_rule", let id = e.ruleId, !invalidColorRuleIDs.contains(id) {
            invalidColorRuleIDs.insert(id)
            rebuildView(reason: reason)
            return
        }
        isBuildingView = false
        viewError = e
        if reason == .query { pager = nil; view = nil }
        if e.code == "filter" {
            filterCheck = FilterCheck(ok: false, error: .init(message: e.message, start: e.start ?? 0, end: e.end ?? 0), warning: nil)
        }
    }

    private func rowsFailed(_ e: APIError) {
        if e.isViewGone {
            rebuildView(reason: .refresh)
        } else {
            rowsError = e
        }
    }

    /// Retry rows that failed to load.
    func retryRows() {
        rowsError = nil
        pager?.retryFailedPages()
    }

    /// The fields the rows carry: the custom columns, plus the failure tier for the Tier column (§4.4) when the engine
    /// has the analysis fields.
    var pagerColumns: [String] {
        let tier = EventColumn.tierField
        return customColumns + (store.fieldNames.contains(tier) && !customColumns.contains(tier) ? [tier] : [])
    }

    private func remakePager() {
        guard let view, let api = engine.api else { return }
        pager?.cancel()
        let p = EventPager(api: api, view: view, columns: pagerColumns)
        p.onError = { [weak self] e in self?.rowsFailed(e) }
        pager = p
        viewGeneration += 1
    }

    private func engineDidBecomeReady() {
        // View IDs from an earlier engine run are gone.
        rebuildView(reason: view == nil ? .query : .refresh)
        if let id = selectedEvent { loadDetail(id) }
        checkEntry()
    }

    private func indexDidFinish() {
        // A window nobody can see skips live refreshes (an event view rebuild reads every event in scope) and catches
        // up once when it is back on screen.
        guard isOnScreen else {
            missedIndexRun = true
            return
        }
        scheduleLiveRefresh()
        failures.indexDidFinish()
        steps.indexDidFinish()
    }

    private func occlusionChanged() {
        guard missedIndexRun, isOnScreen else { return }
        missedIndexRun = false
        indexDidFinish()
    }

    private func scheduleLiveRefresh() {
        guard view != nil, !isBuildingView else { return }
        let wait = Self.liveRefreshInterval(rows: view?.count ?? 0) - Date().timeIntervalSince(lastBuildAt)
        if wait <= 0 {
            rebuildView(reason: .refresh)
        } else if refreshTask == nil {
            refreshTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(wait))
                guard !Task.isCancelled, let self else { return }
                self.refreshTask = nil
                self.rebuildView(reason: .refresh)
            }
        }
    }

    private func observeColorRules() {
        withObservationTracking {
            _ = app.colorRules.rules
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.observeColorRules()
                self.invalidColorRuleIDs = []
                let rules = self.app.colorRules.specs()
                if (self.lastSpec?.colorRules ?? []) != rules { self.scheduleRebuild() }
            }
        }
    }

    // MARK: Columns

    func addColumn(field: String) {
        guard !customColumns.contains(field) else { return }
        customColumns.append(field)
    }

    func removeColumn(field: String) {
        customColumns.removeAll { $0 == field }
    }

    // MARK: Selection

    /// Select an event; `reveal` switches to Events and scrolls it into view.
    func select(event id: String, reveal: Bool = true) {
        pruneSelectionOnNextView = false
        if reveal && workspace != .events { workspace = .events }
        if selectedEvent == id {
            if reveal { revealRequest += 1 }
            return
        }
        selectedEvent = id
        if reveal { revealRequest += 1 }
    }

    /// Select a row of the view (0-based). Loads its page first when needed.
    func select(row: Int) {
        guard let pager, row >= 0, row < pager.count else { return }
        selectedRow = row
        if let r = pager.row(at: row) {
            pendingRowForEvent = (r.id, row)
            selectedEvent = r.id
            return
        }
        Task { [weak self] in
            guard let rows = try? await pager.rows(in: row..<(row + 1)), let r = rows.first, let self, self.selectedRow == row else { return }
            self.pendingRowForEvent = (r.id, row)
            self.selectedEvent = r.id
        }
    }

    /// Go ▸ Go to Event: by view row number (1-based).
    func goToRow(number: Int) {
        guard let view, view.count > 0 else { return }
        select(row: max(1, min(number, view.count)) - 1)
        revealRequest += 1
    }

    private func selectionChanged() {
        detailTask?.cancel()
        rawTask?.cancel()
        locateTask?.cancel()
        derivedTask?.cancel()
        detailError = nil
        rawError = nil
        guard let id = selectedEvent else {
            eventDetail = nil
            raw = nil
            eventDerived = nil
            selectedRow = nil
            selectedPointer = nil
            selectedNodeFragment = nil
            isLoadingDetail = false
            return
        }
        if let pending = pendingRowForEvent, pending.event == id {
            selectedRow = pending.row
        } else {
            relocateSelection()
        }
        pendingRowForEvent = nil
        loadDetail(id)
    }

    private func loadDetail(_ id: String) {
        guard let api = engine.api else { return }
        isLoadingDetail = true
        detailTask = Task { [weak self] in
            do {
                let detail = try await api.event(id)
                guard !Task.isCancelled, let self, self.selectedEvent == id else { return }
                // Keep the selected field when the new event has it (Wireshark behavior).
                if let p = self.selectedPointer, detail.compositeDocument.pointer(p) == nil { self.selectedPointer = nil }
                self.eventDetail = detail
                self.isLoadingDetail = false
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled, let self, self.selectedEvent == id else { return }
                self.detailError = error as? APIError ?? .unreachable(error)
                self.eventDetail = nil
                self.isLoadingDetail = false
            }
        }
        derivedTask = Task { [weak self] in
            // The Step and Failure layers; an engine without the analysis simply has none.
            let d = try? await api.eventDerived(id)
            guard !Task.isCancelled, let self, self.selectedEvent == id else { return }
            self.eventDerived = d
        }
        rawTask = Task { [weak self] in
            do {
                let raw = try await api.raw(id)
                guard !Task.isCancelled, let self, self.selectedEvent == id else { return }
                self.raw = raw
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled, let self, self.selectedEvent == id else { return }
                self.rawError = error as? APIError ?? .unreachable(error)
                self.raw = nil
            }
        }
    }

    /// Retry loading the selected event's detail and raw bytes.
    func reloadSelection() {
        if let id = selectedEvent { loadDetail(id) }
    }

    /// Find the selected event's row in the current view (nil when the view excludes it). With `prune` (the scope
    /// or filter changed), an event the new view does not hold is deselected, so Detail and Raw never keep showing
    /// an event from the previous view.
    private func relocateSelection(prune: Bool = false) {
        locateTask?.cancel()
        guard let id = selectedEvent, let view, let pager else {
            selectedRow = nil
            return
        }
        if let i = pager.cachedIndex(ofEvent: id) {
            selectedRow = i
            return
        }
        guard let api = engine.api else { return }
        locateTask = Task { [weak self] in
            let located: Int??
            do { located = .some(try await api.locate(view: view.viewId, event: id)) } catch { located = .none }
            guard !Task.isCancelled, let self, self.selectedEvent == id, self.view == view else { return }
            switch located {
            case .some(let no?): self.selectedRow = no - 1
            case .some(nil) where prune: self.selectedEvent = nil
            default: self.selectedRow = nil
            }
        }
    }

    // MARK: Go menu

    func goBack() {
        if let s = history.back() { restore(s) }
    }

    func goForward() {
        if let s = history.forward() { restore(s) }
    }

    /// The partner of the selected event: call ↔ result, an exec item's call, or the next block of the same response.
    var partnerEventID: String? {
        guard let d = eventDetail else { return nil }
        return Self.partner(of: d)
    }

    static func partner(of d: EventDetail) -> String? {
        let me = d.event.id
        // Copies of inherited context are never the partner when the original is there.
        let related = d.related.filter { $0.id != me }.sorted { ($0.isDimmed ? 1 : 0, $0.seq) < ($1.isDimmed ? 1 : 0, $1.seq) }
        func first(_ kinds: [EventKind]) -> EventRow? {
            for k in kinds { if let r = related.first(where: { $0.kind == k && $0.session == d.event.session }) { return r } }
            return nil
        }
        // The tool span's ends: its call opens it and its result closes it.
        let spanEnds = [d.span?.firstEvent, d.span?.lastEvent].compactMap { $0 }.filter { $0 != me }
        switch d.event.kind {
        case .toolCall: return first([.toolResult, .toolExec])?.id ?? spanEnds.last ?? related.first?.id
        case .toolResult, .toolExec: return first([.toolCall])?.id ?? spanEnds.first ?? related.first?.id
        default:
            // Blocks of one response: the next one in file order, wrapping to the first.
            let same = related.filter { $0.session == d.event.session }
            return (same.first { $0.seq > d.event.seq } ?? same.first)?.id
        }
    }

    /// ⌥⌘→: go to the partner event and show it in Events. When the view filters the partner out, the status bar says
    /// "Not in view" and the detail and raw panes show it.
    func goToPartner() {
        guard let partner = partnerEventID else {
            NSSound.beep()
            return
        }
        select(event: partner)
    }

    /// Previous or next event in the same turn.
    func goToNextInTurn(_ forward: Bool) {
        guard let id = selectedEvent, let turn = eventDetail?.event.turn, let api = engine.api else { return }
        Task { [weak self] in
            guard let self else { return }
            let events: [EventRow]
            if let cache = self.turnCache, cache.turn == turn {
                events = cache.events
            } else {
                guard let d = try? await api.span(turn) else { return }
                events = d.events
                self.turnCache = (turn, events)
            }
            guard let i = events.firstIndex(where: { $0.id == id }) else { return }
            let j = forward ? i + 1 : i - 1
            if events.indices.contains(j) { self.select(event: events[j].id) }
        }
    }

    var parentSessionID: String? {
        let current = scope.sessions.count == 1 ? scope.sessions[0] : eventDetail?.event.session
        return current.flatMap { sessionsByID[$0]?.parentId }
    }

    func goToParentSession() {
        if let p = parentSessionID { openSession(p) }
    }

    /// The child session the selected event spawned (Agent or spawn_agent call), if any.
    var childSessionID: String? {
        guard let d = eventDetail else { return nil }
        if let link = d.event.attrs["agent"]?["link_session"]?.stringValue { return link }
        if let link = d.span?.linkSession { return link }
        return d.spanChain.last { $0.linkSession != nil }?.linkSession
    }

    func openChildSession() {
        if let c = childSessionID { openSession(c) }
    }

    // MARK: Marks

    func toggleMark() {
        guard let id = selectedEvent else { return }
        if marks.contains(id) { marks.remove(id) } else { marks.insert(id) }
    }

    func clearMarks() { marks.removeAll() }

    /// The next marked event after the selected row in view order, wrapping around.
    func nextMark() {
        guard !marks.isEmpty, let view, let api = engine.api else { return }
        let current = selectedRow ?? -1
        let ids = marks
        Task { [weak self] in
            var rows: [(Int, String)] = []
            for id in ids {
                if let no = try? await api.locate(view: view.viewId, event: id) { rows.append((no - 1, id)) }
            }
            guard let self, self.view == view, !rows.isEmpty else { return }
            rows.sort { $0.0 < $1.0 }
            let next = rows.first { $0.0 > current } ?? rows[0]
            self.pendingRowForEvent = (next.1, next.0)
            self.select(event: next.1)
        }
    }

    // MARK: Find (⌘F, ⌘G, ⇧⌘G): jumps between matches without filtering

    func showFindBar() {
        isFindBarVisible = true
        findFocusRequest += 1
    }

    func find(_ query: String, forward: Bool) {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, let view, let api = engine.api else { return }
        findQuery = q
        findStatus = nil
        let from = selectedRow.map { $0 + 1 } ?? (forward ? 0 : view.count + 1)
        Task { [weak self] in
            do {
                let no = try await api.find(view: view.viewId, query: q, from: from, forward: forward)
                guard let self, self.view == view else { return }
                if let no {
                    self.select(row: no - 1)
                    self.revealRequest += 1
                } else {
                    self.findStatus = forward ? "No more matches below." : "No more matches above."
                    NSSound.beep()
                }
            } catch let e as APIError {
                self?.findStatus = e.isMissingRoute ? "Find needs a newer engine." : e.message
            } catch {}
        }
    }

    // MARK: Copy

    /// Copy as JSON fallback when no view handles ⌥⌘C: the selected event's composite document.
    func copySelectedEventAsJSON() {
        guard let detail = eventDetail else { return }
        AppKitHelpers.copy(detail.compositeDocument.prettyPrinted)
    }

    // MARK: History

    private func navigationChanged() {
        guard !isRestoring, !historyPending else { return }
        historyPending = true
        Task { [weak self] in
            guard let self else { return }
            self.historyPending = false
            self.history.record(self.navState, coalesce: true)
        }
    }

    /// Restore a navigation state completely: a state without an event clears the selection.
    func restore(_ s: NavState) {
        isRestoring = true
        defer { isRestoring = false }
        workspace = s.workspace
        if let mode = s.sessionMode { sessionMode = mode }
        scope = s.scope
        appliedFilter = s.filter
        filterText = s.filter
        selectedEvent = s.selectedEvent
        lensItem = s.lensItem
        compare = s.compare ?? CompareNav()
    }

    /// Restore a window's saved state at launch (scene storage) and start its history there.
    func restoreScene(_ s: NavState) {
        restore(s)
        history.reset(to: s)
    }
}
