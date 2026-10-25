import AppKit
import Foundation
import Observation
import SwiftUI

/// A light/dark color pair stored as `#RRGGBB` strings.
struct RuleColor: Codable, Hashable, Sendable {
    var light: String
    var dark: String

    init(light: String, dark: String) {
        self.light = light
        self.dark = dark
    }

    init(_ light: UInt32, _ dark: UInt32) {
        self.light = String(format: "#%06X", light)
        self.dark = String(format: "#%06X", dark)
    }

    /// A dynamic NSColor that follows the appearance.
    var nsColor: NSColor {
        let l = NSColor(hexString: light) ?? .labelColor
        let d = NSColor(hexString: dark) ?? l
        return NSColor(name: nil) { $0.isDark ? d : l }
    }
}

/// How a rule's outline frames a row; the default tier rules use solid outlines (DESIGN.md §6.1).
enum OutlineStyle: String, Codable, CaseIterable, Sendable {
    case solid, dashed, dotted

    var title: String { rawValue.capitalized }
    /// Dash lengths for a 1 pt line (nil: solid).
    var dashPattern: [NSNumber]? {
        switch self {
        case .solid: return nil
        case .dashed: return [4, 3]
        case .dotted: return [1, 2]
        }
    }
}

/// One coloring rule: the first enabled rule whose filter matches a row colors it (SPEC §7.6, MAC-SPEC §8). A rule
/// sets the text color, the background (the leading bar and a light wash) and an outline that frames the row.
struct ColorRule: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var filter: String
    var enabled: Bool
    var foreground: RuleColor?
    var background: RuleColor?
    var outline: RuleColor?
    /// Solid when an outline color is set without a style.
    var outlineStyle: OutlineStyle?

    init(id: String = UUID().uuidString, name: String, filter: String, enabled: Bool = true, foreground: RuleColor? = nil,
         background: RuleColor? = nil, outline: RuleColor? = nil, outlineStyle: OutlineStyle? = nil) {
        self.id = id
        self.name = name
        self.filter = filter
        self.enabled = enabled
        self.foreground = foreground
        self.background = background
        self.outline = outline
        self.outlineStyle = outlineStyle
    }
}

/// A row's outline from its coloring rule.
struct RowOutline: Equatable {
    var color: NSColor
    var style: OutlineStyle
}

/// The ordered coloring rules. The engine evaluates them while it builds a view (MAC-CONTRACT §3), so rules
/// support the full filter language; each row carries the id of its first matching rule.
@MainActor @Observable final class ColorRules {
    var rules: [ColorRule] {
        didSet {
            colorCache.removeAll()
            save()
        }
    }

    @ObservationIgnored private let defaults: UserDefaults?
    @ObservationIgnored private var colorCache: [String: (fg: NSColor?, bg: NSColor?, tint: NSColor?, outline: RowOutline?)] = [:]
    private static let key = "coloringRules"
    /// Set once the stored rules gained the tier rules, so a user who deletes them keeps them deleted.
    private static let tierKey = "coloringRules.tierDefaults"

    init(defaults: UserDefaults? = .standard) {
        self.defaults = defaults
        if let data = defaults?.data(forKey: Self.key), let saved = try? JSONDecoder().decode([ColorRule].self, from: data) {
            rules = defaults?.bool(forKey: Self.tierKey) == true ? saved : Self.withTierDefaults(saved)
            if rules != saved { save() }
        } else {
            rules = Self.defaultRules
        }
        defaults?.set(true, forKey: Self.tierKey)
    }

    /// Stored rules from before the tier rules gain the ones they lack (same filter), in front.
    static func withTierDefaults(_ rules: [ColorRule]) -> [ColorRule] {
        let squash = { (f: String) in f.filter { !$0.isWhitespace } }
        let have = Set(rules.map { squash($0.filter) }), ids = Set(rules.map(\.id))
        return tierRules.filter { !have.contains(squash($0.filter)) && !ids.contains($0.id) } + rules
    }

    // MARK: Defaults (SPEC §7.6)

