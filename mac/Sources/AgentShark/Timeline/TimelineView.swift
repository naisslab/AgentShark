import AppKit
import QuartzCore

/// The Instruments-style timeline (MAC-SPEC §6): a time ruler, the current view's density track, and session or
/// project tracks in a vertical scroll view, each with a header column. Layer-backed and drawn with Core Graphics.
///
/// Pointer: two-finger horizontal scroll pans (with momentum), vertical scroll moves between tracks, pinch or
/// ⌘-scroll zooms around the pointer, drag sets the inspection range, ⌥-drag pans, click selects, double-click
/// zooms to a span (or opens a session in the overview). Keyboard: arrows browse spans, ⌥← ⌥→ pan, Return shows
/// the span in Events, Escape zooms back.
final class TimelineView: NSView {
    let controller: TimelineController
    private(set) var ruler: TimelineRulerView!
    private(set) var densityTrack: TimelineDensityView!
    let scrollView = ShadowedScrollView()
    private(set) var canvas: TimelineCanvasView!
    let hud = TimelineHUD()
    private var link: CADisplayLink?
    private var axisCache: (key: String, axis: TimeTicks.Axis)?
    private var scrollAxisIsHorizontal: Bool?
    private var lastWheelZoom = Date.distantPast

    static let headerWidth = TimelineMetrics.headerWidth

    init(controller: TimelineController) {
        self.controller = controller
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
        wantsLayer = true
        ruler = TimelineRulerView(owner: self)
        densityTrack = TimelineDensityView(owner: self)
        canvas = TimelineCanvasView(owner: self)
        scrollView.documentView = canvas
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.horizontalScrollElasticity = .none
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .controlBackgroundColor
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(clipBoundsChanged), name: NSView.boundsDidChangeNotification,
                                               object: scrollView.contentView)
        for v in [ruler!, densityTrack!, scrollView, hud] as [NSView] { addSubview(v) }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Timeline")
        controller.view = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let w = bounds.width
        let top = TimelineMetrics.rulerHeight + TimelineMetrics.densityHeight
        ruler.frame = NSRect(x: 0, y: 0, width: w, height: TimelineMetrics.rulerHeight)
        densityTrack.frame = NSRect(x: 0, y: TimelineMetrics.rulerHeight, width: w, height: TimelineMetrics.densityHeight)
        scrollView.frame = NSRect(x: 0, y: top, width: w, height: max(0, bounds.height - top))
        canvas.updateSize()
        controller.plotWidth = Double(max(1, scrollView.contentSize.width - Self.headerWidth))
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil {
            link?.invalidate()
            link = nil
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        redrawAll()
    }

    // MARK: Called by the controller

    func viewportChanged() {
        hud.hide()
        ruler.needsDisplay = true
        densityTrack.needsDisplay = true
        canvas.setNeedsDisplay(canvas.visibleRect)
    }

    func layoutChanged() {
        hud.hide()
        canvas.updateSize()
        canvas.needsDisplay = true
        canvas.invalidateAccessibility()
    }

    func densityChanged() { densityTrack.needsDisplay = true }

    func redrawAll() {
        ruler.needsDisplay = true
        densityTrack.needsDisplay = true
        canvas.setNeedsDisplay(canvas.visibleRect)
    }

    func scrollRowToVisible(y: CGFloat, height: CGFloat) {
        canvas.scrollToVisible(NSRect(x: canvas.visibleRect.minX, y: y - 12, width: 1, height: height + 24))
    }

