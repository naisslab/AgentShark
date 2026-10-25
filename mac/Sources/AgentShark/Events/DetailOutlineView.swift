import AppKit
import Quartz
import SwiftUI

/// The detail outline (MAC-SPEC §5): the selected event decoded into layers, as an `NSOutlineView` with
/// name, value and annotation columns.
struct DetailOutline: NSViewControllerRepresentable {
    let model: WindowModel
    let pane: EventsPaneState

    func makeNSViewController(context: Context) -> DetailOutlineController { DetailOutlineController(model: model, pane: pane) }
    func updateNSViewController(_ controller: DetailOutlineController, context: Context) {}

    static func dismantleNSViewController(_ controller: DetailOutlineController, coordinator: ()) {
        controller.tearDown()
    }

    /// Take the space offered: measuring the table through Auto Layout would make its column widths, which the table
    /// fits to its width, part of its own size.
    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: DetailOutlineController, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 600, height: proposal.height ?? 400)
    }
}

/// Routes Copy, Copy as JSON, Space and Return to the controller.
final class DetailNSOutline: NSOutlineView, AgentSharkResponderActions {
    weak var controller: DetailOutlineController?

    override func keyDown(with event: NSEvent) {
        let plain = event.modifierFlags.intersection([.command, .control, .option]).isEmpty
        if plain, event.charactersIgnoringModifiers == " " {
            controller?.toggleQuickLook()
            return
        }
        if plain, event.keyCode == 36 || event.keyCode == 76, let node = item(atRow: selectedRow) as? DetailNode {
            controller?.activate(node)
            return
        }
        super.keyDown(with: event)
    }

    @objc func copy(_ sender: Any?) { controller?.copySelection(asJSON: false) }
    @objc func copyAsJSON(_ sender: Any?) { controller?.copySelection(asJSON: true) }

    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(copy(_:)) || item.action == #selector(copyAsJSON(_:)) { return selectedRow >= 0 }
        return super.validateUserInterfaceItem(item)
    }

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }
    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) { controller?.quickLook.attach(panel) }
    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) { controller?.quickLook.detach(panel) }
}

/// Which nodes are expanded, per event kind, saved across launches.
@MainActor enum DetailExpansion {
    private static let key = "AgentShark.detailExpansion"
    private static var cache: [String: Set<String>]?

    static func expanded(for kind: String) -> Set<String>? {
        load()[kind]
    }

    static func set(_ ids: Set<String>, for kind: String) {
        var all = load()
        all[kind] = ids
        cache = all
        UserDefaults.standard.set(all.mapValues { Array($0).sorted() }, forKey: key)
    }

    private static func load() -> [String: Set<String>] {
        if let cache { return cache }
        let raw = UserDefaults.standard.dictionary(forKey: key) as? [String: [String]] ?? [:]
        let loaded = raw.mapValues(Set.init)
        cache = loaded
        return loaded
    }
}

@MainActor final class DetailOutlineController: NSViewController, NSOutlineViewDataSource, NSOutlineViewDelegate, NSMenuDelegate {
    let model: WindowModel
    let pane: EventsPaneState
    let outlineView = DetailNSOutline()
    let quickLook = QuickLookSource()
    private let scrollView = ShadowedScrollView()
    private let contextMenu = NSMenu()
    private var loops: [ObservationLoop] = []
    private var layers: [DetailNode] = []
    private var detail: EventDetail?
    private var kind = ""
    private var expanded: Set<String> = []
    private var selectedNodeID: String?
    private var restoring = false
    private var lastReveal = 0
    private var fonts = EventTableFonts(density: .compact)
    private var thumbnails: [String: NSImage] = [:]
    private var thumbnailsLoading: Set<String> = []

    static let thumbnailHeight: CGFloat = 72
    /// Embedded images up to this size load as thumbnails by themselves; larger ones on Space.
    static let autoThumbnailBytes = 2_000_000

