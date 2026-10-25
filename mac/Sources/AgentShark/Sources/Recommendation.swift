import Foundation

/// A logging-health recommendation split into readable prose and copy-ready code (FEEDBACK F13): a Copy button
/// only ever copies code, never the explanation around it.
struct Recommendation: Hashable {
    /// One block of the recommendation, in order.
    enum Block: Hashable {
        /// Verbatim text from the engine.
        case prose(String)
        /// Code that runs or pastes as is; `label` says where it goes.
        case code(label: String, text: String)
    }

    let blocks: [Block]
    /// What following the advice changes, for example that it configures a system AgentShark does not read.
    let effect: String?
    /// Configuration files the text names (`~/.claude/settings.json`), for Reveal in Finder.
    let configFiles: [String]
    /// The text suggests `agentshark capture`.
    let suggestsCapture: Bool

    static let externalCollectorEffect = "Configures an external OTLP collector; AgentShark does not ingest this data."

    /// From the engine's value: `{text, code: {lang, snippet}, effect}`, or plain text from older engines.
    init(_ value: JSONValue) {
        guard let o = value.objectValue else {
            self.init(text: value.stringValue ?? "")
            return
        }
        let text = o["text"]?.stringValue ?? ""
        let code: [Block] = (o["code"].map(Self.list) ?? []).compactMap { c in
            if let snippet = c.stringValue { return .code(label: Self.label(forCode: snippet), text: snippet) }
            guard let snippet = c["snippet"]?.stringValue ?? c["code"]?.stringValue else { return nil }
            return .code(label: Self.label(forLanguage: c["lang"]?.stringValue) ?? Self.label(forCode: snippet), text: snippet)
        }
        // Structured advice keeps prose and code apart; older text still needs its code pulled out.
        let prose = code.isEmpty ? Recommendation(text: text).blocks : (text.isEmpty ? [] : [.prose(text)])
        let snippets = code.compactMap { if case .code(_, let t) = $0 { return t } else { return nil } }
        self.init(blocks: prose + code, source: ([text] + snippets).joined(separator: "\n"), effect: o["effect"]?.stringValue)
    }

    init(text: String) {
        var blocks: [Block] = []
        for sentence in Self.sentences(text) {
            let (code, rest) = Self.extractCode(sentence)
            // A sentence that is nothing but code is shown only as code.
            if rest.split(whereSeparator: \.isWhitespace).count > 2 { blocks.append(.prose(sentence)) }
            blocks += code.map { .code(label: $0.label, text: $0.text) }
        }
        // Merge consecutive prose sentences into paragraphs.
        var merged: [Block] = []
        for b in blocks {
            if case .prose(let s) = b, case .prose(let prev)? = merged.last {
                merged[merged.count - 1] = .prose(prev + " " + s)
            } else {
                merged.append(b)
            }
        }
        self.init(blocks: merged, source: text, effect: nil)
    }

