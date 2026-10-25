import AppKit

/// The sequence diagram (MAC-SPEC §7 "Flow"): lane headers above a vertically scrolling, row-virtualized canvas.
/// Each row draws its slice of the lifelines plus one arrow, note or turn separator; only rows in the dirty rect
/// are drawn and fetched. Returns are dashed and errors red with a ✕, so color is never the only cue.
final class FlowDiagramView: NSView {
    let controller: FlowController
    let scrollView = NSScrollView()
    private(set) var header: FlowLaneHeaderView!
    private(set) var canvas: FlowCanvasView!
    let hud = TimelineHUD()
    private(set) var laneX: [String: CGFloat] = [:]
    private(set) var laneWidth: CGFloat = FlowDiagramView.minLaneWidth
    private(set) var contentWidth: CGFloat = 0

    static let rowHeight: CGFloat = 28
    static let gutter: CGFloat = 96
    static let minLaneWidth: CGFloat = 136
    static let headerHeight: CGFloat = 38

    init(controller: FlowController) {
        self.controller = controller
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
        header = FlowLaneHeaderView(owner: self)
        canvas = FlowCanvasView(owner: self)
        scrollView.documentView = canvas
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .controlBackgroundColor
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(clipBoundsChanged), name: NSView.boundsDidChangeNotification,
                                               object: scrollView.contentView)
        addSubview(header)
        addSubview(scrollView)
        addSubview(hud)
        controller.view = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        header.frame = NSRect(x: 0, y: 0, width: bounds.width, height: Self.headerHeight)
        scrollView.frame = NSRect(x: 0, y: Self.headerHeight, width: bounds.width, height: max(0, bounds.height - Self.headerHeight))
        relayoutLanes()
    }

    private func relayoutLanes() {
        let lanes = controller.lanes
        let n = CGFloat(max(1, lanes.count))
        let clip = scrollView.contentSize.width
        laneWidth = max(Self.minLaneWidth, ((clip - Self.gutter) / n).rounded(.down))
        laneX = Dictionary(lanes.enumerated().map { ($1.key, Self.gutter + laneWidth * (CGFloat($0) + 0.5)) }, uniquingKeysWith: { a, _ in a })
        contentWidth = Self.gutter + laneWidth * n
        canvas.updateSize()
        header.needsDisplay = true
        canvas.needsDisplay = true
    }

    @objc private func clipBoundsChanged(_ note: Notification) {
        hud.hide()
        header.needsDisplay = true
    }

    // MARK: Called by the controller

    func reload(keepPosition: Bool) {
        hud.hide()
        relayoutLanes()
        if !keepPosition { canvas.scroll(.zero) }
        canvas.invalidateAccessibility()
    }

    func rowsLoaded(_ rows: IndexSet) {
        guard let first = rows.first, let last = rows.last else { return }
        let r = NSRect(x: 0, y: CGFloat(first) * Self.rowHeight, width: canvas.bounds.width, height: CGFloat(last - first + 1) * Self.rowHeight)
        let visible = r.intersection(canvas.visibleRect)
        if !visible.isEmpty { canvas.setNeedsDisplay(visible) }
    }

    func selectionChanged(scrollTo index: Int?) {
        canvas.setNeedsDisplay(canvas.visibleRect)
        guard let index else { return }
        let r = NSRect(x: canvas.visibleRect.minX, y: CGFloat(index) * Self.rowHeight, width: 1, height: Self.rowHeight)
        if !canvas.visibleRect.insetBy(dx: 0, dy: Self.rowHeight).intersects(r) {
            // Far away: center it, like a table revealing a row.
            let y = max(0, min(r.midY - canvas.visibleRect.height / 2, canvas.bounds.height - canvas.visibleRect.height))
            canvas.scroll(NSPoint(x: canvas.visibleRect.minX, y: y))
        } else {
            canvas.scrollToVisible(r)
        }
    }
}

// MARK: - Lane headers

/// Lane titles, kept above the diagram and scrolled horizontally with it. A subagent lane's title opens its session.
final class FlowLaneHeaderView: NSView {
    unowned let owner: FlowDiagramView
    private var tracking: NSTrackingArea?
    private var hoverLane: String?

