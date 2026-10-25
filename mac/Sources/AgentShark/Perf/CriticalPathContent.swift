import AppKit
import Foundation

/// What Session · Critical Path shows of one AgentPerf result (ANALYSIS-UX §4): session names, lanes, the verdict and
/// legend, the data gaps, the partial-window warning and the rows of the four tables. It is built once per result, and
/// every figure in it is an API field the client only formats; placing times on the track's axis is the one
/// arithmetic it leaves to the track.
struct CriticalPathContent {
    let result: PerfResult
    let names: PathSessionNames
    /// One lane per `bySession` entry, in that order; a session that has segments but no entry follows at the end.
    let lanes: [PathLane]
    let verdict: AnalysisVocabulary.Verdict
    /// The legend rows, a derived class's time marked as the verdict marks its share: "22m 23s≈".
    let legend: [AnalysisVocabulary.LegendRow]
    /// The class bar or the track hatches some time, so the legend names the hatching (`hatchKey`).
    let isHatched: Bool
    /// Every gap of the result in coverage order, with its sentence (§4.4).
    let gaps: [Gap]
    /// The partial-window warning (§4.5); nil when the analysed events cover the session.
    let partialWindow: String?
    /// The segment cap (§4.8): one sentence for the band's label, its tooltip and accessibility element, and the
    /// Segments footer; nil when the returned segments are the whole path.
    let segmentCap: String?
    /// The cap's short form, for a band too narrow for the sentence: "First 30 of 395 segments".
    let segmentCapShort: String?
    /// The stretch the band covers, from the last returned segment's end to the path's end; nil when the segments
    /// reach the end.
    let notReturned: ClosedRange<Int64>?
    let contributors: [ContributorGroup]
    let rework: [ReworkRow]
    let subagents: [SubagentRow]
    let parallelism: String
    /// Segments' rows, up to 2,000 with clocks and tooltips each, built the first time the Segments tab asks for them
    /// rather than with the rest of the content, which a body evaluation builds on the main actor.
    var segments: [SegmentRow] { segmentRows.rows { Self.segmentRows(result, names: names) } }
    private let segmentRows = LazyRows<SegmentRow>()

    var path: PerfResult.CriticalPath { result.criticalPath }
    /// The path has no length: the verdict's Empty form and the evidence line are all there is to show (§4.6, §4.11).
    var isEmpty: Bool { verdict.form == .empty }
    /// The share column's denominator: "of 11m 30s".
    var wallText: String { path.wallUs.map { Formatters.duration($0) } ?? Formatters.missing }

    struct Gap: Hashable, Sendable {
        let code: WorkbenchGap
        let text: String
    }

    /// `fallbackTitle` names a session the result's `sessions` map does not (analysis 1.0): the catalog's title.
    /// `rootIsSubagent` and `rootRange` come from the catalog too, for an engine that sends no `sessions` map and no
    /// `window`.
    init(_ result: PerfResult, fallbackTitle: (String) -> String? = { _ in nil }, rootIsSubagent: Bool? = nil,
         rootRange: (start: Int64?, end: Int64?)? = nil) {
        self.result = result
        let cp = result.criticalPath
        names = PathSessionNames(result, fallbackTitle: fallbackTitle, rootIsSubagent: rootIsSubagent)
        partialWindow = Self.partialWindow(result, rootRange: rootRange)
        let verdict = AnalysisVocabulary.verdict(cp, gaps: result.coverage.gaps)
        self.verdict = partialWindow == nil ? verdict : Self.loaded(verdict, wallUs: cp.wallUs)
        legend = Self.legend(cp)
        isHatched = cp.byClass.keys.contains { Self.isDerived($0, in: cp) } || cp.segments.contains(where: Self.isDerived)
        gaps = Self.gaps(result)
        let cap = Self.segmentCap(result)
        segmentCap = cap?.sentence
        segmentCapShort = cap?.short
        notReturned = Self.notReturned(result.criticalPath)
        lanes = Self.lanes(result, names: names)
        contributors = Self.contributors(result, names: names)
        rework = Self.rework(result)
        subagents = Self.subagents(result, names: names)
        parallelism = Self.parallelism(result.collaboration)
    }

    // MARK: Legend (§4.7)

    /// What the hatching on the class bar and the track means: the line under the legend, and the first words of the
    /// class bar's accessibility label.
    static let hatchKey = "Hatched: derived from timestamps (≈)"

    /// One row per class on the path: the known classes in their fixed order, then any class a newer engine adds, by
    /// time on the path, named in words and drawn neutral, so the class bar and its legend account for the whole path.
    static func legend(_ cp: PerfResult.CriticalPath) -> [AnalysisVocabulary.LegendRow] {
        var rows = AnalysisVocabulary.legendRows(cp)
        if let wall = cp.wallUs, wall > 0 {
            let shown = Set(rows.map(\.pathClass))
            rows += cp.byClass.filter { !shown.contains($0.key) }
                .sorted { $0.value.us != $1.value.us ? $0.value.us > $1.value.us : $0.key.rawValue < $1.key.rawValue }
                .map { c, s in
                    AnalysisVocabulary.LegendRow(pathClass: c, name: PathMarkStyle.name(c), time: Formatters.duration(s.us),
                                                 share: Formatters.share(s.share), part: Formatters.part(s.us, of: wall, share: s.share))
                }
        }
        return rows.map { row in
            guard isDerived(row.pathClass, in: cp) else { return row }
            var marked = row
            marked.time += "≈"
            return marked
        }
    }

