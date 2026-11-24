import Foundation
import XCTest

@testable import LifestreamCaptureCore

final class CoreTests: XCTestCase {

    func testExactRangeReadJoinsShortReadsAndRejectsEarlyEOF() async throws {
        let pipe = Pipe()
        let reader = pipe.fileHandleForReading
        let writer = pipe.fileHandleForWriting
        try writer.write(contentsOf: Data("ab".utf8))
        let remainingWrite = Task.detached {
            try await Task.sleep(for: .milliseconds(10))
            try writer.write(contentsOf: Data("cde".utf8))
            try writer.close()
        }

        let joined = try FileDurability.readExactly(
            from: reader,
            count: 5,
            eofDiagnostic: "unexpected EOF"
        )
        try await remainingWrite.value
        XCTAssertEqual(joined, Data("abcde".utf8))

        let shortPipe = Pipe()
        try shortPipe.fileHandleForWriting.write(contentsOf: Data("abc".utf8))
        try shortPipe.fileHandleForWriting.close()
        XCTAssertThrowsError(
            try FileDurability.readExactly(
                from: shortPipe.fileHandleForReading,
                count: 4,
                eofDiagnostic: "expected early EOF"
            )
        ) { error in
            XCTAssertTrue(String(describing: error).contains("expected early EOF"))
        }
    }

    #if canImport(Darwin)
        func testExclusiveFileCreationAppliesClassCDataProtection() throws {
            let root = try temporaryDirectory()
            let exclusiveURL = root.appendingPathComponent("exclusive.dat")
            let exclusiveHandle = try FileDurability.createRegularFileExclusively(
                at: exclusiveURL
            )
            try exclusiveHandle.close()

            let durableURL = root.appendingPathComponent("durable.dat")
            try FileDurability.writeNewRegularFileDurably(
                Data("protected".utf8),
                to: durableURL
            )

            for url in [exclusiveURL, durableURL] {
                let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                XCTAssertEqual(
                    attributes[.protectionKey] as? FileProtectionType,
                    .completeUntilFirstUserAuthentication,
                    url.lastPathComponent
                )
            }
        }

        func testExclusiveFileSetupFailureRemovesCreatedEntryForRetry() throws {
            let root = try temporaryDirectory()
            let url = root.appendingPathComponent("retry.dat")

            XCTAssertThrowsError(
                try FileDurability.createRegularFileExclusively(
                    at: url,
                    setupAfterOpen: { _ in throw POSIXError(.EIO) }
                )
            )
            XCTAssertFalse(try FileDurability.entryExists(at: url))

            try FileDurability.writeNewRegularFileDurably(Data("retry".utf8), to: url)
            XCTAssertEqual(try Data(contentsOf: url), Data("retry".utf8))
        }
    #endif

