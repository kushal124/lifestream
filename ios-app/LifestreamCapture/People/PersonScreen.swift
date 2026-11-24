import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct PersonScreen: View {
    let id: String
    @ObservedObject private var model: PersonModel
    @ObservedObject private var book = PeopleBook.shared
    @ObservedObject private var home = HomeToday.shared
    @ObservedObject private var products = ProductsBook.shared
    @State private var editing = false

    init(id: String) {
        self.id = id
        _model = ObservedObject(wrappedValue: PersonModel.of(id))
    }

    var body: some View {
        OnePage(model.page?.head.name ?? "") {
            content(model.page)
        }
        .accessibilityIdentifier("person.screen")
        .toolbar {
            if book.takes, model.page != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { editing = true }
                        .accessibilityIdentifier("person.edit.open")
                }
            }
        }
        .onChange(of: model.page != nil, initial: true) { _, landed in
            if landed, AppRuntime.asked("--ui-test-edit") { editing = true }
        }
        .sheet(isPresented: $editing) {
            if let page = model.page {
                PersonEdit(model: model, page: page, id: model.target).drawerRest(.large)
            }
        }
        .task(id: home.revision) {
            book.heardTakes()
            async let photos: Void = model.photos.read()
            await model.read()
            await photos
        }
        .onDisappear {
            if !AppNavigation.shared.holds(.person(id)) { model.left() }
        }
        .readsAgain(failed: { model.failure }) {
            await model.read()
        }
    }

    @ViewBuilder
    private func content(_ page: HomeLink.Pages.Person?) -> some View {
        if model.failure == .missing {
            EmptyState(.person, "This person is not in your messages any more.")
        } else if page == nil, let failure = model.failure {
            ReadLack(failure, lacks: "This person isn't on this iPhone yet.", words: PeopleWords.failure(failure)) {
                Task { await model.read() }
            }
        } else if let page, page.me {
            PageNote(drawn: model.pages.drawn)
            YourPage(page: page, model: model, photos: model.photos, done: model.line.map(done))
        } else {
            PageNote(drawn: model.pages.drawn)
            let drawn = page.map(PersonPage.init)
            let counting = page?.counting == true
            let name = page?.head.name ?? "Person A"
            let named = page?.head.named ?? true
            OneHead(name, line: drawn?.line ?? "", quiet: !named, identifier: "person.name", done: model.line.map(done)) {
                HeadFace(name: named ? name : nil, photo: page?.head.photo, held: page != nil, model: model, photos: model.photos)
            }
            .reading(page == nil)
            PageTalk(talk: page?.talk, reading: page == nil, person: true)
            AboutCard(facts: (drawn?.facts(today: home.today, network: PeopleWords.network) ?? []).map { fact in
                HeadFact(id: fact.id, key: fact.key, words: fact.words, link: fact.link, said: fact.said)
            })
            PersonFigure(page: counting ? nil : drawn, today: home.today)
            if page != nil { PersonPhotosGroup(id: id, photos: model.photos) }
            VStack(alignment: .leading, spacing: 0) {
                if !counting, let calls = drawn?.calls { CallsRow(calls: calls.count) }
                WaitLine()
            }
            .waiting(page == nil || counting)
            if let drawn, !counting {
                WhereYouTalk(name: drawn.page.head.name, talks: drawn.talks, today: home.today)
            } else {
                WhereYouTalk.reading
            }
        }
    }

    private func done(_ line: PersonModel.Line) -> HeadDone {
        switch line {
        case .done(let words, let act):
            HeadDone(words: words, press: act == nil ? nil : { Task { await model.undo() } }, busy: model.acting)
        case .said(let words):
            HeadDone(words: words, press: nil)
        case .unanswered(let said):
            HeadDone(words: PeopleBook.words(said), press: { Task { await model.again() } }, act: said == .saving ? .check : .again,
                     busy: model.acting)
        }
    }
}

struct PersonFigure: View {
    let page: PersonPage?
    let today: String

