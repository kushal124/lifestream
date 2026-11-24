import Foundation
import CoreGraphics
import ImageIO
import Vision
import Darwin

private struct Input: Decodable { let path: String; let phase: String }
private struct Truth: Decodable { let marker: String; let expectedPhrases: [String] }
private struct Manifest: Decodable { let scenarios: [String:Truth] }
private struct Line { let text: String; let box: CGRect; let index: Int }
private func normalized(_ text: String) -> String { text.split(whereSeparator: \.isWhitespace).joined(separator:" ") }
private func tokens(_ text: String) -> [String] { normalized(text).components(separatedBy:" ").filter { !$0.isEmpty } }
private func bag(_ tokens: [String]) -> [String:Int] { Dictionary(tokens.map { ($0,1) },uniquingKeysWith:+) }
private func containsBag(_ expected: String, in text: String) -> Bool {
    let required = bag(tokens(expected)), observed = bag(tokens(text))
    return required.allSatisfy { observed[$0.key,default:0] >= $0.value }
}
private func valid(_ box: CGRect) -> Bool {
    [box.minX,box.minY,box.width,box.height].allSatisfy(\.isFinite) && box.width>0 && box.height>0 && box.minX>=0 && box.minY>=0 && box.maxX<=1 && box.maxY<=1
}
private func topLeftOrder(_ lines: [Line]) -> [Line] {
    lines.sorted {
        if $0.box.midY != $1.box.midY { return $0.box.midY > $1.box.midY }
        if $0.box.minX != $1.box.minX { return $0.box.minX < $1.box.minX }
        return $0.index < $1.index
    }
}
private func rowOrder(_ lines: [Line]) -> (lines: [Line], rows: Int, multiMemberRows: Int) {
    var groups: [(box:CGRect,lines:[Line])] = []
    for line in topLeftOrder(lines) {
        let candidates = groups.indices.filter { index in
            let box = groups[index].box
            let overlap = min(box.maxY,line.box.maxY)-max(box.minY,line.box.minY)
            return overlap >= min(box.height,line.box.height)*0.5
        }
        if let index = candidates.min(by:{ abs(groups[$0].box.midY-line.box.midY)<abs(groups[$1].box.midY-line.box.midY) }) {
            groups[index].box = groups[index].box.union(line.box); groups[index].lines.append(line)
        } else { groups.append((line.box,[line])) }
    }
    let ordered = groups.sorted { $0.box.midY>$1.box.midY }.flatMap { group in
        group.lines.sorted { $0.box.minX == $1.box.minX ? $0.index<$1.index : $0.box.minX<$1.box.minX }
    }
    return (ordered,groups.count,groups.filter { $0.lines.count>1 }.count)
}
@main struct FastOCRPhraseOrderDiagnostic {
    static func main() {
        do { try run() } catch { print("{\"error\":\"diagnostic-input-or-output-failed\"}"); exit(1) }
    }
    static func run() throws {
        guard CommandLine.arguments.count == 3 else { throw NSError(domain:"PhraseDiagnostic",code:1) }
        let inputs = try JSONDecoder().decode([Input].self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))
        let manifest = try JSONDecoder().decode(Manifest.self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2])))
        guard !inputs.isEmpty,inputs.count<=40,inputs.allSatisfy({ manifest.scenarios[$0.phase] != nil }) else { throw NSError(domain:"PhraseDiagnostic",code:2) }
        var output: [[String:Any]] = []
        for (index,input) in inputs.enumerated() {
            autoreleasepool {
                var row: [String:Any] = ["sample":index,"phase":input.phase]
                guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath:input.path) as CFURL,nil),
                      let image = CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary) else {
                    row["error"] = "decode-failed"; output.append(row); return
                }
                let request = VNRecognizeTextRequest(); request.recognitionLevel = .fast; request.usesLanguageCorrection = false
                do { try VNImageRequestHandler(cgImage:image,orientation:.up).perform([request]) }
                catch { row["error"] = "recognition-failed"; output.append(row); return }
                guard let results = request.results,results.count<=10000 else { row["error"] = "absent-or-overlimit-results"; output.append(row); return }
                let lines = results.enumerated().compactMap { position, observation -> Line? in
                    guard let candidate = observation.topCandidates(1).first else { return nil }
                    return Line(text:candidate.string,box:observation.boundingBox,index:position)
                }
                let geometry = lines.filter { valid($0.box) }, ordered = rowOrder(geometry)
                let raw = normalized(lines.map(\.text).joined(separator:"\n"))
                let top = normalized(topLeftOrder(geometry).map(\.text).joined(separator:"\n"))
                let spatial = normalized(ordered.lines.map(\.text).joined(separator:"\n"))
                let truth = manifest.scenarios[input.phase]!
                var phrases: [[String:Any]] = []
                for expected in truth.expectedPhrases {
                    let phrase = normalized(expected)
                    let rawFound = raw.contains(phrase), topFound = top.contains(phrase), spatialFound = spatial.contains(phrase)
                    let allTokens = containsBag(phrase,in:raw)
                    phrases.append(["expectedPhrase":expected,"rawContains":rawFound,
                        "topCenterOrderContains":topFound,"geometricRowOrderContains":spatialFound,
                        "rawContainsIgnoringCase":raw.lowercased().contains(phrase.lowercased()),
                        "expectedWhitespaceTokenMultisetPresent":allTokens,
                        "expectedWhitespaceTokenMultisetPresentIgnoringCase":containsBag(phrase.lowercased(),in:raw.lowercased()),
                        "containedInOneOriginalObservation":lines.contains { normalized($0.text).contains(phrase) },
                        "diagnosis":rawFound ? "present-in-raw" : spatialFound || topFound ? "recovered-by-geometry-only-order" : allTokens ? "tokens-present-but-phrase-not-recovered" : "token-or-punctuation-recognition-mismatch"])
                }
                row["phraseDiagnostics"] = phrases
                row["rawPhraseRecall"] = Double(phrases.filter { $0["rawContains"] as? Bool == true }.count)/Double(max(1,phrases.count))
                row["geometricRowPhraseRecall"] = Double(phrases.filter { $0["geometricRowOrderContains"] as? Bool == true }.count)/Double(max(1,phrases.count))
                row["topCenterPhraseRecall"] = Double(phrases.filter { $0["topCenterOrderContains"] as? Bool == true }.count)/Double(max(1,phrases.count))
                row["observationCount"] = lines.count; row["invalidGeometryCount"] = lines.count-geometry.count
                row["geometricRows"] = ordered.rows; row["multiObservationRows"] = ordered.multiMemberRows
                row["rowOrderChanged"] = ordered.lines.map(\.index) != geometry.map(\.index)
                row["markerExactInRawTokens"] = tokens(raw).contains(truth.marker)
                output.append(row)
            }
        }
        let report: [String:Any] = ["measurements":output,"limitations":[
            "Expected manifest phrases score outputs only; they do not select regions, reorder observations or modify recognized text.",
            "Geometry alternatives use normalized Vision coordinates: top-center descending and half-height-overlap row grouping then left-to-right.",
            "A recovered phrase indicates segmentation/order contributed, not proof of generally correct page reading order. Multi-column layouts can require different policies.",
            "Token presence is a multiset test across all recognized text; incidental identical words elsewhere may satisfy it. Case and punctuation mismatches are reported separately.",
            "Invalid geometry is counted and excluded from spatial alternatives, retained in raw recognition order. No actual OCR strings emitted.",
            "This diagnostic does not time OCR, merge results into production, or change stored pixels."]]
        print(String(decoding:try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self))
    }
}
