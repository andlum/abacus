import SwiftUI

struct MonthView: View {
    let client: APIClient
    let me: Me
    @Environment(Session.self) private var session
    @State private var month: String
    @State private var expenses: [Expense] = []
    @State private var error: String?
    @State private var adding = false

    init(client: APIClient, me: Me) {
        self.client = client
        self.me = me
        _month = State(initialValue: String(me.today.prefix(7)))
    }

    var body: some View {
        NavigationStack {
            CardList {
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                if expenses.isEmpty && error == nil {
                    Text("Nothing this month.").foregroundStyle(.secondary)
                }
                ForEach(expenses) { e in
                    ExpenseRow(expense: e, me: me)
                        .swipeActions {
                            if e.status == "posted" {
                                Button("Void", role: .destructive) { Task { await void(e) } }
                            }
                        }
                }
            }
            .navigationTitle(month)
            .toolbar {
                ToolbarItemGroup(placement: .topBarLeading) {
                    Button { step(-1) } label: { Image(systemName: "chevron.left") }
                    Button { step(1) } label: { Image(systemName: "chevron.right") }
                        .disabled(month >= String(me.today.prefix(7)))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { adding = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) {
                AddExpenseView(client: client, me: me)
            }
            .refreshable { await load() }
            .task(id: month) { await load() }
        }
    }

    // "2026-01" stepped by one month either way.
    private func step(_ by: Int) {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return }
        let index = parts[0] * 12 + (parts[1] - 1) + by
        month = String(format: "%04d-%02d", index / 12, index % 12 + 1)
    }

    private func load() async {
        do {
            expenses = try await client.expenses(month: month)
            error = nil
        } catch APIError.signedOut {
            session.signOut()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func void(_ e: Expense) async {
        do {
            _ = try await client.void(expense: e.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ExpenseRow: View {
    let expense: Expense
    let me: Me

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(expense.description).strikethrough(expense.status == "void")
                Text("\(expense.date) · \(me.name(expense.payerId)) paid · \(me.categoryLabel(expense.category))")
                    .font(.caption).foregroundStyle(.secondary)
                if let account = me.accountLabel(expense.accountId) {
                    Text("from \(account)").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            VStack(alignment: .trailing) {
                Text(expense.totalCents.map(Money.format) ?? "—").monospacedDigit()
                if let mine = expense.shares[me.me.id] {
                    Text("your segment \(Money.format(mine))").font(.caption).foregroundStyle(.secondary)
                } else if expense.status != "posted" {
                    Text(expense.status).font(.caption).foregroundStyle(.orange)
                }
            }
        }
        .opacity(expense.status == "void" ? 0.5 : 1)
    }
}
