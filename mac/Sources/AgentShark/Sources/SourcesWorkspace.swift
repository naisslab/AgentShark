import SwiftUI

/// The logging-health report per engine. It is slow to build (tens of seconds on a large history), so it survives
/// workspace switches and reloads only on Refresh.
@MainActor enum SourcesReportCache {
    private static var entries: [(store: WeakStore, request: PanelRequest<SourcesResult>)] = []

    private struct WeakStore {
        weak var value: EngineStore?
    }

    static func request(for store: EngineStore) -> PanelRequest<SourcesResult> {
        entries.removeAll { $0.store.value == nil }
        if let e = entries.first(where: { $0.store.value === store }) { return e.request }
        let r = PanelRequest<SourcesResult>()
        entries.append((WeakStore(value: store), r))
        return r
    }
}

/// Sources: the logging-health report (SPEC §8). It answers "am I logging correctly?": the most important finding
/// first, the capability matrix, one section per agent, then every source file. It ignores the investigation scope.
struct SourcesWorkspace: View {
    @Bindable var model: WindowModel

    private var request: PanelRequest<SourcesResult> { SourcesReportCache.request(for: model.store) }

    var body: some View {
        VStack(spacing: 0) {
            // The workspace header (DESIGN.md §7.3): the logging-health report ignores the investigation scope.
            WorkspaceHeader(model: model, label: model.scopeLabel(for: .sources)) {
                if model.isCapture {
                    Picker("Report", selection: $model.sourcesShowLocal) {
                        Text("Captured Evidence").tag(false)
                        Text("This Mac").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .help("Captured Evidence describes only what the capture contains; This Mac checks this Mac's own agents and settings")
                }
            } controls: {
                if let at = request.loadedAt, !request.isLoading {
                    Text("Checked \(Formatters.relative(Int64(at.timeIntervalSince1970 * 1e6)))")
                        .font(Theme.fontSwiftUI(.metadata))
                        .foregroundStyle(.secondary)
                        .help("The report was built at \(Formatters.timestamp(Int64(at.timeIntervalSince1970 * 1e6)))")
                }
                Button("Refresh") {
                    request.load(key: reportKey, force: true, fetch)
                }
                .disabled(request.isLoading)
                .help("Check every agent's logs again")
                if !model.isCapture {
                    Button("Export Capture Now…") { model.presentedSheet = .exportCapture }
                        .help("Save sessions to a self-contained .agentcap file that survives the agents' log cleanup")
                }
            }
            PanelKit.RequestView(request: request, loadingTitle: "Checking every agent's logs… This can take a minute on a large history.",
                                 failureTitle: "Could not build the logging-health report") { report in
                PanelKit.SplitView(autosaveName: "AgentShark.Sources.Split", firstMinimum: 180, secondMinimum: 140,
                                   initialFraction: 0.62,
                                   first: SourcesReportView(model: model, report: report),
                                   second: SourceFilesTable(sources: report.sources))
            }
        }
        .task(id: reportKey) {
            request.load(key: reportKey, fetch)
        }
    }

    private var reportKey: String { model.isCapture && model.sourcesShowLocal ? "local" : "report" }

    private var fetch: @MainActor () async throws -> SourcesResult {
        { [model] in try await model.panelAPI().sources(local: model.isCapture && model.sourcesShowLocal) }
    }
}

// MARK: - Report

private let severityRank = ["error": 0, "warn": 1, "note": 2, "chat": 3]

/// Capability order and names (`Capability` in src/model/types.ts).
private let capabilityNames: [(id: String, name: String)] = [
    ("timestamps", "Timestamps"), ("llm-latency", "Model-call latency"), ("ttft", "Time to first token"),
    ("tool-durations", "Tool durations"), ("exit-codes", "Exit codes"), ("token-usage", "Token usage"),
    ("cache-tokens", "Cache tokens"), ("reasoning-text", "Reasoning text"), ("system-prompt", "System prompt"),
    ("tool-definitions", "Tool definitions"), ("subagent-tree", "Subagent tree"), ("file-diffs", "File diffs and backups"),
    ("cost", "Cost"), ("raw-http", "Raw HTTP"), ("permission-decisions", "Permission decisions"),
]

/// Chip words are lowercase, as every chip is (and as on the web).
private let levelInfo: [(level: String, name: String, meaning: String)] = [
    ("logged", "logged", "The agent writes this value"),
    ("derived", "derived", "AgentShark computes it from other logged fields"),
    ("partial", "partial", "Present for some records only"),
    ("absent", "absent", "Not in the logs"),
]

private func levelColor(_ level: String) -> Color {
    switch level {
    case "logged": return Theme.ok.swiftUI
    case "derived": return Theme.note.swiftUI
    case "partial": return Theme.warn.swiftUI
    default: return .secondary
    }
}

private func agentName(_ a: HealthReport) -> String {
    a.label.isEmpty ? PanelKit.agentLabel(a.agent) : a.label
}

private struct SourcesReportView: View {
    let model: WindowModel
    let report: SourcesResult

