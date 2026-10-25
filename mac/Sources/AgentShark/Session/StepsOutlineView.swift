import AppKit
import SwiftUI

/// Session · Steps (SPEC §12.7): a native `NSOutlineView` with turn rows (origin, prompt excerpt, wall time, impact,
/// claim chip, time bar) and step rows (No., time, Δ, intent, call chips, active, gap, context, tokens out, model time;
/// a narrow table drops the last two). A 12 pt gutter draws one lane per episode. → and ← expand and collapse; ⌥↑ and
/// ⌥↓ move by turn. Sorting by duration, tokens or context flattens the tree into a step list with a Turn column.
/// Steps that do not match the window's filter or time range are dimmed, never hidden.
struct StepsOutline: NSViewControllerRepresentable {
    let model: WindowModel

    func makeNSViewController(context: Context) -> StepsOutlineController { StepsOutlineController(model: model) }
    func updateNSViewController(_ controller: StepsOutlineController, context: Context) {}

    static func dismantleNSViewController(_ controller: StepsOutlineController, coordinator: ()) { controller.tearDown() }

    /// Take the space offered: measuring the table through Auto Layout would make its column widths, which the table
    /// fits to its width, part of its own size.
    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: StepsOutlineController, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 600, height: proposal.height ?? 400)
    }
}

final class TurnNode: NSObject {
    let turn: StepTurn
    var steps: [StepNode] = []
    init(_ turn: StepTurn) { self.turn = turn }
}

final class StepNode: NSObject {
    let step: StepItem
    /// Lane index per episode id drawn in the gutter of this row: (lane, isAttemptRow, continuesAbove, continuesBelow).
    var lanes: [(lane: Int, attempt: Bool, up: Bool, down: Bool)] = []
    init(_ step: StepItem) { self.step = step }
}

final class StepsNSOutline: NSOutlineView {
    weak var controller: StepsOutlineController?

    /// Step cells take their whole column: the table reads as one table, with no indentation for the turn level.
    override func frameOfCell(atColumn column: Int, row: Int) -> NSRect {
        let frame = super.frameOfCell(atColumn: column, row: row)
        guard column >= 0, column < tableColumns.count, !(item(atRow: row) is TurnNode) else { return frame }
        let col = rect(ofColumn: column)
        return NSRect(x: col.minX + intercellSpacing.width / 2, y: frame.minY, width: max(0, col.width - intercellSpacing.width), height: frame.height)
    }

    override func keyDown(with event: NSEvent) {
        let mods = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if mods == .option, event.keyCode == 126 || event.keyCode == 125 {
            controller?.moveByTurn(event.keyCode == 125 ? 1 : -1)
            return
        }
        if mods.isEmpty, event.keyCode == 36 || event.keyCode == 76 {
            controller?.activateSelection()
            return
        }
        super.keyDown(with: event)
    }
}

/// Turn rows draw a quiet band instead of the group-row style.
final class StepsRowView: NSTableRowView {
    var isTurn = false
    var dimmed = false { didSet { alphaValue = dimmed ? 0.45 : 1 } }

    override func drawBackground(in dirtyRect: NSRect) {
        if isTurn {
            // Group-style rows draw no selection of their own: a selected turn gets an accent tint that keeps its text legible.
            (isSelected ? NSColor.controlAccentColor.withAlphaComponent(isEmphasized ? 0.22 : 0.12)
                        : NSColor.windowBackgroundColor).setFill()
            bounds.fill()
            NSColor.separatorColor.setFill()
            NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
        } else {
            super.drawBackground(in: dirtyRect)
        }
    }
}

@MainActor final class StepsOutlineController: NSViewController, NSOutlineViewDataSource, NSOutlineViewDelegate, NSMenuDelegate {
    let model: WindowModel
    private let outline = StepsNSOutline()
    private let scrollView = ShadowedScrollView()
    private let contextMenu = NSMenu()
    private var turns: [TurnNode] = []
    private var loose: [StepNode] = []
    private var flat: [StepNode] = []
    private var loops: [ObservationLoop] = []
    private var generation = -1
    private var focusSerial = 0
    /// A turn to reveal once the outline holds it (the focus can arrive before the rebuild that loads it).
    private var pendingTurn: String?
    private var applying = false
    private var flatMode = false
    private var fonts = EventTableFonts(density: .compact)
    private var metrics = Theme.metrics(.compact)

    /// The columns of DESIGN.md §4.4 in display order: what the step cost (Active, Gap) before its context, output and
    /// model time. Turn shows only in a flat list.
    static let columns: [(spec: ColumnFit.Spec, title: String)] = [
        (.init(id: "gutter", min: 12, max: 12, priority: 1), ""),
        (.init(id: "no", min: 44, max: 56, priority: 1), "No."),
        (.init(id: "time", min: 96, max: 120, priority: 2), "Time"),
        (.init(id: "delta", min: 56, max: 72, priority: 4), "Δ"),
        (.init(id: "turn", min: 44, max: 56, priority: 2), "Turn"),
        (.init(id: "intent", min: 160, max: 420, priority: 1, primary: true, weight: 420), "Intent"),
        (.init(id: "calls", min: 180, max: 360, priority: 1, primary: true, weight: 360), "Calls"),
        (.init(id: "active", min: 64, max: 80, priority: 1), "Active"),
        (.init(id: "gap", min: 56, max: 72, priority: 2), "Gap"),
        (.init(id: "ctx", min: 56, max: 64, priority: 3), "Ctx"),
        (.init(id: "tokOut", min: 48, max: 64, priority: 3), "Out"),
        (.init(id: "model", min: 72, max: 88, priority: 3), "Model time"),
    ]
    /// Columns the person can hide from Options ▸ Columns (the P1 columns always show).
    static var optionalColumns: [(id: String, title: String)] {
        columns.filter { $0.spec.priority > 1 && $0.spec.id != "turn" }.map { ($0.spec.id, $0.title) }
    }
    /// Header clicks sort by these columns (StepsModel.sort keys); Active is model plus tool time, never the idle gap.
    private static let sortKeys: [String: String] = ["active": "active", "gap": "gap", "ctx": "ctx", "tokOut": "tokOut"]
    private static let headerHelp: [String: String] = [
        "time": "Clock time of the step's start (Times in the scope bar names the zone); from the time reference when one is set",
        "delta": "Time since the previous step",
        "active": "Model plus tool time: the step's own work",
        "gap": "Wall time the model and tools did not use: mostly the idle stretch before the next step. Wall time = active + gap.",
        "ctx": "Context size at the step",
        "tokOut": "Output tokens",
        "model": "Model time",
    ]

