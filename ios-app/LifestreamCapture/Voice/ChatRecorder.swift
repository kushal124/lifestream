@preconcurrency import AVFoundation
import Foundation
import HomeLink
import LifestreamCaptureCore
import UIKit

@MainActor
final class ChatRecorder: ObservableObject {
    enum Phase: Equatable {
        case idle
        case asking
        case recording
        case stopped
    }

    struct Note: Equatable {
        let id: String
        let seconds: Int
        let ms: Int
        let levels: [Double]
    }

    static let second = 32_000
    static let shortest = 8_000

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var owner: String?
    @Published private(set) var levels: [Double] = []
    @Published private(set) var samples = 0
    @Published var said: String?

    private(set) var note: String?
    private var filling = Data()
    private var posted = 0
    private var tenth: [Int16] = []
    private var limit = 0
    private let microphone: any ChatMicrophone
    private let giveBack: () -> Void
    private let permission: () -> VoiceCaptureEngine.Permission
    private let askPermission: @MainActor () async -> Bool
    private let outbox: AskOutbox
    private var watching: [NSObjectProtocol] = []
    private var line: AsyncStream<[Int16]>.Continuation?
    private var listening: Task<Void, Never>?

    static let microphoneOff = "Voice notes need the microphone. Allow it for Lifestream in Settings."
    static let unkept = "Couldn't keep your voice note on this iPhone. Free some space."

    init(outbox: AskOutbox, microphone: (any ChatMicrophone)? = nil,
         permission: @escaping () -> VoiceCaptureEngine.Permission = { AppRuntime.isUITesting ? .granted : VoiceCaptureEngine.permission },
         askPermission: @escaping @MainActor () async -> Bool = { await VoiceCaptureEngine.requestPermission() },
         giveBack: @escaping () -> Void = { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }) {
        self.outbox = outbox
        self.microphone = microphone ?? (AppRuntime.isUITesting ? SyntheticMicrophone() : EngineMicrophone())
        self.permission = permission
        self.askPermission = askPermission
        self.giveBack = giveBack
        let center = NotificationCenter.default
        watching = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.halt() }
            },
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
                let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
                MainActor.assumeIsolated { self?.halt() }
            },
        ]
    }

    var ms: Int { samples / 16 }

    func holds(_ owner: String) -> Bool {
        self.owner == owner && (phase == .recording || phase == .stopped)
    }

    func start(for owner: String, unready: String?, limits: HomeLink.Ask.Ready.Limits) {
        guard phase == .idle else { return }
        if let unready { return said = unready }
        limit = limits.voiceMs
        switch permission() {
        case .granted:
            record(for: owner)
        case .denied:
            said = Self.microphoneOff
        case .undetermined:
            phase = .asking
            self.owner = owner
            Task { [weak self] in
                guard let granted = await self?.askPermission(), let self, self.phase == .asking else { return }
                self.phase = .idle
                if granted { self.record(for: owner) } else { self.said = Self.microphoneOff }
            }
        }
    }

    private func record(for owner: String) {
        let note = HomeLink.Ask.mint()
        guard outbox.open(note: note) else { return said = Self.unkept }
        let (stream, line) = AsyncStream<[Int16]>.makeStream()
        do {
            try microphone.start { line.yield($0) }
        } catch {
            line.finish()
            outbox.cancel(note: note)
            said = "The microphone did not start recording."
            return
        }
        self.line = line
        listening = Task { [weak self] in
            for await samples in stream { self?.heard(samples, of: note) }
        }
        self.note = note
        self.owner = owner
        said = nil
        filling = Data()
        tenth = []
        posted = 0
        levels = []
        samples = 0
        phase = .recording
        EnergyLedger.shared.hold("microphone", setting: "recording")
    }

    func heard(_ heard: [Int16], of note: String) {
        guard phase == .recording || phase == .stopped, self.note == note else { return }
        let room = max(0, limit * 16 - samples)
        let taken = heard.prefix(room)
        samples += taken.count
        taken.withUnsafeBufferPointer { filling.append(Data(buffer: $0)) }
        tenth.append(contentsOf: taken)
        while tenth.count >= 1_600 {
            levels.append(Self.level(tenth.prefix(1_600)))
            tenth.removeFirst(1_600)
        }
        _ = handOver(note, whole: true)
        if samples >= limit * 16 { halt() }
    }

    private func handOver(_ note: String, whole: Bool) -> Bool {
        while filling.count >= Self.second || (!whole && !filling.isEmpty) {
            let part = Data(filling.prefix(Self.second))
            guard outbox.second(note: note, posted, part) else {
                said = Self.unkept
                return false
            }
            if said == Self.unkept { said = nil }
            filling.removeFirst(part.count)
            posted += 1
        }
        return true
    }

    func halt() {
        guard phase == .recording else {
            if phase == .asking { phase = .idle }
            return
        }
        release()
        phase = .stopped
    }

    func take() async -> Note? {
        guard phase == .recording || phase == .stopped, let note else { return nil }
        release()
        phase = .stopped
        await listening?.value
        guard self.note == note else { return nil }
        if samples < Self.shortest {
            cancel()
            return nil
        }
        guard handOver(note, whole: false) else { return nil }
        let taken = Note(id: note, seconds: posted, ms: ms, levels: Self.bars(levels))
        guard outbox.close(note: note, ms: taken.ms, levels: taken.levels) else {
            said = Self.unkept
            return nil
        }
        return taken
    }

    func sent(_ note: String) {
        guard self.note == note else { return }
        listening = nil
        reset()
    }

    func cancel() {
        guard let note else {
            if phase == .asking { phase = .idle }
            return
        }
        release()
        listening?.cancel()
        listening = nil
        outbox.cancel(note: note)
        reset()
    }

    private func release() {
        guard line != nil else { return }
        microphone.stop()
        line?.finish()
        line = nil
        EnergyLedger.shared.hold("microphone", setting: nil)
        giveBack()
    }

    private func reset() {
        note = nil
        owner = nil
        phase = .idle
        filling = Data()
        tenth = []
        posted = 0
        levels = []
        samples = 0
    }

    nonisolated static func level<Samples: Collection>(_ samples: Samples) -> Double where Samples.Element == Int16 {
        guard !samples.isEmpty else { return 0 }
        let power = samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(samples.count)
        let decibels = 10 * log10(max(power, 1) / (32_768.0 * 32_768.0))
        return min(1, max(0, (decibels + 50) / 50))
    }

    nonisolated static func bars(_ levels: [Double], count: Int = 40) -> [Double] {
        guard levels.count > count else { return levels }
        return (0..<count).map { bar in
            let from = bar * levels.count / count
            let to = max(from + 1, (bar + 1) * levels.count / count)
            return levels[from..<to].max() ?? 0
        }
    }

    nonisolated static func time(ms: Int) -> String {
        let seconds = ms / 1000
        return "\(seconds / 60):" + String(format: "%02d", seconds % 60)
    }
}

