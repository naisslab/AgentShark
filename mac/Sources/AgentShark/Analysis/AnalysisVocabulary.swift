import AppKit

/// Words, marks and colors of the two analyses, Session · Critical Path (AgentPerf) and Session · Compare (AgentDiff),
/// so both views, their accessibility labels and their tests read one table (ANALYSIS-UX §4.6, §4.7, §5.6–§5.10,
/// Decisions 9, 10 and 13). The words are the Workbench page's (web/js/lib/workbench-format.js), which §6.4 requires to
/// match word for word. A key this table does not know reads as plain words and draws neutral, never in a kind color.
enum AnalysisVocabulary {
    /// Phrases client-written analysis copy never uses (Decision 9, SPEC §12.1.4): the views state shares, alignments
    /// and leads, never a cause or a verdict on a run. The engine's fixed advice and caveat sentences are quoted
    /// verbatim and are not client copy.
    static let bannedPhrases = ["caused", "because", "root cause", "bound this run", "better run", "worse run"]

    /// The tooltip reason for a value the engine returns as null (DESIGN.md §9 Missing values), on both clients.
    static let notDetermined = "Not determined by the logs"

    /// A value cell: the value, or "—" with its reason in the tooltip when the engine returns null; never 0 (§5.14).
    static func value(_ text: String?, reason: String = notDetermined) -> (text: String, help: String?) {
        guard let text else { return (Formatters.missing, reason) }
        return (text, nil)
    }

    // MARK: Path classes (CLASS_OF in src/workbench/perf.ts)

    /// The classes in the fixed order of the class bar and its legend, so two runs read alike.
    static let classes = PathClass.known

    static func className(_ c: PathClass) -> String {
        switch c.rawValue {
        case "model": return "Model"
        case "tools": return "Tools"
        case "harness": return "Compaction"
        case "coordination": return "Waiting on other agents"
        case "people": return "Waiting on people"
        case "idle": return "Idle between turns"
        case "unattributed": return "Unattributed"
        default: return words(c.rawValue)
        }
    }

    /// The time buckets a class sums, in TIME_BUCKETS order.
    static func buckets(of c: PathClass) -> [TimeBucketName] {
        switch c.rawValue {
        case "model": return ["api-retry", "model"]
        case "tools": return ["wait-process", "hook", "tool"]
        case "harness": return ["compaction"]
        case "coordination": return ["wait-agent", "coordination"]
        case "people": return ["wait-human", "human-gap"]
        case "idle": return ["continuation"]
        case "unattributed": return ["unattributed"]
        default: return []
        }
    }

    /// The class of a time bucket, or nil for a bucket no class names.
    static func pathClass(of bucket: TimeBucketName) -> PathClass? {
        classes.first { buckets(of: $0).contains(bucket) }
    }

    /// A class takes the color of its buckets on the Steps time bar (DESIGN.md §5.2 item 3); idle, unattributed and
    /// unknown classes are neutral, and idle's fill is lighter than the unattributed grey.
    static func classColor(_ c: PathClass) -> NSColor {
        switch c.rawValue {
        case "model": return Theme.color(.llm)
        case "tools": return Theme.color(.toolOther)
        case "harness": return Theme.color(.compaction)
        case "coordination": return Theme.color(.agent)
        case "people": return Theme.color(.user)
        case "idle": return TimeBar.idle
        default: return TimeBar.neutral
        }
    }

    /// The legend's share column title, naming the denominator: "Share (of 11m 30s path)".
    static func shareColumnTitle(pathUs: Int64) -> String {
        "Share (of \(Formatters.duration(pathUs)) path)"
    }

    /// A legend row (§4.7): the class's swatch and name, its time and share, and the full "{part}" form the bar's
    /// accessibility label reads.
    struct LegendRow: Equatable, Sendable {
        var pathClass: PathClass
        var name: String
        var time: String
        var share: String
        var part: String
    }

    /// One row per class with time on the path, in the fixed class order; none when the path has no length.
    static func legendRows(_ cp: PerfResult.CriticalPath) -> [LegendRow] {
        guard let wall = cp.wallUs, wall > 0 else { return [] }
        return classes.compactMap { c in
            cp.byClass[c].map {
                LegendRow(pathClass: c, name: className(c), time: Formatters.duration($0.us), share: Formatters.share($0.share),
                          part: Formatters.part($0.us, of: wall, share: $0.share))
            }
        }
    }

