import AppKit
import UserNotifications

/// Alarm notifications (SPEC §12.7): off by default, offered once, and only for the `consecutive` and `blocker` alarms
/// whose kind is on in Settings ▸ Alerts. Clicking one opens the Lens with a Live chip: the alarm's episode, else its
/// delegation, else Session · Steps at its session.
@MainActor final class AppNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AppNotifications()

    /// The notification center needs an app bundle; tests and the command-line self-test run without one.
    private var center: UNUserNotificationCenter? {
        Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil ? .current() : nil
    }

    func start() {
        center?.delegate = self
    }

    func requestAuthorization() {
        center?.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// The text of an alarm notification, e.g. "Codex · AgentShark: 2 failures blocked by the environment; agents
    /// recover from these 2–7% of the time".
    static func text(kind: AlarmKind, agent: AgentKind?, project: String?, thresholds: AlarmThresholds?) -> (title: String, body: String) {
        let title = [agent?.label, project].compactMap { $0 }.joined(separator: " · ")
        switch kind {
        case .blocker:
            let n = thresholds?.blocker ?? 2
            return (title, "\(n) failures blocked by the environment (sandbox, policy or network); agents recover from these 2–7% of the time.")
        case .consecutive:
            let n = thresholds?.consecutive ?? 6
            return (title, "\(n) failures in a row with no successful call between them; 89% of such turns ended failed, blocked or interrupted.")
        default:
            return (title, DerivedStyle.alarmWord(kind).capitalized)
        }
    }

    func post(_ a: AlarmStreamEvent, store: EngineStore, preferences: Preferences) {
        guard let center, a.notify, a.state == .firing, preferences.notifies(a.kind) else { return }
        let session = store.sessionsByID[a.sessionId]
        let root = session.flatMap { store.sessionsByID[$0.rootId] } ?? session
        let t = Self.text(kind: a.kind, agent: session?.agent, project: root?.project ?? root?.displayTitle, thresholds: store.info?.analysis?.alarmThresholds)
        let content = UNMutableNotificationContent()
        content.title = t.title.isEmpty ? "AgentShark" : t.title
        content.body = t.body
        content.sound = .default
        content.userInfo = ["sessionId": a.sessionId, "episodeId": a.episodeId ?? "", "delegationId": a.delegationId ?? "", "alarmId": a.id]
        center.add(UNNotificationRequest(identifier: a.id, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let session = info["sessionId"] as? String ?? ""
        let episode = info["episodeId"] as? String ?? ""
        let delegation = info["delegationId"] as? String ?? ""
        Task { @MainActor in
            AppModel.shared.openAlarm(session: session, episode: episode.isEmpty ? nil : episode, delegation: delegation.isEmpty ? nil : delegation)
            completionHandler()
        }
    }
}

extension AppModel {
    /// A notification click: the front window opens the alarm's Lens (or its session's steps).
    func openAlarm(session: String, episode: String?, delegation: String?) {
        NSApp.activate()
        guard let m = frontWindowModel else {
            openWindow(.newLive())
            return
        }
        m.hostWindow?.makeKeyAndOrderFront(nil)
        if let episode {
            m.openEpisode(episode)
        } else if let delegation {
            m.openLens(LensItem(kind: .delegation, id: delegation))
        } else if !session.isEmpty {
            m.openSession(session, mode: .steps)
        }
    }
}
