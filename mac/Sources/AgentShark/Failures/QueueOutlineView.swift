import AppKit
import SwiftUI

/// The attention queue (SPEC §12.7, DESIGN.md §7.5–§7.6): an `NSOutlineView` with one sticky group row per attention
/// section (Other and Recovered start collapsed) and two-line item rows.
struct QueueOutline: NSViewControllerRepresentable {
    let model: WindowModel

    func makeNSViewController(context: Context) -> QueueOutlineController { QueueOutlineController(model: model) }
    func updateNSViewController(_ controller: QueueOutlineController, context: Context) {}

    static func dismantleNSViewController(_ controller: QueueOutlineController, coordinator: ()) { controller.tearDown() }

    /// Take the space offered: measuring the table through Auto Layout would make its column widths, which the table
    /// fits to its width, part of its own size.
    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: QueueOutlineController, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 600, height: proposal.height ?? 400)
    }
}

/// A section header in the outline.
final class QueueSectionNode: NSObject {
    let section: AttentionSection?
    var rows: [QueueRowNode] = []
    var count: Int
    /// The last child when the section shows fewer rows than it holds.
    var more: QueueMoreNode?

    init(section: AttentionSection?, count: Int) {
        self.section = section
        self.count = count
    }

    var children: [Any] { rows + (more.map { [$0] } ?? []) }
}

/// "Show all 812" at the end of a section that shows its first page (or nothing yet).
final class QueueMoreNode: NSObject {
    let section: FailuresModel.Section
    init(_ section: FailuresModel.Section) { self.section = section }

    var title: String {
        let s = section
        if s.loaded == 0 { return "Show \(Formatters.count(min(FailuresModel.sectionPage, s.total)))" }
        if s.expanded, s.loaded >= FailuresModel.maxRows { return "Narrow the facets to see the rest" }
        return "Show All \(Formatters.count(s.total))"
    }

    var isActionable: Bool { !(section.expanded && section.loaded >= FailuresModel.maxRows) }
}

final class QueueRowNode: NSObject {
    let row: QueueRow
    init(_ row: QueueRow) { self.row = row }
}

/// Return opens; Space and the arrows work as in any outline.
final class QueueNSOutline: NSOutlineView {
    weak var controller: QueueOutlineController?

    override func keyDown(with event: NSEvent) {
        let plain = event.modifierFlags.intersection([.command, .control, .option]).isEmpty
        if plain, event.keyCode == 36 || event.keyCode == 76 {
            controller?.activateSelection()
            return
        }
        super.keyDown(with: event)
    }
}

@MainActor final class QueueOutlineController: NSViewController, NSOutlineViewDataSource, NSOutlineViewDelegate, NSMenuDelegate {
    let model: WindowModel
    private let outline = QueueNSOutline()
    private let scrollView = ShadowedScrollView()
    private let contextMenu = NSMenu()
    private var sections: [QueueSectionNode] = []
    private var flat: [QueueRowNode] = []
    private var loops: [ObservationLoop] = []
    private var generation = -1
    private var applying = false

