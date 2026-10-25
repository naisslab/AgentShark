import Charts
import SwiftUI

/// I/O Graph metrics (`IoMetric` and `DerivedIoMetric` in src/index/api.ts).
enum IOMetric: String, CaseIterable, Identifiable {
    case events
    case errors
    case tokensInput = "tokens.input"
    case tokensOutput = "tokens.output"
    case toolCalls = "tool.calls"
    case llmCalls = "llm.calls"
    case latencyMean = "latency.mean"
    case ttftMean = "ttft.mean"
    case outputRateMean = "output.rate.mean"
    case contextTokens = "context.tokens"
    case failures = "failures.failure"
    case suspect = "failures.suspect"
    case benign = "failures.benign"
    case deferred = "failures.deferred"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .events: return "Events"
        case .errors: return "Errors"
        case .tokensInput: return "Input Tokens"
        case .tokensOutput: return "Output Tokens"
        case .toolCalls: return "Tool Calls"
        case .llmCalls: return "Model Calls"
        case .latencyMean: return "Mean Model Latency"
        case .ttftMean: return "Mean Time to First Token"
        case .outputRateMean: return "Mean Output Tokens/s (end-to-end)"
        case .contextTokens: return "Context Tokens (peak)"
        case .failures: return "Failures"
        case .suspect: return "Suspect Results (≈)"
        case .benign: return "Benign Results"
        case .deferred: return "Deferred Results"
        }
    }

    /// Values are durations in µs; bins without data have no value (not zero).
    var isDuration: Bool { self == .latencyMean || self == .ttftMean }

    var isMean: Bool { isDuration || self == .outputRateMean }

    /// Values are levels (the peak context in a bin), not counts: merged bins keep the peak and nothing is totaled.
    var isLevel: Bool { self == .contextTokens }

    /// Metrics of the agent-native analysis (SPEC §12.7 Statistics: context tokens and failures by tier).
    var isDerived: Bool { rawValue.hasPrefix("context.") || rawValue.hasPrefix("failures.") }

    /// Picker groups: the logged metrics, then the derived ones.
    static var logged: [IOMetric] { allCases.filter { !$0.isDerived } }
    static var derived: [IOMetric] { allCases.filter(\.isDerived) }

    func format(_ v: Double) -> String {
        if self == .outputRateMean { return v.formatted(.number.precision(.fractionLength(0...2))) + " tok/s" }
        return isDuration ? Formatters.duration(Int64(v.rounded())) : Formatters.tokens(Int(v.rounded()))
    }

    /// The noun of a count metric ("93 errors", Principle 5); nil for a duration or a level, whose figure has its unit.
    var noun: String? {
        switch self {
        case .events: return "event"
        case .errors: return "error"
        case .tokensInput, .tokensOutput: return "token"
        case .toolCalls: return "tool call"
        case .llmCalls: return "model call"
        case .failures: return "failure"
        case .suspect: return "suspect result"
        case .benign: return "benign result"
        case .deferred: return "deferred result"
        case .latencyMean, .ttftMean, .outputRateMean: return nil
        case .contextTokens: return "token"
        }
    }

    /// A value with its noun: "12 errors", "1.2M tokens", "820ms".
    func formatWithUnit(_ v: Double) -> String {
        guard let noun else { return format(v) }
        return format(v) + " " + (v.rounded() == 1 ? noun : noun + "s")
    }

    var color: Color {
        switch self {
        case .events: return .accentColor
        case .errors: return Theme.err.swiftUI
        case .tokensInput, .tokensOutput, .llmCalls, .latencyMean, .ttftMean, .outputRateMean: return Theme.color(.llm).swiftUI
        case .toolCalls: return Theme.color(.toolOther).swiftUI
        case .contextTokens: return Theme.color(.context).swiftUI
        case .failures, .suspect: return Theme.err.swiftUI
        case .benign, .deferred: return Theme.warn.swiftUI
        }
    }
}

enum IOInterval: String, CaseIterable, Identifiable {
    case auto, second = "1s", minute = "1m", fiveMinutes = "5m", hour = "1h", day = "1d"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: return "Automatic"
        case .second: return "1 Second"
        case .minute: return "1 Minute"
        case .fiveMinutes: return "5 Minutes"
        case .hour: return "1 Hour"
        case .day: return "1 Day"
        }
    }

    var microseconds: Int64? {
        switch self {
        case .auto: return nil
        case .second: return 1_000_000
        case .minute: return 60_000_000
        case .fiveMinutes: return 300_000_000
        case .hour: return 3_600_000_000
        case .day: return 86_400_000_000
        }
    }
}

