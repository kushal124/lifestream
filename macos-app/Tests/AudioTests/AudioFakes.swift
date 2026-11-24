import AVFoundation
import CoreMedia
import Evidence
import Foundation
@testable import Audio

enum SyntheticAudio {
    static let rate = AudioFormat.sampleRate

    static func chunk(frame: Int, frames: Int, at: Date) -> AudioChunk {
        var samples = [Int16](repeating: 0, count: frames)
        var noise = UInt32(truncatingIfNeeded: frame &* 2_654_435_761 &+ 1)
        for index in 0..<frames {
            let t = Double(frame + index) / Double(rate)
            noise = noise &* 1_664_525 &+ 1_013_904_223
            let hiss = Double(Int32(bitPattern: noise >> 16 & 0xFFFF) - 32_768) / 32_768
            let syllable = 0.5 + 0.5 * sin(2 * .pi * 4 * t)
            let voice = sin(2 * .pi * 180 * t) + 0.5 * sin(2 * .pi * 720 * t) + 0.3 * sin(2 * .pi * 1_900 * t)
            samples[index] = Int16(max(-32_000, min(32_000, 6_000 * syllable * voice + 1_500 * hiss)))
        }
        let buffer = PCMSampleBuffer.make(samples, presentationTime: CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(rate)))!
        return AudioChunk(buffer: buffer, at: at, duration: Double(frames) / Double(rate))
    }

    static func silence(seconds: Double, from frame: Int, at: Date) -> [AudioChunk] {
        let size = rate / 10
        let count = Int((seconds * Double(rate)).rounded()) / size
        return (0..<count).map { index in
            let buffer = PCMSampleBuffer.make([Int16](repeating: 0, count: size),
                                              presentationTime: CMTime(value: CMTimeValue(frame + index * size),
                                                                       timescale: CMTimeScale(rate)))!
            return AudioChunk(buffer: buffer, at: at.addingTimeInterval(Double(index * size) / Double(rate)),
                              duration: Double(size) / Double(rate))
        }
    }

    static func chunks(seconds: Double, from frame: Int = 0, at: Date) -> [AudioChunk] {
        let size = rate / 10
        let count = Int((seconds * Double(rate)).rounded()) / size
        return (0..<count).map { index in
            chunk(frame: frame + index * size, frames: size, at: at.addingTimeInterval(Double(index * size) / Double(rate)))
        }
    }
}

extension PCMSampleBuffer {
    static func make(_ samples: [Int16], presentationTime: CMTime) -> CMSampleBuffer? {
        make(count: samples.count, presentationTime: presentationTime) { destination in
            for (index, sample) in samples.enumerated() { destination[index] = sample }
        }
    }
}

final class PooledMicrophone: AudioSource, @unchecked Sendable {

    private(set) var dropped = 0
    private var handoff: SampleHandoff?
    private let free: DispatchSemaphore
    private let lock = NSLock()
    private var slots: [UnsafeMutableRawPointer]
    private let slotBytes: Int
    private let start = CMClockGetTime(CMClockGetHostTimeClock())

    init(buffers: Int, frames: Int) {
        slotBytes = frames * 2
        slots = (0..<buffers).map { _ in UnsafeMutableRawPointer.allocate(byteCount: frames * 2, alignment: 16) }
        free = DispatchSemaphore(value: buffers)
    }

    deinit {
        for slot in slots { slot.deallocate() }
    }

    func start(_ capture: AudioCapture, queue: DispatchQueue, deliver: @escaping (AudioChunk) -> Void,
               failed: @escaping (String) -> Void) throws {
        handoff = SampleHandoff(recorder: queue, clock: { CMClockGetHostTimeClock() }, deliver: deliver)
    }

    func stop() {
        handoff = nil
    }

    func play(seconds: Double, from frame: Int) {
        guard let handoff else { return }
        let frames = slotBytes / 2
        for index in 0..<Int((seconds * Double(AudioFormat.sampleRate)).rounded()) / frames {
            guard free.wait(timeout: .now() + waitLimit) == .success else {
                dropped += 1
                continue
            }
            let first = frame + index * frames
            guard let buffer = filled(from: first, frames: frames) else { return }
            handoff.queue.async { handoff.take(buffer) }
        }
        handoff.queue.sync {}
    }

