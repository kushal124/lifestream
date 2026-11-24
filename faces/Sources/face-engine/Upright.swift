import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum Upright {
    static let quality = 0.8

    struct Request: Decodable {
        let from: String
        let to: String
        let type: String
        let side: Int?
    }

    struct Result: Encodable {
        var made: String?
        var animated: Bool?
        var cannot: String?
    }

    static func run(_ request: Request) throws -> Result {
        if let side = request.side, side < 1 { throw EngineError.request("side is a whole number of pixels, 1 or more, or null") }
        let video = request.type.hasPrefix("video/")
        guard video || request.type.hasPrefix("image/") else {
            throw EngineError.request("type is image/… or video/…, not \(request.type)")
        }
        guard FileManager.default.isReadableFile(atPath: request.from) else { throw EngineError.failed("cannot read \(request.from)") }
        let made = video ? try poster(request) : picture(request)
        switch made {
        case .failure(let unreadable): return Result(cannot: unreadable.reason)
        case .success(.animated): return Result(animated: true)
        case .success(.image(let image, let png)):
            let type = png ? UTType.png : UTType.jpeg
            try write(image, type: type, to: request.to)
            return Result(made: png ? "png" : "jpeg")
        }
    }

    private enum Made {
        case image(CGImage, png: Bool)
        case animated
    }

    private static func picture(_ request: Request) -> Swift.Result<Made, Unreadable> {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: request.from) as CFURL, nil),
              CGImageSourceGetCount(source) > 0, let size = Picture.orientedSize(source)
        else { return .failure(Unreadable("not an image ImageIO can read")) }
        if ["image/gif", "image/webp"].contains(request.type), CGImageSourceGetCount(source) > 1 { return .success(.animated) }
        guard size.width * size.height <= Picture.maxPixels else {
            return .failure(Unreadable("larger than \(Picture.maxPixels / 1_000_000) megapixels"))
        }
        let longer = max(size.width, size.height)
        guard let image = Picture.thumbnail(source, maxSide: min(request.side ?? longer, longer)) else {
            return .failure(Unreadable("ImageIO cannot decode it"))
        }
        if request.type == "image/png" { return .success(.image(image, png: true)) }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        return .success(.image(image, png: properties?[kCGImagePropertyHasAlpha] as? Bool == true && seeThrough(image)))
    }

    private static func seeThrough(_ image: CGImage) -> Bool {
        let (width, height) = (image.width, image.height)
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        return pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return true }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return stride(from: 3, to: buffer.count, by: 4).contains { buffer[$0] < 255 }
        }
    }

    private static func poster(_ request: Request) throws -> Swift.Result<Made, Unreadable> {
        let asset = AVURLAsset(url: URL(fileURLWithPath: request.from), options: [AVURLAssetOverrideMIMETypeKey: request.type])
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        if #available(macOS 15, *) { generator.dynamicRangePolicy = .forceSDR }
        if let side = request.side { generator.maximumSize = CGSize(width: side, height: side) }
        let frame = Frame()
        let done = DispatchSemaphore(value: 0)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        Task.detached {
            do {
                let length = try await asset.load(.duration)
                if length.isNumeric, length.seconds > 0 {
                    let at = length.seconds >= 10 ? CMTime(value: 1, timescale: 1) : CMTimeMultiplyByRatio(length, multiplier: 1, divisor: 10)
                    frame.image = .success(try await generator.image(at: at).image)
                } else {
                    frame.image = .failure(Unreadable("a video of no length"))
                }
            } catch {
                frame.failed = error
            }
            done.signal()
        }
        done.wait()
        if let error = frame.failed {
            guard noMovie(error) else { throw EngineError.failed("AVFoundation could not read the video just now: \(error.localizedDescription)") }
            return .failure(Unreadable("no frame AVFoundation can read: \(error.localizedDescription)"))
        }
        return frame.image.map { .image($0, png: false) }
    }

    static func noMovie(_ error: Error) -> Bool {
        guard let error = error as? AVError else { return false }
        return [.fileFormatNotRecognized, .fileFailedToParse, .decoderNotFound, .noImageAtTime, .contentIsUnavailable].contains(error.code)
    }

    private final class Frame: @unchecked Sendable {
        var image: Swift.Result<CGImage, Unreadable> = .failure(Unreadable("no frame"))
        var failed: Error?
    }

    private static func write(_ image: CGImage, type: UTType, to path: String) throws {
        guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, type.identifier as CFString, 1, nil) else {
            throw EngineError.failed("cannot write \(path)")
        }
        CGImageDestinationAddImage(destination, image, (type == .jpeg ? [kCGImageDestinationLossyCompressionQuality: quality] : [:]) as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw EngineError.failed("cannot write \(path)") }
    }
}
