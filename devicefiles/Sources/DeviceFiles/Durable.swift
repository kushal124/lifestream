import Foundation
import Darwin

public enum DeviceFileError: Error, Equatable, CustomStringConvertible {
    case io(operation: String, code: Int32)
    case invalidSizeOrType(name: String, maximumBytes: Int)
    case truncated(name: String)
    case notFlushed(name: String, code: Int32)
    case unreadable(name: String, why: String)
    case switched(name: String)
    case alreadyKeyed

    public var description: String {
        switch self {
        case .io(let operation, let code):
            return "Durable file \(operation) failed: \(String(cString: strerror(code))) (errno \(code))"
        case .notFlushed(let name, let code):
            return "\(name) was written but not flushed: \(String(cString: strerror(code))) (errno \(code))"
        case .invalidSizeOrType(let name, let maximum):
            return "\(name) must be a nonempty regular file of at most \(maximum) bytes"
        case .truncated(let name):
            return "\(name) ended before its declared size; the artifact may be truncated"
        case .unreadable(let name, let why):
            return "\(name) does not open: \(why)"
        case .switched(let name):
            return "\(name) was abandoned: this Mac's files became encrypted while it was written"
        case .alreadyKeyed:
            return "this Mac's files are encrypted already"
        }
    }
}

extension DeviceFiles {
    public enum Flush: Sendable, Equatable {
        case data
        case barrier
        case full
    }

    public enum Commit: Sendable, Equatable {
        case ordered
        case durable
        case atomic
        case pass
    }

    public enum Step: Equatable, Sendable {
        case flush(Flush)
        case cut
        case truncate
    }

    public enum Metered: Equatable, Sendable {
        case flush(Flush)
        case written(Int)
    }

    nonisolated(unsafe) public static var flushObserver: ((URL, Flush) -> Void)?

    nonisolated(unsafe) public static var writeLimit: Int?

    nonisolated(unsafe) public static var failStep: ((URL, Step) -> Int32?)?

    nonisolated(unsafe) public static var meter: ((Metered) -> Void)?

    public static func syncFile(_ url: URL, flush: Flush = .full) throws {
        let fd = Darwin.open(url.path, O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else {
            throw Durable.failure("open \(url.lastPathComponent) for sync")
        }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else {
            throw Durable.failure("inspect file for sync")
        }
        guard info.st_mode & S_IFMT == S_IFREG else {
            throw DeviceFileError.invalidSizeOrType(name: url.lastPathComponent, maximumBytes: Int.max)
        }
        guard fchmod(fd, 0o600) == 0 else {
            throw Durable.failure("restrict file permissions")
        }
        try Durable.issue(flush, on: fd, naming: url)
    }

    public static func syncDirectory(_ url: URL, flush: Flush = .data) throws {
        let fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else {
            throw Durable.failure("open directory \(url.lastPathComponent)")
        }
        defer { Darwin.close(fd) }
        try Durable.issue(flush, on: fd, naming: url)
    }

    @discardableResult
    public static func moveFresh(_ file: URL, into folder: URL, stem: String, suffix: String) throws -> URL {
        var attempt = 1
        while true {
            let target = folder.appendingPathComponent(attempt == 1 ? stem + suffix : "\(stem)-\(attempt)\(suffix)")
            if renamex_np(file.path, target.path, UInt32(RENAME_EXCL)) == 0 {
                return target
            }
            guard errno == EEXIST else {
                throw Durable.failure("move \(file.lastPathComponent)")
            }
            attempt += 1
        }
    }
}

enum Durable {
    struct Partial {
        let error: DeviceFileError
        let written: Int
    }

    static func create(_ url: URL) throws -> Int32 {
        let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            throw failure("create \(url.lastPathComponent)")
        }
        return fd
    }

