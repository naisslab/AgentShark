import AppKit
import SwiftUI

/// Per-window state of the sidebar's list filters (they never change the scope).
@MainActor @Observable final class SidebarListState {
    var query = ""
    var activeWithin: SidebarListFilter.ActiveWithin = .any
    /// Counts of the last build, for the footer.
    var matching = 0
    var total = 0
}

/// The source list (MAC-SPEC §3): All Sessions, Live, Pinned, Recent, then agents → projects → sessions with
/// nested subagents; a list filter at the bottom. Selecting rows scopes the window; ⌘-click selects several.
///
/// It is an `NSOutlineView`: the list holds every indexed session (thousands on a busy Mac) and is rebuilt as
/// the list filter changes. A view-based outline reloads only its visible rows, with reused cells; a SwiftUI
/// `List` diffs every row on each rebuild.
struct SidebarView: View {
    @Bindable var model: WindowModel
    @State private var list = SidebarListState()
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                SidebarOutline(model: model, list: list, openWindow: openWindow)
                emptyOverlay
            }
            Divider()
            footer
        }
    }

    private var filter: SidebarListFilter {
        SidebarListFilter(query: list.query, hiddenAgents: model.app.preferences.hiddenAgents, activeWithin: list.activeWithin)
    }

    @ViewBuilder private var emptyOverlay: some View {
        switch model.store.sessionsPhase {
        case .failed(let e) where model.sessions.isEmpty:
            FailedStateView(title: "Could not load sessions", message: "The session list is unavailable.", error: e) {
                model.store.refreshAllSessions()
            }
        case .loading where model.sessions.isEmpty, .idle where model.sessions.isEmpty:
            LoadingStateView(title: model.engine.api == nil ? "Waiting for the engine…" : "Loading sessions…")
        default:
            if list.matching == 0 && filter.isActive && !model.sessions.isEmpty {
                ContentUnavailableView {
                    Label("No sessions", systemImage: "line.3.horizontal.decrease.circle")
                } description: {
                    Text(SidebarTreeBuilder.emptyReason(filter))
                } actions: {
                    if list.activeWithin != .any { Button("Show All Dates") { list.activeWithin = .any } }
                    if !list.query.isEmpty { Button("Clear Search") { list.query = "" } }
                    if !model.app.preferences.hiddenAgents.isEmpty { Button("Show All Agents") { model.app.preferences.hiddenAgents = [] } }
                }
                .padding(.top, 60)
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                SidebarSearchField(text: $list.query)
                    .frame(height: 24)
                Menu {
                    Section("Active Within") {
                        Picker("Active Within", selection: $list.activeWithin) {
                            ForEach(SidebarListFilter.ActiveWithin.allCases) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                    Section("Agents") {
                        ForEach(AgentKind.known, id: \.self) { agent in
                            Toggle(agent.label, isOn: Binding(
                                get: { !model.app.preferences.hiddenAgents.contains(agent.rawValue) },
                                set: { show in
                                    if show { model.app.preferences.hiddenAgents.remove(agent.rawValue) } else { model.app.preferences.hiddenAgents.insert(agent.rawValue) }
                                }))
                        }
                    }
                    Divider()
                    Button("Reset List Filters") {
                        list.query = ""
                        list.activeWithin = .any
                        model.app.preferences.hiddenAgents = []
                    }
                    .disabled(!filter.isActive)
                } label: {
                    Image(systemName: filter.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(filter.isActive ? Color.accentColor : Color.secondary)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("List filters: recent activity and agents. They filter this list only; they never change the scope.")
                .accessibilityLabel("Session list filters")
            }
            Text(footerText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .help("List filters change which sessions this list shows. They do not change the events in any workspace.")
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 10)
    }

    private var footerText: String {
        if model.store.sessionsAreCached { return "Last known sessions · the engine is starting" }
        if filter.isActive {
            return "List filter: \(Formatters.count(list.matching)) of \(Formatters.count(list.total)) sessions"
        }
        return Formatters.count(list.total, "session")
    }
}

/// The sidebar's search field ("Filter Sessions"), debounced.
struct SidebarSearchField: NSViewRepresentable {
    @Binding var text: String

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    func makeNSView(context: Context) -> NSSearchField {
        let field = NSSearchField()
        field.placeholderString = "Filter Sessions"
        field.sendsSearchStringImmediately = false
        field.sendsWholeSearchString = false
        field.controlSize = .regular
        field.font = .systemFont(ofSize: 12)
        field.delegate = context.coordinator
        field.setAccessibilityLabel("Filter the session list")
        field.toolTip = "Filters this list by title, project, ID, folder, branch or model. It does not change the scope."
        return field
    }

    func updateNSView(_ field: NSSearchField, context: Context) {
        context.coordinator.text = $text
        if field.stringValue != text { field.stringValue = text }
    }

    @MainActor final class Coordinator: NSObject, NSSearchFieldDelegate {
        var text: Binding<String>
        private var pending: Task<Void, Never>?
        init(text: Binding<String>) { self.text = text }

        /// Typing filters after a short pause; clearing applies at once.
        func controlTextDidChange(_ obj: Notification) {
            guard let field = obj.object as? NSSearchField else { return }
            let value = field.stringValue
            pending?.cancel()
            guard !value.isEmpty else { text.wrappedValue = value; return }
            pending = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(120))
                guard !Task.isCancelled else { return }
                self?.text.wrappedValue = value
            }
        }
    }
}

/// The outline itself.
struct SidebarOutline: NSViewControllerRepresentable {
    let model: WindowModel
    let list: SidebarListState
    let openWindow: OpenWindowAction

    func makeNSViewController(context: Context) -> SidebarController {
        SidebarController(model: model, list: list, openWindow: openWindow)
    }

    func updateNSViewController(_ controller: SidebarController, context: Context) {}

    static func dismantleNSViewController(_ controller: SidebarController, coordinator: ()) { controller.tearDown() }
}

@MainActor final class SidebarController: NSViewController, NSOutlineViewDataSource, NSOutlineViewDelegate, NSMenuDelegate {
    let model: WindowModel
    let list: SidebarListState
    let openWindow: OpenWindowAction
    private let outline = NSOutlineView()
    private let scrollView = ShadowedScrollView()
    private let contextMenu = NSMenu()
    private var items: [SidebarItem] = []
    private var loops: [ObservationLoop] = []
    private var applyingSelection = false
    private var selectionTask: Task<Void, Never>?
    private var minuteTimer: Timer?
    private var buildTask: Task<Void, Never>?
    /// The next update refreshes every row on screen: relative times follow the clock.
    private var refreshAllRows = false
    /// The Live section of the last build, before the list filters.
    private var liveShown: [String] = []
    private var expandedKeys: Set<String>
    private var collapsedKeys: Set<String>
    /// A rebuild right after the scope changed elsewhere scrolls to the selection instead of keeping the old position.
    private var revealUntil = Date.distantPast
    /// Rows the person selected (their keys), so a rebuild keeps the same rows (Recent rather than the tree).
    private var preferredKeys: Set<String> = []
    /// The session set this list last applied, to tell its own scope changes from outside ones.
    private var appliedIDs: [String]?
    private var itemsBySession: [String: [SidebarItem]] = [:]

    private static let expandedKey = "AgentShark.sidebarExpanded"
    private static let collapsedKey = "AgentShark.sidebarCollapsed"
    /// Projects active within this time start expanded.
    private static let recentProjectWindow: TimeInterval = 7 * 86400

    init(model: WindowModel, list: SidebarListState, openWindow: OpenWindowAction) {
        self.model = model
        self.list = list
        self.openWindow = openWindow
        expandedKeys = Set(UserDefaults.standard.stringArray(forKey: Self.expandedKey) ?? [])
        collapsedKeys = Set(UserDefaults.standard.stringArray(forKey: Self.collapsedKey) ?? [])
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("session"))
        column.resizingMask = .autoresizingMask
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.style = .sourceList
        outline.rowSizeStyle = .custom
        outline.rowHeight = 24
        outline.allowsMultipleSelection = true
        outline.allowsEmptySelection = true
        outline.floatsGroupRows = false
        outline.indentationPerLevel = 12
        outline.autoresizesOutlineColumn = false
        outline.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.doubleAction = #selector(doubleClicked)
        outline.setAccessibilityLabel("Sessions")
        contextMenu.delegate = self
        contextMenu.autoenablesItems = false
        outline.menu = contextMenu

        scrollView.documentView = outline
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        view = scrollView

        NotificationCenter.default.addObserver(self, selector: #selector(expansionChanged(_:)), name: NSOutlineView.itemDidExpandNotification, object: outline)
        NotificationCenter.default.addObserver(self, selector: #selector(expansionChanged(_:)), name: NSOutlineView.itemDidCollapseNotification, object: outline)
        loops.append(ObservationLoop { [weak self] in self?.followData() })
        loops.append(ObservationLoop { [weak self] in self?.followScope() })
        loops.append(ObservationLoop { [weak self] in self?.followMarks() })
        // The Live section and relative times follow the clock.
        minuteTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.minuteTick() }
        }
    }

    func tearDown() {
        loops.forEach { $0.cancel() }
        loops.removeAll()
        minuteTimer?.invalidate()
        buildTask?.cancel()
        selectionTask?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: Building

    private var filter: SidebarListFilter {
        SidebarListFilter(query: list.query, hiddenAgents: model.app.preferences.hiddenAgents, activeWithin: list.activeWithin)
    }

    private func followData() {
        _ = model.store.sessions
        _ = SidebarLists.shared.pinned
        _ = SidebarLists.shared.recent
        _ = filter
        rebuild()
    }

    /// Build the tree in the background: it walks every session, tens of milliseconds of main thread with thousands of
    /// them on every index run. The latest build wins; its result merges into the rows on screen.
    private func rebuild() {
        let store = model.store
        let sessions = store.sessions, byID = store.sessionsByID, children = store.childrenByParent
        let pinned = SidebarLists.shared.pinned, recent = SidebarLists.shared.recent, filter = filter
        liveShown = SidebarTreeBuilder.liveIDs(sessions)
        buildTask?.cancel()
        buildTask = Task { [weak self] in
            let result = await Task.detached(priority: .userInitiated) {
                SidebarTreeBuilder.build(sessions: sessions, byID: byID, childrenByParent: children, pinned: pinned, recent: recent, filter: filter)
            }.value
            guard !Task.isCancelled else { return }
            self?.apply(result)
        }
    }

    /// A minute changes the relative times of the rows on screen. The tree changes only when a session leaves the Live
    /// window or a list filter keeps recent sessions; rebuilding it every minute anyway cost the main thread 80 ms.
    private func minuteTick() {
        if filter.activeWithin != .any || SidebarTreeBuilder.liveIDs(model.store.sessions) != liveShown {
            refreshAllRows = true
            rebuild()
        } else {
            refreshRowViews()
        }
    }

    private func apply(_ result: SidebarTreeBuilder.Result) {
        // The rebuilt rows that matched rows on screen are dropped; free those thousands of objects in the background.
        defer { Task.detached(priority: .background) { withExtendedLifetime(result) {} } }
        if list.matching != result.matching { list.matching = result.matching }
        if list.total != result.total { list.total = result.total }
        // Rows that are still there keep their objects, so only the parents whose children changed reload. A full reload
        // on every index run re-expanded every expanded row, and AppKit made a row view and a disclosure button for each
        // of them: after a few days that kept hundreds of thousands of buttons alive and stalled the main thread.
        let merged = SidebarItem.reconcile(items, result.items)
        let origin = scrollView.contentView.bounds.origin
        let full = items.isEmpty || merged.changed.contains { $0 == nil }
        items = merged.items
        if full || !merged.changed.isEmpty {
            itemsBySession = [:]
            func index(_ list: [SidebarItem]) {
                for item in list {
                    if let id = item.sessionID { itemsBySession[id, default: []].append(item) }
                    index(item.children)
                }
            }
            index(items)
        }
        applyingSelection = true
        if full {
            outline.reloadData()
        } else {
            let changed = Set(merged.changed.compactMap { $0.map(ObjectIdentifier.init) })
            // A parent inside another changed parent reloads with it.
            func insideChanged(_ item: SidebarItem) -> Bool {
                var p = item.parent
                while let q = p { if changed.contains(ObjectIdentifier(q)) { return true }; p = q.parent }
                return false
            }
            for case let parent? in merged.changed where !insideChanged(parent) { outline.reloadItem(parent, reloadChildren: true) }
            refreshRowViews(only: refreshAllRows ? nil : merged.updated)
        }
        refreshAllRows = false
        for item in items { restoreExpansion(item) }
        selectScopeItems(scroll: false)
        applyingSelection = false
        if Date() < revealUntil, outline.selectedRow >= 0 {
            outline.scrollRowToVisible(outline.selectedRow)
        } else {
            scrollView.contentView.scroll(to: origin)
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }
    }

    private func isExpandedByDefault(_ item: SidebarItem) -> Bool {
        switch item.kind {
        case .section: return true
        case .project:
            let latest = item.children.compactMap { $0.session?.lastActivity }.max() ?? 0
            return Double(latest) / 1e6 > Date().timeIntervalSince1970 - Self.recentProjectWindow
        case .session: return !list.query.trimmingCharacters(in: .whitespaces).isEmpty
        case .allSessions: return false
        }
    }

    private func shouldExpand(_ item: SidebarItem) -> Bool {
        if expandedKeys.contains(item.key) { return true }
        if collapsedKeys.contains(item.key) { return false }
        return isExpandedByDefault(item)
    }

    private func restoreExpansion(_ item: SidebarItem) {
        guard !item.children.isEmpty, shouldExpand(item) else { return }
        // Expanding an expanded row is not free: AppKit lays its rows out again.
        if !outline.isItemExpanded(item) { outline.expandItem(item) }
        for c in item.children { restoreExpansion(c) }
    }

    @objc private func expansionChanged(_ note: Notification) {
        guard !applyingSelection, let item = note.userInfo?["NSObject"] as? SidebarItem else { return }
        let expanded = note.name == NSOutlineView.itemDidExpandNotification
        if expanded == isExpandedByDefault(item) {
            expandedKeys.remove(item.key)
            collapsedKeys.remove(item.key)
        } else if expanded {
            expandedKeys.insert(item.key)
            collapsedKeys.remove(item.key)
        } else {
            collapsedKeys.insert(item.key)
            expandedKeys.remove(item.key)
        }
        UserDefaults.standard.set(Array(expandedKeys), forKey: Self.expandedKey)
        UserDefaults.standard.set(Array(collapsedKeys), forKey: Self.collapsedKey)
        // A collapsed parent shows the worst mark of its subtree; an expanded one only its own.
        let row = outline.row(forItem: item)
        if row >= 0 { outline.reloadData(forRowIndexes: IndexSet(integer: row), columnIndexes: IndexSet(integer: 0)) }
    }

    /// Sidebar glyphs (SPEC §12.7): refresh the rows on screen when the marks change.
    private func followMarks() {
        _ = model.derived.marks
        _ = model.derived.marksGaps
        // Outside the observation: a collapsed row's mark reads the session tree, whose changes reach the rows through
        // `apply`; observed here, every index run would refresh the rows twice.
        Task { @MainActor [weak self] in self?.refreshRowViews() }
    }

    /// Configure the cells the outline already has (the visible rows and those AppKit keeps ready around them) for
    /// their items' current content, all of them or those of `only`. Reloading the rows instead would make new cell
    /// views and rebuild the key view loop, which cost more than the rest of a sidebar update.
    private func refreshRowViews(only: [SidebarItem]? = nil) {
        let wanted = only.map { Set($0.map(ObjectIdentifier.init)) }
        if wanted?.isEmpty == true { return }
        outline.enumerateAvailableRowViews { rowView, row in
            guard let item = outline.item(atRow: row) as? SidebarItem, wanted?.contains(ObjectIdentifier(item)) ?? true else { return }
            configure(rowView.view(atColumn: 0) as? NSView, for: item)
        }
    }

    private func configure(_ cell: NSView?, for item: SidebarItem) {
        if let cell = cell as? SidebarSectionCell {
            cell.configure(title: item.title, count: item.key.hasPrefix("agent:") ? item.count : nil)
        } else if let cell = cell as? SidebarRowCell {
            cell.configure(item, mark: mark(for: item))
        }
    }

    /// A session's mark; a collapsed parent shows the worst mark of its subtree.
    private func mark(for item: SidebarItem) -> SessionMark? {
        guard let id = item.sessionID else { return nil }
        let derived = model.derived
        if !item.children.isEmpty, !outline.isItemExpanded(item) {
            return derived.subtreeMark(id, children: model.store.childrenByParent)
        }
        return derived.marks[id]
    }

    // MARK: Selection ↔ scope

    private func followScope() {
        let ids = model.scope.sessions
        if ids != appliedIDs {
            // Changed elsewhere (Back, Open Child Session, a link): show the tree rows.
            preferredKeys = []
            revealUntil = Date().addingTimeInterval(1)
        }
        applyingSelection = true
        selectScopeItems(scroll: true)
        applyingSelection = false
    }

    private var selectedSessionIDs: [String] {
        var seen = Set<String>()
        return outline.selectedRowIndexes.compactMap { (outline.item(atRow: $0) as? SidebarItem)?.sessionID }.filter { seen.insert($0).inserted }
    }

    /// Select the rows for the scoped sessions (in the agent tree), expanding their parents.
    private func selectScopeItems(scroll: Bool) {
        let ids = model.scope.sessions
        if Set(selectedSessionIDs) == Set(ids), !(ids.isEmpty && outline.selectedRow < 0) { return }
        var rows = IndexSet()
        if ids.isEmpty {
            if let all = items.first(where: { $0.kind == .allSessions }) { rows.insert(outline.row(forItem: all)) }
        } else {
            for id in ids {
                let candidates = itemsBySession[id] ?? []
                guard let item = candidates.first(where: { preferredKeys.contains($0.key) }) ?? treeItem(for: id) ?? candidates.first
                else { continue }
                var chain: [SidebarItem] = []
                var p = item.parent
                while let n = p { chain.insert(n, at: 0); p = n.parent }
                for n in chain where !outline.isItemExpanded(n) { outline.expandItem(n) }
                let row = outline.row(forItem: item)
                if row >= 0 { rows.insert(row) }
            }
        }
        outline.selectRowIndexes(rows, byExtendingSelection: false)
        if scroll, let first = rows.first { outline.scrollRowToVisible(first) }
    }

    private func treeItem(for id: String) -> SidebarItem? {
        itemsBySession[id]?.first { $0.key == "tree:\(id)" }
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !applyingSelection else { return }
        let selected = outline.selectedRowIndexes.compactMap { outline.item(atRow: $0) as? SidebarItem }
        preferredKeys = Set(selected.map(\.key))
        let selectedAll = selected.contains { $0.kind == .allSessions }
        let ids = selectedAll ? [] : selectedSessionIDs
        // Arrowing through the list scopes after a short pause, not on every row.
        selectionTask?.cancel()
        selectionTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let self else { return }
            self.applyScope(ids)
        }
    }

    private func applyScope(_ ids: [String]) {
        guard ids != model.scope.sessions else { return }
        appliedIDs = ids
        switch ids.count {
        case 0: model.clearSessionScope()
        case 1:
            model.openSession(ids[0])
            SidebarLists.shared.noteOpened(ids[0])
        default: model.openSessions(ids)
        }
    }

    @objc private func doubleClicked() {
        guard let item = outline.item(atRow: outline.clickedRow) as? SidebarItem, let id = item.sessionID else { return }
        selectionTask?.cancel()
        SidebarLists.shared.noteOpened(id)
        appliedIDs = [id]
        model.openSession(id, workspace: .session)
    }

    // MARK: Data source

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        (item as? SidebarItem)?.children.count ?? items.count
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        (item as? SidebarItem)?.children[index] ?? items[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        !((item as? SidebarItem)?.children.isEmpty ?? true)
    }

    // MARK: Delegate

    func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool {
        (item as? SidebarItem)?.kind == .section
    }

    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
        guard let item = item as? SidebarItem else { return false }
        return item.kind == .session || item.kind == .allSessions
    }

    func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
        (item as? SidebarItem)?.kind == .section ? 26 : 24
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let item = item as? SidebarItem else { return nil }
        let cell: NSView
        switch item.kind {
        case .section:
            let id = NSUserInterfaceItemIdentifier("SidebarSection")
            cell = outlineView.makeView(withIdentifier: id, owner: nil) as? SidebarSectionCell ?? SidebarSectionCell(identifier: id)
        default:
            let id = NSUserInterfaceItemIdentifier("SidebarRow")
            cell = outlineView.makeView(withIdentifier: id, owner: nil) as? SidebarRowCell ?? SidebarRowCell(identifier: id)
        }
        configure(cell, for: item)
        return cell
    }

    // MARK: Context menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = outline.clickedRow
        guard row >= 0, let clicked = outline.item(atRow: row) as? SidebarItem, let clickedID = clicked.sessionID else { return }
        let ids = outline.selectedRowIndexes.contains(row) ? selectedSessionIDs : [clickedID]
        let model = self.model
        let openWindow = self.openWindow
        menu.addItem("Open in New Tab", symbol: "plus.square.on.square") {
            openInNewTab(NavState(workspace: model.workspace, scope: Scope(sessions: ids, from: model.scope.from, to: model.scope.to),
                                  filter: model.appliedFilter, selectedEvent: nil), openWindow: openWindow)
        }
        menu.addItem("Show Steps", symbol: SessionMode.steps.symbol, enabled: ids.count == 1) {
            SidebarLists.shared.noteOpened(clickedID)
            model.openSession(clickedID, mode: .steps)
        }
        menu.addItem("Show Transcript", symbol: SessionMode.transcript.symbol, enabled: ids.count == 1) {
            SidebarLists.shared.noteOpened(clickedID)
            model.openSession(clickedID, mode: .transcript)
        }
        SidebarAnalysisItems.add(to: menu, ids: ids, model: model)
        menu.addItem("Show Failures", symbol: Symbols.workspace(.failures)) {
            if ids.count == 1 { model.openSession(ids[0], workspace: .failures) } else {
                model.openSessions(ids)
                model.workspace = .failures
            }
        }
        menu.addItem("Show Timeline", symbol: "chart.bar.xaxis") {
            if ids.count == 1 { model.openSession(ids[0], workspace: .timeline) } else {
                model.openSessions(ids)
                model.workspace = .timeline
            }
        }
        menu.addItem(.separator())
        let pinned = ids.allSatisfy(SidebarLists.shared.isPinned)
        menu.addItem(pinned ? "Unpin" : "Pin", symbol: pinned ? "pin.slash" : "pin") { SidebarLists.shared.togglePin(ids) }
        menu.addItem(ids.count == 1 ? "Copy Session ID" : "Copy Session IDs", symbol: "doc.on.doc") {
            AppKitHelpers.copy(ids.joined(separator: "\n"))
        }
        menu.addItem("Reveal Transcript in Finder", symbol: "folder", enabled: ids.count == 1 && model.engine.api != nil) {
            guard let api = model.engine.api else { return }
            Task {
                guard let detail = try? await api.session(clickedID),
                      let path = detail.sources.first(where: { $0.kind.contains("transcript") || $0.kind == "rollout" })?.path ?? detail.sources.first?.path
                else { NSSound.beep(); return }
                AppKitHelpers.revealInFinder(path)
            }
        }
    }
}

