import Foundation
import UniformTypeIdentifiers
import XCTest

final class ScanTests: EngineTestCase {
    func scan(_ photos: [(key: String, url: URL)], name: String = "request") throws -> Engine.Run {
        try Engine.run("scan", [
            "models": Engine.models.path,
            "output": path("out-\(name)"),
            "photos": photos.map { ["key": $0.key, "path": $0.url.path] },
        ], in: folder, name: name)
    }

    func faces(_ photo: [String: Any]) -> [[String: Any]] { photo["faces"] as? [[String: Any]] ?? [] }

    func vectors(_ photo: [String: Any], name: String = "request") throws -> [[Float]] {
        guard let file = photo["vectors"] as? String else { return [] }
        let data = try Data(contentsOf: folder.appendingPathComponent("out-\(name)/\(file)"))
        let values = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        return stride(from: 0, to: values.count, by: 512).map { Array(values[$0..<($0 + 512)]) }
    }

    func cosine(_ a: [Float], _ b: [Float]) -> Float { zip(a, b).map(*).reduce(0, +) }

    func testReferencePhotosMatchTheirNumbers() throws {
        try Engine.requireModels()
        let expected = try JSONSerialization.jsonObject(
            with: Data(contentsOf: Engine.reference.appendingPathComponent("expected.json"))) as! [String: Any]
        let keys = (expected["photos"] as! [[String: Any]]).map { $0["key"] as! String }
        XCTAssertEqual(keys, ["crew-seven.jpg", "crew-six.jpg", "crew-six-640.jpg", "crew-six-320.jpg"])
        let run = try scan(keys.map { ($0, Engine.reference.appendingPathComponent($0)) })
        let result = try run.json()
        Engine.keep(run.resultFile, as: "scan-reference.json")
        XCTAssertEqual(result["pipeline"] as? NSDictionary, expected["pipeline"] as? NSDictionary)
        let photos = result["photos"] as! [[String: Any]]
        for (photo, want) in zip(photos, expected["photos"] as! [[String: Any]]) {
            XCTAssertEqual(photo["status"] as? String, "ok")
            let got = faces(photo), wanted = faces(want)
            XCTAssertEqual(got.count, wanted.count, "\(photo["key"]!)")
            let width = photo["width"] as! Double, height = photo["height"] as! Double
            let rows = try vectors(photo)
            let referenceData = try Data(contentsOf: Engine.reference.appendingPathComponent(want["vectors"] as! String))
            let reference = referenceData.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
            XCTAssertEqual(rows.count, got.count, "one vector per face")
            var keys = Set<String>()
            for (index, (face, wantFace)) in zip(got, wanted).enumerated() {
                let box = face["box"] as! [Double]
                XCTAssertTrue(box[0] >= 0 && box[1] >= 0 && box[2] <= width && box[3] <= height && box[0] < box[2] && box[1] < box[3])
                XCTAssertTrue(keys.insert(box.map { String(Int($0.rounded())) }.joined(separator: ",")).inserted)
                for (a, b) in zip(box, wantFace["box"] as! [Double]) { XCTAssertEqual(a, b, accuracy: 0.5) }
                let norm = rows[index].map { $0 * $0 }.reduce(0, +).squareRoot()
                XCTAssertEqual(norm, 1, accuracy: 1e-5)
                XCTAssertGreaterThan(cosine(rows[index], Array(reference[(index * 512)..<((index + 1) * 512)])), 0.999,
                                     "row \(index) is face \(index)")
                let tier = face["tier"] as! String
                XCTAssertTrue(["seed", "assign", "observe"].contains(tier))
                if tier == "observe" {
                    XCTAssertNil(face["crop"])
                } else {
                    let crop = folder.appendingPathComponent("out-request/\(face["crop"] as! String)")
                    XCTAssertTrue(Images.size(crop) == (160, 160), "crop is 160 px square")
                }
            }
        }
    }

