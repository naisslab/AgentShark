import SwiftUI

/// The Timeline workspace (MAC-SPEC §6): a scope bar with zoom controls, the timeline, and a footer that describes
/// the selection or the inspection range and explains the colors.
struct TimelineWorkspace: View {
    @Bindable var model: WindowModel
    @State private var controller: TimelineController?

    var body: some View {
        VStack(spacing: 0) {
            if let controller {
                TimelineBar(model: model, controller: controller)
                ZStack {
                    TimelineHost(controller: controller)
                        .accessibilityLabel("Timeline")
                    TimelineStateOverlay(model: model, controller: controller)
                }
                Divider()
                TimelineFooter(model: model, controller: controller)
            } else {
                Color.clear
            }
        }
        .onAppear {
            if controller == nil {
                let c = TimelineController(model: model)
                controller = c
                c.sync()
            }
        }
    }
}

/// Wraps `TimelineView`; the AppKit view keeps its scroll position and zoom across SwiftUI updates.
private struct TimelineHost: NSViewRepresentable {
    let controller: TimelineController

    func makeNSView(context: Context) -> TimelineView { TimelineView(controller: controller) }
    func updateNSView(_ view: TimelineView, context: Context) {}
}

// MARK: - Bar

/// The Timeline header (DESIGN.md §7.3): "4 sessions · 212 spans · 9 failure bands" and what of the scope applies;
/// Zoom (− and + as one segmented control) and Fit inline; Collapse Idle Gaps and the Context lane in Options.
private struct TimelineBar: View {
    @Bindable var model: WindowModel
    let controller: TimelineController

