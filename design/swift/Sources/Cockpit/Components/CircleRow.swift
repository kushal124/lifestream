import SwiftUI

public struct CircleRow<Stepper: View>: View {
    let number: Int?
    let reach: String
    let line: String
    let selected: Bool
    let separator: Bool
    let identifier: String?
    let select: () -> Void
    let remove: (() -> Void)?
    let stepper: Stepper
    var forced: RowHighlight?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(number: Int?, reach: String, line: String, selected: Bool = false, separator: Bool = true, identifier: String? = nil,
                select: @escaping () -> Void, remove: (() -> Void)? = nil, @ViewBuilder stepper: () -> Stepper) {
        self.number = number
        self.reach = reach
        self.line = line
        self.selected = selected
        self.separator = separator
        self.identifier = identifier
        self.select = select
        self.remove = remove
        self.stepper = stepper()
    }

    static var centre: CGFloat { 6 }

    private var title: String { number.map { "Circle \($0)" } ?? "Circle" }

    public var body: some View {
        if selected { setting } else { choosing }
    }

    private var choosing: some View {
        Button(action: select) {
            CircleRowFrame(separator: separator) {
                glyph
            } words: {
                let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2))
                layout {
                    titleText.frame(maxWidth: .infinity, alignment: .leading)
                    reachText
                }
                lineText
            } trailing: {
                if remove != nil { Color.clear.frame(width: removeWidth, height: 1) }
            }
        }
        .buttonStyle(Cockpit.Pressable.row(platform, forced: forced))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(reach), \(line)")
        .accessibilityHint("Sets this circle on the map")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(identifier ?? "")
        .overlay(alignment: .trailing) {
            if let remove { removeButton(remove).padding(.trailing, platform.rowInset) }
        }
    }

    private var reachText: some View {
        Group {
            if platform == .ios { Text(reach).cockpit(Cockpit.Style.phoneRowTitle) } else { Text(reach).cockpit(.monoData) }
        }
            .monospacedDigit()
            .foregroundStyle(Cockpit.Color.textSecondary)
            .lineLimit(1)
            .fixedSize()
    }

    private var setting: some View {
        let clear: CGFloat = platform == .ios && !alone ? 4 : 0
        let filled: RowHighlight? = alone ? nil : RowHighlight.selected
        return RowChrome(radius: platform == .ios ? 12 : platform.rowRadius, highlight: forced ?? filled) {
            if platform == .ios {
                CircleRowFrame(separator: separator, led: !alone) { glyph } words: { settingWords } trailing: {
                    if let remove { removeButton(remove) }
                }
                .padding(-clear)
            } else {
                CircleRowFrame(separator: separator) {
                    glyph
                } words: {
                    settingWords
                    stepper.padding(.top, Cockpit.Space.s2)
                } trailing: {
                    if let remove { removeButton(remove) }
                }
            }
        }
        .padding(clear)
        .accessibilityElement(children: .contain)
    }

    private var settingWords: some View {
        VStack(alignment: .leading, spacing: 2) {
            titleText
            lineText
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(line)")
        .accessibilityAddTraits(.isSelected)
        .accessibilityIdentifier(identifier ?? "")
    }

    private var glyph: some View {
        Circle()
            .fill(selected ? Cockpit.Color.life.opacity(0.18) : Color.clear)
            .overlay(Circle().strokeBorder(selected ? Cockpit.Color.life : Cockpit.Color.textTertiary,
                                           lineWidth: selected ? Cockpit.Stroke.line : Cockpit.Stroke.border))
            .overlay { if selected { Circle().fill(Cockpit.Color.life).frame(width: Self.centre, height: Self.centre) } }
            .accessibilityHidden(true)
    }

    private var alone: Bool { number == nil && platform == .ios }

    private var titleText: some View {
        Text(alone ? line : title)
            .cockpit(.rowTitle)
            .foregroundStyle(Cockpit.Color.text)
            .cockpitLines(alone ? 2 : 1)
    }

    @ViewBuilder private var lineText: some View {
        if !alone {
            Text(line)
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .cockpitLines(2)
        }
    }

    private var removeWidth: CGFloat { platform == .ios ? Cockpit.Size.controlSm : Cockpit.Size.controlMac }

    private func removeButton(_ remove: @escaping () -> Void) -> some View {
        IconButton(.close, label: number.map { "Remove circle \($0)" } ?? "Remove circle", style: .plain, size: .small, action: remove)
            .accessibilityIdentifier(identifier.map { "\($0).remove" } ?? "")
    }
}

public struct AddCircleRow: View {
    let full: String?
    let identifier: String?
    let add: () -> Void
    var forced: RowHighlight?
    @Environment(\.cockpitPlatform) private var platform

    let alone: Bool

    public init(full: String? = nil, identifier: String? = nil, alone: Bool = false, add: @escaping () -> Void) {
        self.full = full
        self.identifier = identifier
        self.alone = alone
        self.add = add
    }

    private var tone: Color { platform == .ios ? Cockpit.Color.accent : Cockpit.Color.textSecondary }

    public var body: some View {
        let shown = full == nil ? 1 : Cockpit.Opacity.disabled
        Button(action: add) {
            CircleRowFrame(separator: false, led: !alone) {
                Icon(.add, size: .sm)
                    .foregroundStyle(tone)
                    .opacity(shown)
                    .accessibilityHidden(true)
            } words: {
                Text("Add circle")
                    .cockpit(.rowTitle)
                    .foregroundStyle(tone)
                    .opacity(shown)
                    .cockpitLines(1)
                if let full {
                    Text(full)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .cockpitLines(2)
                }
            }
        }
        .buttonStyle(Cockpit.Pressable.row(platform, forced: forced))
        .disabled(full != nil)
        .accessibilityIdentifier(identifier ?? "")
    }
}

private struct CircleRowFrame<Lead: View, Words: View, Trailing: View>: View {
    let separator: Bool
    var led = true
    let lead: Lead
    let words: Words
    let trailing: Trailing
    @Environment(\.cockpitPlatform) private var platform

    init(separator: Bool, led: Bool = true, @ViewBuilder lead: () -> Lead, @ViewBuilder words: () -> Words,
         @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.separator = separator
        self.led = led
        self.lead = lead()
        self.words = words()
        self.trailing = trailing()
    }

    static var glyph: CGFloat { 18 }

    var body: some View {
        let spacing = platform == .ios ? Cockpit.Space.s3 : Cockpit.Space.s2
        HStack(spacing: spacing) {
            if led { lead.frame(width: Self.glyph, height: Self.glyph) }
            VStack(alignment: .leading, spacing: 2) { words }
                .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.horizontal, platform.rowInset)
        .padding(.vertical, platform == .ios ? 10 : 6)
        .frame(minHeight: platform.rowHeight)
        .overlay(alignment: .bottom) {
            if separator {
                Rectangle()
                    .fill(Cockpit.Color.rule)
                    .frame(height: platform == .ios ? Cockpit.pixelRule : Cockpit.Stroke.border)
                    .padding(.leading, platform.rowInset + (led ? Self.glyph + spacing : 0))
                    .padding(.trailing, platform.rowInset)
            }
        }
        .contentShape(Rectangle())
    }
}
