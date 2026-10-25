import AppKit
import SwiftUI

/// The alignment table (ANALYSIS-UX §5.10, §5.11): a native `NSTableView` of the engine's aligned rows, run A's action
/// on the left, run B's on the right and the status gutter between them, with a 12 pt minimap beside the scroller.
/// Difference regions get a group row, runs of four or more same rows fold into one row, and the table never scrolls
/// sideways: the A and B columns share the width and keep at least 45% of their halves (DESIGN.md §4.4).
///
/// Keys: ↑ and ↓ move between rows, ← and → choose the run the inspector shows, Space opens or closes a fold, Return
/// shows the chosen run's action in Events, and ⌥⌘↓ / ⌥⌘↑ go to the next or previous region (Go menu).
struct AlignmentTable: NSViewControllerRepresentable {
    let model: WindowModel
    let compare: CompareModel

    func makeNSViewController(context: Context) -> AlignmentTableController { AlignmentTableController(model: model, compare: compare) }
    func updateNSViewController(_ controller: AlignmentTableController, context: Context) {}

    static func dismantleNSViewController(_ controller: AlignmentTableController, coordinator: ()) { controller.tearDown() }

    /// Take the space offered: the columns fit the table's width, so its width must not depend on them.
    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: AlignmentTableController, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 600, height: proposal.height ?? 400)
    }
}

final class AlignmentNSTable: NSTableView {
    weak var controller: AlignmentTableController?

    /// Region, fold and footer rows span the table from their first visible column, as wide as the clip view shows it:
    /// the table can be wider while it fits its columns, and a line sized to that would cut without its ellipsis. They
    /// are ordinary rows, not group rows: AppKit puts section spacing above every group row but the first.
    override func frameOfCell(atColumn column: Int, row: Int) -> NSRect {
        guard let controller, controller.spans(row) else { return super.frameOfCell(atColumn: column, row: row) }
        guard column == firstVisibleColumn else { return .zero }
        var r = rect(ofRow: row)
        if let clip = enclosingScrollView?.contentView { r.size.width = min(r.width, clip.bounds.width) }
        return r
    }

    var firstVisibleColumn: Int { tableColumns.firstIndex { !$0.isHidden } ?? 0 }

    override func keyDown(with event: NSEvent) {
        let mods = event.modifierFlags.intersection([.command, .control, .option, .shift])
        guard mods.isEmpty, let controller else { return super.keyDown(with: event) }
        switch event.keyCode {
        case 123: controller.compare.choose(.a)
        case 124: controller.compare.choose(.b)
        case 125: controller.move(1)
        case 126: controller.move(-1)
        case 49: controller.compare.toggleFold()
        case 36, 76: controller.activate()
        default: super.keyDown(with: event)
        }
    }
}

