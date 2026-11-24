#if os(macOS)
import AppKit
import SwiftUI
@testable import Cockpit

@MainActor private func onSheet<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: NameRow.gap) { content() }
        .padding(Cockpit.Space.s4)
        .background(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous).fill(Cockpit.Color.surface))
}

private struct OpenDateRow: View {
    @State var day: DateRow.Day?
    @State var open = true
    var forced: RowHighlight?
    var body: some View {
        let row = DateRow("Birthday", day: $day, empty: "Add birthday", open: $open, years: 1900...2026)
        return set(row, \.forced, forced)
    }
}

private struct SectionDateRow: View {
    @State var day: DateRow.Day? = .init(month: 4, day: 12, year: 2017)
    @State var open = true
    var body: some View {
        SheetPart("History") {
            DateRow("History from", day: $day, empty: "Choose a day", open: $open, clear: nil, yearAlways: true,
                    separator: false, said: .init(line: "Read from this day on"))
        }
    }
}

@MainActor let dateRowSheet = Sheet("date-row", platforms: [.ios]) {
    Specimen("A date · with its year · none") {
        onSheet {
            DateRow("Birthday", day: .constant(.init(month: 8, day: 14)), empty: "Add birthday", open: .constant(false))
            DateRow("Birthday", day: .constant(.init(month: 8, day: 14, year: 1993)), empty: "Add birthday", open: .constant(false))
            DateRow("Birthday", day: .constant(nil), empty: "Add birthday", open: .constant(false))
        }
    }
    Specimen("Pressed: the line fills pressed") {
        onSheet { OpenDateRow(day: .init(month: 8, day: 14), open: false, forced: .pressed) }
    }
    Specimen("Open: the wheel under the line, day and month; Clear and the Year switch") {
        onSheet { OpenDateRow(day: .init(month: 8, day: 14)) }
    }
    Specimen("The Year switch on: the year’s column") {
        onSheet { OpenDateRow(day: .init(month: 2, day: 28, year: 1993)) }
    }
    Specimen("Disabled, while its sheet saves") {
        onSheet {
            DateRow("Birthday", day: .constant(.init(month: 8, day: 14, year: 1993)), empty: "Add birthday", open: .constant(false))
                .disabled(true)
        }
    }
    Specimen("In a settings section, a full date: the date and caret its row's end, the year always (a stream's first day)") {
        SheetPart("History") {
            DateRow("History from", day: .constant(.init(month: 4, day: 12, year: 2017)), empty: "Choose a day",
                    open: .constant(false), clear: nil, yearAlways: true, separator: false)
        }
        .padding(Cockpit.Space.s4)
        .groundColor(Cockpit.Color.surface)
    }
    Specimen("In a settings section, open: the wheel under the row's words, day, month and year") {
        SectionDateRow()
            .padding(Cockpit.Space.s4)
            .groundColor(Cockpit.Color.surface)
    }
    Specimen("Accessibility size (AX3): the label over the date; the wheel’s rows grown") {
        onSheet {
            DateRow("Birthday", day: .constant(nil), empty: "Add birthday", open: .constant(false))
            OpenDateRow(day: .init(month: 9, day: 30, year: 1993))
        }
        .environment(\.dynamicTypeSize, .accessibility3)
    }
}

private enum Save { case unchanged, ready, busy }

private struct DrawnBar: View {
    let save: Save

