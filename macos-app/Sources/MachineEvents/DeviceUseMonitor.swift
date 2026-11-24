import Evidence
import Foundation

public enum DeviceUseSignal: Sendable {
    case clients
    case level
}

public protocol DeviceUseProbe: AnyObject, Sendable {
    func read(at: Date) -> DeviceUse
    func observe(_ signal: @escaping @Sendable (DeviceUseSignal) -> Void)
    func stopObserving()
    func recheck()
}

public final class DeviceUseMonitor: @unchecked Sendable {
    public static let clientWindow: TimeInterval = 0.025
    public static let levelWindow: TimeInterval = 0.3

    private let probe: any DeviceUseProbe
    private let queue: DispatchQueue
    private let clock: @Sendable () -> Date
    private var changed: ((DeviceUse) -> Void)?
    private var last: DeviceUse?
    private var windowOpenedAt: Date?
    private var deadline: DispatchTime?
    private var pending: DispatchWorkItem?

    public init(probe: any DeviceUseProbe, queue: DispatchQueue,
                clock: @escaping @Sendable () -> Date = { Date() }) {
        self.probe = probe
        self.queue = queue
        self.clock = clock
    }

    public func start(_ changed: @escaping (DeviceUse) -> Void) -> DeviceUse {
        dispatchPrecondition(condition: .onQueue(queue))
        self.changed = changed
        probe.observe { [weak self] signal in self?.heard(signal) }
        let first = read(at: clock())
        last = first
        return first
    }

    public func recheck() {
        probe.recheck()
        heard(.clients)
    }

    public func stop() {
        dispatchPrecondition(condition: .onQueue(queue))
        probe.stopObserving()
        pending?.cancel()
        pending = nil
        deadline = nil
        windowOpenedAt = nil
        changed = nil
        last = nil
    }

    public func read() -> DeviceUse {
        read(at: clock())
    }

    private func read(at instant: Date) -> DeviceUse {
        ResourceMeter.shared.count(.deviceReads)
        return ResourceMeter.shared.measure(.deviceUse) { probe.read(at: instant) }
    }

    private func heard(_ signal: DeviceUseSignal) {
        let now = clock()
        queue.async { [self] in
            guard changed != nil else { return }
            let window = signal == .clients ? Self.clientWindow : Self.levelWindow
            let due = DispatchTime.now() + window
            if windowOpenedAt == nil { windowOpenedAt = now }
            if let deadline, deadline <= due { return }
            pending?.cancel()
            let item = DispatchWorkItem { [weak self] in self?.readNow() }
            pending = item
            deadline = due
            queue.asyncAfter(deadline: due, execute: item)
        }
    }

    private func readNow() {
        guard let changed, let opened = windowOpenedAt else { return }
        windowOpenedAt = nil
        deadline = nil
        pending = nil
        let read = self.read(at: opened)
        guard read.audio != last?.audio || read.cameras != last?.cameras else { return }
        last = read
        changed(read)
    }
}