    init(owner: FlowDiagramView) {
        self.owner = owner
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Lanes")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    private var offset: CGFloat { owner.scrollView.contentView.bounds.minX }

    private func laneRect(_ lane: FlowLane) -> NSRect? {
        owner.laneX[lane.key].map { NSRect(x: $0 - owner.laneWidth / 2 - offset, y: 0, width: owner.laneWidth, height: bounds.height) }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        TimelineDrawing.text("Time", in: NSRect(x: 10 - offset, y: 4, width: FlowDiagramView.gutter - 14, height: 15),
                             font: .systemFont(ofSize: 11, weight: .semibold), color: .secondaryLabelColor)
        TimelineDrawing.text("since first", in: NSRect(x: 10 - offset, y: 19, width: FlowDiagramView.gutter - 14, height: 13),
                             font: TimelineDrawing.captionFont, color: .tertiaryLabelColor)
        for lane in owner.controller.lanes {
            guard let r = laneRect(lane), r.maxX >= 0, r.minX <= bounds.width else { continue }
            // Centered over the lifeline, with the lane's color as a small swatch before the title.
            let link = lane.session != nil
            let inner = r.insetBy(dx: 8, dy: 0)
            let titleFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
            let swatch: CGFloat = lane.color == nil ? 0 : 13
            let titleW = min(inner.width - swatch, TimelineDrawing.width(lane.title, font: titleFont) + 2)
            let x0 = r.midX - (titleW + swatch) / 2
            if let c = lane.color {
                c.setFill()
                NSBezierPath(roundedRect: NSRect(x: x0, y: 8, width: 8, height: 8), xRadius: 2, yRadius: 2).fill()
            }
            TimelineDrawing.text(lane.title, in: NSRect(x: x0 + swatch, y: 4, width: titleW, height: 16), font: titleFont,
                                 color: link && hoverLane == lane.key ? .linkColor : .labelColor)
            if let sub = lane.subtitle {
                TimelineDrawing.text(sub, in: NSRect(x: inner.minX, y: 20, width: inner.width, height: 14), font: TimelineDrawing.captionFont,
                                     color: .secondaryLabelColor, alignment: .center)
            }
        }
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }

    private func lane(at p: NSPoint) -> FlowLane? {
        owner.controller.lanes.first { laneRect($0)?.contains(p) == true }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect, .cursorUpdate],
                               owner: self)
        addTrackingArea(t)
        tracking = t
    }

    override func mouseMoved(with e: NSEvent) {
        let l = lane(at: convert(e.locationInWindow, from: nil))
        let key = l?.session != nil ? l?.key : nil
        if key != hoverLane {
            hoverLane = key
            needsDisplay = true
        }
        (key != nil ? NSCursor.pointingHand : NSCursor.arrow).set()
        toolTip = l.map { $0.session != nil ? "Open \($0.title) in Flow" : [$0.title, $0.subtitle].compactMap { $0 }.joined(separator: " · ") }
    }

    override func mouseExited(with event: NSEvent) {
        hoverLane = nil
        NSCursor.arrow.set()
        needsDisplay = true
    }

    override func mouseUp(with e: NSEvent) {
        if let id = lane(at: convert(e.locationInWindow, from: nil))?.session {
            owner.controller.model.openSession(id, mode: .flow)
        }
    }

    override func scrollWheel(with e: NSEvent) { owner.scrollView.scrollWheel(with: e) }

    override func accessibilityChildren() -> [Any]? {
        owner.controller.lanes.compactMap { lane in
            guard let r = laneRect(lane) else { return nil }
            let label = [lane.title, lane.subtitle].compactMap { $0 }.joined(separator: ", ")
            if let id = lane.session {
                return TimelineAXElement.make(role: .link, label: label, rect: r, in: self, parent: self, help: "Opens this subagent in Flow") { [weak self] in
                    self?.owner.controller.model.openSession(id, mode: .flow)
                }
            }
            return TimelineAXElement.make(role: .staticText, label: label, rect: r, in: self, parent: self)
        }
    }
}