    static func createAfresh(_ url: URL) throws -> Int32 {
        let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            throw failure("create \(url.lastPathComponent)")
        }
        guard fchmod(fd, 0o600) == 0 else {
            let failed = failure("restrict \(url.lastPathComponent)")
            Darwin.close(fd)
            throw failed
        }
        return fd
    }

    static func writeNew(_ data: Data, to url: URL, flush: DeviceFiles.Flush) throws {
        let fd = try create(url)
        defer { Darwin.close(fd) }
        try write(data, to: fd)
        try issue(flush, on: fd, naming: url)
    }

    static func replace(_ url: URL, with data: Data, commit: DeviceFiles.Commit) throws {
        switch commit {
        case .ordered, .durable:
            let folder = url.deletingLastPathComponent()
            let temporary = folder.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
            try writeNew(data, to: temporary, flush: .barrier)
            guard Darwin.rename(temporary.path, url.path) == 0 else {
                let code = errno
                Darwin.unlink(temporary.path)
                throw failure("replace \(url.lastPathComponent)", code: code)
            }
            if commit == .durable {
                try DeviceFiles.syncDirectory(folder, flush: .full)
            }
        case .atomic:
            do {
                try data.write(to: url, options: .atomic)
            } catch {
                throw failure("replace \(url.lastPathComponent)", code: posixCode(of: error))
            }
        case .pass:
            try replacePass(url, with: data)
        }
    }

    private static func replacePass(_ url: URL, with data: Data) throws {
        let directory = url.deletingLastPathComponent()
        var temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            guard fd >= 0 else { throw failure("create \(temporary.lastPathComponent)") }
            do {
                try write(data, to: fd)
                try issue(.data, on: fd, naming: temporary)
            } catch {
                Darwin.close(fd)
                throw error
            }
            Darwin.close(fd)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try temporary.setResourceValues(values)
            guard Darwin.rename(temporary.path, url.path) == 0 else {
                throw failure("replace \(url.lastPathComponent)")
            }
        } catch {
            Darwin.unlink(temporary.path)
            if let failed = error as? DeviceFileError { throw failed }
            throw failure("replace \(url.lastPathComponent)", code: posixCode(of: error))
        }
    }

    static func openForReading(_ url: URL) throws -> Int32? {
        let fd = Darwin.open(url.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else {
            throw failure("open \(url.lastPathComponent)")
        }
        return fd
    }

    static func regularSize(_ fd: Int32, naming url: URL, maximumBytes: Int) throws -> Int {
        var info = stat()
        guard fstat(fd, &info) == 0 else {
            throw failure("inspect \(url.lastPathComponent)")
        }
        guard info.st_mode & S_IFMT == S_IFREG else {
            throw DeviceFileError.invalidSizeOrType(name: url.lastPathComponent, maximumBytes: maximumBytes)
        }
        return Int(info.st_size)
    }

    static func read(_ fd: Int32, count: Int, from offset: Int, naming url: URL) throws -> Data {
        var data = Data(count: count)
        try data.withUnsafeMutableBytes { bytes in
            var at = 0
            while at < bytes.count {
                let read = pread(fd, bytes.baseAddress!.advanced(by: at), bytes.count - at, off_t(offset + at))
                if read < 0 && errno == EINTR {
                    continue
                }
                if read < 0 {
                    throw failure("read \(url.lastPathComponent)")
                }
                guard read > 0 else {
                    throw DeviceFileError.truncated(name: url.lastPathComponent)
                }
                at += read
            }
        }
        return data
    }

    static func firstByte(_ fd: Int32, naming url: URL) throws -> UInt8? {
        var byte: UInt8 = 0
        while true {
            let read = pread(fd, &byte, 1, 0)
            if read < 0 && errno == EINTR { continue }
            guard read >= 0 else { throw failure("read \(url.lastPathComponent)") }
            return read == 0 ? nil : byte
        }
    }

    static func writeAll(_ data: Data, to descriptor: Int32) -> Partial? {
        var offset = 0
        defer { DeviceFiles.meter?(.written(offset)) }
        let failed: DeviceFileError? = data.withUnsafeBytes { bytes in
            while offset < bytes.count {
                var length = bytes.count - offset
                if let limit = DeviceFiles.writeLimit {
                    guard limit > 0 else { return failure("write", code: ENOSPC) }
                    length = min(length, limit)
                }
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), length)
                if count < 0 && errno == EINTR {
                    continue
                }
                guard count > 0 else {
                    return failure("write", code: count == 0 ? EIO : errno)
                }
                if let limit = DeviceFiles.writeLimit { DeviceFiles.writeLimit = limit - count }
                offset += count
            }
            return nil
        }
        return failed.map { Partial(error: $0, written: offset) }
    }

    static func write(_ data: Data, to descriptor: Int32) throws {
        if let partial = writeAll(data, to: descriptor) { throw partial.error }
    }

    static func issue(_ flush: DeviceFiles.Flush, on descriptor: Int32, naming url: URL) throws {
        DeviceFiles.flushObserver?(url, flush)
        DeviceFiles.meter?(.flush(flush))
        if let code = DeviceFiles.failStep?(url, .flush(flush)) {
            throw failure("flush \(url.lastPathComponent) to storage", code: code)
        }
        while true {
            let result: Int32
            switch flush {
            case .data:
                result = fsync(descriptor)
            case .barrier:
                result = fcntl(descriptor, F_BARRIERFSYNC)
            case .full:
                result = fcntl(descriptor, F_FULLFSYNC)
            }
            if result == 0 {
                return
            }
            if errno != EINTR {
                throw failure("flush \(url.lastPathComponent) to storage")
            }
        }
    }

    static func failure(_ operation: String, code: Int32 = errno) -> DeviceFileError {
        .io(operation: operation, code: code)
    }

    static func posixCode(of error: Error) -> Int32 {
        let ns = error as NSError
        if ns.domain == NSPOSIXErrorDomain { return Int32(ns.code) }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSPOSIXErrorDomain {
            return Int32(underlying.code)
        }
        return EIO
    }
}