    private var label: String {
        var parts = [controller.phase == .ready ? controller.statusText : (model.scope.sessions.isEmpty ? "All sessions" : "Spans")]
        if model.scope.hasTimeRange { parts.append("time range applied") }
        if !model.appliedFilter.isEmpty { parts.append("filter shown as density") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        WorkspaceHeader(model: model, label: label) {
            if controller.isRefreshing && controller.phase == .ready {
                ProgressView().controlSize(.mini).help("Updating the timeline…")
            }
            if let e = controller.refreshError {
                Button("Retry") { controller.retry() }.help("Refreshing failed: \(e.message)")
            }
            ControlGroup {
                Button { controller.zoomOut() } label: { Image(systemName: "minus") }
                    .keyboardShortcut("-", modifiers: .command)
                    .iconHelp("Zoom Out (⌘−)")
                Button { controller.zoomIn() } label: { Image(systemName: "plus") }
                    .keyboardShortcut("=", modifiers: .command)
                    .iconHelp("Zoom In (⌘+)")
            }
            .fixedSize()
            .disabled(controller.phase != .ready)
            Button("Fit") { controller.zoomToFit() }
                .keyboardShortcut("0", modifiers: .command)
                .disabled(controller.phase != .ready)
                .help(model.scope.hasTimeRange ? "Zoom to the time range (⌘0)" : "Zoom to fit (⌘0)")
            Menu("Options") {
                Toggle("Collapse Idle Gaps", isOn: Binding(get: { model.app.preferences.collapseIdleGaps },
                                                           set: { model.app.preferences.collapseIdleGaps = $0 }))
                Toggle("Context Lane", isOn: Binding(get: { model.app.preferences.showContextLane },
                                                     set: { model.app.preferences.showContextLane = $0 }))
                    .disabled(controller.mode != .sessions)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Collapse idle stretches longer than \(model.app.preferences.idleGapMinutes) minutes; show each session's context against its window")
        }
        .help(controller.lodMinDur != nil ? "This session has more spans than fit at once; shorter spans appear as you zoom in." : "")
    }
}

// MARK: - States

/// Loading, failed and empty states over the timeline (SPEC §7.8): never other data in their place.
private struct TimelineStateOverlay: View {
    @Bindable var model: WindowModel
    let controller: TimelineController
    @State private var retriedFor: [String]?

    var body: some View {
        if model.engine.api == nil && !controller.hasData {
            EngineStateView(engine: model.engine).background(.background)
        } else {
            switch controller.phase {
            case .idle, .loading:
                LoadingStateView(title: model.scope.hasSessions ? "Loading spans…" : "Loading sessions…")
                    .background(.background)
            case .failed(let e):
                FailedStateView(title: "Could not load the timeline", error: e) { controller.retry() }
                    .background(.background)
            case .ready:
                if controller.trackCount == 0 {
                    emptyState.background(.background)
                } else if controller.mode == .sessions && controller.spanCount == 0 {
                    ContentUnavailableView("No spans", systemImage: "chart.bar.xaxis",
                                           description: Text("These sessions have no turns, model calls or tool calls."))
                        .allowsHitTesting(false)
                }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if controller.mode == .overview {
            ContentUnavailableView {
                Label("No sessions indexed", systemImage: "chart.bar.xaxis")
            } description: {
                Text(model.isCapture ? "This capture contains no indexed sessions." : "No supported logs found in the locations checked.")
            } actions: {
                Button(model.isCapture ? "Capture Details" : "Open Sources") { model.workspace = .sources }
            }
        } else if model.scope.sessions.contains(where: { model.sessionsByID[$0] != nil }) || model.store.sessionsPhase != .ready {
            // The catalog has these sessions: an empty layout is a load that has not landed, never "not found". Load once
            // more; if it is still empty, say so with Retry.
            if retriedFor == model.scope.sessions {
                FailedStateView(title: "No tracks to draw", message: "The engine returned no session tree for this scope.", error: nil) { controller.retry() }
            } else {
                LoadingStateView(title: "Loading spans…")
                    .task(id: model.scope.sessions) {
                        retriedFor = model.scope.sessions
                        controller.retry()
                    }
            }
        } else {
            ContentUnavailableView {
                Label("Session not found", systemImage: "questionmark.folder")
            } description: {
                Text(model.scope.sessions.count == 1 ? "The selected session is not in this index." : "None of the selected sessions is in this index.")
            } actions: {
                Button("Show All Sessions") { model.clearSessionScope() }
            }
        }
    }
}

// MARK: - Footer

private struct TimelineFooter: View {
    @Bindable var model: WindowModel
    let controller: TimelineController

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 12) {
                if let r = model.inspectionRange {
                    rangeSummary(r)
                } else if let focus = controller.focus {
                    focusSummary(focus)
                } else {
                    Text(controller.mode == .overview ? "Double-click a session to open it. Drag to set an inspection range."
                         : "Click a span to select its first event. Drag to set an inspection range.")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .frame(height: 22)
            ViewThatFits(in: .horizontal) {
                TimelineLegend(mode: controller.mode, kinds: 12)
                TimelineLegend(mode: controller.mode, kinds: 7)
                TimelineLegend(mode: controller.mode, kinds: 4)
                TimelineLegend(mode: controller.mode, kinds: 0)
            }
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }

    private func rangeSummary(_ r: ClosedRange<Int64>) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.left.and.right").foregroundStyle(.tint)
            Text("Inspection Range").fontWeight(.medium)
            Text(Formatters.timeRange(from: r.lowerBound, to: r.upperBound) + " · " + Formatters.duration(r.upperBound - r.lowerBound))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Button("Filter to Range") { controller.filterToRange() }
                .controlSize(.small)
                .help("Set the time range of the investigation scope to this range (⌘R)")
            Button { controller.clearInspectionRange() } label: { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .iconHelp("Clear Inspection Range")
        }
    }

    @ViewBuilder private func focusSummary(_ focus: TimelineController.Focus) -> some View {
        switch focus {
        case .span(let sp):
            HStack(spacing: 8) {
                Image(systemName: Symbols.spanKind(sp.kind))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(TimelineLayout.paint(for: sp).color.swiftUI)
                    .accessibilityHidden(true)
                Text(TimelineText.spanKind(sp)).foregroundStyle(.secondary)
                Text(sp.name.isEmpty ? sp.kind.rawValue : sp.name).fontWeight(.medium).lineLimit(1).truncationMode(.tail)
                Text(TimelineText.duration(sp))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .help(Formatters.provenance(sp.durSrc))
                if sp.status != .ok {
                    Label(TimelineText.status(sp.status), systemImage: sp.status == .error ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.spanStatusColor(sp.status).swiftUI)
                        .labelStyle(.titleAndIcon)
                }
                Button("Show in Events") { controller.showInEvents() }
                    .controlSize(.small)
                    .disabled(sp.firstEvent == nil)
                    .help("Select this span's first event in the Events workspace (Return)")
            }
        case .session(let s):
            HStack(spacing: 8) {
                Image(systemName: Symbols.agent(s.agent))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Theme.agentColor(s.agent).swiftUI)
                    .accessibilityHidden(true)
                Text(s.title ?? TimelineText.shortID(s.id)).fontWeight(.medium).lineLimit(1)
                if let start = s.start {
                    Text(Formatters.duration((s.end ?? start) - start, src: "derived")).monospacedDigit().foregroundStyle(.secondary)
                }
                Button("Open Session") { model.openSession(s.id, workspace: .timeline) }
                    .controlSize(.small)
                    .help("Show this session's turns, model calls and tool calls")
            }
        case .process(let p):
            HStack(spacing: 8) {
                Image(systemName: "terminal").foregroundStyle(Theme.color(.toolShell).swiftUI).accessibilityHidden(true)
                Text("Process").foregroundStyle(.secondary)
                Text(p.program ?? p.procKey).fontWeight(.medium).lineLimit(1).truncationMode(.middle)
                Text(p.status + (p.exitCode.map { " · exit \($0)" } ?? "")).foregroundStyle((p.exitCode ?? 0) != 0 ? Theme.err.swiftUI : .secondary)
                if let end = p.endTs { Text(Formatters.duration(end - p.startTs, src: "derived")).monospacedDigit().foregroundStyle(.secondary) }
                Button("Follow") { controller.activateFocus() }
                    .controlSize(.small)
                    .help("Show the command, its polls and its output (Return)")
            }
        case .delegation(let d):
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(Theme.color(.agent).swiftUI).accessibilityHidden(true)
                Text("Delegation").foregroundStyle(.secondary)
                Text(d.childTitle ?? d.taskExcerpt ?? d.kind).fontWeight(.medium).lineLimit(1)
                Text(d.outcome.rawValue + (d.silent ? " · silent" : "")).foregroundStyle(d.outcome.isFailure || d.silent ? Theme.err.swiftUI : .secondary)
                Button("Follow") { controller.activateFocus() }
                    .controlSize(.small)
                    .help("Show the task, the child's steps and the result the parent saw (Return)")
                if let child = d.childSession {
                    Button("Open Child") { model.openSession(child, workspace: .timeline) }.controlSize(.small)
                }
            }
        }
    }
}

/// What the colors mean: the first `kinds` span kinds (sessions) or the agents (overview); in sessions also errors,
/// failure bands and bars with no end logged.
private struct TimelineLegend: View {
    let mode: TimelineController.Mode
    let kinds: Int

