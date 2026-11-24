#if os(macOS)
import CoreLocation
import SwiftUI
@testable import Cockpit


private struct Screen<Content: View>: View {
    var typeSize = DynamicTypeSize.large
    @ViewBuilder let content: Content
    var body: some View {
        content
            .padding(.horizontal, -Cockpit.Space.s4)
            .environment(\.dynamicTypeSize, typeSize)
    }
}

private struct Shot: Identifiable {
    let id: Int
}

@MainActor private func tile(_ n: Int) -> Image? {
    StandInPhoto.image(n, size: 60).map { Image(decorative: $0, scale: 1) }
}

private let phone: CGFloat = 402

@MainActor private func air(_ height: CGFloat, _ rail: DayRail = .through) -> some View {
    Color.clear.frame(height: height).dayRail(rail)
}


@MainActor let dayFoldSheet = Sheet("day-fold", ios: phone, platforms: [.ios]) {
    Specimen("Today, every stay folded") {
        Screen {
            VStack(spacing: 0) {
                FigureRow([.init("7h 21m", "asleep"), .init("1,754", "steps so far"), .init("63", "recovery")])
                air(24, .none)
                DayRow(.allDay(title: "Visit: City A", facts: "Calendar \u{00B7} all day, 2 to 5 May"), time: nil, rail: .none, action: {})
                air(16, .none)
                StayHead("Harbour Home", time: "04:00", length: "5h 33m", glyph: .home, line: "since Thu 21:53",
                         rail: .starts, action: {})
                NamesLine(["Woke 08:37", "Group Alpha", "Mac 29m", "Person B", "Ask", "Person C", "Person D"]) { _ in }
                air(16)
                DayRow(.move(icon: .drive, words: "Drive 1.8 km", length: "5m"), time: "09:33")
                air(8)
                StayHead("Corner Gym", time: "09:38", length: "1h 13m", glyph: .place, line: "15th day here since 19 Sep",
                         action: {})
                NamesLine(["Music", "Workout 45m", "Person E", "Person F"]) { _ in }
                PhotoStrip((0..<9).map(Shot.init), label: { "Photo \($0.id)" }, open: { _ in }) { DrawnPhoto(n: $0.id) }
                air(16)
                DayRow(.move(icon: .drive, words: "Drive 1.5 km", more: "0.9 km of it not recorded", length: "6m"), time: "10:51")
                air(8)
                StayHead("Harbour Home", time: "10:57", length: "4h 48m", glyph: .home, line: "since 10:57", action: {})
                NamesLine(["Mac 3h 49m", "Claude Code", "Person E", "Garage North", "Dictated", "Searched", "Group Beta",
                           "Person F", "Endel 43m", "Person A", "Person G"]) { _ in }
                air(16)
                DayRow(.now(updated: "15:42"), time: "15:45",
                       rail: DayRail(above: .life, below: .plan))
                DayRow(.plan(title: "Dinner with Person A", facts: "in 7h 45m \u{00B7} Calendar \u{00B7} accepted",
                             length: "30m"), time: "23:30", rail: DayRail(above: .plan, below: .none), action: {})
                DayRow(.dayEnd(next: "Saturday 24 October"), time: "04:00", rail: .none)
            }
        }
    }
}

