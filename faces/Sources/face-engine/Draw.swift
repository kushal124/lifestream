import CoreGraphics
import CoreText
import Foundation
import ImageIO

enum Draw {
    struct Request: Decodable {
        let images: [Image]

        struct Image: Decodable {
            let path: String
            let output: String
            let faces: [Face]
        }

        struct Face: Decodable {
            let box: [Double]
            let name: String
        }
    }

    struct Result: Encodable {
        let images: [Image]
    }

    struct Image: Encodable {
        let status: String
        var reason: String?
        var width: Int?
        var height: Int?
    }

    static let maxSide = 1536
    static let quality = 0.95
    static let box = CGColor(srgbRed: 24 / 255, green: 214 / 255, blue: 120 / 255, alpha: 1)
    static let label = CGColor(srgbRed: 10 / 255, green: 45 / 255, blue: 30 / 255, alpha: 1)
    static let text = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)

    static func run(_ request: Request) throws -> Result {
        for (index, image) in request.images.enumerated() {
            for face in image.faces where face.box.count != 4 || !face.box.allSatisfy(\.isFinite) || face.name.isEmpty {
                throw EngineError.request("image \(index): every face needs a box of four numbers and a name")
            }
        }
        return Result(images: try request.images.map { image in
            let data: Data
            do { data = try Data(contentsOf: URL(fileURLWithPath: image.path)) } catch {
                throw EngineError.failed("cannot read \(image.path): \(error.localizedDescription)")
            }
            switch draw(data, faces: image.faces) {
            case .failure(let unreadable):
                return Image(status: "unreadable", reason: unreadable.reason)
            case .success(let drawn):
                do { try drawn.jpeg.write(to: URL(fileURLWithPath: image.output), options: .atomic) } catch {
                    throw EngineError.failed("cannot write \(image.output): \(error.localizedDescription)")
                }
                return Image(status: "ok", width: drawn.width, height: drawn.height)
            }
        })
    }

    private static func draw(_ data: Data, faces: [Request.Face]) -> Swift.Result<(jpeg: Data, width: Int, height: Int), Unreadable> {
        sized(data).map { sized in
            let width = sized.image.width, height = sized.image.height
            let jpeg = face_engine.jpeg(sized.image, region: CGRect(x: 0, y: 0, width: width, height: height), width: width,
                                        height: height, quality: quality) { context in
                for face in faces { frame(context, face.box, face.name, scaleX: sized.scaleX, scaleY: sized.scaleY) }
            }
            return (jpeg, width, height)
        }
    }

    static func sized(_ data: Data) -> Swift.Result<(image: CGImage, scaleX: Double, scaleY: Double), Unreadable> {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let size = Picture.orientedSize(source)
        else { return .failure(Unreadable("not an image ImageIO can read")) }
        guard let image = Picture.thumbnail(source, maxSide: min(maxSide, max(size.width, size.height))) else {
            return .failure(Unreadable("ImageIO cannot decode it"))
        }
        return .success((image, Double(image.width) / Double(size.width), Double(image.height) / Double(size.height)))
    }

    static func frame(_ context: CGContext, _ box: [Double], _ words: String, scaleX: Double, scaleY: Double) {
        let width = context.width, height = context.height
        let stroke = CGFloat(max(2, (Double(max(width, height)) / 500).rounded()))
        let font = CTFontCreateWithName("Helvetica" as CFString, CGFloat(max(14, (Double(max(width, height)) / 45).rounded())), nil)
        func flipped(_ rect: CGRect) -> CGRect {
            CGRect(x: rect.minX, y: CGFloat(height) - rect.maxY, width: rect.width, height: rect.height)
        }
        let rect = CGRect(x: box[0] * scaleX, y: box[1] * scaleY,
                          width: (box[2] - box[0]) * scaleX, height: (box[3] - box[1]) * scaleY)
        context.setStrokeColor(Draw.box)
        context.setLineWidth(stroke)
        context.stroke(flipped(rect).insetBy(dx: stroke / 2, dy: stroke / 2))
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: words, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): text,
        ]))
        var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
        let textWidth = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
        let textHeight = ascent + descent
        let left = max(0, min(rect.minX.rounded(), CGFloat(width) - textWidth - 2 * stroke))
        let top = max(0, rect.minY.rounded() - textHeight - 2 * stroke)
        context.setFillColor(label)
        context.fill(flipped(CGRect(x: left, y: top, width: textWidth + 2 * stroke, height: textHeight + 2 * stroke)))
        context.textPosition = CGPoint(x: left + stroke, y: CGFloat(height) - top - stroke - ascent)
        CTLineDraw(line, context)
    }
}
