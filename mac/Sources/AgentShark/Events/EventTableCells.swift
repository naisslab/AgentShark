import AppKit

/// A column of the event table (MAC-SPEC §5, SPEC §7.8 default and Advanced presets).
struct EventColumn {
    let id: String
    let title: String
    let width: CGFloat
    let minWidth: CGFloat
    let alignment: NSTextAlignment
    /// `WindowModel.sort` key; nil when the engine cannot sort by this column.
    let sortKey: String?
    let help: String

    static let gutterID = "mark"
    static let summaryID = "summary"
    static let customPrefix = "x:"

    static let all: [EventColumn] = [
        .init(id: "no", title: "No.", width: 62, minWidth: 40, alignment: .right, sortKey: "no", help: "Row number in the current view"),
        .init(id: "time", title: "Time", width: 112, minWidth: 60, alignment: .right, sortKey: "ts",
              help: "Event time. View ▸ Time Column Format changes this column only; hover for the full timestamp with its UTC offset."),
        .init(id: "delta", title: "Δ", width: 78, minWidth: 40, alignment: .right, sortKey: nil, help: "Time since the previous displayed event"),
        .init(id: "session", title: "Session", width: 150, minWidth: 60, alignment: .left, sortKey: "session", help: "Session title"),
        .init(id: "agent", title: "Agent", width: 96, minWidth: 50, alignment: .left, sortKey: nil, help: "Agent that wrote the log"),
        .init(id: "actor", title: "Actor", width: 72, minWidth: 40, alignment: .left, sortKey: nil, help: "Who produced the event"),
        .init(id: "kind", title: "Kind", width: 140, minWidth: 60, alignment: .left, sortKey: "kind", help: "Normalized event kind"),
        .init(id: "proto", title: "Record Type", width: 210, minWidth: 60, alignment: .left, sortKey: nil,
              help: "The native record type (proto), such as claude/assistant/tool_use"),
        .init(id: "tool", title: "Tool", width: 100, minWidth: 40, alignment: .left, sortKey: "tool", help: "Tool name"),
        .init(id: "model", title: "Model", width: 140, minWidth: 40, alignment: .left, sortKey: nil, help: "Model name"),
        .init(id: "duration", title: "Duration", width: 72, minWidth: 44, alignment: .right, sortKey: "dur",
              help: "Duration of the span this event opens or closes. — means the event has no measured span."),
        .init(id: "tokens", title: "Tokens", width: 100, minWidth: 50, alignment: .right, sortKey: nil,
              help: "Tokens: input (all prompt tokens, including cache) → output"),
        .init(id: "tokIn", title: "Tok In", width: 64, minWidth: 40, alignment: .right, sortKey: "tokIn", help: "Input tokens, including cache"),
        .init(id: "tokOut", title: "Tok Out", width: 64, minWidth: 40, alignment: .right, sortKey: "tokOut", help: "Output tokens"),
        .init(id: "tier", title: "Tier", width: 72, minWidth: 64, alignment: .left, sortKey: nil,
              help: "The failure tier of a failed call: failure, suspect, benign or deferred. — means the event is not a failure."),
        .init(id: summaryID, title: "Summary", width: 420, minWidth: 240, alignment: .left, sortKey: nil, help: "What happened, in one line"),
    ]

    /// The field the Tier column reads.
    static let tierField = "failure.tier"

    /// DESIGN.md §4.4 priorities: P1 never hides; P4, then P3 hide when Summary would get less than 45% of the table.
    static func priority(_ id: String) -> Int {
        switch id {
        case gutterID, "no", "time", summaryID: return 1
        case "kind", "duration", "tier", "x:failure.tier": return 2
        case "delta", "actor", "proto", "tokIn", "tokOut": return 4
        default: return 3
        }
    }

    static let byID: [String: EventColumn] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })

    static func custom(_ field: String) -> EventColumn {
        EventColumn(id: customPrefix + field, title: field, width: 120, minWidth: 40, alignment: .left, sortKey: nil,
                    help: "Custom column: \(field) (Apply as Column)")
    }
}

/// Fonts and row height of a table at the current density (DESIGN.md §3.1, §4.3): cells in Row primary with tabular
/// figures, machine text (Kind values, ids) in the code font.
struct EventTableFonts {
    let digits: NSFont
    let mono: NSFont
    let text: NSFont
    let secondary: NSFont
    let rowHeight: CGFloat

