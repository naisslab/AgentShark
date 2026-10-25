import AppKit

/// One completion for the filter field.
struct FilterCompletion: Hashable {
    /// Text that replaces the completed range.
    let insert: String
    let title: String
    let type: String
    let detail: String
}

/// Completion candidates from the field registry (`/api/fields`), layers, kinds and flags (MAC-SPEC §4).
enum FilterCompletions {
    static let logicalOps: Set<String> = ["&&", "||", "!", "and", "or", "not"]

    /// Candidates for the caret position, with the range they replace; nil when nothing fits.
    /// `explicit` (⌥⎋) also completes at an empty position.
    static func candidates(text: String, caret: Int, fields: [FieldInfo], explicit: Bool = false) -> (range: NSRange, items: [FilterCompletion])? {
        let names = Set(fields.map(\.name))
        let tokens = FilterSyntaxHighlighter.tokens(text, fields: names)
        let current = tokens.last { $0.range.location < caret && caret <= NSMaxRange($0.range) }
        let before = tokens.filter { NSMaxRange($0.range) <= (current?.range.location ?? caret) }

        // A value after `field ==` (enum fields complete their values).
        if before.count >= 2, before[before.count - 1].kind == .op, !logicalOps.contains(before[before.count - 1].text.lowercased()),
           let field = fields.first(where: { $0.name == before[before.count - 2].text }), let values = field.values, !values.isEmpty {
            var prefix = ""
            var range = NSRange(location: caret, length: 0)
            if let current, [.string, .word, .invalid, .keyword, .field].contains(current.kind) {
                prefix = current.text.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                range = current.range
            } else if !explicit, caret > 0, (text as NSString).character(at: caret - 1) != 0x20 {
                return nil
            }
            let items = values.filter { prefix.isEmpty || $0.lowercased().hasPrefix(prefix.lowercased()) }
                .map { FilterCompletion(insert: FilterExpression.quote($0), title: $0, type: field.type, detail: "Value of \(field.name)") }
            guard !items.isEmpty, !(items.count == 1 && items[0].title == prefix) else { return nil }
            return (range, Array(items.prefix(200)))
        }

        // A field, layer, kind or flag at a field position.
        let previous = before.last
        let atFieldPosition = previous == nil || (previous!.kind == .op && logicalOps.contains(previous!.text.lowercased()))
            || (previous!.kind == .punctuation && previous!.text == "(")
        guard atFieldPosition else { return nil }
        var prefix = ""
        var range = NSRange(location: caret, length: 0)
        if let current {
            guard [.word, .field, .keyword].contains(current.kind), caret == NSMaxRange(current.range) else { return nil }
            prefix = current.text
            range = current.range
        } else if !explicit {
            return nil
        }
        let all = vocabulary(fields)
        let p = prefix.lowercased()
        let starts = all.filter { $0.title.lowercased().hasPrefix(p) }
        let contains = p.isEmpty ? [] : all.filter { !$0.title.lowercased().hasPrefix(p) && $0.title.lowercased().contains(p) }
        let items = starts.sorted { ($0.title.count, $0.title) < ($1.title.count, $1.title) } + contains
        guard !items.isEmpty, !(items.count == 1 && items[0].title == prefix) else { return nil }
        return (range, Array(items.prefix(200)))
    }

    /// Fields, then layers, kinds and flags, without duplicates.
    static func vocabulary(_ fields: [FieldInfo]) -> [FilterCompletion] {
        var seen = Set<String>()
        var out: [FilterCompletion] = []
        func add(_ c: FilterCompletion) {
            if seen.insert(c.title).inserted { out.append(c) }
        }
        for f in fields { add(FilterCompletion(insert: f.name, title: f.name, type: f.type, detail: f.description)) }
        for l in EventKind.layers { add(FilterCompletion(insert: l, title: l, type: "layer", detail: "Every \(l).* event")) }
        for k in fields.first(where: { $0.name == "kind" })?.values ?? [] {
            add(FilterCompletion(insert: k, title: k, type: "kind", detail: "Events of kind \(k)"))
        }
        for f in FilterSyntaxHighlighter.flags.sorted() {
            add(FilterCompletion(insert: f, title: f, type: "flag", detail: DetailTreeBuilder.flagHint(f).map { "Flag: \($0)" } ?? "Flag"))
        }
        return out
    }

    /// "Did you mean" suggestions: from the engine's message, then registered names close to the bad token.
    static func suggestions(message: String, badToken: String?, fields: [FieldInfo]) -> [String] {
        var out: [String] = []
        if let r = message.range(of: #"(?i)did you mean '([^']+)'"#, options: .regularExpression) {
            let quoted = message[r]
            if let open = quoted.firstIndex(of: "'"), let close = quoted.lastIndex(of: "'"), open < close {
                out.append(String(quoted[quoted.index(after: open)..<close]))
            }
        }
        if let bad = badToken?.lowercased(), bad.count >= 2 {
            let names = vocabulary(fields).map(\.title)
            let near = names.map { ($0, distance(bad, $0.lowercased())) }.filter { $0.1 <= max(1, bad.count / 4) && $0.1 > 0 }
                .sorted { ($0.1, $0.0) < ($1.1, $1.0) }
            for (name, _) in near.prefix(3) where !out.contains(name) { out.append(name) }
        }
        return out
    }

