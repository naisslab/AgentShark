import AppKit
import SwiftUI

/// The marks of DESIGN.md §6.3. A mark is an SF Symbol, never a text glyph: Unicode glyphs vary in weight and
/// baseline across font fallbacks. Plain-text outputs (Copy Report, the CLI) keep the notation characters.
enum Mark: String, CaseIterable, Sendable {
    case failed, blocked, interrupted, masked, degraded, slow, recovered, clean, silentChild, loop, alarm, regressed, claim, live, dataGap

    var symbol: String {
        switch self {
        case .failed: return "xmark.circle.fill"
        case .blocked: return "hand.raised.fill"
        case .interrupted: return "pause.circle.fill"
        case .masked: return "circle.lefthalf.filled"
        case .degraded: return "exclamationmark.triangle.fill"
        case .slow: return "clock.fill"
        case .recovered: return "arrow.counterclockwise.circle.fill"
        case .clean: return "checkmark.circle.fill"
        case .silentChild: return "arrow.down.to.line.circle.fill"
        case .loop: return "arrow.triangle.2.circlepath.circle.fill"
        case .alarm: return "bell.fill"
        case .regressed: return "arrowtriangle.up.fill"
        case .claim: return "questionmark.circle.fill"
        case .live: return "circle.fill"
        case .dataGap: return "info.circle"
        }
    }

    /// The outlined form: a delegation outcome from a `parsed:*`, `derived:*` or `inferred:*` source.
    var outlinedSymbol: String { symbol.hasSuffix(".fill") ? String(symbol.dropLast(5)) : symbol }

    /// The accessible name of a mark that stands alone.
    var accessibleName: String {
        switch self {
        case .silentChild: return "silent child"
        case .loop: return "loop"
        case .alarm: return "alarm firing"
        case .claim: return "unverified claim"
        case .dataGap: return "data gap"
        default: return rawValue
        }
    }

    /// The mark of a turn or session impact.
    static func impact(_ i: TurnImpact) -> Mark {
        switch i {
        case .failed: return .failed
        case .blocked: return .blocked
        case .interrupted: return .interrupted
        case .masked: return .masked
        case .degraded: return .degraded
        case .slow: return .slow
        case .recovered: return .recovered
        default: return .clean
        }
    }

    /// The uncircled form, for a mark drawn on a Solid fill (§6.2 call tokens), where a circled glyph's knock-out would
    /// show the fill and read as a dot.
    var bareSymbol: String {
        switch self {
        case .failed: return "xmark"
        case .loop: return "arrow.triangle.2.circlepath"
        case .recovered: return "arrow.counterclockwise"
        case .clean: return "checkmark"
        case .claim: return "questionmark"
        default: return symbol
        }
    }

    /// A symbol image sized and weighted like the text it precedes, in `color`. The symbol stays monochrome, so the
    /// glyph inside a filled circle stays knocked out (a palette color would paint every layer and leave a solid disc).
    func image(size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor? = nil, outlined: Bool = false, bare: Bool = false) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: size, weight: weight, scale: .small)
        let name = bare ? bareSymbol : outlined ? outlinedSymbol : symbol
        guard let base = NSImage(systemSymbolName: name, accessibilityDescription: accessibleName)?.withSymbolConfiguration(config) else { return nil }
        guard let color else { base.isTemplate = true; return base }
        return Self.tint(base, color)
    }

    /// `template` filled with `color` where it is opaque. Drawn lazily, so a dynamic color follows the appearance.
    static func tint(_ template: NSImage, _ color: NSColor) -> NSImage {
        let image = NSImage(size: template.size, flipped: false) { rect in
            template.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        image.accessibilityDescription = template.accessibilityDescription
        return image
    }
}

// MARK: - SwiftUI

/// A Plain mark (§6.1): the mark and its word in the impact color, no border and no fill. The mark beside its word is
/// hidden from VoiceOver; the word carries the meaning.
struct PlainMark: View {
    let mark: Mark?
    let text: String
    var color: NSColor = .secondaryLabelColor
    var outlined = false
    var help: String?

