import SwiftUI

public struct AgentRequestCard: View {
    public enum Pick: Equatable, Sendable {
        case code(String)
        case deny
    }

    public struct Line: Equatable, Sendable, Identifiable {
        public let icon: Cockpit.Icon
        public let words: String
        public let label: String?

        public var id: Cockpit.Icon { icon }

        public init(_ icon: Cockpit.Icon, _ words: String, label: String? = nil) {
            self.icon = icon
            self.words = words
            self.label = label
        }
    }

    public struct Ended: Equatable, Sendable {
        public let title: String
        public let words: String?

        public init(_ title: String, words: String? = nil) {
            self.title = title
            self.words = words
        }
    }

    let head: String
    let line: String
    let pickTitle: String
    let pickLine: String?
    let sentence: String?
    let reads: [Line]
    let change: (() -> Void)?
    let sending: Pick?
    let failed: String?
    let ended: Ended?
    let done: () -> Void
    let pick: (Pick) -> Void
    @Environment(\.cockpitPlatform) private var platform
    @State private var height: CGFloat?
    @State private var safeFoot: CGFloat = 0

    public init(head: String, line: String, pickTitle: String, pickLine: String? = nil, sentence: String? = nil,
                reads: [Line] = [], change: (() -> Void)? = nil, sending: Pick? = nil, failed: String? = nil, ended: Ended? = nil,
                done: @escaping () -> Void = {}, pick: @escaping (Pick) -> Void) {
        self.head = head
        self.line = line
        self.pickTitle = pickTitle
        self.pickLine = pickLine
        self.sentence = sentence
        self.reads = reads
        self.change = change
        self.sending = sending
        self.failed = failed
        self.ended = ended
        self.done = done
        self.pick = pick
    }

    public var body: some View {
        if platform == .ios { SheetMargined { phone($0) } } else { panel }
    }

    private func phone(_ margin: CGFloat) -> some View {
        VStack(spacing: 0) {
            ScrollView { stack(margin) }
                .scrollBounceBehavior(.basedOnSize)
                .contentMargins(.bottom, (height ?? 0) - safeFoot >= Cockpit.sheetHugLimit ? safeFoot : 0, for: .scrollContent)
                .modifier(DrawerMeasured(height: $height))
                .ignoresSafeArea(.container, edges: .bottom)
        }
        .onSheetFootChange { safeFoot = $0 }
        .groundColor(Cockpit.Color.surface)
        .preference(key: SheetContentHeight.self, value: height)
        .accessibilityElement(children: .contain)
    }

    private func stack(_ margin: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
            top
            if let ended {
                if let words = ended.words {
                    Text(verbatim: words)
                        .cockpit(.body)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button("Close", action: done)
                    .buttonStyle(.cockpit(.secondary, fullWidth: true))
                    .environment(\.cockpitButtonHeight, Cockpit.Size.controlLg)
            } else {
                willRead
                picking
                Button { pick(.deny) } label: {
                    Text("Don\u{2019}t allow").cockpit(.headline).foregroundStyle(Cockpit.Color.text)
                        .frame(maxWidth: .infinity, minHeight: Cockpit.Size.target)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .overlay { if sending == .deny { ProgressView() } }
                if let failed { InPlaceLine(failed) }
            }
        }
        .disabled(sending != nil)
        .padding(.horizontal, margin)
        .padding(.top, Cockpit.Space.s6)
        .padding(.bottom, Cockpit.Gap.head)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var top: some View {
        HStack(alignment: .center, spacing: Cockpit.Space.s4) {
            VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                Text(verbatim: ended?.title ?? head)
                    .cockpit(.title2)
                    .foregroundStyle(Cockpit.Color.text)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: line)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var picking: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            Text(verbatim: pickTitle)
                .cockpit(.footnote)
                .fontWeight(.semibold)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            numbers
            if let pickLine {
                Text(verbatim: pickLine)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private var willRead: some View {
        if !reads.isEmpty || sentence != nil { WillSee(reads: reads, sentence: sentence, change: change) }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s5) {
            VStack(alignment: .leading, spacing: 2) {
                Text(head)
                    .cockpit(.title2)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: line)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let sentence {
                Text(Self.paragraph(sentence, change: change != nil && ended == nil))
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.text)
                    .tint(Cockpit.Color.accent)
                    .fixedSize(horizontal: false, vertical: true)
                    .environment(\.openURL, OpenURLAction { _ in
                        change?()
                        return .handled
                    })
            }
            if let ended { over(ended) } else { asking }
        }
        .padding(.horizontal, platform.margin)
        .padding(.vertical, Cockpit.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .groundColor(Cockpit.Color.surface)
        .accessibilityElement(children: .contain)
    }

    private static func paragraph(_ sentence: String, change: Bool) -> AttributedString {
        var made = AttributedString(sentence)
        guard change else { return made }
        var link = AttributedString("Edit")
        link.link = URL(string: "cockpit-change:")
        made.append(AttributedString(" "))
        made.append(link)
        return made
    }

    private var numbers: some View {
        CodeEntry(sending: sending, pick: pick)
    }

    private func over(_ ended: Ended) -> some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            Text(verbatim: [ended.title, ended.words].compactMap { $0 }.joined(separator: " "))
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer(minLength: 0)
                Button("Close", action: done)
                    .buttonStyle(.cockpit(.plain, size: .regular))
            }
        }
    }

