import Foundation

/// Text formatting for times, durations, sizes and counts (SPEC §7.8 "Time is unambiguous").
///
/// Missing values are "—"; 0 always means a measured zero. Compact times omit the date and the UTC offset,
/// so a column that uses them shows the offset in its title (`timeColumnTitle`) and the full timestamp on hover.
enum Formatters {
    /// The placeholder for a missing value.
    static let missing = "—"

    /// Time zone for local times. Tests replace it; the app follows the system setting.
    nonisolated(unsafe) static var timeZone: TimeZone = .autoupdatingCurrent

    // MARK: Times

    /// A time cell in the given format. `first`, `prev` and `sessionStart` anchor the relative formats.
    static func time(_ us: Int64, format: TimeFormat, first: Int64?, prev: Int64?, sessionStart: Int64?) -> String {
        switch format {
        case .local: return clock(us, zone: timeZone)
        case .utc: return clock(us, zone: utc)
        case .relFirst: return offset(us - (first ?? us))
        case .deltaPrev: return offset(us - (prev ?? us))
        case .relSession: return offset(us - (sessionStart ?? us))
        }
    }

    /// The Time column title, naming the zone or the anchor.
    static func timeColumnTitle(_ format: TimeFormat, at us: Int64? = nil) -> String {
        switch format {
        // The scope bar's "Times +08:00" names the zone of local times.
        case .local: return "Time"
        case .utc: return "Time (UTC)"
        case .relFirst: return "Time (since first)"
        case .deltaPrev: return "Δ Time"
        case .relSession: return "Time (since session start)"
        }
    }

    /// `14:03:22.123` in a zone.
    static func clock(_ us: Int64, zone: TimeZone) -> String {
        let c = components(us, zone: zone)
        return String(format: "%02d:%02d:%02d.%03d", c.hour, c.minute, c.second, c.micros / 1000)
    }

    /// "23:04" in local time; with `offset`, "23:04 +08:00" (the Since chip, where no column title names the zone).
    static func shortClock(_ us: Int64, offset: Bool = false) -> String {
        let c = components(us, zone: timeZone)
        let clock = String(format: "%02d:%02d", c.hour, c.minute)
        return offset ? clock + " " + offsetText(seconds: timeZone.secondsFromGMT(for: date(us))) : clock
    }

    /// A time relative to the time reference (⌃⌘T): `+1:02:03.456` or `-0:00:01.200`.
    static func reference(_ deltaUs: Int64) -> String {
        let sign = deltaUs < 0 ? "-" : "+"
        let a = deltaUs.magnitude
        let ms = (a / 1000) % 1000, s = (a / 1_000_000) % 60, m = (a / 60_000_000) % 60, h = a / 3_600_000_000
        return String(format: "%@%llu:%02llu:%02llu.%03llu", sign, h, m, s, ms)
    }

    /// Full precision with the offset, for tooltips and copying: `2026-10-11 14:03:22.123456 +08:00`. `digits` cuts the
    /// fraction, so 3 gives DESIGN.md §9's `2026-10-11 14:03:22.123 +08:00`.
    static func timestamp(_ us: Int64, utc useUTC: Bool = false, digits: Int = 6) -> String {
        let zone = useUTC ? utc : timeZone
        let c = components(us, zone: zone)
        var base = String(format: "%04d-%02d-%02d %02d:%02d:%02d", c.year, c.month, c.day, c.hour, c.minute, c.second)
        if digits > 0 { base += "." + String(format: "%06d", c.micros).prefix(min(digits, 6)) }
        return useUTC ? base + " UTC" : base + " " + offsetText(seconds: zone.secondsFromGMT(for: date(us)))
    }

    /// ISO 8601 with offset, for machine-readable copies: `2026-10-11T14:03:22.123456+08:00`.
    static func iso8601(_ us: Int64) -> String {
        let c = components(us, zone: timeZone)
        let off = offsetText(seconds: timeZone.secondsFromGMT(for: date(us)))
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%06d", c.year, c.month, c.day, c.hour, c.minute, c.second, c.micros) + off
    }

    /// `Oct 11 14:03` (local), for labels where the offset is shown nearby.
    static func shortDateTime(_ us: Int64) -> String {
        let c = components(us, zone: timeZone)
        return String(format: "%@ %d %02d:%02d", monthNames[c.month - 1], c.day, c.hour, c.minute)
    }

