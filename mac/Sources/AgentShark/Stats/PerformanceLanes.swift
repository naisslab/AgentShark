import SwiftUI

// Statistics ▸ Performance over time (SPEC §6 Over time): lanes on one time axis with idle gaps collapsed, one cursor
// across every lane, drag-to-zoom, and the slowest intervals drawn where they happened. The words match the web viewer.

/// The lanes, top to bottom.
enum PerfLane: String, CaseIterable, Identifiable {
    case busy, intervals, duration, ttft, speed, cache, prompt, calls
    var id: Self { self }

    var title: String {
        switch self {
        case .busy: return "Where time went"
        case .intervals: return "Slowest intervals"
        case .duration: return "Call duration"
        case .ttft: return "First token"
        case .speed: return "Output speed"
        case .cache: return "Cache reuse"
        case .prompt: return "Prompt size"
        case .calls: return "Calls"
        }
    }

    var help: String {
        switch self {
        case .busy: return "Agent time in each bin by what it went to, as a share of the bin. Parallel sessions and subagents add up, so a bin can pass 100%."
        case .intervals: return "The ranked intervals, drawn where they happened. Click one to open it in Timeline."
        case .duration: return "Whole model call duration by call start, including waiting."
        case .ttft: return "Time before the first output token, where the agent logged it."
        case .speed: return "Output tokens per second over the whole call, including waiting; not decode speed."
        case .cache: return "Cached input tokens ÷ input tokens of the calls that started in the bin."
        case .prompt: return "Median input tokens per call, cached or not. Larger prompts take longer to process."
        case .calls: return "Model and tool calls started in each bin; a red dot marks bins with failed calls."
        }
    }

    var height: CGFloat {
        switch self {
        case .busy: return 96
        case .duration, .ttft, .speed: return 64
        default: return 56
        }
    }

    var isSeries: Bool { [.duration, .ttft, .speed, .cache, .prompt].contains(self) }

    /// The solid and the dashed line of a series lane.
    func values(_ b: PerformanceBin) -> (Double?, Double?) {
        switch self {
        case .duration: return (b.latencyP50.map(Double.init), b.latencyP90.map(Double.init))
        case .ttft: return (b.ttftP50.map(Double.init), b.ttftP90.map(Double.init))
        case .speed: return (b.rateP50, b.rateP10)
        case .cache: return (b.cacheHitRatio, nil)
        case .prompt: return (b.inputP50.map(Double.init), nil)
        default: return (nil, nil)
        }
    }

    var names: (String, String) {
        switch self {
        case .duration, .ttft: return ("p50", "p90")
        case .speed: return ("p50", "p10")
        case .prompt: return ("median", "")
        default: return ("", "")
        }
    }

    /// What the header points at without a cursor: the slowest, lowest or largest bin.
    var peak: (text: String, secondary: Bool, lowest: Bool)? {
        switch self {
        case .duration, .ttft: return ("slowest p90", true, false)
        case .speed: return ("slowest p10", true, true)
        case .cache: return ("lowest", false, true)
        case .prompt: return ("largest", false, false)
        default: return nil
        }
    }

    func format(_ v: Double) -> String {
        switch self {
        case .duration, .ttft: return Formatters.duration(Int64(v.rounded()))
        case .speed: return v.formatted(.number.precision(.fractionLength(0...(v < 10 ? 1 : 0)))) + " tok/s"
        case .cache: return Formatters.shortPercent(v)
        case .prompt: return Formatters.tokens(Int(v.rounded())) + " tokens"
        default: return Formatters.tokens(Int(v.rounded()))
        }
    }

    /// The axis label of a series lane's value.
    func axisLabel(_ v: Double) -> String {
        switch self {
        case .duration, .ttft: return Formatters.duration(Int64(v.rounded()))
        case .speed: return Formatters.tokens(Int(v.rounded())) + "/s"
        case .cache: return Formatters.shortPercent(v)
        default: return Formatters.tokens(Int(v.rounded()))
        }
    }

    /// The text of the lane for one bin: what its header shows under the cursor.
    func text(_ b: PerformanceBin, binUs: Int64) -> String {
        switch self {
        case .busy: return b.busyUs > 0 ? Formatters.shortPercent(Double(b.busyUs) / Double(binUs)) + " busy" : "idle"
        case .calls:
            return [Formatters.count(b.calls, "model call"), Formatters.count(b.tools, "tool call"),
                    b.failed > 0 ? "\(Formatters.count(b.failed)) failed" : nil].compactMap { $0 }.joined(separator: " · ")
        case .intervals: return ""
        default:
            if b.calls == 0 { return "no model calls" }
            let (a, c) = values(b)
            let parts = [a.map { [names.0, format($0)] }, c.map { [names.1, format($0)] }].compactMap { $0 }
                .map { $0.filter { !$0.isEmpty }.joined(separator: " ") }
            return parts.isEmpty ? "no samples" : parts.joined(separator: " · ")
        }
    }
}

