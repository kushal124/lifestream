import Audio
import DeviceFiles
import Evidence
import Foundation
import Spool
import XCTest
@testable import Recorder

@MainActor
final class LifecycleTests: XCTestCase {
    private static let full = CaptureGapReason.storageBackpressure.rawValue
    private static let failed = CaptureGapReason.storageFailed.rawValue

    func testAStopWhileStorageOpensStartsNothingAndAnswersOnceTheStoreIsFlushed() async throws {
        let world = World()
        world.opening.close()
        try world.recorder.start()
        XCTAssertEqual(world.recorder.status.state, .starting)
        try await until("starting is written") { world.file.written.contains { $0.state == .starting } }
        let stopped = Happened()
        Task { @MainActor in
            await world.recorder.stop()
            stopped.note()
        }
        try await until("the stop is taken") { world.recorder.stopping }
        XCTAssertEqual(world.recorder.status.state, .stopped, "a stop reads stopped from the moment it is taken")
        XCTAssertThrowsError(try world.recorder.start()) { XCTAssertEqual($0 as? RecorderError, .stillPausing) }
        XCTAssertFalse(stopped.value, "the stop answers only after the store it is still opening")
        world.opening.open()
        try await until("stopped.value") { stopped.value }
        XCTAssertEqual(world.log.events, ["flush"], "no producer started, no activity held; the store was flushed")
        XCTAssertFalse(world.recorder.running)
        XCTAssertEqual(world.file.written.last?.state, .stopped)
    }

    func testScreenRecordingRevokedMidRunWaitsForItAndCapturesOnceGivenBack() async throws {
        let world = World()
        world.clock.due = [(1003, { world.acquisition.allowed = false }), (1007, { world.acquisition.allowed = true })]
        var seen: [RecorderState] = []
        world.recorder.changed = { if seen.last != world.recorder.status.state { seen.append(world.recorder.status.state) } }
        try world.recorder.start(duration: 9.9)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(seen, [.starting, .recording, .permissionRequired, .recording, .stopped])
        XCTAssertEqual(world.acquisition.captures, [1000, 1002, 1008])
        XCTAssertEqual(world.log.events, ["activity begin", "machine start", "input start", "audio start", "flush",
                                          "audio stop", "input stop", "machine stop", "activity end"],
                       "the producers record through the lost grant and stop after the flush")
        XCTAssertTrue(world.file.written.contains { $0.state == .permissionRequired && $0.message == Recorder.screenRecordingMessage })
    }

    func testALostGrantStandsUntilAFrameIsSavedAndCaptureBeginsAtTheStart() async throws {
        let world = World()
        world.clock.due = [(1003, { world.acquisition.allowed = false }), (1007, { world.acquisition.allowed = true })]
        var reasons: [String?] = []
        world.recorder.changed = {
            let reason = world.recorder.status.lastGapReason
            if reasons.last != reason { reasons.append(reason) }
        }
        try world.recorder.start(duration: 9.9)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(reasons, [nil, "screen-recording-permission-denied", nil], "the frame at 1008 ends it")
        XCTAssertEqual(world.recorder.status.capturingSince, world.clock.date(at: 1000))
        XCTAssertEqual(world.recorder.status.lastSaved, world.clock.date(at: 1008))
    }

    func testScreenTurnedOnAgainBeginsCaptureAnew() async throws {
        let world = World()
        world.clock.due = [(1003, { world.recorder.setOff([.screen]) }), (1007.5, { world.recorder.setOff([]) })]
        var since: [Date?] = []
        world.recorder.changed = {
            let began = world.recorder.status.capturingSince
            if since.last != began { since.append(began) }
        }
        try world.recorder.start(duration: 9.9)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(since, [nil, world.clock.date(at: 1000), world.clock.date(at: 1007.5)])
    }


    func testAFullDiskLosesTheTenureAndTheRunReopensTheStoreAndStatesTheStretch() async throws {
        let world = World()
        world.spool.refuse = { $0.number == 3 ? CaptureStoreError.io("write", ENOSPC) : nil }
        try world.recorder.start(duration: 30)
        await world.recorder.waitUntilStopped()

        let lost = try XCTUnwrap(world.file.written.first { $0.state == .recovering })
        XCTAssertEqual(lost.storageFailure, StorageFailure(kind: "io", errno: ENOSPC, at: world.clock.date(at: 1004)))
        XCTAssertEqual(lost.lastGapReason, Self.full, "the cause stands: the menu says the disk is full at once")
        XCTAssertEqual(lost.owed, [RuntimeStatus.OwedSpan(reason: Self.full, from: world.clock.date(at: 1004))], "owed while unwritten")
        XCTAssertEqual(lost.capturingSince, world.clock.date(at: 1000), "an opening begins no capture")
        XCTAssertEqual(lost.lastSaved, world.clock.date(at: 1002))
        XCTAssertEqual(world.openings, [1000, 1019], "the store opens again 15 s after the loss")
        XCTAssertEqual(world.writerMet, 0, "every user of the old store had finished before the new opening")
        XCTAssertEqual(world.log.events, ["activity begin", "machine start", "input start", "audio start", "flush",
                                          "audio stop", "input stop", "machine stop", "activity end"],
                       "the producers start once, record through the lost tenure and stop at the run's end; one activity")
        XCTAssertEqual(world.acquisition.captures, [1000, 1002, 1004, 1019, 1021, 1023, 1025, 1027, 1029],
                       "the cadence resumes from the reopening")
        let appended = world.spool.appended
        XCTAssertEqual(appended.count, 9)
        let span = appended[2]
        XCTAssertEqual(span.reason, Self.full, "the new tenure's first publication")
        XCTAssertEqual(span.capturedAt, world.clock.date(at: 1004))
        XCTAssertEqual(span.capturedUntil, world.clock.date(at: 1019))
        XCTAssertTrue(appended[3...].allSatisfy { $0.status != "gap" }, "frames from the reopening on")
        let reopened = try XCTUnwrap(world.file.written.last { $0.state == .recovering })
        XCTAssertNil(reopened.storageFailure, "the lost stretch is written: the cause is cleared")
        XCTAssertNil(reopened.owed)
        XCTAssertEqual(world.recorder.status.state, .stopped)
        XCTAssertNil(world.recorder.status.storageFailure)
    }

