import AppKit
import SwiftUI

/// File ▸ Export Capture (⇧⌘E): write sessions to a self-contained `.agentcap` file with
/// `agentshark capture … --progress json`, with a determinate progress bar, Stop, and Reveal in Finder.
struct ExportCaptureSheet: View {
    @Bindable var model: WindowModel
    @Environment(\.dismiss) private var dismiss
    @State private var job: CaptureExportJob
    @State private var scope: ExportScope
    @State private var agents: Set<AgentKind> = Set(AgentKind.known)
    @State private var since: Date
    @State private var until: Date
    @State private var compression: CaptureCompression = .zstd
    @State private var includeRaw = true
    @State private var includeSidecars = true
    @State private var profile = "forensic"
    @State private var lastOptions: CaptureExportJob.Options?
    @State private var saveError: String?

    enum ExportScope: String, CaseIterable, Identifiable {
        case session, view, timeRange, all
        var id: String { rawValue }

        var title: String {
            switch self {
            case .session: return "Current session"
            case .view: return "Current view"
            case .timeRange: return "Time range"
            case .all: return "All sessions"
            }
        }
    }

    init(model: WindowModel) {
        _model = Bindable(model)
        _job = State(initialValue: CaptureExportJob(preferences: model.app.preferences))
        let s = model.scope
        _scope = State(initialValue: s.sessions.count == 1 ? .session : (!s.isEmpty || !model.appliedFilter.isEmpty) ? .view : .all)
        let now = Date()
        _since = State(initialValue: s.from.map { Date(timeIntervalSince1970: Double($0) / 1e6) } ?? now.addingTimeInterval(-7 * 86400))
        _until = State(initialValue: s.to.map { Date(timeIntervalSince1970: Double($0) / 1e6) } ?? now)
    }

    private var isBusy: Bool { job.isRunning }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Export Capture").font(.headline).padding([.horizontal, .top], 20)
            Form {
                Section {
                    Picker("Sessions", selection: $scope) {
                        ForEach(ExportScope.allCases) { s in
                            Text(s.title).tag(s).disabled(s == .session && model.focusedSessionID == nil)
                        }
                    }
                    .pickerStyle(.radioGroup)
                    Text(scopeDescription)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if scope == .timeRange {
                        DatePicker("Since", selection: $since, in: ...until, displayedComponents: [.date, .hourAndMinute])
                        DatePicker("Until", selection: $until, in: since..., displayedComponents: [.date, .hourAndMinute])
                        Text("Sessions active in this range, in \(Formatters.utcOffset()). Whole sessions are exported.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if scope != .session {
                        LabeledContent("Agents") {
                            HStack(spacing: 12) {
                                ForEach(AgentKind.known, id: \.self) { agent in
                                    Toggle(agent.label, isOn: Binding(get: { agents.contains(agent) },
                                                                      set: { if $0 { agents.insert(agent) } else { agents.remove(agent) } }))
                                        .toggleStyle(.checkbox)
                                }
                            }
                        }
                    }
                }
                Section {
                    Picker("Capture profile", selection: $profile) {
                        Text("Forensic (full evidence)").tag("forensic")
                        Text("Shareable (structure only)").tag("shareable")
                    }
                    Picker("Compression", selection: $compression) {
                        ForEach(CaptureCompression.allCases) { Text($0.title).tag($0) }
                    }
                    Toggle("Include original source lines", isOn: $includeRaw)
                        .disabled(profile == "shareable")
                    Toggle("Include side files", isOn: $includeSidecars)
                        .disabled(profile == "shareable")
                        .help("Persisted tool outputs, workflow and subagent metadata")
                } footer: {
                    Text(contentsNote)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .formStyle(.grouped)
            .disabled(isBusy)
            progress
                .padding(.horizontal, 20)
            buttons
                .padding(20)
        }
        .frame(width: 560)
        .onDisappear { if job.isRunning { job.cancel() } }
        .onChange(of: job.state) { _, state in
            // A stopped export leaves an incomplete file behind; it is not a capture.
            if state == .cancelled, let url = lastOptions?.output { try? FileManager.default.removeItem(at: url) }
        }
    }

    // MARK: Text

    private var scopeDescription: String {
        switch scope {
        case .session:
            guard let id = model.focusedSessionID else { return "Select one session in the sidebar to export it." }
            return "“\(model.store.title(of: id))” and its subagents."
        case .view:
            var parts: [String] = []
            if !model.scope.sessions.isEmpty { parts.append("the \(Formatters.count(model.scope.sessions.count, "selected session")) and their subagents") }
            if model.scope.hasTimeRange { parts.append("sessions active \(Formatters.timeRange(from: model.scope.from, to: model.scope.to))") }
            var text = parts.isEmpty ? "All sessions" : parts.joined(separator: ", limited to ").capitalizedFirst
            if !model.appliedFilter.isEmpty { text += ", keeping only sessions with at least one event that matches the filter" }
            return text + ". A capture always holds whole sessions."
        case .timeRange:
            return "Every session that was active between the two times."
        case .all:
            return "Every indexed session. This can be a large file."
        }
    }

    private var contentsNote: String {
        if profile == "shareable" {
            return "The shareable profile removes trace free text, raw lines and side files, and pseudonymizes identities. It preserves structural analysis with explicit data-loss metadata. Review the exported result before sharing."
        }
        var text = "A capture contains prompts, answers, tool inputs and outputs, file paths and session metadata. It is not redacted; review it before you share it."
        if !includeRaw { text += " Without the original source lines it is smaller, but raw bytes cannot be shown; normalized text is still included." }
        return text
    }

    // MARK: Progress and result

    @ViewBuilder private var progress: some View {
        switch job.state {
        case .idle:
            EmptyView()
        case .running(let done, let total):
            VStack(alignment: .leading, spacing: 4) {
                if total > 0 {
                    ProgressView(value: Double(done), total: Double(max(total, done)))
                    Text("Writing session \(Formatters.count(done)) of \(Formatters.count(total))…")
                } else {
                    ProgressView()
                        .progressViewStyle(.linear)
                    Text("Preparing the capture…")
                }
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        case .finished(let path, let bytes):
            Label {
                Text("Exported \(bytes.map { Formatters.bytes($0) + " " } ?? "")to \((path as NSString).lastPathComponent).")
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.ok.swiftUI)
            }
            .textSelection(.enabled)
        case .failed(let message):
            Label {
                Text("The export failed. \(message)").textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.err.swiftUI)
            }
        case .cancelled:
            Label("Export stopped. The incomplete file was removed.", systemImage: "stop.circle")
                .foregroundStyle(.secondary)
        }
        if let saveError {
            Text(saveError).foregroundStyle(Theme.err.swiftUI).font(.callout)
        }
    }

