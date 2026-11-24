import SwiftUI

public struct Kbd: View {
    let keys: String
    @Environment(\.cockpitPlatform) private var platform

    public init(_ keys: String) {
        self.keys = keys
    }

    public var body: some View {
        Text(keys)
            .cockpit(.footnote)
            .tracking(0.2)
            .foregroundStyle(Cockpit.Color.textTertiary)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 7)
            .frame(minWidth: 20, minHeight: 20)
            .background(Capsule().fill(Cockpit.Color.raised))
    }
}
