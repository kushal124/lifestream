#if os(macOS)
import SwiftUI
@testable import Cockpit

@MainActor let searchFieldSheet = Sheet("search-field", hosted: true) {
    Specimen("Empty") { SearchField(text: .constant("")) }
    Specimen("Typing, focused") { focusedField("mira") }
    Specimen("With clear, not focused") { SearchField(text: .constant("Corner Gym")) }
    Specimen("Key hint while empty (Mac only)") { SearchField(text: .constant(""), shortcut: "⌘K") }
    Specimen("Key hint gives way to clear") { SearchField(text: .constant("14 oct"), shortcut: "⌘K") }
    Specimen("Another placeholder") { SearchField(text: .constant(""), placeholder: "Find a person") }
    Specimen("Long text") { SearchField(text: .constant("lunch with Mira at the place near the river last spring")) }
    Specimen("On a card") {
        Card { SearchField(text: .constant(""), placeholder: "Filter this day", shortcut: "/") }
    }
}

@MainActor private func focusedField(_ text: String) -> SearchField {
    var field = SearchField(text: .constant(text), shortcut: "⌘K")
    field.forcedFocus = true
    return field
}

@MainActor let fieldSheet = Sheet("field", hosted: true) {
    Specimen("Empty, a placeholder") { Field("Name this place", text: .constant(""), placeholder: "Name this place") }
    Specimen("Typed") { Field("Name", text: .constant("Home")) }
    Specimen("Typing, focused") { focusedValueField("Corner Gym") }
    Specimen("Long text") { Field("Name", text: .constant("The coffee place by the station with the long tables")) }
    Specimen("Refused") {
        Field("App password", text: .constant("password"), secure: true, error: "Gmail did not accept this app password.")
    }
    Specimen("Under a part label, beside its buttons") {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Name")
            Field("Name this place", text: .constant(""), placeholder: "Name this place")
            HStack(spacing: 4) {
                Button("Name it") {}.buttonStyle(.cockpit(.primary))
                Button("Not now") {}.buttonStyle(.cockpit(.plain))
            }
        }
    }
}

@MainActor private func focusedValueField(_ text: String) -> Field {
    var field = Field("Name", text: .constant(text))
    field.forcedFocus = true
    return field
}

private let reaches = [20, 30, 40, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000]

@MainActor let valueStepperSheet = Sheet("value-stepper") {
    Specimen("A reach, mid-ladder") {
        ValueStepper("Reach", value: .constant(75), steps: reaches, less: "Smaller", more: "Larger") { "\($0) m" }
    }
    Specimen("At the bottom · at the top") {
        HStack(spacing: 12) {
            ValueStepper("Reach", value: .constant(20), steps: reaches, less: "Smaller", more: "Larger") { "\($0) m" }
            ValueStepper("Reach", value: .constant(2000), steps: reaches, less: "Smaller", more: "Larger") { "\($0) m" }
        }
    }
    Specimen("A reach made elsewhere, off the ladder (83 m): shown as it is, a step lands on 85 m or 80 m") {
        ValueStepper("Reach", value: .constant(83), notch: { at, way in
            let width = at < 100 ? 5 : 10
            return way > 0 ? at / width * width + width : (at + width - 1) / width * width - width
        }, less: "Smaller", more: "Larger") { "\($0) m" }
    }
    Specimen("A year") {
        ValueStepper("Year", value: .constant(2026), steps: Array(2019...2026), less: "The year before", more: "The year after") { String($0) }
    }
    Specimen("Beside a sentence") {
        HStack(spacing: 12) {
            ValueStepper("Reach", value: .constant(65), steps: [20, 30, 40, 50, 65, 75, 100], less: "Smaller", more: "Larger") { "\($0) m" }
            Text("How far from the centre a stay still counts as here.").cockpit(.footnote).foregroundStyle(Cockpit.Color.textTertiary)
        }
    }
}

@MainActor let kbdSheet = Sheet("kbd") {
    Specimen("Keys") {
        HStack(spacing: 8) {
            Kbd("⌘K"); Kbd("/"); Kbd("⏎"); Kbd("Esc"); Kbd("j"); Kbd("k"); Kbd("⌘["); Kbd("⌥⌘F")
        }
    }
    Specimen("Beside words") {
        VStack(alignment: .leading, spacing: 10) {
            Hint("Search", "⌘K")
            Hint("Open the row", "⏎")
            Hint("Close the inspector", "Esc")
        }
    }
    Specimen("On a card") {
        Card {
            HStack(spacing: 6) {
                Text("Mira Sen").cockpit(.rowTitle).foregroundStyle(Cockpit.Color.text)
                Spacer()
                Kbd("1")
            }
        }
    }
}

