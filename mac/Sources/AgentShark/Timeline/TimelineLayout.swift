import AppKit

// Track layout for the timeline (MAC-SPEC §6, SPEC §7.2). Overview mode lays out one track per project with a bar
// per session, subagents in thin rows beneath their parents. Session mode lays out one track per session of the
// scope tree, each with a density sparkline and span lanes: turns, then model/tool/other spans, then exec items.
// A row keeps its bars sorted by start with a running maximum of their ends, so the bars overlapping a time range
// are found by binary search even when they overlap each other.

enum TimelineMetrics {
    static let headerWidth: CGFloat = 240
    static let rulerHeight: CGFloat = 28
    static let densityHeight: CGFloat = 40
    static let rowHeight: CGFloat = 16
    static let barHeight: CGFloat = 12
    static let subRowHeight: CGFloat = 8
    static let subBarHeight: CGFloat = 6
    /// The optional Context lane under a session's span rows.
    static let contextLaneHeight: CGFloat = 28
    /// Space above each process or delegation lane.
    static let laneGap: CGFloat = 3
    /// Lanes start below the header's two lines, so their titles never overlap the session's.
    static let laneTop: CGFloat = 40
    static let trackTop: CGFloat = 4
    static let sparkHeight: CGFloat = 12
    static let sparkGap: CGFloat = 3
    static let trackBottom: CGFloat = 6
    static let minTrackHeight: CGFloat = 44
    static let collapsedTrackHeight: CGFloat = 28
    static let maxSubRows = 6
    static let indent: CGFloat = 12
    static let maxIndentLevels = 6
    /// Points on each side of a fitted range.
    static let fitPadding: Double = 16
}

/// What a bar's fill encodes: a kind, an agent, or retry/permission status.
enum TimelinePaint: Hashable {
    case kind(Theme.KindColor)
    case agent(AgentKind)
    case warn, note

    var color: NSColor {
        switch self {
        case .kind(let k): return Theme.color(k)
        case .agent(let a): return Theme.agentColor(a)
        case .warn: return Theme.warn
        case .note: return Theme.note
        }
    }
}

/// One bar: a span, a process or a delegation (session mode), or a session (overview).
struct TimelineItem {
    enum Ref {
        case span(SpanRow)
        case session(OverviewSession)
        case process(ProcessItem)
        case delegation(DelegationItem)
    }

    var id: String
    var start: Double
    var end: Double
    var paint: TimelinePaint
    var label: String
    var isError: Bool
    /// Turns are long background spans: drawn lighter so the calls inside them stay readable.
    var isBackground: Bool
    var ref: Ref
    /// No end was logged: the bar is a 24 pt stub with a dashed end, or reaches its session's end with a cap while
    /// `running` (DESIGN.md §7.12 Bar ends).
    var openEnded = false
    var running = false
    var y: CGFloat = 0
    var h: CGFloat = 0

    var span: SpanRow? { if case .span(let s) = ref { return s }; return nil }
    var session: OverviewSession? { if case .session(let s) = ref { return s }; return nil }
    var process: ProcessItem? { if case .process(let p) = ref { return p }; return nil }
    var delegation: DelegationItem? { if case .delegation(let d) = ref { return d }; return nil }
}

struct TimelineRow {
    var y: CGFloat
    var h: CGFloat
    var items: [TimelineItem]
    /// maxEnd[i] = max(items[0...i].end).
    var maxEnd: [Double]

    init(items: [TimelineItem], y: CGFloat, h: CGFloat, barHeight: CGFloat) {
        self.y = y
        self.h = h
        var items = items
        var maxEnd: [Double] = []
        maxEnd.reserveCapacity(items.count)
        var m = -Double.infinity
        let inset = ((h - barHeight) / 2).rounded()
        for i in items.indices {
            m = max(m, items[i].end)
            maxEnd.append(m)
            items[i].y = y + inset
            items[i].h = barHeight
        }
        self.items = items
        self.maxEnd = maxEnd
    }

