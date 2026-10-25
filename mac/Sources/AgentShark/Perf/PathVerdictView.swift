import AppKit
import SwiftUI

// The upper part of Session · Critical Path (ANALYSIS-UX §4.4–§4.7): the evidence line, the notices, the verdict and the
// class breakdown.

/// Critical Path's evidence line (§4.4), the shared `EvidenceLine`: the gaps, "This event is not on the critical path."
/// when an event selected elsewhere is on no segment (§4.10), then what the analysis read. A click opens every gap,
/// the three caveats and the rule.
struct PerfEvidenceLine: View {
    let content: CriticalPathContent
    /// An event selected elsewhere that no segment holds (§4.10).
    var notOnPath = false
    var metrics = Theme.Metrics(density: .compact)

    static let notOnPathText = "This event is not on the critical path."

    /// The line read as one element: every gap sentence whole, the not-on-path sentence when it shows, and the coverage.
    var spoken: String {
        ([content.gapsSpoken] + (notOnPath ? [Self.notOnPathText] : []) + [content.coverageText]).joined(separator: " ")
    }

    var body: some View {
        EvidenceLine(headline: content.gapHeadline, spoken: spoken, coverage: content.coverageText,
                     notice: notOnPath ? Self.notOnPathText : nil,
                     help: "Show every data gap, the analysis's caveats and its rule", hint: "Shows every data gap, the caveats and the rule",
                     metrics: metrics) {
            EvidencePopover(gaps: content.gaps.map { EvidencePopover.Gap(code: $0.code, text: $0.text) }, caveats: content.result.caveats,
                            notes: [.init(text: AnalysisVocabulary.ruleLine(content.path.bindingSrc.rawValue)),
                                    .init(text: "Whole run: the filter and time range do not apply. Subagents are always included.")])
        }
    }
}

/// A one-line notice above the analysis: the partial window (§4.5) and the stale bar (§4.1) in the warn style of the
/// app's inline banners, the stale bar with Refresh. While the Refresh runs, the bar keeps its slot and its height with
/// a spinner and secondary text on the evidence line's neutral surface: following the path again is progress, not a
/// warning, and severity colour is for severity (DESIGN.md §5.2).
struct PerfNotice: View {
    let symbol: String
    let text: String
    var action: String?
    /// The action's tooltip.
    var actionHelp: String?
    var busy = false
    var perform: () -> Void = {}

    static let buttonHeight: CGFloat = 20

    var body: some View {
        HStack(spacing: 8) {
            if busy {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: symbol).foregroundStyle(Theme.warn.swiftUI).accessibilityHidden(true)
            }
            Text(text).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(busy ? Color.secondary : Color.primary)
            Spacer(minLength: 8)
            if let action {
                Button(action, action: perform).controlSize(.small).help(actionHelp ?? "")
            }
        }
        // The stale bar's height with its button, which the busy bar keeps, so nothing below moves when Refresh starts.
        .frame(minHeight: action != nil || busy ? Self.buttonHeight : nil)
        .font(Theme.fontSwiftUI(.rowSecondary))
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(busy ? Color.secondary.opacity(0.06) : Theme.warn.swiftUI.opacity(0.1))
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .combine)
    }
}

/// The verdict (§4.6): at most two lines in the Title role, each ending in its derived mark, then the engine's advice in
/// secondary type. Every line states a share, never a cause; each mark's tooltip names the claim it marks and the rule.
struct PathVerdictView: View {
    let verdict: AnalysisVocabulary.Verdict
    let rule: String

    static let proseWidth: CGFloat = 560
    /// The widest the advice runs: about 92ch of its font, a measured line's limit (DESIGN.md §3.4).
    static let adviceLimitCh: CGFloat = 92

    /// The advice column's width: the engine's longest sentence on one line, between the 80ch prose width and about
    /// 92ch, so a sentence the pane has room for never leaves its last words on a line of their own ("the levers.≈"
    /// under a long verdict); a narrower pane wraps it within the pane.
    static func adviceWidth(_ notes: [AnalysisVocabulary.VerdictLine]) -> CGFloat {
        let font = Theme.font(.rowPrimary)
        let widest = notes.map { ceil(($0.shown as NSString).size(withAttributes: [.font: font]).width) + 2 }.max() ?? 0
        let ch = ("0" as NSString).size(withAttributes: [.font: font]).width
        return min(ceil(adviceLimitCh * ch), max(proseWidth, widest))
    }

