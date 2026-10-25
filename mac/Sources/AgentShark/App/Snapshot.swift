import AppKit
import SwiftUI

/// `AgentShark --snapshot <dir>`: the MAC-SPEC §12 screenshot set, drawn offscreen into `<dir>`.
///
/// Each workspace is drawn in light and dark at 1440×900 and 1280×800 by asking the window's views to draw into a
/// bitmap (`cacheDisplay`). No screen capture is involved, so it works while the screen is locked, and the window
/// sits far off every screen. Settings live in memory; AGENTSHARK_HOME, AGENTSHARK_ENGINE_SOURCE and AGENTSHARK_NODE
/// choose the index, the engine checkout and Node as for `--self-test`. Prints one JSON object with structure only
/// (shot names, sizes, waits) and exits 0 when every shot was written.
///
/// Run the SwiftPM binary (`scripts/snapshot.sh`), never the app bundle: views keep UI state such as split positions
/// in the standard defaults of the running binary, and the bundle's defaults are the person's settings.
@MainActor enum Snapshot {
    static let sizes: [(name: String, size: NSSize)] = [("1440x900", NSSize(width: 1440, height: 900)), ("1280x800", NSSize(width: 1280, height: 800))]
    static let appearances: [(name: String, appearance: NSAppearance.Name)] = [("light", .aqua), ("dark", .darkAqua)]
    /// Far off every screen, so a window never appears even when the screen unlocks mid-run.
    static let offscreen = NSPoint(x: -30_000, y: -30_000)
    /// UI state the views keep in `@AppStorage` (the Statistics section, the Tools grouping).
    static let storage = UserDefaults(suiteName: "dev.agentshark.snapshot") ?? .standard

    /// One workspace state to draw.
    struct Shot {
        let name: String
        /// Least time to let loads that expose no state (Timeline, Statistics panels) finish.
        var settle: Double = 1.5
        /// Build the workspace's views anew, with no saved split positions, so a pane `prepare` opens is laid out open
        /// from the start. Opening a collapsed pane animates, and an offscreen window never finishes the animation: the
        /// pane would stay zero wide.
        var fresh = false
        let prepare: @MainActor (WindowModel) -> Void
        /// The data the shot shows has arrived; checked until it holds or the timeout passes.
        var ready: @MainActor (WindowModel) -> Bool = { _ in true }
    }

