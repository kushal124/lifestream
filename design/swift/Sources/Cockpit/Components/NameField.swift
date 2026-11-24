import SwiftUI

public struct NameField: View {
    @Binding var text: String
    let placeholder: String
    let act: String
    let focus: FocusState<Bool>.Binding?
    let save: () -> Void
    @FocusState private var ownFocus: Bool
    @Environment(\.cockpitPlatform) private var platform
    @ScaledMetric(relativeTo: .subheadline) private var slot: CGFloat = 24

    public init(_ placeholder: String, text: Binding<String>, act: String, focus: FocusState<Bool>.Binding? = nil,
                save: @escaping () -> Void) {
        self.placeholder = placeholder
        self._text = text
        self.act = act
        self.focus = focus
        self.save = save
    }

    private var typed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: platform == .ios ? Cockpit.Size.controlLg / 2 : Cockpit.Radius.sm, style: .continuous)
        HStack(spacing: platform == .ios ? Cockpit.Space.s3 : 10) {
            if platform != .ios {
                Icon(.search, size: .sm)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .frame(width: slot)
            }
            ZStack(alignment: .leading) {
                if text.isEmpty {
                    Text(placeholder)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .cockpitLines(1)
                        .accessibilityHidden(true)
                }
                TextField("", text: $text)
                    .textFieldStyle(.plain)
                    .focusEffectDisabled()
                    .focused(focus ?? $ownFocus)
                    .foregroundStyle(Cockpit.Color.text)
                    .tint(Cockpit.Color.text)
                    #if os(iOS)
                    .submitLabel(.done)
                    .textInputAutocapitalization(.words)
                    #endif
                    .onChange(of: text) { _, now in
                        let kept = Field.kept(now, spaces: true)
                        if kept != now { text = kept }
                    }
                    .onSubmit { if !typed.isEmpty { save() } }
                    .accessibilityLabel(placeholder)
                    .accessibilityIdentifier("name.field")
            }
            .cockpit(.body)
            if !typed.isEmpty {
                Button(act, action: save)
                    .buttonStyle(.plain)
                    .cockpit(.headline)
                    .foregroundStyle(Cockpit.Color.text)
                    .hitArea(platform)
                    .transition(.opacity)
                    .accessibilityIdentifier("name.save")
            }
        }
        .padding(.leading, platform == .ios ? Cockpit.Space.s4 : 10)
        .padding(.trailing, Cockpit.Space.s4)
        .frame(minHeight: platform == .ios ? Cockpit.Size.controlLg : 40)
        .background(shape.fill(Cockpit.Color.well))
        .overlay { if platform != .ios { shape.strokeBorder(Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border) } }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: typed.isEmpty)
    }
}
