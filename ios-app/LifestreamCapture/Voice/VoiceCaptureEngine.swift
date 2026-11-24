import AVFoundation
import Foundation
import LifestreamCaptureCore

enum VoiceCaptureError: Error, LocalizedError, Equatable {
    case notRecording
    case recorderRefused
    case noBytes

    var errorDescription: String? {
        switch self {
        case .notRecording: "No recording is in progress."
        case .recorderRefused: "The microphone did not start recording."
        case .noBytes: "The recorder produced no audio."
        }
    }
}

@MainActor
protocol VoiceCaptureSession: AnyObject {
    var isActive: Bool { get }
    var currentTime: TimeInterval { get }
    var isStalled: Bool { get }
    func prime() async throws
    func discard()
    func level() -> Float
    func finish(mode: VoiceNoteMode, reason: String) throws -> VoiceNoteSnapshot
    func releaseSession()
}

@MainActor
final class VoiceCaptureEngine: VoiceCaptureSession {
    enum Permission: Equatable {
        case undetermined
        case granted
        case denied
    }

    static var permission: Permission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .granted
        case .denied: .denied
        default: .undetermined
        }
    }

    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    let encoder = VoiceEncoderSettings.aacMono48k

    private let session = DispatchQueue(label: "org.lifestreamprotocol.phone.voice-session")
    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var startedAt: Date?
    private var primedAtUptime: TimeInterval = 0

    private var sessionTaken = false

    var isActive: Bool { recorder != nil }

    var currentTime: TimeInterval { recorder?.currentTime ?? 0 }

    nonisolated static func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        if session.category != .playAndRecord || session.mode != .default
            || !session.categoryOptions.contains(.defaultToSpeaker) {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        }
        try session.setActive(true)
    }

    func releaseSession() {
        guard sessionTaken, recorder == nil else { return }
        sessionTaken = false
        session.async {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    func prime() async throws {
        discard()
        sessionTaken = true
        let encoder = encoder
        let opened: Opened = try await withCheckedThrowingContinuation { continuation in
            session.async {
                continuation.resume(with: Result(catching: { try Self.open(encoder) }))
            }
        }
        recorder = opened.recorder
        fileURL = opened.url
        startedAt = opened.startedAt
        primedAtUptime = opened.uptime
        EnergyLedger.shared.hold("microphone", setting: "recording")
    }

    private struct Opened: @unchecked Sendable {
        let recorder: AVAudioRecorder
        let url: URL
        let startedAt: Date
        let uptime: TimeInterval
    }

    private nonisolated static func open(_ encoder: VoiceEncoderSettings) throws -> Opened {
        try activateSession()
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(UUID().uuidString)")
            .appendingPathExtension(encoder.fileExtension)
        let recorder = try AVAudioRecorder(url: url, settings: encoder.avSettings)
        recorder.isMeteringEnabled = true
        guard recorder.prepareToRecord(), recorder.record() else {
            try? FileManager.default.removeItem(at: url)
            throw VoiceCaptureError.recorderRefused
        }
        return Opened(recorder: recorder, url: url, startedAt: AppClock.now, uptime: ProcessInfo.processInfo.systemUptime)
    }

    var isStalled: Bool {
        guard let recorder, recorder.isRecording else { return false }
        let running = ProcessInfo.processInfo.systemUptime - primedAtUptime
        return running >= 0.3 && recorder.currentTime < running * 0.5
    }

    func discard() {
        recorder?.stop()
        EnergyLedger.shared.hold("microphone", setting: nil)
        if let fileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
        recorder = nil
        fileURL = nil
        startedAt = nil
    }

    func level() -> Float {
        guard let recorder else { return 0 }
        recorder.updateMeters()
        let decibels = recorder.averagePower(forChannel: 0)
        let floor: Float = -50
        return max(0, min(1, (decibels - floor) / -floor))
    }

    func finish(mode: VoiceNoteMode, reason: String) throws -> VoiceNoteSnapshot {
        guard let recorder, let fileURL, let startedAt else {
            throw VoiceCaptureError.notRecording
        }
        let input = Self.currentInput()
        let durationSeconds = recorder.currentTime
        let endedAt = AppClock.now
        defer {
            self.recorder = nil
            self.fileURL = nil
            self.startedAt = nil
        }
        recorder.stop()
        EnergyLedger.shared.hold("microphone", setting: nil)
        let file = OwnedMediaFile(takingOwnershipOf: fileURL)
        guard try FileDurability.regularFileSize(at: fileURL) > 0 else { throw VoiceCaptureError.noBytes }
        return VoiceNoteSnapshot(
            file: file,
            encoder: encoder,
            startedAt: startedAt,
            endedAt: endedAt,
            durationSeconds: durationSeconds,
            mode: mode,
            endReason: reason,
            input: input
        )
    }

    private static func currentInput() -> VoiceInputRoute? {
        guard let port = AVAudioSession.sharedInstance().currentRoute.inputs.first else {
            return nil
        }
        return VoiceInputRoute(portType: port.portType.rawValue, portName: port.portName)
    }
}

@MainActor
final class SyntheticVoiceCapture: VoiceCaptureSession {
    static let encoder = VoiceEncoderSettings(
        format: "pcm_s16le",
        container: "wav",
        mimeType: "audio/wav",
        fileExtension: "wav",
        sampleRateHz: 16_000,
        channels: 1,
        bitRate: 256_000
    )

    private var startedAt: Date?
    private var startedUptime: TimeInterval = 0

    var isActive: Bool { startedAt != nil }

    var currentTime: TimeInterval { isActive ? ProcessInfo.processInfo.systemUptime - startedUptime : 0 }

    var isStalled: Bool { false }

    func prime() async throws {
        discard()
        startedAt = AppClock.now
        startedUptime = ProcessInfo.processInfo.systemUptime
    }

    func discard() {
        startedAt = nil
    }

    func level() -> Float {
        isActive ? Float(Self.swell(currentTime)) : 0
    }

    func releaseSession() {}

    func finish(mode: VoiceNoteMode, reason: String) throws -> VoiceNoteSnapshot {
        guard let startedAt else { throw VoiceCaptureError.notRecording }
        let durationSeconds = currentTime
        self.startedAt = nil
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(UUID().uuidString)")
            .appendingPathExtension(Self.encoder.fileExtension)
        try FileDurability.writeNewRegularFileDurably(ChatAudio.wav(Self.signal(seconds: durationSeconds)), to: url)
        return VoiceNoteSnapshot(
            file: OwnedMediaFile(takingOwnershipOf: url),
            encoder: Self.encoder,
            startedAt: startedAt,
            endedAt: AppClock.now,
            durationSeconds: durationSeconds,
            mode: mode,
            endReason: reason,
            input: nil
        )
    }

    private static func swell(_ seconds: TimeInterval) -> Double {
        0.2 + 0.6 * abs(sin(seconds * 2))
    }

    private static func signal(seconds: TimeInterval) -> Data {
        let rate = Double(encoder.sampleRateHz)
        let samples = (0..<Int(seconds * rate)).map { n -> Int16 in
            let at = Double(n) / rate
            return Int16(swell(at) * 12_000 * sin(at * 2 * .pi * 220)).littleEndian
        }
        return samples.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}
