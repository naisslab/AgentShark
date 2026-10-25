import AppKit

/// Drawing shared by the timeline, the track strip and the flow diagram. Call inside `draw(_:)`, where AppKit has
/// made the view's appearance current, so dynamic colors resolve for Light or Dark Mode.
@MainActor enum TimelineDrawing {
    static let tickFont = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
    static let barFont = NSFont.systemFont(ofSize: 10)
    static let captionFont = NSFont.systemFont(ofSize: 10.5)

    /// A coordinate snapped to device pixels, so edges stay crisp on Retina displays.
    static func snap(_ v: CGFloat, _ backingScale: CGFloat) -> CGFloat { (v * backingScale).rounded() / backingScale }

    // MARK: Color

    /// Black or white text for a fill, whichever contrasts more in the current appearance.
    static func ink(on fill: NSColor, alpha: CGFloat = 1) -> NSColor {
        guard let c = fill.usingColorSpace(.sRGB) else { return .labelColor }
        func lin(_ v: CGFloat) -> CGFloat { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        // Composite over the plot background for translucent fills.
        let bg: CGFloat = NSAppearance.currentDrawing().isDark ? 0.12 : 1
        let a = c.alphaComponent * alpha
        let r = c.redComponent * a + bg * (1 - a), g = c.greenComponent * a + bg * (1 - a), b = c.blueComponent * a + bg * (1 - a)
        let l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? NSColor.white : NSColor.black.withAlphaComponent(0.85)
    }

    // MARK: Text

    private static func attributes(_ font: NSFont, _ color: NSColor, _ alignment: NSTextAlignment) -> [NSAttributedString.Key: Any] {
        let p = NSMutableParagraphStyle()
        p.lineBreakMode = .byTruncatingTail
        p.alignment = alignment
        return [.font: font, .foregroundColor: color, .paragraphStyle: p]
    }

    /// One line of text, truncated with an ellipsis, vertically centered in `rect`.
    static func text(_ s: String, in rect: CGRect, font: NSFont, color: NSColor, alignment: NSTextAlignment = .left) {
        guard rect.width > 4, !s.isEmpty else { return }
        let lineHeight = ceil(font.ascender - font.descender + font.leading)
        let r = CGRect(x: rect.minX, y: rect.midY - lineHeight / 2, width: rect.width, height: lineHeight)
        (s as NSString).draw(with: r, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                             attributes: attributes(font, color, alignment))
    }

    static func width(_ s: String, font: NSFont) -> CGFloat {
        ceil((s as NSString).size(withAttributes: [.font: font]).width)
    }

    // MARK: Symbols

    private static var symbolCache: [String: NSImage] = [:]

    /// An SF Symbol with hierarchical rendering in `color`, cached per appearance.
    static func symbol(_ name: String, size: CGFloat, color: NSColor, colorKey: String, weight: NSFont.Weight = .regular) -> NSImage? {
        let key = "\(name)|\(size)|\(colorKey)|\(NSAppearance.currentDrawing().name.rawValue)"
        if let img = symbolCache[key] { return img }
        let config = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
            .applying(NSImage.SymbolConfiguration(hierarchicalColor: color.usingColorSpace(.sRGB) ?? color))
        let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config)
        if symbolCache.count > 200 { symbolCache.removeAll() }
        symbolCache[key] = img
        return img
    }

