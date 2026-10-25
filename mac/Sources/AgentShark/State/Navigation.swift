import Foundation
import Observation

/// The seven workspaces (SPEC §12.7): Failures first, then Events, Session (modes Steps, Transcript, Flow, Critical Path
/// and Compare), Timeline, Statistics, Diagnostics and Sources, bound to ⌘1–⌘7 in that order (or Events first in the
/// classic order).
enum Workspace: String, CaseIterable, Codable, Hashable, Sendable, Identifiable {
    case failures, events, session, timeline, stats, diagnostics, sources

    var id: String { rawValue }

    var title: String {
        switch self {
        case .failures: return "Failures"
        case .events: return "Events"
        case .session: return "Session"
        case .timeline: return "Timeline"
        case .stats: return "Statistics"
        case .diagnostics: return "Diagnostics"
        case .sources: return "Sources"
        }
    }

    var symbol: String { Symbols.workspace(self) }

    /// The order shown in the picker and bound to ⌘1–⌘7: `allCases`, or Events first when the classic order is on.
    static func ordered(classic: Bool) -> [Workspace] {
        classic ? [.events, .failures] + allCases.filter { $0 != .events && $0 != .failures } : allCases
    }

    /// ⌘1–⌘7 in the given order.
    func shortcutDigit(classic: Bool) -> Character {
        Character(String(Workspace.ordered(classic: classic).firstIndex(of: self)! + 1))
    }

    /// Persisted raw values from earlier builds: "conversation" is Session · Transcript and "flow" Session · Flow.
    static func migrate(rawValue: String) -> (Workspace, SessionMode?)? {
        switch rawValue {
        case "conversation": return (.session, .transcript)
        case "flow": return (.session, .flow)
        default: return Workspace(rawValue: rawValue).map { ($0, nil) }
        }
    }

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let (w, _) = Workspace.migrate(rawValue: raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "unknown workspace \(raw)"))
        }
        self = w
    }

    /// Which parts of the investigation scope this workspace honors (SPEC §7.8, §12.7). Session depends on its
    /// mode; see `WindowModel.honorsTimeRange` and `honorsFilter`.
    var honorsSessions: Bool { self != .sources }
    var honorsTimeRange: Bool { self != .sources }
    var honorsFilter: Bool { [.failures, .events, .stats, .diagnostics].contains(self) }
}

/// The Session workspace's modes (SPEC §12.7): Steps, the former Conversation (Transcript), Flow, Critical Path
/// (AgentPerf) and Compare (AgentDiff), bound to ⌥⌘1–⌥⌘5 in that order.
enum SessionMode: String, CaseIterable, Codable, Hashable, Sendable {
    case steps, transcript, flow, criticalPath, compare

    var title: String {
        switch self {
        case .steps: return "Steps"
        case .transcript: return "Transcript"
        case .flow: return "Flow"
        case .criticalPath: return "Critical Path"
        case .compare: return "Compare"
        }
    }

    /// The title in the Analyze menu and the mode switch's tooltip: an analysis names its engine there, and only there
    /// (DESIGN.md §9), so macOS Help search still finds "AgentPerf" and "AgentDiff".
    var commandTitle: String {
        switch self {
        case .criticalPath: return "Critical Path (AgentPerf)"
        case .compare: return "Compare Runs (AgentDiff)"
        case .steps, .transcript, .flow: return title
        }
    }

    var symbol: String {
        switch self {
        case .steps: return "list.number"
        case .transcript: return "bubble.left.and.bubble.right"
        case .flow: return "arrow.left.arrow.right"
        case .criticalPath: return "point.topleft.down.to.point.bottomright.curvepath"
        case .compare: return "square.split.2x1"
        }
    }

    /// The time range highlights Steps and applies to Flow. The Transcript shows the full session, and Critical Path and
    /// Compare analyse whole runs.
    var honorsTimeRange: Bool { self == .steps || self == .flow }
    /// The filter highlights and dims Steps; the other modes do not use it.
    var honorsFilter: Bool { self == .steps }
    /// The mode lays out the detail and raw panes (⌥⌘I) beside its main pane, where they show the selection.
    var hasDerivedInspector: Bool { self == .steps || self == .criticalPath || self == .compare }
}