/// One bar of the graph: [start, end) in µs.
struct IOBin: Identifiable, Hashable {
    let start: Int64
    let end: Int64
    let value: Double
    var id: Int64 { start }
    var startDate: Date { Date(timeIntervalSince1970: Double(start) / 1e6) }
    var endDate: Date { Date(timeIntervalSince1970: Double(end) / 1e6) }

    /// Bars for a series, merged so that at most `limit` are drawn. Means use sample counts when supplied.
    static func bins(_ series: IoSeries, limit: Int = 1200) -> (bins: [IOBin], merged: Int) {
        let width = max(1, series.binUs)
        let points = series.series.sorted { $0.t < $1.t }
        guard let first = points.first, let last = points.last else { return ([], 1) }
        let span = Int((last.t - first.t) / width) + 1
        let factor = max(1, (span + limit - 1) / limit)
        let isMean = IOMetric(rawValue: series.metric)?.isMean == true
        let isLevel = IOMetric(rawValue: series.metric)?.isLevel == true
        let merged = width * Int64(factor)
        var groups: [Int64: (sum: Double, n: Int, peak: Double)] = [:]
        for p in points {
            let key = first.t + ((p.t - first.t) / merged) * merged
            let g = groups[key] ?? (0, 0, -.infinity)
            let weight = isMean ? max(1, p.n ?? 1) : 1
            groups[key] = (g.sum + p.v * Double(weight), g.n + weight, max(g.peak, p.v))
        }
        let out = groups.keys.sorted().map { k in
            let g = groups[k]!
            return IOBin(start: k, end: k + merged, value: isLevel ? g.peak : isMean ? g.sum / Double(g.n) : g.sum)
        }
        return (out, factor)
    }
}

/// Statistics ▸ I/O Graph: a metric over time for the current view, with a hover rule and drag-to-range.
struct IOGraphView: View {
    let model: WindowModel
    let view: ViewInfo
    @AppStorage("stats.ioMetric") private var metric: IOMetric = .events
    @AppStorage("stats.ioInterval") private var interval: IOInterval = .auto
    @State private var request = PanelRequest<IoSeries>()

    private var settings: String { "\(metric.rawValue)|\(interval.rawValue)" }
    private var key: String { "\(view.viewId)|\(settings)" }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Picker("Metric", selection: $metric) {
                    ForEach(IOMetric.logged) { Text($0.title).tag($0) }
                    Divider()
                    ForEach(IOMetric.derived) { Text($0.title).tag($0) }
                }
                .fixedSize()
                Picker("Interval", selection: $interval) {
                    ForEach(IOInterval.allCases) { Text($0.title).tag($0) }
                }
                .fixedSize()
                Spacer(minLength: 8)
                Text("Drag across the graph to set the time scope.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            if metric == .outputRateMean {
                Text("Mean of per-call output tokens ÷ whole call duration, grouped by call start. Includes waiting and estimated durations; this is not decode speed.")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.bottom, 8)
            } else if metric == .ttftMean {
                Text("Only calls with a recorded or derived time to first token contribute. Missing timing leaves a gap.")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.bottom, 8)
            }
            Divider()
            if case .failed(let e) = request.phase, metric.isDerived, e.isNotServed || e.code == "bad-param" {
                ContentUnavailableView("\(metric.title) Cannot Be Graphed Here", systemImage: "chart.xyaxis.line",
                                       description: Text("This engine does not graph the agent-native metrics yet. The other metrics still work."))
            } else {
                PanelKit.RequestView(request: request, loadingTitle: "Building the graph…") { series in
                    IOChart(model: model, series: series, metric: IOMetric(rawValue: series.metric) ?? metric,
                            requestedInterval: interval.microseconds)
                }
            }
        }
        .task(id: key) {
            let viewID = view.viewId, metric = metric, interval = interval
            // Keep the graph during a live refresh, but not when the metric or interval changed.
            let keep = model.isRefreshingView && request.key?.hasSuffix("|" + settings) == true
            request.load(key: key, keepValue: keep) { [model] in
                try await model.viewRequest { try await $0.statsIO(view: viewID, intervalUs: interval.microseconds, metric: metric.rawValue) }
            }
        }
    }
}

