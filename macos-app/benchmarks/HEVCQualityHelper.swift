import Evidence
import Spool
import Foundation
import CoreGraphics
import ImageIO
import Vision
import Darwin

private enum Failure: Error { case input, image, dimensions, pixels }
private func image(_ saved: CaptureImage) throws -> CGImage {
    switch saved {
    case .png(let data):
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure.image }
        return image
    case .raw(let frame):
        let l = frame.layout
        guard let space = CGColorSpace(iccData: l.ICCData as CFData),
              let provider = CGDataProvider(data: frame.data as CFData),
              let intent = CGColorRenderingIntent(rawValue: l.renderingIntent),
              let image = CGImage(width: l.width, height: l.height, bitsPerComponent: l.bitsPerComponent,
                  bitsPerPixel: l.bitsPerPixel, bytesPerRow: l.bytesPerRow, space: space,
                  bitmapInfo: CGBitmapInfo(rawValue: l.bitmapInfo), provider: provider,
                  decode: nil, shouldInterpolate: false, intent: intent) else { throw Failure.image }
        return image
    }
}
private func bgra(_ image: CGImage) throws -> Data {
    var bytes = Data(count: image.width * image.height * 4)
    try bytes.withUnsafeMutableBytes { buffer in
        guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)
        else { throw Failure.pixels }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    return bytes
}
private func rawImage(_ bytes: Data, width: Int, height: Int) throws -> CGImage {
    guard bytes.count == width * height * 4,
          let provider = CGDataProvider(data: bytes as CFData),
          let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { throw Failure.pixels }
    return image
}
private func ocr(_ image: CGImage) throws -> [String] {
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}
private func bag(_ words: [String]) -> [String: Int] {
    Dictionary(words.map { ($0, 1) }, uniquingKeysWith: +)
}
private func agreement(_ expected: [String], _ observed: [String]) -> [String: Any] {
    let a = Set(expected.flatMap { $0.split(whereSeparator: { $0.isWhitespace }).map(String.init) })
    let b = Set(observed.flatMap { $0.split(whereSeparator: { $0.isWhitespace }).map(String.init) })
    let common = a.intersection(b).count
    return ["referenceTokens": a.count, "observedTokens": b.count,
        "tokenRecall": a.isEmpty ? 1.0 : Double(common)/Double(a.count),
        "tokenPrecision": b.isEmpty ? (a.isEmpty ? 1.0 : 0.0) : Double(common)/Double(b.count),
        "lineMultisetEqual": bag(expected) == bag(observed)]
}
private func json(_ object: Any, to url: URL? = nil) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    if let url { try data.write(to: url) }
    else { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8)) }
}
@main private enum Diagnostic {
    static func main() {
        do { try run() }
        catch { FileHandle.standardError.write(Data("HEVC quality helper failed.\n".utf8)); exit(1) }
    }
    static func run() throws {
        let args = CommandLine.arguments
        guard args.count >= 2 else { throw Failure.input }
        if args[1] == "baseline" {
            guard args.count == 5, let limit = Int(args[4]), (20...60).contains(limit) else { throw Failure.input }
            let window = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[3]))) as! [String: Any]
            guard let start = window["start"] as? Double, let end = window["end"] as? Double else { throw Failure.input }
            let store = try CaptureStore(directory: URL(fileURLWithPath: args[2]), readOnly: true)
            let all = try store.read(limit: 10000, since: Date(timeIntervalSince1970: start))
            guard all.count < 10000 else { throw Failure.input }
            let available = all.filter { $0.capturedAt.timeIntervalSince1970 < end && $0.imageFile != nil }
            let count = min(limit, available.count)
            guard count >= 20 else { throw Failure.input }

            var totalBytes = 0, encodeCPU = 0.0, decodeCPU = 0.0, exact = 0, keys = 0
            func cpu() -> Double { var time = timespec(); clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &time); return Double(time.tv_sec) + Double(time.tv_nsec)/1e9 }
            for index in 0..<count {
                try autoreleasepool {
                    let originalIndex = Int((Double(index) * Double(available.count-1) / Double(count-1)).rounded())
                    guard case .raw(let frame) = try store.readImage(for: available[originalIndex]) else { throw Failure.input }
                    let started = cpu()
                    let encoded = try FrameCodec.encodePending(frame)
                    encodeCPU += cpu()-started
                    totalBytes += encoded.count
                    keys += 1
                    let decodeStarted = cpu()
                    let restored = try FrameCodec.decode(encoded)
                    decodeCPU += cpu()-decodeStarted
                    guard restored == frame else { throw Failure.pixels }
                    exact += 1
                }
            }
            try json(["frames": count, "exactFrames": exact, "keyFrames": keys, "bytes": totalBytes,
                "encodeCPUSeconds": encodeCPU, "decodeCPUSeconds": decodeCPU,
                "scope": "Actual native lossless FrameCodec, same chronological sampled indexes; source read and verification assertions excluded from codec CPU; no metadata or durability IO"])
        } else if args[1] == "prepare" {
            guard args.count == 6, let limit = Int(args[5]), (20...60).contains(limit) else { throw Failure.input }
            let window = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[3]))) as! [String: Any]
            guard let start = window["start"] as? Double, let end = window["end"] as? Double, start < end else { throw Failure.input }
            let store = try CaptureStore(directory: URL(fileURLWithPath: args[2]), readOnly: true)
            let all = try store.read(limit: 10000, since: Date(timeIntervalSince1970: start))
            guard all.count < 10000 else { throw Failure.input }
            let available = all.filter { $0.capturedAt.timeIntervalSince1970 < end && $0.imageFile != nil }
            let count = min(limit, available.count)
            guard count >= 20 else { throw Failure.input }
            let indexes = (0..<count).map { Int((Double($0) * Double(available.count-1) / Double(count-1)).rounded()) }
            let selected = Set((0..<6).map { Int((Double($0) * Double(count-1) / 5).rounded()) })
            let directory = URL(fileURLWithPath: args[4]); let rawURL = directory.appendingPathComponent("source.bgra")
            _ = FileManager.default.createFile(atPath: rawURL.path, contents: nil)
            let handle = try FileHandle(forWritingTo: rawURL); defer { try? handle.close() }
            var width = 0, height = 0, references: [[String: Any]] = []
            var sourceArtifactBytes = 0
            for (index, originalIndex) in indexes.enumerated() {
                try autoreleasepool {
                    let observation = available[originalIndex]
                    let original = try image(store.readImage(for: observation))
                    if index == 0 { width = original.width; height = original.height }
                    guard width == original.width, height == original.height, width % 2 == 0, height % 2 == 0,
                          width * height <= 16_000_000 else { throw Failure.dimensions }
                    let bytes = try bgra(original)
                    try handle.write(contentsOf: bytes)
                    let attributes = try FileManager.default.attributesOfItem(atPath: store.directory.appendingPathComponent(observation.imageFile!).path)
                    sourceArtifactBytes += (attributes[.size] as? NSNumber)?.intValue ?? 0
                    if selected.contains(index) {
                        let expected = try ocr(original)
                        let converted = try ocr(rawImage(bytes, width: width, height: height))
                        references.append(["index": index, "original": expected, "converted": converted])
                    }
                }
            }
            try json(["width": width, "height": height, "references": references], to: directory.appendingPathComponent("references.json"))
            try json(["width": width, "height": height, "frames": count, "selectedIndexes": references.map { $0["index"]! },
                "availableFrames": available.count, "selectedSourceArtifactBytesExcludingReferenceAncestors": sourceArtifactBytes,
                "preparation": "Read-only store reconstruction; native dimensions; convert to sRGB BGRA8 and composite alpha on white",
                "sampling": "Evenly spaced chronological subset; encoded at 0.5fps, not original wall-time spacing",
                "convertedOCR": references.map { ["index": $0["index"]!, "agreement": agreement($0["original"] as! [String], $0["converted"] as! [String])] }])
        } else if args[1] == "score" {
            guard args.count == 4 else { throw Failure.input }
            let reference = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2]).appendingPathComponent("references.json"))) as! [String: Any]
            let width = reference["width"] as! Int, height = reference["height"] as! Int
            let rows = reference["references"] as! [[String: Any]]
            let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: args[3])); defer { try? handle.close() }
            var output: [[String: Any]] = []
            for row in rows {
                try autoreleasepool {
                    let bytes = try handle.read(upToCount: width * height * 4) ?? Data()
                    let recognized = try ocr(rawImage(bytes, width: width, height: height))
                    output.append(["index": row["index"]!, "versusOriginal": agreement(row["original"] as! [String], recognized),
                        "versusColorConverted": agreement(row["converted"] as! [String], recognized)])
                }
            }
            guard (try handle.read(upToCount: 1) ?? Data()).isEmpty else { throw Failure.dimensions }
            try json(["width": width, "height": height, "samples": output])
        } else { throw Failure.input }
    }
}
