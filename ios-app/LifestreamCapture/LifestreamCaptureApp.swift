import Cockpit
import HomeLink
import SwiftUI
import LifestreamCaptureCore
import UserNotifications

@main
struct LifestreamCaptureApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = CaptureAppModel(runtime: .shared)
    @StateObject private var notes = AppRuntime.shared.notes
    @Environment(\.scenePhase) private var scenePhase
    @State private var away = false
    #if DEBUG
    @State private var notificationsAsked = false
    private static let systemNotificationTest = AppRuntime.isUITesting
        && ProcessInfo.processInfo.arguments.contains("--ui-test-system-notification")
    #endif

    init() {
        if StorageProbe.launch(root: AppRuntime.supportRoot) == .locked { exit(0) }
    }

    private static func pairingText(_ url: URL) -> String {
        #if ONBOARDING
        if url.scheme?.lowercased() == "lifestream-test" { return "lifestream" + url.absoluteString.dropFirst("lifestream-test".count) }
        #endif
        return url.absoluteString
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(notes)
                .modifier(UITestAppearanceOverride())
                .background(AgentSheetAnchor())
                #if DEBUG
                .overlay(alignment: .topLeading) {
                    if notificationsAsked {
                        Text("Notifications asked").font(.system(size: 1)).opacity(0.01)
                            .allowsHitTesting(false)
                            .accessibilityIdentifier("ui-test.notifications-asked")
                    }
                }
                .overlay(alignment: .topTrailing) {
                    if AppRuntime.isUITesting {
                        CannedHome.Asks.Probe()
                        CannedHome.PeopleEdits.Probe()
                        StatedForTests()
                        CannedHome.Settings.Probe.View()
                        CannedHome.Bundles.Probe.View()
                        CannedHome.Agents.Probe()
                        LockProofsForTests()
                        WaitingForTests()
                    }
                }
                #endif
                .onOpenURL { url in
                    if let link = PairingLink(Self.pairingText(url)) { OpenedLink.shared.open(link) }
                }
                .onChange(of: scenePhase) { old, new in
                    if new == .background { away = true }
                    let returning = new == .active && away
                    if returning { Interaction.returnToFront.begin() }
                    AppRuntime.shared.scenePhaseChanged(from: old, to: new)
                    if returning {
                        away = false
                        Interaction.returnToFront.endAtCommit()
                    }
                }
                .task {
                    #if DEBUG
                    if Self.systemNotificationTest {
                        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                        await Self.sendSyntheticCheckIn()
                        notificationsAsked = true
                    }
                    #endif
                    if ProcessInfo.processInfo.arguments.contains("--clear-exported-photo-copies") {
                        let photos = PhotosLibraryModel()
                        await photos.clearTransferredPhotos()
                        let failed: String? = switch photos.clearing.failure {
                        case .notSent: "Not sent"
                        case .refused(let words), .saving(let words), .unknown(let words): words
                        case nil: nil
                        }
                        let report = ["result": failed ?? "cleared", "completed_at": CaptureTime.rfc3339(AppClock.now)]
                        let url = AppRuntime.shared.root.appendingPathComponent("photo-clear-result.json")
                        try? JSONEncoder().encode(report).write(to: url, options: .atomic)
                    }
                }
        }
    }
}

#if DEBUG
extension LifestreamCaptureApp {
    static func sendSyntheticCheckIn() async {
        let content = UNMutableNotificationContent()
        content.title = "Synthetic check-in"
        content.body = "Open the check-in form"
        content.userInfo = ["checkin_prompt": "synthetic-prompt"]
        content.categoryIdentifier = "checkin"
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "synthetic-notification", content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)))
    }
}
#endif

#if DEBUG
private struct StatedForTests: View {
    var body: some View {
        if let stated = CannedHome.Stated.shared.lines.last {
            Text(stated).font(.system(size: 1)).opacity(0.01)
                .allowsHitTesting(false)
                .accessibilityIdentifier("ui-test.stated")
        }
    }
}
#endif

#if DEBUG
private struct LockProofsForTests: View {
    @ObservedObject private var lock = LifeLock.shared

    var body: some View {
        Text(lock.proofs.isEmpty ? "none" : lock.proofs.joined(separator: "; ")).font(.system(size: 1)).opacity(0.01)
            .allowsHitTesting(false)
            .accessibilityIdentifier("ui-test.lock.proofs")
    }
}
#endif

#if DEBUG
private struct WaitingForTests: View {
    @ObservedObject private var lock = LifeLock.shared

    var body: some View {
        Text(lock.isLocked && AppNavigation.shared.waitsBehindLock ? "waits" : "none").font(.system(size: 1)).opacity(0.01)
            .allowsHitTesting(false)
            .accessibilityIdentifier("ui-test.lock.waiting")
    }
}
#endif

struct UITestAppearanceOverride: ViewModifier {
    func body(content: Content) -> some View {
        let arguments = ProcessInfo.processInfo.arguments
        applyColorScheme(
            content,
            dark: arguments.contains("--ui-test-dark-appearance"),
            light: arguments.contains("--ui-test-light-appearance")
        )
        .onAppear {
            let size: UIContentSizeCategory? = arguments.contains("--ui-test-accessibility-largest")
                ? .accessibilityExtraExtraExtraLarge
                : arguments.contains("--ui-test-accessibility-extra-large") ? .accessibilityMedium : nil
            guard let size else { return }
            for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                for window in scene.windows { window.traitOverrides.preferredContentSizeCategory = size }
            }
        }
        .transaction {
            if AppRuntime.runsStill {
                $0.disablesAnimations = true
                $0.animation = nil
            }
        }
    }

    @ViewBuilder
    private func applyColorScheme<V: View>(_ content: V, dark: Bool, light: Bool) -> some View {
        if light {
            content.preferredColorScheme(.light)
        } else if dark {
            content.preferredColorScheme(.dark)
        } else {
            content
        }
    }
}
