import AppKit
import Foundation

/// The edit chip or close diff the diff sheet shows.
struct DiffRequest: Identifiable, Hashable, Sendable {
    let eventId: String
    var path: String?
    var title: String
    /// The session of the event, when known: the sheet then offers Follow File.
    var session: String?
    var id: String { eventId + "|" + (path ?? "") }
}

/// Statistics results kept per window, so leaving and re-entering a section does not compute it again.
@MainActor final class PanelCache {
    private var requests: [String: AnyObject] = [:]

    func request<V>(_ key: String, _ type: V.Type = V.self) -> PanelRequest<V> {
        if let r = requests[key] as? PanelRequest<V> { return r }
        let r = PanelRequest<V>()
        requests[key] = r
        return r
    }
}

/// The agent-native actions of a window (SPEC §12.7 Keyboard, MAC-CONTRACT §5.2).
extension WindowModel {
    // MARK: Lens

    func openEpisode(_ id: String, reveal: Bool = true) {
        openLens(LensItem(kind: .episode, id: id), reveal: reveal)
    }

    /// Show a queue item in the Lens frame; `reveal` switches to Failures.
    func openLens(_ item: LensItem, reveal: Bool = true) {
        lensItem = item
        failures.panel = .lens
        if reveal { workspace = .failures }
    }

    // MARK: Navigation

    /// ⌘' / ⇧⌘': the next or previous failure in scope; with nothing selected, the newest. In Failures it moves
    /// through the queue; elsewhere it finds the failure event next to the selected one in the window's view.
    func nextFailure(_ forward: Bool) {
        if workspace == .failures {
            failures.move(by: forward ? 1 : -1, attentionOnly: false)
            return
        }
        guard let api = engine.api else { return NSSound.beep() }
        let field = store.fields.contains { $0.name == "failure" } ? "failure" : "error"
        let anchor = eventDetail.flatMap { $0.event.id == selectedEvent ? $0.event.ts : nil }
        let current = selectedEvent
        var spec = makeSpec()
        spec.colorRules = nil
        spec.filter = appliedFilter.isEmpty ? field : "(\(appliedFilter)) && \(field)"
        spec.sort = "ts"
        if let anchor {
            if forward { spec.from = max(spec.from ?? anchor, anchor) } else { spec.to = min(spec.to ?? anchor, anchor) }
            spec.order = forward ? "asc" : "desc"
        } else {
            spec.order = "desc"
        }
        Task { [weak self] in
            do {
                let v = try await api.createView(spec)
                let rows = v.count > 0 ? try await api.rows(view: v.viewId, offset: 0, limit: 20) : []
                guard let self, self.selectedEvent == current else { return }
                guard let hit = rows.first(where: { $0.id != current }) else { return NSSound.beep() }
                self.selectFailureEvent(hit.id)
            } catch {
                NSSound.beep()
            }
        }
    }

    /// Select a failure event where the current workspace can show it.
    private func selectFailureEvent(_ id: String) {
        switch workspace {
        case .session:
            select(event: id, reveal: false)
            sessionMode = .steps
            steps.focus(event: id)
        case .timeline:
            select(event: id, reveal: false)
        default:
            select(event: id, reveal: true)
        }
    }

    /// ⌥⌘': the next item of a section that needs attention.
    func nextAttentionItem() {
        if workspace != .failures { workspace = .failures }
        failures.move(by: 1, attentionOnly: true)
    }

    /// The event the agent-native actions act on: the selected event, else the Lens's newest attempt.
    var subjectEventID: String? { selectedEvent ?? lensSubject?.eventId }

    /// The Lens's subject: its newest attempt (episode), its final message (claim) or the result the parent saw.
    var lensSubject: (eventId: String, session: String?)? {
        guard workspace == .failures || selectedEvent == nil else { return nil }
        return failures.lensSubject
    }