private struct Hint: View {
    let words: String, keys: String
    init(_ words: String, _ keys: String) { self.words = words; self.keys = keys }
    var body: some View {
        HStack(spacing: 8) {
            Text(words).cockpit(.body).foregroundStyle(Cockpit.Color.textSecondary)
            Kbd(keys)
        }
    }
}

private let dayChips = [
    Chip("Conversations", count: 36), Chip("Mail", count: 62), Chip("Mac", count: 6),
    Chip("Calls", count: 1), Chip("Photos", count: 12_480), Chip("Notes", count: 3),
]

@MainActor let chipRowSheet = Sheet("chip-row", hosted: true) {
    Specimen("All (nothing chosen)") { ChipRow(dayChips, selection: .constant([])) }
    Specimen("One chosen") { ChipRow(dayChips, selection: .constant(["Mail"])) }
    Specimen("Several chosen (⌘-click adds)") { ChipRow(dayChips, selection: .constant(["Conversations", "Calls"])) }
    Specimen("Hover (Mac) on Mail · pressed on Mac") {
        VStack(alignment: .leading, spacing: 8) {
            forcedRow("Mail", .hover)
            forcedRow("Mac", .pressed)
        }
    }
    Specimen("Huge and tiny counts") {
        ChipRow([Chip("Photos", count: 12_480), Chip("Messages", count: 1_204_118), Chip("Calls", count: 1)], selection: .constant(["Calls"]))
    }
    Specimen("With icons, no All") {
        ChipRow([Chip("Conversations", count: 36, icon: .message), Chip("Mail", count: 62, icon: .mail),
                 Chip("Photos", count: 9, icon: .photos), Chip("Notes", count: 2, icon: .note)],
                selection: .constant(["Mail"]), all: false)
    }
    Specimen("No counts") {
        ChipRow([Chip("Mira Sen"), Chip("Person A"), Chip("Home")], selection: .constant(["Mira Sen"]), all: false)
    }
}

@MainActor private func forcedRow(_ id: String, _ state: RowHighlight) -> ChipRow<String> {
    var row = ChipRow(dayChips, selection: .constant([]))
    row.forced = (id, state)
    return row
}

@MainActor let toggleSheet = Sheet("toggle") {
    Specimen("On · off") {
        VStack(spacing: 0) {
            Toggle("Screen", isOn: .constant(true))
            Toggle("Microphone", isOn: .constant(false))
        }
        .toggleStyle(.cockpit)
    }
    Specimen("With a detail line") {
        VStack(spacing: 0) {
            Toggle(isOn: .constant(true)) {
                Text("Open at login")
                Text("Lifestream starts recording when you log in.")
            }
            Toggle(isOn: .constant(false)) {
                Text("Sounds")
                Text("What the Mac plays, recorded with the screen. About 40 MB an hour, to Lifestream on this Mac and nowhere else.")
            }
        }
        .toggleStyle(.cockpit)
    }
    Specimen("Switch alone: on · off") {
        HStack(spacing: 16) {
            Toggle("Screen", isOn: .constant(true)).labelsHidden()
            Toggle("Microphone", isOn: .constant(false)).labelsHidden()
        }
        .toggleStyle(.cockpit)
    }
    Specimen("Disabled: on · off") {
        VStack(spacing: 0) {
            Toggle("Health", isOn: .constant(true))
            Toggle("Screen Time", isOn: .constant(false))
        }
        .toggleStyle(.cockpit)
        .disabled(true)
    }
    Specimen("Rows in a card") {
        Card {
            VStack(spacing: 0) {
                Toggle(isOn: .constant(true)) { Text("Location"); Text("Where you are through the day.") }
                Rectangle().fill(Cockpit.Color.hairline).frame(height: Cockpit.Stroke.border)
                Toggle(isOn: .constant(false)) { Text("Photos"); Text("Paused") }
            }
            .toggleStyle(.cockpit)
        }
    }
}

@MainActor let loadingSheet = Sheet("loading") {
    Specimen("A page read: the mark, centred in the space offered") {
        HStack(spacing: 24) {
            frame("Reading the days", moment: 0)
            frame("Reading everyone you talk with", moment: 0.5)
        }
        .frame(height: 220)
    }
    Specimen("A page read past duration-patience: waiting for Lifestream") {
        frame("Reading everyone you talk with", moment: 0.5, waiting: true)
            .frame(height: 220)
    }
    Specimen("Inside a card and a row: the small mark") {
        HStack(alignment: .top, spacing: 24) {
            Card("Recent") { frame("Reading what you did together", size: .inline, moment: 0.25) }
            frame("Reading the connectors", size: .inline, moment: 0.75)
        }
    }
}

@MainActor private func frame(_ label: String, size: Loading.Size = .page, moment: Double, waiting: Bool = false) -> Loading {
    var loading = Loading(label, size: size)
    loading.forced = moment
    loading.forcedWaiting = waiting
    return loading
}
#endif
