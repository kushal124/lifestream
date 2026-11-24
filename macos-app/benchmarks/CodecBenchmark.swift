import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

func now() -> Double { ProcessInfo.processInfo.systemUptime }
func decode(_ data: Data) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    else { throw NSError(domain: "Decode", code: 1) }
    return image
}
func encode(_ image: CGImage, type: UTType, quality: Double?) throws -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil)
    else { throw NSError(domain: "Encode", code: 1) }
    let properties: CFDictionary? = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary }
    CGImageDestinationAddImage(destination, image, properties)
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "Encode", code: 2) }
    return data as Data
}
func tokens(_ image: CGImage) throws -> Set<String> {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    return Set(text.split(whereSeparator: { $0.isWhitespace }).map(String.init))
}
var measurements: [[String: Any]] = []
for (index, path) in CommandLine.arguments.dropFirst().enumerated() {
    do {
        try autoreleasepool {
            let original = try Data(contentsOf: URL(fileURLWithPath: path))
            let originalStart = now()
            let image = try decode(original)
            let originalDecode = now() - originalStart
            let ocrStart = now()
            let reference = try tokens(image)
            let ocrDuration = now() - ocrStart
            for (name, type, quality) in [("png", UTType.png, nil as Double?), ("heic-0.9", .heic, 0.9), ("heic-0.95", .heic, 0.95), ("heic-1.0", .heic, 1.0)] {
                do {
                    let start = now()
                    let data = try encode(image, type: type, quality: quality)
                    let encodedAt = now()
                    let decoded = try decode(data)
                    let decodedAt = now()
                    let observed = try tokens(decoded)
                    let overlap = reference.intersection(observed).count
                    measurements.append([
                        "sample": index, "codec": name, "originalBytes": original.count,
                        "encodedBytes": data.count, "width": decoded.width, "height": decoded.height,
                        "dimensionsMatch": decoded.width == image.width && decoded.height == image.height,
                        "encodeMilliseconds": (encodedAt-start)*1000, "decodeMilliseconds": (decodedAt-encodedAt)*1000,
                        "originalDecodeMilliseconds": originalDecode*1000, "originalOCRMilliseconds": ocrDuration*1000,
                        "decodedOCRMilliseconds": (now()-decodedAt)*1000,
                        "referenceTokens": reference.count, "decodedTokens": observed.count,
                        "commonTokens": overlap,
                        "tokenRecall": reference.isEmpty ? 1 : Double(overlap)/Double(reference.count),
                        "tokenPrecision": observed.isEmpty ? (reference.isEmpty ? 1.0 : 0.0) : Double(overlap)/Double(observed.count)
                    ])
                } catch { measurements.append(["sample": index, "codec": name, "error": "codec-or-ocr-failed", "errorCode": (error as NSError).code]) }
            }
        }
    } catch { measurements.append(["sample": index, "error": "sample-or-ocr-failed", "errorCode": (error as NSError).code]) }
}
let report = try JSONSerialization.data(withJSONObject: ["measurements": measurements], options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(report)
FileHandle.standardOutput.write(Data("\n".utf8))
