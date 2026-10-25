import AppKit
import SwiftUI

/// The Failures workspace (SPEC §12.7, DESIGN.md §4.5): three chrome rows across the workspace (the workspace header,
/// the facet bar and, under Group by Attention, the section index), then the attention queue, the Lens ("Observed
/// chain") and the detail outline with the raw pane (⌥⌘I) side by side in an `NSSplitView`. Every split saves its
/// position.
struct FailuresWorkspace: View {
    @Bindable var model: WindowModel
    @State private var pane = EventsPaneState()

    private var failures: FailuresModel { model.failures }

    var body: some View {
        VStack(spacing: 0) {
            NotificationOfferBanner(model: model)
            header
            FacetBar(model: model)
            if model.failureFacets.group == .attention, failures.sections.count > 1 {
                SectionIndex(model: model, failures: failures)
            }
            AutosaveSplitView(autosaveName: "AgentShark.FailuresPanes", vertical: true, panes: [
                // DESIGN.md §8.1: queue 440–640, Lens from 520, inspector 360–560. The hard minimums are lower so a narrow
                // window still lays out; the preferred minimums hold while the other panes keep theirs.
                SplitPane(id: "queue", minimum: 300, maximum: 640, preferredMinimum: 440, roomy: 440, initial: 480, holdingPriority: .init(260),
                          accessibilityLabel: "Attention queue") {
                    QueuePane(model: model)
                },
                SplitPane(id: "lens", minimum: 400, preferredMinimum: 520, roomy: 520, accessibilityLabel: "Observed chain") {
                    LensHost(model: model)
                },
                SplitPane(id: "inspect", minimum: 300, maximum: 560, preferredMinimum: 360, roomy: 360, initial: 400, holdingPriority: .init(255),
                          isCollapsed: !model.showDerivedInspector, accessibilityLabel: "Event detail and raw source") {
                    DerivedInspector(model: model, pane: pane)
                },
            ])
        }
        .sheet(item: $pane.longText) { item in
            LongTextSheet(item: item, api: model.engine.api)
        }
        .task(id: syncKey) { model.failures.sync() }
        .onChange(of: model.lensItem) { _, item in
            if item != nil { model.failures.panel = .lens }
        }
    }

