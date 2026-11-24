import Foundation
import HomeLink

extension HomeClock {
    public static let current = ClockInUse()
}

public final class ClockInUse: @unchecked Sendable {
    public typealias Wait = @Sendable (_ seconds: TimeInterval, _ then: @escaping @Sendable () -> Void) -> @Sendable () -> Void

    private let lock = NSLock()
    private let now: @Sendable () -> Date
    private let zone: @Sendable () -> TimeZone
    private let wait: Wait
    private var installed: HomeClock?
    private var placeholder: HomeClock?
    private var changes = 0
    private var adopted = -1
    private var listeners: [Int: @Sendable () -> Void] = [:]
    private var next = 0
    private var held: HomeClock.Day?
    private var cancel: (@Sendable () -> Void)?

    public init(kept: HomeClock? = nil, now: @escaping @Sendable () -> Date = { AppClock.now },
                zone: @escaping @Sendable () -> TimeZone = { TimeZone.current }, wait: @escaping Wait = ClockInUse.sleep) {
        installed = kept?.id == nil ? nil : kept
        self.now = now
        self.zone = zone
        self.wait = wait
    }

    public var clock: HomeClock {
        Self.pinned ?? lock.withLock { inUse() }
    }

    public var revision: Int {
        lock.withLock { changes }
    }

    public struct Snapshot: Sendable {
        public let clock: HomeClock
        public let revision: Int
    }

    public var snapshot: Snapshot {
        lock.withLock { Snapshot(clock: inUse(), revision: changes) }
    }

    public func telling<Result>(by snapshot: Snapshot, _ work: () throws -> Result) rethrows -> Result {
        try Self.$pinned.withValue(snapshot.clock, operation: work)
    }

    @TaskLocal private static var pinned: HomeClock?

    public func dayAt(_ ms: Int64) -> HomeClock.Day {
        clock.dayAt(ms)
    }

    public func dayAt(_ date: Date) -> HomeClock.Day {
        clock.dayAt(date)
    }

    public func today() -> String {
        dayAt(now()).day
    }

    public func follow(_ link: HomeLink) {
        link.onHomeClock { [weak self, weak link] in
            guard let link else { return }
            self?.adopt(link.keptClock)
        }
        adopt(link.keptClock)
    }

    public func adopt(_ kept: HomeLink.KeptClock) {
        tell(lock.withLock {
            guard kept.revision > adopted else { return nil }
            adopted = kept.revision
            return kept.clock.map(put) ?? letGo()
        })
    }

    public func install(_ clock: HomeClock) {
        tell(lock.withLock { put(clock) })
    }

    public func reset() {
        tell(lock.withLock { letGo() })
    }

    private func put(_ clock: HomeClock) -> [@Sendable () -> Void]? {
        guard let id = clock.id, installed?.id != id else { return nil }
        installed = clock
        return changed()
    }

    private func letGo() -> [@Sendable () -> Void]? {
        guard installed != nil else { return nil }
        (installed, placeholder) = (nil, nil)
        return changed()
    }

    private func changed() -> [@Sendable () -> Void]? {
        changes += 1
        guard !listeners.isEmpty else { return nil }
        arm()
        return Array(listeners.values)
    }

    private func tell(_ listeners: [@Sendable () -> Void]?) {
        listeners?.forEach { $0() }
    }

    public func inFront() {
        turned()
    }

    @discardableResult
    public func onChange(_ listener: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        let key: Int = lock.withLock {
            next += 1
            listeners[next] = listener
            if listeners.count == 1 { arm() }
            return next
        }
        return { [weak self] in self?.stop(key) }
    }

    private func stop(_ key: Int) {
        let cancelled: (@Sendable () -> Void)? = lock.withLock {
            listeners[key] = nil
            guard listeners.isEmpty else { return nil }
            defer { (cancel, held) = (nil, nil) }
            return cancel
        }
        cancelled?()
    }

    private func turned() {
        let told: [@Sendable () -> Void]? = lock.withLock {
            guard !listeners.isEmpty else { return nil }
            let was = held?.day
            arm()
            return held?.day == was ? nil : Array(listeners.values)
        }
        told?.forEach { $0() }
    }

    private func arm() {
        cancel?()
        let at = now()
        let today = inUse().dayAt(at)
        held = today
        let seconds = max(0, TimeInterval(today.endMs) / 1000 - at.timeIntervalSince1970)
        cancel = wait(seconds) { [weak self] in self?.turned() }
    }

    private func inUse() -> HomeClock {
        if let installed { return installed }
        if let placeholder { return placeholder }
        let made = HomeClock.placeholder(at: now(), zone: zone())
        placeholder = made
        return made
    }

    public static let sleep: Wait = { seconds, then in
        let task = Task {
            try? await Task.sleep(for: .seconds(seconds))
            if !Task.isCancelled { then() }
        }
        return { task.cancel() }
    }
}
