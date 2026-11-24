import Foundation
import XCTest

final class CommandTests: EngineTestCase {
    func testUnreadableRequests() throws {
        let notJSON = folder.appendingPathComponent("bad.json")
        try Data("{ not json".utf8).write(to: notJSON)
        let wrongShape = folder.appendingPathComponent("shape.json")
        try Data(#"{"photos": "many"}"#.utf8).write(to: wrongShape)
        let result = path("result.json")
        for arguments in [
            ["scan", path("missing.json"), result], ["group", notJSON.path, result], ["draw", wrongShape.path, result],
            ["self-check", wrongShape.path, result], ["read", wrongShape.path, result], ["make", notJSON.path, result],
            ["paint", notJSON.path, result], ["scan", notJSON.path],
        ] {
            let run = try Engine.run(arguments)
            XCTAssertEqual(run.status, 2, "\(arguments)")
            XCTAssertFalse(FileManager.default.fileExists(atPath: result), "\(arguments)")
        }
    }

    func testUnwritableResult() throws {
        let request = folder.appendingPathComponent("request.json")
        try Data(#"{"images": []}"#.utf8).write(to: request)
        let run = try Engine.run(["draw", request.path, path("no/such/folder/result.json")])
        XCTAssertEqual(run.status, 1)
    }

    func testBothRuntimesPass() throws {
        try Engine.requireModels()
        let run = try Engine.run("self-check", ["models": Engine.models.path, "reference": Engine.reference.path], in: folder)
        let result = try run.json()
        Engine.keep(run.resultFile, as: "self-check.json")
        XCTAssertEqual(result["ok"] as? Bool, true, "\(result)")
        let runtimes = result["runtimes"] as! [[String: Any]]
        XCTAssertEqual(runtimes.map { $0["runtime"] as! String }, ["gpu", "cpu"])
        for runtime in runtimes {
            XCTAssertEqual(runtime["ok"] as? Bool, true)
            XCTAssertEqual(runtime["faces"] as? Int, 15)
        }
    }

    func testReferenceOfAnotherPipeline() throws {
        let reference = folder.appendingPathComponent("reference")
        try FileManager.default.copyItem(at: Engine.reference, to: reference)
        let expected = reference.appendingPathComponent("expected.json")
        var json = try JSONSerialization.jsonObject(with: Data(contentsOf: expected)) as! [String: Any]
        var pipeline = json["pipeline"] as! [String: Any]
        pipeline["detect_threshold"] = 0.5
        json["pipeline"] = pipeline
        try JSONSerialization.data(withJSONObject: json).write(to: expected)
        let request = ["models": Engine.models.path, "reference": reference.path]
        let result = try Engine.run("self-check", request, in: folder).json()
        XCTAssertEqual(result["ok"] as? Bool, false)
        for runtime in result["runtimes"] as! [[String: Any]] {
            XCTAssertEqual(runtime["reason"] as? String, "the reference numbers belong to another pipeline")
        }
        try FileManager.default.removeItem(at: expected)
        XCTAssertEqual(try Engine.run("self-check", request, in: folder, name: "bare").status, 2)
    }
}
