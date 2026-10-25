import AppKit
import SwiftUI

/// The Lens frame: the episode, claim or delegation Lens, a signature, or a run report, by what the queue selected.
struct LensHost: View {
    @Bindable var model: WindowModel

    var body: some View {
        Group {
            switch model.failures.panel {
            case _ where model.followTarget != nil:
                // Follow takes over the Lens column (§7.9).
                FollowPanel(model: model, inRegion: true)
            case .lens where model.lensItem != nil:
                LensView(model: model, lens: model.failures.lens)
            case .signature(let id):
                SignatureView(model: model, signatureID: id)
            case .run(let session):
                RunPanel(model: model, sessionID: session)
            default:
                ContentUnavailableView("Nothing selected", systemImage: "rectangle.and.text.magnifyingglass",
                                       description: Text("Select an item in the queue to see its observed chain: where it happened, each attempt, how it closed, and whether it was seen before."))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}

/// "Observed chain" (SPEC §12.7, DESIGN.md §7.7): one frame for Episode, Claim, Delegation and Signature. Every row links
/// to its event and carries a provenance mark; associations name their rule. The Lens shows evidence in order and never
/// states a cause.
struct LensView: View {
    @Bindable var model: WindowModel
    let lens: LensModel

    var body: some View {
        ZStack {
            switch lens.content {
            case .episode(let p)?: EpisodeLensView(model: model, lens: lens, p: p)
            case .claim(let c)?: ClaimLensView(model: model, c: c)
            case .delegation(let d)?: DelegationLensView(model: model, d: d)
            case nil: EmptyView()
            }
            switch lens.phase {
            case .loading where lens.content == nil:
                LoadingStateView(title: "Reading the observed chain…")
            case .failed(let e):
                FailedStateView(title: e.isNotServed ? "Not available in this engine" : e.status == 404 ? "Item not found" : "Could not load the Lens",
                                message: e.status == 404 ? "It is no longer in the index; it may have been re-derived." : "Your selection is preserved.",
                                error: e) { lens.show(model.lensItem, api: model.engine.api, force: true) }
            default:
                EmptyView()
            }
        }
        .task(id: "\(model.lensItem?.kind.rawValue ?? "")|\(model.lensItem?.id ?? "")|\(model.engine.api?.endpoint.baseURL.absoluteString ?? "")") {
            lens.show(model.lensItem, api: model.engine.api)
        }
        .onChange(of: lens.content) { _, content in
            // The detail and raw panes start on the newest attempt, the closing message or the result the parent saw.
            guard let content else { return }
            let candidates: [String]
            switch content {
            case .episode(let p): candidates = p.attempts.map(\.eventId) + p.attempts.compactMap(\.callEventId)
            case .claim(let c): candidates = [c.claim.finalEventId]
            case .delegation(let d): candidates = [d.delegation.resultEventId, d.parentSaw?.eventId].compactMap { $0 }
            }
            guard let first = content.subjectEventID, !(model.selectedEvent.map(candidates.contains) ?? false) else { return }
            model.select(event: first, reveal: false)
        }
        .onChange(of: model.derived.generation) {
            // A live run: open outcomes and counts can still change.
            if lens.episode?.where.live == true || lens.episode?.episode.outcome == .open { lens.show(model.lensItem, api: model.engine.api, force: true) }
        }
    }
}

// MARK: - Frame

/// An action of the Lens pane header: enabled with its action, or disabled with the reason in its tooltip.
struct LensAction {
    let title: String
    let help: String
    var run: (() -> Void)?
}

/// The Lens pane (§7.7): a sticky 32 pt header with the pane title, the kind, and four actions (one primary, then Show in
/// Events, Follow and Copy Report; below a Lens width of 640 the secondary ones fold into "⋯"), over the scrolling
/// document.
struct LensPane<Content: View>: View {
    let model: WindowModel
    let kind: String
    let primary: LensAction
    let secondary: [LensAction]
    @ViewBuilder let content: Content
    @FocusState private var focused: Bool

    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) { content }
                    .font(Theme.fontSwiftUI(.rowPrimary, model.app.preferences.rowDensity))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: 880, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollShadows()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Observed chain, \(kind)")
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Observed chain").font(Theme.fontSwiftUI(.paneTitle)).fixedSize()
            Text(kind).font(Theme.fontSwiftUI(.paneTitle).weight(.regular)).foregroundStyle(.secondary).fixedSize()
            Spacer(minLength: 8)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    button(primary, prominent: true)
                    ForEach(secondary, id: \.title) { button($0, prominent: false) }
                }
                HStack(spacing: 8) {
                    button(primary, prominent: true)
                    Menu {
                        ForEach(secondary, id: \.title) { a in
                            Button(a.title) { a.run?() }.disabled(a.run == nil)
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .iconHelp("More Actions")
                }
            }
        }
        .controlSize(metrics.swiftUIControlSize)
        .padding(.horizontal, 12)
        .frame(height: metrics.paneHeader)
        .background(.bar)
    }

    @ViewBuilder private func button(_ a: LensAction, prominent: Bool) -> some View {
        let b = Button(a.title) { a.run?() }.disabled(a.run == nil).help(a.help).fixedSize()
        if prominent { b.buttonStyle(.borderedProminent) } else { b }
    }
}

