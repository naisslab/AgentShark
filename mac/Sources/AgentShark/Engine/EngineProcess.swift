import Foundation
import Observation
import os

/// One Node engine process: the live index (`serve`) or one capture file (`open`), MAC-SPEC §2.
///
/// `start()` locates Node, spawns the engine with `--handshake`, and becomes `.ready` when the engine prints
/// its ready line. If the process exits, it restarts with exponential backoff (at most 5 attempts).
@MainActor @Observable final class EngineProcess {
    enum Mode: Hashable, Sendable {
        case live
        case demo
        case capture(URL)
    }

    enum Status: Equatable, Sendable {
        case idle
        case locatingNode
        case starting
        case ready(EngineEndpoint)
        case failed(String)
        case restarting(attempt: Int)
    }

    let mode: Mode
    private(set) var status: Status = .idle
    /// Last 200 lines of the engine's stderr, for the diagnostics popover.
    private(set) var logTail: [String] = []
    /// Set when Node is missing or too old; the onboarding sheet offers "Choose Node binary…".
    private(set) var nodeProblem: NodeLocatorError?
    /// The Node binary and version in use.
    private(set) var node: (url: URL, version: String)?

    static let maxRestarts = 5

    @ObservationIgnored private let preferences: Preferences
    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var restartAttempts = 0
    @ObservationIgnored private var readyAt: Date?
    @ObservationIgnored private var stopping = false
    @ObservationIgnored private var useHandshake = true
    @ObservationIgnored private var stdoutBuffer = Data()
    @ObservationIgnored private var stderrBuffer = Data()
    @ObservationIgnored private var restartTask: Task<Void, Never>?
    @ObservationIgnored private var cachedClient: APIClient?
    @ObservationIgnored private var statusObservers: [(Status) -> Void] = []
    /// Off (`serve --no-watch`): the live engine does not re-index on source changes, and beside another process that
    /// writes the index it only follows, never taking over when that process exits (`--snapshot` turns it off).
    @ObservationIgnored var watchesSources = true

    init(mode: Mode, preferences: Preferences) {
        self.mode = mode
        self.preferences = preferences
    }

    /// Non-nil while `status` is `.ready`.
    var api: APIClient? {
        guard case .ready(let endpoint) = status else { return nil }
        if cachedClient?.endpoint != endpoint { cachedClient = APIClient(endpoint: endpoint) }
        return cachedClient
    }

    var endpoint: EngineEndpoint? {
        if case .ready(let e) = status { return e }
        return nil
    }

    var isRunning: Bool { process?.isRunning == true }

    var captureURL: URL? {
        if case .capture(let url) = mode { return url }
        return nil
    }

    /// Called on every status change (not observed; for EngineStore).
    func observeStatus(_ handler: @escaping (Status) -> Void) {
        statusObservers.append(handler)
    }

    private func setStatus(_ s: Status) {
        guard s != status else { return }
        status = s
        for h in statusObservers { h(s) }
    }

    // MARK: Lifecycle

    func start() {
        guard process == nil, status != .locatingNode else { return }
        stopping = false
        restartTask?.cancel()
        launch()
    }

