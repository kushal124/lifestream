import CoreGraphics
import Foundation
import ImageIO
import XCTest

final class MakeTests: EngineTestCase {
    struct Bitmap {
        let width: Int
        let height: Int
        let bytes: Data

        func rgb(_ x: Int, _ y: Int) -> [UInt8] {
            let at = (y * width + x) * 4
            return [bytes[at], bytes[at + 1], bytes[at + 2]]
        }

        func colours(_ box: [Double], scale: (x: Double, y: Double) = (1, 1), inset: Int = 0) -> Set<[UInt8]> {
            let left = Int((box[0] * scale.x).rounded(.down)) + inset, right = Int((box[2] * scale.x).rounded(.up)) - inset
            let top = Int((box[1] * scale.y).rounded(.down)) + inset, bottom = Int((box[3] * scale.y).rounded(.up)) - inset
            var seen = Set<[UInt8]>()
            for y in max(0, top)..<min(height, bottom) { for x in max(0, left)..<min(width, right) { seen.insert(rgb(x, y)) } }
            return seen
        }
    }

    func picture(_ url: URL, _ output: String, filled: [[Double]] = [], covered: [[String: Any]] = [], written: [[String: Any]] = [],
                 bitmap: String? = nil) -> [String: Any] {
        var item: [String: Any] = ["path": url.path, "output": path(output), "filled": filled, "covered": covered, "written": written]
        if let bitmap { item["bitmap"] = path(bitmap) }
        return item
    }

    func rgb(_ text: String) -> [UInt8]? {
        guard text.count == 7, text.hasPrefix("#"), let value = UInt32(text.dropFirst(), radix: 16) else { return nil }
        return [UInt8(value >> 16 & 0xff), UInt8(value >> 8 & 0xff), UInt8(value & 0xff)]
    }

    func make(_ pictures: [[String: Any]], name: String = "request") throws -> Engine.Run {
        try Engine.run("make", ["pictures": pictures], in: folder, name: name)
    }

    func bitmap(_ name: String, _ width: Int, _ height: Int) throws -> Bitmap {
        let bytes = try Data(contentsOf: folder.appendingPathComponent(name))
        XCTAssertEqual(bytes.count, width * height * 4)
        return Bitmap(width: width, height: height, bytes: bytes)
    }