    init(model: WindowModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var steps: StepsModel { model.steps }

    override func loadView() {
        outline.controller = self
        for (c, title) in Self.columns {
            let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(c.id))
            col.title = title
            col.width = c.min
            col.minWidth = c.id == "gutter" ? c.min : 24
            col.resizingMask = c.id == "gutter" ? [] : .userResizingMask
            if c.id == "gutter" { col.maxWidth = c.max }
            col.headerToolTip = Self.headerHelp[c.id]
            if ["no", "time", "delta", "turn", "active", "gap", "ctx", "tokOut", "model"].contains(c.id) {
                col.headerCell.alignment = .right
            }
            if let key = Self.sortKeys[c.id] { col.sortDescriptorPrototype = NSSortDescriptor(key: key, ascending: false) }
            outline.addTableColumn(col)
        }
        outline.outlineTableColumn = outline.tableColumns[1]
        outline.style = .fullWidth
        outline.floatsGroupRows = false
        outline.indentationPerLevel = 0
        outline.allowsMultipleSelection = false
        outline.usesAlternatingRowBackgroundColors = false
        outline.intercellSpacing = NSSize(width: 6, height: 0)
        outline.columnAutoresizingStyle = .noColumnAutoresizing
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.doubleAction = #selector(doubleClicked)
        outline.setAccessibilityLabel("Steps")
        outline.allowsColumnReordering = false
        contextMenu.delegate = self
        contextMenu.autoenablesItems = false
        outline.menu = contextMenu
        scrollView.documentView = outline
        scrollView.hasVerticalScroller = true
        // Columns fit the visible width (§4.4): columns that do not fit hide and the header says how many.
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        view = scrollView
        scrollView.contentView.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(widthChanged), name: NSView.frameDidChangeNotification, object: scrollView.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(expansionChanged(_:)), name: NSOutlineView.itemDidExpandNotification, object: outline)
        NotificationCenter.default.addObserver(self, selector: #selector(expansionChanged(_:)), name: NSOutlineView.itemDidCollapseNotification, object: outline)
        loops.append(ObservationLoop { [weak self] in self?.followData() })
        loops.append(ObservationLoop { [weak self] in self?.followFocus() })
        loops.append(ObservationLoop { [weak self] in self?.followDisplay() })
        loops.append(ObservationLoop { [weak self] in self?.followHiddenColumns() })
    }

    func tearDown() {
        loops.forEach { $0.cancel() }
        loops.removeAll()
        NotificationCenter.default.removeObserver(self)
    }

    private var fittedWidth: CGFloat = 0

    override func viewDidLayout() {
        super.viewDidLayout()
        widthChanged()
    }

    /// Also on clip view frame changes: a pane resized by its split view does not always lay this view out again.
    @objc private func widthChanged() {
        let width = scrollView.contentView.bounds.width
        guard width > 0, abs(width - fittedWidth) > 0.5 else { return }
        fittedWidth = width
        fitColumns()
    }

