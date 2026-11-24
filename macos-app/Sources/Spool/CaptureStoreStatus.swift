import Foundation

public struct CaptureStoreStatus: Codable, Equatable, Sendable {
    public var recordCount: Int
    public var incompleteCount: Int
    public var latestCapture: Date?

    public init(recordCount: Int, incompleteCount: Int, latestCapture: Date?) {
        self.recordCount = recordCount
        self.incompleteCount = incompleteCount
        self.latestCapture = latestCapture
    }
}
