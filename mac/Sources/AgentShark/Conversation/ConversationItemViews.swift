import AppKit
import SwiftUI

/// What every item view needs from the workspace.
@MainActor struct ConversationContext {
    let model: WindowModel
    /// The active find text, highlighted in message text; empty when Find is closed.
    let highlight: String
    let showFullText: (FullTextRequest) -> Void

    func showInEvents(_ event: String) { model.select(event: event) }
}

/// One transcript item, with Show in Events on hover, in the context menu and as an accessibility action.
struct ConversationItemView: View {
    let entry: ConversationEntry
    let context: ConversationContext
    let isCurrentMatch: Bool
    @State private var hovering = false

    private var item: ConversationItem { entry.item }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            content.frame(maxWidth: .infinity, alignment: .leading)
            // A gutter, so the button never covers the item's own controls.
            Button {
                context.showInEvents(item.event)
            } label: {
                Image(systemName: "arrow.right.circle")
            }
            .buttonStyle(.borderless)
            .iconHelp("Show in Events")
            .opacity(hovering && showsHoverButton ? 1 : 0)
            .allowsHitTesting(hovering && showsHoverButton)
            .accessibilityHidden(true)
            .frame(width: 18)
            .padding(.top, 2)
        }
            .overlay {
                if isCurrentMatch {
                    RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor, lineWidth: 2).padding(-4)
                }
            }
            .onHover { hovering = $0 }
            .contextMenu {
                Button("Show in Events") { context.showInEvents(item.event) }
                if let result = item.tool?.resultEvent {
                    Button("Show Result in Events") { context.showInEvents(result) }
                }
                if let child = item.subagent?.session {
                    Button("Open Subagent Conversation") { context.model.openSession(child, mode: .transcript) }
                }
                Divider()
                if let text = item.text, !text.isEmpty {
                    Button("Copy Text") { AppKitHelpers.copy(text) }
                }
                Button("Copy Event ID") { AppKitHelpers.copy(item.event) }
            }
            .accessibilityAction(named: "Show in Events") { context.showInEvents(item.event) }
    }

    /// Dividers and separators are too thin for an overlay button; their context menu has the action.
    private var showsHoverButton: Bool { !["turn-end", "compaction", "status"].contains(item.type) }

    @ViewBuilder private var content: some View {
        switch item.type {
        case "prompt": MessageView(entry: entry, context: context, isUser: true)
        case "text": MessageView(entry: entry, context: context, isUser: false)
        case "thinking": ThinkingView(entry: entry)
        case "inject": InjectView(entry: entry)
        case "tool": ToolCardView(entry: entry, context: context)
        case "subagent": SubagentCardView(entry: entry, context: context)
        case "compaction": CompactionView(entry: entry, context: context)
        case "turn-end": TurnEndView(item: item)
        case "error": ErrorBannerView(entry: entry, context: context)
        default: StatusLineView(item: item)
        }
    }
}

// MARK: - Shared pieces

/// `14:03:22` with the full timestamp and offset on hover.
private struct TimeLabel: View {
    let ts: Int64

    var body: some View {
        Text(PanelKit.clock(ts))
            .font(Theme.dataFontSwiftUI(size: 11))
            .foregroundStyle(.secondary)
            .help(Formatters.timestamp(ts))
    }
}

private func toolColor(_ kind: String?) -> Color {
    let k: Theme.KindColor
    switch kind {
    case "shell": k = .toolShell
    case "file": k = .toolFile
    case "web": k = .toolWeb
    case "mcp": k = .toolMcp
    case "agent": k = .agent
    default: k = .toolOther
    }
    return Theme.color(k).swiftUI
}

/// `exit 0`, `exit 1` or `Error`; nothing when the result has no status.
private struct ExitBadge: View {
    let tool: ConversationItem.Tool

    var body: some View {
        if let code = tool.exitCode {
            let failed = code != 0 || tool.isError == true
            PanelKit.Chip(text: "exit \(code)", symbol: failed ? "xmark" : nil, color: failed ? Theme.err.swiftUI : .secondary)
                .help(failed ? "The command failed with exit code \(code)" : "The command succeeded")
        } else if tool.isError == true {
            PanelKit.Chip(text: "Error", symbol: "xmark", color: Theme.err.swiftUI)
                .help("The tool reported an error")
        }
    }
}