    private func column(_ id: String) -> NSTableColumn? { outline.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier(id)) }

    /// Fit the columns to the width (§4.4): the Turn column only in a flat list, the person's hidden columns left out,
    /// then P4 and P3 columns hidden until Intent and Calls keep 45%; the model learns which, for the header.
    private func fitColumns() {
        let width = scrollView.contentView.bounds.width
        guard width > 0 else { return }
        let fit = Self.fit(width: width, flat: flatMode, userHidden: steps.userHiddenColumns, spacing: outline.intercellSpacing.width,
                           dated: Self.spansDays(steps.steps))
        for col in outline.tableColumns {
            let id = col.identifier.rawValue
            if let w = fit.widths[id] {
                col.isHidden = false
                if abs(col.width - w) > 0.5 { col.width = w }
            } else {
                col.isHidden = true
            }
        }
        // The table's frame follows its columns, so the turn rows (which span it) end at the visible edge.
        outline.tile()
        if outline.frame.width > width + 0.5 { outline.setFrameSize(NSSize(width: width, height: outline.frame.height)) }
        // The header reads this; a layout pass must not change what SwiftUI is updating, so it lands on the next turn.
        let hidden = fit.hidden
        DispatchQueue.main.async { [weak self] in
            if let steps = self?.steps, steps.autoHiddenColumns != hidden { steps.autoHiddenColumns = hidden }
        }
    }

    /// The column fit for a table `width` wide. A list whose steps span days gives Time its maximum, for the date
    /// prefix ("Oct 9 08:24:22").
    static func fit(width: CGFloat, flat: Bool, userHidden: Set<String>, spacing: CGFloat, dated: Bool = false) -> ColumnFit.Result {
        let specs = columns.map(\.spec).filter { (flat || $0.id != "turn") && !userHidden.contains($0.id) }
            .map { dated && $0.id == "time" ? ColumnFit.Spec(id: $0.id, min: $0.max, max: $0.max, priority: $0.priority) : $0 }
        return ColumnFit.fit(specs, width: width, spacing: spacing)
    }

    /// Whether the steps fall on more than one local day.
    static func spansDays(_ steps: [StepItem]) -> Bool {
        guard let first = steps.first?.startTs else { return false }
        return steps.contains { !Formatters.sameDay($0.startTs, first) }
    }

    /// → and ← expand and collapse turns: keep the turn row's chevron in step.
    @objc private func expansionChanged(_ note: Notification) {
        guard let t = note.userInfo?["NSObject"] as? TurnNode else { return }
        let row = outline.row(forItem: t)
        if row >= 0, let cell = outline.view(atColumn: 0, row: row, makeIfNecessary: false) as? TurnRowCell {
            cell.configure(t.turn, expanded: outline.isItemExpanded(t), analysis: model.info?.analysis)
        }
    }

    // MARK: Following the model

    private func followData() {
        let gen = steps.generation
        guard gen != generation else { return }
        generation = gen
        rebuild()
    }

    /// Options ▸ Columns changed which columns the person hides.
    private func followHiddenColumns() {
        _ = steps.userHiddenColumns
        fitColumns()
    }

    private func followDisplay() {
        let prefs = model.app.preferences
        let changed = metrics.density != prefs.rowDensity
        fonts = EventTableFonts(density: prefs.rowDensity)
        metrics = prefs.metrics
        _ = model.timeReference
        if changed { outline.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<outline.numberOfRows)) }
        outline.reloadData(forRowIndexes: IndexSet(integersIn: 0..<outline.numberOfRows), columnIndexes: IndexSet(integersIn: 0..<outline.numberOfColumns))
    }

    private func rebuild() {
        flatMode = steps.isFlat
        let byTurn = Dictionary(grouping: steps.steps, by: { $0.turnId ?? "" })
        turns = steps.turns.map { t in
            let node = TurnNode(t)
            node.steps = (byTurn[t.id] ?? []).map(StepNode.init)
            return node
        }
        let turnIDs = Set(steps.turns.map(\.id))
        loose = steps.steps.filter { !turnIDs.contains($0.turnId ?? "") }.map(StepNode.init)
        flat = flatMode ? steps.steps.map(StepNode.init) : turns.flatMap(\.steps) + loose
        assignLanes()
        // A flat list gains the Turn column (a tree loses it): fit the columns again.
        fitColumns()
        let expanded = Set(turns.filter { outline.isItemExpanded($0) }.map(\.turn.id))
        let origin = scrollView.contentView.bounds.origin
        applying = true
        let headerSort = flatMode && Self.sortKeys.values.contains(steps.sort)
        outline.sortDescriptors = headerSort ? [NSSortDescriptor(key: steps.sort, ascending: steps.ascending)] : []
        outline.reloadData()
        if !flatMode {
            for t in turns where expanded.contains(t.turn.id) || shouldExpandByDefault(t) { outline.expandItem(t) }
        }
        applying = false
        scrollView.contentView.scroll(to: origin)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        restoreSelection(scroll: false)
        revealPendingTurn()
    }

    /// Turns with failures start open; with fold-clean, clean turns stay closed.
    private func shouldExpandByDefault(_ t: TurnNode) -> Bool {
        if turns.count <= 3 { return true }
        return t.turn.impact.isProblem || t.turn.nEpisodes > 0 || t.turn.open
    }

    /// One lane per episode: first-fit over the rows the episode spans.
    private func assignLanes() {
        var spans: [String: (first: Int, last: Int)] = [:]
        for (i, n) in flat.enumerated() {
            for e in Set(n.step.episodeIds + n.step.calls.compactMap(\.episodeId)) {
                let cur = spans[e]
                spans[e] = (min(cur?.first ?? i, i), max(cur?.last ?? i, i))
            }
        }
        var laneEnd: [Int] = []
        var laneOf: [String: Int] = [:]
        for (e, s) in spans.sorted(by: { ($0.value.first, $0.key) < ($1.value.first, $1.key) }) {
            if let l = laneEnd.firstIndex(where: { $0 < s.first }) {
                laneOf[e] = l
                laneEnd[l] = s.last
            } else {
                laneOf[e] = laneEnd.count
                laneEnd.append(s.last)
            }
        }
        for (i, n) in flat.enumerated() {
            let here = Set(n.step.episodeIds + n.step.calls.compactMap(\.episodeId))
            n.lanes = spans.compactMap { e, s in
                guard i >= s.first, i <= s.last, let l = laneOf[e], l < 4 else { return nil }
                return (l, here.contains(e), i > s.first, i < s.last)
            }
        }
    }

    private func node(forStep id: String?) -> StepNode? {
        guard let id else { return nil }
        return flat.first { $0.step.id == id }
    }

    private func restoreSelection(scroll: Bool) {
        guard let n = node(forStep: steps.selectedStepID) else { return }
        applying = true
        if !flatMode, let t = turns.first(where: { $0.steps.contains(n) }), !outline.isItemExpanded(t) { outline.expandItem(t) }
        let row = outline.row(forItem: n)
        if row >= 0 {
            outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            if scroll { outline.scrollRowToVisible(row) }
        }
        applying = false
    }

    /// ⌘↩ from elsewhere: reveal and select the step.
    private func followFocus() {
        let serial = steps.focusSerial
        guard serial != focusSerial else { return }
        focusSerial = serial
        if let t = steps.revealTurnID {
            pendingTurn = t
            revealPendingTurn()
            return
        }
        guard steps.focusStepID != nil else { return }
        restoreSelection(scroll: true)
        view.window?.makeFirstResponder(outline)
    }

    /// Select and expand the pending turn row (in a flat list: the turn's first step).
    private func revealPendingTurn() {
        guard let id = pendingTurn else { return }
        let item: Any?
        if flatMode {
            item = flat.first { $0.step.turnId == id }
        } else if let t = turns.first(where: { $0.turn.id == id }) {
            applying = true
            outline.expandItem(t)
            applying = false
            item = t
        } else {
            item = nil
        }
        guard let item else { return }
        pendingTurn = nil
        let row = outline.row(forItem: item)
        guard row >= 0 else { return }
        outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        outline.scrollRowToVisible(row)
        view.window?.makeFirstResponder(outline)
    }

    // MARK: Data source

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if let t = item as? TurnNode { return t.steps.count }
        if item == nil { return flatMode ? flat.count : turns.count + loose.count }
        return 0
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if let t = item as? TurnNode { return t.steps[index] }
        if flatMode { return flat[index] }
        return index < turns.count ? turns[index] : loose[index - turns.count]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        (item as? TurnNode).map { !$0.steps.isEmpty } ?? false
    }

    func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool { item is TurnNode }

    /// A sortable header flattens the list by its column; Sort ▸ Sequence brings the turns back.
    func outlineView(_ outlineView: NSOutlineView, sortDescriptorsDidChange oldDescriptors: [NSSortDescriptor]) {
        guard !applying, let d = outlineView.sortDescriptors.first, let key = d.key else { return }
        steps.ascending = d.ascending
        steps.sort = key
    }

    func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
        item is TurnNode ? metrics.turnRow : metrics.tableRow
    }

    func outlineView(_ outlineView: NSOutlineView, rowViewForItem item: Any) -> NSTableRowView? {
        let v = StepsRowView()
        v.isTurn = item is TurnNode
        if let s = item as? StepNode { v.dimmed = s.step.match == false }
        if let t = item as? TurnNode { v.dimmed = t.turn.matchedSteps == 0 }
        return v
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        if let t = item as? TurnNode {
            guard tableColumn == nil else { return nil }
            let id = NSUserInterfaceItemIdentifier("TurnRow")
            let cell = outlineView.makeView(withIdentifier: id, owner: nil) as? TurnRowCell ?? TurnRowCell(identifier: id)
            cell.configure(t.turn, expanded: outlineView.isItemExpanded(t), analysis: model.info?.analysis)
            cell.onToggle = { [weak self, weak t] in
                guard let self, let t else { return }
                if self.outline.isItemExpanded(t) { self.outline.collapseItem(t) } else { self.outline.expandItem(t) }
            }
            cell.onBucket = { [weak self] b in self?.steps.bucket = b }
            cell.onClaim = { [weak self] in self?.model.openLens(LensItem(kind: .claim, id: t.turn.id)) }
            cell.interventions = steps.interventionsByTurn[t.turn.id] ?? []
            return cell
        }
        guard let n = item as? StepNode, let col = tableColumn?.identifier.rawValue else { return nil }
        let s = n.step
        switch col {
        case "gutter":
            let id = NSUserInterfaceItemIdentifier("StepGutter")
            let v = outlineView.makeView(withIdentifier: id, owner: nil) as? EpisodeGutterView ?? EpisodeGutterView()
            v.identifier = id
            v.lanes = n.lanes
            return v
        case "calls":
            let id = NSUserInterfaceItemIdentifier("StepCalls")
            let v = outlineView.makeView(withIdentifier: id, owner: nil) as? CallChipsView ?? CallChipsView()
            v.identifier = id
            v.calls = s.calls
            v.onClick = { [weak self] call in self?.clicked(call) }
            return v
        default:
            let id = NSUserInterfaceItemIdentifier("StepText." + col)
            let cell = outlineView.makeView(withIdentifier: id, owner: nil) as? EventTextCell ?? EventTextCell(identifier: id)
            configure(cell, column: col, step: s, index: outlineView.row(forItem: n))
            return cell
        }
    }

    private func configure(_ cell: EventTextCell, column: String, step s: StepItem, index: Int) {
        let missing = Formatters.missing
        let analysis = model.info?.analysis
        let reference = model.timeReference
        /// A number, or "—" in the faint color with the reason in its tooltip (§7.8 Missing values).
        func number(_ text: String?, reason: String, tooltip: String? = nil, color: NSColor = .labelColor) {
            cell.configure(text ?? missing, font: fonts.digits, color: text == nil ? .tertiaryLabelColor : color, alignment: .right,
                           tooltip: text == nil ? reason : tooltip)
        }
        switch column {
        case "no":
            cell.configure(Formatters.count(s.n), font: fonts.digits, color: .secondaryLabelColor, alignment: .right)
        case "time":
            if let reference {
                cell.configure(Formatters.reference(s.startTs - reference), font: fonts.digits, alignment: .right,
                               tooltip: "From the time reference\n" + Formatters.timestamp(s.startTs))
            } else {
                // Clock time; a step on another day than the first one listed carries its date (§7.9 Dates).
                let first = steps.steps.first?.startTs ?? s.startTs
                let text = Formatters.sameDay(s.startTs, first) ? Formatters.clock(s.startTs, zone: Formatters.timeZone) : Formatters.datedClock(s.startTs)
                // A dated time drops its milliseconds to fit the column; the tooltip keeps them.
                cell.configure(text, font: fonts.digits, alignment: .right, tooltip: Formatters.timestamp(s.startTs))
            }
        case "delta":
            let prev = index > 0 ? (outline.item(atRow: index - 1) as? StepNode)?.step.startTs : nil
            number(prev.map { Formatters.duration(max(0, s.startTs - $0)) }, reason: "The first step listed has no previous step.", color: .secondaryLabelColor)
        case "turn":
            cell.configure(steps.turn(s.turnId).map { "T\($0.n)" } ?? missing, font: fonts.digits, color: .secondaryLabelColor, alignment: .right)
        case "intent":
            let interventions = steps.interventionsByStep[s.id] ?? []
            let marks = interventions.map { InterventionStyle.word($0.kind) + " · " }.joined()
            cell.configure((s.compactionBefore ? "compacted · " : "") + marks + (s.intent.map { DerivedStyle.marked($0, s.intentSrc) } ?? missing), font: fonts.text,
                           color: s.intent == nil && interventions.isEmpty ? .tertiaryLabelColor : .labelColor,
                           tooltip: ((s.intent ?? "The step's intent is not logged.") + "\n" + DerivedStyle.provHelp(s.intentSrc, analysis: analysis)
                                     + (s.compactionBefore ? "\nThe context was compacted before this step." : "")
                                     + interventions.map { "\n" + InterventionStyle.help($0, analysis: analysis) }.joined()))
        case "ctx":
            number(s.ctxTokens.map { Formatters.tokens($0) }, reason: steps.gapNote(for: "ctx") ?? "Context size is not logged for this step.",
                   tooltip: s.ctxWindow.map { "Context \(Formatters.tokens(s.ctxTokens)) of \(Formatters.tokens($0)) · " + DerivedStyle.provHelp(s.ctxWindowSrc, analysis: analysis) })
        case "tokOut":
            number(s.tokOut.map { Formatters.tokens($0) }, reason: steps.gapNote(for: "tokOut") ?? "Output tokens are not logged for this step.")
        case "model":
            number(s.modelUs.map { DerivedStyle.marked(Formatters.duration($0), s.modelSrc) },
                   reason: steps.gapNote(for: "model") ?? "Model time is not logged for this step.",
                   tooltip: DerivedStyle.provHelp(s.modelSrc, analysis: analysis))
        case "active":
            number(s.activeUs.map { Formatters.duration($0) }, reason: steps.gapNote(for: "active") ?? "Neither model nor tool time is known for this step.",
                   tooltip: "Active: model \(Formatters.duration(s.modelUs, src: nil)) + tools \(Formatters.duration(s.toolUs, src: nil))"
                       + (s.durUs.map { "\nWall \(Formatters.duration($0)) = active + gap" } ?? ""))
        case "gap":
            number(s.gapUs.map { Formatters.duration($0) }, reason: steps.gapNote(for: "gap") ?? "Wall or active time is unknown for this step, so the gap is too.",
                   tooltip: "Wall time the model and tools did not use: mostly the idle stretch before the next step"
                       + (s.durUs.map { "\nWall \(Formatters.duration($0)) = active + gap" } ?? ""), color: .secondaryLabelColor)
        default:
            break
        }
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !applying else { return }
        let item = outline.item(atRow: outline.selectedRow)
        if let n = item as? StepNode {
            steps.selectedStepID = n.step.id
            let call = n.step.calls.first { $0.tier != nil } ?? n.step.calls.first
            if let call { model.select(event: call.resultEventId ?? call.eventId, reveal: false) }
        }
    }

    func outlineView(_ outlineView: NSOutlineView, shouldShowOutlineCellForItem item: Any) -> Bool { false }

    // MARK: Actions

    private func clicked(_ call: StepCall) {
        if let child = call.childSessionId, NSEvent.modifierFlags.contains(.option) {
            model.openSession(child, mode: .steps)
            return
        }
        model.select(event: call.resultEventId ?? call.eventId, reveal: NSEvent.modifierFlags.contains(.command))
    }

    @objc private func doubleClicked() {
        let row = outline.clickedRow
        guard row >= 0 else { return }
        if let t = outline.item(atRow: row) as? TurnNode {
            if outline.isItemExpanded(t) { outline.collapseItem(t) } else { outline.expandItem(t) }
            return
        }
        activateSelection()
    }

    /// Return or double-click: the step's first failing call (else its first call) in Events.
    func activateSelection() {
        guard let n = outline.item(atRow: outline.selectedRow) as? StepNode else { return }
        let call = n.step.calls.first { $0.tier != nil } ?? n.step.calls.first
        if let call { model.select(event: call.resultEventId ?? call.eventId, reveal: true) }
    }

    /// ⌥↑ / ⌥↓: the previous or next turn row.
    func moveByTurn(_ step: Int) {
        guard !flatMode, !turns.isEmpty else { return NSSound.beep() }
        let item = outline.item(atRow: outline.selectedRow)
        let current: Int? = {
            if let t = item as? TurnNode { return turns.firstIndex(of: t) }
            if let n = item as? StepNode { return turns.firstIndex { $0.steps.contains(n) } }
            return nil
        }()
        let target = current.map { $0 + step } ?? (step > 0 ? 0 : turns.count - 1)
        guard turns.indices.contains(target) else { return NSSound.beep() }
        let row = outline.row(forItem: turns[target])
        guard row >= 0 else { return }
        outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        outline.scrollRowToVisible(row)
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = outline.clickedRow
        guard row >= 0 else { return }
        let model = self.model
        if let t = outline.item(atRow: row) as? TurnNode {
            menu.addItem("Filter to This Turn", symbol: "line.3.horizontal.decrease") { model.drillDown("turn == " + FilterExpression.quote(t.turn.id)) }
            menu.addItem("Set Time Reference at Turn Start") { model.timeReference = t.turn.startTs }
            if t.turn.claim != nil {
                menu.addItem("Open Claim Check", symbol: "text.badge.checkmark") { model.openLens(LensItem(kind: .claim, id: t.turn.id)) }
            }
            for iv in steps.interventionsByTurn[t.turn.id] ?? [] where iv.stepId == nil {
                menu.addItem("Show \(InterventionStyle.word(iv.kind).capitalized) Event", symbol: InterventionStyle.symbol) { model.select(event: iv.eventId, reveal: true) }
            }
            if let basis = t.turn.impactBasis, basis.contains("#ep:") {
                menu.addItem("Open the Episode That Set the Impact") { model.openEpisode(basis) }
            }
            menu.addItem("Copy Turn ID") { AppKitHelpers.copy(t.turn.id) }
            return
        }
        guard let n = outline.item(atRow: row) as? StepNode else { return }
        let s = n.step
        if let call = s.calls.first {
            menu.addItem("Show in Events", symbol: Symbols.workspace(.events)) { model.select(event: call.eventId, reveal: true) }
            menu.addItem("Follow Tool Call", symbol: "point.topleft.down.to.point.bottomright.curvepath") {
                model.followTarget = .call(eventId: call.eventId)
            }
        }
        for e in Set(s.episodeIds + s.calls.compactMap(\.episodeId)).sorted() {
            menu.addItem("Open Episode \(TimelineText.shortID(e))", symbol: Mark.loop.symbol) { model.openEpisode(e) }
        }
        for c in s.calls where c.childSessionId != nil {
            menu.addItem("Open Child Session", symbol: "arrow.down.right.circle") { model.openSession(c.childSessionId!, mode: .steps) }
            if let p = c.processId { menu.addItem("Follow Process") { model.followTarget = .process(id: p) } }
        }
        for c in s.calls where c.processId != nil && c.childSessionId == nil {
            menu.addItem("Follow Process", symbol: "terminal") { model.followTarget = .process(id: c.processId!) }
        }
        for iv in steps.interventionsByStep[s.id] ?? [] {
            menu.addItem("Show \(InterventionStyle.word(iv.kind).capitalized) Event", symbol: InterventionStyle.symbol) { model.select(event: iv.eventId, reveal: true) }
        }
        menu.addItem(.separator())
        menu.addItem("Filter to This Step", symbol: "line.3.horizontal.decrease") { model.drillDown("step == " + FilterExpression.quote(s.id)) }
        menu.addItem("Set Time Reference Here") { model.timeReference = s.startTs }
        menu.addItem("Copy Step ID") { AppKitHelpers.copy(s.id) }
    }
}