// MARK: - Analysis items

/// The row menu's analysis items (ANALYSIS-UX §3.4), after Show Transcript: Show Critical Path for one session,
/// Compare Runs for exactly two top-level runs, and Compare With ▸ for one top-level run. A disabled item says why in
/// its tooltip. Built apart from the outline, so tests read the menu a right-click shows.
@MainActor enum SidebarAnalysisItems {
    /// How many runs Compare With ▸ lists before Choose…
    static let candidates = 8

    static func add(to menu: NSMenu, ids: [String], model: WindowModel) {
        let one = ids.count == 1 ? ids[0] : nil
        menu.addItem("Show Critical Path", symbol: SessionMode.criticalPath.symbol, enabled: one != nil) {
            guard let one else { return }
            SidebarLists.shared.noteOpened(one)
            model.openSession(one, mode: .criticalPath)
        }.toolTip = one == nil ? "Critical Path analyses one run. Select only one." : nil

        let pair = model.compareRunPair(ids)
        menu.addItem("Compare Runs", symbol: SessionMode.compare.symbol, enabled: pair != nil) {
            guard let pair else { return }
            model.compareRuns(pair.a, pair.b)
        }.toolTip = compareRunsHelp(ids, model: model)

        let run = one.flatMap { model.sessionsByID[$0]?.parentId == nil ? $0 : nil }
        menu.addSubmenu("Compare With", enabled: run != nil) { sub in
            guard let run else { return }
            dropFreedSearches()
            fillCompareWith(sub, run: run, model: model)
            searchSameTitle(of: run, model: model) { [weak sub] in
                if let sub { fillCompareWith(sub, run: run, model: model) }
            }
        }.toolTip = run != nil ? nil : one == nil ? "Compare With starts from one run. Select only one." : "Compare aligns two top-level runs."
    }

