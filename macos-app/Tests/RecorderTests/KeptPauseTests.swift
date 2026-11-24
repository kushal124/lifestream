import Evidence
import Foundation
import Spool
import XCTest
@testable import Recorder

@MainActor
final class KeptPauseTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUp() {
        suite = "kept-pause-test-" + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    private var relaunched: KeptPause { KeptPause(UserDefaults(suiteName: suite)!) }

    func testAFreshMacIsNotPaused() {
        XCTAssertFalse(KeptPause(defaults).paused)
        XCTAssertFalse(ControlResponder(recorder: Self.recorder(), kept: KeptPause(defaults)).paused)
    }

    func testTheControlPauseIsKeptForTheNextLaunch() async {
        let recorder = Self.recorder()
        let control = ControlResponder(recorder: recorder, kept: KeptPause(defaults))
        let started = await control.respond(to: ControlRequest(action: "start"))
        XCTAssertTrue(started.ok)
        XCTAssertTrue(recorder.running)
        let paused = await control.respond(to: ControlRequest(action: "pause"))
        XCTAssertTrue(paused.ok)
        XCTAssertFalse(recorder.running)
        XCTAssertTrue(control.paused)
        XCTAssertTrue(relaunched.paused, "the pause was not kept for the next launch")
    }

    func testThePersonsPauseIsKeptAndTheirStartClearsIt() async throws {
        let recorder = Self.recorder()
        let control = ControlResponder(recorder: recorder, kept: KeptPause(defaults))
        try control.start()
        XCTAssertFalse(relaunched.paused)
        await control.pause()
        XCTAssertFalse(recorder.running)
        XCTAssertTrue(relaunched.paused)
        try control.start()
        XCTAssertTrue(recorder.running)
        XCTAssertFalse(relaunched.paused, "starting again left the pause kept")
        await recorder.stop()
    }

    func testTheControlStartClearsAKeptPause() async {
        await ControlResponder(recorder: Self.recorder(), kept: KeptPause(defaults)).pause()
        let recorder = Self.recorder()
        let control = ControlResponder(recorder: recorder, kept: relaunched)
        XCTAssertTrue(control.paused)
        let started = await control.respond(to: ControlRequest(action: "start"))
        XCTAssertTrue(started.ok)
        XCTAssertFalse(relaunched.paused)
        await recorder.stop()
    }

    func testATimedStartKeepsThePersonsPause() async {
        await ControlResponder(recorder: Self.recorder(), kept: KeptPause(defaults)).pause()
        let recorder = Self.recorder()
        let control = ControlResponder(recorder: recorder, kept: relaunched)
        let started = await control.respond(to: ControlRequest(action: "start", durationSeconds: 30))
        XCTAssertTrue(started.ok)
        XCTAssertTrue(recorder.running)
        XCTAssertTrue(relaunched.paused, "a timed start cleared the person's pause, so the next launch records")
        await recorder.stop()
        XCTAssertTrue(relaunched.paused)
    }

    func testTheAppsOwnShutdownIsNoPause() async throws {
        let recorder = Self.recorder()
        let control = ControlResponder(recorder: recorder, kept: KeptPause(defaults))
        try control.start()
        let shutdown = await control.respond(to: ControlRequest(action: "shutdown"))
        XCTAssertEqual(shutdown.state, "shutting_down")
        XCTAssertFalse(recorder.running)
        XCTAssertFalse(relaunched.paused, "the app's own shutdown was kept as a pause")

        let pausedFirst = ControlResponder(recorder: Self.recorder(), kept: KeptPause(defaults))
        await pausedFirst.pause()
        _ = await pausedFirst.respond(to: ControlRequest(action: "shutdown"))
        XCTAssertTrue(relaunched.paused, "a shutdown cleared the person's pause")
    }

    private static func recorder() -> Recorder {
        Recorder(configuration: RecorderConfiguration(interval: 2),
                 dependencies: RecorderDependencies(acquisition: Screen(), machine: Awake(), input: Keys(), clock: Still(),
                                                    openStore: { Kept() }, persistStatus: { _ in }))
    }
}

@MainActor private final class Still: RecorderClock {
    let uptime: Double = 1000
    var date: Date { Date(timeIntervalSince1970: 1_700_000_000) }
    func sleep(for seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64.max / 2)
    }
}

@MainActor private final class Screen: RecorderAcquisition {
    var screenRecordingAllowed: Bool { true }
    func invalidate() {}
    func inputIdleSeconds() -> Double? { 0 }
    func setModes(_ modes: RecordingModes) {}
    func capture() async throws -> CaptureAttempt {
        .done([CaptureResult(observation: CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_000), displayID: 1,
                                                             width: 4, height: 4),
                             image: .png(Data([0x89, 0x50, 0x4e, 0x47])))])
    }
}

private final class Kept: RecorderStorage, @unchecked Sendable {
    func append(_ observation: CaptureObservation, image: CaptureImage?) async throws {}
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

@MainActor private final class Keys: RecorderInput {
    var status: RecorderInputStatus { RecorderInputStatus(state: .recording) }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
}
