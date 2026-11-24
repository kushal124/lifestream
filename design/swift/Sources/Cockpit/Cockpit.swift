import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public enum Cockpit {
    public struct RGBA: Sendable, Equatable {
        public let red, green, blue, alpha: Double
        public init(_ red: Double, _ green: Double, _ blue: Double, _ alpha: Double) {
            self.red = red; self.green = green; self.blue = blue; self.alpha = alpha
        }
        #if canImport(UIKit)
        var platform: UIColor { UIColor(red: red, green: green, blue: blue, alpha: alpha) }
        #elseif canImport(AppKit)
        var platform: NSColor { NSColor(srgbRed: red, green: green, blue: blue, alpha: alpha) }
        #endif
    }

    static func dynamic(dark: RGBA, light: RGBA, darkHC: RGBA, lightHC: RGBA) -> SwiftUI.Color {
        #if canImport(UIKit)
        return SwiftUI.Color(uiColor: UIColor { traits in
            let high = traits.accessibilityContrast == .high
            if traits.userInterfaceStyle == .dark { return (high ? darkHC : dark).platform }
            return (high ? lightHC : light).platform
        })
        #elseif canImport(AppKit)
        return SwiftUI.Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) != .aqua
            let high = highContrastNames.contains(appearance.name) || NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
            return (isDark ? (high ? darkHC : dark) : (high ? lightHC : light)).platform
        })
        #endif
    }

    #if canImport(AppKit) && !canImport(UIKit)
    private static let highContrastNames: Set<NSAppearance.Name> = [.accessibilityHighContrastDarkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastVibrantDark, .accessibilityHighContrastVibrantLight]
    #endif

    public struct TextStyle: Sendable {
        public let size: CGFloat
        public let lineHeight: CGFloat
        public let weight: Int
        public let design: Font.Design
        public let textStyle: Font.TextStyle?
        public let tracking: CGFloat
        public let italic: Bool
        public let tabular: Bool
        public let uppercase: Bool

        public var font: Font {
            #if os(iOS)
            var font: Font = textStyle.map { Font.system($0, design: design) } ?? Font.system(size: size, design: design)
            #else
            var font = Font.system(size: size, design: design)
            #endif
            font = font.weight(Self.weight(weight))
            if italic { font = font.italic() }
            if tabular { font = font.monospacedDigit() }
            return font
        }

        func font(at typeSize: DynamicTypeSize) -> Font {
            #if os(iOS)
            return font
            #else
            guard let textStyle, typeSize != .large else { return font }
            var font = Font.system(size: Cockpit.scaled(size, relativeTo: textStyle, at: typeSize), design: design)
                .weight(Self.weight(weight))
            if italic { font = font.italic() }
            if tabular { font = font.monospacedDigit() }
            return font
            #endif
        }

        static func weight(_ value: Int) -> Font.Weight {
            switch value {
            case ..<350: return .light
            case ..<450: return .regular
            case ..<550: return .medium
            case ..<650: return .semibold
            default: return .bold
            }
        }
    }

    static func scaled(_ value: CGFloat, relativeTo style: Font.TextStyle, at typeSize: DynamicTypeSize) -> CGFloat {
        let sizes = typeSizes(style)
        return value * sizes[typeIndex(typeSize)] / sizes[typeIndex(.large)]
    }

    private static func typeSizes(_ style: Font.TextStyle) -> [CGFloat] {
        switch style {
        case .largeTitle: [31, 32, 33, 34, 36, 38, 40, 44, 48, 52, 56, 60]
        case .title: [25, 26, 27, 28, 30, 32, 34, 38, 43, 48, 53, 58]
        case .title2: [19, 20, 21, 22, 24, 26, 28, 34, 39, 44, 50, 56]
        case .title3: [17, 18, 19, 20, 22, 24, 26, 31, 37, 43, 49, 55]
        case .callout: [13, 14, 15, 16, 18, 20, 22, 26, 32, 38, 44, 51]
        case .subheadline: [12, 13, 14, 15, 17, 19, 21, 25, 30, 36, 42, 49]
        case .footnote: [12, 12, 12, 13, 15, 17, 19, 23, 27, 33, 38, 44]
        case .caption: [11, 11, 11, 12, 14, 16, 18, 22, 26, 32, 37, 43]
        case .caption2: [11, 11, 11, 11, 13, 15, 17, 20, 24, 29, 34, 40]
        default: [14, 15, 16, 17, 19, 21, 23, 28, 33, 40, 47, 53]
        }
    }

    private static func typeIndex(_ size: DynamicTypeSize) -> Int {
        switch size {
        case .xSmall: 0
        case .small: 1
        case .medium: 2
        case .large: 3
        case .xLarge: 4
        case .xxLarge: 5
        case .xxxLarge: 6
        case .accessibility1: 7
        case .accessibility2: 8
        case .accessibility3: 9
        case .accessibility4: 10
        case .accessibility5: 11
        @unknown default: 3
        }
    }

    public struct ShadowLayer: Sendable {
        public let color: RGBA
        public let x, y, blur, spread: CGFloat
        public let inset: Bool
        var swiftUIColor: SwiftUI.Color { SwiftUI.Color(.sRGB, red: color.red, green: color.green, blue: color.blue, opacity: color.alpha) }
    }

    public struct ShadowSet: Sendable {
        public let dark, light, darkHC, lightHC: [ShadowLayer]
        public func layers(_ scheme: ColorScheme, _ contrast: ColorSchemeContrast) -> [ShadowLayer] {
            switch (scheme, contrast) {
            case (.dark, .increased): return darkHC
            case (.dark, _): return dark
            case (_, .increased): return lightHC
            default: return light
            }
        }
    }
}

