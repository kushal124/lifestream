import Foundation

public enum CaptureStoreError: Error, CustomStringConvertible {
    case writerAlreadyRunning
    case readOnly
    case archiveBacklogFull
    case videoEncoderUnavailable
    case invalidObservation
    case corruptBundle(String)
    case io(String, Int32)
    case bundleFailure(name: String, cause: Error)
    case publishedNotFlushed(end: Date, cause: Error)

    public var description: String {
        switch self {
        case .bundleFailure(let name, let cause):
            return "Cannot read capture bundle \(name): \(cause)"
        case .writerAlreadyRunning:
            return "Another recorder owns this capture directory"
        case .readOnly:
            return "This capture store is read-only"
        case .archiveBacklogFull:
            return "The capture volume is full; images wait for space"
        case .videoEncoderUnavailable:
            return "The hardware HEVC encoder could not take the image; it was not kept"
        case .invalidObservation:
            return "Invalid capture observation"
        case .corruptBundle(let path):
            return "Invalid capture bundle: \(path)"
        case .io(let operation, let code):
            return "Capture storage \(operation) failed (errno \(code))"
        case .publishedNotFlushed(_, let cause):
            return "A capture bundle was published but not flushed: \(cause)"
        }
    }
}
