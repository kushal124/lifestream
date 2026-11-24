import Foundation

public struct CaptureOCRScope: Codable, Equatable, Sendable {
    public var requested: String
    public var effective: String
    public var focusedPID: Int32

    public init(requested: String, effective: String, focusedPID: Int32) {
        self.requested = requested
        self.effective = effective
        self.focusedPID = focusedPID
    }
}
