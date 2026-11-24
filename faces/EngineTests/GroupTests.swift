import CryptoKit
import Foundation
import XCTest

final class GroupTests: EngineTestCase {
    struct Library {
        let folder: URL
        var photos: [[String: Any]] = []
        var noise = 300

        mutating func photo(_ key: String, _ faces: [(direction: [Int: Float], tier: String)]) {
            var bytes = Data()
            var entries: [[String: Any]] = []
            for (index, face) in faces.enumerated() {
                var vector = [Float](repeating: 0, count: 512)
                for (axis, value) in face.direction { vector[axis] = value }
                vector[noise] = 0.25
                noise += 1
                let norm = vector.map { $0 * $0 }.reduce(0, +).squareRoot()
                vector = vector.map { $0 / norm }
                vector.withUnsafeBufferPointer { bytes.append(Data(buffer: $0)) }
                entries.append(["box": Self.box(index), "tier": face.tier])
            }
            let file = folder.appendingPathComponent("\(key).f32")
            try! bytes.write(to: file)
            photos.append(["key": key, "vectors": faces.isEmpty ? NSNull() : file.path as Any, "faces": entries])
        }

        static func box(_ index: Int) -> [Double] { [Double(10 + 100 * index), 10, Double(90 + 100 * index), 90] }
        static func key(_ photo: String, _ index: Int) -> String {
            "\(photo):" + box(index).map { String(Int($0)) }.joined(separator: ",")
        }
    }

    func library() -> Library { Library(folder: folder) }

    func group(_ library: Library, statements: [[String: Any]] = [], people: [String: String] = [:],
               bars: [String: Double]? = nil, name: String = "request") throws -> Engine.Run {
        var request: [String: Any] = ["photos": library.photos, "statements": statements, "people": people]
        if let bars { request["bars"] = bars }
        return try Engine.run("group", request, in: folder, name: name)
    }

    func outcome(_ result: [String: Any]) -> [String: (person: String, cluster: String)] {
        var out: [String: (String, String)] = [:]
        for photo in result["photos"] as! [[String: Any]] {
            for face in photo["faces"] as! [[String: Any]] {
                out[face["face"] as! String] = (face["person"] as! String, face["cluster"] as! String)
            }
        }
        return out
    }

    func statement(_ photo: String, _ index: Int, _ kind: [String: Any], shift: Double = 0) -> [String: Any] {
        ["photo": photo, "box": Library.box(index).map { $0 + shift }].merging(kind) { $1 }
    }

    let a: [Int: Float] = [0: 1], b: [Int: Float] = [1: 1], c: [Int: Float] = [2: 1]

    func anchored(_ library: inout Library, _ slug: String, _ direction: [Int: Float], count: Int,
                  prefix: String, tier: String = "seed") -> [[String: Any]] {
        (0..<count).map { index in
            library.photo("\(prefix)\(index)", [(direction, tier)])
            return statement("\(prefix)\(index)", 0, ["is": slug])
        }
    }

    func testStatementsFindTheirFaces() throws {
        var library = library()
        library.photo("p", [(a, "seed"), (b, "seed")])
        library.photo("q", [(c, "seed")])
        let statements = [
            statement("p", 0, ["is": "moved"], shift: 6),
            statement("p", 1, ["is": "exact"]),
            statement("p", 1, ["is": "near"], shift: 9),
            statement("q", 3, ["is": "nowhere"]),
            statement("elsewhere", 0, ["is": "nowhere"]),
        ]
        let run = try group(library, statements: statements)
        let result = try run.json()
        Engine.keep(run.resultFile, as: "group-statements.json")
        let faces = outcome(result)
        XCTAssertEqual(faces[Library.key("p", 0)]?.person, "moved")
        XCTAssertEqual(faces[Library.key("p", 1)]?.person, "exact")
        XCTAssertEqual(faces[Library.key("q", 0)]?.person, "")
        let unmatched = (result["unmatched"] as! [[String: Any]]).map { $0["photo"] as! String }
        XCTAssertEqual(unmatched, ["p", "q", "elsewhere"])
    }