@MainActor final class AlignmentTableController: NSViewController, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
    let model: WindowModel
    let compare: CompareModel
    private let table = AlignmentNSTable()
    private let scrollView = ShadowedScrollView()
    private let minimap = AlignmentMinimap()
    private let contextMenu = NSMenu()
    private var items: [AlignmentItem] = []
    private var result: DiffResult?
    private var resultKey: String?
    private var loops: [ObservationLoop] = []
    /// The loops that reload rows: only what they read first arms them, not what the cells read as they load.
    private var reloads: [SnapshotLoop] = []
    /// A selection to centre once the clip view has a height (before the first layout it has none, and centring then
    /// put the row half above the top edge), or once the table has loaded the rows that hold it.
    private var pendingCentre = false
    private var applying = false
    private var fonts = EventTableFonts(density: .compact)
    private var metrics = Theme.metrics(.compact)
    private var fittedWidth: CGFloat = 0
    private var scrollSerial = 0
    /// The row last drawn with the chosen-side bar.
    private var chosenRow: Int?
    /// Each side's run start, from which Since start counts.
    private var runStart: [CompareSide: Int64] = [:]
    /// Whether any action carries a start time (analysis 1.1); without one the Since start columns stay hidden.
    private var hasTimes = false

    /// The columns in display order: #, A, its time since the run's start, the status gutter, B and its time.
    static let columns: [(spec: ColumnFit.Spec, title: String)] = [
        (.init(id: "no", min: 44, max: 56, priority: 3), "#"),
        (.init(id: "a", min: 160, max: 2000, priority: 1, primary: true), "A"),
        (.init(id: "aTime", min: 64, max: 76, priority: 4), "Since start"),
        (.init(id: "status", min: 28, max: 28, priority: 1), ""),
        (.init(id: "b", min: 160, max: 2000, priority: 1, primary: true), "B"),
        (.init(id: "bTime", min: 64, max: 76, priority: 4), "Since start"),
    ]

    init(model: WindowModel, compare: CompareModel) {
        self.model = model
        self.compare = compare
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        table.controller = self
        for (c, title) in Self.columns {
            let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(c.id))
            col.title = title
            col.width = c.min
            col.minWidth = 24
            col.resizingMask = []
            if ["no", "aTime", "bTime"].contains(c.id) { col.headerCell.alignment = .right }
            table.addTableColumn(col)
        }
        table.style = .fullWidth
        table.floatsGroupRows = false
        table.allowsMultipleSelection = false
        table.allowsEmptySelection = true
        table.allowsTypeSelect = false
        table.allowsColumnReordering = false
        table.allowsColumnResizing = false
        table.usesAlternatingRowBackgroundColors = false
        table.intercellSpacing = NSSize(width: 6, height: 0)
        table.columnAutoresizingStyle = .noColumnAutoresizing
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(doubleClicked)
        table.setAccessibilityLabel("Alignment of run A and run B")
        contextMenu.delegate = self
        contextMenu.autoenablesItems = false
        table.menu = contextMenu
        scrollView.documentView = table
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .controlBackgroundColor
        minimap.onPick = { [weak self] p in self?.pickFromMinimap(p) }

        let container = AlignmentContainer(scrollView: scrollView, minimap: minimap)
        view = container
        scrollView.contentView.postsFrameChangedNotifications = true
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(widthChanged), name: NSView.frameDidChangeNotification, object: scrollView.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        // Reloading builds cells that read the selection, the side, the folds and the density; only the reads before it
        // arm these loops, so arrowing through 3,000 rows re-runs neither the items loop nor the display loop.
        reloads.append(SnapshotLoop { [weak self] in self?.model.app.preferences.rowDensity } act: { [weak self] in
            if let density = $0 { self?.followDisplay(density) }
        })
        reloads.append(SnapshotLoop { [weak self] in self.map { ($0.compare.items, $0.compare.result, $0.compare.key) } } act: { [weak self] in
            if let now = $0 { self?.followItems(now.0, now.1, now.2) }
        })
        loops.append(ObservationLoop { [weak self] in self?.followSelection() })
        reloads.append(SnapshotLoop { [weak self] in self.map { ($0.compare.side, $0.compare.selectedPosition) } } act: { [weak self] in
            if let now = $0 { self?.followSide(now.1) }
        })
    }

    func tearDown() {
        loops.forEach { $0.cancel() }
        loops.removeAll()
        reloads.forEach { $0.cancel() }
        reloads.removeAll()
        NotificationCenter.default.removeObserver(self)
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        widthChanged()
        if pendingCentre, scrollView.contentView.bounds.height > 0, let p = tablePosition {
            pendingCentre = false
            scrollToCenter(p)
        }
    }

    /// The selected item's row in the table as it stands, which can be a turn behind the model's rows.
    private var tablePosition: Int? { compare.selected.flatMap { items.firstIndex(of: $0) } }

    // MARK: Following the model

    private func followDisplay(_ density: Preferences.RowDensity) {
        let f = EventTableFonts(density: density)
        let m = Theme.metrics(density)
        guard f.rowHeight != fonts.rowHeight || m != metrics || table.numberOfRows == 0 else { return }
        fonts = f
        metrics = m
        table.headerView?.needsDisplay = true
        if table.numberOfRows > 0 { table.reloadData() }
    }

    private func followItems(_ newItems: [AlignmentItem], _ newResult: DiffResult?, _ key: String?) {
        let changedResult = newResult?.coverage.snapshotAt != result?.coverage.snapshotAt || key != resultKey
        guard newItems != items || changedResult else { return }
        items = newItems
        resultKey = key
        result = newResult
        if changedResult, let r = newResult {
            let catalog = model.sessionsByID
            runStart = [:]
            for side in CompareSide.allCases {
                let run = CompareRun(id: r.run(side).session, result: r, catalog: catalog)
                runStart[side] = run.start
                let column = table.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier(side == .a ? "a" : "b"))
                column?.title = side.letter + " · " + run.name
                column?.headerToolTip = "Run \(side.letter): " + run.help
                let time = table.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier(side == .a ? "aTime" : "bTime"))
                time?.headerToolTip = "Time since this run's first event"
                    + (run.start.map { "\nRun \(side.letter) started \(Formatters.timestamp($0, digits: 3))" } ?? "")
            }
            table.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier("status"))?.headerToolTip = CompareText.statusColumnHelp(rule: r.method)
            hasTimes = r.alignment.contains { $0.left?.start != nil || $0.right?.start != nil }
            fittedWidth = 0
            widthChanged()
        }
        applying = true
        table.reloadData()
        applying = false
        minimap.update(items: items, result: result)
        updateViewport()
        restoreSelection(scroll: changedResult || pendingCentre)
    }

    private func followSelection() {
        _ = compare.selected
        let serial = compare.scrollRequest
        restoreSelection(scroll: serial != scrollSerial)
        scrollSerial = serial
    }

    /// The selection and ← and → change which cell carries the chosen-side bar: the row that had it and the row that
    /// gets it are drawn again, so only one cell in the table has it.
    private func followSide(_ row: Int?) {
        let rows = IndexSet([chosenRow, row].compactMap { $0 }.filter { $0 < table.numberOfRows })
        chosenRow = row
        table.reloadData(forRowIndexes: rows, columnIndexes: IndexSet(integersIn: 0..<table.numberOfColumns))
    }

    /// Select the model's selection in the table, centred when `scroll` asks. The model can be a turn ahead of the table
    /// (Show Row opens a fold and selects in one turn, and the observers run in either order): a selection the table's
    /// rows do not hold yet waits for the reload, which restores it, its scroll included.
    private func restoreSelection(scroll: Bool) {
        applying = true
        defer { applying = false }
        guard compare.selected != nil else {
            table.deselectAll(nil)
            return
        }
        guard let p = tablePosition, p < table.numberOfRows else {
            if scroll { pendingCentre = true }
            return
        }
        if table.selectedRow != p { table.selectRowIndexes(IndexSet(integer: p), byExtendingSelection: false) }
        guard scroll else { return }
        if scrollView.contentView.bounds.height > 0 {
            pendingCentre = false
            scrollToCenter(p)
        } else {
            pendingCentre = true
        }
    }

    private func scrollToCenter(_ row: Int) {
        let rect = table.rect(ofRow: row)
        let visible = scrollView.contentView.bounds
        guard !visible.contains(rect) else { return }
        let y = max(0, rect.midY - visible.height / 2)
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: min(y, max(0, table.bounds.height - visible.height))))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    // MARK: Columns (DESIGN.md §4.4)

    @objc private func widthChanged() {
        let width = scrollView.contentView.bounds.width
        guard width > 0, abs(width - fittedWidth) > 0.5 else { return }
        fittedWidth = width
        let specs = Self.columns.map(\.spec).filter { hasTimes || ($0.id != "aTime" && $0.id != "bTime") }
        let fit = ColumnFit.fit(specs, width: width, spacing: table.intercellSpacing.width)
        let firstVisible = table.firstVisibleColumn
        for col in table.tableColumns {
            if let w = fit.widths[col.identifier.rawValue] {
                col.isHidden = false
                if abs(col.width - w) > 0.5 { col.width = w }
            } else {
                col.isHidden = true
            }
        }
        table.tile()
        if table.frame.width > width + 0.5 { table.setFrameSize(NSSize(width: width, height: table.frame.height)) }
        // The spanning rows hang off the first visible column, and AppKit frames their cells only when it makes them.
        let column = table.firstVisibleColumn
        if column != firstVisible {
            table.reloadData()
        } else {
            table.enumerateAvailableRowViews { rowView, row in
                guard self.spans(row), let cell = rowView.view(atColumn: column) as? NSView else { return }
                cell.frame = NSRect(x: 0, y: 0, width: table.frameOfCell(atColumn: column, row: row).width, height: rowView.bounds.height)
            }
        }
        // A column hidden for want of room is one the chips row names; Since start left out for want of times is not.
        let names = ["no": "#", "aTime": "Since start (A)", "bTime": "Since start (B)"]
        let hidden = fit.hidden.compactMap { names[$0] }
        // The chips row reads this; a layout pass must not change what SwiftUI is updating, so it lands on the next turn.
        DispatchQueue.main.async { [weak self] in
            if let compare = self?.compare, compare.hiddenColumns != hidden { compare.hiddenColumns = hidden }
        }
    }

    @objc private func scrolled() { updateViewport() }

    private func updateViewport() {
        let visible = table.rows(in: scrollView.contentView.bounds)
        minimap.viewport = visible.length > 0 ? visible.location..<(visible.location + visible.length) : nil
    }

    // MARK: Data source and delegate

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    /// The row is a region, fold or footer row, drawn across the whole table.
    func spans(_ row: Int) -> Bool {
        items.indices.contains(row) && items[row].rowPosition == nil
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard items.indices.contains(row) else { return metrics.tableRow }
        if case .region = items[row] { return metrics.groupHeader }
        return metrics.tableRow
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        items.indices.contains(row) && items[row].isSelectable
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let v = AlignmentRowView()
        if items.indices.contains(row) {
            switch items[row] {
            case .region: v.kind = .region
            case .fold: v.kind = .fold
            case .footer: v.kind = .footer
            case .row(let p):
                v.kind = .row
                // The row reads its visible content in order, marks as words (DESIGN.md §10.2).
                if let r = result?.alignment[p] {
                    let starts = runStart
                    v.setAccessibilityLabel(CompareText.rowLabel(r) { side in r.action(side).flatMap { CompareText.elapsed($0, runStart: starts[side]) } })
                }
            }
        }
        return v
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard items.indices.contains(row), let result else { return nil }
        let item = items[row]
        guard let p = item.rowPosition else {
            guard let tableColumn, table.tableColumns.firstIndex(of: tableColumn) == table.firstVisibleColumn else { return nil }
            let id = NSUserInterfaceItemIdentifier("AlignmentGroup")
            let cell = tableView.makeView(withIdentifier: id, owner: nil) as? AlignmentGroupCell ?? AlignmentGroupCell(identifier: id)
            configureGroup(cell, item, result)
            return cell
        }
        guard let col = tableColumn?.identifier.rawValue else { return nil }
        let r = result.alignment[p]
        switch col {
        case "a", "b":
            let side: CompareSide = col == "a" ? .a : .b
            let id = NSUserInterfaceItemIdentifier("AlignmentAction")
            let cell = tableView.makeView(withIdentifier: id, owner: nil) as? AlignmentActionCell ?? AlignmentActionCell(identifier: id)
            cell.configure(r, side: side, fonts: fonts, chosen: compare.selected == item && compare.side == side && r.isPaired)
            return cell
        case "status":
            let id = NSUserInterfaceItemIdentifier("AlignmentStatus")
            let cell = tableView.makeView(withIdentifier: id, owner: nil) as? AlignmentStatusCell ?? AlignmentStatusCell(identifier: id)
            cell.configure(r, fonts: fonts)
            return cell
        default:
            let id = NSUserInterfaceItemIdentifier("AlignmentText." + col)
            let cell = tableView.makeView(withIdentifier: id, owner: nil) as? EventTextCell ?? EventTextCell(identifier: id)
            if col == "no" {
                cell.configure(Formatters.count(r.index + 1), font: fonts.digits, color: .secondaryLabelColor, alignment: .right)
            } else {
                let side: CompareSide = col == "aTime" ? .a : .b
                let a = r.action(side)
                let text = a.flatMap { CompareText.elapsed($0, runStart: runStart[side]) }
                cell.configure(a == nil ? "" : text ?? Formatters.missing, font: fonts.digits,
                               color: text == nil ? .tertiaryLabelColor : .secondaryLabelColor, alignment: .right,
                               tooltip: a.flatMap { CompareText.elapsedHelp($0, side: side) } ?? (a == nil ? nil : AnalysisVocabulary.notDetermined))
            }
            return cell
        }
    }

    private func configureGroup(_ cell: AlignmentGroupCell, _ item: AlignmentItem, _ result: DiffResult) {
        switch item {
        case .region(let i):
            // Where the whole sentence does not fit, each side keeps its three most frequent ops, then one, then none (the
            // tooltip keeps them all), so the verdict stays.
            let region = CompareText.regionShown(result.regions[i], in: result)
            let forms = [nil, 3, 1, 0].map { AnalysisVocabulary.regionHeader(region, number: i + 1, opsLimit: $0) }
            let text = forms[0]
            let lines = forms.map { $0.components(separatedBy: " · ") }
            cell.configure(symbol: nil, title: lines[0][0], details: lines.map { $0.dropFirst().joined(separator: " · ") }, fonts: fonts,
                           titleFont: Theme.font(.groupHeader, model.app.preferences.rowDensity), tooltip: text)
            cell.setAccessibilityLabel(text)
        case .fold(let from, let to):
            let open = compare.expandedFolds.contains(from)
            let r = result.alignment
            let text = AnalysisVocabulary.foldRow(from: r[from].index, to: r[to].index)
            cell.configure(symbol: open ? "chevron.down" : "chevron.right", title: nil, details: [text], fonts: fonts, titleFont: fonts.text,
                           tooltip: open ? "Fold these same actions again (Space)" : "Show these same actions (Space)")
            cell.setAccessibilityLabel(text + (open ? ", expanded" : ", collapsed"))
            cell.onSymbol = { [weak self] in self?.toggle(foldAt: from) }
        case .footer(let text):
            cell.configure(symbol: "info.circle", title: nil, details: [text], fonts: fonts, titleFont: fonts.text, tooltip: nil)
            cell.setAccessibilityLabel(text)
        case .row:
            break
        }
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !applying else { return }
        let row = table.selectedRow
        compare.select(items.indices.contains(row) ? items[row] : nil)
    }

    // MARK: Actions

    /// A double-click opens or closes a fold, as its chevron and Space do; on an aligned row it shows the action in Events.
    @objc private func doubleClicked() {
        let row = table.clickedRow
        guard items.indices.contains(row) else { return }
        if case .fold(let from, _) = items[row] { return toggle(foldAt: from) }
        activate()
    }

    private func toggle(foldAt from: Int) {
        if compare.expandedFolds.contains(from) { compare.expandedFolds.remove(from) } else { compare.expandedFolds.insert(from) }
    }

    /// Return or a double-click: the chosen run's action in Events.
    func activate() {
        if case .fold? = compare.selected { return compare.toggleFold() }
        guard let a = compare.selectedAction else { return NSSound.beep() }
        model.select(event: a.eventID, reveal: true)
    }

    /// ↑ and ↓ skip the region and footer rows, which take no selection.
    func move(_ step: Int) {
        let start = tablePosition ?? (step > 0 ? -1 : items.count)
        var p = start + step
        while items.indices.contains(p), !items[p].isSelectable { p += step }
        guard items.indices.contains(p) else { return NSSound.beep() }
        compare.select(items[p], scroll: true)
        table.scrollRowToVisible(p)
    }

    private func pickFromMinimap(_ position: Int) {
        guard items.indices.contains(position) else { return }
        var p = position
        while items.indices.contains(p), !items[p].isSelectable { p += 1 }
        guard items.indices.contains(p) else { return }
        compare.select(items[p], scroll: true)
        view.window?.makeFirstResponder(table)
    }

    // MARK: Menu (§5.12)

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        guard items.indices.contains(row), let result else { return }
        let compare = self.compare, model = self.model
        if case .fold(let from, _) = items[row] {
            let open = compare.expandedFolds.contains(from)
            menu.addItem(open ? "Fold Same Actions" : "Show Same Actions") { [weak self] in self?.toggle(foldAt: from) }
            return
        }
        guard let p = items[row].rowPosition else { return }
        if compare.selected != items[row] { compare.select(items[row]) }
        let r = result.alignment[p]
        for side in CompareSide.allCases {
            menu.addItem("Show \(side.letter) in Events", symbol: Symbols.workspace(.events), enabled: r.action(side) != nil) {
                if let a = r.action(side) { model.select(event: a.eventID, reveal: true) }
            }
        }
        menu.addItem(.separator())
        menu.addItem("Show in Session", symbol: SessionMode.steps.symbol) { compare.showInSession() }
        menu.addItem("Show in Timeline", symbol: Symbols.workspace(.timeline)) { compare.showInTimeline() }
        menu.addItem(.separator())
        for side in CompareSide.allCases {
            if let a = r.action(side) { menu.addItem("Copy \(side.letter) Event ID") { AppKitHelpers.copy(a.eventID) } }
        }
    }
}

