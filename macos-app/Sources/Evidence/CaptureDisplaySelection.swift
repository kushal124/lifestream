import Foundation

public struct CaptureDisplaySelection: Codable, Equatable, Sendable {
    public let policy: String
    public let reason: String
    public let availableCount: Int

    public init(policy: String, reason: String, availableCount: Int) {
        self.policy = policy
        self.reason = reason
        self.availableCount = availableCount
    }
}
