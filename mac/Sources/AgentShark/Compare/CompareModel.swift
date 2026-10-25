import AppKit
import Observation

// The state and the pure rules of Session · Compare (ANALYSIS-UX §5): which rows the alignment table lists, how they
// fold, where the difference regions start, which run a side names, and how the engine's refusals read. The views
// read `CompareModel`; the rules are static so tests and other views call them without a window.

// MARK: - Sides

/// Run A (the engine's `left`, the run that started first unless swapped) or run B (`right`).
enum CompareSide: Hashable, Sendable, CaseIterable {
    case a, b

    var letter: String { self == .a ? "A" : "B" }
    var other: CompareSide { self == .a ? .b : .a }
}

extension DiffResult {
    func run(_ side: CompareSide) -> RunSide { side == .a ? left : right }
}

extension DiffResult.AlignmentRow {
    func action(_ side: CompareSide) -> DiffResult.ActionView? { side == .a ? left : right }

    /// Both runs have an action in this row.
    var isPaired: Bool { left != nil && right != nil }
}

extension DiffResult.ActionView {
    /// The event behind the action, which `WindowModel.select(event:reveal:)` opens.
    var eventID: String { evidence.first?.eventId ?? id }
}

// MARK: - Runs

/// What Compare names a run by: its title, start and agent. The engine's `sessions` map (analysis 1.1) comes first, so a
/// run has a title even when the sidebar has not loaded it; the catalog fills in for an older engine.
struct CompareRun: Hashable, Sendable {
    var id: String
    var title: String?
    var agent: AgentKind?
    var start: Int64?

    /// The title, never the id (DESIGN.md §9 Sessions).
    var name: String { AnalysisVocabulary.runName(title: title) }
    /// The full title and the full id, which a click copies.
    var help: String { AnalysisVocabulary.runHelp(title: title, id: id) }

    init(id: String, result: DiffResult?, catalog: [String: SessionRow]) {
        let engine = result?.sessions?[id]
        let row = catalog[id]
        self.id = id
        title = engine?.title ?? row?.title
        agent = engine?.agent ?? row?.agent
        start = engine?.startTs ?? row?.start
    }

    /// What tells two runs with the same title apart on one line: each one's start, "Mar 24 00:25", or its short id when
    /// the starts read alike or one is not known; nil when the titles differ, which already tell them apart.
    static func apart(_ a: CompareRun, _ b: CompareRun) -> (a: String, b: String)? {
        guard RunRanking.normalizedTitle(a.title) == RunRanking.normalizedTitle(b.title) else { return nil }
        if let x = a.start.map(Formatters.shortDateTime), let y = b.start.map(Formatters.shortDateTime), x != y { return (x, y) }
        return (a.shortID, b.shortID)
    }

    /// "cx:0190f0…0001": the agent's prefix, then the native id cut in the middle.
    var shortID: String { AnalysisVocabulary.runID(title: nil, id: id) ?? id }

    /// "Oct 21 14:02 · Codex" (ANALYSIS-UX §5.6), led by the id when the run is untitled; a part the logs do not give is
    /// left out. The session count has its own row in the grid.
    var detail: RunDetail {
        let short = AnalysisVocabulary.runID(title: title, id: id)
        return RunDetail(lead: [short, start.map(Formatters.shortDateTime)].compactMap { $0 }, agent: agent, trail: [],
                         id: short == nil ? nil : id)
    }
}

/// A run's metadata line in parts, so the agent's dot can go right before the agent's name (`RunDetailLine`): what
/// comes before the agent, the agent, and what comes after it.
struct RunDetail: Hashable, Sendable {
    var lead: [String]
    var agent: AgentKind?
    var trail: [String]
    /// The untitled run's full id, whose short form leads `lead`; nil for a titled run, whose id stays in its tooltip.
    var id: String? = nil

    /// "Oct 22 09:15 · 18m 04s · Codex · agentshark"
    var text: String { (lead + [agent?.label].compactMap { $0 } + trail).joined(separator: " · ") }
}

// MARK: - The alignment table's rows

