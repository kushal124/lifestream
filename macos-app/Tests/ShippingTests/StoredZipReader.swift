import DeviceFiles
import Foundation

struct StoredZipReader {
    struct Member: Equatable {
        let name: String
        let bytes: Data
    }

    static let localSignature = 0x0403_4b50
    static let centralSignature = 0x0201_4b50
    static let endSignature = 0x0605_4b50

    let members: [Member]

    var names: [String] { members.map(\.name) }

    static func plain(_ url: URL) throws -> Data {
        let disk = try Data(contentsOf: url)
        guard !disk.starts(with: [0x50, 0x4b]),
              let opened = try DeviceFiles(.keyed(ShippingFixture.macKey)).read(url, maximumBytes: Int.max) else { return disk }
        return opened
    }

    init(_ url: URL) throws {
        let data = try Self.plain(url)
        guard let end = Self.endOfCentralDirectory(data) else { throw StoredZipError.noEnd }
        let count = Self.u16(data, end + 10)
        var offset = Self.u32(data, end + 16)
        var found: [Member] = []
        for _ in 0..<count {
            guard offset + 46 <= data.count, Self.u32(data, offset) == Self.centralSignature else {
                throw StoredZipError.centralEntry(offset)
            }
            let bytes = Self.u32(data, offset + 24)
            let nameLength = Self.u16(data, offset + 28)
            let extraLength = Self.u16(data, offset + 30)
            let commentLength = Self.u16(data, offset + 32)
            let localOffset = Self.u32(data, offset + 42)
            let name = String(decoding: data[(offset + 46)..<(offset + 46 + nameLength)], as: UTF8.self)
            found.append(Member(name: name, bytes: try Self.localBytes(data, at: localOffset, bytes: bytes)))
            offset += 46 + nameLength + extraLength + commentLength
        }
        members = found
    }

    func bytes(_ name: String) -> Data? {
        members.first { $0.name == name }?.bytes
    }

    func text(_ name: String) -> String? {
        bytes(name).map { String(decoding: $0, as: UTF8.self) }
    }

    private static func localBytes(_ data: Data, at offset: Int, bytes: Int) throws -> Data {
        guard offset + 30 <= data.count, u32(data, offset) == localSignature else {
            throw StoredZipError.localHeader(offset)
        }
        let start = offset + 30 + u16(data, offset + 26) + u16(data, offset + 28)
        guard start + bytes <= data.count else { throw StoredZipError.localHeader(offset) }
        return data[start..<(start + bytes)]
    }

    private static func endOfCentralDirectory(_ data: Data) -> Int? {
        guard data.count >= 22 else { return nil }
        var offset = data.count - 22
        while offset >= 0 {
            if u32(data, offset) == endSignature { return offset }
            offset -= 1
        }
        return nil
    }

    private static func u16(_ data: Data, _ at: Int) -> Int {
        Int(data[at]) | Int(data[at + 1]) << 8
    }

    private static func u32(_ data: Data, _ at: Int) -> Int {
        Int(data[at]) | Int(data[at + 1]) << 8 | Int(data[at + 2]) << 16 | Int(data[at + 3]) << 24
    }
}

enum StoredZipError: Error, CustomStringConvertible {
    case noEnd
    case centralEntry(Int)
    case localHeader(Int)

    var description: String {
        switch self {
        case .noEnd: return "the file states no end of central directory"
        case .centralEntry(let at): return "no central directory entry at \(at)"
        case .localHeader(let at): return "no local header at \(at)"
        }
    }
}
