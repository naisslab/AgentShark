import AppKit
import SwiftUI

/// Building blocks shared by the panel workspaces (Conversation, Statistics, Diagnostics, Sources) and their sheets.
/// They live in one namespace so they never collide with the other builders' types.
enum PanelKit {}

// MARK: - Requests with explicit states (SPEC §7.8)

/// One asynchronous request with explicit loading, failed and loaded states. Loading a new key cancels the previous
/// request, and responses that arrive for an older key are dropped. Retry repeats the same request.
@MainActor @Observable final class PanelRequest<Value> {
    enum Phase {
        case idle
        case loading
        case failed(APIError)
        case loaded(Value)
    }

    private(set) var phase: Phase = .idle
    private(set) var key: String?
    /// A refresh is loading while the previous value stays visible.
    private(set) var isRefreshing = false
    /// When the loaded value arrived.
    private(set) var loadedAt: Date?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var fetch: (@MainActor () async throws -> Value)?

    var value: Value? {
        if case .loaded(let v) = phase { return v }
        return nil
    }

    var isLoading: Bool {
        if case .loading = phase { return true }
        return false
    }

    /// Load `key` unless it is already loaded or loading; a failed key loads again. With `keepValue` (a live refresh
    /// of the same query), the current value stays visible until the new one arrives.
    func load(key: String, force: Bool = false, keepValue: Bool = false, _ fetch: @escaping @MainActor () async throws -> Value) {
        if !force, key == self.key {
            if case .failed = phase {} else { return }
        }
        self.key = key
        self.fetch = fetch
        run(keepValue: keepValue)
    }

    /// Repeat the last request.
    func retry() { run(keepValue: false) }

    func cancel() {
        task?.cancel()
        task = nil
        key = nil
        fetch = nil
        phase = .idle
        isRefreshing = false
    }

    private func run(keepValue: Bool) {
        guard let fetch else { return }
        task?.cancel()
        isRefreshing = keepValue && value != nil
        if !isRefreshing { phase = .loading }
        let key = self.key
        task = Task { [weak self] in
            do {
                let v = try await fetch()
                guard !Task.isCancelled, let self, self.key == key else { return }
                self.phase = .loaded(v)
                self.loadedAt = Date()
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, let self, self.key == key else { return }
                self.phase = .failed(error as? APIError ?? .unreachable(error))
            }
            self?.isRefreshing = false
        }
    }
}

extension WindowModel {
    /// The current view replaced an earlier view of the same query (a live refresh), so panels keep showing their
    /// numbers until the new ones arrive.
    var isRefreshingView: Bool { viewChangeReason == .refresh }
}

extension PanelKit {
    /// Shows a request's state: inline progress, a failure with Retry, or the content.
    struct RequestView<Value, Content: View>: View {
        let request: PanelRequest<Value>
        var loadingTitle = "Loading…"
        var failureTitle = "Could not load this view"
        @ViewBuilder let content: (Value) -> Content

        var body: some View {
            switch request.phase {
            case .idle, .loading:
                LoadingStateView(title: loadingTitle)
            case .failed(let e):
                FailedStateView(title: failureTitle, error: e) { request.retry() }
            case .loaded(let v):
                content(v)
                    .overlay(alignment: .topTrailing) {
                        if request.isRefreshing {
                            ProgressView()
                                .controlSize(.small)
                                .padding(8)
                                .help("Updating with newly indexed events")
                        }
                    }
            }
        }
    }

    /// The state of a workspace that depends on the window's view, when the view is not ready: waiting for the
    /// engine, building, failed (with Retry, never a global fallback), or empty with the SPEC §7.8 actions.
    struct ViewPhaseView: View {
        let model: WindowModel
        let phase: ViewPhase

        var body: some View {
            switch phase {
            case .waitingForEngine:
                EngineStateView(engine: model.engine)
            case .loading:
                LoadingStateView(title: "Building the view…")
            case .failed(let e):
                FailedStateView(error: e) { model.rebuildView() }
            case .empty:
                NoMatchesView(model: model)
            case .ready:
                EmptyView()
            }
        }
    }

    /// "No events match this filter and scope." with Clear Filter and Widen Range.
    struct NoMatchesView: View {
        let model: WindowModel

        var body: some View {
            ContentUnavailableView {
                Label("No matching events", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text("No events match this filter and scope.")
            } actions: {
                HStack {
                    if !model.appliedFilter.isEmpty {
                        Button("Clear Filter") { model.clearFilter() }
                    }
                    if model.scope.hasTimeRange {
                        Button("Widen Range") { model.clearTimeScope() }
                    }
                    if model.scope.hasSessions {
                        Button("All Sessions") { model.clearSessionScope() }
                    }
                }
            }
        }
    }
}

// MARK: - Bars, chips and buttons

extension PanelKit {
    /// The bar at the top of a workspace: scope label on the leading side, controls on the trailing side.
    struct HeaderBar<Leading: View, Trailing: View>: View {
        @ViewBuilder let leading: () -> Leading
        @ViewBuilder let trailing: () -> Trailing

