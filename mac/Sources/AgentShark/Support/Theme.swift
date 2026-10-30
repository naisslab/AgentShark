import AppKit
import SwiftUI

/// Semantic colors, fonts and metrics. Every color has a light and a dark variant; color only encodes kind and status.
enum Theme {
    // MARK: Kind colors (SPEC §7.6 palette, matching the web viewer's tokens)

    enum KindColor: String, CaseIterable, Sendable {
        case user, llm, thinking, toolShell, toolFile, toolWeb, toolMcp, toolOther, agent, context, compaction, hook, harness, raw
    }

    static func color(_ k: KindColor) -> NSColor {
        switch k {
        case .user: return dynamic(0x17732F, 0x57C27A)
        case .llm: return dynamic(0x1F5FBF, 0x6EA8FF)
        case .thinking: return dynamic(0x7448B6, 0xB496F0)
        case .toolShell: return dynamic(0x8F5E00, 0xE0A93A)
        case .toolFile: return dynamic(0x7E5F32, 0xCFAE7E)
        case .toolWeb: return dynamic(0x0A6D8F, 0x4FC3E6)
        case .toolMcp: return dynamic(0x0D6F66, 0x3FC1B0)
        case .toolOther: return dynamic(0x3D6B78, 0x8DB8C4)
        case .agent: return dynamic(0x922AA2, 0xD683E6)
        case .context: return dynamic(0x566577, 0x97A7BA)
        case .compaction: return dynamic(0xA84306, 0xF08A4B)
        case .hook: return dynamic(0x506070, 0x9EACBC)
        case .harness: return dynamic(0x666058, 0xB3ABA1)
        case .raw: return dynamic(0x756716, 0xC9B64E)
        }
    }

    /// The kind category of an event; tool events use the tool's kind.
    static func kindColor(for kind: EventKind, toolName: String? = nil) -> KindColor {
        switch kind.layer {
        case "user": return .user
        case "llm": return kind == .llmThinking ? .thinking : .llm
        case "tool":
            switch ToolKinds.kind(of: toolName) {
            case "shell": return .toolShell
            case "file": return .toolFile
            case "web": return .toolWeb
            case "mcp": return .toolMcp
            case "agent": return .agent
            default: return .toolOther
            }
        case "agent": return .agent
        case "context": return kind == .contextCompaction ? .compaction : .context
        case "hook", "permission": return .hook
        case "harness": return .harness
        case "raw": return .raw
        default: return .context
        }
    }

    /// The color of an event's kind bar.
    static func kindColor(_ kind: EventKind, toolName: String? = nil) -> NSColor {
        color(kindColor(for: kind, toolName: toolName))
    }

    // MARK: Agents

    static func agentColor(_ agent: AgentKind) -> NSColor {
        switch agent {
        case .claudeCode: return dynamic(0xB0502A, 0xE3916B)
        case .claudeCowork: return dynamic(0x8A5A2B, 0xD4A574)
        case .codex: return dynamic(0x3556C8, 0x8AA4F7)
        case .copilot: return dynamic(0x6F42C1, 0xAD93F2)
        case .antigravity: return dynamic(0x1A7F4B, 0x6FCF97)
        default: return .secondaryLabelColor
        }
    }

    // MARK: Status (system colors adapt to Dark Mode and Increase Contrast)

    static let ok = NSColor.systemGreen
    static let warn = NSColor.systemOrange
    static let err = NSColor.systemRed
    static let note = NSColor.systemBlue

    /// Color for an API severity (`error | warn | note | chat`).
    static func severityColor(_ severity: String) -> NSColor {
        switch severity {
        case "error": return err
        case "warn": return warn
        case "note": return note
        default: return .secondaryLabelColor
        }
    }

    static func spanStatusColor(_ s: SpanStatus) -> NSColor {
        switch s {
        case .ok: return ok
        case .error: return err
        case .cancelled, .interrupted: return warn
        case .open: return note
        default: return .secondaryLabelColor
        }
    }

    // MARK: Row tints

    /// Width of the leading kind bar in event rows.
    static let kindBarWidth: CGFloat = 3