    init(model: WindowModel, pane: EventsPaneState) {
        self.model = model
        self.pane = pane
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        outlineView.controller = self
        outlineView.style = .fullWidth
        outlineView.dataSource = self
        outlineView.delegate = self
        outlineView.usesAutomaticRowHeights = false
        outlineView.allowsMultipleSelection = false
        outlineView.allowsTypeSelect = true
        outlineView.autoresizesOutlineColumn = false
        outlineView.indentationPerLevel = 14
        outlineView.intercellSpacing = NSSize(width: 8, height: 0)
        outlineView.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        outlineView.target = self
        outlineView.doubleAction = #selector(doubleClicked)
        outlineView.setAccessibilityLabel("Event detail")
        contextMenu.delegate = self
        contextMenu.autoenablesItems = false
        outlineView.menu = contextMenu

        // `fitColumns` sets the widths from the pane's width; these are the starting widths and the manual minimums.
        let columns: [(String, String, CGFloat, CGFloat)] = [("name", "Field", 200, 90), ("value", "Value", 340, 120), ("note", "Note", 160, 50)]
        for (id, title, width, minWidth) in columns {
            let c = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            c.title = title
            c.width = width
            c.minWidth = minWidth
            c.resizingMask = [.autoresizingMask, .userResizingMask]
            outlineView.addTableColumn(c)
        }
        outlineView.outlineTableColumn = outlineView.tableColumns[0]
        // No autosave: `fitColumns` computes every width and hidden state from the pane's width, and a restored hidden
        // Value column (from a stacked layout) would leave field names without values (DS1-08).

        scrollView.documentView = outlineView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        view = scrollView
        quickLook.keyTarget = outlineView

        scrollView.contentView.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(fitColumns), name: NSView.frameDidChangeNotification, object: scrollView.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(itemExpansionChanged(_:)), name: NSOutlineView.itemDidExpandNotification,
                                               object: outlineView)
        NotificationCenter.default.addObserver(self, selector: #selector(itemExpansionChanged(_:)), name: NSOutlineView.itemDidCollapseNotification,
                                               object: outlineView)
        loops.append(ObservationLoop { [weak self] in self?.followDetail() })
        loops.append(ObservationLoop { [weak self] in self?.followReveal() })
        loops.append(ObservationLoop { [weak self] in self?.followDisplay() })
    }

    func tearDown() {
        loops.forEach { $0.cancel() }
        loops.removeAll()
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: Columns

    /// Narrow panes put each value under its field name in one cell.
    private var stacked = false
    private var fittedWidth: CGFloat = 0

    override func viewDidLayout() {
        super.viewDidLayout()
        fitColumns()
    }

    /// Also on clip view frame changes: a pane resized by its split view does not always lay this view out again.
    @objc private func fitColumns() {
        let width = scrollView.contentView.bounds.width
        guard width > 0, abs(width - fittedWidth) > 0.5 else { return }
        fittedWidth = width
        let layout = Self.columnLayout(width: width, spacing: outlineView.intercellSpacing.width)
        let restack = layout.stacked != stacked
        stacked = layout.stacked
        // Set every width with autoresizing off: under the uniform style each assignment spreads its difference over the
        // other columns, which left Field wide and pushed Value past the pane's edge (DS1-08).
        let style = outlineView.columnAutoresizingStyle
        outlineView.columnAutoresizingStyle = .noColumnAutoresizing
        for (id, w) in [("name", layout.name), ("value", layout.value), ("note", layout.note)] {
            guard let c = outlineView.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier(id)) else { continue }
            c.isHidden = w == 0
            if w > 0 { c.width = w }
        }
        outlineView.columnAutoresizingStyle = style
        // Row heights change with the stacking: build the rows again (expansion and selection are restored), on the next
        // turn of the run loop, because reloading inside this layout pass is a reentrant table operation.
        if restack {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if self.detail != nil { self.rebuild() }
                self.outlineView.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<self.outlineView.numberOfRows))
            }
        }
        // A pane that opens with an animation (0.2 s) can settle without a last frame notification: fit again after it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in self?.fitColumns() }
    }

    /// Column widths for a pane `width` points wide (0 hides a column). From 520 pt: Field, Value and Note; below
    /// that Note goes and Field keeps 120 pt; below 320 pt one column holds the name with the value under it.
    static func columnLayout(width: CGFloat, spacing: CGFloat) -> (stacked: Bool, name: CGFloat, value: CGFloat, note: CGFloat) {
        if width < 320 { return (true, width - spacing, 0, 0) }
        if width < 520 { return (false, 120, width - 120 - 2 * spacing, 0) }
        let name = max(140, min(200, (width * 0.26).rounded())), note = min(160, (width * 0.2).rounded())
        return (false, name, width - name - note - 3 * spacing, note)
    }

    // MARK: Following the model

    private var derived: EventDerived?

    private func followDetail() {
        let d = model.eventDetail
        let dv = model.eventDerived
        _ = model.store.sessionsByID.count
        guard d != detail || dv != derived else { return }
        let sameEvent = d?.event.id == detail?.event.id
        detail = d
        derived = dv
        if !sameEvent { thumbnails.removeAll(); thumbnailsLoading.removeAll() }
        rebuild()
    }

    private func rebuild() {
        guard let d = detail else {
            layers = []
            outlineView.reloadData()
            return
        }
        let store = model.store
        layers = DetailTreeBuilder.layers(for: d, session: d.session ?? store.sessionsByID[d.event.session], derived: derived,
                                          analysis: model.info?.analysis, title: { store.title(of: $0) })
        kind = d.event.kind.rawValue
        expanded = DetailExpansion.expanded(for: kind) ?? defaultExpansion()
        restoring = true
        outlineView.reloadData()
        for layer in layers { restoreExpansion(layer) }
        restoring = false
        restoreSelection()
    }

    /// The decoded layer and its first-level groups are open the first time a kind is shown.
    private func defaultExpansion() -> Set<String> {
        var ids: Set<String> = ["decoded", "failure"]
        if let decoded = layers.first(where: { $0.id == "decoded" }) {
            for c in decoded.children where c.isExpandable && c.name != "input" { ids.insert(c.id) }
        }
        return ids
    }

    private func restoreExpansion(_ node: DetailNode) {
        guard expanded.contains(node.id), node.isExpandable else { return }
        outlineView.expandItem(node)
        for c in node.children { restoreExpansion(c) }
    }

    /// Keep the selected field selected when the new event has it (Wireshark behavior).
    private func restoreSelection() {
        guard let id = selectedNodeID, let node = find(id: id) else {
            pane.rawHighlight = nil
            return
        }
        reveal(node, select: true)
    }

    /// Find a node by id, building lazy children only along the path.
    private func find(id: String) -> DetailNode? {
        var level = layers
        while true {
            guard let next = level.first(where: { id == $0.id || id.hasPrefix($0.id + "/") }) else { return nil }
            if next.id == id { return next }
            level = next.children
        }
    }

    private func reveal(_ node: DetailNode, select: Bool) {
        var chain: [DetailNode] = []
        var p = node.parent
        while let n = p {
            chain.insert(n, at: 0)
            p = n.parent
        }
        restoring = true
        for n in chain { outlineView.expandItem(n) }
        restoring = false
        let row = outlineView.row(forItem: node)
        guard row >= 0 else { return }
        if select { outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false) }
        outlineView.scrollRowToVisible(row)
    }

    /// Raw pane → detail: select the native node for a raw pointer (or its nearest existing ancestor).
    private func followReveal() {
        guard let request = pane.revealRequest, request.serial != lastReveal else { return }
        lastReveal = request.serial
        guard detail != nil, let native = layers.first(where: { $0.id == "native" }) else { return }
        var node = native
        var target = native
        let tokens = request.pointer.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        for tok in tokens {
            guard let next = node.children.first(where: { $0.rawPointer?.split(separator: "/", omittingEmptySubsequences: false).last == tok })
            else { break }
            node = next
            target = next
        }
        reveal(target, select: true)
        view.window?.makeFirstResponder(outlineView)
    }

    private func followDisplay() {
        let prefs = model.app.preferences
        fonts = EventTableFonts(density: prefs.rowDensity)
        outlineView.rowHeight = fonts.rowHeight
        outlineView.reloadData(forRowIndexes: IndexSet(integersIn: 0..<outlineView.numberOfRows),
                               columnIndexes: IndexSet(integersIn: 0..<outlineView.numberOfColumns))
    }

    // MARK: Data source

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        guard let node = item as? DetailNode else { return layers.count }
        return node.children.count
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        guard let node = item as? DetailNode else { return layers[index] }
        return node.children[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        (item as? DetailNode)?.isExpandable ?? false
    }

    // MARK: Delegate

    func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
        guard let node = item as? DetailNode else { return fonts.rowHeight }
        if node.image != nil { return Self.thumbnailHeight + 6 }
        return stacked && !node.value.isEmpty ? 2 * fonts.rowHeight - 4 : fonts.rowHeight
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? DetailNode, let column = tableColumn?.identifier.rawValue else { return nil }
        let id = NSUserInterfaceItemIdentifier("detail." + column)
        let cell = outlineView.makeView(withIdentifier: id, owner: nil) as? DetailCell ?? DetailCell(identifier: id)
        switch column {
        case "name":
            // Layer rows take the Group header role; field labels are Row secondary, muted (DESIGN.md §7.10).
            let font = node.isLayer ? Theme.font(.groupHeader, model.app.preferences.rowDensity) : fonts.secondary
            let color: NSColor = node.isLayer ? .labelColor : .secondaryLabelColor
            if stacked {
                let value = valueStyle(node)
                cell.configure(node.name, font: font, color: color, thumbnail: thumbnail(for: node),
                               detail: node.image == nil && !node.value.isEmpty ? (node.value, value.font, value.color) : nil, tier: node.tier)
                cell.toolTip = [node.name, tooltip(for: node) ?? node.value, node.annotation].compactMap { $0 }.joined(separator: "\n")
            } else {
                cell.configure(node.name, font: font, color: color, thumbnail: nil)
                cell.toolTip = node.pointer.map { "\(node.name)\nJSON pointer: \($0)" } ?? node.name
            }
        case "value":
            let style = valueStyle(node)
            cell.configure(node.value, font: style.font, color: style.color, thumbnail: thumbnail(for: node), tier: node.tier)
            cell.toolTip = [tooltip(for: node), outlineView.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier("note"))?.isHidden == true ? node.annotation : nil]
                .compactMap { $0 }.joined(separator: "\n")
        default:
            cell.configure(node.annotation ?? "", font: fonts.text, color: .tertiaryLabelColor, thumbnail: nil)
            cell.toolTip = node.annotation
        }
        return cell
    }

    /// A value's font and color: links blue, errors red, data monospaced.
    private func valueStyle(_ node: DetailNode) -> (font: NSFont, color: NSColor) {
        var color: NSColor
        switch node.style {
        case .muted: color = .secondaryLabelColor
        case .error: color = Theme.err
        case .warning: color = Theme.warn
        default: color = .labelColor
        }
        if node.link != nil { color = .linkColor }
        let isData = node.isMonospaced || (node.pointer?.hasPrefix("/native") ?? false) || (node.pointer?.hasPrefix("/attrs") ?? false)
        return (node.isLayer ? fonts.text : isData ? fonts.mono : (node.style == .number ? fonts.digits : fonts.text), color)
    }

    private func tooltip(for node: DetailNode) -> String? {
        switch node.link {
        case .event?: return "\(node.value)\nDouble-click to go to this event."
        case .session?: return "\(node.value)\nDouble-click to open this session."
        case .file(let path)?: return "\(path)\nDouble-click to reveal it in Finder."
        case .episode?: return "\(node.value)\nDouble-click to open the episode's observed chain."
        case .diff?: return "\(node.value)\nDouble-click to show the diff."
        case nil: break
        }
        if node.fullText != nil { return "Double-click to read the whole value." }
        if node.image != nil { return "Press Space to preview the image." }
        return node.value.count > 60 ? String(node.value.prefix(1000)) : nil
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        let node = outlineView.item(atRow: outlineView.selectedRow) as? DetailNode
        if !restoring { selectedNodeID = node?.id }
        pane.rawHighlight = node?.rawPointer
        if model.selectedPointer != node?.pointer { model.selectedPointer = node?.pointer }
        // Filter ▸ Apply as Filter also works for nodes outside the composite document (turn, step, failure layers).
        let fragment = node.flatMap { $0.pointer == nil ? filterFragment(for: $0) : nil }
        if model.selectedNodeFragment != fragment { model.selectedNodeFragment = fragment }
    }

    @objc private func itemExpansionChanged(_ note: Notification) {
        guard !restoring, let node = note.userInfo?["NSObject"] as? DetailNode, !kind.isEmpty else { return }
        if note.name == NSOutlineView.itemDidExpandNotification { expanded.insert(node.id) } else { expanded.remove(node.id) }
        DetailExpansion.set(expanded, for: kind)
    }

    // MARK: Activation

    @objc private func doubleClicked() {
        guard outlineView.clickedRow >= 0, let node = outlineView.item(atRow: outlineView.clickedRow) as? DetailNode else { return }
        activate(node)
    }

    /// Double-click or Return: follow a link, read a long value, preview an image, or toggle the node.
    func activate(_ node: DetailNode) {
        if let link = node.link {
            follow(link)
        } else if let text = node.fullText {
            pane.longText = .init(title: node.name, text: text, event: detail?.event.id, rawPointer: node.rawPointer)
        } else if node.image != nil {
            toggleQuickLook()
        } else if node.isExpandable {
            if outlineView.isItemExpanded(node) { outlineView.collapseItem(node) } else { outlineView.expandItem(node) }
        }
    }

    private func follow(_ link: DetailNode.Link) {
        switch link {
        case .event(let id): model.select(event: id)
        case .session(let id): model.openSession(id)
        case .file(let path): AppKitHelpers.revealInFinder(path)
        case .episode(let id): model.openEpisode(id)
        case .diff(let event, let path):
            model.diffRequest = DiffRequest(eventId: event, path: path, title: path.map { ($0 as NSString).lastPathComponent } ?? event,
                                            session: detail?.event.id == event ? detail?.event.session : nil)
        }
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = outlineView.clickedRow
        guard row >= 0, let node = outlineView.item(atRow: row) as? DetailNode else { return }
        let model = self.model
        let fragment = filterFragment(for: node)
        menu.addSubmenu("Apply as Filter", enabled: fragment != nil) { sub in
            sub.addCombineModes { mode in if let fragment { model.applyFilter(fragment: fragment, mode: mode) } }
        }
        menu.addSubmenu("Prepare as Filter", enabled: fragment != nil) { sub in
            sub.addCombineModes { mode in if let fragment { model.prepareFilter(fragment: fragment, mode: mode) } }
        }
        let field = fieldName(for: node)
        menu.addItem("Apply as Column", enabled: field != nil) { if let field { model.addColumn(field: field) } }
        menu.addItem(.separator())
        menu.addItem("Copy Value", enabled: !node.isLayer || node.copyValue != nil) {
            AppKitHelpers.copy(node.fullText ?? node.copyValue ?? node.value)
        }
        menu.addItem("Copy Field Name", enabled: field != nil) { if let field { AppKitHelpers.copy(field) } }
        menu.addItem("Copy JSON Pointer", enabled: node.pointer != nil) { if let p = node.pointer { AppKitHelpers.copy(p) } }
        if let link = node.link {
            menu.addItem(.separator())
            let title: String
            switch link {
            case .event: title = "Go to Event"
            case .session: title = "Open Session"
            case .file: title = "Reveal in Finder"
            case .episode: title = "Open in Failures"
            case .diff: title = "Show Diff"
            }
            menu.addItem(title) { [weak self] in self?.follow(link) }
        }
        if node.fullText != nil {
            menu.addItem("Show Whole Value…") { [weak self] in self?.activate(node) }
        }
        if node.image != nil {
            menu.addItem("Quick Look") { [weak self] in
                self?.outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
                self?.toggleQuickLook()
            }
        }
        menu.addItem(.separator())
        menu.addItem("Expand All Subtrees", enabled: node.isExpandable) { [weak self] in
            self?.outlineView.expandItem(node, expandChildren: true)
        }
        menu.addItem("Collapse All Subtrees") { [weak self] in
            guard let self else { return }
            if node.isExpandable { self.outlineView.collapseItem(node, collapseChildren: true) } else { self.outlineView.collapseItem(nil, collapseChildren: true) }
        }
    }

    /// The filter fragment for a node: from the engine's fieldMap or the composite pointer, else its own field.
    func filterFragment(for node: DetailNode) -> String? {
        if let p = node.pointer, let d = detail, let f = FilterExpression.fragment(forPointer: p, in: d) { return f }
        if let field = node.field, let value = node.filterValue { return FilterExpression.equals(field: field, value: value) }
        return nil
    }

    func fieldName(for node: DetailNode) -> String? {
        if let p = node.pointer {
            if let ref = detail?.fieldMap?[p] { return ref.field }
            if let f = FilterExpression.field(forPointer: p) { return f }
        }
        return node.field
    }

    // MARK: Copy

    func copySelection(asJSON: Bool) {
        guard let node = outlineView.item(atRow: outlineView.selectedRow) as? DetailNode else { return }
        if asJSON, let p = node.pointer, let v = detail?.compositeDocument.pointer(p) {
            AppKitHelpers.copy(v.prettyPrinted)
        } else if asJSON {
            model.copySelectedEventAsJSON()
        } else {
            AppKitHelpers.copy("\(node.name): \(node.fullText ?? node.copyValue ?? node.value)")
        }
    }

    // MARK: Quick Look and thumbnails

    func toggleQuickLook() {
        if QuickLookSource.isVisible {
            QuickLookSource.close()
            return
        }
        guard let d = detail else { return }
        let node = outlineView.item(atRow: outlineView.selectedRow) as? DetailNode
        let api = model.engine.api
        Task { [weak self] in
            var url: URL?
            if let node, let image = node.image, let api {
                if let data = await Self.imageData(image, event: d.event.id, api: api, limit: QuickLookSource.maxEmbeddedBytes) {
                    url = QuickLookSource.write(data, name: QuickLookSource.safeName("\(d.event.id) \(node.name)") + ".png")
                }
            } else if let node, let text = node.fullText {
                url = QuickLookSource.write(text, name: QuickLookSource.safeName("\(d.event.id) \(node.name)") + ".txt")
            }
            if url == nil { url = await QuickLookSource.previewFile(for: d, api: api) }
            guard let self, let url, self.detail?.event.id == d.event.id else { return }
            self.quickLook.show(url)
        }
    }

    private static func imageData(_ image: DetailNode.Image, event: String, api: APIClient, limit: Int) async -> Data? {
        switch image {
        case .file(let path):
            return try? await api.file(path: path).data
        case .embedded(let pointer, _, let bytes):
            guard bytes <= limit else { return nil }
            return await QuickLookSource.loadEmbeddedImage(event: event, rawPointer: pointer, bytes: bytes, api: api)
        }
    }

    private func thumbnail(for node: DetailNode) -> NSImage? {
        guard let image = node.image, let d = detail else { return nil }
        let key = node.id
        if let t = thumbnails[key] { return t }
        guard !thumbnailsLoading.contains(key), let api = model.engine.api else { return nil }
        thumbnailsLoading.insert(key)
        let event = d.event.id
        Task { [weak self] in
            let data = await Self.imageData(image, event: event, api: api, limit: Self.autoThumbnailBytes)
            guard let self, self.detail?.event.id == event, let data, let img = NSImage(data: data) else { return }
            self.thumbnails[key] = img
            let row = self.outlineView.row(forItem: node)
            if row >= 0 {
                self.outlineView.reloadData(forRowIndexes: IndexSet(integer: row), columnIndexes: IndexSet(integersIn: 0..<self.outlineView.numberOfColumns))
            }
        }
        return nil
    }
}

