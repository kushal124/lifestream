import SwiftUI
#if canImport(AppKit) && !canImport(UIKit)
import AppKit
#endif

public struct Chip<ID: Hashable>: Identifiable {
    public let id: ID
    let label: String
    let count: Int?
    let atLeast: Bool
    let icon: Cockpit.Icon?

    public init(_ label: String, id: ID, count: Int? = nil, atLeast: Bool = false, icon: Cockpit.Icon? = nil) {
        self.id = id
        self.label = label
        self.count = count
        self.atLeast = atLeast
        self.icon = icon
    }
}

extension Chip: Sendable where ID: Sendable {}

public extension Chip where ID == String {
    init(_ label: String, count: Int? = nil, icon: Cockpit.Icon? = nil) {
        self.init(label, id: label, count: count, icon: icon)
    }
}

public struct ChipRow<ID: Hashable>: View {
    let chips: [Chip<ID>]
    @Binding var selection: Set<ID>
    let all: Bool
    let allCount: Int?
    let allAtLeast: Bool
    let multiple: Bool
    let reading: Bool
    let tally: Bool
    var forced: (id: ID?, state: RowHighlight)?
    @Environment(\.cockpitPlatform) private var platform

    public init(_ chips: [Chip<ID>], selection: Binding<Set<ID>>, all: Bool = true, allCount: Int? = nil, allAtLeast: Bool = false,
                multiple: Bool = true, reading: Bool = false) {
        self.chips = chips
        self._selection = selection
        self.all = all
        self.allCount = allCount
        self.allAtLeast = allAtLeast
        self.multiple = multiple
        self.reading = reading
        tally = false
    }

    public init(_ chips: [Chip<ID>], picked: Binding<ID?>, reading: Bool = false) {
        self.chips = chips
        self._selection = Binding(get: { picked.wrappedValue.map { [$0] } ?? [] }, set: { picked.wrappedValue = $0.first })
        all = false
        allCount = nil
        allAtLeast = false
        multiple = false
        self.reading = reading
        tally = true
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Cockpit.Space.s2) {
                if all {
                    ChipButton(label: "All", count: allCount, atLeast: allAtLeast, icon: nil, selected: selection.isEmpty, tally: tally, forced: forced(nil)) {
                        selection = []
                    }
                    .disabled(reading)
                }
                HStack(spacing: Cockpit.Space.s2) {
                    ForEach(chips) { chip in
                        ChipButton(label: chip.label, count: chip.count, atLeast: chip.atLeast, icon: chip.icon, selected: selection.contains(chip.id),
                                   tally: tally, forced: forced(chip.id)) {
                            selection = Self.chosen(chip.id, in: selection, adding: multiple && Self.adding)
                        }
                    }
                }
                .reading(reading)
            }
            .padding(.vertical, platform == .ios ? 6 : 2)
        }
        .scrollClipDisabled()
    }

    private func forced(_ id: ID?) -> RowHighlight? {
        guard let forced, forced.id == id else { return nil }
        return forced.state
    }

    static func chosen(_ id: ID, in selection: Set<ID>, adding: Bool) -> Set<ID> {
        if adding { return selection.symmetricDifference([id]) }
        return selection == [id] ? [] : [id]
    }

    private static var adding: Bool {
        #if canImport(AppKit) && !canImport(UIKit)
        return NSEvent.modifierFlags.contains(.command)
        #else
        return false
        #endif
    }
}

