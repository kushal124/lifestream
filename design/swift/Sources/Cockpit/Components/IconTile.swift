import SwiftUI

public struct IconTile: View {
    let meaning: Cockpit.Icon
    let side: CGFloat?
    let radius: CGFloat?
    let ink: Color
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.redactionReasons) private var redaction

    public init(_ meaning: Cockpit.Icon, side: CGFloat? = nil, radius: CGFloat? = nil, ink: Color = Cockpit.Color.text) {
        self.meaning = meaning
        self.side = side
        self.radius = radius
        self.ink = ink
    }

    public var body: some View {
        let side = side ?? platform.iconColumn
        RoundedRectangle(cornerRadius: radius ?? platform.tileRadius, style: .continuous)
            .fill(Cockpit.Color.raised)
            .frame(width: side, height: side)
            .overlay {
                if !redaction.skeleton {
                    Icon(meaning, size: side >= Cockpit.Size.target ? .lg : side >= Cockpit.Size.controlSm ? .md : .sm)
                        .foregroundStyle(ink)
                }
            }
    }
}
