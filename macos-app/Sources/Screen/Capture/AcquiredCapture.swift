import CoreGraphics
import Evidence
import Foundation

@MainActor
final class AcquiredCapture {
    let width: Int
    let height: Int
    let provenance: CaptureAcquisition
    let endedAt: Date
    private var image: CGImage?

    init(image: CGImage, provenance: CaptureAcquisition, endedAt: Date) {
        self.image = image
        width = image.width
        height = image.height
        self.provenance = provenance
        self.endedAt = endedAt
    }

    func takeImage() throws -> CGImage {
        guard let image else { throw CapturePipeline.Failure.rejected(.screenAcquisitionFailed) }
        self.image = nil
        return image
    }
}

struct EnrichedCapture {
    var observation: CaptureObservation
    let image: CaptureImage
    let text: Task<RecognizedText, Never>

    func recognized() async -> CaptureObservation {
        with(await text.value)
    }

    func with(_ text: RecognizedText) -> CaptureObservation {
        var observation = self.observation
        observation.ocr = text.image.observations
        observation.ocrStatus = text.image.status.rawValue
        observation.timings?.ocrMs = text.ms
        observation.timings?.ocrTiles = text.image.requests
        return observation
    }
}

struct RecognizedText {
    let image: RecognizedImage
    let ms: Int
}
