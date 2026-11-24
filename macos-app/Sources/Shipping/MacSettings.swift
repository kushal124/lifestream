import DeviceFiles
import Evidence
import Foundation
import HomeLink

public final class MacSettings: @unchecked Sendable {
    public typealias JSON = HomeLink.JSON
    public typealias Values = SettingsQueue.Settings

    public typealias Change = SettingsQueue.Change

    private struct Kept: Codable, Equatable {
        var given: Values?
        var seeded: [String] = []
    }

    public static let fileName = "settings.json"
    public static let queueName = "settings-queue.json"
    static let startKey = "start_ms"
    public static let readerRefresh: TimeInterval = 300
    public static let leastRefresh: TimeInterval = 60
    private let file: URL
    private let files: DeviceFiles
    private let defaults: Values
    private let lock = NSLock()
    private var kept: Kept
    private var applied: Values = [:]
    public let queue: SettingsQueue
    public var changed: (@Sendable (String) async -> Void)?

    public init(file: URL, defaults: Values = [:], files: DeviceFiles) {
        self.file = file
        self.files = files
        self.defaults = defaults
        queue = SettingsQueue(file: file.deletingLastPathComponent().appendingPathComponent(Self.queueName), files: files)
        kept = (try? files.read(file, maximumBytes: ShippingState.mostKept)).flatMap { try? JSONDecoder().decode(Kept.self, from: $0) } ?? Kept()
        applied = lock.withLock { snapshot() }
    }


    public func applies(_ connector: String) -> [String] {
        lock.withLock { handed(connector) }
    }

    private func handed(_ connector: String) -> [String] {
        let given = kept.given?[connector].map { Array($0.keys) } ?? []
        let built = defaults[connector].map { Array($0.keys) } ?? []
        return Set(given + built).subtracting([Self.startKey]).sorted()
    }

    public func local(_ connector: String, _ member: String) -> Bool {
        applies(connector).contains(member)
    }

    public func value(_ connector: String, _ member: String) -> JSON? {
        lock.withLock { running(connector, member) }
    }

    private func running(_ connector: String, _ member: String) -> JSON? {
        if let queued = queue.queued(connector: connector, member: member) { return queued }
        return kept.given?[connector]?[member] ?? builtIn(connector, member)
    }

    private func builtIn(_ connector: String, _ member: String) -> JSON? {
        if let built = defaults[connector]?[member] { return built }
        guard member == "refresh", connector != "screen" else { return nil }
        return .string(Self.words(Self.readerRefresh))
    }

    static func accepts(_ member: String, _ value: JSON) -> Bool {
        switch member {
        case "refresh", "idle_pause": return value.string.flatMap(seconds) != nil
        case "ocr": return ["always", "exact"].contains(value.string ?? "")
        case "apps": return value.array != nil
        default: return value != .null
        }
    }

    private static func kept(_ member: String, _ value: JSON) -> JSON {
        member == "apps" ? AppsField.clean(value) : value
    }

    public func refresh(of connector: String) -> TimeInterval {
        guard connector != "screen", let seconds = value(connector, "refresh")?.string.flatMap(Self.seconds) else {
            return Self.readerRefresh
        }
        return max(Self.leastRefresh, seconds)
    }

