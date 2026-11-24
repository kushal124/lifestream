import SwiftUI

extension View {
    func hitArea(_ platform: Cockpit.Platform) -> some View {
        let pad: CGFloat = platform == .ios ? 12 : 4
        return padding(pad).contentShape(Rectangle()).padding(-pad)
    }
}
