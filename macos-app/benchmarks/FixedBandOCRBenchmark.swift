import Foundation
import CoreGraphics
import ImageIO
import Vision
import Darwin

private enum Failure: Error { case input, image, pixels }
private struct Stamp {
    let wall = ProcessInfo.processInfo.systemUptime
    let cpu: Double
    init() { var t = timespec(); clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &t); cpu = Double(t.tv_sec)+Double(t.tv_nsec)/1e9 }
    func elapsed() -> [String: Double] {
        let end = Stamp(); return ["wallMilliseconds": (end.wall-wall)*1000, "cpuMilliseconds": (end.cpu-cpu)*1000]
    }
}
private struct Line: Equatable { let text: String; let bounds: CGRect }
private struct Band { let core: Range<Int>; let crop: Range<Int> }
private struct Cache { let bytes: Data; let lines: [Line] }
private struct Result { let lines: [Line]; let rejected: Int; let reused: Int; let recognized: Int }
private func recognize(_ image: CGImage) throws -> [Line] {
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { result in
        result.topCandidates(1).first.map { Line(text: $0.string, bounds: result.boundingBox) }
    }
}
private func bands(height: Int, core: Int) -> [Band] {
    stride(from: 0, to: height, by: core).map { start in
        Band(core: start..<min(height,start+core), crop: max(0,start-96)..<min(height,start+core+96))
    }
}
private func activeBytes(_ data: Data, stride: Int, width: Int, rows: Range<Int>) -> Data {
    var output = Data(); output.reserveCapacity(width*4*rows.count)
    for row in rows { output.append(data[(row*stride)..<(row*stride+width*4)]) }
    return output
}
private func bandOCR(_ image: CGImage, bytes: Data, core: Int, cache: inout [Cache]?, useCache: Bool) throws -> Result {
    let regions = bands(height: image.height, core: core)
    var next: [Cache] = [], merged: [Line] = []
    var reused = 0, recognized = 0, rejected = 0
    for (index, band) in regions.enumerated() {
        let pixels = activeBytes(bytes, stride: image.bytesPerRow, width: image.width, rows: band.crop)
        if useCache, let previous = cache, previous.count == regions.count, previous[index].bytes == pixels {
            next.append(previous[index]); merged += previous[index].lines; reused += 1; continue
        }
        guard let crop = image.cropping(to: CGRect(x: 0, y: band.crop.lowerBound, width: image.width, height: band.crop.count)) else { throw Failure.image }
        let lines = try recognize(crop)
        recognized += 1
        var accepted: [Line] = []
        for line in lines {
            let centerFromTop = Double(band.crop.lowerBound) + (1-line.bounds.midY)*Double(band.crop.count)
            guard centerFromTop >= Double(band.core.lowerBound), centerFromTop < Double(band.core.upperBound) else {
                rejected += 1; continue
            }
            let global = CGRect(x: line.bounds.minX,
                y: 1-Double(band.crop.upperBound)/Double(image.height)+line.bounds.minY*Double(band.crop.count)/Double(image.height),
                width: line.bounds.width, height: line.bounds.height*Double(band.crop.count)/Double(image.height))
            accepted.append(Line(text: line.text, bounds: global))
        }
        next.append(Cache(bytes: pixels, lines: accepted)); merged += accepted
    }
    cache = next
    merged.sort { $0.bounds.midY == $1.bounds.midY ? $0.bounds.minX < $1.bounds.minX : $0.bounds.midY > $1.bounds.midY }
    return Result(lines: merged, rejected: rejected, reused: reused, recognized: recognized)
}
private func bag(_ lines: [Line], words: Bool) -> [String: Int] {
    let text = words ? lines.flatMap { $0.text.split(whereSeparator: { $0.isWhitespace }).map(String.init) } : lines.map(\.text)
    return Dictionary(text.map { ($0,1) }, uniquingKeysWith: +)
}
private func quality(_ expected: [Line], _ observed: [Line]) -> [String: Any] {
    let a = bag(expected, words: true), b = bag(observed, words: true)
    let count = a.values.reduce(0,+), overlap = a.reduce(0) { $0+min($1.value,b[$1.key] ?? 0) }
    let al = bag(expected, words: false), bl = bag(observed, words: false)
    return ["referenceTokenOccurrences": count, "observedTokenOccurrences": b.values.reduce(0,+),
        "tokenMultisetRecall": count == 0 ? 1.0 : Double(overlap)/Double(count),
        "tokenMultisetEqual": a == b, "lineMultisetEqual": al == bl,
        "missingOrChangedLineOccurrences": al.reduce(0) { $0+max(0,$1.value-(bl[$1.key] ?? 0)) },
        "extraOrChangedLineOccurrences": bl.reduce(0) { $0+max(0,$1.value-(al[$1.key] ?? 0)) }]
}
private func boundaryDiagnostics(_ full: [Line], _ observed: [Line], height: Int, core: Int) -> [String: Int] {
    let boundaries = Array(stride(from: core, to: height, by: core))
    let expected = full.filter { line in boundaries.contains { abs(Double($0)-(1-line.bounds.midY)*Double(height)) <= 96 } }
    let missing = expected.filter { line in !observed.contains { candidate in
        line.text == candidate.text && abs(line.bounds.midY-candidate.bounds.midY)*Double(height)<24
    }}.count
    var duplicates = 0
    for (index,line) in observed.enumerated() {
        for other in observed.dropFirst(index+1) where line.text == other.text {
            let intersection = line.bounds.intersection(other.bounds)
            let union = line.bounds.width*line.bounds.height+other.bounds.width*other.bounds.height-intersection.width*intersection.height
            if !intersection.isNull, union > 0, intersection.width*intersection.height/union > 0.5 { duplicates += 1 }
        }
    }
    return ["fullReferenceLinesNearBoundary": expected.count, "unmatchedBoundaryReferenceLines": missing,
        "sameTextOverlappingLinePairs": duplicates]
}
@main private enum Benchmark {
    static func main() {
        do { try run() }
        catch { FileHandle.standardError.write(Data("Fixed-band OCR diagnostic failed.\n".utf8)); exit(1) }
    }
    static func run() throws {
        guard (2...3).contains(CommandLine.arguments.count) else { throw Failure.input }
        let limit = CommandLine.arguments.count == 3 ? Int(CommandLine.arguments[2]) ?? 0 : 20
        guard (1...20).contains(limit) else { throw Failure.input }
        let input = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let paths = (try? JSONDecoder().decode([String].self, from: input)) ?? String(decoding: input, as: UTF8.self).split(whereSeparator: \.isNewline).map(String.init)
        guard !paths.isEmpty else { throw Failure.input }
        var caches: [Int: [Cache]] = [:]
        var previousLayout: [Int] = [], previousColor: CGColorSpace?
        var rows: [[String: Any]] = []
        for (index,path) in paths.prefix(limit).enumerated() {
            try autoreleasepool {
                guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
                      image.bitsPerComponent == 8, image.bitsPerPixel == 32, image.decode == nil,
                      image.width*image.height <= 16_000_000,
                      let color = image.colorSpace, color.model == .rgb, let storage = image.dataProvider?.data else { throw Failure.image }
                let data = storage as Data
                guard data.count >= image.bytesPerRow*image.height else { throw Failure.pixels }
                let layout = [image.width,image.height,image.bytesPerRow,Int(image.bitmapInfo.rawValue),Int(image.renderingIntent.rawValue)]
                if layout != previousLayout || previousColor.map({ !CFEqual($0,color) }) != false { caches.removeAll() }
                previousLayout = layout; previousColor = color
                if index == 0 { _ = try recognize(image) }
                let fullStarted = Stamp(); let full = try recognize(image); let fullTime = fullStarted.elapsed()
                for core in index % 2 == 0 ? [512,768] : [768,512] {
                    var cache = caches[core]
                    let started = Stamp(); let optimized = try bandOCR(image, bytes: data, core: core, cache: &cache, useCache: true)
                    let optimizedTime = started.elapsed(); caches[core] = cache
                    var independent: [Cache]?
                    let baselineStarted = Stamp(); let baseline = try bandOCR(image, bytes: data, core: core, cache: &independent, useCache: false)
                    let baselineTime = baselineStarted.elapsed()
                    rows.append(["sample": index, "coreHeight": core, "overlapPixelsEachSide": 96,
                        "width": image.width, "height": image.height, "fullVision": fullTime,
                        "incrementalBands": optimizedTime, "independentFullBands": baselineTime,
                        "recognizedBands": optimized.recognized, "reusedBands": optimized.reused,
                        "overlapCandidatesRejectedThisRun": optimized.rejected,
                        "versusFullVision": quality(full,optimized.lines),
                        "versusIndependentFixedBands": quality(baseline.lines,optimized.lines),
                        "sameFixedBandCoordinatesAndText": baseline.lines == optimized.lines,
                        "boundaryDiagnostics": boundaryDiagnostics(full,optimized.lines,height:image.height,core:core)])
                }
            }
        }
        let report: [String: Any] = ["measurements": rows, "fullWarmupExcluded": true,
            "timingScope": "in-memory OCR; band time includes exact active-byte extraction/comparison and crop mapping; source decoding excluded",
            "limitations": ["Native whole-frame Vision is a comparison reference, not ground truth.",
                "Unmatched boundary reference lines can reflect segmentation or recognition differences, not necessarily missing visible words.",
                "Each independent full-band pass checks the same fixed-context algorithm; cached and recomputed results need not reproduce whole-frame OCR.",
                "No acquisition, AX, image encoding, disk persistence, hardware energy or full-recorder CPU is measured.",
                "Whole-frame baseline precedes band passes; band-height order alternates, but model/cache order effects are not eliminated."]]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted,.sortedKeys]))
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
