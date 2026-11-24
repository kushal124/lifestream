import SwiftUI

public struct SearchField: View {
    @Binding var text: String
    let placeholder: String
    let shortcut: String?
    let focus: FocusState<Bool>.Binding?
    var forcedFocus = false
    @FocusState private var ownFocus: Bool
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.isEnabled) private var enabled

    public init(text: Binding<String>, placeholder: String = "Search your life", shortcut: String? = nil, focus: FocusState<Bool>.Binding? = nil) {
        self._text = text
        self.placeholder = placeholder
        self.shortcut = shortcut
        self.focus = focus
    }

    public var body: some View {
        let focused = focus ?? $ownFocus
        HStack(spacing: platform == .ios ? Cockpit.Space.s3 : Cockpit.Space.s2) {
            Icon(.search, size: platform == .ios ? .md : .sm)
                .foregroundStyle(!enabled ? Cockpit.Color.textDisabled
                    : platform == .mac && isFocused ? Cockpit.Color.here
                    : platform == .ios ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary)
            ZStack(alignment: .leading) {
                if text.isEmpty {
                    Text(placeholder)
                        .foregroundStyle(!enabled ? Cockpit.Color.textDisabled
                            : platform == .ios ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary)
                        .lineLimit(1)
                        .accessibilityHidden(true)
                }
                TextField("", text: $text)
                    .textFieldStyle(.plain)
                    .focusEffectDisabled()
                    .focused(focused)
                    .foregroundStyle(Cockpit.Color.text)
                    .submitLabel(.search)
                    .accessibilityLabel(placeholder)
                    .accessibilityAddTraits(.isSearchField)
            }
            .cockpit(.body)
            if !text.isEmpty {
                Button { text = "" } label: {
                    Icon(.clear, size: platform == .ios ? .sm : .xs, label: "Clear")
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .hitArea(platform)
                }
                .buttonStyle(.plain)
            } else if let hint {
                Kbd(hint).accessibilityHidden(true)
            }
        }
        .padding(.leading, platform == .ios ? Cockpit.Space.s4 : Cockpit.Space.s3)
        .padding(.trailing, platform == .ios ? Cockpit.Space.s4 : hint == nil ? Cockpit.Space.s2 : (platform.controlHeight - 20) / 2)
        .frame(minHeight: platform.controlHeight)
        .background {
            if platform == .ios && enabled { Capsule(style: .continuous).fill(Cockpit.Color.well) }
        }
        .overlay {
            if platform == .ios {
                Capsule(style: .continuous)
                    .strokeBorder(!enabled ? Cockpit.Color.border : isFocused ? Cockpit.Color.focus : Cockpit.Color.rule,
                                  lineWidth: Cockpit.Stroke.hairline)
            } else {
                Capsule().strokeBorder(isFocused ? Cockpit.Color.here : Cockpit.Color.border, lineWidth: Cockpit.Stroke.border)
            }
        }
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    private var isFocused: Bool { forcedFocus || (focus ?? $ownFocus).wrappedValue }

    private var hint: String? { platform == .mac && enabled && text.isEmpty && !isFocused ? shortcut : nil }
}
