import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Settings ▸ Coloring Rules (MAC-SPEC §8): an ordered list; the first enabled rule that matches colors a row.
struct ColoringRulesSettingsView: View {
    let app: AppModel
    @Bindable var rules: ColorRules
    @State private var selection: Set<String> = []
    @State private var importError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("The first enabled rule whose filter matches an event colors its row: the text color, the background (a leading bar and a light wash) and an outline that frames the row, which the failure tiers use. Drag rules to reorder them. Each rule has separate colors for Light and Dark appearance.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            header
            List(selection: $selection) {
                ForEach($rules.rules) { $rule in
                    ColorRuleRow(rule: $rule, api: app.liveEngine.api)
                        .tag(rule.id)
                }
                .onMove { rules.move(fromOffsets: $0, toOffset: $1) }
            }
            .listStyle(.bordered)
            .alternatingRowBackgrounds()
            .frame(minHeight: 320)
            .onDeleteCommand { rules.remove(ids: selection) }
            toolbar
        }
        .padding(20)
        .frame(width: 940, height: 520)
        .alert("Could Not Import Coloring Rules", isPresented: Binding(get: { importError != nil }, set: { if !$0 { importError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(importError ?? "")
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("On").frame(width: 24)
            Text("Name").frame(width: 150, alignment: .leading)
            Text("Filter").frame(maxWidth: .infinity, alignment: .leading)
            Text("Text").frame(width: 64)
            Text("Background").frame(width: 64)
            Text("Outline").frame(width: 150)
            Text("Preview").frame(width: 72)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .accessibilityHidden(true)
    }

    private var toolbar: some View {
        HStack(spacing: 6) {
            ControlGroup {
                Button {
                    let index = rules.rules.firstIndex { selection.contains($0.id) }
                    let rule = ColorRule(name: "New Rule", filter: "", background: ColorRules.palette["blue"])
                    rules.add(rule, at: index)
                    selection = [rule.id]
                } label: {
                    Image(systemName: "plus")
                }
                .iconHelp("Add a rule")
                Button {
                    rules.remove(ids: selection)
                    selection = []
                } label: {
                    Image(systemName: "minus")
                }
                .iconHelp("Remove the selected rules")
                .disabled(selection.isEmpty)
            }
            .fixedSize()
            Spacer()
            Button("Restore Defaults") { rules.restoreDefaults() }
            Button("Import…", action: importRules)
            Button("Export…", action: exportRules)
        }
    }

    private func importRules() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.message = "Choose a coloring rules file (JSON)"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                try rules.importData(try Data(contentsOf: url))
            } catch {
                importError = error.localizedDescription
            }
        }
    }

    private func exportRules() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "AgentShark Coloring Rules.json"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                try rules.exportData().write(to: url, options: .atomic)
            } catch {
                importError = error.localizedDescription
            }
        }
    }
}

/// One editable rule with live filter validation.
private struct ColorRuleRow: View {
    @Binding var rule: ColorRule
    let api: APIClient?
    @State private var check: FilterCheck?