    static let palette: [String: RuleColor] = [
        "red": RuleColor(0xBD2828, 0xFF7B72),
        "green": RuleColor(0x17732F, 0x57C27A),
        "blue": RuleColor(0x1F5FBF, 0x6EA8FF),
        "violet": RuleColor(0x7448B6, 0xB496F0),
        "amber": RuleColor(0x8F5E00, 0xE0A93A),
        "sand": RuleColor(0x7E5F32, 0xCFAE7E),
        "cyan": RuleColor(0x0A6D8F, 0x4FC3E6),
        "teal": RuleColor(0x0D6F66, 0x3FC1B0),
        "purple": RuleColor(0x922AA2, 0xD683E6),
        "orange": RuleColor(0xA84306, 0xF08A4B),
        "slate": RuleColor(0x506070, 0x9EACBC),
        "grey": RuleColor(0x566577, 0x97A7BA),
        "olive": RuleColor(0x756716, 0xC9B64E),
        "faint": RuleColor(0x8A9099, 0x6E757D),
    ]

    /// The failure tiers (SPEC §12.7 Events): a red wash for `failure`, a red outline for suspect rows, an amber outline
    /// for benign and deferred rows (one solid outline per tier color, DESIGN.md §6.1). Rows take color only through
    /// the leading bar and the wash (§5.2), so the text keeps its color. They come first, so a tiered row keeps its cue
    /// over its kind's wash.
    static let tierRules: [ColorRule] = [
        ColorRule(id: "default.tier.failure", name: "Failures", filter: "failure", background: palette["red"]),
        ColorRule(id: "default.tier.suspect", name: "Suspect failures", filter: #"failure.tier == "suspect""#,
                  outline: palette["red"], outlineStyle: .solid),
        ColorRule(id: "default.tier.benign", name: "Benign and deferred", filter: #"failure.tier in {"benign", "deferred"}"#,
                  outline: palette["amber"], outlineStyle: .solid),
    ]