    func testTheNextStretchStartsOneIntervalAfterTheLastSpan() async throws {
        let world = World()
        world.spool.refuse = { [3, 5].contains($0.number) ? CaptureStoreError.io("write", ENOSPC) : nil }
        try world.recorder.start(duration: 52)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.openings, [1000, 1019, 1049], "no frame saved between: the wait doubled")
        let spans = world.spool.appended.filter { $0.capturedUntil != nil }
        XCTAssertEqual(spans.map(\.reason), [Self.full, Self.full])
        XCTAssertEqual(spans.map(\.capturedAt), [world.clock.date(at: 1004), world.clock.date(at: 1021)])
        XCTAssertEqual(spans.map(\.capturedUntil), [world.clock.date(at: 1019), world.clock.date(at: 1049)])
    }

    func testAStoreFailingEveryFrameDoublesItsWaitAndAFrameSavedResetsIt() async throws {
        let world = World()
        let lines = world.failureLines()
        world.spool.refuse = { append in
            guard let frame = append.frame, frame <= 8 || frame == 10 else { return nil }
            return CaptureStoreError.io("write", EIO)
        }
        try world.recorder.start(duration: 2390)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.openings, [1000, 1015, 1045, 1105, 1225, 1465, 1765, 2065, 2365, 2382])
        XCTAssertEqual(world.spool.appended.filter { $0.reason == Self.failed }.count, 9, "every stretch stated once")
        lines.drain()
        let tenure = try world.lines().filter { ($0["event"] as? String)?.hasPrefix("tenure_") == true }
        XCTAssertEqual(tenure.map { $0["event"] as? String }, ["tenure_lost", "tenure_opened", "tenure_lost", "tenure_opened"],
                       "eight rounds of a failing frame are one streak")
        XCTAssertEqual(tenure[0]["kind"] as? String, "io")
        XCTAssertEqual(tenure[0]["errno"] as? Int, Int(EIO))
        XCTAssertEqual(tenure[1]["at"] as? String, UTCInstant.rfc3339(world.clock.date(at: 2365)), "at the first frame saved")
        XCTAssertEqual(tenure[1]["since"] as? String, UTCInstant.rfc3339(world.clock.date(at: 1000)))
        XCTAssertEqual(tenure[1]["kind"] as? String, "io")
        XCTAssertEqual(tenure[1]["errno"] as? Int, Int(EIO))
        let all = try world.lines().map { $0["event"] as? String }
        XCTAssertEqual(all.first, "run_started")
        XCTAssertEqual(all.last, "run_ended")
    }

    func testFailedOpeningsRetryOnTheDoublingWaitShowingRecoveringAndStartNothing() async throws {
        let world = World()
        world.opens = { $0 <= 7 ? CaptureStoreError.io("open", EIO) : nil }
        var seen: [RecorderState] = []
        world.recorder.changed = { if seen.last != world.recorder.status.state { seen.append(world.recorder.status.state) } }
        try world.recorder.start(duration: 2070)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.openings, [1000, 1015, 1045, 1105, 1225, 1465, 1765, 2065])
        XCTAssertEqual(seen, [.starting, .recovering, .recording, .stopped])
        XCTAssertEqual(world.log.events.first, "activity begin")
        XCTAssertEqual(world.producersStartedAt, [2065], "the producers start once, after the opening is stated")
        let retrying = world.file.written.filter { $0.state == .recovering }
        XCTAssertFalse(retrying.isEmpty)
        XCTAssertTrue(retrying.allSatisfy { $0.storageFailure == StorageFailure(kind: "io", errno: EIO, at: world.clock.date(at: 1000)) },
                      "the first failure is the cause")
        XCTAssertTrue(retrying.allSatisfy { $0.capturingSince == world.clock.date(at: 1000) }, "timed from the start")
        let beats = world.file.written.map(\.updatedAt).filter { $0 < world.clock.date(at: 2065) }
        for (earlier, later) in zip(beats, beats.dropFirst()) {
            XCTAssertLessThanOrEqual(later.timeIntervalSince(earlier), Recorder.statusHeartbeat, "the heartbeat through a long wait")
        }
        XCTAssertEqual(beats.filter { $0 > world.clock.date(at: 1765) }.count, 4, "300 s written every 60 s")
        XCTAssertNil(world.file.written.last?.storageFailure, "cleared once a tenure opens")
        XCTAssertEqual(world.recorder.status.capturingSince, world.clock.date(at: 1000))
    }

    func testFiftyFailedOpeningsAreOneLineAndOneClosingLine() async throws {
        let world = World()
        let lines = world.failureLines()
        world.opens = { $0 <= 50 ? CaptureStoreError.io("open", EIO) : nil }
        try world.recorder.start()
        try await until("a frame is saved") { world.recorder.status.recorded > 0 }
        await world.recorder.stop()
        XCTAssertEqual(world.openings.count, 51)
        lines.drain()
        let failures = try world.lines().filter { $0["event"] as? String != "run_started" && $0["event"] as? String != "run_ended" }
        XCTAssertEqual(failures.map { $0["event"] as? String }, ["opening_failed", "tenure_opened"])
        XCTAssertEqual(failures[1]["since"] as? String, UTCInstant.rfc3339(world.clock.date(at: 1000)))
        XCTAssertEqual(failures[1]["kind"] as? String, "io")
        XCTAssertEqual(failures[1]["errno"] as? Int, Int(EIO))
    }

    func testAStreakWhoseFirstLineWasLostIsStatedByItsClosingLine() async throws {
        let world = World()
        let lines = world.failureLines()
        let blocker = world.spoolFolder.appendingPathComponent("resources")
        try Data("not a folder".utf8).write(to: blocker)
        world.opens = { $0 <= 2 ? CaptureStoreError.io("open", ENOSPC) : nil }
        world.clock.due = [(1020, {
            lines.drain()
            try? FileManager.default.removeItem(at: blocker)
        })]
        try world.recorder.start(duration: 50)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.openings, [1000, 1015, 1045])
        lines.drain()
        let written = try world.lines()
        XCTAssertEqual(written.map { $0["event"] as? String }, ["tenure_opened", "run_ended"])
        XCTAssertEqual(written[0]["since"] as? String, UTCInstant.rfc3339(world.clock.date(at: 1000)))
        XCTAssertEqual(written[0]["errno"] as? Int, Int(ENOSPC))
    }

    func testAReopeningThatMeetsTheWriterRetries() async throws {
        let world = World()
        world.spool.refuse = { $0.number == 3 ? CaptureStoreError.io("write", EIO) : nil }
        world.opens = { $0 == 2 ? CaptureStoreError.writerAlreadyRunning : nil }
        try world.recorder.start(duration: 52)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.openings, [1000, 1019, 1049])
        let span = try XCTUnwrap(world.spool.appended.first { $0.capturedUntil != nil })
        XCTAssertEqual(span.reason, Self.failed, "not the disk's: storage-failed")
        XCTAssertEqual(span.capturedAt, world.clock.date(at: 1004))
        XCTAssertEqual(span.capturedUntil, world.clock.date(at: 1049))
    }

    func testAPublicationThatFailsWhileAFrameWaitsLosesTheTenureAndPublishesNothingAfterIt() async throws {
        let world = World()
        world.acquisition.firstWaits = true
        world.spool.refuse = { $0.number == 1 ? Refused() : nil }
        var states: [RecorderState] = []
        world.recorder.changed = { if states.last != world.recorder.status.state { states.append(world.recorder.status.state) } }
        try world.recorder.start(duration: 30)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.acquisition.captures, [1000, 1002, 1017, 1019, 1021, 1023, 1025, 1027, 1029],
                       "the run recovers and records to its timer")
        XCTAssertEqual(states, [.starting, .recording, .recovering, .recording, .stopped], "never an error, never a pause")
        let appended = world.spool.appended
        XCTAssertEqual(appended.first?.reason, Self.failed, "the frame behind the failed one never reached the spool")
        XCTAssertEqual(appended.first?.capturedAt, world.clock.date(at: 1000), "no observation appended: from the run's start")
        XCTAssertEqual(appended.first?.capturedUntil, world.clock.date(at: 1017))
        XCTAssertEqual(world.spool.tried, 1 + appended.count, "nothing of the lost tenure tried after the failed one")
        XCTAssertFalse(appended.contains { $0.status != "gap" && $0.capturedAt < world.clock.date(at: 1017) })
    }

    func testAFailureWithSixFramesWaitingLosesTheTenureAndStrandsNothing() async throws {
        let world = World()
        world.acquisition.everyWaits = true
        world.spool.refuse = { $0.number == 1 ? Refused() : nil }
        world.flushing.close()
        try world.recorder.start(duration: 300)
        try await until("an attempt is held for room") { world.recorder.held == 1 }
        XCTAssertEqual(world.recorder.status.pendingFrames, 6)
        world.acquisition.releaseFirst()
        try await until("the new tenure's span") { world.spool.tried == 2 }
        XCTAssertEqual(world.openings.count, 2)
        XCTAssertEqual(world.spool.tried, 2, "the failed frame, then the new tenure's span: no frame of the lost tenure")
        XCTAssertEqual(world.spool.appended.map(\.reason), [Self.failed])
        XCTAssertTrue(world.recorder.running, "the run goes on")
        let stopped = Happened()
        Task { @MainActor in
            await world.recorder.stop()
            stopped.note()
        }
        try await until("the cleanup reaches the flush") { world.flushing.waiting }
        XCTAssertNil(world.recorder.status.pendingFrames, "every frame stopped waiting")
        XCTAssertEqual(world.recorder.held, 0, "no attempt held")
        world.flushing.open()
        try await until("the run is released") { stopped.value }
        XCTAssertEqual(world.log.events.suffix(2), ["machine stop", "activity end"], "the cleanup ran to the seal")
    }

    func testACancelledOneShotAnswersWithoutItsTextAndPublishesNothing() async throws {
        let world = World()
        world.acquisition.everyWaits = true
        let answered = Happened()
        let shot = Task { @MainActor in
            defer { answered.note() }
            try await world.recorder.captureOnce()
        }
        try await until("its frame waits for its text") { world.recorder.status.pendingFrames == 1 }
        shot.cancel()
        try await until("the cancelled one-shot answers") { answered.value }
        let result = await shot.result
        XCTAssertThrowsError(try result.get())
        XCTAssertEqual(world.spool.tried, 0)
        XCTAssertFalse(world.recorder.running)
        XCTAssertEqual(world.recorder.status.state, .stopped)
    }

    func testAOneShotWhoseStoreIsLostThrowsAndRestsStopped() async throws {
        let world = World()
        world.spool.refuse = { _ in CaptureStoreError.io("write", EIO) }
        do {
            try await world.recorder.captureOnce()
            XCTFail("the one-shot threw nothing")
        } catch {
            XCTAssertEqual(StorageFailure.kind(of: error).kind, "io")
        }
        XCTAssertEqual(world.recorder.status.state, .stopped)
        XCTAssertFalse(world.recorder.running)
        XCTAssertEqual(world.openings, [1000])
        XCTAssertEqual(world.recorder.status.storageFailure?.errno, EIO)
        XCTAssertEqual(world.file.written.last?.state, .stopped)
        XCTAssertFalse(world.log.events.contains("flush"), "no flush onto the store that failed")
    }

    func testAFailureWhileTheRunSleepsTowardItsNextSlotRecoversAtOnce() async throws {
        let world = World()
        world.acquisition.everyWaits = true
        world.spool.refuse = { $0.number == 1 ? Refused() : nil }
        world.recorder.take(interval: 20, idlePauseAfter: nil, ocr: .always)
        try world.recorder.start(duration: 300)
        try await until("the first frame waits for its text") { world.recorder.status.pendingFrames == 1 }
        world.acquisition.releaseFirst()
        try await until("the new tenure's first attempt") { world.acquisition.captures.count == 2 }
        XCTAssertEqual(world.openings, [1000, 1015], "15 s after the loss, not after the next slot")
        await world.recorder.stop()
        XCTAssertEqual(world.acquisition.captures, [1000, 1015])
    }

    func testAFailureWhileATimerEndedRunPublishesItsWaitingFramesKeepsItsCause() async throws {
        let world = World()
        world.acquisition.everyWaits = true
        world.spool.refuse = { $0.number == 1 ? Refused() : nil }
        try world.recorder.start(duration: 1.9)
        try await until("the run ended with a frame waiting") {
            world.recorder.stopping && world.recorder.status.pendingFrames == 1
        }
        XCTAssertEqual(world.recorder.status.state, .stopped)
        world.acquisition.releaseFirst()
        try await until("the run is released") { !world.recorder.running }
        XCTAssertEqual(world.spool.tried, 1)
        XCTAssertEqual(world.recorder.status.state, .stopped, "the run ended on its timer, as it was ending")
        XCTAssertEqual(world.recorder.status.storageFailure?.kind, "Refused", "the cause is kept")
        XCTAssertEqual(world.file.written.last?.state, .stopped)
        XCTAssertEqual(world.openings, [1000], "a run closing does not reopen for a stretch it does not owe")
        XCTAssertFalse(world.log.events.contains("flush"), "no flush onto the store that failed")
    }


    func testATimedRunWhoseStoreNeverOpensEndsAtItsDeadline() async throws {
        let world = World()
        world.opens = { _ in CaptureStoreError.io("open", EIO) }
        try world.recorder.start(duration: 100)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.openings, [1000, 1015, 1045], "the third wait is clipped to the timer")
        XCTAssertEqual(world.clock.uptime, 1100)
        XCTAssertFalse(world.recorder.running)
        XCTAssertEqual(world.recorder.status.state, .stopped)
        XCTAssertEqual(world.recorder.status.storageFailure?.errno, EIO, "a stop does not clear the cause")
        XCTAssertEqual(world.log.events, [], "nothing started, no activity held, nothing to flush")
    }

    func testAPauseDuringTheRecoveryNapEndsTheRunAndStatesTheStretchToTheStop() async throws {
        let world = World()
        world.clock.long = { false }
        world.spool.refuse = { $0.number == 2 ? Refused() : nil }
        try world.recorder.start()
        try await until("the tenure is lost and its store dropped") {
            world.recorder.status.state == .recovering && world.spool.live == 0
        }
        world.clock.advance(20)
        await world.recorder.stop()
        XCTAssertEqual(world.openings, [1000, 1022], "the cleanup's one try")
        let span = try XCTUnwrap(world.spool.appended.last)
        XCTAssertEqual(span.reason, Self.failed)
        XCTAssertEqual(span.capturedAt, world.clock.date(at: 1002))
        XCTAssertEqual(span.capturedUntil, world.clock.date(at: 1022), "to the stop")
        XCTAssertNil(world.recorder.status.owed)
        XCTAssertNil(world.recorder.status.storageFailure, "the stretch is written")
        XCTAssertEqual(world.log.events.suffix(5), ["flush", "audio stop", "input stop", "machine stop", "activity end"])
        XCTAssertEqual(world.log.events.filter { $0 == "activity begin" }.count, 1, "held across the lost tenure")
    }

    func testAStopDuringAReopeningEndsTheRun() async throws {
        let world = World()
        world.spool.refuse = { $0.number == 2 ? Refused() : nil }
        world.clock.due = [(1010, { world.opening.close() })]
        try world.recorder.start()
        try await until("the reopening waits") { world.opening.waiting }
        let stopped = Happened()
        Task { @MainActor in
            await world.recorder.stop()
            stopped.note()
        }
        try await until("the stop is taken") { world.recorder.stopping }
        world.clock.advance(30)
        world.opening.open()
        try await until("the run is released") { stopped.value }
        XCTAssertEqual(world.openings, [1000, 1017])
        XCTAssertEqual(world.acquisition.captures, [1000, 1002], "no attempt after the stop")
        let span = try XCTUnwrap(world.spool.appended.last)
        XCTAssertEqual(span.capturedAt, world.clock.date(at: 1002))
        XCTAssertEqual(span.capturedUntil, world.clock.date(at: 1017), "the store that opened takes the stretch to the stop")
        XCTAssertEqual(world.log.events.suffix(5), ["flush", "audio stop", "input stop", "machine stop", "activity end"])
    }

    func testAStopThatCannotWriteTheStretchKeepsItForTheNextOpening() async throws {
        let world = World()
        world.clock.long = { false }
        world.spool.refuse = { $0.number == 2 ? Refused() : nil }
        world.opens = { $0 >= 2 ? CaptureStoreError.io("open", EIO) : nil }
        try world.recorder.start()
        try await until("the tenure is lost and its store dropped") {
            world.recorder.status.state == .recovering && world.spool.live == 0
        }
        world.clock.advance(20)
        await world.recorder.stop()
        let held = RuntimeStatus.OwedSpan(reason: Self.failed, from: world.clock.date(at: 1002), until: world.clock.date(at: 1022))
        XCTAssertEqual(world.recorder.status.owed?.map(\.unnamed), [held])
        XCTAssertNotNil(world.recorder.status.owed?.first?.bundle, "named for the bundle that will hold it")
        XCTAssertNotNil(world.recorder.status.storageFailure)
        XCTAssertEqual(world.file.written.last?.owed, world.recorder.status.owed, "the file keeps it for the next process too")
        XCTAssertEqual(world.file.written.last?.state, .stopped)

        world.opens = { _ in nil }
        world.clock.long = { world.spool.live == 0 }
        let before = world.spool.appended.count
        try world.recorder.start(duration: 4)
        await world.recorder.waitUntilStopped()
        let next = Array(world.spool.appended[before...])
        XCTAssertEqual(next.first?.reason, Self.failed, "written before anything else")
        XCTAssertEqual(next.first?.capturedAt, held.from)
        XCTAssertEqual(next.first?.capturedUntil, held.until)
        XCTAssertTrue(next.dropFirst().allSatisfy { $0.status != "gap" })
        XCTAssertNil(world.recorder.status.owed)
        XCTAssertNil(world.recorder.status.storageFailure)
        XCTAssertNil(world.recorder.status.lastGapReason, "a past run's stretch does not stand")
    }


    private static let notRunning = CaptureGapReason.recorderNotRunning.rawValue

    func testAProcessThatEndedRecordingStatesItsStretchFromItsNewestFrame() async throws {
        let world = World()
        let lines = world.failureLines()
        var previous = RuntimeStatus(state: .recording)
        previous.updatedAt = world.clock.date(at: 900)
        world.previous = previous
        world.newest = NewestObservation(capturedAt: world.clock.date(at: 920), end: world.clock.date(at: 920))
        try world.recorder.start(duration: 4)
        await world.recorder.waitUntilStopped()
        let appended = world.spool.appended
        XCTAssertEqual(appended.first?.reason, Self.notRunning, "the first publication")
        XCTAssertEqual(appended.first?.capturedAt, world.clock.date(at: 922))
        XCTAssertEqual(appended.first?.capturedUntil, world.clock.date(at: 1000), "to the opening")
        XCTAssertNotEqual(appended.first?.capturedAt, world.newest?.capturedAt)
        XCTAssertEqual(appended.dropFirst().map(\.status), [ObservationStatus.captured.rawValue, ObservationStatus.captured.rawValue])
        XCTAssertFalse(world.file.written.contains { $0.lastGapReason == Self.notRunning }, "the reason never stands")
        lines.drain()
        let unclean = try world.lines().filter { $0["event"] as? String == "unclean_end" }
        XCTAssertEqual(unclean.count, 1)
        XCTAssertEqual(unclean.first?["since"] as? String, UTCInstant.rfc3339(world.clock.date(at: 922)))
    }

    func testARecordingHeartbeatAfterTheNewestFrameStartsTheStretch() async throws {
        let world = World()
        var previous = RuntimeStatus(state: .permissionRequired)
        previous.updatedAt = world.clock.date(at: 950)
        world.previous = previous
        world.newest = NewestObservation(capturedAt: world.clock.date(at: 900), end: world.clock.date(at: 900))
        try world.recorder.start(duration: 2)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.spool.appended.first?.reason, Self.notRunning)
        XCTAssertEqual(world.spool.appended.first?.capturedAt, world.clock.date(at: 950))
    }

    func testAClosureOpenAtAnUncleanEndStartsTheStretchAtItsOpeningGapNotTheHeartbeat() async throws {
        let world = World()
        let opened = world.clock.date(at: 1000 - 4 * 3600)
        var previous = RuntimeStatus(state: .recording)
        previous.owed = [RuntimeStatus.OwedSpan(reason: CaptureGapReason.displayAsleepOrSessionInactive.rawValue,
                                                from: opened.addingTimeInterval(2))]
        previous.updatedAt = opened.addingTimeInterval(3 * 3600)
        world.previous = previous
        world.newest = NewestObservation(capturedAt: opened, end: opened)
        try world.recorder.start(duration: 2)
        await world.recorder.waitUntilStopped()
        let gap = try XCTUnwrap(world.spool.appended.first)
        XCTAssertEqual(gap.reason, Self.notRunning)
        XCTAssertEqual(gap.capturedAt, opened.addingTimeInterval(2))
        XCTAssertEqual(gap.capturedUntil, world.clock.date(at: 1000))
    }

    func testALostTenureAtAnUncleanEndStartsTheStretchAfterTheNewestSpansEnd() async throws {
        let world = World()
        var previous = RuntimeStatus(state: .recovering)
        previous.capturingSince = world.clock.date(at: 100)
        previous.storageFailure = StorageFailure(kind: "io", errno: EIO, at: world.clock.date(at: 400))
        previous.updatedAt = world.clock.date(at: 990)
        world.previous = previous
        world.newest = NewestObservation(capturedAt: world.clock.date(at: 300), end: world.clock.date(at: 500))
        try world.recorder.start(duration: 2)
        await world.recorder.waitUntilStopped()
        let gap = try XCTUnwrap(world.spool.appended.first)
        XCTAssertEqual(gap.reason, Self.notRunning)
        XCTAssertEqual(gap.capturedAt, world.clock.date(at: 502))
        XCTAssertEqual(gap.capturedUntil, world.clock.date(at: 1000))
    }

    func testASpanTheLastProcessHeldIsWrittenAndNoUncleanEnd() async throws {
        let world = World()
        var previous = RuntimeStatus(state: .stopped)
        let held = RuntimeStatus.OwedSpan.ended(reason: Self.failed, from: world.clock.date(at: 600), until: world.clock.date(at: 700))
        previous.owed = [held]
        previous.storageFailure = StorageFailure(kind: "io", errno: EIO, at: world.clock.date(at: 598))
        world.previous = previous
        world.newest = NewestObservation(capturedAt: world.clock.date(at: 598), end: world.clock.date(at: 598))
        try world.recorder.start(duration: 2)
        await world.recorder.waitUntilStopped()
        let gaps = world.spool.appended.filter { $0.status == "gap" }
        XCTAssertEqual(gaps.map(\.reason), [Self.failed])
        XCTAssertEqual(gaps.first?.capturedAt, held.from)
        XCTAssertEqual(gaps.first?.capturedUntil, held.until)
        XCTAssertNil(world.recorder.status.owed)
    }

    func testACleanEndAShortStretchAndASecondRunStateNone() async throws {
        let clean = World()
        clean.previous = RuntimeStatus(state: .stopped)
        clean.newest = NewestObservation(capturedAt: clean.clock.date(at: 100), end: clean.clock.date(at: 100))
        try clean.recorder.start(duration: 2)
        await clean.recorder.waitUntilStopped()
        XCTAssertFalse(clean.spool.appended.contains { $0.status == "gap" }, "a stop is no unclean end")

        let short = World()
        var recording = RuntimeStatus(state: .recording)
        recording.updatedAt = short.clock.date(at: 997)
        short.previous = recording
        short.newest = NewestObservation(capturedAt: short.clock.date(at: 998), end: short.clock.date(at: 998))
        try short.recorder.start(duration: 2)
        await short.recorder.waitUntilStopped()
        XCTAssertFalse(short.spool.appended.contains { $0.status == "gap" }, "two seconds is one interval: none")

        let twice = World()
        recording.updatedAt = twice.clock.date(at: 500)
        twice.previous = recording
        twice.newest = NewestObservation(capturedAt: twice.clock.date(at: 500), end: twice.clock.date(at: 500))
        try twice.recorder.start(duration: 2)
        await twice.recorder.waitUntilStopped()
        twice.clock.advance(100)
        try twice.recorder.start(duration: 2)
        await twice.recorder.waitUntilStopped()
        XCTAssertEqual(twice.spool.appended.filter { $0.reason == Self.notRunning }.count, 1, "the process's first run only")
    }

    func testARunThatNeverOpenedEndsTheUncleanStretchAtItsStop() async throws {
        let world = World()
        world.clock.long = { false }
        var previous = RuntimeStatus(state: .recording)
        previous.updatedAt = world.clock.date(at: 800)
        world.previous = previous
        world.newest = NewestObservation(capturedAt: world.clock.date(at: 800), end: world.clock.date(at: 800))
        world.opens = { _ in CaptureStoreError.io("open", EIO) }
        try world.recorder.start()
        try await until("the first opening failed") { world.recorder.status.state == .recovering }
        world.clock.advance(10)
        await world.recorder.stop()
        world.clock.advance(30)
        world.opens = { _ in nil }
        world.clock.long = { world.spool.live == 0 }
        try world.recorder.start(duration: 2)
        await world.recorder.waitUntilStopped()
        let gaps = world.spool.appended.filter { $0.status == "gap" }
        XCTAssertEqual(gaps.map(\.reason), [Self.notRunning, Self.failed])
        XCTAssertEqual(gaps.map(\.capturedAt), [world.clock.date(at: 802), world.clock.date(at: 1000)])
        XCTAssertEqual(gaps.map(\.capturedUntil), [world.clock.date(at: 1000), world.clock.date(at: 1010)],
                       "to the stop: the pause after it was the person's")
    }

    func testAnUncleanEndThatFailsToPublishIsWrittenByTheNextOpeningBeforeTheLostStretch() async throws {
        let world = World()
        var previous = RuntimeStatus(state: .recording)
        previous.updatedAt = world.clock.date(at: 900)
        world.previous = previous
        world.newest = NewestObservation(capturedAt: world.clock.date(at: 900), end: world.clock.date(at: 900))
        world.opens = { $0 == 1 ? CaptureStoreError.io("open", EIO) : nil }
        world.spool.refuse = { $0.number == 1 ? CaptureStoreError.io("write", EIO) : nil }
        try world.recorder.start(duration: 48)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.openings, [1000, 1015, 1045])
        let spans = world.spool.appended.filter { $0.capturedUntil != nil }
        XCTAssertEqual(spans.map(\.reason), [Self.notRunning, Self.failed])
        XCTAssertEqual(spans.map(\.capturedAt), [world.clock.date(at: 902), world.clock.date(at: 1000)],
                       "the failed first opening is the run's lost stretch; it begins where the unclean end's gap ends")
        XCTAssertEqual(spans.map(\.capturedUntil), [world.clock.date(at: 1000), world.clock.date(at: 1045)])
    }

    func testAnUncleanEndADeadProcessNeverWroteIsWrittenByTheNext() async throws {
        let first = World()
        var previous = RuntimeStatus(state: .recording)
        previous.updatedAt = first.clock.date(at: 900)
        first.previous = previous
        first.newest = NewestObservation(capturedAt: first.clock.date(at: 920), end: first.clock.date(at: 920))
        first.spool.refuse = { _ in CaptureStoreError.io("write", EIO) }
        try first.recorder.start(duration: 4)
        await first.recorder.waitUntilStopped()
        let left = try XCTUnwrap(first.file.written.first { $0.state == .recording })

        let next = World()
        next.previous = left
        next.newest = first.newest
        next.clock.advance(100)
        try next.recorder.start(duration: 2)
        await next.recorder.waitUntilStopped()
        let gaps = next.spool.appended.filter { $0.status == "gap" }
        XCTAssertEqual(gaps.map(\.reason), [Self.notRunning])
        XCTAssertEqual(gaps.first?.capturedAt, next.clock.date(at: 922), "from the newest frame, not the dead process's opening")
        XCTAssertEqual(gaps.first?.capturedUntil, next.clock.date(at: 1100))
    }

    func testAnUncleanEndAStoppedProcessCouldNotWriteIsWrittenByTheNext() async throws {
        let first = World()
        first.clock.long = { false }
        var previous = RuntimeStatus(state: .recording)
        previous.updatedAt = first.clock.date(at: 900)
        first.previous = previous
        first.newest = NewestObservation(capturedAt: first.clock.date(at: 920), end: first.clock.date(at: 920))
        first.opens = { _ in CaptureStoreError.io("open", EIO) }
        try first.recorder.start()
        try await until("the first opening failed") { first.recorder.status.state == .recovering }
        first.clock.advance(10)
        await first.recorder.stop()
        let left = try XCTUnwrap(first.file.written.last)
        XCTAssertEqual(left.state, .stopped)

        let next = World()
        next.previous = left
        next.newest = first.newest
        next.clock.advance(100)
        try next.recorder.start(duration: 2)
        await next.recorder.waitUntilStopped()
        let gaps = next.spool.appended.filter { $0.status == "gap" }
        XCTAssertEqual(gaps.map(\.reason), [Self.notRunning, Self.failed])
        XCTAssertEqual(gaps.map(\.capturedAt), [next.clock.date(at: 922), next.clock.date(at: 1000)])
        XCTAssertEqual(gaps.map(\.capturedUntil), [next.clock.date(at: 1000), next.clock.date(at: 1010)],
                       "the first process's stretch to where this one began, its failed openings to its stop")
    }

    func testTwoDeathsBeforeAnyObservationKeepTheFirstAbsence() async throws {
        let second = World()
        second.clock.long = { false }
        var first = RuntimeStatus(state: .starting)
        first.capturingSince = second.clock.date(at: 900)
        first.updatedAt = second.clock.date(at: 900)
        second.previous = first
        second.opens = { _ in CaptureStoreError.io("open", EIO) }
        try second.recorder.start()
        try await until("its failed opening is written") { second.file.written.contains { $0.state == .recovering } }
        let left = try XCTUnwrap(second.file.written.last { $0.state == .recovering })
        await second.recorder.stop()

        let third = World()
        third.previous = left
        third.clock.advance(100)
        try third.recorder.start(duration: 2)
        await third.recorder.waitUntilStopped()
        let gaps = third.spool.appended.filter { $0.status == "gap" }
        XCTAssertEqual(gaps.first?.capturedAt, third.clock.date(at: 900), "from where the first process began capture")
        XCTAssertEqual(gaps.last?.capturedUntil, third.clock.date(at: 1100))
        for (earlier, later) in zip(gaps, gaps.dropFirst()) {
            XCTAssertEqual(earlier.capturedUntil, later.capturedAt, "one after another, never overlapping")
        }
    }

    func testAnUncleanEndNeverCoversThePauseBeforeCaptureBegan() async throws {
        for state in [RecorderState.starting, .recovering] {
            let world = World()
            var previous = RuntimeStatus(state: state)
            previous.capturingSince = world.clock.date(at: 950)
            previous.updatedAt = world.clock.date(at: 960)
            if state == .recovering { previous.storageFailure = StorageFailure(kind: "io", errno: EIO, at: world.clock.date(at: 955)) }
            world.previous = previous
            world.newest = NewestObservation(capturedAt: world.clock.date(at: 600), end: world.clock.date(at: 600))
            try world.recorder.start(duration: 2)
            await world.recorder.waitUntilStopped()
            let gap = try XCTUnwrap(world.spool.appended.first)
            XCTAssertEqual(gap.reason, Self.notRunning)
            XCTAssertEqual(gap.capturedAt, world.clock.date(at: 950), "\(state): from where capture began")
        }
    }

    func testTwoHeldSpansAreBothWritten() async throws {
        let world = World()
        world.clock.long = { false }
        world.spool.refuse = { $0.number == 2 || $0.number == 3 ? Refused() : nil }
        world.opens = { [2, 4].contains($0) ? CaptureStoreError.io("open", EIO) : nil }
        try world.recorder.start()
        try await until("the first tenure is lost") { world.recorder.status.state == .recovering && world.spool.live == 0 }
        world.clock.advance(20)
        await world.recorder.stop()

        try world.recorder.start()
        try await until("the held span's append fails and the tenure is lost") {
            world.spool.tried == 3 && world.recorder.status.state == .recovering && world.spool.live == 0
        }
        world.clock.advance(10)
        await world.recorder.stop()

        world.opens = { _ in nil }
        world.clock.long = { world.spool.live == 0 }
        try world.recorder.start(duration: 2)
        await world.recorder.waitUntilStopped()
        let spans = world.spool.appended.filter { $0.capturedUntil != nil }
        XCTAssertEqual(spans.map(\.reason), [Self.failed, Self.failed])
        XCTAssertEqual(spans.map(\.capturedAt), [world.clock.date(at: 1002), world.clock.date(at: 1022)])
        XCTAssertEqual(spans.map(\.capturedUntil), [world.clock.date(at: 1022), world.clock.date(at: 1032)])
    }

    func testACleanupsSpanStaysOwedUntilItLands() async throws {
        let first = World()
        first.clock.long = { false }
        first.spool.refuse = { $0.number == 2 ? Refused() : nil }
        try first.recorder.start()
        try await until("the tenure is lost and its store dropped") {
            first.recorder.status.state == .recovering && first.spool.live == 0
        }
        first.clock.advance(20)
        first.appending.close()
        let stopped = Happened()
        Task { @MainActor in
            await first.recorder.stop()
            stopped.note()
        }
        try await until("the cleanup's span waits to land") { first.appending.waiting }
        let left = first.recorder.status
        first.appending.open()
        try await until("the stop answered") { stopped.value }

        let next = World()
        next.previous = left
        next.newest = NewestObservation(capturedAt: next.clock.date(at: 1000), end: next.clock.date(at: 1000))
        next.clock.advance(100)
        try next.recorder.start(duration: 2)
        await next.recorder.waitUntilStopped()
        let span = try XCTUnwrap(next.spool.appended.first)
        XCTAssertEqual(span.reason, Self.failed)
        XCTAssertEqual(span.capturedAt, next.clock.date(at: 1002))
        XCTAssertEqual(span.capturedUntil, next.clock.date(at: 1022), "to the stop")
    }

    func testAFirstOpeningRefusedForSpaceShowsTheDiskAndStatesItsStretch() async throws {
        let world = World()
        world.opens = { $0 == 1 ? CaptureStoreError.io("open", ENOSPC) : nil }
        try world.recorder.start(duration: 20)
        await world.recorder.waitUntilStopped()
        let retrying = try XCTUnwrap(world.file.written.first { $0.state == .recovering })
        XCTAssertEqual(retrying.lastGapReason, Self.full, "the disk's words at once")
        XCTAssertEqual(world.openings, [1000, 1015])
        let span = try XCTUnwrap(world.spool.appended.first)
        XCTAssertEqual(span.reason, Self.full)
        XCTAssertEqual(span.capturedAt, world.clock.date(at: 1000))
        XCTAssertEqual(span.capturedUntil, world.clock.date(at: 1015))
    }

    func testALostTenureWaitsForACompactionPassUnderWay() async throws {
        let world = World()
        world.clock.long = { true }
        world.compacting.close()
        try world.recorder.start()
        try await until("a compaction pass is under way") { world.compacting.waiting }
        world.spool.refuse = { _ in Refused() }
        try await until("the tenure is lost") { world.recorder.status.state == .recovering }
        world.spool.refuse = { _ in nil }
        world.compacting.open()
        try await until("the store opens again") { world.openings.count == 2 }
        await world.recorder.stop()
        XCTAssertEqual(world.writerMet, 0, "the new opening came after the pass returned the old store")
    }

    func testAnAppendPublishedButNotFlushedStartsTheLostStretchAfterIt() async throws {
        let world = World()
        world.spool.published = { $0.number == 3 ? CaptureStoreError.publishedNotFlushed(end: world.clock.date(at: 1004),
                                                                                           cause: CaptureStoreError.io("flush", EIO)) : nil }
        try world.recorder.start(duration: 30)
        await world.recorder.waitUntilStopped()
        let span = try XCTUnwrap(world.spool.appended.first { $0.capturedUntil != nil })
        XCTAssertEqual(world.spool.appended.prefix(3).map(\.capturedAt),
                       [world.clock.date(at: 1000), world.clock.date(at: 1002), world.clock.date(at: 1004)], "the third is visible")
        XCTAssertEqual(span.reason, Self.failed)
        XCTAssertEqual(span.capturedAt, world.clock.date(at: 1006), "one interval after the published frame")
        XCTAssertEqual(span.capturedUntil, world.clock.date(at: 1019))
    }

    func testAnOwedSpanPublishedButNotFlushedIsNotWrittenAgain() async throws {
        let world = World()
        var previous = RuntimeStatus(state: .stopped)
        let held = RuntimeStatus.OwedSpan.ended(reason: Self.failed, from: world.clock.date(at: 600), until: world.clock.date(at: 700))
        previous.owed = [held]
        world.previous = previous
        world.spool.published = { $0.number == 1 ? CaptureStoreError.publishedNotFlushed(end: world.clock.date(at: 700),
                                                                                           cause: CaptureStoreError.io("flush", EIO)) : nil }
        try world.recorder.start(duration: 30)
        await world.recorder.waitUntilStopped()
        let spans = world.spool.appended.filter { $0.capturedUntil != nil }
        XCTAssertEqual(spans.map(\.capturedAt), [world.clock.date(at: 600), world.clock.date(at: 1000)],
                       "the held span once, then the stretch its flush cost")
        XCTAssertNil(world.recorder.status.owed)
    }

    func testAnUnreadableNewestObservationStartsTheStretchAtTheLastStatus() async throws {
        let world = World()
        var previous = RuntimeStatus(state: .recovering)
        previous.capturingSince = world.clock.date(at: 1000 - 2 * 86400)
        previous.storageFailure = StorageFailure(kind: "io", errno: EIO, at: world.clock.date(at: 900))
        previous.updatedAt = world.clock.date(at: 950)
        world.previous = previous
        world.newestUnreadable = true
        try world.recorder.start(duration: 2)
        await world.recorder.waitUntilStopped()
        let gap = try XCTUnwrap(world.spool.appended.first)
        XCTAssertEqual(gap.reason, Self.notRunning)
        XCTAssertEqual(gap.capturedAt, world.clock.date(at: 950))
        XCTAssertEqual(gap.capturedUntil, world.clock.date(at: 1000))
    }

    func testTheOwedListIsInEveryStatusUntilWritten() async throws {
        let world = World()
        world.clock.long = { false }
        var previous = RuntimeStatus(state: .recording)
        previous.updatedAt = world.clock.date(at: 900)
        world.previous = previous
        world.opens = { _ in CaptureStoreError.io("open", EIO) }
        try world.recorder.start()
        try await until("starting is written") { !world.file.written.isEmpty }
        let starting = try XCTUnwrap(world.file.written.first)
        XCTAssertEqual(starting.owed, [RuntimeStatus.OwedSpan(reason: Self.notRunning, from: world.clock.date(at: 900),
                                                              lived: world.clock.date(at: 900))], "unplaced, going on")
        try await until("the first opening failed") { world.recorder.status.state == .recovering }
        XCTAssertEqual(world.file.written.last?.owed, [
            RuntimeStatus.OwedSpan(reason: Self.notRunning, from: world.clock.date(at: 900), until: world.clock.date(at: 1000),
                                   lived: world.clock.date(at: 900)),
            RuntimeStatus.OwedSpan(reason: Self.failed, from: world.clock.date(at: 1000)),
        ], "the unclean end ends where the run began; the run's stretch goes on")
        await world.recorder.stop()
    }


    func testAHeldSpanADeadProcessPublishedIsNotPublishedAgain() async throws {
        let spool = Spool()
        let first = World(spool: spool)
        var stopped = RuntimeStatus(state: .stopped)
        let held = RuntimeStatus.OwedSpan.ended(reason: Self.full, from: first.clock.date(at: 600), until: first.clock.date(at: 700))
        stopped.owed = [held]
        first.previous = stopped
        try first.recorder.start(duration: 4)
        await first.recorder.waitUntilStopped()
        XCTAssertEqual(spool.appended.filter { $0.capturedAt == held.from }.count, 1, "published")
        let left = try XCTUnwrap(first.file.written.last { $0.owed?.contains(held) == true })

        let next = World(spool: spool)
        next.previous = left
        next.newest = spool.appended.last.map { NewestObservation(capturedAt: $0.capturedAt, end: $0.capturedUntil ?? $0.capturedAt) }
        next.clock.advance(100)
        try next.recorder.start(duration: 2)
        await next.recorder.waitUntilStopped()
        XCTAssertEqual(spool.appended.filter { $0.capturedAt == held.from }.count, 1, "one bundle, not two")
        XCTAssertNil(next.recorder.status.owed)
    }

    func testAHeldSpanPublishedButNotFlushedIsNotPublishedAgainByTheNextProcess() async throws {
        let spool = Spool()
        let first = World(spool: spool)
        var stopped = RuntimeStatus(state: .stopped)
        let held = RuntimeStatus.OwedSpan.ended(reason: Self.full, from: first.clock.date(at: 600), until: first.clock.date(at: 700))
        stopped.owed = [held]
        first.previous = stopped
        spool.published = { $0.number == 1 ? CaptureStoreError.publishedNotFlushed(end: first.clock.date(at: 700),
                                                                                     cause: CaptureStoreError.io("flush", EIO)) : nil }
        try first.recorder.start(duration: 30)
        await first.recorder.waitUntilStopped()
        spool.published = { _ in nil }
        let left = try XCTUnwrap(first.file.written.last { $0.owed?.contains(held) == true }, "owed until durable")
        XCTAssertEqual(left.state, .recovering, "the lost tenure's status still owes it")

        let next = World(spool: spool)
        next.previous = left
        next.newest = spool.appended.last.map { NewestObservation(capturedAt: $0.capturedAt, end: $0.capturedUntil ?? $0.capturedAt) }
        next.clock.advance(100)
        try next.recorder.start(duration: 2)
        await next.recorder.waitUntilStopped()
        XCTAssertEqual(spool.appended.filter { $0.capturedAt == held.from }.count, 1, "one bundle, not two")
    }

    func testAnEndingSpanAStopAndAFailedAppendFindStaysOwed() async throws {
        let world = World()
        world.recorder.take(interval: 2, idlePauseAfter: 60, ocr: .always)
        world.acquisition.idle = 100
        world.clock.due = [(1010, { world.acquisition.idle = 0 })]
        world.appending.close()
        try world.recorder.start()
        try await until("the closure's span waits to land") { world.appending.waiting }
        world.opens = { $0 >= 2 ? CaptureStoreError.io("open", EIO) : nil }
        let stopped = Happened()
        Task { @MainActor in
            await world.recorder.stop()
            stopped.note()
        }
        try await until("the stop is taken") { world.recorder.stopping }
        world.spool.refuse = { _ in Refused() }
        world.appending.open()
        try await until("the stop answered") { stopped.value }
        let idle = RuntimeStatus.OwedSpan(reason: CaptureGapReason.inputInactiveCapturePaused.rawValue,
                                          from: world.clock.date(at: 1002), until: world.clock.date(at: 1010))
        let left = try XCTUnwrap(world.file.written.last)
        XCTAssertEqual(left.state, .stopped)
        XCTAssertEqual(left.owed?.map(\.unnamed), [idle], "owed in the status the stop wrote")

        world.spool.refuse = { _ in nil }
        world.opens = { _ in nil }
        world.acquisition.idle = 0
        let before = world.spool.appended.count
        try world.recorder.start(duration: 2)
        await world.recorder.waitUntilStopped()
        let first = try XCTUnwrap(world.spool.appended.dropFirst(before).first)
        XCTAssertEqual(first.reason, idle.reason, "written at the next opening, before anything else")
        XCTAssertEqual(first.capturedAt, idle.from)
        XCTAssertEqual(first.capturedUntil, idle.until)
        XCTAssertNil(world.recorder.status.owed)
    }

    func testTwoClosuresOneAttemptConsumesAStopAndAFailedAppendFindBothOwed() async throws {
        let world = World()
        world.recorder.take(interval: 2, idlePauseAfter: 60, ocr: .always)
        world.acquisition.idle = 100
        world.clock.due = [(1010, { world.acquisition.idle = 0 })]
        world.appending.close()
        try world.recorder.start()
        try await until("the idle closure's span waits to land") { world.appending.held == 1 }
        let asleep = CaptureGapReason.displayAsleepOrSessionInactive.rawValue
        world.machine.set(awake: false)
        let aFrom = world.clock.date
        world.clock.advance(10)
        world.machine.set(awake: true)
        let a = RuntimeStatus.OwedSpan(reason: asleep, from: aFrom, until: world.clock.date)
        world.clock.advance(1)
        world.machine.set(awake: false)
        let bFrom = world.clock.date
        world.clock.advance(10)
        world.machine.set(awake: true)
        let b = RuntimeStatus.OwedSpan(reason: asleep, from: bFrom, until: world.clock.date)
        world.appending.open()
        world.appending.close()
        try await until("the first closure's span waits to land") {
            world.appending.held == 1 && world.spool.appended.contains { $0.reason == CaptureGapReason.inputInactiveCapturePaused.rawValue && $0.capturedUntil != nil }
        }
        world.opens = { $0 >= 2 ? CaptureStoreError.io("open", EIO) : nil }
        let stopped = Happened()
        Task { @MainActor in
            await world.recorder.stop()
            stopped.note()
        }
        try await until("the stop is taken") { world.recorder.stopping }
        world.spool.refuse = { _ in Refused() }
        world.appending.open()
        try await until("the stop answered") { stopped.value }
        let left = try XCTUnwrap(world.file.written.last)
        XCTAssertEqual(left.state, .stopped)
        XCTAssertEqual(left.owed?.map(\.unnamed), [a, b], "both owed in the status the stop wrote")

        world.spool.refuse = { _ in nil }
        world.opens = { _ in nil }
        let before = world.spool.appended.count
        try world.recorder.start(duration: 2)
        await world.recorder.waitUntilStopped()
        let written = world.spool.appended.dropFirst(before).prefix(2).map {
            RuntimeStatus.OwedSpan(reason: $0.reason ?? "", from: $0.capturedAt, until: $0.capturedUntil)
        }
        XCTAssertEqual(written, [a, b], "both written at the next opening, before anything else")
        for span in [a, b] {
            XCTAssertEqual(world.spool.appended.filter { $0.reason == span.reason && $0.capturedAt == span.from }.count, 1,
                           "each once")
        }
        XCTAssertNil(world.recorder.status.owed)
    }

    func testAnEndingSpanAKillLeavesIsWrittenByTheNextProcess() async throws {
        let first = World()
        var longSleeps = 0
        first.clock.long = {
            longSleeps += 1
            return longSleeps == 1
        }
        first.compacting.close()
        first.recorder.take(interval: 2, idlePauseAfter: 60, ocr: .always)
        first.acquisition.idle = 100
        first.appending.close()
        try first.recorder.start()
        try await until("a compaction pass is under way and the idle closure is open") {
            first.compacting.waiting && first.spool.appended.contains { $0.reason == CaptureGapReason.inputInactiveCapturePaused.rawValue }
        }
        first.acquisition.idle = 0
        try await until("the closure's span waits to land") { first.appending.waiting }
        let stopped = Happened()
        Task { @MainActor in
            await first.recorder.stop()
            stopped.note()
        }
        try await until("the stop is taken") { first.recorder.stopping }
        let written = first.file.written.count
        first.compacting.open()
        try await until("compaction wrote a status after the stop") {
            first.file.written.dropFirst(written).contains { $0.state == .stopped }
        }
        let left = try XCTUnwrap(first.file.written.dropFirst(written).first { $0.state == .stopped })
        let span = try XCTUnwrap(left.owed?.first { $0.reason == CaptureGapReason.inputInactiveCapturePaused.rawValue },
                                 "the ending span is owed in it")
        XCTAssertNotNil(span.until)
        first.appending.open()
        try await until("the stop answered") { stopped.value }

        let next = World()
        next.previous = left
        next.clock.advance(1000)
        try next.recorder.start(duration: 2)
        await next.recorder.waitUntilStopped()
        let written2 = try XCTUnwrap(next.spool.appended.first)
        XCTAssertEqual(written2.reason, span.reason, "the next process writes it first")
        XCTAssertEqual(written2.capturedAt, span.from)
        XCTAssertEqual(written2.capturedUntil, span.until)
        XCTAssertFalse(next.spool.appended.contains { $0.reason == Self.notRunning }, "a stop's rest: no unclean end")
    }


    func testAFrameRefusedAsInvalidIsAGapAndTheTenureStands() async throws {
        let world = World()
        world.spool.refuse = { $0.frame == 2 ? CaptureStoreError.invalidObservation : nil }
        try world.recorder.start(duration: 5.9)
        await world.recorder.waitUntilStopped()
        XCTAssertEqual(world.openings, [1000])
        let appended = world.spool.appended
        XCTAssertEqual(appended.map(\.status), [ObservationStatus.captured.rawValue, "gap", ObservationStatus.captured.rawValue])
        XCTAssertEqual(appended[1].reason, CaptureGapReason.captureFailed.rawValue)
        XCTAssertEqual(appended[1].capturedAt, world.clock.date(at: 1002))
        XCTAssertNil(world.recorder.status.storageFailure)
    }

    func testARuntimeFileThatCannotBeWrittenKeepsTheRunRecording() async throws {
        let world = World()
        world.file.refused = world.clock.date(at: 1050)...world.clock.date(at: 1130)
        var seen: [RecorderState] = []
        world.recorder.changed = { if seen.last != world.recorder.status.state { seen.append(world.recorder.status.state) } }
        try world.recorder.start(duration: 200)
        await world.recorder.waitUntilStopped()
        XCTAssertGreaterThan(world.file.refusals, 0, "a heartbeat fell in the refused stretch")
        XCTAssertEqual(seen, [.starting, .recording, .stopped])
        XCTAssertEqual(world.recorder.status.recorded, 100, "a frame at every slot")
        XCTAssertEqual(world.openings, [1000])
        XCTAssertEqual(world.file.written.last?.state, .stopped, "the next write tried again")
    }

    func testConcurrentStopsEndTogetherAndAStartBetweenThemIsRefused() async throws {
        let world = World()
        world.flushing.close()
        try world.recorder.start()
        try await until("the run records") { world.recorder.status.state == .recording }
        let first = Happened(), second = Happened()
        Task { @MainActor in
            await world.recorder.stop()
            first.note()
        }
        Task { @MainActor in
            await world.recorder.stop()
            second.note()
        }
        try await until("the flush is under way") { world.flushing.waiting }
        XCTAssertThrowsError(try world.recorder.start()) { XCTAssertEqual($0 as? RecorderError, .stillPausing) }
        XCTAssertFalse(first.value || second.value, "neither stop answers before the flush")
        world.flushing.open()
        try await until("both stops answered") { first.value && second.value }
        XCTAssertFalse(world.recorder.running)
        XCTAssertEqual(world.log.events.filter { $0 == "flush" }.count, 1, "one cleanup, shared")
        try world.recorder.start()
        XCTAssertTrue(world.recorder.running, "a start after the stop is taken")
        await world.recorder.stop()
    }

    func testAOneShotsStatusAndRuntimeJSONAgree() async throws {
        let world = World()
        try await world.recorder.captureOnce()
        XCTAssertEqual(world.recorder.status.state, .captured)
        XCTAssertEqual(world.file.written.last?.state, .captured)
        XCTAssertEqual(world.recorder.status.recorded, 1)
        XCTAssertFalse(world.recorder.running)
    }
}

