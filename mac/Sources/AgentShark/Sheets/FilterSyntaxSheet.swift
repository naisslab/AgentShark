import SwiftUI

/// Help ▸ Filter Reference: the display-filter grammar, operators, units and time values, examples with Apply,
/// and the searchable list of fields. Presented by `Commands` as `FilterSyntaxSheet()`; it acts on the key window's
/// model, or on `model` when one is passed.
struct FilterSyntaxSheet: View {
    var model: WindowModel?
    @FocusedValue(\.windowModel) private var focusedModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage("filterReference.page") private var page: Page = .syntax
    @State private var fieldQuery = ""
    @State private var fieldSelection: Set<FieldInfo.ID> = []

    enum Page: String, CaseIterable, Identifiable {
        case syntax, examples, fields
        var id: String { rawValue }
        var title: String {
            switch self {
            case .syntax: return "Syntax"
            case .examples: return "Examples"
            case .fields: return "Fields"
            }
        }
    }

    init(model: WindowModel? = nil) {
        self.model = model
    }

    private var target: WindowModel? { model ?? focusedModel }
    private var fields: [FieldInfo] { target?.fields ?? AppModel.shared.fields }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                HStack {
                    Text("Filter Reference").font(.headline)
                    Spacer()
                }
                Picker("Page", selection: $page) {
                    ForEach(Page.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            Divider()
            Group {
                switch page {
                case .syntax: syntax
                case .examples: examples
                case .fields: fieldsPage
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            HStack {
                Text("Filters select events in Events, Statistics and Diagnostics. Sources ignore them; Conversation, Flow and Timeline say how they use them.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        }
        .frame(width: 800, height: 620)
    }

    // MARK: Syntax

    private static var syntaxSections: [(title: String, rows: [(String, String)])] {
        [
            ("Bare Words", [
                ("error", "A flag: error, inherited, dup, orphan, inferred, truncated, abandoned, meta, sidechain"),
                ("tool", "A layer matches every kind in it: session, user, llm, tool, agent, context, turn, hook, permission, harness, raw"),
                ("tool.call", "An event kind"),
                ("tool.exit_code", "A field: true when it is present and not false, 0 or empty"),
                ("\"rate limit\"", "A quoted string searches the full text: summary, message text, tool input and output"),
            ]),
            ("Comparisons", [
                ("==  eq", "Equal"), ("!=  ne", "Not equal"), (">  gt", "Greater than"), (">=  ge", "Greater than or equal"),
                ("<  lt", "Less than"), ("<=  le", "Less than or equal"),
                ("contains", "Case-insensitive substring: summary contains \"npm test\""),
                ("matches  ~", "Regular expression (JavaScript syntax): session.title matches \"^Fix\""),
                ("in {…}", "One of several values: tool.name in {\"Read\", \"Edit\"}"),
            ]),
            ("Logic", [
                ("&&  and", "Both conditions"), ("||  or", "Either condition"), ("!  not", "Negation"),
                ("( … )", "Grouping: (tool || llm) && error"),
            ]),
            ("Values and Units", [
                ("\"text\"", "Strings in double quotes; escape \" and \\ with a backslash"),
                ("5s  250ms  2m  1h  1d", "Durations: us, µs, ms, s, m, min, h, d. A bare number on a duration field is milliseconds."),
                ("2k  1.5M", "Counts: k or K (thousand), M (million)"),
                ("4KB  2MB  1GB", "Sizes in bytes (1 KB = 1,024 bytes)"),
                ("true  false", "Booleans"),
            ]),
            ("Times", [
                ("ts > -2h", "Relative to now; relative times need a sign"),
                ("ts >= \"\(today) 09:00\"", "Local time of this Mac (\(Formatters.utcOffset())); a date alone means its midnight"),
                ("ts < \"\(today)T09:00+02:00\"", "An explicit offset, or Z for UTC"),
            ]),
            ("Source Records", [
                ("native.message.model", "Any field of the original record, by its path. Slower than the indexed fields."),
                ("tokens.cache_read > 10k", "Normalized attributes; the Fields page lists them"),
            ]),
        ]
    }

    /// One grid for every section, so the descriptions line up.
    private var syntax: some View {
        ScrollView {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 5) {
                ForEach(Self.syntaxSections, id: \.title) { section in
                    GridRow {
                        Text(section.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.top, section.title == Self.syntaxSections.first?.title ? 0 : 14)
                            .gridCellColumns(2)
                    }
                    ForEach(section.rows, id: \.0) { row in
                        GridRow {
                            Text(row.0).font(Theme.fontSwiftUI(.code)).textSelection(.enabled)
                            Text(row.1).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private static var today: String {
        let c = Formatters.components(Int64(Date().timeIntervalSince1970 * 1e6), zone: Formatters.timeZone)
        return String(format: "%04d-%02d-%02d", c.year, c.month, c.day)
    }

    // MARK: Examples

    private static let examples: [(String, String)] = [
        ("Errors", "error"),
        ("Failed shell commands", #"tool.result && tool.exit_code != 0"#),
        ("Slow shell commands", #"tool.name == "Bash" && dur > 5s"#),
        ("File edits", #"tool.name in {"Edit", "Write", "MultiEdit", "apply_patch"}"#),
        ("MCP tool calls", #"tool.kind == "mcp""#),
        ("Large model outputs", "llm && tokens.output > 2000"),
        ("Heavy cache reads", "tokens.cache_read > 100k"),
        ("Thinking blocks", "llm.thinking"),
        ("Human prompts", "user.prompt"),
        ("Subagent activity", "agent"),
        ("Context compactions", "context.compaction"),
        ("Aborted turns", "turn.abort"),
        ("Codex sessions only", #"agent == "codex""#),
        ("Rate limits mentioned anywhere", #""rate limit""#),
        ("Summaries that mention a test run", #"summary contains "npm test""#),
        ("Sessions whose title starts with Fix", #"session.title matches "^Fix""#),
        ("Results without a call", "orphan"),
        ("Undecoded records", "raw.unknown"),
        ("Last two hours", "ts > -2h"),
        ("A field of the original record", #"native.message.stop_reason == "max_tokens""#),
    ]

    private var allExamples: [(String, String)] {
        var seen = Set(Self.examples.map(\.1))
        return Self.examples + Bookmarks.presets.compactMap { seen.insert($0.filter).inserted ? ($0.name, $0.filter) : nil }
    }

    private var examples: some View {
        let names = Set(fields.map(\.name))
        return List {
            ForEach(allExamples, id: \.1) { example in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(example.0)
                        Text(Self.highlighted(example.1, fields: names)).font(Theme.fontSwiftUI(.code)).textSelection(.enabled)
                    }
                    Spacer()
                    Button("Apply") {
                        target?.applyFilter(example.1)
                        dismiss()
                    }
                    .disabled(target == nil)
                    .help("Replace the current filter with this one")
                }
                .padding(.vertical, 2)
                .contextMenu {
                    Button("Apply") {
                        target?.applyFilter(example.1)
                        dismiss()
                    }
                    Button("Add to Current Filter") {
                        target?.applyFilter(fragment: example.1, mode: .andSelected)
                        dismiss()
                    }
                    Divider()
                    Button("Copy Filter") { AppKitHelpers.copy(example.1) }
                }
            }
        }
        .listStyle(.inset)
        .alternatingRowBackgrounds()
    }

    /// Filter text colored like the filter field.
    static func highlighted(_ text: String, fields: Set<String>) -> AttributedString {
        let ns = text as NSString
        var out = AttributedString()
        var at = 0
        for token in FilterSyntaxHighlighter.tokens(text, fields: fields) where token.range.location >= at {
            if token.range.location > at { out += AttributedString(ns.substring(with: NSRange(location: at, length: token.range.location - at))) }
            var piece = AttributedString(ns.substring(with: token.range))
            piece.foregroundColor = Color(nsColor: FilterSyntaxHighlighter.color(token.kind))
            out += piece
            at = token.range.location + token.range.length
        }
        if at < ns.length { out += AttributedString(ns.substring(from: at)) }
        return out
    }

    // MARK: Fields

    private var fieldsPage: some View {
        let q = fieldQuery.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = fields.filter {
            q.isEmpty || $0.name.lowercased().contains(q) || $0.description.lowercased().contains(q) || $0.type.contains(q)
        }
        return VStack(spacing: 0) {
            HStack {
                Text(Formatters.count(shown.count, "field")).foregroundStyle(.secondary).monospacedDigit()
                Spacer()
                PanelKit.SearchField(text: $fieldQuery, prompt: "Filter Fields", onEscape: { fieldQuery = "" })
                    .frame(width: 240)
            }
            .controlSize(.small)
            .padding(.horizontal, 20)
            .padding(.vertical, 6)
            if fields.isEmpty {
                ContentUnavailableView("Fields unavailable", systemImage: "list.bullet.rectangle",
                                       description: Text("The field list loads when the engine is running."))
            } else if shown.isEmpty {
                ContentUnavailableView.search(text: fieldQuery)
            } else {
                Table(shown, selection: $fieldSelection) {
                    TableColumn("Field") { (f: FieldInfo) in
                        Text(f.name).font(Theme.fontSwiftUI(.code)).textSelection(.enabled)
                    }
                    .width(min: 140, ideal: 200)
                    TableColumn("Type") { (f: FieldInfo) in Text(f.type).foregroundStyle(.secondary) }
                        .width(min: 56, ideal: 70)
                    TableColumn("Description") { (f: FieldInfo) in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(f.description).lineLimit(2)
                            if let values = f.values, !values.isEmpty {
                                Text(values.joined(separator: ", "))
                                    .font(Theme.fontSwiftUI(.code))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                        }
                        .help(([f.description] + (f.values.map { ["Values: " + $0.joined(separator: ", ")] } ?? [])).joined(separator: "\n"))
                    }
                }
                .contextMenu(forSelectionType: FieldInfo.ID.self) { ids in
                    if let name = ids.first {
                        Button("Copy Field Name") { AppKitHelpers.copy(name) }
                        Button("Add to Filter Field") {
                            dismiss()
                            target?.prepareFilter(fragment: name, mode: .andSelected)
                        }
                        .disabled(target == nil)
                    }
                }
            }
        }
    }
}
