import SwiftUI

/// A native review flow: findings first, their evidence beside them, and limits in a separate sheet.
struct ReliabilityWorkspace: View {
    @Bindable var model: WindowModel
    @State private var editingLimits = false
    private var state: ReliabilityModel { model.reliabilityModel }
    private var request: AnalysisRequest<ReliabilityResult> { model.analyses.reliability }
    private var session: String? { model.criticalPathSession }
    private var spec: AnalysisSpec<ReliabilityResult>? { session.map { .reliability(session: $0, policy: state.policy) } }
    private var resultKey: String { (request.key ?? "") + "|" + (request.value.map { String($0.coverage.snapshotAt) } ?? "") }

    var body: some View {
        VStack(spacing: 0) {
            WorkspaceHeader(model: model, label: model.sessionScopeLabel(.reliability), labelHelp: model.sessionScopeHelp(.reliability)) {
                SessionModeSwitch(model: model)
            } controls: {
                HeaderControls(model: model, canRefresh: request.value != nil && !request.isRefreshing,
                               configure: { editingLimits = true }, refresh: { request.refresh() })
            } folded: {
                HeaderControls(model: model, folded: true, canRefresh: request.value != nil && !request.isRefreshing,
                               configure: { editingLimits = true }, refresh: { request.refresh() })
            }
            if session == nil {
                ContentUnavailableView("Select a session to check reliability", systemImage: SessionMode.reliability.symbol,
                                       description: Text("Choose a session in the sidebar to review failure handling and repeated observations."))
            } else {
                AnalysisPanes(model: model, autosaveName: "AgentShark.ReliabilityPanes", mainMinimum: 540, accessibilityLabel: "Reliability review") {
                    content
                }
            }
        }
        .sheet(isPresented: $editingLimits) {
            ReliabilityLimitsSheet(policy: state.policy, labels: state.allowedObservationLabels) { state.policy = $0 }
        }
        .onAppear { request.want(spec); request.isVisible = true; synchronize() }
        .onDisappear { request.isVisible = false }
        .onChange(of: spec?.key) { request.want(spec) }
        .onChange(of: resultKey) { synchronize() }
    }

    @ViewBuilder private var content: some View {
        if let result = request.value {
            ReliabilityReport(model: model, state: state, request: request, result: result)
        } else if request.isWaitingForEngine {
            EngineStateView(engine: model.engine)
        } else {
            switch request.phase {
            case .idle, .loading, .loaded: LoadingStateView(title: "Checking failure handling and repeated observations…")
            case .failed(let error):
                if error.isWorkbenchNotServed {
                    ContentUnavailableView("Reliability Checks needs a newer engine", systemImage: SessionMode.reliability.symbol,
                                           description: Text("Rebuild the app to include the reliability analysis."))
                } else if error.isWorkbenchUnavailable {
                    LoadingStateView(title: "Checks will run when indexing finishes…")
                } else if error.workbenchCode == .sessionNotFound || error.workbenchCode == .sessionTreeLimit || error.workbenchCode == .rowLimit {
                    ContentUnavailableView(error.message, systemImage: "exclamationmark.magnifyingglass",
                                           description: Text("Choose another session or one of this run's subagents in the sidebar."))
                } else {
                    FailedStateView(title: "Could not check reliability", error: error) { request.retry() }
                }
            }
        }
    }

    private func synchronize() {
        guard let result = request.value, let key = request.key else { return }
        state.show(result, key: key)
        if let ref = state.selectedEvidence { model.select(event: ref.eventId, reveal: false) }
    }
}

extension ReliabilityWorkspace {
    struct HeaderControls: View {
        @Bindable var model: WindowModel
        var folded = false
        var canRefresh = false
        var configure: () -> Void = {}
        var refresh: () -> Void = {}

        var body: some View {
            if folded {
                Menu("Options") {
                    SessionPicker(model: model, inMenu: true)
                    Button("Limits…", action: configure)
                    Button("Refresh Checks", action: refresh).disabled(!canRefresh)
                    Toggle("Inspector", isOn: $model.showDerivedInspector)
                }.menuStyle(.borderlessButton).fixedSize()
            } else {
                SessionPicker(model: model)
                Button("Limits…", action: configure)
                    .help("Set per-session budgets, repeat thresholds and intentional repetition exemptions")
                Button(action: refresh) { Image(systemName: "arrow.clockwise") }
                    .disabled(!canRefresh).iconHelp("Refresh reliability analysis")
                Toggle("Inspector", isOn: $model.showDerivedInspector).toggleStyle(.checkbox)
                    .help("Event detail and raw source (⌥⌘I)")
            }
        }
    }
}