    private func filled(from frame: Int, frames: Int) -> CMSampleBuffer? {
        let samples = SyntheticAudio.chunk(frame: frame, frames: frames, at: Date()).buffer
        guard let format = CMSampleBufferGetFormatDescription(samples), let data = CMSampleBufferGetDataBuffer(samples) else {
            return nil
        }
        let memory = lock.withLock { slots.removeLast() }
        CMBlockBufferCopyDataBytes(data, atOffset: 0, dataLength: slotBytes, destination: memory)
        var source = CMBlockBufferCustomBlockSource(
            version: kCMBlockBufferCustomBlockSourceVersion, AllocateBlock: nil,
            FreeBlock: { pool, memory, _ in
                Unmanaged<PooledMicrophone>.fromOpaque(pool!).takeUnretainedValue().release(memory)
            },
            refCon: Unmanaged.passUnretained(self).toOpaque())
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: memory, blockLength: slotBytes, blockAllocator: nil,
                                           customBlockSource: &source, offsetToData: 0, dataLength: slotBytes, flags: 0,
                                           blockBufferOut: &block)
        var buffer: CMSampleBuffer?
        let time = CMTimeAdd(start, CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(AudioFormat.sampleRate)))
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: block!, formatDescription: format, sampleCount: frames,
            presentationTimeStamp: time, packetDescriptions: nil, sampleBufferOut: &buffer)
        return buffer
    }

    private func release(_ memory: UnsafeMutableRawPointer) {
        lock.withLock { slots.append(memory) }
        free.signal()
    }
}

final class FakeAudioSource: AudioSource, @unchecked Sendable {
    private(set) var started: [String] = []
    private(set) var stops = 0
    var failNextStart = false
    private var queue: DispatchQueue?
    private var deliver: ((AudioChunk) -> Void)?
    private var failed: ((String) -> Void)?

    func start(_ capture: AudioCapture, queue: DispatchQueue, deliver: @escaping (AudioChunk) -> Void,
               failed: @escaping (String) -> Void) throws {
        switch capture {
        case .microphone(let uid): started.append(uid)
        case .sound: started.append("sound")
        }
        if failNextStart {
            failNextStart = false
            throw MicrophoneSourceError.input
        }
        self.queue = queue
        self.deliver = deliver
        self.failed = failed
    }

    func stop() {
        stops += 1
        deliver = nil
    }

    var capturing: Bool { deliver != nil }

    func push(_ chunks: [AudioChunk]) {
        guard let queue, let deliver else { return }
        for chunk in chunks { queue.async { deliver(chunk) } }
    }

    func breakCapture() {
        guard let queue, let failed else { return }
        queue.async { failed("synthetic runtime error") }
    }
}

enum Uses {
    static let microphone = AudioDeviceFacts(uid: "synthetic-input-uid", name: "Synthetic Microphone", transport: "built_in")
    static let headset = AudioDeviceFacts(uid: "synthetic-headset-uid", name: "Synthetic Headset", transport: "bluetooth")
    static let speakers = AudioDeviceFacts(uid: "synthetic-output-uid", name: "Synthetic Speakers", transport: "built_in")
    static let camera = CameraFacts(uid: "synthetic-camera-uid", name: "Synthetic Camera")

    static let speakersAtHalf = DeviceLevel(device: speakers, volume: 0.5, muted: false)
    static let microphoneAtThreeQuarters = DeviceLevel(device: microphone, volume: 0.75, muted: false)

    static func use(at: Date, holders: [(String, AudioDeviceFacts?)] = [], players: [String] = [],
                    input: AudioDeviceFacts? = microphone, defaultRunning: Bool = false,
                    inputVolume: Double = 0.75, output: DeviceLevel = speakersAtHalf,
                    cameras: [CameraFacts] = []) -> DeviceUse {
        let microphone = holders.enumerated().map { index, holder in
            AudioClient(pid: Int32(500 + index), app: holder.0, rawApp: holder.0, device: holder.1)
        }
        let sound = players.enumerated().map { index, app in
            AudioClient(pid: Int32(600 + index), app: app, rawApp: app, device: speakers)
        }
        let level = DeviceLevel(device: input, volume: input.map { _ in inputVolume }, muted: input.map { _ in false })
        return DeviceUse(at: at, audio: AudioUse(microphone: microphone, sound: sound, output: output, input: level,
                                                 defaultInputRunning: defaultRunning),
                         cameras: cameras)
    }

    static func unreadable(at: Date) -> DeviceUse {
        DeviceUse(at: at, audio: nil, cameras: nil)
    }
}

enum Instants {
    static func date(_ spelling: String) -> Date {
        guard let date = UTCInstant.date(rfc3339: spelling) else { fatalError("\(spelling) is not an instant") }
        return date
    }
}