    func testZIPWriterRejectsTraversalNames() throws {
        let root = try temporaryDirectory()
        let source = root.appendingPathComponent("source")
        try Data().write(to: source)
        let destination = root.appendingPathComponent("unsafe.zip")
        XCTAssertThrowsError(
            try StoredZIPWriter.write(fileURLs: ["../private": source], to: destination))
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testStreamingZIP64WriterHandlesLargeFileWithBoundedChunks() throws {
        let root = try temporaryDirectory()
        let source = root.appendingPathComponent("large.jsonl")
        FileManager.default.createFile(atPath: source.path, contents: nil)
        let handle = try FileHandle(forWritingTo: source)
        let chunk = Data(repeating: 0x61, count: 1_048_576)
        for _ in 0..<32 { try handle.write(contentsOf: chunk) }
        try handle.close()

        let destination = root.appendingPathComponent("streaming.zip")
        try StoredZIPWriter.write(fileURLs: ["health.jsonl": source], to: destination)
        try assertValidZIP(destination)
        let size = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize
        XCTAssertGreaterThan(size ?? 0, chunk.count)
    }

    func testStreamingZIPPreparationNeverTruncatesPlantedTemporaryEntries() throws {
        let root = try temporaryDirectory()
        let source = root.appendingPathComponent("source.txt")
        try Data("source".utf8).write(to: source)
        let destination = root.appendingPathComponent("bundle.zip")
        let plantedFile = root.appendingPathComponent("planted.tmp")
        let plantedBytes = Data("caller-owned".utf8)
        try plantedBytes.write(to: plantedFile)

        XCTAssertThrowsError(
            try StoredZIPWriter.prepare(
                fileURLs: ["source.txt": source],
                to: destination,
                temporaryURL: plantedFile
            )
        )
        XCTAssertEqual(try Data(contentsOf: plantedFile), plantedBytes)

        let target = root.appendingPathComponent("target.txt")
        try Data("target".utf8).write(to: target)
        let plantedSymlink = root.appendingPathComponent("planted-link.tmp")
        try FileManager.default.createSymbolicLink(
            at: plantedSymlink,
            withDestinationURL: target
        )
        XCTAssertThrowsError(
            try StoredZIPWriter.prepare(
                fileURLs: ["source.txt": source],
                to: destination,
                temporaryURL: plantedSymlink
            )
        )
        XCTAssertEqual(try Data(contentsOf: target), Data("target".utf8))
    }

    func testZIPWriterReportsDirectorySyncFailureAndRejectsExistingDestination() throws {
        let root = try temporaryDirectory()
        let destinationDirectory = root.appendingPathComponent("write-only")
        try FileManager.default.createDirectory(
            at: destinationDirectory,
            withIntermediateDirectories: false
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: destinationDirectory.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: destinationDirectory.path
            )
        }

        let source = root.appendingPathComponent("source.txt")
        try Data("value".utf8).write(to: source)
        let streamingDestination = destinationDirectory.appendingPathComponent("streaming.zip")
        XCTAssertThrowsError(
            try StoredZIPWriter.write(fileURLs: ["entry.txt": source], to: streamingDestination)
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: streamingDestination.path))

        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: destinationDirectory.path
        )
        try StoredZIPWriter.write(
            fileURLs: ["entry.txt": source],
            to: streamingDestination
        )
        let publishedDigest = try SHA256Digest.taggedFile(at: streamingDestination)
        XCTAssertThrowsError(
            try StoredZIPWriter.write(
                fileURLs: ["entry.txt": source],
                to: streamingDestination
            )
        )
        XCTAssertEqual(
            try SHA256Digest.taggedFile(at: streamingDestination),
            publishedDigest
        )
    }

    func testTrackingIntentRoundTrip() throws {
        let url = try temporaryDirectory().appendingPathComponent("intent.json")
        let store = TrackingIntentStore(url: url)
        let intent = TrackingIntent(armed: true, coverageState: .stationaryAutoPaused, bootID: UUID())
        try store.save(intent)
        XCTAssertEqual(try store.load(), intent)
        let encoded = try JSONEncoder.lifestream().encode(intent)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), ["armed", "coverage_state", "boot_id"])
    }

    func testTrackingIntentRejectsSemanticCorruptionWithoutMutation() throws {
        let root = try temporaryDirectory()
        let url = root.appendingPathComponent("intent.json")
        let store = TrackingIntentStore(url: url)
        let corrupt = Data(
            #"{"armed":true,"coverage_state":"not-a-coverage-state","boot_id":"00000000-0000-0000-0000-000000000001"}"#
                .utf8
        )
        try corrupt.write(to: url)

        guard case .failed(let diagnostic) = store.loadState() else {
            return XCTFail("semantically corrupt tracking intent must fail closed")
        }
        XCTAssertTrue(diagnostic.contains("coverage_state"))
        XCTAssertEqual(try Data(contentsOf: url), corrupt)
    }

    func testTrackingIntentNeverReadsOrPublishesThroughASymlink() throws {
        let root = try temporaryDirectory()
        let targetURL = root.appendingPathComponent("target.json")
        let targetStore = TrackingIntentStore(url: targetURL)
        let intent = TrackingIntent(
            armed: true,
            coverageState: .unknown,
            bootID: UUID()
        )
        try targetStore.save(intent)
        let originalBytes = try Data(contentsOf: targetURL)
        let linkedURL = root.appendingPathComponent("tracking-intent.json")
        try FileManager.default.createSymbolicLink(
            at: linkedURL,
            withDestinationURL: targetURL
        )
        let linkedStore = TrackingIntentStore(url: linkedURL)

        guard case .failed = linkedStore.loadState() else {
            return XCTFail("a symlinked tracking intent must fail closed")
        }
        XCTAssertThrowsError(try linkedStore.save(intent))
        XCTAssertEqual(try Data(contentsOf: targetURL), originalBytes)
        XCTAssertEqual(
            try FileManager.default.destinationOfSymbolicLink(atPath: linkedURL.path),
            targetURL.path
        )
    }

    func testAbsentFileRemovalRetryStillSynchronizesParentDirectory() throws {
        let root = try temporaryDirectory()
        let file = root.appendingPathComponent("published.json")
        try Data("published".utf8).write(to: file)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: root.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: root.path
            )
        }

        XCTAssertThrowsError(
            try FileDurability.removeRegularFileIfPresentDurably(at: file)
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: root.path
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: root.path
        )
        XCTAssertThrowsError(
            try FileDurability.removeRegularFileIfPresentDurably(at: file)
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: root.path
        )
        XCTAssertNoThrow(
            try FileDurability.removeRegularFileIfPresentDurably(at: file)
        )
    }

    func testAbsentStagingRetryStillSynchronizesParentDirectory() throws {
        let root = try temporaryDirectory()
        let staging = root.appendingPathComponent("staging", isDirectory: true)
        try FileManager.default.createDirectory(
            at: staging,
            withIntermediateDirectories: false
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: root.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: root.path
            )
        }

        XCTAssertThrowsError(
            try FileDurability.removePrivateDirectoryIfPresent(at: staging)
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: root.path
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: root.path
        )
        XCTAssertThrowsError(
            try FileDurability.removePrivateDirectoryIfPresent(at: staging)
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: root.path
        )
        XCTAssertNoThrow(
            try FileDurability.removePrivateDirectoryIfPresent(at: staging)
        )
    }

    func testParentDirectorySynchronizationFailsWhenPublicationDirectoryIsMissing() throws {
        let root = try temporaryDirectory()
        let published = root.appendingPathComponent("published.json")
        try Data("durable".utf8).write(to: published)

        XCTAssertNoThrow(try FileDurability.synchronizeParentDirectory(of: published))
        XCTAssertThrowsError(
            try FileDurability.synchronizeParentDirectory(
                of: root.appendingPathComponent("missing", isDirectory: true)
                    .appendingPathComponent("unpublished.json")
            )
        )
    }

    func testDurableDirectoryCreationStopsAtFailedParentSyncAndCanRetry() throws {
        let root = try temporaryDirectory()
        let restricted = root.appendingPathComponent("write-only")
        try FileManager.default.createDirectory(at: restricted, withIntermediateDirectories: false)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: restricted.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: restricted.path
            )
        }
        let first = restricted.appendingPathComponent("first")
        let target = first.appendingPathComponent("second")

        XCTAssertThrowsError(try FileDurability.createDirectoryDurably(at: target))
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))

        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: restricted.path
        )
        XCTAssertNoThrow(try FileDurability.createDirectoryDurably(at: target))
        var isDirectory = ObjCBool(false)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
    }

    func testDurableDirectoryCreationRejectsSymlinkedComponents() throws {
        let root = try temporaryDirectory()
        let target = root.appendingPathComponent("caller-owned", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        let marker = target.appendingPathComponent("keep.txt")
        try Data("keep".utf8).write(to: marker)
        let link = root.appendingPathComponent("capture", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

        XCTAssertThrowsError(try FileDurability.createDirectoryDurably(at: link))
        XCTAssertThrowsError(
            try FileDurability.createDirectoryDurably(
                at: link.appendingPathComponent("logs", isDirectory: true)
            )
        )
        XCTAssertEqual(try Data(contentsOf: marker), Data("keep".utf8))
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lifestream-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func assertValidZIP(_ url: URL) throws {
        #if os(macOS)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
            process.arguments = ["-tqq", url.path]
            try process.run()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0)
        #endif
    }

}

