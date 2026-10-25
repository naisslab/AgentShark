import AppKit
import Observation

/// A lifeline of the sequence diagram.
struct FlowLane: Hashable {
    var key: String
    var title: String
    var subtitle: String?
    /// The subagent session a lane stands for; its header opens it.
    var session: String?
    var color: NSColor?
}

/// What one event draws: an arrow between lanes, a note on a lane, or a turn separator.
enum FlowStep {
    case arrow(from: String, to: String, color: NSColor, dashed: Bool, label: String)
    case note(lane: String, color: NSColor, label: String)
    case separator(color: NSColor, label: String)
}

/// Data of the Flow workspace (MAC-SPEC §7, SPEC §7.5): a sequence diagram of exactly one session, or of the selected
/// turn. Lanes are User, Agent, one per tool kind the session used, and one per subagent. Each event of a session
/// view in file order is one row. Scope contract (SPEC §7.8): one session; the time range applies; the display
/// filter does not.
@MainActor @Observable final class FlowController {
    enum Phase: Equatable { case noSession, waitingForEngine, loading, failed(APIError), empty, ready }

    let model: WindowModel
    private(set) var phase: Phase = .loading
    private(set) var sessionID: String?
    private(set) var count = 0
    /// Show only the turn of the selected event.
    var turnOnly = false { didSet { if turnOnly != oldValue { sync() } } }
    private(set) var turnID: String?

    @ObservationIgnored private(set) var lanes: [FlowLane] = []
    @ObservationIgnored private(set) var pager: EventPager?
    /// Time of the first event drawn; the gutter shows offsets from it.
    @ObservationIgnored private(set) var base: Int64 = 0
    @ObservationIgnored private(set) var selectedIndex: Int?
    @ObservationIgnored weak var view: FlowDiagramView?
    @ObservationIgnored private var spawn: [String: String] = [:]
    @ObservationIgnored private var toolKinds: [String: String] = [:]
    @ObservationIgnored private var key = ""
    @ObservationIgnored private var generation = -1
    @ObservationIgnored private var lastLoadAt = Date.distantPast
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var loadSeq = 0
    @ObservationIgnored private var locateTask: Task<Void, Never>?
    @ObservationIgnored private var ownSelection: String?
    @ObservationIgnored private var flowView: ViewInfo?

    static let toolLanes = ["shell", "file", "web", "mcp", "agent", "plan", "other"]
    static let maxSubagentLanes = 12
    /// `kind in {…}` rather than layer words: a bare `agent` would name the session.agent field.
    static let kinds = ["user.prompt", "llm.text", "llm.error", "tool.call", "tool.result", "agent.spawn", "agent.message", "agent.status",
                        "turn.start", "turn.end", "turn.abort"]
    static let filter = "kind in {" + kinds.map(FilterExpression.quote).joined(separator: ", ") + "}"

    init(model: WindowModel) {
        self.model = model
        observe()
    }

