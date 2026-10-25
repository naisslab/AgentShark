import SwiftUI

/// The sections of the Statistics workspace.
enum StatsSection: String, CaseIterable, Identifiable {
    case summary, kinds, tools, models, performance, turns, time, endpoints, io, pairs

    var id: Self { self }

    var title: String {
        switch self {
        case .summary: return "Summary"
        case .kinds: return "Kinds"
        case .tools: return "Tools"
        case .models: return "Models"
        case .performance: return "Performance"
        case .turns: return "Turns"
        case .time: return "Time"
        case .endpoints: return "Endpoints"
        case .io: return "I/O Graph"
        case .pairs: return "Pairs"
        }
    }

    var symbol: String {
        switch self {
        case .summary: return "list.bullet.clipboard"
        case .kinds: return "square.stack.3d.up"
        case .tools: return "wrench.and.screwdriver"
        case .models: return "cpu"
        case .performance: return "speedometer"
        case .turns: return "arrow.uturn.right"
        case .time: return "clock"
        case .endpoints: return "point.3.connected.trianglepath.dotted"
        case .io: return "chart.xyaxis.line"
        case .pairs: return "arrow.left.arrow.right"
        }
    }

    var help: String {
        switch self {
        case .summary: return "Counts, time span, tokens and logged cost of the current view"
        case .kinds: return "Events by layer, kind and record type, with their share and source bytes"
        case .tools: return "Service response time per tool, MCP server, program, host or model: percentiles with their coverage, duration sources and failures by tier"
        case .models: return "Calls, tokens, cache hits and latency per model"
        case .performance:
            return "Time to first token, output tokens per second and call latency, with sample coverage.\n"
                + "For one run's critical path, use Session ▸ Critical Path (\(AgentSharkCommands.modeShortcut(.criticalPath).keys))."
        case .turns: return "The turns of the sessions in scope, slowest first: wall time, impact, claim and where the time went"
        case .time: return "Wall time of the sessions in scope by bucket: waiting, tools, model, and what no bucket claims"
        case .endpoints: return "MCP servers, web hosts, hooks, shell programs and agent types: calls, sessions, failures and durations"
        case .io: return "Events, errors, tokens or latency over time"
        case .pairs: return "Agent and tool pairs, and parent and subagent sessions"
        }
    }
}

/// Statistics (MAC-SPEC §7, SPEC §7.5). Every section follows the window's view: filter, sessions and time range.
/// Without a valid view nothing is requested, so a failed view never turns into whole-index numbers (SPEC §7.8).
struct StatsWorkspace: View {
    @Bindable var model: WindowModel
    @AppStorage("stats.section") private var section: StatsSection = .summary

