import AppKit

// The optional Context lane of the Timeline (SPEC §12.3.9, §12.7): each step's context tokens against the context
// window, with compactions and the injected attachment types. The window line is dashed where it is inferred (Claude
// logs no window). Context is cost and latency, not a failure cause, and the lane says so.

/// One step's context.
struct ContextPoint: Hashable {
    var ts: Double
    var tokens: Int?
    var window: Int?
    var windowSrc: Prov?
    var compaction: Bool
    var step: Int
    /// The step's first call, which a click selects.
    var eventId: String?
    var attachments: [String: Int]?

    var windowInferred: Bool { windowSrc?.family == .inferred }

    static let caption = "cost and latency, not a failure cause"

    /// Steps by session, in time order; steps without a context size or a compaction are left out.
    static func series(_ steps: [StepItem]) -> [String: [ContextPoint]] {
        var out: [String: [ContextPoint]] = [:]
        for s in steps where s.ctxTokens != nil || s.compactionBefore {
            out[s.sessionId, default: []].append(ContextPoint(ts: Double(s.startTs), tokens: s.ctxTokens, window: s.ctxWindow, windowSrc: s.ctxWindowSrc,
                                                              compaction: s.compactionBefore, step: s.n, eventId: s.calls.first?.eventId,
                                                              attachments: s.attachments))
        }
        for k in out.keys { out[k]!.sort { $0.ts < $1.ts } }
        return out.filter { $0.value.contains { $0.tokens != nil } }
    }

    /// The top of the lane's scale: the largest window or context in the series.
    static func scaleTop(_ points: [ContextPoint]) -> Double {
        Double(points.map { max($0.window ?? 0, $0.tokens ?? 0) }.max() ?? 0)
    }

    /// Index of the last point at or before `t` (else the first).
    static func index(at t: Double, in points: [ContextPoint]) -> Int? {
        guard !points.isEmpty else { return nil }
        var lo = 0, hi = points.count
        while lo < hi {
            let m = (lo + hi) / 2
            if points[m].ts <= t { lo = m + 1 } else { hi = m }
        }
        return max(0, lo - 1)
    }

    /// "182k of 200k (91%)".
    var fillText: String {
        guard let tokens else { return Formatters.missing }
        guard let window, window > 0 else { return Formatters.tokens(tokens) }
        return "\(Formatters.tokens(tokens)) of \(Formatters.tokens(window)) (\(Formatters.percent(Double(tokens) / Double(window))))"
    }
}

