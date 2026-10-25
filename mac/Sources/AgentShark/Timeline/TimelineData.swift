import Foundation

/// Engine requests shared by the timeline, the track strip and the flow diagram. Session details and the overview
/// are cached per engine and index generation, so switching workspaces does not refetch them.
@MainActor enum TimelineData {
    /// The deepest tree the session timeline lays out.
    static let maxTreeSessions = 300
    /// Spans per request; past this the engine keeps the longest ones (level of detail).
    static let spanLimit = 20_000

    // MARK: Cache

    private static var cacheKey = ""
    private static var details: [String: SessionDetail] = [:]
    private static var overviewSessions: [OverviewSession]?

    private static func cache(_ api: APIClient, generation: Int) {
        let key = "\(api.endpoint.baseURL.absoluteString)#\(generation)"
        if key != cacheKey {
            cacheKey = key
            details = [:]
            overviewSessions = nil
        }
    }

    static func sessionDetail(_ id: String, api: APIClient, generation: Int) async throws -> SessionDetail {
        cache(api, generation: generation)
        if let d = details[id] { return d }
        let d = try await api.session(id)
        cache(api, generation: generation)
        if details.count > 400 { details.removeAll() }
        details[id] = d
        return d
    }

    /// Details of `ids` from the cache, the rest fetched side by side. The requests run off the main actor and the
    /// cache is read and written here: a group of main-actor child tasks came back empty in release builds.
    private static func sessionDetails(_ ids: [String], api: APIClient, generation: Int) async -> [String: Result<SessionDetail, Error>] {
        cache(api, generation: generation)
        var out: [String: Result<SessionDetail, Error>] = [:]
        for id in ids { if let d = details[id] { out[id] = .success(d) } }
        let missing = ids.filter { out[$0] == nil }
        let fetched = await withTaskGroup(of: (String, Result<SessionDetail, Error>).self) { group in
            for id in missing {
                group.addTask {
                    do { return (id, .success(try await api.session(id))) } catch { return (id, .failure(error)) }
                }
            }
            var got: [(String, Result<SessionDetail, Error>)] = []
            for await r in group { got.append(r) }
            return got
        }
        cache(api, generation: generation)
        if details.count + fetched.count > 400 { details.removeAll() }
        for (id, r) in fetched {
            if case .success(let d) = r { details[id] = d }
            out[id] = r
        }
        return out
    }

    /// Every session with a start time, for the overview.
    static func overview(api: APIClient, generation: Int) async throws -> [OverviewSession] {
        cache(api, generation: generation)
        if let o = overviewSessions { return o }
        let o = try await api.overview().filter { $0.start != nil }
        cache(api, generation: generation)
        overviewSessions = o
        return o
    }

    // MARK: Session tree

    /// The scoped sessions and their descendants in display order: each session followed by its children by
    /// start time. Only sessions with children are fetched; leaf children come from their parent's list.
    /// Stops at `maxTreeSessions`; `truncated` says so.
    static func sessionTree(roots ids: [String], api: APIClient, generation: Int) async throws -> (nodes: [TimelineNode], truncated: Bool) {
        var rows: [String: SessionRow] = [:]
        var order: [String] = []
        var unique: Set<String> = []
        var level = ids.filter { unique.insert($0).inserted }
        var firstError: Error?
        var truncated = false
        while !level.isEmpty {
            let fetched = await sessionDetails(level, api: api, generation: generation)
            var next: [String] = []
            for id in level {
                switch fetched[id] {
                case .success(let d)?:
                    if rows[id] == nil { order.append(id) }
                    rows[id] = d.session.row
                    for c in d.children where rows[c.id] == nil {
                        guard rows.count < maxTreeSessions else {
                            truncated = true
                            break
                        }
                        rows[c.id] = c
                        order.append(c.id)
                        if c.nChildren > 0 { next.append(c.id) }
                    }
                case .failure(let e)?:
                    firstError = firstError ?? e
                case nil:
                    break
                }
            }
            level = rows.count < maxTreeSessions ? next : []
            if !next.isEmpty && rows.count >= maxTreeSessions { truncated = true }
        }
        // Every requested root failed: report it rather than drawing nothing.
        if rows.isEmpty, let firstError { throw firstError }

        var kids: [String: [SessionRow]] = [:]
        for id in order {
            guard let s = rows[id], let p = s.parentId, p != s.id, rows[p] != nil else { continue }
            kids[p, default: []].append(s)
        }
        var out: [TimelineNode] = []
        var seen: Set<String> = []
        func visit(_ s: SessionRow, _ depth: Int) {
            guard seen.insert(s.id).inserted else { return }
            let children = (kids[s.id] ?? []).sorted { ($0.start ?? 0, $0.id) < ($1.start ?? 0, $1.id) }
            out.append(TimelineNode(session: s, depth: depth))
            for c in children { visit(c, depth + 1) }
        }
        for id in ids {
            guard let s = rows[id] else { continue }
            if let p = s.parentId, rows[p] != nil, ids.contains(p) { continue }
            visit(s, 0)
        }
        for id in order { if let s = rows[id] { visit(s, 0) } }
        return (out, truncated)
    }