/// Session · Compare's choices (ANALYSIS-UX §5.1, §5.3), kept in history so Back restores them. Runs A and B come from
/// the scope: A started first, and `swapped` flips the sides without reordering `Scope.sessions`, which would rebuild
/// the event view.
struct CompareNav: Codable, Hashable, Sendable {
    /// The two runs chosen when the scope holds more than two top-level runs; nil compares the two that started first.
    var pair: [String]? = nil
    var swapped = false
    /// Align the runs' subagents too (the engine's default).
    var subagents = true
    /// Actions aligned per run; nil leaves the engine's limit.
    var limit: Int? = nil
}

extension CompareNav {
    private enum Keys: String, CodingKey { case pair, swapped, subagents, limit }

    /// Every field may be missing, so a state another build saved still decodes.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        pair = try c.decodeIfPresent([String].self, forKey: .pair)
        swapped = try c.decodeIfPresent(Bool.self, forKey: .swapped) ?? false
        subagents = try c.decodeIfPresent(Bool.self, forKey: .subagents) ?? true
        limit = try c.decodeIfPresent(Int.self, forKey: .limit)
    }
}

/// The two runs Session · Compare aligns, in the order it shows them (`WindowModel.compareSides`).
struct CompareSides: Hashable, Sendable {
    let a: String
    let b: String
}

/// What Session · Compare finds in the scope (ANALYSIS-UX §5.1), which decides what it shows.
enum CompareScope: Hashable, Sendable {
    /// No session in scope: "No runs selected".
    case empty
    /// Subagents only, no top-level run: Compare offers their whole runs (`WindowModel.useWholeRuns()`).
    case subagents([String])
    /// One top-level run, perhaps with one of its own subagents: the run chooser picks the other run.
    case oneRun(String, withOwnSubagent: Bool)
    /// Two or more top-level runs: `WindowModel.compareSides` names the two Compare aligns.
    case runs([String])
}

/// Compare's alignment table as Go ▸ Next and Previous Difference Region (⌥⌘↓, ⌥⌘↑) see it. The table sets itself as
/// `WindowModel.differenceRegions` while it shows an alignment. The menu reads `canStepDifferenceRegion`, so what it
/// depends on (the regions and the selected row) must be observable for the items to enable and disable as they change.
@MainActor protocol DifferenceRegionNavigating: AnyObject {
    /// Whether a region lies after (`forward`) or before the selected row; the menu item is disabled otherwise.
    func canStepDifferenceRegion(forward: Bool) -> Bool
    /// Select the first row of the next or previous region and scroll it into view.
    func stepDifferenceRegion(forward: Bool)
}

/// What the Lens frame shows: an episode id, a claim's turn id or a delegation's span id.
struct LensItem: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case episode, claim, delegation }
    var kind: Kind
    var id: String
}

/// Time column formats (Wireshark's View ▸ Time Display Format).
enum TimeFormat: String, CaseIterable, Codable, Hashable, Sendable {
    case local, utc, relFirst, deltaPrev, relSession

    var title: String {
        switch self {
        case .local: return "Local Time"
        case .utc: return "UTC"
        case .relFirst: return "Since First Displayed Event"
        case .deltaPrev: return "Since Previous Displayed Event"
        case .relSession: return "Since Session Start"
        }
    }
}

/// The session set and time range of an investigation. Empty `sessions` means all sessions.
struct Scope: Codable, Hashable, Sendable {
    var sessions: [String] = []
    var from: Int64?
    var to: Int64?

    var hasSessions: Bool { !sessions.isEmpty }
    var hasTimeRange: Bool { from != nil || to != nil }
    var isEmpty: Bool { !hasSessions && !hasTimeRange }
}

