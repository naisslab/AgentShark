import AppKit
import SwiftUI

// MARK: - Ranking (ANALYSIS-UX §5.2; shared with the sidebar's Compare With ▸)

/// A run the chooser offers, and why it ranks where it does.
struct RankedRun: Hashable, Identifiable, Sendable {
    enum Match: Hashable, Sendable {
        /// The same title, ignoring case and spacing. Same title is not same task, so the tag never says so.
        case sameTitle
        /// The same project and working directory.
        case sameFolder
    }

    let row: SessionRow
    let match: Match?
    /// The run's agent is the current run's, and that set it above runs of its group by another agent.
    var sameAgent = false

    var id: String { row.id }

    /// "Same title", "Same folder", with "· same agent" where the agent set the order within the group.
    var tag: String? {
        let base: String
        switch match {
        case .sameTitle?: base = "Same title"
        case .sameFolder?: base = "Same folder"
        case nil: return nil
        }
        return sameAgent ? base + " · same agent" : base
    }
}

/// The order in which Compare offers a second run: runs with the same title first, then runs in the same folder, then
/// the rest. Within the first two groups a run by the current run's agent comes first, since a run by another agent
/// earns a "Different agents" caution; then each group is newest first. Only top-level runs other than the current one,
/// since Compare aligns two runs.
enum RunRanking {
    /// A title for matching: lowercased, with runs of white space as one space; nil for an empty title, which matches
    /// nothing.
    static func normalizedTitle(_ title: String?) -> String? {
        normalized(lowercased: title?.lowercased())
    }

    private static func normalized(lowercased title: String?) -> String? {
        let words = (title ?? "").split(whereSeparator: \.isWhitespace)
        return words.isEmpty ? nil : words.joined(separator: " ")
    }

    /// A top-level run the ranking can offer, its title, project and folder lowercased once: the catalog holds up to
    /// 20,000 sessions, and the chooser ranks on every keystroke (`index`).
    struct Candidate: Sendable {
        let row: SessionRow
        /// The title as `normalizedTitle` matches it.
        let title: String?
        /// The lowercased title, project and folder, which a search looks in.
        let fields: [String]
    }

    /// `rows` as candidates, top-level runs only, each listed once: what `rank` reads, which the chooser keeps while
    /// the catalog stays the same.
    static func index(_ rows: [SessionRow]) -> [Candidate] {
        var seen: Set<String> = []
        return rows.compactMap { row in
            guard row.parentId == nil, seen.insert(row.id).inserted else { return nil }
            let title = row.title?.lowercased()
            return Candidate(row: row, title: normalized(lowercased: title),
                             fields: [title, row.project?.lowercased(), row.cwd?.lowercased()].compactMap { $0 })
        }
    }

    /// Rank `candidates` against `current` (a run with id `currentID`, whose row may not be loaded), keeping those that
    /// match every word of `query` in their title, project or folder. Duplicates and subagents are left out; `limit`
    /// keeps the first ones (the sidebar's menu shows 8).
    static func rank(_ candidates: [SessionRow], current: SessionRow?, currentID: String, query: String = "", limit: Int? = nil) -> [RankedRun] {
        rank(index(candidates), current: current, currentID: currentID, query: query, limit: limit)
    }

    /// The same ranking over candidates `index` built once.
    static func rank(_ candidates: [Candidate], current: SessionRow?, currentID: String, query: String = "", limit: Int? = nil) -> [RankedRun] {
        let title = normalizedTitle(current?.title)
        let terms = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        var ranked: [RankedRun] = []
        for c in candidates where c.row.id != currentID {
            if !terms.isEmpty {
                guard terms.allSatisfy({ term in c.fields.contains { $0.contains(term) } }) else { continue }
            }
            let row = c.row
            let match: RankedRun.Match?
            if let title, c.title == title {
                match = .sameTitle
            } else if let current, sameFolder(row, current) {
                match = .sameFolder
            } else {
                match = nil
            }
            ranked.append(RankedRun(row: row, match: match))
        }
        func group(_ r: RankedRun) -> Int { r.match == .sameTitle ? 0 : r.match == .sameFolder ? 1 : 2 }
        // A group whose runs are of more than one agent puts the current run's agent first, and its tag says so.
        var agents: [Int: Set<AgentKind>] = [:]
        for r in ranked where r.match != nil { agents[group(r), default: []].insert(r.row.agent) }
        if let agent = current?.agent {
            for i in ranked.indices where ranked[i].match != nil && ranked[i].row.agent == agent && (agents[group(ranked[i])]?.count ?? 0) > 1 {
                ranked[i].sameAgent = true
            }
        }
        ranked.sort { x, y in
            if group(x) != group(y) { return group(x) < group(y) }
            if x.sameAgent != y.sameAgent { return x.sameAgent }
            let sx = x.row.start ?? .min, sy = y.row.start ?? .min
            return sx != sy ? sx > sy : x.row.id < y.row.id
        }
        return limit.map { Array(ranked.prefix($0)) } ?? ranked
    }

