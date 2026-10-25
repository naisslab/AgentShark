import CoreGraphics

/// Column widths and priorities of DESIGN.md §4.4. Tables never scroll sideways in a default layout: when the columns
/// do not fit, or the primary columns would fall below 45% of the width, columns hide in priority order (P4 first,
/// then P3; within a priority, the rightmost first), and the table says how many it hid.
enum ColumnFit {
    struct Spec: Equatable, Sendable {
        let id: String
        let min: CGFloat
        let max: CGFloat
        /// 1 never hides; 3 and 4 hide under pressure.
        let priority: Int
        /// The primary columns (Summary; Intent and Calls) keep at least 45% and take the remaining width.
        var primary = false
        /// Share of the primary width when there are several primary columns.
        var weight: CGFloat = 1
    }

    struct Result: Equatable {
        var hidden: [String]
        var widths: [String: CGFloat]
    }

    static let primaryShare: CGFloat = 0.45

    /// Fit `columns` (in display order, already without the ones the person hid) into `width`.
    static func fit(_ columns: [Spec], width: CGFloat, spacing: CGFloat) -> Result {
        var shown = columns
        var hidden: [String] = []
        func others() -> CGFloat { shown.filter { !$0.primary }.reduce(0) { $0 + $1.min } + spacing * CGFloat(shown.count) }
        func primaryMin() -> CGFloat { shown.filter(\.primary).reduce(0) { $0 + $1.min } }
        func fits() -> Bool {
            let room = width - others()
            return room >= primaryMin() && room >= width * primaryShare
        }
        func hide(_ priorities: [Int], while condition: () -> Bool) {
            while condition() {
                guard let victim = priorities.lazy.compactMap({ p in shown.lastIndex { $0.priority == p } }).first else { return }
                hidden.append(shown[victim].id)
                shown.remove(at: victim)
            }
        }
        hide([4, 3], while: { !fits() })
        // A pane narrower than a default layout (an inspector beside the table): the P2 columns go too before any
        // column would leave the visible width.
        hide([2], while: { width - others() < primaryMin() })
        let order = Dictionary(uniqueKeysWithValues: columns.enumerated().map { ($1.id, $0) })
        hidden.sort { order[$0, default: 0] < order[$1, default: 0] }
        // The others start at their minimum; once the primary columns reach their maximum, the others grow toward
        // theirs, and anything left goes back to the primary columns.
        var widths: [String: CGFloat] = [:]
        for c in shown where !c.primary { widths[c.id] = c.min }
        let primary = shown.filter(\.primary)
        // Below their minimum the primary columns shrink rather than push a column off the edge.
        var room = width - others()
        let primaryMax = primary.reduce(0) { $0 + $1.max }
        if room > primaryMax {
            var extra = room - primaryMax
            for c in shown where !c.primary && extra > 0 {
                let grow = Swift.min(extra, c.max - c.min)
                widths[c.id] = c.min + grow
                extra -= grow
            }
            room = primaryMax + extra
        }
        let totalWeight = primary.reduce(0) { $0 + $1.weight }
        var assigned: CGFloat = 0
        for (i, c) in primary.enumerated() {
            let w = i == primary.count - 1 ? room - assigned : (room * c.weight / Swift.max(1, totalWeight)).rounded(.down)
            widths[c.id] = Swift.max(24, w)
            assigned += widths[c.id]!
        }
        return Result(hidden: hidden, widths: widths)
    }

    /// "2 columns hidden".
    static func hiddenText(_ n: Int) -> String { n == 1 ? "1 column hidden" : "\(n) columns hidden" }
}
