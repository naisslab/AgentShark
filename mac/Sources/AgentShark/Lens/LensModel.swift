import Foundation
import Observation

/// The Lens frame's data ("Observed chain", SPEC §12.7): one episode, claim or delegation, loaded for the window's
/// `lensItem`. Claims and delegations open in the same frame.
@MainActor @Observable final class LensModel {
    enum Content: Hashable {
        case episode(LensPayload)
        case claim(ClaimLens)
        case delegation(DelegationLens)

        /// The event the frame is about: the newest attempt, the final message, or the result the parent saw.
        var subjectEventID: String? {
            switch self {
            case .episode(let p): return p.attempts.last?.eventId
            case .claim(let c): return c.claim.finalEventId
            case .delegation(let d): return d.delegation.resultEventId ?? d.parentSaw?.eventId
            }
        }
    }

    enum Phase: Equatable {
        case idle, loading, ready
        case failed(APIError)
    }

    private(set) var item: LensItem?
    private(set) var content: Content?
    private(set) var phase: Phase = .idle
    /// The attempt the ladder has selected (↑ and ↓ move it).
    var selectedAttempt: Int?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var loadedFrom: String?
    /// Head and tail length the Lens asks for.
    static let outputChars = 2000

    var episode: LensPayload? { if case .episode(let p)? = content { return p }; return nil }
    var claim: ClaimLens? { if case .claim(let c)? = content { return c }; return nil }
    var delegation: DelegationLens? { if case .delegation(let d)? = content { return d }; return nil }

    /// Where the shown item happened, whatever its kind.
    var location: LensWhere? {
        switch content {
        case .episode(let p)?: return p.where
        case .claim(let c)?: return c.where
        case .delegation(let d)?: return d.where
        case nil: return nil
        }
    }

    /// Load `item` unless it is already shown; `force` reloads it (live refresh, Retry).
    func show(_ item: LensItem?, api: APIClient?, force: Bool = false) {
        guard let item else {
            task?.cancel()
            self.item = nil
            content = nil
            phase = .idle
            return
        }
        guard let api else { return }
        let source = api.endpoint.baseURL.absoluteString
        if !force, item == self.item, loadedFrom == source, phase != .idle, !isFailed { return }
        let keep = item == self.item && content != nil
        if !keep {
            content = nil
            selectedAttempt = nil
            phase = .loading
        }
        self.item = item
        loadedFrom = source
        task?.cancel()
        task = Task { [weak self] in
            do {
                let c: Content
                switch item.kind {
                case .episode: c = .episode(try await api.episode(item.id, outputChars: Self.outputChars).payload)
                case .claim: c = .claim(try await api.claim(turn: item.id, outputChars: Self.outputChars))
                case .delegation: c = .delegation(try await api.delegation(span: item.id, outputChars: Self.outputChars))
                }
                guard !Task.isCancelled, let self, self.item == item else { return }
                self.content = c
                self.phase = .ready
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled, let self, self.item == item else { return }
                if !keep { self.phase = .failed(error as? APIError ?? .unreachable(error)) }
            }
        }
    }

    private var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    /// ↑ / ↓ in the ladder.
    func moveAttempt(_ step: Int) -> LensAttempt? {
        guard let attempts = episode?.attempts, !attempts.isEmpty else { return nil }
        let i = selectedAttempt.flatMap { n in attempts.firstIndex { $0.n == n } }
        let j = i.map { $0 + step } ?? (step > 0 ? 0 : attempts.count - 1)
        guard attempts.indices.contains(j) else { return nil }
        selectedAttempt = attempts[j].n
        return attempts[j]
    }

    var currentAttempt: LensAttempt? {
        guard let attempts = episode?.attempts else { return nil }
        return selectedAttempt.flatMap { n in attempts.first { $0.n == n } } ?? attempts.last
    }

    /// The session of the frame: the last session crumb of Where.
    var sessionID: String? {
        switch content {
        case .episode(let p)?: return p.where.breadcrumb.last { $0.kind == "session" || $0.kind == "run" }?.id
        case .claim(let c)?: return c.claim.sessionId
        case .delegation(let d)?: return d.delegation.sessionId
        case nil: return nil
        }
    }
}

extension FailuresModel {
    /// The Lens's subject event and its session.
    var lensSubject: (eventId: String, session: String?)? {
        guard panel == .lens else { return nil }
        switch lens.content {
        case .episode?: return lens.currentAttempt.map { ($0.eventId, lens.sessionID) }
        case .claim(let c)?: return (c.claim.finalEventId, c.claim.sessionId)
        case .delegation(let d)?: return (d.delegation.resultEventId ?? d.parentSaw?.eventId ?? "", d.delegation.sessionId)
        case nil: return nil
        }
    }

    var lensSubjectTime: Int64? {
        guard panel == .lens else { return nil }
        switch lens.content {
        case .episode?: return lens.currentAttempt?.ts
        case .claim(let c)?: return c.claim.ts
        case .delegation(let d)?: return d.delegation.startTs
        case nil: return nil
        }
    }

    var lensSignatureID: String? {
        guard panel == .lens else { return nil }
        return lens.episode?.episode.signature.id
    }

    var followCandidate: FollowTarget? {
        guard panel == .lens else { return nil }
        switch lens.content {
        case .episode?: return lens.currentAttempt.map { .call(eventId: $0.callEventId ?? $0.eventId) }
        case .delegation(let d)?: return .delegation(spanId: d.delegation.id)
        default: return nil
        }
    }
}
