import Foundation
import Darwin

struct JSONSpans {
    struct Member {
        let keyStart: Int
        let key: Range<Int>
        let value: Range<Int>
    }

    struct Object {
        let members: [Member]
        let end: Int
    }

    let bytes: [UInt8]

    init(_ data: Data) {
        bytes = [UInt8](data)
    }

    func document() -> Object? {
        let start = skipSpace(0)
        guard let object = object(at: start), skipSpace(object.end) == bytes.count else {
            return nil
        }
        return object
    }

    func object(at start: Int) -> Object? {
        guard start < bytes.count, bytes[start] == UInt8(ascii: "{") else {
            return nil
        }
        var members: [Member] = []
        var index = skipSpace(start + 1)
        if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
            return Object(members: [], end: index + 1)
        }
        while index < bytes.count {
            guard bytes[index] == UInt8(ascii: "\""), let keyEnd = stringEnd(index) else {
                return nil
            }
            let colon = skipSpace(keyEnd)
            guard colon < bytes.count, bytes[colon] == UInt8(ascii: ":") else {
                return nil
            }
            let valueStart = skipSpace(colon + 1)
            guard let valueEnd = valueEnd(valueStart) else {
                return nil
            }
            members.append(Member(keyStart: index, key: (index + 1)..<(keyEnd - 1), value: valueStart..<valueEnd))
            let next = skipSpace(valueEnd)
            guard next < bytes.count else {
                return nil
            }
            if bytes[next] == UInt8(ascii: "}") {
                return Object(members: members, end: next + 1)
            }
            guard bytes[next] == UInt8(ascii: ",") else {
                return nil
            }
            index = skipSpace(next + 1)
        }
        return nil
    }

    func members(named name: String, in object: Object) -> [Member] {
        let wanted = Array(name.utf8)
        return object.members.filter { bytes[$0.key].elementsEqual(wanted) }
    }

    func value(_ member: Member, is token: String) -> Bool {
        bytes[member.value].elementsEqual(token.utf8)
    }

    func valueEnd(_ start: Int) -> Int? {
        guard start < bytes.count else {
            return nil
        }
        switch bytes[start] {
        case UInt8(ascii: "\""):
            return stringEnd(start)
        case UInt8(ascii: "{"), UInt8(ascii: "["):
            return containerEnd(start)
        default:
            var index = start
            while index < bytes.count, !Self.isDelimiter(bytes[index]) {
                index += 1
            }
            return index > start ? index : nil
        }
    }

    private func stringEnd(_ start: Int) -> Int? {
        bytes.withUnsafeBufferPointer { buffer -> Int? in
            guard let base = buffer.baseAddress else {
                return nil
            }
            var index = start + 1
            while index < buffer.count {
                guard let found = memchr(base + index, Int32(UInt8(ascii: "\"")), buffer.count - index) else {
                    return nil
                }
                let quote = base.distance(to: found.assumingMemoryBound(to: UInt8.self))
                var slashes = 0
                var before = quote - 1
                while before > start, base[before] == UInt8(ascii: "\\") {
                    slashes += 1
                    before -= 1
                }
                if slashes % 2 == 0 {
                    return quote + 1
                }
                index = quote + 1
            }
            return nil
        }
    }

    private func containerEnd(_ start: Int) -> Int? {
        var depth = 0
        var index = start
        while index < bytes.count {
            switch bytes[index] {
            case UInt8(ascii: "\""):
                guard let end = stringEnd(index) else {
                    return nil
                }
                index = end
                continue
            case UInt8(ascii: "{"), UInt8(ascii: "["):
                depth += 1
            case UInt8(ascii: "}"), UInt8(ascii: "]"):
                depth -= 1
                if depth == 0 {
                    return index + 1
                }
            default:
                break
            }
            index += 1
        }
        return nil
    }

    private func skipSpace(_ start: Int) -> Int {
        var index = start
        while index < bytes.count, Self.isSpace(bytes[index]) {
            index += 1
        }
        return index
    }

    private static func isSpace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D
    }

    private static func isDelimiter(_ byte: UInt8) -> Bool {
        isSpace(byte) || byte == UInt8(ascii: ",") || byte == UInt8(ascii: "}") || byte == UInt8(ascii: "]")
    }
}
