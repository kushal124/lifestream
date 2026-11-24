import CryptoKit
import DeviceFiles
import Evidence
import XCTest
@testable import ResourceWatch

final class PowerLogCopyTests: XCTestCase {
    private var root: URL!
    private var batteryLife: URL { root.appendingPathComponent("BatteryLife") }
    private var archives: URL { batteryLife.appendingPathComponent("Archives") }
    private var copies: URL { root.appendingPathComponent("spool/resources/powerlog") }
    private var copy: PowerLogCopy { PowerLogCopy(source: batteryLife, destination: copies, files: DeviceFiles(.plain), scratch: copies) }

    private let base = 1_790_812_680.0
    private var now: Date { Date(timeIntervalSince1970: base + 3_600) }

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("powerlog-copy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: archives, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: copies, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func rows(_ name: String) throws -> [[String: Any]] {
        let url = copies.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
    }

    private func ids(_ name: String) throws -> [Int] {
        try rows(name).map { try XCTUnwrap($0["ID"] as? Int) }
    }

    private func writeLog() throws -> PowerLogFixture {
        try PowerLogFixture.archive({ log in
            for id in 1...3 {
                try log.coalition(id: id, start: base + Double(id - 1) * 60, end: base + Double(id) * 60,
                                  bundle: "com.example.alpha", energy: 1_000 * id)
            }
            try log.battery(id: 1, at: base + 30, systemPower: 12.5, external: false)
        }, to: archives.appendingPathComponent("powerlog_2026-09-30_AAAA0001.PLSQL.gz"), scratch: root)
        try PowerLogFixture.archive({ log in
            for id in 3...4 {
                try log.coalition(id: id, start: base + Double(id - 1) * 60, end: base + Double(id) * 60,
                                  bundle: "com.example.alpha", energy: 1_000 * id)
            }
        }, to: archives.appendingPathComponent("powerlog_2026-10-01_AAAA0002.PLSQL.gz"), scratch: root)
        let current = try PowerLogFixture(batteryLife.appendingPathComponent(PowerLogCopy.currentName))
        for id in 4...6 {
            try current.coalition(id: id, start: base + Double(id - 1) * 60, end: base + Double(id) * 60,
                                  bundle: id == 6 ? nil : "com.example.alpha", energy: 1_000 * id, ane: 7, gpu: 3)
        }
        try current.battery(id: 2, at: base + 150, systemPower: 14.25, external: true)
        return current
    }

