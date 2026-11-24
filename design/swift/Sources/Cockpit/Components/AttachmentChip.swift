import SwiftUI

public struct AttachmentChip: View {
    public enum Lead {
        case icon(Cockpit.Icon)
        case picture(Image)
    }

    public enum Act {
        case kept(open: (() -> Void)?, remove: () -> Void)
        case offered(add: () -> Void)
    }

    let title: String
    let lead: Lead
    let act: Act
    @Environment(\.cockpitPlatform) private var platform

    public init(_ title: String, lead: Lead, act: Act) {
        self.title = title
        self.lead = lead
        self.act = act
    }

    private var height: CGFloat { platform == .ios ? Cockpit.Size.controlSm : 28 }
    private var reach: CGFloat { max(0, platform.hitSize - height) / 2 }

    public var body: some View {
        Group {
            switch act {
            case let .kept(open, remove): kept(open: open, remove: remove)
            case let .offered(add): offered(add: add)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func kept(open: (() -> Void)?, remove: @escaping () -> Void) -> some View {
        let capsule = Capsule(style: .continuous)
        return HStack(spacing: 0) {
            if let open {
                Button(action: open) { face }
                    .buttonStyle(.plain)
                    .accessibilityLabel(title)
                    .accessibilityAddTraits(.isLink)
                    .accessibilityIdentifier("attachment.open")
            } else {
                face
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(title)
            }
            Button(action: remove) {
                Icon(.close, size: .sm)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .padding(.trailing, platform == .ios ? 8 : 6)
                    .frame(height: height)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(title)")
            .help("Remove")
            .accessibilityIdentifier("attachment.remove")
        }
        .foregroundStyle(Cockpit.Color.text)
        .background(capsule.fill(Cockpit.Color.raised))
        .clipShape(capsule)
        .padding(.vertical, reach)
        .contentShape(Rectangle())
        .padding(.vertical, -reach)
    }

    private var face: some View {
        HStack(spacing: platform == .ios ? 6 : 5) {
            leading
            words
        }
        .padding(.leading, platform == .ios ? 10 : 9)
        .padding(.trailing, platform == .ios ? 6 : 5)
        .frame(height: height)
        .contentShape(Rectangle())
    }

    private func offered(add: @escaping () -> Void) -> some View {
        let capsule = Capsule(style: .continuous)
        return Button(action: add) {
            HStack(spacing: platform == .ios ? 6 : 5) {
                Icon(.add, size: .sm)
                if case .picture = lead { leading }
                words
            }
            .padding(.leading, platform == .ios ? 9 : 8)
            .padding(.trailing, platform == .ios ? 12 : 10)
            .frame(height: height)
        }
        .buttonStyle(Cockpit.Pressable(forced: nil) { label, state in
            label
                .foregroundStyle(Cockpit.Color.textSecondary)
                .background { if let state { capsule.fill(RowChrome<EmptyView>.color(state)) } }
                .overlay { capsule.strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border) }
                .contentShape(capsule)
                .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
                .padding(.vertical, reach)
                .contentShape(Rectangle())
                .padding(.vertical, -reach)
        })
        .accessibilityLabel(title)
        .accessibilityIdentifier("attachment.add")
    }

    private var words: some View {
        Text(title)
            .cockpit(.rowTitle)
            .lineLimit(1)
            .truncationMode(.middle)
    }

    @ViewBuilder private var leading: some View {
        switch lead {
        case let .icon(icon):
            Icon(icon, size: .sm)
        case let .picture(image):
            let size = platform == .ios ? CGSize(width: 16, height: 24) : CGSize(width: 30, height: 20)
            let shape = RoundedRectangle(cornerRadius: platform == .ios ? 3 : 4, style: .continuous)
            image
                .resizable()
                .scaledToFill()
                .frame(width: size.width, height: size.height, alignment: .top)
                .clipShape(shape)
                .overlay { shape.strokeBorder(Cockpit.Color.hairline, lineWidth: Cockpit.Stroke.hairline) }
                .accessibilityHidden(true)
        }
    }
}
