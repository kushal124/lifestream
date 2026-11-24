import AVFoundation
import XCTest
@testable import Audio

final class AudioSegmentWriterTests: XCTestCase {
    private var root: URL!
    private static var abandoned: [AudioSegmentWriter] = []

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("audio-writer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func write(seconds: Double, to name: String, finish: Bool = true) throws -> URL {
        let url = root.appendingPathComponent(name)
        let writer = try AudioSegmentWriter(url: url)
        for chunk in SyntheticAudio.chunks(seconds: seconds, at: Date()) { try writer.append(chunk) }
        if finish { try writer.finish() } else { Self.abandoned.append(writer) }
        return url
    }

    func testAFileIsMonoAACAtTheStatedRateAndReadsBackWhole() throws {
        let url = try write(seconds: 5, to: "five.m4a")
        let file = try AVAudioFile(forReading: url)
        XCTAssertEqual(file.fileFormat.channelCount, 1)
        XCTAssertEqual(file.fileFormat.sampleRate, 16_000)
        XCTAssertEqual(file.fileFormat.settings[AVFormatIDKey] as? UInt32, kAudioFormatMPEG4AAC)
        XCTAssertEqual(Double(file.length) / 16_000, 5, accuracy: 0.1)
    }

    func testAnHourStaysUnderTwentyMegabytes() throws {
        let url = try write(seconds: 60, to: "minute.m4a")
        let bytes = try XCTUnwrap(try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int)
        XCTAssertLessThan(bytes * 60, 20_000_000, "\(bytes) bytes a minute")
        XCTAssertGreaterThan(bytes * 60, 1_000_000, "the encoder wrote audio, not silence")
    }

    func testAFileNeverClosedReadsUpToItsLastFragment() throws {
        let url = try write(seconds: 25, to: "crashed.m4a", finish: false)
        var seconds = 0.0
        try until("seconds = AudioSegmentWriter.readableSeconds(url)") {
            seconds = AudioSegmentWriter.readableSeconds(url)
            return seconds >= 10
        }
        XCTAssertLessThanOrEqual(seconds, 25)
    }

    func testAFileWithNoSampleLeavesNothing() throws {
        let url = root.appendingPathComponent("empty.m4a")
        let writer = try AudioSegmentWriter(url: url)
        try writer.finish()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
