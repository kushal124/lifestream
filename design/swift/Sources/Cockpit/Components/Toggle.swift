import SwiftUI

public extension ToggleStyle where Self == CockpitToggleStyle {
    static var cockpit: CockpitToggleStyle { CockpitToggleStyle() }
    static func cockpit(waiting: Bool) -> CockpitToggleStyle { CockpitToggleStyle(waiting: waiting) }
}

public struct CockpitToggleStyle: ToggleStyle {
    let waiting: Bool

    public init(waiting: Bool = false) {
        self.waiting = waiting
    }

    public func makeBody(configuration: Configuration) -> some View {
        CockpitToggle(configuration: configuration, waiting: waiting)
    }

    static func spoken(waiting: Bool) -> String? { waiting ? "Waiting" : nil }
}

private struct CockpitToggle: View {
    let configuration: ToggleStyleConfiguration
    let waiting: Bool
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.inSettingSection) private var inSection

    var body: some View {
        if #available(iOS 18, macOS 15, *) {
            LabelsVisibility { row(labelled: $0) }
        } else {
            row(labelled: true)
        }
    }

    private func row(labelled: Bool) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(spacing: Cockpit.Space.s4) {
                if labelled {
                    _VariadicView.Tree(ToggleLabel()) { configuration.label }
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Switch(on: configuration.isOn, waiting: waiting, platform: platform, sectioned: inSection, reduceMotion: reduceMotion)
            }
            .frame(minHeight: labelled ? platform.rowHeight : nil)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
        .animation(slide, value: configuration.isOn)
        .animation(slide, value: waiting)
        .accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label }.toggleStyle(.switch) }
        .modifier(SpokenValue(words: CockpitToggleStyle.spoken(waiting: waiting)))
    }
}

extension CockpitToggle {
    private var slide: Animation {
        if reduceMotion { return .easeInOut(duration: Cockpit.Duration.fast) }
        return inSection ? .easeOut(duration: Cockpit.Duration.fold) : Cockpit.Ease.spring()
    }
}

@available(iOS 18, macOS 15, *)
private struct LabelsVisibility<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content
    @Environment(\.labelsVisibility) private var visibility
    var body: some View { content(visibility != .hidden) }
}

private struct ToggleLabel: _VariadicView_MultiViewRoot {
    @MainActor func body(children: _VariadicView.Children) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(children.enumerated()), id: \.element.id) { index, child in
                if index == 0 {
                    child.cockpit(.body).foregroundStyle(Cockpit.Color.text)
                } else {
                    child.cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary)
                }
            }
        }
    }
}

private struct SpokenValue: ViewModifier {
    let words: String?

    func body(content: Content) -> some View {
        if let words { content.accessibilityValue(words) } else { content }
    }
}

private struct Switch: View {
    let on: Bool
    let waiting: Bool
    let platform: Cockpit.Platform
    let sectioned: Bool
    let reduceMotion: Bool

    var body: some View {
        let (width, height, inset): (CGFloat, CGFloat, CGFloat) = platform == .ios ? (51, 31, 2) : sectioned ? (36, 20, 2) : (32, 18, 1)
        let lit = on || waiting
        ZStack(alignment: lit ? .trailing : .leading) {
            Capsule().fill(waiting ? Cockpit.Color.caution : on ? Cockpit.Color.engaged : (sectioned ? Cockpit.Color.track : Cockpit.Color.data4))
            Capsule().strokeBorder(Cockpit.Color.strokeControl, lineWidth: Cockpit.Stroke.border).opacity(lit ? 0 : 1)
            knob(inset: inset, side: height - inset * 2)
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }

    @ViewBuilder private func knob(inset: CGFloat, side: CGFloat) -> some View {
        let knob = Circle()
            .fill(Cockpit.Color.knob)
            .cockpitShadow(Cockpit.Shadow.knob, in: Circle())
            .frame(width: side, height: side)
            .padding(inset)
        if reduceMotion { knob.id(on).transition(.opacity) } else { knob }
    }
}
