import AppKit
import SwiftUI

/// The compact timeline above the event table (MAC-SPEC §5 "Timeline track"): the current view's event density, the
/// turns of the scoped sessions and the selected event's marker. Click jumps to the nearest event (or a turn's first
/// event), drag sets the scope's time range, pinch or ⌘-scroll zooms, double-click fits. The Events workspace shows
/// and hides it with ⌥⌘T.
struct TimelineTrackStrip: View {
    @Bindable var model: WindowModel
    /// Preferred height; the strip draws at any height from `minimumHeight` up.
    static let height: CGFloat = 110
    static let minimumHeight: CGFloat = 56

    var body: some View {
        StripHost(model: model)
            .overlay(alignment: .topTrailing) {
                HStack(spacing: 2) {
                    if model.scope.hasTimeRange {
                        Button { model.clearTimeScope() } label: { Image(systemName: "xmark.circle") }
                            .iconHelp("Clear the Time Range")
                    }
                    Button { model.workspace = .timeline } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                        .iconHelp("Open in the Timeline Workspace")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.bar, in: RoundedRectangle(cornerRadius: 5))
                .padding(.top, TimelineStripView.axisHeight + 3)
                .padding(.trailing, 6)
            }
            .frame(minHeight: Self.minimumHeight, idealHeight: Self.height, maxHeight: .infinity)
    }
}

private struct StripHost: NSViewRepresentable {
    let model: WindowModel

    func makeNSView(context: Context) -> TimelineStripView { TimelineStripView(model: model) }
    func updateNSView(_ view: TimelineStripView, context: Context) {}
}

/// The strip's AppKit view; it follows the window model on its own.
final class TimelineStripView: NSView {
    let model: WindowModel
    static let axisHeight: CGFloat = 18
    private static let pad: CGFloat = 8

    private var key = ""
    private var loadedSessions: [String]?
    private var loading = true
    private var extent: (lo: Double, hi: Double)?
    private var gaps: [TimeGap] = []
    private var turns: TimelineRow?
    private var viewport: TimeViewport?
    private var zoomed = false
    private var density: [Histogram] = []
    private var densityLoaded: TimelineData.DensityKey?
    private var densityTask: Task<Void, Never>?
    private var loadTask: Task<Void, Never>?
    private var marker: Double?
    private var dragStart: CGFloat?
    private var brush: (CGFloat, CGFloat)?
    private var hoverX: CGFloat?
    private var tracking: NSTrackingArea?
    private var lastRange: [Int64?] = [nil, nil]
    private var gapSettings: (Bool, Int64) = (true, 0)
    /// Unscoped, the strip spans the history of every session, which an index run extends by seconds: a live update
    /// reloads that overview (hundreds of kilobytes of JSON) at most every `overviewRefreshInterval`.
    static let overviewRefreshInterval: TimeInterval = 30
    private var overviewLoadedAt = Date.distantPast
    private var deferredLoad: Task<Void, Never>?
    private let hud = TimelineHUD()

    init(model: WindowModel) {
        self.model = model
        super.init(frame: NSRect(x: 0, y: 0, width: 600, height: TimelineTrackStrip.height))
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        addSubview(hud)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Timeline of the current scope")
        setAccessibilityHelp("Click selects the nearest event. Drag sets the time range. Double-click shows everything.")
        observe()
        sync()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }

    private var plotWidth: Double { Double(max(1, bounds.width - 2 * Self.pad)) }
    private var activeGaps: [TimeGap] { gapSettings.0 ? gaps : [] }
    private var scale: TimeScale? { viewport.map { TimeScale($0, gaps: activeGaps) } }
    private var turnRowY: CGFloat { bounds.height - 16 }

    // MARK: Following the window

