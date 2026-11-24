import Evidence
import Foundation
import CoreGraphics
import ImageIO

enum SegmentCodec {
    static let maximumSegmentBytes = 128 * 1024 * 1024
    static let bitmap = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue

    static func check(_ status: OSStatus) throws {
        if status != 0 {
            throw VideoArchiveError.codec(status)
        }
    }

    static func mediaFailure(_ operation: VideoArchiveOperation, error: Error?) -> VideoArchiveError {
        guard let error else {
            return .media(operation: operation, domain: "AVFoundation", code: nil)
        }
        let platform = error as NSError
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_"))
        let scalars = platform.domain.unicodeScalars.prefix(80).filter { allowed.contains($0) }
        let domain = String(String.UnicodeScalarView(scalars))
        return .media(operation: operation, domain: domain.isEmpty ? "platform" : domain, code: platform.code)
    }

    static func image(_ saved: CaptureImage) throws -> CGImage {
        switch saved {
        case .png(let data):
            guard data.count <= RawFrame.maximumBytes,
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  (1...4096).contains(width),
                  (1...4096).contains(height),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                throw VideoArchiveError.invalidInput
            }
            return image
        case .raw(let frame):
            let layout = frame.layout
            guard (1...4096).contains(layout.width),
                  (1...4096).contains(layout.height),
                  layout.bitsPerComponent == 8,
                  layout.bitsPerPixel == 32,
                  layout.bytesPerRow >= layout.width * 4,
                  layout.bytesPerRow <= 65536,
                  frame.data.count >= layout.bytesPerRow * layout.height,
                  frame.data.count <= RawFrame.maximumBytes,
                  layout.ICCData.count <= RawFrame.maximumICCBytes,
                  let space = CGColorSpace(iccData: layout.ICCData as CFData),
                  space.model == .rgb,
                  let provider = CGDataProvider(data: frame.data as CFData),
                  let image = CGImage(
                      width: layout.width,
                      height: layout.height,
                      bitsPerComponent: 8,
                      bitsPerPixel: 32,
                      bytesPerRow: layout.bytesPerRow,
                      space: space,
                      bitmapInfo: CGBitmapInfo(rawValue: layout.bitmapInfo),
                      provider: provider,
                      decode: nil,
                      shouldInterpolate: false,
                      intent: CGColorRenderingIntent(rawValue: layout.renderingIntent) ?? .defaultIntent
                  ) else {
                throw VideoArchiveError.invalidInput
            }
            return image
        }
    }
}
