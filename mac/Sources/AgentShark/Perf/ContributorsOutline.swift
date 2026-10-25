import AppKit
import SwiftUI

/// The Contributors table (ANALYSIS-UX §4.9) as a native outline: a group row per group, its contributors under it,
/// and the columns sized from the table's own width (`ContributorColumns`), which a SwiftUI `Table` cannot do without
/// leaving rows it already drew on the old widths. A group row runs across the table, so its title and badge cut only
/// where the row itself has no room. The selection is the model's (`selectedID`); a click, double-click, Return and
/// the context menu act as the other tables' rows do (§4.10).
struct ContributorsOutline: NSViewControllerRepresentable {
    let cp: CriticalPathModel
    let content: CriticalPathContent
    let groups: [CriticalPathContent.ContributorGroup]
    /// The row that shows the model's selection (`contributorRowID`).
    let selectedID: String?
    let metrics: Theme.Metrics

    func makeNSViewController(context: Context) -> ContributorsOutlineController { ContributorsOutlineController(cp: cp) }

    func updateNSViewController(_ controller: ContributorsOutlineController, context: Context) {
        controller.update(content: content, groups: groups, selectedID: selectedID, metrics: metrics)
    }

    /// Take the space offered: the columns fit the table's width, so its width must not depend on them.
    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: ContributorsOutlineController, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 600, height: proposal.height ?? 300)
    }
}

/// A group or a contributor: the outline's items must be objects.
final class ContributorNode: NSObject {
    let group: CriticalPathContent.ContributorGroup?
    let row: CriticalPathContent.ContributorRow?
    let children: [ContributorNode]

    init(group: CriticalPathContent.ContributorGroup) {
        self.group = group
        row = nil
        children = group.rows.map(ContributorNode.init(row:))
    }

    init(row: CriticalPathContent.ContributorRow) {
        group = nil
        self.row = row
        children = []
    }
}

final class ContributorsNSOutline: NSOutlineView {
    weak var controller: ContributorsOutlineController?

    /// A group row's title runs from the disclosure to the table's visible edge, across the columns its contributors
    /// fill; its other columns hold nothing.
    override func frameOfCell(atColumn column: Int, row: Int) -> NSRect {
        guard (item(atRow: row) as? ContributorNode)?.group != nil else { return super.frameOfCell(atColumn: column, row: row) }
        guard column == 0 else { return .zero }
        var r = super.frameOfCell(atColumn: column, row: row)
        let edge = min(bounds.width, enclosingScrollView?.contentView.bounds.width ?? bounds.width) - intercellSpacing.width
        r.size.width = max(r.width, edge - r.minX)
        return r
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let row = row(at: convert(event.locationInWindow, from: nil))
        return controller?.menu(row: row)
    }

    override func keyDown(with event: NSEvent) {
        let mods = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if mods.isEmpty, event.keyCode == 36 || event.keyCode == 76, let controller {
            controller.open(row: selectedRow)
        } else {
            super.keyDown(with: event)
        }
    }
}

@MainActor final class ContributorsOutlineController: NSViewController, NSOutlineViewDataSource, NSOutlineViewDelegate {
    let cp: CriticalPathModel
    private let outline = ContributorsNSOutline()
    private let scrollView = ShadowedScrollView()
    private var content: CriticalPathContent?
    private var groups: [CriticalPathContent.ContributorGroup] = []
    private var nodes: [ContributorNode] = []
    /// The groups closed in this table; every group opens by default.
    private var collapsed: Set<CriticalPathContent.ContributorGroup.Kind> = []
    private var selectedID: String?
    private var metrics = Theme.metrics(.compact)
    /// Set while the table follows the model, so its own notifications do not act as the person's.
    private var applying = false
    private var fittedWidth: CGFloat = 0

    private enum Column: String, CaseIterable {
        case contributor, session, onPath, share

        /// The header; Share's names the path's length once a result is shown ("of 4d 08h").
        var title: String {
            switch self {
            case .contributor: return "Contributor"
            case .session: return "Session"
            case .onPath: return "On path"
            case .share: return ""
            }
        }

        var isFigure: Bool { self == .onPath || self == .share }
    }

