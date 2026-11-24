import Foundation
import AVFoundation
import Evidence

final class AssetWriterOutput: MovieOutput {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let samples: [CMSampleBuffer]

    init(samples: [CMSampleBuffer], writer: AVAssetWriter) {
        self.samples = samples
        self.writer = writer
        input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: nil,
            sourceFormatHint: CMSampleBufferGetFormatDescription(samples[0])
        )
    }

    func start() throws {
        guard writer.canAdd(input) else {
            throw VideoArchiveError.invalidInput
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw SegmentCodec.mediaFailure(.startWriting, error: writer.error)
        }
        writer.startSession(atSourceTime: .zero)
    }

    func onReady(queue: DispatchQueue, perform: @escaping () -> Void) {
        input.requestMediaDataWhenReady(on: queue, using: perform)
    }

    var isReady: Bool {
        input.isReadyForMoreMediaData
    }

    func append(ordinal: Int) throws {
        guard writer.status == .writing, input.append(samples[ordinal]) else {
            throw SegmentCodec.mediaFailure(.appendFrame, error: writer.error)
        }
    }

    func finish(_ completed: @escaping (Result<Void, Error>) -> Void) {
        input.markAsFinished()
        writer.finishWriting { [writer] in
            if writer.status == .completed {
                completed(.success(()))
            } else {
                completed(.failure(SegmentCodec.mediaFailure(.finishWriting, error: writer.error)))
            }
        }
    }

    func cancel() {
        if writer.status == .writing {
            writer.cancelWriting()
        }
    }
}
