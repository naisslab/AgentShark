import AppKit

/// Shared behavior of the timeline's parts: flipped, layer-backed, hover tracking, and pan/zoom gestures that go to
/// the owning `TimelineView` (vertical scrolling falls through to the scroll view).
class TimelinePartView: NSView {
    unowned let owner: TimelineView
    private var tracking: NSTrackingArea?

    init(owner: TimelineView) {
        self.owner = owner
        super.init(frame: .zero)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    var controller: TimelineController { owner.controller }

    func point(_ e: NSEvent) -> NSPoint { convert(e.locationInWindow, from: nil) }
    /// The event's x in plot coordinates (0 at the left edge of the time axis).
    func plotX(_ e: NSEvent) -> CGFloat { point(e).x - TimelineView.headerWidth }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(t)
        tracking = t
    }

    override func mouseExited(with event: NSEvent) { owner.hud.hide() }

    override func scrollWheel(with e: NSEvent) {
        if !owner.handleScroll(e, plotX: plotX(e)) { super.scrollWheel(with: e) }
    }

    override func magnify(with e: NSEvent) { owner.handleMagnify(e, plotX: plotX(e)) }
}

// MARK: - Ruler

/// The time ruler: local-time ticks with the date and UTC offset at the left; drag sets the inspection range.
final class TimelineRulerView: TimelinePartView {
    private var dragStart: Double?

    override init(owner: TimelineView) {
        super.init(owner: owner)
        setAccessibilityElement(true)
        setAccessibilityRole(.ruler)
        setAccessibilityLabel("Time ruler")
        setAccessibilityHelp("Drag to set the inspection range. Click to clear it.")
    }

    override func accessibilityValue() -> Any? {
        var parts = [owner.axis.context]
        if let r = controller.model.inspectionRange {
            parts.append("Inspection range \(Formatters.timeRange(from: r.lowerBound, to: r.upperBound))")
        }
        return parts.joined(separator: ", ")
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let H = TimelineView.headerWidth, pw = owner.plotWidth
        let bs = window?.backingScaleFactor ?? 2
        let s = controller.scale
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        let axis = owner.axis
        TimelineDrawing.text(controller.extent == nil ? "" : axis.context, in: CGRect(x: 10, y: 0, width: H - 18, height: bounds.height),
                             font: TimelineDrawing.captionFont, color: .secondaryLabelColor)
        ctx.saveGState()
        ctx.clip(to: CGRect(x: H, y: 0, width: pw, height: bounds.height))
        TimelineDrawing.breaks(ctx, scale: s, from: s.t(0), to: s.t(Double(pw)), x0: H, y0: 0, y1: bounds.height)
        TimelineDrawing.dimOutside(ctx, scale: s, from: controller.model.scope.from, to: controller.model.scope.to, x0: H, y0: 0,
                                   width: pw, height: bounds.height)
        TimelineDrawing.ruler(ctx, axis: axis, scale: s, x0: H, y: 0, width: pw, height: bounds.height, backingScale: bs)
        if let (a, b) = rangeX() {
            TimelineDrawing.range(ctx, xa: a, xb: b, y0: 0, height: bounds.height)
            let r = controller.brush.map { ($0.from, $0.to) } ?? controller.model.inspectionRange.map { (Double($0.lowerBound), Double($0.upperBound)) }
            if let r {
                let label = Formatters.duration(Int64(abs(r.1 - r.0)))
                let lw = TimelineDrawing.width(label, font: TimelineDrawing.tickFont) + 8
                let mid = (a + b) / 2
                if abs(b - a) > lw + 4 {
                    NSColor.controlAccentColor.setFill()
                    NSBezierPath(roundedRect: CGRect(x: mid - lw / 2, y: 3, width: lw, height: 13), xRadius: 3, yRadius: 3).fill()
                    TimelineDrawing.text(label, in: CGRect(x: mid - lw / 2, y: 3, width: lw, height: 13), font: TimelineDrawing.tickFont,
                                         color: .white, alignment: .center)
                }
            }
        }
        if let m = controller.marker {
            TimelineDrawing.marker(ctx, x: H + CGFloat(s.x(m)), y0: bounds.height - 7, height: 7, cap: true)
        }
        ctx.restoreGState()
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
        NSRect(x: H - 1, y: 0, width: 1, height: bounds.height).fill()
    }

    /// x of the inspection range (or the range being dragged).
    private func rangeX() -> (CGFloat, CGFloat)? {
        let s = controller.scale, H = TimelineView.headerWidth
        if let b = controller.brush { return (H + CGFloat(s.x(b.from)), H + CGFloat(s.x(b.to))) }
        if let r = controller.model.inspectionRange {
            return (H + CGFloat(s.x(Double(r.lowerBound))), H + CGFloat(s.x(Double(r.upperBound))))
        }
        return nil
    }

