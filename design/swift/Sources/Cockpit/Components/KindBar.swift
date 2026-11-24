import SwiftUI

public struct KindBar: View {
    public struct Part: Sendable, Hashable {
        public let name: String
        public let n: Int

        public init(_ name: String, n: Int) {
            self.name = name
            self.n = n
        }
    }

    static let shown = 5
    static let other = "Other"
    static let gap: CGFloat = 2
    static let least: CGFloat = 2

    let parts: [Part]
    @Environment(\.cockpitPlatform) private var platform

    public init(parts: [Part]) {
        self.parts = Self.folded(parts)
    }

    public var body: some View {
        let phone = platform == .ios
        VStack(alignment: .leading, spacing: phone ? Cockpit.Space.s2 : 6) {
            GeometryReader { proxy in
                let widths = Self.widths(parts.map(\.n), in: proxy.size.width)
                HStack(spacing: Self.gap) {
                    ForEach(parts.indices, id: \.self) { index in
                        Rectangle().fill(Self.ink(index)).frame(width: widths[index])
                    }
                }
            }
            .frame(height: phone ? 12 : 8)
            .clipShape(RoundedRectangle(cornerRadius: phone ? 4 : Cockpit.Radius.s2xs, style: .continuous))
            FlowLayout(spacing: Cockpit.Space.s4, lineSpacing: Cockpit.Space.s1) {
                ForEach(parts.indices, id: \.self) { index in
                    HStack(spacing: Cockpit.Space.s1) {
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(Self.ink(index))
                            .frame(width: 8, height: 8)
                        Text(Self.words(parts[index]))
                            .cockpit(phone ? Cockpit.Style.iosFootnote : platform.style(.footnote))
                            .monospacedDigit()
                            .foregroundStyle(Cockpit.Color.textSecondary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(parts.map(Self.words).joined(separator: ", "))
    }

    static func words(_ part: Part) -> String {
        "\(part.name) \(part.n.formatted(.number.locale(Locale(identifier: "en_US"))))"
    }

    static func folded(_ parts: [Part]) -> [Part] {
        let counted = parts.filter { $0.n > 0 }
        guard counted.count > shown else { return counted }
        let rest = counted.dropFirst(shown).reduce(0) { $0 + $1.n }
        return Array(counted.prefix(shown)) + [Part(other, n: rest)]
    }

    static func ink(_ index: Int) -> Color {
        if index >= shown { return Cockpit.Color.storageOther }
        return [Cockpit.Color.storage1, Cockpit.Color.storage2, Cockpit.Color.storage3, Cockpit.Color.storage4, Cockpit.Color.storage5][index]
    }

    static func widths(_ counts: [Int], in width: CGFloat) -> [CGFloat] {
        let total = counts.reduce(0, +)
        guard total > 0 else { return counts.map { _ in 0 } }
        let room = max(0, width - gap * CGFloat(counts.count - 1))
        let small = Set(counts.indices.filter { CGFloat(counts[$0]) / CGFloat(total) * room < least })
        let large = counts.indices.filter { !small.contains($0) }.reduce(0) { $0 + counts[$1] }
        let left = max(0, room - least * CGFloat(small.count))
        return counts.indices.map { index in
            small.contains(index) ? least : CGFloat(counts[index]) / CGFloat(max(large, 1)) * left
        }
    }
}
