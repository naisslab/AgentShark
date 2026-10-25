import AppKit
import Foundation

/// One row of the detail outline: a name, a value and a dimmed annotation (SPEC §7.4).
final class DetailNode: NSObject {
    enum Style { case plain, string, number, literal, muted, error, warning }

    enum Link: Hashable {
        case event(String)
        case session(String)
        case file(String)
        /// Opens the episode in the Lens.
        case episode(String)
        /// Shows the diff of a change.
        case diff(event: String, path: String?)
    }

    enum Image: Hashable {
        /// A side file on disk (`file.path`, `tool.persisted_path`).
        case file(String)
        /// A base64 payload inside the source record, at this raw pointer.
        case embedded(rawPointer: String, mediaType: String, bytes: Int)
    }

    /// Stable path ("decoded/tool/name"), so the selected field stays selected on the next event.
    let id: String
    let name: String
    var value: String
    var annotation: String?
    var style: Style = .plain
    var isMonospaced = false
    var isLayer = false
    /// Pointer into the composite document `{"event", "attrs", "native"}` (fieldMap, Apply as Filter).
    var pointer: String?
    /// Pointer into the source record, for highlighting raw bytes.
    var rawPointer: String?
    /// Filter field and value for nodes outside the composite document (session, turn and span layers).
    var field: String?
    var filterValue: JSONValue?
    var copyValue: String?
    /// The full text of a long string; double-click opens it in a sheet.
    var fullText: String?
    var link: Link?
    var image: Image?
    /// The Failure layer's tier, drawn once as a badge before its value (§7.10): Solid for failure, Outline otherwise.
    var tier: FailureTier?
    weak var parent: DetailNode?

    private var makeChildren: (() -> [DetailNode])?
    private var builtChildren: [DetailNode]?

    init(id: String, name: String, value: String, annotation: String? = nil, style: Style = .plain) {
        self.id = id
        self.name = name
        self.value = value
        self.annotation = annotation
        self.style = style
    }

    func setChildren(_ nodes: [DetailNode]) {
        builtChildren = nodes
        makeChildren = nil
        for n in nodes { n.parent = self }
    }

    /// Children built on first access (the native record can be large).
    func setLazyChildren(_ make: @escaping () -> [DetailNode]) {
        builtChildren = nil
        makeChildren = make
    }

    var children: [DetailNode] {
        if let builtChildren { return builtChildren }
        let nodes = makeChildren?() ?? []
        setChildren(nodes)
        return nodes
    }

    var isExpandable: Bool { builtChildren.map { !$0.isEmpty } ?? (makeChildren != nil) }

    /// Depth-first search through children (builds lazy children on the way).
    func first(where match: (DetailNode) -> Bool) -> DetailNode? {
        if match(self) { return self }
        for c in children {
            if let hit = c.first(where: match) { return hit }
        }
        return nil
    }

    override var description: String { "\(name): \(value)" }
}

