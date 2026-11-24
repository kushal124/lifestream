#if os(macOS)
import SwiftUI
@testable import Cockpit


@MainActor let groupSheet = Sheet("group") {
    Specimen("Two groups, each under its label") {
        VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
            Card("Conversations", group: true) {
                ListRow("iMessage", meta: "29 messages today", mono: true, leading: .symbol(.message), action: {})
                ListRow("WhatsApp", meta: "Last yesterday", mono: true, leading: .symbol(.message), separator: false, action: {})
            }
            Card("Body", group: true) {
                ListRow("Health", meta: "Nothing yet", mono: true, leading: .symbol(.health), separator: false, action: {})
            }
        }
    }
    Specimen("Pressed, and the row whose sheet is open") {
        Card("Devices", group: true) {
            pressedRow
            ListRow("Chrome", meta: "Last 09:12", mono: true, leading: .symbol(.web), selected: true, separator: false, action: {})
        }
    }
}

@MainActor private var pressedRow: some View {
    var row = ListRow("This iPhone", meta: "Recording", signal: .engaged, leading: .symbol(.phoneScreen), action: {})
    row.forced = .pressed
    return row
}

@MainActor let viewsSheet = Sheet("views", hosted: true) {
    Specimen("Connected chosen") {
        Views("Connectors", options: [.init("Connected", id: 0, count: 24), .init("Add more", id: 1, count: 9)], selection: .constant(0))
    }
    Specimen("Add more chosen") {
        Views("Connectors", options: [.init("Connected", id: 0, count: 24), .init("Add more", id: 1, count: 9)], selection: .constant(1))
    }
    Specimen("Three, the third while chosen; a view with no count") {
        Views("People", options: [.init("People", id: 0, count: 1_204), .init("Groups", id: 1), .init("No name yet", id: 2, count: 624)],
              selection: .constant(2))
    }
    Specimen("Places pressed (iPhone) or hovered (Mac)") {
        var views = Views("Places", options: [.init("Places", id: 0, count: 86), .init("Trips", id: 1, count: 12)], selection: .constant(1))
        views.forced = 0
        return views
    }
}

@MainActor let tabsSheet = Sheet("tabs", hosted: true) {
    Specimen("Overview shown, LLM processing needs you") {
        Tabs("WhatsApp", options: streamTabs(needs: true), selection: .constant(0))
    }
    Specimen("LLM processing shown") {
        Tabs("WhatsApp", options: streamTabs(needs: true), selection: .constant(2))
    }
    Specimen("Three, Settings shown") {
        Tabs("GitHub", options: Array(streamTabs(needs: false).prefix(3)), selection: .constant(1))
    }
    Specimen("Settings pressed (iPhone) or hovered (Mac)") {
        var tabs = Tabs("Photos", options: streamTabs(needs: false), selection: .constant(0))
        tabs.forced = 1
        return tabs
    }
    Specimen("Wider than the sheet, Backfill shown") {
        Tabs("WhatsApp", options: streamTabs(needs: true), selection: .constant(3))
            .frame(width: 240, alignment: .leading)
            .padding(.horizontal, Cockpit.Space.s3)
            .clipped()
            .padding(.horizontal, -Cockpit.Space.s3)
    }
}

@MainActor private func streamTabs(needs: Bool) -> [TabOption<Int>] {
    [.init("Overview", id: 0), .init("Settings", id: 1), .init("LLM processing", id: 2, needs: needs), .init("Backfill", id: 3)]
}

@MainActor let barTitleSheet = Sheet("bar-title", hosted: true) {
    ForEach(barTitleFrames, id: \.label) { frame in
        Specimen("Tab page · \(frame.label)") {
            BarFrame(title: "People", bar: frame.bar) {
                VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                    Text("People").cockpit(.display).foregroundStyle(Cockpit.Color.text).fadesIntoBar()
                    SearchField(text: .constant(""), placeholder: "Search people")
                }
                Views("People", options: [.init("People", id: 0, count: 214), .init("Groups", id: 1, count: 18)],
                      selection: .constant(0))
            }
            .environment(\.barFadeForced, frame.head)
        }
    }
    ForEach(barTitleFrames, id: \.label) { frame in
        Specimen("Page of one thing · \(frame.label)") {
            BarFrame(title: "Person A", bar: frame.bar) {
                HStack(spacing: Cockpit.Space.s4) {
                    PersonFace("Person A", size: .head)
                    VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                        Text("Person A").cockpit(.title1).foregroundStyle(Cockpit.Color.text).fadesIntoBar()
                        PartLine(["WhatsApp and iMessage", "Since Mar 2025"])
                    }
                }
            }
            .environment(\.barFadeForced, frame.head)
        }
    }
}