    /// Levenshtein distance (short strings only).
    static func distance(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        guard !a.isEmpty else { return b.count }
        guard !b.isEmpty else { return a.count }
        var prev = Array(0...b.count)
        for i in 1...a.count {
            var cur = [i] + Array(repeating: 0, count: b.count)
            for j in 1...b.count {
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            prev = cur
        }
        return prev[b.count]
    }
}

/// The completion list under the filter field: a borderless child window that never takes key focus, so
/// typing continues in the field. Arrow keys move, Return or Tab accept, Escape closes.
@MainActor final class FilterCompletionPanel: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    private let panel: Panel
    private let table = NSTableView()
    private(set) var items: [FilterCompletion] = []
    private(set) var range = NSRange(location: 0, length: 0)
    var onAccept: ((FilterCompletion, NSRange) -> Void)?

    static let rowHeight: CGFloat = 22
    static let width: CGFloat = 560

    override init() {
        panel = Panel(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 200), styleMask: [.borderless, .nonactivatingPanel],
                      backing: .buffered, defer: true)
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .popUpMenu
        panel.hidesOnDeactivate = true
        let effect = NSVisualEffectView()
        effect.material = .menu
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 8
        effect.layer?.masksToBounds = true
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("completion"))
        table.addTableColumn(column)
        table.headerView = nil
        table.style = .plain
        table.backgroundColor = .clear
        table.rowHeight = Self.rowHeight
        table.intercellSpacing = .zero
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(clicked)
        table.refusesFirstResponder = true
        table.setAccessibilityLabel("Filter completions")
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.contentView.drawsBackground = false
        effect.addSubview(scroll)
        scroll.frame = effect.bounds.insetBy(dx: 0, dy: 4)
        scroll.autoresizingMask = [.width, .height]
        panel.contentView = effect
    }

    var isVisible: Bool { panel.isVisible }

    var selected: FilterCompletion? {
        items.indices.contains(table.selectedRow) ? items[table.selectedRow] : nil
    }

    /// Show `items` under `anchor` (screen coordinates of the completed text) in `parent`.
    func show(_ items: [FilterCompletion], range: NSRange, below anchor: NSRect, parent: NSWindow) {
        let keep = selected
        self.items = items
        self.range = range
        table.reloadData()
        let row = keep.flatMap { items.firstIndex(of: $0) } ?? 0
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        table.scrollRowToVisible(row)
        let height = min(CGFloat(items.count), 10) * Self.rowHeight + 8
        let screen = parent.screen?.visibleFrame ?? .infinite
        var origin = NSPoint(x: anchor.minX - 8, y: anchor.minY - height - 4)
        origin.x = min(max(screen.minX, origin.x), screen.maxX - Self.width)
        if origin.y < screen.minY { origin.y = anchor.maxY + 4 }
        panel.setFrame(NSRect(x: origin.x, y: origin.y, width: Self.width, height: height), display: true)
        if panel.parent == nil { parent.addChildWindow(panel, ordered: .above) }
        panel.orderFront(nil)
        NSAccessibility.post(element: table, notification: .selectedRowsChanged)
    }

    func hide() {
        guard panel.isVisible else { return }
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
    }

    func move(_ delta: Int) {
        guard !items.isEmpty else { return }
        let row = max(0, min(items.count - 1, table.selectedRow + delta))
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        table.scrollRowToVisible(row)
    }

    @objc private func clicked() {
        guard items.indices.contains(table.clickedRow) else { return }
        onAccept?(items[table.clickedRow], range)
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("completionCell")
        let cell = tableView.makeView(withIdentifier: id, owner: nil) as? CompletionCell ?? CompletionCell(identifier: id)
        cell.configure(items[row])
        return cell
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let rv = NSTableRowView()
        rv.selectionHighlightStyle = .regular
        rv.isEmphasized = true
        return rv
    }

    private final class CompletionCell: NSTableCellView {
        let name = NSTextField(labelWithString: "")
        let type = NSTextField(labelWithString: "")
        let detail = NSTextField(labelWithString: "")

        init(identifier: NSUserInterfaceItemIdentifier) {
            super.init(frame: .zero)
            self.identifier = identifier
            name.font = Theme.codeFont(size: 12)
            type.font = .systemFont(ofSize: 10, weight: .medium)
            detail.font = .systemFont(ofSize: 11)
            for f in [name, type, detail] {
                f.lineBreakMode = .byTruncatingTail
                f.cell?.truncatesLastVisibleLine = true
                addSubview(f)
            }
            textField = name
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        func configure(_ c: FilterCompletion) {
            name.stringValue = c.title
            type.stringValue = c.type
            detail.stringValue = c.detail
            setAccessibilityLabel("\(c.title), \(c.type). \(c.detail)")
            applyColors()
            needsLayout = true
        }

        override var backgroundStyle: NSView.BackgroundStyle {
            didSet { applyColors() }
        }

        private func applyColors() {
            let emphasized = backgroundStyle == .emphasized
            name.textColor = emphasized ? .alternateSelectedControlTextColor : .labelColor
            type.textColor = emphasized ? .alternateSelectedControlTextColor : .secondaryLabelColor
            detail.textColor = emphasized ? .alternateSelectedControlTextColor : .secondaryLabelColor
        }

        override func layout() {
            super.layout()
            let h = bounds.height
            let nameWidth = min(200, ceil(name.intrinsicContentSize.width))
            func place(_ f: NSTextField, x: CGFloat, width: CGFloat) {
                let lh = ceil(f.intrinsicContentSize.height)
                f.frame = NSRect(x: x, y: floor((h - lh) / 2), width: max(0, width), height: lh)
            }
            place(name, x: 10, width: nameWidth)
            let typeWidth: CGFloat = 60
            place(type, x: 10 + nameWidth + 8, width: typeWidth)
            let x = 10 + nameWidth + 8 + typeWidth + 4
            place(detail, x: x, width: bounds.width - x - 10)
        }
    }
}