    init(density: Preferences.RowDensity) {
        digits = Theme.font(.rowPrimary, density)
        text = digits
        mono = Theme.font(.code, density)
        secondary = Theme.font(.rowSecondary, density)
        rowHeight = Theme.rowHeight(density)
    }
}

/// Layers that never animate (row decorations change while scrolling).
private func staticLayer() -> CALayer {
    let layer = CALayer()
    layer.actions = ["backgroundColor": NSNull(), "bounds": NSNull(), "position": NSNull(), "hidden": NSNull(), "frame": NSNull()]
    return layer
}

/// A row: subtle coloring-rule tint, the 3 pt kind bar at the leading edge and the rule's outline. All are plain
/// layers, so rows that scroll in cost no drawing.
final class EventRowView: NSTableRowView {
    var kindColor: NSColor? { didSet { if kindColor != oldValue { updateLayers() } } }
    var tint: NSColor? { didSet { if tint != oldValue { updateLayers() } } }
    /// The coloring rule's frame (the failure tiers: dashed red for suspect, amber for benign and deferred).
    var outline: RowOutline? { didSet { if outline != oldValue { updateLayers() } } }
    private let tintLayer = staticLayer()
    private let barLayer = staticLayer()
    private let outlineLayer: CAShapeLayer = {
        let l = CAShapeLayer()
        l.fillColor = nil
        l.lineWidth = 1
        l.actions = ["path": NSNull(), "strokeColor": NSNull(), "hidden": NSNull(), "bounds": NSNull(), "position": NSNull(), "lineDashPattern": NSNull()]
        return l
    }()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isSelected: Bool { didSet { updateLayers() } }

    override func layout() {
        super.layout()
        if tintLayer.superlayer == nil, let layer {
            layer.insertSublayer(tintLayer, at: 0)
            layer.insertSublayer(barLayer, above: tintLayer)
            layer.insertSublayer(outlineLayer, above: barLayer)
        }
        tintLayer.frame = bounds
        barLayer.frame = NSRect(x: 0, y: 0, width: Theme.kindBarWidth, height: bounds.height)
        outlineLayer.frame = bounds
        outlineLayer.path = CGPath(rect: bounds.insetBy(dx: 0.5, dy: 0.5), transform: nil)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateLayers()
    }

    private func updateLayers() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            // The selection replaces the tint; the kind bar stays.
            tintLayer.backgroundColor = isSelected ? nil : tint?.cgColor
            barLayer.backgroundColor = kindColor?.cgColor
            outlineLayer.isHidden = outline == nil
            outlineLayer.strokeColor = outline?.color.cgColor
            outlineLayer.lineDashPattern = outline?.style.dashPattern
        }
        needsLayout = true
    }
}

/// A text cell with an optional leading symbol. While its row loads it draws a skeleton bar instead.
/// Configuring a cell is on the scrolling path, so symbol images and line heights are cached and tooltips
/// are built only when one is shown.
final class EventTextCell: NSTableCellView, NSViewToolTipOwner {
    let label = NSTextField(labelWithString: "")
    let symbol = NSImageView()
    private let skeleton = NSView()
    private var baseColor: NSColor = .labelColor
    private var symbolColor: NSColor = .secondaryLabelColor
    private var symbolName: String?
    private var lineHeight: CGFloat = 14
    private var tooltipProvider: (() -> String?)?
    private var tooltipBounds: NSRect = .zero
    private static var symbolCache: [String: NSImage] = [:]
    private static var lineHeights: [CGFloat: CGFloat] = [:]
    var isPlaceholder = false {
        didSet {
            guard isPlaceholder != oldValue else { return }
            label.isHidden = isPlaceholder
            symbol.isHidden = isPlaceholder || symbol.image == nil
            skeleton.isHidden = !isPlaceholder
        }
    }

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        label.lineBreakMode = .byTruncatingTail
        label.usesSingleLineMode = true
        label.cell?.truncatesLastVisibleLine = true
        label.allowsDefaultTighteningForTruncation = false
        label.translatesAutoresizingMaskIntoConstraints = true
        symbol.imageScaling = .scaleProportionallyDown
        symbol.isHidden = true
        skeleton.wantsLayer = true
        skeleton.layer?.cornerRadius = 3
        skeleton.isHidden = true
        skeleton.setAccessibilityElement(false)
        addSubview(skeleton)
        addSubview(symbol)
        addSubview(label)
        textField = label
        imageView = symbol
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(_ text: String, font: NSFont, color: NSColor = .labelColor, alignment: NSTextAlignment = .left,
                   symbolName: String? = nil, symbolTint: NSColor = .secondaryLabelColor, dimmed: Bool = false,
                   tooltip: @autoclosure @escaping () -> String? = nil) {
        isPlaceholder = false
        if label.stringValue != text { label.stringValue = text }
        if label.font != font {
            label.font = font
            lineHeight = Self.lineHeight(for: font, in: label)
            needsLayout = true
        }
        if label.alignment != alignment { label.alignment = alignment }
        baseColor = color
        symbolColor = symbolTint
        if symbolName != self.symbolName {
            self.symbolName = symbolName
            symbol.image = symbolName.flatMap { Self.symbolImage($0, size: font.pointSize - 1) }
            symbol.isHidden = symbolName == nil
            needsLayout = true
        }
        let alpha: CGFloat = dimmed ? 0.55 : 1
        if alphaValue != alpha { alphaValue = alpha }
        tooltipProvider = tooltip
        applyColors()
    }