    @ViewBuilder private var buttons: some View {
        HStack {
            if case .finished(let path, _) = job.state {
                Button("Reveal in Finder") { AppKitHelpers.revealInFinder(path) }
            }
            Spacer()
            if isBusy {
                Button("Stop Export") { job.cancel() }
                    .keyboardShortcut(.cancelAction)
            } else if case .finished = job.state {
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            } else {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(job.state == .idle ? "Export…" : "Export Again…") { chooseDestination() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canExport)
            }
        }
    }

    private var canExport: Bool {
        switch scope {
        case .session: return model.focusedSessionID != nil
        case .timeRange: return !agents.isEmpty && since < until
        default: return !agents.isEmpty
        }
    }

    // MARK: Export

    private var defaultName: String {
        let c = Formatters.components(Int64(Date().timeIntervalSince1970 * 1e6), zone: Formatters.timeZone)
        let date = String(format: "%04d-%02d-%02d", c.year, c.month, c.day)
        var base = "AgentShark Capture \(date)"
        if scope == .session, let id = model.focusedSessionID {
            let title = model.store.title(of: id).components(separatedBy: CharacterSet(charactersIn: "/:\\\n")).joined(separator: " ")
            base = "\(title.prefix(60).trimmingCharacters(in: .whitespaces)) \(date)"
        }
        return base + compression.suffix
    }

    private func chooseDestination() {
        saveError = nil
        let panel = NSSavePanel()
        panel.title = "Export Capture"
        panel.prompt = "Export"
        panel.nameFieldLabel = "Export As:"
        panel.nameFieldStringValue = defaultName
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        let handler: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK, let chosen = panel.url else { return }
            let url = compression.normalize(chosen)
            if url != chosen, FileManager.default.fileExists(atPath: url.path) {
                saveError = "“\(url.lastPathComponent)” already exists. Choose another name."
                return
            }
            start(url)
        }
        if let window = NSApp.keyWindow {
            panel.beginSheetModal(for: window, completionHandler: handler)
        } else {
            panel.begin(completionHandler: handler)
        }
    }

    private func start(_ url: URL) {
        var o = CaptureExportJob.Options(output: url, includeRaw: includeRaw, includeSidecars: includeSidecars)
        o.profile = profile
        var filters: [String] = []
        switch scope {
        case .session:
            o.sessions = model.focusedSessionID.map { [$0] } ?? []
        case .view:
            o.sessions = model.scope.sessions
            o.since = model.scope.from
            o.until = model.scope.to
            if !model.appliedFilter.isEmpty { filters.append(model.appliedFilter) }
        case .timeRange:
            o.since = Int64(since.timeIntervalSince1970 * 1e6)
            o.until = Int64(until.timeIntervalSince1970 * 1e6)
        case .all:
            break
        }
        // The capture job has no agent option; `agent in {…}` selects the same whole sessions.
        if scope != .session, agents.count < AgentKind.known.count {
            filters.append("agent in {\(agents.sorted().map { FilterExpression.quote($0.rawValue) }.joined(separator: ", "))}")
        }
        o.filter = filters.count > 1 ? filters.map { "(\($0))" }.joined(separator: " && ") : filters.first
        lastOptions = o
        job.start(o)
    }
}

/// Capture compression, chosen through the file extension (the CLI infers it from the name).
enum CaptureCompression: String, CaseIterable, Identifiable {
    case zstd, gzip, none
    var id: String { rawValue }

    var title: String {
        switch self {
        case .zstd: return "Zstandard (.agentcap.zst)"
        case .gzip: return "Gzip (.agentcap.gz)"
        case .none: return "None (.agentcap)"
        }
    }

    var suffix: String {
        switch self {
        case .zstd: return ".agentcap.zst"
        case .gzip: return ".agentcap.gz"
        case .none: return ".agentcap"
        }
    }

    /// The URL with exactly this compression's suffix.
    func normalize(_ url: URL) -> URL {
        var name = url.lastPathComponent
        for s in [".agentcap.zst", ".agentcap.gz", ".agentcap", ".zst", ".gz"] where name.lowercased().hasSuffix(s) {
            name.removeLast(s.count)
            break
        }
        return url.deletingLastPathComponent().appendingPathComponent(name + suffix)
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
