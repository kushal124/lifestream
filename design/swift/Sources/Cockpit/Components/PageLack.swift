import SwiftUI

public struct PageLack: View {
    let sentence: String
    let retry: (() -> Void)?

    public init(_ sentence: String, retry: (() -> Void)? = nil) {
        self.sentence = sentence
        self.retry = retry
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
            Text(sentence)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Try again", action: retry).buttonStyle(.cockpit(.plain, size: .small))
            }
        }
        .padding(.vertical, Cockpit.Space.s3)
        .unredacted()
        .accessibilityElement(children: .contain)
    }
}

public extension EnvironmentValues {
    @Entry var reachLacks: Bool = false
}
