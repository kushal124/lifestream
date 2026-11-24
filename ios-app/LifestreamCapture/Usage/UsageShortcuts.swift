import AppIntents
import Foundation
import LifestreamCaptureCore

enum UsageMarkerEvent: String, AppEnum {
    case opened, closed
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "App event" }
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
        [.opened: "Opened", .closed: "Closed"]
    }
}

struct RecordAppActivity: AppIntent {
    static var title: LocalizedStringResource { "Record app activity" }
    static var description: IntentDescription {
        "Save an app-open or app-close marker from a personal automation. Configure a separate label for each app."
    }
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "App label") var appLabel: String
    @Parameter(title: "Event") var event: UsageMarkerEvent

    static var parameterSummary: some ParameterSummary {
        Summary("Record \(\.$appLabel) \(\.$event)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let createdAt = AppClock.now
        let runtime = AppRuntime.shared
        try await runtime.launched()
        try await runtime.usageRecorder.recordMarker(label: appLabel, event: event.rawValue, createdAt: createdAt)
        return .result()
    }
}
