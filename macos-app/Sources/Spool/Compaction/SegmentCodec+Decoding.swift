import Evidence
import Foundation
import AVFoundation
import CoreGraphics
import VideoToolbox

extension SegmentCodec {
    static func validate(url: URL, encoding: CaptureVideoProvenance, frameCount: Int) throws {
        try encoding.validate()
        guard (1...SegmentReference.maximumFrameCount).contains(frameCount) else {
            throw VideoArchiveError.invalidReference
        }
        try withDecodedFrames(url: url, encoding: encoding, frameCount: frameCount, through: frameCount - 1,
                              requireEnd: true) { _, _ in }
    }

    static func decode(url: URL, reference: SegmentReference) throws -> RawFrame {
        try reference.validate()
        var result: RawFrame?
        try withDecodedFrames(
            url: url,
            encoding: reference.encoding,
            frameCount: reference.frameCount,
            through: reference.ordinal,
            requireEnd: false
        ) { ordinal, image in
            if ordinal == reference.ordinal {
                result = crop(image, to: reference.encoding)
            }
        }
        guard let result else {
            throw VideoArchiveError.corruptSegment
        }
        return result
    }

    static func decode(samples: [CMSampleBuffer], format: CMVideoFormatDescription, ordinal: Int,
                       encoding: CaptureVideoProvenance) throws -> RawFrame {
        guard samples.indices.contains(ordinal) else {
            throw VideoArchiveError.invalidReference
        }
        var session: VTDecompressionSession?
        try check(VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            formatDescription: format,
            decoderSpecification: nil,
            imageBufferAttributes: [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            outputCallback: nil,
            decompressionSessionOut: &session
        ))
        guard let session else {
            throw VideoArchiveError.corruptSegment
        }
        defer { VTDecompressionSessionInvalidate(session) }
        var result: RawFrame?
        var failure: OSStatus = 0
        for index in 0...ordinal {
            try autoreleasepool {
                try check(VTDecompressionSessionDecodeFrame(session, sampleBuffer: samples[index], flags: [],
                                                            infoFlagsOut: nil) { status, _, image, _, _ in
                    guard status == 0, let image,
                          CVPixelBufferGetWidth(image) == encoding.encodedWidth,
                          CVPixelBufferGetHeight(image) == encoding.encodedHeight,
                          CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA else {
                        failure = status == 0 ? -1 : status
                        return
                    }
                    if index == ordinal {
                        result = crop(image, to: encoding)
                    }
                })
                try check(VTDecompressionSessionWaitForAsynchronousFrames(session))
                try check(failure)
            }
        }
        guard let result else {
            throw VideoArchiveError.corruptSegment
        }
        return result
    }

    private static func crop(_ image: CVPixelBuffer, to encoding: CaptureVideoProvenance) -> RawFrame {
        CVPixelBufferLockBaseAddress(image, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        let width = encoding.originalWidth
        let height = encoding.originalHeight
        var data = Data(count: width * height * 4)
        data.withUnsafeMutableBytes { destination in
            for row in 0..<height {
                memcpy(
                    destination.baseAddress!.advanced(by: row * width * 4),
                    CVPixelBufferGetBaseAddress(image)!.advanced(by: row * CVPixelBufferGetBytesPerRow(image)),
                    width * 4
                )
            }
        }
        let icc = CGColorSpace(name: CGColorSpace.sRGB)!.copyICCData()! as Data
        let layout = FrameLayout(
            width: width,
            height: height,
            bytesPerRow: width * 4,
            bitmapInfo: bitmap,
            renderingIntent: 0,
            ICCData: icc
        )
        return RawFrame(layout: layout, data: data)
    }

    private static func withDecodedFrames(
        url: URL,
        encoding: CaptureVideoProvenance,
        frameCount: Int,
        through lastOrdinal: Int,
        requireEnd: Bool,
        visit: (Int, CVPixelBuffer) throws -> Void
    ) throws {
        let asset = AVURLAsset(url: url)
        let tracks = CompletionBox<[AVAssetTrack]>()
        let task = Task.detached(priority: max(Task.currentPriority, .medium)) {
            do {
                let loaded = try await asset.loadTracks(withMediaType: .video)
                guard loaded.count == 1 else {
                    throw VideoArchiveError.corruptSegment
                }
                let descriptions = try await loaded[0].load(.formatDescriptions)
                guard descriptions.count == 1,
                      CMFormatDescriptionGetMediaSubType(descriptions[0]) == kCMVideoCodecType_HEVC else {
                    throw VideoArchiveError.corruptSegment
                }
                let size = CMVideoFormatDescriptionGetDimensions(descriptions[0])
                let duration = try await asset.load(.duration)
                guard size.width == encoding.encodedWidth,
                      size.height == encoding.encodedHeight,
                      duration.isNumeric,
                      abs(duration.seconds - Double(frameCount)) < 0.001 else {
                    throw VideoArchiveError.corruptSegment
                }
                tracks.finish(.success(loaded))
            } catch let error as VideoArchiveError {
                tracks.finish(.failure(error))
            } catch {
                tracks.finish(.failure(mediaFailure(.loadTracks, error: error)))
            }
        }
        let videoTracks: [AVAssetTrack]
        do {
            videoTracks = try tracks.wait(for: .loadTracks)
        } catch {
            task.cancel()
            throw error
        }
        guard videoTracks.count == 1 else {
            throw VideoArchiveError.corruptSegment
        }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(
            track: videoTracks[0],
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        )
        guard reader.canAdd(output) else {
            throw VideoArchiveError.corruptSegment
        }
        reader.add(output)
        guard reader.startReading() else {
            throw mediaFailure(.startReading, error: reader.error)
        }
        defer { reader.cancelReading() }
        for ordinal in 0...lastOrdinal {
            try autoreleasepool {
                guard let sample = output.copyNextSampleBuffer() else {
                    if let error = reader.error {
                        throw mediaFailure(.decodeFrame, error: error)
                    }
                    throw VideoArchiveError.corruptSegment
                }
                let expectedTime = CMTime(value: Int64(ordinal), timescale: 1)
                guard CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(sample), expectedTime) == 0,
                      let image = CMSampleBufferGetImageBuffer(sample),
                      CVPixelBufferGetWidth(image) == encoding.encodedWidth,
                      CVPixelBufferGetHeight(image) == encoding.encodedHeight,
                      CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA else {
                    throw VideoArchiveError.corruptSegment
                }
                try visit(ordinal, image)
            }
        }
        if requireEnd {
            let hasExtraFrame = autoreleasepool { output.copyNextSampleBuffer() != nil }
            if let error = reader.error {
                throw mediaFailure(.decodeFrame, error: error)
            }
            guard !hasExtraFrame, reader.status == .completed else {
                throw VideoArchiveError.corruptSegment
            }
        }
    }
}

private final class CompletionBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, Error>?
    let ready = DispatchSemaphore(value: 0)

    func finish(_ value: Result<T, Error>) {
        lock.lock()
        guard result == nil else {
            lock.unlock()
            return
        }
        result = value
        lock.unlock()
        ready.signal()
    }

    func wait(for operation: VideoArchiveOperation) throws -> T {
        guard ready.wait(timeout: .now() + 15) == .success else {
            throw VideoArchiveError.timeout(operation)
        }
        lock.lock()
        defer { lock.unlock() }
        guard let result else {
            throw VideoArchiveError.corruptSegment
        }
        return try result.get()
    }
}
