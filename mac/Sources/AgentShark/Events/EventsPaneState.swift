import Foundation
import Observation

/// State the Events workspace's panes share: which source bytes to highlight, raw → detail reveal requests,
/// the long-string sheet and the raw pane's mode.
@MainActor @Observable final class EventsPaneState {
    enum RawMode: String, CaseIterable, Hashable { case pretty, exact }

    /// A long string opened from the detail outline (double-click).
    struct LongText: Identifiable, Hashable {
        let id = UUID()
        let title: String
        let text: String
        /// The event and raw pointer, to load the full value when the index copy was shortened.
        let event: String?
        let rawPointer: String?
        var isShortened: Bool { text.range(of: #"…\[\+\d+( chars)?\]$"#, options: .regularExpression) != nil }
    }

    /// Pointer into the source record whose bytes the raw pane highlights.
    var rawHighlight: String?
    /// Raw pane → detail outline: reveal and select the native node at this raw pointer. The counter makes
    /// repeated clicks on the same bytes count.
    private(set) var revealRequest: (pointer: String, serial: Int)?
    var longText: LongText?
    var rawMode: RawMode {
        didSet { UserDefaults.standard.set(rawMode.rawValue, forKey: "AgentShark.rawMode") }
    }
    var wrapsRawLines: Bool {
        didSet { UserDefaults.standard.set(wrapsRawLines, forKey: "AgentShark.rawWraps") }
    }

    init() {
        rawMode = UserDefaults.standard.string(forKey: "AgentShark.rawMode").flatMap(RawMode.init(rawValue:)) ?? .pretty
        wrapsRawLines = UserDefaults.standard.object(forKey: "AgentShark.rawWraps") as? Bool ?? true
    }

    func revealInDetail(rawPointer: String) {
        revealRequest = (rawPointer, (revealRequest?.serial ?? 0) + 1)
    }
}