/// An observation loop that only its `read` arms: `act` runs right after with what `read` returned, outside the
/// tracking, so the cells a table reload builds can read the model without re-running the loop.
@MainActor private final class SnapshotLoop {
    private var step: (() -> Void)?

    init<T>(_ read: @escaping @MainActor () -> T, act: @escaping @MainActor (T) -> Void) {
        step = { [weak self] in
            let now = withObservationTracking { read() } onChange: { [weak self] in Task { @MainActor in self?.step?() } }
            act(now)
        }
        step?()
    }

    func cancel() { step = nil }
}

// MARK: - Container

/// The table's scroll view with the minimap at its right edge, beside the scroller, and the minimap's ≠ in the header
/// row above it, which names it.
private final class AlignmentContainer: NSView {
    let scrollView: NSScrollView
    let minimap: AlignmentMinimap
    private let header = MinimapHeader()

    init(scrollView: NSScrollView, minimap: AlignmentMinimap) {
        self.scrollView = scrollView
        self.minimap = minimap
        super.init(frame: .zero)
        addSubview(scrollView)
        addSubview(minimap)
        addSubview(header)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let w = AlignmentMinimap.width
        scrollView.frame = NSRect(x: 0, y: 0, width: max(0, bounds.width - w), height: bounds.height)
        // The minimap starts under the table header, so its rows line up with the scroller's.
        let height = (scrollView.documentView as? NSTableView)?.headerView?.frame.height ?? 0
        header.frame = NSRect(x: bounds.width - w, y: 0, width: w, height: height)
        minimap.frame = NSRect(x: bounds.width - w, y: height, width: w, height: max(0, bounds.height - height))
    }
}

