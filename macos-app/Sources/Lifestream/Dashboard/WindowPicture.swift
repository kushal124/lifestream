import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum WindowPicture {
    static let quality = 0.85
    static let longestSide = 2_880
    static let mostBytes = 4 * 1024 * 1024

    static func jpeg(_ image: CGImage, most: Int = mostBytes) -> Data? {
        var side = min(longestSide, max(image.width, image.height))
        while side > 0 {
            guard let drawn = scaled(image, longest: side), let data = encoded(drawn) else { return nil }
            if data.count <= most { return data }
            side = side * 3 / 4
        }
        return nil
    }

    private static func scaled(_ image: CGImage, longest: Int) -> CGImage? {
        let long = max(image.width, image.height)
        guard long > longest else { return image }
        let width = max(1, image.width * longest / long)
        let height = max(1, image.height * longest / long)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    private static func encoded(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}
