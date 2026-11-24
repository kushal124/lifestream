import Foundation

extension HomeLink {
    public struct CountTableQuery: Sendable, Equatable {
        public struct Match: Sendable, Equatable {
            public let key: String
            public let value: String

            public init(_ key: String, whole value: String) {
                self.key = key
                self.value = "=" + value
            }
        }

        public var of: String
        public var match: [Match]
        public var measure: String?
        public var op: String?
        public var by: [String]
        public var order: String?
        public var limit: Int?
        public var from: String?
        public var to: String?
        public var cursor: String?

        public init(of: String, match: [Match] = [], measure: String? = nil, op: String? = nil, by: [String] = [],
                    order: String? = nil, limit: Int? = nil, from: String? = nil, to: String? = nil, cursor: String? = nil) {
            self.of = of
            self.match = match
            self.measure = measure
            self.op = op
            self.by = by
            self.order = order
            self.limit = limit
            self.from = from
            self.to = to
            self.cursor = cursor
        }
    }

    public struct CountTable: Decodable, Sendable, Equatable {
        public struct Total: Decodable, Sendable, Equatable {
            public let n: Int
            public let sum: JSON?
            public let ref: String?
        }

        public let asked: String
        public let held: HeldDays?
        public let total: Total?
        public let columns: [String]
        public let rows: [[JSON]]
        public let next: String?

        public func value(_ column: String, in row: [JSON]) -> JSON? {
            columns.firstIndex(of: column).flatMap { $0 < row.count ? row[$0] : nil }
        }
    }

    public func searchKind(_ key: PageKey) async throws -> Pages.SearchKind {
        try await Self.paged {
            guard let answer = try await page(key, etag: nil) else { throw LinkFailure.unreadable(304) }
            return try JSONDecoder().decode(Pages.SearchKind.self, from: answer.value)
        }
    }

    public func countTable(_ query: CountTableQuery) async throws -> CountTable {
        try await Self.paged {
            guard let response = try await get("/v1/count", Self.parameters(query)) else { throw LinkFailure.unreadable(304) }
            return try Self.decoded(CountTable.self, response)
        }
    }

    public struct CursorExpired: Error, Sendable, Equatable, CustomStringConvertible {
        public let description: String

        public init(_ description: String) {
            self.description = description
        }
    }

    static func paged<Value>(_ read: () async throws -> Value) async throws -> Value {
        do {
            return try await read()
        } catch LinkFailure.refused(409, "CURSOR_EXPIRED", let message) {
            throw CursorExpired(message)
        }
    }

    static func parameters(_ query: CountTableQuery) -> [(String, String?)] {
        var items: [(String, String?)] = [("of", query.of)]
        items += query.match.map { ("match.\($0.key)", $0.value) }
        items += [("measure", query.measure), ("op", query.op)] + query.by.map { ("by", $0) }
        items += [("order", query.order), ("limit", query.limit.map(String.init)), ("from", query.from), ("to", query.to), ("cursor", query.cursor)]
        return items
    }
}
