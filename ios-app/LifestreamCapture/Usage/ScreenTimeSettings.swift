import Cockpit
import Combine
#if SCREEN_TIME
import FamilyControls
import DeviceActivity
#endif
import LifestreamCaptureCore
import SwiftUI
import os

#if SCREEN_TIME
@MainActor
final class ScreenTimeModel: ObservableObject {
    enum Part: Hashable { case totals, monitoring, olderDays }

    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "usage")
    @Published var status = UsageCaptureStatus()
    @Published var busy = false
    @Published private(set) var failures: [Part: String] = [:]
    @Published var monitoring = false
    @Published var selection = FamilyActivitySelection()
    @Published var threshold = 30
    let monitor = UsageMonitorManager()

    func load() async {
        status = await AppRuntime.shared.usageRecorder.snapshot()
        do {
            monitoring = DeviceActivityCenter().activities.contains { $0.rawValue.hasPrefix("usage-") }
            if case .object(let config)? = try monitor.loadConfiguration() {
                if let saved = config["selection"] {
                    selection = try JSONDecoder.lifestream().decode(FamilyActivitySelection.self,
                        from: JSONEncoder.lifestream().encode(saved))
                }
                if case .object(let value)? = config["threshold"], case .integer(let minutes)? = value["minute"],
                   (5...240).contains(minutes) { threshold = Int(minutes) }
            }
            if case .object(let diagnostic)? = try monitor.loadDiagnostic(),
               case .string(let message)? = diagnostic["error"] {
                Self.log.error("A monitoring mark was not saved: \(message, privacy: .public)")
                failures[.monitoring] = "Lifestream couldn't save a mark. Press Update monitoring to try again."
            }
        } catch {
            Self.log.error("Monitoring's settings did not read: \(String(describing: error), privacy: .public)")
            failures[.monitoring] = "Lifestream couldn't read the apps you chose. Choose them again."
        }
    }

    func perform(_ part: Part, failure: String, _ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        failures[part] = nil
        Task {
            do {
                try await operation()
            } catch {
                Self.log.error("A Screen Time act failed: \(String(describing: error), privacy: .public)")
                failures[part] = failure
            }
            await load()
            busy = false
        }
    }
}

struct ScreenTimeSettings: View {
    @StateObject private var model = ScreenTimeModel()
    @ObservedObject private var permissions = PhoneNeeds.shared.permissions
    @State private var confirmTotals = false
    @State private var chooseApps = false
    @State private var backfillStart = Calendar.current.date(byAdding: .day, value: -30, to: AppClock.now)!
    @State private var backfillEnd = AppClock.now
    @State private var wheelOpen: Bool?

    private var readsTotals: Bool { model.status.authorization == .approvedWithDataAccess }
    private var chosen: Int {
        model.selection.applicationTokens.count + model.selection.categoryTokens.count + model.selection.webDomainTokens.count
    }

    var body: some View {
        Group {
            totals
            monitoring
            olderDays
            UsageMarkersCard()
        }
        .disabled(model.busy)
        .task { await model.load() }
        .onChange(of: permissions.rows) { Task { await model.load() } }
        .familyActivityPicker(isPresented: $chooseApps, selection: $model.selection)
        .confirmationDialog(PhoneSource.screenTime.confirmation?.title ?? "", isPresented: $confirmTotals, titleVisibility: .visible) {
            Button("Allow") {
                model.perform(.totals, failure: "Screen Time wasn't allowed. Press Allow reading totals to ask again.") {
                    try await AppRuntime.shared.usageRecorder.requestAuthorization()
                }
            }
            Button("Not now", role: .cancel) {}
        } message: {
            Text(PhoneSource.screenTime.confirmation?.message ?? "")
        }
    }

    @ViewBuilder private func failure(_ part: ScreenTimeModel.Part, identifier: String) -> some View {
        if let words = model.failures[part] {
            SettingRow(words, lead: .signal(.warning))
                .accessibilityIdentifier(identifier)
        }
    }

    private var totals: some View {
        let allows = allowsTotals
        let acts = readsTotals || allows
        return SheetPart("Daily totals", note: totalsNote) {
            failure(.totals, identifier: "usage.totals.error")
            SettingRow("Last read", value: model.status.lastCompleted.map { Words.ago($0) } ?? "Never",
                       line: model.status.lastSourceUpdate.map { "Apple last updated " + Words.shortDate($0) },
                       problem: model.status.error ?? model.status.catalogError, separator: acts)
                .accessibilityIdentifier("usage.error")
            if readsTotals {
                Self.act("Refresh", busy: model.busy || model.status.isRefreshing, separator: allows) {
                    model.perform(.totals, failure: "Lifestream couldn't read the totals. Press Refresh to try again.") {
                        _ = await AppRuntime.shared.usageRecorder.refresh(.manual)
                    }
                }
                .accessibilityIdentifier("usage.refresh")
            }
            if allows {
                Self.act("Allow reading totals", separator: false) { confirmTotals = true }
            }
        }
    }