// MARK: - Cells

/// A turn row (DESIGN.md §7.8): disclosure, "T6", the prompt excerpt (tail ellipsis), the outcome as a Plain mark and
/// word, the claim mark, the wall time on the right and a 120 pt time bar.
final class TurnRowCell: NSTableCellView {
    private let chevron = NSButton()
    private let number = NSTextField(labelWithString: "")
    private let prompt = NSTextField(labelWithString: "")
    private let impact = NSTextField(labelWithString: "")
    private let impactIcon = NSImageView()
    private let wall = NSTextField(labelWithString: "")
    private let claim = NSButton(title: "", target: nil, action: nil)
    private let bar = TimeBarView()
    var onToggle: (() -> Void)?
    /// The claim mark opens the claim check in the Lens frame.
    var onClaim: (() -> Void)?
    /// The turn's interventions, as words beside its impact.
    var interventions: [InterventionItem] = [] { didSet { if interventions != oldValue { updateWords() } } }
    private var turn: StepTurn?
    private var impactColor: NSColor = .secondaryLabelColor
    var onBucket: ((TimeBucketName) -> Void)? {
        didSet { bar.onBucket = onBucket }
    }

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        chevron.bezelStyle = .inline
        chevron.isBordered = false
        chevron.imagePosition = .imageOnly
        chevron.target = self
        chevron.action = #selector(toggle)
        number.font = Theme.font(.groupHeader)
        prompt.font = Theme.font(.groupHeader)
        prompt.lineBreakMode = .byTruncatingTail
        impact.font = Theme.font(.rowSecondary)
        impact.lineBreakMode = .byTruncatingTail
        wall.font = Theme.font(.rowSecondary)
        wall.textColor = .secondaryLabelColor
        wall.alignment = .right
        impactIcon.imageScaling = .scaleProportionallyDown
        claim.isBordered = false
        claim.imagePosition = .imageLeading
        claim.target = self
        claim.action = #selector(openClaim)
        for v in [chevron, number, prompt, impactIcon, impact, claim, wall, bar] as [NSView] { addSubview(v) }
        textField = prompt
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func toggle() { onToggle?() }
    @objc private func openClaim() { onClaim?() }

