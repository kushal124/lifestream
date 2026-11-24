import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct ShownRow: Identifiable {
    let row: HomeLink.Pages.Row
    let meta: String?

    var id: String { row.id }

    init(_ lined: PeopleListing.Lined) {
        row = lined.row
        meta = lined.line
    }

    init(_ row: HomeLink.Pages.Row, meta: String?) {
        self.row = row
        self.meta = meta
    }

    static func of(_ rows: [HomeLink.Pages.Row], today: String, grouped: Bool = false, now: Date = AppClock.now) -> [ShownRow] {
        rows.map { ShownRow($0, meta: PeopleListing.meta($0, today: today, now: now, grouped: grouped)) }
    }
}

struct PeopleGroup: View {
    let label: String?
    let id: String
    let shown: [ShownRow]
    let counting: Bool

    init(_ label: String?, id: String, shown: [ShownRow], counting: Bool = false) {
        self.label = label
        self.id = id
        self.shown = shown
        self.counting = counting
    }

    var body: some View {
        if !shown.isEmpty {
            Card(label, group: true, flat: true) {
                LazyVStack(spacing: 0) {
                    ForEach(shown) { each in
                        PersonRow(row: each.row, meta: each.meta, counting: counting, separator: each.id != shown.last?.id)
                            .id("person \(id) \(each.id)")
                    }
                }
                .scrollTargetLayout()
            }
        }
    }
}

extension PeopleGroup {
    static var reading: some View {
        let names = ["Person A", "Person Bee", "Person C", "Person Dee Ess", "Person E", "Person F"]
        let lines = ["12 messages today", "Yesterday", "3 messages today", "Thursday", "12 Oct", "Yesterday"]
        return VStack(alignment: .leading, spacing: 0) {
            Card("This week", group: true, flat: true) {
                ForEach(names.indices, id: \.self) { index in
                    ListRow(names[index], meta: lines[index], mono: true, leading: .monogram(names[index]),
                            separator: index < names.count - 1, action: {})
                }
            }
            WaitLine()
        }
        .reading(true)
    }
}

struct GroupsGroup: View {
    let label: String
    let groups: [HomeLink.Pages.ChatRow]
    let quiet: [HomeLink.Pages.ChatRow]
    @Binding var quietOpen: Bool
    let today: String

    init(_ label: String, groups: [HomeLink.Pages.ChatRow], quiet: [HomeLink.Pages.ChatRow] = [],
         quietOpen: Binding<Bool> = .constant(false), today: String) {
        self.label = label
        self.groups = groups
        self.quiet = quiet
        self._quietOpen = quietOpen
        self.today = today
    }

    var body: some View {
        if !groups.isEmpty || !quiet.isEmpty {
            Card(label, group: true, flat: true) {
                LazyVStack(spacing: 0) {
                    ForEach(groups, id: \.chat) { chat in
                        GroupRow(chat: chat, today: today, separator: chat.chat != groups.last?.chat || !quiet.isEmpty)
                            .id("group " + chat.chat)
                    }
                    if !quiet.isEmpty {
                        FoldRow("Quiet", count: quiet.count, open: $quietOpen, separator: quietOpen)
                            .accessibilityIdentifier("people.groups.quiet")
                            .id("groups quiet")
                        if quietOpen {
                            ForEach(quiet, id: \.chat) { chat in
                                GroupRow(chat: chat, today: today, separator: chat.chat != quiet.last?.chat)
                                    .id("group " + chat.chat)
                            }
                        }
                    }
                }
                .scrollTargetLayout()
            }
        }
    }
}

struct YouRow: View {
    let you: HomeLink.Pages.Row

    var body: some View {
        let drawn = HomePictures.shared.face(you.photo)
        Card("You", group: true, flat: true) {
            ListRow(you.name, meta: you.line, leading: .monogram(you.name, photo: drawn), separator: false,
                    action: { AppNavigation.shared.push(.person(you.id)) })
                .readsFace(you.photo, size: .row)
                .facesValue(you.photo, drawn: drawn)
                .accessibilityIdentifier("people.you")
        }
    }
}

fileprivate struct PersonRow: View {
    let row: HomeLink.Pages.Row
    let meta: String?
    let counting: Bool
    var separator = true

    var body: some View {
        let drawn = HomePictures.shared.face(row.photo)
        ListRow(row.name, meta: meta, metaReading: counting, mono: true,
                leading: .monogram(row.named ? row.name : nil, photo: drawn), separator: separator,
                action: { AppNavigation.shared.push(.person(row.id)) })
            .readsFace(row.photo, size: .row)
            .facesValue(row.photo, drawn: drawn)
            .accessibilityIdentifier("people.row.\(row.id)")
    }
}

struct GroupRow: View {
    let chat: HomeLink.Pages.ChatRow
    let today: String
    var separator = true

    var body: some View {
        ListRow(chat.title, meta: PeopleListing.meta(chat, today: today, now: AppClock.now), mono: true,
                leading: .symbol(.meeting), separator: separator,
                action: { AppNavigation.shared.push(.group(chat.chat)) })
            .accessibilityIdentifier("people.group.\(chat.chat)")
    }
}

struct MostInTouch: View {
    let most: [PeopleListing.Lined]

    private static let fits = 3

    private var shown: [PeopleListing.Lined] { Array(most.prefix(Self.fits)) }

    var body: some View {
        if !most.isEmpty {
            Card("Most in touch", group: true, flat: true) {
                ForEach(shown, id: \.row.id) { row($0) }
            }
        }
    }

    private func row(_ lined: PeopleListing.Lined) -> some View {
        let person = lined.row
        let drawn = HomePictures.shared.face(person.photo)
        return ListRow(person.name, meta: lined.line + Words.dot + "30 days", leading: .monogram(person.name, photo: drawn),
                       separator: person.id != shown.last?.row.id, action: { AppNavigation.shared.push(.person(person.id)) })
            .readsFace(person.photo, size: .row)
            .facesValue(person.photo, drawn: drawn)
            .accessibilityIdentifier("people.month.\(person.id)")
    }
}

struct OrganiseCard: View {
    let count: Int
    @Binding var view: PeopleTabModel.Listing

    var body: some View {
        if count > 0 {
            Card(group: true) {
                ListRow("Organise", leading: .icon(.people), value: Words.count(count), chevron: true,
                        selected: view == .organise, separator: false, action: { view = .organise })
                    .accessibilityIdentifier("people.tidy.organise")
            }
        }
    }
}

struct NobodyYet: View {
    @ObservedObject private var products = ProductsBook.shared

    var body: some View {
        VStack(spacing: Cockpit.Space.s2) {
            ForEach(Array(products.names.connectors(of: "messages").enumerated()), id: \.element.product) { index, each in
                offer(each.product, each.named, primary: index == 0)
            }
        }
    }

    private func offer(_ product: String, _ named: ProductNames.Named, primary: Bool) -> some View {
        Offer(icon: named.icon.flatMap(Cockpit.Icon.init(rawValue:)) ?? .message, name: named.name,
              line: "Brings in everyone you write to there.", button: "Connect", primary: primary,
              identifier: "people.connect.\(product)") { AppNavigation.shared.openStream(named.connector ?? product) }
    }
}