    private var entries: [(String, NSColor)] {
        if mode == .overview { return AgentKind.known.map { ($0.label, Theme.agentColor($0)) } }
        let all: [(String, NSColor)] = [
            ("Turn", Theme.color(.user)), ("Model", Theme.color(.llm)), ("Shell", Theme.color(.toolShell)), ("File", Theme.color(.toolFile)),
            ("Web", Theme.color(.toolWeb)), ("MCP", Theme.color(.toolMcp)), ("Agent", Theme.color(.agent)), ("Other tool", Theme.color(.toolOther)),
            ("Compaction", Theme.color(.compaction)), ("Hook", Theme.color(.hook)), ("Retry", Theme.warn), ("Permission", Theme.note),
        ]
        return Array(all.prefix(kinds))
    }

    var body: some View {
        HStack(spacing: 10) {
            ForEach(entries, id: \.0) { name, color in
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 2).fill(color.swiftUI).frame(width: 9, height: 9)
                    Text(name)
                }
            }
            if mode == .sessions {
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 2).strokeBorder(Theme.err.swiftUI, lineWidth: 1.5).frame(width: 9, height: 9)
                    Text("Error")
                }
                HStack(spacing: 4) {
                    ZStack {
                        Rectangle().fill(Theme.err.swiftUI.opacity(0.3))
                        Hatch().fill(Theme.err.swiftUI.opacity(0.8))
                    }
                    .frame(width: 14, height: 5)
                    .clipped()
                    Text("Hatched: unrecovered")
                }
                .help("A failure episode that did not recover, from its first attempt to its last; the mark after it is its outcome")
                HStack(spacing: 4) {
                    Rectangle().fill(Theme.warn.swiftUI.opacity(0.55)).frame(width: 14, height: 5)
                    Text("Amber: recovered after ≥3 attempts")
                }
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 1)
                        .strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                        .frame(width: 14, height: 9)
                    Text("Dashed end: no end logged")
                }
                .help("A process or delegation whose end was never logged is a short stub with a dashed end; a running one reaches the session's end with a cap")
            }
        }
        .font(Theme.fontSwiftUI(.metadata))
        .foregroundStyle(.secondary)
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Legend")
    }
}