/// Message blocks: paragraphs as Markdown, code in boxes with Copy.
struct MessageBlocksView: View {
    let blocks: [MessageBlock]
    var highlight = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let a):
                    Text(MessageBlock.highlighted(a, highlight))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                case .heading(let a):
                    Text(MessageBlock.highlighted(a, highlight)).font(.headline).textSelection(.enabled)
                case .code(let language, let text):
                    PanelKit.CodeBlock(text: text, label: language ?? "Code")
                case .table(let text):
                    PanelKit.CodeBlock(text: text, label: "Table")
                case .quote(let a):
                    HStack(alignment: .top, spacing: 8) {
                        RoundedRectangle(cornerRadius: 1.5).fill(.tertiary).frame(width: 3)
                        Text(MessageBlock.highlighted(a, highlight))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}

/// "Show Full Text…" when the index copy was capped.
private struct FullTextButton: View {
    let title: String
    let request: FullTextRequest
    let context: ConversationContext

    var body: some View {
        Button(title) { context.showFullText(request) }
            .controlSize(.small)
            .help("Load the complete text from the original source record")
    }
}

// MARK: - Messages

private struct MessageView: View {
    let entry: ConversationEntry
    let context: ConversationContext
    let isUser: Bool

    private var item: ConversationItem { entry.item }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: isUser ? "person.fill" : "sparkles")
                    .foregroundStyle(Theme.color(isUser ? .user : .llm).swiftUI)
                    .accessibilityHidden(true)
                Text(isUser ? "User" : "Assistant").fontWeight(.semibold)
                if let model = item.llm?.model {
                    Text(model).font(Theme.fontSwiftUI(.rowSecondary)).foregroundStyle(.secondary)
                }
                if let out = item.llm?.tokens?.output {
                    Text("\(Formatters.tokens(out)) out")
                        .font(Theme.dataFontSwiftUI(size: 11))
                        .foregroundStyle(.secondary)
                        .help("\(Formatters.count(out)) output tokens in this model response")
                }
                TimeLabel(ts: item.ts)
            }
            if entry.blocks.isEmpty {
                Text(isUser ? "Empty prompt" : "No text was logged for this response.").foregroundStyle(.tertiary)
            } else {
                MessageBlocksView(blocks: entry.blocks, highlight: context.highlight)
            }
            if entry.textIsTruncated {
                FullTextButton(title: "Show Full Text" + (item.textLen.map { " (\(Formatters.tokens($0)) characters)…" } ?? "…"),
                               request: FullTextRequest(eventID: item.event, kind: .text, title: isUser ? "Prompt" : "Assistant Message"),
                               context: context)
            }
        }
        .padding(isUser ? 12 : 0)
        .background {
            if isUser { RoundedRectangle(cornerRadius: 9).fill(.quinary) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(isUser ? "User prompt" : "Assistant message")
    }
}

/// A row with a chevron that expands its content. Rows that cannot expand keep the chevron's space, so icons line
/// up with each other and with the tool cards.
private struct ExpandableRow<Label: View, Content: View>: View {
    @Binding var isExpanded: Bool
    var canExpand = true
    var hint = "Shows the full text"
    @ViewBuilder let label: () -> Label
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.18)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .opacity(canExpand ? 1 : 0)
                        .accessibilityHidden(true)
                    label()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .allowsHitTesting(canExpand)
            .accessibilityValue(canExpand ? (isExpanded ? "Expanded" : "Collapsed") : "")
            .accessibilityHint(canExpand ? hint : "")
            if isExpanded && canExpand {
                content().padding(.leading, 19)
            }
        }
        .padding(.horizontal, 10)
    }
}

private struct ThinkingView: View {
    let entry: ConversationEntry
    @State private var expanded = false

