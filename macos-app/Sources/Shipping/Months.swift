import Darwin
import Foundation
import HomeLink

struct Months: Equatable, Sendable {
    static let undated = "undated"
    static let recount: TimeInterval = 86_400

    private(set) var stated: [String: Through.Month] = [:]

    init() {}

    static func key(seconds: Int64) -> String {
        var time = time_t(seconds)
        var parts = tm()
        guard gmtime_r(&time, &parts) != nil else { return undated }
        return String(format: "%04d-%02d", Int(parts.tm_year) + 1900, Int(parts.tm_mon) + 1)
    }

    static func key(nanoseconds: Int) -> String {
        key(seconds: Int64((Double(nanoseconds) / 1_000_000_000).rounded(.down)))
    }

    mutating func add(_ month: String?, items: Int, bytes: Int64) {
        let key = month ?? Self.undated
        let held = stated[key]
        stated[key] = Through.Month(items: (held?.items ?? 0) + items, bytes: (held?.bytes ?? 0) + bytes)
    }

    mutating func file(modifiedAt nanoseconds: Int, bytes: Int) {
        add(Self.key(nanoseconds: nanoseconds), items: 1, bytes: Int64(bytes))
    }

    mutating func add(_ other: Months) {
        for (key, month) in other.stated { add(key, items: month.items, bytes: month.bytes ?? 0) }
    }

    static func facts(_ owed: [String: Through.Month]?) -> [(String, JSONText)] {
        guard let owed else { return [] }
        let months = owed.keys.sorted(by: JSONText.javaScriptOrder).map { key in
            (key, JSONText.array([.int(owed[key]!.items), owed[key]!.bytes.map { .int(Int($0)) } ?? .null]))
        }
        return [("months", .object(months))]
    }

    var spelled: String {
        let object = stated.mapValues { [$0.items, $0.bytes ?? 0] }
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    init?(spelled: String) {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(spelled.utf8))) as? [String: [Int64]] else { return nil }
        for (key, pair) in object {
            guard pair.count == 2, let items = Int(exactly: pair[0]) else { return nil }
            stated[key] = Through.Month(items: items, bytes: pair[1])
        }
    }
}
