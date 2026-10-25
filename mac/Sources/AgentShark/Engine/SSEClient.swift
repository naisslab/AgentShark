import Foundation

/// Server-Sent Events over URLSession with automatic reconnection.
///
/// Lines are split by hand rather than with `AsyncBytes.lines`, which drops the blank lines that end an event.
enum SSEClient {
    struct Message: Hashable, Sendable {
        var event: String
        var data: String
    }

    /// Messages from `request`, reconnecting after errors or end of stream (honoring the server's `retry:`),
    /// until the consumer stops iterating. `onConnection(true)` fires when a response arrives and
    /// `onConnection(false)` when it ends.
    static func messages(request: URLRequest, session: URLSession,
                         onConnection: @escaping @Sendable (Bool) -> Void) -> AsyncThrowingStream<Message, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var retryMs = 3000
                var failures = 0
                while !Task.isCancelled {
                    do {
                        let (bytes, response) = try await session.bytes(for: request)
                        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                            throw APIError(status: status, message: "The event stream answered with HTTP \(status).", code: nil,
                                           start: nil, end: nil)
                        }
                        onConnection(true)
                        failures = 0
                        var parser = Parser()
                        var line: [UInt8] = []
                        for try await byte in bytes {
                            if byte == 0x0A {
                                if line.last == 0x0D { line.removeLast() }
                                if let m = parser.feed(String(decoding: line, as: UTF8.self)) { continuation.yield(m) }
                                if let r = parser.retryMs { retryMs = r }
                                line.removeAll(keepingCapacity: true)
                            } else {
                                line.append(byte)
                            }
                        }
                    } catch is CancellationError {
                        break
                    } catch let e as URLError where e.code == .cancelled {
                        break
                    } catch {
                        failures += 1
                    }
                    onConnection(false)
                    if Task.isCancelled { break }
                    // Back off from the server's retry interval up to 30 s while the engine stays unreachable.
                    let delay = min(30_000, retryMs * (1 << min(failures, 4)))
                    try? await Task.sleep(for: .milliseconds(delay))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The SSE line protocol (event, data, retry, comments; a blank line dispatches).
    struct Parser {
        private var event = ""
        private var data: [String] = []
        private(set) var retryMs: Int?

        mutating func feed(_ line: String) -> Message? {
            if line.isEmpty {
                defer {
                    event = ""
                    data = []
                }
                guard !data.isEmpty else { return nil }
                return Message(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
            }
            if line.hasPrefix(":") { return nil }
            let field: Substring
            var value: Substring
            if let colon = line.firstIndex(of: ":") {
                field = line[..<colon]
                value = line[line.index(after: colon)...]
                if value.first == " " { value = value.dropFirst() }
            } else {
                field = Substring(line)
                value = ""
            }
            switch field {
            case "event": event = String(value)
            case "data": data.append(String(value))
            case "retry": retryMs = Int(value)
            default: break
            }
            return nil
        }
    }
}
