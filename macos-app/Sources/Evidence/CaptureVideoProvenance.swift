import Foundation

public struct CaptureVideoProvenance: Codable, Equatable, Sendable {
    public let codec: String
    public let colorSpace: String
    public let quality: Double
    public let originalWidth: Int
    public let originalHeight: Int
    public let encodedWidth: Int
    public let encodedHeight: Int
    public let hardwareEncoder: Bool

    public init(width: Int, height: Int, quality: Double) {
        codec = "hevc-lossy-v1"
        colorSpace = "sRGB-converted"
        self.quality = quality
        originalWidth = width
        originalHeight = height
        encodedWidth = (1...4096).contains(width) ? (width + 1) / 2 * 2 : 0
        encodedHeight = (1...4096).contains(height) ? (height + 1) / 2 * 2 : 0
        hardwareEncoder = true
    }

    public func validate() throws {
        guard codec == "hevc-lossy-v1",
              colorSpace == "sRGB-converted",
              hardwareEncoder,
              quality.isFinite,
              (0...1).contains(quality),
              (1...4096).contains(originalWidth),
              (1...4096).contains(originalHeight),
              encodedWidth == (originalWidth + 1) / 2 * 2,
              encodedHeight == (originalHeight + 1) / 2 * 2 else {
            throw VideoArchiveError.invalidReference
        }
    }
}
