import SwiftUI

/// Every menu shortcut, declared once (MAC-CONTRACT §5.5). `Commands` binds them, the Keyboard Shortcuts sheet lists
/// them, and `ShortcutTests` checks that none collide with each other or with the standard macOS menus.
enum AppShortcut: String, CaseIterable {
    // File
    case newWindow, newTab, openCapture, exportCapture, reindexEvents, reindex
    // Edit
    case copyAsJSON, find, findNext, findPrevious, mark
    // View
    case workspace1, workspace2, workspace3, workspace4, workspace5, workspace6, workspace7
    case sessionSteps, sessionTranscript, sessionFlow, sessionCriticalPath, sessionCompare, showTimelineTrack, showInspector
    // Go
    case back, forward, goToEvent, partnerEvent, previousInTurn, nextInTurn, nextMark, parentSession, childSession, nextRegion,
         previousRegion, timeReference
    // Failures
    case nextFailure, previousFailure, nextAttention, showInSession, showSignature, follow, copyReport
    // Filter
    case clearFilter, filterToTimeRange

    private static let command: EventModifiers = .command

    var shortcut: KeyboardShortcut {
        switch self {
        case .newWindow: return KeyboardShortcut("n")
        case .newTab: return KeyboardShortcut("t")
        case .openCapture: return KeyboardShortcut("o")
        case .exportCapture: return KeyboardShortcut("e", modifiers: [.command, .shift])
        case .reindexEvents: return KeyboardShortcut("r")
        case .reindex: return KeyboardShortcut("r", modifiers: [.command, .shift])
        case .copyAsJSON: return KeyboardShortcut("c", modifiers: [.command, .option])
        case .find: return KeyboardShortcut("f")
        case .findNext: return KeyboardShortcut("g")
        case .findPrevious: return KeyboardShortcut("g", modifiers: [.command, .shift])
        case .mark: return KeyboardShortcut("m", modifiers: [.command, .control])
        case .workspace1, .workspace2, .workspace3, .workspace4, .workspace5, .workspace6, .workspace7:
            return KeyboardShortcut(KeyEquivalent(Character(String(workspaceIndex! + 1))))
        case .sessionSteps: return KeyboardShortcut("1", modifiers: [.command, .option])
        case .sessionTranscript: return KeyboardShortcut("2", modifiers: [.command, .option])
        case .sessionFlow: return KeyboardShortcut("3", modifiers: [.command, .option])
        case .sessionCriticalPath: return KeyboardShortcut("4", modifiers: [.command, .option])
        case .sessionCompare: return KeyboardShortcut("5", modifiers: [.command, .option])
        case .showTimelineTrack: return KeyboardShortcut("t", modifiers: [.command, .option])
        case .showInspector: return KeyboardShortcut("i", modifiers: [.command, .option])
        case .back: return KeyboardShortcut("[")
        case .forward: return KeyboardShortcut("]")
        case .goToEvent: return KeyboardShortcut("l")
        case .partnerEvent: return KeyboardShortcut(.rightArrow, modifiers: [.command, .option])
        case .previousInTurn: return KeyboardShortcut(.upArrow, modifiers: [.command, .control])
        case .nextInTurn: return KeyboardShortcut(.downArrow, modifiers: [.command, .control])
        case .nextMark: return KeyboardShortcut("m", modifiers: [.command, .shift])
        case .parentSession: return KeyboardShortcut(.upArrow, modifiers: .command)
        case .childSession: return KeyboardShortcut(.downArrow, modifiers: .command)
        case .nextRegion: return KeyboardShortcut(.downArrow, modifiers: [.command, .option])
        case .previousRegion: return KeyboardShortcut(.upArrow, modifiers: [.command, .option])
        case .timeReference: return KeyboardShortcut("t", modifiers: [.command, .control])
        case .nextFailure: return KeyboardShortcut("'")
        case .previousFailure: return KeyboardShortcut("'", modifiers: [.command, .shift])
        case .nextAttention: return KeyboardShortcut("'", modifiers: [.command, .option])
        case .showInSession: return KeyboardShortcut(.return, modifiers: .command)
        case .showSignature: return KeyboardShortcut("g", modifiers: [.command, .option])
        case .follow: return KeyboardShortcut("f", modifiers: [.command, .option])
        case .copyReport: return KeyboardShortcut("c", modifiers: [.command, .shift])
        case .clearFilter: return KeyboardShortcut(.delete, modifiers: .command)
        case .filterToTimeRange: return KeyboardShortcut("r")
        }
    }

    /// Commands that share a key on purpose, active in different workspaces (⌘R: Reindex in Events, Filter to Time
    /// Range in Timeline). Nil: every workspace.
    var context: Set<Workspace>? {
        switch self {
        case .reindexEvents: return [.events]
        case .reindex: return Set(Workspace.allCases).subtracting([.events])
        case .filterToTimeRange: return [.timeline]
        default: return nil
        }
    }

    /// 0-based position of a workspace shortcut (⌘1 is 0).
    var workspaceIndex: Int? {
        switch self {
        case .workspace1: return 0
        case .workspace2: return 1
        case .workspace3: return 2
        case .workspace4: return 3
        case .workspace5: return 4
        case .workspace6: return 5
        case .workspace7: return 6
        default: return nil
        }
    }

    static func workspace(at index: Int) -> AppShortcut {
        [.workspace1, .workspace2, .workspace3, .workspace4, .workspace5, .workspace6, .workspace7][index]
    }

    /// The shortcut as the menus show it: "⌥⌘G", "⌘↩".
    var keys: String { Self.describe(shortcut) }

    static func describe(_ s: KeyboardShortcut) -> String {
        var out = ""
        if s.modifiers.contains(.control) { out += "⌃" }
        if s.modifiers.contains(.option) { out += "⌥" }
        if s.modifiers.contains(.shift) { out += "⇧" }
        if s.modifiers.contains(.command) { out += "⌘" }
        switch s.key {
        case .upArrow: out += "↑"
        case .downArrow: out += "↓"
        case .leftArrow: out += "←"
        case .rightArrow: out += "→"
        case .return: out += "↩"
        case .delete: out += "⌫"
        case .escape: out += "⎋"
        case .space: out += "Space"
        default: out += String(s.key.character).uppercased()
        }
        return out
    }
}

extension KeyboardShortcut {
    /// Key and modifiers, for comparing shortcuts.
    var identity: String { "\(key.character)|\(modifiers.rawValue)" }
}
