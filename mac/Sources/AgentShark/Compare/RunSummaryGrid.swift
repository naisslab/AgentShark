import AppKit
import SwiftUI

/// The Runs grid (ANALYSIS-UX §5.6): one row per metric, run A and run B side by side, and the difference of B against
/// A in words. The disclosure folds it to one line that still names both runs and their headline figures; each window
/// keeps its own state (`CompareModel.runsOpen`). Caution lines follow when the titles or agents differ, then the
/// Behavior disclosure (§5.7).
struct RunSummaryGrid: View {
    let model: WindowModel
    let result: DiffResult
    @Bindable var compare: CompareModel
    /// Whether the grid is open before anyone opens or folds it in this window (`opensByDefault`).
    let openByDefault: Bool
    /// The width to lay out in, the overview's, which the pane gives. Never measured from the grid itself: once its
    /// cells had laid out at a width, the grid could not narrow below it, and it widened the pane past the inspector.
    let width: CGFloat

    private var open: Bool { compare.runsOpen ?? openByDefault }

    /// A window 800 pt tall or shorter starts with the grid folded, so the alignment table keeps its rows (DESIGN.md §2,
    /// §8.7); a window whose height is not known yet starts with it open.
    static func opensByDefault(windowHeight: CGFloat?) -> Bool {
        (windowHeight ?? .infinity) > 800
    }

    private var density: Preferences.RowDensity { model.app.preferences.rowDensity }
    private var runA: CompareRun { CompareRun(id: result.left.session, result: result, catalog: model.sessionsByID) }
    private var runB: CompareRun { CompareRun(id: result.right.session, result: result, catalog: model.sessionsByID) }

    /// The label column, and the A and B columns: equal, at most 320 pt, so the difference stays near the values it
    /// compares on a wide window, and narrower where the pane is, down to 140 pt, so the widest difference fits whole.
    static let labelWidth: CGFloat = 104
    static let spacing: CGFloat = 16
    private var column: CGFloat {
        max(140, min(320, (width - Self.labelWidth - Self.differenceRoom(result.delta, density: density) - 3 * Self.spacing) / 2))
    }
    /// The columns are too narrow for every value in full.
    private var narrow: Bool { column < 190 }

    /// The differences in grid order, but for the tokens' (`TokenDifference`).
    static func differences(_ d: DiffResult.MetricsDelta) -> [AnalysisVocabulary.Difference] {
        [AnalysisVocabulary.durationDifference(d.wallUs), AnalysisVocabulary.countDifference(d.actions, "action"),
         AnalysisVocabulary.countDifference(d.steps, "step"), AnalysisVocabulary.countDifference(d.failedActions, "failed action"),
         AnalysisVocabulary.countDifference(d.edits, "edit"), AnalysisVocabulary.countDifference(d.sessions, "session")]
    }