    /// The tooltip of Title line `i`'s ≈: the largest share in a normal verdict, then the largest agent-side share; a
    /// verdict that is not established marks only its largest attributed share. A line without the mark has none.
    static func lineHelp(_ i: Int, of verdict: AnalysisVocabulary.Verdict, rule: String) -> String {
        guard verdict.lines.indices.contains(i), !verdict.lines[i].mark.isEmpty else { return "" }
        switch (verdict.form, i) {
        case (.normal, 0): return AnalysisVocabulary.verdictHelp(rule: rule)
        case (.normal, _): return AnalysisVocabulary.confidenceHelp(.derived, "the largest agent-side share of the critical path", rule: rule)
        default: return AnalysisVocabulary.confidenceHelp(.derived, "the largest attributed share of the critical path", rule: rule)
        }
    }

    /// The tooltip of the advice's ≈: the engine's fixed sentence for the class, not a reading of this run.
    static func notesHelp(_ verdict: AnalysisVocabulary.Verdict, rule: String) -> String {
        guard verdict.notes.contains(where: { !$0.mark.isEmpty }) else { return "" }
        return AnalysisVocabulary.confidenceHelp(.derived, "the engine's fixed advice for this class", rule: rule)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(verdict.lines.enumerated()), id: \.offset) { i, line in
                (Text(line.text) + Text(line.mark).foregroundStyle(.secondary))
                    .font(Theme.fontSwiftUI(.title))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .help(Self.lineHelp(i, of: verdict, rule: rule))
                    .accessibilityLabel(line.spoken)
                    .accessibilityAddTraits(i == 0 ? .isHeader : [])
            }
            if !verdict.notes.isEmpty {
                // One class's advice per line where the pane has room for each (`adviceWidth`); where it has not, one
                // paragraph, so a wrap falls mid-paragraph instead of leaving each sentence's last words on a line of
                // their own. The Title lines keep the pane's width.
                ViewThatFits(in: .horizontal) {
                    advice(separator: "\n")
                    advice(separator: " ")
                }
                .padding(.top, 3)
                .help(Self.notesHelp(verdict, rule: rule))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(verdict.notes.map(\.spoken).joined(separator: ". "))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func advice(separator: String) -> some View {
        Text(verdict.notes.map(\.shown).joined(separator: separator))
            .font(Theme.fontSwiftUI(.rowPrimary))
            .foregroundStyle(.secondary)
            .lineLimit(4)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: Self.adviceWidth(verdict.notes), alignment: .leading)
    }
}

/// The class bar and its legend (§4.7): an 8 pt bar of the path by class in the fixed class order across the pane,
/// derived time hatched, over a grid of rows that is its text equivalent: swatch, name, time and share. Each column
/// has its own header row naming the columns and the share's denominator. Clicking a row (or its part of the bar)
/// makes that class stand out on the track and narrows Contributors and Segments; clicking it again clears it.
struct PathClassBreakdown: View {
    let content: CriticalPathContent
    let selected: PathClass?
    /// Two columns of legend rows where they fit, so the legend takes half the height.
    var columns = 1
    let toggle: (PathClass) -> Void

    /// Two columns when more than three rows would split and both fit in `width`, else one.
    static func columns(_ content: CriticalPathContent, width: CGFloat) -> Int {
        content.legend.count > 3 && width >= Self.width(content, columns: 2) ? 2 : 1
    }

    private var shareTitle: String { Self.shareTitle(content) }

    private var timeWidth: CGFloat { Self.timeWidth(content) }

    /// The Time column: as wide as its longest figure with its ≈, and never under 60 pt.
    private static func timeWidth(_ content: CriticalPathContent) -> CGFloat {
        max(60, content.legend.map { width($0.time, .rowSecondary) }.max() ?? 0)
    }
    static let columnGap: CGFloat = 32

    private static func shareTitle(_ content: CriticalPathContent) -> String {
        content.path.wallUs.map(AnalysisVocabulary.shareColumnTitle) ?? "Share"
    }

