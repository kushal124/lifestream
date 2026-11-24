import XCTest
import Evidence
@testable import Recorder

final class CaptureAttemptOutcomeTests: XCTestCase {
    func testAWaitCountsNoTechnicalFailure() {
        for reason in [CaptureGapReason.storageBackpressure, .captureGenerationInvalidated, .recorderNotRunning] {
            XCTAssertEqual(CaptureAttemptOutcome.classify(imageCount: 0, gapReasons: [reason.rawValue]),
                           CaptureAttemptOutcome(attempt: .waiting, technicalReason: nil), reason.rawValue)
            XCTAssertEqual(CaptureAttemptOutcome.classify(imageCount: 1, gapReasons: [reason.rawValue]),
                           CaptureAttemptOutcome(attempt: .recording, technicalReason: nil), reason.rawValue)
        }
    }

    func testAFailedWriteIsATechnicalFailure() {
        XCTAssertEqual(CaptureAttemptOutcome.classify(imageCount: 0, gapReasons: ["storage-failed"]),
                       CaptureAttemptOutcome(attempt: .recovering, technicalReason: .storageFailed))
    }

    func testAStatusCountsAFullDiskAsNoFailure() {
        var status = RuntimeStatus(state: .recording)
        XCTAssertEqual(status.recordAttempt(imageCount: 0, gapReasons: ["storage_backpressure"]), .waiting)
        XCTAssertNil(status.lastTechnicalFailureReason)
        XCTAssertEqual(status.consecutiveTechnicalFailedAttempts, 0)
    }
}
