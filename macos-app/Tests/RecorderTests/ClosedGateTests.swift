import Evidence
import Foundation
import Screen
import Spool
import XCTest
@testable import Recorder

@MainActor
final class ClosedGateTests: XCTestCase {
    private static let asleep = CaptureGapReason.displayAsleepOrSessionInactive.rawValue
    private static let idle = CaptureGapReason.inputInactiveCapturePaused.rawValue
    private static let full = CaptureGapReason.storageBackpressure.rawValue

    func testAnHourAsleepIsTwoGapsAndTheFirstOpenAttemptCaptures() async throws {
        let run = Run()
        let slept = 1800.0
        run.clock.due = [(1010.5, { run.machine.set(open: false) }),
                         (4600, { run.clock.slept = slept }),
                         (4612.3, { run.machine.set(open: true) })]
        try run.recorder.start(duration: 3700)
        await run.recorder.waitUntilStopped()

        let gaps = run.storage.appended.filter { $0.status == "gap" }
        XCTAssertEqual(gaps.map(\.reason), [Self.asleep, Self.asleep], "no gap per attempt, no missed deadlines")
        assertAt(gaps[0].capturedAt, 1010.5, "the opening gap is at the gate's closing edge")
        XCTAssertNil(gaps[0].capturedUntil)
        assertAt(gaps[1].capturedAt, 1012.5, "the stretch starts one interval after the opening gap")
        assertAt(try XCTUnwrap(gaps[1].capturedUntil), 4612.3 + slept, "and ends at the opening edge, by the wall clock")

        let starts = run.acquisition.starts
        XCTAssertEqual(starts.filter { $0 < 4612 }.count, 6, "frames at 1000 to 1010, none while closed")
        let after = starts.filter { $0 > 4612 }
        XCTAssertEqual(after.first ?? 0, 4614, accuracy: 1e-6, "the first open attempt captures")
        XCTAssertEqual(after.dropFirst().first ?? 0, 4616, accuracy: 1e-6, "on the run's own cadence")

        let closed = run.file.written.filter { $0.updatedAt >= at(1012) && $0.updatedAt < at(4614 + slept) }
        XCTAssertEqual(closed.first?.state, .waiting)
        XCTAssertEqual(closed.first?.updatedAt.timeIntervalSince1970 ?? 0, at(1012).timeIntervalSince1970,
                       accuracy: 0.001, "the transition is written at once")
        XCTAssertTrue(closed.allSatisfy { $0.state == .waiting })
        XCTAssertTrue((59...62).contains(closed.count), "a heartbeat a minute, not a write per attempt: \(closed.count)")
        XCTAssertEqual(run.file.written.first { $0.updatedAt >= at(4614 + slept) }?.state, .recording)
    }

