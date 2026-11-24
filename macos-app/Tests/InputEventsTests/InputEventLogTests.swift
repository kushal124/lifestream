import Evidence
import DeviceFiles
import Foundation
import XCTest
@testable import InputEvents

final class InputEventLogTests: XCTestCase {
    private var root: URL!
    private let zone = TimeZone(identifier: "Asia/Kolkata")!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("input-log-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var folder: URL { root.appendingPathComponent(InputEventBatch.directoryName) }

    private func log(_ source: FakeSource, _ reader: FakeReader = FakeReader(),
                     clock: InputEventClock = .held) -> InputEventLog {
        let log = InputEventLog(directory: root, files: DeviceFiles(.plain), modes: RecordingModes(exclude: [Synthetic.vault]), timeZone: zone, report: { _ in },
                                source: source, reader: reader, clock: clock)
        addTeardownBlock { log.stop() }
        return log
    }

    private func sealedChunks() throws -> [InputChunk] {
        try InputEventBatch.sealedBatches(in: folder).flatMap { name in
            try String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8)
                .split(separator: "\n").map { try InputEventCodec.chunk(String($0)) }
        }
    }

    private func raw(_ type: RawInputEventType, target: Int32 = 501, code: Int = 0,
                     characters: String = "") -> InputBufferItem {
        Synthetic.raw(type, at: Synthetic.opened, target: target, code: code, characters: characters)
    }

