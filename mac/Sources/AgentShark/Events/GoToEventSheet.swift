import SwiftUI

/// Go ▸ Go to Event… (⌘L): a row number in the current view, or an event ID.
struct GoToEventSheet: View {
    @Bindable var model: WindowModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var problem: String?
    @State private var isLocating = false
    @FocusState private var focused: Bool

    private var count: Int { model.view?.count ?? 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Go to Event").font(.headline)
            TextField("Event number or ID:", text: $text, prompt: Text(count > 0 ? "1–\(Formatters.count(count))" : "No events"))
                .font(Theme.dataFontSwiftUI(size: 13))
                .focused($focused)
                .onSubmit(go)
            Text(problem ?? "Enter a row number in the current view, or an event ID such as s_3f9a0c1b2d4e:812.")
                .font(.callout)
                .foregroundStyle(problem == nil ? Color.secondary : Color.red)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                if isLocating { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Go", action: go)
                    .keyboardShortcut(.defaultAction)
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || count == 0 || isLocating)
            }
        }
        .padding(20)
        .frame(width: 380)
        .onAppear {
            if let row = model.selectedRow { text = String(row + 1) }
            focused = true
        }
    }

    private func go() {
        let input = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "")
        guard !input.isEmpty, let view = model.view else { return }
        if let n = Int(input) {
            guard (1...view.count).contains(n) else {
                problem = "The current view has events 1–\(Formatters.count(view.count))."
                return
            }
            model.goToRow(number: n)
            dismiss()
            return
        }
        guard let api = model.engine.api else { return }
        isLocating = true
        Task {
            let no = (try? await api.locate(view: view.viewId, event: input)) ?? nil
            isLocating = false
            if no != nil {
                model.select(event: input)
                dismiss()
            } else {
                problem = "That event is not in the current view. Check the ID, or widen the filter and scope."
            }
        }
    }
}
