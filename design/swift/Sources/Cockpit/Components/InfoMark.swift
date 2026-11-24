import SwiftUI

public struct InfoMark: View {
    let sentence: String
    let label: String
    @State private var shown = false
    var forcedOpen = false
    @Environment(\.cockpitPlatform) private var platform

    public init(_ sentence: String, label: String) {
        self.sentence = sentence
        self.label = label
    }

    public var body: some View {
        Button { shown = true } label: {
            Icon(.info, size: .sm)
                .foregroundStyle(Cockpit.Color.textTertiary)
                .frame(width: platform.hitSize, height: platform.hitSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(width: Cockpit.Size.iconSm, height: Cockpit.Size.iconSm)
        .help(sentence)
        .popover(isPresented: $shown, arrowEdge: platform == .mac ? .top : nil) { tip }
        .overlay(alignment: .topLeading) {
            if forcedOpen { tip.fixedSize().offset(x: -Cockpit.Space.s4, y: Cockpit.Size.iconSm + Cockpit.Space.s2) }
        }
        .accessibilityLabel("About \(label)")
        .accessibilityHint(sentence)
    }

    private var tip: some View {
        Text(sentence)
            .cockpit(.subhead)
            .foregroundStyle(Cockpit.Color.text)
            .frame(width: 280, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(Cockpit.Space.s3)
            .background(forcedOpen ? Cockpit.Color.surface : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
            #if os(iOS)
            .presentationCompactAdaptation(.popover)
            .presentationBackground(Cockpit.Color.surface)
            #endif
    }
}
