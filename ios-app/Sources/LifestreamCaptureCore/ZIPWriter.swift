import CryptoKit
import Foundation

#if canImport(Darwin)
    import Darwin
#elseif canImport(Glibc)
    import Glibc
#endif

public enum StoredZIPWriter {
    struct PreparedArchive: Sendable {
        let temporaryURL: URL
        let destinationURL: URL
        let archiveSHA256: String
        let directoryIdentity: FileIdentity
        let temporaryFileIdentity: FileIdentity
        let archiveSize: UInt64
    }

    private struct ArchiveEntry {
        let name: String
        let crc32: UInt32
        let size: UInt64
        let localHeaderOffset: UInt64
    }

    private struct LocalEntryLayout {
        let dataOffset: UInt64
        let endOffset: UInt64
    }

    private struct SourceReadResult {
        let bytesRead: UInt64
        let crc32: UInt32
    }

    private static let maximumCentralDirectoryBytes: UInt64 = 16 * 1_024 * 1_024
    private static let maximumArchiveEntries: UInt64 = 100_000
    private static let maximumManifestBytes: UInt64 = 16 * 1_024 * 1_024

    public static func write(fileURLs: [String: URL], to destination: URL) throws {
        let prepared = try prepare(fileURLs: fileURLs, to: destination)
        defer {
            try? removeTemporary(prepared)
        }
        try publish(prepared)
    }

