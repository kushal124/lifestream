import Foundation

public enum RecorderStatement: Equatable, Sendable {
    case recording
    case starting
    case paused
    case interrupted(Cause)

    public enum Cause: String, CaseIterable, Sendable {
        case disk, permission, browser, capture, away
        case `private`
    }

    var stated: [String: Any] {
        switch self {
        case .recording: return ["state": "recording"]
        case .starting: return ["state": "starting"]
        case .paused: return ["state": "paused"]
        case .interrupted(let cause): return ["state": "interrupted", "cause": cause.rawValue]
        }
    }
}