    func testMergesAreFollowed() throws {
        var library = library()
        var statements = anchored(&library, "old", a, count: 3, prefix: "a")
        statements += anchored(&library, "mid", a, count: 2, prefix: "m")
        library.photo("new", [(a, "seed")])
        let faces = outcome(try group(library, statements: statements, people: ["old": "mid", "mid": "end"]).json())
        XCTAssertEqual(faces[Library.key("a0", 0)]?.person, "end")
        XCTAssertEqual(faces[Library.key("m0", 0)]?.person, "end")
        XCTAssertEqual(faces[Library.key("new", 0)]?.person, "end")
        let loop = try group(library, statements: statements, people: ["old": "mid", "mid": "old"], name: "loop")
        XCTAssertEqual(loop.status, 2)
        XCTAssertFalse(loop.resultExists)
    }

    func testAnchorsAndAssignment() throws {
        var library = library()
        let unusual: [Int: Float] = [0: 0.5, 3: 0.866]
        var statements = anchored(&library, "a", a, count: 25, prefix: "a")
        statements += anchored(&library, "a", unusual, count: 2, prefix: "u")
        library.photo("odd", [(b, "seed")])
        statements.append(statement("odd", 0, ["is": "a"]))
        library.photo("small", [(a, "observe")])
        statements.append(statement("small", 0, ["is": "a"]))
        statements += anchored(&library, "b", b, count: 5, prefix: "b")
        library.photo("x", [(a, "seed"), (unusual, "assign"), (a, "observe")])
        let faces = outcome(try group(library, statements: statements).json())
        XCTAssertEqual(faces[Library.key("odd", 0)]?.person, "a")
        XCTAssertEqual(faces[Library.key("small", 0)]?.person, "a")
        XCTAssertEqual(faces[Library.key("x", 0)]?.person, "a")
        XCTAssertEqual(faces[Library.key("x", 2)]?.person, "", "observe faces are never assigned")
        XCTAssertEqual(faces[Library.key("x", 2)]?.cluster, "")
        library.photo("y", [(unusual, "assign")])
        let again = outcome(try group(library, statements: statements, name: "again").json())
        XCTAssertEqual(again[Library.key("y", 0)]?.person, "a")
    }

    func testNotThisPersonHoldsTheFace() throws {
        var library = library()
        var statements = anchored(&library, "a", a, count: 5, prefix: "a")
        statements += anchored(&library, "b", b, count: 5, prefix: "b")
        library.photo("x", [([0: 1, 1: 0.85], "seed")])
        library.photo("y", [([0: 1, 1: 0.85], "seed")])
        statements.append(statement("x", 0, ["is_not": ["a"]]))
        let faces = outcome(try group(library, statements: statements).json())
        XCTAssertEqual(faces[Library.key("x", 0)]?.person, "", "neither a nor the runner-up b")
        XCTAssertEqual(faces[Library.key("y", 0)]?.person, "a")
    }

    func testIgnoredFacesStayOut() throws {
        var library = library()
        var statements = anchored(&library, "a", a, count: 5, prefix: "a")
        library.photo("x", [(a, "seed")])
        statements.append(statement("x", 0, ["ignore": true]))
        for key in ["s0", "s1", "s2"] {
            library.photo(key, [(c, "seed")])
            statements.append(statement(key, 0, ["ignore": true]))
        }
        let result = try group(library, statements: statements).json()
        let faces = outcome(result)
        XCTAssertEqual(faces[Library.key("x", 0)]?.person, "")
        XCTAssertEqual((result["clusters"] as! [Any]).count, 0)
        XCTAssertEqual(faces[Library.key("s0", 0)]?.cluster, "")
    }

