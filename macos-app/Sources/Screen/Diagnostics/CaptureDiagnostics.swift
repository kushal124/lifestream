import AppKit
import CoreText
import Evidence

@MainActor
public enum CaptureDiagnostics {
    public static func recognizeSavedImage(_ saved: CaptureImage) async -> ([Evidence.TextObservation], String) {
        guard let image = await ImageConversion.decode(saved) else { return ([], "image-unavailable") }
        let result = await recognize(image)
        return (result.observations, result.status.rawValue)
    }

    public static func pngForSavedImage(_ saved: CaptureImage) async throws -> Data {
        if case .png(let data) = saved { return data }
        guard let image = await ImageConversion.decode(saved) else {
            throw NSError(domain: "CaptureImage", code: 1)
        }
        return try await ImageConversion.encodePNG(image)
    }

    public static func selfTest() async -> [String: Bool] {
        let marker = "SYNTHETIC CAPTURE CHECK"
        guard let image = Self.syntheticImage(width: 1600, height: 240, lines: [(marker, 90)],
            space: CGColorSpace(name: CGColorSpace.sRGB)) else {
            return ["pngEncoded": false, "ocrRecognized": false]
        }
        let png = try? await ImageConversion.encodePNG(image)
        let result = await Self.recognize(image)
        let recognized = result.observations.map(\.text).joined(separator: " ")
        var checks = ["pngEncoded": png?.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) == true,
                      "ocrRecognized": result.status == .complete && recognized.contains(marker)]
        let before = Self.syntheticImage(width: 1600, height: 1000,
            lines: [("SYNTHETIC STABLE LINE", 800), ("SYNTHETIC OLD", 100)], space: CGColorSpaceCreateDeviceRGB())
        let after = Self.syntheticImage(width: 1600, height: 1000,
            lines: [("SYNTHETIC STABLE LINE", 800), ("SYNTHETIC NEW", 100)], space: CGColorSpaceCreateDeviceRGB())
        guard let before, let after else {
            checks["exactOnlyIdenticalReused"] = false
            return checks
        }
        let recognizer = TextRecognizer(mode: .exact) { frame, tile in
            await BlockingWork.run { TileCrop(frame, tile).recognize() }
        }
        func live(_ image: CGImage) async -> RecognizedImage {
            await recognizer.start(image, bytes: ImageBytes.materialize(image), display: 1,
                                   vision: VisionRecognizer.read).value
        }
        let exactInitial = await live(before)
        let exactRepeated = await live(before)
        var exactLong = exactRepeated
        for _ in 0..<12 {
            exactLong = await live(before)
        }
        checks["exactOnlyReuseBeyondAuditInterval"] = exactLong.status == .reusedExactImage
            && exactLong.observations == exactInitial.observations
        let exactChanged = await live(after)
        let fullChanged = await Self.recognize(after)
        checks["exactOnlyIdenticalReused"] = exactRepeated.status == .reusedExactImage
            && exactRepeated.observations == exactInitial.observations
        checks["exactOnlyChangedTilesRead"] = exactChanged.status == .completeReusedTiles && exactChanged.requests == 1 &&
            fullChanged.status == .complete && exactChanged.observations == fullChanged.observations
        return checks
    }

    nonisolated private static func recognize(_ image: CGImage) async -> RecognizedImage {
        await BlockingWork.run { ImageRecognition.full(image, vision: VisionRecognizer.read) }
    }

    nonisolated private static func syntheticImage(width: Int, height: Int, lines: [(String, Int)],
                                                   space: CGColorSpace?) -> CGImage? {
        guard let space, let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let font = CTFontCreateWithName("Helvetica" as CFString, 64, nil)
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)]
        for (label, y) in lines {
            context.textPosition = CGPoint(x: 60, y: y)
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: label, attributes: attributes))
            CTLineDraw(line, context)
        }
        return context.makeImage()
    }
}
