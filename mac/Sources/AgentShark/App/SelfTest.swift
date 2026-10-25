import Foundation

/// `AgentShark --self-test`: headless check of the live engine path used by the integrator.
///
/// Starts the live engine (AGENTSHARK_HOME from the environment; AGENTSHARK_ENGINE_SOURCE and AGENTSHARK_NODE
/// optionally choose the engine checkout and Node binary), then exercises info, sessions, views, rows, event,
/// raw, spans, statistics and sources. Prints one JSON object with structure and counts only (never message
/// text) and exits 0 when every step passed, 1 otherwise. Settings are not read or written.
enum SelfTest {
    static func run() -> Never {
        Task { @MainActor in
            let code = await perform()
            exit(code)
        }
        dispatchMain()
    }

    /// Records the steps of the agent-native part.
    @MainActor final class Recorder {
        var steps: [JSONValue] = []
        var failed = false

        func step<T>(_ name: String, _ body: () async throws -> T, _ summary: (T) -> JSONValue) async -> T? {
            let started = Date()
            var s: JSONObject = ["step": .string(name)]
            defer {
                s["ms"] = .number((Date().timeIntervalSince(started) * 1000).rounded())
                steps.append(.object(s))
            }
            do {
                let v = try await body()
                s["ok"] = .bool(true)
                s["result"] = summary(v)
                return v
            } catch let e as APIError where e.isNotServed {
                // A route this engine build does not serve yet is a stated gap, not a client failure.
                s["ok"] = .bool(true)
                s["result"] = .object(["notServed": .string(e.message)])
                return nil
            } catch {
                failed = true
                s["ok"] = .bool(false)
                s["error"] = .string((error as? APIError)?.message ?? error.localizedDescription)
                return nil
            }
        }
    }

    private static func n(_ i: Int) -> JSONValue { .number(Double(i)) }

    /// The agent-native routes (SPEC §12.5): structure and counts only, never trace text.
    @MainActor static func derivedSteps(api: APIClient, sessions: [SessionRow], into r: Recorder) async {
        _ = await r.step("failuresSummary", { try await api.failuresSummary(.global) }) {
            .object(["episodes": n($0.episodes), "needAttention": n($0.needAttention), "openAlarms": n($0.openAlarms),
                     "failureRows": n($0.tierCount(.failure)), "gaps": n($0.gaps.count)])
        }
        let queue = await r.step("failuresQueue", { try await api.failuresQueue(QueueRequest(scope: .global, group: .attention, limit: 50)) }) {
            .object(["total": n($0.total), "rows": n($0.rows.count),
                     "sections": .array(Array(Set($0.rows.compactMap { $0.section?.rawValue })).sorted().map(JSONValue.string))])
        }
        // The queue's jump bar loads a section the main page did not reach on its own.
        _ = await r.step("failuresQueue(section)", {
            try await api.failuresQueue(QueueRequest(scope: .global, group: .attention, section: "silent-child", limit: FailuresModel.sectionPage))
        }) {
            .object(["total": n($0.total), "rows": n($0.rows.count), "onlySection": .bool($0.rows.allSatisfy { $0.section?.rawValue == "silent-child" })])
        }
        if let ep = queue?.rows.first(where: { $0.kind == .episode }) {
            _ = await r.step("episode", { try await api.episode(ep.id) }) {
                .object(["attempts": n($0.payload.attempts.count), "outcome": .string($0.payload.episode.outcome.rawValue),
                         "related": n($0.payload.related.count), "gaps": n($0.payload.gaps.count)])
            }
        }
        _ = await r.step("sessionMarks", { try await api.sessionMarks() }) { .object(["rows": n($0.rows.count), "gaps": n($0.gaps.count)]) }
        _ = await r.step("alarms(firing)", { try await api.alarms(.global, state: .firing) }) { .object(["total": n($0.total)]) }
        _ = await r.step("signatures", { try await api.signatures(.global, limit: 20) }) { .object(["total": n($0.total), "rows": n($0.rows.count)]) }
        guard let root = queue?.rows.first?.sessionId ?? sessions.first(where: { $0.parentId == nil })?.id else { return }
        let page = await r.step("sessionSteps", { try await api.sessionSteps(root, StepsRequest(limit: 200)) }) {
            .object(["total": n($0.total), "turns": n($0.turns.count), "steps": n($0.steps.count), "more": .bool($0.next != nil)])
        }
        _ = await r.step("runReport", { try await api.runReport(session: root) }) {
            .object(["turns": n($0.payload.turns.total), "steps": n($0.payload.steps.total), "attention": n($0.payload.attention.count),
                     "status": .string($0.payload.run.status)])
        }
        if let turn = page?.turns.first {
            _ = await r.step("time(turn)", { try await api.time(turn: turn.id) }) { .object(["buckets": n($0.payload.buckets.count)]) }
        }
        // Steps sorted by active time; an engine that predates `sort=active` refuses it and the app sorts by itself.
        let sortStarted = Date()
        var sortStep: JSONObject = ["step": .string("sessionSteps(sort: active)"), "ok": .bool(true)]
        do {
            let sorted = try await api.sessionSteps(root, StepsRequest(limit: 50, sort: "active", order: "desc"))
            sortStep["result"] = .object(["steps": n(sorted.steps.count), "sortedByEngine": .bool(true)])
        } catch let e as APIError where e.status == 400 {
            sortStep["result"] = .object(["sortedByEngine": .bool(false)])
        } catch {
            r.failed = true
            sortStep["ok"] = .bool(false)
            sortStep["error"] = .string((error as? APIError)?.message ?? error.localizedDescription)
        }
        sortStep["ms"] = .number((Date().timeIntervalSince(sortStarted) * 1000).rounded())
        r.steps.append(.object(sortStep))
        guard let call = page?.steps.first(where: { !$0.calls.isEmpty })?.calls.first else { return }
        _ = await r.step("eventDerived", { try await api.eventDerived(call.resultEventId ?? call.eventId) }) {
            .object(["step": .bool($0.step != nil), "failure": .bool($0.failure != nil), "episode": .bool($0.episode != nil)])
        }
        _ = await r.step("followCall", { try await api.follow(.call(eventId: call.eventId)) }) { .object(["items": n($0.items.count)]) }
        await p1Steps(api: api, root: root, into: r)
    }

