import Foundation
import SwiftUI

/// Message text split into blocks. Paragraphs carry inline Markdown (bold, italic, code spans); code fences, tables
/// and quotes keep their text. Links never become clickable: their URL is shown after the text instead, because
/// transcripts are untrusted input.
enum MessageBlock: Hashable {
    case paragraph(AttributedString)
    case heading(AttributedString)
    case code(language: String?, text: String)
    case table(String)
    case quote(AttributedString)

    private static let fence = try! NSRegularExpression(pattern: #"^\s*(`{3,}|~{3,})\s*([\w+#.-]*)"#)
    private static let heading = try! NSRegularExpression(pattern: #"^\s{0,3}#{1,6}\s+(.*)$"#)
    private static let table = try! NSRegularExpression(pattern: #"^\s*\|.*\|\s*$"#)
    private static let quote = try! NSRegularExpression(pattern: #"^\s*>\s?(.*)$"#)
    private static let bullet = try! NSRegularExpression(pattern: #"^(\s*)[-*+]\s+"#)

    /// Parse Markdown into blocks.
    static func parse(_ source: String) -> [MessageBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var out: [MessageBlock] = []
        var i = 0
        func isBlockStart(_ l: String) -> Bool {
            match(fence, l) != nil || match(heading, l) != nil || match(table, l) != nil || match(quote, l) != nil
        }
        while i < lines.count {
            let line = lines[i]
            if let m = match(fence, line) {
                let marker = m[1]
                let close = String(repeating: marker.first!, count: marker.count)
                var body: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(close) {
                    body.append(lines[i])
                    i += 1
                }
                i += 1
                out.append(.code(language: m[2].isEmpty ? nil : m[2], text: body.joined(separator: "\n")))
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                i += 1
            } else if let m = match(heading, line) {
                out.append(.heading(inline(m[1])))
                i += 1
            } else if match(table, line) != nil {
                var rows: [String] = []
                while i < lines.count, match(table, lines[i]) != nil {
                    rows.append(lines[i].trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                out.append(.table(rows.joined(separator: "\n")))
            } else if match(quote, line) != nil {
                var rows: [String] = []
                while i < lines.count, let m = match(quote, lines[i]) {
                    rows.append(m[1])
                    i += 1
                }
                out.append(.quote(inline(rows.joined(separator: "\n"))))
            } else {
                var para = [line]
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty, !isBlockStart(lines[i]) {
                    para.append(lines[i])
                    i += 1
                }
                let text = para.map { bulletize($0) }.joined(separator: "\n")
                out.append(.paragraph(inline(text)))
            }
        }
        return out
    }

    /// `- item` → `• item`, keeping the indentation.
    private static func bulletize(_ line: String) -> String {
        guard let m = match(bullet, line) else { return line }
        return m[1] + "• " + line.dropFirst(m[0].count)
    }

    /// Inline Markdown with links neutralized.
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(allowsExtendedAttributes: false,
                                                              interpretedSyntax: .inlineOnlyPreservingWhitespace,
                                                              failurePolicy: .returnPartiallyParsedIfPossible)
        guard let parsed = try? AttributedString(markdown: text, options: options) else { return AttributedString(text) }
        var out = AttributedString()
        for (url, range) in parsed.runs[\.link] {
            var piece = AttributedString(parsed[range])
            guard let url else {
                out += piece
                continue
            }
            piece.link = nil
            piece.underlineStyle = .single
            out += piece
            if String(parsed[range].characters) != url.absoluteString {
                var suffix = AttributedString(" (\(url.absoluteString))")
                suffix.foregroundColor = .secondary
                out += suffix
            }
        }
        return out
    }

    /// Mark every case-insensitive occurrence of `query` with the find highlight.
    static func highlighted(_ text: AttributedString, _ query: String) -> AttributedString {
        guard !query.isEmpty else { return text }
        var out = text
        var start = out.startIndex
        while start < out.endIndex, let r = out[start...].range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) {
            out[r].backgroundColor = Color(nsColor: .findHighlightColor).opacity(0.55)
            start = r.upperBound
        }
        return out
    }

    /// Plain text of the block, for search.
    var plainText: String {
        switch self {
        case .paragraph(let a), .heading(let a), .quote(let a): return String(a.characters)
        case .code(_, let t), .table(let t): return t
        }
    }

    private static func match(_ re: NSRegularExpression, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }
}
