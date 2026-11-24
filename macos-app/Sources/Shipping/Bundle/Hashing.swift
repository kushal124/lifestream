import CryptoKit
import Darwin
import DeviceFiles
import Foundation
import zlib

struct StreamDigest {
    private var sha = SHA256()
    private(set) var crc: UInt32 = 0
    private(set) var bytes: Int = 0

    mutating func update(_ chunk: Data) {
        sha.update(data: chunk)
        crc = CRC32.update(crc, chunk)
        bytes += chunk.count
    }

    func hex() -> String {
        sha.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

enum CRC32 {
    static func update(_ crc: UInt32, _ data: Data) -> UInt32 {
        data.withUnsafeBytes { bytes in
            guard let base = bytes.bindMemory(to: Bytef.self).baseAddress, !bytes.isEmpty else { return crc }
            return UInt32(crc32_z(uLong(crc), base, bytes.count))
        }
    }
}

final class OpenedFile {
    let url: URL
    let handle: FileHandle
    let status: stat

    init(url: URL, handle: FileHandle) {
        self.url = url
        self.handle = handle
        var status = stat()
        _ = fstat(handle.fileDescriptor, &status)
        self.status = status
    }

    convenience init(url: URL, descriptor: Int32) {
        self.init(url: url, handle: FileHandle(fileDescriptor: descriptor, closeOnDealloc: true))
    }

    static func own(_ url: URL) throws -> OpenedFile {
        let descriptor = open(url.path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { throw FileOpenerError.unreadable(errno) }
        return OpenedFile(url: url, descriptor: descriptor)
    }

    var isRegularFile: Bool { status.st_mode & S_IFMT == S_IFREG }

    var stamp: FileFacts.Stamp { FileFacts.stamp(of: status) }

    func bytes() throws -> Data {
        try handle.seek(toOffset: 0)
        return try handle.readToEnd() ?? Data()
    }

    func chunks(_ body: (Data) throws -> Void) throws {
        try handle.seek(toOffset: 0)
        while try autoreleasepool(invoking: {
            let chunk = try handle.read(upToCount: FileChunks.size) ?? Data()
            if chunk.isEmpty { return false }
            try body(chunk)
            return true
        }) {}
    }
}

struct FileOpener: Sendable {
    let open: @Sendable (URL) throws -> OpenedFile?

    static let own = FileOpener { try OpenedFile.own($0) }

    func file(_ url: URL) throws -> OpenedFile {
        guard let opened = try open(url) else { throw FileOpenerError.gone }
        return opened
    }
}

enum FileOpenerError: PathFreeError, Equatable {
    case gone
    case unreadable(Int32)

    var why: String {
        switch self {
        case .gone: return "it is gone"
        case .unreadable(let code): return String(cString: strerror(code))
        }
    }

    var description: String { "a file cannot be opened: \(why)" }
}

enum FileChunks {
    static let size = 1 << 20

    static func read(_ url: URL, _ body: (Data) throws -> Void) throws {
        try OpenedFile.own(url).chunks(body)
    }

    static func measure(_ url: URL) throws -> (sha256: String, bytes: Int) {
        try measure(try OpenedFile.own(url))
    }

    static func measure(_ file: OpenedFile) throws -> (sha256: String, bytes: Int) {
        var digest = StreamDigest()
        try file.chunks { digest.update($0) }
        return (digest.hex(), digest.bytes)
    }

    static func read(_ url: URL, through files: DeviceFiles, _ body: (Data) throws -> Void) throws {
        let reader = try files.reader(url)
        while let chunk = try autoreleasepool(invoking: { try reader.next() }) {
            try autoreleasepool { try body(chunk) }
        }
    }

    static func measure(_ url: URL, through files: DeviceFiles) throws -> (sha256: String, bytes: Int) {
        var digest = StreamDigest()
        try read(url, through: files) { digest.update($0) }
        return (digest.hex(), digest.bytes)
    }
}