@MainActor enum TimelineContextDrawing {
    /// The lane: a stepped area of context tokens, the window as a line (dashed where inferred), and compaction ticks.
    static func draw(_ ctx: CGContext, points: [ContextPoint], lane: (y: CGFloat, h: CGFloat), scale s: TimeScale, tA: Double, tB: Double,
                     x0: CGFloat, width: CGFloat) {
        let rect = CGRect(x: x0, y: lane.y, width: width, height: lane.h)
        ctx.setFillColor(NSColor.quaternaryLabelColor.withAlphaComponent(0.05).cgColor)
        ctx.fill(rect)
        let top = ContextPoint.scaleTop(points)
        guard top > 0, let first = ContextPoint.index(at: tA, in: points) else { return }
        let inset: CGFloat = 2
        let bottom = rect.maxY - 1, usable = rect.height - inset - 1
        func y(_ v: Int) -> CGFloat { bottom - CGFloat(Double(v) / top) * usable }
        func x(_ t: Double) -> CGFloat { min(x0 + width + 2, max(x0 - 2, x0 + CGFloat(s.x(t)))) }
        let color = Theme.color(.context)

        // Context area and its top edge, as steps from one point to the next.
        let area = CGMutablePath(), edge = CGMutablePath()
        var windows: [(xa: CGFloat, xb: CGFloat, y: CGFloat, inferred: Bool)] = []
        var compactions: [CGFloat] = []
        var i = first
        while i < points.count {
            let p = points[i]
            if p.ts > tB { break }
            let xa = x(p.ts)
            let xb = i + 1 < points.count ? x(min(points[i + 1].ts, tB)) : x(p.ts) + 2
            if let v = p.tokens {
                let yy = y(v)
                area.addRect(CGRect(x: xa, y: yy, width: max(0.5, xb - xa), height: bottom - yy))
                edge.move(to: CGPoint(x: xa, y: yy))
                edge.addLine(to: CGPoint(x: max(xa + 0.5, xb), y: yy))
            }
            if let w = p.window { windows.append((xa, xb, y(w), p.windowInferred)) }
            if p.compaction { compactions.append(xa) }
            i += 1
        }
        ctx.setFillColor(color.withAlphaComponent(0.38).cgColor)
        ctx.addPath(area)
        ctx.fillPath()
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(1.5)
        ctx.addPath(edge)
        ctx.strokePath()

        // The window: solid where logged, dashed where inferred.
        for inferred in [false, true] {
            let path = CGMutablePath()
            for w in windows where w.inferred == inferred {
                path.move(to: CGPoint(x: w.xa, y: w.y + 0.5))
                path.addLine(to: CGPoint(x: max(w.xa + 0.5, w.xb), y: w.y + 0.5))
            }
            ctx.setStrokeColor(NSColor.secondaryLabelColor.cgColor)
            ctx.setLineWidth(1)
            ctx.setLineDash(phase: 0, lengths: inferred ? [3, 2] : [])
            ctx.addPath(path)
            ctx.strokePath()
        }
        ctx.setLineDash(phase: 0, lengths: [])

        // Compactions: a tick with a small cap.
        let tick = Theme.color(.compaction)
        ctx.setFillColor(tick.cgColor)
        for cx in compactions {
            ctx.fill(CGRect(x: cx - 0.5, y: rect.minY, width: 1.5, height: rect.height))
            ctx.fill(CGRect(x: cx - 2.5, y: rect.minY, width: 5.5, height: 2))
        }
    }

    /// The header caption beside the lane.
    static func header(_ lane: (y: CGFloat, h: CGFloat), x: CGFloat, width: CGFloat) {
        TimelineDrawing.text("Context", in: CGRect(x: x, y: lane.y + 1, width: width, height: 13),
                             font: .systemFont(ofSize: 10, weight: .medium), color: .secondaryLabelColor)
        TimelineDrawing.text(ContextPoint.caption, in: CGRect(x: x, y: lane.y + 14, width: width, height: 12),
                             font: .systemFont(ofSize: 9), color: .tertiaryLabelColor)
    }

    /// The hover card for the point under the pointer.
    static func tip(_ points: [ContextPoint], at t: Double) -> NSAttributedString? {
        guard let i = ContextPoint.index(at: t, in: points) else { return nil }
        let p = points[i]
        var rows: [(String, String)] = [("Step", Formatters.count(p.step)), ("Time", Formatters.timestamp(Int64(p.ts)))]
        if p.window != nil {
            rows.append(("Window", Formatters.tokens(p.window) + (p.windowInferred ? " · inferred (Claude logs no window; data limit 7)" : " · logged")))
        }
        if p.compaction { rows.append(("Compaction", "the context was compacted before this step")) }
        if let a = p.attachments, !a.isEmpty {
            rows.append(("Attachments", a.sorted { $0.value > $1.value }.prefix(4).map { "\($0.key) \(Formatters.count($0.value))" }.joined(separator: ", ")))
        }
        rows.append(("", "Context is " + ContextPoint.caption + "."))
        return TimelineHUD.content(title: "Context " + p.fillText, rows: rows)
    }

    /// "Context lane: peak 182k of 200k tokens, window inferred, 2 compactions" for VoiceOver.
    static func accessibilityLabel(_ points: [ContextPoint]) -> String {
        let peak = points.compactMap(\.tokens).max()
        var parts = ["Context lane: " + (peak.map { "peak \(Formatters.tokens($0)) tokens" } ?? "no sizes")]
        if let w = points.compactMap(\.window).max() { parts.append("window \(Formatters.tokens(w))" + (points.contains { $0.windowInferred } ? ", inferred" : "")) }
        let n = points.filter(\.compaction).count
        if n > 0 { parts.append(Formatters.count(n, "compaction")) }
        parts.append(ContextPoint.caption)
        return parts.joined(separator: ", ")
    }
}