        var body: some View {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    leading()
                    Spacer(minLength: 8)
                    trailing()
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 28)
                .controlSize(.small)
                Divider()
            }
            .background(.bar)
        }
    }

    /// Copies text and confirms with a checkmark for a moment.
    struct CopyButton: View {
        let text: String
        var title = "Copy"
        var help = "Copy to the clipboard"
        var iconOnly = false
        @State private var copied = false

        var body: some View {
            Button {
                AppKitHelpers.copy(text)
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(1.2))
                    copied = false
                }
            } label: {
                if iconOnly {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                } else {
                    Label(copied ? "Copied" : title, systemImage: copied ? "checkmark" : "doc.on.doc")
                }
            }
            .help(help)
            .accessibilityLabel(copied ? "Copied" : title)
        }
    }

    /// A small capsule label; color encodes status only.
    /// A Plain mark (DESIGN.md §6.1): an optional symbol and a word in its color; no border and no fill.
    struct Chip: View {
        let text: String
        var symbol: String?
        var color: Color = .secondary

        var body: some View {
            HStack(spacing: 3) {
                if let symbol {
                    Image(systemName: symbol).imageScale(.small).accessibilityHidden(true)
                }
                Text(text)
            }
            .font(Theme.fontSwiftUI(.rowSecondary))
            .lineLimit(1)
            .foregroundStyle(color)
        }
    }

    /// A horizontal share bar, `fraction` in 0…1.
    struct ShareBar: View {
        let fraction: Double

        var body: some View {
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule()
                        .fill(Color.secondary.opacity(0.55))
                        .frame(width: max(fraction > 0 ? 2 : 0, g.size.width * min(1, max(0, fraction))))
                }
            }
            .frame(height: 6)
            .accessibilityHidden(true)
        }
    }

    /// Monospaced text in a box with a label and a Copy button. Long text scrolls sideways, never wraps.
    struct CodeBlock: View {
        let text: String
        var label: String?
        /// Text copied instead of `text` (for example the untruncated value).
        var copyText: String?

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    if let label {
                        Text(label).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    CopyButton(text: copyText ?? text, help: "Copy \(label ?? "the code")", iconOnly: true)
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                }
                .padding(.horizontal, 8)
                .padding(.top, 4)
                ScrollView(.horizontal) {
                    Text(text)
                        .font(Theme.fontSwiftUI(.code))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                        .padding(.horizontal, 8)
                        .padding(.bottom, 8)
                        .padding(.top, 2)
                }
                .scrollIndicators(.automatic)
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor).opacity(0.7)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
        }
    }

    /// Apply as Filter and Prepare as Filter submenus for a fragment (Wireshark's six combine modes).
    struct FilterMenus: View {
        let model: WindowModel
        let fragment: String

        var body: some View {
            Menu("Apply as Filter") {
                ForEach(FilterCombine.allCases, id: \.self) { mode in
                    Button(mode.title) { model.applyFilter(fragment: fragment, mode: mode) }
                }
            }
            Menu("Prepare as Filter") {
                ForEach(FilterCombine.allCases, id: \.self) { mode in
                    Button(mode.title) { model.prepareFilter(fragment: fragment, mode: mode) }
                }
            }
        }
    }
}

// MARK: - Search field

extension PanelKit {
    /// A native `NSSearchField`. Return calls `onSubmit` (Shift-Return `onSubmitBackward`), Escape `onEscape`.
    struct SearchField: NSViewRepresentable {
        @Binding var text: String
        var prompt: String
        /// Increment to move keyboard focus into the field.
        var focusRequest = 0
        var onSubmit: (() -> Void)?
        var onSubmitBackward: (() -> Void)?
        var onEscape: (() -> Void)?

        func makeCoordinator() -> Coordinator { Coordinator() }

        func makeNSView(context: Context) -> NSSearchField {
            let field = NSSearchField()
            field.placeholderString = prompt
            field.setAccessibilityLabel(prompt)
            field.delegate = context.coordinator
            field.sendsSearchStringImmediately = true
            field.controlSize = .regular
            field.font = .systemFont(ofSize: NSFont.systemFontSize)
            context.coordinator.lastFocus = focusRequest
            return field
        }

        func updateNSView(_ field: NSSearchField, context: Context) {
            context.coordinator.parent = self
            if field.stringValue != text { field.stringValue = text }
            if context.coordinator.lastFocus != focusRequest {
                context.coordinator.lastFocus = focusRequest
                DispatchQueue.main.async { field.window?.makeFirstResponder(field) }
            }
        }