    /// Some of `c`'s time on the path is derived from timestamps, so the class bar hatches part of it and its time
    /// carries ≈. Unattributed time is time no logged or derived interval claims: the engine sends it as not logged,
    /// but nothing derives it, so it is never marked derived (§4.8).
    static func isDerived(_ c: PathClass, in cp: PerfResult.CriticalPath) -> Bool {
        c != .unattributed && (cp.byClass[c]?.derivedUs ?? 0) > 0
    }

    func isDerived(_ c: PathClass) -> Bool { Self.isDerived(c, in: path) }

    /// The hatched part of `c` on the class bar: its derived time, and none for unattributed time, which draws solid.
    func derivedUs(_ c: PathClass) -> Int64 {
        isDerived(c) ? path.byClass[c]?.derivedUs ?? 0 : 0
    }

    /// All of `c`'s time on the path is derived, so the class bar stripes its whole part.
    func isAllDerived(_ c: PathClass) -> Bool { Self.isAllDerived(c, in: path) }

    static func isAllDerived(_ c: PathClass, in cp: PerfResult.CriticalPath) -> Bool {
        guard isDerived(c, in: cp), let share = cp.byClass[c], share.us > 0 else { return false }
        return (share.derivedUs ?? 0) >= share.us
    }

    /// The logs do not time this segment directly and it is not unattributed, so the track hatches it and its
    /// duration carries ≈ (§4.8).
    static func isDerived(_ s: PerfResult.PathSegment) -> Bool {
        !s.logged && s.class != .unattributed
    }

    /// What unattributed time is, in the Steps time bar's words: the track's tooltip line for it and its Duration
    /// tooltip in Segments.
    static let unattributedNote = "No logged or derived interval claims it; never counted as model time"

    /// "Unattributed 35.8s: no logged or derived interval claims it; never counted as model time": the class bar's
    /// tooltip and the legend row's accessibility label, `time` being the row's "{part}".
    static func unattributedHelp(_ time: String) -> String {
        "Unattributed \(time): " + unattributedNote.prefix(1).lowercased() + unattributedNote.dropFirst()
    }

    // MARK: Evidence line (§4.4)

    /// What the evidence line says when the result has no gap.
    static let noGaps = "No data gaps"

    /// "8 data gaps: Approvals are not logged, so approval waits count as tool time; …" (`AnalysisVocabulary.gapHeadline`,
    /// the words of Compare, the run report and the web): the line cuts it at its tail. While the partial-window warning
    /// shows, the line lists only the gaps it does not state (`warningGaps`), so the row under it does not repeat it
    /// (DESIGN.md §1 principle 2); the count and the popover keep every gap.
    var gapHeadline: String {
        guard !gaps.isEmpty else { return Self.noGaps }
        let listed = partialWindow == nil ? gaps : gaps.filter { !Self.warningGaps.contains($0.code) }
        return AnalysisVocabulary.gapHeadline(gaps.map(\.text), listing: listed.isEmpty ? nil : listed.map(\.text))
    }

    /// The gaps the partial-window warning states: how many events were analysed, and how much of the session the path
    /// covers.
    static let warningGaps: Set<WorkbenchGap> = [.windowPartial, .eventLimit]

    /// Every gap sentence whole, for the line's accessibility label (`AnalysisVocabulary.gapsSpoken`).
    var gapsSpoken: String {
        AnalysisVocabulary.gapsSpoken(gaps.map(\.text), none: Self.noGaps)
    }

    /// "6,262 of 6,262 events · Times +08:00".
    var coverageText: String {
        let c = result.coverage
        return Formatters.count(c.eventsExamined) + " of " + Formatters.count(c.eventsAvailable, "event") + " · Times "
            + Formatters.offsetLabel(at: path.startTs)
    }

    /// The gaps in coverage order, as the web lists them, then any missing timing an older engine left out of it.
    static func gaps(_ r: PerfResult) -> [Gap] {
        var codes: [WorkbenchGap] = []
        for code in r.coverage.gaps + r.missing.map(\.code) where !codes.contains(code) { codes.append(code) }
        return codes.map { code in
            Gap(code: code, text: AnalysisVocabulary.gapText(code, note: r.coverage.note(code), effect: r.missing.first { $0.code == code }?.effect))
        }
    }

    // MARK: Partial window (§4.5)

    /// With analysis 1.1: "Analysed 50,000 of 84,340 events: " and the engine's own note for the gap, verbatim ("The
    /// critical path covers only the loaded events: 4d 08h of this session's 41d 23h (10%)."). Merged sources load in
    /// sequence order, so the loaded events need not start at the session's start, and neither sentence says "first".
    /// An older engine sends no window, so the warning states the analysed range beside the session's own, as clock
    /// ranges; the client computes no duration.
    static func partialWindow(_ r: PerfResult, rootRange: (start: Int64?, end: Int64?)?) -> String? {
        let c = r.coverage, cp = r.criticalPath
        let counts = "\(Formatters.count(c.eventsExamined)) of \(Formatters.count(c.eventsAvailable, "event"))"
        if c.gaps.contains(.windowPartial) {
            if let note = c.note(.windowPartial) { return "Analysed " + counts + ": " + note }
            if let w = cp.window, let analysed = w.analyzedUs, let session = w.sessionUs {
                return "Analysed " + counts + ": the path covers " + Formatters.duration(analysed) + " of this session's "
                    + Formatters.duration(session) + (w.share.map { " (" + Formatters.share($0) + ")" } ?? "") + "."
            }
        }
        guard c.gaps.contains(.windowPartial) || (c.gaps.contains(.eventLimit) && cp.window == nil) else { return nil }
        var parts = ["Analysed " + counts + "."]
        if let range = clockRange(cp.window?.analyzedStartTs ?? cp.startTs, cp.window?.analyzedEndTs ?? cp.endTs) {
            parts.append("Analysed: \(range).")
        }
        if let range = clockRange(cp.window?.sessionStartTs ?? rootRange?.start, cp.window?.sessionEndTs ?? rootRange?.end) {
            parts.append("Session: \(range).")
        }
        return parts.joined(separator: " ")
    }

