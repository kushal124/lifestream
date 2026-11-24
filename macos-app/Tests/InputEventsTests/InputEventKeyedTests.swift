import CryptoKit
import DeviceFiles
import Evidence
import Foundation
import XCTest
@testable import InputEvents

final class InputEventKeyedTests: XCTestCase {
    private var root: URL!
    private let key = SymmetricKey(data: Data(repeating: 0x3c, count: 32))
    private let zone = TimeZone(identifier: "Asia/Kolkata")!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("input-events-keyed-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var folder: URL { root.appendingPathComponent(InputEventBatch.directoryName) }
    private var openBatch: URL { folder.appendingPathComponent(InputEventBatch.openName) }
    private var openChunk: URL { folder.appendingPathComponent(InputEventBatch.chunkName) }

    private func chunk(at spelling: String) -> InputChunk {
        let at = Synthetic.date(spelling)
        return InputChunk(at: at, until: at.addingTimeInterval(60), layout: "com.apple.keylayout.US",
                          apps: [Synthetic.editor], events: [InputEvent(t: 10, body: .keyUp(code: 1, app: 0, syn: nil))])
    }

    private func ats(_ url: URL, _ files: DeviceFiles) throws -> [Date] {
        let bytes = try XCTUnwrap(files.read(url, maximumBytes: 1 << 20))
        return try String(decoding: bytes, as: UTF8.self).split(separator: "\n").map { try InputEventCodec.chunk(String($0)).at }
    }

    private func onDisk(_ url: URL) throws -> Data {
        try XCTUnwrap(FileManager.default.contents(atPath: url.path))
    }

    func testAKeyedBatchIsEncryptedSealedAndReadWholeAndItsLastLineFoundAgainAtTheNextStart() throws {
        let files = DeviceFiles(.keyed(key))
        let first = try InputEventFiles(recorderDirectory: root, files: files, timeZone: zone)
        try first.publish(chunk(at: "2026-09-23T10:03:00.000Z"))
        try first.publish(chunk(at: "2026-09-23T10:04:00.000Z"))
        XCTAssertEqual(try onDisk(openBatch).first, 0x80)
        XCTAssertNil(try onDisk(openBatch).range(of: Data(Synthetic.editor.utf8)), "no plain app name on disk")
        first.close()

        let again = try InputEventFiles(recorderDirectory: root, files: files, timeZone: zone)
        XCTAssertEqual(again.lastUntil, Synthetic.date("2026-09-23T10:05:00.000Z"), "the last line read from the whole batch")
        let sealed = try XCTUnwrap(again.sealedBatches().first)
        XCTAssertEqual(try ats(folder.appendingPathComponent(sealed), files),
                       [Synthetic.date("2026-09-23T10:03:00.000Z"), Synthetic.date("2026-09-23T10:04:00.000Z")])
    }

    func testAKeyedOpenMinuteIsEncryptedAndRebuiltAtTheNextStart() throws {
        let files = DeviceFiles(.keyed(key))
        let crashed = ChunkerOnFiles(files: try InputEventFiles(recorderDirectory: root, files: files, timeZone: zone), zone: zone)
        crashed.chunker.handle(Synthetic.raw(.leftMouseUp, at: Synthetic.opened.addingTimeInterval(5)), uptime: 0)
        XCTAssertEqual(try onDisk(openChunk).first, 0x80)
        crashed.files.close()

        let next = try InputEventFiles(recorderDirectory: root, files: files, timeZone: zone)
        let sealed = try XCTUnwrap(next.sealedBatches().first)
        let published = try XCTUnwrap(files.read(folder.appendingPathComponent(sealed), maximumBytes: 1 << 20))
        let line = try InputEventCodec.chunk(String(decoding: published.dropLast(), as: UTF8.self))
        XCTAssertTrue(line.recovered, "the minute rebuilt from the encrypted open minute")
    }

    func testABatchOpenedPlainWritesItsNextLineIntoANewKeyedBatchOnceTheInstanceSwitches() throws {
        let files = DeviceFiles(.plain)
        let input = try InputEventFiles(recorderDirectory: root, files: files, timeZone: zone)
        try input.publish(chunk(at: "2026-09-23T10:03:00.000Z"))
        XCTAssertEqual(try onDisk(openBatch).first, UInt8(ascii: "{"))

        try files.becomeKeyed(key) { _ in try FileManager.default.removeItem(at: openBatch) }
        try input.publish(chunk(at: "2026-09-23T10:04:00.000Z"))

        XCTAssertEqual(try onDisk(openBatch).first, 0x80)
        XCTAssertEqual(try ats(openBatch, files), [Synthetic.date("2026-09-23T10:04:00.000Z")])
    }
}
