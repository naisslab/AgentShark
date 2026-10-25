import AppKit
import SwiftUI

/// Follow (⌥⌘F, SPEC §12.7): one stream in order, docked under the workspace. Tool Call: input, head and tail,
/// persisted output, exit code. Delegation: task, child steps with failure bands, the child's final message, what the
/// parent saw, the parent's next step. Process: command, polls with keystrokes, the reassembled output, the exit code;
/// earlier "still running" results are marked deferred. File: reads, edits, patches, external edits and backups with
/// diffs, grey shell mentions, edits made between failed attempts, and the note that shell edits are not tracked.
/// When raw bytes are gone, the stream says why and offers Export Capture. Escape closes it.
///
/// Follow never adds a pane (DESIGN.md §7.9): it takes over the Lens column in Failures, the Raw pane (or the whole lower
/// region) in Events, and the inspector region in Session · Steps; "‹ Back" or Escape returns. Workspaces without such
/// a region show it docked under the workspace.
struct FollowPanel: View {
    @Bindable var model: WindowModel
    /// It took over a region of the workspace: "‹ Back" returns.
    var inRegion = false
    @State private var page: FollowPage?
    @State private var error: APIError?
    @State private var loadingMore = false
    /// A Tool Call's span: its duration and provenance for the first line (§7.9 Tool Call).
    @State private var callSpan: SpanRow?
    /// Each tab's subject, read from its own target (the tool, the child's title), so no tab is a bare kind (§7.9).
    @State private var subjects: [FollowTarget: String] = [:]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ZStack {
                if let page {
                    list(page)
                } else if let error {
                    if error.isNotServed {
                        ContentUnavailableView(Self.unavailableTitle(model.followTarget), systemImage: "point.topleft.down.to.point.bottomright.curvepath",
                                               description: Text("This engine does not serve this stream yet. Select the events to read them in Events."))
                    } else {
                        FailedStateView(title: "Could not load the stream", error: error) { Task { await load() } }
                    }
                } else {
                    LoadingStateView(title: "Reading the stream…")
                }
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity)
        .background(Color(nsColor: .controlBackgroundColor))
        .task(id: model.followTarget) { await load() }
        .task(id: tabs) { await loadSubjects() }
        .onExitCommand { model.followTarget = nil }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(model.followTarget?.title ?? "Follow")
    }

    static func unavailableTitle(_ t: FollowTarget?) -> String {
        switch t {
        case .process?: return "Follow Process Is Not Available"
        case .file?: return "Follow File Is Not Available"
        case .delegation?: return "Follow Delegation Is Not Available"
        default: return "Follow Is Not Available"
        }
    }

    /// The header (§7.9): "Follow", one tab per stream labeled "Kind · subject" (the subject cut at 200 pt), then the
    /// zone of the times and the close button, which never leave the header.
    private var header: some View {
        HStack(spacing: 10) {
            if inRegion {
                Button("‹ Back") { model.followTarget = nil }
                    .buttonStyle(.borderless)
                    .fixedSize()
                    .help("Return to what this region showed (Escape)")
            }
            Text("Follow").font(Theme.fontSwiftUI(.paneTitle)).fixedSize()
            HStack(spacing: 12) {
                ForEach(tabs, id: \.self) { t in tab(t) }
            }
            .layoutPriority(-1)
            Spacer(minLength: 0)
            if let page, page.items.contains(where: { $0.role == "marker" && ($0.reason ?? "").localizedCaseInsensitiveContains("raw") }), !model.isCapture {
                Button("Export Capture…") { model.presentedSheet = .exportCapture }.fixedSize()
            }
            Text(model.timeReference == nil ? "Times " + Formatters.offsetLabel() : "Times from the reference")
                .font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary).lineLimit(1).fixedSize()
            Button {
                model.followTarget = nil
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .fixedSize()
            .iconHelp("Close Follow (Escape)")
        }
        .controlSize(model.app.preferences.metrics.swiftUIControlSize)
        .padding(.horizontal, 12)
        .frame(height: model.app.preferences.metrics.paneHeader)
        .frame(minWidth: 0, maxWidth: .infinity)
        .background(.bar)
    }

    private func tab(_ t: FollowTarget) -> some View {
        let current = t == model.followTarget
        let subject = tabSubject(t)
        return Button { model.followTarget = t } label: {
            HStack(spacing: 0) {
                Text(Self.kindWord(t)).font(.system(size: 12, weight: .semibold)).foregroundStyle(current ? Color.primary : Color.secondary)
                    .fixedSize()
                if let subject {
                    Text(" · " + subject).font(.system(size: 12)).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: 200, alignment: .leading)
                }
            }
            .padding(.vertical, 4)
            .overlay(alignment: .bottom) { Rectangle().fill(current ? Color.accentColor : .clear).frame(height: 2).offset(y: 3) }
        }
        .buttonStyle(.plain)
        .help(subject.map { Self.kindWord(t) + " · " + $0 } ?? Self.kindWord(t))
        .accessibilityAddTraits(current ? .isSelected : [])
    }

    /// The followed stream first, then the other streams of the selected event. Those are offered only when Follow
    /// opened on one of them: a stream opened from a Timeline bar or the Lens is not the selected event's, and the
    /// selected event's streams would be a sibling's. Two tabs never read the same.
    private var tabs: [FollowTarget] {
        guard let t = model.followTarget else { return [] }
        let alternatives = model.followAlternatives
        guard alternatives.contains(t) else { return [t] }
        var seen: Set<String> = []
        return ([t] + alternatives.filter { $0 != t }).filter { seen.insert(Self.kindWord($0) + "|" + (tabSubject($0) ?? "\($0)")).inserted }
    }

    static func kindWord(_ t: FollowTarget) -> String {
        switch t {
        case .call: return "Tool Call"
        case .delegation: return "Delegation"
        case .process: return "Process"
        case .file: return "File"
        }
    }

    /// The subject of a tab: the tool, the program, the file name or the child's title.
    private func tabSubject(_ t: FollowTarget) -> String? {
        if let s = subjects[t] { return s }
        let s = t == model.followTarget ? page?.subject : nil
        switch t {
        case .call: return s?.tool
        case .process(let id):
            if let p = s?.program { return p }
            let n = id.range(of: "#proc:").map { id[$0.upperBound...].split(separator: ":").first.map(String.init) ?? "" } ?? ""
            return n.isEmpty ? nil : n
        case .file(_, let path): return (path as NSString).lastPathComponent
        case .delegation: return s?.childSessionId.map { model.store.title(of: $0) }
        }
    }

    /// Reads each tab's subject from its own target: a call's tool from its event, a delegation's child from its span.
    private func loadSubjects() async {
        guard let api = model.engine.api else { return }
        for t in tabs where subjects[t] == nil {
            switch t {
            case .call(let id):
                if let tool = try? await api.event(id).event.toolName { subjects[t] = tool }
            case .delegation(let id):
                if let span = try? await api.span(id).span {
                    subjects[t] = span.linkSession.map { model.store.title(of: $0) } ?? span.name
                }
            default: break
            }
        }
    }

    private func list(_ page: FollowPage) -> some View {
        let body = FollowBody(model: model, page: page, callSpan: callSpan)
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                body.content
                if page.next != nil {
                    Button(loadingMore ? "Loading…" : "Load More") { Task { await loadMore() } }
                        .disabled(loadingMore)
                }
                if !page.gaps.isEmpty { GapList(gaps: page.gaps).font(Theme.fontSwiftUI(.rowSecondary)) }
            }
            .font(Theme.fontSwiftUI(.rowPrimary, model.app.preferences.rowDensity))
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollShadows()
    }

    private func load() async {
        guard let t = model.followTarget, let api = model.engine.api else { return }
        page = nil
        error = nil
        callSpan = nil
        do {
            let p = try await api.follow(t)
            if case .call(let id) = t {
                // The call's duration is its span's, with the span's provenance (§7.9 Tool Call).
                let callID = p.items.first { $0.role == "call" }?.eventId ?? id
                if let span = try? await api.event(callID).event.span { callSpan = try? await api.span(span).span }
            }
            page = p
        } catch {
            self.error = error as? APIError ?? .unreachable(error)
        }
    }

    private func loadMore() async {
        guard let t = model.followTarget, let api = model.engine.api, let cur = page, let after = cur.next else { return }
        loadingMore = true
        defer { loadingMore = false }
        if let more = try? await api.follow(t, after: after) {
            var p = cur
            p.items += more.items
            p.next = more.next
            page = p
        }
    }
}

