import DeviceFiles
import Foundation

final class ZipWriter {
    struct Member: Equatable {
        let name: String
        let bytes: Int
        let sha256: String
    }

    private struct Entry {
        let name: Data
        let bytes: Int
        let sha256: String
        let crc: UInt32
        let localOffset: Int
    }

    private static let localSignature: UInt32 = 0x0403_4b50
    private static let centralSignature: UInt32 = 0x0201_4b50
    private static let endSignature: UInt32 = 0x0605_4b50
    private static let zip64EndSignature: UInt32 = 0x0606_4b50
    private static let zip64LocatorSignature: UInt32 = 0x0706_4b50
    private static let utf8Flag: UInt16 = 1 << 11
    private static let versionStored: UInt16 = 20
    private static let versionZip64: UInt16 = 45
    private static let u16Max = 0xffff
    private static let u32Max = 0xffff_ffff

    let path: URL
    private let partial: URL
    private let writer: Writer
    private var entries: [Entry] = []
    private var names: Set<String> = []
    private var offset = 0
    private var open = true

    init(path: URL, files: DeviceFiles) throws {
        self.path = path
        partial = URL(fileURLWithPath: path.path + ".partial")
        writer = try files.writer(partial, flush: .full)
    }

    deinit { if open { abort() } }

    func addFile(_ name: String, from url: URL) throws -> Member {
        try addStream(name) { emit in try FileChunks.read(url, emit) }
    }

    func addFile(_ name: String, kept url: URL, through files: DeviceFiles) throws -> Member {
        try addStream(name) { emit in try FileChunks.read(url, through: files, emit) }
    }

    func addFile(_ name: String, from file: OpenedFile) throws -> Member {
        try addStream(name) { emit in try file.chunks(emit) }
    }

    func addBytes(_ name: String, _ data: Data) throws -> Member {
        let nameBytes = try begin(name)
        let localOffset = offset
        var digest = StreamDigest()
        digest.update(data)
        try write(Self.localHeader(name: nameBytes, crc: digest.crc, bytes: data.count, zip64: data.count > Self.u32Max))
        try write(data)
        let member = Member(name: name, bytes: data.count, sha256: digest.hex())
        entries.append(Entry(name: nameBytes, bytes: member.bytes, sha256: member.sha256, crc: digest.crc, localOffset: localOffset))
        return member
    }

    func addStream(_ name: String, _ body: ((Data) throws -> Void) throws -> Void) throws -> Member {
        let nameBytes = try begin(name)
        var measured = StreamDigest()
        try body { measured.update($0) }
        let localOffset = offset
        try write(Self.localHeader(name: nameBytes, crc: measured.crc, bytes: measured.bytes, zip64: true))
        var copied = StreamDigest()
        try body { chunk in
            copied.update(chunk)
            guard copied.bytes <= measured.bytes else { throw ZipWriterError.changed(name) }
            try self.write(chunk)
        }
        let member = Member(name: name, bytes: measured.bytes, sha256: measured.hex())
        guard copied.bytes == measured.bytes, copied.crc == measured.crc, copied.hex() == member.sha256 else {
            throw ZipWriterError.changed(name)
        }
        entries.append(Entry(name: nameBytes, bytes: member.bytes, sha256: member.sha256, crc: measured.crc, localOffset: localOffset))
        return member
    }

    @discardableResult
    func close() throws -> [Member] {
        guard open else { throw ZipWriterError.closed }
        let centralOffset = offset
        for entry in entries { try write(Self.centralEntry(entry)) }
        let centralBytes = offset - centralOffset
        if entries.count >= Self.u16Max || centralBytes >= Self.u32Max || centralOffset >= Self.u32Max {
            let zip64Offset = offset
            var record = Data()
            record.append32(Self.zip64EndSignature)
            record.append64(44)
            record.append16(Self.versionZip64)
            record.append16(Self.versionZip64)
            record.append32(0)
            record.append32(0)
            record.append64(UInt64(entries.count))
            record.append64(UInt64(entries.count))
            record.append64(UInt64(centralBytes))
            record.append64(UInt64(centralOffset))
            try write(record)
            var locator = Data()
            locator.append32(Self.zip64LocatorSignature)
            locator.append32(0)
            locator.append64(UInt64(zip64Offset))
            locator.append32(1)
            try write(locator)
        }
        var end = Data()
        end.append32(Self.endSignature)
        end.append16(0)
        end.append16(0)
        end.append16(UInt16(min(entries.count, Self.u16Max)))
        end.append16(UInt16(min(entries.count, Self.u16Max)))
        end.append32(UInt32(min(centralBytes, Self.u32Max)))
        end.append32(UInt32(min(centralOffset, Self.u32Max)))
        end.append16(0)
        try write(end)
        try writer.finish()
        open = false
        guard rename(partial.path, path.path) == 0 else { throw ZipWriterError.io("publish \(path.lastPathComponent)", errno) }
        return entries.map { Member(name: String(decoding: $0.name, as: UTF8.self), bytes: $0.bytes, sha256: $0.sha256) }
    }

