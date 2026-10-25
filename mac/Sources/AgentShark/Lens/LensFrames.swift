import AppKit
import SwiftUI

// Claims, delegations, signatures and runs in the Lens frame (SPEC §12.7: "Claims and delegations open in the same
// Lens frame"; DESIGN.md §7.7).

struct ClaimLensView: View {
    let model: WindowModel
    let c: ClaimLens

    private var evidenceWords: String { DerivedStyle.outcomeWord(c.claim.evidence.rawValue) }

    var body: some View {
        LensPane(model: model, kind: "Claim", primary: LensActions.showInSession(model), secondary: [
            LensAction(title: "Show in Events", help: "The final message in Events") { model.select(event: c.claim.finalEventId, reveal: true) },
            LensActions.follow(model),
            LensActions.copyReportUnavailable("claims"),
        ]) {
            VStack(alignment: .leading, spacing: 8) {
                LensStatusLine {
                    if let agent = model.lensAgent { AgentName(agent: agent) }
                    if c.where.live { Dot(); PlainMark(mark: .live, text: "Live", color: .controlAccentColor) }
                } trailing: {
                    EmptyView()
                }
                // A claim is never red (§6.2).
                LensTitle(mark: .claim, color: c.claim.evidence.isUnverified ? Theme.warn : .secondaryLabelColor,
                          text: (c.claim.evidence.isUnverified ? "Unverified claim · " : "Claim · ") + evidenceWords)
                    .help((model.info?.analysis?.ruleNote(Prov(rawValue: "inferred:\(c.claim.rule)/\(c.claim.evidence.rawValue)")) ?? c.claim.rule)
                          + "\nMatched the claim pattern \(c.claim.pattern). AgentShark does not judge the claim; it lists the evidence.")
                if let quote = c.claim.claimExcerpt {
                    ProseBlock(text: "“\(quote)”")
                }
            }
            LensSection(title: "Where") { WhereView(model: model, w: c.where) }
            LensSection(title: "Evidence") { evidence }
            if let t = c.finalText {
                LensSection(title: "Final message") {
                    HStack(spacing: 6) {
                        Text("The turn ended with this message")
                        EventLink(model: model, eventID: c.claim.finalEventId, label: "Event ›")
                    }
                    ProseBlock(text: t)
                }
            }
            LensSection(title: "Gaps") { GapList(gaps: c.gaps) }
        }
    }

    @ViewBuilder private var evidence: some View {
        if c.evidence.isEmpty {
            Text("No test run or edit in this turn.").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(c.evidence, id: \.eventId) { e in
                    HStack(spacing: 6) {
                        Text(e.kind == "test" ? "test" : "edit").foregroundStyle(.secondary).frame(width: 32, alignment: .leading)
                        if let s = e.step { Text("step \(s)").monospacedDigit().foregroundStyle(.secondary) }
                        EventLink(model: model, eventID: e.eventId, label: e.target ?? e.path ?? e.kind, mono: true)
                        if let code = e.exitCode {
                            ProvText(text: "exit \(code)", prov: e.exitSrc, analysis: model.info?.analysis)
                                .foregroundStyle(code == 0 ? Color.secondary : Theme.err.swiftUI)
                        } else if let tier = e.tier {
                            Text(tier.rawValue).foregroundStyle(DerivedStyle.tierColor(tier).swiftUI)
                        }
                        if let a = e.added { Text("+\(a)").monospacedDigit().foregroundStyle(Theme.ok.swiftUI) }
                        if let r = e.removed { Text("−\(r)").monospacedDigit().foregroundStyle(Theme.err.swiftUI) }
                        if e.earlier { Text("earlier turn").foregroundStyle(.secondary) }
                    }
                }
            }
        }
    }
}

struct DelegationLensView: View {
    let model: WindowModel
    let d: DelegationLens

    private var del: DelegationItem { d.delegation }