    /// The room the widest difference takes ("↓ 2.11M fewer in · ↑ 760 more out"), between 160 and 300 pt.
    static func differenceRoom(_ d: DiffResult.MetricsDelta, density: Preferences.RowDensity) -> CGFloat {
        let font = Theme.font(.rowPrimary, density)
        // The direction symbol and its 4 pt gap, as `DifferenceView` draws them.
        let symbol = font.pointSize + 4
        func width(_ d: AnalysisVocabulary.Difference) -> CGFloat {
            ceil((d.text as NSString).size(withAttributes: [.font: font]).width) + (d.symbol == nil ? 0 : symbol)
        }
        let tokens = TokenDifference.parts(d)
        let dot = ceil(("·" as NSString).size(withAttributes: [.font: font]).width) + 8
        let widths = differences(d).map(width) + [tokens.map(width).reduce(0, +) + CGFloat(tokens.count - 1) * dot]
        return min(300, max(160, (widths.max() ?? 0) + 2))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if open {
                grid
                cautions
            } else {
                FoldedRunsLine(result: result, runA: runA, runB: runB, density: density) { compare.runsOpen = true }
            }
            BehaviorDisclosure(model: model, result: result, open: $compare.behaviorOpen, labelWidth: Self.labelWidth, column: column,
                               spacing: Self.spacing)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Grid

    private var grid: some View {
        let a = result.left.metrics, b = result.right.metrics, d = result.delta
        return VStack(alignment: .leading, spacing: 1) {
            row {
                disclosure
            } a: {
                runCell("A", runA)
            } b: {
                runCell("B", runB)
            } difference: {
                Text("Difference (B vs A)").font(Theme.fontSwiftUI(.rowSecondary, density)).foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help("Run B against run A, from the engine's differences")
            }
            .padding(.bottom, 3)
            // The engine reads only the top-level session when subagents are excluded, so the span shrinks with it.
            metric("Wall time", Formatters.duration(a.wallUs, src: nil), Formatters.duration(b.wallUs, src: nil),
                   AnalysisVocabulary.durationDifference(d.wallUs),
                   help: "From the run's first to its last logged event, " + (model.compare.subagents ? "subagents included" : "its top-level session only"))
            actionsRow
            metric("Steps", Formatters.count(a.steps, "step"), Formatters.count(b.steps, "step"), AnalysisVocabulary.countDifference(d.steps, "step"),
                   help: Self.stepsHelp(subagents: model.compare.subagents))
            metric("Failed actions", "\(Formatters.count(a.failedActions)) failed", "\(Formatters.count(b.failedActions)) failed",
                   AnalysisVocabulary.countDifference(d.failedActions, "failed action"), help: Self.failedHelp(subagents: model.compare.subagents))
            metric("Edits", edits(a), edits(b), AnalysisVocabulary.countDifference(d.edits, "edit"))
            tokensRow(a, b, d)
            metric("Sessions", Formatters.count(a.sessions, "session"), Formatters.count(b.sessions, "session"),
                   AnalysisVocabulary.countDifference(d.sessions, "session"),
                   help: model.compare.subagents ? "Each run's top-level session and its subagents" : "Subagents are excluded, so each run is its top-level session")
        }
    }

    /// One grid row: the label, A and B in their equal columns, then the difference, which takes the rest of the width
    /// and cuts at its tail in a narrow pane, so a row never runs past the pane. No trailing spacer: its gap would come
    /// out of the difference's room.
    private func row<L: View, A: View, B: View, D: View>(@ViewBuilder label: () -> L, @ViewBuilder a: () -> A, @ViewBuilder b: () -> B,
                                                         @ViewBuilder difference: () -> D) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Self.spacing) {
            label().frame(width: Self.labelWidth, alignment: .leading)
            a().frame(width: column, alignment: .leading)
            b().frame(width: column, alignment: .leading)
            difference()
        }
    }

    private var disclosure: some View {
        RunsDisclosure(open: true, density: density) { compare.runsOpen = false }
    }

    private func label(_ text: String) -> some View {
        Text(text).font(Theme.fontSwiftUI(.rowSecondary, density)).foregroundStyle(.secondary).lineLimit(1)
    }

    /// The run's title (a click copies its id), its column's letter hanging in the gutter before it so the title lines
    /// up with the values under it, then "Oct 21 14:02 · ● Codex"; the Sessions row holds the session count.
    private func runCell(_ letter: String, _ run: CompareRun) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Button {
                AppKitHelpers.copy(run.id)
            } label: {
                Text(run.name)
                    .font(Theme.fontSwiftUI(.paneTitle, density))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .buttonStyle(.plain)
            .help(run.help + "\nClick to copy the run's ID.")
            .contextMenu {
                Button("Show Run in Steps") { model.openSession(run.id, mode: .steps) }
                Button("Copy Run ID") { AppKitHelpers.copy(run.id) }
            }
            .overlay(alignment: .leading) {
                Text(letter)
                    .font(Theme.fontSwiftUI(.paneTitle, density))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .alignmentGuide(.leading) { $0[.trailing] + 6 }
                    .help("Run \(letter)" + (letter == "A" ? ", the run that started first unless swapped" : ""))
            }
            RunDetailLine(detail: run.detail)
                .font(Theme.fontSwiftUI(.rowSecondary, density))
                .foregroundStyle(.secondary)
                .help(narrow ? run.detail.text : "")
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Run \(letter), " + run.name + ", " + run.detail.text)
    }

    // One word, one count (DESIGN.md §1.7): a row says how far its count reaches where another view counts nearby.

    /// The run report's step count of the same sessions; the Steps header gives the top-level session's alone.
    static func stepsHelp(subagents: Bool) -> String {
        "Steps of the run, as the Steps run report counts them: " + (subagents ? "its subagents' steps included" : "its top-level session only")
    }

    /// Failed actions are not the inspector's Errors, which counts events flagged as errors in one session.
    static func failedHelp(subagents: Bool) -> String {
        "Tool actions that failed, " + (subagents ? "in every session of the run" : "in its top-level session")
            + ". A different count from the inspector's Errors, which counts events flagged as errors in one session."
    }

    /// The inspector's Tokens are one session's; this row sums the run's sessions.
    static func tokensHelp(subagents: Bool) -> String {
        "Input and output tokens, " + (subagents ? "summed over the run's sessions, its subagents included" : "of the run's top-level session only")
            + ". The inspector's Tokens are one session's."
    }

    /// "incl. subagents" after a run's tokens when they sum more than its top-level session, so the figure is not read
    /// as the inspector's, which counts that session alone.
    static func tokensQualifier(_ m: DiffResult.RunMetrics, subagents: Bool) -> String? {
        subagents && m.sessions > 1 ? "incl. subagents" : nil
    }

    private func metric(_ name: String, _ a: String, _ b: String, _ difference: AnalysisVocabulary.Difference, help: String? = nil) -> some View {
        row {
            label(name).help(help ?? "")
        } a: {
            value(a)
        } b: {
            value(b)
        } difference: {
            DifferenceView(difference: difference, density: density, cut: narrow)
        }
        .accessibilityElement(children: .combine)
    }

    /// A value, then its `qualifier` in secondary type ("incl. subagents"), which the tail cut reaches first.
    private func value(_ text: String, qualifier: String? = nil, help: String? = nil) -> some View {
        let tail = qualifier.map { " " + $0 } ?? ""
        return (Text(text).foregroundStyle(text == Formatters.missing ? .secondary : .primary) + Text(tail).foregroundStyle(.secondary))
            .font(Theme.fontSwiftUI(.rowPrimary, density))
            .lineLimit(1)
            // A narrow column (the inspector open) can cut a value; its tooltip then holds it whole (DESIGN.md §3.5).
            .help(help ?? (text == Formatters.missing ? AnalysisVocabulary.notDetermined : narrow ? text + tail : ""))
    }

    private func tokensRow(_ a: DiffResult.RunMetrics, _ b: DiffResult.RunMetrics, _ d: DiffResult.MetricsDelta) -> some View {
        func tokens(_ m: DiffResult.RunMetrics) -> String? {
            guard m.tokensIn != nil || m.tokensOut != nil else { return nil }
            return "\(Formatters.tokens(m.tokensIn.map { Int(clamping: $0) })) in · \(Formatters.tokens(m.tokensOut.map { Int(clamping: $0) })) out"
        }
        let notLogged = "Not logged for this agent."
        let subagents = model.compare.subagents
        return row {
            label("Tokens").help(Self.tokensHelp(subagents: subagents))
        } a: {
            value(tokens(a) ?? Formatters.missing, qualifier: tokens(a) == nil ? nil : Self.tokensQualifier(a, subagents: subagents),
                  help: tokens(a) == nil ? notLogged : nil)
        } b: {
            value(tokens(b) ?? Formatters.missing, qualifier: tokens(b) == nil ? nil : Self.tokensQualifier(b, subagents: subagents),
                  help: tokens(b) == nil ? notLogged : nil)
        } difference: {
            TokenDifference(delta: d, density: density, cut: narrow)
        }
        .accessibilityElement(children: .combine)
    }

    /// Each run's actions and how many of them the alignment table places in its rows, paired or not; the tooltip says
    /// how many pair with the other run and why the rest are not there.
    private var actionsRow: some View {
        let limit = model.compare.limit ?? 1500
        func cell(_ side: CompareSide) -> some View {
            let m = result.run(side).metrics
            let help = [Self.actions(m, short: false), Self.actionsHelp(result, side: side, limit: limit, subagents: model.compare.subagents)]
                .filter { !$0.isEmpty }.joined(separator: "\n")
            // The longer words where the column holds them, never a cut value (DESIGN.md §3.5).
            return ViewThatFits(in: .horizontal) {
                value(Self.actions(m, short: false), help: help)
                value(Self.actions(m, short: true), help: help)
            }
        }
        return row {
            label("Actions").help("Waits are not aligned. Limit: \(Formatters.count(limit)) actions per run.")
        } a: {
            cell(.a)
        } b: {
            cell(.b)
        } difference: {
            DifferenceView(difference: AnalysisVocabulary.countDifference(result.delta.actions, "action"), density: density, cut: narrow)
        }
        .accessibilityElement(children: .combine)
    }

    /// "40 actions · 39 in the alignment", or `short` "40 actions · 39 in the table": "aligned" alone read as paired with
    /// the other run. An engine before 1.1 sends no aligned count.
    static func actions(_ m: DiffResult.RunMetrics, short: Bool) -> String {
        let all = Formatters.count(m.actions, "action")
        guard let aligned = m.alignedActions else { return all }
        return all + " · \(Formatters.count(aligned)) in the " + (short ? "table" : "alignment")
    }

    /// What "in the alignment" counts: "39 placed in the table, paired or not: 16 paired with run B, 23 only in run A. 1
    /// wait is not aligned.", then the actions the action limit left out, and that subagents' actions are not counted
    /// when they are excluded.
    static func actionsHelp(_ result: DiffResult, side: CompareSide, limit: Int, subagents: Bool) -> String {
        let m = result.run(side).metrics, s = result.summary
        var parts: [String] = []
        if let aligned = m.alignedActions {
            let paired = s.same + s.outcomeDiffers + s.objectDiffers
            parts.append("\(Formatters.count(aligned)) placed in the table, paired or not: \(Formatters.count(paired)) paired with run "
                         + "\(side.other.letter), \(Formatters.count(side == .a ? s.leftOnly : s.rightOnly)) only in run \(side.letter).")
            let waits = m.actions - aligned
            if waits > 0 { parts.append(waits == 1 ? "1 wait is not aligned." : "\(Formatters.count(waits)) waits are not aligned.") }
            if let alignable = m.alignableActions, alignable > aligned {
                parts.append("The limit of \(Formatters.count(limit)) actions per run left out \(Formatters.count(alignable - aligned, "more action")).")
            }
        }
        if !subagents { parts.append("Subagents are excluded, so their actions are not counted.") }
        return parts.joined(separator: " ")
    }

    private func edits(_ m: DiffResult.RunMetrics) -> String {
        "\(Formatters.count(m.edits, "edit")) in \(Formatters.count(m.filesEdited, "file"))"
    }

    // MARK: Cautions

    private var cautionList: [RunCaution] { RunCaution.list(runA, runB) }

    /// The cautions span the grid from its label column, ⚠ in that column: they are about the pair, not about run A.
    @ViewBuilder private var cautions: some View {
        let list = cautionList
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(list, id: \.sentence) { caution($0.sentence) }
            }
        }
    }

    private func caution(_ text: String) -> some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warn.swiftUI)
        }
        .font(Theme.fontSwiftUI(.rowSecondary, density))
        .foregroundStyle(.secondary)
    }
}