    func abort() {
        guard open else { return }
        open = false
        writer.abandon()
    }


    private func begin(_ name: String) throws -> Data {
        guard open else { throw ZipWriterError.closed }
        let parts = name.split(separator: "/", omittingEmptySubsequences: false)
        guard !name.isEmpty, !name.hasPrefix("/"), !name.contains("\\"), !name.contains("\0"),
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw ZipWriterError.memberName(name)
        }
        let bytes = Data(name.utf8)
        guard bytes.count <= Self.u16Max else { throw ZipWriterError.memberName(name) }
        guard names.insert(name).inserted else { throw ZipWriterError.duplicate(name) }
        return bytes
    }

    private func write(_ data: Data) throws {
        try writer.write(data)
        offset += data.count
    }

    private static func localHeader(name: Data, crc: UInt32, bytes: Int, zip64: Bool) -> Data {
        let extra = zip64 ? zip64Extra([UInt64(bytes), UInt64(bytes)]) : Data()
        var header = Data()
        header.append32(localSignature)
        header.append16(zip64 ? versionZip64 : versionStored)
        header.append16(utf8Flag)
        header.append16(0)
        header.append16(0)
        header.append16(0)
        header.append32(crc)
        header.append32(zip64 ? UInt32(u32Max) : UInt32(bytes))
        header.append32(zip64 ? UInt32(u32Max) : UInt32(bytes))
        header.append16(UInt16(name.count))
        header.append16(UInt16(extra.count))
        return header + name + extra
    }

    private static func centralEntry(_ entry: Entry) -> Data {
        let bigSize = entry.bytes > u32Max
        let bigOffset = entry.localOffset > u32Max
        var fields: [UInt64] = []
        if bigSize { fields += [UInt64(entry.bytes), UInt64(entry.bytes)] }
        if bigOffset { fields.append(UInt64(entry.localOffset)) }
        let extra = fields.isEmpty ? Data() : zip64Extra(fields)
        let version = fields.isEmpty ? versionStored : versionZip64
        var header = Data()
        header.append32(centralSignature)
        header.append16(version)
        header.append16(version)
        header.append16(utf8Flag)
        header.append16(0)
        header.append16(0)
        header.append16(0)
        header.append32(entry.crc)
        header.append32(bigSize ? UInt32(u32Max) : UInt32(entry.bytes))
        header.append32(bigSize ? UInt32(u32Max) : UInt32(entry.bytes))
        header.append16(UInt16(entry.name.count))
        header.append16(UInt16(extra.count))
        header.append16(0)
        header.append16(0)
        header.append16(0)
        header.append32(0)
        header.append32(bigOffset ? UInt32(u32Max) : UInt32(entry.localOffset))
        return header + entry.name + extra
    }

    private static func zip64Extra(_ fields: [UInt64]) -> Data {
        var extra = Data()
        extra.append16(0x0001)
        extra.append16(UInt16(fields.count * 8))
        for field in fields { extra.append64(field) }
        return extra
    }
}

enum ZipWriterError: Error, Equatable, CustomStringConvertible {
    case io(String, Int32)
    case closed
    case memberName(String)
    case duplicate(String)
    case changed(String)

    var description: String {
        switch self {
        case .io(let operation, let code): return "zip \(operation) failed (errno \(code))"
        case .closed: return "zip writer is closed"
        case .memberName(let name): return "zip member name \(name) must be a relative, /-separated path"
        case .duplicate(let name): return "duplicate zip member \(name)"
        case .changed(let name): return "zip member \(name) changed between its two reads"
        }
    }
}

extension Data {
    mutating func append16(_ value: UInt16) { append(contentsOf: Swift.withUnsafeBytes(of: value.littleEndian, Array.init)) }
    mutating func append32(_ value: UInt32) { append(contentsOf: Swift.withUnsafeBytes(of: value.littleEndian, Array.init)) }
    mutating func append64(_ value: UInt64) { append(contentsOf: Swift.withUnsafeBytes(of: value.littleEndian, Array.init)) }
}
