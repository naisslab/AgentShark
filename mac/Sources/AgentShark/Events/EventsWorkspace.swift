import AppKit
import SwiftUI

/// The Events workspace (MAC-SPEC §5): timeline track, event table, then the detail outline beside the raw
/// pane. Every split saves its position.
struct EventsWorkspace: View {
    @Bindable var model: WindowModel
    @State private var pane = EventsPaneState()

    var body: some View {
        VStack(spacing: 0) {
            WorkspaceHeader(model: model, label: model.scopeLabel(for: .events), stale: model.viewIsStale) {
                if !model.autoHiddenEventColumns.isEmpty {
                    Button(ColumnFit.hiddenText(model.autoHiddenEventColumns.count)) { model.eventTable?.showColumnsMenu() }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .help("Columns that do not fit this width: " + model.autoHiddenEventColumns.joined(separator: ", "))
                }
                Button("Columns") { model.eventTable?.showColumnsMenu() }
                    .help("Show, hide and reset the table's columns")
            }
            if model.isFindBarVisible {
                EventFindBar(model: model)
                Divider()
            }
            AutosaveSplitView(autosaveName: "AgentShark.Events.Rows", vertical: false, panes: [
                SplitPane(id: "timeline", minimum: 56, initial: 96, holdingPriority: .init(260), isCollapsed: !model.showTimelineTrack,
                          accessibilityLabel: "Timeline track") {
                    TimelineTrackStrip(model: model)
                },
                SplitPane(id: "table", minimum: 120, accessibilityLabel: "Events") {
                    EventTablePane(model: model)
                },
                SplitPane(id: "inspect", minimum: 200, initial: 320, holdingPriority: .init(255), accessibilityLabel: "Event detail and raw source") {
                    // Follow takes the Raw pane at a window of 1440 or wider, so the call's Detail reads beside it; below,
                    // the whole lower region (§7.9).
                    if model.followTarget != nil, model.windowWidth < 1440 {
                        FollowPanel(model: model, inRegion: true)
                    } else {
                        AutosaveSplitView(autosaveName: "AgentShark.Events.Inspect", vertical: true, panes: [
                            // Equal holding priorities: both panes share a change in width.
                            SplitPane(id: "detail", minimum: 220, accessibilityLabel: "Detail") { DetailPane(model: model, pane: pane) },
                            SplitPane(id: "raw", minimum: 250, initial: 460, accessibilityLabel: model.followTarget == nil ? "Raw source" : "Follow") {
                                if model.followTarget != nil { FollowPanel(model: model, inRegion: true) } else { RawPane(model: model, pane: pane) }
                            },
                        ])
                    }
                },
            ])
        }
        .sheet(item: $pane.longText) { item in
            LongTextSheet(item: item, api: model.engine.api)
        }
    }
}

/// The event table with its view states (SPEC §7.8): loading, failed with Retry, empty with actions, ready.
/// The table stays in place across states, so its scroll position and columns survive a rebuild.
struct EventTablePane: View {
    @Bindable var model: WindowModel

    var body: some View {
        VStack(spacing: 0) {
            if model.viewIsStale, let e = model.viewError {
                InlineBanner(symbol: "clock.badge.exclamationmark", text: "Could not refresh this view; showing earlier results. \(e.message)",
                             action: "Retry") { model.rebuildView() }
            } else if let e = model.rowsError {
                InlineBanner(symbol: "exclamationmark.triangle", text: "Some rows could not be loaded. \(e.message)", action: "Retry") {
                    model.retryRows()
                }
            }
            ZStack {
                EventTable(model: model)
                    .opacity(model.view == nil ? 0 : 1)
                    .accessibilityHidden(model.view == nil)
                overlay
            }
        }
    }

    @ViewBuilder private var overlay: some View {
        switch model.viewPhase {
        case .waitingForEngine:
            EngineStateView(engine: model.engine).background(.background)
        case .loading:
            LoadingStateView(title: model.appliedFilter.isEmpty && model.scope.isEmpty ? "Building the view of all events…" : "Building the view…")
                .background(.background)
        case .failed(let e):
            FailedStateView(error: e) { model.rebuildView() }.background(.background)
        case .empty:
            ContentUnavailableView {
                Label("No events match", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text(emptyDescription)
            } actions: {
                HStack {
                    if !model.appliedFilter.isEmpty { Button("Clear Filter") { model.clearFilter() } }
                    if model.scope.hasTimeRange { Button("Widen Range") { model.clearTimeScope() } }
                    if model.scope.hasSessions { Button("Show All Sessions") { model.clearSessionScope() } }
                }
                .fixedSize()
            }
            .background(.background)
        case .ready:
            EmptyView()
        }
    }

    private var emptyDescription: String {
        if model.appliedFilter.isEmpty && model.scope.isEmpty { return "The index has no events yet." }
        return "No events match this filter and scope."
    }
}

/// A one-line notice above a pane, with an action.
struct InlineBanner: View {
    let symbol: String
    let text: String
    let action: String
    let perform: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).foregroundStyle(.orange).accessibilityHidden(true)
            Text(text).lineLimit(2).font(.callout)
            Spacer(minLength: 8)
            Button(action, action: perform).controlSize(.small)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.orange.opacity(0.1))
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .combine)
    }
}

