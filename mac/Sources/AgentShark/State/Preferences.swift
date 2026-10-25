import Foundation
import Observation
import ServiceManagement

/// App settings (MAC-SPEC §10), backed by UserDefaults. `Preferences(defaults: nil)` keeps them in memory only
/// (the self-test uses that, so it never reads or writes the person's settings).
@MainActor @Observable final class Preferences {
    /// View ▸ Appearance and Settings ▸ Appearance: follow the system, or force light or dark.
    enum AppearanceChoice: String, CaseIterable, Codable, Sendable {
        case system, light, dark

        var title: String {
            switch self {
            case .system: return "System"
            case .light: return "Light"
            case .dark: return "Dark"
            }
        }
    }

    /// Compact (22 pt rows) or comfortable (26 pt rows, every type size +1): the larger-text setting (DESIGN.md §4.3).
    enum RowDensity: String, CaseIterable, Codable, Sendable {
        case compact, comfortable

        var label: String { self == .compact ? "Compact" : "Comfortable" }
        var sizeBump: CGFloat { self == .compact ? 0 : 1 }

        /// Reads the stored value; "regular" is the earlier name of comfortable.
        init?(stored: String) {
            self.init(rawValue: stored == "regular" ? "comfortable" : stored)
        }
    }

    @ObservationIgnored private let defaults: UserDefaults?

    // MARK: General

    /// Folder of the AgentShark checkout whose engine runs when the app has no bundled engine. Empty: automatic.
    var engineSourcePath: String { didSet { save(engineSourcePath, "engineSourcePath") } }
    /// AGENTSHARK_HOME for the live engine. Empty: the engine default (~/.agentshark).
    var indexLocation: String { didSet { save(indexLocation, "indexLocation") } }
    /// Node binary chosen in Settings. Empty: automatic lookup.
    var nodeOverridePath: String { didSet { save(nodeOverridePath, "nodeOverridePath") } }
    var defaultWorkspace: Workspace { didSet { save(defaultWorkspace.rawValue, "defaultWorkspace") } }
    /// "Classic workspace order" (for one release): Events stays at ⌘1 and Failures moves to ⌘2.
    var classicOrder: Bool { didSet { save(classicOrder, "classicOrder") } }
    /// End of the previous visit (µs): launch opens Failures when newer attention items exist (SPEC §12.7 Entry).
    var lastVisit: Int64? {
        didSet {
            if let v = lastVisit { save(NSNumber(value: v), "lastVisit") } else { defaults?.removeObject(forKey: "lastVisit") }
        }
    }

    // MARK: Alerts (SPEC §12.7 Notifications)

    /// Notifications are off by default and offered once.
    var notificationsEnabled: Bool { didSet { save(notificationsEnabled, "notificationsEnabled") } }
    /// The offer was answered (turned on, or Not Now).
    var notificationsOffered: Bool { didSet { save(notificationsOffered, "notificationsOffered") } }
    /// Notifying alarm kinds the person turned off (`consecutive`, `blocker`).
    var mutedAlarmKinds: Set<String> { didSet { save(Array(mutedAlarmKinds).sorted(), "mutedAlarmKinds") } }

    // MARK: Sources

    /// Agents hidden from the sidebar list. A list filter only: their events still appear in every view.
    var hiddenAgents: Set<String> { didSet { save(Array(hiddenAgents).sorted(), "hiddenAgents") } }

    // MARK: Appearance

    var appearance: AppearanceChoice { didSet { save(appearance.rawValue, "appearance") } }
    var rowDensity: RowDensity { didSet { save(rowDensity.rawValue, "rowDensity") } }
    /// Default time format for new windows.
    var timeFormat: TimeFormat { didSet { save(timeFormat.rawValue, "timeFormat") } }
    var collapseIdleGaps: Bool { didSet { save(collapseIdleGaps, "collapseIdleGaps") } }
    /// View ▸ Show Context Lane: the Timeline's optional lane of context tokens against the window (SPEC §12.7).
    var showContextLane: Bool { didSet { save(showContextLane, "showContextLane") } }
    var idleGapMinutes: Int { didSet { save(idleGapMinutes, "idleGapMinutes") } }

    // MARK: Filters

    /// Most recent first, at most 20.
    private(set) var recentFilters: [String] { didSet { save(recentFilters, "recentFilters") } }