    func configure(_ t: StepTurn, expanded: Bool, analysis: AnalysisStatus?) {
        chevron.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: expanded ? "Collapse" : "Expand")
        chevron.contentTintColor = .secondaryLabelColor
        chevron.setAccessibilityLabel(expanded ? "Collapse turn \(t.n)" : "Expand turn \(t.n)")
        number.stringValue = "T\(t.n)"
        number.toolTip = "Turn \(t.n)" + (t.origin.map { $0 == "human" ? "" : ", started by \($0)" } ?? "")
        prompt.stringValue = t.promptExcerpt ?? "No prompt"
        prompt.textColor = t.promptExcerpt == nil ? .tertiaryLabelColor : .labelColor
        impactColor = t.impact.isProblem ? DerivedStyle.impactColor(t.impact) : .secondaryLabelColor
        impactIcon.image = Mark.impact(t.impact).image(size: 11, weight: .semibold, color: impactColor)
        turn = t
        updateWords()
        if let c = t.claim {
            // The claim mark is never red (§6.2): amber when unverified.
            claim.isHidden = false
            let tint = c.isUnverified ? Theme.warn : NSColor.secondaryLabelColor
            claim.image = Mark.claim.image(size: 10, weight: .semibold, color: tint)
            claim.attributedTitle = NSAttributedString(string: " " + DerivedStyle.outcomeWord(c.rawValue),
                                                       attributes: [.foregroundColor: tint, .font: Theme.font(.rowSecondary)])
            claim.toolTip = "The final message claims success; the claim check found: \(DerivedStyle.outcomeWord(c.rawValue)). Click to open the evidence."
            claim.setAccessibilityLabel("Claim check: " + DerivedStyle.outcomeWord(c.rawValue))
        } else {
            claim.isHidden = true
        }
        wall.stringValue = t.wallUs.map { DerivedStyle.marked(Formatters.duration($0), t.wallSrc) } ?? Formatters.missing
        wall.toolTip = "Wall time of the turn. " + DerivedStyle.provHelp(t.wallSrc, analysis: analysis)
        bar.time = TimeBreakdown(wallUs: t.wallUs, buckets: t.buckets, unattributedUs: t.unattributedUs, humanGapUs: nil, continuationUs: nil)
        toolTip = (t.promptExcerpt ?? "") + "\n" + Formatters.timestamp(t.startTs)
        setAccessibilityLabel("Turn \(t.n), \(t.impact.rawValue), \(Formatters.count(t.nSteps, "step")): \(t.promptExcerpt ?? "no prompt")")
        needsLayout = true
    }

    /// Impact, open and unattended states, interventions and highlight counts.
    private func updateWords() {
        guard let t = turn else { return }
        var words = [t.impact.rawValue]
        if t.open { words.append("open") }
        if t.unattended { words.append("unattended") }
        let kinds = Dictionary(grouping: interventions, by: \.kind)
        for k in InterventionKind.known where kinds[k] != nil {
            words.append(InterventionStyle.counted(k, kinds[k]!.count))
        }
        if let m = t.matchedSteps { words.append("\(m) of \(t.nSteps) match") }
        impact.attributedStringValue = {
            let a = NSMutableAttributedString(string: words[0], attributes: [.foregroundColor: impactColor, .font: Theme.font(.rowSecondary)])
            if words.count > 1 {
                a.append(NSAttributedString(string: " · " + words.dropFirst().joined(separator: " · "),
                                            attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: Theme.font(.rowSecondary)]))
            }
            return a
        }()
        impact.toolTip = interventions.isEmpty ? nil : interventions.map { InterventionStyle.help($0, analysis: nil) }.joined(separator: "\n")
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let w = bounds.width, h = bounds.height
        chevron.frame = NSRect(x: 4, y: (h - 16) / 2, width: 16, height: 16)
        // Labels draw their text 2 pt in from each side, which their intrinsic widths leave out.
        let nw = ceil(number.intrinsicContentSize.width) + 4
        number.frame = NSRect(x: 22, y: (h - 16) / 2, width: nw, height: 16)
        let barW: CGFloat = min(120, w * 0.15)
        bar.frame = NSRect(x: w - barW - 12, y: (h - 8) / 2, width: barW, height: 8)
        let ww = ceil(wall.intrinsicContentSize.width) + 4
        wall.frame = NSRect(x: bar.frame.minX - ww - 8, y: (h - 15) / 2, width: ww, height: 15)
        var right = wall.frame.minX - 12
        if !claim.isHidden {
            let cw = min(200, ceil(claim.intrinsicContentSize.width))
            claim.frame = NSRect(x: right - cw, y: (h - 18) / 2, width: cw, height: 18)
            right = claim.frame.minX - 10
        }
        let iw = min(260, ceil(impact.intrinsicContentSize.width) + 4)
        impact.frame = NSRect(x: right - iw, y: (h - 15) / 2, width: iw, height: 15)
        impactIcon.frame = NSRect(x: impact.frame.minX - 16, y: (h - 13) / 2, width: 13, height: 13)
        prompt.frame = NSRect(x: number.frame.maxX + 6, y: (h - 16) / 2, width: max(0, impactIcon.frame.minX - number.frame.maxX - 18), height: 16)
    }
}