    static let shots: [Shot] = [
        // The default layouts (DESIGN.md §8.2): the inspector is hidden in Failures and Session · Steps.
        Shot(name: "failures-lens", prepare: { m in
            m.workspace = .failures
            m.showDerivedInspector = false
        }, ready: { m in m.failures.phase == .ready && (m.lensItem == nil || m.failures.lens.phase == .ready) }),
        Shot(name: "session-steps", prepare: { m in showSteps(m, inspector: false) },
             ready: { m in m.steps.phase == .ready && (m.steps.report != nil || m.steps.reportError != nil) }),
        // ⌥⌘I beside Steps: the P4 and P3 columns hide and the header says how many (§4.4).
        Shot(name: "session-steps-inspector", settle: 1, fresh: true, prepare: { m in showSteps(m, inspector: true) },
             ready: { m in m.steps.phase == .ready }),
        Shot(name: "timeline", settle: 4, prepare: { m in m.workspace = .timeline }),
        Shot(name: "stats-tools", settle: 4, prepare: { m in
            storage.set(StatsSection.tools.rawValue, forKey: "stats.section")
            m.workspace = .stats
        }, ready: { m in m.view != nil && !m.isBuildingView }),
        Shot(name: "diagnostics", settle: 3, prepare: { m in m.workspace = .diagnostics }, ready: { m in m.view != nil && !m.isBuildingView }),
        Shot(name: "events", settle: 2, prepare: { m in m.workspace = .events }, ready: { m in m.view != nil && !m.isBuildingView }),
        Shot(name: "sources", settle: 3, prepare: { m in m.workspace = .sources }),
        // Follow in the Lens column (§7.9): the selected attempt's call, with its stages.
        Shot(name: "failures-follow", settle: 2.5, prepare: { m in
            m.workspace = .failures
            m.showDerivedInspector = false
        }, ready: { m in
            if m.followTarget == nil, m.failures.lens.phase == .ready { m.follow() }
            return m.followTarget != nil
        }),
        // Follow in the Steps inspector region, the layout that clipped the header at 1280 (DS1-04).
        Shot(name: "session-steps-follow", settle: 2.5, prepare: { m in
            if m.followTarget == nil { m.followTarget = m.failures.followCandidate }
            showSteps(m, inspector: true)
        }, ready: { m in m.steps.phase == .ready && m.followTarget != nil }),
        Shot(name: "stats-io", settle: 4, prepare: { m in
            m.followTarget = nil
            storage.set(StatsSection.io.rawValue, forKey: "stats.section")
            m.workspace = .stats
        }, ready: { m in m.view != nil && !m.isBuildingView }),
        Shot(name: "stats-summary", settle: 4, prepare: { m in
            storage.set(StatsSection.summary.rawValue, forKey: "stats.section")
            m.workspace = .stats
        }, ready: { m in m.view != nil && !m.isBuildingView }),
        // Performance over time (SPEC §6): headline figures and the lanes on one collapsed time axis.
        Shot(name: "stats-performance", settle: 4, prepare: { m in
            storage.set(StatsSection.performance.rawValue, forKey: "stats.section")
            m.workspace = .stats
        }, ready: { m in m.view != nil && !m.isBuildingView }),
        // Group by Signature with the top signature's Lens (§7.7 Signature).
        Shot(name: "failures-signatures", settle: 2.5, prepare: { m in
            m.followTarget = nil
            m.workspace = .failures
            m.failureFacets.group = .signature
        }, ready: { m in
            guard m.failures.phase == .ready else { return false }
            if m.failures.selectedRow?.kind != .signature, let top = m.failures.displayOrder.first { m.failures.select(top) }
            return m.failures.selectedRow?.kind == .signature
        }),
        // The faceted scope label and section counts: the whole index narrowed to one family.
        Shot(name: "failures-family", prepare: { m in
            m.resetScope()
            m.failureFacets.group = .attention
            m.failureFacets.families = ["sandbox"]
            m.workspace = .failures
        }, ready: { m in m.failures.phase == .ready && m.failures.facetedSections != nil && (m.lensItem == nil || m.failures.lens.phase == .ready) }),

        // Session · Critical Path (ANALYSIS-UX §4) of a run with two subagents and a workflow agent, nothing selected.
        // Every analysis shot with a result also waits until its detail and raw panes are open exactly when the
        // Inspector box is checked, so a pane the split view restored against the model is reported as not ready.
        Shot(name: "critical-path", settle: 2, prepare: { m in open(m, testsRun, mode: .criticalPath) }, ready: { m in
            guard open(m, testsRun, mode: .criticalPath), perfShown(m) else { return false }
            CriticalPathModel.of(m).selection = nil
            return inspectorFollowsModel(m, panes: criticalPathPanes)
        }),
        // The longest segment that has an event, with its detail and raw panes beside the path (§4.10).
        Shot(name: "critical-path-selected", settle: 2, fresh: true, prepare: { m in open(m, testsRun, mode: .criticalPath, inspector: true) }, ready: { m in
            guard open(m, testsRun, mode: .criticalPath, inspector: true), perfShown(m), let r = m.analyses.perf.value, let key = m.analyses.perf.key else { return false }
            let cp = CriticalPathModel.of(m)
            let content = cp.content(r, key: key)
            if cp.selection == nil, let i = content.path.segments.indices.filter({ !content.path.segments[$0].evidence.isEmpty })
                .max(by: { content.path.segments[$0].us < content.path.segments[$1].us }) {
                cp.select(.segment(i), in: content)
            }
            return cp.selection != nil && m.selectedEvent != nil && m.eventDetail?.event.id == m.selectedEvent
                && inspectorFollowsModel(m, panes: criticalPathPanes)
        }),
        // Measured results the synthetic sample cannot produce (§4.6 Not established, §4.5 partial window), placed in
        // the window's analysis cache.
        Shot(name: "critical-path-not-established", settle: 2, prepare: { m in showFixture(m, perf: "perf-v1.1-measured-unexplained") },
             ready: { m in perfShown(m) && inspectorFollowsModel(m, panes: criticalPathPanes) }),
        Shot(name: "critical-path-partial-window", settle: 2, prepare: { m in showFixture(m, perf: "perf-v1.1-measured-partial") },
             ready: { m in perfShown(m) && inspectorFollowsModel(m, panes: criticalPathPanes) }),
        // The partial window beside the inspector: the narrower track draws the short form of the segment-cap sentence.
        Shot(name: "critical-path-partial-window-inspector", settle: 2, fresh: true,
             prepare: { m in showFixture(m, perf: "perf-v1.1-measured-partial", inspector: true) },
             ready: { m in perfShown(m) && inspectorFollowsModel(m, panes: criticalPathPanes) }),

        // Session · Compare (§5) of two top-level runs with subagents.
        Shot(name: "compare", settle: 2, prepare: { m in compare(m) }, ready: { m in
            compare(m) && compareShown(m) && inspectorFollowsModel(m, panes: comparePanes)
        }),
        // No pair of the sample has a same row, so Only Differences shows on a measured pair that has them.
        Shot(name: "compare-only-differences", settle: 2, prepare: { m in showFixture(m, diff: "diff-v1.1-measured-anchor", onlyDifferences: true) },
             ready: { m in compareShown(m) && inspectorFollowsModel(m, panes: comparePanes) }),
        // A paired row whose outcomes differ, its action in the detail and raw panes beside the alignment, under the
        // A | B control (§5.12); at 1280 the Runs grid folds into its line in the narrower pane.
        Shot(name: "compare-selected", settle: 2, fresh: true, prepare: { m in compare(m, inspector: true) }, ready: { m in
            guard compare(m, inspector: true), compareShown(m), inspectorFollowsModel(m, panes: comparePanes) else { return false }
            let model = CompareModel.of(m)
            if model.selectedRow == nil, let item = pairedRow(model, .outcomeDiffers) ?? pairedRow(model, .objectDiffers) {
                model.select(item, scroll: true)
            }
            return model.selectedRow != nil && m.selectedEvent != nil && m.eventDetail?.event.id == m.selectedEvent
        }),
        // One run in scope: the run chooser (§5.2).
        Shot(name: "compare-chooser", settle: 2, prepare: { m in open(m, testsRun, mode: .compare) }, ready: { m in
            guard open(m, testsRun, mode: .compare), case .oneRun(_, withOwnSubagent: false) = m.compareScope else { return false }
            return true
        }),
        // A run and its own subagent: the chooser says Compare aligns two separate runs (§5.1).
        Shot(name: "compare-blocked", settle: 2, prepare: { m in openWithSubagent(m) }, ready: { m in openWithSubagent(m) }),

        // The entry points (§3): the run report's Critical Path, the scope bar's Compare 2 Runs, the inspector's rows.
        Shot(name: "steps-run-report", settle: 1.5, prepare: { m in open(m, testsRun, mode: .steps) }, ready: { m in
            guard open(m, testsRun, mode: .steps) else { return false }
            return m.steps.phase == .ready && m.steps.sessionID == m.focusedSessionID && m.steps.report != nil
        }),
        Shot(name: "scope-compare-button", settle: 2, prepare: { m in openPairInEvents(m) }, ready: { m in
            openPairInEvents(m) && m.view != nil && !m.isBuildingView
        }),
        Shot(name: "inspector-analysis-rows", settle: 2.5, prepare: { m in openInEvents(m, testsRun) }, ready: { m in
            openInEvents(m, testsRun) && m.view != nil && !m.isBuildingView
        }),
        // The same entry points in a narrow pane: the session inspector beside Steps shrinks the run report strip, and
        // beside Events, with a time reference, the scope bar drops Compare 2 Runs and folds its tokens into "+2 more".
        Shot(name: "steps-run-report-narrow", settle: 1.5, fresh: true, prepare: { m in open(m, testsRun, mode: .steps, sessionInspector: true) }, ready: { m in
            guard open(m, testsRun, mode: .steps, sessionInspector: true) else { return false }
            return m.steps.phase == .ready && m.steps.sessionID == m.focusedSessionID && m.steps.report != nil
        }),
        Shot(name: "scope-bar-folded", settle: 2, fresh: true, prepare: { m in foldScopeBar(m) }, ready: { m in
            foldScopeBar(m) && m.view != nil && !m.isBuildingView
        }),
        // Events ▸ Show in Critical Path on a subagent's event: the path of the whole run, with the segment that holds
        // the event selected (§4.10).
        Shot(name: "critical-path-from-subagent-event", settle: 2, fresh: true, prepare: { m in showSubagentEventInCriticalPath(m) }, ready: { m in
            guard showSubagentEventInCriticalPath(m), perfShown(m), inspectorFollowsModel(m, panes: criticalPathPanes) else { return false }
            let cp = CriticalPathModel.of(m)
            return cp.selection != nil || cp.notOnPath != nil
        }),
        // A Refresh in flight (§4.1): the path on screen stays under the bar with its spinner until the new one arrives.
        // Last of the analysis shots, so no other shot sees the held Refresh.
        Shot(name: "critical-path-refreshing", settle: 2, fresh: true, prepare: { m in open(m, testsRun, mode: .criticalPath) }, ready: { m in
            guard open(m, testsRun, mode: .criticalPath), perfShown(m), inspectorFollowsModel(m, panes: criticalPathPanes) else { return false }
            CriticalPathModel.of(m).selection = nil
            return holdRefresh(m)
        }),
    ]

