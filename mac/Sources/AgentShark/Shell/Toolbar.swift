import AppKit
import SwiftUI

/// The unified toolbar (DESIGN.md §7.1, §8.5): sidebar toggle | back and forward | the workspace picker in full words |
/// flexible space | the status item | the inspector toggle. The display filter lives in the scope bar.
struct MainToolbar: ToolbarContent {
    @Bindable var model: WindowModel
    /// Width of the window's detail column: under pressure the status item shrinks to its dot (§8.6), so no item
    /// ever goes behind the overflow chevron.
    var detailWidth: CGFloat = 1200

    private var fit: ToolbarFit {
        ToolbarFit(detailWidth: detailWidth, order: model.app.preferences.workspaceOrder, status: model.store.statusTitle)
    }

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            ControlGroup {
                Button { model.goBack() } label: { Label("Back", systemImage: "chevron.left") }
                    .disabled(!model.history.canGoBack)
                    .help("Back (⌘[)")
                Button { model.goForward() } label: { Label("Forward", systemImage: "chevron.right") }
                    .disabled(!model.history.canGoForward)
                    .help("Forward (⌘])")
            }
            .controlGroupStyle(.navigation)
            WorkspacePicker(selection: model.workspace, order: model.app.preferences.workspaceOrder) { model.workspace = $0 }
        }
        // The flexible space between the picker and the status item (§7.1): an empty principal item that takes the room
        // the toolbar has, so the status item and the inspector toggle sit at the trailing edge.
        if #available(macOS 26.0, *) {
            ToolbarItem(placement: .principal) { FlexibleToolbarSpace() }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .principal) { FlexibleToolbarSpace() }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            LiveStatusButton(model: model, showsText: fit.showsStatusText)
            Button {
                model.inspectorShown.toggle()
            } label: {
                Label("Inspector", systemImage: "sidebar.trailing")
            }
            .help(model.inspectorShown ? "Hide Inspector (⌥⌘I)" : "Show Inspector (⌥⌘I)")
        }
    }
}

/// An empty principal item that takes the toolbar's free width.
struct FlexibleToolbarSpace: View {
    var body: some View {
        Color.clear.frame(minWidth: 0, maxWidth: .infinity, maxHeight: 1).accessibilityHidden(true)
    }
}

/// The status item (§7.1): a colored dot and a word for what the data is doing ("Watching", "Indexing 3/7",
/// "Connected · manual refresh"), with a popover of progress, index facts and the engine log. Under toolbar
/// pressure it is the dot alone, with the words in its tooltip and popover.
struct LiveStatusButton: View {
    @Bindable var model: WindowModel
    var showsText = true
    @State private var showsPopover = false

    var body: some View {
        Button {
            showsPopover.toggle()
        } label: {
            HStack(spacing: 6) {
                indicator
                if showsText {
                    Text(model.store.statusTitle)
                        .font(.callout)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .padding(.horizontal, 4)
        }
        .help(model.store.statusDetail.isEmpty ? model.store.statusTitle : model.store.statusTitle + "\n" + model.store.statusDetail)
        .accessibilityLabel("Status: \(model.store.statusTitle)\(model.store.lastIndexFailed ? ", last index run failed" : "")")
        .popover(isPresented: $showsPopover, arrowEdge: .bottom) {
            LiveStatusPopover(model: model) { showsPopover = false }
        }
    }

    @ViewBuilder private var indicator: some View {
        switch model.store.liveStatus {
        case .engineStarting, .indexing:
            ProgressView().controlSize(.mini)
        case .watching where model.store.lastIndexFailed, .manualRefresh where model.store.lastIndexFailed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.warn.swiftUI)
                .imageScale(.small)
        case .watching:
            Circle().fill(Theme.ok.swiftUI).frame(width: 8, height: 8)
        case .following:
            Circle().strokeBorder(Theme.ok.swiftUI, lineWidth: 1.5).frame(width: 8, height: 8)
        case .manualRefresh:
            Circle().strokeBorder(.secondary, lineWidth: 1.5).frame(width: 8, height: 8)
        case .capture(_, let complete):
            Image(systemName: complete == false ? "doc.badge.ellipsis" : "doc.zipper")
                .foregroundStyle(complete == false ? Theme.warn.swiftUI : Color.secondary)
        case .disconnected:
            Circle().fill(Theme.warn.swiftUI).frame(width: 8, height: 8)
        case .engineStopped:
            Circle().fill(Theme.err.swiftUI).frame(width: 8, height: 8)
        }
    }
}

struct LiveStatusPopover: View {
    @Bindable var model: WindowModel
    let close: () -> Void

