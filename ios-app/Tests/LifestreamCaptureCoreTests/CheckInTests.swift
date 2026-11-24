import Foundation
import XCTest
@testable import LifestreamCaptureCore

final class CheckInTests: XCTestCase {
    func testCheckInDomainSealsItsExactBytes() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try await CaptureStore.restored(root: root)
        _ = try await store.append(domain: .checkin, draft: .init(kind: "access", observedAt: "2026-06-01T12:00:00Z", payload: .object(["notifications": .string("denied")])))
        let sealed = try await CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports"))
            .sealEverything(appVersion: "1.0.0")
        let file = try XCTUnwrap(sealed?.manifest.files["checkin.jsonl"])
        XCTAssertEqual(file.observations, 1)
        let raw = try await store.jsonl(.checkin)
        XCTAssertEqual(file.bytes, UInt64(raw.count)); XCTAssertEqual(file.sha256, SHA256Digest.tagged(raw))
    }
}
