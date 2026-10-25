import AppKit
import Foundation
import Observation

/// The Failures workspace of one window: the scope it asks for, the summary and the attention queue, the selected row
/// and what the Lens frame shows (SPEC §12.7, MAC-CONTRACT §5.2).
///
/// Scope (SPEC §7.8 row "Failures"): sessions and time range always; the display filter when Match Filter is on. With
/// Match Filter the window's view is the scope (an item matches when any of its events is in it); without it a view of
/// the sessions and time range alone. Nothing is requested without a valid view, so a failed view never turns into
/// whole-index numbers.
@MainActor @Observable final class FailuresModel {
    enum Phase: Equatable {
        case idle, loading, ready
        case failed(APIError)
        /// The engine predates the agent-native routes.
        case unavailable
    }

    /// What the Lens frame shows besides the window's `lensItem`.
    enum Panel: Hashable {
        case none
        case lens
        case signature(String)
        case run(session: String)
    }

    /// A section of the queue outline with the rows it shows. Attention sections show a page of rows until Show All.
    struct Section: Identifiable {
        let section: AttentionSection?
        let rows: [QueueRow]
        /// Items in the section: the summary's count, at least the rows loaded.
        var total: Int
        /// Rows loaded for the section; more than `rows` while it shows only its first page.
        var loaded: Int
        var expanded: Bool
        var id: String { section?.rawValue ?? "" }
        var hidden: Int { total - rows.count }
    }

    weak var window: WindowModel?
    /// The Lens frame's data.
    let lens = LensModel()
    private(set) var phase: Phase = .idle
    private(set) var summary: FailuresSummary?
    /// Items per attention section under the narrowing facets (Outcome, Family, Agent, Role, Unattended); nil without
    /// them. The summary takes no facets, so its section counts would describe the unfaceted queue.
    private(set) var facetedSections: [String: Int]?
    private(set) var rows: [QueueRow] = []
    private(set) var total = 0
    private(set) var gaps: [Gap] = []
    private(set) var isRefreshing = false
    private(set) var isLoadingMore = false
    /// Increments when `rows` change, so the outline reloads.
    private(set) var rowsGeneration = 0
    var selectedKey: String?
    var panel: Panel = .none
    var collapsed: Set<String> = ["other", "recovered"]
    /// Attention sections showing every loaded row (Show All), not only their first page.
    var expandedSections: Set<String> = []
    /// Sections whose rows are loading on their own (a jump or Show All).
    private(set) var loadingSections: Set<String> = []
    /// The section the jump bar asked for, and how many jumps were made (the outline scrolls to it).
    private(set) var jumpSection: AttentionSection?
    private(set) var jumpSerial = 0
    /// The section at the top of the queue's scroll viewport: the section index marks it.
    var visibleSection: String?
    /// Select the first row once the queue loads (the entry rule).
    var selectTopOnLoad = false
    /// A queue has loaded in this window: later loads that change the scope may replace the Lens item.
    @ObservationIgnored private var hasLoaded = false
    /// Pending ⌘' / ⌥⌘' moves while the queue loads.
    @ObservationIgnored private var pendingMove: (step: Int, attentionOnly: Bool)?

    @ObservationIgnored private var requestKey: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var ownView: (key: String, view: ViewInfo)?
    @ObservationIgnored private var lastLoad = Date.distantPast
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    /// Rows of a section loaded on their own, from its first row: a section the main page did not reach, or one
    /// expanded past it. Kept across live refreshes (and reloaded with them), dropped when the scope changes.
    @ObservationIgnored private var sectionRows: [String: [QueueRow]] = [:]
    static let pageSize = 200
    /// Rows an attention section shows before Show All.
    nonisolated static let sectionPage = 25
    /// The engine returns at most this many rows per request.
    nonisolated static let maxRows = 1000
    static let liveInterval: TimeInterval = 5

    var selectedRow: QueueRow? { selectedKey.flatMap { k in loadedRows.first { $0.rowKey == k } } }

    /// Every loaded row: the main page, then the rows of sections loaded on their own.
    private var loadedRows: [QueueRow] {
        var seen = Set(rows.map(\.rowKey))
        return rows + sectionRows.values.joined().filter { seen.insert($0.rowKey).inserted }
    }

    // MARK: Scope

