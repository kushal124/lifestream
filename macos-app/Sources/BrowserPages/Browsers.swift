import Evidence
import Foundation

public enum BrowserEngine: Sendable {
    case chromium
    case webkit
    case gecko
}

public enum PrivateWindowSignal: Equatable, Sendable {
    case control(role: String, title: String)
    case windowTitleEnding(String)

    func matches(role: String?, title: String?) -> Bool {
        guard case .control(let signalRole, let signalTitle) = self else { return false }
        return role == signalRole && title == signalTitle
    }

    public var readsWindowTitle: Bool {
        if case .windowTitleEnding = self { return true }
        return false
    }

    public static let chromiumIncognito = PrivateWindowSignal.control(role: "AXButton", title: "Incognito")
    public static let safariPrivateBrowsing = PrivateWindowSignal.windowTitleEnding(", Private Browsing")
}

public struct BrowserProfile: Sendable {
    public let engine: BrowserEngine
    public let privateSignal: PrivateWindowSignal?
    public let documentURL: Bool

    init(engine: BrowserEngine, privateSignal: PrivateWindowSignal?, documentURL: Bool = false) {
        self.engine = engine
        self.privateSignal = privateSignal
        self.documentURL = documentURL
    }

    public var readsPages: Bool { engine != .gecko && privateSignal != nil }
}

public enum Browsers {
    private static let chromium = BrowserProfile(engine: .chromium, privateSignal: .chromiumIncognito)
    private static let chrome = BrowserProfile(engine: .chromium, privateSignal: .chromiumIncognito, documentURL: true)
    private static let safari = BrowserProfile(engine: .webkit, privateSignal: .safariPrivateBrowsing)
    private static let webkit = BrowserProfile(engine: .webkit, privateSignal: nil)
    private static let gecko = BrowserProfile(engine: .gecko, privateSignal: nil)

    static let profiles: [String: BrowserProfile] = {
        var profiles: [String: BrowserProfile] = [:]
        profiles["com.apple.Safari"] = safari
        profiles["com.apple.SafariTechnologyPreview"] = webkit
        for id in ["com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
                   "org.chromium.Chromium", "company.thebrowser.Browser", "company.thebrowser.dia",
                   "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
                   "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev",
                   "com.microsoft.edgemac.Canary", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
                   "com.operasoftware.OperaGX", "ai.perplexity.comet"] {
            profiles[id] = chromium
        }
        profiles["com.google.Chrome"] = chrome
        for id in ["org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly",
                   "org.mozilla.floorp", "org.torproject.torbrowser", "net.waterfox.waterfox",
                   "io.gitlab.librewolf-community", "app.zen-browser.zen"] {
            profiles[id] = gecko
        }
        return profiles
    }()

    public static func profile(_ bundleID: String?) -> BrowserProfile? {
        bundleID.flatMap { profiles[$0] }
    }

    public static func isBrowser(_ bundleID: String?) -> Bool {
        profile(bundleID) != nil
    }
}

public enum UnmatchedBrowserWindow {
    public static func mode(windows: [BrowserWindow], app: String, modes: RecordingModes,
                            listComplete: Bool = true) -> RecordingMode? {
        guard listComplete else { return nil }
        let pages = windows.compactMap(\.shownPage)
        guard !pages.isEmpty else { return nil }
        var strictest = RecordingMode.record
        for page in pages {
            guard case .site = page else { return nil }
            strictest = strictest.stricter(modes.mode(app: app, page: page))
        }
        return strictest
    }

    public static func mayLookPast(windows: [BrowserWindow], listComplete: Bool) -> Bool {
        listComplete && !windows.isEmpty && windows.allSatisfy { $0.kind == .other || ($0.kind == .standard && $0.bounds != nil) }
    }
}
