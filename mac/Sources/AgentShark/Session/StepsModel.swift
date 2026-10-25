import AppKit
import Foundation
import Observation

/// Session · Steps of one window: the focused session's turns and steps, its Run report, and the options that shape
/// the list (SPEC §12.7). Scope (§7.8 row "Session · Steps"): one session plus a descendants toggle; the time range
/// and the display filter highlight and dim steps, and never hide one.
@MainActor @Observable final class StepsModel {
    enum Phase: Equatable {
        case idle, loading, ready
        case failed(APIError)
        case unavailable
    }

    weak var window: WindowModel?
    private(set) var phase: Phase = .idle
    private(set) var sessionID: String?
    private(set) var turns: [StepTurn] = []
    private(set) var steps: [StepItem] = []
    private(set) var total = 0
    private(set) var matched: Int?
    private(set) var gaps: [Gap] = []
    private(set) var next: String?
    private(set) var isLoadingMore = false
    private(set) var isRefreshing = false
    /// Increments when turns or steps change (the outline reloads).
    private(set) var generation = 0
    private(set) var report: RunReport?
    private(set) var reportError: APIError?

    /// `seq` (the tree) or a flat sort: `active` (model plus tool time), `dur` (wall time, which includes the idle
    /// gap to the next step), `tokIn`, `tokOut` or `ctx`.
    var sort = "seq" { didSet { if sort != oldValue { reload() } } }
    var ascending = false { didSet { if ascending != oldValue { reload() } } }
    var descendants = false { didSet { if descendants != oldValue { reload() } } }
    var foldClean = false { didSet { if foldClean != oldValue { reload() } } }
    var onlyFailed = false { didSet { if onlyFailed != oldValue { reload() } } }
    /// The turn time bar's segment that narrows the list.
    var bucket: TimeBucketName? { didSet { if bucket != oldValue { reload() } } }
    /// ⌘↩: the event whose step should be revealed and selected.
    private(set) var focusEventID: String?
    /// The step to reveal once loaded, and how many reveal requests were made (the outline follows it).
    private(set) var focusStepID: String?
    /// The turn to reveal and select (Statistics ▸ Turns) once it is loaded, and the loaded turn the outline reveals
    /// at the next `focusSerial`.
    private(set) var focusTurnID: String?
    private(set) var revealTurnID: String?
    private(set) var focusSerial = 0
    var selectedStepID: String?
    /// Steps columns the person hid (Options ▸ Columns), kept across launches; and the columns the table hid because they
    /// did not fit (DESIGN.md §4.4), for the header's "2 columns hidden".
    var userHiddenColumns: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "AgentShark.StepsHiddenColumns") ?? []) {
        didSet { UserDefaults.standard.set(Array(userHiddenColumns).sorted(), forKey: "AgentShark.StepsHiddenColumns") }
    }
    var autoHiddenColumns: [String] = []

    /// Interventions of the session (SPEC §12.3.8), by step and by turn; association only, never a cause.
    private(set) var interventionsByStep: [String: [InterventionItem]] = [:]
    private(set) var interventionsByTurn: [String: [InterventionItem]] = [:]

    @ObservationIgnored private var requestKey: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var reportTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var lastLoad = Date.distantPast
    static let pageSize = 500
    /// The most steps one request returns.
    static let maxPage = 5000

    var isFlat: Bool { sort != "seq" }

    var selectedStep: StepItem? { selectedStepID.flatMap { id in steps.first { $0.id == id } } }

    func turn(of step: StepItem) -> StepTurn? { step.turnId.flatMap { id in turns.first { $0.id == id } } }

    /// The server's data-gap note that explains a missing value in a Steps column (§7.8 Missing values), if any.
    func gapNote(for column: String) -> String? {
        let fields: [String: [String]] = [
            "model": ["steps[].modelUs"], "ctx": ["steps[].ctxTokens", "steps[].ctxWindow"], "tokOut": ["steps[].tokOut"],
            "active": ["steps[].activeUs", "steps[].modelUs"], "gap": ["steps[].gapUs", "steps[].activeUs", "steps[].modelUs"],
        ]
        for f in fields[column] ?? [] {
            if let g = gaps.first(where: { $0.field == f }) { return g.message }
        }
        return nil
    }

    /// The step's place in its turn, "k of m" (DESIGN.md §9 Step position).
    func place(of step: StepItem) -> (k: Int, of: Int)? {
        guard let t = turn(of: step) else { return nil }
        let before = steps.filter { $0.turnId == t.id && $0.n < step.n }.count
        return (before + 1, max(t.nSteps, before + 1))
    }

    // MARK: Loading

    private func viewForHighlights(_ w: WindowModel) -> String? {
        guard !w.appliedFilter.isEmpty || w.scope.hasTimeRange else { return nil }
        return w.view?.viewId
    }

    private func key(_ w: WindowModel) -> String {
        [w.focusedSessionID ?? "", viewForHighlights(w) ?? "", sort, "\(ascending)", "\(descendants)", "\(foldClean)", "\(onlyFailed)",
         bucket?.rawValue ?? "", "\(w.scope.from ?? 0)", w.engine.api?.endpoint.baseURL.absoluteString ?? ""].joined(separator: "|")
    }

    func sync() {
        guard let w = window else { return }
        if w.derived.availability == .missingRoutes {
            phase = .unavailable
            return
        }
        guard w.engine.api != nil else { return }
        // The filter or time range is rebuilding the view: wait for it rather than drop the highlights.
        if (!w.appliedFilter.isEmpty || w.scope.hasTimeRange) && w.view == nil && w.viewError == nil && !steps.isEmpty { return }
        if key(w) != requestKey { load(keep: w.focusedSessionID == sessionID && !steps.isEmpty) }
    }

    func reload() {
        requestKey = nil
        sync()
    }

    func retry() {
        requestKey = nil
        load(keep: false)
    }

    func indexDidFinish() {
        guard window?.workspace == .session, window?.sessionMode == .steps, phase == .ready, refreshTask == nil else { return }
        let wait = max(0, 5 - Date().timeIntervalSince(lastLoad))
        refreshTask = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled, let self else { return }
            self.refreshTask = nil
            self.load(keep: true)
        }
    }

    private func request(_ w: WindowModel, after: String?) -> StepsRequest {
        StepsRequest(view: viewForHighlights(w), after: after, limit: Self.pageSize, sort: isFlat ? sort : nil,
                     order: isFlat ? (ascending ? "asc" : "desc") : nil, descendants: descendants ? true : nil,
                     foldClean: foldClean ? true : nil, onlyFailed: onlyFailed ? true : nil, bucket: bucket)
    }

    private func load(keep: Bool) {
        guard let w = window, let api = w.engine.api else { return }
        task?.cancel()
        let k = key(w)
        requestKey = k
        lastLoad = Date()
        guard let session = w.focusedSessionID else {
            sessionID = nil
            turns = []
            steps = []
            report = nil
            phase = .idle
            generation += 1
            return
        }
        if session != sessionID { report = nil; selectedStepID = nil }
        sessionID = session
        if keep { isRefreshing = true } else { phase = .loading }
        let req = request(w, after: nil)
        let wanted = keep ? max(steps.count, Self.pageSize) : Self.pageSize
        loadReport(api: api, session: session, since: w.scope.from)
        loadInterventions(api: api, session: session)
        task = Task { [weak self] in
            do {
                var q = req
                q.limit = max(q.limit, min(Self.maxPage, wanted))
                let page = try await api.sessionSteps(session, q)
                guard !Task.isCancelled, let self, self.requestKey == k else { return }
                self.turns = page.turns
                self.total = page.total
                self.matched = page.matched
                self.steps = page.steps
                self.gaps = page.gaps
                self.next = page.next
                self.phase = .ready
                self.isRefreshing = false
                self.generation += 1
                self.resolveFocus()
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled, let self, self.requestKey == k else { return }
                self.isRefreshing = false
                let e = error as? APIError ?? .unreachable(error)
                if e.isNotServed {
                    self.phase = .unavailable
                } else if e.code == "view_expired" || e.isViewGone {
                    self.requestKey = nil
                    self.window?.rebuildView(reason: .refresh)
                } else if keep && !self.steps.isEmpty {
                    self.phase = .ready
                } else {
                    self.phase = .failed(e)
                }
            }
        }
    }

    private func loadReport(api: APIClient, session: String, since: Int64?) {
        reportTask?.cancel()
        reportTask = Task { [weak self] in
            do {
                let r = try await api.runReport(session: session, since: since)
                guard !Task.isCancelled, let self, self.sessionID == session else { return }
                self.report = r.payload
                self.reportError = nil
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled, let self, self.sessionID == session else { return }
                self.reportError = error as? APIError ?? .unreachable(error)
            }
        }
    }

    private func loadInterventions(api: APIClient, session: String) {
        let q = DerivedScopeQuery(session: session, descendants: descendants)
        Task { [weak self] in
            let rows = (try? await api.interventions(q, limit: 2000))?.rows ?? []
            guard let self, self.sessionID == session else { return }
            self.interventionsByStep = Dictionary(grouping: rows.filter { $0.stepId != nil }, by: { $0.stepId! })
            self.interventionsByTurn = Dictionary(grouping: rows.filter { $0.turnId != nil }, by: { $0.turnId! })
            self.generation += 1
        }
    }

    func loadMore() {
        guard let w = window, let api = w.engine.api, let session = sessionID, let after = next, !isLoadingMore else { return }
        isLoadingMore = true
        let k = requestKey
        let req = request(w, after: after)
        Task { [weak self] in
            defer { self?.isLoadingMore = false }
            guard let page = try? await api.sessionSteps(session, req), let self, self.requestKey == k else { return }
            let known = Set(self.turns.map(\.id))
            self.turns += page.turns.filter { !known.contains($0.id) }
            self.steps += page.steps
            self.next = page.next
            self.generation += 1
            self.resolveFocus()
        }
    }

    // MARK: Focus (⌘↩ Show in Session)

    /// Reveal and select the step that holds `eventID`, loading pages until it is there.
    func focus(event eventID: String) {
        focusEventID = eventID
        focusStepID = nil
        focusTurnID = nil
        revealTurnID = nil
        guard let api = window?.engine.api else { return }
        if let s = steps.first(where: { $0.calls.contains { $0.eventId == eventID || $0.resultEventId == eventID } }) {
            setFocus(s.id)
            return
        }
        Task { [weak self] in
            guard let d = try? await api.eventDerived(eventID), let self, self.focusEventID == eventID else { return }
            if let step = d.step { self.setFocus(step.id) }
        }
    }

    /// Reveal and select a turn row, loading pages until it is there.
    func focus(turn turnID: String) {
        focusEventID = nil
        focusStepID = nil
        revealTurnID = nil
        focusTurnID = turnID
        focusPages = 0
        resolveFocus()
    }

    private func setFocus(_ stepID: String) {
        focusStepID = stepID
        selectedStepID = stepID
        resolveFocus()
    }

    private var focusPages = 0

    private func resolveFocus() {
        if let t = focusTurnID {
            if turns.contains(where: { $0.id == t }) {
                focusPages = 0
                focusTurnID = nil
                revealTurnID = t
                focusSerial += 1
            } else if next != nil, focusPages < 20 {
                focusPages += 1
                loadMore()
            }
            return
        }
        guard let id = focusStepID else { return }
        if steps.contains(where: { $0.id == id }) {
            focusPages = 0
            selectedStepID = id
            focusSerial += 1
        } else if next != nil, focusPages < 20 {
            focusPages += 1
            loadMore()
        }
    }

    // MARK: Labels

    /// "79 steps · filter highlights 14" (DESIGN.md §7.8): the session title is in the Run report strip only.
    func scopeLabel() -> String {
        guard phase == .ready || !steps.isEmpty else { return "Steps" }
        var parts = [Formatters.count(total, "step")]
        if let matched, let w = window, !w.appliedFilter.isEmpty || w.scope.hasTimeRange {
            let what = !w.appliedFilter.isEmpty && w.scope.hasTimeRange ? "filter and range" : !w.appliedFilter.isEmpty ? "filter" : "range"
            parts.append("\(what) highlights \(Formatters.count(matched))")
        }
        if descendants { parts.append("with subagents") }
        return parts.joined(separator: " · ")
    }

    func turn(_ id: String?) -> StepTurn? { id.flatMap { t in turns.first { $0.id == t } } }
}