    var body: some View {
        LensPane(model: model, kind: "Delegation", primary: LensActions.showInSession(model), secondary: [
            LensAction(title: "Show in Events", help: "The result the parent saw, in Events") {
                if let e = del.resultEventId ?? d.parentSaw?.eventId { model.select(event: e, reveal: true) }
            },
            LensAction(title: "Follow", help: "Task, child steps with failure bands, the child's final message, what the parent saw (⌥⌘F)") {
                model.followTarget = .delegation(spanId: del.id)
            },
            LensActions.copyReportUnavailable("delegations"),
        ]) {
            header
            LensSection(title: "Where") { WhereView(model: model, w: d.where) }
            LensSection(title: "Child") { child }
            LensSection(title: "What the parent saw") { parent }
            LensSection(title: "Cost") {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                    GridRow {
                        Text("Tokens in (tree)").foregroundStyle(.secondary)
                        Text(del.tokInTree.map { Formatters.tokens($0) } ?? Formatters.missing).monospacedDigit()
                    }
                    GridRow {
                        Text("Tokens out (tree)").foregroundStyle(.secondary)
                        Text(del.tokOutTree.map { Formatters.tokens($0) } ?? Formatters.missing).monospacedDigit()
                    }
                    GridRow {
                        Text("Parent waited").foregroundStyle(.secondary)
                        Text(del.parentWaitUs.map { Formatters.duration($0) + "≈" } ?? Formatters.missing).monospacedDigit()
                            .help("Derived from the timestamps of the spawn and the result")
                    }
                }
            }
            LensSection(title: "Gaps") { GapList(gaps: d.gaps) }
        }
    }

    /// Status line (role, the child's agent, Live, unattended), the title and the task.
    private var header: some View {
        let logged = del.outcomeSrc?.family == .logged
        let failed = del.outcome.isFailure
        let told = del.parentTold.map { $0 ? "parent told: yes" : "parent told: no" }
        return VStack(alignment: .leading, spacing: 8) {
            LensStatusLine {
                Text(Self.roleWord(del.childRole ?? del.kind))
                if let agent = del.childAgent { Dot(); AgentName(agent: agent) }
                if d.where.live { Dot(); PlainMark(mark: .live, text: "Live", color: .controlAccentColor) }
            } trailing: {
                EmptyView()
            }
            // Logged outcomes use the filled mark; parsed, derived and inferred ones the outlined form (§6.3).
            LensTitle(mark: del.silent ? .silentChild : failed ? .failed : .clean, color: failed || del.silent ? Theme.err : .secondaryLabelColor,
                      outlined: !logged, text: "Child " + DerivedStyle.marked(del.outcome.rawValue, del.outcomeSrc) + (told.map { " · " + $0 } ?? ""))
                .help("Outcome: " + DerivedStyle.provHelp(del.outcomeSrc, analysis: model.info?.analysis)
                      + (del.silent ? "\nSilent: the child failed or was blocked and the parent was not told." : ""))
            if let task = d.task ?? del.taskExcerpt { ProseBlock(text: task, lines: 6) }
        }
    }

    /// "subagent", "workflow", "guardian" (§6.2 Role).
    static func roleWord(_ role: String) -> String {
        switch role {
        case "sub", "subagent", "agent", "task": return "subagent"
        case "wf", "workflow", "workflow-agent": return "workflow"
        default: return role.replacingOccurrences(of: "-", with: " ")
        }
    }

    private var child: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(Formatters.count(d.child.steps, "step") + (d.child.impact.map { " · worst impact \($0.rawValue)" } ?? ""))
                    .foregroundStyle(.secondary)
                if let child = del.childSession {
                    Button("Open the child session ›") { model.openSession(child, mode: .steps) }.buttonStyle(.link)
                }
            }
            ForEach(d.child.episodes, id: \.rowKey) { r in
                HStack(spacing: 6) {
                    let (mark, color) = DerivedStyle.rowMark(r)
                    if let mark { Image(systemName: mark.symbol).foregroundStyle(color.swiftUI).accessibilityHidden(true) }
                    Button(r.signature ?? r.target ?? r.id) { model.openEpisode(r.id, reveal: false) }
                        .buttonStyle(.link)
                        .lineLimit(1)
                    Text(DerivedStyle.rowWord(r)).foregroundStyle(.secondary)
                }
            }
            if let t = d.child.finalText {
                Text("The child's final message").foregroundStyle(.secondary)
                ProseBlock(text: t)
            }
        }
    }

    @ViewBuilder private var parent: some View {
        if let saw = d.parentSaw {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(saw.flagged ? "flagged as an error" : "not flagged as an error")
                        .foregroundStyle(saw.flagged ? Theme.err.swiftUI : .secondary)
                    if let told = saw.told {
                        Dot()
                        Text("told: \(told ? "yes" : "no")?").foregroundStyle(told ? Color.secondary : Theme.warn.swiftUI)
                            .help(model.info?.analysis?.ruleNote(Prov(rawValue: "inferred:\(saw.rule)/\(told ? "told" : "silent")")) ?? saw.rule)
                    }
                    EventLink(model: model, eventID: saw.eventId, label: "Event ›")
                }
                if let t = saw.text { CodeBlock(text: t, headLines: 4, tailLines: 2, noun: "result") }
                if let next = d.parentNext {
                    Text("The parent's next step: step \(next.n)").foregroundStyle(.secondary)
                    ForEach(next.calls, id: \.eventId) { c in
                        EventLink(model: model, eventID: c.eventId, label: [c.tool, c.target].compactMap { $0 }.joined(separator: " "), mono: true)
                    }
                }
            }
        } else {
            Text("The parent saw no result of this child.").foregroundStyle(.secondary)
        }
    }
}

