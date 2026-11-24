import Foundation
import UniformTypeIdentifiers
import XCTest

final class DrawTests: EngineTestCase {
    let face = [397.1, 284.0, 444.89, 344.37]

    func draw(_ images: [[String: Any]], name: String = "request") throws -> Engine.Run {
        try Engine.run("draw", ["images": images], in: folder, name: name)
    }

    func image(_ url: URL, _ output: String, _ faces: [[String: Any]]) -> [String: Any] {
        ["path": url.path, "output": path(output), "faces": faces]
    }

    func isBoxGreen(_ rgb: (Int, Int, Int)) -> Bool { rgb.0 < 90 && rgb.1 > 170 && rgb.2 > 70 && rgb.2 < 170 }

    func testBoxesLandOnTheOrientedPhoto() throws {
        let rotated = folder.appendingPathComponent("rotated.tiff")
        Images.write(Images.storedForOrientation6(Images.load(Images.seven)), to: rotated, type: .tiff, orientation: 6)
        let named = [["box": face, "name": "Person A"]]
        let first = try draw([image(Images.seven, "plain.jpg", named), image(rotated, "rotated.jpg", named)], name: "first")
        let result = try first.json()
        XCTAssertEqual(result["images"] as? NSArray, [
            ["status": "ok", "width": 1280, "height": 853], ["status": "ok", "width": 1280, "height": 853],
        ] as NSArray)
        for output in ["plain.jpg", "rotated.jpg"] {
            let url = folder.appendingPathComponent(output)
            XCTAssertTrue(isBoxGreen(Images.pixel(url, 398, 314)), "\(output) \(Images.pixel(url, 398, 314))")
            XCTAssertFalse(isBoxGreen(Images.pixel(url, 421, 314)), output)
        }
        Engine.keep(folder.appendingPathComponent("plain.jpg"), as: "draw-named.jpg")
        let second = try draw([image(Images.seven, "again.jpg", named)], name: "second")
        XCTAssertEqual(second.status, 0)
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("plain.jpg")),
                       try Data(contentsOf: folder.appendingPathComponent("again.jpg")))
    }

    func testSizes() throws {
        let large = folder.appendingPathComponent("large.png")
        Images.write(Images.scaled(Images.load(Images.seven), 3), to: large, type: .png)
        let offPhoto: [String: Any] = ["box": [1200.0, -40, 1400, 100], "name": "A name long enough to run off the edge"]
        let result = try draw([
            image(large, "large.jpg", [["box": face.map { $0 * 3 }, "name": "Person A"]]),
            image(Images.six, "small.jpg", [offPhoto]),
            image(Images.six, "none.jpg", []),
        ]).json()
        let sizes = (result["images"] as! [[String: Any]]).map { [$0["width"] as! Int, $0["height"] as! Int] }
        XCTAssertEqual(sizes, [[1536, 1023], [1280, 852], [1280, 852]])
        XCTAssertTrue(Images.size(folder.appendingPathComponent("large.jpg")) == (1536, 1023))
        XCTAssertTrue(isBoxGreen(Images.pixel(folder.appendingPathComponent("large.jpg"), 477, 377)))
        let plain = Images.pixel(folder.appendingPathComponent("none.jpg"), 640, 400)
        let original = Images.pixel(Images.six, 640, 400)
        XCTAssertEqual(Double(plain.0), Double(original.0), accuracy: 12)
    }

    func testUnreadableImageIsAStatus() throws {
        let text = folder.appendingPathComponent("text.jpg")
        try Data("not an image".utf8).write(to: text)
        let images = try draw([image(text, "bad.jpg", []), image(Images.six, "good.jpg", [])]).json()["images"] as! [[String: Any]]
        XCTAssertEqual(images.map { $0["status"] as! String }, ["unreadable", "ok"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: path("bad.jpg")))
        XCTAssertTrue(FileManager.default.fileExists(atPath: path("good.jpg")))
    }

    func testMissingPhotoStopsTheRun() throws {
        let missing = try draw([image(folder.appendingPathComponent("gone.jpg"), "out.jpg", [])], name: "missing")
        XCTAssertEqual(missing.status, 1)
        XCTAssertFalse(missing.resultExists)
        let unwritable = try draw([["path": Images.six.path, "output": path("no/such/folder/out.jpg"), "faces": []]],
                                  name: "unwritable")
        XCTAssertEqual(unwritable.status, 1)
        XCTAssertFalse(unwritable.resultExists)
    }

    func testBadFacesAreRefused() throws {
        for faces: [[String: Any]] in [[["box": face, "name": ""]], [["box": [1, 2, 3], "name": "A"]]] {
            let run = try draw([image(Images.six, "out.jpg", faces)])
            XCTAssertEqual(run.status, 2)
            XCTAssertFalse(run.resultExists)
        }
    }
}