private struct ReliabilityReport: View {
    @Bindable var model: WindowModel
    @Bindable var state: ReliabilityModel
    let request: AnalysisRequest<ReliabilityResult>
    let result: ReliabilityResult
    @State private var budgetsExpanded = false
    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    var body: some View {
        VStack(spacing: 0) {
            evidenceLine
            if request.isRefreshing {
                PerfNotice(symbol: "arrow.clockwise", text: "Refreshing checks…", busy: true)
            } else if request.isStale {
                PerfNotice(symbol: "clock.arrow.circlepath", text: "Run changed since these checks", action: "Refresh") { request.refresh() }
            }
            overview
            Divider()
            filters
            Divider()
            if state.rows.isEmpty {
                ContentUnavailableView("No matching reliability patterns", systemImage: "checkmark.magnifyingglass",
                                       description: Text("The examined logs contain none of the configured patterns. This does not establish task success; review the data gaps above."))
            } else {
                AutosaveSplitView(autosaveName: "AgentShark.ReliabilityReview", vertical: true, panes: [
                    SplitPane(id: "findings", minimum: 190, initial: 250, accessibilityLabel: "Reliability findings") { findings },
                    SplitPane(id: "finding", minimum: 280, accessibilityLabel: "Finding and evidence") {
                        if let selected = state.selected {
                            ReliabilityFindingDetail(model: model, state: state, finding: selected, metrics: metrics)
                        } else {
                            ContentUnavailableView("No finding selected", systemImage: "line.3.horizontal.decrease",
                                                   description: Text("Change the category or search to find a review item."))
                        }
                    },
                ])
            }
            SelectionBar(sentence: state.selected.map { SelectionSentence(lead: $0.title, parts: ["Needs review"], detail: $0.target) },
                         placeholder: "Select a finding to review its evidence", metrics: metrics) {
                Button("Show in Steps") { state.showInSteps(model) }.disabled(state.selectedEvidence == nil)
                Button("Show in Events") {
                    if let ref = state.selectedEvidence { model.select(event: ref.eventId, reveal: true) }
                }.disabled(state.selectedEvidence == nil)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .onChange(of: state.category) { state.reconcile() }
        .onChange(of: state.search) { state.reconcile() }
        .onChange(of: state.selectedEvidence) {
            if let ref = state.selectedEvidence { model.select(event: ref.eventId, reveal: false) }
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(Formatters.count(result.summary.failureHandlingCandidates + result.summary.repeatedObservationChains, "finding") + " to review")
                    .font(.headline)
                Spacer()
                Text("Whole run · \(Formatters.count(result.coverage.sessionIds.count, "session"))")
                    .font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary)
            }
            DisclosureGroup(isExpanded: $budgetsExpanded) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(result.decisions, id: \.sessionId) { decision in
                            ReliabilityBudgetRow(decision: decision, title: model.runLabel(of: decision.sessionId))
                        }
                    }.padding(.top, 8)
                }.frame(height: min(160, CGFloat(result.decisions.count) * 120))
            } label: {
                let stop = result.decisions.filter { $0.decision == "stop" }.count
                Label(stop > 0 ? Formatters.count(stop, "session") + " reached a stopping threshold" : "Budgets and next-step recommendations",
                      systemImage: stop > 0 ? "pause.circle" : "gauge.with.dots.needle.50percent")
                    .font(Theme.fontSwiftUI(.rowPrimary))
            }
            Text("Review candidates against their evidence. Stopping recommendations are advisory.")
                .font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary)
            if let allowed = state.policy.allowedRepeatCalls, !allowed.isEmpty {
                HStack {
                    Text(Formatters.count(allowed.count, "exact observation") + " allowed in this window")
                        .foregroundStyle(.secondary)
                    if let last = state.lastAllowedObservation, allowed.contains(last) {
                        Button("Undo Last Allow") { state.undoAllowedObservation() }
                    }
                }.font(Theme.fontSwiftUI(.metadata))
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var filters: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { categoryPicker; searchField.frame(width: 160) }
            VStack(alignment: .leading, spacing: 6) { categoryPicker; searchField }
        }
        .controlSize(metrics.swiftUIControlSize)
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
    private var categoryPicker: some View {
        Picker("Findings", selection: $state.category) {
            ForEach(ReliabilityCategory.allCases) { category in Text(category.title + " (\(state.count(category)))").tag(category) }
        }.pickerStyle(.segmented).labelsHidden().fixedSize(horizontal: true, vertical: false)
    }
    private var searchField: some View {
        TextField("Filter findings", text: $state.search).textFieldStyle(.roundedBorder)
            .accessibilityLabel("Filter reliability findings")
    }
    private var findings: some View {
        List(selection: Binding(get: { state.selection }, set: { state.choose($0) })) {
            ForEach(state.visibleRows) { row in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: row.category == .handling ? "exclamationmark.bubble" : "arrow.triangle.2.circlepath")
                            .foregroundStyle(.secondary)
                        Text(row.title).font(Theme.fontSwiftUI(.rowPrimary)).lineLimit(3)
                    }
                    Text(row.target).font(Theme.fontSwiftUI(.rowSecondary).monospaced()).foregroundStyle(.secondary).lineLimit(2)
                    if result.coverage.sessionIds.count > 1 {
                        Text(model.runLabel(of: row.sessionId)).font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .padding(.vertical, 5)
                .tag(row.id)
                .accessibilityLabel(row.title + ". " + row.target + ". Needs review.")
            }
        }.listStyle(.sidebar)
    }

    private var evidenceLine: some View {
        let gaps = result.coverage.gaps.map { code in
            EvidencePopover.Gap(code: code, text: AnalysisVocabulary.gapText(code, note: result.coverage.note(code)))
        }
        let sentences = gaps.map(\.text)
        let coverage = "\(Formatters.count(result.coverage.eventsExamined)) of \(Formatters.count(result.coverage.eventsAvailable)) events"
        return EvidenceLine(headline: AnalysisVocabulary.gapHeadline(sentences), spoken: AnalysisVocabulary.gapsSpoken(sentences, none: "No reported data gaps") + ". " + coverage,
                            coverage: coverage, help: "View coverage, data gaps and detection limits", hint: "Opens evidence coverage", metrics: metrics) {
            EvidencePopover(gaps: gaps, caveats: result.caveats,
                            notes: [.init(text: "Whole run, including subagents. Filter and time range do not apply."),
                                    .init(text: "Analysis " + result.analysisVersion)])
        }
    }
}