/// The minimap's header cell: ≠ (rows that differ) on the header row's background, with the minimap's tooltip.
private final class MinimapHeader: NSView {
    private let glyph = NSImageView()

    init() {
        super.init(frame: .zero)
        glyph.image = NSImage(systemSymbolName: "notequal", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        glyph.contentTintColor = .secondaryLabelColor
        glyph.imageScaling = .scaleProportionallyDown
        addSubview(glyph)
        toolTip = AlignmentMinimap.help
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        glyph.frame = bounds.insetBy(dx: 1, dy: 2)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        bounds.fill()
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: 0, width: 1, height: bounds.height).fill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }
}

// MARK: - Rows and cells

/// Region rows draw a quiet band like the Steps turn rows; the other rows are plain table rows.
final class AlignmentRowView: NSTableRowView {
    enum Kind { case row, region, fold, footer }
    var kind: Kind = .row

    override func drawBackground(in dirtyRect: NSRect) {
        switch kind {
        case .region:
            NSColor.windowBackgroundColor.setFill()
            bounds.fill()
            NSColor.separatorColor.setFill()
            NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
        case .row, .fold, .footer:
            super.drawBackground(in: dirtyRect)
        }
    }
}

/// A side of an aligned row: the op symbol, the action's object in monospace cut in the middle, and the failed mark.
/// On the selected row, when it is paired, the side the inspector shows has a 2 pt accent bar at its leading edge.
final class AlignmentActionCell: NSTableCellView {
    private let op = NSImageView()
    private let label = NSTextField(labelWithString: "")
    private let outcome = NSImageView()
    private let chosenBar = NSView()
    private static var images: [String: NSImage] = [:]