protocol ChatMicrophone: AnyObject {
    func start(_ heard: @escaping @Sendable ([Int16]) -> Void) throws
    func stop()
}

final class EngineMicrophone: ChatMicrophone {
    private let engine = AVAudioEngine()

    func start(_ heard: @escaping @Sendable ([Int16]) -> Void) throws {
        try VoiceCaptureEngine.activateSession()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: target) else { throw VoiceCaptureError.recorderRefused }
        input.installTap(onBus: 0, bufferSize: 4_096, format: format, block: Self.tap(converter, target, heard))
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private nonisolated static func tap(_ converter: AVAudioConverter, _ target: AVAudioFormat,
                                        _ heard: @escaping @Sendable ([Int16]) -> Void) -> AVAudioNodeTapBlock {
        { buffer, _ in
            let ratio = target.sampleRate / buffer.format.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var given = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if given {
                    status.pointee = .noDataNow
                    return nil
                }
                given = true
                status.pointee = .haveData
                return buffer
            }
            guard error == nil, let channel = out.int16ChannelData, out.frameLength > 0 else { return }
            heard(Array(UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength))))
        }
    }
}

final class SyntheticMicrophone: ChatMicrophone {
    private var task: Task<Void, Never>?

    func start(_ heard: @escaping @Sendable ([Int16]) -> Void) throws {
        task = Task.detached {
            var n = 0
            while !Task.isCancelled {
                let swell = 0.2 + 0.6 * abs(sin(Double(n) / 5))
                heard((0..<1_600).map { Int16(swell * 12_000 * sin(Double($0) * 2 * .pi * 220 / 16_000)) })
                n += 1
                await Task.yield()
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}

enum ChatAudio {
    static func wav(_ pcm: Data) -> Data {
        var header = Data()
        func word(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
        func half(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
        header.append(contentsOf: Array("RIFF".utf8))
        word(UInt32(36 + pcm.count))
        header.append(contentsOf: Array("WAVEfmt ".utf8))
        word(16)
        half(1)
        half(1)
        word(16_000)
        word(32_000)
        half(2)
        half(16)
        header.append(contentsOf: Array("data".utf8))
        word(UInt32(pcm.count))
        return header + pcm
    }
}
