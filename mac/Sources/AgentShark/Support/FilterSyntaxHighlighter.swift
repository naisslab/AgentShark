import AppKit

/// One token of a display filter, with its UTF-16 range (port of src/filter/lexer.ts, for coloring and completion).
struct FilterToken: Hashable, Sendable {
    enum Kind: Hashable, Sendable {
        /// A registered field name, or `native.…` / `attrs.…`.
        case field
        /// A layer (`tool`), a kind (`tool.call`), a flag (`error`), or `true`/`false`.
        case keyword
        /// `==`, `!=`, `<`, `&&`, `||`, `!`, `~`, `and`, `or`, `not`, `in`, `contains`, `matches`, `eq`, …
        case op
        case string
        case number
        /// `(`, `)`, `{`, `}`, `,`.
        case punctuation
        /// A bare word that is not a known field: a value such as `claude-code`, or a field still being typed.
        case word
        /// Text the lexer rejects: a single `=`, `&` or `|`, or an unterminated string.
        case invalid
    }

    var kind: Kind
    var range: NSRange
    var text: String
}

/// Syntax coloring for the filter field (MAC-SPEC §4).
enum FilterSyntaxHighlighter {
    static let layers: Set<String> = Set(EventKind.layers)
    static let flags: Set<String> = ["error", "inherited", "dup", "orphan", "inferred", "truncated", "abandoned", "meta", "sidechain"]
    static let wordOps: Set<String> = ["eq", "ne", "gt", "ge", "lt", "le", "and", "or", "not", "in", "contains", "matches"]
    private static let delimiters: Set<UInt16> = Set("(){},\"'=!<>&|~".utf16)
    private static let unitRegex = try! NSRegularExpression(pattern: #"^[+-]?(\d+(\.\d*)?|\.\d+)(us|µs|ms|s|m|min|h|d|k|K|M|KB|MB|GB)?$"#)

    /// Color the filter text. `fields` are the registered field names (`AppModel.fields`).
    static func highlight(_ text: String, fields: Set<String>) -> NSAttributedString {
        highlight(text, fields: fields, font: nil)
    }

    static func highlight(_ text: String, fields: Set<String>, font: NSFont?) -> NSAttributedString {
        var base: [NSAttributedString.Key: Any] = [.foregroundColor: NSColor.labelColor]
        if let font { base[.font] = font }
        let out = NSMutableAttributedString(string: text, attributes: base)
        for t in tokens(text, fields: fields) {
            out.addAttribute(.foregroundColor, value: color(t.kind), range: t.range)
            if t.kind == .invalid {
                out.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue | NSUnderlineStyle.patternDot.rawValue, range: t.range)
                out.addAttribute(.underlineColor, value: NSColor.systemRed, range: t.range)
            }
        }
        return out
    }

    static func color(_ kind: FilterToken.Kind) -> NSColor {
        switch kind {
        case .field: return .systemTeal
        case .keyword: return .systemPink
        case .op: return .systemPurple
        case .string: return .systemRed
        case .number: return .systemBlue
        case .punctuation: return .secondaryLabelColor
        case .word: return .labelColor
        case .invalid: return .systemRed
        }
    }