private let barTitleFrames: [(label: String, head: Double, bar: Double)] = [
    ("At rest", 1, 0),
    ("The bar's title at half", 0.2, BarFade.bar(0.2)),
    ("Gone, the bar's title whole", 0, 1),
]

private struct BarFrame<Head: View>: View {
    let title: String
    let bar: Double
    @ViewBuilder let head: Head

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s4) {
            ZStack {
                BarTitleLabel(title: title, strength: nil, forced: bar)
                IconButton(.back, label: "Back", style: .glass) {}
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: 44)
            VStack(alignment: .leading, spacing: Cockpit.Space.s6) { head }
        }
        .padding(Cockpit.Space.s4)
        .groundColor(Cockpit.Color.canvas)
        .overlay {
            RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous)
                .strokeBorder(Cockpit.Color.hairline, lineWidth: Cockpit.Stroke.border)
        }
    }
}

private let weekdays = ["Thu 8 Oct", "Fri 9 Oct", "Sat 10 Oct", "Sun 11 Oct", "Mon 12 Oct", "Tue 13 Oct", "Wed 14 Oct"]

private func week(_ counts: [Int]) -> [WeekFigure.Bar] {
    counts.indices.map { WeekFigure.Bar(count: counts[$0], noun: counts[$0] == 1 ? "message" : "messages", when: weekdays[$0]) }
}

private let personWeeks: [WeekFigure.Bar] = (0..<104).map { week in
    let count = week < 30 ? (week % 9 == 0 ? 6 : 0) : 40 + (week * 53) % 280
    return WeekFigure.Bar(count: count, when: "week \(week + 1)")
}

@MainActor private func read(_ figure: WeekFigure, _ bar: Int) -> WeekFigure {
    var figure = figure
    figure.lit = bar
    return figure
}

@MainActor let weekFigureSheet = Sheet("week-figure") {
    let seven = WeekFigure("29", words: "messages today", line: "Last sent 22:50", bars: week([40, 52, 47, 0, 61, 44, 29]))
    Specimen("Seven days at rest: today in here, an empty Sunday") { seven }
    Specimen("Monday read (the finger on it)") { read(seven, 4) }
    Specimen("A week of zeros: a baseline") {
        WeekFigure("0", words: "messages today", line: "Last sent Thu", bars: week(Array(repeating: 0, count: 7)))
    }
    Specimen("A catch-up day: full height, the rest keep their scale; read, its real count") {
        read(WeekFigure("50", words: "messages today", bars: week([40, 52, 3_900, 0, 61, 44, 50])), 2)
    }
    Specimen("The week still counted by the home: the amount and its words skeletons, a low column a day, the line words") {
        WeekFigure("00", words: "messages today", line: "Last sent 22:50", bars: week(Array(repeating: 0, count: 7)))
            .reading(true)
            .environment(\.skeletonForced, 0.5)
    }
    Specimen("No week from the home: the figure alone") {
        WeekFigure("14", words: "events today", line: "Last sent 14:02", bars: [])
    }
    Specimen("104 weeks of a person, this week in here") {
        WeekFigure("1,494", words: "messages in the last 30 days", bars: personWeeks, ends: ("2 years ago", "This week"))
    }
    Specimen("A quiet person's years, the busiest in here, the present in the foot") {
        WeekFigure("18,082", words: "messages since Jun 2020",
                   bars: [3_100, 6_400, 4_200, 2_300, 1_200, 640, 240].enumerated().map { WeekFigure.Bar(count: $1, when: String(2020 + $0)) },
                   labels: (2020...2026).map(String.init), marked: .busiest([3_100, 6_400, 4_200, 2_300, 1_200, 640, 240]),
                   foot: "2 in the last 30 days · before that, 6 Aug")
    }
    Specimen("104 weeks, a week read that opens its busiest day") {
        read(WeekFigure("1,494", words: "messages in the last 30 days", bars: personWeeks, ends: ("2 years ago", "This week"),
                        open: { _ in }), 70)
    }
}