    /// The agent of the Lens subject: the queue row's, else its session's.
    var lensAgent: AgentKind? {
        failures.selectedRow?.agent ?? failures.lens.sessionID.flatMap { sessionsByID[$0]?.agent }
    }

    /// ⌘↩ (the Failures menu): what the mode shows in Session. Critical Path shows the selected mark's evidence and
    /// Compare the chosen run's action, each in the session its result names; elsewhere it is the subject event.
    func showSelectionInSession() {
        if workspace == .session && sessionMode == .criticalPath {
            CriticalPathModel.of(self).showInSession(criticalPathTarget)
        } else if isComparing {
            guard compareShowsAlignment else { return NSSound.beep() }
            CompareModel.of(self).showInSession()
        } else {
            showInSession()
        }
    }

    /// ⌘↩ has something to show: a mark or row with evidence in Critical Path, an action on the chosen run of the
    /// alignment Compare shows, a subject event elsewhere.
    var canShowSelectionInSession: Bool {
        if workspace == .session && sessionMode == .criticalPath { return criticalPathTarget?.evidence != nil }
        if isComparing { return compareShowsAlignment && CompareModel.of(self).selectedAction != nil }
        return subjectEventID != nil
    }

    /// Critical Path's selection, resolved against the result the mode shows.
    var criticalPathTarget: PerfTarget? {
        guard let r = analyses.perf.value, let key = analyses.perf.key else { return nil }
        let cp = CriticalPathModel.of(self)
        return cp.target(in: cp.content(r, key: key))
    }

    /// Session · Steps with the subject event's step expanded and selected, in the session `sessionToShow` picks.
    func showInSession(session hint: String? = nil) {
        guard let event = subjectEventID else { return NSSound.beep() }
        let session = Self.sessionToShow(hint: hint, own: knownSession(of: event), fromFailures: workspace == .failures || selectedEvent == nil,
                                         lens: failures.lensSubject?.session, row: failures.selectedRow?.sessionId)
        if selectedEvent != event { select(event: event, reveal: false) }
        sessionMode = .steps
        if let session, !scope.sessions.contains(session) {
            openSession(session, workspace: .session)
        } else {
            if let session { singleSessionChoice = session }
            workspace = .session
        }
        steps.focus(event: event)
    }

    /// The session ⌘↩ opens: the caller's (`hint`), which wins since the loaded detail may still be the previous
    /// selection's, else the one the event's own detail or view row names (`own`). While the subject comes from Failures
    /// (`fromFailures`: the Failures workspace, or no event selected), the Lens subject's session follows, then the
    /// selected queue row's: the row still decides when the Lens shows no subject (its Signature or Run panel) and the
    /// event's detail has not loaded. A queue row never decides for an event selected elsewhere. Nil keeps the session
    /// in focus.
    static func sessionToShow(hint: String?, own: String?, fromFailures: Bool, lens: String?, row: String?) -> String? {
        hint ?? own ?? (fromFailures ? lens ?? row : nil)
    }

    /// The session of `event` from its loaded detail or its row in the view; nil while neither is this event's.
    private func knownSession(of event: String) -> String? {
        if let d = eventDetail, d.event.id == event { return d.event.session }
        if let row = selectedRow.flatMap({ pager?.row(at: $0) }), row.id == event { return row.session }
        return nil
    }

    /// ⌥⌘G: the signature of the selection in the Lens frame.
    var subjectSignatureID: String? {
        if workspace == .failures, case .signature(let id) = failures.panel { return id }
        if workspace == .failures, let s = failures.lensSignatureID { return s }
        if let f = eventDerived?.failure, eventDerived?.eventId == selectedEvent { return f.signatureId }
        return failures.selectedRow?.signatureId
    }

    func showSignature() {
        guard let id = subjectSignatureID else { return NSSound.beep() }
        failures.showSignature(id)
        workspace = .failures
    }

