import Evidence
import Foundation
import AVFoundation
import CryptoKit

enum OpenSegmentLog {
    struct Format: Codable, Equatable {
        let version: Int
        let displayID: UInt32
        let encoding: CaptureVideoProvenance
        let extensions: Data
    }

    struct Record: Equatable {
        let ordinal: Int
        let imagePath: String
        let attachments: Data
        let sample: Data
    }

    static let maximumFormatBytes = 1024 * 1024
    static let maximumLogBytes = SegmentCodec.maximumSegmentBytes + 1024 * 1024

    static func format(of description: CMFormatDescription, displayID: UInt32,
                       encoding: CaptureVideoProvenance) throws -> Format {
        let extensions = CMFormatDescriptionGetExtensions(description) ?? ([:] as CFDictionary)
        let format = Format(
            version: 1,
            displayID: displayID,
            encoding: encoding,
            extensions: try PropertyListSerialization.data(fromPropertyList: extensions, format: .binary, options: 0)
        )
        guard CMFormatDescriptionEqual(try formatDescription(format), otherFormatDescription: description) else {
            throw VideoArchiveError.corruptSegment
        }
        return format
    }

    static func formatDescription(_ format: Format) throws -> CMVideoFormatDescription {
        try format.encoding.validate()
        guard format.version == 1,
              let extensions = try? PropertyListSerialization.propertyList(from: format.extensions, format: nil)
                as? [String: Any] else {
            throw VideoArchiveError.corruptSegment
        }
        var description: CMVideoFormatDescription?
        try SegmentCodec.check(CMVideoFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            codecType: kCMVideoCodecType_HEVC,
            width: Int32(format.encoding.encodedWidth),
            height: Int32(format.encoding.encodedHeight),
            extensions: extensions as CFDictionary,
            formatDescriptionOut: &description
        ))
        guard let description else {
            throw VideoArchiveError.corruptSegment
        }
        return description
    }

    static func record(of sample: CMSampleBuffer, ordinal: Int, imagePath: String) throws -> Record {
        guard CMSampleBufferGetNumSamples(sample) == 1,
              CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(sample), CMTime(value: Int64(ordinal), timescale: 1)) == 0,
              CMTimeCompare(CMSampleBufferGetDuration(sample), CMTime(value: 1, timescale: 1)) == 0,
              !CMSampleBufferGetDecodeTimeStamp(sample).isValid,
              let block = CMSampleBufferGetDataBuffer(sample) else {
            throw VideoArchiveError.corruptSegment
        }
        var bytes = Data(count: CMBlockBufferGetDataLength(block))
        try bytes.withUnsafeMutableBytes { buffer in
            try SegmentCodec.check(CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: buffer.count,
                                                              destination: buffer.baseAddress!))
        }
        var attachments = Data()
        if let array = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]],
           let first = array.first, !first.isEmpty {
            attachments = try PropertyListSerialization.data(fromPropertyList: first, format: .binary, options: 0)
        }
        return Record(ordinal: ordinal, imagePath: imagePath, attachments: attachments, sample: bytes)
    }

    static func sampleBuffer(_ record: Record, format: CMVideoFormatDescription) throws -> CMSampleBuffer {
        var block: CMBlockBuffer?
        try SegmentCodec.check(CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: record.sample.count,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
            dataLength: record.sample.count, flags: 0, blockBufferOut: &block))
        guard let block else {
            throw VideoArchiveError.corruptSegment
        }
        try record.sample.withUnsafeBytes { bytes in
            try SegmentCodec.check(CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: block,
                                                                 offsetIntoDestination: 0, dataLength: bytes.count))
        }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 1),
                                        presentationTimeStamp: CMTime(value: Int64(record.ordinal), timescale: 1),
                                        decodeTimeStamp: .invalid)
        var size = record.sample.count
        var sample: CMSampleBuffer?
        try SegmentCodec.check(CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: 1,
            sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1,
            sampleSizeArray: &size, sampleBufferOut: &sample))
        guard let sample else {
            throw VideoArchiveError.corruptSegment
        }
        if !record.attachments.isEmpty {
            guard let values = try? PropertyListSerialization.propertyList(from: record.attachments, format: nil)
                    as? [String: Any],
                  let array = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
                  CFArrayGetCount(array) == 1 else {
                throw VideoArchiveError.corruptSegment
            }
            let attachments = unsafeBitCast(CFArrayGetValueAtIndex(array, 0), to: CFMutableDictionary.self)
            for (key, value) in values {
                let pair = (key as CFString, value as CFTypeRef)
                withExtendedLifetime(pair) {
                    CFDictionarySetValue(attachments, Unmanaged.passUnretained(pair.0).toOpaque(),
                                         Unmanaged.passUnretained(pair.1).toOpaque())
                }
            }
        }
        return sample
    }

    static func encode(_ record: Record) -> Data {
        var body = Data()
        appendWord(record.ordinal, to: &body)
        for part in [Data(record.imagePath.utf8), record.attachments, record.sample] {
            appendWord(part.count, to: &body)
            body.append(part)
        }
        var bytes = Data()
        appendWord(body.count + 32, to: &bytes)
        bytes.append(body)
        bytes.append(contentsOf: SHA256.hash(data: bytes))
        return bytes
    }

    static func records(in log: Data) -> [Record] {
        var records: [Record] = []
        var cursor = log.startIndex
        while let length = word(in: log, at: cursor), length >= 32 + 16,
              log.endIndex - cursor - 4 >= length {
            let end = cursor + 4 + length
            let record = log[cursor..<end]
            guard Data(SHA256.hash(data: record.dropLast(32))) == record.suffix(32) else {
                break
            }
            var field = cursor + 4
            func next() -> Data? {
                guard let count = word(in: log, at: field), end - 32 - field - 4 >= count else {
                    return nil
                }
                defer { field += 4 + count }
                return Data(log[(field + 4)..<(field + 4 + count)])
            }
            guard let ordinal = word(in: log, at: field), ordinal == records.count else {
                break
            }
            field += 4
            guard let path = next(), let imagePath = String(data: path, encoding: .utf8),
                  let attachments = next(), let sample = next(), !sample.isEmpty, field == end - 32 else {
                break
            }
            records.append(Record(ordinal: ordinal, imagePath: imagePath, attachments: attachments, sample: sample))
            cursor = end
        }
        return records
    }

    private static func appendWord(_ value: Int, to data: inout Data) {
        var little = UInt32(value).littleEndian
        withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }

    private static func word(in data: Data, at index: Data.Index) -> Int? {
        guard index >= data.startIndex, data.endIndex - index >= 4 else {
            return nil
        }
        return data[index..<(index + 4)].enumerated().reduce(0) { $0 | Int($1.element) << (8 * $1.offset) }
    }
}

struct OpenImage: Codable, Equatable {
    let segment: String
    let ordinal: Int

    static let maximumBytes = 1024
}
