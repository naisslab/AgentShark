import AppKit
import SwiftUI

/// Glyphs, words and colors of the derived model (WEB-CONTRACT "Glyphs and marks", MAC-CONTRACT §5.6). Color is never
/// the only cue: every impact, tier and provenance also has a glyph and a word.
enum DerivedStyle {
    // MARK: Impact

    static func impactColor(_ i: TurnImpact) -> NSColor {
        switch i {
        case .failed, .blocked: return Theme.err
        case .interrupted, .masked, .degraded, .slow: return Theme.warn
        case .recovered: return .secondaryLabelColor
        default: return .tertiaryLabelColor
        }
    }

    /// The mark and impact color of an episode outcome (§6.3, §5.2 item 1).
    static func outcomeMark(_ o: EpisodeOutcome) -> (Mark, NSColor) {
        switch o {
        case .endedOnFailure: return (.failed, Theme.err)
        case .interrupted: return (.interrupted, Theme.warn)
        case .pivoted: return (.degraded, Theme.warn)
        case .recoveredLater: return (.recovered, Theme.warn)
        case .open: return (.live, .controlAccentColor)
        default: return (.recovered, .secondaryLabelColor)
        }
    }

    /// A signature's counts, as its queue row and its Lens title print them (Mac notes 12): "3 episodes in 7 sessions", or
    /// "3 episodes in scope · 7 sessions in all" when the episodes are the scope's and the sessions all time's.
    static func signatureCounts(episodes: Int, sessions: Int?, scoped: Bool) -> String {
        let e = Formatters.count(episodes, "episode")
        guard let sessions else { return e }
        return scoped ? e + " in scope · " + Formatters.count(sessions, "session") + " in all" : e + " in " + Formatters.count(sessions, "session")
    }

    /// The mark and color of a signature status (§6.2): "↻ recurring" muted, "▲ regressed" amber; new and dormant
    /// carry no mark.
    static func signatureStatusMark(_ s: SignatureStatus) -> (Mark?, NSColor) {
        switch s.rawValue {
        case "regressed": return (.regressed, Theme.warn)
        case "recurring": return (.recovered, .secondaryLabelColor)
        case "new": return (nil, Theme.note)
        default: return (nil, .secondaryLabelColor)
        }
    }

    /// The Episode Lens title: "Ended on failure after 1 attempt", "Recovered after 3 attempts".
    static func episodeTitle(_ o: EpisodeOutcome, attempts: Int) -> String {
        let word = o == .open ? "still open" : outcomeWord(o.rawValue)
        return word.prefix(1).uppercased() + word.dropFirst() + " after " + Formatters.count(attempts, "attempt")
    }

    // MARK: Tiers

    static func tierColor(_ t: FailureTier?) -> NSColor {
        switch t {
        case .failure?, .suspect?: return Theme.err
        case .benign?, .deferred?: return Theme.warn
        default: return .secondaryLabelColor
        }
    }

    /// "1,204", "212≈": suspect counts are upper bounds, with the mark after the value (§3.3).
    static func tierCount(_ t: FailureTier, _ n: Int) -> String {
        t == .suspect ? Formatters.count(n) + "≈" : Formatters.count(n)
    }

    // MARK: Words

    static func outcomeWord(_ o: String?) -> String {
        guard let o else { return Formatters.missing }
        switch o {
        case "parallel-ok": return "parallel ok"
        case "recovered-later": return "recovered later"
        case "ended-on-failure": return "ended on failure"
        case "passed-after-last-edit": return "tests passed after the last edit"
        case "edited-after-last-test": return "edited after the last test"
        case "last-test-failed": return "last test failed"
        case "no-test-in-turn": return "no test in this turn"
        default: return o.replacingOccurrences(of: "-", with: " ")
        }
    }

    static func sectionTitle(_ s: AttentionSection) -> String {
        switch s.rawValue {
        case "alarms": return "Alarms"
        case "blocked": return "Blocked"
        case "unrecovered": return "Unrecovered"
        case "silent-child": return "Silent Child Failures"
        case "unverified-claims": return "Unverified Claims"
        case "recurring": return "Recurring Signatures"
        case "other": return "Other"
        case "recovered": return "Recovered"
        default: return s.rawValue.capitalized
        }
    }

    /// The jump bar's word for a section.
    static func sectionShortTitle(_ s: AttentionSection) -> String {
        switch s.rawValue {
        case "blocked": return "Blocked"
        case "silent-child": return "Silent"
        case "unverified-claims": return "Claims"
        case "recurring": return "Recurring"
        default: return sectionTitle(s)
        }
    }

