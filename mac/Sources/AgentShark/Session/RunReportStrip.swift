import AppKit
import SwiftUI

/// The Run report strip at the top of Session · Steps (DESIGN.md §7.8): a title line (disclosure, session title, Finished,
/// Live or Stalled, unattended), a summary line of Plain items, and the time bar labeled with the time in turns and the
/// run's span. The disclosure collapses the strip to its title line and the choice persists. Summary items that do not
/// fit move into a trailing More menu, interventions first, then files, peak context, the subagent breakdown and turns;
/// while the line still does not fit, the recovery, impact, claim, silent-child and alarm items follow, failed last.
/// The step count never moves. In a narrow pane the time bar shrinks first, to `minBarWidth`; then the summary line
/// folds. Nothing is cut, and the In turns label and Critical Path stay whole.
struct RunReportStrip: View {
    let model: WindowModel
    let report: RunReport
    var onBucket: ((TimeBucketName) -> Void)?
    @AppStorage("AgentShark.runReportCollapsed") private var collapsed = false

    /// The time bar's narrowest width (ANALYSIS-UX §3.6).
    static let minBarWidth: CGFloat = 120

    private var analysis: AnalysisStatus? { model.info?.analysis }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            titleLine
            if !collapsed {
                summaryLine
                if report.time.buckets.contains(where: { $0.us > 0 }) { barLine }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Time bar line

    /// "In turns 7m 13s of 30m 30s ▬▬▬ Critical Path": the bar takes what the label and the link leave, down to
    /// `minBarWidth`.
    var barLine: some View {
        HStack(spacing: 8) {
            Text(Self.inTurnsText(report))
                .font(Theme.fontSwiftUI(.rowSecondary))
                .foregroundStyle(.secondary)
                .fixedSize()
                .help(Self.inTurnsHelp(report, ownTurns: model.sessionsByID[report.run.session]?.nTurns,
                                       subagents: !(model.childrenByParent[report.run.session] ?? []).isEmpty)
                      + "\n" + TimeLegend.criticalPathNote)
            TimeBar(time: report.time, span: Self.shownSpan(report), onBucket: onBucket)
                .frame(minWidth: Self.minBarWidth)
                .frame(height: 8)
            // The same run's critical path, as a text button on this row so the strip gains no row (ANALYSIS-UX §3.6).
            Button("Critical Path") { model.sessionMode = .criticalPath }
                .buttonStyle(.link)
                .font(Theme.fontSwiftUI(.rowSecondary))
                .fixedSize()
                .help("Session ▸ Critical Path (\(AgentSharkCommands.modeShortcut(.criticalPath).keys))")
        }
    }

    /// The run's span from its first to its last event, subagents included: the inspector's Duration.
    static func runSpan(_ report: RunReport) -> Int64? {
        guard let start = report.run.start, let end = report.run.end, end >= start else { return nil }
        return end - start
    }

    /// The span the In turns label names and the time bar's track stands for: the run's, except in a report since a
    /// time range, which sums only its turns and shows no span.
    static func shownSpan(_ report: RunReport) -> Int64? {
        report.since == nil ? runSpan(report) : nil
    }

    /// "In turns 7m 13s of 30m 30s": the engine's sum of the turns' wall times, which leaves out the time between
    /// turns, then the run's span (`shownSpan`).
    static func inTurnsText(_ report: RunReport) -> String {
        "In turns " + (report.time.wallUs.map { Formatters.duration($0) } ?? Formatters.missing)
            + (shownSpan(report).map { " of " + Formatters.duration($0) } ?? "")
    }

    /// What the In turns figure sums and what it leaves out. The engine sums the session's own turns (`ownTurns` of
    /// them unless the report covers a time range); a subagent's time is in them only as its parent's waiting.
    static func inTurnsHelp(_ report: RunReport, ownTurns: Int?, subagents: Bool) -> String {
        let count = report.since == nil ? ownTurns.map { Formatters.count($0) + " " } ?? "" : ""
        let since = report.since.map { " since " + Formatters.shortDateTime($0) } ?? ""
        var text = "Wall time of " + (subagents ? "the session's " : "the run's ") + count + "turns" + since + ", summed."
        if subagents { text += " Its subagents' turns are not added; the time it waited on them is." }
        var between: [String] = []
        if let us = report.time.humanGapUs, us > 0 { between.append(Formatters.duration(us) + " between prompts") }
        if let us = report.time.continuationUs, us > 0 { between.append(Formatters.duration(us) + " idle") }
        let span = runSpan(report).map { "the run spans \(Formatters.duration($0)) from its first to its last event." }
        if !between.isEmpty {
            text += " The time between turns (" + between.joined(separator: ", ") + ") is in no turn" + (span.map { "; " + $0 } ?? ".")
        } else if let span {
            text += " " + span.prefix(1).uppercased() + span.dropFirst()
        }
        return text
    }

    // MARK: Title line

    private var titleLine: some View {
        HStack(spacing: 8) {
            Button {
                collapsed.toggle()
            } label: {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14)
            }
            .buttonStyle(.plain)
            .iconHelp(collapsed ? "Show the run report" : "Collapse the run report to its title")
            // Named as the scope token and the window title name the run: "Untitled · cx:0190a0…0001", never its id alone.
            let title = report.run.title ?? model.runTitle(of: report.run.root)
            Text(AnalysisVocabulary.runLabel(title: title, id: report.run.root))
                .font(Theme.fontSwiftUI(.title))
                .lineLimit(1)
                .truncationMode(.tail)
                .help(AnalysisVocabulary.runHelp(title: title, id: report.run.root))
            status
            // The report covers what happened since the time range's start, so its counts can be fewer than the
            // header's steps; the strip says so (M-07, as the web does).
            if let since = report.since {
                Text("since " + Formatters.shortDateTime(since) + (model.entrySince == .lastVisit ? " (last visit)" : ""))
                    .font(Theme.fontSwiftUI(.rowSecondary))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .help("The report counts the evidence at or after \(Formatters.timestamp(since)); the header counts every step")
            }
            if report.run.unattended {
                Text("unattended").font(Theme.fontSwiftUI(.rowSecondary)).foregroundStyle(.secondary)
                    .help("No human was watching: a subagent, an active goal, or approval set to never.")
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder private var status: some View {
        Group {
            if report.stall.turnOpen, let s = report.stall.stalledForS, s >= 60 {
                PlainMark(mark: .interrupted, text: "Stalled \(Formatters.duration(Int64(s * 1e6)))", color: Theme.warn,
                          help: "The open turn has written nothing for this long, and it is not waiting on a running process or a question.")
            } else if report.run.isLive {
                PlainMark(mark: .live, text: "Live", color: .controlAccentColor,
                          help: "The run's newest event is less than a minute old; counts can still change.")
            } else {
                Text("Finished").foregroundStyle(.secondary).help(report.run.end.map { "Last event \(Formatters.timestamp($0))" } ?? "")
            }
        }
        .font(Theme.fontSwiftUI(.rowSecondary))
        .fixedSize()
    }

    // MARK: Summary line

    struct Item: Identifiable {
        let id: String
        let text: String
        var mark: Mark?
        var color: NSColor = .secondaryLabelColor
        var help: String = ""
        var action: (() -> Void)?
    }

    /// Item ids in the order they move into More: the counts first, then, while the line still does not fit, the
    /// attention items from the least alarming, failed last. The step count never moves.
    static let moveOrder = ["interventions", "files", "context", "subagents", "turns",
                            "impact-recovered", "impact-masked", "impact-degraded", "impact-interrupted", "impact-blocked",
                            "claims", "silent", "alarms", "impact-failed"]

    /// The session's own steps while Steps leaves its subagents out and the report covers the same whole run.
    private var ownSteps: Int? {
        let steps = model.steps
        return steps.descendants || report.since != nil || report.run.session != steps.sessionID ? nil : steps.total
    }

    /// "79 steps", or "79 steps (65 + 14 in subagents)" when the session's `own` steps are fewer.
    static func stepsText(_ total: Int, own: Int?) -> String {
        let text = Formatters.count(total, "step")
        guard let own, own > 0, total > own else { return text }
        return text + " (\(Formatters.count(own)) + \(Formatters.count(total - own)) in subagents)"
    }

    /// Every summary item, in reading order.
    private var items: [Item] {
        let steps = model.steps
        let narrow: () -> Void = { steps.onlyFailed = true }
        var out: [Item] = [Item(id: "turns", text: Formatters.count(report.turns.total, "turn"), help: "Turns of the run, its subagents included")]
        out.append(Item(id: "steps", text: Formatters.count(report.steps.total, "step"), help: "Steps of the run, its subagents included"))
        if let own = ownSteps, own > 0, report.steps.total > own {
            out.append(Item(id: "subagents", text: "\(Formatters.count(own)) + \(Formatters.count(report.steps.total - own)) in subagents",
                            help: "This session's own steps and its subagents' steps"))
        }
        for i in TurnImpact.known where i.isProblem || i == .recovered {
            if let n = report.impact[i.rawValue], n > 0 {
                out.append(Item(id: "impact-" + i.rawValue, text: "\(Formatters.count(n)) \(i.rawValue)", mark: Mark.impact(i),
                                color: i.isProblem ? DerivedStyle.impactColor(i) : .secondaryLabelColor,
                                help: "Turns whose worst impact is \(i.rawValue). Click to show only turns with failures.", action: narrow))
            }
        }
        if report.claims.unverified > 0 {
            out.append(Item(id: "claims", text: Formatters.count(report.claims.unverified, "unverified claim"), mark: .claim, color: Theme.warn,
                            help: "Final messages that claim success without a passing test after the last edit"))
        }
        if report.delegations.silent > 0 {
            out.append(Item(id: "silent", text: "\(Formatters.count(report.delegations.silent)) silent", mark: .silentChild, color: Theme.err,
                            help: "Children that failed or were blocked without the parent being told"))
        }
        let firing = report.alarms.filter { $0.state == .firing }.count
        if firing > 0 {
            out.append(Item(id: "alarms", text: Formatters.count(firing, "alarm"), mark: .alarm, color: Theme.err, help: "Alarms firing in this run"))
        }
        if let peak = report.context.peakTokens {
            out.append(Item(id: "context", text: "peak context \(Formatters.tokens(peak))" + (report.context.window.map { " of " + Formatters.tokens($0) } ?? "")
                                + (report.context.windowSrc?.mark ?? ""),
                            help: "The largest context of any step. " + DerivedStyle.provHelp(report.context.windowSrc, analysis: analysis)))
        }
        if report.changes.files > 0 {
            out.append(Item(id: "files", text: "\(Formatters.count(report.changes.files, "file")) +\(report.changes.added) −\(report.changes.removed)",
                            help: report.changes.shellMentions > 0 ? "Plus \(report.changes.shellMentions) shell mentions; shell edits are not tracked." : "Shell edits are not tracked."))
        }
        let interventions = InterventionStyle.summary(report.interventions)
        if !interventions.isEmpty {
            out.append(Item(id: "interventions", text: interventions,
                            help: "Interventions in this run: interrupts, rejections, questions, external edits and corrections. Associations, never failure causes."))
        }
        return out
    }

    /// The summary line's layouts, widest first, each the ids of the items in More: the items present move one at a
    /// time in `moveOrder`, so nothing on the line is cut to a tooltip (DESIGN.md §10.1). The first that fits shows.
    static func folds(itemIDs: [String]) -> [[String]] {
        let order = moveOrder.filter(itemIDs.contains)
        return (0...order.count).map { Array(order.prefix($0)) }
    }

    private var summaryLine: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(Self.folds(itemIDs: items.map(\.id)), id: \.self) { summary(moving: $0) }
        }
    }

    /// The summary line with the `moving` items in More, which lists them in reading order.
    private func summary(moving: [String]) -> some View {
        let all = items
        let shown = all.filter { !moving.contains($0.id) }
        let hidden = all.filter { moving.contains($0.id) }
        return HStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { i, item in
                if i > 0 { Text(item.id == "subagents" ? " " : " · ").foregroundStyle(.tertiary) }
                itemView(item, wrapped: item.id == "subagents")
            }
            if !hidden.isEmpty {
                Menu("More") {
                    ForEach(hidden) { item in menuEntry(item) }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .padding(.leading, 8)
                .help(hidden.map(\.text).joined(separator: " · "))
            }
        }
        .font(Theme.fontSwiftUI(.rowSecondary))
        .lineLimit(1)
        .fixedSize()
    }

    /// A More entry: the item's mark and text, running the item's action as the item on the line does.
    @ViewBuilder private func menuEntry(_ item: Item) -> some View {
        let label = Label {
            Text(item.text)
        } icon: {
            if let mark = item.mark { Image(systemName: mark.symbol) }
        }
        if let action = item.action {
            Button(action: action) { label }.help(item.help)
        } else {
            label
        }
    }

    @ViewBuilder private func itemView(_ item: Item, wrapped: Bool) -> some View {
        let text = wrapped ? "(" + item.text + ")" : item.text
        let label = PlainMark(mark: item.mark, text: text, color: item.color, help: item.help)
        if let action = item.action {
            Button(action: action) { label }.buttonStyle(.plain)
        } else {
            label
        }
    }
}

/// A stacked bar of wall time by bucket (SPEC §12.3.9); derived parts are hatched and unattributed time is grey.
/// Clicking a segment narrows the step list to that bucket.
struct TimeBar: View {
    let time: TimeBreakdown
    /// What the whole track stands for, in µs: the run's span beside "In turns 7m 13s of 30m 30s". The buckets then fill
    /// 7m 13s of the track and its outlined rest, the span outside the turns, stays unfilled, so the fill is the ratio
    /// the label states. Nil lets the buckets fill the track, as beside a wall time alone.
    var span: Int64? = nil
    var onBucket: ((TimeBucketName) -> Void)?