/// One row of the alignment table (ANALYSIS-UX §5.10).
enum AlignmentItem: Hashable, Sendable {
    /// A difference region's group row; the value is its position in `regions`.
    case region(Int)
    /// An aligned row; the value is its position in `alignment`.
    case row(Int)
    /// Four or more consecutive same rows, `from` and `to` being positions in `alignment`.
    case fold(from: Int, to: Int)
    /// A note under the last row: rows or regions the engine did not return.
    case footer(String)

    var rowPosition: Int? {
        if case .row(let i) = self { return i }
        return nil
    }

    /// Rows a person can select: aligned rows, and folds (Space opens one).
    var isSelectable: Bool {
        switch self {
        case .row, .fold: return true
        case .region, .footer: return false
        }
    }
}

/// The summary chips and Only Differences (ANALYSIS-UX §5.9): status chips admit their statuses together, the ambiguous
/// chip keeps only ambiguous rows, and Only Differences hides same rows; no chip on admits every status.
struct AlignmentFilter: Hashable, Sendable {
    var statuses: Set<AlignmentStatus> = []
    var ambiguousOnly = false
    var onlyDifferences = false

    /// A chip narrows the rows: the table then lists exactly what the chips name, unfolded.
    var isNarrowed: Bool { !statuses.isEmpty || ambiguousOnly }

    func admits(_ row: DiffResult.AlignmentRow) -> Bool {
        if onlyDifferences && row.status == .same { return false }
        if ambiguousOnly && !row.ambiguous { return false }
        return statuses.isEmpty || statuses.contains(row.status)
    }
}

enum AlignmentLayout {
    /// Runs of this many consecutive same rows or more fold into one row (§5.10).
    static let foldMinimum = 4

    /// The table's rows: each region's group row before its first listed row, aligned rows that pass `filter`, runs of
    /// four or more same rows folded unless `expanded` holds their first position (an expanded fold keeps its row, so
    /// it can close again), and the footers. Folds apply only to the unnarrowed list: a chip asks for its rows.
    static func items(_ result: DiffResult, filter: AlignmentFilter, expanded: Set<Int>) -> [AlignmentItem] {
        let rows = result.alignment
        let folding = !filter.isNarrowed && !filter.onlyDifferences
        var items: [AlignmentItem] = []
        var region = 0
        var openRegion: Int?
        var i = 0
        while i < rows.count {
            let row = rows[i]
            // Regions are listed in row order; one whose rows all fail the filter gets no group row.
            while region < result.regions.count, result.regions[region].to < row.index { region += 1 }
            let inRegion = region < result.regions.count && result.regions[region].from <= row.index ? region : nil
            if folding, row.status == .same {
                var end = i
                while end + 1 < rows.count, rows[end + 1].status == .same, rows[end + 1].index == rows[end].index + 1 { end += 1 }
                if end - i + 1 >= foldMinimum {
                    items.append(.fold(from: i, to: end))
                    if expanded.contains(i) { items += (i...end).map(AlignmentItem.row) }
                    i = end + 1
                    continue
                }
            }
            if filter.admits(row) {
                if let r = inRegion, r != openRegion {
                    items.append(.region(r))
                    openRegion = r
                }
                items.append(.row(i))
            }
            i += 1
        }
        if let note = AnalysisVocabulary.regionCapFooter(regions: result.summary.regions, returned: result.regions.count) {
            items.append(.footer(note))
        }
        if let note = AnalysisVocabulary.rowCapFooter(rows: result.summary.rows, returned: rows.count) { items.append(.footer(note)) }
        return items
    }

    /// The item position of the first row of the region after (`forward`) or before the item at `selected`, for Go ▸
    /// Next and Previous Difference Region. Before means a region that starts above the selection, so from a region's
    /// first row Previous goes to the region before it. Without a selection, Next goes to the first region and Previous
    /// to the last.
    static func regionStart(_ items: [AlignmentItem], from selected: Int?, forward: Bool) -> Int? {
        let starts = items.indices.compactMap { p -> Int? in
            guard case .region = items[p], p + 1 < items.count, items[p + 1].rowPosition != nil else { return nil }
            return p + 1
        }
        guard let selected else { return forward ? starts.first : starts.last }
        return forward ? starts.first { $0 > selected } : starts.last { $0 < selected }
    }

    /// The fold whose rows include the alignment position `row`; nil when no fold holds it.
    static func fold(containing row: Int, in items: [AlignmentItem]) -> AlignmentItem? {
        items.first { if case .fold(let from, let to) = $0 { return (from...to).contains(row) } else { return false } }
    }
}