    /// Index of the first item that can overlap a range starting at `t`.
    func firstIndex(endingAtOrAfter t: Double) -> Int {
        var lo = 0, hi = maxEnd.count
        while lo < hi {
            let m = (lo + hi) / 2
            if maxEnd[m] < t { lo = m + 1 } else { hi = m }
        }
        return lo
    }
}

struct TimelineTrack {
    enum Kind {
        case session(SessionRow, depth: Int)
        case project(name: String, sessions: Int, subagents: Int)
    }

    var id: String
    var kind: Kind
    var y: CGFloat
    var h: CGFloat
    var rows: [TimelineRow]
    /// Session extent with its duration source (session mode).
    var band: (start: Double, end: Double, durSrc: String?)?
    var collapsed: Bool
    /// Sorted start times of the track's calls (everything but turns), for its activity sparkline.
    var activity: [Double] = []
    /// The Context lane (SPEC §12.7 Timeline), when it is shown and the session has context sizes.
    var contextLane: (y: CGFloat, h: CGFloat)?
    /// Titles of the sub-lanes with their counts, for the header (§7.12).
    var laneLabels: [TimelineLaneLabel] = []
    /// The Failures lane: the failure bands of the session, when it has any.
    var bandLane: (y: CGFloat, h: CGFloat)?

    var session: SessionRow? { if case .session(let s, _) = kind { return s }; return nil }
    var depth: Int { if case .session(_, let d) = kind { return d }; return 0 }
    var sparkRect: (y: CGFloat, h: CGFloat)? {
        guard session != nil else { return nil }
        return (collapsed ? y + (h - TimelineMetrics.sparkHeight) / 2 : y + TimelineMetrics.trackTop, TimelineMetrics.sparkHeight)
    }
}

struct TimelineItemPath: Hashable {
    var track: Int
    var row: Int
    var item: Int
}

/// What is under the pointer.
enum TimelineHit: Equatable {
    case header(track: Int, disclosure: Bool)
    case item(TimelineItemPath)
    case gap(TimeGap)
    case track(Int)
    /// A failure band (SPEC §12.7 Timeline): an unrecovered episode, or a recovery that took three or more attempts.
    case band(track: Int, episode: String)
    /// The Context lane of a track, at a time.
    case context(track: Int, t: Double)
}

/// A session of the scope tree in display order.
struct TimelineNode {
    var session: SessionRow
    var depth: Int
}

struct TimelineLayout {
    var tracks: [TimelineTrack] = []
    var height: CGFloat = 0
    /// Item id (span or session id) → where it is drawn.
    var paths: [String: TimelineItemPath] = [:]
    var spanCount = 0

    subscript(path: TimelineItemPath) -> TimelineItem { tracks[path.track].rows[path.row].items[path.item] }

    func item(id: String?) -> TimelineItem? { id.flatMap { paths[$0] }.map { self[$0] } }

    /// Tracks intersecting [top, top + height).
    func visibleTracks(top: CGFloat, height: CGFloat) -> Range<Int> {
        var lo = 0, hi = tracks.count
        while lo < hi {
            let m = (lo + hi) / 2
            if tracks[m].y + tracks[m].h <= top { lo = m + 1 } else { hi = m }
        }
        var end = lo
        while end < tracks.count, tracks[end].y < top + height { end += 1 }
        return lo..<end
    }

    /// The bar nearest to x (within 3 pt) in the row under y. `x` is in plot coordinates.
    func hitItem(trackIndex: Int, y: CGFloat, x: Double, scale: TimeScale) -> TimelineItemPath? {
        let track = tracks[trackIndex]
        guard let r = track.rows.firstIndex(where: { y >= $0.y && y < $0.y + $0.h }) else { return nil }
        let row = track.rows[r]
        let t = scale.t(x), tA = scale.t(x - 3), tB = scale.t(x + 3)
        var best: Int?
        var bestD = Double.infinity
        var i = row.firstIndex(endingAtOrAfter: tA)
        while i < row.items.count {
            let it = row.items[i]
            if it.start > tB { break }
            if it.end >= tA {
                let d = t < it.start ? it.start - t : (t > it.end ? t - it.end : 0)
                if d < bestD || (d == bestD && best.map { it.end - it.start < row.items[$0].end - row.items[$0].start } == true) {
                    best = i
                    bestD = d
                }
            }
            i += 1
        }
        return best.map { TimelineItemPath(track: trackIndex, row: r, item: $0) }
    }