// MARK: - Signature

/// A signature (SPEC §12.2 row 7, DESIGN.md §7.7): its history by day, Split at, observed fixes and recent episodes.
struct SignatureView: View {
    let model: WindowModel
    let signatureID: String
    @State private var detail: SignatureDetail?
    @State private var error: APIError?

    /// The facet bar's Split at day (§7.4); the Lens shows its comparison.
    private var splitAt: Int64? { model.signatureSplitAt }

    var body: some View {
        ZStack {
            if let s = detail {
                content(s)
            } else if let error {
                FailedStateView(title: "Could not load the signature", error: error) { Task { await load() } }
            } else {
                LoadingStateView(title: "Reading the signature…")
            }
        }
        .task(id: "\(signatureID)|\(splitAt ?? 0)") { await load() }
    }

    private func load() async {
        guard let api = model.engine.api else { return }
        do {
            detail = try await api.signature(signatureID, splitAt: splitAt)
            error = nil
        } catch {
            self.error = error as? APIError ?? .unreachable(error)
        }
    }

    private func listEpisodes(_ item: SignatureItem) {
        model.failureFacets.group = .episode
        model.applyFilter(fragment: "signature == " + FilterExpression.quote(item.id), mode: .andSelected)
    }

    private func content(_ s: SignatureDetail) -> some View {
        let item = s.item
        return LensPane(model: model, kind: "Signature",
                        primary: LensAction(title: "List Its Episodes", help: "The queue grouped by episode, filtered to this signature") { listEpisodes(item) },
                        secondary: [
                            LensAction(title: "Show in Events", help: "Events filtered to this signature") {
                                model.applyFilter("signature == " + FilterExpression.quote(item.id))
                                model.workspace = .events
                            },
                            LensAction(title: "Follow", help: "A signature spans sessions; open one of its episodes to follow it", run: nil),
                            LensActions.copyReportUnavailable("signatures"),
                        ]) {
            VStack(alignment: .leading, spacing: 8) {
                LensStatusLine {
                    Text(item.family.rawValue).help("Family \(item.family.rawValue) · class \(item.class.rawValue)")
                    ForEach(Array(item.agents.prefix(3).enumerated()), id: \.offset) { _, a in
                        Dot()
                        AgentName(agent: a)
                    }
                    if item.agents.count > 3 { Text("+\(item.agents.count - 3)").help(item.agents.dropFirst(3).map(\.label).joined(separator: ", ")) }
                } trailing: {
                    EmptyView()
                }
                let (mark, color) = DerivedStyle.signatureStatusMark(item.status)
                LensTitle(mark: mark, color: color, text: Self.title(item, row: queueRow, scoped: model.failures.countsAreScoped))
                CodeBlock(text: item.text, signature: true)
            }
            LensSection(title: "Counts") {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                    GridRow {
                        Text("Wall time lost").foregroundStyle(.secondary)
                        Text(Formatters.duration(item.wallLostUs) + "≈").monospacedDigit().help("Derived from the episodes' timestamps")
                    }
                    if let r = item.unrecoveredRate {
                        GridRow {
                            Text("Unrecovered").foregroundStyle(.secondary)
                            Text("\(Int((r * 100).rounded()))% of closed episodes").monospacedDigit()
                                .help("Unrecovered episodes of all recovered and unrecovered ones in all sessions; parallel and open episodes count in neither")
                        }
                    }
                    GridRow {
                        Text("First and last").foregroundStyle(.secondary)
                        Text(Formatters.shortDate(item.firstTs) + " · " + Formatters.relative(item.lastTs)).help(Formatters.timestamp(item.firstTs))
                    }
                }
            }
            LensSection(title: "By day") {
                DayBars(days: s.days, split: s.split.map { DayBars.day($0.at) }) { day in
                    if let at = DayBars.start(of: day) { model.signatureSplitAt = at }
                }
            }
            if let sp = s.split { LensSection(title: "Split at " + Formatters.shortDate(sp.at)) { split(sp) } }
            LensSection(title: "Observed fixes") {
                if s.fixes.isEmpty {
                    Text("No fix observed in past recoveries.").foregroundStyle(.secondary)
                }
                ForEach(s.fixes, id: \.self) { f in
                    HStack(spacing: 6) {
                        Text(f.kind).foregroundStyle(.secondary)
                        Text(f.pattern).font(Theme.fontSwiftUI(.code))
                        Text("in \(f.n) of \(Formatters.count(f.of, "recovery", plural: "recoveries")) · not verified").foregroundStyle(.secondary)
                        Button("Example ›") { model.openEpisode(f.exampleEpisode, reveal: false) }.buttonStyle(.link)
                    }
                }
            }
            LensSection(title: "Recent episodes") {
                ForEach(s.examples, id: \.episodeId) { e in RecentEpisodeRow(model: model, example: e) }
            }
            LensSection(title: "Gaps") { GapList(gaps: s.gaps) }
        }
    }

    /// The queue row this Lens shows, when the queue selected it: the title reads the row's counts (Mac notes 12).
    private var queueRow: QueueRow? {
        model.failures.selectedRow.flatMap { $0.kind == .signature && ($0.signatureId ?? $0.id) == signatureID ? $0 : nil }
    }

    /// "Recurring · 3 episodes in 7 sessions" from the row's fields; without a row (⌥⌘G), the signature's own counts,
    /// which count failures rather than episodes.
    static func title(_ item: SignatureItem, row: QueueRow?, scoped: Bool) -> String {
        let status = item.status.rawValue.prefix(1).uppercased() + item.status.rawValue.dropFirst()
        if let n = row?.members {
            return status + " · " + DerivedStyle.signatureCounts(episodes: n, sessions: row?.seenSessions, scoped: scoped)
        }
        return status + " · " + Formatters.count(item.n, "failure") + " in " + Formatters.count(item.sessions, "session")
    }

    /// "0.0017 → 0.0059 per active session"; rates under 0.01 read per 1,000 active sessions (§9 Rate change).
    static func rateChange(_ sp: SignatureSplit) -> (before: String, after: String, unit: String, up: Bool?)? {
        guard let a = sp.before.perActiveSession, let b = sp.after.perActiveSession else { return nil }
        let scale = max(a, b) < 0.01 ? 1000.0 : 1
        func f(_ v: Double) -> String { Formatters.significant(v * scale) }
        return (f(a), f(b), scale == 1 ? "per active session" : "per 1,000 active sessions", a == b ? nil : b > a)
    }

    /// Before and after the facet bar's Split at day, and the rate change (§7.4, §9 Rate change).
    private func split(_ sp: SignatureSplit) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Grid(alignment: .trailing, horizontalSpacing: 16, verticalSpacing: 3) {
                GridRow {
                    Text("").gridColumnAlignment(.leading)
                    Text("Before").foregroundStyle(.secondary).help("Before " + Formatters.timestamp(sp.at))
                    Text("After").foregroundStyle(.secondary).help("From " + Formatters.timestamp(sp.at))
                }
                row("Days", sp.before.days, sp.after.days)
                row("Failures", sp.before.n, sp.after.n)
                row("Active sessions", sp.before.activeSessions, sp.after.activeSessions)
            }
            .monospacedDigit()
            if let c = Self.rateChange(sp) {
                HStack(spacing: 4) {
                    Text("Rate").foregroundStyle(.secondary)
                    Text("\(c.before) → \(c.after) \(c.unit)")
                    if let up = c.up {
                        Image(systemName: up ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
                            .foregroundStyle(up ? Theme.err.swiftUI : Theme.ok.swiftUI)
                            .accessibilityLabel(up ? "up" : "down")
                    }
                }
            }
            Text("A comparison of rates, not a verdict on a fix: other changes on those days count too.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func row(_ title: String, _ a: Int, _ b: Int) -> some View {
        GridRow {
            Text(title).foregroundStyle(.secondary).gridColumnAlignment(.leading)
            Text(Formatters.count(a))
            Text(Formatters.count(b))
        }
    }
}

