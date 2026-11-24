import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct PageTalk: View {
    let talk: HomeLink.Pages.Talk?
    let reading: Bool
    var person = false

    private static let fits = 4

    var body: some View {
        if let talk {
            TalkSection(open: { AppNavigation.shared.push(.day(talk.day, focus: talk.focus)) }) {
                drawn(meta(talk), lines: Self.lines(talk), inGroup: talk.group)
            }
        } else if reading {
            TalkSection(open: nil) {
                drawn("Today 00:00" + Words.dot + "WhatsApp", lines: Self.sample, inGroup: false)
                    .reading(true)
            }
        }
    }

    private func drawn(_ meta: String, lines: [TalkLine], inGroup: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(meta)
                .cockpit(.footnote)
                .monospacedDigit()
                .foregroundStyle(Cockpit.Color.textTertiary)
                .lineLimit(1)
                .padding(.bottom, Cockpit.Space.s2)
                .accessibilityIdentifier("person.talk.when")
            ForEach(lines.indices, id: \.self) { lines[$0].group(inGroup) }
        }
    }

    private func meta(_ talk: HomeLink.Pages.Talk) -> String {
        let clock = talk.lines.last.map { Words.clock(Words.date(ms: Int64($0.atMs))) }
        let when = [PeopleWords.talkDay(talk.day, now: AppClock.now), clock].compactMap { $0 }.joined(separator: " ")
        let place = person && talk.group ? talk.title : talk.network
        return [when, place].filter { !$0.isEmpty }.joined(separator: Words.dot)
    }

    private static func lines(_ talk: HomeLink.Pages.Talk) -> [TalkLine] {
        var lastWho: String?
        return talk.lines.suffix(fits).enumerated().map { index, line in
            let turned = line.who != lastWho
            lastWho = line.who
            return TalkLine(who: line.name, turned: turned, words: line.text, forwarded: line.forwarded, mine: line.mine, first: index == 0)
        }
    }

    private static let sample = [
        TalkLine(who: "Person A", turned: true, words: "See you at the usual place tomorrow?", forwarded: false, mine: false, first: true),
        TalkLine(who: "Person A", turned: false, words: "Around six works", forwarded: false, mine: false, first: false),
        TalkLine(who: "You", turned: true, words: "Perfect, I will bring the synthetic cake", forwarded: false, mine: true, first: false),
    ]
}

private struct TalkSection<Content: View>: View {
    let open: (() -> Void)?
    let content: Content

    init(open: (() -> Void)?, @ViewBuilder content: () -> Content) {
        self.open = open
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
            SectionLabel("Last talked", action: open == nil ? nil : "Open the day", perform: open, actionIdentifier: "person.talk.open")
            content
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("person.talk")
        }
    }
}

private struct TalkLine: View {
    let who: String
    let turned: Bool
    let words: String
    let forwarded: Bool
    let mine: Bool
    let first: Bool
    var inGroup = false

    func group(_ group: Bool) -> TalkLine {
        var line = self
        line.inGroup = group
        return line
    }

    var body: some View {
        MessageBubble(Self.marked(words), mine: mine, speaker: inGroup && turned && !mine ? who : nil, forwarded: forwarded, lines: 3)
            .padding(.top, first ? 0 : turned ? Cockpit.Space.s2 : 2)
    }

    static func marked(_ words: String) -> String {
        var rest = Substring(words)
        var out = ""
        for match in rest.matches(of: /\[(photo|video|sticker|voice message|document)(?:: ([^\]]*))?\]/) {
            out += rest[rest.startIndex..<match.range.lowerBound]
            let kind = String(match.1)
            out += kind.prefix(1).uppercased() + kind.dropFirst() + (match.2.map { Words.dot + $0 } ?? "")
            rest = rest[match.range.upperBound...]
        }
        return out + rest
    }
}