/// Builds the detail layers for one event: Event, Session, Turn, Span, the decoded layer for its kind, Related
/// events and the Native record.
enum DetailTreeBuilder {
    /// Strings longer than this (or with a newline) show their first line and open in a sheet.
    static let longString = 140
    static let attrOrder = ["text", "tool", "llm", "tokens", "agent", "turn", "hook", "error", "permission", "context", "file",
                            "ratelimit", "cost"]
    static let msFields: Set<String> = ["thinking_ms", "ttft_ms", "latency_ms", "reported_wall_ms", "retry_in_ms", "duration_ms"]
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "tiff"]

    static let decodedLabels: [String: String] = [
        "tool.call": "Tool Call", "tool.result": "Tool Result", "tool.exec": "Tool Execution", "llm.text": "Model Output",
        "llm.thinking": "Thinking", "llm.usage": "Token Usage", "llm.error": "Model API Error", "llm.refusal": "Refusal",
        "user.prompt": "User Prompt", "user.inject": "Injected Content", "agent.spawn": "Subagent Launch",
        "agent.message": "Agent Message", "agent.status": "Subagent Status", "context.compaction": "Compaction",
        "hook.run": "Hook", "permission.request": "Permission Request", "permission.decision": "Permission Decision",
    ]

    static func layers(for detail: EventDetail, session: SessionRow?, derived: EventDerived? = nil, analysis: AnalysisStatus? = nil,
                       title: (String) -> String) -> [DetailNode] {
        let ev = detail.event
        let derived = derived?.eventId == ev.id ? derived : nil
        var out: [DetailNode] = [eventLayer(detail)]
        if let d = derived, let f = failureLayer(d, analysis: analysis, quiet: noFailureText(detail.span, event: ev.id)) { out.append(f) }
        out.append(sessionLayer(ev.session, session, title: title))
        let turn = detail.spanChain.first { $0.kind == .turn } ?? (detail.span?.kind == .turn ? detail.span : nil)
        if let turn { out.append(turnLayer(turn, title: title)) }
        if let step = derived?.step { out.append(stepLayer(step, turnIndex: turn?.attrs?["turn"]?["index"]?.intValue)) }
        if let span = detail.span, span.kind != .turn { out.append(spanLayer(span, chain: detail.spanChain, title: title)) }
        if let decoded = decodedLayer(detail) { out.append(decoded) }
        if !detail.related.isEmpty { out.append(relatedLayer(detail.related)) }
        out.append(nativeLayer(detail))
        for l in out { l.isLayer = true }
        return out
    }

    // MARK: Event

    private static func eventLayer(_ d: EventDetail) -> DetailNode {
        let ev = d.event
        let layer = DetailNode(id: "event", name: ev.no.map { "Event No. \(Formatters.count($0))" } ?? "Event",
                               value: "\(ev.kind.rawValue) · \(ev.actor.rawValue) · \(Formatters.clock(ev.ts, zone: Formatters.timeZone))")
        layer.pointer = "/event"
        var kids: [DetailNode] = []
        func add(_ key: String, _ name: String, _ value: String, annotation: String? = nil, style: DetailNode.Style = .plain,
                 mono: Bool = false) -> DetailNode {
            let n = DetailNode(id: "event/\(key)", name: name, value: value, annotation: annotation, style: style)
            n.pointer = "/event/\(key)"
            n.isMonospaced = mono
            kids.append(n)
            return n
        }
        _ = add("kind", "Kind", ev.kind.rawValue, mono: true)
        _ = add("proto", "Record type", ev.proto, mono: true)
        _ = add("actor", "Actor", ev.actor.rawValue)
        let time = add("ts", "Time", Formatters.timestamp(ev.ts),
                       annotation: ev.tsSrc == "logged" ? "logged" : "timestamp \(ev.tsSrc)", style: ev.tsSrc == "logged" ? .plain : .warning)
        time.copyValue = Formatters.iso8601(ev.ts)
        _ = add("seq", "Sequence", String(ev.seq), annotation: "file order", style: .number)
        let flags = add("flags", "Flags", ev.flags.isEmpty ? "none" : ev.flags.joined(separator: ", "),
                        style: ev.isError ? .error : ev.flags.isEmpty ? .muted : .plain)
        flags.setChildren(ev.flags.enumerated().map { i, f in
            let n = DetailNode(id: "event/flags/\(f)", name: "[\(i)]", value: f, annotation: flagHint(f), style: f == "error" ? .error : .plain)
            n.pointer = "/event/flags/\(i)"
            return n
        })
        // An API error or refusal is an instant: its span's timestamp gap is not how long the error took.
        if let dur = ev.dur, ev.kind != .llmError, ev.kind != .llmRefusal {
            let src = d.span.flatMap { $0.dur == dur ? $0.durSrc : nil }
            _ = add("dur", "Duration", Formatters.duration(dur, src: src),
                    annotation: (src.map(Formatters.provenance) ?? "of this event's span") + " · \(Formatters.count(Int(dur))) µs",
                    style: .number)
        }
        if ev.tokIn != nil || ev.tokOut != nil {
            let n = DetailNode(id: "event/tokens", name: "Tokens",
                               value: "\(Formatters.tokens(ev.tokIn)) in · \(Formatters.tokens(ev.tokOut)) out", style: .number)
            n.setChildren([
                ev.tokIn.map { v -> DetailNode in
                    let c = DetailNode(id: "event/tokIn", name: "Input", value: Formatters.count(v), annotation: "all prompt tokens, incl. cache",
                                       style: .number)
                    c.pointer = "/event/tokIn"
                    return c
                },
                ev.tokOut.map { v -> DetailNode in
                    let c = DetailNode(id: "event/tokOut", name: "Output", value: Formatters.count(v), style: .number)
                    c.pointer = "/event/tokOut"
                    return c
                },
            ].compactMap { $0 })
            kids.append(n)
        }
        if let tool = ev.toolName { _ = add("toolName", "Tool", tool, annotation: ToolKinds.kind(of: tool)) }
        if let model = ev.model { _ = add("model", "Model", model, mono: true) }
        _ = add("id", "Event ID", ev.id, mono: true)
        let raw = ev.raw
        let location = "\(raw.path ?? raw.source):\(raw.line)"
        let src = DetailNode(id: "event/source", name: "Source", value: location,
                             annotation: "offset \(Formatters.count(Int(raw.offset))) · \(Formatters.bytes(Int64(raw.length)))"
                                 + (raw.block.map { " · block \($0)" } ?? ""))
        src.isMonospaced = true
        src.copyValue = location
        if let path = raw.path { src.link = .file(path) }
        kids.append(src)
        layer.setChildren(kids)
        return layer
    }

    static func flagHint(_ flag: String) -> String? {
        switch flag {
        case "error": return "the event is a failure"
        case "inherited": return "copied context (resumed prefix)"
        case "dup": return "the same information is in another event"
        case "orphan": return "a result whose call was never found"
        case "inferred": return "a link or value that was guessed"
        case "truncated": return "text was cut in the index"
        case "abandoned": return "replaced by a later rewind"
        case "meta": return "harness-injected prompt"
        case "sidechain": return "sidechain record"
        default: return nil
        }
    }

    // MARK: Session

    private static func sessionLayer(_ id: String, _ s: SessionRow?, title: (String) -> String) -> DetailNode {
        let layer = DetailNode(id: "session", name: "Session", value: s.map { "\($0.agent.label) · \($0.displayTitle)" } ?? id)
        guard let s else {
            layer.setChildren([sessionLink("session/id", "Session", id, title: title)])
            return layer
        }
        var kids: [DetailNode] = [sessionLink("session/id", "Session", s.id, title: title)]
        func kv(_ key: String, _ name: String, _ value: String?, field: String? = nil, annotation: String? = nil,
                style: DetailNode.Style = .plain, mono: Bool = false) {
            let missing = value?.isEmpty ?? true
            let n = DetailNode(id: "session/\(key)", name: name, value: missing ? Formatters.missing : value!, annotation: annotation,
                               style: missing ? .muted : style)
            n.isMonospaced = mono
            if let field, !missing {
                n.field = field
                n.filterValue = .string(value!)
            }
            kids.append(n)
        }
        kv("agent", "Agent", s.agent.label, annotation: s.agent.rawValue)
        kids.last?.field = "agent"
        kids.last?.filterValue = .string(s.agent.rawValue)
        kv("role", "Role", s.role, field: "session.role")
        kv("state", "State", s.state == "ok" ? "ok" : s.state,
           annotation: s.isMissingSource ? "the transcript file is gone; only indexed data remains" : nil,
           style: s.isMissingSource ? .warning : .plain)
        kv("title", "Title", s.title, field: "session.title")
        kv("project", "Project", s.project, field: "project")
        kv("cwd", "Working directory", s.cwd, field: "session.cwd", mono: true)
        kv("branch", "Git branch", s.gitBranch, field: "branch")
        kv("models", "Models", s.models.joined(separator: ", "))
        kv("version", "Version", s.version)
        kv("entrypoint", "Entrypoint", [s.entrypoint, s.originator].compactMap { $0 }.joined(separator: " · "))
        if let start = s.start {
            let range = Formatters.timeRange(from: start, to: s.end)
            kv("active", "Active", range, annotation: s.end.map { Formatters.duration($0 - start) })
        }
        kv("counts", "Counts", "\(Formatters.count(s.nEvents, "event")) · \(Formatters.count(s.nTurns, "turn")) · "
            + "\(Formatters.count(s.nLlm, "model call")) · \(Formatters.count(s.nTools, "tool call")) · \(Formatters.count(s.nErrors, "error"))")
        kv("tokens", "Tokens", "\(Formatters.tokens(s.tokens.input)) in · \(Formatters.tokens(s.tokens.output)) out",
           annotation: s.costUsd.map { "logged cost \(Formatters.cost($0))" })
        if let p = s.parentId { kids.append(sessionLink("session/parent", "Parent session", p, title: title)) }
        if s.rootId != s.id, s.rootId != s.parentId { kids.append(sessionLink("session/root", "Root session", s.rootId, title: title)) }
        if s.nChildren > 0 { kv("children", "Subagents", Formatters.count(s.nChildren)) }
        layer.setChildren(kids)
        return layer
    }

    private static func sessionLink(_ id: String, _ name: String, _ session: String, title: (String) -> String) -> DetailNode {
        let t = title(session)
        let n = DetailNode(id: id, name: name, value: t == session ? session : t, annotation: t == session ? nil : session)
        n.link = .session(session)
        n.copyValue = session
        n.field = "session"
        n.filterValue = .string(session)
        return n
    }

    // MARK: Turn and span

    private static func turnLayer(_ turn: SpanRow, title: (String) -> String) -> DetailNode {
        let index = turn.attrs?["turn"]?["index"]?.intValue
        let layer = DetailNode(id: "turn", name: index.map { "Turn \($0)" } ?? "Turn",
                               value: (turn.name.isEmpty ? "(no prompt)" : turn.name) + (turn.dur.map { " · " + Formatters.duration($0, src: turn.durSrc) } ?? ""))
        // The turn's id selects its events (`turn == "<id>"`), so the layer itself applies as a filter.
        layer.field = "turn"
        layer.filterValue = .string(turn.id)
        layer.setChildren(spanChildren("turn", turn, title: title))
        return layer
    }

    private static func spanLayer(_ span: SpanRow, chain: [SpanRow], title: (String) -> String) -> DetailNode {
        let layer = DetailNode(id: "span", name: "Span: \(span.kind.rawValue)",
                               value: (span.name.isEmpty ? span.id : span.name)
                                   + (span.dur.map { " · " + Formatters.duration($0, src: span.durSrc) } ?? "") + " · \(span.status.rawValue)",
                               style: span.status == .error ? .error : .plain)
        let nesting = DetailNode(id: "span/nesting", name: "Nesting", value: (chain.map(\.kind.rawValue) + [span.kind.rawValue]).joined(separator: " › "))
        layer.setChildren([nesting] + spanChildren("span", span, title: title))
        return layer
    }

    private static func spanChildren(_ prefix: String, _ span: SpanRow, title: (String) -> String) -> [DetailNode] {
        var kids: [DetailNode] = []
        // `span.name` and `span.status` describe the event's own innermost span, so only that layer offers them as
        // filters; on the Turn layer they would select other events.
        let isOwnSpan = prefix == "span"
        let name = DetailNode(id: "\(prefix)/name", name: "Name", value: span.name.isEmpty ? Formatters.missing : span.name,
                              style: span.name.isEmpty ? .muted : .plain)
        if !span.name.isEmpty, isOwnSpan {
            name.field = "span.name"
            name.filterValue = .string(span.name)
        }
        kids.append(name)
        let status = DetailNode(id: "\(prefix)/status", name: "Status", value: span.status.rawValue,
                                style: span.status == .error ? .error : span.status == .ok ? .plain : .warning)
        if isOwnSpan {
            status.field = "span.status"
            status.filterValue = .string(span.status.rawValue)
        }
        kids.append(status)
        let start = DetailNode(id: "\(prefix)/start", name: "Start", value: Formatters.timestamp(span.start),
                               annotation: span.end.map { "end " + Formatters.timestamp($0) } ?? "no end recorded")
        start.copyValue = Formatters.iso8601(span.start)
        kids.append(start)
        let dur = DetailNode(id: "\(prefix)/dur", name: "Duration", value: Formatters.duration(span.dur, src: span.durSrc),
                             annotation: Formatters.provenance(span.durSrc), style: span.dur == nil ? .muted : .number)
        kids.append(dur)
        let isTool = span.kind == .tool
        if let first = span.firstEvent {
            kids.append(eventLink("\(prefix)/first", isTool ? "Call event" : "First event", first))
        }
        if let last = span.lastEvent, last != span.firstEvent {
            kids.append(eventLink("\(prefix)/last", isTool ? "Result event" : "Last event", last))
        }
        if let child = span.linkSession { kids.append(sessionLink("\(prefix)/child", "Child session", child, title: title)) }
        let id = DetailNode(id: "\(prefix)/id", name: prefix == "turn" ? "Turn ID" : "Span ID", value: span.id)
        id.isMonospaced = true
        id.copyValue = span.id
        id.field = prefix == "turn" ? "turn" : "span"
        id.filterValue = .string(span.id)
        kids.append(id)
        if let attrs = span.attrs, attrs.childCount > 0 {
            let a = DetailNode(id: "\(prefix)/attrs", name: "Attributes", value: summarize(attrs), style: .muted)
            a.setLazyChildren { objectChildren("\(prefix)/attrs", attrs, pointer: nil, rawPointer: nil, finder: nil) }
            kids.append(a)
        }
        return kids
    }

    // MARK: Step and Failure (SPEC §12.7 Events: the derived layers)

    private static func stepLayer(_ step: EventDerived.Step, turnIndex: Int?) -> DetailNode {
        let layer = DetailNode(id: "step", name: "Step \(step.n)",
                               value: (step.inTurn.map { Formatters.stepPosition(step.n, inTurn: ($0.n, $0.of), turn: turnIndex) } ?? "step \(step.n), outside a turn")
                                   + " · " + step.segSrc.words)
        layer.field = "step"
        layer.filterValue = .string(step.id)
        let id = DetailNode(id: "step/id", name: "Step ID", value: step.id)
        id.isMonospaced = true
        id.field = "step"
        id.filterValue = .string(step.id)
        let seg = DetailNode(id: "step/seg", name: "Segmentation", value: step.segSrc.rawValue, annotation: "how calls were joined to this model response")
        seg.isMonospaced = true
        layer.setChildren([id, seg])
        return layer
    }

    private static func provNode(_ id: String, _ name: String, _ value: String, _ prov: Prov?, analysis: AnalysisStatus?) -> DetailNode {
        DetailNode(id: id, name: name, value: DerivedStyle.marked(value, prov), annotation: prov.map { $0.words })
    }

    /// The Analysis row of an event the failure analysis flags nothing on. Its own span (not its turn) can still have
    /// ended in error, which the Span row below it reads in red ("· error"); the row then says where that error is and
    /// never reads "no failure signal" beside it. A tool call's error is on its result event, the event the failure
    /// analysis files a failure on; another event of a failed span reads as not flagged. Short enough to stay whole in
    /// the 1280 pt inspector.
    static func noFailureText(_ span: SpanRow?, event: String) -> String {
        guard let span, span.kind != .turn, span.status == .error else { return "no failure signal on this event" }
        if span.kind == .tool, span.firstEvent == event, let result = span.lastEvent, result != event {
            return "the error is on its result event"
        }
        return "not flagged; its span ended in error"
    }

    /// The Failure layer: one line built by the engine ("benign: rg no match"), then the tier, rule, signature,
    /// target, exit code, and the episode, process, delegation, changes, intervention and claim the event belongs to.
    /// `quiet`: the Analysis row when the failure analysis flags nothing on the event (`noFailureText`).
    private static func failureLayer(_ d: EventDerived, analysis: AnalysisStatus?, quiet: String) -> DetailNode? {
        var kids: [DetailNode] = []
        let layer: DetailNode
        if let f = d.failure {
            // The badge names the tier, so the engine's note loses its "failure: " lead and stays in the text color.
            let lead = f.tier.rawValue + ": "
            layer = DetailNode(id: "failure", name: "Failure", value: f.note.hasPrefix(lead) ? String(f.note.dropFirst(lead.count)) : f.note)
            layer.tier = f.tier
            layer.field = "failure.tier"
            layer.filterValue = .string(f.tier.rawValue)
            func kv(_ key: String, _ name: String, _ value: String, field: String? = nil, filter: String? = nil, mono: Bool = false,
                    annotation: String? = nil) {
                let n = DetailNode(id: "failure/\(key)", name: name, value: value, annotation: annotation)
                n.isMonospaced = mono
                if let field { n.field = field; n.filterValue = .string(filter ?? value) }
                kids.append(n)
            }
            kv("source", "Source", f.source.rawValue, field: "failure.source")
            kv("rule", "Rule", f.rule, mono: true, annotation: analysis?.ruleDescription(f.rule))
            kv("family", "Family", f.family.rawValue, field: "failure.family", annotation: "class \(f.class.rawValue)")
            kv("signature", "Signature", f.signature, field: "signature", filter: f.signatureId, mono: true, annotation: f.signatureId)
            kv("target", "Target", f.targetKey, field: "failure.target", mono: true)
            if let code = f.exitCode {
                kids.append(provNode("failure/exit", "Exit code", "\(code)", f.exitSrc, analysis: analysis))
            }
            if let line = f.errorLine { kv("line", "Error line", line, mono: true) }
            if let a = f.attempt { kv("attempt", "Attempt", "\(a)") }
        } else {
            guard d.episode != nil || d.process != nil || d.delegation != nil || !d.changes.isEmpty || d.intervention != nil || d.claim != nil
            else { return nil }
            layer = DetailNode(id: "failure", name: "Analysis", value: quiet, style: .muted)
        }
        if let e = d.episode {
            // The outcome word carries no mark ("pivoted", never "pivoted≈", §9 Outcomes); its source is in the note.
            let n = DetailNode(id: "failure/episode", name: "Episode", value: DerivedStyle.outcomeWord(e.outcome.rawValue)
                               + " · \(Formatters.count(e.nAttempts, "attempt")) · \(e.role)",
                               annotation: "outcome \(e.outcomeSrc.words) · section \(e.section.rawValue)")
            n.link = .episode(e.id)
            n.copyValue = e.id
            n.field = "episode"
            n.filterValue = .string(e.id)
            kids.append(n)
        }
        if let p = d.process {
            let n = DetailNode(id: "failure/process", name: "Process", value: "\(p.role) · \(p.status)" + (p.exitCode.map { " · " + DerivedStyle.marked("exit \($0)", p.exitSrc) } ?? "")
                               + (p.closeStep.map { " at step \($0)" } ?? ""))
            n.field = "process"
            n.filterValue = .string(p.id)
            n.copyValue = p.id
            if let close = p.closeEventId { n.link = .event(close) }
            kids.append(n)
        }
        if let del = d.delegation {
            let n = DetailNode(id: "failure/delegation", name: "Delegation", value: DerivedStyle.marked(del.outcome.rawValue, del.outcomeSrc)
                               + (del.silent ? " · silent (parent not told)" : ""), style: del.silent ? .error : .plain)
            if let child = del.childSessionId { n.link = .session(child) }
            n.copyValue = del.id
            kids.append(n)
        }
        for (i, c) in d.changes.enumerated() {
            var value = "\(c.op.rawValue) \(c.path)"
            if let a = c.added { value += " +\(a)" }
            if let r = c.removed { value += " −\(r)" }
            let n = DetailNode(id: "failure/change/\(i)", name: "Change", value: value, annotation: c.src.words + (c.outsideCwd ? " · outside the working directory" : ""))
            n.isMonospaced = true
            n.field = "change.path"
            n.filterValue = .string(c.path)
            if c.diffAvailable { n.link = .diff(event: d.eventId, path: c.path) }
            kids.append(n)
        }
        if let iv = d.intervention {
            kids.append(provNode("failure/intervention", "Intervention", "\(iv.kind.rawValue) by \(iv.actor)", iv.actorSrc, analysis: analysis))
        }
        if let c = d.claim {
            let n = DetailNode(id: "failure/claim", name: "Claim", value: "?" + DerivedStyle.outcomeWord(c.evidence.rawValue), annotation: c.rule)
            n.field = "claim.evidence"
            n.filterValue = .string(c.evidence.rawValue)
            kids.append(n)
        }
        layer.setChildren(kids)
        return layer
    }

    private static func eventLink(_ id: String, _ name: String, _ event: String, summary: String? = nil) -> DetailNode {
        let n = DetailNode(id: id, name: name, value: summary ?? event, annotation: summary == nil ? nil : event)
        n.link = .event(event)
        n.copyValue = event
        n.isMonospaced = summary == nil
        return n
    }

    // MARK: Decoded attributes

    private static func decodedLayer(_ d: EventDetail) -> DetailNode? {
        guard let attrs = d.event.attrs.objectValue, !attrs.isEmpty else { return nil }
        let finder = PointerFinder(native: d.event.native, block: d.event.raw.block)
        let name = attrs["tool"]?["name"]?.stringValue ?? attrs["llm"]?["model"]?.stringValue ?? attrs["agent"]?["type"]?.stringValue
            ?? attrs["hook"]?["name"]?.stringValue
        // Kinds without their own layer name show their attributes under a neutral title.
        let label = decodedLabels[d.event.kind.rawValue]
        let title = label.map { l in name.map { "\(l): \($0)" } ?? l } ?? "Attributes"
        let layer = DetailNode(id: "decoded", name: title, value: EventSummary.display(d.event.summary, kind: d.event.kind, durationShown: false))
        layer.pointer = "/attrs"
        let keys = attrs.keys.sorted { rank($0) < rank($1) }
        layer.setChildren(keys.map { attrNode("decoded/\($0)", key: $0, value: attrs[$0]!, path: [$0], finder: finder, parent: attrs) })
        return layer
    }

    private static func rank(_ key: String) -> Int { attrOrder.firstIndex(of: key) ?? 100 }

    private static func attrNode(_ id: String, key: String, value v: JSONValue, path: [String], finder: PointerFinder,
                                 parent: JSONObject?) -> DetailNode {
        let pointer = "/attrs/" + path.map(JSONValue.escapePointerToken).joined(separator: "/")
        if key == "tokens", let t = v.objectValue { return tokensNode(id, t, pointer: pointer, finder: finder) }
        if let obj = v.objectValue, obj["$omitted"] == nil {
            let inputPointer = path == ["tool", "input"] ? finder.object(obj) : nil
            let n = DetailNode(id: id, name: key, value: summarize(v), style: .muted)
            n.pointer = pointer
            n.rawPointer = inputPointer
            n.setLazyChildren {
                obj.map { k, x in
                    if let inputPointer {
                        return valueNode("\(id)/\(k)", name: k, value: x, pointer: pointer + "/" + JSONValue.escapePointerToken(k),
                                         rawPointer: inputPointer + "/" + JSONValue.escapePointerToken(k), parent: obj, finder: nil)
                    }
                    return attrNode("\(id)/\(k)", key: k, value: x, path: path + [k], finder: finder, parent: obj)
                }
            }
            return n
        }
        let n = valueNode(id, name: key, value: v, pointer: pointer, rawPointer: finder.find(v, key: key), parent: parent, finder: nil)
        annotateKnownField(n, key: key, value: v, path: path)
        return n
    }

    /// Units and links for well-known attribute keys.
    private static func annotateKnownField(_ n: DetailNode, key: String, value v: JSONValue, path: [String]) {
        if let ms = v.doubleValue, msFields.contains(key) {
            n.annotation = Formatters.duration(Int64(ms * 1000))
        } else if key == "usd", let usd = v.doubleValue {
            n.annotation = "logged cost " + Formatters.cost(usd)
        } else if key == "resets_at", let us = v.int64Value {
            n.annotation = Formatters.timestamp(us)
        } else if key == "used_percent", let p = v.doubleValue {
            n.annotation = Formatters.percent(p / 100)
        }
        if let s = v.stringValue, key == "persisted_path" || key == "backup" || (key == "path" && path.first == "file") {
            n.link = .file(s)
            if imageExtensions.contains((s as NSString).pathExtension.lowercased()) { n.image = .file(s) }
        }
        if key == "link_session", let s = v.stringValue { n.link = .session(s) }
    }

    private static func tokensNode(_ id: String, _ t: JSONObject, pointer: String, finder: PointerFinder) -> DetailNode {
        let input = t["input"]?.intValue, output = t["output"]?.intValue
        let n = DetailNode(id: id, name: "tokens", value: "\(Formatters.tokens(input)) in · \(Formatters.tokens(output)) out", style: .number)
        n.pointer = pointer
        let order = ["input", "uncached", "cache_read", "cache_write", "output", "reasoning", "total", "context_window"]
        var kids: [DetailNode] = order.compactMap { k in
            guard let v = t[k] else { return nil }
            let c = valueNode("\(id)/\(k)", name: k, value: v, pointer: pointer + "/" + k, rawPointer: finder.find(v, key: k), parent: t,
                              finder: nil)
            if let i = v.intValue { c.value = Formatters.count(i) }
            return c
        }
        for (k, v) in t where !order.contains(k) {
            kids.append(valueNode("\(id)/\(k)", name: k, value: v, pointer: pointer + "/" + JSONValue.escapePointerToken(k), rawPointer: nil,
                                  parent: t, finder: nil))
        }
        if let input, input > 0 {
            let ratio = Double(t["cache_read"]?.intValue ?? 0) / Double(input)
            kids.append(DetailNode(id: "\(id)/hit", name: "cache hit ratio", value: Formatters.percent(ratio), annotation: "cache_read ÷ input",
                                   style: .number))
        }
        n.setChildren(kids)
        return n
    }

    // MARK: Related and native

    private static func relatedLayer(_ related: [EventRow]) -> DetailNode {
        let layer = DetailNode(id: "related", name: "Related Events", value: Formatters.count(related.count, "event"))
        layer.setChildren(related.enumerated().map { i, r in
            eventLink("related/\(i)", r.kind.rawValue, r.id, summary: r.summary.isEmpty ? r.id : EventSummary.display(r.summary, kind: r.kind, durationShown: false))
        })
        return layer
    }

    private static func nativeLayer(_ d: EventDetail) -> DetailNode {
        let native = d.event.native
        let layer = DetailNode(id: "native", name: "Native Record", value: d.event.proto,
                               annotation: native.map { $0.typeName == "object" ? summarize($0) : $0.typeName } ?? "not stored")
        layer.pointer = "/native"
        layer.rawPointer = ""
        layer.isMonospaced = true
        if let native {
            layer.setLazyChildren { objectChildren("native", native, pointer: "/native", rawPointer: "", finder: nil) }
        } else {
            layer.setChildren([])
        }
        return layer
    }

    // MARK: Generic JSON

    static func objectChildren(_ id: String, _ v: JSONValue, pointer: String?, rawPointer: String?, finder: PointerFinder?) -> [DetailNode] {
        switch v {
        case .object(let o):
            return o.map { k, x in
                let tok = JSONValue.escapePointerToken(k)
                return valueNode("\(id)/\(tok)", name: k, value: x, pointer: pointer.map { $0 + "/" + tok },
                                 rawPointer: rawPointer.map { $0 + "/" + tok }, parent: o, finder: finder)
            }
        case .array(let a):
            return a.enumerated().map { i, x in
                valueNode("\(id)/\(i)", name: "[\(i)]", value: x, pointer: pointer.map { "\($0)/\(i)" }, rawPointer: rawPointer.map { "\($0)/\(i)" },
                          parent: nil, finder: finder)
            }
        default:
            return [valueNode("\(id)/value", name: "value", value: v, pointer: pointer, rawPointer: rawPointer, parent: nil, finder: finder)]
        }
    }

    static func valueNode(_ id: String, name: String, value v: JSONValue, pointer: String?, rawPointer: String?, parent: JSONObject?,
                          finder: PointerFinder?) -> DetailNode {
        let n: DetailNode
        switch v {
        case .object(let o) where o["$omitted"] != nil:
            return omittedNode(id, name: name, o, rawPointer: rawPointer, parent: parent, pointer: pointer)
        case .object, .array:
            n = DetailNode(id: id, name: name, value: summarize(v), style: .muted)
            if v.childCount > 0 {
                n.setLazyChildren { objectChildren(id, v, pointer: pointer, rawPointer: rawPointer, finder: finder) }
            }
        case .string(let s):
            let firstLine = s.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
            let isLong = s.count > longString || s.contains("\n")
            if isLong {
                n = DetailNode(id: id, name: name, value: String(firstLine.prefix(longString)) + " …",
                               annotation: "\(Formatters.count(s.count)) chars · \(Formatters.count(lineCount(s), "line"))", style: .string)
                n.fullText = s
            } else {
                n = DetailNode(id: id, name: name, value: JSONValue.string(s).compactText, style: .string)
            }
            n.copyValue = s
        case .number(let d):
            n = DetailNode(id: id, name: name, value: JSONValue.format(d), style: .number)
            n.copyValue = n.value
        case .bool(let b):
            n = DetailNode(id: id, name: name, value: b ? "true" : "false", style: .literal)
            n.copyValue = n.value
        case .null:
            n = DetailNode(id: id, name: name, value: "null", style: .muted)
        }
        n.pointer = pointer
        n.rawPointer = rawPointer
        return n
    }

    private static func omittedNode(_ id: String, name: String, _ o: JSONObject, rawPointer: String?, parent: JSONObject?,
                                     pointer: String?) -> DetailNode {
        let kind = o["$omitted"]?.stringValue ?? "content"
        let bytes = o["bytes"]?.intValue
        let mediaType = o["mediaType"]?.stringValue ?? parent?["media_type"]?.stringValue ?? parent?["mediaType"]?.stringValue
            ?? parent?["mime_type"]?.stringValue
        var parts = [kind]
        if let bytes { parts.append(Formatters.bytes(Int64(bytes))) }
        if let more = o["count"]?.intValue { parts.append("\(Formatters.count(more)) more items") }
        if let mediaType { parts.append(mediaType) }
        let n = DetailNode(id: id, name: name, value: "‹" + parts.joined(separator: " · ") + "›", annotation: "omitted from the index",
                           style: .muted)
        n.pointer = pointer
        n.rawPointer = rawPointer
        if let mediaType, mediaType.hasPrefix("image/"), let rawPointer {
            n.image = .embedded(rawPointer: rawPointer, mediaType: mediaType, bytes: bytes ?? 0)
        }
        return n
    }

    /// `{type: "tool_use", name: "Bash", …}` or `{3 fields}` / `[12 items]`.
    static func summarize(_ v: JSONValue) -> String {
        switch v {
        case .array(let a): return a.isEmpty ? "[]" : "[\(Formatters.count(a.count, "item"))]"
        case .object(let o):
            var bits: [String] = []
            for k in ["type", "name", "role", "subtype", "id"] {
                if let s = o[k]?.stringValue {
                    bits.append("\(k): " + JSONValue.string(s.count > 40 ? String(s.prefix(40)) + "…" : s).compactText)
                }
            }
            if bits.isEmpty { return o.isEmpty ? "{}" : "{\(Formatters.count(o.count, "field"))}" }
            return "{" + bits.joined(separator: ", ") + (o.count > bits.count ? ", …" : "") + "}"
        default: return v.displayText
        }
    }

    static func lineCount(_ s: String) -> Int { s.reduce(1) { $1 == "\n" ? $0 + 1 : $0 } }
}

