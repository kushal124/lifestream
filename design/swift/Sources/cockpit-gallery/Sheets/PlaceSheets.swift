#if os(macOS)
import SwiftUI
@testable import Cockpit


struct DrawnPhoto: View {
    let n: Int

    var body: some View {
        if let image = StandInPhoto.image(n) {
            Image(decorative: image, scale: 1).resizable().scaledToFill()
        }
    }
}

private struct Shot: Identifiable {
    let id: Int
}

@MainActor let photoGridSheet = Sheet("photo-grid", ios: 390, mac: 520) {
    Specimen("A place's row of its newest twelve, under its label with Show all") {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            SectionLabel("Photos", count: 36, action: "Show all", perform: {})
            PhotoGrid((0..<12).map(Shot.init), label: { "Photo \($0.id)" }, open: { _ in }) { DrawnPhoto(n: $0.id) }
        }
    }
    Specimen("Fewer than a row: they keep their size and stand from the leading edge") {
        PhotoGrid((0..<2).map(Shot.init), label: { "Photo \($0.id)" }, open: { _ in }) { DrawnPhoto(n: $0.id) }
    }
    Specimen("Show all: every photo, three across on iPhone") {
        PhotoGrid((0..<8).map(Shot.init), columns: 3, label: { "Photo \($0.id)" }, open: { _ in }) { DrawnPhoto(n: $0.id) }
    }
    Specimen("Pressed (iPhone) or hovered (Mac); a picture still loading, its glyph") {
        HStack(spacing: Cockpit.Space.s2) {
            Button {} label: { DrawnPhoto(n: 1) }.buttonStyle(PhotoTileStyle(forced: .pressed))
            Button {} label: { DrawnPhoto(n: 2) }.buttonStyle(PhotoTileStyle(forced: .hover))
            Button {} label: { Color.clear }.buttonStyle(PhotoTileStyle())
        }
        .frame(width: 300)
    }
    Specimen("Reading") {
        PhotoGrid((0..<3).map(Shot.init), columns: 3, label: { _ in "Photo" }, open: { _ in }) { DrawnPhoto(n: $0.id) }
            .reading(true)
            .environment(\.skeletonForced, 0.3)
    }
    Specimen("Filled (a naming card): one across the row, two halves, three, four as two and two, five, six") {
        VStack(alignment: .leading, spacing: Cockpit.Space.s4) {
            ForEach([1, 2, 3, 4, 5, 6], id: \.self) { count in
                PhotoGrid((0..<count).map { Shot(id: $0 + count) }, filled: true, label: { "Photo \($0.id)" }, open: { _ in }) {
                    DrawnPhoto(n: $0.id)
                }
            }
        }
    }
}

@MainActor let partLineSheet = Sheet("part-line", ios: 390, mac: 420) {
    Specimen("Under a title: the city, since when, the person there") {
        VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
            Text("Northside Climbing").cockpit(.title1).foregroundStyle(Cockpit.Color.text)
            PartLine([PartLine.Part("Bayview"), PartLine.Part("since Mar 2025"), PartLine.Part("You're here", here: true)])
        }
    }
    Specimen("Narrow: it breaks between whole parts, never inside one") {
        PartLine([PartLine.Part("Bayview"), PartLine.Part("since Mar 2025"), PartLine.Part("You're here", here: true),
                  PartLine.Part("Part of Harbour Market")])
            .frame(width: 230, alignment: .leading)
    }
    Specimen("Reading") {
        PartLine(["Bayview", "since Mar 2025"])
            .reading(true)
            .environment(\.skeletonForced, 0.3)
    }
}

@MainActor let faceStackSheet = Sheet("face-stack", ios: 390, mac: 420) {
    Specimen("One · two · three · more than three · no name yet") {
        HStack(spacing: Cockpit.Space.s6) {
            FaceStack(names: ["Sam Rivera"])
            FaceStack(names: ["Sam Rivera", "Mira Sen"])
            FaceStack(names: ["Sam Rivera", "Mira Sen", "Dana Okafor"])
            FaceStack(names: ["Sam Rivera", "Mira Sen", "Dana Okafor", "Lee Park", "Ana Ruiz"])
            FaceStack(names: [nil, "Mira Sen"])
        }
    }
}