/// A titled section of the Lens document: a hairline above an uppercase label, 6 pt to its content.
struct LensSection<Content: View, Trailing: View>: View {
    let title: String
    @ViewBuilder let trailing: Trailing
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack {
                SectionLabel(text: title)
                Spacer()
                trailing.font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension LensSection where Trailing == EmptyView {
    init(title: String, @ViewBuilder content: () -> Content) {
        self.init(title: title, trailing: { EmptyView() }, content: content)
    }
}

/// The status line (Row secondary): items joined by " · ", and an optional right part.
struct LensStatusLine<Leading: View, Trailing: View>: View {
    @ViewBuilder let leading: Leading
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: 6) {
            leading
            Spacer(minLength: 8)
            trailing
        }
        .font(Theme.fontSwiftUI(.rowSecondary))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

/// The separator between status items.
struct Dot: View {
    var body: some View { Text("·").foregroundStyle(.tertiary).accessibilityHidden(true) }
}

/// The Lens title (Title role), led by the outcome mark in its impact color; built from structured fields, never from
/// trace text and never with an identifier.
struct LensTitle: View {
    let mark: Mark?
    var color: NSColor = .secondaryLabelColor
    var outlined = false
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let mark {
                Image(systemName: outlined ? mark.outlinedSymbol : mark.symbol)
                    .foregroundStyle(color.swiftUI)
                    .accessibilityHidden(true)
            }
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
        .font(Theme.fontSwiftUI(.title))
        .accessibilityAddTraits(.isHeader)
    }
}

/// A code block (§3.5): machine text on the well, radius 4, padded 8 by 10. Long text shows its head and tail lines
/// joined by "⋯ 38 lines omitted ⋯", with "Show full output (1,142 characters)" to expand in place.
struct CodeBlock: View {
    let text: String
    var headLines = 6
    var tailLines = 4
    /// Text to set on the error wash (the matched error line).
    var highlight: String?
    /// The text is the signature: placeholders muted, never clamped.
    var signature = false
    var noun = "output"
    @State private var expanded = false

    var body: some View {
        let clamp = OutputView.preview(head: text, tail: nil, headLines: headLines, tailLines: tailLines)
        VStack(alignment: .leading, spacing: 4) {
            Text(attributed(expanded || signature ? text : clamp.text))
                .font(Theme.fontSwiftUI(.code))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
                .padding(.horizontal, 10)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color(nsColor: .quaternarySystemFill)))
            if !signature, clamp.hidden > 0 || expanded {
                Button(expanded ? "Show Less" : "Show full \(noun) (\(Formatters.count(text.count, "character")))") { expanded.toggle() }
                    .buttonStyle(.link)
                    .font(Theme.fontSwiftUI(.rowSecondary))
            }
        }
    }

    private func attributed(_ s: String) -> AttributedString {
        if signature { return SignatureText.attributed(s) }
        var a = AttributedString(s)
        if let h = highlight?.trimmingCharacters(in: .whitespacesAndNewlines), !h.isEmpty, let r = a.range(of: h) {
            a[r].backgroundColor = Theme.err.swiftUI.opacity(0.12)
        }
        return a
    }
}

/// Prose (§3.4, §3.5): at most 80 characters wide, clamped at `lines` with "Show all (2,310 characters)".
struct ProseBlock: View {
    let text: String
    var lines = 6
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text)
                .lineLimit(expanded ? nil : lines)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 560, alignment: .leading)
            if text.count > lines * 80 || text.filter({ $0 == "\n" }).count >= lines {
                Button(expanded ? "Show Less" : "Show all (\(Formatters.count(text.count, "character")))") { expanded.toggle() }
                    .buttonStyle(.link)
                    .font(Theme.fontSwiftUI(.rowSecondary))
            }
        }
    }
}

/// A link to an event: selects it (the detail and raw panes follow); ⌘-click shows it in Events.
struct EventLink: View {
    let model: WindowModel
    let eventID: String
    let label: String
    var mono = false

    var body: some View {
        Button {
            let reveal = NSEvent.modifierFlags.contains(.command)
            model.select(event: eventID, reveal: reveal)
        } label: {
            Text(label)
                .font(mono ? Theme.fontSwiftUI(.code) : nil)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .buttonStyle(.link)
        .help("Select this event; ⌘-click shows it in Events")
    }
}

/// A value with its provenance mark after it and a tooltip that names the source (and an inferred rule's precision).
struct ProvText: View {
    let text: String
    let prov: Prov?
    let analysis: AnalysisStatus?

    var body: some View {
        Text(DerivedStyle.marked(text, prov))
            .monospacedDigit()
            .help(DerivedStyle.provHelp(prov, analysis: analysis))
    }
}

/// Signature text: placeholders (`<url>`, `<n>`) muted so the literal (matched) words stand out.
enum SignatureText {
    static func attributed(_ text: String) -> AttributedString {
        var out = AttributedString()
        var rest = Substring(text)
        while let r = rest.range(of: #"<[a-z]+(:[^>]*)?>"#, options: .regularExpression) {
            out += AttributedString(String(rest[..<r.lowerBound]))
            var ph = AttributedString(String(rest[r]))
            ph.foregroundColor = .secondary
            out += ph
            rest = rest[r.upperBound...]
        }
        out += AttributedString(String(rest))
        return out
    }
}

// MARK: - Where

/// Where (§7.7): the breadcrumb (run › child › turn › step), the metadata line (model, approval, sandbox, context) and,
/// for a spawned session, the parent line.
struct WhereView: View {
    let model: WindowModel
    let w: LensWhere

