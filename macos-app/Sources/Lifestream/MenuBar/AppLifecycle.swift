import AppKit
import Recorder

@MainActor protocol ActivatingApp: AnyObject {
    func bringForward(_ window: NSWindow)
    func activate(ignoringOtherApps flag: Bool)
}

extension NSApplication: ActivatingApp {
    func bringForward(_ window: NSWindow) {
        window.makeKeyAndOrderFront(nil)
    }
}

@MainActor enum AppActivation {
    static func front(_ window: NSWindow, in app: ActivatingApp) {
        app.bringForward(window)
        app.activate(ignoringOtherApps: true)
    }
}

enum QuitSource: Equatable {
    case user
    case controlShutdown
    case system

    static let quitReasonKeyword = AEKeyword(0x7768_793F)

    static let systemReasons: Set<OSType> = [
        OSType(kAELogOut), OSType(kAEReallyLogOut), OSType(kAEShowRestartDialog),
        OSType(kAEShowShutdownDialog), OSType(kAERestart), OSType(kAEShutDown),
    ]

    static func systemSettings(_ sender: String) -> Bool {
        sender == "com.apple.systempreferences" || sender.hasPrefix("com.apple.settings.")
    }

    static func classify(shuttingDown: Bool, quitReason: OSType?, sender: String? = nil,
                         updating: Bool = false) -> QuitSource {
        if shuttingDown { return .controlShutdown }
        if updating { return .system }
        if let quitReason, systemReasons.contains(quitReason) { return .system }
        if let sender, systemSettings(sender) { return .system }
        return .user
    }
}

enum QuitDecision: Equatable {
    case askFirst
    case stopThenTerminate
    case terminateNow

    static func decide(source: QuitSource, screenRecorded: Bool) -> QuitDecision {
        switch source {
        case .user: return screenRecorded ? .askFirst : .stopThenTerminate
        case .controlShutdown, .system: return .terminateNow
        }
    }

    static func screenRecorded(running: Bool, state: RecorderState) -> Bool {
        running && [.starting, .recording, .waiting, .recovering].contains(state)
    }
}
