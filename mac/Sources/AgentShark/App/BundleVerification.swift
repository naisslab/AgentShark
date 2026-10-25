import Foundation

/// Release acceptance entry: exercise the native bundle's own runtime and engine with synthetic data.
/// It opens no windows, writes no preferences, and never starts the live personal index.
enum BundleVerification {
    static func run() -> Never {
        do {
            guard let resources = Bundle.main.resourceURL,
                  let root = EngineSource.bundled,
                  let entry = EngineSource.entryPoint(in: root) else {
                throw SourceLocationError("The compiled engine is missing from the app bundle.")
            }
            let node = resources.appendingPathComponent("node")
            guard FileManager.default.isExecutableFile(atPath: node.path) else {
                throw SourceLocationError("The app bundle has no executable runtime.")
            }
            let process = Process()
            process.executableURL = node
            process.arguments = [entry.path, "demo", "--no-open", "--port", "0", "--handshake"]
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = "/usr/bin:/bin"
            environment.removeValue(forKey: "NODE_OPTIONS")
            environment.removeValue(forKey: "NODE_PATH")
            process.environment = environment
            process.currentDirectoryURL = resources
            process.standardInput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            let output = Pipe()
            process.standardOutput = output
            try process.run()
            let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: deadline)
            defer {
                deadline.cancel()
                if process.isRunning { process.terminate() }
                process.waitUntilExit()
            }
            var text = ""
            while !text.contains("\n") {
                let data = output.fileHandleForReading.availableData
                if data.isEmpty { break }
                text += String(decoding: data, as: UTF8.self)
            }
            guard let endpoint = EngineProcess.parseHandshake(text.components(separatedBy: "\n")[0]) else {
                throw SourceLocationError("The bundled engine did not report a ready handshake.")
            }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 3
            let session = URLSession(configuration: configuration)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: endpoint.baseURL.appendingPathComponent("api/info"))
            request.setValue(endpoint.token, forHTTPHeaderField: "X-AgentShark-Token")
            final class ResponseBox: @unchecked Sendable { var events = 0 }
            var events = 0
            for _ in 0..<50 {
                let box = ResponseBox(), done = DispatchSemaphore(value: 0)
                session.dataTask(with: request) { data, _, _ in
                    defer { done.signal() }
                    guard let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let counts = object["counts"] as? [String: Any] else { return }
                    box.events = counts["events"] as? Int ?? 0
                }.resume()
                if done.wait(timeout: .now() + 4) != .success { break }
                events = box.events
                if events > 0 { break }
                Thread.sleep(forTimeInterval: 0.1)
            }
            guard events > 0 else { throw SourceLocationError("The bundled sample did not produce indexed events.") }
            process.terminate()
            process.waitUntilExit()
            guard !FileManager.default.fileExists(atPath: URL(fileURLWithPath: endpoint.indexPath).deletingLastPathComponent().path) else {
                throw SourceLocationError("The demo's temporary index was not cleaned up.")
            }
            print("Bundle verified: native launcher, bundled runtime, synthetic indexing, authenticated API, and cleanup (\(events) events).")
        } catch {
            fputs("Bundle verification failed: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
        exit(0)
    }
}
