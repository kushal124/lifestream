import SwiftUI

public struct AskStartHeading: View {
    let words: String
    @Environment(\.cockpitPlatform) private var platform

    public init(_ words: String = "What shall we look back on?") {
        self.words = words
    }

    public var body: some View {
        Text(words)
            .cockpit(platform == .ios ? Cockpit.Style.iosGreeting : Cockpit.Style.macGreeting)
            .foregroundStyle(Cockpit.Color.text)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
    }
}

public struct AskStartRow: View {
    let icon: Cockpit.Icon?
    let words: String
    let action: () -> Void
    @Environment(\.cockpitPlatform) private var platform

    public init(_ icon: Cockpit.Icon?, _ words: String, action: @escaping () -> Void) {
        self.icon = icon
        self.words = words
        self.action = action
    }

    public var body: some View {
        let phone = platform == .ios
        Button(action: action) {
            HStack(spacing: phone ? Cockpit.Space.s3 + 2 : Cockpit.Space.s3) {
                Group {
                    if let icon { Icon(icon, size: phone ? .md : .sm) } else { Color.clear }
                }
                .frame(width: phone ? Cockpit.Size.iconMd : Cockpit.Size.iconSm)
                .foregroundStyle(Cockpit.Color.textSecondary)
                Text(words)
                    .cockpit(phone ? .body : .subhead)
                    .foregroundStyle(Cockpit.Color.text)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, phone ? Cockpit.Space.s1 : Cockpit.Space.s3)
            .frame(minHeight: phone ? 48 : 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(Cockpit.Pressable.row(platform, forced: nil))
        .accessibilityElement(children: .combine)
    }
}