@MainActor let visitRowSheet = Sheet("visit-row", ios: 390, mac: 420) {
    Specimen("A place's visits: day over span, length, faces, one grid") {
        Card("Visits", count: 85, group: true) {
            VisitRow(day: "Today", span: "since 18:05", length: "1h 40m", here: true, faces: true) {}
            VisitRow(day: "Tue 21 Oct", span: "18:12–20:04", length: "1h 52m", people: [.init("Sam Rivera")], faces: true) {}
            VisitRow(day: "Sun 19 Oct", span: "10:30–12:48", length: "2h 18m",
                     people: [.init("Sam Rivera"), .init("Mira Sen")], faces: true) {}
            VisitRow(day: "Sat 11 Oct", span: "09:50–12:30", length: "12h",
                     people: ["Sam Rivera", "Mira Sen", "Dana Okafor", "Lee Park"].map { FaceStack.Face($0) }, faces: true,
                     separator: false) {}
        }
    }
    Specimen("No visit with people: no slot kept") {
        Card("Visit", group: true) {
            VisitRow(day: "Sun 4 Oct", span: "12:41–13:20", length: "39m", faces: false, separator: false) {}
        }
    }
    Specimen("Reading") {
        Card("Visits", group: true) {
            VisitRow(day: "Wed 14 Oct", span: "09:12–17:40", length: "8h 28m", faces: false) {}
            VisitRow(day: "Wed 14 Oct", span: "09:12–17:40", length: "8h 28m", faces: false, separator: false) {}
        }
        .reading(true)
        .environment(\.skeletonForced, 0.3)
    }
}

@MainActor let questionCardSheet = Sheet("question-card", ios: 390, mac: 420) {
    Specimen("On a place's page, under its map") {
        QuestionCard("Is this home?", line: "You've slept here 3 nights, since Monday.", yes: "Yes, it's home") { _ in }
    }
}

private struct DrawnMap<Mark: View>: View {
    let height: CGFloat
    @ViewBuilder let mark: Mark

    var body: some View {
        ZStack {
            MapGround.land
            Path { path in
                path.move(to: CGPoint(x: 0, y: height * 0.7))
                path.addLine(to: CGPoint(x: 420, y: height * 0.55))
                path.move(to: CGPoint(x: 140, y: 0))
                path.addLine(to: CGPoint(x: 170, y: height))
            }
            .stroke(Cockpit.Color.textTertiary.opacity(0.25), lineWidth: 2)
            mark
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
    }
}

private struct OpenSpot: View {
    let reach: CGFloat

    var body: some View {
        ZStack {
            ReachCircle(diameter: reach)
            SpotRing(open: true)
        }
    }
}

private struct SettingCircle: View {
    let radius: Double
    let metresPerPoint: Double
    var lifted = false
    var held = false