private struct ReliabilityFindingDetail: View {
    @Bindable var model: WindowModel
    @Bindable var state: ReliabilityModel
    let finding: ReliabilityFinding
    let metrics: Theme.Metrics

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(finding.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                    Text(finding.target).font(Theme.fontSwiftUI(.rowPrimary).monospaced()).textSelection(.enabled)
                    Label("Needs review", systemImage: "questionmark.circle")
                        .font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary)
                        .help(AnalysisVocabulary.confidenceHelp(.candidate, "a reliability pattern", rule: finding.rule))
                }
                if let r = finding.repetition {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 20) { measurements(r) }
                        VStack(alignment: .leading, spacing: 8) { measurements(r) }
                    }
                }
                detailSection("What Happened", text: finding.explanation)
                detailSection("Suggested Next Step", text: finding.nextStep)
                if finding.repetition?.outcome == "ok" {
                    VStack(alignment: .leading, spacing: 6) {
                        Button("Allow This Observation") { state.allowObservation() }
                            .disabled(!state.canAllowObservation)
                            .help("Allow this tool with the same complete input and successful output in this window. Failed results remain checked. Undo here or remove the allowance in Limits.")
                        Text("For monitoring you have verified. Allows this exact input and successful output; failed calls remain checked.")
                            .font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("EVIDENCE").font(Theme.fontSwiftUI(.sectionLabel)).foregroundStyle(.secondary)
                    Text("Select a record to inspect its event and raw source.").font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary)
                    ForEach(Array(finding.evidence.enumerated()), id: \.offset) { index, ref in
                        Button {
                            state.inspect(ref)
                            model.select(event: ref.eventId, reveal: false)
                            model.showDerivedInspector = true
                        } label: {
                            HStack {
                                Image(systemName: state.selectedEvidence == ref ? "record.circle" : "doc.text.magnifyingglass")
                                Text(finding.evidenceLabel(at: index))
                                Spacer(minLength: 4)
                                if let line = ref.line { Text("Line \(line)").foregroundStyle(.secondary) }
                                Image(systemName: "chevron.right").imageScale(.small).foregroundStyle(.tertiary)
                            }
                            .padding(8)
                            .background(state.selectedEvidence == ref ? Color.accentColor.opacity(0.1) : Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
                        }
                        .buttonStyle(.plain)
                        .help("Inspect \(ref.source), line \(ref.line.map(String.init) ?? Formatters.missing)")
                        .accessibilityLabel(finding.evidenceLabel(at: index) + ". Inspect source.")
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .id(finding.id)
    }
    private func detailSection(_ title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(Theme.fontSwiftUI(.sectionLabel)).foregroundStyle(.secondary)
            Text(text).font(Theme.fontSwiftUI(.rowPrimary)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
    }
    @ViewBuilder private func measurements(_ r: ReliabilityResult.Repetition) -> some View {
        metric("Attempts", value: Formatters.count(r.attempts))
        metric("Elapsed", value: ReliabilityPresentation.duration(r.measurement.wallUs))
        metric("Tool time", value: ReliabilityPresentation.duration(r.measurement.toolUs))
        metric("Tokens", value: ReliabilityPresentation.tokens(r.measurement.tokens))
    }
    private func metric(_ name: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value).font(.headline).monospacedDigit()
            Text(name).font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary)
        }
    }
}