    /// ⌥⌘F: the stream that fits the selection: a process, a delegation, the file it changed or read, or the call.
    var followCandidate: FollowTarget? {
        if workspace == .failures, let t = failures.followCandidate { return t }
        return followAlternatives.first
    }

    /// Every stream the selected event belongs to, best fit first: its process, its delegation, each file it changed
    /// or read, and its tool call. The Follow panel offers the others.
    var followAlternatives: [FollowTarget] {
        var out: [FollowTarget] = []
        let session = eventDetail.flatMap { $0.event.id == selectedEvent ? $0.event.session : nil }
        if let d = eventDerived, d.eventId == selectedEvent {
            if let p = d.process { out.append(.process(id: p.id)) }
            if let del = d.delegation { out.append(.delegation(spanId: del.id)) }
            if let session {
                for c in d.changes where c.op != "shell-mention" { out.append(.file(session: session, path: c.path)) }
            }
        }
        if let id = selectedEvent, let detail = eventDetail, detail.event.id == id {
            switch detail.event.kind {
            case .toolCall: out.append(.call(eventId: id))
            case .toolResult, .toolExec: if let p = partnerEventID { out.append(.call(eventId: p)) }
            default: break
            }
        }
        var seen: Set<FollowTarget> = []
        return out.filter { seen.insert($0).inserted }
    }

    func follow() {
        guard let t = followCandidate else { return NSSound.beep() }
        followTarget = t
    }

    /// The episode ⇧⌘C reports on: the Lens's episode in Failures, else the episode of the selected event.
    var reportSubjectEpisode: String? {
        if workspace == .failures, failures.panel == .lens, lensItem?.kind == .episode { return lensItem?.id }
        guard let d = eventDerived, d.eventId == selectedEvent else { return nil }
        return d.episode?.id ?? d.failure?.episodeId
    }

    var canCopyReport: Bool { reportSubjectEpisode != nil }

    /// ⇧⌘C: the report preview (format, redactions, Copy).
    func copyReport() {
        guard let id = reportSubjectEpisode else { return NSSound.beep() }
        reportEpisodeID = id
        presentedSheet = .reportPreview
    }

    /// ⌃⌘T: set the time reference at the selected event (or the Lens subject), or clear it.
    func toggleTimeReference() {
        if timeReference != nil {
            timeReference = nil
            return
        }
        if let d = eventDetail, d.event.id == selectedEvent {
            timeReference = d.event.ts
        } else if let ts = failures.lensSubjectTime {
            timeReference = ts
        } else {
            NSSound.beep()
        }
    }

    /// `episode == "<id>"` in Events (the Lens action Show in Events).
    func showEpisodeInEvents(_ id: String) {
        applyFilter("episode == " + FilterExpression.quote(id))
        workspace = .events
    }

    // MARK: Entry (SPEC §12.7)

    /// At launch: firing alarms, or attention items newer than the last visit, open Failures on the top item and set
    /// the "Since 23:04 (last visit)" chip. The first launch has no last visit: every attention item counts, and the
    /// chip reads "first visit". A restored selected event always wins.
    func checkEntry() {
        guard !entryChecked else { return }
        entryChecked = true
        guard selectedEvent == nil, !isCapture, app.isLaunching, let api = engine.api else { return }
        let lastVisit = app.previousVisit
        Task { [weak self] in
            let alarms = try? await api.alarms(.global, state: .firing, limit: 1)
            let attention = (try? await api.failuresSummary(DerivedScopeQuery(view: "global", since: lastVisit)))?.needAttention ?? 0
            guard let self, self.selectedEvent == nil, (alarms?.total ?? 0) > 0 || attention > 0 else { return }
            if attention > 0, !self.scope.hasTimeRange {
                if let lastVisit { self.scope.from = lastVisit }
                self.entrySince = lastVisit == nil ? .firstVisit : .lastVisit
            }
            self.failures.selectTopOnLoad = true
            self.workspace = .failures
        }
    }
}
