import CryptoKit
import Evidence
import DeviceFiles
import Foundation
import Spool
import XCTest
@testable import Recorder

@MainActor
final class ResourceAccountTests: XCTestCase {
    func testALineIsSpelledAsTheSpecPinsIt() throws {
        let minute = ResourceMinute(
            work: [.ocr: ResourceTotals(cpuNs: 812_000_000, wallNs: 1_904_000_000, n: 29),
                   .shipping("screen"): ResourceTotals(cpuNs: 40_000_000, wallNs: 90_000_000, n: 1),
                   .shipping(nil): ResourceTotals(cpuNs: 3_000_000, wallNs: 5_000_000, n: 1),
                   .capture: ResourceTotals(cpuNs: 120_000_000, wallNs: 300_000_000, n: 30),
                   .menuBar: ResourceTotals(cpuNs: 2_000_000, wallNs: 2_100_000, n: 30),
                   .inputTap: ResourceTotals(cpuNs: 900_000, wallNs: 1_000_000, n: 412)],
            counts: [.bytesWritten: 1_048_576, .frames: 29, .gaps: 1, .ocrRequests: 64, .flushFull: 30])
        var process = ProcessUsage()
        process.cpuNs = 1_100_000_000
        process.cpuNsByQoS.utility = 700_000_000
        process.cpuNsByQoS.default = 50_000_000
        process.cpuNsByQoS.userInitiated = 300_000_000
        process.cpuNsByQoS.userInteractive = 50_000_000
        process.energyNj = 2_400_000_000
        process.instructions = 9_000_000_000
        process.cycles = 3_000_000_000
        process.diskReadBytes = 4096
        process.diskWriteBytes = 2_097_152
        process.logicalWriteBytes = 1_572_864
        process.interruptWakeups = 1200
        process.idleWakeups = 340
        process.footprintBytes = 183_500_800
        process.threads = 31
        let states = StateSeconds(awake: 60, displayAwake: 60, unlocked: 58, capturing: 58, onBattery: 60, lowPower: 0,
                                  thermalMax: .fair,
                                  front: ["proc:example-tool": 15, "com.example.editor": 45, "com.example.gone": 0])
        let line = ResourceLine.encode(at: instant("2026-10-03T04:10:00.000Z"), until: instant("2026-10-03T04:11:00.000Z"),
                                       build: "49b1e7d", pid: 80914, process: process, minute: minute, states: states)
        XCTAssertEqual(line, #"{"at":"2026-10-03T04:10:00.000Z","until":"2026-10-03T04:11:00.000Z","build":"49b1e7d","pid":80914,"process":{"cpu_ns":1100000000,"cpu_ns_by_qos":{"background":0,"utility":700000000,"default":50000000,"user_initiated":300000000,"user_interactive":50000000,"legacy":0,"maintenance":0},"energy_nj":2400000000,"instructions":9000000000,"cycles":3000000000,"disk_read_bytes":4096,"disk_write_bytes":2097152,"logical_write_bytes":1572864,"interrupt_wakeups":1200,"idle_wakeups":340,"footprint_bytes":183500800,"threads":31},"work":{"capture":{"cpu_ns":120000000,"wall_ns":300000000,"n":30},"ocr":{"cpu_ns":812000000,"wall_ns":1904000000,"n":29},"input_tap":{"cpu_ns":900000,"wall_ns":1000000,"n":412},"shipping":{"cpu_ns":3000000,"wall_ns":5000000,"n":1},"shipping:screen":{"cpu_ns":40000000,"wall_ns":90000000,"n":1},"menu_bar":{"cpu_ns":2000000,"wall_ns":2100000,"n":30}},"counts":{"frames":29,"gaps":1,"ocr_requests":64,"flush_full":30,"bytes_written":1048576},"state":{"awake_s":60,"display_awake_s":60,"unlocked_s":58,"capturing_s":58,"on_battery_s":60,"low_power_s":0,"thermal_max":"fair","front":{"com.example.editor":45,"proc:example-tool":15}}}"# + "\n")
        XCTAssertNoThrow(try JSONSerialization.jsonObject(with: Data(line.utf8)))
        XCTAssertEqual(ResourceLine.quoted("a\"b\\c\u{1}"), #""a\"b\\c\u0001""#)
    }

    func testTheHelpersUseFollowsTheProcessAndIsLeftOutWhenNone() throws {
        let minute = ResourceMinute(work: [:], counts: [.ocrHelperLifts: 2, .ocrHelperRestarts: 1, .ocrReadsFailed: 1,
                                                        .ocrTilesRecalled: 5])
        var helper = ProcessUsage()
        helper.cpuNs = 300_000_000
        helper.cpuNsByQoS.background = 280_000_000
        helper.energyNj = 90_000_000
        helper.threads = 9
        let at = Date(timeIntervalSince1970: 1_791_000_000)
        let line = ResourceLine.encode(at: at, until: at.addingTimeInterval(60), build: "b", pid: 1,
                                       process: ProcessUsage(), helper: helper, minute: minute, states: StateSeconds())
        XCTAssertTrue(line.contains(#""threads":0},"helper":{"cpu_ns":300000000,"cpu_ns_by_qos":{"background":280000000,"utility":0,"default":0,"user_initiated":0,"user_interactive":0,"legacy":0,"maintenance":0},"energy_nj":90000000,"instructions":0,"cycles":0,"disk_read_bytes":0,"disk_write_bytes":0,"logical_write_bytes":0,"interrupt_wakeups":0,"idle_wakeups":0,"footprint_bytes":0,"threads":9},"work":{}"#), line)
        XCTAssertTrue(line.contains(#""counts":{"ocr_tiles_recalled":5,"ocr_helper_lifts":2,"ocr_helper_restarts":1,"ocr_reads_failed":1}"#), line)
        let idle = ResourceLine.encode(at: at, until: at.addingTimeInterval(60), build: "b", pid: 1,
                                       process: ProcessUsage(), helper: ProcessUsage(), minute: minute, states: StateSeconds())
        XCTAssertFalse(idle.contains(#""helper""#))
    }

    func testTheMeterHandsOverAMinuteAndStartsAgain() {
        let meter = ResourceMeter()
        meter.count(.frames, 3)
        meter.count(.gaps, 0)
        meter.count(.ocr, units: 2)
        meter.count(.shipping("screen"), units: 1)
        meter.measure(.publish, units: 0) { spin() }
        var outer: UInt64 = 0
        let began = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        meter.measure(.capture) {
            spin()
            meter.measure(.browserPages) { spin() }
        }
        outer = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - began
        let minute = meter.take()
        XCTAssertEqual(minute.counts, [.frames: 3])
        XCTAssertEqual(Set(minute.work.keys), [.ocr, .shipping("screen"), .capture, .browserPages])
        XCTAssertEqual(minute.work[.ocr], ResourceTotals(cpuNs: 0, wallNs: 0, n: 2))
        let capture = minute.work[.capture]!, pages = minute.work[.browserPages]!
        XCTAssertEqual(capture.n, 1)
        XCTAssertEqual(pages.n, 1)
        XCTAssertGreaterThan(pages.cpuNs, 0)
        XCTAssertLessThanOrEqual(capture.wallNs + pages.wallNs, outer, "the inner measure is not counted twice")
        XCTAssertGreaterThan(capture.wallNs + pages.wallNs, outer / 2)
        XCTAssertEqual(meter.take(), ResourceMinute(), "a take starts the meter again")
    }

    func testAStopWritesThePartialMinute() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lifestream-resource-account")
        try? FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let wall = Wall(instant("2026-10-03T04:10:20.250Z"))
        let usage = Usage()
        var sources = ResourceAccount.Sources()
        sources.clock = { wall.now }
        sources.process = { usage.next() }
        sources.build = "abc1234-dirty"
        sources.pid = 4242
        sources.timer = false
        sources.observe = { states in
            states.set(.displayAwake, true)
            states.set(.unlocked, true)
            states.setFront("com.example.editor")
        }
        let account = ResourceAccount(directory: directory, files: DeviceFiles(.plain), sources: sources)
        let acquisition = Frames(wall: wall)
        var dependencies = RecorderDependencies(acquisition: acquisition, machine: AwakeMachine(), input: QuietInput(),
            clock: SteppingClock(), openStore: { Discarded() }, persistStatus: { _ in })
        dependencies.resources = account
        let recorder = Recorder(configuration: RecorderConfiguration(interval: 2), dependencies: dependencies)

        try recorder.start(duration: 9.9)
        await recorder.waitUntilStopped()
        XCTAssertEqual(acquisition.frames, 5, "five frames, each two seconds of the wall clock")
        wall.now = instant("2026-10-03T04:11:00.700Z")
        account.minutePassed()
        wall.now = instant("2026-10-03T04:11:05.500Z")
        await recorder.stop()
        await recorder.stop()

        let file = directory.appendingPathComponent("resources/app-2026-10-03.jsonl")
        let lines = try String(contentsOf: file, encoding: .utf8).split(separator: "\n").map(String.init)
        print("resource account artifact: \(file.path)")
        XCTAssertEqual(lines.count, 2, "the minute's line and the stop's, once")
        let first = try object(lines[0]), last = try object(lines[1])
        XCTAssertEqual(first["at"] as? String, "2026-10-03T04:10:20.250Z", "the first line starts at the start")
        XCTAssertEqual(first["until"] as? String, "2026-10-03T04:11:00.000Z", "and ends at the minute")
        XCTAssertEqual(last["at"] as? String, "2026-10-03T04:11:00.000Z", "the next starts where it ended")
        XCTAssertEqual(last["until"] as? String, "2026-10-03T04:11:05.500Z", "and the stop ends the partial minute")
        XCTAssertEqual(first["build"] as? String, "abc1234-dirty")
        XCTAssertEqual(first["pid"] as? Int, 4242)
        XCTAssertTrue(lines[0].hasPrefix(#"{"at":"2026-10-03T04:10:20.250Z","until":"2026-10-03T04:11:00.000Z","build":"abc1234-dirty","pid":4242,"process":{"cpu_ns":250000000,"cpu_ns_by_qos":{"background":0,"utility":250000000,"#),
                      "the process states this line's deltas: \(lines[0])")
        let process = try XCTUnwrap(first["process"] as? [String: Any])
        XCTAssertEqual(process["footprint_bytes"] as? Int, 51_000_000, "a level is read at the line's end")
        XCTAssertEqual(process["threads"] as? Int, 21)
        XCTAssertEqual((first["counts"] as? [String: Any])?["frames"] as? Int, 5)
        XCTAssertNil((last["counts"] as? [String: Any])?["frames"], "a line's work does not leak into the next")
        let state = try XCTUnwrap(first["state"] as? [String: Any])
        XCTAssertEqual(state["awake_s"] as? Int, 40)
        XCTAssertEqual(state["display_awake_s"] as? Int, 40)
        XCTAssertEqual(state["capturing_s"] as? Int, 10, "five two-second frames, then the run's end")
        XCTAssertEqual(state["on_battery_s"] as? Int, 0)
        XCTAssertEqual(state["thermal_max"] as? String, "nominal")
        XCTAssertEqual(state["front"] as? [String: Int], ["com.example.editor": 40])
        let stopped = try XCTUnwrap(last["state"] as? [String: Any])
        XCTAssertEqual(stopped["awake_s"] as? Int, 6)
        XCTAssertEqual(stopped["capturing_s"] as? Int, 0)
        XCTAssertEqual(stopped["front"] as? [String: Int], ["com.example.editor": 6])
    }

    func testTheProcessReadStatesNanoseconds() throws {
        let before = try XCTUnwrap(ProcessUsage.read(pid: getpid()))
        let clockBefore = clock_gettime_nsec_np(CLOCK_PROCESS_CPUTIME_ID)
        for _ in 0..<20 { spin() }
        let clockSpent = Double(clock_gettime_nsec_np(CLOCK_PROCESS_CPUTIME_ID) - clockBefore)
        let after = try XCTUnwrap(ProcessUsage.read(pid: getpid()))
        let spent = Double(after.since(before).cpuNs)
        XCTAssertGreaterThan(spent, clockSpent * 0.5, "\(spent) ns against the clock's \(clockSpent)")
        XCTAssertLessThan(spent, clockSpent * 2 + 5_000_000)
        XCTAssertGreaterThan(after.footprintBytes, 1_000_000)
        XCTAssertGreaterThan(after.threads, 0)
    }

    func testTheFirstLineOfADayPrunesFilesOlderThanThirtyDays() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("resources-\(UUID().uuidString)")
        let resources = directory.appendingPathComponent(ResourceAccount.folderName)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for name in ["app-2026-09-01.jsonl", "app-2026-09-03.jsonl", "watch-2026-09-01.jsonl"] {
            try Data("{}\n".utf8).write(to: resources.appendingPathComponent(name))
        }
        let wall = Wall(instant("2026-10-03T00:00:10.000Z"))
        var sources = ResourceAccount.Sources()
        sources.clock = { wall.now }
        sources.timer = false
        let account = ResourceAccount(directory: directory, files: DeviceFiles(.plain), meter: ResourceMeter(), sources: sources)
        account.start()
        wall.now = instant("2026-10-03T00:00:30.000Z")
        await account.cut()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: resources.path).sorted(),
                       ["app-2026-09-03.jsonl", "app-2026-10-03.jsonl", "watch-2026-09-01.jsonl"])
    }

    func testAKeyedMacWritesItsLinesKeyedThroughTheSwitchingInstance() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("resources-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let wall = Wall(instant("2026-10-03T04:10:00.000Z"))
        var sources = ResourceAccount.Sources()
        sources.clock = { wall.now }
        sources.timer = false
        sources.observe = { states in states.setFront("com.example.private-diary") }
        let files = DeviceFiles(.plain)
        let account = ResourceAccount(directory: directory, files: files, meter: ResourceMeter(),
                                      sources: sources)
        account.start()
        wall.now = instant("2026-10-03T04:10:30.000Z")
        await account.cut()
        let file = directory.appendingPathComponent("resources/app-2026-10-03.jsonl")
        let plainLine = try XCTUnwrap(String(contentsOf: file, encoding: .utf8).split(separator: "\n").map(String.init).first)
        let plainFront = try XCTUnwrap(try object(plainLine)["state"] as? [String: Any])["front"] as? [String: Int]
        XCTAssertEqual(plainFront, ["com.example.private-diary": 30], "a plain Mac spells the app as before")
        try files.becomeKeyed(SymmetricKey(size: .bits256)) { _ in try FileManager.default.removeItem(at: file) }
        wall.now = instant("2026-10-03T04:11:00.000Z")
        await account.cut()

        XCTAssertNil(try Data(contentsOf: file).range(of: Data("private-diary".utf8)), "the keyed Mac wrote an app's name to disk")
        let read = try XCTUnwrap(try files.read(file, maximumBytes: 1 << 20), "the keyed line does not open with the key")
        let lines = try XCTUnwrap(String(data: read, encoding: .utf8)).split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, 1)
        let keyedFront = try XCTUnwrap(try object(lines[0])["state"] as? [String: Any])["front"] as? [String: Int]
        XCTAssertEqual(keyedFront, [files.name("com.example.private-diary"): 30], "a keyed Mac spells the app as a keyed name")
    }

    func testALineThatCannotBeWrittenIsCountedInTheNext() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("resources-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data().write(to: directory.appendingPathComponent(ResourceAccount.folderName))
        let wall = Wall(instant("2026-10-03T23:59:30.000Z"))
        let meter = ResourceMeter()
        var sources = ResourceAccount.Sources()
        sources.clock = { wall.now }
        sources.timer = false
        let account = ResourceAccount(directory: directory, files: DeviceFiles(.plain), meter: meter, sources: sources)
        account.start()
        wall.now = instant("2026-10-04T00:00:01.000Z")
        await account.cut()
        XCTAssertEqual(meter.take().counts, [.resourceLinesDropped: 1])
    }
}


private func instant(_ spelling: String) -> Date {
    UTCInstant.date(rfc3339: spelling)!
}

private func object(_ line: String) throws -> [String: Any] {
    try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
}

private func spin() {
    var x = 0.0
    for i in 0..<200_000 { x += Double(i).squareRoot() }
    XCTAssertGreaterThan(x, 0)
}

private final class Wall: @unchecked Sendable {
    private let lock = NSLock()
    private var instant: Date
    init(_ instant: Date) { self.instant = instant }
    var now: Date {
        get { lock.withLock { instant } }
        set { lock.withLock { instant = newValue } }
    }
}

private final class Usage: @unchecked Sendable {
    private let lock = NSLock()
    private var reads: UInt64 = 0
    func next() -> ProcessUsage {
        lock.withLock {
            defer { reads += 1 }
            var usage = ProcessUsage()
            usage.cpuNs = 1_000_000_000 + reads * 250_000_000
            usage.cpuNsByQoS.utility = 1_000_000_000 + reads * 250_000_000
            usage.energyNj = 5_000_000_000 + reads * 1_000_000_000
            usage.footprintBytes = 50_000_000 + reads * 1_000_000
            usage.threads = 20 + reads
            return usage
        }
    }
}

@MainActor private final class SteppingClock: RecorderClock {
    private(set) var uptime: Double = 1000
    var date: Date { Date(timeIntervalSince1970: 1_700_000_000 + uptime) }
    func sleep(for seconds: Double) async throws {
        try Task.checkCancellation()
        guard seconds < 10 else {
            try await Task.sleep(nanoseconds: UInt64.max / 2)
            return
        }
        uptime += seconds
        await Task.yield()
    }
}

@MainActor private final class Frames: RecorderAcquisition {
    private let wall: Wall
    private(set) var frames = 0
    init(wall: Wall) { self.wall = wall }
    var screenRecordingAllowed: Bool { true }
    func invalidate() {}
    func inputIdleSeconds() -> Double? { 0 }
    func setModes(_ modes: RecordingModes) {}
    func capture() async throws -> CaptureAttempt {
        frames += 1
        wall.now = wall.now.addingTimeInterval(2)
        let observation = CaptureObservation(capturedAt: wall.now, displayID: 1, width: 4, height: 4)
        return .done([CaptureResult(observation: observation, image: .png(Data([0x89, 0x50, 0x4e, 0x47])))])
    }
}

private final class Discarded: RecorderStorage, @unchecked Sendable {
    func append(_ observation: CaptureObservation, image: CaptureImage?) async throws {}
    func hasBackpressure() -> Bool { false }
    func compact(flush: Bool) async throws -> VideoCompactionReport {
        VideoCompactionReport(imageCount: 0, pendingImageCount: 0, pendingBytes: 0)
    }
}

@MainActor private final class AwakeMachine: RecorderMachine {
    var availability: RecorderAvailability { RecorderAvailability(displayAwake: true, sessionActive: true) }
    var availabilityChanged: ((RecorderAvailability) -> Void)?
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
}

@MainActor private final class QuietInput: RecorderInput {
    var status: RecorderInputStatus { RecorderInputStatus(state: .off) }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
}
