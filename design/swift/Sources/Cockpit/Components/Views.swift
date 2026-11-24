import SwiftUI

public struct ViewOption<ID: Hashable>: Identifiable {
    public let id: ID
    let label: String
    let count: Int?
    let reading: Bool
    let identifier: String?

    public init(_ label: String, id: ID, count: Int? = nil, reading: Bool = false, identifier: String? = nil) {
        self.id = id
        self.label = label
        self.count = count
        self.reading = reading
        self.identifier = identifier
    }
}

public struct Views<ID: Hashable>: View {
    let label: String
    let options: [ViewOption<ID>]
    @Binding var selection: ID
    var forced: ID?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ label: String, options: [ViewOption<ID>], selection: Binding<ID>) {
        self.label = label
        self.options = options
        self._selection = selection
    }

    public var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: platform == .ios ? Cockpit.Space.s2 : Cockpit.Space.s1) { pills }
                    VStack(alignment: .leading, spacing: Cockpit.Space.s2) { pills }
                }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: platform == .ios ? Cockpit.Space.s2 : Cockpit.Space.s1) { pills }
                }
                .scrollClipDisabled()
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    @ViewBuilder private var pills: some View {
        ForEach(options) { option in
            Button { selection = option.id } label: {
                ViewPill(label: option.label, count: option.count, reading: option.reading, chosen: option.id == selection)
            }
            .buttonStyle(Cockpit.Pressable(forced: forced == option.id ? .touched(platform) : nil) { label, state in
                ViewPillFace(label: label, state: state, chosen: option.id == selection, filled: option.id == selection && !option.reading)
            })
            .accessibilityLabel(option.label)
            .accessibilityValue(option.reading ? "" : option.count.map(ViewPill.number) ?? "")
            .accessibilityAddTraits(option.id == selection ? .isSelected : [])
            .accessibilityIdentifier(option.identifier ?? "")
        }
    }
}

private struct ViewPill: View {
    let label: String
    let count: Int?
    let reading: Bool
    let chosen: Bool
    @Environment(\.cockpitPlatform) private var platform

    nonisolated static func number(_ count: Int) -> String {
        count.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US")))
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label).cockpit(platform == .ios ? .subhead : .rowTitle).fontWeight(platform == .ios ? .medium : nil).fixedSize()
            if reading || count != nil {
                ZStack(alignment: .leading) {
                    if reading { Text(verbatim: "00") }
                    if let count, !reading { Text(Self.number(count)) }
                }
                .cockpit(.monoData)
                .monospacedDigit()
                .foregroundStyle(platform == .ios ? Cockpit.Color.textSecondary : chosen ? Cockpit.Color.here : Cockpit.Color.textTertiary)
                .reading(reading)
            }
        }
        .lineLimit(1)
    }
}

private struct ViewPillFace: View {
    let label: ButtonStyleConfiguration.Label
    let state: RowHighlight?
    let chosen: Bool
    let filled: Bool
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let shape = Capsule(style: .continuous)
        let fill: Color = filled ? (platform == .ios ? Cockpit.Color.raised : Cockpit.Color.selection)
            : chosen ? .clear
            : state.map { $0 == .hover ? Cockpit.Color.hover : Cockpit.Color.pressed } ?? .clear
        let height = Cockpit.Size.controlSm
        label
            .foregroundStyle(chosen || state != nil ? Cockpit.Color.text : Cockpit.Color.textSecondary)
            .padding(.horizontal, 14)
            .padding(.vertical, Cockpit.Space.s1)
            .frame(minHeight: height)
            .background(shape.fill(fill))
            .overlay {
                if !chosen {
                    shape.strokeBorder(contrast == .increased ? Cockpit.Color.border : Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border)
                }
            }
            .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
            .overlay { FocusRing(radius: height / 2) }
            .contentShape(shape)
            .padding(.vertical, max(0, platform.hitSize - height) / 2)
            .contentShape(Rectangle())
            .padding(.vertical, -max(0, platform.hitSize - height) / 2)
    }
}
