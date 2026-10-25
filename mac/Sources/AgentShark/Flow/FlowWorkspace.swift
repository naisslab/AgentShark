import SwiftUI

/// The Flow workspace: a sequence diagram of one session (MAC-SPEC §7). With several sessions selected it says
/// which one it shows and offers a picker; it never picks one silently (SPEC §7.8).
struct FlowWorkspace: View {
    @Bindable var model: WindowModel
    @State private var controller: FlowController?

    var body: some View {
        VStack(spacing: 0) {
            if let controller {
                FlowBar(model: model, controller: controller)
                ZStack {
                    FlowHost(controller: controller)
                    FlowStateOverlay(model: model, controller: controller)
                }
            } else {
                Color.clear
            }
        }
        .onAppear {
            if controller == nil {
                let c = FlowController(model: model)
                controller = c
                c.sync()
            }
        }
    }
}

private struct FlowHost: NSViewRepresentable {
    let controller: FlowController

    func makeNSView(context: Context) -> FlowDiagramView { FlowDiagramView(controller: controller) }
    func updateNSView(_ view: FlowDiagramView, context: Context) {}
}

/// The Flow header (DESIGN.md §7.3): the Session mode switch, the scope label and "Selected turn only".
private struct FlowBar: View {
    @Bindable var model: WindowModel
    @Bindable var controller: FlowController

    var body: some View {
        WorkspaceHeader(model: model, label: label) {
            SessionModeSwitch(model: model)
        } controls: {
            SessionPicker(model: model)
            Toggle("Selected turn only", isOn: $controller.turnOnly)
                .toggleStyle(.checkbox)
                .disabled(model.selectedEvent == nil && !controller.turnOnly)
                .help(model.selectedEvent == nil ? "Select an event to show only its turn" : "Show only the turn that contains the selected event")
        }
    }

    /// "312 events · filter does not apply", or the session of the selected event when no session is scoped.
    private var label: String {
        guard controller.phase == .ready else { return model.sessionScopeLabel(.flow) }
        var parts = [Formatters.count(controller.count, "event")]
        if !model.scope.hasSessions, controller.sessionID != nil { parts.append("session of the selected event") }
        if model.scope.hasTimeRange { parts.append("time range applied") }
        parts.append("filter does not apply")
        return parts.joined(separator: " · ")
    }
}

/// Explicit states over the diagram (SPEC §7.8).
private struct FlowStateOverlay: View {
    @Bindable var model: WindowModel
    let controller: FlowController

    var body: some View {
        switch controller.phase {
        case .ready:
            EmptyView()
        case .noSession:
            ContentUnavailableView("No session selected", systemImage: SessionMode.flow.symbol,
                                   description: Text("Select a session in the sidebar, or select an event, to see its sequence diagram."))
                .background(.background)
        case .waitingForEngine:
            EngineStateView(engine: model.engine).background(.background)
        case .loading:
            LoadingStateView(title: "Loading the flow…").background(.background)
        case .failed(let e):
            FailedStateView(title: "Could not load the flow", error: e) { controller.retry() }
                .background(.background)
        case .empty:
            ContentUnavailableView {
                Label("Nothing to draw", systemImage: SessionMode.flow.symbol)
            } description: {
                Text(emptyReason)
            } actions: {
                if model.scope.hasTimeRange {
                    Button("Clear Time Range") { model.clearTimeScope() }
                }
                if controller.turnOnly {
                    Button("Show the Whole Session") { controller.turnOnly = false }
                }
            }
            .background(.background)
        }
    }

    private var emptyReason: String {
        if controller.turnOnly { return "The selected turn has no prompts, model text or tool calls." }
        if model.scope.hasTimeRange { return "This session has no prompts, model text or tool calls in the time range." }
        return "This session has no prompts, model text or tool calls."
    }
}