@MainActor let dayOpenSheet = Sheet("day-open", ios: phone, platforms: [.ios]) {
    Specimen("A stay opened in place, its rows") {
        Screen {
            VStack(spacing: 0) {
                VStack(spacing: 0) {
                    StayHead("Harbour Home", time: "10:57", length: "4h 48m", glyph: .home, line: "since 10:57",
                             state: .open, action: {})
                    air(4)
                    DayRow(.item(icon: .workMac, name: "Mac", words: [.items(["Browser 1h 13m", "Lifestream 21m", "Notes 15m"]),
                                                                  .quiet("Release notes")],
                                 count: .text("2h 6m")), time: "11:01", action: {})
                    DayRow(.item(icon: .codingAgent, name: "Claude Code", detail: "lifestream",
                                 words: [.quote("we built the photo pages and the face index, can you set up the scratch home with synthetic data")],
                                 count: .text("17 prompts")), time: "11:04", selected: true, action: {})
                    DayRow(.item(icon: .message, name: "Person E", words: [.text("Sent 2 documents, 2 photos")],
                                 count: .runs([.sent(4)])), time: "11:58", action: {})
                    DayRow(.item(icon: .call, name: "Garage North", words: [.text("Missed call"), .quiet("not returned yet")],
                                 count: .runs([.missed(1)])), time: "12:01", action: {})
                    DayRow(.item(icon: .voiceNote, name: "Dictated", detail: "to Claude Code",
                                 words: [.quote("Can you add the following issues to the project? The first one is the flow for the archive")],
                                 count: .text("4 dictations")), time: "12:33", action: {})
                    DayRow(.item(icon: .listening, name: "Nothing recorded", words: [.text("Endel \u{00B7} Fall Asleep, Settle In, Nap")],
                                 count: .text("43m"), quiet: true), time: "13:14", action: {})
                    DayRow(.item(icon: .meeting, name: "Group Alpha", words: [.quote("In for the weekend"), .quote("Not sure all three days"),
                                                                                .quote("Why")],
                                 count: .runs([.sent(4)])), time: "14:06", action: {})
                }
                air(12)
                DayRow(.move(icon: .walk, words: "Walk 0.6 km", names: "Person A, Music", length: "9m", open: false),
                       time: "15:42", action: {})
            }
        }
    }
    Specimen("More than 12 rows: the stay's hours, one open") {
        Screen {
            VStack(spacing: 0) {
                StayHead("Northside Studio", time: "09:12", length: "8h 40m", glyph: .place, line: "4 of the last 35 days",
                         state: .open, action: {})
                air(4)
                DayRow(.hour(names: "Person A, Group Alpha, Person B and 6 others", count: .runs([.sent(14)]), open: false),
                       time: "09:00", action: {})
                VStack(spacing: 0) {
                    DayRow(.hour(names: "Person C, Mac 52m, Ask and 2 others", count: .runs([.sent(3)]), open: true),
                           time: "10:00", action: {})
                    DayRow(.item(icon: .message, name: "Person C", words: [.quote("On my way"), .quote("Ten minutes")],
                                 count: .runs([.sent(2)])), time: "10:04", action: {})
                    DayRow(.item(icon: .ai, name: "Ask", detail: "Trip to City A", words: [.quote("when did we last go there together")],
                                 count: .text("1 prompt")), time: "10:21", action: {})
                }
                DayRow(.hour(names: "6 chats wrote to you", open: false), time: "11:00", action: {})
            }
        }
    }
    Specimen("Scrolled inside the open stay: its head pinned under the bar") {
        Screen {
            VStack(spacing: 0) {
                StayHead("Harbour Home", time: "10:57", length: "4h 48m", glyph: .home, line: "since 10:57",
                         state: .pinned, action: {})
                DayRow(.item(icon: .message, name: "Person E", words: [.quote("Sounds good"), .quote("Ok")],
                             count: .runs([.sent(3)])), time: "14:06", action: {})
            }
        }
    }
}


@MainActor let stayHeadSheet = Sheet("stay-head", ios: phone, platforms: [.ios]) {
    Specimen("Folded, the day's first (the line starts at its disc)") {
        Screen { StayHead("Harbour Home", time: "04:00", length: "5h 33m", glyph: .home, line: "since Thu 21:53", rail: .starts, action: {}) }
    }
    Specimen("Open") {
        Screen { StayHead("Corner Gym", time: "09:38", length: "1h 13m", glyph: .place, line: "15th day here since 19 Sep", state: .open, action: {}) }
    }
    Specimen("Pinned under the bar") {
        Screen { StayHead("Corner Gym", time: "09:38", length: "1h 13m", glyph: .place, line: "15th day here since 19 Sep", state: .pinned, action: {}) }
    }
    Specimen("Its line coming (read after the day)") {
        Screen { StayHead("Northside Studio", time: "12:30", length: "4h 12m", glyph: .place, line: .coming, action: {}) }
            .environment(\.skeletonForced, 0.3)
    }
    Specimen("No place recorded, on the track") {
        Screen { StayHead("No place recorded", time: "11:12", length: "1h 18m", glyph: nil, rail: .through(.track), action: {}) }
    }
    Specimen("No time (the day's untimed records)") {
        Screen { StayHead("Also that day", time: nil, length: nil, glyph: nil, rail: .through(.track), action: {}) }
    }
    Specimen("A stay with no rows: no caret, not a button") {
        Screen { StayHead("Harbour Point", time: "17:02", length: "8m", glyph: .place, line: "landed") }
    }
    Specimen("Unnamed: by what it is near, quieter, its dot hollow, and Name it after its line") {
        Screen { StayHead("Near Harbour Home", time: "17:51", length: "1h 9m", glyph: .place, line: "1.8 km away", unnamed: true,
                          nameIt: .init {}, action: {}) }
    }
    Specimen("Unnamed under a city: Name it alone on its line") {
        Screen { StayHead("Lisbon", time: "13:00", length: "1h 30m", glyph: .place, unnamed: true, nameIt: .init {}, action: {}) }
    }
    Specimen("Unnamed, no spot to name: the same head, no link, its line's room kept") {
        Screen {
            VStack(spacing: 0) {
                StayHead("Near The Office", time: "19:06", length: "24m", glyph: .place, line: "0.6 km away", unnamed: true, action: {})
                StayHead("Unnamed place", time: "16:00", length: "1h", glyph: .place, unnamed: true, action: {})
            }
        }
    }
    Specimen("A long name, cut before its length") {
        Screen { StayHead("Harbour Point Light Station State Historic Park", time: "13:40", length: "2h 5m", glyph: .place, line: "first day here", action: {}) }
    }
    Specimen("Pressed") {
        Screen { set(StayHead("Corner Gym", time: "09:38", length: "1h 13m", glyph: .place, line: "15th day here since 19 Sep", action: {}), \.forced, .pressed) }
    }
    Specimen("Accessibility size (AX3): the time above the name") {
        Screen(typeSize: .accessibility3) { StayHead("Corner Gym", time: "09:38", length: "1h 13m", glyph: .place, line: "15th day here since 19 Sep", action: {}) }
    }
    Specimen("Reading") {
        Screen { StayHead("Harbour Home", time: "04:00", length: "5h 33m", glyph: .home, line: "since Thu", action: {}) }
            .reading(true).environment(\.skeletonForced, 0.3)
    }
}

