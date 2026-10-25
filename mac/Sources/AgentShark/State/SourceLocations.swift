import Foundation

/// Same versioned document as src/source-config.ts. Shared by the desktop app and CLI.
struct SourceLocations: Codable, Equatable {
    var version = 1
    var autoDiscover = true
    var claudeRoots: [String] = []
    var codexRoots: [String] = []

    static func path(indexLocation: URL?, environment: [String: String] = ProcessInfo.processInfo.environment,
                     home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        if let explicit = environment["AGENTSHARK_SOURCE_CONFIG"], !explicit.isEmpty { return URL(fileURLWithPath: explicit) }
        let directory = indexLocation ?? environment["AGENTSHARK_HOME"].map { URL(fileURLWithPath: $0) } ?? home.appendingPathComponent(".agentshark")
        return directory.appendingPathComponent("sources.json")
    }

    static func read(from url: URL) throws -> SourceLocations {
        guard FileManager.default.fileExists(atPath: url.path) else { return SourceLocations() }
        let value = try JSONDecoder().decode(SourceLocations.self, from: Data(contentsOf: url))
        try value.validate()
        return value
    }

    func validate() throws {
        guard version == 1 else { throw SourceLocationError("Unsupported source settings version. Update AgentShark before editing this file.") }
        for root in claudeRoots + codexRoots {
            let expanded = (root as NSString).expandingTildeInPath
            guard expanded.hasPrefix("/"), !root.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw SourceLocationError("Choose an absolute folder path for each source.")
            }
        }
    }

    func write(to url: URL) throws {
        try validate()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

struct SourceLocationError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
