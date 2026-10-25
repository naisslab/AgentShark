import AppKit
import Quartz

/// Quick Look (Space) for the event table and the detail outline: the event's image, its persisted tool
/// output, its text, or its JSON, written to a temporary file when it is not a file already.
@MainActor final class QuickLookSource: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    private var items: [URL] = []
    /// Keyboard events the panel does not handle (arrow keys) go back to this view.
    weak var keyTarget: NSView?

    static let directory = FileManager.default.temporaryDirectory.appendingPathComponent("AgentShark-QuickLook", isDirectory: true)

    /// Show (or update) the panel with `url`.
    func show(_ url: URL) {
        items = [url]
        guard let panel = QLPreviewPanel.shared() else { return }
        if panel.isVisible {
            panel.reloadData()
        } else {
            panel.makeKeyAndOrderFront(nil)
        }
    }

    static var isVisible: Bool { QLPreviewPanel.sharedPreviewPanelExists() && QLPreviewPanel.shared().isVisible }

    static func close() {
        if isVisible { QLPreviewPanel.shared().orderOut(nil) }
    }

    func attach(_ panel: QLPreviewPanel) {
        panel.dataSource = self
        panel.delegate = self
    }

    func detach(_ panel: QLPreviewPanel) {
        panel.dataSource = nil
        panel.delegate = nil
    }

    nonisolated func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        MainActor.assumeIsolated { items.count }
    }

    nonisolated func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! {
        MainActor.assumeIsolated { items.indices.contains(index) ? items[index] as NSURL : nil }
    }

    nonisolated func previewPanel(_ panel: QLPreviewPanel!, handle event: NSEvent!) -> Bool {
        MainActor.assumeIsolated {
            guard let event, event.type == .keyDown, let keyTarget else { return false }
            keyTarget.keyDown(with: event)
            return true
        }
    }

    // MARK: Preparing the preview file

    /// A file to preview for an event: an image, the persisted output file, the text, or the event JSON.
    static func previewFile(for detail: EventDetail, api: APIClient?) async -> URL? {
        let attrs = detail.event.attrs
        let fm = FileManager.default
        for path in [attrs["file"]?["path"]?.stringValue, attrs["tool"]?["persisted_path"]?.stringValue].compactMap({ $0 }) {
            let ext = (path as NSString).pathExtension.lowercased()
            if DetailTreeBuilder.imageExtensions.contains(ext), fm.isReadableFile(atPath: path) { return URL(fileURLWithPath: path) }
        }
        if let image = embeddedImage(in: detail), let api, let url = await writeEmbeddedImage(image, event: detail.event.id, api: api) {
            return url
        }
        if let persisted = attrs["tool"]?["persisted_path"]?.stringValue, fm.isReadableFile(atPath: persisted) {
            return URL(fileURLWithPath: persisted)
        }
        let name = safeName(detail.event.id)
        if let output = attrs["tool"]?["output"]?.stringValue, !output.isEmpty {
            return write(output, name: "\(name) output.txt")
        }
        if let text = attrs["text"]?.stringValue, !text.isEmpty {
            return write(text, name: "\(name).txt")
        }
        if let input = attrs["tool"]?["input"], input.isContainer {
            return write(input.prettyPrinted, name: "\(name) input.json")
        }
        return write(detail.compositeDocument.prettyPrinted, name: "\(name).json")
    }

    /// The first base64 image in the native record: (raw pointer, media type, bytes).
    static func embeddedImage(in detail: EventDetail) -> (pointer: String, mediaType: String, bytes: Int)? {
        guard let native = detail.event.native else { return nil }
        var found: (String, String, Int)?
        func walk(_ v: JSONValue, _ p: String, parent: JSONObject?) {
            guard found == nil else { return }
            switch v {
            case .object(let o):
                if o["$omitted"] != nil {
                    let type = o["mediaType"]?.stringValue ?? parent?["media_type"]?.stringValue ?? parent?["mediaType"]?.stringValue
                    if let type, type.hasPrefix("image/") { found = (p, type, o["bytes"]?.intValue ?? 0) }
                    return
                }
                for (k, x) in o { walk(x, p + "/" + JSONValue.escapePointerToken(k), parent: o) }
            case .array(let a):
                for (i, x) in a.enumerated() { walk(x, "\(p)/\(i)", parent: nil) }
            default:
                break
            }
        }
        walk(native, "", parent: nil)
        return found.map { ($0.0, $0.1, $0.2) }
    }

    /// Embedded payloads above this size are not fetched for previews.
    static let maxEmbeddedBytes = 16_000_000

    /// Fetch an embedded base64 image from the source line and decode it.
    static func loadEmbeddedImage(event: String, rawPointer: String, bytes: Int, api: APIClient) async -> Data? {
        guard bytes <= maxEmbeddedBytes else { return nil }
        guard let raw = try? await api.raw(event, maxString: max(4000, bytes * 2 + 64)), raw.available,
              let value = RawJSON.value(at: rawPointer, inRecord: raw.text)?.stringValue else { return nil }
        var b64 = Substring(value)
        if b64.hasPrefix("data:"), let comma = b64.firstIndex(of: ",") { b64 = b64[b64.index(after: comma)...] }
        return Data(base64Encoded: String(b64), options: .ignoreUnknownCharacters)
    }

    private static func writeEmbeddedImage(_ image: (pointer: String, mediaType: String, bytes: Int), event: String,
                                           api: APIClient) async -> URL? {
        guard let data = await loadEmbeddedImage(event: event, rawPointer: image.pointer, bytes: image.bytes, api: api) else { return nil }
        let ext = image.mediaType.split(separator: "/").last.map(String.init) ?? "png"
        return write(data, name: "\(safeName(event)) image.\(ext == "jpeg" ? "jpg" : ext)")
    }

    static func write(_ text: String, name: String) -> URL? {
        write(Data(text.utf8), name: name)
    }

    static func write(_ data: Data, name: String) -> URL? {
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        // Keep the folder small: only the latest previews.
        if let old = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil), old.count > 20 {
            for url in old { try? fm.removeItem(at: url) }
        }
        let url = directory.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }

    static func safeName(_ s: String) -> String {
        String(s.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." ? $0 : "_" })
    }
}
