import SwiftUI

// Adds a one-time expense split by the household's rules. The server
// previews the split as the amount is typed; the phone never works one out.
struct AddExpenseView: View {
    let client: APIClient
    let me: Me
    @Environment(\.dismiss) private var dismiss
    @State private var description = ""
    @State private var amount = ""
    @State private var category = "other"
    @State private var payerId: String
    @State private var date = Date()
    @State private var preview: SplitPreview?
    @State private var error: String?
    @State private var saving = false

    init(client: APIClient, me: Me) {
        self.client = client
        self.me = me
        _payerId = State(initialValue: me.me.id)
    }

    private var draft: NewExpense? {
        guard let cents = Money.parse(amount), cents > 0 else { return nil }
        return NewExpense(description: description, totalCents: cents, date: Self.iso(date), category: category, payerId: payerId)
    }

    var body: some View {
        NavigationStack {
            CardForm {
                TextField("What was it?", text: $description)
                TextField("Amount", text: $amount).keyboardType(.decimalPad)
                Picker("Category", selection: $category) {
                    ForEach(me.categories) { Text($0.label).tag($0.slug) }
                }
                Picker("Paid by", selection: $payerId) {
                    ForEach(me.members) { Text(me.name($0.id)).tag($0.id) }
                }
                DatePicker("Date", selection: $date, in: ...Date(), displayedComponents: .date)
                if let preview {
                    Section("Split") {
                        if preview.ok, let shares = preview.shares {
                            ForEach(me.members) { m in
                                LabeledContent(me.name(m.id), value: Money.format(shares[m.id] ?? 0))
                            }
                            if let rule = preview.rule { Text(rule).font(.caption) }
                        }
                        Text(preview.why).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .navigationTitle("New expense")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await save() } }
                        .disabled(saving || draft == nil || description.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .task(id: "\(amount)|\(category)|\(payerId)|\(Self.iso(date))") { await refreshPreview() }
        }
    }

    private func refreshPreview() async {
        guard let draft else { preview = nil; return }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        preview = try? await client.preview(draft)
    }

    private func save() async {
        guard let draft else { return }
        saving = true
        defer { saving = false }
        do {
            _ = try await client.create(draft)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // The phone's calendar date. The server checks it against the
    // household's today and refuses a date in the future.
    static func iso(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