    /// Compare With ▸'s items: up to `candidates` runs ranked as the run chooser ranks them, from the catalog and the
    /// index's same-title search, then Choose…. Built again when the search returns, while the menu is open.
    static func fillCompareWith(_ sub: NSMenu, run: String, model: WindowModel) {
        sub.removeAllItems()
        let current = model.sessionsByID[run]
        let ranked = RunRanking.rank(model.store.sessions + searchedRuns(of: run, in: model.store), current: current, currentID: run,
                                     limit: candidates)
        for other in ranked {
            sub.addItem(RunRanking.menuTitle(other.row, current: current)) { model.compareRuns(run, other.id) }
                .toolTip = candidateHelp(other)
        }
        if ranked.isEmpty { sub.addItem("No Other Runs", enabled: false) {} }
        sub.addItem(.separator())
        sub.addItem("Choose…") { model.openSession(run, mode: .compare) }
    }

    // MARK: Same-title search (§5.2)

    /// A run of one index: a capture window's store is not the live one, though it can hold the same ids.
    private struct SearchKey: Hashable {
        let store: ObjectIdentifier
        let run: String
    }

    /// One search's result. The store is held weakly and must be the asking store itself: a freed store's address can
    /// come back as a new store's, at the same `indexGeneration`, and that store's index is not this one.
    private struct Search {
        weak var store: EngineStore?
        let generation: Int
        let rows: [SessionRow]
    }

