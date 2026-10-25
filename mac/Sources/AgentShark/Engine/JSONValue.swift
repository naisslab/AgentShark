import Foundation

/// Polymorphic JSON (`attrs`, `native`, `meta`, tool `input`). Objects keep their key order.
///
/// `JSONDecoder` does not report object keys in source order, so values decoded through `Codable`
/// list keys alphabetically. `JSONValue.parse(_:)` is an order-preserving parser; `APIClient` uses it
/// for the payloads whose order matters to people (an event's `attrs` and `native` record).
indirect enum JSONValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)
}

/// An ordered JSON object. It reads like a dictionary (`obj["key"]`, `keys`, `count`) and iterates
/// `(key, value)` pairs in source order.
struct JSONObject: Hashable, Sendable, RandomAccessCollection, ExpressibleByDictionaryLiteral {
    private(set) var keys: [String] = []
    private var storage: [String: JSONValue] = [:]

    init() {}

    init(_ pairs: [(String, JSONValue)]) {
        for (k, v) in pairs { self[k] = v }
    }

    init(_ dictionary: [String: JSONValue]) {
        for k in dictionary.keys.sorted() { self[k] = dictionary[k] }
    }

    init(dictionaryLiteral elements: (String, JSONValue)...) {
        self.init(elements)
    }

    /// A repeated key keeps its first position and its last value, as in JavaScript.
    subscript(key: String) -> JSONValue? {
        get { storage[key] }
        set {
            if let newValue {
                if storage.updateValue(newValue, forKey: key) == nil { keys.append(key) }
            } else if storage.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    var values: [JSONValue] { keys.map { storage[$0]! } }
    var dictionary: [String: JSONValue] { storage }

    var startIndex: Int { 0 }
    var endIndex: Int { keys.count }
    subscript(position: Int) -> (key: String, value: JSONValue) {
        let k = keys[position]
        return (k, storage[k]!)
    }
}

extension JSONValue {
    // MARK: Accessors

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    subscript(index: Int) -> JSONValue? {
        if case .array(let a) = self, a.indices.contains(index) { return a[index] }
        return nil
    }

    /// Ordered key/value pairs of an object, nil for other values.
    var orderedObject: [(String, JSONValue)]? {
        if case .object(let o) = self { return o.map { ($0.key, $0.value) } }
        return nil
    }

    var objectValue: JSONObject? {
        if case .object(let o) = self { return o }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var doubleValue: Double? {
        if case .number(let d) = self { return d }
        return nil
    }

    var int64Value: Int64? {
        guard case .number(let d) = self, d.rounded() == d, abs(d) < 9.2e18 else { return nil }
        return Int64(d)
    }

    var intValue: Int? { int64Value.map { Int($0) } }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    var isNull: Bool { self == .null }

    /// Scalars and empty containers have no children.
    var isContainer: Bool {
        switch self {
        case .array, .object: return true
        default: return false
        }
    }

    var childCount: Int {
        switch self {
        case .array(let a): return a.count
        case .object(let o): return o.count
        default: return 0
        }
    }

    /// JSON type name for the detail outline's annotation column.
    var typeName: String {
        switch self {
        case .null: return "null"
        case .bool: return "boolean"
        case .number: return "number"
        case .string: return "string"
        case .array: return "array"
        case .object: return "object"
        }
    }

    /// RFC 6901 JSON Pointer lookup. "" is the whole value.
    func pointer(_ jsonPointer: String) -> JSONValue? {
        if jsonPointer.isEmpty { return self }
        guard jsonPointer.hasPrefix("/") else { return nil }
        var current: JSONValue = self
        for raw in jsonPointer.dropFirst().split(separator: "/", omittingEmptySubsequences: false) {
            let token = JSONValue.unescapePointerToken(String(raw))
            switch current {
            case .object(let o):
                guard let next = o[token] else { return nil }
                current = next
            case .array(let a):
                guard let i = Int(token), a.indices.contains(i) else { return nil }
                current = a[i]
            default:
                return nil
            }
        }
        return current
    }

    static func escapePointerToken(_ token: String) -> String {
        token.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1")
    }

    static func unescapePointerToken(_ token: String) -> String {
        token.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
    }

    // MARK: Text

    /// Value text for a detail row: strings unquoted, integers without a fraction, containers summarized.
    var displayText: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let d): return JSONValue.format(d)
        case .string(let s): return s
        case .array(let a): return a.isEmpty ? "[]" : "[\(a.count) item\(a.count == 1 ? "" : "s")]"
        case .object(let o): return o.isEmpty ? "{}" : "{\(o.count) field\(o.count == 1 ? "" : "s")}"
        }
    }

    /// Compact single-line JSON.
    var compactText: String {
        var out = ""
        write(to: &out, indent: nil, level: 0)
        return out
    }

