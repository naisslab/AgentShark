import AppKit
import Foundation
import Observation

/// What is selected in Critical Path: a mark on the track or a row of a table (ANALYSIS-UX §4.10).
enum PerfSelection: Hashable, Sendable {
    /// A path segment, by its index in `criticalPath.segments`.
    case segment(Int)
    /// A row of Contributors: `topTools` or `topSteps`, by index.
    case tool(Int)
    case step(Int)
    /// A Rework row, or one of its evidence events.
    case rework(PerfReworkKind, evidence: Int?)
    /// A subagent: its Subagents row, or its delegation span on the track. By index in `collaboration.delegations`.
    case delegation(Int)
}

/// The tabs of the bottom tables (§4.9).
enum PerfTab: String, CaseIterable, Identifiable, Sendable {
    case contributors, segments, rework, subagents

    var id: Self { self }

    var title: String {
        switch self {
        case .contributors: return "Contributors"
        case .segments: return "Segments"
        case .rework: return "Rework"
        case .subagents: return "Subagents"
        }
    }
}

/// What a selection points at: its evidence event, the stretch of time it covers, and the marks the track highlights.
struct PerfTarget: Equatable {
    /// What was selected, so the inspector can say why no event shows.
    enum Kind: Equatable { case mark, contributor, rework, delegation }
    var kind: Kind = .mark
    var evidence: EvidenceRef?
    /// Show in Timeline sets the time range to this (§4.10); nil when the selection covers no stretch of time.
    var range: ClosedRange<Int64>?
    /// The session to open for Open Subagent: a subagent row, or a segment in a subagent's lane.
    var subagent: String?
    /// Segments the track highlights.
    var segments: [Int] = []
    /// A delegation span the track highlights.
    var delegation: Int?
    /// What the inspector says when no event marks the selection: "Waiting on people · 2m 05s≈".
    var title: String = ""
    var detail: String = ""
    /// The selection bar's words (§4.10): "Model · 42.1s · Main", "sh:npm audit · 45s · audit:deps".
    var sentence: SelectionSentence?
}

extension CriticalPathContent {
    /// Resolve a selection against this result; nil when the result has no such row.
    func target(_ s: PerfSelection) -> PerfTarget? {
        let cp = path
        switch s {
        case .segment(let i):
            guard cp.segments.indices.contains(i) else { return nil }
            let seg = cp.segments[i]
            let name = PathMarkStyle.name(seg.class), duration = CriticalPathContent.durationText(seg)
            return PerfTarget(evidence: seg.evidence.first, range: seg.start...max(seg.start, seg.end),
                              subagent: seg.sessionId == result.sessionId ? nil : seg.sessionId, segments: [i],
                              title: name + " · " + duration,
                              detail: [CriticalPathContent.clockRange(seg.start, seg.end), names.lane(seg.sessionId)].compactMap { $0 }.joined(separator: " · "),
                              sentence: SelectionSentence(lead: name, parts: [duration, names.short(seg.sessionId)]))
        case .tool(let i):
            guard cp.topTools.indices.contains(i) else { return nil }
            return contributorTarget(cp.topTools[i], name: cp.topTools[i].key)
        case .step(let i):
            guard cp.topSteps.indices.contains(i) else { return nil }
            return contributorTarget(cp.topSteps[i], name: CriticalPathContent.stepName(cp.topSteps[i]))
        case .rework(let kind, let e):
            let finding = kind.finding(in: result.rework)
            let found = Formatters.count(finding.count, kind.noun, plural: kind.plural)
            guard let e else {
                // A measured zero has nothing to show: the inspector says so in the finding's own words.
                return PerfTarget(kind: .rework, evidence: finding.evidence.first, segments: segments(of: finding.evidence.first),
                                  title: finding.count == 0 ? kind.noneFound : kind.title,
                                  detail: finding.count == 0 ? "" : found, sentence: SelectionSentence(lead: kind.title, parts: [found]))
            }
            guard finding.evidence.indices.contains(e) else { return nil }
            let ref = finding.evidence[e]
            return PerfTarget(kind: .rework, evidence: ref, range: segmentRange(of: ref), segments: segments(of: ref), title: kind.title,
                              sentence: SelectionSentence(lead: kind.title, parts: ["event \(Formatters.count(e + 1)) of \(Formatters.count(finding.evidence.count))",
                                                                                     names.short(ref.sessionId)]))
        case .delegation(let i):
            let ds = result.collaboration.delegations
            guard ds.indices.contains(i) else { return nil }
            let d = ds[i]
            let end = d.end ?? cp.endTs ?? d.start
            let onPath = "\(Formatters.duration(d.onPathUs)) on the path"
            return PerfTarget(kind: .delegation, range: d.start...max(d.start, end), subagent: d.child, delegation: i, title: names.lane(d.child),
                              detail: [CriticalPathContent.clockRange(d.start, d.end), onPath].compactMap { $0 }.joined(separator: " · "),
                              sentence: SelectionSentence(lead: names.lane(d.child), parts: [onPath]))
        }
    }

