import AppKit
import SwiftUI

/// What the raw text view shows: the text, each pointer's range in it, and how to label the gutter.
struct RawDocument: Equatable {
    enum Gutter: Equatable {
        case lineNumbers
        /// Absolute file offsets: the line starts at `base` bytes into the file.
        case byteOffsets(base: Int64)
    }

    /// Changes whenever the text changes (event, mode, full or shortened line).
    let id: String
    let text: String
    let ranges: [String: NSRange]
    let gutter: Gutter
}

/// The raw pane (MAC-SPEC §5): the selected event's source line, Pretty or Exact, with the selected field's
/// bytes highlighted, a header with the source location, and an explanation when the bytes are unavailable.
struct RawPane: View {
    @Bindable var model: WindowModel
    @Bindable var pane: EventsPaneState
    @State private var fullLine: RawResult?
    @State private var isLoadingFullLine = false
    @State private var headerWidth: CGFloat = 0
    @State private var cache = DocumentCache()

    /// Pretty-printing a long record is not free; the body re-runs on every highlight change.
    final class DocumentCache {
        var key: String?
        var document: RawDocument?
    }

    /// Lines up to this size are fetched in full for Exact mode.
    static let maxExactBytes = 8_000_000

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task(id: fullLineKey) { await loadFullLine() }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Text("Raw").font(Theme.fontSwiftUI(.paneTitle)).fixedSize()
            if let src = model.raw?.source ?? model.eventDetail.map({ RawResult.Source(id: $0.event.raw.source, path: $0.event.raw.path, line: $0.event.raw.line, offset: $0.event.raw.offset, length: $0.event.raw.length) }) {
                Button {
                    if let path = src.path { AppKitHelpers.revealInFinder(path) }
                } label: {
                    Text(src.path.map { ($0 as NSString).lastPathComponent } ?? src.id)
                        .lineLimit(1).truncationMode(.middle)
                }
                .buttonStyle(.link)
                // The file name keeps 120 pt (shortened in the middle) wherever the header has room for it, and about
                // ten characters (6 + 4 around the ellipsis) in a narrow inspector (§3.5).
                .frame(minWidth: headerWidth >= 380 ? 120 : 84, alignment: .leading)
                .layoutPriority(-1)
                .disabled(src.path == nil)
                .help(src.path.map { "\($0)\nClick to reveal the file in Finder." } ?? "The source path is not recorded.")
                if headerWidth >= 520 {
                    Text("line \(Formatters.count(src.line)) · \(Formatters.bytes(Int64(src.length)))")
                        .font(Theme.fontSwiftUI(.rowSecondary))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .layoutPriority(-2)
                        .help("Byte offset \(Formatters.count(Int(src.offset))) (0x\(String(src.offset, radix: 16, uppercase: true))), length \(Formatters.count(src.length)) bytes")
                }
            }
            Spacer(minLength: 4)
            // Below 360 pt the segmented control folds into a menu, so the file name keeps its room (M-24).
            Picker("Mode", selection: $pane.rawMode) {
                Text("Pretty").tag(EventsPaneState.RawMode.pretty)
                Text("Exact").tag(EventsPaneState.RawMode.exact)
            }
            .modifier(RawModePickerStyle(menu: headerWidth > 0 && headerWidth < 360))
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
            .layoutPriority(1)
            .help("Pretty: formatted JSON. Exact: the line as stored on disk, with byte offsets.")
            Toggle(isOn: $pane.wrapsRawLines) {
                Image(systemName: "text.word.spacing")
            }
            .toggleStyle(.button)
            .controlSize(.small)
            .iconHelp(pane.wrapsRawLines ? "Stop Wrapping Lines" : "Wrap Lines")
            Button {
                copyRaw()
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(model.raw?.text.isEmpty ?? true)
            .iconHelp("Copy the Source Line")
        }
        .padding(.horizontal, 12)
        .frame(height: model.app.preferences.metrics.paneHeader)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { headerWidth = $0 }
    }

    private func copyRaw() {
        let text = fullLine?.text ?? model.raw?.text ?? ""
        AppKitHelpers.copy(text)
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if model.selectedEvent == nil {
            ContentUnavailableView("No event selected", systemImage: "doc.plaintext",
                                   description: Text("The source line of the selected event appears here."))
        } else if let error = model.rawError {
            FailedStateView(title: "Could not read the source", message: "Your selection is preserved.", error: error) { model.reloadSelection() }
        } else if let raw = model.raw, matchesSelection(raw) {
            VStack(spacing: 0) {
                if let note = banner(raw) {
                    Label(note, systemImage: raw.available ? "info.circle" : "exclamationmark.triangle")
                        .font(.callout)
                        .foregroundStyle(raw.available ? Color.secondary : Color.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.bar)
                    Divider()
                }
                if let doc = cachedDocument(raw) {
                    RawTextRepresentable(document: doc, highlight: pane.rawHighlight, wraps: pane.wrapsRawLines,
                                         fontSize: Theme.TypeRole.code.size + model.app.preferences.rowDensity.sizeBump) { pointer in
                        pane.revealInDetail(rawPointer: pointer)
                    }
                } else {
                    ContentUnavailableView("No source text", systemImage: "doc.questionmark",
                                           description: Text("Neither the source line nor an indexed copy is available."))
                }
            }
        } else {
            LoadingStateView(title: "Reading the source…")
        }
    }

    /// The raw result belongs to the selected event's line (it arrives separately from the detail).
    private func matchesSelection(_ raw: RawResult) -> Bool {
        guard let d = model.eventDetail, d.event.id == model.selectedEvent else { return true }
        return raw.source.id == d.event.raw.source && raw.source.offset == d.event.raw.offset
    }

    private func banner(_ raw: RawResult) -> String? {
        if !raw.available {
            let reason = raw.reason ?? "the source file cannot be read"
            let fallback = model.eventDetail?.event.native != nil ? " Showing the indexed copy (long strings capped at 512 characters)." : ""
            return "Raw bytes unavailable: \(reason).\(fallback)"
        }
        if pane.rawMode == .exact {
            if isLoadingFullLine { return "Loading the full line…" }
            if fullLine == nil, raw.truncated {
                return "Long strings are shortened, so offsets after them are approximate. Lines over \(Formatters.bytes(Int64(Self.maxExactBytes))) are not loaded in full."
            }
        } else if raw.truncated {
            return "Strings longer than 4,000 characters are shortened. Exact shows the full line."
        }
        return nil
    }

    private func cachedDocument(_ raw: RawResult) -> RawDocument? {
        let key = "\(raw.source.id):\(raw.source.offset):\(raw.text.utf16.count):\(raw.available)|\(pane.rawMode.rawValue)|"
            + "\(fullLine?.text.utf16.count ?? -1)|\(raw.available ? "" : model.eventDetail?.event.id ?? "")"
        if cache.key != key {
            cache.key = key
            cache.document = document(raw)
        }
        return cache.document
    }

    private func document(_ raw: RawResult) -> RawDocument? {
        // Events on the same source line share one document.
        let id = "\(raw.source.id):\(raw.source.offset)"
        if !raw.available {
            guard let native = model.eventDetail?.event.native else {
                return raw.text.isEmpty ? nil : RawDocument(id: "\(id)|plain", text: raw.text, ranges: [:], gutter: .lineNumbers)
            }
            let p = RawJSON.pretty(native)
            return RawDocument(id: "\(model.selectedEvent ?? id)|indexed", text: p.text, ranges: p.ranges, gutter: .lineNumbers)
        }
        switch pane.rawMode {
        case .exact:
            let line = fullLine ?? raw
            var ranges: [String: NSRange] = [:]
            for p in line.ranges.keys { ranges[p] = line.range(for: p) }
            return RawDocument(id: "\(id)|exact|\(line.text.utf16.count)", text: line.text, ranges: ranges, gutter: .byteOffsets(base: line.source.offset))
        case .pretty:
            guard raw.text.utf16.count <= 3_000_000, let value = try? JSONValue.parse(raw.text) else {
                var ranges: [String: NSRange] = [:]
                for p in raw.ranges.keys { ranges[p] = raw.range(for: p) }
                return RawDocument(id: "\(id)|flat", text: raw.text, ranges: ranges, gutter: .byteOffsets(base: raw.source.offset))
            }
            let p = RawJSON.pretty(value)
            return RawDocument(id: "\(id)|pretty", text: p.text, ranges: p.ranges, gutter: .lineNumbers)
        }
    }

    // MARK: Full line for Exact mode

    private var fullLineKey: String {
        "\(model.selectedEvent ?? "")|\(pane.rawMode.rawValue)|\(model.raw?.truncated ?? false)"
    }

    private func loadFullLine() async {
        fullLine = nil
        guard pane.rawMode == .exact, let id = model.selectedEvent, let raw = model.raw, raw.available, raw.truncated,
              raw.source.length <= Self.maxExactBytes, let api = model.engine.api else { return }
        isLoadingFullLine = true
        defer { isLoadingFullLine = false }
        let full = try? await api.raw(id, maxString: raw.source.length + 64)
        guard !Task.isCancelled, model.selectedEvent == id else { return }
        fullLine = full
    }
}