// MARK: - Words the comparison adds

enum CompareText {
    /// What a side cell shows for an action, and its tooltip. A search or a shell command shows the engine's `label`
    /// (what it ran or looked for), whose target key (`sh:rg#5108b0426cc5`, `sh:npm run`) goes in the tooltip; other
    /// actions show their object without the prefix the op symbol already says (§5.10 Objects).
    static func action(_ a: DiffResult.ActionView) -> (text: String, help: String?) {
        let base = AnalysisVocabulary.object(a)
        if let label = a.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty,
           a.op == .search || a.object.hasPrefix("sh:") {
            return (label, "Target " + a.object)
        }
        return base
    }

    /// `text` cut in the middle to at most `limit` characters (DESIGN.md §3.5: paths and commands keep both ends), for
    /// call tokens whose full text is their tooltip.
    static func clipped(_ text: String, to limit: Int) -> String {
        guard text.count > limit, limit > 1 else { return text }
        let head = (limit - 1) / 2, tail = limit - 1 - head
        return text.prefix(head) + "…" + text.suffix(tail)
    }

    /// An action in words for accessibility labels and sentences: "search rg -n auth", "edit src/auth/session.ts".
    static func spoken(_ a: DiffResult.ActionView) -> String {
        AnalysisVocabulary.opWord(a.op) + " " + action(a).text
    }

    /// Time since the run started, the one figure the client works out (formatting an elapsed offset); nil when the
    /// action or the run has no start.
    static func elapsed(_ a: DiffResult.ActionView, runStart: Int64?) -> String? {
        guard let start = a.start, let runStart, start >= runStart else { return nil }
        return Formatters.duration(start - runStart)
    }

    /// The Since start cell's tooltip: when the action started, and how long it ran when the engine sends both ends.
    static func elapsedHelp(_ a: DiffResult.ActionView, side: CompareSide) -> String? {
        guard let start = a.start else { return nil }
        var text = "Started \(Formatters.timestamp(start, digits: 3)), measured from the start of run \(side.letter)"
        if let end = a.end, end >= start { text += "\nRan " + Formatters.duration(end - start) }
        return text
    }

    /// A side cell's tooltip: the target or full text, then what the run had done before ("3rd edit of this file; the
    /// last check before it failed"), then the failed mark's meaning or an outcome the logs do not hold.
    static func sideHelp(_ a: DiffResult.ActionView, row: DiffResult.AlignmentRow, side: CompareSide) -> String {
        var lines = [action(a).help ?? action(a).text]
        let prefix = side.letter + ": "
        if let state = AnalysisVocabulary.rowHelp(row)?.split(separator: "\n").first(where: { $0.hasPrefix(prefix) }) {
            lines.append(String(state.dropFirst(prefix.count)))
        }
        if a.outcome == .failed { lines.append("The action failed.") }
        if let unknown = AnalysisVocabulary.outcomeHelp(a.outcome) { lines.append(unknown + ".") }
        return lines.joined(separator: "\n")
    }

    /// The confidence mark after a row's status: a paired row's, "?" for a candidate and "≈" for a derived pairing. An
    /// action only one run has is paired with nothing, so its status has no mark, whatever an older engine sent.
    static func pairingMark(_ row: DiffResult.AlignmentRow) -> String {
        row.isPaired ? AnalysisVocabulary.confidenceMark(row.confidence) : ""
    }

    /// The mark in words for accessibility labels: "candidate", "derived", or nil for an unpaired row.
    static func pairingWord(_ row: DiffResult.AlignmentRow) -> String? {
        row.isPaired ? AnalysisVocabulary.confidenceWord(row.confidence) : nil
    }

    /// The status gutter's tooltip: the status, then why a pairing is a candidate ("Candidate pairing: the action occurs
    /// more than once in a run, so another pairing would score the same."), or what an unpaired row does not show. The
    /// rule and its unchecked precision are stated once, in the column's header tooltip (`statusColumnHelp`).
    static func statusHelp(_ row: DiffResult.AlignmentRow) -> String {
        let status = AnalysisVocabulary.statusWord(row.status)
        guard row.isPaired else {
            let other: CompareSide = row.left == nil ? .a : .b
            return status + "\nNo action of run \(other.letter) is paired with it, which is not evidence that run \(other.letter) did nothing like it."
        }
        guard row.confidence != .derived else { return status + "\nDerived pairing: the action occurs once in each run." }
        return status + "\n" + candidateHelp(row)
    }

