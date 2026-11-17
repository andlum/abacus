import SwiftUI

// Loads who you are once, then shows the balance and every expense.
struct HomeView: View {
    let client: APIClient
    @Environment(Session.self) private var session
    @State private var me: Me?
    @State private var error: String?

    var body: some View {
        Group {
            if let me {
                TabView {
                    Tab("Balance", systemImage: "scalemass") {
                        BalanceView(client: client, me: me)
                    }
                    Tab("Expenses", systemImage: "list.bullet") {
                        ExpensesView(client: client, me: me)
                    }
                }
            } else if let error {
                ContentUnavailableView {
                    Label("Can't reach Clementine", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { Task { await load() } }
                    Button("Sign out", role: .destructive) { session.signOut() }
                }
            } else {
                ProgressView()
            }
        }
        .task { await load() }
    }

    private func load() async {
        error = nil
        do {
            me = try await client.me()
        } catch APIError.signedOut {
            session.signOut()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
