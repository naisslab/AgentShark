import AppKit
import Foundation

/// Pretty-printing and syntax coloring for the raw pane.
enum RawJSON {
    enum TokenKind: Hashable { case key, string, number, literal, punctuation }

    /// Pretty-printed JSON (2-space indent, source key order) and each pointer's value range in it (UTF-16).
    static func pretty(_ value: JSONValue) -> (text: String, ranges: [String: NSRange]) {
        var out = ""
        var length = 0
        var ranges: [String: NSRange] = [:]
        func emit(_ s: String) {
            out += s
            length += s.utf16.count
        }
        func write(_ v: JSONValue, pointer: String, level: Int) {
            let start = length
            switch v {
            case .object(let o) where !o.isEmpty:
                emit("{\n")
                for (i, (k, x)) in o.enumerated() {
                    emit(String(repeating: "  ", count: level + 1))
                    var key = ""
                    JSONValue.writeQuoted(k, to: &key)
                    emit(key + ": ")
                    write(x, pointer: pointer + "/" + JSONValue.escapePointerToken(k), level: level + 1)
                    emit(i + 1 < o.count ? ",\n" : "\n")
                }
                emit(String(repeating: "  ", count: level) + "}")
            case .array(let a) where !a.isEmpty:
                emit("[\n")
                for (i, x) in a.enumerated() {
                    emit(String(repeating: "  ", count: level + 1))
                    write(x, pointer: "\(pointer)/\(i)", level: level + 1)
                    emit(i + 1 < a.count ? ",\n" : "\n")
                }
                emit(String(repeating: "  ", count: level) + "]")
            default:
                emit(v.compactText)
            }
            ranges[pointer] = NSRange(location: start, length: length - start)
        }
        write(value, pointer: "", level: 0)
        return (out, ranges)
    }

    /// Token ranges of JSON text (pretty or exact), for coloring. Tolerates invalid JSON.
    static func tokens(in text: NSString) -> [(range: NSRange, kind: TokenKind)] {
        var out: [(NSRange, TokenKind)] = []
        let n = text.length
        var i = 0
        let buffer = UnsafeMutablePointer<unichar>.allocate(capacity: max(n, 1))
        defer { buffer.deallocate() }
        text.getCharacters(buffer, range: NSRange(location: 0, length: n))
        while i < n {
            let c = buffer[i]
            switch c {
            case 0x22: // "
                let start = i
                i += 1
                while i < n {
                    if buffer[i] == 0x5C { i += 2; continue }
                    if buffer[i] == 0x22 { i += 1; break }
                    i += 1
                }
                i = min(i, n)
                // A string followed by ':' is a key.
                var j = i
                while j < n, buffer[j] == 0x20 || buffer[j] == 0x0A || buffer[j] == 0x09 || buffer[j] == 0x0D { j += 1 }
                out.append((NSRange(location: start, length: i - start), j < n && buffer[j] == 0x3A ? .key : .string))
            case 0x2D, 0x30...0x39: // - 0-9
                let start = i
                while i < n, let u = UnicodeScalar(buffer[i]), "0123456789+-.eE".unicodeScalars.contains(u) { i += 1 }
                out.append((NSRange(location: start, length: i - start), .number))
            case 0x74, 0x66, 0x6E: // t f n
                let start = i
                while i < n, buffer[i] >= 0x61, buffer[i] <= 0x7A { i += 1 }
                out.append((NSRange(location: start, length: i - start), .literal))
            case 0x7B, 0x7D, 0x5B, 0x5D, 0x3A, 0x2C: // { } [ ] : ,
                out.append((NSRange(location: i, length: 1), .punctuation))
                i += 1
            default:
                i += 1
            }
        }
        return out
    }

    /// Raw stays neutral (§5.2, §7.11): red means failure elsewhere, so no token takes a hue. Keys and punctuation are
    /// muted so the values read first.
    static func color(_ kind: TokenKind) -> NSColor {
        switch kind {
        case .key, .punctuation: return .secondaryLabelColor
        case .string, .number, .literal: return .labelColor
        }
    }

    /// Colored text in `font`.
    static func attributed(_ text: String, font: NSFont) -> NSAttributedString {
        let out = NSMutableAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor.labelColor])
        // Coloring a multi-megabyte record would stall the main thread; such text stays plain.
        guard out.length <= 2_000_000 else { return out }
        out.beginEditing()
        for t in tokens(in: out.string as NSString) {
            out.addAttribute(.foregroundColor, value: color(t.kind), range: t.range)
        }
        out.endEditing()
        return out
    }

    /// The innermost pointer whose range contains `location`.
    static func pointer(containing location: Int, in ranges: [String: NSRange]) -> String? {
        var best: (String, Int)?
        for (p, r) in ranges where r.location <= location && location < max(NSMaxRange(r), r.location + 1) {
            if best == nil || r.length < best!.1 { best = (p, r.length) }
        }
        return best?.0
    }

    /// The value of `pointer` in a raw record's text (for full-length strings and embedded images).
    static func value(at pointer: String, inRecord text: String) -> JSONValue? {
        (try? JSONValue.parse(text))?.pointer(pointer)
    }
}