    func testAClosureOneAttemptSawStillGetsItsSpan() async throws {
        let run = Run()
        let slept = 34 * 60.0
        run.clock.due = [(1010.5, { run.machine.set(open: false) }),
                         (1013, { run.clock.slept = slept; run.machine.set(open: true) })]
        try run.recorder.start(duration: 20)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.asleep, Self.asleep])
        assertAt(gaps[0].capturedAt, 1010.5)
        XCTAssertNil(gaps[0].capturedUntil)
        assertAt(gaps[1].capturedAt, 1012.5)
        assertAt(try XCTUnwrap(gaps[1].capturedUntil), 1013 + slept)
        XCTAssertEqual(run.acquisition.starts.first { $0 > 1012 } ?? 0, 1014, accuracy: 1e-6)
    }

    func testAClosureWhollyBetweenTwoAttemptsIsOneSpanWhenLongerThanAnInterval() async throws {
        let long = Run()
        long.clock.due = [(1010.5, { long.machine.set(open: false) }),
                          (1010.6, { long.clock.slept = 1800 - 0.1; long.machine.set(open: true) })]
        try long.recorder.start(duration: 20)
        await long.recorder.waitUntilStopped()
        let gaps = long.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.asleep])
        assertAt(gaps[0].capturedAt, 1010.5)
        assertAt(try XCTUnwrap(gaps[0].capturedUntil), 1010.5 + 1800, "T2 − T1 = 30 min")
        XCTAssertEqual(long.acquisition.starts.count, 10, "every attempt captured")

        let short = Run()
        short.clock.due = [(1010.5, { short.machine.set(open: false) }),
                           (1011.5, { short.machine.set(open: true) })]
        try short.recorder.start(duration: 20)
        await short.recorder.waitUntilStopped()
        XCTAssertEqual(short.gaps.count, 0, "a second's closure states nothing")
    }

    func testTwoClosuresBetweenTwoAttemptsAreTwoSpans() async throws {
        let run = Run()
        run.clock.due = [(1010.5, { run.machine.set(open: false) }),
                         (1010.6, { run.clock.slept = 1800; run.machine.set(open: true) }),
                         (1010.7, { run.machine.set(open: false) }),
                         (1010.8, { run.clock.slept = 3600; run.machine.set(open: true) })]
        try run.recorder.start(duration: 20)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.asleep, Self.asleep])
        assertAt(gaps[0].capturedAt, 1010.5)
        assertAt(try XCTUnwrap(gaps[0].capturedUntil), 1010.6 + 1800)
        assertAt(gaps[1].capturedAt, 1010.7 + 1800)
        assertAt(try XCTUnwrap(gaps[1].capturedUntil), 1010.8 + 3600)
    }

    func testAClockSetBackStatesAClosureOnce() async throws {
        let run = Run()
        run.clock.due = [(1010.5, { run.machine.set(open: false) }),
                         (1010.6, { run.clock.slept = 1800; run.machine.set(open: true) }),
                         (1012.5, { run.clock.slept = -3600 })]
        try run.recorder.start(duration: 30)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.asleep], "stated once")
        assertAt(gaps[0].capturedAt, 1010.5)
        assertAt(try XCTUnwrap(gaps[0].capturedUntil), 1010.6 + 1800)
    }

    func testIdleIsAClosureWithItsSpan() async throws {
        let run = Run(configuration: RecorderConfiguration(interval: 2, idlePauseAfter: 60))
        run.clock.due = [(1010.5, { run.acquisition.idle = 120 }),
                         (1030.5, { run.acquisition.idle = 0 })]
        try run.recorder.start(duration: 40)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.idle, Self.idle])
        assertAt(gaps[0].capturedAt, 1012)
        XCTAssertNil(gaps[0].capturedUntil)
        XCTAssertEqual(gaps[0].inputIdleSeconds, 120)
        assertAt(gaps[1].capturedAt, 1014)
        assertAt(try XCTUnwrap(gaps[1].capturedUntil), 1032)
        XCTAssertNil(gaps[1].inputIdleSeconds)
        XCTAssertEqual(run.acquisition.starts.filter { $0 > 1011 && $0 < 1031 }.count, 0, "ten idle attempts, no frame")
        XCTAssertEqual(run.acquisition.starts.first { $0 > 1011 } ?? 0, 1032, accuracy: 1e-6)
    }

    func testAnIntervalTakenDuringAClosureLeavesItsSpanStart() async throws {
        let run = Run()
        run.clock.due = [(1010.5, { run.machine.set(open: false) }),
                         (1020, { run.recorder.take(interval: 5, idlePauseAfter: nil, ocr: .exact) }),
                         (1040.5, { run.machine.set(open: true) })]
        try run.recorder.start(duration: 60)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.asleep, Self.asleep])
        assertAt(gaps[0].capturedAt, 1010.5)
        assertAt(gaps[1].capturedAt, 1012.5, "openedAt + 2, the opening's interval")
        assertAt(try XCTUnwrap(gaps[1].capturedUntil), 1040.5)
    }

    func testADisplayClosingDuringAFullDiskEndsTheDisksSpanThere() async throws {
        let run = Run()
        run.clock.due = [(1010.5, { run.storage.full = true }),
                         (1020.5, { run.machine.set(open: false) })]
        try run.recorder.start(duration: 30)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.prefix(3).map(\.reason), [Self.full, Self.full, Self.asleep])
        assertAt(gaps[0].capturedAt, 1012)
        XCTAssertNil(gaps[0].capturedUntil)
        assertAt(gaps[1].capturedAt, 1014)
        assertAt(try XCTUnwrap(gaps[1].capturedUntil), 1020.5, "the disk's span ends at the display's edge")
        assertAt(gaps[2].capturedAt, 1020.5, "the display's opening gap is there")
        XCTAssertNil(gaps[2].capturedUntil)
    }

    func testAFullDiskForFortyAttemptsIsTwoGaps() async throws {
        let run = Run()
        run.clock.due = [(1010.5, { run.storage.full = true }),
                         (1090.5, { run.storage.full = false })]
        try run.recorder.start(duration: 100)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.full, Self.full])
        assertAt(gaps[0].capturedAt, 1012)
        XCTAssertNil(gaps[0].capturedUntil)
        assertAt(gaps[1].capturedAt, 1014)
        assertAt(try XCTUnwrap(gaps[1].capturedUntil), 1092)
        XCTAssertEqual(run.acquisition.starts.filter { $0 > 1011 && $0 < 1091 }.count, 0, "40 attempts, no capture")
        XCTAssertEqual(run.acquisition.starts.first { $0 > 1011 } ?? 0, 1092, accuracy: 1e-6)
        XCTAssertNil(run.recorder.status.lastTechnicalFailureReason, "a wait for room, no technical failure")
    }

    func testAnImageRefusedForSpaceInsideAnAppendIsAGapAtItsFrameAndTheGateOpensTheClosure() async throws {
        let run = Run()
        run.acquisition.capturing = { uptime in if abs(uptime - 1012) < 0.01 { run.storage.full = true } }
        run.clock.due = [(1030.5, { run.storage.full = false })]
        try run.recorder.start(duration: 40)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.full, Self.full, Self.full])
        guard gaps.count == 3 else { return }
        assertAt(gaps[0].capturedAt, 1012, "at the refused frame's own slot")
        XCTAssertEqual(gaps[0].displayID, 1)
        XCTAssertNil(gaps[0].capturedUntil)
        assertAt(gaps[1].capturedAt, 1014, "the gate's opening gap")
        XCTAssertNil(gaps[1].capturedUntil)
        assertAt(gaps[2].capturedAt, 1016)
        assertAt(try XCTUnwrap(gaps[2].capturedUntil), 1032)
    }

    func testAnObservedClosureEndsAtItsOwnEdgeWhenAnotherFollowsBeforeTheNextAttempt() async throws {
        let run = Run()
        run.clock.due = [(1010.5, { run.machine.set(open: false) }),
                         (1012.5, { run.clock.slept = 600; run.machine.set(open: true) }),
                         (1012.6, { run.machine.set(open: false) }),
                         (1012.7, { run.clock.slept = 1800; run.machine.set(open: true) })]
        try run.recorder.start(duration: 20)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.asleep, Self.asleep, Self.asleep])
        guard gaps.count == 3 else { return }
        assertAt(gaps[0].capturedAt, 1010.5, "the first closure's opening gap")
        assertAt(gaps[1].capturedAt, 1012.5)
        assertAt(try XCTUnwrap(gaps[1].capturedUntil), 1012.5 + 600, "to its own opening edge")
        assertAt(gaps[2].capturedAt, 1012.6 + 600, "the second closure, edge to edge")
        assertAt(try XCTUnwrap(gaps[2].capturedUntil), 1012.7 + 1800)
    }

    func testAnObservedClosureEndsAtItsOwnEdgeWhenAnotherIsStillClosed() async throws {
        let run = Run()
        run.clock.due = [(1010.5, { run.machine.set(open: false) }),
                         (1012.5, { run.clock.slept = 600; run.machine.set(open: true) }),
                         (1012.6, { run.machine.set(open: false) }),
                         (1020.5, { run.clock.slept = 1800; run.machine.set(open: true) })]
        try run.recorder.start(duration: 30)
        await run.recorder.waitUntilStopped()

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.asleep, Self.asleep, Self.asleep, Self.asleep])
        guard gaps.count == 4 else { return }
        assertAt(gaps[0].capturedAt, 1010.5)
        assertAt(gaps[1].capturedAt, 1012.5)
        assertAt(try XCTUnwrap(gaps[1].capturedUntil), 1012.5 + 600)
        assertAt(gaps[2].capturedAt, 1012.6 + 600, "the second's opening gap at its closing edge")
        XCTAssertNil(gaps[2].capturedUntil)
        assertAt(gaps[3].capturedAt, 1012.6 + 600 + 2)
        assertAt(try XCTUnwrap(gaps[3].capturedUntil), 1020.5 + 1800)
    }

    func testAFrameClosedDuringAcquisitionIsAGapAtItsSlot() async throws {
        let run = Run()
        run.acquisition.capturing = { uptime in if abs(uptime - 1012) < 0.01 { run.machine.set(open: false, told: false) } }
        try run.recorder.start(duration: 13)
        await run.recorder.waitUntilStopped()

        let closed = try XCTUnwrap(run.gaps.first)
        XCTAssertEqual(closed.reason, CaptureGapReason.sessionChangedDuringCapture.rawValue)
        assertAt(closed.capturedAt, 1012, "at the frame's slot, not after its acquisition")
    }

    func testAPauseWhileIdleStatesItsSpanToThePause() async throws {
        let run = Run(configuration: RecorderConfiguration(interval: 2, idlePauseAfter: 60))
        var pause: Task<Void, Never>?
        run.clock.due = [(1010.5, { run.acquisition.idle = 120 }),
                         (1300, { pause = Task { await run.recorder.stop() } })]
        try run.recorder.start()
        await run.recorder.waitUntilStopped()
        await pause?.value

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.idle, Self.idle])
        assertAt(gaps[1].capturedAt, 1014)
        let until = try XCTUnwrap(gaps[1].capturedUntil).timeIntervalSince1970
        XCTAssertGreaterThanOrEqual(until, at(1300).timeIntervalSince1970 - 1e-6)
        XCTAssertLessThanOrEqual(until, at(1302).timeIntervalSince1970)
    }

    func testAGrantGivenWhileTheRunWaitsStartsCaptureWithoutARestart() async throws {
        let run = Run()
        run.acquisition.allowed = false
        run.clock.due = [(1101, { run.acquisition.allowed = true })]
        try run.recorder.start(duration: 200)
        XCTAssertTrue(run.recorder.running, "the run starts without the grant")
        await run.recorder.waitUntilStopped()

        XCTAssertEqual(run.acquisition.starts.first ?? 0, 1102, accuracy: 1e-6, "the first attempt after the grant captures")
        XCTAssertEqual(run.storage.appended.count, 49, "frames from 1102 to the timer, nothing before")
        XCTAssertTrue(run.storage.appended.allSatisfy { $0.status != "gap" })
        let waiting = try XCTUnwrap(run.file.written.first { $0.state == .permissionRequired })
        XCTAssertEqual(waiting.message, Recorder.screenRecordingMessage)
        XCTAssertEqual(run.file.written.first { $0.updatedAt >= at(1102) }?.state, .recording)
    }

    func testAPauseWhileClosedStatesTheStretchUpToThePause() async throws {
        let run = Run()
        var pause: Task<Void, Never>?
        run.clock.due = [(1010.5, { run.machine.set(open: false) }),
                         (1300, { pause = Task { await run.recorder.stop() } })]
        try run.recorder.start()
        await run.recorder.waitUntilStopped()
        await pause?.value

        let gaps = run.gaps
        XCTAssertEqual(gaps.map(\.reason), [Self.asleep, Self.asleep])
        assertAt(gaps[1].capturedAt, 1012.5)
        let until = try XCTUnwrap(gaps[1].capturedUntil).timeIntervalSince1970
        XCTAssertGreaterThanOrEqual(until, at(1300).timeIntervalSince1970 - 1e-6)
        XCTAssertLessThanOrEqual(until, at(1302).timeIntervalSince1970)
        XCTAssertEqual(run.file.written.last?.state, .stopped)
    }

    func testAnAwakeRunWritesRuntimeJSONOnTransitionsAndAHeartbeat() async throws {
        let run = Run()
        run.clock.due = [(1101, { run.input.state = .permissionRequired })]
        var lagging = 0
        run.recorder.changed = { [weak recorder = run.recorder] in
            guard let recorder else { return }
            if recorder.status.recorded != run.storage.appended.count { lagging += 1 }
        }
        try run.recorder.start(duration: 300)
        await run.recorder.waitUntilStopped()

        XCTAssertEqual(run.storage.appended.count, 150)
        XCTAssertEqual(lagging, 0, "the status the control socket reads is exact")
        let written = run.file.written
        XCTAssertLessThan(written.count, 10, "not a write per attempt: \(written.count)")
        for (earlier, later) in zip(written, written.dropFirst()) where earlier.transition == later.transition
            && later.state != .stopped {
            XCTAssertGreaterThanOrEqual(later.updatedAt.timeIntervalSince(earlier.updatedAt),
                                        Recorder.statusHeartbeat - 1e-6, "counters wait for the heartbeat")
        }
        let change = try XCTUnwrap(written.first { $0.inputLog == .permissionRequired })
        XCTAssertLessThan(change.updatedAt, at(1104), "a transition is written by the next attempt")
        let last = try XCTUnwrap(written.last)
        XCTAssertEqual(last.state, .stopped)
        XCTAssertEqual(last.recorded, 150, "the stop leaves the run's final count")
        XCTAssertEqual(last.recorded, run.recorder.status.recorded)
    }
}