/// "Split at Oct 6" (§7.4): opens a calendar popover with an ISO date field ("2026-10-06"); no locale date input.
struct SplitAtButton: View {
    let at: Int64?
    let apply: (Int64) -> Void
    @State private var open = false

    var body: some View {
        Button(at.map { "Split at " + Formatters.shortDate($0) } ?? "Split at…") { open = true }
            .help(at.map { "Split at \(Formatters.isoDate($0)). Click to change." } ?? "Compare failures before and after a date")
            .popover(isPresented: $open, arrowEdge: .bottom) {
                // A week ago is the usual "did my fix work" question.
                SplitDatePopover(initial: at ?? Int64((Date().timeIntervalSince1970 - 7 * 86_400) * 1e6)) { us in
                    open = false
                    if let us { apply(us) }
                }
            }
    }
}

/// A graphical calendar and an ISO field that stay in step; Return or Split applies, Escape cancels.
struct SplitDatePopover: View {
    let initial: Int64
    let done: (Int64?) -> Void
    @State private var date = Date()
    @State private var iso = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            DatePicker("Split at", selection: $date, displayedComponents: [.date])
                .datePickerStyle(.graphical)
                .labelsHidden()
                .onChange(of: date) { _, d in iso = Formatters.isoDate(Int64(d.timeIntervalSince1970 * 1e6)) }
            HStack(spacing: 8) {
                TextField("YYYY-MM-DD", text: $iso)
                    .font(Theme.fontSwiftUI(.code))
                    .frame(width: 110)
                    .onSubmit { commit() }
                    .onChange(of: iso) { _, s in if let us = DayBars.start(of: s) { date = Date(timeIntervalSince1970: Double(us) / 1e6) } }
                Spacer()
                Button("Cancel", role: .cancel) { done(nil) }.keyboardShortcut(.cancelAction)
                Button("Split") { commit() }.keyboardShortcut(.defaultAction).disabled(DayBars.start(of: iso) == nil)
            }
            .controlSize(.small)
        }
        .padding(12)
        .frame(width: 260)
        .onAppear {
            date = Date(timeIntervalSince1970: Double(initial) / 1e6)
            iso = Formatters.isoDate(initial)
        }
    }

    private func commit() {
        if let us = DayBars.start(of: iso) { done(us) }
    }
}

