import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct StatusView: View {
    @EnvironmentObject private var model: CaptureAppModel
    @ObservedObject private var permissions = PhoneNeeds.shared.permissions
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openConnectors) private var open
    @Environment(\.openURL) private var openURL

    var body: some View {
        SheetPage("Status") {
            SheetPart(nil) {
                SettingRow("Recorder", problem: unsaved, line: state, separator: false) {
                    if model.coverageState == .authorizationBlocked {
                        Button("Open Settings") {
                            if let settings = URL(string: UIApplication.openSettingsURLString) { openURL(settings) }
                        }
                        .buttonStyle(.cockpit(.primary, size: .small))
                        .accessibilityIdentifier("status.settings")
                    } else if model.serviceRequested != true {
                        Button("Start recording") { model.startCapture() }
                            .buttonStyle(.cockpit(.primary, size: .small, busy: model.startingCapture.running))
                            .accessibilityIdentifier("status.retry-capture-start")
                    }
                }
                .accessibilityIdentifier("status.operational-state")
                .actOutcome(model.startingCapture, identifier: "status.start-failed") { model.startCapture() }
            }
            SheetPart("Permissions", note: model.backgroundRefresh == "Available" ? nil
                      : "Location still wakes the app through iOS's own paths, but Health and Motion may be read less often.") {
                SettingRow("Location", value: model.coverageState == .authorizationBlocked ? "Not allowed" : "Allowed")
                    .accessibilityIdentifier("status.location")
                SettingRow("Health", value: Self.health(permissions))
                    .accessibilityIdentifier("status.health-authorization")
                SettingRow("Background App Refresh", value: Self.refresh(model.backgroundRefresh),
                           state: model.backgroundRefresh == "Available" ? nil : .caution, separator: false)
                    .accessibilityIdentifier("status.background-refresh")
            }
            if model.livenessSamples.contains(where: { $0 > 0 }) {
                SheetPart("Activity", line: "Recorder events per hour over the last 24 hours.") {
                    CardRow(separator: false) {
                        LivenessSparkline(values: model.livenessSamples)
                            .frame(height: Cockpit.Space.s12)
                            .accessibilityIdentifier("status.liveness-sparkline")
                    }
                }
            }
            SheetPart(nil) {
                SettingRow("Details", line: "What the recorder was asked, the last location, battery and today's counts",
                           separator: false, opens: { open(.statusDetails) })
                    .accessibilityIdentifier("status.details")
            }
        }
        .refreshable { await model.refresh() }
        .repeatWhileActive(every: .seconds(30)) { await model.refresh() }
    }

    private var state: String {
        let now = Self.now(model.recorderOperationalState)
        let off = ["off", "not_started"].contains(model.recorderOperationalState)
        switch model.coverageState {
        case .authorizationBlocked, .locationUnavailable, .accuracyDegraded:
            return off ? Self.delivery(model.coverageState) : "\(now) · \(Self.delivery(model.coverageState))"
        default:
            return now
        }
    }

    private var unsaved: String? {
        model.runtime.locationRecorder.persistenceDiagnostic.map {
            $0.replacingOccurrences(of: "Persistence failure: ", with: "Could not save: ")
        }
    }


    static func asked(_ requested: Bool?) -> String {
        switch requested {
        case true: "Yes"
        case false: "No"
        case nil: "Not known: the phone could not save it"
        }
    }

    static func now(_ state: String) -> String {
        switch state {
        case "recording": "Recording"
        case "sleeping": "Still, checking now and then"
        case "wakeup": "Checking whether you moved"
        case "off", "not_started": "Location off"
        case "battery_saving": "Battery saving: visits and moves of a few hundred metres"
        default: state.replacingOccurrences(of: "_", with: " ").capitalizingFirst
        }
    }

    static func delivery(_ state: CoverageState) -> String {
        switch state {
        case .highRateExpected: "Fixes arriving as you move"
        case .stationaryAutoPaused: "Still; iOS paused location, so quiet is expected"
        case .coarseFallbackOnly: "Only rough wake-ups, no precise fixes"
        case .accuracyDegraded: "Precise location is off; fixes are approximate"
        case .authorizationBlocked: "Location isn't allowed"
        case .locationUnavailable: "iOS cannot find the phone right now"
        case .processAbsence: "The app was stopped for a while; expect a gap"
        case .deviceOffOrPreunlock: "The phone was off or not yet unlocked; expect a gap"
        case .unknown: "Asked to record; nothing has arrived yet"
        }
    }

    private static func health(_ permissions: PermissionsModel) -> String {
        guard permissions.read else { return SignalMark.checking.word }
        return permissions.mark(of: "health")?.word ?? "Not on this phone"
    }

    private static func refresh(_ status: String) -> String {
        switch status {
        case "Available": "On"
        case "Denied in Settings": "Off in Settings"
        case "Restricted": "Not allowed on this phone"
        case "Unknown": "Not known"
        default: status
        }
    }
}

struct StatusDetails: View {
    @EnvironmentObject private var model: CaptureAppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SheetPage("Details") {
            SheetPart(nil) {
                SettingRow("Asked to record", value: StatusView.asked(model.serviceRequested))
                    .accessibilityIdentifier("status.service-requested")
                SettingRow("Location", value: model.runtime.locationRecorder.persistenceDiagnostic == nil ? StatusView.delivery(model.coverageState) : "Not saving what it records")
                    .accessibilityIdentifier("status.platform-evidence")
                TimelineView(.animation(minimumInterval: 30, paused: scenePhase != .active)) { _ in
                    SettingRow("Last location", value: model.lastFixAge(at: AppClock.now))
                        .accessibilityIdentifier("status.last-fix-age")
                }
                let battery = model.wholeDeviceBatteryChangePercent.map { String(format: "%.1f\u{00A0}%%", $0) }
                SettingRow("Battery use", value: battery ?? "Not known yet")
                    .accessibilityIdentifier("status.battery")
                SettingRow("Locations today", value: Words.count(model.locationCountToday))
                SettingRow("Motion today", value: Words.count(model.motionCountToday))
                SettingRow("Health today", value: Words.count(model.healthCountToday))
                SettingRow("Photos today", value: Words.count(model.cameraCountToday + model.photosCountToday))
                SettingRow("Voice notes today", value: Words.count(model.voiceCountToday), separator: false)
                    .accessibilityIdentifier("status.voice-count")
            }
        }
        .repeatWhileActive(every: .seconds(30)) { await model.refresh() }
    }
}

private extension String {
    var capitalizingFirst: String { prefix(1).uppercased() + dropFirst() }
}

struct LivenessSparkline: View {
    let values: [Double]

    var body: some View {
        GeometryReader { geometry in
            Path { path in
                guard !values.isEmpty else { return }
                for (index, value) in values.enumerated() {
                    let x = geometry.size.width * Double(index) / Double(max(1, values.count - 1))
                    let y = geometry.size.height * (1 - value)
                    index == 0
                        ? path.move(to: .init(x: x, y: y)) : path.addLine(to: .init(x: x, y: y))
                }
            }
            .stroke(Cockpit.Color.data2, style: StrokeStyle(lineWidth: Cockpit.Stroke.line, lineCap: .round, lineJoin: .round))
        }
        .accessibilityLabel("Recorder events per hour, last 24 hours")
    }
}