    private func time(at e: NSEvent) -> Double {
        controller.scale.t(Double(min(max(0, plotX(e)), owner.plotWidth)))
    }

    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(owner.canvas)
        guard plotX(e) >= 0 else { return }
        dragStart = time(at: e)
    }

    override func mouseDragged(with e: NSEvent) {
        guard let start = dragStart else { return }
        controller.brush = (start, time(at: e))
        owner.redrawAll()
    }

    override func mouseUp(with e: NSEvent) {
        defer {
            dragStart = nil
            owner.redrawAll()
        }
        guard dragStart != nil else { return }
        if let b = controller.brush, abs(controller.scale.x(b.to) - controller.scale.x(b.from)) > 3 {
            controller.setInspectionRange(b.from, b.to)
        } else {
            controller.clearInspectionRange()
        }
        controller.brush = nil
    }

    override func mouseMoved(with e: NSEvent) {
        let p = point(e)
        let px = Double(plotX(e))
        let s = controller.scale
        if px >= 0, let b = s.breaks(from: s.t(px - s.breakWidth - 1), to: s.t(px + 1)).first(where: { px >= $0.x && px < $0.x + s.breakWidth }),
           let content = owner.hudContent(for: .gap(b.gap)) {
            owner.hud.show(content, near: convert(p, to: owner), in: owner.bounds)
        } else {
            owner.hud.hide()
        }
    }

}

// MARK: - Density track

/// "Current View": the display filter's effect on the timeline, as event density of the window's view (SPEC §7.8),
/// with errors in red. Shows the view's state (loading, failed with Retry, empty) instead of other data.
final class TimelineDensityView: TimelinePartView {
    private let retry = NSButton(title: "Retry", target: nil, action: nil)

    override init(owner: TimelineView) {
        super.init(owner: owner)
        retry.bezelStyle = .push
        retry.controlSize = .small
        retry.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        retry.target = self
        retry.action = #selector(retryView)
        retry.toolTip = "Build the view again with the same filter and scope"
        retry.isHidden = true
        addSubview(retry)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Current view density")
    }

    @objc private func retryView() { controller.model.rebuildView() }

    /// The header's second line and whether the view failed.
    private var state: (text: String, failed: Bool) {
        let m = controller.model
        switch m.viewPhase {
        case .waitingForEngine: return ("Waiting for the engine…", false)
        case .loading: return ("Loading the view…", false)
        case .failed: return ("Could not load this view", true)
        case .empty: return ("No events match", false)
        case .ready:
            let n = Formatters.count(m.view?.count ?? 0, "event")
            return (m.appliedFilter.isEmpty ? n : "\(n) · filtered", false)
        }
    }

    override func accessibilityValue() -> Any? { state.text }

    override func layout() {
        super.layout()
        retry.sizeToFit()
        retry.frame.origin = NSPoint(x: TimelineView.headerWidth - retry.frame.width - 8, y: (bounds.height - retry.frame.height) / 2)
    }

    override func viewWillDraw() {
        super.viewWillDraw()
        retry.isHidden = !state.failed
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let H = TimelineView.headerWidth, pw = owner.plotWidth
        let s = controller.scale
        let st = state
        NSColor.controlBackgroundColor.setFill()
        bounds.fill()
        TimelineDrawing.text("Current View", in: CGRect(x: 10, y: 5, width: H - 20, height: 15),
                             font: .systemFont(ofSize: 11, weight: .semibold), color: .labelColor)
        TimelineDrawing.text(st.text, in: CGRect(x: 10, y: 20, width: H - 20 - (st.failed ? retry.frame.width + 6 : 0), height: 14),
                             font: .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular), color: st.failed ? Theme.err : .secondaryLabelColor)
        ctx.saveGState()
        ctx.clip(to: CGRect(x: H, y: 0, width: pw, height: bounds.height))
        if controller.model.viewPhase == .ready, controller.densityViewID == controller.model.view?.viewId {
            TimelineDrawing.density(ctx, scale: s, parts: controller.density, x0: H, top: 4, height: bounds.height - 8,
                                    fill: NSColor.controlAccentColor.withAlphaComponent(0.55), clipWidth: pw)
        }
        TimelineDrawing.breaks(ctx, scale: s, from: s.t(0), to: s.t(Double(pw)), x0: H, y0: 0, y1: bounds.height)
        TimelineDrawing.dimOutside(ctx, scale: s, from: controller.model.scope.from, to: controller.model.scope.to, x0: H, y0: 0,
                                   width: pw, height: bounds.height)
        if let m = controller.marker { TimelineDrawing.marker(ctx, x: H + CGFloat(s.x(m)), y0: 0, height: bounds.height, cap: false) }
        ctx.restoreGState()
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
        NSRect(x: H - 1, y: 0, width: 1, height: bounds.height).fill()
    }

    override func mouseMoved(with e: NSEvent) {
        let p = point(e)
        let t = controller.scale.t(Double(plotX(e)))
        guard plotX(e) >= 0,
              let part = controller.density.first(where: { Double($0.from) <= t && t < Double($0.from) + Double($0.binUs) * Double($0.bins.count) })
        else { return owner.hud.hide() }
        let i = Int((t - Double(part.from)) / Double(part.binUs))
        guard part.bins.indices.contains(i) else { return owner.hud.hide() }
        let b = part.bins[i]
        let from = part.from + Int64(i) * part.binUs
        let content = TimelineHUD.content(title: Formatters.count(b.count, "event") + (b.errors > 0 ? " · \(Formatters.count(b.errors, "error"))" : ""),
                                          rows: [("From", Formatters.timestamp(from)), ("To", Formatters.timestamp(from + part.binUs))])
        owner.hud.show(content, near: convert(p, to: owner), in: owner.bounds)
    }
}

// MARK: - Track canvas

/// The scrolling document: track headers on the left, span or session bars on the right.
final class TimelineCanvasView: TimelinePartView {
    private enum Drag {
        case none
        case pending(start: NSPoint, hit: TimelineHit?)
        case range(start: Double)
        case pan(lastX: CGFloat)
    }
    private var drag = Drag.none
    private var axChildren: [TimelineAXElement]?