    private var agents: [HealthReport] {
        func worst(_ a: HealthReport) -> Int { a.findings.map { severityRank[$0.severity] ?? 9 }.min() ?? 9 }
        return report.agents.sorted {
            ($0.detected ? 0 : 1, worst($0), -$0.files) < ($1.detected ? 0 : 1, worst($1), -$1.files)
        }
    }

    private var findings: [(agent: HealthReport, finding: HealthReport.Finding)] {
        agents.flatMap { a in a.findings.map { (a, $0) } }
            .sorted { (severityRank[$0.finding.severity] ?? 9) < (severityRank[$1.finding.severity] ?? 9) }
    }

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    overview(scroller)
                    if model.isCapture { captureNote }
                    capabilityMatrix
                    ForEach(agents.filter(\.detected)) { a in
                        AgentHealthSection(model: model, agent: a).id(a.agent)
                    }
                    notFound
                }
                .padding(20)
                .frame(maxWidth: 1100, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollShadows()
        }
    }

    // MARK: Overview: the verdict and the most important findings first

    private func overview(_ scroller: ScrollViewProxy) -> some View {
        let detected = agents.filter(\.detected)
        let errors = findings.filter { $0.finding.severity == "error" }.count
        let warnings = findings.filter { $0.finding.severity == "warn" }.count
        let top = findings.prefix(5)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: errors > 0 ? "xmark.octagon.fill" : warnings > 0 ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                    .foregroundStyle(errors > 0 ? Theme.err.swiftUI : warnings > 0 ? Theme.warn.swiftUI : Theme.ok.swiftUI)
                    .font(.title2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verdict(errors: errors, warnings: warnings)).font(.title3.weight(.semibold))
                    Text("\(detected.count) of \(agents.count) agents found · \(Formatters.count(detected.reduce(0) { $0 + $1.files }, "file")) · \(Formatters.bytes(detected.reduce(0) { $0 + $1.bytes }))")
                        .foregroundStyle(.secondary)
                }
            }
            if !top.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(top.enumerated()), id: \.offset) { _, f in
                        Button {
                            withAnimation { scroller.scrollTo(f.agent.agent, anchor: .top) }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: Symbols.severity(f.finding.severity))
                                    .foregroundStyle(Theme.severityColor(f.finding.severity).swiftUI)
                                    .frame(width: 16)
                                Text(agentName(f.agent)).foregroundStyle(.secondary).frame(width: 110, alignment: .leading)
                                Text(f.finding.title).foregroundStyle(.primary).lineLimit(1)
                            }
                        }
                        .buttonStyle(.plain)
                        .help("Show this finding in the \(agentName(f.agent)) section")
                        .accessibilityLabel("\(Severity.label(f.finding.severity)): \(agentName(f.agent)), \(f.finding.title)")
                    }
                    if findings.count > top.count {
                        Text("\(findings.count - top.count) more findings in the agent sections below.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 34)
            }
        }
    }

    private func verdict(errors: Int, warnings: Int) -> String {
        guard errors + warnings > 0 else { return "Logging looks healthy" }
        let parts = [errors > 0 ? Formatters.count(errors, "error") : nil, warnings > 0 ? Formatters.count(warnings, "warning") : nil]
        return "Needs attention: " + parts.compactMap { $0 }.joined(separator: ", ")
    }

    /// Which machine the report describes (SPEC §8): the captured evidence, or this Mac on request.
    private var captureNote: some View {
        Label {
            Text(captureNoteText).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: report.isCaptured ? "shippingbox" : "desktopcomputer").foregroundStyle(.secondary)
        }
        .font(.callout)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 7).fill(.quinary))
    }

    private var captureNoteText: String {
        guard report.isCaptured else {
            return "This Mac's logging health\(report.host.map { " (\($0))" } ?? ""). It describes the agents, settings and index on this Mac, not the machine that wrote the capture."
        }
        var origin = "Captured evidence"
        if let host = report.host { origin += " from \(host)" }
        if let at = report.capturedAt { origin += ", written \(Formatters.timestamp(at))" }
        return origin + ". The inventory, capabilities and findings describe only what the capture contains; nothing on this Mac is read."
    }

    // MARK: Capability matrix: capabilities × detected agents

    @ViewBuilder private var capabilityMatrix: some View {
        let detected = agents.filter { $0.detected && !$0.capabilities.isEmpty }
        if !detected.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Capability Matrix").font(.headline)
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
                        GridRow {
                            Text("Capability").foregroundStyle(.secondary)
                            ForEach(detected) { a in Text(agentName(a)).fontWeight(.medium).lineLimit(1) }
                        }
                        .font(.callout)
                        Divider().gridCellUnsizedAxes(.horizontal)
                        ForEach(rows(for: detected), id: \.id) { cap in
                            GridRow {
                                Text(cap.name)
                                ForEach(detected) { a in
                                    if let c = a.capabilities.first(where: { $0.capability == cap.id }) {
                                        LevelChip(level: c.level)
                                            .help("\(agentName(a)) · \(cap.name): \(c.level). \(c.note)")
                                            .accessibilityLabel("\(cap.name), \(agentName(a)): \(c.level). \(c.note)")
                                    } else {
                                        Text(Formatters.missing).foregroundStyle(.tertiary).help("Not reported for \(agentName(a))")
                                    }
                                }
                            }
                        }
                    }
                    .padding(.bottom, 4)
                }
                HStack(spacing: 14) {
                    ForEach(levelInfo, id: \.level) { l in
                        HStack(spacing: 5) {
                            LevelChip(level: l.level)
                            Text(l.meaning).foregroundStyle(.secondary)
                        }
                    }
                }
                .font(.caption)
                Text("Hover a level to see how it was measured on this machine.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func rows(for agents: [HealthReport]) -> [(id: String, name: String)] {
        let known = Set(capabilityNames.map(\.id))
        let extra = Set(agents.flatMap { $0.capabilities.map(\.capability) }).subtracting(known).sorted()
        return capabilityNames + extra.map { ($0, $0) }
    }

    // MARK: Agents not found

    @ViewBuilder private var notFound: some View {
        let missing = agents.filter { !$0.detected }
        if !missing.isEmpty {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(missing) { a in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(agentName(a)).fontWeight(.medium)
                            if let f = a.findings.first { Text(f.detail).foregroundStyle(.secondary) }
                            if !a.roots.isEmpty {
                                Text("Looked in " + a.roots.joined(separator: ", "))
                                    .font(Theme.fontSwiftUI(.code))
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
                .padding(.top, 6)
            } label: {
                Text("Not Found on This Mac (\(missing.count))").font(.headline)
            }
        }
    }
}

