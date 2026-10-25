import SwiftUI

/// One row of the diagnostics outline: a severity, a group, an entry, or a note that a group was cut short.
struct DiagnosticRow: Identifiable, Hashable {
    enum Kind: Hashable {
        case severity
        case group
        case item
        case truncated
    }

    let id: String
    let kind: Kind
    /// API severity (`error | warn | note | chat`).
    let severity: String
    let group: String
    let title: String
    let count: Int?
    let shown: Int?
    let item: ExpertResult.Item?
    var children: [DiagnosticRow] = []

    /// Plain-language meaning of each group (SPEC §3.8; `loop` and `silent-child` from the analysis, §12.7).
    static let groupInfo: [String: String] = [
        "malformed": "Source lines that are not valid JSON",
        "undecoded": "Record types AgentShark does not decode yet",
        "unpaired": "Calls without a result, or results without a call",
        "tool-error": "Tool calls that failed",
        "api-error": "Model API errors",
        "retry": "API retries with backoff",
        "refusal": "Model refusals",
        "interrupted": "Turns or tools interrupted by the user or the harness",
        "permission-denied": "Permission requests that were denied",
        "compaction": "Context compactions",
        "logging-gap": "Missing transcripts, timestamp inversions and other gaps in the logs",
        "sequence": "Ordering anomalies between records",
        "rate-limit": "Rate-limit events",
        "loop": "Failure episodes with five or more attempts of one signature",
        "silent-child": "Subagents that failed while the parent was not told",
    ]

    /// Severity → group → entries, leaving out `hiddenSeverities` and entries that do not match `query` (§7.14). Entries
    /// sort newest first; groups by their newest entry (`byTime`) or by count.
    static func outline(_ result: ExpertResult, hiddenSeverities: Set<String>, query: String, byTime: Bool = true) -> [DiagnosticRow] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        func matches(_ it: ExpertResult.Item) -> Bool {
            q.isEmpty || it.message.lowercased().contains(q) || (it.session?.lowercased().contains(q) ?? false)
                || (it.event?.lowercased().contains(q) ?? false)
        }
        var out: [DiagnosticRow] = []
        for sev in Severity.order + Set(result.groups.map(\.severity)).subtracting(Severity.order).sorted() where !hiddenSeverities.contains(sev) {
            func newest(_ g: ExpertResult.Group) -> Int64 { g.items.compactMap(\.ts).max() ?? 0 }
            let groups = result.groups.filter { $0.severity == sev }
                .sorted { byTime ? (newest($0), $0.count) > (newest($1), $1.count) : ($0.count, newest($0)) > ($1.count, newest($1)) }
            var groupRows: [DiagnosticRow] = []
            for g in groups {
                let items = g.items.filter(matches).sorted { ($0.ts ?? 0) > ($1.ts ?? 0) }
                guard q.isEmpty || !items.isEmpty || g.group.lowercased().contains(q) else { continue }
                var row = DiagnosticRow(id: "g/\(g.id)", kind: .group, severity: sev, group: g.group, title: g.group, count: g.count,
                                        shown: q.isEmpty ? nil : items.count, item: nil)
                // Entries with one message collapse into one row with their count, which expands to the entries (M-14).
                var byMessage: [String: [ExpertResult.Item]] = [:]
                var order: [String] = []
                for it in items {
                    if byMessage[it.message] == nil { order.append(it.message) }
                    byMessage[it.message, default: []].append(it)
                }
                row.children = order.map { message in
                    let same = byMessage[message]!
                    let entry = { (it: ExpertResult.Item) in
                        DiagnosticRow(id: "i/\(it.id)", kind: .item, severity: sev, group: g.group, title: it.message, count: nil, shown: nil, item: it)
                    }
                    guard same.count > 1 else { return entry(same[0]) }
                    var dup = DiagnosticRow(id: "m/\(g.id)/\(same[0].id)", kind: .item, severity: sev, group: g.group, title: message,
                                            count: same.count, shown: nil, item: same[0])
                    dup.children = same.map(entry)
                    return dup
                }
                if q.isEmpty, g.items.count < g.count {
                    row.children.append(DiagnosticRow(id: "t/\(g.id)", kind: .truncated, severity: sev, group: g.group,
                                                      title: "Showing the first \(Formatters.count(g.items.count)) of \(Formatters.count(g.count)). Narrow the view to see the rest.",
                                                      count: nil, shown: nil, item: nil))
                }
                groupRows.append(row)
            }
            guard !groupRows.isEmpty else { continue }
            var sevRow = DiagnosticRow(id: "s/\(sev)", kind: .severity, severity: sev, group: "", title: Severity.label(sev),
                                       count: groups.reduce(0) { $0 + $1.count }, shown: nil, item: nil)
            sevRow.children = groupRows
            out.append(sevRow)
        }
        return out
    }
}

