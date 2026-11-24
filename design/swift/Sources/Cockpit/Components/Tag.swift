import SwiftUI

public struct Tag: View {
    let text: String
    let tone: Cockpit.SignalKind?
    let mono: Bool
    @Environment(\.cockpitPlatform) private var platform

    public init(_ text: String, tone: Cockpit.SignalKind? = nil, mono: Bool = false) {
        self.text = text
        self.tone = tone
        self.mono = mono
    }

    public var body: some View {
        HStack(spacing: 5) {
            if let tone { SignalShape(tone, size: 10) }
            Text(text)
                .cockpit(mono ? .monoData : .label)
                .foregroundStyle(tone.map(\.wordColor) ?? Cockpit.Color.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, platform == .ios ? 10 : Cockpit.Space.s2)
        .frame(minHeight: platform == .ios ? 24 : 20)
        .background {
            let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.control, style: .continuous)
            switch tone {
            case .plan?: shape.strokeBorder(Cockpit.Color.plan, style: StrokeStyle(lineWidth: Cockpit.Stroke.border, dash: Cockpit.Dash.plan))
            case let tone?: shape.fill(tone.soft)
            case nil: shape.fill(Cockpit.Color.raised)
            }
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}