    /// The index's same-title runs per run, from `GET /api/sessions?role=main&q={title}&limit=50` as the run chooser
    /// asks it: the catalog can lack a run the index holds. Kept while its store lives, and asked again after an index
    /// run.
    private static var searched: [SearchKey: Search] = [:]
    private static var searching: Set<SearchKey> = []

    /// The search for `run` in `store`, when it is that store's own.
    private static func search(of run: String, in store: EngineStore) -> Search? {
        searched[SearchKey(store: ObjectIdentifier(store), run: run)].flatMap { $0.store === store ? $0 : nil }
    }

    /// Searches kept for runs of every store, the freed ones' included until the next Compare With ▸ (tests).
    static var searchCount: Int { searched.count }

    /// Drop the searches of stores that are gone.
    private static func dropFreedSearches() {
        searched = searched.filter { $0.value.store != nil }
    }

    /// The search itself; tests stand in for the engine.
    static var sameTitleSearch: @MainActor (WindowModel, String) async -> [SessionRow]? = { model, title in
        guard let api = model.engine.api else { return nil }
        return try? await api.sessions(query: title, role: "main", limit: 50).sessions
    }

    /// The runs the index's same-title search found for `run`; empty before it returns.
    static func searchedRuns(of run: String, in store: EngineStore) -> [SessionRow] {
        search(of: run, in: store)?.rows ?? []
    }