    private static func width(_ text: String, _ role: Theme.TypeRole) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: Theme.font(role)]).width) + 2
    }

    private var shareWidth: CGFloat { Self.width(shareTitle, .metadata) }

    /// A column as wide as its longest class name and its share header, so the breakdown never cuts a word.
    static func columnWidth(_ content: CriticalPathContent) -> CGFloat {
        let names = content.legend.map { width($0.name, .rowSecondary) }.max() ?? 0
        return 16 + max(names, width("Class", .metadata)) + 4 + 8 + timeWidth(content) + 8 + width(shareTitle(content), .metadata)
    }

    /// The breakdown's width in `columns` columns.
    static func width(_ content: CriticalPathContent, columns: Int) -> CGFloat {
        CGFloat(columns) * columnWidth(content) + CGFloat(columns - 1) * columnGap
    }

    /// The legend rows by column, top to bottom, then left to right.
    private var chunks: [[AnalysisVocabulary.LegendRow]] {
        let rows = content.legend
        let size = max(1, (rows.count + columns - 1) / max(1, columns))
        return stride(from: 0, to: rows.count, by: size).map { Array(rows[$0..<min($0 + size, rows.count)]) }
    }

    var body: some View {
        let column = Self.columnWidth(content)
        VStack(alignment: .leading, spacing: 8) {
            ClassBar(content: content, selected: selected, toggle: toggle)
                .frame(height: 8)
            HStack(alignment: .top, spacing: Self.columnGap) {
                ForEach(Array(chunks.enumerated()), id: \.offset) { _, rows in
                    VStack(alignment: .leading, spacing: 2) {
                        header
                        VStack(spacing: 0) {
                            ForEach(rows, id: \.pathClass) { row in legendRow(row) }
                        }
                    }
                    .frame(width: column)
                }
            }
            if content.isHatched { hatchKey }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The hatching's key, with a sample of it in the swatch column: the pattern is named in words and tied to the ≈
    /// that derived Time cells carry (DESIGN.md §3.3, §5.3).
    private var hatchKey: some View {
        HStack(spacing: 6) {
            Hatch().fill(Color.primary.opacity(0.35))
                .clipShape(RoundedRectangle(cornerRadius: 2))
                .frame(width: 10, height: 10)
                .accessibilityHidden(true)
            Text(CriticalPathContent.hatchKey)
        }
        .font(Theme.fontSwiftUI(.metadata))
        .foregroundStyle(.secondary)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Class").frame(maxWidth: .infinity, alignment: .leading)
            Text("Time").frame(width: timeWidth, alignment: .trailing)
            Text(shareTitle).frame(width: shareWidth, alignment: .trailing)
        }
        .font(Theme.fontSwiftUI(.metadata))
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }

    private func legendRow(_ row: AnalysisVocabulary.LegendRow) -> some View {
        let on = selected == row.pathClass
        return Button {
            toggle(row.pathClass)
        } label: {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    PathSwatch(pathClass: row.pathClass, size: 10, hatched: content.isDerived(row.pathClass))
                    Text(row.name).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(row.time).frame(width: timeWidth, alignment: .trailing)
                Text(row.share).frame(width: shareWidth, alignment: .trailing)
            }
            .font(Theme.fontSwiftUI(.rowSecondary))
            .monospacedDigit()
            .foregroundStyle(selected == nil || on ? Color.primary : Color.secondary)
            .padding(.horizontal, 4)
            .frame(height: 18)
            .background(on ? Color.accentColor.opacity(0.16) : Color.clear, in: RoundedRectangle(cornerRadius: 4))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, -4)
        .help(on ? "Show every class again" : "Highlight \(row.name) on the track and show only its contributors and segments")
        .accessibilityLabel(Self.spoken(row, in: content))
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// A legend row read aloud: "Model, 3m 46s of 30m 30s (12%), derived", and for unattributed time what it is.
    static func spoken(_ row: AnalysisVocabulary.LegendRow, in content: CriticalPathContent) -> String {
        if row.pathClass == .unattributed { return CriticalPathContent.unattributedHelp(row.part) }
        return row.name + ", " + row.part + (content.isDerived(row.pathClass) ? ", derived" : "")
    }
}