    override init(owner: TimelineView) {
        super.init(owner: owner)
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        focusRingType = .exterior
    }

    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { true }

    func updateSize() {
        let size = NSSize(width: owner.scrollView.contentSize.width, height: max(controller.layout.height, owner.scrollView.contentSize.height))
        if frame.size != size { setFrameSize(size) }
    }

    // MARK: Focus ring

    override var focusRingMaskBounds: NSRect { visibleRect }
    override func drawFocusRingMask() { NSBezierPath(rect: visibleRect.insetBy(dx: 2, dy: 2)).fill() }
    override func becomeFirstResponder() -> Bool {
        noteFocusRingMaskChanged()
        return true
    }

    // MARK: Drawing

    override func draw(_ dirty: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let c = controller
        let layout = c.layout
        let s = c.scale
        let H = TimelineView.headerWidth, pw = owner.plotWidth, w = H + pw
        let bs = window?.backingScaleFactor ?? 2, px = 1 / bs
        let tA = s.t(0), tB = s.t(Double(pw))
        let range = layout.visibleTracks(top: dirty.minY, height: dirty.height)
        let alt = NSColor.alternatingContentBackgroundColors

        NSColor.controlBackgroundColor.setFill()
        dirty.fill()
        if alt.count > 1 {
            alt[1].setFill()
            for i in range where i % 2 == 1 { NSRect(x: 0, y: layout.tracks[i].y, width: w, height: layout.tracks[i].h).fill() }
        }
        // Header of the track holding the selection.
        if let sel = c.highlightedPath, range.contains(sel.track) {
            NSColor.controlAccentColor.withAlphaComponent(0.10).setFill()
            let t = layout.tracks[sel.track]
            NSRect(x: 0, y: t.y, width: H, height: t.h).fill()
        }

        // Plot
        ctx.saveGState()
        ctx.clip(to: CGRect(x: H, y: dirty.minY, width: pw, height: dirty.height))
        NSColor.separatorColor.withAlphaComponent(0.35).setFill()
        for tk in owner.axis.ticks { NSRect(x: TimelineDrawing.snap(H + CGFloat(tk.x), bs), y: dirty.minY, width: px, height: dirty.height).fill() }
        for i in range { drawTrackPlot(ctx, layout.tracks[i], scale: s, tA: tA, tB: tB, x0: H, width: pw, backingScale: bs) }
        joins = []
        for i in range { drawBands(ctx, layout.tracks[i], scale: s, tA: tA, tB: tB, x0: H, width: pw) }
        for i in range {
            let t = layout.tracks[i]
            if let lane = t.contextLane, let id = t.session?.id, let points = c.context[id] {
                TimelineContextDrawing.draw(ctx, points: points, lane: lane, scale: s, tA: tA, tB: tB, x0: H, width: pw)
            }
        }
        var rows: [TimelineRow] = []
        for i in range { rows += layout.tracks[i].rows.filter { $0.y + $0.h >= dirty.minY && $0.y <= dirty.maxY } }
        drawItems(ctx, rows: rows, scale: s, tA: tA, tB: tB, x0: H, xMax: w, backingScale: bs)
        for i in range { drawOverlays(ctx, layout.tracks[i], scale: s, tA: tA, tB: tB, x0: H, xMax: w) }
        TimelineDrawing.breaks(ctx, scale: s, from: tA, to: tB, x0: H, y0: dirty.minY, y1: dirty.maxY)
        TimelineDrawing.gapJoins(ctx, joins, scale: s, from: tA, to: tB, x0: H)
        TimelineDrawing.dimOutside(ctx, scale: s, from: c.model.scope.from, to: c.model.scope.to, x0: H, y0: dirty.minY, width: pw, height: dirty.height)
        if let b = c.brush {
            TimelineDrawing.range(ctx, xa: H + CGFloat(s.x(b.from)), xb: H + CGFloat(s.x(b.to)), y0: dirty.minY, height: dirty.height)
        } else if let r = c.model.inspectionRange {
            TimelineDrawing.range(ctx, xa: H + CGFloat(s.x(Double(r.lowerBound))), xb: H + CGFloat(s.x(Double(r.upperBound))), y0: dirty.minY,
                                  height: dirty.height)
        }
        if case .item(let p)? = c.hover, p != c.highlightedPath { outline(ctx, layout[p], scale: s, color: NSColor.labelColor.withAlphaComponent(0.6), width: 1) }
        if let p = c.highlightedPath {
            // A background-colored gap inside the accent ring keeps the selection visible on bars of the accent's hue.
            outline(ctx, layout[p], scale: s, color: .controlBackgroundColor, width: 1.5)
            outline(ctx, layout[p], scale: s, color: .controlAccentColor, width: 2, inset: -2.5)
        }
        if let m = c.marker { TimelineDrawing.marker(ctx, x: H + CGFloat(s.x(m)), y0: dirty.minY, height: dirty.height, cap: false) }
        ctx.restoreGState()

        // Separators and headers
        NSColor.separatorColor.setFill()
        for i in range {
            let t = layout.tracks[i]
            NSRect(x: 0, y: t.y + t.h - px, width: w, height: px).fill()
            drawHeader(t, hovered: c.hover == .header(track: i, disclosure: true) || c.hover == .header(track: i, disclosure: false))
        }
        NSColor.separatorColor.setFill()
        NSRect(x: H - 1, y: dirty.minY, width: 1, height: dirty.height).fill()
    }

