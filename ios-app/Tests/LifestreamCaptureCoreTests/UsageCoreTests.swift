import Foundation
import XCTest
@testable import LifestreamCaptureCore

final class UsageCoreTests: XCTestCase {
    private func temporary() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }

    func testUsageIsExportable() async throws {
        let root = temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        let draft = CaptureDraft(kind: "activity_segment", observedAt: CaptureTime.rfc3339(Date()),
            payload: .object(["total_activity_duration": .number(1.25), "first_pickup": .null]))
        let entry = try await store.append(domain: .usage, draft: draft)
        let reopened = try CaptureStore(root: root.appendingPathComponent("capture"))
        let entries = try await reopened.entries(domain: .usage)
        XCTAssertEqual(entries, [entry])
        let sealed = try await CaptureExporter(store: reopened, exportsDirectory: root.appendingPathComponent("exports"))
        .sealEverything(appVersion: "1.0.0")
        let bundle = try XCTUnwrap(sealed)
        XCTAssertEqual(bundle.manifest.files["usage.jsonl"]?.observations, 1)
        XCTAssertNotNil(bundle.manifest.files["usage.jsonl"]?.sha256)
    }

    func testInboxDoesNotReadAboveItsExistingContainer() throws {
        let root = temporary()
        let container = root.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
            try? FileManager.default.removeItem(at: root)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o100], ofItemAtPath: root.path)
        let inbox = UsageInbox(directory: container.appendingPathComponent("inbox"))
        XCTAssertEqual(try inbox.pending(), [])
        let id = try inbox.publish(.string("synthetic"))
        let item = try XCTUnwrap(inbox.pending().first)
        XCTAssertEqual(item.deliveryID, id)
        try inbox.acknowledge(item)
        XCTAssertEqual(try inbox.pending(), [])
    }

    func testInboxAlreadyMadeIsMarkedOutOfBackupsBeforePublishing() throws {
        let root = temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("inbox", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        XCTAssertNotEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        try UsageInbox(directory: directory).publish(.string("synthetic"))
        XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testInboxRetriesUntilAcknowledgedAndRejectsUUIDMutation() throws {
        let root = temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let inbox = UsageInbox(directory: root)
        let id = UUID()
        try inbox.publish(.object(["event": .string("opened")]), deliveryID: id)
        XCTAssertEqual(try inbox.pending().map(\.deliveryID), [id])
        try inbox.publish(.object(["event": .string("opened")]), deliveryID: id)
        XCTAssertEqual(try inbox.pending().count, 1)
        XCTAssertThrowsError(try inbox.publish(.null, deliveryID: id))
        let item = try XCTUnwrap(inbox.pending().first)
        XCTAssertEqual(try UsageInbox(directory: root).pending(), [item])
        try inbox.acknowledge(item)
        try inbox.acknowledge(item)
        XCTAssertEqual(try inbox.pending(), [])
    }

    func testInboxConcurrentPublishAndBoundedDrain() async throws {
        let root = temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let inbox = UsageInbox(directory: root)
        let ids = try await withThrowingTaskGroup(of: UUID.self) { group in
            for _ in 0..<40 { group.addTask { try inbox.publish(.null) } }
            var ids = Set<UUID>()
            for try await id in group { ids.insert(id) }
            return ids
        }
        XCTAssertEqual(ids.count, 40)
        XCTAssertEqual(try inbox.pending(limit: 7).count, 7)
        XCTAssertEqual(Set(try inbox.pending().map(\.deliveryID)), ids)
    }

    func testInboxRejectsOverflowOversizedAndHostileFilesWithoutDeletingThem() throws {
        let root = temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let inbox = UsageInbox(directory: root, maximumItems: 1, maximumItemBytes: 128, maximumTotalBytes: 128)
        XCTAssertThrowsError(try inbox.publish(.string(String(repeating: "a", count: 256))))
        try inbox.publish(.null)
        XCTAssertThrowsError(try inbox.publish(.null))
        let item = try XCTUnwrap(inbox.pending(limit: 1).first)
        try inbox.acknowledge(item)
        let hostile = root.appendingPathComponent("\(UUID().uuidString.lowercased()).json")
        try FileManager.default.createSymbolicLink(at: hostile, withDestinationURL: root.appendingPathComponent("absent"))
        XCTAssertThrowsError(try inbox.pending(limit: 1))
        XCTAssertNotNil(try FileManager.default.destinationOfSymbolicLink(atPath: hostile.path))
        try FileManager.default.removeItem(at: hostile)
        try Data("malformed".utf8).write(to: hostile)
        XCTAssertThrowsError(try inbox.pending(limit: 1))
        XCTAssertEqual(try Data(contentsOf: hostile), Data("malformed".utf8))
    }

    func testPublishRetryRecoversSameUUIDAtCapacity() throws {
        let root = temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let inbox = UsageInbox(directory: root, maximumItems: 1)
        let id = try inbox.publish(.string("synthetic"))
        let target = root.appendingPathComponent("\(id.uuidString.lowercased()).json")
        let staging = root.appendingPathComponent(".pending-\(id.uuidString.lowercased())")
        try FileManager.default.moveItem(at: target, to: staging)
        XCTAssertEqual(try inbox.publish(.string("synthetic"), deliveryID: id), id)
        XCTAssertEqual(try inbox.pending(limit: 1).map(\.deliveryID), [id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
        try FileManager.default.moveItem(at: target, to: staging)
        XCTAssertThrowsError(try inbox.publish(.string("changed"), deliveryID: id))
        XCTAssertEqual(try inbox.pending(limit: 1).first?.payload, .string("synthetic"))
    }

    func testInboxRecoversDurableStagingAndLinkedPublication() throws {
        let root = temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let inbox = UsageInbox(directory: root, maximumItems: 1)
        let id = try inbox.publish(.string("synthetic"))
        let target = root.appendingPathComponent("\(id.uuidString.lowercased()).json")
        let staging = root.appendingPathComponent(".pending-\(id.uuidString.lowercased())")
        try FileManager.default.moveItem(at: target, to: staging)
        XCTAssertEqual(try inbox.pending(limit: 1).map(\.deliveryID), [id])
        try FileManager.default.copyItem(at: target, to: staging)
        XCTAssertEqual(try inbox.pending(limit: 1).map(\.deliveryID), [id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
    }
}