private func at(_ uptime: Double) -> Date {
    Date(timeIntervalSince1970: 1_700_000_000 + uptime - 1000)
}

private func assertAt(_ date: Date, _ uptime: Double, _ message: String = "",
                      file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(date.timeIntervalSince1970, at(uptime).timeIntervalSince1970, accuracy: 1e-3, message,
                   file: file, line: line)
}


@MainActor private final class Run {
    let clock = SteppingClock()
    let machine = Display()
    let input = SwitchableInput()
    let storage = Appended()
    let file = StatusFile()
    let configuration: RecorderConfiguration
    lazy var acquisition = Frames(clock: clock)
    lazy var recorder: Recorder = {
        var dependencies = RecorderDependencies(acquisition: acquisition, machine: machine, input: input,
            clock: clock, openStore: { [storage] in storage }, persistStatus: { [file] in file.write($0) })
        dependencies.acquisitionTimeout = 30
        return Recorder(configuration: configuration, dependencies: dependencies)
    }()
    var gaps: [CaptureObservation] { storage.appended.filter { $0.status == "gap" } }

    init(configuration: RecorderConfiguration = RecorderConfiguration(interval: 2)) {
        self.configuration = configuration
    }
}

@MainActor private final class SteppingClock: RecorderClock {
    private(set) var uptime: Double = 1000
    var slept: Double = 0
    var date: Date { at(uptime + slept) }
    var due: [(at: Double, change: () -> Void)] = []
    func advance(_ seconds: Double) { uptime += seconds }
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
            await Task.yield()
            try Task.checkCancellation()
        }
        uptime = end
        await Task.yield()
    }
}