    /// The time the buckets and unattributed time account for, which the engine sums to the turns' wall time.
    static func accounted(_ time: TimeBreakdown) -> Int64 {
        time.buckets.reduce(Int64(0)) { $0 + $1.us } + (time.unattributedUs ?? 0)
    }

    /// The turns' wall time, the In turns label's figure.
    static func inTurns(_ time: TimeBreakdown) -> Int64 {
        time.wallUs ?? accounted(time)
    }

    /// The share of the track the buckets fill: the turns' wall time of `span`, the whole track without one, and never
    /// more than the whole.
    static func filledShare(_ time: TimeBreakdown, span: Int64?) -> Double {
        guard let span, span > 0 else { return 1 }
        return min(1, Double(inTurns(time)) / Double(span))
    }

    /// A bucket's colour. The critical path's own buckets (`human-gap`, `continuation`, `coordination`, `unattributed`)
    /// take their class's colour (AnalysisVocabulary); a bucket this client does not know is neutral, so unknown time
    /// never reads as model time.
    static func color(_ b: TimeBucketName) -> NSColor {
        switch b.rawValue {
        case "model": return Theme.color(.llm)
        case "wait-human", "human-gap": return Theme.color(.user)
        case "wait-agent", "coordination": return Theme.color(.agent)
        case "wait-process": return Theme.color(.toolShell)
        case "api-retry": return Theme.warn
        case "compaction": return Theme.color(.compaction)
        case "hook": return Theme.color(.hook)
        case "tool": return Theme.color(.toolOther)
        case "continuation": return idle
        case "unattributed": return neutral
        default: return neutral
        }
    }