    var body: some View {
        var editor = CircleEditor(radius: .constant(radius), limits: 20...2_000, snap: { $0 }, notch: { at, _ in at }, ticks: { _, _ in false },
                                  metresPerPoint: metresPerPoint, lifted: lifted, moved: "Where it was", words: { "\(Int($0)) m" },
                                  nudge: { _ in })
        editor.forcedHeld = held
        return editor
    }
}

@MainActor let circleEditorSheet = Sheet("circle-editor", ios: 390, mac: 420) {
    Specimen("At rest: 80 m, the pin set, the handle on the ring's east; a spot and stays inside lit, others outside, a place overlapped") {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            DrawnMap(height: 260) {
                ZStack {
                    SpotRing(lit: true).offset(x: -30, y: 24)
                    SpotRing().offset(x: 120, y: -70)
                    ForEach(Array([(20, -40), (44, 10), (-12, 50), (-50, -20), (100, 40), (96, 70)].enumerated()), id: \.offset) { _, at in
                        StayDot(lit: hypot(Double(at.0), Double(at.1)) < 78).offset(x: CGFloat(at.0), y: CGFloat(at.1))
                    }
                    ReachCircle(diameter: 120, quiet: true).offset(x: -150, y: -40)
                    PlaceDisc(diameter: MapMarks.diameter(hours: 30), faded: true).offset(x: -150, y: -40)
                    SettingCircle(radius: 80, metresPerPoint: 80 / 78)
                }
            }
            HStack(spacing: Cockpit.Space.s3) {
                Text("Takes in 1 spot · 8 stays · overlaps Ridge Bakery")
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ValueStepper("Reach", value: .constant(80), steps: [75, 80, 85], less: "Smaller", more: "Larger") { "\(Int($0)) m" }
            }
        }
    }
    Specimen("The map moving under it: the pin lifted off its point") {
        DrawnMap(height: 200) { SettingCircle(radius: 80, metresPerPoint: 80 / 60, lifted: true) }
    }
    Specimen("The handle held: the size above it") {
        DrawnMap(height: 200) { SettingCircle(radius: 120, metresPerPoint: 120 / 90, held: true) }
            .environment(\.cockpitSystemGlass, false)
    }
    Specimen("A ring smaller than the pin and the handle: the handle clear of the pin on its leader") {
        DrawnMap(height: 160) { SettingCircle(radius: 20, metresPerPoint: 2) }
    }
}

@MainActor let circleRowSheet = Sheet("circle-row", ios: 390, mac: 420) {
    Specimen("A place of one: its row, \"Circle\", set by its stepper and never removed; Add circle under it") {
        Card("Circles", group: true) {
            CircleRow(number: nil, reach: "90 m", line: "Takes in 120 stays", selected: true, select: {}) { CircleReachStepper(90) }
            AddCircleRow {}
        }
    }
    Specimen("Circles 3: the first selected, set by its stepper; each removable while another remains; Add circle last") {
        Card("Circles", count: 3, group: true) {
            CircleRow(number: 1, reach: "55 m", line: "Takes in 41 stays · overlaps Ridge Bakery", selected: true, select: {}, remove: {}) {
                CircleReachStepper(55)
            }
            CircleRow(number: 2, reach: "30 m", line: "Takes in 6 stays", select: {}, remove: {}) { CircleReachStepper(30) }
            CircleRow(number: 3, reach: "80 m", line: "Takes in no stays", select: {}, remove: {}) { CircleReachStepper(80) }
            AddCircleRow {}
        }
    }
    Specimen("Add circle pressed") {
        Card(group: true) {
            set(AddCircleRow {}, \.forced, .pressed)
        }
    }
    Specimen("Circles 20, the most a place holds: Add circle disabled, saying so") {
        Card("Circles", count: 20, group: true) {
            ForEach(1...20, id: \.self) { number in
                CircleRow(number: number, reach: "30 m", line: number == 20 ? "Takes in 1 spot · 3 stays" : "Takes in 2 stays",
                          selected: number == 20, select: {}, remove: {}) { CircleReachStepper(30) }
            }
            AddCircleRow(full: "20 circles, the most a place holds") {}
        }
    }
    Specimen("Pressed") {
        Card(group: true) {
            set(CircleRow(number: 2, reach: "30 m", line: "Takes in 6 stays", separator: false, select: {}, remove: {}) { CircleReachStepper(30) },
                \.forced, .pressed)
        }
    }
    Specimen("A long line wraps to two") {
        Card(group: true) {
            CircleRow(number: 3, reach: "1.25 km", line: "Takes in 2 spots · 214 stays · overlaps Ridge Bakery and 3 more",
                      separator: false, select: {}, remove: {}) { CircleReachStepper(1_250) }
        }
    }
    OnPhone {
        Specimen("At an accessibility size: the reach under the title, never cut") {
            Card(group: true) {
                CircleRow(number: 2, reach: "30 m", line: "Takes in 6 stays", separator: false, select: {}, remove: {}) { CircleReachStepper(30) }
            }
            .environment(\.dynamicTypeSize, .accessibility3)
        }
    }
}