    init(cp: CriticalPathModel) {
        self.cp = cp
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        outline.controller = self
        for c in Column.allCases {
            let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(c.rawValue))
            col.title = c.title
            col.minWidth = 24
            col.resizingMask = []
            if c.isFigure { col.headerCell.alignment = .right }
            outline.addTableColumn(col)
        }
        outline.outlineTableColumn = outline.tableColumns[0]
        outline.indentationPerLevel = 12
        outline.style = .inset
        outline.floatsGroupRows = false
        outline.autosaveExpandedItems = false
        outline.allowsMultipleSelection = false
        outline.allowsEmptySelection = true
        outline.allowsColumnReordering = false
        outline.allowsColumnResizing = false
        outline.usesAlternatingRowBackgroundColors = false
        outline.gridStyleMask = .solidHorizontalGridLineMask
        outline.intercellSpacing = NSSize(width: PerfColumnFit.spacing, height: 0)
        outline.columnAutoresizingStyle = .noColumnAutoresizing
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.doubleAction = #selector(doubleClicked)
        outline.setAccessibilityLabel("Contributors")
        scrollView.documentView = outline
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .controlBackgroundColor
        view = scrollView
        scrollView.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(widthChanged), name: NSView.frameDidChangeNotification, object: scrollView)
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        widthChanged()
    }

    // MARK: Following the model

    func update(content: CriticalPathContent, groups: [CriticalPathContent.ContributorGroup], selectedID: String?, metrics: Theme.Metrics) {
        let rows = groups != self.groups || content.result.coverage.snapshotAt != self.content?.result.coverage.snapshotAt
            || content.result.sessionId != self.content?.result.sessionId || metrics != self.metrics
        self.content = content
        self.metrics = metrics
        if rows {
            self.groups = groups
            outline.tableColumns[3].title = "of " + content.wallText
            outline.tableColumns[3].headerToolTip = "Share of the " + content.wallText + " critical path"
            nodes = groups.map(ContributorNode.init(group:))
            applying = true
            outline.reloadData()
            for n in nodes where !(n.group.map { collapsed.contains($0.kind) } ?? false) { outline.expandItem(n) }
            applying = false
            fittedWidth = 0
            widthChanged()
        }
        if rows || selectedID != self.selectedID {
            let moved = selectedID != self.selectedID
            self.selectedID = selectedID
            restoreSelection(scroll: moved)
        }
    }

    private func node(_ id: String?) -> ContributorNode? {
        guard let id else { return nil }
        return nodes.lazy.flatMap(\.children).first { $0.row?.id == id }
    }

    /// Select the model's selection, brought into view when it changed; a row in a closed group shows no selection.
    private func restoreSelection(scroll: Bool) {
        applying = true
        defer { applying = false }
        let row = node(selectedID).map { outline.row(forItem: $0) } ?? -1
        guard row >= 0 else {
            outline.deselectAll(nil)
            return
        }
        if outline.selectedRow != row { outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false) }
        if scroll { outline.scrollRowToVisible(row) }
    }

    // MARK: Columns (DESIGN.md §4.4)

    @objc private func widthChanged() {
        let width = scrollView.frame.width
        guard width > 0, abs(width - fittedWidth) > 0.5 else { return }
        fittedWidth = width
        let fit = CriticalPathContent.ContributorColumns(groups, width: width)
        let widths: [Column: CGFloat] = [.contributor: fit.contributor, .session: fit.session, .onPath: CriticalPathContent.ContributorColumns.onPath,
                                         .share: CriticalPathContent.ContributorColumns.share]
        for col in outline.tableColumns {
            guard let c = Column(rawValue: col.identifier.rawValue), let w = widths[c] else { continue }
            col.isHidden = c == .session && !fit.showsSession
            if !col.isHidden, abs(col.width - w) > 0.5 { col.width = w }
        }
        outline.tile()
        // The group rows' cells span the table, and AppKit frames a cell only when it makes it.
        outline.enumerateAvailableRowViews { rowView, row in
            guard (self.outline.item(atRow: row) as? ContributorNode)?.group != nil, let cell = rowView.view(atColumn: 0) as? NSView else { return }
            let frame = self.outline.frameOfCell(atColumn: 0, row: row)
            cell.frame = NSRect(x: frame.minX - rowView.frame.minX, y: 0, width: frame.width, height: rowView.bounds.height)
        }
    }

    // MARK: Data source and delegate

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        (item as? ContributorNode)?.children.count ?? (item == nil ? nodes.count : 0)
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        (item as? ContributorNode)?.children[index] ?? nodes[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        (item as? ContributorNode)?.group != nil
    }

    func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat { metrics.tableRow }

    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
        (item as? ContributorNode)?.row != nil
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? ContributorNode, let tableColumn, let column = Column(rawValue: tableColumn.identifier.rawValue) else { return nil }
        if let g = node.group {
            guard column == .contributor else { return nil }
            let cell = textCell("ContributorGroup")
            cell.configure(g.title, font: Theme.font(.groupHeader), tooltip: g.badgeHelp)
            let text = NSMutableAttributedString(string: g.title + " ", attributes: [.font: Theme.font(.groupHeader), .foregroundColor: NSColor.labelColor])
            text.addAttribute(.kern, value: 2.5, range: NSRange(location: text.length - 1, length: 1))
            text.append(NSAttributedString(string: g.badge, attributes: [.font: Theme.font(.rowSecondary), .foregroundColor: NSColor.secondaryLabelColor]))
            cell.label.attributedStringValue = text
            cell.label.lineBreakMode = .byTruncatingTail
            cell.label.setAccessibilityLabel(g.title + ", " + g.badge)
            return cell
        }
        guard let r = node.row else { return nil }
        let cell = textCell("Contributor." + column.rawValue)
        cell.label.setAccessibilityLabel(nil)
        switch column {
        case .contributor:
            cell.configure(r.name, font: Theme.font(r.isCode ? .code : .rowPrimary), tooltip: r.help)
            cell.label.lineBreakMode = r.isCode ? .byTruncatingMiddle : .byTruncatingTail
        case .session:
            cell.configure(r.session, font: Theme.font(.rowPrimary), color: .secondaryLabelColor, tooltip: r.sessionHelp)
        case .onPath:
            cell.configure(r.onPath, font: Theme.font(.rowPrimary), alignment: .right, tooltip: r.onPathHelp.isEmpty ? nil : r.onPathHelp)
            if r.isDerived { cell.label.setAccessibilityLabel(r.onPath.replacingOccurrences(of: "≈", with: "") + ", derived") }
        case .share:
            cell.configure(r.share, font: Theme.font(.rowPrimary), alignment: .right, tooltip: r.shareHelp)
        }
        return cell
    }

    private func textCell(_ id: String) -> EventTextCell {
        let id = NSUserInterfaceItemIdentifier(id)
        return outline.makeView(withIdentifier: id, owner: nil) as? EventTextCell ?? EventTextCell(identifier: id)
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !applying, let content else { return }
        let row = (outline.item(atRow: outline.selectedRow) as? ContributorNode)?.row
        guard row != nil || outline.selectedRow < 0 else { return }
        selectedID = row?.id
        cp.select(row?.selection, in: content)
    }

    func outlineViewItemDidExpand(_ notification: Notification) { followExpansion(notification, open: true) }
    func outlineViewItemDidCollapse(_ notification: Notification) { followExpansion(notification, open: false) }

    private func followExpansion(_ notification: Notification, open: Bool) {
        guard !applying, let kind = (notification.userInfo?["NSObject"] as? ContributorNode)?.group?.kind else { return }
        if open { collapsed.remove(kind) } else { collapsed.insert(kind) }
        restoreSelection(scroll: false)
    }

    // MARK: Actions (§4.10)

    /// A double-click on a group opens or closes it; on a contributor, its event in Steps, as Return does.
    @objc private func doubleClicked() {
        let row = outline.clickedRow
        if let node = outline.item(atRow: row) as? ContributorNode, node.group != nil {
            if outline.isItemExpanded(node) { outline.collapseItem(node) } else { outline.expandItem(node) }
        } else {
            open(row: row)
        }
    }

    func open(row: Int) {
        guard let content, let r = (outline.item(atRow: row) as? ContributorNode)?.row else { return }
        cp.open(r.selection, in: content)
    }

    /// The row's context menu, the selection bar's actions.
    func menu(row: Int) -> NSMenu? {
        guard let content, let r = (outline.item(atRow: row) as? ContributorNode)?.row else { return nil }
        return CriticalPathTrackView.menu(for: content.target(r.selection), cp: cp)
    }
}
