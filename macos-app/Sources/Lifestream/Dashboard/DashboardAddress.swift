import Foundation

struct DashboardAddress: Equatable {
    enum Decision: Equatable { case load, openInBrowser, refuse }

    static let defaultPort = 4317
    let port: Int
    let bundled: Bool

    init(port: Int = DashboardAddress.defaultPort, bundled: Bool = false) {
        self.port = port
        self.bundled = bundled
    }

    var carried: DashboardAddress { DashboardAddress(port: port, bundled: true) }

    var root: URL { URL(string: bundled ? "\(BundledPage.scheme)://\(BundledPage.host)/" : "http://127.0.0.1:\(port)/")! }

    func root(hash: String) -> URL { URL(string: root.absoluteString + "#\(hash)")! }

    func place(of url: URL) -> URL? {
        let dashboard = DashboardAddress(port: port)
        if Self.view(of: url) == AppSection.onboardingView { return dashboard.root(hash: "view=\(AppSection.onboardingView)") }
        let carried = url.scheme?.lowercased() == BundledPage.scheme
        guard !carried || Self.view(of: url) != nil, let shown = URLComponents(url: url, resolvingAgainstBaseURL: false),
              var parts = carried ? URLComponents(url: dashboard.root, resolvingAgainstBaseURL: false) : shown else { return nil }
        parts.percentEncodedFragment = Self.place(hash: shown.percentEncodedFragment)
        return parts.url
    }

    static func place(hash: String?) -> String? {
        let kept = (hash ?? "").split(separator: "&").filter { !$0.hasPrefix("tour=") }
        return kept.isEmpty ? nil : kept.joined(separator: "&")
    }

    static func hash(_ hash: String, over url: URL) -> String {
        guard !hash.split(separator: "&").contains(where: { $0.hasPrefix("view=") }) else { return hash }
        let kept = (url.fragment ?? "").split(separator: "&").filter { !$0.hasPrefix("dialog=") && !$0.hasPrefix("flow=") }
        return (kept.map(String.init) + [hash]).joined(separator: "&")
    }

    static func view(of url: URL) -> String? { value(of: "view", in: url) }

    static func dialog(of url: URL) -> String? { value(of: "dialog", in: url) }

    private static func value(of name: String, in url: URL) -> String? {
        url.fragment?.split(separator: "&").lazy.compactMap { part -> String? in
            let pair = part.split(separator: "=", maxSplits: 1)
            return pair.count == 2 && pair[0] == name ? String(pair[1]).removingPercentEncoding : nil
        }.first
    }

    var hostAndPort: String { "127.0.0.1:\(port)" }

    static let appSchemes: Set<String> = ["imessage", "sms"]

    func decide(_ url: URL?) -> Decision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .refuse }
        if DashboardAddress.appSchemes.contains(scheme) { return .openInBrowser }
        if scheme == BundledPage.scheme { return bundled && url.host == BundledPage.host ? .load : .refuse }
        guard scheme == "http" || scheme == "https" else { return .refuse }
        guard url.host != nil else { return .refuse }
        return url.user == nil && url.password == nil && isDashboard(scheme: scheme, host: url.host ?? "", port: url.port ?? -1)
            ? .load : .openInBrowser
    }

    func startURL(stored: String?, launch: Bool = false) -> URL {
        guard !bundled, let stored, let url = URL(string: stored), decide(url) == .load else { return launch ? chat : root }
        return !launch || Self.view(of: url) == AppSection.onboardingView ? url : chat
    }

    var chat: URL { root(hash: "view=\(AppSection.ask.rawValue)") }

    func isDashboard(scheme: String, host: String, port: Int) -> Bool {
        let host = host.lowercased()
        if scheme.lowercased() == BundledPage.scheme { return bundled && host == BundledPage.host }
        return scheme.lowercased() == "http" && (host == "127.0.0.1" || host == "localhost") && port == self.port
    }
}