@MainActor let namesLineSheet = Sheet("names-line", ios: phone, platforms: [.ios]) {
    Specimen("One line") {
        Screen { NamesLine(["Music", "Workout 45m", "Person E"]) { _ in } }
    }
    Specimen("Two lines, the rest as +N") {
        Screen {
            NamesLine(["Mac 3h 49m", "Claude Code", "Person E", "Garage North", "Dictated", "Searched", "Group Beta",
                       "Person F", "Endel 43m", "Person A", "Person G", "Mail", "Codex"]) { _ in }
        }
    }
    Specimen("A first name longer than the band, cut before its +N") {
        Screen { NamesLine(["The Northside Community Design and Architecture Studio Members", "Person A"]) { _ in } }
    }
    Specimen("Accessibility size (AX3): three lines at most") {
        Screen(typeSize: .accessibility3) {
            NamesLine(["Mac 3h 49m", "Claude Code", "Person E", "Garage North", "Dictated", "Searched", "Group Beta",
                       "Person F", "Endel 43m"]) { _ in }
        }
    }
}

@MainActor let photoStripSheet = Sheet("photo-strip", ios: phone, platforms: [.ios]) {
    ForEach([1, 3, 4, 9], id: \.self) { count in
        Specimen(count == 9 ? "Nine: the fourth the door to the other six" : "\(count) photo\(count == 1 ? "" : "s")") {
            Screen { PhotoStrip((0..<count).map(Shot.init), label: { "Photo \($0.id)" }, open: { _ in }) { DrawnPhoto(n: $0.id) } }
        }
    }
    Specimen("A picture still drawing: its glyph") {
        Screen { PhotoStrip((0..<2).map(Shot.init), label: { "Photo \($0.id)" }, open: { _ in }) { _ in Color.clear } }
    }
    Specimen("Reading") {
        Screen { PhotoStrip((0..<4).map(Shot.init), label: { "Photo \($0.id)" }, open: { _ in }) { DrawnPhoto(n: $0.id) } }
            .reading(true).environment(\.skeletonForced, 0.3)
    }
}