    /// Crumbs with consecutive identical labels merged.
    private var crumbs: [(crumb: LensWhere.Crumb, label: String)] {
        var out: [(LensWhere.Crumb, String)] = []
        for c in w.breadcrumb where c.kind != "step" {
            let label = c.label ?? (c.kind == "run" || c.kind == "session" ? model.store.title(of: c.id) : TimelineText.shortID(c.id))
            if out.last?.1 == label { continue }
            out.append((c, label))
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            FlowLayout(spacing: 4) {
                ForEach(Array(crumbs.enumerated()), id: \.offset) { i, c in
                    HStack(spacing: 4) {
                        if i > 0 { Text("›").foregroundStyle(.tertiary) }
                        crumb(c.crumb, label: c.label)
                    }
                }
                if let s = w.step {
                    HStack(spacing: 4) {
                        if !crumbs.isEmpty { Text("›").foregroundStyle(.tertiary) }
                        Text(s.text(afterTurnCrumb: w.breadcrumb.contains { $0.kind == "turn" })).fontWeight(.semibold).fixedSize()
                    }
                }
            }
            metadata
            if let parent = parentLine { parent }
        }
    }

    /// One crumb: a plain link, cut at the tail between 12 and 40 characters (the line wraps first).
    @ViewBuilder private func crumb(_ c: LensWhere.Crumb, label: String) -> some View {
        let text = c.kind == "turn" ? "turn “\(label)”" : label
        let cut = Text(text).lineLimit(1).truncationMode(.tail).frame(minWidth: 84, maxWidth: 280, alignment: .leading).fixedSize(horizontal: text.count <= 40, vertical: false)
        switch c.kind {
        case "run", "session":
            Button { model.openSession(c.id, mode: .steps) } label: { cut }
                .buttonStyle(.link)
                .help(label + "\nOpen in Session · Steps")
        default:
            cut.help(label)
        }
    }

    /// "Model gpt-6-astra · Approval on-request · Sandbox workspace-write · Context 78k of 258k": keys muted, values in
    /// the primary color, a missing value "not logged" in the faint color.
    private var metadata: some View {
        let analysis = model.info?.analysis
        let posture = w.posture
        var items: [(String, String?, Prov?)] = [("Model", w.model, nil), ("Approval", posture.approval, posture.src), ("Sandbox", posture.sandbox, posture.src)]
        if let mode = posture.permissionMode { items.append(("Mode", mode, posture.src)) }
        items.append(("Context", w.ctx.tokens.map { Formatters.tokens($0) + (w.ctx.window.map { " of " + Formatters.tokens($0) } ?? "") }, w.ctx.windowSrc))
        return FlowLayout(spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                HStack(spacing: 4) {
                    if i > 0 { Dot() }
                    Text(item.0).foregroundStyle(.secondary)
                    if let v = item.1 {
                        Text(DerivedStyle.marked(v, item.2)).help(item.2.map { DerivedStyle.provHelp($0, analysis: analysis) } ?? "")
                    } else {
                        Text("not logged").foregroundStyle(.tertiary)
                    }
                }
                .fixedSize()
            }
        }
        .font(Theme.fontSwiftUI(.rowSecondary))
    }

    /// "Spawned by <parent title> (completed) ›", a link to the delegation that started this session.
    private var parentLine: AnyView? {
        guard let last = w.delegationPath.last else { return nil }
        let sessions = w.breadcrumb.filter { $0.kind == "run" || $0.kind == "session" }
        let parent = sessions.firstIndex { $0.id == last.sessionId }.flatMap { $0 > 0 ? sessions[$0 - 1] : nil }
        let title = parent.map { $0.label ?? model.store.title(of: $0.id) } ?? "its parent"
        return AnyView(
            Button {
                model.openLens(LensItem(kind: .delegation, id: last.spanId), reveal: false)
            } label: {
                Text("Spawned by \(title)" + (last.outcome.map { " (\($0.rawValue))" } ?? "") + " ›").lineLimit(1).truncationMode(.middle)
            }
            .buttonStyle(.link)
            .font(Theme.fontSwiftUI(.rowSecondary))
            .help("Open the delegation that started this session")
        )
    }
}

/// Gaps: what the data cannot show, in plain sentences; data-limit numbers stay in the tooltips.
struct GapList: View {
    let gaps: [Gap]

    var body: some View {
        if gaps.isEmpty {
            Text("No stated gaps for this item.").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(gaps) { g in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: Mark.dataGap.symbol).foregroundStyle(.secondary).accessibilityHidden(true)
                        Text(g.message).fixedSize(horizontal: false, vertical: true).frame(maxWidth: 560, alignment: .leading)
                    }
                    .help(g.limit.map { "Data limit \($0) (SPEC §12.9)" } ?? g.code.rawValue)
                }
            }
        }
    }
}

/// A word diff: additions green, deletions red and struck through. Ops are runs of whole words, so a space separates
/// neighbors unless one already ends or starts with whitespace.
struct DiffOpsText: View {
    let ops: [DiffOp]