    /// The P1 routes: claims, interventions, time, service response time, endpoints, and the Process and File streams.
    @MainActor static func p1Steps(api: APIClient, root: String, into r: Recorder) async {
        let scope = DerivedScopeQuery(session: root, descendants: true)
        _ = await r.step("claims", { try await api.claims(scope, limit: 50) }) { .object(["total": n($0.total), "gaps": n($0.gaps.count)]) }
        _ = await r.step("interventions", { try await api.interventions(scope, limit: 50) }) { .object(["total": n($0.total), "gaps": n($0.gaps.count)]) }
        _ = await r.step("time(session)", { try await api.time(session: root) }) {
            .object(["buckets": n($0.payload.buckets.count), "wall": .bool($0.payload.wallUs != nil), "gaps": n($0.gaps.count)])
        }
        _ = await r.step("statsSRT(program)", { try await api.statsSRT(view: "global", group: "program") }) { .object(["rows": n($0.rows.count)]) }
        _ = await r.step("statsEndpoints", { try await api.statsEndpoints(view: "global") }) { .object(["rows": n($0.rows.count)]) }
        let procs = await r.step("processes", { try await api.processes(scope, limit: 5) }) { .object(["total": n($0.total)]) }
        _ = await r.step("delegations", { try await api.delegations(scope, limit: 5) }) { .object(["total": n($0.total)]) }
        _ = await r.step("episodes(global)", { try await api.episodes(.global, limit: 50) }) { .object(["total": n($0.total), "rows": n($0.rows.count)]) }
        if let p = procs?.rows.first {
            _ = await r.step("followProcess", { try await api.follow(.process(id: p.id)) }) {
                .object(["items": n($0.items.count), "kind": .string($0.kind)])
            }
        }
    }