    var isChosen: Bool { !chosenBar.isHidden }

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        label.lineBreakMode = .byTruncatingMiddle
        label.usesSingleLineMode = true
        label.cell?.truncatesLastVisibleLine = true
        op.imageScaling = .scaleProportionallyDown
        outcome.imageScaling = .scaleProportionallyDown
        chosenBar.wantsLayer = true
        chosenBar.isHidden = true
        op.setAccessibilityElement(false)
        outcome.setAccessibilityElement(false)
        for v in [chosenBar, op, label, outcome] { addSubview(v) }
        textField = label
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(_ row: DiffResult.AlignmentRow, side: CompareSide, fonts: EventTableFonts, chosen: Bool) {
        guard let a = row.action(side) else {
            op.image = nil
            label.stringValue = ""
            outcome.image = nil
            chosenBar.isHidden = true
            toolTip = nil
            setAccessibilityLabel("\(side.letter): no action")
            return
        }
        let shown = CompareText.action(a)
        let size = fonts.mono.pointSize
        op.image = Self.image(AnalysisVocabulary.opSymbol(a.op), size: size)
        op.contentTintColor = .secondaryLabelColor
        label.stringValue = shown.text
        label.font = fonts.mono
        // Same rows recede, so the rows that differ carry the eye.
        label.textColor = row.status == .same ? .secondaryLabelColor : .labelColor
        if let mark = AnalysisVocabulary.outcomeSymbol(a.outcome) {
            outcome.image = Self.image(mark, size: size)
            outcome.contentTintColor = AnalysisVocabulary.outcomeColor(a.outcome)
        } else {
            outcome.image = nil
        }
        chosenBar.isHidden = !chosen
        chosenBar.layer?.backgroundColor = NSColor.controlAccentColor.cgColor
        toolTip = CompareText.sideHelp(a, row: row, side: side)
        setAccessibilityLabel("\(side.letter): " + CompareText.spoken(a) + (a.outcome == .failed ? ", failed" : ""))
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        let icon: CGFloat = 16
        op.frame = NSRect(x: 4, y: (h - icon) / 2, width: icon, height: icon)
        let mark: CGFloat = outcome.image == nil ? 0 : 16
        let font = label.font ?? .systemFont(ofSize: 12)
        let lh = ceil(font.ascender - font.descender + font.leading) + 1
        let x = op.frame.maxX + 5
        let available = bounds.width - x - (mark > 0 ? mark + 6 : 2)
        // The text's own width, so the failed mark follows the text; a label's intrinsic size lags a font change.
        let textWidth = min(available, ceil((label.stringValue as NSString).size(withAttributes: [.font: font]).width) + 4)
        label.frame = NSRect(x: x, y: (h - lh) / 2, width: max(0, textWidth), height: lh)
        outcome.frame = NSRect(x: label.frame.maxX + 2, y: (h - mark) / 2, width: mark, height: mark)
        chosenBar.frame = NSRect(x: 0, y: 3, width: 2, height: h - 6)
    }