/// One back/forward history entry: restoring it restores all of it (SPEC §7.8).
struct NavState: Codable, Hashable, Sendable {
    var workspace: Workspace
    /// New in the agent-native build; decodes as nil from older history.
    var sessionMode: SessionMode? = nil
    var scope: Scope
    var filter: String
    var selectedEvent: String?
    var lensItem: LensItem? = nil
    /// New with Session · Compare; decodes as nil from older history.
    var compare: CompareNav? = nil
}

extension NavState {
    private enum Keys: String, CodingKey { case workspace, sessionMode, scope, filter, selectedEvent, lensItem, compare }

    /// Older states name "conversation" or "flow" as their workspace: they become Session in that mode.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let raw = try c.decode(String.self, forKey: .workspace)
        guard let (w, mode) = Workspace.migrate(rawValue: raw) else {
            throw DecodingError.dataCorruptedError(forKey: .workspace, in: c, debugDescription: "unknown workspace \(raw)")
        }
        workspace = w
        sessionMode = try c.decodeIfPresent(SessionMode.self, forKey: .sessionMode) ?? mode
        scope = try c.decode(Scope.self, forKey: .scope)
        filter = try c.decode(String.self, forKey: .filter)
        selectedEvent = try c.decodeIfPresent(String.self, forKey: .selectedEvent)
        lensItem = try c.decodeIfPresent(LensItem.self, forKey: .lensItem)
        compare = try c.decodeIfPresent(CompareNav.self, forKey: .compare)
    }
}

/// The Failures workspace facets (SPEC §12.7).
struct FailureFacets: Codable, Hashable, Sendable {
    var tiers: [FailureTier] = [.failure]
    var outcomes: [EpisodeOutcome] = []
    var families: [FailureFamily] = []
    var agents: [AgentKind] = []
    var roles: [String] = []
    var unattended: Bool?
    var group: QueueGroup = .attention
    /// `attention | recent | impact | attempts | wall | sessions`.
    var sort: String = "attention"
    /// An item matches when any of its events is in the window's view (filter, sessions and time range).
    var matchFilter = true

    var isDefault: Bool { self == FailureFacets() }

    /// Facets that drop items from the queue beyond the tiers: Outcome, Family, Agent, Role and Unattended.
    var narrows: Bool { !outcomes.isEmpty || !families.isEmpty || !agents.isEmpty || !roles.isEmpty || unattended != nil }

    /// "family sandbox · agent Codex": the narrowing facets in words, for the scope label.
    var narrowingWords: String {
        var parts: [String] = []
        if !outcomes.isEmpty { parts.append("outcome " + outcomes.map { DerivedStyle.outcomeWord($0.rawValue) }.joined(separator: ", ")) }
        if !families.isEmpty { parts.append("family " + families.map(\.rawValue).joined(separator: ", ")) }
        if !agents.isEmpty { parts.append("agent " + agents.map(\.label).joined(separator: ", ")) }
        if !roles.isEmpty { parts.append("role " + roles.map { $0.replacingOccurrences(of: "-", with: " ") }.joined(separator: ", ")) }
        if let u = unattended { parts.append(u ? "unattended only" : "attended only") }
        return parts.joined(separator: " · ")
    }
}

/// Wireshark's Apply/Prepare as Filter submenu.
enum FilterCombine: String, CaseIterable, Hashable, Sendable {
    case selected, notSelected, andSelected, orSelected, andNotSelected, orNotSelected

    var title: String {
        switch self {
        case .selected: return "Selected"
        case .notSelected: return "Not Selected"
        case .andSelected: return "…and Selected"
        case .orSelected: return "…or Selected"
        case .andNotSelected: return "…and not Selected"
        case .orNotSelected: return "…or not Selected"
        }
    }

    /// Combine `fragment` with `existing`. With no existing filter, the and/or modes reduce to the fragment.
    func combine(existing: String, fragment: String) -> String {
        let e = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        let f = fragment.trimmingCharacters(in: .whitespacesAndNewlines)
        let negated = "!(\(f))"
        switch self {
        case .selected: return f
        case .notSelected: return negated
        case .andSelected: return e.isEmpty ? f : "(\(e)) && (\(f))"
        case .orSelected: return e.isEmpty ? f : "(\(e)) || (\(f))"
        case .andNotSelected: return e.isEmpty ? negated : "(\(e)) && \(negated)"
        case .orNotSelected: return e.isEmpty ? negated : "(\(e)) || \(negated)"
        }
    }
}