    // MARK: Building

    /// First-fit packing of start-sorted items into non-overlapping rows; overflow shares the last row.
    static func pack(_ items: [TimelineItem], maxRows: Int) -> [[TimelineItem]] {
        var rows: [[TimelineItem]] = []
        var ends: [Double] = []
        for it in items {
            var r = ends.firstIndex { $0 <= it.start } ?? -1
            if r < 0 {
                if rows.count < maxRows {
                    r = rows.count
                    rows.append([])
                    ends.append(-.infinity)
                } else {
                    r = rows.count - 1
                }
            }
            rows[r].append(it)
            ends[r] = max(ends[r], it.end)
        }
        return rows
    }

    private mutating func index(_ trackIndex: Int) {
        for (r, row) in tracks[trackIndex].rows.enumerated() {
            for (i, it) in row.items.enumerated() { paths[it.id] = TimelineItemPath(track: trackIndex, row: r, item: i) }
        }
    }

    /// Session mode: a track per node; collapsed tracks show only their summary and hide their descendants. Under the
    /// span rows come the session's process and delegation lanes (`lanes`), then a Context lane for sessions in
    /// `contextLanes`.
    static func sessions(_ nodes: [TimelineNode], spans: [SpanRow], collapsed: Set<String>, contextLanes: Set<String> = [],
                         lanes: [String: TimelineLanes] = [:], bands: [String: Int] = [:]) -> TimelineLayout {
        typealias M = TimelineMetrics
        var bySession: [String: [SpanRow]] = [:]
        for sp in spans { bySession[sp.session, default: []].append(sp) }
        var layout = TimelineLayout()
        var y: CGFloat = 0
        var hiddenUnder: Int?
        for node in nodes {
            if let depth = hiddenUnder {
                if node.depth > depth { continue }
                hiddenUnder = nil
            }
            let s = node.session
            let isCollapsed = collapsed.contains(s.id)
            if isCollapsed { hiddenUnder = node.depth }
            var band: (start: Double, end: Double, durSrc: String?)? = s.start.map { (Double($0), Double(s.end ?? $0), nil) }
            var levels: [[TimelineItem]] = [[], [], []]
            var activity: [Double] = []
            for sp in bySession[s.id] ?? [] {
                if sp.kind == .session {
                    band = (Double(sp.start), Double(sp.end ?? sp.start), sp.durSrc)
                    continue
                }
                layout.spanCount += 1
                let level = sp.kind == .turn ? 0 : (sp.kind == .exec || sp.kind == .phase ? 2 : 1)
                levels[level].append(item(for: sp))
                if level > 0 { activity.append(Double(sp.start)) }
            }
            var rows: [TimelineRow] = []
            var lane: (y: CGFloat, h: CGFloat)?
            var bandLane: (y: CGFloat, h: CGFloat)?
            var laneLabels: [TimelineLaneLabel] = []
            let height: CGFloat
            if isCollapsed {
                height = M.collapsedTrackHeight
            } else {
                // Sub-lanes start below the header's two lines, so each can carry its title and count (§7.12).
                var ry = y + M.laneTop
                if let n = bands[s.id], n > 0 {
                    laneLabels.append(TimelineLaneLabel(y: ry, title: "Failures", count: n))
                    bandLane = (ry, M.rowHeight)
                    ry += M.rowHeight + M.laneGap
                }
                for (level, items) in levels.enumerated() {
                    if level > 0 && items.isEmpty { continue }
                    let sorted = items.sorted { $0.start < $1.start }
                    let lane = sorted.isEmpty ? [[]] : pack(sorted, maxRows: M.maxSubRows)
                    if !items.isEmpty {
                        laneLabels.append(TimelineLaneLabel(y: ry, title: ["Turns", "Calls", "Exec"][level], count: items.count, rows: lane.count))
                    }
                    for packed in lane {
                        rows.append(TimelineRow(items: packed, y: ry, h: M.rowHeight, barHeight: M.barHeight))
                        ry += M.rowHeight
                    }
                }
                if let l = lanes[s.id], !l.isEmpty {
                    let built = laneRows(l, openEnd: band?.end ?? Double(s.end ?? s.start ?? 0), y: &ry)
                    rows += built.rows
                    laneLabels += built.labels
                }
                if contextLanes.contains(s.id) {
                    lane = (ry + 3, M.contextLaneHeight)
                    ry += M.contextLaneHeight + 3
                }
                height = max(M.minTrackHeight, ry - y + M.trackBottom)
            }
            let index = layout.tracks.count
            layout.tracks.append(TimelineTrack(id: s.id, kind: .session(s, depth: node.depth),
                                               y: y, h: height, rows: rows, band: band, collapsed: isCollapsed, activity: activity.sorted(),
                                               contextLane: lane, laneLabels: laneLabels, bandLane: bandLane))
            layout.index(index)
            y += height
        }
        layout.height = y
        return layout
    }

