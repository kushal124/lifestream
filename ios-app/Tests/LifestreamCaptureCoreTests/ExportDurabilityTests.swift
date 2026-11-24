import Foundation
import XCTest

@testable import LifestreamCaptureCore

final class ExportDurabilityTests: XCTestCase {
    func testPublishFailsWhileExactPreparedTemporaryCannotBeRemoved() throws {
        let root = try temporaryDirectory()
        let exports = root.appendingPathComponent("exports", isDirectory: true)
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: false)
        let source = root.appendingPathComponent("source.jsonl")
        try Data("observation\n".utf8).write(to: source)
        let destination = exports.appendingPathComponent("bundle.zip")
        let temporary = exports.appendingPathComponent(".bundle.zip.test.tmp")
        let prepared = try StoredZIPWriter.prepare(
            fileURLs: ["source.jsonl": source],
            to: destination,
            temporaryURL: temporary
        )
        try FileManager.default.copyItem(at: temporary, to: destination)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o500],
            ofItemAtPath: exports.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: exports.path
            )
        }

        XCTAssertThrowsError(try StoredZIPWriter.publish(prepared))
        XCTAssertTrue(FileManager.default.fileExists(atPath: temporary.path))
        XCTAssertEqual(
            try SHA256Digest.taggedFile(at: destination),
            prepared.archiveSHA256
        )
    }

    func testStreamingConvenienceWriteRejectsExactExistingDestination() throws {
        let root = try temporaryDirectory()
        let exports = root.appendingPathComponent("exports", isDirectory: true)
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: false)
        let source = root.appendingPathComponent("source.jsonl")
        try Data("observation\n".utf8).write(to: source)
        let destination = exports.appendingPathComponent("bundle.zip")
        try StoredZIPWriter.write(
            fileURLs: ["source.jsonl": source],
            to: destination
        )
        let originalBytes = try Data(contentsOf: destination)
        let originalAttributes = try FileManager.default.attributesOfItem(
            atPath: destination.path
        )
        let originalInode = try XCTUnwrap(
            originalAttributes[.systemFileNumber] as? NSNumber
        )

        XCTAssertThrowsError(
            try StoredZIPWriter.write(
                fileURLs: ["source.jsonl": source],
                to: destination
            )
        )

        let retryAttributes = try FileManager.default.attributesOfItem(
            atPath: destination.path
        )
        XCTAssertEqual(
            retryAttributes[.systemFileNumber] as? NSNumber,
            originalInode
        )
        XCTAssertEqual(try Data(contentsOf: destination), originalBytes)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: exports.path),
            [destination.lastPathComponent]
        )
    }

    func testArchivePreparationRequiresDurableTemporaryDirectoryEntry() throws {
        let root = try temporaryDirectory()
        let exports = root.appendingPathComponent("exports", isDirectory: true)
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: false)
        let source = root.appendingPathComponent("source.jsonl")
        try Data("observation\n".utf8).write(to: source)
        let destination = exports.appendingPathComponent("bundle.zip")
        let temporary = exports.appendingPathComponent(".bundle.zip.test.tmp")
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: exports.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: exports.path
            )
        }

        XCTAssertThrowsError(
            try StoredZIPWriter.prepare(
                fileURLs: ["source.jsonl": source],
                to: destination,
                temporaryURL: temporary
            )
        )

        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: exports.path
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
    }

    func testArchivePreparationRejectsSameSizeSourceMutationBetweenChecksumAndStream() throws {
        let root = try temporaryDirectory()
        let exports = root.appendingPathComponent("exports", isDirectory: true)
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: false)
        let source = root.appendingPathComponent("source.jsonl")
        let original = Data(repeating: 0x41, count: 4_096)
        let replacement = Data(repeating: 0x42, count: original.count)
        try original.write(to: source)
        let destination = exports.appendingPathComponent("bundle.zip")
        let temporary = exports.appendingPathComponent(".bundle.zip.test.tmp")

        XCTAssertThrowsError(
            try StoredZIPWriter.prepare(
                fileURLs: [source.lastPathComponent: source],
                to: destination,
                temporaryURL: temporary,
                afterSourceChecksum: { name in
                    XCTAssertEqual(name, source.lastPathComponent)
                    let writer = try FileDurability.openRegularFileForWriting(at: source)
                    do {
                        try writer.seek(toOffset: 0)
                        try writer.write(contentsOf: replacement)
                        try writer.synchronize()
                        try writer.close()
                    } catch {
                        try? writer.close()
                        throw error
                    }
                }
            )
        ) { error in
            XCTAssertTrue(
                error.localizedDescription.contains("archive source changed"),
                "\(error)"
            )
        }

        XCTAssertEqual(try Data(contentsOf: source), replacement)
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testStagedSnapshotLeafIsCreatedExclusivelyWithoutFollowingSymlinks() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(
            root: root.appendingPathComponent("capture", isDirectory: true)
        )
        let target = root.appendingPathComponent("caller-owned.jsonl")
        let bytes = Data("caller-owned\n".utf8)
        try bytes.write(to: target)
        let staged = root.appendingPathComponent("health.jsonl")
        try FileManager.default.createSymbolicLink(at: staged, withDestinationURL: target)

        let slices = try await store.stageExportSlices([(.health, 0)], in: root)
        XCTAssertThrowsError(try XCTUnwrap(slices[.health]).get())
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(
            try FileManager.default.destinationOfSymbolicLink(atPath: staged.path),
            target.path
        )
    }

    func testLaunchReclaimsExportStagingWithoutFollowingASymlink() async throws {
        let root = try temporaryDirectory()
        let capture = root.appendingPathComponent("capture", isDirectory: true)
        _ = try CaptureStore(root: capture)
        let target = root.appendingPathComponent("caller-owned", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        let marker = target.appendingPathComponent("keep.txt")
        try Data("keep".utf8).write(to: marker)
        let link = capture.appendingPathComponent("export-staging", isDirectory: true)
            .appendingPathComponent("staging-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

        _ = try CaptureStore(root: capture)
        XCTAssertEqual(try Data(contentsOf: marker), Data("keep".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: link.path))
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lifestream-export-durability-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}
