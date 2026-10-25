import Foundation
import Observation

/// Runs `agentshark capture … --progress json` for File ▸ Export Capture (MAC-CONTRACT §3.6).
/// Engines without `--progress` still export; progress is then indeterminate.
@MainActor @Observable final class CaptureExportJob {
    struct Options: Hashable, Sendable {
        var output: URL
        var sessions: [String] = []
        /// Epoch µs; sent as ISO 8601 with the local offset.
        var since: Int64?
        var until: Int64?
        var filter: String?
        var includeRaw = true
        var includeSidecars = true
        var profile = "forensic"
    }

    enum State: Equatable, Sendable {
        case idle
        /// `total` is 0 while unknown.
        case running(done: Int, total: Int)
        case finished(path: String, bytes: Int64?)
        case failed(String)
        case cancelled
    }

    private(set) var state: State = .idle
    /// The CLI's stderr, for the failure message.
    private(set) var log: [String] = []

    @ObservationIgnored private let preferences: Preferences
    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var useProgress = true
    @ObservationIgnored private var buffer = Data()
    @ObservationIgnored private var options: Options?

    init(preferences: Preferences) {
        self.preferences = preferences
    }

    var isRunning: Bool {
        if case .running = state { return true }
        return false
    }

    func start(_ options: Options) {
        guard !isRunning else { return }
        self.options = options
        log = []
        state = .running(done: 0, total: 0)
        let override = preferences.nodeOverrideURL
        Task.detached(priority: .userInitiated) {
            let node = NodeLocator.locate(override: override)
            await MainActor.run { [weak self] in
                switch node {
                case .success(let n): self?.spawn(node: n.url)
                case .failure(let e): self?.state = .failed(e.localizedDescription)
                }
            }
        }
    }

    func cancel() {
        guard let p = process, p.isRunning else { return }
        p.terminate()
        state = .cancelled
    }

    func arguments(for o: Options) -> [String] {
        var args = ["capture", "-o", o.output.path, "--no-index", "--profile", o.profile]
        for s in o.sessions { args += ["--session", s] }
        if let since = o.since { args += ["--since", Formatters.iso8601(since)] }
        if let until = o.until { args += ["--until", Formatters.iso8601(until)] }
        if let f = o.filter, !f.isEmpty { args += ["--filter", f] }
        if !o.includeRaw { args.append("--no-raw") }
        if !o.includeSidecars { args.append("--no-sidecars") }
        if useProgress { args += ["--progress", "json"] }
        return args
    }

    private func spawn(node: URL) {
        guard let options else { return }
        guard let root = EngineSource.resolve(settingsPath: preferences.engineSourcePath) else {
            state = .failed("The AgentShark engine was not found. Choose the engine source folder in Settings ▸ General.")
            return
        }
        let p = Process()
        p.executableURL = node
        p.arguments = [EngineSource.entryPoint(in: root)!.path] + arguments(for: options)
        var env = ProcessInfo.processInfo.environment
        if let home = preferences.indexLocationURL { env["AGENTSHARK_HOME"] = home.path }
        env["NO_COLOR"] = "1"
        p.environment = env
        p.currentDirectoryURL = root
        p.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        buffer.removeAll()
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil }
            Task { @MainActor in self?.consume(data) }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil; return }
            let text = EngineProcess.stripANSI(String(decoding: data, as: UTF8.self))
            Task { @MainActor in self?.log += text.split(separator: "\n").map(String.init) }
        }
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            Task { @MainActor in self?.exited(code) }
        }
        do {
            try p.run()
            process = p
        } catch {
            state = .failed("Could not start Node: \(error.localizedDescription)")
        }
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        for line in EngineProcess.takeLines(&buffer, flush: data.isEmpty) {
            guard line.hasPrefix("{"), let v = try? JSONValue.parse(line) else { continue }
            switch v["event"]?.stringValue {
            case "progress":
                state = .running(done: v["done"]?.intValue ?? 0, total: v["total"]?.intValue ?? 0)
            case "done":
                state = .finished(path: v["path"]?.stringValue ?? options?.output.path ?? "", bytes: v["bytes"]?.int64Value)
            default:
                break
            }
        }
    }

    private func exited(_ code: Int32) {
        process = nil
        if case .cancelled = state { return }
        // An engine without --progress rejects it with a usage error; export again without it.
        if code == 2, useProgress, log.contains(where: { $0.contains("progress") }), let options {
            useProgress = false
            state = .idle
            start(options)
            return
        }
        if code == 0 {
            if case .finished = state { return }
            let path = options?.output.path ?? ""
            let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.int64Value
            state = .finished(path: path, bytes: size)
        } else {
            state = .failed(log.suffix(4).joined(separator: "\n").nilIfEmpty ?? "The export stopped with exit code \(code).")
        }
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
