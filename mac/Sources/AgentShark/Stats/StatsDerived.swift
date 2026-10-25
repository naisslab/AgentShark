import SwiftUI

// Statistics ▸ Tools (service response time), Turns, Time and Endpoints (SPEC §12.7 Statistics, §12.2 rows 4 and 6).
// Tools and Endpoints follow the window's view. Turns lists the turns of the sessions in scope that have an event in
// the view. Time accounts for whole sessions, so the display filter does not apply to it and its header says so.

// MARK: - Service response time

/// `SrtGroup` in api.ts.
enum SRTGroup: String, CaseIterable, Identifiable {
    case tool, server, program, host, model

    var id: Self { self }

    var title: String {
        switch self {
        case .tool: return "Tool"
        case .server: return "MCP Server"
        case .program: return "Program"
        case .host: return "Host"
        case .model: return "Model"
        }
    }

    var noun: String {
        switch self {
        case .tool: return "tool"
        case .server: return "MCP server"
        case .program: return "program"
        case .host: return "web host"
        case .model: return "model"
        }
    }

    /// The filter that selects the rows' events, where a filter field holds the key.
    func fragment(_ keys: [String]) -> String? {
        switch self {
        case .tool: return membership("tool.name", keys)
        case .model: return membership("model", keys)
        default: return nil
        }
    }
}

/// Duration sources of a set of calls in words: "logged 92% · ≈derived 8%".
enum DurationSources {
    static func family(_ key: String) -> String {
        let head = key.split(separator: ":", maxSplits: 1).first.map(String.init) ?? key
        switch head {
        case "logged": return "logged"
        case "derived": return "derived≈"
        case "parsed": return "parsed~"
        default: return "unknown"
        }
    }

    static func summary(_ mix: [String: Int]) -> String {
        var byFamily: [String: Int] = [:]
        for (k, n) in mix { byFamily[family(k), default: 0] += n }
        let total = byFamily.values.reduce(0, +)
        guard total > 0 else { return Formatters.missing }
        return byFamily.sorted { $0.value > $1.value || ($0.value == $1.value && $0.key < $1.key) }
            .map { "\($0.key) \(Formatters.percent(Double($0.value) / Double(total)))" }
            .joined(separator: " · ")
    }

    static func help(_ mix: [String: Int]) -> String {
        mix.sorted { $0.value > $1.value }.map { "\($0.key): \(Formatters.count($0.value))" }.joined(separator: "\n")
    }
}

extension SrtRow {
    var failureCount: Int { failures["failure"] ?? 0 }
    var suspectCount: Int { failures["suspect"] ?? 0 }
    var failureRate: Double { calls > 0 ? Double(failureCount) / Double(calls) : 0 }
    var coverage: Double { calls > 0 ? Double(durKnown) / Double(calls) : 0 }
    var p50Key: Int64 { p50 ?? -1 }
    var p90Key: Int64 { p90 ?? -1 }
    var p99Key: Int64 { p99 ?? -1 }
    var maxKey: Int64 { max ?? -1 }
    var sourcesText: String { DurationSources.summary(durSrcMix) }
    var agentsText: String { agents.map(\.label).joined(separator: ", ") }
}

/// "82 of 120" (DESIGN.md §4.4 Known durations): percentiles cover only calls with a known duration (SPEC §7.8).
private func coverageText(known: Int, of calls: Int) -> some View {
    Text("\(Formatters.count(known)) of \(Formatters.count(calls))")
        .font(Theme.dataFontSwiftUI(size: 12))
        .foregroundStyle(known < calls ? Color.secondary : Color.primary)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .help("\(Formatters.count(known)) of \(Formatters.count(calls, "call")) have a known duration (\(Formatters.percent(calls > 0 ? Double(known) / Double(calls) : nil))); the percentiles cover only those.")
}

/// The Failures column title and the legend of its "+≈n" notation.
enum FailureColumn {
    static let title = "Failures (+suspect≈)"
    static let legend = "+n≈ counts suspect rows, an upper bound (Claude Bash successes carry no exit code)."
}

/// Failure-tier rows: the `failure` count, then "+≈n" suspect results (upper bounds).
private func tierText(failure: Int, suspect: Int) -> some View {
    Text(Formatters.count(failure) + (suspect > 0 ? " +\(Formatters.count(suspect))≈" : ""))
        .font(Theme.dataFontSwiftUI(size: 12))
        .foregroundStyle(failure > 0 ? Theme.err.swiftUI : .primary)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .help("\(Formatters.count(failure, "failure"))" + (suspect > 0 ? " and at most \(Formatters.count(suspect)) suspect results (≈, an upper bound)" : ""))
}

/// Statistics ▸ Tools: service response time grouped by tool, MCP server, program, host or model, each percentile
/// with its coverage and duration-source mix, and failures by tier. An engine without these routes keeps the
/// per-tool table.
struct StatsSRTView: View {
    let model: WindowModel
    let viewID: String
    @AppStorage("stats.srtGroup") private var group: SRTGroup = .tool
    private var request: PanelRequest<SrtResponse> { model.panels.request("stats.srt") }
    @State private var selection: Set<SrtRow.ID> = []
    @State private var sortOrder = [KeyPathComparator(\SrtRow.calls, order: .reverse)]

    private var key: String { "\(viewID)|\(group.rawValue)" }

