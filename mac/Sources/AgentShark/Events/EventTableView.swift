import AppKit
import Quartz
import SwiftUI

/// The event table (MAC-SPEC §5): a view-based `NSTableView` over the window's `EventPager`, with fixed row
/// heights and cell reuse, so scrolling stays smooth over millions of rows.
struct EventTable: NSViewControllerRepresentable {
    let model: WindowModel

    func makeNSViewController(context: Context) -> EventTableController { EventTableController(model: model) }
    func updateNSViewController(_ controller: EventTableController, context: Context) {}

    static func dismantleNSViewController(_ controller: EventTableController, coordinator: ()) {
        controller.tearDown()
    }

    /// Take the space offered: measuring the table through Auto Layout would make its column widths, which the table
    /// fits to its width, part of its own size.
    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: EventTableController, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 600, height: proposal.height ?? 400)
    }
}

/// `NSTableView` that routes Copy, Copy as JSON, Space (Quick Look) and the preview panel to its controller.
final class EventNSTable: NSTableView, AgentSharkResponderActions {
    weak var controller: EventTableController?

    override func keyDown(with event: NSEvent) {
        if event.charactersIgnoringModifiers == " ", event.modifierFlags.intersection([.command, .control, .option]).isEmpty {
            controller?.toggleQuickLook()
            return
        }
        super.keyDown(with: event)
    }

    @objc func copy(_ sender: Any?) { controller?.copyRows(asJSON: false) }
    @objc func copyAsJSON(_ sender: Any?) { controller?.copyRows(asJSON: true) }

    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(copy(_:)) || item.action == #selector(copyAsJSON(_:)) { return !selectedRowIndexes.isEmpty }
        return super.validateUserInterfaceItem(item)
    }

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }
    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) { controller?.quickLook.attach(panel) }
    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) { controller?.quickLook.detach(panel) }
}