/// A class's swatch, in the legend and the tables: a sample of the class as the class bar draws it, its colour at
/// `PathMarkStyle.opacity` inside a 0.5 pt edge. The neutral classes' greys sit near the background, so their edge is
/// `separatorColor`; it stays a hairline, so a grey row never reads as an unchecked checkbox. `hatched` stripes the
/// sample: the legend stripes exactly the classes whose time carries ≈, whose part of the bar shows stripes too, so
/// the hatching key ties each striped part of the bar to its row. Unattributed time is never derived, so its swatch
/// is solid grey, as its part of the bar is.
struct PathSwatch: View {
    let pathClass: PathClass
    var size: CGFloat = 10
    var hatched = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 2)
        shape.fill(PathMarkStyle.color(pathClass).swiftUI.opacity(PathMarkStyle.opacity(pathClass)))
            .overlay { if hatched { Hatch().fill(Color.primary.opacity(0.35)).clipShape(shape) } }
            .overlay(shape.strokeBorder(PathMarkStyle.isNeutral(pathClass) ? Color(nsColor: .separatorColor) : Color.primary.opacity(0.12),
                                        lineWidth: 0.5))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The stacked bar of the path by class. Each part's derived time is hatched at its trailing end, as on the Steps time
/// bar; widths are the API's microseconds placed on the bar. Idle and unattributed time draw solid with an edge, as on
/// the track; unattributed time is never hatched, since no interval claims it.
struct ClassBar: View {
    let content: CriticalPathContent
    let selected: PathClass?
    let toggle: (PathClass) -> Void

    /// The narrowest a derived stretch draws: two of the hatching's 4 pt stripes, so a class whose time carries ≈
    /// always shows stripes on the bar, however little of it is derived (3m 46s≈ of model time with 2s derived).
    static let minHatch: CGFloat = 8

    /// The hatched width at the trailing end of a part `width` wide whose `fraction` of time is derived.
    static func hatchWidth(_ width: CGFloat, fraction: CGFloat) -> CGFloat {
        guard fraction > 0, width > 0 else { return 0 }
        return min(width, max(minHatch, width * min(1, fraction)))
    }

    var body: some View {
        let wall = Double(max(1, content.path.wallUs ?? 1))
        GeometryReader { geo in
            HStack(spacing: 0) {
                ForEach(content.legend, id: \.pathClass) { row in
                    let share = content.path.byClass[row.pathClass]
                    let width = geo.size.width * CGFloat(Double(share?.us ?? 0) / wall)
                    let derivedUs = content.derivedUs(row.pathClass)
                    let derived = share.map { $0.us > 0 ? CGFloat(Double(derivedUs) / Double($0.us)) : 0 } ?? 0
                    ZStack(alignment: .trailing) {
                        Rectangle().fill(PathMarkStyle.color(row.pathClass).swiftUI.opacity(PathMarkStyle.opacity(row.pathClass)))
                        if derived > 0 {
                            // Its stripes reach past the frame; clipped, none crosses into a neighbour's part.
                            Hatch().fill(Color.primary.opacity(0.35)).frame(width: Self.hatchWidth(width, fraction: derived)).clipped()
                        }
                        if PathMarkStyle.isNeutral(row.pathClass) {
                            Rectangle().strokeBorder(Color(nsColor: .separatorColor), lineWidth: max(0, min(1, width / 2)))
                        }
                    }
                    .frame(width: max(0, width))
                    .opacity(selected == nil || selected == row.pathClass ? 1 : 0.3)
                    .contentShape(Rectangle())
                    .onTapGesture { toggle(row.pathClass) }
                    .help(Self.help(row, derivedUs: derivedUs))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 2))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel((content.isHatched ? CriticalPathContent.hatchKey + ". " : "") + AnalysisVocabulary.classBarLabel(content.legend))
    }

    /// A part's tooltip: "Model: 3m 46s of 30m 30s (12%); derived 2s≈", and for unattributed time what it is.
    static func help(_ row: AnalysisVocabulary.LegendRow, derivedUs: Int64) -> String {
        if row.pathClass == .unattributed { return CriticalPathContent.unattributedHelp(row.part) }
        return row.name + ": " + row.part + (derivedUs > 0 ? "; derived \(Formatters.duration(derivedUs))≈" : "")
    }
}
