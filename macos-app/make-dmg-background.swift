import AppKit
import CoreText

guard CommandLine.arguments.count == 4, let scale = Double(CommandLine.arguments[2]),
      FileManager.default.fileExists(atPath: CommandLine.arguments[3]) else {
    FileHandle.standardError.write(Data("usage: swift make-dmg-background.swift OUTPUT.png SCALE APP\n".utf8))
    exit(2)
}
let river = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("design/river", isDirectory: true)
guard let photo = NSImage(contentsOf: river.appendingPathComponent("river-2000.webp")),
      let photoPixels = photo.representations.first.map({ CGSize(width: $0.pixelsWide, height: $0.pixelsHigh) }),
      CTFontManagerRegisterFontsForURL(river.appendingPathComponent("geist.woff2") as CFURL, .process, nil) else {
    FileHandle.standardError.write(Data("make-dmg-background: design/river holds no river-2000.webp or geist.woff2\n".utf8))
    exit(1)
}

let window = CGSize(width: 700, height: 400)
let app = CGPoint(x: 176, y: 130)
let applications = CGPoint(x: 524, y: 130)
let fadeFrom: CGFloat = 40
let blackFrom: CGFloat = 200
func rgb(_ hex: Int, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}
let ink = rgb(0xEDF1F2)
let soft = rgb(0x8F9CA0)
let ground = { (alpha: CGFloat) in rgb(0x0C1215, alpha) }

let pixels = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(window.width * scale), pixelsHigh: Int(window.height * scale),
                              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                              colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
pixels.size = window
NSGraphicsContext.saveGraphicsState()
let context = NSGraphicsContext(bitmapImageRep: pixels)!
NSGraphicsContext.current = context
context.imageInterpolation = .high
let whole = NSRect(origin: .zero, size: window)

let cover = max(window.width / photoPixels.width, window.height / photoPixels.height)
let shown = CGSize(width: photoPixels.width * cover, height: photoPixels.height * cover)
photo.draw(in: NSRect(x: (window.width - shown.width) * 0.5, y: (window.height - shown.height) * 0.4, width: shown.width, height: shown.height))

NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.22).setFill()
whole.fill(using: .sourceOver)
ground(0.45).setFill()
whole.fill(using: .sourceOver)
let stops = (0...48).map { CGFloat($0) / 48 }
let fade = NSGradient(colors: stops.map { NSColor.black.withAlphaComponent($0 * $0 * $0 * ($0 * ($0 * 6 - 15) + 10)) },
                      atLocations: stops, colorSpace: .sRGB)
fade?.draw(in: NSRect(x: 0, y: window.height - blackFrom, width: window.width, height: blackFrom - fadeFrom), angle: -90)
NSColor.black.setFill()
NSRect(x: 0, y: 0, width: window.width, height: window.height - blackFrom).fill()

func flip(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x, y: window.height - point.y) }

let start = flip(CGPoint(x: 290, y: app.y))
let end = flip(CGPoint(x: 408, y: applications.y))
let arrow = NSBezierPath()
arrow.lineWidth = 2
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.move(to: start)
arrow.line(to: end)
arrow.move(to: CGPoint(x: end.x - 10, y: end.y + 8))
arrow.line(to: end)
arrow.line(to: CGPoint(x: end.x - 10, y: end.y - 8))
ink.withAlphaComponent(0.6).setStroke()
arrow.stroke()

NSWorkspace.shared.icon(forFile: CommandLine.arguments[3])
  .draw(in: NSRect(x: app.x - 64, y: window.height - app.y - 64, width: 128, height: 128))

func geist(_ size: CGFloat, _ weight: NSFont.Weight) -> NSFont {
    let traits: [NSFontDescriptor.TraitKey: Any] = [.weight: weight]
    let descriptor = NSFontDescriptor(fontAttributes: [.family: "Geist", .traits: traits])
    return NSFont(descriptor: descriptor, size: size) ?? .systemFont(ofSize: size, weight: weight)
}
func centred(_ string: String, font: NSFont, tracking: CGFloat, color: NSColor, at y: CGFloat) {
    let line = NSAttributedString(string: string, attributes: [.font: font, .kern: tracking, .foregroundColor: color])
    let measured = line.size()
    line.draw(at: CGPoint(x: (window.width - measured.width) / 2, y: window.height - y - measured.height / 2))
}
centred("Drag Lifestream to Applications", font: geist(26, .medium), tracking: -0.78, color: ink, at: 292)
centred("Then open it from there.", font: geist(13, .regular), tracking: -0.13, color: soft, at: 324)
NSGraphicsContext.restoreGraphicsState()

try pixels.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
