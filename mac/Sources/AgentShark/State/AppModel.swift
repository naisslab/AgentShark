import AppKit
import Foundation
import Observation

/// What a window shows: the live index or one capture file. SwiftUI restores it with the window.
/// Live targets carry a unique ID so every New Window or New Tab is a separate window; a capture target
/// is unique per file, so opening the same capture again brings its window forward.
enum WindowTarget: Codable, Hashable, Sendable {
    case live(UUID)
    case capture(URL)

    static func newLive() -> WindowTarget { .live(UUID()) }
}

/// App-wide state: settings, the live engine and its catalog, bookmarks, coloring rules, capture engines.
@MainActor @Observable final class AppModel {
    static let shared = AppModel()

    let preferences: Preferences
    let liveEngine: EngineProcess
    let demoEngine: EngineProcess
    /// Catalog of the live engine (info, sessions, fields, indexing, connection).
    let liveStore: EngineStore
    var bookmarks: Bookmarks
    var colorRules: ColorRules
    /// Capture files opened recently (File ▸ Open Recent), newest first.
    private(set) var recentCaptures: [URL] = []

    /// One engine per open capture file, with the number of windows showing it.
    @ObservationIgnored private var captureStores: [URL: EngineStore] = [:]
    @ObservationIgnored private var captureWindowCounts: [URL: Int] = [:]
    /// Opens a window; set by the first window from SwiftUI's `openWindow`.
    @ObservationIgnored var openWindowHandler: ((WindowTarget) -> Void)?
    /// Windows requested before any window could open them (a capture double-clicked at launch).
    @ObservationIgnored private(set) var pendingTargets: [WindowTarget] = []
    @ObservationIgnored private var started = false
    /// When the app started: the entry rule (SPEC §12.7) applies to the windows of a launch only.
    @ObservationIgnored let launchedAt = Date()
    /// The end of the previous visit, read at launch (nil on the first launch). `lastVisit` itself moves on every
    /// minute, so a killed app still records its visit.
    @ObservationIgnored private(set) var previousVisit: Int64?
    @ObservationIgnored private var visitTimer: Timer?
    /// Windows of this process, for routing a notification click to a window.
    @ObservationIgnored private var windowModels: [WeakWindowModel] = []

    private struct WeakWindowModel { weak var model: WindowModel? }

    var isLaunching: Bool { Date().timeIntervalSince(launchedAt) < 90 }

    /// `defaults: nil` keeps every setting in memory (tests and the self-test).
    init(preferences: Preferences? = nil, defaults: UserDefaults? = .standard) {
        let preferences = preferences ?? Preferences(defaults: defaults)
        self.preferences = preferences
        previousVisit = preferences.lastVisit
        liveEngine = EngineProcess(mode: .live, preferences: preferences)
        demoEngine = EngineProcess(mode: .demo, preferences: preferences)
        // A stable (FNV-1a) key per index location; String.hashValue changes every launch.
        let cacheKey = preferences.indexLocation.isEmpty ? "default"
            : String(preferences.indexLocation.utf8.reduce(UInt64(14_695_981_039_346_656_037)) { ($0 ^ UInt64($1)) &* 1_099_511_628_211 }, radix: 36)
        liveStore = EngineStore(engine: liveEngine, cacheKey: defaults == nil ? nil : cacheKey)
        bookmarks = Bookmarks(defaults: defaults)
        colorRules = ColorRules(defaults: defaults)
        recentCaptures = NSDocumentController.shared.recentDocumentURLs
        let store = liveStore
        liveStore.derived.onAlarmFired = { [weak preferences] a in
            guard let preferences else { return }
            AppNotifications.shared.post(a, store: store, preferences: preferences)
        }
    }