    /// The class bar's accessibility label, which lists every legend row in full (§4.7 Text equivalent): "Critical
    /// path by class: Model, 1m 28s of 11m 30s (13%); Waiting on people, 8m 15s of 11m 30s (72%)".
    static func classBarLabel(_ rows: [LegendRow]) -> String {
        "Critical path by class: " + rows.map { $0.name + ", " + $0.part }.joined(separator: "; ")
    }

    // MARK: Verdict (§4.6, Decision 10)

    /// A verdict line and the mark after it: "≈" when the line states a derived share or quotes the engine's advice.
    struct VerdictLine: Equatable, Sendable {
        var text: String
        var mark = ""

        var shown: String { text + mark }
        /// The mark read as a word after the line (DESIGN.md §10.2).
        var spoken: String { mark.isEmpty ? text : text + ", derived" }
    }

    struct Verdict: Equatable, Sendable {
        enum Form: Sendable {
            case normal, notEstablished, empty
        }

        var form: Form
        /// The Title-role lines, at most two.
        var lines: [VerdictLine]
        /// The secondary lines under them.
        var notes: [VerdictLine]
    }

    /// The verdict on a critical path. Decision 10 picks the form: "Not established" whenever the gap
    /// `critical-path-mostly-unexplained` is present, and the empty form when the path has no length or no largest
    /// class. Each line states a share, never a cause (Decision 9), and every share is the engine's.
    static func verdict(_ cp: PerfResult.CriticalPath, gaps: [WorkbenchGap]) -> Verdict {
        guard let wall = cp.wallUs, wall > 0, let binding = cp.binding else {
            return Verdict(form: .empty, lines: [VerdictLine(text: "No timed activity on this run's critical path.")], notes: [])
        }
        let mark = cp.bindingSrc.mark
        func share(_ c: PathClass) -> String {
            className(c) + ", " + Formatters.part(cp.byClass[c]?.us ?? 0, of: wall, share: cp.byClass[c]?.share)
        }
        if gaps.contains(.mostlyUnexplained) {
            let u = cp.byClass[.unattributed]
            var lines = [VerdictLine(text: "Not established: \(Formatters.duration(u?.us ?? 0)) of the \(Formatters.duration(wall)) critical path "
                                         + "(\(Formatters.share(u?.share))) is unattributed.")]
            // An engine before 1.1 sends no largest attributed class.
            if let c = cp.largestAttributedClass { lines.append(VerdictLine(text: "Largest attributed share: " + share(c), mark: mark)) }
            return Verdict(form: .notEstablished, lines: lines, notes: [VerdictLine(text: "The logs do not explain most of the path; see the data gaps.")])
        }
        var lines = [VerdictLine(text: "Largest share of the critical path: " + share(binding), mark: mark)]
        // An engine before 1.1 can name unattributed time as the agent-side class; no line headlines unexplained time.
        let agent = cp.agentBinding.flatMap { $0 == binding || $0 == .unattributed ? nil : $0 }
        if let agent { lines.append(VerdictLine(text: "Largest agent-side share: " + share(agent), mark: mark)) }
        let advice = cp.advice.filter { ($0.class == binding || $0.class == agent) && !$0.text.isEmpty }
        return Verdict(form: .normal, lines: lines, notes: advice.map { VerdictLine(text: $0.text, mark: "≈") })
    }

    /// The tooltip of the verdict's ≈ (§4.6): "Derived: the largest share of the critical path (rule
    /// derived:largest-share). Precision not yet checked."
    static func verdictHelp(rule: String) -> String {
        confidenceHelp(.derived, "the largest share of the critical path", rule: rule)
    }

    /// The evidence popover's rule line (§4.4): "Rule: derived:largest-share. Precision not yet checked."
    static func ruleLine(_ rule: String) -> String {
        "Rule: \(rule). " + precisionNotChecked
    }

    // MARK: Actions (Op in src/workbench/actions.ts)

    /// The ops an alignment row can carry: the engine's less `wait`, which it leaves out of the alignment.
    static let ops = ActionOp.known.filter { $0 != .wait }

