import AppKit
import SwiftUI

/// Settings (⌘,), MAC-SPEC §10, DESIGN.md §7.17: a toolbar-style tab bar with an SF Symbol and a word per tab; each pane
/// sizes to its content.
struct SettingsView: View {
    enum Tab: Hashable { case general, sources, appearance, alerts, coloringRules }

    let app: AppModel
    /// The open tab; `--snapshot` opens Alerts.
    @State var tab: Tab = .general

    var body: some View {
        // One child per tab (not a ForEach), so the Settings scene draws its toolbar-style tab bar.
        TabView(selection: $tab) {
            Self.pane(.general, app: app).tabItem { Label("General", systemImage: "gearshape") }.tag(Tab.general)
            Self.pane(.sources, app: app).tabItem { Label("Sources", systemImage: "externaldrive.connected.to.line.below") }.tag(Tab.sources)
            Self.pane(.appearance, app: app).tabItem { Label("Appearance", systemImage: "textformat.size") }.tag(Tab.appearance)
            Self.pane(.alerts, app: app).tabItem { Label("Alerts", systemImage: "bell") }.tag(Tab.alerts)
            Self.pane(.coloringRules, app: app).tabItem { Label("Coloring Rules", systemImage: "paintpalette") }.tag(Tab.coloringRules)
        }
    }

    /// The content of one tab.
    @ViewBuilder static func pane(_ tab: Tab, app: AppModel) -> some View {
        switch tab {
        case .general: GeneralSettingsView(app: app, prefs: app.preferences)
        case .sources: SourcesSettingsView(app: app, prefs: app.preferences)
        case .appearance: AppearanceSettingsView(prefs: app.preferences)
        case .alerts: AlertsSettingsView(app: app, prefs: app.preferences)
        case .coloringRules: ColoringRulesSettingsView(app: app, rules: app.colorRules)
        }
    }
}

// MARK: - General

struct GeneralSettingsView: View {
    let app: AppModel
    @Bindable var prefs: Preferences
    @State private var nodeStatus = "Checking…"
    @State private var launchAtLogin = false
    @State private var engineSettingsChanged = false

    var body: some View {
        Form {
            Section {
                PathSetting(title: "Engine source:", path: $prefs.engineSourcePath, placeholder: "Automatic",
                            chooseTitle: "Choose the AgentShark engine folder", directories: true)
                Text(engineSourceNote).font(.callout).foregroundStyle(.secondary)
                PathSetting(title: "Index location:", path: $prefs.indexLocation, placeholder: "~/.agentshark (default)",
                            chooseTitle: "Choose the folder for the AgentShark index (AGENTSHARK_HOME)", directories: true)
                PathSetting(title: "Node binary:", path: $prefs.nodeOverridePath, placeholder: "Automatic",
                            chooseTitle: "Choose a Node.js binary (version 24.12 or later)", directories: false)
                Text(nodeStatus).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                HStack {
                    Text(engineSettingsChanged ? "Restart the engine to use the new settings." : "Changes take effect when the engine restarts.")
                        .font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button("Restart Engine") {
                        app.restartLiveEngine()
                        engineSettingsChanged = false
                    }
                }
            } header: {
                Text("Engine")
            }
            Section {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in
                        if prefs.launchAtLogin != on { prefs.launchAtLogin = on }
                    }
                Picker("Default workspace:", selection: $prefs.defaultWorkspace) {
                    ForEach(prefs.workspaceOrder) { Text($0.title).tag($0) }
                }
                Toggle("Classic workspace order (Events first)", isOn: $prefs.classicOrder)
                Text("Failures is ⌘1 and Events ⌘2. The classic order keeps Events at ⌘1 for this release.")
                    .font(.callout).foregroundStyle(.secondary)
            } header: {
                Text("Startup")
            }
        }
        .formStyle(.grouped)
        .frame(width: 600)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear { launchAtLogin = prefs.launchAtLogin }
        .task(id: prefs.nodeOverridePath) { await checkNode() }
        .onChange(of: prefs.engineSourcePath) { engineSettingsChanged = true }
        .onChange(of: prefs.indexLocation) { engineSettingsChanged = true }
        .onChange(of: prefs.nodeOverridePath) { engineSettingsChanged = true }
    }

    /// What the engine source resolves to; the chosen folder's path is shown once, in its field (Principle 2).
    private var engineSourceNote: String {
        if let bundled = EngineSource.bundled { return "Using the engine bundled with the app (\((bundled.path as NSString).abbreviatingWithTildeInPath))." }
        if !prefs.engineSourcePath.isEmpty, !EngineSource.isEngineRoot(URL(fileURLWithPath: (prefs.engineSourcePath as NSString).expandingTildeInPath)) {
            return "This folder does not contain an AgentShark engine entry point."
        }
        guard let url = EngineSource.resolve(settingsPath: prefs.engineSourcePath) else { return "No engine found." }
        return prefs.engineSourcePath.isEmpty ? "Found \((url.path as NSString).abbreviatingWithTildeInPath)." : "The folder contains the engine."
    }

    private func checkNode() async {
        nodeStatus = "Checking…"
        let override = prefs.nodeOverrideURL
        let result = await Task.detached(priority: .userInitiated) { NodeLocator.locate(override: override) }.value
        switch result {
        case .success(let node): nodeStatus = "Using Node.js \(node.version) at \(node.url.path)."
        case .failure(let e): nodeStatus = [e.localizedDescription, e.recoverySuggestion].compactMap { $0 }.joined(separator: " ")
        }
    }
}