    private var store: EngineStore { model.store }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(store.statusTitle).font(.headline)
                if !store.statusDetail.isEmpty {
                    Text(store.statusDetail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let i = store.indexing {
                VStack(alignment: .leading, spacing: 4) {
                    ProgressView(value: Double(i.done), total: Double(max(1, i.total)))
                    Text("\(Formatters.count(i.done)) of \(Formatters.count(i.total)) files")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    if let path = i.path {
                        Text(path).font(.caption.monospaced()).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            if !agentCounts.isEmpty {
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 3) {
                    ForEach(agentCounts, id: \.agent) { row in
                        GridRow {
                            Label(row.agent.label, systemImage: Symbols.agent(row.agent))
                                .symbolRenderingMode(.hierarchical)
                            Text(Formatters.count(row.sessions, "session")).monospacedDigit().foregroundStyle(.secondary)
                                .gridColumnAlignment(.trailing)
                        }
                    }
                }
                .font(.callout)
            }
            if let info = store.info {
                Text("\(Formatters.count(info.counts.sources, "source")) · \(Formatters.count(info.counts.sessions, "session")) · \(Formatters.count(info.counts.events, "event"))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                if let coverage = captureCoverage { Text(coverage).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            engineLog
            HStack {
                if !model.isCapture {
                    Button("Reindex Now") { store.reindex() }
                        .disabled(model.engine.api == nil || store.indexing != nil || store.isFollowing)
                        .help(store.isFollowing ? "The process that writes this index indexes it" : "Index new and changed logs now (File ▸ Reindex Now)")
                }
                Button("Restart Engine") {
                    if model.isCapture { model.engine.restart() } else { model.app.restartLiveEngine() }
                }
                Spacer()
                Button("Open Sources") {
                    model.workspace = .sources
                    close()
                }
            }
            .controlSize(.small)
        }
        .padding(14)
        .frame(width: 420)
    }

    private var agentCounts: [(agent: AgentKind, sessions: Int)] {
        let counts = Dictionary(grouping: model.sessions, by: \.agent).mapValues(\.count)
        return counts.map { ($0.key, $0.value) }.sorted { $0.sessions > $1.sessions }
    }

    /// Capture coverage in words (raw lines unavailable, sidecars omitted), when the engine reports it.
    private var captureCoverage: String? {
        guard let c = store.info?.capture?.coverage else { return nil }
        if c["known"]?.boolValue == false { return "Coverage was not recorded by the writer of this capture." }
        var parts: [String] = []
        if let n = c["rawUnavailable"]?.intValue, n > 0 { parts.append("\(Formatters.count(n, "raw line")) unavailable") }
        if c["rawOmitted"]?.boolValue == true { parts.append("raw lines omitted on purpose (--no-raw)") }
        if let s = c["sidecarsOmitted"]?.arrayValue, !s.isEmpty { parts.append("\(Formatters.count(s.count, "side file")) omitted") }
        return parts.isEmpty ? "All raw lines and side files are present." : "Coverage: " + parts.joined(separator: "; ") + "."
    }

    @ViewBuilder private var engineLog: some View {
        let lines = model.engine.logTail.suffix(60)
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Engine Log").font(.subheadline.weight(.semibold))
                    Spacer()
                    Button("Copy") { AppKitHelpers.copy(model.engine.logTail.joined(separator: "\n")) }
                        .buttonStyle(.link)
                        .font(.caption)
                }
                ScrollView {
                    Text(lines.joined(separator: "\n"))
                        .font(.system(size: 10, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(6)
                }
                .defaultScrollAnchor(.bottom)
                .frame(height: 140)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color(nsColor: .separatorColor)))
            }
        }
    }
}

/// The workspace picker (§8.5): an `NSSegmentedControl` of the seven workspaces in full words, always at the regular
/// control size (a toolbar may otherwise render it larger). Segments fit their titles (a SwiftUI segmented picker in a
/// toolbar gives every segment the width of the longest title). The order is SPEC §12.7's, or the classic one.
struct WorkspacePicker: NSViewRepresentable {
    let selection: Workspace
    var order: [Workspace] = Workspace.allCases
    let select: (Workspace) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSSegmentedControl {
        let control = NSSegmentedControl(labels: order.map(\.title), trackingMode: .selectOne,
                                         target: context.coordinator, action: #selector(Coordinator.changed(_:)))
        control.controlSize = .regular
        control.segmentDistribution = .fit
        control.setAccessibilityLabel("Workspace")
        return control
    }

    func updateNSView(_ control: NSSegmentedControl, context: Context) {
        let c = context.coordinator
        c.select = select
        if c.order != order {
            c.order = order
            control.segmentCount = order.count
            for (i, w) in order.enumerated() {
                control.setLabel(w.title, forSegment: i)
                control.setToolTip("\(w.title) (⌘\(i + 1))", forSegment: i)
                control.setWidth(0, forSegment: i)
            }
            control.invalidateIntrinsicContentSize()
        }
        let index = order.firstIndex(of: selection) ?? 0
        if control.selectedSegment != index { control.selectedSegment = index }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSSegmentedControl, context: Context) -> CGSize? {
        nsView.intrinsicContentSize
    }

    @MainActor final class Coordinator: NSObject {
        var select: (Workspace) -> Void = { _ in }
        var order: [Workspace] = []

        @objc func changed(_ sender: NSSegmentedControl) {
            if order.indices.contains(sender.selectedSegment) { select(order[sender.selectedSegment]) }
        }
    }
}

/// Whether the status item keeps its words (§8.6): the picker always shows full names, so under pressure the status
/// item shrinks to its dot before anything else changes.
struct ToolbarFit: Equatable {
    var showsStatusText: Bool

    /// Back and forward, the inspector toggle, and the spacing and padding between the items.
    static let fixed: CGFloat = 72 + 34 + 100
    /// A segment's padding and the status button's dot and bezel.
    static let segmentPadding: CGFloat = 20, statusChrome: CGFloat = 40

    @MainActor init(detailWidth: CGFloat, order: [Workspace], status: String) {
        let font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        func width(_ s: String, _ f: NSFont) -> CGFloat { ceil((s as NSString).size(withAttributes: [.font: f]).width) }
        let picker = order.reduce(0) { $0 + width($1.title, font) + Self.segmentPadding }
        let statusText = width(status, .preferredFont(forTextStyle: .callout))
        self.init(showsStatusText: detailWidth - Self.fixed - picker - Self.statusChrome - statusText >= 0)
    }

    init(showsStatusText: Bool) {
        self.showsStatusText = showsStatusText
    }
}
