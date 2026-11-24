import SwiftUI

public struct NoneLine: View {
    let sentence: String
    let detail: String?

    public init(_ sentence: String, detail: String? = nil) {
        self.sentence = sentence
        self.detail = detail
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
            Text(sentence).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
            if let detail { Text(detail).cockpit(.footnote).foregroundStyle(Cockpit.Color.textTertiary) }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
