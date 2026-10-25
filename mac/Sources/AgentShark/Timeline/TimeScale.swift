import Foundation

// Time-axis math for the timeline (MAC-SPEC §6, SPEC §7.2), ported from web/js/lib/timescale.js: a
// piecewise-linear time → x mapping that collapses idle gaps into fixed-width breaks, zoom, pan and fit
// helpers, and local-time ticks from years down to microseconds. Pure value code with no AppKit.
//
// Times are microseconds since the epoch held as Double (exact below 2^53 µs, about the year 2255).

/// The visible part of the time axis: `t0` is the time at x = 0, `k` is points per microsecond of
/// uncollapsed time.
struct TimeViewport: Hashable, Sendable {
    var t0: Double
    var k: Double
}

/// An idle stretch of time between busy intervals.
struct TimeGap: Hashable, Sendable {
    var start: Double
    var end: Double

    var length: Double { end - start }
}

/// One zoom level's mapping between time and x. A gap collapses only when its linear width would exceed
/// `breakWidth`, so a gap never takes more room than it would uncollapsed and the total width is continuous in
/// `k`. Time inside a break maps linearly across the break, which keeps the mapping monotonic and invertible.
struct TimeScale: Sendable {
    /// Gaps shorter than this stay uncollapsed (MAC-SPEC §6 default; Settings changes it).
    static let defaultMinGap: Double = 5 * 60e6
    /// Width of a collapsed gap.
    static let breakWidth: Double = 24
    /// Deepest zoom: one microsecond spans 4 points.
    static let maxK: Double = 4

    let t0: Double
    let k: Double
    let breakWidth: Double
    /// The gaps collapsed at this zoom, in time order.
    let collapsed: [TimeGap]
    /// x of each collapsed gap's left edge before the shift that puts `t0` at 0.
    private let gx: [Double]
    private let x0: Double

    init(_ viewport: TimeViewport, gaps: [TimeGap] = [], breakWidth: Double = TimeScale.breakWidth) {
        let k = viewport.k
        t0 = viewport.t0
        self.k = k
        self.breakWidth = breakWidth
        let active = gaps.filter { $0.length * k > breakWidth }
        collapsed = active
        var gx: [Double] = []
        gx.reserveCapacity(active.count)
        var removed = 0.0
        for (i, g) in active.enumerated() {
            gx.append((g.start - viewport.t0 - removed) * k + Double(i) * breakWidth)
            removed += g.length
        }
        self.gx = gx
        x0 = TimeScale.raw(viewport.t0, t0: viewport.t0, k: k, collapsed: active, gx: gx, breakWidth: breakWidth)
    }

    var viewport: TimeViewport { TimeViewport(t0: t0, k: k) }

    private static func raw(_ t: Double, t0: Double, k: Double, collapsed: [TimeGap], gx: [Double], breakWidth: Double) -> Double {
        let i = lastIndex(collapsed.count, atOrBelow: t) { collapsed[$0].start }
        guard i >= 0 else { return (t - t0) * k }
        let g = collapsed[i]
        if t < g.end { return gx[i] + (t - g.start) / g.length * breakWidth }
        return gx[i] + breakWidth + (t - g.end) * k
    }

    /// x of time `t`.
    func x(_ t: Double) -> Double {
        TimeScale.raw(t, t0: t0, k: k, collapsed: collapsed, gx: gx, breakWidth: breakWidth) - x0
    }

    /// Time at `x` (the inverse of `x(_:)`).
    func t(_ x: Double) -> Double {
        let v = x + x0
        let i = TimeScale.lastIndex(gx.count, atOrBelow: v) { gx[$0] }
        guard i >= 0 else { return t0 + v / k }
        let g = collapsed[i]
        if v < gx[i] + breakWidth { return g.start + (v - gx[i]) / breakWidth * g.length }
        return g.end + (v - gx[i] - breakWidth) / k
    }

    /// Collapsed gaps intersecting [from, to], with the x of their left edge.
    func breaks(from: Double, to: Double) -> [(gap: TimeGap, x: Double)] {
        var out: [(gap: TimeGap, x: Double)] = []
        var i = max(0, TimeScale.lastIndex(collapsed.count, atOrBelow: from) { collapsed[$0].start })
        while i < collapsed.count {
            let g = collapsed[i]
            if g.start >= to { break }
            if g.end > from { out.append((g, x(g.start))) }
            i += 1
        }
        return out
    }

