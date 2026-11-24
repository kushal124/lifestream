import Foundation
import LifestreamCaptureCore

struct CheckInHistory: Sendable {
    var entries: [CaptureEntry] = []
    var reports: [CaptureEntry] { entries.filter { $0.kind == "report" } }
    var tests: [CaptureEntry] { entries.filter { $0.kind == "vigilance" } }
    var firstPrework: Date? {
        reports.first { $0.payload.ciString("form") == "prework" }.flatMap { CaptureTime.date(rfc3339: $0.observedAt) }
    }
    var prompts: [CheckInPrompt] {
        entries.filter { $0.kind == "prompt" && $0.payload.ciString("event") == "scheduled" }.compactMap {
            guard let id = $0.payload.ciString("prompt_id"), let form = $0.payload.ciString("form"),
                  let trigger = $0.payload.ciString("trigger"), let time = $0.payload.ciString("scheduled_for"),
                  let date = CaptureTime.date(rfc3339: time) else { return nil }
            return .init(id: id, form: form, trigger: trigger, scheduledFor: date)
        }
    }
    func hasEvent(_ event: String, _ id: String) -> Bool {
        entries.contains { $0.kind == "prompt" && $0.payload.ciString("prompt_id") == id && $0.payload.ciString("event") == event }
    }
    func answered(_ prompt: CheckInPrompt) -> Bool { hasEvent("answered", prompt.id) }
    var runningBlock: CaptureEntry? {
        reports.last { entry in
            entry.payload.ciString("form") == "block_before" && !reports.contains {
                $0.payload.ciString("form") == "block_after" && $0.payload.ciString("block_id") == entry.payload.ciString("block_id")
            }
        }
    }
    func rework(now: Date, calendar: Calendar = .current) -> [CaptureEntry] {
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now)!
        guard !reports.contains(where: { $0.payload.ciString("form") == "prework" && sameDay($0, now, calendar) }) else { return [] }
        return reports.filter { entry in
            let id = entry.payload.ciString("block_id")
            return entry.payload.ciString("form") == "block_before" && sameDay(entry, yesterday, calendar)
                && reports.contains { $0.payload.ciString("block_id") == id && $0.payload.ciString("form") == "block_after" }
                && !reports.contains { $0.payload.ciString("block_id") == id && $0.payload.ciString("form") == "block_rework" }
        }
    }
    func sameDay(_ entry: CaptureEntry, _ date: Date, _ calendar: Calendar = .current) -> Bool {
        CaptureTime.date(rfc3339: entry.observedAt).map { calendar.isDate($0, inSameDayAs: date) } ?? false
    }
}

struct CheckInStatus: Sendable {
    var authorization = "not_determined"
    var state = CheckInScheduleState()
    var history = CheckInHistory()
    var error: String?
}

