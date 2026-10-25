import AppKit
import SwiftUI

/// The bottom tables of Session · Critical Path (ANALYSIS-UX §4.9): a pane header with only the tabs Contributors,
/// Segments, Rework and Subagents (and the legend's class token, which narrows two of them), then the tab's table,
/// which fills the pane down to the selection bar (`PerfSelectionBar`, §4.10).
struct PerfTablesPane: View {
    @Bindable var model: WindowModel
    @Bindable var cp: CriticalPathModel
    let content: CriticalPathContent

    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            note
            switch cp.tab {
            case .contributors: ContributorsTable(cp: cp, content: content, metrics: metrics)
            case .segments: SegmentsTable(cp: cp, content: content)
            case .rework: ReworkTable(cp: cp, content: content)
            case .subagents: SubagentsTable(cp: cp, content: content)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity)
        .controlSize(metrics.swiftUIControlSize)
        .environment(\.defaultMinListRowHeight, metrics.tableRow)
    }

    // MARK: Pane header

    private var header: some View {
        HStack(spacing: 8) {
            Picker("Table", selection: $cp.tab) {
                ForEach(PerfTab.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            if let c = cp.classFilter, cp.tab == .contributors || cp.tab == .segments {
                ScopeToken(kind: "Class", value: PathMarkStyle.name(c), applies: true, help: "Only rows of this class; the legend sets it",
                           clearHelp: "Show every class") { cp.classFilter = nil }
            }
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 12)
        .frame(height: metrics.paneHeader)
        .background(.bar)
    }

    /// The tab's note under the header: what Rework measures, and how parallel the subagents ran.
    @ViewBuilder private var note: some View {
        switch cp.tab {
        case .rework: PerfPaneNote(text: "Repeated or reworked time, not waste.")
        case .subagents where !content.subagents.isEmpty: PerfPaneNote(text: content.parallelism)
        default: EmptyView()
        }
    }
}

/// Critical Path's selection bar (§4.10), the shared `SelectionBar` at the bottom of the pane: the selection in words
/// ("Model · 42.1s · Main", "sh:npm audit · 45s · audit:deps"), then Open Subagent when the selection is in a
/// subagent, Show in Events, Show in Session, Show in Timeline and Copy Event ID, as Compare's bar lists its own. Each
/// disabled one says why; narrow, they fold into one Actions menu.
struct PerfSelectionBar: View {
    let cp: CriticalPathModel
    let target: PerfTarget?
    var metrics = Theme.Metrics(density: .compact)

    static let placeholder = "No mark or row selected"

    var body: some View {
        SelectionBar(sentence: target?.sentence, placeholder: Self.placeholder, metrics: metrics) { buttons }
    }

    @ViewBuilder private var buttons: some View {
        let event = target?.evidence != nil
        let none = target == nil ? "Select a mark or a row first" : "No event marks this time"
        if let sub = target?.subagent {
            Button("Open Subagent") { cp.openSubagent(sub) }
                .help("Critical Path of this subagent's own run")
        }
        Button("Show in Events") { cp.showInEvents(target) }
            .disabled(!event)
            .help(event ? "Select this event in the Events workspace" : none)
        Button("Show in Session") { cp.showInSession(target) }
            .disabled(!event)
            .help(event ? "Show in Session (⌘↩): its step in Steps" : none)
        Button("Show in Timeline") { cp.showInTimeline(target) }
            .disabled(target?.range == nil && !event)
            .help(target == nil ? "Select a mark or a row first" : "Set the time range to this stretch and show it in the Timeline")
        Button("Copy Event ID") { cp.copyEventID(target) }
            .disabled(!event)
            .help(event ? "Copy the ID of the selected event" : none)
    }
}

/// One line of metadata under a table's pane header.
struct PerfPaneNote: View {
    let text: String

    var body: some View {
        VStack(spacing: 0) {
            Text(text)
                .font(Theme.fontSwiftUI(.metadata))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
            Divider()
        }
    }
}

/// The context menu of a table row: the selection bar's actions.
struct PerfRowMenu: View {
    let cp: CriticalPathModel
    let target: PerfTarget?

    var body: some View {
        let event = target?.evidence != nil
        Button("Show in Events") { cp.showInEvents(target) }.disabled(!event)
        Button("Show in Session") { cp.showInSession(target) }.disabled(!event)
        Button("Show in Timeline") { cp.showInTimeline(target) }.disabled(target?.range == nil && !event)
        Divider()
        if let sub = target?.subagent { Button("Open Subagent") { cp.openSubagent(sub) } }
        Button("Copy Event ID") { cp.copyEventID(target) }.disabled(!event)
    }
}

extension CriticalPathModel {
    /// A double-click on a row: its event in Steps, or a subagent's own Critical Path.
    func open(_ s: PerfSelection, in content: CriticalPathContent) {
        let t = content.target(s)
        if t?.evidence != nil {
            showInSession(t)
        } else if case .delegation = s {
            openSubagent(t?.subagent)
        }
    }
}

// MARK: - Shared cells

private extension View {
    /// A cell's content, reported at most 14 pt tall. The SwiftUI table pads each cell by 4 pt above and below and sizes
    /// its row to the tallest cell, so a 13 pt line (16 pt) made 24 pt rows; capped, rows take DESIGN.md §4.3's 22 pt
    /// compact, and `defaultMinListRowHeight` raises them to 26 pt comfortable. The line still draws whole, centred.
    func tableCell() -> some View { frame(maxHeight: 14) }
}

/// A right-aligned figure with tabular digits.
private func figure(_ text: String, help: String? = nil) -> some View {
    Text(text)
        .font(Theme.fontSwiftUI(.rowPrimary))
        .monospacedDigit()
        .frame(maxWidth: .infinity, alignment: .trailing)
        .help(help ?? "")
        .tableCell()
}

private func missingAware(_ cell: CriticalPathContent.Cell) -> some View {
    figure(cell.text, help: cell.help).foregroundStyle(cell.help == nil ? Color.primary : Color.secondary)
}

/// A class's swatch and name.
private struct ClassCell: View {
    let pathClass: PathClass
    let name: String

    var body: some View {
        HStack(spacing: 6) {
            PathSwatch(pathClass: pathClass, size: 8)
            Text(name).lineLimit(1)
        }
        .font(Theme.fontSwiftUI(.rowPrimary))
        .help(name)
        .tableCell()
    }
}

/// The empty state of a table narrowed to a class, with the way back.
private struct ClassEmpty: View {
    let cp: CriticalPathModel
    let title: String
    let detail: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "line.3.horizontal.decrease.circle")
        } description: {
            Text(detail)
        } actions: {
            if cp.classFilter != nil { Button("Show Every Class") { cp.classFilter = nil } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Contributors

/// Tools and model steps on the path, largest first, in two groups, after the longest waits when waiting is the largest
/// share (§4.9). The table is `ContributorsOutline`, which sizes its columns from its own width; a table too narrow
/// for Session hides it and the footer says so.
private struct ContributorsTable: View {
    let cp: CriticalPathModel
    let content: CriticalPathContent
    let metrics: Theme.Metrics
    /// The table's width, which decides whether Session shows (`ContributorColumns`).
    @State private var width: CGFloat = 0

    private var groups: [CriticalPathContent.ContributorGroup] {
        content.contributors.filter { cp.classFilter == nil || $0.pathClass == cp.classFilter }
    }

    var body: some View {
        let groups = groups
        if groups.isEmpty {
            if let c = cp.classFilter {
                ClassEmpty(cp: cp, title: "No contributors in \(PathMarkStyle.name(c))",
                           detail: "Contributors lists the tools and the model steps with the most time on the path, and the longest waits when waiting is the largest share.")
            } else {
                ContentUnavailableView("No tools or model steps on the path", systemImage: "list.bullet",
                                       description: Text("The path is waiting and unattributed time only."))
            }
        } else {
            VStack(spacing: 0) {
                ContributorsOutline(cp: cp, content: content, groups: groups, selectedID: content.contributorRowID(for: cp.selection, in: groups),
                                    metrics: metrics)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
                if !CriticalPathContent.ContributorColumns(groups, width: width).showsSession {
                    TableFooter(count: Formatters.count(groups.reduce(0) { $0 + $1.rows.count }, "contributor"),
                                hint: PerfColumnFit.note([.init(id: "session", title: "Session", width: 0)]) ?? "")
                }
            }
        }
    }
}

// MARK: - Column fit

/// Tables never scroll sideways (DESIGN.md §4.4): when a table's columns do not fit its width, its optional columns hide
/// in order, and the footer names them.
struct PerfColumnFit {
    struct Column {
        let id: String
        let title: String
        /// The widest the column grows: the table gives a column room up to its maximum before its flexible column.
        let width: CGFloat
    }

    /// The columns that always show: the flexible column's minimum and the others' maximums, summed.
    let fixed: CGFloat
    /// Optional columns, first to hide first.
    let optional: [Column]
    let count: Int

    /// What one column takes beyond its own width: the table's spacing between cells.
    static let spacing: CGFloat = 17
    /// The table's own margins and scroller.
    static let margins: CGFloat = 32

    /// The optional columns that do not fit in `width`.
    func hidden(in width: CGFloat) -> [Column] {
        guard width > 0 else { return [] }
        var need = fixed + optional.reduce(0) { $0 + $1.width } + CGFloat(count) * Self.spacing + Self.margins
        var out: [Column] = []
        for c in optional where need > width {
            out.append(c)
            need -= c.width + Self.spacing
        }
        return out
    }

    /// "Started and Duplicate reads do not fit; widen the pane or hide the inspector to show them."
    static func note(_ hidden: [Column]) -> String? {
        guard !hidden.isEmpty else { return nil }
        let names = hidden.map(\.title)
        let list = names.count == 1 ? names[0] : names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
        return list + (names.count == 1 ? " does" : " do") + " not fit; widen the pane or hide the inspector to show " + (names.count == 1 ? "it." : "them.")
    }
}

/// Hides a table's optional columns that do not fit its width, through the table's column customization.
private struct ColumnFitting<Row: Identifiable>: ViewModifier {
    let fit: PerfColumnFit
    @Binding var customization: TableColumnCustomization<Row>
    @Binding var hidden: [PerfColumnFit.Column]

    func body(content: Content) -> some View {
        content.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            let now = fit.hidden(in: width)
            guard now.map(\.id) != hidden.map(\.id) else { return }
            hidden = now
            for c in fit.optional { customization[visibility: c.id] = now.contains { $0.id == c.id } ? .hidden : .visible }
        }
    }
}

// MARK: - Segments

/// The track as text (§4.9, DESIGN.md §10.3): every returned segment in time order, with the cap stated in the footer.
private struct SegmentsTable: View {
    let cp: CriticalPathModel
    let content: CriticalPathContent
    @State private var customization = TableColumnCustomization<CriticalPathContent.SegmentRow>()
    @State private var hidden: [PerfColumnFit.Column] = []

    /// Evidence hides first, then Session; Start, Class, the step or call and Duration always show.
    private static let fit = PerfColumnFit(fixed: 104 + 170 + 120 + 72, optional: [.init(id: "evidence", title: "Evidence", width: 64),
                                                                               .init(id: "session", title: "Session", width: 100)], count: 6)

    private var rows: [CriticalPathContent.SegmentRow] {
        guard let c = cp.classFilter else { return content.segments }
        let segs = content.path.segments
        return content.segments.filter { segs[$0.index].class == c || segs[$0.index].mixedParts.contains { $0.class == c } }
    }

    /// The track band's sentence, then the columns that do not fit.
    private var footer: String {
        [content.segmentCap.map { $0 + "." }, PerfColumnFit.note(hidden)].compactMap { $0 }.joined(separator: " ")
    }

    var body: some View {
        let rows = rows
        VStack(spacing: 0) {
            if rows.isEmpty, let c = cp.classFilter {
                ClassEmpty(cp: cp, title: "No segments in \(PathMarkStyle.name(c))", detail: "No segment of the path is in this class.")
            } else {
                table(rows)
            }
            TableFooter(count: cp.classFilter == nil ? Formatters.count(rows.count, "segment")
                            : "\(Formatters.count(rows.count)) of \(Formatters.count(content.segments.count, "segment"))",
                        hint: footer)
        }
    }

    /// The selected segment, or for a contributor or rework row, the segment its event marks first, so the table follows
    /// the selection made on another tab or on the track (§4.10).
    private var selectedIndex: Int? {
        if case .segment(let i)? = cp.selection { return i }
        return cp.target(in: content)?.segments.first
    }

    private var selection: Binding<Int?> {
        Binding(get: { selectedIndex }, set: { i in
            guard i != selectedIndex else { return }
            cp.select(i.map(PerfSelection.segment), in: content)
        })
    }

    private func table(_ rows: [CriticalPathContent.SegmentRow]) -> some View {
        ScrollViewReader { proxy in
            segmentTable(rows)
                .onChange(of: selectedIndex) { _, i in
                    if let i { proxy.scrollTo(i) }
                }
                .onAppear {
                    DispatchQueue.main.async { if let i = selectedIndex { proxy.scrollTo(i) } }
                }
        }
    }

    private func segmentTable(_ rows: [CriticalPathContent.SegmentRow]) -> some View {
        Table(rows, selection: selection, columnCustomization: $customization) {
            TableColumn("Start") { (r: CriticalPathContent.SegmentRow) in
                Text(r.start).font(Theme.fontSwiftUI(.rowPrimary)).monospacedDigit().foregroundStyle(.secondary).help(r.startHelp).tableCell()
            }
            .width(min: 88, ideal: 92, max: 104)
            .customizationID("start")
            .disabledCustomizationBehavior(.visibility)
            TableColumn("Session") { (r: CriticalPathContent.SegmentRow) in
                Text(r.session).font(Theme.fontSwiftUI(.rowPrimary)).foregroundStyle(.secondary).lineLimit(1).help(r.sessionHelp).tableCell()
            }
            .width(min: 64, ideal: 72, max: 100)
            .customizationID("session")
            TableColumn("Class") { (r: CriticalPathContent.SegmentRow) in ClassCell(pathClass: r.pathClass, name: r.className) }
                .width(min: 120, ideal: 150, max: 170)
                .customizationID("class")
                .disabledCustomizationBehavior(.visibility)
            TableColumn("Step or call") { (r: CriticalPathContent.SegmentRow) in
                Text(r.label.isEmpty ? Formatters.missing : r.label)
                    .font(r.labelIsCode ? Theme.fontSwiftUI(.code) : Theme.fontSwiftUI(.rowPrimary))
                    .foregroundStyle(r.label.isEmpty ? Color.secondary : Color.primary)
                    .lineLimit(1)
                    .truncationMode(r.labelIsCode ? .middle : .tail)
                    .help(r.label.isEmpty ? "The engine names no step or call for this time" : r.label)
                    .tableCell()
            }
            .width(min: 120, ideal: 130)
            .customizationID("label")
            .disabledCustomizationBehavior(.visibility)
            TableColumn("Duration") { (r: CriticalPathContent.SegmentRow) in figure(r.duration, help: r.durationHelp) }
                .width(min: 60, ideal: 60, max: 72)
                .alignment(.trailing)
                .customizationID("duration")
                .disabledCustomizationBehavior(.visibility)
            TableColumn("Evidence") { (r: CriticalPathContent.SegmentRow) in
                Text(r.evidence == nil ? Formatters.missing : "Event")
                    .foregroundStyle(.secondary)
                    .help(r.evidence == nil ? "No event marks this time" : "Selecting the row shows the event in the inspector")
                    .tableCell()
            }
            .width(min: 56, ideal: 56, max: 64)
            .customizationID("evidence")
        }
        .modifier(ColumnFitting(fit: Self.fit, customization: $customization, hidden: $hidden))
        .alternatingRowBackgrounds(.disabled)
        .contextMenu(forSelectionType: Int.self) { ids in
            if let i = ids.first { PerfRowMenu(cp: cp, target: content.target(.segment(i))) }
        } primaryAction: { ids in
            if let i = ids.first { cp.open(.segment(i), in: content) }
        }
    }
}

// MARK: - Rework

/// Repeated or reworked time (§4.9); a row opens to its evidence events, up to 50.
private struct ReworkTable: View {
    @Bindable var cp: CriticalPathModel
    let content: CriticalPathContent

    struct Item: Identifiable, Hashable {
        let id: String
        let kind: PerfReworkKind
        let row: CriticalPathContent.ReworkRow?
        let evidence: Int?
        let ref: EvidenceRef?

        var selection: PerfSelection { .rework(kind, evidence: evidence) }
    }

    private var selection: Binding<String?> {
        Binding(get: {
            guard case .rework(let k, let e)? = cp.selection else { return nil }
            return Self.id(k, e)
        }, set: { id in
            cp.select(id.flatMap(Self.selection), in: content)
        })
    }

    private static func id(_ k: PerfReworkKind, _ e: Int?) -> String { k.rawValue + (e.map { "#\($0)" } ?? "") }

    private static func selection(_ id: String) -> PerfSelection? {
        let parts = id.split(separator: "#", maxSplits: 1).map(String.init)
        guard let k = PerfReworkKind(rawValue: parts[0]) else { return nil }
        return .rework(k, evidence: parts.count > 1 ? Int(parts[1]) : nil)
    }

    var body: some View {
        Table(of: Item.self, selection: selection) {
            TableColumn("Pattern") { (item: Item) in patternCell(item).tableCell() }
                .width(min: 160, ideal: 200)
            TableColumn("Count") { (item: Item) in
                if let r = item.row { figure(r.count).foregroundStyle(r.isZero ? Color.secondary : Color.primary) }
            }
            .width(min: 112, ideal: 120, max: 180)
            .alignment(.trailing)
            TableColumn("Time") { (item: Item) in
                if let r = item.row { figure(r.time).foregroundStyle(r.isZero ? Color.secondary : Color.primary) }
            }
            .width(min: 60, ideal: 64, max: 88)
            .alignment(.trailing)
            TableColumn("On path (of \(content.wallText))") { (item: Item) in
                if let r = item.row { figure(r.onPath, help: r.onPathHelp).foregroundStyle(r.isZero ? Color.secondary : Color.primary) }
            }
            .width(min: 120, ideal: 130, max: 180)
            .alignment(.trailing)
        } rows: {
            ForEach(content.rework) { r in
                let head = Item(id: Self.id(r.kind, nil), kind: r.kind, row: r, evidence: nil, ref: nil)
                if r.evidence.isEmpty {
                    TableRow(head)
                } else {
                    DisclosureTableRow(head, isExpanded: expansion(r.kind)) {
                        ForEach(Array(r.evidence.enumerated()), id: \.offset) { i, ref in
                            TableRow(Item(id: Self.id(r.kind, i), kind: r.kind, row: nil, evidence: i, ref: ref))
                        }
                    }
                }
            }
        }
        .alternatingRowBackgrounds(.disabled)
        .contextMenu(forSelectionType: String.self) { ids in
            if let s = ids.first.flatMap(Self.selection) { PerfRowMenu(cp: cp, target: content.target(s)) }
        } primaryAction: { ids in
            guard let s = ids.first.flatMap(Self.selection) else { return }
            if case .rework(let k, nil) = s, !(content.rework.first { $0.kind == k }?.evidence.isEmpty ?? true) {
                expansion(k).wrappedValue.toggle()
            } else {
                cp.open(s, in: content)
            }
        }
    }

    @ViewBuilder private func patternCell(_ item: Item) -> some View {
        if let r = item.row {
            Text(r.name).font(Theme.fontSwiftUI(.rowPrimary)).foregroundStyle(r.isZero ? Color.secondary : Color.primary)
        } else if let ref = item.ref, let e = item.evidence {
            HStack(spacing: 8) {
                Text("Event \(Formatters.count(e + 1))").monospacedDigit()
                Text(content.names.short(ref.sessionId) + (ref.line.map { " · line \(Formatters.count($0))" } ?? ""))
                    .foregroundStyle(.secondary).lineLimit(1)
                Text(Formatters.middleEllipsis(ref.eventId)).font(Theme.fontSwiftUI(.code)).foregroundStyle(.secondary)
                    .help(ref.eventId)
                Spacer(minLength: 4)
                Button("Show") { cp.select(item.selection, in: content) }
                    .buttonStyle(.link)
                    .help("Select this event; the inspector shows it")
            }
            .font(Theme.fontSwiftUI(.rowPrimary))
        }
    }

    private func expansion(_ k: PerfReworkKind) -> Binding<Bool> {
        Binding(get: { cp.expandedRework.contains(k) }, set: { if $0 { cp.expandedRework.insert(k) } else { cp.expandedRework.remove(k) } })
    }
}

// MARK: - Subagents

/// The run's subagents (§4.9), most time on the path first; a double-click opens a subagent's own Critical Path.
private struct SubagentsTable: View {
    let cp: CriticalPathModel
    let content: CriticalPathContent
    @State private var customization = TableColumnCustomization<CriticalPathContent.SubagentRow>()
    @State private var hidden: [PerfColumnFit.Column] = []

    /// Started hides first, then Duplicate reads and Overlap with siblings; the subagent and its times always show.
    private static let fit = PerfColumnFit(fixed: 120 + 64 + 96 + 68, optional: [
        .init(id: "started", title: "Started", width: 100), .init(id: "reads", title: "Duplicate reads", width: 104),
        .init(id: "overlap", title: "Overlap with siblings", width: 128),
    ], count: 7)

    private var selection: Binding<Int?> {
        Binding(get: { if case .delegation(let i)? = cp.selection { return i } else { return nil } },
                set: { cp.select($0.map(PerfSelection.delegation), in: content) })
    }

    var body: some View {
        if content.subagents.isEmpty {
            ContentUnavailableView("No subagents", systemImage: "person.2",
                                   description: Text("This run started no subagents, so its path stays in one session."))
        } else {
            VStack(spacing: 0) {
                table
                TableFooter(count: Formatters.count(content.subagents.count, "subagent"),
                            hint: PerfColumnFit.note(hidden) ?? "Double-click a subagent to see its own critical path.")
            }
        }
    }

    private var table: some View {
        Table(content.subagents, selection: selection, columnCustomization: $customization) {
            TableColumn("Subagent") { (r: CriticalPathContent.SubagentRow) in
                HStack(spacing: 8) {
                    Text(r.name).lineLimit(1).layoutPriority(1)
                    if let task = r.task { Text(task).foregroundStyle(.secondary).lineLimit(1) }
                }
                .font(Theme.fontSwiftUI(.rowPrimary))
                .help(r.help)
                .tableCell()
            }
            .width(min: 120, ideal: 140)
            .customizationID("subagent")
            .disabledCustomizationBehavior(.visibility)
            TableColumn("Started") { (r: CriticalPathContent.SubagentRow) in
                Text(r.started).font(Theme.fontSwiftUI(.rowPrimary)).foregroundStyle(.secondary).help(r.startedHelp).tableCell()
            }
            .width(min: 84, ideal: 88, max: 100)
            .customizationID("started")
            TableColumn("Busy") { (r: CriticalPathContent.SubagentRow) in missingAware(r.busy) }
                .width(min: 52, ideal: 56, max: 64).alignment(.trailing)
                .customizationID("busy").disabledCustomizationBehavior(.visibility)
            TableColumn("Parent waited") { (r: CriticalPathContent.SubagentRow) in missingAware(r.parentWaited) }
                .width(min: 80, ideal: 84, max: 96).alignment(.trailing)
                .customizationID("waited").disabledCustomizationBehavior(.visibility)
            TableColumn("On path") { (r: CriticalPathContent.SubagentRow) in figure(r.onPath) }
                .width(min: 56, ideal: 60, max: 68).alignment(.trailing)
                .customizationID("onPath").disabledCustomizationBehavior(.visibility)
            TableColumn("Overlap with siblings") { (r: CriticalPathContent.SubagentRow) in missingAware(r.overlap) }
                .width(min: 112, ideal: 116, max: 128).alignment(.trailing)
                .customizationID("overlap")
            TableColumn("Duplicate reads") { (r: CriticalPathContent.SubagentRow) in figure(r.duplicateReads) }
                .width(min: 92, ideal: 96, max: 104).alignment(.trailing)
                .customizationID("reads")
        }
        .modifier(ColumnFitting(fit: Self.fit, customization: $customization, hidden: $hidden))
        .alternatingRowBackgrounds(.disabled)
        .contextMenu(forSelectionType: Int.self) { ids in
            if let i = ids.first { PerfRowMenu(cp: cp, target: content.target(.delegation(i))) }
        } primaryAction: { ids in
            if let i = ids.first { cp.open(.delegation(i), in: content) }
        }
    }
}