private struct IOChart: View {
    let model: WindowModel
    let series: IoSeries
    let metric: IOMetric
    let requestedInterval: Int64?
    @State private var hover: IOBin?
    @State private var drag: (from: Int64, to: Int64)?

    var body: some View {
        let (bins, factor) = IOBin.bins(series)
        if bins.isEmpty {
            ContentUnavailableView("No data", systemImage: "chart.xyaxis.line",
                                   description: Text("The current view has no \(metric.title.lowercased()) to graph."))
        } else {
            // §7.13: the chart takes the height left by the controls row and the data-table strip (at least 240 pt);
            // the table is open by default and sits to the right of the chart from a 1,728 pt window.
            let wide = model.windowWidth >= 1728
            let layout = wide ? AnyLayout(HStackLayout(alignment: .top, spacing: 12)) : AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            layout {
                VStack(alignment: .leading, spacing: 10) {
                    chart(bins)
                        .frame(minHeight: 240)
                        .contextMenu {
                            Button("Copy Data as CSV") { AppKitHelpers.copy(csv(bins)) }
                        }
                    footer(bins, factor: factor)
                }
                IODataTable(bins: bins, metric: metric)
                    .frame(width: wide ? 320 : nil, height: wide ? nil : min(184, 28 + CGFloat(bins.count) * 22))
                    .frame(maxHeight: wide ? .infinity : nil)
            }
            .padding(16)
        }
    }

    /// Axis labels in 24-hour clock time under the "Times +08:00" header; with the date when the range spans days.
    private func axisLabel(_ date: Date, span: Int64) -> String {
        let us = Int64(date.timeIntervalSince1970 * 1e6)
        if span < 86_400_000_000 { return Formatters.shortClock(us) }
        return span < 7 * 86_400_000_000 ? Formatters.shortDateTime(us) : Formatters.shortDate(us)
    }

    /// "08:06" within a day, "Oct 12 08:06" across days.
    private func when(_ us: Int64, _ bins: [IOBin]) -> String {
        guard let a = bins.first?.start, let b = bins.last?.end else { return Formatters.shortDateTime(us) }
        return Formatters.sameDay(a, b - 1) ? Formatters.shortClock(us) : Formatters.shortDateTime(us)
    }

