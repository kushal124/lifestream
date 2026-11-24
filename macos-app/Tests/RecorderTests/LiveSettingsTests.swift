import Audio
import Evidence
import Foundation
import Screen
import Spool
import XCTest
@testable import Recorder

@MainActor
final class LiveSettingsTests: XCTestCase {
    func testANewIntervalStartsItsSlotsAtOnceAndOCRReachesTheNextImage() async throws {
        let run = LiveRun(interval: 10)
        run.clock.due = [(1004, { run.recorder.take(interval: 2, idlePauseAfter: nil, ocr: .always) }),
                         (1009, { run.recorder.take(interval: 2, idlePauseAfter: nil, ocr: .always) })]
        try run.recorder.start(duration: 15)
        await run.recorder.waitUntilStopped()
        XCTAssertEqual(run.log.events, ["capture 1000", "ocr always", "capture 1004", "capture 1006", "capture 1008",
                                        "ocr always", "capture 1010", "capture 1012", "capture 1014"],
                       "the new interval waited for the old one's slot, or the same one cut a sleep short")
        XCTAssertEqual(run.recorder.configuration.interval, 2)

        run.recorder.take(interval: 0.2, idlePauseAfter: nil, ocr: .exact)
        XCTAssertEqual(run.recorder.configuration.interval, 1)
        run.recorder.take(interval: 3600, idlePauseAfter: nil, ocr: .exact)
        XCTAssertEqual(run.recorder.configuration.interval, 300)
    }

    func testANewIntervalTakenDuringAnAttemptStartsItsSlotsAfterIt() async throws {
        let run = LiveRun(interval: 10)
        run.captures.during = { run.recorder.take(interval: 2, idlePauseAfter: nil, ocr: .exact) }
        try run.recorder.start(duration: 7)
        await run.recorder.waitUntilStopped()
        XCTAssertEqual(run.log.events.filter { $0.hasPrefix("capture") }, ["capture 1000", "capture 1002", "capture 1004", "capture 1006"],
                       "the attempt under way slept toward the old interval's next slot")
    }

    func testAnIdleTimeoutTakenWhileRunningHoldsFromTheNextAttempt() async throws {
        let run = LiveRun(interval: 2)
        run.captures.idle = 100
        run.clock.due = [(1005, { run.recorder.take(interval: 2, idlePauseAfter: 60, ocr: .exact) }),
                         (1011, { run.recorder.take(interval: 2, idlePauseAfter: nil, ocr: .exact) })]
        try run.recorder.start(duration: 15)
        await run.recorder.waitUntilStopped()
        XCTAssertEqual(run.log.events.filter { $0.hasPrefix("capture") },
                       ["capture 1000", "capture 1002", "capture 1004", "capture 1012", "capture 1014"],
                       "idle past the new timeout was captured, or captures did not come back once it was taken away")
    }

    func testModesSetWholeReachEveryPortAndAreSavedOnce() throws {
        let run = LiveRun(interval: 2)
        var said: [RecordingModes] = []
        run.recorder.modesSet = { said.append($0) }
        var next = RecordingModes.defaults
        try next.set(.exclude, for: "com.example.notes-fake")
        try run.recorder.setModes(next)
        try run.recorder.setModes(next)
        XCTAssertEqual(run.recorder.modes, next)
        XCTAssertEqual(run.log.events, ["modes capture", "modes input", "modes machine", "modes audio"], "a port missed the modes")
        XCTAssertEqual(run.saved, [next], "not saved, or saved again unchanged")
        XCTAssertEqual(said, [], "the modes given were said back as this Mac's change")

        try run.recorder.setMode(.activity, for: .app("com.example.chat-fake"))
        XCTAssertEqual(said.count, 1)
        XCTAssertEqual(run.saved.count, 2)
    }
}

@MainActor private final class Log {
    var events: [String] = []
}

@MainActor private final class LiveRun {
    let log = Log()
    let clock = CutClock()
    lazy var captures = Captures(log: log, clock: clock)
    var saved: [RecordingModes] = []
    let interval: Double
    init(interval: Double) { self.interval = interval }
    lazy var recorder: Recorder = {
        var dependencies = RecorderDependencies(acquisition: captures, machine: Awake(log: log),
            input: LoggedInput(log: log), clock: clock, openStore: { Counted() }, persistStatus: { _ in })
        dependencies.audio = LoggedAudio(log: log)
        dependencies.modes = .defaults
        dependencies.persistModes = { [unowned self] in saved.append($0) }
        dependencies.acquisitionTimeout = CutClock.forever
        return Recorder(configuration: RecorderConfiguration(interval: interval), dependencies: dependencies)
    }()
}

@MainActor private final class CutClock: RecorderClock {
    static let forever: Double = 15
    private(set) var uptime: Double = 1000
    var date: Date { Date(timeIntervalSince1970: 1_700_000_000 + uptime) }
    var due: [(at: Double, change: () -> Void)] = []
    func sleep(for seconds: Double) async throws {
        try Task.checkCancellation()
        guard seconds < Self.forever else {
            try await Task.sleep(nanoseconds: UInt64.max / 2)
            return
        }
        let end = uptime + seconds
        while let next = due.first, next.at <= end {
            due.removeFirst()
            uptime = max(uptime, next.at)
            next.change()
            if Task.isCancelled { throw CancellationError() }
        }
        uptime = end
        await Task.yield()
    }
}

@MainActor private final class Captures: RecorderAcquisition {
    let log: Log
    let clock: CutClock
    var idle: Double = 0
    var during: (() -> Void)?
    init(log: Log, clock: CutClock) {
        self.log = log
        self.clock = clock
    }
    var screenRecordingAllowed: Bool { true }
    func invalidate() {}
    func inputIdleSeconds() -> Double? { idle }
    func setModes(_ modes: RecordingModes) { log.events.append("modes capture") }
    func setOCR(_ mode: OCRMode) { log.events.append("ocr \(mode.rawValue)") }
    func capture() async throws -> CaptureAttempt {
        log.events.append("capture \(Int(clock.uptime))")
        during?()
        during = nil
        let observation = CaptureObservation(capturedAt: clock.date, displayID: 1, width: 4, height: 4)
        return .done([CaptureResult(observation: observation, image: .png(Data([0x89, 0x50, 0x4e, 0x47])))])
    }
}

private final class Counted: RecorderStorage, @unchecked Sendable {
    func append(_ observation: CaptureObservation, image: CaptureImage?) async throws {}
    func hasBackpressure() -> Bool { false }
    func compact(flush: Bool) async throws -> VideoCompactionReport {
        VideoCompactionReport(imageCount: 0, pendingImageCount: 0, pendingBytes: 0)
    }
}

@MainActor private final class Awake: RecorderMachine {
    let log: Log
    init(log: Log) { self.log = log }
    var availability: RecorderAvailability { RecorderAvailability(displayAwake: true, sessionActive: true) }
    var availabilityChanged: ((RecorderAvailability) -> Void)?
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) { log.events.append("modes machine") }
}

@MainActor private final class LoggedInput: RecorderInput {
    let log: Log
    init(log: Log) { self.log = log }
    var status: RecorderInputStatus { RecorderInputStatus(state: .recording) }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) { log.events.append("modes input") }
}

@MainActor private final class LoggedAudio: RecorderAudio {
    let log: Log
    init(log: Log) { self.log = log }
    var status: AudioStatus { AudioStatus(mic: .stopped, sound: .stopped) }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) { log.events.append("modes audio") }
}
