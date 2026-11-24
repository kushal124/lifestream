import CryptoKit
import Foundation

#if canImport(Darwin)
    import Darwin
#elseif canImport(Glibc)
    import Glibc
#endif

struct FileIdentity: Sendable, Equatable {
    let device: UInt64
    let inode: UInt64
}

public enum FileDurability {
    public static func createPrivateDirectoryDurably(at directory: URL) throws {
        if try !realDirectoryExists(at: directory) {
            try createDirectoryDurably(at: directory)
        }
        try synchronizeParentDirectory(of: directory)
    }

    public static func removePrivateDirectoryIfPresent(at directory: URL) throws {
        guard let metadata = try entryMetadata(at: directory) else {
            try synchronizeParentDirectory(of: directory)
            return
        }
        guard isDirectory(metadata) else {
            throw CaptureError.corruptState(
                "refusing to remove non-directory private work entry: \(directory.path)"
            )
        }
        try FileManager.default.removeItem(at: directory)
        try synchronizeParentDirectory(of: directory)
    }

    public static func excludeFromBackup(_ directory: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = directory
        try url.setResourceValues(values)
    }

    public static let unlockedOnly: Data.WritingOptions = {
        #if os(iOS)
            [.atomic, .completeFileProtection]
        #else
            [.atomic]
        #endif
    }()

    public static func createDirectoryDurably(at directory: URL) throws {
        let fileManager = FileManager.default
        var ancestor = directory.standardizedFileURL
        var missing: [URL] = []
        while try entryMetadata(at: ancestor) == nil {
            let parent = ancestor.deletingLastPathComponent()
            guard parent.path != ancestor.path else {
                throw CaptureError.corruptState(
                    "cannot find an existing ancestor for directory \(directory.path)"
                )
            }
            missing.append(ancestor)
            ancestor = parent
        }
        guard let ancestorMetadata = try entryMetadata(at: ancestor),
            isDirectory(ancestorMetadata)
        else {
            throw CaptureError.corruptState(
                "directory ancestor is not a real directory: \(ancestor.path)"
            )
        }

        if missing.isEmpty {
            try synchronizeParentDirectory(of: ancestor)
            return
        }
        try synchronizeParentDirectory(of: ancestor)
        for component in missing.reversed() {
            try fileManager.createDirectory(
                at: component,
                withIntermediateDirectories: false
            )
            try synchronizeParentDirectory(of: component)
        }
    }

    public static func synchronizeFile(at url: URL) throws {
        EnergyLedger.shared.count("file_syncs")
        let handle = try openRegularFileForWriting(at: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }

    public static func synchronizeParentDirectory(of publishedURL: URL) throws {
        try synchronizeDirectory(at: publishedURL.deletingLastPathComponent())
    }

    public static func synchronizeDirectory(at directory: URL) throws {
        EnergyLedger.shared.count("file_syncs")
        let descriptor = directory.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        }
        guard descriptor >= 0 else { throw currentPOSIXError() }
        defer { _ = close(descriptor) }
        guard fsync(descriptor) == 0 else { throw currentPOSIXError() }
    }

    static func entryExists(at url: URL) throws -> Bool {
        try entryMetadata(at: url) != nil
    }

    public static func realDirectoryExists(at url: URL) throws -> Bool {
        guard let metadata = try entryMetadata(at: url) else { return false }
        guard isDirectory(metadata) else {
            throw CaptureError.corruptState(
                "path is not a real directory: \(url.path)"
            )
        }
        return true
    }

    static func directoryIdentity(at directory: URL) throws -> FileIdentity {
        let descriptor = directory.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        }
        guard descriptor >= 0 else { throw currentPOSIXError() }
        defer { _ = close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else { throw currentPOSIXError() }
        guard isDirectory(metadata) else {
            throw CaptureError.corruptState(
                "path is not a real directory: \(directory.path)"
            )
        }
        return FileIdentity(device: UInt64(metadata.st_dev), inode: UInt64(metadata.st_ino))
    }

    public static func removeRegularFileIfPresentDurably(at url: URL) throws {
        try removeRegularFileIfPresent(at: url)
        try synchronizeParentDirectory(of: url)
    }

