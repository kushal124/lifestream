import SwiftUI

public struct FieldRow: View {
    private enum Kind {
        case text(Binding<String>, placeholder: String, source: String?, sourced: Bool, focus: FocusState<Bool>.Binding?,
                  words: Bool)
        case menu(String, open: Bool, action: () -> Void)
        case push(String, empty: String, action: () -> Void)
    }

    public static let labelColumn: CGFloat = Cockpit.Size.formLabel

    let label: String
    private let kind: Kind
    var forcedLit = false
    var forced: RowHighlight?

    public init(_ label: String, text: Binding<String>, placeholder: String = "", source: String? = nil, sourced: Bool = true,
                focus: FocusState<Bool>.Binding? = nil, capitalizesWords: Bool = true) {
        self.label = label
        self.kind = .text(text, placeholder: placeholder, source: source, sourced: sourced, focus: focus, words: capitalizesWords)
    }

    public init(_ label: String, value: String, open: Bool = false, action: @escaping () -> Void) {
        self.label = label
        self.kind = .menu(value, open: open, action: action)
    }

    public init(_ label: String, value: String, empty: String, push: @escaping () -> Void) {
        self.label = label
        self.kind = .push(value, empty: empty, action: push)
    }

    public var body: some View {
        switch kind {
        case let .text(text, placeholder, source, sourced, focus, words):
            TextFieldRow(label: label, text: text, placeholder: placeholder, source: sourced ? source : nil, focus: focus,
                         words: words, forcedLit: forcedLit)
        case let .menu(value, open, action):
            MenuFieldRow(label: label, value: value, open: open || forcedLit, forced: forced, action: action)
        case let .push(value, empty, action):
            MenuFieldRow(label: label, value: value, open: forcedLit, forced: forced, empty: empty, pushes: true, action: action)
        }
    }
}