/// A detail cell: one line of text, a thumbnail beside a caption for images, or (in a narrow pane) a field name with
/// its value on a second line.
final class DetailCell: NSTableCellView {
    let label = NSTextField(labelWithString: "")
    let thumbnail = NSImageView()
    private let detail = NSTextField(labelWithString: "")
    private let badge = BadgeView()

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        label.lineBreakMode = .byTruncatingTail
        label.usesSingleLineMode = true
        label.cell?.truncatesLastVisibleLine = true
        thumbnail.imageScaling = .scaleProportionallyDown
        thumbnail.imageAlignment = .alignLeft
        thumbnail.isHidden = true
        thumbnail.wantsLayer = true
        thumbnail.layer?.cornerRadius = 3
        thumbnail.layer?.masksToBounds = true
        detail.lineBreakMode = .byTruncatingTail
        detail.usesSingleLineMode = true
        detail.isHidden = true
        badge.isHidden = true
        addSubview(thumbnail)
        addSubview(label)
        addSubview(detail)
        addSubview(badge)
        textField = label
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var baseColor: NSColor = .labelColor
    private var detailColor: NSColor = .labelColor

    /// `tier` draws the Failure layer's tier badge before the value line (§7.10).
    func configure(_ text: String, font: NSFont, color: NSColor, thumbnail image: NSImage?,
                   detail second: (text: String, font: NSFont, color: NSColor)? = nil, tier: FailureTier? = nil) {
        badge.isHidden = tier == nil
        if let tier {
            badge.style = tier == .failure ? .solid : .outline
            badge.text = tier.rawValue
            badge.tint = DerivedStyle.tierColor(tier)
        }
        if label.stringValue != text { label.stringValue = text }
        label.font = font
        baseColor = color
        thumbnail.image = image
        thumbnail.isHidden = image == nil
        thumbnail.setAccessibilityLabel(image == nil ? nil : "Image preview")
        detail.isHidden = second == nil
        if let second {
            if detail.stringValue != second.text { detail.stringValue = second.text }
            detail.font = second.font
            detailColor = second.color
        }
        applyColors()
        needsLayout = true
    }

