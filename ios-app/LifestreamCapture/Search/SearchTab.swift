import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct SearchTab: View {
    @ObservedObject private var model = SearchModel.shared
    @ObservedObject private var home = HomeToday.shared
    @ObservedObject private var book = PeopleBook.shared
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: model.words.isEmpty ? Cockpit.Space.s6 : 0) {
                if model.words.isEmpty {
                    BeforeTyping(model: model, open: open).environment(\.cockpitRowsFaces, Cockpit.Size.lead)
                } else {
                    Results(model: model, open: open)
                }
            }
            .padding(.horizontal, Cockpit.Gap.edge)
            .padding(.top, Cockpit.Space.s3)
            .padding(.bottom, Cockpit.Space.s8)
        }
        .accessibilityIdentifier("search.root")
        .barTitleScroll(current: true)
        .rootBar("Search", raisesFoot: !model.words.isEmpty) { RootTitle("Search") } controls: {
            Button { AppNavigation.shared.presented = nil } label: {
                Icon(.close, size: .lg, label: "Close").foregroundStyle(Cockpit.Color.text).barSlot()
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search.close")
        }
        .transformEnvironment(\.rootBarFoot) { foot in
            let banner = foot
            foot = AnyView(VStack(spacing: 0) {
                if let banner { banner }
                field
            })
        }
        .scrollDismissesKeyboard(.immediately)
        .groundColor(Cockpit.Color.canvas)
        .photoViewer($model.viewing) { open($0) }
        .onAppear {
            if let words = AppNavigation.shared.designSearch, !words.isEmpty { model.text = words }
            if model.words.isEmpty || AppRuntime.asked("--ui-test-keyboard") || AppRuntime.asked("--ui-test-submitted") { fieldFocused = true }
        }
        .task {
            guard AppRuntime.asked("--ui-test-submitted") else { return }
            try? await Task.sleep(for: .seconds(1.5))
            submit()
        }
        .task { await model.readNames() }
        .readsAgain(unread: { !model.placesRead }) { await model.readNames() }
        .readsAgain(failed: { if case .failed(let failure) = model.answer { failure } else { nil } }) {
            model.tryAgain()
        }
        .task(id: model.asking) { await model.ask(model.asking) }
        .task(id: model.seeing) { await model.see(model.seeing) }
    }

    private var field: some View {
        HStack(spacing: Cockpit.Space.s3) {
            SearchField(text: $model.text.timed(.searchKeystroke), placeholder: "Search your life", focus: $fieldFocused)
                .autocorrectionDisabled()
                .onSubmit(submit)
                .accessibilityIdentifier("search.field")
            if fieldFocused && model.words.isEmpty {
                Button("Cancel") {
                    model.text = ""
                    fieldFocused = false
                }
                .buttonStyle(.cockpit(.plain))
                .accessibilityIdentifier("search.cancel")
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(Cockpit.Ease.out(Cockpit.Duration.fast), value: fieldFocused)
        .padding(.leading, Cockpit.Gap.edge)
        .padding(.trailing, model.words.isEmpty ? Cockpit.Gap.edge : Cockpit.Space.s3)
        .padding(.top, Cockpit.Space.s1)
        .padding(.bottom, Cockpit.Space.s2)
    }

    private func submit() {
        model.remember()
        fieldFocused = false
    }

    private func open(_ route: LifeRoute) {
        if !model.words.isEmpty { model.remember() }
        fieldFocused = false
        AppNavigation.shared.pushInSearch(route)
    }
}

private struct BeforeTyping: View {
    @ObservedObject var model: SearchModel
    let open: (LifeRoute) -> Void

    var body: some View {
        let people = model.suggestedPeople, places = model.suggestedPlaces
        let reading = !model.namesRead
        if !model.recent.words.isEmpty {
            RecentSearches(words: model.recent.words, pick: { model.text = $0 }, clear: model.clearRecent)
                .environment(\.cockpitRowsBare, true)
        }
        if reading || !people.isEmpty {
            VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                SectionLabel("People")
                Card(group: true, flat: true) {
                    if reading && people.isEmpty {
                        ForEach(0..<3, id: \.self) { index in
                            ListRow(["Person A", "Person B", "Person C"][index], leading: .monogram("Person"), chevron: false, separator: index < 2)
                        }
                    } else {
                        ForEach(Array(people.enumerated()), id: \.element.id) { index, person in
                            PersonHitRow(name: person.name, id: person.id, face: person.photo?.hash, line: nil, separator: index < people.count - 1) {
                                open(.person(person.id))
                            }
                        }
                    }
                }
                .reading(reading && people.isEmpty)
            }
        }
        if reading || !places.isEmpty {
            VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                SectionLabel("Places")
                Card(group: true, flat: true) {
                    if reading && places.isEmpty {
                        ForEach(0..<3, id: \.self) { index in
                            ListRow(["Home", "The Office", "Synthetic Gym"][index], excerpt: .init("12 days"), leading: .tile(.place),
                                    chevron: false, separator: index < 2)
                        }
                    } else {
                        ForEach(Array(places.enumerated()), id: \.element.slug) { index, place in
                            PlaceHitRow(name: place.name, slug: place.slug, line: PlacesWords.line(place, now: AppClock.now),
                                        separator: index < places.count - 1) {
                                open(.place(place.slug))
                            }
                        }
                    }
                }
                .reading(reading && places.isEmpty)
            }
        }
    }
}