private struct CircleReachStepper: View {
    let metres: Double
    init(_ metres: Double) { self.metres = metres }
    var body: some View {
        ValueStepper("Reach", value: .constant(metres), steps: [metres - 5, metres, metres + 5], less: "Smaller", more: "Larger") {
            $0 < 1_000 ? "\(Int($0)) m" : "\($0 / 1_000) km"
        }
    }
}

@MainActor let nameRowSheet = Sheet("name-row", ios: 390, mac: 420, hosted: true) {
    Specimen("The field, then a calendar's, a message's, one of your places near it") {
        VStack(spacing: NameRow.gap) {
            NameField("Type a name", text: .constant(""), act: "Save") {}
            NameRow("Lantern Noodle Bar", source: "Calendar · 12:30", icon: .calendarEvent) {}
            NameRow("Bayview Ramen", source: "WhatsApp · 11:40", icon: .message) {}
            NameRow("Kiln Coffee", source: "Your place · 140 m", icon: .place) {}
        }
    }
    Specimen("Typed: every match under the field, Google's among them, each saying so") {
        VStack(alignment: .leading, spacing: NameRow.gap) {
            NameField("Type a name", text: .constant("Kiln"), act: "Save") {}
            NameRow("Kiln Coffee", source: "Your place · 12 km", icon: .place) {}
            NameRow("Kiln Bakery", source: "90 m away · Google", icon: .place) {}
            NameRow("Kiln Studio", source: "Google", icon: .place) {}
        }
    }
    Specimen("The lit row, the one Return takes before anything is typed (the Mac's)") {
        VStack(spacing: NameRow.gap) {
            NameRow("Lantern Noodle Bar", source: "Calendar · 12:30", icon: .calendarEvent, lit: true) {}
            NameRow("Bayview Ramen", source: "WhatsApp · 11:40", icon: .message) {}
        }
    }
    Specimen("Pressed (iPhone) or hovered (Mac)") {
        VStack(spacing: NameRow.gap) {
            forcedNameRow(.pressed)
            forcedNameRow(.hover)
        }
    }
    Specimen("A name too long for its line ends in an ellipsis") {
        NameRow("The Northern Reach Community Library and Reading Rooms", source: "Google · Fri 18:02", icon: .place) {}
    }
    Specimen("Reading") {
        VStack(spacing: NameRow.gap) {
            NameRow("Lantern Noodle Bar", source: "Calendar · 12:30", icon: .calendarEvent) {}
            NameRow("Bayview Ramen", source: "WhatsApp · 11:40", icon: .message) {}
        }
        .reading(true)
        .environment(\.skeletonForced, 0.3)
    }
}

@MainActor private func forcedNameRow(_ state: RowHighlight) -> some View {
    var row = NameRow("Bayview Ramen", source: "WhatsApp · 11:40", icon: .message) {}
    row.forced = state
    return row
}

@MainActor let nameFieldSheet = Sheet("name-field", ios: 390, mac: 420, hosted: true) {
    Specimen("Empty: the glass and the placeholder") {
        NameField("Type a name", text: .constant(""), act: "Save") {}
    }
    Specimen("Typed: the act at its end") {
        NameField("Somewhere else", text: .constant("Lantern"), act: "Mark") {}
    }
}