/// The Follow body (§7.9 Body and Kinds): numbered stages for a delegation, and labeled stages for a call, a process
/// and a file, with code blocks shown (head and tail), never behind a disclosure.
@MainActor struct FollowBody {
    let model: WindowModel
    let page: FollowPage
    let callSpan: SpanRow?
    /// Items in time order (an item without a time keeps its place).
    private let items: [FollowItem]
    private let firstTs: Int64?

    init(model: WindowModel, page: FollowPage, callSpan: SpanRow?) {
        self.model = model
        self.page = page
        self.callSpan = callSpan
        items = page.items.enumerated().sorted { a, b in
            guard let x = a.element.ts, let y = b.element.ts, x != y else { return a.offset < b.offset }
            return x < y
        }.map(\.element)
        firstTs = page.items.compactMap(\.ts).min()
    }

    @ViewBuilder var content: some View {
        switch page.kind {
        case "delegation": delegation
        case "process": process
        case "file": file
        default: call
        }
    }

    // MARK: Pieces

    private func stage<C: View>(_ n: Int?, _ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: n.map { "\($0) · \(title)" } ?? title)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A tier in Follow (§6.2): Plain "✕ failure" in red, Outline for the other tiers; Solid stays in the Lens and Detail.
    @ViewBuilder private func tierMark(_ t: FailureTier) -> some View {
        if t == .failure { PlainMark(mark: .failed, text: t.rawValue, color: Theme.err) } else { TierBadge(tier: t) }
    }