    var body: some View {
        let edit = SheetEdit(opened: Save.unchanged, now: save, identifier: "person.edit") { .close }
        let acts = SheetActs(drawn: save == .busy ? .running : .idle)
        HStack(spacing: Cockpit.Space.s2) {
            SheetCancel(edit: edit, acts: acts) {}
            Spacer(minLength: 0)
            SheetKeep(edit: edit, acts: acts)
        }
        .overlay {
            Text("Edit person")
                .cockpit(.headline)
                .foregroundStyle(Cockpit.Color.text)
                .lineLimit(1)
        }
        .padding(.horizontal, Cockpit.Space.s4)
        .padding(.top, Cockpit.Space.s4)
        .padding(.bottom, Cockpit.Space.s2)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

private struct EditPerson: View {
    @State private var birthday: DateRow.Day?
    @State private var open = false
    @State private var kind: String?

    var body: some View {
        VStack(spacing: 0) {
            DrawnBar(save: .ready)
            VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
                head
                fields
                theirs
                VStack(alignment: .leading, spacing: NameRow.gap) {
                    notAPerson
                    hide
                }
            }
            .padding(.horizontal, Cockpit.Space.s4)
            .padding(.top, Cockpit.Space.s2)
            .padding(.bottom, Cockpit.Space.s8)
        }
        .groundColor(Cockpit.Color.surface)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: Cockpit.Radius.s2xl, topTrailingRadius: Cockpit.Radius.s2xl, style: .continuous))
        .padding(.top, Cockpit.Space.s2)
    }

    private var head: some View {
        HStack(spacing: Cockpit.Space.s4) {
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .head, badge: true)
                .accessibilityLabel("Change photo")
            Text("Sam")
                .cockpit(.title2)
                .foregroundStyle(Cockpit.Color.text)
                .cockpitLines(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: NameRow.gap) {
            FieldRow("Name", text: .constant("Sam"))
            FieldRow("Full name", text: .constant("Sam Rivera"), source: "WhatsApp · 4 mails")
            FieldRow("Relationship", text: .constant(""), placeholder: "Friend from college", capitalizesWords: false)
            FieldRow("Work", text: .constant("Northside Studio"))
            DateRow("Birthday", day: $birthday, empty: "Add birthday", open: $open, years: 1900...2026)
            if birthday == nil {
                NameRow("14 August?", line: "From your messages", lead: .key("Suggested"), end: .add(false) {}) {}
            }
        }
    }

    private var notAPerson: some View {
        MenuRow("Mark as not a person", selection: $kind, options: [.init("AI", "AI"), .init("A business", "A business"),
                                                                     .init("An automated sender", "An automated sender")],
                prompt: "Mark as not a person")
            .padding(.leading, Cockpit.Space.s1)
    }

    private var theirs: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            SectionLabel("Numbers and emails")
            VStack(alignment: .leading, spacing: NameRow.gap) {
                NameRow("+1 555 000 0001", line: "From Contacts", lead: .key("Phone"), end: .remove("Remove") {}) {}
                NameRow("sam.rivera@example.com", line: "", lead: .key("Email"), end: .remove("Remove") {}) {}
                NameRow("@sam.rivera", line: "", lead: .key("Instagram"), end: .remove("Remove") {}) {}
                NameRow("Number hidden", line: "", lead: .key("WhatsApp"), end: .remove("Remove") {}) {}
                NameRow("+1 555 000 0014", line: "Same name · 212 messages", lead: .key("Phone"), end: .add(true) {}) {}
                NameRow("s.rivera@example.com", line: "Mail in their name · 14 mails", lead: .key("Email"), end: .add(false) {}) {}
                AddRow("Add a number, email or link", text: .constant(""), field: true, keyed: true) {}
            }
        }
    }

    private var hide: some View {
        Button {} label: {
            HStack(spacing: Cockpit.Space.s3) {
                Text("Hide from People")
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .cockpitLines(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, Cockpit.Space.s4)
            .frame(minHeight: Cockpit.Size.target)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct Bleed<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View { content.padding(.horizontal, -Cockpit.Space.s4) }
}

@MainActor let editPersonSheet = Sheet("edit-person", hosted: true, platforms: [.ios]) {
    Bleed { EditPerson() }
}

@MainActor let editPersonLargeSheet = Sheet("edit-person-large", hosted: true, platforms: [.ios]) {
    Bleed { EditPerson() }
        .environment(\.dynamicTypeSize, .accessibility3)
}

@MainActor let editPersonStatesSheet = Sheet("edit-person-states", hosted: true, platforms: [.ios]) {
    Specimen("Nothing changed: Save waits") {
        Bleed { DrawnBar(save: .unchanged) }
    }
    Specimen("Save asked: busy in place, the sheet’s controls disabled") {
        Bleed {
            VStack(spacing: Cockpit.Space.s2) {
                DrawnBar(save: .busy)
                VStack(spacing: NameRow.gap) {
                    FieldRow("Name", text: .constant("Sam"))
                    DateRow("Birthday", day: .constant(.init(month: 8, day: 14)), empty: "Add birthday", open: .constant(false))
                    NameRow("+1 555 000 0014", line: "WhatsApp · same name, 212 messages", lead: .icon(.message), end: .tick(true) {}) {}
                }
                .padding(.horizontal, Cockpit.Space.s4)
                .disabled(true)
            }
            .groundColor(Cockpit.Color.surface)
        }
    }
    Specimen("Not sent: the act’s failure under the bar, the sheet kept") {
        Bleed {
            VStack(spacing: 0) {
                DrawnBar(save: .ready)
                InPlaceLine(.notSent, retry: {})
                    .padding(.horizontal, Cockpit.Space.s4)
                    .padding(.bottom, Cockpit.Space.s2)
            }
            .groundColor(Cockpit.Color.surface)
        }
    }
    Specimen("Not a person?: the home’s suspicion, ticked · what was said, a tag ending in ×") {
        onSheet {
            NameRow("AI", line: "Replies within 20 s", lead: .icon(.ai), end: .tick(true) {}) {}
            CardChip("A business", kind: .tag) {}.padding(.top, Cockpit.Space.s2)
        }
    }
}
#endif