    // MARK: Analysis shots

    /// The synthetic sample's Claude Code run with two subagents and a workflow agent.
    static let testsRun = "Run the tests"
    /// The synthetic sample's Codex run with a subagent that Compare aligns with `testsRun`.
    static let repoRun = "Check the repo state"
    /// `testsRun`'s own subagent.
    static let testsSubagent = "run integration tests"

    /// A synthetic-sample session by title; nil until the catalog lists it.
    static func session(_ m: WindowModel, _ title: String) -> String? {
        m.sessions.first { $0.displayTitle == title }?.id
    }

    /// Start from a clean window: no Follow, no session inspector, no selected event, no scope, filter or time reference.
    static func clear(_ m: WindowModel) {
        m.followTarget = nil
        m.showInspector = false
        m.resetScope()
        m.timeReference = nil
        m.selectedEvent = nil
    }

    /// Scope `title`'s run alone in Session ▸ `mode`, with the derived and session inspectors as given; false until the
    /// catalog lists the run. It changes the window only when it is not already there, so `ready` can call it again.
    @discardableResult static func open(_ m: WindowModel, _ title: String, mode: SessionMode, inspector: Bool = false,
                                        sessionInspector: Bool = false) -> Bool {
        guard let id = session(m, title) else { return false }
        if m.scope.sessions != [id] || m.workspace != .session || m.sessionMode != mode {
            clear(m)
            m.openSession(id, mode: mode)
        }
        if m.showDerivedInspector != inspector { m.showDerivedInspector = inspector }
        if m.showInspector != sessionInspector { m.showInspector = sessionInspector }
        return true
    }