/// The Runs disclosure: "▾ Runs" heading the open grid, "▸ Runs" leading its folded line.
struct RunsDisclosure: View {
    let open: Bool
    let density: Preferences.RowDensity
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 4) {
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 12)
                // Never wraps: a narrow folded line once broke it into "R / un / s".
                Text("Runs").font(Theme.fontSwiftUI(.groupHeader, density)).fixedSize()
            }
        }
        .buttonStyle(.plain)
        .help(open ? "Fold the runs to one line" : "Show the runs side by side")
        .accessibilityLabel(open ? "Runs, expanded" : "Runs, collapsed")
    }
}

/// A §5.6 caution: the folded line's words and the open grid's sentence.
struct RunCaution: Hashable, Sendable {
    /// What differs, "titles", which the folded line's words name.
    var noun: String
    var sentence: String

    /// "different titles"
    var short: String { "different " + noun }

    /// The cautions that apply to runs A and B: their titles differ, or their agents do.
    static func list(_ a: CompareRun, _ b: CompareRun) -> [RunCaution] {
        var list: [RunCaution] = []
        if RunRanking.normalizedTitle(a.title) != RunRanking.normalizedTitle(b.title) {
            list.append(RunCaution(noun: "titles", sentence: "Different titles: the alignment assumes both runs attempt the same task."))
        }
        if let x = a.agent, let y = b.agent, x != y {
            list.append(RunCaution(noun: "agents", sentence: "Different agents: the same action name may not do the same thing."))
        }
        return list
    }

