import SwiftUI
import AppKit

/// Settings ▸ Sources: which agents the sidebar lists, and the roots the engine discovered.
struct SourcesSettingsView: View {
    let app: AppModel
    @Bindable var prefs: Preferences
    @State private var phase: Phase = .loading
    @State private var locations = SourceLocations()
    @State private var sourceError: String?
    @State private var sourceSaved = false
    @State private var canSaveSources = false

    enum Phase {
        case loading
        case failed(APIError)
        case ready([HealthReport])
    }

    private enum SourceTarget: CaseIterable, Identifiable {
        case claude, codex, antigravity, gemini, deepseek
        var id: Self { self }

        var menuLabel: String {
            switch self {
            case .claude: return "Claude Code (.claude)…"
            case .codex: return "Codex (.codex)…"
            case .antigravity: return "Antigravity (.gemini/antigravity)…"
            case .gemini: return "Gemini (.gemini or VegaTrajectoryArchives)…"
            case .deepseek: return "DeepSeek Harness (.dsh)…"
            }
        }

        var panelTitle: String {
            switch self {
            case .claude: return "Choose a Claude Code Data Folder"
            case .codex: return "Choose a Codex Data Folder"
            case .antigravity: return "Choose an Antigravity Data Folder"
            case .gemini: return "Choose a Gemini Data Folder"
            case .deepseek: return "Choose a DeepSeek Harness Data Folder"
            }
        }

        var panelMessage: String {
            switch self {
            case .claude: return "Select the .claude folder containing projects."
            case .codex: return "Select the .codex folder containing sessions or archived_sessions."
            case .antigravity: return "Select .gemini/antigravity (or a folder containing conversations or brain)."
            case .gemini: return "Select .gemini (containing tmp or antigravity) or a VegaTrajectoryArchives folder."
            case .deepseek: return "Select the .dsh folder containing sessions (or a workspace/session folder)."
            }
        }
    }

