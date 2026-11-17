import SwiftUI

// Every expense of the group, newest first, a page at a time. The next page
// loads when the last row appears; pulling down starts over from the top.
struct ExpensesView: View {
    let client: APIClient
    let me: Me
    @Environment(Session.self) private var session
    @State private var expenses: [Expense] = []
    @State private var nextCursor: String?
    @State private var count = 0
    @State private var totalCents = 0
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var error: String?
    // Why the next page did not load; shown at the bottom with a retry.
    @State private var moreError: String?
    @State private var adding = false
    @State private var byMonth = false

    var body: some View {
        NavigationStack {
            CardList {
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                if loaded && expenses.isEmpty && error == nil {
                    Text("No expenses yet.").foregroundStyle(.secondary)
                }
                if count > 0 {
                    Text("\(count == 1 ? "1 expense" : "\(count) expenses") · \(Money.format(totalCents))")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(expenses) { e in
                    ExpenseRow(expense: e, me: me)
                        .swipeActions {
                            if e.status == "posted" {
                                Button("Void", role: .destructive) { Task { await void(e) } }
                            }
                        }
                        .task {
                            if e.id == expenses.last?.id { await loadMore() }
                        }
                }
                if nextCursor != nil {
                    if let moreError {
                        VStack(spacing: 8) {
                            Text(moreError).foregroundStyle(.red)
                            Button("Try again") { Task { await loadMore() } }
                        }
                        .frame(maxWidth: .infinity)
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
            }
            .navigationTitle("Expenses")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("By month") { byMonth = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { adding = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $adding, onDismiss: { Task { await reload() } }) {
                AddExpenseView(client: client, me: me)
            }
            .sheet(isPresented: $byMonth, onDismiss: { Task { await reload() } }) {
                MonthView(client: client, me: me)
            }
            .refreshable { await reload() }
            .task { await reload() }
        }
    }

    // The first page again, replacing what was shown.
    private func reload() async {
        do {
            let page = try await client.expenses()
            expenses = page.expenses
            nextCursor = page.nextCursor
            count = page.count
            totalCents = page.totalCents
            error = nil
            moreError = nil
        } catch APIError.signedOut {
            session.signOut()
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        moreError = nil
        defer { loadingMore = false }
        do {
            let page = try await client.expenses(cursor: cursor)
            // A reload while this page was on its way wins.
            guard cursor == nextCursor else { return }
            let seen = Set(expenses.map(\.id))
            expenses += page.expenses.filter { !seen.contains($0.id) }
            nextCursor = page.nextCursor
            count = page.count
            totalCents = page.totalCents
        } catch APIError.signedOut {
            session.signOut()
        } catch {
            // Only for the page still asked for: a reload meanwhile starts over.
            guard cursor == nextCursor else { return }
            moreError = error.localizedDescription
        }
    }

    private func void(_ e: Expense) async {
        do {
            _ = try await client.void(expense: e.id)
            await reload()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
