import Foundation
import Observation
import SwiftUI

struct FilterBookmark: Codable, Hashable, Sendable, Identifiable {
    var id: UUID
    var name: String
    var filter: String
    /// Built-in presets ship with the app and cannot be edited.
    var isBuiltIn: Bool

    init(id: UUID = UUID(), name: String, filter: String, isBuiltIn: Bool = false) {
        self.id = id
        self.name = name
        self.filter = filter
        self.isBuiltIn = isBuiltIn
    }
}

/// Saved filters: built-in presets ("Filters" menu examples) plus the person's own bookmarks.
@MainActor @Observable final class Bookmarks {
    static let presets: [FilterBookmark] = ([
        ("Errors", "error"),
        ("Slow shell commands", #"tool.name == "Bash" && dur > 5s"#),
        ("Large model outputs", "llm && tokens.output > 2000"),
        ("Subagent activity", "agent"),
        ("Context compactions", "context.compaction"),
        ("MCP tool calls", #"tool.kind == "mcp""#),
        ("Thinking blocks", "llm.thinking"),
        ("Human prompts", "user.prompt"),
        ("Failed tool results", "tool.result && error"),
        ("Results without a call", "orphan"),
        ("Undecoded records", "raw.unknown"),
        ("Last two hours", "ts > -2h"),
    ] as [(String, String)]).enumerated().map { i, p in
        FilterBookmark(id: UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", i + 1))!, name: p.0, filter: p.1, isBuiltIn: true)
    }

    private(set) var user: [FilterBookmark] { didSet { save() } }
    @ObservationIgnored private let defaults: UserDefaults?
    private static let key = "filterBookmarks"

    init(defaults: UserDefaults? = .standard) {
        self.defaults = defaults
        if let data = defaults?.data(forKey: Self.key), let list = try? JSONDecoder().decode([FilterBookmark].self, from: data) {
            user = list.map { var b = $0; b.isBuiltIn = false; return b }
        } else {
            user = []
        }
    }

    var all: [FilterBookmark] { Self.presets + user }

    @discardableResult
    func add(name: String, filter: String) -> FilterBookmark {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = FilterBookmark(name: trimmed.isEmpty ? filter : trimmed, filter: filter)
        user.append(b)
        return b
    }

    func update(_ bookmark: FilterBookmark) {
        guard let i = user.firstIndex(where: { $0.id == bookmark.id }) else { return }
        user[i] = bookmark
    }

    func remove(_ id: UUID) {
        user.removeAll { $0.id == id }
    }

    func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        user.move(fromOffsets: source, toOffset: destination)
    }

    private func save() {
        guard let defaults, let data = try? JSONEncoder().encode(user) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