    static func prepare(
        fileURLs: [String: URL],
        to destination: URL,
        temporaryURL suppliedTemporaryURL: URL? = nil,
        afterSourceChecksum: ((String) throws -> Void)? = nil,
        precomputedCRC32: [String: UInt32] = [:],
        expectedSHA256: [String: String] = [:]
    ) throws -> PreparedArchive {
        struct Source {
            let name: Data
            let size: UInt64
            let crc: UInt32
            let localOffset: UInt64
        }
        let sortedFiles = fileURLs.sorted { $0.key < $1.key }
        guard !sortedFiles.isEmpty,
            UInt64(sortedFiles.count) <= maximumArchiveEntries
        else {
            throw CaptureError.zipTooLarge
        }
        var admittedCentralDirectoryBytes: UInt64 = 0
        for (name, _) in sortedFiles {
            let fixedEntryBytes: UInt64 = 46 + 28
            let nameBytes = UInt64(name.utf8.count)
            guard nameBytes <= maximumCentralDirectoryBytes - fixedEntryBytes else {
                throw CaptureError.zipTooLarge
            }
            let entryBytes = fixedEntryBytes + nameBytes
            guard admittedCentralDirectoryBytes <= maximumCentralDirectoryBytes - entryBytes else {
                throw CaptureError.zipTooLarge
            }
            admittedCentralDirectoryBytes += entryBytes
        }
        for (name, _) in sortedFiles where !isSafe(name) {
            throw CaptureError.unsafeFilename(name)
        }
        let temporary =
            suppliedTemporaryURL
            ?? destination.deletingLastPathComponent()
            .appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")
        let directory = temporary.deletingLastPathComponent()
        guard
            directory.standardizedFileURL.path
                == destination.deletingLastPathComponent().standardizedFileURL.path
        else {
            throw CaptureError.corruptState(
                "archive temporary must share its destination directory"
            )
        }
        let createdInDirectoryIdentity = try FileDurability.directoryIdentity(at: directory)
        let descriptor = temporary.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        }
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        let createdTemporaryIdentity = try archiveFileSnapshot(for: output).identity
        var retainsPreparedArchive = false
        defer {
            if !retainsPreparedArchive {
                try? removeTemporary(
                    at: temporary,
                    directoryIdentity: createdInDirectoryIdentity,
                    expectedFileIdentity: createdTemporaryIdentity
                )
            }
        }
        #if os(iOS)
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: temporary.path
            )
        #endif
        var offset: UInt64 = 0
        var central: [Source] = []
        var archiveHasher = SHA256()
        do {
            func emit(_ data: Data) throws {
                try output.write(contentsOf: data)
                archiveHasher.update(data: data)
                offset += UInt64(data.count)
            }
            for (name, url) in sortedFiles {
                let nameBytes = Data(name.utf8)
                guard nameBytes.count <= Int(UInt16.max) else { throw CaptureError.zipTooLarge }
                let input = try FileDurability.openRegularFileForReading(at: url)
                do {
                    let initialSnapshot = try archiveFileSnapshot(
                        for: input,
                        role: "archive source \(name)"
                    )
                    if name == "manifest.json",
                        initialSnapshot.size > maximumManifestBytes
                    {
                        throw CaptureError.zipTooLarge
                    }

                    let checksum: UInt32
                    if let precomputed = precomputedCRC32[name] {
                        checksum = precomputed
                    } else {
                        let checksumPass = try readSource(
                            input,
                            expectedSize: initialSnapshot.size,
                            name: name,
                            consume: { _ in }
                        )
                        guard
                            try archiveFileSnapshot(
                                for: input,
                                role: "archive source \(name)"
                            ) == initialSnapshot
                        else {
                            throw changedSource(name)
                        }
                        checksum = checksumPass.crc32
                    }
                    try afterSourceChecksum?(name)

                    let source = Source(
                        name: nameBytes,
                        size: initialSnapshot.size,
                        crc: checksum,
                        localOffset: offset
                    )
                    var header = Data()
                    header.appendLE(UInt32(0x0403_4B50))
                    header.appendLE(UInt16(45))
                    header.appendLE(UInt16(0x0800))
                    header.appendLE(UInt16(0))
                    header.appendLE(UInt16(0))
                    header.appendLE(UInt16(0))
                    header.appendLE(source.crc)
                    header.appendLE(UInt32.max)
                    header.appendLE(UInt32.max)
                    header.appendLE(UInt16(nameBytes.count))
                    header.appendLE(UInt16(20))
                    header.append(nameBytes)
                    header.appendLE(UInt16(0x0001))
                    header.appendLE(UInt16(16))
                    header.appendLE(source.size)
                    header.appendLE(source.size)
                    try emit(header)

                    var memberHasher = SHA256()
                    let expectedHash = expectedSHA256[name]
                    let archivePass = try readSource(
                        input,
                        expectedSize: source.size,
                        name: name,
                        computesCRC: precomputedCRC32[name] == nil,
                        consume: { chunk in
                            if expectedHash != nil { memberHasher.update(data: chunk) }
                            try emit(chunk)
                        }
                    )
                    if let expectedHash {
                        let actual = "sha256:" + memberHasher.finalize().map { String(format: "%02x", $0) }.joined()
                        guard actual == expectedHash else { throw changedSource(name) }
                    }
                    let finalSnapshot = try archiveFileSnapshot(
                        for: input,
                        role: "archive source \(name)"
                    )
                    guard finalSnapshot == initialSnapshot,
                        archivePass.bytesRead == source.size,
                        precomputedCRC32[name] != nil || archivePass.crc32 == source.crc
                    else {
                        throw changedSource(name)
                    }
                    try input.close()
                    central.append(source)
                } catch {
                    try? input.close()
                    throw error
                }
            }

            let centralOffset = offset
            for source in central {
                var header = Data()
                header.appendLE(UInt32(0x0201_4B50))
                header.appendLE(UInt16(45))
                header.appendLE(UInt16(45))
                header.appendLE(UInt16(0x0800))
                header.appendLE(UInt16(0))
                header.appendLE(UInt16(0))
                header.appendLE(UInt16(0))
                header.appendLE(source.crc)
                header.appendLE(UInt32.max)
                header.appendLE(UInt32.max)
                header.appendLE(UInt16(source.name.count))
                header.appendLE(UInt16(28))
                header.appendLE(UInt16(0))
                header.appendLE(UInt16(0))
                header.appendLE(UInt16(0))
                header.appendLE(UInt32(0))
                header.appendLE(UInt32.max)
                header.append(source.name)
                header.appendLE(UInt16(0x0001))
                header.appendLE(UInt16(24))
                header.appendLE(source.size)
                header.appendLE(source.size)
                header.appendLE(source.localOffset)
                try emit(header)
            }
            let centralSize = offset - centralOffset
            let zip64EndOffset = offset
            var footer = Data()
            footer.appendLE(UInt32(0x0606_4B50))
            footer.appendLE(UInt64(44))
            footer.appendLE(UInt16(45))
            footer.appendLE(UInt16(45))
            footer.appendLE(UInt32(0))
            footer.appendLE(UInt32(0))
            footer.appendLE(UInt64(central.count))
            footer.appendLE(UInt64(central.count))
            footer.appendLE(centralSize)
            footer.appendLE(centralOffset)
            footer.appendLE(UInt32(0x0706_4B50))
            footer.appendLE(UInt32(0))
            footer.appendLE(zip64EndOffset)
            footer.appendLE(UInt32(1))
            footer.appendLE(UInt32(0x0605_4B50))
            footer.appendLE(UInt16(0))
            footer.appendLE(UInt16(0))
            footer.appendLE(UInt16.max)
            footer.appendLE(UInt16.max)
            footer.appendLE(UInt32.max)
            footer.appendLE(UInt32.max)
            footer.appendLE(UInt16(0))
            try emit(footer)
            try output.synchronize()
            let completedTemporary = try archiveFileSnapshot(for: output)
            guard completedTemporary.identity == createdTemporaryIdentity,
                completedTemporary.size == offset
            else {
                throw CaptureError.corruptState(
                    "prepared archive changed while it was being written"
                )
            }
            try output.close()
            try FileDurability.synchronizeParentDirectory(of: temporary)
            let archiveSHA256 =
                "sha256:"
                + archiveHasher.finalize()
                .map { String(format: "%02x", $0) }
                .joined()
            let prepared = PreparedArchive(
                temporaryURL: temporary,
                destinationURL: destination,
                archiveSHA256: archiveSHA256,
                directoryIdentity: createdInDirectoryIdentity,
                temporaryFileIdentity: completedTemporary.identity,
                archiveSize: completedTemporary.size
            )
            retainsPreparedArchive = true
            return prepared
        } catch {
            try? output.close()
            throw error
        }
    }

    static func publish(_ prepared: PreparedArchive) throws {
        try validateDirectoryIdentity(of: prepared)
        try publishAfterDirectoryValidation(prepared)
    }

    static func publishAfterDirectoryValidation(_ prepared: PreparedArchive) throws {
        let temporaryExists: Bool
        do {
            try validatePreparedArchive(
                at: prepared.temporaryURL,
                expectedIdentity: prepared.temporaryFileIdentity,
                expectedSize: prepared.archiveSize,
                expectedSHA256: prepared.archiveSHA256,
                role: "temporary"
            )
            temporaryExists = true
        } catch let error as POSIXError where error.code == .ENOENT {
            temporaryExists = false
        }
        if temporaryExists {
            do {
                try FileManager.default.moveItem(
                    at: prepared.temporaryURL,
                    to: prepared.destinationURL
                )
            } catch {
                try validatePreparedArchive(
                    at: prepared.destinationURL,
                    expectedIdentity: prepared.temporaryFileIdentity,
                    expectedSize: prepared.archiveSize,
                    expectedSHA256: prepared.archiveSHA256,
                    role: "destination"
                )
                try removeTemporary(prepared)
            }
        } else {
            try validatePreparedArchive(
                at: prepared.destinationURL,
                expectedIdentity: prepared.temporaryFileIdentity,
                expectedSize: prepared.archiveSize,
                expectedSHA256: prepared.archiveSHA256,
                role: "destination"
            )
        }
        try validatePreparedArchiveIdentity(
            at: prepared.destinationURL,
            expectedIdentity: prepared.temporaryFileIdentity,
            expectedSize: prepared.archiveSize,
            role: "destination"
        )
        try FileDurability.synchronizeFile(at: prepared.destinationURL)
        try FileDurability.synchronizeParentDirectory(of: prepared.destinationURL)
    }

    static func removeTemporary(_ prepared: PreparedArchive) throws {
        try removeTemporary(
            at: prepared.temporaryURL,
            directoryIdentity: prepared.directoryIdentity,
            expectedFileIdentity: prepared.temporaryFileIdentity
        )
    }

    static func removeTemporary(
        at temporary: URL,
        directoryIdentity: FileIdentity,
        expectedFileIdentity: FileIdentity? = nil
    ) throws {
        guard
            try FileDurability.directoryIdentity(
                at: temporary.deletingLastPathComponent()
            ) == directoryIdentity
        else {
            throw CaptureError.corruptState(
                "archive custody directory changed; refusing temporary cleanup"
            )
        }
        if let expectedFileIdentity {
            do {
                let actual = try archiveFileSnapshot(at: temporary).identity
                guard actual == expectedFileIdentity else {
                    throw CaptureError.corruptState(
                        "prepared archive temporary was replaced; refusing cleanup"
                    )
                }
            } catch let error as POSIXError where error.code == .ENOENT {
            }
        }
        try FileDurability.removeRegularFileIfPresentDurably(at: temporary)
    }

    private static func validateDirectoryIdentity(
        of prepared: PreparedArchive
    ) throws {
        guard
            try FileDurability.directoryIdentity(
                at: prepared.destinationURL.deletingLastPathComponent()
            ) == prepared.directoryIdentity
        else {
            throw CaptureError.corruptState(
                "archive custody directory changed during publication"
            )
        }
    }

    private struct ArchiveFileSnapshot: Equatable {
        let identity: FileIdentity
        let size: UInt64
    }

    private static func validatePreparedArchiveIdentity(
        at url: URL,
        expectedIdentity: FileIdentity,
        expectedSize: UInt64,
        role: String
    ) throws {
        let snapshot = try archiveFileSnapshot(at: url)
        guard snapshot.identity == expectedIdentity,
            snapshot.size == expectedSize
        else {
            throw CaptureError.corruptState(
                "prepared archive \(role) was replaced before publication"
            )
        }
    }

    private static func validatePreparedArchive(
        at url: URL,
        expectedIdentity: FileIdentity,
        expectedSize: UInt64,
        expectedSHA256: String,
        role: String
    ) throws {
        let input = try FileDurability.openRegularFileForReading(at: url)
        defer { try? input.close() }
        let before = try archiveFileSnapshot(for: input)
        guard before.identity == expectedIdentity,
            before.size == expectedSize
        else {
            throw CaptureError.corruptState(
                "prepared archive \(role) was replaced before publication"
            )
        }

        var hasher = SHA256()
        var bytesRead: UInt64 = 0
        while try withZIPTemporaryObjects({
            guard let chunk = try input.read(upToCount: 1_048_576), !chunk.isEmpty else { return false }
            let (next, overflow) = bytesRead.addingReportingOverflow(UInt64(chunk.count))
            guard !overflow, next <= expectedSize else {
                throw CaptureError.corruptState(
                    "prepared archive \(role) changed while validating its digest"
                )
            }
            bytesRead = next
            hasher.update(data: chunk)
            return true
        }) {}
        let after = try archiveFileSnapshot(for: input)
        guard before == after, bytesRead == expectedSize else {
            throw CaptureError.corruptState(
                "prepared archive \(role) changed while validating its digest"
            )
        }
        let digest =
            "sha256:"
            + hasher.finalize()
            .map { String(format: "%02x", $0) }
            .joined()
        guard digest == expectedSHA256 else {
            throw CaptureError.corruptState(
                "prepared archive \(role) digest does not match the staged bytes"
            )
        }
    }

    private static func archiveFileSnapshot(at url: URL) throws -> ArchiveFileSnapshot {
        let input = try FileDurability.openRegularFileForReading(at: url)
        defer { try? input.close() }
        return try archiveFileSnapshot(for: input)
    }

    private static func archiveFileSnapshot(
        for handle: FileHandle,
        role: String = "prepared archive"
    ) throws -> ArchiveFileSnapshot {
        var metadata = stat()
        guard fstat(handle.fileDescriptor, &metadata) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard metadata.st_mode & S_IFMT == S_IFREG,
            metadata.st_size >= 0
        else {
            throw CaptureError.corruptState(
                "\(role) is not a real regular file"
            )
        }
        return ArchiveFileSnapshot(
            identity: .init(
                device: UInt64(metadata.st_dev),
                inode: UInt64(metadata.st_ino)
            ),
            size: UInt64(metadata.st_size)
        )
    }

    private static func readSource(
        _ input: FileHandle,
        expectedSize: UInt64,
        name: String,
        computesCRC: Bool = true,
        consume: (Data) throws -> Void
    ) throws -> SourceReadResult {
        try input.seek(toOffset: 0)
        var bytesRead: UInt64 = 0
        var crc = CRC32.Accumulator()
        while try withZIPTemporaryObjects({
            guard let chunk = try input.read(upToCount: 1_048_576), !chunk.isEmpty else { return false }
            let (next, overflow) = bytesRead.addingReportingOverflow(UInt64(chunk.count))
            guard !overflow, next <= expectedSize else {
                throw changedSource(name)
            }
            bytesRead = next
            if computesCRC { crc.update(chunk) }
            try consume(chunk)
            return true
        }) {}
        guard bytesRead == expectedSize else {
            throw changedSource(name)
        }
        return SourceReadResult(bytesRead: bytesRead, crc32: crc.finalized)
    }

    private static func changedSource(_ name: String) -> CaptureError {
        .corruptState("archive source changed while preparing: \(name)")
    }

    public static func readManifest(from archiveURL: URL) throws -> ExportBundleManifest {
        let input = try FileDurability.openRegularFileForReading(at: archiveURL)
        defer { try? input.close() }
        let archiveSize = try input.seekToEnd()
        guard archiveSize >= 22 else {
            throw invalidArchive("missing end-of-central-directory record")
        }

        let eocdOffset = archiveSize - 22
        let eocd = try readExactly(input, offset: eocdOffset, count: 22)
        guard try eocd.uint32LE(at: 0) == 0x0605_4B50,
            try eocd.uint16LE(at: 4) == 0,
            try eocd.uint16LE(at: 6) == 0,
            try eocd.uint16LE(at: 20) == 0
        else {
            throw invalidArchive("unsupported end-of-central-directory record")
        }

        let eocdEntriesOnDisk = try eocd.uint16LE(at: 8)
        let eocdEntryCount = try eocd.uint16LE(at: 10)
        let eocdCentralSize = try eocd.uint32LE(at: 12)
        let eocdCentralOffset = try eocd.uint32LE(at: 16)
        let usesZIP64 =
            eocdEntryCount == UInt16.max
            || eocdEntriesOnDisk == UInt16.max
            || eocdCentralSize == UInt32.max
            || eocdCentralOffset == UInt32.max

        let entryCount: UInt64
        let centralSize: UInt64
        let centralOffset: UInt64
        let centralEnd: UInt64
        if usesZIP64 {
            guard eocdEntryCount == UInt16.max,
                eocdEntriesOnDisk == UInt16.max,
                eocdCentralSize == UInt32.max,
                eocdCentralOffset == UInt32.max,
                eocdOffset >= 20
            else {
                throw invalidArchive("incomplete ZIP64 sentinel metadata")
            }
            let locatorOffset = eocdOffset - 20
            let locator = try readExactly(input, offset: locatorOffset, count: 20)
            guard try locator.uint32LE(at: 0) == 0x0706_4B50,
                try locator.uint32LE(at: 4) == 0,
                try locator.uint32LE(at: 16) == 1
            else {
                throw invalidArchive("invalid ZIP64 locator")
            }
            let zip64Offset = try locator.uint64LE(at: 8)
            guard zip64Offset <= locatorOffset,
                locatorOffset - zip64Offset == 56
            else {
                throw invalidArchive("invalid ZIP64 end-record offset")
            }
            let zip64 = try readExactly(input, offset: zip64Offset, count: 56)
            let zip64EntriesOnDisk = try zip64.uint64LE(at: 24)
            let zip64EntryCount = try zip64.uint64LE(at: 32)
            guard try zip64.uint32LE(at: 0) == 0x0606_4B50,
                try zip64.uint64LE(at: 4) == 44,
                try zip64.uint32LE(at: 16) == 0,
                try zip64.uint32LE(at: 20) == 0,
                zip64EntriesOnDisk == zip64EntryCount
            else {
                throw invalidArchive("invalid ZIP64 end record")
            }
            entryCount = zip64EntryCount
            centralSize = try zip64.uint64LE(at: 40)
            centralOffset = try zip64.uint64LE(at: 48)
            centralEnd = zip64Offset
        } else {
            guard eocdEntriesOnDisk == eocdEntryCount else {
                throw invalidArchive("multi-disk archives are unsupported")
            }
            entryCount = UInt64(eocdEntryCount)
            centralSize = UInt64(eocdCentralSize)
            centralOffset = UInt64(eocdCentralOffset)
            centralEnd = eocdOffset
        }

        guard entryCount > 0,
            entryCount <= maximumArchiveEntries,
            centralSize <= maximumCentralDirectoryBytes,
            centralOffset <= centralEnd,
            centralSize == centralEnd - centralOffset
        else {
            throw invalidArchive("central directory exceeds bounded deterministic layout")
        }
        let central = try readExactly(
            input,
            offset: centralOffset,
            count: try boundedInt(centralSize)
        )
        let entries = try parseCentralDirectory(central, entryCount: entryCount)
        guard entries.map(\.name) == entries.map(\.name).sorted(),
            Set(entries.map(\.name)).count == entries.count,
            entries.map(\.localHeaderOffset)
                == entries.map(\.localHeaderOffset).sorted(),
            let manifestEntry = entries.first(where: { $0.name == "manifest.json" }),
            entries.filter({ $0.name == "manifest.json" }).count == 1,
            manifestEntry.size <= maximumManifestBytes
        else {
            throw invalidArchive("archive entries are not uniquely deterministic")
        }

        var nextLocalOffset: UInt64 = 0
        var manifestLayout: LocalEntryLayout?
        for entry in entries {
            guard entry.localHeaderOffset == nextLocalOffset else {
                throw invalidArchive(
                    "local archive members are not contiguous in writer order"
                )
            }
            let layout = try validateStoredEntryLayout(
                entry,
                from: input,
                before: centralOffset
            )
            nextLocalOffset = layout.endOffset
            if entry.name == "manifest.json" {
                manifestLayout = layout
            }
        }
        guard nextLocalOffset == centralOffset,
            let manifestLayout
        else {
            throw invalidArchive(
                "local archive members do not end at the central directory"
            )
        }
        let manifestBytes = try readExactly(
            input,
            offset: manifestLayout.dataOffset,
            count: try boundedInt(manifestEntry.size)
        )
        guard CRC32.checksum(manifestBytes) == manifestEntry.crc32 else {
            throw invalidArchive("manifest CRC does not match its bytes")
        }
        let manifest: ExportBundleManifest
        do {
            manifest = try JSONDecoder.lifestream().decode(
                ExportBundleManifest.self,
                from: manifestBytes
            )
        } catch {
            throw invalidArchive("manifest.json cannot be decoded: \(error)")
        }

        let archivedNames = Set(entries.map(\.name))
        let manifestNames = Set(manifest.files.keys).union(["manifest.json"])
        guard archivedNames == manifestNames else {
            throw invalidArchive("central directory does not match manifest topology")
        }
        let entriesByName = Dictionary(uniqueKeysWithValues: entries.map { ($0.name, $0) })
        for (name, file) in manifest.files {
            guard entriesByName[name]?.size == file.bytes else {
                throw invalidArchive("archive size does not match manifest for \(name)")
            }
        }
        return manifest
    }

    private static func parseCentralDirectory(
        _ central: Data,
        entryCount: UInt64
    ) throws -> [ArchiveEntry] {
        var entries: [ArchiveEntry] = []
        entries.reserveCapacity(try boundedInt(entryCount))
        var offset = 0
        for _ in 0..<entryCount {
            guard offset <= central.count,
                central.count - offset >= 46,
                try central.uint32LE(at: offset) == 0x0201_4B50
            else {
                throw invalidArchive("invalid central-directory entry")
            }
            let flags = try central.uint16LE(at: offset + 8)
            let method = try central.uint16LE(at: offset + 10)
            let crc32 = try central.uint32LE(at: offset + 16)
            let compressed32 = try central.uint32LE(at: offset + 20)
            let uncompressed32 = try central.uint32LE(at: offset + 24)
            let nameLength = Int(try central.uint16LE(at: offset + 28))
            let extraLength = Int(try central.uint16LE(at: offset + 30))
            let commentLength = Int(try central.uint16LE(at: offset + 32))
            let diskStart = try central.uint16LE(at: offset + 34)
            let localOffset32 = try central.uint32LE(at: offset + 42)
            let variableLength = nameLength + extraLength + commentLength
            guard flags == 0x0800,
                method == 0,
                diskStart == 0,
                commentLength == 0,
                variableLength <= central.count - offset - 46
            else {
                throw invalidArchive("unsupported central-directory entry")
            }
            let nameStart = offset + 46
            let nameData = central.subdata(in: nameStart..<(nameStart + nameLength))
            guard let name = String(data: nameData, encoding: .utf8),
                isSafe(name)
            else {
                throw invalidArchive("invalid archive entry name")
            }
            let extraStart = nameStart + nameLength
            let extra = central.subdata(in: extraStart..<(extraStart + extraLength))
            let requiresZIP64 =
                compressed32 == UInt32.max
                || uncompressed32 == UInt32.max
                || localOffset32 == UInt32.max
            let compressed: UInt64
            let uncompressed: UInt64
            let localHeaderOffset: UInt64
            if requiresZIP64 {
                guard compressed32 == UInt32.max,
                    uncompressed32 == UInt32.max,
                    localOffset32 == UInt32.max,
                    extra.count == 28,
                    try extra.uint16LE(at: 0) == 0x0001,
                    try extra.uint16LE(at: 2) == 24
                else {
                    throw invalidArchive("invalid ZIP64 central extra field")
                }
                uncompressed = try extra.uint64LE(at: 4)
                compressed = try extra.uint64LE(at: 12)
                localHeaderOffset = try extra.uint64LE(at: 20)
            } else {
                guard extra.isEmpty else {
                    throw invalidArchive("unexpected central extra field")
                }
                compressed = UInt64(compressed32)
                uncompressed = UInt64(uncompressed32)
                localHeaderOffset = UInt64(localOffset32)
            }
            guard compressed == uncompressed else {
                throw invalidArchive("compressed archive member is unsupported")
            }
            entries.append(
                .init(
                    name: name,
                    crc32: crc32,
                    size: uncompressed,
                    localHeaderOffset: localHeaderOffset
                ))
            offset += 46 + variableLength
        }
        guard offset == central.count else {
            throw invalidArchive("central directory has trailing bytes")
        }
        return entries
    }

    private static func validateStoredEntryLayout(
        _ entry: ArchiveEntry,
        from input: FileHandle,
        before centralOffset: UInt64
    ) throws -> LocalEntryLayout {
        guard entry.localHeaderOffset <= centralOffset,
            centralOffset - entry.localHeaderOffset >= 30
        else {
            throw invalidArchive("local entry offset is outside the archive")
        }
        let fixed = try readExactly(input, offset: entry.localHeaderOffset, count: 30)
        guard try fixed.uint32LE(at: 0) == 0x0403_4B50,
            try fixed.uint16LE(at: 6) == 0x0800,
            try fixed.uint16LE(at: 8) == 0,
            try fixed.uint16LE(at: 10) == 0,
            try fixed.uint16LE(at: 12) == 0,
            try fixed.uint32LE(at: 14) == entry.crc32
        else {
            throw invalidArchive("local entry metadata is invalid")
        }
        let compressed32 = try fixed.uint32LE(at: 18)
        let uncompressed32 = try fixed.uint32LE(at: 22)
        let nameLength = Int(try fixed.uint16LE(at: 26))
        let extraLength = Int(try fixed.uint16LE(at: 28))
        guard nameLength + extraLength <= Int(UInt16.max) * 2 else {
            throw invalidArchive("local entry metadata is too large")
        }
        let variable = try readExactly(
            input,
            offset: entry.localHeaderOffset + 30,
            count: nameLength + extraLength
        )
        let nameData = variable.prefix(nameLength)
        guard String(data: nameData, encoding: .utf8) == entry.name else {
            throw invalidArchive("local and central entry names disagree")
        }
        let extra = variable.dropFirst(nameLength)
        let size: UInt64
        let expectedVersion: UInt16
        if compressed32 == UInt32.max || uncompressed32 == UInt32.max {
            let extraData = Data(extra)
            let zip64UncompressedSize = try extraData.uint64LE(at: 4)
            let zip64CompressedSize = try extraData.uint64LE(at: 12)
            guard compressed32 == UInt32.max,
                uncompressed32 == UInt32.max,
                extraData.count == 20,
                try extraData.uint16LE(at: 0) == 0x0001,
                try extraData.uint16LE(at: 2) == 16,
                zip64UncompressedSize == zip64CompressedSize
            else {
                throw invalidArchive("invalid ZIP64 local extra field")
            }
            size = zip64UncompressedSize
            expectedVersion = 45
        } else {
            guard extra.isEmpty, compressed32 == uncompressed32 else {
                throw invalidArchive("unsupported local entry layout")
            }
            size = UInt64(uncompressed32)
            expectedVersion = 20
        }
        guard try fixed.uint16LE(at: 4) == expectedVersion,
            size == entry.size
        else {
            throw invalidArchive("local and central entry sizes disagree")
        }
        let dataOffset = entry.localHeaderOffset + 30 + UInt64(nameLength + extraLength)
        guard dataOffset <= centralOffset,
            size <= centralOffset - dataOffset
        else {
            throw invalidArchive("archive member extends into the central directory")
        }
        let (endOffset, overflow) = dataOffset.addingReportingOverflow(size)
        guard !overflow else {
            throw invalidArchive("archive member extent overflows UInt64")
        }
        return .init(dataOffset: dataOffset, endOffset: endOffset)
    }

    private static func readExactly(
        _ input: FileHandle,
        offset: UInt64,
        count: Int
    ) throws -> Data {
        try input.seek(toOffset: offset)
        var result = Data()
        result.reserveCapacity(count)
        while result.count < count {
            guard let chunk = try input.read(upToCount: count - result.count),
                !chunk.isEmpty
            else {
                throw invalidArchive("archive ended before its declared metadata")
            }
            result.append(chunk)
        }
        return result
    }

    private static func boundedInt(_ value: UInt64) throws -> Int {
        guard let result = Int(exactly: value) else {
            throw invalidArchive("archive metadata exceeds platform limits")
        }
        return result
    }

    private static func invalidArchive(_ diagnostic: String) -> CaptureError {
        .corruptState("export archive: \(diagnostic)")
    }

    private static func isSafe(_ name: String) -> Bool {
        !name.isEmpty && !name.hasPrefix("/") && !name.contains("\\")
            && !name.split(separator: "/").contains("..")
    }

}

