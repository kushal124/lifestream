import SwiftUI

public struct AddRow: View {
    let placeholder: String
    @Binding var text: String
    let field: Bool
    let keyed: Bool
    let add: () -> Void
    var forcedLit = false
    @FocusState private var focused: Bool
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.isEnabled) private var enabled
    @Environment(\.fieldRowStacked) private var stacked

    public init(_ placeholder: String, text: Binding<String>, field: Bool = false, keyed: Bool = false, add: @escaping () -> Void) {
        self.placeholder = placeholder
        self._text = text
        self.field = field
        self.keyed = keyed
        self.add = add
    }

    public var body: some View {
        if field {
            HStack(spacing: keyed ? (stacked ? Cockpit.Space.s2 : 0) : Cockpit.Space.s3) {
                if keyed {
                    plus.frame(width: stacked ? nil : FieldRow.labelColumn, alignment: .leading)
                } else {
                    plus.frame(width: 32)
                }
                input
            }
            .padding(.leading, Cockpit.Space.s4)
            .padding(.trailing, Cockpit.Space.s3)
            .padding(.vertical, Cockpit.Space.s2)
            .frame(maxWidth: .infinity, minHeight: platform == .ios ? Cockpit.Size.controlLg : 40, alignment: .leading)
            .fieldRowBox(lit: enabled && (focused || forcedLit))
            .contentShape(Rectangle())
            .onTapGesture { if enabled { focused = true } }
        } else {
            HStack(spacing: Cockpit.Space.s3) {
                plus
                input
            }
            .padding(.horizontal, platform == .mac ? 0 : platform.rowInset)
            .frame(maxWidth: .infinity, minHeight: platform == .mac ? 44 : platform.rowHeight, alignment: .leading)
        }
    }

    private var plus: some View {
        Icon(.add, size: .sm)
            .foregroundStyle(Cockpit.Color.textSecondary)
            .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
            .accessibilityHidden(true)
    }

    @ViewBuilder private var input: some View {
        if field {
            ZStack(alignment: .leading) {
                if text.isEmpty {
                    Text(placeholder)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .cockpitLines(1)
                        .minimumScaleFactor(0.85)
                        .accessibilityHidden(true)
                }
                textField(TextField("", text: $text))
                    .accessibilityLabel(placeholder)
            }
            .cockpit(.body)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            textField(TextField(placeholder, text: $text, prompt: Text(placeholder).foregroundStyle(Cockpit.Color.textTertiary)))
                .cockpit(.body)
        }
    }

    private func textField(_ field: TextField<Text>) -> some View {
        field
            .textFieldStyle(.plain)
            .foregroundStyle(enabled ? Cockpit.Color.text : Cockpit.Color.textSecondary)
            .focused($focused)
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .submitLabel(.done)
            #endif
            .onSubmit(add)
    }
}