    /// The verdict of a partial window (Decision 11): each share names the path it is a share of as the loaded part,
    /// "Model, 2d 23h of the 4d 08h loaded (68%)", and the Not established line "of the 4d 08h critical path in the
    /// loaded events", so the headline does not read as a verdict on the whole session.
    static func loaded(_ verdict: AnalysisVocabulary.Verdict, wallUs: Int64?) -> AnalysisVocabulary.Verdict {
        guard let wallUs, wallUs > 0 else { return verdict }
        let wall = Formatters.duration(wallUs)
        var out = verdict
        out.lines = verdict.lines.map { line in
            var l = line
            l.text = l.text.replacingOccurrences(of: " of " + wall + " (", with: " of the " + wall + " loaded (")
                .replacingOccurrences(of: " of the " + wall + " critical path ", with: " of the " + wall + " critical path in the loaded events ")
            // A share the engine left out leaves the part without its brackets.
            if l.text.hasSuffix(" of " + wall) { l.text = l.text.dropLast(wall.count + 4) + " of the " + wall + " loaded" }
            return l
        }
        return out
    }

    /// "Oct 11 10:02:13 → 10:07:55 +08:00", with the date on both ends when they differ; nil without both ends.
    static func clockRange(_ from: Int64?, _ to: Int64?) -> String? {
        guard let from, let to else { return nil }
        let end = Formatters.sameDay(from, to) ? String(Formatters.clock(to, zone: Formatters.timeZone).prefix(8)) : Formatters.datedClock(to)
        return Formatters.datedClock(from) + " → " + end + " " + Formatters.offsetLabel(at: from)
    }

    // MARK: Segment cap (§4.8)

    /// What the track shows of a path whose segments did not all come back, in the words of what is on screen, as a
    /// sentence and a short form for a narrow band: "Showing the first 30 of 395 segments" ("First 30 of 395 segments")
    /// when `segmentsTotal` counts more, "Showing the first 2,000 segments" ("First 2,000 segments") from the cap's gap
    /// alone, and "The analysis returned no segments for this stretch" ("No segments returned") when the segments stop
    /// before the path's end and nothing says why. The 1.1 engine merges short segments until the path fits its cap,
    /// so only an older engine, or a result cut by hand, has fewer; none can be asked for the rest.
    static func segmentCap(_ r: PerfResult) -> (sentence: String, short: String)? {
        let cp = r.criticalPath
        let sent = cp.segments.count
        if let total = cp.segmentsTotal, total > sent {
            let part = "first \(Formatters.count(sent)) of \(Formatters.count(total, "segment"))"
            return ("Showing the " + part, part.prefix(1).uppercased() + part.dropFirst())
        }
        if r.coverage.gaps.contains(.segmentLimit) {
            let part = "first " + Formatters.count(sent, "segment")
            return ("Showing the " + part, part.prefix(1).uppercased() + part.dropFirst())
        }
        return notReturned(cp) == nil ? nil : ("The analysis returned no segments for this stretch", "No segments returned")
    }

    /// The band's second tooltip line: what still counts the time the track leaves out.
    static let segmentCapNote = "The class bar, the legend and Contributors count the whole path."

    /// From the last returned segment's end (the path's start when none came) to the path's end; nil when nothing is
    /// left between them.
    static func notReturned(_ cp: PerfResult.CriticalPath) -> ClosedRange<Int64>? {
        guard let end = cp.endTs, let from = cp.segments.map(\.end).max() ?? cp.startTs, from < end else { return nil }
        return from...end
    }

    // MARK: Lanes (§4.8)

    static func lanes(_ r: PerfResult, names: PathSessionNames) -> [PathLane] {
        let cp = r.criticalPath
        var order = cp.bySession.map(\.sessionId)
        for s in cp.segments where !order.contains(s.sessionId) { order.append(s.sessionId) }
        let index = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        var members = Array(repeating: [Int](), count: order.count)
        for (i, s) in cp.segments.enumerated() { members[index[s.sessionId] ?? 0].append(i) }
        let share = Dictionary(cp.bySession.map { ($0.sessionId, $0) }, uniquingKeysWith: { a, _ in a })
        return order.enumerated().map { i, id in
            PathLane(session: id, name: names.lane(id), gutterName: names.gutterLane(id), help: names.help(id), onPathUs: share[id]?.us,
                     onPathHelp: share[id].flatMap { s in cp.wallUs.map { Formatters.part(s.us, of: $0, share: s.share) + " on the path" } } ?? "",
                     isRoot: id == r.sessionId, segments: members[i],
                     delegation: r.collaboration.delegations.firstIndex { $0.child == id })
        }
    }

    // MARK: Contributors (§4.9)

    struct ContributorGroup: Identifiable, Hashable {
        enum Kind: String, Hashable, Sendable { case waits, tools, steps }
        let kind: Kind
        let title: String
        let rows: [ContributorRow]
        /// The class whose time the group's contributors are.
        let pathClass: PathClass
        /// How many contributors the group had before its ten: the engine's count of tools or steps (nil from an
        /// engine that sends none), or the leading wait's segments.
        let total: Int?
        var id: Kind { kind }