    /// The Critical Path result of the focused session has arrived.
    static func perfShown(_ m: WindowModel) -> Bool {
        guard let id = m.focusedSessionID, m.analyses.perf.key == AnalysisSpec.perf(session: id).key else { return false }
        return m.analyses.perf.value?.sessionId == id
    }

    /// The split views that hold each analysis's detail and raw panes (`SplitPane` "inspect", the second item).
    static let criticalPathPanes = "AgentShark.CriticalPathPanes"
    static let comparePanes = "AgentShark.ComparePanes"

    /// The analysis's detail and raw panes are open exactly when the Inspector box is checked.
    static func inspectorFollowsModel(_ m: WindowModel, panes name: String) -> Bool {
        guard let split = splitView(named: name, in: m.hostWindow?.contentView), split.arrangedSubviews.count > 1 else { return false }
        return split.isSubviewCollapsed(split.arrangedSubviews[1]) == !m.showDerivedInspector
    }

    static func splitView(named name: String, in view: NSView?) -> NSSplitView? {
        guard let view else { return nil }
        if let split = view as? NSSplitView, split.autosaveName == name { return split }
        return view.subviews.lazy.compactMap { splitView(named: name, in: $0) }.first
    }

    /// Hold the shown Critical Path result in a Refresh, as Refresh does while the engine computes: its key loads again
    /// with the result kept on screen, and the load returns the same result long after the shot is drawn.
    static func holdRefresh(_ m: WindowModel) -> Bool {
        let perf = m.analyses.perf
        guard let key = perf.key, let r = perf.value else { return false }
        if !perf.isRefreshing {
            m.panels.request(key, PerfResult.self).load(key: key, force: true, keepValue: true) {
                try await Task.sleep(for: .seconds(30))
                return r
            }
        }
        return perf.isRefreshing
    }

    /// Show a test fixture's Critical Path result: it goes into the window's analysis cache under the key the view
    /// asks for, so the view shows it without a request, and its run is scoped. The run is not in the index, so the scope
    /// bar names it by its id.
    static func showFixture(_ m: WindowModel, perf name: String, inspector: Bool = false) {
        guard let r = fixture(name, PerfResult.self) else { return }
        let key = AnalysisSpec.perf(session: r.sessionId).key
        m.panels.request(key, PerfResult.self).load(key: key, force: true) { r }
        clear(m)
        m.openSession(r.sessionId, mode: .criticalPath)
        m.showDerivedInspector = inspector
    }

    /// Show a test fixture's Compare result for its two runs, as `showFixture(_:perf:)` does.
    static func showFixture(_ m: WindowModel, diff name: String, onlyDifferences: Bool) {
        guard let r = fixture(name, DiffResult.self) else { return }
        clear(m)
        m.compareRuns(r.left.session, r.right.session)
        m.setCompareSides(a: r.left.session, b: r.right.session)
        m.showDerivedInspector = false
        CompareModel.of(m).filter.onlyDifferences = onlyDifferences
        guard let sides = m.compareSides else { return }
        let key = AnalysisSpec<DiffResult>.diff(left: sides.a, right: sides.b, children: m.compare.subagents, limit: m.compare.limit).key
        m.panels.request(key, DiffResult.self).load(key: key, force: true) { r }
    }