    /// Search the index for runs with `run`'s title unless this index generation already did, then call `found` when
    /// the result differs from what the menu had.
    static func searchSameTitle(of run: String, model: WindowModel, found: @escaping @MainActor () -> Void) {
        let store = model.store
        let key = SearchKey(store: ObjectIdentifier(store), run: run)
        let generation = store.indexGeneration
        guard let title = model.sessionsByID[run]?.title, RunRanking.normalizedTitle(title) != nil,
              search(of: run, in: store)?.generation != generation, searching.insert(key).inserted else { return }
        Task { @MainActor in
            defer { searching.remove(key) }
            guard let rows = await sameTitleSearch(model, title) else { return }
            let before = search(of: run, in: store)?.rows ?? []
            searched[key] = Search(store: store, generation: generation, rows: rows)
            if rows != before { found() }
        }
    }

    /// Forget the searches (tests).
    static func resetSearches() {
        searched = [:]
        searching = []
    }

    /// A candidate's tooltip: why it ranks where it does and what its title leaves out, "Same folder · 18m 04s ·
    /// agentshark". The duration is the sidebar's (`RunDuration`).
    static func candidateHelp(_ run: RankedRun) -> String? {
        var parts = [run.tag].compactMap { $0 }
        if let d = RunDuration(run.row) { parts.append(d.phrase) }
        if let project = run.row.project, !project.isEmpty { parts.append(project) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Why Compare Runs is disabled for `ids`; nil when it is enabled.
    static func compareRunsHelp(_ ids: [String], model: WindowModel) -> String? {
        guard model.compareRunPair(ids) == nil else { return nil }
        let set = Set(ids)
        let roots = ids.filter { !model.hasAncestor($0, in: set) }
        if ids.count == 1 { return "Select two top-level runs with ⌘-click." }
        if roots.count == 1 { return "These are one run and its own subagent. Compare aligns two separate runs." }
        if roots.count > 2 { return "Compare aligns two runs. Select only two." }
        return "Compare aligns two top-level runs."
    }
}

extension WindowModel {
    /// The two top-level runs Compare Runs aligns for `ids` (ANALYSIS-UX §3.4, §3.5): exactly two remain once a session
    /// selected with its ancestor is dropped, as `scopeRootSessions` drops it, and neither has a parent. So a run and its
    /// own subagent never qualify. A session the catalog has not loaded counts as a run, as in `compareRoots`.
    func compareRunPair(_ ids: [String]) -> (a: String, b: String)? {
        let set = Set(ids)
        let roots = ids.filter { !hasAncestor($0, in: set) }
        guard roots.count == 2, roots[0] != roots[1], roots.allSatisfy({ sessionsByID[$0]?.parentId == nil }) else { return nil }
        return (roots[0], roots[1])
    }
}

/// A run's duration as the sidebar states it, from its first to its last logged event: the row tooltip's, which the
/// run chooser, Compare With ▸ and the session inspector reuse. When the first and last events share one time (one
/// logged event, or several stamped alike) nothing was measured, so it reads "—" with the reason, never "0ms"
/// (DESIGN.md §9: 0 means a measured zero).
enum RunDuration: Equatable {
    /// From the first to the last event, in µs.
    case measured(Int64)
    /// No duration, and why: "one logged event".
    case none(reason: String)

    /// nil without both times, or when the last precedes the first.
    init?(_ row: SessionRow) {
        guard let a = row.start, let b = row.end, b >= a else { return nil }
        if b > a && row.nEvents > 1 {
            self = .measured(b - a)
        } else {
            self = .none(reason: row.nEvents > 1 ? "its events share one time" : row.nEvents == 1 ? "one logged event" : "no logged events")
        }
    }

    /// "18m 04s"; nil when nothing was measured.
    var figure: String? {
        if case .measured(let us) = self { return Formatters.duration(us) }
        return nil
    }

    /// "18m 04s", or "—" in a row or a grid.
    var text: String { figure ?? Formatters.missing }

    /// The "—"'s tooltip, "No duration: one logged event"; nil for a figure.
    var help: String? {
        if case .none(let reason) = self { return "No duration: " + reason }
        return nil
    }

    /// The duration within a tooltip, where "—" could not carry its own: "18m 04s", or "no duration (one logged event)".
    var phrase: String {
        switch self {
        case .measured: return text
        case .none(let reason): return "no duration (\(reason))"
        }
    }
}

// MARK: - Cells

/// A section header ("Live", "Claude Code") with an optional count.
final class SidebarSectionCell: NSTableCellView {
    private let label = NSTextField(labelWithString: "")
    private let countLabel = NSTextField(labelWithString: "")

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .secondaryLabelColor
        countLabel.font = .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        countLabel.textColor = .tertiaryLabelColor
        countLabel.alignment = .right
        addSubview(label)
        addSubview(countLabel)
        textField = label
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(title: String, count: Int?) {
        label.stringValue = title
        countLabel.stringValue = count.map(Formatters.count) ?? ""
        setAccessibilityLabel(count.map { "\(title), \(Formatters.count($0, "session"))" } ?? title)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        let cw = ceil(countLabel.intrinsicContentSize.width)
        countLabel.frame = NSRect(x: bounds.maxX - cw - 30, y: (h - 14) / 2 - 1, width: cw, height: 14)
        label.frame = NSRect(x: 0, y: (h - 15) / 2 - 1, width: max(0, countLabel.frame.minX - 6), height: 15)
    }
}

/// A session, project or All Sessions row (DESIGN.md §7.18): a leading mark, the title, a firing alarm's bell, the age,
/// and one neutral count capsule with the error count, as in the source lists of Mail and Xcode. Events, tokens out,
/// duration and the subagent count are in the tooltip and the accessibility label; children sit under the disclosure.
final class SidebarRowCell: NSTableCellView {
    private let icon = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private let errorBadge = BadgeView()
    private let liveDot = PulsingDot()
    private let alarmIcon = NSImageView()
    /// What `icon` shows. The sidebar configures its cells again on every index run; a new image, string or tooltip
    /// makes AppKit draw the row again (and a tooltip re-registers its tracking area), so unchanged ones are not set.
    private var iconKey: String?

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        icon.imageScaling = .scaleProportionallyDown
        title.font = .systemFont(ofSize: 13)
        title.lineBreakMode = .byTruncatingTail
        title.cell?.truncatesLastVisibleLine = true
        detail.font = Theme.font(.metadata)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .right
        errorBadge.style = .count
        alarmIcon.imageScaling = .scaleProportionallyDown
        alarmIcon.image = Mark.alarm.image(size: 10, weight: .semibold, color: Theme.err)
        for v in [icon, liveDot, title, alarmIcon, detail, errorBadge] as [NSView] { addSubview(v) }
        textField = title
        imageView = icon
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(_ item: SidebarItem, mark: SessionMark? = nil) {
        liveDot.isHidden = true
        errorBadge.isHidden = true
        alarmIcon.isHidden = mark.map { $0.firingAlarms == 0 } ?? true
        alphaValue = 1
        var tip: String?
        switch item.kind {
        case .allSessions:
            setIcon("tray.full", tint: .controlAccentColor)
            set(title, "All Sessions")
            set(detail, Formatters.count(item.count))
            tip = "Clear the session scope: every session, with the current time range and filter."
            setAccessibilityLabel("All Sessions, \(Formatters.count(item.count, "session"))")
        case .project:
            setIcon("folder", tint: .secondaryLabelColor)
            set(title, item.title)
            set(detail, Formatters.count(item.count))
            tip = "\(item.title)\n\(Formatters.count(item.count, "session"))"
            setAccessibilityLabel("Project \(item.title), \(Formatters.count(item.count, "session"))")
        case .session:
            guard let s = item.session else { break }
            set(title, item.title)
            set(detail, s.lastActivity.map { Formatters.relative($0) } ?? Formatters.missing)
            let lead = Self.leadingMark(mark)
            if s.isMissingSource {
                setIcon("exclamationmark.triangle", tint: .systemOrange)
                alphaValue = 0.55
            } else if item.isLive {
                icon.isHidden = true
                liveDot.isHidden = false
                liveDot.startAnimating()
            } else if let lead {
                setIcon("mark \(lead.mark)") { lead.mark.image(size: 12, weight: .semibold, color: lead.color) }
            } else {
                setIcon("mark clean") { Mark.clean.image(size: 12, weight: .semibold, color: .secondaryLabelColor) }
                icon.isHidden = mark == nil
            }
            if s.nErrors > 0 {
                errorBadge.isHidden = false
                errorBadge.text = Formatters.count(s.nErrors)
            }
            tip = Self.tooltip(s, subagents: item.subagents) + (Self.markText(mark).map { "\n" + $0 } ?? "")
            var label = "\(item.title), \(s.agent.label)"
            if let m = Self.markText(mark) { label += ", " + m }
            if s.nErrors > 0 { label += ", \(Formatters.count(s.nErrors, "error"))" }
            if item.subagents > 0 { label += ", \(Formatters.count(item.subagents, "subagent"))" }
            if item.isLive { label += ", live" }
            if s.isMissingSource { label += ", transcript missing" }
            label += ", " + detail.stringValue
            setAccessibilityLabel(label)
            let errors = Formatters.count(s.nErrors, "error")
            if errorBadge.toolTip != errors { errorBadge.toolTip = errors }
        case .section:
            break
        }
        if toolTip != tip { toolTip = tip }
        needsLayout = true
    }

    private func set(_ field: NSTextField, _ text: String) {
        if field.stringValue != text { field.stringValue = text }
    }

    /// The leading mark: the worst problem impact, else a silent child failure (§6.3).
    static func leadingMark(_ mark: SessionMark?) -> (mark: Mark, color: NSColor)? {
        guard let m = mark else { return nil }
        if let i = m.worstImpact, i.isProblem { return (Mark.impact(i), DerivedStyle.impactColor(i)) }
        if m.silentChildren > 0 { return (.silentChild, Theme.err) }
        return nil
    }

    private func setIcon(_ symbol: String, tint: NSColor) {
        setIcon("\(symbol) \(tint)") {
            NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 12, weight: .regular).applying(.init(hierarchicalColor: tint)))
        }
    }