    var body: some View {
        HStack(spacing: 8) {
            Toggle("Enabled", isOn: $rule.enabled)
                .labelsHidden()
                .frame(width: 24)
                .help(rule.enabled ? "Disable this rule" : "Enable this rule")
            TextField("Name", text: $rule.name)
                .labelsHidden()
                .frame(width: 150)
            HStack(spacing: 4) {
                TextField("Filter", text: $rule.filter, prompt: Text("tool.kind == \"shell\""))
                    .labelsHidden()
                    .font(Theme.fontSwiftUI(.code))
                validationIcon
            }
            .frame(maxWidth: .infinity)
            HStack(spacing: 2) {
                ColorSlot(color: $rule.foreground, variant: \.light, name: "text color (Light)", fallback: "#1B1F24")
                ColorSlot(color: $rule.foreground, variant: \.dark, name: "text color (Dark)", fallback: "#E6E8EB")
            }
            .frame(width: 64)
            HStack(spacing: 2) {
                ColorSlot(color: $rule.background, variant: \.light, name: "background (Light)", fallback: "#1F5FBF")
                ColorSlot(color: $rule.background, variant: \.dark, name: "background (Dark)", fallback: "#6EA8FF")
            }
            .frame(width: 64)
            HStack(spacing: 2) {
                ColorSlot(color: $rule.outline, variant: \.light, name: "outline (Light)", fallback: "#BD2828")
                ColorSlot(color: $rule.outline, variant: \.dark, name: "outline (Dark)", fallback: "#FF7B72")
                Picker("Outline style", selection: Binding(get: { rule.outlineStyle ?? .solid }, set: { rule.outlineStyle = $0 })) {
                    ForEach(OutlineStyle.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .labelsHidden()
                .fixedSize()
                .disabled(rule.outline == nil)
                .help("How the outline is drawn")
            }
            .frame(width: 150)
            RulePreview(rule: rule).frame(width: 72)
        }
        .padding(.vertical, 2)
        .opacity(rule.enabled ? 1 : 0.6)
        .task(id: rule.filter) { await validate() }
    }

    @ViewBuilder private var validationIcon: some View {
        if rule.filter.trimmingCharacters(in: .whitespaces).isEmpty {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.orange).iconHelp("Empty filter: this rule never matches")
        } else if let check {
            if check.ok, let warning = check.warning {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow).iconHelp(warning)
            } else if check.ok {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).iconHelp("Valid filter")
            } else {
                Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
                    .iconHelp(check.error?.message ?? "Invalid filter: this rule is skipped")
            }
        } else {
            Image(systemName: "circle.dotted").foregroundStyle(.secondary).iconHelp("Not validated: the engine is not running")
        }
    }

    private func validate() async {
        let text = rule.filter
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty, let api else {
            check = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(200))
        guard !Task.isCancelled, let result = try? await api.validate(text), !Task.isCancelled else { return }
        check = result
    }
}

/// A color well for one appearance of an optional light/dark pair; "+" adds the pair.
private struct ColorSlot: View {
    @Binding var color: RuleColor?
    let variant: WritableKeyPath<RuleColor, String>
    let name: String
    let fallback: String

    var body: some View {
        if let pair = color {
            ColorPicker(name.capitalized, selection: Binding(
                get: { Color(nsColor: NSColor(hexString: pair[keyPath: variant]) ?? .gray) },
                set: { new in
                    var p = color ?? pair
                    p[keyPath: variant] = NSColor(new).hexString
                    color = p
                }), supportsOpacity: false)
                .labelsHidden()
                .help("Set the \(name)")
                .contextMenu { Button("Remove Color") { color = nil } }
        } else {
            Button {
                color = RuleColor(light: fallback, dark: fallback)
            } label: {
                Image(systemName: "plus.circle").symbolRenderingMode(.hierarchical)
            }
            .buttonStyle(.borderless)
            .frame(width: 28)
            .iconHelp("Add a \(name)")
        }
    }
}

/// How a row colored by the rule looks in the current appearance.
private struct RulePreview: View {
    let rule: ColorRule

    var body: some View {
        let bg = rule.background?.nsColor
        HStack(spacing: 0) {
            Rectangle().fill(Color(nsColor: bg ?? .clear)).frame(width: Theme.kindBarWidth)
            Text("Aa 12:03")
                .font(Theme.fontSwiftUI(.code))
                .foregroundStyle(Color(nsColor: rule.foreground?.nsColor ?? .labelColor))
                .padding(.horizontal, 6)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(height: 18)
        .background(Color(nsColor: bg.map(Theme.rowTint) ?? .clear))
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .overlay {
            if let outline = rule.outline {
                Rectangle().strokeBorder(Color(nsColor: outline.nsColor),
                                         style: StrokeStyle(lineWidth: 1, dash: (rule.outlineStyle ?? .solid).dashPattern?.map { CGFloat($0.doubleValue) } ?? []))
            } else {
                RoundedRectangle(cornerRadius: 3).strokeBorder(.separator)
            }
        }
        .accessibilityHidden(true)
    }
}