    func testEveryRowIsCopiedOnceIntoItsUTCDayAndTheLiveLogIsNeverOpened() throws {
        let current = try writeLog()
        defer { current.close() }
        let before = try FileManager.default.contentsOfDirectory(atPath: batteryLife.path).sorted()
        XCTAssertTrue(before.contains("CurrentPowerlog.PLSQL-wal"), "the fixture's newest rows are only in the WAL")

        let pass = try copy.run(now: now)

        XCTAssertEqual(pass.archivesRead, ["powerlog_2026-09-30_AAAA0001.PLSQL.gz", "powerlog_2026-10-01_AAAA0002.PLSQL.gz"])
        XCTAssertEqual(pass.rows, ["coalitions": 6, "battery": 2])
        XCTAssertEqual(try ids("coalitions-2026-09-30.jsonl"), [1, 2])
        XCTAssertEqual(try ids("coalitions-2026-10-01.jsonl"), [3, 4, 5, 6])
        XCTAssertEqual(try ids("battery-2026-09-30.jsonl"), [1])
        XCTAssertEqual(try ids("battery-2026-10-01.jsonl"), [2])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: batteryLife.path).sorted(), before,
                       "nothing new beside the live log: it was cloned, never opened in place")
        XCTAssertFalse(FileManager.default.fileExists(atPath: copies.appendingPathComponent(".work").path))

        let line = try String(contentsOf: copies.appendingPathComponent("coalitions-2026-10-01.jsonl"), encoding: .utf8)
            .split(separator: "\n")[1]
        XCTAssertEqual(String(line), """
            {"ane_energy_nj":0,"bundle_id":"com.example.alpha","cpu_time":0,"energy":4000,"energy_billed_to_me":0,\
            "gpu_energy_nj":0,"ID":4,"interrupt_wakeups":10,"LaunchdName":"application.synthetic.4",\
            "timestamp":"2026-10-01T00:01:00.000Z","timestampEnd":"2026-10-01T00:02:00.000Z"}
            """, "a row is its columns by name, NULLs left out, BundleId as bundle_id, instants in RFC 3339")
        let battery = try rows("battery-2026-09-30.jsonl")[0]
        XCTAssertEqual(battery["SystemPower"] as? Double, 12.5)
        XCTAssertEqual(battery["ChargerRegisterStatus"] as? String, "AP8=", "a BLOB is kept, in base64")
        XCTAssertNil(try rows("coalitions-2026-10-01.jsonl").last?["bundle_id"], "a coalition with no bundle states none")
    }

    func testTheCopysFilesAreTheOwnersAloneWhateverTheMask() throws {
        let current = try writeLog()
        defer { current.close() }
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: copies.path)
        let before = umask(0o022)
        defer { umask(before) }
        try copy.run(now: now)
        func mode(_ url: URL) throws -> Int {
            try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int)
        }
        XCTAssertEqual(try mode(copies), 0o700)
        let names = try FileManager.default.contentsOfDirectory(atPath: copies.path)
        XCTAssertTrue(names.contains(PowerLogCopy.cursorName))
        for name in names {
            XCTAssertEqual(try mode(copies.appendingPathComponent(name)), 0o600, "\(name) readable by every account")
        }
    }

    func testALaterPassAppendsOnlyNewRowsAndNeverRereadsAnArchive() throws {
        let current = try writeLog()
        defer { current.close() }
        try copy.run(now: now)
        let first = try Data(contentsOf: copies.appendingPathComponent("coalitions-2026-10-01.jsonl"))

        try current.coalition(id: 7, start: base + 360, end: base + 420, bundle: "com.example.beta", energy: 9)
        let pass = try copy.run(now: now)

        XCTAssertEqual(pass.archivesRead, [], "an archive is read once")
        XCTAssertEqual(pass.rows, ["coalitions": 1])
        let second = try Data(contentsOf: copies.appendingPathComponent("coalitions-2026-10-01.jsonl"))
        XCTAssertEqual(second.prefix(first.count), first, "a day's file only grows")
        XCTAssertEqual(try ids("coalitions-2026-10-01.jsonl"), [3, 4, 5, 6, 7])

        try PowerLogFixture.archive({ log in
            for id in 5...7 {
                try log.coalition(id: id, start: base + Double(id - 1) * 60, end: base + Double(id) * 60,
                                  bundle: "com.example.alpha", energy: 1)
            }
        }, to: archives.appendingPathComponent("powerlog_2026-10-02_AAAA0003.PLSQL.gz"), scratch: root)
        let rotated = try copy.run(now: now)
        XCTAssertEqual(rotated.archivesRead, ["powerlog_2026-10-02_AAAA0003.PLSQL.gz"])
        XCTAssertEqual(rotated.rows, [:])
    }

    func testALogThatStartsOverIsStillCopied() throws {
        let current = try writeLog()
        try copy.run(now: now)
        current.close()
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: batteryLife.appendingPathComponent(PowerLogCopy.currentName).path + suffix)
        }
        let fresh = try PowerLogFixture(batteryLife.appendingPathComponent(PowerLogCopy.currentName))
        defer { fresh.close() }
        try fresh.coalition(id: 1, start: base + 3_600, end: base + 3_660, bundle: "com.example.alpha", energy: 5)

        let pass = try copy.run(now: now)

        XCTAssertEqual(pass.rows, ["coalitions": 1])
        XCTAssertEqual(try ids("coalitions-2026-10-01.jsonl"), [3, 4, 5, 6, 1])
    }

    func testTheFirstPassOfADayPrunesFilesOlderThanThirtyDays() throws {
        let current = try writeLog()
        defer { current.close() }
        try copy.run(now: now)
        for name in ["coalitions-2026-08-30.jsonl", "battery-2026-08-30.jsonl", "coalitions-2026-09-01.jsonl", "notes.jsonl"] {
            try Data("{}\n".utf8).write(to: copies.appendingPathComponent(name))
        }
        let pass = try copy.run(now: Date(timeIntervalSince1970: base + 30 * 86_400 + 3_600))
        XCTAssertEqual(pass.rows, [:], "the cursor stayed: no row is copied again")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: copies.path).sorted(),
                       ["battery-2026-10-01.jsonl", "coalitions-2026-10-01.jsonl", "cursor.json", "notes.jsonl"])
    }

    func testNoPowerLogCopiesNothing() throws {
        let pass = try PowerLogCopy(source: root.appendingPathComponent("missing"), destination: copies, files: DeviceFiles(.plain), scratch: copies).run(now: now)
        XCTAssertEqual(pass, PowerLogCopy.Pass())
    }

    func testAKeyedCopyWorksInScratchAndKeepsItsLinesAndCursorEncrypted() throws {
        let current = try writeLog()
        defer { current.close() }
        let files = DeviceFiles(.keyed(SymmetricKey(data: Data(repeating: 0x42, count: 32))))
        let scratch = root.appendingPathComponent("scratch/watch")
        let keyed = PowerLogCopy(source: batteryLife, destination: copies, files: files, scratch: scratch)

        let pass = try keyed.run(now: now)

        XCTAssertEqual(pass.rows, ["coalitions": 6, "battery": 2])
        XCTAssertFalse(FileManager.default.fileExists(atPath: copies.appendingPathComponent(".work").path),
                       "no copy of the power log in the spool")
        XCTAssertFalse(FileManager.default.fileExists(atPath: scratch.appendingPathComponent(".work").path),
                       "the scratch copy is gone when the read ends")
        let lines = copies.appendingPathComponent("coalitions-2026-10-01.jsonl")
        let disk = try XCTUnwrap(FileManager.default.contents(atPath: lines.path))
        XCTAssertEqual(disk.first, 0x80)
        XCTAssertNil(disk.range(of: Data("com.example.alpha".utf8)), "no app name on disk")
        let plain = try XCTUnwrap(files.read(lines, maximumBytes: 1 << 20))
        let ids = try String(decoding: plain, as: UTF8.self).split(separator: "\n").map {
            try XCTUnwrap((JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])?["ID"] as? Int)
        }
        XCTAssertEqual(ids, [3, 4, 5, 6])
        let cursor = try XCTUnwrap(FileManager.default.contents(atPath: copies.appendingPathComponent(PowerLogCopy.cursorName).path))
        XCTAssertNil(cursor.range(of: Data("archives".utf8)), "the cursor is encrypted")

        XCTAssertEqual(try keyed.run(now: now).rows, [:], "the encrypted cursor reads back: nothing is copied twice")
    }

}