private struct ReliabilityBudgetRow: View {
    let decision: ReliabilityResult.Decision
    let title: String
    var body: some View {
        let budget = decision.budget
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).fontWeight(.medium).lineLimit(1)
                Spacer()
                Text(ReliabilityPresentation.recommendation(decision.decision))
                    .foregroundStyle(decision.decision == "stop" ? Color.orange : Color.secondary)
            }
            Text(decision.reason).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 18) { consumption(budget) }
                VStack(alignment: .leading, spacing: 4) { consumption(budget) }
            }
            if budget.tokenBudget != nil { forecast("Token budget", remaining: budget.forecast.repeatsWithinTokenBudget) }
            if budget.timeBudgetUs != nil { forecast("Time budget", remaining: budget.forecast.repeatsWithinTimeBudget) }
        }.font(Theme.fontSwiftUI(.rowSecondary))
    }
    @ViewBuilder private func consumption(_ budget: ReliabilityResult.Budget) -> some View {
        Text("Tokens: " + (budget.usedTokens == nil && budget.knownTokens > 0 ? "≥" + ReliabilityPresentation.tokens(budget.knownTokens) : ReliabilityPresentation.tokens(budget.usedTokens))
             + (budget.tokenBudget.map { " / " + ReliabilityPresentation.tokens($0) } ?? " · no limit"))
        Text("Elapsed: " + ReliabilityPresentation.duration(budget.usedUs)
             + (budget.timeBudgetUs.map { " / " + ReliabilityPresentation.duration($0) } ?? " · no limit"))
    }
    private func forecast(_ label: String, remaining: Int64?) -> some View {
        Text(label + ": " + (remaining == nil ? "forecast needs at least two measured repeat intervals."
            : ReliabilityPresentation.forecast(remaining) + " at the recent repeat rate."))
            .foregroundStyle(.secondary)
    }
}

private struct ReliabilityLimitsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: ReliabilityPolicyDraft
    let labels: [ReliabilityCallExemption: String]
    let apply: (ReliabilityPolicy) -> Void
    init(policy: ReliabilityPolicy, labels: [ReliabilityCallExemption: String], apply: @escaping (ReliabilityPolicy) -> Void) {
        _draft = State(initialValue: ReliabilityPolicyDraft(policy))
        self.labels = labels
        self.apply = apply
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Reliability Limits").font(.title2.bold())
            Text("Limits apply separately to each session. Recommendations help you decide when to change strategy or pause; AgentShark does not stop the agent.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("Flag repeated calls after", text: $draft.minimum)
                TextField("Recommend stopping after", text: $draft.stop)
                TextField("Token budget", text: $draft.tokens, prompt: Text("No limit"))
                TextField("Time budget (minutes)", text: $draft.minutes, prompt: Text("No limit"))
                TextField("Tools allowed to repeat", text: $draft.allowed, prompt: Text("Comma-separated tool names"))
            }
            Text("Repeated calls require equal complete inputs and outputs with no logged state change. Exempt tools that intentionally poll or sample.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !draft.calls.isEmpty {
                Text("Allowed Observations").font(.headline)
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(draft.calls, id: \.self) { item in
                            HStack {
                                Text(labels[item] ?? item.tool)
                                    .font(.caption).lineLimit(2)
                                Spacer()
                                Button("Remove") { draft.calls.removeAll { $0 == item } }
                                    .accessibilityLabel("Remove allowed observation for " + (labels[item] ?? item.tool))
                            }
                        }
                    }
                }.frame(height: min(160, CGFloat(draft.calls.count) * 48))
            }
            if draft.validated == nil {
                Label("Use 2–100 calls to flag a repeat, a stopping threshold at least that high (up to 1,000), and positive budgets.", systemImage: "exclamationmark.circle")
                    .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Restore Defaults") { draft = ReliabilityPolicyDraft(ReliabilityPolicy()) }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Apply Limits") {
                    if let policy = draft.validated { apply(policy); dismiss() }
                }.keyboardShortcut(.defaultAction).disabled(draft.validated == nil)
            }
        }
        .padding(24).frame(width: 520)
    }
}
