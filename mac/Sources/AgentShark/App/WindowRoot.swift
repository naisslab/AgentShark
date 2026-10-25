import SwiftUI

/// Per-window options saved with the window (scene storage), beside its navigation state.
struct WindowOptions: Codable, Hashable {
    var timeFormat: TimeFormat
    var showTimelineTrack: Bool
    var showInspector: Bool
    var columnPreset: ColumnPreset
    var customColumns: [String]
    var sortKey: String
    var sortAscending: Bool
    var showInherited: Bool
    var showDup: Bool
    /// Agent-native options (absent from earlier builds).
    var failureFacets: FailureFacets?
    var showDerivedInspector: Bool?

    @MainActor init(_ m: WindowModel) {
        timeFormat = m.timeFormat
        showTimelineTrack = m.showTimelineTrack
        showInspector = m.showInspector
        columnPreset = m.columnPreset
        customColumns = m.customColumns
        sortKey = m.sort.key
        sortAscending = m.sort.ascending
        showInherited = m.showInherited
        showDup = m.showDup
        failureFacets = m.failureFacets
        showDerivedInspector = m.showDerivedInspector
    }

    @MainActor func apply(to m: WindowModel) {
        m.timeFormat = timeFormat
        m.showTimelineTrack = showTimelineTrack
        m.showInspector = showInspector
        m.columnPreset = columnPreset
        m.customColumns = customColumns
        m.sort = (sortKey, sortAscending)
        m.showInherited = showInherited
        m.showDup = showDup
        if let failureFacets { m.failureFacets = failureFacets }
        if let showDerivedInspector { m.showDerivedInspector = showDerivedInspector }
    }
}

/// Reports the hosting `NSWindow` once the view is in a window.
struct HostWindowReader: NSViewRepresentable {
    let onWindow: (NSWindow?) -> Void

    final class Probe: NSView {
        var onWindow: ((NSWindow?) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            onWindow?(window)
        }
    }

    func makeNSView(context: Context) -> Probe {
        let p = Probe()
        p.onWindow = onWindow
        return p
    }

    func updateNSView(_ nsView: Probe, context: Context) {
        nsView.onWindow = onWindow
        if nsView.window != nil { onWindow(nsView.window) }
    }
}

/// Creates the window's `WindowModel`, restores and saves its state, publishes it to the menus, and hosts
/// `MainWindow`.
struct WindowRoot: View {
    let target: WindowTarget
    @State private var model: WindowModel?
    @SceneStorage("AgentShark.navState") private var savedNav: Data?
    @SceneStorage("AgentShark.windowOptions") private var savedOptions: Data?
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Group {
            if let model {
                MainWindow(model: model)
                    .focusedSceneValue(\.windowModel, model)
                    .navigationTitle(model.windowTitle)
                    .onChange(of: model.navState) { _, state in
                        savedNav = try? JSONEncoder().encode(state)
                    }
                    .onChange(of: WindowOptions(model)) { _, options in
                        savedOptions = try? JSONEncoder().encode(options)
                    }
            } else {
                Color.clear
            }
        }
        .frame(minWidth: 900, minHeight: 560)
        .background(WindowCloseObserver { [target] in AppModel.shared.releaseWindow(target) })
        .background(HostWindowReader { window in model?.hostWindow = window })
        .onAppear(perform: setUp)
    }

    private func setUp() {
        let app = AppModel.shared
        app.openWindowHandler = { [openWindow] target in openWindow(value: target) }
        app.openSettingsHandler = { [openSettings] in openSettings() }
        for pending in app.takePendingTargets() { openWindow(value: pending) }
        guard model == nil else { return }
        app.retainWindow(target)
        let m = app.makeWindowModel(for: target)
        if let data = savedOptions, let options = try? JSONDecoder().decode(WindowOptions.self, from: data) {
            options.apply(to: m)
        }
        if let data = savedNav, let nav = try? JSONDecoder().decode(NavState.self, from: data) {
            m.restoreScene(nav)
        }
        model = m
    }
}