    private func observe() {
        withObservationTracking {
            _ = model.focusedSessionID
            _ = model.scope
            _ = model.selectedEvent
            _ = model.eventDetail
            _ = model.showInherited
            _ = model.store.indexGeneration
            _ = model.engine.api
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.observe()
                self?.sync()
            }
        }
    }

    // MARK: Loading

    func sync() {
        let sid = model.focusedSessionID
        var turn: String?
        if turnOnly, let selected = model.selectedEvent {
            // Wait for the selected event's detail before switching turns.
            guard let d = model.eventDetail, d.event.id == selected else { return }
            turn = d.event.turn
        }
        guard let api = model.engine.api else {
            phase = sid == nil ? .noSession : .waitingForEngine
            return
        }
        let k = [sid ?? "", turn ?? "", model.scope.from.map(String.init) ?? "", model.scope.to.map(String.init) ?? "",
                 String(model.showInherited), api.endpoint.baseURL.absoluteString].joined(separator: "|")
        if k != key {
            key = k
            load(sid, turn: turn, api: api, refresh: false)
        } else if model.store.indexGeneration != generation, phase == .ready || phase == .empty {
            scheduleRefresh(sid, turn: turn, api: api)
        } else {
            followSelection()
        }
    }

    func retry() {
        key = ""
        sync()
    }

    /// After an index run, rebuild in place (at most every few seconds) and keep the scroll position.
    private func scheduleRefresh(_ sid: String?, turn: String?, api: APIClient) {
        guard refreshTask == nil else { return }
        let wait = TimelineController.refreshInterval - Date().timeIntervalSince(lastLoadAt)
        refreshTask = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled, let self else { return }
            self.refreshTask = nil
            self.load(sid, turn: turn, api: api, refresh: true)
        }
    }

    private func load(_ sid: String?, turn: String?, api: APIClient, refresh: Bool) {
        loadSeq += 1
        let seq = loadSeq
        refreshTask?.cancel()
        refreshTask = nil
        generation = model.store.indexGeneration
        lastLoadAt = Date()
        if !refresh {
            pager?.cancel()
            pager = nil
            flowView = nil
            lanes = []
            count = 0
            selectedIndex = nil
            sessionID = sid
            turnID = turn
            view?.reload(keepPosition: false)
        }
        guard let sid else {
            phase = .noSession
            return
        }
        if !refresh { phase = .loading }
        let generation = generation
        let filter = turn.map { "(\(Self.filter)) && turn == \(FilterExpression.quote($0))" } ?? Self.filter
        let spec = ViewSpec(filter: filter, sessions: [sid], descendants: false, from: model.scope.from, to: model.scope.to,
                            includeInherited: model.showInherited ? true : nil)
        Task { [weak self] in
            do {
                async let detailRequest = TimelineData.sessionDetail(sid, api: api, generation: generation)
                let info = try await api.createView(spec)
                let detail = try await detailRequest
                async let toolsRequest = try? api.statsTools(view: info.viewId)
                async let workflowsRequest = try? api.spans(sessions: [sid], from: nil, to: nil, kinds: ["workflow"], limit: 1000)
                let (tools, workflows) = await (toolsRequest, workflowsRequest)
                guard let self, seq == self.loadSeq else { return }
                self.buildLanes(detail, tools: tools, workflows: workflows?.spans ?? [])
                self.base = info.firstTs ?? detail.session.start ?? 0
                self.pager?.cancel()
                let pager = EventPager(api: api, view: info, columns: [])
                pager.onRowsLoaded = { [weak self] rows in self?.view?.rowsLoaded(rows) }
                self.pager = pager
                self.flowView = info
                self.count = info.count
                self.phase = info.count == 0 ? .empty : .ready
                self.view?.reload(keepPosition: refresh)
                self.followSelection(force: !refresh)
            } catch {
                guard let self, seq == self.loadSeq else { return }
                // A failed refresh keeps the diagram; the next index run tries again.
                if !refresh { self.phase = .failed(error as? APIError ?? .unreachable(error)) }
            }
        }
    }

    private static func laneKind(_ kind: String?) -> String {
        guard let kind, toolLanes.contains(kind) else { return "other" }
        return kind
    }

    private func buildLanes(_ detail: SessionDetail, tools: [ToolStat]?, workflows: [SpanRow]) {
        toolKinds = Dictionary((tools ?? []).map { ($0.tool, Self.laneKind(Self.toolLanes.contains($0.kind) ? $0.kind : ToolKinds.kind(of: $0.tool))) },
                               uniquingKeysWith: { a, _ in a })
        // Without tool statistics every tool lane is shown, so no call loses its target.
        let used = tools == nil ? Set(Self.toolLanes) : Set(toolKinds.values)
        let s = detail.session.row
        let children = detail.children.filter { $0.parentSpanId != nil }.sorted { ($0.start ?? 0, $0.id) < ($1.start ?? 0, $1.id) }
        let shown = Array(children.prefix(Self.maxSubagentLanes))
        var lanes = [
            FlowLane(key: "user", title: "User", color: Theme.color(.user)),
            FlowLane(key: "agent", title: "Agent", subtitle: s.models.isEmpty ? s.agent.label : s.models.joined(separator: ", "),
                     color: Theme.agentColor(s.agent)),
        ]
        let titles = ["shell": "Shell", "file": "Files", "web": "Web", "mcp": "MCP", "agent": "Agent Tools", "plan": "Plan", "other": "Other Tools"]
        for k in Self.toolLanes where used.contains(k) {
            lanes.append(FlowLane(key: "tool:" + k, title: titles[k] ?? k, color: Self.toolColor(k)))
        }
        for c in shown {
            lanes.append(FlowLane(key: "sub:" + c.id, title: c.displayTitle, subtitle: TimelineText.roleBadge(c.role) ?? c.role, session: c.id,
                                  color: Theme.color(.agent)))
        }
        if children.count > shown.count {
            lanes.append(FlowLane(key: "sub:*", title: "\(children.count - shown.count) More Subagents", color: Theme.color(.agent)))
        }
        self.lanes = lanes
        // A child's parentSpanId is the tool span that launched it; workflow agents hang off a workflow span whose
        // parent is the Workflow tool span.
        let wfParent = Dictionary(workflows.map { ($0.id, $0.parent) }, uniquingKeysWith: { a, _ in a })
        spawn = [:]
        for c in children {
            let lane = shown.contains(c) ? "sub:" + c.id : "sub:*"
            for spanID in [c.parentSpanId, c.parentSpanId.flatMap { wfParent[$0] ?? nil }] {
                if let spanID, spawn[spanID] == nil { spawn[spanID] = lane }
            }
        }
    }

    static func toolColor(_ kind: String) -> NSColor {
        switch kind {
        case "shell": return Theme.color(.toolShell)
        case "file": return Theme.color(.toolFile)
        case "web": return Theme.color(.toolWeb)
        case "mcp": return Theme.color(.toolMcp)
        case "agent": return Theme.color(.agent)
        default: return Theme.color(.toolOther)
        }
    }

    // MARK: Classification

    func step(for ev: EventRow) -> FlowStep {
        let err = ev.isError
        let label = ev.summary.isEmpty ? ev.kind.rawValue : ev.summary
        func toolLane() -> String {
            if let span = ev.span, let lane = spawn[span] { return lane }
            return "tool:" + Self.laneKind(toolKinds[ev.toolName ?? ""] ?? ToolKinds.kind(of: ev.toolName))
        }
        func color(_ lane: String, error: Bool = false) -> NSColor {
            if error { return Theme.err }
            if lane.hasPrefix("sub:") { return Theme.color(.agent) }
            return Self.toolColor(String(lane.dropFirst(5)))
        }
        switch ev.kind {
        case .userPrompt:
            return .arrow(from: "user", to: "agent", color: Theme.color(.user), dashed: false, label: label)
        case .llmText:
            return .arrow(from: "agent", to: "user", color: Theme.color(.llm), dashed: false, label: label)
        case .toolCall:
            let to = toolLane()
            return .arrow(from: "agent", to: to, color: color(to, error: err), dashed: false, label: label)
        case .toolResult:
            let from = toolLane()
            return .arrow(from: from, to: "agent", color: color(from, error: err), dashed: true, label: label + Self.durationSuffix(ev, label))
        case .agentSpawn, .agentMessage:
            return .arrow(from: "agent", to: ev.span.flatMap { spawn[$0] } ?? "tool:agent", color: Theme.color(.agent), dashed: false, label: label)
        case .agentStatus:
            if let from = ev.span.flatMap({ spawn[$0] }) {
                return .arrow(from: from, to: "agent", color: Theme.color(.agent), dashed: true, label: label)
            }
            return .note(lane: "agent", color: .secondaryLabelColor, label: label)
        case .turnStart:
            return .separator(color: Theme.color(.user), label: label)
        case .turnEnd, .turnAbort:
            return .separator(color: err || ev.kind == .turnAbort ? Theme.err : .tertiaryLabelColor, label: label + Self.durationSuffix(ev, label))
        default:
            return .note(lane: "agent", color: err ? Theme.err : .secondaryLabelColor, label: label)
        }
    }

    /// " · 3.21s" for an event with a duration, unless its summary already ends with one, such as "(2.9 s)".
    private static func durationSuffix(_ ev: EventRow, _ summary: String) -> String {
        guard let d = ev.dur else { return "" }
        if summary.range(of: #"\([0-9.,]+ ?(µs|us|ms|s|min|m|h)\)\s*$"#, options: .regularExpression) != nil { return "" }
        return " · " + Formatters.duration(d)
    }

    // MARK: Selection

    /// Select the event of row `index`; `reveal` switches to Events.
    func select(row index: Int, reveal: Bool) {
        guard let pager, index >= 0, index < count else { return }
        selectedIndex = index
        view?.selectionChanged(scrollTo: index)
        if let r = pager.row(at: index) {
            ownSelection = r.id
            model.select(event: r.id, reveal: reveal)
            return
        }
        Task { [weak self] in
            guard let r = try? await pager.rows(in: index..<(index + 1)).first, let self, self.selectedIndex == index else { return }
            self.ownSelection = r.id
            self.model.select(event: r.id, reveal: reveal)
        }
    }

    /// Find the window's selected event in this diagram.
    private func followSelection(force: Bool = false) {
        guard let id = model.selectedEvent, let info = flowView, let api = model.engine.api else {
            if model.selectedEvent == nil, selectedIndex != nil {
                selectedIndex = nil
                view?.selectionChanged(scrollTo: nil)
            }
            return
        }
        if id == ownSelection && !force { return }
        ownSelection = id
        if let pager, let i = pager.cachedIndex(ofEvent: id) {
            selectedIndex = i
            view?.selectionChanged(scrollTo: i)
            return
        }
        locateTask?.cancel()
        locateTask = Task { [weak self] in
            let no = try? await api.locate(view: info.viewId, event: id)
            guard !Task.isCancelled, let self, self.flowView == info, self.model.selectedEvent == id else { return }
            self.selectedIndex = no.flatMap { $0 }.map { $0 - 1 }
            self.view?.selectionChanged(scrollTo: self.selectedIndex)
        }
    }
}