/// Read-only `NSTextView` (TextKit 1) for the raw pane, with a gutter and a highlighted range.
struct RawTextRepresentable: NSViewRepresentable {
    let document: RawDocument
    let highlight: String?
    let wraps: Bool
    let fontSize: CGFloat
    let onClickPointer: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = RawScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let textView = NSTextView(usingTextLayoutManager: false)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.usesFindBar = true
        textView.isIncrementalSearchingEnabled = true
        textView.allowsUndo = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.textContainerInset = NSSize(width: 4, height: 4)
        textView.isVerticallyResizable = true
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = [.width]
        textView.drawsBackground = true
        textView.backgroundColor = .textBackgroundColor
        textView.delegate = context.coordinator
        textView.setAccessibilityLabel("Raw source record")
        scroll.documentView = textView
        let gutter = RawGutterView(scrollView: scroll, orientation: .verticalRuler)
        gutter.clientView = textView
        scroll.verticalRulerView = gutter
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true
        context.coordinator.textView = textView
        context.coordinator.gutter = gutter
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let c = context.coordinator
        c.onClickPointer = onClickPointer
        c.apply(document: document, wraps: wraps, fontSize: fontSize)
        c.highlight(document.ranges, pointer: highlight)
    }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        weak var textView: NSTextView?
        weak var gutter: RawGutterView?
        var onClickPointer: (String) -> Void = { _ in }
        private var documentID: String?
        private var ranges: [String: NSRange] = [:]
        private var highlighted: (pointer: String?, range: NSRange?)
        private var wraps: Bool?
        private var fontSize: CGFloat = 0

        func apply(document: RawDocument, wraps: Bool, fontSize: CGFloat) {
            guard let textView, let storage = textView.textStorage else { return }
            if document.id != documentID || fontSize != self.fontSize {
                documentID = document.id
                self.fontSize = fontSize
                ranges = document.ranges
                highlighted = (nil, nil)
                storage.setAttributedString(RawJSON.attributed(document.text, font: Theme.codeFont(size: fontSize)))
                textView.setSelectedRange(NSRange(location: 0, length: 0))
                (textView.enclosingScrollView as? RawScrollView)?.scrollToStart()
                gutter?.configure(text: document.text, gutter: document.gutter, font: Theme.dataFont(size: max(9, fontSize - 1)))
            }
            if wraps != self.wraps {
                self.wraps = wraps
                guard let container = textView.textContainer, let scroll = textView.enclosingScrollView as? RawScrollView else { return }
                scroll.wraps = wraps
                if wraps {
                    container.widthTracksTextView = true
                    textView.isHorizontallyResizable = false
                    scroll.tile()
                } else {
                    container.widthTracksTextView = false
                    textView.isHorizontallyResizable = true
                    container.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
                }
                gutter?.needsDisplay = true
            }
        }

        func highlight(_ ranges: [String: NSRange], pointer: String?) {
            guard let textView, let lm = textView.layoutManager else { return }
            // The whole record ("") is not worth highlighting.
            let range = pointer.flatMap { $0.isEmpty ? nil : ranges[$0] }
            guard highlighted.pointer != pointer || highlighted.range != range else { return }
            if let old = highlighted.range, NSMaxRange(old) <= lm.textStorage?.length ?? 0 {
                lm.removeTemporaryAttribute(.backgroundColor, forCharacterRange: old)
            }
            highlighted = (pointer, range)
            guard let range, NSMaxRange(range) <= textView.string.utf16.count else { return }
            lm.addTemporaryAttribute(.backgroundColor, value: Self.highlightColor, forCharacterRange: range)
            textView.scrollRangeToVisible(NSRange(location: range.location, length: min(range.length, 200)))
        }

        static let highlightColor = Theme.dynamic(0xFFE58A, 0x6B5A12)

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView, let type = NSApp.currentEvent?.type, type == .leftMouseUp || type == .leftMouseDown else { return }
            let sel = textView.selectedRange()
            guard sel.length == 0, let pointer = RawJSON.pointer(containing: sel.location, in: ranges), !pointer.isEmpty else { return }
            onClickPointer(pointer)
        }
    }
}