    /// "Port tests to vitest · Oct 22 09:15", with the agent when it is not the current run's: the sidebar's Compare
    /// With ▸ items (§3.4). An untitled run reads "Untitled · cx:0190a0…0001 · Oct 22 09:15".
    static func menuTitle(_ row: SessionRow, current: SessionRow?) -> String {
        var parts = [AnalysisVocabulary.runLabel(title: row.title, id: row.id)]
        if let start = row.start { parts.append(Formatters.shortDateTime(start)) }
        if let current, current.agent != row.agent { parts.append(row.agent.label) }
        return parts.joined(separator: " · ")
    }

    /// A chooser row's second line: "Oct 22 09:15 · 18m 04s · Codex · agentshark", led by the id when the run is
    /// untitled. The duration is the sidebar's (`RunDuration`): "—" for a run of one logged event, the row's tooltip
    /// saying why.
    static func detail(_ row: SessionRow) -> RunDetail {
        let short = AnalysisVocabulary.runID(title: row.title, id: row.id)
        var lead = [short].compactMap { $0 }
        if let start = row.start { lead.append(Formatters.shortDateTime(start)) }
        if let d = RunDuration(row) { lead.append(d.text) }
        let project = row.project.flatMap { $0.isEmpty ? nil : $0 }
        return RunDetail(lead: lead, agent: row.agent, trail: [project].compactMap { $0 }, id: short == nil ? nil : row.id)
    }

    private static func sameFolder(_ a: SessionRow, _ b: SessionRow) -> Bool {
        guard let cwd = a.cwd, !cwd.isEmpty else { return false }
        return cwd == b.cwd && a.project == b.project
    }
}

// MARK: - Chooser

/// "Compare {title} with…" (ANALYSIS-UX §5.2): the scope holds one top-level run, and this picks the other. The list
/// ranks the index's runs (`RunRanking`); ↑ and ↓ move from the search field, Return or a double-click compares, and
/// Esc clears the search. The index's own search by title adds same-title runs the catalog has not loaded.
struct RunChooser: View {
    @Bindable var model: WindowModel
    let current: String
    /// Why the chooser shows although two sessions are selected: "These are one run and its own subagent. …"
    var note: String?
    @State private var query = ""
    @State private var selection: String?
    @State private var searched: [SessionRow] = []
    /// The ranked runs, nil until first ranked. `rank()` ranks them again only when `rankKey` changes, so ↑ and ↓ never
    /// rank and a keystroke ranks once.
    @State private var ranked: [RankedRun]?
    /// The catalog's runs with their fields lowercased, and what they were built from: a keystroke ranks them without
    /// lowercasing every row again.
    @State private var index: (key: IndexKey, candidates: [RunRanking.Candidate])?
    /// The search `ranked` answers: a new search selects its first run.
    @State private var rankedQuery: String?
    @FocusState private var searchFocused: Bool

    private var metrics: Theme.Metrics { model.app.preferences.metrics }
    private var density: Preferences.RowDensity { model.app.preferences.rowDensity }
    /// The bordered list's frame above and below its rows.
    static let listBorder: CGFloat = 2

    private var currentRow: SessionRow? { model.sessionsByID[current] }

    /// What the ranking reads. The catalog's rows can arrive after the index run that announced them, so its labels
    /// generation counts as well as the index's.
    private struct RankKey: Equatable {
        var current: String
        var query: String
        var index: Int
        var labels: Int
        var searched: [String]
    }

    private var rankKey: RankKey {
        RankKey(current: current, query: query, index: model.store.indexGeneration, labels: model.store.sessionLabelsGeneration,
                searched: searched.map(\.id))
    }

    /// What the candidates are built from: the catalog's generations and the index's same-title runs.
    private struct IndexKey: Equatable {
        var index: Int
        var labels: Int
        var searched: [String]
    }

    var body: some View {
        // A readable column rather than rows a window wide: the chooser asks one question.
        VStack(alignment: .leading, spacing: 12) {
            header
            if let runs = ranked {
                if runs.isEmpty {
                    empty
                } else {
                    list(runs)
                }
            }
        }
        .frame(maxWidth: 760)
        .padding(.horizontal, 24)
        .padding(.top, 20)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { searchFocused = true }
        .onChange(of: rankKey, initial: true) { rank() }
        .task(id: "\(current)|\(model.store.indexGeneration)|\(model.engine.api != nil)") { await searchSameTitle() }
    }