/// Diagnostics (API name `expert`): severity → group → entries with counts. By default it covers the current view;
/// without a valid view it shows the view's state and never falls back to the whole index (SPEC §7.8).
struct DiagnosticsWorkspace: View {
    @Bindable var model: WindowModel
    @AppStorage("diagnostics.currentViewOnly") private var viewOnly = true
    @AppStorage("diagnostics.hiddenSeverities") private var hiddenSeverities = ""
    @AppStorage("diagnostics.sortByTime") private var sortByTime = true
    @State private var request = PanelRequest<ExpertResult>()
    @State private var query = ""
    /// Severity and group rows shown open, and those that have appeared (see `autoExpanded`).
    @State private var expanded: Set<String> = []
    @State private var seen: Set<String> = []
    @State private var selection: Set<DiagnosticRow.ID> = []
    @State private var searchFocus = 0
    /// Increments on Refresh in whole-index mode.
    @State private var refreshes = 0

    private var hidden: Set<String> { Set(hiddenSeverities.split(separator: ",").map(String.init)) }

    /// Nil when the current view is required but missing.
    private var requestKey: String? {
        if viewOnly { return model.view.map { "view:\($0.viewId)" } }
        return "all:\(refreshes)"
    }

    var body: some View {
        // The workspace header (DESIGN.md §7.3, §7.14): the scope label, the message filter, Sort and Current view only.
        VStack(spacing: 0) {
            controls
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onChange(of: model.findFocusRequest) {
            // Edit ▸ Find (⌘F) here filters the messages.
            guard model.workspace == .diagnostics else { return }
            model.isFindBarVisible = false
            searchFocus += 1
        }
        // Rows open here, as state, so a row that opened by itself can still be collapsed.
        .onChange(of: autoExpanded, initial: true) { _, ids in
            // A search opens what it matched; otherwise a row opens only the first time it appears.
            expanded.formUnion(query.isEmpty ? ids.subtracting(seen) : ids)
            seen.formUnion(ids)
        }
        .task(id: requestKey) {
            // Whole-index mode names the global scope; it is never the fallback for a missing view.
            guard let key = requestKey, let viewID = viewOnly ? model.view?.viewId : "global" else {
                request.cancel()
                return
            }
            request.load(key: key, keepValue: viewOnly && model.isRefreshingView) { [model] in try await model.viewRequest { try await $0.expert(view: viewID, limit: 500) } }
        }
    }

    // MARK: Controls

    /// "1,204 entries · 3 errors · 120 warnings · all sessions"; whole-index mode says the scope does not apply.
    private var label: String {
        let totals = Dictionary(grouping: request.value?.groups ?? [], by: \.severity).mapValues { $0.reduce(0) { $0 + $1.count } }
        var parts: [String] = []
        if let r = request.value { parts.append(Formatters.count(r.groups.reduce(0) { $0 + $1.count }, "entry", plural: "entries")) }
        for sev in Severity.order where (totals[sev] ?? 0) > 0 && !hidden.contains(sev) {
            parts.append(Formatters.count(totals[sev]!) + " " + Severity.label(sev).lowercased() + ((totals[sev]! == 1) ? "" : "s"))
        }
        if parts.isEmpty { parts.append("Diagnostics") }
        if viewOnly {
            parts.append(model.scopeParts.isEmpty ? "all sessions" : model.scopeParts.joined(separator: " + "))
        } else {
            parts.append("whole index: the scope does not apply")
        }
        return parts.joined(separator: " · ")
    }

    private var controls: some View {
        WorkspaceHeader(model: model, label: label) {
            PanelKit.SearchField(text: $query, prompt: "Filter Messages", focusRequest: searchFocus, onEscape: { query = "" })
                .frame(width: 180)
            Menu {
                Picker("Sort By", selection: $sortByTime) {
                    Text("Time").tag(true)
                    Text("Count").tag(false)
                }
                .pickerStyle(.inline)
                Section("Show") {
                    ForEach(Severity.order, id: \.self) { sev in
                        Toggle(Severity.label(sev), isOn: Binding(get: { !hidden.contains(sev) }, set: { setHidden(sev, !$0) }))
                    }
                }
            } label: {
                Text("Sort: " + (sortByTime ? "Time" : "Count"))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Entries sort newest first; groups by their newest entry or by count. The menu also shows or hides each severity.")
            if !viewOnly {
                Button { refreshes += 1 } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .iconHelp("Refresh diagnostics for the whole index")
            }
            Toggle("Current view only", isOn: $viewOnly)
                .toggleStyle(.checkbox)
                .help("Only entries whose event or session is in the current view: its filter, sessions and time range")
        }
    }

    private func setHidden(_ sev: String, _ hide: Bool) {
        var h = hidden
        if hide { h.insert(sev) } else { h.remove(sev) }
        hiddenSeverities = h.sorted().joined(separator: ",")
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if viewOnly, (model.view?.count ?? 0) == 0 {
            PanelKit.ViewPhaseView(model: model, phase: model.viewPhase)
        } else {
            PanelKit.RequestView(request: request, loadingTitle: "Loading diagnostics…") { result in
                let rows = DiagnosticRow.outline(result, hiddenSeverities: hidden, query: query, byTime: sortByTime)
                if result.groups.isEmpty {
                    ContentUnavailableView("No diagnostics", systemImage: "checkmark.seal",
                                           description: Text(viewOnly ? "Nothing was flagged for the events in the current view."
                                                                      : "The index has no diagnostics."))
                } else if rows.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    outline(rows)
                }
            }
        }
    }

    private func outline(_ rows: [DiagnosticRow]) -> some View {
        var byID: [String: DiagnosticRow] = [:]
        for s in rows {
            byID[s.id] = s
            for g in s.children {
                byID[g.id] = g
                for i in g.children {
                    byID[i.id] = i
                    for e in i.children { byID[e.id] = e }
                }
            }
        }
        return Table(of: DiagnosticRow.self, selection: $selection) {
            TableColumn("Diagnostic") { (r: DiagnosticRow) in DiagnosticTitleCell(row: r, line2: line2(r)) }
                .width(min: 260, ideal: 720)
            TableColumn("Count") { (r: DiagnosticRow) in countCell(r) }
                .width(min: 56, ideal: 90, max: 120)
        } rows: {
            ForEach(rows) { sev in
                DisclosureTableRow(sev, isExpanded: expansion(sev.id)) {
                    ForEach(sev.children) { g in
                        DisclosureTableRow(g, isExpanded: expansion(g.id)) {
                            ForEach(g.children) { e in
                                if e.children.isEmpty {
                                    TableRow(e)
                                } else {
                                    DisclosureTableRow(e, isExpanded: expansion(e.id)) { ForEach(e.children) { TableRow($0) } }
                                }
                            }
                        }
                    }
                }
            }
        }
        .contextMenu(forSelectionType: DiagnosticRow.ID.self) { ids in
            itemMenu(ids.compactMap { byID[$0] })
        } primaryAction: { ids in
            guard ids.count == 1, let r = ids.first.flatMap({ byID[$0] }) else { return }
            open(r)
        }
    }

    /// Rows that open the first time they appear: every severity, and the groups when only a few exist or a search
    /// is active.
    private var autoExpanded: Set<String> {
        guard let result = request.value else { return [] }
        let severities = DiagnosticRow.outline(result, hiddenSeverities: hidden, query: query)
        let groups = severities.flatMap(\.children)
        return Set(severities.map(\.id) + (!query.isEmpty || groups.count <= 3 ? groups.map(\.id) : []))
    }

    private func expansion(_ id: String) -> Binding<Bool> {
        Binding(get: { expanded.contains(id) }, set: { if $0 { expanded.insert(id) } else { expanded.remove(id) } })
    }

    /// Double-click: an entry jumps to its event (or opens its session); a severity or group expands or collapses.
    private func open(_ r: DiagnosticRow) {
        switch r.kind {
        case .item:
            if let event = r.item?.event {
                model.select(event: event)
            } else if let session = r.item?.session {
                model.openSession(session, workspace: .events)
            }
        case .severity, .group:
            expansion(r.id).wrappedValue.toggle()
        case .item where !r.children.isEmpty:
            expansion(r.id).wrappedValue.toggle()
        case .truncated:
            break
        }
    }

    @ViewBuilder private func itemMenu(_ rows: [DiagnosticRow]) -> some View {
        let items = rows.compactMap(\.item)
        if items.count == 1, let it = items.first {
            if let episode = it.episodeId {
                Button("Open Observed Chain") { model.openEpisode(episode) }
            }
            if let event = it.event {
                Button("Show in Events") { model.select(event: event) }
            }
            if let session = it.session {
                Button("Open Session") { model.openSession(session, workspace: .events) }
                Button("Open Transcript") { model.openSession(session, mode: .transcript) }
            }
            Divider()
            if let event = it.event {
                Button("Copy Event ID") { AppKitHelpers.copy(event) }
            }
        }
        if !items.isEmpty {
            Button(items.count == 1 ? "Copy Message" : "Copy Messages") { AppKitHelpers.copy(items.map(\.message).joined(separator: "\n")) }
        }
    }

    // MARK: Cells

    @ViewBuilder private func countCell(_ r: DiagnosticRow) -> some View {
        if let count = r.count {
            Text(r.shown.map { "\(Formatters.count($0)) of \(Formatters.count(count))" } ?? Formatters.count(count))
                .font(Theme.dataFontSwiftUI(size: 12))
                .foregroundStyle(r.kind == .severity ? .primary : .secondary)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .help(r.kind == .item ? Formatters.count(count, "entry", plural: "entries") + " with this message" : Formatters.count(count, "entry", plural: "entries"))
        }
    }

    /// An entry's second line (§7.14): its session's title (not its id), the agent and the time, muted. The group header
    /// names the rule, so the line leaves it out (its tooltip keeps it); the time is a clock time when the group spans
    /// less than a day, so adjacent entries differ (M-14). A collapsed run of one message reads "93 entries · newest …".
    private func line2(_ r: DiagnosticRow) -> String? {
        guard r.kind == .item, let it = r.item else { return nil }
        var parts: [String] = []
        if !r.children.isEmpty, let n = r.count { parts.append(Formatters.count(n, "entry", plural: "entries")) }
        if let s = it.session {
            parts.append(model.store.title(of: s))
            if let agent = model.sessionsByID[s]?.agent { parts.append(agent.label) }
        }
        if let ts = it.ts { parts.append((r.children.isEmpty ? "" : "newest ") + (clockTimes.contains(r.group) ? PanelKit.clock(ts) : Formatters.relative(ts))) }
        return parts.joined(separator: " · ")
    }

    /// Groups whose entries all fall within one day: their entries show clock times.
    private var clockTimes: Set<String> {
        guard let result = request.value else { return [] }
        return Set(result.groups.filter { g in
            let ts = g.items.compactMap(\.ts)
            guard let lo = ts.min(), let hi = ts.max() else { return false }
            return hi - lo < 86_400_000_000
        }.map(\.group))
    }
}

/// A severity, a group (its name and meaning), or an entry: the severity mark and the message, then its second line.
private struct DiagnosticTitleCell: View {
    let row: DiagnosticRow
    var line2: String?

