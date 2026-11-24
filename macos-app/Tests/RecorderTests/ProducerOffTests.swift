import Audio
import Evidence
import Foundation
import Spool
import XCTest
@testable import Recorder

@MainActor
final class ProducerOffTests: XCTestCase {
    func testAProducerOffBeforeTheRunIsNeverStarted() async throws {
        let run = OffRun()
        run.recorder.setOff([.screen, .input, .audio])
        try run.recorder.start(duration: 5.9)
        await run.recorder.waitUntilStopped()
        XCTAssertEqual(run.log.events, [], "a producer turned off was started")
        XCTAssertEqual(run.storage.count, 0, "screen off took a frame or published a gap")
    }

    func testAProducerTurnedOffWhileRecordingStopsAndTurnedOnStartsAtOnce() async throws {
        let run = OffRun()
        run.clock.due = [(1003, { run.recorder.setOff([.screen, .input, .audio]) }),
                         (1007, { run.recorder.setOff([.audio]) })]
        try run.recorder.start(duration: 9.9)
        await run.recorder.waitUntilStopped()
        XCTAssertEqual(run.log.events, [
            "input start", "audio start", "capture 1000", "capture 1002",
            "audio stop", "input stop", "input start", "capture 1008",
            "input stop",
        ])
        XCTAssertTrue(run.recorder.off == [.audio])
    }
}

@MainActor private final class Log {
    var events: [String] = []
}

@MainActor private final class OffRun {
    let log = Log()
    let clock = DueClock()
    let storage = Counted()
    lazy var recorder: Recorder = {
        var dependencies = RecorderDependencies(acquisition: Captures(log: log, clock: clock), machine: Awake(),
            input: LoggedInput(log: log), clock: clock, openStore: { [storage] in storage }, persistStatus: { _ in })
        dependencies.audio = LoggedAudio(log: log)
        dependencies.acquisitionTimeout = 30
        return Recorder(configuration: RecorderConfiguration(interval: 2), dependencies: dependencies)
    }()
}

@MainActor private final class DueClock: RecorderClock {
    private(set) var uptime: Double = 1000
    var date: Date { Date(timeIntervalSince1970: 1_700_000_000 + uptime) }
    var due: [(at: Double, change: () -> Void)] = []
    func sleep(for seconds: Double) async throws {
        try Task.checkCancellation()
        guard seconds < 15 else {
            try await Task.sleep(nanoseconds: UInt64.max / 2)
            return
        }
        let end = uptime + seconds
        while let next = due.first, next.at <= end {
            due.removeFirst()
            uptime = max(uptime, next.at)
            next.change()
        }
        uptime = end
        await Task.yield()
    }
}

@MainActor private final class Captures: RecorderAcquisition {
    let log: Log
    let clock: DueClock
    init(log: Log, clock: DueClock) {
        self.log = log
        self.clock = clock
    }
    var screenRecordingAllowed: Bool { true }
    func invalidate() {}
    func inputIdleSeconds() -> Double? { 0 }
    func setModes(_ modes: RecordingModes) {}
    func capture() async throws -> CaptureAttempt {
        log.events.append("capture \(Int(clock.uptime))")
        let observation = CaptureObservation(capturedAt: clock.date, displayID: 1, width: 4, height: 4)
        return .done([CaptureResult(observation: observation, image: .png(Data([0x89, 0x50, 0x4e, 0x47])))])
    }
}

private final class Counted: RecorderStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var appended = 0
    var count: Int { lock.withLock { appended } }
    func append(_ observation: CaptureObservation, image: CaptureImage?) async throws { lock.withLock { appended += 1 } }
    func hasBackpressure() -> Bool { false }
    func compact(flush: Bool) async throws -> VideoCompactionReport {
        VideoCompactionReport(imageCount: 0, pendingImageCount: 0, pendingBytes: 0)
    }
}

@MainActor private final class Awake: RecorderMachine {
    var availability: RecorderAvailability { RecorderAvailability(displayAwake: true, sessionActive: true) }
    var availabilityChanged: ((RecorderAvailability) -> Void)?
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
}

@MainActor private final class LoggedInput: RecorderInput {
    let log: Log
    init(log: Log) { self.log = log }
    var status: RecorderInputStatus { RecorderInputStatus(state: .recording) }
    func start() { log.events.append("input start") }
    func stop() { log.events.append("input stop") }
    func setModes(_ modes: RecordingModes) {}
}

@MainActor private final class LoggedAudio: RecorderAudio {
    let log: Log
    init(log: Log) { self.log = log }
    var status: AudioStatus { AudioStatus(mic: .stopped, sound: .stopped) }
    func start() { log.events.append("audio start") }
    func stop() { log.events.append("audio stop") }
    func setModes(_ modes: RecordingModes) {}
}