private struct TextFieldRow: View {
    let label: String
    @Binding var text: String
    let placeholder: String
    let source: String?
    let focus: FocusState<Bool>.Binding?
    let words: Bool
    let forcedLit: Bool
    @FocusState private var ownFocus: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.fieldRowStacked) private var stacked
    @Environment(\.fieldRowLong) private var long

    var body: some View {
        let focused = enabled && (forcedLit || (focus ?? $ownFocus).wrappedValue)
        FieldRowLine(label: label) {
            if stacked {
                VStack(alignment: .leading, spacing: 2) {
                    field
                    if let source { sourceWords(source) }
                }
            } else if let source {
                FieldValueAndSource {
                    Text(text).cockpit(.body).fixedSize().hidden().accessibilityHidden(true)
                    field
                    sourceInRoom(source).frame(maxWidth: .infinity, alignment: .trailing).clipped()
                }
            } else {
                field
            }
        }
        .fieldRowBox(lit: focused)
        .contentShape(Rectangle())
        .onTapGesture { if enabled { (focus ?? $ownFocus).wrappedValue = true } }
    }

    private var field: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty && !placeholder.isEmpty {
                Text(placeholder)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .cockpitLines(1)
                    .accessibilityHidden(true)
            }
            TextField("", text: $text, axis: long ? .vertical : .horizontal)
                .lineLimit(long ? 2 : 1)
                .textFieldStyle(.plain)
                .focusEffectDisabled()
                .focused(focus ?? $ownFocus)
                .foregroundStyle(enabled ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                #if os(iOS)
                .textInputAutocapitalization(words ? .words : .sentences)
                #endif
                .autocorrectionDisabled()
                .onChange(of: text) { _, typed in
                    let kept = Field.kept(typed, spaces: true)
                    if kept != typed { text = kept }
                }
                .accessibilityLabel(label)
        }
        .cockpit(.body)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sourceInRoom(_ source: String) -> some View {
        let parts = source.components(separatedBy: " · ")
        return ViewThatFits(in: .horizontal) {
            ForEach((1...parts.count).reversed(), id: \.self) { count in
                sourceWords(parts.prefix(count).joined(separator: " · ")).fixedSize()
            }
            Color.clear.frame(width: 0, height: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(source)
        .accessibilityAddTraits(.isStaticText)
    }

    private func sourceWords(_ source: String) -> some View {
        Text(source)
            .cockpit(.subhead)
            .foregroundStyle(Cockpit.Color.textTertiary)
            .cockpitLines(1)
    }
}

private struct FieldValueAndSource: Layout {
    private static let least: CGFloat = 44

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let field = subviews[1].sizeThatFits(proposal)
        let source = subviews[2].sizeThatFits(.unspecified)
        return CGSize(width: proposal.width ?? field.width + Cockpit.Space.s3 + source.width, height: max(field.height, source.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let typed = subviews[0].sizeThatFits(.unspecified).width + 2
        let gap = Cockpit.Space.s3
        let room = bounds.width - typed - gap
        let width = min(subviews[2].sizeThatFits(.unspecified).width, room)
        let source = width >= Self.least ? width : 0
        subviews[0].place(at: bounds.origin, proposal: .zero)
        subviews[1].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
                          proposal: ProposedViewSize(width: bounds.width - (source > 0 ? source + gap : 0), height: bounds.height))
        subviews[2].place(at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing,
                          proposal: ProposedViewSize(width: source, height: nil))
    }
}

private struct MenuFieldRow: View {
    let label: String
    let value: String
    let open: Bool
    let forced: RowHighlight?
    var empty = ""
    var pushes = false
    let action: () -> Void
    @FocusState private var focused: Bool
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            FieldRowLine(label: label) {
                HStack(spacing: Cockpit.Space.s2) {
                    Text(value.isEmpty ? empty : value)
                        .cockpit(.body)
                        .foregroundStyle(value.isEmpty ? Cockpit.Color.textTertiary : enabled ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                        .cockpitLines(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if pushes {
                        Icon(.forward, size: .xs)
                            .foregroundStyle(Cockpit.Color.textTertiary)
                            .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
                            .accessibilityHidden(true)
                    } else {
                        FieldRowCaret(open: false)
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(Cockpit.Pressable(forced: forced) { label, state in
            label.fieldRowBox(lit: enabled && (open || focused), highlight: state)
        })
        .focusEffectDisabled()
        .focused($focused)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(value.isEmpty ? empty : value)
        .accessibilityAddTraits(.isButton)
    }
}

extension EnvironmentValues {
    var fieldRowStacked: Bool { cockpitPlatform == .ios && dynamicTypeSize.isAccessibilitySize }
    @Entry var fieldRowLong = false
}

public extension View {
    func fieldRowLong() -> some View { environment(\.fieldRowLong, true) }
}

struct ControlCaret: View {
    var open = false
    var tone = Cockpit.Color.textTertiary
    var menu = false
    @Environment(\.cockpitPlatform) private var platform

    private static var bearing: CGFloat { 1.7 }

    var body: some View {
        if menu, platform == .ios {
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(tone)
        } else {
            Icon(.expand, size: .xs)
                .foregroundStyle(tone)
                .rotationEffect(.degrees(open ? 180 : 0))
                .padding(.trailing, platform == .ios ? -Self.bearing : 0)
        }
    }
}

struct FieldRowCaret: View {
    let open: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ControlCaret(open: open, menu: true)
            .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
            .animation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.fast), value: open)
            .accessibilityHidden(true)
    }
}

struct FieldRowLine<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.fieldRowStacked) private var stacked

    var body: some View {
        let words = Group {
            if platform == .ios {
                Text(label).cockpit(Cockpit.Style.iosSubhead).foregroundStyle(Cockpit.Color.textSecondary)
            } else {
                Text(label).cockpit(.body).foregroundStyle(Cockpit.Color.textTertiary)
            }
        }
        .accessibilityHidden(true)
        Group {
            if stacked {
                VStack(alignment: .leading, spacing: 2) {
                    words.fixedSize(horizontal: false, vertical: true)
                    content
                }
                .padding(.vertical, Cockpit.Space.s3)
            } else if platform == .ios {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    words.lineLimit(1).frame(width: FieldRow.labelColumn, alignment: .leading)
                    content
                }
                .padding(.vertical, Cockpit.Space.s3)
            } else {
                HStack(spacing: Cockpit.Space.s3) {
                    words.lineLimit(1).frame(width: FieldRow.labelColumn, alignment: .leading)
                    content
                }
            }
        }
        .padding(.leading, Cockpit.Space.s4)
        .padding(.trailing, platform == .ios ? Cockpit.Space.s4 : Cockpit.Space.s3)
        .frame(maxWidth: .infinity, minHeight: platform == .ios ? Cockpit.Size.controlLg : 40, alignment: .leading)
    }
}

extension View {
    func fieldRowBox(lit: Bool, highlight: RowHighlight? = nil) -> some View {
        modifier(FieldRowBox(lit: lit, highlight: highlight))
    }
}

public extension EnvironmentValues {
    @Entry var cockpitRowInCard = false
}

private struct FieldRowBox: ViewModifier {
    let lit: Bool
    let highlight: RowHighlight?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.cockpitRowInCard) private var inCard

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: inCard ? 0 : Cockpit.Radius.sm, style: .continuous)
        content
            .background {
                ZStack {
                    if !inCard { shape.fill(Cockpit.Color.well) }
                    if let highlight { shape.fill(RowChrome<EmptyView>.color(highlight)) }
                }
                .animation(.easeOut(duration: Cockpit.Duration.instant), value: highlight)
            }
            .overlay {
                if lit || platform == .mac {
                    shape.strokeBorder(lit ? Cockpit.Color.here : Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.instant), value: lit)
    }
}
