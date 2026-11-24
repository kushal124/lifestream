import SwiftUI

public struct ChatRow: View {
    let title: String
    let selected: Bool
    let running: Bool
    let action: () -> Void
    var forced: RowHighlight?
    @Environment(\.cockpitPlatform) private var platform

    public init(_ title: String, selected: Bool = false, running: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.selected = selected
        self.running = running
        self.action = action
    }

    public var body: some View {
        let phone = platform == .ios
        Button(action: action) {
            HStack(spacing: Cockpit.Space.s2) {
                Text(title)
                    .cockpit(phone ? .body : .subhead)
                    .foregroundStyle(Cockpit.Color.text)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if running { Loading("Answering", size: .glyph) }
            }
            .padding(.horizontal, phone ? Cockpit.Space.s3 : Cockpit.Space.s2)
            .frame(minHeight: phone ? Cockpit.Size.row : Cockpit.Size.rowMac)
            .contentShape(Rectangle())
        }
        .buttonStyle(Cockpit.Pressable.row(platform, selected: selected, forced: forced))
        .padding(.horizontal, phone ? Cockpit.Space.s2 : 0)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

public struct ChatLabel: View {
    let words: String
    @Environment(\.cockpitPlatform) private var platform

    public init(_ words: String) {
        self.words = words
    }

    public var body: some View {
        Text(words)
            .cockpit(.footnote)
            .foregroundStyle(Cockpit.Color.textTertiary)
            .padding(.horizontal, platform == .ios ? Cockpit.Space.s5 : Cockpit.Space.s2)
            .padding(.top, platform == .ios ? 18 : Cockpit.Space.s3)
            .padding(.bottom, Cockpit.Space.s1 + 2)
            .accessibilityAddTraits(.isHeader)
    }
}
