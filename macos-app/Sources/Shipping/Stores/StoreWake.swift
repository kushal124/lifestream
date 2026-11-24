import AppKit
import Foundation

public enum StoreWake {
    public static let launchHidden: @Sendable (String) -> Void = { bundleIdentifier in
        guard NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).isEmpty,
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = true
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in }
    }
}
