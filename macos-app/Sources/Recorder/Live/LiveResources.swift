import AppKit
import Darwin
import Evidence
import Foundation
import IOKit.ps
import notify
import Screen

enum LiveResources {
    static func sources() -> ResourceAccount.Sources {
        var sources = ResourceAccount.Sources()
        sources.process = { ProcessUsage.read(pid: getpid()) }
        sources.helper = { TextRecognitionHelper.usage() }
        sources.build = Bundle.main.object(forInfoDictionaryKey: "LifestreamCommit") as? String ?? "unknown"
        sources.observe = { states in
            MainActor.assumeIsolated { ResourceObservers.start(states) }
        }
        return sources
    }
}

@MainActor
final class ResourceObservers {
    private static var running: ResourceObservers?

    private let states: ResourceStates
    private var locked = false
    private var onConsole = true
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var powerToken: Int32 = 0

    static func start(_ states: ResourceStates) {
        guard running == nil else { return }
        let observers = ResourceObservers(states: states)
        observers.observe()
        running = observers
    }

    private init(states: ResourceStates) {
        self.states = states
    }

    private func observe() {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        locked = session?["CGSSessionScreenIsLocked"] as? Bool ?? false
        onConsole = session?[kCGSessionOnConsoleKey as String] as? Bool ?? true
        states.set(.unlocked, !locked && onConsole)
        states.set(.displayAwake, CGDisplayIsAsleep(CGMainDisplayID()) == 0)
        states.setFront(NSWorkspace.shared.frontmostApplication.flatMap(Self.name))
        power()
        let workspace = NSWorkspace.shared.notificationCenter
        listen(workspace, NSWorkspace.willSleepNotification) { $0.states.set(.awake, false) }
        listen(workspace, NSWorkspace.didWakeNotification) { $0.states.set(.awake, true) }
        listen(workspace, NSWorkspace.screensDidSleepNotification) { $0.states.set(.displayAwake, false) }
        listen(workspace, NSWorkspace.screensDidWakeNotification) { $0.states.set(.displayAwake, true) }
        listen(workspace, NSWorkspace.sessionDidBecomeActiveNotification) { $0.session(onConsole: true) }
        listen(workspace, NSWorkspace.sessionDidResignActiveNotification) { $0.session(onConsole: false) }
        let distributed = DistributedNotificationCenter.default()
        listen(distributed, Notification.Name("com.apple.screenIsLocked")) { $0.session(locked: true) }
        listen(distributed, Notification.Name("com.apple.screenIsUnlocked")) { $0.session(locked: false) }
        listen(NotificationCenter.default, .NSProcessInfoPowerStateDidChange) { $0.power() }
        listen(NotificationCenter.default, ProcessInfo.thermalStateDidChangeNotification) { $0.power() }
        let activation = workspace.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil,
                                               queue: .main) { [states] notification in
            let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            states.setFront(app.flatMap(Self.name))
        }
        observers.append((workspace, activation))
        notify_register_dispatch(kIOPSNotifyPowerSource, &powerToken, .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.power() }
        }
    }

    private func listen(_ center: NotificationCenter, _ name: Notification.Name,
                        _ handle: @escaping @MainActor (ResourceObservers) -> Void) {
        let observer = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                handle(self)
            }
        }
        observers.append((center, observer))
    }

    private func session(locked: Bool? = nil, onConsole: Bool? = nil) {
        if let locked { self.locked = locked }
        if let onConsole { self.onConsole = onConsole }
        states.set(.unlocked, !self.locked && self.onConsole)
    }

    private func power() {
        let info = ProcessInfo.processInfo
        states.set(.lowPower, info.isLowPowerModeEnabled)
        states.setThermal(ThermalLevel(rawValue: info.thermalState.rawValue) ?? .critical)
        let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue()
        let source = snapshot.flatMap { IOPSGetProvidingPowerSourceType($0)?.takeUnretainedValue() as String? }
        states.set(.onBattery, source == kIOPSBatteryPowerValue)
    }

    private nonisolated static func name(_ app: NSRunningApplication) -> String? {
        app.bundleIdentifier ?? app.executableURL.map { "proc:\($0.lastPathComponent)" }
    }
}
