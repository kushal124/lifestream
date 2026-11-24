import SwiftUI

public struct LiveBadge: View {
    public init() {}

    public var body: some View {
        HStack(spacing: Cockpit.Space.s1) {
            Icon(.live, size: .sm)
            Text(verbatim: "LIVE").cockpit(.caption2)
        }
        .foregroundStyle(Cockpit.Color.text)
        .padding(.leading, 6)
        .padding(.trailing, Cockpit.Space.s2)
        .frame(height: Cockpit.Size.capsule)
        .cockpitGlass(in: Capsule())
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Live Photo")
        .accessibilityIdentifier("viewer.live")
    }
}
