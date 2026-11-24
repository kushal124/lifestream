import Foundation

public enum RecorderControlError: Error, CustomStringConvertible {
    case alreadyRunning
    case unavailable
    case invalidRequest
    case oversized
    case timeout
    case invalidResponse
    case unsafePath
    case system(Int32)

    public var description: String {
        switch self {
        case .alreadyRunning: return "A recorder app already owns this capture directory"
        case .unavailable: return "Recorder app is not running for this capture directory"
        case .invalidRequest: return "Invalid control request"
        case .oversized: return "Control message exceeds its size limit"
        case .timeout: return "Recorder control request timed out"
        case .invalidResponse: return "Invalid recorder control response"
        case .unsafePath: return "Recorder control directory has unsafe ownership or permissions"
        case .system(let code): return "Recorder control failed (errno \(code))"
        }
    }
}
