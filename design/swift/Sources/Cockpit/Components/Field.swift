import SwiftUI

public struct Field: View {
    @Binding var text: String
    let label: String
    let placeholder: String
    let focus: FocusState<Bool>.Binding?
    let secure: Bool
    let spaces: Bool
    let error: String?
    var forcedFocus = false
    @FocusState private var ownFocus: Bool
    @Environment(\.cockpitPlatform) private var platform

    public init(_ label: String, text: Binding<String>, placeholder: String = "", focus: FocusState<Bool>.Binding? = nil,
                secure: Bool = false, spaces: Bool = true, error: String? = nil) {
        self.label = label
        self.error = error
        self._text = text
        self.placeholder = placeholder
        self.focus = focus
        self.secure = secure
        self.spaces = spaces
    }

    static func kept(_ text: String, spaces: Bool) -> String {
        text.filter { !$0.isNewline && (spaces || !$0.isWhitespace) }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            field
            if let error {
                Text(error)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Cockpit.Space.s1)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(label): \(error)")
            }
        }
    }

    private var field: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty && !placeholder.isEmpty {
                Text(placeholder)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .cockpitLines(1)
                    .accessibilityHidden(true)
            }
            Group {
                if secure { SecureField("", text: $text) } else { TextField("", text: $text) }
            }
                .textFieldStyle(.plain)
                .onChange(of: text) { _, typed in
                    let kept = Self.kept(typed, spaces: spaces)
                    if kept != typed { text = kept }
                }
                .focusEffectDisabled()
                .focused(focus ?? $ownFocus)
                .foregroundStyle(Cockpit.Color.text)
                .accessibilityLabel(label)
        }
        .cockpit(.body)
        .padding(.horizontal, platform == .ios ? Cockpit.Space.s4 : Cockpit.Space.s3)
        .frame(minHeight: platform.controlHeight)
        .background {
            if platform == .ios { Capsule().fill(Cockpit.Color.well) }
        }
        .overlay {
            if platform == .ios {
                Capsule()
                    .strokeBorder(error != nil ? Cockpit.Color.warning : isFocused ? Cockpit.Color.focus : Color.clear,
                                  lineWidth: Cockpit.Stroke.border)
            } else {
                Capsule().strokeBorder(error != nil ? Cockpit.Color.warning : isFocused ? Cockpit.Color.here : Cockpit.Color.border,
                                       lineWidth: Cockpit.Stroke.border)
            }
        }
    }

    private var isFocused: Bool { forcedFocus || (focus ?? $ownFocus).wrappedValue }
}