@MainActor let sheetFrameSheet = Sheet("sheet-frame", ios: 390, mac: 520, hosted: true) {
    Specimen("A stream: who, what it brought, its state, where it comes from; the foot") {
        SheetFrame("iMessage", icon: .message) {
            WeekFigure("29", words: "messages today", line: "Last sent 22:50", bars: week([40, 52, 47, 0, 61, 44, 29]))
            SheetPart("Comes from") {
                SettingRow("This Mac", value: "29 today", separator: false)
            }
        } words: {
            Text("In the Lifestream app on your Mac.")
        } acts: {
            Button("Pause") {}.buttonStyle(.cockpit(.secondary))
        }
        .fixedSize(horizontal: false, vertical: true)
    }
    Specimen("Two accounts read in Chrome: each by its email, the second declined (Off, the home's line under it)") {
        SheetFrame("Claude", icon: .ai) {
            SheetPart("Comes from", note: "Turn them on or off from Lifestream on your Mac.") {
                ListRow("person-a@example.com", meta: "23,532 messages", lines: 2, leading: .symbol(.web)) { EmptyView() }
                ListRow("person-b@example.com", meta: "Off", signal: .idle, detail: "Not read", lines: 2,
                        leading: .symbol(.web), separator: false) { EmptyView() }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
    Specimen("A line under an unclear name; the acts alone") {
        SheetFrame("Pages read", icon: .web, line: "Chrome on the Mac") {
            SheetPart("Needs you") {
                SettingRow("Google asks you to confirm it's you.", separator: false)
            }
        } acts: {
            Button("Not now") {}.buttonStyle(.cockpit(.plain))
            Button("Open") {}.buttonStyle(.cockpit(.primary))
        }
        .fixedSize(horizontal: false, vertical: true)
    }
    OnPhone { Specimen("An edit's head: × to leave at the start, ✓ to keep at the end, dimmed until something changed; saving; not saved") {
        VStack(spacing: Cockpit.Space.s4) {
            Drawer("Rename folder", edit: SheetEdit(opened: "Trips", now: "Wedding") { .close }) {
                Card(group: true) { ListRow("Wedding", separator: false) }
            }
            .fixedSize(horizontal: false, vertical: true)
            Drawer("Rename folder", edit: SheetEdit(opened: "Trips", now: "Trips") { .close }) {
                Card(group: true) { ListRow("Trips", separator: false) }
            }
            .fixedSize(horizontal: false, vertical: true)
            Drawer("Rename folder", edit: SheetEdit(opened: "Trips", now: "Wedding", acts: SheetActs(drawn: .running)) { .close }) {
                Card(group: true) { ListRow("Wedding", separator: false) }
            }
            .fixedSize(horizontal: false, vertical: true)
            Drawer("Rename folder", edit: SheetEdit(opened: "Trips", now: "Wedding", acts: SheetActs(drawn: .failed(.notSent))) { .close }) {
                Card(group: true) { ListRow("Wedding", separator: false) }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    } }
    Specimen("No icon, no foot: a device's sheet whose parts push inside it") {
        SheetFrame("This iPhone") {
            Card(group: true) {
                ListRow("Status", chevron: true, action: {})
                ListRow("About", chevron: true, separator: false, action: {})
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

@MainActor let sheetFootSheet = Sheet("sheet-frame-foot", hosted: true, platforms: [.ios]) {
    Specimen("Over the home indicator: 34 under the buttons, not 16 + 34") {
        SheetFrame("Gmail", icon: .mail, line: "Every email, sent and received") {
            SheetPart("Comes from") {
                SettingRow("person-a@example.com", value: "1,204 today", separator: false)
            }
        } words: {
            Button("Turn off") {}.buttonStyle(.cockpit(.plain, tone: .warning))
        } acts: {
            Button("Pause") {}.buttonStyle(.cockpit(.secondary))
        }
        .safeAreaPadding(.bottom, 34)
        .frame(height: 300)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Cockpit.Color.caution.opacity(0.15)).frame(height: 34).allowsHitTesting(false)
        }
    }
    Specimen("No home indicator: the margin, 16") {
        SheetFrame("Gmail", icon: .mail, line: "Every email, sent and received") {
            SheetPart("Comes from") {
                SettingRow("person-a@example.com", value: "1,204 today", separator: false)
            }
        } words: {
            Button("Turn off") {}.buttonStyle(.cockpit(.plain, tone: .warning))
        } acts: {
            Button("Pause") {}.buttonStyle(.cockpit(.secondary))
        }
        .frame(height: 300)
    }
    Specimen("Closed by its foot: Done the way out, and a swipe down; no close circle in the head") {
        SheetFrame("Model and thinking") {
            SheetPart(nil) {
                SettingRow("Model", value: "GPT-6.1 Terra")
                SettingRow("Thinking", value: "High", separator: false)
            }
            Button("Done") {}.buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
        }
        .drawerClosedByFoot()
        .frame(height: 300)
    }
}

@MainActor let sheetPageSheet = Sheet("sheet-page", ios: 390, mac: 520, hosted: true) {
    Specimen("A pushed page (its title goes in the sheet's bar): a part and its note") {
        NavigationStack {
            SheetPage("Check-ins") {
                SheetPart("Ask", note: "Asked once a night, an hour before bedtime.") {
                    SettingRow("Bedtime", separator: false) {
                        MenuRow("Bedtime", selection: .constant("22:30"), options: [.init("22:30", "22:30")])
                    }
                }
            }
        }
        .frame(height: 220)
    }
}
#endif