    var body: some View {
        switch row.kind {
        case .severity:
            Label {
                Text(row.title).font(Theme.fontSwiftUI(.groupHeader))
            } icon: {
                Image(systemName: Symbols.severity(row.severity)).foregroundStyle(Theme.severityColor(row.severity).swiftUI)
            }
        case .group:
            // The group's human name; its rule id is an internal id and lives in the tooltip (§9 Internal ids).
            Text(DiagnosticRow.groupInfo[row.group] ?? row.group).font(Theme.fontSwiftUI(.groupHeader)).lineLimit(1)
                .help("Rule \(row.group)")
        case .item:
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: Symbols.severity(row.severity)).foregroundStyle(Theme.severityColor(row.severity).swiftUI)
                        .imageScale(.small).accessibilityHidden(true)
                    Text(row.title).lineLimit(1).truncationMode(.tail)
                }
                if let line2 {
                    Text(line2).font(Theme.fontSwiftUI(.rowSecondary)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                        .padding(.leading, 20)
                }
            }
            .padding(.vertical, 2)
            .help(row.title + (row.item?.ts.map { "\n" + Formatters.timestamp($0) } ?? "") + "\nRule " + row.group)
        case .truncated:
            Label(row.title, systemImage: "ellipsis.circle").foregroundStyle(.secondary).lineLimit(1)
        }
    }
}
