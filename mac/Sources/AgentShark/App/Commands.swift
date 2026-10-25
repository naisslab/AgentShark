import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// The menu bar (MAC-SPEC §11). Items drive the key window's `WindowModel`. Shortcuts never take a standard
/// text-editing binding away: when a text view has focus, ⌘⌫, ⌘↑ and ⌘↓ keep their text meaning, and Find
/// goes to the text view's find bar.
struct AgentSharkCommands: Commands {
    let app: AppModel
    @FocusedValue(\.windowModel) private var model: WindowModel?
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some Commands {
        appMenu
        fileMenu
        editMenu
        viewMenu
        goMenu
        failuresMenu
        filterMenu
        analyzeMenu
        helpMenu
    }

    // MARK: App

    /// Settings… also brings the window forward when another app is active (the Dock menu uses the same path).
    @CommandsBuilder private var appMenu: some Commands {
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") {
                NSApp.activate()
                openSettings()
                AppKitHelpers.bringSettingsToFront()
            }
            .keyboardShortcut(",")
        }
    }

    // MARK: File

    @CommandsBuilder private var fileMenu: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Window") { openWindow(value: WindowTarget.newLive()) }
                .keyboardShortcut(AppShortcut.newWindow.shortcut)
            Button("New Tab") { newTab() }
                .keyboardShortcut(AppShortcut.newTab.shortcut)
            Divider()
            Button("Open Capture…") { openCapturePanel() }
                .keyboardShortcut(AppShortcut.openCapture.shortcut)
            Menu("Open Recent") {
                ForEach(app.recentCaptures, id: \.self) { url in
                    Button(url.lastPathComponent) { app.openCapture(url) }
                }
                if !app.recentCaptures.isEmpty { Divider() }
                Button("Clear Menu") { app.clearRecentCaptures() }
                    .disabled(app.recentCaptures.isEmpty)
            }
            Divider()
            Button("Export Capture…") { model?.presentedSheet = .exportCapture }
                .keyboardShortcut(AppShortcut.exportCapture.shortcut)
                .disabled(model == nil || model?.isCapture == true)
            // ⌘R in Events; ⇧⌘R elsewhere, because the Timeline uses ⌘R for Filter to Range.
            Button("Reindex Now") { model?.store.reindex() }
                .keyboardShortcut(model?.workspace == .events ? AppShortcut.reindexEvents.shortcut : AppShortcut.reindex.shortcut)
                .disabled(model == nil || model?.isCapture == true || model?.engine.api == nil || model?.store.isFollowing == true)
        }
    }

    // MARK: Edit

    @CommandsBuilder private var editMenu: some Commands {
        CommandGroup(after: .pasteboard) {
            Button("Copy as JSON") { copyAsJSON() }
                .keyboardShortcut(AppShortcut.copyAsJSON.shortcut)
                .disabled(model?.selectedEvent == nil)
        }
        CommandGroup(replacing: .textEditing) {
            Menu("Find") {
                Button("Find…") { find(.showFindInterface) }
                    .keyboardShortcut(AppShortcut.find.shortcut)
                Button("Find Next") { find(.nextMatch) }
                    .keyboardShortcut(AppShortcut.findNext.shortcut)
                Button("Find Previous") { find(.previousMatch) }
                    .keyboardShortcut(AppShortcut.findPrevious.shortcut)
            }
            Divider()
            Button(selectionIsMarked ? "Unmark" : "Mark") { model?.toggleMark() }
                .keyboardShortcut(AppShortcut.mark.shortcut)
                .disabled(model?.selectedEvent == nil)
            Button("Clear Marks") { model?.clearMarks() }
                .disabled(model?.marks.isEmpty ?? true)
        }
    }

    // MARK: View

    @CommandsBuilder private var viewMenu: some Commands {
        CommandGroup(before: .toolbar) {
            ForEach(Array(app.preferences.workspaceOrder.enumerated()), id: \.element) { i, w in
                Toggle(w.title, isOn: Binding(get: { model?.workspace == w }, set: { if $0 { model?.workspace = w } }))
                    .keyboardShortcut(AppShortcut.workspace(at: i).shortcut)
            }
            .disabled(model == nil)
            Menu("Session Mode") {
                ForEach(SessionMode.allCases, id: \.self) { mode in
                    Toggle(mode.title, isOn: Binding(get: { model?.workspace == .session && model?.sessionMode == mode },
                                                     set: { if $0 { model?.showSessionMode(mode) } }))
                        .keyboardShortcut(Self.modeShortcut(mode).shortcut)
                }
            }
            .disabled(model == nil)
            Divider()
        }
        SidebarCommands()
        CommandGroup(after: .sidebar) {
            Group {
                Toggle("Show Timeline Track", isOn: bind(\.showTimelineTrack, default: true))
                    .keyboardShortcut(AppShortcut.showTimelineTrack.shortcut)
                // ⌥⌘I: the session inspector in Events; the detail outline with the raw pane in Failures and Session.
                Toggle("Show Inspector", isOn: inspectorBinding)
                    .keyboardShortcut(AppShortcut.showInspector.shortcut)
                Divider()
                Picker("Time Column Format", selection: bind(\.timeFormat, default: app.preferences.timeFormat)) {
                    ForEach(TimeFormat.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Picker("Columns", selection: bind(\.columnPreset, default: .standard)) {
                    ForEach(ColumnPreset.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Toggle("Collapse Idle Gaps", isOn: Binding(get: { app.preferences.collapseIdleGaps },
                                                           set: { app.preferences.collapseIdleGaps = $0 }))
                Toggle("Show Context Lane", isOn: Binding(get: { app.preferences.showContextLane },
                                                          set: { app.preferences.showContextLane = $0 }))
                Divider()
                Toggle("Show Inherited Context", isOn: bind(\.showInherited, default: false))
                Toggle("Show Duplicates", isOn: bind(\.showDup, default: false))
            }
            .disabled(model == nil)
            Picker("Appearance", selection: Binding(get: { app.preferences.appearance }, set: { app.preferences.appearance = $0 })) {
                ForEach(Preferences.AppearanceChoice.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            Divider()
        }
    }

    // MARK: Go

    @CommandsBuilder private var goMenu: some Commands {
        CommandMenu("Go") {
            Button("Back") { model?.goBack() }
                .keyboardShortcut(AppShortcut.back.shortcut)
                .disabled(model?.history.canGoBack != true)
            Button("Forward") { model?.goForward() }
                .keyboardShortcut(AppShortcut.forward.shortcut)
                .disabled(model?.history.canGoForward != true)
            Divider()
            Button("Go to Event…") { model?.presentedSheet = .goToEvent }
                .keyboardShortcut(AppShortcut.goToEvent.shortcut)
                .disabled(model?.view == nil)
            Button("Partner Event") { model?.goToPartner() }
                .keyboardShortcut(AppShortcut.partnerEvent.shortcut)
                .disabled(model?.partnerEventID == nil)
            Button("Previous in Turn") { model?.goToNextInTurn(false) }
                .keyboardShortcut(AppShortcut.previousInTurn.shortcut)
                .disabled(model?.eventDetail?.event.turn == nil)
            Button("Next in Turn") { model?.goToNextInTurn(true) }
                .keyboardShortcut(AppShortcut.nextInTurn.shortcut)
                .disabled(model?.eventDetail?.event.turn == nil)
            Button("Next Mark") { model?.nextMark() }
                .keyboardShortcut(AppShortcut.nextMark.shortcut)
                .disabled(model?.marks.isEmpty ?? true)
            Divider()
            Button("Parent Session") { textAware({ $0.moveToBeginningOfDocument(nil) }) { model?.goToParentSession() } }
                .keyboardShortcut(AppShortcut.parentSession.shortcut)
                .disabled(model?.parentSessionID == nil)
            Button("Open Child Session") { textAware({ $0.moveToEndOfDocument(nil) }) { model?.openChildSession() } }
                .keyboardShortcut(AppShortcut.childSession.shortcut)
                .disabled(model?.childSessionID == nil)
            Divider()
            // Session · Compare's regions, through `WindowModel.differenceRegions`.
            Button("Next Difference Region") { model?.goToDifferenceRegion(forward: true) }
                .keyboardShortcut(AppShortcut.nextRegion.shortcut)
                .disabled(model?.canGoToDifferenceRegion(forward: true) != true)
            Button("Previous Difference Region") { model?.goToDifferenceRegion(forward: false) }
                .keyboardShortcut(AppShortcut.previousRegion.shortcut)
                .disabled(model?.canGoToDifferenceRegion(forward: false) != true)
            Divider()
            Button(model?.timeReference == nil ? "Set Time Reference" : "Clear Time Reference") { model?.toggleTimeReference() }
                .keyboardShortcut(AppShortcut.timeReference.shortcut)
                .disabled(model == nil || (model?.timeReference == nil && model?.eventDetail == nil && model?.failures.lensSubjectTime == nil))
        }
    }

    // MARK: Failures (SPEC §12.7 Keyboard)

    @CommandsBuilder private var failuresMenu: some Commands {
        CommandMenu("Failures") {
            Button("Next Failure") { model?.nextFailure(true) }
                .keyboardShortcut(AppShortcut.nextFailure.shortcut)
                .disabled(model?.engine.api == nil)
            Button("Previous Failure") { model?.nextFailure(false) }
                .keyboardShortcut(AppShortcut.previousFailure.shortcut)
                .disabled(model?.engine.api == nil)
            Button("Next Attention Item") { model?.nextAttentionItem() }
                .keyboardShortcut(AppShortcut.nextAttention.shortcut)
                .disabled(model?.engine.api == nil)
            Divider()
            // Before any view's keyDown sees ⌘↩, so the menu routes it by mode.
            Button("Show in Session") { model?.showSelectionInSession() }
                .keyboardShortcut(AppShortcut.showInSession.shortcut)
                .disabled(model?.canShowSelectionInSession != true)
            Button("Show Signature") { model?.showSignature() }
                .keyboardShortcut(AppShortcut.showSignature.shortcut)
                .disabled(model?.subjectSignatureID == nil)
            Button("Follow") { model?.follow() }
                .keyboardShortcut(AppShortcut.follow.shortcut)
                .disabled(model?.followCandidate == nil)
            Button("Copy Report…") { model?.copyReport() }
                .keyboardShortcut(AppShortcut.copyReport.shortcut)
                .disabled(model?.canCopyReport != true)
            Divider()
            ForEach([FailureTier.suspect, .benign, .deferred], id: \.self) { tier in
                Toggle("Include \(tier.rawValue.capitalized)", isOn: Binding(
                    get: { model?.failureFacets.tiers.contains(tier) ?? false },
                    set: { on in
                        guard let model else { return }
                        model.failureFacets.tiers.removeAll { $0 == tier }
                        if on { model.failureFacets.tiers.append(tier) }
                    }))
            }
            .disabled(model == nil)
            Picker("Group By", selection: Binding(get: { model?.failureFacets.group ?? .attention },
                                                  set: { model?.failureFacets.group = $0 })) {
                ForEach(QueueGroup.known, id: \.self) { Text(DerivedStyle.groupTitle($0)).tag($0) }
            }
            .disabled(model == nil)
            Button("Split Signature at Date…") { model?.presentedSheet = .splitSignature }
                .disabled(model?.subjectSignatureID == nil)
        }
    }

    // MARK: Filter

    @CommandsBuilder private var filterMenu: some Commands {
        CommandMenu("Filter") {
            Button("Apply Filter") { model.map { $0.applyFilter($0.filterText) } }
                .disabled(model == nil)
            Button("Clear Filter") { clearFilter() }
                .keyboardShortcut(AppShortcut.clearFilter.shortcut)
                .disabled(model == nil || (model?.appliedFilter.isEmpty == true && model?.filterText.isEmpty == true))
            Button("Filter to Time Range") { model?.filterToInspectionRange() }
                .keyboardShortcut(model?.workspace == .timeline ? AppShortcut.filterToTimeRange.shortcut : Optional<KeyboardShortcut>.none)
                .disabled(model?.inspectionRange == nil)
            Divider()
            Menu("Apply as Filter") {
                ForEach(FilterCombine.allCases, id: \.self) { mode in
                    Button(mode.title) { if let f = model?.selectedFieldFragment { model?.applyFilter(fragment: f, mode: mode) } }
                }
            }
            .disabled(model?.selectedFieldFragment == nil)
            Menu("Prepare as Filter") {
                ForEach(FilterCombine.allCases, id: \.self) { mode in
                    Button(mode.title) { if let f = model?.selectedFieldFragment { model?.prepareFilter(fragment: f, mode: mode) } }
                }
            }
            .disabled(model?.selectedFieldFragment == nil)
            Divider()
            Menu("Filters") {
                Section("Examples") {
                    ForEach(Bookmarks.presets) { b in
                        Button(b.name) { model?.applyFilter(b.filter) }
                    }
                }
                if !app.bookmarks.user.isEmpty {
                    Section("Saved Filters") {
                        ForEach(app.bookmarks.user) { b in
                            Button(b.name) { model?.applyFilter(b.filter) }
                        }
                    }
                }
            }
            .disabled(model == nil)
            Menu("Recent Filters") {
                ForEach(app.preferences.recentFilters, id: \.self) { f in
                    Button(f) { model?.applyFilter(f) }
                }
                Divider()
                Button("Clear Menu") { app.preferences.clearRecentFilters() }
                    .disabled(app.preferences.recentFilters.isEmpty)
            }
            .disabled(model == nil)
            Button("Save Filter…") { model?.presentedSheet = .saveFilter }
                .disabled(model.map { $0.filterText.isEmpty && $0.appliedFilter.isEmpty } ?? true)
        }
    }

    // MARK: Analyze (ANALYSIS-UX §3.3)

    /// The engine analyses that are Session modes, then the other research tools, which need a real browser for their
    /// downloads and file inputs. The modes' keys (⌥⌘4, ⌥⌘5) live on View ▸ Session Mode, since a key binds one item.
    @CommandsBuilder private var analyzeMenu: some Commands {
        CommandMenu("Analyze") {
            ForEach([SessionMode.criticalPath, .compare], id: \.self) { mode in
                Button(mode.commandTitle) { model?.showSessionMode(mode) }
                    .disabled(model == nil)
            }
            Divider()
            Button("Open Research Tools in Browser") { ResearchTools.open(engine: app.liveEngine) }
                .disabled(app.liveEngine.endpoint == nil)
            Button("Explore Bundled Demo") { openWindow(id: "demo-workbench") }
        }
    }

    // MARK: Help

    @CommandsBuilder private var helpMenu: some Commands {
        CommandGroup(replacing: .help) {
            Button("Getting Started") { model?.presentedSheet = .gettingStarted }
            Button("Filter Reference") { model?.presentedSheet = .filterSyntax }
            Button("Keyboard Shortcuts") { model?.presentedSheet = .keyboardShortcuts }
        }
    }

    // MARK: Actions

    private func bind<T>(_ keyPath: ReferenceWritableKeyPath<WindowModel, T>, default value: T) -> Binding<T> {
        Binding(get: { model?[keyPath: keyPath] ?? value }, set: { model?[keyPath: keyPath] = $0 })
    }

    static func modeShortcut(_ mode: SessionMode) -> AppShortcut {
        switch mode {
        case .steps: return .sessionSteps
        case .transcript: return .sessionTranscript
        case .flow: return .sessionFlow
        case .criticalPath: return .sessionCriticalPath
        case .compare: return .sessionCompare
        }
    }

    /// ⌥⌘I: the session inspector in Events and the other workspaces; the detail and raw panes in Failures and Session.
    private var inspectorBinding: Binding<Bool> {
        Binding(get: { model?.inspectorShown ?? false }, set: { model?.inspectorShown = $0 })
    }

    private var selectionIsMarked: Bool {
        guard let model, let id = model.selectedEvent else { return false }
        return model.marks.contains(id)
    }

    /// Keep the standard text binding when a text view (or a text field's editor) has focus.
    private func textAware(_ text: (NSTextView) -> Void, else action: () -> Void) {
        if let tv = AppKitHelpers.editingTextView { text(tv) } else { action() }
    }

    private func clearFilter() {
        guard let model else { return }
        if !model.filterFieldIsFocused, let tv = AppKitHelpers.editingTextView {
            tv.deleteToBeginningOfLine(nil)
            return
        }
        model.clearFilter()
    }

    private func copyAsJSON() {
        if !AppKitHelpers.sendAction(#selector(AgentSharkResponderActions.copyAsJSON(_:))) {
            model?.copySelectedEventAsJSON()
        }
    }

    /// Find goes to a text view's find bar when one has focus, otherwise to the event find bar.
    private func find(_ action: NSTextFinder.Action) {
        if let tv = AppKitHelpers.editingTextView, !tv.isFieldEditor, tv.usesFindBar || tv.usesFindPanel {
            AppKitHelpers.sendAction(#selector(NSResponder.performTextFinderAction(_:)), tag: action.rawValue)
            return
        }
        guard let model else { return }
        switch action {
        case .showFindInterface: model.showFindBar()
        case .nextMatch: model.find(model.findQuery, forward: true)
        case .previousMatch: model.find(model.findQuery, forward: false)
        default: break
        }
    }

    private func newTab() {
        let current = NSApp.keyWindow
        openWindow(value: WindowTarget.newLive())
        guard let current else { return }
        // The new window becomes key on the next turn of the run loop; then tab it into the current window.
        DispatchQueue.main.async {
            guard let new = NSApp.keyWindow, new !== current, current.tabbedWindows?.contains(new) != true else { return }
            current.addTabbedWindow(new, ordered: .above)
            new.makeKeyAndOrderFront(nil)
        }
    }

    private func openCapturePanel() {
        let panel = NSOpenPanel()
        panel.title = "Open Capture"
        panel.prompt = "Open"
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = CaptureTypes.openable
        panel.begin { response in
            guard response == .OK else { return }
            for url in panel.urls { app.openCapture(url) }
        }
    }
}

/// Uniform types for capture files (declared in Info.plist by build-app.sh).
enum CaptureTypes {
    static let capture = UTType(exportedAs: "dev.agentshark.capture", conformingTo: .data)
    static var openable: [UTType] {
        [capture, UTType(filenameExtension: "zst"), .gzip].compactMap { $0 }
    }
}