    /// The uncollapsed stretches of [from, to] between breaks.
    func segments(from: Double, to: Double) -> [TimeGap] {
        var out: [TimeGap] = []
        var a = from
        for (g, _) in breaks(from: from, to: to) {
            if g.end <= a { continue }
            if g.start > a { out.append(TimeGap(start: a, end: g.start)) }
            a = g.end
        }
        if a < to { out.append(TimeGap(start: a, end: to)) }
        return out
    }

    /// Index of the last i in [0, n) with key(i) <= v (keys ascending), or -1.
    static func lastIndex(_ n: Int, atOrBelow v: Double, key: (Int) -> Double) -> Int {
        var lo = 0, hi = n - 1, found = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if key(mid) <= v {
                found = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return found
    }
}

// MARK: - Gaps, fit, zoom and pan

extension TimeScale {
    /// Idle gaps longer than `minGap` between busy intervals. Intervals may overlap; a nil or inverted end is a
    /// point. The result is sorted and disjoint.
    static func findGaps(_ intervals: [(start: Double, end: Double?)], minGap: Double = defaultMinGap) -> [TimeGap] {
        var iv: [(Double, Double)] = []
        iv.reserveCapacity(intervals.count)
        for it in intervals where it.start.isFinite {
            let end = it.end.flatMap { $0.isFinite && $0 > it.start ? $0 : nil } ?? it.start
            iv.append((it.start, end))
        }
        iv.sort { $0.0 < $1.0 }
        var gaps: [TimeGap] = []
        var reach = -Double.infinity
        for (a, b) in iv {
            if reach > -.infinity, a - reach > minGap { gaps.append(TimeGap(start: reach, end: a)) }
            if b > reach { reach = b }
        }
        return gaps
    }

    /// The viewport that shows [from, to] across `width` points with `pad` points on each side. With gaps the
    /// width depends on which gaps collapse at a given k, so k is found by bisection (width grows with k).
    static func fit(from: Double, to: Double, width: Double, gaps: [TimeGap] = [], breakWidth: Double = TimeScale.breakWidth,
                    pad: Double = 0, maxK: Double = TimeScale.maxK) -> TimeViewport {
        let to = to > from ? to : from + 1000
        let target = max(1, width - 2 * pad)
        func widthAt(_ k: Double) -> Double { TimeScale(TimeViewport(t0: from, k: k), gaps: gaps, breakWidth: breakWidth).x(to) }
        var lo = target / (to - from)
        var hi = lo
        var i = 0
        while i < 80, widthAt(hi) < target {
            hi *= 2
            i += 1
        }
        i = 0
        while i < 60, hi / lo > 1 + 1e-9 {
            let mid = (lo * hi).squareRoot()
            if widthAt(mid) < target { lo = mid } else { hi = mid }
            i += 1
        }
        let k = min(hi, maxK)
        return TimeViewport(t0: TimeScale(TimeViewport(t0: from, k: k), gaps: gaps, breakWidth: breakWidth).t(-pad), k: k)
    }

    /// Scale by `factor` while the time under `x` stays under `x`.
    static func zoom(_ v: TimeViewport, around x: Double, factor: Double, gaps: [TimeGap] = [],
                     breakWidth: Double = TimeScale.breakWidth, minK: Double = 0, maxK: Double = TimeScale.maxK) -> TimeViewport {
        let anchor = TimeScale(v, gaps: gaps, breakWidth: breakWidth).t(x)
        let k = min(maxK, max(minK, v.k * factor))
        return TimeViewport(t0: TimeScale(TimeViewport(t0: anchor, k: k), gaps: gaps, breakWidth: breakWidth).t(-x), k: k)
    }

    /// Move so the time now at `dx` becomes the left edge.
    static func pan(_ v: TimeViewport, by dx: Double, gaps: [TimeGap] = [], breakWidth: Double = TimeScale.breakWidth) -> TimeViewport {
        TimeViewport(t0: TimeScale(v, gaps: gaps, breakWidth: breakWidth).t(dx), k: v.k)
    }

    /// The viewport at zoom `k` that puts time `t` at `x`.
    static func place(_ t: Double, at x: Double, k: Double, gaps: [TimeGap] = [], breakWidth: Double = TimeScale.breakWidth) -> TimeViewport {
        TimeViewport(t0: TimeScale(TimeViewport(t0: t, k: k), gaps: gaps, breakWidth: breakWidth).t(-x), k: k)
    }