    private func note(_ text: String) -> some View {
        Text(text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    /// Time and "Event ›" above a block.
    private func meta(_ it: FollowItem) -> some View {
        HStack(spacing: 8) {
            time(it.ts)
            Spacer(minLength: 0)
            if let e = it.eventId { EventLink(model: model, eventID: e, label: "Event ›") }
        }
        .font(Theme.fontSwiftUI(.rowSecondary))
    }

    private func time(_ ts: Int64?) -> some View {
        Text(ts.map(timeText) ?? Formatters.missing)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .help(ts.map { Formatters.timestamp($0) } ?? "No time logged")
    }

    /// Clock time, or "Oct 13 07:33:38" when its date is not the panel's first (§7.9 Dates); from the reference when set.
    private func timeText(_ ts: Int64) -> String {
        if let ref = model.timeReference { return Formatters.reference(ts - ref) }
        if let first = firstTs, !Formatters.sameDay(ts, first) { return Formatters.datedClock(ts) }
        return Formatters.clock(ts, zone: Formatters.timeZone)
    }

    /// Head and tail of an item's text as code, with the index's cut between them.
    @ViewBuilder private func headTail(_ it: FollowItem) -> some View {
        if let h = it.head { CodeBlock(text: h, headLines: 6, tailLines: 4) }
        if let t = it.tail {
            Text("⋯ the index keeps the head and the tail ⋯").font(Theme.fontSwiftUI(.rowSecondary)).foregroundStyle(.tertiary)
            CodeBlock(text: t, headLines: 0, tailLines: 6)
        }
    }

    private func exitText(_ code: Int?, _ src: Prov?) -> Text {
        guard let code else { return Text("exit —").foregroundStyle(.tertiary) }
        return Text(DerivedStyle.marked("exit \(code)", src)).foregroundStyle(code == 0 ? Color.primary : Theme.err.swiftUI)
    }

    /// The first line of a kind ("Bash · 160ms≈ · exit 1~"), Row primary.
    private func firstLine(_ parts: [Text]) -> some View {
        parts.dropFirst().reduce(parts.first ?? Text("")) { $0 + Text(" · ").foregroundStyle(.secondary) + $1 }
            .monospacedDigit()
            .lineLimit(2)
            .textSelection(.enabled)
    }

    // MARK: Kinds

    private var call: some View {
        let s = page.subject
        let call = items.first { $0.role == "call" }
        let results = items.filter { $0.role == "result" }
        let persisted = items.filter { $0.role == "persisted" }
        let execs = items.filter { $0.role == "exec" }
        let cuts = items.filter { $0.role == "marker" && !($0.reason ?? "").localizedCaseInsensitiveContains("raw") }
        let last = results.last
        let dur: Text = callSpan?.dur.map { Text(Formatters.duration($0) + Formatters.provenanceGlyph(callSpan?.durSrc)) }
            ?? Text("duration —").foregroundStyle(.tertiary)
        return VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                firstLine([Text(s.tool ?? "Tool call"), dur, exitText(last?.exitCode ?? s.exitCode, last?.exitSrc ?? s.exitSrc)])
                    .help(callSpan.map { Formatters.provenance($0.durSrc) } ?? "The call has no measured span")
                if let t = s.tier { tierMark(t) }
            }
            stage(nil, "Input") {
                if let call {
                    meta(call)
                    CodeBlock(text: call.head ?? call.excerpt ?? "", headLines: 6, tailLines: 4, noun: "input")
                } else {
                    note("The call event is not in the index.")
                }
            }
            stage(nil, "Output") {
                if results.isEmpty { note("No result yet: the call has not returned, or its result was not logged.") }
                ForEach(Array(results.enumerated()), id: \.offset) { _, r in
                    meta(r)
                    if r.head == nil && r.tail == nil { note("No output was logged for this result.") } else { headTail(r) }
                    if let reason = r.reason { note(reason) }
                }
            }
            if !persisted.isEmpty { stage(nil, "Persisted output") { rows(persisted) } }
            if !execs.isEmpty { stage(nil, "Commands the script ran (\(Formatters.count(execs.count)))") { rows(execs) } }
            if !cuts.isEmpty { stage(nil, "Cuts") { rows(cuts) } }
        }
    }