/// Bars of failures per day, with the first and last day under them and the hovered day's date and count (§10.3).
/// With a split day, the days before it are dimmed and a rule marks it; clicking a day splits there.
struct DayBars: View {
    let days: [SignatureDay]
    var split: String?
    var onPick: ((String) -> Void)?
    @State private var hover: Int?

    /// The local `YYYY-MM-DD` of a time (the server's day keys are local dates).
    static func day(_ us: Int64) -> String { Formatters.isoDate(us) }

    /// Local midnight of a `YYYY-MM-DD` day, in µs.
    static func start(of day: String) -> Int64? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, parts[1] >= 1, parts[1] <= 12, parts[2] >= 1, parts[2] <= 31 else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = Formatters.timeZone
        guard let date = cal.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return nil }
        return Int64(date.timeIntervalSince1970 * 1e6)
    }

    /// "Oct 6" for a day key.
    static func label(_ day: String) -> String { start(of: day).map { Formatters.shortDate($0) } ?? day }

    /// "Last 37 days: 7 failures, at most 4 a day" (§10.3 text equivalent).
    static func summary(_ days: [SignatureDay]) -> String {
        "Last \(Formatters.count(days.count, "day")): \(Formatters.count(days.reduce(0) { $0 + $1.n }, "failure")), at most \(days.map(\.n).max() ?? 0) a day"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            GeometryReader { geo in
                let w = days.isEmpty ? 0 : geo.size.width / CGFloat(days.count)
                Canvas { ctx, size in
                    ctx.fill(Path(CGRect(x: 0, y: size.height - 1, width: size.width, height: 1)), with: .color(Color(nsColor: .separatorColor)))
                    guard !days.isEmpty, let maxN = days.map(\.n).max(), maxN > 0 else { return }
                    for (i, d) in days.enumerated() where d.n > 0 {
                        let h = max(2, CGFloat(d.n) / CGFloat(maxN) * (size.height - 1))
                        let before = split.map { d.d < $0 } ?? false
                        ctx.fill(Path(CGRect(x: CGFloat(i) * w, y: size.height - 1 - h, width: max(1, w - 1), height: h)),
                                 with: .color(Theme.err.swiftUI.opacity(before ? 0.35 : i == hover ? 1 : 0.75)))
                    }
                    if let split, let i = days.firstIndex(where: { $0.d >= split }) {
                        ctx.fill(Path(CGRect(x: CGFloat(i) * w - 1, y: 0, width: 1.5, height: size.height)), with: .color(.accentColor))
                    }
                }
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    if case .active(let p) = phase, w > 0, days.indices.contains(Int(p.x / w)) { hover = Int(p.x / w) } else { hover = nil }
                }
                .onTapGesture { p in
                    guard w > 0, let pick = onPick else { return }
                    let i = Int(p.x / w)
                    if days.indices.contains(i) { pick(days[i].d) }
                }
            }
            .frame(height: 64)
            HStack {
                Text(days.first.map { Self.label($0.d) } ?? "")
                Spacer()
                if let h = hover, days.indices.contains(h) {
                    Text(Self.label(days[h].d) + " · " + Formatters.count(days[h].n, "failure")).foregroundStyle(.primary)
                    Spacer()
                }
                Text(days.last.map { Self.label($0.d) } ?? "")
            }
            .font(Theme.fontSwiftUI(.metadata))
            .monospacedDigit()
            .foregroundStyle(.secondary)
        }
        .help(onPick == nil ? "" : "Click a day to split there")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.summary(days) + (split.map { ", split at \($0)" } ?? ""))
    }
}