    /// Show the image `key` names, making it only when the icon shows another one.
    private func setIcon(_ key: String, _ make: () -> NSImage?) {
        icon.isHidden = false
        guard key != iconKey else { return }
        iconKey = key
        icon.image = make()
    }

    /// "worst impact failed · 1 silent child failure · 1 alarm firing" for the tooltip and VoiceOver.
    static func markText(_ mark: SessionMark?) -> String? {
        guard let m = mark else { return nil }
        var parts: [String] = []
        if let i = m.worstImpact, i.isProblem { parts.append("worst impact \(i.rawValue)") }
        if m.silentChildren > 0 { parts.append(Formatters.count(m.silentChildren, "silent child failure")) }
        if m.firingAlarms > 0 { parts.append(Formatters.count(m.firingAlarms, "alarm") + " firing") }
        if m.needAttention > 0 { parts.append("\(Formatters.count(m.needAttention)) need attention") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The title, then "Codex · 360 events · 12k out · 45m 13s · 16 errors · 96 subagents", the place and the time.
    static func tooltip(_ s: SessionRow, subagents: Int) -> String {
        var lines = [s.displayTitle]
        var facts = [s.agent.label, Formatters.count(s.nEvents, "event")]
        if let out = s.tokens.output, out > 0 { facts.append(Formatters.tokens(out) + " out") }
        if let d = RunDuration(s) { facts.append(d.phrase) }
        facts.append(Formatters.count(s.nErrors, "error"))
        if subagents > 0 { facts.append(Formatters.count(subagents, "subagent")) }
        lines.append(facts.joined(separator: " · "))
        if s.role != "main" { lines.append("Role: \(s.role)") }
        if let cwd = s.cwd { lines.append(cwd) }
        if let b = s.gitBranch { lines.append("Branch: \(b)") }
        if !s.models.isEmpty { lines.append("Models: \(s.models.joined(separator: ", "))") }
        if let start = s.start { lines.append(Formatters.timeRange(from: start, to: s.end)) }
        lines.append(s.id)
        if s.isMissingSource {
            lines.append(s.state == "missing-transcript"
                ? "The transcript file is gone; only metadata from the agent's session registry remains."
                : "The source file was deleted; showing the copy kept in the index.")
        }
        return lines.joined(separator: "\n")
    }

    override var backgroundStyle: NSView.BackgroundStyle {
        didSet {
            let emphasized = backgroundStyle == .emphasized
            detail.textColor = emphasized ? .alternateSelectedControlTextColor : .secondaryLabelColor
            errorBadge.isEmphasized = emphasized
        }
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        icon.frame = NSRect(x: 0, y: (h - 16) / 2, width: 16, height: 16)
        liveDot.frame = NSRect(x: 4, y: (h - 8) / 2, width: 8, height: 8)
        var right = bounds.maxX - 4
        if !errorBadge.isHidden {
            let w = errorBadge.intrinsicContentSize.width
            errorBadge.frame = NSRect(x: right - w, y: (h - 15) / 2, width: w, height: 15)
            right -= w + 6
        }
        let dw = ceil(detail.intrinsicContentSize.width)
        detail.frame = NSRect(x: right - dw, y: (h - 14) / 2, width: dw, height: 14)
        right -= dw + 6
        if !alarmIcon.isHidden {
            alarmIcon.frame = NSRect(x: right - 12, y: (h - 12) / 2, width: 12, height: 12)
            right -= 16
        }
        title.frame = NSRect(x: 22, y: (h - 17) / 2, width: max(0, right - 24), height: 17)
    }
}

/// The Live mark: a pulsing accent dot (static when Reduce Motion is on).
final class PulsingDot: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.controlAccentColor.cgColor
        layer?.cornerRadius = 4
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.width / 2
    }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.controlAccentColor.cgColor
    }

    func startAnimating() {
        guard let layer, layer.animation(forKey: "pulse") == nil, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = 1
        a.toValue = 0.35
        a.duration = 1.1
        a.autoreverses = true
        a.repeatCount = .infinity
        a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(a, forKey: "pulse")
    }
}