    /// A result from `mac/Tests/AgentSharkTests/Fixtures/workbench` of this checkout.
    static func fixture<T: Decodable>(_ name: String, _ type: T.Type) -> T? {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Tests/AgentSharkTests/Fixtures/workbench/\(name).json")
        do {
            return try APIClient.decode(type, from: Data(contentsOf: url))
        } catch {
            FileHandle.standardError.write(Data("snapshot: cannot read the fixture \(url.path): \(error.localizedDescription)\n".utf8))
            return nil
        }
    }

    /// Compare `testsRun` with `repoRun`, every row shown, with the derived inspector as given; false until the catalog
    /// lists both.
    @discardableResult static func compare(_ m: WindowModel, inspector: Bool = false) -> Bool {
        guard let a = session(m, testsRun), let b = session(m, repoRun) else { return false }
        if Set(m.scope.sessions) != [a, b] || !m.isComparing {
            clear(m)
            m.compareRuns(a, b)
        }
        if m.showDerivedInspector != inspector { m.showDerivedInspector = inspector }
        let model = CompareModel.of(m)
        if model.filter.onlyDifferences { model.filter.onlyDifferences = false }
        return true
    }

    /// The first table row whose aligned row has `status` and an action on both sides.
    static func pairedRow(_ model: CompareModel, _ status: AlignmentStatus) -> AlignmentItem? {
        guard let result = model.result else { return nil }
        return model.items.first { item in
            guard let p = item.rowPosition, result.alignment.indices.contains(p) else { return false }
            let row = result.alignment[p]
            return row.status == status && row.left != nil && row.right != nil
        }
    }

    /// The alignment of the scoped pair shows.
    static func compareShown(_ m: WindowModel) -> Bool {
        let model = CompareModel.of(m)
        return m.analyses.diff.value != nil && model.result != nil && model.key == m.analyses.diff.key
    }

    /// `testsRun`'s subagent `testsSubagent`; nil until the catalog lists both.
    static func subagent(_ m: WindowModel) -> (run: String, sub: String)? {
        guard let run = session(m, testsRun), let sub = m.sessions.first(where: { $0.displayTitle == testsSubagent && $0.parentId == run })?.id else { return nil }
        return (run, sub)
    }

    /// `testsRun` with its own subagent `testsSubagent` in Session ▸ Compare.
    @discardableResult static func openWithSubagent(_ m: WindowModel) -> Bool {
        guard case let (run, sub)? = subagent(m) else { return false }
        if m.scope.sessions != [run, sub] || !m.isComparing {
            clear(m)
            m.openSessions([run, sub])
            m.showSessionMode(.compare)
        }
        if m.showDerivedInspector { m.showDerivedInspector = false }
        return true
    }

    /// `testsRun` and `repoRun` scoped in Events, with the session inspector as given.
    @discardableResult static func openPairInEvents(_ m: WindowModel, sessionInspector: Bool = false) -> Bool {
        guard let a = session(m, testsRun), let b = session(m, repoRun) else { return false }
        if m.scope.sessions != [a, b] || m.workspace != .events {
            clear(m)
            m.openSessions([a, b])
            m.workspace = .events
        }
        if m.showInspector != sessionInspector { m.showInspector = sessionInspector }
        return true
    }

    /// The pair in Events beside the session inspector, with a time reference at `testsRun`'s start, so the scope bar
    /// has more tokens than room.
    @discardableResult static func foldScopeBar(_ m: WindowModel) -> Bool {
        guard openPairInEvents(m, sessionInspector: true), let start = m.sessions.first(where: { $0.displayTitle == testsRun })?.start else { return false }
        if m.timeReference != start { m.timeReference = start }
        return true
    }

    /// The subagent event Events ▸ Show in Critical Path starts from, once its rows are fetched; nil before.
    private static var subagentEvent: EventRow?
    private static var fetchingSubagentEvent = false