/// The detail outline with its header and states.
struct DetailPane: View {
    @Bindable var model: WindowModel
    let pane: EventsPaneState

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Detail").font(Theme.fontSwiftUI(.paneTitle))
                if let d = model.eventDetail {
                    Text(d.event.kind.rawValue).font(Theme.fontSwiftUI(.code)).foregroundStyle(.secondary).lineLimit(1)
                    if let no = d.event.no { Text("No. " + Formatters.count(no)).font(Theme.fontSwiftUI(.rowSecondary)).foregroundStyle(.secondary) }
                }
                Spacer()
                if model.isLoadingDetail { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 12)
            .frame(height: model.app.preferences.metrics.paneHeader)
            Divider()
            ZStack {
                DetailOutline(model: model, pane: pane)
                    .opacity(model.eventDetail == nil ? 0 : 1)
                if model.selectedEvent == nil {
                    ContentUnavailableView("No event selected", systemImage: "list.bullet.indent",
                                           description: Text("Select a row to decode it into layers, from the event down to the native record."))
                        .background(.background)
                } else if let e = model.detailError {
                    FailedStateView(title: "Could not load the event",
                                    message: e.status == 404 ? "The event is no longer in the index; it may have been re-indexed." : "Your selection is preserved.",
                                    error: e) { model.reloadSelection() }
                        .background(.background)
                } else if model.eventDetail == nil {
                    LoadingStateView(title: "Decoding…").background(.background)
                }
            }
        }
    }
}

/// ⌘F: find in the view (full text). Jumps between matches without filtering.
struct EventFindBar: View {
    @Bindable var model: WindowModel
    @State private var query = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField("Find in View", text: $query, prompt: Text("Find text in the current view"))
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { model.find(query, forward: true) }
                .frame(maxWidth: 360)
                .accessibilityLabel("Find in view")
            ControlGroup {
                Button { model.find(query, forward: false) } label: { Image(systemName: "chevron.left") }
                    .iconHelp("Find Previous (⇧⌘G)")
                Button { model.find(query, forward: true) } label: { Image(systemName: "chevron.right") }
                    .iconHelp("Find Next (⌘G)")
            }
            .controlSize(.small)
            .fixedSize()
            .disabled(query.trimmingCharacters(in: .whitespaces).isEmpty)
            if let status = model.findStatus {
                Text(status).font(.callout).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Text("Find moves the selection; it does not filter.").font(.caption).foregroundStyle(.tertiary).lineLimit(1)
            Button("Done") { model.isFindBarVisible = false }
                .controlSize(.small)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.bar)
        .onAppear {
            query = model.findQuery
            focused = true
        }
        .onChange(of: model.findFocusRequest) { focused = true }
        .onExitCommand { model.isFindBarVisible = false }
    }
}

/// A long string from the detail outline, readable and searchable in full.
struct LongTextSheet: View {
    let item: EventsPaneState.LongText
    let api: APIClient?
    @Environment(\.dismiss) private var dismiss
    @State private var text: String?
    @State private var loadProblem: String?
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(item.title).font(.headline)
                Spacer()
                Text("\(Formatters.count((text ?? item.text).count)) characters · \(Formatters.count(DetailTreeBuilder.lineCount(text ?? item.text), "line"))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            ReadOnlyTextView(text: text ?? item.text)
                .frame(minWidth: 560, idealWidth: 760, minHeight: 320, idealHeight: 520)
                .border(Color(nsColor: .separatorColor))
            HStack {
                if item.isShortened && text == nil {
                    Button("Load Full Value from Source") { Task { await loadFull() } }
                        .disabled(isLoading || api == nil || item.event == nil || item.rawPointer == nil)
                        .help("The index keeps a shortened copy; read the whole value from the source file.")
                    if isLoading { ProgressView().controlSize(.small) }
                }
                if let loadProblem { Text(loadProblem).font(.callout).foregroundStyle(.secondary) }
                Spacer()
                Button("Copy") { AppKitHelpers.copy(text ?? item.text) }
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
    }

    private func loadFull() async {
        guard let api, let event = item.event, let pointer = item.rawPointer else { return }
        isLoading = true
        defer { isLoading = false }
        // "…[+1234 chars]": how much the index left out.
        let missing = item.text.range(of: #"(?<=\[\+)\d+"#, options: .regularExpression).flatMap { Int(item.text[$0]) } ?? 0
        do {
            let raw = try await api.raw(event, maxString: max(4000, item.text.count + missing + 64))
            guard raw.available, let value = RawJSON.value(at: pointer, inRecord: raw.text)?.stringValue else {
                loadProblem = raw.reason.map { "The source is unavailable: \($0)." } ?? "The value is not in the source line."
                return
            }
            text = value
        } catch {
            loadProblem = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}

/// A scrollable, selectable, searchable (⌘F) plain-text view.
struct ReadOnlyTextView: NSViewRepresentable {
    let text: String

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        if let tv = scroll.documentView as? NSTextView {
            tv.isEditable = false
            tv.isSelectable = true
            tv.usesFindBar = true
            tv.isIncrementalSearchingEnabled = true
            tv.font = Theme.codeFont(size: 12)
            tv.textContainerInset = NSSize(width: 6, height: 6)
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView, tv.string != text else { return }
        tv.string = text
    }
}