        @MainActor final class Coordinator: NSObject, NSSearchFieldDelegate {
            var parent: SearchField?
            var lastFocus = 0

            func controlTextDidChange(_ note: Notification) {
                guard let field = note.object as? NSSearchField else { return }
                parent?.text = field.stringValue
            }

            func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
                switch selector {
                case #selector(NSResponder.insertNewline(_:)):
                    if NSApp.currentEvent?.modifierFlags.contains(.shift) == true, let back = parent?.onSubmitBackward {
                        back()
                        return true
                    }
                    guard let submit = parent?.onSubmit else { return false }
                    submit()
                    return true
                case #selector(NSResponder.cancelOperation(_:)):
                    guard let escape = parent?.onEscape else { return false }
                    escape()
                    return true
                default:
                    return false
                }
            }
        }
    }
}

// MARK: - Split view with autosave

extension PanelKit {
    /// An `NSSplitView` that saves its divider position under `autosaveName`. `vertical` puts the panes side by side.
    struct SplitView<First: View, Second: View>: NSViewRepresentable {
        let autosaveName: String
        var vertical = false
        var firstMinimum: CGFloat = 120
        var secondMinimum: CGFloat = 120
        /// Initial share of the first pane when nothing is saved yet.
        var initialFraction: CGFloat = 0.55
        let first: First
        let second: Second

        func makeCoordinator() -> Coordinator { Coordinator() }

        func makeNSView(context: Context) -> NSSplitView {
            let split = NSSplitView()
            split.isVertical = vertical
            split.dividerStyle = .thin
            let a = NSHostingView(rootView: first)
            let b = NSHostingView(rootView: second)
            a.sizingOptions = []
            b.sizingOptions = []
            split.addArrangedSubview(a)
            split.addArrangedSubview(b)
            split.setHoldingPriority(.init(250), forSubviewAt: 0)
            split.setHoldingPriority(.init(260), forSubviewAt: 1)
            context.coordinator.minimums = (firstMinimum, secondMinimum)
            split.delegate = context.coordinator
            let hasSaved = UserDefaults.standard.object(forKey: "NSSplitView Subview Frames \(autosaveName)") != nil
            split.autosaveName = autosaveName
            if !hasSaved {
                let fraction = initialFraction
                DispatchQueue.main.async { [weak split] in
                    guard let split else { return }
                    let length = split.isVertical ? split.bounds.width : split.bounds.height
                    if length > 0 { split.setPosition((length * fraction).rounded(), ofDividerAt: 0) }
                }
            }
            return split
        }

        func updateNSView(_ split: NSSplitView, context: Context) {
            context.coordinator.minimums = (firstMinimum, secondMinimum)
            (split.arrangedSubviews.first as? NSHostingView<First>)?.rootView = first
            (split.arrangedSubviews.last as? NSHostingView<Second>)?.rootView = second
        }

        @MainActor final class Coordinator: NSObject, NSSplitViewDelegate {
            var minimums: (CGFloat, CGFloat) = (120, 120)

            func splitView(_ splitView: NSSplitView, constrainMinCoordinate proposed: CGFloat, ofSubviewAt index: Int) -> CGFloat {
                max(proposed, minimums.0)
            }

            func splitView(_ splitView: NSSplitView, constrainMaxCoordinate proposed: CGFloat, ofSubviewAt index: Int) -> CGFloat {
                let length = splitView.isVertical ? splitView.bounds.width : splitView.bounds.height
                return min(proposed, length - minimums.1 - splitView.dividerThickness)
            }
        }
    }
}

// MARK: - Formatting shared by the panels

extension PanelKit {
    /// "Times in UTC+08:00", for headers of panels that show local clock times (SPEC §7.8).
    /// "Times +08:00", as the scope bar spells it.
    static var timeZoneNote: String { "Times " + Formatters.offsetLabel() }

    /// `14:03:22` local, for compact lists; the tooltip carries the full timestamp with its offset.
    static func clock(_ us: Int64) -> String {
        let c = Formatters.components(us, zone: Formatters.timeZone)
        return String(format: "%02d:%02d:%02d", c.hour, c.minute, c.second)
    }

    /// The display label of an agent kind string.
    static func agentLabel(_ raw: String) -> String { AgentKind(rawValue: raw).label }

    /// Whether a string is a session ID (`cc:…`, `cw:…`, `cx:…`, `cp:…`).
    static func isSessionID(_ s: String) -> Bool {
        guard s.count > 3, s.dropFirst(2).first == ":" else { return false }
        return AgentKind.known.contains { s.hasPrefix($0.prefix + ":") }
    }
}