    /// A Contributors row: `name` is its key, or a step's "Step 40 · Run the auth tests".
    private func contributorTarget(_ c: PerfResult.Contributor, name: String) -> PerfTarget {
        let ref = c.evidence.first
        let session = c.sessionId ?? ref?.sessionId
        return PerfTarget(kind: .contributor, evidence: ref, range: segmentRange(of: ref), subagent: session == result.sessionId ? nil : session,
                          segments: segments(of: ref), title: c.key,
                          sentence: SelectionSentence(lead: name, parts: [Formatters.duration(c.us)] + (session.map { [names.short($0)] } ?? [])))
    }

    /// The segments whose evidence is `ref`'s event.
    func segments(of ref: EvidenceRef?) -> [Int] {
        guard let id = ref?.eventId else { return [] }
        return path.segments.indices.filter { path.segments[$0].evidence.first?.eventId == id }
    }

    private func segmentRange(of ref: EvidenceRef?) -> ClosedRange<Int64>? {
        segments(of: ref).first.map { path.segments[$0].start...max(path.segments[$0].start, path.segments[$0].end) }
    }

    /// `s`, made in `old`, in this result. A Refresh of a live run can merge, add or drop segments, so an index into
    /// `old` can name another stretch here, and the rows of every table can move. A mark or wait row follows its time:
    /// the segment of its session that holds its start, else the first one that overlaps it, else the one its event
    /// marks. A contributor follows its key, a rework event its event, and a subagent its delegation. Nil when this
    /// result has nothing that stands for it.
    func reselect(_ s: PerfSelection, from old: CriticalPathContent) -> PerfSelection? {
        switch s {
        case .segment(let i):
            guard old.path.segments.indices.contains(i) else { return nil }
            return segment(over: old.path.segments[i]).map(PerfSelection.segment)
        case .tool(let i):
            guard old.path.topTools.indices.contains(i) else { return nil }
            let c = old.path.topTools[i]
            return path.topTools.firstIndex { $0.key == c.key && $0.sessionId == c.sessionId }.map(PerfSelection.tool)
        case .step(let i):
            guard old.path.topSteps.indices.contains(i) else { return nil }
            let c = old.path.topSteps[i]
            return path.topSteps.firstIndex { $0.key == c.key && $0.sessionId == c.sessionId }.map(PerfSelection.step)
        case .rework(let kind, let e):
            guard let e else { return s }
            let before = kind.finding(in: old.result.rework).evidence
            guard before.indices.contains(e) else { return nil }
            return kind.finding(in: result.rework).evidence.firstIndex { $0.eventId == before[e].eventId }.map { .rework(kind, evidence: $0) }
        case .delegation(let i):
            let before = old.result.collaboration.delegations
            guard before.indices.contains(i) else { return nil }
            return result.collaboration.delegations.firstIndex { $0.id == before[i].id }.map(PerfSelection.delegation)
        }
    }

