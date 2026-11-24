import Foundation
import CoreGraphics
import Vision
import ImageIO

@main struct QualityDiagnostic {
    typealias Text = OCRDiagnostic.TextObservation
    static func recognize(_ image: CGImage) throws -> [Text] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap {
            guard let candidate = $0.topCandidates(1).first else { return nil }
            return Text(text: candidate.string, confidence: candidate.confidence,
                bounds: CaptureRect(x: $0.boundingBox.minX, y: $0.boundingBox.minY,
                    width: $0.boundingBox.width, height: $0.boundingBox.height))
        }
    }
    static func cg(_ r: CaptureRect) -> CGRect { CGRect(x: r.x, y: r.y, width: r.width, height: r.height) }
    static func rect(_ r: CGRect) -> CaptureRect { CaptureRect(x: r.minX, y: r.minY, width: r.width, height: r.height) }
    static func crops(_ changes: [CaptureRect], _ image: CGImage, _ previous: [Text], extra: Double) -> [CaptureRect]? {
        guard let base = OCRRegion.planRegions(changedPixels: changes, width: image.width, height: image.height, previous: previous) else { return nil }
        if extra == 0 { return base }
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        var regions = base.map { cg($0).insetBy(dx: -extra, dy: -extra).integral.intersection(bounds) }
        let old = previous.map { value in
            CGRect(x: value.bounds.x * Double(image.width), y: (1-value.bounds.y-value.bounds.height) * Double(image.height),
                   width: value.bounds.width * Double(image.width), height: value.bounds.height * Double(image.height))
        }
        var change = true
        while change {
            change = false
            for i in regions.indices {
                for box in old where regions[i].intersects(box) {
                    let next = regions[i].union(box.insetBy(dx: -extra, dy: -extra)).integral.intersection(bounds)
                    if next != regions[i] { regions[i] = next; change = true }
                }
            }
            var i = 0
            while i < regions.count {
                var j = i+1
                while j < regions.count {
                    if regions[i].intersects(regions[j]) {
                        let removed = regions.remove(at: j)
                        regions[i] = regions[i].union(removed); change = true
                    } else { j += 1 }
                }
                i += 1
            }
            if regions.reduce(0, { $0+$1.width*$1.height }) > bounds.width*bounds.height*0.5 { return nil }
        }
        return regions.map(rect)
    }
    static func counts(_ values: [Text]) -> [String:Int] { Dictionary(values.map { ($0.text,1) }, uniquingKeysWith: +) }
    static func strings(_ values: [Text]) -> Set<String> { Set(values.flatMap { $0.text.split(whereSeparator: \.isWhitespace).map(String.init) }) }
    static func detail(_ value: Text) -> [String:Any] {
        ["text":value.text,"confidence":value.confidence,"bounds":[value.bounds.x,value.bounds.y,value.bounds.width,value.bounds.height]]
    }
    static func preserveStable(_ values: [Text], previous: [Text], before: CGImage, after: CGImage,
                               regions: [CaptureRect]) -> ([Text],Int) {
        guard before.width == after.width, before.height == after.height,
              let oldData = before.dataProvider?.data, let newData = after.dataProvider?.data,
              CFDataGetLength(oldData) >= before.bytesPerRow * before.height,
              CFDataGetLength(newData) >= after.bytesPerRow * after.height,
              let a = CFDataGetBytePtr(oldData), let b = CFDataGetBytePtr(newData) else { return (values,0) }
        let bounds = CGRect(x:0,y:0,width:after.width,height:after.height)
        func pixels(_ value: Text) -> CGRect {
            CGRect(x:value.bounds.x * Double(after.width),y:(1-value.bounds.y-value.bounds.height) * Double(after.height),
                   width:value.bounds.width * Double(after.width),height:value.bounds.height * Double(after.height))
        }
        var result = values, count = 0, used = Set<Int>()
        for old in previous {
            let oldBox = pixels(old)
            let check = oldBox.insetBy(dx:-4,dy:-4).integral.intersection(bounds)
            guard !check.isNull, !check.isEmpty else { continue }
            var unchanged = true
            for y in Int(check.minY)..<Int(check.maxY) {
                if memcmp(a.advanced(by:y * before.bytesPerRow + Int(check.minX)*4),
                          b.advanced(by:y * after.bytesPerRow + Int(check.minX)*4),Int(check.width)*4) != 0 { unchanged = false; break }
            }
            guard unchanged else { continue }
            let candidates = result.indices.filter { index in
                guard !used.contains(index) else { return false }
                let box = pixels(result[index]), intersection = oldBox.intersection(box)
                guard !intersection.isNull, !intersection.isEmpty else { return false }
                let iou = intersection.width*intersection.height / (oldBox.width*oldBox.height+box.width*box.height-intersection.width*intersection.height)
                let edgeDelta = max(abs(oldBox.minX-box.minX),abs(oldBox.minY-box.minY),abs(oldBox.maxX-box.maxX),abs(oldBox.maxY-box.maxY))
                return iou > 0.8 && edgeDelta <= 2 && regions.contains { cg($0).contains(oldBox) && cg($0).contains(box) }
            }
            guard candidates.count == 1, let index = candidates.first else { continue }
            guard !result.indices.contains(where: { $0 != index && pixels(result[$0]).intersects(oldBox) }) else { continue }
            if result[index] != old { result[index] = old; count += 1 }
            used.insert(index)
        }
        return (result,count)
    }
    static func main() throws {
        var rows: [[String:Any]] = []
        var previousImage: CGImage?, previousOCR: [Text] = []
        for (index,path) in CommandLine.arguments.dropFirst().prefix(20).enumerated() {
            try autoreleasepool {
                guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath:path) as CFURL,nil),
                      let image = CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary) else { return }
                let full = try recognize(image)
                let fullAgain = try recognize(image)
                defer { previousImage = image; previousOCR = full }
                guard let prior = previousImage, image.bitsPerPixel == 32, image.bitsPerComponent == 8,
                      image.bitmapInfo == prior.bitmapInfo,
                      let a = prior.dataProvider?.data, let b = image.dataProvider?.data else {
                    rows.append(["index":index,"status":"first-or-incompatible","repeatFullEqual":counts(full)==counts(fullAgain)]); return
                }
                let old = PixelBuffer(width:prior.width,height:prior.height,bytesPerRow:prior.bytesPerRow,bytesPerPixel:4,data:a as Data)
                let current = PixelBuffer(width:image.width,height:image.height,bytesPerRow:image.bytesPerRow,bytesPerPixel:4,data:b as Data)
                guard case .changed(let changes) = old.changedRegions(to:current) else {
                    rows.append(["index":index,"status":"unchanged-or-incompatible","repeatFullEqual":counts(full)==counts(fullAgain)]); return
                }
                for padding in [0.0,32.0,96.0,192.0] {
                    guard let regions = crops(changes,image,previousOCR,extra:padding) else {
                        rows.append(["index":index,"extraPadding":padding,"status":"full-fallback"]); continue
                    }
                    var recognized: [(crop:CaptureRect,observations:[Text])] = []
                    for region in regions {
                        guard let crop = image.cropping(to:cg(region)) else { continue }
                        recognized.append((crop:region,observations:try recognize(crop)))
                    }
                    let unprotected = OCRRegion.merge(previous:previousOCR,regions:recognized,width:image.width,height:image.height)
                    let protected = preserveStable(unprotected,previous:previousOCR,before:prior,after:image,regions:regions)
                    for (variant,merged,protectedCount) in [("context-only",unprotected,0),("stable-line-protected",protected.0,protected.1)] {
                    let reference = strings(full), observed = strings(merged)
                    let fullCounts = counts(full), mergedCounts = counts(merged)
                    rows.append(["index":index,"extraPadding":padding,"variant":variant,"protectedLines":protectedCount,"status":"differential","regions":regions.map { [$0.x,$0.y,$0.width,$0.height] },
                        "regionAreaRatio":regions.reduce(0,{$0+$1.width*$1.height})/Double(image.width*image.height),
                        "referenceTokens":reference.count,"observedTokens":observed.count,"commonTokens":reference.intersection(observed).count,
                        "textMultisetEqual":fullCounts==mergedCounts,"repeatFullEqual":fullCounts==counts(fullAgain),
                        "missingTokens":Array(reference.subtracting(observed)).sorted(),"extraTokens":Array(observed.subtracting(reference)).sorted(),
                        "missingOrChangedLines":full.filter { fullCounts[$0.text] != mergedCounts[$0.text] }.map(detail),
                        "extraOrChangedLines":merged.filter { fullCounts[$0.text] != mergedCounts[$0.text] }.map(detail)])
                    }
                }
            }
        }
        let request = VNRecognizeTextRequest()
        let result = try JSONSerialization.data(withJSONObject:["minimumTextHeight":request.minimumTextHeight,"revision":request.revision,"samples":rows],options:[.prettyPrinted,.sortedKeys])
        FileHandle.standardOutput.write(result)
    }
}
