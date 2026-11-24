import Compression
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

enum Engine {
    static let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    static let models = package.appendingPathComponent("models/buffalo_l")
    static let reference = package.appendingPathComponent("reference")
    static let artifacts = package.appendingPathComponent(".build/e2e")

    static var binary: URL {
        Bundle(for: Marker.self).bundleURL.deletingLastPathComponent().appendingPathComponent("face-engine")
    }

    struct Run {
        let status: Int32
        let stderr: String
        let resultFile: URL

        func json(file: StaticString = #filePath, line: UInt = #line) throws -> [String: Any] {
            XCTAssertEqual(status, 0, "face-engine failed: \(stderr)", file: file, line: line)
            let data = try Data(contentsOf: resultFile)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], file: file, line: line)
        }

        var resultExists: Bool { FileManager.default.fileExists(atPath: resultFile.path) }
    }

    @discardableResult
    static func run(_ command: String, _ request: Any, in folder: URL, name: String = "request") throws -> Run {
        let requestFile = folder.appendingPathComponent("\(name).json")
        try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys]).write(to: requestFile)
        return try run([command, requestFile.path, folder.appendingPathComponent("\(name)-result.json").path])
    }

    static func run(_ arguments: [String]) throws -> Run {
        let process = Process()
        process.executableURL = binary
        process.arguments = arguments
        let errors = Pipe()
        process.standardError = errors
        try process.run()
        let stderr = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        let result = URL(fileURLWithPath: arguments.count > 2 ? arguments[2] : "/nonexistent")
        return Run(status: process.terminationStatus, stderr: stderr, resultFile: result)
    }

    static func requireModels() throws {
        for file in ["det_10g.onnx", "w600k_r50.onnx"]
        where !FileManager.default.fileExists(atPath: models.appendingPathComponent(file).path) {
            throw XCTSkip("faces/models/buffalo_l/\(file) is absent; run faces/fetch-models.sh")
        }
    }

    static func keep(_ file: URL, as name: String) {
        try? FileManager.default.createDirectory(at: artifacts, withIntermediateDirectories: true)
        let target = artifacts.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: target)
        try? FileManager.default.copyItem(at: file, to: target)
    }
}

final class Marker {}

class EngineTestCase: XCTestCase {
    var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("face-engine-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func path(_ name: String) -> String { folder.appendingPathComponent(name).path }
}

enum Images {
    static let seven = Engine.reference.appendingPathComponent("crew-seven.jpg")
    static let six = Engine.reference.appendingPathComponent("crew-six.jpg")

    static func load(_ url: URL) -> CGImage {
        let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
        return CGImageSourceCreateImageAtIndex(source, 0, nil)!
    }

    static func write(_ image: CGImage, to url: URL, type: UTType, orientation: Int? = nil) {
        let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
        var properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.95]
        if let orientation { properties[kCGImagePropertyOrientation] = orientation }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        precondition(CGImageDestinationFinalize(destination))
    }

    static func canvas(_ width: Int, _ height: Int, gray: Bool = false, _ draw: (CGContext) -> Void) -> CGImage {
        let space = gray ? CGColorSpaceCreateDeviceGray() : CGColorSpace(name: CGColorSpace.sRGB)!
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                bytesPerRow: 0, space: space,
                                bitmapInfo: gray ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.interpolationQuality = .high
        draw(context)
        return context.makeImage()!
    }

