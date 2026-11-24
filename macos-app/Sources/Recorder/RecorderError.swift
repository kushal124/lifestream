import Foundation

public enum RecorderError: Error, Equatable, LocalizedError {
    case stillPausing
    case alreadyActive

    public var errorDescription: String? {
        switch self {
        case .stillPausing: return "Recorder is still pausing; retry when stopped"
        case .alreadyActive: return "Recorder is already active or pausing"
        }
    }
}