private struct ChipButton: View {
    let label: String
    let count: Int?
    let atLeast: Bool
    let icon: Cockpit.Icon?
    let selected: Bool
    let tally: Bool
    let forced: RowHighlight?
    let action: () -> Void
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        if tally { tallied } else { plain }
    }

    private var tallied: some View {
        let selected = selected && enabled
        let phone = platform == .ios
        let ink = !enabled ? Cockpit.Color.textDisabled : selected ? Cockpit.Color.textInverse : Cockpit.Color.textSecondary
        return Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Icon(icon, size: .sm) }
                Text(label)
                if let count {
                    Text(count.formatted(.number.locale(Locale(identifier: "en_US"))) + (atLeast ? "+" : ""))
                        .fontWeight(phone ? .semibold : .medium)
                        .monospacedDigit()
                        .foregroundStyle(!enabled ? Cockpit.Color.textDisabled : selected ? Cockpit.Color.textInverse : Cockpit.Color.text)
                }
            }
            .foregroundStyle(ink)
            .cockpit(phone ? Cockpit.Style.iosSubhead : platform.style(.subhead))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, Cockpit.Space.s3)
            .frame(minHeight: phone ? Cockpit.Size.controlSm : 28)
        }
        .buttonStyle(TallyStyle(platform: platform, selected: selected, forced: forced))
        .accessibilityLabel(count.map { "\(label), \(atLeast ? "at least " : "")\($0)" } ?? label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var plain: some View {
        let selected = selected && enabled
        return Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Icon(icon, size: .sm) }
                Text(label).cockpit(.subhead).fontWeight(platform == .ios ? .medium : nil)
                if let count {
                    Text(count.formatted(.number.locale(Locale(identifier: "en_US"))) + (atLeast ? "+" : ""))
                        .cockpit(.monoData)
                        .monospacedDigit()
                        .foregroundStyle(!enabled ? Cockpit.Color.textDisabled : selected ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary)
                }
            }
            .foregroundStyle(!enabled ? Cockpit.Color.textDisabled : selected ? Cockpit.Color.text : Cockpit.Color.textSecondary)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, platform == .ios ? Cockpit.Space.s3 : 10)
            .frame(minHeight: platform == .ios ? Cockpit.Size.controlSm : 24)
        }
        .buttonStyle(ChipStyle(platform: platform, selected: selected, forced: forced))
        .accessibilityLabel(count.map { "\(label), \(atLeast ? "at least " : "")\($0)" } ?? label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

public struct CardChip: View {
    public enum Kind {
        case ask(open: Bool)
        case tick(Bool, why: String)
        case tag
    }

    let label: String
    let kind: Kind
    let action: () -> Void
    var forced: RowHighlight?
    @Environment(\.cockpitPlatform) private var platform

    public init(_ label: String, kind: Kind, action: @escaping () -> Void) {
        self.label = label
        self.kind = kind
        self.action = action
    }

    public var body: some View {
        let height = platform == .ios ? Cockpit.Size.controlSm : 24
        let inset: CGFloat = platform == .ios ? Cockpit.Space.s3 : 10
        Button(action: action) {
            HStack(spacing: 6) {
                switch kind {
                case let .ask(open):
                    Text(label).foregroundStyle(open ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                case let .tick(on, why):
                    Tick(on: on).padding(.trailing, 1)
                    Text(label).foregroundStyle(Cockpit.Color.text).fixedSize()
                    if !why.isEmpty {
                        Text("· \(why)").foregroundStyle(on ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary)
                    }
                case .tag:
                    Text(label).foregroundStyle(Cockpit.Color.text)
                    Icon(.close, size: .xs)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .frame(width: 16, height: 16)
                }
            }
            .cockpit(.subhead)
            .lineLimit(1)
            .padding(.leading, isTick ? (height - Tick.side(platform)) / 2 : inset)
            .padding(.trailing, isTag ? inset - 5 : inset)
            .frame(minHeight: height)
        }
        .buttonStyle(ChipStyle(platform: platform, selected: selected, forced: forced))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibleLabel)
        .accessibilityValue(ticked.map { $0 ? "Ticked" : "Not ticked" } ?? "")
        .accessibilityHint(isTag ? "Removes it" : "")
        .accessibilityAddTraits(.isButton)
    }

    private var selected: Bool {
        switch kind {
        case let .ask(open): open
        case let .tick(on, _): on
        case .tag: true
        }
    }

    private var isTick: Bool { if case .tick = kind { true } else { false } }
    private var isTag: Bool { if case .tag = kind { true } else { false } }
    private var ticked: Bool? { if case let .tick(on, _) = kind { on } else { nil } }
    private var accessibleLabel: String {
        if case let .tick(_, why) = kind, !why.isEmpty { return "\(label), \(why)" }
        return label
    }
}

private struct TallyStyle: ButtonStyle {
    let platform: Cockpit.Platform
    let selected: Bool
    let forced: RowHighlight?

    func makeBody(configuration: Configuration) -> some View {
        TallyBody(configuration: configuration, style: self)
    }
}

private struct TallyBody: View {
    let configuration: ButtonStyleConfiguration
    let style: TallyStyle
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        let selected = style.selected && enabled
        let state = enabled ? style.forced ?? (configuration.isPressed ? .pressed : hovering && style.platform == .mac ? .hover : nil) : nil
        let phone = style.platform == .ios
        let shape = Capsule(style: .continuous)
        configuration.label
            .background {
                ZStack {
                    shape.fill(selected ? Cockpit.Color.text : phone ? Cockpit.Color.well : SwiftUI.Color.clear)
                    if let state, !selected { shape.fill(RowChrome<EmptyView>.color(state)) }
                    if !selected {
                        shape.strokeBorder(phone ? Cockpit.Color.phoneRule : Cockpit.Color.hairline,
                                           lineWidth: phone ? Cockpit.Stroke.hairline : Cockpit.Stroke.border)
                    }
                }
            }
            .opacity(selected && state == .pressed ? 0.85 : 1)
            .contentShape(shape)
            .hitArea(style.platform)
            .onHover { hovering = $0 }
    }
}

private struct ChipStyle: ButtonStyle {
    let platform: Cockpit.Platform
    let selected: Bool
    let forced: RowHighlight?

    func makeBody(configuration: Configuration) -> some View {
        ChipBody(configuration: configuration, style: self)
    }
}

private struct ChipBody: View {
    let configuration: ButtonStyleConfiguration
    let style: ChipStyle
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        let selected = style.selected && enabled
        let state = enabled ? style.forced ?? (configuration.isPressed ? .pressed : hovering && style.platform == .mac ? .hover : nil) : nil
        let phone = style.platform == .ios
        let shape = RoundedRectangle(cornerRadius: phone ? Cockpit.Size.controlSm / 2 : Cockpit.Radius.control, style: .continuous)
        configuration.label
            .background {
                ZStack {
                    shape.fill(selected ? (phone ? Cockpit.Color.raised : Cockpit.Color.selection) : SwiftUI.Color.clear)
                    if let state { shape.fill(phone && !selected ? Cockpit.Color.raised.opacity(0.5) : RowChrome<EmptyView>.color(state)) }
                    if !selected && !phone { shape.strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border) }
                }
            }
            .contentShape(shape)
            .hitArea(style.platform)
            .onHover { hovering = $0 }
    }
}