    @MainActor static func perform() async -> Int32 {
        let env = ProcessInfo.processInfo.environment
        let prefs = Preferences(defaults: nil)
        if let src = env["AGENTSHARK_ENGINE_SOURCE"] { prefs.engineSourcePath = src }
        if let node = env["AGENTSHARK_NODE"] { prefs.nodeOverridePath = node }
        let timeout = Double(env["AGENTSHARK_SELFTEST_TIMEOUT"] ?? "") ?? 180

        var report = JSONObject()
        var steps: [JSONValue] = []
        var failed = false

        func record(_ name: String, _ started: Date, _ result: Result<JSONValue, Error>) {
            var s: JSONObject = ["step": .string(name), "ms": .number((Date().timeIntervalSince(started) * 1000).rounded())]
            switch result {
            case .success(let detail):
                s["ok"] = .bool(true)
                s["result"] = detail
            case .failure(let error):
                failed = true
                s["ok"] = .bool(false)
                s["error"] = .string((error as? APIError)?.message ?? error.localizedDescription)
            }
            steps.append(.object(s))
        }

        func step<T>(_ name: String, _ body: () async throws -> T, _ summary: (T) -> JSONValue) async -> T? {
            let t = Date()
            do {
                let v = try await body()
                record(name, t, .success(summary(v)))
                return v
            } catch {
                record(name, t, .failure(error))
                return nil
            }
        }

        func n(_ i: Int) -> JSONValue { .number(Double(i)) }

        let engine = EngineProcess(mode: .live, preferences: prefs)
        let started = Date()
        engine.start()
        while engine.api == nil {
            if case .failed(let message) = engine.status {
                record("engine", started, .failure(APIError(status: 0, message: message, code: "engine", start: nil, end: nil)))
                break
            }
            if Date().timeIntervalSince(started) > timeout {
                record("engine", started, .failure(APIError(status: 0, message: "No ready handshake within \(Int(timeout)) s",
                                                            code: "timeout", start: nil, end: nil)))
                break
            }
            try? await Task.sleep(for: .milliseconds(100))
        }

        if let api = engine.api, let ep = engine.endpoint {
            record("engine", started, .success(.object([
                "baseURL": .string(ep.baseURL.absoluteString), "mode": .string(ep.mode), "version": .string(ep.version),
                "node": .string(engine.node?.version ?? ""),
            ])))
            let info = await step("info", { try await api.info() }) {
                .object(["mode": .string($0.mode), "sources": n($0.counts.sources), "sessions": n($0.counts.sessions),
                         "events": n($0.counts.events), "spans": n($0.counts.spans),
                         "analysisVersion": $0.analysis?.version.map { n($0) } ?? .null, "analysisPending": n($0.analysis?.pending.count ?? 0),
                         "follower": .bool($0.isFollower), "writerPid": $0.followedWriterPid.map { n($0) } ?? .null])
            }
            let sessionList = await step("sessions", { try await api.sessions(limit: 20000) }) {
                .object(["total": n($0.total), "returned": n($0.sessions.count)])
            }
            if info?.analysis != nil {
                let r = Recorder()
                await derivedSteps(api: api, sessions: sessionList?.sessions ?? [], into: r)
                steps += r.steps
                if r.failed { failed = true }
            } else {
                steps.append(.object(["step": .string("derived"), "ok": .bool(true),
                                      "result": .object(["skipped": .string("the engine reports no analysis (index schema < 4)")])]))
            }
            let view = await step("createView", { try await api.createView(ViewSpec()) }) { .object(["count": n($0.count)]) }
            _ = await step("createView(filter: error)", { try await api.createView(ViewSpec(filter: "error")) }) {
                .object(["count": n($0.count)])
            }
            if let view {
                let page0 = await step("rows(page 1)", { try await api.rows(view: view.viewId, offset: 0, limit: 500) }) {
                    .object(["rows": n($0.count), "firstNo": $0.first?.no.map { n($0) } ?? .null])
                }
                _ = await step("rows(page 2)", { try await api.rows(view: view.viewId, offset: 500, limit: 500) }) {
                    .object(["rows": n($0.count), "firstNo": $0.first?.no.map { n($0) } ?? .null])
                }
                if let first = page0?.first {
                    _ = await step("event", { try await api.event(first.id) }) {
                        .object(["kind": .string($0.event.kind.rawValue), "related": n($0.related.count),
                                 "spanChain": n($0.spanChain.count), "fieldMap": .bool($0.fieldMap != nil),
                                 "nativeKeys": n($0.event.native?.childCount ?? 0)])
                    }
                    _ = await step("raw", { try await api.raw(first.id) }) {
                        .object(["available": .bool($0.available), "ranges": n($0.ranges.count), "bytes": n($0.text.utf8.count)])
                    }
                    _ = await step("spans", { try await api.spans(sessions: [first.session], from: nil, to: nil, limit: 2000) }) {
                        .object(["spans": n($0.spans.count), "truncated": .bool($0.truncated)])
                    }
                }
                _ = await step("statsSummary", { try await api.statsSummary(view: view.viewId) }) {
                    .object(["events": n($0.events), "sessions": n($0.sessions), "toolCalls": n($0.toolCalls)])
                }
            }
            _ = await step("sources", { try await api.sources() }) {
                .object(["agents": n($0.agents.count), "sources": n($0.sources.count)])
            }
        }

        engine.terminateForQuit()
        report["ok"] = .bool(!failed)
        report["steps"] = .array(steps)
        if failed { report["engineLog"] = .array(engine.logTail.suffix(10).map(JSONValue.string)) }
        print(JSONValue.object(report).prettyPrinted)
        return failed ? 1 : 0
    }
}