    /// Two-space indented JSON in key order.
    var prettyPrinted: String {
        var out = ""
        write(to: &out, indent: "  ", level: 0)
        return out
    }

    static func format(_ d: Double) -> String {
        if d.rounded() == d, abs(d) < 1e15 { return String(Int64(d)) }
        return String(d)
    }

    private func write(to out: inout String, indent: String?, level: Int) {
        switch self {
        case .null, .bool, .number:
            out += displayText
        case .string(let s):
            JSONValue.writeQuoted(s, to: &out)
        case .array(let a):
            if a.isEmpty { out += "[]"; return }
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                if let indent { out += "\n" + String(repeating: indent, count: level + 1) }
                v.write(to: &out, indent: indent, level: level + 1)
            }
            if let indent { out += "\n" + String(repeating: indent, count: level) }
            out += "]"
        case .object(let o):
            if o.isEmpty { out += "{}"; return }
            out += "{"
            for (i, (k, v)) in o.enumerated() {
                if i > 0 { out += "," }
                if let indent { out += "\n" + String(repeating: indent, count: level + 1) }
                JSONValue.writeQuoted(k, to: &out)
                out += indent == nil ? ":" : ": "
                v.write(to: &out, indent: indent, level: level + 1)
            }
            if let indent { out += "\n" + String(repeating: indent, count: level) }
            out += "}"
        }
    }

    static func writeQuoted(_ s: String, to out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where u.value < 0x20: out += String(format: "\\u%04x", u.value)
            default: out.unicodeScalars.append(u)
            }
        }
        out += "\""
    }
}

// MARK: - Codable

extension JSONValue: Codable {
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let d = try? c.decode(Double.self) { self = .number(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        // JSONDecoder does not expose key order; sort for a stable presentation.
        let d = try c.decode([String: JSONValue].self)
        self = .object(JSONObject(d))
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .null:
            var c = encoder.singleValueContainer()
            try c.encodeNil()
        case .bool(let b):
            var c = encoder.singleValueContainer()
            try c.encode(b)
        case .number(let d):
            var c = encoder.singleValueContainer()
            if let i = int64Value { try c.encode(i) } else { try c.encode(d) }
        case .string(let s):
            var c = encoder.singleValueContainer()
            try c.encode(s)
        case .array(let a):
            var c = encoder.unkeyedContainer()
            for v in a { try c.encode(v) }
        case .object(let o):
            var c = encoder.container(keyedBy: AnyKey.self)
            for (k, v) in o { try c.encode(v, forKey: AnyKey(k)) }
        }
    }
}

/// A coding key for arbitrary strings.
struct AnyKey: CodingKey, Hashable {
    let stringValue: String
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    var intValue: Int? { nil }
    init?(intValue: Int) { return nil }
}

// MARK: - Order-preserving parser

struct JSONParseError: Error, LocalizedError {
    let offset: Int
    let message: String
    var errorDescription: String? { "Invalid JSON at byte \(offset): \(message)" }
}

extension JSONValue {
    /// Parse JSON text, keeping object keys in source order.
    static func parse(_ data: Data) throws -> JSONValue {
        try data.withUnsafeBytes { raw in
            var p = OrderedJSONParser(bytes: raw.bindMemory(to: UInt8.self))
            p.skipWhitespace()
            let v = try p.parseValue(depth: 0)
            p.skipWhitespace()
            if p.i != p.bytes.count { throw p.error("unexpected trailing characters") }
            return v
        }
    }

    static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }
}

private struct OrderedJSONParser {
    let bytes: UnsafeBufferPointer<UInt8>
    var i = 0

    init(bytes: UnsafeBufferPointer<UInt8>) { self.bytes = bytes }

    func error(_ message: String) -> JSONParseError { JSONParseError(offset: i, message: message) }

    mutating func skipWhitespace() {
        while i < bytes.count {
            switch bytes[i] {
            case 0x20, 0x0A, 0x0D, 0x09: i += 1
            default: return
            }
        }
    }

    mutating func parseValue(depth: Int) throws -> JSONValue {
        guard depth < 512 else { throw error("nesting too deep") }
        guard i < bytes.count else { throw error("unexpected end of input") }
        switch bytes[i] {
        case UInt8(ascii: "{"): return try parseObject(depth: depth)
        case UInt8(ascii: "["): return try parseArray(depth: depth)
        case UInt8(ascii: "\""): return .string(try parseString())
        case UInt8(ascii: "t"): try expect("true"); return .bool(true)
        case UInt8(ascii: "f"): try expect("false"); return .bool(false)
        case UInt8(ascii: "n"): try expect("null"); return .null
        default: return .number(try parseNumber())
        }
    }

