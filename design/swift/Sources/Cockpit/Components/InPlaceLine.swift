import SwiftUI

public struct InPlaceLine: View {
    public enum Said: Sendable, Equatable {
        case notSent
        case refused(String)
        case saving(String)
        case unknown(String)
    }

    let words: String
    let severity: Cockpit.Severity
    let act: String
    let retry: (() -> Void)?
    @Environment(\.cockpitPlatform) private var platform

    public init(_ words: String, severity: Cockpit.Severity = .stopped, act: String = "Try again", retry: (() -> Void)? = nil) {
        self.words = words
        self.severity = severity
        self.act = act
        self.retry = retry
    }

    public init(_ said: Said, act: String = "Try again", retry: (() -> Void)? = nil) {
        switch said {
        case .notSent: self.init("Not sent", act: act, retry: retry)
        case .refused(let words): self.init(words, act: act, retry: retry)
        case .saving(let words): self.init(words, severity: .waiting, act: "Check", retry: retry)
        case .unknown(let words): self.init(words, severity: .needs, act: act, retry: retry)
        }
    }

    public var body: some View {
        let ios = platform == .ios
        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
            SeverityMark(severity, size: ios ? 16 : 14)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + (ios ? 5 : 4.5) }
                .accessibilityRepresentation { Text(severity.word) }
            Text(words)
                .cockpit(ios ? .subhead : .body)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button(act, action: retry)
                    .buttonStyle(.plain)
                    .cockpit(ios ? .subhead : .body)
                    .fontWeight(.semibold)
                    .foregroundStyle(Cockpit.Color.text)
                    .lineLimit(1)
                    .fixedSize()
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, ios ? Cockpit.Space.s2 : 6)
        .accessibilityElement(children: .contain)
    }
}
