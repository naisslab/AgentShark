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

    var body: some View {
        Form {
            Section("Folders to Read") {
                Toggle("Automatically find agent logs on this Mac", isOn: $locations.autoDiscover)
                Text("Claude Code and Codex logs are found automatically. Add another .claude or .codex folder for archived or external logs.")
                    .font(.callout).foregroundStyle(.secondary)
                rootRows("Claude Code", roots: $locations.claudeRoots)
                rootRows("Codex", roots: $locations.codexRoots)
                HStack {
                    Button("Add Claude Folder…") { chooseFolder(claude: true) }
                    Button("Add Codex Folder…") { chooseFolder(claude: false) }
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

    private func chooseFolder(claude: Bool) {
        let panel = NSOpenPanel()
        panel.title = claude ? "Choose a Claude Code Data Folder" : "Choose a Codex Data Folder"
        panel.message = claude ? "Select the .claude folder containing projects." : "Select the .codex folder containing sessions or archived_sessions."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.showsHiddenFiles = true
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        let names = claude ? ["projects"] : ["sessions", "archived_sessions"]
        guard names.contains(where: { FileManager.default.fileExists(atPath: folder.appendingPathComponent($0).path) }) else {
            sourceError = "This folder has no \(names.joined(separator: " or ")) directory. Choose the agent's data folder."
            return
        }
        if claude { if !locations.claudeRoots.contains(folder.path) { locations.claudeRoots.append(folder.path) } }
        else { if !locations.codexRoots.contains(folder.path) { locations.codexRoots.append(folder.path) } }
        sourceSaved = false
        sourceError = nil
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