@MainActor let dayRowSheet = Sheet("day-row", ios: phone, platforms: [.ios]) {
    Specimen("Every kind") {
        Screen {
            VStack(spacing: 0) {
                DayRow(.item(icon: .message, name: "Person A", words: [.quote("Good morning"), .quote("See you at eight then")],
                             count: .runs([.sent(2), .call("5m")])), time: "08:49", action: {})
                DayRow(.item(icon: .call, name: "Person B", words: [.text("Called you")], count: .runs([.call("5m")])), time: "09:09", action: {})
                DayRow(.item(icon: .workMac, name: "Mac", words: [.items(["Browser 16m", "Lifestream 11m", "Chat 1m"]),
                                                              .quiet("Release notes on Example")],
                             count: .text("29m")), time: "09:05", action: {})
                DayRow(.item(icon: .codingAgent, name: "Claude Code", detail: "notes", words: [.quote("what is using the cpu on this laptop")],
                             count: .text("2 prompts")), time: "11:02", action: {})
                DayRow(.item(icon: .ai, name: "Claude", detail: "Planning the week",
                             words: [.quote("help me plan the next three days around the two calls")], count: .text("6 prompts")),
                       time: "11:30", action: {})
                DayRow(.item(icon: .search, name: "Searched", words: [.quote("ferry times"), .quote("tide tables"), .quote("rain")],
                             count: .text("3 searches")), time: "12:10", action: {})
                DayRow(.item(icon: .listening, name: "Music", words: [.items(["Artist A", "Artist B", "Artist C", "Artist D"])],
                             count: .text("10 tracks")), time: "09:43", action: {})
                DayRow(.item(icon: .workout, name: "Workout", words: [.text("strain 15.1 \u{00B7} WHOOP")], count: .text("45m")),
                       time: "09:59", action: {})
                DayRow(.item(icon: .sleep, name: "Woke", words: [.text("asleep 00:47–08:37 \u{00B7} WHOOP")], count: .text("7h 50m")),
                       time: "08:37", action: {})
                DayRow(.item(icon: .photos, name: "Photos", words: [.tiles((1...4).map(tile), more: 3), .text("at Corner Gym")],
                             count: .text("7 photos")), time: "10:44", action: {})
                DayRow(.item(icon: .mail, name: "Mail", words: [.text("Sent"), .quote("Fwd: the plan for the weekend and the tickets")]),
                       time: "20:19", action: {})
                DayRow(.item(icon: .mail, name: "6 mails", words: [.items(["Northwind Bank", "Example Alerts", "Person C"])]),
                       time: "07:00", action: {})
                DayRow(.item(icon: .calendarEvent, name: "Design review", words: [.text("Calendar \u{00B7} accepted"), .quiet("11:00 in City A")],
                             count: .text("50m")), time: "13:30", action: {})
                DayRow(.item(icon: .note, name: "Note", words: [.quote("buy more film")]), time: "16:02", action: {})
                DayRow(.item(icon: .pause, name: "Nothing recorded", count: .text("1h 12m"), quiet: true), time: "13:50", action: {})
                DayRow(.item(icon: .meeting, name: "Group Delta", count: .runs([.received(14)]), quiet: true), time: nil, action: {})
            }
        }
    }
    Specimen("A quote too long cut at a word inside its mark; a second that does not fit left out") {
        Screen {
            VStack(spacing: 0) {
                DayRow(.item(icon: .voiceNote, name: "Dictated", words: [.quote("There was also a bug where the home would go down for a few seconds whenever the page loaded")],
                             count: .text("1 dictation")), time: "12:52", action: {})
                DayRow(.item(icon: .message, name: "Group Alpha", words: [.quote("In for the weekend"), .quote("Not sure if all three days work for everyone")],
                             count: .runs([.sent(2)])), time: "14:06", action: {})
            }
        }
    }
    Specimen("Selected (its moment open) · pressed") {
        Screen {
            VStack(spacing: 0) {
                DayRow(.item(icon: .message, name: "Person A", words: [.quote("Ok")], count: .runs([.sent(1)])), time: "14:06", selected: true, action: {})
                set(DayRow(.item(icon: .message, name: "Person B", words: [.quote("Later")], count: .runs([.sent(1)])), time: "14:07", action: {}), \.forced, .pressed)
            }
        }
    }
    Specimen("Accessibility size (AX3): the time above the name") {
        Screen(typeSize: .accessibility3) {
            DayRow(.item(icon: .message, name: "Person A", words: [.quote("Good morning")], count: .runs([.sent(2)])), time: "08:49", action: {})
        }
    }
    Specimen("Reading") {
        Screen {
            VStack(spacing: 0) {
                DayRow(.item(icon: .message, name: "Person A", words: [.quote("Good morning to you")], count: .runs([.sent(2)])), time: "08:49")
                DayRow(.item(icon: .workMac, name: "Mac", words: [.items(["Browser 16m", "Lifestream 11m"])], count: .text("29m")), time: "09:05")
            }
        }
        .reading(true).environment(\.skeletonForced, 0.3)
    }
}