    private func observe() {
        withObservationTracking {
            _ = model.scope
            _ = model.view
            _ = model.eventDetail
            _ = model.selectedEvent
            _ = model.store.indexGeneration
            _ = model.engine.api
            _ = model.app.preferences.collapseIdleGaps
            _ = model.app.preferences.idleGapMinutes
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.observe()
                self?.sync()
            }
        }
    }

    private func sync() {
        guard let api = model.engine.api else { return }
        let p = model.app.preferences
        let settings = (p.collapseIdleGaps, p.idleGapMicroseconds)
        let base = "\(api.endpoint.baseURL)|"
        let newKey = base + "\(model.store.indexGeneration)"
        let reload = newKey != key || model.scope.sessions != loadedSessions || settings != gapSettings
        let liveUpdate = key.hasPrefix(base) && model.scope.sessions.isEmpty && loadedSessions == [] && settings == gapSettings
        let wait = Self.overviewRefreshInterval - Date().timeIntervalSince(overviewLoadedAt)
        if reload && liveUpdate && wait > 0 {
            if deferredLoad == nil {
                deferredLoad = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(wait))
                    guard !Task.isCancelled, let self else { return }
                    self.deferredLoad = nil
                    self.sync()
                }
            }
        } else if reload {
            // A new session set fits again; a live index update or a gap setting keeps the zoom.
            let keepZoom = zoomed && model.scope.sessions == loadedSessions
            key = newKey
            loadedSessions = model.scope.sessions
            gapSettings = settings
            deferredLoad?.cancel()
            deferredLoad = nil
            if model.scope.sessions.isEmpty { overviewLoadedAt = Date() }
            load(api: api, keepZoom: keepZoom)
        }
        if !reload || (liveUpdate && wait > 0), [model.scope.from, model.scope.to] != lastRange {
            lastRange = [model.scope.from, model.scope.to]
            fit()
        }
        if let d = model.eventDetail, d.event.id == model.selectedEvent { marker = Double(d.event.ts) } else if model.selectedEvent == nil { marker = nil }
        requestDensity(debounce: false)
        needsDisplay = true
    }

    private func load(api: APIClient, keepZoom: Bool) {
        let ids = model.scope.sessions
        let generation = model.store.indexGeneration
        let minGap = Double(gapSettings.1)
        loadTask?.cancel()
        loading = true
        loadTask = Task { [weak self] in
            var turnItems: [TimelineItem] = []
            var busy: [(start: Double, end: Double?)] = []
            var points: [(Double, Double)] = []
            if ids.isEmpty {
                let sessions = (try? await TimelineData.overview(api: api, generation: generation)) ?? []
                for s in sessions {
                    guard let start = s.start else { continue }
                    busy.append((start: Double(start), end: s.end.map(Double.init)))
                    points.append((Double(start), Double(s.end ?? start)))
                }
            } else {
                for id in ids {
                    guard let d = try? await TimelineData.sessionDetail(id, api: api, generation: generation) else { continue }
                    for t in d.turns {
                        turnItems.append(TimelineLayout.item(for: t))
                        busy.append((start: Double(t.start), end: t.end.map(Double.init)))
                    }
                    for s in [d.session.row] + d.children {
                        guard let start = s.start else { continue }
                        points.append((Double(start), Double(s.end ?? start)))
                        // The strip knows only the scoped sessions' turns, so subagents count as busy for their whole
                        // life: an idle gap never hides events of the view.
                        if s.id != d.session.id || d.turns.isEmpty { busy.append((start: Double(start), end: s.end.map(Double.init))) }
                    }
                }
            }
            guard !Task.isCancelled, let self else { return }
            if points.isEmpty, let info = self.model.info, let a = info.firstTs { points = [(Double(a), Double(info.lastTs ?? a))] }
            let lo = points.map(\.0).min(), hi = points.map(\.1).max()
            self.extent = lo.flatMap { lo in hi.map { (lo, max($0, lo + 1000)) } }
            self.gaps = TimeScale.findGaps(busy, minGap: minGap)
            self.turns = turnItems.isEmpty ? nil
                : TimelineRow(items: turnItems.sorted { $0.start < $1.start }, y: 0, h: 12, barHeight: 10)
            self.loading = false
            self.lastRange = [self.model.scope.from, self.model.scope.to]
            if keepZoom, let v = self.viewport { self.setViewport(v) } else { self.fit() }
        }
    }

    /// Fit the scope's time range when set, else everything.
    private func fit() {
        guard let e = extent else {
            viewport = nil
            needsDisplay = true
            return
        }
        let lo = model.scope.from.map(Double.init) ?? e.lo, hi = model.scope.to.map(Double.init) ?? e.hi
        viewport = TimeScale.fit(from: hi > lo ? lo : e.lo, to: hi > lo ? hi : e.hi, width: plotWidth, gaps: activeGaps, pad: 2)
        zoomed = false
        requestDensity(debounce: false)
        needsDisplay = true
    }

    private func setViewport(_ v: TimeViewport) {
        viewport = TimeScale.keepInView(v, extent: extent, width: plotWidth, gaps: activeGaps)
        zoomed = true
        requestDensity(debounce: true)
        needsDisplay = true
    }

    private func requestDensity(debounce: Bool) {
        guard let api = model.engine.api, let view = model.view, let s = scale else {
            if model.view == nil {
                density = []
                densityLoaded = nil
            }
            return
        }
        let a = s.t(0), b = s.t(plotWidth)
        let loaded = TimelineData.DensityKey(view: view.viewId, width: Int(plotWidth), gaps: activeGaps, from: a, to: b)
        if densityLoaded?.serves(loaded) == true { return }
        densityTask?.cancel()
        let width = plotWidth
        densityTask = Task { [weak self] in
            if debounce { try? await Task.sleep(for: .milliseconds(150)) }
            guard !Task.isCancelled else { return }
            let parts = await TimelineData.density(api: api, view: view.viewId, scale: s, from: a, to: b, width: width)
            guard !Task.isCancelled, let self, self.model.view?.viewId == view.viewId else { return }
            self.density = parts
            self.densityLoaded = loaded
            self.needsDisplay = true
        }
    }

    override func setFrameSize(_ newSize: NSSize) {
        let changed = newSize.width != frame.width
        super.setFrameSize(newSize)
        if changed { zoomed ? setViewport(viewport ?? TimeViewport(t0: 0, k: 1)) : fit() }
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let bs = window?.backingScaleFactor ?? 2
        let x0 = Self.pad, pw = CGFloat(plotWidth), axisH = Self.axisHeight
        NSColor.controlBackgroundColor.setFill()
        bounds.fill()
        NSColor.windowBackgroundColor.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: axisH).fill()
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: axisH - 1, width: bounds.width, height: 1).fill()
        guard let s = scale else {
            let text: String
            switch model.viewPhase {
            case .failed: text = "Could not load this view."
            case .empty: text = "No events in scope."
            default: text = loading ? "Loading…" : "No events in scope."
            }
            TimelineDrawing.text(text, in: CGRect(x: x0, y: axisH, width: pw, height: bounds.height - axisH), font: .systemFont(ofSize: 11),
                                 color: .secondaryLabelColor)
            return
        }
        let tA = s.t(0), tB = s.t(Double(pw))
        let axis = TimeTicks.axis(s, width: Double(pw), minSpacing: 90, zone: Formatters.timeZone)
        // The date and UTC offset the tick labels leave out sit at the right end of the axis, measured first: a tick
        // label that would come within 6 pt of them is left out whole rather than cut ("17:2", DESIGN.md §3.5), as the
        // Timeline workspace keeps its date header out of its tick row.
        let context = axis.context
        let dateW = TimelineDrawing.width(context, font: TimelineDrawing.tickFont)
        let dateRect = CGRect(x: bounds.width - Self.pad - dateW, y: 0, width: dateW, height: axisH - 2)
        TimelineDrawing.ruler(ctx, axis: axis, scale: s, x0: x0, y: 0, width: pw, height: axisH, backingScale: bs, keepClear: dateRect)

        ctx.saveGState()
        ctx.clip(to: CGRect(x: x0, y: axisH, width: pw, height: bounds.height - axisH))
        NSColor.separatorColor.withAlphaComponent(0.35).setFill()
        for tk in axis.ticks { NSRect(x: TimelineDrawing.snap(x0 + CGFloat(tk.x), bs), y: axisH, width: 1 / bs, height: bounds.height - axisH).fill() }
        let densityTop = axisH + 4, densityBottom = turns == nil ? bounds.height - 4 : turnRowY - 4
        if model.viewPhase == .ready {
            TimelineDrawing.density(ctx, scale: s, parts: density, x0: x0, top: densityTop, height: densityBottom - densityTop,
                                    fill: NSColor.controlAccentColor.withAlphaComponent(0.6), clipWidth: pw)
        } else if case .failed = model.viewPhase {
            TimelineDrawing.text("Could not load this view.", in: CGRect(x: x0 + 4, y: densityTop, width: pw, height: densityBottom - densityTop),
                                 font: .systemFont(ofSize: 11), color: Theme.err)
        }
        if let turns {
            var rects: [CGRect] = [], edges: [CGRect] = [], errors: [CGRect] = []
            var i = turns.firstIndex(endingAtOrAfter: tA)
            while i < turns.items.count, turns.items[i].start <= tB {
                let it = turns.items[i]
                i += 1
                let xa = x0 + CGFloat(s.x(it.start)), xb = max(xa + 1, x0 + CGFloat(s.x(it.end)))
                let r = CGRect(x: xa, y: turnRowY + 1, width: xb - xa, height: 10)
                rects.append(r)
                edges.append(CGRect(x: xa, y: r.minY, width: min(2, r.width), height: r.height))
                if it.isError { errors.append(r) }
            }
            let c = Theme.color(.user)
            ctx.setFillColor(c.withAlphaComponent(0.25).cgColor)
            ctx.fill(rects)
            ctx.setFillColor(c.withAlphaComponent(0.8).cgColor)
            ctx.fill(edges)
            ctx.setStrokeColor(Theme.err.cgColor)
            ctx.setLineWidth(1.5)
            for r in errors { ctx.stroke(r.insetBy(dx: 0.75, dy: 0.75)) }
        }
        TimelineDrawing.breaks(ctx, scale: s, from: tA, to: tB, x0: x0, y0: axisH, y1: bounds.height)
        TimelineDrawing.dimOutside(ctx, scale: s, from: model.scope.from, to: model.scope.to, x0: x0, y0: axisH, width: pw,
                                   height: bounds.height - axisH)
        if let m = marker { TimelineDrawing.marker(ctx, x: x0 + CGFloat(s.x(m)), y0: axisH, height: bounds.height - axisH, cap: true) }
        if let (a, b) = brush {
            TimelineDrawing.range(ctx, xa: a, xb: b, y0: axisH, height: bounds.height - axisH)
        } else if let h = hoverX {
            NSColor.tertiaryLabelColor.setFill()
            NSRect(x: h, y: axisH, width: 1, height: bounds.height - axisH).fill()
        }
        ctx.restoreGState()
        // The date over the tick marks under it; the tick labels already keep their distance.
        NSColor.windowBackgroundColor.setFill()
        NSRect(x: dateRect.minX - TimelineDrawing.tickClearance, y: 0, width: bounds.width - dateRect.minX + TimelineDrawing.tickClearance,
               height: axisH - 1).fill()
        // Right-aligned in a rect 2 pt wider on the left, so rounding never cuts the date's first character.
        TimelineDrawing.text(context, in: CGRect(x: dateRect.minX - 2, y: 0, width: dateRect.width + 2, height: dateRect.height),
                             font: TimelineDrawing.tickFont, color: .secondaryLabelColor, alignment: .right)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    // MARK: Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(t)
        tracking = t
    }

    private func plotX(_ e: NSEvent) -> CGFloat {
        min(max(0, convert(e.locationInWindow, from: nil).x - Self.pad), CGFloat(plotWidth))
    }

    private func turn(at x: CGFloat, y: CGFloat) -> TimelineItem? {
        guard let turns, let s = scale, y >= turnRowY - 2, y <= turnRowY + 14 else { return nil }
        let t = s.t(Double(x)), tA = s.t(Double(x) - 2), tB = s.t(Double(x) + 2)
        var best: TimelineItem?
        var i = turns.firstIndex(endingAtOrAfter: tA)
        while i < turns.items.count, turns.items[i].start <= tB {
            let it = turns.items[i]
            if it.end >= tA, best.map({ abs(it.start - t) < abs($0.start - t) }) ?? true { best = it }
            i += 1
        }
        return best
    }

    override func mouseMoved(with e: NSEvent) {
        let p = convert(e.locationInWindow, from: nil)
        let x = p.x - Self.pad
        guard let s = scale, x >= 0, x <= CGFloat(plotWidth) else {
            hoverX = nil
            hud.hide()
            needsDisplay = true
            return
        }
        hoverX = p.x
        needsDisplay = true
        if let t = turn(at: x, y: p.y), let sp = t.span {
            hud.show(TimelineView.spanTip(sp, store: model.store), near: p, in: bounds)
            return
        }
        let t = s.t(Double(x))
        for part in density {
            let i = Int((t - Double(part.from)) / Double(part.binUs))
            guard part.bins.indices.contains(i), t >= Double(part.from) else { continue }
            let b = part.bins[i], from = part.from + Int64(i) * part.binUs
            hud.show(TimelineHUD.content(title: Formatters.count(b.count, "event") + (b.errors > 0 ? " · \(Formatters.count(b.errors, "error"))" : ""),
                                         rows: [("From", Formatters.timestamp(from)), ("To", Formatters.timestamp(from + part.binUs))]),
                     near: p, in: bounds)
            return
        }
        hud.hide()
    }

    override func mouseExited(with event: NSEvent) {
        hoverX = nil
        hud.hide()
        needsDisplay = true
    }

    override func mouseDown(with e: NSEvent) {
        hud.hide()
        if e.clickCount == 2 {
            dragStart = nil
            fit()
            return
        }
        dragStart = plotX(e)
    }

    override func mouseDragged(with e: NSEvent) {
        guard let start = dragStart else { return }
        let x = plotX(e)
        if brush != nil || abs(x - start) > 3 {
            brush = (Self.pad + start, Self.pad + x)
            needsDisplay = true
        }
    }

    override func mouseUp(with e: NSEvent) {
        guard let start = dragStart, let s = scale else { return }
        dragStart = nil
        if let (a, b) = brush {
            brush = nil
            needsDisplay = true
            let ta = s.t(Double(min(a, b) - Self.pad)), tb = s.t(Double(max(a, b) - Self.pad))
            model.setTimeRange(from: Int64(ta.rounded(.down)), to: Int64(tb.rounded(.up)))
            return
        }
        if let t = turn(at: start, y: convert(e.locationInWindow, from: nil).y), let first = t.span?.firstEvent {
            model.select(event: first, reveal: true)
            return
        }
        let t = s.t(Double(start))
        let model = model
        Task {
            if let id = await TimelineData.eventNear(t, model: model) { model.select(event: id, reveal: true) }
        }
    }

    override func scrollWheel(with e: NSEvent) {
        guard let v = viewport else { return super.scrollWheel(with: e) }
        let precise = e.hasPreciseScrollingDeltas
        let dx = e.scrollingDeltaX * (precise ? 1 : 10), dy = e.scrollingDeltaY * (precise ? 1 : 10)
        let x = Double(plotX(e))
        hud.hide()
        if e.modifierFlags.contains(.command) {
            setViewport(TimeScale.zoom(v, around: x, factor: exp(Double(abs(dy) >= abs(dx) ? dy : dx) * 0.01), gaps: activeGaps, minK: minK))
        } else if abs(dx) > abs(dy) {
            setViewport(TimeScale.pan(v, by: Double(-dx), gaps: activeGaps))
        } else {
            super.scrollWheel(with: e)
        }
    }

    override func magnify(with e: NSEvent) {
        guard let v = viewport else { return }
        hud.hide()
        setViewport(TimeScale.zoom(v, around: Double(plotX(e)), factor: max(0.2, 1 + Double(e.magnification)), gaps: activeGaps, minK: minK))
    }

    private var minK: Double {
        guard let e = extent else { return 0 }
        return TimeScale.fit(from: e.lo, to: e.hi, width: plotWidth, gaps: activeGaps).k / 2
    }

    // MARK: Accessibility

    override func accessibilityValue() -> Any? {
        guard let s = scale else { return loading ? "Loading" : "No events in scope" }
        var parts = ["Showing " + Formatters.timeRange(from: Int64(s.t(0)), to: Int64(s.t(plotWidth)))]
        if let v = model.view { parts.append(Formatters.count(v.count, "event")) }
        if let m = marker { parts.append("selected event at " + Formatters.timestamp(Int64(m))) }
        return parts.joined(separator: ", ")
    }

    override func accessibilityChildren() -> [Any]? {
        guard let turns, let s = scale else { return [] }
        var out: [TimelineAXElement] = []
        var i = turns.firstIndex(endingAtOrAfter: s.t(0))
        while i < turns.items.count, turns.items[i].start <= s.t(plotWidth), out.count < 100 {
            let it = turns.items[i]
            i += 1
            guard let sp = it.span else { continue }
            let xa = Self.pad + CGFloat(s.x(it.start)), xb = max(xa + 2, Self.pad + CGFloat(s.x(it.end)))
            let model = model
            out.append(TimelineAXElement.make(role: .button, label: "Turn \(it.label), \(TimelineText.duration(sp))",
                                              rect: NSRect(x: xa, y: turnRowY, width: xb - xa, height: 12), in: self, parent: self) {
                if let first = sp.firstEvent { model.select(event: first, reveal: true) }
            })
        }
        return out
    }
}