    private var delegation: some View {
        let by = { (role: String) in items.filter { $0.role == role } }
        let child = items.filter { $0.role == "child-step" || $0.role == "child-failure" }
        let failed = child.filter(isFailing).count
        let steps = child.count - failed
        let s = page.subject
        return VStack(alignment: .leading, spacing: 16) {
            stage(1, "Task") {
                if let task = by("task").first {
                    meta(task)
                    ProseBlock(text: task.excerpt ?? task.head ?? "", lines: 4)
                } else {
                    note("The task was not logged.")
                }
            }
            stage(2, "Child steps (" + ([Formatters.count(steps) + (page.next != nil ? " so far" : ""), failed > 0 ? Formatters.count(failed, "failed call") : nil]
                .compactMap { $0 }.joined(separator: " · ")) + ")") {
                if child.isEmpty { note(s.childSessionId != nil ? "The child logged no calls." : "The child session is not indexed.") }
                ForEach(Array(bands(child).enumerated()), id: \.offset) { _, band in
                    if band.failing {
                        HStack(spacing: 8) {
                            Text("Failure band").font(.system(size: 11, weight: .semibold)).textCase(.uppercase).foregroundStyle(Theme.err.swiftUI)
                            if let ep = band.items.first?.episodeId {
                                Button("Episode ›") { model.openEpisode(ep, reveal: true) }.buttonStyle(.link)
                            }
                        }
                        .padding(.top, 2)
                    }
                    rows(band.items, word: "step")
                }
                if let c = s.childSessionId {
                    Button("Open the Child in Session ›") { model.openSession(c, mode: .steps) }.buttonStyle(.link)
                }
            }
            stage(3, "Final message") {
                let finals = by("child-final")
                if finals.isEmpty { note("The child returned no final message.") }
                ForEach(Array(finals.enumerated()), id: \.offset) { _, f in
                    meta(f)
                    ProseBlock(text: f.head ?? f.excerpt ?? "", lines: 6)
                }
            }
            stage(4, "Result the parent saw") {
                if let saw = by("parent-saw").first {
                    HStack(spacing: 8) {
                        time(saw.ts)
                        if let t = saw.tier { tierMark(t) }
                        if let told = s.parentTold {
                            Text(DerivedStyle.marked("parent told: " + (told ? "yes" : "no"), Prov(rawValue: "inferred:parent-told")))
                                .foregroundStyle(told ? Color.primary : Theme.err.swiftUI)
                        }
                        Spacer(minLength: 0)
                        if let e = saw.eventId { EventLink(model: model, eventID: e, label: "Event ›") }
                    }
                    .font(Theme.fontSwiftUI(.rowSecondary))
                    ProseBlock(text: saw.head ?? saw.excerpt ?? "", lines: 6)
                    if let reason = saw.reason { note(reason) }
                } else {
                    note("The parent saw no result from this child.")
                }
            }
            stage(5, "Parent’s next step") {
                let next = by("parent-next")
                if next.isEmpty { note("The parent made no further call in that turn.") } else { rows(next, word: "next") }
            }
        }
    }

