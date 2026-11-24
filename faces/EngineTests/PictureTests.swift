import AVFoundation
import Foundation
import UniformTypeIdentifiers
import XCTest
@testable import face_engine

final class PictureTests: EngineTestCase {
    func picture(_ from: URL, type: String, side: Int?, to name: String) throws -> [String: Any] {
        var request: [String: Any] = ["from": from.path, "to": path(name), "type": type]
        request["side"] = side ?? NSNull()
        return try Engine.run("picture", request, in: folder, name: "\(name)-request").json()
    }

    func original(_ name: String, _ width: Int, _ height: Int, type: UTType, orientation: Int) -> URL {
        let url = folder.appendingPathComponent(name)
        Samples.write([Samples.stored(Samples.marked(width, height), for: orientation)], to: url, type: type, orientation: orientation)
        return url
    }

    func testTurnedPicturesAreMadeUpright() throws {
        let jpeg = original("six.jpg", 1200, 800, type: .jpeg, orientation: 6)
        let heic = original("eight.heic", 1200, 800, type: .heic, orientation: 8)
        for (url, type, orientation) in [(jpeg, "image/jpeg", 6), (heic, "image/heic", 8)] {
            let stated = Samples.facts(url)
            XCTAssertEqual(stated["orientation"] as? Int, orientation)
            XCTAssertEqual([stated["width"] as? Int, stated["height"] as? Int], [800, 1200])
            XCTAssertNotEqual(stated["corners"] as? [String], Samples.upright)
            XCTAssertEqual(stated["shown"] as? [String], Samples.upright)
            XCTAssertEqual(stated["gps"] as? Bool, true)
            for (side, width, height) in [(640, 640, 427), (2560, 1200, 800), (nil, 1200, 800)] as [(Int?, Int, Int)] {
                let name = "\(orientation)-\(side.map(String.init) ?? "full").jpg"
                let result = try picture(url, type: type, side: side, to: name)
                XCTAssertEqual(result as NSDictionary, ["made": "jpeg"] as NSDictionary)
                let made = Samples.facts(folder.appendingPathComponent(name))
                Engine.keep(folder.appendingPathComponent(name), as: "picture-\(name)")
                let at = "\(type) at \(side.map(String.init) ?? "full")"
                XCTAssertEqual(made["type"] as? String, UTType.jpeg.identifier, at)
                XCTAssertEqual(made["width"] as? Int, width, at)
                XCTAssertEqual(Double(made["height"] as? Int ?? 0), Double(height), accuracy: 1, at)
                XCTAssertNil(made["orientation"], at)
                XCTAssertEqual(made["gps"] as? Bool, false, at)
                XCTAssertEqual(made["corners"] as? [String], Samples.upright, at)
            }
        }
    }

    func testSmallAndStaticPicturesAreMade() throws {
        let small = original("small.jpg", 400, 300, type: .jpeg, orientation: 6)
        XCTAssertEqual(try picture(small, type: "image/jpeg", side: 640, to: "small-made.jpg") as NSDictionary, ["made": "jpeg"])
        let webp = folder.appendingPathComponent("still.webp")
        try Samples.webp([Samples.stored(Samples.marked(400, 300), for: 6)], orientation: 6).write(to: webp)
        XCTAssertEqual(Samples.facts(webp)["shown"] as? [String], Samples.upright, "the synthetic WebP shows upright")
        XCTAssertEqual(try picture(webp, type: "image/webp", side: 640, to: "webp-made.jpg") as NSDictionary, ["made": "jpeg"])
        let gif = original("still.gif", 400, 300, type: .gif, orientation: 1)
        XCTAssertEqual(try picture(gif, type: "image/gif", side: 640, to: "gif-made.jpg") as NSDictionary, ["made": "jpeg"])
        for name in ["small-made.jpg", "webp-made.jpg", "gif-made.jpg"] {
            let made = Samples.facts(folder.appendingPathComponent(name))
            XCTAssertEqual([made["width"] as? Int, made["height"] as? Int], [400, 300], name)
            XCTAssertNil(made["orientation"], name)
            XCTAssertEqual(made["gps"] as? Bool, false, name)
            XCTAssertEqual(made["corners"] as? [String], Samples.upright, name)
        }
        let clear = folder.appendingPathComponent("clear.png")
        Samples.write([Samples.marked(1600, 1200, clear: true)], to: clear, type: .png, orientation: nil)
        XCTAssertEqual(try picture(clear, type: "image/png", side: 640, to: "clear-made.png") as NSDictionary, ["made": "png"])
        let made = Samples.facts(folder.appendingPathComponent("clear-made.png"))
        XCTAssertEqual(made["type"] as? String, UTType.png.identifier)
        XCTAssertEqual([made["width"] as? Int, made["height"] as? Int], [640, 480])
        XCTAssertEqual(made["alpha"] as? Bool, true)
        let opaque = folder.appendingPathComponent("opaque.png")
        Samples.write([Samples.marked(1600, 1200)], to: opaque, type: .png, orientation: nil)
        XCTAssertEqual(Samples.facts(opaque)["alpha"] as? Bool, true)
        for side in [640, nil] as [Int?] {
            let name = "opaque-made-\(side.map(String.init) ?? "full").png"
            XCTAssertEqual(try picture(opaque, type: "image/png", side: side, to: name) as NSDictionary, ["made": "png"], name)
            XCTAssertEqual(Samples.facts(folder.appendingPathComponent(name))["type"] as? String, UTType.png.identifier, name)
        }
    }