/// Maps normalized attribute values to pointers in the native record, so decoded fields highlight their
/// source bytes (a heuristic: the engine does not record where each attribute came from). It searches the
/// event's own content block first.
final class PointerFinder {
    private let native: JSONValue?
    private let preferredPrefix: String?
    private var leaves: [(pointer: String, value: JSONValue)]?

    init(native: JSONValue?, block: Int?) {
        self.native = native
        if let block, native?.pointer("/message/content/\(block)") != nil {
            preferredPrefix = "/message/content/\(block)"
        } else {
            preferredPrefix = nil
        }
    }

    private func collect() -> [(pointer: String, value: JSONValue)] {
        if let leaves { return leaves }
        var out: [(String, JSONValue)] = []
        var budget = 20_000
        func walk(_ v: JSONValue, _ p: String) {
            guard budget > 0 else { return }
            budget -= 1
            switch v {
            case .object(let o):
                if o["$omitted"] != nil { return }
                out.append((p, v))
                for (k, x) in o { walk(x, p + "/" + JSONValue.escapePointerToken(k)) }
            case .array(let a):
                out.append((p, v))
                for (i, x) in a.enumerated() { walk(x, "\(p)/\(i)") }
            default:
                out.append((p, v))
            }
        }
        if let native { walk(native, "") }
        if let prefix = preferredPrefix {
            out = out.filter { $0.0.hasPrefix(prefix) } + out.filter { !$0.0.hasPrefix(prefix) }
        }
        leaves = out
        return out
    }