    /// Events ▸ Show in Critical Path on `testsSubagent`'s first Bash call, as the row menu does it: scope the subagent
    /// in Events, fetch its rows, then show the call on its run's path with the derived inspector open. False until the
    /// path's mode shows; `ready` calls it again until then.
    @discardableResult static func showSubagentEventInCriticalPath(_ m: WindowModel) -> Bool {
        guard case let (run, sub)? = subagent(m) else { return false }
        if !m.showDerivedInspector { m.showDerivedInspector = true }
        if let e = subagentEvent {
            if m.scope.sessions != [run] || m.workspace != .session || m.sessionMode != .criticalPath {
                EventTableController.show(event: e.id, session: e.session, in: .session, mode: .criticalPath, model: m)
            }
            return m.selectedEvent == e.id
        }
        if m.scope.sessions != [sub] || m.workspace != .events {
            clear(m)
            m.openSession(sub, workspace: .events)
            return false
        }
        guard !fetchingSubagentEvent, !m.isBuildingView, let view = m.view?.viewId, let api = m.engine.api else { return false }
        fetchingSubagentEvent = true
        Task { @MainActor in
            defer { fetchingSubagentEvent = false }
            let rows = (try? await api.rows(view: view, offset: 0, limit: 500)) ?? []
            subagentEvent = rows.first { $0.session == sub && $0.kind == .toolCall && $0.toolName == "Bash" }
        }
        return false
    }

    /// `title`'s run scoped in Events with the session inspector open.
    @discardableResult static func openInEvents(_ m: WindowModel, _ title: String) -> Bool {
        guard let id = session(m, title) else { return false }
        if m.scope.sessions != [id] || m.workspace != .events {
            clear(m)
            m.openSession(id, workspace: .events)
        }
        if !m.showInspector { m.showInspector = true }
        return true
    }

    static func run(arguments: [String]) -> Never {
        guard let i = arguments.firstIndex(of: "--snapshot"), arguments.indices.contains(i + 1) else {
            FileHandle.standardError.write(Data("usage: AgentShark --snapshot <dir>\n".utf8))
            exit(2)
        }
        if Bundle.main.bundleIdentifier == "dev.agentshark.app" {
            FileHandle.standardError.write(Data("--snapshot runs from the SwiftPM binary (scripts/snapshot.sh), not the app bundle, so it never writes the app's settings.\n".utf8))
            exit(2)
        }
        let dir = URL(fileURLWithPath: arguments[i + 1], isDirectory: true)
        NSApplication.shared.setActivationPolicy(.accessory)
        Task { @MainActor in
            let code = await perform(dir: dir)
            exit(code)
        }
        NSApplication.shared.run()
        exit(1)
    }

    static func perform(dir: URL) async -> Int32 {
        let env = ProcessInfo.processInfo.environment
        let timeout = Double(env["AGENTSHARK_SNAPSHOT_TIMEOUT"] ?? "") ?? 180
        var report: JSONObject = ["dir": .string(dir.path), "screenLocked": .bool(screenLocked), "notes": .array([
            "Selected list rows and the selected toolbar segment are drawn with a plain inactive-selection fill: offscreen drawing cannot render their materials.",
            "The engine does not watch sources (it never takes over the index), so the toolbar reads Connected · manual refresh.",
        ].map(JSONValue.string))]
        var written: [JSONValue] = []
        var failed: [JSONValue] = []
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            print(JSONValue.object(["ok": .bool(false), "error": .string(error.localizedDescription)]).prettyPrinted)
            return 1
        }

        // Start from the default layouts (DESIGN.md §8.2): forget the column and split positions earlier runs of this
        // binary saved. This is the SwiftPM binary's own defaults domain, never the app's (checked in `run`).
        let ui = UserDefaults.standard
        for key in ui.dictionaryRepresentation().keys
        where key.hasPrefix("NSTableView Columns") || key.hasPrefix("NSTableView Sort Ordering")
            || key == "AgentShark.EventTable.autoHidden" || key == "AgentShark.StepsHiddenColumns" || key == "AgentShark.runReportCollapsed" {
            ui.removeObject(forKey: key)
        }
        forgetSplitPositions(in: ui)

        let prefs = Preferences(defaults: nil)
        if let src = env["AGENTSHARK_ENGINE_SOURCE"] { prefs.engineSourcePath = src }
        if let node = env["AGENTSHARK_NODE"] { prefs.nodeOverridePath = node }
        let app = AppModel(preferences: prefs, defaults: nil)
        app.liveEngine.watchesSources = false
        let m = app.makeWindowModel(for: .newLive())
        let started = Date()
        guard await wait(timeout, { m.engine.api != nil && m.info != nil }) else {
            report["ok"] = .bool(false)
            report["error"] = .string("The engine did not become ready within \(Int(timeout)) s")
            report["engineLog"] = .array(m.engine.logTail.suffix(10).map(JSONValue.string))
            print(JSONValue.object(report).prettyPrinted)
            return 1
        }
        report["engineReadyMs"] = .number((Date().timeIntervalSince(started) * 1000).rounded())

