import Foundation

// Hand-written to match the schemas in apps/web/src/lib/openapi.ts. Money is
// whole cents; dates are YYYY-MM-DD strings in the household's timezone.

struct Member: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
}

// One of the group's categories. An expense names it by `slug`.
struct Category: Codable, Identifiable, Hashable, Sendable {
    let slug: String
    let label: String
    var id: String { slug }
}

// A card or account the group pays from. `kind` is "personal" or "business"
// in a business group and nil in a household.
struct Account: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let lastFour: String?
    let kind: String?
    let archived: Bool
}

struct Me: Codable, Sendable {
    struct Person: Codable, Sendable { let id: String; let displayName: String; let email: String }
    struct Household: Codable, Sendable { let id: String; let name: String; let kind: String; let timezone: String }
    let me: Person
    let household: Household
    let members: [Member]
    // The categories to offer when adding an expense; removed ones are left out.
    let categories: [Category]
    // The group's accounts, archived ones included. Optional so an older
    // server that sends none still decodes.
    let accounts: [Account]?
    let today: String

    func name(_ id: String) -> String {
        id == me.id ? "You" : members.first { $0.id == id }?.displayName ?? "Someone"
    }

    // What a category is called; its slug when it is removed or unknown.
    func categoryLabel(_ slug: String) -> String {
        categories.first { $0.slug == slug }?.label ?? slug
    }

    // "Business card ··4242", as the web app writes it; nil when not recorded.
    func accountLabel(_ id: String?) -> String? {
        guard let id, let a = accounts?.first(where: { $0.id == id }) else { return nil }
        return a.lastFour.map { "\(a.name) ··\($0)" } ?? a.name
    }
}

struct Expense: Codable, Identifiable, Sendable {
    let id: String
    let date: String
    let description: String
    let category: String
    let totalCents: Int?
    let payerId: String
    let status: String
    let source: String
    let ruleSource: String?
    let unassignedReason: String?
    let templateLineageId: String?
    let period: String?
    let supersedesId: String?
    // The account it was paid from, if one was recorded.
    let accountId: String?
    let shares: [String: Int]
    let createdAt: String
}

// One page of GET /expenses. `count` and `totalCents` cover every match,
// not only this page; `nextCursor` is nil on the last page.
struct ExpenseList: Codable, Sendable {
    let expenses: [Expense]
    let nextCursor: String?
    let count: Int
    let totalCents: Int
}

struct Balance: Codable, Sendable {
    struct Owes: Codable, Hashable, Sendable { let from: String; let to: String; let amountCents: Int }
    struct Entry: Codable, Identifiable, Sendable {
        let kind: String
        let id: String
        let date: String
        let description: String
        let effect: [String: Int]
    }
    // Only in a business group: what it owes the members who paid its
    // costs on a personal account.
    struct OwedBack: Codable, Sendable {
        struct Member: Codable, Hashable, Sendable {
            let memberId: String
            let personalPaidCents: Int
            let repaidCents: Int
            let owedCents: Int
        }
        let members: [Member]
        let untaggedCount: Int
        let untaggedCents: Int
    }
    let net: [String: Int]
    let owes: [Owes]
    let entries: [Entry]
    let owedBack: OwedBack?
}

struct Attention: Codable, Sendable {
    struct OnDefault: Codable, Sendable { let lineageId: String; let name: String; let category: String }
    let needsAmount: [Expense]
    let unassigned: [Expense]
    let onDefault: [OnDefault]
    let count: Int
}

struct Settlement: Codable, Identifiable, Sendable {
    let id: String
    let fromMemberId: String
    let toMemberId: String
    let amountCents: Int
    let date: String
    let note: String
    let status: String
    // The payment this one replaced when it was edited; nil when none.
    let supersedesId: String?
    let createdAt: String
    let createdBy: String
}

// A new one-time expense. Left out, `rule` means the household's rules.
struct NewExpense: Encodable, Sendable {
    var description: String
    var totalCents: Int
    var date: String?
    var category: String?
    var payerId: String?
}

