import SwiftUI

// Kinds, Tools, Models and Pairs: native sortable tables. Double-click narrows the filter with AND (SPEC §7.8);
// Replace and the other combine modes are explicit context-menu choices.

/// Context menu for drill-down rows: narrow, show the events, the six combine modes, and Copy.
struct DrillDownMenu: View {
    let model: WindowModel
    let fragment: String?
    let copyTitle: String
    let copyText: String

    var body: some View {
        if let fragment {
            Button("Narrow Filter to Selection") { model.drillDown(fragment) }
            Button("Show Matching Events") {
                model.drillDown(fragment)
                model.workspace = .events
            }
            Divider()
            PanelKit.FilterMenus(model: model, fragment: fragment)
            Divider()
        }
        Button(copyTitle) { AppKitHelpers.copy(copyText) }
    }
}

/// The caption bar under a statistics table.
struct TableFooter: View {
    let count: String
    let hint: String

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 12) {
                Text(count).monospacedDigit()
                Text(hint).lineLimit(3).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
        }
    }
}

/// `field in {"a", "b"}` for several values, `field == "a"` for one.
func membership(_ field: String, _ values: [String]) -> String? {
    switch values.count {
    case 0: return nil
    case 1: return "\(field) == \(FilterExpression.quote(values[0]))"
    default: return "\(field) in {\(values.map(FilterExpression.quote).joined(separator: ", "))}"
    }
}

func countText(_ n: Int) -> some View {
    Text(Formatters.count(n)).font(Theme.dataFontSwiftUI(size: 12)).frame(maxWidth: .infinity, alignment: .trailing)
}

func errorText(_ n: Int) -> some View {
    Text(Formatters.count(n))
        .font(Theme.dataFontSwiftUI(size: 12))
        .foregroundStyle(n > 0 ? Theme.err.swiftUI : .primary)
        .frame(maxWidth: .infinity, alignment: .trailing)
}

func durationText(_ us: Int64?, missing: String) -> some View {
    Text(Formatters.duration(us, src: nil))
        .font(Theme.dataFontSwiftUI(size: 12))
        .frame(maxWidth: .infinity, alignment: .trailing)
        .help(us == nil ? missing : Formatters.count(Int(us! / 1000)) + " ms")
}

// MARK: - Kinds

/// One row of the kind hierarchy: a layer, a kind or a record type (`proto`).
struct KindRow: Identifiable, Hashable {
    enum Level: Hashable { case layer, kind, recordType }

    let id: String
    let name: String
    let level: Level
    let count: Int
    let bytes: Int64
    /// Share of all events in the view.
    let share: Double
    /// Share of all source bytes in the view.
    let byteShare: Double
    var children: [KindRow]?

    /// The filter that selects this row's events.
    var fragment: String {
        switch level {
        case .layer: return name
        case .kind: return FilterExpression.kind(EventKind(rawValue: name))
        case .recordType: return "proto == \(FilterExpression.quote(name))"
        }
    }

    static func rows(_ nodes: [KindNode], total: Int, totalBytes: Int64? = nil, prefix: String = "") -> [KindRow] {
        let bytes = totalBytes ?? nodes.reduce(0) { $0 + $1.bytes }
        return nodes.map { n in
            let level: Level = n.name.contains("/") ? .recordType : EventKind.layers.contains(n.name) ? .layer : .kind
            let id = prefix + "/" + n.name
            let kids = rows(n.children, total: total, totalBytes: bytes, prefix: id)
            return KindRow(id: id, name: n.name, level: level, count: n.count, bytes: n.bytes,
                           share: total > 0 ? Double(n.count) / Double(total) : 0,
                           byteShare: bytes > 0 ? Double(n.bytes) / Double(bytes) : 0, children: kids.isEmpty ? nil : kids)
        }
    }

    /// Sorted at every level.
    static func sorted(_ rows: [KindRow], using order: [KeyPathComparator<KindRow>]) -> [KindRow] {
        rows.sorted(using: order).map { r in
            var r = r
            r.children = r.children.map { sorted($0, using: order) }
            return r
        }
    }