enum PerfBusy {
    /// Stacking order of Where time went, bottom first: the work, then the waits.
    static let order = ["model", "tool", "hook", "compaction", "api-retry", "wait-process", "wait-agent", "wait-human"]

    static func label(_ name: String) -> String {
        switch name {
        case "model": return "Model"
        case "tool": return "Tools"
        case "hook": return "Hooks"
        case "compaction": return "Compaction"
        case "api-retry": return "API retries"
        case "wait-process": return "Waiting for a process"
        case "wait-agent": return "Waiting for a subagent"
        case "wait-human": return "Waiting for a human"
        default: return name
        }
    }

    /// The kind of interval a bottleneck is, by its time bucket.
    static func interval(_ name: String) -> String {
        switch name {
        case "model": return "Model call"
        case "tool": return "Tool call"
        case "hook": return "Hook"
        case "api-retry": return "API retry"
        default: return label(name)
        }
    }

    static func color(_ name: String) -> Color { Color(nsColor: TimeBar.color(TimeBucketName(rawValue: name))) }
}

// MARK: - Axis

/// The shared x mapping of the lanes: the busy segments fill the plot, and each idle gap between them takes a break.
struct PerfAxis {
    static let breakWidth: CGFloat = 14
    static let left: CGFloat = 56
    static let right: CGFloat = 14
    private static let steps: [Int64] = [1, 2, 5, 10, 15, 30].map { $0 * 1_000_000 } + [1, 2, 5, 10, 15, 30].map { $0 * 60_000_000 }
        + [1, 2, 3, 6, 12, 24].map { $0 * 3_600_000_000 }

    let segments: [PerformanceTimeline.Segment]
    let width: CGFloat
    /// Points per µs of busy time.
    let k: Double
    private let starts: [CGFloat]

    init(segments: [PerformanceTimeline.Segment], width: CGFloat) {
        self.segments = segments
        self.width = width
        let plot = max(1, width - Self.left - Self.right - CGFloat(max(0, segments.count - 1)) * Self.breakWidth)
        let busy = segments.reduce(0.0) { $0 + Double($1.end - $1.start) }
        k = busy > 0 ? Double(plot) / busy : 0
        var x = Self.left
        var starts: [CGFloat] = []
        for s in segments {
            starts.append(x)
            x += CGFloat(Double(s.end - s.start) * k) + Self.breakWidth
        }
        self.starts = starts
    }

    /// The x of a time, within the plot; a time in an idle gap maps linearly across its break.
    func x(_ t: Int64) -> CGFloat {
        guard let i = segments.lastIndex(where: { $0.start <= t }) else { return Self.left }
        let s = segments[i]
        if t <= s.end || i + 1 == segments.count { return min(width - Self.right, starts[i] + CGFloat(Double(t - s.start) * k)) }
        let next = segments[i + 1]
        let end = starts[i] + CGFloat(Double(s.end - s.start) * k)
        return end + Self.breakWidth * CGFloat(Double(t - s.end) / Double(max(1, next.start - s.end)))
    }

    /// The time at an x, or nil in a break or outside the plot.
    func t(_ x: CGFloat) -> Int64? {
        for (i, s) in segments.enumerated() {
            let end = starts[i] + CGFloat(Double(s.end - s.start) * k)
            if x >= starts[i] && x < end { return s.start + Int64(Double(x - starts[i]) / k) }
        }
        return nil
    }

    /// The collapsed gaps: their x range and idle time.
    var breaks: [(x0: CGFloat, x1: CGFloat, idle: Int64)] {
        segments.indices.dropLast().map { i in
            let x0 = starts[i] + CGFloat(Double(segments[i].end - segments[i].start) * k)
            return (x0, x0 + Self.breakWidth, segments[i + 1].start - segments[i].end)
        }
    }

    /// Each segment's start (`lead`), then round local times at least `spacing` apart.
    func ticks(spacing: CGFloat = 96) -> [(x: CGFloat, t: Int64, lead: Bool)] {
        guard k > 0 else { return [] }
        let step = Self.steps.first { CGFloat(Double($0) * k) >= spacing } ?? Self.steps.last!
        var out: [(x: CGFloat, t: Int64, lead: Bool)] = []
        for s in segments {
            out.append((x(s.start), s.start, true))
            let offset = Int64(Formatters.timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(s.start) / 1e6))) * 1_000_000
            var t = ((s.start + offset + step - 1) / step) * step - offset
            while t < s.end {
                if t > s.start { out.append((x(t), t, false)) }
                t += step
            }
        }
        return out
    }
}

/// "17:24" within a day, "Oct 11 17:24" across days (DESIGN.md §9 Dates); seconds when bins are shorter than a minute.
func perfBinTime(_ us: Int64, sameDay: Bool, seconds: Bool) -> String {
    let c = Formatters.components(us, zone: Formatters.timeZone)
    let clock = seconds ? String(format: "%02d:%02d:%02d", c.hour, c.minute, c.second) : String(format: "%02d:%02d", c.hour, c.minute)
    return sameDay ? clock : Formatters.shortDate(us) + " " + clock
}

