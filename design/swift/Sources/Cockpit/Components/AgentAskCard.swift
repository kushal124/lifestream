import SwiftUI

public struct AgentAskCard: View {
    public enum Answer: String, Equatable, Sendable {
        case once, always, no
    }

    public struct Choice: Equatable, Sendable {
        public let answer: Answer
        public let words: String

        public init(_ answer: Answer, _ words: String) {
            self.answer = answer
            self.words = words
        }
    }

    let name: String
    let icon: Cockpit.Icon
    let when: String?
    let place: String?
    let head: String
    let says: String?
    let fact: String?
    let today: [BoldRun]?
    let reason: String?
    let screen: String?
    let choices: [Choice]
    let preferred: Answer
    let sending: Answer?
    let failed: String?
    let outcome: String?
    let change: (() -> Void)?
    let done: () -> Void
    let answer: (Answer) -> Void
    @Environment(\.cockpitPlatform) private var platform
    @State private var height: CGFloat?
    @State private var safeFoot: CGFloat = 0

    public init(name: String = "", icon: Cockpit.Icon = .codingAgent, when: String? = nil, place: String? = nil, head: String, says: String? = nil,
                fact: String? = nil, today: [BoldRun]? = nil, reason: String?,
                screen: String? = nil, choices: [Choice], preferred: Answer, sending: Answer? = nil, failed: String? = nil,
                outcome: String? = nil, change: (() -> Void)?, done: @escaping () -> Void = {}, answer: @escaping (Answer) -> Void) {
        self.name = Self.plain(name)
        self.icon = icon
        self.when = when
        self.place = place
        self.head = Self.plain(head)
        self.says = says
        self.fact = fact.map(Self.plain)
        self.today = today
        self.reason = reason.map(Self.plain).flatMap { $0.isEmpty ? nil : $0 }
        self.screen = screen.map(Self.plain)
        self.choices = choices
        self.preferred = preferred
        self.sending = sending
        self.failed = failed
        self.outcome = outcome
        self.change = change
        self.done = done
        self.answer = answer
    }

    public static func stacked(_ choices: [Choice], preferred: Answer) -> [Choice] {
        choices.filter { $0.answer == preferred } + choices.filter { $0.answer != preferred }
    }

    public static func row(_ choices: [Choice], preferred: Answer) -> [Choice] {
        choices.filter { $0.answer == .no } + choices.filter { $0.answer != .no && $0.answer != preferred }
            + choices.filter { $0.answer == preferred && $0.answer != .no }
    }

    public static func quoted(_ reason: String) -> String { "\u{201C}" + reason + "\u{201D}" }

    public static func says(_ name: String) -> String { name.isEmpty ? "It says" : plain(name) + " says" }

    private static func plain(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
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
        VStack(alignment: .leading, spacing: Cockpit.Space.s5) {
            top
            if let outcome {
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                    Icon(.done, size: .md).foregroundStyle(Cockpit.Color.engaged)
                    Text(verbatim: outcome)
                        .cockpit(.title2)
                        .foregroundStyle(Cockpit.Color.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                Button("Done", action: done)
                    .buttonStyle(.cockpit(.secondary, fullWidth: true))
                    .environment(\.cockpitButtonHeight, Cockpit.Size.target)
            } else {
                VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                    Text(verbatim: head)
                        .cockpit(.title2)
                        .foregroundStyle(Cockpit.Color.text)
                        .accessibilityAddTraits(.isHeader)
                    under
                }
                .fixedSize(horizontal: false, vertical: true)
                if let reason { said(reason) }
                if let screen { AccessNote(screen) }
                buttons
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
        HStack(spacing: Cockpit.Space.s3) {
            IconTile(icon, side: Cockpit.Size.controlSm, radius: Cockpit.Radius.sm)
                .accessibilityHidden(true)
            Text(verbatim: name)
                .cockpit(.headline)
                .foregroundStyle(Cockpit.Color.text)
                .cockpitLines(1)
            if let when {
                Text(verbatim: when)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .cockpitLines(1)
            }
            Spacer(minLength: Cockpit.Space.s2)
            if let place {
                Text(verbatim: place)
                    .cockpit(.subhead)
                    .monospacedDigit()
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .cockpitLines(1)
            }
            if let change, outcome == nil {
                Button(action: change) {
                    Text("Edit").cockpit(.body).foregroundStyle(Cockpit.Color.text).frame(minHeight: Cockpit.Size.target)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(minHeight: Cockpit.Size.target)
    }

    private func said(_ reason: String) -> some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            Text(verbatim: says ?? Self.says(name))
                .cockpit(.footnote)
                .fontWeight(.semibold)
                .foregroundStyle(Cockpit.Color.textSecondary)
            Text(verbatim: Self.quoted(reason))
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.text)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var buttons: some View {
        VStack(spacing: Cockpit.Space.s2) {
            ForEach(Self.stacked(choices, preferred: preferred), id: \.answer) { choice in
                let kind: CockpitButtonStyle.Kind = choice.answer == .no ? .plain : choice.answer == preferred ? .primary : .secondary
                Button(choice.words) { answer(choice.answer) }
                    .buttonStyle(.cockpit(kind, busy: sending == choice.answer, fullWidth: true))
            }
        }
        .environment(\.cockpitButtonHeight, Cockpit.Size.controlLg)
        .padding(.top, Cockpit.Space.s1)
    }

    @ViewBuilder private var under: some View {
        if let today {
            BoldLine(today)
        } else if let fact {
            Text(verbatim: fact)
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
        }
    }


    private var panel: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s4) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: head)
                    .cockpit(.title2)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                under
            }
            if let reason {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: Self.says(name)).cockpit(.footnote).foregroundStyle(Cockpit.Color.textTertiary)
                    Text(verbatim: Self.quoted(reason)).cockpit(.body).foregroundStyle(Cockpit.Color.textSecondary)
                }
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let screen { AccessNote(screen) }
            HStack(spacing: Cockpit.Space.s2) {
                if let change { Button("Edit", action: change).buttonStyle(.cockpit(.plain)) }
                Spacer(minLength: Cockpit.Space.s2)
                ForEach(Self.row(choices, preferred: preferred), id: \.answer) { choice in
                    let filled = choice.answer == preferred && choice.answer != .no
                    if filled {
                        Button(choice.words) { answer(choice.answer) }
                            .buttonStyle(.cockpit(.primary, busy: sending == choice.answer))
                            .keyboardShortcut(.defaultAction)
                    } else {
                        Button(choice.words) { answer(choice.answer) }
                            .buttonStyle(.cockpit(.secondary, busy: sending == choice.answer))
                    }
                }
            }
            if let failed { InPlaceLine(failed) }
        }
        .disabled(sending != nil)
        .padding(.horizontal, platform.margin)
        .padding(.vertical, Cockpit.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .groundColor(Cockpit.Color.surface)
        .accessibilityElement(children: .contain)
    }
}

public struct AccessNote: View, Equatable {
    let words: String

    public init(_ words: String) {
        self.words = words
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
            Icon(.screen, size: .sm).foregroundStyle(Cockpit.Color.textSecondary)
            Text(verbatim: words)
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(Cockpit.Space.s3)
        .background(Cockpit.Color.well, in: RoundedRectangle(cornerRadius: Cockpit.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
