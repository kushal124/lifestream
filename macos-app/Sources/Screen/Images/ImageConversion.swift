import CoreGraphics
import Evidence
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ImageConversion {
    static func image(_ frame: RawFrame) -> CGImage? {
        let layout = frame.layout
        guard let space = CGColorSpace(iccData: layout.ICCData as CFData),
              let provider = CGDataProvider(data: frame.data as CFData),
              layout.renderingIntent >= 0,
              let intent = CGColorRenderingIntent(rawValue: layout.renderingIntent) else { return nil }
        return CGImage(width: layout.width, height: layout.height,
            bitsPerComponent: layout.bitsPerComponent, bitsPerPixel: layout.bitsPerPixel,
            bytesPerRow: layout.bytesPerRow, space: space, bitmapInfo: CGBitmapInfo(rawValue: layout.bitmapInfo),
            provider: provider, decode: nil, shouldInterpolate: false, intent: intent)
    }

    static func decode(_ saved: CaptureImage) async -> CGImage? {
        await BlockingWork.run {
            switch saved {
            case .raw(let frame):
                return image(frame)
            case .png(let data):
                guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
                return CGImageSourceCreateImageAtIndex(source, 0,
                    [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
            }
        }
    }

    static func capture(_ image: CGImage, bytes: RawFrame?) async throws -> CaptureImage {
        guard let bytes else { return .png(try await encodePNG(image)) }
        return .raw(bytes)
    }

    static func encodePNG(_ image: CGImage) async throws -> Data {
        try await BlockingWork.throwing {
            let data = NSMutableData()
            let type = UTType.png.identifier as CFString
            guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else {
                throw ImageFailure.encoding
            }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { throw ImageFailure.encoding }
            return data as Data
        }
    }

    private enum ImageFailure: Error {
        case encoding
    }
}