    mutating func expect(_ word: StaticString) throws {
        let w = UnsafeBufferPointer(start: word.utf8Start, count: word.utf8CodeUnitCount)
        guard i + w.count <= bytes.count else { throw error("unexpected end of input") }
        for (k, b) in w.enumerated() where bytes[i + k] != b { throw error("invalid literal") }
        i += w.count
    }

    mutating func parseObject(depth: Int) throws -> JSONValue {
        i += 1
        var obj = JSONObject()
        skipWhitespace()
        if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(obj) }
        while true {
            skipWhitespace()
            guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { throw error("expected a key") }
            let key = try parseString()
            skipWhitespace()
            guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { throw error("expected ':'") }
            i += 1
            skipWhitespace()
            obj[key] = try parseValue(depth: depth + 1)
            skipWhitespace()
            guard i < bytes.count else { throw error("unterminated object") }
            if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
            if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(obj) }
            throw error("expected ',' or '}'")
        }
    }

    mutating func parseArray(depth: Int) throws -> JSONValue {
        i += 1
        var items: [JSONValue] = []
        skipWhitespace()
        if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(items) }
        while true {
            skipWhitespace()
            items.append(try parseValue(depth: depth + 1))
            skipWhitespace()
            guard i < bytes.count else { throw error("unterminated array") }
            if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
            if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(items) }
            throw error("expected ',' or ']'")
        }
    }

    mutating func parseString() throws -> String {
        i += 1
        let start = i
        // Fast path: no escapes.
        while i < bytes.count {
            let b = bytes[i]
            if b == UInt8(ascii: "\"") {
                let s = String(decoding: UnsafeBufferPointer(rebasing: bytes[start..<i]), as: UTF8.self)
                i += 1
                return s
            }
            if b == UInt8(ascii: "\\") { break }
            i += 1
        }
        var scalars = String.UnicodeScalarView()
        var utf8: [UInt8] = Array(bytes[start..<i])
        func flush() {
            if !utf8.isEmpty {
                scalars.append(contentsOf: String(decoding: utf8, as: UTF8.self).unicodeScalars)
                utf8.removeAll(keepingCapacity: true)
            }
        }
        while i < bytes.count {
            let b = bytes[i]
            if b == UInt8(ascii: "\"") {
                i += 1
                flush()
                return String(scalars)
            }
            if b != UInt8(ascii: "\\") {
                utf8.append(b)
                i += 1
                continue
            }
            guard i + 1 < bytes.count else { break }
            let e = bytes[i + 1]
            i += 2
            switch e {
            case UInt8(ascii: "\""): utf8.append(0x22)
            case UInt8(ascii: "\\"): utf8.append(0x5C)
            case UInt8(ascii: "/"): utf8.append(0x2F)
            case UInt8(ascii: "b"): utf8.append(0x08)
            case UInt8(ascii: "f"): utf8.append(0x0C)
            case UInt8(ascii: "n"): utf8.append(0x0A)
            case UInt8(ascii: "r"): utf8.append(0x0D)
            case UInt8(ascii: "t"): utf8.append(0x09)
            case UInt8(ascii: "u"):
                flush()
                var code = try hex4()
                if (0xD800...0xDBFF).contains(code), i + 1 < bytes.count, bytes[i] == UInt8(ascii: "\\"), bytes[i + 1] == UInt8(ascii: "u") {
                    let save = i
                    i += 2
                    let low = try hex4()
                    if (0xDC00...0xDFFF).contains(low) {
                        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                    } else {
                        i = save
                    }
                }
                scalars.append(Unicode.Scalar(code) ?? "\u{FFFD}")
            default:
                throw error("invalid escape")
            }
        }
        throw error("unterminated string")
    }

    mutating func hex4() throws -> UInt32 {
        guard i + 4 <= bytes.count else { throw error("short \\u escape") }
        var v: UInt32 = 0
        for _ in 0..<4 {
            let b = bytes[i]
            let d: UInt32
            switch b {
            case 0x30...0x39: d = UInt32(b - 0x30)
            case 0x41...0x46: d = UInt32(b - 0x41 + 10)
            case 0x61...0x66: d = UInt32(b - 0x61 + 10)
            default: throw error("invalid \\u escape")
            }
            v = v << 4 | d
            i += 1
        }
        return v
    }

    mutating func parseNumber() throws -> Double {
        let start = i
        while i < bytes.count, Self.isNumberByte(bytes[i]) { i += 1 }
        let text = String(decoding: UnsafeBufferPointer(rebasing: bytes[start..<i]), as: UTF8.self)
        guard !text.isEmpty, let d = Double(text) else {
            i = start
            throw error("invalid value")
        }
        return d
    }

    static func isNumberByte(_ b: UInt8) -> Bool {
        switch b {
        case 0x30...0x39, UInt8(ascii: "-"), UInt8(ascii: "+"), UInt8(ascii: "."), UInt8(ascii: "e"), UInt8(ascii: "E"): return true
        default: return false
        }
    }
}
