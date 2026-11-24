import Foundation
import CoreGraphics
import ImageIO
import Vision

private func now() -> Double { ProcessInfo.processInfo.systemUptime }
private func failure(_ code: Int) -> NSError { NSError(domain: "OCRScaleBenchmark", code: code) }
private func decode(_ path: String) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0,
              [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    else { throw failure(1) }
    return image
}
private func downsample(_ image: CGImage, height: Int) throws -> CGImage {
    guard image.height > height else { return image }
    guard let colorSpace = image.colorSpace, colorSpace.model == .rgb else { throw failure(2) }
    let width = max(1, Int((Double(image.width) * Double(height) / Double(image.height)).rounded()))
    guard let context = CGContext(data: nil, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw failure(3) }
    context.interpolationQuality = .high
    context.setBlendMode(.copy)
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let result = context.makeImage() else { throw failure(4) }
    return result
}
private struct Recognized {
    let tokens: Set<String>
    let tokenBag: [String: Int]
    let lineBag: [String: Int]
}
private func recognize(_ image: CGImage) throws -> Recognized {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    let words = lines.flatMap { $0.split(whereSeparator: { $0.isWhitespace }).map(String.init) }
    return Recognized(tokens: Set(words),
        tokenBag: Dictionary(words.map { ($0, 1) }, uniquingKeysWith: +),
        lineBag: Dictionary(lines.map { ($0, 1) }, uniquingKeysWith: +))
}
private struct Measurement {
    let recognized: Recognized
    let width: Int
    let height: Int
    let scaleMilliseconds: Double
    let ocrMilliseconds: Double
    let colorSpacePreserved: Bool
    let executionOrder: Int
}
private func run() throws {
    guard CommandLine.arguments.count == 2 else { throw failure(5) }
    let paths = try JSONDecoder().decode([String].self,
        from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    guard !paths.isEmpty, paths.count <= 20 else { throw failure(6) }
    var rows: [[String: Any]] = []
    var warmedUp = false
    for (sample, path) in paths.enumerated() {
        do {
            try autoreleasepool {
                let decodeStarted = now()
                let original = try decode(path)
                let decodeMilliseconds = (now() - decodeStarted) * 1000
                if !warmedUp {
                    _ = try recognize(original)
                    warmedUp = true
                }
                let heights = [0, 1440, 1600, 1800]
                let order = Array(heights[(sample % 4)...]) + Array(heights[..<(sample % 4)])
                var measurements: [Int: Measurement] = [:]
                var errors: [Int: Int] = [:]
                for (position, height) in order.enumerated() {
                    do {
                        let measurement = try autoreleasepool { () throws -> Measurement in
                            let scaleStarted = now()
                            let image = height == 0 ? original : try downsample(original, height: height)
                            let scaleMilliseconds = (now() - scaleStarted) * 1000
                            let ocrStarted = now()
                            let recognized = try recognize(image)
                            let elapsed = (now() - ocrStarted) * 1000
                            let sameSpace: Bool
                            if let a = original.colorSpace, let b = image.colorSpace {
                                sameSpace = CFEqual(a, b)
                            } else { sameSpace = false }
                            return Measurement(recognized: recognized, width: image.width, height: image.height,
                                scaleMilliseconds: scaleMilliseconds, ocrMilliseconds: elapsed,
                                colorSpacePreserved: sameSpace, executionOrder: position)
                        }
                        measurements[height] = measurement
                    } catch { errors[height] = (error as NSError).code }
                }
                guard let reference = measurements[0] else { throw failure(7) }
                for height in heights {
                    guard let measurement = measurements[height] else {
                        rows.append(["sample": sample, "targetHeight": height,
                            "error": "scale-or-ocr-failed", "errorCode": errors[height] ?? -1])
                        continue
                    }
                    let expected = reference.recognized
                    let actual = measurement.recognized
                    let common = expected.tokens.intersection(actual.tokens).count
                    let bagCommon = expected.tokenBag.reduce(0) { $0 + min($1.value, actual.tokenBag[$1.key] ?? 0) }
                    rows.append([
                        "sample": sample, "targetHeight": height, "native": height == 0,
                        "width": measurement.width, "height": measurement.height,
                        "nativeWidth": original.width, "nativeHeight": original.height,
                        "sourceDecodeMilliseconds": decodeMilliseconds,
                        "scaleMilliseconds": measurement.scaleMilliseconds,
                        "ocrMilliseconds": measurement.ocrMilliseconds,
                        "scaleAndOCRMilliseconds": measurement.scaleMilliseconds + measurement.ocrMilliseconds,
                        "nativeOCRMilliseconds": reference.ocrMilliseconds,
                        "colorSpacePreserved": measurement.colorSpacePreserved,
                        "executionOrder": measurement.executionOrder,
                        "referenceTokens": expected.tokens.count, "observedTokens": actual.tokens.count,
                        "commonTokens": common,
                        "tokenRecall": expected.tokens.isEmpty ? 1.0 : Double(common) / Double(expected.tokens.count),
                        "tokenPrecision": actual.tokens.isEmpty ? (expected.tokens.isEmpty ? 1.0 : 0.0) : Double(common) / Double(actual.tokens.count),
                        "commonTokenOccurrences": bagCommon,
                        "referenceTokenOccurrences": expected.tokenBag.values.reduce(0, +),
                        "observedTokenOccurrences": actual.tokenBag.values.reduce(0, +),
                        "tokenMultisetEqual": expected.tokenBag == actual.tokenBag,
                        "textMultisetEqual": expected.lineBag == actual.lineBag
                    ])
                }
            }
        } catch {
            rows.append(["sample": sample, "error": "sample-or-reference-failed", "errorCode": (error as NSError).code])
        }
    }
    let result: [String: Any] = ["reference": "native-resolution-vision-not-ground-truth",
        "recognitionLevel": "accurate", "languageCorrection": false,
        "warmupExcluded": warmedUp, "order": "rotated-per-sample",
        "measurements": rows]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]))
    FileHandle.standardOutput.write(Data("\n".utf8))
}
do { try run() }
catch {
    FileHandle.standardError.write(Data("OCR scale benchmark failed (code \((error as NSError).code)); expected a JSON array of 1–20 PNG paths.\n".utf8))
    exit(1)
}