        /// The rows are the ten longest, so the badge never reads as the class's total (§4.9): "10 of 14" where the
        /// count is known to be larger, "top 10" where the engine's ten may have left some out, else the count, which
        /// is then every contributor.
        var badge: String {
            if let total, total > rows.count { return Formatters.count(rows.count) + " of " + Formatters.count(total) }
            if total == nil, rows.count >= CriticalPathContent.topRows { return "top " + Formatters.count(rows.count) }
            return Formatters.count(rows.count)
        }

        /// The group header's tooltip: what the rows are, and where the class's total is.
        var badgeHelp: String {
            let one: String, many: String
            switch kind {
            case .waits:
                let wait = AnalysisVocabulary.className(pathClass).lowercased()
                (one, many) = ("stretch of " + wait, "stretches of " + wait)
            case .tools: (one, many) = ("tool target", "tool targets")
            case .steps: (one, many) = ("model step", "model steps")
            }
            let cut = (total ?? .max) > rows.count && rows.count >= CriticalPathContent.topRows
            return (cut ? "The \(Formatters.count(rows.count)) longest " + many : "Every " + one + " on the path") + "; the class total is in the legend"
        }
    }

    /// The engine's top ten tools and steps, and the ten longest waits.
    static let topRows = 10

    /// The classes that are waiting rather than work: when one of them is the largest share, Contributors leads with
    /// its longest stretches, so "which wait?" has an answer where tools and steps are a sliver of the path.
    static let waitClasses: Set<PathClass> = [.people, .idle, .coordination, .harness]

    struct ContributorRow: Identifiable, Hashable {
        let id: String
        let selection: PerfSelection
        let name: String
        /// A tool key is machine text (DESIGN.md §3.2); a step reads as words.
        let isCode: Bool
        let help: String
        let session: String
        let sessionHelp: String
        /// "45s", with ≈ when some of the time is derived from timestamps, as the legend marks its class (Decision 13).
        let onPath: String
        /// What the ≈ means, with the derived part when the engine sends it; empty for logged time.
        let onPathHelp: String
        /// Read aloud after the time: ", derived".
        let isDerived: Bool
        let share: String
        let shareHelp: String
        let evidence: EvidenceRef?
    }

    static func contributors(_ r: PerfResult, names: PathSessionNames) -> [ContributorGroup] {
        let cp = r.criticalPath
        func row(_ c: PerfResult.Contributor, _ selection: PerfSelection, name: String, isCode: Bool, help: String) -> ContributorRow {
            let session = c.sessionId ?? c.evidence.first?.sessionId
            let derived = isDerived(c, step: !isCode, in: cp)
            return ContributorRow(id: "\(selection)", selection: selection, name: name, isCode: isCode, help: help,
                                  session: session.map(names.short) ?? Formatters.missing,
                                  sessionHelp: session.map(names.help) ?? AnalysisVocabulary.notDetermined,
                                  onPath: Formatters.duration(c.us) + (derived ? "≈" : ""), onPathHelp: derived ? derivedHelp(c) : "",
                                  isDerived: derived, share: Formatters.share(c.share),
                                  shareHelp: cp.wallUs.map { Formatters.part(c.us, of: $0, share: c.share) + " of the critical path" } ?? "",
                                  evidence: c.evidence.first)
        }
        let tools = cp.topTools.enumerated().map { i, c in row(c, .tool(i), name: c.key, isCode: true, help: c.key) }
        let steps = cp.topSteps.enumerated().map { i, c in
            let name = stepName(c)
            return row(c, .step(i), name: name, isCode: false, help: [name == stepNameWithoutIntent(c) ? nil : name, c.key].compactMap { $0 }.joined(separator: "\n"))
        }
        return [waits(r, names: names),
                ContributorGroup(kind: .tools, title: "Tools on the path", rows: tools, pathClass: .tools, total: cp.topToolsTotal),
                ContributorGroup(kind: .steps, title: "Model steps on the path", rows: steps, pathClass: .model, total: cp.topStepsTotal)]
            .compactMap { $0 }.filter { !$0.rows.isEmpty }
    }

    /// "Waits on the path" (§4.9): when the largest class is a wait, its ten longest segments, built here from the
    /// returned segments since the engine ranks only tools and steps. A row names the wait and when it began, or what
    /// it waited on: "Between prompts · 17:15:02", "Waiting for a subagent · audit:deps". Selecting one selects its
    /// segment, so a row with an event shows in Events and one without shows in the Timeline (§4.10). A segment carries
    /// no share, so its Share is its time over the path's, the one share the client divides.
    static func waits(_ r: PerfResult, names: PathSessionNames) -> ContributorGroup? {
        let cp = r.criticalPath
        guard let c = cp.binding, waitClasses.contains(c), let wall = cp.wallUs, wall > 0 else { return nil }
        let first = cp.startTs
        let all = cp.segments.indices.filter { cp.segments[$0].class == c }
        let rows = all.sorted { cp.segments[$0].us != cp.segments[$1].us ? cp.segments[$0].us > cp.segments[$1].us : $0 < $1 }
            .prefix(topRows)
            .map { i -> ContributorRow in
                let s = cp.segments[i]
                let what = s.bucket == "mixed" ? PathMarkStyle.name(s.class) : TimeLegend.label(s.bucket)
                let label = s.label?.trimmingCharacters(in: .whitespacesAndNewlines)
                let name = what + " · " + (label.flatMap { $0.isEmpty ? nil : $0 } ?? shortClock(s.start, first: first))
                let share = Double(s.us) / Double(wall)
                return ContributorRow(id: "\(PerfSelection.segment(i))", selection: .segment(i), name: name, isCode: false,
                                      help: [name, clockRange(s.start, s.end)].compactMap { $0 }.joined(separator: "\n"),
                                      session: names.short(s.sessionId), sessionHelp: names.help(s.sessionId),
                                      onPath: durationText(s), onPathHelp: durationHelp(s), isDerived: isDerived(s),
                                      share: Formatters.share(share),
                                      shareHelp: Formatters.part(s.us, of: wall, share: share) + " of the critical path",
                                      evidence: s.evidence.first)
            }
        return ContributorGroup(kind: .waits, title: "Waits on the path", rows: Array(rows), pathClass: c, total: all.count)
    }

