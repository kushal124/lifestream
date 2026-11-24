import Foundation

public enum ObservationBytes {
    public static func status(of json: Data) -> String? {
        let scan = JSONSpans(json)
        guard let top = scan.document() else {
            return nil
        }
        let named = scan.members(named: "status", in: top)
        guard named.count == 1 else {
            return nil
        }
        let raw = scan.bytes[named[0].value]
        guard raw.count >= 2, raw.first == UInt8(ascii: "\""), raw.last == UInt8(ascii: "\""),
              !raw.contains(UInt8(ascii: "\\")) else {
            return nil
        }
        return String(decoding: raw.dropFirst().dropLast(), as: UTF8.self)
    }

    public static func member(_ name: String, of json: Data) -> Data? {
        let scan = JSONSpans(json)
        guard let top = scan.document() else {
            return nil
        }
        let named = scan.members(named: name, in: top)
        guard named.count == 1 else {
            return nil
        }
        return Data(scan.bytes[named[0].value])
    }

    public static let gapStatuses: Set<String> = ["gap", "excluded"]
    public static let capturedStatus = "captured"
}

public struct GapAttempt: Equatable, Sendable {
    public static let members = ["capturedAt", "capturedUntil", "inputIdleSeconds"]

    public let shared: Data
    let insertions: [(at: Int, member: Int)]
    public let tokens: [String?]

    public static func == (lhs: GapAttempt, rhs: GapAttempt) -> Bool {
        lhs.shared == rhs.shared && lhs.tokens == rhs.tokens
    }

    public init?(_ json: Data) {
        let scan = JSONSpans(json)
        guard let top = scan.document() else {
            return nil
        }
        var found: [(value: Range<Int>, member: Int)] = []
        var tokens: [String?] = Array(repeating: nil, count: Self.members.count)
        for (index, name) in Self.members.enumerated() {
            let named = scan.members(named: name, in: top)
            guard named.count <= 1 else {
                return nil
            }
            guard let member = named.first else {
                continue
            }
            let raw = scan.bytes[member.value]
            guard raw.allSatisfy(Self.isNumberByte) else {
                return nil
            }
            tokens[index] = String(decoding: raw, as: UTF8.self)
            found.append((member.value, index))
        }
        guard tokens[0] != nil else {
            return nil
        }
        found.sort { $0.value.lowerBound < $1.value.lowerBound }
        var shared = Data()
        var insertions: [(at: Int, member: Int)] = []
        var cursor = 0
        for (value, member) in found {
            shared.append(contentsOf: scan.bytes[cursor..<value.lowerBound])
            insertions.append((shared.count, member))
            cursor = value.upperBound
        }
        shared.append(contentsOf: scan.bytes[cursor...])
        self.shared = shared
        self.insertions = insertions
        self.tokens = tokens
        guard rebuild(tokens) == json else {
            return nil
        }
    }

    public func rebuild(_ tokens: [String?]) -> Data? {
        guard tokens.count == Self.members.count,
              zip(tokens, self.tokens).allSatisfy({ ($0 == nil) == ($1 == nil) }) else {
            return nil
        }
        var result = Data()
        var cursor = 0
        for (at, member) in insertions {
            result.append(shared[cursor..<at])
            result.append(Data(tokens[member]!.utf8))
            cursor = at
        }
        result.append(shared[cursor...])
        return result
    }

    private static func isNumberByte(_ byte: UInt8) -> Bool {
        (0x30...0x39).contains(byte) || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "+")
            || byte == UInt8(ascii: ".") || byte == UInt8(ascii: "e") || byte == UInt8(ascii: "E")
    }
}
