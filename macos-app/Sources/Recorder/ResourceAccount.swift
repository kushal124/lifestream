import DeviceFiles
import Evidence
import Foundation

final class ResourceStates: @unchecked Sendable {
    enum Flag: Int, CaseIterable {
        case awake, displayAwake, unlocked, capturing, onBattery, lowPower
    }

    private let lock = NSLock()
    private let clock: @Sendable () -> Date
    private var on: [Bool]
    private var seconds: [Double]
    private var front: String?
    private var frontSeconds: [String: Double] = [:]
    private var thermal = ThermalLevel.nominal
    private var thermalMax = ThermalLevel.nominal
    private var since: Date

    init(clock: @escaping @Sendable () -> Date) {
        self.clock = clock
        on = Flag.allCases.map { $0 == .awake }
        seconds = Array(repeating: 0, count: Flag.allCases.count)
        since = clock()
    }

    func set(_ flag: Flag, _ value: Bool) {
        lock.withLock {
            guard on[flag.rawValue] != value else { return }
            advance(to: clock())
            on[flag.rawValue] = value
        }
    }

    func setFront(_ name: String?) {
        lock.withLock {
            guard front != name else { return }
            advance(to: clock())
            front = name
        }
    }

    func setThermal(_ level: ThermalLevel) {
        lock.withLock {
            thermal = level
            thermalMax = max(thermalMax, level)
        }
    }

    func take(until: Date) -> StateSeconds {
        lock.withLock {
            advance(to: until)
            func whole(_ flag: Flag) -> Int { Int(seconds[flag.rawValue].rounded()) }
            let taken = StateSeconds(awake: whole(.awake), displayAwake: whole(.displayAwake),
                                     unlocked: whole(.unlocked), capturing: whole(.capturing),
                                     onBattery: whole(.onBattery), lowPower: whole(.lowPower),
                                     thermalMax: thermalMax,
                                     front: frontSeconds.mapValues { Int($0.rounded()) })
            seconds = Array(repeating: 0, count: Flag.allCases.count)
            frontSeconds = [:]
            thermalMax = thermal
            return taken
        }
    }

    private func advance(to instant: Date) {
        let elapsed = instant.timeIntervalSince(since)
        guard elapsed > 0 else { return }
        since = instant
        let awake = on[Flag.awake.rawValue]
        for flag in Flag.allCases where on[flag.rawValue] && (awake || flag == .awake) {
            seconds[flag.rawValue] += elapsed
        }
        if awake, let front { frontSeconds[front, default: 0] += elapsed }
    }
}

final class ResourceAccount: @unchecked Sendable {
    static let folderName = "resources"
    static let prefix = "app-"

    struct Sources: Sendable {
        var clock: @Sendable () -> Date = { Date() }
        var process: @Sendable () -> ProcessUsage? = { nil }
        var helper: @Sendable () -> ProcessUsage? = { nil }
        var build = "unknown"
        var pid = ProcessInfo.processInfo.processIdentifier
        var observe: @Sendable (ResourceStates) -> Void = { _ in }
        var timer = true
    }

    let states: ResourceStates
    private let folder: URL
    private let files: DeviceFiles
    private let meter: ResourceMeter
    private let sources: Sources
    private let pruner: DayFiles.Pruner
    private let queue = DispatchQueue(label: "org.lifestreamprotocol.screen-capture.resources", qos: .utility)
    private var at: Date?
    private var baseline: ProcessUsage?
    private var helperBaseline: ProcessUsage?
    private var timer: DispatchSourceTimer?

    init(directory: URL, files: DeviceFiles, meter: ResourceMeter = .shared, sources: Sources = Sources()) {
        folder = directory.appendingPathComponent(Self.folderName, isDirectory: true)
        self.files = files
        self.meter = meter
        self.sources = sources
        pruner = DayFiles.Pruner(in: folder, prefixes: [Self.prefix])
        states = ResourceStates(clock: sources.clock)
    }

    func start() {
        let begun = queue.sync { at != nil }
        guard !begun else { return }
        sources.observe(states)
        queue.sync {
            let now = sources.clock()
            at = now
            baseline = sources.process()
            helperBaseline = sources.helper()
            _ = meter.take()
            _ = states.take(until: now)
            if sources.timer { arm(after: now) }
        }
    }

    func cut() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async { [self] in
                if let at {
                    let now = sources.clock()
                    if now > at { write(until: now) }
                }
                done.resume()
            }
        }
    }

    func minutePassed() {
        guard let at else { return }
        let now = sources.clock()
        let minute = Self.minute(of: now)
        if minute > at { write(until: minute) }
        if sources.timer { arm(after: now) }
    }


    private func write(until: Date) {
        guard let at else { return }
        let usage = sources.process()
        let process = usage.flatMap { now in baseline.map { now.since($0) } }
        if let usage { baseline = usage }
        let helperUsage = sources.helper()
        let helper = helperUsage.flatMap { now in helperBaseline.map { now.since($0) } }
        if let helperUsage { helperBaseline = helperUsage }
        let minute = meter.take()
        var states = states.take(until: until)
        states.front = Dictionary(states.front.map { (files.name($0.key), $0.value) }, uniquingKeysWith: +)
        self.at = until
        let line = ResourceLine.encode(at: at, until: until, build: sources.build, pid: sources.pid,
                                       process: process, helper: helper, minute: minute, states: states)
        pruner.prune(at: sources.clock())
        let file = folder.appendingPathComponent(DayFiles.name(Self.prefix, at: at))
        do {
            OwnerOnly.folder(folder)
            let handle = try files.log(file)
            defer { handle.close() }
            try handle.append(Data(line.utf8), flush: nil)
        } catch {
            meter.count(.resourceLinesDropped)
        }
    }

    private func arm(after now: Date) {
        let next = Self.minute(of: now).addingTimeInterval(60)
        let timer = self.timer ?? {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.setEventHandler { [weak self] in self?.minutePassed() }
            timer.resume()
            self.timer = timer
            return timer
        }()
        timer.schedule(wallDeadline: .now() + max(0, next.timeIntervalSince(now)), leeway: .seconds(2))
    }

    static func minute(of instant: Date) -> Date {
        Date(timeIntervalSince1970: (instant.timeIntervalSince1970 / 60).rounded(.down) * 60)
    }
}