    /// A clock time for a name: "17:15:02", with the short date when it is not the path's first day.
    static func shortClock(_ us: Int64, first: Int64?) -> String {
        let clock = String(Formatters.clock(us, zone: Formatters.timeZone).prefix(8))
        guard let first, !Formatters.sameDay(us, first) else { return clock }
        return Formatters.shortDate(us) + " " + clock
    }

    /// The Contributor column's widest: its widest value, a group's title and badge included, with room after it, at
    /// most `maxContributorWidth`. As SRT's name column's 45% share stops at its maximum (DESIGN.md §4.4), the primary
    /// column stops where its values do. A child row's name starts after the disclosure's indent.
    static func contributorColumnWidth(_ groups: [ContributorGroup]) -> CGFloat {
        func width(_ s: String, _ role: Theme.TypeRole) -> CGFloat { ceil((s as NSString).size(withAttributes: [.font: Theme.font(role)]).width) }
        let heads = groups.map { width($0.title, .groupHeader) + 6 + width($0.badge, .rowSecondary) + contributorIndent }
        let rows = groups.flatMap(\.rows).map { width($0.name, $0.isCode ? .code : .rowPrimary) + 2 * contributorIndent }
        let widest = (heads + rows).max() ?? 0
        return min(maxContributorWidth, max(220, widest + 24))
    }

    /// The Contributor column grows no wider than the prose measure; a longer step intent is cut at its tail, whole in
    /// its tooltip.
    static let maxContributorWidth: CGFloat = 560

    /// The outline's indent and disclosure before a row's name.
    static let contributorIndent: CGFloat = 20

    /// The Contributors columns in a table `width` wide (DESIGN.md §4.4): On path and Share at fixed widths, Session
    /// between 120 and 200 pt, and Contributor, the primary column, as wide as its values (`contributorColumnWidth`)
    /// while the table has room, down to 180 pt; a table too narrow for that and Session's 120 hides Session (P3).
    /// Room left over stays after Share, so the figures sit beside the names. `width` is the table's frame, which its
    /// pane sets, so the columns never change it; 0, before it is measured, gives the widest.
    struct ContributorColumns: Equatable {
        var contributor: CGFloat
        /// 0 when Session is hidden.
        var session: CGFloat

        var showsSession: Bool { session > 0 }

        static let contributorMin: CGFloat = 180
        static let sessionRange: ClosedRange<CGFloat> = 120...200
        static let onPath: CGFloat = 80
        static let share: CGFloat = 88

        init(contributor: CGFloat, session: CGFloat) {
            self.contributor = contributor
            self.session = session
        }

        init(_ groups: [ContributorGroup], width: CGFloat) {
            let widest = CriticalPathContent.contributorColumnWidth(groups)
            let range = Self.sessionRange
            guard width > 0 else {
                self.init(contributor: widest, session: range.upperBound)
                return
            }
            // What the four columns share once the table's margins, its spacing and the figures are taken.
            let room = width - PerfColumnFit.margins - 4 * PerfColumnFit.spacing - Self.onPath - Self.share
            if room - range.lowerBound >= Self.contributorMin {
                let contributor = min(widest, room - range.lowerBound)
                self.init(contributor: contributor, session: min(range.upperBound, room - contributor))
            } else {
                self.init(contributor: min(widest, max(Self.contributorMin, room + PerfColumnFit.spacing)), session: 0)
            }
        }
    }

    /// The Contributors row that shows `s`: its own, or for a mark or another tab's row, the contributor whose evidence
    /// is the selection's event, so the table follows the track it is the text of (§4.10). The model's selection stays
    /// the one source; a click on the mirrored row selects that row.
    func contributorRowID(for s: PerfSelection?, in groups: [ContributorGroup]) -> String? {
        guard let s else { return nil }
        let rows = groups.flatMap(\.rows)
        if let own = rows.first(where: { $0.selection == s }) { return own.id }
        guard let event = target(s)?.evidence?.eventId else { return nil }
        return rows.first { $0.evidence?.eventId == event }?.id
    }

    /// Some of a contributor's time is derived from timestamps: the engine's `derivedUs` (1.1), else, from an engine
    /// that does not send it, its class being all derived (a contributor's time is part of its class's, so the legend's
    /// ≈ then holds for each row), else a derived segment of the contributor's own: its step's model time, or for a
    /// tool the segment its evidence event marks. Its own segments alone missed every row of a capped result, whose
    /// returned segments are a few of the path's.
    static func isDerived(_ c: PerfResult.Contributor, step: Bool, in cp: PerfResult.CriticalPath) -> Bool {
        if let d = c.derivedUs { return d > 0 }
        if isAllDerived(step ? .model : .tools, in: cp) { return true }
        let event = c.evidence.first?.eventId
        return cp.segments.contains { s in
            guard isDerived(s), s.sessionId == (c.sessionId ?? s.sessionId) else { return false }
            return step ? s.refKind == .step && s.stepId == c.key : s.class == .tools && event != nil && s.evidence.first?.eventId == event
        }
    }

