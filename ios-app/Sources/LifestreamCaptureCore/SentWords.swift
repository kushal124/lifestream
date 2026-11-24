import Foundation
import HomeLink

public enum SentWords {
    public static func words(of type: String, count: Int, in kinds: [HomeLink.PrivacyState.Kind]) -> String {
        let said: (one: String, many: String)? = kinds.lazy.compactMap { kind in
            kind.type == type ? (kind.one, kind.many) : kind.subtypes.first { $0.type == type }.map { ($0.one, $0.many) }
        }.first
        guard let said else { return type }
        return count == 1 ? said.one : said.many
    }

    public static func hidden(_ counts: [String: Int], kinds: [HomeLink.PrivacyState.Kind]) -> String {
        counts.filter { $0.value > 0 }.sorted { ($1.value, $0.key) < ($0.value, $1.key) }
            .map { type, count in "\(Words.count(count)) \(words(of: type, count: count, in: kinds)) \(type == "face" ? "covered" : "hidden")" }
            .joined(separator: Words.dot)
    }

    public static func hid(_ row: HomeLink.Outbound, kinds: [HomeLink.PrivacyState.Kind]) -> String {
        let details = hidden(row.counts, kinds: kinds)
        if !details.isEmpty { return details }
        return row.level == .named("none") ? "Sent as it was" : "Nothing to hide"
    }

    public static func hider(_ row: HomeLink.Outbound) -> String? {
        guard row.counts.values.contains(where: { $0 > 0 }) else { return nil }
        return row.detector == nil ? "What Lifestream knows" : "The hiding model"
    }

    public static func to(_ row: HomeLink.Outbound, now: Date = AppClock.now) -> String {
        "Sent to \(row.receiver), " + Words.shortDate(Words.date(ms: row.atMs), now: now, weekday: false)
    }

    public static func fact(_ row: HomeLink.Outbound, kinds: [HomeLink.PrivacyState.Kind], now: Date = AppClock.now) -> String {
        let how = hid(row, kinds: kinds)
        return to(row, now: now) + Words.dot + how.prefix(1).lowercased() + how.dropFirst()
    }
}
