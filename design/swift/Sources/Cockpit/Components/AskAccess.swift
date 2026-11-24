import SwiftUI

public struct AskAccessLine: View {
    let line: String
    let undoing: Bool
    let failed: String?
    let undo: (() -> Void)?

    public init(_ line: String, undoing: Bool = false, failed: String? = nil, undo: (() -> Void)? = nil) {
        self.line = line
        self.undoing = undoing
        self.failed = failed
        self.undo = undo
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
                Icon(.done, size: .sm).foregroundStyle(Cockpit.Color.engaged)
                Text(verbatim: line)
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isStaticText)
                Spacer(minLength: Cockpit.Space.s2)
                if let undo {
                    Button(action: undo) {
                        Text("Undo").cockpit(.body).foregroundStyle(Cockpit.Color.accent).frame(minHeight: Cockpit.Size.target)
                    }
                    .buttonStyle(.plain)
                    .overlay { if undoing { ProgressView() } }
                    .disabled(undoing)
                }
            }
            if let failed { InPlaceLine(failed) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

public struct AskAccessCard: View {
    public enum Answer: Equatable, Sendable { case allow, no }

    let head: String
    let adds: [String]
    let keeps: String?
    let screen: String?
    let answered: String?
    let allowed: Bool
    let words: (allow: String?, no: String)
    let sending: Answer?
    let failed: String?
    let answer: ((Answer) -> Void)?
    let edit: (() -> Void)?

    private static let column: CGFloat = 20
    private static let words: CGFloat = 30

    public init(head: String, adds: [String], keeps: String?, screen: String? = nil, answered: String? = nil, allowed: Bool = false,
                words: (allow: String?, no: String) = ("Allow", "No"), sending: Answer? = nil, failed: String? = nil,
                edit: (() -> Void)? = nil, answer: ((Answer) -> Void)?) {
        self.head = head
        self.adds = adds
        self.keeps = keeps
        self.screen = screen
        self.answered = answered
        self.allowed = allowed
        self.words = words
        self.sending = sending
        self.failed = failed
        self.answer = answer
        self.edit = edit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            row(Icon(.ai, size: .sm).foregroundStyle(Cockpit.Color.textSecondary)) {
                Text(verbatim: head).cockpit(.headline).foregroundStyle(Cockpit.Color.text).accessibilityAddTraits(.isHeader)
            }
            ForEach(adds, id: \.self) { add in
                row(Icon(.add, size: .sm).foregroundStyle(Cockpit.Color.engaged)) {
                    Text(verbatim: add).cockpit(.body).foregroundStyle(Cockpit.Color.text)
                }
            }
            if let keeps {
                row(EmptyView()) {
                    Text(verbatim: keeps).cockpit(.body).foregroundStyle(Cockpit.Color.textSecondary)
                }
            }
            if let screen { AccessNote(screen).padding(.top, Cockpit.Space.s2) }
            if let answered {
                Rectangle().fill(Cockpit.Color.hairline).frame(height: 1).padding(.top, Cockpit.Space.s3)
                row(Group { if allowed { Icon(.done, size: .sm).foregroundStyle(Cockpit.Color.engaged) } }) {
                    Text(verbatim: answered).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
                }
                .padding(.top, Cockpit.Space.s2)
                .accessibilityIdentifier("ask.access.answered")
            } else if let answer {
                HStack(spacing: Cockpit.Space.s3) {
                    if let edit {
                        Button("Edit", action: edit)
                            .buttonStyle(.cockpit(.plain))
                            .accessibilityIdentifier("ask.access.edit")
                    }
                    if let allow = words.allow {
                        Button(allow) { answer(.allow) }
                            .buttonStyle(.cockpit(.secondary, busy: sending == .allow, fullWidth: true))
                    }
                    Button(words.no) { answer(.no) }
                        .buttonStyle(.cockpit(.plain, busy: sending == .no, fullWidth: true))
                        .overlay { Capsule().strokeBorder(Cockpit.Color.border) }
                }
                .environment(\.cockpitButtonHeight, Cockpit.Size.target)
                .disabled(sending != nil)
                .padding(.top, Cockpit.Space.s4)
            }
            if answered == nil, let failed { InPlaceLine(failed) }
        }
        .padding(Cockpit.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Cockpit.Color.surface, in: RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous).strokeBorder(Cockpit.Color.border) }
        .accessibilityElement(children: .contain)
    }

    private func row<Mark: View, Words: View>(_ mark: Mark, @ViewBuilder words: () -> Words) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Self.words - Self.column) {
            mark.frame(width: Self.column, alignment: .leading)
            words().fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}
