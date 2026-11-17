import Foundation

enum APIError: LocalizedError {
    case signedOut
    case notFound(String)
    // The server's own words for why it said no, fit to show the person.
    case refused(String)
    case server(Int)

    var errorDescription: String? {
        switch self {
        case .signedOut: "This device was disconnected. Sign in again with a new token."
        case .notFound(let message), .refused(let message): message
        case .server(let status): "The server had a problem (\(status)). Try again."
        }
    }
}

// Calls /api/v1 as described in the server's openapi.json. The server works
// out every split; this only sends what the person typed and shows what
// comes back.
struct APIClient: Sendable {
    let baseURL: URL
    let token: String

    func me() async throws -> Me { try await get("me") }
    func balance() async throws -> Balance { try await get("balance") }
    func attention() async throws -> Attention { try await get("attention") }
    func expenses(month: String) async throws -> [Expense] {
        let page: MonthExpenses = try await get("months/\(month)/expenses")
        return page.expenses
    }
    // Every expense of the group, newest first. Pass the last page's
    // `nextCursor` for the page after it.
    func expenses(cursor: String? = nil, limit: Int = 50) async throws -> ExpenseList {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get("expenses", query: query)
    }
    func preview(_ draft: NewExpense) async throws -> SplitPreview { try await post("expenses/preview", draft) }
    func create(_ draft: NewExpense) async throws -> Expense { try await post("expenses", draft) }
    func void(expense id: String) async throws -> Expense { try await post("expenses/\(id)/void", Empty()) }
    func settlements() async throws -> [Settlement] {
        let list: SettlementList = try await get("settlements")
        return list.settlements
    }
    func record(_ payment: NewSettlement) async throws -> Settlement { try await post("settlements", payment) }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await send(request(path, method: "GET", query: query))
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T {
        var req = request(path, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        return try await send(req)
    }

    private func request(_ path: String, method: String, query: [URLQueryItem] = []) -> URLRequest {
        var url = baseURL.appending(path: "api/v1/\(path)")
        if !query.isEmpty { url.append(queryItems: query) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
        switch status {
        case 200..<300: return try JSONDecoder().decode(T.self, from: data)
        case 401: throw APIError.signedOut
        case 404: throw APIError.notFound(message ?? "Not found.")
        case 400..<500: throw APIError.refused(message ?? "The server refused that.")
        default: throw APIError.server(status)
        }
    }
}

private struct ErrorBody: Decodable { let error: String }
private struct Empty: Encodable {}
private struct MonthExpenses: Decodable { let month: String; let expenses: [Expense] }
private struct SettlementList: Decodable { let settlements: [Settlement] }