/// The raw pane's scroll view. The gutter is an overlay ruler that insets the clip view, so the text view
/// is sized and scrolled inside those insets.
final class RawScrollView: NSScrollView {
    var wraps = true

    override func tile() {
        super.tile()
        let insets = contentView.contentInsets
        if wraps, let doc = documentView {
            let width = max(0, floor(contentView.bounds.width - insets.left - insets.right))
            if abs(doc.frame.width - width) > 0.5 { doc.setFrameSize(NSSize(width: width, height: doc.frame.height)) }
        }
    }

    func scrollToStart() {
        let insets = contentView.contentInsets
        contentView.scroll(to: NSPoint(x: -insets.left, y: -insets.top))
        reflectScrolledClipView(contentView)
    }
}

/// Gutter for the raw pane: line numbers (Pretty) or absolute byte offsets of each visual line (Exact).
final class RawGutterView: NSRulerView {
    private var lineStarts: [Int] = [0]
    private var gutter: RawDocument.Gutter = .lineNumbers
    private var font = Theme.dataFont(size: 10)
    /// UTF-8 byte offset at every 1,024th UTF-16 index, to turn character positions into byte offsets.
    private var byteCheckpoints: [Int] = [0]
    private var utf16: [UInt16] = []
    private static let checkpointStride = 1024