    /// Unattributed time, and any bucket this client does not know: `secondaryLabelColor` at 20% of its alpha, as
    /// SwiftUI's `Color.secondary.opacity(0.2)`. A system color's `withAlphaComponent` resolves it once, so the
    /// provider resolves it per appearance.
    static let neutral = NSColor(name: nil) { appearance in
        var base = NSColor.secondaryLabelColor
        appearance.performAsCurrentDrawingAppearance { base = NSColor.secondaryLabelColor.usingColorSpace(.sRGB) ?? base }
        return base.withAlphaComponent(base.alphaComponent * 0.2)
    }

    /// Idle time between turns that no person started (`continuation`): the neutral quaternary fill (ANALYSIS-UX §4.7).
    /// It has about a quarter of the unattributed grey's alpha, so the two stay apart wherever both are drawn solid.
    static let idle = NSColor.quaternarySystemFill

    var body: some View {
        GeometryReader { geo in
            let filled = geo.size.width * CGFloat(Self.filledShare(time, span: span))
            let total = Double(max(1, Self.accounted(time)))
            ZStack(alignment: .leading) {
                if filled < geo.size.width {
                    // The span outside the turns: an outline, apart from the grey fill of unattributed time in them.
                    RoundedRectangle(cornerRadius: 2).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1)
                }
                HStack(spacing: 0) {
                    ForEach(time.buckets.filter { $0.us > 0 }, id: \.name) { b in
                        segment(b, width: filled * CGFloat(Double(b.us) / total))
                    }
                    if (time.unattributedUs ?? 0) > 0 {
                        Rectangle().fill(Self.neutral.swiftUI)
                            .frame(width: filled * CGFloat(Double(time.unattributedUs ?? 0) / total))
                            .help("Unattributed \(Formatters.duration(time.unattributedUs ?? 0)): no bucket claims it; never counted as model time")
                    }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: 2))
        }
        .help(TimeLegend.text(time, span: span))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(TimeLegend.accessibilityLabel(time, span: span))
    }