    /// Why a pairing is a candidate: "Candidate pairing: the action occurs more than once in a run, so another pairing
    /// would score the same."
    static func candidateHelp(_ row: DiffResult.AlignmentRow) -> String {
        var why: [String] = []
        if row.ambiguous { why.append("the action occurs more than once in a run, so another pairing would score the same") }
        if row.status == .objectDiffers { why.append("the two actions differ in target, so they are paired by their place in the runs") }
        if why.isEmpty { why.append("the engine does not vouch for it") }
        return "Candidate pairing: " + why.joined(separator: "; ") + "."
    }

    /// The selection bar's words for a row whose status carries ?: "? ambiguous" for a row the ambiguous chip counts, so
    /// the bar and the chip name the same rows; "? paired by place" for a different-target row that is not ambiguous;
    /// "? candidate" otherwise. Nil for a row without ?.
    static func candidateNote(_ row: DiffResult.AlignmentRow) -> String? {
        let mark = AnalysisVocabulary.confidenceMark(.candidate)
        guard pairingMark(row) == mark else { return nil }
        if row.ambiguous { return mark + " ambiguous" }
        return mark + (row.status == .objectDiffers ? " paired by place" : " candidate")
    }

    /// The status column's header tooltip, where the method's caveat is stated once for every row.
    static func statusColumnHelp(rule: String) -> String {
        "Status of the row in both runs. ? marks a candidate pairing, ≈ a derived one.\n"
            + "Every pairing comes from rule \(rule). " + AnalysisVocabulary.precisionNotChecked
    }

    /// A summary chip in a narrow pane (§5.9), keeping its noun: "0 same", "2 outcome", "14 target", "23 only A",
    /// "12 only B". Its tooltip and accessibility label keep the full chip, "2 different outcome".
    static func shortChip(_ s: AlignmentStatus, count: Int) -> String {
        let noun: String
        switch s {
        case .outcomeDiffers: noun = "outcome"
        case .objectDiffers: noun = "target"
        case .leftOnly: noun = "only A"
        case .rightOnly: noun = "only B"
        default: return AnalysisVocabulary.chip(s, count: count)
        }
        return Formatters.count(count) + " " + noun
    }

    /// The summary chips' legend (§5.9): each status's symbol and words, then the marks after them.
    static let legend = "= same · ⚠ different outcome · ⇆ different target · ‹ only in A · › only in B. "
        + "? after a status marks a candidate pairing: the action occurs more than once in a run, or the two actions differ in "
        + "target. ≈ marks a derived pairing. Rows only in one run have no mark."

    /// The ambiguous chip's tooltip. The chip shows ?, and ? marks more rows than the chip counts, so it names both.
    static let ambiguousHelp = "Rows whose action occurs more than once in a run, so another pairing would score the same. "
        + "? marks these rows and every different-target row, which is paired by its place in the runs."

    /// A row read aloud: "Row 120, A: edit src/auth/session.ts, failed, 4m 10s since start; Different outcome, derived;
    /// B: edit src/auth/session.ts, 9m 52s since start".
    static func rowLabel(_ row: DiffResult.AlignmentRow, elapsed: (CompareSide) -> String?) -> String {
        func side(_ s: CompareSide) -> String {
            guard let a = row.action(s) else { return "\(s.letter): no action" }
            var parts = [spoken(a)]
            if a.outcome == .failed { parts.append("failed") }
            if let e = elapsed(s) { parts.append(e + " since start") }
            return "\(s.letter): " + parts.joined(separator: ", ")
        }
        let status = [AnalysisVocabulary.statusWord(row.status), pairingWord(row)].compactMap { $0 }.joined(separator: ", ")
        return "Row \(Formatters.count(row.index + 1)), " + [side(.a), status, side(.b)].joined(separator: "; ")
    }

