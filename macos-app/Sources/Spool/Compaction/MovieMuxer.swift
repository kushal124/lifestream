import Foundation
import AVFoundation
import Evidence

protocol MovieOutput {
    func start() throws
    func onReady(queue: DispatchQueue, perform: @escaping () -> Void)
    var isReady: Bool { get }
    func append(ordinal: Int) throws
    func finish(_ completed: @escaping (Result<Void, Error>) -> Void)
    func cancel()
}

final class MovieMuxer {
    private enum State {
        case pumping(Int)
        case finishing
        case finished
    }

    private let output: MovieOutput
    private let frameCount: Int
    private let queue: DispatchQueue
    private let completed = DispatchSemaphore(value: 0)
    private var state = State.pumping(0)
    private var result: Result<Void, Error>?
    private let stageLock = NSLock()
    private var current = VideoArchiveOperation.appendFrame

    private init(frameCount: Int, output: MovieOutput) {
        self.frameCount = frameCount
        self.output = output
        let caller = max(qos_class_self().rawValue, QOS_CLASS_UTILITY.rawValue)
        queue = DispatchQueue(
            label: "LifestreamScreen.video-mux",
            qos: DispatchQoS(qosClass: DispatchQoS.QoSClass(rawValue: qos_class_t(rawValue: caller)) ?? .utility, relativePriority: 0)
        )
    }

    static func write(samples: [CMSampleBuffer], id: String, in scratch: URL) throws -> URL {
        guard !samples.isEmpty else {
            throw VideoArchiveError.invalidInput
        }
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let movie = scratch.appendingPathComponent("movie-\(id).mov")
        if FileManager.default.fileExists(atPath: movie.path) {
            try FileManager.default.removeItem(at: movie)
        }
        do {
            let writer = try AVAssetWriter(outputURL: movie, fileType: .mov)
            try write(frameCount: samples.count, output: AssetWriterOutput(samples: samples, writer: writer))
        } catch {
            try? FileManager.default.removeItem(at: movie)
            throw error
        }
        return movie
    }

    static func write(
        frameCount: Int,
        output: MovieOutput,
        timeout: TimeInterval = 15,
        isCancelled: () -> Bool = { Task.isCancelled }
    ) throws {
        guard (1...SegmentReference.maximumFrameCount).contains(frameCount),
              timeout.isFinite,
              timeout >= 0,
              timeout <= 15 else {
            throw VideoArchiveError.invalidInput
        }
        try MovieMuxer(frameCount: frameCount, output: output).run(timeout: timeout, isCancelled: isCancelled)
    }

    private func run(timeout: TimeInterval, isCancelled: () -> Bool) throws {
        do {
            try output.start()
            output.onReady(queue: queue) { [weak self] in
                self?.pump()
            }
            let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeout * 1_000_000_000)
            while true {
                if isCancelled() {
                    throw VideoArchiveError.cancelled
                }
                let nextCheck = min(deadline, DispatchTime.now().uptimeNanoseconds + 100_000_000)
                if completed.wait(timeout: DispatchTime(uptimeNanoseconds: nextCheck)) == .success {
                    break
                }
                if DispatchTime.now().uptimeNanoseconds >= deadline {
                    throw VideoArchiveError.timeout(stage)
                }
            }
            try queue.sync {
                guard let result else {
                    throw VideoArchiveError.corruptSegment
                }
                try result.get()
            }
        } catch {
            queue.sync {
                complete(.failure(error), cancel: true)
            }
            throw error
        }
    }

    private func pump() {
        guard case .pumping(var ordinal) = state else {
            return
        }
        do {
            while output.isReady, ordinal < frameCount {
                try output.append(ordinal: ordinal)
                ordinal += 1
                state = .pumping(ordinal)
            }
        } catch {
            complete(.failure(error), cancel: true)
            return
        }
        guard ordinal == frameCount else {
            return
        }
        state = .finishing
        stageLock.withLock { current = .finishWriting }
        output.finish { [weak self] result in
            self?.queue.async { [weak self] in
                self?.complete(result, cancel: false)
            }
        }
    }

    private var stage: VideoArchiveOperation {
        stageLock.withLock { current }
    }

    private func complete(_ result: Result<Void, Error>, cancel: Bool) {
        if case .finished = state {
            return
        }
        state = .finished
        if cancel {
            output.cancel()
        }
        self.result = result
        completed.signal()
    }
}