    func testAnimationsAreLeftToMove() throws {
        let frames = [0, 7].map { Samples.marked(200, 150, shift: $0) }
        let gif = folder.appendingPathComponent("moving.gif")
        Samples.write(frames, to: gif, type: .gif, orientation: nil)
        let webp = folder.appendingPathComponent("moving.webp")
        try Samples.webp(frames).write(to: webp)
        for (url, type) in [(gif, "image/gif"), (webp, "image/webp")] {
            XCTAssertEqual(Samples.facts(url)["frames"] as? Int, 2, type)
            XCTAssertEqual(try picture(url, type: type, side: 640, to: "\(type.dropFirst(6))-made") as NSDictionary, ["animated": true], type)
            XCTAssertFalse(FileManager.default.fileExists(atPath: path("\(type.dropFirst(6))-made")), type)
        }
    }

    func testAPosterIsUpright() async throws {
        let movie = folder.appendingPathComponent("turned.mov")
        try await Samples.movie(Samples.stored(Samples.marked(640, 480), for: 6), to: movie)
        for (side, width, height) in [(320, 320, 240), (nil, 640, 480)] as [(Int?, Int, Int)] {
            let name = "poster-\(side.map(String.init) ?? "full").jpg"
            XCTAssertEqual(try picture(movie, type: "video/quicktime", side: side, to: name) as NSDictionary, ["made": "jpeg"])
            Engine.keep(folder.appendingPathComponent(name), as: "picture-\(name)")
            let made = Samples.facts(folder.appendingPathComponent(name))
            XCTAssertEqual([made["width"] as? Int, made["height"] as? Int], [width, height], name)
            XCTAssertNil(made["orientation"], name)
            XCTAssertEqual(made["corners"] as? [String], Samples.upright, name)
        }
    }

    func testAPosterIsAtOneSecond() async throws {
        let movie = folder.appendingPathComponent("long.mov")
        try await Samples.movie(Samples.stored(Samples.marked(640, 480), for: 6), to: movie, frames: 40, perSecond: 2) { $0 == 2 }
        XCTAssertEqual(try picture(movie, type: "video/quicktime", side: 320, to: "long-poster.jpg") as NSDictionary, ["made": "jpeg"])
        Engine.keep(folder.appendingPathComponent("long-poster.jpg"), as: "picture-long-poster.jpg")
        XCTAssertEqual(Samples.facts(folder.appendingPathComponent("long-poster.jpg"))["corners"] as? [String], Samples.upright)
    }

    func testBytesThatAreNoneCannot() throws {
        let none = folder.appendingPathComponent("none")
        try Data("synthetic bytes that are no picture\n".utf8).write(to: none)
        for type in ["image/jpeg", "video/mp4"] {
            let result = try picture(none, type: type, side: 640, to: "none-made")
            XCTAssertEqual(Array(result.keys), ["cannot"], type)
            XCTAssertFalse((result["cannot"] as? String ?? "").isEmpty, type)
            XCTAssertFalse(FileManager.default.fileExists(atPath: path("none-made")), type)
        }
    }

    func testAPosterFailsOnlyForAFileThatIsNoMovie() {
        for code in [AVError.Code.fileFormatNotRecognized, .fileFailedToParse, .decoderNotFound, .noImageAtTime, .contentIsUnavailable] {
            XCTAssertTrue(Upright.noMovie(AVError(code)), "\(code.rawValue)")
        }
        for error in [AVError(.outOfMemory), AVError(.unknown), AVError(.diskFull), NSError(domain: NSPOSIXErrorDomain, code: Int(EIO)),
                      NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoSuchFileError)] as [Error] {
            XCTAssertFalse(Upright.noMovie(error), "\(error)")
        }
    }

    func testBadRequestsAreRefused() throws {
        let jpeg = original("bad.jpg", 200, 100, type: .jpeg, orientation: 1)
        for (type, side) in [("image/jpeg", 0), ("text/plain", 640)] {
            let run = try Engine.run("picture", ["from": jpeg.path, "to": path("bad-made.jpg"), "type": type, "side": side], in: folder)
            XCTAssertEqual(run.status, 2, "\(type) \(side)")
            XCTAssertFalse(run.resultExists)
        }
        let unwritable = try Engine.run("picture", ["from": jpeg.path, "to": path("no/such/folder/made.jpg"), "type": "image/jpeg", "side": 640], in: folder)
        XCTAssertEqual(unwritable.status, 1)
        let missing = try Engine.run("picture", ["from": path("missing.jpg"), "to": path("missing-made.jpg"), "type": "image/jpeg", "side": 640], in: folder, name: "missing")
        XCTAssertEqual(missing.status, 1)
    }
}