    var body: some View {
        Text(ops.enumerated().reduce(AttributedString()) { acc, item in
            let (i, op) = item
            let needsSpace = i > 0 && !(ops[i - 1].text.last?.isWhitespace ?? true) && !(op.text.first?.isWhitespace ?? true)
            var a = AttributedString((needsSpace ? " " : "") + op.text)
            switch op.op {
            case "add":
                a.foregroundColor = Theme.ok.swiftUI
                a.backgroundColor = Theme.ok.swiftUI.opacity(0.12)
            case "del":
                a.foregroundColor = Theme.err.swiftUI
                a.strikethroughStyle = .single
            default:
                a.foregroundColor = .secondary
            }
            return acc + a
        })
        .font(Theme.fontSwiftUI(.code))
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// "2 edits ›": a link that opens the diffs of the edits between two attempts or in the close.
struct EditLinks: View {
    let model: WindowModel
    let edits: [EditRef]

    var body: some View {
        if edits.count == 1, let e = edits.first {
            link(e, title: "1 edit: \((e.path as NSString).lastPathComponent)" + counts(e) + " ›")
        } else {
            Menu(Formatters.count(edits.count, "edit") + " ›") {
                ForEach(edits, id: \.self) { e in
                    Button((e.path as NSString).lastPathComponent + counts(e)) { open(e) }
                }
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help(edits.map(\.path).joined(separator: "\n"))
        }
    }

    private func counts(_ e: EditRef) -> String {
        [e.added.map { " +\($0)" }, e.removed.map { " −\($0)" }].compactMap { $0 }.joined()
    }

    private func link(_ e: EditRef, title: String) -> some View {
        Button(title) { open(e) }.buttonStyle(.link).help(e.path + "\nShow the diff")
    }

    private func open(_ e: EditRef) {
        model.diffRequest = DiffRequest(eventId: e.eventId, path: e.path, title: (e.path as NSString).lastPathComponent,
                                        session: model.failures.lensSubject?.session)
    }
}

/// Lays children out in rows, wrapping at the available width.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4
    var lineSpacing: CGFloat = 2

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 600
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0, x + size.width > width {
                x = 0
                y += rowH + lineSpacing
                rowH = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x)
            rowH = max(rowH, size.height)
        }
        return CGSize(width: min(width, maxX), height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowH + lineSpacing
                rowH = 0
            }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
    }
}

// MARK: - Episode

struct EpisodeLensView: View {
    @Bindable var model: WindowModel
    let lens: LensModel
    let p: LensPayload
    @FocusState private var focused: Bool

    private var analysis: AnalysisStatus? { model.info?.analysis }

    var body: some View {
        ScrollViewReader { proxy in
            LensPane(model: model, kind: "Episode", primary: LensActions.showInSession(model), secondary: [
                LensAction(title: "Show in Events", help: "Events filtered to this episode") { model.showEpisodeInEvents(p.episode.id) },
                LensActions.follow(model),
                LensAction(title: "Copy Report", help: "Markdown, agent brief or JSON, after a redaction preview (⇧⌘C)") { model.copyReport() },
            ]) {
                header
                LensSection(title: "Where") { WhereView(model: model, w: p.where) }
                LensSection(title: "Trigger") { trigger }
                LensSection(title: "Attempts (\(p.attempts.count))") {
                    Text("Times " + Formatters.offsetLabel())
                } content: {
                    AttemptsLadder(model: model, lens: lens, attempts: p.attempts)
                }
                LensSection(title: "Close") { CloseView(model: model, close: p.close) }
                LensSection(title: "Cost") { cost }
                LensSection(title: "Seen before") { SeenBeforeView(model: model, seen: p.seenBefore, family: p.episode.signature.family, signatureID: p.episode.signature.id) }
                    .id("seen-before")
                LensSection(title: "Related") { RelatedView(model: model, related: p.related) }
                LensSection(title: "Gaps") { GapList(gaps: p.gaps) }
            }
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .simultaneousGesture(TapGesture().onEnded { focused = true })
            .onKeyPress(.upArrow) { moveAttempt(-1, proxy) }
            .onKeyPress(.downArrow) { moveAttempt(1, proxy) }
            .environment(\.lensScroll, { id in withAnimation(.easeInOut(duration: 0.15)) { proxy.scrollTo(id, anchor: .top) } })
        }
    }

    private func moveAttempt(_ step: Int, _ proxy: ScrollViewProxy) -> KeyPress.Result {
        guard let a = lens.moveAttempt(step) else { return .ignored }
        model.select(event: a.eventId, reveal: false)
        withAnimation(.easeInOut(duration: 0.15)) { proxy.scrollTo("attempt-\(a.n)", anchor: .center) }
        return .handled
    }

    /// The status line, the structured title and the signature block (§7.7 Header block).
    private var header: some View {
        let e = p.episode
        let (mark, color) = DerivedStyle.outcomeMark(e.outcome)
        return VStack(alignment: .leading, spacing: 8) {
            LensStatusLine {
                TierBadge(tier: e.tier, help: "Tier \(e.tier.rawValue)")
                Dot()
                Text(e.signature.family.rawValue).help("Family \(e.signature.family.rawValue) · class \(e.signature.class.rawValue)")
                if let agent = model.lensAgent {
                    Dot()
                    AgentName(agent: agent)
                }
                if p.where.live { Dot(); PlainMark(mark: .live, text: "Live", color: .controlAccentColor) }
                if e.unattended { Dot(); Text("unattended").help("No human was watching: a subagent, an active goal, or approval set to never.") }
                // One item: "⟳ blind loop" when the attempts repeat with no edit between them, else "⟳ loop" (M-19).
                if e.blind {
                    Dot(); PlainMark(mark: .loop, text: "blind loop", color: Theme.warn, help: "At least 3 identical attempts with no edit between them")
                } else if e.loop {
                    Dot(); PlainMark(mark: .loop, text: "loop", color: Theme.warn, help: "At least 5 attempts with one signature")
                }
            } trailing: {
                SignatureStatusMark(status: p.seenBefore.status)
                SeenBeforeLink()
            }
            LensTitle(mark: mark, color: color, text: DerivedStyle.episodeTitle(e.outcome, attempts: e.nAttempts))
                .help("Outcome: " + DerivedStyle.provHelp(e.outcomeSrc, analysis: analysis) + (e.actor.map { "\nActor: \($0)" } ?? ""))
            CodeBlock(text: e.signature.text, signature: true)
                .help("Signature: placeholders such as <url> and <n> stand for the parts that vary")
        }
    }