    /// Overview: a track per project (most recently active first), sessions packed into rows, subagents in thin
    /// rows beneath the row of their root session. A collapsed project shows its sessions in one row.
    static func overview(_ sessions: [OverviewSession], collapsed: Set<String>) -> TimelineLayout {
        typealias M = TimelineMetrics
        let byID = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var kids: [String: [OverviewSession]] = [:]
        var roots: [OverviewSession] = []
        for s in sessions {
            if let p = s.parentId, p != s.id, byID[p] != nil { kids[p, default: []].append(s) } else { roots.append(s) }
        }
        func descendants(_ s: OverviewSession) -> [OverviewSession] {
            var out: [OverviewSession] = []
            var stack = kids[s.id] ?? []
            var seen: Set<String> = []
            while let c = stack.popLast() {
                guard seen.insert(c.id).inserted else { continue }
                out.append(c)
                stack += kids[c.id] ?? []
            }
            return out
        }
        var groups: [String: [OverviewSession]] = [:]
        for r in roots { groups[r.project ?? "(no project)", default: []].append(r) }
        func lastEnd(_ list: [OverviewSession]) -> Int64 { list.map { $0.end ?? $0.start ?? 0 }.max() ?? 0 }
        let ordered = groups.sorted { lastEnd($0.value) > lastEnd($1.value) || (lastEnd($0.value) == lastEnd($1.value) && $0.key < $1.key) }

        var layout = TimelineLayout()
        var y: CGFloat = 0
        for (project, members) in ordered {
            let isCollapsed = collapsed.contains(project)
            let items = members.map(item(for:)).sorted { $0.start < $1.start }
            var rows: [TimelineRow] = []
            var ry = y + M.trackTop + 2
            var subCount = 0
            for track in isCollapsed ? [items] : pack(items, maxRows: .max) {
                rows.append(TimelineRow(items: track, y: ry, h: M.rowHeight, barHeight: M.barHeight))
                ry += M.rowHeight
                let subs = track.flatMap { $0.session.map(descendants) ?? [] }.map(item(for:)).sorted { $0.start < $1.start }
                subCount += subs.count
                if isCollapsed { continue }
                for packed in subs.isEmpty ? [] : pack(subs, maxRows: M.maxSubRows) {
                    rows.append(TimelineRow(items: packed, y: ry, h: M.subRowHeight, barHeight: M.subBarHeight))
                    ry += M.subRowHeight
                }
            }
            let height = max(M.minTrackHeight, ry - y + M.trackBottom)
            let index = layout.tracks.count
            layout.tracks.append(TimelineTrack(id: "project:" + project, kind: .project(name: project, sessions: members.count, subagents: subCount),
                                               y: y, h: height, rows: rows, band: nil, collapsed: isCollapsed))
            layout.index(index)
            y += height
        }
        layout.height = y
        return layout
    }

    // MARK: Items

    static func item(for sp: SpanRow) -> TimelineItem {
        let start = Double(sp.start)
        let end = Double(sp.end ?? sp.dur.map { sp.start + $0 } ?? sp.start)
        return TimelineItem(id: sp.id, start: start, end: max(end, start), paint: paint(for: sp), label: sp.name.isEmpty ? sp.kind.rawValue : sp.name,
                            isError: sp.status == .error, isBackground: sp.kind == .turn, ref: .span(sp))
    }

