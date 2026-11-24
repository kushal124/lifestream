import Evidence
import DeviceFiles
import Foundation
import XCTest
@testable import InputEvents

final class InputEventSyncTests: XCTestCase {
    private var root: URL!
    private var flushes: [(path: String, level: DeviceFiles.Flush)] = []
    private var asked: [Bool] = []
    private let zone = TimeZone(identifier: "Asia/Kolkata")!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("input-sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let folder = root.appendingPathComponent(InputEventBatch.directoryName).path
        DeviceFiles.flushObserver = { [unowned self] url, level in
            guard url.path.hasPrefix(folder) else { return }
            flushes.append((String(url.path.dropFirst(folder.count).drop { $0 == "/" }), level))
        }
    }

    override func tearDownWithError() throws {
        DeviceFiles.flushObserver = nil
        try? FileManager.default.removeItem(at: root)
    }

    private func openFiles() throws -> InputEventFiles {
        try InputEventFiles(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: zone, unsynced: { [unowned self] in asked.append($0) })
    }

    private func key(_ t: Int) -> InputEvent { InputEvent(t: t, body: .keyUp(code: t, app: 0, syn: nil)) }

    func testAWriteAsksForOneSyncAndTheMinutesLineSupersedesIt() throws {
        let files = try openFiles()
        files.chunkOpened(at: Synthetic.minute, layout: "com.apple.keylayout.US")
        files.appAdded(0, name: Synthetic.editor)
        files.eventFinished(key(10))
        XCTAssertEqual(asked, [true], "the first unsynced write asks once")
        XCTAssertTrue(flushes.isEmpty, "events are written without a flush")

        files.syncChunk()
        XCTAssertEqual(flushes.map(\.path), [InputEventBatch.chunkName])
        XCTAssertEqual(flushes.map(\.level), [.full])
        XCTAssertEqual(asked, [true, false])
        files.syncChunk()
        XCTAssertEqual(flushes.count, 1, "nothing unsynced, nothing flushed")

        files.eventFinished(key(20))
        files.eventFinished(key(30))
        XCTAssertEqual(asked, [true, false, true], "a write after a sync asks again, once")

        files.chunkClosed(InputChunk(at: Synthetic.minute, until: Synthetic.minute.addingTimeInterval(60),
                                     layout: "com.apple.keylayout.US", apps: [Synthetic.editor],
                                     events: [key(10), key(20), key(30)]))
        XCTAssertEqual(flushes.map(\.path), [InputEventBatch.chunkName, InputEventBatch.openName],
                       "the line is fully flushed; its batch's first line and the cleared minute are not")
        XCTAssertEqual(flushes.map(\.level), [.full, .full])
        XCTAssertEqual(asked, [true, false, true, false], "the published line cancels the sync")
        files.syncChunk()
        XCTAssertEqual(flushes.count, 2)

        files.chunkOpened(at: Synthetic.minute.addingTimeInterval(60), layout: "com.apple.keylayout.US")
        files.chunkClosed(nil)
        XCTAssertEqual(asked, [true, false, true, false, true, false], "a minute with no line needs no sync")
        XCTAssertEqual(flushes.count, 2)

        try files.seal()
        files.close()
        XCTAssertEqual(flushes.count, 2, "a seal and a close flush nothing more")
        XCTAssertEqual(files.sealedBatches(), ["20260923T100300.000Z.jsonl"])
    }

    func testRecoveryPublishesTheOpenMinuteWithOneFullFlushAndSealsWithNone() throws {
        let files = try openFiles()
        files.chunkOpened(at: Synthetic.minute, layout: "com.apple.keylayout.US")
        files.appAdded(0, name: Synthetic.editor)
        files.eventFinished(key(10))
        files.syncChunk()
        flushes = []

        _ = try openFiles()
        XCTAssertEqual(flushes.map(\.path), [InputEventBatch.openName])
        XCTAssertEqual(flushes.map(\.level), [.full])
    }
}