    static func scaled(_ image: CGImage, _ factor: Double) -> CGImage {
        let width = Int(Double(image.width) * factor), height = Int(Double(image.height) * factor)
        return canvas(width, height) { $0.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height)) }
    }

    static func closeUp(_ height: Double, width: Int = 896, canvasHeight: Int = 1200, narrow: Double = 1,
                        across: Double = 0.5) throws -> CGImage {
        let expected = try JSONSerialization.jsonObject(
            with: Data(contentsOf: Engine.reference.appendingPathComponent("expected.json"))) as! [String: Any]
        let photo = (expected["photos"] as! [[String: Any]]).first { $0["key"] as? String == "crew-six.jpg" }!
        let face = (photo["faces"] as! [[String: Any]]).max { ($0["score"] as! Double) < ($1["score"] as! Double) }!
        let box = face["box"] as! [Double]
        let image = load(six)
        let (w, h) = (box[2] - box[0], box[3] - box[1])
        let region = CGRect(x: box[0] - w / 2, y: box[1] - 0.6 * h, width: 2 * w,
                            height: Double(image.height) - (box[1] - 0.6 * h))
        let cut = image.cropping(to: region)!
        let s = height / h
        let left = Double(width) * across - ((box[0] + box[2]) / 2 - region.minX) * s * narrow
        let top = Double(canvasHeight) / 2 - ((box[1] + box[3]) / 2 - region.minY) * s
        return canvas(width, canvasHeight) { context in
            context.setFillColor(CGColor(srgbRed: 0.5, green: 0.5, blue: 0.5, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: canvasHeight))
            context.draw(cut, in: CGRect(x: left, y: Double(canvasHeight) - top - region.height * s,
                                         width: region.width * s * narrow, height: region.height * s))
        }
    }

    static let shotLines: [(words: String, top: Double)] = [
        ("Call Ada Example at +1 555 000 0001", 80), ("Write to person-a@example.com today", 200),
    ]
    static let shotFace = [1042.75, 490.0, 1162.23, 640.93]

    static func screenshot() -> CGImage {
        let (width, height) = (1400, 900)
        let face = load(seven).cropping(to: CGRect(x: 340, y: 240, width: 160, height: 160))!
        return canvas(width, height) { context in
            context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            let font = CTFontCreateWithName("Helvetica" as CFString, 48, nil)
            for (words, top) in shotLines {
                let line = CTLineCreateWithAttributedString(NSAttributedString(string: words, attributes: [
                    NSAttributedString.Key(kCTFontAttributeName as String): font,
                    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1),
                ]))
                context.textPosition = CGPoint(x: 60, y: Double(height) - top - 48)
                CTLineDraw(line, context)
            }
            context.draw(face, in: CGRect(x: 900, y: Double(height) - 380 - 400, width: 400, height: 400))
        }
    }

    static func overlap(_ a: [Double], _ b: [Double]) -> Double {
        let width = min(a[2], b[2]) - max(a[0], b[0]), height = min(a[3], b[3]) - max(a[1], b[1])
        guard width > 0, height > 0 else { return 0 }
        return width * height / min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    }

    static func storedForOrientation6(_ image: CGImage) -> CGImage {
        canvas(image.height, image.width) { context in
            context.translateBy(x: CGFloat(image.height), y: 0)
            context.rotate(by: .pi / 2)
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
    }

    static func pixel(_ url: URL, _ x: Int, _ y: Int) -> (Int, Int, Int) {
        let image = load(url)
        var bytes = [UInt8](repeating: 0, count: 4)
        let context = CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
        return (Int(bytes[0]), Int(bytes[1]), Int(bytes[2]))
    }

    static func size(_ url: URL) -> (Int, Int) {
        let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as! [CFString: Any]
        return (properties[kCGImagePropertyPixelWidth] as! Int, properties[kCGImagePropertyPixelHeight] as! Int)
    }

    static func blackPNG(width: UInt32, height: UInt32) -> Data {
        func chunk(_ type: String, _ body: [UInt8]) -> [UInt8] {
            let typed = Array(type.utf8) + body
            return bigEndian(UInt32(body.count)) + typed + bigEndian(crc32(typed))
        }
        let total = Int(height) * (1 + Int(width) * 3)
        var deflated: [UInt8] = [0x78, 0x9C]
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        precondition(compression_stream_init(stream, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK)
        defer { compression_stream_destroy(stream) }
        let zeros = [UInt8](repeating: 0, count: 1 << 20)
        var output = [UInt8](repeating: 0, count: 1 << 20)
        var remaining = total
        zeros.withUnsafeBufferPointer { input in
            output.withUnsafeMutableBufferPointer { out in
                var status = COMPRESSION_STATUS_OK
                while status == COMPRESSION_STATUS_OK {
                    if stream.pointee.src_size == 0 && remaining > 0 {
                        stream.pointee.src_ptr = input.baseAddress!
                        stream.pointee.src_size = min(remaining, input.count)
                        remaining -= stream.pointee.src_size
                    }
                    stream.pointee.dst_ptr = out.baseAddress!
                    stream.pointee.dst_size = out.count
                    status = compression_stream_process(stream, remaining == 0 ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0)
                    deflated += out.prefix(out.count - stream.pointee.dst_size)
                }
            }
        }
        deflated += bigEndian(UInt32(total % 65521) << 16 | 1)
        let header = bigEndian(width) + bigEndian(height) + [8, 2, 0, 0, 0]
        return Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] + chunk("IHDR", header) + chunk("IDAT", deflated)
            + chunk("IEND", []))
    }

    private static func bigEndian(_ value: UInt32) -> [UInt8] {
        [UInt8(value >> 24), UInt8(value >> 16 & 0xFF), UInt8(value >> 8 & 0xFF), UInt8(value & 0xFF)]
    }

    private static func crc32(_ bytes: [UInt8]) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in bytes {
            crc ^= UInt32(byte)
            for _ in 0..<8 { crc = crc & 1 == 1 ? (crc >> 1) ^ 0xEDB8_8320 : crc >> 1 }
        }
        return ~crc
    }
}