    /// Trigger (§7.7): a two-column grid with a 72 pt label column.
    private var trigger: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 8, verticalSpacing: 6) {
            GridRow {
                label("Intent")
                if let t = p.intent.text {
                    ProvText(text: t, prov: p.intent.src, analysis: analysis).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("not logged").foregroundStyle(.tertiary)
                }
            }
            GridRow {
                label("Target")
                Text(p.episode.targetKey).font(Theme.fontSwiftUI(.code)).textSelection(.enabled)
                    .padding(.horizontal, 4)
                    .background(RoundedRectangle(cornerRadius: 3).fill(Color(nsColor: .quaternarySystemFill)))
            }
            if let first = p.attempts.first {
                if let input = first.input {
                    GridRow {
                        label("Input")
                        CodeBlock(text: input, headLines: 2, tailLines: 0, noun: "input")
                    }
                }
                if let out = OutputView.text(first.result) {
                    GridRow {
                        label("Output")
                        CodeBlock(text: out, headLines: 4, tailLines: 2, highlight: first.result.errorLine)
                    }
                }
            }
        }
    }

    private func label(_ s: String) -> some View {
        Text(s).foregroundStyle(.secondary).frame(width: 72, alignment: .leading).gridColumnAlignment(.leading)
    }

    /// Cost (§7.7): one figure per label, tabular.
    private var cost: some View {
        let e = p.episode
        return Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
            GridRow {
                Text("Wall time lost").foregroundStyle(.secondary)
                if let w = e.wallUs { ProvText(text: Formatters.duration(w), prov: e.wallSrc, analysis: analysis) } else { Text(Formatters.missing).foregroundStyle(.tertiary) }
            }
            GridRow {
                Text("Attempts").foregroundStyle(.secondary)
                Text(Formatters.count(e.nAttempts)).monospacedDigit()
            }
            GridRow {
                Text("Steps").foregroundStyle(.secondary)
                Text(Formatters.count(e.nSteps)).monospacedDigit()
            }
            GridRow {
                Text("Tokens out").foregroundStyle(.secondary)
                Text(e.tokOut.map { Formatters.tokens($0) } ?? Formatters.missing).monospacedDigit()
            }
            GridRow {
                Text("Tokens in").foregroundStyle(.secondary)
                Text(e.tokInUpperBound.map { "≤" + Formatters.tokens($0) + " (upper bound)" } ?? Formatters.missing).monospacedDigit()
                    .help("Input tokens processed over the episode's steps; an upper bound on what recovery cost.")
            }
        }
    }
}

/// Scrolls the Lens document to an anchor ("Seen before ›").
private struct LensScrollKey: EnvironmentKey {
    static let defaultValue: @MainActor (String) -> Void = { _ in }
}

extension EnvironmentValues {
    var lensScroll: @MainActor (String) -> Void {
        get { self[LensScrollKey.self] }
        set { self[LensScrollKey.self] = newValue }
    }
}

/// "Seen before ›": scrolls to the Seen before section; prints no figures.
struct SeenBeforeLink: View {
    @Environment(\.lensScroll) private var scroll

    var body: some View {
        Button("Seen before ›") { scroll("seen-before") }
            .buttonStyle(.link)
            .help("Go to Seen before")
    }
}

/// A signature status (§6.2): "recurring" and "dormant" muted with their marks, "regressed" in amber, "new" in blue.
struct SignatureStatusMark: View {
    let status: SignatureStatus

    var body: some View {
        let (mark, color) = DerivedStyle.signatureStatusMark(status)
        PlainMark(mark: mark, text: status.rawValue, color: color)
    }
}

/// The four Lens actions shared by every kind.
@MainActor enum LensActions {
    static func showInSession(_ model: WindowModel) -> LensAction {
        LensAction(title: "Show in Session", help: "Session · Steps with this step expanded and selected (⌘↩)") { model.showInSession() }
    }

    static func follow(_ model: WindowModel) -> LensAction {
        model.followCandidate == nil
            ? LensAction(title: "Follow", help: "Nothing to follow: this item has no call, process or delegation stream", run: nil)
            : LensAction(title: "Follow", help: "The call, delegation or process stream (⌥⌘F)") { model.follow() }
    }

    static func copyReportUnavailable(_ what: String) -> LensAction {
        LensAction(title: "Copy Report", help: "Reports for \(what) need a newer engine; episodes have them (⇧⌘C)", run: nil)
    }
}