@MainActor let namingCardSheet = Sheet("naming-card", ios: 390, mac: 420, hosted: true) {
    Specimen("The third of twelve: its photos filling their rows, what witnessed it, the field, three names") {
        NamingCard(position: 3, of: 12, close: {}) {
            NamingPage(witnessed: "You took 214 photos here on 16 days between 2019 and 2026.",
                       last: "Last time Tue 20 Oct 2026 from 14:10 to 15:30", more: 14,
                       takes: "Takes in 1 spot · 21 stays", skip: {}, hide: {}) {
                DrawnMap(height: NamingPage<EmptyView, EmptyView, EmptyView, EmptyView>.mapHeight) {
                    SettingCircle(radius: 80, metresPerPoint: 80 / 78)
                }
            } reach: {
                ValueStepper("Reach", value: .constant(80), steps: [75, 80, 85], less: "Smaller", more: "Larger") { "\(Int($0)) m" }
            } photos: {
                PhotoGrid((1..<7).map(Shot.init), filled: true, label: { "Photo \($0.id)" }, open: { _ in }) { DrawnPhoto(n: $0.id) }
            } names: {
                VStack(spacing: NameRow.gap) {
                    NameField("Type a name", text: .constant(""), act: "Save") {}
                    NameRow("Lantern Noodle Bar", source: "Calendar · 12:30", icon: .calendarEvent) {}
                    NameRow("Harbour Home", source: "Your place · 160 m", icon: .place) {}
                    NameRow("Bayview Ramen", source: "WhatsApp · 11:40", icon: .message) {}
                }
            }
        }
        .frame(height: 1_150)
    }
    Specimen("The last of twelve: one photo, typed, Google's names and credit, the undo of the card before, no key") {
        NamingCard(position: 12, of: 12, close: {}) {
            NamingPage(witnessed: "You took a photo here on Tue 20 Oct 2026 at 14:10.", takes: "Takes in 1 spot · 1 stay", skip: {}, hide: {},
                       note: "Names from Google Places come once Lifestream holds a key",
                       added: .init("Added to Harbour Home", undo: {})) {
                DrawnMap(height: NamingPage<EmptyView, EmptyView, EmptyView, EmptyView>.mapHeight) {
                    SettingCircle(radius: 150, metresPerPoint: 150 / 78)
                }
            } reach: {
                ValueStepper("Reach", value: .constant(150), steps: [140, 150, 160], less: "Smaller", more: "Larger") { "\(Int($0)) m" }
            } photos: {
                PhotoGrid([Shot(id: 1)], filled: true, label: { "Photo \($0.id)" }, open: { _ in }) { DrawnPhoto(n: $0.id) }
            } names: {
                VStack(alignment: .leading, spacing: NameRow.gap) {
                    NameField("Type a name", text: .constant("Pier"), act: "Save") {}
                    NameRow("Pier Six", source: "30 m away · Google", icon: .place) {}
                    NameRow("Pier Steps", source: "70 m away · Google", icon: .place) {}
                }
            }
        }
        .frame(height: 900)
    }
}

@MainActor let namingFinishSheet = Sheet("naming-finish", ios: 390, mac: 420, hosted: true) {
    Specimen("Twelve places named") {
        NamingFinish(count: 12, line: "In 2 minutes · Bayview and Lakeshore", named: [
            NamedPlace(id: "a", name: "Lantern Noodle Bar", day: "Sat 22 Aug"),
            NamedPlace(id: "b", name: "Ridge Bakery", day: "6 Jul"),
            NamedPlace(id: "c", name: "Pier Six", day: "3 Aug"),
        ], done: {}) {
            DrawnMap(height: 340) {
                HStack(spacing: 60) {
                    PlaceDisc(diameter: 12, lit: true)
                    PlaceDisc(diameter: 20)
                    PlaceDisc(diameter: 10, lit: true)
                }
            }
        }
        .frame(height: 844)
    }
    Specimen("One place named, its spot added to a place of yours: Undo over Done") {
        NamingFinish(count: 1, line: "In under a minute · Bayview", named: [NamedPlace(id: "a", name: "Pier Six", day: "3 Aug")],
                     added: NamingAdded("Added to Pier Six") {}, done: {}) {
            DrawnMap(height: 340) { PlaceDisc(diameter: 12, lit: true) }
        }
        .frame(height: 844)
    }
}

@MainActor let hiddenSpotCardSheet = Sheet("hidden-spot-card", ios: 390, mac: 420) {
    Specimen("On 4 days, near a place") {
        HiddenSpotCard(id: "a", known: "On 4 days · 250 m from Home", hidden: "Hidden 13 Oct", unhide: {}) {
            DrawnMap(height: HiddenSpotCard<EmptyView>.mapHeight) { OpenSpot(reach: 48) }
        }
    }
    Specimen("Known by its day alone") {
        HiddenSpotCard(id: "b", known: "One day", hidden: "Hidden 2 Sep", unhide: {}) {
            DrawnMap(height: HiddenSpotCard<EmptyView>.mapHeight) { OpenSpot(reach: 48) }
        }
    }
}
#endif