    var body: some View {
        VStack(spacing: 0) {
            PanelKit.HeaderBar {
                Picker("Group by", selection: $group) {
                    ForEach(SRTGroup.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .help("Group the calls of the current view")
            } trailing: {
                Text("Durations: logged; ≈ derived from timestamps; ~ parsed from output. +n≈ suspect rows are an upper bound.")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            content
        }
        .task(id: key) {
            let group = group, viewID = viewID
            let keep = model.isRefreshingView && request.key?.hasSuffix("|" + group.rawValue) == true
            request.load(key: key, keepValue: keep) { [model] in try await model.viewRequest { try await $0.statsSRT(view: viewID, group: group.rawValue) } }
        }
    }

    @ViewBuilder private var content: some View {
        if case .failed(let e) = request.phase, e.isNotServed {
            if group == .tool {
                StatsToolsView(model: model, viewID: viewID)
            } else {
                ContentUnavailableView {
                    Label("Grouping by \(group.title) Is Not Available", systemImage: "wrench.and.screwdriver")
                } description: {
                    Text("This engine does not compute service response times yet. Group by Tool shows the per-tool table.")
                } actions: {
                    Button("Group by Tool") { group = .tool }
                }
            }
        } else {
            PanelKit.RequestView(request: request, loadingTitle: "Measuring response times…") { r in
                VStack(spacing: 0) {
                    if r.rows.isEmpty {
                        ContentUnavailableView("No \(group.title) Calls in This View", systemImage: "wrench.and.screwdriver",
                                               description: Text("The events in the current view contain no calls to group by \(group.noun)."))
                    } else {
                        table(r.rows.sorted(using: sortOrder))
                    }
                    TableFooter(count: Formatters.count(r.rows.count, group.noun), hint: footer(r))
                }
            }
        }
    }

    private func footer(_ r: SrtResponse) -> String {
        let calls = r.rows.reduce(0) { $0 + $1.calls }, known = r.rows.reduce(0) { $0 + $1.durKnown }
        var parts = ["Percentiles cover the \(Formatters.count(known)) of \(Formatters.count(calls, "call")) with a known duration."]
        if group.fragment(["x"]) != nil { parts.append("Double-click a row to narrow the filter to it.") }
        parts += r.gaps.map { StatsTurnsView.sentence($0.message) }
        // The header note already states the suspect bound (one fact, one place).
        return parts.joined(separator: " ")
    }

    private func table(_ rows: [SrtRow]) -> some View {
        Table(rows, selection: $selection, sortOrder: $sortOrder) {
            countColumns
            timeColumns
            agentColumns
        }
        .alternatingRowBackgrounds(.disabled)
        .contextMenu(forSelectionType: SrtRow.ID.self) { ids in
            let keys = rows.map(\.key).filter(ids.contains)
            DrillDownMenu(model: model, fragment: group.fragment(keys), copyTitle: "Copy \(group.title)", copyText: keys.joined(separator: "\n"))
        } primaryAction: { ids in
            if let f = group.fragment(rows.map(\.key).filter(ids.contains)) { model.drillDown(f) }
        }
    }

    /// The §4.4 columns, in order: name, Calls, Failures, Fail %, p50, p90, p99, Max, Known durations, Total time,
    /// Agents, then Duration sources.
    @TableColumnBuilder<SrtRow, KeyPathComparator<SrtRow>>
    private var countColumns: some TableColumnContent<SrtRow, KeyPathComparator<SrtRow>> {
        TableColumn(group.title, value: \SrtRow.key) { (r: SrtRow) in
            // Tool, server and program names are machine text; model names and hosts read as words (§3.2).
            Text(r.key).font(group == .model ? Theme.fontSwiftUI(.rowPrimary) : Theme.fontSwiftUI(.code)).lineLimit(1).truncationMode(.middle)
                .help(r.key + (r.agents.isEmpty ? "" : "\nAgents: " + r.agentsText))
        }
        .width(min: 160, ideal: 200, max: 320)
        TableColumn("Calls", value: \SrtRow.calls) { (r: SrtRow) in countText(r.calls) }
            .width(min: 64, ideal: 64, max: 80)
        TableColumn(FailureColumn.title, value: \SrtRow.failureCount) { (r: SrtRow) in tierText(failure: r.failureCount, suspect: r.suspectCount) }
            .width(min: 88, ideal: 118, max: 150)
        TableColumn("Fail %", value: \SrtRow.failureRate) { (r: SrtRow) in
            Text(r.calls > 0 ? Formatters.shortPercent(r.failureRate) : Formatters.missing)
                .font(Theme.dataFontSwiftUI(size: 12))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .help("\(Formatters.count(r.failureCount)) of \(Formatters.count(r.calls, "call")) failed (\(Formatters.percent(r.failureRate)))")
        }
        .width(min: 64, ideal: 64, max: 72)
    }

    @TableColumnBuilder<SrtRow, KeyPathComparator<SrtRow>>
    private var timeColumns: some TableColumnContent<SrtRow, KeyPathComparator<SrtRow>> {
        TableColumn("p50", value: \SrtRow.p50Key) { (r: SrtRow) in durationText(r.p50, missing: Self.noDuration) }
            .width(min: 64, ideal: 64, max: 80)
        TableColumn("p90", value: \SrtRow.p90Key) { (r: SrtRow) in durationText(r.p90, missing: Self.noDuration) }
            .width(min: 64, ideal: 64, max: 80)
        TableColumn("p99", value: \SrtRow.p99Key) { (r: SrtRow) in durationText(r.p99, missing: Self.noDuration) }
            .width(min: 64, ideal: 64, max: 80)
        TableColumn("Max", value: \SrtRow.maxKey) { (r: SrtRow) in durationText(r.max, missing: Self.noDuration) }
            .width(min: 64, ideal: 64, max: 80)
        TableColumn("Known durations", value: \SrtRow.coverage) { (r: SrtRow) in coverageText(known: r.durKnown, of: r.calls) }
            .width(min: 112, ideal: 112, max: 120)
        TableColumn("Total time", value: \SrtRow.total) { (r: SrtRow) in
            // A group with no known duration has no total, which is not a measured zero (§9 Missing values).
            durationText(r.durKnown > 0 ? r.total : nil, missing: Self.noDuration)
        }
        .width(min: 80, ideal: 80, max: 96)
    }

    @TableColumnBuilder<SrtRow, KeyPathComparator<SrtRow>>
    private var agentColumns: some TableColumnContent<SrtRow, KeyPathComparator<SrtRow>> {
        TableColumn("Agents", value: \SrtRow.agentsText) { (r: SrtRow) in
            Text(r.agents.isEmpty ? Formatters.missing : r.agentsText).foregroundStyle(.secondary).lineLimit(1).help(r.agentsText)
        }
        .width(min: 120, ideal: 140, max: 200)
        TableColumn("Duration sources", value: \SrtRow.sourcesText) { (r: SrtRow) in
            Text(r.sourcesText).foregroundStyle(.secondary).lineLimit(1).help(DurationSources.help(r.durSrcMix))
        }
        .width(min: 90, ideal: 140)
    }

    private static let noDuration = "No call in this group has a known duration."
}

// MARK: - Endpoints

/// `EndpointKind` in api.ts, plus All.
enum EndpointFilter: String, CaseIterable, Identifiable {
    case all, mcp, host, hook, program, agent

    var id: Self { self }

    var title: String {
        switch self {
        case .all: return "All"
        case .mcp: return "MCP Servers"
        case .host: return "Web Hosts"
        case .hook: return "Hooks"
        case .program: return "Programs"
        case .agent: return "Agent Types"
        }
    }

    static func word(_ kind: String) -> String {
        switch kind {
        case "mcp": return "MCP server"
        case "host": return "web host"
        case "hook": return "hook"
        case "program": return "program"
        case "agent": return "agent type"
        default: return kind
        }
    }
}

extension EndpointRow: Identifiable {
    var id: String { kind + "|" + endpoint }
    var failureCount: Int { failures["failure"] ?? 0 }
    var suspectCount: Int { failures["suspect"] ?? 0 }
    var failureRate: Double { calls > 0 ? Double(failureCount) / Double(calls) : 0 }
    var coverage: Double { calls > 0 ? Double(durKnown) / Double(calls) : 0 }
    var p50Key: Int64 { p50 ?? -1 }
    var p90Key: Int64 { p90 ?? -1 }
    var p99Key: Int64 { p99 ?? -1 }
    var lastKey: Int64 { lastTs ?? -1 }
}

/// Statistics ▸ Endpoints (Wireshark's Endpoints): who the agents talked to in the current view.
struct StatsEndpointsView: View {
    let model: WindowModel
    let viewID: String
    @AppStorage("stats.endpointKind") private var kind: EndpointFilter = .all
    private var request: PanelRequest<EndpointsResponse> { model.panels.request("stats.endpoints") }
    @State private var selection: Set<EndpointRow.ID> = []
    @State private var sortOrder = [KeyPathComparator(\EndpointRow.calls, order: .reverse)]

    private var key: String { "\(viewID)|\(kind.rawValue)" }

    var body: some View {
        VStack(spacing: 0) {
            PanelKit.HeaderBar {
                Picker("Kind", selection: $kind) {
                    ForEach(EndpointFilter.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
            } trailing: {
                Text(PanelKit.timeZoneNote).font(.caption).foregroundStyle(.secondary)
            }
            if case .failed(let e) = request.phase, e.isNotServed {
                ContentUnavailableView("Endpoints are not available", systemImage: "point.3.connected.trianglepath.dotted",
                                       description: Text("This engine does not compute endpoint statistics yet."))
            } else {
                PanelKit.RequestView(request: request, loadingTitle: "Counting endpoints…") { r in
                    VStack(spacing: 0) {
                        if r.rows.isEmpty {
                            ContentUnavailableView("No endpoints in this view", systemImage: "point.3.connected.trianglepath.dotted",
                                                   description: Text("The events in the current view call no \(kind == .all ? "MCP server, web host, hook, program or subagent" : EndpointFilter.word(kind.rawValue))."))
                        } else {
                            table(r.rows.sorted(using: sortOrder))
                        }
                        TableFooter(count: Formatters.count(r.rows.count, "endpoint"),
                                    hint: (["Percentiles cover the calls with a known duration (Coverage)."] + r.gaps.map { StatsTurnsView.sentence($0.message) }
                                           + [FailureColumn.legend]).joined(separator: " "))
                    }
                }
            }
        }
        .task(id: key) {
            let kind = kind, viewID = viewID
            let keep = model.isRefreshingView && request.key?.hasSuffix("|" + kind.rawValue) == true
            request.load(key: key, keepValue: keep) { [model] in
                try await model.viewRequest { try await $0.statsEndpoints(view: viewID, kind: kind == .all ? nil : kind.rawValue) }
            }
        }
    }

    private func table(_ rows: [EndpointRow]) -> some View {
        Table(rows, selection: $selection, sortOrder: $sortOrder) {
            TableColumn("Kind", value: \EndpointRow.kind) { (r: EndpointRow) in Text(EndpointFilter.word(r.kind)).foregroundStyle(.secondary) }
                .width(min: 60, ideal: 90, max: 120)
            TableColumn("Endpoint", value: \EndpointRow.endpoint) { (r: EndpointRow) in
                Text(r.endpoint).font(Theme.fontSwiftUI(.code)).lineLimit(1).truncationMode(.middle).help(r.endpoint)
            }
            .width(min: 120, ideal: 220, max: 420)
            TableColumn("Calls", value: \EndpointRow.calls) { (r: EndpointRow) in countText(r.calls) }
                .width(min: 40, ideal: 48, max: 90)
            TableColumn("Sessions", value: \EndpointRow.sessions) { (r: EndpointRow) in countText(r.sessions) }
                .width(min: 50, ideal: 56, max: 90)
            TableColumn(FailureColumn.title, value: \EndpointRow.failureCount) { (r: EndpointRow) in tierText(failure: r.failureCount, suspect: r.suspectCount) }
                .width(min: 70, ideal: 118, max: 150)
            TableColumn("Fail %", value: \EndpointRow.failureRate) { (r: EndpointRow) in
                Text(r.calls > 0 ? Formatters.percent(r.failureRate) : Formatters.missing)
                    .font(Theme.dataFontSwiftUI(size: 12))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .help("\(Formatters.count(r.failureCount)) of \(Formatters.count(r.calls, "call")) failed")
            }
            .width(min: 50, ideal: 56, max: 90)
            TableColumn("Known durations", value: \EndpointRow.coverage) { (r: EndpointRow) in coverageText(known: r.durKnown, of: r.calls) }
                .width(min: 88, ideal: 96, max: 120)
            TableColumn("p50", value: \EndpointRow.p50Key) { (r: EndpointRow) in durationText(r.p50, missing: Self.noDuration) }
                .width(min: 46, ideal: 54, max: 100)
            TableColumn("p90", value: \EndpointRow.p90Key) { (r: EndpointRow) in durationText(r.p90, missing: Self.noDuration) }
                .width(min: 46, ideal: 54, max: 100)
            TableColumn("Last Call", value: \EndpointRow.lastKey) { (r: EndpointRow) in
                Text(r.lastTs.map(Formatters.shortDateTime) ?? Formatters.missing)
                    .font(Theme.dataFontSwiftUI(size: 12))
                    .foregroundStyle(.secondary)
                    .help(Formatters.timeRange(from: r.firstTs, to: r.lastTs))
            }
            .width(min: 90, ideal: 120)
        }
        .alternatingRowBackgrounds(.disabled)
        .contextMenu(forSelectionType: EndpointRow.ID.self) { ids in
            let picked = rows.filter { ids.contains($0.id) }
            Button("Copy Endpoint") { AppKitHelpers.copy(picked.map(\.endpoint).joined(separator: "\n")) }
        }
    }

    private static let noDuration = "No call to this endpoint has a known duration."
}

// MARK: - Scope roots

extension WindowModel {
    /// The sessions of the scope that have no ancestor in the scope: the derived routes include descendants, so a
    /// child selected with its parent would count twice.
    var scopeRootSessions: [String] {
        let set = Set(scope.sessions)
        return scope.sessions.filter { !hasAncestor($0, in: set) }
    }

    /// Whether a session's parent chain reaches one of `set`.
    func hasAncestor(_ id: String, in set: Set<String>) -> Bool {
        var parent = sessionsByID[id]?.parentId
        var hops = 0
        while let p = parent, p != id, hops < 32 {
            if set.contains(p) { return true }
            parent = sessionsByID[p]?.parentId
            hops += 1
        }
        return false
    }
}

/// At most this many sessions of the scope are read by Turns and Time.
private let maxStatsSessions = 20

@MainActor private func scopeNote(_ model: WindowModel, read: Int) -> String {
    let n = model.scopeRootSessions.count
    if n == 1 { return model.runLabel(of: model.scopeRootSessions[0]) }
    return n > read ? "first \(read) of \(n) sessions" : Formatters.count(n, "session")
}

// MARK: - Turns

/// One row of Statistics ▸ Turns.
struct TurnStat: Identifiable, Hashable {
    let turn: StepTurn
    let sessionTitle: String

    var id: String { turn.id }
    var wallKey: Int64 { turn.wallUs ?? -1 }
    var startKey: Int64 { turn.startTs }
    var impactRank: Int { TurnImpact.known.firstIndex(of: turn.impact) ?? TurnImpact.known.count }
    var stepsKey: Int { turn.nSteps }
    var episodesKey: Int { turn.nEpisodes }
    var claimKey: String { turn.claim?.rawValue ?? "" }
    var promptKey: String { turn.promptExcerpt ?? "" }
    var topBucket: TimeBucket? { turn.buckets.max { $0.us < $1.us } }
    var topBucketKey: Int64 { topBucket?.us ?? -1 }
}

/// The turns of the sessions in scope, read through the steps route with clean turns folded (one page holds every
/// turn row; only the steps of turns with problems come along).
struct TurnsResult {
    var rows: [TurnStat]
    /// Turns read before keeping those with an event in the view.
    var read: Int
    var truncated: Bool
    var gaps: [Gap]

    @MainActor static func load(model: WindowModel, api: APIClient, view: String?) async throws -> TurnsResult {
        var rows: [TurnStat] = []
        var seen: Set<String> = []
        var gaps: [Gap] = []
        var truncated = false
        let roots = Array(model.scopeRootSessions.prefix(maxStatsSessions))
        for session in roots {
            var after: String?
            var pages = 0
            repeat {
                let page = try await api.sessionSteps(session, StepsRequest(view: view, after: after, limit: 5000, descendants: true, foldClean: true))
                for t in page.turns where seen.insert(t.id).inserted {
                    rows.append(TurnStat(turn: t, sessionTitle: model.store.title(of: t.sessionId)))
                }
                for g in page.gaps where !gaps.contains(g) { gaps.append(g) }
                after = page.next
                pages += 1
            } while after != nil && pages < 8
            if after != nil { truncated = true }
        }
        let read = rows.count
        if view != nil { rows = rows.filter { ($0.turn.matchedSteps ?? 1) > 0 } }
        return TurnsResult(rows: rows, read: read, truncated: truncated || model.scopeRootSessions.count > roots.count, gaps: gaps)
    }
}

/// Statistics ▸ Turns: the turns of the sessions in scope with an event in the view, slowest first. Double-click
/// opens the turn in Session · Steps, where sorting by duration finds its slowest step (SPEC §12.8 W9).
struct StatsTurnsView: View {
    let model: WindowModel
    let viewID: String
    private var request: PanelRequest<TurnsResult> { model.panels.request("stats.turns") }
    @State private var selection: Set<TurnStat.ID> = []
    @State private var sortOrder = [KeyPathComparator(\TurnStat.wallKey, order: .reverse)]

    /// The view only narrows turns when a filter or time range is set; otherwise every turn of the scope counts.
    private var narrowingView: String? { !model.appliedFilter.isEmpty || model.scope.hasTimeRange ? viewID : nil }
    private var key: String { "\(viewID)|\(model.scopeRootSessions.joined(separator: ","))" }

    var body: some View {
        VStack(spacing: 0) {
            PanelKit.HeaderBar {
                ScopeLabelView(text: label, stale: false)
            } trailing: {
                EmptyView()
            }
            if model.scopeRootSessions.isEmpty {
                ContentUnavailableView {
                    Label("Choose Sessions", systemImage: "arrow.uturn.right")
                } description: {
                    Text("Turns lists the turns of the sessions in scope. Select one or more sessions in the sidebar.")
                }
            } else if case .failed(let e) = request.phase, e.isNotServed {
                ContentUnavailableView("Turns are not available", systemImage: "arrow.uturn.right",
                                       description: Text("This engine does not serve the agent-native steps."))
            } else {
                PanelKit.RequestView(request: request, loadingTitle: "Reading turns…") { r in
                    VStack(spacing: 0) {
                        if r.rows.isEmpty {
                            ContentUnavailableView("No turns", systemImage: "arrow.uturn.right",
                                                   description: Text(r.read > 0 ? "No turn of these sessions has an event in the current view." : "These sessions have no turns."))
                        } else {
                            table(r.rows.sorted(using: sortOrder))
                        }
                        TableFooter(count: Formatters.count(r.rows.count, "turn"), hint: footer(r))
                    }
                }
            }
        }
        .task(id: key) {
            guard !model.scopeRootSessions.isEmpty, let api = model.engine.api else { return }
            let view = narrowingView
            request.load(key: key, keepValue: model.isRefreshingView) { [model] in
                try await model.viewRequest { _ in try await TurnsResult.load(model: model, api: api, view: view) }
            }
        }
    }

    private var label: String {
        guard !model.scopeRootSessions.isEmpty else { return "Turns of the sessions in scope" }
        var parts = ["Turns of " + scopeNote(model, read: maxStatsSessions) + " with subagents"]
        parts.append(narrowingView == nil ? "every turn" : "turns with an event in the view")
        return parts.joined(separator: " · ")
    }

    private func footer(_ r: TurnsResult) -> String {
        var parts = ["Double-click a turn to open it in Session · Steps."]
        if r.read > r.rows.count { parts.append("\(Formatters.count(r.read - r.rows.count, "turn")) without an event in the view are left out.") }
        if r.truncated { parts.append("Only the first \(maxStatsSessions) sessions, and at most 40,000 steps of each, were read.") }
        parts += r.gaps.map { Self.sentence($0.message) }
        return parts.joined(separator: " ")
    }

    static func sentence(_ s: String) -> String { s.hasSuffix(".") ? s : s + "." }

    private func table(_ rows: [TurnStat]) -> some View {
        let byID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return Table(rows, selection: $selection, sortOrder: $sortOrder) {
            leadColumns
            detailColumns
        }
        .alternatingRowBackgrounds(.disabled)
        .contextMenu(forSelectionType: TurnStat.ID.self) { ids in
            if let id = ids.first, let t = byID[id]?.turn { menu(t) }
        } primaryAction: { ids in
            if let id = ids.first, let t = byID[id]?.turn { model.showTurnInSession(t) }
        }
    }

    @ViewBuilder private func menu(_ t: StepTurn) -> some View {
        Button("Show in Session") { model.showTurnInSession(t) }
        Button("Narrow Filter to This Turn") { model.drillDown("turn == " + FilterExpression.quote(t.id)) }
        if t.claim != nil {
            Button("Open Claim Check") { model.openLens(LensItem(kind: .claim, id: t.id)) }
        }
        if let basis = t.impactBasis, basis.contains("#ep:") {
            Button("Open the Episode That Set the Impact") { model.openEpisode(basis) }
        }
        Divider()
        Button("Set Time Reference at Turn Start") { model.timeReference = t.startTs }
        Button("Copy Turn ID") { AppKitHelpers.copy(t.id) }
    }

    @TableColumnBuilder<TurnStat, KeyPathComparator<TurnStat>>
    private var leadColumns: some TableColumnContent<TurnStat, KeyPathComparator<TurnStat>> {
        TableColumn("Turn", value: \TurnStat.startKey) { (r: TurnStat) in
            VStack(alignment: .leading, spacing: 0) {
                Text("Turn \(r.turn.n)").font(.callout.monospacedDigit())
                Text(r.sessionTitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .help(Formatters.timestamp(r.turn.startTs))
        }
        .width(min: 80, ideal: 110)
        TableColumn("Prompt", value: \TurnStat.promptKey) { (r: TurnStat) in
            Text(r.turn.promptExcerpt ?? "(no prompt)").lineLimit(2).foregroundStyle(r.turn.promptExcerpt == nil ? .tertiary : .primary)
                .help((r.turn.origin.map { "Origin: \($0)\n" } ?? "") + (r.turn.promptExcerpt ?? ""))
        }
        .width(min: 120, ideal: 170)
        TableColumn("Wall", value: \TurnStat.wallKey) { (r: TurnStat) in
            Text(r.turn.wallUs.map { DerivedStyle.marked(Formatters.duration($0), r.turn.wallSrc) } ?? Formatters.missing)
                .font(Theme.dataFontSwiftUI(size: 12))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .help(r.turn.open ? "The turn is still open." : DerivedStyle.provHelp(r.turn.wallSrc, analysis: model.info?.analysis))
        }
        .width(min: 60, ideal: 70, max: 110)
        TableColumn("Steps", value: \TurnStat.stepsKey) { (r: TurnStat) in countText(r.turn.nSteps) }
            .width(min: 40, ideal: 44, max: 80)
        TableColumn("Episodes", value: \TurnStat.episodesKey) { (r: TurnStat) in errorText(r.turn.nEpisodes) }
            .width(min: 50, ideal: 56, max: 90)
    }

    @TableColumnBuilder<TurnStat, KeyPathComparator<TurnStat>>
    private var detailColumns: some TableColumnContent<TurnStat, KeyPathComparator<TurnStat>> {
        TableColumn("Impact", value: \TurnStat.impactRank) { (r: TurnStat) in
            VStack(alignment: .leading, spacing: 0) {
                Label(r.turn.impact.rawValue, systemImage: Mark.impact(r.turn.impact).symbol)
                    .foregroundStyle(DerivedStyle.impactColor(r.turn.impact).swiftUI)
                if r.turn.open || r.turn.unattended {
                    Text([r.turn.open ? "open" : nil, r.turn.unattended ? "unattended" : nil].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .help((r.turn.impactBasis.map { "Set by \($0)" } ?? r.turn.impact.rawValue)
                  + (r.turn.unattended ? "\nUnattended: a subagent, an active Codex goal, or no prompt in the last 3 turns with approval set to never." : ""))
        }
        .width(min: 80, ideal: 100, max: 140)
        TableColumn("Claim", value: \TurnStat.claimKey) { (r: TurnStat) in
            if let c = r.turn.claim {
                ClaimChip(evidence: c) { model.openLens(LensItem(kind: .claim, id: r.turn.id)) }
            } else {
                Text("")
            }
        }
        .width(min: 80, ideal: 100)
        TableColumn("Most Time", value: \TurnStat.topBucketKey) { (r: TurnStat) in
            if let b = r.topBucket, b.us > 0 {
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 2).fill(TimeBar.color(b.name).swiftUI).frame(width: 8, height: 8)
                    Text("\(b.name.rawValue) \(r.turn.wallUs.map { Formatters.percent(Double(b.us) / Double(max(1, $0))) } ?? Formatters.duration(b.us))")
                        .font(.callout.monospacedDigit())
                }
                .help("\(b.name.rawValue): \(Formatters.duration(b.us)) of the turn's wall time")
            } else {
                Text(Formatters.missing).foregroundStyle(.tertiary).help("Time buckets are not derived for this turn.")
            }
        }
        .width(min: 80, ideal: 100)
    }
}

/// A claim chip: the claim check's evidence, never red (SPEC §12.3.8). Clicking opens the claim in the Lens frame.
struct ClaimChip: View {
    let evidence: ClaimEvidence
    var action: (() -> Void)?

    var body: some View {
        Button { action?() } label: {
            PlainMark(mark: .claim, text: DerivedStyle.outcomeWord(evidence.rawValue), color: evidence.isUnverified ? Theme.warn : .secondaryLabelColor,
                      help: "The final message claims success; the claim check found this. Click to open the evidence.")
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}

// MARK: - Time

/// Wall time of the sessions in scope, summed over their breakdowns.
struct TimeSummary {
    var total: TimeBreakdown
    var sessions: [(id: String, time: TimeBreakdown)]
    var truncated: Bool
    var gaps: [Gap]

    /// Buckets add up by name in TIME_BUCKETS order; a part every session leaves unmeasured stays nil, never zero.
    static func sum(_ list: [TimeBreakdown]) -> TimeBreakdown {
        func add(_ values: [Int64?]) -> Int64? {
            let known = values.compactMap { $0 }
            return known.isEmpty ? nil : known.reduce(0, +)
        }
        var byName: [TimeBucketName: TimeBucket] = [:]
        for t in list {
            for b in t.buckets {
                var cur = byName[b.name] ?? TimeBucket(name: b.name, us: 0, loggedUs: 0, derivedUs: 0)
                cur.us += b.us
                cur.loggedUs += b.loggedUs
                cur.derivedUs += b.derivedUs
                byName[b.name] = cur
            }
        }
        let order = TimeBucketName.known + byName.keys.filter { !TimeBucketName.known.contains($0) }.sorted { $0.rawValue < $1.rawValue }
        return TimeBreakdown(wallUs: add(list.map(\.wallUs)), buckets: order.compactMap { byName[$0] },
                             unattributedUs: add(list.map(\.unattributedUs)), humanGapUs: add(list.map(\.humanGapUs)),
                             continuationUs: add(list.map(\.continuationUs)))
    }

    @MainActor static func load(api: APIClient, sessions: [String]) async throws -> TimeSummary {
        let picked = Array(sessions.prefix(maxStatsSessions))
        var out: [(id: String, time: TimeBreakdown)] = []
        var gaps: [Gap] = []
        for s in picked {
            let r = try await api.time(session: s)
            out.append((s, r.payload))
            for g in r.gaps where !gaps.contains(g) { gaps.append(g) }
        }
        return TimeSummary(total: sum(out.map(\.time)), sessions: out, truncated: sessions.count > picked.count, gaps: gaps)
    }

    static func describe(_ b: TimeBucketName) -> String {
        switch b.rawValue {
        case "wait-human": return "Waiting for a person: questions the agent asked"
        case "wait-agent": return "Waiting for a subagent or workflow"
        case "wait-process": return "Polling a running process: empty write_stdin, sleep, BashOutput, TaskOutput, Monitor"
        case "api-retry": return "API retries"
        case "compaction": return "Compacting the context"
        case "hook": return "Hooks"
        case "tool": return "Tool calls; includes any approval wait (data limit 2)"
        case "model": return "Model responses"
        default: return b.rawValue
        }
    }
}

/// Statistics ▸ Time: where the wall time of the sessions in scope went (SPEC §12.3.9). Time is accounted per
/// session, so the display filter does not apply; the header says so.
struct StatsTimeView: View {
    let model: WindowModel
    private var request: PanelRequest<TimeSummary> { model.panels.request("stats.time") }

    private var key: String { "\(model.scopeRootSessions.joined(separator: ","))|\(model.store.indexGeneration)" }

    var body: some View {
        VStack(spacing: 0) {
            PanelKit.HeaderBar {
                ScopeLabelView(text: label, stale: false)
            } trailing: {
                EmptyView()
            }
            if model.scopeRootSessions.isEmpty {
                ContentUnavailableView {
                    Label("Choose Sessions", systemImage: "clock")
                } description: {
                    Text("Time accounts for whole sessions. Select one or more sessions in the sidebar.")
                }
            } else if case .failed(let e) = request.phase, e.isNotServed {
                ContentUnavailableView("Time accounting is not available", systemImage: "clock",
                                       description: Text("This engine does not derive time buckets yet (SPEC §12.3.9)."))
            } else {
                PanelKit.RequestView(request: request, loadingTitle: "Accounting for time…") { s in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            breakdown(s)
                            if s.sessions.count > 1 { perSession(s) }
                            notes(s)
                        }
                        .padding(20)
                        .frame(maxWidth: 900, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .task(id: key) {
            let roots = model.scopeRootSessions
            guard !roots.isEmpty, let api = model.engine.api else { return }
            request.load(key: key, keepValue: request.value != nil) { try await TimeSummary.load(api: api, sessions: roots) }
        }
    }

    private var label: String {
        guard !model.scopeRootSessions.isEmpty else { return "Time of the sessions in scope" }
        var parts = ["Time of " + scopeNote(model, read: maxStatsSessions) + " with subagents"]
        if !model.appliedFilter.isEmpty { parts.append("filter does not apply") }
        if model.scope.hasTimeRange { parts.append("time range does not apply") }
        return parts.joined(separator: " · ")
    }

    private var single: String? { model.scopeRootSessions.count == 1 ? model.scopeRootSessions[0] : nil }

    private func breakdown(_ s: TimeSummary) -> some View {
        let t = s.total
        let accounted = t.buckets.reduce(Int64(0)) { $0 + $1.us } + (t.unattributedUs ?? 0)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Wall Time").font(.headline)
                Text(t.wallUs.map { Formatters.duration($0) } ?? Formatters.missing).font(.title3.weight(.semibold).monospacedDigit())
                    .help(t.wallUs == nil ? "No wall time could be measured." : "The sum of the turns' wall time.")
            }
            if accounted > 0 || single != nil {
                HStack(spacing: 8) {
                    if accounted > 0 {
                        TimeBar(time: t, onBucket: single.map { id in { b in self.openSteps(id, bucket: b) } })
                            .frame(height: 16)
                            .frame(maxWidth: 640)
                    }
                    if let single { criticalPathLink(single) }
                }
            }
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
                GridRow {
                    Text("Bucket")
                    Text("Time").gridColumnAlignment(.trailing)
                    Text("Share").gridColumnAlignment(.trailing)
                    Text("Logged").gridColumnAlignment(.trailing)
                    Text("Derived").gridColumnAlignment(.trailing)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                ForEach(t.buckets.filter { $0.us > 0 }, id: \.name) { b in
                    GridRow {
                        HStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 2).fill(TimeBar.color(b.name).swiftUI).frame(width: 10, height: 10)
                            Text(b.name.rawValue)
                        }
                        .help(TimeSummary.describe(b.name))
                        Text(Formatters.duration(b.us)).font(Theme.dataFontSwiftUI(size: 12))
                        Text(Formatters.percent(accounted > 0 ? Double(b.us) / Double(accounted) : nil)).font(Theme.dataFontSwiftUI(size: 12))
                        Text(Formatters.duration(b.loggedUs)).font(Theme.dataFontSwiftUI(size: 12))
                        Text(b.derivedUs > 0 ? "≈" + Formatters.duration(b.derivedUs) : Formatters.duration(0)).font(Theme.dataFontSwiftUI(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }
                GridRow {
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 2).fill(Color.secondary.opacity(0.25)).frame(width: 10, height: 10)
                        Text("unattributed")
                    }
                    .help("Time no bucket claims. It is never counted as model time.")
                    Text(t.unattributedUs.map { Formatters.duration($0) } ?? Formatters.missing).font(Theme.dataFontSwiftUI(size: 12))
                    Text(Formatters.percent(accounted > 0 ? t.unattributedUs.map { Double($0) / Double(accounted) } : nil)).font(Theme.dataFontSwiftUI(size: 12))
                    Text("")
                    Text("")
                }
                .foregroundStyle(.secondary)
                Divider().gridCellUnsizedAxes(.horizontal)
                GridRow {
                    Text("Between turns: waiting for a prompt").help("Time between a turn's end and the next prompt a person typed")
                    Text(t.humanGapUs.map { Formatters.duration($0) } ?? Formatters.missing).font(Theme.dataFontSwiftUI(size: 12))
                }
                GridRow {
                    Text("Between turns: continuations").help("Time before turns that continued without a person's prompt")
                    Text(t.continuationUs.map { Formatters.duration($0) } ?? Formatters.missing).font(Theme.dataFontSwiftUI(size: 12))
                }
            }
        }
    }

    private func perSession(_ s: TimeSummary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("By Session").font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
                ForEach(s.sessions, id: \.id) { row in
                    GridRow {
                        Button(model.store.title(of: row.id)) { openSteps(row.id, bucket: nil) }
                            .buttonStyle(.link)
                            .lineLimit(1)
                        Text(row.time.wallUs.map { Formatters.duration($0) } ?? Formatters.missing).font(Theme.dataFontSwiftUI(size: 12))
                            .gridColumnAlignment(.trailing)
                        TimeBar(time: row.time, onBucket: { b in openSteps(row.id, bucket: b) }).frame(width: 280, height: 10)
                        criticalPathLink(row.id)
                    }
                }
            }
        }
    }

    private func notes(_ s: TimeSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if s.truncated { Text("Only the first \(maxStatsSessions) sessions of the scope were read.") }
            Text("Each bucket claims time in priority order: waiting for a person, a subagent or a process, then API retries, compaction, hooks, tools and the model. Hatched parts are derived from timestamps.")
            if single != nil { Text("Click a bucket to list the steps with time in it.") }
            if !s.gaps.isEmpty { GapList(gaps: s.gaps) }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func openSteps(_ session: String, bucket: TimeBucketName?) {
        model.openSession(session, mode: .steps)
        model.steps.bucket = bucket
    }

    /// Show Critical Path (ANALYSIS-UX §3.8) at the trailing end of a run's time bar, as in the Steps run report: this
    /// tab sums every bucket, and Critical Path follows the one chain of waits that set the run's length.
    private func criticalPathLink(_ session: String) -> some View {
        Button("Critical Path") { model.openSession(session, mode: .criticalPath) }
            .buttonStyle(.link)
            .font(Theme.fontSwiftUI(.rowSecondary))
            .fixedSize()
            .help(TimeLegend.criticalPathNote)
            .accessibilityLabel("Show Critical Path of \(model.store.title(of: session))")
    }
}

// MARK: - Turn in Session

extension WindowModel {
    /// Session · Steps with the turn selected and expanded (Statistics ▸ Turns, the claim and impact links).
    func showTurnInSession(_ t: StepTurn) {
        sessionMode = .steps
        if scope.sessions.contains(t.sessionId) {
            singleSessionChoice = t.sessionId
            workspace = .session
        } else if let root = scopeRootSessions.first(where: { hasAncestor(t.sessionId, in: [$0]) }) {
            singleSessionChoice = root
            steps.descendants = true
            workspace = .session
        } else {
            openSession(t.sessionId, workspace: .session)
        }
        steps.focus(turn: t.id)
    }
}