    var symbol: String {
        switch level {
        case .recordType: return "doc.plaintext"
        case .kind: return Symbols.eventKind(EventKind(rawValue: name))
        case .layer:
            switch name {
            case "user": return "person.fill"
            case "llm": return "sparkles"
            case "tool": return "wrench.and.screwdriver"
            case "agent": return "person.2"
            case "context": return "paperclip"
            case "session": return "info.circle"
            case "turn": return "arrow.uturn.right"
            case "hook": return "bolt.horizontal"
            case "permission": return "lock.shield"
            case "harness": return "gearshape"
            default: return "questionmark.square.dashed"
            }
        }
    }

    var color: Color {
        switch level {
        case .recordType: return .secondary
        case .layer: return Theme.kindColor(EventKind(rawValue: name + ".")).swiftUI
        case .kind: return Theme.kindColor(EventKind(rawValue: name)).swiftUI
        }
    }
}

struct StatsKindsView: View {
    let model: WindowModel
    let viewID: String
    /// Kept per window and view, so re-entering this section shows the computed result instead of computing again.
    private var request: PanelRequest<[KindNode]> { model.panels.request("stats.kinds") }
    @State private var selection: Set<KindRow.ID> = []
    @State private var sortOrder = [KeyPathComparator(\KindRow.count, order: .reverse)]

    var body: some View {
        PanelKit.RequestView(request: request, loadingTitle: "Counting kinds…") { tree in
            let total = tree.reduce(0) { $0 + $1.count }
            let rows = KindRow.sorted(KindRow.rows(tree, total: total), using: sortOrder)
            let byID = Self.index(rows)
            VStack(spacing: 0) {
                if rows.isEmpty {
                    ContentUnavailableView("No events in this view", systemImage: "square.stack.3d.up")
                } else {
                    Table(rows, children: \.children, selection: $selection, sortOrder: $sortOrder) {
                        TableColumn("Layer / Kind / Record Type", value: \.name) { r in
                            Label {
                                Text(r.name)
                                    .font(r.level == .recordType ? Theme.fontSwiftUI(.code) : .body)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            } icon: {
                                Image(systemName: r.symbol).foregroundStyle(r.color).frame(width: 18)
                            }
                            .symbolRenderingMode(.hierarchical)
                            .help(r.fragment)
                        }
                        .width(min: 220, ideal: 360)
                        TableColumn("Events", value: \.count) { r in countText(r.count) }
                            .width(min: 70, ideal: 90)
                        TableColumn("Share", value: \.share) { r in
                            HStack(spacing: 6) {
                                Text(Formatters.percent(r.share))
                                    .font(Theme.dataFontSwiftUI(size: 12))
                                    .frame(width: 52, alignment: .trailing)
                                PanelKit.ShareBar(fraction: r.share)
                            }
                        }
                        .width(min: 120, ideal: 170)
                        TableColumn("Bytes", value: \.bytes) { r in
                            HStack(spacing: 6) {
                                Text(Formatters.bytes(r.bytes))
                                    .font(Theme.dataFontSwiftUI(size: 12))
                                    .frame(width: 62, alignment: .trailing)
                                PanelKit.ShareBar(fraction: r.byteShare)
                            }
                            .help("\(Formatters.count(Int(r.bytes))) bytes of source records, \(Formatters.percent(r.byteShare)) of the view")
                        }
                        .width(min: 120, ideal: 170)
                    }
                    .contextMenu(forSelectionType: KindRow.ID.self) { ids in
                        let picked = ids.compactMap { byID[$0] }
                        DrillDownMenu(model: model, fragment: Self.fragment(picked), copyTitle: "Copy Name",
                                      copyText: picked.map(\.name).joined(separator: "\n"))
                    } primaryAction: { ids in
                        if let f = Self.fragment(ids.compactMap { byID[$0] }) { model.drillDown(f) }
                    }
                }
                TableFooter(count: Formatters.count(total, "event"),
                            hint: "Double-click a row to narrow the filter to it. Bytes are the size of the source records; blocks of one line count once.")
            }
        }
        .task(id: viewID) {
            request.load(key: viewID, keepValue: model.isRefreshingView) { [model, viewID] in try await model.viewRequest { try await $0.statsKinds(view: viewID) } }
        }
    }

