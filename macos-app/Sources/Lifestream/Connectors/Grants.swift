import AppKit
import Audio
import CoreBluetooth
import HomeLink
import os
import PhotoLibrary
import Shipping
import UserNotifications

enum Grant: String, CaseIterable, Identifiable {
    case screenRecording, accessibility, microphone, systemAudio, bluetooth, fullDiskAccess, photos, openAtLogin

    var id: String { rawValue }

    var title: String {
        switch self {
        case .screenRecording: return "Screen Recording"
        case .accessibility: return "Accessibility"
        case .microphone: return "Microphone"
        case .systemAudio: return "System Audio Recording"
        case .bluetooth: return "Bluetooth"
        case .fullDiskAccess: return "Full Disk Access"
        case .photos: return "Photos"
        case .openAtLogin: return "Open at login"
        }
    }

    var reopens: Bool { self == .screenRecording }

    var optional: Bool { self == .bluetooth }

    var questioned: Bool { self == .microphone || self == .systemAudio || self == .bluetooth || self == .photos }

    static let listed = allCases.filter { $0 != .openAtLogin }

    static func missing(_ held: [Grant: Bool]) -> [Grant] {
        listed.filter { !$0.optional && held[$0] != true }
    }

    static func menuLine(_ missing: [Grant]) -> String? {
        switch missing.count {
        case 0: return nil
        case 1: return "Allow 1 permission…"
        default: return "Allow \(missing.count) permissions…"
        }
    }

    var why: String {
        switch self {
        case .screenRecording: return "What is on your screen, every two seconds. Nothing on this Mac is recorded without it."
        case .accessibility: return "Which window and page is in front, its text, and your keys and clicks."
        case .microphone: return "The microphone, while another app is using it."
        case .systemAudio: return "What this Mac plays while the microphone is in use: the other side of a call."
        case .bluetooth: return "When Bluetooth devices connect and disconnect."
        case .fullDiskAccess: return "Your messages, notes, calls and other apps' history on this Mac."
        case .photos: return "Every photo and video in Photos on this Mac, and their files as Lifestream reads them."
        case .openAtLogin: return "Lifestream opens when you log in, so this Mac records and syncs after a restart."
        }
    }

    var pane: URL {
        let anchor: String
        switch self {
        case .screenRecording, .systemAudio: anchor = "Privacy_ScreenCapture"
        case .accessibility: anchor = "Privacy_Accessibility"
        case .microphone: anchor = "Privacy_Microphone"
        case .bluetooth: anchor = "Privacy_Bluetooth"
        case .fullDiskAccess: anchor = "Privacy_AllFiles"
        case .photos: anchor = "Privacy_Photos"
        case .openAtLogin: return URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!
        }
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
    }

    var granted: Bool {
        switch self {
        case .screenRecording: return CGPreflightScreenCaptureAccess() || ScreenRecordingSwitch.on()
        case .accessibility: return AXIsProcessTrusted()
        case .microphone: return AudioPermissions.granted(.mic)
        case .systemAudio: return AudioPermissions.granted(.sound)
        case .bluetooth: return CBManager.authorization == .allowedAlways
        case .fullDiskAccess: return ShippingDomains.fullDiskAccess(witness: ShippingDomains.fullDiskAccessWitness)
        case .photos: return PhotoLibrary().access.reads
        case .openAtLogin: return HomeAgents.appLogin == .enabled
        }
    }

    var unanswered: Bool {
        switch self {
        case .microphone: return AudioPermissions.status(.mic) == .undetermined
        case .systemAudio: return AudioPermissions.status(.sound) == .undetermined
        case .bluetooth: return CBManager.authorization == .notDetermined
        case .photos: return PhotoLibrary().access == .undecided
        default: return false
        }
    }

    var alerts: Bool { self == .screenRecording && ScreenRecordingSwitch.unasked() }

    static func current() async -> [Grant: Bool] {
        await Task.detached { read() }.value
    }

    static func current(telling link: @escaping @Sendable () -> HomeLink?) async -> [Grant: Bool] {
        await Task.detached {
            let held = read()
            link()?.tell(grants: stated(held: { held[$0] == true }, asked: { !$0.unanswered && !$0.alerts },
                                               defaults: .standard))
            return held
        }.value
    }

    private static func read() -> [Grant: Bool] {
        Dictionary(uniqueKeysWithValues: allCases.map { ($0, $0.granted) })
    }

    static let seenOnKey = "grants.seen-on"

    static func stated(defaults: UserDefaults = .standard) -> [String: String] {
        stated(held: \.granted, asked: { !$0.unanswered && !$0.alerts }, defaults: defaults)
    }

    static func stated(held: (Grant) -> Bool, asked: (Grant) -> Bool, defaults: UserDefaults) -> [String: String] {
        let seen = Set(defaults.stringArray(forKey: seenOnKey) ?? [])
        var now = seen
        var stated: [String: String] = [:]
        for grant in listed {
            let silent = grant == .fullDiskAccess || grant == .accessibility
            if held(grant) {
                stated[grant.rawValue] = "on"
                if silent { now.insert(grant.rawValue) }
            } else {
                stated[grant.rawValue] = (silent ? seen.contains(grant.rawValue) : asked(grant)) ? "off" : "not-asked"
            }
        }
        if now != seen { defaults.set(now.sorted(), forKey: seenOnKey) }
        return stated
    }

