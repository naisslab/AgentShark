import AppKit
import SwiftUI

@main
enum Main {
    static func main() {
        if CommandLine.arguments.contains("--verify-bundle") { BundleVerification.run() }
        // Hidden entry for the integrator: run headless against the live engine and exit.
        if CommandLine.arguments.contains("--self-test") { SelfTest.run() }
        // Hidden entry for screenshot review: draw every workspace offscreen and exit.
        if CommandLine.arguments.contains("--snapshot") { MainActor.assumeIsolated { Snapshot.run(arguments: CommandLine.arguments) } }
        AgentSharkApp.main()
    }
}

struct AgentSharkApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup(for: WindowTarget.self) { $target in
            WindowRoot(target: target)
        } defaultValue: {
            WindowTarget.newLive()
        }
        .defaultSize(width: 1440, height: 900)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { AgentSharkCommands(app: AppModel.shared) }

        Settings {
            SettingsView(app: AppModel.shared)
        }
        // The live research tools open in the browser (Analyze menu). The bundled demo has a window of its own because the
        // window starts and stops the demo engine.
        Window("AgentShark Demo", id: "demo-workbench") {
            DemoWorkbenchWindow(app: AppModel.shared)
        }
        .defaultSize(width: 1300, height: 850)
        // One row: the title and its subtitle share the toolbar with Open in Browser (ANALYSIS-UX §6.2).
        .windowToolbarStyle(.unified)
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    private var terminationSignal: DispatchSourceSignal?

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = true
        // SIGTERM (logout, `kill`) quits normally, so the engines stop with the app.
        Foundation.signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }
        source.resume()
        terminationSignal = source
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppModel.shared.start()
        AppNotifications.shared.start()
    }

    /// The Dock menu reaches Settings and a new window while another app is frontmost.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem("New Window") {
            NSApp.activate()
            AppModel.shared.openWindow(.newLive())
        }
        menu.addItem("Settings…") {
            NSApp.activate()
            AppModel.shared.openSettingsHandler?()
            AppKitHelpers.bringSettingsToFront()
        }
        return menu
    }

    /// Double-clicked or dropped `.agentcap`, `.agentcap.zst` and `.agentcap.gz` files.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where AppModel.isCaptureFile(url) {
            AppModel.shared.openCapture(url)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // The end of this visit: the next launch opens Failures when newer attention items exist (SPEC §12.7 Entry).
        AppModel.shared.markVisit()
        AppModel.shared.terminateAllEngines()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}
