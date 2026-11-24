import SwiftUI

public struct Segmented<ID: Hashable>: View {
    let label: String
    let options: [TabOption<ID>]
    let selection: ID
    let line: String?
    let pick: (ID) -> Void
    @State private var chosen = 0
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.isEnabled) private var enabled

    public init(_ label: String, options: [TabOption<ID>], selection: ID, line: String? = nil, pick: @escaping (ID) -> Void) {
        self.label = label
        self.options = options
        self.selection = selection
        self.line = line
        self.pick = pick
    }

    private var height: CGFloat { platform == .ios ? Cockpit.Size.controlMd : Cockpit.Size.controlMac }

    public var body: some View {
        if let line {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                bar
                Text(verbatim: line)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("segmented.line")
            }
        } else {
            bar
        }
    }

    private var bar: some View {
        HStack(spacing: 0) {
            ForEach(options) { option in segment(option) }
        }
        .padding(2)
        .background(Capsule(style: .continuous).fill(Cockpit.Color.raised))
        .sensoryFeedback(.selection, trigger: chosen)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    private func segment(_ option: TabOption<ID>) -> some View {
        let shown = option.id == selection
        return Button {
            guard !shown else { return }
            if platform == .ios { chosen += 1 }
            pick(option.id)
        } label: {
            Text(option.label)
                .cockpit(platform == .ios ? Cockpit.Style.iosRowTitle : platform.style(.headline))
                .lineLimit(1)
                .foregroundStyle(shown ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                .frame(maxWidth: .infinity, minHeight: height - 4)
                .background(Capsule(style: .continuous).fill(shown ? Cockpit.Color.selection : .clear))
                .contentShape(Capsule(style: .continuous))
                .animation(.easeOut(duration: Cockpit.Duration.instant), value: shown)
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : 0.6)
        .accessibilityLabel(option.label)
        .accessibilityAddTraits(shown ? .isSelected : [])
        .accessibilityIdentifier(option.identifier ?? "")
    }
}
