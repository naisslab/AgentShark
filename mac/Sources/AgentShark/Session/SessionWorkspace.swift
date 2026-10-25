import AppKit
import SwiftUI

/// The Session workspace (SPEC §12.7): one session in four modes, or two runs in Compare. Steps is steps-first (Run report
/// strip, turn and step rows); Transcript is the former Conversation workspace and Flow the former Flow workspace;
/// Critical Path (AgentPerf) and Compare (AgentDiff) present the engine's analyses of whole runs. Each mode's workspace
/// header (DESIGN.md §7.3) leads with the mode switch.
struct SessionWorkspace: View {
    @Bindable var model: WindowModel

    var body: some View {
        switch model.sessionMode {
        case .steps: StepsWorkspace(model: model)
        case .transcript:
            VStack(spacing: 0) {
                WorkspaceHeader(model: model, label: model.sessionScopeLabel(.transcript)) {
                    SessionModeSwitch(model: model)
                } controls: {
                    SessionPicker(model: model)
                }
                ConversationWorkspace(model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case .flow: FlowWorkspace(model: model)
        case .criticalPath: CriticalPathWorkspace(model: model)
        case .compare: CompareWorkspace(model: model)
        }
    }
}

/// Steps | Transcript | Flow | Critical Path | Compare, at the left of the Session workspace header (⌥⌘1–⌥⌘5). It never
/// folds: the header folds its controls first (ANALYSIS-UX Decision 4).
struct SessionModeSwitch: View {
    @Bindable var model: WindowModel

    var body: some View {
        SessionModeControl(selection: model.sessionMode) { model.sessionMode = $0 }
    }

    /// "Steps ⌥⌘1 · … · Compare Runs (AgentDiff) ⌥⌘5", from the keys View ▸ Session Mode binds.
    static var help: String {
        SessionMode.allCases.map { "\($0.commandTitle) \(AgentSharkCommands.modeShortcut($0).keys)" }.joined(separator: " · ")
    }
}

/// The mode switch as an `NSSegmentedControl` whose segments fit their titles: a SwiftUI segmented picker gives every
/// segment the width of "Critical Path", 488 pt instead of 374 pt at the regular size. It follows the header's control
/// size.
struct SessionModeControl: NSViewRepresentable {
    let selection: SessionMode
    let select: (SessionMode) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSSegmentedControl {
        Self.makeControl(target: context.coordinator, action: #selector(Coordinator.changed(_:)))
    }

    /// One segment per mode, each as wide as its full title.
    static func makeControl(target: AnyObject?, action: Selector?) -> NSSegmentedControl {
        let control = NSSegmentedControl(labels: SessionMode.allCases.map(\.title), trackingMode: .selectOne, target: target, action: action)
        control.segmentDistribution = .fit
        control.toolTip = SessionModeSwitch.help
        control.setAccessibilityLabel("Session mode")
        return control
    }

    func updateNSView(_ control: NSSegmentedControl, context: Context) {
        context.coordinator.select = select
        // SwiftUI may set the control size itself; the font does not follow it.
        let size = NSControl.ControlSize(context.environment.controlSize)
        let fontSize = NSFont.systemFontSize(for: size)
        if control.controlSize != size || control.font?.pointSize != fontSize {
            control.controlSize = size
            control.font = .systemFont(ofSize: fontSize)
            control.invalidateIntrinsicContentSize()
        }
        let index = SessionMode.allCases.firstIndex(of: selection) ?? 0
        if control.selectedSegment != index { control.selectedSegment = index }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSSegmentedControl, context: Context) -> CGSize? {
        nsView.intrinsicContentSize
    }

    @MainActor final class Coordinator: NSObject {
        var select: (SessionMode) -> Void = { _ in }

        @objc func changed(_ sender: NSSegmentedControl) {
            let modes = SessionMode.allCases
            if modes.indices.contains(sender.selectedSegment) { select(modes[sender.selectedSegment]) }
        }
    }
}

private extension NSControl.ControlSize {
    init(_ size: ControlSize) {
        switch size {
        case .mini: self = .mini
        case .small: self = .small
        case .large, .extraLarge: self = .large
        default: self = .regular
        }
    }
}

/// Which of several scoped sessions the Session workspace shows; nothing when one is scoped. A session reads by its
/// title, or "Untitled · cx:0190a0…0001" (`WindowModel.runLabel`). In a folded header's menu (`inMenu`) it is a Session
/// submenu.
struct SessionPicker: View {
    @Bindable var model: WindowModel
    var inMenu = false

    var body: some View {
        if model.scope.sessions.count > 1 {
            let picker = Picker("Session", selection: Binding(get: { model.focusedSessionID ?? "" }, set: { model.singleSessionChoice = $0 })) {
                ForEach(model.scope.sessions, id: \.self) { Text(model.runLabel(of: $0)).tag($0) }
            }
            if inMenu {
                picker
            } else {
                picker
                    .labelsHidden()
                    .frame(maxWidth: 220)
                    .help(model.singleSessionNote ?? "The Session workspace shows one session at a time")
            }
        }
    }
}

/// The detail column of Steps, Critical Path and Compare (§7.8, ANALYSIS-UX §4.2, §5.12): the mode's main pane, then
/// the selection's detail and raw panes, which ⌥⌘I shows (`SessionMode.hasDerivedInspector`), with the long-text sheet
/// they open. A mode can put its own `inspector` in the pane; it gets the panes' state for the detail it shows. Follow
/// takes the pane where the window gives it the region (Steps, §7.9) and docks under the workspace elsewhere.
struct AnalysisPanes<Main: View, Inspector: View>: View {
    @Bindable var model: WindowModel
    /// Where the divider position is saved; each mode keeps its own.
    let autosaveName: String
    let mainMinimum: CGFloat
    let accessibilityLabel: String
    let main: Main
    let inspector: (EventsPaneState) -> Inspector
    @State private var pane = EventsPaneState()

    init(model: WindowModel, autosaveName: String, mainMinimum: CGFloat = 420, accessibilityLabel: String, @ViewBuilder main: () -> Main,
         @ViewBuilder inspector: @escaping (EventsPaneState) -> Inspector) {
        self.model = model
        self.autosaveName = autosaveName
        self.mainMinimum = mainMinimum
        self.accessibilityLabel = accessibilityLabel
        self.main = main()
        self.inspector = inspector
    }

    private var followInRegion: Bool { model.followHasRegion && model.followTarget != nil }

    var body: some View {
        AutosaveSplitView(autosaveName: autosaveName, vertical: true, panes: [
            SplitPane(id: "main", minimum: mainMinimum, accessibilityLabel: accessibilityLabel) { main },
            SplitPane(id: "inspect", minimum: 360, initial: 400, holdingPriority: .init(255), isCollapsed: !model.showDerivedInspector && !followInRegion,
                      accessibilityLabel: followInRegion ? "Follow" : "Event detail and raw source") {
                if followInRegion { FollowPanel(model: model, inRegion: true) } else { inspector(pane) }
            },
        ])
        .sheet(item: $pane.longText) { item in LongTextSheet(item: item, api: model.engine.api) }
    }
}

extension AnalysisPanes where Inspector == DerivedInspector {
    /// The selected event's detail and raw panes.
    init(model: WindowModel, autosaveName: String, mainMinimum: CGFloat = 420, accessibilityLabel: String, @ViewBuilder main: () -> Main) {
        self.init(model: model, autosaveName: autosaveName, mainMinimum: mainMinimum, accessibilityLabel: accessibilityLabel, main: main,
                  inspector: { DerivedInspector(model: model, pane: $0) })
    }
}

/// What Critical Path and Compare show in place of their analysis until it is built into the app; the research tools in
/// the browser have both.
struct AnalysisPlaceholder: View {
    let model: WindowModel
    let mode: SessionMode

    var body: some View {
        ContentUnavailableView {
            Label("\(mode.title) is not available in this build", systemImage: mode.symbol)
        } description: {
            Text("The research tools in the browser include it.")
        } actions: {
            Button("Open Research Tools in Browser") { ResearchTools.open(engine: model.engine) }
                .disabled(model.engine.endpoint == nil)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Session · Steps (§7.8): the workspace header, the Run report strip, the data-gap line, the steps outline and (⌥⌘I)
/// the detail and raw panes.
struct StepsWorkspace: View {
    @Bindable var model: WindowModel

    private var steps: StepsModel { model.steps }

    var body: some View {
        VStack(spacing: 0) {
            header
            if model.focusedSessionID == nil {
                ContentUnavailableView("No session selected", systemImage: SessionMode.steps.symbol,
                                       description: Text("Select a session in the sidebar to see its turns and steps."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                if let r = steps.report {
                    RunReportStrip(model: model, report: r) { b in steps.bucket = b }
                    Divider()
                } else if let e = steps.reportError, !e.isNotServed {
                    Text("The run report is unavailable: \(e.message)").font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal, 12).padding(.vertical, 4)
                    Divider()
                }
                if !steps.gaps.isEmpty { GapBanner(gaps: steps.gaps) }
                // Follow takes the inspector region, which opens for it (§7.9).
                AnalysisPanes(model: model, autosaveName: "AgentShark.StepsPanes", accessibilityLabel: "Steps") {
                    ZStack {
                        StepsOutline(model: model).opacity(steps.steps.isEmpty && steps.turns.isEmpty ? 0 : 1)
                        overlay
                    }
                }
            }
        }
        .task(id: syncKey) { steps.sync() }
    }

    private var syncKey: String {
        [model.focusedSessionID ?? "", model.view?.viewId ?? "-", model.appliedFilter, "\(model.scope.from ?? 0)|\(model.scope.to ?? 0)",
         model.engine.api?.endpoint.baseURL.absoluteString ?? "", "\(model.derived.availability)"].joined(separator: "|")
    }

    /// Mode switch and "79 steps · filter highlights 14"; inline "Only turns with failures", Descendants and Inspector;
    /// Sort, Fold clean turns and Columns in Options (§7.3).
    private var header: some View {
        WorkspaceHeader(model: model, label: model.sessionScopeLabel(.steps)) {
            SessionModeSwitch(model: model)
        } controls: {
            headerControls
        } folded: {
            foldedControls
        }
    }

    /// The header's inline controls, and `foldedControls` when they do not fit; `LayoutFitTests` measures both.
    @ViewBuilder var headerControls: some View {
        SessionPicker(model: model)
        if let b = steps.bucket {
            ScopeToken(kind: "Time", value: TimeLegend.name(b), applies: true, help: "Only steps with \(TimeLegend.name(b)) time",
                       clearHelp: "Show every step") { steps.bucket = nil }
        }
        if steps.isRefreshing { ProgressView().controlSize(.mini) }
        if steps.next != nil {
            Button(steps.isLoadingMore ? "Loading…" : "Load More") { steps.loadMore() }.disabled(steps.isLoadingMore)
        }
        Toggle("Only turns with failures", isOn: Binding(get: { steps.onlyFailed }, set: { steps.onlyFailed = $0 })).toggleStyle(.checkbox)
        Toggle("Descendants", isOn: Binding(get: { steps.descendants }, set: { steps.descendants = $0 })).toggleStyle(.checkbox)
            .help("Include the steps of this session's subagents")
        Toggle("Inspector", isOn: $model.showDerivedInspector).toggleStyle(.checkbox)
            .help("The selected step's event detail and raw source (⌥⌘I)")
        optionsMenu
        if !steps.autoHiddenColumns.isEmpty {
            Menu(ColumnFit.hiddenText(steps.autoHiddenColumns.count)) { columnItems }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .foregroundStyle(.secondary)
                .help("Columns that do not fit this width: " + hiddenTitles + ". Widen the window or hide the inspector to show them.")
        }
    }

    @ViewBuilder var foldedControls: some View {
        Toggle("Only turns with failures", isOn: Binding(get: { steps.onlyFailed }, set: { steps.onlyFailed = $0 })).toggleStyle(.checkbox)
        optionsMenu
    }

    private var hiddenTitles: String {
        steps.autoHiddenColumns.compactMap { id in StepsOutlineController.columns.first { $0.spec.id == id }?.title }.joined(separator: ", ")
    }

    private var optionsMenu: some View {
        Menu("Options") {
            Picker("Sort", selection: Binding(get: { steps.sort }, set: { steps.sort = $0 })) {
                Text("Sequence (Turns)").tag("seq")
                Text("Active Time (Model + Tools)").tag("active")
                Text("Gap").tag("gap")
                Text("Wall Time (Active + Gap)").tag("dur")
                Text("Tokens In").tag("tokIn")
                Text("Tokens Out").tag("tokOut")
                Text("Context").tag("ctx")
            }
            .pickerStyle(.inline)
            if steps.isFlat {
                Toggle("Ascending", isOn: Binding(get: { steps.ascending }, set: { steps.ascending = $0 }))
            }
            Divider()
            Toggle("Fold Clean Turns", isOn: Binding(get: { steps.foldClean }, set: { steps.foldClean = $0 }))
            Toggle("Descendants", isOn: Binding(get: { steps.descendants }, set: { steps.descendants = $0 }))
            Toggle("Inspector", isOn: $model.showDerivedInspector)
            Divider()
            Menu("Columns") { columnItems }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Sorting by time, tokens or context flattens the turns into one step list with a Turn column.")
    }

    /// One item per column the person can hide; a column that does not fit says so.
    @ViewBuilder private var columnItems: some View {
        ForEach(StepsOutlineController.optionalColumns, id: \.id) { c in
            Toggle(c.title + (steps.autoHiddenColumns.contains(c.id) ? " (does not fit)" : ""), isOn: Binding(
                get: { !steps.userHiddenColumns.contains(c.id) },
                set: { on in if on { steps.userHiddenColumns.remove(c.id) } else { steps.userHiddenColumns.insert(c.id) } }))
        }
    }

    @ViewBuilder private var overlay: some View {
        switch steps.phase {
        case .idle where model.engine.api == nil:
            EngineStateView(engine: model.engine).background(.background)
        case .idle, .loading:
            if steps.steps.isEmpty { LoadingStateView(title: "Reading steps…").background(.background) }
        case .failed(let e):
            FailedStateView(title: e.status == 404 ? "Session not found" : "Could not load steps",
                            message: e.status == 404 ? "The session is not in this index." : "Your selection is preserved.", error: e) { steps.retry() }
                .background(.background)
        case .unavailable:
            ContentUnavailableView {
                Label("Steps need a newer engine", systemImage: SessionMode.steps.symbol)
            } description: {
                Text("This engine predates the step analysis (index schema 4). The Transcript and Flow modes still work.")
            } actions: {
                Button("Show Transcript") { model.sessionMode = .transcript }
            }
            .background(.background)
        case .ready:
            if steps.steps.isEmpty && steps.turns.isEmpty {
                ContentUnavailableView("No steps", systemImage: SessionMode.steps.symbol,
                                       description: Text(steps.onlyFailed || steps.bucket != nil ? "No step matches these options." : "This session has no model responses."))
                    .background(.background)
            }
        }
    }
}