    func testReadThenMade() throws {
        let shot = folder.appendingPathComponent("shot.png")
        Images.write(Images.screenshot(), to: shot, type: .png)
        let read = try Engine.run("read", ["pictures": [["path": shot.path]]], in: folder, name: "read").json()
        let found = (read["pictures"] as! [[String: Any]])[0]
        let words = (found["lines"] as! [[String: Any]]).flatMap { $0["words"] as! [[String: Any]] }
        let hidden = words.filter { ["Ada", "Example", "555", "000", "0001", "person-a@example.com"].contains($0["text"] as! String) }
            .map { $0["box"] as! [Double] }
        XCTAssertEqual(hidden.count, 6)
        let face = (found["faces"] as! [[String: Any]]).map { $0["box"] as! [Double] }.first { Images.overlap($0, Images.shotFace) >= 0.5 }!
        let recipe = picture(shot, "made.jpg", filled: hidden, covered: [["box": face, "tag": "P1"]], bitmap: "made.rgbx")
        let first = try make([recipe], name: "first").json()
        XCTAssertEqual(first["engine"] as? String, "make 2")
        let made1 = (first["pictures"] as! [[String: Any]])[0]
        XCTAssertEqual(made1["status"] as? String, "ok")
        XCTAssertEqual([made1["width"] as? Int, made1["height"] as? Int], [1400, 900])
        let colour = try XCTUnwrap((made1["covered"] as? [String])?.first)
        Engine.keep(folder.appendingPathComponent("made.jpg"), as: "make-screenshot.jpg")
        let made = try bitmap("made.rgbx", 1400, 900)
        for box in hidden { XCTAssertEqual(made.colours(box), [[0, 0, 0]], "\(box)") }
        let tone = try XCTUnwrap(rgb(colour))
        XCTAssertEqual(made.colours([face[0], face[1], face[2], face[1] + 20]), [tone])
        XCTAssertTrue(made.colours(face).contains { $0.allSatisfy { $0 > 230 } }, "the tag is written on the cover, in white")
        let call = words.first { $0["text"] as? String == "Call" }!["box"] as! [Double]
        XCTAssertTrue(made.colours(call).contains([255, 255, 255]))

        var again = recipe
        again["output"] = path("again.jpg")
        again["bitmap"] = path("again.rgbx")
        XCTAssertEqual(try make([again], name: "second").status, 0)
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("made.rgbx")), try Data(contentsOf: folder.appendingPathComponent("again.rgbx")))
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("made.jpg")), try Data(contentsOf: folder.appendingPathComponent("again.jpg")))
    }

    func testFillsScaleWithThePhoto() throws {
        let face = [397.1, 284.0, 444.89, 344.37]
        let large = folder.appendingPathComponent("large.png")
        Images.write(Images.scaled(Images.load(Images.seven), 3), to: large, type: .png)
        let rotated = folder.appendingPathComponent("rotated.tiff")
        Images.write(Images.storedForOrientation6(Images.load(Images.seven)), to: rotated, type: .tiff, orientation: 6)
        let edge = [1200.0, -40, 1400, 100]
        let result = try make([
            picture(large, "large.jpg", filled: [face.map { $0 * 3 }], bitmap: "large.rgbx"),
            picture(rotated, "rotated.jpg", filled: [face, edge], bitmap: "rotated.rgbx"),
        ]).json()
        let sizes = (result["pictures"] as! [[String: Any]]).map { [$0["width"] as! Int, $0["height"] as! Int] }
        XCTAssertEqual(sizes, [[1536, 1023], [1280, 853]])
        XCTAssertEqual(try bitmap("large.rgbx", 1536, 1023).colours(face.map { $0 * 3 }, scale: (1536.0 / 3840, 1023.0 / 2559)), [[0, 0, 0]])
        let turned = try bitmap("rotated.rgbx", 1280, 853)
        XCTAssertEqual(turned.colours(face), [[0, 0, 0]])
        XCTAssertEqual(turned.colours([1200, 0, 1280, 100]), [[0, 0, 0]])
        XCTAssertNotEqual(turned.rgb(1199, 50), [0, 0, 0])
    }

    func testNoMetadataLeaves() throws {
        let tagged = folder.appendingPathComponent("tagged.jpg")
        let destination = CGImageDestinationCreateWithURL(tagged as CFURL, "public.jpeg" as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, Images.load(Images.six), [
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 12.5, kCGImagePropertyGPSLatitudeRef: "N",
                                            kCGImagePropertyGPSLongitude: 45.25, kCGImagePropertyGPSLongitudeRef: "E"],
            kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "Example Camera Maker", kCGImagePropertyTIFFModel: "Example Model 1"],
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2026:01:02 03:04:05"],
        ] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        func properties(_ url: URL) -> [CFString: Any] {
            CGImageSourceCopyPropertiesAtIndex(CGImageSourceCreateWithURL(url as CFURL, nil)!, 0, nil) as! [CFString: Any]
        }
        XCTAssertNotNil(properties(tagged)[kCGImagePropertyGPSDictionary])
        XCTAssertEqual(try make([picture(tagged, "made.jpg")]).status, 0)
        let made = folder.appendingPathComponent("made.jpg")
        let kept = properties(made)
        XCTAssertNil(kept[kCGImagePropertyGPSDictionary])
        XCTAssertNil(kept[kCGImagePropertyTIFFDictionary])
        XCTAssertNil((kept[kCGImagePropertyExifDictionary] as? [CFString: Any])?[kCGImagePropertyExifDateTimeOriginal])
        let bytes = try Data(contentsOf: made)
        for written in ["Example Camera Maker", "Example Model 1", "2026:01:02"] { XCTAssertNil(bytes.range(of: Data(written.utf8)), written) }
    }

    func testBadRecipesAreRefused() throws {
        let cases: [[String: Any]] = [
            picture(Images.six, "out.jpg", filled: [[1, 2, 3]]),
            picture(Images.six, "out.jpg", filled: [[10, 10, 5, 20]]),
            picture(Images.six, "out.jpg", written: [["box": [1, 2, 3, 4], "tag": ""]]),
            picture(Images.six, "out.jpg", covered: [["box": [1, 2, 3, 4], "tag": ""]]),
            picture(Images.six, "out.jpg", covered: [["box": [1, 2, 3, 4], "colour": "black"]]),
            picture(Images.six, "out.jpg", covered: [["box": [4, 2, 3, 4]]]),
        ]
        for (index, item) in cases.enumerated() {
            let run = try make([item], name: "bad-\(index)")
            XCTAssertEqual(run.status, 2, "\(item)")
            XCTAssertFalse(run.resultExists)
            XCTAssertFalse(FileManager.default.fileExists(atPath: path("out.jpg")))
        }
    }

    func testUnreadableAndMissing() throws {
        let text = folder.appendingPathComponent("text.jpg")
        try Data("not an image".utf8).write(to: text)
        let pictures = try make([picture(text, "bad.jpg"), picture(Images.six, "good.jpg")]).json()["pictures"] as! [[String: Any]]
        XCTAssertEqual(pictures.map { $0["status"] as! String }, ["unreadable", "ok"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: path("bad.jpg")))
        let missing = try make([picture(folder.appendingPathComponent("gone.jpg"), "out.jpg")], name: "missing")
        XCTAssertEqual(missing.status, 1)
        XCTAssertFalse(missing.resultExists)
        let unwritable = try make([["path": Images.six.path, "output": path("no/such/folder/out.jpg"), "filled": [], "covered": [], "written": []]], name: "unwritable")
        XCTAssertEqual(unwritable.status, 1)
        XCTAssertFalse(unwritable.resultExists)
    }

    func testFaceCoversAreTheirOwnTone() throws {
        let face = [102.11, 101.66, 348.62, 475.08]
        let closeUp = Engine.reference.appendingPathComponent("crew-six-640.jpg")
        let result = try make([
            picture(closeUp, "plain.jpg", bitmap: "plain.rgbx"),
            picture(closeUp, "covered.jpg", covered: [["box": face, "tag": "P1"]], bitmap: "covered.rgbx"),
            picture(closeUp, "given.jpg", covered: [["box": face, "colour": "#336699"]], bitmap: "given.rgbx"),
        ]).json()
        let made = result["pictures"] as! [[String: Any]]
        XCTAssertEqual(made[0]["covered"] as? [String], [])
        let colour = try XCTUnwrap(rgb(try XCTUnwrap((made[1]["covered"] as? [String])?.first)))
        XCTAssertEqual(made[2]["covered"] as? [String], ["#336699"])
        Engine.keep(folder.appendingPathComponent("covered.jpg"), as: "make-cover.jpg")
        let plain = try bitmap("plain.rgbx", 448, 600), covered = try bitmap("covered.rgbx", 448, 600)
        let w = face[2] - face[0], h = face[3] - face[1]
        let middle = [face[0] + w / 4, face[1] + h / 4, face[2] - w / 4, face[3] - h / 4]
        var sum = [0.0, 0, 0], count = 0.0
        for y in Int(middle[1])..<Int(middle[3]) { for x in Int(middle[0])..<Int(middle[2]) {
            for (c, v) in plain.rgb(x, y).enumerated() { sum[c] += Double(v) }
            count += 1
        } }
        for c in 0..<3 { XCTAssertEqual(Double(colour[c]), sum[c] / count, accuracy: 2, "the cover is the face's own tone") }
        XCTAssertNotEqual(colour, [0, 0, 0])
        XCTAssertEqual(covered.colours([face[0], face[1], face[2], face[1] + 60]), [colour])
        XCTAssertEqual(covered.colours([face[0], face[3] - 60, face[2], face[3]]), [colour])
        XCTAssertTrue(covered.colours(middle).contains { $0.allSatisfy { $0 > 230 } }, "the tag is written in white")
        XCTAssertEqual(try bitmap("given.rgbx", 448, 600).colours(face), [[0x33, 0x66, 0x99]])
        XCTAssertNotEqual(covered.rgb(Int(face[0]) - 2, Int((face[1] + face[3]) / 2)), colour)

        let small = folder.appendingPathComponent("small.png")
        Images.write(Images.scaled(Images.load(Images.seven), 0.5), to: small, type: .png)
        let tiny = [397.1, 284.0, 444.89, 344.37].map { $0 / 2 }
        let widened = try make([picture(small, "small.jpg", covered: [["box": tiny, "colour": "#ff00ff"]], bitmap: "small.rgbx")], name: "small").json()
        XCTAssertEqual((widened["pictures"] as! [[String: Any]])[0]["covered"] as? [String], ["#ff00ff"])
        let smallMade = try bitmap("small.rgbx", 640, 426)
        XCTAssertEqual(smallMade.colours([tiny[0] - 3, tiny[1] - 3, tiny[2] + 3, tiny[3] + 3]), [[255, 0, 255]])
        XCTAssertNotEqual(smallMade.rgb(Int(tiny[0].rounded(.down)) - 5, Int((tiny[1] + tiny[3]) / 2)), [255, 0, 255])
    }

    func testCoveredFacesAreNotRecognised() throws {
        try Engine.requireModels()
        let seven = Engine.reference.appendingPathComponent("crew-seven.jpg"), six = Engine.reference.appendingPathComponent("crew-six.jpg")
        let large = folder.appendingPathComponent("seven-large.png"), smaller = folder.appendingPathComponent("six-small.png")
        Images.write(Images.scaled(Images.load(Images.seven), 1.2), to: large, type: .png)
        Images.write(Images.scaled(Images.load(Images.six), 0.6), to: smaller, type: .png)
        let photos: [(key: String, url: URL)] = [("seven", seven), ("six", six), ("seven-large", large), ("six-small", smaller),
            ("six-640", Engine.reference.appendingPathComponent("crew-six-640.jpg")),
            ("six-320", Engine.reference.appendingPathComponent("crew-six-320.jpg"))]
        func scan(_ photos: [(key: String, url: URL)], _ name: String) throws -> [String: (faces: [[Double]], vectors: [[Float]])] {
            let result = try Engine.run("scan", ["models": Engine.models.path, "output": path("out-\(name)"),
                                                 "photos": photos.map { ["key": $0.key, "path": $0.url.path] }], in: folder, name: name).json()
            var found: [String: (faces: [[Double]], vectors: [[Float]])] = [:]
            for photo in result["photos"] as! [[String: Any]] {
                let faces = (photo["faces"] as? [[String: Any]] ?? []).map { $0["box"] as! [Double] }
                var rows: [[Float]] = []
                if let file = photo["vectors"] as? String {
                    let values = try Data(contentsOf: folder.appendingPathComponent("out-\(name)/\(file)")).withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
                    rows = stride(from: 0, to: values.count, by: 512).map { Array(values[$0..<($0 + 512)]) }
                }
                found[photo["key"] as! String] = (faces, rows)
            }
            return found
        }
        let original = try scan(photos, "original")
        let pictures = photos.map { photo -> [String: Any] in
            let faces = original[photo.key]!.faces
            return picture(photo.url, "\(photo.key)-covered.jpg",
                           covered: faces.enumerated().map { ["box": $0.element, "tag": "P\($0.offset + 1)"] },
                           written: [])
        }
        XCTAssertEqual(try make(pictures).status, 0)
        let control = try make([picture(seven, "seven-control.jpg", covered: original["seven"]!.faces.dropFirst().enumerated().map { ["box": $0.element, "tag": "P\($0.offset + 2)"] },
                                        written: [["box": original["seven"]!.faces[0], "tag": "P1"]])], name: "control")
        XCTAssertEqual(control.status, 0)
        for photo in photos { Engine.keep(folder.appendingPathComponent("\(photo.key)-covered.jpg"), as: "covered-\(photo.key).jpg") }
        let after = try scan(photos.map { ($0.key, folder.appendingPathComponent("\($0.key)-covered.jpg")) } + [("control", folder.appendingPathComponent("seven-control.jpg"))], "covered")
        func cosine(_ a: [Float], _ b: [Float]) -> Float { zip(a, b).map(*).reduce(0, +) }
        var faces = 0, best: Float = 0
        var lines: [String] = []
        for photo in photos {
            let before = original[photo.key]!, seen = after[photo.key]!
            for (index, vector) in before.vectors.enumerated() {
                faces += 1
                let onCover = seen.faces.indices.filter { Images.overlap(seen.faces[$0], before.faces[index]) >= 0.3 && $0 < seen.vectors.count }
                let top = onCover.map { cosine(vector, seen.vectors[$0]) }.max() ?? 0
                best = max(best, top)
                lines.append("\(photo.key) face \(index + 1): \(onCover.count) found on its cover, cosine \(top)")
                XCTAssertLessThan(top, 0.30, "\(photo.key) face \(index + 1) is matched on its cover")
            }
        }
        try lines.joined(separator: "\n").write(to: Engine.artifacts.appendingPathComponent("covered-cosines.txt"), atomically: true, encoding: .utf8)
        XCTAssertEqual(faces, 7 + 6 + 7 + 6 + 1 + 1, "every reference face is checked")
        let visible = original["seven"]!.vectors[0]
        XCTAssertGreaterThan(after["control"]!.vectors.map { cosine(visible, $0) }.max() ?? 0, 0.48)
        XCTAssertLessThan(best, 0.30)
    }
}
