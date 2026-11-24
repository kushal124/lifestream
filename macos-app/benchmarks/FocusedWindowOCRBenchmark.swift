import Foundation
import CoreGraphics
import ImageIO
import Vision
import Darwin
private func failure(_ code: Int) -> NSError { NSError(domain:"FocusedWindowDiagnostic",code:code) }
private struct Manifest: Decodable { let scenarios: [String:Truth] }
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
    init() { var t = timespec(); clock_gettime(CLOCK_PROCESS_CPUTIME_ID,&t); cpu = Double(t.tv_sec)+Double(t.tv_nsec)/1e9 }
    func elapsed() -> [String:Double] { let end = Clock(); return ["cpuSeconds":end.cpu-cpu,"wallSeconds":end.wall-wall] }
}
private func recognize(_ image: CGImage) throws -> [String] {
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage:image,orientation:.up).perform([request])
    guard let results = request.results else { throw failure(1) }
    return results.compactMap { $0.topCandidates(1).first?.string }
}
private func decode(_ path: String) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0,
              [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    else { throw failure(1) }
    return image
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

private struct Region {
    let rect: CGRect?
    let reason: String
    let clipped: Bool
}
private func region(_ row: [String:Any], image: CGImage) -> Region {
    func fail(_ reason: String) -> Region { Region(rect:nil,reason:reason,clipped:false) }
    guard let evidence = row["cropEvidence"] as? [String:Any] else { return fail("missing-independent-window-evidence") }
    guard evidence["source"] as? String == "ax-focused-window-matched-cg-window",
          evidence["coordinateSpace"] as? String == "display-native-top-left-pixels",
          evidence["axFocused"] as? Bool == true else { return fail("unsupported-or-unfocused-window-evidence") }
    func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue > 0, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue <= Double(Int32.max) else { return nil }
        return number.intValue
    }
    guard let focused = integer(evidence["focusedPID"]), integer(evidence["axPID"]) == focused,
          integer(evidence["cgPID"]) == focused, integer(evidence["cgWindowID"]) != nil else { return fail("window-focus-process-witness-mismatch") }
    guard let bounds = row["cropBounds"] as? [String:Any] else { return fail("missing-pixel-bounds") }
    let numbers = ["x","y","width","height"].compactMap { key -> Double? in
        guard let n = bounds[key] as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }
    guard numbers.count == 4,numbers[2]>0,numbers[3]>0, numbers.allSatisfy({ abs($0)<1000000 }) else { return fail("invalid-pixel-bounds") }
    let full = CGRect(x:0,y:0,width:image.width,height:image.height)
    let requested = CGRect(x:numbers[0],y:numbers[1],width:numbers[2],height:numbers[3]).integral
    let clipped = requested.intersection(full)
    guard !clipped.isEmpty,!clipped.isNull else { return fail("window-outside-captured-display") }
    return Region(rect:clipped,reason:"independent-focused-window",clipped:!full.contains(requested))
}
private struct Measurement {
    let lines: [String]?
    let status: String
    let error: String?
    let timing: [String:Double]
    let cropTime: [String:Double]
    let ocrTime: [String:Double]
    let width: Int
    let height: Int
}
@main struct FocusedWindowOCRBenchmark {
    static func main() {
        do { try run() } catch { print("{\"error\":\"invalid-diagnostic-input-or-output\"}"); exit(1) }
    }
    static func run() throws {
        guard CommandLine.arguments.count == 3 else { throw failure(2) }
        guard let inputs = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as? [[String:Any]],
              !inputs.isEmpty,inputs.count <= 40 else { throw failure(3) }
        let manifest = try JSONDecoder().decode(Manifest.self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2])))
        guard manifest.scenarios.values.allSatisfy({ !$0.scenarioContentTokens.isEmpty && !$0.expectedPhrases.isEmpty }) else { throw failure(4) }
        var output: [[String:Any]] = [], warmed = false
        for (index,input) in inputs.enumerated() {
            autoreleasepool {
                guard let path = input["path"] as? String,let phase = input["phase"] as? String,let truth = manifest.scenarios[phase] else {
                    output.append(["sample":index,"error":"missing-image-path-or-declared-phase"]); return
                }
                let decodeStart = Clock()
                guard let image = try? decode(path) else { output.append(["sample":index,"phase":phase,"error":"decode-failed"]); return }
                let decodeTime = decodeStart.elapsed()
                if !warmed { _ = try? recognize(image); warmed = true }
                let planning = Clock(), chosen = region(input,image:image), planningTime = planning.elapsed()
                var variants: [String:Measurement] = [:]
                let order = index%2 == 0 ? ["full","focused-window"] : ["focused-window","full"]
                for mode in order {
                    let total = Clock(), cropStart = Clock()
                    var status = "full-frame", target = image
                    if mode == "focused-window" {
                        status = "full-fallback-"+chosen.reason
                        if let rect = chosen.rect {
                            if let cropped = image.cropping(to:rect) { target = cropped; status = "focused-window-crop" }
                            else { status = "full-fallback-crop-failed" }
                        }
                    }
                    let cropTime = cropStart.elapsed(), ocrStart = Clock()
                    let text = try? recognize(target)
                    let ocrTime = ocrStart.elapsed(); var totalTime = total.elapsed()
                    if mode == "focused-window" {
                        for key in ["cpuSeconds","wallSeconds"] { totalTime[key]! += planningTime[key]! }
                    }
                    variants[mode] = Measurement(lines:text,status:status,error:text == nil ? "recognition-failed" : nil,
                        timing:totalTime,cropTime:cropTime,ocrTime:ocrTime,width:target.width,height:target.height)
                }
                let forbidden = manifest.scenarios.values.map(\.marker).filter { $0 != truth.marker } + ["OMEGA999","THETA888"]
                for mode in ["full","focused-window"] {
                    let result = variants[mode]!
                    var row: [String:Any] = ["sample":index,"phase":phase,"mode":mode,"status":result.status,
                        "width":result.width,"height":result.height,"nativeWidth":image.width,"nativeHeight":image.height,
                        "decodeTime":decodeTime,"windowPlanningTime":planningTime,"cropTime":result.cropTime,
                        "ocrTime":result.ocrTime,"totalTimeIncludingCropAndPlanning":result.timing,
                        "windowClippedAtDisplayEdge":chosen.clipped,"boundsEvidence":chosen.reason]
                    if let lines = result.lines {
                        row["groundTruth"] = quality(lines,truth:truth,forbidden:forbidden)
                        if let full = variants["full"]?.lines {
                            row["fullReferenceLineMultisetEqual"] = bag(lines)==bag(full)
                            row["fullReferenceTokenMultisetRecall"] = recall(words(full.joined(separator:"\n")),words(lines.joined(separator:"\n")))
                        }
                    } else { row["error"] = result.error ?? "recognition-failed" }
                    output.append(row)
                }
            }
        }
        let report: [String:Any] = ["measurements":output,"limitations":[
            "Focused crop bounds are external AX-focused-window and matching CG-window witnesses in native top-left pixel coordinates; expected text never chooses the crop.",
            "Witness fields are consistency-checked, not authenticated: root must derive them from actual saved metadata, matching capture time, display scale, origin, focus and window identity.",
            "Missing, invalid, mismatched or outside-display bounds use actual full OCR and report why. Partly offscreen windows are clipped to visible image intersection and labeled.",
            "CPU includes actual crop and window-planning cost for the crop candidate; source PNG decode separate. Prior metadata acquisition cost is not measured.",
            "One repetition per image, alternating order, excluded warmup. No whole-recorder cost or production promotion claim.",
            "Full-image OCR is comparison reference, not truth. Fixed manifest scores marker, identifiers and phrases; background text is intentionally outside focused-window scope.",
            "All source images remain unchanged. No raw recognized text, paths, process IDs or window IDs appear in report."]]
        print(String(decoding:try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self))
    }
}
