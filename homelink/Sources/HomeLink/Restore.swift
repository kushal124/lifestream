import CryptoKit
import Foundation

public enum WhichPhone: Sendable, Equatable {
    case unsaid
    case continuing(String)
    case another
}

public struct PhoneChoice: Sendable, Equatable {
    public let unit: String
    public let model: String
    public let account: String?
    public let lastShipped: Date?

    init?(_ object: [String: Any]) {
        guard let unit = object["unit"] as? String, let model = object["model"] as? String else { return nil }
        self.unit = unit
        self.model = model
        account = object["account"] as? String
        lastShipped = (object["last_ms"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
    }
}

public struct Restore: Sendable, Equatable {
    public struct Entry: Sendable, Equatable {
        public let kind: String
        public let observedAt: String
        public let payload: Data

        public init(kind: String, observedAt: String, payload: Data) {
            self.kind = kind
            self.observedAt = observedAt
            self.payload = payload
        }
    }

    public let pass: String
    public let unit: String
    public let sources: [String]
    public let since: [String: Date]
    public let types: [String: [String]]
    public let domains: [String: [Entry]]
    public let contacts: [String: [String]]

    public init(pass: String, unit: String, sources: [String] = [], since: [String: Date] = [:], types: [String: [String]] = [:],
                domains: [String: [Entry]] = [:], contacts: [String: [String]] = [:]) {
        self.pass = pass
        self.unit = unit
        self.sources = sources.sorted()
        self.since = since
        self.types = types
        self.domains = domains
        self.contacts = contacts
    }

    init?(body: Data) {
        guard let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let pass = object["pass"] as? String, let unit = object["unit"] as? String,
              let since = object["since"] as? [String: Any], let types = object["types"] as? [String: [String]],
              let domains = object["domains"] as? [String: Any], let contacts = object["contacts"] as? [String: [String]] else { return nil }
        self.pass = pass
        self.unit = unit
        sources = since.keys.sorted()
        self.since = since.compactMapValues { ($0 as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } }
        self.types = types
        var entries: [String: [Entry]] = [:]
        for (domain, list) in domains {
            guard let list = list as? [[String: Any]] else { return nil }
            var read: [Entry] = []
            for item in list {
                guard let kind = item["kind"] as? String, let observedAt = item["observed_at"] as? String,
                      let payload = item["payload"],
                      let bytes = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .fragmentsAllowed]) else { return nil }
                read.append(Entry(kind: kind, observedAt: observedAt, payload: bytes))
            }
            entries[domain] = read
        }
        self.domains = entries
        self.contacts = contacts
    }

    static func sha256(_ bytes: Data) -> String {
        "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
