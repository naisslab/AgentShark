import AppKit
import Observation
import SwiftUI

/// Re-runs `body` after any observable property it read changes. AppKit controllers use it to follow a
/// `WindowModel` without SwiftUI; `cancel()` stops it (call it when the controller goes away).
@MainActor final class ObservationLoop {
    private var isActive = true
    private let body: @MainActor () -> Void

    init(_ body: @escaping @MainActor () -> Void) {
        self.body = body
        run()
    }

    func cancel() { isActive = false }

    private func run() {
        guard isActive else { return }
        withObservationTracking {
            body()
        } onChange: { [weak self] in
            Task { @MainActor in self?.run() }
        }
    }
}

/// A navigation state for the next window that opens ("Open in New Tab"). The new window's `MainWindow`
/// takes it when it appears, if it was set in the last few seconds.
@MainActor enum PendingWindowState {
    private static var pending: (state: NavState, at: Date)?

    static func set(_ state: NavState) { pending = (state, Date()) }

    static func take() -> NavState? {
        defer { pending = nil }
        guard let p = pending, Date().timeIntervalSince(p.at) < 5 else { return nil }
        return p.state
    }
}

/// Pinned and recently opened sessions for the sidebar's Pinned and Recent sections (saved in UserDefaults).
@MainActor @Observable final class SidebarLists {
    static let shared = SidebarLists()
    static let recentLimit = 12

    private(set) var pinned: [String] { didSet { defaults.set(pinned, forKey: "AgentShark.pinnedSessions") } }
    private(set) var recent: [String] { didSet { defaults.set(recent, forKey: "AgentShark.recentSessions") } }
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        pinned = defaults.stringArray(forKey: "AgentShark.pinnedSessions") ?? []
        recent = defaults.stringArray(forKey: "AgentShark.recentSessions") ?? []
    }

    func isPinned(_ id: String) -> Bool { pinned.contains(id) }

    /// Pin every session in `ids`, or unpin them all when all are already pinned.
    func togglePin(_ ids: [String]) {
        if ids.allSatisfy(isPinned) {
            pinned.removeAll { ids.contains($0) }
        } else {
            pinned += ids.filter { !isPinned($0) }
        }
    }

    func noteOpened(_ id: String) {
        guard recent.first != id else { return }
        recent = Array(([id] + recent.filter { $0 != id }).prefix(Self.recentLimit))
    }
}

/// Open a window showing `state` as a tab of the current window (sidebar ▸ Open in New Tab).
@MainActor func openInNewTab(_ state: NavState, openWindow: OpenWindowAction) {
    let current = NSApp.keyWindow
    PendingWindowState.set(state)
    openWindow(value: WindowTarget.newLive())
    guard let current else { return }
    DispatchQueue.main.async {
        guard let new = NSApp.keyWindow, new !== current, current.tabbedWindows?.contains(new) != true else { return }
        current.addTabbedWindow(new, ordered: .above)
        new.makeKeyAndOrderFront(nil)
    }
}

extension NSMenu {
    /// Add an item whose action runs `handler`.
    @discardableResult
    func addItem(_ title: String, symbol: String? = nil, enabled: Bool = true, state: NSControl.StateValue = .off,
                 handler: @escaping @MainActor () -> Void) -> NSMenuItem {
        let item = ClosureMenuItem(title: title, handler: handler)
        item.isEnabled = enabled
        item.state = state
        if let symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
        addItem(item)
        return item
    }

    /// Add a submenu item.
    @discardableResult
    func addSubmenu(_ title: String, enabled: Bool = true, build: (NSMenu) -> Void) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu(title: title)
        sub.autoenablesItems = false
        build(sub)
        item.submenu = sub
        item.isEnabled = enabled
        addItem(item)
        return item
    }

    /// The six Wireshark combine modes, each calling `handler`.
    func addCombineModes(_ handler: @escaping @MainActor (FilterCombine) -> Void) {
        for mode in FilterCombine.allCases {
            addItem(mode.title) { handler(mode) }
        }
    }
}

/// A menu item that runs a closure (menus built in code).
final class ClosureMenuItem: NSMenuItem {
    private let handler: @MainActor () -> Void

    init(title: String, handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func run() {
        MainActor.assumeIsolated { handler() }
    }
}