    init(model: WindowModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var failures: FailuresModel { model.failures }
    /// Whether the outline shows section rows; fixed at each rebuild so the data source always matches its arrays.
    private var grouped = true

    override func loadView() {
        outline.controller = self
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("item"))
        column.resizingMask = .autoresizingMask
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.style = .fullWidth
        outline.rowSizeStyle = .custom
        outline.floatsGroupRows = true
        outline.indentationPerLevel = 0
        outline.allowsMultipleSelection = false
        outline.autoresizesOutlineColumn = false
        outline.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.doubleAction = #selector(doubleClicked)
        outline.setAccessibilityLabel("Attention queue")
        contextMenu.delegate = self
        contextMenu.autoenablesItems = false
        outline.menu = contextMenu
        scrollView.documentView = outline
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        view = scrollView
        NotificationCenter.default.addObserver(self, selector: #selector(expansionChanged(_:)), name: NSOutlineView.itemDidExpandNotification, object: outline)
        NotificationCenter.default.addObserver(self, selector: #selector(expansionChanged(_:)), name: NSOutlineView.itemDidCollapseNotification, object: outline)
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        loops.append(ObservationLoop { [weak self] in self?.followRows() })
        loops.append(ObservationLoop { [weak self] in self?.followSelection() })
        loops.append(ObservationLoop { [weak self] in self?.followJump() })
    }

    func tearDown() {
        loops.forEach { $0.cancel() }
        loops.removeAll()
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: Following the model

    private var builtGroup: QueueGroup?

    private func followRows() {
        let gen = failures.rowsGeneration
        let summaryEpisodes = failures.summary?.episodes
        let group = model.failureFacets.group
        let expanded = failures.expandedSections
        let loading = failures.loadingSections
        guard gen != generation || group != builtGroup || summaryEpisodes != builtEpisodes || expanded != builtExpanded || loading != builtLoading
        else { return }
        generation = gen
        builtGroup = group
        builtEpisodes = summaryEpisodes
        builtExpanded = expanded
        builtLoading = loading
        rebuild()
    }

    private var builtEpisodes: Int?
    private var builtExpanded: Set<String> = []
    private var builtLoading: Set<String> = []
    private var jumpSerial = 0

    /// The jump bar: the section header at the top of the visible rows.
    private func followJump() {
        let serial = failures.jumpSerial
        guard serial != jumpSerial else { return }
        jumpSerial = serial
        guard let name = failures.jumpSection, let node = sections.first(where: { $0.section == name }) else { return }
        applying = true
        outline.expandItem(node)
        applying = false
        let row = outline.row(forItem: node)
        guard row >= 0 else { return }
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: outline.rect(ofRow: row).minY - scrollView.contentInsets.top))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    private func rebuild() {
        grouped = model.failureFacets.group == .attention
        sections = failures.sections.map { s in
            let node = QueueSectionNode(section: s.section, count: s.total)
            node.rows = s.rows.map(QueueRowNode.init)
            if grouped, s.hidden > 0 { node.more = QueueMoreNode(s) }
            return node
        }
        flat = sections.flatMap(\.rows)
        let origin = scrollView.contentView.bounds.origin
        applying = true
        outline.reloadData()
        for s in sections where grouped {
            if let sec = s.section, failures.collapsed.contains(sec.rawValue) { outline.collapseItem(s) } else { outline.expandItem(s) }
        }
        applying = false
        scrollView.contentView.scroll(to: origin)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        followSelection()
        scrolled()
    }

    private func followSelection() {
        let key = failures.selectedKey
        _ = failures.collapsed
        guard let key, let node = flat.first(where: { $0.row.rowKey == key }) else {
            if key == nil, outline.selectedRow >= 0 {
                applying = true
                outline.deselectAll(nil)
                applying = false
            }
            return
        }
        applying = true
        if grouped, let s = sections.first(where: { $0.rows.contains(node) }), !outline.isItemExpanded(s) { outline.expandItem(s) }
        let row = outline.row(forItem: node)
        if row >= 0, outline.selectedRow != row {
            outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            outline.scrollRowToVisible(row)
        }
        applying = false
    }

    /// The section whose rows are at the top of the viewport, for the section index (§7.5).
    @objc private func scrolled() {
        guard grouped else { return }
        let top = scrollView.contentView.bounds.minY + 1
        var current: QueueSectionNode?
        for s in sections {
            let row = outline.row(forItem: s)
            guard row >= 0 else { continue }
            if outline.rect(ofRow: row).minY <= top { current = s } else { break }
        }
        let name = (current ?? sections.first)?.section?.rawValue
        guard failures.visibleSection != name else { return }
        DispatchQueue.main.async { [weak self] in self?.failures.visibleSection = name }
    }

    @objc private func expansionChanged(_ note: Notification) {
        guard !applying, let s = note.userInfo?["NSObject"] as? QueueSectionNode, let sec = s.section else { return }
        if note.name == NSOutlineView.itemDidExpandNotification { failures.collapsed.remove(sec.rawValue) } else { failures.collapsed.insert(sec.rawValue) }
    }

    // MARK: Data source

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if let s = item as? QueueSectionNode { return s.children.count }
        if item == nil { return grouped ? sections.count : flat.count }
        return 0
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if let s = item as? QueueSectionNode { return s.children[index] }
        return grouped ? sections[index] : flat[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { item is QueueSectionNode }

    func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool { item is QueueSectionNode }

    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool { item is QueueRowNode }

    func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
        let m = model.app.preferences.metrics
        return item is QueueSectionNode ? m.groupHeader : item is QueueMoreNode ? m.groupHeader : m.listRow
    }

    func outlineView(_ outlineView: NSOutlineView, rowViewForItem item: Any) -> NSTableRowView? {
        item is QueueSectionNode ? QueueGroupRowView() : nil
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        if let s = item as? QueueSectionNode {
            let id = NSUserInterfaceItemIdentifier("QueueSection")
            let cell = outlineView.makeView(withIdentifier: id, owner: nil) as? QueueSectionCell ?? QueueSectionCell(identifier: id)
            let title = s.section.map(DerivedStyle.sectionTitle) ?? "Items"
            // Under Group by Attention the section index holds the counts (§7.5).
            cell.configure(title: title, count: grouped ? nil : s.count, attention: s.section.map { SectionIndex.attention.contains($0.rawValue) } ?? false,
                           unit: s.section?.unit ?? "episode")
            return cell
        }
        if let more = item as? QueueMoreNode {
            let id = NSUserInterfaceItemIdentifier("QueueMore")
            let cell = outlineView.makeView(withIdentifier: id, owner: nil) as? QueueMoreCell ?? QueueMoreCell(identifier: id)
            let loading = more.section.section.map { failures.loadingSections.contains($0.rawValue) } ?? false
            let sec = more.section
            cell.configure(title: loading ? "Loading…" : more.title, note: "\(Formatters.count(sec.rows.count)) of \(Formatters.count(sec.total)) shown",
                           enabled: more.isActionable && !loading) { [weak self] in
                self?.failures.showMore(more.section)
            }
            return cell
        }
        guard let node = item as? QueueRowNode else { return nil }
        let id = NSUserInterfaceItemIdentifier("QueueRow")
        let cell = outlineView.makeView(withIdentifier: id, owner: nil) as? QueueRowCell ?? QueueRowCell(identifier: id)
        cell.configure(node.row, sessionTitle: node.row.sessionId.map { model.store.title(of: $0) } ?? node.row.title, analysis: model.info?.analysis,
                       countsScoped: failures.countsAreScoped)
        return cell
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !applying, let node = outline.item(atRow: outline.selectedRow) as? QueueRowNode else { return }
        failures.select(node.row)
    }

    // MARK: Activation

    @objc private func doubleClicked() {
        guard outline.clickedRow >= 0, outline.item(atRow: outline.clickedRow) is QueueRowNode else { return }
        activateSelection()
    }

    /// Return or double-click: an alarm without an episode shows its turn in Steps; other items show their step.
    func activateSelection() {
        guard let node = outline.item(atRow: outline.selectedRow) as? QueueRowNode else { return }
        let r = node.row
        switch r.kind {
        case .alarm, .session:
            if let s = r.sessionId { model.openSession(s, mode: .steps) }
        case .signature:
            failures.showSignature(r.signatureId ?? r.id)
        default:
            model.showInSession()
        }
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard outline.clickedRow >= 0, let node = outline.item(atRow: outline.clickedRow) as? QueueRowNode else { return }
        let r = node.row
        let model = self.model
        if r.kind == .episode {
            menu.addItem("Show in Session", symbol: SessionMode.steps.symbol) {
                model.failures.select(r)
                model.showInSession()
            }
            menu.addItem("Show in Events", symbol: Symbols.workspace(.events)) { model.showEpisodeInEvents(r.id) }
        }
        if let sig = r.signatureId {
            menu.addItem("Show Signature", symbol: "number") { model.failures.showSignature(sig) }
            menu.addItem("Group by This Signature", symbol: "line.3.horizontal.decrease") {
                model.failureFacets.group = .episode
                model.applyFilter(fragment: "signature == " + FilterExpression.quote(sig), mode: .andSelected)
            }
        }
        if let s = r.sessionId {
            menu.addItem("Open Session", symbol: Symbols.workspace(.session)) { model.openSession(s, mode: .steps) }
        }
        menu.addItem(.separator())
        menu.addItem("Copy ID") { AppKitHelpers.copy(r.id) }
        if let sig = r.signature { menu.addItem("Copy Signature") { AppKitHelpers.copy(sig) } }
    }
}

/// A queue group header (§7.5): 28 pt, the chrome surface, a disclosure, the name (Group header role), the attention
/// dot, and the count on the right unless the section index already shows it.
final class QueueSectionCell: NSTableCellView {
    private let label = NSTextField(labelWithString: "")
    private let countLabel = NSTextField(labelWithString: "")
    private let dot = NSView()

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        label.font = Theme.font(.groupHeader)
        countLabel.font = Theme.font(.rowSecondary)
        countLabel.textColor = .secondaryLabelColor
        countLabel.alignment = .right
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        for v in [dot, label, countLabel] as [NSView] { addSubview(v) }
        textField = label
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(title: String, count: Int?, attention: Bool, unit: String) {
        label.stringValue = title
        countLabel.stringValue = count.map(Formatters.count) ?? ""
        dot.isHidden = !attention
        setAccessibilityLabel(title + (count.map { ", " + Formatters.count($0, unit) } ?? "") + (attention ? ", needs attention" : ""))
        needsLayout = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        effectiveAppearance.performAsCurrentDrawingAppearance { dot.layer?.backgroundColor = Theme.err.cgColor }
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        let cw = ceil(countLabel.intrinsicContentSize.width)
        countLabel.frame = NSRect(x: bounds.maxX - cw - 12, y: (h - 15) / 2, width: cw, height: 15)
        var x: CGFloat = 0
        if !dot.isHidden {
            dot.frame = NSRect(x: 0, y: (h - 6) / 2, width: 6, height: 6)
            x = 12
        }
        label.frame = NSRect(x: x, y: (h - 16) / 2, width: max(0, countLabel.frame.minX - x - 8), height: 16)
        viewDidChangeEffectiveAppearance()
    }
}

/// The group header rows: the chrome surface with a hairline under them.
final class QueueGroupRowView: NSTableRowView {
    override func drawBackground(in dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
    }
}

/// The last row of a capped section (§7.5): a "Show All 1,306" button and "8 of 1,306 shown" as metadata.
final class QueueMoreCell: NSTableCellView {
    private let button = NSButton(title: "", target: nil, action: nil)
    private let note = NSTextField(labelWithString: "")
    private var action: (() -> Void)?

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        button.bezelStyle = .push
        button.controlSize = .small
        button.target = self
        button.action = #selector(pressed)
        note.font = Theme.font(.metadata)
        note.textColor = .secondaryLabelColor
        addSubview(button)
        addSubview(note)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(title: String, note text: String, enabled: Bool, action: @escaping () -> Void) {
        button.title = title
        button.isHidden = !enabled
        note.stringValue = text
        self.action = action
        needsLayout = true
    }

    @objc private func pressed() { action?() }

    override func layout() {
        super.layout()
        var x: CGFloat = 34
        if !button.isHidden {
            let size = button.intrinsicContentSize
            button.frame = NSRect(x: x - 6, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
            x = button.frame.maxX + 8
        }
        note.frame = NSRect(x: x, y: (bounds.height - 15) / 2, width: max(0, bounds.width - x - 12), height: 15)
    }
}

/// A queue item (§7.6). Line 1: the impact mark in a 16 pt column, the subject (13/500, UI font, tail ellipsis; a
/// signature row starts with its 48×14 sparkline), "● Live", and the age. Line 2, indented 22: the outcome word, a tier
/// badge for tiers other than failure, the agent (dot and short name), the session title and the family; on the
/// right "3 attempts · 7m 29s≈ lost · in 10 sessions". When line 2 is short, "in N sessions", the family and the
/// attempts drop in that order, then the title cuts down to 96 pt; the outcome, the agent and the wall figure never
/// drop or cut.
final class QueueRowCell: NSTableCellView {
    private let icon = NSImageView()
    private let subject = NSTextField(labelWithString: "")
    private let live = NSTextField(labelWithString: "Live")
    private let liveDot = NSImageView()
    private let age = NSTextField(labelWithString: "")
    private let outcome = NSTextField(labelWithString: "")
    private let tier = BadgeView()
    private let agentDot = NSView()
    private let agent = NSTextField(labelWithString: "")
    private let title = NSTextField(labelWithString: "")
    private let family = NSTextField(labelWithString: "")
    private let right = NSTextField(labelWithString: "")
    private let spark = SparkView()
    private var outcomeColor: NSColor = .labelColor
    private var agentColor: NSColor = .secondaryLabelColor
    private var parts = Line2Parts()
    private var subjectText = ""
    private var subjectIsSignature = false

    /// The right part of line 2, in pieces that drop by priority.
    struct Line2Parts: Equatable {
        var attempts: String?
        var wall: String?
        var sessions: String?
        var family: String?
    }

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        icon.imageScaling = .scaleProportionallyDown
        subject.font = Theme.font(.queuePrimary)
        subject.lineBreakMode = .byTruncatingTail
        subject.cell?.truncatesLastVisibleLine = true
        for l in [live, age, outcome, agent, title, family, right] {
            l.font = Theme.font(.rowSecondary)
            l.lineBreakMode = .byTruncatingTail
        }
        live.textColor = .controlAccentColor
        liveDot.image = Mark.live.image(size: 7, weight: .regular, color: .controlAccentColor)
        age.textColor = .secondaryLabelColor
        age.alignment = .right
        title.textColor = .secondaryLabelColor
        family.textColor = .secondaryLabelColor
        right.textColor = .secondaryLabelColor
        right.alignment = .right
        tier.style = .outline
        agentDot.wantsLayer = true
        agentDot.layer?.cornerRadius = 4
        for v in [icon, spark, subject, liveDot, live, age, outcome, tier, agentDot, agent, title, family, right] as [NSView] { addSubview(v) }
        textField = subject
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// `sessionTitle` is the row's session (a delegation's parent session; the child's title is its subject).
    func configure(_ r: QueueRow, sessionTitle: String?, analysis: AnalysisStatus?, countsScoped: Bool = false) {
        let (mark, color) = DerivedStyle.rowMark(r)
        icon.image = mark?.image(size: 12, weight: .semibold, color: color)
        icon.isHidden = mark == nil
        icon.setAccessibilityElement(false)
        let text = Self.subject(r)
        subjectText = text
        subjectIsSignature = r.kind == .episode || r.kind == .signature || (r.kind == .alarm && r.signature != nil)
        live.isHidden = !r.live
        liveDot.isHidden = !r.live
        age.stringValue = Formatters.relative(r.ts)
        let o = DerivedStyle.rowOutcome(r)
        outcome.stringValue = o.text
        outcomeColor = o.color
        if let t = r.tier, t != .failure, r.kind == .episode || r.kind == .signature {
            tier.isHidden = false
            tier.text = t.rawValue
            tier.tint = DerivedStyle.tierColor(t)
        } else {
            tier.isHidden = true
        }
        if let a = r.agent {
            agent.stringValue = a.label
            agentColor = Theme.agentColor(a)
            agent.isHidden = false
            agentDot.isHidden = false
        } else {
            agent.isHidden = true
            agentDot.isHidden = true
        }
        title.stringValue = r.kind == .signature ? "" : sessionTitle ?? ""
        title.isHidden = title.stringValue.isEmpty
        parts = Self.line2(r, countsScoped: countsScoped)
        family.stringValue = parts.family ?? ""
        spark.daily = r.daily
        spark.isHidden = r.daily == nil
        toolTip = Self.tooltip(r, subject: text, sessionTitle: sessionTitle, analysis: analysis)
        setAccessibilityLabel(Self.accessibility(r, subject: text, outcome: o.text, sessionTitle: sessionTitle, parts: parts))
        applyColors()
        needsLayout = true
    }

    /// The subject of line 1, by row kind (§7.6).
    static func subject(_ r: QueueRow) -> String {
        switch r.kind {
        case .claim: return r.quote.map { "“\($0)”" } ?? "Claim in “\(r.title ?? "this turn")”"
        case .delegation: return r.title ?? r.target ?? r.id
        case .alarm:
            let what = r.alarmKind.map(DerivedStyle.alarmWord) ?? "alarm"
            return r.signature ?? r.target.map { what + ": " + $0 } ?? what
        case .session: return r.title ?? r.id
        default: return r.signature ?? r.target ?? r.errorLine ?? r.title ?? r.id
        }
    }

    /// The right part of line 2 and the family, by row kind.
    static func line2(_ r: QueueRow, countsScoped: Bool = false) -> Line2Parts {
        var p = Line2Parts()
        if r.kind == .signature {
            p.attempts = r.members.map { DerivedStyle.signatureCounts(episodes: $0, sessions: r.seenSessions, scoped: countsScoped) }
            if let w = r.wallUs, w > 0 { p.wall = Formatters.duration(w) + (r.wallSrc?.mark ?? "≈") + " lost" }
            p.family = r.family?.rawValue
            return p
        }
        if let n = r.attempts, n > 1 { p.attempts = Formatters.count(n, "attempt") }
        if let w = r.wallUs { p.wall = DerivedStyle.marked(Formatters.duration(w), r.wallSrc ?? Prov(rawValue: "derived")) + " lost" }
        if let s = r.seenSessions, s > 1 { p.sessions = "in " + Formatters.count(s, "session") }
        p.family = r.family?.rawValue
        return p
    }

    /// The subject in the UI font; a signature's placeholders muted (§3.2). `color` overrides both (a selected row).
    static func subjectString(_ text: String, signature: Bool, color: NSColor? = nil) -> NSAttributedString {
        let out = NSMutableAttributedString(string: text, attributes: [.font: Theme.font(.queuePrimary), .foregroundColor: color ?? NSColor.labelColor])
        let ns = text as NSString
        if color == nil, signature, let re = try? NSRegularExpression(pattern: #"<[a-z]+(:[^>]*)?>"#) {
            for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                out.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor, range: m.range)
            }
        }
        return out
    }

    static func tooltip(_ r: QueueRow, subject: String, sessionTitle: String?, analysis: AnalysisStatus?) -> String {
        var tip = [subject]
        if let e = r.errorLine, e != subject { tip.append(e) }
        if let t = sessionTitle { tip.append("Session: " + t) }
        tip.append(Formatters.timestamp(r.ts))
        if let src = r.outcomeSrc { tip.append("Outcome: " + DerivedStyle.provHelp(src, analysis: analysis)) }
        if let w = r.wallSrc { tip.append("Wall time: " + DerivedStyle.provHelp(w, analysis: analysis)) }
        if r.unattended { tip.append("Unattended: no human was watching") }
        return tip.joined(separator: "\n")
    }

    /// "ended on failure, <signature>, Claude Code, <session title>, 7m 29s lost, 2h ago" (§10.2).
    static func accessibility(_ r: QueueRow, subject: String, outcome: String, sessionTitle: String?, parts: Line2Parts) -> String {
        var items = [outcome, subject]
        if let a = r.agent { items.append(a.label) }
        if let t = sessionTitle, r.kind != .signature { items.append(t) }
        items += [parts.attempts, parts.wall, parts.sessions].compactMap { $0 }
        if r.live { items.append("live") }
        items.append(Formatters.relative(r.ts))
        return items.joined(separator: ", ")
    }

    override var backgroundStyle: NSView.BackgroundStyle {
        didSet { applyColors() }
    }

    private func applyColors() {
        let e = backgroundStyle == .emphasized
        let fg: NSColor = .alternateSelectedControlTextColor
        outcome.textColor = e ? fg : outcomeColor
        for l in [age, title, family, right, agent] { l.textColor = e ? fg : .secondaryLabelColor }
        live.textColor = e ? fg : .controlAccentColor
        tier.isEmphasized = e
        effectiveAppearance.performAsCurrentDrawingAppearance { agentDot.layer?.backgroundColor = (e ? fg : agentColor).cgColor }
        subject.attributedStringValue = Self.subjectString(subjectText, signature: subjectIsSignature, color: e ? fg : nil)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColors()
    }

    /// Which line-2 pieces show at `width` (§7.6 Line 2 priority): "in N sessions", then the family, then the attempts
    /// drop; then the title narrows to 96 pt, and below that (a queue narrower than its 440 pt minimum) to what is left.
    /// The title is never dropped while 24 pt remain, and `gap` always separates the left group from the right one.
    static func fitLine2(width: CGFloat, fixed: CGFloat, title: CGFloat, family: CGFloat, attempts: CGFloat, wall: CGFloat, sessions: CGFloat,
                         gap: CGFloat = 8) -> (family: Bool, attempts: Bool, sessions: Bool, title: CGFloat) {
        var show = (family: family > 0, attempts: attempts > 0, sessions: sessions > 0)
        func used() -> CGFloat {
            let rightW = [show.attempts ? attempts : 0, wall, show.sessions ? sessions : 0].filter { $0 > 0 }.reduce(0) { $0 + $1 + 10 }
            return fixed + (show.family ? family + 10 : 0) + rightW + gap
        }
        let floor = min(title, 96)
        if width - used() < floor { show.sessions = false }
        if width - used() < floor { show.family = false }
        if width - used() < floor { show.attempts = false }
        let room = min(title, width - used())
        return (show.family, show.attempts, show.sessions, room < min(title, 24) ? 0 : room)
    }

    override func layout() {
        super.layout()
        let w = bounds.width, h = bounds.height
        let pad: CGFloat = 12, textX: CGFloat = pad + 16 + 6
        let lineH: CGFloat = 17
        let top = h / 2 + 1, bottom = h / 2 - lineH + 1
        // A label draws its text 2 pt in from each side, which its intrinsic width leaves out.
        func width(_ l: NSTextField) -> CGFloat { l.isHidden || l.stringValue.isEmpty ? 0 : ceil(l.intrinsicContentSize.width) + 4 }
        // Line 1.
        icon.frame = NSRect(x: pad, y: top + 1, width: 16, height: 15)
        let ageW = min(56, width(age))
        age.frame = NSRect(x: w - pad - ageW, y: top, width: ageW, height: lineH)
        var edge = age.frame.minX - 8
        if !live.isHidden {
            let lw = width(live)
            live.frame = NSRect(x: edge - lw, y: top, width: lw, height: lineH)
            liveDot.frame = NSRect(x: live.frame.minX - 10, y: top + 4, width: 8, height: 8)
            edge = liveDot.frame.minX - 6
        }
        var x = textX
        if !spark.isHidden {
            spark.frame = NSRect(x: x, y: top + 2, width: 48, height: 14)
            x += 54
        }
        subject.frame = NSRect(x: x, y: top, width: max(0, edge - x), height: lineH)
        // Line 2.
        let ow = width(outcome)
        let tw = tier.isHidden ? 0 : tier.intrinsicContentSize.width
        let aw = agent.isHidden ? 0 : width(agent) + 12
        let fixed = ow + (tw > 0 ? tw + 6 : 0) + (aw > 0 ? aw + 10 : 0)
        func measure(_ s: String?) -> CGFloat {
            guard let s, !s.isEmpty else { return 0 }
            return ceil((s as NSString).size(withAttributes: [.font: Theme.font(.rowSecondary)]).width) + 4
        }
        let fit = Self.fitLine2(width: w - textX - pad, fixed: fixed, title: width(title), family: measure(parts.family), attempts: measure(parts.attempts),
                                wall: measure(parts.wall), sessions: measure(parts.sessions))
        right.stringValue = [fit.attempts ? parts.attempts : nil, parts.wall, fit.sessions ? parts.sessions : nil].compactMap { $0 }.joined(separator: " · ")
        let rw = width(right)
        right.frame = NSRect(x: w - pad - rw, y: bottom, width: rw, height: lineH)
        x = textX
        outcome.frame = NSRect(x: x, y: bottom, width: ow, height: lineH)
        x += ow + 6
        if tw > 0 {
            tier.frame = NSRect(x: x, y: bottom + 1, width: tw, height: 15)
            x += tw + 6
        }
        if aw > 0 {
            x += 4
            agentDot.frame = NSRect(x: x, y: bottom + 5, width: 8, height: 8)
            // The agent keeps its name whole down to the queue minimum; below it, it cuts before it touches the right group.
            agent.frame = NSRect(x: x + 12, y: bottom, width: max(0, min(aw - 12, right.frame.minX - 8 - x - 12)), height: lineH)
            x += aw + 6
        }
        title.frame = NSRect(x: x, y: bottom, width: fit.title, height: lineH)
        x += fit.title > 0 ? fit.title + 6 : 0
        family.isHidden = !fit.family || parts.family == nil
        family.frame = NSRect(x: x, y: bottom, width: max(0, min(measure(parts.family), right.frame.minX - x - 8)), height: lineH)
    }
}

/// A tiny sparkline of per-day counts.
final class SparkView: NSView {
    var daily: DailyCounts? { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        guard let daily else { return }
        let pts = DerivedStyle.sparkline(daily, in: bounds.insetBy(dx: 1, dy: 1))
        guard pts.count > 1, let ctx = NSGraphicsContext.current?.cgContext else { return }
        // AppKit views here are not flipped: y grows upward, so mirror the points.
        ctx.setStrokeColor(NSColor.secondaryLabelColor.cgColor)
        ctx.setLineWidth(1)
        ctx.addLines(between: pts.map { CGPoint(x: $0.x, y: bounds.height - $0.y) })
        ctx.strokePath()
    }

    override func isAccessibilityElement() -> Bool { false }
}