    /// The folded line's words after ⚠: "different titles · different agents", or `compact`, "different titles, agents".
    static func words(_ list: [RunCaution], compact: Bool) -> String {
        compact ? "different " + list.map(\.noun).joined(separator: ", ") : list.map(\.short).joined(separator: " · ")
    }
}

/// The Runs grid folded to one line (§5.6): "▸ Runs · A Port tests to vitest vs B Fix the login test · 30m 30s vs 18m
/// 04s · 996 vs 778 actions · ⚠ different titles · different agents". Whether the alignment applies is never behind a
/// disclosure (DESIGN.md §2), so the cautions stay, and ⚠ always keeps its words (DESIGN.md §5.3): where the line does
/// not fit, the action counts go, then the cautions' words shorten to "⚠ different titles, agents", then the wall times
/// go; the names cut last, each keeping 96 pt. The tooltip holds the cautions' sentences. Runs with the same title carry
/// their start, "A Run title 1 · Mar 24 00:25 vs B Run title 1 · Mar 24 03:25", so the sides stay apart.
struct FoldedRunsLine: View {
    enum Form: CaseIterable { case full, wallTime, compactCautions, names }

    let result: DiffResult
    let runA: CompareRun
    let runB: CompareRun
    let density: Preferences.RowDensity
    /// One form, as `LayoutFitTests` measures them; nil shows the first that fits.
    var form: Form? = nil
    /// The disclosure's action: open the grid.
    let unfold: () -> Void