        let window = makeWindow(MainWindow(model: m), toolbarStyle: .unified)
        m.hostWindow = window
        // The launch entry rule (SPEC §12.7) may move the window to Failures; let it land before the first shot.
        _ = await wait(10) { m.entryChecked }
        try? await Task.sleep(for: .seconds(2))
        let only = env["AGENTSHARK_SNAPSHOT_SHOTS"].map { Set($0.split(separator: ",").map(String.init)) }
        for shot in shots where only?.contains(shot.name) ?? true {
            if shot.fresh {
                m.workspace = m.workspace == .sources ? .events : .sources
                try? await Task.sleep(for: .milliseconds(500))
                forgetSplitPositions(in: ui)
            }
            shot.prepare(m)
            let t = Date()
            let ready = await wait(timeout) { shot.ready(m) }
            try? await Task.sleep(for: .seconds(shot.settle))
            for size in sizes {
                window.setFrame(NSRect(origin: offscreen, size: size.size), display: true)
                for look in appearances {
                    NSApplication.shared.appearance = NSAppearance(named: look.appearance)
                    try? await Task.sleep(for: .milliseconds(700))
                    let name = "mac-\(shot.name)-\(size.name)-\(look.name).png"
                    if write(window, to: dir.appendingPathComponent(name)) { written.append(.string(name)) } else { failed.append(.string(name)) }
                }
            }
            report[shot.name] = .object(["ready": .bool(ready), "waitMs": .number((Date().timeIntervalSince(t) * 1000).rounded())])
        }
        window.close()

        // Settings ▸ Alerts and Appearance at their own heights, in both appearances. The hosting view reports no
        // fitting size before its first layout, so measure the SwiftUI content itself.
        for (tab, tabName) in [(SettingsView.Tab.general, "general"), (.alerts, "alerts"), (.appearance, "appearance")] {
            let settings = makeWindow(SettingsView(app: app, tab: tab), toolbarStyle: .preference)
            // A pane sizes to its content (§7.17): measure the pane alone, then add the window's tab bar.
            let pane = NSHostingController(rootView: AnyView(SettingsView.pane(tab, app: app).defaultAppStorage(storage)))
            let measured = pane.sizeThatFits(in: NSSize(width: 600, height: 2000))
            let chrome = settings.frame.height - settings.contentLayoutRect.height
            settings.setContentSize(NSSize(width: max(600, measured.width), height: Self.settingsHeight(measured.height) + chrome))
            settings.contentView?.layoutSubtreeIfNeeded()
            settings.makeFirstResponder(nil)
            // Let the tab bar's glass platter settle: drawn sooner, it is a 1 pt circle behind "General" (snapshot.sh).
            try? await Task.sleep(for: .milliseconds(700))
            for look in appearances {
                NSApplication.shared.appearance = NSAppearance(named: look.appearance)
                try? await Task.sleep(for: .milliseconds(700))
                let name = "mac-settings-\(tabName)-\(look.name).png"
                if write(settings, to: dir.appendingPathComponent(name)) { written.append(.string(name)) } else { failed.append(.string(name)) }
            }
            settings.close()
        }