    func startAnimation() {
        guard link == nil else { return }
        let l = displayLink(target: self, selector: #selector(animationFrame(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func animationFrame(_ l: CADisplayLink) {
        if !controller.stepAnimation(CACurrentMediaTime()) {
            l.invalidate()
            link = nil
        }
    }

    @objc private func clipBoundsChanged(_ note: Notification) {
        hud.hide()
        canvas.noteFocusRingMaskChanged()
    }

    // MARK: Shared geometry

    var plotWidth: CGFloat { CGFloat(controller.plotWidth) }

    /// Ruler ticks for the current viewport, cached until it changes.
    var axis: TimeTicks.Axis {
        let v = controller.viewport
        let key = "\(v.t0)|\(v.k)|\(controller.plotWidth)|\(controller.activeGaps.count)|\(Formatters.timeZone.identifier)"
        if let c = axisCache, c.key == key { return c.axis }
        let a = TimeTicks.axis(controller.scale, width: controller.plotWidth, minSpacing: 90, zone: Formatters.timeZone)
        axisCache = (key, a)
        return a
    }

    // MARK: Scroll and gestures (shared by the ruler, density track and canvas)

    /// Pan, or zoom with ⌘. Returns false for vertical scrolling, which belongs to the scroll view.
    func handleScroll(_ e: NSEvent, plotX: CGFloat) -> Bool {
        hud.hide()
        let precise = e.hasPreciseScrollingDeltas
        let dx = e.scrollingDeltaX * (precise ? 1 : 10), dy = e.scrollingDeltaY * (precise ? 1 : 10)
        if e.modifierFlags.contains(.command) {
            if e.phase.contains(.began) || (e.phase.isEmpty && e.momentumPhase.isEmpty && Date().timeIntervalSince(lastWheelZoom) > 0.6) {
                controller.beginZoomGesture()
            }
            lastWheelZoom = Date()
            let delta = abs(dy) >= abs(dx) ? dy : dx
            controller.zoom(around: Double(plotX), factor: exp(Double(delta) * 0.01))
            return true
        }
        // Lock the axis for a whole gesture (including momentum), like NSScrollView.
        if e.phase.contains(.began) || e.phase.contains(.mayBegin) || (e.phase.isEmpty && e.momentumPhase.isEmpty) {
            scrollAxisIsHorizontal = nil
        }
        if scrollAxisIsHorizontal == nil {
            guard dx != 0 || dy != 0 else { return false }
            scrollAxisIsHorizontal = abs(dx) > abs(dy)
        }
        guard scrollAxisIsHorizontal == true else { return false }
        controller.pan(by: Double(-dx))
        return true
    }

    func handleMagnify(_ e: NSEvent, plotX: CGFloat) {
        hud.hide()
        if e.phase.contains(.began) { controller.beginZoomGesture() }
        controller.zoom(around: Double(plotX), factor: max(0.2, 1 + Double(e.magnification)))
    }

    /// Two-finger double-tap: zoom to the span under the pointer, or back.
    func handleSmartMagnify(at p: NSPoint) {
        if case .item(let path)? = hit(at: p), let sp = controller.layout[path].span {
            controller.zoom(to: Double(sp.start), controller.layout[path].end)
        } else if !controller.zoomBack() {
            controller.zoom(to: controller.scale.t(Double(p.x - Self.headerWidth) - 100), controller.scale.t(Double(p.x - Self.headerWidth) + 100))
        }
    }

    // MARK: Hit testing (canvas coordinates)

    func hit(at p: NSPoint) -> TimelineHit? {
        let layout = controller.layout
        guard let ti = layout.visibleTracks(top: p.y, height: 1).first, p.y >= layout.tracks[ti].y else { return nil }
        let track = layout.tracks[ti]
        if p.x < Self.headerWidth {
            let disclosureEnd = 8 + CGFloat(min(track.depth, TimelineMetrics.maxIndentLevels)) * TimelineMetrics.indent + 16
            return .header(track: ti, disclosure: track.session == nil || p.x < disclosureEnd)
        }
        let px = Double(p.x - Self.headerWidth)
        let s = controller.scale
        if let b = s.breaks(from: s.t(px - s.breakWidth - 1), to: s.t(px + 1)).first(where: { px >= $0.x && px < $0.x + s.breakWidth }) {
            return .gap(b.gap)
        }
        // Bands run along the sparkline's base (`TimelineCanvasView.drawBands`); the end glyph adds 12 pt after one.
        if let spark = track.sparkRect, let session = track.session, p.y >= spark.y + spark.h - 6, p.y <= spark.y + spark.h + 4 {
            let t = s.t(px), slack = 3 / max(1e-12, s.viewport.k)
            if let e = controller.bands[session.id]?.first(where: { Double($0.startTs) - slack <= t && Double($0.endTs) + 4 * slack >= t }) {
                return .band(track: ti, episode: e.id)
            }
        }
        if let lane = track.contextLane, p.y >= lane.y, p.y < lane.y + lane.h { return .context(track: ti, t: s.t(px)) }
        if let path = layout.hitItem(trackIndex: ti, y: p.y, x: px, scale: s) {
            // Overview: a tick at an unrecovered episode is its own target.
            if let session = layout[path].session, let list = controller.ticks[session.id] {
                let t = s.t(px), slack = 3 / max(1e-12, s.viewport.k)
                if let e = list.first(where: { abs(Double($0.startTs) - t) <= slack }) { return .band(track: ti, episode: e.id) }
            }
            return .item(path)
        }
        return .track(ti)
    }

    // MARK: Hover content

    func hudContent(for hit: TimelineHit) -> NSAttributedString? {
        let layout = controller.layout
        switch hit {
        case .item(let path):
            let it = layout[path]
            if let sp = it.span { return Self.spanTip(sp, store: controller.model.store, times: controller.turnTimes[sp.id]) }
            if let s = it.session { return Self.sessionTip(s, unrecovered: controller.ticks[s.id]?.count ?? 0) }
            if let p = it.process { return TimelineLaneDrawing.processTip(p) }
            if let d = it.delegation { return TimelineLaneDrawing.delegationTip(d, store: controller.model.store) }
            return nil
        case .gap(let g):
            return TimelineHUD.content(title: "Idle gap · \(Formatters.duration(Int64(g.length)))", rows: [
                ("From", Formatters.timestamp(Int64(g.start))), ("To", Formatters.timestamp(Int64(g.end))),
            ])
        case .header(let ti, _):
            let track = layout.tracks[ti]
            switch track.kind {
            case .session(let s, _): return Self.sessionTip(s, durSrc: track.band?.durSrc)
            case .project(let name, let n, let subs):
                return TimelineHUD.content(title: name, rows: [
                    ("Sessions", Formatters.count(n)), ("Subagents", Formatters.count(subs)),
                    ("", track.collapsed ? "Click to expand" : "Click to collapse"),
                ])
            }
        case .track:
            return nil
        case .context(let ti, let t):
            guard let id = layout.tracks[ti].session?.id, let points = controller.context[id] else { return nil }
            return TimelineContextDrawing.tip(points, at: t)
        case .band(_, let id):
            guard let e = controller.band(id: id) else { return nil }
            return TimelineHUD.content(title: (Self.isUnrecovered(e) ? "Unrecovered: " : "Recovered after \(e.nAttempts) attempts: ") + e.targetKey, rows: [
                ("Outcome", DerivedStyle.marked(DerivedStyle.outcomeWord(e.outcome.rawValue), e.outcomeSrc)),
                ("Family", e.family.rawValue), ("Attempts", Formatters.count(e.nAttempts)),
                ("Wall", e.wallUs.map { Formatters.duration($0, src: e.wallSrc?.rawValue ?? "derived") } ?? Formatters.missing),
                ("", e.loop ? "Loop · click to open the observed chain" : "Click to open the observed chain"),
            ], titleColor: Self.isUnrecovered(e) ? Theme.err : Theme.warn)
        }
    }

    static func isUnrecovered(_ e: EpisodeItem) -> Bool { TimelineController.isUnrecoveredBand(e) }

    /// "logged (task_complete.duration_ms)", "derived from timestamps", "parsed (wall-time)", "not logged".
    static func provenance(_ src: String?) -> String {
        guard let src, src != "unknown" else { return "not logged" }
        let detail = src.split(separator: ":", maxSplits: 1).dropFirst().first.map { " (\($0))" } ?? ""
        if src.hasPrefix("logged") { return "logged" + detail }
        if src.hasPrefix("derived") { return "derived from timestamps" }
        if src.hasPrefix("parsed") { return "parsed from output" + detail }
        return src
    }

    /// A span's hover content; a turn adds its time by bucket (the strip in its bar) when loaded.
    static func spanTip(_ sp: SpanRow, store: EngineStore, times: TimeBreakdown? = nil) -> NSAttributedString {
        var kind = TimelineText.spanKind(sp)
        if sp.kind == .tool, let k = TimelineLayout.toolKind(of: sp) { kind += " · \(k)" }
        let dur = sp.dur ?? sp.end.map { $0 - sp.start }
        let src = sp.dur == nil && sp.end != nil ? "derived" : sp.durSrc
        var rows: [(String, String)] = [
            ("Kind", kind),
            ("Duration", dur == nil ? "\(Formatters.missing) (not logged)" : "\(Formatters.duration(dur, src: src)) · \(provenance(src))"),
            ("Start", Formatters.timestamp(sp.start)),
        ]
        if let t = sp.attrs?["tokens"], t["input"] != nil || t["output"] != nil {
            rows.append(("Tokens", "in \(Formatters.tokens(t["input"]?.intValue)) · out \(Formatters.tokens(t["output"]?.intValue))"))
        }
        rows.append(("Status", TimelineText.status(sp.status)))
        if let m = sp.attrs?["llm"]?["model"]?.stringValue { rows.append(("Model", m)) }
        if let i = sp.attrs?["tool"]?["input_summary"]?.stringValue { rows.append(("Input", String(i.prefix(160)))) }
        if let child = sp.linkSession { rows.append(("Subagent", store.title(of: child))) }
        if let times { rows += TimelineLaneDrawing.turnStripTip(times) }
        return TimelineHUD.content(title: sp.name.isEmpty ? TimelineText.spanKind(sp) : String(sp.name.prefix(120)), rows: rows,
                                   titleColor: sp.status == .error ? Theme.err : .labelColor)
    }

    static func sessionTip(_ s: OverviewSession, unrecovered: Int = 0) -> NSAttributedString {
        var extra = [("Output tokens", Formatters.tokens(s.tokOut))]
        if unrecovered > 0 { extra.append(("Unrecovered", Formatters.count(unrecovered, "episode") + " (red ticks)")) }
        return sessionTip(title: s.title ?? TimelineText.shortID(s.id), agent: s.agent, role: s.role, project: s.project, start: s.start, end: s.end,
                          durSrc: nil, events: s.nEvents, errors: s.nErrors, extra: extra)
    }

    static func sessionTip(_ s: SessionRow, durSrc: String?) -> NSAttributedString {
        var extra: [(String, String)] = []
        if !s.models.isEmpty { extra.append(("Models", s.models.joined(separator: ", "))) }
        if s.nChildren > 0 { extra.append(("Subagents", Formatters.count(s.nChildren))) }
        return sessionTip(title: s.displayTitle, agent: s.agent, role: s.role, project: s.project, start: s.start, end: s.end, durSrc: durSrc,
                          events: s.nEvents, errors: s.nErrors, extra: extra)
    }

    private static func sessionTip(title: String, agent: AgentKind, role: String, project: String?, start: Int64?, end: Int64?, durSrc: String?,
                                   events: Int, errors: Int, extra: [(String, String)]) -> NSAttributedString {
        var rows: [(String, String)] = [("Agent", [agent.label, TimelineText.roleBadge(role)].compactMap { $0 }.joined(separator: " · "))]
        if let project { rows.append(("Project", project)) }
        if let start {
            // A session's duration spans its first and last timestamps unless the agent logged one.
            let src = durSrc ?? "derived"
            rows.append(("Start", Formatters.timestamp(start)))
            rows.append(("Duration", Formatters.duration((end ?? start) - start, src: src) + " · " + provenance(src)))
        }
        rows.append(("Events", Formatters.count(events) + (errors > 0 ? " · \(Formatters.count(errors, "error"))" : "")))
        return TimelineHUD.content(title: title, rows: rows + extra)
    }

    // MARK: Context menu

    func contextMenu(for hit: TimelineHit?) -> NSMenu {
        let m = NSMenu()
        m.autoenablesItems = false
        let c = controller
        let model = c.model
        func add(_ title: String, _ enabled: Bool = true, _ action: @escaping () -> Void) {
            let item = TimelineMenuItem(title, action)
            item.isEnabled = enabled
            m.addItem(item)
        }
        // Drill-down narrows the current filter with AND (SPEC §7.8); the six combine modes are explicit choices.
        func filterMenus(_ fragment: String, noun: String) {
            add("Narrow Filter to This \(noun)") { model.drillDown(fragment) }
            for (title, apply) in [("Apply as Filter", true), ("Prepare as Filter", false)] {
                let sub = NSMenu()
                for mode in FilterCombine.allCases {
                    sub.addItem(TimelineMenuItem(mode.title) {
                        if apply { model.applyFilter(fragment: fragment, mode: mode) } else { model.prepareFilter(fragment: fragment, mode: mode) }
                    })
                }
                let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                item.submenu = sub
                m.addItem(item)
            }
        }
        switch hit {
        case .item(let path)?:
            let it = c.layout[path]
            if let sp = it.span {
                if c.highlighted != sp.id { c.select(path) }
                add("Show in Events", sp.firstEvent != nil) { c.showInEvents() }
                add("Zoom to Span") { c.zoom(to: it.start, it.end) }
                add("Set Inspection Range to Span") { c.setInspectionRange(it.start, max(it.end, it.start + 1)) }
                m.addItem(.separator())
                filterMenus(TimelineText.filterFragment(sp), noun: sp.kind == .turn ? "Turn" : "Span")
                if let child = sp.linkSession {
                    m.addItem(.separator())
                    add("Open Child Session") { model.openSession(child, workspace: .timeline) }
                }
                m.addItem(.separator())
                add("Copy Name") { AppKitHelpers.copy(sp.name) }
                add("Copy Span ID") { AppKitHelpers.copy(sp.id) }
            } else if let s = it.session {
                c.select(path)
                sessionItems(s.id, add: add)
                m.addItem(.separator())
                filterMenus(FilterExpression.session(s.id), noun: "Session")
                m.addItem(.separator())
                add("Copy Session ID") { AppKitHelpers.copy(s.id) }
            } else if let p = it.process {
                c.select(path)
                add("Follow Process") { model.followTarget = .process(id: p.id) }
                add("Show in Events") { model.select(event: p.openEventId, reveal: true) }
                add("Zoom to Process") { c.zoom(to: it.start, it.end) }
                m.addItem(.separator())
                add("Copy Command Key") { AppKitHelpers.copy(p.procKey) }
            } else if let d = it.delegation {
                c.select(path)
                add("Follow Delegation") { model.followTarget = .delegation(spanId: d.id) }
                add("Open Observed Chain") { model.openLens(LensItem(kind: .delegation, id: d.id)) }
                if let child = d.childSession { add("Open Child Session") { model.openSession(child, workspace: .timeline) } }
                add("Zoom to Delegation") { c.zoom(to: it.start, it.end) }
            }
        case .header(let ti, _)?:
            let track = c.layout.tracks[ti]
            add(track.collapsed ? "Expand Track" : "Collapse Track") { c.toggleCollapsed(track: ti) }
            if let s = track.session {
                m.addItem(.separator())
                sessionItems(s.id, add: add)
                m.addItem(.separator())
                filterMenus(FilterExpression.session(s.id), noun: "Session")
                m.addItem(.separator())
                add("Copy Session ID") { AppKitHelpers.copy(s.id) }
            }
        case .gap(let g)?:
            add("Zoom to Idle Gap") { c.zoom(to: g.start, g.end) }
        case .context(let ti, let t)?:
            if let id = c.layout.tracks[ti].session?.id, let points = c.context[id], let i = ContextPoint.index(at: t, in: points),
               let event = points[i].eventId {
                add("Show Step \(points[i].step) in Events") { model.select(event: event, reveal: true) }
            }
            add("Hide Context Lane") { model.app.preferences.showContextLane = false }
        default:
            break
        }
        if m.numberOfItems > 0 { m.addItem(.separator()) }
        if model.inspectionRange != nil {
            add("Filter to Range") { c.filterToRange() }
            add("Clear Inspection Range") { c.clearInspectionRange() }
            m.addItem(.separator())
        }
        add("Zoom In") { c.zoomIn() }
        add("Zoom Out") { c.zoomOut() }
        add("Zoom to Fit") { c.zoomToFit() }
        add("Zoom Back", c.canZoomBack) { c.zoomBack() }
        let collapse = TimelineMenuItem("Collapse Idle Gaps") { model.app.preferences.collapseIdleGaps.toggle() }
        collapse.state = model.app.preferences.collapseIdleGaps ? .on : .off
        m.addItem(collapse)
        let lane = TimelineMenuItem("Show Context Lane") { model.app.preferences.showContextLane.toggle() }
        lane.state = model.app.preferences.showContextLane ? .on : .off
        m.addItem(lane)
        return m
    }

    private func sessionItems(_ id: String, add: (String, Bool, @escaping () -> Void) -> Void) {
        let model = controller.model
        let isScope = model.scope.sessions == [id]
        add("Open Session", !isScope) { model.openSession(id, workspace: .timeline) }
        add("Show Steps", true) { model.openSession(id, mode: .steps) }
        add("Show Transcript", true) { model.openSession(id, mode: .transcript) }
        add("Show in Flow", true) { model.openSession(id, mode: .flow) }
        add("Show Critical Path", true) { model.openSession(id, mode: .criticalPath) }
    }
}

/// A menu item that runs a closure.
final class TimelineMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, _ handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError() }

    @objc private func run() { handler() }
}
