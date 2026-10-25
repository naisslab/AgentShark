import SwiftUI

/// Help ▸ Keyboard Shortcuts: every shortcut, grouped by menu and by workspace, with a filter field.
struct KeyboardShortcutsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    struct Shortcut: Hashable {
        let action: String
        let keys: String
    }

    struct ShortcutGroup: Identifiable {
        let title: String
        let items: [Shortcut]
        var id: String { title }
    }

    /// MAC-SPEC §5 and §11, as the menus implement them.
    static let groups: [ShortcutGroup] = [
        ShortcutGroup(title: "File", items: [
            .init(action: "New Window", keys: "⌘N"),
            .init(action: "New Tab", keys: "⌘T"),
            .init(action: "Open Capture…", keys: "⌘O"),
            .init(action: "Export Capture…", keys: "⇧⌘E"),
            .init(action: "Reindex Now (Events)", keys: "⌘R"),
            .init(action: "Reindex Now (other workspaces)", keys: "⇧⌘R"),
            .init(action: "Close", keys: "⌘W"),
            .init(action: "Settings…", keys: "⌘,"),
        ]),
        ShortcutGroup(title: "Edit", items: [
            .init(action: "Copy", keys: "⌘C"),
            .init(action: "Copy as JSON", keys: "⌥⌘C"),
            .init(action: "Find", keys: "⌘F"),
            .init(action: "Find Next", keys: "⌘G"),
            .init(action: "Find Previous", keys: "⇧⌘G"),
            .init(action: "Mark or Unmark Event", keys: "⌃⌘M"),
        ]),
        ShortcutGroup(title: "View", items: Workspace.allCases.enumerated().map { i, w in
            Shortcut(action: w.title, keys: AppShortcut.workspace(at: i).keys)
        } + [
            .init(action: "Show Sidebar", keys: "⌃⌘S"),
            .init(action: "Show Timeline Track", keys: "⌥⌘T"),
            .init(action: "Show Inspector (detail and raw in Failures and Session)", keys: "⌥⌘I"),
            .init(action: "Enter Full Screen", keys: "⌃⌘F"),
        ]),
        ShortcutGroup(title: "Failures", items: [
            .init(action: "Next Failure (nothing selected: the newest)", keys: AppShortcut.nextFailure.keys),
            .init(action: "Previous Failure", keys: AppShortcut.previousFailure.keys),
            .init(action: "Next Attention Item", keys: AppShortcut.nextAttention.keys),
            .init(action: "Show in Session", keys: AppShortcut.showInSession.keys),
            .init(action: "Show Signature", keys: AppShortcut.showSignature.keys),
            .init(action: "Follow", keys: AppShortcut.follow.keys),
            .init(action: "Copy Report…", keys: AppShortcut.copyReport.keys),
            .init(action: "Previous or Next Attempt (Lens)", keys: "↑ ↓"),
        ]),
        ShortcutGroup(title: "Go", items: [
            .init(action: "Back", keys: "⌘["),
            .init(action: "Forward", keys: "⌘]"),
            .init(action: "Go to Event…", keys: "⌘L"),
            .init(action: "Partner Event (call ↔ result)", keys: "⌥⌘→"),
            .init(action: "Previous in Turn", keys: "⌃⌘↑"),
            .init(action: "Next in Turn", keys: "⌃⌘↓"),
            .init(action: "Next Mark", keys: "⇧⌘M"),
            .init(action: "Parent Session", keys: "⌘↑"),
            .init(action: "Open Child Session", keys: "⌘↓"),
            .init(action: "Next Difference Region (Session · Compare)", keys: AppShortcut.nextRegion.keys),
            .init(action: "Previous Difference Region (Session · Compare)", keys: AppShortcut.previousRegion.keys),
            .init(action: "Set or Clear Time Reference", keys: AppShortcut.timeReference.keys),
        ]),
        ShortcutGroup(title: "Filter", items: [
            .init(action: "Apply Filter (in the filter field)", keys: "↩"),
            .init(action: "Revert to the Applied Filter (in the filter field)", keys: "⎋"),
            .init(action: "Accept Completion (in the filter field)", keys: "⇥"),
            .init(action: "Clear Filter", keys: "⌘⌫"),
            .init(action: "Filter to Time Range (Timeline)", keys: "⌘R"),
        ]),
        ShortcutGroup(title: "Event Table", items: [
            .init(action: "Previous or Next Event", keys: "↑ ↓"),
            .init(action: "Page Up or Page Down", keys: "⇞ ⇟"),
            .init(action: "First or Last Event", keys: "↖ ↘"),
            .init(action: "Quick Look Tool Output or Image", keys: "Space"),
        ]),
        ShortcutGroup(title: "Timeline", items: [
            .init(action: "Zoom In", keys: "⌘+"),
            .init(action: "Zoom Out", keys: "⌘−"),
            .init(action: "Fit the Whole Scope", keys: "⌘0"),
            .init(action: "Zoom Out One Level", keys: "⎋"),
            .init(action: "Zoom Around the Pointer", keys: "⌘ Scroll"),
        ]),
        // View ▸ Session Mode, from any workspace.
        ShortcutGroup(title: "Session", items: SessionMode.allCases.map { mode in
            Shortcut(action: mode.title, keys: AgentSharkCommands.modeShortcut(mode).keys)
        }),
        ShortcutGroup(title: "Session · Steps", items: [
            .init(action: "Expand or Collapse a Turn", keys: "→ ←"),
            .init(action: "Previous or Next Turn", keys: "⌥↑ ⌥↓"),
            .init(action: "Show the Step's Call in Events", keys: "↩"),
        ]),
        ShortcutGroup(title: "Session · Transcript", items: [
            .init(action: "Find in Transcript", keys: "⌘F"),
            .init(action: "Next Match", keys: "↩  ⌘G"),
            .init(action: "Previous Match", keys: "⇧↩  ⇧⌘G"),
            .init(action: "Close Find", keys: "⎋"),
        ]),
        ShortcutGroup(title: "Session · Critical Path", items: [
            .init(action: "Previous or Next Segment", keys: "← →"),
            .init(action: "Previous or Next Lane", keys: "↑ ↓"),
            .init(action: "Zoom Out or In on the Track", keys: "⌘− ⌘+"),
            .init(action: "Fit the Path in the Track", keys: "⌘0"),
            .init(action: "Show the Selected Evidence in Session", keys: AppShortcut.showInSession.keys),
        ]),
        ShortcutGroup(title: "Session · Compare", items: [
            .init(action: "Previous or Next Row", keys: "↑ ↓"),
            .init(action: "Show Run A or B in the Inspector", keys: "← →"),
            .init(action: "Fold or Unfold Same Rows", keys: "Space"),
            .init(action: "Show the Chosen Side in Session", keys: AppShortcut.showInSession.keys),
        ]),
    ]

    private var shown: [ShortcutGroup] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return Self.groups }
        return Self.groups.compactMap { g in
            let items = g.items.filter { $0.action.lowercased().contains(q) || $0.keys.lowercased().contains(q) || g.title.lowercased().contains(q) }
            return items.isEmpty ? nil : ShortcutGroup(title: g.title, items: items)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Keyboard Shortcuts").font(.headline)
                Spacer()
                PanelKit.SearchField(text: $query, prompt: "Filter Shortcuts", focusRequest: 1, onEscape: { query = "" })
                    .frame(width: 220)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            Divider()
            ScrollView {
                if shown.isEmpty {
                    ContentUnavailableView.search(text: query).padding(.top, 40)
                } else {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 28, alignment: .top), GridItem(.flexible(), alignment: .top)],
                              alignment: .leading, spacing: 22) {
                        ForEach(shown) { group in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(group.title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                                ForEach(group.items, id: \.self) { s in
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(s.action)
                                        Spacer(minLength: 12)
                                        Text(s.keys)
                                            .font(.system(.body, design: .rounded).monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }
                                    .accessibilityElement(children: .combine)
                                }
                            }
                        }
                    }
                    .padding(20)
                }
            }
            Divider()
            HStack {
                Text("Shortcuts that name a workspace or the filter field work there only.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        }
        .frame(width: 760, height: 600)
    }
}
