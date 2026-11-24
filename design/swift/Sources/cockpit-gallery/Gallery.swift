#if os(macOS)
import AppKit
import ObjectiveC
import SwiftUI
@testable import Cockpit

struct Sheet {
    let name: String
    let width: (ios: CGFloat, mac: CGFloat)
    let hosted: Bool
    let platforms: [Cockpit.Platform]
    let content: @MainActor () -> AnyView

    init<V: View>(_ name: String, ios: CGFloat = 390, mac: CGFloat = 420, hosted: Bool = false,
                  platforms: [Cockpit.Platform] = Cockpit.Platform.allCases, @ViewBuilder content: @escaping @MainActor () -> V) {
        self.name = name
        self.width = (ios, mac)
        self.hosted = hosted
        self.platforms = platforms
        self.content = { AnyView(content()) }
    }
}

struct Specimen<Content: View>: View {
    let label: String
    let content: Content
    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .textCase(.uppercase)
                .foregroundStyle(Cockpit.Color.textTertiary)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct OnPhone<Content: View>: View {
    @ViewBuilder let content: Content
    @Environment(\.cockpitPlatform) private var platform
    var body: some View {
        if platform == .ios { content }
    }
}

enum Theme: CaseIterable {
    case dark, light, darkHC, lightHC

    var title: String {
        switch self {
        case .dark: "Dark"
        case .light: "Light"
        case .darkHC: "Dark · Increase Contrast"
        case .lightHC: "Light · Increase Contrast"
        }
    }
    var scheme: ColorScheme { self == .dark || self == .darkHC ? .dark : .light }
    var high: Bool { self == .darkHC || self == .lightHC }
}

@MainActor enum IncreaseContrast {
    nonisolated(unsafe) static var on = false
    static func install() {
        let selector = #selector(getter: NSWorkspace.accessibilityDisplayShouldIncreaseContrast)
        guard let method = class_getInstanceMethod(NSWorkspace.self, selector) else { return }
        let block: @convention(block) (AnyObject) -> Bool = { _ in IncreaseContrast.on }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }
}

@MainActor enum Renderer {
    static func write(_ sheet: Sheet, platform: Cockpit.Platform, to folder: URL) throws {
        let width = platform == .ios ? sheet.width.ios : sheet.width.mac
        let height = Theme.allCases.map { render(sheet, platform: platform, theme: $0, width: width, height: nil)?.height ?? 0 }.max() ?? 0
        let columns = Theme.allCases.compactMap { render(sheet, platform: platform, theme: $0, width: width, height: CGFloat(height) / scale) }
        let pixelsWide = columns.reduce(0) { $0 + $1.width }
        guard let context = CGContext(data: nil, width: pixelsWide, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        var x = 0
        for column in columns {
            context.draw(column, in: CGRect(x: x, y: height - column.height, width: column.width, height: column.height))
            x += column.width
        }
        guard let composed = context.makeImage() else { return }
        let png = NSBitmapImageRep(cgImage: composed).representation(using: .png, properties: [:])
        try png?.write(to: folder.appendingPathComponent("\(platform.rawValue)-\(sheet.name).png"))
    }

    static let scale: CGFloat = 2

    private static func render(_ sheet: Sheet, platform: Cockpit.Platform, theme: Theme, width: CGFloat, height: CGFloat?) -> CGImage? {
        IncreaseContrast.on = theme.high
        let view = VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("\(sheet.name) · \(platform == .ios ? "iPhone" : "Mac")")
                Spacer()
                Text(theme.title)
            }
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .textCase(.uppercase)
            .foregroundStyle(Cockpit.Color.textTertiary)
            sheet.content()
        }
        .padding(platform.margin)
        .frame(width: width, alignment: .topLeading)
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: width, height: height, alignment: .topLeading)
        .groundColor(Cockpit.Color.canvas)
        .environment(\.colorScheme, theme.scheme)
        .environment(\._colorSchemeContrast, theme.high ? .increased : .standard)
        .cockpitPlatform(platform)
        .environment(\.breathForced, 0.3)
        if sheet.hosted { return hostedImage(view, theme: theme, width: width, height: height) }
        let renderer = ImageRenderer(content: view)
        renderer.scale = scale
        renderer.proposedSize = ProposedViewSize(width: width, height: height)
        return renderer.cgImage
    }

    private static func hostedImage<V: View>(_ view: V, theme: Theme, width: CGFloat, height: CGFloat?) -> CGImage? {
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 100), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: theme.scheme == .dark ? .darkAqua : .aqua)
        window.contentView = host
        host.frame.size = NSSize(width: width, height: height ?? host.fittingSize.height)
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        host.cacheDisplay(in: host.bounds, to: rep)
        return (rep.converting(to: .sRGB, renderingIntent: .default) ?? rep).cgImage
    }
}
#endif