    private var process: some View {
        let s = page.subject
        let open = items.first { $0.role == "open" }
        let stream = items.filter { $0.role != "open" }
        let n = { (role: String) in stream.filter { $0.role == role }.count }
        let ended = stream.first { ["close", "kill", "error"].contains($0.role) }
        let state = s.status == "running" ? "Running" : ended?.role == "kill" ? "Killed" : ended?.role == "error" ? "Ended on an error" : "Exited"
        let output = ReassembledOutput.text(page.items)
        return VStack(alignment: .leading, spacing: 16) {
            stage(nil, "Command") {
                if let open {
                    meta(open)
                    CodeBlock(text: open.head ?? open.excerpt ?? "", headLines: 6, tailLines: 2, noun: "command")
                } else if let p = s.program {
                    CodeBlock(text: p)
                }
                // "Exited · exit 0~ · 0 polls · 0 inputs" (§7.9 Process).
                firstLine([Text(state), exitText(s.exitCode, s.exitSrc), Text(Formatters.count(n("poll"), "poll")), Text(Formatters.count(n("input"), "input"))]
                    + (n("deferred") > 0 ? [Text(Formatters.count(n("deferred"), "deferred result"))] : []))
            }
            stage(nil, "Lifecycle") { rows(stream, wordWidth: 64) }
            stage(nil, "Reassembled output") {
                if output.isEmpty { note("The process printed nothing the index kept.") } else { CodeBlock(text: output, headLines: 12, tailLines: 6) }
            }
        }
    }

    private var file: some View {
        let s = page.subject
        let notes = items.filter { $0.role == "marker" }.compactMap(\.reason)
        let list = items.filter { $0.role != "marker" }
        return VStack(alignment: .leading, spacing: 12) {
            firstLine([Text(Formatters.count(s.reads ?? 0, "read")), Text(Formatters.count(s.edits ?? 0, "edit")),
                       Text(Formatters.count(s.shellMentions ?? 0, "shell mention"))])
            if list.isEmpty { note("No read, edit or mention of this path in the session.") } else { rows(list) }
            ForEach(notes.isEmpty ? ["Shell edits are not tracked."] : notes, id: \.self) { note($0) }
        }
    }

    // MARK: Rows

    private func isFailing(_ it: FollowItem) -> Bool { it.role == "child-failure" || it.tier == .failure || it.tier == .suspect }

    /// Consecutive failing child rows of one episode share a band.
    private func bands(_ child: [FollowItem]) -> [(failing: Bool, items: [FollowItem])] {
        var out: [(failing: Bool, items: [FollowItem])] = []
        for it in child {
            let bad = isFailing(it)
            if let last = out.last, last.failing == bad, !bad || last.items.last?.episodeId == it.episodeId {
                out[out.count - 1].items.append(it)
            } else {
                out.append((bad, [it]))
            }
        }
        return out
    }

    private func rows(_ list: [FollowItem], word: String? = nil, wordWidth: CGFloat = 76) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(list.enumerated()), id: \.offset) { _, it in
                FollowRow(model: model, item: it, word: word, wordWidth: wordWidth, time: it.ts.map(timeText), failing: isFailing(it))
            }
        }
    }
}

/// A list row (§7.9 Process): word, time (120), description (flex, tail ellipsis; machine text in the code font, words in
/// the UI font; "—" with a reason when none was logged), extras, and "Event ›" on the right of the same line.
private struct FollowRow: View {
    let model: WindowModel
    let item: FollowItem
    var word: String?
    var wordWidth: CGFloat = 76
    var time: String?
    var failing = false

    /// Roles whose text is a command, keystrokes or output.
    private static let machine: Set<String> = ["exec", "input", "open", "output", "persisted", "poll", "deferred", "close", "error", "read",
                                               "edit", "patch", "write", "external", "backup", "shell-mention"]