    static func removeRegularFileIfPresent(at url: URL) throws {
        let result = url.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return unlink(path)
        }
        if result != 0, errno != ENOENT { throw currentPOSIXError() }
    }

    public static func readRegularFileIfPresent(
        at url: URL,
        maximumBytes: Int? = nil
    ) throws -> Data? {
        let handle: FileHandle
        do {
            handle = try openRegularFileForReading(at: url)
        } catch let error as POSIXError where error.code == .ENOENT {
            return nil
        }
        defer { try? handle.close() }
        guard let maximumBytes else {
            return try handle.readToEnd() ?? Data()
        }
        guard maximumBytes >= 0 else {
            throw CaptureError.corruptState("regular-file read limit is negative")
        }
        var result = Data()
        result.reserveCapacity(min(maximumBytes, 1_048_576))
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            guard chunk.count <= maximumBytes - result.count else {
                throw CaptureError.corruptState(
                    "regular file exceeds its bounded read limit: \(url.lastPathComponent)"
                )
            }
            result.append(chunk)
        }
        return result
    }

    static func readExactly(
        from handle: FileHandle,
        count: Int,
        eofDiagnostic: String
    ) throws -> Data {
        guard count >= 0 else {
            throw CaptureError.corruptState("requested a negative file byte count")
        }
        var result = Data()
        result.reserveCapacity(count)
        while result.count < count {
            guard let chunk = try handle.read(upToCount: count - result.count),
                !chunk.isEmpty
            else {
                throw CaptureError.corruptState(eofDiagnostic)
            }
            result.append(chunk)
        }
        return result
    }

    static func protectMediaFile(at url: URL) throws {
        let handle = try openRegularFileForWriting(at: url)
        defer { try? handle.close() }
        #if canImport(Darwin)
            guard fcntl(handle.fileDescriptor, F_SETPROTECTIONCLASS, Int32(3)) != -1 else {
                throw currentPOSIXError()
            }
        #endif
        try handle.synchronize()
    }

    public static func regularFileSize(at url: URL) throws -> UInt64 {
        let handle = try openRegularFileForReading(at: url)
        defer { try? handle.close() }
        return try handle.seekToEnd()
    }

    public static func openRegularFileForReading(at url: URL) throws -> FileHandle {
        try openRegularFile(at: url, flags: O_RDONLY)
    }

    public static func openRegularFileForWriting(at url: URL) throws -> FileHandle {
        try openRegularFile(at: url, flags: O_WRONLY)
    }

    public static func createRegularFileExclusively(at url: URL) throws -> FileHandle {
        try createRegularFileExclusively(at: url, setupAfterOpen: nil)
    }

    static func createRegularFileExclusively(
        at url: URL,
        setupAfterOpen: ((Int32) throws -> Void)?
    ) throws -> FileHandle {
        let descriptor = url.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return open(
                path,
                O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW,
                mode_t(0o600)
            )
        }
        guard descriptor >= 0 else { throw currentPOSIXError() }
        var metadata = stat()
        do {
            guard fstat(descriptor, &metadata) == 0,
                isRegularFile(metadata)
            else { throw currentPOSIXError() }
            try setupAfterOpen?(descriptor)
            #if canImport(Darwin)
                let protectionClassC: Int32 = 3
                guard fcntl(descriptor, F_SETPROTECTIONCLASS, protectionClassC) != -1 else {
                    throw currentPOSIXError()
                }
            #endif
            return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        } catch {
            let setupError = error
            var cleanupError: (any Error)?
            do {
                try removeCreatedEntry(at: url)
            } catch {
                cleanupError = error
            }
            _ = close(descriptor)
            if let cleanupError {
                throw CaptureError.corruptState(
                    "exclusive file setup failed (\(setupError)); cleanup failed (\(cleanupError))"
                )
            }
            throw setupError
        }
    }

    public static func writeNewRegularFileDurably(
        _ data: Data,
        to url: URL
    ) throws {
        let handle = try createRegularFileExclusively(at: url)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
            try synchronizeParentDirectory(of: url)
        } catch {
            try? handle.close()
            try? removeRegularFileIfPresentDurably(at: url)
            throw error
        }
    }

    private static func openRegularFile(
        at url: URL,
        flags: Int32
    ) throws -> FileHandle {
        let descriptor = url.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return open(path, flags | O_NOFOLLOW | O_NONBLOCK)
        }
        guard descriptor >= 0 else { throw currentPOSIXError() }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else {
            let error = currentPOSIXError()
            _ = close(descriptor)
            throw error
        }
        guard isRegularFile(metadata) else {
            _ = close(descriptor)
            throw CaptureError.corruptState(
                "path is not a real regular file: \(url.path)"
            )
        }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    private static func removeCreatedEntry(at url: URL) throws {
        let result = url.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return unlink(path)
        }
        if result != 0, errno != ENOENT { throw currentPOSIXError() }
        try synchronizeParentDirectory(of: url)
    }

    private static func entryMetadata(at url: URL) throws -> stat? {
        var metadata = stat()
        let result = url.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return lstat(path, &metadata)
        }
        if result == 0 { return metadata }
        guard errno == ENOENT else { throw currentPOSIXError() }
        return nil
    }

    private static func isDirectory(_ metadata: stat) -> Bool {
        metadata.st_mode & S_IFMT == S_IFDIR
    }

    private static func isRegularFile(_ metadata: stat) -> Bool {
        metadata.st_mode & S_IFMT == S_IFREG
    }

    private static func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

public final class OwnedMediaFile: Sendable {
    public let url: URL

    public init(takingOwnershipOf url: URL) { self.url = url }

    deinit { try? FileManager.default.removeItem(at: url) }
}

extension FileDurability {
    public static func copyRegularFileDurably(from source: URL, to destination: URL) throws {
        try copyRegularFileDurably(from: source, to: destination, observing: { _ in })
    }

    public static func copyRegularFileDurablyHashing(
        from source: URL, to destination: URL
    ) throws -> (sha256: String, bytes: UInt64) {
        var hasher = SHA256()
        var bytes: UInt64 = 0
        try copyRegularFileDurably(from: source, to: destination) { chunk in
            hasher.update(data: chunk)
            bytes += UInt64(chunk.count)
        }
        return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), bytes)
    }

    private static func copyRegularFileDurably(
        from source: URL, to destination: URL, observing: (Data) -> Void
    ) throws {
        let reader = try openRegularFileForReading(at: source)
        defer { try? reader.close() }
        let writer = try createRegularFileExclusively(at: destination)
        do {
            while try autoreleasepool(invoking: {
                guard let chunk = try reader.read(upToCount: 1_048_576), !chunk.isEmpty else { return false }
                try writer.write(contentsOf: chunk)
                observing(chunk)
                return true
            }) {}
            try writer.synchronize()
            try writer.close()
            try synchronizeParentDirectory(of: destination)
        } catch {
            try? writer.close()
            try? removeRegularFileIfPresentDurably(at: destination)
            throw error
        }
    }
}