    func testSameRequestSameBytes() throws {
        try Engine.requireModels()
        let photos: [(key: String, url: URL)] = [("a", Images.seven), ("b", Images.six), ("c", Images.seven)]
        let first = try scan(photos, name: "first")
        let second = try scan(photos, name: "second")
        XCTAssertEqual(try Data(contentsOf: first.resultFile).count > 0, true)
        let firstResult = try first.json(), secondResult = try second.json()
        XCTAssertEqual(firstResult as NSDictionary, secondResult as NSDictionary)
        for key in ["a", "b", "c"] {
            XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("out-first/\(key).f32")),
                           try Data(contentsOf: folder.appendingPathComponent("out-second/\(key).f32")))
        }
        let reversed = try scan(photos.reversed(), name: "reversed").json()
        let byKey = Dictionary(uniqueKeysWithValues: (reversed["photos"] as! [[String: Any]]).map { ($0["key"] as! String, $0) })
        let firstPhotos = firstResult["photos"] as! [[String: Any]]
        let withoutCrops = { (photo: [String: Any]) in self.faces(photo).map { $0.filter { $0.key != "crop" } } as NSArray }
        XCTAssertEqual(withoutCrops(firstPhotos[0]), withoutCrops(firstPhotos[2]))
        for photo in firstPhotos {
            let other = byKey[photo["key"] as! String]!
            XCTAssertEqual(faces(photo) as NSArray, faces(other) as NSArray)
            for (a, b) in zip(try vectors(photo, name: "first"), try vectors(other, name: "reversed")) {
                XCTAssertGreaterThan(cosine(a, b), 0.9999)
            }
        }
    }

    func testOrientationIsApplied() throws {
        try Engine.requireModels()
        let upright = Images.load(Images.seven)
        let rotated = folder.appendingPathComponent("rotated.tiff")
        Images.write(Images.storedForOrientation6(upright), to: rotated, type: .tiff, orientation: 6)
        let plain = folder.appendingPathComponent("plain.tiff")
        Images.write(upright, to: plain, type: .tiff)
        let photos = try scan([("plain", plain), ("rotated", rotated)]).json()["photos"] as! [[String: Any]]
        XCTAssertEqual(photos[1]["width"] as? Int, upright.width)
        XCTAssertEqual(photos[1]["height"] as? Int, upright.height)
        XCTAssertEqual(faces(photos[0]).count, 7)
        XCTAssertEqual(faces(photos[1]).count, faces(photos[0]).count)
        for (a, b) in zip(faces(photos[0]), faces(photos[1])) {
            for (x, y) in zip(a["box"] as! [Double], b["box"] as! [Double]) { XCTAssertEqual(x, y, accuracy: 0.5) }
        }
    }

    func testFormatsDecode() throws {
        try Engine.requireModels()
        let upright = Images.load(Images.seven)
        let heic = folder.appendingPathComponent("photo.heic")
        Images.write(upright, to: heic, type: .heic)
        let gray = folder.appendingPathComponent("gray.png")
        Images.write(Images.canvas(upright.width, upright.height, gray: true) {
            $0.draw(upright, in: CGRect(x: 0, y: 0, width: upright.width, height: upright.height))
        }, to: gray, type: .png)
        let empty = folder.appendingPathComponent("empty.png")
        Images.write(Images.canvas(640, 480) { context in
            context.setFillColor(CGColor(srgbRed: 0.2, green: 0.5, blue: 0.8, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 640, height: 480))
        }, to: empty, type: .png)
        let tiny = folder.appendingPathComponent("tiny.png")
        Images.write(Images.canvas(8, 8) { _ in }, to: tiny, type: .png)
        let thin = folder.appendingPathComponent("thin.png")
        Images.write(Images.canvas(4000, 3) { _ in }, to: thin, type: .png)
        let run = try scan([("heic", heic), ("gray", gray), ("empty", empty), ("tiny", tiny), ("thin", thin)])
        let photos = try run.json()["photos"] as! [[String: Any]]
        XCTAssertEqual(photos.map { $0["status"] as! String }, ["ok", "ok", "ok", "ok", "ok"])
        XCTAssertEqual(faces(photos[0]).count, 7, "HEIC")
        XCTAssertEqual(faces(photos[1]).count, 7, "greyscale")
        for photo in photos[2...] {
            XCTAssertEqual(faces(photo).count, 0)
            XCTAssertNil(photo["vectors"])
        }
        XCTAssertEqual(photos[4]["width"] as? Int, 4000)
    }

    func testBadBytesAreUnreadable() throws {
        try Engine.requireModels()
        let text = folder.appendingPathComponent("text")
        try Data("not an image".utf8).write(to: text)
        let empty = folder.appendingPathComponent("empty")
        try Data().write(to: empty)
        let cut = folder.appendingPathComponent("cut.jpg")
        let bytes = try Data(contentsOf: Images.seven)
        try bytes.prefix(bytes.count / 2).write(to: cut)
        let giant = folder.appendingPathComponent("giant.png")
        try Images.blackPNG(width: 16_000, height: 13_000).write(to: giant)
        let run = try scan([("text", text), ("empty", empty), ("cut", cut), ("giant", giant), ("good", Images.six)])
        let photos = try run.json()["photos"] as! [[String: Any]]
        XCTAssertEqual(photos[0]["status"] as? String, "unreadable")
        XCTAssertEqual(photos[1]["status"] as? String, "unreadable")
        XCTAssertTrue(["ok", "unreadable"].contains(photos[2]["status"] as! String))
        XCTAssertEqual(photos[3]["status"] as? String, "unreadable")
        XCTAssertTrue((photos[3]["reason"] as! String).contains("megapixels"))
        XCTAssertEqual(photos[4]["status"] as? String, "ok")
        XCTAssertEqual(faces(photos[4]).count, 6)
    }

    func testMissingPhotoStopsTheRun() throws {
        try Engine.requireModels()
        let run = try scan([("good", Images.six), ("gone", folder.appendingPathComponent("gone.jpg"))])
        XCTAssertEqual(run.status, 1)
        XCTAssertFalse(run.resultExists)
        XCTAssertTrue(run.stderr.contains("gone.jpg"))
    }

    func testModelsMissingOrChanged() throws {
        try Engine.requireModels()
        let models = folder.appendingPathComponent("models")
        try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
        let request: [String: Any] = ["models": models.path, "output": path("out"), "photos": [["key": "a", "path": Images.six.path]]]
        let missing = try Engine.run("scan", request, in: folder)
        XCTAssertEqual(missing.status, 1)
        XCTAssertTrue(missing.stderr.contains("fetch-models.sh"))
        try Data("a converted model".utf8).write(to: models.appendingPathComponent("det_10g.onnx"))
        try FileManager.default.createSymbolicLink(at: models.appendingPathComponent("w600k_r50.onnx"),
                                                   withDestinationURL: Engine.models.appendingPathComponent("w600k_r50.onnx"))
        let changed = try Engine.run("scan", request, in: folder)
        XCTAssertEqual(changed.status, 1)
        XCTAssertTrue(changed.stderr.contains("SHA-256"))
        XCTAssertFalse(changed.resultExists)
    }

    func testKeysMustBePlainAndUnique() throws {
        for keys in [["../escape"], ["a/b"], [""], [".hidden"], ["same", "same"]] {
            let run = try Engine.run("scan", [
                "models": Engine.models.path, "output": path("out"),
                "photos": keys.map { ["key": $0, "path": Images.six.path] },
            ], in: folder)
            XCTAssertEqual(run.status, 2, "\(keys)")
            XCTAssertFalse(run.resultExists)
        }
    }

    func testEmptyRequestNeedsNoModels() throws {
        let run = try Engine.run("scan", ["models": path("nowhere"), "output": path("out"), "photos": []], in: folder)
        XCTAssertEqual((try run.json()["photos"] as! [Any]).count, 0)
    }

    func testCloseFacesAreFound() throws {
        try Engine.requireModels()
        let heights = [200.0, 300, 375, 450, 600, 750, 900, 1100]
        let photos = try heights.map { height -> (key: String, url: URL) in
            let url = folder.appendingPathComponent("close-\(Int(height)).jpg")
            Images.write(try Images.closeUp(height), to: url, type: .jpeg)
            return ("close-\(Int(height))", url)
        }
        let run = try scan(photos)
        let result = try run.json()
        Engine.keep(run.resultFile, as: "scan-close-faces.json")
        for (photo, height) in zip(result["photos"] as! [[String: Any]], heights) {
            let found = faces(photo)
            XCTAssertEqual(found.count, 1, "\(photo["key"]!): one face, never two boxes for it")
            guard let face = found.first else { continue }
            let box = face["box"] as! [Double]
            XCTAssertEqual((box[0] + box[2]) / 2, 448, accuracy: height / 10, "\(photo["key"]!) \(box)")
            XCTAssertEqual((box[1] + box[3]) / 2, 600, accuracy: height / 10, "\(photo["key"]!) \(box)")
            XCTAssertEqual(box[3] - box[1], height, accuracy: height * 0.15, "\(photo["key"]!) \(box)")
            XCTAssertGreaterThan(face["score"] as! Double, 0.75, "\(photo["key"]!)")
            XCTAssertEqual(face["tier"] as? String, "seed", "\(photo["key"]!)")
            let crop = folder.appendingPathComponent("out-request/\(face["crop"] as! String)")
            XCTAssertTrue(Images.size(crop) == (160, 160))
            let rows = try vectors(photo)
            XCTAssertEqual(rows.count, 1)
            XCTAssertEqual(rows[0].map { $0 * $0 }.reduce(0, +).squareRoot(), 1, accuracy: 1e-5)
        }
        let rows = try (result["photos"] as! [[String: Any]]).map { try vectors($0)[0] }
        for row in rows.dropFirst() { XCTAssertGreaterThan(cosine(rows[0], row), 0.6) }
    }

    func testNarrowFacesAreFound() throws {
        try Engine.requireModels()
        let heights = [400.0, 450, 500, 550]
        let photos = try heights.map { height -> (key: String, url: URL) in
            let url = folder.appendingPathComponent("narrow-\(Int(height)).jpg")
            Images.write(try Images.closeUp(height, narrow: 0.65), to: url, type: .jpeg)
            return ("narrow-\(Int(height))", url)
        }
        let run = try scan(photos)
        Engine.keep(run.resultFile, as: "scan-narrow-faces.json")
        for (photo, height) in zip(try run.json()["photos"] as! [[String: Any]], heights) {
            let found = faces(photo)
            XCTAssertEqual(found.count, 1, "\(photo["key"]!): \(found)")
            guard let box = found.first?["box"] as? [Double] else { continue }
            XCTAssertEqual((box[0] + box[2]) / 2, 448, accuracy: height / 10, "\(photo["key"]!) \(box)")
            XCTAssertEqual(box[3] - box[1], height, accuracy: height * 0.15, "\(photo["key"]!) \(box)")
        }
    }

    func testEachAxisMapsBackByItsOwnScale() throws {
        try Engine.requireModels()
        let photos = try [1049, 1050].map { rows -> (key: String, url: URL) in
            let url = folder.appendingPathComponent("strip-\(rows).jpg")
            Images.write(try Images.closeUp(700, width: 6000, canvasHeight: rows, across: 0.93), to: url, type: .jpeg)
            return ("strip-\(rows)", url)
        }
        let run = try scan(photos)
        Engine.keep(run.resultFile, as: "scan-wide-strip.json")
        let found = (try run.json()["photos"] as! [[String: Any]]).map(faces)
        XCTAssertEqual(found.map(\.count), [1, 1], "\(found)")
        guard found.allSatisfy({ $0.count == 1 }) else { return }
        let (a, b) = (found[0][0], found[1][0])
        XCTAssertEqual(((a["box"] as! [Double])[0] + (a["box"] as! [Double])[2]) / 2, 5580, accuracy: 30)
        for (x, y) in zip(a["box"] as! [Double], b["box"] as! [Double]) { XCTAssertEqual(x, y, accuracy: 5, "box") }
        for (x, y) in zip((a["landmarks"] as! [[Double]]).joined(), (b["landmarks"] as! [[Double]]).joined()) {
            XCTAssertEqual(x, y, accuracy: 5, "landmarks")
        }
    }

    func testCloseFaceBesideAGroup() throws {
        try Engine.requireModels()
        let seven = Images.load(Images.seven), close = try Images.closeUp(900)
        let url = folder.appendingPathComponent("group-and-close.jpg")
        Images.write(Images.canvas(2096, 1200) { context in
            context.draw(seven, in: CGRect(x: 0, y: 200, width: 1200, height: 800))
            context.draw(close, in: CGRect(x: 1200, y: 0, width: 896, height: 1200))
        }, to: url, type: .jpeg)
        let run = try scan([("group-and-close", url), ("crew-seven", Images.seven)])
        let photos = try run.json()["photos"] as! [[String: Any]]
        Engine.keep(run.resultFile, as: "scan-close-beside-group.json")
        let found = faces(photos[0]), group = faces(photos[1])
        XCTAssertEqual(found.count, group.count + 1, "\(found)")
        for face in group {
            let want = (face["box"] as! [Double]).enumerated().map { $0.offset % 2 == 0 ? $0.element * 0.9375 : $0.element * 0.9375 + 200 }
            let match = found.filter { zip($0["box"] as! [Double], want).allSatisfy { abs($0 - $1) <= 4 } }
            XCTAssertEqual(match.count, 1, "\(want)")
        }
        let large = found.filter { ($0["size"] as! Double) > 400 }
        XCTAssertEqual(large.count, 1)
        if let box = large.first?["box"] as? [Double] {
            XCTAssertEqual((box[0] + box[2]) / 2, 1200 + 448, accuracy: 90)
            XCTAssertGreaterThan(large[0]["score"] as! Double, 0.75)
        }
    }

    func testLargeFacesAreNotDemoted() throws {
        try Engine.requireModels()
        let large = folder.appendingPathComponent("large.png")
        Images.write(Images.scaled(Images.load(Images.seven), 3), to: large, type: .png)
        let photos = try scan([("small", Images.seven), ("large", large)]).json()["photos"] as! [[String: Any]]
        let rank = ["observe": 0, "assign": 1, "seed": 2]
        let small = faces(photos[0]), big = faces(photos[1])
        XCTAssertEqual(small.count, big.count)
        for (a, b) in zip(small, big) {
            XCTAssertGreaterThanOrEqual(rank[b["tier"] as! String]!, rank[a["tier"] as! String]!)
            if (b["score"] as! Double) >= 0.6 { XCTAssertEqual(b["tier"] as? String, "seed") }
        }
    }
}