    func testMarginAndBars() throws {
        var library = library()
        var statements = anchored(&library, "a", a, count: 5, prefix: "a")
        statements += anchored(&library, "b", b, count: 5, prefix: "b")
        library.photo("x", [([0: 1, 1: 0.97], "seed")])
        let result = try group(library, statements: statements).json()
        XCTAssertEqual(outcome(result)[Library.key("x", 0)]?.person, "")
        XCTAssertEqual(result["bars"] as? NSDictionary, ["edge": 0.64, "assign": 0.56, "margin": 0.08, "maybe": 0.48] as NSDictionary)
        let loose = try group(library, statements: statements, bars: ["margin": 0], name: "loose").json()
        XCTAssertEqual(outcome(loose)[Library.key("x", 0)]?.person, "a")
        XCTAssertEqual(loose["bars"] as? NSDictionary, ["edge": 0.64, "assign": 0.56, "margin": 0, "maybe": 0.48] as NSDictionary)
    }

    func testOnePersonPerPhoto() throws {
        var library = library()
        var statements = anchored(&library, "a", a, count: 5, prefix: "a")
        library.photo("two", [([0: 1, 5: 0.1], "seed"), ([0: 1, 5: 0.6], "seed")])
        library.photo("named", [(a, "seed"), (a, "seed")])
        statements.append(statement("named", 1, ["is": "a"]))
        let faces = outcome(try group(library, statements: statements).json())
        XCTAssertEqual(faces[Library.key("two", 0)]?.person, "a")
        XCTAssertEqual(faces[Library.key("two", 1)]?.person, "")
        XCTAssertEqual(faces[Library.key("named", 1)]?.person, "a")
        XCTAssertEqual(faces[Library.key("named", 0)]?.person, "")
    }

