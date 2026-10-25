import SwiftUI

/// Session · Critical Path (ANALYSIS-UX §4): the chain of waits that set one run's length, from the engine's AgentPerf
/// analysis. It analyses the whole run, so the filter and time range do not apply. The main pane reads from the top:
/// the evidence line, the notices, the verdict over the class breakdown, the path track, and the tables, which fill to
/// the bottom; the selection's detail and raw panes sit beside it (⌥⌘I), as in Steps.
struct CriticalPathWorkspace: View {
    @Bindable var model: WindowModel

    private var perf: AnalysisRequest<PerfResult> { model.analyses.perf }
    private var cp: CriticalPathModel { CriticalPathModel.of(model) }
    private var spec: AnalysisSpec<PerfResult>? { model.criticalPathSession.map { AnalysisSpec.perf(session: $0) } }

    var body: some View {
        VStack(spacing: 0) {
            // Fit joins − and + where the row has room for it beside the whole label (1440 pt); otherwise it is in
            // Options, and the header folds as every mode's does (Decision 4).
            ViewThatFits(in: .horizontal) {
                header(controls(.wide), folded: controls(.wide))
                header(controls(.inline), folded: controls(.folded))
            }
            if model.criticalPathSession == nil {
                ContentUnavailableView("No session selected", systemImage: SessionMode.criticalPath.symbol,
                                       description: Text("Select a session in the sidebar to see its critical path."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                CriticalPathPanes(model: model, cp: cp, content: content) { main }
            }
        }
        .onAppear {
            perf.want(spec)
            perf.isVisible = true
            cp.show(key: perf.key, content: content)
        }
        .onDisappear { perf.isVisible = false }
        .onChange(of: model.criticalPathSession) { perf.want(spec) }
        // A Refresh brings a new result under the same key, whose segments and rows can sit at other indexes.
        .onChange(of: resultKey) { cp.show(key: perf.key, content: content) }
        .task(id: followKey) { follow() }
    }

    /// The shown result: its key and when the engine computed it.
    private var resultKey: String {
        (perf.key ?? "") + "|" + (perf.value.map { String($0.coverage.snapshotAt) } ?? "")
    }

    /// The shown result's content; nil until a result arrives.
    private var content: CriticalPathContent? {
        guard let r = perf.value, let key = perf.key else { return nil }
        return cp.content(r, key: key)
    }

    /// "Critical path · {title}" until the result arrives and for a path with no length, then "11m 30s critical path · 5
    /// of 37 sessions on the path", or "Subagent run · 4 sessions" for a subagent's subtree (§4.3).
    private var label: String {
        let lead = model.criticalPathSession.map { "Critical path · " + model.runLabel(of: $0) } ?? model.sessionScopeLabel(.criticalPath)
        guard let r = perf.value else { return lead }
        let wall = r.criticalPath.wallUs.flatMap { $0 > 0 ? $0 : nil }
        let subagent = cp.isSubagent(r.sessionId, result: r)
        guard wall != nil || subagent else { return lead }
        return WindowModel.criticalPathScopeLabel(wallUs: wall, sessionsOnPath: r.criticalPath.bySession.count, sessions: r.coverage.sessionIds.count,
                                                  subagent: subagent)
    }

    private func header(_ controls: HeaderControls, folded: HeaderControls) -> some View {
        WorkspaceHeader(model: model, label: label, labelHelp: model.sessionScopeHelp(.criticalPath)) {
            SessionModeSwitch(model: model)
        } controls: {
            controls
        } folded: {
            folded
        }
    }

    private func controls(_ form: HeaderControls.Form) -> HeaderControls {
        let session = perf.value?.sessionId ?? model.criticalPathSession
        let wholeRun: (() -> Void)? = session.flatMap { id in
            cp.isSubagent(id, result: perf.value) ? { cp.showWholeRun(of: id, sessions: perf.value?.sessions) } : nil
        }
        return HeaderControls(model: model, form: form, zoom: cp.hasTrack && content?.isEmpty == false ? { cp.zoom($0) } : nil,
                              mergeShort: Binding(get: { cp.mergeShort }, set: { cp.mergeShort = $0 }), wholeRun: wholeRun)
    }

    // MARK: States (§4.11)

    @ViewBuilder private var main: some View {
        if let content {
            CriticalPathReport(model: model, cp: cp, perf: perf, content: content)
        } else if perf.isWaitingForEngine {
            EngineStateView(engine: model.engine)
        } else {
            switch perf.phase {
            case .idle, .loading, .loaded:
                CriticalPathLoadingView(large: (model.criticalPathSession.flatMap { model.store.sessionsByID[$0]?.nEvents } ?? 0) > 50_000)
            case .failed(let e):
                CriticalPathFailure(model: model, error: e) { perf.retry() }
            }
        }
    }

    // MARK: Events selected elsewhere (§4.10)

    private var followKey: String {
        [resultKey, model.selectedEvent ?? "", model.eventDetail?.event.id ?? ""].joined(separator: "|")
    }

    private func follow() {
        guard let content else { return }
        let detail = model.eventDetail?.event.id == model.selectedEvent ? model.eventDetail : nil
        cp.follow(event: model.selectedEvent, session: detail?.event.session, ts: detail?.event.ts, in: content)
    }
}

/// The failures of §4.11: the index is not ready (it runs again by itself), the engine is too old, the analysis timed
/// out (Retry), the run is past the session-tree or row limit or gone from the index (no Retry), or anything else (Retry).
struct CriticalPathFailure: View {
    let model: WindowModel
    let error: APIError
    let retry: () -> Void

    var body: some View {
        let e = error
        if e.isWorkbenchUnavailable {
            ContentUnavailableView {
                Label("Critical Path needs the finished index.", systemImage: "hourglass")
            } description: {
                Text(indexingNote)
            }
        } else if e.isWorkbenchNotServed {
            ContentUnavailableView {
                Label("Critical Path needs a newer engine.", systemImage: SessionMode.criticalPath.symbol)
            } description: {
                Text("This engine does not run the critical-path analysis. Steps shows the run's time by bucket.")
            } actions: {
                Button("Show Steps") { model.sessionMode = .steps }
            }
        } else {
            switch e.workbenchCode {
            case .timeout?:
                FailedStateView(title: "Analysis took longer than 30s.",
                                message: "The engine stopped the job and restarted a query worker; the Events table may reload. Your selection is preserved.",
                                error: nil, retry: retry)
            case .sessionTreeLimit?:
                ContentUnavailableView("This run has more than 500 sessions, the analysis limit.", systemImage: "square.stack.3d.up.slash",
                                       description: Text("Critical Path of one of its subagents stays within the limit."))
            case .sessionNotFound?:
                ContentUnavailableView("This session is no longer in the index.", systemImage: "questionmark.folder",
                                       description: Text("It may have been removed or re-indexed. Select another session in the sidebar."))
            case .rowLimit?:
                ContentUnavailableView(e.message, systemImage: "tablecells.badge.ellipsis")
            default:
                FailedStateView(title: "Could not load this analysis.", error: e, retry: retry)
            }
        }
    }

    /// The index's progress while the engine refuses analyses; the request runs again by itself after the index run.
    private var indexingNote: String {
        if case .indexing = model.store.liveStatus {
            return model.store.statusTitle + ". The analysis runs by itself when indexing finishes."
        }
        return "The analysis runs by itself when the next index run finishes."
    }
}

extension CriticalPathWorkspace {
    /// What the track's zoom controls ask for; they act on the track only (§4.3).
    enum Zoom { case out, `in`, fit }

    /// The header's controls (§4.3): Show Whole Run when a subagent is analysed, the session picker when several
    /// sessions are in scope, Zoom Out, Zoom In and Fit, the Inspector toggle, and Options with Merge Segments Shorter
    /// Than 1s. `LayoutFitTests` measures each form.
    struct HeaderControls: View {
        /// `wide` has Fit inline; `inline` moves it into Options, so the row keeps the session picker, Inspector and the
        /// labelled Options menu inline at 1280 pt in both densities; `folded` is one Options menu, so the mode switch
        /// never folds (Decision 4).
        enum Form { case wide, inline, folded }

        @Bindable var model: WindowModel
        var form = Form.inline
        /// Zooms the track; nil while no track shows, which disables the zoom controls.
        var zoom: ((Zoom) -> Void)? = nil
        /// Options ▸ Merge Segments Shorter Than 1s; nil disables it.
        var mergeShort: Binding<Bool>? = nil
        /// Show Whole Run (§4.3); nil unless the analysed session is a subagent.
        var wholeRun: (() -> Void)? = nil

        init(model: WindowModel, form: Form = .inline, zoom: ((Zoom) -> Void)? = nil, mergeShort: Binding<Bool>? = nil,
             wholeRun: (() -> Void)? = nil) {
            self.model = model
            self.form = form
            self.zoom = zoom
            self.mergeShort = mergeShort
            self.wholeRun = wholeRun
        }

        init(model: WindowModel, folded: Bool) {
            self.init(model: model, form: folded ? .folded : .inline)
        }

        static let mergeTitle = "Merge Segments Shorter Than 1s"
        private static let mergeHelp = "Draw segments shorter than a second as one neutral mark; the Segments table keeps every segment"
        private static let fitHelp = "Fit the whole path in the track (⌘0)"

        var body: some View {
            if form == .folded {
                Menu("Options") {
                    if let wholeRun { Button("Show Whole Run", action: wholeRun) }
                    SessionPicker(model: model, inMenu: true)
                    Button("Zoom Out") { zoom?(.out) }.disabled(zoom == nil)
                    Button("Zoom In") { zoom?(.in) }.disabled(zoom == nil)
                    Button("Fit") { zoom?(.fit) }.disabled(zoom == nil)
                    Divider()
                    merge
                    Toggle("Inspector", isOn: $model.showDerivedInspector)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .background { keys }
            } else {
                if let wholeRun {
                    Button("Show Whole Run", action: wholeRun)
                        .help("Critical Path of the top-level run this subagent belongs to")
                }
                SessionPicker(model: model)
                ControlGroup {
                    Button { zoom?(.out) } label: { Image(systemName: "minus") }
                        .iconHelp("Zoom Out (⌘−)")
                    Button { zoom?(.in) } label: { Image(systemName: "plus") }
                        .iconHelp("Zoom In (⌘+)")
                }
                .fixedSize()
                .disabled(zoom == nil)
                .background { keys }
                if form == .wide {
                    Button("Fit") { zoom?(.fit) }
                        .disabled(zoom == nil)
                        .help(Self.fitHelp)
                }
                Toggle("Inspector", isOn: $model.showDerivedInspector).toggleStyle(.checkbox)
                    .help("The selected mark's event detail and raw source (⌥⌘I)")
                Menu("Options") {
                    if form != .wide {
                        Button("Fit") { zoom?(.fit) }
                            .disabled(zoom == nil)
                            .help(Self.fitHelp)
                        Divider()
                    }
                    merge
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help(form == .wide ? "How the track draws short segments" : "Fit the path in the track, and how the track draws short segments")
            }
        }

        /// ⌘−, ⌘+ and ⌘0, as the Timeline binds them, in every form: on buttons that draw nothing and take no room, so
        /// the keys work whether the zoom controls are inline or folded into Options.
        private var keys: some View {
            ZStack {
                Button("Zoom Out") { zoom?(.out) }.keyboardShortcut("-", modifiers: .command)
                Button("Zoom In") { zoom?(.in) }.keyboardShortcut("=", modifiers: .command)
                Button("Fit") { zoom?(.fit) }.keyboardShortcut("0", modifiers: .command)
            }
            .disabled(zoom == nil)
            .opacity(0)
            .frame(width: 0, height: 0)
            .focusable(false)
            .accessibilityHidden(true)
        }

        private var merge: some View {
            Toggle(Self.mergeTitle, isOn: mergeShort ?? .constant(false))
                .disabled(mergeShort == nil)
                .help(Self.mergeHelp)
        }
    }
}

// MARK: - Panes

/// The detail column, laid out like Steps (§4.2): the main pane, then the selection's detail and raw panes, which ⌥⌘I
/// shows. A mark no event marks has no detail to show, so the inspector says so and offers Show in Timeline (§4.10).
struct CriticalPathPanes<Main: View>: View {
    @Bindable var model: WindowModel
    let cp: CriticalPathModel
    let content: CriticalPathContent?
    @ViewBuilder var main: Main
    @State private var pane = EventsPaneState()

    var body: some View {
        AutosaveSplitView(autosaveName: "AgentShark.CriticalPathPanes", vertical: true, panes: [
            SplitPane(id: "main", minimum: 420, accessibilityLabel: "Critical path") { main },
            SplitPane(id: "inspect", minimum: 360, initial: 400, holdingPriority: .init(255), isCollapsed: !model.showDerivedInspector,
                      accessibilityLabel: "Event detail and raw source") { inspector },
        ])
        .sheet(item: $pane.longText) { item in LongTextSheet(item: item, api: model.engine.api) }
    }

    @ViewBuilder private var inspector: some View {
        if let content, let t = cp.target(in: content), t.evidence == nil {
            PerfNoEventInspector(cp: cp, target: t, metrics: model.app.preferences.metrics)
        } else {
            DerivedInspector(model: model, pane: pane)
        }
    }
}

/// The inspector for a selection no event marks: a gap between turns, idle or unattributed time, a subagent's span, or
/// a rework finding the engine found none of.
struct PerfNoEventInspector: View {
    let cp: CriticalPathModel
    let target: PerfTarget
    let metrics: Theme.Metrics

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Detail").font(Theme.fontSwiftUI(.paneTitle))
                Spacer()
            }
            .padding(.horizontal, 12)
            .frame(height: metrics.paneHeader)
            Divider()
            message
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
        }
    }

    @ViewBuilder private var message: some View {
        switch target.kind {
        case .delegation:
            ContentUnavailableView {
                Label(target.title, systemImage: "person.2")
            } description: {
                Text(target.detail + "\nNo one event stands for a subagent; its own Critical Path and Steps show its work.")
            } actions: {
                if let sub = target.subagent { Button("Open Subagent") { cp.openSubagent(sub) } }
                timeline
            }
        case .rework where target.range == nil:
            // "No rereads found in this run.": no time to show in the Timeline either.
            ContentUnavailableView(target.title, systemImage: "arrow.triangle.2.circlepath",
                                   description: target.detail.isEmpty ? nil : Text(target.detail))
        default:
            ContentUnavailableView {
                Label("No event marks this time.", systemImage: "clock")
            } description: {
                Text([target.title, target.detail].filter { !$0.isEmpty }.joined(separator: "\n"))
            } actions: {
                timeline
            }
        }
    }

    private var timeline: some View {
        Button("Show in Timeline") { cp.showInTimeline(target) }
            .disabled(target.range == nil)
    }
}

// MARK: - Report

/// The analysis once its result arrived: everything below the header in the main pane.
struct CriticalPathReport: View {
    @Bindable var model: WindowModel
    @Bindable var cp: CriticalPathModel
    let perf: AnalysisRequest<PerfResult>
    let content: CriticalPathContent
    @State private var width: CGFloat = 0