    /// The narrowest a run's name cuts to, unless the name is shorter.
    static let nameFloor: CGFloat = 96

    private var cautions: [RunCaution] { RunCaution.list(runA, runB) }

    var body: some View {
        Group {
            if let form {
                line(form)
            } else {
                ViewThatFits(in: .horizontal) {
                    line(.full)
                    line(.wallTime)
                    line(.compactCautions)
                    line(.names)
                }
            }
        }
        .font(Theme.fontSwiftUI(.rowPrimary, density))
    }

    private func line(_ form: Form) -> some View {
        let a = result.left.metrics, b = result.right.metrics
        let apart = CompareRun.apart(runA, runB)
        // A word space between the parts, so the figures fit beside the inspector at 1280 pt.
        return HStack(alignment: .firstTextBaseline, spacing: 4) {
            RunsDisclosure(open: false, density: density, toggle: unfold)
            dot
            name("A", runA, apart?.a).layoutPriority(1)
            Text("vs").foregroundStyle(.secondary).fixedSize()
            name("B", runB, apart?.b).layoutPriority(1)
            if form != .names {
                dot
                Text("\(Formatters.duration(a.wallUs, src: nil)) vs \(Formatters.duration(b.wallUs, src: nil))"
                     + (form == .full ? " · \(Formatters.count(a.actions)) vs \(Formatters.count(b.actions, "action"))" : ""))
                    // In the cautions' size: what follows the names is their metadata (DESIGN.md §4.3).
                    .font(Theme.fontSwiftUI(.rowSecondary, density))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .help("Wall time" + (form == .full ? " and actions" : "") + " of run A, then run B")
            }
            if !cautions.isEmpty {
                dot
                caution(compact: form == .compactCautions || form == .names)
            }
        }
        .lineLimit(1)
    }

    private var dot: some View {
        Text("·").foregroundStyle(.tertiary).fixedSize()
    }

    /// "A Run the tests": the side's letter in the secondary style the grid's letters use, then the title, which cuts at
    /// its tail; the start that tells same-titled runs apart never cuts. The tooltip holds the full title and id.
    private func name(_ letter: String, _ run: CompareRun, _ start: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(letter).foregroundStyle(.secondary).fixedSize()
            FloorWidth(floor: Self.nameFloor) {
                Text(run.name).truncationMode(.tail)
            }
            if let start { Text("· " + start).foregroundStyle(.secondary).fixedSize() }
        }
        .help("Run \(letter): " + run.help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Run \(letter), " + run.name + (start.map { ", " + $0 } ?? ""))
    }

    /// ⚠ and the cautions' words, never ⚠ alone; the tooltip and the accessibility label hold their sentences.
    private func caution(compact: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warn.swiftUI)
            Text(RunCaution.words(cautions, compact: compact))
        }
        .font(Theme.fontSwiftUI(.rowSecondary, density))
        .foregroundStyle(.secondary)
        .fixedSize()
        .help(cautions.map(\.sentence).joined(separator: "\n"))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(cautions.map(\.sentence).joined(separator: " "))
    }
}