/// A path with Choose… and Clear, shown abbreviated with a tilde.
struct PathSetting: View {
    let title: String
    @Binding var path: String
    let placeholder: String
    let chooseTitle: String
    let directories: Bool

    var body: some View {
        LabeledContent(title) {
            HStack(spacing: 6) {
                Text(path.isEmpty ? placeholder : (path as NSString).abbreviatingWithTildeInPath)
                    .foregroundStyle(path.isEmpty ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(path)
                Spacer(minLength: 8)
                Button("Choose…", action: choose)
                if !path.isEmpty {
                    Button {
                        path = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill").symbolRenderingMode(.hierarchical)
                    }
                    .buttonStyle(.borderless)
                    .iconHelp("Use the default")
                }
            }
        }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.message = chooseTitle
        panel.canChooseDirectories = directories
        panel.canChooseFiles = !directories
        panel.canCreateDirectories = directories
        panel.allowsMultipleSelection = false
        panel.treatsFilePackagesAsDirectories = true
        if !path.isEmpty { panel.directoryURL = URL(fileURLWithPath: (path as NSString).expandingTildeInPath) }
        panel.begin { response in
            if response == .OK, let url = panel.url { path = url.path }
        }
    }
}

// MARK: - Appearance

struct AppearanceSettingsView: View {
    @Bindable var prefs: Preferences