    private var asking: some View {
        let size: CockpitButtonStyle.Size = .regular
        return VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            picking
            HStack {
                Spacer(minLength: 0)
                Button("Don\u{2019}t allow") { pick(.deny) }
                    .buttonStyle(.cockpit(.plain, size: size, busy: sending == .deny))
            }
            if let failed {
                InPlaceLine(failed)
            }
        }
        .disabled(sending != nil)
    }
}

public struct WillSee: View {
    let title: String
    let reads: [AgentRequestCard.Line]
    let sentence: String?
    let change: (() -> Void)?

    public init(title: String? = nil, reads: [AgentRequestCard.Line], sentence: String? = nil, change: (() -> Void)? = nil) {
        self.title = title ?? "It will see"
        self.reads = reads
        self.sentence = sentence
        self.change = change
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(verbatim: title).cockpit(.footnote).fontWeight(.semibold).foregroundStyle(Cockpit.Color.textSecondary)
                Spacer(minLength: Cockpit.Space.s2)
                if let change {
                    Button(action: change) {
                        Text("Edit").cockpit(.headline).foregroundStyle(Cockpit.Color.text).frame(minHeight: Cockpit.Size.target)
                    }
                    .buttonStyle(.plain)
                }
            }
            if reads.isEmpty, let sentence {
                Text(verbatim: sentence)
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(reads) { line in
                    HStack(spacing: Cockpit.Space.s3) {
                        if let label = line.label {
                            Text(verbatim: label)
                                .cockpit(.body)
                                .foregroundStyle(Cockpit.Color.text)
                            Spacer(minLength: Cockpit.Space.s3)
                            Text(verbatim: line.words)
                                .cockpit(.body)
                                .foregroundStyle(Cockpit.Color.textSecondary)
                                .multilineTextAlignment(.trailing)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            Icon(line.icon, size: .md).foregroundStyle(Cockpit.Color.textSecondary)
                            Text(verbatim: line.words)
                                .cockpit(.body)
                                .foregroundStyle(Cockpit.Color.text)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                    }
                    .frame(minHeight: Cockpit.Size.row)
                    .overlay(alignment: .bottom) {
                        if line != reads.last {
                            Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border)
                                .padding(.leading, line.label == nil ? Cockpit.Space.s8 : 0)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

public struct CodeEntry: View {
    public static let digits = 6
    let sending: AgentRequestCard.Pick?
    let pick: (AgentRequestCard.Pick) -> Void
    @State private var typed = ""

    public init(sending: AgentRequestCard.Pick? = nil, pick: @escaping (AgentRequestCard.Pick) -> Void) {
        self.sending = sending
        self.pick = pick
    }

    public static func code(_ typed: String) -> String? {
        let digits = typed.filter { !$0.isWhitespace && $0 != "-" }
        return digits.count == digits.utf8.count && digits.count == Self.digits && digits.allSatisfy(\.isASCII) && digits.allSatisfy(\.isNumber)
            ? digits : nil
    }

    private var busy: Bool { if case .code = sending { true } else { false } }

    public var body: some View {
        let code = Self.code(typed)
        HStack(spacing: Cockpit.Space.s2) {
            field
                .onSubmit { if let code, sending == nil { pick(.code(code)) } }
            Button("Allow") { if let code { pick(.code(code)) } }
                .buttonStyle(.cockpit(.primary, size: .regular, busy: busy))
                .disabled(code == nil || sending != nil)
                .accessibilityIdentifier("agent.allow")
        }
    }

    private var field: some View {
        let made = TextField("000 000", text: $typed)
            .cockpit(.figureL)
            .multilineTextAlignment(.center)
            .monospacedDigit()
            .autocorrectionDisabled()
            .disabled(sending != nil)
            .accessibilityLabel("Code")
            .accessibilityIdentifier("agent.code")
        #if os(iOS)
        return made.keyboardType(.numberPad).textContentType(.oneTimeCode)
        #else
        return made
        #endif
    }
}

