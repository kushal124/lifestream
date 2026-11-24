import CryptoKit
import DeviceFiles
import Evidence
import XCTest
@testable import MachineEvents

final class MachineEventKeyedTests: XCTestCase {
    private var root: URL!
    private let key = SymmetricKey(data: Data(repeating: 0x5a, count: 32))
    private let zone = TimeZone(identifier: "Asia/Kolkata")!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("machine-events-keyed-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var batches: URL { root.appendingPathComponent(MachineEventBatch.directoryName) }
    private var openBatch: URL { batches.appendingPathComponent(MachineEventBatch.openName) }

    private func openLog(_ files: DeviceFiles) throws -> MachineEventLog {
        try MachineEventLog(recorderDirectory: root, files: files, timeZone: zone) {
            MachineState(awake: true, displayAwake: true, sessionActive: true, locked: false, power: .ac,
                         batteryPercent: 80, lidOpen: true, wifiJoined: false, wifiName: nil, wifiNameUnavailable: false)
        }
    }

    private func event(_ spelling: String, _ name: MachineEventName) -> MachineEvent {
        MachineEvent(at: UTCInstant.date(rfc3339: spelling)!, name: name)
    }

    private func names(_ url: URL, _ files: DeviceFiles) throws -> [MachineEventName] {
        let bytes = try XCTUnwrap(files.read(url, maximumBytes: 1 << 20))
        return try String(decoding: bytes, as: UTF8.self).split(separator: "\n").map { try MachineEventCodec.event(String($0)).name }
    }

    private func onDisk(_ url: URL) throws -> Data {
        try XCTUnwrap(FileManager.default.contents(atPath: url.path))
    }

    func testAKeyedBatchIsEncryptedAndClosedBatchesReadWhole() throws {
        let files = DeviceFiles(.keyed(key))
        let log = try openLog(files)
        try log.append(event("2026-09-07T05:00:00.000Z", .lock))
        try log.append(event("2026-09-07T05:01:00.000Z", .unlock))
        let disk = try onDisk(openBatch)
        XCTAssertEqual(disk.first, 0x80, "a log's layout")
        XCTAssertNil(disk.range(of: Data("lock".utf8)), "no plain line on disk")
        try log.rotate()
        let sealed = batches.appendingPathComponent("20260907T050000.000Z.jsonl")
        XCTAssertEqual(try names(sealed, files), [.state, .lock, .unlock])
    }

    func testATornLastRecordOfAKeyedBatchIsRepairedAndTheBatchSealedWhole() throws {
        let files = DeviceFiles(.keyed(key))
        let first = try openLog(files)
        try first.append(event("2026-09-07T05:00:00.000Z", .wake))
        let whole = try XCTUnwrap(files.read(openBatch, maximumBytes: 1 << 20))
        let handle = try XCTUnwrap(FileHandle(forWritingAtPath: openBatch.path))
        try handle.seekToEnd()
        try handle.write(contentsOf: Data([0, 0, 0, 40, 1, 2, 3]))
        try handle.close()

        let log = try openLog(files)

        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.000Z.jsonl"])
        XCTAssertEqual(try files.read(batches.appendingPathComponent("20260907T050000.000Z.jsonl"), maximumBytes: 1 << 20),
                       whole, "the torn record is dropped, every whole line kept")
    }

    func testALogOpenedPlainWritesItsNextLineIntoANewKeyedBatchOnceTheInstanceSwitches() throws {
        let files = DeviceFiles(.plain)
        let log = try openLog(files)
        try log.append(event("2026-09-07T05:00:00.000Z", .lock))
        XCTAssertEqual(try onDisk(openBatch).first, UInt8(ascii: "{"), "plain before the switch")

        try files.becomeKeyed(key) { _ in try FileManager.default.removeItem(at: openBatch) }
        try log.append(event("2026-09-07T05:01:00.000Z", .unlock))

        XCTAssertEqual(try onDisk(openBatch).first, 0x80, "the next line lands in a new keyed batch")
        XCTAssertEqual(try names(openBatch, files), [.unlock])
    }
}
