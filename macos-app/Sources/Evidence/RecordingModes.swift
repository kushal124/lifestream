import DeviceFiles
import Foundation

public enum RecordingMode: String, Codable, CaseIterable, Sendable {
    case record
    case activity
    case exclude
}

public struct RecordingModeGroup: Codable, Equatable, Sendable {
    public var activity: [String]
    public var exclude: [String]

    public init(activity: [String] = [], exclude: [String] = []) {
        self.activity = activity
        self.exclude = exclude
    }
}

public struct RecordingModeListing: Codable, Equatable, Sendable {
    public var apps: RecordingModeGroup
    public var sites: RecordingModeGroup

    public init(apps: RecordingModeGroup, sites: RecordingModeGroup = RecordingModeGroup()) {
        self.apps = apps
        self.sites = sites
    }
}

public enum RecordingModeTarget: Equatable, Sendable {
    case app(String)
    case site(String)
}

public enum RecordingModesError: Error, Equatable, LocalizedError {
    case ownAppNeverRecorded
    case invalidBundleID
    case invalidSite

    public var errorDescription: String? {
        switch self {
        case .ownAppNeverRecorded:
            return "\(RecordingModes.ownApp) is always activity: it may be excluded, never recorded"
        case .invalidBundleID:
            return "A bundle id is 1–255 characters with no spaces or control characters"
        case .invalidSite:
            return "A site is a host, such as example.com, or a host and port, such as 127.0.0.1:4317"
        }
    }
}

public struct RecordingModes: Equatable, Sendable {
    public static let ownApp = "org.lifestreamprotocol.screen-capture"
    public static let passwordManagers = ["com.1password.1password", "com.agilebits.onepassword7", "com.apple.Passwords",
                                          "com.apple.keychainaccess", "com.bitwarden.desktop", "com.lastpass.LastPass",
                                          "com.dashlane.dashlanephonefinal", "org.keepassxc.keepassxc", "com.protonpass.mac"]
    public static let defaultExcluded = Set(passwordManagers)
    public static let defaultSiteActivity: Set<String> = ["127.0.0.1:4317", "localhost:4317"]
    public static let fileName = "app-modes.json"
    public static let defaults = RecordingModes(exclude: defaultExcluded, siteActivity: defaultSiteActivity)

    private var settings: [String: RecordingMode]
    private var siteSettings: [Site: RecordingMode]
    public private(set) var launchExcluded: Set<String>

    public init(activity: Set<String> = [], exclude: Set<String> = [], launchExcluded: Set<String> = [],
                siteActivity: Set<String> = [], siteExclude: Set<String> = []) {
        settings = Self.settings(activity: activity, exclude: exclude)
        var sites: [Site: RecordingMode] = [:]
        for (spelling, mode) in Self.settings(activity: siteActivity, exclude: siteExclude) {
            if let site = Site(rule: spelling) { sites[site] = mode }
        }
        siteSettings = sites
        self.launchExcluded = launchExcluded
    }

    private static func settings(activity: Set<String>, exclude: Set<String>) -> [String: RecordingMode] {
        var settings: [String: RecordingMode] = [:]
        for id in activity { settings[id] = .activity }
        for id in exclude { settings[id] = .exclude }
        return settings
    }

    public func mode(of bundleID: String?) -> RecordingMode {
        guard let bundleID else { return .record }
        if launchExcluded.contains(bundleID) { return .exclude }
        if let set = settings[bundleID] { return set }
        return bundleID == Self.ownApp ? .activity : .record
    }

    public var hasSiteRules: Bool { !siteSettings.isEmpty }

    public func siteMode(of page: Site) -> RecordingMode? {
        var mode: RecordingMode?
        for (rule, set) in siteSettings where rule.covers(page) {
            mode = (mode ?? .record).stricter(set)
        }
        return mode
    }

    public func mode(app bundleID: String?, page: BrowserPage?) -> RecordingMode {
        let app = mode(of: bundleID)
        switch page {
        case nil: return app
        case .privateWindow?: return .exclude
        case .unknown?: return hasSiteRules ? .exclude : app
        case .site(let site)?: return app.stricter(siteMode(of: site) ?? .record)
        }
    }

    public var excluded: Set<String> {
        launchExcluded.union(settings.filter { $0.value == .exclude }.keys)
    }