    /// A region as its group row tells it. A side's wall time shorter than the spread of its own rows' starts cannot
    /// hold those rows, so it is dropped and the side reads without "in …": an engine before the region-span fix
    /// measured a side from its first row to its last, which interleaved subagent actions put out of time order.
    static func regionShown(_ region: DiffResult.Region, in result: DiffResult) -> DiffResult.Region {
        let all = result.alignment
        // The engine returns rows in index order from 0, so a region's rows are a slice; a cut list is searched.
        let rows: ArraySlice<DiffResult.AlignmentRow>
        if all.indices.contains(region.from), all[region.from].index == region.from {
            rows = all[region.from...min(region.to, all.count - 1)]
        } else {
            rows = ArraySlice(all.filter { (region.from...region.to).contains($0.index) })
        }
        var shown = region
        for side in CompareSide.allCases {
            let starts = rows.compactMap { $0.action(side)?.start }
            guard let first = starts.min(), let last = starts.max(), let wall = side == .a ? region.left.wallUs : region.right.wallUs,
                  wall < last - first else { continue }
            if side == .a { shown.left.wallUs = nil } else { shown.right.wallUs = nil }
        }
        return shown
    }

    /// The data-gap line's gaps (§5.8 Placement): the conditional ones, found in this data, the gaps that cut what the
    /// table lists first. The permanent gaps, true of every comparison, go to the divergence card's caveat line.
    static func dataGaps(_ coverage: WorkbenchCoverage) -> [WorkbenchGap] {
        let first: [WorkbenchGap] = [.actionLimit, .alignmentRowLimit, .regionLimit, .eventLimit]
        let shown = coverage.gaps.filter { !permanent($0, coverage) }
        return shown.filter(first.contains).sorted { first.firstIndex(of: $0)! < first.firstIndex(of: $1)! }
            + shown.filter { !first.contains($0) }
    }

    /// The permanent gaps of this comparison, the caveat line's two first: the data-gap popover's Caveats and the caveat
    /// line's tooltip list them.
    static func permanentGaps(_ coverage: WorkbenchCoverage) -> [WorkbenchGap] {
        WorkbenchGap.permanentDiffGaps + coverage.gaps.filter { permanent($0, coverage) && !WorkbenchGap.permanentDiffGaps.contains($0) }
    }

    /// The divergence card's caveat line in full, for its tooltip: every permanent gap's sentence, then the engine's
    /// caveats.
    static func caveatHelp(_ result: DiffResult) -> String {
        (permanentGaps(result.coverage).map { AnalysisVocabulary.gapText($0, note: result.coverage.note($0)) } + result.caveats).joined(separator: "\n")
    }

    private static func permanent(_ gap: WorkbenchGap, _ coverage: WorkbenchCoverage) -> Bool {
        WorkbenchGap.permanentDiffGaps.contains(gap) || coverage.isPermanent(gap)
    }

    /// The moment whose offset the evidence line's "Times" names: the earlier run's start, the moment the Since start
    /// tooltips and the Runs grid show, as Critical Path names its path's start; the analysis time when neither start is
    /// known.
    static func timesMoment(_ result: DiffResult, catalog: [String: SessionRow]) -> Int64 {
        CompareSide.allCases.compactMap { CompareRun(id: result.run($0).session, result: result, catalog: catalog).start }.min()
            ?? result.coverage.snapshotAt
    }

    /// The data-gap line's sentences, whole, in `dataGaps` order: its popover-free reading and accessibility label.
    static func dataGapSentences(_ coverage: WorkbenchCoverage) -> [String] {
        dataGaps(coverage).map { AnalysisVocabulary.gapText($0, note: coverage.note($0)) }
    }

    /// "ⓘ 2 data gaps: Only the first 100 of 111 difference regions were returned; order across subagents comes from
    /// timestamps", or the one gap's sentence alone (the ⓘ is the line's symbol): `AnalysisVocabulary.gapHeadline`, as
    /// Critical Path and the run report word their lines. Nil for no gap beyond the caveat line's.
    static func dataGapHeadline(_ coverage: WorkbenchCoverage) -> String? {
        let sentences = dataGapSentences(coverage)
        return sentences.isEmpty ? nil : AnalysisVocabulary.gapHeadline(sentences)
    }

    /// What the data-gap line says when every gap is on the caveat line.
    static let noDataGaps = "No data gaps beyond the caveats on the first divergence."

