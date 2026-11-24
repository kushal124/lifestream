import AVFoundation
import DeviceFiles
import Evidence
import Foundation

public enum AudioDiagnostics {
    public struct TestRecording: Sendable {
        public let file: URL
        public let track: AudioTrack
        public let device: String?
        public let seconds: Double
        public let bytes: Int
        public let latencyMs: Int?
        public let chunks: Int
        public var bytesPerHour: Int { seconds > 0 ? Int(Double(bytes) / seconds * 3600) : 0 }
    }

    public static func testRecording(_ track: AudioTrack, seconds: Double, into directory: URL,
                                     files: DeviceFiles) throws -> TestRecording {
        let capture: AudioCapture
        switch track {
        case .mic:
            guard let uid = AVCaptureDevice.default(for: .audio)?.uniqueID else { throw AudioDiagnosticsError.noInput }
            capture = .microphone(uid: uid)
        case .sound:
            capture = .sound
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let queue = DispatchQueue(label: "org.lifestreamprotocol.audio.test")
        let file = directory.appendingPathComponent("\(track.rawValue)-test-\(UTCInstant.basic(Date())).m4a")
        let writer = try AudioSegmentWriter(url: file)
        let source = AudioSources.live()[track]
        let asked = Date()
        var first: Date?
        var chunks = 0
        var failure: String?
        try source.start(capture, queue: queue, deliver: { chunk in
            if first == nil { first = Date() }
            chunks += 1
            do { try writer.append(chunk) } catch { failure = "\(error)" }
        }, failed: { message in failure = message })
        Thread.sleep(forTimeInterval: seconds)
        try queue.sync {
            source.stop()
            try writer.finish()
        }
        if let failure { throw AudioDiagnosticsError.capture(failure) }
        let bytes = FileManager.default.fileExists(atPath: file.path) ? try files.size(of: file) : 0
        var device: String?
        if case .microphone(let uid) = capture { device = uid }
        return TestRecording(file: file, track: track, device: device, seconds: writer.duration, bytes: bytes,
                             latencyMs: first.map { Int(($0.timeIntervalSince(asked) * 1000).rounded()) },
                             chunks: queue.sync { chunks })
    }
}

public enum AudioDiagnosticsError: Error, CustomStringConvertible {
    case noInput
    case capture(String)

    public var description: String {
        switch self {
        case .noInput: return "no input device is available"
        case .capture(let why): return "the test recording failed: \(why)"
        }
    }
}
