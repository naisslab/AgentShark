import Foundation
import Observation

/// A conversation item with its text parsed once, for rendering and for search.
struct ConversationEntry: Identifiable, Hashable {
    let item: ConversationItem
    /// Parsed Markdown for prompts, answers and compaction summaries; plain text elsewhere.
    let blocks: [MessageBlock]
    /// Lowercased text that ⌘F searches: message text, tool name, input and output.
    let searchText: String

    var id: String { item.id }

    init(_ item: ConversationItem) {
        self.item = item
        let text = item.text ?? ""
        switch item.type {
        case "prompt", "text", "compaction", "error": blocks = text.isEmpty ? [] : MessageBlock.parse(text)
        default: blocks = []
        }
        var parts = [text, item.subagent?.title ?? "", item.subagent?.type ?? ""]
        if let t = item.tool {
            parts += [t.name, t.inputSummary ?? "", t.output ?? ""]
            if let input = t.input { parts.append(input.stringValue ?? input.compactText) }
        }
        searchText = parts.joined(separator: "\n").lowercased()
    }

    /// The index copy of the text was capped; the raw record has the rest.
    var textIsTruncated: Bool { ConversationText.isTruncated(item.text, length: item.textLen) }
    var outputIsTruncated: Bool {
        guard let t = item.tool else { return false }
        return t.resultEvent != nil && ConversationText.isTruncated(t.output, length: t.outputLen)
    }
}

/// Loads one session's transcript page by page (`/api/conversation`, opaque cursor), most recent request wins.
@MainActor @Observable final class ConversationModel {
    enum Phase: Equatable {
        case idle, loading, failed(APIError), ready
    }

    private(set) var sessionID: String?
    private(set) var entries: [ConversationEntry] = []
    /// The first page's state; later pages report failures through `moreError`.
    private(set) var phase: Phase = .idle
    private(set) var moreError: APIError?
    private(set) var isComplete = false
    /// Find's Load All is fetching the remaining pages.
    private(set) var isLoadingAll = false
    /// The session row the transcript was loaded against (for the header and to notice new activity).
    private(set) var session: SessionRow?
    private(set) var sessionError: APIError?

    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var cursor: JSONValue?
    @ObservationIgnored private var seen: Set<String> = []
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var pageTask: Task<Void, Never>?
    @ObservationIgnored private var loadAllTask: Task<Void, Never>?

    static let pageSize = 200

    /// Show `id` (no-op when it is already shown). `known` is the catalog's row, when it has one.
    func open(_ id: String?, api: APIClient?, known: SessionRow?) {
        if id == sessionID, api === self.api, phase != .idle { return }
        generation += 1
        pageTask?.cancel()
        pageTask = nil
        loadAllTask?.cancel()
        loadAllTask = nil
        isLoadingAll = false
        sessionID = id
        self.api = api
        entries = []
        seen = []
        cursor = nil
        isComplete = false
        moreError = nil
        session = known
        sessionError = nil
        guard let id else {
            phase = .idle
            return
        }
        phase = .loading
        if known == nil { loadSession(id) }
        loadMore()
    }

    /// Reload from the start (Retry, or new activity in the session).
    func reload(known: SessionRow?) {
        let id = sessionID
        sessionID = nil
        open(id, api: api, known: known)
    }

    /// Load the next page unless one is loading or the transcript is complete.
    func loadMore() {
        guard let id = sessionID, let api, !isComplete, pageTask == nil else { return }
        let gen = generation
        let after = cursor
        moreError = nil
        pageTask = Task { [weak self] in
            do {
                let page = try await api.conversation(session: id, after: after, limit: Self.pageSize)
                guard let self, self.generation == gen else { return }
                self.append(page, after: after)
            } catch is CancellationError {
            } catch {
                guard let self, self.generation == gen else { return }
                let e = error as? APIError ?? .unreachable(error)
                if self.entries.isEmpty { self.phase = .failed(e) } else { self.moreError = e }
            }
            guard let self, self.generation == gen else { return }
            self.pageTask = nil
        }
    }

    /// Load every remaining page (⌘F's "Load All").
    func loadAll() {
        guard loadAllTask == nil else { return }
        let gen = generation
        isLoadingAll = true
        loadAllTask = Task { [weak self] in
            while let self, self.generation == gen, !self.isComplete, self.moreError == nil, !Task.isCancelled {
                if self.pageTask == nil { self.loadMore() }
                guard let page = self.pageTask else { break }
                await page.value
                if case .failed = self.phase { break }
            }
            guard let self, self.generation == gen else { return }
            self.loadAllTask = nil
            self.isLoadingAll = false
        }
    }

