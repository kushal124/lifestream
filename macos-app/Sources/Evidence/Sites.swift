import Foundation

public struct Site: Hashable, Comparable, Sendable {
    public let host: String
    public let port: Int?

    public var spelling: String { port.map { "\(host):\($0)" } ?? host }

    public static func < (lhs: Site, rhs: Site) -> Bool { lhs.spelling < rhs.spelling }

    public init?(rule: String) {
        let trimmed = rule.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.contains("/"), !trimmed.contains("@"),
              let components = URLComponents(string: "http://\(trimmed)"),
              let host = components.encodedHost?.lowercased(), components.path.isEmpty,
              components.query == nil, components.fragment == nil, components.user == nil else { return nil }
        let site = Site(host: host, port: components.port)
        guard RecordingModes.isValidSite(site.spelling) else { return nil }
        self = site
    }

    public init?(page url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.encodedHost?.lowercased(), !host.isEmpty else { return nil }
        var port = components.port
        if port == nil {
            switch components.scheme?.lowercased() {
            case "http": port = 80
            case "https": port = 443
            default: break
            }
        }
        let site = Site(host: host, port: port)
        guard RecordingModes.isValidSite(site.spelling) else { return nil }
        self = site
    }

    init(host: String, port: Int?) {
        self.host = host
        self.port = port
    }

    public func covers(_ page: Site) -> Bool {
        if let port { return page.host == host && page.port == port }
        return page.host == host || page.host.hasSuffix("." + host)
    }
}

public enum BrowserPage: Equatable, Hashable, Sendable {
    case site(Site)
    case privateWindow
    case unknown
}

extension RecordingMode {
    private var strictness: Int {
        switch self {
        case .record: return 0
        case .activity: return 1
        case .exclude: return 2
        }
    }

    public func stricter(_ other: RecordingMode) -> RecordingMode {
        other.strictness > strictness ? other : self
    }
}

public enum PageUnknownCause: String, Codable, CaseIterable, Sendable {
    case browserUnsupported = "browser-unsupported"
    case browserDidNotAnswer = "browser-did-not-answer"
    case noAccessibilityWindow = "no-accessibility-window"
    case ambiguousAccessibilityWindow = "ambiguous-accessibility-window"
    case walkDeadline = "walk-deadline"
    case walkBudget = "walk-budget"
    case controlsUnreadable = "controls-unreadable"
    case noWebArea = "no-web-area"
    case urlUnreadable = "url-unreadable"
    case pageWithoutHost = "page-without-host"
    case windowUnreadable = "window-unreadable"
}

public struct ForegroundPageGap: Equatable, Sendable {
    public let reason: CaptureGapReason
    public let cause: PageUnknownCause?

    public init(page: BrowserPage, cause: PageUnknownCause?) {
        switch page {
        case .site:
            reason = .foregroundSiteRuleExcluded
            self.cause = nil
        case .privateWindow:
            reason = .foregroundPrivateWindow
            self.cause = nil
        case .unknown:
            reason = .foregroundPageUnreadable
            self.cause = cause
        }
    }

    public func observation(at date: Date, displayID: UInt32 = 0) -> CaptureObservation {
        var observation = CaptureObservation.gap(at: date, displayID: displayID, reason: reason.rawValue,
                                                 status: .excluded)
        observation.pageCause = cause?.rawValue
        return observation
    }
}
