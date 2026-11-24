import Foundation

enum OCRStatus: String, Sendable {
    case complete = "complete"
    case completeFullColorSpaceChanged = "complete-full-color-space-changed"
    case completeFullFirst = "complete-full-first"
    case completeFullIncompatibleStorage = "complete-full-incompatible-storage"
    case completeFullPixelLayoutChanged = "complete-full-pixel-layout-changed"
    case completeFullPixelsChanged = "complete-full-pixels-changed"
    case completeFullPixelsUnavailable = "complete-full-pixels-unavailable"
    case completeFullUnsupportedImage = "complete-full-unsupported-image"
    case completeReusedTiles = "complete-reused-tiles"
    case failed = "failed"
    case reusedExactImage = "reused-exact-image"
}
