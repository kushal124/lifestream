import Evidence
import Foundation
import Spool
import XCTest
@testable import Recorder

@MainActor
final class PendingFrameTests: XCTestCase {
    func testFramesPublishInCaptureOrderWhenTheirTextArrivesOutOfOrder() async throws {
        let run = PendingRun()
        run.acquisition.script = [.after(2), .now, .now]
        run.acquisition.captureSeconds = [0.2, 2.5, 0.2]
        var saved: [Date?] = []
        run.recorder.changed = {
            if run.recorder.status.recorded == 1, saved.isEmpty { saved.append(run.recorder.status.lastSaved) }
        }
        try run.recorder.start(duration: 7.9)
        await run.recorder.waitUntilStopped()

        let published = run.storage.appended
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(saved.first ?? nil), at(1006))
        XCTAssertEqual(published.first?.capturedAt, at(1000))
        XCTAssertEqual(published.map(\.status), ["captured", "captured", "gap", "captured"])
        XCTAssertEqual(published.map { $0.capturedAt.timeIntervalSince1970 - 1_700_000_000 },
                       [0, 2, 4, 6], "capture order, the missed slot in its place")
        XCTAssertEqual(published[2].reason, "capture-deadline-missed; count=1")
        XCTAssertEqual(run.acquisition.starts, [1000, 1002, 1006], "every attempt began on its slot or the next")
        XCTAssertEqual(run.recorder.status.recorded, 3)
        XCTAssertNil(run.recorder.status.pendingFrames)
    }

    func testAFrameWaitingForItsTextWhenTheDisplaySleepsIsNeverPublished() async throws {
        let run = PendingRun()
        run.acquisition.script = [.closedUnnoticed, .now, .now]
        run.clock.due = [(1001, { run.machine.set(open: false) }), (1005, { run.machine.set(open: true) })]
        try run.recorder.start(duration: 7.9)
        await run.recorder.waitUntilStopped()

        let published = run.storage.appended
        XCTAssertFalse(published.contains { $0.status == "captured" && $0.capturedAt == at(1000) },
                       "a frame captured before the close and waiting through it is dropped")
        XCTAssertEqual(published.map(\.reason), [
            CaptureGapReason.sessionChangedDuringCapture.rawValue,
            CaptureGapReason.displayAsleepOrSessionInactive.rawValue,
            CaptureGapReason.displayAsleepOrSessionInactive.rawValue,
            "foreground-pid-matched-around-image-acquisition"])
        XCTAssertEqual(published.last?.capturedAt, at(1006))
    }

    func testTheGapInAClosedFramesPlaceIsAtTheFramesOwnSlot() async throws {
        let run = PendingRun()
        run.acquisition.script = [.closedUnnoticedLate]
        run.clock.due = [(1001, { run.machine.set(open: false) })]
        try run.recorder.start(duration: 7.9)
        await run.recorder.waitUntilStopped()

        let published = run.storage.appended
        XCTAssertEqual(published.first?.reason, CaptureGapReason.sessionChangedDuringCapture.rawValue)
        XCTAssertEqual(published.first?.capturedAt, at(1000), "at the frame's own slot, not 40 s on")
        XCTAssertFalse(published.contains { $0.status == "captured" })
    }

    func testAFrameRefusedForSpaceInsideTheDisksClosureIsAGapAtItsSlot() async throws {
        let run = PendingRun()
        run.acquisition.script = [.closedUnnoticed]
        run.clock.due = [(1001, { run.storage.full = true }), (1009, { run.storage.full = false })]
        try run.recorder.start(duration: 11.9)
        await run.recorder.waitUntilStopped()

        let gaps = run.storage.appended.filter { $0.status == "gap" }
        XCTAssertEqual(gaps.map(\.reason), Array(repeating: CaptureGapReason.storageBackpressure.rawValue, count: 3))
        guard gaps.count == 3 else { return }
        XCTAssertEqual(gaps.map(\.capturedAt), [at(1000), at(1002), at(1004)], "the frame's own slot, the opening gap, the span")
        XCTAssertEqual(gaps[0].displayID, 1)
        XCTAssertEqual(gaps[2].capturedUntil, at(1010))
    }

    func testAStopWithFramesWaitingDropsThemAndAnswersWithoutTheirText() async throws {
        let run = PendingRun()
        run.acquisition.script = Array(repeating: .dropped, count: 1000)
        try start(run)
        try await until("run.acquisition.starts.count >= 2") { run.acquisition.starts.count >= 2 }
        XCTAssertNotNil(run.recorder.status.pendingFrames, "the frames are waiting, and status says so")
        let stopped = Happened()
        Task { @MainActor in
            await run.recorder.stop()
            stopped.note()
        }
        try await until("stopped.value") { stopped.value }
        XCTAssertEqual(run.storage.appended.filter { $0.status == "captured" }.count, 0,
                       "a stopped run publishes none of its waiting frames")
        XCTAssertNil(run.recorder.status.pendingFrames)
        XCTAssertNil(run.file.written.last?.pendingFrames)
    }

    func testTheNextAttemptIsHeldBeforeItStartsWhileSixWaitForTheirText() async throws {
        XCTAssertEqual(Recorder.waitingLimit, 6)
        let run = PendingRun()
        run.acquisition.script = Array(repeating: .held, count: 7) + [.now]
        try start(run)
        try await until("run.recorder.held == 1") { run.recorder.held == 1 }
        XCTAssertEqual(run.acquisition.starts.count, 6, "the seventh is held before it starts")
        XCTAssertEqual(run.recorder.status.pendingFrames, 6)
        XCTAssertEqual(run.storage.appended.filter { $0.status == "gap" }.count, 0, "no frame closed, no gap yet")
        run.acquisition.release()
        try await until("run.storage.appended.filter { $0.status == \"captured\" }.count >= 7") { run.storage.appended.filter { $0.status == "captured" }.count >= 7 }
        XCTAssertGreaterThanOrEqual(run.acquisition.starts.count, 7, "let go once one is published")
        let published = run.storage.appended
        XCTAssertEqual(published.prefix(7).map(\.status), Array(repeating: "captured", count: 7), "every waiting frame published")
        XCTAssertFalse(published.contains { $0.reason == CaptureGapReason.captureGenerationInvalidated.rawValue })
    }

    private func start(_ run: PendingRun) throws {
        try run.recorder.start()
        addTeardownBlock { @MainActor [self] in
            run.acquisition.release()
            let stopped = Happened()
            Task { @MainActor in
                await run.recorder.stop()
                stopped.note()
            }
            try? await until("stopped.value") { stopped.value }
        }
    }

    func testARunThatEndsOnItsTimerPublishesTheFramesStillBeingRecognized() async throws {
        let run = PendingRun()
        run.acquisition.script = [.later]
        var seen: [Int?] = []
        run.acquisition.finishing = { seen.append(run.recorder.status.pendingFrames) }
        try run.recorder.start(duration: 1.9)
        await run.recorder.waitUntilStopped()

        XCTAssertEqual(run.storage.appended.map(\.status), ["captured"])
        XCTAssertEqual(seen, [1], "status states the frame waiting for its text")
        XCTAssertEqual(run.recorder.status.recorded, 1)
        XCTAssertNil(run.recorder.status.pendingFrames)
    }
}


