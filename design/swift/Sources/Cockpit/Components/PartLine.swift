import SwiftUI

public struct PartLine: View {
    public struct Part: Hashable, Sendable {
        let words: String
        let here: Bool

        public init(_ words: String, here: Bool = false) {
            self.words = words
            self.here = here
        }
    }

    let parts: [Part]
    let role: Cockpit.Role
    let ink: Color
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ parts: [Part], role: Cockpit.Role = .subhead, ink: Color = Cockpit.Color.textSecondary) {
        self.parts = parts
        self.role = role
        self.ink = ink
    }

    public init(_ words: [String], role: Cockpit.Role = .subhead, ink: Color = Cockpit.Color.textSecondary) {
        self.init(words.map { Part($0) }, role: role, ink: ink)
    }

    static var dot: CGFloat { 7 }

    public var body: some View {
        let space = (TypeScale.pointSize(platform.style(role), typeSize) * 0.26).rounded(.toNearestOrAwayFromZero)
        lines(space)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(parts.map(\.words).joined(separator: " · "))
        .accessibilityAddTraits(.isStaticText)
    }

    @ViewBuilder private func lines(_ space: CGFloat) -> some View {
        if platform == .ios, !parts.contains(where: \.here) {
            text(parts.map(\.words).joined(separator: " · ")).lineLimit(1).truncationMode(.tail)
        } else {
            flow(space)
        }
    }

    private func flow(_ space: CGFloat) -> some View {
        FlowLayout(spacing: space, lineSpacing: 0) {
            ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                let words = index < parts.count - 1 ? part.words + Words.trail : part.words
                if part.here {
                    HStack(alignment: .capCentre, spacing: Cockpit.Space.s1 + 2) {
                        Circle()
                            .fill(Cockpit.Color.here)
                            .frame(width: Self.dot, height: Self.dot)
                            .alignmentGuide(.capCentre) { $0.height / 2 }
                        text(words).capCentre(role)
                    }
                } else {
                    text(words)
                }
            }
        }
    }

    private func text(_ words: String) -> some View {
        Text(words)
            .cockpit(role)
            .foregroundStyle(ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private enum Words {
        static let trail = "\u{00A0}·"
    }
}
