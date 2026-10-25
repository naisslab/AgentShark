import AppKit
import SwiftUI

/// Session · Compare (ANALYSIS-UX §5): two top-level runs aligned action by action, from the engine's AgentDiff
/// analysis. Run A started first (`WindowModel.compareSides`); the filter and time range do not apply. The scope decides
/// what shows (§5.1): no run, a subagent, one run (the run chooser), or two or more runs (the comparison). The comparison
/// reads top to bottom: the data-gap line, the Runs grid and Behavior, the first divergence, the summary chips, the
/// alignment table with its minimap, and the selection bar; ⌥⌘I adds the selected action's detail and raw panes.
struct CompareWorkspace: View {
    @Bindable var model: WindowModel

    private var compare: CompareModel { CompareModel.of(model) }
    private var request: AnalysisRequest<DiffResult> { model.analyses.diff }

    /// What to align: runs A and B with the header's options; nil until the scope holds two top-level runs.
    private var spec: AnalysisSpec<DiffResult>? {
        guard let sides = model.compareSides else { return nil }
        return .diff(left: sides.a, right: sides.b, children: model.compare.subagents, limit: model.compare.limit)
    }

    /// The alignment on screen, only while the scope holds runs to compare.
    private var shown: DiffResult? {
        guard case .runs = model.compareScope else { return nil }
        return request.value
    }

    var body: some View {
        VStack(spacing: 0) {
            WorkspaceHeader(model: model, label: model.compareScopeLabel(rows: shown?.alignedRows), labelHelp: model.sessionScopeHelp(.compare)) {
                SessionModeSwitch(model: model)
            } controls: {
                HeaderControls(model: model, onlyDifferences: onlyDifferences)
            } folded: {
                HeaderControls(model: model, folded: true, onlyDifferences: onlyDifferences)
            }
            content
        }
        .onAppear {
            request.isVisible = true
            send()
        }
        .onDisappear {
            request.isVisible = false
            if model.differenceRegions === compare { model.differenceRegions = nil }
        }
        .onChange(of: spec?.key) { _, _ in send() }
    }

    /// Ask for the alignment of the sides as they stand, locking them first so the key cannot flip under the request.
    private func send() {
        model.lockCompareSides()
        request.want(spec)
    }

    /// Only Differences acts on the alignment table, so it is enabled while one shows.
    private var onlyDifferences: Binding<Bool>? {
        guard shown != nil else { return nil }
        let compare = self.compare
        return Binding(get: { compare.filter.onlyDifferences }, set: { compare.filter.onlyDifferences = $0 })
    }

