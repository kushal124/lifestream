import Compression
import Evidence
import Foundation

public struct ImportListing: Sendable, Equatable {
    public enum Form: String, Sendable {
        case zip, tgz, folder, file
    }

    public let form: Form
    public let members: [String]

    public static func of(_ url: URL) throws -> ImportListing {
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isFolder) else { throw ImportListingError.unlisted(url.lastPathComponent) }
        if isFolder.boolValue {
            return ImportListing(form: .folder, members: try ImportFiles.members(of: url).map(\.locator))
        }
        guard let handle = try? FileHandle(forReadingFrom: url) else { throw ImportListingError.unlisted(url.lastPathComponent) }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: 4)) ?? Data()
        let bytes = Int64(FileFacts.regularFileSize(url.path) ?? 0)
        do {
            if head.starts(with: [0x50, 0x4b, 0x03, 0x04]) || head.starts(with: [0x50, 0x4b, 0x05, 0x06]) {
                let zip = try ZipListing(handle: handle, size: bytes)
                return ImportListing(form: .zip, members: zip.entries.map(\.name).filter { !$0.hasSuffix("/") })
            }
            if head.starts(with: [0x1f, 0x8b]), Self.gzippedTar(handle) {
                try handle.seek(toOffset: 0)
                return ImportListing(form: .tgz, members: try TarListing.read(GzipReader(handle: handle)))
            }
        } catch {
            throw ImportListingError.unlisted(url.lastPathComponent)
        }
        return ImportListing(form: .file, members: [url.lastPathComponent])
    }

    private static func gzippedTar(_ handle: FileHandle) -> Bool {
        guard (try? handle.seek(toOffset: 0)) != nil, var reader = try? GzipReader(handle: handle),
              let block = try? reader.read(512), block.count == 512 else { return false }
        return TarListing.checksum(block)
    }
}

public enum ImportListingError: Error, Equatable, CustomStringConvertible {
    case unlisted(String)

    public var description: String {
        switch self {
        case .unlisted(let name): return "\(name) does not list"
        }
    }
}


struct ZipListing {
    struct Entry {
        let name: String
        let method: UInt16
        let compressed: Int64
        let uncompressed: Int64
        let localHeader: Int64
    }

    let entries: [Entry]

    init(handle: FileHandle, size: Int64) throws {
        let broken = ImportListingError.unlisted("zip")
        func within(_ value: UInt64) throws -> Int64 {
            guard let exact = Int64(exactly: value), exact <= size else { throw broken }
            return exact
        }
        guard size >= 22 else { throw broken }
        let tailLength = min(size, 65_557)
        try handle.seek(toOffset: UInt64(size - tailLength))
        let tail = try handle.read(upToCount: Int(tailLength)) ?? Data()
        guard tail.count == Int(tailLength), let end = Self.last(of: 0x0605_4b50, in: tail) else { throw broken }
        var count = Int64(tail.le16(end + 10))
        var directorySize = Int64(tail.le32(end + 12))
        var directoryOffset = Int64(tail.le32(end + 16))
        if count == 0xffff || directorySize == 0xffff_ffff || directoryOffset == 0xffff_ffff {
            guard end >= 20, tail.le32(end - 20) == 0x0706_4b50 else { throw broken }
            let recordOffset = try within(tail.le64(end - 20 + 8))
            guard recordOffset <= size - 56 else { throw broken }
            try handle.seek(toOffset: UInt64(recordOffset))
            let record = try handle.read(upToCount: 56) ?? Data()
            guard record.count == 56, record.le32(0) == 0x0606_4b50 else { throw broken }
            count = try within(record.le64(32))
            directorySize = try within(record.le64(40))
            directoryOffset = try within(record.le64(48))
        }
        guard directorySize <= size, directoryOffset <= size - directorySize, count <= directorySize / 46 else { throw broken }
        try handle.seek(toOffset: UInt64(directoryOffset))
        let directory = try handle.read(upToCount: Int(directorySize)) ?? Data()
        guard directory.count == Int(directorySize) else { throw broken }
        var entries: [Entry] = []
        var at = 0
        for _ in 0..<count {
            guard at + 46 <= directory.count, directory.le32(at) == 0x0201_4b50 else { throw broken }
            let method = directory.le16(at + 10)
            var compressed = Int64(directory.le32(at + 20))
            var uncompressed = Int64(directory.le32(at + 24))
            let nameLength = Int(directory.le16(at + 28)), extraLength = Int(directory.le16(at + 30)), commentLength = Int(directory.le16(at + 32))
            var local = Int64(directory.le32(at + 42))
            guard at + 46 + nameLength + extraLength + commentLength <= directory.count else { throw broken }
            let name = String(decoding: directory.subdata(in: (at + 46)..<(at + 46 + nameLength)), as: UTF8.self)
            var extra = at + 46 + nameLength
            let extraEnd = extra + extraLength
            while extra + 4 <= extraEnd {
                let id = directory.le16(extra), length = Int(directory.le16(extra + 2))
                let fieldEnd = extra + 4 + length
                guard fieldEnd <= extraEnd else { throw broken }
                if id == 0x0001 {
                    var field = extra + 4
                    func next(inFile: Bool = true) throws -> Int64 {
                        guard field + 8 <= fieldEnd else { throw broken }
                        defer { field += 8 }
                        let value = directory.le64(field)
                        if inFile { return try within(value) }
                        guard let exact = Int64(exactly: value) else { throw broken }
                        return exact
                    }
                    if uncompressed == 0xffff_ffff { uncompressed = try next(inFile: false) }
                    if compressed == 0xffff_ffff { compressed = try next() }
                    if local == 0xffff_ffff { local = try next() }
                }
                extra = fieldEnd
            }
            guard compressed <= size, local <= size - 30 else { throw broken }
            entries.append(Entry(name: name, method: method, compressed: compressed, uncompressed: uncompressed, localHeader: local))
            at += 46 + nameLength + extraLength + commentLength
        }
        self.entries = entries
    }