    /// A row's wash from a rule or kind color: 6% alpha, 10% in Dark Mode (DESIGN.md §5.2).
    static func rowTint(_ color: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            let dark = appearance.isDark
            var base = color
            appearance.performAsCurrentDrawingAppearance { base = color.usingColorSpace(.sRGB) ?? color }
            return base.withAlphaComponent(dark ? 0.10 : 0.06)
        }
    }

    // MARK: Type scale (DESIGN.md §3.1)

    /// The roles of the type scale. Sizes are compact; comfortable density adds 1 to every size.
    enum TypeRole: Sendable {
        /// Lens title, session title in the Steps header, empty-state headline, Settings pane title: 15/600.
        case title
        /// Pane headers and workspace tabs: 13/600.
        case paneTitle
        /// Lens and Follow section labels (uppercase): 11/600.
        case sectionLabel
        /// Queue sections, Steps turn rows, Diagnostics groups: 12/600.
        case groupHeader
        /// Table cells, Lens values, prose: 13/400.
        case rowPrimary
        /// Queue line 1: 13/500.
        case queuePrimary
        /// Queue line 2, field labels, scope label: 11/400.
        case rowSecondary
        /// Ages, status bar, legends, hints: 11/400.
        case metadata
        /// Code blocks, Raw, call tokens, inline ids (SF Mono, §3.2 contexts only): 12/400.
        case code

        var size: CGFloat {
            switch self {
            case .title: return 15
            case .paneTitle, .rowPrimary, .queuePrimary: return 13
            case .groupHeader, .code: return 12
            case .sectionLabel, .rowSecondary, .metadata: return 11
            }
        }

        var weight: NSFont.Weight {
            switch self {
            case .title, .paneTitle, .sectionLabel, .groupHeader: return .semibold
            case .queuePrimary: return .medium
            default: return .regular
            }
        }
    }

    /// The font of a role: the system font with tabular figures, or SF Mono for `.code`.
    static func font(_ role: TypeRole, _ density: Preferences.RowDensity = .compact) -> NSFont {
        let size = role.size + density.sizeBump
        return role == .code ? codeFont(size: size) : dataFont(size: size, weight: role.weight)
    }

    /// The SwiftUI font of a role.
    static func fontSwiftUI(_ role: TypeRole, _ density: Preferences.RowDensity = .compact) -> Font {
        Font(font(role, density))
    }

    /// SF Mono, only for the machine text of DESIGN.md §3.2: code, commands, paths, identifiers, filter vocabulary.
    static func codeFont(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.monospacedSystemFont(ofSize: size, weight: weight)
    }

    /// The UI font with tabular figures: every number and timestamp aligns through it (§3.3).
    static func dataFont(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
    }

    /// SwiftUI equivalents.
    static func dataFontSwiftUI(size: CGFloat) -> Font { .system(size: size).monospacedDigit() }

    /// Solid badge text: dark in both appearances, because white reaches only 3.4–3.6:1 on systemRed (§5.4).
    static let solidBadgeText = NSColor(hex: 0x15181B)

    // MARK: Metrics (DESIGN.md §4.3)

    static let compactRowHeight: CGFloat = 22
    static let comfortableRowHeight: CGFloat = 26

    static func rowHeight(_ density: Preferences.RowDensity) -> CGFloat {
        density == .compact ? compactRowHeight : comfortableRowHeight
    }

    /// Row and bar heights of one density.
    struct Metrics: Equatable, Sendable {
        let density: Preferences.RowDensity
        private var c: Bool { density == .compact }
        var tableRow: CGFloat { c ? 22 : 26 }
        var turnRow: CGFloat { c ? 28 : 32 }
        var listRow: CGFloat { c ? 40 : 48 }
        var groupHeader: CGFloat { c ? 28 : 32 }
        var paneHeader: CGFloat { c ? 32 : 36 }
        var workspaceHeader: CGFloat { c ? 28 : 32 }
        var scopeBar: CGFloat { c ? 36 : 40 }
        var statusBar: CGFloat { c ? 24 : 26 }
        /// Buttons, pop-up buttons, segmented controls and search fields outside the toolbar (§4.2).
        var swiftUIControlSize: ControlSize { c ? .small : .regular }
    }

    static func metrics(_ density: Preferences.RowDensity) -> Metrics { Metrics(density: density) }

    // MARK: Helpers

    /// A color with separate light and dark values (0xRRGGBB).
    static func dynamic(_ light: UInt32, _ dark: UInt32) -> NSColor {
        let l = NSColor(hex: light), d = NSColor(hex: dark)
        return NSColor(name: nil) { $0.isDark ? d : l }
    }
}

extension NSColor {
    /// The same dynamic color for SwiftUI.
    var swiftUI: Color { Color(nsColor: self) }

    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }

    /// `#RRGGBB` or `RRGGBB`.
    convenience init?(hexString: String) {
        var s = hexString.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(hex: v)
    }

    /// `#RRGGBB` in sRGB.
    var hexString: String {
        let c = usingColorSpace(.sRGB) ?? self
        let r = Int((c.redComponent * 255).rounded()), g = Int((c.greenComponent * 255).rounded()), b = Int((c.blueComponent * 255).rounded())
        return String(format: "#%02X%02X%02X", max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    }
}

extension NSAppearance {
    var isDark: Bool { bestMatch(from: [.aqua, .darkAqua]) == .darkAqua }
}

/// Tool kind of a tool name (mirrors toolKind() in src/adapters/adapter.ts; EventRow carries only the name).
enum ToolKinds {
    static let shell: Set<String> = ["Bash", "BashOutput", "KillShell", "KillBash", "exec_command", "write_stdin", "shell_command", "shell",
                                     "local_shell", "mcp__workspace__bash"]
    static let file: Set<String> = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "Glob", "Grep", "LS", "apply_patch",
                                    "view_image"]
    static let web: Set<String> = ["WebFetch", "WebSearch", "web_search", "web_search_call", "mcp__workspace__web_fetch"]
    static let agent: Set<String> = ["Agent", "Task", "Workflow", "SendMessage", "spawn_agent", "send_message", "followup_task", "wait_agent",
                                     "list_agents", "interrupt_agent", "close_agent", "send_input", "wait"]
    static let plan: Set<String> = ["TodoWrite", "TodoRead", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "TaskOutput",
                                    "update_plan", "ExitPlanMode", "EnterPlanMode"]

    /// `shell | file | web | mcp | agent | plan | custom | other`, or nil without a name.
    static func kind(of name: String?) -> String? {
        guard let name, !name.isEmpty else { return nil }
        if shell.contains(name) { return "shell" }
        if web.contains(name) { return "web" }
        if name.hasPrefix("mcp__") { return "mcp" }
        if file.contains(name) { return "file" }
        if agent.contains(name) { return "agent" }
        if plan.contains(name) { return "plan" }
        if name == "exec" { return "custom" }
        return "other"
    }
}
