import Foundation
import XCTest
@testable import LifestreamCaptureCore

final class SelectiveHistoryTests: XCTestCase {
    private func fixture() async throws -> (URL, CaptureStore, [CaptureEntry]) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try CaptureStore(root: root)
        let entries = try await store.appendBatch(domain: .photos, drafts: (0..<8).map {
            CaptureDraft(kind: "asset", observedAt: "2026-08-27T00:00:00Z",
                         payload: .object(["value": .integer(Int64($0)), "unicode": .string("é🟢")]))
        })
        return (root, store, entries)
    }

    func testBlockedFoldDoesNotBlockAppendAndExcludesMovingTail() async throws {
        let (root, store, entries) = try await fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let started = Happened()
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let scan = Task {
            try await store.foldEntries(domain: .photos, initial: [UInt64]()) { result, entry in
                if result.isEmpty {
                    started.note()
                    guard release.wait(timeout: .now() + waitLimit) == .success else {
                        throw CaptureError.corruptState("append could not progress while fold was blocked")
                    }
                }
                result.append(entry.sequence)
            }
        }
        try await until("started.value") { started.value }
        let append = try await store.append(domain: .photos,
            draft: .init(kind: "sweep", observedAt: "2026-08-27T00:00:00Z", payload: .null))
        release.signal()
        XCTAssertEqual(append.sequence, 9)
        let result = try await scan.value
        XCTAssertEqual(result, entries.map(\.sequence))
    }

    func testCancelledReadFails() async throws {
        let (root, store, _) = try await fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let task = Task {
            return try await store.entries(domain: .photos)
        }
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled read must throw") }
        catch is CancellationError { }
    }
}