    /// Stop the engine (SIGTERM, then SIGKILL after 2 s) and stay stopped.
    func stop() {
        stopping = true
        restartTask?.cancel()
        generation += 1
        if let p = process, p.isRunning {
            let pid = p.processIdentifier
            Self.signal(pid, SIGTERM)
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                if kill(pid, 0) == 0 { Self.signal(pid, SIGKILL) }
            }
        }
        process = nil
        setStatus(.idle)
    }

    /// Runs the engine as a child of /bin/sh that stops it when the app process is gone (crash, force quit),
    /// so an engine never outlives the app. Exits with the engine's status.
    nonisolated static let watchdogScript = """
        "$@" &
        child=$!
        trap 'kill -TERM "$child" 2>/dev/null' TERM INT HUP
        while kill -0 "$PPID" 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 1; done
        kill -TERM "$child" 2>/dev/null
        wait "$child"
        """

    /// Signal the watchdog and the engine together: their process group when it is their own, else the watchdog.
    nonisolated static func signal(_ pid: pid_t, _ sig: Int32) {
        let group = getpgid(pid)
        if group > 0, group != getpgrp() { killpg(group, sig) } else { kill(pid, sig) }
    }

    /// Stop and start again, for example after the engine source or index location changed in Settings.
    func restart() {
        stop()
        restartAttempts = 0
        useHandshake = true
        nodeProblem = nil
        start()
    }

    /// SIGTERM synchronously, for applicationWillTerminate. Waits up to `timeout` for the process to exit.
    func terminateForQuit(timeout: TimeInterval = 2) {
        stopping = true
        restartTask?.cancel()
        guard let p = process, p.isRunning else { return }
        Self.signal(p.processIdentifier, SIGTERM)
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { Self.signal(p.processIdentifier, SIGKILL) }
    }

    private func launch() {
        generation += 1
        let gen = generation
        setStatus(.locatingNode)
        let override = preferences.nodeOverrideURL
        Task.detached(priority: .userInitiated) {
            let result = NodeLocator.locate(override: override)
            await MainActor.run { [weak self] in
                guard let self, self.generation == gen else { return }
                switch result {
                case .success(let node):
                    self.nodeProblem = nil
                    self.node = node
                    self.spawn(node: node.url, generation: gen)
                case .failure(let problem):
                    self.nodeProblem = problem
                    self.setStatus(.failed(problem.localizedDescription))
                }
            }
        }
    }

    private func spawn(node: URL, generation gen: Int) {
        guard let root = EngineSource.resolve(settingsPath: preferences.engineSourcePath) else {
            setStatus(.failed("The AgentShark engine was not found. Choose the engine source folder in Settings ▸ General."))
            return
        }
        guard let entry = EngineSource.entryPoint(in: root) else { setStatus(.failed("The engine entry point is missing. Reinstall AgentShark.")); return }
        var args = [entry.path]
        switch mode {
        case .live: args += ["serve", "--no-open", "--port", "0"] + (watchesSources ? [] : ["--no-watch"])
        case .demo: args += ["demo", "--no-open", "--port", "0"]
        case .capture(let url): args += ["open", url.path, "--no-open", "--port", "0"]
        }
        if useHandshake { args.append("--handshake") }

        var env = ProcessInfo.processInfo.environment
        if let home = preferences.indexLocationURL { env["AGENTSHARK_HOME"] = home.path }
        env["NO_COLOR"] = "1"
        env["FORCE_COLOR"] = "0"

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", Self.watchdogScript, "agentshark-engine", node.path] + args
        p.environment = env
        p.currentDirectoryURL = root
        p.standardInput = FileHandle.nullDevice
        let out = Pipe()
        let err = Pipe()
        p.standardOutput = out
        p.standardError = err
        stdoutBuffer.removeAll()
        stderrBuffer.removeAll()

        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil }
            Task { @MainActor in self?.consume(data, stderr: false, generation: gen) }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil }
            Task { @MainActor in self?.consume(data, stderr: true, generation: gen) }
        }
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            Task { @MainActor in self?.processExited(status: status, generation: gen) }
        }

        do {
            try p.run()
        } catch {
            setStatus(.failed("Could not start Node at \(node.path): \(error.localizedDescription)"))
            return
        }
        process = p
        readyAt = nil
        setStatus(.starting)
    }

    // MARK: Output

    private func consume(_ data: Data, stderr: Bool, generation gen: Int) {
        guard gen == generation else { return }
        if stderr {
            stderrBuffer.append(data)
            for line in Self.takeLines(&stderrBuffer, flush: data.isEmpty) { appendLog(line) }
        } else {
            stdoutBuffer.append(data)
            for line in Self.takeLines(&stdoutBuffer, flush: data.isEmpty) { handleStdout(line) }
        }
    }

    nonisolated static func takeLines(_ buffer: inout Data, flush: Bool) -> [String] {
        var lines: [String] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            lines.append(String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...nl)
        }
        if flush, !buffer.isEmpty {
            lines.append(String(decoding: buffer, as: UTF8.self))
            buffer.removeAll()
        }
        return lines
    }

    /// Engine output also goes to the unified log (Console.app: subsystem dev.agentshark.app, category engine).
    private static let log = Logger(subsystem: "dev.agentshark.app", category: "engine")

    private func appendLog(_ line: String) {
        let clean = Self.redactTokens(Self.stripANSI(line)).trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
        guard !clean.isEmpty else { return }
        Self.log.notice("\(clean, privacy: .public)")
        logTail.append(clean)
        if logTail.count > 200 { logTail.removeFirst(logTail.count - 200) }
    }

    private func handleStdout(_ line: String) {
        let clean = Self.stripANSI(line).trimmingCharacters(in: .whitespaces)
        if case .ready = status {
            appendLog(clean)
            return
        }
        if let endpoint = Self.parseHandshake(clean) ?? Self.parseViewerLine(clean, mode: mode, indexPath: preferences.indexLocationURL?.path) {
            readyAt = Date()
            setStatus(.ready(endpoint))
        } else if !clean.isEmpty {
            appendLog(clean)
        }
    }

    /// `{"event":"ready","url":…,"token":…,"mode":…,"indexPath":…,"version":…}`.
    nonisolated static func parseHandshake(_ line: String) -> EngineEndpoint? {
        guard line.hasPrefix("{"), let v = try? JSONValue.parse(line), v["event"]?.stringValue == "ready",
              let urlText = v["url"]?.stringValue, let base = baseURL(from: urlText) else { return nil }
        let token = v["token"]?.stringValue ?? URLComponents(string: urlText)?.queryItems?.first { $0.name == "token" }?.value
        guard let token, !token.isEmpty else { return nil }
        return EngineEndpoint(baseURL: base, token: token, mode: v["mode"]?.stringValue ?? "live",
                              indexPath: v["indexPath"]?.stringValue ?? "", version: v["version"]?.stringValue ?? "",
                              role: v["role"]?.stringValue ?? v["indexer"]?["role"]?.stringValue,
                              writerPid: v["writerPid"]?.intValue ?? v["indexer"]?["writerPid"]?.intValue)
    }

    /// Fallback for engines without `--handshake`: `  viewer  http://127.0.0.1:PORT/?token=T`.
    nonisolated static func parseViewerLine(_ line: String, mode: Mode, indexPath: String?) -> EngineEndpoint? {
        guard let range = line.range(of: #"http://127\.0\.0\.1:\d+/\?token=[0-9A-Za-z]+"#, options: .regularExpression),
              let comps = URLComponents(string: String(line[range])),
              let token = comps.queryItems?.first(where: { $0.name == "token" })?.value,
              let base = baseURL(from: String(line[range])) else { return nil }
        let modeName: String
        switch mode {
        case .live, .demo: modeName = "live"
        case .capture: modeName = "capture"
        }
        return EngineEndpoint(baseURL: base, token: token, mode: modeName, indexPath: indexPath ?? "", version: "")
    }

    nonisolated static func baseURL(from text: String) -> URL? {
        guard let c = URLComponents(string: text), let host = c.host, let port = c.port else { return nil }
        return URL(string: "\(c.scheme ?? "http")://\(host):\(port)")
    }

    /// The engine prints its access token in the viewer URL; logs and the Engine Log popover never show it.
    nonisolated static func redactTokens(_ s: String) -> String {
        guard s.contains("token") else { return s }
        return s.replacingOccurrences(of: #"(token=|"token"\s*:\s*")[0-9A-Za-z]+"#, with: "$1…", options: .regularExpression)
    }

    nonisolated static func stripANSI(_ s: String) -> String {
        guard s.contains("\u{1B}") else { return s }
        return s.replacingOccurrences(of: #"\u001B\[[0-9;?]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
    }

    // MARK: Exit and restart

    private func processExited(status code: Int32, generation gen: Int) {
        guard gen == generation else { return }
        process = nil
        cachedClient = nil
        if stopping { return }
        let wasReady: Bool
        if case .ready = status { wasReady = true } else { wasReady = false }

        // An engine without --handshake rejects the flag with a usage error (exit 2); retry without it. The exit
        // can arrive before the last stderr line, so the exit code alone decides.
        if !wasReady, useHandshake, code == 2 {
            useHandshake = false
            appendLog("AgentShark: this engine does not support --handshake; reading the viewer URL instead.")
            launch()
            return
        }
        // A run that stayed up for a minute starts a fresh backoff sequence.
        if let readyAt, Date().timeIntervalSince(readyAt) > 60 { restartAttempts = 0 }
        guard restartAttempts < Self.maxRestarts else {
            let last = logTail.suffix(3).joined(separator: "\n")
            setStatus(.failed("The engine stopped (exit code \(code)) and did not recover after \(Self.maxRestarts) restarts."
                + (last.isEmpty ? "" : "\n\(last)")))
            return
        }
        restartAttempts += 1
        let attempt = restartAttempts
        setStatus(.restarting(attempt: attempt))
        appendLog("AgentShark: engine exited with code \(code); restarting (attempt \(attempt) of \(Self.maxRestarts)).")
        let delay = Double(1 << (attempt - 1))
        restartTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, !self.stopping else { return }
            self.launch()
        }
    }
}
