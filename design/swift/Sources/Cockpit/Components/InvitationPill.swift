import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

public struct InvitationPill<Mark: View>: View {
    let count: Int
    let words: String
    let label: String
    let action: () -> Void
    let mark: Mark
    var forced = false
    @ScaledMetric(relativeTo: .subheadline) private var chevron = Cockpit.Size.iconXs
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.cockpitPlatform) private var platform

    public init(count: Int, words: String, label: String, action: @escaping () -> Void, @ViewBuilder mark: () -> Mark) {
        self.count = count
        self.words = words
        self.label = label
        self.action = action
        self.mark = mark()
    }

    public var body: some View {
        Button(action: action) {
            HStack(alignment: .capCentre, spacing: Cockpit.Space.s2) {
                if platform != .ios { mark }
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(count.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))))
                        .cockpit(platform == .ios ? .subhead : .monoData)
                        .fontWeight(platform == .ios ? .semibold : .medium)
                        .monospacedDigit()
                    Text(words)
                        .cockpit(platform == .ios ? .subhead : .rowTitle)
                        .fontWeight(platform == .ios ? .semibold : nil)
                        .capCentre(platform == .ios ? .subhead : .rowTitle)
                }
                .foregroundStyle(Cockpit.Color.text)
                if platform != .ios {
                    IconShape(meaning: .forward)
                        .fill(Cockpit.Color.textTertiary)
                        .frame(width: chevron, height: chevron)
                }
            }
            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            .fixedSize(horizontal: !typeSize.isAccessibilitySize, vertical: true)
            .padding(.leading, 10)
            .padding(.trailing, Cockpit.Space.s2)
            .padding(.vertical, 6)
            .frame(minHeight: Cockpit.Size.controlSm)
        }
        .buttonStyle(Cockpit.Pressable(forced: forced ? .touched(platform) : nil) { label, state in
            let shape = Capsule(style: .continuous)
            return label
                .background {
                    ZStack {
                        shape.fill(Cockpit.Color.raised)
                        if let state { shape.fill(state == .hover ? Cockpit.Color.hover : Cockpit.Color.pressed) }
                    }
                    .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
                }
                .cockpitShadow(platform == .ios ? .none : Cockpit.Shadow.edge, in: shape)
                .contentShape(shape)
                .hitArea(platform)
        })
        .alignmentGuide(.capCentre) { $0.height / 2 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isButton)
    }
}

public extension VerticalAlignment {
    static let capCentre = VerticalAlignment(CapCentre.self)
}

private enum CapCentre: AlignmentID {
    static func defaultValue(in dimensions: ViewDimensions) -> CGFloat { dimensions[VerticalAlignment.center] }
}

public extension View {
    func capCentre(_ role: Cockpit.Role) -> some View {
        modifier(CapCentreText(role: role))
    }
}

private struct CapCentreText: ViewModifier {
    let role: Cockpit.Role
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.dynamicTypeSize) private var typeSize

    func body(content: Content) -> some View {
        let caps = Self.capHeight(platform.style(role), typeSize)
        return content.alignmentGuide(.capCentre) { $0[.firstTextBaseline] - caps / 2 }
    }

    static func capHeight(_ style: Cockpit.TextStyle, _ typeSize: DynamicTypeSize) -> CGFloat {
        #if os(iOS)
        if let font = TypeScale.font(style, typeSize) { return font.capHeight }
        #endif
        return style.size * 0.705
    }
}

enum TypeScale {
    static func pointSize(_ style: Cockpit.TextStyle, _ typeSize: DynamicTypeSize) -> CGFloat {
        #if os(iOS)
        if let font = font(style, typeSize) { return font.pointSize }
        #endif
        return style.size
    }

    #if os(iOS)
    static func font(_ style: Cockpit.TextStyle, _ typeSize: DynamicTypeSize) -> UIFont? {
        guard let textStyle = style.textStyle.flatMap(uiTextStyle) else { return nil }
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
        return UIFont.preferredFont(forTextStyle: textStyle, compatibleWith: traits)
    }

    private static func uiTextStyle(_ style: Font.TextStyle) -> UIFont.TextStyle? {
        switch style {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .subheadline: .subheadline
        case .body: .body
        case .callout: .callout
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: nil
        }
    }
    #endif
}
