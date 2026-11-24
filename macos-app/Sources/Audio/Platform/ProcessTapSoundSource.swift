import AVFoundation
import CoreAudio
import CoreMedia
import Evidence
import Foundation

public enum SoundSourceError: Error, Equatable, CustomStringConvertible {
    case tap(OSStatus)
    case aggregate(OSStatus)
    case format(OSStatus)
    case start(OSStatus)
    case notSound

    public var description: String {
        switch self {
        case .tap(let status): return "the sound tap could not be created (\(status))"
        case .aggregate(let status): return "the sound tap's device could not be created (\(status))"
        case .format(let status): return "the sound tap states no format (\(status))"
        case .start(let status): return "the sound tap could not start (\(status))"
        case .notSound: return "this source captures the Mac's sound only"
        }
    }
}

public final class ProcessTapSoundSource: AudioSource, @unchecked Sendable {
    static let aggregateUID = "org.lifestreamprotocol.sound-tap"
    static let fallbackUID = "org.lifestreamprotocol.sound-tap-2"

    static let bufferFrames: UInt32 = 2048

    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var proc: AudioDeviceIOProcID?
    private var generation: UInt64 = 0
    private var converter: TapConverter?

    public init() {}

    public func start(_ capture: AudioCapture, queue: DispatchQueue,
                      deliver: @escaping (AudioChunk) -> Void, failed: @escaping (String) -> Void) throws {
        stop()
        guard capture == .sound else { throw SoundSourceError.notSound }
        do {
            let format = try createTapAndDevice()
            generation &+= 1
            let current = generation
            let converter = TapConverter(source: format)
            self.converter = converter
            var created: AudioDeviceIOProcID?
            let status = AudioDeviceCreateIOProcIDWithBlock(&created, aggregate, nil) { [weak self] _, input, inputTime, _, _ in
                let copied = TapBuffer(input, hostTime: inputTime.pointee)
                queue.async {
                    guard let self, self.generation == current, let copied else { return }
                    let chunks = ResourceMeter.shared.measure(.audioSound, units: 0) { converter.convert(copied) }
                    for chunk in chunks { deliver(chunk) }
                }
            }
            guard status == noErr, let created else { throw SoundSourceError.start(status) }
            proc = created
            let started = AudioDeviceStart(aggregate, created)
            guard started == noErr else { throw SoundSourceError.start(started) }
        } catch {
            stop()
            throw error
        }
    }

    public func stop() {
        generation &+= 1
        converter = nil
        if let proc, aggregate != kAudioObjectUnknown {
            AudioDeviceStop(aggregate, proc)
            AudioDeviceDestroyIOProcID(aggregate, proc)
        }
        proc = nil
        if aggregate != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregate) }
        aggregate = AudioObjectID(kAudioObjectUnknown)
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
        tap = AudioObjectID(kAudioObjectUnknown)
    }


    private func createTapAndDevice() throws -> AudioStreamBasicDescription {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: Self.ownProcessObject().map { [$0] } ?? [])
        description.name = "Lifestream sound"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        var status = AudioHardwareCreateProcessTap(description, &tap)
        guard status == noErr, tap != kAudioObjectUnknown else { throw SoundSourceError.tap(status) }

        for uid in [Self.aggregateUID, Self.fallbackUID] {
            let device: [String: Any] = [
                kAudioAggregateDeviceNameKey: "Lifestream sound",
                kAudioAggregateDeviceUIDKey: uid,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString,
                                                   kAudioSubTapDriftCompensationKey: true]],
                kAudioAggregateDeviceTapAutoStartKey: true,
            ]
            aggregate = AudioObjectID(kAudioObjectUnknown)
            status = AudioHardwareCreateAggregateDevice(device as CFDictionary, &aggregate)
            if status == noErr, aggregate != kAudioObjectUnknown { break }
        }
        guard status == noErr, aggregate != kAudioObjectUnknown else { throw SoundSourceError.aggregate(status) }

        var frames = Self.bufferFrames
        var buffer = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyBufferFrameSize,
                                                mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        _ = AudioObjectSetPropertyData(aggregate, &buffer, 0, nil, UInt32(MemoryLayout<UInt32>.size), &frames)

        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        status = AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format)
        guard status == noErr else { throw SoundSourceError.format(status) }
        return format
    }

    private static func ownProcessObject() -> AudioObjectID? {
        var pid = ProcessInfo.processInfo.processIdentifier
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                                UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object)
        return status == noErr && object != kAudioObjectUnknown ? object : nil
    }
}