actor CheckInRecorder {
    private let store: CaptureStore
    private let notifications: any CheckInNotificationSource
    private let stateURL: URL
    private let beforeCapture: @Sendable () async throws -> Void
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var lastError: String?

    init(store: CaptureStore, notifications: any CheckInNotificationSource, stateURL: URL,
         beforeCapture: @escaping @Sendable () async throws -> Void = {}) {
        self.store = store; self.notifications = notifications; self.stateURL = stateURL
        self.beforeCapture = beforeCapture
    }
    private func lock() async {
        if busy { await withCheckedContinuation { waiters.append($0) } } else { busy = true }
    }
    private func unlock() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }
    private var known = CheckInHistory()
    private var knownThrough: UInt64 = 0
    private func history() async throws -> CheckInHistory {
        let added = try await store.foldEntries(domain: .checkin, afterSequence: knownThrough, initial: [CaptureEntry]()) {
            $0.append($1)
        }
        known.entries += added
        knownThrough = added.last?.sequence ?? knownThrough
        return known
    }
    private func state() throws -> CheckInScheduleState {
        guard let data = try FileDurability.readRegularFileIfPresent(at: stateURL, maximumBytes: 131_072) else {
            return CheckInScheduleState()
        }
        return try JSONDecoder.lifestream().decode(CheckInScheduleState.self, from: data)
    }
    private func persist(_ value: CheckInScheduleState) throws {
        try JSONEncoder.lifestream().encode(value).write(to: stateURL,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func status() async -> CheckInStatus {
        await lock(); defer { unlock() }
        var result = CheckInStatus(authorization: await notifications.authorization(), error: lastError)
        do { result.history = try await history() }
        catch { result.error = error.localizedDescription }
        do { result.state = try state() }
        catch { result.error = error.localizedDescription }
        return result
    }

    func openRow(now: Date = AppClock.now) async {
        await lock(); defer { unlock() }
        do {
            try await beforeCapture()
            try await recordAccess(now)
            if try state().prompting, await notifications.authorization() == "not_determined" {
                try await notifications.requestAuthorization()
                try await recordAccess(AppClock.now)
            }
            lastError = nil
        } catch { lastError = error.localizedDescription }
    }

    func wake(now: Date = AppClock.now, healthWake: Date? = nil, calendar: Calendar = .current, rebuild: Bool = false) async {
        await lock(); defer { unlock() }
        do {
            try await beforeCapture()
            try await recordAccess(now)
            var state: CheckInScheduleState
            do { state = try self.state() }
            catch {
                guard rebuild else { throw error }
                state = CheckInScheduleState()
            }
            var history = try await history()
            let prompting = state.prompting
            if !prompting {
                await notifications.cancel((state.schedule?.prompts ?? []).flatMap(\.notificationIDs))
            }
            if prompting, !rebuild, state.schedule == nil, history.prompts.contains(where: { calendar.isDate($0.scheduledFor, inSameDayAs: now) }) {
                throw CaptureError.corruptState("Today's schedule could not be read. Turn Ask through the day off and on again to make a new one.")
            }
            if prompting, rebuild || (calendar.component(.hour, from: now) >= 4 &&
                (state.schedule == nil || !calendar.isDate(state.schedule!.day, inSameDayAs: now))) {
                let oldPrompts = rebuild ? history.prompts + (state.schedule?.prompts ?? []) : state.schedule?.prompts ?? []
                await notifications.cancel(oldPrompts.flatMap(\.notificationIDs))
                state.schedule = .build(now: now, healthWake: healthWake, bedtimeMinutes: state.bedtimeMinutes,
                    firstPrework: history.firstPrework, seed: UInt64.random(in: .min ... .max), calendar: calendar)
                try persist(state)
            }
            if prompting, var schedule = state.schedule, calendar.isDate(schedule.day, inSameDayAs: now),
               let first = history.firstPrework, !schedule.prompts.contains(where: { $0.trigger == "calibration" }) {
                let plan = CheckInSchedule.build(now: now, healthWake: schedule.wakeSource == "healthkit" ? schedule.wake : nil,
                    bedtimeMinutes: state.bedtimeMinutes, firstPrework: first, seed: schedule.seed, calendar: calendar)
                if let calibration = plan.prompts.first(where: { $0.trigger == "calibration" && $0.scheduledFor > now }) {
                    schedule.prompts.append(calibration); state.schedule = schedule; try persist(state)
                }
            }
            let scheduling = prompting ? state.schedule?.prompts ?? [] : []
            for prompt in scheduling {
                if !history.hasEvent("scheduled", prompt.id) {
                    try await appendEvent(prompt, "scheduled", now)
                }
            }
            history = try await self.history()
            for (id, date) in await notifications.delivered() {
                if let prompt = history.prompts.first(where: { $0.id == id }), !history.hasEvent("delivered", id) {
                    try await appendEvent(prompt, "delivered", date)
                }
            }
            for prompt in history.prompts where !history.answered(prompt) && prompt.expires <= now {
                if !history.hasEvent("expired", prompt.id) { try await appendEvent(prompt, "expired", prompt.expires) }
                await notifications.cancel(prompt.notificationIDs)
            }
            for prompt in scheduling where prompt.expires > now && !history.answered(prompt) {
                try await notifications.schedule(prompt, now: now)
            }
            if let block = history.runningBlock, let start = CaptureTime.date(rfc3339: block.observedAt),
               now.timeIntervalSince(start) >= CheckInScheduleRules.workBlockLimitSeconds {
                let end = start.addingTimeInterval(CheckInScheduleRules.workBlockLimitSeconds)
                let report = CheckInReport(form: .blockAfter, openedAt: CaptureTime.rfc3339(end),
                    answeredAt: CaptureTime.rfc3339(end), localZone: calendar.timeZone.identifier,
                    responseMS: 0, changes: 0, answers: [:], blockID: block.payload.ciString("block_id"),
                    awakeForSeconds: block.payload.ciObject["awake_for_s"]?.ciNumber.map { $0 + CheckInScheduleRules.workBlockLimitSeconds },
                    wakeSource: block.payload.ciString("wake_source"), endedBy: "timeout")
                _ = try await store.appendBatch(domain: .checkin, drafts: [.init(kind: "report", observedAt: report.answeredAt, payload: report.payload)])
            }
            lastError = nil
        } catch { lastError = error.localizedDescription }
    }

    private func recordAccess(_ now: Date) async throws {
        let authorization = await notifications.authorization()
        let history = try await history()
        if history.entries.last(where: { $0.kind == "access" })?.payload.ciString("notifications") != authorization {
            _ = try await store.appendBatch(domain: .checkin, drafts: [.init(kind: "access", observedAt: CaptureTime.rfc3339(now),
                payload: .object(["notifications": .string(authorization)]))])
        }
    }
    private func appendEvent(_ prompt: CheckInPrompt, _ event: String, _ now: Date) async throws {
        _ = try await store.appendBatch(domain: .checkin, drafts: [.init(kind: "prompt", observedAt: CaptureTime.rfc3339(now), payload: prompt.payload(event: event))])
    }
    func event(promptID: String, event: String, at now: Date = AppClock.now) async {
        await lock(); defer { unlock() }
        do {
            try await beforeCapture()
            let history = try await history()
            guard let prompt = history.prompts.first(where: { $0.id == promptID }) else { return }
            if !history.hasEvent(event, promptID) { try await appendEvent(prompt, event, now) }
            if now >= prompt.expires && !history.answered(prompt) && !history.hasEvent("expired", promptID) {
                try await appendEvent(prompt, "expired", prompt.expires)
            }
        } catch { lastError = error.localizedDescription }
    }

    func cancel() {}

    func save(_ report: CheckInReport) async throws {
        await lock(); defer { unlock() }
        do {
            try await beforeCapture()
            guard report.firstMissing == nil else { throw CaptureError.corruptState("Pick one to save") }
            let history = try await history()
            if report.form == .blockBefore && history.runningBlock != nil {
                throw CaptureError.corruptState("Stop the running block first")
            }
            if report.form == .blockAfter, history.runningBlock?.payload.ciString("block_id") != report.blockID {
                throw CaptureError.corruptState("This block has already ended")
            }
            var payload = report.payload.ciObject
            let now = CaptureTime.date(rfc3339: report.answeredAt) ?? AppClock.now
            let prompt = history.prompts.first { $0.id == report.promptID }
            var drafts: [CaptureDraft] = []
            if let prompt {
                let opened = CaptureTime.date(rfc3339: report.openedAt) ?? now
                if opened >= prompt.expires || history.answered(prompt) {
                    payload["prompt_id"] = .null; payload["trigger"] = .string("manual")
                }
                if now >= prompt.expires && !history.answered(prompt) {
                    if !history.hasEvent("expired", prompt.id) {
                        drafts.append(.init(kind: "prompt", observedAt: CaptureTime.rfc3339(prompt.expires), payload: prompt.payload(event: "expired")))
                    }
                } else if !history.answered(prompt) {
                    drafts.append(.init(kind: "prompt", observedAt: report.answeredAt, payload: prompt.payload(event: "answered")))
                }
            }
            drafts.insert(.init(kind: "report", observedAt: report.answeredAt, payload: .object(payload)), at: 0)
            _ = try await store.appendBatch(domain: .checkin, drafts: drafts)
            if let prompt { await notifications.cancel(prompt.notificationIDs) }
            lastError = nil
        } catch { lastError = error.localizedDescription; throw error }
    }

    func saveVigilance(_ session: VigilanceRecord) async throws {
        await lock(); defer { unlock() }
        do {
            try await beforeCapture()
            let history = try await history()
            guard !history.tests.contains(where: { $0.payload.ciString("started_at") == session.startedAt }) else { return }
            let number = history.tests.filter { $0.payload.ciObject["completed"] == .bool(true) }.count + (session.completed ? 1 : 0)
            var payload = session.payload(sessionNumber: number).ciObject
            var drafts: [CaptureDraft] = []
            if let prompt = history.prompts.first(where: { $0.id == session.promptID }) {
                let opened = CaptureTime.date(rfc3339: session.startedAt) ?? AppClock.now
                if opened >= prompt.expires || history.answered(prompt) {
                    payload["prompt_id"] = .null; payload["trigger"] = .string("manual")
                }
                let ended = CaptureTime.date(rfc3339: session.endedAt) ?? opened
                if ended >= prompt.expires && !history.answered(prompt) {
                    if !history.hasEvent("expired", prompt.id) {
                        drafts.append(.init(kind: "prompt", observedAt: CaptureTime.rfc3339(prompt.expires), payload: prompt.payload(event: "expired")))
                    }
                } else if session.completed && !history.answered(prompt) {
                    drafts.append(.init(kind: "prompt", observedAt: session.endedAt, payload: prompt.payload(event: "answered")))
                }
            }
            drafts.insert(.init(kind: "vigilance", observedAt: session.startedAt, payload: .object(payload)), at: 0)
            _ = try await store.appendBatch(domain: .checkin, drafts: drafts)
            if session.completed, let prompt = history.prompts.first(where: { $0.id == session.promptID }) {
                await notifications.cancel(prompt.notificationIDs)
            }
            lastError = nil
        } catch { lastError = error.localizedDescription; throw error }
    }

    func setPrompts(on: Bool) async throws {
        await lock(); defer { unlock() }
        var state = (try? state()) ?? CheckInScheduleState()
        state.promptsOn = on; try persist(state)
        if !on { await notifications.cancel((state.schedule?.prompts ?? []).flatMap(\.notificationIDs)) }
    }

    func setBedtime(minutes: Int) async throws {
        await lock(); defer { unlock() }
        guard (0..<1440).contains(minutes) else { return }
        var state = try state(); state.bedtimeMinutes = minutes; try persist(state)
    }
}

extension JSONValue {
    var ciObject: [String: JSONValue] { if case .object(let value) = self { value } else { [:] } }
    var ciArray: [JSONValue] { if case .array(let value) = self { value } else { [] } }
    func ciString(_ key: String) -> String? { if case .string(let value) = ciObject[key] { value } else { nil } }
    var ciNumber: Double? {
        switch self { case .number(let n): n; case .integer(let n): Double(n); case .unsigned(let n): Double(n); default: nil }
    }
}