    var body: some View {
        switch page?.figure(today: today) {
        case .weeks(let count, let bars, let marked)?:
            WeekFigure(Words.count(count), words: Self.noun(count) + Words.dot + "30 days", line: page?.since.map { "Since " + $0 },
                       bars: Self.bars(bars), ends: bars.count > 8 ? (bars[0].label, "This week") : nil,
                       labels: bars.count > 1 && bars.count <= 8 ? bars.map(\.label) : nil,
                       marked: marked.map(WeekFigure.Mark.bar) ?? .none) { Self.open(bars[$0]) }
                .accessibilityIdentifier("person.weeks")
        case .years(let total, let bars, let marked, let foot)?:
            WeekFigure(Words.count(total), words: Self.noun(total) + (page?.since.map { " since " + $0 } ?? ""), bars: Self.bars(bars),
                       ends: bars.count > 8 ? (bars[0].label, bars[bars.count - 1].label) : nil,
                       labels: bars.count <= 8 ? bars.map(\.label) : nil,
                       marked: marked.map(WeekFigure.Mark.bar) ?? .none, foot: foot) { Self.open(bars[$0]) }
                .accessibilityIdentifier("person.weeks")
        case .facts(let pairs)?:
            Facts(nil, pairs.map { ($0.key, $0.words) })
                .accessibilityIdentifier("person.weeks")
        case .nothing?:
            EmptyView()
        case nil:
            WeekFigure("00", words: "messages" + Words.dot + "30 days", line: "Since Mar 2025",
                       bars: (0..<Self.readingWeeks).map { _ in WeekFigure.Bar(count: 0, noun: "messages", when: "") },
                       ends: ("", "This week"))
                .accessibilityIdentifier("person.weeks")
                .reading(true)
        }
    }

    private static let readingWeeks = 12

    private static func noun(_ count: Int) -> String {
        count == 1 ? "message" : "messages"
    }

    private static func bars(_ bars: [PersonPage.Bar]) -> [WeekFigure.Bar] {
        bars.map { WeekFigure.Bar(count: $0.count, noun: noun($0.count), when: $0.when) }
    }

    private static func open(_ bar: PersonPage.Bar) {
        if let day = bar.day { AppNavigation.shared.push(.day(day)) }
    }
}

private struct CallsRow: View {
    let calls: Int

    var body: some View {
        Card(group: true, flat: true) {
            ListRow("Calls", meta: "Last 30 days", leading: .symbol(.call), value: Words.count(calls), chevron: false, separator: false) {
                Icon(.forward, size: .sm).hidden().padding(.trailing, -4)
            }
        }
        .environment(\.cockpitRowsFaces, Cockpit.Space.s6)
        .accessibilityIdentifier("person.calls")
    }
}

private struct WhereYouTalk: View {
    let name: String
    let talks: PersonPage.Talks
    let today: String
    @State private var open = false