struct TapBuffer {
    let channels: [(count: UInt32, data: Data)]
    let hostTime: UInt64?

    init?(_ list: UnsafePointer<AudioBufferList>, hostTime stamp: AudioTimeStamp) {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        var channels: [(UInt32, Data)] = []
        for buffer in buffers {
            guard let bytes = buffer.mData, buffer.mDataByteSize > 0 else { continue }
            channels.append((buffer.mNumberChannels, Data(bytes: bytes, count: Int(buffer.mDataByteSize))))
        }
        guard !channels.isEmpty else { return nil }
        self.channels = channels
        hostTime = stamp.mFlags.contains(.hostTimeValid) ? stamp.mHostTime : nil
    }

    init(channels: [(count: UInt32, data: Data)], hostTime: UInt64?) {
        self.channels = channels
        self.hostTime = hostTime
    }
}

final class TapConverter {
    static let holeThreshold: TimeInterval = 0.1

    private let source: AudioStreamBasicDescription
    private let resampler: AVAudioConverter?
    private let input: AVAudioFormat?
    private let output: AVAudioFormat?
    private var mono: AVAudioPCMBuffer?
    private var resampled: AVAudioPCMBuffer?
    private var anchor: (host: Double, wall: Date)?
    private var consumed = 0
    private var written = 0
    private let rate = Double(AudioFormat.sampleRate)

    init(source: AudioStreamBasicDescription) {
        self.source = source
        input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: source.mSampleRate, channels: 1, interleaved: false)
        output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(AudioFormat.sampleRate), channels: 1,
                               interleaved: false)
        if let input, let output, abs(source.mSampleRate - Double(AudioFormat.sampleRate)) >= 1 {
            resampler = AVAudioConverter(from: input, to: output)
        } else {
            resampler = nil
        }
    }

    func convert(_ buffer: TapBuffer) -> [AudioChunk] {
        guard source.mSampleRate > 0, let mono = mixToMono(buffer) else { return [] }
        let host = buffer.hostTime.map { Double(AudioConvertHostTimeToNanos($0)) / 1e9 }
            ?? Double(AudioConvertHostTimeToNanos(AudioGetCurrentHostTime())) / 1e9
        if anchor == nil {
            let now = Double(AudioConvertHostTimeToNanos(AudioGetCurrentHostTime())) / 1e9
            anchor = (host, Date().addingTimeInterval(-(max(0, now - host))))
        }
        var chunks: [AudioChunk] = []
        let expected = anchor!.host + Double(consumed) / source.mSampleRate
        if host - expected > Self.holeThreshold {
            var left = Int(((host - expected) * rate).rounded())
            while left > 0 {
                let size = min(left, Int(rate))
                if let chunk = chunk(size, fill: { $0.update(repeating: 0, count: size) }) { chunks.append(chunk) }
                left -= size
            }
            consumed += Int(((host - expected) * source.mSampleRate).rounded())
        }
        consumed += Int(mono.frameLength)
        if let chunk = resample(mono) { chunks.append(chunk) }
        return chunks
    }

    private func chunk(_ count: Int, fill: (UnsafeMutablePointer<Int16>) -> Void) -> AudioChunk? {
        guard count > 0, let anchor else { return nil }
        let offset = Double(written) / rate
        let pts = CMTimeAdd(CMTime(seconds: anchor.host, preferredTimescale: 1_000_000_000),
                            CMTime(value: CMTimeValue(written), timescale: CMTimeScale(AudioFormat.sampleRate)))
        guard let buffer = PCMSampleBuffer.make(count: count, presentationTime: pts, fill: fill) else { return nil }
        written += count
        return AudioChunk(buffer: buffer, at: anchor.wall.addingTimeInterval(offset), duration: Double(count) / rate)
    }

    private func mixToMono(_ buffer: TapBuffer) -> AVAudioPCMBuffer? {
        guard source.mFormatID == kAudioFormatLinearPCM, let input else { return nil }
        let isFloat = source.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let bits = Int(source.mBitsPerChannel)
        guard (isFloat && bits == 32) || (!isFloat && bits == 16) else { return nil }
        var frames = 0
        var mixed = 0
        for (count, data) in buffer.channels {
            let channels = max(Int(count), 1)
            let length = data.count / (isFloat ? 4 : 2) / channels
            if frames == 0, length > 0 {
                frames = length
                if (mono?.frameCapacity ?? 0) < AVAudioFrameCount(frames) {
                    mono = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: AVAudioFrameCount(frames))
                }
                mono?.floatChannelData?[0].update(repeating: 0, count: frames)
            }
            if let sum = mono?.floatChannelData?[0], frames > 0 {
                let shared = min(length, frames)
                data.withUnsafeBytes { bytes in
                    if isFloat {
                        let values = bytes.bindMemory(to: Float.self)
                        for frame in 0..<shared {
                            for channel in 0..<channels { sum[frame] += values[frame * channels + channel] }
                        }
                    } else {
                        let values = bytes.bindMemory(to: Int16.self)
                        for frame in 0..<shared {
                            for channel in 0..<channels { sum[frame] += Float(values[frame * channels + channel]) / 32_768 }
                        }
                    }
                }
            }
            mixed += channels
        }
        guard mixed > 0, frames > 0, let mono, let sum = mono.floatChannelData?[0] else { return nil }
        let scale = 1 / Float(mixed)
        for frame in 0..<frames { sum[frame] *= scale }
        mono.frameLength = AVAudioFrameCount(frames)
        return mono
    }

    private func resample(_ mono: AVAudioPCMBuffer) -> AudioChunk? {
        guard let resampler, let output else { return int16(mono) }
        let capacity = AVAudioFrameCount(Double(mono.frameLength) * rate / source.mSampleRate + 64)
        if (resampled?.frameCapacity ?? 0) < capacity {
            resampled = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity)
        }
        guard let resampled else { return nil }
        resampled.frameLength = 0
        var given = false
        var error: NSError?
        let status = resampler.convert(to: resampled, error: &error) { _, state in
            if given {
                state.pointee = .noDataNow
                return nil
            }
            given = true
            state.pointee = .haveData
            return mono
        }
        guard status != .error, error == nil else { return nil }
        return int16(resampled)
    }

    private func int16(_ floats: AVAudioPCMBuffer) -> AudioChunk? {
        guard let values = floats.floatChannelData?[0] else { return nil }
        let count = Int(floats.frameLength)
        return chunk(count) { samples in
            for index in 0..<count { samples[index] = Int16(max(-1, min(1, values[index])) * 32_767) }
        }
    }
}

