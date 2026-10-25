import SwiftUI

private enum PerformanceMetric: String, CaseIterable, Identifiable {
    case latency, ttft, rate, cache
    var id: Self { self }
    var title: String {
        switch self {
        case .latency: return "Call duration"
        case .ttft: return "First token"
        case .rate: return "Output speed"
        case .cache: return "Cache reuse"
        }
    }
    var column: String { self == .cache ? "Input reused" : self == .rate ? "Slow calls (p10)" : "Slow calls (p90)" }
    var direction: String { self == .cache ? "Higher means more reuse" : self == .rate ? "Higher is faster" : "Lower is faster" }
    var note: String {
        switch self {
        case .latency: return "Whole call duration, including waiting."
        case .ttft: return "Time before the first output token arrives."
        case .rate: return "Output tokens per second across the whole call, including waiting."
        case .cache: return "Cached input tokens ÷ total input tokens, over calls with both counts."
        }
    }
    func value(_ r: PerformanceStat, typical: Bool = false) -> Double? {
        switch self {
        case .latency: return (typical ? r.latencyP50 : r.latencyP90).map(Double.init)
        case .ttft: return (typical ? r.ttftP50 : r.ttftP90).map(Double.init)
        case .rate: return typical ? r.outputRateP50 : r.outputRateP10
        case .cache: return r.cacheHitRatio
        }
    }
    func known(_ r: PerformanceStat) -> Int {
        switch self {
        case .latency: return r.latencyKnown
        case .ttft: return r.ttftKnown
        case .rate: return r.outputRateKnown
        case .cache: return r.cacheKnown ?? 0
        }
    }
    func estimated(_ r: PerformanceStat) -> Int { self == .latency ? r.latencyEstimated : self == .rate ? r.outputRateEstimated : 0 }
    func format(_ value: Double?) -> String {
        guard let value else { return "Not recorded" }
        switch self {
        case .latency, .ttft: return Formatters.duration(Int64(value), src: nil)
        case .rate: return value.formatted(.number.precision(.fractionLength(0...2))) + " tok/s"
        case .cache: return Formatters.percent(value)
        }
    }
    func ordered(_ rows: [PerformanceStat]) -> [PerformanceStat] {
        rows.sorted { a, b in
            guard let x = value(a) else { return false }
            guard let y = value(b) else { return true }
            if x == y { return a.model < b.model }
            return self == .latency || self == .ttft ? x > y : x < y
        }
    }
}

/// Headline figures, the lanes over time, the slowest intervals, then one model metric at a time (SPEC §6).
struct StatsPerformanceView: View {
    let model: WindowModel
    let viewID: String
    private var request: PanelRequest<PerformanceResult> { model.panels.request("stats.performance") }
    @State private var selection: Set<String> = []
    @AppStorage("stats.performanceMetric") private var metric: PerformanceMetric = .latency
    @AppStorage("stats.performanceFolded") private var foldedRaw = ""
    @State private var expanded = false
    /// The interval under the pointer, in the lanes or the list.
    @State private var linked: String?
    /// The lanes' cursor, shared with the pinned axis.
    @State private var pointer = PerfPointer()
    /// The time ranges the lanes zoomed from, newest last; Zoom Out restores them.
    @State private var zoomStack: [(prev: (from: Int64?, to: Int64?), next: (from: Int64, to: Int64))] = []
    @State private var showTable = false

    private var folded: Binding<Set<PerfLane>> {
        Binding(get: { Set(foldedRaw.split(separator: ",").compactMap { PerfLane(rawValue: String($0)) }) },
                set: { foldedRaw = $0.map(\.rawValue).sorted().joined(separator: ",") })
    }