    func testClusters() throws {
        var library = library()
        for index in 0..<4 { library.photo("s\(index)", [(a, "seed")]) }
        library.photo("t0", [(b, "seed")])
        library.photo("t1", [(b, "seed")])
        library.photo("u0", [(c, "seed"), (c, "seed")])
        library.photo("u1", [(c, "seed")])
        library.photo("u2", [(c, "seed")])
        library.photo("v", [(a, "assign")])
        library.photo("w", [(a, "observe")])
        let run = try group(library)
        let result = try run.json()
        Engine.keep(run.resultFile, as: "group-clusters.json")
        let faces = outcome(result)
        let clusters = result["clusters"] as! [[String: Any]]
        XCTAssertEqual(clusters.map { $0["size"] as! Int }, [5, 3])
        let first = clusters[0]
        let lowest = Library.key("s0", 0)
        let id = SHA256.hash(data: Data(lowest.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16)
        XCTAssertEqual(first["id"] as? String, String(id))
        XCTAssertEqual(faces[Library.key("v", 0)]?.cluster, String(id))
        XCTAssertEqual(faces[Library.key("w", 0)]?.cluster, "")
        XCTAssertEqual(faces[Library.key("t0", 0)]?.cluster, "")
        let inSecond = faces.filter { $0.value.cluster == clusters[1]["id"] as! String }.map(\.key)
        XCTAssertEqual(inSecond.filter { $0.hasPrefix("u0:") }.count, 1, "one face of a photo per cluster")
    }

    func testTypical() throws {
        var library = library()
        for index in 0..<4 { library.photo("s\(index)", [(a, "seed")]) }
        library.photo("odd", [([0: 1, 7: 0.5], "seed")])
        library.photo("lone", [(b, "seed")])
        let run = try group(library)
        let result = try run.json()
        Engine.keep(run.resultFile, as: "group-typical.json")
        var typical: [String: Double] = [:]
        var outside: [String] = []
        for photo in result["photos"] as! [[String: Any]] {
            for face in photo["faces"] as! [[String: Any]] {
                if (face["cluster"] as! String).isEmpty {
                    XCTAssertNil(face["typical"], "a face outside every cluster states no typical")
                    outside.append(face["face"] as! String)
                } else {
                    typical[face["face"] as! String] = try XCTUnwrap(face["typical"] as? Double)
                }
            }
        }
        XCTAssertEqual(outside, [Library.key("lone", 0)])
        XCTAssertEqual(typical.count, 5)
        let unit = 1 / Double(1.0625).squareRoot(), odd = 1 / Double(1.3125).squareRoot()
        let sum = [4 * unit + odd, 0.5 * odd], noise = [0.25 * unit, 0.25 * unit, 0.25 * unit, 0.25 * unit, 0.25 * odd]
        let norm = (sum.map { $0 * $0 }.reduce(0, +) + noise.map { $0 * $0 }.reduce(0, +)).squareRoot()
        let expectedOdd = (odd * sum[0] + 0.5 * odd * sum[1] + 0.25 * odd * noise[4]) / norm
        XCTAssertEqual(typical[Library.key("odd", 0)]!, expectedOdd, accuracy: 0.0002)
        XCTAssertEqual(typical.min { $0.value < $1.value }?.key, Library.key("odd", 0))
        for value in typical.values { XCTAssertEqual(value, (value * 10_000).rounded() / 10_000) }
    }

    func testLookAlikeKeepsItsFaces() throws {
        var library = library()
        let statements = anchored(&library, "a", a, count: 10, prefix: "a")
        let alike: [Int: Float] = [0: 0.6, 4: 0.8]
        let distant: [Int: Float] = [0: 0.45, 4: 0.89]
        for index in 0..<4 { library.photo("s\(index)", [(distant, "seed")]) }
        library.photo("new0", [(alike, "seed")])
        library.photo("new1", [(alike, "assign")])
        let faces = outcome(try group(library, statements: statements).json())
        XCTAssertEqual(faces[Library.key("new0", 0)]?.person, "")
        XCTAssertEqual(faces[Library.key("new1", 0)]?.person, "")
        XCTAssertNotEqual(faces[Library.key("new0", 0)]?.cluster, "")
        XCTAssertEqual(faces[Library.key("new0", 0)]?.cluster, faces[Library.key("s0", 0)]?.cluster)
    }

    func testSuggestions() throws {
        var library = library()
        var statements = anchored(&library, "a", a, count: 5, prefix: "a")
        statements += anchored(&library, "b", b, count: 5, prefix: "b")
        for index in 0..<3 { library.photo("n\(index)", [([0: 0.5, 6: 0.866], "seed")]) }
        for index in 0..<3 { library.photo("f\(index)", [(c, "seed")]) }
        for index in 0..<3 { library.photo("d\(index)", [([1: 0.5, 8: 0.866], "seed")]) }
        statements.append(statement("d1", 0, ["is_not": ["b"]]))
        let run = try group(library, statements: statements)
        let result = try run.json()
        Engine.keep(run.resultFile, as: "group-suggestions.json")
        let faces = outcome(result)
        let clusters = Dictionary(uniqueKeysWithValues: (result["clusters"] as! [[String: Any]]).map {
            ($0["id"] as! String, $0["suggested"] as! [[String: Any]])
        })
        let near = try XCTUnwrap(clusters[faces[Library.key("n0", 0)]!.cluster])
        XCTAssertEqual(near.map { $0["person"] as? String }, ["a"])
        let score = try XCTUnwrap(near.first?["score"] as? Double)
        XCTAssertEqual(score, 0.5, accuracy: 0.05)
        XCTAssertEqual(score, (score * 10_000).rounded() / 10_000)
        XCTAssertEqual(clusters[faces[Library.key("f0", 0)]!.cluster]?.count, 0)
        XCTAssertEqual(clusters[faces[Library.key("d0", 0)]!.cluster]?.count, 0, "a person a face of the cluster is not")
        XCTAssertEqual(faces[Library.key("n0", 0)]?.person, "", "a suggestion never moves a face")
    }

    func testMaybe() throws {
        var library = library()
        var statements = anchored(&library, "a", a, count: 5, prefix: "a")
        statements += anchored(&library, "b", b, count: 5, prefix: "b")
        let near: [Int: Float] = [0: 0.58, 9: 0.815]
        library.photo("m", [(near, "assign")])
        library.photo("said", [(near, "seed")])
        statements.append(statement("said", 0, ["is_not": ["a"]]))
        library.photo("small", [(near, "observe")])
        library.photo("far", [([0: 0.2, 10: 0.98], "seed")])
        library.photo("taken", [(a, "seed")])
        let run = try group(library, statements: statements)
        let result = try run.json()
        Engine.keep(run.resultFile, as: "group-maybe.json")
        var maybes: [String: [String: Any]] = [:]
        for photo in result["photos"] as! [[String: Any]] {
            for face in photo["faces"] as! [[String: Any]] {
                if let maybe = face["maybe"] as? [String: Any] { maybes[face["face"] as! String] = maybe }
            }
        }
        XCTAssertEqual(Set(maybes.keys), [Library.key("m", 0)])
        let maybe = try XCTUnwrap(maybes[Library.key("m", 0)])
        XCTAssertEqual(maybe["person"] as? String, "a")
        let score = try XCTUnwrap(maybe["score"] as? Double)
        XCTAssertGreaterThanOrEqual(score, 0.48)
        XCTAssertLessThan(score, 0.56)
        XCTAssertEqual(outcome(result)[Library.key("m", 0)]?.person, "", "a maybe is no name")
        XCTAssertEqual(outcome(result)[Library.key("taken", 0)]?.person, "a")
        let loose = try group(library, statements: statements, bars: ["maybe": 0.1], name: "loose").json()
        let far = (loose["photos"] as! [[String: Any]]).first { $0["key"] as? String == "far" }!["faces"] as! [[String: Any]]
        XCTAssertEqual((far[0]["maybe"] as? [String: Any])?["person"] as? String, "a")
    }

    func testOrderDoesNotMatter() throws {
        var library = library()
        var statements = anchored(&library, "a", a, count: 5, prefix: "a")
        statements += anchored(&library, "b", b, count: 5, prefix: "b")
        for index in 0..<6 { library.photo("s\(index)", [(c, "seed"), (a, "assign")]) }
        let first = try group(library, statements: statements, name: "first")
        let second = try group(library, statements: statements, name: "second")
        var reversed = library
        reversed.photos.reverse()
        let third = try group(reversed, statements: statements.reversed(), name: "third")
        let bytes = try [first, second, third].map { try Data(contentsOf: $0.resultFile) }
        XCTAssertEqual(bytes[0], bytes[1])
        XCTAssertEqual(bytes[0], bytes[2])
    }

    func testEmptyLibrary() throws {
        let result = try group(library()).json()
        XCTAssertEqual((result["photos"] as! [Any]).count, 0)
        XCTAssertEqual((result["clusters"] as! [Any]).count, 0)
    }

    func testBadLibrariesAreRefused() throws {
        var library = library()
        library.photo("p", [(a, "seed"), (b, "seed")])
        let good = library.photos[0]
        func refused(_ photos: [[String: Any]], _ statements: [[String: Any]] = [], status: Int32 = 2,
                     line: UInt = #line) throws {
            var bad = library
            bad.photos = photos
            let run = try group(bad, statements: statements, name: "bad")
            XCTAssertEqual(run.status, status, run.stderr, line: line)
            XCTAssertFalse(run.resultExists, line: line)
        }
        func with(_ changes: [String: Any]) -> [String: Any] { good.merging(changes) { $1 } }
        try refused([with(["vectors": path("gone.f32")])], status: 1)
        try Data(count: 100).write(to: folder.appendingPathComponent("short.f32"))
        try refused([with(["vectors": path("short.f32")])])
        var nan = [Float](repeating: 0, count: 1024)
        nan[3] = .nan
        try nan.withUnsafeBufferPointer { Data(buffer: $0) }.write(to: folder.appendingPathComponent("nan.f32"))
        try refused([with(["vectors": path("nan.f32")])])
        try refused([good, good])
        let faces = good["faces"] as! [[String: Any]]
        try refused([with(["faces": [faces[0], faces[0]]])])
        try refused([with(["faces": [["box": [1, 2, 3], "tier": "seed"], faces[1]]])])
        try refused([with(["faces": [["box": faces[0]["box"]!, "tier": "great"], faces[1]]])])
        try refused([good], [["photo": "p", "box": Library.box(0)]])
        try refused([good], [["photo": "p", "box": Library.box(0), "is": "a", "ignore": true]])
    }
}