    /// Symbols at the label's size and semibold, as the table's other symbols are: lighter, a 12 pt `pencil`, the
    /// commonest op, is a hairline beside `testtube.2` and `doc.text`.
    private static func image(_ name: String, size: CGFloat) -> NSImage? {
        let key = "\(name)|\(size)"
        if let i = images[key] { return i }
        let i = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: size, weight: .semibold))
        images[key] = i
        return i
    }
}

/// The status gutter: the status symbol in its color, then a paired row's confidence mark as text (≈ derived, ?
/// candidate).
final class AlignmentStatusCell: NSTableCellView {
    private let symbol = NSImageView()
    private let mark = NSTextField(labelWithString: "")

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        symbol.imageScaling = .scaleProportionallyDown
        symbol.setAccessibilityElement(false)
        mark.setAccessibilityElement(false)
        addSubview(symbol)
        addSubview(mark)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(_ row: DiffResult.AlignmentRow, fonts: EventTableFonts) {
        let size = fonts.digits.pointSize - 1
        symbol.image = NSImage(systemSymbolName: AnalysisVocabulary.statusSymbol(row.status), accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: size, weight: .semibold))
        symbol.contentTintColor = AnalysisVocabulary.statusColor(row.status)
        mark.stringValue = CompareText.pairingMark(row)
        mark.font = fonts.secondary
        mark.textColor = .secondaryLabelColor
        toolTip = CompareText.statusHelp(row)
        setAccessibilityLabel([AnalysisVocabulary.statusWord(row.status), CompareText.pairingWord(row)].compactMap { $0 }.joined(separator: ", "))
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        let icon: CGFloat = 14
        let mw = ceil(mark.intrinsicContentSize.width)
        let total = icon + (mw > 0 ? mw + 1 : 0)
        let x = max(0, (bounds.width - total) / 2)
        symbol.frame = NSRect(x: x, y: (h - icon) / 2, width: icon, height: icon)
        let mh = ceil(mark.intrinsicContentSize.height)
        mark.frame = NSRect(x: symbol.frame.maxX + 1, y: (h - mh) / 2, width: mw, height: mh)
    }
}

