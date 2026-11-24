import CoreGraphics
import Foundation
import Vision

enum Read {
    static let version = "read 1: text revision 3, accurate, as written; faces revision 3"

    struct Request: Decodable {
        let pictures: [Item]

        struct Item: Decodable {
            let path: String
        }
    }

    struct Result: Encodable {
        let reader: String
        let pictures: [Found]
    }

    struct Found: Encodable {
        let status: String
        var reason: String?
        var width: Int?
        var height: Int?
        var lines: [Line]?
        var faces: [Face]?
    }

    struct Line: Encodable {
        let confidence: Double
        let words: [Word]
    }

    struct Word: Encodable {
        let text: String
        let box: [Double]
    }

    struct Face: Encodable {
        let box: [Double]
        let confidence: Double
    }

    static func run(_ request: Request) throws -> Result {
        Result(reader: version, pictures: try request.pictures.map { item in
            let data: Data
            do { data = try Data(contentsOf: URL(fileURLWithPath: item.path)) } catch {
                throw EngineError.failed("cannot read \(item.path): \(error.localizedDescription)")
            }
            switch Picture.oriented(data) {
            case .failure(let unreadable):
                return Found(status: "unreadable", reason: unreadable.reason)
            case .success(let image):
                return try read(image)
            }
        })
    }

    private static func read(_ image: CGImage) throws -> Found {
        let width = Double(image.width), height = Double(image.height)
        func box(_ rect: CGRect) -> [Double] {
            func clip(_ value: Double, _ limit: Double) -> Double { (min(max(value, 0), limit) * 100).rounded() / 100 }
            return [clip(rect.minX * width, width), clip((1 - rect.maxY) * height, height),
                    clip(rect.maxX * width, width), clip((1 - rect.minY) * height, height)]
        }
        let text = VNRecognizeTextRequest()
        text.revision = VNRecognizeTextRequestRevision3
        text.recognitionLevel = .accurate
        text.usesLanguageCorrection = false
        text.automaticallyDetectsLanguage = true
        let faces = VNDetectFaceRectanglesRequest()
        faces.revision = VNDetectFaceRectanglesRequestRevision3
        do {
            try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([text, faces])
        } catch {
            throw EngineError.failed("Vision cannot read the picture now: \(error.localizedDescription)")
        }
        let lines = (text.results ?? []).compactMap { observation -> Line? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let string = candidate.string
            let words = string.split(whereSeparator: \.isWhitespace).map { word in
                let own = try? candidate.boundingBox(for: word.startIndex..<word.endIndex)
                return Word(text: String(word), box: box(own?.boundingBox ?? observation.boundingBox))
            }
            return words.isEmpty ? nil : Line(confidence: rounded(candidate.confidence), words: words)
        }
        return Found(status: "ok", width: image.width, height: image.height, lines: lines,
                     faces: (faces.results ?? []).map { Face(box: box($0.boundingBox), confidence: rounded($0.confidence)) })
    }

    private static func rounded(_ value: Float) -> Double { (Double(value) * 10000).rounded() / 10000 }
}