@MainActor let dayLinesSheet = Sheet("day-lines", ios: phone, platforms: [.ios]) {
    Specimen("An hour folded · open · chats that wrote") {
        Screen {
            VStack(spacing: 0) {
                DayRow(.hour(names: "Person A, Group Alpha, Person B and 6 others", count: .runs([.sent(14)]), open: false), time: "09:00", action: {})
                DayRow(.hour(names: "Person C, Mac 52m, Ask and 1 other", count: .runs([.sent(3)]), open: true), time: "10:00", action: {})
                DayRow(.hour(names: "6 chats wrote to you", open: false), time: "11:00", action: {})
            }
        }
    }
    Specimen("Moves: plain, with what the record adds, with names (folded, open)") {
        Screen {
            VStack(spacing: 0) {
                DayRow(.move(icon: .drive, words: "Drive 1.8 km", length: "5m"), time: "09:33")
                DayRow(.move(icon: .walk, words: "Walk 1.2 km", more: "stopped 6m at Harbour Fuel", length: "21m"), time: "12:04")
                DayRow(.move(icon: .move, words: "Flight 13,512 km", length: "16h 20m"), time: "04:00")
                DayRow(.move(icon: .run, words: "Run 5.1 km", names: "Music, Person A", length: "31m", open: false), time: "07:10", action: {})
                DayRow(.move(icon: .run, words: "Run 5.1 km", names: "Music, Person A", length: "31m", open: true), time: "07:10", action: {})
            }
        }
    }
    Specimen("Now, updated 15:42 · nothing known yet; then plans and the day's end") {
        Screen {
            VStack(spacing: 0) {
                DayRow(.now(updated: "15:42"), time: "15:45",
                       rail: DayRail(above: .life, below: .plan))
                DayRow(.plan(title: "Gym", facts: "in 2h 45m \u{00B7} Calendar \u{00B7} accepted", length: "1h"), time: "18:30",
                       rail: .through(.plan), action: {})
                DayRow(.plan(title: "Dinner with Person A", facts: "in 4h 15m \u{00B7} Calendar \u{00B7} accepted \u{00B7} 11:00 in City A",
                             length: "2h"), time: "20:00", rail: DayRail(above: .plan, below: .none), action: {})
                air(12, .none)
                DayRow(.now(updated: nil), time: "15:45", rail: .ends)
            }
        }
    }
    Specimen("All day, before the first head") {
        Screen { DayRow(.allDay(title: "Visit: City A", facts: "Calendar \u{00B7} all day, 2 to 5 May"), time: nil, rail: .none, action: {}) }
    }
    Specimen("Midnight between two rows · the day's end") {
        Screen {
            VStack(spacing: 0) {
                DayRow(.item(icon: .message, name: "Person A", words: [.quote("Night")], count: .runs([.sent(1)])), time: "23:58", action: {})
                DayRow(.divider(date: "Saturday 24 October"), time: "00:00")
                DayRow(.item(icon: .message, name: "Person A", words: [.quote("Still up?")], count: .runs([.sent(1)])), time: "00:12", rail: .ends, action: {})
                DayRow(.dayEnd(next: "Saturday 24 October"), time: "04:00", rail: .none)
            }
        }
    }
}

@MainActor let figureRowSheet = Sheet("figure-row", ios: phone, platforms: [.ios]) {
    Specimen("Three") { Screen { FigureRow([.init("7h 21m", "asleep"), .init("1,754", "steps so far"), .init("63", "recovery")]) } }
    Specimen("Two: no night recorded, the others close up") { Screen { FigureRow([.init("4,612", "steps"), .init("312", "sent")]) } }
    Specimen("One") { Screen { FigureRow([.init("1,955", "sent")]) } }
    Specimen("A stated zero is drawn") { Screen { FigureRow([.init("0", "steps"), .init("3,723", "to you")]) } }
    Specimen("Accessibility size (AX3): one under another") {
        Screen(typeSize: .accessibility3) { FigureRow([.init("7h 21m", "asleep"), .init("1,754", "steps so far")]) }
    }
    Specimen("Reading") {
        Screen { FigureRow([.init("7h 21m", "asleep"), .init("1,754", "steps"), .init("63", "recovery")]) }
            .reading(true).environment(\.skeletonForced, 0.3)
    }
}

private let harbour = CLLocationCoordinate2D(latitude: 47.6062, longitude: -122.3321)
private let gym = CLLocationCoordinate2D(latitude: 47.6135, longitude: -122.3205)
private let studio = CLLocationCoordinate2D(latitude: 47.6010, longitude: -122.3150)
private let cafe = CLLocationCoordinate2D(latitude: 47.6100, longitude: -122.3290)
private let far = CLLocationCoordinate2D(latitude: 37.7749, longitude: -122.4194)