    /// The catalog holds every session the sidebar lists, the recent and pinned ones included; the index's search adds
    /// same-title runs a catalog still loading lacks. A new search selects its first run, and so does a list that no
    /// longer holds the selected one.
    private func rank() {
        let key = IndexKey(index: model.store.indexGeneration, labels: model.store.sessionLabelsGeneration, searched: searched.map(\.id))
        let candidates: [RunRanking.Candidate]
        if let index, index.key == key {
            candidates = index.candidates
        } else {
            candidates = RunRanking.index(model.store.sessions + searched)
            index = (key, candidates)
        }
        let runs = RunRanking.rank(candidates, current: currentRow, currentID: current, query: query)
        ranked = runs
        if query != rankedQuery || !runs.contains(where: { $0.id == selection }) { selection = runs.first?.id }
        rankedQuery = query
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("Compare \(model.store.title(of: current)) with…")
                    .font(Theme.fontSwiftUI(.title, density))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(AnalysisVocabulary.runHelp(title: currentRow?.title, id: current))
                Spacer(minLength: 12)
                TextField("Search runs", text: $query, prompt: Text("Search by title, project or folder"))
                    .textFieldStyle(.roundedBorder)
                    .controlSize(metrics.swiftUIControlSize)
                    .frame(width: 260)
                    .focused($searchFocused)
                    .onKeyPress(.downArrow) { move(1) }
                    .onKeyPress(.upArrow) { move(-1) }
                    .onSubmit(compareSelected)
                    .onExitCommand { query = "" }
                    .accessibilityLabel("Search runs")
            }
            if let note {
                Label {
                    Text(note)
                } icon: {
                    Image(systemName: Mark.dataGap.symbol).foregroundStyle(.secondary)
                }
                .font(Theme.fontSwiftUI(.rowPrimary, density))
            }
            Text("Same title first, then same folder, the same agent's runs first in each; then the newest. Return or a double-click compares.")
                .font(Theme.fontSwiftUI(.rowSecondary, density))
                .foregroundStyle(.secondary)
        }
    }

    /// As tall as its rows up to the pane, past which it scrolls inside itself: the border never frames blank height
    /// (DESIGN.md §8.7). Each row is exactly a two-line list row (§4.3).
    private func list(_ runs: [RankedRun]) -> some View {
        List(runs, selection: $selection) { run in
            ChooserRow(run: run, density: density)
                .listRowInsets(EdgeInsets())
                .tag(run.id)
        }
        .listStyle(.bordered(alternatesRowBackgrounds: false))
        .frame(maxHeight: CGFloat(runs.count) * metrics.listRow + Self.listBorder)
        .contextMenu(forSelectionType: String.self) { ids in
            if let id = ids.first {
                Button("Compare With This Run") { model.compareRuns(current, id) }
                Button("Copy Run ID") { AppKitHelpers.copy(id) }
            }
        } primaryAction: { ids in
            if let id = ids.first { model.compareRuns(current, id) }
        }
        .onKeyPress(.return) {
            compareSelected()
            return .handled
        }
        .accessibilityLabel("Runs to compare with")
    }

    @ViewBuilder private var empty: some View {
        if query.isEmpty {
            ContentUnavailableView("No other runs", systemImage: SessionMode.compare.symbol,
                                   description: Text("The index has no other top-level run to compare with."))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView {
                Label("No run matches “\(query)”", systemImage: "magnifyingglass")
            } description: {
                Text("The search looks in titles, projects and folders.")
            } actions: {
                Button("Clear Search") { query = "" }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func move(_ step: Int) -> KeyPress.Result {
        let ids = (ranked ?? []).map(\.id)
        guard !ids.isEmpty else { return .ignored }
        let i = selection.flatMap(ids.firstIndex(of:)) ?? (step > 0 ? -1 : ids.count)
        selection = ids[max(0, min(ids.count - 1, i + step))]
        return .handled
    }

    private func compareSelected() {
        guard let id = selection ?? ranked?.first?.id else { return NSSound.beep() }
        model.compareRuns(current, id)
    }

    /// `GET /api/sessions?role=main&q={title}&limit=50`: same-title runs the catalog may not hold yet.
    private func searchSameTitle() async {
        guard let api = model.engine.api, let title = currentRow?.title, !title.isEmpty else { return }
        if let list = try? await api.sessions(query: title, role: "main", limit: 50) { searched = list.sessions }
    }
}

/// A chooser row (two-line list row, DESIGN.md §4.3): the title in the system font ("Untitled" without one) with its
/// "Same title" or "Same folder" tag, then "Oct 22 09:15 · 18m 04s · ● Codex · agentshark".
private struct ChooserRow: View {
    let run: RankedRun
    let density: Preferences.RowDensity

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(AnalysisVocabulary.runName(title: run.row.title))
                    .font(Theme.fontSwiftUI(.queuePrimary, density))
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let tag = run.tag {
                    Text(tag)
                        .font(Theme.fontSwiftUI(.metadata, density))
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
            }
            RunDetailLine(detail: RunRanking.detail(run.row))
                .font(Theme.fontSwiftUI(.rowSecondary, density))
                .foregroundStyle(.secondary)
        }
        // The bordered list insets its rows by 6 pt itself, so the text sits 12 pt in (DESIGN.md §4.2 queue row).
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: Theme.metrics(density).listRow)
        .help(AnalysisVocabulary.runHelp(title: run.row.title, id: run.row.id) + (RunDuration(run.row)?.help.map { "\n" + $0 } ?? ""))
        .accessibilityElement(children: .combine)
        .accessibilityLabel([AnalysisVocabulary.runName(title: run.row.title), run.tag, RunRanking.detail(run.row).text].compactMap { $0 }
            .joined(separator: ", "))
    }
}