/// A full-width row: a region's group row ("Region 3" in the group-header role, then its rows and sides), a fold ("38
/// same actions (rows 41–78)") or a footer note. One label, so the line cuts once, at its tail, in an ellipsis.
final class AlignmentGroupCell: NSTableCellView {
    private let symbol = NSButton()
    private let label = NSTextField(labelWithString: "")
    /// The line, then shorter forms of it: layout shows the first that fits the visible width, else cuts the last.
    private var lines: [NSAttributedString] = []
    var onSymbol: (() -> Void)?

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        symbol.isBordered = false
        symbol.imagePosition = .imageOnly
        symbol.target = self
        symbol.action = #selector(tapped)
        symbol.setAccessibilityElement(false)
        label.lineBreakMode = .byTruncatingTail
        label.usesSingleLineMode = true
        label.cell?.truncatesLastVisibleLine = true
        addSubview(symbol)
        addSubview(label)
        textField = label
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// `details` is the line after the title, longest first.
    func configure(symbol name: String?, title: String?, details: [String], fonts: EventTableFonts, titleFont: NSFont, tooltip: String?) {
        onSymbol = nil
        symbol.image = name.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: fonts.secondary.pointSize, weight: .semibold)) }
        symbol.contentTintColor = .secondaryLabelColor
        symbol.isHidden = name == nil
        // An attributed value keeps its own line break mode, so the tail cut is in the string.
        let tail = NSMutableParagraphStyle()
        tail.lineBreakMode = .byTruncatingTail
        lines = details.map { detail in
            let text = NSMutableAttributedString()
            if let title {
                text.append(NSAttributedString(string: title, attributes: [.font: titleFont, .foregroundColor: NSColor.labelColor]))
                text.append(NSAttributedString(string: "  ·  ", attributes: [.font: fonts.secondary, .foregroundColor: NSColor.tertiaryLabelColor]))
            }
            text.append(NSAttributedString(string: detail, attributes: [.font: title == nil ? fonts.text : fonts.secondary,
                                                                         .foregroundColor: NSColor.secondaryLabelColor]))
            text.addAttribute(.paragraphStyle, value: tail, range: NSRange(location: 0, length: text.length))
            return text
        }
        toolTip = tooltip
        needsLayout = true
    }

    @objc private func tapped() { onSymbol?() }

    override func layout() {
        super.layout()
        let h = bounds.height
        var x: CGFloat = 6
        if !symbol.isHidden {
            symbol.frame = NSRect(x: x, y: (h - 16) / 2, width: 16, height: 16)
            x = symbol.frame.maxX + 4
        }
        let width = max(0, bounds.width - x - 8)
        let line = lines.first { ceil($0.size().width) <= width } ?? lines.last ?? NSAttributedString()
        if label.attributedStringValue != line { label.attributedStringValue = line }
        let lh = ceil(line.size().height) + 1
        label.frame = NSRect(x: x, y: (h - lh) / 2, width: width, height: lh)
    }
}

// MARK: - Minimap (§5.11)

/// A 12 pt strip beside the scroller with two lanes, A on the left and B on the right: rows only in one run mark that
/// run's lane, changed pairs mark both, each in its chip's color (a different outcome in the warn color, the others in
/// the secondary label color); same rows draw nothing. Position carries the meaning, so color is never alone. A click
/// selects the row there; the visible rows are framed. Its tooltip, and the ≠ above it, name it.
final class AlignmentMinimap: NSView {
    static let width: CGFloat = 12
    static let help = "Rows with differences, run A's lane on the left and run B's on the right: orange marks a different outcome, "
        + "grey a row only in one run or with a different target. Click to jump to a row; the frame shows the rows in view."