    static let mergeBelowUs: Int64 = 1_000_000
    /// The partial-window warning's Show Steps.
    static let partialStepsHelp = "Steps lists every step of this session, not only the events this analysis read"

    var body: some View {
        VStack(spacing: 0) {
            PerfEvidenceLine(content: content, notOnPath: cp.notOnPath != nil, metrics: model.app.preferences.metrics)
            // Sending Refresh records the run's new end at once, so the request is no longer stale while it runs: the
            // bar stays, with its spinner, until the new result replaces this one.
            if perf.isRefreshing {
                PerfNotice(symbol: "clock.arrow.circlepath", text: "Following the critical path again…", busy: true)
            } else if perf.isStale {
                PerfNotice(symbol: "clock.arrow.circlepath", text: "Run changed since this analysis", action: "Refresh") {
                    perf.refresh()
                }
            }
            // The one statement of the partial window: the evidence line leaves its gaps out (§4.5). The engine analyses
            // at most 50,000 events of a run and takes no wider window, so the way to the rest is Steps.
            if let partial = content.partialWindow {
                PerfNotice(symbol: "exclamationmark.triangle.fill", text: partial, action: "Show Steps", actionHelp: Self.partialStepsHelp) {
                    model.sessionMode = .steps
                }
            }
            if content.isEmpty {
                empty
            } else {
                summary
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 14)
                Divider()
                let input = TrackInput(content: content, key: perf.key ?? "", showsAllLanes: cp.showsAllLanes,
                                       mergeBelowUs: cp.mergeShort ? Self.mergeBelowUs : nil, classFilter: cp.classFilter, target: cp.target(in: content))
                CriticalPathTrack(cp: cp, input: input)
                    .frame(height: criticalPathTrackHeight(rows: input.rows.count))
                Divider()
                PerfTablesPane(model: model, cp: cp, content: content)
                    .frame(minHeight: 140)
                // At the bottom of the pane, as in Compare (§4.10, §5.12).
                PerfSelectionBar(cp: cp, target: cp.target(in: content), metrics: model.app.preferences.metrics)
            }
        }
        // Nothing inside may widen the pane past its divider: a table scrolls inside itself instead.
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .clipped()
        .background(Color(nsColor: .controlBackgroundColor))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    /// One layout at every width (§4.2): the verdict, the class bar across the pane, then its legend in two columns
    /// when they fit, else one.
    private var summary: some View {
        VStack(alignment: .leading, spacing: 12) {
            PathVerdictView(verdict: content.verdict, rule: content.path.bindingSrc.rawValue)
            PathClassBreakdown(content: content, selected: cp.classFilter, columns: PathClassBreakdown.columns(content, width: width - 32)) {
                cp.toggleClass($0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The Empty form (§4.6): the path has no length, so there is no breakdown, track or table to show.
    private var empty: some View {
        ContentUnavailableView {
            Label(content.verdict.lines.first?.text ?? "No timed activity on this run's critical path.", systemImage: SessionMode.criticalPath.symbol)
        } description: {
            Text("Steps lists every event the run recorded.")
        } actions: {
            Button("Show Steps") { model.sessionMode = .steps }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Loading

/// Loading (§4.11, DESIGN.md §7.15): nothing for 150 ms, then the shape of the analysis (verdict, class bar, track) as a
/// skeleton, then its words after a second, with a note for a run past the engine's 50,000-event window.
struct CriticalPathLoadingView: View {
    let large: Bool
    @State private var shown = false
    @State private var worded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if shown {
                VStack(alignment: .leading, spacing: 8) {
                    bar(width: 420, height: 14)
                    bar(width: 300, height: 14)
                    bar(width: nil, height: 8).padding(.top, 8)
                }
                .padding(16)
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(0..<3, id: \.self) { i in
                        HStack(spacing: 12) {
                            bar(width: 140, height: 10)
                            bar(width: nil, height: 12).padding(.trailing, CGFloat(120 * i))
                        }
                    }
                }
                .padding(16)
            }
            if worded {
                VStack(spacing: 4) {
                    Text("Following the critical path…")
                    if large { Text("Large run: this can take a few seconds.") }
                }
                .font(Theme.fontSwiftUI(.metadata))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.top, 24)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .controlBackgroundColor))
        .task {
            try? await Task.sleep(for: .milliseconds(150))
            shown = true
            try? await Task.sleep(for: .milliseconds(850))
            worded = true
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Following the critical path" + (large ? ". Large run: this can take a few seconds." : ""))
    }

    private func bar(width: CGFloat?, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 3)
            .fill(Color(nsColor: .quaternaryLabelColor).opacity(0.5))
            .frame(maxWidth: width ?? .infinity)
            .frame(width: width, height: height)
    }
}
