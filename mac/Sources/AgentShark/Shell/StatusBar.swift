import SwiftUI

/// The status bar (DESIGN.md §7.16): Selection, Attention, Index and Source location, then the index's last run on the
/// right. Each segment shows only when no pane or chrome row already shows its fact, and segments drop whole when the
/// row is short (Index first, then Source location, then Selection). Workspace counts and scope labels live in the
/// workspace header, never here.
struct StatusBar: View {
    @Bindable var model: WindowModel
    @State private var indexBytes: Int64?

    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    var body: some View {
        HStack(spacing: 0) {
            ViewThatFits(in: .horizontal) {
                segments(drop: 0)
                segments(drop: 1)
                segments(drop: 2)
                segments(drop: 3)
            }
            Spacer(minLength: 8)
            Text(watchText)
                .lineLimit(1)
                .fixedSize()
                .help(model.info?.indexing.lastRunAt == nil ? "No completed index run yet"
                      : model.store.statusDetail.isEmpty ? model.store.statusTitle : model.store.statusDetail)
        }
        .font(Theme.fontSwiftUI(.metadata))
        .foregroundStyle(.secondary)
        .padding(.trailing, 10)
        .frame(height: metrics.statusBar)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .task(id: model.info?.indexing.lastRunAt ?? 0) { await measureIndex() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Status bar")
    }

    /// The segments, leaving out the `drop` lowest priorities (P4 Index, P3 Source location, P2 Selection).
    private func segments(drop: Int) -> some View {
        HStack(spacing: 0) {
            if drop < 3, let s = selection {
                segment { Text(s.text).lineLimit(1).truncationMode(.tail).frame(maxWidth: 420, alignment: .leading).fixedSize().help(s.help) }
            }
            if let attention = attentionText {
                segment {
                    Button { model.workspace = .failures } label: {
                        Text(attention).foregroundStyle(model.derived.openAlarms > 0 ? Theme.err.swiftUI : .secondary)
                    }
                    .buttonStyle(.plain)
                    .fixedSize()
                    .help("Items that need attention and alarms that are firing in all sessions, whatever the scope. Click to open Failures.")
                }
            }
            if drop < 1 {
                segment { Text(indexText).fixedSize().help(model.info?.indexPath ?? "") }
            }
            if drop < 2, let loc = sourceLocation {
                segment {
                    Text(loc.text).lineLimit(1).truncationMode(.middle).frame(maxWidth: 320, alignment: .leading).fixedSize()
                        .help(loc.help)
                }
            }
        }
    }

    /// One segment: 10 pt each side and a hairline after it.
    private func segment<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        HStack(spacing: 0) {
            content().padding(.horizontal, 10)
            Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 1, height: 12).accessibilityHidden(true)
        }
    }

    // MARK: Segments

    /// "2,941 need attention · 1 alarm · all sessions" (§9 Attention). Failures owns the scoped count, so it hides there.
    private var attentionText: String? {
        guard model.workspace != .failures, model.derived.isAvailable, let n = model.derived.needAttention else { return nil }
        return Self.attention(n, alarms: model.derived.openAlarms)
    }

    static func attention(_ n: Int, alarms: Int) -> String {
        Formatters.count(n) + " need attention" + (alarms > 0 ? " · " + Formatters.count(alarms, "alarm") : "") + " · all sessions"
    }

    /// Whether a visible pane already shows the selection: the Lens in Failures, Detail in Events, the inspector in
    /// Session · Steps, Critical Path and Compare.
    private var paneShowsSelection: Bool {
        switch model.workspace {
        case .failures, .events: return true
        case .session: return model.sessionMode.hasDerivedInspector && model.showDerivedInspector
        default: return false
        }
    }

    /// Whether the Raw pane is visible (it shows the selection's source).
    private var rawIsVisible: Bool {
        switch model.workspace {
        case .events: return true
        case .failures: return model.showDerivedInspector
        case .session: return model.sessionMode.hasDerivedInspector && model.showDerivedInspector
        default: return false
        }
    }

    /// "Selected: step 46 · 5 of 6 in turn 6", or the selected event (§9 Selection).
    private var selection: (text: String, help: String)? {
        guard !paneShowsSelection else { return nil }
        if model.workspace == .session, model.sessionMode == .steps, let s = model.steps.selectedStep {
            return Self.stepSelection(s, turn: model.steps.turn(of: s), place: model.steps.place(of: s))
        }
        guard let id = model.selectedEvent else { return nil }
        let kind = model.eventDetail?.event.kind.rawValue ?? "event"
        let no = model.selectedRow.map { " No. " + Formatters.count($0 + 1) } ?? ""
        var text = "Selected: " + kind + no
        if let step = model.eventDerived?.step {
            // "… · 279 of 288 in turn 1", as Steps phrases it (§9 Step position): the turn number from the event's turn span.
            let turn = model.eventDetail.flatMap { d in (d.spanChain + [d.span].compactMap { $0 }).first { $0.id == step.turnId } }
            text += " · " + Formatters.stepPosition(step.n, inTurn: step.inTurn.map { ($0.n, $0.of) }, turn: turn?.attrs?["turn"]?["index"]?.intValue)
        }
        return (text, "Selected event \(id)" + (model.selectedRow == nil ? " (not in the event view)" : ""))
    }

    /// "Selected: step 46 · 5 of 6 in turn 6".
    static func stepSelection(_ s: StepItem, turn: StepTurn?, place: (k: Int, of: Int)?) -> (text: String, help: String) {
        ("Selected: " + Formatters.stepPosition(s.n, inTurn: place, turn: turn?.n), "Selected step \(s.id)")
    }

    /// "Selected: episode s_3f9a…:812 · step 164": the Lens item, for a reader that has no Lens (Copy Report, tests).
    static func lensSelection(_ item: LensItem, step: LensWhere.StepAt?) -> (text: String, help: String) {
        let short = item.id.range(of: "#ep:").map { String(item.id[$0.upperBound...]) } ?? TimelineText.shortID(item.id)
        let at = step?.n.map { " · step \($0)" } ?? ""
        return ("Selected: \(item.kind.rawValue) \(short)\(at)", "Selected \(item.kind.rawValue) \(item.id)")
    }

    /// The selection's source file and line, where no Raw pane shows it.
    private var sourceLocation: (text: String, help: String)? {
        guard !rawIsVisible, model.selectedEvent != nil, let raw = model.eventDetail?.event.raw, let path = raw.path else { return nil }
        let text = (path as NSString).abbreviatingWithTildeInPath + ":" + String(raw.line)
        return (text, path + ", line \(raw.line)")
    }

    private var indexText: String {
        if let url = model.engine.captureURL { return "Capture \(url.lastPathComponent)" }
        guard let info = model.info else { return "Index not loaded" }
        var parts = ["Index \(Formatters.count(info.counts.sources, "source"))"]
        if let bytes = indexBytes { parts.append(Formatters.bytes(bytes)) }
        return parts.joined(separator: " · ")
    }

    /// "Last index 2m ago · analysis pending": the index's last run. The toolbar's status item names the watch state.
    private var watchText: String {
        var parts: [String] = []
        // Never the watch state the toolbar already names (Mac notes 3): before the first completed run, "Last index —".
        parts.append("Last index " + (model.info?.indexing.lastRunAt.map { Formatters.relative($0) } ?? Formatters.missing))
        if model.info?.analysis?.pending.isEmpty == false { parts.append("analysis pending") }
        return parts.joined(separator: " · ")
    }

    /// Size of the index database (with its write-ahead log), read off the main thread.
    private func measureIndex() async {
        guard let path = model.info?.indexPath, !path.isEmpty else { return }
        indexBytes = await Task.detached(priority: .utility) {
            let fm = FileManager.default
            return [path, path + "-wal"].reduce(Int64(0)) { sum, p in
                sum + ((try? fm.attributesOfItem(atPath: p)[.size] as? NSNumber)?.int64Value ?? 0)
            }
        }.value
    }
}