private func at(_ uptime: Double) -> Date {
    Date(timeIntervalSince1970: 1_700_000_000 + uptime - 1000)
}

@MainActor private final class PendingRun {
    let clock = DueClock()
    let machine = Display()
    let storage = Appended()
    let file = StatusFile()
    lazy var acquisition = WaitingFrames(clock: clock)
    lazy var recorder: Recorder = {
        var dependencies = RecorderDependencies(acquisition: acquisition, machine: machine, input: Quiet(),
            clock: clock, openStore: { [storage] in storage }, persistStatus: { [file] in file.write($0) })
        dependencies.acquisitionTimeout = 30
        return Recorder(configuration: RecorderConfiguration(interval: 2), dependencies: dependencies)
    }()
}

@MainActor private final class DueClock: RecorderClock {
    private(set) var uptime: Double = 1000
    var date: Date { at(uptime) }
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
        uptime = max(uptime, end)
        for _ in 0..<5 { await Task.yield() }
    }
}

@MainActor private final class WaitingFrames: RecorderAcquisition {
    enum Text {
        case now
        case after(Int)
        case later
        case dropped
        case closedUnnoticed
        case closedUnnoticedLate
        case held
    }

    private let clock: DueClock
    var script: [Text] = []
    var captureSeconds: [Double] = []
    var finishing: (() -> Void)?
    private(set) var starts: [Double] = []
    private var closes = 0
    private var arrived: Set<Int> = []
    private var waiting: [() -> Void] = []
    private var released = false