/// An attempt's or a result's output text: the head and the tail of the output (the error line when there is no
/// output).
struct OutputView {
    /// The text to show for a result: head, then tail when the index kept one; the error line alone otherwise.
    static func text(_ r: LensAttemptResult) -> String? {
        let parts = [r.head, r.tail].compactMap { $0?.trimmingCharacters(in: .newlines) }.filter { !$0.isEmpty }
        if parts.isEmpty { return r.errorLine }
        return parts.joined(separator: "\n")
    }

    /// The clamped text: the first `headLines`, "⋯ n lines omitted ⋯", then the last `tailLines` (§3.5 Code block).
    static func preview(head: String?, tail: String?, headLines: Int = 4, tailLines: Int = 2) -> (text: String, hidden: Int) {
        var lines = (head.map { $0.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) } ?? [])
        if let tail { lines += tail.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) }
        while lines.last?.isEmpty == true { lines.removeLast() }
        guard lines.count > headLines + tailLines + 1 else { return (lines.joined(separator: "\n"), 0) }
        let hidden = lines.count - headLines - tailLines
        let shown = Array(lines.prefix(headLines)) + ["⋯ \(Formatters.count(hidden, "line")) omitted ⋯"] + Array(lines.suffix(tailLines))
        return (shown.joined(separator: "\n"), hidden)
    }

    /// Whether a preview with no hidden lines says nothing but the error line.
    static func onlyRepeats(_ errorLine: String?, preview: (text: String, hidden: Int)) -> Bool {
        guard preview.hidden == 0, let e = errorLine?.trimmingCharacters(in: .whitespacesAndNewlines), !e.isEmpty else { return false }
        let lines = preview.text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return lines.joined(separator: " ") == e
    }
}

/// The attempts ladder (§7.7): one block per attempt. More than three attempts show the first, the selected and the
/// last; the others collapse into "+n attempts" rows that expand in place. Parallel attempts sit under "Same step
/// (parallel)". ↑ and ↓ move between attempts.
struct AttemptsLadder: View {
    let model: WindowModel
    let lens: LensModel
    let attempts: [LensAttempt]
    @State private var expanded: Set<Int> = []

    private var selected: Int? {
        lens.selectedAttempt ?? attempts.first { $0.eventId == model.selectedEvent }?.n
    }

    /// Attempts and collapsed runs, in order.
    private var rows: [(id: String, attempts: [LensAttempt], collapsed: Bool)] {
        guard attempts.count > 3 else { return attempts.map { ("a\($0.n)", [$0], false) } }
        let keep: Set<Int> = [attempts.first!.n, attempts.last!.n, selected ?? attempts.last!.n]
        var out: [(String, [LensAttempt], Bool)] = []
        var run: [LensAttempt] = []
        func flush() {
            if !run.isEmpty {
                let id = "c\(run.first!.n)"
                if expanded.contains(run.first!.n) { out += run.map { ("a\($0.n)", [$0], false) } } else { out.append((id, run, true)) }
            }
            run = []
        }
        for a in attempts {
            if keep.contains(a.n) {
                flush()
                out.append(("a\(a.n)", [a], false))
            } else {
                run.append(a)
            }
        }
        flush()
        return out
    }

    private func attempt(_ n: Int) -> LensAttempt? { attempts.first { $0.n == n } }

    /// Attempts in one step run in parallel (§7.7): the group's label goes before its first attempt.
    private func startsSameStepGroup(_ a: LensAttempt) -> Bool {
        let prev = attempt(a.n - 1), next = attempt(a.n + 1)
        func same(_ x: LensAttempt?, _ y: LensAttempt?) -> Bool { x?.step != nil && x?.step == y?.step }
        return (a.parallel && !(prev?.parallel ?? false)) || (same(a, next) && !same(a, prev))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(rows, id: \.id) { row in
                if row.collapsed {
                    Button("+\(Formatters.count(row.attempts.count, "attempt"))") { expanded.insert(row.attempts.first!.n) }
                        .buttonStyle(.link)
                        .font(Theme.fontSwiftUI(.rowSecondary))
                        .padding(.leading, 10)
                        .help("Attempts \(row.attempts.first!.n)–\(row.attempts.last!.n). Click to show them.")
                } else if let a = row.attempts.first {
                    if startsSameStepGroup(a) {
                        Text("Same step (parallel)").font(Theme.fontSwiftUI(.rowSecondary)).foregroundStyle(.secondary).padding(.leading, 10)
                    }
                    // The first attempt's command and result are the Trigger's Input and Output: shown once (§13 check 10).
                    AttemptRow(model: model, a: a, selected: selected == a.n, inTrigger: a.n == attempts.first?.n)
                        .id("attempt-\(a.n)")
                        .contentShape(Rectangle())
                        .onTapGesture {
                            lens.selectedAttempt = a.n
                            model.select(event: a.eventId, reveal: false)
                        }
                }
            }
        }
        .onChange(of: lens.selectedAttempt) { _, n in
            // ↑ and ↓ reaching a collapsed attempt expand its run.
            if let n, let run = rows.first(where: { $0.collapsed && $0.attempts.contains { $0.n == n } }) { expanded.insert(run.attempts.first!.n) }
        }
    }
}

