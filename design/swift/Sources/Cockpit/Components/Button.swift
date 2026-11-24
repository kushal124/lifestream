import SwiftUI

public struct CockpitButtonStyle: ButtonStyle {
    public enum Kind: Sendable { case primary, secondary, plain }
    public enum Tone: Sendable { case neutral, caution, warning, glyph }
    public enum Size: Sendable { case large, regular, small }

    let kind: Kind
    let tone: Tone
    let size: Size
    let busy: Bool
    let fullWidth: Bool
    let key: String?
    var forced: ButtonState?

    public init(_ kind: Kind = .secondary, tone: Tone = .neutral, size: Size = .regular, busy: Bool = false, fullWidth: Bool = false,
                key: String? = nil) {
        self.kind = kind
        self.tone = tone
        self.size = size
        self.busy = busy
        self.fullWidth = fullWidth
        self.key = key
    }

    public func makeBody(configuration: Configuration) -> some View {
        CockpitButtonBody(configuration: configuration, style: self)
    }

    func fill(on platform: Cockpit.Platform) -> Color {
        if platform == .ios, kind == .primary, tone == .neutral { return Cockpit.Color.accentSolid }
        return fill
    }

    func ink(on platform: Cockpit.Platform, inSection: Bool = false) -> Color {
        if platform == .ios, kind == .primary, tone == .neutral { return Cockpit.Color.accentInk }
        if platform == .ios, kind == .plain, tone == .neutral {
            return inSection ? Cockpit.Color.textSecondary : Cockpit.Color.accent
        }
        return ink
    }

    var fill: Color {
        switch (kind, tone) {
        case (.primary, .neutral), (.primary, .glyph): Cockpit.Color.text
        case (.primary, .caution): Cockpit.Color.caution
        case (.primary, .warning): Cockpit.Color.warning
        case (.secondary, .neutral), (.secondary, .glyph), (.secondary, .warning): Cockpit.Color.raised
        case (.secondary, .caution): Cockpit.Color.cautionSoft
        case (.plain, _): .clear
        }
    }

    var ink: Color {
        switch (kind, tone) {
        case (.primary, .neutral), (.primary, .glyph): Cockpit.Color.textInverse
        case (.primary, _): Cockpit.Color.onSignal
        case (_, .neutral), (_, .glyph): Cockpit.Color.text
        case (_, .caution): Cockpit.Color.caution
        case (_, .warning): Cockpit.Color.warning
        }
    }
}

public extension ButtonStyle where Self == CockpitButtonStyle {
    static func cockpit(_ kind: CockpitButtonStyle.Kind = .secondary, tone: CockpitButtonStyle.Tone = .neutral,
                        size: CockpitButtonStyle.Size = .regular, busy: Bool = false, fullWidth: Bool = false,
                        key: String? = nil) -> CockpitButtonStyle {
        CockpitButtonStyle(kind, tone: tone, size: size, busy: busy, fullWidth: fullWidth, key: key)
    }
}

enum ButtonState { case hover, pressed }

extension EnvironmentValues {
    @Entry var cockpitDone: String?
}

public extension View {
    func cockpitDone(_ word: String?) -> some View {
        environment(\.cockpitDone, word)
    }

    func cockpitDone(_ word: String, after count: Int) -> some View {
        modifier(DoneMoment(word: word, count: count))
    }
}

private struct DoneMoment: ViewModifier {
    let word: String
    let count: Int
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .environment(\.cockpitDone, shown ? word : nil)
            .onChange(of: count) { old, new in
                guard new > old else { return }
                shown = true
            }
            .task(id: shown) {
                guard shown else { return }
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                shown = false
            }
    }
}

