import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

@MainActor
final class VoiceLifecycleTests: XCTestCase {
    func testBackgroundStopsBeforeReturningAndSecondEventCannotDiscardSavedAudio() async throws {
        let home = try VoiceTestHome(self)
        let engine = SyntheticVoiceSession()
        let controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .granted })
        controller.start()
        try await until("the microphone started") { controller.phase.isRecording }
        XCTAssertTrue(engine.isActive)
        controller.enteredBackground()
        XCTAssertFalse(engine.isActive, "Audio must close before the background callback returns")
        XCTAssertEqual(engine.releaseCount, 1)
        controller.interrupted()
        try await until("the note saved") { controller.phase == .idle }
        let entries = try await home.store.entries(domain: .voice)
        XCTAssertEqual(entries.count, 1)
        guard case .object(let payload) = entries.first?.payload else { return XCTFail("Missing voice note") }
        XCTAssertEqual(payload["end_reason"], .string("background"))
        XCTAssertEqual(entries.first?.kind, "voice_note")
        XCTAssertEqual(entries.first?.observedAt, "2023-11-14T22:13:20.000000000Z")
        XCTAssertEqual(payload["blob"], .object([
            "hash": .string(SHA256Digest.tagged(Data([1, 2, 3]))), "type": .string("audio/mp4"),
            "bytes": .integer(3), "role": .string("voice_note"),
        ]))
        XCTAssertEqual(payload["started_at"], .string("2023-11-14T22:13:20.000000000Z"))
        XCTAssertEqual(payload["ended_at"], .string("2023-11-14T22:13:21.000000000Z"))
        XCTAssertEqual(payload["capture_mode"], .string("hands_free"))
        XCTAssertEqual(payload["encoder"], .object([
            "format": .string("aac_lc"), "container": .string("m4a"),
            "sample_rate_hz": .integer(48_000), "channels": .integer(1), "bit_rate": .integer(128_000),
        ]))
        XCTAssertEqual(payload["input"], .null)
        XCTAssertEqual(payload["location"], .null)
    }

    func testStopTwiceAndCancelWhileSavingKeepTheOneSave() async throws {
        let home = try VoiceTestHome(self)
        let controller = VoiceRecordController(recorder: home.recorder, engine: SyntheticVoiceSession(), permission: { .granted })
        controller.start()
        try await until("the microphone started") { controller.phase.isRecording }
        guard case .recording(let recorded, _) = controller.phase else { return XCTFail("recording") }
        controller.stop()
        XCTAssertEqual(controller.phase, .saving(elapsed: recorded))
        controller.stop()
        XCTAssertEqual(controller.phase, .saving(elapsed: recorded), "A second Stop waits for the save")
        controller.cancel()
        XCTAssertEqual(controller.phase, .saving(elapsed: recorded), "Cancel cannot reach a closed note")
        controller.start()
        XCTAssertEqual(controller.phase, .saving(elapsed: recorded), "Saving admits no new note")
        try await until("the note saved") { controller.phase == .idle }
        let entries = try await home.store.entries(domain: .voice)
        XCTAssertEqual(entries.count, 1)
        guard case .object(let payload) = entries.first?.payload else { return XCTFail("Missing voice note") }
        XCTAssertEqual(payload["end_reason"], .string("tapped"))
    }

    func testSaveFailureStandsUntilAcknowledgedThenANewNoteSaves() async throws {
        let refusing = Happened()
        let home = try VoiceTestHome(self, authorizeWrite: {
            if !refusing.value { refusing.note(); throw VoiceCaptureError.noBytes }
        })
        let engine = SyntheticVoiceSession()
        let controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .granted })
        controller.start()
        try await until("the microphone started") { controller.phase.isRecording }
        controller.stop()
        try await until("the save failed") { controller.phase.failure != nil }
        XCTAssertEqual(controller.phase, .failed(VoiceCaptureError.noBytes.localizedDescription))
        controller.start()
        XCTAssertFalse(engine.isActive, "No note starts under the failure's alert")
        controller.acknowledge()
        XCTAssertEqual(controller.phase, .idle)
        controller.start()
        try await until("the microphone started") { controller.phase.isRecording }
        controller.stop()
        try await until("the second note saved") { controller.phase == .idle }
        let entries = try await home.store.entries(domain: .voice)
        XCTAssertEqual(entries.count, 1)
    }

    func testANoteThatFailsWithItsPanelCoveredIsDrawnOnReturnAndTryAgainSaves() async throws {
        let refusing = Happened()
        let home = try VoiceTestHome(self, authorizeWrite: {
            if !refusing.value { refusing.note(); throw VoiceCaptureError.noBytes }
        })
        let controller = VoiceRecordController(recorder: home.recorder, engine: SyntheticVoiceSession(), permission: { .granted })
        let sheet = { (presented: AppNavigation.Presented?) in
            AppShell.sheet(presented: presented, shown: presented, voice: controller.phase)
        }
        controller.start()
        XCTAssertEqual(sheet(nil), .voiceNote, "the panel opens while the microphone starts")
        try await until("the microphone started") { controller.phase.isRecording }
        XCTAssertEqual(sheet(nil), .voiceNote)
        controller.enteredBackground()
        try await until("the save failed") { controller.phase.failure != nil }
        XCTAssertEqual(sheet(nil), .voiceNote, "the failure is drawn on return")
        XCTAssertEqual(sheet(.streams), .streams, "a sheet over it stands first")
        XCTAssertEqual(sheet(nil), .voiceNote, "and the failure waits under it")
        XCTAssertNil(sheet(.camera), "never over the camera's cover")

        controller.again()
        try await until("Try again records a new note") { controller.phase.isRecording }
        XCTAssertEqual(sheet(nil), .voiceNote)
        controller.stop()
        try await until("the new note saved") { controller.phase == .idle }
        XCTAssertNil(sheet(nil), "the panel goes once the note saves")
        let entries = try await home.store.entries(domain: .voice)
        XCTAssertEqual(entries.count, 1)
    }

    func testMicrophoneOffIsDeniedUntilAcknowledged() async throws {
        let home = try VoiceTestHome(self)
        let engine = SyntheticVoiceSession()
        let controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .denied })
        controller.start()
        XCTAssertEqual(controller.phase, .denied)
        XCTAssertEqual(engine.primeCount, 0)
        controller.start()
        XCTAssertEqual(engine.primeCount, 0)
        controller.acknowledge()
        XCTAssertEqual(controller.phase, .idle)
        let entries = try await home.store.entries(domain: .voice)
        XCTAssertTrue(entries.isEmpty)
    }

    func testAnswerAfterTheBackgroundStartsNothing() async throws {
        let home = try VoiceTestHome(self)
        let engine = SyntheticVoiceSession()
        let answered = Happened()
        var controller: VoiceRecordController!
        controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .undetermined },
            askPermission: {
                controller.enteredBackground()
                answered.note()
                return true
            })
        controller.start()
        XCTAssertEqual(controller.phase, .asking)
        try await until("the question answered") { answered.value }
        XCTAssertEqual(controller.phase, .idle)
        XCTAssertEqual(engine.primeCount, 0)
        let entries = try await home.store.entries(domain: .voice)
        XCTAssertTrue(entries.isEmpty)
    }

    func testInterruptionLeavesTheQuestionAnswerable() async throws {
        let home = try VoiceTestHome(self)
        let engine = SyntheticVoiceSession()
        var controller: VoiceRecordController!
        controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .undetermined },
            askPermission: {
                controller.interrupted()
                return true
            })
        controller.start()
        try await until("the answer started the note") { controller.phase.isRecording }
        controller.stop()
        try await until("the note saved") { controller.phase == .idle }
        let entries = try await home.store.entries(domain: .voice)
        XCTAssertEqual(entries.count, 1)
    }

    func testThePanelOpensBeforeTheMicrophoneAndCancelWhileItStartsDiscardsWhatStarts() async throws {
        let home = try VoiceTestHome(self)
        let engine = SyntheticVoiceSession()
        engine.holding = true
        let controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .granted })
        controller.start()
        XCTAssertEqual(controller.phase, .starting, "start returns before the microphone answers")
        XCTAssertTrue(controller.phase.showsPanel)
        try await until("the microphone is asked") { engine.primeCount == 1 }
        controller.stop()
        XCTAssertEqual(controller.phase, .starting, "Stop waits for the microphone")
        controller.cancel()
        XCTAssertEqual(controller.phase, .idle)
        controller.start()
        XCTAssertEqual(engine.primeCount, 1, "no second start while the first is still opening")
        engine.letGo()
        try await until("what started after Cancel is let go") { engine.releaseCount == 1 }
        XCTAssertFalse(engine.isActive)
        XCTAssertEqual(controller.phase, .idle)
        engine.holding = true
        controller.start()
        try await until("the microphone is asked again") { engine.primeCount == 2 }
        controller.interrupted()
        XCTAssertEqual(controller.phase, .idle, "an interruption while it starts ends the note before it begins")
        engine.letGo()
        try await until("what started after the interruption is let go") { engine.releaseCount == 2 }
        XCTAssertFalse(engine.isActive)
        controller.start()
        try await until("a new note starts") { controller.phase.isRecording }
        controller.cancel()
        let entries = try await home.store.entries(domain: .voice)
        XCTAssertTrue(entries.isEmpty)
    }

    func testSecondStallSavesTheNote() async throws {
        let home = try VoiceTestHome(self)
        let engine = SyntheticVoiceSession()
        let controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .granted })
        controller.start()
        engine.stalled = true
        try await until("the note saved after the second stall") { controller.phase == .idle }
        XCTAssertEqual(engine.primeCount, 2, "the first stall starts the microphone again")
        XCTAssertFalse(engine.isActive)
        let entries = try await home.store.entries(domain: .voice)
        guard case .object(let payload) = entries.first?.payload else { return XCTFail("Missing voice note") }
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(payload["end_reason"], .string("stalled"))
    }

    func testRestartThatThrowsFailsTheNote() async throws {
        let home = try VoiceTestHome(self)
        let engine = SyntheticVoiceSession()
        let controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .granted })
        controller.start()
        try await until("the microphone started") { controller.phase.isRecording }
        engine.refuses = true
        engine.stalled = true
        try await until("the stalled note failed") { controller.phase.failure != nil }
        XCTAssertEqual(controller.phase, .failed(VoiceCaptureError.recorderRefused.localizedDescription))
        XCTAssertFalse(engine.isActive)
        let entries = try await home.store.entries(domain: .voice)
        XCTAssertTrue(entries.isEmpty)
    }

    func testTimeLimitSavesTheNote() async throws {
        let home = try VoiceTestHome(self)
        let engine = SyntheticVoiceSession()
        engine.duration = VoiceRecordController.durationLimit
        let controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .granted })
        controller.start()
        try await until("the note saved at the limit") { controller.phase == .idle }
        XCTAssertFalse(engine.isActive)
        let entries = try await home.store.entries(domain: .voice)
        guard case .object(let payload) = entries.first?.payload else { return XCTFail("Missing voice note") }
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(payload["end_reason"], .string("limit"))
    }

    func testRecorderThatRefusesToStartFailsAndTheBackgroundReleases() async throws {
        let home = try VoiceTestHome(self)
        let engine = SyntheticVoiceSession()
        engine.refuses = true
        let controller = VoiceRecordController(recorder: home.recorder, engine: engine, permission: { .granted })
        controller.start()
        try await until("the start failed") { controller.phase.failure != nil }
        XCTAssertEqual(controller.phase, .failed(VoiceCaptureError.recorderRefused.localizedDescription))
        XCTAssertFalse(engine.isActive)
        controller.enteredBackground()
        XCTAssertEqual(engine.releaseCount, 1)
        XCTAssertEqual(controller.phase, .failed(VoiceCaptureError.recorderRefused.localizedDescription))
    }
}