    override var backgroundStyle: NSView.BackgroundStyle {
        didSet { applyColors() }
    }

    private func applyColors() {
        let emphasized = backgroundStyle == .emphasized
        label.textColor = emphasized ? .alternateSelectedControlTextColor : baseColor
        detail.textColor = emphasized ? .alternateSelectedControlTextColor : detailColor
        badge.isEmphasized = emphasized
    }

    override func layout() {
        super.layout()
        let lineHeight = ceil(label.intrinsicContentSize.height)
        let badgeW = badge.isHidden ? 0 : badge.intrinsicContentSize.width + 6
        if !detail.isHidden {
            let half = bounds.height / 2
            label.frame = NSRect(x: 2, y: floor(half + (half - lineHeight) / 2), width: max(0, bounds.width - 4), height: lineHeight)
            let dh = ceil(detail.intrinsicContentSize.height)
            let y = floor((half - dh) / 2) + 1
            badge.frame = NSRect(x: 2, y: y + floor((dh - 15) / 2), width: max(0, badgeW - 6), height: 15)
            detail.frame = NSRect(x: 2 + badgeW, y: y, width: max(0, bounds.width - 4 - badgeW), height: dh)
            return
        }
        var x: CGFloat = 2
        if badgeW > 0 {
            badge.frame = NSRect(x: x, y: floor((bounds.height - 15) / 2), width: badgeW - 6, height: 15)
            x += badgeW
        }
        if !thumbnail.isHidden {
            let h = DetailOutlineController.thumbnailHeight
            let size = thumbnail.image?.size ?? NSSize(width: h, height: h)
            let width = min(bounds.width / 2, h * max(0.5, min(2, size.width / max(1, size.height))))
            thumbnail.frame = NSRect(x: x, y: floor((bounds.height - h) / 2), width: width, height: h)
            x = thumbnail.frame.maxX + 8
        }
        label.frame = NSRect(x: x, y: floor((bounds.height - lineHeight) / 2), width: max(0, bounds.width - x - 2), height: lineHeight)
    }
}
