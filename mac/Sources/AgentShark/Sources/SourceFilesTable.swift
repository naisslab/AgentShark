import SwiftUI

extension SourceRow {
    /// `OK`, `Deleted`, or the engine's status for a file that failed.
    var statusLabel: String {
        if !existsNow { return "Deleted" }
        if status != "ok" || error != nil { return status == "ok" ? "Error" : status.capitalized }
        return "OK"
    }

    var hasProblem: Bool { malformed > 0 || unknown > 0 || status != "ok" || !existsNow || error != nil }

    /// `indexedAt` in µs; the engine has used seconds and milliseconds too.
    var indexedAtUs: Int64? {
        guard let t = indexedAt, t > 0 else { return nil }
        if t > 100_000_000_000_000 { return t }
        if t > 100_000_000_000 { return t * 1000 }
        return t * 1_000_000
    }

    var indexedKey: Int64 { indexedAtUs ?? -1 }
    var agentLabel: String { PanelKit.agentLabel(agent) }
}

/// Every source file the index knows, sortable and filterable (Sources workspace, lower pane).
struct SourceFilesTable: View {
    let sources: [SourceRow]
    @State private var query = ""
    @State private var problemsOnly = false
    @State private var selection: Set<SourceRow.ID> = []
    @State private var sortOrder = [KeyPathComparator(\SourceRow.path)]
    @State private var customization = TableColumnCustomization<SourceRow>()
    /// Columns hidden because they do not fit (§4.4), and the ones the person asked back from the "n columns hidden" menu.
    @State private var autoHidden: [String] = []
    @State private var forced: Set<String> = []
    @State private var width: CGFloat = 0

    /// §4.4 for this table: Path is primary and keeps 45%; Indexed hides first, then Unknown, Malformed, Lines and Kind.
    private static let specs: [ColumnFit.Spec] = [
        .init(id: "path", min: 200, max: 100_000, priority: 1, primary: true),
        .init(id: "agent", min: 96, max: 120, priority: 2),
        .init(id: "kind", min: 110, max: 140, priority: 3),
        .init(id: "status", min: 64, max: 84, priority: 1),
        .init(id: "size", min: 68, max: 80, priority: 2),
        .init(id: "lines", min: 60, max: 72, priority: 3),
        .init(id: "malformed", min: 82, max: 90, priority: 3),
        .init(id: "unknown", min: 74, max: 84, priority: 3),
        .init(id: "indexed", min: 124, max: 140, priority: 4),
    ]
    private static let titles = ["path": "Path", "agent": "Agent", "kind": "Kind", "status": "Status", "size": "Size", "lines": "Lines",
                                 "malformed": "Malformed", "unknown": "Unknown", "indexed": "Indexed"]

    private func spec(_ id: String) -> ColumnFit.Spec { Self.specs.first { $0.id == id }! }

    /// Hide what does not fit at `width` (the table's width less its scroller).
    private func refit(_ w: CGFloat) {
        width = w
        let specs = Self.specs.map { forced.contains($0.id) ? ColumnFit.Spec(id: $0.id, min: $0.min, max: $0.max, priority: 1, primary: $0.primary) : $0 }
        let hidden = ColumnFit.fit(specs, width: w - 16, spacing: 12).hidden
        autoHidden = hidden
        for c in Self.specs { customization[visibility: c.id] = hidden.contains(c.id) ? .hidden : .visible }
    }