@MainActor private final class Display: RecorderMachine {
    private var open = true
    var availability: RecorderAvailability { RecorderAvailability(displayAwake: open, sessionActive: true) }
    var availabilityChanged: ((RecorderAvailability) -> Void)?
    func set(open: Bool, told: Bool = true) {
        self.open = open
        if told { availabilityChanged?(availability) }
    }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
}

@MainActor private final class Frames: RecorderAcquisition {
    private let clock: SteppingClock
    private(set) var starts: [Double] = []
    var allowed = true
    var idle: Double = 0
    var capturing: ((Double) -> Void)?
    init(clock: SteppingClock) { self.clock = clock }
    var screenRecordingAllowed: Bool { allowed }
    func invalidate() {}
    func inputIdleSeconds() -> Double? { idle }
    func setModes(_ modes: RecordingModes) {}
    func capture() async throws -> CaptureAttempt {
        starts.append(clock.uptime)
        capturing?(clock.uptime)
        let observation = CaptureObservation(capturedAt: clock.date, displayID: 1, width: 4, height: 4)
        clock.advance(0.2)
        return .done([CaptureResult(observation: observation, image: .png(Data([0x89, 0x50, 0x4e, 0x47])))])
    }
}

private final class Appended: RecorderStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var observations: [CaptureObservation] = []
    private var isFull = false
    var appended: [CaptureObservation] { lock.withLock { observations } }
    var full: Bool {
        get { lock.withLock { isFull } }
        set { lock.withLock { isFull = newValue } }
    }
    func append(_ observation: CaptureObservation, image: CaptureImage?) async throws {
        try lock.withLock {
            if image != nil, isFull { throw CaptureStoreError.archiveBacklogFull }
            observations.append(observation)
        }
    }
    func hasBackpressure() -> Bool { full }
    func compact(flush: Bool) async throws -> VideoCompactionReport {
        VideoCompactionReport(imageCount: 0, pendingImageCount: 0, pendingBytes: 0)
    }
}

private final class StatusFile: @unchecked Sendable {
    private let lock = NSLock()
    private var statuses: [RuntimeStatus] = []
    var written: [RuntimeStatus] { lock.withLock { statuses } }
    func write(_ status: RuntimeStatus) { lock.withLock { statuses.append(status) } }
}

@MainActor private final class SwitchableInput: RecorderInput {
    var state = InputLogState.recording
    var status: RecorderInputStatus { RecorderInputStatus(state: state) }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
}
