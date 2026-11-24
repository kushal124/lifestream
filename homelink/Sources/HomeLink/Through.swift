import Foundation

public struct Through: Equatable, Sendable {
    public struct Month: Codable, Equatable, Sendable {
        public let items: Int
        public let bytes: Int64?

        public init(items: Int, bytes: Int64?) {
            self.items = items
            self.bytes = bytes
        }
    }

    public let readThrough: Date
    public let statedAt: Date
    public let left: Int?
    public let start: Date?
    public let months: [String: Month]?
    public let seal: Int?

    public init(readThrough: Date, statedAt: Date, left: Int? = nil, start: Date? = nil,
                months: [String: Month]? = nil, seal: Int? = nil) {
        self.readThrough = readThrough
        self.statedAt = statedAt
        self.left = left
        self.start = start
        self.months = months
        self.seal = seal
    }

    func stated(months owed: [String: Month]?) -> [String: Any] {
        var member: [String: Any] = ["read_through": Self.instant(readThrough), "stated_at": Self.instant(statedAt)]
        if let left {
            member["left"] = left
            member["start_ms"] = start.map { Sending.ms($0) as Any } ?? NSNull()
        }
        if let owed { member["months"] = Self.spelled(owed) }
        if let seal { member["seal"] = seal }
        return member
    }

    func with(months: [String: Month]?) -> Through {
        Through(readThrough: readThrough, statedAt: statedAt, left: left, start: start, months: months, seal: seal)
    }

    static func spelled(_ months: [String: Month]) -> [String: [Any]] {
        months.mapValues { [$0.items, $0.bytes ?? NSNull()] as [Any] }
    }

    static func instant(_ date: Date) -> String {
        let ms = Sending.ms(date)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let seconds = formatter.string(from: Date(timeIntervalSince1970: TimeInterval(ms / 1000)))
        return "\(seconds.dropLast()).\(String(format: "%03d", ms % 1000))Z"
    }
}
