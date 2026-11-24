import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public struct UsageInboxItem: Codable, Sendable, Equatable {
    public let deliveryID: UUID
    public let payload: JSONValue
}

public struct UsageInbox: Sendable {
    public let directory: URL
    public let maximumItems: Int
    public let maximumItemBytes: Int
    public let maximumTotalBytes: Int

    public init(directory: URL, maximumItems: Int = 4096,
                maximumItemBytes: Int = 262_144, maximumTotalBytes: Int = 16_777_216) {
        self.directory = directory
        self.maximumItems = maximumItems
        self.maximumItemBytes = maximumItemBytes
        self.maximumTotalBytes = maximumTotalBytes
    }

    @discardableResult
    public func publish(_ payload: JSONValue, deliveryID: UUID = UUID()) throws -> UUID {
        let item = UsageInboxItem(deliveryID: deliveryID, payload: payload)
        let bytes = try encoded(item)
        return try locked {
            let target = url(for: deliveryID)
            if try verifyExistingDelivery(at: target, bytes: bytes) { return deliveryID }
            let files = try inventory()
            if try verifyExistingDelivery(at: target, bytes: bytes) { return deliveryID }
            guard files.count < maximumItems,
                  bytes.count <= maximumTotalBytes - files.reduce(0, { $0 + $1.size }) else {
                throw failure("inbox capacity reached; delivery was not accepted")
            }
            let staging = directory.appendingPathComponent(".pending-\(deliveryID.uuidString.lowercased())")
            try FileDurability.writeNewRegularFileDurably(bytes, to: staging)
            let result = staging.withUnsafeFileSystemRepresentation { source in
                target.withUnsafeFileSystemRepresentation { destination in
                    link(source!, destination!)
                }
            }
            guard result == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            try FileDurability.synchronizeParentDirectory(of: target)
            try FileDurability.removeRegularFileIfPresentDurably(at: staging)
            return deliveryID
        }
    }

    public func pending(limit: Int = 64) throws -> [UsageInboxItem] {
        guard limit > 0, limit <= maximumItems else { throw failure("invalid drain limit") }
        return try locked {
            let files = try inventory()
            var result: [UsageInboxItem] = []
            for file in files.prefix(limit) {
                guard let bytes = try FileDurability.readRegularFileIfPresent(at: file.url, maximumBytes: maximumItemBytes) else {
                    throw failure("inbox entry disappeared")
                }
                let item = try JSONDecoder().decode(UsageInboxItem.self, from: bytes)
                guard file.url.lastPathComponent == url(for: item.deliveryID).lastPathComponent else {
                    throw failure("delivery UUID does not match filename")
                }
                result.append(item)
            }
            return result
        }
    }

    public func acknowledge(_ item: UsageInboxItem) throws {
        try locked {
            let target = url(for: item.deliveryID)
            if let bytes = try FileDurability.readRegularFileIfPresent(at: target, maximumBytes: maximumItemBytes) {
                guard try JSONDecoder().decode(UsageInboxItem.self, from: bytes) == item else {
                    throw failure("delivery changed before acknowledgement")
                }
            }
            try FileDurability.removeRegularFileIfPresentDurably(at: target)
        }
    }

    private func verifyExistingDelivery(at target: URL, bytes: Data) throws -> Bool {
        guard let existing = try FileDurability.readRegularFileIfPresent(at: target, maximumBytes: maximumItemBytes) else {
            return false
        }
        guard existing == bytes else { throw failure("delivery UUID already contains different bytes") }
        try FileDurability.synchronizeFile(at: target)
        try FileDurability.synchronizeParentDirectory(of: target)
        return true
    }

    private func encoded(_ item: UsageInboxItem) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(item)
        guard bytes.count <= maximumItemBytes else { throw failure("delivery exceeds item byte limit") }
        return bytes
    }

    private func url(for id: UUID) -> URL {
        directory.appendingPathComponent("\(id.uuidString.lowercased()).json")
    }

    private func failure(_ message: String) -> CaptureError {
        .corruptState("usage inbox: \(message)")
    }

    private func locked<T>(_ operation: () throws -> T) throws -> T {
        guard maximumItems > 0, maximumItemBytes > 0, maximumTotalBytes > 0 else {
            throw failure("invalid capacity")
        }
        guard try FileDurability.realDirectoryExists(at: directory.deletingLastPathComponent()) else {
            throw failure("the existing inbox container is unavailable")
        }
        if try !FileDurability.realDirectoryExists(at: directory) {
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            } catch let error as CocoaError where error.code == .fileWriteFileExists {
                guard try FileDurability.realDirectoryExists(at: directory) else { throw error }
            }
        }
        try FileDurability.excludeFromBackup(directory)
        try FileDurability.synchronizeParentDirectory(of: directory)
        let fd = directory.withUnsafeFileSystemRepresentation { open($0!, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { _ = close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { _ = flock(fd, LOCK_UN) }
        return try operation()
    }

    private func inventory() throws -> [(url: URL, size: Int)] {
        guard let stream = opendir(directory.path) else { throw failure("cannot enumerate inbox") }
        defer { closedir(stream) }
        var files: [(url: URL, size: Int)] = []
        var seen = Set<String>()
        var total = 0
        errno = 0
        while let entry = readdir(stream) {
            var nameBytes = entry.pointee.d_name
            let name = withUnsafeBytes(of: &nameBytes) { bytes in
                String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
            }
            if name == "." || name == ".." { continue }
            var admittedName = name
            if name.hasPrefix(".pending-"), let id = UUID(uuidString: String(name.dropFirst(9))) {
                let staging = directory.appendingPathComponent(name)
                guard let bytes = try FileDurability.readRegularFileIfPresent(at: staging, maximumBytes: maximumItemBytes),
                      let item = try? JSONDecoder().decode(UsageInboxItem.self, from: bytes), item.deliveryID == id else {
                    throw failure("incomplete publication requires recovery: \(name)")
                }
                let target = url(for: id)
                if let existing = try FileDurability.readRegularFileIfPresent(at: target, maximumBytes: maximumItemBytes) {
                    guard existing == bytes else { throw failure("conflicting interrupted publication") }
                } else {
                    try FileDurability.synchronizeFile(at: staging)
                    guard link(staging.path, target.path) == 0 else { throw failure("cannot recover publication") }
                }
                try FileDurability.synchronizeParentDirectory(of: target)
                try FileDurability.removeRegularFileIfPresentDurably(at: staging)
                admittedName = target.lastPathComponent
            }
            guard admittedName.hasSuffix(".json"), UUID(uuidString: String(admittedName.dropLast(5))) != nil else {
                throw failure("unexpected or interrupted publication requires recovery: \(name)")
            }
            let file = directory.appendingPathComponent(admittedName)
            if !seen.insert(admittedName).inserted { errno = 0; continue }
            guard files.count < maximumItems else { throw failure("inbox entry count exceeds capacity") }
            let size = try FileDurability.regularFileSize(at: file)
            guard size <= UInt64(maximumItemBytes), size <= UInt64(maximumTotalBytes - total) else {
                throw failure("inbox byte capacity exceeded")
            }
            total += Int(size)
            files.append((file, Int(size)))
            errno = 0
        }
        guard errno == 0 else { throw failure("directory enumeration failed") }
        return files.sorted { $0.url.lastPathComponent < $1.url.lastPathComponent }
    }
}