    private static func stripMarker(_ s: String) -> String {
        guard s.hasSuffix("]"), let r = s.range(of: #"…\[\+\d+( chars)?\]$"#, options: .regularExpression) else { return s }
        return String(s[..<r.lowerBound])
    }

    private static func normalize(_ key: String) -> String {
        key.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
    }

    /// The raw pointer of a scalar value, matched by text (strings) or by key and value (numbers, booleans).
    func find(_ value: JSONValue, key: String) -> String? {
        guard native != nil else { return nil }
        switch value {
        case .string(let s):
            guard s.count >= 3 else { return nil }
            let a = String(Self.stripMarker(s).prefix(200))
            return collect().first { leaf in
                guard let l = leaf.value.stringValue else { return false }
                let b = Self.stripMarker(l)
                return b.hasPrefix(a) || (a.hasPrefix(b) && b.count >= 24)
            }?.pointer
        case .number, .bool:
            let k = Self.normalize(key)
            return collect().first { leaf in
                leaf.value == value && Self.normalize(JSONValue.unescapePointerToken(String(leaf.pointer.split(separator: "/").last ?? ""))) == k
            }?.pointer
        default:
            return nil
        }
    }

    /// The raw pointer of an object that has all of `obj`'s keys (a tool's input).
    func object(_ obj: JSONObject) -> String? {
        guard native != nil, !obj.isEmpty else { return nil }
        return collect().first { leaf in
            guard let o = leaf.value.objectValue else { return false }
            return obj.keys.allSatisfy { o[$0] != nil }
        }?.pointer
    }
}