public extension View {
    func cockpit(_ style: Cockpit.TextStyle) -> some View {
        modifier(CockpitText(style: style))
    }

    func cockpitLines(_ limit: Int?) -> some View {
        modifier(CockpitLines(limit: limit))
    }

    func cockpitShadow(_ shadow: Cockpit.ShadowSet) -> some View {
        modifier(CockpitShadow(shadow: shadow))
    }

    func cockpitShadow<S: InsettableShape>(_ shadow: Cockpit.ShadowSet, in shape: S) -> some View {
        modifier(CockpitShapeShadow(shadow: shadow, shape: shape))
    }
}

struct CockpitText: ViewModifier {
    let style: Cockpit.TextStyle
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.dynamicTypeSize) private var typeSize

    func body(content: Content) -> some View {
        content
            .font(style.font(at: typeSize))
            .tracking(style.tracking)
            .lineSpacing(max(0, style.lineHeight - style.size * 1.2))
            .textCase(style.uppercase ? .uppercase : nil)
            .unredacted(when: redaction.skeleton)
            .opacity(redaction.skeleton ? 0 : 1)
            .overlay(alignment: .topLeading) {
                if redaction.skeleton { SkeletonText(style: style) }
            }
    }
}

struct CockpitShadow: ViewModifier {
    let shadow: Cockpit.ShadowSet
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        shadow.layers(scheme, contrast).filter { !$0.inset && $0.blur > 0 }.reduce(AnyView(content)) { view, layer in
            AnyView(view.shadow(color: layer.swiftUIColor, radius: layer.blur / 2, x: layer.x, y: layer.y))
        }
    }
}

struct CockpitShapeShadow<S: InsettableShape>: ViewModifier {
    let shadow: Cockpit.ShadowSet
    let shape: S
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        let layers = shadow.layers(scheme, contrast)
        content
            .background {
                ZStack {
                    ForEach(Array(layers.enumerated()), id: \.offset) { _, layer in
                        if !layer.inset && layer.blur > 0 {
                            shape.fill(layer.swiftUIColor).blur(radius: layer.blur / 2).offset(x: layer.x, y: layer.y)
                        } else if !layer.inset && layer.spread > 0 {
                            shape.inset(by: -layer.spread / 2).stroke(layer.swiftUIColor, lineWidth: layer.spread)
                        }
                    }
                }
                .mask {
                    Rectangle().padding(-96).overlay { shape.blendMode(.destinationOut) }.compositingGroup()
                }
            }
            .overlay {
                ZStack {
                    ForEach(Array(layers.enumerated()), id: \.offset) { _, layer in
                        if layer.inset {
                            shape.strokeBorder(layer.swiftUIColor, lineWidth: max(layer.spread, abs(layer.y)))
                                .offset(x: layer.x, y: layer.y)
                                .clipShape(shape)
                        }
                    }
                }
                .allowsHitTesting(false)
            }
    }
}

public extension String {
    var breakingAddresses: String {
        guard contains("@") else { return self }
        return split(separator: " ", omittingEmptySubsequences: false).map { word in
            guard word.contains("@") else { return String(word) }
            return word.replacingOccurrences(of: "@", with: "@\u{200B}").replacingOccurrences(of: ".", with: "\u{200B}.")
        }.joined(separator: " ")
    }
}

private struct CockpitLines: ViewModifier {
    let limit: Int?
    @Environment(\.dynamicTypeSize) private var typeSize

    func body(content: Content) -> some View {
        content.lineLimit(typeSize.isAccessibilitySize ? nil : limit)
    }
}