// MARK: - Canvas

/// The rows. Height is count × row height; only the dirty rows are fetched and drawn.
final class FlowCanvasView: NSView {
    unowned let owner: FlowDiagramView
    private var tracking: NSTrackingArea?

    init(owner: FlowDiagramView) {
        self.owner = owner
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        focusRingType = .exterior
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    private var controller: FlowController { owner.controller }
    private var rh: CGFloat { FlowDiagramView.rowHeight }

    func updateSize() {
        let clip = owner.scrollView.contentSize
        let size = NSSize(width: max(clip.width, owner.contentWidth), height: max(clip.height, CGFloat(controller.count) * rh))
        if frame.size != size { setFrameSize(size) }
    }

    override var focusRingMaskBounds: NSRect { visibleRect }
    override func drawFocusRingMask() { NSBezierPath(rect: visibleRect.insetBy(dx: 2, dy: 2)).fill() }

    override func becomeFirstResponder() -> Bool {
        setNeedsDisplay(visibleRect)
        noteFocusRingMaskChanged()
        return true
    }

    override func resignFirstResponder() -> Bool {
        setNeedsDisplay(visibleRect)
        return true
    }

    // MARK: Drawing

    override func draw(_ dirty: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        NSColor.controlBackgroundColor.setFill()
        dirty.fill()
        let count = controller.count
        guard count > 0, let pager = controller.pager else { return }
        let first = max(0, Int(dirty.minY / rh)), last = min(count - 1, Int(dirty.maxY / rh))
        guard first <= last else { return }
        let bs = window?.backingScaleFactor ?? 2
        let focused = window?.firstResponder === self && window?.isKeyWindow == true

        if let sel = controller.selectedIndex, (first...last).contains(sel) {
            (focused ? NSColor.selectedContentBackgroundColor.withAlphaComponent(0.22) : NSColor.unemphasizedSelectedContentBackgroundColor).setFill()
            NSRect(x: 0, y: CGFloat(sel) * rh, width: bounds.width, height: rh).fill()
        }
        // Lifelines
        NSColor.separatorColor.setFill()
        for x in owner.laneX.values {
            NSRect(x: TimelineDrawing.snap(x, bs), y: dirty.minY, width: 1 / bs, height: dirty.height).fill()
        }
        for i in first...last {
            let y = CGFloat(i) * rh
            guard let ev = pager.row(at: i) else {
                TimelineDrawing.text("…", in: NSRect(x: 10, y: y, width: 40, height: rh), font: TimelineDrawing.tickFont, color: .tertiaryLabelColor)
                continue
            }
            TimelineDrawing.text(Formatters.offset(ev.ts - controller.base), in: NSRect(x: 10, y: y + rh - 17, width: FlowDiagramView.gutter - 16, height: 14),
                                 font: TimelineDrawing.tickFont, color: .secondaryLabelColor)
            draw(controller.step(for: ev), at: y, error: ev.isError, ctx: ctx)
        }
        pager.prefetch(around: first..<(last + 1))
    }

    private func draw(_ step: FlowStep, at y: CGFloat, error: Bool, ctx: CGContext) {
        let ay = y + rh - 9
        let labelFont = NSFont.systemFont(ofSize: 11)
        switch step {
        case .arrow(let from, let to, let color, let dashed, let label):
            guard let x1 = owner.laneX[from], let x2 = owner.laneX[to], x1 != x2 else {
                return draw(.note(lane: from == "agent" ? to : from, color: color, label: label), at: y, error: error, ctx: ctx)
            }
            let dir: CGFloat = x2 > x1 ? 1 : -1
            ctx.saveGState()
            ctx.setStrokeColor(color.cgColor)
            ctx.setLineWidth(1.25)
            if dashed { ctx.setLineDash(phase: 0, lengths: [4, 3]) }
            ctx.move(to: CGPoint(x: x1, y: ay))
            ctx.addLine(to: CGPoint(x: x2 - dir * 6, y: ay))
            ctx.strokePath()
            ctx.restoreGState()
            ctx.setFillColor(color.cgColor)
            ctx.move(to: CGPoint(x: x2, y: ay))
            ctx.addLine(to: CGPoint(x: x2 - dir * 7, y: ay - 4))
            ctx.addLine(to: CGPoint(x: x2 - dir * 7, y: ay + 4))
            ctx.closePath()
            ctx.fillPath()
            FlowDiagramView.label(label, in: NSRect(x: min(x1, x2) + 7, y: ay - 16, width: abs(x2 - x1) - 14, height: 14), font: labelFont,
                       color: error ? Theme.err : .labelColor, failed: error)
        case .note(let lane, let color, let label):
            let x = owner.laneX[lane] ?? owner.laneX["agent"] ?? FlowDiagramView.gutter + 20
            ctx.setFillColor(color.cgColor)
            ctx.fillEllipse(in: CGRect(x: x - 3.5, y: ay - 3.5, width: 7, height: 7))
            FlowDiagramView.label(label, in: NSRect(x: x + 8, y: ay - 7, width: bounds.width - x - 16, height: 14), font: labelFont,
                       color: error ? Theme.err : .secondaryLabelColor, failed: error)
        case .separator(let color, let label):
            let my = y + rh / 2
            ctx.setFillColor(color.withAlphaComponent(0.7).cgColor)
            ctx.fill(CGRect(x: FlowDiagramView.gutter - 8, y: my - 0.5, width: bounds.width - FlowDiagramView.gutter + 8, height: 1))
            let font = NSFont.systemFont(ofSize: 11, weight: .medium)
            let w = min(TimelineDrawing.width(label, font: font) + 14 + (error ? 14 : 0), bounds.width - FlowDiagramView.gutter - 16)
            let pill = NSRect(x: FlowDiagramView.gutter, y: my - 9, width: w, height: 18)
            NSColor.controlBackgroundColor.setFill()
            let path = NSBezierPath(roundedRect: pill, xRadius: 4, yRadius: 4)
            path.fill()
            color.withAlphaComponent(0.7).setStroke()
            path.lineWidth = 1
            path.stroke()
            FlowDiagramView.label(label, in: pill.insetBy(dx: 7, dy: 0), font: font, color: error ? Theme.err : .labelColor, failed: error)
        }
    }

    // MARK: Mouse

    private func row(at e: NSEvent) -> Int { Int(convert(e.locationInWindow, from: nil).y / rh) }

    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        owner.hud.hide()
        let i = row(at: e)
        guard i >= 0, i < controller.count else { return }
        controller.select(row: i, reveal: e.clickCount == 2)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(t)
        tracking = t
    }

