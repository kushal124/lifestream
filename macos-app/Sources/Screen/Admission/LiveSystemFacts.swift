import AppKit
import Carbon
import Evidence

@MainActor
struct LiveSystemFacts: SystemFacts {
    var screenRecordingPermitted: Bool { CGPreflightScreenCaptureAccess() }
    var sessionPermitsCapture: Bool { SessionLock.permitsCapture(CGSessionCopyCurrentDictionary() as? [String: Any]) }
    var secureInputEnabled: Bool { IsSecureEventInputEnabled() }

    func secureField() -> SecureFieldReading {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return .unreadable }
        return Self.searchFront(pid: pid)
    }

    func secureFieldOffMain() async -> SecureFieldReading {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return .unreadable }
        return await BlockingWork.run { Self.searchFront(pid: pid) }
    }

    private nonisolated static func searchFront(pid: pid_t) -> SecureFieldReading {
        let now = { ProcessInfo.processInfo.systemUptime }
        let deadline = now() + SecureFieldSearch<AccessibilitySecureFields>.deadline
        return SecureFieldSearch(tree: AccessibilitySecureFields(pid: pid, deadline: deadline), deadline: deadline,
                                 now: now).read()
    }

    func frontmostApplication() -> CaptureApplication? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return CaptureApplication(bundleID: app.bundleIdentifier, name: app.localizedName, pid: app.processIdentifier)
    }

    func frontWindow(pid: Int32) -> FrontWindowReading {
        AccessibilityFrontWindow.read(pid: pid)
    }

    func frontWindowOffMain(pid: Int32) async -> FrontWindowReading {
        await BlockingWork.run { AccessibilityFrontWindow.read(pid: pid) }
    }

    func runningPIDs(bundleIDs: Set<String>) -> Set<pid_t> {
        Set(bundleIDs.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0) }
            .map(\.processIdentifier))
    }

    func visiblePIDs() -> Set<Int32>? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
        return Set(windows.compactMap { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value })
    }
}