@MainActor
private struct VoiceTestHome {
    let store: CaptureStore
    let recorder: VoiceRecorder

    init(_ test: XCTestCase, authorizeWrite: @escaping @Sendable () async throws -> Void = {}) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        test.addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        store = try CaptureStore(root: root.appendingPathComponent("capture"))
        let location = LocationRecorderCoordinator(
            store: store, intentStore: TrackingIntentStore(url: root.appendingPathComponent("intent.json")),
            bootID: UUID(), platformServicesEnabled: false)
        recorder = VoiceRecorder(store: store, locationRecorder: location, authorizeWrite: authorizeWrite)
    }
}

@MainActor
private final class SyntheticVoiceSession: VoiceCaptureSession {
    private(set) var isActive = false
    private(set) var releaseCount = 0
    private(set) var primeCount = 0
    var duration: TimeInterval = 1
    var refuses = false
    var stalled = false
    var holding = false
    private var waiting: CheckedContinuation<Void, Never>?
    var completedFile: OwnedMediaFile? = voiceFixtureFile()
    var currentTime: TimeInterval { isActive ? duration : 0 }
    var isStalled: Bool { isActive && stalled }
    func prime() async throws {
        primeCount += 1
        if holding { await withCheckedContinuation { waiting = $0 } }
        if refuses { throw VoiceCaptureError.recorderRefused }
        if completedFile == nil { completedFile = voiceFixtureFile() }
        isActive = true
    }
    func discard() { isActive = false; completedFile = nil }
    func letGo() {
        holding = false
        waiting?.resume()
        waiting = nil
    }
    func level() -> Float { 0 }
    func releaseSession() { releaseCount += 1 }
    func finish(mode: VoiceNoteMode, reason: String) throws -> VoiceNoteSnapshot {
        guard isActive else { throw VoiceCaptureError.notRecording }
        isActive = false
        guard let file = completedFile else { throw VoiceCaptureError.noBytes }
        completedFile = nil
        return VoiceNoteSnapshot(file: file, encoder: .aacMono48k,
            startedAt: Date(timeIntervalSince1970: 1_700_000_000),
            endedAt: Date(timeIntervalSince1970: 1_700_000_001), durationSeconds: duration,
            mode: mode, endReason: reason, input: nil)
    }
}

