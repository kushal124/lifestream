import Combine
import Foundation
import LifestreamCaptureCore

struct CheckInRoute: Identifiable, Equatable {
    enum Destination { case moment, day, ready, prompt }
    let id = UUID()
    let destination: Destination
    var promptID: String?
}

@MainActor
final class CheckInModel: ObservableObject {
    @Published var status = CheckInStatus()
    @Published var form: CheckInForm = .moment
    @Published var prompt: CheckInPrompt?
    @Published var block: CaptureEntry?
    @Published var session: VigilanceSession?
    @Published var error: String?
    @Published var loaded = false
    private var refreshInProgress = false
    private var refreshWaiters: [CheckedContinuation<Void, Never>] = []
    let recorder: CheckInRecorder
    private let healthWake: @Sendable () async -> Date?

    init(recorder: CheckInRecorder, healthWake: @escaping @Sendable () async -> Date?) {
        self.recorder = recorder; self.healthWake = healthWake
    }
    func refresh(rebuild: Bool = false) async {
        await EnergyLedger.shared.measure(.checkin) { await refreshMeasured(rebuild: rebuild) }
    }

    private func refreshMeasured(rebuild: Bool) async {
        if refreshInProgress {
            await withCheckedContinuation { refreshWaiters.append($0) }
            if rebuild { await refreshMeasured(rebuild: true) }
            return
        }
        refreshInProgress = true
        defer {
            refreshInProgress = false
            let waiters = refreshWaiters; refreshWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
        }
        let current = await recorder.status()
        let needsWake = current.state.prompting
            && (rebuild || current.state.schedule.map { !Calendar.current.isDateInToday($0.day) } ?? true)
        await recorder.wake(healthWake: needsWake ? await healthWake() : nil, rebuild: rebuild)
        status = await recorder.status()
    }
    func readStatus() async {
        await EnergyLedger.shared.measure(.checkin) { status = await recorder.status() }
    }
    func prepare(_ route: CheckInRoute) async {
        loaded = false; session = nil; block = nil; prompt = nil; error = nil
        await recorder.openRow()
        await refresh()
        status = await recorder.status()
        error = status.error
        let now = AppClock.now
        if let id = route.promptID {
            prompt = status.history.prompts.first { $0.id == id }
        } else {
            prompt = activePrompt(ready: route.destination == .ready, now: now)
        }
        if let prompt { await recorder.event(promptID: prompt.id, event: "opened") }
        if prompt?.form == "vigilance" {
            beginTest(trigger: "calibration")
        } else if route.destination == .ready {
            prepareReady()
        } else {
            form = route.destination == .day || prompt?.form == "day" || prompt?.form == "week" ? .day : .moment
        }
        loaded = true
    }
    private func prepareReady() {
        if let block = status.history.runningBlock { self.block = block; form = .blockAfter }
        else if let block = status.history.rework(now: AppClock.now).first { self.block = block; form = .blockRework }
        else if status.history.tests.contains(where: { $0.payload.ciObject["completed"] == .bool(true) && status.history.sameDay($0, AppClock.now) }) {
            form = .blockBefore
        } else { form = .prework }
    }
    func activePrompt(ready: Bool, now: Date) -> CheckInPrompt? {
        guard status.state.prompting else { return nil }
        return status.state.schedule?.prompts.first {
            ($0.form == "vigilance") == ready && $0.form != "week" && $0.scheduledFor <= now && $0.expires > now
                && !status.history.answered($0)
        }
    }
    var wakeSchedule: CheckInSchedule? {
        guard let schedule = status.state.schedule else { return nil }
        return status.state.prompting || Calendar.current.isDateInToday(schedule.day) ? schedule : nil
    }
    func beginTest(trigger: String = "prework") {
        let expired = prompt.map { $0.expires <= AppClock.now } ?? false
        session = VigilanceSession(promptID: expired ? nil : prompt?.id,
            trigger: expired ? "manual" : trigger, wake: wakeSchedule?.wake, wakeSource: wakeSchedule?.wakeSource)
    }
    func save(answers: [String: JSONValue], note: String, opened: Date, uptime: Double, changes: Int) async throws -> Bool {
        let now = AppClock.now, savedForm = form
        let id = form == .blockBefore ? UUID().uuidString.lowercased() : block?.payload.ciString("block_id")
        let trigger = prompt?.trigger ?? (form == .prework ? "prework" : form == .week ? "weekly" : "manual")
        let report = CheckInReport(form: form, openedAt: CaptureTime.rfc3339(opened), answeredAt: CaptureTime.rfc3339(now),
            localZone: TimeZone.current.identifier, responseMS: max(0, (ProcessInfo.processInfo.systemUptime - uptime) * 1000),
            changes: changes, answers: answers, note: note.isEmpty ? nil : note, blockID: id,
            promptID: prompt?.id, trigger: trigger, awakeForSeconds: wakeSchedule.map { now.timeIntervalSince($0.wake) },
            wakeSource: wakeSchedule?.wakeSource)
        try await recorder.save(report)
        await refresh()
        status = await recorder.status(); error = nil
        switch savedForm {
        case .day where Calendar.current.component(.weekday, from: now) == 1
            && !status.history.reports.contains(where: { $0.payload.ciString("form") == "week" && status.history.sameDay($0, now) }):
            form = .week
            prompt = status.state.schedule?.prompts.first { $0.form == "week" && !status.history.answered($0) }
            if let prompt { await recorder.event(promptID: prompt.id, event: "opened") }
            return false
        case .blockRework:
            block = status.history.rework(now: now).first
            form = block == nil ? .prework : .blockRework
            return false
        case .prework: beginTest(); return false
        default: return true
        }
    }
    func saveVigilance(_ record: VigilanceRecord) async -> Bool {
        do {
            try await recorder.saveVigilance(record)
            status = await recorder.status(); error = nil; return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func startBlock() { session = nil; prompt = nil; block = nil; form = .blockBefore }
}