/// One view at its ideal width when the proposal allows it, else cut to the proposal, but never below `floor` or its
/// ideal width, whichever is less: a short name keeps its own width, a long one keeps `floor`.
private struct FloorWidth: Layout {
    let floor: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        let ideal = view.sizeThatFits(.unspecified)
        let width = max(min(floor, ideal.width), min(ideal.width, proposal.width ?? ideal.width))
        return view.sizeThatFits(ProposedViewSize(width: width, height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }

    /// The view's own baselines, so the line's first-text-baseline alignment holds.
    func explicitAlignment(of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews,
                           cache: inout ()) -> CGFloat? {
        subviews.first.map { bounds.minY + $0.dimensions(in: ProposedViewSize(width: bounds.width, height: bounds.height))[guide] }
    }
}

/// A run's metadata line, "Oct 11 17:28 · 11m 30s · ● Codex · repo": the agent's dot right before its name (DESIGN.md
/// §5.2), and what follows the agent goes first: whole, or not at all rather than cut to "· …".
struct RunDetailLine: View {
    let detail: RunDetail

    var body: some View {
        if let agent = detail.agent {
            ViewThatFits(in: .horizontal) {
                line(agent, trail: true)
                line(agent, trail: false)
            }
        } else {
            HStack(spacing: 4) {
                lead(detail.trail.isEmpty ? "" : " · " + detail.trail.joined(separator: " · "))
            }
            .lineLimit(1)
        }
    }

    private func line(_ agent: AgentKind, trail: Bool) -> some View {
        HStack(spacing: 4) {
            if !detail.lead.isEmpty { lead(" ·").layoutPriority(1) }
            AgentName(agent: agent).layoutPriority(1)
            if trail, !detail.trail.isEmpty { Text("· " + detail.trail.joined(separator: " · ")) }
        }
        .lineLimit(1)
    }

    /// The lead, then `tail`: an untitled run's short id first, in monospace (DESIGN.md §3.2) at the line's size, a click
    /// copying the full id its tooltip shows; the rest in the UI font, cut at its tail.
    @ViewBuilder private func lead(_ tail: String) -> some View {
        let rest = (detail.id == nil ? detail.lead : Array(detail.lead.dropFirst())).joined(separator: " · ")
        if let id = detail.id, let short = detail.lead.first {
            Text(short)
                .monospaced()
                .fixedSize()
                .help(id + "\nClick to copy the run's ID.")
                .onTapGesture { AppKitHelpers.copy(id) }
                .accessibilityAddTraits(.isButton)
        }
        let text = (detail.id == nil || rest.isEmpty ? rest : "· " + rest) + tail
        if !text.isEmpty { Text(text).truncationMode(.tail) }
    }
}

/// A difference in words after its direction symbol, never by sign or color alone (DESIGN.md §7.8): "↓ 12m 26s shorter",
/// "Same", or "—" with its reason. The words cut at their tail in a narrow pane, and `cut` then puts them whole in the
/// tooltip (DESIGN.md §3.5).
struct DifferenceView: View {
    let difference: AnalysisVocabulary.Difference
    let density: Preferences.RowDensity
    var cut = false

