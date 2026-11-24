import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct CheckInsPage: View {
    @ObservedObject var model = AppRuntime.shared.checkInModel
    @ObservedObject private var permissions = PhoneNeeds.shared.permissions
    @Environment(\.scenePhase) private var scenePhase
    let leave: (@escaping @MainActor () -> Void) -> Void

    var body: some View {
        SheetPage("Check-ins") {
            SheetPart("Check in now") {
                SettingRow("Right now", line: "How you feel", opens: { open(.moment) })
                    .accessibilityIdentifier("checkin.moment")
                SettingRow("Before work", line: "Ratings, then the three-minute reaction test", separator: false, opens: { open(.ready) })
                    .accessibilityIdentifier("checkin.ready")
            }
            SheetPart("Log") {
                let schedule = model.status.state.schedule
                SettingRow("Reports", value: Words.count(model.status.history.reports.count), problem: model.status.error ?? model.error)
                    .accessibilityIdentifier("checkin.reportCount")
                SettingRow("Tests", value: Words.count(model.status.history.tests.count))
                SettingRow("Prompts", value: Words.count(model.status.history.entries.filter { $0.kind == "prompt" }.count))
                SettingRow("Calibration", value: calibrated ?? "Not started",
                           line: calibrated == nil ? "Starts with your first check-in before work" : nil, separator: schedule != nil)
                if let schedule {
                    SettingRow("Wake time", value: Words.shortDate(schedule.wake) + Words.dot + Words.clock(schedule.wake),
                               line: schedule.wakeSource == "healthkit" ? "From Health" : "The default, with none from Health",
                               separator: false)
                }
            }
        }
        .task { await model.refresh() }
        .onChange(of: permissions.rows) { Task { await model.refresh() } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.refresh() } } }
    }

    private func open(_ destination: CheckInRoute.Destination) {
        leave { AppNavigation.shared.whenClear { AppNavigation.shared.checkInRoute = CheckInRoute(destination: destination) } }
    }

    private var calibrated: String? {
        guard let first = model.status.history.firstPrework else { return nil }
        let calendar = Calendar.current
        let n = calendar.dateComponents([.day], from: calendar.startOfDay(for: first), to: calendar.startOfDay(for: AppClock.now)).day ?? 0
        return n >= 28 ? "Done" : "Day \(n + 1) of 28"
    }
}
