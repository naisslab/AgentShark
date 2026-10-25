import AppKit
import SwiftUI

/// What the window shows instead of a workspace before there is data to show (SPEC §7.8 empty states).
enum OnboardingGate: Equatable {
    /// The engine is locating Node, starting, restarting or stopped.
    case engine
    /// The first index run is in progress and nothing is indexed yet.
    case firstIndex
    /// No supported logs were found.
    case noSources
    /// Files were found but no events were indexed.
    case noEvents
    /// The capture holds no events.
    case emptyCapture

    /// Sources and Diagnostics stay reachable whenever the engine runs.
    @MainActor static func gate(for model: WindowModel) -> OnboardingGate? {
        guard model.engine.api != nil else { return .engine }
        guard let info = model.info, info.counts.events == 0, model.workspace != .sources, model.workspace != .diagnostics else { return nil }
        if info.isCapture { return .emptyCapture }
        if model.store.indexing != nil || info.indexing.running { return .firstIndex }
        return info.counts.sources == 0 ? .noSources : .noEvents
    }
}

struct OnboardingView: View {
    @Bindable var model: WindowModel
    let gate: OnboardingGate

    var body: some View {
        Group {
            switch gate {
            case .engine: EngineOnboarding(model: model)
            case .firstIndex: FirstIndexView(model: model)
            case .noSources:
                emptyState("No supported logs found", symbol: "tray",
                           text: "No supported logs were found in the locations checked. Sources lists where AgentShark looked and which agents it supports.",
                           action: "Open Sources") { model.workspace = .sources }
            case .noEvents:
                emptyState("No readable events", symbol: "doc.questionmark",
                           text: "Found files, but no readable events were indexed. Diagnostics lists the records that could not be read.",
                           action: "Open Diagnostics") { model.workspace = .diagnostics }
            case .emptyCapture:
                emptyState("Empty Capture", symbol: "doc.zipper",
                           text: "This capture contains no indexed events. Sources shows what the capture recorded about itself.",
                           action: "Show Capture Details") { model.workspace = .sources }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func emptyState(_ title: String, symbol: String, text: String, action: String, perform: @escaping () -> Void) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(text)
        } actions: {
            Button(action, action: perform).keyboardShortcut(.defaultAction)
            if gate == .noSources { SettingsLink { Text("Choose Source Folders…") } }
            if !model.isCapture { Button("Reindex Now") { model.store.reindex() } }
        }
    }
}

/// The engine is not running: locating Node, starting, restarting, or stopped with its log and Choose Node….
struct EngineOnboarding: View {
    @Bindable var model: WindowModel

    var body: some View {
        switch model.engine.status {
        case .failed(let message):
            failed(message)
        case .restarting(let attempt):
            progress("Restarting the engine", detail: "Attempt \(attempt) of \(EngineProcess.maxRestarts). The last known sessions stay in the sidebar.")
        case .locatingNode:
            progress("Preparing AgentShark", detail: "Starting the bundled analysis engine.")
        default:
            progress(model.isCapture ? "Opening the capture" : "Starting the engine",
                     detail: model.isCapture ? "Loading \(model.engine.captureURL?.lastPathComponent ?? "the capture") into its own index."
                         : "The sidebar shows the last known sessions until the engine answers.")
        }
    }

    private func progress(_ title: String, detail: String) -> some View {
        VStack(spacing: 10) {
            ProgressView().controlSize(.regular)
            Text(title).font(.title3.weight(.semibold))
            Text(detail).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 420)
        }
        .accessibilityElement(children: .combine)
    }

    private func failed(_ message: String) -> some View {
        let nodeProblem = model.engine.nodeProblem
        return VStack(alignment: .leading, spacing: 14) {
            Label(nodeProblem == nil ? "The Engine Stopped" : "The Runtime Is Unavailable", systemImage: nodeProblem == nil ? "bolt.horizontal.circle" : "shippingbox")
                .font(.title2.weight(.semibold))
            Text(message).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if let nodeProblem {
                Text(nodeProblem.recoverySuggestion ?? "").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !model.engine.logTail.isEmpty {
                DisclosureGroup("Engine Log") {
                    ScrollView {
                        Text(model.engine.logTail.suffix(40).joined(separator: "\n"))
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(6)
                    }
                    .defaultScrollAnchor(.bottom)
                    .frame(height: 160)
                    .background(Color(nsColor: .textBackgroundColor))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color(nsColor: .separatorColor)))
                }
            }
            HStack {
                Button("Choose Node…", action: chooseNode)
                Button("Restart Engine") { restart() }.keyboardShortcut(.defaultAction)
                Spacer()
                SettingsLink { Text("Settings…") }
            }
        }
        .padding(24)
        .frame(maxWidth: 560)
    }

    private func restart() {
        if model.isCapture { model.engine.restart() } else { model.app.restartLiveEngine() }
    }

    /// Pick a Node binary for the engine (saved in Settings ▸ General).
    private func chooseNode() {
        let panel = NSOpenPanel()
        panel.title = "Choose Node.js"
        panel.message = "Choose a Node.js binary, version \(NodeLocator.minimumMajor) or later."
        panel.prompt = "Choose"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.treatsFilePackagesAsDirectories = true
        panel.directoryURL = URL(fileURLWithPath: "/opt/homebrew/bin")
        guard let window = NSApp.keyWindow else { return }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            model.app.preferences.nodeOverridePath = url.path
            restart()
        }
    }
}

/// First run: the initial index is being built.
struct FirstIndexView: View {
    @Bindable var model: WindowModel

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "square.stack.3d.down.forward")
                .font(.system(size: 36))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Indexing Your Agent Logs").font(.title2.weight(.semibold))
            Text("AgentShark reads the logs that coding agents keep on this Mac, newest first: sessions being written now appear within seconds, and older history fills in behind them. Later runs only read what changed.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
            if let i = model.store.indexing {
                VStack(spacing: 4) {
                    ProgressView(value: Double(i.done), total: Double(max(1, i.total)))
                        .frame(width: 340)
                    Text("\(Formatters.count(i.done)) of \(Formatters.count(i.total)) files")
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                    if let path = i.path {
                        Text(path).font(.caption.monospaced()).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle).frame(maxWidth: 460)
                    }
                }
            } else {
                ProgressView().controlSize(.small)
            }
            if !agentCounts.isEmpty {
                HStack(spacing: 18) {
                    ForEach(agentCounts, id: \.agent) { row in
                        VStack(spacing: 2) {
                            Image(systemName: Symbols.agent(row.agent)).foregroundStyle(Color(nsColor: Theme.agentColor(row.agent)))
                            Text(row.agent.label).font(.caption)
                            Text(Formatters.count(row.sessions, "session")).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            Button("Open Sources") { model.workspace = .sources }
                .help("See which agents and folders are being indexed")
        }
        .padding(24)
    }

    private var agentCounts: [(agent: AgentKind, sessions: Int)] {
        Dictionary(grouping: model.sessions, by: \.agent).map { ($0.key, $0.value.count) }.sorted { $0.sessions > $1.sessions }
    }
}