    var body: some View {
        PanelKit.RequestView(request: request, loadingTitle: "Measuring call performance…") { result in
            let rows = result.bottlenecks.sorted {
                if $0.duration != $1.duration { return $0.duration > $1.duration }
                if $0.start != $1.start { return $0.start < $1.start }
                return $0.spanId < $1.spanId
            }
            ScrollViewReader { proxy in
                ScrollView {
                    // The Over time header and axis stay pinned while its lanes scroll.
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        if let o = result.overall { figures(o, result.timeline, proxy).padding(.bottom, 20) }
                        if let t = result.timeline, !t.bins.isEmpty {
                            Section {
                                overTime(t, rows).padding(.bottom, 20)
                            } header: {
                                overTimeHeader(t)
                            }
                        }
                        bottlenecks(rows).padding(.bottom, 20)
                        compareModels(result.models)
                    }
                    .padding(12)
                }
            }
            .onChange(of: result.timeline) { pointer = PerfPointer() }
        }
        .task(id: viewID) {
            request.load(key: viewID, keepValue: model.isRefreshingView) { [model, viewID] in
                try await model.viewRequest { try await $0.statsPerformance(view: viewID) }
            }
        }
    }

    // MARK: Headline figures

    private func figures(_ o: PerformanceStat, _ timeline: PerformanceTimeline?, _ proxy: ScrollViewProxy) -> some View {
        let tools = timeline?.bins.reduce(0) { $0 + $1.tools } ?? 0
        let busy = timeline?.busy.values.reduce(0, +) ?? 0
        func of(_ k: Int) -> String { "\(Formatters.count(k)) of \(Formatters.count(o.calls)) calls" }
        func rate(_ v: Double?) -> String { v.map { PerfLane.speed.format($0) } ?? Formatters.missing }
        let est = { (n: Int) in n > 0 ? "≈" : "" }
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 148), spacing: 8, alignment: .leading)], alignment: .leading, spacing: 8) {
            figure(.calls, "Model calls", Formatters.tokens(o.calls), tools > 0 ? Formatters.count(tools, "tool call") : "no tool calls", timeline, proxy)
            figure(.duration, "Median call duration", o.latencyP50.map { Formatters.duration($0) + est(o.latencyEstimated) } ?? "Not recorded",
                   o.latencyP50 == nil ? of(0) : "p90 \(Formatters.duration(o.latencyP90, src: nil)) · \(of(o.latencyKnown))", timeline, proxy)
            figure(.ttft, "Median first token", o.ttftP50.map { Formatters.duration($0) } ?? "Not recorded",
                   o.ttftP50 == nil ? of(0) : "p90 \(Formatters.duration(o.ttftP90, src: nil)) · \(of(o.ttftKnown))", timeline, proxy)
            figure(.speed, "Median output speed", o.outputRateP50 == nil ? "Not recorded" : rate(o.outputRateP50) + est(o.outputRateEstimated),
                   o.outputRateP50 == nil ? of(0) : "p10 \(rate(o.outputRateP10)) · \(of(o.outputRateKnown))", timeline, proxy)
            figure(.cache, "Cache reuse", o.cacheHitRatio == nil ? "Not recorded" : Formatters.shortPercent(o.cacheHitRatio), of(o.cacheKnown ?? 0), timeline, proxy)
            figure(.busy, "Busy time", busy > 0 ? Formatters.duration(busy) : Formatters.missing,
                   timeline.map { Formatters.count($0.segments.count, "busy period") } ?? Formatters.missing, timeline, proxy)
        }
    }

    private func figure(_ lane: PerfLane, _ label: String, _ value: String, _ sub: String, _ timeline: PerformanceTimeline?, _ proxy: ScrollViewProxy) -> some View {
        Button {
            folded.wrappedValue.remove(lane)
            withAnimation { proxy.scrollTo(lane, anchor: .center) }
        } label: {
            HStack(spacing: 10) {
                Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.caption).foregroundStyle(.secondary)
                    Text(value).font(.title3.weight(.semibold)).monospacedDigit()
                    Text(sub).font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                }
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(timeline?.bins.isEmpty ?? true)
        .help("Show its lane in Over time")
        .accessibilityLabel("\(label): \(value), \(sub)")
    }

    // MARK: Over time

    private func overTimeHeader(_ t: PerformanceTimeline) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("Over time").font(.headline)
                Text("\(Formatters.count(t.bins.count, "bin")) of \(Formatters.duration(t.binUs)) · idle time between busy periods is collapsed. Hover to read every lane at one time; drag across a lane to zoom in.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button("Zoom Out", action: zoomOut)
                    .disabled(!model.scope.hasTimeRange)
                    .help("Restore the time range before the last zoom")
                Button("Show in Timeline") { model.workspace = .timeline }
                    .help("Show this time range in Timeline")
            }
            .controlSize(.small)
            PerformanceAxisRow(timeline: t, pointer: $pointer, onZoom: zoom)
        }
        .padding(.top, 4)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func overTime(_ t: PerformanceTimeline, _ rows: [PerformanceBottleneck]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            PerformanceLanesView(timeline: t, intervals: rows, pointer: $pointer, linked: $linked, folded: folded, onZoom: zoom, onOpen: locate)
            DisclosureGroup("Data table", isExpanded: $showTable) {
                if showTable { PerformanceDataTable(timeline: t).frame(height: 240) }
            }
            .font(.caption)
        }
    }

    private func zoom(_ from: Int64, _ to: Int64) {
        zoomStack.append((prev: (model.scope.from, model.scope.to), next: (from, to)))
        model.setTimeRange(from: from, to: to)
    }

    /// Back to the range before the last zoom; with no zoom of ours on record, the whole time.
    private func zoomOut() {
        if let top = zoomStack.popLast(), top.next.from == model.scope.from, top.next.to == model.scope.to {
            model.setTimeRange(from: top.prev.from, to: top.prev.to)
        } else {
            zoomStack.removeAll()
            model.setTimeRange(from: nil, to: nil)
        }
    }

    // MARK: Compare models

    private func compareModels(_ models: [PerformanceStat]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Compare models").font(.headline)
            Picker("Compare models by", selection: $metric) {
                ForEach(PerformanceMetric.allCases) { Text($0.title).tag($0) }
            }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 550)
            Text(metric.direction + " · " + metric.note).font(.caption).foregroundStyle(.secondary)
            if models.isEmpty {
                ContentUnavailableView("No model calls in this view", systemImage: "speedometer")
            } else {
                table(metric.ordered(models)).frame(height: min(360, 32 + CGFloat(models.count) * 30))
            }
            DisclosureGroup("How to read these metrics") {
                Text("The median describes a typical call. p90 marks the high end of durations; p10 marks the low end of output speed. Models with few measured calls have less reliable percentiles. Output speed here is not decode speed. Missing values stay unrecorded, not zero. Cache reuse is weighted by input tokens; low reuse alone does not explain a slowdown.")
                    .font(.caption).foregroundStyle(.secondary).padding(.top, 4)
            }.font(.caption)
            TableFooter(count: Formatters.count(models.count, "model"), hint: "Double-click a model to filter this view. Estimated durations come from log timing.")
        }
    }

    private func table(_ rows: [PerformanceStat]) -> some View {
        let largest = metric == .cache ? 1 : max(rows.compactMap { metric.value($0) }.max() ?? 1, 1)
        return Table(rows, selection: $selection) {
            TableColumn("Model") { r in
                Text(r.model).lineLimit(1).truncationMode(.middle).help(r.model)
            }.width(min: 120, ideal: 200, max: 320)
            TableColumn(metric.column) { r in
                metricValue(r, largest: largest)
            }.width(min: 160, ideal: 200, max: 240)
            if metric != .cache {
                TableColumn("Typical (median)") { r in
                    Text(metric.format(metric.value(r, typical: true))).monospacedDigit()
                }.width(min: 100, ideal: 130, max: 160)
            }
            TableColumn("Calls with data") { r in
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(metric.known(r)) / \(r.calls)").monospacedDigit()
                    if metric.estimated(r) > 0 {
                        Text("\(metric.estimated(r)) estimated").font(.caption2).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .trailing)
            }.width(min: 90, ideal: 110, max: 160)
            TableColumn("Action") { r in
                Button("Filter →") {
                    if let filter = membership("model", [r.model]) { model.drillDown(filter) }
                }.buttonStyle(.borderless).accessibilityLabel("Filter this view to " + r.model)
            }.width(60)
        }
        .contextMenu(forSelectionType: String.self) { ids in
            let names = rows.map(\.model).filter(ids.contains)
            DrillDownMenu(model: model, fragment: membership("model", names), copyTitle: "Copy Model Name", copyText: names.joined(separator: "\n"))
        } primaryAction: { ids in
            if let filter = membership("model", rows.map(\.model).filter(ids.contains)) { model.drillDown(filter) }
        }
    }

    private func metricValue(_ r: PerformanceStat, largest: Double) -> some View {
        HStack(spacing: 12) {
            Text(metric.format(metric.value(r))).fontWeight(.semibold).monospacedDigit()
            if let value = metric.value(r) {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(Color.secondary.opacity(0.1))
                        Rectangle().fill(Color(nsColor: TimeBar.color("model")))
                            .frame(width: g.size.width * min(1, value / largest))
                    }
                }.frame(width: 80, height: 6).accessibilityHidden(true)
            }
        }.frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func bottlenecks(_ rows: [PerformanceBottleneck]) -> some View {
        let longest = max(rows.map(\.duration).max() ?? 1, 1)
        return VStack(alignment: .leading, spacing: 8) {
            Text("Slowest intervals").font(.headline)
            Text("Longest calls and waits in this view, numbered as in the Slowest intervals lane. Open one to inspect what happened around it.")
                .font(.caption).foregroundStyle(.secondary)
            if rows.isEmpty { Text("No completed, timed intervals in this view.").foregroundStyle(.secondary) }
            ForEach(Array(rows.prefix(expanded ? rows.count : 3).enumerated()), id: \.element.id) { index, r in
                bottleneckRow(r, rank: index + 1, longest: longest)
            }
            if rows.count > 3 {
                Button(expanded ? "Show top 3" : "Show all \(rows.count) intervals") { expanded.toggle() }.controlSize(.small)
            }
            DisclosureGroup("About this ranking") {
                Text("Up to 10 completed intervals, ranked by duration on one scale. They may overlap, so their durations do not add up to wall time. A long interval is an investigation lead, not proof of a bottleneck. ≈ means estimated timing. Where time went shows which kind of work filled each period; Statistics → Time separates model, tool and waiting time per session.")
                    .font(.caption).foregroundStyle(.secondary).padding(.top, 4)
            }.font(.caption)
        }
    }

    private func bottleneckRow(_ r: PerformanceBottleneck, rank: Int, longest: Int64) -> some View {
        let label = detail(r)
        let duration = Formatters.duration(r.duration, src: nil) + (r.estimated ? "≈" : "")
        return Button { locate(r) } label: {
            HStack(spacing: 12) {
                Text(String(rank)).foregroundStyle(.secondary).frame(width: 20)
                VStack(alignment: .leading, spacing: 4) {
                    Text(r.name).fontWeight(.medium).lineLimit(1).truncationMode(.tail)
                    Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }.frame(minWidth: 160, idealWidth: 260, maxWidth: 320, alignment: .leading)
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(Color.secondary.opacity(0.1))
                        Rectangle().fill(Color(nsColor: TimeBar.color(r.bucket)))
                            .frame(width: max(2, g.size.width * CGFloat(r.duration) / CGFloat(longest)))
                    }
                }.frame(height: 8).accessibilityHidden(true)
                Text(duration).fontWeight(.semibold).monospacedDigit().frame(width: 80, alignment: .trailing)
                Text("Show in Timeline →").foregroundStyle(Color.accentColor).fixedSize()
            }.padding(.vertical, 8).padding(.horizontal, 4).contentShape(Rectangle())
            .background(linked == r.spanId ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
        .onHover { inside in
            if inside { linked = r.spanId } else if linked == r.spanId { linked = nil }
        }
        .help(r.name + " · " + label)
        .accessibilityLabel("Show in Timeline: " + r.name + ", " + label + ", " + duration)
    }

    private func detail(_ r: PerformanceBottleneck) -> String {
        PerfBusy.interval(r.bucket.rawValue) + " · " + Formatters.clock(r.start, zone: Formatters.timeZone) + (r.estimated ? " · Estimated timing" : "")
    }

    private func locate(_ r: PerformanceBottleneck) {
        let pad = max(1_000_000, r.duration / 10)
        model.openSession(r.sessionId, workspace: .timeline)
        model.setTimeRange(from: r.start - pad, to: r.start + r.duration + pad)
        model.inspectionRange = r.start...(r.start + r.duration)
        model.selectedSpan = r.spanId
        if let id = r.eventId { model.select(event: id, reveal: false) }
    }
}

