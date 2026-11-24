import Foundation

enum Settings {
    static let detectSizes = [1280, 640, 320]
    static let largeFace = 128.0
    static let detectThreshold = 0.45
    static let overlapThreshold = 0.4
    static let batch = 32
    static let tiers = [
        Tier(name: "seed", score: 0.60, size: 80, blur: 50),
        Tier(name: "assign", score: 0.45, size: 40, blur: 12),
    ]
    static let observe = "observe"
    static let version = 1

    struct Tier: Codable, Equatable {
        let name: String
        let score: Double
        let size: Double
        let blur: Double
    }

    static func tier(score: Double, size: Double, blur: Double) -> String {
        tiers.first { score >= $0.score && size >= $0.size && blur >= $0.blur }?.name ?? observe
    }

    struct Description: Codable, Equatable {
        var version = Settings.version
        var detector = ModelFile.detector.sha256
        var recognizer = ModelFile.recognizer.sha256
        var detect_sizes = Settings.detectSizes
        var large_face = Settings.largeFace
        var detect_threshold = Settings.detectThreshold
        var overlap_threshold = Settings.overlapThreshold
        var tiers = Settings.tiers
    }
}

final class Models: @unchecked Sendable {
    private struct Sessions {
        let detectors: [Int: Session]
        let recognizer: Session
    }

    private let paths: (detector: String, recognizer: String)
    private var open: [Runtime: Sessions] = [:]
    private var current: Runtime
    private let fallback: Bool
    private let lock = NSLock()

    static func detectorOutputs(_ side: Int) -> [Int] {
        let anchors = [8, 16, 32].map { 2 * (side / $0) * (side / $0) }
        return anchors + anchors.map { $0 * 4 } + anchors.map { $0 * 10 }
    }

    init(directory: String, only: Runtime? = nil) throws {
        paths = (try ModelFile.detector.verified(in: directory), try ModelFile.recognizer.verified(in: directory))
        current = only ?? .cpu
        fallback = only == nil
        if let only {
            open[only] = try Self.sessions(paths, only)
            return
        }
        let cpu = try Self.sessions(paths, .cpu)
        do {
            let gpu = try Self.sessions(paths, .gpu)
            if let disagreement = try Self.probe(gpu, against: cpu) {
                log("the GPU disagrees with the CPU on the probe (\(disagreement)); scanning on the CPU")
                open[.cpu] = cpu
            } else {
                open[.gpu] = gpu
                current = .gpu
            }
        } catch {
            log("the GPU cannot run the models (\(error)); scanning on the CPU")
            open[.cpu] = cpu
        }
    }

    func detect(_ inputs: [DetectorInput]) throws -> [Detect.Square] {
        try run { sessions in
            try inputs.map { input in
                guard let session = sessions.detectors[input.side] else {
                    throw EngineError.failed("the detector has no \(input.side) square")
                }
                let outputs = try session.run(input.tensor, shape: [1, 3, input.side, input.side],
                                              outputs: Self.detectorOutputs(input.side))
                return Detect.Square(side: input.side, scaleX: input.scaleX, scaleY: input.scaleY, outputs: outputs)
            }
        }
    }

    func embed(_ input: [Float]) throws -> [Float] {
        try run { try $0.recognizer.run(input, shape: [Settings.batch, 3, 112, 112], outputs: [Settings.batch * 512])[0] }
    }

    private func run<T>(_ body: (Sessions) throws -> T) throws -> T {
        let (runtime, sessions) = lock.withLock { (current, open[current]!) }
        do {
            return try body(sessions)
        } catch where runtime == .gpu && fallback {
            log("the GPU failed a run (\(error)); scanning on the CPU from here")
            let cpu = try lock.withLock {
                current = .cpu
                if open[.cpu] == nil { open[.cpu] = try Self.sessions(paths, .cpu) }
                return open[.cpu]!
            }
            return try body(cpu)
        }
    }

    private static func sessions(_ paths: (detector: String, recognizer: String), _ runtime: Runtime) throws -> Sessions {
        Sessions(detectors: try Dictionary(uniqueKeysWithValues: Settings.detectSizes.map {
                     ($0, try Session(.detector, at: paths.detector, runtime: runtime, dimension: ("?", $0)))
                 }),
                 recognizer: try Session(.recognizer, at: paths.recognizer, runtime: runtime, dimension: ("None", Settings.batch)))
    }

    private static func probe(_ gpu: Sessions, against cpu: Sessions) throws -> String? {
        var seed: UInt32 = 12345
        func noise() -> Float {
            seed = seed &* 1_664_525 &+ 1_013_904_223
            return Float(seed >> 8) / Float(1 << 24) * 2 - 1
        }
        var delta: Float = 0
        for side in cpu.detectors.keys.sorted() {
            let image = (0..<(3 * side * side)).map { _ in noise() }
            let shape = [1, 3, side, side]
            for (a, b) in zip(try cpu.detectors[side]!.run(image, shape: shape, outputs: detectorOutputs(side)),
                              try gpu.detectors[side]!.run(image, shape: shape, outputs: detectorOutputs(side))) {
                for (x, y) in zip(a, b) { delta = max(delta, abs(x - y)) }
            }
        }
        if !(delta <= 1e-3) { return "detector outputs differ by \(delta)" }
        let faces = (0..<(Settings.batch * 3 * 112 * 112)).map { _ in noise() }
        let faceShape = [Settings.batch, 3, 112, 112]
        let a = try cpu.recognizer.run(faces, shape: faceShape, outputs: [Settings.batch * 512])[0]
        let b = try gpu.recognizer.run(faces, shape: faceShape, outputs: [Settings.batch * 512])[0]
        for row in 0..<Settings.batch {
            let cosine = Vector.cosine(a[(row * 512)..<((row + 1) * 512)], b[(row * 512)..<((row + 1) * 512)])
            if !(cosine >= 0.9999) { return "recognizer outputs have cosine \(cosine)" }
        }
        return nil
    }
}

enum Vector {
    static func cosine(_ a: ArraySlice<Float>, _ b: ArraySlice<Float>) -> Float {
        var dot: Float = 0, na: Float = 0, nb: Float = 0
        for (x, y) in zip(a, b) {
            dot += x * y
            na += x * x
            nb += y * y
        }
        return dot / max((na * nb).squareRoot(), 1e-12)
    }
}
