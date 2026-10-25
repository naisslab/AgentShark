import AppKit
import SwiftUI

/// The display filter field in the scope bar (MAC-SPEC §4, DESIGN.md §7.2): live syntax coloring, validation 150 ms after the
/// last keystroke (bezel tint and a squiggle under the error, with a popover message and suggestions),
/// completion from the field registry, recent filters (⌄) and bookmarks (★). Return applies, Escape
/// reverts to the applied filter, ⌘⌫ clears.
struct FilterField: NSViewRepresentable {
    let model: WindowModel

    func makeNSView(context: Context) -> FilterFieldView { FilterFieldView(model: model) }
    func updateNSView(_ view: FilterFieldView, context: Context) {}

    static func dismantleNSView(_ view: FilterFieldView, coordinator: ()) { view.tearDown() }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: FilterFieldView, context: Context) -> CGSize? {
        CGSize(width: max(FilterFieldView.minWidth, proposal.width ?? FilterFieldView.idealWidth), height: FilterFieldView.height)
    }
}

/// The field's text field: its focus ring follows the whole rounded field, not only the text.
final class FilterTextField: NSTextField {
    var focusRingPath: (() -> NSBezierPath)?

    override var focusRingMaskBounds: NSRect {
        focusRingPath?().bounds ?? super.focusRingMaskBounds
    }

    override func drawFocusRingMask() {
        if let path = focusRingPath?() { path.fill() } else { super.drawFocusRingMask() }
    }
}

/// Draws a red wavy underline under the error range. It never takes clicks.
final class SquiggleView: NSView {
    var segment: NSRect? { didSet { needsDisplay = true } }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let s = segment else { return }
        let path = NSBezierPath()
        let amplitude: CGFloat = 1.5, wavelength: CGFloat = 4
        var x = s.minX
        let y = s.minY + amplitude
        path.move(to: NSPoint(x: x, y: y))
        var up = true
        while x < s.maxX {
            let next = min(x + wavelength / 2, s.maxX)
            path.curve(to: NSPoint(x: next, y: y), controlPoint1: NSPoint(x: x + wavelength / 4, y: y + (up ? amplitude : -amplitude)),
                       controlPoint2: NSPoint(x: next - wavelength / 4, y: y + (up ? amplitude : -amplitude)))
            x = next
            up.toggle()
        }
        path.lineWidth = 1.2
        NSColor.systemRed.setStroke()
        path.stroke()
    }
}

@MainActor final class FilterFieldView: NSView, NSTextFieldDelegate {
    enum Validation { case neutral, valid, invalid, warning }

    static let height: CGFloat = 24
    static let minWidth: CGFloat = 320
    static let idealWidth: CGFloat = 360

    let model: WindowModel
    let textField = FilterTextField()
    private let icon = NSImageView()
    private let clearButton = NSButton()
    private let historyButton = NSButton()
    private let bookmarkButton = NSButton()
    private let applyHint = NSTextField(labelWithString: "↩ to apply")
    private let squiggle = SquiggleView()
    private let completion = FilterCompletionPanel()
    private var errorPopover: NSPopover?
    private var loops: [ObservationLoop] = []
    private var validation: Validation = .neutral
    private var isEditing = false
    private var lastFocusRequest: Int
    private var lastAnnounced: String?
    private let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