    func list() async {
        switch self {
        case .openAtLogin: await Task.detached { HomeAgents.openAtLogin() }.value
        default: _ = await Task.detached { self.granted }.value
        }
    }

    func alert() async {
        guard self == .screenRecording else { return }
        _ = await Task.detached { CGRequestScreenCaptureAccess() }.value
    }

    @MainActor func request() {
        switch self {
        case .screenRecording: _ = CGRequestScreenCaptureAccess()
        case .accessibility:
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        case .microphone, .systemAudio, .bluetooth, .photos: Task { await question() }
        case .fullDiskAccess: break
        case .openAtLogin: Task.detached { HomeAgents.openAtLogin() }
        }
    }

    @MainActor func question() async {
        switch self {
        case .microphone: _ = await AudioPermissions.request(.mic)
        case .systemAudio: _ = await AudioPermissions.request(.sound)
        case .bluetooth: await BluetoothRequest.ask()
        case .photos: _ = await PhotoLibrary().requestAccess()
        default: return
        }
    }

    @MainActor static func requestMissing() {
        for grant in allCases.sorted(by: { $0.questioned && !$1.questioned }) { grant.request() }
    }
}

enum ScreenRecordingSwitch {
    private typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
    private static let preflight: Preflight? = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)
        .flatMap { dlsym($0, "TCCAccessPreflight") }
        .map { unsafeBitCast($0, to: Preflight.self) }

    static func on() -> Bool {
        preflight?("kTCCServiceScreenCapture" as CFString, nil) == 0
    }

    static func unasked() -> Bool {
        preflight?("kTCCServiceScreenCapture" as CFString, nil) == 2
    }
}

enum SystemSettings {
    static let id = "com.apple.systempreferences"

    @MainActor static func open(_ pane: URL) async {
        for running in NSRunningApplication.runningApplications(withBundleIdentifier: id) {
            await quit(running)
        }
        NSWorkspace.shared.open(pane)
    }

    @MainActor static func putAway() async {
        for running in NSRunningApplication.runningApplications(withBundleIdentifier: id) {
            await quit(running)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    @MainActor static func quit(_ app: NSRunningApplication, patience: Duration = .seconds(2)) async {
        guard !app.isTerminated else { return }
        let (ended, done) = AsyncStream<Void>.makeStream()
        let watch = app.observe(\.isTerminated, options: [.new]) { app, _ in
            if app.isTerminated { done.finish() }
        }
        defer { watch.invalidate() }
        let late = Task { @MainActor in
            try? await Task.sleep(for: patience)
            if !app.isTerminated { app.forceTerminate() }
            try? await Task.sleep(for: patience)
            done.finish()
        }
        defer { late.cancel() }
        app.terminate()
        if app.isTerminated { return }
        for await _ in ended {}
    }
}

private enum BluetoothRequest {
    @MainActor private static var manager: CBCentralManager?
    @MainActor private static let answered = Answered()
    @MainActor private static var waiting: [CheckedContinuation<Void, Never>] = []

    @MainActor static func ask() async {
        guard CBManager.authorization == .notDetermined else { return }
        await withCheckedContinuation { done in
            waiting.append(done)
            if manager == nil {
                manager = CBCentralManager(delegate: answered, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
            }
        }
    }

    private final class Answered: NSObject, CBCentralManagerDelegate {
        func centralManagerDidUpdateState(_ central: CBCentralManager) {
            guard CBManager.authorization != .notDetermined else { return }
            MainActor.assumeIsolated {
                BluetoothRequest.manager = nil
                let done = BluetoothRequest.waiting
                BluetoothRequest.waiting = []
                done.forEach { $0.resume() }
            }
        }
    }
}

enum NotificationGrant {
    static func allowed() async -> Bool {
        guard Bundle.main.bundleIdentifier != nil else { return false }
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return status == .authorized || status == .provisional
    }

    private static let log = Logger(subsystem: "org.lifestreamprotocol.screen-capture", category: "grants")

    static func declines(status: UNAuthorizationStatus?, error: Error?) -> Bool {
        if let error = error as NSError? {
            return error.domain == UNErrorDomain && error.code == UNError.Code.notificationsNotAllowed.rawValue
        }
        return status == .notDetermined
    }

    static func post(_ request: UNNotificationRequest) async {
        guard await ask() else { return }
        try? await UNUserNotificationCenter.current().add(request)
    }

    static func ask() async -> Bool {
        guard Bundle.main.bundleIdentifier != nil else { return false }
        let center = UNUserNotificationCenter.current()
        var failure: Error?
        do {
            let allowed = try await center.requestAuthorization(options: [.alert])
            log.notice("notifications asked: allowed \(allowed, privacy: .public)")
        } catch {
            failure = error
            let refusal = error as NSError
            log.error("notifications refused by macOS: \(refusal.domain, privacy: .public) \(refusal.code, privacy: .public): \(refusal.localizedDescription, privacy: .public)")
        }
        let status = await center.notificationSettings().authorizationStatus
        log.notice("notifications status after the ask: \(status.rawValue, privacy: .public), declined by macOS \(declines(status: status, error: failure), privacy: .public)")
        return status == .authorized || status == .provisional
    }
}
