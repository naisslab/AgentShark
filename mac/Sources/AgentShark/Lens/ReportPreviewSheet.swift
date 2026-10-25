import AppKit
import SwiftUI

/// ⇧⌘C Copy Report: Markdown, an agent brief or JSON, after a redaction preview (SPEC §12.6 privacy, §12.7).
struct ReportPreviewSheet: View {
    let model: WindowModel
    let episodeID: String
    @Environment(\.dismiss) private var dismiss
    @AppStorage("AgentShark.reportFormat") private var format = "md"
    @State private var report: EpisodeReport?
    @State private var error: APIError?

    private static let formats = [("md", "Markdown"), ("brief", "Agent Brief"), ("json", "JSON")]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Copy Report").font(.headline)
                Spacer()
                Picker("Format", selection: $format) {
                    ForEach(Self.formats, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 300)
            }
            Text(redactionText)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ZStack {
                RedactedTextView(text: report?.text ?? "")
                    .border(Color(nsColor: .separatorColor))
                if let error {
                    FailedStateView(title: "Could not build the report", error: error) { Task { await load() } }
                } else if report == nil {
                    LoadingStateView(title: "Building the report…")
                }
            }
            .frame(minWidth: 620, idealWidth: 760, minHeight: 360, idealHeight: 480)
            HStack {
                Text("Trace text in the report is the agent's own output. Review it before sharing.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Copy") {
                    if let t = report?.text { AppKitHelpers.copy(t) }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(report == nil)
            }
        }
        .padding(16)
        .task(id: format) { await load() }
    }

    private var redactionText: String {
        guard let r = report else { return "Home folders, your user name and secret-shaped strings are replaced before anything is copied." }
        if r.redactions.isEmpty { return "Nothing needed redacting. Home folders, your user name and secret-shaped strings would be replaced." }
        let parts = r.redactions.map { Formatters.count($0.count, Self.className($0.class)) }
        return "Redacted: " + parts.joined(separator: ", ") + ". The replacements are highlighted below."
    }

    /// The singular noun of a redaction class ("home folder path", "sk secret").
    static func className(_ c: String) -> String {
        switch c {
        case "home": return "home folder path"
        case "user": return "user name"
        case "sk", "ghp", "github_pat", "slack", "aws", "jwt", "pem": return "\(c) secret"
        case "bearer": return "bearer token"
        default: return c
        }
    }

    private func load() async {
        guard let api = model.engine.api else { return }
        report = nil
        error = nil
        do {
            report = try await api.episodeReport(episodeID, format: format)
        } catch {
            self.error = error as? APIError ?? .unreachable(error)
        }
    }
}

/// The report text with every redaction placeholder highlighted (`~`, `<user>`, `<secret:class:len>`), so the person
/// sees what was replaced before copying.
struct RedactedTextView: NSViewRepresentable {
    let text: String

