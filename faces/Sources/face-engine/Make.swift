import CoreGraphics
import CoreText
import Foundation

enum Make {
    static let version = "make 2"
    static let fill = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
    static let smallSide = 40.0
    static let widen = 0.15

    struct Request: Decodable {
        let pictures: [Item]

        struct Item: Decodable {
            let path: String
            let output: String
            let filled: [[Double]]
            let covered: [Covered]
            let written: [Written]
            let bitmap: String?
        }

        struct Covered: Decodable {
            let box: [Double]
            let colour: String?
            let tag: String?
        }

        struct Written: Decodable {
            let box: [Double]
            let tag: String
        }
    }

    struct Result: Encodable {
        let engine: String
        let pictures: [Made]
    }

    struct Made: Encodable {
        let status: String
        var reason: String?
        var width: Int?
        var height: Int?
        var covered: [String]?
    }

    static func run(_ request: Request) throws -> Result {
        for (index, item) in request.pictures.enumerated() {
            for box in item.filled + item.covered.map(\.box) + item.written.map(\.box) where !valid(box) {
                throw EngineError.request("picture \(index): every box is four finite numbers, x1 ≤ x2 and y1 ≤ y2")
            }
            if item.written.contains(where: { $0.tag.isEmpty }) || item.covered.contains(where: { $0.tag?.isEmpty == true }) {
                throw EngineError.request("picture \(index): a tag is never empty")
            }
            if item.covered.contains(where: { $0.colour.map { rgb($0) == nil } ?? false }) {
                throw EngineError.request("picture \(index): a colour is #rrggbb")
            }
        }
        return Result(engine: version, pictures: try request.pictures.map { item in
            let data: Data
            do { data = try Data(contentsOf: URL(fileURLWithPath: item.path)) } catch {
                throw EngineError.failed("cannot read \(item.path): \(error.localizedDescription)")
            }
            switch make(data, item) {
            case .failure(let unreadable):
                return Made(status: "unreadable", reason: unreadable.reason)
            case .success(let made):
                if let bitmap = item.bitmap { try save(made.bitmap, bitmap) }
                try save(made.jpeg, item.output)
                return Made(status: "ok", width: made.width, height: made.height, covered: made.colours.map(hex))
            }
        })
    }

    private static func valid(_ box: [Double]) -> Bool {
        box.count == 4 && box.allSatisfy(\.isFinite) && box[0] <= box[2] && box[1] <= box[3]
    }

    private static func save(_ data: Data, _ path: String) throws {
        do { try data.write(to: URL(fileURLWithPath: path), options: .atomic) } catch {
            throw EngineError.failed("cannot write \(path): \(error.localizedDescription)")
        }
    }

    static func rgb(_ text: String) -> [UInt8]? {
        guard text.count == 7, text.first == "#", let value = UInt32(text.dropFirst(), radix: 16) else { return nil }
        return [UInt8(value >> 16 & 0xff), UInt8(value >> 8 & 0xff), UInt8(value & 0xff)]
    }

    static func hex(_ rgb: [UInt8]) -> String {
        String(format: "#%02x%02x%02x", rgb[0], rgb[1], rgb[2])
    }

    private static func pixels(_ box: [Double], _ scaleX: Double, _ scaleY: Double, _ width: Int, _ height: Int,
                               margin: Double = 0) -> (left: Int, top: Int, right: Int, bottom: Int) {
        (Int(max(0, (box[0] * scaleX - margin).rounded(.down))), Int(max(0, (box[1] * scaleY - margin).rounded(.down))),
         Int(min(Double(width), (box[2] * scaleX + margin).rounded(.up))), Int(min(Double(height), (box[3] * scaleY + margin).rounded(.up))))
    }

    static func margin(_ box: [Double], _ scaleX: Double, _ scaleY: Double) -> Double {
        let side = min((box[2] - box[0]) * scaleX, (box[3] - box[1]) * scaleY)
        return side >= smallSide ? 0 : ((smallSide - side) * widen).rounded(.up)
    }

