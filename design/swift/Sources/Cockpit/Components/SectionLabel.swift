import SwiftUI

public struct SectionLabel: View {
    let title: String
    let about: String?
    let count: Int?
    let atLeast: Bool
    let action: String?
    let perform: (() -> Void)?
    let open: (() -> Void)?
    let actionIdentifier: String?
    let aside: String?
    var forced = false
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.cockpitHeadStrong) private var headStrong

    public init(_ title: String, about: String? = nil, count: Int? = nil, atLeast: Bool = false, action: String? = nil,
                perform: (() -> Void)? = nil, open: (() -> Void)? = nil, actionIdentifier: String? = nil, aside: String? = nil) {
        self.aside = aside
        self.title = title
        self.about = about
        self.count = count
        self.atLeast = atLeast
        self.action = action
        self.perform = perform
        self.open = open
        self.actionIdentifier = actionIdentifier
    }

    public var body: some View {
        drawn
            .padding(.top, platform == .ios ? -Self.overCaps : 0)
            .padding(.bottom, platform == .ios ? -Self.underBaseline : 0)
    }

    private static var overCaps: CGFloat { 6 }
    private static var underBaseline: CGFloat { 4 }

    @ViewBuilder private var drawn: some View {
        if let open {
            Button(action: open) {
                HStack(spacing: Cockpit.Space.s2) {
                    words
                    Spacer(minLength: 0)
                    Icon(.forward, size: platform == .ios ? .sm : .xs)
                        .foregroundStyle(platform == .ios ? Cockpit.Color.textTertiary : rest)
                        .padding(.trailing, platform == .ios ? -4 : 0)
                }
                .frame(minHeight: platform == .ios ? 28 : 24)
            }
            .buttonStyle(Cockpit.Pressable(forced: forced ? .touched(platform) : nil) { label, state in
                label
                    .foregroundStyle(state == nil ? rest : platform == .ios ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                    .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
                    .contentShape(Rectangle())
                    .hitArea(platform)
            })
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(count.map { "\(title), \(atLeast ? "at least " : "")\($0)" } ?? title)
            .accessibilityAddTraits(.isHeader)
        } else if action == nil {
            HStack(alignment: .center, spacing: Cockpit.Space.s1) {
                labelWords
                if let about { InfoMark(about, label: title) }
                if let aside {
                    Spacer(minLength: Cockpit.Space.s3)
                    SectionAside(words: aside)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
        } else if platform == .ios, !typeSize.isAccessibilitySize {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
                labelWords.lineLimit(1)
                Spacer(minLength: 0)
                actionButton.fixedSize()
            }
            .frame(minHeight: 24)
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
                    labelWords.fixedSize()
                    Spacer(minLength: 0)
                    actionButton.fixedSize()
                }
                VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                    labelWords
                    actionButton
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 24)
        }
    }

    private var rest: Color { strong ? Cockpit.Color.text : platform == .ios ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary }
    private var strong: Bool { platform == .ios && headStrong }

    private var labelWords: some View {
        words
            .foregroundStyle(rest)
            .accessibilityAddTraits(.isHeader)
    }

    private var actionButton: some View {
        Button(action: { perform?() }) {
            HStack(spacing: 2) {
                Text(action ?? "").cockpit(platform == .ios ? .subhead : .footnote)
                Icon(.forward, size: .xs).padding(.trailing, platform == .ios ? -3.4 : 0)
            }
            .foregroundStyle(platform == .ios ? Cockpit.Color.accent : Cockpit.Color.textSecondary)
            .hitArea(platform)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(actionIdentifier ?? "")
    }

    private var words: some View {
        HStack(alignment: .firstTextBaseline, spacing: platform == .ios ? 6 : Cockpit.Space.s2) {
            Text(title)
                .cockpit(.monoLabel)
                .fontWeight(strong ? .semibold : nil)
                .cockpitLines(1)
            if let count {
                Text(count.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))) + (atLeast ? "+" : ""))
                    .cockpit(.monoLabel)
                    .tracking(0)
                    .monospacedDigit()
                    .foregroundStyle(platform == .ios ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary)
                    .fixedSize()
            }
        }
    }
}

struct SectionAside: View {
    let words: String
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        Text(words)
            .cockpit(platform == .ios ? Cockpit.Style.iosFootnote : platform.style(.footnote))
            .monospacedDigit()
            .foregroundStyle(Cockpit.Color.textTertiary)
            .lineLimit(1)
            .fixedSize()
    }
}