    /// "7,132 of 7,132 events": what the engine read of the two runs.
    static func eventsRead(_ coverage: WorkbenchCoverage) -> String {
        "\(Formatters.count(coverage.eventsExamined)) of \(Formatters.count(coverage.eventsAvailable, "event"))"
    }
}

// MARK: - Refusals (ANALYSIS-UX §5.13)

/// What Compare shows when the engine does not return an alignment.
enum CompareFailure: Equatable {
    /// 503 `workbench-unavailable`: the request runs again after the next index run by itself.
    case indexNotReady
    /// 503 `query-timeout`: Retry, Retry Without Subagents, Retry With 500 Actions per Run.
    case timeout
    /// 400 `session-not-found`: the side whose run left the index, when the message names it.
    case runGone(CompareSide?)
    /// 400 `session-tree-limit`.
    case treeLimit
    /// 400 `row-limit`, with the engine's sentence.
    case rowLimit(String)
    /// The engine predates the analysis.
    case notServed
    /// Anything else: Retry.
    case other

    init(_ e: APIError, sides: CompareSides?) {
        if e.isWorkbenchUnavailable { self = .indexNotReady; return }
        if e.isWorkbenchNotServed { self = .notServed; return }
        switch e.workbenchCode {
        case .timeout?: self = .timeout
        case .sessionNotFound?:
            let gone = e.missingSession
            self = .runGone(gone == sides?.a ? .a : gone == sides?.b ? .b : nil)
        case .sessionTreeLimit?: self = .treeLimit
        case .rowLimit?: self = .rowLimit(e.message)
        default: self = .other
        }
    }

    var title: String {
        switch self {
        case .indexNotReady: return "Compare needs the finished index."
        case .timeout: return "Alignment took longer than 30 s."
        case .runGone(let side?): return "Run \(side.letter) is no longer in the index."
        case .runGone(nil): return "One of these runs is no longer in the index."
        case .treeLimit: return "One of these runs has more than 500 sessions, the analysis limit."
        case .rowLimit(let sentence): return sentence
        case .notServed: return "Compare needs a newer engine."
        case .other: return "Could not load this analysis."
        }
    }
}

// MARK: - The window's comparison

extension WindowModel {
    /// Session · Compare's alignment is on screen: the scope holds runs to compare, and the comparison holds the window's
    /// alignment of them (the check `Snapshot.compareShown` makes). ⌘↩ and Go ▸ Difference Region act on its rows only
    /// then, never on a table the scope or a new request took off the screen.
    var compareShowsAlignment: Bool {
        guard case .runs = compareScope, analyses.diff.value != nil, let key = analyses.diff.key else { return false }
        return compareModel.result != nil && compareModel.key == key
    }
}

/// The comparison one window shows: the result, the chips, the folds and the selected row. It outlives the view, so
/// switching modes and coming back keeps them, and it answers Go ▸ Next and Previous Difference Region.
@MainActor @Observable final class CompareModel: DifferenceRegionNavigating {
    @ObservationIgnored private weak var window: WindowModel?

    /// The alignment on screen and its request key.
    private(set) var result: DiffResult?
    private(set) var key: String?
    var filter = AlignmentFilter() { didSet { if filter != oldValue, !switching { layout() } } }
    /// First positions of the folds that are open.
    var expandedFolds: Set<Int> = [] { didSet { if expandedFolds != oldValue, !switching { layout() } } }
    /// `show` is starting the state over for another key, and lays the rows out once when it is done.
    @ObservationIgnored private var switching = false
    private(set) var items: [AlignmentItem] = []
    /// The selected table row (an aligned row or a fold).
    private(set) var selected: AlignmentItem?
    /// The run whose action the inspector shows; ← and → choose it.
    private(set) var side: CompareSide = .a
    /// Increments when the table should scroll the selection into view.
    private(set) var scrollRequest = 0
    /// The Runs grid's disclosure (§5.6) once it is opened or folded in this window; until then the window's height
    /// decides (`RunSummaryGrid.opensByDefault`).
    var runsOpen: Bool?
    /// The Behavior disclosure (§5.7), closed until opened.
    var behaviorOpen = false
    /// Columns the table hid for want of width ("#", "Since start (A)"), which the chips row names (DESIGN.md §4.4).
    var hiddenColumns: [String] = []

