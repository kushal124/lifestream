import Foundation
import LifestreamCaptureCore

struct CheckInPrompt: Codable, Sendable, Identifiable, Equatable {
    let id: String
    let form: String
    let trigger: String
    let scheduledFor: Date
    var expires: Date { scheduledFor.addingTimeInterval(CheckInScheduleRules.expirySeconds) }
    var reminder: Date { scheduledFor.addingTimeInterval(CheckInScheduleRules.reminderSeconds) }
    var notificationIDs: [String] { ["checkin.\(id)", "checkin.\(id).reminder"] }
    func payload(event: String) -> JSONValue {
        .object(["prompt_id": .string(id), "form": .string(form), "trigger": .string(trigger),
                 "scheduled_for": .string(CaptureTime.rfc3339(scheduledFor)),
                 "window_start": .string(CaptureTime.rfc3339(scheduledFor)),
                 "window_end": .string(CaptureTime.rfc3339(expires)), "event": .string(event)])
    }
}

struct CheckInSchedule: Codable, Sendable {
    let day: Date
    let zone: String
    let wake: Date
    let wakeSource: String
    let seed: UInt64
    let draws: [Double]
    var prompts: [CheckInPrompt]

    static func build(now: Date, healthWake: Date?, bedtimeMinutes: Int, firstPrework: Date?,
                      seed: UInt64, calendar: Calendar = .current) -> Self {
        let day = calendar.startOfDay(for: now)
        func instant(_ minutes: Int) -> Date {
            calendar.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: day)!
        }
        let calibrationDay = firstPrework.map {
            calendar.dateComponents([.day], from: calendar.startOfDay(for: $0), to: day).day ?? 0
        }
        let plan = CheckInScheduleRules.build(now: now.timeIntervalSince1970,
            defaultWake: instant(480).timeIntervalSince1970, healthWake: healthWake?.timeIntervalSince1970,
            bedtime: instant(bedtimeMinutes).timeIntervalSince1970,
            afternoon: instant(900).timeIntervalSince1970, weekday: calendar.component(.weekday, from: day),
            calibrationDay: calibrationDay, seed: seed)
        return Self(day: day, zone: calendar.timeZone.identifier, wake: Date(timeIntervalSince1970: plan.wake),
            wakeSource: plan.wakeSource, seed: seed, draws: plan.draws,
            prompts: plan.prompts.map { .init(id: UUID().uuidString.lowercased(), form: $0.form, trigger: $0.trigger,
                                            scheduledFor: Date(timeIntervalSince1970: $0.time)) })
    }
}

struct CheckInScheduleState: Codable, Sendable {
    var bedtimeMinutes = 23 * 60 + 30
    var schedule: CheckInSchedule?
    var promptsOn: Bool?
    var prompting: Bool { promptsOn == true }
}