/// Rows for interval bars (x ranges) so that none overlaps: left to right, the first row with room, at most `limit` rows.
func perfPackRows(_ spans: [(CGFloat, CGFloat)], limit: Int = 5, gap: CGFloat = 4) -> [Int] {
    var ends: [CGFloat] = []
    var rows = Array(repeating: 0, count: spans.count)
    for i in spans.indices.sorted(by: { spans[$0].0 < spans[$1].0 || (spans[$0].0 == spans[$1].0 && $0 < $1) }) {
        let (x0, x1) = spans[i]
        var row = ends.firstIndex { x0 >= $0 + gap } ?? -1
        if row < 0 { row = ends.count < limit ? ends.count : ends.indices.min { ends[$0] < ends[$1] }! }
        if row == ends.count { ends.append(x1) } else { ends[row] = max(ends[row], x1) }
        rows[i] = row
    }
    return rows
}

/// The top of a lane's value axis: its largest value, unless a few outliers sit far above the rest; then the 95th
/// percentile with 25% headroom, and the outliers draw clipped with a caret.
func perfLaneTop(_ values: [Double]) -> Double {
    let v = values.filter(\.isFinite).sorted()
    guard let max = v.last else { return 0 }
    guard v.count >= 10 else { return max }
    let p95 = v[Int((0.95 * Double(v.count)).rounded(.up)) - 1]
    return max > 2 * p95 ? p95 * 1.25 : max
}

/// A round value at or above `v`: a round duration for durations, 100% for shares.
func perfNiceMax(_ v: Double, lane: PerfLane) -> Double {
    if lane == .cache { return 1 }
    guard v > 0 else { return lane == .duration || lane == .ttft ? 1_000_000 : 1 }
    if lane == .duration || lane == .ttft {
        let ms: [Double] = [1, 2, 5, 10, 20, 50, 100, 200, 500].map { $0 * 1000 }
        let s: [Double] = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map { $0 * 1e6 }
        return (ms + s).first { $0 >= v } ?? v
    }
    let base = pow(10, floor(log10(v / 4)))
    let step = [1.0, 2, 5, 10].map { $0 * base }.first { v / $0 <= 4 } ?? 10 * base
    return (v / step).rounded(.up) * step
}

// MARK: - Cursor

/// The lanes' shared cursor: the bin under the pointer, the pinned bin, the other end of a keyboard selection, and a
/// drag. Indices can outlive a refreshed timeline, so every read checks them against the bin count.
struct PerfPointer {
    var hover: Int?
    var cursor: Int?
    var anchor: Int?
    var drag: (a: Int, b: Int)?

    private func valid(_ i: Int?, _ count: Int) -> Int? { i.flatMap { $0 >= 0 && $0 < count ? $0 : nil } }

    /// The bin the lanes read out: under the pointer, else the pinned one.
    func active(_ count: Int) -> Int? { valid(hover, count) ?? valid(cursor, count) }
    func pinned(_ count: Int) -> Int? { valid(cursor, count) }

    /// The selected bins, lowest first: a drag, or a keyboard selection.
    func selection(_ count: Int) -> (Int, Int)? {
        if let d = drag, let a = valid(d.a, count), let b = valid(d.b, count), a != b { return (min(a, b), max(a, b)) }
        if let a = valid(anchor, count), let c = valid(cursor, count), a != c { return (min(a, c), max(a, c)) }
        return nil
    }

    /// The bins Return zooms to: the selection, else the pinned bin.
    func zoomRange(_ count: Int) -> (Int, Int)? { selection(count) ?? pinned(count).map { ($0, $0) } }

    mutating func jump(to index: Int, extend: Bool, count: Int) {
        guard count > 0 else { return }
        if extend && anchor == nil { anchor = pinned(count) ?? 0 }
        if !extend { anchor = nil }
        cursor = min(count - 1, max(0, index))
    }

    mutating func move(_ step: Int, extend: Bool, count: Int) {
        jump(to: pinned(count).map { $0 + step } ?? (step > 0 ? 0 : count - 1), extend: extend, count: count)
    }
}

extension PerformanceTimeline {
    var sameDay: Bool {
        guard let a = bins.first?.t, let b = bins.last?.t else { return true }
        return Formatters.sameDay(a, b + binUs - 1)
    }
    var seconds: Bool { binUs < 60_000_000 }
    func when(_ t: Int64) -> String { perfBinTime(t, sameDay: sameDay, seconds: seconds) }
    /// Bins `lo`...`hi` as a time range.
    func range(_ lo: Int, _ hi: Int) -> (from: Int64, to: Int64) { (bins[lo].t, bins[hi].t + binUs) }