    var body: some View {
        let folded = talks.folded
        let shown = talks.shown + (open ? folded : [])
        if !shown.isEmpty || !folded.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    SectionLabel("Where you talk")
                    Spacer(minLength: Cockpit.Space.s3)
                    Text("From " + name)
                        .cockpit(.footnote)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .lineLimit(1)
                }
                Card(group: true, flat: true) {
                    ForEach(shown.indices, id: \.self) { index in
                        row(shown[index], last: index == shown.count - 1 && (open || folded.isEmpty))
                    }
                    if !open, !folded.isEmpty {
                        ListRow(PersonPage.moreGroups(folded.count), leading: .blank, chevron: false,
                                separator: false,
                                action: { withAnimation(.easeOut(duration: Cockpit.Duration.base)) { open = true } }) {
                            Icon(.forward, size: .sm)
                                .foregroundStyle(Cockpit.Color.textTertiary)
                                .rotationEffect(.degrees(90))
                        }
                        .accessibilityIdentifier("person.chats.more")
                    }
                }
                .environment(\.cockpitRowsFaces, Cockpit.Space.s6)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    static var reading: some View {
        let rows = [("WhatsApp", "Yesterday", "128"), ("Messages", "Monday", "42")]
        return VStack(alignment: .leading, spacing: 0) {
            SectionLabel("Where you talk")
            Card(group: true, flat: true) {
                ForEach(rows.indices, id: \.self) { index in
                    ListRow(rows[index].0, meta: rows[index].1, leading: .symbol(.message), value: rows[index].2, chevron: false,
                            separator: index < rows.count - 1)
                }
            }
            .environment(\.cockpitRowsFaces, Cockpit.Space.s6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .reading(true)
    }

    private func row(_ each: PersonPage.Where, last: Bool) -> some View {
        let opens = each.group ? each.chat : nil
        return ListRow(each.title, meta: each.when.flatMap { PeopleListing.when($0, today: today, now: AppClock.now, grouped: false) },
                       tag: each.quiet ? "Quiet" : nil, leading: .symbol(each.chat == nil ? .mail : each.group ? .meeting : .message),
                       value: Words.count(each.count), chevron: opens != nil, separator: !last,
                       action: opens.map { chat in { AppNavigation.shared.push(.group(chat)) } }) {
            if opens == nil { Icon(.forward, size: .sm).hidden().padding(.trailing, -4) }
        }
        .accessibilityIdentifier("person.chat.\(each.chat ?? each.title)")
    }
}

private struct YourPage: View {
    let page: HomeLink.Pages.Person
    @ObservedObject var model: PersonModel
    @ObservedObject var photos: PersonPhotosModel
    let done: HeadDone?

    var body: some View {
        let name = page.head.name
        VStack(spacing: Cockpit.Space.s3) {
            VStack(spacing: Cockpit.Gap.inRow) {
                OneHead(name, line: "", identifier: "person.name", done: done) {
                    HeadFace(name: name, photo: page.head.photo, held: true, model: model, photos: photos)
                }
                if let full = page.head.fullName, full != name {
                    Text(full)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("page.line")
                }
            }
            if !page.edit.alsoCalled.isEmpty {
                FactChips(centred: true) {
                    ForEach(page.edit.alsoCalled, id: \.name) { also in
                        FactChip(also.name, label: "Also called " + also.name)
                    }
                }
                .accessibilityIdentifier("person.also")
            }
        }
        let handles = page.handles
        if !handles.isEmpty {
            Card("Numbers and emails", group: true) {
                KeyValueRows {
                    ForEach(handles, id: \.id) { handle in
                        KeyValueRow(handle.from ?? Self.kind(handle), handle.words, separator: handle.id != handles.last?.id)
                            .accessibilityIdentifier("person.handle.\(handle.id)")
                    }
                }
            }
        }
        PersonPhotosGroup(id: model.id, photos: photos)
    }

    @MainActor static func kind(_ handle: HomeLink.Pages.Person.Handle) -> String {
        switch handle.kind {
        case .phone: "Phone"
        case .email: "Email"
        case .jid, .network, .unknown: PeopleWords.network(handle.network ?? handle.kind.rawValue)
        }
    }
}

struct PersonPhotosGroup: View {
    let id: String
    @ObservedObject var photos: PersonPhotosModel
    @State private var opening: PhotoViewer.Opening?

    static let row = 3

    var body: some View {
        if photos.total > 0 {
            let more = photos.total > Self.row
            VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                SectionLabel("Photos", count: more ? nil : photos.total,
                             action: more ? "View all \(Words.count(photos.total)) photos" : nil,
                             perform: { AppNavigation.shared.push(.personPhotos(id)) })
                PhotoGrid(PersonShot.of(photos.photos.prefix(Self.row)), label: { PeopleWords.photo($0.photo) },
                          open: { opening = PhotoViewer.Opening(photos: photos.photos.map(\.blob), at: $0.id) }) { shot in
                    PlaceShot.Picture(hash: shot.photo.blob)
                        .accessibilityIdentifier("person.photo.\(shot.id)")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("person.photos")
            .photoViewer($opening) { AppNavigation.shared.push($0) }
        }
    }
}

struct PersonShot: Identifiable {
    let id: Int
    let photo: HomeLink.People.Photos.Photo

    static func of(_ photos: some Sequence<HomeLink.People.Photos.Photo>) -> [PersonShot] {
        photos.enumerated().map { PersonShot(id: $0.offset, photo: $0.element) }
    }
}

struct PersonPhotosScreen: View {
    let id: String
    @ObservedObject private var model: PersonModel
    @ObservedObject private var photos: PersonPhotosModel
    @State private var opening: PhotoViewer.Opening?
    @State private var read = false

    init(id: String) {
        self.id = id
        let model = PersonModel.of(id)
        _model = ObservedObject(wrappedValue: model)
        _photos = ObservedObject(wrappedValue: model.photos)
    }

    private struct Blank: Identifiable {
        let id: Int
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                SectionLabel("Photos", count: photos.total > 0 ? photos.total : nil)
                if photos.photos.isEmpty && photos.failure == nil && !read {
                    PhotoGrid((0..<9).map(Blank.init), columns: 3, label: { _ in "Photo" }, open: { _ in }) { _ in Color.clear }
                        .reading(true)
                } else {
                    let shots = PersonShot.of(photos.photos)
                    PhotoGrid(shots, columns: 3, label: { PeopleWords.photo($0.photo) },
                              open: { opening = PhotoViewer.Opening(photos: shots.map(\.photo.blob), at: $0.id) }) { shot in
                        PlaceShot.Picture(hash: shot.photo.blob)
                            .accessibilityIdentifier("person.photo.\(shot.id)")
                            .onAppear { if shot.id >= shots.count - 6 { Task { await photos.need(shots.count + 1) } } }
                    }
                }
                if let failure = photos.failure {
                    ReadLack(failure, lacks: "Their photos aren't on this iPhone yet.", words: PeopleWords.failure(failure)) {
                        Task { await photos.retry(photos.photos.count + 1) }
                    }
                }
            }
            .padding(Cockpit.Space.s4)
        }
        .accessibilityIdentifier("person.allphotos")
        .groundColor(Cockpit.Color.canvas)
        .navigationTitle(model.page?.head.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: id) {
            await photos.read()
            read = true
        }
        .readsAgain(failed: { photos.failure }) {
            await photos.retry(photos.photos.count + 1)
        }
        .photoViewer($opening) { AppNavigation.shared.push($0) }
    }
}