    public func start(of connector: String) -> Date? {
        guard let ms = lock.withLock({ kept.given?[connector]?[Self.startKey]?.number }) else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    public func statement() -> Values {
        lock.withLock {
            var stated: Values = [:]
            for (connector, members) in kept.given ?? [:] {
                for member in handed(connector) where members[member] != nil {
                    if let value = running(connector, member) { stated[connector, default: [:]][member] = value }
                }
            }
            return stated
        }
    }


    @discardableResult
    public func set(_ connector: String, _ member: String, to asked: JSON) throws -> Bool {
        guard Self.accepts(member, asked) else { return false }
        let value = Self.kept(member, asked)
        let was = lock.withLock { kept.given?[connector]?[member] }
        guard queue.queued(connector: connector, member: member) != nil || was != value else { return true }
        try queue.enqueue(connector: connector, member: member, value: value, was: was)
        return true
    }

    public func seed(_ connector: String, _ member: String, local value: JSON) throws {
        let key = "\(connector).\(member)"
        guard lock.withLock({ !kept.seeded.contains(key) }) else { return }
        if value != .array([]) { try queue.enqueue(connector: connector, member: member, value: value, was: .array([])) }
        lock.withLock { kept.seeded.append(key) }
        try save()
    }

    public func apply() async {
        await notify()
    }

    public func exchange(through link: HomeLink, offers: [String] = [], drain: Bool = true) async throws -> FreshAnswer {
        try await queue.exchange(through: link, offers: offers, drain: drain, merge: { change, home in
            change.connector == "screen" && change.member == "apps" ? AppsField.merge(home, change.value) : nil
        }, heard: { [self] in await heard($0) }, stated: { [self] in statement() }, apply: { [self] in await take($0) })
    }

    public func take(_ settings: Values) async {
        lock.withLock { kept.given = settings }
        keep()
        await notify()
    }

    private func heard(_ sent: SettingsQueue.Sent) async {
        let (connector, member) = (sent.change.connector, sent.change.member)
        let holds: JSON
        switch sent.outcome {
        case .taken: holds = sent.change.value
        case .changed(let home): holds = home
        case .refused:
            ShippingState.log.error("the home refused \(connector, privacy: .public).\(member, privacy: .public): dropped")
            await notify()
            return
        case .unreachable, .saving, .unknown: return
        }
        lock.withLock {
            var given = kept.given ?? [:]
            given[connector, default: [:]][member] = holds
            kept.given = given
        }
        keep()
        await notify()
    }


    private func snapshot() -> Values {
        let connectors = Set((kept.given ?? [:]).keys).union(defaults.keys).union(queue.changes.map(\.connector))
        var values: Values = [:]
        for connector in connectors {
            for member in handed(connector) { values[connector, default: [:]][member] = running(connector, member) }
        }
        return values
    }

    private func notify() async {
        let (before, after) = lock.withLock { () -> (Values, Values) in
            let now = snapshot()
            defer { applied = now }
            return (applied, now)
        }
        let builtIns = { (connector: String) -> [String: JSON] in
            self.lock.withLock {
                var values: [String: JSON] = [:]
                for member in self.handed(connector) { values[member] = self.builtIn(connector, member) }
                return values
            }
        }
        for connector in Set(before.keys).union(after.keys).sorted()
        where (before[connector] ?? builtIns(connector)) != (after[connector] ?? builtIns(connector)) {
            await changed?(connector)
        }
    }

    private func keep() {
        do { try save() } catch {
            ShippingState.log.error("settings.json could not be written: \(ShipperRunRow.reason(error), privacy: .public)")
        }
    }

    private func save() throws {
        let data = try lock.withLock {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            return try encoder.encode(kept)
        }
        try ShippingState.replace(file, with: data, files: files)
    }


    public static func seconds(_ words: String) -> TimeInterval? {
        guard let unit = words.last, let number = Double(words.dropLast()), number.isFinite, number > 0 else { return nil }
        switch unit {
        case "s": return number
        case "m": return number * 60
        case "h": return number * 3600
        case "d": return number * 86400
        default: return nil
        }
    }

    public static func words(_ seconds: TimeInterval) -> String {
        let whole = Int(seconds.rounded())
        for (unit, size) in [("d", 86400), ("h", 3600), ("m", 60)] where whole >= size && whole % size == 0 {
            return "\(whole / size)\(unit)"
        }
        return "\(whole)s"
    }
}

public enum AppsField {
    public static func of(_ modes: RecordingModes) -> HomeLink.JSON {
        let saved = modes.saved
        let item = { (key: String, id: String, mode: RecordingMode) -> HomeLink.JSON in
            .object([key: .string(id), "mode": .string(mode.rawValue)])
        }
        let apps = (saved.apps.activity.map { ($0, RecordingMode.activity) } + saved.apps.exclude.map { ($0, RecordingMode.exclude) })
            .filter { $0.0 != RecordingModes.ownApp }.sorted { $0.0 < $1.0 }.map { item("app", $0.0, $0.1) }
        let sites = (saved.sites.activity.map { ($0, RecordingMode.activity) } + saved.sites.exclude.map { ($0, RecordingMode.exclude) })
            .sorted { $0.0 < $1.0 }.map { item("site", $0.0, $0.1) }
        return .array(apps + sites)
    }

    public static func modes(_ field: HomeLink.JSON, current: RecordingModes) -> RecordingModes? {
        guard let items = items(field) else { return nil }
        var modes = RecordingModes()
        if current.mode(of: RecordingModes.ownApp) == .exclude { try? modes.set(.exclude, for: RecordingModes.ownApp) }
        for (target, mode) in items {
            switch target {
            case .app(let id): try? modes.set(mode, for: id)
            case .site(let rule): try? modes.setSite(mode, for: rule)
            }
        }
        return modes.excludingForThisRun(current.launchExcluded)
    }

    public static func merge(_ home: HomeLink.JSON, _ mine: HomeLink.JSON) -> HomeLink.JSON {
        var merged: [String: (target: RecordingModeTarget, mode: RecordingMode)] = [:]
        for (target, mode) in (items(home) ?? []) + (items(mine) ?? []) {
            let key: String
            switch target {
            case .app(let id): key = "app " + id
            case .site(let rule): key = "site " + rule
            }
            merged[key] = (target, merged[key].map { $0.mode.stricter(mode) } ?? mode)
        }
        return .array(merged.sorted { $0.key < $1.key }.map { _, item in
            switch item.target {
            case .app(let id): return .object(["app": .string(id), "mode": .string(item.mode.rawValue)])
            case .site(let rule): return .object(["site": .string(rule), "mode": .string(item.mode.rawValue)])
            }
        })
    }

    public static func clean(_ field: HomeLink.JSON) -> HomeLink.JSON {
        merge(.array([]), field)
    }

    private static func items(_ field: HomeLink.JSON) -> [(RecordingModeTarget, RecordingMode)]? {
        guard let list = field.array else { return nil }
        var items: [(RecordingModeTarget, RecordingMode)] = []
        var dropped = 0
        for entry in list {
            guard let mode = entry["mode"]?.string.flatMap(RecordingMode.init(rawValue:)), mode != .record else {
                dropped += 1
                continue
            }
            if let id = entry["app"]?.string, RecordingModes.isValidBundleID(id) {
                if id != RecordingModes.ownApp { items.append((.app(id), mode)) }
            } else if let rule = entry["site"]?.string, RecordingModes.isValidSite(rule) {
                items.append((.site(rule), mode))
            } else {
                dropped += 1
            }
        }
        if dropped > 0 { ShippingState.log.error("screen apps: \(dropped, privacy: .public) items this Mac cannot record by dropped") }
        return items
    }
}
