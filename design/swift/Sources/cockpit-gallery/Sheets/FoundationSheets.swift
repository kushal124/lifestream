#if os(macOS)
import SwiftUI
@testable import Cockpit

@MainActor let cardSheet = Sheet("card") {
    Specimen("Default, header with action") {
        Card("Lifestream", action: "Open") {
            Text("Lifestream is on this Mac.").cockpit(.body).foregroundStyle(Cockpit.Color.text)
            Text("212 days of space left").cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary)
        }
    }
    Specimen("Flush, rows to the edges") {
        Card("People", flush: true) {
            ListRow("Mira Sen", meta: "WhatsApp, calls · 2 h ago", leading: .monogram("Mira Sen"), value: "84", action: {})
            ListRow("Person A", meta: "Messages · yesterday", leading: .monogram("Person A"), value: "12", selected: true, action: {})
            ListRow("+1 555 0000 001", meta: "Calls · 3 days ago", leading: .monogram("+1 555 0000 001"), value: "1", separator: false, action: {})
        }
    }
    Specimen("No header") {
        Card {
            Text("A card with only a sentence in it, long enough to wrap across two lines on the narrow phone.").cockpit(.body).foregroundStyle(Cockpit.Color.text)
        }
    }
}

@MainActor let sectionLabelSheet = Sheet("section-label") {
    Specimen("Alone") { SectionLabel("The day so far") }
    Specimen("With an action") { SectionLabel("Recent", action: "See all", perform: {}) }
    Specimen("Long") { SectionLabel("Every place you stayed this year, newest first", action: "Map", perform: {}) }
    Specimen("Opens what it names, its count beside it") { SectionLabel("Bayview", count: 18, open: {}) }
    Specimen("Opening, pressed (iPhone) or hovered (Mac)") {
        var label = SectionLabel("Bayview", count: 18, open: {})
        label.forced = true
        return label
    }
}

@MainActor let listRowSheet = Sheet("list-row") {
    Specimen("Leading and trailing") {
        Card(flush: true) {
            ListRow("Corner Gym", meta: "18 visits · 42h", leading: .icon(.place), when: "3 days ago", chevron: true, action: {})
            ListRow("Mira Sen", meta: "WhatsApp, calls · 2 h ago", leading: .monogram("Mira Sen"), value: "84")
            ListRow("Voice note", meta: "14:05 · 52s", voice: "idea for the onboarding, two screens not four", leading: .icon(.voiceNote))
            ListRow("Plain title only")
            ListRow("Northside Climbing", here: true, meta: "1h 40m today", mono: true, action: {})
            ListRow("Screen", meta: "Recording", leading: .icon(.screen), separator: false) {
                Signal(.engaged, "On")
            }
        }
    }
    Specimen("A page's rows: symbol, glyphs, a mono line, a state in place of the line, recording") {
        Card(group: true) {
            ListRow("iMessage", meta: "29 messages today", mono: true, area: "Conversations", leading: .symbol(.message), action: {})
            ListRow("Gmail", glyphs: [.init(.online, "Online")], meta: "Thursday", mono: true, leading: .symbol(.mail), action: {})
            ListRow("Pages read", glyphs: [.init(.web, "Chrome")], meta: "Needs you", signal: .caution, leading: .symbol(.web), action: {})
            ListRow("Calendar", glyphs: [.init(.workMac, "This Mac")], meta: "Paused", signal: .idle, leading: .symbol(.calendarEvent), action: {})
            ListRow("Location", meta: "212 places today", mono: true, recording: true, leading: .symbol(.location), selected: true,
                    separator: false, action: {})
        }
    }
    Specimen("A stopped stream's act at its trailing edge: offered, then busy while it runs") {
        Card(group: true) {
            ListRow("Gmail", glyphs: [.init(.online, "Online")], meta: "Stopped", signal: .warning, leading: .symbol(.mail),
                    control: .act("Try now", busy: false, perform: {}), action: {})
            ListRow("Claude", glyphs: [.init(.web, "Chrome")], meta: "Stopped", signal: .warning, leading: .symbol(.ai),
                    separator: false, control: .act("Syncing…", busy: true, perform: {}), action: {})
                .environment(\.skeletonForced, 0.3)
        }
    }
    Specimen("Faces: a person's photo, a person, no name yet, a group") {
        Card(group: true) {
            ListRow("Sam Rivera", meta: "12 messages today", mono: true, leading: .monogram("Sam Rivera", photo: drawnFace(0)), action: {})
            ListRow("Mira Sen", meta: "140 messages today", mono: true, leading: .monogram("Mira Sen"), action: {})
            ListRow("+1 555 0000 001", meta: "Last yesterday", mono: true, leading: .monogram(nil), action: {})
            ListRow("Book club", meta: "Last 09:12", mono: true, leading: .symbol(.meeting), separator: false, action: {})
        }
    }
    Specimen("A state's word beside the line, the counts on one edge") {
        Card(group: true) {
            ListRow("Book club", meta: "Last 09:12", leading: .symbol(.meeting), value: "84", chevron: true, action: {})
            ListRow("Old flatmates", meta: "Last 3 Jun", tag: "Quiet", leading: .symbol(.meeting), value: "12", chevron: true,
                    separator: false, action: {})
        }
    }
    Specimen("Add more: a tile, its name and what connecting it takes, the + (and none for a home connector)") {
        Card(group: true) {
            ListRow("Location", meta: "Allow Location", leading: .icon(.location), control: .add("Add Location", perform: {}), action: {})
            ListRow("Health", meta: "Allow Health", leading: .icon(.health), control: .add("Add Health", perform: {}), action: {})
            ListRow("WhatsApp", meta: "Connect on your Mac", leading: .icon(.message), separator: false, action: {})
        }
    }
    Specimen("States: default, hover, pressed, selected, disabled") {
        Card(flush: true) {
            ListRow("Default", meta: "Meta line", leading: .icon(.home), chevron: true, action: {})
            hovered
            pressed
            ListRow("Selected", meta: "Meta line", leading: .icon(.home), chevron: true, selected: true, action: {})
            ListRow("Disabled", meta: "Meta line", leading: .icon(.home), chevron: true, separator: false, action: {}).disabled(true)
        }
    }
    Specimen("An act, offered, and disabled while there is nothing to do: its ink dims as any row's") {
        Card(group: true) {
            ListRow("Build an export", action: {}).environment(\.cockpitRowActs, true)
            ListRow("Reset to default", separator: false, action: {}).environment(\.cockpitRowActs, true).disabled(true)
        }
    }
    Specimen("Long text truncates; a short value leaves the title the room") {
        Card(flush: true) {
            ListRow("Northside Studio and Rehabilitation Centre, Bay 2, upstairs past the café", meta: "18 visits · 42h",
                    leading: .icon(.place), value: "3", chevron: true, action: {})
            ListRow("Northside Studio and Rehabilitation Centre, Bay 2, upstairs past the café", meta: "Unnamed spot near Home · 7 stays on 3 days · first seen in March",
                    leading: .icon(.place), value: "1,204", chevron: true, separator: false, action: {})
        }
    }
}

