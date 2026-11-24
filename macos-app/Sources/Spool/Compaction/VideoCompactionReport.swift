import Foundation

public struct VideoCompactionReport: Codable, Sendable {
    public let imageCount: Int
    public let pendingImageCount: Int
    public let pendingBytes: Int
    public let skippedImageCount: Int

    public init(imageCount: Int, pendingImageCount: Int, pendingBytes: Int, skippedImageCount: Int = 0) {
        self.imageCount = imageCount
        self.pendingImageCount = pendingImageCount
        self.pendingBytes = pendingBytes
        self.skippedImageCount = skippedImageCount
    }
}
