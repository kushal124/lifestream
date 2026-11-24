import Evidence
import XCTest
@testable import ResourceWatch

final class WatcherTests: XCTestCase {
    private var root: URL!
    private var resources: URL { root.appendingPathComponent("resources") }

    private var app: AppReading?
    private var registry: [String: Any] = [:]
    private var own = ProcessUsage()

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("resource-watch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        app = nil
        registry = Self.onAdapter(systemLoad: 13_400)
        own = ProcessUsage()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func watcher() -> ResourceWatcher {
        ResourceWatcher(directory: resources, sources: WatchSources(
            app: { [unowned self] in app },
            mac: { [unowned self] in MacPowerSample { self.registry[$0] } },
            watcher: { [unowned self] in own }))
    }

    private static func date(_ spelling: String) -> Date {
        guard let value = UTCInstant.date(rfc3339: spelling) else { fatalError("bad fixture instant \(spelling)") }
        return value
    }

    private static func onAdapter(systemLoad: Int) -> [String: Any] {
        ["ExternalConnected": true, "CurrentCapacity": 80, "MaxCapacity": 100,
         "PowerTelemetryData": ["SystemLoad": systemLoad, "SystemPowerIn": systemLoad + 900],
         "Voltage": 12_236, "InstantAmperage": 0]
    }

    private static func onBattery(millivolts: Int, milliamps: Int) -> [String: Any] {
        ["ExternalConnected": false, "CurrentCapacity": 79, "MaxCapacity": 100,
         "Voltage": millivolts, "InstantAmperage": NSNumber(value: UInt64(bitPattern: Int64(milliamps)))]
    }

    private static func usage(cpuSeconds: Double, energyJoules: Double = 0) -> ProcessUsage {
        var usage = ProcessUsage()
        usage.cpuNs = UInt64(cpuSeconds * 1e9)
        usage.cpuNsByQoS.utility = UInt64(cpuSeconds * 1e9)
        usage.energyNj = UInt64(energyJoules * 1e9)
        usage.interruptWakeups = UInt64(cpuSeconds * 100)
        usage.footprintBytes = 200_000_000
        usage.threads = 30
        return usage
    }

    private func lines() throws -> [[String: Any]] {
        let files = try FileManager.default.contentsOfDirectory(atPath: resources.path).filter { $0.hasPrefix("watch-") }.sorted()
        return try files.flatMap { name in
            try String(contentsOf: resources.appendingPathComponent(name), encoding: .utf8).split(separator: "\n").map {
                try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
            }
        }
    }

    private func rawLines(_ day: String) throws -> [String] {
        try String(contentsOf: resources.appendingPathComponent("watch-\(day).jsonl"), encoding: .utf8)
            .split(separator: "\n").map(String.init)
    }

    private func process(_ line: [String: Any]) -> [String: Any]? {
        (line["app"] as? [String: Any])?["process"] as? [String: Any]
    }

    private func run(_ watch: ResourceWatcher, from: Date, through: Date, cpuPerRead: Double = 0.5,
                     change: (Date) -> Void = { _ in }) {
        var now = from
        while now <= through {
            change(now)
            if let current = app {
                let seconds = Double(current.usage.cpuNs) / 1e9 + cpuPerRead
                app?.usage = Self.usage(cpuSeconds: seconds, energyJoules: seconds * 2)
            }
            own.cpuNs += 120_000
            own.energyNj += 3_000
            watch.tick(at: now)
            now = Date(timeIntervalSince1970: ((now.timeIntervalSince1970 / 10).rounded(.down) + 1) * 10)
        }
    }

    func testEachWallClockMinuteIsOneLineAndTheFirstBeginsAtLaunch() throws {
        app = AppReading(pid: 80_914, started: Self.date("2026-10-03T03:00:00.000Z"), build: "49b1e7d",
                         usage: Self.usage(cpuSeconds: 100, energyJoules: 200))
        let watch = watcher()
        run(watch, from: Self.date("2026-10-03T04:09:35.250Z"), through: Self.date("2026-10-03T04:11:00.000Z"))
        watch.stop(at: Self.date("2026-10-03T04:11:05.500Z"))

        let written = try lines()
        XCTAssertEqual(written.map { $0["at"] as? String }, ["2026-10-03T04:09:35.250Z", "2026-10-03T04:10:00.000Z",
                                                             "2026-10-03T04:11:00.000Z"])
        XCTAssertEqual(written.map { $0["until"] as? String }, ["2026-10-03T04:10:00.000Z", "2026-10-03T04:11:00.000Z",
                                                                "2026-10-03T04:11:05.500Z"])
        XCTAssertEqual(written.map { ($0["mac"] as? [String: Any])?["samples"] as? Int }, [3, 6, 1],
                       "the read on a minute belongs to the minute it opens")
        XCTAssertEqual(written.map { self.process($0)?["cpu_ns"] as? Int }, [1_500_000_000, 3_000_000_000, 0],
                       "counters from the read at launch: the app's earlier use is not this line's")
        XCTAssertEqual(try rawLines("2026-10-03")[1], """
            {"app":{"build":"49b1e7d","pid":80914,"process":{"cpu_ns":3000000000,"cpu_ns_by_qos":{"background":0,\
            "default":0,"legacy":0,"maintenance":0,"user_initiated":0,"user_interactive":0,"utility":3000000000},\
            "cycles":0,"disk_read_bytes":0,"disk_write_bytes":0,"energy_nj":6000000000,"footprint_bytes":200000000,\
            "idle_wakeups":0,"instructions":0,"interrupt_wakeups":300,"logical_write_bytes":0,"threads":30},\
            "restarted":false},"at":"2026-10-03T04:10:00.000Z","mac":{"battery_percent":80,"external_power":true,\
            "samples":6,"system_power_mw":13400},"until":"2026-10-03T04:11:00.000Z",\
            "watcher":{"cpu_ns":720000,"energy_nj":18000}}
            """, "the watcher's line, byte for byte: macos-app/Sources/ResourceWatch/README.md")
    }

    private func mode(_ url: URL) throws -> Int {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int)
    }

