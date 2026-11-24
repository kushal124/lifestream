import SwiftUI

public struct BoldRun: Sendable, Hashable, Decodable {
    public let text: String
    public let bold: Bool

    public init(_ text: String, bold: Bool = false) {
        self.text = text
        self.bold = bold
    }

    private enum Keys: String, CodingKey { case text, bold }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: Keys.self)
        text = try fields.decode(String.self, forKey: .text)
        bold = try fields.decodeIfPresent(Bool.self, forKey: .bold) ?? false
    }
}

public struct BoldLine: View {
    let runs: [BoldRun]
    @Environment(\.cockpitPlatform) private var platform

    public init(_ bolded: [BoldRun]) {
        runs = bolded
    }

    public var body: some View {
        let line = Self.line(runs)
        line.text
            .cockpit(platform == .ios ? Cockpit.Style.iosSubhead : platform.style(.subhead))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(line.words)
    }

    static func line(_ runs: [BoldRun]) -> (text: Text, words: String) {
        runs.reduce((Text(verbatim: ""), "")) { line, run in
            let part = Text(verbatim: run.text)
                .foregroundStyle(run.bold ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                .fontWeight(run.bold ? .semibold : nil)
            return (Text("\(line.text)\(part)"), line.words + run.text)
        }
    }
}
