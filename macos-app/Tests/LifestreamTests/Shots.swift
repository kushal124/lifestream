import AppKit
import SwiftUI
import XCTest

@MainActor enum Shots {
    nonisolated static let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent(".build/shots")
    nonisolated static let e2e = folder.deletingLastPathComponent().appendingPathComponent("e2e")

    @discardableResult
    static func draw<Content: View>(_ name: String, size: CGSize, scale: CGFloat? = nil, in folder: URL = folder,
                                    @ViewBuilder _ view: () -> Content) async throws -> [URL] {
        let content = view()
        var written: [URL] = []
        for (suffix, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            written.append(try await write(hosting(content, size: size), appearance: appearance, to: "\(name)-\(suffix).png", scale: scale, in: folder))
        }
        return written
    }

    static func hosting(_ view: some View, size: CGSize) -> NSView {
        let hosting = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        hosting.frame = NSRect(origin: .zero, size: size)
        return hosting
    }

    @discardableResult
    static func write(_ view: NSView, appearance: NSAppearance.Name, to file: String, scale: CGFloat? = nil,
                      in folder: URL = folder) async throws -> URL {
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance)
        window.contentView = view
        var bitmap: NSBitmapImageRep?
        try await until("\(file) drew something") {
            view.layoutSubtreeIfNeeded()
            bitmap = try? drawing(view, appearance: appearance, scale: scale)
            return bitmap.map(inked) ?? false
        }
        let png = try XCTUnwrap(bitmap?.representation(using: .png, properties: [:]))
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(file)
        try png.write(to: url)
        print("drawn: \(url.path)")
        return url
    }

    private static func drawing(_ view: NSView, appearance: NSAppearance.Name, scale: CGFloat?) throws -> NSBitmapImageRep {
        let bitmap: NSBitmapImageRep
        if let scale {
            bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(view.bounds.width * scale),
                                                    pixelsHigh: Int(view.bounds.height * scale), bitsPerSample: 8, samplesPerPixel: 4,
                                                    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            bitmap.size = view.bounds.size
        } else {
            bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        }
        if let data = bitmap.bitmapData { data.initialize(repeating: 0, count: bitmap.bytesPerRow * bitmap.pixelsHigh) }
        NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance { view.cacheDisplay(in: view.bounds, to: bitmap) }
        return bitmap
    }

    private static func inked(_ bitmap: NSBitmapImageRep) -> Bool {
        guard let data = bitmap.bitmapData else { return false }
        return UnsafeBufferPointer(start: data, count: bitmap.bytesPerRow * bitmap.pixelsHigh).contains { $0 != 0 }
    }
}