/// The lanes' text equivalent: one row per bin.
private struct PerformanceDataTable: View {
    let timeline: PerformanceTimeline

    var body: some View {
        let bins = timeline.bins, binUs = timeline.binUs
        let sameDay = bins.first.map { a in Formatters.sameDay(a.t, bins.last!.t) } ?? true
        let dur = { (v: Int64?) in Formatters.duration(v, src: nil) }
        Table(bins) {
            TableColumn("Bin start") { (b: PerformanceBin) in
                Text(perfBinTime(b.t, sameDay: sameDay, seconds: binUs < 60_000_000)).monospacedDigit()
                    .help(Formatters.timeRange(from: b.t, to: b.t + binUs))
            }
            TableColumn("Busy") { (b: PerformanceBin) in
                Text(b.busyUs > 0 ? Formatters.shortPercent(Double(b.busyUs) / Double(binUs)) : Formatters.missing).monospacedDigit()
            }
            TableColumn("Most time") { (b: PerformanceBin) in
                Text(b.busy.max { $0.value < $1.value }.map { PerfBusy.label($0.key) } ?? Formatters.missing)
            }
            TableColumn("Model calls") { (b: PerformanceBin) in Text(Formatters.count(b.calls)).monospacedDigit() }
            TableColumn("Tool calls") { (b: PerformanceBin) in Text(Formatters.count(b.tools)).monospacedDigit() }
            TableColumn("Failed") { (b: PerformanceBin) in
                Text(Formatters.count(b.failed)).monospacedDigit().foregroundStyle(b.failed > 0 ? Theme.err.swiftUI : .primary)
            }
            Group {
                TableColumn("Duration p50") { (b: PerformanceBin) in Text(dur(b.latencyP50)).monospacedDigit() }
                TableColumn("Duration p90") { (b: PerformanceBin) in Text(dur(b.latencyP90)).monospacedDigit() }
                TableColumn("First token p50") { (b: PerformanceBin) in Text(dur(b.ttftP50)).monospacedDigit() }
                TableColumn("Speed p50") { (b: PerformanceBin) in Text(b.rateP50.map { PerfLane.speed.format($0) } ?? Formatters.missing).monospacedDigit() }
                TableColumn("Cache reuse") { (b: PerformanceBin) in Text(Formatters.shortPercent(b.cacheHitRatio)).monospacedDigit() }
                TableColumn("Prompt p50") { (b: PerformanceBin) in Text(b.inputP50.map { Formatters.tokens($0) } ?? Formatters.missing).monospacedDigit() }
            }
        }
        .accessibilityLabel("Performance over time by bin")
    }
}