    /// Pan `v` so that part of [lo, hi] stays on screen after a pan or zoom.
    static func keepInView(_ v: TimeViewport, extent: (lo: Double, hi: Double)?, width: Double, gaps: [TimeGap] = [],
                           breakWidth: Double = TimeScale.breakWidth) -> TimeViewport {
        guard let extent else { return v }
        let s = TimeScale(v, gaps: gaps, breakWidth: breakWidth)
        let xa = s.x(extent.lo), xb = s.x(extent.hi)
        let margin = min(width / 4, 120)
        if xb < margin { return pan(v, by: xb - margin, gaps: gaps, breakWidth: breakWidth) }
        if xa > width - margin { return pan(v, by: xa - (width - margin), gaps: gaps, breakWidth: breakWidth) }
        return v
    }
}

// MARK: - Ticks

/// Ruler ticks aligned to local time in a given zone, adapting from years down to microseconds.
enum TimeTicks {
    enum Unit: String, Sendable { case us, ms, s, min, h, d, mo, y }

    struct Step: Hashable, Sendable {
        var us: Double
        var unit: Unit
        var n: Int
    }

    struct Tick: Hashable, Sendable {
        var t: Double
        var x: Double
        var text: String
        /// A boundary of the next larger unit (midnight, a whole second, …).
        var major: Bool
        /// The first time after a break, added when no regular tick is close.
        var edge = false
    }

    struct Axis: Sendable {
        var step: Step
        /// The parts of the time the tick labels leave out (date, year), with the UTC offset.
        var context: String
        var ticks: [Tick]
    }

    static let ms = 1e3, s = 1e6, min = 60e6, h = 3600e6, d = 86400e6
    private static let maxTicks = 2000

    static let steps: [Step] = {
        var out: [Step] = []
        for n in [1, 2, 5, 10, 20, 50, 100, 200, 500] { out.append(Step(us: Double(n), unit: .us, n: n)) }
        for n in [1, 2, 5, 10, 20, 50, 100, 200, 500] { out.append(Step(us: Double(n) * ms, unit: .ms, n: n)) }
        for n in [1, 2, 5, 10, 15, 30] { out.append(Step(us: Double(n) * s, unit: .s, n: n)) }
        for n in [1, 2, 5, 10, 15, 30] { out.append(Step(us: Double(n) * min, unit: .min, n: n)) }
        for n in [1, 2, 3, 6, 12] { out.append(Step(us: Double(n) * h, unit: .h, n: n)) }
        for n in [1, 2, 7, 14] { out.append(Step(us: Double(n) * d, unit: .d, n: n)) }
        for n in [1, 3, 6] { out.append(Step(us: Double(n) * 30.44 * d, unit: .mo, n: n)) }
        for n in [1, 2, 5, 10] { out.append(Step(us: Double(n) * 365.25 * d, unit: .y, n: n)) }
        return out
    }()

    /// The smallest step whose spacing at `k` points per µs is at least `minSpacing`.
    static func pickStep(k: Double, minSpacing: Double = 80) -> Step {
        steps.first { $0.us * k >= minSpacing } ?? steps[steps.count - 1]
    }