    /// The query scope, or the reason there is none yet (`nil` while the view builds).
    private func scopeQuery(_ w: WindowModel, api: APIClient) async throws -> DerivedScopeQuery? {
        let f = w.failureFacets
        if f.matchFilter || (w.appliedFilter.isEmpty) {
            if !f.matchFilter && w.scope.isEmpty { return .global }
            guard let view = w.view else {
                if let e = w.viewError { throw e }
                return nil
            }
            return DerivedScopeQuery(view: view.viewId)
        }
        if w.scope.isEmpty { return .global }
        // Sessions and time range without the filter: a view of its own.
        let spec = ViewSpec(sessions: w.scope.sessions.isEmpty ? nil : w.scope.sessions, descendants: w.scope.sessions.isEmpty ? nil : true,
                            from: w.scope.from, to: w.scope.to)
        let key = "\(api.endpoint.baseURL)|\(spec.sessions ?? [])|\(spec.from ?? 0)|\(spec.to ?? 0)"
        if let own = ownView, own.key == key { return DerivedScopeQuery(view: own.view.viewId) }
        let v = try await api.createView(spec)
        ownView = (key, v)
        return DerivedScopeQuery(view: v.viewId)
    }

    private func key(_ w: WindowModel) -> String {
        let f = w.failureFacets
        let view = f.matchFilter || w.appliedFilter.isEmpty ? (w.view?.viewId ?? "pending") : "own"
        return [view, w.scope.sessions.joined(separator: ","), "\(w.scope.from ?? 0)-\(w.scope.to ?? 0)",
                f.tiers.map(\.rawValue).joined(separator: ","), f.outcomes.map(\.rawValue).joined(separator: ","),
                f.families.map(\.rawValue).joined(separator: ","), f.agents.map(\.rawValue).joined(separator: ","),
                f.roles.joined(separator: ","), "\(f.unattended.map { $0 ? 1 : 0 } ?? -1)", f.group.rawValue, f.sort,
                "\(f.matchFilter)", w.engine.api?.endpoint.baseURL.absoluteString ?? ""].joined(separator: "|")
    }

    // MARK: Loading

    /// Bring the queue up to date with the window (called when the workspace shows and when its inputs change).
    func sync() {
        guard let w = window else { return }
        if w.derived.availability == .missingRoutes {
            phase = .unavailable
            return
        }
        guard w.engine.api != nil else { return }
        let k = key(w)
        if k != requestKey { load(keep: false) }
    }

    func retry() {
        requestKey = nil
        ownView = nil
        load(keep: false)
    }