    private var stats: String {
        let item = entry.item
        let length = item.textLen ?? item.text?.count ?? 0
        var parts: [String] = []
        if item.text?.isEmpty == false {
            parts.append(Formatters.count(length, "character"))
        } else {
            parts.append(length > 0 ? "text not logged (\(Formatters.count(length, "character")))" : "text not logged")
        }
        if let ms = item.meta?["thinkingMs"]?.doubleValue { parts.append(Formatters.duration(Int64(ms * 1000))) }
        if let r = item.llm?.tokens?.reasoning { parts.append("\(Formatters.tokens(r)) reasoning tokens") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        let text = entry.item.text ?? ""
        ExpandableRow(isExpanded: $expanded, canExpand: !text.isEmpty, hint: "Shows the thinking text") {
            HStack(spacing: 6) {
                Image(systemName: "brain").foregroundStyle(Theme.color(.thinking).swiftUI).frame(width: 16).accessibilityHidden(true)
                Text("Thinking").fontWeight(.medium)
                Text(stats).foregroundStyle(.secondary)
                TimeLabel(ts: entry.item.ts)
            }
            .help(text.isEmpty ? "The agent did not log the thinking text." : "Model reasoning before the next step")
        } content: {
            Text(text)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct InjectView: View {
    let entry: ConversationEntry
    @State private var expanded = false

    var body: some View {
        let text = entry.item.text ?? ""
        ExpandableRow(isExpanded: $expanded, canExpand: !text.isEmpty, hint: "Shows the injected text") {
            HStack(spacing: 6) {
                Image(systemName: "text.badge.plus").foregroundStyle(Theme.color(.context).swiftUI).frame(width: 16).accessibilityHidden(true)
                Text("Injected Context").fontWeight(.medium)
                Text(text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").first ?? "")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                TimeLabel(ts: entry.item.ts)
            }
            .help("Text the harness added to the conversation, not typed by the user")
        } content: {
            Text(text)
                .font(Theme.fontSwiftUI(.code))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Tools

private struct ToolCardView: View {
    let entry: ConversationEntry
    let context: ConversationContext
    @State private var expanded = false
    @State private var durationSource: String?

    private var tool: ConversationItem.Tool { entry.item.tool ?? .init(name: "tool") }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.18)) { expanded.toggle() }
            } label: {
                header.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tool call \(tool.name): \(tool.inputSummary ?? "")")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Shows the input and output")
            if expanded {
                Divider()
                details.padding(10)
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(.background.secondary))
        .overlay(RoundedRectangle(cornerRadius: 8)
            .strokeBorder(tool.isError == true ? Theme.err.swiftUI.opacity(0.55) : Color(nsColor: .separatorColor)))
        .task(id: expanded) {
            guard expanded, durationSource == nil, let api = context.model.engine.api else { return }
            durationSource = (try? await api.event(entry.item.event))?.span?.durSrc ?? "unknown"
        }
    }

    private var header: some View {
        HStack(spacing: 7) {
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .rotationEffect(.degrees(expanded ? 90 : 0))
                .accessibilityHidden(true)
            Image(systemName: Symbols.toolKind(tool.kind))
                .foregroundStyle(toolColor(tool.kind))
                .frame(width: 16)
                .accessibilityHidden(true)
            Text(tool.name).font(Theme.fontSwiftUI(.code).weight(.semibold))
            Text(tool.inputSummary ?? "")
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(tool.inputSummary ?? "")
            Spacer(minLength: 8)
            if let dur = tool.dur {
                Text(Formatters.duration(dur, src: durationSource))
                    .font(Theme.dataFontSwiftUI(size: 11))
                    .foregroundStyle(.secondary)
                    .help(durationSource.map(Formatters.provenance) ?? "Expand the card to see how the duration was measured")
            }
            ExitBadge(tool: tool)
            TimeLabel(ts: entry.item.ts)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
    }

    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let dur = tool.dur {
                LabeledContent("Duration") {
                    Text("\(Formatters.duration(dur, src: durationSource)) · \(durationSource.map(Formatters.provenance) ?? "Checking provenance…")")
                        .foregroundStyle(.secondary)
                }
            }
            if let input = tool.input {
                PanelKit.CodeBlock(text: input.stringValue ?? input.prettyPrinted, label: "Input")
            }
            if tool.output == nil && tool.resultEvent == nil {
                Text("No result was recorded for this call.").foregroundStyle(.secondary)
            } else if let output = tool.output {
                PanelKit.CodeBlock(text: output,
                                   label: "Output" + (tool.outputLen.map { " · \(Formatters.count($0, "character"))" } ?? ""))
            }
            HStack(spacing: 8) {
                if entry.outputIsTruncated, let result = tool.resultEvent {
                    Button("Show Full Output…") {
                        context.showFullText(FullTextRequest(eventID: result, kind: .output, title: "Output of \(tool.name)"))
                    }
                    .help("Load the complete output from the original source record")
                }
                Button("Show Call in Events") { context.showInEvents(entry.item.event) }
                if let result = tool.resultEvent {
                    Button("Show Result in Events") { context.showInEvents(result) }
                }
            }
            .controlSize(.small)
        }
    }
}

private struct SubagentCardView: View {
    let entry: ConversationEntry
    let context: ConversationContext
    @State private var showResult = false

    var body: some View {
        let sub = entry.item.subagent
        let tool = entry.item.tool
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: "person.2.fill").foregroundStyle(Theme.color(.agent).swiftUI).accessibilityHidden(true)
                Text("Subagent").fontWeight(.semibold)
                if let type = sub?.type { PanelKit.Chip(text: type) }
                Text(sub?.title ?? tool?.inputSummary ?? entry.item.text ?? "")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                if let dur = tool?.dur {
                    Text(Formatters.duration(dur)).font(Theme.dataFontSwiftUI(size: 11)).foregroundStyle(.secondary)
                }
                if let tool { ExitBadge(tool: tool) }
                TimeLabel(ts: entry.item.ts)
            }
            HStack(spacing: 8) {
                if let child = sub?.session {
                    Button("Open Subagent Conversation") { context.model.openSession(child, mode: .transcript) }
                        .help(context.model.sessionsByID[child] == nil ? "\(child) is not in the session list yet" : "Open \(child)")
                    Text(child).font(Theme.fontSwiftUI(.code)).foregroundStyle(.tertiary).textSelection(.enabled)
                } else {
                    Text("The child session was not found in the index.").foregroundStyle(.secondary)
                }
            }
            .controlSize(.small)
            if let output = tool?.output, !output.isEmpty {
                DisclosureGroup("Result Returned to the Parent", isExpanded: $showResult) {
                    MessageBlocksView(blocks: MessageBlock.parse(output), highlight: context.highlight).padding(.top, 4)
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(.background.secondary))
        .overlay(RoundedRectangle(cornerRadius: 8)
            .strokeBorder(tool?.isError == true ? Theme.err.swiftUI.opacity(0.55) : Theme.color(.agent).swiftUI.opacity(0.35)))
    }
}

// MARK: - Dividers and banners

/// A thin rule with a centered caption.
private struct CaptionRule: View {
    let text: String
    var symbol: String?
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(.separator).frame(height: 1)
            HStack(spacing: 4) {
                if let symbol { Image(systemName: symbol).accessibilityHidden(true) }
                Text(text)
            }
            .font(.caption)
            .foregroundStyle(color)
            .fixedSize()
            Rectangle().fill(.separator).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct CompactionView: View {
    let entry: ConversationEntry
    let context: ConversationContext
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            CaptionRule(text: "Context compacted · \(PanelKit.clock(entry.item.ts))", symbol: "arrow.down.right.and.arrow.up.left",
                        color: Theme.color(.compaction).swiftUI)
                .help(Formatters.timestamp(entry.item.ts))
            if !entry.blocks.isEmpty {
                DisclosureGroup("Summary Carried into the New Context", isExpanded: $expanded) {
                    MessageBlocksView(blocks: entry.blocks, highlight: context.highlight).padding(.top, 4)
                }
                .font(.callout)
            }
        }
    }
}

private struct TurnEndView: View {
    let item: ConversationItem