    /// `Oct 11 10:02:13 – 10:07:55 (UTC+08:00)`, with dates on both ends when they differ. Open ends say so.
    static func timeRange(from: Int64?, to: Int64?) -> String {
        func full(_ us: Int64) -> String {
            let c = components(us, zone: timeZone)
            return String(format: "%@ %d %02d:%02d:%02d", monthNames[c.month - 1], c.day, c.hour, c.minute, c.second)
        }
        let zone = "(\(utcOffset(at: from ?? to)))"
        switch (from, to) {
        case let (f?, t?):
            let cf = components(f, zone: timeZone), ct = components(t, zone: timeZone)
            let sameDay = cf.year == ct.year && cf.month == ct.month && cf.day == ct.day
            let end = sameDay ? String(format: "%02d:%02d:%02d", ct.hour, ct.minute, ct.second) : full(t)
            return "\(full(f)) – \(end) \(zone)"
        case let (f?, nil): return "From \(full(f)) \(zone)"
        case let (nil, t?): return "Until \(full(t)) \(zone)"
        default: return "All time"
        }
    }

    /// "+08:00", or "UTC" at a zero offset: the zone a "Times" label names.
    static func offsetLabel(at us: Int64? = nil) -> String {
        let seconds = timeZone.secondsFromGMT(for: us.map(date) ?? Date())
        return seconds == 0 ? "UTC" : offsetText(seconds: seconds)
    }

    /// `UTC+08:00`, `UTC−05:00` or `UTC` for the local zone at a moment (now when nil).
    static func utcOffset(at us: Int64? = nil) -> String {
        let seconds = timeZone.secondsFromGMT(for: us.map(date) ?? Date())
        return seconds == 0 ? "UTC" : "UTC" + offsetText(seconds: seconds)
    }

    /// Signed relative time: `+0.004123` (µs precision under a minute), `+12:05.123`, `+3:12:05`, `+2d 03:12:05`.
    static func offset(_ us: Int64) -> String {
        let sign = us < 0 ? "-" : "+"
        let a = us.magnitude
        if a < 60_000_000 { return sign + String(format: "%d.%06d", a / 1_000_000, a % 1_000_000) }
        let totalSeconds = a / 1_000_000
        let ms = (a % 1_000_000) / 1000
        let s = totalSeconds % 60, m = (totalSeconds / 60) % 60, h = (totalSeconds / 3600) % 24, d = totalSeconds / 86400
        if totalSeconds < 3600 { return sign + String(format: "%d:%02d.%03d", m, s, ms) }
        if d == 0 { return sign + String(format: "%d:%02d:%02d", h, m, s) }
        return sign + String(format: "%dd %02d:%02d:%02d", d, h, m, s)
    }

    /// "just now" (under a minute), "12m ago", "3h ago", "4d ago" (under 7 days), then "Sep 11" in the current year
    /// and "2025-09-11" in other years (DESIGN.md §9).
    static func relative(_ us: Int64, now: Date = Date()) -> String {
        let seconds = now.timeIntervalSince1970 - Double(us) / 1e6
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h ago" }
        if seconds < 7 * 86400 { return "\(Int(seconds / 86400))d ago" }
        return shortDate(us, now: now)
    }

    /// "Oct 6" in the current year, "2025-10-06" in other years.
    static func shortDate(_ us: Int64, now: Date = Date()) -> String {
        let c = components(us, zone: timeZone)
        let nowYear = components(Int64(now.timeIntervalSince1970 * 1e6), zone: timeZone).year
        return c.year == nowYear ? "\(monthNames[c.month - 1]) \(c.day)" : isoDate(us)
    }

    /// "2026-10-06", for fields and reports.
    static func isoDate(_ us: Int64) -> String {
        let c = components(us, zone: timeZone)
        return String(format: "%04d-%02d-%02d", c.year, c.month, c.day)
    }

    /// "Oct 13 07:33:38": a clock time with the short date, for a list whose dates change (§7.9 Dates).
    static func datedClock(_ us: Int64) -> String {
        let c = components(us, zone: timeZone)
        return String(format: "%@ %d %02d:%02d:%02d", monthNames[c.month - 1], c.day, c.hour, c.minute, c.second)
    }

    /// Whether two instants fall on the same local calendar day.
    static func sameDay(_ a: Int64, _ b: Int64) -> Bool {
        let x = components(a, zone: timeZone), y = components(b, zone: timeZone)
        return x.year == y.year && x.month == y.month && x.day == y.day
    }

    // MARK: Durations

    /// A duration with its provenance mark after it (`7m 29s≈`, `45.6s~`, `4s?`); logged values carry no mark.
    /// Nil is "—".
    static func duration(_ us: Int64?, src: String?) -> String {
        guard let us else { return missing }
        return duration(us) + provenanceGlyph(src)
    }