    static func alarmWord(_ k: AlarmKind) -> String {
        switch k.rawValue {
        case "consecutive": return "consecutive failures"
        case "blocker": return "blocked by environment"
        case "blind-loop": return "blind loop"
        case "loop": return "loop"
        case "stall": return "stalled"
        case "silent-child": return "silent child failure"
        default: return k.rawValue
        }
    }

    static func groupTitle(_ g: QueueGroup) -> String {
        switch g {
        case .attention: return "Attention"
        case .episode: return "Episode"
        case .signature: return "Signature"
        case .session: return "Session"
        case .delegation: return "Delegation"
        default: return g.rawValue.capitalized
        }
    }

    /// The unit of a queue grouped by `g` (§9 Units in Failures: never "items").
    static func groupUnit(_ g: QueueGroup) -> String {
        switch g {
        case .signature: return "signature"
        case .session: return "session"
        case .delegation: return "delegation"
        default: return "episode"
        }
    }

    static let sorts: [(String, String)] = [("attention", "Attention"), ("recent", "Most Recent"), ("impact", "Impact"),
                                            ("attempts", "Attempts"), ("wall", "Wall Time"), ("sessions", "Sessions Seen")]

    /// The mark and color of a queue row (§7.6): its impact, alarm, silent child or claim.
    static func rowMark(_ r: QueueRow) -> (Mark?, NSColor) {
        switch r.kind {
        case .alarm: return (.alarm, Theme.err)
        case .delegation: return (.silentChild, Theme.err)
        case .claim: return (.claim, Theme.warn)
        case .signature:
            return r.signatureStatus?.rawValue == "regressed" ? (.regressed, Theme.warn) : (nil, .secondaryLabelColor)
        case .episode where r.impact != .blocked:
            if let o = r.outcome.flatMap(EpisodeOutcome.init(rawValue:)) { return outcomeMark(o) }
            fallthrough
        default:
            let impact = r.impact ?? (r.outcome == "recovered" ? .recovered : .failed)
            return (Mark.impact(impact), impactColor(impact) == .tertiaryLabelColor ? .secondaryLabelColor : impactColor(impact))
        }
    }

    /// A queue row's outcome slot (§7.6 line 2): the outcome word in its impact color, the claim status, the silent
    /// child's "silent · parent told: no", the alarm's state, or a signature's status.
    static func rowOutcome(_ r: QueueRow) -> (text: String, color: NSColor) {
        switch r.kind {
        case .alarm:
            return ((r.alarmKind.map(alarmWord) ?? "alarm") + " · " + (r.outcome ?? "firing"), r.outcome == "cleared" ? .secondaryLabelColor : Theme.err)
        case .claim:
            switch r.outcome {
            case "no-test-in-turn": return ("no test run", Theme.warn)
            case "edited-after-last-test": return ("edited after test", Theme.warn)
            case "last-test-failed": return ("last test failed", Theme.warn)
            case "passed-after-last-edit": return ("verified", .secondaryLabelColor)
            default: return ("unverified", Theme.warn)
            }
        case .delegation:
            return ("silent · parent told: no", Theme.err)
        case .signature:
            let status = r.signatureStatus?.rawValue ?? "signature"
            return (status, status == "regressed" ? Theme.warn : status == "new" ? Theme.note : .secondaryLabelColor)
        case .episode:
            if r.impact == .blocked { return ("blocked", Theme.err) }
            let o = EpisodeOutcome(rawValue: r.outcome ?? "")
            let (_, color) = outcomeMark(o)
            return (r.outcome == "open" ? "open" : outcomeWord(r.outcome), color == .secondaryLabelColor ? .secondaryLabelColor : color)
        default:
            return (r.impact?.rawValue ?? "session", r.impact.map { $0.isProblem ? impactColor($0) : .secondaryLabelColor } ?? .secondaryLabelColor)
        }
    }

    /// The word beside a row's glyph.
    static func rowWord(_ r: QueueRow) -> String {
        switch r.kind {
        case .alarm: return r.alarmKind.map(alarmWord) ?? "alarm"
        case .signature: return r.signatureStatus?.rawValue ?? "signature"
        case .session: return r.impact?.rawValue ?? "session"
        default: return outcomeWord(r.outcome)
        }
    }

    // MARK: Provenance

    /// A value with its provenance mark after it, with no space (§3.3): `1m 12s≈`, `exit 2~`, `200k?`.
    static func marked(_ text: String, _ prov: Prov?) -> String { text + (prov?.mark ?? "") }

