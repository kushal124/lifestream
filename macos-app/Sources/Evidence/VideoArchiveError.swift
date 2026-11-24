import Foundation

public enum VideoArchiveOperation: String, Sendable {
    case startWriting = "start movie writing"
    case appendFrame = "append encoded frame"
    case finishWriting = "finish movie writing"
    case loadTracks = "load movie tracks"
    case startReading = "start movie reading"
    case decodeFrame = "decode movie frame"
}

public enum VideoArchiveError: Error, Equatable, CustomStringConvertible, LocalizedError {
    case busy
    case invalidInput
    case invalidReference
    case corruptSegment
    case hardwareUnavailable
    case codec(Int32)
    case timeout(VideoArchiveOperation)
    case cancelled
    case media(operation: VideoArchiveOperation, domain: String, code: Int?)

    public var description: String {
        switch self {
        case .media(let operation, let domain, let code):
            let detail = code.map { " (\(domain), code \($0))" } ?? " (no platform error code)"
            return "Could not \(operation.rawValue)\(detail); pending images remain available"
        case .busy:
            return "Another video archive operation is already running; retry after it completes"
        case .invalidInput:
            return "Video input has invalid dimensions, pixels, or encoding parameters"
        case .invalidReference:
            return "Video reference does not match the saved observation, segment, or supported encoding"
        case .corruptSegment:
            return "Video segment failed integrity or frame validation; retain its pending source images"
        case .hardwareUnavailable:
            return "The required hardware HEVC encoder is unavailable; no frame is kept without it"
        case .codec(let status):
            return "Video codec failed with OSStatus \(status); pending images remain available for retry"
        case .timeout(let operation):
            return "Could not \(operation.rawValue) within 15 seconds; retry with pending images intact"
        case .cancelled:
            return "Video archival was cancelled before publication"
        }
    }

    public var errorDescription: String? { description }
}
