import AppKit
import SwiftUI

/// What the track draws: the result's lanes as the view's options show them.
struct TrackInput {
    let content: CriticalPathContent
    /// Identifies the result, so an update with the same result keeps the zoom.
    let key: String
    let showsAllLanes: Bool
    let mergeBelowUs: Int64?
    let classFilter: PathClass?
    let target: PerfTarget?

    /// Lanes shown before the "n more sessions" row (§4.8).
    static let maxLanes = 6

    var rows: [TrackRow] { TrackRow.rows(content.lanes, showsAll: showsAllLanes) }
}

/// A row of the track below its axis: a session's lane, or the "n more sessions" disclosure row, which draws the hidden
/// lanes' segments together while it is closed so the path stays whole.
enum TrackRow: Hashable {
    case lane(PathLane)
    case more(hidden: [PathLane], open: Bool)

    /// Up to six lanes, then the disclosure row and, when it is open, the rest.
    static func rows(_ lanes: [PathLane], showsAll: Bool) -> [TrackRow] {
        guard lanes.count > TrackInput.maxLanes else { return lanes.map(TrackRow.lane) }
        let hidden = Array(lanes[TrackInput.maxLanes...])
        return lanes.prefix(TrackInput.maxLanes).map(TrackRow.lane) + [.more(hidden: hidden, open: showsAll)] + (showsAll ? hidden.map(TrackRow.lane) : [])
    }

    /// The segments the row draws, in time order.
    var segments: [Int] {
        switch self {
        case .lane(let l): return l.segments
        case .more(let hidden, let open): return open ? [] : hidden.flatMap(\.segments).sorted()
        }
    }

    /// "3 more sessions".
    static func moreTitle(_ n: Int) -> String { Formatters.count(n, "more session", plural: "more sessions") }
}

/// The track's height for `rows`: the axis, one 18 pt row each, and a little room below.
@MainActor func criticalPathTrackHeight(rows: Int) -> CGFloat {
    CriticalPathTrackView.axisHeight + CGFloat(rows) * CriticalPathTrackView.rowHeight + CriticalPathTrackView.bottomPad
}

/// The path track (ANALYSIS-UX §4.8) in the SwiftUI layout.
struct CriticalPathTrack: NSViewRepresentable {
    let cp: CriticalPathModel
    let input: TrackInput

    func makeNSView(context: Context) -> CriticalPathTrackView {
        let view = CriticalPathTrackView(cp: cp)
        // Registering changes the header's state, which must not change inside this view update.
        DispatchQueue.main.async { [weak view] in if let view { cp.attach(view) } }
        return view
    }

    func updateNSView(_ view: CriticalPathTrackView, context: Context) {
        view.input = input
    }

    static func dismantleNSView(_ view: CriticalPathTrackView, coordinator: ()) {
        let cp = view.cp
        DispatchQueue.main.async { cp?.detach(view) }
    }
}

/// The critical path in the style of the Timeline track (MAC-SPEC §6): a label gutter, clock ticks under the evidence
/// line's "Times +08:00", one 18 pt lane per session on the path with its segments in their class colors, derived time
/// hatched, and each subagent's full span faint behind its lane. Segments too narrow to draw apart merge into a neutral
/// sliver. Every drawn mark has a tooltip, a click, a context menu and an accessibility element.
final class CriticalPathTrackView: NSView, NSViewToolTipOwner {
    weak var cp: CriticalPathModel?

    static let gutter: CGFloat = 240
    static let axisHeight: CGFloat = 22
    static let rowHeight: CGFloat = 18
    static let barHeight: CGFloat = 12
    static let bottomPad: CGFloat = 6
    /// Room after the plot, so the last tick label and the path's end are not on the edge.
    static let trailingPad: CGFloat = 16
    /// Zoom In and Zoom Out step by this factor, as the Timeline's do.
    static let zoomStep = 1.6

    var input: TrackInput? {
        didSet {
            if oldValue?.key != input?.key { didChangeResult() }
            relayout()
        }
    }

    /// A drawn mark: a segment or sliver of a row, a subagent's span, or the band past the segment cap.
    struct Mark {
        enum Kind: Equatable {
            case segments(LaneMark)
            case span(Int)
            case capBand
        }
        let kind: Kind
        /// The row in `rows`; -1 for the band, which spans every row.
        let row: Int
        let rect: CGRect
    }

    private var rows: [TrackRow] = []
    private(set) var marks: [Mark] = []
    private var hover: Int?
    /// The selection last brought into view; a pan away from it stays put.
    private var revealed: PerfTarget?
    private var axCache: [NSAccessibilityElement]?