    /// After an index run: refresh in place (at most every 5 s), keeping rows and the selection.
    func indexDidFinish() {
        guard window?.workspace == .failures, phase == .ready, refreshTask == nil else { return }
        let wait = max(0, Self.liveInterval - Date().timeIntervalSince(lastLoad))
        refreshTask = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled, let self else { return }
            self.refreshTask = nil
            self.load(keep: true)
        }
    }

    private func load(keep: Bool) {
        guard let w = window, let api = w.engine.api else { return }
        task?.cancel()
        let k = key(w)
        requestKey = k
        lastLoad = Date()
        if keep && !rows.isEmpty { isRefreshing = true } else { phase = .loading }
        if !keep {
            if !sectionRows.isEmpty { rowsGeneration += 1 }
            sectionRows = [:]
            expandedSections = []
        }
        let facets = w.failureFacets
        let limit = max(Self.pageSize, keep ? rows.count : 0)
        let sectionLimits = keep ? sectionRows.mapValues { max(Self.sectionPage, $0.count) } : [:]
        task = Task { [weak self] in
            do {
                guard let self, let window = self.window, let q = try await self.scopeQuery(window, api: api) else {
                    self?.isRefreshing = false
                    return
                }
                async let summary = api.failuresSummary(q, tiers: facets.tiers)
                let page = try await api.failuresQueue(Self.request(q, facets: facets, limit: min(Self.maxRows, limit), offset: 0))
                let faceted = facets.narrows ? try await Self.sectionCounts(api: api, q: q, facets: facets) : nil
                var sections: [String: [QueueRow]] = [:]
                for (name, n) in sectionLimits {
                    var req = Self.request(q, facets: facets, limit: min(Self.maxRows, n), offset: 0)
                    req.section = AttentionSection(rawValue: name)
                    sections[name] = (try? await api.failuresQueue(req))?.rows
                }
                let s = try await summary
                guard !Task.isCancelled, self.requestKey == k else { return }
                var changed = false
                for (name, rows) in sections where self.sectionRows[name] != rows {
                    self.sectionRows[name] = rows
                    changed = true
                }
                self.install(page, summary: s, faceted: faceted, changed: changed, keep: keep)
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled, let self, self.requestKey == k else { return }
                self.isRefreshing = false
                let e = error as? APIError ?? .unreachable(error)
                if e.isNotServed {
                    self.phase = .unavailable
                } else if e.code == "view_expired" || e.isViewGone {
                    self.ownView = nil
                    self.requestKey = nil
                    self.window?.rebuildView(reason: .refresh)
                } else if keep && !self.rows.isEmpty {
                    self.phase = .ready
                } else {
                    self.phase = .failed(e)
                }
            }
        }
    }

    static func request(_ q: DerivedScopeQuery, facets f: FailureFacets, limit: Int, offset: Int) -> QueueRequest {
        QueueRequest(scope: q, group: f.group, tiers: f.tiers, outcomes: f.outcomes, families: f.families, agents: f.agents, roles: f.roles,
                     unattended: f.unattended, sort: f.sort, limit: limit, offset: offset)
    }

    /// Items per attention section under the facets, from one single-row queue request per section (each a few ms).
    static func sectionCounts(api: APIClient, q: DerivedScopeQuery, facets: FailureFacets) async throws -> [String: Int] {
        try await withThrowingTaskGroup(of: (String, Int).self) { group in
            for name in AttentionSection.known {
                var req = request(q, facets: facets, limit: 1, offset: 0)
                req.group = .attention
                req.section = name
                group.addTask { (name.rawValue, try await api.failuresQueue(req).total) }
            }
            return try await group.reduce(into: [:]) { $0[$1.0] = $1.1 }
        }
    }

    /// `changed`: the rows of sections loaded on their own changed too. `keep`: a live refresh of the same queue.
    private func install(_ page: QueuePage, summary s: FailuresSummary, faceted: [String: Int]?, changed: Bool, keep: Bool) {
        summary = s
        facetedSections = faceted
        gaps = page.gaps
        total = page.total
        if changed || page.rows != rows {
            rows = page.rows
            rowsGeneration += 1
        }
        phase = .ready
        isRefreshing = false
        if let k = selectedKey, !loadedRows.contains(where: { $0.rowKey == k }) { selectedKey = nil }
        if selectedKey == nil, let shown = window?.lensItem.flatMap(row(showing:)) { selectedKey = shown.rowKey }
        // The Lens never sits on its placeholder beside a queue with rows: the first load fills an empty Lens (a
        // restored item stays), and a new scope or new facets replace an item the queue no longer holds.
        let lensIsEmptyOrStale = window?.lensItem == nil || (hasLoaded && !keep && selectedKey == nil)
        let opensTop = selectTopOnLoad || (lensIsEmptyOrStale && window?.workspace == .failures && (panel == .lens || panel == .none))
        hasLoaded = true
        if opensTop, let first = displayOrder.first {
            selectTopOnLoad = false
            select(first)
        }
        if let m = pendingMove {
            pendingMove = nil
            move(by: m.step, attentionOnly: m.attentionOnly)
        }
        // Sections that need attention but lie past the main page (thousands of blocked rows can fill it) load their
        // first page on their own, so every one of them shows rows.
        if window?.failureFacets.group == .attention {
            for sec in sections where sec.loaded == 0 && sec.total > 0 && sec.section?.needsAttention == true {
                if let name = sec.section { loadSection(name, limit: Self.sectionPage) }
            }
        }
    }

    func loadMore() {
        guard let w = window, let api = w.engine.api, !isLoadingMore, rows.count < total else { return }
        isLoadingMore = true
        let facets = w.failureFacets
        let k = requestKey
        let offset = rows.count
        Task { [weak self] in
            defer { self?.isLoadingMore = false }
            guard let self, let window = self.window, let q = try? await self.scopeQuery(window, api: api),
                  let page = try? await api.failuresQueue(Self.request(q, facets: facets, limit: Self.pageSize, offset: offset)),
                  self.requestKey == k else { return }
            self.rows += page.rows.filter { r in !self.rows.contains { $0.rowKey == r.rowKey } }
            self.total = page.total
            self.rowsGeneration += 1
        }
    }

    // MARK: Outline

    /// Rows grouped by attention section in display order, each showing its first page until Show All; a single
    /// unnamed group for the other groupings.
    var sections: [Section] {
        guard window?.failureFacets.group == .attention else {
            return [Section(section: nil, rows: rows, total: rows.count, loaded: rows.count, expanded: true)]
        }
        return Self.attentionSections(rows: rows, sectionRows: sectionRows, counts: facetedSections ?? summary?.sections ?? [:],
                                      expanded: expandedSections)
    }

    /// The main page's rows by section, replaced by a section's own rows where loaded, in display order; a section
    /// the summary counts appears even before any of its rows has loaded.
    static func attentionSections(rows: [QueueRow], sectionRows: [String: [QueueRow]], counts: [String: Int], expanded: Set<String>) -> [Section] {
        var by: [String: [QueueRow]] = [:]
        for r in rows { by[r.section?.rawValue ?? "other", default: []].append(r) }
        for (k, v) in sectionRows { by[k] = v }
        var names = AttentionSection.known.filter { by[$0.rawValue] != nil || (counts[$0.rawValue] ?? 0) > 0 }
        names += by.keys.sorted().map(AttentionSection.init(rawValue:)).filter { !names.contains($0) }
        return names.map { s in
            let loaded = by[s.rawValue] ?? []
            let all = expanded.contains(s.rawValue)
            return Section(section: s, rows: all ? loaded : Array(loaded.prefix(sectionPage)),
                           total: max(loaded.count, counts[s.rawValue] ?? 0), loaded: loaded.count, expanded: all)
        }
    }

    /// The more row of a section: its first page when nothing is loaded, then every row (up to the engine's limit).
    func showMore(_ s: Section) {
        guard let name = s.section else { return }
        if s.loaded == 0 { return loadSection(name, limit: Self.sectionPage) }
        expandedSections.insert(name.rawValue)
        if s.loaded < min(s.total, Self.maxRows) { loadSection(name, limit: Self.maxRows) }
    }

    /// The jump bar: open the section, load its first page if the main page did not reach it, and scroll to it.
    func jump(to name: AttentionSection) {
        collapsed.remove(name.rawValue)
        if let s = sections.first(where: { $0.section == name }), s.loaded == 0, s.total > 0 { loadSection(name, limit: Self.sectionPage) }
        jumpSection = name
        jumpSerial += 1
    }

    /// Load a section's rows from its first row, on its own (`GET /api/failures/queue?section=`).
    private func loadSection(_ name: AttentionSection, limit: Int) {
        guard let w = window, let api = w.engine.api, !loadingSections.contains(name.rawValue) else { return }
        let k = requestKey, facets = w.failureFacets
        loadingSections.insert(name.rawValue)
        Task { [weak self] in
            defer { self?.loadingSections.remove(name.rawValue) }
            guard let self, let window = self.window, let q = try? await self.scopeQuery(window, api: api) else { return }
            var req = Self.request(q, facets: facets, limit: limit, offset: 0)
            req.section = name
            guard let page = try? await api.failuresQueue(req), self.requestKey == k else { return }
            self.sectionRows[name.rawValue] = page.rows
            self.rowsGeneration += 1
        }
    }

    /// Every row in outline order.
    var displayOrder: [QueueRow] { sections.flatMap(\.rows) }

    // MARK: Selection

    /// The loaded row whose Lens frame is `item`.
    func row(showing item: LensItem) -> QueueRow? {
        loadedRows.first { r in
            switch (item.kind, r.kind) {
            case (.episode, .episode), (.delegation, .delegation): return r.id == item.id
            case (.claim, .claim): return (r.turnId ?? r.id) == item.id
            default: return false
            }
        }
    }

    /// Select a row and show it in the Lens frame, by `QueueRow.kind` (types.ts).
    func select(_ r: QueueRow) {
        selectedKey = r.rowKey
        guard let w = window else { return }
        if let s = r.section, collapsed.contains(s.rawValue) { collapsed.remove(s.rawValue) }
        switch r.kind {
        case .episode: w.openLens(LensItem(kind: .episode, id: r.id), reveal: false)
        case .claim: w.openLens(LensItem(kind: .claim, id: r.turnId ?? r.id), reveal: false)
        case .delegation: w.openLens(LensItem(kind: .delegation, id: r.id), reveal: false)
        case .signature: showSignature(r.signatureId ?? r.id)
        case .session: panel = .run(session: r.sessionId ?? r.id)
        case .alarm: openAlarm(id: r.id, session: r.sessionId)
        default:
            if let s = r.sessionId { panel = .run(session: s) }
        }
    }

    /// An alarm opens its episode, else its delegation, else the run report of its session (Return shows its turn in Steps).
    func openAlarm(id: String, session: String?) {
        guard let w = window else { return }
        if let a = w.derived.alarm(id: id) { return openAlarm(a) }
        guard let api = w.engine.api, let session else {
            if let session { panel = .run(session: session) }
            return
        }
        panel = .run(session: session)
        Task { [weak self] in
            guard let page = try? await api.alarms(DerivedScopeQuery(session: session, descendants: false), limit: 500),
                  let a = page.rows.first(where: { $0.id == id }) else { return }
            self?.openAlarm(a)
        }
    }

    func openAlarm(_ a: AlarmItem) {
        guard let w = window else { return }
        if let e = a.episodeId {
            w.openLens(LensItem(kind: .episode, id: e), reveal: false)
        } else if let d = a.delegationId {
            w.openLens(LensItem(kind: .delegation, id: d), reveal: false)
        } else {
            panel = .run(session: a.sessionId)
        }
    }

    func showSignature(_ id: String) {
        panel = .signature(id)
    }

    /// ⌘' / ⇧⌘' (step ±1 over items) and ⌥⌘' (next item in a section that needs attention).
    func move(by step: Int, attentionOnly: Bool) {
        if phase != .ready {
            pendingMove = (step, attentionOnly)
            return
        }
        let order = displayOrder.filter { r in
            !attentionOnly || (r.section?.needsAttention ?? false) || window?.failureFacets.group != .attention
        }
        guard !order.isEmpty else { return NSSound.beep() }
        let current = selectedKey.flatMap { k in order.firstIndex { $0.rowKey == k } }
        let next: Int
        if let current {
            next = current + step
        } else {
            next = step > 0 ? 0 : order.count - 1
        }
        guard order.indices.contains(next) else { return NSSound.beep() }
        select(order[next])
    }

    // MARK: Labels

    /// "41 episodes · 12 need attention · filter + since 23:04 +08:00" (SPEC §12.7). Under narrowing facets the
    /// episodes are the faceted ones and the facets are named: "1,742 episodes · family sandbox · 3,032 need attention
    /// in all".
    var scopeLabel: String {
        guard let w = window else { return "Failures" }
        var lead: [String] = []
        if let s = summary {
            if facetedSections != nil {
                lead.append(Formatters.count(scopedEpisodes ?? 0, "episode"))
                lead.append(w.failureFacets.narrowingWords)
                lead.append("\(Formatters.count(s.needAttention)) need attention in all")
            } else {
                lead.append(Formatters.count(s.episodes, "episode"))
                lead.append("\(Formatters.count(s.needAttention)) need attention")
            }
        } else {
            lead.append("Failures")
        }
        var parts: [String] = []
        if w.failureFacets.matchFilter && !w.appliedFilter.isEmpty { parts.append("filter") }
        // The scope tokens name the session and the time; the label names only what narrows.
        if w.scope.hasSessions { parts.append(Formatters.count(w.scope.sessions.count, "session")) }
        if w.scope.hasTimeRange {
            parts.append(ScopeBar.rangeLabel(from: w.scope.from, to: w.scope.to))
        } else if w.entrySince == .firstVisit {
            parts.append("first visit")
        }
        return (lead + [parts.isEmpty ? "all sessions" : parts.joined(separator: " + ")]).joined(separator: " · ")
    }

    /// A Signature row counts the episodes of this scope and facets but the sessions of all time (Mac notes 12), so its
    /// counts name their scope whenever anything narrows the queue.
    var countsAreScoped: Bool {
        guard let w = window else { return false }
        return !w.scope.isEmpty || (w.failureFacets.matchFilter && !w.appliedFilter.isEmpty) || facetedSections != nil
    }

    /// Episodes in the scope, under the narrowing facets when they apply; nil until the summary loads.
    var scopedEpisodes: Int? {
        guard let s = summary else { return nil }
        guard let f = facetedSections else { return s.episodes }
        return AttentionSection.episodeSections.reduce(0) { $0 + (f[$1.rawValue] ?? 0) }
    }

    /// The tier toggle's text: "Failures 1,204", "+suspect 212≈", "+benign 61".
    func tierText(_ t: FailureTier) -> String {
        let n = summary?.tierCount(t) ?? 0
        return t == .failure ? "Failures \(DerivedStyle.tierCount(t, n))" : "+\(t.rawValue) \(DerivedStyle.tierCount(t, n))"
    }
}
