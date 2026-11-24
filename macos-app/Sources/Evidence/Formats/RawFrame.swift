import Foundation

public struct RawFrame: Equatable, Sendable {
    public static let maximumBytes = 256 * 1024 * 1024
    public static let maximumICCBytes = 4 * 1024 * 1024

    public let layout: FrameLayout
    public let data: Data

    public init(layout: FrameLayout, data: Data) {
        self.layout = layout
        self.data = data
    }
}

public struct FrameLayout: Codable, Equatable, Sendable {
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int
    public let bitsPerComponent: Int
    public let bitsPerPixel: Int
    public let bitmapInfo: UInt32
    public let renderingIntent: Int32
    public let ICCData: Data

    public init(
        width: Int,
        height: Int,
        bytesPerRow: Int,
        bitsPerComponent: Int = 8,
        bitsPerPixel: Int = 32,
        bitmapInfo: UInt32,
        renderingIntent: Int32,
        ICCData: Data
    ) {
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.bitsPerComponent = bitsPerComponent
        self.bitsPerPixel = bitsPerPixel
        self.bitmapInfo = bitmapInfo
        self.renderingIntent = renderingIntent
        self.ICCData = ICCData
    }
}