    /// The ≈'s tooltip on a contributor's time: "Derived: 12s of this time on the path is derived from timestamps, not
    /// logged by the agent. Precision not yet checked."
    static func derivedHelp(_ c: PerfResult.Contributor) -> String {
        let part = c.derivedUs.map { Formatters.duration($0) + " of this time on the path is" } ?? "some of this time on the path is"
        return AnalysisVocabulary.confidenceHelp(.derived, part + " derived from timestamps (≈), not logged by the agent")
    }

    /// "Step 40 · Run the auth tests" (DESIGN.md §9 Step position), "Step 40" without an intent, and from an engine
    /// before 1.1, which sends no step number, "Step" with the step id cut in the middle.
    static func stepName(_ c: PerfResult.Contributor) -> String {
        let intent = c.intent?.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ") ?? ""
        return stepNameWithoutIntent(c) + (intent.isEmpty ? "" : " · " + intent)
    }

    private static func stepNameWithoutIntent(_ c: PerfResult.Contributor) -> String {
        c.stepN.map { "Step \($0)" } ?? "Step " + Formatters.middleEllipsis(c.key)
    }

    // MARK: Rework (§4.9)

    struct ReworkRow: Identifiable, Hashable {
        let kind: PerfReworkKind
        let name: String
        /// The engine found none: a measured zero, which the table shows dimmed.
        let isZero: Bool
        let count: String
        let time: String
        let onPath: String
        let onPathHelp: String
        let evidence: [EvidenceRef]
        var id: PerfReworkKind { kind }
    }

    static func rework(_ r: PerfResult) -> [ReworkRow] {
        PerfReworkKind.allCases.map { kind in
            let f = kind.finding(in: r.rework)
            return ReworkRow(kind: kind, name: kind.title, isZero: f.count == 0, count: Formatters.count(f.count, kind.noun, plural: kind.plural),
                             time: Formatters.duration(f.us), onPath: Formatters.duration(f.onPathUs),
                             onPathHelp: r.criticalPath.wallUs.map { Formatters.part(f.onPathUs, of: $0, share: nil) + " of the critical path" } ?? "",
                             evidence: f.evidence)
        }
    }

    // MARK: Subagents (§4.9)

    struct SubagentRow: Identifiable, Hashable {
        /// The delegation's index in `collaboration.delegations`.
        let index: Int
        let child: String
        let name: String
        /// 1.1 (E10): the task the parent gave, and the tooltip naming how the delegation ended.
        let task: String?
        let help: String
        let started: String
        let startedHelp: String
        let busy: Cell
        let parentWaited: Cell
        let onPath: String
        let overlap: Cell
        let duplicateReads: String
        let onPathUs: Int64
        var id: Int { index }
    }

    /// A value, or "—" with its reason in the tooltip (DESIGN.md §9 Missing values).
    struct Cell: Hashable {
        let text: String
        let help: String?

        init(_ us: Int64?) {
            let v = AnalysisVocabulary.value(us.map { Formatters.duration($0) })
            text = v.text
            help = v.help
        }
    }

    static func subagents(_ r: PerfResult, names: PathSessionNames) -> [SubagentRow] {
        let first = r.criticalPath.startTs
        return r.collaboration.delegations.enumerated().map { i, d in
            let task = d.taskExcerpt?.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
            var help = [names.help(d.child)]
            if let task, !task.isEmpty { help.append("Task: " + task) }
            if let outcome = d.outcome { help.append("Outcome: " + outcome.rawValue.replacingOccurrences(of: "-", with: " ")) }
            // A task that only repeats the title says nothing more.
            let shown = task.flatMap { $0.isEmpty || $0.caseInsensitiveCompare(names.title(d.child)) == .orderedSame ? nil : $0 }
            return SubagentRow(index: i, child: d.child, name: names.title(d.child), task: shown,
                               help: help.joined(separator: "\n"), started: listClock(d.start, first: first),
                               startedHelp: Formatters.timestamp(d.start, digits: 3), busy: Cell(d.busyUs), parentWaited: Cell(d.parentWaitUs),
                               onPath: Formatters.duration(d.onPathUs), overlap: Cell(d.siblingOverlapUs),
                               duplicateReads: Formatters.count(d.duplicateReads.count, "read"), onPathUs: d.onPathUs)
        }
        .sorted { $0.onPathUs != $1.onPathUs ? $0.onPathUs > $1.onPathUs : $0.index < $1.index }
    }

    /// "2.03× parallel: 6m 07s of agent work in a 3m 01s span · 28.0s waiting on other agents". A span or parallelism
    /// the logs do not determine is left out, never shown as 0.
    static func parallelism(_ c: PerfResult.Collaboration) -> String {
        let work = Formatters.duration(c.workUs) + " of agent work"
        let head: String
        if let p = c.parallelism, let span = c.spanUs {
            head = String(format: "%.2f× parallel: ", p) + work + " in a " + Formatters.duration(span) + " span"
        } else {
            head = work + "; parallelism not determined by the logs"
        }
        return head + " · " + Formatters.duration(c.coordinationUs) + " waiting on other agents"
    }

    // MARK: Segments (§4.9)

    struct SegmentRow: Identifiable, Hashable {
        let index: Int
        let start: String
        let startHelp: String
        let session: String
        let sessionHelp: String
        let pathClass: PathClass
        let className: String
        let label: String
        /// A command or a target key is machine text; a step label reads as words.
        let labelIsCode: Bool
        let duration: String
        let durationHelp: String
        let evidence: EvidenceRef?
        var id: Int { index }
    }

    static func segmentRows(_ r: PerfResult, names: PathSessionNames) -> [SegmentRow] {
        let first = r.criticalPath.startTs
        return r.criticalPath.segments.enumerated().map { i, s in
            SegmentRow(index: i, start: listClock(s.start, first: first), startHelp: Formatters.timestamp(s.start, digits: 3),
                       session: names.short(s.sessionId), sessionHelp: names.help(s.sessionId), pathClass: s.class,
                       className: PathMarkStyle.name(s.class), label: segmentLabel(s) ?? "", labelIsCode: s.refKind == .call,
                       duration: durationText(s), durationHelp: durationHelp(s), evidence: s.evidence.first)
        }
    }