    init(cp: CriticalPathModel) {
        self.cp = cp
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 120))
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        // A view draws past its bounds unless it clips (macOS 14), and a dirty rect can reach past them.
        clipsToBounds = true
        focusRingType = .exterior
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    private var content: CriticalPathContent? { input?.content }
    private var path: PerfResult.CriticalPath? { content?.path }
    private var plotWidth: CGFloat { max(40, bounds.width - Self.gutter - Self.trailingPad) }
    private var backing: CGFloat { window?.backingScaleFactor ?? 2 }

    // MARK: Viewport

    private var extent: (lo: Double, hi: Double)? {
        guard let a = path?.startTs, let b = path?.endTs else { return nil }
        return (Double(a), Double(max(b, a + 1000)))
    }

    private var fitViewport: TimeViewport? {
        guard let e = extent else { return nil }
        return TimeScale.fit(from: e.lo, to: e.hi, width: Double(plotWidth), pad: 4)
    }

    private var viewport: TimeViewport? {
        get { cp?.viewport ?? fitViewport }
        set { cp?.viewport = newValue }
    }

    var scale: TimeScale? { viewport.map { TimeScale($0) } }

    private func didChangeResult() {
        hover = nil
        if cp?.fitted ?? true { viewport = nil }
    }

    func zoom(_ z: CriticalPathWorkspace.Zoom) {
        switch z {
        case .fit:
            cp?.fitted = true
            viewport = nil
        case .in: zoom(around: Double(plotWidth) / 2, factor: Self.zoomStep)
        case .out: zoom(around: Double(plotWidth) / 2, factor: 1 / Self.zoomStep)
        }
        relayout()
    }

    /// Zoom around `x` in the plot; the fitted view is the widest, since the path is the whole extent.
    private func zoom(around x: Double, factor: Double) {
        guard let v = viewport, let fit = fitViewport else { return }
        let next = TimeScale.zoom(v, around: x, factor: factor, minK: fit.k)
        cp?.fitted = next.k <= fit.k * 1.0001
        viewport = cp?.fitted == true ? nil : TimeScale.keepInView(next, extent: extent, width: Double(plotWidth))
    }

    private func pan(by dx: Double) {
        guard let v = viewport, cp?.fitted == false else { return }
        viewport = TimeScale.keepInView(TimeScale.pan(v, by: dx), extent: extent, width: Double(plotWidth))
        relayout()
    }

    /// Bring a selected stretch into view when it lies outside the visible time.
    private func reveal(_ range: ClosedRange<Int64>) {
        guard let s = scale, cp?.fitted == false else { return }
        let a = s.x(Double(range.lowerBound)), b = s.x(Double(range.upperBound))
        guard b < 0 || a > Double(plotWidth) else { return }
        viewport = TimeScale.place(Double(range.lowerBound), at: Double(plotWidth) / 3, k: s.k)
    }

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = newSize.width != frame.width
        super.setFrameSize(newSize)
        if widthChanged { relayout() }
    }

    // MARK: Layout

    private func rowY(_ row: Int) -> CGFloat { Self.axisHeight + CGFloat(row) * Self.rowHeight }

    private func relayout() {
        if let input, input.target != revealed {
            revealed = input.target
            if let t = input.target, let range = t.range, !t.segments.isEmpty || t.delegation != nil { reveal(range) }
        }
        guard let input, let s = scale else {
            rows = []
            marks = []
            needsDisplay = true
            return
        }
        rows = input.rows
        let segs = input.content.path.segments
        let x0 = Self.gutter
        func x(_ t: Int64) -> Double { s.x(Double(t)) }
        var out: [Mark] = []
        // Subagent spans first: they draw behind the segments and lose hit tests to them.
        for (r, row) in rows.enumerated() {
            guard case .lane(let lane) = row, let d = lane.delegation, let del = input.content.result.collaboration.delegations[safe: d] else { continue }
            let end = del.end ?? input.content.path.endTs ?? del.start
            let a = x(del.start), b = max(x(end), a + LaneMark.minWidth)
            out.append(Mark(kind: .span(d), row: r, rect: CGRect(x: x0 + a, y: rowY(r) + (Self.rowHeight - Self.barHeight) / 2, width: b - a,
                                                                 height: Self.barHeight)))
        }
        for (r, row) in rows.enumerated() {
            for m in LaneMark.marks(row.segments, of: segs, x: x, mergeBelowUs: input.mergeBelowUs) {
                let y = rowY(r) + (Self.rowHeight - Self.barHeight) / 2
                out.append(Mark(kind: .segments(m), row: r, rect: CGRect(x: x0 + m.x0, y: y, width: m.x1 - m.x0, height: Self.barHeight)))
            }
        }
        if let stretch = input.content.notReturned {
            let a = x(stretch.lowerBound), b = max(x(stretch.upperBound), a + LaneMark.minWidth)
            out.append(Mark(kind: .capBand, row: -1, rect: CGRect(x: x0 + a, y: Self.axisHeight, width: b - a, height: CGFloat(rows.count) * Self.rowHeight)))
        }
        // Only what the plot shows is a mark: off-screen marks take no tooltip, click or accessibility element.
        let plot = CGRect(x: x0, y: 0, width: plotWidth, height: bounds.height)
        marks = out.filter { $0.rect.intersects(plot) }
        if hover.map({ $0 >= marks.count }) ?? false { hover = nil }
        axCache = nil
        scheduleToolTips()
        needsDisplay = true
    }

    // MARK: Drawing

    override func draw(_ dirty: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        NSColor.controlBackgroundColor.setFill()
        dirty.intersection(bounds).fill()
        guard let input, let s = scale else { return }
        let x0 = Self.gutter, bs = backing
        let plot = CGRect(x: x0, y: 0, width: plotWidth, height: bounds.height)
        let lanesBottom = rowY(rows.count)

        // Axis: clock ticks with faint guides through the lanes.
        let axis = TimeTicks.axis(s, width: Double(plotWidth), zone: Formatters.timeZone)
        ctx.saveGState()
        ctx.clip(to: plot)
        NSColor.separatorColor.withAlphaComponent(0.35).setFill()
        for tk in axis.ticks {
            NSRect(x: TimelineDrawing.snap(x0 + CGFloat(tk.x), bs), y: Self.axisHeight, width: 1 / bs, height: lanesBottom - Self.axisHeight).fill()
        }
        ctx.restoreGState()
        TimelineDrawing.ruler(ctx, axis: axis, scale: s, x0: x0, y: 0, width: plotWidth, height: Self.axisHeight, backingScale: bs)
        let day = Self.day(max(s.t(0), Double(path?.startTs ?? 0)))
        TimelineDrawing.text(day, in: NSRect(x: 12, y: 2, width: Self.gutter - 90, height: Self.axisHeight - 4), font: TimelineDrawing.captionFont,
                             color: .secondaryLabelColor)
        TimelineDrawing.text("On path", in: NSRect(x: Self.gutter - 84, y: 2, width: 72, height: Self.axisHeight - 4), font: TimelineDrawing.captionFont,
                             color: .secondaryLabelColor, alignment: .right)
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: Self.axisHeight - 1 / bs, width: bounds.width, height: 1 / bs).fill()
        NSRect(x: Self.gutter - 1 / bs, y: Self.axisHeight, width: 1 / bs, height: lanesBottom - Self.axisHeight).fill()

        for (r, row) in rows.enumerated() { drawGutter(row, at: rowY(r)) }

        let target = input.target
        let dimmed = { (indexes: [Int]) -> Bool in
            guard let c = input.classFilter else { return false }
            return !indexes.contains { i in self.matches(input.content.path.segments[i], c) }
        }
        ctx.saveGState()
        ctx.clip(to: plot)
        // The band first, so a last segment's 1 pt minimum that reaches into it draws over it.
        for m in marks where m.kind == .capBand { drawCapBand(m.rect, content: input.content) }
        for (i, m) in marks.enumerated() {
            switch m.kind {
            case .span:
                drawSpan(m.rect, dim: input.classFilter != nil)
            case .segments(let lm):
                drawSegments(lm, rect: m.rect, ctx: ctx, dim: dimmed(lm.segments))
            case .capBand:
                break
            }
            if i == hover { stroke(m.rect.insetBy(dx: -0.5, dy: -0.5), color: NSColor.labelColor.withAlphaComponent(0.55), width: 1, ctx: ctx) }
        }
        // The selection outline last, so no neighbour covers it. A mark a few points wide also gets the Timeline's
        // selection marker through the axis, so it is found at a glance.
        for m in marks where isSelected(m, target) {
            stroke(m.rect.insetBy(dx: -1, dy: -1), color: .controlAccentColor, width: 2, ctx: ctx)
        }
        ctx.restoreGState()
        if let m = marks.first(where: { isSelected($0, target) }), case .segments = m.kind, m.rect.width < 8 {
            TimelineDrawing.marker(ctx, x: m.rect.midX, y0: Self.axisHeight - 7, height: m.rect.minY - Self.axisHeight + 6, cap: true)
        }
    }

    /// The lane labels' header: the day the view starts on, "Tue Oct 20 2026", in the Timeline's words. It is the same
    /// at every zoom and width (the axis context drops to the year once ticks step by days); the ticks add a short date
    /// where the day changes.
    static func day(_ t: Double) -> String {
        let hourly = TimeTicks.Step(us: TimeTicks.h, unit: .h, n: 1)
        return TimeTicks.context(t, step: hourly, zone: Formatters.timeZone).components(separatedBy: " · ").first ?? ""
    }

    private func matches(_ s: PerfResult.PathSegment, _ c: PathClass) -> Bool {
        s.class == c || s.mixedParts.contains { $0.class == c }
    }

    private func isSelected(_ m: Mark, _ t: PerfTarget?) -> Bool {
        guard let t else { return false }
        switch m.kind {
        case .segments(let lm): return lm.segments.contains { t.segments.contains($0) }
        case .span(let d): return t.delegation == d
        case .capBand: return false
        }
    }

    private func drawGutter(_ row: TrackRow, at y: CGFloat) {
        let rect = NSRect(x: 12, y: y, width: Self.gutter - 24, height: Self.rowHeight)
        let font = NSFont.systemFont(ofSize: 11)
        let figures = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        switch row {
        case .lane(let lane):
            let time = lane.onPath
            let tw = TimelineDrawing.width(time, font: figures)
            TimelineDrawing.text(lane.gutterName, in: NSRect(x: rect.minX, y: y, width: rect.width - tw - 10, height: rect.height), font: font,
                                 color: .labelColor)
            TimelineDrawing.text(time, in: NSRect(x: rect.maxX - tw - 1, y: y, width: tw + 1, height: rect.height), font: figures,
                                 color: .secondaryLabelColor, alignment: .right)
        case .more(let hidden, let open):
            let chevron = TimelineDrawing.symbol(open ? "chevron.down" : "chevron.right", size: 9, color: .secondaryLabelColor,
                                                 colorKey: "secondary", weight: .semibold)
            TimelineDrawing.draw(chevron, centeredIn: NSRect(x: rect.minX, y: y, width: 10, height: rect.height))
            TimelineDrawing.text(TrackRow.moreTitle(hidden.count), in: NSRect(x: rect.minX + 14, y: y, width: rect.width - 14, height: rect.height),
                                 font: font, color: .secondaryLabelColor)
        }
    }

    private func drawSegments(_ lm: LaneMark, rect: CGRect, ctx: CGContext, dim: Bool) {
        guard let segs = path?.segments else { return }
        let alpha: CGFloat = dim ? 0.22 : 1
        // Snap the origin to a device pixel, then keep the mark's 1 pt minimum (LaneMark.minWidth).
        let x = TimelineDrawing.snap(rect.minX, backing)
        let r = CGRect(x: x, y: rect.minY, width: max(LaneMark.minWidth, TimelineDrawing.snap(rect.maxX, backing) - x), height: rect.height)
        if lm.isSliver {
            PathMarkStyle.mixed.withAlphaComponent(PathMarkStyle.mixed.alphaComponent * alpha).setFill()
            r.fill()
            return
        }
        let s = segs[lm.segments[0]]
        let color = PathMarkStyle.color(s.class)
        ctx.saveGState()
        ctx.setAlpha(alpha)
        color.withAlphaComponent(color.alphaComponent * PathMarkStyle.opacity(s.class)).setFill()
        r.fill()
        if CriticalPathContent.isDerived(s) { hatch(r, ctx: ctx) }
        NSColor.separatorColor.setFill()
        if PathMarkStyle.isNeutral(s.class) {
            // Idle and unattributed time are outlined, so neither reads as empty lane.
            r.frame(withWidth: min(1, r.width / 2))
        } else if r.width > 4 {
            // A hairline between neighbours, so two segments of one class still read as two.
            NSRect(x: r.minX, y: r.minY, width: 1 / backing, height: r.height).fill()
        }
        ctx.restoreGState()
    }

    /// Derived time (§5.2 item 5): the Steps time bar's hatching, diagonal lines 4 pt apart.
    private func hatch(_ r: CGRect, ctx: CGContext) {
        ctx.saveGState()
        ctx.clip(to: r)
        ctx.setStrokeColor(NSColor.labelColor.withAlphaComponent(0.35).cgColor)
        ctx.setLineWidth(1.2)
        var x = (r.minX / 4).rounded(.down) * 4 - r.height
        while x < r.maxX {
            ctx.move(to: CGPoint(x: x, y: r.maxY))
            ctx.addLine(to: CGPoint(x: x + r.height, y: r.minY))
            x += 4
        }
        ctx.strokePath()
        ctx.restoreGState()
    }

    /// A subagent's full span (§4.8): a plain wash, 15% of the secondary label colour, as tall as the segments that draw
    /// over it and never outlined, so it ranks below every segment; hover and selection outline it like any mark.
    private func drawSpan(_ rect: CGRect, dim: Bool) {
        let base = NSColor.secondaryLabelColor
        base.withAlphaComponent(base.alphaComponent * (dim ? 0.08 : 0.15)).setFill()
        rect.fill()
    }

    /// The stretch no returned segment covers: a faint neutral wash, never hatched, because hatching means derived time
    /// (§4.8). The tick guides run through it, so the axis still reads as the path's, only not drawn. Its words sit on
    /// one line in the Main lane at the band's leading edge, whatever the lanes, so they never read as a lower lane's
    /// content: the sentence where it fits, else the short form (`capLabel`); the tooltip and the Segments footer keep
    /// the sentence.
    private func drawCapBand(_ rect: CGRect, content: CriticalPathContent) {
        NSColor.secondaryLabelColor.withAlphaComponent(0.05).setFill()
        rect.fill(using: .sourceOver)
        NSColor.separatorColor.setFill()
        NSRect(x: TimelineDrawing.snap(rect.minX, backing), y: rect.minY, width: 1, height: rect.height).fill()
        guard rect.width > 48 else { return }
        let main = rows.firstIndex { if case .lane(let l) = $0 { return l.isRoot } else { return false } } ?? 0
        let label = Self.capLabel(content, width: Self.capWidth(rect))
        let words = NSRect(x: rect.minX + 8, y: rowY(main), width: Self.capWidth(rect), height: Self.rowHeight)
        // No guide runs through the words: they sit on the wash over the background, 4 pt of it on each side.
        let behind = NSRect(x: words.minX - 4, y: words.minY + 2, width: min(words.width, TimelineDrawing.width(label, font: TimelineDrawing.captionFont)) + 8,
                            height: words.height - 4)
        NSColor.controlBackgroundColor.setFill()
        behind.fill()
        NSColor.secondaryLabelColor.withAlphaComponent(0.05).setFill()
        behind.fill(using: .sourceOver)
        TimelineDrawing.text(label, in: words, font: TimelineDrawing.captionFont, color: .secondaryLabelColor)
    }

    /// The room for the band's words: 8 pt in from each side.
    static func capWidth(_ band: CGRect) -> CGFloat { band.width - 16 }

    /// The cap's sentence when it fits on one line of `width`; else its short form, cut at its tail if even that does
    /// not fit, so the band never cuts the sentence mid-word.
    static func capLabel(_ content: CriticalPathContent, width: CGFloat) -> String {
        guard let sentence = content.segmentCap else { return "" }
        return TimelineDrawing.width(sentence, font: TimelineDrawing.captionFont) <= width ? sentence : content.segmentCapShort ?? sentence
    }

    private func stroke(_ rect: CGRect, color: NSColor, width: CGFloat, ctx: CGContext) {
        ctx.saveGState()
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(width)
        ctx.stroke(rect)
        ctx.restoreGState()
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(rect: bounds.insetBy(dx: 1, dy: 1)).fill() }

    override func becomeFirstResponder() -> Bool {
        noteFocusRingMaskChanged()
        return true
    }

    // MARK: Hit testing

    /// The mark under `p`: a segment or sliver before the span behind it. A narrow mark takes clicks a little past its
    /// edges, so a 1 pt sliver is still easy to hit.
    func markIndex(at p: NSPoint) -> Int? {
        var best: (index: Int, distance: CGFloat)?
        for (i, m) in marks.enumerated().reversed() {
            if case .span = m.kind { continue }
            let slop = max(0, (5 - m.rect.width) / 2)
            let r = m.rect.insetBy(dx: -slop, dy: 0)
            guard r.minY <= p.y, p.y <= r.maxY, r.minX <= p.x, p.x <= r.maxX else { continue }
            let d = abs(m.rect.midX - p.x)
            if best == nil || d < best!.distance { best = (i, d) }
        }
        if let best { return best.index }
        return marks.indices.first { if case .span = marks[$0].kind { return marks[$0].rect.contains(p) } else { return false } }
    }

    private func row(at p: NSPoint) -> Int? {
        guard p.y >= Self.axisHeight else { return nil }
        let r = Int((p.y - Self.axisHeight) / Self.rowHeight)
        return rows.indices.contains(r) ? r : nil
    }

    /// The selection a mark stands for: a sliver selects its first segment that has evidence.
    private func selection(for m: Mark) -> PerfSelection? {
        switch m.kind {
        case .segments(let lm):
            let segs = path?.segments ?? []
            return .segment(lm.segments.first { !(segs[safe: $0]?.evidence.isEmpty ?? true) } ?? lm.segments[0])
        case .span(let d): return .delegation(d)
        case .capBand: return nil
        }
    }

    // MARK: Mouse

    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(t)
        tracking = t
    }

    override func mouseMoved(with e: NSEvent) {
        let p = convert(e.locationInWindow, from: nil)
        let i = p.x >= Self.gutter ? markIndex(at: p) : nil
        if i != hover {
            hover = i
            needsDisplay = true
        }
        let moreRow = row(at: p).map { if case .more = rows[$0] { return true } else { return false } } ?? false
        (moreRow && p.x < Self.gutter ? NSCursor.pointingHand : NSCursor.arrow).set()
    }

    override func mouseExited(with e: NSEvent) {
        hover = nil
        needsDisplay = true
    }

    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        guard let cp, let content else { return }
        let p = convert(e.locationInWindow, from: nil)
        if let r = row(at: p), case .more = rows[r], p.x < Self.gutter {
            cp.showsAllLanes.toggle()
            return
        }
        guard p.x >= Self.gutter else { return }
        guard let i = markIndex(at: p), let s = selection(for: marks[i]) else {
            if p.y >= Self.axisHeight { cp.select(nil, in: content) }
            return
        }
        cp.select(s, in: content)
        if e.clickCount == 2 {
            let t = content.target(s)
            if t?.evidence != nil { cp.showInSession(t) } else if case .delegation = s { cp.openSubagent(t?.subagent) }
        }
    }

    override func scrollWheel(with e: NSEvent) {
        let precise = e.hasPreciseScrollingDeltas
        let dx = e.scrollingDeltaX * (precise ? 1 : 10), dy = e.scrollingDeltaY * (precise ? 1 : 10)
        let x = Double(convert(e.locationInWindow, from: nil).x - Self.gutter)
        if e.modifierFlags.contains(.command) {
            zoom(around: x, factor: exp(Double(abs(dy) >= abs(dx) ? dy : dx) * 0.01))
            relayout()
        } else if abs(dx) > abs(dy) {
            pan(by: Double(-dx))
        } else {
            super.scrollWheel(with: e)
        }
    }

    override func magnify(with e: NSEvent) {
        zoom(around: Double(convert(e.locationInWindow, from: nil).x - Self.gutter), factor: max(0.2, 1 + Double(e.magnification)))
        relayout()
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        window?.makeFirstResponder(self)
        guard let cp, let content else { return nil }
        let p = convert(event.locationInWindow, from: nil)
        if p.x < Self.gutter, let r = row(at: p), case .lane(let lane) = rows[r], !lane.isRoot {
            let m = NSMenu()
            m.addItem(TimelineMenuItem("Open Subagent") { cp.openSubagent(lane.session) })
            return m
        }
        guard let i = markIndex(at: p), let s = selection(for: marks[i]) else { return nil }
        cp.select(s, in: content)
        return Self.menu(for: content.target(s), cp: cp)
    }

    /// The context menu of a mark or a table row (§4.10): Show in Events, Show in Session, Show in Timeline, then Open
    /// Subagent and Copy Event ID. An action the selection cannot take is disabled.
    static func menu(for t: PerfTarget?, cp: CriticalPathModel) -> NSMenu {
        let m = NSMenu()
        m.autoenablesItems = false
        func add(_ title: String, _ enabled: Bool, key: String = "", _ action: @escaping () -> Void) {
            let item = TimelineMenuItem(title, action)
            item.isEnabled = enabled
            if !key.isEmpty {
                item.keyEquivalent = key
                item.keyEquivalentModifierMask = .command
            }
            m.addItem(item)
        }
        let event = t?.evidence != nil
        add("Show in Events", event) { cp.showInEvents(t) }
        add("Show in Session", event, key: "\r") { cp.showInSession(t) }
        add("Show in Timeline", t?.range != nil || event) { cp.showInTimeline(t) }
        m.addItem(.separator())
        if t?.subagent != nil { add("Open Subagent", true) { cp.openSubagent(t?.subagent) } }
        add("Copy Event ID", event) { cp.copyEventID(t) }
        return m
    }

    // MARK: Keyboard

    override func keyDown(with e: NSEvent) {
        guard let cp, let content else { return super.keyDown(with: e) }
        let segs = content.path.segments
        let current: Int? = { if case .segment(let i)? = cp.selection { return i } else { return nil } }()
        switch e.specialKey {
        case .leftArrow?, .rightArrow?:
            guard !segs.isEmpty else { return NSSound.beep() }
            let forward = e.specialKey == .rightArrow
            let next = current.map { forward ? min(segs.count - 1, $0 + 1) : max(0, $0 - 1) } ?? (forward ? 0 : segs.count - 1)
            cp.select(.segment(next), in: content)
        case .upArrow?, .downArrow?:
            moveLane(by: e.specialKey == .upArrow ? -1 : 1, from: current, in: content)
        case .carriageReturn?, .enter?:
            if e.modifierFlags.contains(.command) { cp.showInSession(cp.target(in: content)) } else { super.keyDown(with: e) }
        default:
            switch e.charactersIgnoringModifiers {
            case "-": zoom(.out)
            case "+", "=": zoom(.in)
            case "0": zoom(.fit)
            default: super.keyDown(with: e)
            }
        }
    }

    /// ↑ and ↓: the segment of the lane above or below nearest in time to the selected one.
    private func moveLane(by delta: Int, from current: Int?, in content: CriticalPathContent) {
        guard let cp else { return }
        let segs = content.path.segments
        let rowOf = { (i: Int) -> Int? in self.rows.firstIndex { $0.segments.contains(i) } }
        let fromRow = current.flatMap(rowOf) ?? (delta > 0 ? -1 : rows.count)
        var r = fromRow + delta
        while rows.indices.contains(r), rows[r].segments.isEmpty { r += delta }
        guard rows.indices.contains(r) else { return NSSound.beep() }
        let mid = current.map { Double(segs[$0].start) / 2 + Double(segs[$0].end) / 2 } ?? Double(content.path.startTs ?? 0)
        let best = rows[r].segments.min { abs(Double(segs[$0].start) / 2 + Double(segs[$0].end) / 2 - mid) < abs(Double(segs[$1].start) / 2 + Double(segs[$1].end) / 2 - mid) }
        if let best { cp.select(.segment(best), in: content) }
    }

    // MARK: Tooltips

    /// The rects the tooltips are registered for: one per drawn mark, then one per row's label.
    private var tipRects: [CGRect] = []
    private var tipsPending: DispatchWorkItem?

    /// A pan or zoom lays the track out on every scroll and magnify tick, and registering a tooltip for each of up to a
    /// thousand visible marks is most of a tick's cost. So the tooltips follow the marks once the gesture rests, and only
    /// when the marks moved; a tooltip shown before that still names the mark under the pointer, since the text is
    /// asked for by point.
    private func scheduleToolTips() {
        tipsPending?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.rebuildToolTips() }
        tipsPending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    private func rebuildToolTips() {
        tipsPending = nil
        let rects = marks.map { $0.rect.insetBy(dx: min(0, ($0.rect.width - 5) / 2), dy: 0) }
            + rows.indices.map { NSRect(x: 0, y: rowY($0), width: Self.gutter, height: Self.rowHeight) }
        guard rects != tipRects else { return }
        tipRects = rects
        removeAllToolTips()
        for r in rects { addToolTip(r, owner: self, userData: nil) }
    }

    func view(_ view: NSView, stringForToolTip tag: NSView.ToolTipTag, point: NSPoint, userData data: UnsafeMutableRawPointer?) -> String {
        if point.x < Self.gutter, let r = row(at: point) { return gutterHelp(rows[r]) }
        guard let i = markIndex(at: point) else { return "" }
        return help(for: marks[i])
    }

    private func gutterHelp(_ row: TrackRow) -> String {
        switch row {
        case .lane(let lane): return lane.help + (lane.onPathHelp.isEmpty ? "" : "\n" + lane.onPathHelp)
        case .more(let hidden, let open):
            return open ? "Hide the sessions with less time on the path" : "Show the \(Formatters.count(hidden.count, "session")) with less time on the path; "
                + "their segments draw on this row while it is closed"
        }
    }

    /// A mark's hover text (§4.8), at most three lines: what and how long, when, and what it did.
    func help(for m: Mark) -> String {
        guard let content else { return "" }
        let segs = content.path.segments
        let first = content.path.startTs
        switch m.kind {
        case .segments(let lm) where lm.isSliver:
            let a = segs[lm.segments[0]], b = segs[lm.segments[lm.segments.count - 1]]
            let parts = lm.segments.prefix(5).map { PathMarkStyle.name(segs[$0].class) + " " + CriticalPathContent.durationText(segs[$0]) }
            return [Formatters.count(lm.segments.count, "short segment") + " · " + content.names.lane(a.sessionId),
                    Self.range(a.start, b.end, first: first),
                    parts.joined(separator: " · ") + (lm.segments.count > 5 ? " · +\(Formatters.count(lm.segments.count - 5)) more" : "")]
                .joined(separator: "\n")
        case .segments(let lm):
            let s = segs[lm.segments[0]]
            let what = s.class == .unattributed ? CriticalPathContent.unattributedNote
                : CriticalPathContent.segmentLabel(s) ?? (s.evidence.isEmpty ? "No event marks this time" : nil)
            return [PathMarkStyle.name(s.class) + " · " + CriticalPathContent.durationText(s) + " · " + content.names.lane(s.sessionId),
                    Self.range(s.start, s.end, first: first), what].compactMap { $0 }.joined(separator: "\n")
        case .span(let d):
            guard let del = content.result.collaboration.delegations[safe: d] else { return "" }
            let task = del.taskExcerpt.map { "Task: " + $0.replacingOccurrences(of: "\n", with: " ") }
            return [content.names.lane(del.child) + ": its full span, faint; the path runs through it for " + Formatters.duration(del.onPathUs),
                    del.end.map { Self.range(del.start, $0, first: first) } ?? Formatters.timestamp(del.start, digits: 3) + " → no end logged", task]
                .compactMap { $0 }.joined(separator: "\n")
        case .capBand:
            let range = content.notReturned.map { Self.range($0.lowerBound, $0.upperBound, first: first) }
            return [content.segmentCap, range, CriticalPathContent.segmentCapNote].compactMap { $0 }.joined(separator: "\n")
        }
    }

    /// "14:03:22.118 → 14:04:04.236 +08:00", with the short date on a day other than the path's first.
    static func range(_ a: Int64, _ b: Int64, first: Int64?) -> String {
        CriticalPathContent.listClock(a, first: first) + " → " + CriticalPathContent.listClock(b, first: first) + " " + Formatters.offsetLabel(at: a)
    }

    // MARK: Accessibility

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityLabel() -> String? { "Critical path track" }
    override func accessibilityHelp() -> String? {
        "Left and Right arrows move between segments, Up and Down between lanes; Command-Return shows the selection in Session; minus and plus zoom, and zero fits the path."
    }

    override func accessibilityChildren() -> [Any]? {
        if let axCache { return axCache }
        guard let cp, let content else { return [] }
        var out: [NSAccessibilityElement] = []
        for (r, row) in rows.enumerated() {
            let rect = NSRect(x: 0, y: rowY(r), width: Self.gutter, height: Self.rowHeight)
            switch row {
            case .lane(let lane):
                out.append(TimelineAXElement.make(role: .staticText, label: "\(lane.name), \(lane.onPath) on the path", rect: rect, in: self, parent: self,
                                                  help: lane.help))
            case .more(let hidden, let open):
                let e = TimelineAXElement.make(role: .disclosureTriangle, label: TrackRow.moreTitle(hidden.count), rect: rect, in: self, parent: self,
                                               help: gutterHelp(row)) { cp.showsAllLanes.toggle() }
                e.setAccessibilityExpanded(open)
                out.append(e)
            }
        }
        let target = cp.target(in: content)
        for m in marks {
            guard let s = selection(for: m) else {
                out.append(TimelineAXElement.make(role: .staticText, label: accessibilityLabel(for: m, content: content), rect: m.rect, in: self,
                                                  parent: self, help: help(for: m)))
                continue
            }
            let e = TimelineAXElement.make(role: .button, label: accessibilityLabel(for: m, content: content), rect: m.rect, in: self, parent: self,
                                           help: help(for: m)) { cp.select(s, in: content) }
            e.setAccessibilitySelected(isSelected(m, target))
            out.append(e)
        }
        axCache = out
        return out
    }

    /// "Model, 42.1s of the 11m 30s path, 14:03:22 to 14:04:04, Main, derived" (§4.8); a sliver counts as one mark.
    func accessibilityLabel(for m: Mark, content: CriticalPathContent) -> String {
        let segs = content.path.segments
        let wall = content.wallText
        func clock(_ us: Int64) -> String { String(Formatters.clock(us, zone: Formatters.timeZone).prefix(8)) }
        switch m.kind {
        case .segments(let lm) where lm.isSliver:
            let a = segs[lm.segments[0]], b = segs[lm.segments[lm.segments.count - 1]]
            return "\(Formatters.count(lm.segments.count, "short segment")) merged, \(clock(a.start)) to \(clock(b.end)), \(content.names.lane(a.sessionId))"
        case .segments(let lm):
            let s = segs[lm.segments[0]]
            return "\(PathMarkStyle.name(s.class)), \(Formatters.duration(s.us)) of the \(wall) path, \(clock(s.start)) to \(clock(s.end)), "
                + content.names.lane(s.sessionId) + (CriticalPathContent.isDerived(s) ? ", derived" : "")
        case .span(let d):
            guard let del = content.result.collaboration.delegations[safe: d] else { return "" }
            return "\(content.names.lane(del.child)) span, \(Formatters.duration(del.onPathUs)) on the path"
        case .capBand:
            return content.segmentCap ?? ""
        }
    }
}

fileprivate extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
