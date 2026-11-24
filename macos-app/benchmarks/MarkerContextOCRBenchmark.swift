import Foundation
import CoreGraphics
import ImageIO
import Vision
import Darwin

private struct Frame: Decodable { let path: String; let phase: String }
private struct Truth: Decodable { let marker: String }
private struct Manifest: Decodable { let scenarios: [String:Truth] }
private struct Stamp {
    let wall = ProcessInfo.processInfo.systemUptime
    let cpu: Double
    init() { var t = timespec(); clock_gettime(CLOCK_PROCESS_CPUTIME_ID,&t); cpu = Double(t.tv_sec)+Double(t.tv_nsec)/1e9 }
    func elapsed() -> [String:Double] { let end = Stamp(); return ["cpuSeconds":end.cpu-cpu,"wallSeconds":end.wall-wall] }
}
private func words(_ text: String) -> [String] { text.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty } }
private func prefix(_ text: String, marker: String) -> Int {
    words(text).map { zip(Array($0.uppercased()),Array(marker.uppercased())).prefix { $0.0 == $0.1 }.count }.max() ?? 0
}
private func recognize(_ image: CGImage, coast: Bool) throws -> [VNRecognizedTextObservation] {
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
    request.usesLanguageCorrection = coast
    if coast {
        request.revision = VNRecognizeTextRequestRevision3; request.recognitionLanguages = ["en-US"]
        request.minimumTextHeight = 0.015; request.automaticallyDetectsLanguage = false
    }
    try VNImageRequestHandler(cgImage:image,orientation:.up).perform([request])
    guard let result = request.results else { throw NSError(domain:"MarkerDiagnostic",code:1) }
    return result
}
private func metrics(_ observations: [VNRecognizedTextObservation], marker: String, otherMarkers: [String]) -> [String:Any] {
    let all = observations.flatMap { $0.topCandidates(5) }, first = observations.compactMap { $0.topCandidates(1).first }
    let best = first.max { prefix($0.string,marker:marker) < prefix($1.string,marker:marker) }
    let observed = first.flatMap { words($0.string) }
    return ["top1ExactMarkerPresent":observed.contains(marker),
        "top5ContainsExpectedMarker":all.contains { words($0.string).contains(marker) },
        "top1BestPrefixLength":best.map { prefix($0.string,marker:marker) } ?? 0,
        "top1BestPrefixConfidence":best.map { $0.confidence as Any } ?? NSNull(),
        "recognizedLineCount":first.count,
        "otherDeclaredMarkerOccurrences":otherMarkers.reduce(0) { count, token in count+observed.filter { $0 == token }.count }]
}
@main struct MarkerContextOCRBenchmark {
    static func main() {
        do { try run() } catch { print("{\"error\":\"diagnostic-failed\"}"); exit(1) }
    }
    static func run() throws {
        guard CommandLine.arguments.count == 3 else { throw NSError(domain:"MarkerDiagnostic",code:2) }
        let frames = try JSONDecoder().decode([Frame].self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))
        let manifest = try JSONDecoder().decode(Manifest.self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2])))
        guard !frames.isEmpty,frames.count <= 20,frames.allSatisfy({ manifest.scenarios[$0.phase] != nil }) else { throw NSError(domain:"MarkerDiagnostic",code:3) }
        var output: [[String:Any]] = [], warmed = false
        for (index,frame) in frames.enumerated() {
            autoreleasepool {
                guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath:frame.path) as CFURL,nil),
                      let image = CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary) else {
                    output.append(["sample":index,"phase":frame.phase,"error":"decode-failed"]); return
                }
                if !warmed { _ = try? recognize(image,coast:false); _ = try? recognize(image,coast:true); warmed = true }
                let marker = manifest.scenarios[frame.phase]!.marker
                let other = manifest.scenarios.values.map(\.marker).filter { $0 != marker }
                let selectorStart = Stamp()
                guard let selection = try? recognize(image,coast:false) else {
                    output.append(["sample":index,"phase":frame.phase,"error":"selector-full-OCR-failed"]); return
                }
                let selectorTime = selectorStart.elapsed()
                let scored = selection.compactMap { observation -> (VNRecognizedTextObservation,Int)? in
                    guard let top = observation.topCandidates(1).first else { return nil }
                    return (observation,prefix(top.string,marker:marker))
                }.sorted { $0.1 > $1.1 }
                let best = scored.first
                let tied = best.map { value in scored.filter { $0.1 == value.1 }.count } ?? 0
                let bounds = best?.0.boundingBox
                let usable = bounds.map { b in [b.minX,b.minY,b.width,b.height].allSatisfy(\.isFinite) && b.width>0 && b.height>0 && b.minX>=0 && b.minY>=0 && b.maxX<=1 && b.maxY<=1 } ?? false
                let configurations = [(0,false),(20,false),(96,false),(0,true),(20,true),(96,true)]
                for offset in configurations.indices {
                    let (padding,coast) = configurations[(offset+index)%configurations.count]
                    var row: [String:Any] = ["sample":index,"phase":frame.phase,"padding":padding,
                        "context":padding == 0 ? "whole-frame" : "oracle-selected-line-crop",
                        "policy":coast ? "coast-observed" : "default-no-correction",
                        "selectorTime":selectorTime,"selectorPrefixLength":best?.1 ?? 0,
                        "selectorBestPrefixTieCount":tied,"nativeWidth":image.width,"nativeHeight":image.height]
                    let start = Stamp()
                    let input: CGImage
                    if padding == 0 { input = image }
                    else {
                        guard usable,let b = bounds,(best?.1 ?? 0)>0,tied == 1 else {
                            row["error"] = "selector-absent-ambiguous-or-invalid"; output.append(row); continue
                        }
                        let full = CGRect(x:0,y:0,width:image.width,height:image.height)
                        let pixelBox = CGRect(x:b.minX*Double(image.width),y:(1-b.minY-b.height)*Double(image.height),
                                              width:b.width*Double(image.width),height:b.height*Double(image.height))
                        let expanded = pixelBox.insetBy(dx:-CGFloat(padding),dy:-CGFloat(padding)).integral
                        let crop = expanded.intersection(full)
                        guard let cropped = image.cropping(to:crop) else { row["error"] = "crop-failed"; output.append(row); continue }
                        input = cropped; row["contextClippedAtImageEdge"] = !full.contains(expanded)
                    }
                    do {
                        let recognized = try recognize(input,coast:coast)
                        let timing = start.elapsed()
                        row["quality"] = metrics(recognized,marker:marker,otherMarkers:other)
                        row["operationTimeIncludingCrop"] = timing
                        row["pipelineTimeIncludingSelector"] = ["cpuSeconds":timing["cpuSeconds"]!+selectorTime["cpuSeconds"]!,
                            "wallSeconds":timing["wallSeconds"]!+selectorTime["wallSeconds"]!]
                        row["width"] = input.width; row["height"] = input.height
                    } catch { row["error"] = "recognition-failed" }
                    output.append(row)
                }
            }
        }
        let result: [String:Any] = ["measurements":output,"limitations":[
            "Explicit oracle-assisted diagnostic box selection uses declared expected marker prefix, not a deployable inference rule.",
            "Selector runs full native OCR first; its CPU is separately reported and included in pipeline time. Whole-frame rerun also reports this cost, not an optimized production baseline.",
            "One representative per phase, one repetition, rotated operation order. No confidence intervals or general policy claim.",
            "Top-five marker presence and prefix confidence expose no recognized strings. Confidence is not proof of correct text.",
            "Crop quality scores the declared marker only: other expected scene phrases are intentionally outside these crops.",
            "Images are read-only, no archived pixels altered. A crop improvement does not establish why Coast produced its different result."]]
        print(String(decoding:try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self))
    }
}
