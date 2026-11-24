import DeviceFiles
import Evidence
import Darwin
import Foundation

public enum ResourceWatch {
    public static let readInterval: TimeInterval = 10
    public static let copyInterval: TimeInterval = 3600

    public struct Configuration {
        public var spool: URL
        public var powerLog: URL
        public var app: URL
        public var duration: TimeInterval?
        public var files: DeviceFiles?
        public var scratch: URL

        public init(spool: URL, powerLog: URL, app: URL, duration: TimeInterval?,
                    files: DeviceFiles?, scratch: URL) {
            self.spool = spool
            self.powerLog = powerLog
            self.app = app
            self.duration = duration
            self.files = files
            self.scratch = scratch
        }
    }

    public static let systemPowerLog = URL(fileURLWithPath: "/var/db/powerlog/Library/BatteryLife", isDirectory: true)

    public static func run(_ configuration: Configuration) {
        setpriority(PRIO_DARWIN_PROCESS, 0, PRIO_DARWIN_BG)
        let resources = configuration.spool.appendingPathComponent("resources", isDirectory: true)
        let finder = AppProcessFinder(bundle: configuration.app)
        let battery = SmartBattery()
        let own = getpid()
        let watcher = ResourceWatcher(directory: resources, sources: WatchSources(
            app: { finder.read() }, mac: { battery.read() }, watcher: { ProcessUsage.read(pid: own) }))
        let copy = configuration.files.map { files in
            PowerLogCopy(source: configuration.powerLog, destination: resources.appendingPathComponent("powerlog", isDirectory: true),
                         files: files, scratch: configuration.scratch)
        }
        let copies = DispatchQueue(label: "org.lifestreamprotocol.resource-watch.powerlog", qos: .background)

        let wake = DispatchSemaphore(value: 0)
        let stopping = StopFlag()
        var signals: [DispatchSourceSignal] = []
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .background))
            source.setEventHandler { stopping.set(); wake.signal() }
            source.resume()
            signals.append(source)
        }

        let deadline = configuration.duration.map { Date().addingTimeInterval($0) }
        var lastCopy = Date.distantPast
        var now = Date()
        while true {
            if let deadline, now >= deadline { break }
            watcher.tick(at: now)
            if let copy, now.timeIntervalSince(lastCopy) >= copyInterval || now < lastCopy {
                lastCopy = now
                copies.async { _ = try? copy.run() }
            }
            var next = Date(timeIntervalSince1970: ((now.timeIntervalSince1970 / readInterval).rounded(.down) + 1) * readInterval)
            if let deadline, next > deadline { next = deadline }
            _ = wake.wait(wallTimeout: .now() + max(0, next.timeIntervalSinceNow))
            now = Date()
            if stopping.isSet { break }
        }
        watcher.stop(at: Date())
        copies.sync {}
        signals.forEach { $0.cancel() }
    }
}

private final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }
}
