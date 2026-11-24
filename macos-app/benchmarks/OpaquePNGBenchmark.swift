import Foundation
import ImageIO
import UniformTypeIdentifiers

struct PixelLayout {
    let stride: Int
    let red: Int
    let green: Int
    let blue: Int
    let alpha: Int?
}

func layout(_ image: CGImage) -> PixelLayout? {
    guard image.bitsPerComponent == 8, image.colorSpace?.model == .rgb,
          !image.bitmapInfo.contains(.floatComponents), image.decode == nil else { return nil }
    let order = image.bitmapInfo.intersection(.byteOrderMask)
    let little = order == .byteOrder32Little
    guard little || order == .byteOrder32Big || order == .byteOrderDefault else { return nil }
    if image.bitsPerPixel == 24, image.alphaInfo == .none, !little {
        return PixelLayout(stride: 3, red: 0, green: 1, blue: 2, alpha: nil)
    }
    guard image.bitsPerPixel == 32 else { return nil }
    switch image.alphaInfo {
    case .first, .premultipliedFirst, .noneSkipFirst:
        return PixelLayout(stride: 4, red: little ? 2 : 1, green: little ? 1 : 2,
                           blue: little ? 0 : 3, alpha: image.alphaInfo == .noneSkipFirst ? nil : (little ? 3 : 0))
    case .last, .premultipliedLast, .noneSkipLast:
        return PixelLayout(stride: 4, red: little ? 3 : 0, green: little ? 2 : 1,
                           blue: little ? 1 : 2, alpha: image.alphaInfo == .noneSkipLast ? nil : (little ? 0 : 3))
    default: return nil
    }
}

func now() -> Double { ProcessInfo.processInfo.systemUptime }
func opaqueView(_ image: CGImage) -> CGImage? {
    guard image.bitsPerPixel == 32, let format = layout(image), let alpha = format.alpha,
          let provider = image.dataProvider, let data = provider.data,
          CFDataGetLength(data) >= image.bytesPerRow * image.height,
          image.bytesPerRow >= image.width * 4,
          let bytes = CFDataGetBytePtr(data) else { return nil }
    for row in 0..<image.height {
        for column in 0..<image.width where bytes[row * image.bytesPerRow + column * 4 + alpha] != 255 {
            return nil
        }
    }
    let replacement: CGImageAlphaInfo = [.first, .premultipliedFirst].contains(image.alphaInfo) ? .noneSkipFirst : .noneSkipLast
    let info = CGBitmapInfo(rawValue: (image.bitmapInfo.rawValue & ~CGBitmapInfo.alphaInfoMask.rawValue) | replacement.rawValue)
    return CGImage(width: image.width, height: image.height, bitsPerComponent: 8, bitsPerPixel: 32,
                   bytesPerRow: image.bytesPerRow, space: image.colorSpace!, bitmapInfo: info,
                   provider: provider, decode: image.decode, shouldInterpolate: image.shouldInterpolate,
                   intent: image.renderingIntent)
}

func decode(_ data: Data) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    else { throw NSError(domain: "ImageDiagnostic", code: 1) }
    return image
}
func encode(_ image: CGImage) throws -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
    else { throw NSError(domain: "ImageDiagnostic", code: 2) }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "ImageDiagnostic", code: 3) }
    return data as Data
}

func equalPixels(_ lhs: CGImage, _ rhs: CGImage) -> Bool {
    guard lhs.width == rhs.width, lhs.height == rhs.height,
          let a = layout(lhs), let b = layout(rhs),
          let ad = lhs.dataProvider?.data, let bd = rhs.dataProvider?.data,
          CFDataGetLength(ad) >= lhs.bytesPerRow * lhs.height,
          CFDataGetLength(bd) >= rhs.bytesPerRow * rhs.height,
          let ap = CFDataGetBytePtr(ad), let bp = CFDataGetBytePtr(bd) else { return false }
    for y in 0..<lhs.height {
        for x in 0..<lhs.width {
            let ai = y * lhs.bytesPerRow + x * a.stride, bi = y * rhs.bytesPerRow + x * b.stride
            if ap[ai+a.red] != bp[bi+b.red] || ap[ai+a.green] != bp[bi+b.green] || ap[ai+a.blue] != bp[bi+b.blue] { return false }
            if (a.alpha.map { ap[ai+$0] } ?? 255) != (b.alpha.map { bp[bi+$0] } ?? 255) { return false }
        }
    }
    return true
}

var results: [[String: Any]] = []
for (index, path) in CommandLine.arguments.dropFirst().enumerated() {
    do {
        try autoreleasepool {
            let image = try decode(Data(contentsOf: URL(fileURLWithPath: path)))
            let scannedAt = now()
            guard let opaque = opaqueView(image) else {
                results.append(["sample": index, "eligible": false, "bitmapInfo": image.bitmapInfo.rawValue]); return
            }
            let scanMilliseconds = (now() - scannedAt) * 1000
            var regularTimes: [Double] = [], opaqueTimes: [Double] = []
            var regular = Data(), compact = Data()
            for iteration in 0..<4 {
                for candidate in (iteration % 2 == 0 ? [false, true] : [true, false]) {
                    let start = now()
                    let data = try encode(candidate ? opaque : image)
                    let elapsed = (now() - start) * 1000
                    if candidate { compact = data; opaqueTimes.append(elapsed) }
                    else { regular = data; regularTimes.append(elapsed) }
                }
            }
            let regularDecoded = try decode(regular), opaqueDecoded = try decode(compact)
            let colorSpaceEqual = regularDecoded.colorSpace?.copyICCData() as Data? == opaqueDecoded.colorSpace?.copyICCData() as Data?
            results.append([
                "sample": index, "eligible": true, "width": image.width, "height": image.height,
                "bitmapInfo": image.bitmapInfo.rawValue, "scanMilliseconds": scanMilliseconds,
                "regularBytes": regular.count, "opaqueBytes": compact.count,
                "regularEncodeMilliseconds": regularTimes, "opaqueEncodeMilliseconds": opaqueTimes,
                "pngRegularColorType": regular.count > 25 ? Int(regular[25]) : -1,
                "pngOpaqueColorType": compact.count > 25 ? Int(compact[25]) : -1,
                "dimensionsMatch": regularDecoded.width == opaqueDecoded.width && regularDecoded.height == opaqueDecoded.height,
                "colorSpaceEqual": colorSpaceEqual, "decodedPixelsEqual": equalPixels(regularDecoded, opaqueDecoded),
                "originalPixelsEqual": equalPixels(image, opaqueDecoded)
            ])
        }
    } catch { results.append(["sample": index, "errorCode": (error as NSError).code]) }
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["measurements": results], options: [.sortedKeys, .prettyPrinted]))
FileHandle.standardOutput.write(Data("\n".utf8))