    override func mouseMoved(with e: NSEvent) {
        let i = row(at: e)
        guard i >= 0, i < controller.count, let ev = controller.pager?.row(at: i) else { return owner.hud.hide() }
        var rows: [(String, String)] = [("Kind", ev.kind.rawValue), ("Time", Formatters.timestamp(ev.ts))]
        if let d = ev.dur { rows.append(("Duration", Formatters.duration(d))) }
        if let t = ev.toolName { rows.append(("Tool", t)) }
        if ev.isError { rows.append(("Status", "Error")) }
        rows.append(("", "Double-click to show in Events"))
        let content = TimelineHUD.content(title: String(ev.summary.prefix(240)), rows: rows, titleColor: ev.isError ? Theme.err : .labelColor)
        owner.hud.show(content, near: convert(convert(e.locationInWindow, from: nil), to: owner), in: owner.bounds)
    }

    override func mouseExited(with event: NSEvent) { owner.hud.hide() }

    override func scrollWheel(with e: NSEvent) {
        owner.hud.hide()
        super.scrollWheel(with: e)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let i = row(at: event)
        guard i >= 0, i < controller.count, let ev = controller.pager?.row(at: i) else { return nil }
        controller.select(row: i, reveal: false)
        let model = controller.model
        let m = NSMenu()
        m.addItem(TimelineMenuItem("Show in Events") { model.select(event: ev.id, reveal: true) })
        m.addItem(TimelineMenuItem("Show in Timeline") {
            model.select(event: ev.id, reveal: false)
            model.workspace = .timeline
        })
        m.addItem(TimelineMenuItem("Show in Conversation") {
            model.select(event: ev.id, reveal: false)
            model.sessionMode = .transcript
            model.workspace = .session
        })
        m.addItem(.separator())
        m.addItem(TimelineMenuItem("Copy Summary") { AppKitHelpers.copy(ev.summary) })
        m.addItem(TimelineMenuItem("Copy Event ID") { AppKitHelpers.copy(ev.id) })
        m.addItem(TimelineMenuItem("Copy Timestamp") { AppKitHelpers.copy(Formatters.iso8601(ev.ts)) })
        return m
    }

