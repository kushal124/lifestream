import Evidence
import Foundation

@MainActor
protocol CaptureAdapter: AnyObject {
    func prepare(pipeline: CapturePipeline, ticket: CapturePipeline.Ticket) async throws -> CaptureBatch
    func apply(_ modes: RecordingModes)
    func apply(ocr: OCRMode)
    func activityOnly() -> CaptureObservation?
}

extension CaptureAdapter {
    func apply(_ modes: RecordingModes) {}
    func apply(ocr: OCRMode) {}
    func activityOnly() -> CaptureObservation? { nil }
}

@MainActor
struct CaptureBatch {
    let requests: [CaptureRequest]
    let validate: () -> CaptureGapReason?
}

@MainActor
struct CaptureRequest {
    let displayID: UInt32
    let prepare: () throws -> CaptureOperation
}

@MainActor
struct CaptureOperation {
    let acquire: () async throws -> AcquiredCapture
    let validate: (CapturePipeline.Phase) -> CaptureGapReason?
    let enrich: (AcquiredCapture) async throws -> EnrichedCapture
}