    static let defaultRules: [ColorRule] = tierRules + [
        ColorRule(id: "default.errors", name: "Errors", filter: "error", background: palette["red"]),
        ColorRule(id: "default.prompts", name: "User prompts", filter: "user.prompt", background: palette["green"]),
        ColorRule(id: "default.thinking", name: "Thinking", filter: "llm.thinking", background: palette["violet"]),
        ColorRule(id: "default.llm", name: "Model output", filter: "llm", background: palette["blue"]),
        ColorRule(id: "default.shell", name: "Shell tools", filter: #"tool.kind == "shell""#, background: palette["amber"]),
        ColorRule(id: "default.file", name: "File tools", filter: #"tool.kind == "file""#, background: palette["sand"]),
        ColorRule(id: "default.web", name: "Web tools", filter: #"tool.kind == "web""#, background: palette["cyan"]),
        ColorRule(id: "default.mcp", name: "MCP tools", filter: #"tool.kind == "mcp""#, background: palette["teal"]),
        ColorRule(id: "default.agents", name: "Agents", filter: #"agent || tool.kind == "agent""#, background: palette["purple"]),
        ColorRule(id: "default.compaction", name: "Compaction", filter: "context.compaction", background: palette["orange"]),
        ColorRule(id: "default.hooks", name: "Hooks", filter: "hook", background: palette["slate"]),
        ColorRule(id: "default.dimmed", name: "Inherited or duplicate", filter: "inherited || dup", foreground: palette["faint"]),
    ]

    func restoreDefaults() { rules = Self.defaultRules }

    // MARK: Use

    /// Enabled rules with a filter, in order, as sent to `POST /api/views`.
    func specs(excluding invalid: Set<String> = []) -> [ColorRuleSpec] {
        rules.filter { $0.enabled && !$0.filter.trimmingCharacters(in: .whitespaces).isEmpty && !invalid.contains($0.id) }
            .map { ColorRuleSpec(id: $0.id, filter: $0.filter) }
    }

    func rule(id: String?) -> ColorRule? {
        guard let id else { return nil }
        return rules.first { $0.id == id }
    }

    /// Dynamic foreground and background colors for a row's `colorRule`. The background is the full color;
    /// apply `Theme.rowTint` for the subtle row fill.
    func colors(forRuleID id: String?) -> (foreground: NSColor?, background: NSColor?) {
        guard let entry = cachedColors(id) else { return (nil, nil) }
        return (entry.fg, entry.bg)
    }

    /// The subtle row fill for a row's `colorRule` (`Theme.rowTint` of the background), cached.
    func rowTint(forRuleID id: String?) -> NSColor? {
        cachedColors(id)?.tint
    }

    /// The frame a row's `colorRule` draws around it, cached.
    func outline(forRuleID id: String?) -> RowOutline? {
        cachedColors(id)?.outline
    }

    private func cachedColors(_ id: String?) -> (fg: NSColor?, bg: NSColor?, tint: NSColor?, outline: RowOutline?)? {
        guard let id else { return nil }
        if let cached = colorCache[id] { return cached }
        let r = rule(id: id)
        let bg = r?.background?.nsColor
        let outline = r?.outline.map { RowOutline(color: $0.nsColor, style: r?.outlineStyle ?? .solid) }
        let entry = (fg: r?.foreground?.nsColor, bg: bg, tint: bg.map(Theme.rowTint), outline: outline)
        colorCache[id] = entry
        return entry
    }

    // MARK: Editing

    func add(_ rule: ColorRule, at index: Int? = nil) {
        rules.insert(rule, at: min(index ?? rules.count, rules.count))
    }

    func remove(ids: Set<String>) {
        rules.removeAll { ids.contains($0.id) }
    }

    func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        rules.move(fromOffsets: source, toOffset: destination)
    }

    // MARK: Import and export

    struct Document: Codable {
        var format = "agentshark-coloring-rules"
        var version = 1
        var rules: [ColorRule]
    }

    func exportData() throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try enc.encode(Document(rules: rules))
    }

    /// Accepts this app's export, a bare array of rules, or the web viewer's rules (`{name, filter, fg, bg, enabled}`).
    static func parse(_ data: Data) throws -> [ColorRule] {
        if let doc = try? JSONDecoder().decode(Document.self, from: data) { return doc.rules }
        if let list = try? JSONDecoder().decode([ColorRule].self, from: data) { return list }
        struct WebRule: Decodable {
            var name: String?
            var filter: String
            var fg: String?
            var bg: String?
            var outline: String?
            var outlineStyle: String?
            var enabled: Bool?
        }
        let web = try JSONDecoder().decode([WebRule].self, from: data)
        return web.map {
            ColorRule(name: $0.name ?? $0.filter, filter: $0.filter, enabled: $0.enabled ?? true, foreground: webColor($0.fg),
                      background: webColor($0.bg), outline: webColor($0.outline), outlineStyle: $0.outlineStyle.flatMap(OutlineStyle.init(rawValue:)))
        }
    }

    func importData(_ data: Data) throws {
        let parsed = try Self.parse(data)
        // Imported ids must stay unique.
        var seen = Set<String>()
        rules = parsed.map { r in
            var r = r
            if r.id.isEmpty || seen.contains(r.id) { r.id = UUID().uuidString }
            seen.insert(r.id)
            return r
        }
    }

    /// `var(--err)`-style tokens and `#RRGGBB` from the web viewer.
    static func webColor(_ value: String?) -> RuleColor? {
        guard let value else { return nil }
        if value.hasPrefix("#"), NSColor(hexString: value) != nil { return RuleColor(light: value.uppercased(), dark: value.uppercased()) }
        let tokens: [String: String] = [
            "--err": "red", "--c-user": "green", "--c-llm": "blue", "--c-thinking": "violet", "--c-tool-shell": "amber",
            "--c-tool-file": "sand", "--c-tool-web": "cyan", "--c-tool-mcp": "teal", "--c-agent": "purple",
            "--c-compaction": "orange", "--c-hook": "slate", "--c-context": "grey", "--c-raw": "olive", "--fg-faint": "faint",
            "--tier-failure": "red", "--tier-suspect": "red", "--tier-benign": "amber",
        ]
        let name = value.replacingOccurrences(of: "var(", with: "").replacingOccurrences(of: ")", with: "")
        return tokens[name].flatMap { palette[$0] }
    }

    private func save() {
        guard let defaults, let data = try? JSONEncoder().encode(rules) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