@MainActor let cardRowSheet = Sheet("card-row") {
    Specimen("A slot: a switch with its line; a figure drawn; a row beside them") {
        Card(group: true) {
            CardRow {
                Toggle(isOn: .constant(true)) {
                    Text("Ask at bedtime")
                    Text("One question before you sleep.")
                }
                .toggleStyle(.cockpit)
            }
            CardRow {
                HStack(alignment: .bottom, spacing: 3) {
                    ForEach([4, 9, 6, 12, 3, 0, 7, 14, 10, 5, 8, 11], id: \.self) { height in
                        RoundedRectangle(cornerRadius: 1).fill(Cockpit.Color.data2).frame(height: CGFloat(height) * 3 + 2)
                    }
                }
                .frame(height: 48, alignment: .bottom)
            }
            ListRow("Recorder", meta: "On", chevron: true, separator: false, action: {})
        }
    }
}

@MainActor private var hovered: some View {
    var row = ListRow("Hover (Mac)", meta: "Meta line", leading: .icon(.home), chevron: true, action: {})
    row.forced = .hover
    return row
}

@MainActor private var pressed: some View {
    var row = ListRow("Pressed", meta: "Meta line", leading: .icon(.home), chevron: true, action: {})
    row.forced = .pressed
    return row
}

@MainActor let monogramSheet = Sheet("monogram") {
    Specimen("sm 24 · md 32 · row 36 · tile 56 · head 72") {
        HStack(alignment: .center, spacing: 16) {
            Monogram("Mira Sen", size: .sm)
            Monogram("Mira Sen", size: .md)
            Monogram("Mira Sen", size: .row)
            Monogram("Mira Sen", size: .tile)
            Monogram("Mira Sen", size: .head)
        }
    }
    Specimen("One name · two names · three words · a number") {
        HStack(spacing: 16) {
            Monogram("Mira", size: .tile)
            Monogram("Person A", size: .tile)
            Monogram("Anna de la Cruz", size: .tile)
            Monogram("+1 555 0000 001", size: .tile)
        }
    }
    Specimen("No name yet: row · tile · head") {
        HStack(alignment: .center, spacing: 16) {
            Monogram(nil, size: .row)
            Monogram(nil, size: .tile)
            Monogram(nil, size: .head)
        }
    }
}

@MainActor let signalSheet = Sheet("signal") {
    Specimen("Each signal, its shape and word") {
        VStack(alignment: .leading, spacing: 10) {
            Signal(.engaged, "Recording", pulse: true)
            Signal(.idle, "Paused")
            Signal(.now, "16:42 now")
            Signal(.plan, "Coming up")
            Signal(.caution, "Needs you")
            Signal(.warning, "Stopped")
        }
    }
    Specimen("Strong, with detail") {
        VStack(alignment: .leading, spacing: 10) {
            Signal(.engaged, "On", detail: "2 min ago", strong: true)
            Signal(.caution, "Limited", detail: "212 photos can't be read", strong: true)
            Signal(.warning, "Can't reach Lifestream", detail: "Last reached 14:02", strong: true)
        }
    }
    Specimen("Shapes at 12, 16, 24") {
        HStack(spacing: 8) {
            ForEach(Cockpit.SignalKind.allCases, id: \.self) { kind in
                HStack(spacing: 2) { SignalShape(kind, size: 12); SignalShape(kind, size: 16); SignalShape(kind, size: 24) }
            }
        }
    }
    Specimen("The home's nine states, each before the home's line") {
        Card(group: true) {
            ForEach(Cockpit.HealthState.allCases, id: \.self) { state in
                ListRow(state.rawValue, meta: healthLines[state], signal: state.signal, leading: .symbol(.recording),
                        separator: state != Cockpit.HealthState.allCases.last) { EmptyView() }
            }
        }
    }
}

private let healthLines: [Cockpit.HealthState: String] = {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    guard let data = try? Data(contentsOf: root.appendingPathComponent("homelink/Tests/Fixtures/report.json")),
          let report = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let rows = report["connectors"] as? [[String: Any]] else { return [:] }
    var lines: [Cockpit.HealthState: String] = [:]
    for row in rows {
        guard let health = row["health"] as? [String: Any], let state = (health["state"] as? String).flatMap(Cockpit.HealthState.init(rawValue:)),
              let line = row["line"] as? String, lines[state] == nil else { continue }
        lines[state] = line
    }
    return lines
}()
#endif