    private func outline(_ ctx: CGContext, _ it: TimelineItem, scale s: TimeScale, color: NSColor, width: CGFloat, inset: CGFloat = 0) {
        let H = TimelineView.headerWidth
        let xa = H + CGFloat(s.x(it.start)), xb = H + CGFloat(s.x(it.end))
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(width)
        let r = CGRect(x: xa, y: it.y, width: max(1, xb - xa), height: it.h).insetBy(dx: inset - width / 2, dy: inset - width / 2)
        ctx.stroke(r)
    }

    /// Session band and activity sparkline (session tracks).
    private func drawTrackPlot(_ ctx: CGContext, _ track: TimelineTrack, scale s: TimeScale, tA: Double, tB: Double, x0: CGFloat, width: CGFloat,
                               backingScale bs: CGFloat) {
        guard let spark = track.sparkRect, let session = track.session else { return }
        let color = Theme.agentColor(session.agent)
        if let band = track.band {
            let xa = max(x0 - 2, x0 + CGFloat(s.x(band.start))), xb = min(x0 + width + 2, x0 + CGFloat(s.x(band.end)))
            if xb > xa {
                ctx.setFillColor(color.withAlphaComponent(0.12).cgColor)
                ctx.fill(CGRect(x: xa, y: spark.y, width: max(1, xb - xa), height: spark.h))
            }
        }
        let a = track.activity
        guard !a.isEmpty else { return }
        let bucket: CGFloat = 2
        var counts = [Int](repeating: 0, count: Int(width / bucket) + 1)
        var lo = 0, hi = a.count
        while lo < hi {
            let m = (lo + hi) / 2
            if a[m] < tA { lo = m + 1 } else { hi = m }
        }
        var maxCount = 0
        var i = lo
        while i < a.count, a[i] <= tB {
            let b = Int(CGFloat(s.x(a[i])) / bucket)
            if counts.indices.contains(b) {
                counts[b] += 1
                maxCount = max(maxCount, counts[b])
            }
            i += 1
        }
        guard maxCount > 0 else { return }
        var rects: [CGRect] = []
        for (b, n) in counts.enumerated() where n > 0 {
            let h = max(1, (CGFloat(n) / CGFloat(maxCount)).squareRoot() * spark.h)
            rects.append(CGRect(x: x0 + CGFloat(b) * bucket, y: spark.y + spark.h - h, width: bucket - 0.5, height: h))
        }
        ctx.setFillColor(color.withAlphaComponent(0.7).cgColor)
        ctx.fill(rects)
    }

    /// Failure bands in the session's Failures lane (§7.12): unrecovered episodes red and hatched, recoveries that took
    /// ≥ 3 attempts amber. Each band runs from the first attempt to the episode's last attempt and ends in its outcome's
    /// mark; loops get a bracket.
    private func drawBands(_ ctx: CGContext, _ track: TimelineTrack, scale s: TimeScale, tA: Double, tB: Double, x0: CGFloat, width: CGFloat) {
        guard let lane = track.bandLane, let session = track.session, let list = controller.bands[session.id] else { return }
        for e in list where Double(e.endTs) >= tA && Double(e.startTs) <= tB {
            let red = TimelineController.isUnrecoveredBand(e)
            let color = red ? Theme.err : Theme.warn
            let xa = max(x0 - 2, x0 + CGFloat(s.x(Double(e.startTs))))
            var xb = min(x0 + width + 2, x0 + CGFloat(s.x(Double(e.endTs))))
            xb = max(xb, xa + 3)
            let r = CGRect(x: xa, y: lane.y + (lane.h - Self.bandHeight) / 2, width: xb - xa, height: Self.bandHeight)
            joins.append((r, color))
            ctx.setFillColor(color.withAlphaComponent(red ? 0.3 : 0.55).cgColor)
            ctx.fill(r)
            if red {
                ctx.saveGState()
                ctx.clip(to: r)
                ctx.setStrokeColor(color.withAlphaComponent(0.8).cgColor)
                ctx.setLineWidth(1)
                var x = r.minX - r.height
                while x < r.maxX {
                    ctx.move(to: CGPoint(x: x, y: r.maxY))
                    ctx.addLine(to: CGPoint(x: x + r.height, y: r.minY))
                    x += 3
                }
                ctx.strokePath()
                ctx.restoreGState()
            }
            if let mark = TimelineController.endMark(e.outcome), r.maxX < x0 + width {
                let image = TimelineDrawing.symbol(mark.symbol, size: 9, color: color, colorKey: red ? "err" : "warn", weight: .bold)
                TimelineDrawing.draw(image, centeredIn: CGRect(x: r.maxX + 1, y: lane.y, width: 11, height: lane.h))
            }
            if e.loop {
                ctx.setStrokeColor(color.cgColor)
                ctx.setLineWidth(1.5)
                ctx.move(to: CGPoint(x: r.minX, y: r.minY + 1))
                ctx.addLine(to: CGPoint(x: r.minX, y: r.minY - 3))
                ctx.addLine(to: CGPoint(x: r.maxX, y: r.minY - 3))
                ctx.addLine(to: CGPoint(x: r.maxX, y: r.minY + 1))
                ctx.strokePath()
            }
        }
    }

    /// Bars and bands drawn this pass, joined across the collapsed gaps they cross (§7.12, M-15).
    private var joins: [(rect: CGRect, color: NSColor)] = []

    static let bandHeight: CGFloat = 8
    /// The stub of a bar with no end logged (§7.12 Bar ends).
    static let stubWidth: CGFloat = 24

