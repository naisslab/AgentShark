import Foundation

/// Builds display-filter fragments for Apply/Prepare as Filter and drill-down actions.
enum FilterExpression {
    /// A double-quoted filter string literal.
    static func quote(_ s: String) -> String {
        var out = "\""
        for ch in s {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\t": out += "\\t"
            case "\r": out += "\\r"
            default: out.append(ch)
            }
        }
        return out + "\""
    }

    /// Literal for a scalar JSON value; nil for null and containers.
    static func literal(_ v: JSONValue) -> String? {
        switch v {
        case .string(let s): return quote(s)
        case .number(let d): return JSONValue.format(d)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }

    /// `field == value`. Booleans become the bare field (`tool.is_error`) or its negation; null becomes `!field`.
    static func equals(field: String, value: JSONValue) -> String? {
        switch value {
        case .bool(true): return field
        case .bool(false), .null: return "!\(field)"
        default: return literal(value).map { "\(field) == \($0)" }
        }
    }

    static func session(_ id: String) -> String { "session == \(quote(id))" }
    static func kind(_ kind: EventKind) -> String { "kind == \(quote(kind.rawValue))" }
    static func tool(_ name: String) -> String { "tool.name == \(quote(name))" }
    static func model(_ name: String) -> String { "model == \(quote(name))" }

    /// `ts >= from && ts <= to` with epoch µs (either end may be open).
    static func timeRange(from: Int64?, to: Int64?) -> String? {
        let parts = [from.map { "ts >= \($0)" }, to.map { "ts <= \($0)" }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " && ")
    }

    /// EventRow keys → filter fields.
    static let eventFields: [String: String] = [
        "id": "id", "session": "session", "agent": "agent", "ts": "ts", "tsSrc": "ts_src", "seq": "seq", "kind": "kind",
        "proto": "proto", "actor": "actor", "summary": "summary", "span": "span", "turn": "turn", "toolName": "tool.name",
        "model": "model", "dur": "dur", "tokIn": "tokens.input", "tokOut": "tokens.output",
    ]

    /// Filter field for a pointer in the composite document (`/event/…`, `/attrs/…`, `/native/…`), when the
    /// path has no array index. Engines that send `fieldMap` make this a fallback only.
    static func field(forPointer pointer: String) -> String? {
        let tokens = pointer.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map {
            JSONValue.unescapePointerToken(String($0))
        }
        guard tokens.count >= 2 else { return nil }
        let path = tokens.dropFirst()
        guard path.allSatisfy({ !$0.isEmpty && Int($0) == nil && !$0.contains(".") && !$0.contains(" ") }) else { return nil }
        switch tokens[0] {
        case "event": return path.count == 1 ? eventFields[path.first!] : nil
        case "attrs": return path.joined(separator: ".")
        case "native": return "native." + path.joined(separator: ".")
        default: return nil
        }
    }

    /// The fragment for a selected detail node: from the engine's `fieldMap`, else derived from the pointer.
    static func fragment(forPointer pointer: String, in detail: EventDetail) -> String? {
        if let ref = detail.fieldMap?[pointer] { return equals(field: ref.field, value: ref.value) }
        // `/event/flags/N` is a flag word, which is a filter by itself.
        if pointer.hasPrefix("/event/flags/"), let flag = detail.compositeDocument.pointer(pointer)?.stringValue { return flag }
        guard let field = field(forPointer: pointer), let value = detail.compositeDocument.pointer(pointer) else { return nil }
        return equals(field: field, value: value)
    }
}