    static func opSymbol(_ op: ActionOp) -> String {
        switch op.rawValue {
        case "edit": return "pencil"
        case "read": return "doc.text"
        case "search": return "magnifyingglass"
        case "test": return "testtube.2"
        case "build": return "hammer"
        case "typecheck": return "checkmark.seal"
        case "vcs": return "arrow.triangle.branch"
        case "install": return "shippingbox"
        case "run": return "terminal"
        case "web": return "globe"
        case "mcp": return "puzzlepiece.extension"
        case "delegate": return "person.2"
        case "plan": return "list.bullet.clipboard"
        case "ask": return "questionmark.bubble"
        default: return "ellipsis.circle"
        }
    }

    /// The op as a word: the symbol's accessibility label, the noun of a region header's op counts, and the head of
    /// an action in words (`actionText`).
    static func opWord(_ op: ActionOp) -> String {
        switch op.rawValue {
        case "vcs": return "version control"
        case "mcp": return "MCP"
        default: return words(op.rawValue)
        }
    }

    /// An action's object without what its symbol already says (§5.10): `edit:` and `read:` lose their prefix, and a
    /// search names its target ("rg") with the full object (`sh:rg#5108b0426cc5`) as the tooltip.
    static func object(_ a: DiffResult.ActionView) -> (text: String, help: String?) {
        let o = a.object
        if o.hasPrefix("edit:") || o.hasPrefix("read:") { return (String(o.dropFirst(5)), nil) }
        guard a.op == .search else { return (o, nil) }
        let target = o.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? o
        return (target.hasPrefix("sh:") ? String(target.dropFirst(3)) : target, o)
    }

    /// An action in words: "edit src/auth/session.ts", "search rg", "test sh:npm test".
    static func actionText(_ a: DiffResult.ActionView) -> String {
        (opWord(a.op) + " " + object(a).text).trimmingCharacters(in: .whitespaces)
    }

    /// An aligned action's outcome mark: only a failure draws one, `xmark.octagon` in `outcomeColor`.
    static func outcomeSymbol(_ o: ActionOutcome) -> String? {
        o == .failed ? "xmark.octagon" : nil
    }

    static func outcomeColor(_ o: ActionOutcome) -> NSColor? {
        o == .failed ? Theme.err : nil
    }

    /// The outcome in the middle of a sentence ("succeeded in both runs") and as the mark's accessibility label:
    /// "succeeded", "failed", or "outcome not logged".
    static func outcomeWord(_ o: ActionOutcome) -> String {
        switch o.rawValue {
        case "ok": return "succeeded"
        case "unknown": return "outcome not logged"
        default: return words(o.rawValue)
        }
    }

    /// The tooltip where an unknown outcome draws no mark.
    static func outcomeHelp(_ o: ActionOutcome) -> String? {
        o == .unknown ? "Outcome not logged" : nil
    }

    // MARK: Alignment status (Status in src/workbench/diff.ts)

    static let statuses = AlignmentStatus.known

    static func statusSymbol(_ s: AlignmentStatus) -> String {
        switch s.rawValue {
        case "same": return "equal"
        case "outcome-differs": return "exclamationmark.triangle"
        case "object-differs": return "arrow.left.arrow.right"
        case "left-only": return "chevron.left"
        case "right-only": return "chevron.right"
        default: return "questionmark.circle"
        }
    }

    /// The status as a word, for the gutter's accessibility label and tooltip.
    static func statusWord(_ s: AlignmentStatus) -> String {
        switch s.rawValue {
        case "same": return "Same"
        case "outcome-differs": return "Different outcome"
        case "object-differs": return "Different target"
        case "left-only": return "Only in A"
        case "right-only": return "Only in B"
        default: return words(s.rawValue)
        }
    }

    /// Only a different outcome is a state worth a severity color (DESIGN.md §5.2 item 1); same rows recede.
    static func statusColor(_ s: AlignmentStatus) -> NSColor {
        switch s.rawValue {
        case "same": return .tertiaryLabelColor
        case "outcome-differs": return Theme.warn
        default: return .secondaryLabelColor
        }
    }

    /// A summary chip: "1 same", "3 different outcome", "38 only in A".
    static func chip(_ s: AlignmentStatus, count: Int) -> String {
        let noun: String
        switch s {
        case .leftOnly: noun = "only in A"
        case .rightOnly: noun = "only in B"
        default: noun = statusWord(s).lowercased()
        }
        return Formatters.count(count) + " " + noun
    }