private struct CockpitButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let style: CockpitButtonStyle
    @State private var hovering = false
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.isEnabled) private var enabled
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.cockpitButtonHeight) private var asked
    @Environment(\.cockpitDone) private var done
    @Environment(\.cockpitOnRaised) private var onRaised
    @Environment(\.inSettingSection) private var inSection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = ButtonShape(capsule: platform == .ios)
        let fill = style.fill(on: platform)
        let ink = style.ink(on: platform, inSection: inSection)
        let state: ButtonState? = style.forced ?? (configuration.isPressed ? .pressed : hovering && platform == .mac ? .hover : nil)
        let (sized, padding): (CGFloat, CGFloat) = switch (platform, style.size) {
        case (.mac, _): (Cockpit.Size.controlMac, style.kind == .plain ? Cockpit.Space.s2 : Cockpit.Space.s3)
        case (.ios, .large): (Cockpit.Size.controlLg, Cockpit.Space.s6)
        case (.ios, .regular): (Cockpit.Size.controlMd, style.kind == .plain ? Cockpit.Space.s3 : Cockpit.Space.s5)
        case (.ios, .small): (Cockpit.Size.controlSm, style.kind == .plain ? Cockpit.Space.s2 : Cockpit.Space.s4)
        }
        let height = asked ?? sized
        let plainDone = style.kind == .plain && done != nil
        HStack(spacing: Cockpit.Space.s2) {
            if plainDone, let done {
                HStack(spacing: 6) {
                    Icon(.done, size: .sm).foregroundStyle(Cockpit.Color.engaged)
                    Text(done).foregroundStyle(Cockpit.Color.textSecondary).lineLimit(1)
                }
                .transition(.opacity)
            } else {
                configuration.label
            }
            if let key = style.key {
                let keyStyle = platform.style(platform == .mac ? .subhead : style.size == .small ? .caption : .footnote)
                Text(key)
                    .fontWeight(.medium)
                    .tracking(keyStyle.size * 0.04)
                    .cockpit(keyStyle)
                    .foregroundStyle(style.busy ? Color.clear : ink.opacity(0.6))
                    .padding(.leading, 6 - Cockpit.Space.s2)
                    .accessibilityHidden(true)
            }
        }
            .environment(\.cockpitIconSize, platform == .mac || style.size == .small ? .sm : .md)
            .cockpit(platform == .ios && style.size == .small ? .subhead : .headline)
            .fontWeight(platform == .ios && style.kind == .plain ? .regular : platform == .ios && style.size == .small ? .semibold : nil)
            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            .multilineTextAlignment(.center)
            .minimumScaleFactor(typeSize.isAccessibilitySize ? 0.7 : 1)
            .foregroundStyle(style.busy || (done != nil && !plainDone) ? AnyShapeStyle(Color.clear) : AnyShapeStyle(ink))
            .accessibilityHidden(done != nil && !plainDone)
            .overlay {
                if style.busy && done == nil {
                    Spinner().foregroundStyle(ink)
                }
            }
            .foregroundStyle(ink)
            .padding(.horizontal, padding)
            .frame(maxWidth: style.fullWidth ? .infinity : nil, minHeight: height)
            .overlay {
                if let done, !plainDone {
                    HStack(spacing: 6) {
                        Icon(.done, size: .sm).foregroundStyle(Cockpit.Color.engaged)
                        Text(done).cockpit(.headline).foregroundStyle(Cockpit.Color.textSecondary).lineLimit(1)
                    }
                    .transition(.opacity)
                }
            }
            .background { ground(shape, fill: fill, state: state) }
            .overlay { FocusRing(radius: Cockpit.Radius.control) }
            .contentShape(shape)
            .scaleEffect(state == .pressed && !(style.fullWidth && platform == .ios) && !(inSection && reduceMotion) ? 0.97 : 1)
            .opacity(state == .pressed && style.kind != .secondary ? Cockpit.Opacity.pressed : 1)
            .opacity(done != nil ? 1 : style.busy ? Cockpit.Opacity.pressed : enabled ? 1 : Cockpit.Opacity.disabled)
            .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
            .animation(.easeOut(duration: Cockpit.Duration.fast), value: done)
            .padding(.vertical, max(0, platform.hitSize - height) / 2)
            .contentShape(Rectangle())
            .padding(.vertical, -max(0, platform.hitSize - height) / 2)
            .allowsHitTesting(!style.busy && done == nil)
            .accessibilityValue(style.busy ? Text("Busy") : Text(""))
            .onHover { hovering = $0 }
    }

    @ViewBuilder private func ground(_ shape: ButtonShape, fill: Color, state: ButtonState?) -> some View {
        shape.fill(done == nil || style.kind == .plain ? fill : Cockpit.Color.actionDone)
        if onRaised, done == nil, style.kind == .secondary, style.tone == .neutral { shape.fill(Cockpit.Color.pressed) }
        if done != nil, style.kind != .plain { shape.strokeBorder(Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border) }
        if state == .hover || (state == .pressed && style.kind == .secondary) {
            shape.fill(state == .hover ? Cockpit.Color.hover : Cockpit.Color.pressed)
        }
    }
}

private struct ButtonShape: InsettableShape {
    let capsule: Bool
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let inner = rect.insetBy(dx: inset, dy: inset)
        return capsule ? Capsule(style: .continuous).path(in: inner)
            : RoundedRectangle(cornerRadius: Cockpit.Radius.control - inset, style: .continuous).path(in: inner)
    }

    func inset(by amount: CGFloat) -> ButtonShape {
        var shape = self
        shape.inset += amount
        return shape
    }
}