    private func segment(_ b: TimeBucket, width: CGFloat) -> some View {
        let color = Self.color(b.name).swiftUI
        let derivedShare = b.us > 0 ? CGFloat(Double(b.derivedUs) / Double(b.us)) : 0
        return ZStack(alignment: .trailing) {
            Rectangle().fill(color.opacity(0.85))
            if derivedShare > 0 {
                Hatch().fill(Color.primary.opacity(0.35))
                    .frame(width: width * derivedShare)
            }
        }
        .frame(width: max(0, width))
        .contentShape(Rectangle())
        .onTapGesture { onBucket?(b.name) }
        .help(TimeLegend.segmentHelp(b) + (onBucket == nil ? "" : "\nClick to show only steps with this time."))
    }
}

/// The key of a stacked time bar, as words: bucket names and the bar's tooltip and text equivalent.
enum TimeLegend {
    /// A bucket in lower case, for the middle of a sentence ("Only steps with waiting for a human time"). The turn-time
    /// buckets are the web viewer's `TIME_BUCKET`; the critical path's own are the Workbench's `BUCKET_NAME`.
    static func name(_ b: TimeBucketName) -> String {
        switch b.rawValue {
        case "wait-human": return "waiting for a human"
        case "wait-agent": return "waiting for a subagent"
        case "wait-process": return "waiting for a process"
        case "api-retry": return "API retries"
        case "hook": return "hooks"
        case "tool": return "tools (includes any approval wait)"
        case "human-gap": return "between prompts"
        case "continuation": return "idle between turns"
        case "coordination": return "waiting on other agents"
        case "unattributed": return "unattributed"
        default: return b.rawValue.replacingOccurrences(of: "-", with: " ")
        }
    }