/// One attempt (§7.7): "#2 · step 49 · 00:06:48 · +12.4s · +3 steps" with the exit on the right, the command as
/// single-line code (click expands it), the result line, then the change class with its word diff and the edits.
struct AttemptRow: View {
    let model: WindowModel
    let a: LensAttempt
    let selected: Bool
    /// The Trigger section already shows this attempt's input and output.
    var inTrigger = false
    @State private var showsCommand = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(line1).monospacedDigit().foregroundStyle(.secondary)
                if a.deferredPolls > 0 {
                    Text("+\(a.deferredPolls) polls").foregroundStyle(.secondary).help("Deferred \"still running\" polls folded into this attempt")
                }
                if a.reread { Text("re-read").foregroundStyle(.secondary).help("The file was read again between the attempts") }
                Spacer(minLength: 8)
                exit
                EventLink(model: model, eventID: a.eventId, label: "Event ›")
            }
            .font(Theme.fontSwiftUI(.rowSecondary))
            if let ops = a.inputDiff, a.n > 1, ops.contains(where: { $0.op != "eq" }) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let c = a.changeClass {
                        Text(c.rawValue).font(Theme.fontSwiftUI(.rowSecondary))
                            .foregroundStyle(c.rawValue == "identical" ? Theme.warn.swiftUI : .secondary)
                    }
                    DiffOpsText(ops: ops)
                }
            } else if let input = a.input, !inTrigger {
                Text(input)
                    .font(Theme.fontSwiftUI(.code))
                    .lineLimit(showsCommand ? nil : 1)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
                    .padding(.horizontal, 4)
                    .background(RoundedRectangle(cornerRadius: 3).fill(Color(nsColor: .quaternarySystemFill)))
                    .onTapGesture(count: 2) { showsCommand.toggle() }
                    .help(showsCommand ? "Double-click to show one line" : input)
                if a.n > 1, let c = a.changeClass, c.rawValue == "identical" {
                    Text("identical to the previous attempt").font(Theme.fontSwiftUI(.rowSecondary)).foregroundStyle(Theme.warn.swiftUI)
                }
            }
            if let line = a.result.errorLine, !inTrigger {
                Text(line).font(Theme.fontSwiftUI(.code)).lineLimit(2).textSelection(.enabled).foregroundStyle(.primary)
            }
            if !a.editsBetween.isEmpty { EditLinks(model: model, edits: a.editsBetween).font(Theme.fontSwiftUI(.rowSecondary)) }
        }
        .padding(.vertical, 6)
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .background(alignment: .leading) {
            Rectangle().fill(selected ? Color.accentColor : Color.clear).frame(width: 2)
        }
        .background(selected ? Color.accentColor.opacity(0.08) : Color.clear)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Attempt \(a.n), \(a.tier.rawValue)\(a.result.errorLine.map { ": \($0)" } ?? "")")
    }

    /// "#2 · step 49 · 00:06:48 · +12.4s · +3 steps".
    private var line1: String {
        var parts = ["#\(a.n)"]
        if let s = a.step { parts.append("step \(s)") }
        parts.append(String(Formatters.clock(a.ts, zone: Formatters.timeZone).prefix(8)))
        // An attempt in the same step as the one before it has no gap to show ("+0µs · +0 steps" said nothing, M-22).
        if a.n > 1, let s = a.gapSteps, s > 0 {
            if let g = a.gapUs { parts.append("+" + Formatters.duration(g)) }
            parts.append("+" + Formatters.count(s, "step"))
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var exit: some View {
        let failed = a.tier == .failure
        HStack(spacing: 3) {
            if failed { Image(systemName: Mark.failed.symbol).accessibilityHidden(true) }
            if let code = a.result.exitCode {
                ProvText(text: "exit \(code)", prov: a.result.exitSrc, analysis: model.info?.analysis)
            } else {
                Text(a.tier.rawValue)
            }
        }
        .foregroundStyle(a.tier == .failure || (a.result.exitCode ?? 0) != 0 ? Theme.err.swiftUI : .secondary)
        .help("Tier \(a.tier.rawValue)")
    }
}

/// Close (§7.7): one sentence naming the closing event and its Event link, then the message as prose (clamp 6 lines).
struct CloseView: View {
    let model: WindowModel
    let close: LensClose

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(title)
                if let id = close.eventId { EventLink(model: model, eventID: id, label: "Event ›") }
            }
            if let t = close.detail.text {
                if close.kind == "final-message" { ProseBlock(text: t) } else { CodeBlock(text: t, headLines: 4, tailLines: 2) }
            }
            if let actor = close.detail.actor { Text("Actor: \(actor)").foregroundStyle(.secondary) }
            if let claim = close.detail.claim {
                // A claim is never red (§6.2).
                PlainMark(mark: .claim, text: "claim: " + DerivedStyle.outcomeWord(claim.rawValue), color: claim.isUnverified ? Theme.warn : .secondaryLabelColor,
                          help: "The claim check of the final message")
                    .font(Theme.fontSwiftUI(.rowSecondary))
            }
            if !close.detail.edits.isEmpty { EditLinks(model: model, edits: close.detail.edits) }
            ForEach(close.detail.calls, id: \.eventId) { c in
                HStack(spacing: 6) {
                    if c.tier == .failure { Image(systemName: Mark.failed.symbol).foregroundStyle(Theme.err.swiftUI).accessibilityHidden(true) }
                    EventLink(model: model, eventID: c.eventId, label: [c.tool, c.target].compactMap { $0 }.joined(separator: " "), mono: true)
                }
            }
        }
    }

    private var title: String {
        switch close.kind {
        case "recovered": return "Recovered by a later call with the same target"
        case "parallel-ok": return "The same target succeeded in the same step"
        case "recovered-later": return "The target succeeded in a later turn"
        case "pivoted": return "Other targets succeeded; the turn ended normally"
        case "interrupted": return "The turn was interrupted"
        case "final-message": return "The turn ended with this message"
        case "open": return "Still open: the turn has not ended"
        default: return close.kind
        }
    }
}

