import Evidence
import DeviceFiles
import XCTest
@testable import ResourceWatch

final class ResourceReportTests: XCTestCase {
    private var package: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    private static func date(_ spelling: String) -> Date {
        guard let value = UTCInstant.date(rfc3339: spelling) else { fatalError("bad fixture instant \(spelling)") }
        return value
    }

    private static func appLine(_ minute: Int) -> String {
        let start = date("2026-10-03T04:10:00.000Z").addingTimeInterval(Double(minute) * 60)
        let qos = #"{"background":0,"utility":500000000,"default":0,"user_initiated":0,"user_interactive":0,"legacy":0,"maintenance":0}"#
        return #"""
            {"at":"\#(UTCInstant.rfc3339(start))","until":"\#(UTCInstant.rfc3339(start.addingTimeInterval(60)))",\#
            "build":"49b1e7d","pid":80914,"process":{"cpu_ns":500000000,"cpu_ns_by_qos":\#(qos),\#
            "energy_nj":6000000000,"instructions":0,"cycles":0,"disk_read_bytes":0,"disk_write_bytes":0,\#
            "logical_write_bytes":0,"interrupt_wakeups":0,"idle_wakeups":0,"footprint_bytes":0,"threads":30},\#
            "work":{"ocr":{"cpu_ns":300000000,"wall_ns":600000000,"n":30}},"counts":{"frames":30},\#
            "state":{"awake_s":60,"display_awake_s":60,"unlocked_s":60,"capturing_s":58,"on_battery_s":0,\#
            "low_power_s":0,"thermal_max":"nominal","front":{"com.example.app":60}}}
            """#
    }

    func testTheReportReadsWhatTheWatcherAndTheCopyWrote() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("resource-report-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let resources = root.appendingPathComponent("spool/resources")
        let batteryLife = root.appendingPathComponent("BatteryLife")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: batteryLife.appendingPathComponent("Archives"), withIntermediateDirectories: true)

        try Data((0..<3).map { Self.appLine($0) + "\n" }.joined().utf8)
            .write(to: resources.appendingPathComponent("app-2026-10-03.jsonl"))

        var usage = ProcessUsage()
        let reading = { AppReading(pid: 80_914, started: Self.date("2026-10-03T03:00:00.000Z"), build: "49b1e7d", usage: usage) }
        var own = ProcessUsage()
        let watcher = ResourceWatcher(directory: resources, sources: WatchSources(
            app: { reading() },
            mac: { MacPowerSample(powerMW: 12_000, batteryPercent: 80, externalPower: true) },
            watcher: { own }))
        var now = Self.date("2026-10-03T04:10:00.000Z")
        while now <= Self.date("2026-10-03T04:13:00.000Z") {
            usage.energyNj += 1_000_000_000
            usage.cpuNs += 83_333_333
            own.cpuNs += 200_000
            watcher.tick(at: now)
            now = now.addingTimeInterval(10)
        }

        let log = try PowerLogFixture(batteryLife.appendingPathComponent(PowerLogCopy.currentName))
        defer { log.close() }
        let from = Self.date("2026-10-03T04:09:00.000Z").timeIntervalSince1970
        try log.coalition(id: 1, start: from, end: from + 300, bundle: "org.lifestreamprotocol.screen-capture",
                          energy: 30_000_000_000, ane: 8_000_000_000, gpu: 1_000_000_000, billed: 1_000_000_000, cpu: 2.5)
        try log.coalition(id: 2, start: from, end: from + 300, bundle: "com.example.other", energy: 3_570_000_000_000)
        for minute in 0..<5 {
            try log.battery(id: minute + 1, at: from + Double(minute) * 60 + 30, systemPower: 12, external: true)
        }
        try PowerLogCopy(source: batteryLife, destination: resources.appendingPathComponent("powerlog"), files: DeviceFiles(.plain), scratch: resources.appendingPathComponent("powerlog"))
            .run(now: Self.date("2026-10-03T04:14:00.000Z"))

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [package.appendingPathComponent("benchmarks/resources-report.py").path,
                             "--store", root.appendingPathComponent("spool").path, "--json"]
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        try data.write(to: root.appendingPathComponent("report.json"))

        let report = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let bucket = try XCTUnwrap((report["buckets"] as? [String: Any])?["49b1e7d"] as? [String: Any])
        XCTAssertEqual(bucket["minutes"] as? Int, 3)
        let watts = try XCTUnwrap(bucket["app_watts"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(watts["own"] as? Double), 0.1, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(watts["watcher"] as? Double), 0.1, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(watts["macos"] as? Double), 40.0 / 300, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap((watts["macos_parts"] as? [String: Any])?["energy"] as? Double), 0.1, accuracy: 1e-9)
        let mac = try XCTUnwrap(bucket["mac_watts"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(mac["watcher"] as? Double), 12, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(mac["power_log"] as? Double), 12, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(mac["all_coalitions"] as? Double), 3_609.0 / 300, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(bucket["app_share_of_mac"] as? Double), 0.1 / 12, accuracy: 1e-9)
        let cpu = try XCTUnwrap(bucket["app_cpu_ms_per_minute"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(cpu["watcher"] as? Double), 500, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(cpu["macos"] as? Double), 500, accuracy: 1e-6)
        XCTAssertEqual((bucket["disagreements"] as? [Any])?.count, 0, "\(bucket["disagreements"] ?? "")")
        let cost = try XCTUnwrap(bucket["watcher_cost"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(cost["cpu_ms_per_minute"] as? Double), 1.2, accuracy: 1e-9)
    }
}