    /// A bucket at the start of a line, in sentence case (DESIGN.md §9): "Waiting for a human", "API retries".
    static func label(_ b: TimeBucketName) -> String {
        let n = name(b)
        return n.prefix(1).uppercased() + n.dropFirst()
    }

    /// A segment's tooltip: "Model: 3.21s (logged 2s, derived 1.21s≈)". The mark follows the derived value and a
    /// measured zero carries none (DESIGN.md §9 Provenance and Durations).
    static func segmentHelp(_ b: TimeBucket) -> String {
        let derived = Formatters.duration(b.derivedUs) + (b.derivedUs > 0 ? "≈" : "")
        let line = "\(label(b.name)): \(Formatters.duration(b.us)) (logged \(Formatters.duration(b.loggedUs)), derived \(derived))"
        return b.name == "wait-agent" ? line + "\n" + subagentWaitNote : line
    }

    /// The bar draws waiting for a subagent in the color of Critical Path's Waiting on other agents, its class there,
    /// which holds less time: the path follows a wait into the subagent it waited on (`attribute` in
    /// src/workbench/perf.ts). The segment's tooltip says so.
    static let subagentWaitNote = "Critical Path counts the subagent's own time in place of this wait while the subagent ran, and the rest as Waiting on other agents."

    /// The span outside the turns, which the bar's track leaves unfilled beside `span`; nil when the turns fill it.
    static func outsideTurns(_ time: TimeBreakdown, span: Int64?) -> Int64? {
        guard let span else { return nil }
        let outside = span - TimeBar.inTurns(time)
        return outside > 0 ? outside : nil
    }

