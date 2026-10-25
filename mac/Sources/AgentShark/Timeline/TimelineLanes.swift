import AppKit

// Analysis lanes of the Timeline (SPEC §12.7 Timeline): process and delegation lanes under a session's span rows, a
// time-bucket strip inside each turn bar, and ticks at unrecovered episodes on the overview's session bars. The data
// comes from /api/processes, /api/delegations, /api/time?turn= and /api/episodes; nothing here is inferred.

/// The process and delegation lanes of one session track.
struct TimelineLanes {
    var processes: [ProcessItem] = []
    var delegations: [DelegationItem] = []

    var isEmpty: Bool { processes.isEmpty && delegations.isEmpty }

    /// Lanes by session: a process belongs to the session that ran it, a delegation to the parent that spawned it.
    static func group(processes: [ProcessItem], delegations: [DelegationItem]) -> [String: TimelineLanes] {
        var out: [String: TimelineLanes] = [:]
        for p in processes { out[p.sessionId, default: TimelineLanes()].processes.append(p) }
        for d in delegations { out[d.sessionId, default: TimelineLanes()].delegations.append(d) }
        return out
    }
}

extension TimelineLayout {
    /// Lanes stay this many rows deep; overlapping bars beyond share the last row.
    static let maxLaneRows = 3

    /// A process bar from its open to its close. With no close logged it is a stub with a dashed end, or, while it
    /// runs, a bar to `openEnd` (the end of its session) with a cap (§7.12 Bar ends).
    static func item(for p: ProcessItem, openEnd: Double) -> TimelineItem {
        let start = Double(p.startTs)
        let exit = p.exitCode.map { " · exit \($0)" } ?? (p.status == "running" ? " · running" : "")
        return TimelineItem(id: "process:" + p.id, start: start, end: max(start, p.endTs.map(Double.init) ?? openEnd), paint: .kind(.toolShell),
                            label: (p.program ?? p.procKey) + exit, isError: (p.exitCode ?? 0) != 0 || p.status == "killed", isBackground: false,
                            ref: .process(p), openEnded: p.endTs == nil, running: p.endTs == nil && p.status == "running")
    }

    /// A delegation bar from the spawn to the result the parent saw, red when the child failed or failed silently.
    static func item(for d: DelegationItem, openEnd: Double) -> TimelineItem {
        let start = Double(d.startTs)
        let name = d.childTitle ?? d.taskExcerpt ?? d.kind
        return TimelineItem(id: "delegation:" + d.id, start: start, end: max(start, d.endTs.map(Double.init) ?? openEnd), paint: .kind(.agent),
                            label: (d.silent ? "silent · " : "") + name, isError: d.outcome.isFailure || d.silent, isBackground: false,
                            ref: .delegation(d), openEnded: d.endTs == nil, running: d.endTs == nil && d.outcome.rawValue == "running")
    }

    /// Lane rows under a track's span rows from `y`, and the lane titles for the header.
    static func laneRows(_ lanes: TimelineLanes, openEnd: Double, y: inout CGFloat) -> (rows: [TimelineRow], labels: [TimelineLaneLabel]) {
        typealias M = TimelineMetrics
        var rows: [TimelineRow] = []
        var labels: [TimelineLaneLabel] = []
        let groups: [(String, [TimelineItem])] = [
            ("Processes", lanes.processes.map { item(for: $0, openEnd: openEnd) }),
            ("Delegations", lanes.delegations.map { item(for: $0, openEnd: openEnd) }),
        ]
        for (title, items) in groups where !items.isEmpty {
            y += M.laneGap
            let lane = pack(items.sorted { $0.start < $1.start }, maxRows: maxLaneRows)
            labels.append(TimelineLaneLabel(y: y, title: title, count: items.count, rows: lane.count))
            for packed in lane {
                rows.append(TimelineRow(items: packed, y: y, h: M.rowHeight, barHeight: M.barHeight))
                y += M.rowHeight
            }
        }
        return (rows, labels)
    }
}

/// The title of a lane in the track header.
struct TimelineLaneLabel: Equatable {
    var y: CGFloat
    var title: String
    var count: Int
    /// Rows the lane stacks into; a bracket ties the rows under its one title (M-08).
    var rows = 1
}

/// Drawing of the analysis overlays.
@MainActor enum TimelineLaneDrawing {
    /// Height of the time-bucket strip at the bottom of a turn bar.
    static let stripHeight: CGFloat = 3
    /// Turn bars narrower than this have no strip (and their times are not requested).
    static let minStripWidth: CGFloat = 12

