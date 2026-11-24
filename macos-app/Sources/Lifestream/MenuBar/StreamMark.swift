import AppKit
import Cockpit

enum StreamMark {
    static let side: CGFloat = 18
    static let mark = NSRect(x: 2, y: 2, width: 14, height: 14)
    static let dot = NSRect(x: 14.75, y: 13, width: 3, height: 3)

    static func image(recording: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { _ in
            draw(recording: recording)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = recording ? "Lifestream, recording" : "Lifestream"
        return image
    }

    private static func draw(recording: Bool) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.setFillColor(NSColor.black.cgColor)
        context.addPath(LogoMark.glyph(in: mark).cgPath)
        context.fillPath()
        if recording { context.fillEllipse(in: dot) }
    }
}
