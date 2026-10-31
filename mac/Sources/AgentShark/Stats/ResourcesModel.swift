import Foundation
import Observation

enum ResourceMetric: String, CaseIterable, Sendable {
    case cpu, memory, read, write, receive, transmit, gpuMemory
    var slow: Bool { self == .receive || self == .transmit || self == .gpuMemory }
}

struct ResourcePoint: Sendable {
    let ts: Int64
    let recording: String
    let value: Double?
    let gapUs: Double
}

/// Project once per observation. Never substitute host counters for a missing session counter.
struct ResourceProjection {
    let processes: [ResourceProcess]
    let partial: Bool
    let values: [ResourceMetric: Double]
    let network: ResourceNetwork?
    let gpu: ResourceGPU?

    init(_ frame: ResourceActivity, sessions: [String]) {
        let selected = Set(sessions)
        func includes(_ owners: [String]) -> Bool { selected.isEmpty || !selected.isDisjoint(with: owners) }
        var seen = Set<String>()
        processes = frame.entries.filter { includes($0.sessions) && seen.insert($0.id).inserted }
        let identities = Set(processes.map(\.id))
        let missing = frame.unavailableProcesses.map { $0.contains { includes($0.sessions) } } ?? !frame.unavailablePids.isEmpty
        partial = frame.truncated || frame.descendants != "tracked" || missing
        network = frame.network.map { ResourceNetwork(ts: $0.ts, reason: $0.reason, entries: $0.entries.filter { identities.contains($0.identity) }) }
        gpu = frame.gpu.map { ResourceGPU(ts: $0.ts, reason: $0.reason, entries: $0.entries.filter { identities.contains($0.identity) }) }
        var v: [ResourceMetric: Double] = [:]
        if !partial {
            v[.cpu] = Self.sum(processes.map(\.cpuPercent))
            v[.memory] = Self.sum(processes.map { $0.residentBytes })
            v[.read] = Self.sum(processes.map(\.readBytesPerSecond))
            v[.write] = Self.sum(processes.map(\.writeBytesPerSecond))
        }
        if network?.reason == nil {
            v[.receive] = Self.sum(network?.entries.map(\.rxBytesPerSecond) ?? [])
            v[.transmit] = Self.sum(network?.entries.map(\.txBytesPerSecond) ?? [])
        }
        if gpu?.reason == nil { v[.gpuMemory] = Self.sum(gpu?.entries.map(\.memoryUsedBytes) ?? []) }
        values = v
    }

    private static func sum(_ values: [Double?]) -> Double? {
        guard !values.isEmpty, values.allSatisfy({ $0?.isFinite == true }) else { return nil }
        return values.reduce(0) { $0 + $1! }
    }
}

struct ResourceAgentTotal: Identifiable {
    let id: String
    let sessions: Int
    let projection: ResourceProjection
    var name: String { ["codex": "Codex", "claude-code": "Claude Code", "claude-cowork": "Claude Cowork", "copilot": "Copilot Chat"][id] ?? "Agent" }

    static func project(_ frame: ResourceActivity, sessions: [String]) -> [Self] {
        let selected = frame.bindings.filter { sessions.isEmpty || sessions.contains($0.session) }
        let groups = Dictionary(grouping: selected) { binding in
            binding.agent ?? ["cx": "codex", "cc": "claude-code", "cw": "claude-cowork", "cp": "copilot"][String(binding.session.prefix(2))] ?? "agent"
        }
        return groups.keys.sorted().map { agent in
            let ids = groups[agent]!.map(\.session)
            return Self(id: agent, sessions: ids.count, projection: ResourceProjection(frame, sessions: ids))
        }
    }
}

/// One cancellable request at a time; a 600-point tail and Canvas drawing bound the native UI work.
@MainActor @Observable final class ResourcesModel {
    private(set) var status = ResourceStatus()
    private(set) var canRecord = false
    private(set) var loading = true
    private(set) var error: String?
    private(set) var actionError: String?
    private(set) var changing = false
    private(set) var series: [ResourceMetric: [ResourcePoint]] = [:]
    private(set) var latest: ResourceProjection?
    private(set) var latestTs: Int64?
    private(set) var latestRecording: String?
    private(set) var network: ResourceNetwork?
    private(set) var gpu: ResourceGPU?
    private(set) var processRows: [ResourceProcess] = []
    private(set) var agentRows: [ResourceAgentTotal] = []
    private(set) var observedHz: Double?
    private(set) var now = Date()
    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private var ids = Set<String>()
    @ObservationIgnored private var orderedIDs: [String] = []
    @ObservationIgnored private var times: [Int64] = []
    @ObservationIgnored private var detailsAt = Date.distantPast
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var reload = true
    @ObservationIgnored private var latestFrame: ResourceActivity?

    static func parsePIDs(_ text: String) -> [Int]? {
        let parts = text.split { $0 == "," || $0.isWhitespace }
        guard !parts.isEmpty, parts.count <= 16 else { return nil }
        let pids = parts.compactMap { Int($0) }
        guard pids.count == parts.count, pids.allSatisfy({ $0 > 0 && $0 <= Int32.max }), Set(pids).count == pids.count else { return nil }
        return pids
    }

    func retry() { reload = true }