    /// Segment widths of a turn's buckets across `width`, in bucket order; unattributed time is left blank.
    static func segments(_ t: TimeBreakdown, width: CGFloat) -> [(name: TimeBucketName, x: CGFloat, w: CGFloat)] {
        let total = Double(t.buckets.reduce(Int64(0)) { $0 + max(0, $1.us) } + max(0, t.unattributedUs ?? 0))
        guard total > 0, width > 0 else { return [] }
        var x: CGFloat = 0
        var out: [(TimeBucketName, CGFloat, CGFloat)] = []
        for b in t.buckets where b.us > 0 {
            let w = width * CGFloat(Double(b.us) / total)
            out.append((b.name, x, w))
            x += w
        }
        return out
    }

    /// The strip inside a turn bar `r`.
    static func turnStrip(_ ctx: CGContext, _ t: TimeBreakdown, in r: CGRect) {
        let strip = CGRect(x: r.minX, y: r.maxY - stripHeight, width: r.width, height: stripHeight)
        for s in segments(t, width: strip.width) where s.w >= 0.5 {
            ctx.setFillColor(TimeBar.color(s.name).cgColor)
            ctx.fill(CGRect(x: strip.minX + s.x, y: strip.minY, width: s.w, height: strip.height))
        }
    }

    /// A tick across an overview bar at an unrecovered episode.
    static func tick(_ ctx: CGContext, x: CGFloat, bar r: CGRect) {
        ctx.setFillColor(Theme.err.cgColor)
        ctx.fill(CGRect(x: x - 1, y: r.minY - 2, width: 2, height: r.height + 4))
    }

    /// The lane titles in a track header: "Delegations 96" (§7.12), with a bracket down the rows of a lane that stacks.
    static func header(_ labels: [TimelineLaneLabel], x: CGFloat, width: CGFloat) {
        let h = TimelineMetrics.rowHeight
        for l in labels where l.rows > 1 {
            NSColor.tertiaryLabelColor.setFill()
            NSRect(x: x - 6, y: l.y + 4, width: 1, height: CGFloat(l.rows) * h - 8).fill()
            NSRect(x: x - 6, y: l.y + CGFloat(l.rows) * h - 5, width: 4, height: 1).fill()
        }
        for l in labels {
            let title = l.title + " "
            let tw = TimelineDrawing.width(title, font: Theme.font(.metadata))
            let r = CGRect(x: x, y: l.y, width: width, height: TimelineMetrics.rowHeight)
            TimelineDrawing.text(title, in: r, font: Theme.font(.metadata), color: .secondaryLabelColor)
            TimelineDrawing.text(Formatters.count(l.count), in: r.offsetBy(dx: tw, dy: 0), font: Theme.font(.metadata), color: .tertiaryLabelColor)
        }
    }

    // MARK: Hover

    static func processTip(_ p: ProcessItem) -> NSAttributedString {
        var rows: [(String, String)] = [
            ("Status", p.status + (p.exitCode.map { " · exit \($0)" } ?? "")),
            ("Duration", p.endTs.map { Formatters.duration($0 - p.startTs, src: "derived") } ?? "still running at the last record"),
            ("Start", Formatters.timestamp(p.startTs)),
            ("Polls · inputs", "\(Formatters.count(p.nPolls)) · \(Formatters.count(p.nInputs))"),
        ]
        if let src = p.exitSrc { rows.append(("Exit code", DerivedStyle.provHelp(src, analysis: nil))) }
        rows.append(("", "Click to select its first event · double-click to follow it"))
        return TimelineHUD.content(title: "Process · " + (p.program ?? p.procKey), rows: rows, titleColor: (p.exitCode ?? 0) != 0 ? Theme.err : .labelColor)
    }

    static func delegationTip(_ d: DelegationItem, store: EngineStore) -> NSAttributedString {
        var rows: [(String, String)] = [
            ("Outcome", DerivedStyle.marked(d.outcome.rawValue, d.outcomeSrc) + (d.silent ? " · silent: the parent was not told" : "")),
            ("Child", d.childSession.map { store.title(of: $0) } ?? "not recorded"),
            ("Duration", d.endTs.map { Formatters.duration($0 - d.startTs, src: "derived") } ?? "no result recorded"),
            ("Start", Formatters.timestamp(d.startTs)),
        ]
        if let wait = d.parentWaitUs { rows.append(("Parent waited", Formatters.duration(wait, src: "derived"))) }
        if let task = d.taskExcerpt { rows.append(("Task", String(task.prefix(160)))) }
        rows.append(("", "Click to select the result · double-click to follow the delegation"))
        return TimelineHUD.content(title: "Delegation · " + d.kind, rows: rows, titleColor: d.outcome.isFailure || d.silent ? Theme.err : .labelColor)
    }

    static func turnStripTip(_ t: TimeBreakdown) -> [(String, String)] {
        var rows = t.buckets.filter { $0.us > 0 }.map { ($0.name.rawValue, Formatters.duration($0.us) + ($0.derivedUs > 0 ? " (≈\(Formatters.duration($0.derivedUs)) derived)" : "")) }
        if let u = t.unattributedUs, u > 0 { rows.append(("unattributed", Formatters.duration(u))) }
        return rows
    }
}
