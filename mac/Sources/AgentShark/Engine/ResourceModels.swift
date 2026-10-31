import Foundation

struct ResourceBinding: Codable, Equatable, Sendable {
    let session: String
    let roots: [Int]
    var starts: [String]? = nil
    var discovered: Bool? = nil
    var shared: Bool? = nil
    var agent: String? = nil
}

struct ResourceDiscovery: Decodable, Equatable, Sendable {
    let state: String
    let checkedTs: Int64?
    let durationMs: Double?
    let intervalMs: Double
    let truncated: Bool?
}

struct ResourceStatus: Decodable, Equatable, Sendable {
    var enabled = false
    var recording: String?
    var intervalMs: Double?
    var effectiveIntervalMs: Double?
    var observedIntervalMs: Double?
    var samples: Int?
    var skipped: Int?
    var buffered: Int?
    var lastDurationMs: Double?
    var lastTs: Int64?
    var lastError: String?
    var sessionError: String?
    var bindings: [ResourceBinding]?
    var discovery: ResourceDiscovery?
}

struct ResourceProcess: Decodable, Identifiable, Sendable {
    let pid: Int
    let parentPid: Int
    let startId: String
    let sessions: [String]
    let cpuTimeUs: Double
    let residentBytes: Double
    let cpuPercent: Double?
    let readBytesPerSecond: Double?
    let writeBytesPerSecond: Double?
    var shared: Bool? = nil
    var id: String { "\(pid):\(startId)" }
}

struct ResourceNetwork: Decodable, Sendable {
    struct Entry: Decodable, Sendable {
        let pid: Int
        let startId: String
        let rxBytesPerSecond: Double?
        let txBytesPerSecond: Double?
        var identity: String { "\(pid):\(startId)" }
    }
    let ts: Int64
    let reason: String?
    let entries: [Entry]
}

struct ResourceGPU: Decodable, Sendable {
    struct Entry: Decodable, Identifiable, Sendable {
        let pid: Int
        let startId: String
        let index: Int
        let smPercent: Double?
        let memoryUsedBytes: Double?
        var identity: String { "\(pid):\(startId)" }
        var id: String { "\(identity):\(index)" }
    }
    let ts: Int64
    let reason: String?
    let entries: [Entry]
}

struct ResourceActivity: Decodable, Sendable {
    struct Missing: Decodable, Sendable { let pid: Int; let sessions: [String] }
    let bindings: [ResourceBinding]
    let entries: [ResourceProcess]
    let descendants: String
    let truncated: Bool
    let unavailablePids: [Int]
    let unavailableProcesses: [Missing]?
    let network: ResourceNetwork?
    let gpu: ResourceGPU?
}

extension ResourceActivity {
    private enum CodingKeys: String, CodingKey {
        case bindings, entries, descendants, truncated, unavailablePids, unavailableProcesses, network, gpu, encoding, groups
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bindings = try c.decode([ResourceBinding].self, forKey: .bindings)
        descendants = try c.decode(String.self, forKey: .descendants)
        truncated = try c.decode(Bool.self, forKey: .truncated)
        unavailablePids = try c.decode([Int].self, forKey: .unavailablePids)
        unavailableProcesses = try c.decodeIfPresent([Missing].self, forKey: .unavailableProcesses)
        network = try c.decodeIfPresent(ResourceNetwork.self, forKey: .network)
        gpu = try c.decodeIfPresent(ResourceGPU.self, forKey: .gpu)
        guard let encoding = try c.decodeIfPresent(String.self, forKey: .encoding) else {
            entries = try c.decode([ResourceProcess].self, forKey: .entries)
            return
        }
        guard encoding == "tuples-v1" else {
            throw DecodingError.dataCorruptedError(forKey: .encoding, in: c, debugDescription: "Unknown resource encoding")
        }
        let groups = try c.decode([[String]].self, forKey: .groups)
        var rows = try c.nestedUnkeyedContainer(forKey: .entries)
        var processes: [ResourceProcess] = []
        while !rows.isAtEnd {
            var row = try rows.nestedUnkeyedContainer()
            let pid = try row.decode(Int.self), parent = try row.decode(Int.self), start = try row.decode(String.self)
            let cpu = try row.decode(Double.self), memory = try row.decode(Double.self)
            _ = try row.decodeIfPresent(Double.self) // Cumulative disk counters remain in recordings.
            _ = try row.decodeIfPresent(Double.self)
            let percent = try row.decodeIfPresent(Double.self), read = try row.decodeIfPresent(Double.self), write = try row.decodeIfPresent(Double.self)
            let group = try row.decode(Int.self), shared = try row.decodeIfPresent(Bool.self)
            guard groups.indices.contains(group), row.isAtEnd, processes.count < 128 else {
                throw DecodingError.dataCorruptedError(in: row, debugDescription: "Invalid packed resource process")
            }
            processes.append(ResourceProcess(pid: pid, parentPid: parent, startId: start, sessions: groups[group],
                cpuTimeUs: cpu, residentBytes: memory, cpuPercent: percent, readBytesPerSecond: read, writeBytesPerSecond: write, shared: shared))
        }
        entries = processes
    }
}

struct ResourceSample: Decodable, Sendable {
    let id: String
    let recording: String
    let ts: Int64
    let intervalMs: Double?
    let observed: [String: Int64]?
    let sessionResources: ResourceActivity?
}

struct ResourcePage: Decodable, Sendable {
    let samples: [ResourceSample]
    let cursor: String?
    let next: String?
    let reset: Bool?
    let canRecord: Bool?
    let recording: ResourceStatus
}

struct ResourceChange: Decodable, Sendable { let recording: ResourceStatus }

extension APIClient {
    func resources(scope: Scope, cursor: String? = nil, live: Bool = false) async throws -> ResourcePage {
        var req = request("GET", "/api/resources", query: [
            ("scope", "session"), ("sessions", scope.sessions.isEmpty ? nil : scope.sessions.joined(separator: ",")),
            ("from", scope.from.map(String.init)), ("to", scope.to.map(String.init)),
            ("order", live ? "asc" : "desc"), ("limit", live ? "256" : "600"),
            ("live", live ? "1" : nil), ("after", cursor),
            ("format", "compact"),
        ])
        req.timeoutInterval = live ? 5 : 30
        return try Self.decode(ResourcePage.self, from: try await send(req))
    }

    func resourceRecording(enabled: Bool, bindings: [ResourceBinding]? = nil) async throws -> ResourceChange {
        struct Body: Encodable { let enabled: Bool; let bindings: [ResourceBinding]? }
        return try await post("/api/resources/recording", body: Body(enabled: enabled, bindings: bindings))
    }

    func bindResources(session: String, roots: [Int]) async throws -> ResourceChange {
        try await post("/api/resources/bind", body: ResourceBinding(session: session, roots: roots))
    }
}
