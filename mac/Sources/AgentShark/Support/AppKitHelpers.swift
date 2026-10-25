import AppKit
import SwiftUI

/// Small AppKit conveniences shared by the workspaces.
enum AppKitHelpers {
    /// Put plain text on the general pasteboard.
    static func copy(_ string: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(string, forType: .string)
    }

    /// Reveal a file in Finder (selecting it), or its nearest existing parent folder.
    static func revealInFinder(_ path: String) {
        var url = URL(fileURLWithPath: path)
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
            return
        }
        while url.pathComponents.count > 1 {
            url.deleteLastPathComponent()
            if fm.fileExists(atPath: url.path) {
                NSWorkspace.shared.open(url)
                return
            }
        }
    }

    /// The first responder of the key window when it is a text view (a field editor or a text view), else nil.
    @MainActor static var editingTextView: NSTextView? {
        NSApp.keyWindow?.firstResponder as? NSTextView
    }

    /// Activate the app and bring the Settings window forward once SwiftUI has opened it (it otherwise opens behind
    /// the frontmost app when AgentShark was not active).
    @MainActor static func bringSettingsToFront() {
        NSApp.activate()
        DispatchQueue.main.async {
            let settings = NSApp.windows.first { ($0.identifier?.rawValue ?? "").localizedCaseInsensitiveContains("settings") }
            settings?.orderFrontRegardless()
            settings?.makeKey()
        }
    }

    /// Send an action up the responder chain; returns whether something handled it.
    @MainActor @discardableResult
    static func sendAction(_ selector: Selector, tag: Int? = nil) -> Bool {
        if let tag {
            let item = NSMenuItem()
            item.tag = tag
            return NSApp.sendAction(selector, to: nil, from: item)
        }
        return NSApp.sendAction(selector, to: nil, from: nil)
    }
}

/// Responder-chain actions the menus send before falling back to the window model.
/// AppKit views that own a selection (the event table, the detail outline) implement them.
@objc protocol AgentSharkResponderActions {
    /// ⌥⌘C: copy the selection as JSON.
    @objc optional func copyAsJSON(_ sender: Any?)
}

/// A base for `NSViewRepresentable` wrappers whose AppKit view keeps its own state (scroll position, column
/// layout) across SwiftUI updates: the view is made once and `update` receives the latest SwiftUI value.
struct HostedNSView<V: NSView>: NSViewRepresentable {
    let make: () -> V
    var update: (V) -> Void = { _ in }

    func makeNSView(context: Context) -> V { make() }
    func updateNSView(_ nsView: V, context: Context) { update(nsView) }
}

/// Calls `onClose` once when the hosting window closes (tab switches and hiding do not count).
struct WindowCloseObserver: NSViewRepresentable {
    let onClose: () -> Void

    final class Coordinator {
        var token: NSObjectProtocol?
        var window: NSWindow?
        var onClose: () -> Void = {}
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { [weak view] in
            guard let window = view?.window, context.coordinator.window == nil else { return }
            let c = context.coordinator
            c.window = window
            c.onClose = onClose
            c.token = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { _ in
                c.onClose()
                if let t = c.token { NotificationCenter.default.removeObserver(t) }
                c.token = nil
            }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

extension View {
    /// `.help(text)` plus a matching VoiceOver label, for icon-only controls.
    func iconHelp(_ text: String) -> some View {
        help(text).accessibilityLabel(text)
    }
}

extension View {
    /// Top and bottom scroll shadows (§7.9): a fade at each edge that has content beyond it, so a row cut by the edge
    /// never reads as the last one. Apply to a `ScrollView`.
    func scrollShadows() -> some View { modifier(ScrollShadows()) }
}

private struct ScrollShadows: ViewModifier {
    private struct Edges: Equatable {
        var top = false
        var bottom = false
    }

    @State private var edges = Edges()

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: Edges.self) { g in
                Edges(top: g.visibleRect.minY > 1, bottom: g.visibleRect.maxY < g.contentSize.height - 1)
            } action: { _, new in
                edges = new
            }
            .overlay(alignment: .top) { shadow(.top).opacity(edges.top ? 1 : 0) }
            .overlay(alignment: .bottom) { shadow(.bottom).opacity(edges.bottom ? 1 : 0) }
    }

    private func shadow(_ edge: VerticalEdge) -> some View {
        LinearGradient(colors: [Color(nsColor: .shadowColor).opacity(0.18), .clear], startPoint: edge == .top ? .top : .bottom,
                       endPoint: edge == .top ? .bottom : .top)
            .frame(height: 8)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// The AppKit counterpart of `scrollShadows()`: an `NSScrollView` that fades its top and bottom edges while content
/// lies beyond them (§7.9).
final class ShadowedScrollView: NSScrollView {
    /// A gradient that never takes a click.
    private final class Shade: NSView {
        init(top: Bool) {
            super.init(frame: .zero)
            let g = CAGradientLayer()
            g.colors = [NSColor.shadowColor.withAlphaComponent(0.18).cgColor, NSColor.clear.cgColor]
            g.startPoint = CGPoint(x: 0.5, y: top ? 1 : 0)
            g.endPoint = CGPoint(x: 0.5, y: top ? 0 : 1)
            layer = g
            wantsLayer = true
            isHidden = true
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func isAccessibilityElement() -> Bool { false }
    }

    private let top = Shade(top: true)
    private let bottom = Shade(top: false)

    override func tile() {
        super.tile()
        for v in [top, bottom] where v.superview !== self { addSubview(v, positioned: .above, relativeTo: nil) }
        let r = contentView.frame
        let inset = contentView.contentInsets.top
        top.frame = NSRect(x: r.minX, y: isFlipped ? r.minY + inset : r.maxY - inset - 8, width: r.width, height: 8)
        bottom.frame = NSRect(x: r.minX, y: isFlipped ? r.maxY - 8 : r.minY, width: r.width, height: 8)
        updateShadows()
    }

    override func reflectScrolledClipView(_ clipView: NSClipView) {
        super.reflectScrolledClipView(clipView)
        updateShadows()
    }

    private func updateShadows() {
        guard let doc = documentView else { return }
        let v = contentView.documentVisibleRect, b = doc.bounds
        top.isHidden = (doc.isFlipped ? v.minY - b.minY : b.maxY - v.maxY) <= 1
        bottom.isHidden = (doc.isFlipped ? b.maxY - v.maxY : v.minY - b.minY) <= 1
    }
}