private func voiceFixtureFile() -> OwnedMediaFile {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try! FileDurability.writeNewRegularFileDurably(Data([1, 2, 3]), to: url)
    return OwnedMediaFile(takingOwnershipOf: url)
}

@MainActor
final class VoiceFileLifetimeTests: XCTestCase {
    func testInterruptedThenBackgroundAndDismissalKeepsLargeSaveAlive() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        let location = LocationRecorderCoordinator(store: store,
            intentStore: TrackingIntentStore(url: root.appendingPathComponent("intent")), bootID: UUID(), platformServicesEnabled: false)
        let recorder = VoiceRecorder(store: store, locationRecorder: location, authorizeWrite: {})
        let url = root.appendingPathComponent("synthetic-voice")
        let writer = try FileDurability.createRegularFileExclusively(at: url)
        for _ in 0..<64 { try writer.write(contentsOf: Data(repeating: 0x5A, count: 1_048_576)) }
        try writer.close()
        let engine = SyntheticVoiceSession()
        engine.completedFile = OwnedMediaFile(takingOwnershipOf: url)
        var controller: VoiceRecordController? = VoiceRecordController(recorder: recorder, engine: engine, permission: { .granted })
        controller?.start()
        try await until("the microphone started") { controller?.phase.isRecording == true }
        controller?.interrupted()
        XCTAssertFalse(engine.isActive)
        XCTAssertNil(engine.completedFile)
        controller?.enteredBackground()
        controller?.start()
        XCTAssertFalse(engine.isActive, "Saving cannot admit a new recording")
        controller = nil
        try await until("try await store.entries(domain: .voice).count == 1") { try await store.entries(domain: .voice).count == 1 }
        let entries = try await store.entries(domain: .voice)
        XCTAssertEqual(entries.count, 1)
        guard case .object(let payload) = entries.first?.payload,
              case .object(let blob)? = payload["blob"] else { return XCTFail("voice payload") }
        XCTAssertEqual(payload["end_reason"], .string("interrupted"))
        XCTAssertEqual(blob["bytes"], .integer(64 * 1_048_576))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testMinimumDurationDropsOwnedFileWithoutPublishing() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        let location = LocationRecorderCoordinator(store: store,
            intentStore: TrackingIntentStore(url: root.appendingPathComponent("intent")), bootID: UUID(), platformServicesEnabled: false)
        let engine = SyntheticVoiceSession()
        engine.duration = 0.1
        let url = try XCTUnwrap(engine.completedFile?.url)
        let controller = VoiceRecordController(recorder: VoiceRecorder(store: store, locationRecorder: location, authorizeWrite: {}),
            engine: engine, permission: { .granted })
        var phases: [VoiceRecordController.Phase] = []
        let watching = controller.$phase.sink { phases.append($0) }
        defer { watching.cancel() }
        controller.start()
        try await until("the microphone started") { controller.phase.isRecording }
        controller.enteredBackground()
        XCTAssertEqual(controller.phase, .idle)
        XCTAssertFalse(phases.contains { if case .saving = $0 { true } else { false } }, "A slip never enters saving")
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        let blobs = try await store.validatedBlobInventory()
        XCTAssertTrue(blobs.isEmpty)
    }
}