    var body: some View {
        HStack(spacing: 4) {
            if let symbol = difference.symbol {
                Image(systemName: symbol)
                    .font(.system(size: Theme.TypeRole.rowPrimary.size + density.sizeBump - 2, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            Text(difference.text)
                .foregroundStyle(difference.symbol == nil ? .secondary : .primary)
                .truncationMode(.tail)
        }
        .font(Theme.fontSwiftUI(.rowPrimary, density))
        .lineLimit(1)
        .help([cut ? difference.text : nil, difference.help].compactMap { $0 }.joined(separator: "\n"))
        .accessibilityElement(children: .combine)
    }
}

/// The tokens' difference: "↓ 2.11M fewer in · ↑ 800 more out", or one "Same" or "—" when both directions read alike.
struct TokenDifference: View {
    let delta: DiffResult.MetricsDelta
    let density: Preferences.RowDensity
    var cut = false

    static func parts(_ d: DiffResult.MetricsDelta) -> [AnalysisVocabulary.Difference] {
        let into = AnalysisVocabulary.tokenDifference(d.tokensIn, "in"), out = AnalysisVocabulary.tokenDifference(d.tokensOut, "out")
        return out == into ? [into] : [into, out]
    }

    var body: some View {
        let parts = Self.parts(delta)
        HStack(spacing: 4) {
            DifferenceView(difference: parts[0], density: density, cut: cut)
            if parts.count > 1 {
                Text("·").font(Theme.fontSwiftUI(.rowPrimary, density)).foregroundStyle(.tertiary)
                DifferenceView(difference: parts[1], density: density, cut: cut)
            }
        }
    }
}

// MARK: - Behavior

/// The Behavior disclosure (ANALYSIS-UX §5.7): the two runs' rework and their responses to failure as mirrored bars on
/// the Runs grid's columns, A's growing left from the boundary between the A and B columns and B's growing right from
/// it, each row scaled to its larger count. The four counts with evidence open a list of their events.
struct BehaviorDisclosure: View {
    let model: WindowModel
    let result: DiffResult
    @Binding var open: Bool
    /// The Runs grid's label and A/B column widths and its spacing, so the bars sit under the runs they count.
    let labelWidth: CGFloat
    let column: CGFloat
    let spacing: CGFloat

    private var density: Preferences.RowDensity { model.app.preferences.rowDensity }

    /// The failure-response@1 classes in words, in §5.7 order.
    static func responseName(_ r: FailureResponse) -> String {
        switch r.rawValue {
        case "retry-same": return "Retried unchanged"
        case "retry-modified": return "Retried modified"
        case "edit": return "Edited"
        case "inspect": return "Inspected"
        case "delegate": return "Delegated"
        case "stop": return "Stopped"
        case "other": return "Other"
        default: return r.rawValue.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 12)
                    Text("Behavior").font(Theme.fontSwiftUI(.groupHeader, density))
                    Text("rereads, reverts, retries, fix loops, responses to failure")
                        .font(Theme.fontSwiftUI(.rowSecondary, density))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .buttonStyle(.plain)
            .help(open ? "Hide the behavior counts" : "Show how each run reread, reverted and retried, and what it did after a failure")
            .accessibilityLabel(open ? "Behavior, expanded" : "Behavior, collapsed")
            if open { bars }
        }
    }

    private var bars: some View {
        let a = result.left.profile, b = result.right.profile
        return VStack(alignment: .leading, spacing: 1) {
            finding("Rereads", a.rereads, b.rereads, rule: "reread@1")
            finding("Reverts", a.reverts, b.reverts, rule: "revert@1")
            finding("Blind retries", a.blindRetries, b.blindRetries, rule: "blind-retry@2")
            finding("Repeated searches", a.repeatedSearches, b.repeatedSearches, rule: "repeat-search@1")
            row("Fix loops", a.fixLoops, b.fixLoops, aView: loops(a), bView: loops(b))
            Text("After a failure")
                .font(Theme.fontSwiftUI(.rowSecondary, density).weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 5)
                .padding(.bottom, 1)
            ForEach(FailureResponse.known, id: \.self) { r in
                let x = a.failureResponses[r] ?? 0, y = b.failureResponses[r] ?? 0
                row(Self.responseName(r), x, y, aView: Text(Formatters.count(x)), bView: Text(Formatters.count(y)))
                    .help("What the session did right after a failed action (rule failure-response@1). " + AnalysisVocabulary.precisionNotChecked)
            }
            Text("Responses to failure are counts only; the engine returns no evidence for them.")
                .font(Theme.fontSwiftUI(.metadata, density))
                .foregroundStyle(.secondary)
                .padding(.leading, labelWidth + spacing)
                .padding(.top, 3)
        }
    }

    /// The longest bar: what the A or B column holds beside the widest value ("10 loops, 10 resolved").
    private var barMax: CGFloat { max(24, min(140, column - 150)) }

    private func finding(_ name: String, _ a: DiffResult.ProfileFinding, _ b: DiffResult.ProfileFinding, rule: String) -> some View {
        row(name, a.count, b.count,
            aView: EvidenceCount(model: model, name: name, side: .a, finding: a, rule: rule, density: density),
            bView: EvidenceCount(model: model, name: name, side: .b, finding: b, rule: rule, density: density))
    }

    /// One row: the label, then A's value and bar right-aligned in the A column, B's bar and value left-aligned in the B
    /// column.
    private func row<A: View, B: View>(_ label: String, _ a: Int, _ b: Int, aView: A, bView: B) -> some View {
        let top = max(a, b, 1)
        return HStack(alignment: .center, spacing: spacing) {
            Text(label)
                .font(Theme.fontSwiftUI(.rowSecondary, density))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: labelWidth, alignment: .leading)
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                aView.lineLimit(1)
                bar(a, of: top)
            }
            .frame(width: column)
            HStack(spacing: 8) {
                bar(b, of: top)
                bView.lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(width: column)
            Spacer(minLength: 0)
        }
        .font(Theme.fontSwiftUI(.rowPrimary, density))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(label): A \(Formatters.count(a)), B \(Formatters.count(b))")
    }

    /// A's bars end where B's begin, so each pair reads as one mirrored row.
    private func bar(_ n: Int, of top: Int) -> some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(Color(nsColor: .secondaryLabelColor).opacity(0.55))
            .frame(width: max(n > 0 ? 2 : 0, barMax * CGFloat(n) / CGFloat(top)), height: 8)
            .help("Scaled to the row's larger count, \(Formatters.count(top))")
            .accessibilityHidden(true)
    }