    public var activity: Set<String> {
        Set(settings.filter { $0.value == .activity }.keys).union([Self.ownApp]).subtracting(excluded)
    }

    public var hidden: Set<String> { excluded.union(activity) }

    public var listing: RecordingModeListing {
        RecordingModeListing(apps: RecordingModeGroup(activity: activity.sorted(), exclude: excluded.sorted()),
                             sites: siteGroup)
    }

    public var saved: RecordingModeListing {
        RecordingModeListing(apps: Self.group(settings), sites: siteGroup)
    }

    private var siteGroup: RecordingModeGroup {
        RecordingModeGroup(activity: siteSettings.filter { $0.value == .activity }.keys.map(\.spelling).sorted(),
                           exclude: siteSettings.filter { $0.value == .exclude }.keys.map(\.spelling).sorted())
    }

    private static func group(_ settings: [String: RecordingMode]) -> RecordingModeGroup {
        RecordingModeGroup(activity: settings.filter { $0.value == .activity }.keys.sorted(),
                           exclude: settings.filter { $0.value == .exclude }.keys.sorted())
    }

    public mutating func set(_ mode: RecordingMode, for bundleID: String) throws {
        guard Self.isValidBundleID(bundleID) else { throw RecordingModesError.invalidBundleID }
        if bundleID == Self.ownApp {
            switch mode {
            case .record: throw RecordingModesError.ownAppNeverRecorded
            case .activity: settings[bundleID] = nil
            case .exclude: settings[bundleID] = .exclude
            }
            return
        }
        settings[bundleID] = mode == .record ? nil : mode
    }

    public mutating func setSite(_ mode: RecordingMode, for rule: String) throws {
        guard let site = Site(rule: rule) else { throw RecordingModesError.invalidSite }
        siteSettings[site] = mode == .record ? nil : mode
    }

    public func excludingForThisRun(_ ids: Set<String>) -> RecordingModes {
        var modes = self
        modes.launchExcluded.formUnion(ids)
        return modes
    }

    public static func isValidBundleID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 255
            && !id.unicodeScalars.contains { $0.properties.isWhitespace || $0.value < 0x20 || $0.value == 0x7F }
    }

    public static func isValidSite(_ site: String) -> Bool {
        let parts = site.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let host = parts[0]
        guard !host.isEmpty, host.utf8.count <= 253 else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ label in
            !label.isEmpty && label.utf8.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-")
                && label.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
        }) else { return false }
        guard parts.count == 2 else { return true }
        guard let port = Int(parts[1]), (1...65535).contains(port), String(port) == parts[1] else { return false }
        return true
    }


    public func fileBytes() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(saved) + Data("\n".utf8)
    }

    public static func decodeFile(_ data: Data) -> RecordingModes? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["apps", "sites"],
              let apps = group(object["apps"], valid: isValidBundleID),
              let sites = group(object["sites"], valid: isValidSite) else { return nil }
        return RecordingModes(activity: apps.activity, exclude: apps.exclude,
                              siteActivity: sites.activity, siteExclude: sites.exclude)
    }

    private static func group(_ value: Any?, valid: (String) -> Bool)
        -> (activity: Set<String>, exclude: Set<String>)? {
        guard let object = value as? [String: Any], Set(object.keys) == ["activity", "exclude"],
              let activity = object["activity"] as? [String], let exclude = object["exclude"] as? [String],
              (activity + exclude).allSatisfy(valid),
              Set(activity).count == activity.count, Set(exclude).count == exclude.count,
              Set(activity).isDisjoint(with: exclude) else { return nil }
        return (Set(activity), Set(exclude))
    }

    public static func load(from directory: URL, files: DeviceFiles,
                            report: (String) -> Void = { _ in }) -> RecordingModes {
        let read: Data?
        do {
            read = try files.read(directory.appendingPathComponent(fileName), maximumBytes: 1 << 20)
        } catch {
            read = Data()
        }
        guard let read else { return defaults }
        guard let modes = decodeFile(read) else {
            report("recording modes: \(fileName) could not be read; the defaults apply")
            return defaults
        }
        return modes
    }

    public func save(to directory: URL, files: DeviceFiles) throws {
        try files.replace(directory.appendingPathComponent(Self.fileName), with: try fileBytes(), commit: .durable)
    }
}