    func release() {
        released = true
        wake()
    }

    init(clock: DueClock) { self.clock = clock }
    var screenRecordingAllowed: Bool { true }
    func inputIdleSeconds() -> Double? { 0 }
    func setModes(_ modes: RecordingModes) {}

    func invalidate() {
        closes += 1
        wake()
    }

    func capture() async throws -> CaptureAttempt {
        let index = starts.count
        starts.append(clock.uptime)
        var observation = CaptureObservation(capturedAt: clock.date, displayID: 1, width: 4, height: 4)
        observation.reason = "foreground-pid-matched-around-image-acquisition"
        clock.advance(index < captureSeconds.count ? captureSeconds[index] : 0.2)
        let text = index < script.count ? script[index] : .now
        let closesAtCapture = closes
        switch text {
        case .now:
            arrive(index)
        case .after(let other):
            Task { await parked { self.arrived.contains(other) }; arrive(index) }
        case .later:
            Task { for _ in 0..<20 { await Task.yield() }; arrive(index) }
        case .held:
            Task { await parked { self.released }; arrive(index) }
        case .dropped, .closedUnnoticed, .closedUnnoticedLate:
            break
        }
        let frame = CaptureResult(observation: observation, image: .png(Data([0x89, 0x50, 0x4e, 0x47])))
        return .recognizing(timings: nil) { [self] in
            finishing?()
            await parked { self.arrived.contains(index) || self.closes > closesAtCapture }
            if closes > closesAtCapture, case .closedUnnoticed = text { return [frame] }
            if closes > closesAtCapture, case .closedUnnoticedLate = text {
                clock.advance(40)
                return [frame]
            }
            guard closes == closesAtCapture else {
                return [CaptureResult(observation: CaptureObservation(capturedAt: clock.date, displayID: 0, width: 0,
                    height: 0, status: "gap", reason: CaptureGapReason.captureGenerationInvalidated.rawValue), image: nil)]
            }
            return [frame]
        }
    }

    private func arrive(_ index: Int) {
        arrived.insert(index)
        wake()
    }

    private func wake() {
        let woken = waiting
        waiting = []
        woken.forEach { $0() }
    }

    private func parked(until condition: @escaping () -> Bool) async {
        while !condition() {
            await withCheckedContinuation { continuation in waiting.append { continuation.resume() } }
        }
    }
}

@MainActor private final class Display: RecorderMachine {
    private var open = true
    var availability: RecorderAvailability { RecorderAvailability(displayAwake: open, sessionActive: true) }
    var availabilityChanged: ((RecorderAvailability) -> Void)?
    func set(open: Bool) {
        self.open = open
        availabilityChanged?(availability)
    }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
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

@MainActor private final class Quiet: RecorderInput {
    var status: RecorderInputStatus { RecorderInputStatus(state: .off) }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
}
