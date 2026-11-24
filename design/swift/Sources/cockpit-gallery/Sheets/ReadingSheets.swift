#if os(macOS)
import SwiftUI
@testable import Cockpit


@MainActor let readingSheet = Sheet("reading", hosted: true) {
    Specimen("Rows reading, the breath at selection: the words, the symbol's square, the face, the tile empty; Chrome's name and icon known") {
        streams.reading(true).environment(\.skeletonForced, 0)
    }
    Specimen("The breath at hover") {
        streams.reading(true).environment(\.skeletonForced, 1)
    }
    Specimen("Before patience: the line's place kept after the last row, unseen") {
        VStack(alignment: .leading, spacing: 0) {
            streams
            WaitLine()
        }
        .reading(true)
        .environment(\.skeletonForced, 0)
    }
    Specimen("Past patience: after the last row, “Waiting for Lifestream.”") {
        VStack(alignment: .leading, spacing: 0) {
            streams
            waited
        }
        .reading(true)
        .environment(\.skeletonForced, 0)
    }
    Specimen("Read: the same rows, in place, the line gone with the skeletons") {
        VStack(alignment: .leading, spacing: 0) {
            streams
            WaitLine()
        }
        .reading(false)
    }
    Specimen("A hit reading: its title, its time and two lines of words") {
        Card(flush: true) {
            hit
            hit
        }
        .reading(true)
        .environment(\.skeletonForced, 0.5)
    }
    Specimen("A figure reading: the amount and its words as bars, a low column a week, the ends as words") {
        Card {
            WeekFigure("1,494", words: "messages in the last 30 days",
                       bars: (0..<104).map { WeekFigure.Bar(count: 0, when: "week \($0 + 1)") }, ends: ("Oct 2024", "This week"))
        }
        .reading(true)
        .environment(\.skeletonForced, 0.5)
    }
    Specimen("Counts not read yet: Connected chosen, unfilled") {
        Views("Connectors", options: [.init("Connected", id: 0, reading: true), .init("Add more", id: 1, reading: true)],
              selection: .constant(0))
            .environment(\.skeletonForced, 0)
    }
    Specimen("Counts read") {
        Views("Connectors", options: [.init("Connected", id: 0, count: 24), .init("Add more", id: 1, count: 9)], selection: .constant(0))
    }
    Specimen("A day reading: its figures, then three stays folded and two moves, each a bar where its words will be") {
        day.environment(\.skeletonForced, 0.5)
    }
    Specimen("A moment reading: the head its row showed, a conversation's bubbles") {
        InspectorFrame("Person A", icon: .message, when: "09:14–09:28 · 14 min · WhatsApp") {
            bubbles.reading(true)
        }
        .frame(height: 330)
        .environment(\.skeletonForced, 0.5)
    }
    Specimen("Opened from a link that knew nothing of it: the tile empty, the head's words bars") {
        InspectorFrame("A moment of your life", icon: .info, when: "Fri 16 Oct · 09:14–09:28 · WhatsApp", reading: true) {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                Text("The words of this moment, as its source keeps them, read").cockpit(.body).lineLimit(1)
                Text("from Lifestream and drawn here at once when they").cockpit(.body).lineLimit(1)
                Text("arrive in this place").cockpit(.body)
            }
            .reading(true)
        }
        .frame(height: 220)
        .environment(\.skeletonForced, 0.5)
    }
}

@MainActor private var day: some View {
    VStack(spacing: 0) {
        FigureRow([.init("5h 50m", "asleep"), .init("7,412", "steps"), .init("63", "recovery")])
        StayHead("One two three four five six", time: "04:00", length: "5h", glyph: .home, line: "One two",
                 rail: .starts, action: {})
        NamesLine(["One two three four five six seven eight nine ten"]) { _ in }
        DayRow(.move(icon: .walk, words: "One two three", length: "9m"), time: "09:58")
        StayHead("One two three four five six", time: "10:08", length: "7h", glyph: .place, line: "One two",
                 action: {})
        NamesLine(["One two three four five six seven eight nine ten"]) { _ in }
        DayRow(.move(icon: .drive, words: "One two three", length: "9m"), time: "17:40")
        StayHead("One two three four five six", time: "17:52", length: "4h", glyph: .place, line: "One two",
                 rail: .ends, action: {})
    }
    .padding(.horizontal, -Cockpit.Space.s4)
    .reading(true)
}

@MainActor private var bubbles: some View {
    VStack(spacing: 2) {
        MessageBubble("Are we still on for tonight?", mine: false)
        MessageBubble("The usual place, the one with the long tables by the window", mine: false)
        MessageBubble("Yes, see you there at eight", mine: true).padding(.top, Cockpit.Space.s2)
        MessageBubble("Great", mine: false).padding(.top, Cockpit.Space.s2)
    }
}

@MainActor private var waited: WaitLine {
    var line = WaitLine()
    line.forced = true
    return line
}

@MainActor private var streams: some View {
    VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
        Card("Conversations", group: true) {
            ListRow("iMessage", meta: "29 messages today", mono: true, leading: .symbol(.message), action: {})
            ListRow("Person A", meta: "Last yesterday", leading: .monogram("Person A"), action: {})
            ListRow("WhatsApp", meta: "140 messages today", mono: true, leading: .symbol(.message), separator: false, action: {})
        }
        Card("Body", group: true) {
            ListRow("Health", meta: "Steps, sleep and workouts", detail: "Allow Health", leading: .icon(.health), separator: false,
                    action: {})
        }
        Card("Devices", group: true) {
            ListRow("Chrome", meta: "Running in Chrome", leading: .symbol(.web), known: true, separator: false)
        }
    }
}

@MainActor private var hit: some View {
    HStack(alignment: .top, spacing: Cockpit.Space.s3) {
        IconTile(.mail)
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text("The synthetic invoice").cockpit(.rowTitle).frame(maxWidth: .infinity, alignment: .leading)
                Text("16:42").cockpit(.monoTime)
            }
            Text("Your synthetic invoice for October is attached, with the receipt for the synthetic order placed last week.")
                .cockpit(.subhead)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    .padding(.horizontal, Cockpit.Space.s4)
    .padding(.vertical, 10)
}
#endif
