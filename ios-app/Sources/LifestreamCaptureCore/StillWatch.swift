import Foundation

public enum StillWatch {
    public static let stillInterval: TimeInterval = 130
    public static let movingInterval: TimeInterval = 30
    public static let checkTimeout: TimeInterval = 30
    public static let lateTimers: TimeInterval = 15
    public static let movementHeard: TimeInterval = 60
    public static let stillReach: Double = 150
    public static let confirmGap: TimeInterval = 3
    public static let homeSilence: TimeInterval = 180

    public static func clusterReach(centreAccuracy: Double, fixAccuracy: Double) -> Double? {
        guard centreAccuracy >= 0, fixAccuracy >= 0 else { return nil }
        return max(20, min(100, max(centreAccuracy, fixAccuracy) * 2))
    }

    public struct Fix: Sendable {
        public let madeAt: TimeInterval
        public let stated: TimeInterval
        public let distance: Double
        public let accuracy: Double

        public init(madeAt: TimeInterval, stated: TimeInterval, distance: Double, accuracy: Double) {
            self.madeAt = madeAt
            self.stated = stated
            self.distance = distance
            self.accuracy = accuracy
        }
    }

    public enum Verdict: Equatable, Sendable {
        case nothing
        case still
        case doubt
        case left
    }

    public struct Check: Sendable {
        public let began: TimeInterval
        private let centreAccuracy: Double
        private var outside: ClosedRange<TimeInterval>?
        public private(set) var newestFresh: TimeInterval?

        public var inDoubt: Bool { outside != nil }

        public init(began: TimeInterval, centreAccuracy: Double) {
            self.began = began
            self.centreAccuracy = centreAccuracy
        }

        public mutating func read(_ fix: Fix, movementHeard: Bool, at now: TimeInterval) -> Verdict {
            guard fix.madeAt >= began, fix.madeAt <= now, fix.accuracy >= 0 else { return .nothing }
            newestFresh = max(newestFresh ?? fix.madeAt, fix.madeAt)
            let cluster = StillWatch.clusterReach(centreAccuracy: max(0, centreAccuracy), fixAccuracy: fix.accuracy) ?? StillWatch.stillReach
            let reach = movementHeard ? cluster : StillWatch.stillReach
            guard fix.distance - fix.accuracy > reach else {
                outside = nil
                return .still
            }
            let span = min(outside?.lowerBound ?? fix.stated, fix.stated)...max(outside?.upperBound ?? fix.stated, fix.stated)
            outside = span
            return span.upperBound - span.lowerBound >= StillWatch.confirmGap ? .left : .doubt
        }
    }

    public struct Watch: Sendable {
        private enum Phase: Sendable {
            case recording(quietEnds: TimeInterval?)
            case asleep(next: TimeInterval, since: TimeInterval)
            case checking(Check)
        }

        private let stillInterval: TimeInterval
        private let movingInterval: TimeInterval
        private let checkTimeout: TimeInterval
        private var phase = Phase.recording(quietEnds: nil)
        private var quiet: TimeInterval?
        private var centreAccuracy: Double = -1
        private var movementAt: TimeInterval?

        public init(
            stillInterval: TimeInterval = StillWatch.stillInterval, movingInterval: TimeInterval = StillWatch.movingInterval,
            checkTimeout: TimeInterval = StillWatch.checkTimeout
        ) {
            self.stillInterval = stillInterval
            self.movingInterval = movingInterval
            self.checkTimeout = checkTimeout
        }

        public var nextCheck: TimeInterval? {
            if case .asleep(let next, _) = phase { next } else { nil }
        }

        public var checkEnds: TimeInterval? {
            if case .checking(let check) = phase { check.began + checkTimeout } else { nil }
        }

        public var quietEnds: TimeInterval? {
            if case .recording(let ends) = phase { ends } else { nil }
        }

        public mutating func settled(at now: TimeInterval, centreAccuracy: Double) {
            self.centreAccuracy = centreAccuracy
            phase = .asleep(next: now + (heard(at: now) ? movingInterval : stillInterval), since: now)
        }

        public mutating func recording(at now: TimeInterval, quiet: TimeInterval?) {
            self.quiet = quiet
            phase = .recording(quietEnds: quiet.map { now + $0 })
        }

        public mutating func fixDelivered(at now: TimeInterval, quiet: TimeInterval) {
            guard case .recording(.some) = phase else { return }
            self.quiet = quiet
            phase = .recording(quietEnds: now + quiet)
        }

        public mutating func beginQuietCheck(at now: TimeInterval, centreAccuracy: Double) {
            guard case .recording = phase else { return }
            self.centreAccuracy = centreAccuracy
            phase = .checking(Check(began: now, centreAccuracy: centreAccuracy))
        }

        public mutating func movementHeard(at now: TimeInterval) {
            let begins = !heard(at: now)
            movementAt = now
            guard case .asleep(let next, let since) = phase else { return }
            phase = .asleep(next: min(next, begins ? now : max(now, since + movingInterval)), since: since)
        }

        public mutating func regionExited(at now: TimeInterval) {
            movementAt = now
            if case .asleep(_, let since) = phase { phase = .asleep(next: now, since: since) }
        }

        public mutating func beginCheck(at now: TimeInterval) {
            guard case .asleep = phase else { return }
            phase = .checking(Check(began: now, centreAccuracy: centreAccuracy))
        }

        public mutating func read(_ fix: Fix, at now: TimeInterval) -> Verdict {
            guard case .checking(var check) = phase else { return .nothing }
            let verdict = check.read(fix, movementHeard: heard(at: now), at: now)
            switch verdict {
            case .still: sleep(after: check, at: now)
            case .left: phase = .recording(quietEnds: quiet.map { now + $0 })
            case .doubt, .nothing: phase = .checking(check)
            }
            return verdict
        }

        @discardableResult
        public mutating func checkTimedOut(at now: TimeInterval) -> Bool {
            guard case .checking(let check) = phase else { return true }
            sleep(after: check, at: now)
            return check.newestFresh != nil
        }

        private func heard(at now: TimeInterval) -> Bool {
            movementAt.map { now - $0 < StillWatch.movementHeard } ?? false
        }

        private mutating func sleep(after check: Check, at now: TimeInterval) {
            let next = check.inDoubt || heard(at: now)
                ? now + movingInterval
                : min(check.newestFresh ?? check.began, now) + stillInterval
            phase = .asleep(next: next, since: now)
        }
    }
}
