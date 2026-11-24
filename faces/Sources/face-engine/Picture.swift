import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Picture: @unchecked Sendable {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    static let maxPixels = 200_000_000

    static func decode(_ data: Data) -> Result<Picture, Unreadable> {
        oriented(data).flatMap(pixels)
    }

    static func oriented(_ data: Data) -> Result<CGImage, Unreadable> {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let size = orientedSize(source)
        else { return .failure(Unreadable("not an image ImageIO can read")) }
        guard size.width * size.height <= maxPixels else {
            return .failure(Unreadable("larger than \(maxPixels / 1_000_000) megapixels"))
        }
        guard let image = thumbnail(source, maxSide: max(size.width, size.height)),
              image.width == size.width, image.height == size.height
        else { return .failure(Unreadable("ImageIO cannot decode it")) }
        return .success(image)
    }

    private static func pixels(_ image: CGImage) -> Result<Picture, Unreadable> {
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
                                          bitsPerComponent: 8, bytesPerRow: image.width * 4, space: sRGB,
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
            else { return false }
            context.interpolationQuality = .none
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        guard drawn else { return .failure(Unreadable("ImageIO cannot decode it")) }
        return .success(Picture(width: image.width, height: image.height, pixels: pixels))
    }

    static func orientedSize(_ source: CGImageSource) -> (width: Int, height: Int)? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0
        else { return nil }
        let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
        return (5...8).contains(orientation) ? (height, width) : (width, height)
    }

    static func thumbnail(_ source: CGImageSource, maxSide: Int) -> CGImage? {
        CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxSide,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    }

    @inline(__always) func value(_ x: Int, _ y: Int, _ c: Int) -> Float {
        guard x >= 0, y >= 0, x < width, y < height else { return 0 }
        return Float(pixels[(y * width + x) * 4 + c])
    }

    func detectorInput(side: Int) -> DetectorInput {
        let (fitWidth, fitHeight): (Int, Int)
        if Double(height) / Double(width) > 1 {
            fitHeight = side
            fitWidth = max(1, Int(Double(side) / (Double(height) / Double(width))))
        } else {
            fitWidth = side
            fitHeight = max(1, Int(Double(side) * (Double(height) / Double(width))))
        }
        var tensor = [Float](repeating: -127.5 / 128, count: 3 * side * side)
        let stepX = Double(width) / Double(fitWidth), stepY = Double(height) / Double(fitHeight)
        let xs = (0..<fitWidth).map { Self.sample($0, scale: stepX, limit: width) }
        pixels.withUnsafeBufferPointer { source in
            tensor.withUnsafeMutableBufferPointer { out in
                for y in 0..<fitHeight {
                    let (y0, fy) = Self.sample(y, scale: stepY, limit: height)
                    let y1 = min(y0 + 1, height - 1)
                    for x in 0..<fitWidth {
                        let (x0, fx) = xs[x]
                        let x1 = min(x0 + 1, width - 1)
                        for c in 0..<3 {
                            let top = Float(source[(y0 * width + x0) * 4 + c]) * (1 - fx)
                                + Float(source[(y0 * width + x1) * 4 + c]) * fx
                            let bottom = Float(source[(y1 * width + x0) * 4 + c]) * (1 - fx)
                                + Float(source[(y1 * width + x1) * 4 + c]) * fx
                            let value = (top * (1 - fy) + bottom * fy).rounded()
                            out[c * side * side + y * side + x] = (value - 127.5) / 128
                        }
                    }
                }
            }
        }
        return DetectorInput(side: side, tensor: tensor, scaleX: Double(fitWidth) / Double(width),
                             scaleY: Double(fitHeight) / Double(height))
    }

    private static func sample(_ i: Int, scale: Double, limit: Int) -> (Int, Float) {
        let position = (Double(i) + 0.5) * scale - 0.5
        var index = Int(position.rounded(.down))
        var weight = Float(position - Double(index))
        if index < 0 { index = 0; weight = 0 }
        if index >= limit - 1 { index = limit - 1; weight = 0 }
        return (index, weight)
    }

    var image: CGImage {
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                       space: sRGB, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
    }
}

struct DetectorInput {
    let side: Int
    let tensor: [Float]
    let scaleX: Double
    let scaleY: Double
}

struct Unreadable: Error {
    let reason: String
    init(_ reason: String) { self.reason = reason }
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func jpeg(_ image: CGImage, region: CGRect, width: Int, height: Int, quality: Double,
          draw extra: ((CGContext) -> Void)? = nil) -> Data {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                            space: sRGB, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.interpolationQuality = .high
    let sx = CGFloat(width) / region.width, sy = CGFloat(height) / region.height
    context.draw(image, in: CGRect(x: -region.minX * sx, y: -(CGFloat(image.height) - region.maxY) * sy,
                                   width: CGFloat(image.width) * sx, height: CGFloat(image.height) * sy))
    extra?(context)
    let output = NSMutableData()
    let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, [
        kCGImageDestinationLossyCompressionQuality: quality,
    ] as CFDictionary)
    CGImageDestinationFinalize(destination)
    return output as Data
}
