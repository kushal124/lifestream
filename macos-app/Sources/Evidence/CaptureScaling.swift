import Foundation

public struct CaptureScaling: Codable, Equatable, Sendable {
    public let nativeWidth: Int
    public let nativeHeight: Int
    public let maximumDimension: Int?
    public let maximumHeight: Int
    public let requestedWidth: Int
    public let requestedHeight: Int

    public static func plan(width: Int, height: Int, maximumHeight: Int, maximumDimension: Int = 0) -> CaptureScaling? {
        guard width > 0,
              height > 0,
              width <= 100_000,
              height <= 100_000,
              maximumHeight == 0 || (256...8192).contains(maximumHeight),
              maximumDimension == 0 || (256...8192).contains(maximumDimension) else {
            return nil
        }
        let heightRatio = maximumHeight == 0 ? 1 : Double(maximumHeight) / Double(height)
        let edgeRatio = maximumDimension == 0 ? 1 : Double(maximumDimension) / Double(max(width, height))
        let ratio = min(1, heightRatio, edgeRatio)
        let outputHeight = max(1, Int((Double(height) * ratio).rounded()))
        let outputWidth = max(1, Int((Double(width) * ratio).rounded()))
        return CaptureScaling(
            nativeWidth: width,
            nativeHeight: height,
            maximumDimension: maximumDimension == 0 ? nil : maximumDimension,
            maximumHeight: maximumHeight,
            requestedWidth: outputWidth,
            requestedHeight: outputHeight
        )
    }
}