    func configurePlaceholder() {
        isPlaceholder = true
        tooltipProvider = nil
        if alphaValue != 1 { alphaValue = 1 }
    }

    private static func symbolImage(_ name: String, size: CGFloat) -> NSImage? {
        let key = "\(name)|\(size)"
        if let cached = symbolCache[key] { return cached }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: size, weight: .regular))
        symbolCache[key] = image
        return image
    }

    private static func lineHeight(for font: NSFont, in field: NSTextField) -> CGFloat {
        if let h = lineHeights[font.pointSize] { return h }
        let h = ceil(field.intrinsicContentSize.height)
        lineHeights[font.pointSize] = h
        return h
    }

    func view(_ view: NSView, stringForToolTip tag: NSView.ToolTipTag, point: NSPoint, userData data: UnsafeMutableRawPointer?) -> String {
        tooltipProvider?() ?? ""
    }

    override var backgroundStyle: NSView.BackgroundStyle {
        didSet { applyColors() }
    }

    private func applyColors() {
        let emphasized = backgroundStyle == .emphasized
        label.textColor = emphasized ? .alternateSelectedControlTextColor : baseColor
        symbol.contentTintColor = emphasized ? .alternateSelectedControlTextColor : symbolColor
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        var x: CGFloat = 2
        if !symbol.isHidden {
            let side = min(h, (label.font?.pointSize ?? 11) + 3)
            symbol.frame = NSRect(x: x, y: (h - side) / 2, width: side, height: side)
            x += side + 4
        }
        label.frame = NSRect(x: x, y: floor((h - lineHeight) / 2), width: max(0, bounds.width - x - 2), height: lineHeight)
        if bounds != tooltipBounds {
            tooltipBounds = bounds
            removeAllToolTips()
            addToolTip(bounds, owner: self, userData: nil)
        }
        skeleton.frame = NSRect(x: 4, y: (h - 6) / 2, width: max(12, min(bounds.width - 8, bounds.width * 0.6)), height: 6)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        effectiveAppearance.performAsCurrentDrawingAppearance { skeleton.layer?.backgroundColor = NSColor.quaternaryLabelColor.cgColor }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        viewDidChangeEffectiveAppearance()
    }
}

/// The mark gutter: a filled dot for marked rows.
final class MarkCell: NSTableCellView {
    private let dot = NSView()

    var isMarked = false {
        didSet {
            guard isMarked != oldValue else { return }
            dot.isHidden = !isMarked
            setAccessibilityLabel(isMarked ? "Marked" : nil)
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        dot.wantsLayer = true
        dot.isHidden = true
        addSubview(dot)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layout() {
        super.layout()
        let d: CGFloat = 7
        dot.frame = NSRect(x: (bounds.width - d) / 2 + 1, y: (bounds.height - d) / 2, width: d, height: d)
        dot.layer?.cornerRadius = d / 2
        updateColor()
    }

    override var backgroundStyle: NSView.BackgroundStyle {
        didSet { updateColor() }
    }

    private func updateColor() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            dot.layer?.backgroundColor = (backgroundStyle == .emphasized ? NSColor.alternateSelectedControlTextColor : NSColor.controlAccentColor).cgColor
        }
    }
}