    private static func last(of signature: UInt32, in data: Data) -> Int? {
        guard data.count >= 22 else { return nil }
        var at = data.count - 22
        while at >= 0 {
            if data.le32(at) == signature { return at }
            at -= 1
        }
        return nil
    }
}


struct GzipReader {
    private let filter: InputFilter<Data>

    init(handle: FileHandle) throws {
        let header = try handle.read(upToCount: 10) ?? Data()
        guard header.count == 10, header[0] == 0x1f, header[1] == 0x8b, header[2] == 8 else { throw ImportListingError.unlisted("gzip") }
        let flags = header[3]
        if flags & 0x04 != 0 {
            let length = try handle.read(upToCount: 2) ?? Data()
            guard length.count == 2 else { throw ImportListingError.unlisted("gzip") }
            _ = try handle.read(upToCount: Int(length.le16(0)))
        }
        for bit in [UInt8(0x08), 0x10] where flags & bit != 0 {
            while let byte = try handle.read(upToCount: 1), let first = byte.first, first != 0 {}
        }
        if flags & 0x02 != 0 { _ = try handle.read(upToCount: 2) }
        filter = try InputFilter(.decompress, using: .zlib) { (length: Int) -> Data? in
            try handle.read(upToCount: length)
        }
    }

    mutating func read(_ count: Int) throws -> Data {
        var data = Data()
        while data.count < count {
            guard let chunk = try filter.readData(ofLength: count - data.count), !chunk.isEmpty else { break }
            data.append(chunk)
        }
        return data
    }
}

enum TarListing {
    static func read(_ reader: GzipReader) throws -> [String] {
        var reader = reader
        var members: [String] = []
        var longName: String?
        var zeros = 0
        while true {
            let header = try reader.read(512)
            guard header.count == 512 else { throw ImportListingError.unlisted("tar") }
            if header.allSatisfy({ $0 == 0 }) {
                zeros += 1
                if zeros == 2 { break }
                continue
            }
            zeros = 0
            guard checksum(header) else { throw ImportListingError.unlisted("tar") }
            let size = try number(header.subdata(in: 124..<136))
            let type = header[156]
            let padded = Int((size + 511) / 512 * 512)
            switch type {
            case UInt8(ascii: "L"), UInt8(ascii: "x"):
                let data = try reader.read(padded)
                guard data.count == padded else { throw ImportListingError.unlisted("tar") }
                let body = data.prefix(Int(size))
                longName = type == UInt8(ascii: "L") ? text(body) : paxPath(body) ?? longName
                continue
            default:
                break
            }
            var name = text(header.subdata(in: 0..<100))
            if header.subdata(in: 257..<262) == Data("ustar".utf8) {
                let prefix = text(header.subdata(in: 345..<500))
                if !prefix.isEmpty { name = prefix + "/" + name }
            }
            if let long = longName { name = long }
            longName = nil
            let regular = type == 0 || type == UInt8(ascii: "0") || type == UInt8(ascii: "7")
            if regular, !name.hasSuffix("/") {
                if name.hasPrefix("./") { name.removeFirst(2) }
                members.append(name)
            }
            try skip(&reader, padded)
        }
        return members
    }

    private static func skip(_ reader: inout GzipReader, _ count: Int) throws {
        var left = count
        while left > 0 {
            let chunk = try reader.read(min(left, 1 << 20))
            guard !chunk.isEmpty else { throw ImportListingError.unlisted("tar") }
            left -= chunk.count
        }
    }

    private static func text(_ data: Data) -> String {
        String(decoding: data.prefix { $0 != 0 }, as: UTF8.self)
    }

    private static func number(_ field: Data) throws -> Int64 {
        if let first = field.first, first & 0x80 != 0 {
            return field.dropFirst().reduce(Int64(first & 0x7f)) { $0 << 8 | Int64($1) }
        }
        let digits = text(field).trimmingCharacters(in: .whitespaces)
        if digits.isEmpty { return 0 }
        guard let value = Int64(digits, radix: 8) else { throw ImportListingError.unlisted("tar") }
        return value
    }

    static func checksum(_ header: Data) -> Bool {
        guard header.count == 512, let stated = try? number(header.subdata(in: 148..<156)) else { return false }
        var sum: Int64 = 0
        for (index, byte) in header.enumerated() { sum += (148..<156).contains(index) ? 32 : Int64(byte) }
        return sum == stated
    }

    private static func paxPath(_ body: Data) -> String? {
        for record in String(decoding: body, as: UTF8.self).split(separator: "\n") {
            guard let space = record.firstIndex(of: " ") else { continue }
            let field = record[record.index(after: space)...]
            if field.hasPrefix("path=") { return String(field.dropFirst(5)) }
        }
        return nil
    }
}


extension Data {
    func le16(_ at: Int) -> UInt16 {
        UInt16(self[startIndex + at]) | UInt16(self[startIndex + at + 1]) << 8
    }

    func le32(_ at: Int) -> UInt32 {
        (0..<4).reduce(UInt32(0)) { $0 | UInt32(self[startIndex + at + $1]) << (8 * $1) }
    }

    func le64(_ at: Int) -> UInt64 {
        (0..<8).reduce(UInt64(0)) { $0 | UInt64(self[startIndex + at + $1]) << (8 * $1) }
    }
}