    // MARK: Density

    /// What a view density was requested for. Each request reads every event of the view, whose events change only
    /// when the view is rebuilt under a new id, while a live index run stretches a fitted range by seconds: a range
    /// within 1% of the loaded one keeps the density. Requesting it again on every index run was most of the engine's
    /// CPU while an agent worked.
    struct DensityKey {
        var view: String
        var width: Int
        var gaps: [TimeGap]
        var from: Double
        var to: Double

        func serves(_ wanted: DensityKey) -> Bool {
            view == wanted.view && width == wanted.width && gaps == wanted.gaps
                && abs(from - wanted.from) + abs(to - wanted.to) <= 0.01 * (to - from)
        }
    }

    /// Event counts of a view across [from, to] of `scale`. Each uncollapsed segment gets its own request so busy
    /// stretches keep their resolution; with many segments one request covers all. Failed parts are left out.
    static func density(api: APIClient, view: String, scale: TimeScale, from: Double, to: Double, width: Double,
                        pointsPerBin: Double = 3) async -> [Histogram] {
        let segments = scale.segments(from: from, to: to).filter { $0.end > $0.start }
        var parts: [(from: Int64, to: Int64, bins: Int)] = []
        if segments.count <= 16 {
            for g in segments {
                let bins = Int(((scale.x(g.end) - scale.x(g.start)) / pointsPerBin).rounded())
                parts.append((Int64(g.start.rounded(.down)), Int64(g.end.rounded(.up)), min(500, max(1, bins))))
            }
        } else {
            parts.append((Int64(from.rounded(.down)), Int64(to.rounded(.up)), min(1000, max(1, Int(width / pointsPerBin)))))
        }
        return await withTaskGroup(of: (Int, Histogram?).self) { group in
            for (i, p) in parts.enumerated() {
                group.addTask { (i, try? await api.histogram(view: view, bins: p.bins, from: p.from, to: p.to)) }
            }
            var out: [(Int, Histogram)] = []
            for await (i, h) in group { if let h, h.binUs > 0, !h.bins.isEmpty { out.append((i, h)) } }
            return out.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }

    // MARK: Events

    /// The event of `view` closest in time to `t`. A view in time order is binary-searched (about 20 one-row
    /// requests); a view sorted another way is answered by a narrow time-ordered view of the same scope.
    static func eventNear(_ t: Double, model: WindowModel) async -> String? {
        guard let api = model.engine.api, let view = model.view, view.count > 0 else { return nil }
        let timeOrdered = model.sort.key == "no" || model.sort.key == "ts"
        if timeOrdered {
            let descending = !model.sort.ascending
            func row(_ i: Int) async -> EventRow? { try? await api.rows(view: view.viewId, offset: i, limit: 1).first }
            var lo = 0, hi = view.count - 1
            while hi - lo > 64 {
                let mid = (lo + hi) / 2
                guard let r = await row(mid) else { return nil }
                if (Double(r.ts) < t) != descending { lo = mid } else { hi = mid }
            }
            let rows = (try? await api.rows(view: view.viewId, offset: lo, limit: min(1000, hi - lo + 1))) ?? []
            return rows.min { abs(Double($0.ts) - t) < abs(Double($1.ts) - t) }?.id
        }
        var spec = model.makeSpec()
        spec.colorRules = nil
        spec.order = "asc"
        spec.sort = "ts"
        spec.from = max(spec.from ?? Int64.min, Int64(t.rounded(.down)))
        if let after = try? await api.createView(spec), after.count > 0,
           let r = try? await api.rows(view: after.viewId, offset: 0, limit: 1).first {
            return r.id
        }
        spec.from = model.scope.from
        spec.to = min(spec.to ?? Int64.max, Int64(t.rounded(.up)))
        spec.order = "desc"
        guard let before = try? await api.createView(spec), before.count > 0 else { return nil }
        return try? await api.rows(view: before.viewId, offset: 0, limit: 1).first?.id
    }
}