struct NewSettlement: Encodable, Sendable {
    var fromMemberId: String
    var toMemberId: String
    var amountCents: Int
    var date: String?
    var note: String?
}

// The server's answer to "what would this split to?". When `ok` is false,
// only `rule`, `why` and `reason` are present.
struct SplitPreview: Decodable, Sendable {
    let ok: Bool
    let shares: [String: Int]?
    let rule: String?
    let why: String
    let reason: String?
    let effect: String?
}

// ---- Card review ------------------------------------------------------------
// GET /accounts, /accounts/{id}, /accounts/{id}/review and the POST that adds
// the picked purchases. `cardMode` is "shared" or "personal".

struct CardPayment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let accountId: String
    let date: String
    let amountCents: Int
    let mode: String
    // The shared expense the payment made; nil on a personal card.
    let expenseId: String?
    let stillSharedCents: Int
}

struct CardLine: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let lastFour: String?
    let institutionName: String
    let cardMode: String
    let shareAll: Bool
    let reviewedThrough: String?
    let needsRelink: Bool
    let latestPayment: CardPayment?
}

struct CardList: Codable, Sendable {
    let accounts: [CardLine]
}

// One card with its payments, newest first.
struct CardAccount: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let lastFour: String?
    let institutionName: String
    let cardMode: String
    let shareAll: Bool
    let reviewedThrough: String?
    let needsRelink: Bool
    let latestPayment: CardPayment?
    let payments: [CardPayment]
}

// The body of PATCH /accounts/{id}.
struct CardModeChange: Codable, Sendable {
    var cardMode: String
}

struct CardReviewLine: Codable, Identifiable, Hashable, Sendable {
    struct Suggestion: Codable, Hashable, Sendable {
        // "recurring", "bill" or "added" (already an expense; picking it takes it out of the payment).
        let kind: String
        let expenseId: String
        let name: String
    }
    let plaidTransactionId: String
    let date: String
    // Negative for money in.
    let amountCents: Int
    let description: String
    let moneyIn: Bool
    // Money in that is a payment to the card, not a refund.
    let cardPayment: Bool
    let addedExpenseId: String?
    let suggestion: Suggestion?
    let ticked: Bool
    var id: String { plaidTransactionId }
}

struct CardReview: Codable, Sendable {
    struct Card: Codable, Sendable {
        let id: String
        let name: String
        let lastFour: String?
        let cardMode: String
    }
    let account: Card
    let from: String
    let to: String
    let payment: CardPayment?
    let payments: [CardPayment]
    let lines: [CardReviewLine]
}

// GET /accounts/{id}/payments/past: a shared card's payments of the last 90
// days that are not shared yet.
struct PastCardPayment: Codable, Identifiable, Hashable, Sendable {
    let plaidTransactionId: String
    let date: String
    // What was paid, positive.
    let amountCents: Int
    let description: String
    // The payment recorded while the card was personal; nil when never seen.
    let paymentId: String?
    var id: String { plaidTransactionId }
}

struct PastCardPayments: Codable, Sendable {
    let payments: [PastCardPayment]
}

// The body of POST /accounts/{id}/payments; it answers with the CardPayment.
struct CardPaymentShare: Codable, Sendable {
    var plaidTransactionId: String
}

// One purchase picked in a review. The split rule is left out until the app
// has a model for rules; the server then uses the group's own.
struct CardReviewPick: Codable, Sendable {
    var plaidTransactionId: String
    var description: String?
    var category: String?
    var tieTo: String?
}

// The body of POST /accounts/{id}/review.
struct CardReviewSubmit: Codable, Sendable {
    var payment: String?
    var from: String?
    var items: [CardReviewPick]
}

struct CardReviewResult: Codable, Sendable {
    let expenses: [Expense]
    // The shared payment's expense after the purchases came out of it.
    let paymentExpense: Expense?
    let from: String
    let to: String
}