    /// Draw a symbol centered in `rect`.
    static func draw(_ image: NSImage?, centeredIn rect: CGRect) {
        guard let image else { return }
        let s = image.size
        image.draw(in: CGRect(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2, width: s.width, height: s.height),
                   from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    // MARK: Ruler

    /// The room a tick label keeps from a label drawn over the axis (the strip's date and offset).
    static let tickClearance: CGFloat = 6

    /// Whether a tick label at `x` (its left edge) of `width` keeps `tickClearance` from `keepClear`, a label drawn over
    /// the axis after it; a label that would not is left out whole, never cut (DESIGN.md §3.5).
    static func tickLabelClears(x: CGFloat, width: CGFloat, of keepClear: CGRect?) -> Bool {
        guard let keepClear else { return true }
        return x + width + tickClearance <= keepClear.minX || x >= keepClear.maxX + tickClearance
    }

    /// Tick marks and labels in [x0, x0 + width] × [y, y + height]; labels that would run into a break, or come within
    /// `tickClearance` of `keepClear` (a label drawn over the axis, such as the date), are left out.
    static func ruler(_ ctx: CGContext, axis: TimeTicks.Axis, scale: TimeScale, x0: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat,
                      backingScale: CGFloat, keepClear: CGRect? = nil) {
        let breaks = scale.breaks(from: scale.t(0), to: scale.t(Double(width))).map { x0 + CGFloat($0.x) }
        let px = 1 / backingScale
        ctx.saveGState()
        ctx.clip(to: CGRect(x: x0, y: y, width: width, height: height))
        var right = -CGFloat.infinity
        for tk in axis.ticks {
            let x = snap(x0 + CGFloat(tk.x), backingScale)
            let len: CGFloat = tk.major ? 7 : 4
            ctx.setFillColor(NSColor.tertiaryLabelColor.cgColor)
            ctx.fill(CGRect(x: x, y: y + height - len, width: px, height: len))
            let tw = TimelineDrawing.width(tk.text, font: tickFont)
            let lx = x + 3
            if lx < right + 8 || lx + tw > x0 + width || !tickLabelClears(x: lx, width: tw, of: keepClear) { continue }
            if breaks.contains(where: { lx < $0 + CGFloat(scale.breakWidth) + 2 && lx + tw > $0 - 2 }) { continue }
            text(tk.text, in: CGRect(x: lx, y: y, width: tw + 1, height: height - 4), font: tickFont,
                 color: tk.major ? .labelColor : .secondaryLabelColor)
            right = lx + tw
        }
        ctx.restoreGState()
    }

    /// Collapsed gaps: a recessed band with zigzag edges. The gap's length is in its hover text ("4h 10m idle"), never a
    /// rotated label that the band's width would cut (M-15).
    static func breaks(_ ctx: CGContext, scale: TimeScale, from: Double, to: Double, x0: CGFloat, y0: CGFloat, y1: CGFloat) {
        let bw = CGFloat(scale.breakWidth)
        for (_, gx) in scale.breaks(from: from, to: to) {
            let x = x0 + CGFloat(gx)
            ctx.setFillColor(NSColor.underPageBackgroundColor.cgColor)
            ctx.fill(CGRect(x: x, y: y0, width: bw, height: y1 - y0))
            ctx.setStrokeColor(NSColor.separatorColor.cgColor)
            ctx.setLineWidth(1)
            for ex in [x + 3.5, x + bw - 3.5] {
                ctx.move(to: CGPoint(x: ex, y: y0))
                var yy = y0, k = 0
                while yy < y1 {
                    ctx.addLine(to: CGPoint(x: ex + (k % 2 == 0 ? -2 : 2), y: yy + 4))
                    yy += 4
                    k += 1
                }
            }
            ctx.strokePath()
        }
    }

    /// A dashed join across each collapsed gap a bar or band crosses, so a long bar never reads as ending at the gap.
    static func gapJoins(_ ctx: CGContext, _ joins: [(rect: CGRect, color: NSColor)], scale: TimeScale, from: Double, to: Double, x0: CGFloat) {
        let bw = CGFloat(scale.breakWidth)
        let gaps = scale.breaks(from: from, to: to).map { x0 + CGFloat($0.x) }
        guard !gaps.isEmpty, !joins.isEmpty else { return }
        ctx.saveGState()
        ctx.setLineWidth(1.5)
        ctx.setLineDash(phase: 0, lengths: [3, 2])
        for (r, color) in joins {
            for gx in gaps where r.minX < gx && r.maxX > gx + bw {
                ctx.setStrokeColor(color.cgColor)
                ctx.move(to: CGPoint(x: gx, y: r.midY))
                ctx.addLine(to: CGPoint(x: gx + bw, y: r.midY))
                ctx.strokePath()
            }
        }
        ctx.restoreGState()
    }

    // MARK: Density

    /// Event-count bars (square-root scaled) with errors overlaid in red.
    static func density(_ ctx: CGContext, scale: TimeScale, parts: [Histogram], x0: CGFloat, top: CGFloat, height: CGFloat, fill: NSColor,
                        clipWidth: CGFloat) {
        var maxCount = 0
        for p in parts { for b in p.bins { maxCount = max(maxCount, b.count) } }
        guard maxCount > 0 else { return }
        let limit = x0 + clipWidth
        for (color, value) in [(fill, \Histogram.Bin.count), (Theme.err, \Histogram.Bin.errors)] as [(NSColor, KeyPath<Histogram.Bin, Int>)] {
            var rects: [CGRect] = []
            for p in parts {
                for (i, b) in p.bins.enumerated() {
                    let v = b[keyPath: value]
                    guard v > 0 else { continue }
                    let xa = x0 + CGFloat(scale.x(Double(p.from) + Double(i) * Double(p.binUs)))
                    let xb = x0 + CGFloat(scale.x(Double(p.from) + Double(i + 1) * Double(p.binUs)))
                    guard xb >= x0, xa <= limit else { continue }
                    let bh = max(1, (Double(v) / Double(maxCount)).squareRoot() * Double(height))
                    rects.append(CGRect(x: xa, y: top + height - CGFloat(bh), width: max(1, xb - xa - 0.5), height: CGFloat(bh)))
                }
            }
            ctx.setFillColor(color.cgColor)
            ctx.fill(rects)
        }
    }

    // MARK: Overlays

    /// The selected event: a vertical line in the accent color with a small cap.
    static func marker(_ ctx: CGContext, x: CGFloat, y0: CGFloat, height: CGFloat, cap: Bool) {
        ctx.setFillColor(NSColor.controlAccentColor.cgColor)
        ctx.fill(CGRect(x: x - 0.75, y: y0, width: 1.5, height: height))
        guard cap else { return }
        ctx.move(to: CGPoint(x: x - 5, y: y0))
        ctx.addLine(to: CGPoint(x: x + 5, y: y0))
        ctx.addLine(to: CGPoint(x: x, y: y0 + 6))
        ctx.closePath()
        ctx.fillPath()
    }

    /// An inspection range (or a range being dragged): tinted band with edges.
    static func range(_ ctx: CGContext, xa: CGFloat, xb: CGFloat, y0: CGFloat, height: CGFloat) {
        let x = min(xa, xb), w = max(1, abs(xb - xa))
        ctx.setFillColor(NSColor.controlAccentColor.withAlphaComponent(0.14).cgColor)
        ctx.fill(CGRect(x: x, y: y0, width: w, height: height))
        ctx.setFillColor(NSColor.controlAccentColor.cgColor)
        ctx.fill(CGRect(x: x, y: y0, width: 1, height: height))
        ctx.fill(CGRect(x: x + w - 1, y: y0, width: 1, height: height))
    }

    /// Dims the time outside the scope's time range and marks its ends.
    static func dimOutside(_ ctx: CGContext, scale: TimeScale, from: Int64?, to: Int64?, x0: CGFloat, y0: CGFloat, width: CGFloat, height: CGFloat) {
        guard from != nil || to != nil else { return }
        let a = from.map { x0 + CGFloat(scale.x(Double($0))) } ?? x0 - 1
        let b = to.map { x0 + CGFloat(scale.x(Double($0))) } ?? x0 + width + 1
        ctx.setFillColor(NSColor.windowBackgroundColor.withAlphaComponent(0.6).cgColor)
        if a > x0 { ctx.fill(CGRect(x: x0, y: y0, width: min(a, x0 + width) - x0, height: height)) }
        if b < x0 + width { ctx.fill(CGRect(x: max(b, x0), y: y0, width: x0 + width - max(b, x0), height: height)) }
        ctx.setFillColor(NSColor.secondaryLabelColor.cgColor)
        if from != nil, a >= x0 { ctx.fill(CGRect(x: a - 0.5, y: y0, width: 1, height: height)) }
        if to != nil, b <= x0 + width { ctx.fill(CGRect(x: b - 0.5, y: y0, width: 1, height: height)) }
    }
}

// MARK: - Hover HUD

/// The tooltip-style HUD shown while hovering a span, session, gap or histogram bin. It never takes clicks.
final class TimelineHUD: NSView {
    private let effect = NSVisualEffectView()
    private let label = PlainLabel(labelWithString: "")

    /// Drawn without vibrancy, so the HUD's text keeps its exact colors over the material.
    private final class PlainLabel: NSTextField {
        override var allowsVibrancy: Bool { false }
    }
    static let maxWidth: CGFloat = 340

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        shadow = {
            let s = NSShadow()
            s.shadowBlurRadius = 8
            s.shadowOffset = NSSize(width: 0, height: -2)
            s.shadowColor = NSColor.black.withAlphaComponent(0.25)
            return s
        }()
        effect.material = .toolTip
        effect.blendingMode = .withinWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 6
        effect.layer?.masksToBounds = true
        effect.layer?.borderWidth = 0.5
        addSubview(effect)
        label.maximumNumberOfLines = 0
        label.lineBreakMode = .byWordWrapping
        label.isSelectable = false
        effect.addSubview(label)
        isHidden = true
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateBorder()
    }

    private func updateBorder() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            effect.layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }

