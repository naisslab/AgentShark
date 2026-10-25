import AppKit
import SwiftUI

/// Conversation ("Follow Session", MAC-SPEC §7): the scoped session as a lazily loaded native transcript. It always
/// shows the full session: the display filter and the time range do not apply, and the scope label says so.
/// With several sessions selected it shows one and says which, with a picker (SPEC §7.8).
struct ConversationWorkspace: View {
    @Bindable var model: WindowModel
    @State private var conversation = ConversationModel()
    @State private var findVisible = false
    @State private var findQuery = ""
    @State private var findFocus = 0
    @State private var matchIndex = 0
    /// The entry Find scrolls to; the counter makes a repeated target scroll again.
    @State private var scrollTarget: (id: String, request: Int)?
    @State private var fullText: FullTextRequest?

    private struct LoadKey: Hashable {
        let session: String?
        let engine: ObjectIdentifier?
    }

    var body: some View {
        let sessionID = model.focusedSessionID
        // The window's scope bar shows this workspace's scope label ("Full session · filter does not apply").
        VStack(spacing: 0) {
            if let note = model.singleSessionNote {
                selectionBar(note)
            } else if model.scope.sessions.isEmpty, let sessionID {
                followBar(sessionID)
            }
            if let sessionID {
                ConversationHeader(model: model, conversation: conversation, sessionID: sessionID, find: openFind)
                if findVisible { findBar }
                Divider()
                transcript(sessionID)
            } else {
                ContentUnavailableView {
                    Label("No session selected", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Select one session in the sidebar to read it as a conversation: prompts, answers, thinking, tool calls and subagents in order.")
                }
            }
        }
        .task(id: LoadKey(session: sessionID, engine: model.engine.api.map(ObjectIdentifier.init))) {
            conversation.open(sessionID, api: model.engine.api, known: sessionID.flatMap { model.sessionsByID[$0] })
            matchIndex = 0
        }
        .onChange(of: model.findFocusRequest) {
            // Edit ▸ Find (⌘F) while this workspace is showing searches the transcript.
            guard model.workspace == .session, model.sessionMode == .transcript, sessionID != nil else { return }
            model.isFindBarVisible = false
            openFind()
        }
        .onChange(of: findQuery) {
            matchIndex = 0
            if let first = matches.first { scroll(to: first) }
        }
        .sheet(item: $fullText) { FullTextSheet(request: $0, model: model) }
    }

    // MARK: Scope bars

    private func selectionBar(_ note: String) -> some View {
        InfoBar(symbol: "rectangle.stack") {
            Text(note + ":")
            Picker("Session", selection: Binding(get: { model.focusedSessionID ?? "" }, set: { model.singleSessionChoice = $0 })) {
                ForEach(model.scope.sessions, id: \.self) { id in
                    Text(model.store.title(of: id)).tag(id)
                }
            }
            .labelsHidden()
            .fixedSize()
            .help("Conversation follows one session at a time; choose which of the selected sessions to show")
        }
    }

    private func followBar(_ sessionID: String) -> some View {
        InfoBar(symbol: "arrow.turn.down.right") {
            Text("No session is selected, so this follows the session of the selected event.")
            Button("Scope to This Session") { model.openSession(sessionID) }
                .controlSize(.small)
        }
    }

    // MARK: Find (⌘F, Return / ⌘G next, Shift-Return / ⇧⌘G previous, Escape closes)

    private var matches: [String] { findVisible ? conversation.matches(findQuery) : [] }

    private var currentMatch: String? {
        let m = matches
        return m.isEmpty ? nil : m[min(matchIndex, m.count - 1)]
    }

    private func openFind() {
        findVisible = true
        findFocus += 1
    }

    private func closeFind() {
        findVisible = false
        findQuery = ""
    }

    private func step(_ delta: Int) {
        let m = matches
        guard !m.isEmpty else {
            NSSound.beep()
            return
        }
        matchIndex = (min(matchIndex, m.count - 1) + delta + m.count) % m.count
        scroll(to: m[matchIndex])
    }

    private func scroll(to id: String) {
        scrollTarget = (id, (scrollTarget?.request ?? 0) + 1)
    }

    private var findBar: some View {
        let m = matches
        let status: String
        if findQuery.trimmingCharacters(in: .whitespaces).isEmpty {
            status = conversation.isComplete ? "" : "Searches the \(Formatters.count(conversation.entries.count, "loaded item"))"
        } else if m.isEmpty {
            status = conversation.isComplete ? "No matches" : "No matches in the loaded items"
        } else {
            status = "\(min(matchIndex, m.count - 1) + 1) of \(Formatters.count(m.count))" + (conversation.isComplete ? "" : " in the loaded items")
        }
        return VStack(spacing: 0) {
            Divider()
            HStack(spacing: 8) {
                PanelKit.SearchField(text: $findQuery, prompt: "Find in Transcript", focusRequest: findFocus,
                                     onSubmit: { step(1) }, onSubmitBackward: { step(-1) }, onEscape: closeFind)
                    .frame(width: 280)
                ControlGroup {
                    Button {
                        step(-1)
                    } label: {
                        Image(systemName: "chevron.left")
                    }
                    .keyboardShortcut("g", modifiers: [.command, .shift])
                    .iconHelp("Previous Match (⇧⌘G)")
                    Button {
                        step(1)
                    } label: {
                        Image(systemName: "chevron.right")
                    }
                    .keyboardShortcut("g", modifiers: .command)
                    .iconHelp("Next Match (⌘G)")
                }
                .fixedSize()
                .disabled(m.isEmpty)
                Text(status).foregroundStyle(.secondary).monospacedDigit()
                if !conversation.isComplete {
                    if conversation.isLoadingAll {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Load All") { conversation.loadAll() }
                            .help("Load the rest of the session so Find covers all of it")
                    }
                }
                Spacer()
                Button("Done", action: closeFind)
            }
            .controlSize(.small)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
        }
        .background(.bar)
    }

    // MARK: Transcript

    @ViewBuilder private func transcript(_ sessionID: String) -> some View {
        switch conversation.phase {
        case .idle, .loading:
            LoadingStateView(title: "Loading the conversation…")
        case .failed(let e):
            FailedStateView(title: "Could not load the conversation", error: e) {
                conversation.reload(known: model.sessionsByID[sessionID])
            }
        case .ready where conversation.entries.isEmpty && conversation.isComplete:
            ContentUnavailableView {
                Label("Nothing to show", systemImage: "text.bubble")
            } description: {
                Text("This session has no prompts, answers or tool calls. Its events may all be metadata; the Events workspace shows them.")
            } actions: {
                Button("Show Session in Events") { model.openSession(sessionID, workspace: .events) }
            }
        case .ready:
            let context = ConversationContext(model: model, highlight: findVisible ? findQuery.trimmingCharacters(in: .whitespaces) : "",
                                              showFullText: { fullText = $0 })
            let current = currentMatch
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(conversation.entries) { entry in
                            ConversationItemView(entry: entry, context: context, isCurrentMatch: entry.id == current)
                                .id(entry.id)
                        }
                        footer
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 16)
                    .frame(maxWidth: 940, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: scrollTarget?.request) {
                    guard let id = scrollTarget?.id else { return }
                    withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .center) }
                }
            }
        }
    }

    @ViewBuilder private var footer: some View {
        if let e = conversation.moreError {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warn.swiftUI)
                Text("Could not load more of the conversation. \(e.message)").foregroundStyle(.secondary)
                Button("Retry") { conversation.loadMore() }
            }
            .font(.callout)
            .frame(maxWidth: .infinity)
        } else if !conversation.isComplete {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading…").foregroundStyle(.secondary)
            }
            .font(.callout)
            .frame(maxWidth: .infinity)
            .onAppear { conversation.loadMore() }
        } else {
            Text("End of session · \(Formatters.count(conversation.entries.count, "item"))")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
        }
    }
}