/// Why the entry rule opened Failures (SPEC §12.7 Entry), for the time chip and the scope label.
enum EntrySince: Sendable {
    /// Items newer than the last visit; the time range starts there.
    case lastVisit
    /// The first launch has no last visit, so every item counts and the time range stays open.
    case firstVisit
}

/// Sheets presented by the main window. `Commands` sets `WindowModel.presentedSheet`.
enum SheetKind: String, Identifiable, Hashable, Sendable {
    case goToEvent, saveFilter, exportCapture, keyboardShortcuts, filterSyntax, gettingStarted, reportPreview, splitSignature
    var id: String { rawValue }
}

/// Column sets for the event table (SPEC §7.8 default and Advanced presets).
enum ColumnPreset: String, CaseIterable, Codable, Hashable, Sendable {
    case standard, advanced

    var title: String { self == .standard ? "Default Columns" : "Advanced Columns" }

    /// Column identifiers: no, time, delta, session, agent, actor, kind, proto, tool, model, duration, tokens, tokIn, tokOut, summary.
    var columns: [String] {
        switch self {
        case .standard: return ["no", "time", "session", "kind", "duration", "tokens", "tier", "summary"]
        case .advanced:
            return ["no", "time", "delta", "session", "agent", "actor", "kind", "proto", "tool", "model", "duration", "tokIn",
                    "tokOut", "tier", "summary"]
        }
    }
}

/// Why the current view was (re)built: a refresh keeps scroll position and selection.
enum ViewChangeReason: Hashable, Sendable {
    case query, refresh
}

/// Explicit view states (SPEC §7.8). A workspace that depends on the view shows exactly one of these.
enum ViewPhase: Hashable, Sendable {
    /// The engine is not running yet (or is restarting).
    case waitingForEngine
    case loading
    /// The view could not be built. Workspaces show the error and Retry, and never fall back to global data.
    case failed(APIError)
    /// Built, with no rows.
    case empty
    case ready
}

/// Back/forward over navigation states, like a browser.
@MainActor @Observable final class NavigationHistory {
    private(set) var entries: [NavState] = []
    private(set) var index = -1
    @ObservationIgnored private var lastRecord = Date.distantPast
    static let limit = 100

    var current: NavState? { entries.indices.contains(index) ? entries[index] : nil }
    var canGoBack: Bool { index > 0 }
    var canGoForward: Bool { index + 1 < entries.count }

    /// Record a state. With `coalesce`, a selection change within a second of the previous one replaces it,
    /// so arrowing through rows does not flood the history. Any other change (workspace, Session mode, Compare's sides
    /// and options, scope or filter) is always a new entry, so Back undoes it.
    func record(_ state: NavState, coalesce: Bool = false) {
        defer { lastRecord = Date() }
        guard state != current else { return }
        if coalesce, let cur = current, Date().timeIntervalSince(lastRecord) < 1, Self.onlySelectionDiffers(cur, state) {
            entries[index] = state
            entries.removeSubrange((index + 1)...)
            return
        }
        if index + 1 < entries.count { entries.removeSubrange((index + 1)...) }
        entries.append(state)
        if entries.count > Self.limit { entries.removeFirst(entries.count - Self.limit) }
        index = entries.count - 1
    }

    /// Whether two states differ only in what is selected: the event and the Lens item.
    private static func onlySelectionDiffers(_ a: NavState, _ b: NavState) -> Bool {
        var a = a
        a.selectedEvent = b.selectedEvent
        a.lensItem = b.lensItem
        return a == b
    }

    func back() -> NavState? {
        guard canGoBack else { return nil }
        index -= 1
        return entries[index]
    }

    func forward() -> NavState? {
        guard canGoForward else { return nil }
        index += 1
        return entries[index]
    }

    func reset(to state: NavState) {
        entries = [state]
        index = 0
    }
}
