import SwiftUI

/// The scope bar (DESIGN.md §7.2): one row with the display filter field, then one Outline token per scope part that is
/// set ("Session: <title> ×", "Time: since Oct 12 17:48 (last visit) ×"), Reset Scope when two or more parts are set,
/// and on the right the zone of the times ("Times +08:00 ▾"). Each × removes only its part. A token the workspace does
/// not use is dimmed and says so in its tooltip. The workspace's scope label is in its workspace header.
struct ScopeBar: View {
    @Bindable var model: WindowModel
    @State private var editingTime = false

    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    var body: some View {
        HStack(spacing: 8) {
            FilterField(model: model)
                .frame(minWidth: FilterFieldView.minWidth, maxWidth: .infinity)
                .frame(height: FilterFieldView.height)
                .layoutPriority(1)
            // Laid out before the filter field, which keeps what is left and never less than 320 pt: the first rung
            // that fits beside it shows (ANALYSIS-UX §3.5). Every rung cuts a token's value at 240 pt first.
            ViewThatFits(in: .horizontal) {
                ForEach(ScopeTokens.Fold.allCases, id: \.self) { ScopeTokens(model: model, fold: $0, editingTime: $editingTime) }
            }
            .layoutPriority(2)
            Spacer(minLength: 0)
            if model.isBuildingView && model.view != nil {
                ProgressView().controlSize(.mini).help("Refreshing the view…")
            }
            timesMenu
        }
        .controlSize(metrics.swiftUIControlSize)
        .padding(.horizontal, 12)
        .frame(height: metrics.scopeBar)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// Compare 2 Runs: the scope holds exactly two top-level runs, and Session · Compare is not already showing them.
    static func offersCompare(_ model: WindowModel) -> Bool {
        !model.isComparing && model.compareRunPair(model.scope.sessions) != nil
    }

    /// The tooltip of every Compare 2 Runs control: the scope bar's and the session inspector's.
    static var compareHelp: String { "Session ▸ Compare (\(AgentSharkCommands.modeShortcut(.compare).keys))" }

    /// "Oct 12 17:48" in labels (§9 Dates).
    static func labelDate(_ us: Int64) -> String { Formatters.shortDate(us) + " " + Formatters.shortClock(us) }

    /// "Oct 12 17:48 – 18:20", "since Oct 12 17:48", "until Oct 13 09:00".
    static func rangeLabel(from: Int64?, to: Int64?) -> String {
        switch (from, to) {
        case let (f?, t?): return labelDate(f) + " – " + (Formatters.sameDay(f, t) ? Formatters.shortClock(t) : labelDate(t))
        case let (f?, nil): return "since " + labelDate(f)
        case let (nil, t?): return "until " + labelDate(t)
        default: return "all"
        }
    }

    /// "Times +08:00 ▾": the zone every clock time is in, and the Time column format.
    private var timesMenu: some View {
        Menu {
            Picker("Time Column Format", selection: $model.timeFormat) {
                ForEach(TimeFormat.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            Text("Times " + Formatters.offsetLabel())
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .foregroundStyle(.secondary)
        .help("Clock times are local, \(Formatters.utcOffset()). Full timestamps with the offset are in tooltips and copies.")
    }
}

/// The scope bar's tokens on one rung of its ladder (ANALYSIS-UX §3.5): the session token, Compare 2 Runs, the time
/// token (or "Time Range…"), the time reference and Reset Scope. Where they do not fit beside the filter field,
/// Compare 2 Runs hides first, into a "+1 more ▾" menu token at the end of the tokens, and Reset Scope follows it
/// there, so the tokens that state the scope stay longest; then everything after the session token folds into that
/// menu ("+3 more ▾"), from which each part can still be changed or removed; and last the session token's value cuts
/// further at the tail. Nothing leaves the bar without an item in the menu (DESIGN.md §3.5).
struct ScopeTokens: View {
    /// The rungs, widest first. Without Compare 2 Runs to offer, the first three are the same.
    enum Fold: CaseIterable {
        /// Every token, with Compare 2 Runs when the scope offers it.
        case nothing
        /// Every token, with Compare 2 Runs in "+1 more ▾".
        case compare
        /// The scope tokens, with Compare 2 Runs and Reset Scope in "+1 more ▾".
        case reset
        /// The session token and "+n more ▾". On the last rung the session token's value may cut below 240 pt, so
        /// the bar never overflows.
        case more
    }

    let model: WindowModel
    let fold: Fold
    @Binding var editingTime: Bool

    var body: some View {
        HStack(spacing: 6) {
            if model.scope.hasSessions {
                if fold == .more { NoWiderThanIdeal { sessionToken }.layoutPriority(-1) } else { sessionToken.fixedSize() }
                if fold == .nothing && ScopeBar.offersCompare(model) { compareButton }
            }
            if !foldsTime {
                Group {
                    timeToken
                    if let ref = model.timeReference { timeReferenceToken(ref) }
                    if showsReset && !foldsReset { resetButton }
                }
                .fixedSize()
            }
            if Self.foldedCount(model, fold: fold) > 0 { moreToken }
        }
    }

    private var workspace: Workspace { model.workspace }

    /// Set parts of the scope: the filter, the session set and the time range.
    private var scopeParts: Int {
        [!model.appliedFilter.isEmpty, model.scope.hasSessions, model.scope.hasTimeRange].filter { $0 }.count
    }

    /// Reset Scope shows, inline or in "+n more ▾", when two or more parts are set (DESIGN.md §7.2).
    private var showsReset: Bool { scopeParts >= 2 }

    // MARK: Tokens

    /// The one command among the tokens, so it carries the Compare mode's symbol (§3.5).
    private var compareButton: some View {
        compareAction.labelStyle(.titleAndIcon).fixedSize()
    }

    /// Compare 2 Runs, inline or as the first item of "+n more ▾".
    private var compareAction: some View {
        Button { model.showSessionMode(.compare) } label: {
            Label("Compare 2 Runs", systemImage: SessionMode.compare.symbol)
        }
        .help(ScopeBar.compareHelp)
    }

    private var resetButton: some View {
        Button("Reset Scope") { model.resetScope() }.help(Self.resetHelp)
    }

    private static let resetHelp = "Clear the session set, the time range and the filter"

    /// The session token's value and the start of its tooltip. One run reads as the window title and the session
    /// pickers name it (`runLabel`): a run the catalog has not loaded by its analysis result's title, an untitled one as
    /// "Untitled · cx:0190a0…0001", with the full title and id in the tooltip. Several read "2 sessions".
    static func sessionText(_ model: WindowModel) -> (value: String, help: String) {
        let ids = model.scope.sessions
        guard ids.count != 1 else {
            return (model.runLabel(of: ids[0]), "Session: " + AnalysisVocabulary.runHelp(title: model.runTitle(of: ids[0]), id: ids[0]))
        }
        return ("\(ids.count) sessions", "Sessions: " + ids.prefix(8).map { model.runLabel(of: $0) }.joined(separator: ", ") + (ids.count > 8 ? ", …" : ""))
    }

    private var sessionToken: some View {
        let ids = model.scope.sessions
        let text = Self.sessionText(model)
        var help = text.help + "\nSubagents of these sessions are included."
        if let note = model.shownSessionNote { help += "\n\(note)." }
        if !workspace.honorsSessions { help += "\n\(workspace.title) does not use the session scope." }
        return ScopeToken(kind: ids.count == 1 ? "Session" : "Sessions", value: text.value, applies: workspace.honorsSessions, help: help,
                          clearHelp: "Remove the session scope (keeps the time range and filter)", cuts: fold == .more) {
            model.clearSessionScope()
        }
    }

    /// The time token's value: "since Oct 12 17:48 (last visit)" or "Oct 12 17:48 – 18:20".
    private var timeValue: String {
        let s = model.scope
        return isLastVisit ? "since \(ScopeBar.labelDate(s.from!)) (last visit)" : ScopeBar.rangeLabel(from: s.from, to: s.to)
    }

    private var isLastVisit: Bool { model.entrySince == .lastVisit && model.scope.from != nil && model.scope.to == nil }

    /// Why the time range is dimmed here, as a tooltip line; empty where it applies.
    private var timeNote: String { model.honorsTimeRange ? "" : "\n\(workspace.title) does not use the time range." }

    private func clearTimeRange() {
        model.entrySince = nil
        model.clearTimeScope()
    }

    @ViewBuilder private var timeToken: some View {
        let s = model.scope
        Group {
            if s.hasTimeRange {
                ScopeToken(kind: "Time", value: timeValue, applies: model.honorsTimeRange,
                           help: (isLastVisit ? "Items and events since your last visit, \(Formatters.timestamp(s.from!))." : Formatters.timeRange(from: s.from, to: s.to))
                               + timeNote + "\nClick to change the time range.",
                           clearHelp: Self.clearTimeHelp, onClick: { editingTime = true }, clear: clearTimeRange)
            } else {
                Button("Time Range…") { editingTime = true }
                    .help("Limit the scope to a time range, or drag across the timeline" + timeNote)
            }
        }
        .popover(isPresented: $editingTime, arrowEdge: .bottom) { timeEditor }
    }

    private static let clearTimeHelp = "Remove the time range (keeps the sessions and filter)"

    private var timeEditor: some View {
        TimeRangeEditor(model: model) { editingTime = false }
    }

    /// "17:48:00.000": the time reference's clock time.
    private func referenceValue(_ ref: Int64) -> String { Formatters.clock(ref, zone: Formatters.timeZone) }

    private func timeReferenceToken(_ ref: Int64) -> some View {
        ScopeToken(kind: "Time reference", value: referenceValue(ref), applies: true,
                   help: "Times show as +h:mm:ss.SSS from \(Formatters.timestamp(ref)) (⌃⌘T)",
                   clearHelp: Self.clearReferenceHelp) { model.timeReference = nil }
    }

    private static let clearReferenceHelp = "Clear the time reference (⌃⌘T)"

    // MARK: +n more

    /// Whether "+n more ▾" holds Compare 2 Runs on the rung `fold`: the scope offers it and the rung hides it.
    static func foldsCompare(_ model: WindowModel, fold: Fold) -> Bool { fold != .nothing && ScopeBar.offersCompare(model) }

    /// How many items "+n more" holds on the rung `fold`: Compare 2 Runs when it folds, then on the last rung the time
    /// token or "Time Range…", and the time reference. Reset Scope is a command on those parts, so it is not counted.
    /// Zero on a rung without the menu.
    static func foldedCount(_ model: WindowModel, fold: Fold) -> Int {
        (foldsCompare(model, fold: fold) ? 1 : 0) + (fold == .more ? 1 + (model.timeReference == nil ? 0 : 1) : 0)
    }

    /// The last rung: the time token and what follows it are in "+n more ▾" too.
    private var foldsTime: Bool { fold == .more }

    /// Reset Scope is in "+n more ▾": on the last rung, and beside a folded Compare 2 Runs on the rung before, where it
    /// never makes the menu alone (it is not counted, so that would read "+0 more").
    private var foldsReset: Bool { fold == .more || (fold == .reset && Self.foldsCompare(model, fold: fold)) }

    /// "+3 more ▾": what does not fit, folded into one Outline token at the end of the tokens. Its menu runs Compare 2
    /// Runs first, then names each folded part and changes or removes it, then Reset Scope; on the last rung the time
    /// range editor opens from it.
    private var moreToken: some View {
        let n = Self.foldedCount(model, fold: fold)
        let compare = Self.foldsCompare(model, fold: fold)
        var parts = compare ? ["Compare 2 Runs (\(AgentSharkCommands.modeShortcut(.compare).keys))"] : []
        if foldsTime {
            parts.append(model.scope.hasTimeRange ? "Time: " + timeValue : "No time range")
            if let ref = model.timeReference { parts.append("Time reference: " + referenceValue(ref)) }
        }
        return Menu {
            if compare { compareAction.labelStyle(.titleAndIcon) }
            if foldsTime {
                if compare { Divider() }
                foldedTimeParts
            }
            if foldsReset && showsReset {
                Divider()
                resetButton
            }
        } label: {
            Text("+\(n) more")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .scopeTokenChrome()
        .help(parts.joined(separator: "\n") + (foldsTime ? timeNote : "") + "\nThese do not fit beside the filter field.")
        .accessibilityLabel("\(n) more scope bar items")
        .popover(isPresented: foldsTime ? $editingTime : .constant(false), arrowEdge: .bottom) { timeEditor }
    }

    /// The last rung's menu items for the time range and the time reference.
    @ViewBuilder private var foldedTimeParts: some View {
        if model.scope.hasTimeRange {
            Section("Time: " + timeValue) {
                Button("Change Time Range…") { editingTime = true }
                Button("Remove Time Range", action: clearTimeRange).help(Self.clearTimeHelp)
            }
        } else {
            Button("Time Range…") { editingTime = true }
        }
        if let ref = model.timeReference {
            Section("Time reference: " + referenceValue(ref)) {
                Button("Clear Time Reference") { model.timeReference = nil }.help(Self.clearReferenceHelp)
            }
        }
    }
}

/// A scope token (§6.1 Outline, neutral): "Kind: value ×". The kind is muted; clicking the value opens its editor and
/// the × removes only this part. A token the workspace does not use is dimmed.
struct ScopeToken: View {
    let kind: String
    let value: String
    let applies: Bool
    let help: String
    let clearHelp: String
    var onClick: (() -> Void)?
    /// The value may cut below 240 pt whatever its length: the scope bar's last rung, where nothing else can give way.
    var cuts = false
    let clear: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            if let onClick {
                Button(action: onClick) { label }.buttonStyle(.plain)
            } else {
                label
            }
            Button(action: clear) {
                Image(systemName: "xmark").imageScale(.small).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .iconHelp(clearHelp)
        }
        .scopeTokenChrome()
        .opacity(applies ? 1 : 0.5)
        .help(help)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(kind): \(value)\(applies ? "" : ", not used here")")
    }

    /// "Kind: value", the kind muted, cut at the tail at 240 pt (§3.5 Scope token).
    private var label: some View {
        (Text(kind + ": ").foregroundStyle(.secondary) + Text(value))
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: 240, alignment: .leading)
            .fixedSize(horizontal: !cuts && value.count < 30, vertical: false)
    }
}

/// Its one view at its ideal width, or narrower when less is proposed: a token that may cut never stretches to fill.
private struct NoWiderThanIdeal: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        let ideal = view.sizeThatFits(.unspecified).width
        return view.sizeThatFits(ProposedViewSize(width: min(ideal, proposal.width ?? ideal), height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}

/// The Outline token's frame (§6.1): its type size, padding, height and hairline border, for the control size.
private struct ScopeTokenChrome: ViewModifier {
    @Environment(\.controlSize) private var controlSize

    func body(content: Content) -> some View {
        content
            .font(controlSize == .small ? .system(size: 11) : .system(size: 13))
            .padding(.horizontal, 8)
            .frame(height: controlSize == .small ? 20 : 24)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
    }
}

extension View {
    fileprivate func scopeTokenChrome() -> some View { modifier(ScopeTokenChrome()) }
}

/// Click on the time chip: set the time range (investigation scope) with two date pickers and presets.
struct TimeRangeEditor: View {
    @Bindable var model: WindowModel
    let done: () -> Void
    @State private var from = Date()
    @State private var to = Date()
    @State private var hasFrom = false
    @State private var hasTo = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Time Range").font(.headline)
            Text("Limits the events in Events, Statistics and Diagnostics, and the spans in Timeline and Flow. Times are in \(Formatters.utcOffset()).")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .leading, verticalSpacing: 6) {
                GridRow {
                    Toggle("From:", isOn: $hasFrom)
                    DatePicker("From", selection: $from, displayedComponents: [.date, .hourAndMinute]).labelsHidden().disabled(!hasFrom)
                }
                GridRow {
                    Toggle("To:", isOn: $hasTo)
                    DatePicker("To", selection: $to, displayedComponents: [.date, .hourAndMinute]).labelsHidden().disabled(!hasTo)
                }
            }
            HStack {
                ForEach([("Last Hour", 3600.0), ("Last 24 Hours", 86400.0), ("Last 7 Days", 7 * 86400.0)], id: \.0) { title, seconds in
                    Button(title) {
                        hasFrom = true
                        hasTo = false
                        from = Date().addingTimeInterval(-seconds)
                    }
                    .controlSize(.small)
                }
            }
            HStack {
                Button("Clear Time Range") {
                    model.clearTimeScope()
                    done()
                }
                .disabled(!model.scope.hasTimeRange)
                Spacer()
                Button("Cancel", role: .cancel, action: done).keyboardShortcut(.cancelAction)
                Button("Apply") {
                    model.setTimeRange(from: hasFrom ? Int64(from.timeIntervalSince1970 * 1e6) : nil,
                                       to: hasTo ? Int64(to.timeIntervalSince1970 * 1e6) : nil)
                    done()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(hasFrom && hasTo && to <= from)
            }
        }
        .padding(16)
        .frame(width: 400)
        .onAppear {
            let s = model.scope
            hasFrom = s.from != nil
            hasTo = s.to != nil
            from = s.from.map { Date(timeIntervalSince1970: Double($0) / 1e6) } ?? Date().addingTimeInterval(-3600)
            to = s.to.map { Date(timeIntervalSince1970: Double($0) / 1e6) } ?? Date()
        }
    }
}