@MainActor private final class Log {
    var events: [String] = []
}

@MainActor private final class Door {
    private var shut = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) var waiting = false
    var held: Int { waiters.count }
    func close() { shut = true }
    func open() {
        shut = false
        waiters.forEach { $0.resume() }
        waiters = []
    }
    func pass() async {
        guard shut else { return }
        waiting = true
        await withCheckedContinuation { waiters.append($0) }
    }
}

@MainActor private final class World {
    let log = Log()
    let clock = DueClock()
    let file = StatusFile()
    let opening = Door()
    let flushing = Door()
    let appending = Door()
    let compacting = Door()
    let spool: Spool
    lazy var acquisition = Frames(clock: clock)
    var previous: RuntimeStatus?
    var newest: NewestObservation?
    var newestUnreadable = false
    var opens: (Int) -> Error? = { _ in nil }
    private(set) var openings: [Double] = []
    private(set) var writerMet = 0
    var producersStartedAt: [Double] { machine.started }
    let machine: Machine
    private var failures: FailureLines?
    let spoolFolder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lifecycle-\(UUID().uuidString)")

    init(spool: Spool = Spool()) {
        self.spool = spool
        machine = Machine(log: log, clock: clock)
        clock.long = { [spool] in spool.live == 0 }
    }

    deinit {
        try? FileManager.default.removeItem(at: spoolFolder)
    }

