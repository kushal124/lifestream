import XCTest
@testable import Evidence

final class CaptureGapReasonTests: XCTestCase {
    func testTheNewReasonsAreSpelledAsTheHomeReadsThem() {
        XCTAssertEqual(CaptureGapReason.storageFailed.rawValue, "storage-failed")
        XCTAssertEqual(CaptureGapReason.recorderNotRunning.rawValue, "recorder-not-running")
        XCTAssertEqual(CaptureGapReason(rawValue: "storage_backpressure"), .storageBackpressure)
    }

    func testWaitsAndFailures() {
        XCTAssertTrue(CaptureGapReason.storageBackpressure.isExpectedWait, "a wait for room")
        XCTAssertTrue(CaptureGapReason.captureGenerationInvalidated.isExpectedWait, "closed by an event, not broken")
        XCTAssertTrue(CaptureGapReason.recorderNotRunning.isExpectedWait)
        XCTAssertFalse(CaptureGapReason.storageFailed.isExpectedWait)
        XCTAssertFalse(CaptureGapReason.captureFailed.isExpectedWait)
    }

    func testEverySpellingIsOne() {
        XCTAssertEqual(Set(CaptureGapReason.allCases.map(\.rawValue)).count, CaptureGapReason.allCases.count)
    }
}