    private func append(_ page: ConversationPage, after: JSONValue?) {
        let fresh = page.items.filter { seen.insert($0.id).inserted }
        entries += fresh.map(ConversationEntry.init)
        // A repeated cursor would loop forever; treat it as the end.
        isComplete = page.next == nil || page.next == after || page.items.isEmpty
        cursor = page.next
        phase = .ready
    }

    private func loadSession(_ id: String) {
        guard let api else { return }
        let gen = generation
        Task { [weak self] in
            do {
                let detail = try await api.session(id)
                guard let self, self.generation == gen else { return }
                self.session = detail.session.row
            } catch {
                guard let self, self.generation == gen else { return }
                self.sessionError = error as? APIError ?? .unreachable(error)
            }
        }
    }

    // MARK: Search

    /// IDs of the loaded entries that contain `query` (case-insensitive), in transcript order.
    func matches(_ query: String) -> [String] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        return entries.filter { $0.searchText.contains(q) }.map(\.id)
    }
}

/// Full text of an item from its raw source record, when the index copy was capped (port of the web viewer's
/// extractText and extractOutput for Claude and Codex records).
enum ConversationText {
    /// Ask for practically unshortened strings.
    static let fullMaxString = 4_000_000

    static func isTruncated(_ text: String?, length: Int?) -> Bool {
        guard let text else { return length.map { $0 > 0 } ?? false }
        if let length, length > text.count { return true }
        return text.range(of: #"…\[\+\d+( chars)?\]\s*$"#, options: .regularExpression) != nil
    }

    /// The content block of an event ID `<source>:<line>.<block>`.
    static func block(of eventID: String) -> Int? {
        guard let dot = eventID.lastIndex(of: "."), let colon = eventID.lastIndex(of: ":"), colon < dot else { return nil }
        return Int(eventID[eventID.index(after: dot)...])
    }

    static func contentText(_ c: JSONValue?) -> String? {
        guard let c else { return nil }
        switch c {
        case .null: return nil
        case .string(let s): return s
        case .array(let items):
            return items.map { x -> String in
                if let s = x.stringValue { return s }
                if let t = x["text"]?.stringValue { return t }
                return (x["type"]?.stringValue ?? "").contains("image") ? "[image]" : ""
            }.joined(separator: "\n")
        default:
            return c["text"]?.stringValue ?? c.prettyPrinted
        }
    }

    /// A tool result's output.
    static func output(from record: JSONValue, block: Int?) -> String? {
        if let content = record["message"]?["content"]?.arrayValue {
            let results = content.filter { $0["type"]?.stringValue == "tool_result" }
            let picked = block.flatMap { content.indices.contains($0) && content[$0]["type"]?.stringValue == "tool_result" ? content[$0] : nil }
                ?? (results.count == 1 ? results[0] : nil)
            if let picked { return contentText(picked["content"]) }
        }
        if let tur = record["toolUseResult"] {
            if let s = tur.stringValue { return s }
            if let out = tur["stdout"]?.stringValue {
                let err = tur["stderr"]?.stringValue ?? ""
                return err.isEmpty ? out : "\(out)\n[stderr]\n\(err)"
            }
        }
        if let p = record["payload"] {
            if let o = p["output"], o != .null, let s = contentText(o) {
                if let inner = try? JSONValue.parse(s), let text = inner["output"]?.stringValue { return text }
                return s
            }
            for key in ["aggregated_output", "formatted_output", "stdout"] {
                if let s = p[key]?.stringValue { return s }
            }
            if let s = p["item"]?["aggregatedOutput"]?.stringValue { return s }
        }
        return nil
    }

    /// A message's text.
    static func text(from record: JSONValue, block: Int?) -> String? {
        let content = record["message"]?["content"]
        if let s = content?.stringValue { return s }
        if let blocks = content?.arrayValue {
            let b = block.flatMap { blocks.indices.contains($0) ? blocks[$0] : nil } ?? blocks.first { $0["text"]?.stringValue != nil }
            if let b { return b["text"]?.stringValue ?? b["thinking"]?.stringValue ?? contentText(b["content"]) }
        }
        if let p = record["payload"] {
            if let s = p["message"]?.stringValue { return s }
            if let s = p["text"]?.stringValue { return s }
            if let c = p["content"], c.arrayValue != nil { return contentText(c) }
            if let c = p["summary"], c.arrayValue != nil { return contentText(c) }
        }
        return nil
    }
}
