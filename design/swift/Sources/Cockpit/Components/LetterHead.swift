import SwiftUI

public struct LetterHead: View {
    let name: String
    let address: String?
    let to: String?
    let at: String?

    public init(_ name: String, address: String? = nil, to: String? = nil, at: String? = nil) {
        self.name = name
        self.address = address
        self.to = to
        self.at = at
    }

    public var body: some View {
        HStack(alignment: .top, spacing: Cockpit.Space.s3) {
            Monogram(name, size: .md)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                    Text(name)
                        .cockpit(.headline)
                        .foregroundStyle(Cockpit.Color.text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let at {
                        Text(at)
                            .cockpit(.monoTime)
                            .monospacedDigit()
                            .foregroundStyle(Cockpit.Color.textTertiary)
                            .fixedSize()
                    }
                }
                if let address, address != name {
                    Text(address)
                        .cockpit(.footnote)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .lineLimit(1)
                        .textSelection(.enabled)
                }
                if let to {
                    Text(to)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .lineLimit(2)
                        .padding(.top, 2)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
