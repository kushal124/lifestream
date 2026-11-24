import Foundation

public enum HealthAsk: Equatable, Sendable {
    case first
    case answered
    case newTypes

    public var reads: Bool { self != .first }

    public static let answeredKey = "health.answered"
    public static let anchorPrefix = "health-anchor."
    public static let yieldedPrefix = "health.yielded."
    public static let startPrefix = "health.start."
}

extension CaptureStore {
    public func healthAsk(complete: Bool) throws -> HealthAsk {
        let marked = try anchor(HealthAsk.answeredKey) != nil
        var earlier = false
        if !marked {
            let read = try anchors(prefix: HealthAsk.anchorPrefix)
            let yielded = try anchors(prefix: HealthAsk.yieldedPrefix)
            earlier = !read.isEmpty || !yielded.isEmpty
        }
        guard marked || earlier || complete else { return .first }
        if !marked { try setAnchor(HealthAsk.answeredKey, Data([1])) }
        return complete ? .answered : .newTypes
    }
}
