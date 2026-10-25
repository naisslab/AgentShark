import AppKit
import SwiftUI

/// The first divergence (ANALYSIS-UX §5.8): the first aligned row that is not the same in both runs, the last shared
/// action before it, what each run saw last, and each run's next actions. It points where to look and never says why:
/// "A lead for investigation, not a cause." stays on its title line, and the caveat line under it carries the two gaps
/// every alignment has.
struct DivergenceCard: View {
    let model: WindowModel
    let result: DiffResult
    let compare: CompareModel

    private var density: Preferences.RowDensity { model.app.preferences.rowDensity }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            titleLine
            if let d = result.firstDivergence {
                Text(AnalysisVocabulary.divergenceDetail(d))
                    .font(Theme.fontSwiftUI(.rowPrimary, density))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(AnalysisVocabulary.divergenceDetail(d))
                // Two empty observations read as one line, so the next actions sit a row higher.
                let neither = d.left.observation == nil && d.right.observation == nil
                VStack(alignment: .leading, spacing: 4) {
                    if neither {
                        Text("No observation recorded for either run.")
                            .font(Theme.fontSwiftUI(.rowPrimary, density))
                            .foregroundStyle(.secondary)
                            .help("Neither run's last action before the divergence has a logged result")
                    }
                    HStack(alignment: .top, spacing: 24) {
                        side(.a, d.left, observation: !neither)
                        side(.b, d.right, observation: !neither)
                    }
                }
                .padding(.vertical, 2)
            }
            // Neither the buttons nor the caveat line is ever cut (DESIGN.md §3.5): the caveat line is prose to read, so
            // where it does not fit beside the buttons it wraps under them, and Show A and Show B fold into one Show menu
            // only when the buttons alone do not fit.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 16) {
                    if let d = result.firstDivergence { buttons(d, folded: false) }
                    caveat.fixedSize()
                    Spacer(minLength: 0)
                }
                VStack(alignment: .leading, spacing: 6) {
                    if let d = result.firstDivergence {
                        ViewThatFits(in: .horizontal) {
                            buttons(d, folded: false)
                            buttons(d, folded: true)
                        }
                    }
                    caveat.fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// The two gaps every alignment has; the tooltip adds every permanent gap and the engine's caveats.
    private var caveat: some View {
        Text(AnalysisVocabulary.caveatLine(notes: result.coverage.notes))
            .font(Theme.fontSwiftUI(.metadata, density))
            .foregroundStyle(.secondary)
            .help(CompareText.caveatHelp(result))
    }

    /// "First divergence: row 1 of 1,299" (or the no-divergence sentence), with the lead sentence at its end.
    private var titleLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(AnalysisVocabulary.divergenceTitle(index: result.firstDivergence?.index, rows: result.alignedRows))
                .font(Theme.fontSwiftUI(.title, density))
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 12)
            Text(AnalysisVocabulary.leadNotCause)
                .font(Theme.fontSwiftUI(.rowSecondary, density))
                .foregroundStyle(.secondary)
                .fixedSize()
                .help(result.caveats.last ?? "")
        }
    }

    /// One run's half: what it saw last before the divergence (unless `observation` is false), then its next actions,
    /// each after its label.
    private func side(_ s: CompareSide, _ d: DiffResult.DivergenceSide, observation: Bool) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 8, verticalSpacing: 4) {
            if observation {
                GridRow {
                    label("\(s.letter) saw")
                    if let o = d.observation {
                        Observation(text: o.excerpt, density: density) {
                            if let e = o.evidence.first { model.select(event: e.eventId, reveal: false) }
                        }
                        .help("What run \(s.letter) saw last before the divergence. Click to select the event that returned it.")
                    } else {
                        Text("No observation recorded.")
                            .font(Theme.fontSwiftUI(.rowPrimary, density))
                            .foregroundStyle(.secondary)
                            .help("Run \(s.letter)'s last action before the divergence has no logged result")
                    }
                }
            }
            GridRow {
                label("\(s.letter) next")
                if d.next.isEmpty {
                    Text("No further actions.").font(Theme.fontSwiftUI(.rowPrimary, density)).foregroundStyle(.secondary)
                } else {
                    FlowLayout(spacing: 4, lineSpacing: 3) {
                        ForEach(Array(d.next.enumerated()), id: \.offset) { _, a in
                            ActionToken(action: a, density: density) { model.select(event: a.eventID, reveal: false) }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(Theme.fontSwiftUI(.rowSecondary, density).weight(.semibold))
            .foregroundStyle(.secondary)
            .fixedSize()
            .gridColumnAlignment(.leading)
    }

    /// Show Row, Show A in Events and Show B in Events, each whole; `folded` keeps Show Row and puts the other two in a
    /// Show menu, as Critical Path's selection bar folds.
    private func buttons(_ d: DiffResult.Divergence, folded: Bool) -> some View {
        HStack(spacing: 8) {
            Button("Show Row") { compare.reveal(row: position(of: d.index)) }
                .help("Select row \(Formatters.count(d.index + 1)) in the alignment table")
                .disabled(!result.alignment.contains { $0.index == d.index })
                .fixedSize()
            if folded {
                Menu("Show") { showInEvents(d) }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(d.left.next.isEmpty && d.right.next.isEmpty)
                    .help("Select run A's or run B's first action from this row in Events")
            } else {
                showInEvents(d)
            }
        }
        .controlSize(model.app.preferences.metrics.swiftUIControlSize)
    }

    @ViewBuilder private func showInEvents(_ d: DiffResult.Divergence) -> some View {
        ForEach(CompareSide.allCases, id: \.self) { side in
            let a = (side == .a ? d.left : d.right).next.first
            Button("Show \(side.letter) in Events") { if let a { model.select(event: a.eventID, reveal: true) } }
                .disabled(a == nil)
                .help(a == nil ? "Run \(side.letter) has no action from this row on"
                      : "Select run \(side.letter)'s first action from this row in Events")
                .fixedSize()
        }
    }

    private func position(of index: Int) -> Int {
        result.alignment.firstIndex { $0.index == index } ?? index
    }
}

/// An observation excerpt (the engine sends at most 400 characters): monospace on a well, clamped to four lines with
/// Show All when it is longer.
private struct Observation: View {
    let text: String
    let density: Preferences.RowDensity
    let select: () -> Void
    @State private var expanded = false
    @State private var clamped = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: select) {
                Text(text)
                    .font(Theme.fontSwiftUI(.code, density))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(expanded ? nil : 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .background {
                        // The unclamped height tells whether four lines cut the text.
                        Text(text).font(Theme.fontSwiftUI(.code, density)).fixedSize(horizontal: false, vertical: true).hidden()
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { full in
                                clamped = full > Theme.font(.code, density).boundingRectForFont.height * 4.6
                            }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color(nsColor: .quaternarySystemFill)))
            }
            .buttonStyle(.plain)
            if clamped {
                Button(expanded ? "Show Less" : "Show All (\(Formatters.count(text.count, "character")))") { expanded.toggle() }
                    .buttonStyle(.link)
                    .font(Theme.fontSwiftUI(.rowSecondary, density))
            }
        }
    }
}

/// A next action as a call token (DESIGN.md §6.2): the op symbol and the action's object in monospace on a well; a
/// failed action carries the failed mark. A click selects its event.
struct ActionToken: View {
    let action: DiffResult.ActionView
    let density: Preferences.RowDensity
    let select: () -> Void

    var body: some View {
        let shown = CompareText.action(action)
        Button(action: select) {
            HStack(spacing: 4) {
                Image(systemName: AnalysisVocabulary.opSymbol(action.op))
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text(CompareText.clipped(shown.text, to: 28))
                    .font(Theme.fontSwiftUI(.code, density))
                    .lineLimit(1)
                    .fixedSize()
                if let mark = AnalysisVocabulary.outcomeSymbol(action.outcome) {
                    Image(systemName: mark).foregroundStyle(Theme.err.swiftUI).accessibilityHidden(true)
                }
            }
            .font(Theme.fontSwiftUI(.rowSecondary, density))
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 3).fill(Color(nsColor: .quaternarySystemFill)))
        }
        .buttonStyle(.plain)
        .help((shown.help.map { $0 + "\n" } ?? "") + "Click to select this action's event")
        .accessibilityLabel(CompareText.spoken(action) + (action.outcome == .failed ? ", failed" : ""))
    }
}