    /// One sentence per bin, for announcements and the axis's accessibility value.
    func sentence(_ i: Int) -> String {
        let b = bins[i]
        let busy = PerfBusy.order.filter { (b.busy[$0] ?? 0) > 0 }.map { "\(PerfBusy.label($0)) \(Formatters.duration(b.busy[$0] ?? 0))" }
        let lanes = PerfLane.allCases.filter { $0.isSeries || $0 == .calls }.map { "\($0.title): \($0.text(b, binUs: binUs))" }
        return ([when(b.t) + " to " + when(b.t + binUs), busy.isEmpty ? "idle" : busy.joined(separator: ", ")] + lanes).joined(separator: ". ")
    }

    func selectionSentence(_ lo: Int, _ hi: Int) -> String {
        "Selected \(Formatters.count(hi - lo + 1, "bin")), \(when(bins[lo].t)) to \(when(bins[hi].t + binUs)). Press Return to zoom."
    }
}

// MARK: - Axis

/// The time axis above the lanes: segment starts, round times, breaks and the cursor's bin. The Statistics page pins
/// it while the lanes scroll. For assistive technology it is the cursor: adjust moves it bin by bin.
struct PerformanceAxisRow: View {
    let timeline: PerformanceTimeline
    @Binding var pointer: PerfPointer
    var onZoom: (Int64, Int64) -> Void
    @State private var width: CGFloat = 0

    private var bins: [PerformanceBin] { timeline.bins }