/// The turn's stacked time bar, drawn in AppKit; a click narrows the step list to that bucket.
final class TimeBarView: NSView {
    var time: TimeBreakdown? { didSet { needsDisplay = true; updateToolTip() } }
    var onBucket: ((TimeBucketName) -> Void)?

    private var segments: [(TimeBucketName?, NSRect, Double)] {
        guard let time else { return [] }
        let total = Double(time.buckets.reduce(Int64(0)) { $0 + $1.us } + (time.unattributedUs ?? 0))
        guard total > 0 else { return [] }
        var x = bounds.minX
        var out: [(TimeBucketName?, NSRect, Double)] = []
        for b in time.buckets where b.us > 0 {
            let w = bounds.width * CGFloat(Double(b.us) / total)
            out.append((b.name, NSRect(x: x, y: bounds.minY, width: w, height: bounds.height), b.us > 0 ? Double(b.derivedUs) / Double(b.us) : 0))
            x += w
        }
        if (time.unattributedUs ?? 0) > 0 { out.append((nil, NSRect(x: x, y: bounds.minY, width: bounds.maxX - x, height: bounds.height), 0)) }
        return out
    }

    override func draw(_ dirtyRect: NSRect) {
        // No time accounting for this turn: draw nothing rather than an empty bar that looks like data.
        guard !segments.isEmpty else { return }
        let path = NSBezierPath(roundedRect: bounds, xRadius: 2, yRadius: 2)
        NSGraphicsContext.saveGraphicsState()
        path.addClip()
        NSColor.quaternaryLabelColor.setFill()
        bounds.fill()
        for (name, r, derived) in segments {
            (name.map { TimeBar.color($0).withAlphaComponent(0.85) } ?? NSColor.tertiaryLabelColor.withAlphaComponent(0.3)).setFill()
            r.fill()
            if derived > 0 {
                let hr = NSRect(x: r.maxX - r.width * derived, y: r.minY, width: r.width * derived, height: r.height)
                NSGraphicsContext.saveGraphicsState()
                hr.clip()
                NSColor.labelColor.withAlphaComponent(0.3).setStroke()
                let hatch = NSBezierPath()
                var x = hr.minX - hr.height
                while x < hr.maxX {
                    hatch.move(to: NSPoint(x: x, y: hr.minY))
                    hatch.line(to: NSPoint(x: x + hr.height, y: hr.maxY))
                    x += 3
                }
                hatch.lineWidth = 1
                hatch.stroke()
                NSGraphicsContext.restoreGraphicsState()
            }
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    private func updateToolTip() {
        guard let time, time.buckets.contains(where: { $0.us > 0 }) || (time.unattributedUs ?? 0) > 0 else {
            toolTip = nil
            setAccessibilityLabel(nil)
            return
        }
        var lines = time.buckets.filter { $0.us > 0 }.map { "\($0.name.rawValue): \(Formatters.duration($0.us))" + ($0.derivedUs > 0 ? " (≈\(Formatters.duration($0.derivedUs)) derived)" : "") }
        if (time.unattributedUs ?? 0) > 0 { lines.append("unattributed: \(Formatters.duration(time.unattributedUs ?? 0))") }
        toolTip = lines.joined(separator: "\n") + "\nClick a segment to show only steps with that time."
        setAccessibilityLabel(lines.joined(separator: ", "))
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if let seg = segments.first(where: { $0.1.contains(p) }), let name = seg.0 { onBucket?(name) }
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .image }
}

/// The 12 pt episode gutter: one lane per episode, a dot where an attempt ran.
final class EpisodeGutterView: NSView {
    var lanes: [(lane: Int, attempt: Bool, up: Bool, down: Bool)] = [] { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        let color = Theme.err.withAlphaComponent(0.8)
        color.setFill()
        for l in lanes {
            let x = 2 + CGFloat(l.lane) * 3
            let top = l.up ? bounds.maxY : bounds.midY
            let bottom = l.down ? bounds.minY : bounds.midY
            NSRect(x: x, y: bottom, width: 1.5, height: max(0, top - bottom)).fill()
            if l.attempt { NSBezierPath(ovalIn: NSRect(x: x - 1.5, y: bounds.midY - 2.25, width: 4.5, height: 4.5)).fill() }
        }
    }

    override func isAccessibilityElement() -> Bool { !lanes.isEmpty }
    override func accessibilityLabel() -> String? {
        lanes.isEmpty ? nil : "\(Set(lanes.map(\.lane)).count) episode lane\(lanes.count == 1 ? "" : "s")\(lanes.contains { $0.attempt } ? ", attempt here" : "")"
    }
}

/// Call chips: red fill for a failure, dashed red for suspect, amber for benign, dotted amber for deferred, ⟳ inside
/// an episode; spawn chips show the child's outcome, its source and "parent told: no". Non-matching calls are dimmed.
final class CallChipsView: NSView {
    var calls: [StepCall] = [] {
        didSet {
            needsDisplay = true
            updateAccessibility()
            toolTip = calls.isEmpty ? nil : calls.map { c in
                var t = Self.label(c)
                if let tier = c.tier { t += " · \(tier.rawValue)" }
                if let d = c.durUs { t += " · " + Formatters.duration(d, src: c.durSrc?.rawValue) }
                return t
            }.joined(separator: "\n") + "\nClick a chip to select its event; ⌘-click shows it in Events; ⌥-click opens a child session."
        }
    }
    var onClick: ((StepCall) -> Void)?
    private var rects: [NSRect] = []

    /// Call tokens are machine text (§3.2): the code font.
    static let font = Theme.font(.code)
    /// Up to three tokens, then "+n" (§7.8).
    static let maxTokens = 3

    static func label(_ c: StepCall) -> String {
        var s = c.tool ?? "call"
        if let t = c.target {
            let short = t.split(separator: ":", maxSplits: 1).last.map(String.init) ?? t
            if short != c.tool { s += " " + String(short.prefix(28)) }
        }
        if c.childSessionId != nil {
            s += " → " + (c.childOutcome.map { DerivedStyle.marked($0.rawValue, c.childOutcomeSrc) } ?? "child")
            if c.parentTold == false { s += " · parent told: no" }
        }
        return s
    }

    /// One token (§6.2 Call chips): inline code on the well; a failure is Solid with the failed mark, the other tiers
    /// are Outline in their tier color, and a call inside an episode ends in the loop mark.
    override func draw(_ dirtyRect: NSRect) {
        rects = []
        var x: CGFloat = 2
        let h: CGFloat = 18
        let y = (bounds.height - h) / 2
        let moreAttributes: [NSAttributedString.Key: Any] = [.font: Theme.font(.rowSecondary), .foregroundColor: NSColor.secondaryLabelColor]
        let mark: CGFloat = 12
        for (i, c) in calls.enumerated() {
            let rest = calls.count - i
            if i == Self.maxTokens {
                ("+\(rest)" as NSString).draw(at: NSPoint(x: x, y: y + 2), withAttributes: moreAttributes)
                break
            }
            let text = Self.label(c) as NSString
            let lead: CGFloat = c.tier == .failure ? mark + 3 : 0
            let trail: CGFloat = c.episodeId != nil ? mark + 3 : 0
            var width = min(220, ceil(text.size(withAttributes: [.font: Self.font]).width) + 12 + lead + trail)
            let more = rest > 1 ? "+\(rest - 1)" as NSString : nil
            let moreWidth = more.map { ceil($0.size(withAttributes: moreAttributes).width) + 6 } ?? 0
            let shortened = x + width > bounds.width - 2 - (i == 0 ? moreWidth : 0)
            if shortened {
                // The first token always shows, shortened, with the count of the rest after it.
                guard i == 0 else {
                    ("+\(rest)" as NSString).draw(at: NSPoint(x: x, y: y + 2), withAttributes: moreAttributes)
                    break
                }
                width = max(32, bounds.width - 2 - x - moreWidth)
                more?.draw(at: NSPoint(x: x + width + 6, y: y + 2), withAttributes: moreAttributes)
            }
            let r = NSRect(x: x, y: y, width: width, height: h)
            rects.append(r)
            let path = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 4, yRadius: 4)
            let alpha: CGFloat = c.match == false ? 0.4 : 1
            var textColor = NSColor.labelColor
            switch c.tier {
            case .failure?:
                Theme.err.withAlphaComponent(alpha).setFill()
                path.fill()
                textColor = Theme.solidBadgeText
            case let tier?:
                DerivedStyle.tierColor(tier).withAlphaComponent(alpha).setStroke()
                path.lineWidth = 1
                path.stroke()
            default:
                NSColor.quaternarySystemFill.setFill()
                path.fill()
                if c.childOutcome?.isFailure == true {
                    Theme.err.withAlphaComponent(alpha).setStroke()
                    path.lineWidth = 1
                    path.stroke()
                }
            }
            var tx = r.minX + 6
            if c.tier == .failure, let img = Mark.failed.image(size: 10, weight: .bold, color: textColor, bare: true) {
                img.draw(in: NSRect(x: tx, y: r.midY - mark / 2, width: mark, height: mark), from: .zero, operation: .sourceOver, fraction: alpha)
                tx += mark + 3
            }
            if c.episodeId != nil, let img = Mark.loop.image(size: 10, weight: .semibold, color: c.tier == .failure ? textColor : .secondaryLabelColor, bare: c.tier == .failure) {
                img.draw(in: NSRect(x: r.maxX - 6 - mark, y: r.midY - mark / 2, width: mark, height: mark), from: .zero, operation: .sourceOver, fraction: alpha)
            }
            let style = NSMutableParagraphStyle()
            style.lineBreakMode = .byTruncatingTail
            let lineHeight = ceil(Self.font.ascender - Self.font.descender)
            text.draw(with: NSRect(x: tx, y: r.midY - lineHeight / 2, width: max(0, r.maxX - 5 - trail - tx), height: lineHeight),
                      options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                      attributes: [.font: Self.font, .foregroundColor: textColor.withAlphaComponent(alpha), .paragraphStyle: style])
            x += width + 4
            if shortened { break }
        }
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if let i = rects.firstIndex(where: { $0.contains(p) }), calls.indices.contains(i) {
            onClick?(calls[i])
        } else {
            super.mouseDown(with: event)
        }
    }

    override func resetCursorRects() {
        for r in rects { addCursorRect(r, cursor: .pointingHand) }
    }

    private func updateAccessibility() {
        setAccessibilityElement(!calls.isEmpty)
        setAccessibilityRole(.group)
        setAccessibilityLabel(calls.isEmpty ? nil : calls.map { Self.label($0) + ($0.tier.map { ", \($0.rawValue)" } ?? "") }.joined(separator: "; "))
    }
}