    /// The placeholders `redactText` (src/mcp/redact.ts) writes: the home folder at a path start, the user name, and
    /// secret classes with their length.
    static let placeholder = try! NSRegularExpression(pattern: #"<secret:[a-z_]+:\d+>|<user>|(?<![\w~.-])-?~(?=/|$|\s|-)"#)

    static func ranges(in text: String) -> [NSRange] {
        placeholder.matches(in: text, range: NSRange(text.startIndex..., in: text)).map(\.range)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        if let tv = scroll.documentView as? NSTextView {
            tv.isEditable = false
            tv.isSelectable = true
            tv.usesFindBar = true
            tv.textContainerInset = NSSize(width: 6, height: 6)
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView, tv.string != text else { return }
        let a = NSMutableAttributedString(string: text, attributes: [.font: Theme.codeFont(size: 12), .foregroundColor: NSColor.textColor])
        for r in Self.ranges(in: text) {
            a.addAttributes([.backgroundColor: Theme.warn.withAlphaComponent(0.22), .font: Theme.codeFont(size: 12, weight: .semibold)], range: r)
        }
        tv.textStorage?.setAttributedString(a)
        tv.setAccessibilityValueDescription("\(Self.ranges(in: text).count) redactions highlighted")
    }
}

/// An edit chip's or a close's diff, from raw bytes (`GET /api/changes/:eventId/diff`).
struct DiffSheet: View {
    let model: WindowModel
    let request: DiffRequest
    @Environment(\.dismiss) private var dismiss
    @State private var diff: ChangeDiff?
    @State private var error: APIError?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Diff · \(request.title)").font(.headline)
                Spacer()
                Button("Select the Event") {
                    model.select(event: request.eventId, reveal: false)
                    dismiss()
                }
            }
            ZStack {
                if let diff {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(diff.files, id: \.path) { f in file(f) }
                            GapList(gaps: diff.gaps)
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else if let error {
                    FailedStateView(title: "Could not load the diff", error: error) { Task { await load() } }
                } else {
                    LoadingStateView(title: "Reading the change from the source…")
                }
            }
            .frame(minWidth: 640, idealWidth: 820, minHeight: 360, idealHeight: 520)
            .background(Color(nsColor: .textBackgroundColor))
            .border(Color(nsColor: .separatorColor))
            HStack {
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .task { await load() }
    }

    private func file(_ f: FileDiff) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(f.path).font(Theme.fontSwiftUI(.code)).fontWeight(.semibold).textSelection(.enabled)
                Text(f.op.rawValue).foregroundStyle(.secondary)
                if let a = f.added { Text("+\(a)").foregroundStyle(Theme.ok.swiftUI) }
                if let r = f.removed { Text("−\(r)").foregroundStyle(Theme.err.swiftUI) }
                Text(f.src.words).font(.caption).foregroundStyle(.tertiary)
                Spacer(minLength: 4)
                if let session = request.session {
                    Button("Follow File") {
                        model.followTarget = .file(session: session, path: f.path)
                        dismiss()
                    }
                    .controlSize(.small)
                    .help("Every read, edit and patch of this file in the session, in order")
                }
            }
            if f.newOnly { Text("The old content is not logged; only the new content is shown.").font(.caption).foregroundStyle(.secondary) }
            if let hunks = f.hunks {
                ForEach(Array(hunks.enumerated()), id: \.offset) { _, h in
                    VStack(alignment: .leading, spacing: 0) {
                        if h.oldStart != nil || h.newStart != nil {
                            Text("@@ -\(h.oldStart.map(String.init) ?? "?") +\(h.newStart.map(String.init) ?? "?") @@").font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        ForEach(Array(h.lines.enumerated()), id: \.offset) { _, line in
                            Text((line.op == "add" ? "+ " : line.op == "del" ? "- " : "  ") + line.text)
                                .font(Theme.fontSwiftUI(.code))
                                .foregroundStyle(line.op == "add" ? Theme.ok.swiftUI : line.op == "del" ? Theme.err.swiftUI : .primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(line.op == "add" ? Theme.ok.swiftUI.opacity(0.08) : line.op == "del" ? Theme.err.swiftUI.opacity(0.08) : .clear)
                                .textSelection(.enabled)
                        }
                    }
                }
                if f.truncated { Text("The diff was cut; select the event to read the whole change.").font(.caption).foregroundStyle(.secondary) }
            } else {
                Text(f.reason ?? "No diff can be shown for this change.").foregroundStyle(.secondary)
            }
        }
    }

    private func load() async {
        guard let api = model.engine.api else { return }
        do {
            diff = try await api.diff(event: request.eventId, path: request.path)
            error = nil
        } catch {
            self.error = error as? APIError ?? .unreachable(error)
        }
    }
}

/// Failures ▸ Split Signature at Date…: the signature with its split controls in a sheet.
struct SignatureSplitSheet: View {
    let model: WindowModel
    let signatureID: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            SignatureView(model: model, signatureID: signatureID)
                .frame(minWidth: 640, idealWidth: 760, minHeight: 480, idealHeight: 620)
            Divider()
            HStack {
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
    }
}