    static func provHelp(_ prov: Prov?, analysis: AnalysisStatus?) -> String {
        guard let prov else { return "Provenance not reported." }
        if prov.family == .inferred { return analysis?.ruleNote(prov) ?? "Inferred by rule \(prov.rule ?? prov.rawValue)." }
        switch prov.family {
        case .logged: return "Logged by the agent" + (prov.rawValue.contains(":") ? " (\(prov.rawValue.dropFirst(7)))" : "") + "."
        case .derived: return "Derived from logged values" + (prov.rawValue.contains(":") ? " (\(prov.rawValue.dropFirst(8)))" : "") + " (≈)."
        case .parsed: return "Parsed from output text" + (prov.rawValue.contains(":") ? " (\(prov.rawValue.dropFirst(7)))" : "") + " (~)."
        case .inferred: return prov.rawValue
        }
    }

    // MARK: Sparkline

    /// Points for a per-day sparkline in `size`.
    static func sparkline(_ daily: DailyCounts, in rect: CGRect) -> [CGPoint] {
        let n = daily.n
        guard n.count > 1, let maxN = n.max(), maxN > 0 else { return [] }
        let dx = rect.width / CGFloat(n.count - 1)
        return n.enumerated().map { i, v in
            CGPoint(x: rect.minX + CGFloat(i) * dx, y: rect.maxY - CGFloat(v) / CGFloat(maxN) * rect.height)
        }
    }
}

/// Words for interventions (SPEC §12.3.8). `nearEpisode` records association only, never a cause.
enum InterventionStyle {
    static let symbol = "hand.raised"

    static func word(_ k: InterventionKind) -> String {
        switch k.rawValue {
        case "abort-child": return "child aborted"
        case "permission-decision": return "permission decision"
        default: return k.rawValue.replacingOccurrences(of: "-", with: " ")
        }
    }

    static func actorWord(_ actor: String) -> String {
        switch actor {
        case "parent-or-human": return "the parent agent or a person (data limit 3)"
        case "human": return "a person"
        case "policy": return "a policy"
        case "hook": return "a hook"
        case "harness": return "the harness"
        default: return actor
        }
    }

    /// "Interrupt by a person, logged (turn_aborted). Waited 2m 10s. Within 3 calls of an episode (association only)."
    static func help(_ iv: InterventionItem, analysis: AnalysisStatus?) -> String {
        var parts = ["\(word(iv.kind).prefix(1).uppercased() + word(iv.kind).dropFirst()) by \(actorWord(iv.actor)): \(DerivedStyle.provHelp(iv.actorSrc, analysis: analysis))"]
        if let w = iv.waitUs { parts.append("Waited \(Formatters.duration(w)) for the answer.") }
        if iv.nearEpisode != nil { parts.append("Within 3 calls of a failure episode (association only, not a cause).") }
        return parts.joined(separator: " ")
    }

    /// "2 interrupts · 1 child aborted · 1 question" for the Run report.
    static func summary(_ byKind: [String: Int]) -> String {
        InterventionKind.known.compactMap { k in byKind[k.rawValue].flatMap { $0 > 0 ? counted(k, $0) : nil } }.joined(separator: " · ")
    }

    /// "1 interrupt", "2 children aborted", "3 tool calls rejected".
    static func counted(_ k: InterventionKind, _ n: Int) -> String {
        let forms: (String, String)
        switch k.rawValue {
        case "abort-child": forms = ("child aborted", "children aborted")
        case "tool-rejected": forms = ("tool call rejected", "tool calls rejected")
        case "policy-rejected": forms = ("policy rejection", "policy rejections")
        case "hook-blocked": forms = ("hook block", "hook blocks")
        default: forms = (word(k), word(k) + "s")
        }
        return "\(Formatters.count(n)) \(n == 1 ? forms.0 : forms.1)"
    }
}

/// A per-day sparkline (signature history).
struct SparklineView: View {
    let daily: DailyCounts
    var color: Color = .secondary

    var body: some View {
        Canvas { ctx, size in
            let pts = DerivedStyle.sparkline(daily, in: CGRect(origin: .zero, size: size).insetBy(dx: 1, dy: 1))
            guard pts.count > 1 else { return }
            var p = Path()
            p.addLines(pts)
            ctx.stroke(p, with: .color(color), lineWidth: 1.2)
        }
        .accessibilityLabel("Daily counts, last \(daily.n.count) days, peak \(daily.n.max() ?? 0)")
    }
}