    /// "**79 episodes** · 19 need attention · filter + since 17:48"; Group ▾, Sort ▾ and "Display filter applies".
    private var header: some View {
        let facets = $model.failureFacets
        return WorkspaceHeader(model: model, label: failures.scopeLabel, stale: model.viewIsStale && model.failureFacets.matchFilter) {
            if failures.isRefreshing { ProgressView().controlSize(.mini) }
            Menu {
                Picker("Group By", selection: facets.group) {
                    ForEach(QueueGroup.known, id: \.self) { Text(DerivedStyle.groupTitle($0)).tag($0) }
                }
                .pickerStyle(.inline)
            } label: {
                Text("Group: \(DerivedStyle.groupTitle(model.failureFacets.group))")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            Menu {
                Picker("Sort", selection: facets.sort) {
                    ForEach(DerivedStyle.sorts, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.inline)
            } label: {
                Text("Sort: \(DerivedStyle.sorts.first { $0.0 == model.failureFacets.sort }?.1 ?? model.failureFacets.sort)")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            Toggle("Display filter applies", isOn: facets.matchFilter)
                .toggleStyle(.checkbox)
                .fixedSize()
                .help("On: an item belongs to the scope when any of its events matches the display filter. Off: only the sessions and the time range apply.")
        }
    }

    /// Everything the queue depends on; a change re-syncs it.
    private var syncKey: String {
        let f = model.failureFacets
        return [model.view?.viewId ?? "-", model.viewError?.message ?? "", model.scope.sessions.joined(separator: ","),
                "\(model.scope.from ?? 0)|\(model.scope.to ?? 0)", model.appliedFilter, "\(f.hashValue)",
                model.engine.api?.endpoint.baseURL.absoluteString ?? "", "\(model.derived.availability)"].joined(separator: "|")
    }
}

/// The detail outline over the raw pane, for the event the Lens or Steps selected.
struct DerivedInspector: View {
    @Bindable var model: WindowModel
    let pane: EventsPaneState

    var body: some View {
        AutosaveSplitView(autosaveName: "AgentShark.DerivedInspector", vertical: false, panes: [
            SplitPane(id: "detail", minimum: 160, accessibilityLabel: "Detail") { DetailPane(model: model, pane: pane) },
            SplitPane(id: "raw", minimum: 140, initial: 240, accessibilityLabel: "Raw source") { RawPane(model: model, pane: pane) },
        ])
    }
}

// MARK: - Queue pane

/// The facets above the attention queue.
struct QueuePane: View {
    @Bindable var model: WindowModel

    private var failures: FailuresModel { model.failures }

    var body: some View {
        VStack(spacing: 0) {
            if !failures.gaps.isEmpty { GapBanner(gaps: failures.gaps) }
            ZStack {
                QueueOutline(model: model)
                    .opacity(failures.rows.isEmpty ? 0 : 1)
                overlay
            }
            Divider()
            footer
        }
    }

    @ViewBuilder private var overlay: some View {
        switch failures.phase {
        case .idle where model.engine.api == nil:
            EngineStateView(engine: model.engine).background(.background)
        case .idle, .loading:
            if failures.rows.isEmpty {
                LoadingStateView(title: model.view == nil && model.viewError == nil ? "Building the view…" : "Reading failures…").background(.background)
            }
        case .failed(let e):
            FailedStateView(title: "Could not load failures", error: e) {
                if model.viewError != nil { model.rebuildView() }
                failures.retry()
            }
            .background(.background)
        case .unavailable:
            ContentUnavailableView {
                Label("Failure analysis unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text("This engine predates the failure analysis (index schema 4). Update AgentShark and restart the engine.")
            } actions: {
                Button("Restart Engine") { model.engine.restart() }
            }
            .background(.background)
        case .ready:
            if failures.rows.isEmpty {
                ContentUnavailableView {
                    Label("No failures in scope", systemImage: "checkmark.circle")
                } description: {
                    Text(emptyText)
                } actions: {
                    HStack {
                        if model.failureFacets.tiers == [.failure] {
                            Button("Include Suspect") { model.failureFacets.tiers.append(.suspect) }
                        }
                        if !model.failureFacets.isDefault { Button("Reset Facets") { model.failureFacets = FailureFacets(matchFilter: model.failureFacets.matchFilter) } }
                        if model.scope.hasTimeRange { Button("Widen Range") { model.clearTimeScope() } }
                    }
                    .fixedSize()
                }
                .background(.background)
            }
        }
    }

    private var emptyText: String {
        if failures.gaps.contains(where: { $0.code == .analysisOutdated || $0.code == .analysisPending }) {
            return "The analysis has not run on this index yet; failures appear once it finishes."
        }
        return model.scope.isEmpty && model.appliedFilter.isEmpty ? "No failure, alarm or unverified claim was found." : "Nothing matches these facets and this scope."
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Text(footerText).lineLimit(1).truncationMode(.tail)
                .help(footerText + "\n⌘' next item · ⌥⌘' next item that needs attention")
            if failures.isRefreshing { ProgressView().controlSize(.mini) }
            Spacer()
            // Attention sections page on their own (Show All); the other groupings page here.
            if model.failureFacets.group != .attention, failures.rows.count < failures.total {
                Button(failures.isLoadingMore ? "Loading…" : "Load More") { failures.loadMore() }
                    .controlSize(.small)
                    .disabled(failures.isLoadingMore)
            }
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .frame(height: 24)
    }

    /// "25 of 13,522 shown: 12,341 episodes · 655 claims · 525 signatures · 54 delegations" (§9: never "items").
    private var footerText: String {
        let grouped = model.failureFacets.group == .attention
        let shown = grouped ? failures.sections.reduce(0) { $0 + $1.rows.count } : failures.rows.count
        let total = failures.total
        let kinds = grouped ? Self.kindCounts(failures.sections) : Formatters.count(total, DerivedStyle.groupUnit(model.failureFacets.group))
        return shown < total ? "\(Formatters.count(shown)) of \(Formatters.count(total)) shown: " + kinds : kinds
    }

    /// "12,333 episodes · 655 claims · 525 signatures · 54 delegations": what the attention items are, by kind.
    static func kindCounts(_ sections: [FailuresModel.Section]) -> String {
        var n: [String: Int] = [:]
        for s in sections {
            guard let name = s.section else { continue }
            let kind: String
            switch name.rawValue {
            case "alarms": kind = "alarm"
            case "silent-child": kind = "delegation"
            case "unverified-claims": kind = "claim"
            case "recurring": kind = "signature"
            default: kind = "episode"
            }
            n[kind, default: 0] += s.total
        }
        return ["episode", "claim", "signature", "delegation", "alarm"].compactMap { k in n[k].flatMap { $0 > 0 ? Formatters.count($0, k) : nil } }
            .joined(separator: " · ")
    }
}

/// The section index (§7.5): one row across the workspace, under Group by Attention. Items are plain text, a name and
/// its count, with a 6 pt red dot on the sections that need attention; the section at the top of the queue is in the
/// primary color with an accent underline. Items that do not fit collapse into a trailing "+3" menu: the index never
/// wraps, clips or scrolls sideways. ⌥↑ and ⌥↓ move to the previous or next section.
struct SectionIndex: View {
    let model: WindowModel
    let failures: FailuresModel

    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    static let attention: Set<String> = ["alarms", "blocked", "unrecovered", "silent-child"]

    private var items: [FailuresModel.Section] { failures.sections.filter { $0.section != nil } }

    var body: some View {
        let all = items
        ViewThatFits(in: .horizontal) {
            ForEach((1...max(1, all.count)).reversed(), id: \.self) { k in row(shown: Array(all.prefix(k)), rest: Array(all.dropFirst(k))) }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: metrics.workspaceHeader, maxHeight: metrics.workspaceHeader, alignment: .leading)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sections")
    }

    private func row(shown: [FailuresModel.Section], rest: [FailuresModel.Section]) -> some View {
        HStack(spacing: 12) {
            ForEach(shown) { s in item(s) }
            if !rest.isEmpty {
                Menu("+\(rest.count)") {
                    ForEach(rest) { s in
                        Button(DerivedStyle.sectionShortTitle(s.section!) + " " + Formatters.count(s.total)) { failures.jump(to: s.section!) }
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help(rest.map { DerivedStyle.sectionTitle($0.section!) }.joined(separator: ", "))
            }
        }
        .fixedSize()
    }

    private func item(_ s: FailuresModel.Section) -> some View {
        let name = s.section!
        let current = failures.visibleSection == name.rawValue
        return Button {
            failures.jump(to: name)
        } label: {
            HStack(spacing: 4) {
                if Self.attention.contains(name.rawValue) {
                    Circle().fill(Theme.err.swiftUI).frame(width: 6, height: 6).accessibilityHidden(true)
                }
                Text(DerivedStyle.sectionShortTitle(name)).font(.system(size: 12, weight: current ? .semibold : .medium))
                    .foregroundStyle(current ? Color.primary : Color.primary.opacity(0.85))
                Text(Formatters.count(s.total)).font(Theme.fontSwiftUI(.rowSecondary)).foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            .overlay(alignment: .bottom) {
                Rectangle().fill(current ? Color.accentColor : .clear).frame(height: 2).offset(y: 4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Go to \(DerivedStyle.sectionTitle(name)): \(Formatters.count(s.total, name.unit ?? "episode")) (⌥↑ ⌥↓)")
        .accessibilityLabel("\(DerivedStyle.sectionTitle(name)), \(Formatters.count(s.total))" + (current ? ", current" : ""))
    }
}

/// Stated gaps (SPEC §12.9): what the data cannot show, never read as zero.
struct GapBanner: View {
    let gaps: [Gap]
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Button {
                expanded.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "info.circle").foregroundStyle(.secondary)
                    Text(headline).lineLimit(1).truncationMode(.tail)
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").imageScale(.small).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            if expanded {
                ForEach(lines, id: \.self) { line in
                    Text("• " + line)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.secondary.opacity(0.06))
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .combine)
    }

    /// "3 data gaps: …; …; …", every gap, in the words of the analyses' evidence lines and the web (DESIGN.md §7.8).
    private var headline: String {
        AnalysisVocabulary.gapHeadline(gaps.map(\.message))
    }

    /// The expanded list: each gap with its limit and count, a line repeated word for word listed once, as the
    /// headline states each sentence once (two gap codes can carry one sentence).
    var lines: [String] {
        var seen = Set<String>()
        return gaps.map { g in g.message + (g.limit.map { " (data limit \($0))" } ?? "") + (g.count.map { " · \(Formatters.count($0))" } ?? "") }
            .filter { seen.insert($0).inserted }
    }
}

// MARK: - Facets

/// The facet bar (DESIGN.md §7.4): one row of tier toggles ("Failures 97", "+suspect 14≈"; a tier with no rows hides
/// unless it is on), then Outcome, Family, Agent, Role and Unattended. A set facet turns its menu button into one token,
/// "Family: sandbox ▾ ×"; Clear Facets appears when two or more are set. Menus that do not fit fold into More.
struct FacetBar: View {
    @Bindable var model: WindowModel

    private var facets: Binding<FailureFacets> { $model.failureFacets }
    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    var body: some View {
        HStack(spacing: 12) {
            ViewThatFits(in: .horizontal) {
                row(folded: 0)
                row(folded: 2)
                row(folded: 4)
                row(folded: 5)
            }
            // "Split at" shows only under Group by Signature, at the bar's right end (§7.4).
            if model.failureFacets.group == .signature {
                Spacer(minLength: 0)
                SplitAtButton(at: model.signatureSplitAt) { model.signatureSplitAt = $0 }
                    .fixedSize()
                if model.signatureSplitAt != nil {
                    Button("Clear") { model.signatureSplitAt = nil }.help("Stop comparing before and after a date")
                }
            }
        }
        .controlSize(metrics.swiftUIControlSize)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: metrics.workspaceHeader, maxHeight: metrics.workspaceHeader, alignment: .leading)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// The row with the last `folded` facet menus in More.
    private func row(folded: Int) -> some View {
        let menus = facetMenus
        let shown = menus.prefix(menus.count - folded)
        let rest = menus.suffix(folded)
        return HStack(spacing: 12) {
            HStack(spacing: 4) {
                Text("Tiers").foregroundStyle(.secondary)
                ForEach(FailureTier.known, id: \.self) { t in tierToggle(t) }
            }
            HStack(spacing: 8) {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, m in m.view }
                if !rest.isEmpty {
                    Menu("More") {
                        ForEach(Array(rest.enumerated()), id: \.offset) { _, m in m.submenu }
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }
                if setCount >= 2 {
                    Button("Clear Facets") { clearFacets() }
                }
            }
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private var setCount: Int {
        let f = model.failureFacets
        return [!f.outcomes.isEmpty, !f.families.isEmpty, !f.agents.isEmpty, !f.roles.isEmpty, f.unattended != nil].filter { $0 }.count
    }

    /// Clear Outcome, Family, Agent, Role and Unattended; the tiers, grouping, sort and filter switch stay.
    private func clearFacets() {
        var f = model.failureFacets
        f.outcomes = []
        f.families = []
        f.agents = []
        f.roles = []
        f.unattended = nil
        model.failureFacets = f
    }

    /// A tier toggle button; on, a non-failure tier takes its tier's outline (§7.4).
    @ViewBuilder private func tierToggle(_ t: FailureTier) -> some View {
        let on = model.failureFacets.tiers.contains(t)
        let n = model.failures.summary?.tierCount(t) ?? 0
        if on || n > 0 || t == .failure {
            Toggle(isOn: Binding(get: { on }, set: { setTier(t, $0) })) {
                Text(model.failures.tierText(t)).monospacedDigit()
            }
            .toggleStyle(.button)
            .overlay {
                if on, t != .failure {
                    RoundedRectangle(cornerRadius: 5).strokeBorder(DerivedStyle.tierColor(t).swiftUI, lineWidth: 1).allowsHitTesting(false)
                }
            }
            .help(tierHelp(t))
        }
    }

    private static let roles = ["main", "subagent", "workflow-agent", "guardian", "review", "fork", "automation"]

    /// One facet: its menu button (a token when set) and the same choices as a submenu of More.
    struct Facet {
        let view: AnyView
        let submenu: AnyView
    }

    private var facetMenus: [Facet] {
        [
            multi("Outcome", EpisodeOutcome.known, facets.outcomes) { DerivedStyle.outcomeWord($0.rawValue) },
            multi("Family", FailureFamily.known, facets.families) { $0.rawValue },
            multi("Agent", AgentKind.known, facets.agents) { $0.label },
            multi("Role", Self.roles, facets.roles) { $0.replacingOccurrences(of: "-", with: " ") },
            unattended,
        ]
    }

    /// Turn a tier on or off; Failures stays on when nothing else is.
    private func setTier(_ tier: FailureTier, _ on: Bool) {
        var t = model.failureFacets.tiers.filter { $0 != tier }
        if on { t.append(tier) }
        if t.isEmpty { t = [.failure] }
        model.failureFacets.tiers = FailureTier.known.filter(t.contains)
    }

    private func tierHelp(_ t: FailureTier) -> String {
        let what: String
        switch t {
        case .failure: what = "Logged failures: error flags, Codex inner failures, API errors, policy and hook blocks, failed processes."
        case .suspect: what = "Unflagged results where a versioned text rule fired (traceback, tests failed, not found, timeout, sandbox). The count is an upper bound (≈)."
        case .benign: what = "Exit 1 with empty output from search and test commands (rg, grep, test, diff, which…)."
        default: what = "Results that only say a process is still running; the process records the real outcome."
        }
        return what + "\nThe count is calls in the scope, before the Outcome, Family, Agent, Role and Unattended facets; the header counts episodes, each of which groups one or more failed calls."
    }

    private func multi<T: Hashable>(_ title: String, _ all: [T], _ selection: Binding<[T]>, label: @escaping (T) -> String) -> Facet {
        let items = ForEach(all, id: \.self) { v in
            Toggle(label(v), isOn: Binding(get: { selection.wrappedValue.contains(v) }, set: { on in
                selection.wrappedValue.removeAll { $0 == v }
                if on { selection.wrappedValue.append(v) }
            }))
        }
        let value = selection.wrappedValue.map(label).joined(separator: ", ")
        return Facet(view: AnyView(FacetMenu(title: title, value: value.isEmpty ? nil : value, clear: { selection.wrappedValue = [] }) { items }),
                     submenu: AnyView(Menu(value.isEmpty ? title : "\(title): \(value)") { items }))
    }

    private var unattended: Facet {
        let picker = Picker("Unattended", selection: $model.failureFacets.unattended) {
            Text("Any").tag(Bool?.none)
            Text("Unattended Only").tag(Bool?.some(true))
            Text("Attended Only").tag(Bool?.some(false))
        }
        .pickerStyle(.inline)
        let value = model.failureFacets.unattended.map { $0 ? "only" : "attended only" }
        return Facet(view: AnyView(FacetMenu(title: "Unattended", value: value, clear: { model.failureFacets.unattended = nil }) { picker }
                                    .help("Unattended: a subagent, an active Codex goal, or approval set to never with no prompt in the last 3 turns.")),
                     submenu: AnyView(Menu("Unattended") { picker }))
    }
}

/// A facet menu button; once set, one Outline token "Family: sandbox ▾ ×" (§6.2, §7.4).
struct FacetMenu<Items: View>: View {
    let title: String
    let value: String?
    let clear: () -> Void
    @ViewBuilder let items: Items
    @Environment(\.controlSize) private var controlSize

    var body: some View {
        if let value {
            HStack(spacing: 2) {
                Menu {
                    items
                } label: {
                    (Text(title + ": ").foregroundStyle(.secondary) + Text(value)).lineLimit(1)
                }
                .menuStyle(.borderlessButton)
                .frame(maxWidth: 240)
                .fixedSize(horizontal: value.count < 28, vertical: false)
                Button(action: clear) { Image(systemName: "xmark").imageScale(.small).foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
                    .iconHelp("Remove the \(title.lowercased()) facet")
            }
            .padding(.horizontal, 6)
            .frame(height: controlSize == .small ? 20 : 24)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
        } else {
            Menu(title) { items }
                .menuStyle(.borderlessButton)
                .fixedSize()
        }
    }
}

// MARK: - Notifications offer

/// Notifications are off by default and offered once (SPEC §12.7), here, when a notifying alarm is open.
struct NotificationOfferBanner: View {
    @Bindable var model: WindowModel

    var body: some View {
        let prefs = model.app.preferences
        if !prefs.notificationsOffered, !model.isCapture, model.derived.firingAlarms.contains(where: { $0.notify }) {
            HStack(spacing: 8) {
                Image(systemName: "bell.badge").foregroundStyle(.tint)
                Text("Get a notification when a live agent repeats a failure or is blocked by its environment?").lineLimit(2)
                Spacer(minLength: 8)
                Button("Not Now") { prefs.notificationsOffered = true }
                Button("Turn On") {
                    prefs.notificationsOffered = true
                    prefs.notificationsEnabled = true
                    AppNotifications.shared.requestAuthorization()
                }
            }
            .font(.callout)
            .controlSize(.small)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.accentColor.opacity(0.08))
            .overlay(alignment: .bottom) { Divider() }
        }
    }
}