    private static func index(_ rows: [KindRow]) -> [KindRow.ID: KindRow] {
        var out: [KindRow.ID: KindRow] = [:]
        func walk(_ rs: [KindRow]) {
            for r in rs {
                out[r.id] = r
                walk(r.children ?? [])
            }
        }
        walk(rows)
        return out
    }

    private static func fragment(_ rows: [KindRow]) -> String? {
        switch rows.count {
        case 0: return nil
        case 1: return rows[0].fragment
        default: return rows.map { "(\($0.fragment))" }.joined(separator: " || ")
        }
    }
}

// MARK: - Tools

extension ToolStat {
    var errorRate: Double { calls > 0 ? Double(errors) / Double(calls) : 0 }
    /// Sort keys: unknown durations sort below every known one.
    var p50Key: Int64 { p50 ?? -1 }
    var p90Key: Int64 { p90 ?? -1 }
    var p99Key: Int64 { p99 ?? -1 }
    var maxKey: Int64 { self.max ?? -1 }
    var agentsText: String { agents.map(PanelKit.agentLabel).joined(separator: ", ") }
}

struct StatsToolsView: View {
    let model: WindowModel
    let viewID: String
    /// Kept per window and view, so re-entering this section shows the computed result instead of computing again.
    private var request: PanelRequest<[ToolStat]> { model.panels.request("stats.tools") }
    @State private var selection: Set<ToolStat.ID> = []
    @State private var sortOrder = [KeyPathComparator(\ToolStat.calls, order: .reverse)]

    private static let noDuration = "No call of this tool has a known duration."

    var body: some View {
        PanelKit.RequestView(request: request, loadingTitle: "Measuring tools…") { tools in
            VStack(spacing: 0) {
                if tools.isEmpty {
                    ContentUnavailableView("No tool calls in this view", systemImage: "wrench.and.screwdriver",
                                           description: Text("The events in the current view contain no tool calls."))
                } else {
                    table(tools.sorted(using: sortOrder))
                }
                TableFooter(count: Formatters.count(tools.count, "tool"),
                            hint: "Double-click a tool to narrow the filter to it. Durations are logged where the agent wrote them, otherwise derived from the call and result times; percentiles cover calls with a known duration.")
            }
        }
        .task(id: viewID) {
            request.load(key: viewID, keepValue: model.isRefreshingView) { [model, viewID] in try await model.viewRequest { try await $0.statsTools(view: viewID) } }
        }
    }

    private func table(_ tools: [ToolStat]) -> some View {
        Table(tools, selection: $selection, sortOrder: $sortOrder) {
            nameColumns
            timeColumns
        }
        .alternatingRowBackgrounds(.disabled)
        .contextMenu(forSelectionType: ToolStat.ID.self) { ids in
            let names = tools.map(\.tool).filter(ids.contains)
            DrillDownMenu(model: model, fragment: membership("tool.name", names), copyTitle: "Copy Tool Name",
                          copyText: names.joined(separator: "\n"))
        } primaryAction: { ids in
            if let f = membership("tool.name", tools.map(\.tool).filter(ids.contains)) { model.drillDown(f) }
        }
    }

