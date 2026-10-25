import SwiftUI

/// Shared view-state presentations (SPEC §7.8): inline, never modal, and failures always offer Retry.

/// Inline progress for a workspace or panel that is loading (DESIGN.md §7.15): nothing for the first 150 ms, then the
/// indicator, and its words after a second.
struct LoadingStateView: View {
    var title: String = "Loading…"
    @State private var shown = false
    @State private var worded = false

    var body: some View {
        VStack(spacing: 12) {
            if shown { ProgressView().controlSize(.small) }
            if worded { Text(title).font(Theme.fontSwiftUI(.metadata)).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            try? await Task.sleep(for: .milliseconds(150))
            shown = true
            try? await Task.sleep(for: .milliseconds(850))
            worded = true
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
    }
}

/// "Could not load this view. Your selection is preserved." with the engine's message and Retry.
struct FailedStateView: View {
    var title: String = "Could not load this view"
    var message: String = "Your selection is preserved."
    let error: APIError?
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "exclamationmark.triangle")
        } description: {
            VStack(spacing: 4) {
                Text(message)
                if let error {
                    Text(error.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
        } actions: {
            Button("Retry", action: retry).keyboardShortcut(.defaultAction)
        }
    }
}

/// Waiting for the engine: starting, restarting, or stopped with its last message.
struct EngineStateView: View {
    let engine: EngineProcess

    var body: some View {
        switch engine.status {
        case .failed(let message):
            ContentUnavailableView {
                Label("Engine stopped", systemImage: "bolt.horizontal.circle")
            } description: {
                Text(message).textSelection(.enabled)
            } actions: {
                Button("Restart Engine") { engine.restart() }
            }
        case .restarting(let attempt):
            LoadingStateView(title: "Restarting the engine (attempt \(attempt) of \(EngineProcess.maxRestarts))…")
        case .locatingNode:
            LoadingStateView(title: "Locating Node.js…")
        default:
            LoadingStateView(title: engine.captureURL == nil ? "Starting the engine…" : "Opening the capture…")
        }
    }
}

/// The workspace's scope label (DESIGN.md §7.3) in Row secondary, its leading count in the primary color at 600:
/// "**79 episodes** · 19 need attention · filter + since 17:48". It never truncates: when the header runs out of room
/// the parts after the first "·" move to its tooltip. `help` says how the scope applies where the label cannot (the
/// analyses read whole runs); it is the tooltip, after the full label when the label is short.
struct ScopeLabelView: View {
    let text: String
    var stale = false
    var short = false
    var help: String?

    private var parts: (lead: String, rest: String) {
        guard let r = text.range(of: " · ") else { return (text, "") }
        return (String(text[..<r.lowerBound]), String(text[r.lowerBound...]))
    }

    var body: some View {
        HStack(spacing: 6) {
            if stale {
                Label("Stale", systemImage: "clock.badge.exclamationmark")
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(Theme.warn.swiftUI)
                    .help("This data belongs to an earlier version of the view; refreshing it failed.")
            }
            let p = parts
            let leadsWithCount = p.lead.first?.isNumber == true
            (Text(p.lead).fontWeight(leadsWithCount ? .semibold : .regular).foregroundStyle(leadsWithCount ? Color.primary : Color.secondary)
                + Text(short ? "" : p.rest).foregroundStyle(.secondary))
                .lineLimit(1)
                .fixedSize()
        }
        .font(.system(size: 11))
        .help(short ? [text, help].compactMap { $0 }.joined(separator: "\n") : help ?? "")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Scope: \(text)")
    }
}

/// The workspace header (§7.3): one row at the top of every workspace. Left, the mode or tab switch when the
/// workspace has one, then the scope label; right, the workspace's inline view controls. When the row runs out of
/// room the scope parts after the first "·" move to the label's tooltip, then `folded` replaces the controls.
struct WorkspaceHeader<Switch: View, Controls: View, Folded: View>: View {
    let model: WindowModel
    let label: String
    var stale = false
    /// The scope label's tooltip (`ScopeLabelView.help`).
    var labelHelp: String?
    @ViewBuilder var modeSwitch: Switch
    @ViewBuilder var controls: Controls
    @ViewBuilder var folded: Folded

    private var metrics: Theme.Metrics { model.app.preferences.metrics }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row(short: false) { controls }
            row(short: true) { controls }
            row(short: true) { folded }
        }
        .controlSize(metrics.swiftUIControlSize)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: metrics.workspaceHeader, maxHeight: metrics.workspaceHeader, alignment: .leading)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func row<C: View>(short: Bool, @ViewBuilder trailing: () -> C) -> some View {
        HStack(spacing: 12) {
            modeSwitch
            ScopeLabelView(text: label, stale: stale, short: short, help: labelHelp)
            Spacer(minLength: 12)
            HStack(spacing: 12) { trailing() }.fixedSize()
        }
    }
}

extension WorkspaceHeader where Folded == Controls {
    init(model: WindowModel, label: String, stale: Bool = false, labelHelp: String? = nil, @ViewBuilder modeSwitch: () -> Switch,
         @ViewBuilder controls: () -> Controls) {
        let c = controls()
        self.init(model: model, label: label, stale: stale, labelHelp: labelHelp, modeSwitch: modeSwitch, controls: { c }, folded: { c })
    }
}

extension WorkspaceHeader where Switch == EmptyView, Folded == Controls {
    init(model: WindowModel, label: String, stale: Bool = false, labelHelp: String? = nil, @ViewBuilder controls: () -> Controls) {
        let c = controls()
        self.init(model: model, label: label, stale: stale, labelHelp: labelHelp, modeSwitch: { EmptyView() }, controls: { c }, folded: { c })
    }
}