    var body: some View {
        Form {
            Section("Folders to Read") {
                Toggle("Automatically find agent logs on this Mac", isOn: $locations.autoDiscover)
                Text("Logs from Claude, Codex, Copilot, Antigravity, Gemini and DeepSeek Harness are found automatically on this Mac. Add extra folders for archived or external data roots.")
                    .font(.callout).foregroundStyle(.secondary)
                rootRows("Claude Code", roots: $locations.claudeRoots)
                rootRows("Codex", roots: $locations.codexRoots)
                rootRows("Antigravity", roots: $locations.antigravityRoots)
                rootRows("Gemini", roots: $locations.geminiRoots)
                rootRows("DeepSeek", roots: $locations.deepseekRoots)
                HStack {
                    Menu("Add Agent Folder…") {
                        ForEach(SourceTarget.allCases) { target in
                            Button(target.menuLabel) { chooseFolder(for: target) }
                        }
                    }
                    .fixedSize()
                    Spacer()
                    Button("Apply & Reindex") { saveSources() }.disabled(!canSaveSources)
                }
                if let sourceError { Label(sourceError, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
                if sourceSaved { Text("Source folders saved. The engine is restarting and indexing them.").font(.callout).foregroundStyle(.secondary) }
            }
            Section {
                ForEach(AgentKind.known, id: \.self) { agent in
                    Toggle(isOn: Binding(get: { !prefs.hiddenAgents.contains(agent.rawValue) },
                                         set: { show in
                                             if show { prefs.hiddenAgents.remove(agent.rawValue) } else { prefs.hiddenAgents.insert(agent.rawValue) }
                                         })) {
                        Label {
                            Text(agent.label)
                        } icon: {
                            Image(systemName: Symbols.agent(agent)).symbolRenderingMode(.hierarchical)
                                .foregroundStyle(Color(nsColor: Theme.agentColor(agent)))
                        }
                    }
                }
            } header: {
                Text("Show in Sidebar")
            } footer: {
                Text("Hidden agents are left out of the sidebar list only. Their events still appear in every view and count toward every total.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section {
                switch phase {
                case .loading:
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(app.liveEngine.api == nil ? "Waiting for the engine…" : "Reading the sources report…").foregroundStyle(.secondary)
                    }
                case .failed(let e):
                    HStack {
                        Label(e.message, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                        Spacer()
                        Button("Retry") { Task { await load() } }
                    }
                case .ready(let agents):
                    ForEach(agents) { report in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(report.label).font(.headline)
                                Spacer()
                                Text(status(report)).font(.callout).foregroundStyle(.secondary)
                            }
                            if report.roots.isEmpty {
                                Text("No locations found on this Mac.").font(.callout).foregroundStyle(.secondary)
                            }
                            ForEach(report.roots, id: \.self) { root in
                                HStack(spacing: 4) {
                                    Text((root as NSString).abbreviatingWithTildeInPath)
                                        .font(Theme.fontSwiftUI(.code))
                                        .textSelection(.enabled)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                    Spacer()
                                    Button {
                                        AppKitHelpers.revealInFinder(root)
                                    } label: {
                                        Image(systemName: "magnifyingglass.circle").symbolRenderingMode(.hierarchical)
                                    }
                                    .buttonStyle(.borderless)
                                    .iconHelp("Reveal in Finder")
                                }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            } header: {
                Text("Discovered Locations (this Mac)")
            }
        }
        .formStyle(.grouped)
        .frame(width: 660, height: 680)
        .onAppear { readSources() }
        .task(id: app.liveEngine.api == nil) { await load() }
    }

    private var configURL: URL { SourceLocations.path(indexLocation: prefs.indexLocationURL) }

    @ViewBuilder private func rootRows(_ label: String, roots: Binding<[String]>) -> some View {
        ForEach(roots.wrappedValue, id: \.self) { path in
            HStack {
                Text(label).foregroundStyle(.secondary)
                Text((path as NSString).abbreviatingWithTildeInPath).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                Spacer()
                Button("Remove", role: .destructive) { roots.wrappedValue.removeAll { $0 == path }; sourceSaved = false }
                    .buttonStyle(.borderless)
            }
            if !FileManager.default.fileExists(atPath: (path as NSString).expandingTildeInPath) {
                Text("Folder unavailable: reconnect its disk or choose another folder.").font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private func readSources() {
        do { locations = try SourceLocations.read(from: configURL); canSaveSources = true; sourceError = nil }
        catch { sourceError = "Could not read source settings: \(error.localizedDescription)"; canSaveSources = false }
    }

    private func saveSources() {
        do {
            try locations.write(to: configURL)
            sourceError = nil
            sourceSaved = true
            app.restartLiveEngine()
        } catch { sourceError = "Could not save source settings: \(error.localizedDescription)" }
    }

    private func chooseFolder(for target: SourceTarget) {
        let panel = NSOpenPanel()
        panel.title = target.panelTitle
        panel.message = target.panelMessage
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.showsHiddenFiles = true
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        if let problem = validateFolder(folder, for: target) {
            sourceError = problem
            return
        }
        let path = folder.path
        switch target {
        case .claude: if !locations.claudeRoots.contains(path) { locations.claudeRoots.append(path) }
        case .codex: if !locations.codexRoots.contains(path) { locations.codexRoots.append(path) }
        case .antigravity: if !locations.antigravityRoots.contains(path) { locations.antigravityRoots.append(path) }
        case .gemini: if !locations.geminiRoots.contains(path) { locations.geminiRoots.append(path) }
        case .deepseek: if !locations.deepseekRoots.contains(path) { locations.deepseekRoots.append(path) }
        }
        sourceSaved = false
        sourceError = nil
    }

    private func validateFolder(_ folder: URL, for target: SourceTarget) -> String? {
        let fm = FileManager.default
        let base = folder.lastPathComponent
        func hasSubdir(_ names: [String]) -> Bool {
            names.contains { fm.fileExists(atPath: folder.appendingPathComponent($0).path) }
        }
        let entries = (try? fm.contentsOfDirectory(atPath: folder.path)) ?? []
        switch target {
        case .claude:
            return hasSubdir(["projects"]) ? nil : "This folder has no projects directory. Choose a .claude data folder."
        case .codex:
            return hasSubdir(["sessions", "archived_sessions"]) ? nil : "This folder has no sessions or archived_sessions directory. Choose a .codex data folder."
        case .antigravity:
            let ok = hasSubdir(["conversations", "brain"]) || base == "conversations" || base == "brain"
            return ok ? nil : "This folder has no conversations or brain directory. Choose .gemini/antigravity (or antigravity-ide)."
        case .gemini:
            let ok = hasSubdir(["tmp", "antigravity", "chats", "VegaTrajectoryArchives"])
                || ["tmp", "chats", "VegaTrajectoryArchives"].contains(base)
                || entries.contains { ($0.hasPrefix("session-") && $0.hasSuffix(".json")) || (base == "VegaTrajectoryArchives" && $0.hasSuffix(".json")) }
            return ok ? nil : "This folder has no Gemini tmp, chats, antigravity, or VegaTrajectoryArchives logs."
        case .deepseek:
            let ok = hasSubdir(["sessions", "storages"]) || base == "sessions"
                || entries.contains { $0.hasPrefix("session") && ($0.hasSuffix(".jsonl") || $0.hasSuffix(".zstd") || $0.hasSuffix(".zst")) }
            return ok ? nil : "This folder has no DeepSeek Harness sessions directory or session.v*.jsonl.zstd files."
        }
    }

    private func status(_ r: HealthReport) -> String {
        if !r.detected { return "Not detected" }
        if !r.parsed { return "Detected, not parsed" }
        return "\(Formatters.count(r.files, "file")) · \(Formatters.bytes(r.bytes))"
    }

    private func load() async {
        guard let api = app.liveEngine.api else {
            phase = .loading
            return
        }
        phase = .loading
        do {
            phase = .ready(try await api.sources().agents)
        } catch let e as APIError {
            phase = .failed(e)
        } catch {}
    }
}
