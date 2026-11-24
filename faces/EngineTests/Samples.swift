import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum Samples {
    static let upright = ["red", "green", "blue", "black"]
    static let colours: [String: [UInt8]] = [
        "red": [255, 0, 0], "green": [0, 255, 0], "blue": [0, 0, 255], "black": [0, 0, 0], "white": [255, 255, 255],
    ]

    static func marked(_ width: Int, _ height: Int, clear: Bool = false, shift: Int = 0) -> CGImage {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let (w, h) = (width / 4, height / 4)
        let blocks = [(0, height - h - shift), (width - w, height - h - shift), (0, -shift), (width - w, -shift)]
        for (name, (x, y)) in zip(upright, blocks) {
            let rgb = colours[name]!.map { CGFloat($0) / 255 }
            context.setFillColor(CGColor(srgbRed: rgb[0], green: rgb[1], blue: rgb[2], alpha: 1))
            context.fill(CGRect(x: x, y: max(0, y), width: w, height: h))
        }
        if clear { context.clear(CGRect(x: width / 3, y: height / 3, width: width / 3, height: height / 3)) }
        return context.makeImage()!
    }

    static func stored(_ image: CGImage, for orientation: Int) -> CGImage {
        let (width, height) = (image.width, image.height)
        let turned = orientation == 6 || orientation == 8
        let context = CGContext(data: nil, width: turned ? height : width, height: turned ? width : height, bitsPerComponent: 8,
                                bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        switch orientation {
        case 6:
            context.translateBy(x: CGFloat(height), y: 0)
            context.rotate(by: .pi / 2)
        case 8:
            context.translateBy(x: 0, y: CGFloat(width))
            context.rotate(by: -.pi / 2)
        default:
            precondition(orientation == 1, "orientation 1, 6 or 8")
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()!
    }

    static func write(_ images: [CGImage], to url: URL, type: UTType, orientation: Int?) {
        let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, images.count, nil)!
        var properties: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 0.95,
            kCGImagePropertyGPSDictionary: [
                kCGImagePropertyGPSLatitude: 1.5, kCGImagePropertyGPSLatitudeRef: "N",
                kCGImagePropertyGPSLongitude: 2.5, kCGImagePropertyGPSLongitudeRef: "E",
            ],
        ]
        if let orientation { properties[kCGImagePropertyOrientation] = orientation }
        if type == .gif { properties[kCGImagePropertyGIFDictionary] = [kCGImagePropertyGIFDelayTime: 0.1] }
        for image in images { CGImageDestinationAddImage(destination, image, properties as CFDictionary) }
        precondition(CGImageDestinationFinalize(destination), "ImageIO wrote no \(type.identifier)")
    }

    static func webp(_ frames: [CGImage], orientation: Int? = nil) -> Data {
        let (width, height) = (frames[0].width, frames[0].height)
        let still = frames.count == 1
        var chunks: [UInt8] = []
        if still && orientation == nil {
            chunks = chunk("VP8L", vp8l(frames[0]))
        } else {
            chunks = chunk("VP8X", [still ? 0x08 : 0x02, 0, 0, 0] + le(width - 1, 3) + le(height - 1, 3))
            if still {
                chunks += chunk("VP8L", vp8l(frames[0]))
                chunks += chunk("EXIF", Array("MM".utf8) + [0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, UInt8(orientation!), 0, 0, 0, 0, 0, 0])
            } else {
                chunks += chunk("ANIM", [255, 255, 255, 255, 0, 0])
                for frame in frames {
                    chunks += chunk("ANMF", [0, 0, 0, 0, 0, 0] + le(width - 1, 3) + le(height - 1, 3) + le(100, 3) + [0x02] + chunk("VP8L", vp8l(frame)))
                }
            }
        }
        return Data(Array("RIFF".utf8) + le(4 + chunks.count, 4) + Array("WEBP".utf8) + chunks)
    }

    static func corners(_ url: URL, shown: Bool = false) -> [String] {
        let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
        let image = shown
            ? CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 100_000,
            ] as CFDictionary)!
            : CGImageSourceCreateImageAtIndex(source, 0, nil)!
        return corners(image)
    }

    static func corners(_ image: CGImage) -> [String] {
        let (width, height) = (image.width, image.height)
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        pixels.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        let points = [(width / 8, height / 8), (width - width / 8, height / 8), (width / 8, height - height / 8), (width - width / 8, height - height / 8)]
        return points.map { x, y in
            let at = (min(y, height - 1) * width + min(x, width - 1)) * 4
            let rgb = pixels[at..<at + 3].map(Int.init)
            return colours.min { distance($0.value, rgb) < distance($1.value, rgb) }!.key
        }
    }

    static func mean(_ image: CGImage, _ box: [Double]) -> [Double] {
        let (width, height) = (image.width, image.height)
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        pixels.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        var sum = [0.0, 0.0, 0.0], count = 0.0
        for y in max(0, Int(box[1]))..<min(height, Int(box[3])) {
            for x in max(0, Int(box[0]))..<min(width, Int(box[2])) {
                for c in 0..<3 { sum[c] += Double(pixels[(y * width + x) * 4 + c]) }
                count += 1
            }
        }
        return sum.map { $0 / max(1, count) }
    }

    static func facts(_ url: URL) -> [String: Any] {
        let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        var facts: [String: Any] = [
            "width": properties[kCGImagePropertyPixelWidth] as? Int ?? 0, "height": properties[kCGImagePropertyPixelHeight] as? Int ?? 0,
            "gps": properties[kCGImagePropertyGPSDictionary] != nil, "alpha": properties[kCGImagePropertyHasAlpha] as? Bool ?? false,
            "type": CGImageSourceGetType(source) as String? ?? "", "frames": CGImageSourceGetCount(source),
            "corners": corners(url), "shown": corners(url, shown: true),
        ]
        if let orientation = properties[kCGImagePropertyOrientation] as? Int { facts["orientation"] = orientation }
        return facts
    }

    static func movie(_ stored: CGImage, to url: URL, frames: Int64 = 10, perSecond: Int32 = 30,
                      marked: @escaping @Sendable (Int64) -> Bool = { $0 > 0 }) async throws {
        let (width, height) = (stored.width, stored.height)
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
        ])
        input.expectsMediaDataInRealTime = false
        input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: CGFloat(height), ty: 0)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.startSession(atSourceTime: .zero)
        func frame(_ image: CGImage?) -> CVPixelBuffer {
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &buffer)
            CVPixelBufferLockBaseAddress(buffer!, [])
            let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer!), width: width, height: height, bitsPerComponent: 8,
                                    bytesPerRow: CVPixelBufferGetBytesPerRow(buffer!), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                    bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)!
            context.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            if let image { context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height)) }
            CVPixelBufferUnlockBaseAddress(buffer!, [])
            return buffer!
        }
        let (black, shown) = (frame(nil), frame(stored))
        let queue = DispatchQueue(label: "samples.movie")
        do {
            try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in
                let writing = Writing(writer: writer, input: input, adaptor: adaptor, black: black, frame: shown, frames: frames,
                                      perSecond: perSecond, marked: marked, done: done)
                input.requestMediaDataWhenReady(on: queue) { writing.more() }
                queue.asyncAfter(deadline: .now() + .seconds(Writing.boundSeconds)) { writing.giveUp() }
            }
        } catch {
            writer.cancelWriting()
            throw error
        }
        if writer.status == .writing { await writer.finishWriting() }
        if writer.status != .completed { throw MovieNotWritten(said: "finishing \(url.lastPathComponent): \(Writing.state(writer))") }
    }

    struct MovieNotWritten: Error, CustomStringConvertible {
        let said: String
        var description: String { "the sample movie was not written: \(said)" }
    }

    private final class Writing: @unchecked Sendable {
        static let boundSeconds = 30
        let writer: AVAssetWriter
        let input: AVAssetWriterInput
        let adaptor: AVAssetWriterInputPixelBufferAdaptor
        let black: CVPixelBuffer
        let frame: CVPixelBuffer
        let frames: Int64
        let perSecond: Int32
        let marked: @Sendable (Int64) -> Bool
        var done: CheckedContinuation<Void, any Error>?
        var next: Int64 = 0

        init(writer: AVAssetWriter, input: AVAssetWriterInput, adaptor: AVAssetWriterInputPixelBufferAdaptor, black: CVPixelBuffer,
             frame: CVPixelBuffer, frames: Int64, perSecond: Int32, marked: @escaping @Sendable (Int64) -> Bool,
             done: CheckedContinuation<Void, any Error>) {
            (self.writer, self.input, self.adaptor, self.black, self.frame) = (writer, input, adaptor, black, frame)
            (self.frames, self.perSecond, self.marked, self.done) = (frames, perSecond, marked, done)
        }

        static func state(_ writer: AVAssetWriter) -> String {
            let status = [AVAssetWriter.Status.unknown: "unknown", .writing: "writing", .completed: "completed", .failed: "failed",
                          .cancelled: "cancelled"][writer.status] ?? "status \(writer.status.rawValue)"
            return "the writer is \(status)\(writer.error.map { ": \($0)" } ?? "")"
        }

        func more() {
            guard done != nil else { return }
            while input.isReadyForMoreMediaData && next < frames {
                guard adaptor.append(marked(next) ? frame : black, withPresentationTime: CMTime(value: next, timescale: perSecond)) else {
                    return end(MovieNotWritten(said: "frame \(next) of \(frames) was refused; \(Writing.state(writer))"))
                }
                next += 1
            }
            if next == frames {
                input.markAsFinished()
                end(nil)
            } else if writer.status != .writing {
                end(MovieNotWritten(said: "\(next) of \(frames) frames taken; \(Writing.state(writer))"))
            }
        }

        func giveUp() {
            end(MovieNotWritten(said: "the encoder took \(next) of \(frames) frames in \(Writing.boundSeconds) s and asked for no more; \(Writing.state(writer))"))
        }

        private func end(_ error: (any Error)?) {
            guard let done else { return }
            self.done = nil
            if let error { done.resume(throwing: error) } else { done.resume() }
        }
    }

    static func tool(_ arguments: [String]) async throws {
        let rest = Array(arguments.dropFirst(2))
        guard !rest.isEmpty else { throw CocoaError(.featureUnsupported) }
        switch arguments.dropFirst().first {
        case "marked":
            let (width, height, type, orientation) = (Int(rest[0])!, Int(rest[1])!, rest[2], Int(rest[3])!)
            let url = URL(fileURLWithPath: rest.last!)
            let frames = (rest.contains("frames") ? [0, 7] : [0]).map { stored(marked(width, height, clear: rest.contains("clear"), shift: $0), for: orientation) }
            if type == "webp" {
                try webp(frames, orientation: orientation == 1 ? nil : orientation).write(to: url)
            } else {
                let types: [String: UTType] = ["jpeg": .jpeg, "heic": .heic, "png": .png, "gif": .gif]
                write(frames, to: url, type: types[type]!, orientation: orientation == 1 ? nil : orientation)
            }
        case "movie":
            try await movie(stored(marked(Int(rest[0])!, Int(rest[1])!), for: 6), to: URL(fileURLWithPath: rest[2]))
        case "turned":
            let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: rest[0]) as CFURL, nil)!
            let orientation = Int(rest[1])!
            write([stored(CGImageSourceCreateImageAtIndex(source, 0, nil)!, for: orientation)], to: URL(fileURLWithPath: rest[2]), type: .jpeg, orientation: orientation)
        case "mean":
            let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: rest[0]) as CFURL, nil)!
            let box = rest[1...4].map { Double($0)! }
            let json = try JSONSerialization.data(withJSONObject: mean(CGImageSourceCreateImageAtIndex(source, 0, nil)!, box))
            FileHandle.standardOutput.write(json + Data("\n".utf8))
        case "facts":
            let json = try JSONSerialization.data(withJSONObject: facts(URL(fileURLWithPath: rest[0])), options: [.sortedKeys])
            FileHandle.standardOutput.write(json + Data("\n".utf8))
        default:
            throw CocoaError(.featureUnsupported)
        }
    }


    private static func distance(_ a: [UInt8], _ b: [Int]) -> Int {
        zip(a, b).map { (Int($0) - $1) * (Int($0) - $1) }.reduce(0, +)
    }

    private static func le(_ value: Int, _ bytes: Int) -> [UInt8] {
        (0..<bytes).map { UInt8(truncatingIfNeeded: value >> (8 * $0)) }
    }

    private static func chunk(_ fourCC: String, _ body: [UInt8]) -> [UInt8] {
        Array(fourCC.utf8) + le(body.count, 4) + body + (body.count % 2 == 1 ? [0] : [])
    }

    private static func vp8l(_ image: CGImage) -> [UInt8] {
        let (width, height) = (image.width, image.height)
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        pixels.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        let on = pixels.map { $0 >= 128 }
        var bits = Bits()
        bits.put(0x2f, 8)
        bits.put(width - 1, 14)
        bits.put(height - 1, 14)
        bits.put(0, 1)
        bits.put(0, 3)
        bits.put(0, 1)
        bits.put(0, 1)
        bits.put(0, 1)
        var both: [Bool] = []
        for channel in [1, 0, 2] {
            let values = Set(stride(from: channel, to: on.count, by: 4).map { on[$0] })
            both.append(values.count == 2)
            bits.put(1, 1)
            if values.count == 2 {
                bits.put(1, 1)
                bits.put(1, 1)
                bits.put(0, 8)
                bits.put(255, 8)
            } else {
                bits.put(0, 1)
                bits.put(1, 1)
                bits.put(values.first! ? 255 : 0, 8)
            }
        }
        for symbol in [255, 0] {
            bits.put(1, 1)
            bits.put(0, 1)
            bits.put(1, 1)
            bits.put(symbol, 8)
        }
        for pixel in 0..<width * height {
            for (code, channel) in [1, 0, 2].enumerated() where both[code] { bits.put(on[pixel * 4 + channel] ? 1 : 0, 1) }
        }
        return bits.bytes
    }

    private struct Bits {
        var bytes: [UInt8] = []
        var used = 8

        mutating func put(_ value: Int, _ count: Int) {
            for bit in 0..<count {
                if used == 8 {
                    bytes.append(0)
                    used = 0
                }
                if (value >> bit) & 1 == 1 { bytes[bytes.count - 1] |= 1 << used }
                used += 1
            }
        }
    }
}