/// A capability level as a chip: symbol plus word, so color is never the only cue.
private struct LevelChip: View {
    let level: String

    var body: some View {
        PanelKit.Chip(text: levelInfo.first { $0.level == level }?.name ?? level, symbol: Symbols.capabilityLevel(level),
                      color: levelColor(level))
    }
}

// MARK: - One agent

private struct AgentHealthSection: View {
    let model: WindowModel
    let agent: HealthReport

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            inventory
            if !agent.roots.isEmpty { roots }
            if !agent.findings.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(sortedFindings.enumerated()), id: \.offset) { _, f in
                        FindingView(model: model, finding: f)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 9).fill(.background.secondary))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color(nsColor: .separatorColor)))
    }

    private var sortedFindings: [HealthReport.Finding] {
        agent.findings.sorted { (severityRank[$0.severity] ?? 9) < (severityRank[$1.severity] ?? 9) }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: Symbols.agent(AgentKind(rawValue: agent.agent)))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Theme.agentColor(AgentKind(rawValue: agent.agent)).swiftUI)
            Text(agentName(agent)).font(.title3.weight(.semibold))
            PanelKit.Chip(text: agent.parsed ? "Parsed" : "Not parsed", symbol: agent.parsed ? "checkmark" : "exclamationmark.triangle",
                          color: agent.parsed ? Theme.ok.swiftUI : Theme.warn.swiftUI)
                .help(agent.parsed ? "AgentShark reads these logs" : "Found on this Mac, but AgentShark cannot read these logs")
            Spacer()
            ForEach(["error", "warn"], id: \.self) { sev in
                let n = agent.findings.filter { $0.severity == sev }.count
                if n > 0 {
                    PanelKit.Chip(text: Formatters.count(n, Severity.label(sev).lowercased()), symbol: Symbols.severity(sev),
                                  color: Theme.severityColor(sev).swiftUI)
                }
            }
        }
    }

    private var inventory: some View {
        let p = agent.parse
        let versions = agent.versions
        let range = agent.firstTs.flatMap { f in agent.lastTs.map { Formatters.timeRange(from: f, to: $0) } } ?? Formatters.missing
        return Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 4) {
            GridRow {
                fact("Files", Formatters.count(agent.files))
                fact("Size", Formatters.bytes(agent.bytes), help: Formatters.count(Int(agent.bytes)) + " bytes")
                fact("Lines", Formatters.count(p.lines))
                fact("Malformed", Formatters.count(p.malformed), warn: p.malformed > 0, help: "Lines that are not valid JSON")
                fact("Unknown", Formatters.count(p.unknown), warn: p.unknown > 0, help: "Records kept as raw.unknown")
            }
            GridRow {
                fact("Skipped", Formatters.count(p.skipped), help: "Records skipped on purpose because they duplicate another source")
                fact("Inherited", Formatters.count(p.inherited), help: "Records copied from a parent or resumed session")
                fact("Versions", versions.isEmpty ? Formatters.missing
                        : versions.prefix(3).joined(separator: ", ") + (versions.count > 3 ? " +\(versions.count - 3)" : ""),
                     help: versions.joined(separator: ", "))
                    .gridCellColumns(3)
            }
            GridRow {
                fact("Date range", range).gridCellColumns(5)
            }
        }
    }

    private func fact(_ label: String, _ value: String, warn: Bool = false, help: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .monospacedDigit()
                .foregroundStyle(warn ? Theme.warn.swiftUI : .primary)
                .textSelection(.enabled)
        }
        .help(help ?? value)
        .accessibilityElement(children: .combine)
    }

    private var roots: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(agent.roots, id: \.self) { root in
                HStack(spacing: 6) {
                    Text(root)
                        .font(Theme.fontSwiftUI(.code))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                    Button {
                        AppKitHelpers.revealInFinder(root)
                    } label: {
                        Image(systemName: "arrow.right.circle")
                    }
                    .buttonStyle(.borderless)
                    .iconHelp("Reveal \(root) in Finder")
                }
            }
        }
    }
}