    /// Analysis overlays on the bars: each turn's time-bucket strip (session tracks) and a tick at each unrecovered
    /// episode on a session bar (overview).
    private func drawOverlays(_ ctx: CGContext, _ track: TimelineTrack, scale s: TimeScale, tA: Double, tB: Double, x0: CGFloat, xMax: CGFloat) {
        let c = controller
        let rows = track.session != nil ? Array(track.rows.prefix(1)) : track.rows
        for row in rows {
            var i = row.firstIndex(endingAtOrAfter: tA)
            while i < row.items.count {
                let it = row.items[i]
                i += 1
                if it.start > tB { break }
                if it.end < tA { continue }
                let xa = max(x0, x0 + CGFloat(s.x(it.start))), xb = min(xMax, x0 + CGFloat(s.x(it.end)))
                let bar = CGRect(x: xa, y: it.y, width: xb - xa, height: it.h)
                if it.span?.kind == .turn, bar.width >= TimelineLaneDrawing.minStripWidth, let t = c.turnTimes[it.id] {
                    TimelineLaneDrawing.turnStrip(ctx, t, in: bar)
                } else if let sess = it.session, let list = c.ticks[sess.id] {
                    for e in list where Double(e.startTs) >= it.start - 1 && Double(e.startTs) <= it.end + 1 {
                        TimelineLaneDrawing.tick(ctx, x: x0 + CGFloat(s.x(Double(e.startTs))), bar: bar)
                    }
                }
            }
        }
    }

    /// The bars of `rows` that intersect [tA, tB]. Bars narrower than a point merge per point column, and fills are
    /// batched per color so tens of thousands of bars stay cheap.
    private func drawItems(_ ctx: CGContext, rows: [TimelineRow], scale s: TimeScale, tA: Double, tB: Double, x0: CGFloat, xMax: CGFloat,
                           backingScale bs: CGFloat) {
        var fills: [TimelinePaint: [CGRect]] = [:]
        var backgrounds: [TimelinePaint: [CGRect]] = [:]
        var openEnded: [TimelinePaint: [CGRect]] = [:]
        var caps: [CGRect] = []
        var errors: [CGRect] = []
        // A label stays inside its bar and stops before the next bar of its row; a bar that overlaps the one before it
        // (a lane past its last row) draws no label, so no two labels share a rect (§3.5, DS1-07).
        var labels: [(item: TimelineItem, rect: CGRect, maxX: CGFloat)] = []
        let px = 1 / bs
        for row in rows {
            var lastColumn = -CGFloat.infinity
            var rowEnd = -CGFloat.infinity
            var rowLabel: Int?
            var i = row.firstIndex(endingAtOrAfter: tA)
            while i < row.items.count {
                let it = row.items[i]
                i += 1
                if it.start > tB { break }
                if it.end < tA { continue }
                var xa = x0 + CGFloat(s.x(it.start)), xb = x0 + CGFloat(s.x(it.end))
                if xb - xa < 1 {
                    let col = xa.rounded(.down)
                    if col == lastColumn { continue }
                    lastColumn = col
                    xa = col
                    xb = col + 1
                }
                // No end logged: a stub with a dashed end, unless it is running (then it reaches the session's end, capped).
                if it.openEnded, !it.running { xb = min(xb, xa + Self.stubWidth) }
                xa = TimelineDrawing.snap(max(xa, x0 - 2), bs)
                xb = max(TimelineDrawing.snap(min(xb, xMax + 2), bs), xa + px)
                let r = CGRect(x: xa, y: it.y, width: xb - xa, height: it.h)
                if it.running { caps.append(r) }
                if it.isBackground {
                    backgrounds[it.paint, default: []].append(r)
                } else if it.openEnded && !it.running {
                    openEnded[it.paint, default: []].append(r)
                } else {
                    fills[it.paint, default: []].append(r)
                }
                if it.isError { errors.append(r) }
                if !it.isBackground, r.width > 2 { joins.append((r, it.paint.color)) }
                if let j = rowLabel { labels[j].maxX = min(labels[j].maxX, r.minX - 2) }
                rowLabel = nil
                if r.width > 40, it.h >= 10, r.minX >= rowEnd - 0.5 {
                    labels.append((it, r, r.maxX))
                    rowLabel = labels.count - 1
                }
                rowEnd = max(rowEnd, r.maxX)
            }
        }
        for (paint, rects) in backgrounds {
            ctx.setFillColor(paint.color.withAlphaComponent(0.22).cgColor)
            ctx.fill(rects)
            ctx.setFillColor(paint.color.withAlphaComponent(0.7).cgColor)
            ctx.fill(rects.map { CGRect(x: $0.minX, y: $0.minY, width: min(2, $0.width), height: $0.height) })
        }
        for (paint, rects) in fills {
            ctx.setFillColor(paint.color.withAlphaComponent(0.88).cgColor)
            ctx.fill(rects)
        }
        // No end logged: a light stub whose end is dashed, so it is never read as a measured bar.
        for (paint, rects) in openEnded {
            ctx.setFillColor(paint.color.withAlphaComponent(0.3).cgColor)
            ctx.fill(rects)
            ctx.saveGState()
            ctx.setStrokeColor(paint.color.cgColor)
            ctx.setLineWidth(1)
            ctx.setLineDash(phase: 0, lengths: [2, 2])
            for r in rects {
                ctx.move(to: CGPoint(x: r.maxX - 0.5, y: r.minY))
                ctx.addLine(to: CGPoint(x: r.maxX - 0.5, y: r.maxY))
            }
            ctx.strokePath()
            ctx.restoreGState()
        }
        // Running: a cap at the session's end.
        for r in caps where r.maxX <= xMax {
            let image = TimelineDrawing.symbol("arrowtriangle.right.fill", size: 8, color: .secondaryLabelColor, colorKey: "secondary")
            TimelineDrawing.draw(image, centeredIn: CGRect(x: r.maxX + 1, y: r.minY, width: 9, height: r.height))
        }
        if !errors.isEmpty {
            ctx.setStrokeColor(Theme.err.cgColor)
            ctx.setLineWidth(1.5)
            for r in errors { ctx.stroke(r.insetBy(dx: 0.75, dy: 0.75)) }
        }
        var inks: [TimelinePaint: NSColor] = [:]
        for (it, r, maxX) in labels {
            let lx = max(r.minX, x0) + 4
            let avail = maxX - lx - 3
            guard avail >= 24 else { continue }
            let color: NSColor
            if it.isBackground {
                color = .labelColor
            } else if let cached = inks[it.paint] {
                color = cached
            } else {
                color = TimelineDrawing.ink(on: it.paint.color, alpha: 0.88)
                inks[it.paint] = color
            }
            // A turn bar carries its time strip along the bottom: the label centers in the part above it (M-26).
            let h = r.height - (it.isBackground ? TimelineLaneDrawing.stripHeight : 0)
            TimelineDrawing.text(it.label, in: CGRect(x: lx, y: r.minY, width: avail, height: h), font: TimelineDrawing.barFont, color: color)
        }
    }