    var body: some View {
        HStack(spacing: 8) {
            Text(word ?? roleWord)
                .font(Theme.fontSwiftUI(.rowSecondary).weight(.semibold))
                .foregroundStyle(roleColor)
                .frame(width: wordWidth, alignment: .leading)
            Text(time ?? Formatters.missing)
                .font(Theme.fontSwiftUI(.rowSecondary))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 120, alignment: .leading)
                .help(item.ts.map { Formatters.timestamp($0) } ?? "No time logged")
            description
            if failing { PlainMark(mark: .failed, text: "failure", color: Theme.err) }
            if let a = item.added { Text("+\(a)").foregroundStyle(Theme.ok.swiftUI).monospacedDigit() }
            if let r = item.removed { Text("−\(r)").foregroundStyle(Theme.err.swiftUI).monospacedDigit() }
            if let c = item.exitCode {
                Text(DerivedStyle.marked("exit \(c)", item.exitSrc)).monospacedDigit().foregroundStyle(c == 0 ? Color.secondary : Theme.err.swiftUI)
                    .help(DerivedStyle.provHelp(item.exitSrc, analysis: model.info?.analysis))
            }
            if item.betweenAttempts == true {
                Text("between attempts").foregroundStyle(Theme.warn.swiftUI).help("This edit falls between two failed attempts of an episode.")
            }
            if item.diffAvailable, let e = item.eventId {
                Button("Diff ›") {
                    model.diffRequest = DiffRequest(eventId: e, path: item.path, title: (item.path ?? e) as String, session: item.sessionId)
                }
                .buttonStyle(.link)
            }
            if let e = item.eventId { EventLink(model: model, eventID: e, label: "Event ›") }
        }
        .font(Theme.fontSwiftUI(.rowSecondary))
        .lineLimit(1)
        .frame(minHeight: 22)
        .opacity(item.role == "shell-mention" ? 0.7 : 1)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var description: some View {
        let text = item.excerpt ?? item.head?.split(separator: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init)
        let full = [text, item.reason].compactMap { $0 }.joined(separator: " · ")
        Text(full.isEmpty ? Formatters.missing : full)
            .font(Self.machine.contains(item.role) && text != nil ? Theme.fontSwiftUI(.code) : Theme.fontSwiftUI(.rowPrimary))
            .foregroundStyle(full.isEmpty ? Color(nsColor: .tertiaryLabelColor) : isQuiet ? .secondary : .primary)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(full.isEmpty ? "Nothing was logged for this item" : full)
    }

    private var isQuiet: Bool { ["shell-mention", "marker", "deferred", "poll"].contains(item.role) }

    private var roleWord: String {
        switch item.role {
        case "child-step", "child-failure": return "step"
        case "child-final": return "final"
        case "parent-saw": return "parent saw"
        case "parent-next": return "next"
        default: return item.role.replacingOccurrences(of: "-", with: " ")
        }
    }

    private var roleColor: Color {
        switch item.role {
        case "child-failure", "error", "kill": return Theme.err.swiftUI
        case "deferred", "marker", "shell-mention", "poll": return .secondary
        default: return .primary
        }
    }
}

/// A process's output chunks joined in order, with a marker where the index cut text.
struct ReassembledOutput: View {
    let items: [FollowItem]

    static func text(_ items: [FollowItem]) -> String {
        items.compactMap { item -> String? in
            let body = [item.head, item.tail].compactMap { $0 }.joined(separator: "\n…\n")
            switch item.role {
            case "output", "close", "error":
                return body.isEmpty ? item.excerpt : body
            case "deferred":
                // A "still running" result carries the output printed so far.
                return body.isEmpty ? nil : body
            case "marker":
                return "[\(item.reason ?? "the index cut text here")]"
            default:
                return nil
            }
        }
        .joined(separator: "\n")
    }

    var body: some View {
        let text = Self.text(items)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Reassembled output").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                PanelKit.CopyButton(text: text, help: "Copy the reassembled output", iconOnly: true).buttonStyle(.borderless)
            }
            Text(text.isEmpty ? "No output was logged." : text)
                .font(Theme.fontSwiftUI(.code))
                .foregroundStyle(text.isEmpty ? .secondary : .primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }
}
