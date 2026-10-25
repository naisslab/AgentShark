import SwiftUI

/// A selection in words for the selection bar: its lead in semibold, then the parts after it, each after a "·", then
/// the action it holds, if any. "Model · 42.1s · Main", "sh:npm audit · 45s · audit:deps", "Row 21 · Different outcome
/// · A" and the test symbol before "pytest -q".
struct SelectionSentence: Hashable, Sendable {
    /// An action as the alignment table shows it: the op's symbol, then the object in monospace, so the op never reads
    /// as part of a command. `text` names the op in words.
    struct Action: Hashable, Sendable {
        var symbol: String
        var op: String
        var object: String
    }

    var lead: String
    var parts: [String] = []
    var action: Action?
    /// What the bar's words leave out, after them in the tooltip and the accessibility label: "Failed. Target sh:rg#…".
    var detail: String?

    /// The sentence as one string: the bar's tooltip and accessibility label, and the tests' reading of it.
    var text: String { ([lead] + parts + (action.map { [$0.op + " " + $0.object] } ?? [])).joined(separator: " · ") }
}

/// The selection bar of both analyses (ANALYSIS-UX §4.10, §5.12), defined once and at the bottom of the pane in both,
/// so switching modes keeps where to look: the selection in words, then every action on it as a button, so none exists
/// only in a context menu (DESIGN.md §10). The words keep their room first; when the buttons do not fit beside them
/// they fold into one Actions menu, and when the words do not fit beside that menu they cut at their tail.
struct SelectionBar<Actions: View>: View {
    /// The selection; nil while nothing is selected, which shows `placeholder`.
    let sentence: SelectionSentence?
    /// "No row selected", "No mark or row selected".
    let placeholder: String
    let metrics: Theme.Metrics
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        HStack(spacing: 12) {
            words.layoutPriority(1)
            Spacer(minLength: 8)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { actions() }.fixedSize()
                Menu("Actions") { actions() }.menuStyle(.borderlessButton).fixedSize()
            }
        }
        .font(Theme.fontSwiftUI(.rowSecondary, metrics.density))
        .controlSize(metrics.swiftUIControlSize)
        .padding(.horizontal, 12)
        .frame(height: metrics.workspaceHeader)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    @ViewBuilder private var words: some View {
        if let sentence {
            let said = [sentence.text, sentence.detail].compactMap { $0 }
            line(sentence)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(said.joined(separator: "\n"))
                .accessibilityLabel("Selected: " + said.joined(separator: ". "))
        } else {
            Text(placeholder).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private func line(_ sentence: SelectionSentence) -> Text {
        let dot = Text(" · ").foregroundStyle(.tertiary)
        let words = sentence.parts.reduce(Text(sentence.lead).fontWeight(.semibold)) { line, part in
            line + dot + Text(part).foregroundStyle(.secondary)
        }
        guard let a = sentence.action else { return words }
        return words + dot + Text(Image(systemName: a.symbol)).fontWeight(.semibold).foregroundStyle(.secondary)
            + Text(" " + a.object).font(Theme.fontSwiftUI(.rowSecondary, metrics.density).monospaced()).foregroundStyle(.secondary)
    }
}
