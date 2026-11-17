import SwiftUI

struct SignInView: View {
    @Environment(Session.self) private var session
    @State private var server = ""
    @State private var token = ""
    @State private var error: String?
    @State private var working = false

    var body: some View {
        NavigationStack {
            CardForm {
                Image("Mark")
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                Section {
                    // Verbatim: as a plain literal SwiftUI reads the placeholder as
                    // Markdown and shows the address as a blue link.
                    TextField("Server", text: $server, prompt: Text(verbatim: "https://abacus.example.com"))
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("abk_…", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Make a token on the web app under Settings → Devices. It is shown once; paste it here.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Button(working ? "Connecting…" : "Connect") {
                    Task { await connect() }
                }
                .disabled(working || server.isEmpty || token.isEmpty)
            }
            .navigationTitle("Clementine")
        }
    }

    private func connect() async {
        working = true
        defer { working = false }
        do {
            _ = try await session.signIn(server: server, token: token)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