    private var totalsNote: String {
        var words = [String]()
        if #available(iOS 26.4, *) {
            if model.status.authorization == .approved { words.append("Allowed for monitoring only. Reading the totals needs wider access.") }
        } else {
            words.append("Reading the totals needs iOS 26.4 or later.")
        }
        if model.status.catalogPending { words.append("The list of apps is still being read. The totals refresh without it.") }
        words.append("Open Lifestream once a day so it can catch up. A day Apple has not given is never counted as zero.")
        return words.joined(separator: " ")
    }

    private var monitoring: some View {
        let starts = chosen > 0, stops = model.monitoring
        return SheetPart("Monitoring", line: "A mark when the apps you choose reach this much use in a day.",
                         note: "Apple marks roughly when the use is reached, not the moment an app opened.") {
            failure(.monitoring, identifier: "usage.monitor.error")
            SettingRow("Apps", opens: { chooseApps = true }) { SettingValue(chosen == 0 ? "None" : Words.count(chosen)) }
                .accessibilityIdentifier("usage.monitor.choose")
            SettingRow("Mark after", separator: starts || stops) {
                ValueStepper("Mark after", value: $model.threshold, steps: Array(stride(from: 5, through: 240, by: 5)),
                             less: "Sooner", more: "Later") { Words.duration(TimeInterval($0 * 60)) }
                    .accessibilityIdentifier("usage.monitor.threshold")
            }
            if starts {
                let act = stops ? "Update monitoring" : "Start monitoring"
                Self.act(act, separator: stops) {
                    model.perform(.monitoring, failure: "Lifestream couldn't start monitoring. Press \(act) to try again.") {
                        try await AppRuntime.shared.launched()
                        try model.monitor.start(selection: model.selection, thresholdMinutes: model.threshold)
                    }
                }
                .accessibilityIdentifier("usage.monitor.start")
            }
            if stops {
                Self.act("Stop monitoring", warns: true, separator: false) {
                    model.perform(.monitoring, failure: "Lifestream couldn't stop monitoring. Press Stop monitoring to try again.") {
                        try model.monitor.stop()
                    }
                }
            }
        }
    }

    private var allowsTotals: Bool {
        if #available(iOS 26.4, *) { return model.status.authorization == .approved }
        return false
    }

    private static func act(_ title: String, warns: Bool = false, busy: Bool = false, separator: Bool = true,
                            perform: @escaping () -> Void) -> some View {
        ListRow(title, separator: separator, action: busy ? nil : perform) {
            if busy { Spinner() }
        }
        .environment(\.cockpitRowActs, !warns)
        .environment(\.cockpitRowWarns, warns)
    }

    private func wheel(_ from: Bool) -> Binding<Bool> {
        Binding(get: { wheelOpen == from }, set: { wheelOpen = $0 ? from : nil })
    }

    private var earliest: Date { model.status.earliest ?? .distantPast }

    private var years: ClosedRange<Int>? {
        model.status.earliest.map { Calendar.current.component(.year, from: $0)...Calendar.current.component(.year, from: AppClock.now) }
    }

    private static func day(_ date: Binding<Date>, from earliest: Date) -> Binding<DateRow.Day?> {
        let calendar = Calendar.current
        return Binding(get: {
            let parts = calendar.dateComponents([.year, .month, .day], from: max(date.wrappedValue, earliest))
            return DateRow.Day(month: parts.month ?? 1, day: parts.day ?? 1, year: parts.year)
        }, set: { day in
            guard let day, let year = day.year,
                  let picked = calendar.date(from: DateComponents(year: year, month: day.month, day: day.day)) else { return }
            date.wrappedValue = max(min(picked, AppClock.now), earliest)
        })
    }

    private var olderDays: some View {
        let next = model.status.backfillNext
        let reading = next != nil
        let acts = readsTotals || reading
        return SheetPart("Older days", line: "Apple's totals for days before now, a day at a time.",
                         note: "Each read takes up to three days.") {
            failure(.olderDays, identifier: "usage.backfill.error")
            DateRow("From", day: Self.day($backfillStart, from: earliest), empty: "", open: wheel(true), years: years,
                    clear: nil, yearAlways: true)
            DateRow("Through", day: Self.day($backfillEnd, from: earliest), empty: "", open: wheel(false), years: years,
                    clear: nil, yearAlways: true, separator: reading || acts)
            if let next {
                SettingRow("Next day to read", value: Words.shortDate(next, zone: TimeZone.current), separator: acts)
            }
            if readsTotals {
                Self.act("Read these days", separator: reading) {
                    model.perform(.olderDays, failure: "Lifestream couldn't start reading these days. Press Read these days to try again.") {
                        try await AppRuntime.shared.usageRecorder.beginBackfill(
                            from: max(backfillStart, earliest), through: max(backfillEnd, earliest))
                        _ = await AppRuntime.shared.usageRecorder.refresh(.backfill)
                    }
                }
            }
            if reading {
                Self.act("Read on") {
                    model.perform(.olderDays, failure: "Lifestream couldn't read on. Press Read on to try again.") {
                        _ = await AppRuntime.shared.usageRecorder.refresh(.backfill)
                    }
                }
                Self.act("Stop reading", warns: true, separator: false) {
                    model.perform(.olderDays, failure: "Lifestream couldn't stop reading. Press Stop reading to try again.") {
                        try await AppRuntime.shared.usageRecorder.stopBackfill()
                    }
                }
            }
        }
    }
}
#else
struct ScreenTimeSettings: View {
    var body: some View {
        UsageMarkersCard()
    }
}
#endif

private struct UsageMarkersCard: View {
    var body: some View {
        SheetPart("Markers from Shortcuts", line: "When an app opens and closes, marked by an automation you make in Shortcuts.") {
            SettingRow("Make the automation", separator: false) {
                EmptyView()
            } held: {
                VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                    Text("In Shortcuts, create an App automation for one app. Select Is Opened and Run Immediately. Add Record app activity, enter that app's label, and choose Opened. Repeat with Is Closed and Closed.")
                    Text("Use one automation for each app, so the label names what opened. A marker is close to when an app opened or closed, not exact.")
                }
                .cockpit(Cockpit.Style.iosFootnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
