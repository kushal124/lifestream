import SwiftUI

public struct PersonFace: View {
    @Environment(\.cockpitPlatform) private var platform
    let name: String?
    let photo: Image?
    let size: Monogram.Size
    let badge: Bool
    let loading: Bool
    @Environment(\.redactionReasons) private var redaction

    public init(_ name: String?, photo: Image? = nil, size: Monogram.Size = .row, badge: Bool = false, loading: Bool = false) {
        self.name = name
        self.photo = photo
        self.size = size
        self.badge = badge
        self.loading = loading
    }

    private static let disc: CGFloat = 22
    private static let past: CGFloat = 3
    private static let cut: CGFloat = 2

    public var body: some View {
        if badge, !redaction.skeleton {
            let at = size.side + Self.past - Self.disc / 2
            ZStack(alignment: .topLeading) {
                face
                Circle()
                    .frame(width: Self.disc + 2 * Self.cut, height: Self.disc + 2 * Self.cut)
                    .position(x: at, y: at)
                    .blendMode(.destinationOut)
                Circle()
                    .fill(Cockpit.Color.raised)
                    .frame(width: Self.disc, height: Self.disc)
                    .overlay { Icon(.photo, size: .xs).foregroundStyle(Cockpit.Color.textSecondary) }
                    .position(x: at, y: at)
                    .accessibilityHidden(true)
            }
            .frame(width: size.side, height: size.side)
            .compositingGroup()
        } else {
            face
        }
    }

    private var face: some View {
        let side = size.side
        return Group {
            if platform == .ios, loading, photo == nil, !redaction.skeleton {
                Circle().fill(Cockpit.Color.raised).frame(width: side, height: side)
            } else {
                Monogram(name, size: size)
            }
        }
            .overlay {
                if let photo, !redaction.skeleton {
                    photo
                        .resizable()
                        .scaledToFill()
                        .frame(width: side, height: side)
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border))
                        .accessibilityHidden(true)
                        .transition(platform == .ios ? .identity : .opacity)
                }
            }
            .animation(platform == .ios ? nil : .easeOut(duration: Cockpit.Duration.fast), value: photo == nil)
    }
}
