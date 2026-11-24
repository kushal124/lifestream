import Cockpit
import SwiftUI


struct NoteAccessoryBar: View {
    static let height: CGFloat = Cockpit.Size.target + 2 * Cockpit.Space.s1

    @ObservedObject var session: NoteEditorSession
    var onChange: () -> Void
    var onFormat: () -> Void
    var onAttach: () -> Void
    var onDismissKeyboard: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            barButton(
                "arrow.uturn.backward", label: "Undo",
                enabled: session.textView?.undoManager?.canUndo == true
            ) {
                session.textView?.undoManager?.undo()
                onChange()
            }
            barButton(
                "arrow.uturn.forward", label: "Redo",
                enabled: session.textView?.undoManager?.canRedo == true
            ) {
                session.textView?.undoManager?.redo()
                onChange()
            }
            Spacer(minLength: Cockpit.Space.s2)
            barButton(
                "textformat", identifier: "style", label: "Format", active: session.isShowingFormatCard,
                action: onFormat)
            barButton("checklist", label: "Checklist", active: session.isChecklistSelection) {
                session.toggleChecklist()
                onChange()
            }
            barButton("paperclip", label: "Add attachment", action: onAttach)
            Spacer(minLength: Cockpit.Space.s2)
            barButton("keyboard.chevron.compact.down", label: "Hide keyboard", action: onDismissKeyboard)
        }
        .padding(.horizontal, Cockpit.Space.s1)
        .frame(height: Cockpit.Size.target)
        .cockpitGlass(in: Capsule())
        .padding(.horizontal, Cockpit.Space.s2)
        .frame(height: Self.height)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("notes.editor.format-bar")
    }

    private func barButton(
        _ systemImage: String,
        identifier: String? = nil,
        label: String,
        active: Bool = false,
        enabled: Bool = true,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: Cockpit.Size.iconMd))
                .foregroundStyle(enabled ? Cockpit.Color.text : Cockpit.Color.textDisabled)
                .frame(width: Cockpit.Size.target, height: Cockpit.Size.target)
                .background(Circle().fill(active ? Cockpit.Color.selection : .clear).padding(Cockpit.Space.s1))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityValue(active ? "On" : "Off")
        .accessibilityIdentifier("notes.editor.\(identifier ?? systemImage)")
    }
}

struct NoteFormatCard: View {
    static let height: CGFloat = 248

    @ObservedObject var session: NoteEditorSession
    var onChange: () -> Void
    var onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            HStack {
                Text("Format")
                    .cockpit(.headline)
                    .foregroundStyle(Cockpit.Color.text)
                Spacer()
                IconButton(.close, label: "Close format", style: .raised, size: .small, action: onClose)
                    .accessibilityIdentifier("notes.editor.format-close")
            }
            .frame(height: Cockpit.Size.target)
            .padding(.horizontal, Cockpit.Space.s4)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Cockpit.Space.s2) {
                    ForEach(NoteFormatting.BlockStyle.allCases) { style in
                        styleChip(style)
                    }
                }
                .padding(.horizontal, Cockpit.Space.s4)
            }
            HStack(spacing: Cockpit.Space.s3) {
                controlGroup {
                    inlineButton("bold", label: "Bold", active: session.isTraitActive(.traitBold)) {
                        session.applyInline { storage, range in
                            NoteFormatting.toggleTrait(.traitBold, in: storage, range: range)
                        }
                    }
                    inlineButton("italic", label: "Italic", active: session.isTraitActive(.traitItalic)) {
                        session.applyInline { storage, range in
                            NoteFormatting.toggleTrait(.traitItalic, in: storage, range: range)
                        }
                    }
                    inlineButton(
                        "underline", label: "Underline", active: session.isAttributeActive(.underlineStyle)
                    ) {
                        session.applyInline { storage, range in
                            NoteFormatting.toggleUnderline(in: storage, range: range)
                        }
                    }
                    inlineButton(
                        "strikethrough", label: "Strikethrough",
                        active: session.isAttributeActive(.strikethroughStyle)
                    ) {
                        session.applyInline { storage, range in
                            NoteFormatting.toggleStrikethrough(in: storage, range: range)
                        }
                    }
                }
                controlGroup {
                    inlineButton(
                        "highlighter", label: "Highlight",
                        active: session.isAttributeActive(.backgroundColor)
                    ) {
                        session.applyInline { storage, range in
                            NoteFormatting.toggleHighlight(in: storage, range: range)
                        }
                    }
                }
                .frame(width: Cockpit.Size.target + 2 * Cockpit.Space.s1)
            }
            .padding(.horizontal, Cockpit.Space.s4)
            HStack(spacing: Cockpit.Space.s3) {
                controlGroup {
                    inlineButton("list.bullet", label: "Bulleted list") { session.applyList(.bulleted) }
                    inlineButton("list.dash", label: "Dashed list") { session.applyList(.dashed) }
                    inlineButton("list.number", label: "Numbered list") { session.applyList(.numbered) }
                }
                controlGroup {
                    inlineButton("decrease.indent", label: "Outdent") {
                        session.applyParagraph { storage, range in
                            NoteFormatting.indent(by: -1, in: storage, range: range)
                        }
                    }
                    inlineButton("increase.indent", label: "Indent") {
                        session.applyParagraph { storage, range in
                            NoteFormatting.indent(by: 1, in: storage, range: range)
                        }
                    }
                }
            }
            .padding(.horizontal, Cockpit.Space.s4)
            Spacer(minLength: 0)
        }
        .padding(.bottom, Cockpit.Space.s2)
        .frame(height: Self.height)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("notes.editor.format-card")
    }

    private func styleChip(_ style: NoteFormatting.BlockStyle) -> some View {
        let selected = session.currentBlockStyle() == style
        return Button {
            session.applyParagraph { storage, range in
                NoteFormatting.applyBlockStyle(style, to: storage, range: range)
            }
            onChange()
        } label: {
            Text(style.title)
                .font(chipFont(for: style))
                .lineLimit(1)
                .foregroundStyle(selected ? Cockpit.Color.textInverse : Cockpit.Color.text)
                .padding(.horizontal, Cockpit.Space.s4)
                .frame(height: Cockpit.Size.controlMd)
                .background(selected ? Cockpit.Color.text : Cockpit.Color.raised, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(style.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("notes.editor.style.\(style.rawValue)")
    }

    private func chipFont(for style: NoteFormatting.BlockStyle) -> Font {
        switch style {
        case .title: .title3.weight(.bold)
        case .heading: .headline
        case .subheading: .subheadline.weight(.semibold)
        case .body: .body
        case .monospaced: .body.monospaced()
        }
    }

    private func controlGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 0) {
            content()
        }
        .padding(Cockpit.Space.s1)
        .background(Cockpit.Color.raised, in: RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous))
    }

    private func inlineButton(
        _ systemImage: String,
        label: String,
        active: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            action()
            onChange()
        } label: {
            Image(systemName: systemImage)
                .font(.system(size: Cockpit.Size.iconMd))
                .foregroundStyle(Cockpit.Color.text)
                .frame(maxWidth: .infinity, minHeight: Cockpit.Size.target)
                .background(
                    active ? Cockpit.Color.thumb : .clear,
                    in: RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(active ? "On" : "Off")
        .accessibilityIdentifier("notes.editor.\(systemImage)")
    }
}