    /// "0.85ms", "2.4ms", "820ms", "7.14s", "7m 09s", "1h 04m", "1d 08h" (DESIGN.md §9): three significant digits
    /// below a minute with no trailing zeros, in ms below a second, and two digits for every unit after the first. A
    /// measured zero is "0ms".
    static func duration(_ us: Int64) -> String {
        let sign = us < 0 ? "−" : ""
        let a = Double(us.magnitude)
        let text: String
        if a < 1000 {
            // Whole µs below 1 ms have at most three significant digits, so the thousandths of a ms are exact.
            var ms = String(format: "0.%03llu", us.magnitude)
            while ms.hasSuffix("0") { ms.removeLast() }
            if ms.hasSuffix(".") { ms.removeLast() }
            text = ms + "ms"
        } else if a < 999_500 {
            text = significant(a / 1000) + "ms"
        } else if a < 59_950_000 {
            text = significant(a / 1e6) + "s"
        } else {
            let t = Int((a / 1e6).rounded())
            if t < 3600 {
                text = String(format: "%dm %02ds", t / 60, t % 60)
            } else if t < 86400 {
                text = String(format: "%dh %02dm", t / 3600, (t % 3600) / 60)
            } else {
                text = String(format: "%dd %02dh", t / 86400, (t % 86400) / 3600)
            }
        }
        return sign + text
    }

    /// Three significant digits with trailing zeros dropped: 2.4, 7.14, 12.3, 820.
    static func significant(_ v: Double) -> String {
        var s = String(format: v < 9.995 ? "%.2f" : v < 99.95 ? "%.1f" : "%.0f", v)
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s
    }

    /// `≈` for derived, `~` for parsed, nothing for logged or unknown.
    static func provenanceGlyph(_ src: String?) -> String {
        guard let src else { return "" }
        if src.hasPrefix("derived") { return "≈" }
        if src.hasPrefix("parsed") { return "~" }
        if src.hasPrefix("inferred") { return "?" }
        return ""
    }

    /// Human description of a duration source, for tooltips.
    static func provenance(_ src: String?) -> String {
        guard let src, src != "unknown" else { return "Duration unknown: the agent did not log it." }
        let detail = src.split(separator: ":", maxSplits: 1).dropFirst().first.map(String.init)
        if src.hasPrefix("logged") { return "Logged by the agent" + (detail.map { " (\($0))" } ?? "") }
        if src.hasPrefix("derived") { return "Derived from timestamps (≈)" }
        if src.hasPrefix("parsed") { return "Parsed from output text" + (detail.map { " (\($0))" } ?? "") + " (~)" }
        return src
    }

    // MARK: Sizes and counts

    /// Decimal units, like Finder: `950 B`, `245 KB`, `11.2 GB`.
    static func bytes(_ n: Int64) -> String {
        let units = ["B", "KB", "MB", "GB", "TB", "PB"]
        var v = Double(n)
        var i = 0
        while abs(v) >= 1000, i < units.count - 1 {
            v /= 1000
            i += 1
        }
        if i == 0 { return "\(n) B" }
        return (abs(v) < 100 ? String(format: "%.1f", v) : String(format: "%.0f", v)) + " " + units[i]
    }

    /// "950", "9.5k", "77.8k", "258k", "1.82M", "12.3M" (the web's `formatTokens`); nil is "—".
    static func tokens(_ n: Int?) -> String {
        guard let n else { return missing }
        let a = Double(abs(n))
        let sign = n < 0 ? "-" : ""
        func trim(_ s: String) -> String {
            guard s.contains(".") else { return s }
            var t = s
            while t.hasSuffix("0") { t.removeLast() }
            if t.hasSuffix(".") { t.removeLast() }
            return t
        }
        if a < 1000 { return String(n) }
        if a < 99_950 { return sign + trim(String(format: "%.1f", a / 1e3)) + "k" }
        if a < 999_500 { return sign + String(format: "%.0f", a / 1e3) + "k" }
        if a < 9_995_000 { return sign + trim(String(format: "%.2f", a / 1e6)) + "M" }
        if a < 999_950_000 { return sign + trim(String(format: "%.1f", a / 1e6)) + "M" }
        return sign + trim(String(format: "%.2f", a / 1e9)) + "B"
    }

    /// `1,204`.
    static func count(_ n: Int) -> String {
        let digits = String(n.magnitude)
        var out = ""
        for (i, ch) in digits.enumerated() {
            if i > 0, (digits.count - i) % 3 == 0 { out.append(",") }
            out.append(ch)
        }
        return (n < 0 ? "-" : "") + out
    }

    /// `1,204 events`, `1 event`.
    static func count(_ n: Int, _ noun: String, plural: String? = nil) -> String {
        "\(count(n)) \(n == 1 ? noun : plural ?? noun + "s")"
    }