@MainActor let dayMapCardSheet = Sheet("day-map-card", ios: phone, platforms: [.ios]) {
    Specimen("While the where answer has not come") {
        Screen { DayMapCard(stays: nil, open: { _ in }) }
    }
    Specimen("A day of one place: its circle at three times its reach") {
        Screen { set(DayMapCard(stays: [.init(id: "h", name: "Harbour Home", point: harbour, minutes: 1_440, time: "24h", reach: 80)], open: { _ in }), \.drawn, true) }
    }
    Specimen("Where the time went: each place a disc by its minutes, its name and time beside it") {
        Screen {
            set(DayMapCard(stays: [.init(id: "h", name: "Harbour Home", point: harbour, minutes: 621, time: "10h 21m"),
                                   .init(id: "g", name: "Corner Gym", point: gym, minutes: 73, time: "1h 13m"),
                                   .init(id: "s", name: "Northside Studio", point: studio, minutes: 252, time: "4h 12m"),
                                   .init(id: "c", name: "Juniper Kitchen", point: CLLocationCoordinate2D(latitude: 47.6066, longitude: -122.3305),
                                         minutes: 40, time: "40m")],
                           open: { _ in }), \.drawn, true)
        }
    }
    Specimen("A travel day: its destination a disc like any") {
        Screen {
            set(DayMapCard(stays: [.init(id: "h", name: "Harbour Home", point: harbour, minutes: 300, time: "5h"),
                                   .init(id: "c", name: "Cafe Rosa", point: cafe, minutes: 30, time: "30m"),
                                   .init(id: "f", name: "Bay Hotel", point: far, minutes: 600, time: "10h")],
                           open: { _ in }), \.drawn, true)
        }
    }
}

@MainActor let placeUnitSheet = Sheet("place-unit", ios: phone, platforms: [.ios]) {
    Specimen("Places, by minutes") {
        Screen {
            VStack(spacing: 0) {
                SectionLabel("Places \u{00B7} 5").padding(.horizontal, Cockpit.Space.s4).frame(height: 28)
                PlaceUnit("Harbour Home", minutes: "10h 21m", line: "your home", action: {})
                PlaceUnit("Corner Gym", minutes: "1h 13m", line: "15 of the last 35 days", action: {})
                PlaceUnit("Northside Studio", minutes: "52m", line: .coming, action: {})
                PlaceUnit("Near Harbour Home", minutes: "1h 9m", line: "1.8 km away", quiet: true, action: {})
                PlaceUnit("Juniper Kitchen", minutes: "40 m", action: {})
            }
        }
        .environment(\.skeletonForced, 0.3)
    }
    Specimen("A long name cut · pressed") {
        Screen {
            VStack(spacing: 0) {
                PlaceUnit("Harbour Point Light Station State Historic Park", minutes: "2h 5m", line: "first day here", action: {})
                set(PlaceUnit("Corner Gym", minutes: "1h 13m", line: "15 of the last 35 days", action: {}), \.forced, .pressed)
            }
        }
    }
}

@MainActor let personRowSheet = Sheet("person-row", ios: phone, platforms: [.ios]) {
    Specimen("People, most contact first") {
        Screen {
            VStack(spacing: 0) {
                SectionLabel("People \u{00B7} 6").padding(.horizontal, Cockpit.Space.s4).frame(height: 28)
                PersonRow("Person E", runs: [.sent(10)], action: {})
                PersonRow("Garage North", runs: [.sent(2), .calls(2)], action: {})
                PersonRow("Person A", photo: StandInPhoto.image(0).map { Image(decorative: $0, scale: 1) }, runs: [.sent(1), .call("5m")], action: {})
                PersonRow("Person B", runs: [.call("5m")], action: {})
                PersonRow("Garage South", runs: [.missed(1)], action: {})
                PersonRow("Group Delta", runs: [.received(14)], action: {})
            }
        }
    }
    Specimen("A long name cut · pressed") {
        Screen {
            VStack(spacing: 0) {
                PersonRow("Northside Community Studio Members and Friends", runs: [.sent(1_204), .calls(12), .missed(3)], action: {})
                set(PersonRow("Person E", runs: [.sent(10)], action: {}), \.forced, .pressed)
            }
        }
    }
}
#endif
