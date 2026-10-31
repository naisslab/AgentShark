import AppKit
import SwiftUI

struct StatsResourcesView: View {
    let model: WindowModel
    @State private var resources = ResourcesModel()
    @State private var sessionID = ""
    @State private var pidText = ""
    @State private var expandedSetup = false
    @State private var showProcesses = false
    @State private var retryID = 0

    private struct RequestKey: Equatable { let scope: Scope; let endpoint: EngineEndpoint?; let retry: Int }
    private var bindings: [ResourceBinding] { resources.status.bindings ?? [] }
    private var selectedBindings: [ResourceBinding] {
        bindings.filter { model.scope.sessions.isEmpty || model.scope.sessions.contains($0.session) }
    }
    private var target: String { sessionID.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var live: Bool { resources.status.enabled && !selectedBindings.isEmpty }
    private var fresh: Bool {
        guard let ts = resources.latestTs else { return false }
        return resources.now.timeIntervalSince1970 - Double(ts) / 1_000_000 < 2
            && resources.latestRecording == resources.status.recording
    }
    private var showCurrent: Bool { !resources.status.enabled || live && fresh }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                heading
                if let error = resources.error { message(error, retry: true) }
                if let error = resources.actionError { message(error) }
                if resources.canRecord { setup }
                if !resources.agentRows.isEmpty { agentTotals }
                if resources.loading {
                    ProgressView("Loading recorded resources…").controlSize(.small)
                } else if resources.latest == nil {
                    ContentUnavailableView {
                        Label("No session measurements", systemImage: "waveform.path.ecg")
                    } description: {
                        Text(model.store.isCapture ? "This capture has no resource measurements in the selected scope."
                             : resources.status.enabled ? "Waiting for a local process writing this session’s indexed transcript. Closed, remote and inaccessible processes have no live measurements."
                             : "Start recording to discover local agent processes automatically. Existing trace files cannot recover past resource usage.")
                    }
                    .frame(maxWidth: .infinity, minHeight: 140)
                }
                if resources.latest != nil {
                    coverage
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 250), spacing: 14), count: model.windowWidth < 950 ? 1 : 2), spacing: 14) {
                        card("CPU", symbol: "cpu", metrics: [.cpu], labels: ["All threads"], colors: [.blue], note: "100% = one logical core", bytes: false)
                        card("Resident memory", symbol: "memorychip", metrics: [.memory], labels: ["RSS sum"], colors: [.purple], note: "Shared pages may be counted more than once", bytes: true)
                        card("Disk I/O", symbol: "internaldrive", metrics: [.read, .write], labels: ["Read", "Write"], colors: [.teal, .orange], note: "Physical bytes per second", bytes: true, rate: true)
                        card("Network", symbol: "network", metrics: [.receive, .transmit], labels: ["Receive", "Send"], colors: [.cyan, .indigo], note: networkNote, bytes: true, rate: true)
                    }
                    gpuStatus
                    DisclosureGroup("Processes (\(resources.processRows.count))", isExpanded: $showProcesses) {
                        processTable.padding(.top, 8)
                    }
                    .font(.callout.weight(.medium))
                    Text("Charts show up to 600 recent observations in the selected time range. Child discovery runs once per second, up to 128 processes; shorter-lived children can be missed. Event filters do not apply.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: RequestKey(scope: model.scope, endpoint: model.engine.endpoint, retry: retryID)) {
            if model.scope.sessions.count == 1 { sessionID = model.scope.sessions[0] }
            guard let api = model.engine.api else { return }
            let scope = model.scope
            await resources.run(api: api, scope: scope, capture: model.store.isCapture) {
                model.hostWindow?.occlusionState.contains(.visible) ?? true
            }
        }
        .onChange(of: model.scope.sessions) { _, ids in
            sessionID = ids.count == 1 ? ids[0] : ""
            pidText = ""
        }
    }

    private var heading: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text("Session resources").font(.title2.weight(.semibold))
                    Text(model.store.isCapture ? "CAPTURE" : resources.status.enabled ? "RECORDING" : "OFF")
                        .font(.caption.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 3)
                        .foregroundStyle(resources.status.enabled ? Color.red : Color.secondary)
                        .background((resources.status.enabled ? Color.red : Color.secondary).opacity(0.09), in: Capsule())
                }
                Text(rateNote).font(.callout).foregroundStyle(.secondary).monospacedDigit()
            }
            Spacer(minLength: 0)
            if resources.canRecord && resources.status.enabled {
                Button("Stop recording", systemImage: "stop.circle") { perform(stop: true) }
                    .disabled(resources.changing)
                    .help("Stop resource recording for all attached sessions in this engine and flush pending samples. Stored measurements remain available.")
            } else if resources.canRecord {
                Button("Start recording", systemImage: "record.circle") {
                    guard let api = model.engine.api else { return }
                    Task { await resources.change(api: api) }
                }.buttonStyle(.borderedProminent).disabled(resources.changing)
            }
        }
    }

    private var rateNote: String {
        if model.store.isCapture { return "Recorded process measurements · session and time scope" }
        guard resources.status.enabled else { return "Recording is optional · CPU, memory and disk target 10 Hz" }
        let requested = 1000 / (resources.status.intervalMs ?? 100)
        let observed = live && fresh ? resources.observedHz.map { String(format: "%.1f Hz observed", $0) } ?? "Waiting for samples" : "Waiting for a detected process in scope"
        return String(format: "%.0f Hz target · ", requested) + observed + " · \(selectedBindings.count) tracked session\(selectedBindings.count == 1 ? "" : "s")"
    }

    private var setup: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Automatic agent discovery", systemImage: "sparkle.magnifyingglass").font(.callout.weight(.medium))
            Text(discoveryNote).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if resources.status.discovery?.truncated == true {
                Text("Discovery reached its safety limit. Some sessions may be missing.").font(.caption).foregroundStyle(.orange)
            }
        DisclosureGroup(isExpanded: $expandedSetup) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Attach a dedicated agent process. Its threads and child processes are included. A shared app or server PID cannot separate concurrent sessions.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    TextField("Session ID", text: $sessionID).accessibilityLabel("Resource session ID")
                        .textFieldStyle(.roundedBorder).frame(minWidth: 180)
                    TextField("Root PID", text: $pidText).accessibilityLabel("Agent root PID")
                        .textFieldStyle(.roundedBorder).frame(width: 145)
                        .help("Operating system PID, or comma-separated PIDs. Tool IDs in traces are not OS PIDs.")
                    Button(resources.status.enabled ? "Attach process" : "Start recording") { perform() }
                        .buttonStyle(.borderedProminent)
                        .disabled(resources.changing || target.isEmpty || ResourcesModel.parsePIDs(pidText) == nil)
                }
                if !pidText.isEmpty && ResourcesModel.parsePIDs(pidText) == nil {
                    Text("Enter 1–16 distinct, positive OS PIDs, separated by commas.").font(.caption).foregroundStyle(.red)
                }
                ForEach(bindings, id: \.session) { binding in
                    HStack {
                        Text(binding.session).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                        Text((binding.discovered == true ? "Auto · " : "Manual · ") + "PID " + binding.roots.map(String.init).joined(separator: ", ")).monospacedDigit().foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        Button("Detach") {
                            guard let api = model.engine.api else { return }
                            Task { await resources.change(api: api, session: binding.session) }
                        }.disabled(resources.changing)
                    }.font(.caption)
                }
                Text("Recording continues when this tab is closed and stops when the engine quits. Starting also saves separate host context; these charts show session processes only.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(.top, 8)
        } label: {
            Label("Advanced: manual process binding", systemImage: "link").font(.callout.weight(.medium))
        }
        }
        .padding(12).background(.quinary, in: RoundedRectangle(cornerRadius: 8))
    }

    private var discoveryNote: String {
        guard resources.status.enabled else { return "Finds local writers of indexed Codex, Claude Code, Claude Cowork and Copilot Chat logs, then includes their threads and child processes. No PID entry needed." }
        guard let discovery = resources.status.discovery else { return "This recording uses manual bindings. Start a new recording with the main Start button to enable automatic discovery." }
        if discovery.state == "searching" { return "Finding local agent processes and matching their open transcripts to session IDs…" }
        if discovery.state == "unavailable" { return "Automatic discovery is temporarily unavailable. Retrying; existing process identities remain pinned." }
        let count = bindings.filter { $0.discovered == true }.count
        let roots = Set(bindings.flatMap(\.roots)).count
        return "\(count) sessions linked to \(roots) root process trees automatically. Discovery checks every \(Int(discovery.intervalMs / 1000)) s; CPU, memory and disk measurements target 10 Hz."
    }

    private var agentTotals: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Agents in this selection").font(.callout.weight(.medium))
            ForEach(resources.agentRows) { agent in
                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(agent.name).font(.callout.weight(.semibold))
                        Text("\(agent.sessions) sessions · \(agent.projection.processes.count) unique processes").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if agent.projection.processes.contains(where: { $0.shared == true }) {
                        Text("Shared process totals").font(.caption).foregroundStyle(.orange)
                    }
                    Text(ResourceFormat.value(showCurrent ? agent.projection.values[.cpu] : nil, bytes: false) + " CPU")
                    Text(ResourceFormat.value(showCurrent ? agent.projection.values[.memory] : nil, bytes: true) + " RSS")
                }.font(.callout.monospacedDigit())
            }
            if resources.latest?.processes.contains(where: { $0.shared == true }) == true {
                Text("Shared processes serve multiple sessions. Their resources are counted once in the total and include work from other sessions; they cannot be split by session ID.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }.padding(12).background(.quinary, in: RoundedRectangle(cornerRadius: 8))
    }

    private var coverage: some View {
        HStack(spacing: 8) {
            Image(systemName: resources.latest?.partial == true ? "exclamationmark.triangle" : "checkmark.circle")
            Text(resources.latest?.partial == true ? "Partial coverage; CPU, memory and disk totals are unknown" : "\(resources.latest?.processes.count ?? 0) unique processes")
            Spacer()
            if let ts = resources.latestTs { Text("Observed " + ResourceFormat.time(ts)).monospacedDigit() }
        }
        .font(.caption).foregroundStyle(.secondary)
        .help(resources.status.sessionError.map(ResourcesModel.reason) ?? "CPU totals include every thread in the observed process tree.")
    }

    private var networkNote: String {
        guard let net = resources.network else { return "Waiting for process counters · macOS ~1 Hz" }
        if let reason = net.reason { return ResourcesModel.reason(reason) }
        return "macOS ~1 Hz · " + age(net.ts)
    }

    private func age(_ ts: Int64) -> String {
        if model.store.isCapture || !resources.status.enabled { return "observed " + ResourceFormat.time(ts) }
        return String(format: "observed %.1f s ago", max(0, resources.now.timeIntervalSince1970 - Double(ts) / 1_000_000))
    }

    private func card(_ title: String, symbol: String, metrics: [ResourceMetric], labels: [String], colors: [Color], note: String, bytes: Bool, rate: Bool = false) -> some View {
        let lines = metrics.map { resources.series[$0] ?? [] }
        let end = resources.latestTs ?? 0
        let start = max(model.scope.from ?? 0, end - 60_000_000)
        return VStack(alignment: .leading, spacing: 9) {
            Label(title, systemImage: symbol).font(.headline)
            HStack(spacing: 18) {
                ForEach(Array(metrics.enumerated()), id: \.offset) { index, metric in
                    let point = resources.series[metric]?.last
                    let valid = showCurrent && (!metric.slow || !resources.status.enabled || point.map { resources.now.timeIntervalSince1970 - Double($0.ts) / 1_000_000 < 4 } == true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ResourceFormat.value(valid ? point?.value : nil, bytes: bytes, rate: rate))
                            .font(.title3.weight(.semibold).monospacedDigit())
                        Label(labels[index], systemImage: "circle.fill").font(.caption).foregroundStyle(colors[index])
                    }
                }
            }
            ResourcePlot(lines: lines, colors: colors, from: start, to: end, bytes: bytes, rate: rate)
                .frame(height: 100)
            Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quinary, in: RoundedRectangle(cornerRadius: 9))
    }

    private var gpuStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("GPU", systemImage: "square.3.layers.3d").font(.headline)
                Spacer()
                Text(resources.gpu?.reason.map(ResourcesModel.reason) ?? (resources.gpu?.entries.isEmpty == false ? "Process counters recorded" : "Waiting for a measurement"))
                    .font(.callout).foregroundStyle(.secondary)
            }
            if resources.gpu?.reason == "unsupported-platform" {
                Text("macOS does not expose per-process Metal GPU counters through this collector.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let gpu = resources.gpu, !gpu.entries.isEmpty {
                Text(age(gpu.ts)).font(.caption).foregroundStyle(.secondary)
                ForEach(gpu.entries) { entry in
                    Text("PID \(entry.pid) · GPU \(entry.index) · SM \(ResourceFormat.value(entry.smPercent, bytes: false)) · VRAM \(ResourceFormat.value(entry.memoryUsedBytes, bytes: true))")
                        .font(.caption.monospacedDigit())
                }
            }
        }
        .padding(14).background(.quinary, in: RoundedRectangle(cornerRadius: 9))
    }

    private var processTable: some View {
        Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 7) {
            GridRow {
                Text("PID"); Text("Parent"); Text("CPU"); Text("RSS"); Text("Disk read/s"); Text("Disk write/s")
            }.foregroundStyle(.secondary)
            ForEach(resources.processRows) { p in
                GridRow {
                    Text(String(p.pid)); Text(String(p.parentPid))
                    Text(ResourceFormat.value(p.cpuPercent, bytes: false))
                    Text(ResourceFormat.value(p.residentBytes, bytes: true))
                    Text(ResourceFormat.value(p.readBytesPerSecond, bytes: true))
                    Text(ResourceFormat.value(p.writeBytesPerSecond, bytes: true))
                }
            }
        }
        .font(.caption.monospacedDigit()).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func message(_ text: String, retry: Bool = false) -> some View {
        HStack {
            Label(text, systemImage: "exclamationmark.triangle").textSelection(.enabled)
            if retry { Button("Retry") { retryID += 1 } }
        }.font(.callout).foregroundStyle(.red)
    }

    private func perform(stop: Bool = false) {
        guard let api = model.engine.api else { return }
        let roots = ResourcesModel.parsePIDs(pidText) ?? []
        let session = target
        Task {
            await resources.change(api: api, session: session, roots: roots, stop: stop)
            if resources.actionError == nil && !stop { expandedSetup = false }
        }
    }
}