    /// Start the live engine (once).
    func start() {
        guard !started else { return }
        started = true
        liveEngine.start()
        visitTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.markVisit() }
        }
        appearanceLoop = ObservationLoop { [weak self] in self?.applyAppearance() }
    }

    @ObservationIgnored private var appearanceLoop: ObservationLoop?

    /// View ▸ Appearance and Settings ▸ Appearance: System, Light or Dark for every window.
    private func applyAppearance() {
        switch preferences.appearance {
        case .system: NSApplication.shared.appearance = nil
        case .light: NSApplication.shared.appearance = NSAppearance(named: .aqua)
        case .dark: NSApplication.shared.appearance = NSAppearance(named: .darkAqua)
        }
    }

    /// Opens the Settings window; set by the first window from SwiftUI's `openSettings` (the Dock menu uses it).
    @ObservationIgnored var openSettingsHandler: (() -> Void)?

    // MARK: Live catalog (MAC-CONTRACT §2.3)

    var info: InfoResult? { liveStore.info }
    var sessions: [SessionRow] { liveStore.sessions }
    var sessionsByID: [String: SessionRow] { liveStore.sessionsByID }
    var childrenByParent: [String: [String]] { liveStore.childrenByParent }
    var fields: [FieldInfo] { liveStore.fields }
    var indexing: (done: Int, total: Int, path: String?, since: Int64?)? { liveStore.indexing }

    // MARK: Windows and engines

    /// The engine and catalog for a window target; capture engines start on first use.
    func store(for target: WindowTarget) -> EngineStore {
        switch target {
        case .live:
            start()
            return liveStore
        case .capture(let url):
            if let s = captureStores[url] { return s }
            let engine = EngineProcess(mode: .capture(url), preferences: preferences)
            let s = EngineStore(engine: engine)
            captureStores[url] = s
            engine.start()
            return s
        }
    }

    func makeWindowModel(for target: WindowTarget) -> WindowModel {
        let s = store(for: target)
        let m = WindowModel(app: self, engine: s.engine, store: s)
        windowModels.removeAll { $0.model == nil }
        windowModels.append(WeakWindowModel(model: m))
        return m
    }

    /// The model of the key window, else of any live window (a notification click).
    var frontWindowModel: WindowModel? {
        windowModels.removeAll { $0.model == nil }
        let live = windowModels.compactMap(\.model).filter { !$0.isCapture }
        return live.first { $0.isKeyWindow } ?? live.first
    }

    /// Open a capture file in a new window bound to its own engine.
    func openCapture(_ url: URL) {
        let url = url.standardizedFileURL
        NSDocumentController.shared.noteNewRecentDocumentURL(url)
        recentCaptures = NSDocumentController.shared.recentDocumentURLs
        openWindow(.capture(url))
    }

    func openWindow(_ target: WindowTarget) {
        if let openWindowHandler {
            openWindowHandler(target)
        } else {
            pendingTargets.append(target)
        }
    }

    /// Called by the first window once `openWindowHandler` is set.
    func takePendingTargets() -> [WindowTarget] {
        defer { pendingTargets.removeAll() }
        return pendingTargets
    }

    func clearRecentCaptures() {
        NSDocumentController.shared.clearRecentDocuments(nil)
        recentCaptures = []
    }

    /// Windows call these on appear and disappear; a capture engine stops when its last window closes.
    func retainWindow(_ target: WindowTarget) {
        if case .capture(let url) = target { captureWindowCounts[url, default: 0] += 1 }
    }

    func releaseWindow(_ target: WindowTarget) {
        guard case .capture(let url) = target else { return }
        let n = (captureWindowCounts[url] ?? 1) - 1
        captureWindowCounts[url] = max(0, n)
        if n <= 0 {
            captureWindowCounts[url] = nil
            captureStores.removeValue(forKey: url)?.engine.stop()
        }
    }

    /// SIGTERM every engine (applicationWillTerminate).
    func terminateAllEngines() {
        liveEngine.terminateForQuit()
        demoEngine.terminateForQuit()
        for s in captureStores.values { s.engine.terminateForQuit() }
    }

    /// The end of this visit so far, for the next launch's entry rule: every minute and at quit.
    func markVisit() {
        preferences.lastVisit = Int64(Date().timeIntervalSince1970 * 1e6)
    }

    /// Restart the live engine after its settings changed.
    func restartLiveEngine() {
        liveEngine.restart()
    }

    /// Supported capture extensions.
    static func isCaptureFile(_ url: URL) -> Bool {
        let name = url.lastPathComponent.lowercased()
        return name.hasSuffix(".agentcap") || name.hasSuffix(".agentcap.zst") || name.hasSuffix(".agentcap.gz")
            || name.hasSuffix(".zst") || name.hasSuffix(".gz")
    }
}