    private var rows: [SourceRow] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return sources.filter { s in
            (!problemsOnly || s.hasProblem)
                && (q.isEmpty || [s.path, s.agent, s.agentLabel, s.kind, s.dialect ?? "", s.statusLabel].contains { $0.lowercased().contains(q) })
        }
        .sorted(using: sortOrder)
    }

    var body: some View {
        let shown = rows
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("Source Files").font(.headline)
                Text(shown.count == sources.count ? Formatters.count(sources.count, "file")
                                                  : "\(Formatters.count(shown.count)) of \(Formatters.count(sources.count, "file"))")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Spacer()
                Toggle("Problems only", isOn: $problemsOnly)
                    .toggleStyle(.checkbox)
                    .help("Only files that are deleted, failed, or have malformed or unknown records")
                if !autoHidden.isEmpty {
                    Menu(ColumnFit.hiddenText(autoHidden.count)) {
                        ForEach(autoHidden, id: \.self) { id in
                            Button("Show " + (Self.titles[id] ?? id)) {
                                forced.insert(id)
                                refit(width)
                            }
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Columns that do not fit beside Path; showing one hides another")
                }
                PanelKit.SearchField(text: $query, prompt: "Filter by Path, Agent, Kind or Status", onEscape: { query = "" })
                    .frame(width: 260)
            }
            .controlSize(.small)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            Divider()
            if shown.isEmpty {
                ContentUnavailableView(sources.isEmpty ? "No source files" : "No matching files", systemImage: "doc.text.magnifyingglass",
                                       description: Text(sources.isEmpty ? "The index has no source files yet." : "Change the filter or turn off Problems only."))
            } else {
                table(shown)
            }
        }
    }

    private func table(_ rows: [SourceRow]) -> some View {
        Table(rows, selection: $selection, sortOrder: $sortOrder, columnCustomization: $customization) {
            fileColumns
            countColumns
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { refit($0) }
        .contextMenu(forSelectionType: SourceRow.ID.self) { ids in
            let paths = rows.filter { ids.contains($0.id) }.map(\.path)
            if paths.count == 1 {
                Button("Reveal in Finder") { AppKitHelpers.revealInFinder(paths[0]) }
            }
            if !paths.isEmpty {
                Button(paths.count == 1 ? "Copy Path" : "Copy Paths") { AppKitHelpers.copy(paths.joined(separator: "\n")) }
            }
        } primaryAction: { ids in
            if let s = rows.first(where: { ids.contains($0.id) }) { AppKitHelpers.revealInFinder(s.path) }
        }
    }

    @TableColumnBuilder<SourceRow, KeyPathComparator<SourceRow>>
    private var fileColumns: some TableColumnContent<SourceRow, KeyPathComparator<SourceRow>> {
        TableColumn("Path", value: \SourceRow.path) { (s: SourceRow) in
            Text(s.path)
                .font(Theme.fontSwiftUI(.code))
                .lineLimit(1)
                .truncationMode(.head)
                .foregroundStyle(s.existsNow ? .primary : .secondary)
                .help(s.path)
        }
        .width(min: spec("path").min)
        .customizationID("path")
        TableColumn("Agent", value: \SourceRow.agentLabel) { (s: SourceRow) in Text(s.agentLabel).lineLimit(1) }
            .width(min: spec("agent").min, ideal: spec("agent").min, max: spec("agent").max)
            .customizationID("agent")
        TableColumn("Kind", value: \SourceRow.kind) { (s: SourceRow) in
            Text(s.kind).lineLimit(1).foregroundStyle(.secondary).help(s.dialect.map { "Dialect: \($0)" } ?? s.kind)
        }
        .width(min: spec("kind").min, ideal: spec("kind").min, max: spec("kind").max)
        .customizationID("kind")
        TableColumn("Status", value: \SourceRow.statusLabel) { (s: SourceRow) in
            PanelKit.Chip(text: s.statusLabel,
                          symbol: s.statusLabel == "OK" ? "checkmark" : "exclamationmark.triangle",
                          color: s.statusLabel == "OK" ? Theme.ok.swiftUI : s.existsNow ? Theme.err.swiftUI : Theme.warn.swiftUI)
                .help(s.error ?? (s.existsNow ? "Indexed" : "The file is gone from disk; its indexed records are kept"))
        }
        .width(min: spec("status").min, ideal: spec("status").min, max: spec("status").max)
        .customizationID("status")
    }

    @TableColumnBuilder<SourceRow, KeyPathComparator<SourceRow>>
    private var countColumns: some TableColumnContent<SourceRow, KeyPathComparator<SourceRow>> {
        TableColumn("Size", value: \SourceRow.size) { (s: SourceRow) in
            Text(Formatters.bytes(s.size))
                .font(Theme.dataFontSwiftUI(size: 12))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .help(Formatters.count(Int(s.size)) + " bytes")
        }
        .width(min: spec("size").min, ideal: spec("size").min, max: spec("size").max)
        .customizationID("size")
        numberColumn("Lines", "lines", \.lines, warn: false)
        numberColumn("Malformed", "malformed", \.malformed, warn: true)
        numberColumn("Unknown", "unknown", \.unknown, warn: true)
        TableColumn("Indexed", value: \SourceRow.indexedKey) { (s: SourceRow) in
            Text(s.indexedAtUs.map { Formatters.shortDateTime($0) } ?? Formatters.missing)
                .font(Theme.dataFontSwiftUI(size: 12))
                .foregroundStyle(.secondary)
                .help(s.indexedAtUs.map { Formatters.timestamp($0) + (s.parseMs.map { String(format: " · parsed in %.0f ms", $0) } ?? "") }
                    ?? "Not indexed yet")
        }
        .width(min: spec("indexed").min, ideal: spec("indexed").min, max: spec("indexed").max)
        .customizationID("indexed")
    }

    private func numberColumn(_ title: String, _ id: String, _ key: KeyPath<SourceRow, Int>, warn: Bool)
        -> some TableColumnContent<SourceRow, KeyPathComparator<SourceRow>> {
        TableColumn(title, value: key) { (s: SourceRow) in
            let n = s[keyPath: key]
            Text(Formatters.count(n))
                .font(Theme.dataFontSwiftUI(size: 12))
                .foregroundStyle(warn && n > 0 ? Theme.warn.swiftUI : .primary)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .width(min: spec(id).min, ideal: spec(id).min, max: spec(id).max)
        .customizationID(id)
    }
}