enum ResourceFormat {
    static func value(_ value: Double?, bytes: Bool, rate: Bool = false) -> String {
        guard let value, value.isFinite else { return "Unknown" }
        if !bytes { return String(format: "%.1f%%", value) }
        let units = ["B", "KiB", "MiB", "GiB", "TiB"]
        var scaled = value, index = 0
        while scaled >= 1024 && index < units.count - 1 { scaled /= 1024; index += 1 }
        return String(format: scaled >= 100 || index == 0 ? "%.0f %@" : "%.1f %@", scaled, units[index]) + (rate ? "/s" : "")
    }
    private static let clock: DateFormatter = {
        let formatter = DateFormatter(); formatter.dateFormat = "HH:mm:ss.SSS"; return formatter
    }()
    static func time(_ ts: Int64) -> String { clock.string(from: Date(timeIntervalSince1970: Double(ts) / 1_000_000)) }
}

/// A handful of paths, rather than a view or chart mark for every 100 ms sample.
private struct ResourcePlot: View {
    let lines: [[ResourcePoint]]
    let colors: [Color]
    let from: Int64
    let to: Int64
    let bytes: Bool
    let rate: Bool

    var body: some View {
        let maximum = max(1, lines.flatMap { $0 }.filter { $0.ts >= from && $0.ts <= to }.compactMap(\.value).max() ?? 1)
        VStack(spacing: 3) {
            Canvas { context, size in
                let span = Double(max(1, to - from))
                var grid = Path()
                for ratio in [0.0, 0.5, 1.0] {
                    let y = 2 + ratio * (size.height - 4)
                    grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: size.width, y: y))
                }
                context.stroke(grid, with: .color(.secondary.opacity(0.15)), style: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                for (index, points) in lines.enumerated() {
                    var path = Path(), previous: ResourcePoint?
                    for point in points where point.ts >= from && point.ts <= to {
                        guard let v = point.value else { previous = nil; continue }
                        let position = CGPoint(x: Double(point.ts - from) / span * size.width,
                                               y: size.height - 2 - min(1, max(0, v / maximum)) * (size.height - 4))
                        if let old = previous, old.recording == point.recording, Double(point.ts - old.ts) <= point.gapUs { path.addLine(to: position) }
                        else { path.move(to: position) }
                        previous = point
                    }
                    context.stroke(path, with: .color(colors[index]), style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
                }
            }.accessibilityHidden(true)
            HStack {
                Text(ResourceFormat.time(from)); Spacer()
                Text("Scale 0–" + ResourceFormat.value(maximum, bytes: bytes, rate: rate)); Spacer()
                Text(ResourceFormat.time(to))
            }.font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
        }
    }
}
