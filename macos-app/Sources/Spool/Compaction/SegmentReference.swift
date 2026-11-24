import Evidence
import Foundation

struct SegmentReference: Codable, Sendable {
    static let maximumFrameCount = 30

    let version: Int
    let segment: String
    let segmentSHA256: Data
    let ordinal: Int
    let frameCount: Int
    let capturedAt: Date
    let encoding: CaptureVideoProvenance

    func validate() throws {
        try encoding.validate()
        guard version == 1,
              segmentSHA256.count == 32,
              (1...Self.maximumFrameCount).contains(frameCount),
              (0..<frameCount).contains(ordinal),
              capturedAt.timeIntervalSince1970.isFinite,
              SpoolLayout.isSegmentPath(segment) else {
            throw VideoArchiveError.invalidReference
        }
    }
}
