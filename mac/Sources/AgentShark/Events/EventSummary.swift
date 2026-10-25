import Foundation

/// The Events Summary in the §9 form: "exec_command · git push origin main · exit 128". The adapters write fields
/// separated by two spaces, with durations as "(75.0 s)" and "ttft 11.2 s"; this joins them with " · ", writes every
/// duration in the §9 format, drops a duration the Duration column already shows (Principle 2), and spells out "ttft".
/// Prose (prompts, messages, thinking) stays as written.
enum EventSummary {
    /// Kinds whose summary is the agent's or the person's own words.
    private static let proseLayers: Set<String> = ["user", "agent"]
    private static let proseKinds: Set<String> = ["llm.text", "llm.thinking"]

    private static let separator = try! NSRegularExpression(pattern: #"\s{2,}"#)
    /// A whole field that is a duration: "(75.0 s)", "10.0 s", "820ms".
    private static let pureDuration = try! NSRegularExpression(pattern: #"^\(?(\d+(?:\.\d+)?)\s?(µs|ms|s)\)?$"#)
    /// A labeled duration: "ttft 11.2 s", "wait 3.0 s".
    private static let labeledDuration = try! NSRegularExpression(pattern: #"^([a-z][a-z ]*?)\s+(\d+(?:\.\d+)?)\s?(µs|ms|s)$"#)

    /// `durationShown`: the row's Duration column shows a figure, so a bare duration field repeats it.
    static func display(_ summary: String, kind: EventKind, durationShown: Bool) -> String {
        if proseLayers.contains(kind.layer) || proseKinds.contains(kind.rawValue) { return summary }
        let ns = summary as NSString
        var fields: [String] = []
        var start = 0
        for m in separator.matches(in: summary, range: NSRange(location: 0, length: ns.length)) {
            fields.append(ns.substring(with: NSRange(location: start, length: m.range.location - start)))
            start = m.range.location + m.range.length
        }
        fields.append(ns.substring(from: start))
        guard fields.count > 1 || pureDuration.firstMatch(in: summary, range: NSRange(location: 0, length: ns.length)) != nil else { return summary }
        let out = fields.compactMap { field(String($0), durationShown: durationShown) }
        return out.isEmpty ? summary : out.joined(separator: " · ")
    }

    /// One field in the §9 form, or nil when it repeats the Duration column.
    private static func field(_ raw: String, durationShown: Bool) -> String? {
        var f = raw.trimmingCharacters(in: .whitespaces)
        for arrow in ["→ ", "← "] where f.hasPrefix(arrow) { f.removeFirst(arrow.count) }
        if f.isEmpty { return nil }
        let r = NSRange(location: 0, length: (f as NSString).length)
        if let m = pureDuration.firstMatch(in: f, range: r) {
            if durationShown { return nil }
            return micros(f, m, value: 1, unit: 2).map(Formatters.duration) ?? f
        }
        if let m = labeledDuration.firstMatch(in: f, range: r), let us = micros(f, m, value: 2, unit: 3) {
            var label = (f as NSString).substring(with: m.range(at: 1))
            if label == "ttft" { label = "first token" }
            return label + " " + Formatters.duration(us)
        }
        return f
    }

    private static func micros(_ s: String, _ m: NSTextCheckingResult, value: Int, unit: Int) -> Int64? {
        let ns = s as NSString
        guard let v = Double(ns.substring(with: m.range(at: value))) else { return nil }
        switch ns.substring(with: m.range(at: unit)) {
        case "µs": return Int64(v.rounded())
        case "ms": return Int64((v * 1000).rounded())
        default: return Int64((v * 1_000_000).rounded())
        }
    }
}