    var body: some View {
        HStack(spacing: 3) {
            if let mark {
                Image(systemName: outlined ? mark.outlinedSymbol : mark.symbol)
                    .imageScale(.small)
                    .accessibilityHidden(true)
            }
            Text(text).lineLimit(1)
        }
        .foregroundStyle(color.swiftUI)
        .help(help ?? "")
        .accessibilityElement(children: .combine)
    }
}

/// A Solid badge (§6.1): the object's own failure tier, once per header. Severity fill, dark text, 15 pt tall.
struct SolidBadge: View {
    let text: String
    var color: NSColor = Theme.err
    var help: String?

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Theme.solidBadgeText.swiftUI)
            .padding(.horizontal, 5)
            .frame(height: 15)
            .background(RoundedRectangle(cornerRadius: 3).fill(color.swiftUI))
            .help(help ?? "")
    }
}

/// An Outline badge (§6.1): a tier other than failure, bordered in its tier color, or a neutral removable token.
struct OutlineBadge: View {
    let text: String
    var color: NSColor = .tertiaryLabelColor
    var help: String?

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(color == .tertiaryLabelColor ? Color.secondary : color.swiftUI)
            .padding(.horizontal, 5)
            .frame(height: 15)
            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(color.swiftUI, lineWidth: 1))
            .help(help ?? "")
    }
}

/// The tier mark for a header or row: Solid for `failure` (headers only), Outline for the others (§6.1, §6.2).
struct TierBadge: View {
    let tier: FailureTier
    var help: String?

    var body: some View {
        if tier == .failure {
            SolidBadge(text: tier.rawValue, color: DerivedStyle.tierColor(tier), help: help)
        } else {
            OutlineBadge(text: tier.rawValue, color: DerivedStyle.tierColor(tier), help: help)
        }
    }
}

/// A section label (§3.1): 11/600 uppercase, secondary.
struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The agent mark (§5.2 item 4): an 8 pt dot in the agent's color before its short name; never a dot alone.
struct AgentName: View {
    let agent: AgentKind

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Theme.agentColor(agent).swiftUI).frame(width: 8, height: 8).accessibilityHidden(true)
            Text(agent.label).lineLimit(1)
        }
    }
}

// MARK: - AppKit

/// A badge drawn in AppKit views: Solid (the object's own failure tier, once per header), Outline (a tier other than
/// failure, bordered in its tier color) or the neutral system count capsule of the sidebar (§6.1, §7.18).
final class BadgeView: NSView {
    enum Style { case solid, outline, count }

    // Rows set these again on every refresh; an unchanged value does not draw the badge again.
    var style = Style.count { didSet { if style != oldValue { invalidateIntrinsicContentSize(); needsDisplay = true } } }
    var text = "" { didSet { if text != oldValue { invalidateIntrinsicContentSize(); needsDisplay = true } } }
    var tint: NSColor = .secondaryLabelColor { didSet { if tint != oldValue { needsDisplay = true } } }
    var isEmphasized = false { didSet { if isEmphasized != oldValue { needsDisplay = true } } }

    private var font: NSFont {
        switch style {
        case .count: return .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        case .solid: return .systemFont(ofSize: 11, weight: .semibold)
        case .outline: return .systemFont(ofSize: 11, weight: .medium)
        }
    }

    private var textColor: NSColor {
        switch style {
        case .solid: return Theme.solidBadgeText
        case .outline: return isEmphasized ? .alternateSelectedControlTextColor : tint
        case .count: return isEmphasized ? .alternateSelectedControlTextColor : .secondaryLabelColor
        }
    }

    override var intrinsicContentSize: NSSize {
        let w = ceil((text as NSString).size(withAttributes: [.font: font]).width)
        return NSSize(width: w + (style == .count ? 12 : 10), height: 15)
    }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        switch style {
        case .solid:
            tint.setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 3, yRadius: 3).fill()
        case .outline:
            (isEmphasized ? NSColor.alternateSelectedControlTextColor : tint).setStroke()
            let p = NSBezierPath(roundedRect: rect, xRadius: 3, yRadius: 3)
            p.lineWidth = 1
            p.stroke()
        case .count:
            (isEmphasized ? NSColor.white.withAlphaComponent(0.22) : NSColor.quaternaryLabelColor).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
        }
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: textColor]
        let size = (text as NSString).size(withAttributes: attrs)
        (text as NSString).draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attrs)
    }
}
