import SwiftUI

public struct FactChip: View {
    let text: String
    let icon: Cockpit.Icon?
    let label: String?
    let open: (() -> Void)?
    var forced: RowHighlight?
    @Environment(\.cockpitPlatform) private var platform

    public init(_ text: String, icon: Cockpit.Icon? = nil, label: String? = nil, open: (() -> Void)? = nil) {
        self.text = text
        self.icon = icon
        self.label = label
        self.open = open
    }

    static let height: CGFloat = 24

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.control, style: .continuous)
        let face = HStack(spacing: 6) {
            if let icon { Icon(icon, size: .sm) }
            Text(text)
                .cockpit(.subhead)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .foregroundStyle(Cockpit.Color.textSecondary)
        .padding(.horizontal, 10)
        .frame(minHeight: Self.height)
        .contentShape(shape)
        if let open {
            let reach = max(0, platform.hitSize - Self.height) / 2
            Button(action: open) { face }
                .buttonStyle(Cockpit.Pressable(forced: forced) { label, state in
                    label
                        .background { if let state { shape.fill(RowChrome<EmptyView>.color(state)) } }
                        .overlay { shape.strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border) }
                        .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
                        .padding(.vertical, reach)
                        .contentShape(Rectangle())
                        .padding(.vertical, -reach)
                })
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label ?? text)
                .accessibilityAddTraits(.isLink)
        } else {
            face
                .overlay { shape.strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border) }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label ?? text)
        }
    }
}

public struct FactChips<Content: View>: View {
    let centred: Bool
    let content: Content

    public init(centred: Bool = false, @ViewBuilder content: () -> Content) {
        self.centred = centred
        self.content = content()
    }

    public var body: some View {
        FlowLayout(spacing: Cockpit.Space.s2, lineSpacing: Cockpit.Space.s2, centred: centred) { content }
    }
}
