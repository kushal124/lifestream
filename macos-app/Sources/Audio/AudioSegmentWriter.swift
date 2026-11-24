import AVFoundation
import CoreMedia
import Foundation

public enum AudioWriterError: Error, Equatable, CustomStringConvertible {
    case open
    case append
    case finish

    public var description: String {
        switch self {
        case .open: return "the audio file could not be opened for writing"
        case .append: return "audio could not be appended to the file"
        case .finish: return "the audio file could not be closed"
        }
    }
}

final class AudioSegmentWriter {
    static let fragmentInterval = CMTime(seconds: 10, preferredTimescale: 600)

    let url: URL
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var firstTime: CMTime?
    private var endTime: CMTime?

    init(url: URL) throws {
        self.url = url
        do { writer = try AVAssetWriter(outputURL: url, fileType: .m4a) } catch { throw AudioWriterError.open }
        writer.movieFragmentInterval = Self.fragmentInterval
        input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: AudioFormat.channels,
            AVSampleRateKey: AudioFormat.sampleRate,
            AVEncoderBitRateKey: AudioFormat.bitRate,
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw AudioWriterError.open }
        writer.add(input)
        guard writer.startWriting() else { throw AudioWriterError.open }
    }

    func append(_ chunk: AudioChunk) throws {
        let time = CMSampleBufferGetPresentationTimeStamp(chunk.buffer)
        if firstTime == nil {
            writer.startSession(atSourceTime: time)
            firstTime = time
        }
        var waited = 0
        while !input.isReadyForMoreMediaData, waited < 200, writer.status == .writing {
            usleep(1_000)
            waited += 1
        }
        guard writer.status == .writing, input.append(chunk.buffer) else { throw AudioWriterError.append }
        let duration = CMSampleBufferGetDuration(chunk.buffer)
        endTime = CMTimeAdd(time, duration.isValid ? duration : CMTime(seconds: chunk.duration, preferredTimescale: 48_000))
    }

    var duration: TimeInterval {
        guard let firstTime, let endTime else { return 0 }
        return CMTimeSubtract(endTime, firstTime).seconds
    }

    func finish() throws {
        guard firstTime != nil else {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
            return
        }
        input.markAsFinished()
        if let endTime { writer.endSession(atSourceTime: endTime) }
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        guard writer.status == .completed else { throw AudioWriterError.finish }
    }

    static func readableSeconds(_ url: URL) -> TimeInterval {
        guard let file = try? AVAudioFile(forReading: url), file.fileFormat.sampleRate > 0 else { return 0 }
        return Double(file.length) / file.fileFormat.sampleRate
    }
}
