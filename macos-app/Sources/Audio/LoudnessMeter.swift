import CoreMedia
import Foundation

struct LoudnessMeter {
    static let everyMs = 1_000
    private static let every = AudioFormat.sampleRate * everyMs / 1_000
    private var sumOfSquares = 0.0
    private var peak = 0
    private var count = 0
    private var rms: [Int] = []
    private var peaks: [Int] = []

    mutating func add(_ buffer: CMSampleBuffer) {
        for sample in Self.samples(of: buffer) {
            let value = Int(sample)
            sumOfSquares += Double(value * value)
            peak = max(peak, abs(value))
            count += 1
            if count == Self.every { close() }
        }
    }

    var loudness: AudioSidecar.Loudness {
        var meter = self
        if meter.count > 0 { meter.close() }
        return AudioSidecar.Loudness(everyMs: Self.everyMs, rmsDbfs: meter.rms, peakDbfs: meter.peaks)
    }

    private mutating func close() {
        rms.append(Self.dbfs((sumOfSquares / Double(count)).squareRoot()))
        peaks.append(Self.dbfs(Double(peak)))
        sumOfSquares = 0
        peak = 0
        count = 0
    }

    private static func dbfs(_ amplitude: Double) -> Int {
        guard amplitude > 0 else { return -96 }
        return max(-96, min(0, Int((20 * log10(amplitude / 32_768)).rounded())))
    }

    private static func samples(of buffer: CMSampleBuffer) -> [Int16] {
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { return [] }
        let length = CMBlockBufferGetDataLength(block)
        var samples = [Int16](repeating: 0, count: length / MemoryLayout<Int16>.size)
        let status = samples.withUnsafeMutableBytes { bytes in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: bytes.count, destination: bytes.baseAddress!)
        }
        return status == kCMBlockBufferNoErr ? samples : []
    }
}
