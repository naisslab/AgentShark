import SwiftUI

/// A button inside the evidence line, between the gaps and what the engine read.
struct EvidenceLineAction {
    let title: String
    let help: String
    let perform: () -> Void
}

/// The evidence line of both analyses (ANALYSIS-UX §4.4, §5.8 Placement; DESIGN.md §7.8 Data-gap line), defined once,
/// so switching between Critical Path and Compare keeps where to look and where to click. One line, always visible:
/// the data gaps (`AnalysisVocabulary.gapHeadline`) cut at their tail, a view's own sentence or control after them,
/// then what the engine read, "{events} · Times {offset}", kept whole, and the chevron last. The whole row is the
/// button that opens every gap sentence in full, the caveats and the rule, for a click, for Space or Return once the
/// keyboard focuses it, and for VoiceOver; a control inside it (Compare's "Compare Up to 2,000 Actions") keeps its own
/// click and is the line's named accessibility action.
struct EvidenceLine<Popover: View>: View {
    /// The gaps in one line: `AnalysisVocabulary.gapHeadline`, or what no gap means in this view.
    let headline: String
    /// What the line reads aloud: every gap sentence whole (`AnalysisVocabulary.gapsSpoken`), then `notice` and
    /// `coverage`.
    let spoken: String
    /// "6,262 of 6,262 events · Times +08:00".
    let coverage: String
    var coverageHelp = ""
    /// A sentence after the gaps, kept whole: Critical Path's "This event is not on the critical path."
    var notice: String?
    var action: EvidenceLineAction?
    /// The row's tooltip and accessibility hint: what a click shows.
    let help: String
    let hint: String
    let metrics: Theme.Metrics
    /// How the keyboard reaches the row: `.activate`, a button's, so with Full Keyboard Access on. Tests, which cannot
    /// turn that setting on, pass `.automatic` to walk the key-view loop.
    var focusInteractions: FocusInteractions = .activate
    @ViewBuilder let popover: () -> Popover
    @State private var shown = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: Mark.dataGap.symbol).foregroundStyle(.secondary).accessibilityHidden(true)
            Text(headline).lineLimit(1).truncationMode(.tail).layoutPriority(-1)
            if let notice {
                Text(notice).fixedSize()
            }
            if let action {
                Button(action.title, action: action.perform)
                    .controlSize(metrics.swiftUIControlSize)
                    .fixedSize()
                    .help(action.help)
                    .padding(.leading, 6)
            }
            Spacer(minLength: 12)
            Text(coverage).monospacedDigit().foregroundStyle(.secondary).fixedSize().help(coverageHelp)
            Image(systemName: "chevron.right").imageScale(.small).foregroundStyle(.tertiary).accessibilityHidden(true)
        }
        .font(Theme.fontSwiftUI(.rowSecondary, metrics.density))
        .padding(.horizontal, 12)
        .frame(height: metrics.workspaceHeader)
        // The whole row is the button: the gaps, the space after them and what the engine read. A control inside it
        // takes its own click first.
        .contentShape(Rectangle())
        .onTapGesture { shown.toggle() }
        .help(help)
        .popover(isPresented: $shown, arrowEdge: .bottom) { popover() }
        .background(Color.secondary.opacity(0.06))
        .overlay(alignment: .bottom) { Divider() }
        // And so for the keyboard (DESIGN.md §10.1): with Full Keyboard Access the row is a stop of the key-view loop,
        // as a button is, and Space or Return opens the popover. A control inside it is a stop of its own.
        .focusable(interactions: focusInteractions)
        .onKeyPress(keys: [.space, .return], phases: .down) { _ in
            shown.toggle()
            return .handled
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(hint)
        .accessibilityAction { shown.toggle() }
        .accessibilityActions {
            if let action { Button(action.title, action: action.perform) }
        }
    }
}

/// What the evidence line opens: every gap sentence (its code in the tooltip), the analysis's caveats verbatim, and
/// below a divider the rule and what the analysis covers.
struct EvidencePopover: View {
    struct Gap: Hashable {
        let code: WorkbenchGap
        let text: String
    }

    /// One line under the divider, with its tooltip.
    struct Note: Hashable {
        let text: String
        var help = ""
    }

    let gaps: [Gap]
    /// Gaps true of every result of the analysis, which lead the caveats rather than count as gaps of this data:
    /// Compare's permanent gaps (§5.8 Placement).
    var caveatGaps: [Gap] = []
    let caveats: [String]
    let notes: [Note]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                section("Data gaps") {
                    if gaps.isEmpty {
                        Text(caveatGaps.isEmpty ? "None" : "None in this data").foregroundStyle(.secondary).font(Theme.fontSwiftUI(.rowPrimary))
                    }
                    ForEach(gaps, id: \.self) { gap($0) }
                }
                if !caveatGaps.isEmpty || !caveats.isEmpty {
                    section("Caveats") {
                        ForEach(caveatGaps, id: \.self) { gap($0) }
                        ForEach(caveats, id: \.self) { bullet($0) }
                    }
                }
                if !notes.isEmpty {
                    Divider()
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(notes, id: \.self) { n in Text(n.text).help(n.help) }
                    }
                    .font(Theme.fontSwiftUI(.metadata))
                    .foregroundStyle(.secondary)
                }
            }
            .padding(16)
            .frame(width: 460, alignment: .leading)
        }
        .frame(maxHeight: 600)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ rows: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(Theme.fontSwiftUI(.sectionLabel)).foregroundStyle(.secondary)
            rows()
        }
    }

    private func gap(_ g: Gap) -> some View {
        bullet(g.text).help(AnalysisVocabulary.gapHelp(g.code))
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("•").foregroundStyle(.tertiary).accessibilityHidden(true)
            Text(text).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
        .font(Theme.fontSwiftUI(.rowPrimary))
    }
}