    lazy var recorder: Recorder = {
        var dependencies = RecorderDependencies(acquisition: acquisition, machine: machine,
            input: Input(log: log), clock: clock,
            openStore: { [unowned self] in
                openings.append(clock.uptime)
                await opening.pass()
                if let refusal = opens(openings.count) { throw refusal }
                guard spool.live == 0 else {
                    writerMet += 1
                    throw CaptureStoreError.writerAlreadyRunning
                }
                return Tenure(spool: spool, log: log, flushing: flushing, appending: appending, compacting: compacting,
                              newest: newest, newestUnreadable: newestUnreadable)
            },
            persistStatus: { [file] in try file.write($0) })
        dependencies.previous = previous
        dependencies.audio = Microphone(log: log)
        dependencies.acquisitionTimeout = 30
        dependencies.holdActivity = { [log] _ in
            log.events.append("activity begin")
            return { log.events.append("activity end") }
        }
        if let failures { dependencies.failures = failures }
        return Recorder(configuration: RecorderConfiguration(interval: 2), dependencies: dependencies)
    }()

    func failureLines() -> FailureLines {
        let lines = FailureLines()
        try? FileManager.default.createDirectory(at: spoolFolder, withIntermediateDirectories: true)
        lines.configure(spool: spoolFolder, plain: DeviceFiles(.plain), build: "test", pid: 1)
        failures = lines
        return lines
    }

