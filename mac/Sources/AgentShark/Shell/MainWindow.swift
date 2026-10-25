import AppKit
import SwiftUI

/// The main window (MAC-SPEC §3): source list | scope bar, workspace and status bar, with an optional session
/// inspector and a unified toolbar.
///
/// The inspector is a trailing pane of the detail column rather than SwiftUI's `.inspector` column: with the
/// AppKit-hosted Events workspace inside, that third split column re-entered constraint passes while the
/// window narrowed until AppKit stopped the app ("more Update Constraints in Window passes than there are
/// views"). The pane keeps the same toggle (⌥⌘I), a draggable edge and a saved width.
struct MainWindow: View {
    @Bindable var model: WindowModel
    @AppStorage("AgentShark.inspectorWidth") private var inspectorWidth = 300.0
    @State private var detailWidth: CGFloat = 1200
    @State private var columns: NavigationSplitViewVisibility = .all

    /// The sidebar and detail minimums add up to less than the window's minimum width (900); the Events
    /// workspace's detail and raw panes need 471 pt side by side.
    static let detailMinWidth: CGFloat = 480
    static let sidebarCollapseWidth: CGFloat = 1180

    /// The inspector is 220–440 pt wide and leaves the workspace at least `detailMinWidth`.
    static func inspectorRange(available: CGFloat) -> ClosedRange<Double> {
        let upper = max(220, min(440, Double(available - detailMinWidth)))
        return 220...upper
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            SidebarView(model: model)
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } detail: {
            // Each part has a zero minimum, so the column's minimum is the constant below and never depends on
            // what the bars or workspaces show. A minimum that changes with the content sends the window's
            // column layout into a loop of constraint passes.
            GeometryReader { geo in
                HStack(spacing: 0) {
                    VStack(spacing: 0) {
                        ScopeBar(model: model)
                            .frame(minWidth: 0, maxWidth: .infinity)
                            .clipped()
                        content
                            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
                            .clipped()
                        // Follow (⌥⌘F) takes over a region of Failures, Events and Session · Steps (DESIGN.md §7.9); the
                        // other workspaces have no such region, so it docks under them. Escape closes it.
                        if model.followTarget != nil, !model.followHasRegion {
                            Divider()
                            FollowPanel(model: model)
                                .frame(minWidth: 0, maxWidth: .infinity)
                                .frame(height: min(300, max(180, geo.size.height * 0.32)))
                        }
                        StatusBar(model: model)
                            .frame(minWidth: 0, maxWidth: .infinity)
                            .clipped()
                            // A second sheet on its own view: edit chips and closes show their diff.
                            .sheet(item: $model.diffRequest) { DiffSheet(model: model, request: $0) }
                    }
                    if model.showInspector {
                        PaneEdge(width: $inspectorWidth, range: Self.inspectorRange(available: geo.size.width))
                        InspectorPanel(model: model)
                            .frame(width: Self.inspectorRange(available: geo.size.width).clamp(inspectorWidth))
                            .frame(maxHeight: .infinity)
                            .background(Color(nsColor: .windowBackgroundColor))
                    }
                }
            }
            .frame(minWidth: Self.detailMinWidth)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { detailWidth = $0 }
        }
        .toolbar { MainToolbar(model: model, detailWidth: detailWidth) }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            // Below 1,180 pt (the sidebar, queue and Lens minimums) the sidebar collapses; it returns above (§8.6).
            if width < Self.sidebarCollapseWidth, model.windowWidth >= Self.sidebarCollapseWidth { columns = .detailOnly }
            if width >= Self.sidebarCollapseWidth, model.windowWidth < Self.sidebarCollapseWidth { columns = .all }
            if abs(model.windowWidth - width) > 1 { model.windowWidth = width }
        }
        .sheet(item: $model.presentedSheet) { sheet($0) }
        .onAppear {
            if let state = PendingWindowState.take(), model.history.entries.count <= 1, model.scope.isEmpty {
                model.restoreScene(state)
            }
        }
        .onChange(of: model.scope.sessions) { _, ids in
            if ids.count == 1 { SidebarLists.shared.noteOpened(ids[0]) }
        }
    }

    @ViewBuilder private var content: some View {
        if let gate = OnboardingGate.gate(for: model) {
            OnboardingView(model: model, gate: gate)
        } else {
            switch model.workspace {
            case .failures: FailuresWorkspace(model: model)
            case .events: EventsWorkspace(model: model)
            case .session: SessionWorkspace(model: model)
            case .timeline: TimelineWorkspace(model: model)
            case .stats: StatsWorkspace(model: model)
            case .diagnostics: DiagnosticsWorkspace(model: model)
            case .sources: SourcesWorkspace(model: model)
            }
        }
    }

    @ViewBuilder private func sheet(_ kind: SheetKind) -> some View {
        switch kind {
        case .goToEvent: GoToEventSheet(model: model)
        case .saveFilter: SaveFilterSheet(model: model)
        case .exportCapture: ExportCaptureSheet(model: model)
        case .keyboardShortcuts: KeyboardShortcutsSheet()
        case .filterSyntax: FilterSyntaxSheet()
        case .gettingStarted:
            GettingStartedSheet(showFilterReference: { model.presentedSheet = .filterSyntax },
                                showKeyboardShortcuts: { model.presentedSheet = .keyboardShortcuts })
        case .reportPreview:
            if let id = model.reportEpisodeID {
                ReportPreviewSheet(model: model, episodeID: id)
            }
        case .splitSignature:
            if let id = model.subjectSignatureID { SignatureSplitSheet(model: model, signatureID: id) }
        }
    }
}

extension ClosedRange where Bound == Double {
    func clamp(_ value: Double) -> Double { Swift.min(upperBound, Swift.max(lowerBound, value)) }
}

/// The inspector's leading edge: a hairline you can drag to resize the pane.
struct PaneEdge: View {
    @Binding var width: Double
    let range: ClosedRange<Double>
    @State private var start: Double?

    var body: some View {
        Rectangle()
            .fill(Color(nsColor: .separatorColor))
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .overlay {
                Color.clear
                    .frame(width: 8)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                        .onChanged { g in
                            let base = start ?? width
                            start = base
                            width = range.clamp(base - g.translation.width)
                        }
                        .onEnded { _ in start = nil })
            }
            .accessibilityHidden(true)
    }
}