    /// What a segment did: the engine's label (1.1), or a coalesced run's parts ("Model 15.4s · Unattributed 2.86s").
    static func segmentLabel(_ s: PerfResult.PathSegment) -> String? {
        if let label = s.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return label }
        let parts = s.mixedParts
        guard !parts.isEmpty else { return nil }
        return parts.prefix(5).map { PathMarkStyle.name($0.class) + " " + Formatters.duration($0.us) }.joined(separator: " · ")
            + (parts.count > 5 ? " · +\(Formatters.count(parts.count - 5)) more" : "")
    }

    /// "42.1s", with ≈ when the logs do not time the interval directly; unattributed time carries none.
    static func durationText(_ s: PerfResult.PathSegment) -> String {
        Formatters.duration(s.us) + (isDerived(s) ? "≈" : "")
    }

    static func durationHelp(_ s: PerfResult.PathSegment) -> String {
        if s.logged { return "Logged by the agent" }
        return isDerived(s) ? "Derived from timestamps (≈)" : unattributedNote
    }

    /// A clock time for a list: "14:03:22.118", with the short date when it is not the path's first day (DESIGN.md
    /// §7.9 Dates).
    static func listClock(_ us: Int64, first: Int64?) -> String {
        let clock = Formatters.clock(us, zone: Formatters.timeZone)
        guard let first, !Formatters.sameDay(us, first) else { return clock }
        return Formatters.shortDate(us) + " " + clock
    }
}

/// Rows built once, on first use: the content is a value the model caches per result, so its copies share the box.
final class LazyRows<Row> {
    private var built: [Row]?

    func rows(_ build: () -> [Row]) -> [Row] {
        if let built { return built }
        let rows = build()
        built = rows
        return rows
    }
}

// MARK: - Session names

/// Names of the analysed sessions (§4.8): the root lane reads "Main" and a subagent "Subagent · {title}", from the
/// result's `sessions` map (analysis 1.1), else from the catalog. A session neither knows reads "Untitled ·
/// cx:0190a0…0001" (`AnalysisVocabulary.runLabel`), never its id alone (DESIGN.md §9 Sessions); the full id is in the
/// tooltip.
struct PathSessionNames {
    let root: String
    /// The analysis covers a subagent's subtree: its root is a subagent, not the run's main session (§4.3).
    let rootIsSubagent: Bool
    private let titles: [String: String]

    init(_ r: PerfResult, fallbackTitle: (String) -> String?, rootIsSubagent: Bool?) {
        root = r.sessionId
        var ids = r.coverage.sessionIds + r.criticalPath.bySession.map(\.sessionId) + r.collaboration.delegations.map(\.child)
        ids.append(r.sessionId)
        var titles: [String: String] = [:]
        for id in ids where titles[id] == nil {
            let t = (r.sessions?[id]?.title ?? fallbackTitle(id))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !t.isEmpty { titles[id] = t }
        }
        self.titles = titles
        self.rootIsSubagent = r.sessions?[r.sessionId].map { $0.parentId != nil } ?? rootIsSubagent ?? false
    }

    /// The title, or "Untitled · cx:0190a0…0001".
    func title(_ id: String) -> String { AnalysisVocabulary.runLabel(title: titles[id], id: id) }

    /// The analysed run's main session, which reads "Main".
    private func isMain(_ id: String) -> Bool { id == root && !rootIsSubagent }

    /// A lane's name: "Main", or "Subagent · Find the auth tests".
    func lane(_ id: String) -> String {
        isMain(id) ? "Main" : "Subagent · " + title(id)
    }

    /// A lane's name in the track's label gutter, which has no room for "Subagent · Untitled · cx:0190a0…0001": the
    /// word that tells no lane apart drops before the id would cut (DESIGN.md §3.5), "Subagent · cx:0190a0…0001".
    func gutterLane(_ id: String) -> String {
        guard !isMain(id), let shortID = AnalysisVocabulary.runID(title: titles[id], id: id) else { return lane(id) }
        return "Subagent · " + shortID
    }

    /// A table cell's name: "Main", or the subagent's title.
    func short(_ id: String) -> String {
        isMain(id) ? "Main" : title(id)
    }

    /// The full title and the full id.
    func help(_ id: String) -> String {
        AnalysisVocabulary.runHelp(title: titles[id], id: id)
    }
}

/// One lane of the track: a session on the path.
struct PathLane: Identifiable, Hashable {
    let session: String
    let name: String
    /// The name the label gutter draws (`PathSessionNames.gutterLane`).
    let gutterName: String
    let help: String
    /// The session's time on the path; nil for a session the engine lists no share for.
    let onPathUs: Int64?
    /// "1m 15s of 30m 30s (4%) on the path".
    let onPathHelp: String
    let isRoot: Bool
    /// Its segments' indexes, in time order.
    let segments: [Int]
    /// The delegation that started this session, whose full span the lane draws faintly behind its segments.
    let delegation: Int?
    var id: String { session }

    var onPath: String { onPathUs.map { Formatters.duration($0) } ?? Formatters.missing }
}

// MARK: - Rework kinds

/// The five rework findings of AgentPerf (rework@1 rules), in the order of §4.9.
enum PerfReworkKind: String, CaseIterable, Hashable, Sendable {
    case rereads, reverts, blindRetries, repeatedSearches, fixLoops