    private func chart(_ bins: [IOBin]) -> some View {
        Chart {
            ForEach(bins) { b in
                RectangleMark(xStart: .value("Start", b.startDate), xEnd: .value("End", b.endDate),
                              yStart: .value("Zero", 0.0), yEnd: .value(metric.title, b.value))
                    .foregroundStyle(metric.color.opacity(hover == nil || hover == b ? 0.85 : 0.55))
                    .accessibilityLabel(Formatters.timeRange(from: b.start, to: b.end))
                    .accessibilityValue(metric.format(b.value))
            }
            if let h = hover {
                RuleMark(x: .value("Time", Date(timeIntervalSince1970: Double(h.start + (h.end - h.start) / 2) / 1e6)))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, alignment: .center, spacing: 4,
                                overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        hoverCard(h)
                    }
            }
            if let d = drag {
                RectangleMark(xStart: .value("From", Date(timeIntervalSince1970: Double(min(d.from, d.to)) / 1e6)),
                              xEnd: .value("To", Date(timeIntervalSince1970: Double(max(d.from, d.to)) / 1e6)))
                    .foregroundStyle(Color.accentColor.opacity(0.18))
            }
        }
        .chartYAxis {
            AxisMarks { v in
                AxisGridLine()
                AxisValueLabel {
                    if let d = v.as(Double.self) { Text(metric.format(d)) }
                }
            }
        }
        .chartXAxis {
            let span = (bins.last?.end ?? 0) - (bins.first?.start ?? 0)
            AxisMarks(values: .automatic(desiredCount: 8)) { v in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let d = v.as(Date.self) { Text(axisLabel(d, span: span)).monospacedDigit() }
                }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let p): hover = drag == nil ? bin(at: p.x, bins, proxy, geo) : nil
                        case .ended: hover = nil
                        }
                    }
                    .gesture(
                        DragGesture(minimumDistance: 4)
                            .onChanged { g in
                                guard let a = time(at: g.startLocation.x, proxy, geo), let b = time(at: g.location.x, proxy, geo) else { return }
                                hover = nil
                                drag = (a, b)
                            }
                            .onEnded { _ in
                                defer { drag = nil }
                                guard let d = drag else { return }
                                let lo = min(d.from, d.to), hi = max(d.from, d.to)
                                // Snap to whole bins.
                                let from = bins.last { $0.start <= lo }?.start ?? lo
                                let to = bins.first { $0.end >= hi }?.end ?? hi
                                if to > from { model.setTimeRange(from: from, to: to) }
                            }
                    )
            }
        }
        .accessibilityLabel(summarySentence(bins))
    }

    /// One sentence naming the series, the range and the peak (§10.3).
    private func summarySentence(_ bins: [IOBin]) -> String {
        guard let first = bins.first, let last = bins.last else { return metric.title }
        var s = "\(metric.title) from \(when(first.start, bins)) to \(when(last.end, bins))"
        if let peak = bins.max(by: { $0.value < $1.value }) { s += ", peak \(metric.formatWithUnit(peak.value)) at \(when(peak.start, bins))" }
        return s
    }

    private func hoverCard(_ b: IOBin) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(metric.format(b.value)).font(.callout.weight(.semibold).monospacedDigit())
            Text(Formatters.timeRange(from: b.start, to: b.end)).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
    }

    private func footer(_ bins: [IOBin], factor: Int) -> some View {
        let width = series.binUs * Int64(factor)
        var parts = ["\(Formatters.count(bins.count, "bin")) of \(Formatters.duration(width))"]
        if factor > 1 {
            parts.append("merged from \(Formatters.duration(series.binUs)) bins for display")
        } else if let requested = requestedInterval, requested != series.binUs {
            parts.append("widened from \(Formatters.duration(requested)) to keep the number of bins manageable")
        }
        if metric.isMean {
            parts.append("bins without valid samples are empty")
        } else if metric.isLevel {
            parts.append("each bin shows the largest context of its steps; context is cost and latency, not a failure cause")
        } else {
            parts.append("total \(metric.formatWithUnit(bins.reduce(0) { $0 + $1.value }))")
        }
        if metric == .suspect { parts.append("suspect counts are upper bounds") }
        if let peak = bins.max(by: { $0.value < $1.value }) {
            parts.append("peak \(metric.formatWithUnit(peak.value)) at \(when(peak.start, bins))")
        }
        parts.append(PanelKit.timeZoneNote)
        return Text(parts.joined(separator: " · "))
            .font(Theme.fontSwiftUI(.metadata))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
    }

    private func time(at x: CGFloat, _ proxy: ChartProxy, _ geo: GeometryProxy) -> Int64? {
        guard let plot = proxy.plotFrame else { return nil }
        let origin = geo[plot].origin.x
        guard let date: Date = proxy.value(atX: x - origin, as: Date.self) else { return nil }
        return Int64(date.timeIntervalSince1970 * 1e6)
    }

    private func bin(at x: CGFloat, _ bins: [IOBin], _ proxy: ChartProxy, _ geo: GeometryProxy) -> IOBin? {
        guard let t = time(at: x, proxy, geo) else { return nil }
        var lo = 0, hi = bins.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if bins[mid].end <= t { lo = mid + 1 } else if bins[mid].start > t { hi = mid - 1 } else { return bins[mid] }
        }
        return nil
    }

    private func csv(_ bins: [IOBin]) -> String {
        (["start,end,\(metric.rawValue)"] + bins.map { "\(Formatters.iso8601($0.start)),\(Formatters.iso8601($0.end)),\(JSONValue.format($0.value))" })
            .joined(separator: "\n")
    }
}

/// The I/O Graph's data table (§7.13, §10.3): the chart's text equivalent, one row per bin, scrolling in its strip.
private struct IODataTable: View {
    let bins: [IOBin]
    let metric: IOMetric

    var body: some View {
        let sameDay = bins.first.map { a in bins.allSatisfy { Formatters.sameDay($0.start, a.start) } } ?? true
        Table(bins) {
            TableColumn("Bin start") { (b: IOBin) in
                Text(sameDay ? Formatters.clock(b.start, zone: Formatters.timeZone) : Formatters.datedClock(b.start))
                    .monospacedDigit()
                    .help(Formatters.timeRange(from: b.start, to: b.end))
            }
            TableColumn(metric.title) { (b: IOBin) in
                Text(metric.format(b.value)).monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .accessibilityLabel("\(metric.title) by bin")
    }
}
