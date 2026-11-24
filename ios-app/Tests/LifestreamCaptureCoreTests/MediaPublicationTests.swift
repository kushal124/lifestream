import Foundation
import Darwin
import XCTest
@testable import LifestreamCaptureCore

final class MediaPublicationTests: XCTestCase {
    func testFilePublicationPreservesBytesAndDeduplicates() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(root: root)
        for data in [Data(), Data("synthetic-🟢".utf8), Data(repeating: 0xA5, count: 2_097_153)] {
            let url = root.appendingPathComponent(UUID().uuidString)
            try FileDurability.writeNewRegularFileDurably(data, to: url)
            let file = OwnedMediaFile(takingOwnershipOf: url)
            let first = try await store.storeBlob(file: file)
            let duplicateURL = root.appendingPathComponent(UUID().uuidString)
            try FileDurability.writeNewRegularFileDurably(data, to: duplicateURL)
            let duplicate = try await store.storeBlob(file: OwnedMediaFile(takingOwnershipOf: duplicateURL))
            XCTAssertEqual(first.hash, SHA256Digest.tagged(data))
            XCTAssertEqual(first.bytes, UInt64(data.count))
            XCTAssertEqual(first.hash, duplicate.hash)
            let stored = try await store.blobFile(forTaggedHash: first.hash)
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(stored)), data)
        }
        let inventory = try await store.validatedBlobInventory().map(\.url)
        XCTAssertEqual(inventory.count, 3)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("blobs").path)
            .contains { $0.hasPrefix(".media-") })
    }

    func testFilePublicationRejectsCorruptExistingBlobAndCleansStage() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(root: root)
        let data = Data("synthetic-original".utf8)
        let hash = try await store.storeBlob(data)
        let destination = root.appendingPathComponent("blobs/" + String(hash.dropFirst(7)))
        try Data("corrupt".utf8).write(to: destination)
        let source = root.appendingPathComponent("source")
        try FileDurability.writeNewRegularFileDurably(data, to: source)
        do {
            _ = try await store.storeBlob(file: OwnedMediaFile(takingOwnershipOf: source))
            XCTFail("Corrupt content-addressed destination must fail")
        } catch { }
        XCTAssertEqual(try Data(contentsOf: destination), Data("corrupt".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("blobs").path).count, 1)
    }

    func testCopyRejectsSymlinkDirectoryAndExistingDestination() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source")
        let destination = root.appendingPathComponent("destination")
        let link = root.appendingPathComponent("link")
        try Data([1, 2, 3]).write(to: source)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
        XCTAssertThrowsError(try FileDurability.copyRegularFileDurably(from: link, to: destination))
        XCTAssertThrowsError(try FileDurability.copyRegularFileDurably(from: root, to: destination))
        let fifo = root.appendingPathComponent("fifo")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        XCTAssertThrowsError(try FileDurability.copyRegularFileDurably(from: fifo, to: destination))
        try FileDurability.copyRegularFileDurably(from: source, to: destination)
        XCTAssertThrowsError(try FileDurability.copyRegularFileDurably(from: source, to: destination))
        XCTAssertEqual(try Data(contentsOf: destination), Data([1, 2, 3]))
    }

    func testLastOwnerCleansAbandonedFile() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data([1]).write(to: url)
        var file: OwnedMediaFile? = OwnedMediaFile(takingOwnershipOf: url)
        XCTAssertEqual(file?.url, url)
        file = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