    func lines() throws -> [[String: Any]] {
        let folder = spoolFolder.appendingPathComponent("resources")
        let days = try FileManager.default.contentsOfDirectory(atPath: folder.path)
            .filter { $0.hasPrefix(FailureLines.prefix) }.sorted()
        return try days.flatMap { day in
            try String(contentsOf: folder.appendingPathComponent(day), encoding: .utf8).split(separator: "\n").map {
                try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
            }
        }
    }
}

@MainActor private final class DueClock: RecorderClock {
    private(set) var uptime: Double = 1000
    var date: Date { date(at: uptime) }
    func date(at uptime: Double) -> Date { Date(timeIntervalSince1970: 1_700_000_000 + uptime) }
    var due: [(at: Double, change: () -> Void)] = []
    var long: () -> Bool = { false }
    func advance(_ seconds: Double) { uptime += seconds }
    func sleep(for seconds: Double) async throws {
        try Task.checkCancellation()
        guard seconds < 15 || long() else {
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
        for _ in 0..<5 { await Task.yield() }
    }
}

@MainActor private final class Frames: RecorderAcquisition {
    let clock: DueClock
    var allowed = true
    var firstWaits = false
    var everyWaits = false
    private(set) var captures: [Int] = []
    private var closes = 0
    private var held: [CheckedContinuation<Void, Never>] = []
    private var released = 0
    init(clock: DueClock) { self.clock = clock }
    var screenRecordingAllowed: Bool { allowed }
    func invalidate() {
        closes += 1
        let waiting = held
        held = []
        waiting.forEach { $0.resume() }
    }
    func releaseFirst() {
        if held.isEmpty {
            released += 1
        } else {
            held.removeFirst().resume()
        }
    }
    var idle: Double? = 0
    func inputIdleSeconds() -> Double? { idle }
    func setModes(_ modes: RecordingModes) {}
    func capture() async throws -> CaptureAttempt {
        captures.append(Int(clock.uptime))
        let frame = CaptureResult(observation: CaptureObservation(capturedAt: clock.date, displayID: 1, width: 4, height: 4),
                                  image: .png(Data([0x89, 0x50, 0x4e, 0x47])))
        if firstWaits, captures.count == 2 { releaseFirst() }
        guard everyWaits || (firstWaits && captures.count == 1) else { return .done([frame]) }
        let taken = closes
        return .recognizing(timings: nil, finish: { [self] in
            if released > 0 {
                released -= 1
            } else if closes == taken {
                await withCheckedContinuation { held.append($0) }
            }
            return [frame]
        })
    }
}

private struct Refused: Error {}

private struct Append {
    let number: Int
    let frame: Int?
}

private final class Spool: @unchecked Sendable {
    private let lock = NSLock()
    private var observations: [CaptureObservation] = []
    private var names: Set<String> = []
    private var tries = 0
    private var frames = 0
    private var open = 0
    private var refusal: (Append) -> Error? = { _ in nil }
    private var publication: (Append) -> Error? = { _ in nil }
    var appended: [CaptureObservation] { lock.withLock { observations } }
    var tried: Int { lock.withLock { tries } }
    var live: Int { lock.withLock { open } }
    var refuse: (Append) -> Error? {
        get { lock.withLock { refusal } }
        set { lock.withLock { refusal = newValue } }
    }
    var published: (Append) -> Error? {
        get { lock.withLock { publication } }
        set { lock.withLock { publication = newValue } }
    }
    func opened() { lock.withLock { open += 1 } }
    func closed() { lock.withLock { open -= 1 } }
    func append(_ observation: CaptureObservation, frame: Bool, bundle: String? = nil) throws {
        try lock.withLock {
            tries += 1
            if frame { frames += 1 }
            let append = Append(number: tries, frame: frame ? frames : nil)
            if let error = refusal(append) { throw error }
            if let bundle {
                guard names.insert(bundle).inserted else { return }
            }
            observations.append(observation)
            if let error = publication(append) { throw error }
        }
    }
}

private final class Tenure: RecorderStorage, @unchecked Sendable {
    private let spool: Spool
    private let log: Log
    private let flushing: Door
    private let appending: Door
    private let compacting: Door
    let newestObservation: NewestObservation?
    let newestUnreadable: Bool
    init(spool: Spool, log: Log, flushing: Door, appending: Door, compacting: Door, newest: NewestObservation?,
         newestUnreadable: Bool) {
        self.newestUnreadable = newestUnreadable
        self.spool = spool
        self.log = log
        self.flushing = flushing
        self.appending = appending
        self.compacting = compacting
        newestObservation = newest
        spool.opened()
    }
    deinit { spool.closed() }
    func append(_ observation: CaptureObservation, image: CaptureImage?) async throws {
        if observation.capturedUntil != nil { await appending.pass() }
        try spool.append(observation, frame: image != nil)
    }
    func append(_ observation: CaptureObservation, bundle: String) async throws {
        if observation.capturedUntil != nil { await appending.pass() }
        try spool.append(observation, frame: false, bundle: bundle)
    }
    func hasBackpressure() -> Bool { false }
    func compact(flush: Bool) async throws -> VideoCompactionReport {
        if flush {
            await MainActor.run { log.events.append("flush") }
            await flushing.pass()
        } else {
            await compacting.pass()
        }
        return VideoCompactionReport(imageCount: 0, pendingImageCount: 0, pendingBytes: 0)
    }
}

private final class StatusFile: @unchecked Sendable {
    private let lock = NSLock()
    private var statuses: [RuntimeStatus] = []
    private var refusing: ClosedRange<Date>?
    private var refusedCount = 0
    var written: [RuntimeStatus] { lock.withLock { statuses } }
    var refused: ClosedRange<Date>? {
        get { lock.withLock { refusing } }
        set { lock.withLock { refusing = newValue } }
    }
    var refusals: Int { lock.withLock { refusedCount } }
    func write(_ status: RuntimeStatus) throws {
        try lock.withLock {
            if refusing?.contains(status.updatedAt) == true {
                refusedCount += 1
                throw CocoaError(.fileWriteOutOfSpace)
            }
            statuses.append(status)
        }
    }
}

@MainActor private final class Machine: RecorderMachine {
    let log: Log
    let clock: DueClock
    private(set) var started: [Double] = []
    init(log: Log, clock: DueClock) {
        self.log = log
        self.clock = clock
    }
    private var awake = true
    var availability: RecorderAvailability { RecorderAvailability(displayAwake: awake, sessionActive: true) }
    var availabilityChanged: ((RecorderAvailability) -> Void)?
    func set(awake: Bool) {
        self.awake = awake
        availabilityChanged?(availability)
    }
    func start() {
        started.append(clock.uptime)
        log.events.append("machine start")
    }
    func stop() { log.events.append("machine stop") }
    func setModes(_ modes: RecordingModes) {}
}

@MainActor private final class Input: RecorderInput {
    let log: Log
    init(log: Log) { self.log = log }
    var status: RecorderInputStatus { RecorderInputStatus(state: .recording) }
    func start() { log.events.append("input start") }
    func stop() { log.events.append("input stop") }
    func setModes(_ modes: RecordingModes) {}
}

@MainActor private final class Microphone: RecorderAudio {
    let log: Log
    init(log: Log) { self.log = log }
    var status: AudioStatus { AudioStatus(mic: .stopped, sound: .stopped) }
    func start() { log.events.append("audio start") }
    func stop() { log.events.append("audio stop") }
    func setModes(_ modes: RecordingModes) {}
}

private extension RuntimeStatus.OwedSpan {
    var unnamed: RuntimeStatus.OwedSpan {
        var span = self
        span.bundle = nil
        return span
    }
}