    // MARK: Keyboard

    override func keyDown(with e: NSEvent) {
        let sel = controller.selectedIndex
        switch e.specialKey {
        case .upArrow?: controller.select(row: max(0, (sel ?? 1) - 1), reveal: false)
        case .downArrow?: controller.select(row: min(controller.count - 1, (sel ?? -1) + 1), reveal: false)
        case .home?: controller.select(row: 0, reveal: false)
        case .end?: controller.select(row: controller.count - 1, reveal: false)
        case .pageUp?, .pageDown?:
            let page = max(1, Int(visibleRect.height / rh) - 1)
            let next = (sel ?? 0) + (e.specialKey == .pageUp ? -page : page)
            controller.select(row: max(0, min(controller.count - 1, next)), reveal: false)
        case .carriageReturn?, .enter?, .newline?:
            if let sel { controller.select(row: sel, reveal: true) }
        default:
            super.keyDown(with: e)
        }
    }

    // MARK: Accessibility

    private var axCache: [TimelineAXElement]?

    func invalidateAccessibility() { axCache = nil }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .list }
    override func accessibilityLabel() -> String? { "Sequence diagram" }
    override func accessibilityHelp() -> String? { "Up and Down arrows move between events; Return shows the selected event in Events." }

    override func accessibilityChildren() -> [Any]? {
        guard let pager = controller.pager, controller.count > 0 else { return [] }
        let vis = visibleRect
        let first = max(0, Int(vis.minY / rh)), last = min(controller.count - 1, Int(vis.maxY / rh))
        guard first <= last else { return [] }
        let titles = Dictionary(controller.lanes.map { ($0.key, $0.title) }, uniquingKeysWith: { a, _ in a })
        var out: [TimelineAXElement] = []
        for i in first...last {
            guard let ev = pager.row(at: i) else { continue }
            let what: String
            switch controller.step(for: ev) {
            case .arrow(let from, let to, _, let dashed, let label):
                what = "\(titles[from] ?? from) \(dashed ? "returns to" : "to") \(titles[to] ?? to): \(label)"
            case .note(let lane, _, let label): what = "\(titles[lane] ?? lane): \(label)"
            case .separator(_, let label): what = label
            }
            let label = "\(Formatters.offset(ev.ts - controller.base)), \(what)" + (ev.isError ? ", error" : "")
            let el = TimelineAXElement.make(role: .button, label: label, rect: NSRect(x: 0, y: CGFloat(i) * rh, width: vis.maxX, height: rh),
                                            in: self, parent: self) { [weak self] in self?.controller.select(row: i, reveal: false) }
            el.setAccessibilitySelected(i == controller.selectedIndex)
            out.append(el)
        }
        axCache = out
        return out
    }
}

extension FlowDiagramView {
    /// A label, led by the failed mark (an SF Symbol, DESIGN.md §6.3) when the message failed.
    static func label(_ text: String, in rect: NSRect, font: NSFont, color: NSColor, failed: Bool) {
        var r = rect
        if failed {
            let image = TimelineDrawing.symbol(Mark.failed.symbol, size: font.pointSize - 1, color: Theme.err, colorKey: "err", weight: .semibold)
            TimelineDrawing.draw(image, centeredIn: NSRect(x: r.minX, y: r.minY, width: font.pointSize, height: r.height))
            r.origin.x += font.pointSize + 3
            r.size.width -= font.pointSize + 3
        }
        TimelineDrawing.text(text, in: r, font: font, color: color)
    }
}