/// Seen before (§7.7): a 30-day sparkline labeled "last 30 days", "14 episodes in 11 sessions · first Sep 6 · last 1d
/// ago", "6 of 14 recovered (43%)", up to three observed fixes, environment advice, and the signature id.
struct SeenBeforeView: View {
    let model: WindowModel
    let seen: LensSeenBefore
    let family: FailureFamily
    let signatureID: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    SparklineView(daily: seen.daily).frame(width: 120, height: 18)
                    Text("last 30 days").font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.tertiary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.counts(seen))
                    if let r = Self.recovered(seen) { Text(r).foregroundStyle(.secondary).help(Self.recoveredHelp(seen)) }
                }
            }
            if seen.fixes.isEmpty {
                Text("No fix observed in past recoveries.").foregroundStyle(.secondary)
            } else {
                Text("Observed in past recoveries, not verified:").foregroundStyle(.secondary)
                ForEach(seen.fixes.prefix(3), id: \.self) { f in
                    HStack(spacing: 6) {
                        Text(f.kind).foregroundStyle(.secondary)
                        Text(f.pattern).font(Theme.fontSwiftUI(.code)).textSelection(.enabled)
                        Text("in \(f.n) of \(Formatters.count(f.of, "recovery", plural: "recoveries"))").monospacedDigit().foregroundStyle(.secondary)
                        Button("Example ›") { model.openEpisode(f.exampleEpisode, reveal: false) }.buttonStyle(.link)
                    }
                }
            }
            if let advice = seen.advice { Text(Self.advice(advice, family: family)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).frame(maxWidth: 560, alignment: .leading) }
            Text(signatureID).font(Theme.fontSwiftUI(.code)).foregroundStyle(.tertiary).textSelection(.enabled)
                .help("Signature id; click Show Signature (⌥⌘G) for its history")
        }
    }

    /// "14 episodes in 11 sessions · first Sep 6 · last 1d ago" (the episode count when the engine sends it).
    static func counts(_ s: LensSeenBefore) -> String {
        let lead = s.episodes.map { Formatters.count($0, "episode") + " in " } ?? "In "
        return lead + Formatters.count(s.sessions, "session") + " · first " + Formatters.shortDate(s.firstTs) + " · last " + Formatters.relative(s.lastTs)
    }

    /// "6 of 14 recovered (43%)" (§9 Rates and shares); with only a rate, "43% of episodes recovered".
    static func recovered(_ s: LensSeenBefore) -> String? {
        if let n = s.episodes, let k = s.recovered, n > 0 {
            return "\(Formatters.count(k)) of \(Formatters.count(n)) recovered (\(Int((Double(k) / Double(n) * 100).rounded()))%)"
        }
        guard let r = s.recoveredRate else { return nil }
        return "\(Int((r * 100).rounded()))% of episodes recovered"
    }

    static func recoveredHelp(_ s: LensSeenBefore) -> String {
        "Episodes of this signature that recovered, of all its episodes in \(Formatters.count(s.sessions, "session"))"
    }

    static func advice(_ kind: String, family: FailureFamily) -> String {
        switch kind {
        case "environment":
            return "Environment: \(family.rawValue) failures recover in the same turn only 2–7% of the time. Check the sandbox, approval and network settings of this agent rather than the code."
        case "dependency": return "Dependency: a module or package is missing from the environment the agent runs in."
        case "harness": return "Harness: the agent's tooling (hooks, code mode, MCP) failed, not the task."
        default: return "Code: the failure comes from the work itself."
        }
    }
}

/// Related (association only): each row names its rule in the muted color ("within 3 calls").
struct RelatedView: View {
    let model: WindowModel
    let related: [LensRelated]

    var body: some View {
        if related.isEmpty {
            Text("Nothing associated.").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(related, id: \.self) { r in
                    HStack(spacing: 6) {
                        Text(r.kind.replacingOccurrences(of: "-", with: " ")).foregroundStyle(.secondary)
                        if r.kind == "child-episode" {
                            Button(r.label ?? r.id) { model.openEpisode(r.id, reveal: false) }.buttonStyle(.link).lineLimit(1)
                        } else if r.kind == "delegation" {
                            Button(r.label ?? r.id) { model.openLens(LensItem(kind: .delegation, id: r.id), reveal: false) }.buttonStyle(.link).lineLimit(1)
                        } else if let e = r.eventId {
                            EventLink(model: model, eventID: e, label: r.label ?? "Event ›")
                        } else {
                            Text(r.label ?? r.id).lineLimit(1)
                        }
                        Text(Self.ruleWords(r.rule)).foregroundStyle(.secondary).help("Association rule \(r.rule): related, not a cause")
                    }
                }
            }
        }
    }

    /// "near-3-calls@1" → "within 3 calls"; other rule ids keep their name without the version.
    static func ruleWords(_ rule: String) -> String {
        let name = rule.split(separator: "@").first.map(String.init) ?? rule
        let parts = name.split(separator: "-")
        if parts.count == 3, parts[0] == "near", parts[2] == "calls", let n = Int(parts[1]) { return "within \(n) calls" }
        return name.replacingOccurrences(of: "-", with: " ")
    }
}
