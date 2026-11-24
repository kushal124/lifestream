import AVFoundation
import CoreAudio
import CoreMedia
import XCTest
@testable import Audio

final class TapConverterTests: XCTestCase {
    private let stereoFloat48k = AudioStreamBasicDescription(
        mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 8, mFramesPerPacket: 1,
        mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)

    private func buffer(frames: Int, at seconds: Double, base: UInt64) -> TapBuffer {
        var samples = [Float](repeating: 0, count: frames * 2)
        for frame in 0..<frames {
            let value = Float(0.5 * sin(2 * .pi * 440 * Double(frame) / 48_000))
            samples[frame * 2] = value
            samples[frame * 2 + 1] = value
        }
        let host = base + AudioConvertNanosToHostTime(UInt64(seconds * 1e9))
        return TapBuffer(channels: [(2, samples.withUnsafeBufferPointer { Data(buffer: $0) })], hostTime: host)
    }

    private func frames(_ chunks: [AudioChunk]) -> Int {
        chunks.map { CMSampleBufferGetNumSamples($0.buffer) }.reduce(0, +)
    }

    func testStereoFloatAtTheDeviceRateBecomesMono16BitAtTheFileRate() throws {
        let converter = TapConverter(source: stereoFloat48k)
        let base = AudioGetCurrentHostTime()
        var chunks: [AudioChunk] = []
        for index in 0..<100 { chunks += converter.convert(buffer(frames: 480, at: Double(index) * 0.01, base: base)) }
        let description = try XCTUnwrap(CMSampleBufferGetFormatDescription(chunks[0].buffer)
            .flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee })
        XCTAssertEqual(description.mSampleRate, 16_000)
        XCTAssertEqual(description.mChannelsPerFrame, 1)
        XCTAssertEqual(description.mBitsPerChannel, 16)
        XCTAssertEqual(Double(frames(chunks)), 16_000, accuracy: 200, "one second in is one second out")
        var peak: Int16 = 0
        for chunk in chunks {
            var length = 0
            var pointer: UnsafeMutablePointer<CChar>?
            CMBlockBufferGetDataPointer(CMSampleBufferGetDataBuffer(chunk.buffer)!, atOffset: 0, lengthAtOffsetOut: nil,
                                        totalLengthOut: &length, dataPointerOut: &pointer)
            pointer!.withMemoryRebound(to: Int16.self, capacity: length / 2) { samples in
                for index in 0..<length / 2 { peak = max(peak, abs(samples[index])) }
            }
        }
        XCTAssertEqual(Double(peak), 0.5 * 32_767, accuracy: 1_500, "both channels mix to the tone, not twice it")
    }

    func testAPauseInTheBuffersIsFilledWithSilenceSoWallTimeHolds() {
        let converter = TapConverter(source: stereoFloat48k)
        let base = AudioGetCurrentHostTime()
        var chunks: [AudioChunk] = []
        for index in 0..<50 { chunks += converter.convert(buffer(frames: 480, at: Double(index) * 0.01, base: base)) }
        for index in 0..<50 { chunks += converter.convert(buffer(frames: 480, at: 2.5 + Double(index) * 0.01, base: base)) }
        XCTAssertEqual(Double(frames(chunks)) / 16_000, 3.0, accuracy: 0.02, "0.5 s, 2 s of silence, 0.5 s")
        let last = chunks.last!
        let first = chunks.first!
        let span = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(last.buffer),
                                  CMSampleBufferGetPresentationTimeStamp(first.buffer)).seconds
        XCTAssertEqual(span + last.duration, 3.0, accuracy: 0.02, "media time equals the wall time spanned")
        XCTAssertEqual(last.at.timeIntervalSince(first.at), span, accuracy: 0.001)
        for (earlier, later) in zip(chunks, chunks.dropFirst()) {
            let gap = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(later.buffer),
                                     CMSampleBufferGetPresentationTimeStamp(earlier.buffer)).seconds - earlier.duration
            XCTAssertEqual(gap, 0, accuracy: 0.0001, "the writer never sees a hole")
        }
    }
}