    func testARunOpensWithLogStartAndStopReturnsOnlyAfterTheBatchIsSealed() throws {
        let source = FakeSource()
        let log = log(source)
        log.start()
        XCTAssertEqual(source.calls, ["opening state", "start"])
        XCTAssertEqual(log.status.state, .recording)
        source.push(raw(.keyDown, code: 0, characters: "a"))
        source.push(raw(.keyUp, code: 0))
        source.push(raw(.leftMouseUp, target: 503))
        try until("log.status.events == 2") { log.status.events == 2 }
        log.stop()
        XCTAssertEqual(source.calls, ["opening state", "start", "stop"])
        XCTAssertEqual(log.status.state, .stopped)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("current.jsonl").path))
        let chunks = try sealedChunks()
        XCTAssertEqual(chunks.count, 1)
        let bodies = chunks[0].events.map(\.body)
        XCTAssertEqual(bodies.first, .logStart(inputMonitoring: true, accessibility: true))
        XCTAssertEqual(bodies.last, .logStop)
        guard case .keyDown(let key) = bodies[1] else { return XCTFail("no key_down") }
        XCTAssertEqual(key.key, "a")
        XCTAssertEqual(key.el?.attributes.role, "AXTextField", "the reader's element is attached")
        XCTAssertEqual(chunks[0].apps, [Synthetic.editor], "the excluded app left nothing")
        XCTAssertEqual(log.status.chunks, 1)
    }

    func testWhatTheLastRunLeftIsRecoveredBeforeTheTapOpens() throws {
        let crashed = ChunkerOnFiles(files: try InputEventFiles(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: zone), zone: zone)
        crashed.chunker.handle(Synthetic.raw(.leftMouseUp, at: Synthetic.opened.addingTimeInterval(1)), uptime: 0)
        let chunkFile = folder.appendingPathComponent(InputEventBatch.chunkName)
        let source = FakeSource()
        source.probeAtStart = {
            ((try? String(contentsOf: chunkFile, encoding: .utf8)) ?? "").contains("\"e\":\"up\"")
        }
        let next = log(source)
        next.start()
        XCTAssertEqual(source.probedAtStart, false, "the crashed minute was rebuilt before the tap opened")
        let recovered = try sealedChunks()
        XCTAssertEqual(recovered.count, 1)
        XCTAssertTrue(recovered[0].recovered)
        XCTAssertEqual(recovered[0].events.map(\.body.name), [.logStart, .up])
        next.stop()
        XCTAssertEqual(try sealedChunks().count, 2)
    }

    func testARelaunchAtTheSameInstantNeverReusesAChunksInstant() throws {
        for stop in [20.0, 25.0] {
            let run = ChunkerOnFiles(files: try InputEventFiles(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: zone), zone: zone)
            run.chunker.handle(Synthetic.raw(.leftMouseUp, at: Synthetic.opened.addingTimeInterval(1)), uptime: 0)
            run.chunker.finish(at: Synthetic.opened.addingTimeInterval(stop))
            XCTAssertTrue(run.chunker.isDrained)
            try run.files.seal()
        }
        let chunks = try sealedChunks()
        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(chunks[0].at, Synthetic.opened)
        XCTAssertEqual(chunks[1].at, chunks[0].until, "the second run opened where the first ended")
    }

    func testWithoutInputMonitoringTheLogRecordsTheMouseAndSaysSo() throws {
        let source = FakeSource()
        source.keys = false
        source.opening = Synthetic.state(inputMonitoring: false)
        let log = log(source)
        log.start()
        XCTAssertEqual(log.status.state, .permissionRequired)
        source.push(raw(.leftMouseUp))
        try until("log.status.events == 1") { log.status.events == 1 }
        log.stop()
        let chunk = try XCTUnwrap(try sealedChunks().first)
        XCTAssertEqual(chunk.events.first?.body, .logStart(inputMonitoring: false, accessibility: true))
    }

    func testAHungApplicationCostsItsEventsOneTimeoutAndNothingMore() throws {
        let source = FakeSource()
        let reader = FakeReader()
        reader.set(Synthetic.element(role: "AXButton"), latency: 0.4)
        let log = log(source, reader, clock: InputEventClock(now: InputEventClock.held.now, uptime: InputEventClock.system.uptime))
        log.start()
        source.push(raw(.leftMouseDown))
        source.push(raw(.leftMouseUp))
        try until("log.status.events == 2") { log.status.events == 2 }
        log.stop()
        let events = try XCTUnwrap(try sealedChunks().first).events
        guard case .down(let down) = events[1].body else { return XCTFail("no down") }
        XCTAssertEqual(down.el?.err, .timeout)
        XCTAssertEqual(events.map(\.body.name), [.logStart, .down, .up, .logStop])
    }

    func testStopWaitsForALookupStillInFlight() throws {
        let source = FakeSource()
        let reader = FakeReader()
        reader.set(Synthetic.element(role: "AXLink", title: "Downloads"), latency: 0.05)
        let log = log(source, reader)
        log.start()
        source.push(raw(.leftMouseDown))
        log.stop()
        let events = try XCTUnwrap(try sealedChunks().first).events
        guard case .down(let down) = events[1].body else { return XCTFail("no down") }
        XCTAssertEqual(down.el?.attributes.title, "Downloads")
        XCTAssertEqual(reader.reads, [.position(pid: 501, app: Synthetic.editor, x: 0, y: 0)])
    }

    func testTheCountsStartOverEachRunAndATapRestartIsReported() throws {
        let source = FakeSource()
        let log = log(source)
        log.start()
        source.push(raw(.leftMouseUp))
        source.push(.tapRestart(.timeout, at: Synthetic.opened))
        try until("log.status.tapRestarts == 1 && log.status.events == 1") { log.status.tapRestarts == 1 && log.status.events == 1 }
        XCTAssertEqual(log.status.lastTapRestart?.reason, "timeout")
        log.stop()
        log.start()
        XCTAssertEqual(log.status.events, 0)
        XCTAssertEqual(log.status.tapRestarts, 0)
        log.stop()
        XCTAssertEqual(try sealedChunks().count, 2)
    }

    func testAModeChangeReachesTheNextEventWithoutARestart() throws {
        let source = FakeSource()
        source.names[505] = "com.example.chat"
        let log = log(source)
        log.start()
        source.push(raw(.leftMouseUp, target: 505))
        try until("log.status.events == 1") { log.status.events == 1 }
        log.setModes(RecordingModes(activity: ["com.example.chat"], exclude: [Synthetic.vault]))
        source.push(raw(.leftMouseDown, target: 505))
        source.push(raw(.leftMouseUp, target: 505))
        log.stop()
        let chunk = try XCTUnwrap(try sealedChunks().first)
        XCTAssertEqual(chunk.events.map(\.body.name), [.logStart, .up, .logStop])
        XCTAssertEqual(chunk.activity, [InputActivity(app: 0, clicks: 1)])
        XCTAssertEqual(log.status.events, 1)
    }

    func testThePageReadWithAClickDecidesItThroughTheQueues() throws {
        let source = FakeSource()
        source.names[510] = "com.google.Chrome"
        let reader = FakeReader()
        var modes = RecordingModes.defaults
        try modes.setSite(.exclude, for: "bank.example")
        let log = InputEventLog(directory: root, files: DeviceFiles(.plain), modes: modes, timeZone: zone, report: { _ in }, source: source,
                                reader: reader, clock: .held)
        addTeardownBlock { log.stop() }
        log.start()
        XCTAssertEqual(source.modes.first, modes, "the page poll reads by the same modes")
        source.push(.page(pid: 510, read: .page(.site(Site(rule: "news.example:443")!)), at: Synthetic.opened))
        reader.set(page: .page(.site(Site(rule: "bank.example:443")!)))
        source.push(raw(.leftMouseDown, target: 510))
        source.push(raw(.leftMouseUp, target: 510))
        try until("reader.reads.count == 1") { reader.reads.count == 1 }
        reader.set(page: .page(.site(Site(rule: "news.example:443")!)))
        source.push(.page(pid: 510, read: .page(.site(Site(rule: "news.example:443")!)), at: Synthetic.opened))
        source.push(raw(.leftMouseDown, target: 510))
        try until("log.status.events == 1") { log.status.events == 1 }
        log.stop()
        let chunk = try XCTUnwrap(try sealedChunks().first)
        XCTAssertEqual(chunk.events.map(\.body.name), [.logStart, .down, .logStop],
                       "the click the bank page answered, and its release, are gone")
        XCTAssertEqual(chunk.sites, ["news.example"])
        XCTAssertEqual(chunk.events[1].site, 0)
    }

    func testAPrivateWindowLeavesNothingEvenWithNoSiteRule() throws {
        let source = FakeSource()
        source.names[510] = "com.google.Chrome"
        let reader = FakeReader()
        let modes = RecordingModes()
        XCTAssertFalse(modes.hasSiteRules)
        let log = InputEventLog(directory: root, files: DeviceFiles(.plain), modes: modes, timeZone: zone, report: { _ in }, source: source,
                                reader: reader, clock: .held)
        addTeardownBlock { log.stop() }
        log.start()
        reader.set(page: .page(.privateWindow))
        source.push(.page(pid: 510, read: .page(.privateWindow), at: Synthetic.opened))
        source.push(raw(.keyDown, target: 510, code: 1, characters: "s"))
        source.push(raw(.keyUp, target: 510, code: 1))
        source.push(raw(.leftMouseDown, target: 510))
        source.push(raw(.leftMouseUp, target: 510))
        reader.set(page: .page(.site(Site(rule: "news.example:443")!)))
        source.push(.page(pid: 510, read: .page(.site(Site(rule: "news.example:443")!)), at: Synthetic.opened))
        source.push(raw(.leftMouseDown, target: 510))
        source.push(raw(.leftMouseUp, target: 510))
        try until("log.status.events == 2") { log.status.events == 2 }
        log.stop()
        let chunk = try XCTUnwrap(try sealedChunks().first)
        XCTAssertEqual(chunk.events.map(\.body.name), [.logStart, .down, .up, .logStop],
                       "the private window's key, its release or its click was written")
        XCTAssertEqual(chunk.activity, [], "the private window's input was counted")
        XCTAssertEqual(chunk.sites, ["news.example"])
    }

    func testAModifierIsJudgedBySecureInputAsItWasReceived() throws {
        let source = FakeSource()
        let log = log(source)
        log.start()
        source.push(Synthetic.raw(.flagsChanged, at: Synthetic.opened, code: 56, flags: 0x0002_0000, secureInput: true))
        source.push(.secureInput(true, at: Synthetic.opened))
        source.push(Synthetic.raw(.flagsChanged, at: Synthetic.opened, code: 56, secureInput: false))
        source.push(.secureInput(false, at: Synthetic.opened))
        source.push(raw(.leftMouseUp))
        try until("log.status.events == 2") { log.status.events == 2 }
        log.stop()
        let chunk = try XCTUnwrap(try sealedChunks().first)
        XCTAssertEqual(chunk.events.map(\.body.name), [.logStart, .secureInput, .flags, .secureInput, .up, .logStop])
        XCTAssertEqual(chunk.events[2].body, .flags(code: 56, mods: []), "the Shift typed under secure input is gone")
    }

    func testAMoveWaitingForItsDrainLandsInTheMinuteItCameIn() throws {
        let boundary = Synthetic.minute
        let clock = FakeClock(boundary.addingTimeInterval(-0.02))
        let source = FakeSource()
        source.onStart = { buffer in
            buffer.append(Synthetic.raw(.mouseMoved, at: boundary.addingTimeInterval(-0.001), x: 5, y: 6))
            clock.now = boundary.addingTimeInterval(0.001)
        }
        let log = InputEventLog(directory: root, files: DeviceFiles(.plain), modes: RecordingModes(), timeZone: zone, report: { _ in },
                                source: source, reader: FakeReader(), clock: clock.clock)
        addTeardownBlock { log.stop() }
        log.start()
        try until("log.status.chunks == 1") { log.status.chunks == 1 }
        log.stop()
        let chunks = try sealedChunks()
        XCTAssertEqual(chunks.map { $0.events.map(\.body.name) }, [[.logStart, .move], [.logStop]])
        XCTAssertEqual(chunks.first?.until, boundary)
        XCTAssertEqual(chunks.first?.events.last?.t, 19)
    }

    func testStartAndStopAreIdempotent() throws {
        let source = FakeSource()
        let log = log(source)
        log.stop()
        log.start()
        log.start()
        XCTAssertEqual(source.calls.filter { $0 == "start" }.count, 1)
        log.stop()
        log.stop()
        XCTAssertEqual(source.calls.filter { $0 == "stop" }.count, 1)
    }
}