    /// The segment that stands for `old`'s time here: of its session, the one that holds its start, else the first that
    /// overlaps it, else the one whose evidence is its event.
    private func segment(over old: PerfResult.PathSegment) -> Int? {
        let segs = path.segments
        let own = segs.indices.filter { segs[$0].sessionId == old.sessionId }
        if let i = own.first(where: { segs[$0].start <= old.start && old.start < segs[$0].end })
            ?? own.first(where: { segs[$0].start < max(old.end, old.start + 1) && old.start < segs[$0].end }) {
            return i
        }
        guard let event = old.evidence.first?.eventId else { return nil }
        return own.first { segs[$0].evidence.first?.eventId == event }
    }

    /// The segment of `session` whose [start, end) holds `ts`, for an event selected elsewhere (§4.10 "Show in Critical
    /// Path"); for an event without a time, the segment whose evidence names it first.
    func segment(holding event: String, session: String?, ts: Int64?) -> Int? {
        let segs = path.segments
        // The segment of the event's session whose [start, end) holds its time (§4.10). A segment's evidence can be an
        // event that only bounds it (a model step cites the tool call that ended it), so matching evidence first picked
        // a 4 s model mark for a 30 s tool call. Evidence decides only for an event without a time.
        if let session, let ts, let i = segs.indices.first(where: { segs[$0].sessionId == session && segs[$0].start <= ts && ts < segs[$0].end }) {
            return i
        }
        return segs.indices.first { segs[$0].evidence.first?.eventId == event }
    }
}

extension WindowModel {
    /// The session Critical Path analyses (§4.1): the focused session when the scope names it; with no session in scope,
    /// the top-level run of the selected event's session. A mark or row in a subagent's lane selects that subagent's
    /// event, which moves the focused session to the subagent; the analysis stays on the run, so its selection and
    /// result stay too. Open Subagent is the one way to analyse a child.
    var criticalPathSession: String? {
        guard let id = focusedSessionID else { return nil }
        return scope.sessions.isEmpty ? EventTableController.runRoot(of: id, in: sessionsByID) : id
    }
}

/// Session · Critical Path's state in one window: the selection, the class highlight, the tab, the track's zoom and
/// lane disclosure. It outlives the view, so switching modes and Back return to the same selection and zoom; it
/// resets when the analysed session changes.
@MainActor @Observable final class CriticalPathModel {
    @ObservationIgnored private(set) weak var window: WindowModel?

    /// The result key the state below belongs to.
    private(set) var key: String?
    var selection: PerfSelection?
    /// The legend row clicked: its class stands out on the track and narrows Contributors and Segments (§4.7).
    var classFilter: PathClass?
    var tab: PerfTab = .contributors
    /// The "n more sessions" row is open.
    var showsAllLanes = false
    var expandedRework: Set<PerfReworkKind> = []
    /// Options ▸ Merge Segments Shorter Than 1s: drawing only; Segments keeps every segment.
    var mergeShort: Bool {
        didSet { Self.defaults?.set(mergeShort, forKey: Self.mergeShortKey) }
    }
    /// An event selected elsewhere that no segment holds (§4.10): the evidence line says so.
    private(set) var notOnPath: String?
    /// The event this mode last selected for a mark or row, so another session's analysis clears it with the
    /// selection; an event selected elsewhere (Events ▸ Show in Critical Path, Back) is the window's to keep.
    @ObservationIgnored private var ownedEvent: String?
    /// The track shows; the header's zoom controls act on it.
    private(set) var hasTrack = false

    /// The track's zoom, kept while the view is gone.
    @ObservationIgnored var viewport: TimeViewport?
    @ObservationIgnored var fitted = true
    @ObservationIgnored private weak var track: CriticalPathTrackView?
    @ObservationIgnored private var cache: (id: String, content: CriticalPathContent)?
    /// The result the selection indexes into: the one last shown for `key`.
    @ObservationIgnored private var basis: CriticalPathContent?

    static let mergeShortKey = "AgentShark.criticalPath.mergeShort"
    /// Where the view options persist; tests and snapshots pass none.
    @ObservationIgnored nonisolated(unsafe) static var defaults: UserDefaults? = .standard

