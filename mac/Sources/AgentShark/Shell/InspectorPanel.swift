import SwiftUI

/// The session inspector (⌥⌘I): the scoped session's facts, links to its parent and subagents, and its source
/// files. With several sessions scoped it lists them; with none it shows the selected event's session.
struct InspectorPanel: View {
    @Bindable var model: WindowModel
    @State private var detail: SessionDetail?
    @State private var error: APIError?
    @State private var isLoading = false

    /// The session the inspector describes, and why.
    private var target: (id: String, note: String?)? {
        switch model.scope.sessions.count {
        case 1: return (model.scope.sessions[0], nil)
        case 0: return model.eventDetail.map { ($0.event.session, "Session of the selected event. No session is scoped.") }
        default:
            let id = model.focusedSessionID ?? model.scope.sessions[0]
            return (id, model.singleSessionNote)
        }
    }

    var body: some View {
        Group {
            if let target {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if model.scope.sessions.count > 1 { sessionPicker }
                        if let note = target.note {
                            Text(note).font(.callout).foregroundStyle(.secondary)
                        }
                        content(for: target.id)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .task(id: "\(target.id)|\(model.store.indexGeneration)") { await load(target.id) }
            } else {
                ContentUnavailableView("No session", systemImage: "sidebar.trailing",
                                       description: Text("Select a session in the sidebar, or an event, to see its details."))
            }
        }
        .frame(minWidth: 220, maxWidth: .infinity)
    }

    private var sessionPicker: some View {
        Picker("Session", selection: Binding(get: { model.focusedSessionID ?? "" }, set: { model.singleSessionChoice = $0 })) {
            ForEach(model.scope.sessions, id: \.self) { id in
                Text(model.runLabel(of: id)).tag(id)
            }
        }
        .help("Which of the selected sessions the inspector, Conversation and Flow show")
    }

    @ViewBuilder private func content(for id: String) -> some View {
        let row = detail?.session.row ?? model.sessionsByID[id]
        if let row {
            header(row)
            facts(row)
            if let p = row.parentId { linkRow("Parent", id: p) }
            if let children = detail?.children, !children.isEmpty { childrenSection(children) }
            if let sources = detail?.sources, !sources.isEmpty { sourcesSection(sources) }
        } else if let error {
            FailedStateView(title: "Could not load the session", message: "Your selection is preserved.", error: error) {
                Task { await load(id) }
            }
        } else {
            LoadingStateView(title: "Loading the session…")
        }
        if isLoading && row != nil { ProgressView().controlSize(.small) }
    }

