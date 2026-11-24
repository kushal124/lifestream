import SwiftUI

public struct HiddenSpotCard<Map: View>: View {
    let id: String
    let known: String
    let hidden: String
    let unhide: (() -> Void)?
    let open: (() -> Void)?
    let map: Map
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cockpitPlatform) private var platform

    public static var mapHeight: CGFloat { 128 }

    public init(id: String, known: String, hidden: String, unhide: (() -> Void)?, open: (() -> Void)? = nil,
                @ViewBuilder map: () -> Map) {
        self.id = id
        self.known = known
        self.hidden = hidden
        self.unhide = unhide
        self.open = open
        self.map = map()
    }

    private var phone: Bool { platform == .ios }

    public var body: some View {
        if let open {
            Button(action: open) { card }
                .buttonStyle(CardPress(shape: RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous)))
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
        } else {
            card
        }
    }

    @ViewBuilder private var card: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous)
        let inner = RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            map
                .frame(height: Self.mapHeight)
                .frame(maxWidth: .infinity)
                .clipShape(phone ? AnyShape(Rectangle()) : AnyShape(inner))
            VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                if !known.isEmpty {
                    Text(known)
                        .cockpit(.rowTitle)
                        .foregroundStyle(Cockpit.Color.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityHidden(true)
                }
                HStack(spacing: Cockpit.Space.s3) {
                    Text(hidden)
                        .cockpit(.monoData)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel(known.isEmpty ? hidden : "\(known), \(hidden)")
                        .accessibilityIdentifier("hidden.known.\(id)")
                    if let unhide {
                        Button("Unhide", action: unhide)
                            .buttonStyle(.cockpit(.secondary, size: .small))
                            .accessibilityIdentifier("hidden.unhide.\(id)")
                    }
                }
            }
            .padding(.horizontal, phone ? Cockpit.Space.s4 : Cockpit.Space.s2)
            .padding(.top, Cockpit.Space.s3)
            .padding(.bottom, phone ? Cockpit.Space.s3 : Cockpit.Space.s1)
        }
        .padding(phone ? 0 : Cockpit.Space.s2)
        .background { shape.fill(Cockpit.Color.surface) }
        .clipShape(phone ? AnyShape(shape) : AnyShape(Rectangle().inset(by: -Cockpit.Space.s4)))
        .accessibilityElement(children: .contain)
    }
}

private struct CardPress<S: Shape>: ButtonStyle {
    let shape: S

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay {
                if configuration.isPressed {
                    ZStack {
                        shape.fill(Cockpit.Color.selection)
                        shape.fill(Cockpit.Color.pressed)
                    }
                    .allowsHitTesting(false)
                }
            }
            .contentShape(shape)
    }
}