    init(window: WindowModel?) {
        self.window = window
        mergeShort = Self.defaults?.bool(forKey: Self.mergeShortKey) ?? false
    }

    // MARK: One per window

    /// The window's own model, which goes when the window does.
    static func of(_ window: WindowModel) -> CriticalPathModel {
        window.criticalPathModel
    }

    // MARK: Content

    /// The content of `result`, built once per result.
    func content(_ result: PerfResult, key: String) -> CriticalPathContent {
        let id = key + "|" + String(result.coverage.snapshotAt) + "|" + result.analysisVersion
        if let cache, cache.id == id { return cache.content }
        let store = window?.store
        let row = store?.sessionsByID[result.sessionId]
        let content = CriticalPathContent(result, fallbackTitle: { store?.sessionsByID[$0]?.displayTitle },
                                          rootIsSubagent: row.map { $0.parentId != nil }, rootRange: row.map { ($0.start, $0.end) })
        cache = (id, content)
        return content
    }

    /// The result's key changed: another session's analysis forgets the previous one's selection, highlight and zoom,
    /// and the window's selected event when this mode selected it, so the inspector empties with the selection. A key
    /// that goes away and comes back (no session for a moment) keeps them.
    func show(key: String?) {
        guard let key, key != self.key else { return }
        let first = self.key == nil
        self.key = key
        basis = nil
        guard !first else { return }
        if let window, let owned = ownedEvent, window.selectedEvent == owned { window.selectedEvent = nil }
        ownedEvent = nil
        selection = nil
        classFilter = nil
        showsAllLanes = false
        expandedRework = []
        notOnPath = nil
        viewport = nil
        fitted = true
    }

    /// `content` is shown for `key`. Another key forgets the state as `show(key:)` says; a new result for the same key
    /// (a Refresh) keeps the selection on what it selected (`reselect`), since the old index can name another
    /// segment or row of the new result, and a selection the new result has nothing for goes. When this mode selected
    /// the window's event, the event follows the selection as a click would; an event selected elsewhere stays, for
    /// `follow` to find in the new result.
    func show(key: String?, content: CriticalPathContent?) {
        show(key: key)
        guard let content, key != nil else { return }
        defer { basis = content }
        guard let basis, basis.result.coverage.snapshotAt != content.result.coverage.snapshotAt, let s = selection else { return }
        let next = content.reselect(s, from: basis)
        if let window, window.selectedEvent == ownedEvent {
            select(next, in: content)
        } else {
            selection = next
        }
    }

    // MARK: Selection (§4.10)

    /// Select a mark or row. One with evidence selects its event in place (`reveal: false`), so the inspector shows
    /// Detail and Raw; one without selects only itself, and the inspector says that no event marks it.
    func select(_ s: PerfSelection?, in content: CriticalPathContent) {
        selection = s
        notOnPath = nil
        let ref = s.flatMap(content.target)?.evidence
        ownedEvent = ref?.eventId
        guard let window else { return }
        if let ref {
            window.select(event: ref.eventId, reveal: false)
        } else if window.selectedEvent != nil {
            window.selectedEvent = nil
        }
    }

    /// The selection resolved; nil without one.
    func target(in content: CriticalPathContent) -> PerfTarget? {
        selection.flatMap(content.target)
    }

    /// Follow an event selected outside the view, such as Events ▸ Show in Critical Path or Back: select the segment
    /// that holds it, or say that none does. An event of a session this analysis does not cover (one left selected in
    /// another run) says nothing about this path, so it changes nothing here.
    func follow(event: String?, session: String?, ts: Int64?, in content: CriticalPathContent) {
        guard let event else {
            notOnPath = nil
            return
        }
        if let session, !content.result.coverage.sessionIds.contains(session) {
            notOnPath = nil
            return
        }
        if let ref = target(in: content)?.evidence, ref.eventId == event { return }
        if let i = content.segment(holding: event, session: session, ts: ts) {
            selection = .segment(i)
            notOnPath = nil
        } else if ts != nil || session != nil {
            selection = nil
            notOnPath = event
        }
    }