    /// Two significant digits for a column of shares: "0%", "0.40%", "4.0%", "5.3%", "12%", "100%".
    static func shortPercent(_ ratio: Double?) -> String {
        guard let ratio, ratio.isFinite else { return missing }
        let p = ratio * 100
        if p == 0 { return "0%" }
        if p < 0.1 { return "<0.1%" }
        return String(format: p >= 9.95 ? "%.0f%%" : p >= 0.995 ? "%.1f%%" : "%.2f%%", p)
    }

    /// `42.1%`.
    static func percent(_ ratio: Double?) -> String {
        guard let ratio, ratio.isFinite else { return missing }
        return String(format: ratio < 0.1 ? "%.2f%%" : "%.1f%%", ratio * 100)
    }

    /// A share of a whole in whole percent, for legends and share columns (ANALYSIS-UX §4.7): "72%", "0%" for a measured
    /// zero, and "<1%" for a non-zero share below 0.5%. The web's `share` reads the same.
    static func share(_ ratio: Double?) -> String {
        guard let ratio, ratio.isFinite else { return missing }
        if ratio > 0, ratio < 0.005 { return "<1%" }
        return "\(Int((ratio * 100).rounded()))%"
    }

    // MARK: Canonical phrases (DESIGN.md §9)

    /// A part of a duration with its denominator (§9 Rates and shares): "8m 15s of 11m 30s (72%)". The share is the
    /// engine's, never divided here; without one the phrase ends at the denominator.
    static func part(_ us: Int64, of whole: Int64, share: Double?) -> String {
        let text = duration(us) + " of " + duration(whole)
        return share.map { text + " (" + self.share($0) + ")" } ?? text
    }

    /// An identifier cut in the middle (§3.5): 6 leading and 4 trailing characters, "cc:222…0001". The full id belongs
    /// in the tooltip and on the pasteboard.
    static func middleEllipsis(_ id: String) -> String {
        id.count <= 11 ? id : "\(id.prefix(6))…\(id.suffix(4))"
    }

    /// Step position: "step 46 · 5 of 6 in turn 6". `afterTurnCrumb` drops "in turn 6" (a turn crumb precedes it);
    /// `leading` capitalizes it for the start of a label. The step number is session-wide (the Steps No. column).
    static func stepPosition(_ n: Int?, inTurn: (k: Int, of: Int)? = nil, turn: Int? = nil, afterTurnCrumb: Bool = false,
                             leading: Bool = false) -> String {
        var parts: [String] = []
        if let n { parts.append("step \(n)") }
        if let p = inTurn {
            let place = "\(p.k) of \(p.of)" + (afterTurnCrumb ? "" : turn.map { " in turn \($0)" } ?? " in its turn")
            parts.append(n == nil ? "step " + place : place)
        }
        var text = parts.isEmpty ? "step" : parts.joined(separator: " · ")
        if leading { text = text.prefix(1).uppercased() + text.dropFirst() }
        return text
    }

    /// `$1.23`; nil is "—".
    static func cost(_ usd: Double?) -> String {
        guard let usd else { return missing }
        return String(format: usd < 1 ? "$%.4f" : "$%.2f", usd)
    }

    // MARK: Calendar arithmetic (fast; no DateFormatter in table cells)

    private static let utc = TimeZone(identifier: "UTC")!
    private static let monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    private static func date(_ us: Int64) -> Date { Date(timeIntervalSince1970: Double(us) / 1e6) }

    private static func offsetText(seconds: Int) -> String {
        let a = abs(seconds)
        return String(format: "%@%02d:%02d", seconds < 0 ? "-" : "+", a / 3600, (a % 3600) / 60)
    }

    struct Parts {
        var year, month, day, hour, minute, second, micros: Int
    }

    static func components(_ us: Int64, zone: TimeZone) -> Parts {
        var secs = us >= 0 ? us / 1_000_000 : (us - 999_999) / 1_000_000
        let micros = Int(us - secs * 1_000_000)
        secs += Int64(zone.secondsFromGMT(for: date(us)))
        var days = secs >= 0 ? secs / 86400 : (secs - 86399) / 86400
        let rem = Int(secs - days * 86400)
        // Civil-from-days (Howard Hinnant), proleptic Gregorian.
        days += 719_468
        let era = (days >= 0 ? days : days - 146_096) / 146_097
        let doe = days - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
        return Parts(year: Int(y), month: Int(m), day: Int(d), hour: rem / 3600, minute: (rem % 3600) / 60, second: rem % 60,
                     micros: micros)
    }
}