    init(window: WindowModel?) {
        self.window = window
    }

    /// The one comparison of `window`, made on first use; it goes when the window does.
    static func of(_ window: WindowModel) -> CompareModel {
        window.compareModel
    }

    /// Show `result` for `key`. Another key is another pair or other options, so the chips, folds and selection start
    /// over; Only Differences is a view option and stays. A Refresh (the same key) keeps the selected action, wherever
    /// the new rows put it.
    func show(_ result: DiffResult?, key: String?) {
        // A result is up to 3,000 rows: its snapshot time tells a Refresh apart without comparing the rows.
        guard key != self.key || result?.coverage.snapshotAt != self.result?.coverage.snapshotAt || (result == nil) != (self.result == nil) else { return }
        let another = key != self.key
        // The event the highlight and the inspector show, as the old rows hold it.
        let event = another ? nil : selectedAction?.eventID
        self.key = key
        self.result = result
        if another {
            switching = true
            filter = AlignmentFilter(onlyDifferences: filter.onlyDifferences)
            expandedFolds = []
            selected = nil
            side = .a
            switching = false
        }
        layout()
        if let event { reselect(event) }
    }

    /// After a Refresh, select the row that holds `event`: on the chosen side, else on the other, which the inspector
    /// then shows; a fold closed over it opens. Rows a live run inserted would otherwise move the highlight to another
    /// action while the inspector keeps the old one. With no listed row holding it, nothing stays selected, in the table
    /// or in the inspector.
    private func reselect(_ event: String) {
        guard let result else { return }
        let found = [side, side.other].lazy.compactMap { s in
            result.alignment.firstIndex { $0.action(s)?.eventID == event }.map { (side: s, row: $0) }
        }.first
        if let found, !items.contains(.row(found.row)), case .fold(let from, _)? = AlignmentLayout.fold(containing: found.row, in: items) {
            expandedFolds.insert(from)
        }
        guard let found, items.contains(.row(found.row)) else {
            selected = nil
            if window?.selectedEvent == event { window?.selectedEvent = nil }
            return
        }
        side = found.side
        select(.row(found.row), scroll: true)
    }

    private func layout() {
        items = result.map { AlignmentLayout.items($0, filter: filter, expanded: expandedFolds) } ?? []
        if let s = selected, !items.contains(s) {
            // A row that a fold closed over gives the selection to its fold.
            if let row = s.rowPosition, let fold = AlignmentLayout.fold(containing: row, in: items) { selected = fold } else { selected = nil }
        }
    }

    // MARK: Selection

    var selectedRow: DiffResult.AlignmentRow? {
        guard let result, let p = selected?.rowPosition, result.alignment.indices.contains(p) else { return nil }
        return result.alignment[p]
    }

    /// The selected row's action on the chosen side.
    var selectedAction: DiffResult.ActionView? { selectedRow?.action(side) }

    /// The selection bar's words (§5.12): "Row 21 · Different outcome · A" and the chosen run's action as the table shows
    /// it, the test symbol before "pytest -q tests/test_b.py"; a fold's "38 same actions (rows 41–78) · Space shows
    /// them"; nil while nothing is selected. A status that carries ? says why after it ("Different outcome · ?
    /// ambiguous"). The run's letter shows on a paired row only: an unpaired row's status names its run. Why the pairing
    /// is a candidate, whether the action failed and its full target go to the tooltip.
    var selectionSentence: SelectionSentence? {
        if let row = selectedRow {
            let note = CompareText.candidateNote(row)
            var sentence = SelectionSentence(lead: "Row \(Formatters.count(row.index + 1))",
                                             parts: [AnalysisVocabulary.statusWord(row.status)] + [note].compactMap { $0 })
            var detail = note == nil ? [] : [CompareText.candidateHelp(row)]
            if let a = selectedAction {
                if row.isPaired { sentence.parts.append(side.letter) }
                let shown = CompareText.action(a)
                sentence.action = .init(symbol: AnalysisVocabulary.opSymbol(a.op), op: AnalysisVocabulary.opWord(a.op), object: shown.text)
                detail += [a.outcome == .failed ? "Run \(side.letter)'s action failed." : nil, shown.help].compactMap { $0 }
            }
            sentence.detail = detail.isEmpty ? nil : detail.joined(separator: " ")
            return sentence
        }
        if case .fold(let from, let to)? = selected, let r = result?.alignment, r.indices.contains(from), r.indices.contains(to) {
            return SelectionSentence(lead: AnalysisVocabulary.foldRow(from: r[from].index, to: r[to].index), parts: ["Space shows them"])
        }
        return nil
    }

