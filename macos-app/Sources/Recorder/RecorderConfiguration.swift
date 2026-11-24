import Foundation

public struct RecorderConfiguration: Sendable, Equatable {
    public internal(set) var interval: Double
    public let duration: Double?
    public internal(set) var idlePauseAfter: Double?

    public init(interval: Double = 2, duration: Double? = nil, idlePauseAfter: Double? = nil) {
        self.interval = interval
        self.duration = duration
        self.idlePauseAfter = idlePauseAfter
    }

    func shouldPauseForIdle(_ seconds: Double?) -> Bool {
        guard let idlePauseAfter, let seconds, seconds.isFinite, seconds >= 0 else { return false }
        return seconds >= idlePauseAfter
    }
}
