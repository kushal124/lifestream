import Foundation

public struct CaptureAcquisition: Codable, Equatable, Sendable {
    public var backend: String
    public var receivedAt: Date
    public var freshness: String

    public init(backend: String, receivedAt: Date, freshness: String) {
        self.backend = backend
        self.receivedAt = receivedAt
        self.freshness = freshness
    }
}