    var body: some View {
        // The workspace header (DESIGN.md §7.13): the tab strip on the left, the scope label after it.
        VStack(spacing: 0) {
            WorkspaceHeader(model: model, label: section == .time ? "Wall time of the sessions in scope" : model.scopeLabel(for: .stats)) {
                ViewThatFits(in: .horizontal) {
                    Picker("Section", selection: $section) {
                        ForEach(StatsSection.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    Picker("Section", selection: $section) {
                        ForEach(StatsSection.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                .help(section.help)
            } controls: {
                EmptyView()
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private var content: some View {
        if section == .time {
            // Time accounts for whole sessions: it does not depend on the view.
            StatsTimeView(model: model)
        } else if let view = model.view, view.count > 0 {
            switch section {
            case .summary: StatsSummaryView(model: model, viewID: view.viewId)
            case .kinds: StatsKindsView(model: model, viewID: view.viewId)
            case .tools: StatsSRTView(model: model, viewID: view.viewId)
            case .models: StatsModelsView(model: model, viewID: view.viewId)
            case .performance: StatsPerformanceView(model: model, viewID: view.viewId)
            case .turns: StatsTurnsView(model: model, viewID: view.viewId)
            case .time: EmptyView()
            case .endpoints: StatsEndpointsView(model: model, viewID: view.viewId)
            case .io: IOGraphView(model: model, view: view)
            case .pairs: StatsPairsView(model: model, viewID: view.viewId)
            }
        } else {
            PanelKit.ViewPhaseView(model: model, phase: model.viewPhase)
        }
    }
}

extension WindowModel {
    /// The engine's client for panel requests; throws a presentable error while the engine is down.
    func panelAPI() throws -> APIClient {
        guard let api = engine.api else {
            throw APIError(status: 0, message: "The AgentShark engine is not running.", code: "unreachable", start: nil, end: nil)
        }
        return api
    }

    /// A request scoped by the current view. When the engine no longer knows the view (it restarted or evicted it),
    /// the view is rebuilt, and the new view ID reloads the panel; nothing falls back to unscoped data.
    func viewRequest<T>(_ body: (APIClient) async throws -> T) async throws -> T {
        do {
            return try await body(panelAPI())
        } catch let e as APIError where e.isViewGone || e.code == "view_expired" {
            rebuildView(reason: .refresh)
            throw e
        }
    }
}

// MARK: - Summary

struct StatsSummaryView: View {
    let model: WindowModel
    let viewID: String
    /// Kept per window and view, so re-entering this section shows the computed result instead of computing again.
    private var request: PanelRequest<StatsSummary> { model.panels.request("stats.summary") }

    var body: some View {
        PanelKit.RequestView(request: request, loadingTitle: "Computing the summary…") { s in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    tiles(s)
                    HStack(alignment: .top, spacing: 28) {
                        tokens(s.tokens).frame(maxWidth: 460, alignment: .leading)
                        byAgent(s).frame(maxWidth: 420, alignment: .leading)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: viewID) {
            request.load(key: viewID, keepValue: model.isRefreshingView) { [model, viewID] in try await model.viewRequest { try await $0.statsSummary(view: viewID) } }
        }
    }

    private func tiles(_ s: StatsSummary) -> some View {
        let span = s.firstTs.flatMap { f in s.lastTs.map { $0 - f } }
        return VStack(alignment: .leading, spacing: 8) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 128, maximum: 200), spacing: 10, alignment: .leading)],
                      alignment: .leading, spacing: 10) {
                // Full counts with separators, as the header prints them (Principle 2); the label's noun follows the count.
                MetricTile(label: s.events == 1 ? "Event" : "Events", value: Formatters.count(s.events), help: Formatters.count(s.events, "event"))
                MetricTile(label: s.sessions == 1 ? "Session" : "Sessions", value: Formatters.count(s.sessions),
                           help: "\(Formatters.count(s.sessions, "session")) with at least one event in the view. Subagents count as their own sessions.")
                MetricTile(label: s.llmCalls == 1 ? "Model call" : "Model calls", value: Formatters.count(s.llmCalls),
                           help: "\(Formatters.count(s.llmCalls, "model response")) in the view")
                MetricTile(label: s.toolCalls == 1 ? "Tool call" : "Tool calls", value: Formatters.count(s.toolCalls), help: Formatters.count(s.toolCalls, "tool call"))
                MetricTile(label: s.errors == 1 ? "Error" : "Errors", value: Formatters.count(s.errors), help: Formatters.count(s.errors, "event") + " flagged as errors",
                           symbol: s.errors > 0 ? "exclamationmark.octagon.fill" : nil, tint: s.errors > 0 ? Theme.err.swiftUI : nil)
                MetricTile(label: "Time span", value: span.map { Formatters.duration($0) } ?? Formatters.missing,
                           help: span == nil ? "No event in the view has a timestamp." : Formatters.timeRange(from: s.firstTs, to: s.lastTs))
                MetricTile(label: "Logged cost", value: s.loggedCostUsd.map(Self.usd) ?? Formatters.missing,
                           help: s.loggedCostUsd == nil
                               ? "None of these sessions logged a cost. AgentShark does not estimate prices."
                               : "Sum of the costs the agents logged for the sessions in this view. AgentShark does not estimate prices.")
            }
            if s.firstTs != nil || s.lastTs != nil {
                Text(Formatters.timeRange(from: s.firstTs, to: s.lastTs))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    /// `$1,981.25`; small amounts keep four decimals.
    private static func usd(_ v: Double) -> String {
        "$" + v.formatted(.number.grouping(.automatic).precision(.fractionLength(v < 1 ? 4 : 2)))
    }

    private func tokens(_ t: TokenUsage) -> some View {
        let rows: [(String, Int?, String)] = [
            ("Input", t.input, "Every prompt token, cached or not"),
            ("Uncached input", t.uncached, "Prompt tokens not served from the cache"),
            ("Cache read", t.cache_read, "Prompt tokens served from the cache"),
            ("Cache write", t.cache_write, "Prompt tokens written to the cache"),
            ("Output", t.output, "Generated tokens"),
            ("Reasoning", t.reasoning, "Reasoning tokens, part of the output where the provider reports them"),
        ]
        let present = rows.filter { $0.1 != nil }
        let hit = t.input.flatMap { $0 > 0 ? Double(t.cache_read ?? 0) / Double($0) : nil }
        return VStack(alignment: .leading, spacing: 8) {
            Text("Tokens").font(.headline)
            if present.isEmpty {
                Text("No token usage was logged for the events in this view.")
                    .foregroundStyle(.secondary)
            } else {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                    ForEach(present, id: \.0) { row in
                        GridRow {
                            Text(row.0).help(row.2)
                            Text(Formatters.tokens(row.1))
                                .font(Theme.dataFontSwiftUI(size: 12))
                                .gridColumnAlignment(.trailing)
                                .help(row.1.map { Formatters.count($0) } ?? Formatters.missing)
                        }
                    }
                    Divider().gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        Text("Cache hit ratio").help("Cache read tokens of all input tokens")
                        Text(Formatters.percent(hit)).font(Theme.dataFontSwiftUI(size: 12))
                        PanelKit.ShareBar(fraction: hit ?? 0).frame(width: 160)
                    }
                }
                Text("Totals sum the model responses that have at least one event in this view.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func byAgent(_ s: StatsSummary) -> some View {
        let total = Double(max(1, s.events))
        return VStack(alignment: .leading, spacing: 8) {
            Text("By agent").font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    Text("Agent")
                    Text("Sessions").gridColumnAlignment(.trailing)
                    Text("Events").gridColumnAlignment(.trailing)
                    Text("Share")
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                ForEach(s.byAgent.sorted { $0.events > $1.events }, id: \.agent) { a in
                    GridRow {
                        AgentName(agent: AgentKind(rawValue: a.agent))
                        Text(Formatters.count(a.sessions)).font(Theme.dataFontSwiftUI(size: 12))
                        Text(Formatters.count(a.events)).font(Theme.dataFontSwiftUI(size: 12))
                        PanelKit.ShareBar(fraction: Double(a.events) / total).frame(width: 120)
                            .help(Formatters.percent(Double(a.events) / total))
                    }
                }
            }
        }
    }
}

/// One summary number with its label; the tooltip gives the exact value or an explanation.
private struct MetricTile: View {
    let label: String
    let value: String
    let help: String
    var symbol: String?
    var tint: Color?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                if let symbol { Image(systemName: symbol).imageScale(.small) }
                Text(value)
            }
            .font(.title3.weight(.semibold).monospacedDigit())
            .foregroundStyle(tint ?? .primary)
            Text(label).font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 7).fill(.quinary))
        .help(help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(value)")
        .accessibilityHint(help)
    }
}
