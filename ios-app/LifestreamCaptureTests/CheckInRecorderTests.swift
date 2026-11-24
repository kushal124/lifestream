import Foundation
import XCTest
@testable import Lifestream
@testable import LifestreamCaptureCore

@MainActor
final class CheckInRecorderTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!; return calendar
    }
    private let now = CaptureTime.date(rfc3339: "2026-06-01T09:00:00Z")!
    private func fixture(prompting: Bool = true) async throws -> (CaptureStore, TestCheckInNotifications, CheckInRecorder, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try await CaptureStore.restored(root: root)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let source = TestCheckInNotifications()
        let recorder = CheckInRecorder(store: store, notifications: source,
            stateURL: root.appendingPathComponent("checkin-schedule.json"))
        if prompting { try await recorder.setPrompts(on: true) }
        return (store, source, recorder, root)
    }
    private func report(_ form: CheckInForm = .moment, prompt: CheckInPrompt? = nil,
                        time: Date? = nil, blockID: String? = nil) -> CheckInReport {
        var answers: [String: JSONValue] = [:]
        for item in form.items {
            switch item.format {
            case .rating: answers[item.id] = .integer(Int64(item.firstValue))
            case .text: answers[item.id] = .string("Synthetic task")
            case .category: answers[item.id] = .string("build")
            case .yesNo: answers[item.id] = .bool(false)
            }
        }
        let time = time ?? now
        return .init(form: form, openedAt: CaptureTime.rfc3339(time.addingTimeInterval(-10)), answeredAt: CaptureTime.rfc3339(time),
            localZone: "Etc/UTC", responseMS: 10_000, changes: 1, answers: answers, blockID: blockID,
            promptID: prompt?.id, trigger: prompt?.trigger ?? "manual")
    }
    func testScheduledCheckInsAreOffByDefault() async throws {
        let (store, source, recorder, _) = try await fixture(prompting: false)
        await recorder.wake(now: now, calendar: calendar)
        await recorder.openRow(now: now)
        let status = await recorder.status()
        XCTAssertNil(status.state.schedule)
        XCTAssertNil(status.error)
        let scheduled = await source.scheduled
        XCTAssertTrue(scheduled.isEmpty)
        let requests = await source.requests
        XCTAssertEqual(requests, 0, "off, no notification permission is asked")
        let entries = try await store.entries(domain: .checkin)
        XCTAssertTrue(entries.filter { $0.kind == "prompt" }.isEmpty)
        try await recorder.save(report())
        let reports = try await store.entries(domain: .checkin).filter { $0.kind == "report" }
        XCTAssertEqual(reports.map { $0.payload.ciString("trigger") }, ["manual"], "a person still checks in")
    }
    func testOffCancelsTheStoredScheduleAndOnResumesItOnce() async throws {
        let (store, source, recorder, _) = try await fixture()
        await recorder.wake(now: now, calendar: calendar)
        var scheduled = await source.scheduled
        XCTAssertFalse(scheduled.isEmpty)
        let before = await recorder.status()
        let schedule = try XCTUnwrap(before.state.schedule)
        try await recorder.setPrompts(on: false)
        scheduled = await source.scheduled
        XCTAssertTrue(scheduled.isEmpty, "off cancels every stored prompt's notification at once")
        await recorder.wake(now: now.addingTimeInterval(60), calendar: calendar)
        scheduled = await source.scheduled
        XCTAssertTrue(scheduled.isEmpty)
        var status = await recorder.status()
        XCTAssertEqual(status.state.schedule?.prompts, schedule.prompts, "off keeps the stored schedule")
        XCTAssertNil(status.error)
        try await recorder.setPrompts(on: true)
        await recorder.wake(now: now.addingTimeInterval(120), calendar: calendar)
        scheduled = await source.scheduled
        XCTAssertFalse(scheduled.isEmpty)
        status = await recorder.status()
        XCTAssertEqual(status.state.schedule?.prompts, schedule.prompts, "on resumes today's schedule, not a new one")
        let events = try await store.entries(domain: .checkin)
            .filter { $0.kind == "prompt" && $0.payload.ciString("event") == "scheduled" }
            .compactMap { $0.payload.ciString("prompt_id") }
        XCTAssertEqual(events.count, Set(events).count, "one scheduled entry per prompt")
    }
    func testOffAKeptScheduleStatesItsWakeOnlyOnItsOwnDay() async throws {
        let (_, _, recorder, _) = try await fixture()
        await recorder.wake(now: now, calendar: calendar)
        let model = CheckInModel(recorder: recorder, healthWake: { nil })
        await model.readStatus()
        XCTAssertNotNil(model.wakeSchedule, "on, the schedule the wake keeps current")
        try await recorder.setPrompts(on: false)
        await model.readStatus()
        XCTAssertNotNil(model.status.state.schedule, "off keeps an older day's schedule")
        XCTAssertNil(model.wakeSchedule, "and states no wake from it")
        model.beginTest()
        XCTAssertNil(model.session?.wake)
        XCTAssertNil(model.session?.wakeSource)
        try await recorder.setPrompts(on: true)
        await recorder.wake(now: Date(), calendar: .current, rebuild: true)
        try await recorder.setPrompts(on: false)
        await model.readStatus()
        XCTAssertNotNil(model.wakeSchedule, "off, today's kept schedule still states today's wake")
    }
    func testOneReportPerSaveAndCancelWritesNothing() async throws {
        let (store, _, recorder, _) = try await fixture()
        await recorder.cancel()
        var entries = try await store.entries(domain: .checkin)
        XCTAssertTrue(entries.isEmpty)
        try await recorder.save(report())
        entries = try await store.entries(domain: .checkin)
        XCTAssertEqual(entries.map(\.kind), ["report"])
        XCTAssertEqual(entries[0].payload.ciString("form"), "moment")
        XCTAssertEqual(entries[0].payload.ciObject["items"]?.ciArray.count, 3)
        await recorder.cancel()
        let afterCancel = try await store.entries(domain: .checkin)
        XCTAssertEqual(entries, afterCancel)
        let invalid = CheckInReport(form: .moment, openedAt: "", answeredAt: "", localZone: "Etc/UTC", responseMS: 0, changes: 0, answers: [:])
        do { try await recorder.save(invalid); XCTFail("Incomplete reports must not write") } catch {}
        let afterInvalid = try await store.entries(domain: .checkin)
        XCTAssertEqual(entries, afterInvalid)
    }
    func testOneAccessPerChangeAndNoLaunchAuthorization() async throws {
        let (store, source, recorder, root) = try await fixture()
        let date = now, localCalendar = calendar
        async let first: Void = recorder.wake(now: date, calendar: localCalendar)
        async let second: Void = recorder.wake(now: date, calendar: localCalendar)
        _ = await (first, second)
        let requests = await source.requests
        XCTAssertEqual(requests, 0)
        var entries = try await store.entries(domain: .checkin)
        XCTAssertEqual(entries.filter { $0.kind == "access" }.count, 1)
        await recorder.openRow(now: now)
        entries = try await store.entries(domain: .checkin)
        XCTAssertEqual(entries.filter { $0.kind == "access" }.map { $0.payload.ciString("notifications") }, ["not_determined", "authorized"])
        let restored = CheckInRecorder(store: store, notifications: source, stateURL: root.appendingPathComponent("checkin-schedule.json"))
        await restored.wake(now: now, calendar: calendar)
        let afterRestore = try await store.entries(domain: .checkin)
        XCTAssertEqual(afterRestore.filter { $0.kind == "access" }.count, 2)
        await source.setAuthorization("denied")
        await restored.wake(now: now, calendar: calendar)
        let changed = try await store.entries(domain: .checkin)
        XCTAssertEqual(changed.filter { $0.kind == "access" }.count, 3)
    }
    func testStoredScheduleReplayAndPromptEvents() async throws {
        let (store, source, recorder, root) = try await fixture()
        await recorder.wake(now: now, calendar: calendar)
        let status = await recorder.status()
        let schedule = try XCTUnwrap(status.state.schedule)
        let prompt = try XCTUnwrap(schedule.prompts.first { $0.form == "moment" })
        let restored = CheckInRecorder(store: store, notifications: source, stateURL: root.appendingPathComponent("checkin-schedule.json"))
        await restored.wake(now: now.addingTimeInterval(600), calendar: calendar)
        let restoredStatus = await restored.status()
        XCTAssertEqual(restoredStatus.state.schedule?.prompts, schedule.prompts)
        XCTAssertEqual(restoredStatus.state.schedule?.seed, schedule.seed)
        for event in ["delivered", "opened", "dismissed"] {
            await restored.event(promptID: prompt.id, event: event, at: prompt.scheduledFor)
            await restored.event(promptID: prompt.id, event: event, at: prompt.scheduledFor)
        }
        await restored.cancel()
        try await restored.save(report(prompt: prompt, time: prompt.scheduledFor.addingTimeInterval(30)))
        await restored.wake(now: prompt.expires.addingTimeInterval(1), calendar: calendar)
        let entries = try await store.entries(domain: .checkin)
        let events = entries.filter { $0.kind == "prompt" && $0.payload.ciString("prompt_id") == prompt.id }.compactMap { $0.payload.ciString("event") }
        XCTAssertEqual(events, ["scheduled", "delivered", "opened", "dismissed", "answered"])
    }
    func testExpiredPromptBecomesManualAndBlockTimeoutIsMissing() async throws {
        let (store, _, recorder, _) = try await fixture()
        await recorder.wake(now: now, calendar: calendar)
        let status = await recorder.status()
        let prompt = try XCTUnwrap(status.state.schedule?.prompts.first)
        let after = prompt.expires.addingTimeInterval(11)
        await recorder.event(promptID: prompt.id, event: "opened", at: after)
        try await recorder.save(report(prompt: prompt, time: after))
        try await recorder.save(report(.blockBefore, blockID: "synthetic-block"))
        await recorder.wake(now: now.addingTimeInterval(3 * 3600 + 1), calendar: calendar)
        await recorder.wake(now: now.addingTimeInterval(3 * 3600 + 2), calendar: calendar)
        let entries = try await store.entries(domain: .checkin)
        let manual = try XCTUnwrap(entries.first { $0.kind == "report" && $0.payload.ciString("form") == "moment" })
        XCTAssertEqual(manual.payload.ciString("trigger"), "manual")
        XCTAssertEqual(manual.payload.ciObject["prompt_id"], .null)
        XCTAssertEqual(entries.filter { $0.payload.ciString("event") == "expired" && $0.payload.ciString("prompt_id") == prompt.id }.count, 1)
        let timeouts = entries.filter { $0.payload.ciString("ended_by") == "timeout" }
        XCTAssertEqual(timeouts.count, 1)
        XCTAssertEqual(timeouts[0].payload.ciObject["items"], .array([]))
        XCTAssertEqual(timeouts[0].observedAt, CaptureTime.rfc3339(now.addingTimeInterval(3 * 3600)))
    }
    func testBackgroundPreservesPendingTrialAndCompletedCounter() async throws {
        let (store, _, recorder, _) = try await fixture()
        let session = VigilanceSession(promptID: nil, trigger: "prework", wake: nil, wakeSource: nil)
        session.start(clock: 10, date: now, device: .object([:]))
        _ = session.frame(targetTimestamp: 10.01, frameDuration: 1 / 60)
        session.touch(timestamp: 10.05)
        session.interrupt("background", clock: 10.1)
        session.finish(completed: false, clock: 10.1)
        let record = try XCTUnwrap(session.record)
        try await recorder.saveVigilance(record)
        try await recorder.saveVigilance(record)
        let entries = try await store.entries(domain: .checkin)
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].payload.ciObject["completed"], .bool(false))
        XCTAssertEqual(entries[0].payload.ciObject["session_number"]?.ciNumber, 0)
        XCTAssertEqual(entries[0].payload.ciObject["trials"]?.ciArray.first?.ciString("class"), "false_start")
        XCTAssertEqual(entries[0].payload.ciObject["interruptions"]?.ciArray.first?.ciString("reason"), "background")
    }
    func testBeforeFourDoesNotDrawAndFirstPreworkAddsCalibration() async throws {
        let (store, _, recorder, root) = try await fixture()
        await recorder.wake(now: now.addingTimeInterval(-6 * 3600), calendar: calendar)
        let early = await recorder.status()
        XCTAssertNil(early.state.schedule)
        await recorder.wake(now: now, calendar: calendar)
        let first = await recorder.status()
        let seed = first.state.schedule?.seed
        XCTAssertFalse(first.state.schedule!.prompts.contains { $0.trigger == "calibration" })
        try await recorder.save(report(.prework))
        await recorder.wake(now: now, calendar: calendar)
        let scheduled = await recorder.status()
        XCTAssertEqual(scheduled.state.schedule?.seed, seed)
        XCTAssertEqual(scheduled.state.schedule?.prompts.filter { $0.trigger == "calibration" }.count, 1)
        try Data("broken schedule".utf8).write(to: root.appendingPathComponent("checkin-schedule.json"))
        let before = try await store.entries(domain: .checkin)
        await recorder.wake(now: now, calendar: calendar)
        let after = try await store.entries(domain: .checkin)
        XCTAssertEqual(before, after, "Corruption must not silently redraw an existing day")
        let broken = await recorder.status()
        XCTAssertNotNil(broken.error)
    }

    func testLateSaveKeepsOpenedPromptProvenanceAndExpires() async throws {
        let (store, _, recorder, _) = try await fixture()
        await recorder.wake(now: now, calendar: calendar)
        let status = await recorder.status()
        let prompt = try XCTUnwrap(status.state.schedule?.prompts.first)
        try await recorder.save(report(prompt: prompt, time: prompt.expires.addingTimeInterval(1)))
        let entries = try await store.entries(domain: .checkin)
        let saved = try XCTUnwrap(entries.first { $0.kind == "report" })
        XCTAssertEqual(saved.payload.ciString("prompt_id"), prompt.id)
        XCTAssertEqual(saved.payload.ciString("trigger"), "random")
        XCTAssertTrue(entries.contains { $0.payload.ciString("event") == "expired" })
        XCTAssertFalse(entries.contains { $0.payload.ciString("event") == "answered" })
    }

    func testTheCardsStatusReadSchedulesAndWritesNothing() async throws {
        let (store, source, recorder, _) = try await fixture()
        await recorder.wake(now: now, calendar: calendar)
        let scheduled = await source.scheduled.count
        XCTAssertGreaterThan(scheduled, 0)
        let entries = try await store.entries(domain: .checkin)
        let model = CheckInModel(recorder: recorder, healthWake: { nil })
        await model.readStatus()
        let schedule = await recorder.status().state.schedule
        XCTAssertNotNil(model.status.state.schedule)
        XCTAssertEqual(model.status.state.schedule?.prompts, schedule?.prompts)
        let scheduledAfter = await source.scheduled.count
        XCTAssertEqual(scheduledAfter, scheduled, "no notification is scheduled again")
        let after = try await store.entries(domain: .checkin)
        XCTAssertEqual(after, entries, "nothing is written")
    }

    func testReworkIsOncePerEndedBlockBeforeFirstPrework() async throws {
        let (_, _, recorder, _) = try await fixture()
        for id in ["block-a", "block-b"] {
            try await recorder.save(report(.blockBefore, blockID: id))
            try await recorder.save(report(.blockAfter, time: now.addingTimeInterval(60), blockID: id))
        }
        let nextDay = now.addingTimeInterval(86400)
        var status = await recorder.status()
        XCTAssertEqual(status.history.rework(now: nextDay, calendar: calendar).count, 2)
        try await recorder.save(report(.blockRework, time: nextDay, blockID: "block-a"))
        status = await recorder.status()
        XCTAssertEqual(status.history.rework(now: nextDay, calendar: calendar).map { $0.payload.ciString("block_id") }, ["block-b"])
        try await recorder.save(report(.blockRework, time: nextDay, blockID: "block-b"))
        status = await recorder.status()
        XCTAssertTrue(status.history.rework(now: nextDay, calendar: calendar).isEmpty)
    }
}