    override init(scrollView: NSScrollView?, orientation: NSRulerView.Orientation) {
        super.init(scrollView: scrollView, orientation: orientation)
        ruleThickness = 40
        setAccessibilityElement(false)
    }

    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(text: String, gutter: RawDocument.Gutter, font: NSFont) {
        self.gutter = gutter
        self.font = font
        utf16 = Array(text.utf16)
        lineStarts = [0]
        for (i, u) in utf16.enumerated() where u == 0x0A { lineStarts.append(i + 1) }
        byteCheckpoints = [0]
        if case .byteOffsets = gutter {
            var bytes = 0
            var i = 0
            while i < utf16.count {
                if i % Self.checkpointStride == 0, i > 0 { byteCheckpoints.append(bytes) }
                bytes += Self.utf8Length(utf16, &i)
            }
        }
        let sample: String
        switch gutter {
        case .lineNumbers: sample = String(lineStarts.count)
        case .byteOffsets(let base): sample = "0x" + String(base + Int64(utf16.count * 3), radix: 16, uppercase: true)
        }
        let thickness = ceil((sample as NSString).size(withAttributes: [.font: font]).width) + 14
        if thickness != ruleThickness {
            ruleThickness = thickness
            // The text moves over only when the scroll view lays out its rulers again.
            scrollView?.tile()
        }
        needsDisplay = true
    }

    /// UTF-8 length of the scalar at `i` (advancing `i` past it).
    private static func utf8Length(_ u: [UInt16], _ i: inout Int) -> Int {
        let c = u[i]
        i += 1
        if c < 0x80 { return 1 }
        if c < 0x800 { return 2 }
        if c >= 0xD800, c < 0xDC00, i < u.count, u[i] >= 0xDC00, u[i] < 0xE000 { i += 1; return 4 }
        return 3
    }

    private func byteOffset(ofCharacter index: Int) -> Int {
        let cp = min(index / Self.checkpointStride, byteCheckpoints.count - 1)
        var bytes = byteCheckpoints[cp]
        var i = cp * Self.checkpointStride
        while i < min(index, utf16.count) { bytes += Self.utf8Length(utf16, &i) }
        return bytes
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView = clientView as? NSTextView, let lm = textView.layoutManager, let container = textView.textContainer else { return }
        NSColor.textBackgroundColor.setFill()
        bounds.fill()
        NSColor.separatorColor.setFill()
        NSRect(x: bounds.maxX - 1, y: bounds.minY, width: 1, height: bounds.height).fill()
        let visible = textView.visibleRect
        let glyphs = lm.glyphRange(forBoundingRect: visible, in: container)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.tertiaryLabelColor]
        let inset = textView.textContainerOrigin.y
        lm.enumerateLineFragments(forGlyphRange: glyphs) { [self] fragment, _, _, glyphRange, _ in
            let char = lm.characterIndexForGlyph(at: glyphRange.location)
            let label: String
            switch gutter {
            case .lineNumbers:
                guard let line = lineIndex(startingAt: char) else { return }
                label = String(line + 1)
            case .byteOffsets(let base):
                label = "0x" + String(base + Int64(byteOffset(ofCharacter: char)), radix: 16, uppercase: true)
            }
            let y = convert(NSPoint(x: 0, y: fragment.minY + inset), from: textView).y
            let size = (label as NSString).size(withAttributes: attrs)
            (label as NSString).draw(at: NSPoint(x: ruleThickness - size.width - 7, y: y + (fragment.height - size.height) / 2), withAttributes: attrs)
        }
    }

    /// The logical line that starts at `char`, or nil when `char` is inside a wrapped line.
    private func lineIndex(startingAt char: Int) -> Int? {
        var lo = 0, hi = lineStarts.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if lineStarts[mid] == char { return mid }
            if lineStarts[mid] < char { lo = mid + 1 } else { hi = mid - 1 }
        }
        return nil
    }
}

/// The Raw pane's Pretty | Exact control: segmented, or a menu in a narrow pane.
private struct RawModePickerStyle: ViewModifier {
    let menu: Bool

    func body(content: Content) -> some View {
        if menu { content.pickerStyle(.menu) } else { content.pickerStyle(.segmented) }
    }
}