    /// "4 loops, 3 resolved", with the cycles in the tooltip; a narrow column reads "4 loops" and the tooltip says how many
    /// were resolved.
    private func loops(_ p: DiffResult.BehaviorProfile) -> some View {
        let resolved = "\(Formatters.count(p.fixLoopsResolved)) resolved"
        let narrow = column < 190
        return Text(Formatters.count(p.fixLoops, "loop") + (narrow ? "" : ", " + resolved))
            .help((narrow ? Formatters.count(p.fixLoops, "loop") + ", " + resolved + ". " : "")
                  + "\(Formatters.count(p.fixLoopCycles, "cycle")) in \(Formatters.count(p.fixLoops, "loop")) (rule fix-loop@1). A loop is resolved when it ends on a passing run.")
    }
}

/// A rework count with its evidence: a click lists up to 50 of its findings, each with Show.
private struct EvidenceCount: View {
    let model: WindowModel
    let name: String
    let side: CompareSide
    let finding: DiffResult.ProfileFinding
    let rule: String
    let density: Preferences.RowDensity
    @State private var shown = false

    var body: some View {
        if finding.evidence.isEmpty {
            Text(Formatters.count(finding.count))
                .help(finding.count == 0 ? "None in run \(side.letter)" : "The engine returned no evidence for these")
        } else {
            Button(Formatters.count(finding.count)) { shown = true }
                .buttonStyle(.link)
                .help("Show the \(name.lowercased()) of run \(side.letter) (rule \(rule)). " + AnalysisVocabulary.precisionNotChecked)
                .popover(isPresented: $shown, arrowEdge: .bottom) { list }
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(name) in run \(side.letter)")
                .font(Theme.fontSwiftUI(.paneTitle, density))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            Text(finding.count > finding.evidence.count
                 ? "The first \(Formatters.count(finding.evidence.count)) of \(Formatters.count(finding.count)), from rule \(rule). \(AnalysisVocabulary.precisionNotChecked)"
                 : "From rule \(rule). \(AnalysisVocabulary.precisionNotChecked)")
                .font(Theme.fontSwiftUI(.metadata, density))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(finding.evidence.prefix(50).enumerated()), id: \.offset) { _, e in
                        row(e)
                        Divider()
                    }
                }
            }
            .scrollShadows()
            .frame(maxHeight: 320)
        }
        .frame(width: 420)
    }

    private func row(_ e: DiffResult.ProfileEvidence) -> some View {
        HStack(spacing: 8) {
            Text((e.detail ?? "Event") + AnalysisVocabulary.confidenceMark(e.confidence))
                .font(Theme.fontSwiftUI(.code, density))
                .lineLimit(1)
                .truncationMode(.middle)
                .help(AnalysisVocabulary.confidenceHelp(e.confidence, "one of run \(side.letter)'s \(name.lowercased())", rule: rule))
            Spacer(minLength: 8)
            if let event = e.evidence.first {
                Button("Show") {
                    shown = false
                    model.select(event: event.eventId, reveal: NSEvent.modifierFlags.contains(.command))
                    if !NSEvent.modifierFlags.contains(.command) { model.showDerivedInspector = true }
                }
                .controlSize(.small)
                .help("Show this event in the inspector; ⌘-click shows it in Events")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: Theme.metrics(density).tableRow)
    }
}
