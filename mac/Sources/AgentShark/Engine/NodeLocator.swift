import Foundation

enum NodeLocatorError: Error, LocalizedError, Hashable, Sendable {
    /// No node binary in any of the searched places.
    case notFound(searched: [String])
    /// The best node found is older than the minimum.
    case tooOld(path: String, version: String)

    var errorDescription: String? {
        switch self {
        case .notFound:
            return "AgentShark needs Node.js \(NodeLocator.minimumMajor) or later, and none was found."
        case .tooOld(let path, let version):
            return "The Node.js at \(path) is version \(version); AgentShark needs version \(NodeLocator.minimumMajor) or later."
        }
    }

    var recoverySuggestion: String? {
        "The desktop release includes its runtime. Reinstall the complete AgentShark application if it is missing. Developer builds can choose a Node binary in Settings."
    }
}

/// Finds a Node.js binary for the engine (MAC-SPEC §2): bundled, Settings override, Homebrew, /usr/local,
/// the newest nvm install, then the login shell's PATH. The version must be at least 24.12.
enum NodeLocator {
    static let minimumMajor = 24

    /// Blocking: runs `node --version` on candidates. Call it off the main thread.
    static func locate(override: URL?) -> Result<(url: URL, version: String), NodeLocatorError> {
        var searched: [String] = []
        var best: (url: URL, version: String, major: Int)?
        // Later groups are slower (the login shell can take a second), so they run only when needed.
        for group in candidateGroups(override: override) {
            for candidate in group() {
                let path = candidate.path
                guard !searched.contains(path) else { continue }
                searched.append(path)
                guard FileManager.default.isExecutableFile(atPath: path), let version = version(of: candidate) else { continue }
                let major = majorVersion(version) ?? 0
                if compareVersions(version, "24.12.0") != .orderedAscending { return .success((candidate, version)) }
                if best == nil || major > best!.major { best = (candidate, version, major) }
            }
        }
        if let best { return .failure(.tooOld(path: best.url.path, version: best.version)) }
        return .failure(.notFound(searched: searched))
    }

    static func candidateGroups(override: URL?) -> [() -> [URL]] {
        [
            {
                var list: [URL] = []
                if let bundled = Bundle.main.resourceURL?.appendingPathComponent("node") { list.append(bundled) }
                if let override { list.append(override) }
                list.append(URL(fileURLWithPath: "/opt/homebrew/bin/node"))
                list.append(URL(fileURLWithPath: "/usr/local/bin/node"))
                return list
            },
            { nvmNodes() },
            { loginShellNode().map { [$0] } ?? [] },
        ]
    }

    /// `~/.nvm/versions/node/*/bin/node`, newest first.
    static func nvmNodes() -> [URL] {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
        let dirs = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return dirs
            .sorted { compareVersions($0, $1) == .orderedDescending }
            .map { root.appendingPathComponent($0).appendingPathComponent("bin/node") }
    }

    static func loginShellNode() -> URL? {
        guard let out = run(URL(fileURLWithPath: "/bin/zsh"), ["-lc", "command -v node"], timeout: 5) else { return nil }
        let path = out.split(separator: "\n").last.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
        return path.hasPrefix("/") ? URL(fileURLWithPath: path) : nil
    }

    /// `v25.8.0` → `25.8.0`.
    static func version(of node: URL) -> String? {
        guard let out = run(node, ["--version"], timeout: 5) else { return nil }
        let v = out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard v.hasPrefix("v"), v.count > 1 else { return nil }
        return String(v.dropFirst())
    }

    static func majorVersion(_ version: String) -> Int? {
        Int(version.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(separator: ".").first ?? "")
    }

    /// Compare `v25.8.0`-style names numerically.
    static func compareVersions(_ a: String, _ b: String) -> ComparisonResult {
        let pa = a.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x < y ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    /// Run a short command and return its stdout, or nil on failure or timeout.
    static func run(_ executable: URL, _ arguments: [String], timeout: TimeInterval) -> String? {
        let p = Process()
        p.executableURL = executable
        p.arguments = arguments
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in done.signal() }
        do {
            try p.run()
        } catch {
            return nil
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        guard p.terminationStatus == 0 else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}
