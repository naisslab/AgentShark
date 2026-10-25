// swift-tools-version: 6.0
// AgentShark for macOS. Build the app bundle with scripts/build-app.sh.

import PackageDescription

let package = Package(
    name: "AgentShark",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "AgentShark",
            path: "Sources/AgentShark"
        ),
    ],
    swiftLanguageModes: [.v5]
)
