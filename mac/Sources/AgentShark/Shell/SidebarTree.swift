import Foundation

/// One row of the sidebar's source list.
final class SidebarItem: NSObject {
    enum Kind: Equatable { case section, allSessions, project, session }

    let kind: Kind
    /// Stable key for expansion state: `section:live`, `agent:codex`, `project:codex/AgentShark`, `tree:<id>`.
    let key: String
    var title: String
    var session: SessionRow? { didSet { sessionID = session?.id } }
    /// `session?.id`, stored: reading it through the optional row copied the whole row.
    private(set) var sessionID: String?
    var agent: AgentKind?
    var count = 0
    /// In the Live section: shows a pulsing dot.
    var isLive = false
    /// Direct subagents in the catalog (the engine's `nChildren` is not always filled in).
    var subagents = 0
    var children: [SidebarItem] = []
    weak var parent: SidebarItem?

    init(kind: Kind, key: String, title: String) {
        self.kind = kind
        self.key = key
        self.title = title
    }


    /// A rebuilt tree merged into the tree on screen.
    struct Reconciled {
        var items: [SidebarItem] = []
        /// Parents whose children changed (added, removed or reordered); nil is the top level.
        var changed: [SidebarItem?] = []
        /// Rows on screen whose content changed.
        var updated: [SidebarItem] = []
    }

    /// Merge a rebuilt tree into the current one. Every row whose key is still under the same parent keeps its object,
    /// with the new content, so the outline keeps its row view, disclosure button and expansion; only the parents in
    /// `changed` need their children reloaded.
    static func reconcile(_ old: [SidebarItem], _ new: [SidebarItem]) -> Reconciled {
        var r = Reconciled()
        r.items = merge(old, new, parent: nil, into: &r)
        return r
    }

    private static func merge(_ old: [SidebarItem], _ new: [SidebarItem], parent: SidebarItem?, into r: inout Reconciled) -> [SidebarItem] {
        // Most levels keep their rows in the same order: pair those up without hashing every key.
        let inOrder = old.count == new.count && zip(old, new).allSatisfy { $0.key == $1.key }
        var byKey: [String: SidebarItem] = [:]
        if !inOrder { for o in old where byKey[o.key] == nil { byKey[o.key] = o } }
        let merged = new.indices.map { i -> SidebarItem in
            let n = new[i]
            guard let o = inOrder ? old[i] : byKey.removeValue(forKey: n.key), o.kind == n.kind else { return n }
            if o.title != n.title || o.session != n.session || o.agent != n.agent || o.count != n.count || o.isLive != n.isLive
                || o.subagents != n.subagents {
                o.title = n.title
                o.session = n.session
                o.agent = n.agent
                o.count = n.count
                o.isLive = n.isLive
                o.subagents = n.subagents
                r.updated.append(o)
            }
            o.children = merge(o.children, n.children, parent: o, into: &r)
            return o
        }
        for m in merged { m.parent = parent }
        if !merged.elementsEqual(old, by: ===) { r.changed.append(parent) }
        return merged
    }
}

/// The sidebar's list filters. They filter the list only and never change the investigation scope
/// (SPEC §7.8 "Session-list filters are not scope").
struct SidebarListFilter: Equatable {
    enum ActiveWithin: String, CaseIterable, Identifiable {
        case any, hour, day, week, month

        var id: String { rawValue }

        var title: String {
            switch self {
            case .any: return "Any Time"
            case .hour: return "Last Hour"
            case .day: return "Last 24 Hours"
            case .week: return "Last 7 Days"
            case .month: return "Last 30 Days"
            }
        }

        var seconds: TimeInterval? {
            switch self {
            case .any: return nil
            case .hour: return 3600
            case .day: return 86400
            case .week: return 7 * 86400
            case .month: return 30 * 86400
            }
        }

        /// "in the last 24 hours" for empty-list messages.
        var phrase: String { title.replacingOccurrences(of: "Last", with: "in the last").lowercased() }
    }

    var query = ""
    var hiddenAgents: Set<String> = []
    var activeWithin: ActiveWithin = .any

    var isActive: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty || !hiddenAgents.isEmpty || activeWithin != .any }
}

/// Builds the sidebar tree: All Sessions, Live, Pinned, Recent, then one section per agent with its projects,
/// root sessions and nested subagents.
enum SidebarTreeBuilder {
    static let liveWindow: TimeInterval = 600
    static let recentShown = 8

    struct Result {
        var items: [SidebarItem]
        /// Sessions that pass the list filters (before nesting context is added).
        var matching: Int
        var total: Int
    }

