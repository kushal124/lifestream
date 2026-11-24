import SwiftUI

public enum DayWord {
    case text(String)
    case quiet(String)
    case quote(String)
    case items([String])
    case tiles([Image?], more: Int)

    var said: String? {
        switch self {
        case let .text(words), let .quiet(words): words
        case let .quote(words): words
        case let .items(items): items.joined(separator: ", ")
        case .tiles: nil
        }
    }
}

struct WordsLine: View {
    let words: [DayWord]
    var led = false

    init(words: [DayWord], led: Bool = false) {
        self.words = words.flatMap { word -> [DayWord] in
            if case let .text(facts) = word { facts.components(separatedBy: " \u{00B7} ").map(DayWord.text) } else { [word] }
        }
        self.led = led
    }

    var body: some View {
        let firstQuote = words.firstIndex { if case .quote = $0 { true } else { false } }
        WordsLayout(led: led) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                Offered {
                    if index == 0, !led {
                        part(word)
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 0) {
                            if index > 0, Self.quote(word), Self.quote(words[index - 1]) {
                                Color.clear.frame(width: Self.quoteGap, height: 0)
                            } else {
                                Text(" \u{00B7} ")
                                    .cockpit(Cockpit.Style.iosSubhead)
                                    .foregroundStyle(Cockpit.Color.textTertiary)
                                    .fixedSize()
                            }
                            part(word)
                        }
                    }
                }
                    .layoutValue(key: Cuts.self, value: Self.cuts(word, line: index == 0, first: index == firstQuote))
            }
        }
    }

    static let quoteGap: CGFloat = 8

    private static func quote(_ word: DayWord) -> Bool {
        if case .quote = word { true } else { false }
    }

    private static func cuts(_ word: DayWord, line: Bool, first: Bool) -> Bool {
        switch word {
        case .text, .quiet: line
        case .items: true
        case .quote: first
        case .tiles: false
        }
    }

    @ViewBuilder private func part(_ word: DayWord) -> some View {
        switch word {
        case let .text(words): CutText(text: words, style: Cockpit.Style.iosSubhead, tone: Cockpit.Color.textSecondary)
        case let .quiet(words): CutText(text: words, style: Cockpit.Style.iosSubhead, tone: Cockpit.Color.textTertiary)
        case let .quote(words): CutText(text: words, style: Cockpit.Style.iosSubhead, tone: Cockpit.Color.textSecondary, quoted: true)
        case let .items(items): CutItems(items: items)
        case let .tiles(tiles, more): TileRun(tiles: tiles, more: more)
        }
    }
}

private struct Cuts: LayoutValueKey {
    static let defaultValue = false
}

struct WordsLayout: Layout {
    var led = false
    static let leastCut: CGFloat = 24
    static let dot: CGFloat = 12

    private struct Placed {
        let index: Int
        let x: CGFloat
        let width: CGFloat?
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [Placed] {
        var placed: [Placed] = []
        var x: CGFloat = 0
        for index in subviews.indices {
            let ideal = subviews[index].sizeThatFits(.unspecified).width
            if x + ideal <= width {
                placed.append(Placed(index: index, x: x, width: nil))
                x += ideal
                continue
            }
            let room = width - x
            if subviews[index][Cuts.self], room >= Self.leastCut + (placed.isEmpty && !led ? 0 : Self.dot) {
                placed.append(Placed(index: index, x: x, width: room))
            }
            break
        }
        return placed
    }

    private func measure(_ placed: [Placed], _ subviews: Subviews) -> (parts: [(CGSize, CGFloat)], ascent: CGFloat, height: CGFloat) {
        let parts = placed.map { item -> (CGSize, CGFloat) in
            let dimensions = subviews[item.index].dimensions(in: ProposedViewSize(width: item.width, height: nil))
            return (CGSize(width: dimensions.width, height: dimensions.height), dimensions[.firstTextBaseline])
        }
        let ascent = parts.map(\.1).max() ?? 0
        let descent = parts.map { $0.0.height - $0.1 }.max() ?? 0
        return (parts, ascent, ascent + descent)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let placed = arrange(width, subviews)
        let line = measure(placed, subviews)
        let used = zip(placed, line.parts).map { $0.x + $1.0.width }.max() ?? 0
        return CGSize(width: proposal.width ?? used, height: line.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let placed = arrange(bounds.width, subviews)
        let line = measure(placed, subviews)
        var shown = Set<Int>()
        for (item, part) in zip(placed, line.parts) {
            shown.insert(item.index)
            subviews[item.index].place(at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + line.ascent - part.1),
                                       proposal: ProposedViewSize(width: item.width, height: nil))
        }
        for index in subviews.indices where !shown.contains(index) {
            subviews[index].place(at: bounds.origin, proposal: .zero)
        }
    }

    func explicitAlignment(of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews,
                           cache: inout ()) -> CGFloat? {
        guard guide == .firstTextBaseline || guide == .lastTextBaseline else { return nil }
        return bounds.minY + measure(arrange(bounds.width, subviews), subviews).ascent
    }
}

struct CutText: View {
    let text: String
    let style: Cockpit.TextStyle
    let tone: Color
    var quoted = false

    private static let mostWords = 24

    var body: some View {
        let words = text.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        ViewThatFits(in: .horizontal) {
            styled(quoted ? "\u{201C}\(text)\u{201D}" : text)
            ForEach(Self.prefixes(words), id: \.self) { kept in
                styled(quoted ? "\u{201C}\(kept)\u{2026}\u{201D}" : "\(kept)\u{2026}")
            }
            HStack(spacing: 0) {
                styled((quoted ? "\u{201C}" : "") + (words.first ?? "")).truncationMode(.tail)
                if quoted { styled("\u{201D}").fixedSize() }
            }
        }
    }

    static func prefixes(_ words: [String]) -> [String] {
        guard words.count > 1 else { return [] }
        return (1..<min(words.count, mostWords + 1)).reversed().map { count in
            words.prefix(count).joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: ",.;:–—-"))
        }
    }

    private func styled(_ words: String) -> some View {
        Text(words).cockpit(style).foregroundStyle(tone).lineLimit(1)
    }
}

struct CutItems: View {
    let items: [String]

    var body: some View {
        if let first = items.first {
            ViewThatFits(in: .horizontal) {
                ForEach((1...items.count).reversed(), id: \.self) { count in
                    Text(items.prefix(count).joined(separator: ", "))
                        .cockpit(Cockpit.Style.iosSubhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .lineLimit(1)
                }
                CutText(text: first, style: Cockpit.Style.iosSubhead, tone: Cockpit.Color.textSecondary)
            }
        }
    }
}

struct TileRun: View {
    let tiles: [Image?]
    let more: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(tiles.prefix(4).enumerated()), id: \.offset) { _, picture in RunTile(picture: picture) }
            if more > 0 {
                Text("+\(ContactRun.number(more))")
                    .cockpit(Cockpit.Style.iosSubhead)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.leading, 4)
            }
        }
        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
    }
}

private struct RunTile: View {
    let picture: Image?
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.xs, style: .continuous)
        Group {
            if redaction.skeleton {
                shape.fill(tone)
            } else {
                shape.fill(Cockpit.Color.raised)
                    .overlay { picture?.resizable().scaledToFill() }
                    .clipShape(shape)
                    .overlay { shape.strokeBorder(Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border) }
            }
        }
        .frame(width: 20, height: 20)
    }
}