    private func drawHeader(_ t: TimelineTrack, hovered: Bool) {
        let H = TimelineView.headerWidth
        let x = 8 + CGFloat(min(t.depth, TimelineMetrics.maxIndentLevels)) * TimelineMetrics.indent
        let line1 = t.collapsed ? CGRect(x: 0, y: t.y, width: 0, height: t.h) : CGRect(x: 0, y: t.y + 5, width: 0, height: 16)
        let chevron = TimelineDrawing.symbol(t.collapsed ? "chevron.right" : "chevron.down", size: 9, color: hovered ? .labelColor : .secondaryLabelColor,
                                             colorKey: hovered ? "label" : "secondary", weight: .semibold)
        TimelineDrawing.draw(chevron, centeredIn: CGRect(x: x, y: line1.minY, width: 12, height: line1.height))
        switch t.kind {
        case .session(let s, _):
            // The agent dot (§5.2 item 4); the agent's name is in the hover text.
            Theme.agentColor(s.agent).setFill()
            NSBezierPath(ovalIn: CGRect(x: x + 18, y: line1.midY - 4, width: 8, height: 8)).fill()
            let titleX = x + 32
            let dur = t.band.map { Formatters.duration(Int64($0.end - $0.start), src: $0.durSrc ?? "derived") } ?? Formatters.missing
            if t.collapsed {
                let dw = TimelineDrawing.width(dur, font: TimelineDrawing.tickFont) + 4
                TimelineDrawing.text(s.displayTitle, in: CGRect(x: titleX, y: line1.minY, width: H - titleX - dw - 12, height: line1.height),
                                     font: .systemFont(ofSize: 12, weight: .medium), color: .labelColor)
                TimelineDrawing.text(dur, in: CGRect(x: H - dw - 8, y: line1.minY, width: dw, height: line1.height),
                                     font: TimelineDrawing.tickFont, color: .secondaryLabelColor, alignment: .right)
                return
            }
            TimelineDrawing.text(s.displayTitle, in: CGRect(x: titleX, y: line1.minY, width: H - titleX - 8, height: line1.height),
                                 font: Theme.font(.groupHeader), color: .labelColor)
            var lx = titleX
            let y2 = t.y + 22
            if let role = TimelineText.roleBadge(s.role) {
                // A role is a Plain muted word (§6.2).
                let rw = TimelineDrawing.width(role, font: Theme.font(.metadata)) + 6
                TimelineDrawing.text(role, in: CGRect(x: lx, y: y2, width: rw, height: 15), font: Theme.font(.metadata), color: .secondaryLabelColor)
                lx += rw
            }
            let sub = "\(dur) · \(Formatters.count(s.nEvents, "event"))" + (s.nErrors > 0 ? " · \(Formatters.count(s.nErrors, "error"))" : "")
            TimelineDrawing.text(sub, in: CGRect(x: lx, y: y2, width: H - lx - 8, height: 15), font: Theme.font(.metadata), color: .secondaryLabelColor)
            if let lane = t.contextLane { TimelineContextDrawing.header(lane, x: titleX, width: H - titleX - 8) }
            TimelineLaneDrawing.header(t.laneLabels, x: x + 18, width: H - x - 26)
        case .project(let name, let n, let subs):
            let icon = TimelineDrawing.symbol("folder", size: 11, color: .secondaryLabelColor, colorKey: "secondary")
            TimelineDrawing.draw(icon, centeredIn: CGRect(x: x + 14, y: t.y + 5, width: 16, height: 16))
            TimelineDrawing.text(name, in: CGRect(x: x + 34, y: t.y + 5, width: H - x - 42, height: 16),
                                 font: .systemFont(ofSize: 12, weight: .semibold), color: .labelColor)
            let sub = Formatters.count(n, "session") + (subs > 0 ? " · \(Formatters.count(subs, "subagent"))" : "")
            TimelineDrawing.text(sub, in: CGRect(x: x + 34, y: t.y + 22, width: H - x - 42, height: 15),
                                 font: .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular), color: .secondaryLabelColor)
        }
    }

    // MARK: Mouse

    override func mouseMoved(with e: NSEvent) {
        let p = point(e)
        let hit = owner.hit(at: p)
        if hit != controller.hover {
            controller.hover = hit
            setNeedsDisplay(visibleRect)
        }
        if let hit, let content = owner.hudContent(for: hit) {
            owner.hud.show(content, near: convert(p, to: owner), in: owner.bounds)
        } else {
            owner.hud.hide()
        }
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        clearHover()
    }

    private func clearHover() {
        guard controller.hover != nil else { return }
        controller.hover = nil
        setNeedsDisplay(visibleRect)
    }

    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        owner.hud.hide()
        let p = point(e)
        let hit = owner.hit(at: p)
        if e.clickCount == 2 {
            drag = .none
            doubleClick(hit, at: p)
            return
        }
        if e.modifierFlags.contains(.option), p.x >= TimelineView.headerWidth {
            drag = .pan(lastX: p.x)
            NSCursor.closedHand.push()
            return
        }
        if case .header(let ti, let disclosure)? = hit {
            drag = .none
            if disclosure { controller.toggleCollapsed(track: ti) }
            return
        }
        drag = .pending(start: p, hit: hit)
    }

    override func mouseDragged(with e: NSEvent) {
        let p = point(e)
        let x = Double(min(max(0, p.x - TimelineView.headerWidth), owner.plotWidth))
        switch drag {
        case .pending(let start, _):
            guard abs(p.x - start.x) > 3, start.x >= TimelineView.headerWidth else { return }
            let t0 = controller.scale.t(Double(start.x - TimelineView.headerWidth))
            drag = .range(start: t0)
            controller.brush = (t0, controller.scale.t(x))
            owner.redrawAll()
        case .range(let t0):
            controller.brush = (t0, controller.scale.t(x))
            owner.redrawAll()
        case .pan(let lastX):
            controller.pan(by: Double(lastX - p.x))
            drag = .pan(lastX: p.x)
        case .none:
            break
        }
    }

    override func mouseUp(with e: NSEvent) {
        switch drag {
        case .pending(_, let hit):
            if case .item(let path)? = hit {
                controller.select(path)
            } else if case .band(_, let id)? = hit {
                controller.model.openEpisode(id)
            } else if case .context(let ti, let t)? = hit, let id = controller.layout.tracks[ti].session?.id, let points = controller.context[id],
                      let i = ContextPoint.index(at: t, in: points), let event = points[i].eventId {
                controller.model.select(event: event, reveal: false)
            } else {
                controller.select(nil)
            }
        case .range:
            if let b = controller.brush { controller.setInspectionRange(b.from, b.to) }
            controller.brush = nil
            owner.redrawAll()
        case .pan:
            NSCursor.pop()
        case .none:
            break
        }
        drag = .none
    }

    private func doubleClick(_ hit: TimelineHit?, at p: NSPoint) {
        let c = controller
        switch hit {
        case .item(let path)?:
            let it = c.layout[path]
            if let s = it.session {
                c.model.openSession(s.id, workspace: .timeline)
            } else if it.process != nil || it.delegation != nil {
                c.select(path)
                c.activateFocus()
            } else {
                c.zoom(to: it.start, it.end)
            }
        case .gap(let g)?:
            c.zoom(to: g.start, g.end)
        case .band(_, let id)?:
            c.model.openEpisode(id)
        case .header(let ti, false)?:
            if let s = c.layout.tracks[ti].session, c.model.scope.sessions != [s.id] { c.model.openSession(s.id, workspace: .timeline) }
        case .header:
            break
        default:
            let x = Double(p.x - TimelineView.headerWidth), s = c.scale
            c.zoom(to: s.t(x - c.plotWidth / 4), s.t(x + c.plotWidth / 4))
        }
    }

    override func scrollWheel(with e: NSEvent) {
        super.scrollWheel(with: e)
        clearHover()
    }

    override func smartMagnify(with e: NSEvent) { owner.handleSmartMagnify(at: point(e)) }

    override func menu(for event: NSEvent) -> NSMenu? {
        window?.makeFirstResponder(self)
        owner.hud.hide()
        return owner.contextMenu(for: owner.hit(at: point(event)))
    }

    // MARK: Keyboard

    override func keyDown(with e: NSEvent) {
        let c = controller
        let option = e.modifierFlags.contains(.option)
        switch e.specialKey {
        case .leftArrow?: option ? c.pan(by: -c.plotWidth * 0.15) : c.moveSelection(.previous)
        case .rightArrow?: option ? c.pan(by: c.plotWidth * 0.15) : c.moveSelection(.next)
        case .upArrow?: c.moveSelection(.up)
        case .downArrow?: c.moveSelection(.down)
        case .carriageReturn?, .enter?, .newline?: c.activateFocus()
        case .pageUp?: scroll(NSPoint(x: visibleRect.minX, y: max(0, visibleRect.minY - visibleRect.height * 0.9)))
        case .pageDown?: scroll(NSPoint(x: visibleRect.minX, y: min(bounds.height - visibleRect.height, visibleRect.minY + visibleRect.height * 0.9)))
        default:
            if e.keyCode == 53 { // Escape
                if c.brush != nil {
                    c.brush = nil
                    drag = .none
                    owner.redrawAll()
                } else if !c.zoomBack() {
                    NSSound.beep()
                }
            } else {
                super.keyDown(with: e)
            }
        }
    }

    /// ⌘+ (⌘=), ⌘− and ⌘0 while the tracks have focus.
    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        guard window?.firstResponder === self, e.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command else {
            return super.performKeyEquivalent(with: e)
        }
        switch e.charactersIgnoringModifiers {
        case "=", "+": controller.zoomIn()
        case "-": controller.zoomOut()
        case "0": controller.zoomToFit()
        default: return super.performKeyEquivalent(with: e)
        }
        return true
    }

    // MARK: Accessibility

    func invalidateAccessibility() { axChildren = nil }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityLabel() -> String? { controller.mode == .overview ? "Projects" : "Session tracks" }
    override func accessibilityHelp() -> String? {
        "Arrow keys move between bars; Option-Left and Option-Right pan; Return shows the selected span in Events or opens the selected session; Escape zooms back."
    }

    override func accessibilityChildren() -> [Any]? {
        let layout = controller.layout
        let s = controller.scale
        let H = TimelineView.headerWidth
        let vis = visibleRect
        let tA = s.t(0), tB = s.t(Double(owner.plotWidth))
        var out: [TimelineAXElement] = []
        for ti in layout.visibleTracks(top: vis.minY, height: vis.height) {
            let t = layout.tracks[ti]
            let trackLabel: String
            switch t.kind {
            case .session(let sess, _):
                let dur = t.band.map { Formatters.duration(Int64($0.end - $0.start)) } ?? "unknown duration"
                trackLabel = [sess.displayTitle, TimelineText.roleBadge(sess.role), dur, Formatters.count(sess.nEvents, "event")].compactMap { $0 }
                    .joined(separator: ", ")
            case .project(let name, let n, _):
                trackLabel = "\(name), \(Formatters.count(n, "session"))"
            }
            let trackEl = TimelineAXElement.make(role: .group, label: trackLabel, rect: NSRect(x: 0, y: t.y, width: vis.maxX, height: t.h),
                                                 in: self, parent: self)
            var kids: [TimelineAXElement] = []
            let header = TimelineAXElement.make(role: .disclosureTriangle, label: t.collapsed ? "Expand track" : "Collapse track",
                                                rect: NSRect(x: 0, y: t.y, width: H, height: min(t.h, 28)), in: self, parent: trackEl) { [weak self] in
                self?.controller.toggleCollapsed(track: ti)
            }
            kids.append(header)
            for (r, row) in t.rows.enumerated() {
                var i = row.firstIndex(endingAtOrAfter: tA)
                while i < row.items.count, kids.count < 150 {
                    let it = row.items[i]
                    if it.start > tB { break }
                    let path = TimelineItemPath(track: ti, row: r, item: i)
                    i += 1
                    if it.end < tA { continue }
                    let xa = H + CGFloat(s.x(it.start)), xb = H + CGFloat(s.x(it.end))
                    guard xb - xa >= 2 || it.id == controller.highlightedPath.map({ layout[$0].id }) else { continue }
                    let label: String
                    if let sp = it.span {
                        label = "\(TimelineText.spanKind(sp)) \(it.label), \(TimelineText.duration(sp))" + (sp.status == .error ? ", error" : "")
                    } else if let p = it.process {
                        label = "Process \(it.label), \(p.status)"
                    } else if let d = it.delegation {
                        label = "Delegation \(it.label), \(d.outcome.rawValue)" + (d.silent ? ", silent" : "")
                    } else {
                        let n = it.session.map { controller.ticks[$0.id]?.count ?? 0 } ?? 0
                        label = "Session \(it.label)" + (n > 0 ? ", \(Formatters.count(n, "unrecovered episode"))" : "")
                    }
                    let el = TimelineAXElement.make(role: .button, label: label,
                                                    rect: NSRect(x: max(H, xa), y: it.y, width: max(2, min(xb, H + owner.plotWidth) - max(H, xa)), height: it.h),
                                                    in: self, parent: trackEl) { [weak self] in self?.controller.select(path) }
                    el.setAccessibilitySelected(path == controller.highlightedPath)
                    kids.append(el)
                }
            }
            if let sess = t.session {
                for e in (controller.bands[sess.id] ?? []).prefix(40) where Double(e.endTs) >= tA && Double(e.startTs) <= tB {
                    let xa = H + CGFloat(s.x(Double(e.startTs))), xb = H + CGFloat(s.x(Double(e.endTs)))
                    let spark = t.sparkRect ?? (t.y, 12)
                    let label = (TimelineController.isUnrecoveredBand(e) ? "Unrecovered failure band" : "Recovery after \(e.nAttempts) attempts")
                        + ", \(e.targetKey), \(DerivedStyle.outcomeWord(e.outcome.rawValue))" + (e.loop ? ", loop" : "")
                    kids.append(TimelineAXElement.make(role: .button, label: label,
                                                       rect: NSRect(x: max(H, xa), y: spark.y, width: max(3, xb - max(H, xa)), height: spark.h),
                                                       in: self, parent: trackEl) { [weak self] in self?.controller.model.openEpisode(e.id) })
                }
            }
            if let lane = t.contextLane, let id = t.session?.id, let points = controller.context[id] {
                kids.append(TimelineAXElement.make(role: .image, label: TimelineContextDrawing.accessibilityLabel(points),
                                                   rect: NSRect(x: H, y: lane.y, width: owner.plotWidth, height: lane.h), in: self, parent: trackEl))
            }
            trackEl.setAccessibilityChildren(kids)
            out.append(trackEl)
        }
        axChildren = out
        return out
    }
}
