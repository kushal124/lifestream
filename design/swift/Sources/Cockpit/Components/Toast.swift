import SwiftUI

public struct Toast: View {
    let title: String
    let line: String?
    @Environment(\.cockpitPlatform) private var platform

    public init(_ title: String, line: String? = nil) {
        self.title = title
        self.line = line
    }

    public var body: some View {
        let phone = platform == .ios
        HStack(spacing: phone ? Cockpit.Space.s2 + 2 : Cockpit.Space.s2) {
            Icon(.done, size: .xs)
                .foregroundStyle(Cockpit.Color.accentInk)
                .frame(width: phone ? 22 : 16, height: phone ? 22 : 16)
                .background(Circle().fill(Cockpit.Color.engaged))
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .cockpit(phone ? .subhead : .body)
                    .fontWeight(.semibold)
                    .foregroundStyle(Cockpit.Color.text)
                if let line {
                    Text(line)
                        .cockpit(.footnote)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, phone ? 14 : 12)
        .padding(.trailing, phone ? 20 : 16)
        .padding(.vertical, Cockpit.Space.s2)
        .frame(minHeight: phone ? 48 : 40)
        .modifier(GlassChrome(shape: Capsule(style: .continuous), interactive: false))
        .accessibilityElement(children: .combine)
    }
}