/// A one-line note under the header bar.
private struct InfoBar<Content: View>: View {
    let symbol: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: symbol).foregroundStyle(.secondary).accessibilityHidden(true)
                content()
                Spacer(minLength: 0)
            }
            .font(.callout)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            Divider()
        }
    }
}

// MARK: - Header

/// Sticky session facts: title, agent, model, working directory, tokens and duration.
private struct ConversationHeader: View {
    let model: WindowModel
    let conversation: ConversationModel
    let sessionID: String
    let find: () -> Void

    var body: some View {
        let latest = model.sessionsByID[sessionID]
        let row = conversation.session ?? latest
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if let row {
                    Image(systemName: Symbols.agent(row.agent))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Theme.agentColor(row.agent).swiftUI)
                        .help(row.agent.label)
                }
                Text(row?.displayTitle ?? sessionID)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
                    .help(sessionID)
                if let role = row?.role, role != "main" { PanelKit.Chip(text: role) }
                if row?.isMissingSource == true {
                    PanelKit.Chip(text: "Transcript missing", symbol: "exclamationmark.triangle", color: Theme.warn.swiftUI)
                        .help("Only registry metadata survives for this session; its transcript file is gone.")
                }
                Spacer(minLength: 8)
                if let latest, let loaded = conversation.session, conversation.phase == .ready,
                   latest.nEvents != loaded.nEvents || latest.end != loaded.end {
                    Button {
                        conversation.reload(known: latest)
                    } label: {
                        Label("New Activity", systemImage: "arrow.clockwise")
                    }
                    .help("The session has new events since the transcript was loaded. Reload it.")
                }
                if let parent = row?.parentId {
                    Button("Parent Session") { model.openSession(parent, mode: .transcript) }
                        .help("Open \(model.store.title(of: parent))")
                }
                Button(action: find) {
                    Image(systemName: "magnifyingglass")
                }
                .iconHelp("Find in Transcript (⌘F)")
            }
            .controlSize(.small)
            if let row {
                Text(facts(row))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
                if let cwd = row.cwd {
                    Text(cwd)
                        .font(Theme.fontSwiftUI(.code))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                        .textSelection(.enabled)
                        .help("Working directory: \(cwd)")
                }
            } else if let e = conversation.sessionError {
                Text("Session details are unavailable: \(e.message)").font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func facts(_ s: SessionRow) -> String {
        var parts = [s.agent.label]
        if !s.models.isEmpty { parts.append(s.models.joined(separator: ", ")) }
        let t = s.tokens
        let tokens = [t.input.map { "in \(Formatters.tokens($0))" }, t.output.map { "out \(Formatters.tokens($0))" },
                      t.cache_read.flatMap { $0 > 0 ? "cache \(Formatters.tokens($0))" : nil }].compactMap { $0 }
        if !tokens.isEmpty { parts.append("tokens " + tokens.joined(separator: " / ")) }
        if let start = s.start, let end = s.end { parts.append(Formatters.duration(end - start)) }
        parts.append(Formatters.count(s.nTurns, "turn"))
        parts.append(Formatters.count(s.nEvents, "event"))
        if s.nErrors > 0 { parts.append(Formatters.count(s.nErrors, "error")) }
        if s.nChildren > 0 { parts.append(Formatters.count(s.nChildren, "subagent")) }
        if let start = s.start { parts.append("started \(Formatters.timestamp(start).prefix(19)) \(Formatters.utcOffset(at: start))") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Full text and output

/// A request for an item's complete text or output from its raw source record.
struct FullTextRequest: Identifiable, Hashable {
    enum Kind: Hashable { case text, output }

    let eventID: String
    let kind: Kind
    let title: String

    var id: String { "\(eventID)#\(kind)" }
}

/// Shows the untruncated text in a text view with Find, Copy and Wrap Lines.
struct FullTextSheet: View {
    let request: FullTextRequest
    let model: WindowModel
    @Environment(\.dismiss) private var dismiss
    @State private var load = PanelRequest<Result>()
    @State private var wrap = true

    struct Result {
        var text: String
        var notes: [String]
        var unavailable: String?
        var persistedPath: String?
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(request.title).font(.headline)
                Text(request.eventID).font(Theme.fontSwiftUI(.code)).foregroundStyle(.secondary).textSelection(.enabled)
                Spacer()
                Toggle("Wrap Lines", isOn: $wrap).toggleStyle(.checkbox)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider()
            PanelKit.RequestView(request: load, loadingTitle: "Loading the original record…",
                                 failureTitle: "Could not load the original record") { r in
                if let reason = r.unavailable {
                    ContentUnavailableView("Original record unavailable", systemImage: "doc.questionmark", description: Text(reason))
                } else {
                    VStack(spacing: 0) {
                        FullTextView(text: r.text, wrap: wrap)
                        if !r.notes.isEmpty {
                            Divider()
                            Text(r.notes.joined(separator: " "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 6)
                        }
                    }
                }
            }
            Divider()
            HStack {
                if let path = load.value?.persistedPath {
                    Button("Reveal Persisted Output in Finder") { AppKitHelpers.revealInFinder(path) }
                        .help(path)
                }
                Spacer()
                if let text = load.value?.text, load.value?.unavailable == nil {
                    PanelKit.CopyButton(text: text, title: "Copy All", help: "Copy the complete text")
                }
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .frame(minWidth: 680, idealWidth: 860, minHeight: 440, idealHeight: 620)
        .task {
            let request = request
            load.load(key: request.id) { [model] in try await Self.fetch(request, api: model.panelAPI()) }
        }
    }

    private static func fetch(_ request: FullTextRequest, api: APIClient) async throws -> Result {
        let raw = try await api.raw(request.eventID, maxString: ConversationText.fullMaxString)
        guard raw.available else {
            return Result(text: "", notes: [], unavailable: "The original source line cannot be read" + (raw.reason.map { ": \($0)." } ?? "."))
        }
        let record = try? JSONValue.parse(raw.text)
        let block = ConversationText.block(of: request.eventID)
        let picked = record.flatMap {
            request.kind == .output ? ConversationText.output(from: $0, block: block) : ConversationText.text(from: $0, block: block)
        }
        var notes: [String] = []
        if picked == nil { notes.append("No known field matched, so this is the whole source record.") }
        if raw.truncated { notes.append("The engine still shortened some very long strings.") }
        let text = picked ?? raw.text
        var persisted: String?
        if text.contains("<persisted-output>"), let detail = try? await api.event(request.eventID),
           let path = detail.event.attrs["tool"]?["persisted_path"]?.stringValue, FileManager.default.fileExists(atPath: path) {
            persisted = path
        }
        return Result(text: text, notes: notes, persistedPath: persisted)
    }
}

/// A read-only, selectable `NSTextView` with the system find bar (⌘F while it has focus).
private struct FullTextView: NSViewRepresentable {
    let text: String
    var wrap = true

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        guard let tv = scroll.documentView as? NSTextView else { return scroll }
        tv.isEditable = false
        tv.isSelectable = true
        tv.isRichText = false
        tv.usesFindBar = true
        tv.isIncrementalSearchingEnabled = true
        tv.font = Theme.codeFont(size: 12)
        tv.textColor = .textColor
        tv.textContainerInset = NSSize(width: 8, height: 8)
        tv.layoutManager?.allowsNonContiguousLayout = true
        tv.setAccessibilityLabel("Full text")
        tv.string = text
        apply(wrap: wrap, to: tv, in: scroll)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView else { return }
        if tv.string != text { tv.string = text }
        apply(wrap: wrap, to: tv, in: scroll)
    }

    private func apply(wrap: Bool, to tv: NSTextView, in scroll: NSScrollView) {
        guard let container = tv.textContainer, container.widthTracksTextView != wrap else { return }
        scroll.hasHorizontalScroller = !wrap
        tv.isHorizontallyResizable = !wrap
        container.widthTracksTextView = wrap
        if wrap {
            tv.autoresizingMask = [.width]
            tv.setFrameSize(NSSize(width: scroll.contentSize.width, height: tv.frame.height))
            container.containerSize = NSSize(width: scroll.contentSize.width, height: .greatestFiniteMagnitude)
        } else {
            tv.autoresizingMask = []
            tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            container.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        }
        tv.sizeToFit()
    }
}
