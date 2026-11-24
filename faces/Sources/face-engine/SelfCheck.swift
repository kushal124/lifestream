import Foundation

enum SelfCheck {
    struct Request: Decodable {
        let models: String
        let reference: String
    }

    struct Result: Encodable {
        let ok: Bool
        let tolerance = Tolerance()
        let runtimes: [Check]
    }

    struct Tolerance: Encodable {
        var box = 0.5
        var landmarks = 0.5
        var score = 0.005
        var cosine = 0.999
    }

    struct Check: Encodable {
        let runtime: Runtime
        let ok: Bool
        var reason: String?
        var faces = 0
        var box = 0.0
        var landmarks = 0.0
        var score = 0.0
        var cosine = 1.0
    }

    static func run(_ request: Request) throws -> Result {
        let expectedPath = (request.reference as NSString).appendingPathComponent("expected.json")
        guard let data = FileManager.default.contents(atPath: expectedPath) else {
            throw EngineError.request("cannot read \(expectedPath)")
        }
        let expected: Scan.Result
        do { expected = try JSONDecoder().decode(Scan.Result.self, from: data) } catch {
            throw EngineError.request("\(expectedPath): \(error)")
        }
        let photos = expected.photos.map {
            Scan.Request.Photo(key: $0.key, path: (request.reference as NSString).appendingPathComponent($0.key))
        }
        let referenceVectors = try expected.photos.map { try vectors(of: $0, in: request.reference) }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("face-engine-\(UUID().uuidString)").path
        defer { try? FileManager.default.removeItem(atPath: output) }
        try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)

        let checks = try Runtime.allCases.map { runtime -> Check in
            guard expected.pipeline == Settings.Description() else {
                return Check(runtime: runtime, ok: false, reason: "the reference numbers belong to another pipeline")
            }
            let scanned: Scan.Result
            do {
                scanned = try Scan.scan(photos, models: Models(directory: request.models, only: runtime), output: output)
            } catch let error as EngineError {
                if case .request = error { throw error }
                return Check(runtime: runtime, ok: false, reason: error.description)
            }
            return try compare(scanned, expected, referenceVectors, output: output, runtime: runtime)
        }
        return Result(ok: checks.allSatisfy(\.ok), runtimes: checks)
    }

    private static func compare(_ scanned: Scan.Result, _ expected: Scan.Result, _ references: [[Float]],
                                output: String, runtime: Runtime) throws -> Check {
        var check = Check(runtime: runtime, ok: true)
        let tolerance = Tolerance()
        for (index, (got, want)) in zip(scanned.photos, expected.photos).enumerated() {
            let gotFaces = got.faces ?? [], wantFaces = want.faces ?? []
            guard got.status == want.status, gotFaces.count == wantFaces.count else {
                return Check(runtime: runtime, ok: false,
                             reason: "\(want.key): \(gotFaces.count) faces (\(got.status)), not \(wantFaces.count) (\(want.status))")
            }
            let vectors = try Self.vectors(of: got, in: output)
            for (face, (a, b)) in zip(gotFaces, wantFaces).enumerated() {
                check.faces += 1
                check.box = max(check.box, zip(a.box, b.box).map { abs($0 - $1) }.max()!)
                check.landmarks = max(check.landmarks, zip(a.landmarks.joined(), b.landmarks.joined()).map { abs($0 - $1) }.max()!)
                check.score = max(check.score, abs(a.score - b.score))
                let row = (face * 512)..<((face + 1) * 512)
                check.cosine = min(check.cosine, Double(Vector.cosine(vectors[row], references[index][row])))
            }
        }
        let within = check.box <= tolerance.box && check.landmarks <= tolerance.landmarks
            && check.score <= tolerance.score && check.cosine >= tolerance.cosine
        if !within {
            return Check(runtime: runtime, ok: false, reason: "outside the tolerance", faces: check.faces,
                         box: check.box, landmarks: check.landmarks, score: check.score, cosine: check.cosine)
        }
        return check
    }

    private static func vectors(of photo: Scan.Photo, in folder: String) throws -> [Float] {
        guard let name = photo.vectors else { return [] }
        let path = (folder as NSString).appendingPathComponent(name)
        guard let data = FileManager.default.contents(atPath: path), data.count == (photo.faces?.count ?? 0) * 2048 else {
            throw EngineError.request("cannot read \(path) as \(photo.faces?.count ?? 0) vectors")
        }
        return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }
}