@MainActor final class EventTableController: NSViewController, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
    let model: WindowModel
    let tableView = EventNSTable()
    let quickLook = QuickLookSource()
    private let scrollView = ShadowedScrollView()
    private let headerMenu = NSMenu()
    private let rowMenu = NSMenu()
    private var loops: [ObservationLoop] = []
    private var pager: EventPager?
    /// Rows whose page arrived while the window was occluded, where reloading them may not draw them (DS1-14).
    private var loadedWhileHidden = IndexSet()
    private var generation = -1
    private var fonts = EventTableFonts(density: .compact)
    private var applyingModelState = false
    private var lastReveal = 0
    /// A new view opened on a selected event whose row was not known or not yet laid out: center it once it is.
    private var centerPending = false
    private var appliedPreset: ColumnPreset?
    private var scrollTest: ScrollTest?

    private static let rowViewID = NSUserInterfaceItemIdentifier("EventRow")
    private static let markCellID = NSUserInterfaceItemIdentifier("MarkCell")

    init(model: WindowModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        tableView.controller = self
        tableView.style = .fullWidth
        tableView.dataSource = self
        tableView.delegate = self
        tableView.allowsMultipleSelection = true
        tableView.allowsColumnReordering = true
        tableView.allowsColumnResizing = true
        tableView.allowsColumnSelection = false
        tableView.allowsTypeSelect = false
        tableView.usesAutomaticRowHeights = false
        tableView.usesAlternatingRowBackgroundColors = false
        tableView.gridStyleMask = []
        tableView.intercellSpacing = NSSize(width: 6, height: 0)
        // Summary takes what the other columns leave (§4.4); the fit sets its width, so nothing autoresizes.
        tableView.columnAutoresizingStyle = .noColumnAutoresizing
        tableView.setAccessibilityLabel("Events")
        headerMenu.delegate = self
        headerMenu.autoenablesItems = false
        rowMenu.delegate = self
        rowMenu.autoenablesItems = false
        tableView.menu = rowMenu

        scrollView.documentView = tableView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = true
        scrollView.contentView.postsBoundsChangedNotifications = true
        view = scrollView

        buildColumns()
        tableView.headerView?.menu = headerMenu
        NotificationCenter.default.addObserver(self, selector: #selector(boundsChanged), name: NSView.boundsDidChangeNotification,
                                               object: scrollView.contentView)
        scrollView.contentView.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(refit), name: NSView.frameDidChangeNotification, object: scrollView.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(refit), name: NSTableView.columnDidResizeNotification, object: tableView)
        NotificationCenter.default.addObserver(self, selector: #selector(refit), name: NSTableView.columnDidMoveNotification, object: tableView)
        model.eventTable = self
        quickLook.keyTarget = tableView
        startObserving()
    }

    /// A window that comes back on screen (another Space, a hidden app) redraws the realized rows whose page loaded
    /// while it was occluded, so no row stays a skeleton (DS1-14).
    override func viewDidAppear() {
        super.viewDidAppear()
        guard let window = view.window else { return }
        for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didBecomeKeyNotification] {
            NotificationCenter.default.removeObserver(self, name: name, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(windowCameBack), name: name, object: window)
        }
        windowCameBack()
    }

    @objc private func windowCameBack() {
        guard isOnScreen else { return }
        prefetchVisible()
        // Only rows loaded while hidden need it: reloading every visible row made each click into the window make every
        // cell of the table again.
        guard !loadedWhileHidden.isEmpty else { return }
        let rows = loadedWhileHidden
        loadedWhileHidden = IndexSet()
        rowsLoaded(rows)
    }

    private var isOnScreen: Bool { view.window?.occlusionState.contains(.visible) ?? false }

    func tearDown() {
        loops.forEach { $0.cancel() }
        loops.removeAll()
        pager?.onRowsLoaded = nil
        scrollTest?.stop()
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: Columns

    private func buildColumns() {
        let gutter = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(EventColumn.gutterID))
        gutter.title = ""
        gutter.width = 14
        gutter.minWidth = 14
        gutter.maxWidth = 14
        gutter.resizingMask = []
        gutter.headerToolTip = "Marked events (⌃⌘M)"
        tableView.addTableColumn(gutter)
        for c in EventColumn.all { tableView.addTableColumn(makeColumn(c)) }
        for field in model.customColumns { addCustomColumn(field) }
        applyPreset(model.columnPreset, fresh: false)
        appliedPreset = model.columnPreset
        // Restores the saved order, widths and visibility.
        tableView.autosaveName = "AgentShark.EventTable"
        tableView.autosaveTableColumns = true
        tableView.sortDescriptors = sortDescriptors(for: model.sort)
    }

    private func makeColumn(_ c: EventColumn) -> NSTableColumn {
        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(c.id))
        col.title = c.title
        col.width = c.width
        col.minWidth = c.minWidth
        col.headerToolTip = c.help
        col.headerCell.alignment = c.alignment
        col.resizingMask = c.id == EventColumn.summaryID ? [.autoresizingMask, .userResizingMask] : .userResizingMask
        if let key = c.sortKey { col.sortDescriptorPrototype = NSSortDescriptor(key: key, ascending: true) }
        return col
    }

    private func addCustomColumn(_ field: String) {
        let col = makeColumn(.custom(field))
        tableView.addTableColumn(col)
        // Custom columns go just before Summary.
        if let summary = columnIndex(EventColumn.summaryID), let index = columnIndex(col.identifier.rawValue), index > summary {
            tableView.moveColumn(index, toColumn: summary)
        }
    }

    private func columnIndex(_ id: String) -> Int? {
        let i = tableView.column(withIdentifier: NSUserInterfaceItemIdentifier(id))
        return i >= 0 ? i : nil
    }

    private func syncCustomColumns() {
        let wanted = Set(model.customColumns)
        for col in tableView.tableColumns where col.identifier.rawValue.hasPrefix(EventColumn.customPrefix) {
            if !wanted.contains(String(col.identifier.rawValue.dropFirst(EventColumn.customPrefix.count))) { tableView.removeTableColumn(col) }
        }
        for field in model.customColumns where columnIndex(EventColumn.customPrefix + field) == nil {
            addCustomColumn(field)
        }
    }

    /// Show the preset's columns. `fresh` (a preset or Reset Columns the person chose) also forgets which columns the
    /// fit hid; at launch they stay remembered, because the table's saved state records them as hidden.
    private func applyPreset(_ preset: ColumnPreset, fresh: Bool = true) {
        let visible = Set(preset.columns)
        for col in tableView.tableColumns {
            let id = col.identifier.rawValue
            guard EventColumn.byID[id] != nil else { continue }
            col.isHidden = !visible.contains(id)
        }
        if fresh { autoHidden = [] }
        refit()
    }

    // MARK: Fit (DESIGN.md §4.4)

    private static let autoHiddenKey = "AgentShark.EventTable.autoHidden"
    /// Columns the fit hid (not the person): they come back when the table widens.
    private var autoHidden: Set<String> = Set(UserDefaults.standard.stringArray(forKey: autoHiddenKey) ?? []) {
        didSet {
            if autoHidden != oldValue { UserDefaults.standard.set(Array(autoHidden).sorted(), forKey: Self.autoHiddenKey) }
        }
    }
    private var fitting = false

    /// Summary takes what the other columns leave, at least 320 pt and 45% of the width; when it cannot, P4 and then P3
    /// columns hide (rightmost first) and the workspace header says how many. The other columns keep the widths the
    /// person gave them.
    @objc private func refit() {
        guard !fitting, let summary = tableView.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier(EventColumn.summaryID)) else { return }
        let width = scrollView.contentView.bounds.width
        guard width > 0 else { return }
        fitting = true
        defer { fitting = false }
        let wanted = tableView.tableColumns.filter { !$0.isHidden || autoHidden.contains($0.identifier.rawValue) }
        let specs = wanted.map { col -> ColumnFit.Spec in
            let id = col.identifier.rawValue
            if id == EventColumn.summaryID { return .init(id: id, min: 320, max: 100_000, priority: 1, primary: true) }
            let w = col.isHidden ? (EventColumn.byID[id]?.width ?? col.width) : col.width
            return .init(id: id, min: w, max: w, priority: EventColumn.priority(id))
        }
        let fit = ColumnFit.fit(specs, width: width, spacing: tableView.intercellSpacing.width)
        let hidden = Set(fit.hidden)
        for col in wanted {
            let hide = hidden.contains(col.identifier.rawValue)
            if col.isHidden != hide { col.isHidden = hide }
        }
        autoHidden = hidden
        if let w = fit.widths[EventColumn.summaryID], abs(summary.width - w) > 0.5 { summary.width = w }
        // The header reads this; a layout pass must not change what SwiftUI is updating, so it lands on the next turn.
        let titles = wanted.filter { hidden.contains($0.identifier.rawValue) }.map(\.title)
        DispatchQueue.main.async { [weak self] in
            if let model = self?.model, model.autoHiddenEventColumns != titles { model.autoHiddenEventColumns = titles }
        }
    }

    /// The Columns menu of the workspace header (§7.3): the header menu, at the pointer.
    func showColumnsMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        buildHeaderMenu(menu)
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }

    /// Back to the preset's columns, widths and order (header menu ▸ Reset Columns).
    private func resetColumns() {
        for (i, c) in EventColumn.all.enumerated() {
            guard let index = columnIndex(c.id) else { continue }
            tableView.tableColumns[index].width = c.width
            if index != i + 1 { tableView.moveColumn(index, toColumn: i + 1) }
        }
        applyPreset(model.columnPreset)
    }

    private func sortDescriptors(for sort: (key: String, ascending: Bool)) -> [NSSortDescriptor] {
        [NSSortDescriptor(key: sort.key, ascending: sort.ascending)]
    }

    // MARK: Following the model

    private func startObserving() {
        loops.append(ObservationLoop { [weak self] in self?.followView() })
        loops.append(ObservationLoop { [weak self] in self?.followSelection() })
        loops.append(ObservationLoop { [weak self] in self?.followDisplay() })
        loops.append(ObservationLoop { [weak self] in self?.followColumns() })
    }

    private func followView() {
        let gen = model.viewGeneration
        let newPager = model.pager
        guard gen != generation || newPager !== pager else { return }
        generation = gen
        // A table that has shown no rows yet (the workspace just appeared) has no position to keep: it starts on the
        // selected event even when the view's last change was a live refresh.
        let keepPosition = model.viewChangeReason == .refresh && pager != nil
        pager?.onRowsLoaded = nil
        pager = newPager
        pager?.onRowsLoaded = { [weak self] rows in self?.rowsLoaded(rows) }
        loadedWhileHidden = IndexSet()
        let origin = scrollView.contentView.bounds.origin
        widenNumberColumn()
        applyingModelState = true
        tableView.reloadData()
        if let row = model.selectedRow, row < tableView.numberOfRows {
            tableView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        } else {
            tableView.deselectAll(nil)
        }
        applyingModelState = false
        if keepPosition {
            scrollView.contentView.scroll(to: origin)
            scrollView.reflectScrolledClipView(scrollView.contentView)
        } else {
            tableView.scrollRowToVisible(0)
            centerPending = model.selectedEvent != nil
            centerSelectionIfPending()
        }
        prefetchVisible()
        startScrollTestIfRequested()
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        centerSelectionIfPending()
    }

    /// The table opens on the selected event: once its row is known and the table has its height, center it.
    private func centerSelectionIfPending() {
        guard centerPending, let row = model.selectedRow, row < tableView.numberOfRows, scrollView.contentView.bounds.height > 1 else { return }
        centerPending = false
        scrollRowToCenter(row)
        prefetchVisible()
    }

    private func followSelection() {
        let row = model.selectedRow
        let reveal = model.revealRequest
        _ = model.viewGeneration
        guard pager != nil else { return }
        applyingModelState = true
        if let row, row < tableView.numberOfRows {
            if !tableView.selectedRowIndexes.contains(row) || tableView.selectedRow != row {
                tableView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            }
        } else if row == nil, !tableView.selectedRowIndexes.isEmpty {
            // No selection, or the selected event is not in this view.
            tableView.deselectAll(nil)
        }
        applyingModelState = false
        if model.selectedEvent == nil { centerPending = false }
        centerSelectionIfPending()
        if reveal != lastReveal {
            lastReveal = reveal
            if let row, row < tableView.numberOfRows { scrollRowToCenter(row) }
        }
    }

    private func followDisplay() {
        let prefs = model.app.preferences
        fonts = EventTableFonts(density: prefs.rowDensity)
        if tableView.rowHeight != fonts.rowHeight { tableView.rowHeight = fonts.rowHeight }
        let format = model.timeFormat
        let reference = model.timeReference
        if let time = columnIndex("time") {
            tableView.tableColumns[time].title = reference != nil ? "Time (from Ref)" : Formatters.timeColumnTitle(format, at: model.view?.firstTs)
        }
        _ = model.marks
        _ = model.app.colorRules.rules
        _ = model.store.sessionLabelsGeneration
        // Reload after this pass, outside the observation: configuring a row reads the whole session list, which every
        // index run changes, so reloading here would make every index run reload every visible row.
        Task { @MainActor [weak self] in self?.reloadVisibleRows() }
    }

    private func followColumns() {
        let preset = model.columnPreset
        _ = model.customColumns
        syncCustomColumns()
        if appliedPreset != preset {
            appliedPreset = preset
            applyPreset(preset)
        }
        let descriptors = sortDescriptors(for: model.sort)
        if tableView.sortDescriptors != descriptors {
            applyingModelState = true
            tableView.sortDescriptors = descriptors
            applyingModelState = false
        }
    }

    /// Scroll so `row` is in the middle of the area below the header (the clip view starts under it).
    /// The No. column grows to fit the largest row number of the view (it never shrinks a width the person set).
    private func widenNumberColumn() {
        guard let pager, let index = columnIndex("no") else { return }
        let text = Formatters.count(pager.count) as NSString
        let needed = ceil(text.size(withAttributes: [.font: fonts.digits]).width) + 16
        let column = tableView.tableColumns[index]
        if column.width < needed { column.width = needed }
    }

    private func scrollRowToCenter(_ row: Int) {
        let rect = tableView.rect(ofRow: row)
        let clip = scrollView.contentView
        let inset = clip.contentInsets.top
        var visible = clip.bounds
        visible.origin.y += inset
        visible.size.height -= inset
        guard !visible.contains(rect) else { return }
        let maxY = max(-inset, tableView.bounds.height - clip.bounds.height)
        let y = min(maxY, max(-inset, rect.midY - visible.height / 2 - inset))
        clip.scroll(to: NSPoint(x: clip.bounds.minX, y: y))
        scrollView.reflectScrolledClipView(clip)
    }

    // MARK: Paging

    private var visibleRows: Range<Int> {
        let r = tableView.rows(in: scrollView.contentView.bounds)
        return r.location..<(r.location + r.length)
    }

    @objc private func boundsChanged() {
        prefetchVisible()
    }

    private func prefetchVisible() {
        let rows = visibleRows
        guard let pager, !rows.isEmpty else { return }
        pager.prefetch(around: rows)
    }

    private func rowsLoaded(_ rows: IndexSet) {
        if !isOnScreen { loadedWhileHidden.formUnion(rows) }
        let visible = visibleRows
        var hit = IndexSet()
        for r in rows where visible.contains(r) { hit.insert(r) }
        // Rows the table realized even where the clip view's bounds are stale (an occluded window): redraw them too.
        tableView.enumerateAvailableRowViews { _, r in if rows.contains(r) { hit.insert(r) } }
        // Δ and "since previous" of the row after a page depend on the page's last row.
        if let last = rows.last, visible.contains(last + 1) { hit.insert(last + 1) }
        guard !hit.isEmpty else { return }
        reload(rows: hit)
    }

    private func reloadVisibleRows() {
        let rows = visibleRows
        guard !rows.isEmpty, tableView.numberOfRows > 0 else { return }
        reload(rows: IndexSet(integersIn: rows))
    }

    private func reload(rows: IndexSet) {
        let valid = rows.filteredIndexSet { $0 < tableView.numberOfRows }
        guard !valid.isEmpty else { return }
        tableView.reloadData(forRowIndexes: valid, columnIndexes: IndexSet(integersIn: 0..<tableView.numberOfColumns))
        for r in valid {
            if let rowView = tableView.rowView(atRow: r, makeIfNecessary: false) as? EventRowView { configure(rowView, row: r) }
        }
    }

    // MARK: Data source and delegate

    func numberOfRows(in tableView: NSTableView) -> Int { pager?.count ?? 0 }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = tableView.makeView(withIdentifier: Self.rowViewID, owner: nil) as? EventRowView ?? {
            let v = EventRowView()
            v.identifier = Self.rowViewID
            return v
        }()
        configure(view, row: row)
        return view
    }

    private func configure(_ rowView: EventRowView, row: Int) {
        guard let r = pager?.row(at: row) else {
            rowView.kindColor = nil
            rowView.tint = nil
            rowView.outline = nil
            return
        }
        rowView.kindColor = Theme.kindColor(r.kind, toolName: r.toolName)
        rowView.tint = model.app.colorRules.rowTint(forRuleID: r.colorRule)
        rowView.outline = model.app.colorRules.outline(forRuleID: r.colorRule)
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let tableColumn else { return nil }
        let id = tableColumn.identifier.rawValue
        if id == EventColumn.gutterID {
            let cell = tableView.makeView(withIdentifier: Self.markCellID, owner: nil) as? MarkCell ?? {
                let c = MarkCell()
                c.identifier = Self.markCellID
                return c
            }()
            cell.isMarked = pager?.row(at: row).map { model.marks.contains($0.id) } ?? false
            return cell
        }
        let cellID = NSUserInterfaceItemIdentifier("cell." + id)
        let cell = tableView.makeView(withIdentifier: cellID, owner: nil) as? EventTextCell ?? EventTextCell(identifier: cellID)
        guard let pager, let r = pager.row(at: row) else {
            if self.pager?.isFailed(row) == true {
                cell.configure(id == EventColumn.summaryID ? "Not loaded" : "", font: fonts.text, color: .tertiaryLabelColor)
            } else {
                cell.configurePlaceholder()
            }
            return cell
        }
        configure(cell, column: id, row: r, index: row, pager: pager)
        return cell
    }

    private func configure(_ cell: EventTextCell, column id: String, row r: EventRow, index: Int, pager: EventPager) {
        let dim = r.isDimmed
        let missing = Formatters.missing
        switch id {
        case "no":
            cell.configure(r.no.map(Formatters.count) ?? Formatters.count(index + 1), font: fonts.digits, color: .secondaryLabelColor,
                           alignment: .right, dimmed: dim)
        case "time":
            let format = model.timeFormat
            var text: String
            if format == .deltaPrev, index > 0, pager.row(at: index - 1) == nil {
                text = "…"
            } else {
                text = Formatters.time(r.ts, format: format, first: model.view?.firstTs, prev: index > 0 ? pager.row(at: index - 1)?.ts : nil,
                                       sessionStart: model.store.sessionsByID[r.session]?.start)
            }
            if format == .relSession, model.store.sessionsByID[r.session]?.start == nil { text = missing }
            if let ref = model.timeReference { text = Formatters.reference(r.ts - ref) }
            let source = r.tsSrc == "logged" ? "" : "\nTimestamp \(r.tsSrc): \(r.tsSrc == "inherited" ? "copied from the previous record" : "not logged")"
            cell.configure(text, font: fonts.digits, color: r.tsSrc == "logged" ? .labelColor : .secondaryLabelColor, alignment: .right, dimmed: dim,
                           tooltip: Formatters.timestamp(r.ts) + "\n" + Formatters.timestamp(r.ts, utc: true) + source)
        case "delta":
            let prev = index > 0 ? pager.row(at: index - 1)?.ts : nil
            // Δ is unsigned (DESIGN.md §9); a list sorted by another column can go back in time, which reads "−".
            cell.configure(prev.map { Formatters.duration(r.ts - $0) } ?? (index == 0 ? missing : "…"), font: fonts.digits,
                           color: .secondaryLabelColor, alignment: .right, dimmed: dim)
        case "session":
            let s = model.store.sessionsByID[r.session]
            let title = s?.displayTitle ?? r.session
            cell.configure(title, font: fonts.text, dimmed: dim,
                           tooltip: [title, r.session, s.map { "\($0.agent.label) · \($0.role)" }].compactMap { $0 }.joined(separator: "\n"))
        case "agent":
            // The agent's dot before its name (§5.2 item 4).
            cell.configure(r.agent.label, font: fonts.text, symbolName: "circle.fill", symbolTint: Theme.agentColor(r.agent), dimmed: dim)
        case "actor":
            cell.configure(r.actor.rawValue, font: fonts.text, color: .secondaryLabelColor, dimmed: dim)
        case "kind":
            let fg = model.app.colorRules.colors(forRuleID: r.colorRule).foreground
            cell.configure(r.kind.rawValue, font: fonts.mono, color: fg ?? .labelColor, symbolName: Symbols.eventKind(r.kind), dimmed: dim)
        case "proto":
            cell.configure(r.proto, font: fonts.mono, color: .secondaryLabelColor, dimmed: dim, tooltip: r.proto)
        case "tool":
            cell.configure(r.toolName ?? missing, font: fonts.text, color: r.toolName == nil ? .tertiaryLabelColor : .labelColor, dimmed: dim)
        case "model":
            cell.configure(r.model ?? missing, font: fonts.text, color: r.model == nil ? .tertiaryLabelColor : .secondaryLabelColor, dimmed: dim)
        case "duration":
            if r.kind == .llmError || r.kind == .llmRefusal {
                cell.configure(missing, font: fonts.digits, color: .tertiaryLabelColor, alignment: .right, dimmed: dim,
                               tooltip: "An API error or refusal has no duration of its own; the time since the request is a timestamp gap, not how long the error took.")
            } else if let dur = r.dur {
                cell.configure(Formatters.duration(dur, src: nil), font: fonts.digits, alignment: .right, dimmed: dim,
                               tooltip: "\(Formatters.count(Int(dur))) µs. Select the event to see how this duration was measured.")
            } else {
                cell.configure(missing, font: fonts.digits, color: .tertiaryLabelColor, alignment: .right, dimmed: dim,
                               tooltip: "No duration: this event does not open or close a measured span.")
            }
        case "tokens":
            if r.tokIn == nil && r.tokOut == nil {
                cell.configure(missing, font: fonts.digits, color: .tertiaryLabelColor, alignment: .right, dimmed: dim,
                               tooltip: "No token counts on this event.")
            } else {
                cell.configure("\(Formatters.tokens(r.tokIn)) → \(Formatters.tokens(r.tokOut))", font: fonts.digits, alignment: .right,
                               dimmed: dim, tooltip: "Input \(r.tokIn.map(Formatters.count) ?? missing) (incl. cache) → output \(r.tokOut.map(Formatters.count) ?? missing)")
            }
        case "tokIn":
            cell.configure(Formatters.tokens(r.tokIn), font: fonts.digits, color: r.tokIn == nil ? .tertiaryLabelColor : .labelColor,
                           alignment: .right, dimmed: dim)
        case "tokOut":
            cell.configure(Formatters.tokens(r.tokOut), font: fonts.digits, color: r.tokOut == nil ? .tertiaryLabelColor : .labelColor,
                           alignment: .right, dimmed: dim)
        case "tier":
            // A Plain tier word in its tier color (§6.2); — for an event that is not a failure.
            let tier = r.extra?[EventColumn.tierField]?.stringValue.map(FailureTier.init(rawValue:))
            cell.configure(tier?.rawValue ?? missing, font: fonts.text, color: tier.map(DerivedStyle.tierColor) ?? .tertiaryLabelColor, dimmed: dim,
                           tooltip: tier == nil ? "Not a failure" : nil)
        case EventColumn.summaryID:
            let fg = model.app.colorRules.colors(forRuleID: r.colorRule).foreground
            let text = summaryText(r)
            var tip = text
            let notable = r.flags.filter { $0 != "error" }
            if !notable.isEmpty { tip += "\nFlags: " + notable.joined(separator: ", ") }
            cell.configure(text.isEmpty ? missing : text, font: fonts.text, color: fg ?? .labelColor,
                           symbolName: r.isError ? Mark.failed.symbol : nil, symbolTint: Theme.err, dimmed: dim,
                           tooltip: tip.count > 2000 ? String(tip.prefix(2000)) + "…" : tip)
            cell.symbol.setAccessibilityLabel(r.isError ? "Error" : nil)
        default:
            if id.hasPrefix(EventColumn.customPrefix) {
                let field = String(id.dropFirst(EventColumn.customPrefix.count))
                let value = r.extra?[field]
                let isNumber = value?.doubleValue != nil
                cell.configure(value.map { $0.isNull ? missing : $0.displayText } ?? missing, font: isNumber ? fonts.digits : fonts.text,
                               color: value == nil || value?.isNull == true ? .tertiaryLabelColor : .labelColor,
                               alignment: isNumber ? .right : .left, dimmed: dim)
            }
        }
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !applyingModelState else { return }
        centerPending = false
        let row = tableView.selectedRow
        guard row >= 0 else { return }
        // Not inside the delegate callback: selecting may load rows and update the table.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.tableView.selectedRow == row else { return }
            self.model.select(row: row)
            if QuickLookSource.isVisible { self.updateQuickLook() }
        }
    }

    func tableView(_ tableView: NSTableView, sortDescriptorsDidChange oldDescriptors: [NSSortDescriptor]) {
        guard !applyingModelState, let d = tableView.sortDescriptors.first, let key = d.key else { return }
        DispatchQueue.main.async { [weak self] in self?.model.sort = (key, d.ascending) }
    }

    func tableView(_ tableView: NSTableView, shouldReorderColumn columnIndex: Int, toColumn newColumnIndex: Int) -> Bool {
        columnIndex != 0 && newColumnIndex != 0
    }

    /// The Summary in the §9 form; a duration the visible Duration column shows is left out (Principle 2).
    private func summaryText(_ r: EventRow) -> String {
        let durationShown = r.dur != nil && tableView.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier("duration"))?.isHidden == false
        return EventSummary.display(r.summary, kind: r.kind, durationShown: durationShown)
    }

    // MARK: Menus

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        if menu === headerMenu { buildHeaderMenu(menu) } else { buildRowMenu(menu) }
    }

    private func buildHeaderMenu(_ menu: NSMenu) {
        for col in tableView.tableColumns where col.identifier.rawValue != EventColumn.gutterID {
            let id = col.identifier.rawValue
            let title = (id == "time" ? "Time" : col.title) + (autoHidden.contains(id) ? " (does not fit)" : "")
            let shown = !col.isHidden || autoHidden.contains(id)
            menu.addItem(title, enabled: id != EventColumn.summaryID, state: shown ? .on : .off) { [weak col, weak self] in
                guard let col, let self else { return }
                if shown {
                    col.isHidden = true
                    self.autoHidden.remove(id)
                } else {
                    col.isHidden = false
                }
                self.refit()
            }
        }
        menu.addItem(.separator())
        for preset in ColumnPreset.allCases {
            menu.addItem(preset.title, state: model.columnPreset == preset ? .on : .off) { [weak self] in
                guard let self else { return }
                self.model.columnPreset = preset
                self.appliedPreset = preset
                self.applyPreset(preset)
            }
        }
        menu.addItem("Reset Columns") { [weak self] in self?.resetColumns() }
        // SPEC §12.7 Events: the derived columns, when the engine has the analysis fields.
        let derived = [("Step", "step"), ("Tier", "failure.tier"), ("Signature", "signature"), ("Outcome", "episode.outcome")]
            .filter { model.store.fieldNames.contains($0.1) }
        if !derived.isEmpty {
            menu.addItem(.separator())
            for (title, field) in derived {
                let on = model.customColumns.contains(field)
                menu.addItem(title, state: on ? .on : .off) { [weak self] in
                    if on { self?.model.removeColumn(field: field) } else { self?.model.addColumn(field: field) }
                }
            }
        }
        menu.addItem(.separator())
        menu.addItem("Add Column…") { [weak self] in self?.promptForColumn() }
        for field in model.customColumns {
            menu.addItem("Remove Column “\(field)”") { [weak self] in self?.model.removeColumn(field: field) }
        }
    }

    private func promptForColumn() {
        let alert = NSAlert()
        alert.messageText = "Add Column"
        alert.informativeText = "Enter a filter field, such as tool.exit_code or native.message.usage.service_tier."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 22))
        field.font = Theme.codeFont(size: 12)
        field.placeholderString = "tool.exit_code"
        alert.accessoryView = field
        alert.addButton(withTitle: "Add")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard let window = view.window else { return }
        alert.beginSheetModal(for: window) { [weak self] response in
            let name = field.stringValue.trimmingCharacters(in: .whitespaces)
            guard response == .alertFirstButtonReturn, !name.isEmpty else { return }
            self?.model.addColumn(field: name)
        }
    }

    private func buildRowMenu(_ menu: NSMenu) {
        let index = tableView.clickedRow
        guard index >= 0, let r = pager?.row(at: index) else { return }
        let model = self.model
        menu.addItem("Show in Session", symbol: SessionMode.steps.symbol) { [weak self] in
            model.select(event: r.id, reveal: false)
            self?.model.showInSession()
        }
        menu.addItem("Follow Session", symbol: SessionMode.transcript.symbol) { [weak self] in self?.show(r, in: .session, mode: .transcript) }
        menu.addItem("Show in Timeline", symbol: "chart.bar.xaxis") { [weak self] in self?.show(r, in: .timeline) }
        menu.addItem("Show in Flow", symbol: SessionMode.flow.symbol) { [weak self] in self?.show(r, in: .session, mode: .flow) }
        // The critical path of the event's whole run; the view selects the segment of the event's own lane that holds
        // the event, or says none does.
        menu.addItem("Show in Critical Path", symbol: SessionMode.criticalPath.symbol) { [weak self] in
            self?.show(r, in: .session, mode: .criticalPath)
        }
        menu.addItem(.separator())
        var fragments: [(String, String)] = []
        if let tool = r.toolName { fragments.append(("Tool “\(tool)”", FilterExpression.tool(tool))) }
        fragments.append(("Kind “\(r.kind.rawValue)”", FilterExpression.kind(r.kind)))
        fragments.append(("Session “\(model.store.title(of: r.session))”", FilterExpression.session(r.session)))
        menu.addSubmenu("Apply as Filter") { sub in
            for (title, fragment) in fragments {
                sub.addSubmenu(title) { $0.addCombineModes { model.applyFilter(fragment: fragment, mode: $0) } }
            }
        }
        menu.addSubmenu("Prepare as Filter") { sub in
            for (title, fragment) in fragments {
                sub.addSubmenu(title) { $0.addCombineModes { model.prepareFilter(fragment: fragment, mode: $0) } }
            }
        }
        menu.addItem(.separator())
        let marked = model.marks.contains(r.id)
        menu.addItem(marked ? "Unmark" : "Mark", symbol: marked ? "circle" : "circle.fill") {
            if model.marks.contains(r.id) { model.marks.remove(r.id) } else { model.marks.insert(r.id) }
        }
        menu.addItem(.separator())
        menu.addItem("Copy Summary") { [weak self] in AppKitHelpers.copy(self?.summaryText(r) ?? r.summary) }
        menu.addItem("Copy Event ID") { AppKitHelpers.copy(r.id) }
        menu.addItem("Copy Source Location") { [weak self] in
            self?.withDetail(of: r) { d in AppKitHelpers.copy("\(d.event.raw.path ?? d.event.raw.source):\(d.event.raw.line)") }
        }
        menu.addItem("Reveal Source File in Finder", symbol: "folder") { [weak self] in
            self?.withDetail(of: r) { d in
                if let path = d.event.raw.path { AppKitHelpers.revealInFinder(path) } else { NSSound.beep() }
            }
        }
        let canSpawn = r.kind == .agentSpawn || (r.toolName.map { ToolKinds.agent.contains($0) } ?? false)
        if canSpawn {
            menu.addItem(.separator())
            menu.addItem("Open Child Session", symbol: "arrow.down.right.circle") { [weak self] in
                self?.withDetail(of: r) { d in
                    let child = d.event.attrs["agent"]?["link_session"]?.stringValue ?? d.span?.linkSession
                        ?? d.spanChain.last { $0.linkSession != nil }?.linkSession
                    if let child { model.openSession(child) } else { NSSound.beep() }
                }
            }
        }
    }

    private func show(_ r: EventRow, in workspace: Workspace, mode: SessionMode? = nil) {
        Self.show(event: r.id, session: r.session, in: workspace, mode: mode, model: model)
    }

    /// Follow Session, Show in Timeline, Show in Flow and Show in Critical Path for a row: keep the scope when it already
    /// covers the row's session, otherwise narrow it to that session (keeping the time range).
    ///
    /// Show in Critical Path analyses the event's whole run instead (ANALYSIS-UX §4.10): its root stays in scope, or
    /// becomes the scope, so a subagent's event shows on the run's path rather than opening the subagent's own. An empty
    /// scope is narrowed too, since the mode would otherwise show the selected event's own session.
    static func show(event: String, session: String, in workspace: Workspace, mode: SessionMode? = nil, model: WindowModel) {
        model.select(event: event, reveal: false)
        if let mode { model.sessionMode = mode }
        if mode == .criticalPath {
            let root = runRoot(of: session, in: model.sessionsByID)
            if model.scope.sessions.contains(root) {
                model.singleSessionChoice = root
                model.workspace = workspace
            } else {
                model.openSession(root, workspace: workspace)
            }
        } else if model.scope.sessions.isEmpty || model.scope.sessions.contains(session) || workspace == .timeline {
            model.singleSessionChoice = session
            model.workspace = workspace
        } else {
            model.openSession(session, workspace: workspace)
        }
    }

    /// The top-level run `session` belongs to, up the `parentId` chain of the catalog. Where the chain leaves the
    /// catalog, the last row it reached names its root; a session the catalog does not know is its own run.
    static func runRoot(of session: String, in sessions: [String: SessionRow]) -> String {
        var id = session
        var seen: Set<String> = [id]
        while let row = sessions[id], let parent = row.parentId {
            guard sessions[parent] != nil else { return row.rootId.isEmpty ? parent : row.rootId }
            guard seen.insert(parent).inserted else { break }
            id = parent
        }
        return id
    }

    /// Run `body` with the row's event detail (the loaded one when it is selected).
    private func withDetail(of r: EventRow, _ body: @escaping @MainActor (EventDetail) -> Void) {
        if let d = model.eventDetail, d.event.id == r.id { body(d); return }
        guard let api = model.engine.api else { NSSound.beep(); return }
        Task {
            if let d = try? await api.event(r.id) { body(d) } else { NSSound.beep() }
        }
    }

    // MARK: Copy

    /// Copy the selected rows as tab-separated text (visible columns) or as JSON.
    func copyRows(asJSON: Bool) {
        guard let pager else { return }
        let selected = tableView.selectedRowIndexes
        guard !selected.isEmpty else { return }
        let limit = 50_000
        if selected.count > limit {
            let alert = NSAlert()
            alert.messageText = "Too Many Rows to Copy"
            alert.informativeText = "Copy works on up to \(Formatters.count(limit)) rows. Narrow the filter, or use File ▸ Export Capture… for larger sets."
            if let window = view.window { alert.beginSheetModal(for: window) } else { alert.runModal() }
            return
        }
        let columns = tableView.tableColumns.filter { !$0.isHidden && $0.identifier.rawValue != EventColumn.gutterID }
        Task { [weak self] in
            var rows: [(Int, EventRow)] = []
            for range in selected.rangeView {
                guard let loaded = try? await pager.rows(in: range) else { NSSound.beep(); return }
                rows += zip(range, loaded).map { ($0, $1) }
            }
            guard let self else { return }
            if asJSON {
                AppKitHelpers.copy(JSONValue.array(rows.map { .object($0.1.jsonObject) }).prettyPrinted)
            } else {
                let lines = rows.map { index, r in
                    columns.map { self.plainText(column: $0.identifier.rawValue, row: r, index: index, pager: pager) }.joined(separator: "\t")
                }
                AppKitHelpers.copy(lines.joined(separator: "\n"))
            }
        }
    }

    /// Cell text for copying; times are full timestamps with their UTC offset.
    private func plainText(column id: String, row r: EventRow, index: Int, pager: EventPager) -> String {
        switch id {
        case "no": return r.no.map(String.init) ?? String(index + 1)
        case "time": return Formatters.iso8601(r.ts)
        case "delta": return index > 0 ? pager.row(at: index - 1).map { Formatters.offset(r.ts - $0.ts) } ?? "" : ""
        case "session": return model.store.title(of: r.session)
        case "agent": return r.agent.rawValue
        case "actor": return r.actor.rawValue
        case "kind": return r.kind.rawValue
        case "proto": return r.proto
        case "tool": return r.toolName ?? ""
        case "model": return r.model ?? ""
        case "duration": return r.dur.map { Formatters.duration($0, src: nil) } ?? ""
        case "tokens": return r.tokIn == nil && r.tokOut == nil ? "" : "\(r.tokIn.map(String.init) ?? "") → \(r.tokOut.map(String.init) ?? "")"
        case "tokIn": return r.tokIn.map(String.init) ?? ""
        case "tokOut": return r.tokOut.map(String.init) ?? ""
        case "tier": return r.extra?[EventColumn.tierField]?.stringValue ?? ""
        case EventColumn.summaryID: return summaryText(r)
        default:
            guard id.hasPrefix(EventColumn.customPrefix) else { return "" }
            return r.extra?[String(id.dropFirst(EventColumn.customPrefix.count))]?.displayText ?? ""
        }
    }

    // MARK: Quick Look

    func toggleQuickLook() {
        if QuickLookSource.isVisible {
            QuickLookSource.close()
        } else {
            updateQuickLook()
        }
    }

    private func updateQuickLook() {
        guard let id = model.selectedEvent else { NSSound.beep(); return }
        let api = model.engine.api
        let loaded = model.eventDetail?.event.id == id ? model.eventDetail : nil
        Task { [weak self] in
            var detail = loaded
            if detail == nil { detail = try? await api?.event(id) }
            guard let self, let detail, self.model.selectedEvent == id,
                  let url = await QuickLookSource.previewFile(for: detail, api: api) else { return }
            self.quickLook.show(url)
        }
    }

    // MARK: Scroll test (AGENTSHARK_SCROLL_TEST=1)

    private func startScrollTestIfRequested() {
        guard scrollTest == nil, ProcessInfo.processInfo.environment["AGENTSHARK_SCROLL_TEST"] == "1",
              let pager, pager.count > 10_000 else { return }
        scrollTest = ScrollTest(scrollView: scrollView, table: tableView)
        scrollTest?.start()
    }
}