    var body: some View {
        Form {
            Section {
                Picker("Appearance:", selection: $prefs.appearance) {
                    ForEach(Preferences.AppearanceChoice.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                Text("System follows the Mac's light or dark setting. View ▸ Appearance changes it too.")
                    .font(.callout).foregroundStyle(.secondary)
            } header: {
                Text("Theme")
            }
            Section {
                Picker("Row density:", selection: $prefs.rowDensity) {
                    Text("Compact (22 pt rows)").tag(Preferences.RowDensity.compact)
                    Text("Comfortable (26 pt rows, larger text)").tag(Preferences.RowDensity.comfortable)
                }
                .pickerStyle(.radioGroup)
                Text("Comfortable adds 1 pt to every text size in tables, lists and panes.")
                    .font(.callout).foregroundStyle(.secondary)
            } header: {
                Text("Density")
            }
            Section {
                Picker("Time column format:", selection: $prefs.timeFormat) {
                    ForEach(TimeFormat.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Text("The default for the Time column in new windows. View ▸ Time Column Format changes the current window. Local times are in the zone that Times in the scope bar names (now \(Formatters.offsetLabel())).")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } header: {
                Text("Time")
            }
            Section {
                Toggle("Collapse idle gaps", isOn: $prefs.collapseIdleGaps)
                Stepper(value: $prefs.idleGapMinutes, in: 1...240) {
                    LabeledContent("Idle gap threshold:", value: "\(prefs.idleGapMinutes) min")
                }
                .disabled(!prefs.collapseIdleGaps)
                Text("Gaps longer than the threshold shrink to a short break marker that shows their length.")
                    .font(.callout).foregroundStyle(.secondary)
            } header: {
                Text("Timeline")
            }
        }
        .formStyle(.grouped)
        .frame(width: 600)
        .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Alerts

/// Settings ▸ Alerts (MAC-CONTRACT §5.6): notifications for the two alarms whose offline replay was precise, and the
/// thresholds of the live index, which every reader shares.
struct AlertsSettingsView: View {
    let app: AppModel
    @Bindable var prefs: Preferences

    var body: some View {
        Form {
            Section {
                Toggle("Notify me about alarms in live runs", isOn: $prefs.notificationsEnabled)
                    .onChange(of: prefs.notificationsEnabled) { _, on in
                        prefs.notificationsOffered = true
                        if on { AppNotifications.shared.requestAuthorization() }
                    }
                ForEach(AlarmKind.notifying, id: \.self) { kind in
                    Toggle(Self.title(kind), isOn: Binding(get: { !prefs.mutedAlarmKinds.contains(kind.rawValue) }, set: { on in
                        if on { prefs.mutedAlarmKinds.remove(kind.rawValue) } else { prefs.mutedAlarmKinds.insert(kind.rawValue) }
                    }))
                    .padding(.leading, 18)
                    .disabled(!prefs.notificationsEnabled)
                }
                Text("Only these two alarms notify. The others (loops, blind loops, stalls, silent children) show as badges in Failures and the sidebar. Clicking a notification opens the observed chain with the Live mark.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } header: {
                Text("Notifications")
            }
            ThresholdsSection(app: app)
        }
        .formStyle(.grouped)
        .frame(width: 600)
        .fixedSize(horizontal: false, vertical: true)
    }

    static func title(_ k: AlarmKind) -> String {
        k == .consecutive ? "Consecutive failures" : k == .blocker ? "Blocked by the environment" : k.rawValue
    }

    static func minutes(_ m: Double) -> String {
        m == m.rounded() ? "\(Int(m)) min" : String(format: "%.1f min", m)
    }
}

/// The live index's alarm thresholds (SPEC §12.3.9 "Thresholds are settings"). They belong to the index, so a change
/// applies to the app, the web viewer, the CLI and MCP alike, and re-derives every session (`PUT
/// /api/settings/alarm-thresholds`). A capture keeps the thresholds it was written with.
struct ThresholdsSection: View {
    let app: AppModel
    @State private var draft: AlarmThresholds?
    @State private var applying = false
    @State private var message: (text: String, isError: Bool)?

    private var current: AlarmThresholds? { app.info?.analysis?.alarmThresholds }
    private var isCapture: Bool { app.info?.mode == "capture" }

    var body: some View {
        Section {
            if let current {
                let d = Binding(get: { draft ?? current }, set: { draft = $0 })
                ThresholdRow(title: "Consecutive failures:", value: d.consecutive, range: 2...50, suffix: "with no successful call between them")
                ThresholdRow(title: "Blocked by environment:", value: d.blocker, range: 1...20, suffix: "sandbox, policy or network failures in one turn")
                ThresholdRow(title: "Stall:", value: Self.wholeMinutes(d.stallMin), range: 1...240, prefix: "no event for", suffix: "min")
                ThresholdRow(title: "Alarm window:", value: Self.wholeMinutes(d.windowMin), range: 1...240, prefix: "an open alarm expires after",
                             suffix: "min without writes")
                HStack {
                    if let message {
                        Label(message.text, systemImage: message.isError ? "exclamationmark.triangle" : "checkmark.circle")
                            .foregroundStyle(message.isError ? Theme.warn.swiftUI : .secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button("Restore Defaults") { draft = .defaults }
                        .disabled(d.wrappedValue == .defaults)
                    Button(applying ? "Applying…" : "Apply") { apply(d.wrappedValue) }
                        .disabled(isCapture || applying || d.wrappedValue == current || app.liveStore.api == nil)
                }
                .disabled(isCapture)
            } else {
                Text("The engine has not reported its thresholds (it predates the analysis, or is not running).").foregroundStyle(.secondary)
            }
            Text(isCapture
                 ? "A capture keeps the thresholds it was written with."
                 : "Thresholds are a setting of the index, shared by the app, the web viewer, the CLI and MCP. Applying them re-derives every session, so alarms change after the next index run.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        } header: {
            Text("Thresholds")
        }
        .onChange(of: current) { _, _ in if !applying { draft = nil } }
    }

    /// A minutes threshold edited in whole minutes.
    private static func wholeMinutes(_ m: Binding<Double>) -> Binding<Int> {
        Binding(get: { Int(m.wrappedValue.rounded()) }, set: { m.wrappedValue = Double($0) })
    }

    private func apply(_ t: AlarmThresholds) {
        guard let api = app.liveStore.api else { return }
        applying = true
        message = nil
        Task {
            defer { applying = false }
            do {
                _ = try await api.setAlarmThresholds(t)
                message = ("Applied. Alarms are re-derived in the next index run.", false)
                draft = nil
                app.liveStore.refreshInfo()
            } catch let e as APIError {
                message = (e.isNotServed || e.status == 404 ? "This engine cannot change thresholds yet." : e.message, true)
            } catch {
                message = (error.localizedDescription, true)
            }
        }
    }
}

/// A threshold: its label, then the number in a small field with its stepper beside it, inside the sentence it
/// completes ("Consecutive failures: [6] with no successful call between them"), as Apple's settings pair a stepper
/// with its field.
private struct ThresholdRow: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    var prefix: String?
    let suffix: String

    var body: some View {
        LabeledContent(title) {
            HStack(spacing: 4) {
                if let prefix { Text(prefix).foregroundStyle(.secondary) }
                TextField(title, value: $value, format: .number)
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    .frame(width: 44)
                    .onSubmit { value = min(max(value, range.lowerBound), range.upperBound) }
                Stepper(title, value: $value, in: range).labelsHidden()
                Text(suffix).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