    func toggleClass(_ c: PathClass) {
        classFilter = classFilter == c ? nil : c
    }

    // MARK: Links (§4.10)

    /// Show in Events: the event in the Events workspace.
    func showInEvents(_ t: PerfTarget?) {
        guard let window, let ref = t?.evidence else { return NSSound.beep() }
        window.select(event: ref.eventId, reveal: true)
    }

    /// Show in Session (⌘↩, double-click): Steps with the event's step focused. The evidence names the event's session,
    /// so a subagent's event opens that subagent's Steps without waiting for the event's detail, as Failures does.
    func showInSession(_ t: PerfTarget?) {
        guard let window, let ref = t?.evidence else { return NSSound.beep() }
        if window.selectedEvent != ref.eventId { window.select(event: ref.eventId, reveal: false) }
        window.sessionMode = .steps
        if window.scope.sessions.contains(ref.sessionId) {
            window.singleSessionChoice = ref.sessionId
            window.workspace = .session
        } else {
            window.openSession(ref.sessionId, workspace: .session)
        }
        window.steps.focus(event: ref.eventId)
    }

    /// Show in Timeline: the time range set to the mark's stretch, with its event selected first when it has one.
    func showInTimeline(_ t: PerfTarget?) {
        guard let window, let t, t.range != nil || t.evidence != nil else { return NSSound.beep() }
        if let ref = t.evidence { window.select(event: ref.eventId, reveal: false) }
        if let r = t.range { window.setTimeRange(from: r.lowerBound, to: r.upperBound) }
        window.workspace = .timeline
    }

    func copyEventID(_ t: PerfTarget?) {
        guard let id = t?.evidence?.eventId else { return NSSound.beep() }
        AppKitHelpers.copy(id)
    }

    /// Open Subagent: Critical Path of the child.
    func openSubagent(_ id: String?) {
        guard let window, let id else { return NSSound.beep() }
        window.openSession(id, mode: .criticalPath)
    }

    /// Show Whole Run (§4.3): Critical Path of the top-level run the analysed subagent belongs to.
    func showWholeRun(of session: String, sessions: [String: WorkbenchSession]?) {
        guard let window else { return }
        let store = window.store
        window.openSession(Self.wholeRun(of: session, catalog: { store.sessionsByID[$0]?.rootId }, sessions: sessions), mode: .criticalPath)
    }

    /// The engine's `rootId` for the session, which names the top-level run whatever the catalog holds. An engine that
    /// sends none leaves the walk up the `parentId` chain of the result's `sessions` map, taking the catalog's root of
    /// the first session on the way whose row the catalog has: the map holds only the analysed subtree, so a
    /// subagent's subagent reaches its parent there and the catalog's row of either names the top-level run. An empty
    /// root names no session.
    static func wholeRun(of session: String, catalog: (String) -> String?, sessions: [String: WorkbenchSession]?) -> String {
        if let root = sessions?[session]?.rootId, !root.isEmpty { return root }
        var id = session
        var seen: Set<String> = [id]
        while true {
            if let root = catalog(id), !root.isEmpty, root != id { return root }
            guard let parent = sessions?[id]?.parentId, seen.insert(parent).inserted else { return id }
            id = parent
        }
    }

    /// The analysed session is a subagent, so the header offers Show Whole Run.
    func isSubagent(_ session: String, result: PerfResult?) -> Bool {
        if let s = result?.sessions?[session] { return s.parentId != nil }
        return window?.store.sessionsByID[session]?.parentId != nil
    }

    // MARK: Track

    func attach(_ track: CriticalPathTrackView) {
        self.track = track
        if !hasTrack { hasTrack = true }
    }

    /// Forget `track` if it is still the registered one: a replacement made before the old track is dismantled has
    /// registered itself by then, and stays.
    func detach(_ track: CriticalPathTrackView) {
        guard self.track === track || self.track == nil else { return }
        self.track = nil
        if hasTrack { hasTrack = false }
    }

    func zoom(_ z: CriticalPathWorkspace.Zoom) {
        track?.zoom(z)
    }
}