    /// The bar's text equivalent (DESIGN.md §10.3): "Time by bucket: model 40s, unattributed 20s", then beside a span
    /// "; outside turns 23m 17s of the 30m 30s span".
    static func accessibilityLabel(_ time: TimeBreakdown, span: Int64? = nil) -> String {
        "Time by bucket: " + parts(time).map { name($0.0) + " " + Formatters.duration($0.1) }.joined(separator: ", ")
            + (outsideTurns(time, span: span).map { "; outside turns \(Formatters.duration($0)) of the \(Formatters.duration(span ?? 0)) span" } ?? "")
    }

    /// The legend as the bar's tooltip (§7.8: the legend has no row), and how the bar differs from the critical path.
    static func text(_ time: TimeBreakdown, span: Int64? = nil) -> String {
        var lines = parts(time).map { label($0.0) + " " + Formatters.duration($0.1) }
        if let outside = outsideTurns(time, span: span) {
            lines.append("Outside turns \(Formatters.duration(outside)): the unfilled rest of the \(Formatters.duration(span ?? 0)) span")
        }
        if time.buckets.contains(where: { $0.derivedUs > 0 }) { lines.append("Hatched parts are derived from timestamps.") }
        lines.append("Click a segment to show only the steps with that time.")
        lines.append(criticalPathNote)
        return lines.joined(separator: "\n")
    }

    /// How the bar differs from Session · Critical Path (ANALYSIS-UX §3.6). The segments' own tooltips cover the bar,
    /// so the Run report's In turns label carries it too.
    static let criticalPathNote = "The bar sums wall time by bucket. Critical Path follows the one chain of waits that set the run's length."

    /// The bar's buckets with time, then its unattributed time.
    private static func parts(_ time: TimeBreakdown) -> [(TimeBucketName, Int64)] {
        let unattributed = time.unattributedUs ?? 0
        return time.buckets.filter { $0.us > 0 }.map { ($0.name, $0.us) } + (unattributed > 0 ? [(TimeBucketName("unattributed"), unattributed)] : [])
    }
}

/// Diagonal hatching for derived time.
struct Hatch: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        var x = rect.minX - rect.height
        while x < rect.maxX {
            p.move(to: CGPoint(x: x, y: rect.maxY))
            p.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
            p.addLine(to: CGPoint(x: x + rect.height + 1.2, y: rect.minY))
            p.addLine(to: CGPoint(x: x + 1.2, y: rect.maxY))
            p.closeSubpath()
            x += 4
        }
        return p
    }
}