private struct Results: View {
    @ObservedObject var model: SearchModel
    let open: (LifeRoute) -> Void

    var body: some View {
        switch model.answer {
        case .found(let found) where SearchModel.readying(found) != nil:
            EmptyState(.search, SearchModel.readying(found) ?? "")
                .accessibilityIdentifier("search.state")
        case .failed(let failure):
            ReadLack(failure, lacks: "Search results aren't on this iPhone.", words: Self.sentence(failure), retry: model.tryAgain)
            if let drawn = model.drawn { Answered(model: model, found: drawn, open: open).padding(.top, Cockpit.Gap.head) }
        case .found(let found) where SearchModel.isEmpty(found):
            if model.chipsShown(found) { KindChips(model: model, found: found) }
            if let nothing = found.nothing {
                EmptyState(.search, nothing)
                    .accessibilityIdentifier("search.none")
            }
            StillReading(model: model, found: found)
        case .found(let found):
            Answered(model: model, found: found, open: open)
        case nil:
            if let drawn = model.drawn {
                Answered(model: model, found: drawn, open: open)
            } else {
                KindChips(model: model, found: nil)
                VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                    SectionLabel("Top hits")
                    Card(group: true, flat: true) { HitRow.reading(3) }
                }
                .reading(true)
                .padding(.top, Cockpit.Gap.head)
            }
        }
    }

    private static func sentence(_ failure: LifeReader.Failure) -> String? {
        switch failure {
        case .missing, .unpaired: "Lifestream could not search."
        case .refused(let words), .failed(let words), .unknown(let words): "Lifestream could not search: \(words)."
        case .busy(let words, _, _, _): words
        case .reach: nil
        }
    }
}

private struct Answered: View {
    @ObservedObject var model: SearchModel
    let found: SearchModel.Search
    let open: (LifeRoute) -> Void

    var body: some View {
        if model.chipsShown(found) { KindChips(model: model, found: found) }
        if model.kind == nil { StillReading(model: model, found: found, top: Cockpit.Space.s3) }
        Group {
            if let kind = model.kind {
                SeeAll(model: model, kind: found.kinds.first { $0.family.rawValue == kind }, open: open)
            } else {
                LazyVStack(alignment: .leading, spacing: Cockpit.Gap.section) {
                    ForEach(model.parts) { part in
                        switch part {
                        case .top(let rows): TopHits(model: model, rows: rows, open: open)
                        case .kind(let kind): KindSection(model: model, kind: kind, open: open)
                        }
                    }
                }
            }
        }
        .padding(.top, Cockpit.Gap.head)
    }
}

private struct StillReading: View {
    @ObservedObject var model: SearchModel
    let found: SearchModel.Search
    var top: CGFloat = 0

    var body: some View {
        if let line = model.stillReading(found) {
            Text(line)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, top)
                .accessibilityIdentifier("search.pending")
        }
    }
}

private struct TopHits: View {
    @ObservedObject var model: SearchModel
    let rows: [SearchModel.Row]
    let open: (LifeRoute) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
            SectionLabel("Top hits")
            Card(group: true, flat: true) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    Row(model: model, row: row, index: rows.prefix(index).filter(SearchModel.isHit).count, separator: index < rows.count - 1,
                        open: open)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("search.top")
    }
}

private struct Row: View {
    @ObservedObject var model: SearchModel
    let row: SearchModel.Row
    let index: Int
    var dated = false
    let separator: Bool
    let open: (LifeRoute) -> Void

    var body: some View {
        switch row {
        case .hit(let ref, let family, let title, let line, let when, let picture, _):
            HitRow(family: family, title: title, line: line, when: when, picture: picture, today: model.today, dated: dated,
                   unopened: model.unopened[ref], identifier: "search.hit.\(index)", separator: separator, action: go)
        case .person(let ref, let name, let line, let picture, let opens):
            VStack(alignment: .leading, spacing: 0) {
                PersonHitRow(name: name, id: Self.person(opens), face: picture, line: line, separator: separator && model.unopened[ref] == nil, action: go)
                if let unopened = model.unopened[ref] { Unopened(words: unopened) }
            }
        case .place(let ref, let name, let line, let opens):
            VStack(alignment: .leading, spacing: 0) {
                PlaceHitRow(name: name, slug: Self.slug(opens) ?? ref, line: line, separator: separator && model.unopened[ref] == nil, action: go)
                if let unopened = model.unopened[ref] { Unopened(words: unopened) }
            }
        case .date(let when, _):
            DateRow(when: when, today: model.today, separator: separator, action: go)
        case .track(_, let title, _, let line):
            TrackRow(title: title, line: line, separator: separator, action: go)
                .accessibilityIdentifier("search.track.\(index)")
        case .sitting(_, let title, let line, _, let when, _, _, _):
            SittingRow(title: title, line: line, when: when, today: model.today, dated: dated, separator: separator, action: go)
                .accessibilityIdentifier("search.sitting.\(index)")
        case .unknown:
            EmptyView()
        }
    }

