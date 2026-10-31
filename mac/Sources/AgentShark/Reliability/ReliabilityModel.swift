import Foundation
import Observation

enum ReliabilityCategory: String, CaseIterable, Identifiable {
    case all, handling, repetition
    var id: Self { self }
    var title: String {
        switch self {
        case .all: return "All"
        case .handling: return "Failure Handling"
        case .repetition: return "Repeated Calls"
        }
    }
}

/// A review row, identified by its source event rather than its current position in a refreshed result.
struct ReliabilityFinding: Identifiable, Hashable {
    let id: String
    let category: ReliabilityCategory
    let sessionId: String
    let title: String
    let target: String
    let explanation: String
    let nextStep: String
    let rule: String
    let evidence: [EvidenceRef]
    let repetition: ReliabilityResult.Repetition?

    static func rows(_ result: ReliabilityResult) -> [Self] {
        let handling = result.failureHandling.map { f in
            Self(id: f.rule + "|" + (f.evidence.first?.eventId ?? f.sessionId) + "|" + f.target, category: .handling,
                 sessionId: f.sessionId, title: f.rule == "timeout-as-empty@1" ? "Timeout followed by an empty-result claim" : "Failed write reported as successful",
                 target: f.target, explanation: f.message,
                 nextStep: f.rule == "timeout-as-empty@1"
                    ? "Retry the lookup or verify it with another source before concluding there are no results."
                    : "Check the file's contents and retry the write before reporting it as saved.",
                 rule: f.rule, evidence: f.evidence, repetition: nil)
        }
        let repeated = result.noProgress.map { r in
            Self(id: r.rule + "|" + (r.evidence.first?.eventId ?? r.sessionId), category: .repetition, sessionId: r.sessionId,
                 title: "\(Formatters.count(r.attempts)) calls returned the same result", target: r.target ?? r.tool ?? "Tool call",
                 explanation: "The calls repeated complete inputs and outputs without a logged state change. "
                    + (r.active ? "These are the latest calls in this session." : "This happened earlier in the trace."),
                 nextStep: "Inspect the output and change the command or investigate the environment before retrying. For deliberate monitoring, review the evidence and allow this exact observation.",
                 rule: r.rule, evidence: r.evidence, repetition: r)
        }
        return handling + repeated.sorted { ($0.repetition?.active == true ? 0 : 1) < ($1.repetition?.active == true ? 0 : 1) }
    }

    /// A long chain retains its first 24 calls and its final call. Name that final attempt by its actual number.
    func evidenceLabel(at index: Int) -> String {
        guard let repetition else {
            return ["Tool call", "Failed result", "Assistant claim"].indices.contains(index)
                ? ["Tool call", "Failed result", "Assistant claim"][index] : "Related event"
        }
        let pair = index / 2
        let lastPair = (evidence.count - 1) / 2
        let attempt = pair == lastPair ? repetition.attempts : pair + 1
        return "Attempt \(attempt) · " + (index.isMultiple(of: 2) ? "call" : "result")
    }
}

@MainActor @Observable final class ReliabilityModel {
    var policy = ReliabilityPolicy()
    var category: ReliabilityCategory = .all
    var search = ""
    private(set) var selection: String?
    private(set) var selectedEvidence: EvidenceRef?
    private(set) var rows: [ReliabilityFinding] = []
    private(set) var lastAllowedObservation: ReliabilityCallExemption?
    private(set) var allowedObservationLabels: [ReliabilityCallExemption: String] = [:]
    private var key: String?

    var visibleRows: [ReliabilityFinding] {
        rows.filter { row in
            (category == .all || row.category == category) && (search.isEmpty || (row.title + " " + row.target + " " + row.sessionId).localizedCaseInsensitiveContains(search))
        }
    }
    var selected: ReliabilityFinding? { rows.first { $0.id == selection } }
    var canAllowObservation: Bool {
        guard let r = selected?.repetition, r.outcome == "ok", let tool = r.tool, !tool.isEmpty,
              r.measurement.inputDigest.count == 64, r.measurement.outputDigest.count == 64 else { return false }
        let item = ReliabilityCallExemption(tool: tool, inputDigest: r.measurement.inputDigest, outputDigest: r.measurement.outputDigest)
        return (policy.allowedRepeatCalls?.count ?? 0) < 100 && !(policy.allowedRepeatCalls ?? []).contains(item)
    }
    func allowObservation() {
        guard canAllowObservation, let r = selected?.repetition, let tool = r.tool else { return }
        let item = ReliabilityCallExemption(tool: tool, inputDigest: r.measurement.inputDigest, outputDigest: r.measurement.outputDigest)
        let location = selected?.evidence.first?.line.map { " · source line \($0)" } ?? ""
        allowedObservationLabels[item] = tool + location + "\n" + (selected?.target ?? tool)
        policy.allowedRepeatCalls = (policy.allowedRepeatCalls ?? []) + [item]
        lastAllowedObservation = item
    }
    func undoAllowedObservation() {
        guard let item = lastAllowedObservation else { return }
        policy.allowedRepeatCalls?.removeAll { $0 == item }
        if policy.allowedRepeatCalls?.isEmpty == true { policy.allowedRepeatCalls = nil }
        lastAllowedObservation = nil
    }