    var body: some View {
        Canvas { ctx, size in
            let ax = PerfAxis(segments: timeline.segments, width: size.width)
            for b in ax.breaks {
                ctx.fill(Path(CGRect(x: b.x0, y: 0, width: b.x1 - b.x0, height: size.height)), with: .color(.secondary.opacity(0.12)))
                var mark = Path()
                for dx in [-2.0, 2.0] {
                    mark.move(to: CGPoint(x: (b.x0 + b.x1) / 2 + dx - 2, y: size.height / 2 + 5))
                    mark.addLine(to: CGPoint(x: (b.x0 + b.x1) / 2 + dx + 2, y: size.height / 2 - 5))
                }
                ctx.stroke(mark, with: .color(.secondary), lineWidth: 1)
            }
            // Segment starts first (with the date across days), then the round times that fit.
            var placed: [(x: CGFloat, w: CGFloat)] = []
            let ticks = ax.ticks()
            for tick in ticks.filter(\.lead) + ticks.filter({ !$0.lead }) {
                let text = tick.lead ? timeline.when(tick.t) : perfBinTime(tick.t, sameDay: true, seconds: timeline.seconds)
                let resolved = ctx.resolve(Text(text).font(.caption2.monospacedDigit()).foregroundStyle(tick.lead ? Color.primary : Color.secondary))
                let w = resolved.measure(in: size).width
                let cx = min(max(tick.lead ? tick.x + 3 + w / 2 : tick.x, PerfAxis.left + w / 2), size.width - PerfAxis.right - w / 2)
                if tick.lead, let seg = timeline.segments.first(where: { $0.start == tick.t }), ax.x(seg.end) - ax.x(seg.start) < w / 2 { continue }
                if placed.contains(where: { abs($0.x - cx) < ($0.w + w) / 2 + 8 }) { continue }
                placed.append((cx, w))
                ctx.draw(resolved, at: CGPoint(x: cx, y: size.height / 2))
            }
        }
        .frame(height: 22)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .overlay(alignment: .topLeading) {
            if let i = pointer.active(bins.count) {
                let x = PerfAxis(segments: timeline.segments, width: width).x(bins[i].t + timeline.binUs / 2)
                Text(timeline.when(bins[i].t) + "–" + perfBinTime(bins[i].t + timeline.binUs, sameDay: true, seconds: timeline.seconds))
                    .font(.caption2.monospacedDigit())
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.primary))
                    .foregroundStyle(Color(nsColor: .windowBackgroundColor))
                    .fixedSize()
                    .alignmentGuide(.leading) { d in min(max(0, x - d.width / 2), max(0, width - d.width)) * -1 }
                    .padding(.top, 2)
                    .allowsHitTesting(false)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(UnevenRoundedRectangle(topLeadingRadius: 6, topTrailingRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
        .accessibilityElement()
        .accessibilityLabel("Performance over time")
        .accessibilityValue(pointer.pinned(bins.count).map { timeline.sentence($0) }
            ?? "No bin selected. \(Formatters.count(bins.count, "bin")) of \(Formatters.duration(timeline.binUs)).")
        .accessibilityAdjustableAction { dir in
            pointer.move(dir == .increment ? 1 : -1, extend: false, count: bins.count)
            if let c = pointer.pinned(bins.count) { AccessibilityNotification.Announcement(timeline.sentence(c)).post() }
        }
        .accessibilityAction(named: "Zoom to This Bin") {
            if let (lo, hi) = pointer.zoomRange(bins.count) { let r = timeline.range(lo, hi); onZoom(r.from, r.to) }
        }
    }
}

// MARK: - Lanes

/// The lanes below the axis. `linked` is the interval under the pointer here or in the list; `onZoom` sets the time
/// range to the selected bins.
struct PerformanceLanesView: View {
    let timeline: PerformanceTimeline
    let intervals: [PerformanceBottleneck]
    @Binding var pointer: PerfPointer
    @Binding var linked: String?
    @Binding var folded: Set<PerfLane>
    var onZoom: (Int64, Int64) -> Void
    var onOpen: (PerformanceBottleneck) -> Void

    @State private var width: CGFloat = 0
    @FocusState private var focused: Bool

    private static let rowHeight: CGFloat = 14
    private var bins: [PerformanceBin] { timeline.bins }
    private var binUs: Int64 { timeline.binUs }
    private var axis: PerfAxis { PerfAxis(segments: timeline.segments, width: width) }
    private func when(_ t: Int64) -> String { timeline.when(t) }
    private var active: Int? { pointer.active(bins.count) }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(PerfLane.allCases) { lane in
                if lane != PerfLane.allCases.first { Divider() }
                laneHeader(lane).id(lane)
                if !folded.contains(lane) {
                    Canvas { ctx, size in draw(lane, ctx, size) }
                        .frame(height: lane == .intervals ? intervalsHeight : lane.height)
                        .contentShape(Rectangle())
                        .onContinuousHover { phase in hovered(lane, phase) }
                        .gesture(dragGesture)
                        .onTapGesture { p in tapped(lane, at: p) }
                        .accessibilityHidden(true)
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 6, bottomTrailingRadius: 6))
        .overlay(UnevenRoundedRectangle(bottomLeadingRadius: 6, bottomTrailingRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
        .focusable()
        .focused($focused)
        .onKeyPress(keys: [.leftArrow, .rightArrow, .home, .end, .return, .escape], phases: .down) { press in key(press) }
    }

    // MARK: Axis and headers

    private func laneHeader(_ lane: PerfLane) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Button {
                if folded.contains(lane) { folded.remove(lane) } else { folded.insert(lane) }
            } label: {
                Label(lane.title, systemImage: folded.contains(lane) ? "chevron.right" : "chevron.down")
                    .labelStyle(.titleAndIcon)
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .help(lane.help)
            .accessibilityValue(folded.contains(lane) ? "Folded" : "Shown")
            readout(lane)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private func readout(_ lane: PerfLane) -> some View {
        let caption = Font.caption.monospacedDigit()
        switch lane {
        case .busy:
            let totals = active.map { bins[$0].busy } ?? timeline.busy
            HStack(spacing: 10) {
                if let i = active { Text(lane.text(bins[i], binUs: binUs)).font(caption.weight(.semibold)) }
                ForEach(PerfBusy.order.filter { (totals[$0] ?? 0) > 0 }, id: \.self) { name in
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2).fill(PerfBusy.color(name)).frame(width: 8, height: 8).accessibilityHidden(true)
                        Text("\(PerfBusy.label(name)) \(Formatters.duration(totals[name] ?? 0))")
                    }
                }
                if active == nil, totals.values.allSatisfy({ $0 == 0 }) { Text("No timed work in this view") }
            }
            .font(caption).foregroundStyle(.secondary).lineLimit(1)
        case .intervals:
            if let r = intervals.first(where: { $0.spanId == linked }), let rank = intervals.firstIndex(of: r) {
                HStack(spacing: 8) {
                    Text("\(rank + 1). \(r.name)").font(caption.weight(.semibold)).lineLimit(1)
                    Text("\(PerfBusy.interval(r.bucket.rawValue)) · \(Formatters.duration(r.duration))\(r.estimated ? "≈" : "") · \(when(r.start))")
                        .font(caption).foregroundStyle(.secondary)
                }
            } else {
                Text(intervals.isEmpty ? "No completed, timed intervals in this view" : "\(Formatters.count(intervals.count, "interval")), numbered as in the list below")
                    .font(caption).foregroundStyle(.secondary)
            }
        case .calls:
            if let i = active {
                Text(lane.text(bins[i], binUs: binUs)).font(caption).foregroundStyle(.secondary)
            } else if let p = peakIndex(bins.map { $0.calls + $0.tools > 0 ? Double($0.calls + $0.tools) : .nan }, lowest: false) {
                HStack(spacing: 10) {
                    peakButton("busiest \(Formatters.count(bins[p].calls + bins[p].tools, "call")) at \(when(bins[p].t))", bin: p)
                    let failed = bins.reduce(0) { $0 + $1.failed }
                    Text(failed > 0 ? "\(Formatters.count(failed)) failed in all" : "none failed").font(caption).foregroundStyle(.secondary)
                }
            }
        default:
            if let i = active {
                Text(lane.text(bins[i], binUs: binUs)).font(caption).foregroundStyle(.secondary)
            } else if let peak = lane.peak,
                      let p = peakIndex(bins.map { (peak.secondary ? lane.values($0).1 : lane.values($0).0) ?? .nan }, lowest: peak.lowest) {
                let v = (peak.secondary ? lane.values(bins[p]).1 : lane.values(bins[p]).0) ?? 0
                peakButton("\(peak.text) \(lane.format(v)) at \(when(bins[p].t))", bin: p)
            } else {
                Text("Not recorded in this view").font(caption).foregroundStyle(.secondary)
            }
        }
    }

    private func peakButton(_ title: String, bin: Int) -> some View {
        Button(title) { focus(bin) }
            .buttonStyle(.link)
            .font(.caption.monospacedDigit())
            .help("Move the cursor to this bin")
    }

    /// The largest or smallest value, the earliest on a tie; NaN marks a missing value.
    private func peakIndex(_ values: [Double], lowest: Bool) -> Int? {
        var best: Int?
        for (i, v) in values.enumerated() where v.isFinite {
            if let b = best, lowest ? v >= values[b] : v <= values[b] { continue }
            best = i
        }
        return best
    }

    // MARK: Drawing

    private var packed: [Int] {
        let ax = axis
        return perfPackRows(intervals.enumerated().map { i, r in
            let x0 = ax.x(r.start)
            let x1 = max(ax.x(r.start + r.duration), x0 + 3)
            let label = CGFloat(7 * String(i + 1).count + 4)
            return (x0, x1 - x0 >= label + 6 ? x1 : x1 + label + 3)
        })
    }

    private var intervalsHeight: CGFloat { 8 + Self.rowHeight * CGFloat(max(1, (packed.max() ?? 0) + 1)) }

    private func draw(_ lane: PerfLane, _ ctx: GraphicsContext, _ size: CGSize) {
        let ax = PerfAxis(segments: timeline.segments, width: size.width)
        let h = size.height
        // Shared frame: tick lines, idle breaks, the selection and the cursor.
        for tick in ax.ticks() {
            ctx.stroke(Path { $0.move(to: CGPoint(x: tick.x, y: 0)); $0.addLine(to: CGPoint(x: tick.x, y: h)) },
                       with: .color(Color(nsColor: .separatorColor).opacity(0.6)), lineWidth: 1)
        }
        for b in ax.breaks {
            ctx.fill(Path(CGRect(x: b.x0, y: 0, width: b.x1 - b.x0, height: h)), with: .color(.secondary.opacity(0.12)))
        }
        if let (lo, hi) = pointer.selection(bins.count) {
            let x0 = ax.x(bins[lo].t), x1 = ax.x(bins[hi].t + binUs)
            ctx.fill(Path(CGRect(x: x0, y: 0, width: x1 - x0, height: h)), with: .color(.accentColor.opacity(0.16)))
        }
        if let i = active {
            let x0 = ax.x(bins[i].t), x1 = ax.x(bins[i].t + binUs)
            ctx.fill(Path(CGRect(x: x0, y: 0, width: max(1, x1 - x0), height: h)), with: .color(.primary.opacity(0.06)))
            ctx.stroke(Path { $0.move(to: CGPoint(x: (x0 + x1) / 2, y: 0)); $0.addLine(to: CGPoint(x: (x0 + x1) / 2, y: h)) },
                       with: .color(.secondary), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
        }
        switch lane {
        case .busy: drawBusy(ctx, ax, h)
        case .calls: drawCalls(ctx, ax, h)
        case .intervals: drawIntervals(ctx, ax, size)
        default: drawSeries(lane, ctx, ax, size)
        }
    }

    private func barRect(_ ax: PerfAxis, _ b: PerformanceBin) -> (x: CGFloat, w: CGFloat) {
        let x0 = ax.x(b.t), x1 = ax.x(b.t + binUs)
        return (x0, max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0)))
    }

    private func yAxis(_ ctx: GraphicsContext, _ ax: PerfAxis, _ h: CGFloat, top: String) {
        ctx.draw(Text(top).font(.caption2.monospacedDigit()).foregroundStyle(.secondary), at: CGPoint(x: PerfAxis.left - 6, y: 8), anchor: .trailing)
        ctx.draw(Text("0").font(.caption2.monospacedDigit()).foregroundStyle(.secondary), at: CGPoint(x: PerfAxis.left - 6, y: h - 6), anchor: .trailing)
        ctx.stroke(Path { $0.move(to: CGPoint(x: PerfAxis.left, y: h - 0.5)); $0.addLine(to: CGPoint(x: ax.width - PerfAxis.right, y: h - 0.5)) },
                   with: .color(Color(nsColor: .separatorColor)), lineWidth: 1)
    }

    private func drawBusy(_ ctx: GraphicsContext, _ ax: PerfAxis, _ h: CGFloat) {
        let top = perfNiceMax(max(1, bins.map { Double($0.busyUs) / Double(binUs) }.max() ?? 1), lane: .busy)
        let k = (h - 6) / top
        for (i, b) in bins.enumerated() {
            let (x, w) = barRect(ax, b)
            var base = h
            for name in PerfBusy.order {
                guard let us = b.busy[name], us > 0 else { continue }
                let bh = CGFloat(Double(us) / Double(binUs) * k)
                ctx.fill(Path(CGRect(x: x, y: base - bh, width: w, height: bh)),
                         with: .color(PerfBusy.color(name).opacity(active == nil || active == i ? 0.9 : 0.6)))
                base -= bh
            }
        }
        if top > 1 {
            let y = h - CGFloat(k)
            ctx.stroke(Path { $0.move(to: CGPoint(x: PerfAxis.left, y: y)); $0.addLine(to: CGPoint(x: ax.width - PerfAxis.right, y: y)) },
                       with: .color(.secondary), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        }
        yAxis(ctx, ax, h, top: Formatters.shortPercent(top))
    }

    private func drawCalls(_ ctx: GraphicsContext, _ ax: PerfAxis, _ h: CGFloat) {
        let top = perfNiceMax(Double(bins.map { $0.calls + $0.tools }.max() ?? 1), lane: .calls)
        let k = (h - 8) / top
        for (i, b) in bins.enumerated() {
            let (x, w) = barRect(ax, b)
            let llm = CGFloat(Double(b.calls) * k), tool = CGFloat(Double(b.tools) * k)
            let alpha = active == nil || active == i ? 0.9 : 0.6
            ctx.fill(Path(CGRect(x: x, y: h - llm, width: w, height: llm)), with: .color(Theme.color(.llm).swiftUI.opacity(alpha)))
            ctx.fill(Path(CGRect(x: x, y: h - llm - tool, width: w, height: tool)), with: .color(PerfBusy.color("tool").opacity(alpha)))
            if b.failed > 0 {
                ctx.fill(Path(ellipseIn: CGRect(x: x + w / 2 - 2.5, y: max(1.5, h - llm - tool - 6.5), width: 5, height: 5)), with: .color(Theme.err.swiftUI))
            }
        }
        yAxis(ctx, ax, h, top: Formatters.tokens(Int(top)))
    }

    private func drawSeries(_ lane: PerfLane, _ ctx: GraphicsContext, _ ax: PerfAxis, _ size: CGSize) {
        let h = size.height
        let all = bins.flatMap { b -> [Double] in let v = lane.values(b); return [v.0, v.1].compactMap { $0 } }
        guard !all.isEmpty else {
            ctx.draw(Text("Not recorded in this view").font(.caption).foregroundStyle(.secondary), at: CGPoint(x: (size.width + PerfAxis.left) / 2, y: h / 2))
            return
        }
        let top = perfNiceMax(perfLaneTop(all), lane: lane)
        func y(_ v: Double) -> CGFloat { h - 2 - CGFloat(min(v, top) / top) * (h - 8) }
        let color = Theme.color(.llm).swiftUI
        for secondary in [false, true] {
            let value = { (b: PerformanceBin) in secondary ? lane.values(b).1 : lane.values(b).0 }
            let shading = GraphicsContext.Shading.color(color.opacity(secondary ? 0.55 : 1))
            let style = StrokeStyle(lineWidth: secondary ? 1 : 1.5, dash: secondary ? [4, 3] : [])
            for (i, b) in bins.enumerated() {
                guard let v = value(b) else { continue }
                let x = ax.x(b.t + binUs / 2)
                let joined = i > 0 && bins[i - 1].t + binUs == b.t && value(bins[i - 1]) != nil
                if joined, let pv = value(bins[i - 1]) {
                    ctx.stroke(Path { $0.move(to: CGPoint(x: ax.x(bins[i - 1].t + binUs / 2), y: y(pv))); $0.addLine(to: CGPoint(x: x, y: y(v))) },
                               with: shading, style: style)
                }
                let isolated = !joined && !(i + 1 < bins.count && b.t + binUs == bins[i + 1].t && value(bins[i + 1]) != nil)
                if v > top {
                    ctx.fill(Path { $0.move(to: CGPoint(x: x - 3.5, y: 7)); $0.addLine(to: CGPoint(x: x + 3.5, y: 7)); $0.addLine(to: CGPoint(x: x, y: 1)); $0.closeSubpath() },
                             with: shading)
                } else if isolated || active == i {
                    let r: CGFloat = active == i ? 3 : 2
                    ctx.fill(Path(ellipseIn: CGRect(x: x - r, y: y(v) - r, width: 2 * r, height: 2 * r)), with: shading)
                }
            }
        }
        yAxis(ctx, ax, h, top: lane.axisLabel(top))
    }

    private func drawIntervals(_ ctx: GraphicsContext, _ ax: PerfAxis, _ size: CGSize) {
        let rows = packed
        let lit = linked
        for (i, r) in intervals.enumerated() {
            let x0 = ax.x(r.start), x1 = max(ax.x(r.start + r.duration), x0 + 3)
            let rect = CGRect(x: x0, y: 4 + CGFloat(rows[i]) * Self.rowHeight, width: x1 - x0, height: Self.rowHeight - 4)
            ctx.fill(Path(rect), with: .color(PerfBusy.color(r.bucket.rawValue).opacity(lit == nil || lit == r.spanId ? 0.9 : 0.45)))
            if lit == r.spanId { ctx.stroke(Path(rect.insetBy(dx: -1, dy: -1)), with: .color(.primary), lineWidth: 1.5) }
            let w = ctx.resolve(Text(String(i + 1)).font(.caption2.monospacedDigit())).measure(in: size).width
            let inside = x1 - x0 >= w + 6
            ctx.draw(Text(String(i + 1)).font(.caption2.monospacedDigit()).foregroundStyle(inside ? Color(nsColor: .controlBackgroundColor) : Color.primary),
                      at: CGPoint(x: inside ? x0 + 3 : min(x1 + 3, size.width - w - 2), y: rect.midY), anchor: .leading)
        }
    }

    // MARK: Pointer and keyboard

    private func binIndex(at x: CGFloat) -> Int? {
        guard let t = axis.t(x) else { return nil }
        var lo = 0, hi = bins.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if t < bins[mid].t { hi = mid - 1 } else if t >= bins[mid].t + binUs { lo = mid + 1 } else { return mid }
        }
        return nil
    }

    private func interval(at p: CGPoint) -> PerformanceBottleneck? {
        let ax = axis
        let rows = packed
        for (i, r) in intervals.enumerated().reversed() {
            let x0 = ax.x(r.start), x1 = max(ax.x(r.start + r.duration), x0 + 3)
            let y = 4 + CGFloat(rows[i]) * Self.rowHeight
            if p.x >= x0 - 2 && p.x <= x1 + 2 && p.y >= y - 2 && p.y <= y + Self.rowHeight { return r }
        }
        return nil
    }

    private func hovered(_ lane: PerfLane, _ phase: HoverPhase) {
        switch phase {
        case .active(let p):
            pointer.hover = binIndex(at: p.x)
            if lane == .intervals {
                linked = interval(at: p)?.spanId
                (linked != nil ? NSCursor.pointingHand : NSCursor.arrow).set()
            }
        case .ended:
            pointer.hover = nil
            if lane == .intervals {
                linked = nil
                NSCursor.arrow.set()
            }
        }
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { g in
                guard let a = binIndex(at: g.startLocation.x) else { return }
                let b = binIndex(at: g.location.x) ?? pointer.drag?.b ?? a
                pointer.drag = (a, b)
                pointer.hover = b
            }
            .onEnded { _ in
                defer { pointer.drag = nil }
                guard let (lo, hi) = pointer.selection(bins.count), pointer.drag != nil else { return }
                let r = timeline.range(lo, hi)
                onZoom(r.from, r.to)
            }
    }

    /// A click opens an interval, or pins the cursor on a bin (a second click unpins it).
    private func tapped(_ lane: PerfLane, at p: CGPoint) {
        if lane == .intervals, let r = interval(at: p) {
            onOpen(r)
            return
        }
        guard let i = binIndex(at: p.x) else { return }
        focused = true
        pointer.cursor = pointer.pinned(bins.count) == i ? nil : i
        pointer.anchor = nil
    }

    private func focus(_ i: Int) {
        pointer.jump(to: i, extend: false, count: bins.count)
        focused = true
        AccessibilityNotification.Announcement(timeline.sentence(i)).post()
    }

    private func announce() {
        if let (lo, hi) = pointer.selection(bins.count) {
            AccessibilityNotification.Announcement(timeline.selectionSentence(lo, hi)).post()
        } else if let c = pointer.pinned(bins.count) {
            AccessibilityNotification.Announcement(timeline.sentence(c)).post()
        }
    }

    private func key(_ press: KeyPress) -> KeyPress.Result {
        let extend = press.modifiers.contains(.shift)
        let n = bins.count
        switch press.key {
        case .leftArrow: pointer.move(-1, extend: extend, count: n)
        case .rightArrow: pointer.move(1, extend: extend, count: n)
        case .home: pointer.jump(to: 0, extend: extend, count: n)
        case .end: pointer.jump(to: n - 1, extend: extend, count: n)
        case .return:
            guard let (lo, hi) = pointer.zoomRange(n) else { return .ignored }
            let r = timeline.range(lo, hi)
            onZoom(r.from, r.to)
            return .handled
        case .escape:
            guard pointer.cursor != nil || pointer.anchor != nil else { return .ignored }
            pointer = PerfPointer()
            return .handled
        default: return .ignored
        }
        announce()
        return .handled
    }
}