/// Debug scroll benchmark: scrolls the table for a few seconds with a display link and logs frame times to
/// stderr. Enabled with the AGENTSHARK_SCROLL_TEST=1 environment variable.
@MainActor final class ScrollTest: NSObject {
    private weak var scrollView: NSScrollView?
    private weak var table: NSTableView?
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var frames: [Double] = []
    private var started: CFTimeInterval = 0
    /// Points per frame: 900 is a full screen of new rows every frame (dragging the scroller); AGENTSHARK_SCROLL_STRIDE overrides it.
    private let stride = CGFloat(Double(ProcessInfo.processInfo.environment["AGENTSHARK_SCROLL_STRIDE"] ?? "") ?? 900)
    private let duration: CFTimeInterval = 8

    init(scrollView: NSScrollView, table: NSTableView) {
        self.scrollView = scrollView
        self.table = table
    }

    func start() {
        guard let table else { return }
        link = table.displayLink(target: self, selector: #selector(step(_:)))
        link?.add(to: .main, forMode: .common)
        started = CACurrentMediaTime()
        last = started
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func step(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        frames.append((now - last) * 1000)
        last = now
        guard let scrollView, let table else { return stop() }
        let clip = scrollView.contentView
        var origin = clip.bounds.origin
        origin.y += stride
        // Jump far now and then, like dragging the scroller knob.
        if frames.count % 60 == 0 { origin.y = CGFloat.random(in: 0...max(0, table.bounds.height - clip.bounds.height)) }
        if origin.y > table.bounds.height - clip.bounds.height { origin.y = 0 }
        clip.scroll(to: origin)
        scrollView.reflectScrolledClipView(clip)
        if now - started > duration {
            stop()
            report()
        }
    }

    private func report() {
        let sorted = frames.dropFirst().sorted()
        guard !sorted.isEmpty else { return }
        let avg = sorted.reduce(0, +) / Double(sorted.count)
        let p95 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
        let p99 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.99))]
        let slow = sorted.filter { $0 > 25 }.count
        let line = String(format: "AgentShark scroll test (%.0f pt/frame): %d frames, avg %.2f ms, p95 %.2f ms, p99 %.2f ms, max %.2f ms, frames over 25 ms: %d\n",
                          Double(stride), sorted.count, avg, p95, p99, sorted.last!, slow)
        FileHandle.standardError.write(Data(line.utf8))
    }
}