    private init(blocks: [Block], source: String, effect: String?) {
        self.blocks = blocks
        let mentionsOTLP = source.contains("OTLP") || source.localizedCaseInsensitiveContains("OpenTelemetry")
        self.effect = effect ?? (mentionsOTLP ? Self.externalCollectorEffect : nil)
        configFiles = Self.matches(#"~/[\w.\-/]+\.(?:json|toml)"#, in: source).reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
        suggestsCapture = source.contains("agentshark capture")
    }

    // MARK: Parsing

    private static func list(_ v: JSONValue) -> [JSONValue] { v.arrayValue ?? [v] }

    /// Sentences: split after `.`, `!` or `?` when a capital letter or a backtick follows.
    static func sentences(_ text: String) -> [String] {
        let marked = text.replacingOccurrences(of: #"(?<=[.!?])\s+(?=[A-Z`])"#, with: "\u{0}", options: .regularExpression)
        return marked.split(separator: "\u{0}").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    /// Code in one sentence and the words left around it.
    static func extractCode(_ sentence: String) -> (code: [(label: String, text: String)], rest: String) {
        var code: [(label: String, text: String)] = []
        var rest = sentence

        // Fenced or backticked commands.
        for span in matches(#"```[\w-]*\n?([\s\S]*?)```|`([^`\n]+)`"#, in: sentence, group: [1, 2]) {
            let s = span.trimmingCharacters(in: .whitespacesAndNewlines)
            guard isCommand(s) else { continue }
            code.append((label: label(forCode: s), text: normalizeCommand(s)))
            rest = rest.replacingOccurrences(of: span, with: "")
        }

        // TOML: `[table] key = value` with a balanced inline-table value.
        if let toml = tomlSnippet(in: sentence) {
            code.append((label: "TOML", text: toml.code))
            rest = rest.replacingOccurrences(of: toml.source, with: "")
        }

        // Environment variables: `NAME=value` assignments become one `export` line.
        let assignments = matches(#"\b[A-Z][A-Z0-9_]{2,}=[^\s,;`]+"#, in: rest).map { a -> String in
            var a = a
            while a.hasSuffix(".") || a.hasSuffix(")") { a.removeLast() }
            return a
        }
        if !assignments.isEmpty {
            code.append((label: "Shell", text: "export " + assignments.joined(separator: " ")))
            for a in assignments { rest = rest.replacingOccurrences(of: a, with: "") }
            rest = rest.replacingOccurrences(of: "export", with: "")
        }
        return (code, rest)
    }

    private static let commandWords: Set<String> = ["agentshark", "export", "mkdir", "npm", "node", "codex", "claude", "defaults", "launchctl"]

    /// A backticked span that runs in a shell, as opposed to a field name such as `cleanupPeriodDays`.
    static func isCommand(_ s: String) -> Bool {
        guard let first = s.split(separator: " ").first.map(String.init) else { return false }
        return commandWords.contains(first) && s.contains(" ")
    }

    static func label(forLanguage lang: String?) -> String? {
        switch lang {
        case "sh", "shell", "bash", "zsh": return "Shell"
        case "toml": return "TOML"
        case "json": return "JSON"
        default: return nil
        }
    }

    static func label(forCode s: String) -> String {
        if s.hasPrefix("[") { return "TOML" }
        if s.hasPrefix("{") { return "JSON" }
        return "Shell"
    }

    /// Make an example command runnable: a `<date>` placeholder becomes today's date from `date`, and the folder of
    /// a `-o ~/folder/file` output is created first.
    static func normalizeCommand(_ s: String) -> String {
        var cmd = s.replacingOccurrences(of: "<date>", with: "$(date +%Y-%m-%d)")
        if let out = matches(#"(?:^|\s)-o\s+(~/[^\s]+)/[^\s/]+"#, in: cmd, group: [1]).first, !cmd.hasPrefix("mkdir") {
            cmd = "mkdir -p \(out) && " + cmd
        }
        return cmd
    }

    /// `[otel] exporter = { … }` → "[otel]\nexporter = { … }", with the text it came from.
    static func tomlSnippet(in s: String) -> (code: String, source: String)? {
        guard let head = s.range(of: #"\[[A-Za-z_][\w.-]*\]\s+[A-Za-z_][\w-]*\s*=\s*"#, options: .regularExpression) else { return nil }
        var i = head.upperBound
        guard i < s.endIndex else { return nil }
        var depth = 0
        var inString = false
        let start = i
        while i < s.endIndex {
            let c = s[i]
            if inString {
                if c == "\"" { inString = false }
            } else if c == "\"" {
                inString = true
            } else if c == "{" {
                depth += 1
            } else if c == "}" {
                depth -= 1
                if depth == 0 { i = s.index(after: i); break }
            } else if depth == 0, c == "," || c.isWhitespace {
                break
            }
            i = s.index(after: i)
        }
        guard depth == 0, i > start else { return nil }
        let source = String(s[head.lowerBound..<i])
        guard let close = source.firstIndex(of: "]") else { return nil }
        let table = source[...close]
        let assignment = source[source.index(after: close)...].trimmingCharacters(in: .whitespaces)
        return ("\(table)\n\(assignment)", source)
    }

    static func matches(_ pattern: String, in s: String, group: [Int] = [0]) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            for g in group where g < m.numberOfRanges && m.range(at: g).location != NSNotFound {
                return ns.substring(with: m.range(at: g))
            }
            return nil
        }
    }
}