    func testAtStartAnOlderReleasesWideFilesAndFoldersAreNarrowedAndKept() throws {
        let powerlog = resources.appendingPathComponent("powerlog")
        try FileManager.default.createDirectory(at: powerlog, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o755])
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: resources.path)
        let files = [resources.appendingPathComponent("watch-2026-10-03.jsonl"),
                     resources.appendingPathComponent("recorder-2026-10-03.jsonl"),
                     powerlog.appendingPathComponent("coalitions-2026-10-02.jsonl"),
                     powerlog.appendingPathComponent("cursor.json")]
        for file in files {
            try Data("{\"old\":true}\n".utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        }

        let watch = watcher()
        XCTAssertEqual(try mode(resources), 0o700)
        XCTAssertEqual(try mode(powerlog), 0o700)
        for file in files {
            XCTAssertEqual(try mode(file), 0o600, "\(file.lastPathComponent) still readable by every account")
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "{\"old\":true}\n", "\(file.lastPathComponent) lost its lines")
        }

        run(watch, from: Self.date("2026-10-03T04:09:50.000Z"), through: Self.date("2026-10-03T04:10:10.000Z"))
        watch.stop(at: Self.date("2026-10-03T04:10:15.000Z"))
        XCTAssertEqual(try rawLines("2026-10-03").count, 3, "the old line and the two new")
        XCTAssertEqual(try mode(files[0]), 0o600)
        let fresh = resources.appendingPathComponent("fresh")
        let freshWatch = ResourceWatcher(directory: fresh, sources: WatchSources(app: { nil }, mac: { nil }, watcher: { ProcessUsage() }))
        freshWatch.tick(at: Self.date("2026-10-03T04:09:50.000Z"))
        freshWatch.stop(at: Self.date("2026-10-03T04:10:00.000Z"))
        XCTAssertEqual(try mode(fresh), 0o700, "a new folder made wide")
        XCTAssertEqual(try mode(fresh.appendingPathComponent("watch-2026-10-03.jsonl")), 0o600, "a new file made 0644")
    }

    func testTheFirstLineOfADayPrunesFilesOlderThanThirtyDays() throws {
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        for name in ["watch-2026-09-01.jsonl", "watch-2026-09-03.jsonl", "app-2026-09-01.jsonl"] {
            try Data("{}\n".utf8).write(to: resources.appendingPathComponent(name))
        }
        let watch = watcher()
        run(watch, from: Self.date("2026-10-03T04:09:50.000Z"), through: Self.date("2026-10-03T04:10:10.000Z"))
        watch.stop(at: Self.date("2026-10-03T04:10:15.000Z"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: resources.path).sorted(),
                       ["app-2026-09-01.jsonl", "watch-2026-09-03.jsonl", "watch-2026-10-03.jsonl"])
    }

    func testARestartInsideTheMinuteCountsBothProcessesAndSaysSo() throws {
        let first = Self.date("2026-10-03T03:00:00.000Z")
        app = AppReading(pid: 100, started: first, build: "49b1e7d", usage: Self.usage(cpuSeconds: 50))
        let watch = watcher()
        run(watch, from: Self.date("2026-10-03T04:10:00.000Z"), through: Self.date("2026-10-03T04:12:00.000Z")) { now in
            if now == Self.date("2026-10-03T04:10:30.000Z") { self.app = nil }
            if now == Self.date("2026-10-03T04:10:40.000Z") {
                self.app = AppReading(pid: 200, started: Self.date("2026-10-03T04:10:35.000Z"), build: "aaaa111",
                                      usage: Self.usage(cpuSeconds: 1.0))
            }
        }
        let written = try lines()
        XCTAssertEqual(written.count, 2)
        let restarted = try XCTUnwrap(written[0]["app"] as? [String: Any])
        XCTAssertEqual(restarted["pid"] as? Int, 200)
        XCTAssertEqual(restarted["build"] as? String, "aaaa111")
        XCTAssertEqual(restarted["restarted"] as? Bool, true)
        XCTAssertEqual(process(written[0])?["cpu_ns"] as? Int, 3_500_000_000)
        XCTAssertEqual((written[1]["app"] as? [String: Any])?["restarted"] as? Bool, false)
        XCTAssertEqual(process(written[1])?["cpu_ns"] as? Int, 3_000_000_000)
    }

    func testAMinuteWithoutTheAppStatesNoApp() throws {
        let watch = watcher()
        run(watch, from: Self.date("2026-10-03T04:10:00.000Z"), through: Self.date("2026-10-03T04:11:00.000Z"))
        let written = try lines()
        XCTAssertEqual(written.count, 1)
        XCTAssertNil(written[0]["app"])
        XCTAssertNotNil(written[0]["watcher"])
    }

    func testASleepEndsTheLineAtTheLastReadBeforeIt() throws {
        app = AppReading(pid: 100, started: Self.date("2026-10-03T03:00:00.000Z"), build: "49b1e7d",
                         usage: Self.usage(cpuSeconds: 50))
        let watch = watcher()
        run(watch, from: Self.date("2026-10-03T04:10:00.000Z"), through: Self.date("2026-10-03T04:10:20.000Z"))
        run(watch, from: Self.date("2026-10-03T23:59:55.000Z"), through: Self.date("2026-10-04T00:00:10.000Z"))
        watch.stop(at: Self.date("2026-10-04T00:00:15.000Z"))

        let written = try lines()
        XCTAssertEqual(written.map { "\($0["at"]!)–\($0["until"]!)" }, [
            "2026-10-03T04:10:00.000Z–2026-10-03T04:10:20.000Z",
            "2026-10-03T23:59:55.000Z–2026-10-04T00:00:00.000Z",
            "2026-10-04T00:00:00.000Z–2026-10-04T00:00:15.000Z",
        ], "no line spans the sleep; each goes to the file of the UTC day it begins")
        XCTAssertEqual(try rawLines("2026-10-03").count, 2)
        XCTAssertEqual(try rawLines("2026-10-04").count, 1)
        XCTAssertEqual(written.compactMap { self.process($0)?["cpu_ns"] as? Int }, [1_000_000_000, 500_000_000, 500_000_000])
    }

    func testTheMacsPowerIsTheBatterysDischargeOrTheAdaptersSystemLoad() throws {
        let watch = watcher()
        registry = Self.onBattery(millivolts: 12_158, milliamps: -1_100)
        run(watch, from: Self.date("2026-10-03T04:10:00.000Z"), through: Self.date("2026-10-03T04:10:50.000Z"))
        registry = Self.onAdapter(systemLoad: 10_814)
        run(watch, from: Self.date("2026-10-03T04:11:00.000Z"), through: Self.date("2026-10-03T04:11:50.000Z"))
        registry = [:]
        run(watch, from: Self.date("2026-10-03T04:12:00.000Z"), through: Self.date("2026-10-03T04:13:00.000Z"))

        let macs = try lines().map { $0["mac"] as? [String: Any] }
        XCTAssertEqual(macs[0]?["system_power_mw"] as? Int, 13_374, "12.158 V × 1.100 A")
        XCTAssertEqual(macs[0]?["external_power"] as? Bool, false)
        XCTAssertEqual(macs[0]?["battery_percent"] as? Int, 79)
        XCTAssertEqual(macs[1]?["system_power_mw"] as? Int, 10_814, "SystemLoad, not SystemPowerIn")
        XCTAssertEqual(macs[1]?["external_power"] as? Bool, true)
        XCTAssertNil(macs[2], "a Mac with no battery entry states no mac")
    }
}