    static func item(for s: OverviewSession) -> TimelineItem {
        let start = Double(s.start ?? 0)
        let title = s.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        return TimelineItem(id: s.id, start: start, end: max(Double(s.end ?? s.start ?? 0), start), paint: .agent(s.agent),
                            label: title?.isEmpty == false ? title! : TimelineText.shortID(s.id), isError: false, isBackground: false,
                            ref: .session(s))
    }

    /// The tool kind of a tool span (`shell`, `file`, …): the logged kind, else from its name.
    static func toolKind(of sp: SpanRow) -> String? {
        sp.attrs?["tool"]?["kind"]?.stringValue ?? ToolKinds.kind(of: sp.attrs?["tool"]?["name"]?.stringValue ?? sp.name)
    }

    static func paint(for sp: SpanRow) -> TimelinePaint {
        switch sp.kind {
        case .turn: return .kind(.user)
        case .llm: return .kind(.llm)
        case .tool:
            if sp.linkSession != nil { return .kind(.agent) }
            switch toolKind(of: sp) {
            case "shell": return .kind(.toolShell)
            case "file": return .kind(.toolFile)
            case "web": return .kind(.toolWeb)
            case "mcp": return .kind(.toolMcp)
            case "agent": return .kind(.agent)
            default: return .kind(.toolOther)
            }
        case .exec: return .kind(.toolShell)
        case .workflow, .phase: return .kind(.agent)
        case .compaction: return .kind(.compaction)
        case .hook: return .kind(.hook)
        case .retry: return .warn
        case .permission: return .note
        default: return .kind(.context)
        }
    }
}

/// Short strings shared by the timeline and flow views.
enum TimelineText {
    /// `cc:8c1e2f3a` for a session ID, the last part of other IDs.
    static func shortID(_ id: String) -> String {
        if let colon = id.firstIndex(of: ":"), !id.contains("#") {
            let prefix = id[..<colon]
            let rest = id[id.index(after: colon)...]
            let tail = rest.split(separator: "/").last.map(String.init) ?? String(rest)
            return "\(prefix):\(tail.prefix(8))"
        }
        return String(id.split(separator: ":").last ?? Substring(id)).prefix(12).description
    }

    /// "Tool call", "Model call", … for a span kind.
    static func spanKind(_ sp: SpanRow) -> String {
        switch sp.kind {
        case .session: return "Session"
        case .turn: return "Turn"
        case .llm: return "Model call"
        case .tool: return sp.linkSession != nil ? "Subagent call" : "Tool call"
        case .exec: return "Execution"
        case .workflow: return "Workflow"
        case .phase: return "Workflow phase"
        case .compaction: return "Compaction"
        case .hook: return "Hook"
        case .retry: return "Retry"
        case .permission: return "Permission"
        default: return sp.kind.rawValue.capitalized
        }
    }

    /// "Error", "Cancelled", … for a span status.
    static func status(_ s: SpanStatus) -> String {
        switch s {
        case .ok: return "OK"
        case .error: return "Error"
        case .cancelled: return "Cancelled"
        case .interrupted: return "Interrupted"
        case .open: return "Open (no end recorded)"
        default: return "Unknown"
        }
    }

    /// A span's duration with its provenance glyph, or "—".
    static func duration(_ sp: SpanRow) -> String {
        Formatters.duration(sp.dur ?? sp.end.map { $0 - sp.start }, src: sp.dur == nil && sp.end != nil ? "derived" : sp.durSrc)
    }

    /// The filter fragment that selects a span's events: turns by `turn`, other spans by `span`.
    static func filterFragment(_ sp: SpanRow) -> String {
        (sp.kind == .turn ? "turn == " : "span == ") + FilterExpression.quote(sp.id)
    }

    /// "subagent", "workflow agent", … (nil for main sessions).
    static func roleBadge(_ role: String) -> String? {
        role == "main" ? nil : role.replacingOccurrences(of: "-", with: " ")
    }
}
