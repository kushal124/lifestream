import Foundation
import CoreGraphics
import ImageIO
import Vision

let bytes = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fatalError("invalid image") }
func recognize(_ image: CGImage) throws -> Set<String> {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return Set((request.results ?? []).flatMap { result -> [String] in
        guard let text = result.topCandidates(1).first?.string else { return [] }
        return text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    })
}
let full = try recognize(image)
var tiles = Set<String>()
var counts: [Int] = []
for y in 0..<2 {
    for x in 0..<2 {
        let left = image.width * x / 2, top = image.height * y / 2
        let right = image.width * (x + 1) / 2, bottom = image.height * (y + 1) / 2
        guard let crop = image.cropping(to: CGRect(x: left, y: top, width: right-left, height: bottom-top)) else { fatalError("crop failed") }
        let result = try recognize(crop); counts.append(result.count); tiles.formUnion(result)
    }
}
let report: [String: Any] = ["fullTokens": full.count, "tileTokens": counts,
    "tileUnionTokens": tiles.count, "fullTokensRetainedByTiles": full.intersection(tiles).count]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]))
