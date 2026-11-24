import CoreGraphics
import Evidence
import Vision

enum VisionRecognizer {
    static let maximumCore = (width: 1280, height: 800)
    static let margin = 64

    static func tiles(width: Int, height: Int) -> [Tile] {
        let columns = max(1, (width + maximumCore.width - 1) / maximumCore.width)
        let rows = max(1, (height + maximumCore.height - 1) / maximumCore.height)
        return (0..<rows).flatMap { row in
            (0..<columns).map { column in
                let core = CGRect(x: column * width / columns, y: row * height / rows,
                                  width: (column + 1) * width / columns - column * width / columns,
                                  height: (row + 1) * height / rows - row * height / rows)
                let crop = core.insetBy(dx: -CGFloat(margin), dy: -CGFloat(margin))
                    .intersection(CGRect(x: 0, y: 0, width: width, height: height))
                return Tile(crop: crop, core: core, width: CGFloat(width), height: CGFloat(height))
            }
        }
    }

    static func read(_ image: CGImage, _ tile: Tile) -> [Evidence.TextObservation]? {
        guard let crop = tile.crop == tile.core ? image : image.cropping(to: tile.crop) else { return nil }
        return recognizeCrop(crop, tile)
    }

    static func recognizeCrop(_ crop: CGImage, _ tile: Tile) -> [Evidence.TextObservation]? {
        request(crop)?.flatMap(tile.keep)
    }

    private static func request(_ image: CGImage) -> [VNRecognizedTextObservation]? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            return request.results ?? []
        } catch {
            return nil
        }
    }

    static func readingOrder(_ observations: [Evidence.TextObservation]) -> [Evidence.TextObservation] {
        let sorted = observations.sorted { $0.bounds.y + $0.bounds.height / 2 > $1.bounds.y + $1.bounds.height / 2 }
        var ordered: [Evidence.TextObservation] = []
        var line: [Evidence.TextObservation] = []
        for observation in sorted {
            if let first = line.first {
                let tolerance = min(first.bounds.height, observation.bounds.height) / 2
                let gap = (first.bounds.y + first.bounds.height / 2) - (observation.bounds.y + observation.bounds.height / 2)
                if gap > tolerance {
                    ordered += line.sorted { $0.bounds.x < $1.bounds.x }
                    line = []
                }
            }
            line.append(observation)
        }
        return ordered + line.sorted { $0.bounds.x < $1.bounds.x }
    }
}

struct Tile: Sendable {
    let crop: CGRect
    let core: CGRect
    let width: CGFloat
    let height: CGFloat

    func whole(_ box: CGRect) -> CGRect {
        CGRect(x: (crop.minX + box.minX * crop.width) / width,
               y: (height - crop.maxY + box.minY * crop.height) / height,
               width: box.width * crop.width / width, height: box.height * crop.height / height)
    }

    func holds(_ box: CGRect) -> Bool {
        let x = box.midX * width, y = (1 - box.midY) * height
        return x >= core.minX && x < core.maxX && y >= core.minY && y < core.maxY
    }

    func keep(_ result: VNRecognizedTextObservation) -> [Evidence.TextObservation] {
        guard let candidate = result.topCandidates(1).first else { return [] }
        let line = whole(result.boundingBox)
        func observation(_ text: Substring, _ box: CGRect) -> Evidence.TextObservation {
            Evidence.TextObservation(text: String(text), confidence: candidate.confidence, bounds: CaptureRect(box))
        }
        let inside = core.insetBy(dx: 0.5, dy: 0.5)
        let pixels = CGRect(x: line.minX * width, y: (1 - line.maxY) * height,
                            width: line.width * width, height: line.height * height)
        if inside.contains(pixels) || crop == core { return [observation(candidate.string[...], line)] }
        guard pixels.intersects(core) else { return [] }
        let text = candidate.string
        var words: [(range: Range<String.Index>, box: CGRect)] = []
        var start: String.Index?
        for index in text.indices {
            if text[index].isWhitespace {
                if let begun = start { words.append((begun..<index, .null)) }
                start = nil
            } else if start == nil {
                start = index
            }
        }
        if let begun = start { words.append((begun..<text.endIndex, .null)) }
        for index in words.indices {
            guard let box = try? candidate.boundingBox(for: words[index].range)?.boundingBox else {
                return holds(line) ? [observation(text[...], line)] : []
            }
            words[index].box = whole(box)
        }
        var pieces: [Evidence.TextObservation] = []
        var run: [(range: Range<String.Index>, box: CGRect)] = []
        func close() {
            guard let first = run.first, let last = run.last else { return }
            pieces.append(observation(text[first.range.lowerBound..<last.range.upperBound],
                                      run.map(\.box).reduce(CGRect.null) { $0.union($1) }))
            run = []
        }
        for word in words {
            if holds(word.box) { run.append(word) } else { close() }
        }
        close()
        return pieces
    }
}