    @ViewBuilder private var content: some View {
        switch model.compareScope {
        case .empty:
            ContentUnavailableView("No runs selected", systemImage: SessionMode.compare.symbol,
                                   description: Text("Select a run in the sidebar, or two runs with ⌘-click."))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .onAppear(perform: clearComparison)
        case .subagents(let ids):
            ContentUnavailableView {
                Label("Compare aligns two top-level runs", systemImage: SessionMode.compare.symbol)
            } description: {
                Text(subagentNote(ids))
            } actions: {
                Button(ids.count == 1 ? "Use Whole Run" : "Use Whole Runs") { model.useWholeRuns() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onAppear(perform: clearComparison)
        case .oneRun(let run, let withOwnSubagent):
            RunChooser(model: model, current: run,
                       note: withOwnSubagent ? "These are one run and its own subagent. Compare aligns two separate runs." : nil)
                .onAppear(perform: clearComparison)
        case .runs:
            ComparePanes(model: model, compare: compare) {
                CompareMain(model: model, compare: compare, request: request)
            }
        }
    }

    /// No alignment shows: the comparison lets go of its rows and selection, so ⌘↩ and Go ▸ Difference Region find
    /// nothing to act on.
    private func clearComparison() {
        CompareMain.clear(model: model, compare: compare, key: request.key)
    }

    /// "Find the auth tests is a subagent of Port tests to vitest."
    private func subagentNote(_ ids: [String]) -> String {
        guard ids.count == 1 else { return "The \(ids.count) selected sessions are subagents." }
        let root = model.rootSession(of: ids[0])
        return "\(model.store.title(of: ids[0])) is a subagent of \(model.store.title(of: root))."
    }
}

extension CompareWorkspace {
    /// The header's inline controls (§5.1, §5.5): the A and B pickers when more than two runs are selected, Swap, the
    /// Subagents and Only Differences toggles, and the Inspector toggle. `folded` is the narrow form, one Options menu,
    /// so the mode switch never folds (Decision 4). `LayoutFitTests` measures both forms.
    struct HeaderControls: View {
        @Bindable var model: WindowModel
        var folded = false
        /// The alignment table's Only Differences; nil while no alignment shows, which disables the toggle.
        var onlyDifferences: Binding<Bool>? = nil

        var body: some View {
            if folded {
                Menu("Options") {
                    sidePickers
                    Button("Swap") { model.swapCompareSides() }.disabled(model.compareSides == nil)
                    Divider()
                    toggles
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            } else {
                sidePickers.frame(maxWidth: 180)
                Button("Swap", systemImage: "arrow.left.arrow.right") { model.swapCompareSides() }
                    .labelStyle(.titleAndIcon)
                    .disabled(model.compareSides == nil)
                    .help("Show run B on the A side; the scope stays as it is")
                toggles.toggleStyle(.checkbox)
            }
        }

        /// A ▾ and B ▾, limited to the selected runs; picking the other side's run swaps them.
        @ViewBuilder private var sidePickers: some View {
            if case .runs(let roots) = model.compareScope, roots.count > 2, let sides = model.compareSides {
                Picker("A", selection: Binding(get: { sides.a }, set: { model.setCompareSides(a: $0, b: $0 == sides.b ? sides.a : sides.b) })) {
                    runItems(roots)
                }
                .help("Run A, one of the selected runs")
                Picker("B", selection: Binding(get: { sides.b }, set: { model.setCompareSides(a: $0 == sides.a ? sides.b : sides.a, b: $0) })) {
                    runItems(roots)
                }
                .help("Run B, one of the selected runs")
            }
        }

        /// "Port tests to vitest · Oct 22 09:15": runs with the same title stay apart.
        private func runItems(_ roots: [String]) -> some View {
            ForEach(roots, id: \.self) { id in
                Text(([model.store.title(of: id)] + [model.sessionsByID[id]?.start.map(Formatters.shortDateTime)].compactMap { $0 })
                    .joined(separator: " · ")).tag(id)
            }
        }

        @ViewBuilder private var toggles: some View {
            Toggle("Subagents", isOn: $model.compare.subagents)
                .help("Align the runs' subagents too")
            Toggle("Only Differences", isOn: onlyDifferences ?? .constant(false))
                .disabled(onlyDifferences == nil)
                .help("Hide the rows that are the same in both runs")
            Toggle("Inspector", isOn: $model.showDerivedInspector)
                .help("The selected action's event detail and raw source (⌥⌘I)")
        }
    }
}

// MARK: - Panes

/// The comparison beside the selected action's detail and raw panes (⌥⌘I, §5.12). Above them, an A | B control chooses
/// the run whose action they show when the selected row has both.
private struct ComparePanes<Main: View>: View {
    @Bindable var model: WindowModel
    let compare: CompareModel
    @ViewBuilder var main: Main
    @State private var pane = EventsPaneState()

    var body: some View {
        AutosaveSplitView(autosaveName: "AgentShark.ComparePanes", vertical: true, panes: [
            SplitPane(id: "main", minimum: 480, accessibilityLabel: "Compare") { main },
            SplitPane(id: "inspect", minimum: 360, initial: 400, holdingPriority: .init(255), isCollapsed: !model.showDerivedInspector,
                      accessibilityLabel: "Event detail and raw source") {
                VStack(spacing: 0) {
                    InspectorSideBar(model: model, compare: compare)
                    DerivedInspector(model: model, pane: pane)
                }
            },
        ])
        .sheet(item: $pane.longText) { item in LongTextSheet(item: item, api: model.engine.api) }
    }
}

/// The inspector's pane header: "A | B" and the chosen run's title for a paired row, or the one run that has the action.
private struct InspectorSideBar: View {
    let model: WindowModel
    @Bindable var compare: CompareModel

    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    var body: some View {
        HStack(spacing: 8) {
            if let row = compare.selectedRow, let result = compare.result {
                if row.isPaired {
                    Picker("Run", selection: Binding(get: { compare.side }, set: { compare.choose($0) })) {
                        Text("A").tag(CompareSide.a)
                        Text("B").tag(CompareSide.b)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .help("The run whose action the inspector shows (← and →)")
                } else {
                    Text(AnalysisVocabulary.statusWord(row.status)).fontWeight(.semibold)
                }
                let run = CompareRun(id: result.run(compare.side).session, result: result, catalog: model.sessionsByID)
                Text(run.name).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail).help(run.help)
            } else {
                Text("Select a row to inspect its action.").foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .font(Theme.fontSwiftUI(.rowSecondary, model.app.preferences.rowDensity))
        .controlSize(metrics.swiftUIControlSize)
        .padding(.horizontal, 12)
        .frame(height: metrics.workspaceHeader)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}

// MARK: - States (§5.13)

/// The comparison, or the state that stands in for it: the engine starting, the alignment loading, or the engine's
/// refusal. A result already in the window's cache shows at once, also while the engine restarts.
private struct CompareMain: View {
    @Bindable var model: WindowModel
    let compare: CompareModel
    let request: AnalysisRequest<DiffResult>

    var body: some View {
        if let result = request.value, let key = request.key {
            CompareResult(model: model, compare: compare, request: request, result: result)
                .onAppear { show(result, key) }
                .onChange(of: "\(key)|\(result.coverage.snapshotAt)") { _, _ in show(result, key) }
        } else {
            Group {
                switch request.current?.phase {
                case .failed(let e)?:
                    failure(e)
                case .loading?, .loaded?:
                    loading
                case .idle?, nil:
                    if request.isWaitingForEngine { EngineStateView(engine: model.engine) } else { loading }
                }
            }
            // No alignment shows (another pair or other options are loading, or the engine refused them), so ⌘↩ and Go ▸
            // Next and Previous Difference Region have no rows to act on.
            .onAppear { Self.clear(model: model, compare: compare, key: request.key) }
        }
    }

    /// Let go of the alignment: the comparison drops its rows and selection, and the window its region navigator.
    static func clear(model: WindowModel, compare: CompareModel, key: String?) {
        compare.show(nil, key: key)
        if model.differenceRegions === compare { model.differenceRegions = nil }
    }

    /// A timeout's ways forward (§5.13): the same request again, or a smaller one.
    @ViewBuilder private var timeoutActions: some View {
        Button("Retry") { request.retry() }.keyboardShortcut(.defaultAction)
        if model.compare.subagents { Button("Retry Without Subagents") { model.compare.subagents = false } }
        if model.compare.limit != 500 { Button("Retry With 500 Actions per Run") { model.compare.limit = 500 } }
    }

    private func show(_ result: DiffResult, _ key: String) {
        compare.show(result, key: key)
        model.differenceRegions = compare
    }

    private var loading: some View {
        LoadingStateView(title: "Aligning the runs")
    }

    @ViewBuilder private func failure(_ e: APIError) -> some View {
        let f = CompareFailure(e, sides: model.compareSides)
        switch f {
        case .indexNotReady:
            ContentUnavailableView {
                Label(f.title, systemImage: "hourglass")
            } description: {
                VStack(spacing: 4) {
                    Text("The alignment starts by itself once indexing finishes.")
                    Text(model.store.statusTitle).font(.callout).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .timeout:
            ContentUnavailableView {
                Label(f.title, systemImage: "exclamationmark.triangle")
            } description: {
                Text("The engine stopped the job and restarted a query worker; the Events table may reload. Your selection is preserved.")
            } actions: {
                // Side by side when they fit, else stacked; never cut (DESIGN.md §3.5).
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { timeoutActions }.fixedSize()
                    VStack(spacing: 8) { timeoutActions }.fixedSize()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .runGone(let side):
            ContentUnavailableView {
                Label(f.title, systemImage: "questionmark.folder")
            } description: {
                Text("Select another run in the sidebar, or choose one to compare with the run that remains.")
            } actions: {
                if let side, let sides = model.compareSides {
                    Button("Choose Another Run") { model.openSessions([side == .a ? sides.b : sides.a]) }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .treeLimit, .rowLimit:
            ContentUnavailableView(f.title, systemImage: "exclamationmark.triangle",
                                   description: Text("Compare these runs without their subagents, or choose smaller runs."))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notServed:
            ContentUnavailableView {
                Label(f.title, systemImage: SessionMode.compare.symbol)
            } description: {
                Text("This engine predates the run alignment (AgentDiff). Steps, Transcript and Flow still work.")
            } actions: {
                Button("Show Steps") { model.sessionMode = .steps }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .other:
            FailedStateView(title: f.title, message: "Your selection is preserved.", error: e) { request.retry() }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - The comparison

private struct CompareResult: View {
    @Bindable var model: WindowModel
    @Bindable var compare: CompareModel
    let request: AnalysisRequest<DiffResult>
    let result: DiffResult
    @State private var overviewHeight: CGFloat = 0

    private var density: Preferences.RowDensity { model.app.preferences.rowDensity }

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                if request.isStale || request.isRefreshing { staleBar }
                CompareEvidenceLine(model: model, result: result)
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        // Read as the pane resizes, so the window's height still decides while no one has used the disclosure.
                        // The grid lays out in the pane's width less the padding, never in a width it measures of itself.
                        RunSummaryGrid(model: model, result: result, compare: compare,
                                       openByDefault: RunSummaryGrid.opensByDefault(windowHeight: model.hostWindow?.contentView?.bounds.height),
                                       width: max(0, geo.size.width - 32))
                        Divider()
                        DivergenceCard(model: model, result: result, compare: compare)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { overviewHeight = $0 }
                }
                .scrollShadows()
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                // The overview takes its content's height up to 58% of the pane, so the table keeps the rest (DESIGN.md
                // §8.7); beyond that it scrolls inside itself. At 1280 × 800 that holds the grid and the divergence card.
                // Without aligned rows there is no table, and the divergence card's title says so (§5.13 No actions).
                .frame(height: result.alignment.isEmpty ? nil : min(overviewHeight, max(160, geo.size.height * 0.58)))
                if !result.alignment.isEmpty {
                    Divider()
                    AlignmentChips(model: model, compare: compare, result: result)
                    ZStack {
                        AlignmentTable(model: model, compare: compare)
                        if compare.key == request.key, compare.items.allSatisfy({ $0.rowPosition == nil }) {
                            ContentUnavailableView {
                                Label("No row matches", systemImage: "line.3.horizontal.decrease")
                            } description: {
                                Text("No aligned row has the statuses these chips and Only Differences keep.")
                            } actions: {
                                Button("Show Every Row") { compare.filter = AlignmentFilter() }
                            }
                            .background(Color(nsColor: .controlBackgroundColor))
                        }
                    }
                    CompareSelectionBar(model: model, compare: compare)
                }
            }
            // Nothing inside may widen the pane past its divider: a wider part would centre the rest in its width.
            .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
            .clipped()
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    /// "Run changed since this analysis · Refresh" (§4.1): nothing recomputes until Refresh.
    private var staleBar: some View {
        HStack(spacing: 8) {
            if request.isRefreshing {
                ProgressView().controlSize(.small)
                Text("Aligning the runs again…")
            } else {
                Image(systemName: "clock.badge.exclamationmark").foregroundStyle(Theme.warn.swiftUI).accessibilityHidden(true)
                Text("Run changed since this analysis")
                Button("Refresh") { request.refresh() }
                    .help("Align the runs again with their new activity")
            }
            Spacer(minLength: 0)
        }
        .font(Theme.fontSwiftUI(.rowSecondary, density))
        .controlSize(model.app.preferences.metrics.swiftUIControlSize)
        .padding(.horizontal, 12)
        .frame(height: model.app.preferences.metrics.workspaceHeader)
        .background(Theme.warn.swiftUI.opacity(0.08))
        .overlay(alignment: .bottom) { Divider() }
    }
}

/// Compare's evidence line (§5.8 Placement), the shared `EvidenceLine`: the gaps of this alignment beyond the caveat
/// line's, the action-limit button when the engine cut a run, and what the engine read. A click lists every gap, the
/// engine's caveats and the rule.
private struct CompareEvidenceLine: View {
    let model: WindowModel
    let result: DiffResult

    private var coverage: String {
        CompareText.eventsRead(result.coverage) + " · Times " + Formatters.offsetLabel(at: CompareText.timesMoment(result, catalog: model.sessionsByID))
    }

    /// §5.13 `action-limit`: the engine cut a run, and a larger limit is left to ask for.
    private var action: EvidenceLineAction? {
        guard result.coverage.gaps.contains(.actionLimit), (model.compare.limit ?? 1500) < 2000 else { return nil }
        let model = self.model
        return .init(title: "Compare Up to 2,000 Actions", help: "Align up to 2,000 actions of each run; a larger alignment takes longer") {
            model.compare.limit = 2000
        }
    }

    var body: some View {
        let c = result.coverage
        func gaps(_ codes: [WorkbenchGap]) -> [EvidencePopover.Gap] {
            codes.map { EvidencePopover.Gap(code: $0, text: AnalysisVocabulary.gapText($0, note: c.note($0))) }
        }
        return EvidenceLine(headline: CompareText.dataGapHeadline(c) ?? CompareText.noDataGaps,
                            spoken: AnalysisVocabulary.gapsSpoken(CompareText.dataGapSentences(c), none: CompareText.noDataGaps) + " " + coverage,
                            coverage: coverage, coverageHelp: "Events of the two runs the engine read; times show in this offset", action: action,
                            help: "Show every data gap, the engine's caveats and the alignment rule",
                            hint: "Shows every data gap, the caveats and the alignment rule", metrics: model.app.preferences.metrics) {
            // The gaps found in this data; what holds for every comparison, the permanent gaps, leads the caveats.
            EvidencePopover(gaps: gaps(CompareText.dataGaps(c)), caveatGaps: gaps(CompareText.permanentGaps(c)), caveats: result.caveats,
                            notes: [.init(text: AnalysisVocabulary.ruleLine(result.method),
                                          help: "Behavior counts: rules " + result.rules.filter { $0 != result.method }.joined(separator: ", "))])
        }
    }
}

// MARK: - Chips (§5.9)

/// "1,299 aligned rows:" and a toggle chip per status with rows, then the ambiguous chip. Chips filter the table and
/// combine with Only Differences; a status with no rows hides its chip unless it is on.
private struct AlignmentChips: View {
    let model: WindowModel
    @Bindable var compare: CompareModel
    let result: DiffResult

    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    private func count(_ s: AlignmentStatus) -> Int {
        let m = result.summary
        switch s {
        case .same: return m.same
        case .outcomeDiffers: return m.outcomeDiffers
        case .objectDiffers: return m.objectDiffers
        case .leftOnly: return m.leftOnly
        case .rightOnly: return m.rightOnly
        default: return 0
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            // Narrow panes keep each chip whole with its symbol and a short noun, "‹ 23 only A", its full words in its
            // tooltip and accessibility label; then (the inspector open at 1280) the lead goes, as the header counts the
            // aligned rows already; narrower still, the chips fold into one Filter menu, never cut (DESIGN.md §3.5). A
            // short noun never shows without its symbol, which ties the chip to the status column's marks.
            ViewThatFits(in: .horizontal) {
                chips(compact: false)
                chips(compact: true)
                chips(compact: true, showsLead: false)
                filterMenu
            }
            Spacer(minLength: 8)
            if !compare.hiddenColumns.isEmpty {
                Text(ColumnFit.hiddenText(compare.hiddenColumns.count))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .help("Columns that do not fit this width: " + compare.hiddenColumns.joined(separator: ", ")
                          + ". Widen the window or hide the inspector to show them.")
            }
        }
        .font(Theme.fontSwiftUI(.rowSecondary, model.app.preferences.rowDensity))
        .controlSize(metrics.swiftUIControlSize)
        .padding(.horizontal, 12)
        .frame(height: metrics.workspaceHeader)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// "1,299 aligned rows:", or `compact` "1,299 aligned:"; its tooltip is the chips' legend.
    private func lead(compact: Bool) -> some View {
        Text(compact ? Formatters.count(result.alignedRows) + " aligned:" : Formatters.count(result.alignedRows, "aligned row") + ":")
            .fontWeight(.semibold)
            .padding(.trailing, 2)
            .help(Formatters.count(result.alignedRows, "aligned row") + ": " + CompareText.legend)
    }

    private func status(_ s: AlignmentStatus) -> Binding<Bool> {
        Binding(get: { compare.filter.statuses.contains(s) }, set: { v in
            if v { compare.filter.statuses.insert(s) } else { compare.filter.statuses.remove(s) }
        })
    }

    /// Why a chip cannot narrow the rows: no row has its status, or Only Differences already hides the same rows.
    private func unavailable(_ s: AlignmentStatus) -> (none: Bool, hidden: Bool) {
        (count(s) == 0 && !compare.filter.statuses.contains(s), s == .same && compare.filter.onlyDifferences)
    }

    private func chips(compact: Bool, showsLead: Bool = true) -> some View {
        HStack(spacing: 6) {
            if showsLead { lead(compact: compact) }
            // Every status has its chip, "0 same" included: a count of none is often the pair's most telling figure.
            ForEach(AnalysisVocabulary.statuses, id: \.self) { s in
                let on = compare.filter.statuses.contains(s)
                let words = AnalysisVocabulary.chip(s, count: count(s))
                let (none, hidden) = unavailable(s)
                Toggle(isOn: status(s)) {
                    HStack(spacing: 3) {
                        // A status no row has draws no severity color: "0 different outcome" warns of nothing.
                        Image(systemName: AnalysisVocabulary.statusSymbol(s))
                            .foregroundStyle(Color(nsColor: none ? .tertiaryLabelColor : AnalysisVocabulary.statusColor(s)))
                            .accessibilityHidden(true)
                        Text(compact ? CompareText.shortChip(s, count: count(s)) : words).monospacedDigit()
                    }
                }
                .toggleStyle(.button)
                .disabled(none || hidden)
                .help((compact ? words + ". " : "")
                      + (none ? "No aligned row has this status" : hidden ? "Only Differences hides the same rows"
                         : on ? "Click to show every status again" : "Click to show only these rows"))
                .accessibilityLabel(words)
            }
            if result.summary.ambiguous > 0 || compare.filter.ambiguousOnly {
                Divider().frame(height: 14).padding(.horizontal, compact ? 1 : 4)
                let words = AnalysisVocabulary.ambiguousChip(count: result.summary.ambiguous)
                Toggle(isOn: $compare.filter.ambiguousOnly) {
                    HStack(spacing: 3) {
                        // The mark these rows carry in the status column, as the gutter draws it.
                        Text(AnalysisVocabulary.confidenceMark(.candidate)).foregroundStyle(.secondary).accessibilityHidden(true)
                        Text(words).monospacedDigit()
                    }
                }
                .toggleStyle(.button)
                .help(CompareText.ambiguousHelp)
                .accessibilityLabel(words)
            }
        }
        .fixedSize()
    }

    /// The chips folded into one menu of the same toggles, for a pane too narrow for the short chips; its label says
    /// how many are on.
    private var filterMenu: some View {
        let on = compare.filter.statuses.count + (compare.filter.ambiguousOnly ? 1 : 0)
        return HStack(spacing: 6) {
            lead(compact: true)
            Menu(on == 0 ? "Filter" : "Filter (\(on) on)") {
                ForEach(AnalysisVocabulary.statuses, id: \.self) { s in
                    let (none, hidden) = unavailable(s)
                    Toggle(AnalysisVocabulary.chip(s, count: count(s)), isOn: status(s)).disabled(none || hidden)
                }
                if result.summary.ambiguous > 0 || compare.filter.ambiguousOnly {
                    Divider()
                    Toggle(AnalysisVocabulary.ambiguousChip(count: result.summary.ambiguous), isOn: $compare.filter.ambiguousOnly)
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Show only the rows of the statuses you choose")
        }
        .fixedSize()
    }
}

// MARK: - Selection bar (§5.12)

/// Compare's selection bar (§5.12), the shared `SelectionBar` at the bottom of the pane: the selected row in words,
/// "Row 21 · Different outcome · A · pytest -q tests/test_b.py" with the test symbol before the command, and every
/// action on it as a button, so none exists only in the context menu: Show A in Events, Show B in Events, Show in Session and Show in Timeline for the
/// chosen run, Copy Event ID, and Clear Filter when the filter or time range hides the event from the event view. The
/// buttons fold into one Actions menu when narrow.
private struct CompareSelectionBar: View {
    @Bindable var model: WindowModel
    @Bindable var compare: CompareModel

    var body: some View {
        SelectionBar(sentence: compare.selectionSentence, placeholder: "No row selected", metrics: model.app.preferences.metrics) {
            buttons
        }
    }

    /// Each disabled action says why, as Critical Path's do: nothing is selected, or the selection has no event.
    @ViewBuilder private var buttons: some View {
        let row = compare.selectedRow
        let action = compare.selectedAction
        let none = { (side: CompareSide) in row == nil ? "Select a row first" : "Run \(side.letter) has no action in this row" }
        ForEach(CompareSide.allCases, id: \.self) { side in
            let a = row?.action(side)
            Button("Show \(side.letter) in Events") { if let a { model.select(event: a.eventID, reveal: true) } }
                .disabled(a == nil)
                .help(a == nil ? none(side) : "Select run \(side.letter)'s action in Events")
        }
        Button("Show in Session") { compare.showInSession() }
            .disabled(action == nil)
            .help(action == nil ? none(compare.side) : "Run \(compare.side.letter)'s step in Session · Steps (⌘↩)")
        Button("Show in Timeline") { compare.showInTimeline() }
            .disabled(action == nil)
            .help(action == nil ? none(compare.side) : "Run \(compare.side.letter)'s action in the Timeline")
        Button("Copy Event ID") { if let action { AppKitHelpers.copy(action.eventID) } }
            .disabled(action == nil)
            .help(action == nil ? none(compare.side) : "Copy the ID of run \(compare.side.letter)'s event")
        if let action, model.selectedEvent == action.eventID, model.selectedRow == nil, model.view != nil {
            if !model.appliedFilter.isEmpty {
                Button("Clear Filter") { model.clearFilter() }
                    .help("The filter hides this event from the event view")
            }
            if model.scope.hasTimeRange {
                Button("Clear Time Range") { model.clearTimeScope() }
                    .help("The time range hides this event from the event view")
            }
        }
    }
}