    /// The chip for ambiguous rows, which cut across the statuses: "386 ambiguous".
    static func ambiguousChip(count: Int) -> String {
        Formatters.count(count) + " ambiguous"
    }

    // MARK: Alignment rows (§5.10)

    /// A row's tooltip: "A: 3rd edit of this file; the last check before it failed." and B's on a second line; nil
    /// when the engine records neither side's edits or checks.
    static func rowHelp(_ row: DiffResult.AlignmentRow) -> String? {
        let lines = [("A", row.left), ("B", row.right)].compactMap { side, a in a.flatMap(actionState).map { "\(side): \($0)." } }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// "3rd edit of this file; the last check before it failed", or "2 earlier edits of this file" for an action that
    /// is not an edit.
    private static func actionState(_ a: DiffResult.ActionView) -> String? {
        var parts: [String] = []
        if let n = a.editsBefore {
            parts.append(a.op == .edit ? ordinal(n + 1) + " edit of this file" : Formatters.count(n, "earlier edit") + " of this file")
        }
        if a.checkBefore == .ok { parts.append("the last check before it passed") }
        if a.checkBefore == .failed { parts.append("the last check before it failed") }
        return parts.isEmpty ? nil : parts.joined(separator: "; ")
    }

    /// A region's group row: "Region 3 · rows 120–188 · A 12 actions in 4m 10s (6 edit, 4 run, 2 read) · B 31 actions
    /// in 9m 52s (…) · rejoins". A side whose wall time is unknown drops "in …"; `number` counts from 1. `opsLimit`
    /// keeps each side's most frequent ops and counts the other kinds' actions, so the list sums to the side's actions
    /// ("39 actions … (12 edit, 9 test, +18 more)"); 0 drops them all.
    static func regionHeader(_ r: DiffResult.Region, number: Int, opsLimit: Int? = nil) -> String {
        func side(_ label: String, _ s: DiffResult.RegionSide) -> String {
            let sorted = s.ops.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
            let kept = opsLimit.map { Array(sorted.prefix($0)) } ?? sorted
            var ops = kept.map { Formatters.count($0.value) + " " + opWord($0.key) }
            let rest = sorted.dropFirst(kept.count).map(\.value).reduce(0, +)
            if !kept.isEmpty, rest > 0 { ops.append("+\(Formatters.count(rest)) more") }
            return label + " " + Formatters.count(s.actions, "action") + (s.wallUs.map { " in " + Formatters.duration($0) } ?? "")
                + (ops.isEmpty ? "" : " (\(ops.joined(separator: ", ")))")
        }
        return ["Region \(Formatters.count(number))", rowRange(from: r.from, to: r.to), side("A", r.left), side("B", r.right),
                r.reconverged ? "rejoins" : "does not rejoin"].joined(separator: " · ")
    }

    /// A fold of consecutive same rows, `from` and `to` being row indexes: "38 same actions (rows 41–78)".
    static func foldRow(from: Int, to: Int) -> String {
        Formatters.count(to - from + 1, "same action") + " (\(rowRange(from: from, to: to)))"
    }

    /// "rows 41–78", or "row 3" for one row (DESIGN.md §9: the plural only above one); `from` and `to` are row indexes.
    private static func rowRange(from: Int, to: Int) -> String {
        from == to ? "row \(Formatters.count(from + 1))" : "rows \(Formatters.count(from + 1))–\(Formatters.count(to + 1))"
    }

    /// The region-cap footer: "11 more regions were not returned (limit 100). Their rows are still listed."; nil when
    /// every region was returned.
    static func regionCapFooter(regions: Int, returned: Int) -> String? {
        guard regions > returned else { return nil }
        let more = regions - returned
        return "\(Formatters.count(more)) more \(more == 1 ? "region was" : "regions were") not returned (limit \(Formatters.count(returned))). "
            + "Their rows are still listed."
    }

    /// The row-cap footer: "Showing 3,000 of 3,412 aligned rows."; nil when every row was returned or the engine
    /// (before 1.1) does not count the rows past the cap.
    static func rowCapFooter(rows: Int?, returned: Int) -> String? {
        guard let rows, rows > returned else { return nil }
        return "Showing \(Formatters.count(returned)) of \(Formatters.count(rows, "aligned row"))."
    }

    // MARK: Confidence (Decision 13; WORKBENCH.md Evidence and Confidence)

    static let confidences = WorkbenchConfidence.known

    static let precisionNotChecked = "Precision not yet checked."

    /// The mark after a value: none when observed, "≈" derived, "?" candidate, and "—" in place of an unknown value,
    /// whose reason goes in the tooltip. A category this client does not know reads as a candidate.
    static func confidenceMark(_ c: WorkbenchConfidence) -> String {
        switch c {
        case .observed: return ""
        case .derived: return "≈"
        case .unknown: return Formatters.missing
        default: return "?"
        }
    }

    /// The word VoiceOver reads after a marked value ("42.1s, derived"); nil when observed.
    static func confidenceWord(_ c: WorkbenchConfidence) -> String? {
        switch c {
        case .observed: return nil
        case .derived, .unknown: return c.rawValue
        default: return "candidate"
        }
    }

    /// The mark's tooltip (DESIGN.md §3.3): "Derived: the largest share of the critical path (rule
    /// derived:largest-share). Precision not yet checked." An unknown value gives its reason. A rule id never appears
    /// without "Precision not yet checked." (Decision 13).
    static func confidenceHelp(_ c: WorkbenchConfidence, _ subject: String, rule: String? = nil, reason: String? = nil) -> String {
        var parts = [sentence((confidenceWord(c) ?? "observed") + ": " + subject + (rule.map { " (rule \($0))" } ?? ""))]
        if c == .unknown || reason != nil { parts.append(sentence(reason ?? notDetermined)) }
        if rule != nil || (c != .observed && c != .unknown) { parts.append(precisionNotChecked) }
        return parts.joined(separator: " ")
    }

    /// An alignment row's confidence tooltip, as the web's: "Candidate pairing. This action occurs more than once in a
    /// run (ambiguous). Rule weighted-action-lcs@1. Precision not yet checked." A pairing is derived or a candidate,
    /// so any other category reads as a candidate, as its mark does.
    static func pairingHelp(confidence: WorkbenchConfidence, status: AlignmentStatus, ambiguous: Bool, rule: String?) -> String {
        let what = status == .leftOnly || status == .rightOnly ? "unpaired action" : "pairing"
        var parts = [(confidence == .derived ? "Derived " : "Candidate ") + what + "."]
        if ambiguous { parts.append("This action occurs more than once in a run (ambiguous).") }
        if let rule { parts.append("Rule \(rule).") }
        parts.append(precisionNotChecked)
        return parts.joined(separator: " ")
    }

    // MARK: Data gaps (§4.4, §5.8, Decision 12)

    /// The sentences of the two gaps every diff carries (the engine's E5 table), for a result that has no
    /// `coverage.notes`.
    static let permanentGapText: [WorkbenchGap: String] = [
        .structuralAlignment: "The alignment pairs actions by structure, not cause.",
        .shellChangesInvisible: "Shell commands can change files without a logged edit.",
    ]

    /// A gap's sentence: the engine's note (`coverage.notes`), else its `missing` effect, else a permanent diff gap's
    /// fixed sentence, else the code itself (§4.4). The code also appears in `gapHelp`.
    static func gapText(_ code: WorkbenchGap, note: String? = nil, effect: String? = nil) -> String {
        if let note, !note.isEmpty, note != code.rawValue { return note }
        if let effect, !effect.isEmpty { return effect }
        return permanentGapText[code] ?? code.rawValue
    }

    static func gapHelp(_ code: WorkbenchGap) -> String {
        "Gap code: " + code.rawValue
    }

    /// The one-line data-gap line of every analysis and derived view (§4.4, §5.8; DESIGN.md §1.7), the web's
    /// `gapHeadline` word for word, and the one builder of it on the Mac (Critical Path, Compare and the Steps run
    /// report call it): one gap reads as its sentence; several read "3 data gaps: Request queueing at the provider is
    /// inside model or unattributed time; approvals are not logged, so approval waits count as tool time; …", every gap
    /// included. The engine's sentences hold no semicolon, so each "; " parts two gaps. The line cuts at its tail, so
    /// its popover and accessibility label keep the full sentences (`gapsSpoken`). Empty for no gap: each line says
    /// what none means there. `listing`, when a view states some gaps in a row of their own, is what the line lists;
    /// the count still names every gap, as the popover does.
    static func gapHeadline(_ sentences: [String], listing: [String]? = nil) -> String {
        let count = distinct(sentences).count
        let parts = distinct(listing ?? sentences).map { String($0.dropLast()) }
        guard count > 1 else { return parts.first.map { $0 + "." } ?? "" }
        return Formatters.count(count, "data gap") + ": "
            + parts.enumerated().map { i, s in i == 0 ? s : continuation(s) }.joined(separator: "; ")
    }

    /// The gaps read aloud, every sentence whole and with its own capital: "2 data gaps: Order across subagents comes
    /// from timestamps. Codex model time is a timestamp gap.", one gap as its sentence, or `none` for no gap. The
    /// evidence line's accessibility label starts with it; the line itself shows `gapHeadline`, which its tail cuts.
    static func gapsSpoken(_ sentences: [String], none: String) -> String {
        let whole = distinct(sentences)
        guard !whole.isEmpty else { return none.hasSuffix(".") ? none : none + "." }
        return (whole.count > 1 ? Formatters.count(whole.count, "data gap") + ": " : "") + whole.joined(separator: " ")
    }

    /// Each gap sentence once, ending in a full stop, in first-seen order. Two gap codes can carry the same sentence
    /// (a run report and its sessions both say Codex model time is a timestamp gap); stating it twice read as two facts
    /// and counted it twice.
    private static func distinct(_ sentences: [String]) -> [String] {
        var seen = Set<String>()
        return sentences.map { $0.hasSuffix(".") ? $0 : $0 + "." }.filter { seen.insert($0).inserted }
    }

    /// A sentence after a semicolon starts lowercase, unless its first word is a name: an agent's ("Claude", "Codex"),
    /// or one with a capital past its first letter ("MCP", "AgentShark").
    private static func continuation(_ s: String) -> String {
        let word = s.prefix { $0.isLetter }
        if agentNames.contains(String(word)) || word.dropFirst().contains(where: \.isUppercase) { return s }
        return s.prefix(1).lowercased() + s.dropFirst()
    }

    private static let agentNames = Set(AgentKind.known.flatMap { $0.label.split(separator: " ").map(String.init) })

    /// The divergence card's caveat line (§5.8): the permanent gaps' sentences, the engine's own when it sends them.
    static func caveatLine(notes: [GapNote]?) -> String {
        WorkbenchGap.permanentDiffGaps.map { code in gapText(code, note: notes?.first { $0.code == code }?.text) }.joined(separator: " ")
    }

    // MARK: Comparison (§5.6, §5.8)

    /// Run B against run A in words. The difference is unsigned (DESIGN.md §7.8): its direction is a word and
    /// `arrow.down` or `arrow.up`, never a sign or a color alone. A null delta is "—" with its reason as `help`.
    struct Difference: Equatable, Sendable {
        /// `arrow.down` when B has less, `arrow.up` when B has more, nil when the runs match or the delta is unknown.
        var symbol: String?
        var text: String
        var help: String?
    }

    /// "12m 26s shorter", "3m 02s longer", "Same", or "—" for a null delta; `deltaUs` is B − A.
    static func durationDifference(_ deltaUs: Int64?) -> Difference {
        difference(deltaUs, less: "shorter", more: "longer") { n, word in Formatters.duration(Int64(clamping: n)) + " " + word }
    }

    /// "218 fewer actions", "1 more edit", or "19 fewer" without a noun; `delta` is B − A.
    static func countDifference(_ delta: Int64?, _ noun: String? = nil, plural: String? = nil) -> Difference {
        difference(delta, less: "fewer", more: "more") { n, word in
            Formatters.count(Int(clamping: n)) + " " + word + (noun.map { " " + (n == 1 ? $0 : plural ?? $0 + "s") } ?? "")
        }
    }

    /// "620k fewer in", "25k more out"; `delta` is B − A and `side` names the token direction.
    static func tokenDifference(_ delta: Int64?, _ side: String) -> Difference {
        difference(delta, less: "fewer", more: "more") { n, word in Formatters.tokens(Int(clamping: n)) + " " + word + " " + side }
    }

    /// The divergence card's title: "First divergence: row 1 of 1,299", or "No divergence: …" when the engine reports
    /// none, or §5.13's no-actions sentence when nothing was aligned. `firstDivergenceIndex` −1 never shows as a number.
    static func divergenceTitle(index: Int?, rows: Int) -> String {
        if rows == 0 { return "Neither run has tool actions to align." }
        guard let index, index >= 0 else {
            return rows == 1 ? "No divergence: the one aligned action is the same."
                : "No divergence: all \(Formatters.count(rows, "aligned action")) are the same."
        }
        return "First divergence: row \(Formatters.count(index + 1)) of \(Formatters.count(rows))"
    }

    /// The divergence card's second line: "Last shared action: read docs/testing.md (row 40, succeeded in both runs)",
    /// or the no-anchor sentence when the runs differ from their first action.
    static func divergenceDetail(_ d: DiffResult.Divergence) -> String {
        guard let anchor = d.anchor, let a = anchor.left else {
            return "The runs differ from their first action; no shared action precedes it."
        }
        return "Last shared action: \(actionText(a)) (row \(Formatters.count(anchor.index + 1)), \(outcomeWord(a.outcome)) in both runs)"
    }

    /// The divergence card's trailing text: the alignment points where to look, never at why.
    static let leadNotCause = "A lead for investigation, not a cause."

    // MARK: Runs

    /// The naming rule of a run (DESIGN.md §9 Sessions). A run is named by its title, else "Untitled" (`runName`), never
    /// by its id alone. An untitled run carries its id in the §3.5 form, "cx:0190a0…0001" (`runID`), as secondary
    /// metadata right where its name appears: the chooser row's and the Runs grid's detail line, and on one line
    /// (`runLabel`) the Compare With ▸ item, the session picker and the Critical Path lanes and tables. UUIDv7 and ULID
    /// ids share their leading characters within a day, so the id keeps its last four, and two untitled runs never read
    /// alike; the form is `SessionRow.displayTitle`'s, so a run reads the same in the sidebar, the scope bar and the
    /// inspector. Where a letter tells the runs apart (Compare's "A · Untitled" column headers and its inspector), the
    /// name stands alone. The full id is in the tooltip (`runHelp`).
    static let untitled = "Untitled"

    static func runName(title: String?) -> String {
        trimmed(title) ?? untitled
    }

    /// An untitled run's id, "cx:0190a0…0001": the agent's prefix, then the native id cut in the middle; nil for a run
    /// with a title.
    static func runID(title: String?, id: String) -> String? {
        guard trimmed(title) == nil else { return nil }
        guard let colon = id.firstIndex(of: ":") else { return Formatters.middleEllipsis(id) }
        return String(id[...colon]) + Formatters.middleEllipsis(String(id[id.index(after: colon)...]))
    }

    /// The run's name on one line: "Port tests to vitest", or "Untitled · cx:0190a0…0001".
    static func runLabel(title: String?, id: String) -> String {
        ([runName(title: title)] + [runID(title: title, id: id)].compactMap { $0 }).joined(separator: " · ")
    }

    /// The run's tooltip: the full title when there is one, then the full id (§3.5), which a click copies.
    static func runHelp(title: String?, id: String) -> String {
        (trimmed(title).map { $0 + "\n" } ?? "") + id
    }

    // MARK: Helpers

    /// The title without its surrounding white space; nil when nothing is left.
    private static func trimmed(_ title: String?) -> String? {
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? nil : t
    }

    /// An engine key as words: "outcome-differs" → "outcome differs".
    private static func words(_ key: String) -> String {
        key.replacingOccurrences(of: "-", with: " ")
    }

    /// A capitalized sentence with its final period.
    private static func sentence(_ text: String) -> String {
        let t = text.prefix(1).uppercased() + text.dropFirst()
        return t.hasSuffix(".") ? t : t + "."
    }

    /// "1st", "2nd", "3rd", "11th", "22nd".
    private static func ordinal(_ n: Int) -> String {
        let suffix = (11...13).contains(n % 100) ? "th" : [1: "st", 2: "nd", 3: "rd"][n % 10] ?? "th"
        return Formatters.count(n) + suffix
    }

    /// `text` gets the delta's magnitude and its direction word.
    private static func difference(_ delta: Int64?, less: String, more: String, text: (UInt64, String) -> String) -> Difference {
        guard let delta else { return Difference(symbol: nil, text: Formatters.missing, help: notDetermined) }
        if delta == 0 { return Difference(symbol: nil, text: "Same") }
        return Difference(symbol: delta < 0 ? "arrow.down" : "arrow.up", text: text(delta.magnitude, delta < 0 ? less : more))
    }
}
