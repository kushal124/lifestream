import Foundation

public enum CaptureImage: Equatable, Sendable {
    case png(Data)
    case raw(RawFrame)
}