    private func go() {
        if let route = model.open(row) { open(route) }
    }

    private static func person(_ opens: HomeLink.Pages.Opens?) -> String? {
        if case .people(let id, let person, _)? = opens { person ?? id } else { nil }
    }

    private static func slug(_ opens: HomeLink.Pages.Opens?) -> String? {
        if case .places(let slug)? = opens { slug } else { nil }
    }
}

private struct DateRow: View {
    let when: HomeLink.Pages.When
    let today: String
    let separator: Bool
    let action: () -> Void

    var body: some View {
        ListRow(title, excerpt: line.map { .init($0) }, leading: .tile(.days), chevron: false, separator: separator, action: action)
            .accessibilityIdentifier("search.goto.day")
    }

    private var title: String {
        switch when {
        case .day(let day): Words.dateTitle(day, today: today)
        case .month(let month): Words.month(ofDay: month + "-01", today: today)
        case .at, .clock, .unknown: ""
        }
    }

    private var line: String? {
        switch when {
        case .day(let day):
            let near = Words.nearDay(day, today: today)
            return near == title ? nil : near
        case .month: return "Month"
        case .at, .clock, .unknown: return nil
        }
    }
}

private struct KindSection: View {
    @ObservedObject var model: SearchModel
    let kind: SearchModel.Section
    let open: (LifeRoute) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
            SectionLabel(kind.title, count: kind.count?.n, atLeast: kind.count?.partial ?? false,
                         open: kind.see ? { model.kind = kind.family.rawValue } : nil)
                .accessibilityIdentifier("search.kind.\(kind.family.rawValue)")
            if let unread = kind.unread {
                Text(unread)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("search.unread.\(kind.family.rawValue)")
            }
            if !kind.rows.isEmpty {
                let offset = model.offset(of: kind.family.rawValue)
                Card(group: true, flat: true) {
                    ForEach(Array(kind.rows.enumerated()), id: \.offset) { index, row in
                        Row(model: model, row: row, index: SearchModel.isHit(row) ? offset + kind.rows.prefix(index).filter(SearchModel.isHit).count : index,
                            separator: index < kind.rows.count - 1, open: open)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("search.section.\(kind.family.rawValue)")
    }
}

private struct SeeAll: View {
    @ObservedObject var model: SearchModel
    let kind: SearchModel.Section?
    let open: (LifeRoute) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
            if let upcoming = kind?.upcoming {
                Card(group: true, flat: true) {
                    ListRow(model.upcoming ? "Up to today" : "Upcoming", leading: .tile(.calendarEvent),
                            value: model.upcoming ? nil : Words.count(upcoming.n) + (upcoming.partial ? "+" : ""), chevron: true, separator: false,
                            action: { model.upcoming.toggle() })
                    .accessibilityLabel(model.upcoming ? "Up to today" : "Upcoming, \(upcoming.partial ? "at least " : "")\(Words.count(upcoming.n))")
                    .accessibilityIdentifier("search.upcoming")
                }
            }
            if let unread = model.seenUnread(kind) {
                Text(unread)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            switch model.seen {
            case .failed(let seeing, let failure) where seeing == model.seeing:
                InPlaceLine(PeopleWords.failure(failure) ?? "Couldn't read these.") { model.tryAgain() }
            default:
                if let page = model.page {
                    rows(page)
                } else {
                    Card(group: true, flat: true) { HitRow.reading(4) }.reading(true)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("search.all")
    }

    @ViewBuilder private func rows(_ page: SearchModel.Page) -> some View {
        if page.rows.isEmpty {
            if let nothing = page.nothing { NoneLine(nothing) }
        } else {
            Card(group: true, flat: true) {
                ForEach(Array(page.rows.enumerated()), id: \.offset) { index, row in
                    Row(model: model, row: row, index: index, dated: true, separator: index < page.rows.count - 1, open: open)
                        .onAppear { if index == page.rows.count - 1 { Task { await model.more() } } }
                }
            }
            if model.loadingMore {
                Card(group: true, flat: true) { HitRow.reading(2) }.reading(true)
            } else if let failed = page.failed {
                InPlaceLine(PeopleWords.failure(failed) ?? "Couldn't read more.") { Task { await model.more() } }
            }
        }
        if let pending = model.stillReading(page) {
            Text(pending)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("search.pending")
        }
    }
}