private func withZIPTemporaryObjects<T>(_ body: () throws -> T) rethrows -> T {
    #if canImport(ObjectiveC)
        return try autoreleasepool(invoking: body)
    #else
        return try body()
    #endif
}

extension Data {
    fileprivate mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var little = value.littleEndian
        Swift.withUnsafeBytes(of: &little) { append(contentsOf: $0) }
    }

    fileprivate func uint16LE(at offset: Int) throws -> UInt16 {
        guard offset >= 0, offset <= count, count - offset >= 2 else {
            throw CaptureError.corruptState("export archive: truncated integer")
        }
        let index = startIndex + offset
        return UInt16(self[index]) | (UInt16(self[index + 1]) << 8)
    }

    fileprivate func uint32LE(at offset: Int) throws -> UInt32 {
        guard offset >= 0, offset <= count, count - offset >= 4 else {
            throw CaptureError.corruptState("export archive: truncated integer")
        }
        let index = startIndex + offset
        return UInt32(self[index])
            | (UInt32(self[index + 1]) << 8)
            | (UInt32(self[index + 2]) << 16)
            | (UInt32(self[index + 3]) << 24)
    }

    fileprivate func uint64LE(at offset: Int) throws -> UInt64 {
        guard offset >= 0, offset <= count, count - offset >= 8 else {
            throw CaptureError.corruptState("export archive: truncated integer")
        }
        let index = startIndex + offset
        var result: UInt64 = 0
        for byteOffset in 0..<8 {
            result |= UInt64(self[index + byteOffset]) << UInt64(byteOffset * 8)
        }
        return result
    }
}
