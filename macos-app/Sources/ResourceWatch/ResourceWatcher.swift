import Darwin
import Evidence
import Foundation

public struct WatchLine: Encodable, Equatable {
    public struct App: Encodable, Equatable {
        public var pid: Int32
        public var build: String
        public var process: ProcessUsage
        public var restarted: Bool
    }

    public struct Mac: Encodable, Equatable {
        public var systemPowerMW: Int?
        public var batteryPercent: Int?
        public var externalPower: Bool
        public var samples: Int

        enum CodingKeys: String, CodingKey {
            case samples
            case systemPowerMW = "system_power_mw"
            case batteryPercent = "battery_percent"
            case externalPower = "external_power"
        }
    }

    public struct Watcher: Encodable, Equatable {
        public var cpuNs: UInt64
        public var energyNj: UInt64

        enum CodingKeys: String, CodingKey {
            case cpuNs = "cpu_ns"
            case energyNj = "energy_nj"
        }
    }

    public var at: Date
    public var until: Date
    public var app: App?
    public var mac: Mac?
    public var watcher: Watcher

    enum CodingKeys: String, CodingKey {
        case at, until, app, mac, watcher
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(UTCInstant.rfc3339(at), forKey: .at)
        try container.encode(UTCInstant.rfc3339(until), forKey: .until)
        try container.encodeIfPresent(app, forKey: .app)
        try container.encodeIfPresent(mac, forKey: .mac)
        try container.encode(watcher, forKey: .watcher)
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

public struct WatchSources {
    public var app: () -> AppReading?
    public var mac: () -> MacPowerSample?
    public var watcher: () -> ProcessUsage?

    public init(app: @escaping () -> AppReading?, mac: @escaping () -> MacPowerSample?,
                watcher: @escaping () -> ProcessUsage?) {
        self.app = app
        self.mac = mac
        self.watcher = watcher
    }
}

public final class ResourceWatcher {
    public static let gap: TimeInterval = 30
    static let prefix = "watch-"

    private struct Piece {
        var pid: pid_t
        var started: Date
        var build: String
        var baseline: ProcessUsage
        var latest: ProcessUsage
    }

    private let directory: URL
    private let sources: WatchSources
    private let pruner: DayFiles.Pruner
    private var start: Date?
    private var lastRead: Date?
    private var pieces: [Piece] = []
    private var samples: [MacPowerSample] = []
    private var watcherBaseline: ProcessUsage?
    private var watcherLatest: ProcessUsage?

    public init(directory: URL, sources: WatchSources) {
        OwnerOnly.narrow(directory)
        self.directory = directory
        self.sources = sources
        pruner = DayFiles.Pruner(in: directory, prefixes: [Self.prefix])
    }

    public func tick(at now: Date) {
        let app = sources.app()
        let mac = sources.mac()
        let own = sources.watcher()
        defer {
            if let mac { self.samples.append(mac) }
            self.lastRead = now
        }
        guard let start, let lastRead else {
            begin(at: now, app: app, own: own)
            return
        }
        if now < lastRead || now.timeIntervalSince(lastRead) > Self.gap {
            finish(until: lastRead)
            begin(at: now, app: app, own: own)
            return
        }
        observe(app: app, own: own)
        let boundary = Self.minuteEnd(after: start)
        if now >= boundary {
            finish(until: boundary)
            begin(at: boundary, app: app, own: own)
        }
    }

    public func stop(at now: Date) {
        guard start != nil else { return }
        observe(app: sources.app(), own: sources.watcher())
        finish(until: now)
        start = nil
    }

    static func minuteEnd(after instant: Date) -> Date {
        Date(timeIntervalSince1970: ((instant.timeIntervalSince1970 / 60).rounded(.down) + 1) * 60)
    }

    private func begin(at instant: Date, app: AppReading?, own: ProcessUsage?) {
        start = instant
        pieces = []
        samples = []
        watcherBaseline = own
        watcherLatest = own
        if let app {
            pieces = [Piece(pid: app.pid, started: app.started, build: app.build, baseline: app.usage, latest: app.usage)]
        }
    }

    private func observe(app: AppReading?, own: ProcessUsage?) {
        if let own { watcherLatest = own }
        guard let app, let start else { return }
        if let last = pieces.indices.last, pieces[last].pid == app.pid, pieces[last].started == app.started {
            pieces[last].latest = app.usage
        } else {
            pieces.append(Piece(pid: app.pid, started: app.started, build: app.build,
                                baseline: app.started >= start ? ProcessUsage() : app.usage, latest: app.usage))
        }
    }

    private func finish(until end: Date) {
        guard let start, end > start else { return }
        var line = WatchLine(at: UTCInstant.millisecond(start), until: UTCInstant.millisecond(end),
                             watcher: .init(cpuNs: 0, energyNj: 0))
        if let last = pieces.last {
            let use = pieces.dropFirst().reduce(pieces[0].latest.since(pieces[0].baseline)) {
                $0.adding($1.latest.since($1.baseline))
            }
            line.app = .init(pid: last.pid, build: last.build, process: use,
                             restarted: pieces.contains { $0.started >= start })
        }
        if let last = samples.last {
            let powers = samples.compactMap(\.powerMW)
            line.mac = .init(systemPowerMW: powers.isEmpty ? nil : Int((powers.reduce(0, +) / Double(powers.count)).rounded()),
                             batteryPercent: last.batteryPercent, externalPower: last.externalPower,
                             samples: samples.count)
        }
        if let latest = watcherLatest, let baseline = watcherBaseline {
            let use = latest.since(baseline)
            line.watcher = .init(cpuNs: use.cpuNs, energyNj: use.energyNj)
        }
        append(line)
    }

    private func append(_ line: WatchLine) {
        guard var data = try? line.encoded() else { return }
        data.append(0x0A)
        pruner.prune(at: line.until)
        let url = directory.appendingPathComponent(DayFiles.name(Self.prefix, at: line.at))
        let descriptor = OwnerOnly.append(url)
        guard descriptor >= 0 else { return }
        _ = data.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
        close(descriptor)
    }
}