    var body: some View {
        let aborted = item.meta?["aborted"]?.boolValue == true
        let dur = item.meta?["dur"]?.int64Value
        let text = [aborted ? "Turn aborted" : "Turn ended", dur.map { Formatters.duration($0) }].compactMap { $0 }.joined(separator: " · ")
        CaptionRule(text: text, symbol: aborted ? "xmark.circle" : nil, color: aborted ? Theme.warn.swiftUI : .secondary)
            .help(dur == nil ? "The turn's duration was not logged." : "Turn duration, from its first to its last event")
    }
}

private struct ErrorBannerView: View {
    let entry: ConversationEntry
    let context: ConversationContext

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.octagon.fill").foregroundStyle(Theme.err.swiftUI).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(entry.item.meta?["kind"]?.stringValue == "llm.refusal" ? "Refusal" : "Error").fontWeight(.semibold)
                    TimeLabel(ts: entry.item.ts)
                }
                if entry.blocks.isEmpty {
                    Text("Unknown error").foregroundStyle(.secondary)
                } else {
                    MessageBlocksView(blocks: entry.blocks, highlight: context.highlight)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.err.swiftUI.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.err.swiftUI.opacity(0.35)))
    }
}

private struct StatusLineView: View {
    let item: ConversationItem

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: item.subagent == nil ? "info.circle" : "person.2").accessibilityHidden(true)
            Text(item.text ?? "").lineLimit(2)
            TimeLabel(ts: item.ts)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }
}
