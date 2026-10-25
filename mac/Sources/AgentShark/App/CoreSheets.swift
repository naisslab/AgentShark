import SwiftUI

/// Filter ▸ Save Filter…: store the current filter as a bookmark. Presented for `SheetKind.saveFilter`.
struct SaveFilterSheet: View {
    @Bindable var model: WindowModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""

    private var filter: String {
        let text = model.filterText.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? model.appliedFilter : text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Save Filter").font(.headline)
            Form {
                TextField("Name:", text: $name, prompt: Text("Slow shell commands"))
                LabeledContent("Filter:") {
                    Text(filter)
                        .font(Theme.fontSwiftUI(.code))
                        .textSelection(.enabled)
                        .lineLimit(3)
                }
            }
            Text("Saved filters appear in Filter ▸ Filters and in the filter field's bookmarks menu.")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") {
                    model.app.bookmarks.add(name: name, filter: filter)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(filter.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}

/// Help ▸ Getting Started. Presented for `SheetKind.gettingStarted`.
struct GettingStartedSheet: View {
    @Environment(\.dismiss) private var dismiss
    var showFilterReference: () -> Void = {}
    var showKeyboardShortcuts: () -> Void = {}

    private let steps: [(symbol: String, title: String, detail: String)] = [
        ("sidebar.left", "Choose what to inspect",
         "Select a session in the sidebar to scope the window to it and its subagents. ⌘-click selects several. The sidebar's search only filters the list; it never changes the scope."),
        ("line.3.horizontal.decrease.circle", "Filter the events",
         #"Type a display filter such as tool.name == "Bash" && dur > 5s and press Return. Filter ▸ Filters has ready-made examples."#),
        ("list.bullet.rectangle", "Read what happened",
         "Each row has a Summary. Select a row to see its decoded fields, then the original bytes on disk in the raw pane."),
        ("square.grid.3x1.below.line.grid.1x2", "Switch workspaces",
         "⌘1–⌘7 show Events, Timeline, Conversation, Flow, Statistics, Diagnostics and Sources. Each states which parts of the scope it uses."),
        ("arrow.uturn.backward", "Retrace your steps",
         "Go ▸ Back (⌘[) and Forward (⌘]) restore the workspace, scope, filter and selected event."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Getting Started").font(.title2.weight(.semibold))
            Text("AgentShark reads the logs that coding agents write on this Mac and lets you inspect them from sessions down to raw bytes.")
                .foregroundStyle(.secondary)
            ForEach(steps, id: \.title) { step in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: step.symbol)
                        .symbolRenderingMode(.hierarchical)
                        .font(.title2)
                        .foregroundStyle(.tint)
                        .frame(width: 28)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step.title).font(.headline)
                        Text(step.detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            HStack {
                Button("Filter Reference", action: showFilterReference)
                Button("Keyboard Shortcuts", action: showKeyboardShortcuts)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 560)
    }
}