    var title: String {
        switch self {
        case .rereads: return "Rereads"
        case .reverts: return "Reverts"
        case .blindRetries: return "Blind retries"
        case .repeatedSearches: return "Repeated searches"
        case .fixLoops: return "Fix loops"
        }
    }

    var noun: String {
        switch self {
        case .rereads: return "reread"
        case .reverts: return "revert"
        case .blindRetries: return "blind retry"
        case .repeatedSearches: return "repeated search"
        case .fixLoops: return "fix loop"
        }
    }

    var plural: String {
        switch self {
        case .blindRetries: return "blind retries"
        case .repeatedSearches: return "repeated searches"
        default: return noun + "s"
        }
    }

    /// The inspector's sentence for a measured zero: "No rereads found in this run."
    var noneFound: String { "No \(plural) found in this run." }

    func finding(in r: PerfResult.Rework) -> PerfResult.ReworkFinding {
        switch self {
        case .rereads: return r.rereads
        case .reverts: return r.reverts
        case .blindRetries: return r.blindRetries
        case .repeatedSearches: return r.repeatedSearches
        case .fixLoops: return r.fixLoops
        }
    }
}

// MARK: - Marks

/// How a path class draws on the track and in the tables. A coalesced run of several classes (`mixed`, analysis 1.1)
/// and a sliver of segments too narrow to draw apart share one neutral fill, darker than unattributed time, so neither
/// reads as a class.
enum PathMarkStyle {
    /// The class's name at the head of a cell or line, so a class this client does not know reads "Queue wait".
    static func name(_ c: PathClass) -> String {
        guard c != .mixed else { return "Mixed" }
        let n = AnalysisVocabulary.className(c)
        return n.prefix(1).uppercased() + n.dropFirst()
    }

    static func color(_ c: PathClass) -> NSColor {
        switch c {
        case .mixed: return mixed
        case .unattributed: return unattributed
        default: return AnalysisVocabulary.classColor(c)
        }
    }

    /// Idle (the quaternary fill, about 3% alpha), unattributed time and a class this client does not know (the time
    /// bar's grey, about 10%) are faint: they draw solid, with a `separatorColor` edge, on the track and the class bar,
    /// so none reads as empty lane; `PathSwatch` draws them the same way, with a hairline edge.
    static func isNeutral(_ c: PathClass) -> Bool {
        c == .idle || c == .unattributed || (c != .mixed && !PathClass.known.contains(c))
    }

    /// How much of its colour a class fills with: a class colour 85%, as the Steps time bar draws it, a neutral class all.
    static func opacity(_ c: PathClass) -> CGFloat { isNeutral(c) ? 1 : 0.85 }

    /// Unattributed time: the time bar's unattributed grey at its full strength, a visible light grey in both themes.
    /// The path is often mostly unattributed when the logs explain little, and at the time bar's 10% that part of the
    /// class bar read as empty, so the bar looked part filled; at this grey the bar always reads whole, still lighter
    /// than a mixed sliver and darker than idle time. It is never hatched, since nothing claims the time.
    static let unattributed = NSColor(name: nil) { appearance in
        var base = NSColor.secondaryLabelColor
        appearance.performAsCurrentDrawingAppearance { base = NSColor.secondaryLabelColor.usingColorSpace(.sRGB) ?? base }
        return base.withAlphaComponent(base.alphaComponent * 0.35)
    }

    static let mixed = NSColor(name: nil) { appearance in
        var base = NSColor.secondaryLabelColor
        appearance.performAsCurrentDrawingAppearance { base = NSColor.secondaryLabelColor.usingColorSpace(.sRGB) ?? base }
        return base.withAlphaComponent(base.alphaComponent * 0.55)
    }
}

/// A drawn mark of one lane at the current zoom: one segment, or a sliver of adjacent segments merged because they are
/// too narrow to draw apart (§4.8).
struct LaneMark: Hashable {
    /// Segment indexes in time order; one for a plain segment.
    let segments: [Int]
    var x0: Double
    var x1: Double

    var isSliver: Bool { segments.count > 1 }
}

extension LaneMark {
    /// The narrowest a segment draws.
    static let minWidth = 1.0

    /// A lane's marks (§4.8): adjacent segments narrower than 1 pt merge into one sliver, and so do adjacent segments
    /// shorter than `mergeBelowUs` (Options ▸ Merge Segments Shorter Than 1s). A narrow segment with no narrow neighbour
    /// stays itself, drawn 1 pt wide. `x` places a time on the track.
    static func marks(_ indexes: [Int], of segments: [PerfResult.PathSegment], x: (Int64) -> Double, mergeBelowUs: Int64? = nil) -> [LaneMark] {
        var out: [LaneMark] = []
        out.reserveCapacity(indexes.count)
        var run: LaneMark?
        func flush() {
            guard let r = run else { return }
            out.append(r.isSliver ? r : LaneMark(segments: r.segments, x0: r.x0, x1: max(r.x1, r.x0 + minWidth)))
            run = nil
        }
        for i in indexes {
            let s = segments[i]
            let x0 = x(s.start), x1 = x(s.end)
            let narrow = x1 - x0 < minWidth || (mergeBelowUs.map { s.us < $0 } ?? false)
            guard narrow else {
                flush()
                out.append(LaneMark(segments: [i], x0: x0, x1: x1))
                continue
            }
            if let r = run, x0 - r.x1 < minWidth {
                run = LaneMark(segments: r.segments + [i], x0: r.x0, x1: max(r.x1, x1, r.x0 + minWidth))
            } else {
                flush()
                run = LaneMark(segments: [i], x0: x0, x1: x1)
            }
        }
        flush()
        return out
    }
}
