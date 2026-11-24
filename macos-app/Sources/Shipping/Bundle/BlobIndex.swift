import Foundation

public struct BlobIndex: Sendable, Equatable {
    public static let format = "org.lifestreamprotocol.blob-index/1"

    public struct Entry: Sendable, Equatable {
        public let sha256: String
        public let bytes: Int

        public init(sha256: String, bytes: Int) {
            self.sha256 = sha256
            self.bytes = bytes
        }
    }

    public private(set) var entries: [String: Entry] = [:]

    public init() {}

    public var count: Int { entries.count }

    public func contains(_ locator: String) -> Bool { entries[locator] != nil }

    public mutating func set(_ locator: String, _ entry: Entry) {
        entries[locator] = entry
    }

    func without(_ hashes: Set<String>) -> BlobIndex {
        var index = self
        index.entries = entries.filter { !hashes.contains($0.value.sha256) }
        return index
    }

    public var data: Data {
        let sorted = entries.keys.sorted(by: JSONText.javaScriptOrder).map { locator -> (String, JSONText) in
            let entry = entries[locator]!
            return (locator, .object([("sha256", .string(entry.sha256)), ("bytes", .int(entry.bytes))]))
        }
        return JSONText.object([("format", .string(Self.format)), ("entries", .object(sorted))]).data + Data("\n".utf8)
    }
}