    @TableColumnBuilder<ToolStat, KeyPathComparator<ToolStat>>
    private var nameColumns: some TableColumnContent<ToolStat, KeyPathComparator<ToolStat>> {
        TableColumn("Tool", value: \ToolStat.tool) { (t: ToolStat) in
            Label {
                Text(t.tool).font(Theme.fontSwiftUI(.code)).lineLimit(1).truncationMode(.middle)
            } icon: {
                Image(systemName: Symbols.toolKind(t.kind)).foregroundStyle(.secondary).frame(width: 18)
            }
            .help(t.tool)
        }
        .width(min: 120, ideal: 190, max: 360)
        TableColumn("Kind", value: \ToolStat.kind) { (t: ToolStat) in Text(t.kind).foregroundStyle(.secondary) }
            .width(min: 40, ideal: 50, max: 80)
        TableColumn("Calls", value: \ToolStat.calls) { (t: ToolStat) in countText(t.calls) }
            .width(min: 44, ideal: 56, max: 90)
        TableColumn("Errors", value: \ToolStat.errors) { (t: ToolStat) in errorText(t.errors) }
            .width(min: 40, ideal: 50, max: 90)
        TableColumn("Error Rate", value: \ToolStat.errorRate) { (t: ToolStat) in
            Text(t.calls > 0 ? Formatters.percent(t.errorRate) : Formatters.missing)
                .font(Theme.dataFontSwiftUI(size: 12))
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .width(min: 50, ideal: 62, max: 90)
    }

    @TableColumnBuilder<ToolStat, KeyPathComparator<ToolStat>>
    private var timeColumns: some TableColumnContent<ToolStat, KeyPathComparator<ToolStat>> {
        durationColumn("p50", \.p50Key) { $0.p50 }
        durationColumn("p90", \.p90Key) { $0.p90 }
        durationColumn("p99", \.p99Key) { $0.p99 }
        durationColumn("Max", \.maxKey) { $0.max }
        durationColumn("Total Time", \.total) { $0.total }
        TableColumn("Agents", value: \ToolStat.agentsText) { (t: ToolStat) in
            Text(t.agentsText).foregroundStyle(.secondary).lineLimit(1).help(t.agentsText)
        }
        .width(min: 60, ideal: 100)
    }

    private func durationColumn(_ title: String, _ key: KeyPath<ToolStat, Int64>, _ value: @escaping (ToolStat) -> Int64?)
        -> some TableColumnContent<ToolStat, KeyPathComparator<ToolStat>> {
        TableColumn(title, value: key) { (t: ToolStat) in durationText(value(t), missing: Self.noDuration) }
            .width(min: 48, ideal: 60, max: 100)
    }
}

// MARK: - Models

extension ModelStat {
    var inputKey: Int { tokens.input ?? -1 }
    var outputKey: Int { tokens.output ?? -1 }
    var cacheReadKey: Int { tokens.cache_read ?? -1 }
    var cacheWriteKey: Int { tokens.cache_write ?? -1 }
    var cacheHitKey: Double { cacheHitRatio ?? -1 }
    var latencyP50Key: Int64 { latencyP50 ?? -1 }
    var latencyP90Key: Int64 { latencyP90 ?? -1 }
}

struct StatsModelsView: View {
    let model: WindowModel
    let viewID: String
    /// Kept per window and view, so re-entering this section shows the computed result instead of computing again.
    private var request: PanelRequest<[ModelStat]> { model.panels.request("stats.models") }
    @State private var selection: Set<ModelStat.ID> = []
    @State private var sortOrder = [KeyPathComparator(\ModelStat.calls, order: .reverse)]

    private static let noLatency = "The agent logged no latency for this model, and none could be derived."

    var body: some View {
        PanelKit.RequestView(request: request, loadingTitle: "Summarizing models…") { models in
            VStack(spacing: 0) {
                if models.isEmpty {
                    ContentUnavailableView("No model calls in this view", systemImage: "cpu",
                                           description: Text("The events in the current view contain no model responses."))
                } else {
                    table(models.sorted(using: sortOrder))
                }
                TableFooter(count: Formatters.count(models.count, "model"),
                            hint: "Double-click a model to narrow the filter to it. Input counts every prompt token, cached or not; cache hit is cache read ÷ input.")
            }
        }
        .task(id: viewID) {
            request.load(key: viewID, keepValue: model.isRefreshingView) { [model, viewID] in try await model.viewRequest { try await $0.statsModels(view: viewID) } }
        }
    }

    private func table(_ models: [ModelStat]) -> some View {
        Table(models, selection: $selection, sortOrder: $sortOrder) {
            TableColumn("Model", value: \ModelStat.model) { (m: ModelStat) in
                Text(m.model).lineLimit(1).truncationMode(.middle).help(m.model)
            }
            .width(min: 120, ideal: 200, max: 360)
            TableColumn("Calls", value: \ModelStat.calls) { (m: ModelStat) in countText(m.calls) }
                .width(min: 44, ideal: 56, max: 90)
            tokenColumns
            latencyColumns
        }
        .contextMenu(forSelectionType: ModelStat.ID.self) { ids in
            let names = models.map(\.model).filter(ids.contains)
            DrillDownMenu(model: model, fragment: membership("model", names), copyTitle: "Copy Model Name",
                          copyText: names.joined(separator: "\n"))
        } primaryAction: { ids in
            if let f = membership("model", models.map(\.model).filter(ids.contains)) { model.drillDown(f) }
        }
    }