    private func header(_ s: SessionRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label {
                Text(s.agent.label)
            } icon: {
                Image(systemName: Symbols.agent(s.agent)).foregroundStyle(Color(nsColor: Theme.agentColor(s.agent)))
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            Text(s.displayTitle).font(.title3.weight(.semibold)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Text(s.id).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            compareButtons(s)
            if s.isMissingSource {
                Label(s.state == "missing-transcript" ? "The transcript file is gone; only registry metadata remains."
                      : "The source file was deleted; the index keeps its copy.", systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
        }
    }

    /// Compare These 2 Runs when the scope holds two top-level runs, as the scope bar's Compare 2 Runs, so the pair the
    /// note "Showing 1 of 2 selected sessions" names is one click away; then Compare With… for a top-level run. A
    /// subagent has no Compare With, since Compare aligns top-level runs (ANALYSIS-UX §3.7). Side by side where both
    /// fit, else one above the other.
    @ViewBuilder private func compareButtons(_ s: SessionRow) -> some View {
        let pair = ScopeBar.offersCompare(model) ? model.compareRunPair(model.scope.sessions) : nil
        let these = pair.map { pair in
            Button("Compare These 2 Runs") { model.showSessionMode(.compare) }
                .help("\(model.runLabel(of: pair.a)) and \(model.runLabel(of: pair.b))\n" + ScopeBar.compareHelp)
        }
        let with = s.parentId == nil ? Button("Compare With…") { model.openSession(s.id, mode: .compare) }.help(ScopeBar.compareHelp) : nil
        if these != nil || with != nil {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    these
                    with
                }
                VStack(alignment: .leading, spacing: 4) {
                    these
                    with
                }
            }
            .controlSize(.small)
            .padding(.top, 4)
        }
    }

    private func facts(_ s: SessionRow) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 5) {
            fact("Role", s.role)
            fact("Project", s.project)
            fact("Folder", s.cwd, mono: true)
            fact("Branch", s.gitBranch)
            fact("Models", s.models.isEmpty ? nil : s.models.joined(separator: ", "))
            fact("Version", s.version)
            fact("Active", s.start.map { Formatters.timeRange(from: $0, to: s.end) })
            fact("Duration", RunDuration(s)?.figure, missing: RunDuration(s)?.help)
            // No figure here: the analysis runs only when Session · Critical Path shows (ANALYSIS-UX §3.7).
            GridRow {
                Text("Critical path").foregroundStyle(.secondary).gridColumnAlignment(.trailing)
                Button("Show") { showCriticalPath(s.id) }
                    .buttonStyle(.link)
                    .help("Session ▸ Critical Path (\(AgentSharkCommands.modeShortcut(.criticalPath).keys))")
            }
            fact("Events", Formatters.count(s.nEvents))
            fact("Turns", Formatters.count(s.nTurns))
            fact("Model calls", Formatters.count(s.nLlm))
            fact("Tool calls", Formatters.count(s.nTools))
            fact("Errors", Formatters.count(s.nErrors), help: Self.errorsHelp)
            fact("Tokens", "\(Formatters.tokens(s.tokens.input)) in · \(Formatters.tokens(s.tokens.output)) out", help: Self.tokensHelp)
            fact("Logged cost", s.costUsd.map(Formatters.cost))
        }
        .font(.callout)
    }

    /// Critical Path of the described session, keeping the scope when it already holds that session.
    private func showCriticalPath(_ id: String) {
        if model.scope.sessions.contains(id) {
            model.singleSessionChoice = id
            model.showSessionMode(.criticalPath)
        } else {
            model.openSession(id, mode: .criticalPath)
        }
    }

    /// What the session's figures count, where Compare counts nearby figures over a whole run (DESIGN.md §1.7: one
    /// word, one count).
    static let errorsHelp = "Events flagged as errors in this session only. Not Compare's Failed actions, which counts failed tool actions across a run."
    static let tokensHelp = "Input and output tokens of this session only; Compare sums a run's sessions, its subagents included."

    /// A fact's tooltip says what it counts when `help` is given, else holds its value, which three lines can cut; a nil
    /// value reads "—", with `missing` as its tooltip when it says why.
    @ViewBuilder private func fact(_ name: String, _ value: String?, mono: Bool = false, help: String? = nil, missing: String? = nil) -> some View {
        GridRow {
            Text(name).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
                .help(help ?? "")
            Text(value ?? Formatters.missing)
                .font(mono ? .caption.monospaced() : .callout)
                .foregroundStyle(value == nil ? .tertiary : .primary)
                .lineLimit(3)
                .help(value.map { help ?? $0 } ?? missing ?? "Not recorded for this session")
        }
    }

    private func linkRow(_ label: String, id: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Button(model.runLabel(of: id)) { model.openSession(id) }
                .buttonStyle(.link)
                .lineLimit(1)
                .help("Open \(id)")
        }
        .font(.callout)
    }

    private func childrenSection(_ children: [SessionRow]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Subagents (\(Formatters.count(children.count)))").font(.subheadline.weight(.semibold))
            ForEach(children.prefix(50)) { c in
                HStack(spacing: 6) {
                    Button(c.displayTitle) { model.openSession(c.id) }
                        .buttonStyle(.link)
                        .lineLimit(1)
                        .help("Open \(c.id)")
                    Spacer(minLength: 4)
                    if c.nErrors > 0 {
                        Text(Formatters.count(c.nErrors, "error")).foregroundStyle(.red)
                    }
                    Text(c.start.map { Formatters.relative($0) } ?? "").foregroundStyle(.secondary)
                }
                .font(.callout)
            }
            if children.count > 50 {
                Text("and \(Formatters.count(children.count - 50)) more").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func sourcesSection(_ sources: [SessionDetail.Source]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Source Files").font(.subheadline.weight(.semibold))
            ForEach(sources) { src in
                Button {
                    AppKitHelpers.revealInFinder(src.path)
                } label: {
                    Text((src.path as NSString).lastPathComponent).lineLimit(1).truncationMode(.middle)
                }
                .buttonStyle(.link)
                .font(.caption.monospaced())
                .help("\(src.path)\n\(src.kind). Click to reveal it in Finder.")
            }
        }
    }

    private func load(_ id: String) async {
        guard let api = model.engine.api else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await api.session(id)
            guard !Task.isCancelled else { return }
            detail = d
            error = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            detail = nil
            self.error = error as? APIError ?? .unreachable(error)
        }
    }
}