    /// Tick times in [from, to] on local boundaries in `zone`. Sub-hour steps use arithmetic on local time; hours
    /// and larger step a calendar so ticks stay on hour, midnight, month and year boundaries across DST changes.
    static func times(from: Double, to: Double, step: Step, zone: TimeZone) -> [Double] {
        guard to >= from else { return [] }
        var out: [Double] = []
        switch step.unit {
        case .us, .ms, .s, .min:
            let off = offset(at: from, zone: zone)
            var t = ((from + off) / step.us).rounded(.up) * step.us - off
            while t <= to, out.count < maxTicks {
                out.append(t)
                t += step.us
            }
            return out
        case .h, .d, .mo, .y:
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = zone
            let fromDate = Date(timeIntervalSince1970: from / 1e6)
            let n = step.n
            let start: Date?
            let advance: Calendar.Component
            let keep: (DateComponents) -> Bool
            switch step.unit {
            case .h:
                start = cal.dateInterval(of: .hour, for: fromDate)?.start
                advance = .hour
                keep = { ($0.hour ?? 0) % n == 0 && ($0.minute ?? 0) == 0 }
            case .d:
                start = cal.startOfDay(for: fromDate)
                advance = .day
                keep = { c in
                    guard let y = c.year, let m = c.month, let day = c.day else { return false }
                    return n == 1 || civilDay(year: y, month: m, day: day) % n == 0
                }
            case .mo:
                start = cal.dateInterval(of: .month, for: fromDate)?.start
                advance = .month
                keep = { c in ((c.year ?? 0) * 12 + (c.month ?? 1) - 1) % n == 0 }
            default:
                start = cal.dateInterval(of: .year, for: fromDate)?.start
                advance = .year
                keep = { ($0.year ?? 0) % n == 0 }
            }
            guard var date = start else { return out }
            var prev = -Double.infinity
            var guardCount = 0
            while guardCount < 40 * maxTicks, out.count < maxTicks {
                guardCount += 1
                let t = date.timeIntervalSince1970 * 1e6
                if t > to { break }
                let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: date)
                if t >= from, t > prev, keep(c) { out.append(t.rounded()) }
                prev = t
                guard let next = cal.date(byAdding: advance, value: 1, to: date) else { break }
                date = next
            }
            return out
        }
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date (aligns multi-day steps; gives the weekday).
    static func civilDay(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /// The zone's offset from UTC at `t`, in µs (east is positive).
    static func offset(at t: Double, zone: TimeZone) -> Double {
        Double(zone.secondsFromGMT(for: Date(timeIntervalSince1970: t / 1e6))) * 1e6
    }

    private static let monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    private static let weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    private static func parts(_ t: Double, zone: TimeZone) -> Formatters.Parts {
        Formatters.components(Int64(t.rounded(.down)), zone: zone)
    }

    private static func two(_ v: Int) -> String { v < 10 ? "0\(v)" : String(v) }

    /// Tick label. Sub-second ticks show only the fraction; whole seconds show the clock time.
    static func label(_ t: Double, step: Step, zone: TimeZone) -> (text: String, major: Bool) {
        let p = parts(t, zone: zone)
        let hhmm = "\(two(p.hour)):\(two(p.minute))"
        let date = "\(monthNames[p.month - 1]) \(p.day)"
        switch step.unit {
        case .y:
            return (String(p.year), false)
        case .mo:
            return p.month == 1 ? (String(p.year), true) : (monthNames[p.month - 1], false)
        case .d:
            return (date, p.day == 1)
        case .h, .min:
            if hhmm == "00:00", p.second == 0, p.micros == 0 { return (date, true) }
            return (hhmm, false)
        case .s:
            return ("\(hhmm):\(two(p.second))", p.second == 0)
        case .ms, .us:
            if p.micros == 0 { return ("\(hhmm):\(two(p.second))", true) }
            if step.unit == .ms || p.micros % 1000 == 0 {
                return ("." + String(format: "%03d", p.micros / 1000), false)
            }
            return ("." + String(format: "%06d", p.micros), false)
        }
    }

    /// The left-end context: the date (and clock for sub-second steps) the labels leave out, plus the UTC offset.
    static func context(_ t: Double, step: Step, zone: TimeZone) -> String {
        let p = parts(t, zone: zone)
        let zoneText = offsetLabel(at: t, zone: zone)
        if step.us >= d { return "\(p.year) · \(zoneText)" }
        // 1970-01-01 was a Thursday.
        let weekday = weekdayNames[((civilDay(year: p.year, month: p.month, day: p.day) % 7) + 11) % 7]
        let day = "\(weekday) \(monthNames[p.month - 1]) \(p.day) \(p.year)"
        if step.us >= s { return "\(day) · \(zoneText)" }
        return "\(day) \(two(p.hour)):\(two(p.minute)):\(two(p.second)) · \(zoneText)"
    }

    /// `UTC`, `UTC+08:00`, `UTC-05:00`.
    static func offsetLabel(at t: Double, zone: TimeZone) -> String {
        let secs = zone.secondsFromGMT(for: Date(timeIntervalSince1970: t / 1e6))
        if secs == 0 { return "UTC" }
        let a = abs(secs)
        return "UTC" + (secs < 0 ? "-" : "+") + two(a / 3600) + ":" + two((a % 3600) / 60)
    }

    /// Ticks for the visible [0, width] of `scale`, generated per uncollapsed segment. A segment that starts after
    /// a break gets an `edge` tick at its start when no regular tick is close.
    static func axis(_ scale: TimeScale, width: Double, minSpacing: Double = 80, zone: TimeZone) -> Axis {
        let step = pickStep(k: scale.k, minSpacing: minSpacing)
        let from = scale.t(0), to = scale.t(width)
        var ticks: [Tick] = []
        for seg in scale.segments(from: from, to: to) {
            let ts = times(from: seg.start, to: seg.end, step: step, zone: zone)
            let segX = scale.x(seg.start)
            if seg.start > from, !(ts.first.map { scale.x($0) - segX < minSpacing / 2 } ?? false) {
                let l = label(seg.start, step: step, zone: zone)
                ticks.append(Tick(t: seg.start, x: segX, text: l.text, major: l.major, edge: true))
            }
            for t in ts {
                let l = label(t, step: step, zone: zone)
                ticks.append(Tick(t: t, x: scale.x(t), text: l.text, major: l.major))
            }
        }
        return Axis(step: step, context: context(from, step: step, zone: zone), ticks: ticks)
    }
}