    static func build(sessions: [SessionRow], byID: [String: SessionRow], childrenByParent: [String: [String]], pinned: [String],
                      recent: [String], filter: SidebarListFilter, now: Date = Date()) -> Result {
        let q = filter.query.trimmingCharacters(in: .whitespaces)
        let cutoff = filter.activeWithin.seconds.map { Int64((now.timeIntervalSince1970 - $0) * 1e6) }
        func has(_ text: String?) -> Bool { text?.range(of: q, options: .caseInsensitive) != nil }
        func passes(_ s: SessionRow) -> Bool {
            if filter.hiddenAgents.contains(s.agent.rawValue) { return false }
            if let cutoff, (s.lastActivity ?? 0) < cutoff { return false }
            guard !q.isEmpty else { return true }
            return has(s.title) || has(s.project) || has(s.id) || has(s.cwd) || has(s.gitBranch) || s.models.contains(where: has)
        }

        // Matching sessions plus their ancestors, so a matching subagent shows under its parent.
        var visible = Set<String>()
        var matching = 0
        for s in sessions where passes(s) {
            matching += 1
            visible.insert(s.id)
            var p = s.parentId
            while let id = p, byID[id] != nil, visible.insert(id).inserted { p = byID[id]?.parentId }
        }

        var items: [SidebarItem] = []
        let all = SidebarItem(kind: .allSessions, key: "all", title: "All Sessions")
        all.count = sessions.count
        items.append(all)

        func flatSection(_ key: String, _ title: String, _ ids: [String], live: Bool) {
            let rows = ids.compactMap { byID[$0] }.filter { visible.contains($0.id) && passes($0) }
            guard !rows.isEmpty else { return }
            let section = SidebarItem(kind: .section, key: "section:\(key)", title: title)
            section.children = rows.map { s in
                let item = sessionItem(s, key: "\(key):\(s.id)", children: childrenByParent[s.id]?.count ?? 0)
                item.isLive = live
                item.parent = section
                return item
            }
            section.count = rows.count
            items.append(section)
        }

        flatSection("live", "Live", liveIDs(sessions, now: now), live: true)
        flatSection("pinned", "Pinned", pinned, live: false)
        flatSection("recent", "Recent", Array(recent.filter { !pinned.contains($0) }.prefix(recentShown)), live: false)

        // Agent → project → root sessions (most recent first) → subagents (in start order).
        var byAgent: [AgentKind: [String: [SessionRow]]] = [:]
        for s in sessions where visible.contains(s.id) {
            let isRoot = s.parentId.map { !visible.contains($0) } ?? true
            guard isRoot else { continue }
            byAgent[s.agent, default: [:]][s.project ?? "(No Project)", default: []].append(s)
        }
        func subtree(_ s: SessionRow) -> SidebarItem {
            let item = sessionItem(s, key: "tree:\(s.id)", children: childrenByParent[s.id]?.count ?? 0)
            item.children = (childrenByParent[s.id] ?? []).compactMap { byID[$0] }.filter { visible.contains($0.id) }
                .sorted { ($0.start ?? 0, $0.id) < ($1.start ?? 0, $1.id) }
                .map { c in
                    let child = subtree(c)
                    child.parent = item
                    return child
                }
            return item
        }
        let agentOrder = AgentKind.known + byAgent.keys.filter { !AgentKind.known.contains($0) }.sorted()
        for agent in agentOrder {
            guard let projects = byAgent[agent] else { continue }
            let section = SidebarItem(kind: .section, key: "agent:\(agent.rawValue)", title: agent.label)
            section.agent = agent
            // Projects in order of their most recent session.
            let ordered = projects.map { name, rows in (name, rows, rows.map { $0.lastActivity ?? 0 }.max() ?? 0) }
                .sorted { ($0.2, $0.0) > ($1.2, $1.0) }
            for (name, rows, _) in ordered {
                let project = SidebarItem(kind: .project, key: "project:\(agent.rawValue)/\(name)", title: name)
                project.agent = agent
                project.count = rows.count
                project.parent = section
                project.children = rows.map { s in
                    let item = subtree(s)
                    item.parent = project
                    return item
                }
                section.children.append(project)
                section.count += rows.count
            }
            items.append(section)
        }
        return Result(items: items, matching: matching, total: sessions.count)
    }

    /// The root sessions active within `liveWindow`, in list order: the Live section before the list filters.
    static func liveIDs(_ sessions: [SessionRow], now: Date = Date()) -> [String] {
        let cutoff = Int64((now.timeIntervalSince1970 - liveWindow) * 1e6)
        return sessions.lazy.filter { $0.parentId == nil && ($0.lastActivity ?? 0) >= cutoff }.map(\.id)
    }

    private static func sessionItem(_ s: SessionRow, key: String, children: Int) -> SidebarItem {
        let item = SidebarItem(kind: .session, key: key, title: s.displayTitle)
        item.session = s
        item.agent = s.agent
        item.subagents = max(s.nChildren, children)
        return item
    }

    /// Why a filtered list is empty, in words ("No sessions active in the last 24 hours.").
    static func emptyReason(_ filter: SidebarListFilter) -> String {
        var parts: [String] = []
        let q = filter.query.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { parts.append("matching “\(q)”") }
        if filter.activeWithin != .any { parts.append("active \(filter.activeWithin.phrase)") }
        if !filter.hiddenAgents.isEmpty, parts.isEmpty { return "Every agent with sessions is hidden from the list." }
        return parts.isEmpty ? "No sessions indexed yet." : "No sessions " + parts.joined(separator: " and ") + "."
    }
}