/// A Recent episodes row (§3.4): mark, outcome, agent, the error line (tail ellipsis, full text in the tooltip) and
/// the age, on one line, like the web's.
private struct RecentEpisodeRow: View {
    let model: WindowModel
    let example: SignatureExample

    var body: some View {
        let (mark, color) = DerivedStyle.outcomeMark(example.outcome)
        HStack(spacing: 6) {
            Button {
                model.openEpisode(example.episodeId, reveal: false)
            } label: {
                PlainMark(mark: mark, text: DerivedStyle.outcomeWord(example.outcome.rawValue), color: color)
            }
            .buttonStyle(.plain)
            .help("Open this episode in " + model.store.title(of: example.sessionId))
            AgentName(agent: example.agent).foregroundStyle(.secondary).fixedSize()
            Text(example.errorLine ?? Formatters.missing)
                .font(Theme.fontSwiftUI(.code))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(example.errorLine ?? "No error line logged")
            Text(Formatters.relative(example.ts)).foregroundStyle(.secondary).monospacedDigit().fixedSize().help(Formatters.timestamp(example.ts))
        }
    }
}

// MARK: - Run

/// A session row or an alarm without an episode: the session's Run report.
struct RunPanel: View {
    let model: WindowModel
    let sessionID: String
    @State private var report: RunReport?
    @State private var error: APIError?