enum PCMSampleBuffer {
    private static let format: CMAudioFormatDescription? = {
        var description = AudioStreamBasicDescription(
            mSampleRate: Double(AudioFormat.sampleRate), mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked, mBytesPerPacket: 2,
            mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var format: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: 0, layout: nil,
                                             magicCookieSize: 0, magicCookie: nil, extensions: nil,
                                             formatDescriptionOut: &format) == noErr else { return nil }
        return format
    }()

    static func make(count: Int, presentationTime: CMTime, fill: (UnsafeMutablePointer<Int16>) -> Void) -> CMSampleBuffer? {
        guard let format else { return nil }
        return make(bytes: count * 2, samples: count, format: format, presentationTime: presentationTime) { bytes in
            fill(bytes.assumingMemoryBound(to: Int16.self))
            return true
        }
    }

    static func copy(_ buffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard let data = CMSampleBufferGetDataBuffer(buffer), let format = CMSampleBufferGetFormatDescription(buffer) else {
            return nil
        }
        let length = CMBlockBufferGetDataLength(data)
        return make(bytes: length, samples: CMSampleBufferGetNumSamples(buffer), format: format,
                    presentationTime: CMSampleBufferGetPresentationTimeStamp(buffer)) { bytes in
            CMBlockBufferCopyDataBytes(data, atOffset: 0, dataLength: length, destination: bytes) == kCMBlockBufferNoErr
        }
    }

    private static func make(bytes length: Int, samples: Int, format: CMAudioFormatDescription, presentationTime: CMTime,
                             fill: (UnsafeMutableRawPointer) -> Bool) -> CMSampleBuffer? {
        guard length > 0 else { return nil }
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: length,
                                                 blockAllocator: nil, customBlockSource: nil, offsetToData: 0,
                                                 dataLength: length, flags: kCMBlockBufferAssureMemoryNowFlag,
                                                 blockBufferOut: &block) == noErr,
              let block else { return nil }
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: nil,
                                          dataPointerOut: &pointer) == kCMBlockBufferNoErr,
              let pointer, fill(UnsafeMutableRawPointer(pointer)) else { return nil }
        var buffer: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: samples,
            presentationTimeStamp: presentationTime, packetDescriptions: nil, sampleBufferOut: &buffer) == noErr else { return nil }
        return buffer
    }
}
