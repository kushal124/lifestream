import Foundation
import DeviceFiles
import CoreGraphics
import AVFoundation
import VideoToolbox
import XCTest
import Evidence
@testable import Spool

final class SegmentCodecTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("video-archive-tests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func frame(_ value: UInt8 = 40) -> RawFrame {
        let width = 129, height = 97
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        var bytes = Data(repeating: value, count: width * height * 4)
        for i in stride(from: 3, to: bytes.count, by: 4) { bytes[i] = 255 }
        return RawFrame(layout: FrameLayout(width: width, height: height, bytesPerRow: width * 4,
            bitmapInfo: SegmentCodec.bitmap, renderingIntent: 0, ICCData: space.copyICCData()! as Data), data: bytes)
    }
    private func observation(_ index: Int) -> CaptureObservation {
        let text = TextObservation(text: "SYNTHETIC ORIGINAL 000", confidence: 0.75,
                                   bounds: CaptureRect(x: 0.1, y: 0.2, width: 0.4, height: 0.1))
        return CaptureObservation(
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000.125 + Double(index * 2)),
            displayID: 1,
            width: 129,
            height: 97,
            ocr: [text],
            capturedUntil: Date(timeIntervalSince1970: 1_700_000_000.625 + Double(index * 2))
        )
    }
    private func finish(_ store: CaptureStore) async throws {
        do {
            while try await store.compactPendingVideo(flush: true).pendingImageCount > 0 {}
        } catch VideoArchiveError.hardwareUnavailable { throw XCTSkip("Hardware HEVC encoder unavailable") }
    }
    func testLiveArchivePreservesMetadataAndRandomOddDimensionReads() async throws {
        let source = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.8)
        var original: [CaptureObservation] = []
        for index in 0..<32 {
            let image = CaptureImage.raw(frame(UInt8(40 + index * 2)))
            original.append(try source.append(observation: observation(index), image: image))
        }
        try await finish(source)
        let archive = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), readOnly: true)
        let saved = try archive.read(limit: 100)
        XCTAssertEqual(saved.count, original.count)
        for index in saved.indices {
            var restored = saved[index]
            restored.imageEncoding = nil
            XCTAssertEqual(restored, original[index])
            XCTAssertEqual(saved[index].imageEncoding?.encodedWidth, 130)
            XCTAssertEqual(saved[index].imageEncoding?.encodedHeight, 98)
        }
        for index in [31, 0, 29, 12, 30] + Array(saved.indices) {
            guard case .raw(let result) = try archive.readImage(for: saved[index]) else {
                return XCTFail("Expected raw pixels")
            }
            XCTAssertEqual(result.layout.width, 129)
            XCTAssertEqual(result.layout.height, 97)
            XCTAssertLessThan(abs(Int(result.data[0]) - (40 + index * 2)), 8)
        }
        let bundle = root.appendingPathComponent(saved[0].imageFile!).deletingLastPathComponent()
        let sidecar = bundle.appendingPathComponent("image.archive")
        let data = try Data(contentsOf: sidecar)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let entry = try decoder.decode(ArchiveSidecar.self, from: data)
        let video = root.appendingPathComponent(entry.reference.segment)
        let movie = try Data(contentsOf: video)
        try Data([0]).write(to: video)
        XCTAssertThrowsError(try archive.readImage(for: saved[0]))
        try movie.write(to: video)
        var json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var reference = json["reference"] as! [String: Any]
        reference["segment"] = "../outside.mov"
        json["reference"] = reference
        try JSONSerialization.data(withJSONObject: json).write(to: sidecar)
        XCTAssertThrowsError(try archive.readImage(for: saved[0]))
        try data.write(to: sidecar)
        let outside = root.appendingPathComponent("outside.mov")
        try movie.write(to: outside)
        try FileManager.default.removeItem(at: video)
        try FileManager.default.createSymbolicLink(at: video, withDestinationURL: outside)
        XCTAssertThrowsError(try archive.readImage(for: saved[0]))
    }
    func testAsymmetricOddImagePreservesOrientationAndLastRowAndColumn() async throws {
        let base = frame()
        let width = base.layout.width, height = base.layout.height
        var data = base.data
        func intensity(x: Int, y: Int) -> UInt8 {
            if y < height / 2 { return x < width / 2 ? 30 : 100 }
            return x < width / 2 ? 170 : 230
        }
        for y in 0..<height {
            for x in 0..<width {
                for channel in 0..<3 { data[(y * width + x) * 4 + channel] = intensity(x: x, y: y) }
            }
        }
        let source = try CaptureStore(directory: root.appendingPathComponent("pattern-source"), files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 1)
        _ = try source.append(observation: observation(0), image: .raw(RawFrame(layout: base.layout, data: data)))
        try await finish(source)
        let archive = try CaptureStore(directory: source.directory, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), readOnly: true)
        let saved = try XCTUnwrap(archive.read().first)
        guard case .raw(let decoded) = try archive.readImage(for: saved) else { return XCTFail("Expected raw image") }
        for y in [0, 8, height - 9, height - 1] {
            for x in [0, 8, width - 9, width - 1] {
                let actual = Int(decoded.data[(y * width + x) * 4])
                XCTAssertLessThan(abs(actual - Int(intensity(x: x, y: y))), 20,
                                  "Wrong pixel orientation or padding at \(x),\(y)")
            }
        }
    }
    func testInterleavedDisplaysAndApplicationSwitchesSharePerDisplaySegments() async throws {
        let source = try CaptureStore(directory: root.appendingPathComponent("interleaved-source"), files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 1)
        for index in 0..<12 {
            var item = observation(index)
            item.displayID = UInt32(index % 2 + 1)
            item.application = CaptureApplication(bundleID: "example.app-\(index % 3)", name: "Synthetic",
                                                  pid: Int32(index % 3 + 1))
            _ = try source.append(observation: item, image: .raw(frame(UInt8(40 + index * 8))))
        }
        let original = try source.read(limit: 100)
        try await finish(source)
        let archive = try CaptureStore(directory: source.directory, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), readOnly: true)
        let saved = try archive.read(limit: 100)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        var segments: [UInt32: Set<String>] = [:]
        for (index, item) in saved.enumerated() {
            XCTAssertEqual(item.application, original[index].application)
            XCTAssertEqual(item.displayID, original[index].displayID)
            let bundle = source.directory.appendingPathComponent(item.imageFile!).deletingLastPathComponent()
            let sidecar = try Data(contentsOf: bundle.appendingPathComponent("image.archive"))
            let reference = try decoder.decode(ArchiveSidecar.self, from: sidecar).reference
            XCTAssertEqual(reference.ordinal, index / 2)
            XCTAssertEqual(reference.frameCount, 6)
            segments[item.displayID, default: []].insert(reference.segment)
            guard case .raw(let decoded) = try archive.readImage(for: item) else {
                return XCTFail("Expected raw image")
            }
            XCTAssertLessThan(abs(Int(decoded.data[0]) - (40 + index * 8)), 8)
        }
        XCTAssertEqual(segments.count, 2)
        XCTAssertTrue(segments.values.allSatisfy { $0.count == 1 })
        XCTAssertNotEqual(segments[1], segments[2])
    }
    func testSaturatedSRGBColorsSurviveHardwareArchiveConversion() async throws {
        let source = try CaptureStore(directory: root.appendingPathComponent("color-source"), files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 1)
        let colors: [[UInt8]] = [[0, 0, 255], [0, 255, 0], [255, 0, 0], [40, 100, 200], [200, 100, 40], [128, 128, 128]]
        let base = frame()
        for (index, color) in colors.enumerated() {
            var pixels = base.data
            for offset in stride(from: 0, to: pixels.count, by: 4) {
                for channel in 0..<3 { pixels[offset + channel] = color[channel] }
            }
            let image = CaptureImage.raw(RawFrame(layout: base.layout, data: pixels))
            _ = try source.append(observation: observation(index), image: image)
        }
        try await finish(source)
        let archive = try CaptureStore(directory: source.directory, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), readOnly: true)
        let videoDirectory = source.directory.appendingPathComponent(".video")
        let movie = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: videoDirectory,
                                                                         includingPropertiesForKeys: nil).first)
        let tracks = try await AVURLAsset(url: movie).loadTracks(withMediaType: .video)
        let descriptions = try await XCTUnwrap(tracks.first).load(.formatDescriptions)
        let format = try XCTUnwrap(descriptions.first)
        func tag(_ key: CFString) -> String? {
            CMFormatDescriptionGetExtension(format, extensionKey: key) as? String
        }
        XCTAssertEqual(tag(kCMFormatDescriptionExtension_ColorPrimaries),
                       kCVImageBufferColorPrimaries_ITU_R_709_2 as String)
        XCTAssertEqual(tag(kCMFormatDescriptionExtension_TransferFunction),
                       kCVImageBufferTransferFunction_sRGB as String)
        XCTAssertEqual(tag(kCMFormatDescriptionExtension_YCbCrMatrix), kCVImageBufferYCbCrMatrix_ITU_R_709_2 as String)
        for (index, item) in try archive.read(limit: 100).enumerated() {
            guard case .raw(let decoded) = try archive.readImage(for: item) else {
                return XCTFail("Expected raw image")
            }
            let center = ((decoded.layout.height / 2) * decoded.layout.width + decoded.layout.width / 2) * 4
            for channel in 0..<3 {
                XCTAssertLessThanOrEqual(abs(Int(decoded.data[center + channel]) - Int(colors[index][channel])), 4)
            }
        }
    }
    func testTheEncoderBufferIsTheFrameDrawnIntoSRGB() throws {
        let width = 129, height = 97, stride = width * 4 + 48
        let encoding = CaptureVideoProvenance(width: width, height: height, quality: 0.8)
        let encoder: SegmentEncoder
        do { encoder = try SegmentEncoder(encoding: encoding) } catch VideoArchiveError.hardwareUnavailable {
            throw XCTSkip("Hardware HEVC encoder unavailable")
        }
        for (name, tolerance) in [(CGColorSpace.displayP3, 0), (CGColorSpace.sRGB, 0), (CGColorSpace.adobeRGB1998, 2)] {
            let space = try XCTUnwrap(CGColorSpace(name: name))
            var bytes = Data(count: stride * height)
            var seed: UInt32 = 7
            for y in 0..<height {
                for x in 0..<stride {
                    seed = seed &* 1_664_525 &+ 1_013_904_223
                    let value = UInt8(truncatingIfNeeded: seed >> 24)
                    let alpha: UInt8 = y < 8 ? 128 : 255
                    bytes[y * stride + x] = x >= width * 4 ? value : x % 4 == 3 ? alpha : min(value, alpha)
                }
            }
            let frame = RawFrame(layout: FrameLayout(width: width, height: height, bytesPerRow: stride,
                bitmapInfo: SegmentCodec.bitmap, renderingIntent: 0, ICCData: try XCTUnwrap(space.copyICCData()) as Data),
                data: bytes)
            let image = try SegmentCodec.image(.raw(frame))
            let drawn = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB)), bitmapInfo: SegmentCodec.bitmap)
            let context = try XCTUnwrap(drawn)
            context.setBlendMode(.copy)
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            let expected = Data(bytes: try XCTUnwrap(context.data), count: width * 4 * height)

            let buffer = try encoder.convert(image)
            CVPixelBufferLockBaseAddress(buffer, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
            let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(buffer)).assumingMemoryBound(to: UInt8.self)
            let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
            for y in 0..<encoding.encodedHeight {
                let row = Data(bytes: base + y * rowBytes, count: encoding.encodedWidth * 4)
                if y < height {
                    let deltas = zip(row.prefix(width * 4), expected[(y * width * 4)..<((y + 1) * width * 4)])
                        .map { abs(Int($0) - Int($1)) }
                    XCTAssertLessThanOrEqual(deltas.max() ?? 0, tolerance, "\(name) row \(y)")
                    XCTAssertTrue(row.dropFirst(width * 4).allSatisfy { $0 == 0 }, "\(name) padding column, row \(y)")
                } else {
                    XCTAssertTrue(row.allSatisfy { $0 == 0 }, "\(name) padding row \(y)")
                }
            }
        }
    }

    func testOneForcedKeyframeASegmentAndEachFrameReadsTheSameFromItsSamplesAndItsMovie() async throws {
        let encoder: SegmentEncoder
        do { encoder = try SegmentEncoder(encoding: CaptureVideoProvenance(width: 129, height: 97, quality: 0.65)) }
        catch VideoArchiveError.hardwareUnavailable { throw XCTSkip("Hardware HEVC encoder unavailable") }
        XCTAssertEqual((encoder.property(kVTCompressionPropertyKey_MaxKeyFrameInterval) as? NSNumber)?.intValue,
                       SegmentReference.maximumFrameCount)
        XCTAssertEqual(SegmentReference.maximumFrameCount, 30)

        let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.65)
        let items = try (0..<30).map { try store.append(observation: observation($0), image: .raw(frame(90))) }
        let fromSamples = try items.map { try store.readImage(for: $0) }
        try await finish(store)
        let reader = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), readOnly: true)
        let saved = try reader.read(limit: 100)
        XCTAssertEqual(saved.count, 30)
        XCTAssertEqual(Set(try saved.map { item -> String in
            let bundle = root.appendingPathComponent(item.imageFile!).deletingLastPathComponent()
            return try SpoolJSON.decode(ArchiveSidecar.self, from: Data(contentsOf: bundle.appendingPathComponent("image.archive")))
                .reference.segment
        }).count, 1, "one segment of 30")
        for (item, before) in zip(saved, fromSamples) {
            XCTAssertNotNil(item.imageEncoding)
            XCTAssertEqual(try reader.readImage(for: item), before)
        }
    }
}