    var body: some View {
        ZStack {
            if let r = report {
                LensPane(model: model, kind: "Run", primary: LensAction(title: "Show in Session", help: "This run in Session · Steps") {
                    model.openSession(r.run.session, mode: .steps)
                }, secondary: [
                    LensAction(title: "Copy Report", help: "The run report as Markdown") {
                        guard let api = model.engine.api else { return }
                        Task { if let md = try? await api.runReportMarkdown(session: r.run.session, since: r.since) { AppKitHelpers.copy(md) } }
                    },
                ]) {
                    RunReportStrip(model: model, report: r).padding(.horizontal, -12)
                    if !r.alarms.isEmpty {
                        LensSection(title: "Alarms") {
                            ForEach(r.alarms) { a in
                                HStack(spacing: 6) {
                                    PlainMark(mark: .alarm, text: DerivedStyle.alarmWord(a.kind), color: a.state == .firing ? Theme.err : .secondaryLabelColor)
                                    Text(a.state.rawValue).foregroundStyle(.secondary)
                                    Text(Formatters.relative(a.lastTs)).foregroundStyle(.secondary)
                                    if a.episodeId != nil || a.delegationId != nil {
                                        Button("Open ›") { model.failures.openAlarm(a) }.buttonStyle(.link)
                                    }
                                }
                            }
                        }
                    }
                    LensSection(title: "Needs attention") {
                        if r.attention.isEmpty { Text("Nothing needs attention in this run.").foregroundStyle(.secondary) }
                        ForEach(r.attention, id: \.rowKey) { row in
                            HStack(spacing: 6) {
                                let (mark, color) = DerivedStyle.rowMark(row)
                                if let mark { Image(systemName: mark.symbol).foregroundStyle(color.swiftUI).accessibilityHidden(true) }
                                Button(row.signature ?? row.target ?? row.id) { model.failures.select(row) }.buttonStyle(.link).lineLimit(1)
                                Text(DerivedStyle.rowWord(row)).foregroundStyle(.secondary)
                            }
                        }
                    }
                    LensSection(title: "Gaps") { GapList(gaps: r.gaps) }
                }
            } else if let error {
                FailedStateView(title: "Could not load the run report", error: error) { Task { await load() } }
            } else {
                LoadingStateView(title: "Reading the run…")
            }
        }
        .task(id: sessionID) { await load() }
    }

    private func load() async {
        guard let api = model.engine.api else { return }
        do {
            report = try await api.runReport(session: sessionID, since: model.scope.from).payload
            error = nil
        } catch {
            self.error = error as? APIError ?? .unreachable(error)
        }
    }
}