@MainActor
final class ChatRecorderTests: XCTestCase {
    private func made(_ test: XCTestCase, giveBack: @escaping () -> Void = {}) -> (ChatRecorder, AskOutbox, TestMicrophone) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        test.addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let outbox = AskOutbox(folder: folder, stage: { _ in throw CancellationError() },
                               notes: AskOutbox.NoteRoutes(open: { _ in }, second: { _, _, _ in }, cancel: { _ in }), here: { "home" })
        let microphone = TestMicrophone()
        let recorder = ChatRecorder(outbox: outbox, microphone: microphone, permission: { .granted }, askPermission: { true }, giveBack: giveBack)
        return (recorder, outbox, microphone)
    }

    private static let limits = HomeLink.Ask.Ready.Limits(photos: 10, photoBytes: 26_214_400, voiceMs: 600_000)

    func testAChatNoteWritesNothingToTheVoiceNotesSpoolAndKeepsItsSecondsAsSixteenBitSixteenKilohertz() async throws {
        let home = try VoiceTestHome(self)
        let (recorder, outbox, microphone) = made(self)
        recorder.start(for: "page", unready: nil, limits: Self.limits)
        microphone.speak(seconds: 2.5)
        try await until("every sample heard") { recorder.samples == 40_000 }
        let note = try await recorder.taken()
        XCTAssertEqual(note.seconds, 3)
        XCTAssertEqual(note.ms, 2_500)
        XCTAssertEqual(try Data(contentsOf: outbox.file(note: note.id, 0)).count, ChatRecorder.second)
        XCTAssertEqual(try Data(contentsOf: outbox.file(note: note.id, 2)).count, 16_000, "the last part, half a second")
        let wav = try XCTUnwrap(outbox.sound(note.id))
        XCTAssertEqual(wav.count, 44 + 80_000, "the WAV holds every sample")
        XCTAssertEqual(note.levels.count, 25, "a level each tenth of a second, up to the bubble's bars")
        let spooled = try await home.store.entries(domain: .voice)
        XCTAssertTrue(spooled.isEmpty, "nothing in the Voice notes spool")
    }

    func testStopHearsEverySampleOnItsWayBeforeTheLastPart() async throws {
        let (recorder, outbox, microphone) = made(self)
        recorder.start(for: "page", unready: nil, limits: Self.limits)
        microphone.speak(seconds: 1.3)
        let note = try await recorder.taken()
        XCTAssertEqual(note.ms, 1_300, "none of the end cut")
        XCTAssertEqual(note.seconds, 2)
        XCTAssertEqual(try Data(contentsOf: outbox.file(note: note.id, 1)).count, 9_600)
    }

    func testTheAudioSessionIsGivenBackWhenTheMicrophoneIsLetGo() async throws {
        var given = 0
        let (recorder, _, microphone) = made(self, giveBack: { given += 1 })
        recorder.start(for: "page", unready: nil, limits: Self.limits)
        microphone.speak(seconds: 1)
        _ = await recorder.take()
        XCTAssertEqual(given, 1, "at Stop")
        recorder.sent(try XCTUnwrap(recorder.note))
        recorder.start(for: "page", unready: nil, limits: Self.limits)
        recorder.halt()
        XCTAssertEqual(given, 2, "stopped by itself")
        recorder.cancel()
        XCTAssertEqual(given, 2, "once a recording")
        recorder.start(for: "page", unready: nil, limits: Self.limits)
        recorder.cancel()
        XCTAssertEqual(given, 3, "at ×")
    }
}
