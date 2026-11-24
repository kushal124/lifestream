import Foundation
import CoreGraphics
import ImageIO
import Vision
import Darwin
private func failure(_ code: Int) -> NSError { NSError(domain: "FixtureOCRScale", code: code) }
private struct Input: Decodable { let path: String; let phase: String }
private struct Manifest: Decodable { let scenarios: [String: Truth] }
private struct Truth: Decodable {
    let marker: String
    let scenarioContentTokens: [String]
    let expectedTokenOccurrences: [String]
    let requiredNumericIdentifierOccurrences: [String]
    let expectedPhrases: [String]
}
private struct Clock {
    let wall = ProcessInfo.processInfo.systemUptime
    let cpu: Double
    init() { var time = timespec(); clock_gettime(CLOCK_PROCESS_CPUTIME_ID,&time); cpu = Double(time.tv_sec)+Double(time.tv_nsec)/1e9 }
    func elapsed() -> [String:Double] { let end = Clock(); return ["cpuSeconds":end.cpu-cpu,"wallSeconds":end.wall-wall] }
}
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

private func recognize(_ image: CGImage, coastPolicy: Bool = false, fastPolicy: Bool = false, marker: String = "") throws -> (lines: [String], diagnostics: [String:Any]) {
    let request = VNRecognizeTextRequest(); request.recognitionLevel = fastPolicy ? .fast : .accurate
    request.usesLanguageCorrection = coastPolicy
    if coastPolicy {
        request.revision = VNRecognizeTextRequestRevision3
        request.recognitionLanguages = ["en-US"]
        request.minimumTextHeight = 0.015
        request.automaticallyDetectsLanguage = false
    }
    try VNImageRequestHandler(cgImage: image,orientation: .up).perform([request])
    guard let results = request.results else { throw failure(7) }
    let candidates = results.map { $0.topCandidates(5) }
    let first = candidates.compactMap(\.first)
    let expected = Array(marker.uppercased())
    var bestPrefix = 0, bestConfidence: Float?
    for candidate in first {
        for token in words(candidate.string) {
            let count = zip(expected,Array(token.uppercased())).prefix { $0.0 == $0.1 }.count
            if count > bestPrefix { bestPrefix = count; bestConfidence = candidate.confidence }
        }
    }
    let confidences = first.map(\.confidence)
    return (first.map(\.string), [
        "top5ContainsExpectedMarker": !marker.isEmpty && candidates.flatMap { $0 }.contains { words($0.string).contains(marker) },
        "top1MarkerPrefixLength": bestPrefix,
        "top1BestMarkerPrefixConfidence": bestConfidence.map { $0 as Any } ?? NSNull(),
        "top1MinimumConfidence": confidences.min().map { $0 as Any } ?? NSNull(),
        "top1MeanConfidence": confidences.isEmpty ? NSNull() : (confidences.reduce(0,+)/Float(confidences.count)) as Any,
        "recognitionLevel": fastPolicy ? "fast" : "accurate", "requestRevision": request.revision, "requestLanguages": request.recognitionLanguages,
        "minimumTextHeight": request.minimumTextHeight, "usesLanguageCorrection": request.usesLanguageCorrection,
        "automaticallyDetectsLanguage": request.automaticallyDetectsLanguage])
}
private func words(_ text: String) -> [String] {
    text.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
}
private func bag(_ words: [String]) -> [String:Int] { Dictionary(words.map { ($0,1) },uniquingKeysWith:+) }
private func recall(_ expected: [String], _ observed: [String]) -> Double {
    let wanted = bag(expected), actual = bag(observed)
    return expected.isEmpty ? 1 : Double(wanted.reduce(0) { $0+min($1.value,actual[$1.key,default:0]) })/Double(expected.count)
}
private func normalized(_ text: String) -> String { text.split(whereSeparator: \.isWhitespace).joined(separator:" ") }
private func quality(_ lines: [String], truth: Truth, forbidden: [String]) -> [String:Any] {
    let text = lines.joined(separator:"\n"), observed = words(text), normalizedText = normalized(text)
    let lower = observed.map { $0.lowercased() }
    let expectedSet = Set(truth.scenarioContentTokens)
    var result: [String:Any] = [
        "markerExactCasePresent": observed.contains(truth.marker),
        "markerCaseInsensitivePresent": lower.contains(truth.marker.lowercased()),
        "expectedTokenSetRecall": Double(expectedSet.intersection(Set(lower)).count)/Double(expectedSet.count),
        "forbiddenSyntheticTokenOccurrences": forbidden.reduce(into:[String:Int]()) { values, token in
            let count = lower.filter { $0 == token.lowercased() }.count
            if count > 0 { values[token] = count }
        }]
    for sensitive in [true,false] {
        let suffix = sensitive ? "CaseSensitive" : "CaseInsensitive"
        let transform: (String)->String = sensitive ? { $0 } : { $0.lowercased() }
        result["expectedTokenMultisetRecall"+suffix] = recall(truth.expectedTokenOccurrences.map(transform),observed.map(transform))
        result["numericIdentifierMultisetRecall"+suffix] = recall(truth.requiredNumericIdentifierOccurrences.map(transform),observed.map(transform))
        let found = truth.expectedPhrases.filter { transform(normalizedText).contains(transform(normalized($0))) }.count
        result["phraseContainmentRecall"+suffix] = Double(found)/Double(truth.expectedPhrases.count)
    }
    return result
}
private struct Measurement {
    let lines: [String]
    let diagnostics: [String:Any]
    let width: Int
    let height: Int
    let scale: [String:Double]
    let ocr: [String:Double]
    let total: [String:Double]
    let colorSpacePreserved: Bool
    let order: Int
}
@main struct FixtureOCRScaleBenchmark {
    static func main() {
        do { try run() }
        catch { print("{\"error\":\"diagnostic-input-or-output-failed\"}"); exit(1) }
    }
    static func run() throws {
        let arguments = CommandLine.arguments.filter { $0 != "--coast-policy" && $0 != "--fast-policy" }
        let coastMode = CommandLine.arguments.contains("--coast-policy")
        let fastMode = CommandLine.arguments.contains("--fast-policy")
        guard !(coastMode && fastMode) else { throw failure(8) }
        guard (3...4).contains(arguments.count) else { throw failure(5) }
        let inputs = try JSONDecoder().decode([Input].self,from:Data(contentsOf:URL(fileURLWithPath:arguments[1])))
        let manifest = try JSONDecoder().decode(Manifest.self,from:Data(contentsOf:URL(fileURLWithPath:arguments[2])))
        let repetitions = arguments.count == 4 ? Int(arguments[3]) ?? 0 : 1
        guard !inputs.isEmpty,inputs.count <= 20,(1...3).contains(repetitions),
              inputs.allSatisfy({ manifest.scenarios[$0.phase] != nil }),
              manifest.scenarios.values.allSatisfy({ !$0.scenarioContentTokens.isEmpty && !$0.expectedPhrases.isEmpty }) else { throw failure(6) }
        var rows: [[String:Any]] = [], warmed = false
        for (index,input) in inputs.enumerated() {
            for repetition in 0..<repetitions {
                autoreleasepool {
                    let decodeStart = Clock()
                    guard let original = try? decode(input.path) else {
                        rows.append(["sample":index,"phase":input.phase,"repetition":repetition,"error":"image-decode-failed"]); return
                    }
                    let decoded = decodeStart.elapsed()
                    if !warmed {
                        _ = try? recognize(original)
                        if coastMode { _ = try? recognize(original,coastPolicy:true) }
                        if fastMode { _ = try? recognize(original,fastPolicy:true) }
                        warmed = true
                    }
                    var measurements: [Int:Measurement] = [:], errors: [Int:String] = [:]
                    let configurations: [(height:Int,coast:Bool,fast:Bool)] = coastMode
                        ? [(0,false,false),(1440,false,false),(0,true,false),(1440,true,false)]
                        : fastMode ? [(0,false,false),(1440,false,false),(0,false,true),(1440,false,true)]
                        : [(0,false,false),(1440,false,false),(1600,false,false)]
                    for step in configurations.indices {
                        let key = (step+index+repetition)%configurations.count
                        let configuration = configurations[key], height = configuration.height
                        do {
                            let total = Clock(), scaleStart = Clock()
                            let scaled = try (height == 0 ? original : downsample(original,height:height))
                            let scaling = scaleStart.elapsed(), ocrStart = Clock()
                            let recognized = try recognize(scaled,coastPolicy:configuration.coast,fastPolicy:configuration.fast,marker:manifest.scenarios[input.phase]!.marker)
                            let ocrTime = ocrStart.elapsed(), totalTime = total.elapsed()
                            measurements[key] = Measurement(lines:recognized.lines,diagnostics:recognized.diagnostics,width:scaled.width,height:scaled.height,
                                scale:scaling,ocr:ocrTime,total:totalTime,
                                colorSpacePreserved:original.colorSpace != nil && scaled.colorSpace != nil && CFEqual(original.colorSpace!,scaled.colorSpace!),order:step)
                        } catch { errors[key] = "scale-or-recognition-failed" }
                    }
                    let truth = manifest.scenarios[input.phase]!
                    let forbidden = manifest.scenarios.values.map(\.marker).filter { $0 != truth.marker } + ["OMEGA999","THETA888"]
                    for key in configurations.indices {
                        let configuration = configurations[key], height = configuration.height
                        var row: [String:Any] = ["sample":index,"phase":input.phase,"repetition":repetition,"targetHeight":height,"policy":configuration.coast ? "coast-observed" : configuration.fast ? "fast-no-correction" : "default-no-correction","decodedWidth":original.width,"decodedHeight":original.height,"decodeTime":decoded]
                        if let result = measurements[key] {
                            row["width"] = result.width; row["height"] = result.height; row["order"] = result.order
                            row["scaleTime"] = result.scale; row["ocrTime"] = result.ocr; row["totalTimeIncludingScale"] = result.total
                            row["colorSpacePreserved"] = result.colorSpacePreserved
                            row["recognitionDiagnostics"] = result.diagnostics
                            row["groundTruth"] = quality(result.lines,truth:truth,forbidden:forbidden)
                            if let native = measurements[0] {
                                row["nativeReference"] = ["lineMultisetEqual":bag(result.lines)==bag(native.lines),
                                    "caseSensitiveTokenMultisetRecall":recall(words(native.lines.joined(separator:"\n")),words(result.lines.joined(separator:"\n")))]
                            } else { row["nativeReferenceError"] = "native-recognition-failed" }
                        } else { row["error"] = errors[key] ?? "missing-measurement" }
                        rows.append(row)
                    }
                }
            }
        }
        let report: [String:Any] = ["measurements":rows,"recognitionLevel":fastMode ? "per-row" : "accurate","coastPolicyComparison":coastMode,"fastPolicyComparison":fastMode,
            "limitations":["Input phase is supplied independently; marker errors are not reclassified or excluded.",
            "Original PNGs are read only; scaling is for OCR only. No pixel archive is changed.",
            "NativeReference always means native default-no-correction, including for Coast-policy rows. Confidence identifies the top candidate with longest case-insensitive prefix of the expected marker; no candidate text is emitted.",
            "Native OCR is a reference, not ground truth. Synthetic truth comes from the explicit manifest, never recognized output.",
            "CPU and wall include scaling+OCR; PNG decode is separately reported. In-memory warmup excluded, execution order rotated.",
            "Forbidden token output is restricted to other declared phase markers and synthetic offscreen/covered archive identifiers.",
            "Phrase containment normalizes whitespace but preserves case/punctuation in the sensitive metric; page reading order is unmeasured.",
            "Unicode token splitting uses Foundation alphanumerics; this fixture contains ASCII tokens, so existing ASCII fixture recall remains comparable.",
            "Validate fixture foreground, occlusion, independent phase time and input provenance before interpreting results."]]
        print(String(decoding:try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self))
    }
}
