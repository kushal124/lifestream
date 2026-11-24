import Foundation
import XCTest
@testable import LifestreamCaptureCore

final class HealthAskTests: XCTestCase {
    private func fresh() throws -> (URL, CaptureStore) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        return (root, try CaptureStore(root: root))
    }

    func testANewInstallWaitsForItsFirstAsk() async throws {
        let (root, store) = try fresh()
        defer { try? FileManager.default.removeItem(at: root) }
        try await store.setAnchor("motion-anchor", Data([1]))
        let ask = try await store.healthAsk(complete: false)
        XCTAssertEqual(ask, .first)
        XCTAssertFalse(ask.reads)
        let mark = try await store.anchor(HealthAsk.answeredKey)
        XCTAssertNil(mark, "nothing answered, nothing marked")
    }

    func testAnsweredOnceReadsOnWhenALaterBuildAddsTypes() async throws {
        let (root, store) = try fresh()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try await store.healthAsk(complete: true)
        XCTAssertEqual(first, .answered)
        let later = try await store.healthAsk(complete: false)
        XCTAssertEqual(later, .newTypes)
        XCTAssertTrue(later.reads)
        let again = try await store.healthAsk(complete: true)
        XCTAssertEqual(again, .answered)
    }

    func testAnInstallFromAnEarlierBuildIsAnswered() async throws {
        for key in [HealthAsk.anchorPrefix + "HKQuantityTypeIdentifierStepCount", HealthAsk.yieldedPrefix + "HKCategoryTypeIdentifierSleepAnalysis"] {
            let (root, store) = try fresh()
            defer { try? FileManager.default.removeItem(at: root) }
            try await store.setAnchor(key, Data([1]))
            let ask = try await store.healthAsk(complete: false)
            XCTAssertEqual(ask, .newTypes, key)
            let mark = try await store.anchor(HealthAsk.answeredKey)
            XCTAssertNotNil(mark, "the mark is written from \(key)")
        }
    }

    func testTheMarkHoldsAcrossALaunch() async throws {
        let (root, store) = try fresh()
        defer { try? FileManager.default.removeItem(at: root) }
        let answered = try await store.healthAsk(complete: true)
        XCTAssertEqual(answered, .answered)
        let relaunched = try CaptureStore(root: root)
        let later = try await relaunched.healthAsk(complete: false)
        XCTAssertEqual(later, .newTypes)
    }
}
