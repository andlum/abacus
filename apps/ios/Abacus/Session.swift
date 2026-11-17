import Foundation
import Observation

// Where the server is and the token that signs in to it. The address is kept
// in UserDefaults; the token, which acts as the member, in the Keychain.
@MainActor
@Observable
final class Session {
    private static let serverKey = "serverURL"
    private static let tokenAccount = "api-token"

    private(set) var client: APIClient?

    init() {
        if let server = UserDefaults.standard.string(forKey: Self.serverKey),
           let url = URL(string: server),
           let token = Keychain.read(account: Self.tokenAccount) {
            client = APIClient(baseURL: url, token: token)
        }
    }

    // Checks the token against the server before keeping it.
    func signIn(server: String, token: String) async throws -> Me {
        let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed),
              url.scheme == "https" || url.scheme == "http" else {
            throw APIError.refused("That is not a web address.")
        }
        let candidate = APIClient(baseURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
        let me = try await candidate.me()
        guard Keychain.save(candidate.token, account: Self.tokenAccount) else {
            throw APIError.refused("The token is right, but this phone would not store it in the Keychain.")
        }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverKey)
        client = candidate
        return me
    }

    func signOut() {
        Keychain.delete(account: Self.tokenAccount)
        client = nil
    }
}
