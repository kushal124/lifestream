import SwiftUI

public struct FoldRow: View {
    let title: String
    let count: Int
    @Binding var open: Bool
    let separator: Bool
    var forced: RowHighlight?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ title: String, count: Int, open: Binding<Bool>, separator: Bool = false) {
        self.title = title
        self.count = count
        self._open = open
        self.separator = separator
    }

    private var number: some View {
        Text(count.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))))
            .cockpit(.monoData)
            .monospacedDigit()
            .foregroundStyle(Cockpit.Color.textTertiary)
            .fixedSize()
    }

    public var body: some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.base)) { open.toggle() }
        } label: {
            HStack(spacing: platform == .ios ? Cockpit.Space.s3 : Cockpit.Space.s2) {
                HStack(alignment: .firstTextBaseline, spacing: platform == .ios ? 6 : Cockpit.Space.s2) {
                    Text(title)
                        .cockpit(.subhead)
                        .foregroundStyle(platform == .ios ? Cockpit.Color.textTertiary : Cockpit.Color.textSecondary)
                        .cockpitLines(1)
                    number
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Icon(.forward, size: platform == .ios ? .sm : .xs)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .rotationEffect(.degrees(platform == .ios ? (open ? 270 : 90) : (open ? 90 : 0)))
                    .padding(.trailing, platform == .ios ? -2 : 0)
            }
            .padding(.horizontal, platform.rowInset)
            .padding(.vertical, platform == .ios ? Cockpit.Space.s3 : 6)
            .frame(minHeight: platform.rowHeight)
            .overlay(alignment: .bottom) {
                if separator {
                    Rectangle()
                        .fill(Cockpit.Color.rule)
                        .frame(height: platform.ruleHeight)
                        .padding(.horizontal, platform.rowInset)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(Cockpit.Pressable.row(platform, forced: forced))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(count)")
        .accessibilityValue(open ? "Expanded" : "Collapsed")
        .accessibilityAddTraits(.isButton)
    }
}
