import Foundation

enum Money {
    // 123456 → "$1,234.56". Formatting only; no arithmetic leaves integers.
    static func format(_ cents: Int) -> String {
        let sign = cents < 0 ? "-" : ""
        let whole = abs(cents) / 100
        let rest = abs(cents) % 100
        return "\(sign)$\(whole.formatted(.number.grouping(.automatic))).\(rest < 10 ? "0" : "")\(rest)"
    }

    // "12.5" or "$12.50" → 1250. Nil for anything that is not an amount with
    // at most two decimal places.
    static func parse(_ text: String) -> Int? {
        let cleaned = text.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespaces)
        let parts = cleaned.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count), let whole = Int(parts[0].isEmpty ? "0" : parts[0]), whole >= 0 else { return nil }
        guard parts.count == 2 else { return whole * 100 }
        let fraction = parts[1]
        guard fraction.count <= 2, fraction.allSatisfy(\.isNumber) else { return nil }
        let padded = fraction.padding(toLength: 2, withPad: "0", startingAt: 0)
        return whole * 100 + (Int(padded) ?? 0)
    }
}
