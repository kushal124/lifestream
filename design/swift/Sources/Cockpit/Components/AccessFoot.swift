import SwiftUI

public enum AccessAnswer {
    case none
    case undo(() -> Void)
    case done(() -> Void)
    case allow(cancel: () -> Void, allow: () -> Void)
}

public struct AccessFoot<Start: View>: View {
    let lines: [String]
    let answer: AccessAnswer
    let busy: Bool
    let start: Start
    @Environment(\.cockpitPlatform) private var platform

    public init(_ words: String? = nil, answer: AccessAnswer = .none, busy: Bool = false, @ViewBuilder start: () -> Start) {
        self.init(lines: words.map { [$0] } ?? [], answer: answer, busy: busy, start: start)
    }

    public init(lines: [String], answer: AccessAnswer = .none, busy: Bool = false, @ViewBuilder start: () -> Start) {
        self.lines = lines
        self.answer = answer
        self.busy = busy
        self.start = start()
    }

    public var body: some View {
        HStack(alignment: .center, spacing: Cockpit.Space.s3) {
            start
            if platform == .ios, !lines.isEmpty {
                said(.leading).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Spacer(minLength: 0)
                if !lines.isEmpty { said(.trailing) }
            }
            acts
        }
        .frame(maxWidth: .infinity, minHeight: Cockpit.Size.controlMd)
    }

    private func said(_ alignment: TextAlignment) -> some View {
        VStack(alignment: alignment == .leading ? .leading : .trailing, spacing: Cockpit.Space.s1) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(verbatim: line)
                    .cockpit(platform == .ios ? .subhead : .body)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .cockpitLines(2)
                    .multilineTextAlignment(alignment)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("access.foot.words")
    }

    @ViewBuilder private var acts: some View {
        switch answer {
        case .none:
            EmptyView()
        case .undo(let undo):
            Button("Undo", action: undo)
                .buttonStyle(.cockpit(.secondary, size: platform == .ios ? .regular : .small, busy: busy, key: platform == .mac ? "⌘Z" : nil))
                .keyboardShortcut("z", modifiers: .command)
                .accessibilityIdentifier("access.undo")
        case .done(let done):
            Button("Done", action: done)
                .buttonStyle(.cockpit(.primary, size: platform == .ios ? .regular : .small, busy: busy))
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("access.done")
        case .allow(let cancel, let allow):
            Button("Cancel", action: cancel)
                .buttonStyle(.cockpit(.plain, size: platform == .ios ? .regular : .small))
                .disabled(busy)
                .accessibilityIdentifier("access.cancel")
            Button("Allow", action: allow)
                .buttonStyle(.cockpit(.primary, size: platform == .ios ? .regular : .small, busy: busy))
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("access.allow")
        }
    }
}

public extension AccessFoot where Start == EmptyView {
    init(_ words: String? = nil, answer: AccessAnswer = .none, busy: Bool = false) {
        self.init(words, answer: answer, busy: busy) { EmptyView() }
    }

    init(lines: [String], answer: AccessAnswer = .none, busy: Bool = false) {
        self.init(lines: lines, answer: answer, busy: busy) { EmptyView() }
    }
}
