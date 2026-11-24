import SwiftUI

struct FocusRing: View {
    let radius: CGFloat
    var forced = false
    @Environment(\.isFocused) private var focused

    var body: some View {
        if focused || forced {
            let out = Cockpit.Stroke.focusOffset + Cockpit.Stroke.focus / 2
            RoundedRectangle(cornerRadius: radius + out, style: .continuous)
                .stroke(Cockpit.Color.focus, lineWidth: Cockpit.Stroke.focus)
                .padding(-out)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}