    func show(_ result: ReliabilityResult, key: String) {
        if self.key != key { selection = nil; selectedEvidence = nil; category = .all; search = "" }
        self.key = key
        rows = ReliabilityFinding.rows(result)
        reconcile()
    }
    func count(_ category: ReliabilityCategory) -> Int { rows.filter { category == .all || $0.category == category }.count }
    func choose(_ id: String?) {
        selection = id
        let refs = selected?.evidence ?? []
        selectedEvidence = selected?.category == .handling ? (refs.dropFirst().first ?? refs.first) : refs.last
    }
    func inspect(_ ref: EvidenceRef) {
        guard selected?.evidence.contains(ref) == true else { return }
        selectedEvidence = ref
    }
    func reconcile() {
        if !visibleRows.contains(where: { $0.id == selection }) { choose(visibleRows.first?.id) }
        else if let selected, !selected.evidence.contains(where: { $0 == selectedEvidence }) { choose(selection) }
    }

    func showInSteps(_ window: WindowModel) {
        guard let ref = selectedEvidence else { return }
        window.select(event: ref.eventId, reveal: false)
        window.openSession(ref.sessionId, mode: .steps)
        window.steps.focus(event: ref.eventId)
    }
}

/// Presentation uses evidence labels instead of treating every candidate as a confirmed error.
enum ReliabilityPresentation {
    static func recommendation(_ decision: String) -> String {
        switch decision {
        case "stop": return "Consider stopping"
        case "change-strategy": return "Change strategy"
        case "review": return "Review the evidence"
        case "no-trigger": return "No stopping threshold reached"
        case "unknown": return "Recommendation unavailable"
        default: return "Review recommendation"
        }
    }
    static func tokens(_ value: Int64?) -> String { Formatters.tokens(value.map(Int.init)) }
    static func duration(_ value: Int64?) -> String { value.map { Formatters.duration($0) } ?? Formatters.missing }
    static func forecast(_ value: Int64?) -> String {
        value.map { Formatters.count(Int($0), "more repeat") } ?? "Not enough measured repeat intervals"
    }
}

/// Text fields keep invalid edits local to the sheet. Only an explicitly applied valid draft changes the request.
struct ReliabilityPolicyDraft {
    var minimum: String
    var stop: String
    var tokens: String
    var minutes: String
    var allowed: String
    var calls: [ReliabilityCallExemption]

    init(_ policy: ReliabilityPolicy) {
        minimum = String(policy.minRepeats)
        stop = String(policy.stopAfterRepeats)
        tokens = policy.tokenBudget.map(String.init) ?? ""
        minutes = policy.timeBudgetUs.map { String(Double($0) / 60_000_000) } ?? ""
        allowed = policy.allowedRepeatTools.joined(separator: ", ")
        calls = policy.allowedRepeatCalls ?? []
    }
    var validated: ReliabilityPolicy? {
        guard let minimum = Int(minimum), (2...100).contains(minimum), let stop = Int(stop), (minimum...1000).contains(stop) else { return nil }
        let tokenText = tokens.trimmingCharacters(in: .whitespaces)
        let timeText = minutes.trimmingCharacters(in: .whitespaces)
        let tokenLimit = tokenText.isEmpty ? nil : Int64(tokenText)
        guard tokenText.isEmpty || (tokenLimit.map { $0 > 0 && $0 <= 9_007_199_254_740_991 } ?? false) else { return nil }
        var timeLimit: Int64?
        if !timeText.isEmpty {
            guard let n = Double(timeText), n.isFinite, n > 0, n * 60_000_000 >= 1, n * 60_000_000 <= 9_007_199_254_740_991 else { return nil }
            timeLimit = Int64((n * 60_000_000).rounded())
        }
        let tools = allowed.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard tools.count <= 100 && tools.allSatisfy({ $0.count <= 200 }) else { return nil }
        return ReliabilityPolicy(minRepeats: minimum, stopAfterRepeats: stop, tokenBudget: tokenLimit, timeBudgetUs: timeLimit,
                                 allowedRepeatTools: Array(Set(tools)).sorted(), allowedRepeatCalls: calls.isEmpty ? nil : calls)
    }
}