    /// Tokenize without throwing; errors become `.invalid` tokens.
    static func tokens(_ text: String, fields: Set<String> = []) -> [FilterToken] {
        let s = Array(text.utf16)
        let ns = text as NSString
        var out: [FilterToken] = []
        var i = 0
        var afterComparison = false
        func push(_ kind: FilterToken.Kind, _ start: Int, _ end: Int) {
            let r = NSRange(location: start, length: end - start)
            out.append(FilterToken(kind: kind, range: r, text: ns.substring(with: r)))
        }
        func isSpace(_ c: UInt16) -> Bool { c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D }
        while i < s.count {
            let c = s[i]
            if isSpace(c) { i += 1; continue }
            let start = i
            let next: UInt16? = i + 1 < s.count ? s[i + 1] : nil
            switch c {
            case 0x28, 0x29, 0x7B, 0x7D, 0x2C: // ( ) { } ,
                i += 1
                push(.punctuation, start, i)
                afterComparison = false
                continue
            case 0x22, 0x27: // " '
                i += 1
                var closed = false
                while i < s.count {
                    if s[i] == 0x5C { i += 2; continue }
                    if s[i] == c { i += 1; closed = true; break }
                    i += 1
                }
                i = min(i, s.count)
                push(closed ? .string : .invalid, start, i)
                afterComparison = false
                continue
            case 0x3D: // =
                if next == 0x3D { i += 2; push(.op, start, i); afterComparison = true } else { i += 1; push(.invalid, start, i) }
                continue
            case 0x21: // !
                if next == 0x3D { i += 2; afterComparison = true } else { i += 1; afterComparison = false }
                push(.op, start, i)
                continue
            case 0x3C, 0x3E: // < >
                i += next == 0x3D ? 2 : 1
                push(.op, start, i)
                afterComparison = true
                continue
            case 0x26, 0x7C: // & |
                if next == c { i += 2; push(.op, start, i) } else { i += 1; push(.invalid, start, i) }
                afterComparison = false
                continue
            case 0x7E: // ~
                i += 1
                push(.op, start, i)
                afterComparison = true
                continue
            default:
                break
            }
            while i < s.count, !delimiters.contains(s[i]), !isSpace(s[i]) { i += 1 }
            let word = ns.substring(with: NSRange(location: start, length: i - start))
            let lower = word.lowercased()
            if wordOps.contains(lower) {
                push(.op, start, i)
                afterComparison = ["eq", "ne", "gt", "ge", "lt", "le", "contains", "matches"].contains(lower)
                continue
            }
            if unitRegex.firstMatch(in: word, range: NSRange(location: 0, length: (word as NSString).length)) != nil {
                push(.number, start, i)
            } else if lower == "true" || lower == "false" {
                push(.keyword, start, i)
            } else if afterComparison {
                push(.word, start, i)
            } else if layers.contains(word) || flags.contains(word) || isKindName(word) {
                push(.keyword, start, i)
            } else if fields.contains(word) || word.hasPrefix("native.") || word.hasPrefix("attrs.") {
                push(.field, start, i)
            } else {
                push(.word, start, i)
            }
            afterComparison = false
        }
        // A layer or flag word that is also a field (`agent`, `turn`) is a field when a comparison follows it.
        for k in out.indices.dropLast() where out[k].kind == .keyword && fields.contains(out[k].text) && isComparison(out[k + 1]) {
            out[k].kind = .field
        }
        return out
    }

    private static func isComparison(_ t: FilterToken) -> Bool {
        guard t.kind == .op else { return false }
        return !["&&", "||", "!", "and", "or", "not"].contains(t.text.lowercased())
    }

    /// The token under (or just before) a caret position, for completion.
    static func token(at caret: Int, in text: String, fields: Set<String> = []) -> FilterToken? {
        tokens(text, fields: fields).last { $0.range.location <= caret && caret <= NSMaxRange($0.range) }
    }

    private static func isKindName(_ word: String) -> Bool {
        guard let dot = word.firstIndex(of: "."), layers.contains(String(word[..<dot])) else { return false }
        return knownKinds.contains(word)
    }

    private static let knownKinds: Set<String> = [
        "session.meta", "session.state", "user.prompt", "user.inject", "llm.text", "llm.thinking", "llm.usage", "llm.error",
        "llm.refusal", "tool.call", "tool.result", "tool.exec", "agent.spawn", "agent.message", "agent.status",
        "context.attachment", "context.compaction", "context.snapshot", "turn.start", "turn.end", "turn.abort", "hook.run",
        "permission.request", "permission.decision", "harness.queue", "harness.ratelimit", "harness.status", "harness.file",
        "harness.vcs", "harness.other", "raw.unknown",
    ]
}
