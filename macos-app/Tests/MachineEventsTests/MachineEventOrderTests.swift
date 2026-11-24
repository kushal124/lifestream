import DeviceFiles
import Evidence
import XCTest
@testable import MachineEvents

final class MachineEventOrderTests: XCTestCase {
    private var root: URL!
    private var seen: [(path: String, level: DeviceFiles.Flush, visible: Set<String>)] = []

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("machine-order-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let batches = self.batches.path
        DeviceFiles.flushObserver = { [unowned self] url, level in
            guard url.path.hasPrefix(batches) else { return }
            let path = String(url.path.dropFirst(batches.count).drop { $0 == "/" })
            seen.append((path, level, Set((try? FileManager.default.contentsOfDirectory(atPath: batches)) ?? [])))
        }
    }

    override func tearDownWithError() throws {
        DeviceFiles.flushObserver = nil
        try? FileManager.default.removeItem(at: root)
    }

    private var batches: URL { root.appendingPathComponent(MachineEventBatch.directoryName) }
    private var open: URL { batches.appendingPathComponent(MachineEventBatch.openName) }

    private func openLog() throws -> MachineEventLog {
        try MachineEventLog(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: TimeZone(identifier: "Asia/Kolkata")!) {
            MachineState(awake: true, displayAwake: true, sessionActive: true, locked: false, power: .ac,
                         batteryPercent: 80, lidOpen: true, wifiJoined: false, wifiName: nil, wifiNameUnavailable: false)
        }
    }

    private static func date(_ spelling: String) -> Date { UTCInstant.date(rfc3339: spelling)! }

    func testABatchOpensWithItsStateAndFirstEventInOneFullFlushAndEveryLineAfterHasItsOwn() throws {
        let log = try openLog()
        try log.append(MachineEvent(at: Self.date("2026-09-07T05:00:00.000Z"), name: .wake))
        XCTAssertEqual(seen.map(\.path), [MachineEventBatch.openName])
        XCTAssertEqual(seen.map(\.level), [.full])
        let lines = try String(contentsOf: open, encoding: .utf8).split(separator: "\n").map(String.init)
        XCTAssertEqual(try lines.map { try MachineEventCodec.event($0).name }, [.state, .wake])

        try log.append(MachineEvent(at: Self.date("2026-09-07T05:01:00.000Z"), name: .lock))
        XCTAssertEqual(seen.map(\.level), [.full, .full])
        try log.rotate()
        XCTAssertEqual(seen.count, 2, "a seal is a rename with no flush")
        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.000Z.jsonl"])
    }

    func testRecoveryCutsATornTailBehindABarrierBeforeTheSealRename() throws {
        let first = try openLog()
        try first.append(MachineEvent(at: Self.date("2026-09-07T05:00:00.000Z"), name: .wake))
        let whole = try Data(contentsOf: open)
        try (whole + Data("{\"at\":\"2026-09-07T06".utf8)).write(to: open)
        seen = []

        let log = try openLog()

        XCTAssertEqual(seen.map(\.path), [MachineEventBatch.openName])
        XCTAssertEqual(seen.map(\.level), [.barrier])
        XCTAssertEqual(seen.first?.visible, [MachineEventBatch.openName], "the barrier precedes the seal rename")
        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.000Z.jsonl"])
        XCTAssertEqual(try Data(contentsOf: batches.appendingPathComponent("20260907T050000.000Z.jsonl")), whole,
                       "the sealed batch is the open one cut after its last whole line")
    }

    func testAWholeStaleBatchIsSealedAndATornFirstLineParkedWithNoFlush() throws {
        try FileManager.default.createDirectory(at: batches, withIntermediateDirectories: true)
        try Data("{\"at\":\"2026-09-07T05:00:00.000Z\",\"event\":\"wake\",\"detail\":{}}\n".utf8).write(to: open)
        _ = try openLog()
        try Data("{\"at\":\"2026-09-07T05".utf8).write(to: open)
        let log = try openLog()
        XCTAssertTrue(seen.isEmpty)
        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.000Z.jsonl"])
        let names = try FileManager.default.contentsOfDirectory(atPath: batches.path)
        XCTAssertEqual(names.filter { $0.hasPrefix("current.jsonl.torn-") }.count, 1)
    }
}