    private static func tone(_ pixels: UnsafePointer<UInt8>, bytesPerRow: Int, _ box: (left: Int, top: Int, right: Int, bottom: Int)) -> [UInt8] {
        let w = box.right - box.left, h = box.bottom - box.top
        let left = box.left + w / 4, right = max(left + 1, box.right - w / 4)
        let top = box.top + h / 4, bottom = max(top + 1, box.bottom - h / 4)
        var sum = [0, 0, 0], count = 0
        for y in top..<bottom { for x in left..<right {
            let at = y * bytesPerRow + x * 4
            for c in 0..<3 { sum[c] += Int(pixels[at + c]) }
            count += 1
        } }
        return sum.map { UInt8(($0 + count / 2) / max(1, count)) }
    }

    private static func tag(_ context: CGContext, _ words: String, _ cover: (left: Int, top: Int, right: Int, bottom: Int)) {
        let height = context.height
        let w = Double(cover.right - cover.left), h = Double(cover.bottom - cover.top)
        let size = max(8, min((w * 0.45).rounded(), (h * 0.5).rounded(), max(14, (Double(max(context.width, height)) / 45).rounded())))
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, CGFloat(size), nil)
        let edge = max(1, (size / 12).rounded())
        func line(_ attributes: [CFString: Any]) -> CTLine {
            var all: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font]
            for (key, value) in attributes { all[NSAttributedString.Key(key as String)] = value }
            return CTLineCreateWithAttributedString(NSAttributedString(string: words, attributes: all))
        }
        let stroke = line([kCTStrokeColorAttributeName: fill, kCTStrokeWidthAttributeName: 200 * edge / size])
        let white = line([kCTForegroundColorAttributeName: Draw.text])
        var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
        let textWidth = CGFloat(CTLineGetTypographicBounds(white, &ascent, &descent, &leading))
        let x = CGFloat(cover.left) + (CGFloat(w) - textWidth) / 2
        let baseline = CGFloat(height) - (CGFloat(cover.top) + (CGFloat(h) + ascent - descent) / 2)
        for drawn in [stroke, white] {
            context.textPosition = CGPoint(x: x, y: baseline)
            CTLineDraw(drawn, context)
        }
    }

    private static func make(_ data: Data, _ item: Request.Item)
        -> Swift.Result<(jpeg: Data, bitmap: Data, width: Int, height: Int, colours: [[UInt8]]), Unreadable> {
        Draw.sized(data).map { sized in
            let width = sized.image.width, height = sized.image.height
            var bitmap = Data()
            var colours: [[UInt8]] = []
            let jpeg = face_engine.jpeg(sized.image, region: CGRect(x: 0, y: 0, width: width, height: height), width: width,
                                        height: height, quality: Draw.quality) { context in
                func flat(_ box: (left: Int, top: Int, right: Int, bottom: Int)) {
                    guard box.right > box.left, box.bottom > box.top else { return }
                    context.fill(CGRect(x: box.left, y: height - box.bottom, width: box.right - box.left, height: box.bottom - box.top))
                }
                let pixels = context.data!.assumingMemoryBound(to: UInt8.self)
                colours = item.covered.map { face in
                    face.colour.flatMap(rgb) ?? tone(pixels, bytesPerRow: context.bytesPerRow,
                                                     Make.pixels(face.box, sized.scaleX, sized.scaleY, width, height))
                }
                let covers = item.covered.map { face in
                    Make.pixels(face.box, sized.scaleX, sized.scaleY, width, height, margin: margin(face.box, sized.scaleX, sized.scaleY))
                }
                context.setShouldAntialias(false)
                for (cover, colour) in zip(covers, colours) {
                    context.setFillColor(CGColor(srgbRed: CGFloat(colour[0]) / 255, green: CGFloat(colour[1]) / 255, blue: CGFloat(colour[2]) / 255, alpha: 1))
                    flat(cover)
                }
                context.setFillColor(fill)
                for box in item.filled { flat(Make.pixels(box, sized.scaleX, sized.scaleY, width, height)) }
                context.setShouldAntialias(true)
                for (face, cover) in zip(item.covered, covers) {
                    if let words = face.tag, cover.right > cover.left, cover.bottom > cover.top { tag(context, words, cover) }
                }
                for written in item.written {
                    Draw.frame(context, written.box, written.tag, scaleX: sized.scaleX, scaleY: sized.scaleY)
                }
                if item.bitmap != nil, let pixels = context.data {
                    bitmap = Data(bytes: pixels, count: context.bytesPerRow * height)
                }
            }
            return (jpeg, bitmap, width, height, colours)
        }
    }
}
