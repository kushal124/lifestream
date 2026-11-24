import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct ThisPhoneSheet: View {
    @EnvironmentObject private var model: CaptureAppModel
    @Environment(\.openConnectors) private var open
    @Environment(\.openURL) private var openURL

    var body: some View {
        SheetFrame("This iPhone", icon: .phoneScreen, line: recorder.word) {
            SheetPart(nil) {
                SettingRow("Status", line: "The recorder, its permissions and today's counts", separator: Self.experiments,
                           opens: { open(.status) })
                    .accessibilityIdentifier("machinery.status")
                    .onAppear { if AppRuntime.asked("--ui-test-status") { open(.status) } }
                #if !APP_STORE
                SettingRow("Experiments", line: "Markers and tests for this build", separator: false,
                           opens: { open(.experiments) })
                    .accessibilityIdentifier("machinery.experiments")
                #endif
            }
            SheetPart("About") {
                SettingRow("Version", value: Self.build)
                OutRow("Privacy policy", separator: false) { openURL(Privacy.policy) }
                    .accessibilityIdentifier("machinery.privacy")
            }
        }
    }

    #if APP_STORE
    private static let experiments = false
    #else
    private static let experiments = true
    #endif

    private var recorder: SignalMark { Self.recorder(model.serviceRequested) }

    static func recorder(_ requested: Bool?) -> SignalMark {
        switch requested {
        case true: SignalMark(kind: .engaged, word: "Recording")
        case false: SignalMark(kind: .idle, word: "Location off")
        case nil: SignalMark(kind: .warning, word: "Location broken")
        }
    }

    static let build: String = {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let number = info["CFBundleVersion"] as? String ?? "?"
        let commit = (info["LifestreamCommit"] as? String).flatMap { $0.isEmpty || $0 == "unknown" ? nil : $0 }
        return "\(version) (\(number))" + (commit.map { Words.dot + $0 } ?? "")
    }()
}