// MARK: - One finding

private struct FindingView: View {
    let model: WindowModel
    let finding: HealthReport.Finding

    var body: some View {
        let rec = finding.recommendation.map(Recommendation.init)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: Symbols.severity(finding.severity))
                .foregroundStyle(Theme.severityColor(finding.severity).swiftUI)
                .accessibilityLabel(Severity.label(finding.severity))
            VStack(alignment: .leading, spacing: 6) {
                Text(finding.title).fontWeight(.semibold)
                if !finding.detail.isEmpty {
                    Text(finding.detail).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                if let rec { RecommendationView(model: model, recommendation: rec) }
            }
        }
    }
}

private struct RecommendationView: View {
    let model: WindowModel
    let recommendation: Recommendation

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Recommendation").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                if let effect = recommendation.effect {
                    Label(effect, systemImage: effect == Recommendation.externalCollectorEffect ? "arrow.up.forward.app" : "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .help("What following this recommendation changes")
                }
            }
            ForEach(Array(recommendation.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let text):
                    Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                case .code(let label, let text):
                    PanelKit.CodeBlock(text: text, label: label)
                }
            }
            if !recommendation.configFiles.isEmpty || (recommendation.suggestsCapture && !model.isCapture) {
                HStack(spacing: 8) {
                    ForEach(recommendation.configFiles, id: \.self) { path in
                        Button("Reveal \((path as NSString).lastPathComponent) in Finder") {
                            AppKitHelpers.revealInFinder((path as NSString).expandingTildeInPath)
                        }
                        .help("Show \(path) in Finder. If it does not exist yet, its folder opens.")
                    }
                    if recommendation.suggestsCapture && !model.isCapture {
                        Button("Export Capture Now…") { model.presentedSheet = .exportCapture }
                    }
                }
                .controlSize(.small)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 7).fill(.quinary))
    }
}
