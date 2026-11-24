import Foundation
import XCTest
@testable import LifestreamCaptureCore

final class ExportInventoryTests: XCTestCase {
    func testABundleCarriesEveryNewEntryAndNoEmptyDomain() async throws {
        for count in [0, 2] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = try CaptureStore(root: root)
            for index in 0..<count {
                _ = try await store.append(domain: .motion, draft: .init(kind: "activity", observedAt: "2026-06-01T00:0\(index):00Z",
                    payload: .object(["stationary": .bool(index == 1)])))
            }
            let sealed = try await CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports"))
                .sealEverything(appVersion: "1.0.0")
            guard count > 0 else { XCTAssertNil(sealed); continue }
            let bundle = try XCTUnwrap(sealed)
            let file = try XCTUnwrap(bundle.manifest.files["motion.jsonl"])
            XCTAssertEqual(file.observations, UInt64(count))
            XCTAssertEqual(file.firstSequence, 1)
            XCTAssertEqual(file.lastSequence, 2)
            let raw = try await store.jsonl(.motion)
            XCTAssertEqual(file.bytes, UInt64(raw.count))
            XCTAssertEqual(file.sha256, SHA256Digest.tagged(raw))
            XCTAssertTrue(FileManager.default.fileExists(atPath: bundle.url.path))
            XCTAssertNil(bundle.manifest.files["checkin.jsonl"], "a domain with nothing new is not carried, and states no seal")
        }
    }

    func testInventoryChecksumsProduceIdenticalArchiveBytes() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(root: root)
        let hash = try await store.storeBlob(Data(repeating: 0xA5, count: 2_097_153))
        let inventory = try await store.validatedBlobInventory(archiveChecksum: true)
        let blob = try XCTUnwrap(inventory.first)
        XCTAssertEqual(blob.hash, hash)
        let name = "blobs/" + blob.url.lastPathComponent
        let old = try StoredZIPWriter.prepare(fileURLs: [name: blob.url], to: root.appendingPathComponent("old.zip"))
        defer { try? StoredZIPWriter.removeTemporary(old) }
        let optimized = try StoredZIPWriter.prepare(fileURLs: [name: blob.url], to: root.appendingPathComponent("new.zip"),
            precomputedCRC32: [name: blob.crc32], expectedSHA256: [name: blob.hash])
        defer { try? StoredZIPWriter.removeTemporary(optimized) }
        XCTAssertEqual(try Data(contentsOf: old.temporaryURL), try Data(contentsOf: optimized.temporaryURL))
    }

    func testMutationAfterInventoryCannotRelabelArchivedBytes() async throws {
        for atomic in [false, true] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = try CaptureStore(root: root)
            _ = try await store.storeBlob(Data([1, 2, 3]))
            let inventory = try await store.validatedBlobInventory(archiveChecksum: true)
            let blob = try XCTUnwrap(inventory.first)
            try Data([4, 5, 6]).write(to: blob.url, options: atomic ? .atomic : [])
            XCTAssertThrowsError(try StoredZIPWriter.prepare(fileURLs: ["blob": blob.url],
                to: root.appendingPathComponent("bad.zip"), precomputedCRC32: ["blob": blob.crc32],
                expectedSHA256: ["blob": blob.hash]))
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("bad.zip").path))
        }
    }
}
