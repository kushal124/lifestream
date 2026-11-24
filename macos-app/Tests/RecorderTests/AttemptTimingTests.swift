import Evidence
import Foundation
import Spool
import XCTest
@testable import Recorder

@MainActor
final class AttemptTimingTests: XCTestCase {
    func testAMissedDeadlineStatesWhereTheOverrunningAttemptSpentItsTime() async throws {
        let clock = FakeClock()
        let storage = RecordingStorage(clock: clock)
        let acquisition = FakeAcquisition(clock: clock, durations: [3.5, 0.2])
        let recorder = Recorder(configuration: RecorderConfiguration(interval: 2),
            dependencies: RecorderDependencies(acquisition: acquisition, machine: AwakeMachine(), input: QuietInput(),
                clock: clock, openStore: { storage }, persistStatus: { _ in }))
        try recorder.start(duration: 5.9)
        await recorder.waitUntilStopped()

        let observations = storage.appended
        XCTAssertEqual(observations.map(\.status), ["captured", "gap", "captured"])
        let gap = observations[1]
        XCTAssertEqual(gap.reason, "capture-deadline-missed; count=1")
        let timings = try XCTUnwrap(gap.timings, "the missed gap states the attempt that overran")
        XCTAssertEqual(timings.captureMs, 3500)
        XCTAssertEqual(timings.publishMs, 10, "one append of the overrunning attempt")
        XCTAssertEqual(timings.statusMs, 0, "runtime.json is written off the attempt's path")
        XCTAssertEqual(timings.attemptMs, 3510)
        XCTAssertEqual(timings.wakeLateMs, 0)
        XCTAssertEqual(timings.prepareMs, 11)
        XCTAssertEqual(timings.screenshotMs, 22)
        XCTAssertEqual(timings.pageCheckMs, 33)
        XCTAssertEqual(timings.ocrMs, 3000)
        XCTAssertEqual(timings.ocrTiles, 4)
        XCTAssertEqual(timings.enrichMs, 3100)
        XCTAssertNil(observations[2].timings?.captureMs, "a frame states only its own screen steps")
        XCTAssertEqual(observations[2].timings?.ocrMs, 3000)
        XCTAssertNil(observations.last { $0.status == "gap" && $0 != gap }, "a kept deadline publishes no gap")
    }

    func testAMissedDeadlineNeverStandsAsTheReason() async throws {
        let clock = FakeClock()
        let storage = RecordingStorage(clock: clock)
        let acquisition = FakeAcquisition(clock: clock, durations: [3.5])
        let recorder = Recorder(configuration: RecorderConfiguration(interval: 2),
            dependencies: RecorderDependencies(acquisition: acquisition, machine: AwakeMachine(), input: QuietInput(),
                clock: clock, openStore: { storage }, persistStatus: { _ in }))
        try recorder.start(duration: 3.9)
        await recorder.waitUntilStopped()
        XCTAssertEqual(storage.appended.map(\.status), ["captured", "gap"])
        XCTAssertEqual(storage.appended.last?.reason, "capture-deadline-missed; count=1")
        XCTAssertNil(recorder.status.lastGapReason)
    }

    func testAFrameNoEncoderTakesBecomesAGapStatingWhy() async throws {
        let clock = FakeClock()
        let storage = RecordingStorage(clock: clock, refusing: .videoEncoderUnavailable)
        let acquisition = FakeAcquisition(clock: clock, durations: [0.2, 0.2])
        let recorder = Recorder(configuration: RecorderConfiguration(interval: 2),
            dependencies: RecorderDependencies(acquisition: acquisition, machine: AwakeMachine(), input: QuietInput(),
                clock: clock, openStore: { storage }, persistStatus: { _ in }))
        try recorder.start(duration: 3.9)
        await recorder.waitUntilStopped()

        let observations = storage.appended
        XCTAssertEqual(observations.map(\.status), ["gap", "gap"])
        XCTAssertEqual(observations.map(\.reason), ["video-encoder-unavailable", "video-encoder-unavailable"])
        XCTAssertEqual(observations.map(\.displayID), [1, 1])
        XCTAssertEqual(observations.map(\.ocr), [[], []], "the frame's text is not kept")
        XCTAssertEqual(recorder.status.lastGapReason, "video-encoder-unavailable")
    }
}


@MainActor private final class FakeClock: RecorderClock {
    private(set) var uptime: Double = 1000
    private var wall = Date(timeIntervalSince1970: 1_700_000_000)
    var date: Date { wall.addingTimeInterval(uptime - 1000) }
    func advance(_ seconds: Double) { uptime += seconds }
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

@MainActor private final class FakeAcquisition: RecorderAcquisition {
    let clock: FakeClock
    var durations: [Double]
    init(clock: FakeClock, durations: [Double]) {
        self.clock = clock
        self.durations = durations
    }
    var screenRecordingAllowed: Bool { true }
    func invalidate() {}
    func inputIdleSeconds() -> Double? { 0 }
    func setModes(_ modes: RecordingModes) {}
    func capture() async throws -> CaptureAttempt {
        let seconds = durations.isEmpty ? 0.2 : durations.removeFirst()
        clock.advance(seconds)
        var observation = CaptureObservation(capturedAt: clock.date, displayID: 1, width: 4, height: 4)
        observation.timings = CaptureTimings(prepareMs: 11, screenshotMs: 22, pageCheckMs: 33, ocrMs: 3000,
                                             ocrTiles: 4, enrichMs: 3100)
        return .done([CaptureResult(observation: observation, image: .png(Data([0x89, 0x50, 0x4e, 0x47])))])
    }
}

private final class RecordingStorage: RecorderStorage, @unchecked Sendable {
    private let clock: FakeClock
    private let refusing: CaptureStoreError?
    init(clock: FakeClock, refusing: CaptureStoreError? = nil) {
        self.clock = clock
        self.refusing = refusing
    }
    private let lock = NSLock()
    private var observations: [CaptureObservation] = []
    var appended: [CaptureObservation] { lock.withLock { observations } }
    func append(_ observation: CaptureObservation, image: CaptureImage?) async throws {
        if image != nil, let refusing {
            throw refusing
        }
        lock.withLock { observations.append(observation) }
        let clock = self.clock
        await MainActor.run { clock.advance(0.010) }
    }
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