    func run(api: APIClient, scope: Scope, capture: Bool, visible: @escaping @MainActor () -> Bool) async {
        clear()
        var failures = 0
        var hidden = false
        while !Task.isCancelled {
            if !visible() || changing {
                hidden = true
                do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
                continue
            }
            if hidden { reload = true; hidden = false }
            let began = ContinuousClock.now
            let version = revision
            let history = reload
            do {
                let page = try await api.resources(scope: scope, cursor: history ? nil : cursor, live: !history)
                try Task.checkCancellation()
                guard version == revision else { continue }
                if history { clearHistory(); reload = false }
                let wasEnabled = status.enabled
                ingest(page, sessions: scope.sessions, history: history)
                loading = false; error = nil; failures = 0
                // A stop by another window flushes the final tail. Load that durable history once.
                if page.reset == true || (!history && wasEnabled && !page.recording.enabled) { reload = true }
                if capture { return }
            } catch is CancellationError { return }
            catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
                loading = false; failures = min(failures + 1, 5)
            }
            let interval: Duration = failures > 0 ? .seconds(min(10, 1 << failures)) : status.enabled ? .milliseconds(100) : .seconds(1)
            let delay = interval - (ContinuousClock.now - began)
            do { if delay > .zero { try await Task.sleep(for: delay) } } catch { return }
        }
    }

    func change(api: APIClient, session: String? = nil, roots: [Int] = [], stop: Bool = false) async {
        guard !changing else { return }
        changing = true; actionError = nil; revision += 1
        defer { changing = false; revision += 1; reload = true }
        do {
            let result: ResourceChange
            if stop { result = try await api.resourceRecording(enabled: false) }
            else if status.enabled, let session { result = try await api.bindResources(session: session, roots: roots) }
            else if let session { result = try await api.resourceRecording(enabled: true, bindings: [ResourceBinding(session: session, roots: roots)]) }
            else { result = try await api.resourceRecording(enabled: true) }
            status = result.recording
        } catch { actionError = error.localizedDescription }
    }

    func ingest(_ page: ResourcePage, sessions: [String], history: Bool = false) {
        status = page.recording
        canRecord = page.canRecord ?? false
        cursor = page.cursor
        now = Date()
        let samples = history ? page.samples.reversed().map { $0 } : page.samples
        for sample in samples where ids.insert(sample.id).inserted {
            orderedIDs.append(sample.id)
            if orderedIDs.count > 600 { ids.remove(orderedIDs.removeFirst()) }
            guard let frame = sample.sessionResources else { continue }
            latestFrame = frame
            let projection = ResourceProjection(frame, sessions: sessions)
            let at = sample.observed?["sessions"] ?? sample.ts
            if sample.recording != latestRecording { network = nil; gpu = nil; times.removeAll() }
            latest = projection; latestTs = at; latestRecording = sample.recording
            if !projection.processes.isEmpty, times.last != at {
                times.append(at); if times.count > 11 { times.removeFirst() }
            }
            if let net = projection.network { network = net }
            if let device = projection.gpu { gpu = device }
            for metric in ResourceMetric.allCases {
                let ts: Int64
                switch metric {
                case .receive, .transmit: guard let net = projection.network else { continue }; ts = net.ts
                case .gpuMemory: guard let device = projection.gpu else { continue }; ts = device.ts
                default: ts = at
                }
                if let previous = series[metric]?.last, previous.recording == sample.recording && previous.ts >= ts { continue }
                var points = series[metric] ?? []
                points.append(ResourcePoint(ts: ts, recording: sample.recording, value: projection.values[metric],
                                            gapUs: metric.slow ? 3_000_000 : max(100, sample.intervalMs ?? 100) * 2500))
                if points.count > 600 { points.removeFirst(points.count - 600) }
                series[metric] = points
            }
        }
        if times.count > 1, let first = times.first, let last = times.last, last > first {
            observedHz = Double(times.count - 1) * 1_000_000 / Double(last - first)
        }
        if now.timeIntervalSince(detailsAt) >= 1 || history {
            processRows = latest?.processes ?? []; detailsAt = now
            agentRows = latestFrame.map { ResourceAgentTotal.project($0, sessions: sessions) } ?? []
        }
    }

    private func clearHistory() {
        latestFrame = nil; agentRows = []
        series = [:]; latest = nil; latestTs = nil; latestRecording = nil; network = nil; gpu = nil
        processRows = []; ids.removeAll(); orderedIDs.removeAll(); times.removeAll(); observedHz = nil
    }

    private func clear() {
        clearHistory(); cursor = nil; reload = true; loading = true; error = nil
        status = ResourceStatus(); canRecord = false
    }

    static func reason(_ value: String?) -> String {
        switch value {
        case "unsupported-platform": return "Unavailable on this platform"
        case "per-process-network-unavailable": return "Process network counters unavailable"
        case "disabled": return "Disabled"
        case "collector-timeout": return "Collector timed out"
        case "collector-not-installed": return "Collector not installed"
        case "gpu-asleep": return "GPU asleep"
        case "gpu-power-state-unknown": return "GPU power state unavailable"
        case "no-process-counters": return "No process counters reported"
        case .some: return "Collector unavailable"
        case nil: return "Waiting for a measurement"
        }
    }
}