    override init(frame: NSRect) {
        super.init(frame: frame)
        toolTip = Self.help
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    struct Mark: Equatable {
        var position: Int
        var a: Bool
        var b: Bool
        var status: AlignmentStatus
    }

    private(set) var marks: [Mark] = []
    private var count = 0
    var viewport: Range<Int>? { didSet { if viewport != oldValue { needsDisplay = true } } }
    var onPick: ((Int) -> Void)?

    override var isFlipped: Bool { true }

    /// The marks of `items`, one per listed aligned row that is not the same in both runs.
    static func marks(_ items: [AlignmentItem], result: DiffResult?) -> [Mark] {
        guard let result else { return [] }
        return items.enumerated().compactMap { p, item in
            guard let i = item.rowPosition else { return nil }
            let s = result.alignment[i].status
            switch s {
            case .same: return nil
            case .leftOnly: return Mark(position: p, a: true, b: false, status: s)
            case .rightOnly: return Mark(position: p, a: false, b: true, status: s)
            default: return Mark(position: p, a: true, b: true, status: s)
            }
        }
    }

    func update(items: [AlignmentItem], result: DiffResult?) {
        marks = Self.marks(items, result: result)
        count = items.count
        axChildren = nil
        needsDisplay = true
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        axChildren = nil
    }

    private func y(_ position: Int) -> CGFloat {
        count == 0 ? 0 : bounds.height * CGFloat(position) / CGFloat(count)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        bounds.fill()
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: 0, width: 1, height: bounds.height).fill()
        guard count > 0 else { return }
        let h = max(1.5, bounds.height / CGFloat(count))
        let lane: CGFloat = 4
        for m in marks {
            AnalysisVocabulary.statusColor(m.status).setFill()
            let top = y(m.position)
            if m.a { NSRect(x: 2, y: top, width: lane, height: h).fill() }
            if m.b { NSRect(x: 2 + lane + 1, y: top, width: lane, height: h).fill() }
        }
        if let v = viewport {
            let r = NSRect(x: 1.5, y: y(v.lowerBound), width: bounds.width - 2, height: max(4, y(v.upperBound) - y(v.lowerBound)))
            NSColor.labelColor.withAlphaComponent(0.08).setFill()
            NSBezierPath(rect: r).fill()
            NSColor.tertiaryLabelColor.setStroke()
            let path = NSBezierPath(rect: r.insetBy(dx: 0.5, dy: 0.5))
            path.lineWidth = 1
            path.stroke()
        }
    }

    override func mouseDown(with event: NSEvent) {
        pick(event)
    }

    override func mouseDragged(with event: NSEvent) {
        pick(event)
    }

    private func pick(_ event: NSEvent) {
        guard count > 0, bounds.height > 0 else { return }
        let y = convert(event.locationInWindow, from: nil).y
        onPick?(max(0, min(count - 1, Int(y / bounds.height * CGFloat(count)))))
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    // One accessibility child per run of marks with the same lanes and status (DESIGN.md §10.3): a button that selects
    // the run's first row, as a click on it does. The children are made again only when the marks or the strip's size
    // change, so VoiceOver keeps its place among them; their frames are in the strip's space, so they hold as the window
    // moves.
    private var axChildren: [TimelineAXElement]?

    static let runHelp = "Selects the first of these rows in the alignment table"

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityLabel() -> String? {
        "Minimap of the differences: \(Formatters.count(marks.count, "row")) differ"
    }

    override func accessibilityChildren() -> [Any]? {
        if let axChildren { return axChildren }
        var runs: [(from: Mark, to: Mark)] = []
        for m in marks {
            if let last = runs.last, last.to.position + 1 == m.position, last.to.status == m.status {
                runs[runs.count - 1].to = m
            } else {
                runs.append((m, m))
            }
        }
        let children = runs.map { run in
            let e = TimelineAXElement()
            e.setAccessibilityParent(self)
            e.setAccessibilityRole(.button)
            let word = AnalysisVocabulary.statusWord(run.from.status)
            let rows = run.from.position == run.to.position ? "1 row" : "\(run.to.position - run.from.position + 1) rows"
            e.setAccessibilityLabel("\(word), \(rows)")
            e.setAccessibilityHelp(Self.runHelp)
            let r = NSRect(x: 0, y: y(run.from.position), width: bounds.width, height: max(2, y(run.to.position + 1) - y(run.from.position)))
            e.setAccessibilityFrameInParentSpace(r)
            e.press = { [weak self] in self?.onPick?(run.from.position) }
            return e
        }
        axChildren = children
        return children
    }
}