    /// Show `content` near `point` (in the superview's coordinates), kept inside `bounds`.
    func show(_ content: NSAttributedString, near point: NSPoint, in area: NSRect) {
        label.attributedStringValue = content
        let size = content.boundingRect(with: NSSize(width: Self.maxWidth - 16, height: 1000), options: [.usesLineFragmentOrigin]).size
        let w = ceil(size.width) + 24, h = ceil(size.height) + 12
        let flipped = superview?.isFlipped ?? true
        var x = point.x + 14
        if x + w > area.maxX - 4 { x = point.x - w - 14 }
        x = max(area.minX + 4, x)
        var y: CGFloat
        if flipped {
            y = point.y + 16
            if y + h > area.maxY - 4 { y = point.y - h - 10 }
            y = max(area.minY + 4, y)
        } else {
            y = point.y - 16 - h
            if y < area.minY + 4 { y = point.y + 10 }
            y = min(area.maxY - h - 4, y)
        }
        frame = NSRect(x: x, y: y, width: w, height: h)
        effect.frame = bounds
        label.frame = NSRect(x: 9, y: 6, width: w - 16, height: h - 12)
        updateBorder()
        isHidden = false
    }

    func hide() { isHidden = true }

    /// A bold title and aligned key–value rows.
    static func content(title: String, rows: [(String, String)], titleColor: NSColor = .labelColor) -> NSAttributedString {
        let out = NSMutableAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: titleColor,
        ])
        let keyWidth = rows.map { TimelineDrawing.width($0.0, font: .systemFont(ofSize: 11)) }.max() ?? 0
        let p = NSMutableParagraphStyle()
        p.tabStops = [NSTextTab(textAlignment: .left, location: keyWidth + 10)]
        p.headIndent = keyWidth + 10
        p.paragraphSpacingBefore = 2
        for (k, v) in rows where !v.isEmpty {
            out.append(NSAttributedString(string: "\n\(k)\t", attributes: [
                .font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: p,
            ]))
            out.append(NSAttributedString(string: v, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor.labelColor, .paragraphStyle: p,
            ]))
        }
        return out
    }
}

// MARK: - Accessibility

/// An accessibility element for something drawn in a custom view (a track, a span, a row) that VoiceOver can press.
final class TimelineAXElement: NSAccessibilityElement {
    var press: (() -> Void)?

    /// `rect` is in `view`'s coordinates; the element's frame is its screen rectangle at creation.
    static func make(role: NSAccessibility.Role, label: String, rect: NSRect, in view: NSView, parent: Any, help: String? = nil,
                     press: (() -> Void)? = nil) -> TimelineAXElement {
        let e = TimelineAXElement()
        e.setAccessibilityRole(role)
        e.setAccessibilityLabel(label)
        if let window = view.window { e.setAccessibilityFrame(window.convertToScreen(view.convert(rect, to: nil))) }
        e.setAccessibilityParent(parent)
        e.setAccessibilityHelp(help)
        e.press = press
        return e
    }

    override func accessibilityPerformPress() -> Bool {
        guard let press else { return false }
        press()
        return true
    }
}
