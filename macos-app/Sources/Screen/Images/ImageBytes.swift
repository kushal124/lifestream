import CoreGraphics
import Evidence
import Foundation

enum ImageBytes {
    static func materialize(_ image: CGImage) -> RawFrame? {
        let width = image.width
        let height = image.height
        let stride = image.bytesPerRow
        let (packedRow, widthOverflow) = width.multipliedReportingOverflow(by: 4)
        let (minimumBytes, heightOverflow) = stride.multipliedReportingOverflow(by: height)
        guard width > 0, height > 0, stride > 0, !widthOverflow, !heightOverflow,
              stride >= packedRow, minimumBytes > 0, minimumBytes <= RawFrame.maximumBytes,
              image.bitsPerComponent == 8, image.bitsPerPixel == 32,
              !image.bitmapInfo.contains(.floatComponents), image.decode == nil,
              image.colorSpace?.model == .rgb,
              let profile = image.colorSpace?.copyICCData(),
              CFDataGetLength(profile) > 0, CFDataGetLength(profile) <= RawFrame.maximumICCBytes,
              let bytes = image.dataProvider?.data,
              CFDataGetLength(bytes) >= minimumBytes,
              CFDataGetLength(bytes) <= RawFrame.maximumBytes else { return nil }
        let layout = FrameLayout(width: width, height: height, bytesPerRow: stride,
            bitsPerComponent: image.bitsPerComponent, bitsPerPixel: image.bitsPerPixel,
            bitmapInfo: image.bitmapInfo.rawValue, renderingIntent: Int32(image.renderingIntent.rawValue),
            ICCData: profile as Data)
        return RawFrame(layout: layout, data: bytes as Data)
    }
}
