import CoreGraphics
import Evidence

extension CaptureRect {
    init(_ rect: CGRect) {
        self.init(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
    }
}

extension CGRect {
    init(_ rect: CaptureRect) {
        self.init(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
    }
}
