import CoreGraphics
import Foundation

enum Scan {
    struct Request: Decodable {
        let models: String
        let output: String
        let photos: [Photo]

        struct Photo: Decodable {
            let key: String
            let path: String
        }
    }

    struct Result: Codable {
        var pipeline = Settings.Description()
        let photos: [Photo]
    }

    struct Photo: Codable {
        let key: String
        let status: String
        var reason: String?
        var width: Int?
        var height: Int?
        var faces: [Face]?
        var vectors: String?
    }

    struct Face: Codable {
        let box: [Double]
        let landmarks: [[Double]]
        let score: Double
        let size: Double
        let tier: String
        let crop: String?
    }

    static let cropSide = 160
    static let cropMargin = 0.25

    static func run(_ request: Request) throws -> Result {
        try checkKeys(request.photos.map(\.key))
        if request.photos.isEmpty { return Result(photos: []) }
        do {
            try FileManager.default.createDirectory(atPath: request.output, withIntermediateDirectories: true)
        } catch {
            throw EngineError.failed("cannot create \(request.output): \(error.localizedDescription)")
        }
        return try scan(request.photos, models: Models(directory: request.models), output: request.output)
    }

    static func scan(_ photos: [Request.Photo], models: Models, output: String) throws -> Result {
        let count = photos.count
        let decoded = Slots<Decoded>(count)
        let finished = Slots<Finished>(count)
        let ahead = DispatchSemaphore(value: 6)
        let failure = Failure()
        let decoders = DispatchQueue(label: "decode", attributes: .concurrent)
        let finishers = DispatchQueue(label: "finish", attributes: .concurrent)

        Thread.detachNewThread {
            for (index, photo) in photos.enumerated() {
                ahead.wait()
                decoders.async { autoreleasepool {
                    do {
                        let data = try Data(contentsOf: URL(fileURLWithPath: photo.path))
                        decoded.put(index, Picture.decode(data).map { picture in
                            Ready(picture: picture, inputs: Settings.detectSizes.map { picture.detectorInput(side: $0) })
                        })
                    } catch {
                        failure.set(EngineError.failed("cannot read \(photo.path): \(error.localizedDescription)"))
                        decoded.put(index, .failure(Unreadable("")))
                    }
                } }
            }
        }
        Thread.detachNewThread {
            for index in 0..<count { autoreleasepool {
                switch decoded.take(index) {
                case .failure(let unreadable):
                    finished.put(index, .failure(unreadable))
                    ahead.signal()
                case .success(let ready):
                    let detections: [Detection]
                    do {
                        detections = Detect.faces(try models.detect(ready.inputs))
                    } catch {
                        failure.set(error)
                        detections = []
                    }
                    finishers.async { autoreleasepool {
                        do {
                            finished.put(index, .success(try finish(ready.picture, detections, key: photos[index].key,
                                                                    output: output)))
                        } catch {
                            failure.set(error)
                            finished.put(index, .failure(Unreadable("")))
                        }
                        ahead.signal()
                    } }
                }
            } }
        }

        var results: [Photo] = []
        var vectors: [[[Float]]] = Array(repeating: [], count: count)
        var batch = [Float](repeating: 0, count: Settings.batch * 3 * 112 * 112)
        var pending: [(photo: Int, face: Int)] = []
        func embed() throws {
            if pending.isEmpty { return }
            let raw = try autoreleasepool { try models.embed(batch) }
            for (slot, owner) in pending.enumerated() {
                var vector = Array(raw[(slot * 512)..<((slot + 1) * 512)])
                let norm = vector.reduce(0) { $0 + $1 * $1 }.squareRoot()
                guard norm.isFinite, norm > 0 else { throw EngineError.failed("the recognizer returned no vector") }
                for i in vector.indices { vector[i] /= norm }
                vectors[owner.photo][owner.face] = vector
            }
            pending.removeAll()
            batch = [Float](repeating: 0, count: batch.count)
        }
        for index in 0..<count {
            let outcome = finished.take(index)
            if let error = failure.error { throw error }
            switch outcome {
            case .failure(let unreadable):
                results.append(Photo(key: photos[index].key, status: "unreadable", reason: unreadable.reason))
            case .success(let scanned):
                results.append(scanned.photo)
                vectors[index] = Array(repeating: [], count: scanned.aligned.count)
                for (face, aligned) in scanned.aligned.enumerated() {
                    aligned.write(into: &batch, slot: pending.count)
                    pending.append((index, face))
                    if pending.count == Settings.batch { try embed() }
                }
            }
        }
        try embed()
        for (index, photo) in results.enumerated() where !(photo.faces ?? []).isEmpty {
            let path = (output as NSString).appendingPathComponent(photo.vectors!)
            let bytes = vectors[index].flatMap { $0 }.withUnsafeBufferPointer { Data(buffer: $0) }
            do { try bytes.write(to: URL(fileURLWithPath: path), options: .atomic) } catch {
                throw EngineError.failed("cannot write \(path): \(error.localizedDescription)")
            }
        }
        return Result(photos: results)
    }