    @TableColumnBuilder<ModelStat, KeyPathComparator<ModelStat>>
    private var tokenColumns: some TableColumnContent<ModelStat, KeyPathComparator<ModelStat>> {
        tokenColumn("Input", \.inputKey) { $0.tokens.input }
        tokenColumn("Output", \.outputKey) { $0.tokens.output }
        tokenColumn("Cache Read", \.cacheReadKey) { $0.tokens.cache_read }
        tokenColumn("Cache Write", \.cacheWriteKey) { $0.tokens.cache_write }
    }

    @TableColumnBuilder<ModelStat, KeyPathComparator<ModelStat>>
    private var latencyColumns: some TableColumnContent<ModelStat, KeyPathComparator<ModelStat>> {
        TableColumn("Cache Hit", value: \ModelStat.cacheHitKey) { (m: ModelStat) in
            Text(Formatters.percent(m.cacheHitRatio))
                .font(Theme.dataFontSwiftUI(size: 12))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .help("Cache read ÷ input tokens")
        }
        .width(min: 50, ideal: 62, max: 90)
        TableColumn("Latency p50", value: \ModelStat.latencyP50Key) { (m: ModelStat) in
            durationText(m.latencyP50, missing: Self.noLatency)
        }
        .width(min: 60, ideal: 76, max: 110)
        TableColumn("Latency p90", value: \ModelStat.latencyP90Key) { (m: ModelStat) in
            durationText(m.latencyP90, missing: Self.noLatency)
        }
        .width(min: 60, ideal: 76, max: 110)
    }

    private func tokenColumn(_ title: String, _ key: KeyPath<ModelStat, Int>, _ value: @escaping (ModelStat) -> Int?)
        -> some TableColumnContent<ModelStat, KeyPathComparator<ModelStat>> {
        TableColumn(title, value: key) { (m: ModelStat) in
            let n = value(m)
            Text(Formatters.tokens(n))
                .font(Theme.dataFontSwiftUI(size: 12))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .help(n.map { Formatters.count($0) + " tokens" } ?? "Not logged")
        }
        .width(min: 52, ideal: 70, max: 110)
    }
}

// MARK: - Pairs

/// A pair from /api/stats/pairs: an agent and a tool it called, or a parent session and its subagent.
struct PairRow: Identifiable, Hashable {
    let id: String
    let isSubagent: Bool
    let a: String
    let b: String
    let aLabel: String
    let bLabel: String
    let count: Int
    let dur: Int64
    let errors: Int

    var type: String { isSubagent ? "Subagent" : "Tool call" }
    var mean: Int64 { count > 0 ? dur / Int64(count) : 0 }
    /// The engine sums known durations and reports 0 when none was measured; that is missing, not a measured zero.
    var knownDur: Int64? { dur > 0 ? dur : nil }
    static let noDuration = "No duration was measured for this pair."

    var fragment: String {
        isSubagent ? FilterExpression.session(b) : "agent == \(FilterExpression.quote(a)) && \(FilterExpression.tool(b))"
    }
}

struct StatsPairsView: View {
    let model: WindowModel
    let viewID: String
    /// Kept per window and view, so re-entering this section shows the computed result instead of computing again.
    private var request: PanelRequest<[PairStat]> { model.panels.request("stats.pairs") }
    @State private var selection: Set<PairRow.ID> = []
    @State private var sortOrder = [KeyPathComparator(\PairRow.count, order: .reverse)]