    init(defaults: UserDefaults? = .standard) {
        self.defaults = defaults
        let d = defaults
        engineSourcePath = d?.string(forKey: "engineSourcePath") ?? ""
        indexLocation = d?.string(forKey: "indexLocation") ?? ""
        nodeOverridePath = d?.string(forKey: "nodeOverridePath") ?? ""
        defaultWorkspace = d?.string(forKey: "defaultWorkspace").flatMap { Workspace.migrate(rawValue: $0)?.0 } ?? .events
        classicOrder = d?.object(forKey: "classicOrder") as? Bool ?? false
        lastVisit = (d?.object(forKey: "lastVisit") as? NSNumber)?.int64Value
        notificationsEnabled = d?.object(forKey: "notificationsEnabled") as? Bool ?? false
        notificationsOffered = d?.object(forKey: "notificationsOffered") as? Bool ?? false
        mutedAlarmKinds = Set(d?.stringArray(forKey: "mutedAlarmKinds") ?? [])
        appearance = d?.string(forKey: "appearance").flatMap(AppearanceChoice.init(rawValue:)) ?? .system
        hiddenAgents = Set(d?.stringArray(forKey: "hiddenAgents") ?? [])
        rowDensity = d?.string(forKey: "rowDensity").flatMap(RowDensity.init(stored:)) ?? .compact
        timeFormat = d?.string(forKey: "timeFormat").flatMap(TimeFormat.init(rawValue:)) ?? .local
        collapseIdleGaps = d?.object(forKey: "collapseIdleGaps") as? Bool ?? true
        showContextLane = d?.object(forKey: "showContextLane") as? Bool ?? false
        idleGapMinutes = d?.object(forKey: "idleGapMinutes") as? Int ?? 5
        recentFilters = d?.stringArray(forKey: "recentFilters") ?? []
    }

    private func save(_ value: Any, _ key: String) {
        defaults?.set(value, forKey: key)
    }

    var metrics: Theme.Metrics { Theme.metrics(rowDensity) }

    /// The workspaces in picker and ⌘1–⌘7 order.
    var workspaceOrder: [Workspace] { Workspace.ordered(classic: classicOrder) }

    /// Whether an alarm kind may post a notification (on, a notifying kind, and not muted in Settings ▸ Alerts).
    func notifies(_ kind: AlarmKind) -> Bool {
        notificationsEnabled && AlarmKind.notifying.contains(kind) && !mutedAlarmKinds.contains(kind.rawValue)
    }

    func noteRecentFilter(_ filter: String) {
        let f = filter.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !f.isEmpty else { return }
        recentFilters = Array(([f] + recentFilters.filter { $0 != f }).prefix(20))
    }

    func clearRecentFilters() { recentFilters = [] }

    // MARK: Derived locations

    var nodeOverrideURL: URL? { nodeOverridePath.isEmpty ? nil : URL(fileURLWithPath: nodeOverridePath) }

    /// AGENTSHARK_HOME to pass to the live engine, or nil for the engine default.
    var indexLocationURL: URL? {
        indexLocation.isEmpty ? nil : URL(fileURLWithPath: (indexLocation as NSString).expandingTildeInPath)
    }

    var idleGapMicroseconds: Int64 { Int64(max(1, idleGapMinutes)) * 60_000_000 }

    // MARK: Launch at login

    var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                NSLog("AgentShark: could not change Launch at Login: \(error.localizedDescription)")
            }
        }
    }
}

// MARK: - Engine source

/// Where the compiled engine or development source entry point lives.
enum EngineSource {
    static func isEngineRoot(_ url: URL) -> Bool {
        entryPoint(in: url) != nil
    }

    static func entryPoint(in url: URL) -> URL? {
        for path in ["bin/agentshark.js", "build/bin/agentshark.js", "bin/agentshark.ts"] {
            let file = url.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: file.path) { return file }
        }
        return nil
    }

    /// The bundled engine (`Contents/Resources/backend`), when the app was built with build-app.sh.
    static var bundled: URL? {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("backend"), isEngineRoot(url) else { return nil }
        return url
    }

    /// Bundled engine, then the Settings path, then a checkout above the executable (swift run).
    static func resolve(settingsPath: String) -> URL? {
        if let bundled { return bundled }
        if !settingsPath.isEmpty {
            let url = URL(fileURLWithPath: (settingsPath as NSString).expandingTildeInPath)
            if isEngineRoot(url) { return url }
        }
        if let found = checkoutAboveExecutable() { return found }
        return nil
    }

    /// `mac/.build/debug/AgentShark` lives inside the checkout; walk up to find it.
    static func checkoutAboveExecutable() -> URL? {
        var dir = Bundle.main.executableURL?.resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<8 {
            guard let d = dir else { return nil }
            if isEngineRoot(d) { return d }
            dir = d.deletingLastPathComponent()
        }
        return nil
    }
}
