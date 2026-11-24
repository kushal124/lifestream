import SwiftUI

public struct IconButton: View {
    public enum Style: Sendable { case glass, raised, plain }
    public enum Size: Sendable { case regular, medium, small }

    let icon: Cockpit.Icon
    let label: String
    let style: Style
    let size: Size
    let weight: Icon.Weight
    let action: () -> Void
    var forced: ButtonState?

    public init(_ icon: Cockpit.Icon, label: String, style: Style = .plain, size: Size = .regular, weight: Icon.Weight = .regular,
                action: @escaping () -> Void) {
        self.icon = icon
        self.label = label
        self.style = style
        self.size = size
        self.weight = weight
        self.action = action
    }

    public var body: some View {
        Button(action: action) { Icon(icon, weight: weight) }
            .buttonStyle(IconButtonStyle(style: style, size: size, forced: forced))
            .accessibilityLabel(label)
            .help(label)
    }
}

private struct IconButtonStyle: ButtonStyle {
    let style: IconButton.Style
    let size: IconButton.Size
    let forced: ButtonState?
    func makeBody(configuration: Configuration) -> some View {
        IconButtonBody(configuration: configuration, style: style, size: size, forced: forced)
    }
}

private struct IconButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let style: IconButton.Style
    let size: IconButton.Size
    let forced: ButtonState?
    @State private var hovering = false
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        let state: ButtonState? = forced ?? (configuration.isPressed ? .pressed : hovering && platform == .mac ? .hover : nil)
        let (side, glyph): (CGFloat, Cockpit.IconSize) = switch (platform, size) {
        case (.mac, _): (Cockpit.Size.controlMac, .sm)
        case (.ios, .regular): (Cockpit.Size.controlMd, .lg)
        case (.ios, .medium): (36, .sm)
        case (.ios, .small): (Cockpit.Size.controlSm, .sm)
        }
        let reach = max(0, platform.hitSize - side) / 2
        let corner = style == .glass || platform == .ios ? side / 2 : Cockpit.Radius.control
        configuration.label
            .environment(\.cockpitIconSize, glyph)
            .foregroundStyle(Cockpit.Color.text)
            .frame(width: side, height: side)
            .background { ground(state) }
            .overlay { FocusRing(radius: corner) }
            .contentShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
            .scaleEffect(state == .pressed ? 0.94 : 1)
            .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
            .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
            .padding(reach)
            .contentShape(Rectangle())
            .padding(-reach)
            .onHover { hovering = $0 }
    }

    @ViewBuilder private func ground(_ state: ButtonState?) -> some View {
        let overlay = state.map { $0 == .hover ? Cockpit.Color.hover : Cockpit.Color.pressed } ?? .clear
        let control = RoundedRectangle(cornerRadius: platform == .ios ? Cockpit.Size.controlMd / 2 : Cockpit.Radius.control, style: .continuous)
        switch style {
        case .glass:
            Circle().fill(state == .pressed ? Cockpit.Color.pressed : .clear).cockpitGlass(in: Circle())
        case .raised:
            ZStack { control.fill(Cockpit.Color.raised); control.fill(overlay) }
        case .plain:
            control.fill(overlay)
        }
    }
}


public extension View {
    func cockpitGlass<S: InsettableShape>(in shape: S, interactive: Bool = true) -> some View {
        modifier(GlassChrome(shape: shape, interactive: interactive))
    }
}

struct GlassChrome<S: InsettableShape>: ViewModifier {
    let shape: S
    let interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.cockpitSystemGlass) private var systemGlass

    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(shape.fill(Cockpit.Color.overlay)).cockpitShadow(Cockpit.Shadow.raised, in: shape)
        } else if #available(iOS 26, macOS 26, *), systemGlass {
            content.glassEffect(.regular.interactive(interactive), in: shape)
        } else {
            content
                .background(shape.fill(Cockpit.Color.glass))
                .background(shape.fill(.ultraThinMaterial))
                .cockpitShadow(Cockpit.Shadow.glass, in: shape)
        }
    }
}

private struct SystemGlassKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    var cockpitSystemGlass: Bool {
        get { self[SystemGlassKey.self] }
        set { self[SystemGlassKey.self] = newValue }
    }
}