    init(model: WindowModel) {
        self.model = model
        lastFocusRequest = model.filterFocusRequest
        super.init(frame: NSRect(x: 0, y: 0, width: 480, height: Self.height))
        setUp()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func tearDown() {
        loops.forEach { $0.cancel() }
        loops.removeAll()
        completion.hide()
        errorPopover?.close()
    }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: Self.height) }

    private func setUp() {
        icon.image = NSImage(systemSymbolName: "line.3.horizontal.decrease.circle", accessibilityDescription: nil)
        icon.symbolConfiguration = .init(pointSize: 13, weight: .regular)
        icon.contentTintColor = .secondaryLabelColor
        icon.setAccessibilityElement(false)

        textField.isBordered = false
        textField.isBezeled = false
        textField.drawsBackground = false
        textField.focusRingType = .default
        textField.font = font
        textField.usesSingleLineMode = true
        textField.lineBreakMode = .byClipping
        textField.cell?.isScrollable = true
        textField.cell?.wraps = false
        textField.delegate = self
        textField.placeholderAttributedString = NSAttributedString(string: #"Filter events, e.g. tool.name == "Bash" && dur > 5s"#,
                                                                   attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.placeholderTextColor])
        textField.setAccessibilityLabel("Display filter")
        textField.toolTip = "Display filter. Return applies, Escape reverts to the applied filter, ⌘⌫ clears. ⌥⎋ shows completions."
        textField.focusRingPath = { [weak self] in self?.bezelPath(in: self?.textField) ?? NSBezierPath() }

        configure(clearButton, symbol: "xmark.circle.fill", help: "Clear Filter (⌘⌫)", action: #selector(clearFilter))
        configure(historyButton, symbol: "chevron.down", help: "Recent Filters", action: #selector(showHistory))
        configure(bookmarkButton, symbol: "star", help: "Filters: examples and saved filters", action: #selector(showBookmarks))
        clearButton.isHidden = true

        applyHint.font = .systemFont(ofSize: 10)
        applyHint.textColor = .tertiaryLabelColor
        applyHint.isHidden = true
        applyHint.setAccessibilityElement(false)

        for v in [icon, textField, applyHint, clearButton, historyButton, bookmarkButton, squiggle] as [NSView] { addSubview(v) }
        completion.onAccept = { [weak self] item, range in self?.accept(item, range: range) }

        loops.append(ObservationLoop { [weak self] in self?.followText() })
        loops.append(ObservationLoop { [weak self] in self?.followValidation() })
        loops.append(ObservationLoop { [weak self] in self?.followFocusRequest() })
    }

    private func configure(_ b: NSButton, symbol: String, help: String, action: Selector) {
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: help)
        b.symbolConfiguration = .init(pointSize: 11, weight: .medium)
        b.isBordered = false
        b.bezelStyle = .accessoryBarAction
        b.contentTintColor = .secondaryLabelColor
        b.toolTip = help
        b.setAccessibilityLabel(help)
        b.target = self
        b.action = action
        b.refusesFirstResponder = false
    }

    // MARK: Layout and drawing

    override func layout() {
        super.layout()
        let h = bounds.height
        icon.frame = NSRect(x: 7, y: (h - 16) / 2, width: 16, height: 16)
        var right = bounds.maxX - 6
        for b in [bookmarkButton, historyButton] {
            b.frame = NSRect(x: right - 20, y: (h - 20) / 2, width: 20, height: 20)
            right -= 20
        }
        if !clearButton.isHidden {
            clearButton.frame = NSRect(x: right - 20, y: (h - 20) / 2, width: 20, height: 20)
            right -= 22
        }
        if !applyHint.isHidden {
            let w = ceil(applyHint.intrinsicContentSize.width)
            applyHint.frame = NSRect(x: right - w - 2, y: (h - 14) / 2, width: w, height: 14)
            right -= w + 6
        }
        let lineHeight = ceil(textField.intrinsicContentSize.height)
        textField.frame = NSRect(x: 27, y: floor((h - lineHeight) / 2), width: max(20, right - 29), height: lineHeight)
        squiggle.frame = bounds
        textField.noteFocusRingMaskChanged()
        updateSquiggle()
    }

    /// The rounded bezel, in `view`'s coordinates (self when nil).
    private func bezelPath(in view: NSView?) -> NSBezierPath {
        let r = bounds.insetBy(dx: 0.5, dy: 0.5)
        let rect = view.map { $0.convert(r, from: self) } ?? r
        return NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7)
    }

    override func draw(_ dirtyRect: NSRect) {
        let path = bezelPath(in: nil)
        NSColor.textBackgroundColor.setFill()
        path.fill()
        let tint: NSColor? = switch validation {
        case .valid: .systemGreen
        case .invalid: .systemRed
        case .warning: .systemYellow
        case .neutral: nil
        }
        if let tint {
            tint.withAlphaComponent(0.10).setFill()
            path.fill()
        }
        (tint?.withAlphaComponent(0.75) ?? NSColor.separatorColor).setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        rehighlight()
        needsDisplay = true
    }

    // MARK: Following the model

    private func followText() {
        let text = model.filterText
        let applied = model.appliedFilter
        _ = model.store.fieldNames
        if currentText != text { setText(text) } else { rehighlight() }
        clearButton.isHidden = text.isEmpty
        updateApplyHint(text: text, applied: applied)
    }

    /// "↩ to apply" while a valid edit differs from the applied filter.
    private func updateApplyHint(text: String, applied: String) {
        let hint = isEditing && !text.isEmpty && text.trimmingCharacters(in: .whitespaces) != applied
            && (validation == .valid || validation == .warning)
        if applyHint.isHidden == hint { applyHint.isHidden = !hint }
        needsLayout = true
    }

    private func followValidation() {
        let check = model.filterCheck
        let text = model.filterText
        let state: Validation
        if text.trimmingCharacters(in: .whitespaces).isEmpty || check == nil {
            state = .neutral
        } else if check!.ok {
            state = check!.warning == nil ? .valid : .warning
        } else {
            state = .invalid
        }
        if state != validation {
            validation = state
            needsDisplay = true
        }
        textField.setAccessibilityValueDescription(state == .invalid ? "Invalid filter" : state == .warning ? "Valid, with a warning" : nil)
        updateSquiggle()
        updateErrorPopover()
        updateApplyHint(text: text, applied: model.appliedFilter)
        bookmarkButton.image = NSImage(systemSymbolName: model.app.bookmarks.all.contains { $0.filter == text } ? "star.fill" : "star",
                                       accessibilityDescription: "Filters")
    }

    private func followFocusRequest() {
        let request = model.filterFocusRequest
        guard request != lastFocusRequest else { return }
        lastFocusRequest = request
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else { return }
            window.makeFirstResponder(self.textField)
            // Put the caret at the error, if there is one.
            if let e = self.model.filterCheck?.error, let editor = self.textField.currentEditor() {
                let length = (self.currentText as NSString).length
                editor.selectedRange = NSRange(location: min(e.start, length), length: 0)
            }
        }
    }

    // MARK: Text

    private var currentText: String {
        (textField.currentEditor() as? NSTextView)?.string ?? textField.stringValue
    }

    private func setText(_ text: String) {
        if let editor = textField.currentEditor() as? NSTextView {
            editor.string = text
            editor.selectedRange = NSRange(location: (text as NSString).length, length: 0)
        } else {
            textField.stringValue = text
        }
        rehighlight()
    }

    private func rehighlight() {
        let names = model.store.fieldNames
        let text = currentText
        if let editor = textField.currentEditor() as? NSTextView, let storage = editor.textStorage {
            let colored = FilterSyntaxHighlighter.highlight(text, fields: names, font: font)
            storage.beginEditing()
            colored.enumerateAttributes(in: NSRange(location: 0, length: colored.length)) { attrs, range, _ in
                storage.setAttributes(attrs, range: range)
            }
            storage.endEditing()
            editor.typingAttributes = [.font: font, .foregroundColor: NSColor.labelColor]
        } else {
            textField.attributedStringValue = FilterSyntaxHighlighter.highlight(text, fields: names, font: font)
        }
    }

    // MARK: Error squiggle and popover

    private var errorRange: NSRange? {
        guard validation == .invalid, let e = model.filterCheck?.error else { return nil }
        let length = (currentText as NSString).length
        let start = min(max(0, e.start), length)
        let end = min(max(start, e.end), length)
        return NSRange(location: start, length: end - start)
    }

    /// The error range's rect in this view's coordinates (a short segment at the end when the range is empty).
    private func errorRect() -> NSRect? {
        guard let range = errorRange else { return nil }
        let text = currentText as NSString
        var rect: NSRect
        if let editor = textField.currentEditor() as? NSTextView, let window {
            let r = range.length > 0 ? range : NSRange(location: max(0, range.location - 1), length: min(1, text.length))
            let screen = editor.firstRect(forCharacterRange: r, actualRange: nil)
            rect = convert(window.convertFromScreen(screen), from: nil)
            if range.length == 0 { rect.origin.x = rect.maxX; rect.size.width = 6 }
        } else {
            let attrs: [NSAttributedString.Key: Any] = [.font: font]
            let x0 = text.substring(to: range.location).size(withAttributes: attrs).width
            let w = range.length > 0 ? text.substring(with: range).size(withAttributes: attrs).width : 6
            let origin = textField.frame.origin
            rect = NSRect(x: origin.x + 2 + x0, y: origin.y, width: w, height: textField.frame.height)
        }
        let clip = textField.frame
        let x0 = max(rect.minX, clip.minX), x1 = min(rect.maxX, clip.maxX)
        guard x1 > x0 else { return nil }
        return NSRect(x: x0, y: rect.minY, width: x1 - x0, height: rect.height)
    }

    private func updateSquiggle() {
        guard let r = errorRect() else {
            squiggle.segment = nil
            return
        }
        squiggle.segment = NSRect(x: r.minX, y: textField.frame.minY - 1, width: max(6, r.width), height: 4)
    }

    private func updateErrorPopover() {
        guard isEditing, !completion.isVisible, let e = model.filterCheck?.error, validation == .invalid, let rect = errorRect() else {
            errorPopover?.close()
            errorPopover = nil
            return
        }
        let text = currentText as NSString
        let range = errorRange ?? NSRange(location: 0, length: 0)
        let bad = range.length > 0 ? text.substring(with: range) : FilterSyntaxHighlighter.token(at: range.location, in: currentText)?.text
        let suggestions = FilterCompletions.suggestions(message: e.message, badToken: bad, fields: model.store.fields)
        let content = FilterErrorView(message: e.message, suggestions: suggestions) { [weak self] s in self?.replaceError(with: s) }
        if lastAnnounced != e.message {
            lastAnnounced = e.message
            NSAccessibility.post(element: textField, notification: .announcementRequested,
                                 userInfo: [.announcement: "Invalid filter: \(e.message)", .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        }
        if let popover = errorPopover, let host = popover.contentViewController as? NSHostingController<FilterErrorView> {
            host.rootView = content
            popover.positioningRect = rect
            return
        }
        let popover = NSPopover()
        popover.behavior = .applicationDefined
        popover.animates = false
        popover.contentViewController = NSHostingController(rootView: content)
        popover.show(relativeTo: rect, of: self, preferredEdge: .minY)
        errorPopover = popover
    }

    /// Replace the error range (or the word at the error) with a suggestion.
    private func replaceError(with suggestion: String) {
        guard let range = errorRange else { return }
        let text = currentText as NSString
        let target = range.length > 0 ? range : FilterSyntaxHighlighter.token(at: range.location, in: currentText)?.range ?? range
        let updated = text.replacingCharacters(in: target, with: suggestion)
        model.filterText = updated
        window?.makeFirstResponder(textField)
    }

    // MARK: Completion

    private func updateCompletion(explicit: Bool = false) {
        guard let editor = textField.currentEditor() as? NSTextView, let window else { return completion.hide() }
        let caret = editor.selectedRange().location
        guard editor.selectedRange().length == 0,
              let found = FilterCompletions.candidates(text: editor.string, caret: caret, fields: model.store.fields, explicit: explicit) else {
            completion.hide()
            updateErrorPopover()
            return
        }
        let anchorRange = found.range.length > 0 ? found.range : NSRange(location: caret, length: 0)
        let anchor = editor.firstRect(forCharacterRange: anchorRange, actualRange: nil)
        errorPopover?.close()
        errorPopover = nil
        completion.show(found.items, range: found.range, below: anchor, parent: window)
    }

    private func accept(_ item: FilterCompletion, range: NSRange) {
        guard let editor = textField.currentEditor() as? NSTextView else { return }
        let text = editor.string as NSString
        guard NSMaxRange(range) <= text.length else { return completion.hide() }
        editor.insertText(item.insert, replacementRange: range)
        completion.hide()
        model.filterText = editor.string
        rehighlight()
    }

    // MARK: NSTextFieldDelegate

    func controlTextDidBeginEditing(_ obj: Notification) {
        isEditing = true
        model.filterFieldIsFocused = true
        rehighlight()
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        isEditing = false
        model.filterFieldIsFocused = false
        completion.hide()
        errorPopover?.close()
        errorPopover = nil
        applyHint.isHidden = true
        rehighlight()
        updateSquiggle()
        needsLayout = true
    }

    func controlTextDidChange(_ obj: Notification) {
        let text = currentText
        if model.filterText != text { model.filterText = text }
        rehighlight()
        updateCompletion()
        updateSquiggle()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.moveDown(_:)) where completion.isVisible:
            completion.move(1)
            return true
        case #selector(NSResponder.moveUp(_:)) where completion.isVisible:
            completion.move(-1)
            return true
        case #selector(NSResponder.insertTab(_:)) where completion.isVisible,
             #selector(NSResponder.insertNewline(_:)) where completion.isVisible:
            if let item = completion.selected { accept(item, range: completion.range) }
            return true
        case #selector(NSResponder.insertNewline(_:)):
            model.applyFilter(textView.string)
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            if completion.isVisible {
                completion.hide()
                updateErrorPopover()
            } else {
                model.revertFilterText()
                setText(model.appliedFilter)
            }
            return true
        case #selector(NSResponder.complete(_:)):
            updateCompletion(explicit: true)
            return true
        default:
            return false
        }
    }

    // MARK: Buttons

    @objc private func clearFilter() {
        model.clearFilter()
        window?.makeFirstResponder(textField)
    }

    @objc private func showHistory() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let recent = model.app.preferences.recentFilters
        menu.addItem(.sectionHeader(title: "Recent Filters"))
        if recent.isEmpty {
            menu.addItem("No Recent Filters", enabled: false) {}
        }
        for f in recent {
            let item = menu.addItem(Self.menuTitle(f)) { [weak self] in self?.model.applyFilter(f) }
            item.toolTip = f
            item.state = f == model.appliedFilter ? .on : .off
        }
        menu.addItem(.separator())
        menu.addItem("Clear Recent Filters", enabled: !recent.isEmpty) { [weak self] in self?.model.app.preferences.clearRecentFilters() }
        menu.popUp(positioning: nil, at: NSPoint(x: historyButton.frame.minX, y: historyButton.frame.minY - 4), in: self)
    }

    @objc private func showBookmarks() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let model = self.model
        let current = currentText.trimmingCharacters(in: .whitespaces)
        menu.addItem("Save Filter…", symbol: "star", enabled: !current.isEmpty || !model.appliedFilter.isEmpty) {
            model.presentedSheet = .saveFilter
        }
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "Examples"))
        for b in Bookmarks.presets {
            let item = menu.addItem(b.name) { model.applyFilter(b.filter) }
            item.toolTip = b.filter
        }
        let user = model.app.bookmarks.user
        if !user.isEmpty {
            menu.addItem(.separator())
            menu.addItem(.sectionHeader(title: "Saved Filters"))
            for b in user {
                let item = menu.addItem(b.name) { model.applyFilter(b.filter) }
                item.toolTip = b.filter
            }
            menu.addItem(.separator())
            menu.addSubmenu("Remove Saved Filter") { sub in
                for b in user { sub.addItem(b.name) { model.app.bookmarks.remove(b.id) } }
            }
        }
        menu.popUp(positioning: nil, at: NSPoint(x: bookmarkButton.frame.minX, y: bookmarkButton.frame.minY - 4), in: self)
    }

    private static func menuTitle(_ filter: String) -> String {
        filter.count > 80 ? String(filter.prefix(79)) + "…" : filter
    }
}

/// The error popover under the filter field: the engine's message and "Did you mean" buttons.
struct FilterErrorView: View {
    let message: String
    let suggestions: [String]
    let apply: (String) -> Void

    /// The engine's message as a sentence, without its own "Did you mean" when buttons offer it.
    private var sentence: String {
        var m = message
        if !suggestions.isEmpty {
            m = m.replacingOccurrences(of: #"\s*(?i:did you mean) '[^']+'\??"#, with: "", options: .regularExpression)
        }
        guard let first = m.first else { return m }
        return first.uppercased() + m.dropFirst()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text(sentence).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.octagon.fill").foregroundStyle(.red)
            }
            .font(.callout)
            if !suggestions.isEmpty {
                HStack(spacing: 6) {
                    Text("Did you mean").font(.callout).foregroundStyle(.secondary)
                    ForEach(suggestions, id: \.self) { s in
                        Button(s) { apply(s) }
                            .font(Theme.fontSwiftUI(.code))
                            .controlSize(.small)
                            .help("Replace the highlighted text with \(s)")
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: 420, alignment: .leading)
    }
}