    var body: some View {
        PanelKit.RequestView(request: request, loadingTitle: "Counting pairs…") { pairs in
            let rows = pairs.map(row).sorted(using: sortOrder)
            VStack(spacing: 0) {
                if rows.isEmpty {
                    ContentUnavailableView("No pairs in this view", systemImage: "arrow.left.arrow.right",
                                           description: Text("The view has no tool calls and no subagent sessions."))
                } else {
                    table(rows)
                }
                TableFooter(count: Formatters.count(rows.count, "pair"),
                            hint: "Tool call rows pair an agent with a tool it called; subagent rows pair a parent session with a child. Double-click a row to narrow the filter to it.")
            }
        }
        .task(id: viewID) {
            request.load(key: viewID, keepValue: model.isRefreshingView) { [model, viewID] in try await model.viewRequest { try await $0.statsPairs(view: viewID) } }
        }
    }

    private func row(_ p: PairStat) -> PairRow {
        let sub = PanelKit.isSessionID(p.b)
        let label = { (s: String) in PanelKit.isSessionID(s) ? model.store.title(of: s) : AgentKind(rawValue: s).label }
        return PairRow(id: p.id, isSubagent: sub, a: p.a, b: p.b, aLabel: label(p.a), bLabel: sub ? label(p.b) : p.b,
                       count: p.count, dur: p.dur, errors: p.errors)
    }

    private func table(_ rows: [PairRow]) -> some View {
        Table(rows, selection: $selection, sortOrder: $sortOrder) {
            pairColumns
            measureColumns
        }
        .contextMenu(forSelectionType: PairRow.ID.self) { ids in
            let picked = rows.filter { ids.contains($0.id) }
            DrillDownMenu(model: model, fragment: Self.fragment(picked), copyTitle: "Copy Pair",
                          copyText: picked.map { "\($0.a)\t\($0.b)" }.joined(separator: "\n"))
            if picked.count == 1, picked[0].isSubagent {
                Divider()
                Button("Open Subagent Session") { model.openSession(picked[0].b) }
            }
        } primaryAction: { ids in
            if let f = Self.fragment(rows.filter { ids.contains($0.id) }) { model.drillDown(f) }
        }
    }

    @TableColumnBuilder<PairRow, KeyPathComparator<PairRow>>
    private var pairColumns: some TableColumnContent<PairRow, KeyPathComparator<PairRow>> {
        TableColumn("Type", value: \PairRow.type) { (r: PairRow) in
            Label {
                Text(r.type)
            } icon: {
                Image(systemName: r.isSubagent ? "person.2" : "wrench").frame(width: 18)
            }
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(.secondary)
        }
        .width(min: 72, ideal: 90, max: 120)
        TableColumn("A", value: \PairRow.aLabel) { (r: PairRow) in
            Text(r.aLabel).lineLimit(1).truncationMode(.middle).help(r.a)
        }
        .width(min: 100, ideal: 200, max: 360)
        TableColumn("B", value: \PairRow.bLabel) { (r: PairRow) in
            Text(r.bLabel)
                .font(r.isSubagent ? .body : Theme.fontSwiftUI(.code))
                .lineLimit(1)
                .truncationMode(.middle)
                .help(r.b)
        }
        .width(min: 100, ideal: 220, max: 360)
    }

    @TableColumnBuilder<PairRow, KeyPathComparator<PairRow>>
    private var measureColumns: some TableColumnContent<PairRow, KeyPathComparator<PairRow>> {
        TableColumn("Count", value: \PairRow.count) { (r: PairRow) in countText(r.count) }
            .width(min: 44, ideal: 60, max: 90)
        TableColumn("Total Time", value: \PairRow.dur) { (r: PairRow) in durationText(r.knownDur, missing: PairRow.noDuration) }
            .width(min: 56, ideal: 72, max: 110)
        TableColumn("Mean", value: \PairRow.mean) { (r: PairRow) in durationText(r.knownDur.map { _ in r.mean }, missing: PairRow.noDuration) }
            .width(min: 50, ideal: 64, max: 100)
        TableColumn("Errors", value: \PairRow.errors) { (r: PairRow) in errorText(r.errors) }
            .width(min: 40, ideal: 52, max: 90)
    }

    private static func fragment(_ rows: [PairRow]) -> String? {
        switch rows.count {
        case 0: return nil
        case 1: return rows[0].fragment
        default: return rows.map { "(\($0.fragment))" }.joined(separator: " || ")
        }
    }
}