    private static func finish(_ picture: Picture, _ detections: [Detection], key: String, output: String) throws -> Scanned {
        var faces: [(face: Detection, size: Double, aligned: AlignedFace, tier: String)] = []
        var keys = Set<String>()
        let bounds = [Double(picture.width), Double(picture.height), Double(picture.width), Double(picture.height)]
        for detection in detections {
            var face = detection
            face.box = zip(face.box, bounds).map { rounded(min(max($0, 0), $1), 2) }
            face.landmarks = face.landmarks.map { $0.map { rounded($0, 2) } }
            face.score = rounded(face.score, 4)
            let size = min(face.box[2] - face.box[0], face.box[3] - face.box[1])
            guard size >= 1, keys.insert(faceKey(key, face.box)).inserted else { continue }
            let aligned = AlignedFace(picture, landmarks: detection.landmarks)
            faces.append((face, rounded(size, 2), aligned, Settings.tier(score: face.score, size: size, blur: aligned.blur)))
        }
        faces.sort { ($0.face.box[1], $0.face.box[0], $0.face.box[3], $0.face.box[2]) < ($1.face.box[1], $1.face.box[0], $1.face.box[3], $1.face.box[2]) }
        let image = faces.contains { $0.tier != Settings.observe } ? picture.image : nil
        var entries: [Face] = []
        for (index, entry) in faces.enumerated() {
            var crop: String?
            if entry.tier != Settings.observe, let image {
                crop = "\(key)-\(index).jpg"
                let data = jpeg(image, region: cropRegion(entry.face.box, picture), width: cropSide, height: cropSide, quality: 0.85)
                let path = (output as NSString).appendingPathComponent(crop!)
                do { try data.write(to: URL(fileURLWithPath: path), options: .atomic) } catch {
                    throw EngineError.failed("cannot write \(path): \(error.localizedDescription)")
                }
            }
            entries.append(Face(box: entry.face.box, landmarks: entry.face.landmarks, score: entry.face.score,
                                size: entry.size, tier: entry.tier, crop: crop))
        }
        let photo = Photo(key: key, status: "ok", width: picture.width, height: picture.height, faces: entries,
                          vectors: entries.isEmpty ? nil : "\(key).f32")
        return Scanned(photo: photo, aligned: faces.map(\.aligned))
    }

    private static func cropRegion(_ box: [Double], _ picture: Picture) -> CGRect {
        let pad = max(box[2] - box[0], box[3] - box[1]) * cropMargin
        let x1 = max(0, (box[0] - pad).rounded(.down)), y1 = max(0, (box[1] - pad).rounded(.down))
        let x2 = min(Double(picture.width), (box[2] + pad).rounded(.down))
        let y2 = min(Double(picture.height), (box[3] + pad).rounded(.down))
        let side = max(1, min(x2 - x1, y2 - y1))
        return CGRect(x: ((x1 + x2 - side) / 2).rounded(.down), y: ((y1 + y2 - side) / 2).rounded(.down),
                      width: side, height: side)
    }

    static func checkKeys(_ keys: [String]) throws {
        var seen = Set<String>()
        for key in keys {
            guard key.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil else {
                throw EngineError.request("photo key \"\(key)\" is not a plain file name")
            }
            guard seen.insert(key).inserted else { throw EngineError.request("photo key \(key) appears twice") }
        }
    }

    private typealias Decoded = Swift.Result<Ready, Unreadable>
    private typealias Finished = Swift.Result<Scanned, Unreadable>

    private struct Ready {
        let picture: Picture
        let inputs: [DetectorInput]
    }

    private struct Scanned {
        let photo: Photo
        let aligned: [AlignedFace]
    }
}

func faceKey(_ photo: String, _ box: [Double]) -> String {
    "\(photo):" + box.map { String(Int($0.rounded())) }.joined(separator: ",")
}

func rounded(_ value: Double, _ places: Int) -> Double {
    let scale = pow(10, Double(places))
    return (value * scale).rounded() / scale
}

final class Slots<T>: @unchecked Sendable {
    private var values: [T?]
    private let condition = NSCondition()

    init(_ count: Int) { values = Array(repeating: nil, count: count) }

    func put(_ index: Int, _ value: T) {
        condition.lock()
        values[index] = value
        condition.broadcast()
        condition.unlock()
    }

    func take(_ index: Int) -> T {
        condition.lock()
        defer { condition.unlock() }
        while values[index] == nil { condition.wait() }
        let value = values[index]!
        values[index] = nil
        return value
    }
}

final class Failure: @unchecked Sendable {
    private var first: Error?
    private let lock = NSLock()

    func set(_ error: Error) { lock.withLock { if first == nil { first = error } } }
    var error: Error? { lock.withLock { first } }
}
