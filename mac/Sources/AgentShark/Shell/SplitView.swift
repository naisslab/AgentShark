import AppKit
import SwiftUI

/// One pane of an `AutosaveSplitView`.
struct SplitPane {
    let id: String
    /// Smallest thickness while expanded, in points.
    var minimum: CGFloat
    /// Largest thickness, or nil for none.
    var maximum: CGFloat?
    /// A larger minimum that holds while the other panes keep their `roomy` thickness (their minimum when nil).
    var preferredMinimum: CGFloat?
    /// The thickness this pane keeps before another pane's `preferredMinimum` takes space from it.
    var roomy: CGFloat?
    /// Thickness on first launch, before the person has moved a divider. Nil shares the rest.
    var initial: CGFloat?
    /// Panes with a higher priority keep their size when the window resizes.
    var holdingPriority: NSLayoutConstraint.Priority = .defaultLow
    var isCollapsed = false
    var accessibilityLabel: String
    let content: AnyView

    init<V: View>(id: String, minimum: CGFloat, maximum: CGFloat? = nil, preferredMinimum: CGFloat? = nil, roomy: CGFloat? = nil, initial: CGFloat? = nil,
                  holdingPriority: NSLayoutConstraint.Priority = .defaultLow, isCollapsed: Bool = false, accessibilityLabel: String,
                  @ViewBuilder content: () -> V) {
        self.id = id
        self.minimum = minimum
        self.maximum = maximum
        self.preferredMinimum = preferredMinimum
        self.roomy = roomy
        self.initial = initial
        self.holdingPriority = holdingPriority
        self.isCollapsed = isCollapsed
        self.accessibilityLabel = accessibilityLabel
        self.content = AnyView(content())
    }
}

/// An `NSSplitView` (through `NSSplitViewController`) hosting SwiftUI panes, with divider positions saved under
/// `autosaveName`. `vertical` puts the panes side by side.
struct AutosaveSplitView: NSViewControllerRepresentable {
    let autosaveName: String
    let vertical: Bool
    let panes: [SplitPane]

    func makeNSViewController(context: Context) -> Controller {
        Controller(autosaveName: autosaveName, vertical: vertical, panes: panes)
    }

    func updateNSViewController(_ controller: Controller, context: Context) {
        controller.update(panes)
    }

    /// Take whatever space is offered. Measuring the split view through Auto Layout would report its current
    /// pane sizes (held at the panes' holding priorities) as its minimum, which changes with every resize and
    /// sends the window's column layout into a loop.
    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: Controller, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 600, height: proposal.height ?? 400)
    }

    @MainActor final class Controller: NSSplitViewController {
        private var hosts: [NSHostingController<AnyView>] = []
        private let autosaveName: String
        private var initialSizes: [CGFloat?] = []
        private var appliedInitialSizes = false
        private var panes: [SplitPane] = []

        init(autosaveName: String, vertical: Bool, panes: [SplitPane]) {
            self.autosaveName = autosaveName
            super.init(nibName: nil, bundle: nil)
            splitView.isVertical = vertical
            splitView.dividerStyle = .thin
            for pane in panes {
                let host = NSHostingController(rootView: pane.content)
                host.sizingOptions = []
                host.view.setAccessibilityLabel(pane.accessibilityLabel)
                let item = NSSplitViewItem(viewController: host)
                item.minimumThickness = pane.minimum
                if let maximum = pane.maximum { item.maximumThickness = maximum }
                item.holdingPriority = pane.holdingPriority
                item.canCollapse = true
                item.isCollapsed = pane.isCollapsed
                addSplitViewItem(item)
                hosts.append(host)
                initialSizes.append(pane.initial)
            }
            self.panes = panes
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func viewDidLoad() {
            super.viewDidLoad()
            splitView.autosaveName = autosaveName
        }

        override func viewDidLayout() {
            super.viewDidLayout()
            applyInitialSizesOnce()
            applyPreferredMinimums()
        }

        /// A pane with a `preferredMinimum` gets as much of it as the other expanded panes leave at their `roomy`
        /// thickness, and never less than its `minimum`.
        private func applyPreferredMinimums() {
            let total = splitView.isVertical ? splitView.bounds.width : splitView.bounds.height
            guard total > 0 else { return }
            let open = splitViewItems.indices.filter { !splitViewItems[$0].isCollapsed && $0 < panes.count }
            for i in open {
                guard let preferred = panes[i].preferredMinimum else { continue }
                let others = open.filter { $0 != i }.reduce(CGFloat(0)) { $0 + (panes[$1].roomy ?? panes[$1].minimum) }
                let room = total - others - splitView.dividerThickness * CGFloat(max(0, open.count - 1))
                let minimum = max(panes[i].minimum, min(preferred, room.rounded(.down)))
                if splitViewItems[i].minimumThickness != minimum { splitViewItems[i].minimumThickness = minimum }
            }
        }

        /// Divider positions from `SplitPane.initial` when nothing was saved yet.
        private func applyInitialSizesOnce() {
            guard !appliedInitialSizes else { return }
            let total = splitView.isVertical ? splitView.bounds.width : splitView.bounds.height
            // Wait for a real size: the first layouts of a new window are smaller than its panes' minimums.
            let minimums = splitViewItems.filter { !$0.isCollapsed }.reduce(CGFloat(0)) { $0 + $1.minimumThickness }
            guard total > 0, splitView.window != nil, total >= minimums + 100 else { return }
            appliedInitialSizes = true
            guard UserDefaults.standard.object(forKey: "NSSplitView Subview Frames \(autosaveName)") == nil else { return }
            let n = initialSizes.count
            guard n >= 2 else { return }
            // Leading panes with a size, in order; then a trailing pane with a size, measured from the far edge.
            var position: CGFloat = 0
            for i in 0..<(n - 1) {
                guard let size = initialSizes[i], !splitViewItems[i].isCollapsed else { break }
                position += size
                splitView.setPosition(position, ofDividerAt: i)
                position += splitView.dividerThickness
            }
            if let last = initialSizes[n - 1], !splitViewItems[n - 1].isCollapsed {
                splitView.setPosition(total - last - splitView.dividerThickness, ofDividerAt: n - 2)
            }
        }

        func update(_ panes: [SplitPane]) {
            self.panes = panes
            for (i, pane) in panes.enumerated() where i < hosts.count {
                hosts[i].rootView = pane.content
                let item = splitViewItems[i]
                if item.isCollapsed != pane.isCollapsed {
                    // Collapse on the next turn: the animation commits a window layout, which must not run inside the
                    // SwiftUI update that called this (it re-enters the panes' view graphs).
                    let collapse = pane.isCollapsed
                    DispatchQueue.main.async {
                        guard item.isCollapsed != collapse else { return }
                        NSAnimationContext.runAnimationGroup { ctx in
                            ctx.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.2
                            ctx.allowsImplicitAnimation = true
                            item.animator().isCollapsed = collapse
                        }
                    }
                }
            }
        }
    }
}