    var selectedPosition: Int? { selected.flatMap { items.firstIndex(of: $0) } }

    /// Select a table row. An aligned row selects its action's event on the chosen side, or on the side that has one, so
    /// the inspector shows it; nothing switches workspace (`reveal: false`, §5.12).
    func select(_ item: AlignmentItem?, scroll: Bool = false) {
        selected = item
        if scroll { scrollRequest += 1 }
        guard let row = selectedRow else { return }
        if row.action(side) == nil { side = side.other }
        selectEvent()
    }

    /// Select the aligned row at `position` in `alignment` and scroll to it (Show Row, the minimap). A chip that hides
    /// the row lets go, and so does Only Differences when the row is a same row; a closed fold over it opens.
    func reveal(row position: Int) {
        guard let result, result.alignment.indices.contains(position) else { return }
        let row = result.alignment[position]
        if !filter.admits(row) {
            var f = filter
            f.statuses = []
            f.ambiguousOnly = false
            if !f.admits(row) { f.onlyDifferences = false }
            filter = f
        }
        if !items.contains(.row(position)), case .fold(let from, _)? = AlignmentLayout.fold(containing: position, in: items) {
            expandedFolds.insert(from)
        }
        select(.row(position), scroll: true)
    }

    /// ← and →, and the inspector's A | B control: show the other run's action of a paired row.
    func choose(_ side: CompareSide) {
        guard let row = selectedRow, row.action(side) != nil else { return NSSound.beep() }
        self.side = side
        selectEvent()
    }

    private func selectEvent() {
        guard let a = selectedAction else { return }
        window?.select(event: a.eventID, reveal: false)
    }

    /// Show in Session for the chosen run's action: Session · Steps of the action's own session (a subagent's action
    /// opens that subagent), with its step expanded. It names the session itself, so it never waits for the event's
    /// detail to learn it; Back returns to Compare.
    func showInSession() {
        guard let window, let a = selectedAction else { return NSSound.beep() }
        window.select(event: a.eventID, reveal: false)
        window.sessionMode = .steps
        if window.scope.sessions.contains(a.sessionId) {
            window.singleSessionChoice = a.sessionId
            window.workspace = .session
        } else {
            window.openSession(a.sessionId, workspace: .session)
        }
        window.steps.focus(event: a.eventID)
    }

    /// Show in Timeline for the chosen run's action, selected there as Flow does.
    func showInTimeline() {
        guard let window, let a = selectedAction else { return NSSound.beep() }
        window.select(event: a.eventID, reveal: false)
        window.workspace = .timeline
    }

    /// Space: open the selected fold, or close the open fold the selected row belongs to.
    func toggleFold() {
        switch selected {
        case .fold(let from, _)?:
            if expandedFolds.contains(from) { expandedFolds.remove(from) } else { expandedFolds.insert(from) }
        case .row(let p)?:
            guard case .fold(let from, let to)? = AlignmentLayout.fold(containing: p, in: items), expandedFolds.contains(from) else {
                return NSSound.beep()
            }
            expandedFolds.remove(from)
            select(.fold(from: from, to: to), scroll: true)
        default:
            NSSound.beep()
        }
    }

    // MARK: Difference regions (Go menu)

    /// The rows are on screen: in a window, while it shows this alignment (`WindowModel.compareShowsAlignment`); without
    /// one, while there are rows.
    private var isShown: Bool { window?.compareShowsAlignment ?? (result != nil) }

    func canStepDifferenceRegion(forward: Bool) -> Bool {
        isShown && AlignmentLayout.regionStart(items, from: selectedPosition, forward: forward) != nil
    }

    func stepDifferenceRegion(forward: Bool) {
        guard isShown, let p = AlignmentLayout.regionStart(items, from: selectedPosition, forward: forward) else { return NSSound.beep() }
        select(items[p], scroll: true)
    }
}