        m.engine.terminateForQuit()
        storage.removePersistentDomain(forName: "dev.agentshark.snapshot")
        report["written"] = .array(written)
        report["failed"] = .array(failed)
        report["ok"] = .bool(failed.isEmpty)
        print(JSONValue.object(report).prettyPrinted)
        return failed.isEmpty ? 0 : 1
    }

    /// Forget the split positions the binary's views saved, so the next split views take their initial sizes.
    static func forgetSplitPositions(in ui: UserDefaults) {
        for key in ui.dictionaryRepresentation().keys where key.hasPrefix("NSSplitView Subview Frames") { ui.removeObject(forKey: key) }
    }

    /// The selected failure's session in Steps, so either Steps shot also runs alone.
    static func showSteps(_ m: WindowModel, inspector: Bool) {
        if m.workspace != .session { if m.lensItem != nil { m.showInSession() } else { m.workspace = .session } }
        m.sessionMode = .steps
        m.showDerivedInspector = inspector
    }

    /// A Settings pane's height: what its content measures, at most 900 pt (520 when it measures nothing).
    static func settingsHeight(_ measured: CGFloat?) -> CGFloat {
        guard let measured, measured > 1, measured.isFinite else { return 520 }
        return min(900, measured.rounded(.up))
    }

    /// A titled window off every screen, hosting `root` with the snapshot's `@AppStorage`; the SwiftUI toolbar and
    /// title become the window's.
    static func makeWindow(_ root: some View, toolbarStyle: NSWindow.ToolbarStyle) -> NSWindow {
        let host = NSHostingController(rootView: AnyView(root.defaultAppStorage(storage)))
        host.sizingOptions = []
        host.sceneBridgingOptions = [.toolbars, .title]
        let window = OffscreenWindow(contentRect: NSRect(origin: offscreen, size: sizes[0].size),
                                     styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                     backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = host
        window.toolbarStyle = toolbarStyle
        window.titleVisibility = toolbarStyle == .unified ? .hidden : .visible
        window.setFrameOrigin(offscreen)
        window.orderFrontRegardless()
        return window
    }

    /// Draws the whole window (title bar and toolbar included) at 2× into a PNG.
    static func write(_ window: NSWindow, to url: URL) -> Bool {
        guard let view = window.contentView?.superview ?? window.contentView else { return false }
        view.layoutSubtreeIfNeeded()
        let restore = standInForWindowServerLayers(in: view)
        defer { restore() }
        let bounds = view.bounds
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(bounds.width * 2), pixelsHigh: Int(bounds.height * 2),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else { return false }
        rep.size = bounds.size
        view.cacheDisplay(in: bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: url)) != nil
    }

    /// `cacheDisplay` cannot draw what the window server composites (portal layers, selection materials, the glass
    /// of a selected segment, the blur behind a table header), so those parts come out as black or white blocks or let
    /// the rows under a header show through. While drawing, hide the portals, stand a plain inactive-selection fill in
    /// for each selection material and selected toolbar segment (whose label then draws like the others), and an
    /// opaque table background behind each table header; the returned closure undoes it.
    static func standInForWindowServerLayers(in root: NSView) -> () -> Void {
        var undo: [() -> Void] = []
        var fill: CGColor = NSColor.unemphasizedSelectedContentBackgroundColor.cgColor
        var tableBackground: CGColor = NSColor.controlBackgroundColor.cgColor
        root.effectiveAppearance.performAsCurrentDrawingAppearance {
            fill = NSColor.unemphasizedSelectedContentBackgroundColor.cgColor
            tableBackground = NSColor.controlBackgroundColor.cgColor
        }
        func standIn(_ frame: NSRect, radius: CGFloat, in parent: NSView, below sibling: NSView, color: CGColor? = nil) {
            let v = NSView(frame: frame)
            v.wantsLayer = true
            v.layer?.backgroundColor = color ?? fill
            v.layer?.cornerRadius = radius
            parent.addSubview(v, positioned: .below, relativeTo: sibling)
            undo.append { v.removeFromSuperview() }
        }
        func walk(_ v: NSView) {
            if !v.isHidden, String(describing: type(of: v)) == "PortalView" {
                v.isHidden = true
                undo.append { v.isHidden = false }
            } else if let e = v as? NSVisualEffectView, e.material == .selection, !e.isHidden, let parent = e.superview {
                e.isHidden = true
                undo.append { e.isHidden = false }
                standIn(e.frame, radius: 6, in: parent, below: e)
            } else if let h = v as? NSTableHeaderView, !h.isHidden, let parent = h.superview {
                standIn(h.frame, radius: 0, in: parent, below: h, color: tableBackground)
            } else if let c = v as? NSSegmentedControl, c.selectedSegment >= 0, let parent = c.superview {
                let selected = c.selectedSegment
                standIn(segmentFrame(c, selected).offsetBy(dx: c.frame.minX, dy: c.frame.minY), radius: (c.bounds.height - 6) / 2, in: parent, below: c)
                c.selectedSegment = -1
                undo.append { c.selectedSegment = selected }
            }
            v.subviews.forEach(walk)
        }
        walk(root)
        return { undo.reversed().forEach { $0() } }
    }

    /// A segment's frame in its control: with `.fit` distribution every segment gets its content plus an equal share
    /// of the remaining width.
    static func segmentFrame(_ c: NSSegmentedControl, _ i: Int) -> NSRect {
        let font = c.font ?? .systemFont(ofSize: NSFont.systemFontSize)
        let content = (0..<c.segmentCount).map { s -> CGFloat in
            if let label = c.label(forSegment: s), !label.isEmpty { return (label as NSString).size(withAttributes: [.font: font]).width }
            return c.image(forSegment: s)?.size.width ?? 0
        }
        let pad = max(0, (c.bounds.width - content.reduce(0, +)) / CGFloat(max(1, c.segmentCount)))
        let x = content.prefix(i).reduce(0) { $0 + $1 + pad }
        return NSRect(x: x, y: 3, width: content[i] + pad, height: c.bounds.height - 6)
    }

    /// Checks `condition` every 200 ms until it holds (true) or `seconds` pass (false).
    static func wait(_ seconds: Double, _ condition: @MainActor () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > deadline { return false }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return true
    }

    /// Whether the screen is locked (as `IOConsoleLocked`), reported so a reader knows why screen capture would fail.
    static var screenLocked: Bool {
        (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
    }
}

/// A window AppKit never moves back onto a screen.
private final class OffscreenWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}
