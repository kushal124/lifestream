import Foundation
import XCTest

final class ReadTests: EngineTestCase {
    func read(_ paths: [String], name: String = "request") throws -> Engine.Run {
        try Engine.run("read", ["pictures": paths.map { ["path": $0] }], in: folder, name: name)
    }

    func testWordsAndFaces() throws {
        let shot = folder.appendingPathComponent("shot.png")
        Images.write(Images.screenshot(), to: shot, type: .png)
        let first = try read([shot.path], name: "first")
        let result = try first.json()
        Engine.keep(first.resultFile, as: "read-screenshot.json")
        let picture = (result["pictures"] as! [[String: Any]])[0]
        XCTAssertEqual(picture["status"] as? String, "ok")
        XCTAssertEqual([picture["width"] as? Int, picture["height"] as? Int], [1400, 900])
        let lines = (picture["lines"] as! [[String: Any]]).filter { $0["confidence"] as! Double > 0.5 }
        let words = lines.map { ($0["words"] as! [[String: Any]]).map { ($0["text"] as! String, $0["box"] as! [Double]) } }
        XCTAssertEqual(words.map { $0.map(\.0).joined(separator: " ") }, Images.shotLines.map(\.words))
        guard words.count == Images.shotLines.count else { return }
        for (index, line) in words.enumerated() {
            let top = Images.shotLines[index].top
            for (word, box) in line {
                XCTAssertTrue(box[1] >= top - 4 && box[1] <= top + 24 && box[3] > top + 30 && box[3] <= top + 70, "\(word) \(box)")
            }
            for (left, right) in zip(line, line.dropFirst()) { XCTAssertLessThanOrEqual(left.1[2], right.1[0], "\(left.0) \(right.0)") }
            XCTAssertLessThan(line[1].1[2] - line[1].1[0], 200, "\(line[1])")
        }
        let faces = (picture["faces"] as! [[String: Any]]).map { $0["box"] as! [Double] }
        XCTAssertEqual(faces.filter { Images.overlap($0, Images.shotFace) >= 0.5 }.count, 1, "\(faces)")
        let second = try read([shot.path], name: "second")
        XCTAssertEqual(try Data(contentsOf: first.resultFile), try Data(contentsOf: second.resultFile))
    }

    func testFacesInScansFrame() throws {
        let rotated = folder.appendingPathComponent("rotated.tiff")
        Images.write(Images.storedForOrientation6(Images.load(Images.seven)), to: rotated, type: .tiff, orientation: 6)
        let result = try read([Images.seven.path, rotated.path]).json()
        let expected = try JSONSerialization.jsonObject(
            with: Data(contentsOf: Engine.reference.appendingPathComponent("expected.json"))) as! [String: Any]
        let scanned = ((expected["photos"] as! [[String: Any]]).first { $0["key"] as? String == "crew-seven.jpg" }!["faces"]
            as! [[String: Any]]).map { $0["box"] as! [Double] }
        for picture in result["pictures"] as! [[String: Any]] {
            XCTAssertEqual([picture["width"] as? Int, picture["height"] as? Int], [1280, 853])
            let faces = (picture["faces"] as! [[String: Any]]).map { $0["box"] as! [Double] }
            for box in scanned { XCTAssertEqual(faces.filter { Images.overlap($0, box) >= 0.5 }.count, 1, "\(box) in \(faces)") }
        }
    }

    func testUnreadableIsAStatus() throws {
        let text = folder.appendingPathComponent("text.jpg")
        try Data("not an image".utf8).write(to: text)
        let pictures = try read([text.path, Images.six.path]).json()["pictures"] as! [[String: Any]]
        XCTAssertEqual(pictures.map { $0["status"] as! String }, ["unreadable", "ok"])
        XCTAssertEqual(pictures[0]["reason"] as? String, "not an image ImageIO can read")
        XCTAssertNil(pictures[0]["lines"])
    }

    func testMissingPictureStopsTheRun() throws {
        let missing = try read([folder.appendingPathComponent("gone.jpg").path])
        XCTAssertEqual(missing.status, 1)
        XCTAssertFalse(missing.resultExists)
    }

    func testTheReadingAlone() throws {
        let result = try read([]).json()
        XCTAssertEqual((result["pictures"] as? [Any])?.count, 0)
        XCTAssertEqual(result["reader"] as? String, "read 1: text revision 3, accurate, as written; faces revision 3")
    }
}
