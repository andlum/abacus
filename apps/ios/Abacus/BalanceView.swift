import SwiftUI

struct BalanceView: View {
    let client: APIClient
    let me: Me
    @Environment(Session.self) private var session
    @State private var balance: Balance?
    @State private var attention: Attention?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            CardList {
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                if let balance {
                    Section {
                        if balance.owes.isEmpty {
                            Text("All square.")
                        }
                        ForEach(balance.owes, id: \.self) { owe in
                            HStack {
                                Text("\(me.name(owe.from)) owe\(owe.from == me.me.id ? "" : "s") \(owe.to == me.me.id ? "you" : me.name(owe.to))")
                                Spacer()
                                Text(Money.format(owe.amountCents)).monospacedDigit().bold()
                            }
                        }
                    }
                }
                if let attention, attention.count > 0 {
                    Section("Needs attention on the web") {
                        ForEach(attention.needsAmount) { e in
                            Label("\(e.description): waiting for its amount", systemImage: "questionmark.circle")
                        }
                        ForEach(attention.unassigned) { e in
                            Label("\(e.description): \(e.unassignedReason ?? "no split")", systemImage: "exclamationmark.triangle")
                        }
                    }
                }
                if let balance {
                    Section("History") {
                        ForEach(balance.entries.reversed()) { entry in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(entry.description.isEmpty ? (entry.kind == "settlement" ? "Payment" : "Expense") : entry.description)
                                    Text(entry.date).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(Money.format(entry.effect[me.me.id] ?? 0)).monospacedDigit()
                                    .foregroundStyle((entry.effect[me.me.id] ?? 0) < 0 ? .red : .primary)
                            }
                        }
                    }
                }
            }
            .navigationTitle(me.household.name)
            .toolbar {
                Menu {
                    Text("Signed in as \(me.me.displayName)")
                    Button("Sign out", role: .destructive) { session.signOut() }
                } label: {
                    Image(systemName: "person.crop.circle")
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            async let b = client.balance()
            async let a = client.attention()
            (balance, attention) = try await (b, a)
            error = nil
        } catch APIError.signedOut {
            session.signOut()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
