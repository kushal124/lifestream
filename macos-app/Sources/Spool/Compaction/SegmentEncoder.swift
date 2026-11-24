import Evidence
import Foundation
import Accelerate
import AVFoundation
import VideoToolbox
import CoreGraphics

final class SegmentEncoder {
    let encoding: CaptureVideoProvenance
    private let session: VTCompressionSession
    private let collector = SampleCollector()
    private(set) var count = 0
    private var totalBytes = 0

    init(encoding: CaptureVideoProvenance) throws {
        try encoding.validate()
        self.encoding = encoding
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(encoding.encodedWidth),
            height: Int32(encoding.encodedHeight),
            codecType: kCMVideoCodecType_HEVC,
            encoderSpecification: [
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
            ] as CFDictionary,
            imageBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                kCVPixelBufferIOSurfacePropertiesKey: [:],
            ] as CFDictionary,
            compressedDataAllocator: nil,
            outputCallback: { context, _, status, _, sample in
                Unmanaged<SampleCollector>.fromOpaque(context!).takeUnretainedValue().append(status, sample)
            },
            refcon: Unmanaged.passUnretained(collector).toOpaque(),
            compressionSessionOut: &session
        )
        guard status == 0, let session else {
            throw VideoArchiveError.hardwareUnavailable
        }
        self.session = session
        do {
            let properties: [(CFString, Any)] = [
                (kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2 as Any),
                (kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_sRGB as Any),
                (kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2 as Any),
                (kVTCompressionPropertyKey_Quality, encoding.quality as Any),
                (kVTCompressionPropertyKey_AllowFrameReordering, false as Any),
                (kVTCompressionPropertyKey_ExpectedFrameRate, 1 as Any),
                (kVTCompressionPropertyKey_MaxKeyFrameInterval, SegmentReference.maximumFrameCount as Any),
            ]
            for (key, value) in properties {
                try SegmentCodec.check(VTSessionSetProperty(session, key: key, value: value as CFTypeRef))
            }
            try SegmentCodec.check(VTCompressionSessionPrepareToEncodeFrames(session))
            try Self.requireHardwareEncoder(session)
        } catch {
            VTCompressionSessionInvalidate(session)
            throw error
        }
    }

    deinit {
        VTCompressionSessionInvalidate(session)
    }

    func property(_ key: CFString) -> CFTypeRef? {
        var value: CFTypeRef?
        let status = withUnsafeMutablePointer(to: &value) {
            VTSessionCopyProperty(session, key: key, allocator: kCFAllocatorDefault, valueOut: UnsafeMutableRawPointer($0))
        }
        return status == 0 ? value : nil
    }

    func convert(_ image: CGImage) throws -> CVPixelBuffer {
        guard image.width == encoding.originalWidth, image.height == encoding.originalHeight else {
            throw VideoArchiveError.invalidInput
        }
        guard let pool = VTCompressionSessionGetPixelBufferPool(session) else {
            throw VideoArchiveError.hardwareUnavailable
        }
        return try Self.buffer(image, encoding: encoding, pool: pool)
    }

    func encode(_ pixels: CVPixelBuffer) throws -> CMSampleBuffer {
        guard count < SegmentReference.maximumFrameCount else {
            throw VideoArchiveError.invalidInput
        }
        let time = CMTime(value: Int64(count), timescale: 1)
        try SegmentCodec.check(VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixels,
            presentationTimeStamp: time,
            duration: CMTime(value: 1, timescale: 1),
            frameProperties: nil,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        ))
        try SegmentCodec.check(VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: time))
        let samples = try collector.take()
        guard samples.count == 1,
              CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(samples[0]), time) == 0 else {
            throw VideoArchiveError.corruptSegment
        }
        let size = CMSampleBufferGetTotalSampleSize(samples[0])
        guard size > 0, size <= SegmentCodec.maximumSegmentBytes - totalBytes else {
            throw VideoArchiveError.corruptSegment
        }
        totalBytes += size
        count += 1
        return samples[0]
    }

    private static func requireHardwareEncoder(_ session: VTCompressionSession) throws {
        let hardware = UnsafeMutablePointer<CFTypeRef?>.allocate(capacity: 1)
        hardware.initialize(to: nil)
        defer {
            hardware.deinitialize(count: 1)
            hardware.deallocate()
        }
        try SegmentCodec.check(VTSessionCopyProperty(
            session,
            key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
            allocator: kCFAllocatorDefault,
            valueOut: hardware
        ))
        guard hardware.pointee as? Bool == true else {
            throw VideoArchiveError.hardwareUnavailable
        }
    }

    private static func buffer(
        _ image: CGImage,
        encoding: CaptureVideoProvenance,
        pool: CVPixelBufferPool
    ) throws -> CVPixelBuffer {
        guard let source = vImage_CGImageFormat(cgImage: image),
              let destination = vImage_CGImageFormat(bitsPerComponent: 8, bitsPerPixel: 32,
                  colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: SegmentCodec.bitmap),
                  renderingIntent: image.renderingIntent),
              let converter = try? vImageConverter.make(sourceFormat: source, destinationFormat: destination),
              let bytes = image.dataProvider?.data as Data?,
              bytes.count >= image.bytesPerRow * image.height else {
            throw VideoArchiveError.invalidInput
        }
        var output: CVPixelBuffer?
        try SegmentCodec.check(CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output))
        guard let output,
              CVPixelBufferGetWidth(output) == encoding.encodedWidth,
              CVPixelBufferGetHeight(output) == encoding.encodedHeight,
              CVPixelBufferGetPixelFormatType(output) == kCVPixelFormatType_32BGRA else {
            throw VideoArchiveError.invalidInput
        }
        let attachments = [
            kCVImageBufferColorPrimariesKey: kCVImageBufferColorPrimaries_ITU_R_709_2,
            kCVImageBufferTransferFunctionKey: kCVImageBufferTransferFunction_sRGB,
            kCVImageBufferYCbCrMatrixKey: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
        ] as CFDictionary
        CVBufferSetAttachments(output, attachments, .shouldPropagate)
        try SegmentCodec.check(CVPixelBufferLockBaseAddress(output, []))
        defer { CVPixelBufferUnlockBaseAddress(output, []) }
        let pointer = CVPixelBufferGetBaseAddress(output)!
        let stride = CVPixelBufferGetBytesPerRow(output)
        memset(pointer, 0, stride * encoding.encodedHeight)
        var target = vImage_Buffer(data: pointer, height: vImagePixelCount(image.height),
                                   width: vImagePixelCount(image.width), rowBytes: stride)
        try bytes.withUnsafeBytes { raw in
            let input = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: raw.baseAddress!),
                                      height: vImagePixelCount(image.height), width: vImagePixelCount(image.width),
                                      rowBytes: image.bytesPerRow)
            do {
                try converter.convert(source: input, destination: &target)
            } catch {
                throw VideoArchiveError.invalidInput
            }
        }
        return output
    }
}

private final class SampleCollector {
    private let lock = NSLock()
    private var samples: [CMSampleBuffer] = []
    private var error: OSStatus = 0

    func append(_ status: OSStatus, _ sample: CMSampleBuffer?) {
        lock.lock()
        defer { lock.unlock() }
        if status != 0 {
            error = status
        }
        if let sample {
            samples.append(sample)
        }
    }

    func take() throws -> [CMSampleBuffer] {
        lock.lock()
        defer { lock.unlock() }
        try SegmentCodec.check(error)
        defer { samples = [] }
        return samples
    }
}
